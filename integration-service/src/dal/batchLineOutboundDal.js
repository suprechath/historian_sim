import { query } from '../db.js';
import { logger } from '../utils/logger.js';

let ensureTablePromise = null;

/**
 * Ensures the batchline_outbound_log table and its indexes exist.
 * Memoized via Promise so it runs safely once on startup.
 */
export async function ensureBatchLineOutboundLogTable() {
    if (!ensureTablePromise) {
        ensureTablePromise = (async () => {
            try {
                await query(`
                    CREATE TABLE IF NOT EXISTS batchline_outbound_log (
                        id              BIGSERIAL PRIMARY KEY,
                        batch_id        TEXT NOT NULL,
                        callback_key    TEXT,
                        ref_instruction TEXT,
                        action          TEXT NOT NULL DEFAULT 'instruction_update'
                                        CHECK (action IN ('instruction_update', 'notification')),
                        target_url      TEXT NOT NULL,
                        chunk_index     INTEGER NOT NULL DEFAULT 1,
                        total_chunks    INTEGER NOT NULL DEFAULT 1,
                        payload         JSONB NOT NULL,
                        status          TEXT NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending', 'delivered', 'failed')),
                        http_status     INTEGER,
                        attempts        INTEGER NOT NULL DEFAULT 1,
                        response_body   JSONB,
                        error_message   TEXT,
                        duration_ms     INTEGER,
                        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        delivered_at    TIMESTAMPTZ
                    );

                    CREATE INDEX IF NOT EXISTS idx_batchline_outbound_batch_id 
                    ON batchline_outbound_log (batch_id);

                    CREATE INDEX IF NOT EXISTS idx_batchline_outbound_callback_key 
                    ON batchline_outbound_log (callback_key) 
                    WHERE callback_key IS NOT NULL;

                    CREATE INDEX IF NOT EXISTS idx_batchline_outbound_created_at 
                    ON batchline_outbound_log (created_at DESC);

                    CREATE INDEX IF NOT EXISTS idx_batchline_outbound_status 
                    ON batchline_outbound_log (status);
                `);
                logger.info('DAL', 'BatchLine outbound log table verified.');
            } catch (err) {
                logger.warn('DAL', 'Could not ensure batchline_outbound_log table:', err.message);
            }
        })();
    }
    return ensureTablePromise;
}

/**
 * Resiliently records an outbound transmission to BatchLine.
 * Designed to never throw, ensuring logging errors never break production business workflows.
 *
 * @param {Object} entry
 * @returns {Promise<Object|null>}
 */
export async function recordBatchLineOutbound({
    batchId,
    callbackKey = null,
    refInstruction = null,
    action = 'instruction_update',
    targetUrl,
    chunkIndex = 1,
    totalChunks = 1,
    payload,
    status = 'pending',
    httpStatus = null,
    attempts = 1,
    responseBody = null,
    errorMessage = null,
    durationMs = null,
    deliveredAt = null
}) {
    if (!batchId || !targetUrl) {
        logger.warn('BatchLineOutboundLog', 'Skipping outbound log write: missing required batchId or targetUrl');
        return null;
    }

    try {
        await ensureBatchLineOutboundLogTable();

        const safePayload = typeof payload === 'object' && payload !== null
            ? JSON.stringify(payload)
            : JSON.stringify({ raw: payload });

        let safeResponse = null;
        if (responseBody !== null && responseBody !== undefined) {
            safeResponse = typeof responseBody === 'object'
                ? JSON.stringify(responseBody)
                : JSON.stringify({ raw: String(responseBody) });
        }

        const { rows } = await query(`
            INSERT INTO batchline_outbound_log (
                batch_id, callback_key, ref_instruction, action,
                target_url, chunk_index, total_chunks, payload,
                status, http_status, attempts, response_body,
                error_message, duration_ms, delivered_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING id, created_at;
        `, [
            batchId,
            callbackKey || null,
            refInstruction || null,
            action,
            targetUrl,
            chunkIndex,
            totalChunks,
            safePayload,
            status,
            httpStatus,
            attempts,
            safeResponse,
            errorMessage ? String(errorMessage) : null,
            durationMs !== null ? Math.round(durationMs) : null,
            deliveredAt || null
        ]);

        return rows[0] || null;
    } catch (err) {
        logger.warn('BatchLineOutboundLog', `Failed to record outbound log entry: ${err.message}`);
        return null;
    }
}

/**
 * Queries outbound logs by batch_id, callback_key, or status.
 *
 * @param {Object} options
 * @returns {Promise<Array>}
 */
