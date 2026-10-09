import { logger } from '../utils/logger.js';
import { formatBatchLineDate, formatExecutedTimestamp } from '../utils/formatters.js';
import { reportError, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';
import { findEventForBatch } from '../dal/externalDal.js';

/**
 * Case 2: Start time / End time phase lookup
 */
export async function handleCase2PhaseTimestamp(ctx, res) {
    const recipeBatchId = ctx.refRecipe || ctx.batchId;
    if (!recipeBatchId) {
        await reportError('[BatchLine Case 2]: Missing required RefRecipe in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefRecipe in instruction payload' });
    }
    if (!ctx.refEvent) {
        await reportError('[BatchLine Case 2]: Missing required RefEvent in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefEvent in instruction payload' });
    }
    if (!ctx.refType) {
        await reportError('[BatchLine Case 2]: Missing required RefType in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefType in instruction payload' });
    }

    const normalizedType = String(ctx.refType).trim().toLowerCase();
    const isStart = /^(starttime|started_at|start)$/i.test(normalizedType);
    const isEnd = /^(endtime|ended_at|end)$/i.test(normalizedType);

    if (!isStart && !isEnd) {
        await reportError(`[BatchLine Case 2]: Invalid RefType: "${ctx.refType}". Expected "StartTime" or "EndTime"`, ctx);
        return res.status(400).json({
            error: `Invalid RefType: "${ctx.refType}". Expected "StartTime" or "EndTime"`
        });
    }

    const event = await findEventForBatch({
        refRecipe: recipeBatchId,
        refEvent: ctx.refEvent
    });

    if (!event) {
        await reportError(`[BatchLine Case 2]: Could not find phase/event "${ctx.refEvent}" for batch "${recipeBatchId}"`, ctx);
        return res.status(404).json({
            error: `Could not find phase/event "${ctx.refEvent}" for batch "${recipeBatchId}"`
        });
    }

    const selectedField = isStart ? 'started_at' : 'ended_at';
    const targetTime = isStart ? event.started_at : event.ended_at;

    if (!targetTime) {
        await reportError(`[BatchLine Case 2]: Phase "${event.name}" for batch "${recipeBatchId}" has no ${selectedField} yet`, ctx);
        return res.status(400).json({
            error: `Phase "${event.name}" for batch "${recipeBatchId}" has no ${selectedField} yet (phase may still be in progress)`,
            event: {
                id: event.id,
                name: event.name,
                level: event.level,
                asset: event.asset_code,
                started_at: event.started_at,
                ended_at: event.ended_at
            }
        });
    }

    const formattedTime = formatBatchLineDate(targetTime);
    const executedTimestamp = formatExecutedTimestamp(targetTime);

    const callbackResult = await sendBatchLineInstructionUpdate({
        refInstruction: ctx.refInstruction,
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
        logger.info('Case2', `Successfully updated phase time for ${event.name}`);
    } else {
        await reportError('[BatchLine Case 2]: Failed to update phase time', ctx, callbackResult?.data || callbackResult?.error);
    }

    return res.json({
        status: 'success',
        case: 2,
        batch_id: ctx.batchId,
        ref_recipe: recipeBatchId,
        ref_event: ctx.refEvent,
        ref_type: ctx.refType,
        timestamp: formattedTime,
        executed_timestamp: executedTimestamp,
        event: {
            id: event.id,
            name: event.name,
            level: event.level,
            asset: event.asset_code,
            started_at: event.started_at,
            ended_at: event.ended_at,
            selected_field: selectedField,
            selected_time: targetTime,
            formatted_value: formattedTime,
            executed_timestamp: executedTimestamp
        },
        callback: callbackResult
    });
}
