import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
    throw new Error('Missing DATABASE_URL environment variable in root .env');
}

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 25,
    idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
    logger.error('DBPool', 'Unexpected error on idle pg client', { error: err.message });
});

export const query = (text, params) => pool.query(text, params);