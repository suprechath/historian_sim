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

    const batchStatus = rawBatchStatus ? String(rawBatchStatus).trim() : null;
    const batchId = rawBatchId ? String(rawBatchId).trim() : null;
    const isStarted = batchStatus ? batchStatus.toLowerCase() === 'started' : false;

    return {
        topic,
        batchObj,
        batchStatus,
        batchId,
        isStarted
    };
}

/**
 * Ensures simulation_control and batch_queue tables and columns exist.
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
 * @returns {Promise<Object>} Assignment result
 */
export async function assignBatchToQueue({
    batchId,
    startImmediate = true,
    startImmediately,
    resetDownstream = false,
    clearTrain = false,
    resume = false
} = {}) {
    await ensureSimulationControl();

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

    // Check if batch ID already exists in batches table
    const { rows: existing } = await query('SELECT id, status, started_at FROM batches WHERE batch_id = $1', [cleanBatchId]);
    if (existing.length > 0) {
        throw new Error(`Batch '${cleanBatchId}' already exists in historian records (Status: ${existing[0].status}). Please choose a unique batch number.`);
    }

    // Check if batch ID is already pending in batch_queue
    const { rows: pendingExisting } = await query(
        "SELECT id, status FROM batch_queue WHERE batch_id = $1 AND status IN ('waiting_r1', 'in_queue')",
        [cleanBatchId]
    );
    if (pendingExisting.length > 0) {
        throw new Error(`Batch '${cleanBatchId}' is already in the manual request queue.`);
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
