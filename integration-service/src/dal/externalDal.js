import { query } from '../db.js';
import { EXTERNAL_CONFIG } from '../config/externalConfig.js';
import { logger } from '../utils/logger.js';
import { reportError } from '../clients/batchLineClient.js';

let ensureTablePromise = null;

/**
 * Ensures the persistent deduplication and cooldown tables exist in PostgreSQL.
 * Memoized via Promise so it executes safely and only once on application startup.
 */
export async function ensureForwardedExceptionsTable() {
    if (!ensureTablePromise) {
        ensureTablePromise = (async () => {
            try {
                await query(`
                    CREATE TABLE IF NOT EXISTS forwarded_high_exceptions (
                        dedupe_key TEXT PRIMARY KEY,
                        batch_id TEXT,
                        instruction_id TEXT,
                        created_at TIMESTAMPTZ DEFAULT NOW()
                    );
                    CREATE INDEX IF NOT EXISTS idx_forwarded_high_exceptions_created 
                    ON forwarded_high_exceptions (created_at DESC);

                    CREATE TABLE IF NOT EXISTS instruction_high_exception_alerts (
                        instruction_key TEXT PRIMARY KEY,
                        batch_id TEXT,
                        phase_id TEXT,
                        step_id TEXT,
                        instruction_id TEXT,
                        last_alerted_at TIMESTAMPTZ DEFAULT NOW(),
                        alert_count INT DEFAULT 1
                    );
                    CREATE INDEX IF NOT EXISTS idx_instruction_alerts_last_alerted 
                    ON instruction_high_exception_alerts (instruction_key, last_alerted_at DESC);
                `);
                logger.info('DAL', 'High exception tracking tables verified.');
            } catch (err) {
                logger.warn('DAL', 'Could not ensure exception tables:', err.message);
            }
        })();
    }
    return ensureTablePromise;
}

let ensureScheduledTablePromise = null;

/**
 * Ensures the persistent scheduled instructions table exists in PostgreSQL.
 */
export async function ensureScheduledInstructionsTable() {
    if (!ensureScheduledTablePromise) {
        ensureScheduledTablePromise = (async () => {
            try {
                await query(`
                    CREATE TABLE IF NOT EXISTS scheduled_instructions (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        case_type INT NOT NULL,
                        batch_id TEXT,
                        ref_instruction TEXT NOT NULL,
                        tag_id INT,
                        scheduled_time TIMESTAMPTZ NOT NULL,
                        payload JSONB NOT NULL,
                        status TEXT NOT NULL DEFAULT 'pending',
                        attempts INT NOT NULL DEFAULT 0,
                        max_attempts INT NOT NULL DEFAULT 3,
                        last_error TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        executed_at TIMESTAMPTZ
                    );

                    CREATE INDEX IF NOT EXISTS idx_scheduled_instructions_due 
                    ON scheduled_instructions (scheduled_time, status) 
                    WHERE status = 'pending';

                    CREATE INDEX IF NOT EXISTS idx_scheduled_instructions_active_ref 
                    ON scheduled_instructions (batch_id, ref_instruction) 
                    WHERE status = 'pending';
                `);
                logger.info('DAL', 'Scheduled instructions persistent queue table verified.');
            } catch (err) {
                logger.warn('DAL', 'Could not ensure scheduled_instructions table:', err.message);
            }
        })();
    }
    return ensureScheduledTablePromise;
}

/**
 * Enqueues a scheduled instruction to the persistent PostgreSQL queue.
 * Automatically supersedes any previous pending task for the same (batch_id, ref_instruction).
 */
