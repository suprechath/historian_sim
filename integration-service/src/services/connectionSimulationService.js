import { query } from '../db.js';
import { logger } from '../utils/logger.js';
import { EXTERNAL_CONFIG } from '../config/externalConfig.js';
import {
    getPendingOutboundLogs,
    countPendingOutboundLogs,
    updateBatchLineOutboundStatus,
    getRecentActiveBatchesFromOutbound
} from '../dal/batchLineOutboundDal.js';
import { sendBatchLineNotification } from '../clients/batchLineClient.js';

let isConnected = true;
let isFlushing = false;

/**
 * Returns current simulated connection state.
 */
export function isIntegrationConnected() {
    return isConnected;
}

/**
 * Initializes connection state from database.
 */
export async function initSimulationConnection() {
    try {
        const { rows } = await query(`
            SELECT integration_connected 
            FROM simulation_control 
            WHERE id = 1;
        `);
        if (rows.length > 0 && rows[0].integration_connected !== undefined) {
            isConnected = Boolean(rows[0].integration_connected);
        }
        logger.info('ConnectionSimulation', `Initialized simulated connection state: ${isConnected ? 'ONLINE' : 'OFFLINE'}`);
    } catch (err) {
        logger.warn('ConnectionSimulation', `Could not read integration_connected state from DB: ${err.message}`);
    }
}

/**
 * Flushes all pending outbound log records to BatchLine (Store-and-Forward).
 *
 * @returns {Promise<{ total: number, delivered: number, failed: number, results: Array }>}
 */
export async function flushPendingOutboxLogs() {
    if (isFlushing) {
        logger.info('StoreAndForward', 'Flush already in progress, skipping duplicate invocation.');
        return { total: 0, delivered: 0, failed: 0, results: [] };
    }

    isFlushing = true;
    const results = [];
    let deliveredCount = 0;
    let failedCount = 0;

    try {
        const pendingLogs = await getPendingOutboundLogs(100);
        logger.info('StoreAndForward', `Flushing ${pendingLogs.length} pending outbound message(s) to BatchLine...`);

        const apiKey = EXTERNAL_CONFIG.BATCHLINE_API_KEY;

        for (const record of pendingLogs) {
            const startMs = Date.now();
            const attempts = (record.attempts || 0) + 1;
            let targetUrl = record.target_url;
            let payload = record.payload;

            // Ensure valid target URL
            if (record.action === 'notification' && !targetUrl) {
                targetUrl = EXTERNAL_CONFIG.BATCHLINE_NOTIFICATION_URL;
            }

            if (!apiKey) {
                await updateBatchLineOutboundStatus(record.id, {
                    status: 'failed',
                    httpStatus: 401,
                    attempts,
                    errorMessage: 'Missing BATCHLINE_API_KEY in environment',
                    durationMs: Date.now() - startMs
                });
                failedCount++;
                results.push({ id: record.id, action: record.action, status: 'failed', error: 'Missing API key' });
                continue;
            }

            try {
                const res = await fetch(targetUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey
                    },
                    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
                    signal: AbortSignal.timeout(EXTERNAL_CONFIG.HTTP_TIMEOUT_MS)
                });

                const durationMs = Date.now() - startMs;
                const text = await res.text();
                let data;
                try { data = JSON.parse(text); } catch { data = text; }

                if (res.ok) {
                    await updateBatchLineOutboundStatus(record.id, {
                        status: 'delivered',
                        httpStatus: res.status,
                        attempts,
                        responseBody: data,
                        errorMessage: null,
                        durationMs,
                        deliveredAt: new Date()
                    });
                    deliveredCount++;
                    results.push({ id: record.id, action: record.action, status: 'delivered', httpStatus: res.status });
                } else {
                    await updateBatchLineOutboundStatus(record.id, {
                        status: 'failed',
                        httpStatus: res.status,
                        attempts,
                        responseBody: data,
                        errorMessage: `HTTP ${res.status}`,
                        durationMs
                    });
                    failedCount++;
                    results.push({ id: record.id, action: record.action, status: 'failed', httpStatus: res.status });
                }
            } catch (netErr) {
                const durationMs = Date.now() - startMs;
                await updateBatchLineOutboundStatus(record.id, {
                    status: 'failed',
                    httpStatus: 500,
                    attempts,
                    errorMessage: netErr.message,
                    durationMs
                });
                failedCount++;
                results.push({ id: record.id, action: record.action, status: 'failed', error: netErr.message });
            }
        }

        logger.info('StoreAndForward', `Flush complete: ${deliveredCount} delivered, ${failedCount} failed out of ${pendingLogs.length} total.`);
    } catch (err) {
        logger.error('StoreAndForward', 'Unexpected error during pending queue flush:', err.message);
    } finally {
        isFlushing = false;
    }

    return {
        total: results.length,
        delivered: deliveredCount,
        failed: failedCount,
        results
    };
}

/**
 * Toggles the simulated connection state of the integration service.
 *
 * When targetConnected = false:
 * 1. Executes "Disconnection Warning Broadcast" by scanning batchline_outbound_log for
 *    distinct (batch_id, callback_key) active within the last 5 minutes.
 * 2. Sends a push notification for each active batch to BatchLine.
 * 3. Switches state to OFFLINE and updates database.
 *
 * When targetConnected = true:
 * 1. Switches state to ONLINE and updates database.
 * 2. Executes "Store-and-Forward" by flushing all pending outbound messages in chronological order.
 * 3. Sends a recovery notification to BatchLine.
 *
 * @param {boolean} targetConnected
 * @returns {Promise<Object>} Status and operation report
 */
