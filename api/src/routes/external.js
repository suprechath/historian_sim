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
        const refElement = instruction.RefElement || body.RefElement;
        const refTime = instruction.RefTime || body.RefTime;
        const refInstruction = instruction.RefInstruction || body.RefInstruction;
        const callbackKey = body.CallbackKey;

        if (rawEventType === undefined || rawEventType === null || rawEventType === '' || Number.isNaN(Number(rawEventType))) {
            console.error('[BatchLine Callback Error]: Missing required EventType in instruction payload');
            return res.status(400).json({ error: 'Missing required EventType in instruction payload' });
        }
        const eventType = Number(rawEventType);

        if (!refElement) {
            console.error('[BatchLine Callback Error]: Missing required RefElement in instruction payload');
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

export default router;