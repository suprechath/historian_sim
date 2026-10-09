import { EXTERNAL_CONFIG } from '../config/externalConfig.js';
import { logger } from '../utils/logger.js';
import { query } from '../db.js';
import {
    formatReadingValue,
    formatExecutedTimestamp,
    parseBatchLineDate,
    cleanInstructionId
} from '../utils/formatters.js';
import {
    getCombinedDescription,
    extractExceptionTriggers,
    extractInterpretMapping,
    parsePrintLabelPayload,
    parseIntervalString,
    parseDurationString
} from '../utils/instructionParsers.js';
import { reportError, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';
import { resolveTag } from '../dal/externalDal.js';
import {
    resolveMetric,
    resolveWaveDirections,
    computeMetricValue
} from './mathService.js';
import { jobRegistry } from './jobRegistry.js';
import { handleBatchExceptionTrigger } from './exceptionTriggerService.js';
import { handleProfileMode, handleRecordMode } from './case3Service.js';

/**
 * Handles PrintLabel Instruction when INTERVAL is specified and RefEndTime is set in the future.
 */
export async function handleFutureIntervalRecordMode(
    ctx,
    res,
    tag,
    actualStart,
    actualEnd,
    intervalConfig,
    startThreshold = null,
    startDirection = null,
    stopThreshold = null,
    durationMinutes = null,
    interpretConfig = null
) {
    const metric = resolveMetric(ctx.refType);
    const intervalMs = intervalConfig.intervalMs;
    const startMs = actualStart.getTime();

    const durationSpecifiedMs = (durationMinutes !== null && durationMinutes > 0)
        ? durationMinutes * 60 * 1000
        : null;

    let endMs = actualEnd ? actualEnd.getTime() : (startMs + (durationSpecifiedMs || intervalMs));
    if (durationSpecifiedMs && endMs < startMs + durationSpecifiedMs) {
        endMs = startMs + durationSpecifiedMs;
    }

    const durationMs = endMs - startMs;

    if (durationMs <= 0) {
        const errMsg = `RefEndTime (${actualEnd ? actualEnd.toISOString() : 'none'}) must be after RefStartTime (${actualStart.toISOString()})`;
        await reportError(`[BatchLine Future Record]: ${errMsg}`, ctx);
        return res.status(400).json({ error: errMsg });
    }

    const cleanRef = cleanInstructionId(ctx.refInstruction);
    const jobKey = `${ctx.batchId}_${cleanRef}`;

    // Cancel previous job for this instruction if running
    if (jobRegistry.has(jobKey)) {
        logger.info('FutureInterval', `Cancelling previous future interval job for ${jobKey}`);
        await jobRegistry.stopJob(jobKey);
    }

    // Determine initial lastKnown reading
    const { rows: initialRows } = await query(`
        SELECT value FROM readings
        WHERE tag_id = $1 AND ts <= $2::timestamptz
        ORDER BY ts DESC LIMIT 1;
    `, [tag.id, actualStart]);

    let lastKnown = 0;
    let initialVal = null;
    if (initialRows.length > 0 && initialRows[0].value !== null) {
        lastKnown = Number(initialRows[0].value);
        initialVal = lastKnown;
    } else {
        const { rows: snapRows } = await query(`
            SELECT value FROM snapshots WHERE tag_id = $1 LIMIT 1;
        `, [tag.id]);
        if (snapRows.length > 0 && snapRows[0].value !== null) {
            lastKnown = Number(snapRows[0].value);
            initialVal = lastKnown;
        }
    }

    const { startDirection: resolvedStartDir, stopDirection, isFall, isEnvelope } = resolveWaveDirections(
        startThreshold,
        stopThreshold,
        startDirection,
        initialVal
    );

    let crossedStartMs = (startThreshold === null) ? startMs : null;
    let armed = false;

    if (startThreshold !== null) {
        if (initialVal !== null) {
            armed = isFall ? (initialVal > startThreshold) : (initialVal < startThreshold);
        }

        const { rows: searchRows } = await query(`
            SELECT ts, value FROM readings
            WHERE tag_id = $1 AND ts >= $2::timestamptz AND ts <= $3::timestamptz
            ORDER BY ts ASC;
        `, [tag.id, actualStart, new Date()]);

        for (let i = 0; i < searchRows.length; i++) {
            const r = searchRows[i];
            if (r.value === null || r.value === undefined) continue;
            const val = Number(r.value);
            if (isNaN(val)) continue;

            if (!armed) {
                if (isFall && val > startThreshold) armed = true;
                if (!isFall && val < startThreshold) armed = true;
            }
            const crossed = isFall ? (val <= startThreshold) : (val >= startThreshold);
            if (armed && crossed) {
                crossedStartMs = new Date(r.ts).getTime();
                logger.info('FutureInterval', `Tag "${tag.name}" already crossed START threshold (${startThreshold}) at ${r.ts} (direction: ${isFall ? 'fall' : 'rise'}). Intervals will start from this point.`);
                break;
            }
            if (i === 0 && crossed) {
                crossedStartMs = new Date(r.ts).getTime();
                logger.info('FutureInterval', `Tag "${tag.name}" was already at/past START threshold (${startThreshold}) at ${r.ts}. Intervals will start from this point.`);
                break;
            }
        }
    }

    if (crossedStartMs && durationSpecifiedMs) {
        endMs = crossedStartMs + durationSpecifiedMs;
    }

    const effectiveBaseStartMs = crossedStartMs || startMs;
    let totalExpectedBuckets = durationSpecifiedMs
        ? Math.min(Math.max(1, Math.ceil(durationSpecifiedMs / intervalMs)), EXTERNAL_CONFIG.MAX_PERIODIC_REPEATS || 50)
        : Math.max(1, Math.ceil((endMs - effectiveBaseStartMs) / intervalMs));

    if (totalExpectedBuckets > (EXTERNAL_CONFIG.MAX_PERIODIC_REPEATS || 50)) {
        logger.warn('FutureInterval', `Capping expected buckets from ${totalExpectedBuckets} to max ${EXTERNAL_CONFIG.MAX_PERIODIC_REPEATS || 50}`);
        totalExpectedBuckets = EXTERNAL_CONFIG.MAX_PERIODIC_REPEATS || 50;
    }

    const nowMs = Date.now();
    const isScenario2 = (startMs < nowMs && nowMs < endMs);
    const scenarioNum = isScenario2 ? 2 : 3;

    // Acknowledge BatchLine webhook immediately with HTTP 200
    if (!res.headersSent) {
        const scheduledResponse = {
            status: 'scheduled',
            case: 3,
            scenario: scenarioNum,
            mode: 'record_interval_future',
            message: isScenario2
                ? `Scenario 2: RefStartTime is in past, RefEndTime in future. Initial past data pushed immediately; subsequent intervals pushed every 30s until ${new Date(endMs).toISOString()}.`
                : `Scenario 3: RefStartTime and RefEndTime are in future. Scheduled to begin at ${actualStart.toISOString()} and push intervals every 30s until ${new Date(endMs).toISOString()}.`,
            batch_id: ctx.batchId,
            tag: tag.name,
            ref_instruction: ctx.refInstruction,
            ref_start_time: ctx.refStartTime,
            start_threshold: startThreshold,
            direction: startThreshold !== null ? (isFall ? 'fall' : 'rise') : null,
            stop_threshold: stopThreshold,
            stop_direction: stopDirection,
            is_envelope: isEnvelope,
            duration_minutes: durationMinutes ?? null,
            interval: intervalConfig.rawInterval,
            interval_ms: intervalMs,
            metric: metric.toUpperCase(),
            total_expected_buckets: totalExpectedBuckets,
            transmission_cadence_sec: 30
        };
        if (ctx.refEndTime) {
            scheduledResponse.ref_end_time = actualEnd ? actualEnd.toISOString() : (new Date(endMs).toISOString());
        }
        res.json(scheduledResponse);
    }

    let nextBucketIndex = 0;
    let isProcessing = false;

    const processCompletedBuckets = async () => {
        if (isProcessing) return;
        isProcessing = true;

        try {
            const currentNowMs = Date.now();

            if (crossedStartMs === null) {
                const { rows: searchRows } = await query(`
                    SELECT ts, value FROM readings
                    WHERE tag_id = $1 AND ts >= $2::timestamptz AND ts <= $3::timestamptz
                    ORDER BY ts ASC;
                `, [tag.id, actualStart, new Date(currentNowMs)]);

                for (let i = 0; i < searchRows.length; i++) {
                    const r = searchRows[i];
                    if (r.value === null || r.value === undefined) continue;
                    const val = Number(r.value);
                    if (isNaN(val)) continue;

                    if (!armed) {
                        if (isFall && val > startThreshold) armed = true;
                        if (!isFall && val < startThreshold) armed = true;
                    }
                    const crossed = isFall ? (val <= startThreshold) : (val >= startThreshold);
                    if (armed && crossed) {
                        crossedStartMs = new Date(r.ts).getTime();
                        if (durationSpecifiedMs) {
                            endMs = crossedStartMs + durationSpecifiedMs;
                            totalExpectedBuckets = Math.min(Math.max(1, Math.ceil(durationSpecifiedMs / intervalMs)), EXTERNAL_CONFIG.MAX_PERIODIC_REPEATS || 50);
                            if (endTimeoutId) clearTimeout(endTimeoutId);
                            const msUntilEnd = Math.max(0, endMs - Date.now() + 1500);
                            endTimeoutId = setTimeout(processCompletedBuckets, msUntilEnd);
                        }
                        logger.info('FutureInterval', `Tag "${tag.name}" crossed START threshold (${startThreshold}) at ${r.ts} (direction: ${isFall ? 'fall' : 'rise'}). Intervals will start from this point until ${new Date(endMs).toISOString()}.`);
                        break;
                    }
                }

                if (crossedStartMs === null) {
                    if (currentNowMs >= endMs) {
                        logger.info('FutureInterval', `Tag "${tag.name}" never crossed START threshold (${startThreshold}) before end time (${new Date(endMs).toISOString()}). Finishing.`);
                        cleanupJob();
                    } else {
                        logger.debug('FutureInterval', `Tag "${tag.name}" has not yet crossed START threshold (${startThreshold}) [direction: ${isFall ? 'fall' : 'rise'}, armed: ${armed}]. Waiting for threshold crossing...`);
                    }
                    return;
                }
            }

            const effectiveStartMs = crossedStartMs;
            if (!durationSpecifiedMs) {
                const remainingDurationMs = endMs - effectiveStartMs;
                if (remainingDurationMs > 0) {
                    totalExpectedBuckets = Math.min(
                        Math.max(1, Math.ceil(remainingDurationMs / intervalMs)),
                        EXTERNAL_CONFIG.MAX_PERIODIC_REPEATS || 50
                    );
                }
            }

            const bucketsToProcess = [];
            while (nextBucketIndex < totalExpectedBuckets) {
                const bStartMs = effectiveStartMs + nextBucketIndex * intervalMs;
                const bEndMs = Math.min(effectiveStartMs + (nextBucketIndex + 1) * intervalMs, endMs);

                if (currentNowMs >= bEndMs || currentNowMs >= endMs) {
                    bucketsToProcess.push({
                        index: nextBucketIndex,
                        bStartMs,
                        bEndMs
                    });
                    nextBucketIndex++;

                    if (bucketsToProcess.length >= (EXTERNAL_CONFIG.MAX_PERIODIC_REPEATS || 50)) {
                        break;
                    }
                } else {
                    break;
                }
            }

            if (bucketsToProcess.length === 0) {
                if (nextBucketIndex >= totalExpectedBuckets || currentNowMs >= endMs) {
                    cleanupJob();
                }
                return;
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
            let hitStop = false;

            for (const b of bucketsToProcess) {
                const isLast = (b.index === totalExpectedBuckets - 1);
                const bucketReadings = readings.filter(r => {
                    const rMs = new Date(r.ts).getTime();
                    return rMs >= b.bStartMs && (isLast ? (rMs <= b.bEndMs) : (rMs < b.bEndMs));
                });

                let resolvedVal;
                if (bucketReadings.length > 0) {
                    resolvedVal = computeMetricValue(bucketReadings.map(r => Number(r.value)), metric);
                    lastKnown = resolvedVal;
                } else {
                    resolvedVal = lastKnown;
                }

                const standardFormattedValue = formatReadingValue(resolvedVal, tag.display_digits);
                const formattedValue = interpretConfig ? interpretConfig.interpret(resolvedVal) : standardFormattedValue;

                setOfValues.push({
                    repeat_no: b.index + 1,
                    value: formattedValue,
                    standard_formatted_value: standardFormattedValue,
                    raw_value: resolvedVal,
                    executed_timestamp: formatExecutedTimestamp(new Date(b.bStartMs)),
                    executed_user_email: ctx.triggeredByEmail || null
                });

                if (stopThreshold !== null && resolvedVal !== null) {
                    const reachedStop = (stopDirection === 'rise') ? (resolvedVal >= stopThreshold) : (resolvedVal <= stopThreshold);
                    const hasStarted = (b.bStartMs > effectiveStartMs || setOfValues.length > 0 || nextBucketIndex > 0);
                    if (reachedStop && hasStarted) {
                        logger.info('FutureInterval', `Tag "${tag.name}" reached STOP threshold (${stopThreshold}) [stopDirection: ${stopDirection}, isEnvelope: ${isEnvelope}] at bucket repeat ${b.index + 1}.`);
                        hitStop = true;
                        break;
                    }
                }
            }

            logger.info('FutureInterval', `Dispatching set of ${setOfValues.length} bucketed values (repeats ${setOfValues[0].repeat_no}..${setOfValues[setOfValues.length - 1].repeat_no}) for tag "${tag.name}" (batch: ${ctx.batchId})...`);

            const cbResult = await sendBatchLineInstructionUpdate({
                refInstruction: ctx.refInstruction,
                batchId: ctx.batchId,
                callbackKey: ctx.callbackKey,
                actualResult: setOfValues
            });

            if (!cbResult?.ok) {
                const detail = cbResult?.data?.error?.detail || cbResult?.error || '';
                if (String(detail).toLowerCase().includes('cannot exceed the target repeat')) {
                    logger.info('FutureInterval', `Instruction ${ctx.refInstruction} reached Target Repeat limit in BatchLine. Stopping job.`);
                    cleanupJob();
                    return;
                }
                await reportError(`[BatchLine PrintLabel 30s]: Failed to push set of ${setOfValues.length} bucketed values`, ctx, detail);
            }

            const nextBucketEndMs = effectiveStartMs + (nextBucketIndex + 1) * intervalMs;
            if (currentNowMs >= nextBucketEndMs && nextBucketIndex < totalExpectedBuckets && !hitStop) {
                setImmediate(processCompletedBuckets);
            }

            if (hitStop || nextBucketIndex >= totalExpectedBuckets || currentNowMs >= endMs) {
                cleanupJob();
            }
        } catch (err) {
            logger.error('FutureInterval', 'Cadence processing error:', err.message);
            await reportError(`[BatchLine PrintLabel 30s Error]: ${err.message}`, ctx, err.stack);
        } finally {
            isProcessing = false;
        }
    };

    let intervalId = null;
    let startTimeoutId = null;
    let endTimeoutId = null;

    const cleanupJob = () => {
        logger.info('FutureInterval', `Completed future interval recording for instruction ${ctx.refInstruction} (${tag.name}). Total repeats sent: ${nextBucketIndex}.`);
        if (startTimeoutId) clearTimeout(startTimeoutId);
        if (intervalId) clearInterval(intervalId);
        if (endTimeoutId) clearTimeout(endTimeoutId);
        jobRegistry.delete(jobKey);
    };

    const stop = async () => {
        cleanupJob();
        await processCompletedBuckets();
    };

    const CADENCE_MS = 30000;

    if (isScenario2) {
        logger.info('FutureInterval', `Pushing initial past readings between ${actualStart.toISOString()} and now (${new Date(nowMs).toISOString()})...`);
        setImmediate(processCompletedBuckets);
        intervalId = setInterval(processCompletedBuckets, CADENCE_MS);
    } else {
        const msUntilStart = Math.max(0, startMs - Date.now());
        logger.info('FutureInterval', `Waiting ${Math.round(msUntilStart / 1000)}s until RefStartTime (${actualStart.toISOString()}) to start 30s cadence...`);
        startTimeoutId = setTimeout(() => {
            logger.info('FutureInterval', `RefStartTime reached (${actualStart.toISOString()}). Starting 30s cadence dispatcher.`);
            intervalId = setInterval(processCompletedBuckets, CADENCE_MS);
        }, msUntilStart);
    }

    const msUntilEnd = Math.max(0, endMs - Date.now() + 1500);
    endTimeoutId = setTimeout(processCompletedBuckets, msUntilEnd);

    const jobRecord = {
        jobKey,
        refInstruction: ctx.refInstruction,
        cleanRefInstruction: cleanRef,
        batchId: ctx.batchId,
        tagId: tag.id,
        tagName: tag.name,
        cleanup: cleanupJob,
        stop,
        getNextBucketIndex: () => nextBucketIndex,
        get startTimeoutId() { return startTimeoutId; },
        get intervalId() { return intervalId; },
        get endTimeoutId() { return endTimeoutId; },
        startedAt: new Date()
    };

    jobRegistry.set(jobKey, jobRecord);
}

/**
 * Mode: Continuous Interval Record Mode (RefEndTime is omitted)
 */
export async function handleContinuousIntervalMode(
    ctx,
    res,
    tag,
    actualStart,
    intervalConfig,
    startThreshold = null,
    startDirection = null,
    interpretConfig = null
) {
    const metric = resolveMetric(ctx.refType);
    const intervalMs = intervalConfig.intervalMs;
    const startMs = actualStart.getTime();

    const cleanRef = cleanInstructionId(ctx.refInstruction);
    const jobKey = `${ctx.batchId}_${cleanRef}`;

    // Cancel previous job for this instruction if running
    if (jobRegistry.has(jobKey)) {
        logger.info('ContinuousInterval', `Replacing existing job for ${jobKey}`);
        await jobRegistry.stopJob(jobKey);
    }

    // Determine initial lastKnown reading
    const { rows: initialRows } = await query(`
        SELECT value FROM readings
        WHERE tag_id = $1 AND ts <= $2::timestamptz
        ORDER BY ts DESC LIMIT 1;
    `, [tag.id, actualStart]);

    let lastKnown = 0;
    let initialVal = null;
    if (initialRows.length > 0 && initialRows[0].value !== null) {
        lastKnown = Number(initialRows[0].value);
        initialVal = lastKnown;
    } else {
        const { rows: snapRows } = await query(`
            SELECT value FROM snapshots WHERE tag_id = $1 LIMIT 1;
        `, [tag.id]);
        if (snapRows.length > 0 && snapRows[0].value !== null) {
            lastKnown = Number(snapRows[0].value);
            initialVal = lastKnown;
        }
    }

    let effectiveDirection = startDirection;
    if (startThreshold !== null && !effectiveDirection) {
        if (initialVal !== null) {
            effectiveDirection = (initialVal <= startThreshold) ? 'rise' : 'fall';
        } else {
            effectiveDirection = 'rise';
        }
    }
    const isFall = (effectiveDirection === 'fall' || effectiveDirection === 'down');

    let crossedStartMs = (startThreshold === null) ? startMs : null;
    let armed = false;
    if (startThreshold !== null) {
        if (initialVal !== null) {
            armed = isFall ? (initialVal > startThreshold) : (initialVal < startThreshold);
        }
    }

    // Acknowledge BatchLine webhook immediately with HTTP 200
    if (!res.headersSent) {
        const responseData = {
            status: 'scheduled',
            case: 3,
            mode: 'record_interval_continuous',
            message: startThreshold !== null
                ? `Continuous periodic collection scheduled for instruction ${ctx.refInstruction}. Will begin recording bucketed values (${intervalConfig.rawInterval}) once ${tag.name} crosses START threshold (${startThreshold}) [direction: ${isFall ? 'fall' : 'rise'}].`
                : `Continuous periodic collection started for instruction ${ctx.refInstruction}. Bucketed values (${intervalConfig.rawInterval}) will be sent every 30s continuously until a stop request is received.`,
            batch_id: ctx.batchId,
            tag: tag.name,
            ref_instruction: ctx.refInstruction,
            ref_start_time: ctx.refStartTime,
            start_threshold: startThreshold,
            direction: startThreshold !== null ? (isFall ? 'fall' : 'rise') : null,
            interval: intervalConfig.rawInterval,
            interval_ms: intervalMs,
            metric: metric.toUpperCase(),
            transmission_cadence_sec: 30
        };
        if (ctx.refEndTime) {
            responseData.ref_end_time = ctx.refEndTime;
        }
        res.json(responseData);
    }

    let nextBucketIndex = 0;
    let isProcessing = false;

    const processCompletedBuckets = async () => {
        if (isProcessing) return;
        isProcessing = true;

        try {
            const currentNowMs = Date.now();

            if (crossedStartMs === null) {
                const { rows: searchRows } = await query(`
                    SELECT ts, value FROM readings
                    WHERE tag_id = $1 AND ts >= $2::timestamptz AND ts <= $3::timestamptz
                    ORDER BY ts ASC;
                `, [tag.id, actualStart, new Date(currentNowMs)]);

                for (let i = 0; i < searchRows.length; i++) {
                    const r = searchRows[i];
                    if (r.value === null || r.value === undefined) continue;
                    const val = Number(r.value);
                    if (isNaN(val)) continue;

                    if (!armed) {
                        if (isFall && val > startThreshold) armed = true;
                        if (!isFall && val < startThreshold) armed = true;
                    } else {
                        const crossed = isFall ? (val <= startThreshold) : (val >= startThreshold);
                        if (crossed) {
                            crossedStartMs = new Date(r.ts).getTime();
                            logger.info('ContinuousInterval', `Tag "${tag.name}" crossed START threshold (${startThreshold}) at ${r.ts} (direction: ${isFall ? 'fall' : 'rise'}). Starting interval collection.`);
                            break;
                        }
                    }
                }

                if (crossedStartMs === null) {
                    logger.debug('ContinuousInterval', `Tag "${tag.name}" has not yet crossed START threshold (${startThreshold}) [direction: ${isFall ? 'fall' : 'rise'}, armed: ${armed}]. Waiting for threshold crossing...`);
                    return;
                }
            }

            const effectiveStartMs = crossedStartMs;
            const bucketsToProcess = [];

            while (true) {
                const bStartMs = effectiveStartMs + nextBucketIndex * intervalMs;
                const bEndMs = bStartMs + intervalMs;

                if (currentNowMs >= bEndMs) {
                    bucketsToProcess.push({
                        index: nextBucketIndex,
                        bStartMs,
                        bEndMs
                    });
                    nextBucketIndex++;

                    if (bucketsToProcess.length >= (EXTERNAL_CONFIG.MAX_PERIODIC_REPEATS || 50)) {
                        break;
                    }
                } else {
                    break;
                }
            }

            if (bucketsToProcess.length === 0) return;

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
                const formattedValue = interpretConfig ? interpretConfig.interpret(resolvedVal) : standardFormattedValue;

                setOfValues.push({
                    repeat_no: b.index + 1,
                    value: formattedValue,
                    standard_formatted_value: standardFormattedValue,
                    raw_value: resolvedVal,
                    executed_timestamp: formatExecutedTimestamp(new Date(b.bStartMs)),
                    executed_user_email: ctx.triggeredByEmail || null
                });
            }

            logger.info('ContinuousInterval', `Dispatching set of ${setOfValues.length} bucketed values (repeats ${setOfValues[0].repeat_no}..${setOfValues[setOfValues.length - 1].repeat_no}) for tag "${tag.name}" (batch: ${ctx.batchId}, instruction: ${ctx.refInstruction})...`);

            const cbResult = await sendBatchLineInstructionUpdate({
                refInstruction: ctx.refInstruction,
                batchId: ctx.batchId,
                callbackKey: ctx.callbackKey,
                actualResult: setOfValues
            });

            if (!cbResult?.ok) {
                const detail = cbResult?.data?.error?.detail || cbResult?.error || '';
                if (String(detail).toLowerCase().includes('cannot exceed the target repeat')) {
                    logger.info('ContinuousInterval', `Instruction ${ctx.refInstruction} reached Target Repeat limit in BatchLine. Stopping continuous collection.`);
                    cleanup();
                    jobRegistry.delete(jobKey);
                    return;
                }
                await reportError(`[BatchLine Continuous 30s]: Failed to push set of ${setOfValues.length} bucketed values`, ctx, detail);
            }

            const nextBucketEndMs = effectiveStartMs + (nextBucketIndex + 1) * intervalMs;
            if (Date.now() >= nextBucketEndMs) {
                setImmediate(processCompletedBuckets);
            }
        } catch (err) {
            logger.error('ContinuousInterval', 'Processing error:', err.message);
            await reportError(`[BatchLine Continuous 30s Error]: ${err.message}`, ctx, err.stack);
        } finally {
            isProcessing = false;
        }
    };

    let intervalId = null;
    let startTimeoutId = null;

    const cleanup = () => {
        if (startTimeoutId) clearTimeout(startTimeoutId);
        if (intervalId) clearInterval(intervalId);
    };

    const stop = async () => {
        cleanup();
        logger.info('ContinuousInterval', `Stopping continuous job for instruction ${ctx.refInstruction} (${tag.name}). Flushing final buckets...`);
        await processCompletedBuckets();
        logger.info('ContinuousInterval', `Final buckets flushed. Total repeats sent: ${nextBucketIndex}.`);
    };

    const CADENCE_MS = 30000;
    const nowMs = Date.now();

    if (startMs <= nowMs) {
        logger.info('ContinuousInterval', `RefStartTime (${actualStart.toISOString()}) is past/now. Starting dispatcher...`);
        setImmediate(processCompletedBuckets);
        intervalId = setInterval(processCompletedBuckets, CADENCE_MS);
    } else {
        const msUntilStart = startMs - nowMs;
        logger.info('ContinuousInterval', `RefStartTime (${actualStart.toISOString()}) is in future. Waiting ${Math.round(msUntilStart / 1000)}s to begin 30s cadence...`);
        startTimeoutId = setTimeout(() => {
            logger.info('ContinuousInterval', `RefStartTime reached (${actualStart.toISOString()}). Starting 30s cadence dispatcher.`);
            setImmediate(processCompletedBuckets);
            intervalId = setInterval(processCompletedBuckets, CADENCE_MS);
        }, msUntilStart);
    }

    const jobRecord = {
        jobKey,
        batchId: ctx.batchId,
        refInstruction: ctx.refInstruction,
        cleanRefInstruction: cleanRef,
        tagId: tag.id,
        tagName: tag.name,
        cleanup,
        stop,
        getNextBucketIndex: () => nextBucketIndex,
        get startTimeoutId() { return startTimeoutId; },
        get intervalId() { return intervalId; },
        startedAt: new Date()
    };

    jobRegistry.set(jobKey, jobRecord);
}

/**
 * Main coordinator for Print Label Instruction (EBR User Record trigger)
 */
export async function handlePrintLabelInstruction(req, res) {
    let ctx = null;
    try {
        const parsed = parsePrintLabelPayload(req.body);

        logger.info('PrintLabelWebhook', 'Parsed parameters summary:', {
            batch_id: parsed.batchId,
            callback_key: parsed.callbackKey,
            ref_instruction: parsed.refInstruction,
            parameters: parsed.parameters,
            parsed_dates: parsed.parsedDates,
            incoming_instruction_ids: parsed.incomingInstructionIds
        });

        // 1. Check if this request is a STOP signal for an active continuous or future interval job
        const incomingIds = [...(parsed.incomingInstructionIds || [])];
        if (parsed.refInstruction && !incomingIds.includes(cleanInstructionId(parsed.refInstruction))) {
            incomingIds.push(cleanInstructionId(parsed.refInstruction));
        }

        if (parsed.batchId && incomingIds.length > 0) {
            const stoppedJobs = [];
            for (const instId of incomingIds) {
                const cleanInst = cleanInstructionId(instId);
                const jobKey = `${parsed.batchId}_${cleanInst}`;

                let targetJobKey = null;
                if (jobRegistry.has(jobKey)) {
                    targetJobKey = jobKey;
                } else {
                    const match = jobRegistry.find((job) =>
                        job.batchId === parsed.batchId &&
                        (job.cleanRefInstruction === cleanInst || cleanInstructionId(job.refInstruction) === cleanInst)
                    );
                    if (match) targetJobKey = match.key;
                }

                if (targetJobKey) {
                    const job = jobRegistry.get(targetJobKey);
                    logger.info('PrintLabel', `Received STOP signal for instruction ${job.refInstruction} on batch ${parsed.batchId}. Stopping job.`);
                    await jobRegistry.stopJob(targetJobKey);
                    stoppedJobs.push({
                        refInstruction: job.refInstruction,
                        totalRepeatsSent: typeof job.getNextBucketIndex === 'function' ? job.getNextBucketIndex() : null
                    });
                }
            }

            if (stoppedJobs.length > 0) {
                return res.json({
                    status: 'stopped',
                    message: `Continuous periodic collection stopped for instruction(s): ${stoppedJobs.map(j => j.refInstruction).join(', ')}`,
                    batch_id: parsed.batchId,
                    stopped_jobs: stoppedJobs
                });
            }

            if (!parsed.parameters.RefElement && !parsed.parameters.RefStartTime) {
                logger.info('PrintLabel', `Received instruction update for [${parsed.incomingInstructionIds.join(', ')}] on batch ${parsed.batchId} with no active job. Acknowledged.`);
                return res.json({
                    status: 'acknowledged',
                    message: `No active continuous job found for instruction(s) ${parsed.incomingInstructionIds.join(', ')}`,
                    batch_id: parsed.batchId
                });
            }
        }

        ctx = {
            topic: parsed.topic,
            batchId: parsed.batchId,
            callbackKey: parsed.callbackKey,
            refElement: parsed.parameters.RefElement,
            refInstruction: parsed.refInstruction,
            refType: parsed.parameters.RefType,
            triggeredByEmail: parsed.user?.executedUserEmail || req.body.TriggeredByEmail || null,
            rawBody: req.body,
            instruction: req.body
        };

        const printLabelDesc = getCombinedDescription(ctx) || [req.body.InstructionDescription, req.body.Description].filter(Boolean).join(' ');
        const interpretConfig = extractInterpretMapping(printLabelDesc);
        if (interpretConfig) {
            logger.info('PrintLabel', 'Found [INTERPRET] mapping for instruction:', interpretConfig.raw);
        }

        const exceptionTriggers = extractExceptionTriggers(printLabelDesc, parsed.refInstruction);
        if (exceptionTriggers.length > 0) {
            return await handleBatchExceptionTrigger(ctx, res, exceptionTriggers);
        }

        if (!parsed.parameters.RefElement) {
            await reportError('[BatchLine PrintLabel]: Missing required RefElement in instruction parameters', { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
            return res.status(400).json({ error: 'Missing required RefElement in instruction parameters' });
        }

        if (!parsed.parameters.RefStartTime) {
            await reportError('[BatchLine PrintLabel]: Missing required RefStartTime in instruction parameters', { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
            return res.status(400).json({ error: 'Missing required RefStartTime in instruction parameters' });
        }

        const startDate = parseBatchLineDate(parsed.parameters.RefStartTime);
        if (!startDate || isNaN(startDate.getTime())) {
            const errMsg = `Invalid date format for RefStartTime ("${parsed.parameters.RefStartTime}")`;
            await reportError(`[BatchLine PrintLabel]: ${errMsg}`, { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
            return res.status(400).json({ error: errMsg });
        }

        let actualStart = startDate;
        let actualEnd = null;

        if (parsed.parameters.RefEndTime && !['null', 'undefined', 'none', ''].includes(String(parsed.parameters.RefEndTime).trim().toLowerCase())) {
            const endDate = parseBatchLineDate(parsed.parameters.RefEndTime);
            if (endDate && !isNaN(endDate.getTime())) {
                [actualStart, actualEnd] = startDate > endDate ? [endDate, startDate] : [startDate, endDate];
            } else {
                const errMsg = `Invalid date format for RefEndTime ("${parsed.parameters.RefEndTime}")`;
                await reportError(`[BatchLine PrintLabel]: ${errMsg}`, { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
                return res.status(400).json({ error: errMsg });
            }
        }

        ctx = {
            topic: parsed.topic,
            batchId: parsed.batchId,
            callbackKey: parsed.callbackKey,
            refElement: parsed.parameters.RefElement,
            refInstruction: parsed.refInstruction,
            refStartTime: actualStart.toISOString(),
            refEndTime: actualEnd ? actualEnd.toISOString() : null,
            refType: parsed.parameters.RefType,
            triggeredByEmail: parsed.user?.executedUserEmail || req.body.TriggeredByEmail || null,
            instructionDescription: '',
            parsedParameters: parsed.parameters,
            instruction: req.body
        };

        const tag = await resolveTag(ctx.refElement, ctx);
        if (!tag) {
            await reportError(`[BatchLine PrintLabel]: Could not resolve tag for RefElement: "${ctx.refElement}"`, ctx);
            return res.status(404).json({ error: `Could not resolve tag for RefElement: "${ctx.refElement}"` });
        }

        const rawStart = parsed.parameters.START;
        const hasStart = rawStart !== null && rawStart !== '' && !isNaN(parseFloat(rawStart));
        const rawStop = parsed.parameters.STOP;
        const hasStop = rawStop !== null && rawStop !== '' && !isNaN(parseFloat(rawStop));

        const intervalConfig = parseIntervalString(parsed.parameters.INTERVAL);
        const durationMinutes = parseDurationString(parsed.parameters.DURATION);

        // Mode 1: Continuous Interval Mode
        if (!actualEnd) {
            if (!intervalConfig) {
                const errMsg = 'Missing required RefEndTime in instruction parameters (or INTERVAL for continuous periodic collection)';
                await reportError(`[BatchLine PrintLabel]: ${errMsg}`, ctx);
                return res.status(400).json({ error: errMsg });
            }
            const startThreshold = hasStart ? parseFloat(rawStart) : null;
            const startDirection = parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null;
            logger.info('PrintLabel', `Identified Continuous Interval Mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
            return await handleContinuousIntervalMode(ctx, res, tag, actualStart, intervalConfig, startThreshold, startDirection, interpretConfig);
        }

        // Mode 2: Future Interval Record Mode
        if (intervalConfig && actualEnd.getTime() > Date.now()) {
            const startThreshold = hasStart ? parseFloat(rawStart) : null;
            const stopThreshold = hasStop ? parseFloat(rawStop) : null;
            const startDirection = parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null;
            logger.info('PrintLabel', `Identified Future Interval Record Mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
            return await handleFutureIntervalRecordMode(ctx, res, tag, actualStart, actualEnd, intervalConfig, startThreshold, startDirection, stopThreshold, durationMinutes, interpretConfig);
        }

        // Mode 2b: Future/Live Profile Mode
        if (hasStart && (actualEnd.getTime() > Date.now() || (durationMinutes && durationMinutes > 0))) {
            const startThreshold = parseFloat(rawStart);
            const stopThreshold = hasStop ? parseFloat(rawStop) : null;
            const startDirection = parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null;

            let effectiveIntervalConfig = intervalConfig;
            if (!effectiveIntervalConfig) {
                const sampleCount = EXTERNAL_CONFIG.MAX_PROFILE_SAMPLES || 30;
                const durMs = (durationMinutes && durationMinutes > 0)
                    ? (durationMinutes * 60 * 1000)
                    : Math.max(1000, actualEnd.getTime() - actualStart.getTime());
                const intervalMs = Math.max(1000, Math.round(durMs / sampleCount));
                effectiveIntervalConfig = {
                    rawInterval: `${Math.round(intervalMs / 1000)}s`,
                    intervalMinutes: intervalMs / 60000,
                    intervalMs
                };
            }

            let effectiveEnd = actualEnd;
            if (durationMinutes && durationMinutes > 0) {
                const minEndMs = actualStart.getTime() + durationMinutes * 60 * 1000;
                if (!effectiveEnd || effectiveEnd.getTime() < minEndMs) {
                    effectiveEnd = new Date(minEndMs);
                }
            }

            if (effectiveEnd.getTime() > Date.now()) {
                logger.info('PrintLabel', `Identified Future/Live Profile Mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
                return await handleFutureIntervalRecordMode(ctx, res, tag, actualStart, effectiveEnd, effectiveIntervalConfig, startThreshold, startDirection, stopThreshold, durationMinutes, interpretConfig);
            }
        }

        // Mode 3: Profile Mode (START specified and RefEndTime is in past/now)
        if (hasStart) {
            const profileConfig = {
                start: parseFloat(rawStart),
                stop: hasStop ? parseFloat(rawStop) : null,
                durationMinutes,
                direction: parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null,
                metric: resolveMetric(ctx.refType)
            };
            logger.info('PrintLabel', `Identified Profile Mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
            return await handleProfileMode(ctx, res, tag, actualStart, actualEnd, profileConfig, intervalConfig, interpretConfig);
        }

        // Mode 4: Record Mode
        logger.info('PrintLabel', `Identified Record Mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
        return await handleRecordMode(ctx, res, tag, actualStart, actualEnd, intervalConfig, interpretConfig);
    } catch (err) {
        logger.error('PrintLabel', 'Webhook error:', err);
        await reportError('[Print Label Webhook Fatal Error]: ' + err.message, ctx || {}, err.stack);
        return res.status(500).json({ error: err.message });
    }
}
