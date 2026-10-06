import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { query } from '../db.js';

// Resolve and load root .env (three levels up from api/src/routes)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const router = Router();

// ===========================================================================
// CONFIGURATION & CONSTANTS
// ===========================================================================
const CONFIG = {
    BATCHLINE_BASE_URL: process.env.BATCHLINE_BASE_URL || 'https://batch-demo.bl-client.com',
    BATCHLINE_NOTIFICATION_URL: process.env.BATCHLINE_NOTIFICATION_URL || 'https://demo.bl-client.com/Notification/push',
    BATCHLINE_API_KEY: process.env.BATCHLINE_API_KEY || '',
    HTTP_TIMEOUT_MS: parseInt(process.env.BATCHLINE_TIMEOUT_MS || '15000', 10),
    PUSH_DELAY_MS: parseInt(process.env.BATCHLINE_PUSH_DELAY_MS || process.env.PUSH_DELAY_MS || '200', 10),
    MAX_PERIODIC_REPEATS: parseInt(process.env.MAX_PERIODIC_REPEATS || '100', 10),
    DEFAULT_PERIODIC_INTERVAL_MIN: parseInt(process.env.DEFAULT_PERIODIC_INTERVAL_MIN || '5', 10),
    MAX_PROFILE_SAMPLES: parseInt(process.env.MAX_PROFILE_SAMPLES || '30', 10),
};

const STAT_OPERATIONS = {
    MAX: 'max',
    MAXIMUM: 'max',
    MIN: 'min',
    MINIMUM: 'min',
    AVG: 'avg',
    AVERAGE: 'avg',
    MEAN: 'avg',
    SUM: 'sum',
    TOTAL: 'sum',
    COUNT: 'sample_count',
    SAMPLES: 'sample_count',
    STDDEV: 'stddev',
    STD: 'stddev',
    STDEV: 'stddev',
    STANDARD_DEVIATION: 'stddev',
    VARIANCE: 'variance',
    VAR: 'variance',
    RANGE: 'range',
    MEDIAN: 'median',
    FIRST: 'first',
    LAST: 'last'
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ===========================================================================
// UTILITY HELPERS
// ===========================================================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ✅
function formatReadingValue(value, displayDigits) {
    if (value === null || value === undefined) return '0';
    const num = Number(value);
    if (isNaN(num)) return String(value);
    if (displayDigits !== null && displayDigits !== undefined) {
        if (displayDigits === 0) return String(Math.round(num));
        return String(Number(num.toFixed(displayDigits)));
    }
    return String(Math.round(num));
}

// ✅
function formatBatchLineDate(date) {
    if (!date) return null;
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;

    const month = MONTH_NAMES[d.getUTCMonth()];
    const day = String(d.getUTCDate()).padStart(2, '0');
    const year = d.getUTCFullYear();
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const minutes = String(d.getUTCMinutes()).padStart(2, '0');
    const seconds = String(d.getUTCSeconds()).padStart(2, '0');

    return `${month} ${day}, ${year} ${hours}:${minutes}:${seconds}`;
}

// ✅
function formatExecutedTimestamp(date) {
    if (!date) return null;
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19) + '+00:00';
}

function parseBatchLineDate(dateStr) {
    if (!dateStr) return null;
    const str = String(dateStr).trim();
    const utcMatch = str.match(/^UTC\((.*?)\)$/i);
    if (utcMatch) {
        const d = new Date(utcMatch[1].trim() + ' UTC');
        if (!isNaN(d.getTime())) return d;
    }
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

function cleanInstructionId(instructionId = '') {
    if (!instructionId) return '';
    return String(instructionId).trim().replace(/^\[+/, '').replace(/\]+$/, '').toUpperCase();
}

/**
 * Extracts [TIME: ...] triggers from text (e.g. [TIME: VALUE=130] or [TIME: VALUE=130, REF=130T]).
 */
function extractTimeTriggers(text, defaultRef = null) {
    if (!text || typeof text !== 'string') return [];
    const regex = /\[TIME:\s*([^\]]+)\]/gi;
    const triggers = [];
    const seen = new Set();
    let m;
    while ((m = regex.exec(text)) !== null) {
        const content = m[1];
        const valMatch = content.match(/\bVALUE\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
        if (!valMatch) continue;
        const refMatch = content.match(/\bREF\s*=\s*([^,\s\]]+)/i);
        const targetValue = parseFloat(valMatch[1]);
        const targetRef = refMatch ? cleanInstructionId(refMatch[1]) : (defaultRef ? cleanInstructionId(defaultRef) : null);
        const dedupeKey = `${targetValue}_${targetRef || ''}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        triggers.push({
            raw: m[0],
            targetValue,
            targetRef
        });
    }
    return triggers;
}

/**
 * Extracts duration in milliseconds from description if [RECORD: ... DURATION=... ] is present.
 * Units supported: s (seconds), m (minutes, default), h (hours).
 */
function extractRecordDurationMs(text) {
    if (!text || typeof text !== 'string') return 0;

    let durationMatch = null;
    const recordBlockMatch = text.match(/\[RECORD:\s*([^\]]+)\]/i);
    if (recordBlockMatch) {
        durationMatch = recordBlockMatch[1].match(/\bDURATION\s*=\s*([+-]?\d+(?:\.\d+)?)\s*(s(?:ec(?:onds?)?)?|m(?:in(?:utes?)?)?|h(?:(?:ou)?rs?)?)?\b/i);
    }

    if (!durationMatch) {
        durationMatch = text.match(/\[DURATION:\s*([+-]?\d+(?:\.\d+)?)\s*(s(?:ec(?:onds?)?)?|m(?:in(?:utes?)?)?|h(?:(?:ou)?rs?)?)?\b\]/i) ||
            text.match(/\bDURATION\s*=\s*([+-]?\d+(?:\.\d+)?)\s*(s(?:ec(?:onds?)?)?|m(?:in(?:utes?)?)?|h(?:(?:ou)?rs?)?)?\b/i);
    }

    if (!durationMatch) return 0;

    const val = parseFloat(durationMatch[1]);
    if (isNaN(val)) return 0;
    const unitStr = (durationMatch[2] || 'm').toLowerCase();

    if (unitStr.startsWith('s')) return Math.round(val * 1000);
    if (unitStr.startsWith('h')) return Math.round(val * 3600 * 1000);
    return Math.round(val * 60 * 1000); // default minutes
}

/**
 * Aggregates all possible description fields from instructions, steps, phases, and batch payloads.
 */
function getCombinedDescription(ctx) {
    const texts = [];
    if (ctx?.instructionDescription) texts.push(ctx.instructionDescription);

    const body = ctx?.rawBody || {};
    if (body.InstructionDescription) texts.push(body.InstructionDescription);
    if (body.Description) texts.push(body.Description);

    const data = body.Data || {};
    const batch = data.Batch || {};
    if (batch.BatchDescription) texts.push(batch.BatchDescription);
    if (batch.Description) texts.push(batch.Description);

    const phases = Array.isArray(batch.Phases) ? batch.Phases : (batch.Phase ? [batch.Phase] : []);
    for (const phase of phases) {
        if (phase.PhaseDescription) texts.push(phase.PhaseDescription);
        if (phase.Description) texts.push(phase.Description);
        const steps = Array.isArray(phase.Steps) ? phase.Steps : (phase.Step ? [phase.Step] : []);
        for (const step of steps) {
            if (step.StepDescription) texts.push(step.StepDescription);
            if (step.Description) texts.push(step.Description);
            const instructions = Array.isArray(step.Instructions) ? step.Instructions : (step.Instruction ? [step.Instruction] : []);
            for (const inst of instructions) {
                if (inst.InstructionDescription) texts.push(inst.InstructionDescription);
                if (inst.Description) texts.push(inst.Description);
                if (inst.InstructionId) texts.push(inst.InstructionId);
            }
        }
    }

    if (ctx?.instruction) {
        if (ctx.instruction.InstructionDescription) texts.push(ctx.instruction.InstructionDescription);
        if (ctx.instruction.Description) texts.push(ctx.instruction.Description);
        if (ctx.instruction.InstructionId) texts.push(ctx.instruction.InstructionId);
    }

    return texts.filter(t => typeof t === 'string' && t.trim()).join(' ');
}

// ✅
function extractInstructionPayload(body = {}) {
    const data = body.Data || {};
    const batch = data.Batch || {};
    const phase = batch.Phase || {};
    const step = phase.Step || {};
    const instruction = step.Instruction || {};

    return {
        topic: body.Topic || null,
        batchId: batch.BatchId || body.batch_id || body.batchid || null,
        rawEventType: instruction.EventType !== undefined ? instruction.EventType : body.EventType,
        instructionDescription: instruction.InstructionDescription || instruction.Description || body.InstructionDescription || body.Description || '',
        refElement: instruction.RefElement || body.RefElement || null,
        refTime: instruction.RefTime || body.RefTime || null,
        refInstruction: instruction.RefInstruction || body.RefInstruction || null,
        refRecipe: instruction.RefRecipe || body.RefRecipe || null,
        refEvent: instruction.RefEvent || body.RefEvent || null,
        refType: instruction.RefType || body.RefType || null,
        refStartTime: instruction.RefStartTime || body.RefStartTime || null,
        refEndTime: instruction.RefEndTime || body.RefEndTime || null,
        callbackKey: body.CallbackKey || instruction.CallbackKey || body.callbackkey || null,
        triggeredByEmail: instruction.TriggeredByEmail || body.TriggeredByEmail || null,
        rawBody: body,
        instruction
    };
}


// ===========================================================================
// BATCHLINE ERROR NOTIFICATION SENDER
// ===========================================================================

/**
 * Sends error notifications to BatchLine via POST /Notification/push
 * Header: x-api-key: <API_KEY>
 * Body: { batchid, message, callbackkey }
 */
// ✅
async function sendBatchLineNotification({ batchId, message, callbackKey }) {
    if (!message) return null;

    const notificationUrl = CONFIG.BATCHLINE_NOTIFICATION_URL;
    const apiKey = CONFIG.BATCHLINE_API_KEY;

    if (!apiKey) {
        console.warn('[BatchLine Notification Warning]: Missing BATCHLINE_API_KEY in environment variables');
        return null;
    }

    const payload = {
        batchid: batchId,
        message: String(message),
        callbackkey: callbackKey
    };

    try {
        const res = await fetch(notificationUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(CONFIG.HTTP_TIMEOUT_MS)
        });

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }

        if (!res.ok) {
            console.warn(`[BatchLine Notification Warning]: API returned status ${res.status}:`, data);
        } else {
            console.log('[BatchLine Notification]: Successfully pushed error notification to BatchLine');
        }

        return { ok: res.ok, status: res.status };
    } catch (err) {
        console.warn('[BatchLine Notification Error]: Failed to push notification:', err.message);
        return { ok: false, error: err.message };
    }
}

/**
 * Centralized error reporting function:
 * 1. Logs to console.error
 * 2. Asynchronously pushes notification to BatchLine
 */
// ✅
async function reportError(message, ctx = {}, extraDetail = null) {
    if (extraDetail !== null && extraDetail !== undefined) {
        console.error(message, extraDetail);
    } else {
        console.error(message);
    }

    const detailStr = extraDetail
        ? (typeof extraDetail === 'object' ? JSON.stringify(extraDetail) : String(extraDetail))
        : '';
    const fullMessage = detailStr ? `${message}: ${detailStr}` : message;

    await sendBatchLineNotification({
        batchId: ctx?.batchId || null,
        message: fullMessage,
        callbackKey: ctx?.callbackKey || null
    }).catch(err => {
        console.warn('[BatchLine Notification Dispatch Failure]:', err.message);
    });
}

// ===========================================================================
// DATA ACCESS LAYER (HIGH PERFORMANCE / INDEX-OPTIMIZED)
// ===========================================================================

/**
 * Resolves a tag record from refElement (e.g. "R1.TEMP" or "Reactor 1.TEMP").
 */
// ✅
async function resolveTag(refElement, ctx = null) {
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
        console.log("tag ID", rows[0].id);
        console.log("tag name", rows[0].name);
        return rows[0];
    }
    await reportError(`[Tag Resolution Error]: Tag not found for candidate "${tagCandidate}"`, ctx);
    return null;
}

/**
 * High-performance dual index-seek to fetch nearest reading to target timestamp.
 * Avoids full-table/chunk scans caused by ORDER BY ABS(EXTRACT(...)).
 */
// ✅
async function getNearestReading(tagId, refTime) {
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
 * Avoids table scans using bounded dual index-seeks.
 */
async function getReadingNearTimestamp(tagId, targetDate, toleranceMs) {
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
 * Finds the record time in historian nearest to targetValue of a tag after afterTime:
 * 1. Scans sequentially from afterTime to detect the first crossing/arrival across targetValue.
 *    If a crossing is found, returns the reading at the crossing closest to targetValue.
 * 2. If no crossing occurred (e.g. value never reached targetValue), fallbacks to the reading
 *    whose value came nearest to targetValue after afterTime.
 */
async function findRecordTimeNearestToValue(tagId, afterTime, targetValue) {
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

// ✅
async function findEventForBatch({ refRecipe, refEvent }) {
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

// ===========================================================================
// OUTBOUND BATCHLINE CLIENT (RESILIENT WITH EXPONENTIAL RETRY)
// ===========================================================================
// ✅
async function sendBatchLineInstructionUpdate({ refInstruction, batchId, actualResult, callbackKey, maxRetries = 2 }) {
    if (!refInstruction || !batchId || !actualResult) return null;

    const baseUrl = CONFIG.BATCHLINE_BASE_URL;
    const callbackUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1/batch/instruction/update/${encodeURIComponent(refInstruction)}`;
    const apiKey = CONFIG.BATCHLINE_API_KEY;

    if (!apiKey) {
        await reportError('[BatchLine Callback Error]: Missing BATCHLINE_API_KEY in environment variables', { batchId, callbackKey });
        return { targetUrl: callbackUrl, error: 'Missing BATCHLINE_API_KEY' };
    }

    const normalizedActualResult = Array.isArray(actualResult)
        ? actualResult
        : [
            typeof actualResult === 'object' && actualResult !== null
                ? actualResult
                : { repeat_no: 1, value: String(actualResult), executed_user_email: null }
        ];

    const payload = {
        batch_id: batchId,
        actual_result: normalizedActualResult
    };

    let attempt = 0;
    while (attempt <= maxRetries) {
        try {
            const cbRes = await fetch(callbackUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(CONFIG.HTTP_TIMEOUT_MS)
            });

            const cbText = await cbRes.text();
            let cbData;
            try { cbData = JSON.parse(cbText); } catch { cbData = cbText; }

            if (cbRes.ok) {
                console.log("Instruction updated successfully")
                console.log("The Number of Actual result sent to Batchline: ", cbData.actual_result.length)
            }

            if (cbRes.status >= 500 && attempt < maxRetries) {
                attempt++;
                console.warn(`[BatchLine Callback Warning]: Server error ${cbRes.status}. Retrying attempt ${attempt}/${maxRetries}...`);
                await sleep(500 * Math.pow(2, attempt));
                continue;
            }

            return {
                targetUrl: callbackUrl,
                status: cbRes.status,
                ok: cbRes.ok,
                data: cbData
            };
        } catch (cbErr) {
            if (attempt < maxRetries) {
                attempt++;
                console.warn(`[BatchLine Callback Warning]: Network error (${cbErr.message}). Retrying attempt ${attempt}/${maxRetries}...`);
                await sleep(500 * Math.pow(2, attempt));
                continue;
            }
            await reportError(`[BatchLine Callback Error]: ${cbErr.message}`, { batchId, callbackKey });
            return {
                targetUrl: callbackUrl,
                error: cbErr.message
            };
        }
    }
}

