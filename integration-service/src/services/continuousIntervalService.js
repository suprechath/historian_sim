import { EXTERNAL_CONFIG } from '../config/externalConfig.js';
import { logger } from '../utils/logger.js';
import { query } from '../db.js';
import {
    formatReadingValue,
    formatExecutedTimestamp,
} from '../utils/formatters.js';
import { reportError, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';
import { resolveMetric, computeMetricValue, detectWaveInReadings } from './mathService.js';
import { createInterpreter } from '../utils/instructionParsers.js';
import {
    enqueueScheduledInstruction,
    rescheduleInstruction,
    markScheduledInstructionCompleted,
    cancelPendingScheduledInstruction
} from '../dal/externalDal.js';

const CASE3_POLL_INTERVAL_SECONDS = 10;
const CASE3_MAX_SCHEDULE_HOURS = 48;
const CASE3_MAX_ATTEMPTS = Math.floor((CASE3_MAX_SCHEDULE_HOURS * 3600) / CASE3_POLL_INTERVAL_SECONDS);

/**
 * Marks task as completed in persistent database.
 */
async function completeTaskAndCleanup(task, reason) {
    logger.info('Case3Worker', `Task ${task.id} (${task.ref_instruction}): ${reason}. Completing task.`);
    await markScheduledInstructionCompleted(task.id);
    return { completed: true };
}

/**
 * Mode: Continuous Interval Record Mode (RefEndTime is omitted or Sentinel collection)
 * Enqueues a persistent scheduled task in PostgreSQL that streams interval readings to BatchLine every 30s.
 * Survives Node.js process crashes, container restarts, and deployments.
 */
export async function handleContinuousIntervalMode(
    ctx,
    res,
    tag,
    actualStart,
    intervalConfig,
    startThreshold = null,
    startDirection = null,
    interpretConfig = null,
    options = {}
) {
    const metric = resolveMetric(ctx.refType);
    const intervalMs = intervalConfig.intervalMs;
    const startMs = actualStart.getTime();

    // Cancel any previous pending task for this instruction directly in PostgreSQL (restart-proof & cluster-safe)
    await cancelPendingScheduledInstruction(ctx.batchId, ctx.refInstruction);

    const effectiveDirection = startDirection || 'rise';
    const isFall = (effectiveDirection === 'fall' || effectiveDirection === 'down');
    const crossedStartMs = (options.crossedStartMs !== undefined && options.crossedStartMs !== null)
        ? options.crossedStartMs
        : ((startThreshold === null) ? startMs : null);
    const stopThreshold = options.stopThreshold ?? null;
    const stopDirection = options.stopDirection ?? null;
    const durationMinutes = options.durationMinutes ?? null;

    // Enqueue task into persistent PostgreSQL queue (survives restarts)
    const scheduledTime = (startMs <= Date.now()) ? new Date() : actualStart;
    const queuedTask = await enqueueScheduledInstruction({
        caseType: 3,
        batchId: ctx.batchId,
        refInstruction: ctx.refInstruction,
        tagId: tag.id,
        scheduledTime,
        payload: {
            ctx,
            tag: {
                id: tag.id,
                name: tag.name,
                display_digits: tag.display_digits
            },
            actualStart: actualStart.toISOString(),
            intervalConfig,
            startThreshold,
            startDirection: effectiveDirection,
            stopThreshold,
            stopDirection,
            durationMinutes,
            interpretConfig: interpretConfig ? { raw: interpretConfig.raw, mapping: interpretConfig.mapping } : null,
            nextBucketIndex: 0,
            crossedStartMs,
            lastThresholdCheckTs: options.lastThresholdCheckTs || ((crossedStartMs !== null)
                ? new Date(crossedStartMs).toISOString()
                : actualStart.toISOString()),
            lastKnown: 0
        },
        maxAttempts: CASE3_MAX_ATTEMPTS
    });

    logger.info('ContinuousInterval', `Enqueued persistent Case 3 streaming task ${queuedTask.id} for tag "${tag.name}" (batch: ${ctx.batchId}, instruction: ${ctx.refInstruction}).`);


    // Acknowledge BatchLine webhook immediately with HTTP 200
    if (!res.headersSent) {
        const responseData = {
            status: 'scheduled',
            case: 3,
            mode: 'record_interval_continuous',
            job_id: queuedTask.id,
            message: (crossedStartMs === null && startThreshold !== null)
                ? `Continuous periodic collection scheduled for instruction ${ctx.refInstruction}. Will begin recording bucketed values (${intervalConfig.rawInterval}) once ${tag.name} crosses START threshold (${startThreshold}) [direction: ${isFall ? 'fall' : 'rise'}].`
                : `Continuous periodic collection started for instruction ${ctx.refInstruction}. Bucketed values (${intervalConfig.rawInterval}) will be sent continuously until a stop request is received.`,
            batch_id: ctx.batchId,
            tag: tag.name,
            ref_instruction: ctx.refInstruction,
            ref_start_time: ctx.refStartTime,
            start_threshold: startThreshold,
            direction: startThreshold !== null ? (isFall ? 'fall' : 'rise') : null,
            interval: intervalConfig.rawInterval,
            interval_ms: intervalMs,
            metric: metric.toUpperCase(),
            transmission_cadence_sec: CASE3_POLL_INTERVAL_SECONDS
        };
        if (ctx.refEndTime) {
            responseData.ref_end_time = ctx.refEndTime;
        }
        res.json(responseData);
    }
}

/**
 * Worker execution handler for persistent scheduled Case 3 continuous interval streaming instructions.
 * Called by scheduledInstructionWorker when scheduled_time is reached.
 */
export async function executeScheduledCase3(task) {
    const payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : task.payload;
    const {
        ctx,
        tag,
        actualStart: actualStartStr,
        intervalConfig,
        startThreshold,
        startDirection,
        stopThreshold = null,
        stopDirection = null,
        durationMinutes = null,
        interpretConfig: rawInterpretConfig
    } = payload;

    const maxAllowed = EXTERNAL_CONFIG.MAX_PERIODIC_REPEATS || 50;
    let nextBucketIndex = payload.nextBucketIndex ?? 0;
    if (nextBucketIndex >= maxAllowed) {
        return await completeTaskAndCleanup(task, `reached maximum allowed data points limit (${maxAllowed})`);
    }

    let crossedStartMs = payload.crossedStartMs ?? null;
    let lastThresholdCheckTs = new Date(payload.lastThresholdCheckTs || actualStartStr);
    let lastKnown = payload.lastKnown ?? 0;

    const actualStart = new Date(actualStartStr);
    const startMs = actualStart.getTime();
    const intervalMs = intervalConfig.intervalMs;
    const metric = resolveMetric(ctx?.refType);
    const interpret = createInterpreter(rawInterpretConfig?.mapping);
    const currentNowMs = Date.now();

    // 1. Threshold detection if not yet crossed
    if (crossedStartMs === null && startThreshold !== null) {
        const { rows: searchRows } = await query(`
            SELECT ts, value FROM readings
            WHERE tag_id = $1 AND ts >= $2::timestamptz AND ts <= $3::timestamptz
            ORDER BY ts ASC;
        `, [tag.id, lastThresholdCheckTs, new Date(currentNowMs)]);

        if (searchRows.length > 0) {
            const wave = detectWaveInReadings(searchRows, {
                start: startThreshold,
                stop: stopThreshold,
                direction: startDirection
            });

            if (wave.waveStartTs) {
                crossedStartMs = new Date(wave.waveStartTs).getTime();
                logger.info('Case3Worker', `Tag "${tag.name}" crossed START threshold (${startThreshold}) at ${wave.waveStartTs}. Starting interval collection.`);
            }
            lastThresholdCheckTs = new Date(searchRows[searchRows.length - 1].ts);
        }

        if (crossedStartMs === null) {
            logger.debug('Case3Worker', `Task ${task.id} (tag: ${tag.name}) has not yet crossed START threshold (${startThreshold}). Rescheduling in ${CASE3_POLL_INTERVAL_SECONDS}s...`);
            payload.lastThresholdCheckTs = lastThresholdCheckTs.toISOString();
            await rescheduleInstruction(task.id, CASE3_POLL_INTERVAL_SECONDS, 'Waiting for START threshold crossing', payload, true);
            return { scheduled: true };
        }

        payload.crossedStartMs = crossedStartMs;
    }

    const effectiveStartMs = crossedStartMs !== null ? crossedStartMs : startMs;
    const bucketsToProcess = [];

    while (true) {
        const currentCandidateIndex = nextBucketIndex + bucketsToProcess.length;
        if (currentCandidateIndex >= maxAllowed) break;

        const bStartMs = effectiveStartMs + currentCandidateIndex * intervalMs;
        const bEndMs = bStartMs + intervalMs;

        if (currentNowMs >= bEndMs) {
            bucketsToProcess.push({
                index: currentCandidateIndex,
                bStartMs,
                bEndMs
            });

            if (bucketsToProcess.length >= maxAllowed) break;
        } else {
            break;
        }
    }

    // No completed buckets yet: reschedule for next interval check
    if (bucketsToProcess.length === 0) {
        const nextBucketEndMs = effectiveStartMs + (nextBucketIndex + 1) * intervalMs;
        const msUntilNextBucket = Math.max(5000, nextBucketEndMs - currentNowMs);
        const delaySec = Math.min(CASE3_POLL_INTERVAL_SECONDS, Math.max(5, Math.ceil(msUntilNextBucket / 1000)));

        payload.crossedStartMs = effectiveStartMs;
        await rescheduleInstruction(task.id, delaySec, 'Awaiting next completed bucket', payload, true);
        return { scheduled: true };
    }

    const rangeStart = new Date(bucketsToProcess[0].bStartMs);
    const rangeEnd = new Date(bucketsToProcess[bucketsToProcess.length - 1].bEndMs);

    const { rows: readings } = await query(`
        SELECT ts, value
        FROM readings
        WHERE tag_id = $1
          AND ts >= $2::timestamptz
          AND ts <= $3::timestamptz
        ORDER BY ts ASC;
    `, [tag.id, rangeStart, rangeEnd]);

    const setOfValues = [];
    for (const b of bucketsToProcess) {
        const bucketReadings = readings.filter(r => {
            const rMs = new Date(r.ts).getTime();
            return rMs >= b.bStartMs && rMs < b.bEndMs;
        });

        let resolvedVal;
        if (bucketReadings.length > 0) {
            resolvedVal = computeMetricValue(bucketReadings.map(r => Number(r.value)), metric);
            lastKnown = resolvedVal;
        } else {
            resolvedVal = lastKnown;
        }

        const standardFormattedValue = formatReadingValue(resolvedVal, tag.display_digits);
        const formattedValue = interpret ? interpret(resolvedVal, standardFormattedValue) : standardFormattedValue;

        setOfValues.push({
            repeat_no: b.index + 1,
            value: formattedValue,
            standard_formatted_value: standardFormattedValue,
            raw_value: resolvedVal,
            executed_timestamp: formatExecutedTimestamp(new Date(b.bStartMs)),
            executed_user_email: ctx?.triggeredByEmail || null
        });
    }

    logger.info('Case3Worker', `Task ${task.id}: Dispatching set of ${setOfValues.length} bucketed values (repeats ${setOfValues[0].repeat_no}..${setOfValues[setOfValues.length - 1].repeat_no}) for tag "${tag.name}" (batch: ${task.batch_id}, instruction: ${task.ref_instruction})...`);

    const cbResult = await sendBatchLineInstructionUpdate({
        refInstruction: task.ref_instruction,
        batchId: task.batch_id,
        callbackKey: ctx?.callbackKey,
        actualResult: setOfValues
    });

    if (cbResult?.ok) {
        // Success: advance cursor safely
        nextBucketIndex += bucketsToProcess.length;
        payload.nextBucketIndex = nextBucketIndex;
        payload.lastKnown = lastKnown;
        payload.crossedStartMs = effectiveStartMs;

        // Check waveform stop threshold or duration if configured
        let reachedStop = false;
        let stopTs = null;
        if (stopThreshold !== null) {
            for (const r of readings) {
                const rMs = new Date(r.ts).getTime();
                if (rMs <= effectiveStartMs) continue;
                const val = Number(r.value);
                if (isNaN(val)) continue;
                const isStopCrossed = (stopDirection === 'rise') ? (val >= stopThreshold) : (val <= stopThreshold);
                if (isStopCrossed) {
                    reachedStop = true;
                    stopTs = r.ts;
                    break;
                }
            }
        }

        let reachedDuration = false;
        if (durationMinutes !== null && durationMinutes > 0) {
            const maxAllowedEndMs = effectiveStartMs + durationMinutes * 60 * 1000;
            if (bucketsToProcess[bucketsToProcess.length - 1].bEndMs >= maxAllowedEndMs) {
                reachedDuration = true;
            }
        }

        if (reachedStop || reachedDuration) {
            const reason = reachedStop
                ? `reached STOP threshold (${stopThreshold}) at ${stopTs}`
                : `reached configured DURATION (${durationMinutes} min)`;
            return await completeTaskAndCleanup(task, reason);
        }


        // Check if maximum allowed repeats reached
        if (nextBucketIndex >= maxAllowed) {
            return await completeTaskAndCleanup(task, `reached maximum allowed data points limit (${maxAllowed})`);
        }

        // Check if more backlog buckets are already past due
        const nextBucketEndMs = effectiveStartMs + (nextBucketIndex + 1) * intervalMs;
        const delaySec = (Date.now() >= nextBucketEndMs) ? 1 : CASE3_POLL_INTERVAL_SECONDS;

        await rescheduleInstruction(task.id, delaySec, 'Next interval bucket cadence', payload, true);
        return { scheduled: true };
    } else {
        const detail = cbResult?.data?.error?.detail || cbResult?.error || '';
        if (String(detail).toLowerCase().includes('cannot exceed the target repeat')) {
            return await completeTaskAndCleanup(task, 'reached Target Repeat limit in BatchLine');
        }

        // Transient error: do NOT advance nextBucketIndex, retry in 15 seconds
        await reportError(`[BatchLine Case 3 Worker]: Failed to push set of ${setOfValues.length} bucketed values (task ${task.id}, will retry)`, ctx, detail);
        await rescheduleInstruction(task.id, 15, `Retry failed update: ${detail}`, payload, false);
        return { scheduled: true };
    }
}
