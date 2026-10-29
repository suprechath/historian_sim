import { logger } from '../utils/logger.js';
import {
    extractInstructionPayload,
    getCombinedDescription,
    extractExceptionTriggers,
    hasHealthCheckTrigger,
    hasPrevBatchTrigger
} from '../utils/instructionParsers.js';
import { reportError } from '../clients/batchLineClient.js';
import { checkAndForwardHighExceptions } from '../services/highExceptionService.js';
import { handleBatchExceptionTrigger } from '../services/exceptionTriggerService.js';
import { handleCase1PointInTime } from '../services/case1Service.js';
import { handlePreviousBatchInstruction } from '../services/previousBatchService.js';
import { handleCase2PhaseTimestamp } from '../services/case2Service.js';
import { handleCase3TimeRange } from '../services/case3Service.js';
import { handlePrintLabelInstruction } from '../services/printLabelService.js';
import { assignBatchToQueue, extractBatchStatusPayload, isProductSpecExcluded } from '../services/batchQueueService.js';
import { jobRegistry } from '../services/jobRegistry.js';
import { handleOnDemandHealthCheck } from '../services/healthCheckService.js';
import { handleStepTriggeredInstructions } from '../services/stepTriggeredTemplateService.js';

/**
 * Handles incoming BatchLine Instruction Webhook (/instruction)
 */
export async function handleInstructionWebhook(req, res) {
    let ctx = null;
    try {
        const body = req.body || {};
        const topic = body.Topic || '';

        // 0. Check for On-Demand Health Check trigger ([HEALTH_CHECK], [PING])
        const fullDesc = getCombinedDescription({ rawBody: body });

        // 1. Topic: print_label_instruction.update
        if (topic === 'print_label_instruction.update') {
            return await handlePrintLabelInstruction(req, res);
        }

        // 2. Topic: batch_execute.update
        if (topic === 'batch_execute.update') {

            // 2.2 Check for [EXCEPTION: REF=...] trigger across all description fields
            const exceptionTriggers = extractExceptionTriggers(fullDesc);

            if (exceptionTriggers.length > 0) {
                const batch = body.Data?.Batch || {};
                const instruction = batch.Phase?.Step?.Instruction || {};
                const actualResults = Array.isArray(instruction.ActualResult)
                    ? instruction.ActualResult
                    : (instruction.ActualResult ? [instruction.ActualResult] : []);
                const latestResult = actualResults[actualResults.length - 1] || actualResults[0] || {};

                ctx = {
                    batchId: batch.BatchId || body.batch_id || body.BatchId || null,
                    refInstruction: exceptionTriggers[0]?.targetRef || instruction.InstructionId || null,
                    callbackKey: body.CallbackKey || body.callbackkey || body.Data?.CallbackKey || null,
                    triggeredByEmail: latestResult.ExecutedUserEmail || instruction.TriggeredByEmail || body.TriggeredByEmail || null
                };
                return await handleBatchExceptionTrigger(ctx, res, exceptionTriggers);
            }

            // 2.3 Health Check
            if (hasHealthCheckTrigger(fullDesc)) {
                logger.info('InstructionWebhook', 'On-Demand Health Check trigger detected in instruction description.');
                return await handleOnDemandHealthCheck(req, res);
            }

            // 2.4 Check for Layer-2 step-triggered instruction templates
            const stepTriggerResult = await handleStepTriggeredInstructions(body);
            if (stepTriggerResult.matched > 0) {
                logger.info('InstructionWebhook', `batch_execute.update triggered ${stepTriggerResult.matched} step template(s) (${stepTriggerResult.executed} executed, ${stepTriggerResult.enqueued} enqueued).`);
                return res.json({
                    status: 'success',
                    message: `Triggered ${stepTriggerResult.matched} step template(s)`,
                    stepTriggers: stepTriggerResult
                });
            }

            // 2.1 High Exception requiring shopfloor intervention
            const highExceptionCheck = await checkAndForwardHighExceptions(body);
            if (highExceptionCheck.matched) {
                if (highExceptionCheck.suppressed) {
                    return res.json({
                        status: 'suppressed',
                        message: highExceptionCheck.reason,
                        lastAlertedAt: highExceptionCheck.lastAlertedAt
                    });
                }
                if (!highExceptionCheck.dispatched) {
                    return res.status(502).json({
                        status: 'error',
                        message: 'Failed to dispatch high exception alert to external webhook',
                        error: highExceptionCheck.error,
                        details: highExceptionCheck.results
                    });
                }
                return res.json({
                    status: 'success',
                    message: 'High exception forwarded to Make.com',
                    count: highExceptionCheck.results.length,
                    details: highExceptionCheck.results
                });
            }

            logger.info('InstructionWebhook', 'batch_execute.update received, no action is needed.');
            return res.json({ status: 'ignored', message: 'No action needed for batch_execute.update' });
        }

        // 3. Topic: batch_active_instruction.update
        if (topic === 'batch_active_instruction.update') {
            ctx = extractInstructionPayload(req.body);

            // 3.1 Validate EventType presence
            if (ctx.rawEventType === undefined || ctx.rawEventType === null || ctx.rawEventType === '' || Number.isNaN(Number(ctx.rawEventType))) {
                logger.info('InstructionWebhook', '/instruction received, no action is needed.');
                return res.status(400).json({ error: 'Missing required EventType in instruction payload' });
            }

            const eventType = Number(ctx.rawEventType);

            // Dispatch EventType cases
            if (eventType === 1) {
                // Check for [PREVBATCH] trigger word in instruction description
                if (hasPrevBatchTrigger(fullDesc) || hasPrevBatchTrigger(ctx.instructionDescription)) {
                    logger.info('InstructionWebhook', `[PREVBATCH] trigger detected for RefElement "${ctx.refElement}". Routing to previous batch lookup.`);
                    return await handlePreviousBatchInstruction(ctx, res);
                }
                return await handleCase1PointInTime(ctx, res);
            }

            if (eventType === 2) {
                return await handleCase2PhaseTimestamp(ctx, res);
            }

            if (eventType === 3) {
                return await handleCase3TimeRange(ctx, res);
            }

            const msg = `EventType ${eventType} not yet implemented`;
            await reportError(`[BatchLine Error]: ${msg}`, ctx);
            return res.status(501).json({
                error: msg,
                batchId: ctx.batchId,
                refInstruction: ctx.refInstruction
            });
        }

        logger.warn('InstructionWebhook', `Unhandled or unknown topic: '${topic}'`);
        return res.status(400).json({ error: `Unhandled topic: '${topic}'` });
    } catch (err) {
        await reportError('[Instruction Webhook Fatal Error]: ' + err.message, ctx || {}, err.stack);
        return res.status(500).json({ error: err.message });
    }
}

