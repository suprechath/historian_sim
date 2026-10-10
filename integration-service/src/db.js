import pg from 'pg';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
    throw new Error('Missing DATABASE_URL environment variable');
}

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20, // Dedicated pool for integration workloads
    idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle integration pg client:', err.message);
});

export const query = (text, params) => pool.query(text, params);

/**
 * Ensures default API keys exist in the database for authentication.
 */
export async function ensureDefaultApiKey() {
    try {
        const defaultKeys = [
            { label: 'External Integration', key: process.env.API_KEY_EXTERNAL },
            { label: 'Automated Test Key', key: process.env.API_KEY_TEST }
        ].filter(item => Boolean(item.key));

        for (const { label, key } of defaultKeys) {
            const keyHash = crypto.createHash('sha256').update(key).digest('hex');
            await query(`
              INSERT INTO api_keys (label, key_hash)
              VALUES ($1, $2)
              ON CONFLICT (key_hash) DO NOTHING;
            `, [label, keyHash]);
        }
    } catch (err) {
        console.error('Failed to verify default API keys in integration service:', err.message);
    }
}
