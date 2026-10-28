import { performance } from 'perf_hooks';
import { query } from '../db.js';
import { logger } from '../utils/logger.js';
import { sendBatchLineNotification, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';
import { formatBatchLineDate, formatExecutedTimestamp, cleanPayloadField } from '../utils/formatters.js';
import { extractInstructionPayload } from '../utils/instructionParsers.js';


let ensureTablesPromise = null;

/**
 * Ensures the persistent integration_health_checks table exists in PostgreSQL.
 * Memoized via Promise so it runs only once on startup.
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
                        acknowledged_at TIMESTAMPTZ,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    ALTER TABLE integration_health_checks ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
                    CREATE INDEX IF NOT EXISTS idx_health_checks_created_at 
                    ON integration_health_checks (created_at DESC);
                    CREATE INDEX IF NOT EXISTS idx_health_checks_type_created 
                    ON integration_health_checks (check_type, created_at DESC);
                    CREATE INDEX IF NOT EXISTS idx_health_checks_batch_ack
                    ON integration_health_checks (batch_id, check_type, acknowledged_at);
                `);
                logger.info('HealthCheck', 'Integration health check tables verified.');
            } catch (err) {
                logger.warn('HealthCheck', 'Could not ensure health check tables:', err.message);
            }
        })();
    }
    return ensureTablesPromise;
}

/**
 * Records a health check or heartbeat entry into the database.
 */
export async function recordHealthCheck({
    checkType = 'on_demand',
    batchId = null,
    instructionId = null,
    status = 'passed',
    message = '',
    latencyMs = 0,
    details = {}
}) {
    try {
        await ensureHealthCheckTables();
        const { rows } = await query(`
            INSERT INTO integration_health_checks (check_type, batch_id, instruction_id, status, message, latency_ms, details)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, created_at;
        `, [
            checkType,
            batchId,
            instructionId,
            status,
            message,
            latencyMs,
            JSON.stringify(details || {})
        ]);
        return rows[0] || null;
    } catch (err) {
        logger.error('HealthCheck', 'Failed to write record to integration_health_checks:', err.message);
        return null;
    }
}

/**
 * Records an entry into the plant events table so it appears in the plant operator's live event/alarm feed.
 */
async function recordPlantEvent({ batchId, status, details }) {
    try {
        let batchPk = null;
        let assetId = 1; // Default to Reactor 1 (R1)

        if (batchId && batchId !== 'UNKNOWN') {
            const { rows } = await query('SELECT id, current_asset_id FROM batches WHERE batch_id = $1 LIMIT 1;', [batchId]);
            if (rows.length > 0) {
                batchPk = rows[0].id;
                if (rows[0].current_asset_id) {
                    assetId = rows[0].current_asset_id;
                }
            }
        }

        const isPassed = status === 'passed';
        const eventName = isPassed
            ? `BatchLine Health Check [PASSED] (Batch: ${batchId || 'N/A'})`
            : `BatchLine Health Check [FAILED] (Batch: ${batchId || 'N/A'})`;
        const level = isPassed ? 'StateChange' : 'Alarm';

        await query(`
            INSERT INTO events (asset_id, batch_pk, name, level, started_at, details)
            VALUES ($1, $2, $3, $4, NOW(), $5);
        `, [assetId, batchPk, eventName, level, JSON.stringify(details || {})]);
    } catch (err) {
        logger.warn('HealthCheck', 'Could not insert event into events table (non-fatal):', err.message);
    }
}

/**
 * Handles incoming On-Demand Health Check trigger from BatchLine.
 * Intercepts [HEALTH_CHECK] trigger in instruction webhook.
 * Always returns HTTP 200 to acknowledge the webhook cleanly.
 */
export async function handleOnDemandHealthCheck(req, res) {
    const startTime = performance.now();
    const body = req.body || {};
    const data = body.Data || {};
    const batch = data.Batch || {};
    const phase = batch.Phase || {};
    const step = phase.Step || {};
    const instruction = step.Instruction || {};

    const payloadCtx = extractInstructionPayload(body);
    const phases = Array.isArray(batch.Phases) ? batch.Phases : (batch.Phase ? [batch.Phase] : []);
    const firstPhase = phases[0] || {};
    const steps = Array.isArray(firstPhase.Steps) ? firstPhase.Steps : (firstPhase.Step ? [firstPhase.Step] : []);
    const firstStep = steps[0] || {};
    const instructions = Array.isArray(firstStep.Instructions) ? firstStep.Instructions : (firstStep.Instruction ? [firstStep.Instruction] : []);
    const firstInstruction = instructions[0] || body.Instruction || {};

    const batchId = payloadCtx.batchId || batch.BatchId || batch.BatchID || body.batch_id || body.BatchId || body.BatchID || 'UNKNOWN';
    const instructionId = firstInstruction.InstructionId || instruction.InstructionId || body.InstructionId || null;
    const refInstruction = payloadCtx.refInstruction || cleanPayloadField(firstInstruction.RefInstruction || instruction.RefInstruction || body.RefInstruction || data.RefInstruction);
    const triggeredByEmail = payloadCtx.triggeredByEmail || firstInstruction.TriggeredByEmail || instruction.TriggeredByEmail || body.TriggeredByEmail || null;
    const callbackKey = payloadCtx.callbackKey || body.CallbackKey || body.callbackkey || data.CallbackKey || null;

    let dbHealthy = false;
    let dbError = null;

    try {
        await query('SELECT 1;');
        dbHealthy = true;
    } catch (err) {
        dbError = err.message;
        logger.error('HealthCheck', 'Database check failed during on-demand health check:', err.message);
    }

    const latencyMs = Math.round(performance.now() - startTime);
    const status = dbHealthy ? 'passed' : 'failed';
    const formattedDate = formatBatchLineDate(new Date());

    const blMessage = dbHealthy
        ? `[Historian HealthCheck]: PASSED at ${formattedDate} (DB: Connected, Latency: ${latencyMs}ms, Batch: ${batchId})`
        : `[Historian HealthCheck]: FAILED at ${formattedDate} (DB Error: ${dbError}, Batch: ${batchId})`;

    // Push notification back to BatchLine so operator/system sees it immediately
    let notificationResult = null;
    try {
        notificationResult = await sendBatchLineNotification({
            batchId: batchId !== 'UNKNOWN' ? batchId : null,
            message: blMessage,
            callbackKey
        });
    } catch (notifErr) {
        logger.warn('HealthCheck', 'Failed to dispatch notification to BatchLine:', notifErr.message);
        notificationResult = { ok: false, error: notifErr.message };
    }

    // If RefInstruction is specified, update BatchLine instruction with BatchId
    let refUpdateResult = null;
    if (refInstruction && batchId && batchId !== 'UNKNOWN') {
        try {
            logger.info('HealthCheck', `RefInstruction "${refInstruction}" detected in health check payload. Sending BatchId "${batchId}" back to BatchLine...`);
            refUpdateResult = await sendBatchLineInstructionUpdate({
                refInstruction,
                batchId,
                callbackKey,
                triggeredByEmail,
                actualResult: [
                    {
                        repeat_no: 1,
                        value: String(batchId),
                        executed_timestamp: formatExecutedTimestamp(new Date()),
                        executed_user_email: triggeredByEmail
                    }
                ]
            });

            if (refUpdateResult?.ok) {
                logger.info('HealthCheck', `Successfully updated instruction "${refInstruction}" with BatchId "${batchId}"`);
            } else {
                logger.warn('HealthCheck', `Failed to update instruction "${refInstruction}" with BatchId "${batchId}":`, refUpdateResult?.error || refUpdateResult?.data);
            }
        } catch (refErr) {
            logger.warn('HealthCheck', `Error updating instruction "${refInstruction}" with BatchId "${batchId}":`, refErr.message);
            refUpdateResult = { ok: false, error: refErr.message };
        }
    }

    const details = {
        refInstruction,
        refUpdateResult,
        batchId,
        instructionId,
        callbackKey,
        triggeredByEmail,
        dbHealthy,
        dbError,
        notificationResult,
        memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        uptimeSeconds: Math.round(process.uptime())
    };

    // Store in integration_health_checks table
    const record = await recordHealthCheck({
        checkType: 'on_demand',
        batchId,
        instructionId,
        status,
        message: blMessage,
        latencyMs,
        details
    });

    // Record into plant events table for real-time operator feed
    await recordPlantEvent({ batchId, status, details });

    logger.info('HealthCheck', `On-demand health check completed: ${status.toUpperCase()} in ${latencyMs}ms (RefInstruction: ${refInstruction || 'N/A'})`);

    // Best practice: Always return 200 OK to the webhook caller to prevent retry storms
    return res.status(200).json({
        status: 'received',
        healthCheck: {
            id: record?.id || null,
            type: 'on_demand',
            result: status,
            message: blMessage,
            latencyMs,
            notificationSent: Boolean(notificationResult?.ok),
            refInstruction: refInstruction || null,
            refInstructionUpdated: Boolean(refUpdateResult?.ok),
            refUpdateResult: refUpdateResult || null,
            timestamp: new Date().toISOString()
        }
    });
}