export async function enqueueScheduledInstruction({
    caseType,
    batchId,
    refInstruction,
    tagId,
    scheduledTime,
    payload,
    maxAttempts = 3
}) {
    await ensureScheduledInstructionsTable();

    // Cancel any previous pending task for the same instruction
    await query(`
        UPDATE scheduled_instructions
        SET status = 'cancelled', last_error = 'Superseded by newer schedule'
        WHERE batch_id IS NOT DISTINCT FROM $1
          AND ref_instruction = $2
          AND status = 'pending';
    `, [batchId, refInstruction]);

    const { rows } = await query(`
        INSERT INTO scheduled_instructions (case_type, batch_id, ref_instruction, tag_id, scheduled_time, payload, max_attempts)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, scheduled_time;
    `, [caseType, batchId, refInstruction, tagId, scheduledTime, JSON.stringify(payload), maxAttempts]);

    return rows[0];
}

/**
 * Atomically claims up to `limit` due scheduled tasks using FOR UPDATE SKIP LOCKED.
 */
export async function claimDueScheduledInstructions(limit = 10) {
    await ensureScheduledInstructionsTable();

    const { rows } = await query(`
        WITH due AS (
            SELECT id
            FROM scheduled_instructions
            WHERE status = 'pending' AND scheduled_time <= NOW()
            ORDER BY scheduled_time ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE scheduled_instructions s
        SET status = 'processing', attempts = attempts + 1
        FROM due
        WHERE s.id = due.id
        RETURNING s.id, s.case_type, s.batch_id, s.ref_instruction, s.tag_id, s.scheduled_time, s.payload, s.attempts, s.max_attempts;
    `, [limit]);

    return rows;
}

/**
 * Marks a scheduled instruction as completed.
 */
export async function markScheduledInstructionCompleted(id) {
    await query(`
        UPDATE scheduled_instructions
        SET status = 'completed', executed_at = NOW(), last_error = NULL
        WHERE id = $1;
    `, [id]);
}

/**
 * Marks a scheduled instruction as failed, retrying if under max_attempts.
 */
export async function markScheduledInstructionFailed(id, errorMessage, canRetry = true) {
    await query(`
        UPDATE scheduled_instructions
        SET status = CASE WHEN attempts >= max_attempts OR NOT $2 THEN 'failed' ELSE 'pending' END,
            last_error = $3,
            executed_at = CASE WHEN attempts >= max_attempts OR NOT $2 THEN NOW() ELSE NULL END
        WHERE id = $1;
    `, [id, canRetry, errorMessage]);
}

/**
 * Cancels pending scheduled instructions matching batchId and refInstruction.
 */
export async function cancelPendingScheduledInstruction(batchId, refInstruction) {
    await ensureScheduledInstructionsTable();
    await query(`
        UPDATE scheduled_instructions
        SET status = 'cancelled', last_error = 'Explicitly cancelled'
        WHERE batch_id IS NOT DISTINCT FROM $1
          AND ref_instruction = $2
          AND status = 'pending';
    `, [batchId, refInstruction]);
}

/**
 * Checks if an alert was already sent for this instruction key within the cooldown window.
 */
export async function checkInstructionAlertCooldown(instructionKey, cooldownMinutes = EXTERNAL_CONFIG.HIGH_EXCEPTION_COOLDOWN_MINUTES) {
    await ensureForwardedExceptionsTable();
    try {
        const { rows } = await query(`
            SELECT last_alerted_at, alert_count
            FROM instruction_high_exception_alerts
            WHERE instruction_key = $1
              AND last_alerted_at > NOW() - ($2 || ' minutes')::interval
            LIMIT 1;
        `, [instructionKey, cooldownMinutes]);

        if (rows && rows.length > 0) {
            return { inCooldown: true, lastAlertedAt: rows[0].last_alerted_at, alertCount: rows[0].alert_count };
        }
    } catch (err) {
        logger.warn('DAL', 'Cooldown check error:', err.message);
    }
    return { inCooldown: false };
}

/**
 * Records or updates the last alerted timestamp for this instruction key in PostgreSQL.
 */
