import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

if (!config.databaseUrl) {
  throw new Error('Missing DATABASE_URL configuration');
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPool.max,
  idleTimeoutMillis: config.dbPool.idleTimeoutMillis,
  connectionTimeoutMillis: config.dbPool.connectionTimeoutMillis,
});

pool.on('error', (err) => {
  logger.error(`Unexpected error on idle pg client: ${err.message}`, 'DBPool', err);
});

/**
 * Execute query with automatic client checkout/release and single retry on transient network loss.
 */
export async function query(text, params = []) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    // If it's a transient connection reset, attempt one immediate retry
    if (err.code === 'ECONNRESET' || err.code === '57P01' || err.message.includes('Connection terminated')) {
      logger.warn(`Retrying query due to transient network interruption: ${err.message}`, 'DBPool');
      return await pool.query(text, params);
    }
    throw err;
  }
}

/**
 * Scoped transaction helper guaranteeing BEGIN, COMMIT, ROLLBACK, and client release.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      logger.error(`Rollback error: ${rbErr.message}`, 'DBTransaction', rbErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Wait for database to become available and schema seeded.
 */
export async function waitForDatabase(maxAttempts = 30, delayMs = 1500) {
  logger.info(`Checking database connectivity at ${config.databaseUrl.replace(/:[^:@]*@/, ':****@')}...`, 'DBInit');
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await pool.connect();
      // Ensure basic tables exist
      const { rows } = await client.query(`
        SELECT COUNT(*)::int as count 
        FROM information_schema.tables 
        WHERE table_name IN ('assets', 'tags', 'batches', 'readings', 'snapshots', 'simulation_control');
      `);
      client.release();

      if (rows[0].count >= 6) {
        logger.info('Database connection established and schema verified.', 'DBInit');
        return true;
      }

      logger.warn(`Database connected but schema is still initializing (found ${rows[0].count}/6 tables). Retrying ${attempt}/${maxAttempts}...`, 'DBInit');
    } catch (err) {
      logger.warn(`Waiting for database (attempt ${attempt}/${maxAttempts}): ${err.message}`, 'DBInit');
    }

    if (attempt < maxAttempts) {
      await new Promise(res => setTimeout(res, delayMs));
    }
  }

  throw new Error(`Database failed to become ready after ${maxAttempts} attempts.`);
}

/**
 * Health check function
 */
export async function isHealthy() {
  try {
    const { rows } = await pool.query('SELECT 1 as healthy');
    return rows.length > 0 && rows[0].healthy === 1;
  } catch (err) {
    return false;
  }
}

/**
 * Graceful teardown
 */
export async function closePool() {
  logger.info('Closing database pool...', 'DBPool');
  await pool.end();
}