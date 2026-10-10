import { performance } from 'perf_hooks';
import { query } from '../db.js';
import { logger } from '../utils/logger.js';

/**
 * Pure audit logging middleware.
 * Records all incoming requests to the `request_log` table upon completion.
 * Does NOT perform any authentication and never blocks any request.
 */
export function auditLog(req, res, next) {
    const start = performance.now();

    res.on('finish', () => {
        const durationMs = Math.round(performance.now() - start);
        const queryString = Object.keys(req.query).length ? JSON.stringify(req.query) : null;
        const apiKeyId = req.apiKeyId || null;

        query(`
            INSERT INTO request_log (api_key_id, method, path, query, status, duration_ms)
            VALUES ($1, $2, $3, $4, $5, $6);
        `, [apiKeyId, req.method, req.originalUrl.split('?')[0], queryString, res.statusCode, durationMs])
            .catch(err => {
                logger.error('AuditLog', 'Failed to write request_log', { error: err.message });
            });
    });

    next();
}
