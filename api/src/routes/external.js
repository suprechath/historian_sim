import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers: Tag Resolution & Reading Retrieval for BatchLine
// ---------------------------------------------------------------------------
async function resolveTag(refElement) {
    if (!refElement) return null;
    const trimmed = refElement.trim();
    const dotIndex = trimmed.indexOf('.');
    const assetStr = trimmed.slice(0, dotIndex).trim();
    const paramStr = trimmed.slice(dotIndex + 1).trim();
    let assetCodeCandidate = assetStr.toUpperCase();
    const match = assetStr.match(/reactor\s*(\d+)/i);
    if (match) {
        assetCodeCandidate = `R${match[1]}`;
    }
    const tagCandidate = `${assetCodeCandidate}.${paramStr}`;

    // 1. Direct tag name match (e.g. "R1.TEMP")
    let { rows } = await query(`
        SELECT t.id, t.name, t.parameter, t.display_digits, t.units, a.code as asset_code 
        FROM tags t 
        JOIN assets a ON t.asset_id = a.id 
        WHERE LOWER(t.name) = LOWER($1);
    `, [tagCandidate]);
    if (rows.length > 0) return rows[0];
    console.error("Tag not found", tagCandidate, rows);
    return null;
}

async function getNearestReading(tagId, refTime) {
    const targetDate = refTime ? new Date(refTime) : new Date();

    // 1. Query readings table for nearest timestamp
    const { rows } = await query(`
        SELECT r.ts, r.value, r.quality
        FROM readings r
        WHERE r.tag_id = $1
        ORDER BY ABS(EXTRACT(EPOCH FROM (r.ts - $2::timestamptz))) ASC
        LIMIT 1;
    `, [tagId, targetDate]);

    if (rows.length > 0) {
        return rows[0];
    }

    // 2. Fallback to latest snapshot
    const { rows: snapshotRows } = await query(`
        SELECT s.ts, s.value, s.quality
        FROM snapshots s
        WHERE s.tag_id = $1
        LIMIT 1;
    `, [tagId]);

    return snapshotRows.length > 0 ? snapshotRows[0] : null;
}

function formatReadingValue(value, displayDigits) {
    if (value === null || value === undefined) return '0';
    const num = Number(value);
    if (isNaN(num)) return String(value);
    if (displayDigits !== null && displayDigits !== undefined) {
        if (displayDigits === 0) {
            return String(Math.round(num));
        }
        return String(Number(num.toFixed(displayDigits)));
    }
    return String(Math.round(num));
}

function formatBatchLineDate(date) {
    if (!date) return null;
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getUTCMonth()];
    const day = String(d.getUTCDate()).padStart(2, '0');
    const year = d.getUTCFullYear();
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const minutes = String(d.getUTCMinutes()).padStart(2, '0');
    const seconds = String(d.getUTCSeconds()).padStart(2, '0');

    return `${month} ${day}, ${year} ${hours}:${minutes}:${seconds}`;
}

function formatExecutedTimestamp(date) {
    if (!date) return null;
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19) + '+00:00';
}

function extractAssetCode(str) {
    if (!str) return null;
    const match = String(str).match(/(?:Reactor\s*|R)(\d+)/i);
    return match ? `R${match[1]}` : null;
}