/**
 * Handles BatchLine Status Webhook Endpoint (POST /status)
 */
export async function handleStatusPost(req, res) {
    try {
        // logger.info('StatusWebhook', 'Received status payload:', req.body);
        const { isStarted, batchId, topic, batchStatus, productSpecificationId } = extractBatchStatusPayload(req.body);

        const isFinished = batchStatus ? ['completed', 'aborted', 'stopped', 'failed', 'cancelled'].includes(batchStatus.toLowerCase()) : false;
        if (isFinished && batchId) {
            logger.info('StatusWebhook', `BatchStatus '${batchStatus}' detected for BatchId '${batchId}'. Stopping active background interval jobs...`);
            await jobRegistry.stopAllForBatch(batchId);
        }

        let batchAssignment = null;
        if (isStarted && batchId) {
            const isExcluded = await isProductSpecExcluded(productSpecificationId);
            if (isExcluded) {
                logger.info('StatusWebhook', `Batch '${batchId}' with ProductSpecificationId '${productSpecificationId}' matches excluded_product_specifications table. Skipping automatic batch queue assignment.`);
                batchAssignment = {
                    assigned: false,
                    skipped: true,
                    reason: `ProductSpecificationId '${productSpecificationId}' is listed in excluded_product_specifications table.`,
                    batchId,
                    productSpecificationId
                };
            } else {
                logger.info('StatusWebhook', `BatchStatus 'Started' detected for BatchId '${batchId}'. Triggering automatic batch queue assignment with startImmediate=true...`);
                try {
                    const result = await assignBatchToQueue({
                        batchId,
                        startImmediate: true,
                        resetDownstream: false,
                        resume: false
                    });
                    if (result.alreadyInQueue) {
                        logger.info('StatusWebhook', `Batch '${result.cleanBatchId}' was already in queue/records (Status: '${result.initialStatus}'). Duplicate queue avoided.`);
                    } else if (result.pendingHealthCheck) {
                        logger.info('StatusWebhook', `Batch '${result.cleanBatchId}' has an active HEALTH_CHECK dialogue. Batch in Historian will start after user clicks close HEALTH_CHECK dialogue.`);
                    } else {
                        logger.info('StatusWebhook', `Batch '${result.cleanBatchId}' assigned to queue successfully with status '${result.initialStatus}'.`);
                    }
                    batchAssignment = {
                        assigned: !result.alreadyInQueue && !result.pendingHealthCheck,
                        batchId: result.cleanBatchId,
                        command: result.cmd,
                        status: result.initialStatus,
                        queueId: result.queueEntry?.id,
                        alreadyInQueue: Boolean(result.alreadyInQueue),
                        pendingHealthCheck: Boolean(result.pendingHealthCheck)
                    };
                } catch (assignErr) {
                    logger.warn('StatusWebhook', `Automatic batch assignment skipped/failed for batch '${batchId}': ${assignErr.message}`);
                    batchAssignment = {
                        assigned: false,
                        skipped: false,
                        batchId,
                        error: assignErr.message
                    };
                }
            }
        }

        res.json({
            status: 'received',
            topic,
            ...(batchAssignment ? { batchAssignment } : {}),
            timestamp: new Date()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * Health / ready probe for status endpoint (GET /status)
 */
export function handleStatusGet(req, res) {
    res.json({ status: 'ready', endpoint: '/api/v1/status' });
}