export async function getBatchLineOutboundLogs({
    batchId = null,
    callbackKey = null,
    refInstruction = null,
    status = null,
    action = null,
    limit = 50,
    offset = 0
} = {}) {
    try {
        await ensureBatchLineOutboundLogTable();

        const conditions = [];
        const values = [];

        if (batchId) {
            values.push(batchId.trim());
            conditions.push(`batch_id = $${values.length}`);
        }
        if (callbackKey) {
            values.push(callbackKey.trim());
            conditions.push(`callback_key = $${values.length}`);
        }
        if (refInstruction) {
            values.push(refInstruction.trim());
            conditions.push(`ref_instruction = $${values.length}`);
        }
        if (status) {
            values.push(status.trim().toLowerCase());
            conditions.push(`status = $${values.length}`);
        }
        if (action) {
            values.push(action.trim().toLowerCase());
            conditions.push(`action = $${values.length}`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limitParam = values.length + 1;
        const offsetParam = values.length + 2;
        values.push(Math.min(Math.max(1, limit), 200));
        values.push(Math.max(0, offset));

        const sql = `
            SELECT id, batch_id, callback_key, ref_instruction, action,
                   target_url, chunk_index, total_chunks, payload,
                   status, http_status, attempts, response_body,
                   error_message, duration_ms, created_at, delivered_at
            FROM batchline_outbound_log
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT $${limitParam} OFFSET $${offsetParam};
        `;

        const { rows } = await query(sql, values);
        return rows;
    } catch (err) {
        logger.warn('BatchLineOutboundLog', `Failed to query outbound logs: ${err.message}`);
        return [];
    }
}


/**
 * Retrieves all pending outbound records for Store-and-Forward processing.
 */
export async function getPendingOutboundLogs(limit = 100) {
    try {
        await ensureBatchLineOutboundLogTable();
        const { rows } = await query(`
            SELECT id, batch_id, callback_key, ref_instruction, action,
                   target_url, chunk_index, total_chunks, payload,
                   status, http_status, attempts, response_body,
                   error_message, duration_ms, created_at, delivered_at
            FROM batchline_outbound_log
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT $1;
        `, [Math.max(1, limit)]);
        return rows;
    } catch (err) {
        logger.warn('BatchLineOutboundLog', `Failed to get pending outbound logs: ${err.message}`);
        return [];
    }
}

/**
 * Counts all pending outbound records.
 */
export async function countPendingOutboundLogs() {
    try {
        await ensureBatchLineOutboundLogTable();
        const { rows } = await query(`
            SELECT COUNT(*)::int AS count
            FROM batchline_outbound_log
            WHERE status = 'pending';
        `);
        return rows[0]?.count || 0;
    } catch (err) {
        return 0;
    }
}

/**
 * Updates status and delivery metadata of an outbound log record.
 */
export async function updateBatchLineOutboundStatus(id, {
    status,
    httpStatus = null,
    attempts = null,
    responseBody = null,
    errorMessage = null,
    durationMs = null,
    deliveredAt = null
} = {}) {
    if (!id) return null;
    try {
        await ensureBatchLineOutboundLogTable();
        let safeResponse = null;
        if (responseBody !== null && responseBody !== undefined) {
            safeResponse = typeof responseBody === 'object'
                ? JSON.stringify(responseBody)
                : JSON.stringify({ raw: String(responseBody) });
        }

        const { rows } = await query(`
            UPDATE batchline_outbound_log
            SET status = COALESCE($1, status),
                http_status = COALESCE($2, http_status),
                attempts = COALESCE($3, attempts),
                response_body = COALESCE($4, response_body),
                error_message = $5,
                duration_ms = COALESCE($6, duration_ms),
                delivered_at = COALESCE($7, delivered_at)
            WHERE id = $8
            RETURNING id, status, attempts, delivered_at;
        `, [
            status || null,
            httpStatus,
            attempts,
            safeResponse,
            errorMessage ? String(errorMessage) : null,
            durationMs !== null ? Math.round(durationMs) : null,
            deliveredAt || null,
            id
        ]);
        return rows[0] || null;
    } catch (err) {
        logger.warn('BatchLineOutboundLog', `Failed to update outbound log ${id}: ${err.message}`);
        return null;
    }
}

/**
 * Retrieves distinct (batch_id, callback_key) active within the last N minutes.
 */
export async function getRecentActiveBatchesFromOutbound(minutes = 10) {
    try {
        await ensureBatchLineOutboundLogTable();
        const { rows } = await query(`
            SELECT DISTINCT batch_id, callback_key
            FROM batchline_outbound_log
            WHERE created_at >= NOW() - ($1 || ' minutes')::INTERVAL
              AND batch_id IS NOT NULL;
        `, [minutes]);
        return rows;
    } catch (err) {
        logger.warn('BatchLineOutboundLog', `Failed to get recent active batches: ${err.message}`);
        return [];
    }
}
