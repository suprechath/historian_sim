import { logger } from '../utils/logger.js';
import { formatReadingValue, formatExecutedTimestamp } from '../utils/formatters.js';
import { reportError, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';
import { findBatchByIdOrActive, getBatchExceptions } from '../dal/externalDal.js';

/**
 * Handles [EXCEPTION: REF=...] triggers.
 * Queries batch_exceptions for the batch and returns repeats formatted as:
 * "Phase : phase_name, Type: exception_type, Limit: limit_value, Actual: peak_value"
 */
export async function handleBatchExceptionTrigger(ctx, res, triggers) {
    const rawBatchId = ctx.batchId;
    const batchRow = await findBatchByIdOrActive(rawBatchId);

    const triggerResults = [];

    for (const trigger of triggers) {
        const targetRef = trigger.targetRef || ctx.refInstruction || ctx.instruction?.InstructionId;
        if (!targetRef) {
            await reportError('[BatchLine Exception]: Missing target RefInstruction for exception update', ctx);
            continue;
        }

        let exceptions = [];
        if (batchRow) {
            exceptions = await getBatchExceptions(batchRow.id, trigger.filterPhase, trigger.filterTag);
        }

        let actualResult = [];
        if (exceptions.length > 0) {
            actualResult = exceptions.map((ex, idx) => {
                const limitVal = formatReadingValue(ex.limit_value, ex.display_digits);
                const peakVal = formatReadingValue(ex.peak_value, ex.display_digits);
                const msg = `Phase : ${ex.phase_name || 'N/A'}, Type: ${ex.exception_type}, Limit: ${limitVal}, Actual: ${peakVal}`;
                return {
                    repeat_no: idx + 1,
                    value: msg,
                    executed_timestamp: formatExecutedTimestamp(ex.started_at || new Date()),
                    executed_user_email: ctx.triggeredByEmail || "qa1@cs.com"
                };
            });
        } else {
            actualResult = [
                {
                    repeat_no: 1,
                    value: 'None',
                    executed_timestamp: formatExecutedTimestamp(new Date()),
                    executed_user_email: ctx.triggeredByEmail || null
                }
            ];
        }

        logger.info('BatchLineException', `Dispatching ${actualResult.length} item(s) to instruction ${targetRef} for batch ${batchRow?.batch_id || rawBatchId}...`);

        const callbackResult = await sendBatchLineInstructionUpdate({
            refInstruction: targetRef,
            batchId: ctx.batchId || batchRow?.batch_id,
            callbackKey: ctx.callbackKey,
            actualResult
        });

        if (callbackResult?.ok) {
            logger.info('BatchLineException', `Successfully updated instruction ${targetRef} with exception results`);
        } else {
            await reportError(`[BatchLine Exception]: Failed to update instruction ${targetRef}`, ctx, callbackResult?.data?.error?.detail || callbackResult?.error);
        }

        triggerResults.push({
            target_ref: targetRef,
            batch_id: ctx.batchId || batchRow?.batch_id,
            exception_count: exceptions.length,
            actual_result: actualResult,
            callback: callbackResult
        });
    }

    if (triggerResults.length === 1) {
        const single = triggerResults[0];
        return res.json({
            status: 'success',
            type: 'batch_exception_summary',
            batch_id: single.batch_id,
            target_instruction: single.target_ref,
            exception_count: single.exception_count,
            actual_result: single.actual_result,
            callback: single.callback
        });
    }

    return res.json({
        status: 'success',
        type: 'batch_exception_summary',
        batch_id: ctx.batchId || batchRow?.batch_id,
        triggers_processed: triggerResults.length,
        results: triggerResults
    });
}
