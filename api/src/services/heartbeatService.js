import { performance } from 'perf_hooks';
import { query } from '../db.js';
import { logger } from '../utils/logger.js';

let ensureTablesPromise = null;
let heartbeatTimer = null;
let isHeartbeatRunning = false;

const INTEGRATION_SERVICE_URL = process.env.INTEGRATION_SERVICE_URL || 'http://integration-service:4001';
const HEARTBEAT_INTERVAL_MIN = parseInt(process.env.HEARTBEAT_INTERVAL_MIN || '10', 10);
const HEARTBEAT_ENABLED = process.env.HEARTBEAT_ENABLED !== 'false';

/**
 * Ensures the persistent integration_health_checks table exists in PostgreSQL.
 */
export async function ensureHealthCheckTables() {
    if (!ensureTablesPromise) {
        ensureTablesPromise = (async () => {
            try {
                await query(`
                    CREATE TABLE IF NOT EXISTS integration_health_checks (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        check_type TEXT NOT NULL CHECK (check_type IN ('on_demand', 'heartbeat')),
                        batch_id TEXT,
                        instruction_id TEXT,
                        status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'degraded')),
                        message TEXT,
                        latency_ms INTEGER,
                        details JSONB,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE INDEX IF NOT EXISTS idx_health_checks_created_at 
                    ON integration_health_checks (created_at DESC);
                    CREATE INDEX IF NOT EXISTS idx_health_checks_type_created 
                    ON integration_health_checks (check_type, created_at DESC);
                `);
                logger.info('HeartbeatService', 'Integration health check tables verified.');
            } catch (err) {
                logger.warn('HeartbeatService', 'Could not ensure health check tables:', err.message);
            }
        })();
    }
    return ensureTablesPromise;
}

/**
 * Executes a single 100% internal heartbeat tick.
 * Verifies TimescaleDB and integration-service without calling any external system.
 */
export async function executeInternalHeartbeat() {
    if (isHeartbeatRunning) return;
    isHeartbeatRunning = true;
    const startTime = performance.now();

    let dbOk = false;
    let dbLatencyMs = 0;
    let dbError = null;

    let integrationOk = false;
    let integrationLatencyMs = 0;
    let integrationError = null;
    let integrationData = null;

    try {
        await ensureHealthCheckTables();

        // 1. Check TimescaleDB connectivity & query latency
        const dbStart = performance.now();
        try {
            await query('SELECT 1;');
            dbOk = true;
            dbLatencyMs = Math.round(performance.now() - dbStart);
        } catch (err) {
            dbError = err.message;
            dbLatencyMs = Math.round(performance.now() - dbStart);
        }

        // 2. Check local integration-service container health probe
        const intStart = performance.now();
        try {
            const healthUrl = `${INTEGRATION_SERVICE_URL.replace(/\/+$/, '')}/health`;
            const res = await fetch(healthUrl, {
                signal: AbortSignal.timeout(3000)
            });
            integrationLatencyMs = Math.round(performance.now() - intStart);
            if (res.ok) {
                integrationOk = true;
                try { integrationData = await res.json(); } catch { integrationData = null; }
            } else {
                integrationError = `HTTP ${res.status}`;
            }
        } catch (err) {
            integrationLatencyMs = Math.round(performance.now() - intStart);
            integrationError = err.message;
        }

        const totalLatencyMs = Math.round(performance.now() - startTime);
        const isHealthy = dbOk && integrationOk;
        const status = isHealthy ? 'passed' : 'failed';

        const message = isHealthy
            ? `[System Heartbeat]: All systems operational (DB: ${dbLatencyMs}ms, Integration: ${integrationLatencyMs}ms)`
            : `[System Heartbeat]: DEGRADED (DB: ${dbOk ? 'OK' : dbError}, Integration: ${integrationOk ? 'OK' : integrationError})`;

        const details = {
            db: { ok: dbOk, latencyMs: dbLatencyMs, error: dbError },
            integration: { ok: integrationOk, latencyMs: integrationLatencyMs, error: integrationError, details: integrationData },
            uptimeSeconds: Math.round(process.uptime()),
            memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
        };

        // 3. Record internal health status to database
        await query(`
            INSERT INTO integration_health_checks (check_type, status, message, latency_ms, details)
            VALUES ($1, $2, $3, $4, $5);
        `, ['heartbeat', status, message, totalLatencyMs, JSON.stringify(details)]);

        logger.info('HeartbeatService', `Internal heartbeat tick completed: ${status.toUpperCase()} (DB: ${dbLatencyMs}ms, Int: ${integrationLatencyMs}ms, Total: ${totalLatencyMs}ms)`);
        return { status, latencyMs: totalLatencyMs, dbOk, integrationOk };
    } catch (err) {
        logger.error('HeartbeatService', 'Unexpected error during internal heartbeat:', err.message);
        return { status: 'failed', error: err.message };
    } finally {
        isHeartbeatRunning = false;
    }
}

/**
 * Starts the internal 24/7 heartbeat worker loop.
 */
export function startInternalHeartbeatWorker() {
    if (!HEARTBEAT_ENABLED) {
        logger.info('HeartbeatService', 'Internal Heartbeat is disabled via HEARTBEAT_ENABLED=false');
        return;
    }

    if (heartbeatTimer) return; // Already running

    const intervalMs = HEARTBEAT_INTERVAL_MIN * 60 * 1000;
    logger.info('HeartbeatService', `Starting Internal 24/7 Heartbeat worker in historian_api (interval: ${HEARTBEAT_INTERVAL_MIN} minutes)...`);

    // Warmup tick after 5 seconds
    const initialTimeout = setTimeout(() => {
        executeInternalHeartbeat().catch(err => {
            logger.warn('HeartbeatService', 'Initial internal heartbeat error:', err.message);
        });
    }, 5000);

    heartbeatTimer = setInterval(() => {
        executeInternalHeartbeat().catch(err => {
            logger.warn('HeartbeatService', 'Periodic internal heartbeat error:', err.message);
        });
    }, intervalMs);

    heartbeatTimer._initialTimeout = initialTimeout;
}

/**
 * Stops the internal 24/7 heartbeat worker loop.
 */
export function stopInternalHeartbeatWorker() {
    if (heartbeatTimer) {
        if (heartbeatTimer._initialTimeout) {
            clearTimeout(heartbeatTimer._initialTimeout);
        }
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        logger.info('HeartbeatService', 'Internal Heartbeat worker stopped.');
    }
}
