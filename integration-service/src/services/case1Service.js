import { logger } from '../utils/logger.js';
import {
    formatReadingValue,
    formatBatchLineDate,
    formatExecutedTimestamp,
    parseBatchLineDate
} from '../utils/formatters.js';
import {
    getCombinedDescription,
    extractTimeTriggers,
    extractRecordDurationMs,
    extractInterpretMapping
} from '../utils/instructionParsers.js';
import { reportError, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';
import {
    resolveTag,
    getNearestReading,
    findRecordTimeNearestToValue,
    enqueueScheduledInstruction
} from '../dal/externalDal.js';

const MAX_FUTURE_SCHEDULE_HOURS = 48;

/**
 * Case 1: Point-in-time value lookup and [TIME: VALUE=...] trigger processing
 */
export async function handleCase1PointInTime(ctx, res) {
    if (!ctx.refElement) {
        await reportError('[BatchLine Case 1]: Missing required RefElement in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefElement in instruction payload' });
    }

    if (!ctx.refInstruction) {
        await reportError('[BatchLine Case 1]: Missing required RefInstruction in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefInstruction in instruction payload' });
    }

    const tag = await resolveTag(ctx.refElement, ctx);
    if (!tag) {
        await reportError(`[BatchLine Case 1]: Could not resolve tag for RefElement: "${ctx.refElement}"`, ctx);
        return res.status(404).json({ error: `Could not resolve tag for RefElement: "${ctx.refElement}"` });
    }

    const fullDesc = getCombinedDescription(ctx);
    const triggers = extractTimeTriggers(fullDesc);
    const parsedRefTime = ctx.refTime ? (parseBatchLineDate(ctx.refTime) || new Date(ctx.refTime)) : null;

    // 1. Time-Trigger Processing: Find timestamp when sensor reaches target value after RefTime
    // Trigger pattern is [TIME: VALUE=130] and records the timestamp back to the active instruction (ctx.refInstruction).
    if (triggers.length > 0) {
        if (!ctx.refTime || !parsedRefTime || isNaN(parsedRefTime.getTime())) {
            await reportError('[BatchLine Case 1]: Missing or invalid RefTime in instruction payload for time trigger', ctx);
            return res.status(400).json({ error: 'Missing or invalid required RefTime in instruction payload for time trigger' });
        }

        const afterTime = parsedRefTime;

        if (afterTime.getTime() > Date.now() + 1000) {
            const errMsg = `RefTime (${afterTime.toISOString()}) cannot be in the future for [TIME: VALUE=...] milestone trigger`;
            await reportError(`[BatchLine Case 1]: ${errMsg}`, ctx);
            return res.status(400).json({ error: errMsg });
        }

        const targetRef = ctx.refInstruction;
        logger.info('Case1', `Processing ${triggers.length} time trigger(s) for tag "${tag.name}" after RefTime (${afterTime.toISOString()}). Target instruction: ${targetRef}`);

        const triggerResults = [];
        for (const trigger of triggers) {

            logger.info('Case1', `Finding record time nearest to ${trigger.targetValue} for tag "${tag.name}" after ${afterTime.toISOString()}...`);
            const reading = await findRecordTimeNearestToValue(tag.id, afterTime, trigger.targetValue);

            if (!reading) {
                const errMsg = `No reading found for tag "${tag.name}" after ${afterTime.toISOString()} near value ${trigger.targetValue}`;
                await reportError(`[BatchLine Case 1]: ${errMsg}`, ctx);
                return res.status(404).json({ error: errMsg });
            }

            const formattedTime = formatBatchLineDate(reading.ts);
            const executedTimestamp = formatExecutedTimestamp(reading.ts);

            logger.info('Case1', `Nearest reading found at ${reading.ts} (value: ${reading.value}, formatted: "${formattedTime}"). Recording back to ${targetRef}...`);

            const callbackResult = await sendBatchLineInstructionUpdate({
                refInstruction: targetRef,
                batchId: ctx.batchId,
                callbackKey: ctx.callbackKey,
                actualResult: [
                    {
                        repeat_no: 1,
                        value: formattedTime,
                        executed_timestamp: executedTimestamp,
                        executed_user_email: ctx.triggeredByEmail
                    }
                ]
            });

            if (callbackResult?.ok) {
                logger.info('Case1', `Successfully updated instruction ${targetRef} with record time "${formattedTime}"`);
            } else {
                await reportError(`[BatchLine Case 1]: Failed to update instruction ${targetRef}`, ctx, callbackResult?.data?.error?.detail || callbackResult?.error);
            }

            triggerResults.push({
                target_value: trigger.targetValue,
                target_ref: targetRef,
                found_ts: reading.ts,
                reading_value: reading.value,
                formatted_time: formattedTime,
                executed_timestamp: executedTimestamp,
                quality: reading.quality,
                callback: callbackResult
            });
        }

        if (triggerResults.length === 1) {
            const single = triggerResults[0];
            return res.json({
                status: 'success',
                case: 1,
                subcase: 'time_trigger',
                batch_id: ctx.batchId,
                tag: tag.name,
                target_value: single.target_value,
                target_instruction: single.target_ref,
                ref_time: ctx.refTime,
                reading: {
                    ts: single.found_ts,
                    raw_value: single.reading_value,
                    formatted_value: formatReadingValue(single.reading_value, tag.display_digits),
                    formatted_time: single.formatted_time,
                    executed_timestamp: single.executed_timestamp,
                    quality: single.quality
                },
                callback: single.callback
            });
        }

        return res.json({
            status: 'success',
            case: 1,
            subcase: 'time_trigger',
            batch_id: ctx.batchId,
            tag: tag.name,
            ref_time: ctx.refTime,
            triggers_processed: triggerResults.length,
            results: triggerResults
        });
    }

    // 2. Point-in-Time Value Lookup (Direct or Offset with [RECORD: DURATION=...])
    const interpretConfig = extractInterpretMapping(fullDesc);
    const durationMs = extractRecordDurationMs(fullDesc);

    // If [RECORD: DURATION=...] is specified, validate RefTime
    if (durationMs > 0 && (!ctx.refTime || !parsedRefTime || isNaN(parsedRefTime.getTime()))) {
        const errMsg = 'Missing or invalid required RefTime in instruction payload for [RECORD: DURATION=...] calculation';
        await reportError(`[BatchLine Case 1]: ${errMsg}`, ctx);
        return res.status(400).json({ error: errMsg });
    }

    const baseTime = (parsedRefTime && !isNaN(parsedRefTime.getTime())) ? parsedRefTime : new Date();
    const targetLookupTime = durationMs > 0 ? new Date(baseTime.getTime() + durationMs) : baseTime;

    if (durationMs > 0) {
        logger.info('Case1', `Trigger [RECORD: DURATION=${durationMs}ms] detected for tag "${tag.name}". RefTime (${baseTime.toISOString()}) + DURATION = target time (${targetLookupTime.toISOString()})`);
    }

    const nowMs = Date.now();
    const hasFutureTarget = (targetLookupTime.getTime() - nowMs > 1000);

    // Option A: Persistent Database-Backed Scheduled Queue when Target Time is set in the future
    if (hasFutureTarget) {
        const delayMs = targetLookupTime.getTime() - nowMs;
        const maxDelayMs = MAX_FUTURE_SCHEDULE_HOURS * 3600 * 1000;

        if (delayMs > maxDelayMs) {
            const errMsg = `Target lookup time (${targetLookupTime.toISOString()}) exceeds maximum future scheduling limit of ${MAX_FUTURE_SCHEDULE_HOURS} hours`;
            await reportError(`[BatchLine Case 1]: ${errMsg}`, ctx);
            return res.status(400).json({ error: errMsg });
        }

        const queued = await enqueueScheduledInstruction({
            caseType: 1,
            batchId: ctx.batchId,
            refInstruction: ctx.refInstruction,
            tagId: tag.id,
            scheduledTime: targetLookupTime,
            payload: {
                ctx,
                tagName: tag.name,
                displayDigits: tag.display_digits,
                fullDesc
            }
        });

        logger.info('Case1', `Target time is in the future (${targetLookupTime.toISOString()}). Enqueued persistent database task ${queued.id} for tag "${tag.name}" (RefInstruction: ${ctx.refInstruction})...`);

        return res.json({
            status: 'scheduled',
            case: 1,
            subcase: durationMs > 0 ? 'record_duration_point_in_time' : 'point_in_time',
            job_id: queued.id,
            batch_id: ctx.batchId,
            tag: tag.name,
            target_instruction: ctx.refInstruction,
            ref_time: ctx.refTime,
            duration_ms: durationMs > 0 ? durationMs : undefined,
            scheduled_time: targetLookupTime.toISOString(),
            delay_seconds: Math.round(delayMs / 1000),
            interpret: interpretConfig ? { raw: interpretConfig.raw, mapping: interpretConfig.mapping } : null,
            message: `Instruction scheduled in persistent queue. Value will be read and recorded to BatchLine when scheduled target time (${targetLookupTime.toISOString()}) elapses in ${Math.round(delayMs / 1000)}s.`
        });
    }

    // Synchronous execution (targetLookupTime is in the past or current)
    const reading = await getNearestReading(tag.id, targetLookupTime);
    if (!reading) {
        await reportError(`[BatchLine Case 1]: No reading or snapshot found for tag "${tag.name}" at target time ${targetLookupTime.toISOString()}`, ctx);
        return res.status(404).json({ error: `No reading or snapshot found for tag "${tag.name}" at target time ${targetLookupTime.toISOString()}` });
    }

    const standardFormattedValue = formatReadingValue(reading.value, tag.display_digits);
    const formattedValue = interpretConfig ? interpretConfig.interpret(reading.value, standardFormattedValue) : standardFormattedValue;
    const executedTimestamp = formatExecutedTimestamp(reading.ts);

    if (interpretConfig) {
        logger.info('Case1', `Applied [INTERPRET] mapping on tag "${tag.name}": raw value ${reading.value} (${standardFormattedValue}) -> "${formattedValue}"`);
    }

    const callbackResult = await sendBatchLineInstructionUpdate({
        refInstruction: ctx.refInstruction,
        batchId: ctx.batchId,
        callbackKey: ctx.callbackKey,
        actualResult: [
            {
                repeat_no: 1,
                value: formattedValue,
                executed_timestamp: executedTimestamp,
                executed_user_email: ctx.triggeredByEmail
            }
        ]
    });

    if (callbackResult?.ok) {
        logger.info('Case1', `Successfully updated instruction for tag ${tag.name} with value "${formattedValue}"`);
    } else {
        await reportError('[BatchLine Case 1]: Failed to update instruction', ctx, callbackResult?.data?.error?.detail || callbackResult?.error);
    }

    return res.json({
        status: 'success',
        case: 1,
        subcase: durationMs > 0 ? 'record_duration_point_in_time' : 'point_in_time',
        batch_id: ctx.batchId,
        tag: tag.name,
        ref_time: ctx.refTime,
        duration_ms: durationMs > 0 ? durationMs : undefined,
        target_lookup_time: targetLookupTime.toISOString(),
        interpret: interpretConfig ? { raw: interpretConfig.raw, mapping: interpretConfig.mapping } : null,
        reading: {
            ts: reading.ts,
            raw_value: reading.value,
            formatted_value: formattedValue,
            standard_formatted_value: standardFormattedValue,
            executed_timestamp: executedTimestamp,
            quality: reading.quality
        },
        callback: callbackResult
    });
}