export async function recordInstructionAlert(instructionKey, batchId, phaseId, stepId, instructionId) {
    await ensureForwardedExceptionsTable();
    try {
        await query(`
            INSERT INTO instruction_high_exception_alerts (
                instruction_key, batch_id, phase_id, step_id, instruction_id, last_alerted_at, alert_count
            )
            VALUES ($1, $2, $3, $4, $5, NOW(), 1)
            ON CONFLICT (instruction_key) DO UPDATE
            SET last_alerted_at = EXCLUDED.last_alerted_at,
                alert_count = instruction_high_exception_alerts.alert_count + 1;
        `, [instructionKey, batchId, phaseId, stepId, instructionId]);
    } catch (err) {
        logger.warn('DAL', 'Failed to record alert timestamp:', err.message);
    }
}

/**
 * Atomically claims unforwarded exceptions in PostgreSQL.
 * Guarantees exactly-once dispatch rights across concurrent webhook retries.
 */
export async function claimHighExceptions(candidates = []) {
    if (candidates.length === 0) return [];
    await ensureForwardedExceptionsTable();

    const claimed = [];
    for (const candidate of candidates) {
        try {
            const { rows } = await query(`
                INSERT INTO forwarded_high_exceptions (dedupe_key, batch_id, instruction_id)
                VALUES ($1, $2, $3)
                ON CONFLICT (dedupe_key) DO NOTHING
                RETURNING dedupe_key;
            `, [candidate.dedupeKey, candidate.basePayload.BatchId, candidate.basePayload.InstructionId]);

            if (rows && rows.length > 0) {
                claimed.push(candidate);
            }
        } catch (err) {
            logger.warn('DAL', 'DB atomic claim error:', err.message);
        }
    }
    return claimed;
}

/**
 * Releases claimed exception dedupe keys if external dispatch fails.
 */
export async function releaseClaimedHighExceptions(candidates = []) {
    if (!candidates || candidates.length === 0) return;
    try {
        const keys = candidates.map(c => c.dedupeKey).filter(Boolean);
        if (keys.length === 0) return;
        await query(`
            DELETE FROM forwarded_high_exceptions
            WHERE dedupe_key = ANY($1::text[]);
        `, [keys]);
    } catch (err) {
        logger.warn('DAL', 'Failed to release claimed exceptions:', err.message);
    }
}

/**
 * Resolves a tag record from refElement (e.g. "R1.TEMP" or "Reactor 1.TEMP").
 */
export async function resolveTag(refElement, ctx = null) {
    if (!refElement) return null;
    const trimmed = String(refElement).trim();
    const dotIndex = trimmed.indexOf('.');
    const assetStr = trimmed.slice(0, dotIndex).trim();
    const paramStr = trimmed.slice(dotIndex + 1).trim();
    let assetCodeCandidate = assetStr.toUpperCase();
    const match = assetStr.match(/reactor\s*(\d+)/i);
    if (match) {
        assetCodeCandidate = `R${match[1]}`;
    }
    const tagCandidate = `${assetCodeCandidate}.${paramStr}`;

    const { rows } = await query(`
        SELECT t.id, t.name, t.parameter, t.display_digits, t.units, a.code as asset_code 
        FROM tags t 
        JOIN assets a ON t.asset_id = a.id 
        WHERE LOWER(t.name) = LOWER($1);
    `, [tagCandidate]);

    if (rows.length > 0) {
        logger.debug('DAL', `Resolved tag candidate "${tagCandidate}"`, { id: rows[0].id, name: rows[0].name });
        return rows[0];
    }
    await reportError(`[Tag Resolution Error]: Tag not found for candidate "${tagCandidate}"`, ctx);
    return null;
}

/**
 * High-performance dual index-seek to fetch nearest reading to target timestamp.
 */