async function findEventForBatch({ refRecipe, refEvent, refElement }) {
    if (!refRecipe || !refEvent) return null;

    const trimmedRecipe = String(refRecipe).trim();
    const trimmedEvent = String(refEvent).trim();
    const assetCode = extractAssetCode(refElement);

    // 1. Primary lookup: join batches and assets
    let sql = `
        SELECT e.id, e.name, e.level, e.started_at, e.ended_at, a.code AS asset_code, b.batch_id
        FROM events e
        JOIN batches b ON e.batch_pk = b.id
        JOIN assets a ON e.asset_id = a.id
        WHERE (LOWER(TRIM(b.batch_id)) = LOWER($1) OR b.id::text = $1)
          AND (
            LOWER(TRIM(e.name)) = LOWER($2)
            OR REPLACE(LOWER(TRIM(e.name)), '_', ' ') = REPLACE(LOWER(TRIM($2)), '_', ' ')
            OR LOWER(TRIM(e.level)) = LOWER($2)
            OR (e.level = 'Phase' AND LOWER(e.name) LIKE LOWER($3))
          )
    `;
    const params = [trimmedRecipe, trimmedEvent, `%${trimmedEvent}%`];

    if (assetCode) {
        params.push(assetCode);
        sql += ` ORDER BY CASE WHEN LOWER(a.code) = LOWER($${params.length}) THEN 0 ELSE 1 END, e.started_at DESC LIMIT 1;`;
    } else {
        sql += ` ORDER BY e.started_at DESC LIMIT 1;`;
    }

    let { rows } = await query(sql, params);
    if (rows.length > 0) return rows[0];

    // 2. Fallback lookup: if asset code is known, check events table directly
    if (assetCode) {
        ({ rows } = await query(`
            SELECT e.id, e.name, e.level, e.started_at, e.ended_at, a.code AS asset_code, null AS batch_id
            FROM events e
            JOIN assets a ON e.asset_id = a.id
            WHERE LOWER(a.code) = LOWER($1)
              AND (
                LOWER(TRIM(e.name)) = LOWER($2)
                OR REPLACE(LOWER(TRIM(e.name)), '_', ' ') = REPLACE(LOWER(TRIM($2)), '_', ' ')
                OR LOWER(TRIM(e.level)) = LOWER($2)
                OR (e.level = 'Phase' AND LOWER(e.name) LIKE LOWER($3))
              )
            ORDER BY e.started_at DESC
            LIMIT 1;
        `, [assetCode, trimmedEvent, `%${trimmedEvent}%`]));

        if (rows.length > 0) return rows[0];
    }

    return null;
}

