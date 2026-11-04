import { logger } from '../utils/logger.js';
import { formatExecutedTimestamp, parseBatchLineDate } from '../utils/formatters.js';
import { extractInterpretMapping, getCombinedDescription, extractForceUpdateTriggers } from '../utils/instructionParsers.js';
import { reportError, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';

/**
 * Handles dynamic force update triggers for EventType 1.
 * Supports patterns like:
 *   [REF=REAC, VALUE=R1]
 *   [FORCE: REF=REAC, VALUE=R1]
 *   [REF="REAC", VALUE="R1", REPEAT=1]
 *
 * Directly pushes static or dynamic values into BatchLine instruction(s)
 * without requiring Historian sensor tag lookups.
 *
 * @param {object} ctx - Instruction payload context.
 * @param {object} res - Express response object.
 * @param {Array<object>} [triggers] - Pre-extracted force update triggers (optional).
 * @returns {Promise<object>} Express response json.
 */
export async function handleForceUpdateInstruction(ctx, res, triggers = null) {
    try {
        if (!ctx.batchId) {
            await reportError('[BatchLine Force Update]: Missing required BatchId in instruction payload', ctx);
            return res.status(400).json({ error: 'Missing required BatchId in instruction payload' });
        }

        const fullDesc = getCombinedDescription(ctx);
        const resolvedTriggers = (triggers && triggers.length > 0)
            ? triggers
            : extractForceUpdateTriggers(fullDesc || ctx.instructionDescription, ctx.refInstruction);

        if (!resolvedTriggers || resolvedTriggers.length === 0) {
            const errMsg = 'No valid dynamic force update triggers found in instruction description';
            await reportError(`[BatchLine Force Update]: ${errMsg}`, ctx);
            return res.status(400).json({ error: errMsg });
        }

        const interpretConfig = extractInterpretMapping(fullDesc);
        const baseTime = (ctx.refTime ? parseBatchLineDate(ctx.refTime) : null) || new Date();
        const defaultExecutedTimestamp = formatExecutedTimestamp(baseTime);

        // Group triggers by targetRef to dispatch one update call per instruction with all repeats
        const groupedByRef = new Map();
        for (const trigger of resolvedTriggers) {
            const targetRef = trigger.targetRef || ctx.refInstruction;
            if (!targetRef) continue;

            if (!groupedByRef.has(targetRef)) {
                groupedByRef.set(targetRef, []);
            }
            groupedByRef.get(targetRef).push(trigger);
        }

        if (groupedByRef.size === 0) {
            const errMsg = 'Missing target RefInstruction for dynamic force update';
            await reportError(`[BatchLine Force Update]: ${errMsg}`, ctx);
            return res.status(400).json({ error: errMsg });
        }

        const updateResults = [];

        for (const [targetRef, targetTriggers] of groupedByRef.entries()) {
            const actualResult = targetTriggers.map((t, idx) => {
                const rawVal = t.value;
                const formattedValue = interpretConfig ? interpretConfig.interpret(rawVal, rawVal) : rawVal;
                const executedTimestamp = defaultExecutedTimestamp;

                return {
                    repeat_no: t.hasExplicitRepeat ? t.repeatNo : (t.repeatNo || (idx + 1)),
                    value: formattedValue,
                    executed_timestamp: executedTimestamp,
                    executed_user_email: ctx.triggeredByEmail || null
                };
            });

            logger.info('ForceUpdate', `Dispatching dynamic force update to instruction "${targetRef}" with ${actualResult.length} item(s) for batch "${ctx.batchId}"...`);

            const callbackResult = await sendBatchLineInstructionUpdate({
                refInstruction: targetRef,
                batchId: ctx.batchId,
                callbackKey: ctx.callbackKey,
                actualResult
            });

            if (callbackResult?.ok) {
                logger.info('ForceUpdate', `Successfully force-updated instruction "${targetRef}" with value(s): ${actualResult.map(r => r.value).join(', ')}`);
            } else {
                await reportError(`[BatchLine Force Update]: Failed to update instruction ${targetRef}`, ctx, callbackResult?.data?.error?.detail || callbackResult?.error);
            }

            updateResults.push({
                target_instruction: targetRef,
                batch_id: ctx.batchId,
                actual_result: actualResult,
                callback: callbackResult
            });
        }

        if (updateResults.length === 1) {
            const single = updateResults[0];
            const primaryItem = single.actual_result[0] || {};
            return res.json({
                status: 'success',
                case: 1,
                subcase: 'force_update',
                batch_id: single.batch_id,
                target_instruction: single.target_instruction,
                value: primaryItem.value,
                actual_result: single.actual_result,
                executed_timestamp: primaryItem.executed_timestamp,
                executed_user_email: primaryItem.executed_user_email,
                callback: single.callback
            });
        }

        return res.json({
            status: 'success',
            case: 1,
            subcase: 'force_update',
            batch_id: ctx.batchId,
            directives_processed: updateResults.length,
            results: updateResults
        });
    } catch (err) {
        await reportError('[BatchLine Force Update Fatal Error]: ' + err.message, ctx, err.stack);
        return res.status(500).json({ error: err.message });
    }
}