// ===========================================================================
// CASE HANDLERS (SEPARATION OF CONCERNS)
// ===========================================================================

/**
 * Case 1: Point-in-time value lookup
 */
// ✅
async function handleCase1PointInTime(ctx, res) {
    if (!ctx.refElement) {
        await reportError('[BatchLine Case 1]: Missing required RefElement in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefElement in instruction payload' });
    }

    const tag = await resolveTag(ctx.refElement, ctx);
    if (!tag) {
        await reportError(`[BatchLine Case 1]: Could not resolve tag for RefElement: "${ctx.refElement}"`, ctx);
        return res.status(404).json({ error: `Could not resolve tag for RefElement: "${ctx.refElement}"` });
    }

    // Check for trigger wording in description: [TIME: VALUE=130] (or [TIME: VALUE=..., REF=...])
    const fullDesc = getCombinedDescription(ctx);
    const triggers = extractTimeTriggers(fullDesc, ctx.refInstruction);
    const durationMs = extractRecordDurationMs(fullDesc);

    let baseRefTime = null;
    let effectiveRefTime = null;
    if (ctx.refTime) {
        baseRefTime = parseBatchLineDate(ctx.refTime) || new Date(ctx.refTime);
        if (!isNaN(baseRefTime.getTime())) {
            effectiveRefTime = new Date(baseRefTime.getTime() + durationMs);
            if (durationMs !== 0) {
                console.log(`[BatchLine Case 1]: Applied [RECORD: DURATION] offset of ${durationMs}ms (${durationMs / 60000}m). Base RefTime: ${baseRefTime.toISOString()} -> Actual RefTime: ${effectiveRefTime.toISOString()}`);
            }
        }
    }

    if (triggers.length > 0) {
        if (!ctx.refTime) {
            await reportError('[BatchLine Case 1]: Missing required RefTime in instruction payload for time trigger', ctx);
            return res.status(400).json({ error: 'Missing required RefTime in instruction payload for time trigger' });
        }

        if (!effectiveRefTime || isNaN(effectiveRefTime.getTime())) {
            await reportError(`[BatchLine Case 1]: Invalid RefTime date format: "${ctx.refTime}"`, ctx);
            return res.status(400).json({ error: `Invalid RefTime date format: "${ctx.refTime}"` });
        }

        const afterTime = effectiveRefTime;

        console.log(`[BatchLine Case 1]: Processing ${triggers.length} time trigger(s) for tag "${tag.name}" after actual RefTime (${afterTime.toISOString()})...`);

        const triggerResults = [];
        for (const trigger of triggers) {
            const targetRef = trigger.targetRef || ctx.refInstruction;
            if (!targetRef) {
                await reportError('[BatchLine Case 1]: Missing target RefInstruction for time trigger update', ctx);
                continue;
            }

            console.log(`[BatchLine Case 1]: Finding record time nearest to ${trigger.targetValue} for tag "${tag.name}" after ${afterTime.toISOString()}...`);
            const reading = await findRecordTimeNearestToValue(tag.id, afterTime, trigger.targetValue);

            if (!reading) {
                const errMsg = `No reading found for tag "${tag.name}" after ${afterTime.toISOString()} near value ${trigger.targetValue}`;
                await reportError(`[BatchLine Case 1]: ${errMsg}`, ctx);
                return res.status(404).json({ error: errMsg });
            }

            const formattedTime = formatBatchLineDate(reading.ts);
            const executedTimestamp = formatExecutedTimestamp(reading.ts);

            console.log(`[BatchLine Case 1]: Nearest reading found at ${reading.ts} (value: ${reading.value}, formatted: "${formattedTime}"). Recording back to ${targetRef}...`);

            const callbackResult = await sendBatchLineInstructionUpdate({
                refInstruction: targetRef,
                batchId: ctx.batchId,
                callbackKey: ctx.callbackKey,
                actualResult: [
                    {
                        repeat_no: 1,
                        value: formattedTime,
                        executed_timestamp: executedTimestamp,
                        executed_user_email: ctx.triggeredByEmail
                    }
                ]
            });

            if (callbackResult?.ok) {
                console.log(`[BatchLine Case 1]: Successfully updated instruction ${targetRef} with record time "${formattedTime}"`);
            } else {
                await reportError(`[BatchLine Case 1]: Failed to update instruction ${targetRef}`, ctx, callbackResult?.data?.error?.detail || callbackResult?.error);
            }

            triggerResults.push({
                target_value: trigger.targetValue,
                target_ref: targetRef,
                found_ts: reading.ts,
                reading_value: reading.value,
                formatted_time: formattedTime,
                executed_timestamp: executedTimestamp,
                quality: reading.quality,
                callback: callbackResult
            });
        }

        if (triggerResults.length === 1) {
            const single = triggerResults[0];
            return res.json({
                status: 'success',
                case: 1,
                subcase: 'time_trigger',
                batch_id: ctx.batchId,
                tag: tag.name,
                target_value: single.target_value,
                target_instruction: single.target_ref,
                ref_time: ctx.refTime,
                actual_ref_time: afterTime.toISOString(),
                duration_offset_ms: durationMs,
                reading: {
                    ts: single.found_ts,
                    raw_value: single.reading_value,
                    formatted_value: formatReadingValue(single.reading_value, tag.display_digits),
                    formatted_time: single.formatted_time,
                    executed_timestamp: single.executed_timestamp,
                    quality: single.quality
                },
                callback: single.callback
            });
        }

        return res.json({
            status: 'success',
            case: 1,
            subcase: 'time_trigger',
            batch_id: ctx.batchId,
            tag: tag.name,
            ref_time: ctx.refTime,
            actual_ref_time: afterTime.toISOString(),
            duration_offset_ms: durationMs,
            triggers_processed: triggerResults.length,
            results: triggerResults
        });
    }

    // Default Case 1: Point-in-time value lookup
    const targetLookupTime = effectiveRefTime || ctx.refTime;
    const reading = await getNearestReading(tag.id, targetLookupTime);
    if (!reading) {
        await reportError(`[BatchLine Case 1]: No reading or snapshot found for tag "${tag.name}"`, ctx);
        return res.status(404).json({ error: `No reading or snapshot found for tag "${tag.name}"` });
    }

    const formattedValue = formatReadingValue(reading.value, tag.display_digits);
    const executedTimestamp = formatExecutedTimestamp(reading.ts);

    const callbackResult = await sendBatchLineInstructionUpdate({
        refInstruction: ctx.refInstruction,
        batchId: ctx.batchId,
        callbackKey: ctx.callbackKey,
        actualResult: [
            {
                repeat_no: 1,
                value: formattedValue,
                executed_timestamp: executedTimestamp,
                executed_user_email: ctx.triggeredByEmail
            }
        ]
    });

    if (callbackResult?.ok) {
        console.log(`[BatchLine Case 1]: Successfully updated instruction for tag ${tag.name}`);
    } else {
        await reportError('[BatchLine Case 1]: Failed to update instruction', ctx, callbackResult?.data.error.detail);
    }

    return res.json({
        status: 'success',
        case: 1,
        batch_id: ctx.batchId,
        tag: tag.name,
        ref_time: ctx.refTime,
        actual_ref_time: effectiveRefTime ? effectiveRefTime.toISOString() : null,
        duration_offset_ms: durationMs,
        reading: {
            ts: reading.ts,
            raw_value: reading.value,
            formatted_value: formattedValue,
            executed_timestamp: executedTimestamp,
            quality: reading.quality
        },
        callback: callbackResult
    });
}

/**
 * Case 2: Start time / End time phase lookup
 */
// ✅
async function handleCase2PhaseTimestamp(ctx, res) {
    const recipeBatchId = ctx.refRecipe || ctx.batchId;
    if (!recipeBatchId) {
        await reportError('[BatchLine Case 2]: Missing required RefRecipe in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefRecipe in instruction payload' });
    }
    if (!ctx.refEvent) {
        await reportError('[BatchLine Case 2]: Missing required RefEvent in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefEvent in instruction payload' });
    }
    if (!ctx.refType) {
        await reportError('[BatchLine Case 2]: Missing required RefType in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefType in instruction payload' });
    }

    const normalizedType = String(ctx.refType).trim().toLowerCase();
    const isStart = /^(starttime|started_at|start)$/i.test(normalizedType);
    const isEnd = /^(endtime|ended_at|end)$/i.test(normalizedType);

    if (!isStart && !isEnd) {
        await reportError(`[BatchLine Case 2]: Invalid RefType: "${ctx.refType}". Expected "StartTime" or "EndTime"`, ctx);
        return res.status(400).json({
            error: `Invalid RefType: "${ctx.refType}". Expected "StartTime" or "EndTime"`
        });
    }

    // In Case 2, RefElement is always null (not considered)
    const event = await findEventForBatch({
        refRecipe: recipeBatchId,
        refEvent: ctx.refEvent
    });

    if (!event) {
        await reportError(`[BatchLine Case 2]: Could not find phase/event "${ctx.refEvent}" for batch "${recipeBatchId}"`, ctx);
        return res.status(404).json({
            error: `Could not find phase/event "${ctx.refEvent}" for batch "${recipeBatchId}"`
        });
    }

    const selectedField = isStart ? 'started_at' : 'ended_at';
    const targetTime = isStart ? event.started_at : event.ended_at;

    if (!targetTime) {
        await reportError(`[BatchLine Case 2]: Phase "${event.name}" for batch "${recipeBatchId}" has no ${selectedField} yet`, ctx);
        return res.status(400).json({
            error: `Phase "${event.name}" for batch "${recipeBatchId}" has no ${selectedField} yet (phase may still be in progress)`,
            event: {
                id: event.id,
                name: event.name,
                level: event.level,
                asset: event.asset_code,
                started_at: event.started_at,
                ended_at: event.ended_at
            }
        });
    }

    const formattedTime = formatBatchLineDate(targetTime);

    const callbackResult = await sendBatchLineInstructionUpdate({
        refInstruction: ctx.refInstruction,
        batchId: ctx.batchId,
        callbackKey: ctx.callbackKey,
        actualResult: [
            {
                repeat_no: 1,
                value: formattedTime,
                executed_user_email: ctx.triggeredByEmail
            }
        ]
    });

    if (callbackResult?.ok) {
        console.log(`[BatchLine Case 2]: Successfully updated phase time for ${event.name}`);
    } else {
        await reportError('[BatchLine Case 2]: Failed to update phase time', ctx, callbackResult?.data || callbackResult?.error);
    }

    return res.json({
        status: 'success',
        case: 2,
        batch_id: ctx.batchId,
        ref_recipe: recipeBatchId,
        ref_event: ctx.refEvent,
        ref_type: ctx.refType,
        event: {
            id: event.id,
            name: event.name,
            level: event.level,
            asset: event.asset_code,
            started_at: event.started_at,
            ended_at: event.ended_at,
            selected_field: selectedField,
            selected_time: targetTime,
            formatted_value: formattedTime
        },
        callback: callbackResult
    });
}

/**
 * Resolves aggregation metric from RefType
 */
// ✅
function resolveMetric(refType) {
    if (!refType) return 'avg';
    const rUpper = String(refType).trim().toUpperCase();
    if (rUpper === 'MIN' || rUpper === 'MINIMUM') return 'min';
    if (rUpper === 'MAX' || rUpper === 'MAXIMUM') return 'max';
    if (rUpper === 'SUM') return 'sum';
    if (rUpper === 'FIRST') return 'first';
    if (rUpper === 'LAST') return 'last';
    return 'avg';
}

/**
 * Computes single aggregated metric value from an array of numbers
 */
// ✅
function computeMetricValue(vals, metric) {
    if (!vals || vals.length === 0) return 0;
    if (metric === 'min') return Math.min(...vals);
    if (metric === 'max') return Math.max(...vals);
    if (metric === 'sum') return vals.reduce((acc, v) => acc + v, 0);
    if (metric === 'first') return vals[0];
    if (metric === 'last') return vals[vals.length - 1];
    return vals.reduce((acc, v) => acc + v, 0) / vals.length;
}

/**
 * Resolves start/stop directions and whether the waveform represents an envelope/pulse
 * (e.g. rising above threshold, staying high, then falling back below threshold).
 */
