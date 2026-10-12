import { logger } from '../utils/logger.js';
import { formatBatchLineDate, formatExecutedTimestamp } from '../utils/formatters.js';
import { getCombinedDescription, hasScheduleTrigger } from '../utils/instructionParsers.js';
import { reportError, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';
import {
    findEventForBatch,
    enqueueScheduledInstruction,
    rescheduleInstruction
} from '../dal/externalDal.js';

// Poll every 5 seconds; allow up to 48 hours of polling attempts (48 * 3600 / 5 = 34560 attempts)
const CASE2_POLL_INTERVAL_SECONDS = 10;
const CASE2_MAX_SCHEDULE_HOURS = 48;
const CASE2_MAX_ATTEMPTS = Math.floor((CASE2_MAX_SCHEDULE_HOURS * 3600) / CASE2_POLL_INTERVAL_SECONDS);

/**
 * Normalizes and determines whether RefType is Start or End.
 */
function parseRefType(refType) {
    const normalized = String(refType || '').trim().toLowerCase();
    const isStart = /^(starttime|started_at|start)$/i.test(normalized);
    const isEnd = /^(endtime|ended_at|end)$/i.test(normalized);
    return { isStart, isEnd, valid: isStart || isEnd };
}

/**
 * Case 2: Start time / End time phase lookup (with optional [SCHEDULE] background polling)
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

    const { isStart, isEnd, valid } = parseRefType(ctx.refType);
    if (!valid) {
        await reportError(`[BatchLine Case 2]: Invalid RefType: "${ctx.refType}". Expected "StartTime" or "EndTime"`, ctx);
        return res.status(400).json({
            error: `Invalid RefType: "${ctx.refType}". Expected "StartTime" or "EndTime"`
        });
    }

    const fullDesc = getCombinedDescription(ctx);
    const isScheduled = hasScheduleTrigger(fullDesc);

    const event = await findEventForBatch({
        refRecipe: recipeBatchId,
        refEvent: ctx.refEvent
    });

    const selectedField = isStart ? 'started_at' : 'ended_at';
    const targetTime = event ? (isStart ? event.started_at : event.ended_at) : null;

    // If scheduled and timestamp is not yet available, enqueue for background polling
    if (isScheduled && !targetTime) {
        const queued = await enqueueScheduledInstruction({
            caseType: 2,
            batchId: ctx.batchId,
            refInstruction: ctx.refInstruction,
            tagId: null,
            scheduledTime: new Date(Date.now() + CASE2_POLL_INTERVAL_SECONDS * 1000),
            payload: {
                ctx,
                recipeBatchId,
                refEvent: ctx.refEvent,
                refType: ctx.refType,
                selectedField,
                isStart
            },
            maxAttempts: CASE2_MAX_ATTEMPTS
        });

        const statusDetail = !event
            ? `Phase "${ctx.refEvent}" not yet created in database`
            : `Phase "${event.name}" has no ${selectedField} yet (in-progress)`;

        logger.info('Case2', `[SCHEDULE] detected for "${ctx.refEvent}". ${statusDetail}. Enqueued background polling job ${queued.id} (polling every ${CASE2_POLL_INTERVAL_SECONDS}s)...`);

        return res.json({
            status: 'scheduled',
            case: 2,
            job_id: queued.id,
            batch_id: ctx.batchId,
            ref_recipe: recipeBatchId,
            ref_event: ctx.refEvent,
            ref_type: ctx.refType,
            target_instruction: ctx.refInstruction,
            poll_interval_seconds: CASE2_POLL_INTERVAL_SECONDS,
            max_schedule_hours: CASE2_MAX_SCHEDULE_HOURS,
            message: `Instruction scheduled for background polling. Integration service will poll every ${CASE2_POLL_INTERVAL_SECONDS}s and push the ${ctx.refType} to BatchLine once the event occurs.`
        });
    }

    // Non-scheduled or timestamp already ready: immediate evaluation
    if (!event) {
        await reportError(`[BatchLine Case 2]: Could not find phase/event "${ctx.refEvent}" for batch "${recipeBatchId}"`, ctx);
        return res.status(404).json({
            error: `Could not find phase/event "${ctx.refEvent}" for batch "${recipeBatchId}"`
        });
    }

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

/**
 * Worker execution handler for persistent scheduled Case 2 polling instructions.
 * Called by scheduledInstructionWorker when task is due.
 */
export async function executeScheduledCase2(task) {
    const payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : task.payload;
    const { ctx, recipeBatchId, refEvent, refType, selectedField, isStart } = payload;

    const event = await findEventForBatch({
        refRecipe: recipeBatchId,
        refEvent
    });

    const targetTime = event ? (isStart ? event.started_at : event.ended_at) : null;

    // If target timestamp is not yet reached, reschedule to check again in CASE2_POLL_INTERVAL_SECONDS
    if (!targetTime) {
        const reason = !event
            ? `Phase "${refEvent}" not yet created in database`
            : `Phase "${event.name}" ${selectedField} is not set yet`;

        logger.debug('Case2Worker', `Task ${task.id}: ${reason}. Rescheduling in ${CASE2_POLL_INTERVAL_SECONDS}s (attempt ${task.attempts}/${task.max_attempts})...`);
        await rescheduleInstruction(task.id, CASE2_POLL_INTERVAL_SECONDS, reason);
        return { scheduled: true, reason };
    }

    const formattedTime = formatBatchLineDate(targetTime);
    const executedTimestamp = formatExecutedTimestamp(targetTime);

    logger.info('Case2Worker', `Phase "${event.name}" ${selectedField} found (${formattedTime}) for task ${task.id}. Sending update to BatchLine...`);

    const callbackResult = await sendBatchLineInstructionUpdate({
        refInstruction: task.ref_instruction,
        batchId: task.batch_id,
        callbackKey: ctx?.callbackKey,
        actualResult: [
            {
                repeat_no: 1,
                value: formattedTime,
                executed_timestamp: executedTimestamp,
                executed_user_email: ctx?.triggeredByEmail
            }
        ]
    });

    if (!callbackResult?.ok) {
        const errMsg = callbackResult?.data?.error?.detail || callbackResult?.error || 'Unknown BatchLine update failure';
        await reportError(`[BatchLine Case 2 Worker]: Failed to update instruction for task ${task.id}`, ctx, errMsg);
        throw new Error(`BatchLine update failed: ${errMsg}`);
    }

    logger.info('Case2Worker', `Successfully executed scheduled task ${task.id} for phase "${event.name}" (${selectedField}): ${formattedTime}`);
    return callbackResult;
}
