import { logger } from '../utils/logger.js';
import { formatExecutedTimestamp } from '../utils/formatters.js';
import { extractInterpretMapping, getCombinedDescription } from '../utils/instructionParsers.js';
import { reportError, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';
import { resolveAsset, getPreviousBatchForAsset } from '../dal/externalDal.js';

/**
 * Handles [PREVBATCH] trigger case for EventType 1.
 * Looks up the previous batch number executed on the specified equipment element (RefElement)
 * and dispatches the batch number back to BatchLine active instruction (RefInstruction).
 * Note: RefTime can be null in this request and is not used for filtering.
 *
 * @param {object} ctx - Instruction payload context.
 * @param {object} res - Express response object.
 * @returns {Promise<object>} Express response json.
 */
export async function handlePreviousBatchInstruction(ctx, res) {
    try {
        if (!ctx.refElement) {
            await reportError('[BatchLine Previous Batch]: Missing required RefElement in instruction payload', ctx);
            return res.status(400).json({ error: 'Missing required RefElement in instruction payload' });
        }

        if (!ctx.refInstruction) {
            await reportError('[BatchLine Previous Batch]: Missing required RefInstruction in instruction payload', ctx);
            return res.status(400).json({ error: 'Missing required RefInstruction in instruction payload' });
        }

        if (!ctx.batchId) {
            await reportError('[BatchLine Previous Batch]: Missing required BatchId in instruction payload', ctx);
            return res.status(400).json({ error: 'Missing required BatchId in instruction payload' });
        }

        const asset = await resolveAsset(ctx.refElement, ctx);
        if (!asset) {
            await reportError(`[BatchLine Previous Batch]: Could not resolve asset for RefElement: "${ctx.refElement}"`, ctx);
            return res.status(404).json({ error: `Could not resolve asset for RefElement: "${ctx.refElement}"` });
        }

        const previousBatch = await getPreviousBatchForAsset({
            assetId: asset.id,
            currentBatchId: ctx.batchId
        });

        if (!previousBatch || !previousBatch.batch_id) {
            const errMsg = `No previous batch found for RefElement "${ctx.refElement}" (Asset: ${asset.code})`;
            await reportError(`[BatchLine Previous Batch]: ${errMsg}`, ctx);
            return res.status(404).json({ error: errMsg });
        }

        const fullDesc = getCombinedDescription(ctx);
        const interpretConfig = extractInterpretMapping(fullDesc);
        const rawBatchNumber = previousBatch.batch_id;
        const formattedValue = interpretConfig ? interpretConfig.interpret(rawBatchNumber, rawBatchNumber) : rawBatchNumber;
        const executedTimestamp = formatExecutedTimestamp(new Date());

        logger.info('PreviousBatch', `Found previous batch "${rawBatchNumber}" for element "${ctx.refElement}" (Asset: ${asset.code}). Recording back to instruction "${ctx.refInstruction}"...`);

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
            logger.info('PreviousBatch', `Successfully updated instruction "${ctx.refInstruction}" with previous batch "${formattedValue}"`);
        } else {
            await reportError(`[BatchLine Previous Batch]: Failed to update instruction ${ctx.refInstruction}`, ctx, callbackResult?.data?.error?.detail || callbackResult?.error);
        }

        return res.json({
            status: 'success',
            case: 1,
            subcase: 'previous_batch',
            batch_id: ctx.batchId,
            asset: {
                id: asset.id,
                code: asset.code,
                display_name: asset.display_name
            },
            ref_element: ctx.refElement,
            target_instruction: ctx.refInstruction,
            previous_batch: {
                id: previousBatch.id,
                batch_id: rawBatchNumber,
                formatted_value: formattedValue,
                started_at: previousBatch.started_at,
                ended_at: previousBatch.ended_at,
                status: previousBatch.status
            },
            callback: callbackResult
        });
    } catch (err) {
        await reportError('[BatchLine Previous Batch Fatal Error]: ' + err.message, ctx, err.stack);
        return res.status(500).json({ error: err.message });
    }
}
