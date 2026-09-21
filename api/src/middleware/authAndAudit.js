import crypto from 'crypto';
import { query } from '../db.js';

export async function authAndAudit(req, res, next) {
    const start = performance.now();
    const apiKey = req.headers['x-api-key'];

    const isWebhookRoute = req.path === '/instruction' || req.path === '/status';

    if (!apiKey) {
        if (isWebhookRoute) {
            res.on('finish', () => {
                const durationMs = Math.round(performance.now() - start);
                const queryString = Object.keys(req.query).length ? JSON.stringify(req.query) : null;
                query(`
                    INSERT INTO request_log (api_key_id, method, path, query, status, duration_ms)
                    VALUES ($1, $2, $3, $4, $5, $6);
                `, [null, req.method, req.originalUrl.split('?')[0], queryString, res.statusCode, durationMs])
                    .catch(err => console.error('Failed to write request_log:', err.message));
            });
            return next();
        }
        return res.status(401).json({ error: 'Missing required X-API-Key header' });
    }

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    try {
        // 1. Verify key authenticity and revocation status
        const { rows } = await query(`
            SELECT id, label 
            FROM api_keys 
            WHERE key_hash = $1 AND revoked_at IS NULL;
            `, [keyHash]
        );

        if (rows.length === 0) {
            return res.status(403).json({ error: 'Invalid or revoked API key' });
        }

        const keyRecord = rows[0];
        req.apiKeyId = keyRecord.id;

        // Update last_used_at asynchronously
        query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [keyRecord.id]).catch(() => { });

        // 2. Log request on response finish
        res.on('finish', () => {
            const durationMs = Math.round(performance.now() - start);
            const queryString = Object.keys(req.query).length ? JSON.stringify(req.query) : null;

            query(`
        INSERT INTO request_log (api_key_id, method, path, query, status, duration_ms)
        VALUES ($1, $2, $3, $4, $5, $6);
      `, [req.apiKeyId, req.method, req.originalUrl.split('?')[0], queryString, res.statusCode, durationMs])
                .catch(err => console.error('Failed to write request_log:', err.message));
        });

        next();
    } catch (err) {
        res.status(500).json({ error: 'Authentication internal error: ' + err.message });
    }
}