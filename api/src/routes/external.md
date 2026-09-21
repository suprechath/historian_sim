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

async function sendBatchLineInstructionUpdate({ refInstruction, batchId, actualResult }) {
    if (!refInstruction) return null;

    const baseUrl = process.env.BATCHLINE_BASE_URL || 'https://batch-demo.bl-client.com';
    const callbackUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1/batch/instruction/update/${encodeURIComponent(refInstruction)}`;
    const apiKey = process.env.BATCHLINE_API_KEY || '';

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers['x-api-key'] = apiKey;
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

        const eventType = instruction.EventType !== undefined ? Number(instruction.EventType) : (body.EventType !== undefined ? Number(body.EventType) : 1);
        const refElement = instruction.RefElement || body.RefElement;
        const refTime = instruction.RefTime || body.RefTime;
        const refInstruction = instruction.RefInstruction || body.RefInstruction;
        const callbackKey = body.CallbackKey;

        if (!refElement) {
            return res.status(400).json({ error: 'Missing required RefElement in instruction payload' });
        }

        // Case 1: Point-in-time value lookup
        if (eventType === 1) {
            const tag = await resolveTag(refElement);
            if (!tag) {
                return res.status(404).json({ error: `Could not resolve tag for RefElement: "${refElement}"` });
            }

            const reading = await getNearestReading(tag.id, refTime);
            if (!reading) {
                return res.status(404).json({ error: `No reading or snapshot found for tag "${tag.name}"` });
            }

            const formattedValue = formatReadingValue(reading.value, tag.display_digits);

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
                    quality: reading.quality
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


















// ---------------------------------------------------------------------------
// Tag Metadata & Historical Readings (EBR Cases 1 & 3)
// ---------------------------------------------------------------------------
// router.get('/tags', async (req, res) => {
//     const { asset, cpp } = req.query;
//     try {
//         let sql = `
//       SELECT 
//         t.id, t.name, t.description, t.parameter, t.point_type,
//         a.code AS asset, t.units, t.range_min, t.range_max,
//         t.alarm_low, t.alarm_high, t.alarm_state_int,
//         t.display_digits, t.is_cpp,
//         COALESCE(
//           json_agg(
//             json_build_object('state', tsl.state_value, 'label', tsl.label)
//           ) FILTER (WHERE tsl.state_value IS NOT NULL), '[]'
//         ) AS state_labels
//       FROM tags t
//       JOIN assets a ON t.asset_id = a.id
//       LEFT JOIN tag_state_labels tsl ON tsl.tag_id = t.id
//       WHERE 1=1
//     `;
//         const params = [];
//         if (asset) { params.push(asset); sql += ` AND a.code = $${params.length}`; }
//         if (cpp === 'true') { sql += ` AND t.is_cpp = true`; }
//         sql += ' GROUP BY t.id, a.code ORDER BY t.id;';

//         const { rows } = await query(sql, params);
//         res.json(rows);
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// router.get('/readings', async (req, res) => {
//     const { tags, from, to, resolution = 'auto' } = req.query;
//     if (!tags || !from || !to) {
//         return res.status(400).json({ error: 'Parameters "tags", "from", and "to" are required' });
//     }

//     const tagList = tags.split(',').map(t => t.trim());
//     const fromDate = new Date(from);
//     const toDate = new Date(to);
//     const spanHours = (toDate - fromDate) / (1000 * 3600);

//     let targetRes = resolution;
//     let downsampled = false;

//     if (targetRes === 'auto') {
//         if (spanHours <= 4) targetRes = 'raw';
//         else if (spanHours <= 24) { targetRes = '1m'; downsampled = true; }
//         else if (spanHours <= 168) { targetRes = '5m'; downsampled = true; }
//         else { targetRes = '1h'; downsampled = true; }
//     }

//     try {
//         let sql = '';
//         if (targetRes === 'raw') {
//             sql = `
//         SELECT r.ts AS "time", t.name AS "tag", r.value, r.quality
//         FROM readings r
//         JOIN tags t ON r.tag_id = t.id
//         WHERE t.name = ANY($1::text[]) AND r.ts >= $2 AND r.ts <= $3
//         ORDER BY r.ts ASC;
//       `;
//         } else if (targetRes === '1m') {
//             sql = `
//         SELECT r.bucket AS "time", t.name AS "tag", r.avg_value AS value, 0 AS quality
//         FROM readings_1min r
//         JOIN tags t ON r.tag_id = t.id
//         WHERE t.name = ANY($1::text[]) AND r.bucket >= $2 AND r.bucket <= $3
//         ORDER BY r.bucket ASC;
//       `;
//         } else {
//             const bucket = targetRes === '5m' ? '5 minutes' : '1 hour';
//             sql = `
//         SELECT time_bucket('${bucket}', r.ts) AS "time", t.name AS "tag",
//                avg(r.value) AS value, min(r.quality) AS quality
//         FROM readings r
//         JOIN tags t ON r.tag_id = t.id
//         WHERE t.name = ANY($1::text[]) AND r.ts >= $2 AND r.ts <= $3
//         GROUP BY 1, 2
//         ORDER BY 1 ASC;
//       `;
//         }

//         const { rows } = await query(sql, [tagList, fromDate, toDate]);
//         res.json({ resolution: targetRes, autoDownsampled: downsampled, count: rows.length, data: rows });
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// // EBR Case 1: Point-in-time value lookup
// router.get('/tags/:tag/value', async (req, res) => {
//     const { tag } = req.params;
//     const ts = req.query.ts ? new Date(req.query.ts) : new Date();

//     try {
//         const { rows } = await query(`
//       SELECT t.name, r.ts, ROUND(r.value::numeric, t.display_digits) AS value, 
//              r.quality, t.units, t.is_cpp, tsl.label AS state_label
//       FROM readings r
//       JOIN tags t ON r.tag_id = t.id
//       LEFT JOIN tag_state_labels tsl ON tsl.tag_id = t.id AND tsl.state_value = r.value::smallint
//       WHERE t.name = $1 AND r.ts <= $2
//       ORDER BY r.ts DESC
//       LIMIT 1;
//     `, [tag, ts]);

//         if (rows.length === 0) return res.status(404).json({ error: `No reading found for tag '${tag}'` });
//         res.json(rows[0]);
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// // EBR Case 3: Summary calculations
// router.get('/tags/:tag/summary', async (req, res) => {
//     const { tag } = req.params;
//     const { from, to } = req.query;
//     if (!from || !to) return res.status(400).json({ error: 'Parameters "from" and "to" are required' });

//     try {
//         const { rows: tagRows } = await query('SELECT id, point_type FROM tags WHERE name = $1', [tag]);
//         if (tagRows.length === 0) return res.status(404).json({ error: `Tag '${tag}' not found` });

//         if (tagRows[0].point_type === 'integer') {
//             const { rows } = await query(`
//         WITH state_durations AS (
//           SELECT value::smallint AS state_value,
//                  extract(epoch FROM lead(ts, 1, $3::timestamptz) OVER (ORDER BY ts) - ts) AS secs,
//                  quality
//           FROM readings r
//           JOIN tags t ON r.tag_id = t.id
//           WHERE t.name = $1 AND r.ts >= $2::timestamptz AND r.ts <= $3::timestamptz
//         )
//         SELECT 
//           sd.state_value AS state,
//           COALESCE(tsl.label, 'Unknown') AS label,
//           ROUND(sum(sd.secs)::numeric, 1) AS seconds_in_state,
//           count(*)::int AS transitions,
//           ROUND((100.0 * count(*) FILTER (WHERE sd.quality = 0) / NULLIF(count(*), 0))::numeric, 2) AS percent_good
//         FROM state_durations sd
//         LEFT JOIN tag_state_labels tsl ON tsl.tag_id = $4 AND tsl.state_value = sd.state_value
//         GROUP BY sd.state_value, tsl.label;
//       `, [tag, from, to, tagRows[0].id]);
//             return res.json({ tag, timeInState: rows });
//         }

//         const { rows } = await query(`
//       WITH intervals AS (
//         SELECT r.value, r.quality,
//                extract(epoch FROM lead(r.ts, 1, $3::timestamptz) OVER (ORDER BY r.ts) - r.ts) AS secs
//         FROM readings r
//         JOIN tags t ON r.tag_id = t.id
//         WHERE t.name = $1 AND r.ts >= $2::timestamptz AND r.ts <= $3::timestamptz
//       )
//       SELECT
//         ROUND(min(value)::numeric, 3) AS min_value,
//         ROUND(max(value)::numeric, 3) AS max_value,
//         ROUND((sum(value * secs) / NULLIF(sum(secs), 0))::numeric, 3) AS time_weighted_avg,
//         ROUND(avg(value)::numeric, 3) AS event_weighted_avg,
//         count(*)::int AS sample_count,
//         ROUND((100.0 * count(*) FILTER (WHERE quality = 0) / NULLIF(count(*), 0))::numeric, 2) AS percent_good
//       FROM intervals;
//     `, [tag, from, to]);

//         res.json({ tag, ...rows[0] });
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// // ---------------------------------------------------------------------------
// // Batches & ISA-88 Tree (EBR Case 2)
// // ---------------------------------------------------------------------------
// router.get('/batches', async (req, res) => {
//     const { status, asset, limit = 50 } = req.query;
//     try {
//         let sql = `
//       SELECT b.id, b.batch_id, b.product_code, b.recipe_version, 
//              a.code AS current_reactor, b.started_at, b.ended_at, b.status
//       FROM batches b
//       LEFT JOIN assets a ON b.current_asset_id = a.id
//       WHERE 1=1
//     `;
//         const params = [];
//         if (status) { params.push(status); sql += ` AND b.status = $${params.length}`; }
//         if (asset) { params.push(asset); sql += ` AND a.code = $${params.length}`; }
//         sql += ` ORDER BY b.started_at DESC LIMIT $${params.length + 1};`;
//         params.push(parseInt(limit, 10));

//         const { rows } = await query(sql, params);
//         res.json(rows);
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// router.get('/batches/:id', async (req, res) => {
//     const { id } = req.params;
//     try {
//         const { rows: batchRows } = await query(`
//       SELECT b.*, a.code AS current_reactor 
//       FROM batches b 
//       LEFT JOIN assets a ON b.current_asset_id = a.id 
//       WHERE b.batch_id = $1 OR b.id::text = $1;
//     `, [id]);
//         if (batchRows.length === 0) return res.status(404).json({ error: 'Batch not found' });
//         const batch = batchRows[0];

//         const { rows: events } = await query(`
//       SELECT e.id, e.parent_id, e.name, e.level, e.occurrence, e.started_at, e.ended_at, 
//              a.code AS asset, t.name AS tag_name, e.details
//       FROM events e
//       JOIN assets a ON e.asset_id = a.id
//       LEFT JOIN tags t ON e.tag_id = t.id
//       WHERE e.batch_pk = $1
//       ORDER BY e.started_at ASC;
//     `, [batch.id]);

//         res.json({ batch, events });
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// router.get('/events', async (req, res) => {
//     const { asset, level, from, to, limit = 15 } = req.query;
//     try {
//         let sql = `
//       SELECT e.id, e.name, e.occurrence, e.level, e.started_at, e.ended_at,
//              a.code AS asset, b.batch_id, t.name AS tag_name
//       FROM events e
//       JOIN assets a ON e.asset_id = a.id
//       LEFT JOIN batches b ON e.batch_pk = b.id
//       LEFT JOIN tags t ON e.tag_id = t.id
//       WHERE 1=1
//     `;
//         const params = [];
//         if (asset) { params.push(asset); sql += ` AND a.code = $${params.length}`; }
//         if (level) { params.push(level); sql += ` AND e.level = $${params.length}`; }
//         if (from && to) {
//             params.push(new Date(from));
//             params.push(new Date(to));
//             sql += ` AND e.started_at <= $${params.length} AND (e.ended_at IS NULL OR e.ended_at >= $${params.length - 1})`;
//         }
//         sql += ` ORDER BY e.started_at DESC LIMIT $${params.length + 1};`;
//         params.push(parseInt(limit, 10));

//         const { rows } = await query(sql, params);
//         res.json(rows);
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// router.get('/events/:id/summary', async (req, res) => {
//     const { id } = req.params;
//     try {
//         const { rows: evRows } = await query('SELECT * FROM events WHERE id = $1', [id]);
//         if (evRows.length === 0) return res.status(404).json({ error: 'Event not found' });
//         const ev = evRows[0];
//         const endTime = ev.ended_at || new Date();

//         const { rows } = await query(`
//       SELECT t.name, t.units,
//              ROUND(min(r.value)::numeric, t.display_digits) AS min_val,
//              ROUND(max(r.value)::numeric, t.display_digits) AS max_val,
//              ROUND(avg(r.value)::numeric, t.display_digits) AS avg_val,
//              ROUND((100.0 * count(*) FILTER (WHERE r.quality = 0) / NULLIF(count(*), 0))::numeric, 2) AS percent_good
//       FROM readings r
//       JOIN tags t ON r.tag_id = t.id
//       WHERE t.asset_id = $1 AND t.is_cpp = true AND r.ts >= $2 AND r.ts <= $3
//       GROUP BY t.id;
//     `, [ev.asset_id, ev.started_at, endTime]);

//         res.json({ event: ev, cppSummaries: rows });
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// // ---------------------------------------------------------------------------
// // Outbound Monitoring Push Jobs (EBR Cases 4 & 5)
// // ---------------------------------------------------------------------------
// router.get('/jobs', async (req, res) => {
//     try {
//         const { rows } = await query(`
//       SELECT 
//         j.id, j.batch_pk, b.batch_id, a.code AS reactor,
//         j.interval_sec, j.kind, j.started_at, j.end_at, j.max_samples,
//         j.sequence, j.state, j.callback_ref, j.completed_at,
//         array_agg(t.name) AS tags
//       FROM monitoring_jobs j
//       JOIN batches b ON j.batch_pk = b.id
//       JOIN assets a ON j.asset_id = a.id
//       LEFT JOIN monitoring_job_tags mjt ON mjt.job_id = j.id
//       LEFT JOIN tags t ON mjt.tag_id = t.id
//       GROUP BY j.id, b.batch_id, a.code
//       ORDER BY j.started_at DESC;
//     `);
//         res.json(rows);
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// router.post('/jobs', async (req, res) => {
//     const { batchId, reactor, tagNames, intervalSec = 60, kind = 'fixed', callbackUrl, endAt, maxSamples = 500 } = req.body;
//     try {
//         const { rows: batchRows } = await query('SELECT id FROM batches WHERE batch_id = $1', [batchId]);
//         if (batchRows.length === 0) return res.status(404).json({ error: `Batch '${batchId}' not found` });

//         const { rows: assetRows } = await query('SELECT id FROM assets WHERE code = $1', [reactor]);
//         if (assetRows.length === 0) return res.status(404).json({ error: `Asset '${reactor}' not found` });

//         const { rows: jobRows } = await query(`
//       INSERT INTO monitoring_jobs 
//       (batch_pk, asset_id, interval_sec, kind, callback_ref, end_at, max_samples, next_fire_at)
//       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
//       RETURNING *;
//     `, [batchRows[0].id, assetRows[0].id, intervalSec, kind, callbackUrl, endAt ? new Date(endAt) : null, maxSamples]);

//         const job = jobRows[0];

//         if (Array.isArray(tagNames) && tagNames.length > 0) {
//             await query(`
//         INSERT INTO monitoring_job_tags (job_id, tag_id)
//         SELECT $1, id FROM tags WHERE name = ANY($2::text[]);
//       `, [job.id, tagNames]);
//         }

//         res.status(201).json(job);
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// router.get('/jobs/:id', async (req, res) => {
//     const { id } = req.params;
//     try {
//         const { rows: jobRows } = await query('SELECT * FROM monitoring_jobs WHERE id = $1', [id]);
//         if (jobRows.length === 0) return res.status(404).json({ error: 'Job not found' });
//         const { rows: outbox } = await query('SELECT * FROM monitoring_outbox WHERE job_id = $1 ORDER BY sequence DESC;', [id]);
//         res.json({ job: jobRows[0], samples: outbox });
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// router.post('/jobs/:id/complete', async (req, res) => {
//     const { id } = req.params;
//     try {
//         await query("UPDATE monitoring_jobs SET state = 'completed', completed_at = NOW() WHERE id = $1", [id]);
//         res.json({ message: 'Job completed' });
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// router.post('/jobs/:id/cancel', async (req, res) => {
//     const { id } = req.params;
//     try {
//         await query("UPDATE monitoring_jobs SET state = 'cancelled', completed_at = NOW() WHERE id = $1", [id]);
//         res.json({ message: 'Job cancelled' });
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

export default router;