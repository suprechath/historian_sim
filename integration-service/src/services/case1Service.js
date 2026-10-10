import { logger } from '../utils/logger.js';
import {
    formatReadingValue,
    formatBatchLineDate,
    formatExecutedTimestamp,
    parseBatchLineDate
} from '../utils/formatters.js';
import {
    getCombinedDescription,
    extractExceptionTriggers,
    extractTimeTriggers,
    extractRecordDurationMs,
    extractInterpretMapping
} from '../utils/instructionParsers.js';
import { reportError, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';
import { resolveTag, getNearestReading, findRecordTimeNearestToValue } from '../dal/externalDal.js';
import { handleBatchExceptionTrigger } from './exceptionTriggerService.js';

/**
 * Case 1: Point-in-time value lookup and [TIME: VALUE=...] trigger processing
 */
export async function handleCase1PointInTime(ctx, res) {
    if (!ctx.refElement) {
        await reportError('[BatchLine Case 1]: Missing required RefElement in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefElement in instruction payload' });
    }

    const tag = await resolveTag(ctx.refElement, ctx);
    if (!tag) {
        await reportError(`[BatchLine Case 1]: Could not resolve tag for RefElement: "${ctx.refElement}"`, ctx);
        return res.status(404).json({ error: `Could not resolve tag for RefElement: "${ctx.refElement}"` });
    }

    const fullDesc = getCombinedDescription(ctx);
    const exceptionTriggers = extractExceptionTriggers(fullDesc, ctx.refInstruction);
    if (exceptionTriggers.length > 0) {
        return await handleBatchExceptionTrigger(ctx, res, exceptionTriggers);
    }

    const triggers = extractTimeTriggers(fullDesc, ctx.refInstruction);
    const durationMs = extractRecordDurationMs(fullDesc);
    const interpretConfig = extractInterpretMapping(fullDesc);

    let baseRefTime = null;
    let effectiveRefTime = null;
    if (ctx.refTime) {
        baseRefTime = parseBatchLineDate(ctx.refTime) || new Date(ctx.refTime);
        if (!isNaN(baseRefTime.getTime())) {
            effectiveRefTime = new Date(baseRefTime.getTime() + durationMs);
            if (durationMs !== 0) {
                logger.info('Case1', `Applied [RECORD: DURATION] offset of ${durationMs}ms (${durationMs / 60000}m). Base RefTime: ${baseRefTime.toISOString()} -> Actual RefTime: ${effectiveRefTime.toISOString()}`);
            }
        }
    }

    if (triggers.length > 0) {
        if (!ctx.refTime) {
            await reportError('[BatchLine Case 1]: Missing required RefTime in instruction payload for time trigger', ctx);
            return res.status(400).json({ error: 'Missing required RefTime in instruction payload for time trigger' });
        }

        if (!effectiveRefTime || isNaN(effectiveRefTime.getTime())) {
            await reportError(`[BatchLine Case 1]: Invalid RefTime date format: "${ctx.refTime}"`, ctx);
            return res.status(400).json({ error: `Invalid RefTime date format: "${ctx.refTime}"` });
        }

        const afterTime = effectiveRefTime;
        logger.info('Case1', `Processing ${triggers.length} time trigger(s) for tag "${tag.name}" after actual RefTime (${afterTime.toISOString()})...`);

        const triggerResults = [];
        for (const trigger of triggers) {
            const targetRef = trigger.targetRef || ctx.refInstruction;
            if (!targetRef) {
                await reportError('[BatchLine Case 1]: Missing target RefInstruction for time trigger update', ctx);
                continue;
            }

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
                actual_ref_time: afterTime.toISOString(),
                duration_offset_ms: durationMs,
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
            actual_ref_time: afterTime.toISOString(),
            duration_offset_ms: durationMs,
            triggers_processed: triggerResults.length,
            results: triggerResults
        });
    }

    // Default Case 1: Point-in-time value lookup
    const targetLookupTime = effectiveRefTime || ctx.refTime;
    const reading = await getNearestReading(tag.id, targetLookupTime);
    if (!reading) {
        await reportError(`[BatchLine Case 1]: No reading or snapshot found for tag "${tag.name}"`, ctx);
        return res.status(404).json({ error: `No reading or snapshot found for tag "${tag.name}"` });
    }

    const standardFormattedValue = formatReadingValue(reading.value, tag.display_digits);
    const formattedValue = interpretConfig ? interpretConfig.interpret(reading.value) : standardFormattedValue;
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
        batch_id: ctx.batchId,
        tag: tag.name,
        ref_time: ctx.refTime,
        actual_ref_time: effectiveRefTime ? effectiveRefTime.toISOString() : null,
        duration_offset_ms: durationMs,
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
