import { Router } from 'express';
import {
    handleInstructionWebhook,
    handleStatusPost,
    handleStatusGet
} from '../controllers/externalController.js';
import { checkAndForwardHighExceptions } from '../services/highExceptionService.js';

import { assignBatchToQueue } from '../services/batchQueueService.js';
import { query } from '../db.js';
import { logger } from '../utils/logger.js';

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
 * Health Check Dialogue Acknowledge & Batch Queue Start (/health/close)
 * Triggered when operator closes the HEALTH_CHECK dialogue on Historian screen.
 * Starts batch with standard logic "wait R1 available" (startImmediate: true).
 */
router.post(['/health/close', '/integration/health/close'], async (req, res) => {
    try {
        const { id, batchId } = req.body || {};
        if (id) {
            try {
                await query('UPDATE integration_health_checks SET acknowledged_at = NOW() WHERE id = $1', [id]);
            } catch (uErr) {
                logger.warn('HealthCheck', `Could not update acknowledged_at on health check: ${uErr.message}`);
            }
        }

        let batchAssignment = null;
        if (batchId && batchId !== 'UNKNOWN' && String(batchId).trim()) {
            try {
                const result = await assignBatchToQueue({
                    batchId: String(batchId).trim(),
                    startImmediate: true,
                    resetDownstream: false,
                    resume: false,
                    fromHealthCheckClose: true
                });
                batchAssignment = {
                    assigned: true,
                    batchId: result.cleanBatchId,
                    command: result.cmd,
                    status: result.initialStatus,
                    alreadyInQueue: Boolean(result.alreadyInQueue)
                };
            } catch (assignErr) {
                logger.warn('HealthCheck', `Automatic batch assignment on health check close skipped for '${batchId}': ${assignErr.message}`);
                batchAssignment = {
                    assigned: false,
                    batchId,
                    error: assignErr.message
                };
            }
        }

        res.json({
            status: 'closed',
            healthCheckId: id || null,
            batchAssignment
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Named exports for backward compatibility
export { checkAndForwardHighExceptions };

export default router;