export async function getNearestReading(tagId, refTime) {
    const targetDate = refTime ? new Date(refTime) : new Date();

    const { rows } = await query(`
        WITH candidates AS (
            (
                SELECT r.ts, r.value, r.quality
                FROM readings r
                WHERE r.tag_id = $1 AND r.ts <= $2::timestamptz
                ORDER BY r.ts DESC
                LIMIT 1
            )
            UNION ALL
            (
                SELECT r.ts, r.value, r.quality
                FROM readings r
                WHERE r.tag_id = $1 AND r.ts > $2::timestamptz
                ORDER BY r.ts ASC
                LIMIT 1
            )
        )
        SELECT ts, value, quality
        FROM candidates
        ORDER BY ABS(EXTRACT(EPOCH FROM (ts - $2::timestamptz))) ASC
        LIMIT 1;
    `, [tagId, targetDate]);

    if (rows.length > 0) return rows[0];

    // Fallback to latest snapshot
    const { rows: snapshotRows } = await query(`
        SELECT s.ts, s.value, s.quality
        FROM snapshots s
        WHERE s.tag_id = $1
        LIMIT 1;
    `, [tagId]);

    return snapshotRows.length > 0 ? snapshotRows[0] : null;
}

/**
 * Fetches the reading nearest to target timestamp within a strict tolerance window.
 */
export async function getReadingNearTimestamp(tagId, targetDate, toleranceMs) {
    const { rows } = await query(`
        WITH bounded_candidates AS (
            (
                SELECT r.ts, r.value, r.quality
                FROM readings r
                WHERE r.tag_id = $1
                  AND r.ts <= $2::timestamptz
                  AND r.ts >= ($2::timestamptz - ($3 || ' milliseconds')::interval)
                ORDER BY r.ts DESC
                LIMIT 1
            )
            UNION ALL
            (
                SELECT r.ts, r.value, r.quality
                FROM readings r
                WHERE r.tag_id = $1
                  AND r.ts > $2::timestamptz
                  AND r.ts <= ($2::timestamptz + ($3 || ' milliseconds')::interval)
                ORDER BY r.ts ASC
                LIMIT 1
            )
        )
        SELECT ts, value, quality
        FROM bounded_candidates
        ORDER BY ABS(EXTRACT(EPOCH FROM (ts - $2::timestamptz))) ASC
        LIMIT 1;
    `, [tagId, targetDate, toleranceMs]);

    if (rows.length > 0) return rows[0];

    // Fallback check on snapshot if within tolerance window
    const { rows: snapRows } = await query(`
        SELECT s.ts, s.value, s.quality
        FROM snapshots s
        WHERE s.tag_id = $1
          AND ABS(EXTRACT(EPOCH FROM (s.ts - $2::timestamptz))) <= ($3 / 1000.0)
        LIMIT 1;
    `, [tagId, targetDate, toleranceMs]);

    return snapRows.length > 0 ? snapRows[0] : null;
}

/**
 * Finds the record time in historian nearest to targetValue of a tag after afterTime.
 * Detects crossing points or closest readings within a reasonable tolerance.
 */
export async function findRecordTimeNearestToValue(tagId, afterTime, targetValue, maxTolerance = 2.0) {
    const CHUNK_SIZE = 5000;
    let prevRow = null;
    let bestRow = null;
    let minDiff = Infinity;

    // Scan forward in time from afterTime (using index on tag_id, ts)
    const { rows: chunk } = await query(`
        SELECT ts, value, quality
        FROM readings
        WHERE tag_id = $1 AND ts >= $2::timestamptz
        ORDER BY ts ASC
        LIMIT $3;
    `, [tagId, afterTime, CHUNK_SIZE]);

    if (!chunk || chunk.length === 0) {
        return null;
    }

    for (const currRow of chunk) {
        if (currRow.value === null || currRow.value === undefined) continue;
        const currVal = Number(currRow.value);
        if (Number.isNaN(currVal)) continue;

        const diffCurr = Math.abs(currVal - targetValue);
        if (diffCurr < minDiff) {
            minDiff = diffCurr;
            bestRow = currRow;
        }

        // First time signal crossed the target
        if (prevRow !== null) {
            const prevVal = Number(prevRow.value);
            const isCrossing = (prevVal <= targetValue && currVal >= targetValue) ||
                (prevVal >= targetValue && currVal <= targetValue);
            if (isCrossing) {
                const diffPrev = Math.abs(prevVal - targetValue);
                return diffPrev <= diffCurr ? prevRow : currRow;
            }
        }

        prevRow = currRow;
    }

    // Fallback: If it never crossed, return the peak reading only if close to target
    if (bestRow && minDiff <= maxTolerance) {
        return bestRow;
    }

    return null;
}

