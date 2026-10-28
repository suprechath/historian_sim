import { Router } from 'express';
import {
    handleInstructionWebhook,
    handleStatusPost,
    handleStatusGet
} from '../controllers/externalController.js';
import { checkAndForwardHighExceptions } from '../services/highExceptionService.js';

import { assignBatchToQueue } from '../services/batchQueueService.js';
import {
    getPredefinedTemplates,
    upsertPredefinedTemplate,
    instantiatePredefinedBatchInstructions
} from '../services/instructionTemplateService.js';
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
        logger.info('HealthCheck', `Health check dialogue closed for Batch "${batchId}".`);
        let hcDetails = null;
        if (id) {
            try {
                const updateRes = await query('UPDATE integration_health_checks SET acknowledged_at = NOW() WHERE id = $1 RETURNING details', [id]);
                if (updateRes?.rows?.length > 0) {
                    const rawDetails = updateRes.rows[0].details;
                    hcDetails = typeof rawDetails === 'string' ? JSON.parse(rawDetails) : rawDetails;
                }
            } catch (uErr) {
                logger.warn('HealthCheck', `Could not update acknowledged_at on health check: ${uErr.message}`);
            }
        }

        if (!hcDetails && batchId && batchId !== 'UNKNOWN') {
            try {
                const lookup = await query('SELECT details FROM integration_health_checks WHERE batch_id = $1 ORDER BY created_at DESC LIMIT 1', [String(batchId).trim()]);
                if (lookup?.rows?.length > 0) {
                    const rawDetails = lookup.rows[0].details;
                    hcDetails = typeof rawDetails === 'string' ? JSON.parse(rawDetails) : rawDetails;
                }
            } catch (lErr) {
                // non-fatal
            }
        }

        const callbackKey = req.body?.callbackKey || hcDetails?.callbackKey || null;
        const triggeredByEmail = req.body?.triggeredByEmail || hcDetails?.triggeredByEmail || null;

        let batchAssignment = null;
        let templateInstantiation = null;

        if (batchId && batchId !== 'UNKNOWN' && String(batchId).trim()) {
            const cleanBatchId = String(batchId).trim();
            let result = null;
            try {
                result = await assignBatchToQueue({
                    batchId: cleanBatchId,
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

            // Only when assignBatchToQueue was done completely within /health/close, start to instantiate predefined instructions
            if (result && batchAssignment?.assigned) {
                const targetBatchId = result.cleanBatchId || cleanBatchId || batchId;
                try {
                    logger.info('HealthCheck', `Health check PASSED for Batch "${targetBatchId}". Auto-instantiating predefined recipe instructions into scheduled worker...`);
                    templateInstantiation = await instantiatePredefinedBatchInstructions({
                        batchId: targetBatchId,
                        callbackKey,
                        triggeredByEmail
                    });
                    logger.info('HealthCheck', `Auto-instantiation complete: ${templateInstantiation.enqueued}/${templateInstantiation.total} instructions queued for Batch "${targetBatchId}".`);
                } catch (templateErr) {
                    logger.warn('HealthCheck', `Failed to auto-instantiate predefined instructions for Batch "${targetBatchId}":`, templateErr.message);
                    templateInstantiation = {
                        batchId: targetBatchId,
                        total: 0,
                        enqueued: 0,
                        error: templateErr.message
                    };
                }
            }
        }

        res.json({
            status: 'closed',
            healthCheckId: id || null,
            batchAssignment,
            templates: templateInstantiation
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * List Predefined Instruction Templates (/templates)
 */
router.get('/templates', async (req, res) => {
    try {
        const { recipeVersion, activeOnly } = req.query;
        const templates = await getPredefinedTemplates({
            recipeVersion: recipeVersion || null,
            activeOnly: activeOnly === 'true'
        });
        res.json({
            status: 'success',
            count: templates.length,
            templates
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Create or Update Predefined Instruction Template (/templates)
 */
router.post('/templates', async (req, res) => {
    try {
        const {
            recipeVersion,
            name,
            instructionId,
            instructionDescription,
            refInstruction,
            eventType,
            caseType,
            refEvent,
            refType,
            refElement,
            refTime,
            refStartTime,
            refEndTime,
            expectedResult,
            isActive
        } = req.body || {};

        const effectiveEventType = Number(eventType || caseType);
        if (!name || !effectiveEventType || !refInstruction || !instructionDescription) {
            return res.status(400).json({
                error: 'Missing required fields: name, eventType (or caseType), refInstruction, instructionDescription'
            });
        }
        const saved = await upsertPredefinedTemplate({
            recipeVersion: recipeVersion || 'v2.1',
            name,
            instructionId,
            instructionDescription,
            refInstruction,
            eventType: effectiveEventType,
            refEvent,
            refType,
            refElement,
            refTime,
            refStartTime,
            refEndTime,
            expectedResult,
            isActive: isActive !== false
        });
        res.json({
            status: 'success',
            template: saved
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Manually trigger Predefined Instruction Instantiation for a Batch (/templates/instantiate)
 */
router.post('/templates/instantiate', async (req, res) => {
    try {
        const { batchId, callbackKey, triggeredByEmail, recipeVersion } = req.body || {};
        if (!batchId) {
            return res.status(400).json({ error: 'Missing required field: batchId' });
        }
        const result = await instantiatePredefinedBatchInstructions({
            batchId,
            callbackKey,
            triggeredByEmail,
            recipeVersion: recipeVersion || 'v2.1'
        });
        res.json({
            status: 'success',
            instantiation: result
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Named exports for backward compatibility
export { checkAndForwardHighExceptions };

export default router;