import { EXTERNAL_CONFIG } from '../config/externalConfig.js';
import { logger } from '../utils/logger.js';

/**
 * Sends a high-exception alert payload to Make.com webhook.
 */
export async function sendHighExceptionToMake(payload) {
    const webhookUrl = process.env.MAKE_HIGH_EXCEPTION_WEBHOOK_URL || EXTERNAL_CONFIG.MAKE_HIGH_EXCEPTION_WEBHOOK_URL;
    const apiKey = EXTERNAL_CONFIG.MAKE_API_KEY;

    if (!webhookUrl) {
        logger.warn('MakeHighException', 'No webhook URL configured, skipping dispatch');
        return { ok: false, error: 'No webhook URL configured' };
    }

    try {
        logger.info('MakeHighException', `Dispatching exception alert for Batch ${payload.BatchId}, Instruction ${payload.InstructionId} to Make.com...`);
        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-make-apikey': apiKey
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(EXTERNAL_CONFIG.HTTP_TIMEOUT_MS)
        });

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }

        if (!res.ok) {
            logger.warn('MakeHighException', `Webhook returned status ${res.status}:`, data);
        } else {
            logger.info('MakeHighException', 'Successfully dispatched alert to Make.com:', data);
        }

        return { ok: res.ok, status: res.status, data };
    } catch (err) {
        logger.error('MakeHighException', 'Failed to dispatch alert:', err.message);
        return { ok: false, error: err.message };
    }
}
