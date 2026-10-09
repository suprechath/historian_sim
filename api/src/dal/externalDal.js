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
 */
export async function findRecordTimeNearestToValue(tagId, afterTime, targetValue) {
    const CHUNK_SIZE = 5000;
    let prevRow = null;

    const { rows: firstChunk } = await query(`
        SELECT ts, value
        FROM readings
        WHERE tag_id = $1 AND ts >= $2::timestamptz
        ORDER BY ts ASC
        LIMIT $3;
    `, [tagId, afterTime, CHUNK_SIZE]);

    if (!firstChunk || firstChunk.length === 0) {
        return null;
    }

    const firstVal = Number(firstChunk[0].value);
    if (!Number.isNaN(firstVal) && Math.abs(firstVal - targetValue) < 1e-4) {
        return firstChunk[0];
    }

    let rowsToCheck = firstChunk;
    while (rowsToCheck.length > 0) {
        for (let i = 0; i < rowsToCheck.length; i++) {
            const currRow = rowsToCheck[i];
            if (currRow.value === null || currRow.value === undefined) continue;
            const currVal = Number(currRow.value);
            if (Number.isNaN(currVal)) continue;

            if (prevRow !== null) {
                const prevVal = Number(prevRow.value);
                const isCrossing = (prevVal <= targetValue && currVal >= targetValue) ||
                    (prevVal >= targetValue && currVal <= targetValue);
                if (isCrossing) {
                    const diffPrev = Math.abs(prevVal - targetValue);
                    const diffCurr = Math.abs(currVal - targetValue);
                    return diffPrev <= diffCurr ? prevRow : currRow;
                }
            }
            prevRow = currRow;
        }

        if (rowsToCheck.length < CHUNK_SIZE) {
            break;
        }

        const lastTs = rowsToCheck[rowsToCheck.length - 1].ts;
        const { rows: nextChunk } = await query(`
            SELECT ts, value
            FROM readings
            WHERE tag_id = $1 AND ts > $2::timestamptz
            ORDER BY ts ASC
            LIMIT $3;
        `, [tagId, lastTs, CHUNK_SIZE]);

        rowsToCheck = nextChunk;
    }

    // Fallback: If target was never reached or crossed, find reading nearest in value after afterTime
    const { rows: nearestRows } = await query(`
        SELECT ts, value
        FROM readings
        WHERE tag_id = $1 AND ts >= $2::timestamptz
        ORDER BY ABS(value - $3) ASC, ts ASC
        LIMIT 1;
    `, [tagId, afterTime, targetValue]);

    return nearestRows.length > 0 ? nearestRows[0] : (prevRow || null);
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