function resolveWaveDirections(startThreshold, stopThreshold, userDirection = null, initialVal = null) {
    let startDirection = userDirection ? String(userDirection).trim().toLowerCase() : null;
    if (!startDirection) {
        if (stopThreshold !== null && stopThreshold !== startThreshold) {
            startDirection = (stopThreshold > startThreshold) ? 'rise' : 'fall';
        } else if (initialVal !== null) {
            startDirection = (initialVal <= startThreshold) ? 'rise' : 'fall';
        } else {
            startDirection = 'rise';
        }
    }

    const isFall = (startDirection === 'fall' || startDirection === 'down');
    const effectiveStartDirection = isFall ? 'fall' : 'rise';

    let stopDirection = null;
    let isEnvelope = false;

    if (stopThreshold !== null) {
        if (stopThreshold === startThreshold) {
            // Equal thresholds: envelope / pulse wave (stop when returning across the same threshold)
            stopDirection = isFall ? 'rise' : 'fall';
            isEnvelope = true;
        } else if (isFall) {
            // Starting with a fall: if stopThreshold > startThreshold, it's recovering upward (dip/valley envelope)
            stopDirection = (stopThreshold > startThreshold) ? 'rise' : 'fall';
            isEnvelope = (stopThreshold > startThreshold);
        } else {
            // Starting with a rise: if stopThreshold < startThreshold, it's falling back down (peak envelope with hysteresis)
            stopDirection = (stopThreshold < startThreshold) ? 'fall' : 'rise';
            isEnvelope = (stopThreshold < startThreshold);
        }
    }

    return {
        startDirection: effectiveStartDirection,
        stopDirection,
        isFall,
        isEnvelope
    };
}

/**
 * Consolidates readings within a window into intervals of intervalMs,
 * aggregating each interval's readings using the specified metric (min, max, avg, sum, first, last).
 */
// ✅
function buildIntervalConsolidatedValues(rows, windowStart, windowEnd, intervalMs, metric, displayDigits, fallbackVal = 0) {
    const startMs = windowStart.getTime();
    const endMs = windowEnd.getTime();
    const windowDurationMs = Math.max(0, endMs - startMs);

    // Rule: Window < Interval or Zero duration -> single point
    if (windowDurationMs < intervalMs || startMs === endMs) {
        let singleVal = fallbackVal;
        if (rows && rows.length > 0) {
            singleVal = computeMetricValue(rows.map(r => Number(r.value)), metric);
        }
        return [{
            repeat_no: 1,
            value: formatReadingValue(singleVal, displayDigits),
            raw_value: singleVal,
            bucket_start: windowStart.toISOString(),
            bucket_end: windowEnd.toISOString(),
            samples: rows ? rows.length : 0,
            executed_timestamp: formatExecutedTimestamp(windowStart)
        }];
    }

    let intervalCount = Math.max(1, Math.ceil(windowDurationMs / intervalMs));
    const maxAllowed = CONFIG.MAX_PROFILE_SAMPLES || CONFIG.MAX_PERIODIC_REPEATS || 50;
    if (intervalCount > maxAllowed) {
        intervalCount = maxAllowed;
    }

    let lastKnown = (rows && rows.length > 0) ? Number(rows[0].value) : ((fallbackVal !== null && fallbackVal !== undefined) ? Number(fallbackVal) : 0);

    const values = [];

    for (let i = 0; i < intervalCount; i++) {
        const bStartMs = startMs + i * intervalMs;
        const bEndMs = Math.min(startMs + (i + 1) * intervalMs, endMs);
        const bStart = new Date(bStartMs);
        const bEnd = new Date(bEndMs);

        const isLast = (i === intervalCount - 1);
        const bucketVals = [];

        if (rows && rows.length > 0) {
            for (let j = 0; j < rows.length; j++) {
                const rTs = new Date(rows[j].ts).getTime();
                if (rTs >= bStartMs && (isLast ? (rTs <= bEndMs) : (rTs < bEndMs))) {
                    const val = Number(rows[j].value);
                    if (!Number.isNaN(val)) bucketVals.push(val);
                }
            }
        }

        let resolvedVal;
        if (bucketVals.length > 0) {
            resolvedVal = computeMetricValue(bucketVals, metric);
            lastKnown = resolvedVal;
        } else {
            resolvedVal = lastKnown;
        }

        values.push({
            repeat_no: i + 1,
            value: formatReadingValue(resolvedVal, displayDigits),
            raw_value: resolvedVal,
            bucket_start: bStart.toISOString(),
            bucket_end: bEnd.toISOString(),
            samples: bucketVals.length,
            executed_timestamp: formatExecutedTimestamp(bStart)
        });
    }

    return values;
}

/**
 * Case 3 - Submode: Profile Wave Detection & Downsampling
 */
// ✅
async function handleProfileMode(ctx, res, tag, actualStart, actualEnd, profileConfig, intervalConfig = null) {
    const startThreshold = profileConfig.start;
    const stopThreshold = profileConfig.stop;

    const { rows } = await query(`
        SELECT ts, value
        FROM readings
        WHERE tag_id = $1
          AND ts >= $2::timestamptz
          AND ts <= $3::timestamptz
        ORDER BY ts ASC;
    `, [tag.id, actualStart, actualEnd]);

    if (rows.length === 0) {
        const errMsg = `No readings found for tag "${tag.name}" between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`;
        await reportError(`[BatchLine Profile]: ${errMsg}`, ctx);
        return res.status(404).json({ error: errMsg });
    }

    // Direction resolution
    const firstValidRow = rows.find(r => r.value !== null && r.value !== undefined && !Number.isNaN(Number(r.value)));
    const firstVal = firstValidRow ? Number(firstValidRow.value) : null;

    const { startDirection, stopDirection, isFall, isEnvelope } = resolveWaveDirections(
        startThreshold,
        stopThreshold,
        profileConfig.direction,
        firstVal
    );

    let armed = false;
    let waveStartTs = null;
    let waveStopTs = null;

    if (firstVal !== null) {
        if (isFall && firstVal >= startThreshold) armed = true;
        if (!isFall && firstVal <= startThreshold) armed = true;
    }

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.value === null || r.value === undefined) continue;
        const val = Number(r.value);
        if (Number.isNaN(val)) continue;

        if (!armed) {
            if (isFall && val >= startThreshold) armed = true;
            if (!isFall && val <= startThreshold) armed = true;
        }

        if (armed && !waveStartTs) {
            let reachedStart = false;
            if (i === 0) {
                reachedStart = isFall ? (val <= startThreshold) : (val >= startThreshold);
            } else {
                const prevVal = Number(rows[i - 1].value);
                reachedStart = isFall ? (val <= startThreshold && prevVal >= startThreshold)
                    : (val >= startThreshold && prevVal <= startThreshold);
            }

            if (reachedStart) waveStartTs = r.ts;
        } else if (waveStartTs && !waveStopTs) {
            if (profileConfig.durationMinutes !== null && profileConfig.durationMinutes > 0) {
                const durationMs = profileConfig.durationMinutes * 60 * 1000;
                if (new Date(r.ts).getTime() - new Date(waveStartTs).getTime() >= durationMs) {
                    waveStopTs = r.ts;
                    break;
                }
            } else if (stopThreshold !== null) {
                const isAfterStart = (new Date(r.ts).getTime() > new Date(waveStartTs).getTime());
                const reachedStop = (stopDirection === 'rise') ? (val >= stopThreshold) : (val <= stopThreshold);
                if (reachedStop && isAfterStart) {
                    waveStopTs = r.ts;
                    break;
                }

                // If wave aborted back past startThreshold before stop: reset (only for monotonic ramps!)
                if (!isEnvelope) {
                    const aborted = isFall ? (val > startThreshold) : (val < startThreshold);
                    if (aborted) {
                        waveStartTs = null;
                        armed = false;
                    }
                }
            }
        }
    }

    // Fallback search if waveStart not armed
    if (!waveStartTs) {
        for (const r of rows) {
            if (r.value === null || r.value === undefined) continue;
            const val = Number(r.value);
            if (Number.isNaN(val)) continue;
            if (isFall ? (val <= startThreshold) : (val >= startThreshold)) {
                waveStartTs = r.ts;
                break;
            }
        }
    }

    if (!waveStartTs) {
        const errMsg = `Reading value for tag "${tag.name}" never ${startDirection === 'rise' ? 'rose to or above' : 'fell to or below'} START threshold (${startThreshold}) between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`;
        await reportError(`[BatchLine Profile]: ${errMsg}`, ctx);
        return res.status(404).json({ error: errMsg });
    }

    if (!waveStopTs) {
        if (profileConfig.durationMinutes !== null && profileConfig.durationMinutes > 0) {
            const targetStop = new Date(new Date(waveStartTs).getTime() + profileConfig.durationMinutes * 60 * 1000);
            const lastTs = new Date(rows[rows.length - 1].ts);
            waveStopTs = (targetStop < lastTs) ? targetStop.toISOString() : lastTs.toISOString();
        } else {
            waveStopTs = rows[rows.length - 1].ts;
        }
    }

    const waveStart = new Date(waveStartTs);
    const waveStop = new Date(waveStopTs);

    const waveRows = rows.filter(r => {
        if (r.value === null || r.value === undefined || Number.isNaN(Number(r.value))) return false;
        const t = new Date(r.ts).getTime();
        return t >= waveStart.getTime() && t <= waveStop.getTime();
    });

    const totalCount = waveRows.length;
    if (totalCount === 0) {
        const errMsg = `No readings found for tag "${tag.name}" in the captured wave between ${waveStart.toISOString()} and ${waveStop.toISOString()}`;
        await reportError(`[BatchLine Profile]: ${errMsg}`, ctx);
        return res.status(404).json({ error: errMsg });
    }

    let valuesToSend = [];
    const durationMs = waveStop.getTime() - waveStart.getTime();

    if (intervalConfig && intervalConfig.intervalMs) {
        valuesToSend = buildIntervalConsolidatedValues(
            waveRows,
            waveStart,
            waveStop,
            intervalConfig.intervalMs,
            profileConfig.metric || 'avg',
            tag.display_digits,
            startThreshold
        );
    } else if (totalCount <= CONFIG.MAX_PROFILE_SAMPLES || durationMs <= 1000) {
        valuesToSend = waveRows.slice(0, CONFIG.MAX_PROFILE_SAMPLES).map((r, idx) => ({
            repeat_no: idx + 1,
            value: formatReadingValue(r.value, tag.display_digits),
            raw_value: r.value,
            ts: r.ts,
            executed_timestamp: formatExecutedTimestamp(r.ts)
        }));
    } else {
        const sampleCount = CONFIG.MAX_PROFILE_SAMPLES || 30;
        const lastBucketIndex = sampleCount - 1;

        const { rows: bucketRows } = await query(`
            WITH bounds AS (
                SELECT $2::timestamptz AS t_start, $3::timestamptz AS t_end
            ),
            buckets AS (
                SELECT 
                    i AS bucket_no,
                    t_start + (i * (t_end - t_start) / $4) AS b_start,
                    t_start + ((i + 1) * (t_end - t_start) / $4) AS b_end
                FROM bounds, generate_series(0, $5) AS i
            )
            SELECT 
                b.bucket_no,
                b.b_start,
                b.b_end,
                AVG(r.value) AS avg_val,
                MIN(r.value) AS min_val,
                MAX(r.value) AS max_val,
                COUNT(r.value)::int AS samples
            FROM buckets b
            LEFT JOIN readings r 
              ON r.tag_id = $1 
             AND r.ts >= b.b_start 
             AND (CASE WHEN b.bucket_no = $5 THEN r.ts <= b.b_end ELSE r.ts < b.b_end END)
            GROUP BY b.bucket_no, b.b_start, b.b_end
            ORDER BY b.bucket_no;
        `, [tag.id, waveStart, waveStop, sampleCount, lastBucketIndex]);

        let lastKnown = null;
        const bucketList = bucketRows.map(r => {
            let metricVal = null;
            if (profileConfig.metric === 'min') metricVal = r.min_val;
            else if (profileConfig.metric === 'max') metricVal = r.max_val;
            else metricVal = r.avg_val;

            if (metricVal !== null && metricVal !== undefined) {
                lastKnown = Number(metricVal);
            }
            return {
                bucket_no: r.bucket_no,
                b_start: r.b_start,
                b_end: r.b_end,
                value: (metricVal !== null && metricVal !== undefined) ? Number(metricVal) : lastKnown,
                samples: r.samples
            };
        });

        const firstKnown = bucketList.find(b => b.value !== null)?.value ?? startThreshold;
        valuesToSend = bucketList.map((b, idx) => {
            const resolvedVal = b.value !== null ? b.value : firstKnown;
            return {
                repeat_no: idx + 1,
                value: formatReadingValue(resolvedVal, tag.display_digits),
                raw_value: resolvedVal,
                bucket_start: b.b_start,
                bucket_end: b.b_end,
                samples: b.samples,
                executed_timestamp: formatExecutedTimestamp(b.b_start)
            };
        });
    }

    console.log(`[BatchLine Profile]: Pushing ${valuesToSend.length} values for captured first wave...`);
    const actualResult = valuesToSend.map((item, idx) => ({
        repeat_no: item.repeat_no || (idx + 1),
        value: item.value,
        executed_timestamp: item.executed_timestamp || formatExecutedTimestamp(item.bucket_start || item.ts),
        executed_user_email: ctx.triggeredByEmail || null
    }));

    const cbResult = await sendBatchLineInstructionUpdate({
        refInstruction: ctx.refInstruction,
        batchId: ctx.batchId,
        callbackKey: ctx.callbackKey,
        actualResult
    });

    if (!cbResult?.ok) {
        await reportError(`Failed to update BatchLine Case 3 profile (${valuesToSend.length} items)`, ctx, cbResult?.data?.error?.detail || cbResult?.error);
    }

    return res.json({
        status: 'success',
        case: 3,
        mode: 'record_profile',
        batch_id: ctx.batchId,
        tag: tag.name,
        metric: (profileConfig.metric || 'avg').toUpperCase(),
        ref_type: ctx.refType,
        start_threshold: startThreshold,
        stop_threshold: profileConfig.stop ?? null,
        duration_minutes: profileConfig.durationMinutes ?? null,
        direction: startDirection,
        interval: intervalConfig ? intervalConfig.rawInterval : null,
        interval_minutes: intervalConfig ? intervalConfig.intervalMinutes : null,
        wave_start: waveStart.toISOString(),
        wave_stop: waveStop.toISOString(),
        wave_duration_sec: Math.max(1, (waveStop - waveStart) / 1000),
        total_samples: totalCount,
        records_sent: valuesToSend.length,
        records: valuesToSend,
        callback: cbResult,
        callbacks: cbResult ? [cbResult] : []
    });
}

