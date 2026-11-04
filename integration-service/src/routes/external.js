import { Router } from 'express';
import {
    handleInstructionWebhook,
    handleStatusPost,
    handleStatusGet
} from '../controllers/externalController.js';
import { checkAndForwardHighExceptions } from '../services/highExceptionService.js';
import { getBatchLineOutboundLogs } from '../dal/batchLineOutboundDal.js';

const router = Router();

// ===========================================================================
// MAIN WEBHOOK ROUTES
// ===========================================================================

/**
 * BatchLine Instruction Webhook (/instruction)
 */
router.post('/instruction', handleInstructionWebhook);

/**
 * BatchLine Status Webhooks (/status)
 */
router.post('/status', handleStatusPost);
router.get('/status', handleStatusGet);

/**
 * Query Outbound BatchLine Audit Logs (/batchline/outbound-logs)
 */
router.get('/batchline/outbound-logs', async (req, res) => {
    try {
        const { batch_id, callback_key, ref_instruction, status, action, limit, offset } = req.query;
        const logs = await getBatchLineOutboundLogs({
            batchId: batch_id,
            callbackKey: callback_key,
            refInstruction: ref_instruction,
            status,
            action,
            limit: limit ? parseInt(limit, 10) : 50,
            offset: offset ? parseInt(offset, 10) : 0
        });
        return res.json({ status: 'success', count: logs.length, data: logs });
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// Named exports for backward compatibility
export { checkAndForwardHighExceptions };

export default router;
