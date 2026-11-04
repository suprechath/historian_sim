import { EXTERNAL_CONFIG } from '../config/externalConfig.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/formatters.js';
import { recordBatchLineOutbound } from '../dal/batchLineOutboundDal.js';
import { isIntegrationConnected } from '../services/connectionSimulationService.js';

/**
 * Sends error notifications to BatchLine via POST /Notification/push
 */
export async function sendBatchLineNotification({ batchId, message, callbackKey, bypassOfflineCheck = false }) {
    if (!message) return null;

    const notificationUrl = EXTERNAL_CONFIG.BATCHLINE_NOTIFICATION_URL;
    const apiKey = EXTERNAL_CONFIG.BATCHLINE_API_KEY;

    const payload = {
        batchid: batchId,
        message: String(message),
        callbackkey: callbackKey
    };

    if (!bypassOfflineCheck && !isIntegrationConnected()) {
        logger.info('StoreAndForward', `Buffering notification for batch ${batchId} while offline`);
        await recordBatchLineOutbound({
            batchId: batchId || 'UNKNOWN',
            callbackKey: callbackKey || null,
            refInstruction: null,
            action: 'notification',
            targetUrl: notificationUrl,
            chunkIndex: 1,
            totalChunks: 1,
            payload,
            status: 'pending',
            httpStatus: null,
            attempts: 0,
            errorMessage: 'Buffered in Store-and-Forward queue (Integration Server offline)',
            durationMs: 0
        });
        return { ok: false, offline: true, buffered: true };
    }

    if (!apiKey) {
        logger.warn('BatchLineNotification', 'Missing BATCHLINE_API_KEY in environment variables');
        await recordBatchLineOutbound({
            batchId: batchId || 'UNKNOWN',
            callbackKey: callbackKey || null,
            refInstruction: null,
            action: 'notification',
            targetUrl: notificationUrl,
            chunkIndex: 1,
            totalChunks: 1,
            payload,
            status: 'failed',
            httpStatus: 401,
            attempts: 0,
            errorMessage: 'Missing BATCHLINE_API_KEY in environment variables',
            durationMs: 0
        });
        return null;
    }

    const notifStartTime = Date.now();
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
        const durationMs = Date.now() - notifStartTime;

        if (!res.ok) {
            logger.warn('BatchLineNotification', `API returned status ${res.status}`, data);
            await recordBatchLineOutbound({
                batchId: batchId || 'UNKNOWN',
                callbackKey: callbackKey || null,
                refInstruction: null,
                action: 'notification',
                targetUrl: notificationUrl,
                chunkIndex: 1,
                totalChunks: 1,
                payload,
                status: 'failed',
                httpStatus: res.status,
                attempts: 1,
                responseBody: data,
                errorMessage: `HTTP ${res.status}`,
                durationMs
            });
        } else {
            logger.info('BatchLineNotification', 'Successfully pushed error notification to BatchLine');
            await recordBatchLineOutbound({
                batchId: batchId || 'UNKNOWN',
                callbackKey: callbackKey || null,
                refInstruction: null,
                action: 'notification',
                targetUrl: notificationUrl,
                chunkIndex: 1,
                totalChunks: 1,
                payload,
                status: 'delivered',
                httpStatus: res.status,
                attempts: 1,
                responseBody: data,
                durationMs,
                deliveredAt: new Date()
            });
        }

        return { ok: res.ok, status: res.status };
    } catch (err) {
        const durationMs = Date.now() - notifStartTime;
        logger.warn('BatchLineNotification', 'Failed to push notification', err.message);
        await recordBatchLineOutbound({
            batchId: batchId || 'UNKNOWN',
            callbackKey: callbackKey || null,
            refInstruction: null,
            action: 'notification',
            targetUrl: notificationUrl,
            chunkIndex: 1,
            totalChunks: 1,
            payload,
            status: 'failed',
            httpStatus: 500,
            attempts: 1,
            errorMessage: err.message,
            durationMs
        });
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
 * Resilient outbound BatchLine instruction update client with chunking, retry backoff,
 * and automatic persistent audit logging in batchline_outbound_log.
 */
export async function sendBatchLineInstructionUpdate({ refInstruction, batchId, actualResult, callbackKey, maxRetries = 2, bypassOfflineCheck = false }) {
    if (!refInstruction || !batchId || !actualResult) return null;

    const baseUrl = EXTERNAL_CONFIG.BATCHLINE_BASE_URL;
    const callbackUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1/batch/instruction/update/${encodeURIComponent(refInstruction)}`;
    const apiKey = EXTERNAL_CONFIG.BATCHLINE_API_KEY;

    if (!bypassOfflineCheck && !isIntegrationConnected()) {
        logger.info('StoreAndForward', `Buffering instruction update for batch ${batchId} ref ${refInstruction} while offline`);
        await recordBatchLineOutbound({
            batchId,
            callbackKey,
            refInstruction,
            action: 'instruction_update',
            targetUrl: callbackUrl,
            chunkIndex: 1,
            totalChunks: 1,
            payload: { batch_id: batchId, actual_result: actualResult },
            status: 'pending',
            httpStatus: null,
            attempts: 0,
            errorMessage: 'Buffered in Store-and-Forward queue (Integration Server offline)',
            durationMs: 0
        });
        return { targetUrl: callbackUrl, ok: false, offline: true, buffered: true };
    }

    if (!apiKey) {
        await recordBatchLineOutbound({
            batchId,
            callbackKey,
            refInstruction,
            action: 'instruction_update',
            targetUrl: callbackUrl,
            chunkIndex: 1,
            totalChunks: 1,
            payload: { actualResult },
            status: 'failed',
            httpStatus: 401,
            attempts: 0,
            errorMessage: 'Missing BATCHLINE_API_KEY in environment variables',
            durationMs: 0
        });
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
        const chunkStartTime = Date.now();

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
                const durationMs = Date.now() - chunkStartTime;

                if (cbRes.ok) {
                    logger.info('BatchLineCallback', `Chunk ${chunkIdx + 1}/${totalChunks} (${chunk.length} items) delivered successfully`);
                    await recordBatchLineOutbound({
                        batchId,
                        callbackKey,
                        refInstruction,
                        action: 'instruction_update',
                        targetUrl: callbackUrl,
                        chunkIndex: chunkIdx + 1,
                        totalChunks,
                        payload,
                        status: 'delivered',
                        httpStatus: cbRes.status,
                        attempts: attempt + 1,
                        responseBody: cbData,
                        errorMessage: null,
                        durationMs,
                        deliveredAt: new Date()
                    });
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
                await recordBatchLineOutbound({
                    batchId,
                    callbackKey,
                    refInstruction,
                    action: 'instruction_update',
                    targetUrl: callbackUrl,
                    chunkIndex: chunkIdx + 1,
                    totalChunks,
                    payload,
                    status: 'failed',
                    httpStatus: cbRes.status,
                    attempts: attempt + 1,
                    responseBody: cbData,
                    errorMessage: `HTTP ${cbRes.status}`,
                    durationMs
                });
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
                const durationMs = Date.now() - chunkStartTime;
                await recordBatchLineOutbound({
                    batchId,
                    callbackKey,
                    refInstruction,
                    action: 'instruction_update',
                    targetUrl: callbackUrl,
                    chunkIndex: chunkIdx + 1,
                    totalChunks,
                    payload,
                    status: 'failed',
                    httpStatus: 500,
                    attempts: attempt + 1,
                    errorMessage: cbErr.message,
                    durationMs
                });
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
            const durationMs = Date.now() - chunkStartTime;
            await recordBatchLineOutbound({
                batchId,
                callbackKey,
                refInstruction,
                action: 'instruction_update',
                targetUrl: callbackUrl,
                chunkIndex: chunkIdx + 1,
                totalChunks,
                payload,
                status: 'failed',
                httpStatus: 500,
                attempts: maxRetries + 1,
                errorMessage: `Failed to deliver chunk ${chunkIdx + 1}/${totalChunks}`,
                durationMs
            });
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