export async function setSimulationConnection(targetConnected) {
    const shouldBeOnline = Boolean(targetConnected);

    if (shouldBeOnline === isConnected) {
        const pendingCount = await countPendingOutboundLogs();
        return {
            connected: isConnected,
            message: `Integration server is already ${isConnected ? 'ONLINE' : 'OFFLINE'}`,
            pendingCount
        };
    }

    if (!shouldBeOnline) {
        // --- 1. TRANSITION TO OFFLINE: Disconnection Warning Broadcast ---
        logger.warn('ConnectionSimulation', 'Initiating simulated disconnection. Preparing Disconnection Warning Broadcast...');

        // Scan batchline_outbound_log for batches active in the last 5 minutes
        const activeOutboundBatches = await getRecentActiveBatchesFromOutbound(5);

        // Also check batch_queue and simulation_control for any currently active batch
        const batchMap = new Map();
        for (const item of activeOutboundBatches) {
            if (item.batch_id) {
                const key = `${item.batch_id}::${item.callback_key || ''}`;
                batchMap.set(key, { batchId: item.batch_id, callbackKey: item.callback_key || null });
            }
        }

        try {
            const { rows: queueRows } = await query(`
                SELECT batch_id FROM batch_queue 
                WHERE status IN ('in_queue', 'processing', 'waiting_r1')
                ORDER BY created_at DESC LIMIT 5;
            `);
            for (const q of queueRows) {
                if (q.batch_id && !Array.from(batchMap.values()).some(b => b.batchId === q.batch_id)) {
                    batchMap.set(`${q.batch_id}::`, { batchId: q.batch_id, callbackKey: null });
                }
            }

            const { rows: simRows } = await query(`
                SELECT assigned_batch_id FROM simulation_control WHERE id = 1;
            `);
            if (simRows[0]?.assigned_batch_id) {
                const bId = simRows[0].assigned_batch_id;
                if (!Array.from(batchMap.values()).some(b => b.batchId === bId)) {
                    batchMap.set(`${bId}::`, { batchId: bId, callbackKey: null });
                }
            }
        } catch (dbErr) {
            logger.warn('ConnectionSimulation', `Could not scan extra batch tables: ${dbErr.message}`);
        }

        // If no active batches found, broadcast with SYSTEM identifier
        if (batchMap.size === 0) {
            batchMap.set('SYSTEM::', { batchId: 'SYSTEM', callbackKey: null });
        }

        const targets = Array.from(batchMap.values());
        logger.info('ConnectionSimulation', `Sending Disconnection Warning Broadcast to ${targets.length} target(s)...`);

        const broadcastResults = [];
        for (const target of targets) {
            const warnMsg = `[SYSTEM WARNING] Historian Integration Server disconnected (Simulated Outage). Telemetry and instruction updates are paused.`;
            try {
                // bypassOfflineCheck: true ensures the warning leaves the building before the link goes dark
                const result = await sendBatchLineNotification({
                    batchId: target.batchId,
                    message: warnMsg,
                    callbackKey: target.callbackKey,
                    bypassOfflineCheck: true
                });
                broadcastResults.push({
                    batchId: target.batchId,
                    callbackKey: target.callbackKey,
                    delivered: Boolean(result?.ok)
                });
            } catch (warnErr) {
                logger.warn('ConnectionSimulation', `Failed to send disconnect warning for batch ${target.batchId}: ${warnErr.message}`);
                broadcastResults.push({
                    batchId: target.batchId,
                    callbackKey: target.callbackKey,
                    delivered: false,
                    error: warnErr.message
                });
            }
        }

        // Now set offline in-memory and in DB
        isConnected = false;
        try {
            await query(`
                UPDATE simulation_control 
                SET integration_connected = false, updated_at = NOW() 
                WHERE id = 1;
            `);
        } catch (err) {
            logger.warn('ConnectionSimulation', `Failed to update simulation_control: ${err.message}`);
        }

        const pendingCount = await countPendingOutboundLogs();
        logger.warn('ConnectionSimulation', `Integration Server is now OFFLINE (simulated). Incoming webhooks blocked, outbound buffered.`);

        return {
            connected: false,
            message: `Integration server disconnected. Broadcasted warning to ${broadcastResults.length} target(s).`,
            broadcastCount: broadcastResults.length,
            broadcasts: broadcastResults,
            pendingCount
        };
    } else {
        // --- 2. TRANSITION TO ONLINE: Store-and-Forward Reconnection ---
        logger.info('ConnectionSimulation', 'Reconnecting Integration Server. Preparing Store-and-Forward queue flush...');

        isConnected = true;
        try {
            await query(`
                UPDATE simulation_control 
                SET integration_connected = true, updated_at = NOW() 
                WHERE id = 1;
            `);
        } catch (err) {
            logger.warn('ConnectionSimulation', `Failed to update simulation_control: ${err.message}`);
        }

        // Flush Store-and-Forward queue
        const flushSummary = await flushPendingOutboxLogs();

        // Send a reconnection recovery notification
        try {
            await sendBatchLineNotification({
                batchId: 'SYSTEM',
                message: `[SYSTEM RESTORED] Historian Integration Server reconnected. Outbound queue flushed (${flushSummary.delivered}/${flushSummary.total} delivered).`,
                bypassOfflineCheck: true
            });
        } catch (reconnErr) {
            logger.warn('ConnectionSimulation', `Failed to send reconnection broadcast: ${reconnErr.message}`);
        }

        const remainingPending = await countPendingOutboundLogs();

        return {
            connected: true,
            message: `Integration server reconnected. Flushed ${flushSummary.delivered} pending message(s).`,
            flushedCount: flushSummary.delivered,
            failedCount: flushSummary.failed,
            totalPendingProcessed: flushSummary.total,
            remainingPending
        };
    }
}

