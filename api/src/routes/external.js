import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers: Tag Resolution & Reading Retrieval for BatchLine
// ---------------------------------------------------------------------------
async function resolveTag(refElement) {
    if (!refElement) return null;
    const trimmed = refElement.trim();

    // 1. Direct tag name match (e.g. "R1.TEMP")
    let { rows } = await query(`
        SELECT t.id, t.name, t.parameter, t.display_digits, t.units, a.code as asset_code 
        FROM tags t 
        JOIN assets a ON t.asset_id = a.id 
        WHERE LOWER(t.name) = LOWER($1);
    `, [trimmed]);
    if (rows.length > 0) return rows[0];

    // 2. Parse by dot (e.g. "Reactor 1.temp")
    if (trimmed.includes('.')) {
        const dotIndex = trimmed.indexOf('.');
        const assetStr = trimmed.slice(0, dotIndex).trim();
        const paramStr = trimmed.slice(dotIndex + 1).trim();

        let assetCodeCandidate = assetStr.toUpperCase();
        const match = assetStr.match(/reactor\s*(\d+)/i);
        if (match) {
            assetCodeCandidate = `R${match[1]}`;
        }

        ({ rows } = await query(`
            SELECT t.id, t.name, t.parameter, t.display_digits, t.units, a.code as asset_code
            FROM tags t
            JOIN assets a ON t.asset_id = a.id
            WHERE (LOWER(a.code) = LOWER($1) OR LOWER(a.display_name) LIKE LOWER($2))
              AND (
                LOWER(t.parameter) = LOWER($3)
                OR LOWER(t.name) LIKE LOWER($4)
                OR LOWER(t.description) LIKE LOWER($4)
              )
            LIMIT 1;
        `, [assetCodeCandidate, `%${assetStr}%`, paramStr, `%${paramStr}%`]));

        if (rows.length > 0) return rows[0];
    }

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
            body: JSON.stringify(payload)
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

            // Trigger special "record" mode if InstructionDescription contains exact "[RECORD]" (all caps) or RefType is "record"
            const hasRecordTag = typeof instructionDescription === 'string' && instructionDescription.includes('[RECORD]');
            const isRecordType = String(refType || '').trim().toUpperCase() === 'RECORD';
            const isRecordMode = hasRecordTag || isRecordType;

            let statField = null;
            if (!isRecordMode) {
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

            // Special Mode: "record" - Send values within time range (up to 10 values, downsampled via 10 time buckets)
            if (isRecordMode) {
                const countRes = await query(`
                    SELECT COUNT(*)::int AS total_count
                    FROM readings
                    WHERE tag_id = $1
                      AND ts >= $2::timestamptz
                      AND ts <= $3::timestamptz;
                `, [tag.id, actualStart, actualEnd]);

                const totalCount = countRes.rows[0]?.total_count || 0;
                if (totalCount === 0) {
                    return res.status(404).json({
                        error: `No readings found for tag "${tag.name}" between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`
                    });
                }

                let valuesToSend = [];

                if (totalCount <= 10) {
                    // Send all values if not more than 10
                    const { rows } = await query(`
                        SELECT ts, value
                        FROM readings
                        WHERE tag_id = $1
                          AND ts >= $2::timestamptz
                          AND ts <= $3::timestamptz
                        ORDER BY ts ASC;
                    `, [tag.id, actualStart, actualEnd]);

                    valuesToSend = rows.map((r, idx) => ({
                        repeat_no: idx + 1,
                        value: formatReadingValue(r.value, tag.display_digits),
                        raw_value: r.value,
                        ts: r.ts
                    }));
                } else {
                    // Split into 10 time ranges and compute average of each
                    const { rows } = await query(`
                        WITH bounds AS (
                            SELECT $2::timestamptz AS t_start, $3::timestamptz AS t_end
                        ),
                        buckets AS (
                            SELECT 
                                i AS bucket_no,
                                t_start + (i * (t_end - t_start) / 10) AS b_start,
                                t_start + ((i + 1) * (t_end - t_start) / 10) AS b_end
                            FROM bounds, generate_series(0, 9) AS i
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
                         AND (CASE WHEN b.bucket_no = 9 THEN r.ts <= b.b_end ELSE r.ts < b.b_end END)
                        GROUP BY b.bucket_no, b.b_start, b.b_end
                        ORDER BY b.bucket_no;
                    `, [tag.id, actualStart, actualEnd]);

                    // Fill forward / backward in case any bucket had zero samples (e.g. data gaps)
                    let lastKnown = null;
                    const bucketList = rows.map(r => {
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
                            samples: b.samples
                        };
                    });
                }

                // Send each value to BatchLine in a loop with 1-second delay between pushes
                const callbackResults = [];
                for (let i = 0; i < valuesToSend.length; i++) {
                    const item = valuesToSend[i];
                    const cbResult = await sendBatchLineInstructionUpdate({
                        refInstruction,
                        batchId,
                        actualResult: [
                            {
                                repeat_no: item.repeat_no,
                                value: item.value,
                                executed_user_email: instruction.TriggeredByEmail || null
                            }
                        ]
                    });

                    if (cbResult?.ok) {
                        console.log(`Successfully updated BatchLine Case 3 record (repeat_no: ${item.repeat_no})`);
                    } else {
                        console.error(`Failed to update BatchLine Case 3 record (repeat_no: ${item.repeat_no})`, JSON.stringify(cbResult?.data?.error?.detail || cbResult?.error));
                    }

                    callbackResults.push({
                        repeat_no: item.repeat_no,
                        value: item.value,
                        callback: cbResult
                    });

                    // Delay 1 second before the next push
                    if (i < valuesToSend.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
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