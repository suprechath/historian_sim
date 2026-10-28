import { query } from '../db.js';
import { logger } from '../utils/logger.js';

// In-memory simulation state cache (synchronized with database)
export const simState = {
    running: true,
    speed: 1,
    mode: 'continuous',
    assignedBatchId: null,
    singleBatchStatus: 'idle',
    updatedAt: new Date()
};

/**
 * Extracts and normalizes batch status info from incoming status webhook payloads.
 *
 * @param {Object} body - Request body
 * @returns {Object} Extracted batch status details
 */
export function extractBatchStatusPayload(body = {}) {
    const topic = body?.Topic || null;
    const batchObj = body?.Data?.Batch || body?.Batch || {};
    const rawBatchStatus = batchObj.BatchStatus || body?.BatchStatus || null;
    const rawBatchId = batchObj.BatchId || body?.BatchId || null;
    const rawProductSpecId = batchObj.ProductSpecificationId || body?.ProductSpecificationId || null;

    const batchStatus = rawBatchStatus ? String(rawBatchStatus).trim() : null;
    const batchId = rawBatchId ? String(rawBatchId).trim() : null;
    const productSpecificationId = rawProductSpecId ? String(rawProductSpecId).trim() : null;
    const isStarted = batchStatus ? batchStatus.toLowerCase() === 'started' : false;

    return {
        topic,
        batchObj,
        batchStatus,
        batchId,
        productSpecificationId,
        isStarted
    };
}

/**
 * Checks whether a given ProductSpecificationId exists in the excluded_product_specifications database table.
 * Comparison is case-insensitive and whitespace-trimmed.
 *
 * @param {string|null} productSpecificationId
 * @returns {Promise<boolean>} True if excluded, false otherwise
 */
export async function isProductSpecExcluded(productSpecificationId) {
    if (!productSpecificationId || typeof productSpecificationId !== 'string' || !productSpecificationId.trim()) {
        return false;
    }

    try {
        const cleanSpecId = productSpecificationId.trim();
        const { rows } = await query(
            `SELECT 1 FROM excluded_product_specifications 
             WHERE LOWER(TRIM(product_specification_id)) = LOWER($1) 
             LIMIT 1`,
            [cleanSpecId]
        );
        return rows.length > 0;
    } catch (err) {
        logger.warn('BatchQueue', `Could not query excluded_product_specifications table: ${err.message}`);
        return false;
    }
}

/**
 * Ensures simulation_control, batch_queue, and excluded_product_specifications tables exist.
 */
export async function ensureSimulationControl() {
    await query(`
      CREATE TABLE IF NOT EXISTS simulation_control (
        id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        running           BOOLEAN NOT NULL DEFAULT true,
        speed             INTEGER NOT NULL DEFAULT 1 CHECK (speed >= 1 AND speed <= 3600),
        phase_skip_asset  TEXT,
        mode              TEXT NOT NULL DEFAULT 'continuous' CHECK (mode IN ('continuous', 'single')),
        assigned_batch_id TEXT,
        batch_command     TEXT,
        single_batch_status TEXT DEFAULT 'idle',
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE simulation_control ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'continuous';
      ALTER TABLE simulation_control ADD COLUMN IF NOT EXISTS assigned_batch_id TEXT;
      ALTER TABLE simulation_control ADD COLUMN IF NOT EXISTS batch_command TEXT;
      ALTER TABLE simulation_control ADD COLUMN IF NOT EXISTS single_batch_status TEXT DEFAULT 'idle';
      ALTER TABLE simulation_control ADD COLUMN IF NOT EXISTS process_skip_asset TEXT;
      INSERT INTO simulation_control (id, running, speed, mode)
      VALUES (1, true, 1, 'continuous')
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS batch_queue (
        id SERIAL PRIMARY KEY,
        batch_id TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_queue',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_batch_queue_status ON batch_queue(status);

      CREATE TABLE IF NOT EXISTS excluded_product_specifications (
        product_specification_id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

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
    `);
}

