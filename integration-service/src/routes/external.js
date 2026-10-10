import { Router } from 'express';
import {
    handleInstructionWebhook,
    handleStatusPost,
    handleStatusGet
} from '../controllers/externalController.js';
import { checkAndForwardHighExceptions } from '../services/highExceptionService.js';

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

// Named exports for backward compatibility
export { checkAndForwardHighExceptions };

export default router;