/**
 * Worker execution handler for persistent scheduled Case 1 instructions.
 * Called by scheduledInstructionWorker when scheduled_time is reached.
 */
export async function executeScheduledCase1(task) {
    const payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : task.payload;
    const { ctx, tagName, displayDigits, fullDesc } = payload;

    const interpretConfig = extractInterpretMapping(fullDesc);
    const reading = await getNearestReading(task.tag_id, task.scheduled_time);

    if (!reading) {
        const errMsg = `No reading or snapshot found for tag "${tagName || task.tag_id}" at scheduled time`;
        await reportError(`[BatchLine Case 1 Worker]: ${errMsg}`, ctx);
        throw new Error(errMsg);
    }

    const standardFormattedValue = formatReadingValue(reading.value, displayDigits);
    const formattedValue = interpretConfig ? interpretConfig.interpret(reading.value, standardFormattedValue) : standardFormattedValue;
    const executedTimestamp = formatExecutedTimestamp(reading.ts);

    if (interpretConfig) {
        logger.info('Case1Worker', `Applied [INTERPRET] mapping for tag "${tagName}": raw ${reading.value} (${standardFormattedValue}) -> "${formattedValue}"`);
    }

    const callbackResult = await sendBatchLineInstructionUpdate({
        refInstruction: task.ref_instruction,
        batchId: task.batch_id,
        callbackKey: ctx?.callbackKey,
        actualResult: [
            {
                repeat_no: 1,
                value: formattedValue,
                executed_timestamp: executedTimestamp,
                executed_user_email: ctx?.triggeredByEmail
            }
        ]
    });

    if (!callbackResult?.ok) {
        const errMsg = callbackResult?.data?.error?.detail || callbackResult?.error || 'Unknown BatchLine update failure';
        await reportError(`[BatchLine Case 1 Worker]: Failed to update instruction for task ${task.id}`, ctx, errMsg);
        throw new Error(`BatchLine update failed: ${errMsg}`);
    }

    logger.info('Case1Worker', `Successfully executed scheduled task ${task.id} for tag "${tagName}" with value "${formattedValue}"`);
    return callbackResult;
}