/**
 * Finds event for batch matching recipe ID and event name/level.
 */
export async function findEventForBatch({ refRecipe, refEvent }) {
    if (!refRecipe || !refEvent) return null;

    const trimmedRecipe = String(refRecipe).trim();
    const trimmedEvent = String(refEvent).trim();

    const sql = `
        SELECT e.id, e.name, e.level, e.started_at, e.ended_at, a.code AS asset_code, b.batch_id
        FROM events e
        JOIN batches b ON e.batch_pk = b.id
        JOIN assets a ON e.asset_id = a.id
        WHERE (LOWER(TRIM(b.batch_id)) = LOWER($1) OR b.id::text = $1)
          AND (
            LOWER(TRIM(e.name)) = LOWER($2)
            OR REPLACE(LOWER(TRIM(e.name)), '_', ' ') = REPLACE(LOWER(TRIM($2)), '_', ' ')
            OR LOWER(TRIM(e.level)) = LOWER($2)
          )
        ORDER BY e.started_at DESC
        LIMIT 1;
    `;
    const params = [trimmedRecipe, trimmedEvent];

    const { rows } = await query(sql, params);
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Resolves batch row by batchId or finds the active running batch.
 */
export async function findBatchByIdOrActive(rawBatchId) {
    if (rawBatchId) {
        const { rows } = await query(
            'SELECT id, batch_id, status FROM batches WHERE LOWER(batch_id) = LOWER($1) LIMIT 1',
            [rawBatchId]
        );
        if (rows.length > 0) return rows[0];
    }

    // Fallback: Check currently running batch or latest
    const { rows: runningRows } = await query(
        "SELECT id, batch_id, status FROM batches WHERE status = 'Running' ORDER BY started_at DESC LIMIT 1"
    );
    if (runningRows.length > 0) return runningRows[0];

    const { rows: latestRows } = await query(
        "SELECT id, batch_id, status FROM batches ORDER BY started_at DESC LIMIT 1"
    );
    return latestRows.length > 0 ? latestRows[0] : null;
}

/**
 * Queries batch exceptions with optional phase and tag filters.
 */
export async function getBatchExceptions(batchPk, filterPhase = null, filterTag = null) {
    const queryParams = [batchPk];
    let filterSql = '';
    if (filterPhase) {
        queryParams.push(`%${filterPhase}%`);
        filterSql += ` AND be.phase_name ILIKE $${queryParams.length}`;
    }
    if (filterTag) {
        queryParams.push(`%${filterTag}%`);
        filterSql += ` AND t.name ILIKE $${queryParams.length}`;
    }

    const { rows } = await query(`
        SELECT 
            be.id,
            be.phase_name,
            be.exception_type,
            be.limit_value,
            be.peak_value,
            be.started_at,
            be.ended_at,
            be.duration_sec,
            t.name AS tag_name,
            t.display_digits,
            a.code AS asset_code
        FROM batch_exceptions be
        JOIN tags t ON be.tag_id = t.id
        JOIN assets a ON be.asset_id = a.id
        WHERE be.batch_pk = $1 ${filterSql}
        ORDER BY be.started_at ASC, be.id ASC;
    `, queryParams);

    return rows;
}