/**
 * Fetch live simulation control state from database.
 */
export async function getSimulationState() {
    try {
        const { rows } = await query('SELECT running, speed, mode, assigned_batch_id, single_batch_status, updated_at FROM simulation_control WHERE id = 1');
        if (rows.length > 0) {
            simState.running = rows[0].running;
            simState.speed = rows[0].speed;
            simState.mode = rows[0].mode || 'continuous';
            simState.assignedBatchId = rows[0].assigned_batch_id || null;
            simState.singleBatchStatus = rows[0].single_batch_status || 'idle';
            simState.updatedAt = rows[0].updated_at;
        }
    } catch (err) {
        // Fallback to in-memory state if table not ready
    }
    return simState;
}

/**
 * Assigns a batch to the simulator queue (equivalent to DemoControls handleAssignBatch).
 *
 * @param {Object} options
 * @param {string} options.batchId - Identifier for the batch
 * @param {boolean} [options.startImmediate=true] - Start immediately in R1 (Combination 1)
 * @param {boolean} [options.startImmediately] - Alias for startImmediate
 * @param {boolean} [options.resetDownstream=false] - Clear train & omit existing (Combination 3)
 * @param {boolean} [options.clearTrain=false] - Alias for resetDownstream
 * @param {boolean} [options.resume=false] - Ensure simulator running is unpaused
 * @param {boolean} [options.fromHealthCheckClose=false] - Explicitly called upon operator closing HEALTH_CHECK dialogue
 * @returns {Promise<Object>} Assignment result
 */