/**
 * Case 3 - Submode: Uniform Range Recording (Record Mode)
 */
// ✅
async function handleRecordMode(ctx, res, tag, actualStart, actualEnd, intervalConfig = null) {
    let metric = resolveMetric(ctx.refType);

    const { rows: allRows } = await query(`
        SELECT ts, value
        FROM readings
        WHERE tag_id = $1
          AND ts >= $2::timestamptz
          AND ts <= $3::timestamptz
        ORDER BY ts ASC;
    `, [tag.id, actualStart, actualEnd]);

    if (allRows.length === 0) {
        const errMsg = `No readings found for tag "${tag.name}" between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`;
        await reportError(`[BatchLine Record]: ${errMsg}`, ctx);
        return res.status(404).json({ error: errMsg });
    }

    const totalCount = allRows.length;
    let valuesToSend = [];
    const durationMs = actualEnd.getTime() - actualStart.getTime();

    if (intervalConfig && intervalConfig.intervalMs) {
        valuesToSend = buildIntervalConsolidatedValues(
            allRows,
            actualStart,
            actualEnd,
            intervalConfig.intervalMs,
            metric,
            tag.display_digits,
            allRows[0]?.value ?? 0
        );
    } else if (totalCount <= CONFIG.MAX_PROFILE_SAMPLES || durationMs <= 1000) {
        valuesToSend = allRows.slice(0, CONFIG.MAX_PROFILE_SAMPLES).map((r, idx) => ({
            repeat_no: idx + 1,
            value: formatReadingValue(r.value, tag.display_digits),
            raw_value: r.value,
            ts: r.ts,
            executed_timestamp: formatExecutedTimestamp(r.ts)
        }));
    } else {
        const sampleCount = CONFIG.MAX_PROFILE_SAMPLES || 30;
        const lastBucketIndex = sampleCount - 1;

        const { rows: bucketRows } = await query(`
            WITH bounds AS (
                SELECT $2::timestamptz AS t_start, $3::timestamptz AS t_end
            ),
            buckets AS (
                SELECT 
                    i AS bucket_no,
                    t_start + (i * (t_end - t_start) / $4) AS b_start,
                    t_start + ((i + 1) * (t_end - t_start) / $4) AS b_end
                FROM bounds, generate_series(0, $5) AS i
            )
            SELECT 
                b.bucket_no,
                b.b_start,
                b.b_end,
                AVG(r.value) AS avg_val,
                MIN(r.value) AS min_val,
                MAX(r.value) AS max_val,
                COUNT(r.value)::int AS samples
            FROM buckets b
            LEFT JOIN readings r 
              ON r.tag_id = $1 
             AND r.ts >= b.b_start 
             AND (CASE WHEN b.bucket_no = $5 THEN r.ts <= b.b_end ELSE r.ts < b.b_end END)
            GROUP BY b.bucket_no, b.b_start, b.b_end
            ORDER BY b.bucket_no;
        `, [tag.id, actualStart, actualEnd, sampleCount, lastBucketIndex]);

        let lastKnown = null;
        const bucketList = bucketRows.map(r => {
            let metricVal = null;
            if (metric === 'min') metricVal = r.min_val;
            else if (metric === 'max') metricVal = r.max_val;
            else metricVal = r.avg_val;

            if (metricVal !== null && metricVal !== undefined) {
                lastKnown = Number(metricVal);
            }
            return {
                bucket_no: r.bucket_no,
                b_start: r.b_start,
                b_end: r.b_end,
                value: (metricVal !== null && metricVal !== undefined) ? Number(metricVal) : lastKnown,
                samples: r.samples
            };
        });

        const firstKnown = bucketList.find(b => b.value !== null)?.value ?? 0;
        valuesToSend = bucketList.map((b, idx) => {
            const resolvedVal = b.value !== null ? b.value : firstKnown;
            return {
                repeat_no: idx + 1,
                value: formatReadingValue(resolvedVal, tag.display_digits),
                raw_value: resolvedVal,
                bucket_start: b.b_start,
                bucket_end: b.b_end,
                samples: b.samples,
                executed_timestamp: formatExecutedTimestamp(b.b_start)
            };
        });
    }

    console.log(`[BatchLine Record]: Pushing ${valuesToSend.length} consolidated values for tag ${tag.name}...`);
    const actualResult = valuesToSend.map((item, idx) => ({
        repeat_no: item.repeat_no || (idx + 1),
        value: item.value,
        executed_timestamp: item.executed_timestamp || formatExecutedTimestamp(item.ts || item.bucket_start),
        executed_user_email: ctx.triggeredByEmail || null
    }));

    const cbResult = await sendBatchLineInstructionUpdate({
        refInstruction: ctx.refInstruction,
        batchId: ctx.batchId,
        callbackKey: ctx.callbackKey,
        actualResult
    });

    if (!cbResult?.ok) {
        await reportError(`Failed to update BatchLine Case 3 record (${valuesToSend.length} items)`, ctx, cbResult?.data?.error?.detail || cbResult?.error);
    }

    return res.json({
        status: 'success',
        case: 3,
        mode: 'record',
        batch_id: ctx.batchId,
        tag: tag.name,
        metric: metric.toUpperCase(),
        ref_type: ctx.refType,
        ref_start_time: ctx.refStartTime,
        ref_end_time: ctx.refEndTime,
        interval: intervalConfig ? intervalConfig.rawInterval : null,
        interval_minutes: intervalConfig ? intervalConfig.intervalMinutes : null,
        total_samples: totalCount,
        records_sent: valuesToSend.length,
        records: valuesToSend,
        callback: cbResult,
        callbacks: cbResult ? [cbResult] : []
    });
}

/**
 * Case 3 - Submode: Standard Statistical / Aggregate Calculations
 */
// ✅
async function handleAggregateMode(ctx, res, tag, actualStart, actualEnd, statField) {
    const { rows } = await query(`
        SELECT 
            COUNT(*)::int AS sample_count,
            MIN(r.value) AS min,
            MAX(r.value) AS max,
            AVG(r.value) AS avg,
            SUM(r.value) AS sum,
            STDDEV(r.value) AS stddev,
            VARIANCE(r.value) AS variance,
            (MAX(r.value) - MIN(r.value)) AS range,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.value) AS median,
            first(r.value, r.ts) AS first,
            last(r.value, r.ts) AS last,
            (last(r.value, r.ts) - first(r.value, r.ts)) AS diff
        FROM readings r
        WHERE r.tag_id = $1
          AND r.ts >= $2::timestamptz
          AND r.ts <= $3::timestamptz;
    `, [tag.id, actualStart, actualEnd]);

    const stats = rows[0] || {};
    if (!stats.sample_count || Number(stats.sample_count) === 0) {
        const errMsg = `No readings found for tag "${tag.name}" between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`;
        await reportError(`[BatchLine Aggregate]: ${errMsg}`, ctx);
        return res.status(404).json({ error: errMsg });
    }

    let rawResult = stats[statField];
    if (rawResult === null || rawResult === undefined) {
        if (statField === 'stddev' || statField === 'variance') {
            rawResult = 0;
        } else {
            const errMsg = `Unable to compute "${ctx.refType}" for tag "${tag.name}" in the specified time range.`;
            await reportError(`[BatchLine Aggregate]: ${errMsg}`, ctx);
            return res.status(404).json({ error: errMsg });
        }
    }

    const formattedValue = (statField === 'sample_count')
        ? String(rawResult)
        : formatReadingValue(rawResult, tag.display_digits);

    const callbackResult = await sendBatchLineInstructionUpdate({
        refInstruction: ctx.refInstruction,
        batchId: ctx.batchId,
        callbackKey: ctx.callbackKey,
        actualResult: [
            {
                repeat_no: 1,
                value: formattedValue,
                executed_user_email: ctx.triggeredByEmail
            }
        ]
    });

    if (callbackResult?.ok) {
        console.log(`[BatchLine Aggregate]: Successfully updated ${statField} for tag ${tag.name}`);
    } else {
        await reportError('[BatchLine Aggregate]: Failed to update instruction', ctx, callbackResult?.data || callbackResult?.error);
    }

    return res.json({
        status: 'success',
        case: 3,
        batch_id: ctx.batchId,
        tag: tag.name,
        ref_type: ctx.refType,
        operation: statField,
        ref_start_time: ctx.refStartTime,
        ref_end_time: ctx.refEndTime,
        sample_count: stats.sample_count,
        raw_value: rawResult,
        formatted_value: formattedValue,
        statistics: {
            min: stats.min,
            max: stats.max,
            avg: stats.avg,
            sum: stats.sum,
            stddev: stats.stddev,
            variance: stats.variance,
            range: stats.range,
            median: stats.median,
            first: stats.first,
            last: stats.last,
            diff: stats.diff,
            sample_count: stats.sample_count
        },
        callback: callbackResult
    });
}

/**
 * Case 3 Dispatcher: Parses options and routes to profile, record, periodic, or aggregate
 */