async function sendBatchLineInstructionUpdate({ refInstruction, batchId, actualResult }) {
    if (!refInstruction || !batchId || !actualResult) return null;

    const baseUrl = process.env.BATCHLINE_BASE_URL || 'https://batch-demo.bl-client.com';
    const callbackUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1/batch/instruction/update/${encodeURIComponent(refInstruction)}`;
    const apiKey = process.env.BATCHLINE_API_KEY || '';

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers['x-api-key'] = apiKey;
    } else {
        console.error('[BatchLine Callback Error]: Missing BATCHLINE_API_KEY in environment variables');
        return null;
    }

    // Ensure actual_result is properly formatted as an array
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

    try {
        const cbRes = await fetch(callbackUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000)
        });
        const cbText = await cbRes.text();
        let cbData;
        try { cbData = JSON.parse(cbText); } catch { cbData = cbText; }
        return {
            targetUrl: callbackUrl,
            status: cbRes.status,
            ok: cbRes.ok,
            data: cbData
        };
    } catch (cbErr) {
        console.error('[BatchLine Callback Error]:', cbErr.message);
        return {
            targetUrl: callbackUrl,
            error: cbErr.message
        };
    }
}

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
    LAST: 'last',
    RECORD: 'record',
    RECORDS: 'record'
};

// ---------------------------------------------------------------------------
// BatchLine Instruction Webhook Endpoint (/instruction)
// ---------------------------------------------------------------------------
router.post('/instruction', async (req, res) => {
    try {
        const body = req.body || {};
        const topic = body.Topic;
        const data = body.Data || {};
        const batch = data.Batch || {};
        const batchId = batch.BatchId || body.batch_id;
        const phase = batch.Phase || {};
        const step = phase.Step || {};
        const instruction = step.Instruction || {};

        const rawEventType = instruction.EventType !== undefined ? instruction.EventType : body.EventType;
        const instructionDescription = instruction.InstructionDescription || body.InstructionDescription || '';
        const refElement = instruction.RefElement || body.RefElement;
        const refTime = instruction.RefTime || body.RefTime;
        const refInstruction = instruction.RefInstruction || body.RefInstruction;
        const refRecipe = instruction.RefRecipe || body.RefRecipe;
        const refEvent = instruction.RefEvent || body.RefEvent;
        const refType = instruction.RefType || body.RefType;
        const refStartTime = instruction.RefStartTime || body.RefStartTime;
        const refEndTime = instruction.RefEndTime || body.RefEndTime;
        const callbackKey = body.CallbackKey;

        if (rawEventType === undefined || rawEventType === null || rawEventType === '' || Number.isNaN(Number(rawEventType))) {
            console.error('[BatchLine Callback Error]: Missing required EventType in instruction payload');
            return res.status(400).json({ error: 'Missing required EventType in instruction payload' });
        }
        const eventType = Number(rawEventType);

        // Case 1: Point-in-time value lookup
        if (eventType === 1) {
            if (!refElement) {
                console.error('[BatchLine Callback Error]: Missing required RefElement in instruction payload');
                return res.status(400).json({ error: 'Missing required RefElement in instruction payload' });
            }

            const tag = await resolveTag(refElement);
            if (!tag) {
                return res.status(404).json({ error: `Could not resolve tag for RefElement: "${refElement}"` });
            }

            const reading = await getNearestReading(tag.id, refTime);
            if (!reading) {
                return res.status(404).json({ error: `No reading or snapshot found for tag "${tag.name}"` });
            }

            const formattedValue = formatReadingValue(reading.value, tag.display_digits);
            const executedTimestamp = formatExecutedTimestamp(reading.ts);

            // Post back to BatchLine using reusable function
            const callbackResult = await sendBatchLineInstructionUpdate({
                refInstruction,
                batchId,
                actualResult: [
                    {
                        repeat_no: 1,
                        value: formattedValue,
                        executed_timestamp: executedTimestamp,
                        executed_user_email: instruction.TriggeredByEmail || null
                    }
                ]
            });

            if (callbackResult.ok) {
                console.log('Successfully updated BatchLine case 1 instruction', callbackResult.data);
            }
            else {
                console.error('Failed to update BatchLine case 1 instruction', JSON.stringify(callbackResult.data.error.detail));
            }

            return res.json({
                status: 'success',
                case: 1,
                batch_id: batchId,
                tag: tag.name,
                ref_time: refTime,
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

        // Case 2: Start time / End time phase lookup
        if (eventType === 2) {
            const recipeBatchId = refRecipe || batchId;
            if (!recipeBatchId) {
                console.error('[BatchLine Callback Error]: Missing required RefRecipe in instruction payload');
                return res.status(400).json({ error: 'Missing required RefRecipe in instruction payload' });
            }
            if (!refEvent) {
                console.error('[BatchLine Callback Error]: Missing required RefEvent in instruction payload');
                return res.status(400).json({ error: 'Missing required RefEvent in instruction payload' });
            }
            if (!refType) {
                console.error('[BatchLine Callback Error]: Missing required RefType in instruction payload');
                return res.status(400).json({ error: 'Missing required RefType in instruction payload' });
            }

            const normalizedType = String(refType).trim().toLowerCase();
            const isStart = /^(starttime|started_at|start)$/i.test(normalizedType);
            const isEnd = /^(endtime|ended_at|end)$/i.test(normalizedType);

            if (!isStart && !isEnd) {
                return res.status(400).json({
                    error: `Invalid RefType: "${refType}". Expected "StartTime" or "EndTime"`
                });
            }

            const event = await findEventForBatch({
                refRecipe: recipeBatchId,
                refEvent,
                refElement
            });

            if (!event) {
                return res.status(404).json({
                    error: `Could not find phase/event "${refEvent}" for batch "${recipeBatchId}"`
                });
            }

            const selectedField = isStart ? 'started_at' : 'ended_at';
            const targetTime = isStart ? event.started_at : event.ended_at;

            if (!targetTime) {
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

            // Post back to BatchLine using reusable function
            const callbackResult = await sendBatchLineInstructionUpdate({
                refInstruction,
                batchId,
                actualResult: [
                    {
                        repeat_no: 1,
                        value: formattedTime,
                        executed_user_email: instruction.TriggeredByEmail || null
                    }
                ]
            });

            if (callbackResult.ok) {
                console.log('Successfully updated BatchLine Case 2 instruction', callbackResult.data);
            }
            else {
                console.error('Failed to update BatchLine Case 2 instruction', JSON.stringify(callbackResult.data.error.detail));
            }

            return res.json({
                status: 'success',
                case: 2,
                batch_id: batchId,
                ref_recipe: recipeBatchId,
                ref_event: refEvent,
                ref_type: refType,
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

        // Case 3: Calculated / Aggregate statistic over a time range
        if (eventType === 3) {
            if (!refElement) {
                console.error('[BatchLine Callback Error]: Missing required RefElement in instruction payload');
                return res.status(400).json({ error: 'Missing required RefElement in instruction payload' });
            }

            if (!refStartTime || !refEndTime) {
                console.error('[BatchLine Callback Error]: Missing required RefStartTime or RefEndTime in instruction payload');
                return res.status(400).json({ error: 'Missing required RefStartTime or RefEndTime in instruction payload' });
            }

            const startDate = new Date(refStartTime);
            const endDate = new Date(refEndTime);

            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                return res.status(400).json({
                    error: `Invalid date format for RefStartTime ("${refStartTime}") or RefEndTime ("${refEndTime}")`
                });
            }

            const [actualStart, actualEnd] = startDate > endDate ? [endDate, startDate] : [startDate, endDate];

            // 1. Check special profile mode:
            // Supports:
            // [RECORD_PROFILE: START=80, STOP=30]
            // [RECORD_PROFILE: START=70, DURATION= 200 DIRECTION=Fall]
            // [RECORD_PROFILE: START=30, DURATION= 200 DIRECTION=Rise]
            const profileBlockMatch = typeof instructionDescription === 'string'
                ? instructionDescription.match(/\[RECORD_PROFILE:\s*([^\]]+)\]/i)
                : null;
            let isProfileMode = false;
            let profileConfig = null;

            if (profileBlockMatch) {
                const content = profileBlockMatch[1];
                const startMatch = content.match(/\bSTART\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
                const stopMatch = content.match(/\bSTOP\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
                const durationMatch = content.match(/\bDURATION\s*=\s*(\d+(?:\.\d+)?)/i);
                const directionMatch = content.match(/\bDIRECTION\s*=\s*(Rise|Fall)/i);

                if (startMatch) {
                    isProfileMode = true;
                    profileConfig = {
                        start: parseFloat(startMatch[1]),
                        stop: stopMatch ? parseFloat(stopMatch[1]) : null,
                        durationMinutes: durationMatch ? parseFloat(durationMatch[1]) : null,
                        direction: directionMatch ? directionMatch[1].toLowerCase() : null
                    };
                }
            }
            const hasRecordTag = typeof instructionDescription === 'string' && /\[RECORD(?::|\s|\])/i.test(instructionDescription);
            const isRecordType = String(refType || '').trim().toUpperCase() === 'RECORD';
            const isRecordMode = !isProfileMode && (hasRecordTag || isRecordType);

            let statField = null;
            let profileMetric = 'avg';

            if (isProfileMode) {
                if (refType) {
                    const rTypeUpper = String(refType).trim().toUpperCase();
                    if (rTypeUpper === 'MIN' || rTypeUpper === 'MINIMUM') profileMetric = 'min';
                    else if (rTypeUpper === 'AVG' || rTypeUpper === 'AVERAGE' || rTypeUpper === 'MEAN') profileMetric = 'avg';
                    else profileMetric = 'max';
                }
            } else if (!isRecordMode) {
                if (!refType) {
                    console.error('[BatchLine Callback Error]: Missing required RefType in instruction payload');
                    return res.status(400).json({ error: 'Missing required RefType in instruction payload' });
                }

                const statKey = String(refType).trim().toUpperCase();
                statField = STAT_OPERATIONS[statKey];

                if (!statField) {
                    return res.status(400).json({
                        error: `Unsupported RefType operation: "${refType}". Supported operations: MAX, MIN, AVG, SUM, COUNT, STDDEV, VARIANCE, RANGE, MEDIAN, FIRST, LAST.`
                    });
                }
            }

            const tag = await resolveTag(refElement);
            if (!tag) {
                return res.status(404).json({ error: `Could not resolve tag for RefElement: "${refElement}"` });
            }
            console.log("tag.name", tag.name);
            console.log("tag.id", tag.id);

            // Special Mode: "record_profile"
            // Captures the first wave between START and STOP (or DURATION). If multiple waves exist, rids them off and retains ONLY the first wave.
            // If <= 30 values found, pushes directly to BatchLine.
            // If > 30 values found, downsamples and averages into exactly 30 consolidated values.
            if (isProfileMode) {
                const startThreshold = profileConfig.start;
                const stopThreshold = profileConfig.stop;

                // 1. Fetch readings within [actualStart, actualEnd] in chronological order
                const { rows } = await query(`
                    SELECT ts, value
                    FROM readings
                    WHERE tag_id = $1
                      AND ts >= $2::timestamptz
                      AND ts <= $3::timestamptz
                    ORDER BY ts ASC;
                `, [tag.id, actualStart, actualEnd]);

                if (rows.length === 0) {
                    return res.status(404).json({
                        error: `No readings found for tag "${tag.name}" between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`
                    });
                }

                // 2. Resolve start & stop directions
                let startDirection = profileConfig.direction;
                if (!startDirection) {
                    if (stopThreshold !== null) {
                        startDirection = (stopThreshold >= startThreshold) ? 'rise' : 'fall';
                    } else {
                        const firstValidRow = rows.find(r => r.value !== null && r.value !== undefined && !Number.isNaN(Number(r.value)));
                        const initialVal = firstValidRow ? Number(firstValidRow.value) : startThreshold;
                        startDirection = (initialVal <= startThreshold) ? 'rise' : 'fall';
                    }
                }
                const isFall = (startDirection === 'fall');
                const stopDirection = (stopThreshold !== null) ? ((stopThreshold >= startThreshold) ? 'rise' : 'fall') : null;

                // 3. Capture the FIRST wave between START and STOP (or DURATION) with edge/crossing detection
                let armed = false;
                let waveStartTs = null;
                let waveStopTs = null;

                const firstValidRow = rows.find(r => r.value !== null && r.value !== undefined && !Number.isNaN(Number(r.value)));
                const firstVal = firstValidRow ? Number(firstValidRow.value) : null;
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

                        if (reachedStart) {
                            waveStartTs = r.ts;
                        }
                    } else if (waveStartTs && !waveStopTs) {
                        // Wave has started, detect completion of the first wave
                        if (profileConfig.durationMinutes !== null && profileConfig.durationMinutes > 0) {
                            const durationMs = profileConfig.durationMinutes * 60 * 1000;
                            if (new Date(r.ts).getTime() - new Date(waveStartTs).getTime() >= durationMs) {
                                waveStopTs = r.ts;
                                break; // First wave achieved, discard subsequent waves!
                            }
                        } else if (stopThreshold !== null) {
                            const reachedStop = (stopDirection === 'rise') ? (val >= stopThreshold) : (val <= stopThreshold);
                            if (reachedStop) {
                                waveStopTs = r.ts;
                                break; // Stop at first wave, discard any subsequent waves!
                            }

                            // If wave aborted / reversed back past startThreshold before reaching stopThreshold:
                            // Reset so we capture the actual wave that successfully reaches stopThreshold!
                            const aborted = isFall ? (val > startThreshold) : (val < startThreshold);
                            if (aborted) {
                                waveStartTs = null;
                                armed = false;
                            }
                        }
                    }
                }

                if (!waveStartTs) {
                    // Fallback to first matching point in range
                    for (const r of rows) {
                        if (r.value === null || r.value === undefined) continue;
                        const val = Number(r.value);
                        if (Number.isNaN(val)) continue;
                        const match = isFall ? (val <= startThreshold) : (val >= startThreshold);
                        if (match) {
                            waveStartTs = r.ts;
                            break;
                        }
                    }
                }

                if (!waveStartTs) {
                    return res.status(404).json({
                        error: `Reading value for tag "${tag.name}" never ${startDirection === 'rise' ? 'rose to or above' : 'fell to or below'} START threshold (${startThreshold}) between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`
                    });
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

                // 4. Retain ONLY the first wave readings, ridding off any other waves
                const waveRows = rows.filter(r => {
                    if (r.value === null || r.value === undefined || Number.isNaN(Number(r.value))) return false;
                    const t = new Date(r.ts).getTime();
                    return t >= waveStart.getTime() && t <= waveStop.getTime();
                });

                const totalCount = waveRows.length;
                if (totalCount === 0) {
                    return res.status(404).json({
                        error: `No readings found for tag "${tag.name}" in the captured wave between ${waveStart.toISOString()} and ${waveStop.toISOString()}`
                    });
                }

                let valuesToSend = [];
                const durationMs = waveStop.getTime() - waveStart.getTime();

                // 5. If 30 or fewer values, or duration <= 1s, send raw readings directly
                if (totalCount <= 30 || durationMs <= 1000) {
                    valuesToSend = waveRows.slice(0, 30).map((r, idx) => ({
                        repeat_no: idx + 1,
                        value: formatReadingValue(r.value, tag.display_digits),
                        raw_value: r.value,
                        ts: r.ts,
                        executed_timestamp: formatExecutedTimestamp(r.ts)
                    }));
                } else {
                    // If exceed 30 values, downsample and average into exactly 30 time buckets
                    const { rows: bucketRows } = await query(`
                        WITH bounds AS (
                            SELECT $2::timestamptz AS t_start, $3::timestamptz AS t_end
                        ),
                        buckets AS (
                            SELECT 
                                i AS bucket_no,
                                t_start + (i * (t_end - t_start) / 30) AS b_start,
                                t_start + ((i + 1) * (t_end - t_start) / 30) AS b_end
                            FROM bounds, generate_series(0, 29) AS i
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
                         AND (CASE WHEN b.bucket_no = 29 THEN r.ts <= b.b_end ELSE r.ts < b.b_end END)
                        GROUP BY b.bucket_no, b.b_start, b.b_end
                        ORDER BY b.bucket_no;
                    `, [tag.id, waveStart, waveStop]);

                    // Fill forward / backward in case of any empty bucket
                    let lastKnown = null;
                    const bucketList = bucketRows.map(r => {
                        let metricVal = null;
                        if (profileMetric === 'min') metricVal = r.min_val;
                        else if (profileMetric === 'max') metricVal = r.max_val;
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

                // 6. Push to BatchLine with delay between pushes
                console.log(`[BatchLine Callback Profile]: Pushing ${valuesToSend.length} values for captured first wave...`);
                const callbackResults = [];
                for (let i = 0; i < valuesToSend.length; i++) {
                    const item = valuesToSend[i];
                    const executedTimestamp = item.executed_timestamp || formatExecutedTimestamp(item.bucket_start || item.ts);
                    const cbResult = await sendBatchLineInstructionUpdate({
                        refInstruction,
                        batchId,
                        actualResult: [
                            {
                                repeat_no: item.repeat_no,
                                value: item.value,
                                executed_timestamp: executedTimestamp,
                                executed_user_email: instruction.TriggeredByEmail || null
                            }
                        ]
                    });

                    if (cbResult?.ok) {
                        console.log(`Successfully updated BatchLine Case 3 profile (repeat_no: ${item.repeat_no}/${valuesToSend.length})`);
                    } else {
                        console.error(`Failed to update BatchLine Case 3 profile (repeat_no: ${item.repeat_no}/${valuesToSend.length})`, JSON.stringify(cbResult?.data?.error?.detail || cbResult?.error));
                    }

                    callbackResults.push({
                        repeat_no: item.repeat_no,
                        value: item.value,
                        executed_timestamp: executedTimestamp,
                        callback: cbResult
                    });

                    // Deploy delay between pushes
                    if (i < valuesToSend.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                }

                return res.json({
                    status: 'success',
                    case: 3,
                    mode: 'record_profile',
                    batch_id: batchId,
                    tag: tag.name,
                    metric: profileMetric.toUpperCase(),
                    start_threshold: startThreshold,
                    stop_threshold: profileConfig.stop ?? null,
                    duration_minutes: profileConfig.durationMinutes ?? null,
                    direction: startDirection,
                    wave_start: waveStart.toISOString(),
                    wave_stop: waveStop.toISOString(),
                    wave_duration_sec: Math.max(1, (waveStop - waveStart) / 1000),
                    total_samples: totalCount,
                    records_sent: valuesToSend.length,
                    records: valuesToSend,
                    callbacks: callbackResults
                });
            }

            // Special Mode: "record" - Send values within time range (consolidated into 30 values, deployed with 0.5s delay)
            if (isRecordMode) {
                // 1. Fetch all raw readings within [actualStart, actualEnd]
                const { rows: allRows } = await query(`
                    SELECT ts, value
                    FROM readings
                    WHERE tag_id = $1
                      AND ts >= $2::timestamptz
                      AND ts <= $3::timestamptz
                    ORDER BY ts ASC;
                `, [tag.id, actualStart, actualEnd]);

                if (allRows.length === 0) {
                    return res.status(404).json({
                        error: `No readings found for tag "${tag.name}" between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`
                    });
                }

                const totalCount = allRows.length;
                let valuesToSend = [];
                const durationMs = actualEnd.getTime() - actualStart.getTime();

                // 2. If 30 or fewer values, or duration <= 1s, send raw values directly
                if (totalCount <= 30 || durationMs <= 1000) {
                    valuesToSend = allRows.slice(0, 30).map((r, idx) => ({
                        repeat_no: idx + 1,
                        value: formatReadingValue(r.value, tag.display_digits),
                        raw_value: r.value,
                        ts: r.ts,
                        executed_timestamp: formatExecutedTimestamp(r.ts)
                    }));
                } else {
                    // If exceed 30 values, downsample and average into exactly 30 time buckets
                    const { rows: bucketRows } = await query(`
                        WITH bounds AS (
                            SELECT $2::timestamptz AS t_start, $3::timestamptz AS t_end
                        ),
                        buckets AS (
                            SELECT 
                                i AS bucket_no,
                                t_start + (i * (t_end - t_start) / 30) AS b_start,
                                t_start + ((i + 1) * (t_end - t_start) / 30) AS b_end
                            FROM bounds, generate_series(0, 29) AS i
                        )
                        SELECT 
                            b.bucket_no,
                            b.b_start,
                            b.b_end,
                            AVG(r.value) AS avg_value,
                            COUNT(r.value)::int AS samples
                        FROM buckets b
                        LEFT JOIN readings r 
                          ON r.tag_id = $1 
                         AND r.ts >= b.b_start 
                         AND (CASE WHEN b.bucket_no = 29 THEN r.ts <= b.b_end ELSE r.ts < b.b_end END)
                        GROUP BY b.bucket_no, b.b_start, b.b_end
                        ORDER BY b.bucket_no;
                    `, [tag.id, actualStart, actualEnd]);

                    // Fill forward / backward in case any bucket had zero samples (e.g. data gaps)
                    let lastKnown = null;
                    const bucketList = bucketRows.map(r => {
                        const avg = r.avg_value !== null && r.avg_value !== undefined ? Number(r.avg_value) : null;
                        if (avg !== null) lastKnown = avg;
                        return {
                            bucket_no: r.bucket_no,
                            b_start: r.b_start,
                            b_end: r.b_end,
                            value: avg ?? lastKnown,
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

                // 3. Send each value to BatchLine in a loop with 0.5s delay between pushes
                console.log(`[BatchLine Callback Record]: Pushing ${valuesToSend.length} consolidated values (with 0.5s interval)...`);
                const callbackResults = [];
                for (let i = 0; i < valuesToSend.length; i++) {
                    const item = valuesToSend[i];
                    const executedTimestamp = item.executed_timestamp || formatExecutedTimestamp(item.ts || item.bucket_start);
                    const cbResult = await sendBatchLineInstructionUpdate({
                        refInstruction,
                        batchId,
                        actualResult: [
                            {
                                repeat_no: item.repeat_no,
                                value: item.value,
                                executed_timestamp: executedTimestamp,
                                executed_user_email: instruction.TriggeredByEmail || null
                            }
                        ]
                    });

                    if (cbResult?.ok) {
                        console.log(`Successfully updated BatchLine Case 3 record (repeat_no: ${item.repeat_no}/30)`);
                    } else {
                        console.error(`Failed to update BatchLine Case 3 record (repeat_no: ${item.repeat_no}/30)`, JSON.stringify(cbResult?.data?.error?.detail || cbResult?.error));
                    }

                    callbackResults.push({
                        repeat_no: item.repeat_no,
                        value: item.value,
                        executed_timestamp: executedTimestamp,
                        callback: cbResult
                    });

                    // Deploy 0.5 sec delay for every push
                    if (i < valuesToSend.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                }

                return res.json({
                    status: 'success',
                    case: 3,
                    mode: 'record',
                    batch_id: batchId,
                    tag: tag.name,
                    ref_type: refType,
                    ref_start_time: refStartTime,
                    ref_end_time: refEndTime,
                    total_samples: totalCount,
                    records_sent: valuesToSend.length,
                    records: valuesToSend,
                    callbacks: callbackResults
                });
            }

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
                return res.status(404).json({
                    error: `No readings found for tag "${tag.name}" between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`
                });
            }

            let rawResult = stats[statField];
            if (rawResult === null || rawResult === undefined) {
                if (statField === 'stddev' || statField === 'variance') {
                    rawResult = 0;
                } else {
                    return res.status(404).json({
                        error: `Unable to compute "${refType}" for tag "${tag.name}" in the specified time range.`
                    });
                }
            }

            const formattedValue = (statField === 'sample_count')
                ? String(rawResult)
                : formatReadingValue(rawResult, tag.display_digits);

            // Post back to BatchLine using reusable function
            const callbackResult = await sendBatchLineInstructionUpdate({
                refInstruction,
                batchId,
                actualResult: [
                    {
                        repeat_no: 1,
                        value: formattedValue,
                        executed_user_email: instruction.TriggeredByEmail || null
                    }
                ]
            });

            if (callbackResult?.ok) {
                console.log('Successfully updated BatchLine Case 3 instruction', callbackResult.data);
            }
            else {
                console.error('Failed to update BatchLine Case 3 instruction', JSON.stringify(callbackResult?.data?.error?.detail || callbackResult?.error));
            }

            return res.json({
                status: 'success',
                case: 3,
                batch_id: batchId,
                tag: tag.name,
                ref_type: refType,
                operation: statField,
                ref_start_time: refStartTime,
                ref_end_time: refEndTime,
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

        return res.status(501).json({
            error: `EventType ${eventType} not yet implemented`,
            batchId,
            refInstruction
        });
    } catch (err) {
        console.error('[Instruction Webhook Error]:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// BatchLine Status Webhook Endpoint (/status)
// ---------------------------------------------------------------------------
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