export async function assignBatchToQueue({
    batchId,
    startImmediate = true,
    startImmediately,
    resetDownstream = false,
    clearTrain = false,
    resume = false,
    fromHealthCheckClose = false
} = {}) {
    if (!batchId || typeof batchId !== 'string' || !batchId.trim()) {
        throw new Error('Batch number or identifier is required.');
    }
    let cleanBatchId = batchId.trim();

    // If purely numeric, format as standard B-YYYY-NNNN
    if (/^\d+$/.test(cleanBatchId)) {
        const year = new Date().getUTCFullYear();
        cleanBatchId = `B-${year}-${cleanBatchId.padStart(4, '0')}`;
    }

    // Industrial regex validation: alphanumeric, hyphens, dots, underscores (max 64 chars)
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(cleanBatchId)) {
        throw new Error('Batch identifier may only contain alphanumeric characters, hyphens, dots, and underscores (1–64 characters).');
    }

    await ensureSimulationControl();

    // 1. Check if batch ID already exists in batches table (already running or recorded in Historian)
    const { rows: existing } = await query('SELECT id, status, started_at FROM batches WHERE batch_id = $1', [cleanBatchId]);
    if (existing.length > 0) {
        logger.info('BatchQueue', `Batch '${cleanBatchId}' already exists in historian records (Status: ${existing[0].status}). Avoiding a new queue.`);
        const currentSim = await getSimulationState();
        return {
            cleanBatchId,
            cmd: 'already_started',
            initialStatus: existing[0].status,
            alreadyInQueue: true,
            alreadyStarted: true,
            queueEntry: null,
            control: currentSim,
            simState: currentSim
        };
    }

    // 2. Condition 3.1: If the batch was already in queue, avoid a new queue
    const { rows: pendingExisting } = await query(
        "SELECT id, batch_id, command, status FROM batch_queue WHERE batch_id = $1 AND status IN ('waiting_r1', 'in_queue', 'pending_omit')",
        [cleanBatchId]
    );
    if (pendingExisting.length > 0) {
        logger.info('BatchQueue', `Batch '${cleanBatchId}' is already in queue with status '${pendingExisting[0].status}'. Avoiding a new queue.`);
        const currentSim = await getSimulationState();
        return {
            cleanBatchId,
            cmd: pendingExisting[0].command,
            initialStatus: pendingExisting[0].status,
            alreadyInQueue: true,
            queueEntry: pendingExisting[0],
            control: currentSim,
            simState: currentSim
        };
    }

    // 3. Condition: Batch will start after user clicks close HEALTH_CHECK dialogue
    // If an on-demand health check exists for this batch and has NOT been closed/acknowledged yet,
    // hold off starting the batch until the operator closes the dialogue.
    if (!fromHealthCheckClose) {
        try {
            const { rows: pendingHealthChecks } = await query(`
                SELECT id, created_at
                FROM integration_health_checks
                WHERE batch_id = $1
                  AND check_type = 'on_demand'
                  AND acknowledged_at IS NULL
                  AND created_at >= NOW() - INTERVAL '10 minutes'
                ORDER BY created_at DESC
                LIMIT 1;
            `, [cleanBatchId]);

            if (pendingHealthChecks.length > 0) {
                logger.info('BatchQueue', `Batch '${cleanBatchId}' has an active HEALTH_CHECK dialogue pending operator closure (HealthCheck ID: ${pendingHealthChecks[0].id}). Batch in Historian will start after user clicks close HEALTH_CHECK dialogue.`);
                const currentSim = await getSimulationState();
                return {
                    cleanBatchId,
                    cmd: 'awaiting_health_check_close',
                    initialStatus: 'awaiting_health_check',
                    pendingHealthCheck: true,
                    healthCheckId: pendingHealthChecks[0].id,
                    alreadyInQueue: false,
                    queueEntry: null,
                    control: currentSim,
                    simState: currentSim
                };
            }
        } catch (hcErr) {
            // Non-fatal if table or column does not exist yet
            logger.warn('BatchQueue', `Could not check pending health check status: ${hcErr.message}`);
        }
    }

    const isStartImmediate = Boolean(startImmediate ?? startImmediately ?? false);
    const isResetDownstream = Boolean(!isStartImmediate && (resetDownstream || clearTrain));

    let cmd = 'start_queue';
    let initialStatus = 'in_queue';

    if (isStartImmediate) {
        // Combination 1: Start immediately if R1 idle, else wait in queue of R1
        cmd = 'start_immediate';
        initialStatus = 'waiting_r1';
    } else if (isResetDownstream) {
        // Combination 3: Omit existing batch and start R1 with new batch immediately
        cmd = 'start_omit_existing';
        initialStatus = 'pending_omit';
    } else {
        // Combination 2: Wait till existing batch finishes R3
        cmd = 'start_queue';
        initialStatus = 'in_queue';
    }

    // Insert into batch_queue
    const { rows: queueRows } = await query(`
      INSERT INTO batch_queue (batch_id, command, status, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING id, batch_id, command, status;
    `, [cleanBatchId, cmd, initialStatus]);

    const { rows } = await query(`
      UPDATE simulation_control
      SET mode = 'single',
          assigned_batch_id = $1,
          batch_command = $2,
          single_batch_status = $3,
          running = CASE WHEN $4 THEN true ELSE running END,
          updated_at = NOW()
      WHERE id = 1
      RETURNING running, speed, mode, assigned_batch_id, single_batch_status, updated_at;
    `, [cleanBatchId, cmd, initialStatus, Boolean(resume)]);

    if (rows.length > 0) {
        simState.running = rows[0].running;
        simState.speed = rows[0].speed;
        simState.mode = rows[0].mode || 'single';
        simState.assignedBatchId = rows[0].assigned_batch_id || cleanBatchId;
        simState.singleBatchStatus = rows[0].single_batch_status || initialStatus;
        simState.updatedAt = rows[0].updated_at;
    }

    return {
        cleanBatchId,
        cmd,
        initialStatus,
        queueEntry: queueRows[0],
        control: rows[0] || {},
        simState
    };
}
