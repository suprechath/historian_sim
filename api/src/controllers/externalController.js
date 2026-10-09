import { logger } from '../utils/logger.js';
import {
    extractInstructionPayload,
    getCombinedDescription,
    extractExceptionTriggers
} from '../utils/instructionParsers.js';
import { reportError } from '../clients/batchLineClient.js';
import { checkAndForwardHighExceptions } from '../services/highExceptionService.js';
import { handleBatchExceptionTrigger } from '../services/exceptionTriggerService.js';
import { handleCase1PointInTime } from '../services/case1Service.js';
import { handleCase2PhaseTimestamp } from '../services/case2Service.js';
import { handleCase3TimeRange } from '../services/case3Service.js';
import { handlePrintLabelInstruction } from '../services/printLabelService.js';

/**
 * Handles incoming BatchLine Instruction Webhook (/instruction)
 */
export async function handleInstructionWebhook(req, res) {
    let ctx = null;
    try {
        const body = req.body || {};
        const topic = body.Topic || '';

        // 1. Check if this is the print_label_instruction hook
        if (topic === 'print_label_instruction.update' || (body.Data?.Batch?.Phases && !body.Data?.Batch?.Phase)) {
            return await handlePrintLabelInstruction(req, res);
        }

        ctx = extractInstructionPayload(req.body);

        // 2. Check for High Exception requiring shopfloor intervention
        const highExceptionCheck = await checkAndForwardHighExceptions(body);
        if (highExceptionCheck.matched) {
            if (highExceptionCheck.suppressed) {
                return res.json({
                    status: 'suppressed',
                    message: highExceptionCheck.reason,
                    lastAlertedAt: highExceptionCheck.lastAlertedAt
                });
            }
            return res.json({
                status: 'success',
                message: 'High exception forwarded to Make.com',
                count: highExceptionCheck.results.length,
                details: highExceptionCheck.results
            });
        }

        // 3. Check for [EXCEPTION: REF=...] trigger across all description fields
        const fullDesc = getCombinedDescription(ctx);
        const exceptionTriggers = extractExceptionTriggers(fullDesc, ctx.refInstruction);
        if (exceptionTriggers.length > 0) {
            return await handleBatchExceptionTrigger(ctx, res, exceptionTriggers);
        }

        // 4. Validate EventType presence
        if (ctx.rawEventType === undefined || ctx.rawEventType === null || ctx.rawEventType === '' || Number.isNaN(Number(ctx.rawEventType))) {
            logger.info('InstructionWebhook', '/instruction received, no action is needed.');
            return res.status(400).json({ error: 'Missing required EventType in instruction payload' });
        }

        const eventType = Number(ctx.rawEventType);

        // 5. Dispatch EventType cases
        if (eventType === 1) {
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
        logger.info('StatusWebhook', 'Received status payload:', req.body);
        res.json({
            status: 'received',
            topic: req.body?.Topic || null,
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
