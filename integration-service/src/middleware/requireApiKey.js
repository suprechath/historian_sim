import crypto from 'crypto';
import { query } from '../db.js';

/**
 * Strict API Key verification middleware.
 * Use ONLY on private/internal REST endpoints that require authentication.
 * Webhook endpoints from BatchLine should NOT use this middleware.
 */
export async function requireApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return res.status(401).json({ error: 'Missing required X-API-Key header' });
    }

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    try {
        const { rows } = await query(`
            SELECT id, label 
            FROM api_keys 
            WHERE key_hash = $1 AND revoked_at IS NULL;
        `, [keyHash]);

        if (rows.length === 0) {
            return res.status(403).json({ error: 'Invalid or revoked API key' });
        }

        const keyRecord = rows[0];
        req.apiKeyId = keyRecord.id;

        // Asynchronously update last_used_at timestamp
        query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [keyRecord.id]).catch(() => { });

        next();
    } catch (err) {
        res.status(500).json({ error: 'Authentication internal error: ' + err.message });
    }
}