async function handleCase3TimeRange(ctx, res) {
    if (!ctx.refElement) {
        await reportError('[BatchLine Case 3]: Missing required RefElement in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefElement in instruction payload' });
    }
    if (!ctx.refStartTime) {
        await reportError('[BatchLine Case 3]: Missing required RefStartTime in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefStartTime in instruction payload' });
    }
    if (!ctx.refType) {
        await reportError('[BatchLine Case 3]: Missing required RefType in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefType in instruction payload' });
    }

    const startDate = parseBatchLineDate(ctx.refStartTime) || new Date(ctx.refStartTime);
    if (isNaN(startDate.getTime())) {
        const errMsg = `Invalid date format for RefStartTime ("${ctx.refStartTime}")`;
        await reportError(`[BatchLine Case 3]: ${errMsg}`, ctx);
        return res.status(400).json({ error: errMsg });
    }

    // -------------------------------------------------------------------------
    // Detect Modes (Strictly [RECORD] or [RECORD: ...] with 6 sub-scenarios)
    // -------------------------------------------------------------------------
    const desc = typeof ctx.instructionDescription === 'string' ? ctx.instructionDescription : '';

    // Strictly match [RECORD] or [RECORD: ...]
    const recordBlockMatch = desc.match(/\[RECORD(?::\s*([^\]]*))?\]/i);
    const isRecordTrigger = Boolean(recordBlockMatch);

    let isProfileMode = false;
    let profileConfig = null;
    let intervalConfig = null;
    let statField = null;

    if (isRecordTrigger) {
        const content = (recordBlockMatch[1] || '').trim();
        const metric = resolveMetric(ctx.refType);

        // Parameters
        const startMatch = content.match(/\bSTART\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
        const stopMatch = content.match(/\bSTOP\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
        const durationMatch = content.match(/\bDURATION\s*=\s*(\d+(?:\.\d+)?)\s*(s|m|h)?/i);
        const directionMatch = content.match(/\bDIRECTION\s*=\s*(Rise|Fall)/i);
        const intervalMatch = content.match(/\bINTERVAL\s*=\s*(\d+(?:\.\d+)?)\s*(s|m|h)?/i);

        if (intervalMatch) {
            const val = parseFloat(intervalMatch[1]);
            const unit = (intervalMatch[2] || 'm').toLowerCase();
            let intervalMs;
            let intervalMinutes;
            if (unit === 's') {
                intervalMs = Math.round(val * 1000);
                intervalMinutes = val / 60;
            } else if (unit === 'h') {
                intervalMs = Math.round(val * 3600 * 1000);
                intervalMinutes = val * 60;
            } else {
                intervalMs = Math.round(val * 60 * 1000);
                intervalMinutes = val;
            }
            intervalConfig = {
                rawInterval: intervalMatch[0],
                intervalMinutes,
                intervalMs: Math.max(intervalMs, 1000)
            };
        }

        let durationMinutes = null;
        if (durationMatch) {
            const val = parseFloat(durationMatch[1]);
            const unit = (durationMatch[2] || 'm').toLowerCase();
            if (unit === 's') durationMinutes = val / 60;
            else if (unit === 'h') durationMinutes = val * 60;
            else durationMinutes = val;
        }

        const sentinelMatch = content.match(/\b(SENTINEL|OPEN[-_]?ENDED)\b/i);
        const isSentinelMode = Boolean(sentinelMatch);

        if (startMatch) {
            isProfileMode = true;
            profileConfig = {
                start: parseFloat(startMatch[1]),
                stop: stopMatch ? parseFloat(stopMatch[1]) : null,
                durationMinutes,
                direction: directionMatch ? directionMatch[1].toLowerCase() : null,
                metric,
                isSentinel: isSentinelMode
            };
        }
    } else {
        const statKey = String(ctx.refType).trim().toUpperCase();
        statField = STAT_OPERATIONS[statKey];

        if (!statField) {
            await reportError(`[BatchLine Case 3]: Unsupported RefType operation: "${ctx.refType}"`, ctx);
            return res.status(400).json({
                error: `Unsupported RefType operation: "${ctx.refType}". Supported operations: MAX, MIN, AVG, SUM, COUNT, STDDEV, VARIANCE, RANGE, MEDIAN, FIRST, LAST.`
            });
        }
    }

    // Determine endDate (support inferring from durationMinutes or explicit SENTINEL/OPEN_ENDED mode)
    let endDate = ctx.refEndTime ? (parseBatchLineDate(ctx.refEndTime) || new Date(ctx.refEndTime)) : null;
    if (typeof isSentinelMode !== 'undefined' && isSentinelMode) {
        // Explicit SENTINEL or OPEN_ENDED keyword in [RECORD: ... SENTINEL]
        // Expand window with a 24-hour industrial safety watchdog ceiling awaiting stop signal from BatchLine
        const watchdogHours = 24;
        endDate = new Date(startDate.getTime() + watchdogHours * 60 * 60 * 1000);
        console.log(`[BatchLine Case 3]: Explicit SENTINEL / OPEN_ENDED mode activated for tag "${ctx.refElement}" (batch: ${ctx.batchId}, refInstruction: ${ctx.refInstruction}). Setting 24h watchdog ceiling.`);
    } else if (!endDate || isNaN(endDate.getTime())) {
        if (profileConfig?.durationMinutes && profileConfig.durationMinutes > 0) {
            endDate = new Date(startDate.getTime() + profileConfig.durationMinutes * 60 * 1000);
        } else {
            await reportError('[BatchLine Case 3]: Missing required RefEndTime in instruction payload', ctx);
            return res.status(400).json({ error: 'Missing required RefEndTime in instruction payload' });
        }
    } else if (endDate.getTime() === startDate.getTime() && profileConfig?.durationMinutes && profileConfig.durationMinutes > 0) {
        // When BatchLine mandates RefEndTime and operator sets RefEndTime = RefStartTime, expand by DURATION
        console.log(`[BatchLine Case 3]: RefEndTime equals RefStartTime for tag "${ctx.refElement}". Expanding window by DURATION (${profileConfig.durationMinutes}m).`);
        endDate = new Date(startDate.getTime() + profileConfig.durationMinutes * 60 * 1000);
    }

    const [actualStart, actualEnd] = startDate > endDate ? [endDate, startDate] : [startDate, endDate];

    // Single RefElement resolution
    const tag = await resolveTag(ctx.refElement, ctx);
    if (!tag) {
        await reportError(`[BatchLine Case 3]: Could not resolve tag for RefElement: "${ctx.refElement}"`, ctx);
        return res.status(404).json({ error: `Could not resolve tag for RefElement: "${ctx.refElement}"` });
    }

    const now = new Date();
    const nowMs = now.getTime();

    // -------------------------------------------------------------------------
    // Route 1: Profile Mode (Check if historical or live tracking required)
    // -------------------------------------------------------------------------
    if (isProfileMode) {
        let isLiveTracking = false;

        if (actualEnd.getTime() > nowMs) {
            isLiveTracking = true;
        } else {
            // Check in existing readings up to now if wave has already fully finished
            const startThreshold = profileConfig.start;
            const { startDirection, stopDirection } = resolveWaveDirections(
                startThreshold,
                profileConfig.stop,
                profileConfig.direction
            );
            const isFall = (startDirection === 'fall');

            const { rows: searchRows } = await query(`
                SELECT ts, value FROM readings
                WHERE tag_id = $1 AND ts >= $2::timestamptz AND ts <= $3::timestamptz
                ORDER BY ts ASC;
            `, [tag.id, actualStart, now]);

            let waveStartTs = null;
            let armed = false;
            for (let i = 0; i < searchRows.length; i++) {
                const r = searchRows[i];
                if (r.value === null || r.value === undefined) continue;
                const val = Number(r.value);
                if (isNaN(val)) continue;

                if (!armed) {
                    if (isFall && val > startThreshold) armed = true;
                    if (!isFall && val < startThreshold) armed = true;
                }
                const reachedStart = isFall ? (val <= startThreshold) : (val >= startThreshold);
                if (armed && reachedStart) {
                    waveStartTs = r.ts;
                    break;
                }
                if (i === 0 && reachedStart) {
                    waveStartTs = r.ts;
                    break;
                }
            }

            if (!waveStartTs) {
                // Wave has not crossed START threshold yet: Live Tracking required
                isLiveTracking = true;
            } else if (profileConfig.durationMinutes !== null && profileConfig.durationMinutes > 0) {
                const targetFinishMs = new Date(waveStartTs).getTime() + profileConfig.durationMinutes * 60 * 1000;
                if (targetFinishMs > nowMs) {
                    // Wave started, but duration extends beyond current time: Live Tracking required
                    isLiveTracking = true;
                }
            } else if (profileConfig.stop !== null) {
                let reachedStop = false;
                for (const r of searchRows) {
                    if (new Date(r.ts).getTime() <= new Date(waveStartTs).getTime()) continue;
                    const val = Number(r.value);
                    if (stopDirection === 'rise' ? (val >= profileConfig.stop) : (val <= profileConfig.stop)) {
                        reachedStop = true;
                        break;
                    }
                }
                if (!reachedStop) {
                    isLiveTracking = true;
                }
            }
        }

        if (isLiveTracking) {
            console.log(`[BatchLine Case 3]: Identified Live Tracking Profile Mode for tag "${tag.name}" (batch: ${ctx.batchId}, START=${profileConfig.start}, DURATION=${profileConfig.durationMinutes ?? 'none'}m)`);

            let effectiveIntervalConfig = intervalConfig;
            if (!effectiveIntervalConfig) {
                const sampleCount = CONFIG.MAX_PROFILE_SAMPLES || 30;
                const durMs = (profileConfig.durationMinutes && profileConfig.durationMinutes > 0)
                    ? (profileConfig.durationMinutes * 60 * 1000)
                    : Math.max(1000, actualEnd.getTime() - actualStart.getTime());
                const intervalMs = Math.max(1000, Math.round(durMs / sampleCount));
                effectiveIntervalConfig = {
                    rawInterval: `${Math.round(intervalMs / 1000)}s`,
                    intervalMinutes: intervalMs / 60000,
                    intervalMs
                };
            }

            let effectiveEnd = actualEnd;
            if (profileConfig.durationMinutes && profileConfig.durationMinutes > 0) {
                const minEndMs = actualStart.getTime() + profileConfig.durationMinutes * 60 * 1000;
                if (!effectiveEnd || effectiveEnd.getTime() < minEndMs) {
                    effectiveEnd = new Date(minEndMs);
                }
            }

            return await handleFutureIntervalRecordMode(
                ctx,
                res,
                tag,
                actualStart,
                effectiveEnd,
                effectiveIntervalConfig,
                profileConfig.start,
                profileConfig.direction,
                profileConfig.stop,
                profileConfig.durationMinutes
            );
        }

        // Entire wave completed in the past: run standard historical profile
        console.log(`[BatchLine Case 3]: Identified historical profile mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
        return await handleProfileMode(ctx, res, tag, actualStart, actualEnd, profileConfig, intervalConfig);
    }

    // -------------------------------------------------------------------------
    // Route 2: Record Mode (Future/Live Interval or Historical)
    // -------------------------------------------------------------------------
    if (isRecordTrigger) {
        if (typeof isSentinelMode !== 'undefined' && isSentinelMode && !isProfileMode) {
            console.log(`[BatchLine Case 3]: Identified Continuous Sentinel Record Mode for tag "${tag.name}" (batch: ${ctx.batchId}, INTERVAL=${intervalConfig?.rawInterval || 'none'})`);
            const effInterval = intervalConfig || { rawInterval: '1m', intervalMinutes: 1, intervalMs: 60000 };
            return await handleContinuousIntervalMode(ctx, res, tag, actualStart, effInterval, null, null);
        }

        if (actualEnd.getTime() > nowMs) {
            console.log(`[BatchLine Case 3]: Identified Future Record Mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
            let effectiveIntervalConfig = intervalConfig;
            if (!effectiveIntervalConfig) {
                const sampleCount = CONFIG.MAX_PROFILE_SAMPLES || 30;
                const durMs = Math.max(1000, actualEnd.getTime() - actualStart.getTime());
                const intervalMs = Math.max(1000, Math.round(durMs / sampleCount));
                effectiveIntervalConfig = {
                    rawInterval: `${Math.round(intervalMs / 1000)}s`,
                    intervalMinutes: intervalMs / 60000,
                    intervalMs
                };
            }
            return await handleFutureIntervalRecordMode(
                ctx,
                res,
                tag,
                actualStart,
                actualEnd,
                effectiveIntervalConfig,
                null,
                null,
                null,
                null
            );
        }

        console.log(`[BatchLine Case 3]: Identified historical record mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
        return await handleRecordMode(ctx, res, tag, actualStart, actualEnd, intervalConfig);
    }

    // -------------------------------------------------------------------------
    // Route 3: Standard Statistical / Aggregate Calculations
    // -------------------------------------------------------------------------
    console.log(`[BatchLine Case 3]: Identified aggregate mode "${statField}" for tag "${tag.name}" (batch: ${ctx.batchId})`);
    return await handleAggregateMode(ctx, res, tag, actualStart, actualEnd, statField);
}

// ===========================================================================
// PRINT LABEL INSTRUCTION (EBR USER RECORD TRIGGER) HELPERS
// ===========================================================================



// ✅
function mapInstructionKey(instructionId = '') {
    const id = String(instructionId).trim().toUpperCase();
    if (id.includes('[PARM')) return 'RefElement';
    if (id.includes('[REF')) return 'RefInstruction';
    if (id.includes('[AGG')) return 'RefType';
    if (id.includes('[STH')) return 'START';
    if (id.includes('[ETH')) return 'STOP';
    if (id.includes('[INV')) return 'INTERVAL';
    if (id.includes('[DUR')) return 'DURATION';
    if (id.includes('[DIR')) return 'DIRECTION';
    if (id.includes('[ET') || id.includes('[NT') || id === 'ET' || id === 'NT') return 'RefEndTime';
    if (id.includes('[ST') || id === 'ST') return 'RefStartTime';
    return null;
}

// ✅
function parsePrintLabelPayload(body = {}) {
    const data = body.Data || {};
    const batch = data.Batch || {};
    const batchId = batch.BatchId || body.batch_id || body.batchid || null;
    const callbackKey = body.CallbackKey || data.CallbackKey || body.callbackkey || null;

    const parameters = {
        RefElement: null,
        RefInstruction: null,
        RefStartTime: null,
        RefEndTime: null,
        RefType: null,
        START: null,
        STOP: null,
        INTERVAL: null,
        DURATION: null,
        DIRECTION: null
    };

    let executedUserEmail = null;
    const incomingInstructionIds = [];

    const phases = Array.isArray(batch.Phases) ? batch.Phases : (batch.Phase ? [batch.Phase] : []);
    for (const phase of phases) {
        const steps = Array.isArray(phase.Steps) ? phase.Steps : (phase.Step ? [phase.Step] : []);
        for (const step of steps) {
            const instructions = Array.isArray(step.Instructions) ? step.Instructions : (step.Instruction ? [step.Instruction] : []);
            for (const inst of instructions) {
                if (inst.InstructionId) {
                    incomingInstructionIds.push(cleanInstructionId(inst.InstructionId));
                }
                const key = mapInstructionKey(inst.InstructionId);
                if (!key) continue;

                const result = Array.isArray(inst.ActualResult) ? inst.ActualResult[inst.ActualResult.length - 1] : inst.ActualResult;
                const val = result?.Value ? String(result.Value).trim() : null;

                if (val && val.toLowerCase() !== 'skip instruction') {
                    parameters[key] = val;
                }
                if (result?.ExecutedUserEmail) {
                    executedUserEmail = result.ExecutedUserEmail;
                }
            }
        }
    }

    const startDate = parameters.RefStartTime ? parseBatchLineDate(parameters.RefStartTime) : null;
    const endDate = parameters.RefEndTime ? parseBatchLineDate(parameters.RefEndTime) : null;

    return {
        topic: body.Topic || null,
        batchId,
        callbackKey,
        refInstruction: parameters.RefInstruction || batch.RefInstruction || body.RefInstruction || null,
        user: executedUserEmail ? { executedUserEmail } : null,
        parameters,
        incomingInstructionIds,
        parsedDates: {
            startDate: startDate ? startDate.toISOString() : null,
            endDate: endDate ? endDate.toISOString() : null
        }
    };
}

function parseIntervalString(intervalStr) {
    if (!intervalStr) return null;
    const str = String(intervalStr).trim();
    if (str.toLowerCase() === 'skip instruction' || str === '') return null;
    const match = str.match(/^([+-]?\d+(?:\.\d+)?)\s*(s|m|h)?/i);
    if (!match) return null;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 0) return null;
    const unit = (match[2] || 'm').toLowerCase();
    let intervalMs;
    let intervalMinutes;
    if (unit === 's') {
        intervalMs = Math.round(val * 1000);
        intervalMinutes = val / 60;
    } else if (unit === 'h') {
        intervalMs = Math.round(val * 3600 * 1000);
        intervalMinutes = val * 60;
    } else {
        intervalMs = Math.round(val * 60 * 1000);
        intervalMinutes = val;
    }
    return {
        rawInterval: str,
        intervalMinutes,
        intervalMs: Math.max(intervalMs, 1000)
    };
}

function parseDurationString(durationStr) {
    if (!durationStr) return null;
    const str = String(durationStr).trim();
    if (str.toLowerCase() === 'skip instruction' || str === '') return null;
    const match = str.match(/^([+-]?\d+(?:\.\d+)?)\s*(s|m|h)?/i);
    if (!match) return null;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 0) return null;
    const unit = (match[2] || 'm').toLowerCase();
    if (unit === 's') return val / 60;
    if (unit === 'h') return val * 60;
    return val;
}

// Active background jobs for PrintLabel future interval recordings
const activeFutureIntervalJobs = new Map();

/**
 * Handles PrintLabel Instruction when INTERVAL is specified and RefEndTime is set in the future.
 * Immediately acknowledges HTTP webhook and starts a progressive 30-second cadence dispatcher,
 * sending sets of bucketed values to BatchLine every 30 seconds until RefEndTime.
 */
async function handleFutureIntervalRecordMode(ctx, res, tag, actualStart, actualEnd, intervalConfig, startThreshold = null, startDirection = null, stopThreshold = null, durationMinutes = null) {
    const metric = resolveMetric(ctx.refType);
    const intervalMs = intervalConfig.intervalMs;
    const startMs = actualStart.getTime();

    const durationSpecifiedMs = (durationMinutes !== null && durationMinutes > 0)
        ? durationMinutes * 60 * 1000
        : null;

    let endMs = actualEnd ? actualEnd.getTime() : (startMs + (durationSpecifiedMs || intervalMs));
    if (durationSpecifiedMs && endMs < startMs + durationSpecifiedMs) {
        endMs = startMs + durationSpecifiedMs;
    }

    const durationMs = endMs - startMs;

    if (durationMs <= 0) {
        const errMsg = `RefEndTime (${actualEnd ? actualEnd.toISOString() : 'none'}) must be after RefStartTime (${actualStart.toISOString()})`;
        await reportError(`[BatchLine Future Record]: ${errMsg}`, ctx);
        return res.status(400).json({ error: errMsg });
    }

    const cleanRef = cleanInstructionId(ctx.refInstruction);
    const jobKey = `${ctx.batchId}_${cleanRef}`;

    // Cancel previous job for this instruction if running
    if (activeFutureIntervalJobs.has(jobKey)) {
        console.log(`[BatchLine Future Record]: Cancelling previous future interval job for ${jobKey}`);
        const prevJob = activeFutureIntervalJobs.get(jobKey);
        if (typeof prevJob.cleanup === 'function') prevJob.cleanup();
        else {
            if (prevJob.startTimeoutId) clearTimeout(prevJob.startTimeoutId);
            if (prevJob.intervalId) clearInterval(prevJob.intervalId);
            if (prevJob.endTimeoutId) clearTimeout(prevJob.endTimeoutId);
        }
        activeFutureIntervalJobs.delete(jobKey);
    }

    // Determine initial lastKnown reading
    const { rows: initialRows } = await query(`
        SELECT value FROM readings
        WHERE tag_id = $1 AND ts <= $2::timestamptz
        ORDER BY ts DESC LIMIT 1;
    `, [tag.id, actualStart]);

    let lastKnown = 0;
    let initialVal = null;
    if (initialRows.length > 0 && initialRows[0].value !== null) {
        lastKnown = Number(initialRows[0].value);
        initialVal = lastKnown;
    } else {
        const { rows: snapRows } = await query(`
            SELECT value FROM snapshots WHERE tag_id = $1 LIMIT 1;
        `, [tag.id]);
        if (snapRows.length > 0 && snapRows[0].value !== null) {
            lastKnown = Number(snapRows[0].value);
            initialVal = lastKnown;
        }
    }

    const { startDirection: resolvedStartDir, stopDirection, isFall, isEnvelope } = resolveWaveDirections(
        startThreshold,
        stopThreshold,
        startDirection,
        initialVal
    );
    const effectiveDirection = resolvedStartDir;

    let crossedStartMs = (startThreshold === null) ? startMs : null;
    let armed = false;

    if (startThreshold !== null) {
        if (initialVal !== null) {
            armed = isFall ? (initialVal > startThreshold) : (initialVal < startThreshold);
        }

        const { rows: searchRows } = await query(`
            SELECT ts, value FROM readings
            WHERE tag_id = $1 AND ts >= $2::timestamptz AND ts <= $3::timestamptz
            ORDER BY ts ASC;
        `, [tag.id, actualStart, new Date()]);

        for (let i = 0; i < searchRows.length; i++) {
            const r = searchRows[i];
            if (r.value === null || r.value === undefined) continue;
            const val = Number(r.value);
            if (isNaN(val)) continue;

            if (!armed) {
                if (isFall && val > startThreshold) armed = true;
                if (!isFall && val < startThreshold) armed = true;
            }
            const crossed = isFall ? (val <= startThreshold) : (val >= startThreshold);
            if (armed && crossed) {
                crossedStartMs = new Date(r.ts).getTime();
                console.log(`[BatchLine Future 30s]: Tag "${tag.name}" already crossed START threshold (${startThreshold}) at ${r.ts} (direction: ${isFall ? 'fall' : 'rise'}). Intervals will start from this point.`);
                break;
            }
            if (i === 0 && crossed) {
                crossedStartMs = new Date(r.ts).getTime();
                console.log(`[BatchLine Future 30s]: Tag "${tag.name}" was already at/past START threshold (${startThreshold}) at ${r.ts}. Intervals will start from this point.`);
                break;
            }
        }
    }

    if (crossedStartMs && durationSpecifiedMs) {
        endMs = crossedStartMs + durationSpecifiedMs;
    }

    const effectiveBaseStartMs = crossedStartMs || startMs;
    let totalExpectedBuckets = durationSpecifiedMs
        ? Math.min(Math.max(1, Math.ceil(durationSpecifiedMs / intervalMs)), CONFIG.MAX_PERIODIC_REPEATS || 50)
        : Math.max(1, Math.ceil((endMs - effectiveBaseStartMs) / intervalMs));

    if (totalExpectedBuckets > (CONFIG.MAX_PERIODIC_REPEATS || 50)) {
        console.warn(`[BatchLine Future Warning]: Capping expected buckets from ${totalExpectedBuckets} to max ${CONFIG.MAX_PERIODIC_REPEATS || 50}`);
        totalExpectedBuckets = CONFIG.MAX_PERIODIC_REPEATS || 50;
    }

    const nowMs = Date.now();
    const isScenario2 = (startMs < nowMs && nowMs < endMs);
    const isScenario3 = (nowMs <= startMs);
    const scenarioNum = isScenario2 ? 2 : 3;

    // Acknowledge BatchLine webhook immediately with HTTP 200
    if (!res.headersSent) {
        res.json({
            status: 'scheduled',
            case: 3,
            scenario: scenarioNum,
            mode: 'record_interval_future',
            message: isScenario2
                ? `Scenario 2: RefStartTime is in past, RefEndTime in future. Initial past data pushed immediately; subsequent intervals pushed every 30s until ${new Date(endMs).toISOString()}.`
                : `Scenario 3: RefStartTime and RefEndTime are in future. Scheduled to begin at ${actualStart.toISOString()} and push intervals every 30s until ${new Date(endMs).toISOString()}.`,
            batch_id: ctx.batchId,
            tag: tag.name,
            ref_instruction: ctx.refInstruction,
            ref_start_time: ctx.refStartTime,
            ref_end_time: actualEnd ? actualEnd.toISOString() : (new Date(endMs).toISOString()),
            start_threshold: startThreshold,
            direction: startThreshold !== null ? (isFall ? 'fall' : 'rise') : null,
            stop_threshold: stopThreshold,
            stop_direction: stopDirection,
            is_envelope: isEnvelope,
            duration_minutes: durationMinutes ?? null,
            interval: intervalConfig.rawInterval,
            interval_ms: intervalMs,
            metric: metric.toUpperCase(),
            total_expected_buckets: totalExpectedBuckets,
            transmission_cadence_sec: 30
        });
    }

    let nextBucketIndex = 0;
    let isProcessing = false;

    const processCompletedBuckets = async () => {
        if (isProcessing) return;
        isProcessing = true;

        try {
            const currentNowMs = Date.now();

            // 1. If START threshold specified, ensure value has crossed threshold before starting repeats
            if (crossedStartMs === null) {
                const { rows: searchRows } = await query(`
                    SELECT ts, value FROM readings
                    WHERE tag_id = $1 AND ts >= $2::timestamptz AND ts <= $3::timestamptz
                    ORDER BY ts ASC;
                `, [tag.id, actualStart, new Date(currentNowMs)]);

                for (let i = 0; i < searchRows.length; i++) {
                    const r = searchRows[i];
                    if (r.value === null || r.value === undefined) continue;
                    const val = Number(r.value);
                    if (isNaN(val)) continue;

                    if (!armed) {
                        if (isFall && val > startThreshold) armed = true;
                        if (!isFall && val < startThreshold) armed = true;
                    }
                    const crossed = isFall ? (val <= startThreshold) : (val >= startThreshold);
                    if (armed && crossed) {
                        crossedStartMs = new Date(r.ts).getTime();
                        if (durationSpecifiedMs) {
                            endMs = crossedStartMs + durationSpecifiedMs;
                            totalExpectedBuckets = Math.min(Math.max(1, Math.ceil(durationSpecifiedMs / intervalMs)), CONFIG.MAX_PERIODIC_REPEATS || 50);
                            if (endTimeoutId) clearTimeout(endTimeoutId);
                            const msUntilEnd = Math.max(0, endMs - Date.now() + 1500);
                            endTimeoutId = setTimeout(processCompletedBuckets, msUntilEnd);
                        }
                        console.log(`[BatchLine Future 30s]: Tag "${tag.name}" crossed START threshold (${startThreshold}) at ${r.ts} (direction: ${isFall ? 'fall' : 'rise'}). Intervals will start from this point until ${new Date(endMs).toISOString()}.`);
                        break;
                    }
                }

                if (crossedStartMs === null) {
                    if (currentNowMs >= endMs) {
                        console.log(`[BatchLine Future 30s]: Tag "${tag.name}" never crossed START threshold (${startThreshold}) before end time (${new Date(endMs).toISOString()}). Finishing.`);
                        cleanupJob();
                    } else {
                        console.log(`[BatchLine Future 30s]: Tag "${tag.name}" has not yet crossed START threshold (${startThreshold}) [direction: ${isFall ? 'fall' : 'rise'}, armed: ${armed}]. Waiting for threshold crossing...`);
                    }
                    return;
                }
            }

            const effectiveStartMs = crossedStartMs;
            if (!durationSpecifiedMs) {
                const remainingDurationMs = endMs - effectiveStartMs;
                if (remainingDurationMs > 0) {
                    totalExpectedBuckets = Math.min(
                        Math.max(1, Math.ceil(remainingDurationMs / intervalMs)),
                        CONFIG.MAX_PERIODIC_REPEATS || 50
                    );
                }
            }

            const bucketsToProcess = [];
            while (nextBucketIndex < totalExpectedBuckets) {
                const bStartMs = effectiveStartMs + nextBucketIndex * intervalMs;
                const bEndMs = Math.min(effectiveStartMs + (nextBucketIndex + 1) * intervalMs, endMs);

                // Bucket is ready if its window has completed or now >= endMs
                if (currentNowMs >= bEndMs || currentNowMs >= endMs) {
                    bucketsToProcess.push({
                        index: nextBucketIndex,
                        bStartMs,
                        bEndMs
                    });
                    nextBucketIndex++;

                    // Limit batch size per dispatch
                    if (bucketsToProcess.length >= (CONFIG.MAX_PERIODIC_REPEATS || 50)) {
                        break;
                    }
                } else {
                    break;
                }
            }

            if (bucketsToProcess.length === 0) {
                if (nextBucketIndex >= totalExpectedBuckets || currentNowMs >= endMs) {
                    cleanupJob();
                }
                return;
            }

            const rangeStart = new Date(bucketsToProcess[0].bStartMs);
            const rangeEnd = new Date(bucketsToProcess[bucketsToProcess.length - 1].bEndMs);

            const { rows: readings } = await query(`
                SELECT ts, value
                FROM readings
                WHERE tag_id = $1
                  AND ts >= $2::timestamptz
                  AND ts <= $3::timestamptz
                ORDER BY ts ASC;
            `, [tag.id, rangeStart, rangeEnd]);

            const setOfValues = [];
            let hitStop = false;

            for (const b of bucketsToProcess) {
                const isLast = (b.index === totalExpectedBuckets - 1);
                const bucketReadings = readings.filter(r => {
                    const rMs = new Date(r.ts).getTime();
                    return rMs >= b.bStartMs && (isLast ? (rMs <= b.bEndMs) : (rMs < b.bEndMs));
                });

                let resolvedVal;
                if (bucketReadings.length > 0) {
                    resolvedVal = computeMetricValue(bucketReadings.map(r => Number(r.value)), metric);
                    lastKnown = resolvedVal;
                } else {
                    resolvedVal = lastKnown;
                }

                setOfValues.push({
                    repeat_no: b.index + 1,
                    value: formatReadingValue(resolvedVal, tag.display_digits),
                    executed_timestamp: formatExecutedTimestamp(new Date(b.bStartMs)),
                    executed_user_email: ctx.triggeredByEmail || null
                });

                if (stopThreshold !== null && resolvedVal !== null) {
                    const reachedStop = (stopDirection === 'rise') ? (resolvedVal >= stopThreshold) : (resolvedVal <= stopThreshold);
                    const hasStarted = (b.bStartMs > effectiveStartMs || setOfValues.length > 0 || nextBucketIndex > 0);
                    if (reachedStop && hasStarted) {
                        console.log(`[BatchLine Future 30s]: Tag "${tag.name}" reached STOP threshold (${stopThreshold}) [stopDirection: ${stopDirection}, isEnvelope: ${isEnvelope}] at bucket repeat ${b.index + 1}.`);
                        hitStop = true;
                        break;
                    }
                }
            }

            console.log(`[BatchLine PrintLabel 30s]: Dispatching set of ${setOfValues.length} bucketed values (repeats ${setOfValues[0].repeat_no}..${setOfValues[setOfValues.length - 1].repeat_no}) for tag "${tag.name}" (batch: ${ctx.batchId})...`);

            const cbResult = await sendBatchLineInstructionUpdate({
                refInstruction: ctx.refInstruction,
                batchId: ctx.batchId,
                callbackKey: ctx.callbackKey,
                actualResult: setOfValues
            });

            if (!cbResult?.ok) {
                const detail = cbResult?.data?.error?.detail || cbResult?.error || '';
                if (String(detail).toLowerCase().includes('cannot exceed the target repeat')) {
                    console.log(`[BatchLine Future 30s]: Instruction ${ctx.refInstruction} reached Target Repeat limit in BatchLine. Stopping job.`);
                    cleanupJob();
                    return;
                }
                await reportError(`[BatchLine PrintLabel 30s]: Failed to push set of ${setOfValues.length} bucketed values`, ctx, detail);
            }

            // If there are still older backlogged buckets, process next chunk immediately
            const nextBucketEndMs = effectiveStartMs + (nextBucketIndex + 1) * intervalMs;
            if (currentNowMs >= nextBucketEndMs && nextBucketIndex < totalExpectedBuckets && !hitStop) {
                setImmediate(processCompletedBuckets);
            }

            if (hitStop || nextBucketIndex >= totalExpectedBuckets || currentNowMs >= endMs) {
                cleanupJob();
            }
        } catch (err) {
            console.error('[BatchLine PrintLabel 30s Error]:', err);
            await reportError(`[BatchLine PrintLabel 30s Error]: ${err.message}`, ctx, err.stack);
        } finally {
            isProcessing = false;
        }
    };

    let intervalId = null;
    let startTimeoutId = null;
    let endTimeoutId = null;

    const cleanupJob = () => {
        console.log(`[BatchLine PrintLabel 30s]: Completed future interval recording for instruction ${ctx.refInstruction} (${tag.name}). Total repeats sent: ${nextBucketIndex}.`);
        if (startTimeoutId) clearTimeout(startTimeoutId);
        if (intervalId) clearInterval(intervalId);
        if (endTimeoutId) clearTimeout(endTimeoutId);
        activeFutureIntervalJobs.delete(jobKey);
    };

    const stop = async () => {
        cleanupJob();
        await processCompletedBuckets();
    };

    const CADENCE_MS = 30000;

    if (isScenario2) {
        // Scenario 2: RefStartTime < Request time < RefEndTime
        // 1. Immediately push query between RefStartTime and Request time
        console.log(`[BatchLine PrintLabel Scenario 2]: Pushing initial past readings between ${actualStart.toISOString()} and now (${new Date(nowMs).toISOString()})...`);
        setImmediate(processCompletedBuckets);

        // 2. Await to push the rest every 30 seconds until RefEndTime
        intervalId = setInterval(processCompletedBuckets, CADENCE_MS);
    } else {
        // Scenario 3: Request time < RefStartTime and RefEndTime
        // Wait until RefStartTime arrives before starting the 30-second cadence
        const msUntilStart = Math.max(0, startMs - Date.now());
        console.log(`[BatchLine PrintLabel Scenario 3]: Waiting ${Math.round(msUntilStart / 1000)}s until RefStartTime (${actualStart.toISOString()}) to start 30s cadence...`);
        startTimeoutId = setTimeout(() => {
            console.log(`[BatchLine PrintLabel Scenario 3]: RefStartTime reached (${actualStart.toISOString()}). Starting 30s cadence dispatcher.`);
            intervalId = setInterval(processCompletedBuckets, CADENCE_MS);
        }, msUntilStart);
    }

    const msUntilEnd = Math.max(0, endMs - Date.now() + 1500);
    endTimeoutId = setTimeout(processCompletedBuckets, msUntilEnd);

    const jobRecord = {
        jobKey,
        refInstruction: ctx.refInstruction,
        cleanRefInstruction: cleanRef,
        batchId: ctx.batchId,
        tagId: tag.id,
        tagName: tag.name,
        cleanup: cleanupJob,
        stop,
        getNextBucketIndex: () => nextBucketIndex,
        get startTimeoutId() { return startTimeoutId; },
        get intervalId() { return intervalId; },
        get endTimeoutId() { return endTimeoutId; },
        startedAt: new Date()
    };

    activeFutureIntervalJobs.set(jobKey, jobRecord);
}

/**
 * Mode: Continuous Interval Record Mode (RefEndTime is omitted)
 * Immediately acknowledges HTTP webhook and starts a continuous 30-second cadence dispatcher,
 * sending sets of bucketed values to BatchLine every 30 seconds continuously until
 * a STOP request mentioning the RefInstruction is received.
 */
async function handleContinuousIntervalMode(ctx, res, tag, actualStart, intervalConfig, startThreshold = null, startDirection = null) {
    const metric = resolveMetric(ctx.refType);
    const intervalMs = intervalConfig.intervalMs;
    const startMs = actualStart.getTime();

    const cleanRef = cleanInstructionId(ctx.refInstruction);
    const jobKey = `${ctx.batchId}_${cleanRef}`;

    // Cancel previous job for this instruction if running
    if (activeFutureIntervalJobs.has(jobKey)) {
        console.log(`[BatchLine Continuous]: Replacing existing job for ${jobKey}`);
        const prevJob = activeFutureIntervalJobs.get(jobKey);
        if (typeof prevJob.cleanup === 'function') prevJob.cleanup();
        activeFutureIntervalJobs.delete(jobKey);
    }

    // Determine initial lastKnown reading
    const { rows: initialRows } = await query(`
        SELECT value FROM readings
        WHERE tag_id = $1 AND ts <= $2::timestamptz
        ORDER BY ts DESC LIMIT 1;
    `, [tag.id, actualStart]);

    let lastKnown = 0;
    let initialVal = null;
    if (initialRows.length > 0 && initialRows[0].value !== null) {
        lastKnown = Number(initialRows[0].value);
        initialVal = lastKnown;
    } else {
        const { rows: snapRows } = await query(`
            SELECT value FROM snapshots WHERE tag_id = $1 LIMIT 1;
        `, [tag.id]);
        if (snapRows.length > 0 && snapRows[0].value !== null) {
            lastKnown = Number(snapRows[0].value);
            initialVal = lastKnown;
        }
    }

    let effectiveDirection = startDirection;
    if (startThreshold !== null && !effectiveDirection) {
        if (initialVal !== null) {
            effectiveDirection = (initialVal <= startThreshold) ? 'rise' : 'fall';
        } else {
            effectiveDirection = 'rise';
        }
    }
    const isFall = (effectiveDirection === 'fall' || effectiveDirection === 'down');

    let crossedStartMs = (startThreshold === null) ? startMs : null;
    let armed = false;
    if (startThreshold !== null) {
        if (initialVal !== null) {
            armed = isFall ? (initialVal > startThreshold) : (initialVal < startThreshold);
        }
    }

    // Acknowledge BatchLine webhook immediately with HTTP 200
    if (!res.headersSent) {
        res.json({
            status: 'scheduled',
            case: 3,
            mode: 'record_interval_continuous',
            message: startThreshold !== null
                ? `Continuous periodic collection scheduled for instruction ${ctx.refInstruction}. Will begin recording bucketed values (${intervalConfig.rawInterval}) once ${tag.name} crosses START threshold (${startThreshold}) [direction: ${isFall ? 'fall' : 'rise'}].`
                : `Continuous periodic collection started for instruction ${ctx.refInstruction}. Bucketed values (${intervalConfig.rawInterval}) will be sent every 30s continuously until a stop request is received.`,
            batch_id: ctx.batchId,
            tag: tag.name,
            ref_instruction: ctx.refInstruction,
            ref_start_time: ctx.refStartTime,
            ref_end_time: null,
            start_threshold: startThreshold,
            direction: startThreshold !== null ? (isFall ? 'fall' : 'rise') : null,
            interval: intervalConfig.rawInterval,
            interval_ms: intervalMs,
            metric: metric.toUpperCase(),
            transmission_cadence_sec: 30
        });
    }

    let nextBucketIndex = 0;
    let isProcessing = false;

    const processCompletedBuckets = async () => {
        if (isProcessing) return;
        isProcessing = true;

        try {
            const currentNowMs = Date.now();

            // 1. If START threshold specified, ensure value has crossed threshold before starting repeats
            if (crossedStartMs === null) {
                const { rows: searchRows } = await query(`
                    SELECT ts, value FROM readings
                    WHERE tag_id = $1 AND ts >= $2::timestamptz AND ts <= $3::timestamptz
                    ORDER BY ts ASC;
                `, [tag.id, actualStart, new Date(currentNowMs)]);

                for (let i = 0; i < searchRows.length; i++) {
                    const r = searchRows[i];
                    if (r.value === null || r.value === undefined) continue;
                    const val = Number(r.value);
                    if (isNaN(val)) continue;

                    if (!armed) {
                        if (isFall && val > startThreshold) armed = true;
                        if (!isFall && val < startThreshold) armed = true;
                    } else {
                        const crossed = isFall ? (val <= startThreshold) : (val >= startThreshold);
                        if (crossed) {
                            crossedStartMs = new Date(r.ts).getTime();
                            console.log(`[BatchLine Continuous]: Tag "${tag.name}" crossed START threshold (${startThreshold}) at ${r.ts} (direction: ${isFall ? 'fall' : 'rise'}). Starting interval collection.`);
                            break;
                        }
                    }
                }

                if (crossedStartMs === null) {
                    console.log(`[BatchLine Continuous]: Tag "${tag.name}" has not yet crossed START threshold (${startThreshold}) [direction: ${isFall ? 'fall' : 'rise'}, armed: ${armed}]. Waiting for threshold crossing...`);
                    return;
                }
            }

            const effectiveStartMs = crossedStartMs;
            const bucketsToProcess = [];

            while (true) {
                const bStartMs = effectiveStartMs + nextBucketIndex * intervalMs;
                const bEndMs = bStartMs + intervalMs;

                // Bucket is ready once its full window has elapsed
                if (currentNowMs >= bEndMs) {
                    bucketsToProcess.push({
                        index: nextBucketIndex,
                        bStartMs,
                        bEndMs
                    });
                    nextBucketIndex++;

                    // Limit batch size per dispatch to prevent massive payloads on large backlogs
                    if (bucketsToProcess.length >= (CONFIG.MAX_PERIODIC_REPEATS || 50)) {
                        break;
                    }
                } else {
                    break;
                }
            }

            if (bucketsToProcess.length === 0) return;

            const rangeStart = new Date(bucketsToProcess[0].bStartMs);
            const rangeEnd = new Date(bucketsToProcess[bucketsToProcess.length - 1].bEndMs);

            const { rows: readings } = await query(`
                SELECT ts, value
                FROM readings
                WHERE tag_id = $1
                  AND ts >= $2::timestamptz
                  AND ts <= $3::timestamptz
                ORDER BY ts ASC;
            `, [tag.id, rangeStart, rangeEnd]);

            const setOfValues = [];
            for (const b of bucketsToProcess) {
                const bucketReadings = readings.filter(r => {
                    const rMs = new Date(r.ts).getTime();
                    return rMs >= b.bStartMs && rMs < b.bEndMs;
                });

                let resolvedVal;
                if (bucketReadings.length > 0) {
                    resolvedVal = computeMetricValue(bucketReadings.map(r => Number(r.value)), metric);
                    lastKnown = resolvedVal;
                } else {
                    resolvedVal = lastKnown;
                }

                setOfValues.push({
                    repeat_no: b.index + 1,
                    value: formatReadingValue(resolvedVal, tag.display_digits),
                    executed_timestamp: formatExecutedTimestamp(new Date(b.bStartMs)),
                    executed_user_email: ctx.triggeredByEmail || null
                });
            }

            console.log(`[BatchLine Continuous 30s]: Dispatching set of ${setOfValues.length} bucketed values (repeats ${setOfValues[0].repeat_no}..${setOfValues[setOfValues.length - 1].repeat_no}) for tag "${tag.name}" (batch: ${ctx.batchId}, instruction: ${ctx.refInstruction})...`);

            const cbResult = await sendBatchLineInstructionUpdate({
                refInstruction: ctx.refInstruction,
                batchId: ctx.batchId,
                callbackKey: ctx.callbackKey,
                actualResult: setOfValues
            });

            if (!cbResult?.ok) {
                const detail = cbResult?.data?.error?.detail || cbResult?.error || '';
                if (String(detail).toLowerCase().includes('cannot exceed the target repeat')) {
                    console.log(`[BatchLine Continuous]: Instruction ${ctx.refInstruction} reached Target Repeat limit in BatchLine. Stopping continuous collection.`);
                    cleanup();
                    activeFutureIntervalJobs.delete(jobKey);
                    return;
                }
                await reportError(`[BatchLine Continuous 30s]: Failed to push set of ${setOfValues.length} bucketed values`, ctx, detail);
            }

            // If there are still older backlogged buckets, process next chunk immediately
            const nextBucketEndMs = effectiveStartMs + (nextBucketIndex + 1) * intervalMs;
            if (Date.now() >= nextBucketEndMs) {
                setImmediate(processCompletedBuckets);
            }
        } catch (err) {
            console.error('[BatchLine Continuous 30s Error]:', err);
            await reportError(`[BatchLine Continuous 30s Error]: ${err.message}`, ctx, err.stack);
        } finally {
            isProcessing = false;
        }
    };

    let intervalId = null;
    let startTimeoutId = null;

    const cleanup = () => {
        if (startTimeoutId) clearTimeout(startTimeoutId);
        if (intervalId) clearInterval(intervalId);
    };

    const stop = async () => {
        cleanup();
        console.log(`[BatchLine Continuous]: Stopping continuous job for instruction ${ctx.refInstruction} (${tag.name}). Flushing final buckets...`);
        await processCompletedBuckets();
        console.log(`[BatchLine Continuous]: Final buckets flushed. Total repeats sent: ${nextBucketIndex}.`);
    };

    const CADENCE_MS = 30000;
    const nowMs = Date.now();

    if (startMs <= nowMs) {
        // RefStartTime is in past or now: immediately check threshold / push completed buckets
        console.log(`[BatchLine Continuous]: RefStartTime (${actualStart.toISOString()}) is past/now. Starting dispatcher...`);
        setImmediate(processCompletedBuckets);
        intervalId = setInterval(processCompletedBuckets, CADENCE_MS);
    } else {
        // RefStartTime is in future: schedule to start when RefStartTime arrives
        const msUntilStart = startMs - nowMs;
        console.log(`[BatchLine Continuous]: RefStartTime (${actualStart.toISOString()}) is in future. Waiting ${Math.round(msUntilStart / 1000)}s to begin 30s cadence...`);
        startTimeoutId = setTimeout(() => {
            console.log(`[BatchLine Continuous]: RefStartTime reached (${actualStart.toISOString()}). Starting 30s cadence dispatcher.`);
            setImmediate(processCompletedBuckets);
            intervalId = setInterval(processCompletedBuckets, CADENCE_MS);
        }, msUntilStart);
    }

    const jobRecord = {
        jobKey,
        batchId: ctx.batchId,
        refInstruction: ctx.refInstruction,
        cleanRefInstruction: cleanRef,
        tagId: tag.id,
        tagName: tag.name,
        cleanup,
        stop,
        getNextBucketIndex: () => nextBucketIndex,
        get startTimeoutId() { return startTimeoutId; },
        get intervalId() { return intervalId; },
        startedAt: new Date()
    };

    activeFutureIntervalJobs.set(jobKey, jobRecord);
}

async function handlePrintLabelInstruction(req, res) {
    let ctx = null;
    try {
        const parsed = parsePrintLabelPayload(req.body);

        console.log('================================================================================');
        console.log('[BatchLine Webhook]: Parsed parameters summary:', JSON.stringify({
            batch_id: parsed.batchId,
            callback_key: parsed.callbackKey,
            ref_instruction: parsed.refInstruction,
            parameters: parsed.parameters,
            parsed_dates: parsed.parsedDates,
            incoming_instruction_ids: parsed.incomingInstructionIds
        }, null, 2));

        // 1. Check if this request is a STOP signal for an active continuous or future interval job
        const incomingIds = [...(parsed.incomingInstructionIds || [])];
        if (parsed.refInstruction && !incomingIds.includes(cleanInstructionId(parsed.refInstruction))) {
            incomingIds.push(cleanInstructionId(parsed.refInstruction));
        }

        if (parsed.batchId && incomingIds.length > 0) {
            const stoppedJobs = [];
            for (const instId of incomingIds) {
                const cleanInst = cleanInstructionId(instId);
                const jobKey = `${parsed.batchId}_${cleanInst}`;

                let targetJobKey = null;
                if (activeFutureIntervalJobs.has(jobKey)) {
                    targetJobKey = jobKey;
                } else {
                    for (const [k, job] of activeFutureIntervalJobs.entries()) {
                        if (job.batchId === parsed.batchId && (job.cleanRefInstruction === cleanInst || cleanInstructionId(job.refInstruction) === cleanInst)) {
                            targetJobKey = k;
                            break;
                        }
                    }
                }

                if (targetJobKey) {
                    const job = activeFutureIntervalJobs.get(targetJobKey);
                    console.log(`[BatchLine PrintLabel]: Received STOP signal for instruction ${job.refInstruction} on batch ${parsed.batchId}. Stopping job.`);
                    if (typeof job.stop === 'function') {
                        await job.stop();
                    } else if (typeof job.cleanup === 'function') {
                        job.cleanup();
                    }
                    activeFutureIntervalJobs.delete(targetJobKey);
                    stoppedJobs.push({
                        refInstruction: job.refInstruction,
                        totalRepeatsSent: typeof job.getNextBucketIndex === 'function' ? job.getNextBucketIndex() : null
                    });
                }
            }

            if (stoppedJobs.length > 0) {
                return res.json({
                    status: 'stopped',
                    message: `Continuous periodic collection stopped for instruction(s): ${stoppedJobs.map(j => j.refInstruction).join(', ')}`,
                    batch_id: parsed.batchId,
                    stopped_jobs: stoppedJobs
                });
            }

            // If payload has no RefElement and no RefStartTime, but mentions instructions,
            // acknowledge gracefully (e.g. stop signal received when no job was active or manual value input)
            if (!parsed.parameters.RefElement && !parsed.parameters.RefStartTime) {
                console.log(`[BatchLine PrintLabel]: Received instruction update for [${parsed.incomingInstructionIds.join(', ')}] on batch ${parsed.batchId} with no active job. Acknowledged.`);
                return res.json({
                    status: 'acknowledged',
                    message: `No active continuous job found for instruction(s) ${parsed.incomingInstructionIds.join(', ')}`,
                    batch_id: parsed.batchId
                });
            }
        }

        if (!parsed.parameters.RefElement) {
            await reportError('[BatchLine PrintLabel]: Missing required RefElement in instruction parameters', { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
            return res.status(400).json({ error: 'Missing required RefElement in instruction parameters' });
        }

        if (!parsed.parameters.RefStartTime) {
            await reportError('[BatchLine PrintLabel]: Missing required RefStartTime in instruction parameters', { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
            return res.status(400).json({ error: 'Missing required RefStartTime in instruction parameters' });
        }

        const startDate = parseBatchLineDate(parsed.parameters.RefStartTime);
        if (!startDate || isNaN(startDate.getTime())) {
            const errMsg = `Invalid date format for RefStartTime ("${parsed.parameters.RefStartTime}")`;
            await reportError(`[BatchLine PrintLabel]: ${errMsg}`, { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
            return res.status(400).json({ error: errMsg });
        }

        let actualStart = startDate;
        let actualEnd = null;

        if (parsed.parameters.RefEndTime) {
            const endDate = parseBatchLineDate(parsed.parameters.RefEndTime);
            if (!endDate || isNaN(endDate.getTime())) {
                const errMsg = `Invalid date format for RefEndTime ("${parsed.parameters.RefEndTime}")`;
                await reportError(`[BatchLine PrintLabel]: ${errMsg}`, { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
                return res.status(400).json({ error: errMsg });
            }
            [actualStart, actualEnd] = startDate > endDate ? [endDate, startDate] : [startDate, endDate];
        }

        ctx = {
            topic: parsed.topic,
            batchId: parsed.batchId,
            callbackKey: parsed.callbackKey,
            refElement: parsed.parameters.RefElement,
            refInstruction: parsed.refInstruction,
            refStartTime: actualStart.toISOString(),
            refEndTime: actualEnd ? actualEnd.toISOString() : null,
            refType: parsed.parameters.RefType,
            triggeredByEmail: parsed.user?.executedUserEmail || req.body.TriggeredByEmail || null,
            instructionDescription: '',
            parsedParameters: parsed.parameters,
            instruction: req.body
        };

        const tag = await resolveTag(ctx.refElement, ctx);
        if (!tag) {
            await reportError(`[BatchLine PrintLabel]: Could not resolve tag for RefElement: "${ctx.refElement}"`, ctx);
            return res.status(404).json({ error: `Could not resolve tag for RefElement: "${ctx.refElement}"` });
        }

        const rawStart = parsed.parameters.START;
        const hasStart = rawStart !== null && rawStart !== '' && !isNaN(parseFloat(rawStart));
        const rawStop = parsed.parameters.STOP;
        const hasStop = rawStop !== null && rawStop !== '' && !isNaN(parseFloat(rawStop));

        const intervalConfig = parseIntervalString(parsed.parameters.INTERVAL);
        const durationMinutes = parseDurationString(parsed.parameters.DURATION);

        // Mode 1: Continuous Interval Mode (RefEndTime is omitted and INTERVAL is specified)
        if (!actualEnd) {
            if (!intervalConfig) {
                const errMsg = 'Missing required RefEndTime in instruction parameters (or INTERVAL for continuous periodic collection)';
                await reportError(`[BatchLine PrintLabel]: ${errMsg}`, ctx);
                return res.status(400).json({ error: errMsg });
            }
            const startThreshold = hasStart ? parseFloat(rawStart) : null;
            const startDirection = parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null;
            console.log(`[BatchLine PrintLabel]: Identified Continuous Interval Mode for tag "${tag.name}" (batch: ${ctx.batchId}, START=${startThreshold ?? 'none'}, DIRECTION=${startDirection ?? 'auto'}, INTERVAL=${intervalConfig.rawInterval}, Metric=${resolveMetric(ctx.refType)})`);
            return await handleContinuousIntervalMode(ctx, res, tag, actualStart, intervalConfig, startThreshold, startDirection);
        }

        // Mode 2: Future Interval Record Mode (INTERVAL specified and RefEndTime is in future)
        // Checked BEFORE historical Profile/Record modes so ongoing/future interval recordings
        // push past intervals immediately and continue pushing every 30s until RefEndTime.
        if (intervalConfig && actualEnd.getTime() > Date.now()) {
            const startThreshold = hasStart ? parseFloat(rawStart) : null;
            const stopThreshold = hasStop ? parseFloat(rawStop) : null;
            const startDirection = parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null;
            console.log(`[BatchLine PrintLabel]: Identified Future Interval Record Mode for tag "${tag.name}" (batch: ${ctx.batchId}, START=${startThreshold ?? 'none'}, STOP=${stopThreshold ?? 'none'}, INTERVAL=${intervalConfig.rawInterval}, Metric=${resolveMetric(ctx.refType)}, RefEndTime in future: ${actualEnd.toISOString()})`);
            return await handleFutureIntervalRecordMode(ctx, res, tag, actualStart, actualEnd, intervalConfig, startThreshold, startDirection, stopThreshold, durationMinutes);
        }

        // Mode 2b: Future/Live Profile Mode (START is specified with future RefEndTime or DURATION extending into future)
        if (hasStart && (actualEnd.getTime() > Date.now() || (durationMinutes && durationMinutes > 0))) {
            const startThreshold = parseFloat(rawStart);
            const stopThreshold = hasStop ? parseFloat(rawStop) : null;
            const startDirection = parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null;

            let effectiveIntervalConfig = intervalConfig;
            if (!effectiveIntervalConfig) {
                const sampleCount = CONFIG.MAX_PROFILE_SAMPLES || 30;
                const durMs = (durationMinutes && durationMinutes > 0)
                    ? (durationMinutes * 60 * 1000)
                    : Math.max(1000, actualEnd.getTime() - actualStart.getTime());
                const intervalMs = Math.max(1000, Math.round(durMs / sampleCount));
                effectiveIntervalConfig = {
                    rawInterval: `${Math.round(intervalMs / 1000)}s`,
                    intervalMinutes: intervalMs / 60000,
                    intervalMs
                };
            }

            let effectiveEnd = actualEnd;
            if (durationMinutes && durationMinutes > 0) {
                const minEndMs = actualStart.getTime() + durationMinutes * 60 * 1000;
                if (!effectiveEnd || effectiveEnd.getTime() < minEndMs) {
                    effectiveEnd = new Date(minEndMs);
                }
            }

            if (effectiveEnd.getTime() > Date.now()) {
                console.log(`[BatchLine PrintLabel]: Identified Future/Live Profile Mode for tag "${tag.name}" (batch: ${ctx.batchId}, START=${startThreshold}, DURATION=${durationMinutes ?? 'none'}m)`);
                return await handleFutureIntervalRecordMode(ctx, res, tag, actualStart, effectiveEnd, effectiveIntervalConfig, startThreshold, startDirection, stopThreshold, durationMinutes);
            }
        }

        // Mode 3: Profile Mode (START is specified and RefEndTime is in past/now)
        if (hasStart) {
            const profileConfig = {
                start: parseFloat(rawStart),
                stop: hasStop ? parseFloat(rawStop) : null,
                durationMinutes,
                direction: parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null,
                metric: resolveMetric(ctx.refType)
            };
            console.log(`[BatchLine PrintLabel]: Identified Profile Mode for tag "${tag.name}" (batch: ${ctx.batchId}, START=${profileConfig.start}, STOP=${profileConfig.stop}, INTERVAL=${intervalConfig?.rawInterval || 'none'}, Metric=${profileConfig.metric})`);
            return await handleProfileMode(ctx, res, tag, actualStart, actualEnd, profileConfig, intervalConfig);
        }

        // Mode 4: Record Mode (Default when START is omitted and RefEndTime is in past/now; uses interval if specified, or downsamples to MAX_PROFILE_SAMPLES)
        console.log(`[BatchLine PrintLabel]: Identified Record Mode for tag "${tag.name}" (batch: ${ctx.batchId}, INTERVAL=${intervalConfig?.rawInterval || 'none'}, Metric=${resolveMetric(ctx.refType)})`);
        return await handleRecordMode(ctx, res, tag, actualStart, actualEnd, intervalConfig);
    } catch (err) {
        console.error('[Print Label Instruction Webhook Error]:', err);
        await reportError('[Print Label Webhook Fatal Error]: ' + err.message, ctx || {}, err.stack);
        return res.status(500).json({ error: err.message });
    }
}

// ===========================================================================
// MAIN WEBHOOK ROUTES
// ===========================================================================

/**
 * BatchLine Instruction Webhook (/instruction)
 */
router.post('/instruction', async (req, res) => {
    let ctx = null;
    try {
        const body = req.body || {};
        const topic = body.Topic || '';

        // Check if this is the print_label_instruction hook
        if (topic === 'print_label_instruction.update' || (body.Data?.Batch?.Phases && !body.Data?.Batch?.Phase)) {
            return await handlePrintLabelInstruction(req, res);
        }

        ctx = extractInstructionPayload(req.body);

        if (ctx.rawEventType === undefined || ctx.rawEventType === null || ctx.rawEventType === '' || Number.isNaN(Number(ctx.rawEventType))) {
            // await reportError('[BatchLine Error]: Missing required EventType in instruction payload', ctx);
            console.log("/instruction received, no action is needed.")
            return res.status(400).json({ error: 'Missing required EventType in instruction payload' });
        }

        const eventType = Number(ctx.rawEventType);

        if (eventType === 1) {
            return await handleCase1PointInTime(ctx, res);
        }

        if (eventType === 2) {
            return await handleCase2PhaseTimestamp(ctx, res);
        }

        if (eventType === 3) {
            return await handleCase3TimeRange(ctx, res);
        }

        const msg = `EventType ${eventType} not yet implemented`;
        await reportError(`[BatchLine Error]: ${msg}`, ctx);
        return res.status(501).json({
            error: msg,
            batchId: ctx.batchId,
            refInstruction: ctx.refInstruction
        });
    } catch (err) {
        await reportError('[Instruction Webhook Fatal Error]: ' + err.message, ctx || {}, err.stack);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * BatchLine Status Webhook Endpoint (/status)
 */
router.post('/status', async (req, res) => {
    try {
        console.log('[Status Webhook] Received status payload:', JSON.stringify(req.body));
        res.json({
            status: 'received',
            topic: req.body.Topic || null,
            timestamp: new Date()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/status', (req, res) => {
    res.json({ status: 'ready', endpoint: '/api/v1/status' });
});

export default router;