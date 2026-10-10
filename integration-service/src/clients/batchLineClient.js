import { EXTERNAL_CONFIG } from '../config/externalConfig.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/formatters.js';

/**
 * Sends error notifications to BatchLine via POST /Notification/push
 */
export async function sendBatchLineNotification({ batchId, message, callbackKey }) {
    if (!message) return null;

    const notificationUrl = EXTERNAL_CONFIG.BATCHLINE_NOTIFICATION_URL;
    const apiKey = EXTERNAL_CONFIG.BATCHLINE_API_KEY;

    if (!apiKey) {
        logger.warn('BatchLineNotification', 'Missing BATCHLINE_API_KEY in environment variables');
        return null;
    }

    const payload = {
        batchid: batchId,
        message: String(message),
        callbackkey: callbackKey
    };

    try {
        const res = await fetch(notificationUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(EXTERNAL_CONFIG.HTTP_TIMEOUT_MS)
        });

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }

        if (!res.ok) {
            logger.warn('BatchLineNotification', `API returned status ${res.status}`, data);
        } else {
            logger.info('BatchLineNotification', 'Successfully pushed error notification to BatchLine');
        }

        return { ok: res.ok, status: res.status };
    } catch (err) {
        logger.warn('BatchLineNotification', 'Failed to push notification', err.message);
        return { ok: false, error: err.message };
    }
}

/**
 * Centralized error reporting function:
 * 1. Logs to structured logger
 * 2. Asynchronously pushes notification to BatchLine
 */
export async function reportError(message, ctx = {}, extraDetail = null) {
    logger.error('API Error', message, extraDetail);

    const detailStr = extraDetail
        ? (typeof extraDetail === 'object' ? JSON.stringify(extraDetail) : String(extraDetail))
        : '';
    const fullMessage = detailStr ? `${message}: ${detailStr}` : message;

    await sendBatchLineNotification({
        batchId: ctx?.batchId || null,
        message: fullMessage,
        callbackKey: ctx?.callbackKey || null
    }).catch(err => {
        logger.warn('BatchLineNotification', 'Dispatch failure', err.message);
    });
}

/**
 * Resilient outbound BatchLine instruction update client with chunking and exponential backoff.
 */
export async function sendBatchLineInstructionUpdate({ refInstruction, batchId, actualResult, callbackKey, maxRetries = 2 }) {
    if (!refInstruction || !batchId || !actualResult) return null;

    const baseUrl = EXTERNAL_CONFIG.BATCHLINE_BASE_URL;
    const callbackUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1/batch/instruction/update/${encodeURIComponent(refInstruction)}`;
    const apiKey = EXTERNAL_CONFIG.BATCHLINE_API_KEY;

    if (!apiKey) {
        await reportError('[BatchLine Callback Error]: Missing BATCHLINE_API_KEY in environment variables', { batchId, callbackKey });
        return { targetUrl: callbackUrl, error: 'Missing BATCHLINE_API_KEY' };
    }

    const normalizedActualResult = Array.isArray(actualResult)
        ? actualResult
        : [
            typeof actualResult === 'object' && actualResult !== null
                ? actualResult
                : { repeat_no: 1, value: String(actualResult), executed_user_email: null }
        ];

    const chunkSize = EXTERNAL_CONFIG.BATCHLINE_CHUNK_SIZE || 50;
    const chunks = [];
    for (let i = 0; i < normalizedActualResult.length; i += chunkSize) {
        chunks.push(normalizedActualResult.slice(i, i + chunkSize));
    }

    const totalChunks = chunks.length;
    logger.info('BatchLineCallback', `Dispatching ${normalizedActualResult.length} values in ${totalChunks} chunk(s) (max ${chunkSize}/request) for instruction ${refInstruction}...`);

    let lastResult = null;

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
        const chunk = chunks[chunkIdx];
        const payload = {
            batch_id: batchId,
            actual_result: chunk
        };

        let attempt = 0;
        let chunkDelivered = false;

        while (attempt <= maxRetries) {
            try {
                const cbRes = await fetch(callbackUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey
                    },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(EXTERNAL_CONFIG.HTTP_TIMEOUT_MS)
                });

                const cbText = await cbRes.text();
                let cbData;
                try { cbData = JSON.parse(cbText); } catch { cbData = cbText; }

                if (cbRes.ok) {
                    logger.info('BatchLineCallback', `Chunk ${chunkIdx + 1}/${totalChunks} (${chunk.length} items) delivered successfully`);
                    lastResult = {
                        targetUrl: callbackUrl,
                        status: cbRes.status,
                        ok: true,
                        data: cbData
                    };
                    chunkDelivered = true;
                    break;
                }

                if (cbRes.status >= 500 && attempt < maxRetries) {
                    attempt++;
                    logger.warn('BatchLineCallback', `Chunk ${chunkIdx + 1}/${totalChunks} server error ${cbRes.status}. Retrying attempt ${attempt}/${maxRetries}...`);
                    await sleep(500 * Math.pow(2, attempt));
                    continue;
                }

                logger.warn('BatchLineCallback', `Chunk ${chunkIdx + 1}/${totalChunks} rejected with status ${cbRes.status}:`, cbData);
                await reportError(`[BatchLine Callback Error]: Chunk ${chunkIdx + 1}/${totalChunks} failed (HTTP ${cbRes.status})`, { batchId, callbackKey }, cbData);
                return {
                    targetUrl: callbackUrl,
                    status: cbRes.status,
                    ok: false,
                    chunksCompleted: chunkIdx,
                    totalChunks,
                    data: cbData
                };
            } catch (cbErr) {
                if (attempt < maxRetries) {
                    attempt++;
                    logger.warn('BatchLineCallback', `Chunk ${chunkIdx + 1}/${totalChunks} network error (${cbErr.message}). Retrying attempt ${attempt}/${maxRetries}...`);
                    await sleep(500 * Math.pow(2, attempt));
                    continue;
                }
                await reportError(`[BatchLine Callback Error]: Chunk ${chunkIdx + 1}/${totalChunks} network error: ${cbErr.message}`, { batchId, callbackKey });
                return {
                    targetUrl: callbackUrl,
                    status: 500,
                    ok: false,
                    chunksCompleted: chunkIdx,
                    totalChunks,
                    error: cbErr.message
                };
            }
        }

        if (!chunkDelivered) {
            return {
                targetUrl: callbackUrl,
                status: 500,
                ok: false,
                chunksCompleted: chunkIdx,
                totalChunks,
                error: `Failed to deliver chunk ${chunkIdx + 1}/${totalChunks}`
            };
        }

        // Brief delay between chunk dispatches to prevent rate-limiting
        if (chunkIdx < totalChunks - 1 && EXTERNAL_CONFIG.PUSH_DELAY_MS > 0) {
            await sleep(EXTERNAL_CONFIG.PUSH_DELAY_MS);
        }
    }

    logger.info('BatchLineCallback', `All ${totalChunks} chunk(s) (${normalizedActualResult.length} total items) successfully updated for instruction ${refInstruction}`);
    return {
        targetUrl: callbackUrl,
        status: lastResult?.status || 200,
        ok: true,
        data: lastResult?.data,
        totalItems: normalizedActualResult.length,
        totalChunks
    };
}
