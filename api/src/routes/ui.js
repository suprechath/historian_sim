import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// In-memory simulation state cache (synchronized with database)
export let simState = {
    running: true,
    speed: 1,
    updatedAt: new Date()
};

// Ensure simulation_control table exists
export async function ensureSimulationControl() {
    await query(`
      CREATE TABLE IF NOT EXISTS simulation_control (
        id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        running           BOOLEAN NOT NULL DEFAULT true,
        speed             INTEGER NOT NULL DEFAULT 1 CHECK (speed >= 1 AND speed <= 3600),
        phase_skip_asset  TEXT,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO simulation_control (id, running, speed)
      VALUES (1, true, 1)
      ON CONFLICT (id) DO NOTHING;
    `);
}

// Fetch live simulation control state from database
export async function getSimulationState() {
    try {
        const { rows } = await query('SELECT running, speed, updated_at FROM simulation_control WHERE id = 1');
        if (rows.length > 0) {
            simState.running = rows[0].running;
            simState.speed = rows[0].speed;
            simState.updatedAt = rows[0].updated_at;
        }
    } catch (err) {
        // Fallback to in-memory state if table not ready
    }
    return simState;
}

// ---------------------------------------------------------------------------
// 1. Live SSE Stream (1s composite payload for mimic, tags, clock & phases)
// ---------------------------------------------------------------------------
router.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Prevent Nginx from buffering SSE events
    res.flushHeaders();

    const interval = setInterval(async () => {
        try {
            // 0. Fetch latest simulation speed & running status
            const currentSimState = await getSimulationState();

            // 1. Active phases & batches per vessel
            const { rows: reactors } = await query(`
        SELECT a.code AS asset, b.batch_id, b.recipe_version, e.name AS phase
        FROM assets a
        LEFT JOIN batches b ON b.current_asset_id = a.id AND b.status = 'Running'
        LEFT JOIN events e ON e.asset_id = a.id AND e.level = 'Phase' AND e.ended_at IS NULL
        ORDER BY a.id;
      `);

            const reactorMap = {};
            reactors.forEach(r => {
                reactorMap[r.asset] = {
                    phase: r.phase || 'Idle',
                    batchId: r.batch_id || null,
                    recipe: r.recipe_version || 'v2.1'
                };
            });

            // 2. All 25 tags with discrete state labels and CPP indicators
            const { rows: tags } = await query(`
        SELECT 
          t.name,
          t.parameter,
          t.point_type,
          a.code AS asset,
          ROUND(s.value::numeric, t.display_digits) AS val,
          tsl.label AS state_label,
          CASE s.quality 
            WHEN 0 THEN 'Good' 
            WHEN 1 THEN 'Questionable' 
            WHEN 2 THEN 'Bad' 
            WHEN 3 THEN 'Substituted' 
          END AS q,
          t.units AS u,
          t.is_cpp AS cpp,
          CASE 
            WHEN t.alarm_high IS NOT NULL AND s.value > t.alarm_high THEN true
            WHEN t.alarm_low IS NOT NULL AND s.value < t.alarm_low THEN true
            WHEN t.alarm_state_int IS NOT NULL AND s.value::smallint = t.alarm_state_int THEN true
            ELSE false
          END AS alarm
        FROM snapshots s
        JOIN tags t ON s.tag_id = t.id
        JOIN assets a ON t.asset_id = a.id
        LEFT JOIN tag_state_labels tsl ON tsl.tag_id = t.id AND tsl.state_value = s.value::smallint
        ORDER BY t.id;
      `);

            res.write(`data: ${JSON.stringify({
                clock: new Date(),
                running: currentSimState.running,
                speed: currentSimState.speed,
                reactors: reactorMap,
                tags
            })}\n\n`);
        } catch (err) {
            console.error('SSE snapshot fetch error:', err.message);
        }
    }, 1000);

    req.on('close', () => {
        clearInterval(interval);
        res.end();
    });
});

// ---------------------------------------------------------------------------
// 2. Simulation State & Demo Controls
// ---------------------------------------------------------------------------
router.get('/simulation/state', async (req, res) => {
    try {
        const state = await getSimulationState();
        res.json(state);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/simulation/state', async (req, res) => {
    const { running, speed } = req.body;
    try {
        await ensureSimulationControl();
        const parsedSpeed = speed !== undefined ? Math.min(Math.max(parseInt(speed, 10) || 1, 1), 3600) : null;
        const parsedRunning = running !== undefined ? Boolean(running) : null;

        const { rows } = await query(`
          UPDATE simulation_control
          SET running = COALESCE($1, running),
              speed = COALESCE($2, speed),
              updated_at = NOW()
          WHERE id = 1
          RETURNING running, speed, updated_at;
        `, [parsedRunning, parsedSpeed]);

        if (rows.length > 0) {
            simState.running = rows[0].running;
            simState.speed = rows[0].speed;
            simState.updatedAt = rows[0].updated_at;
        }
        res.json(simState);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/simulation/phase/skip', async (req, res) => {
    const { asset } = req.body;
    try {
        const { rows: assetRows } = await query('SELECT id, code FROM assets WHERE code = $1', [asset]);
        if (assetRows.length === 0) return res.status(404).json({ error: `Asset '${asset}' not found` });

        await ensureSimulationControl();

        // 1. Mark active phase ended in events
        await query(`
          UPDATE events 
          SET ended_at = NOW() 
          WHERE asset_id = $1 AND level = 'Phase' AND ended_at IS NULL;
        `, [assetRows[0].id]);

        // 2. Signal the continuous simulator engine to advance in-memory FSM
        await query(`
          UPDATE simulation_control
          SET phase_skip_asset = $1,
              updated_at = NOW()
          WHERE id = 1;
        `, [assetRows[0].code]);

        res.json({ message: `Active phase skipped for ${asset}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// not used yet
router.post('/simulation/override-status', async (req, res) => {
    const { tag, state, release = false } = req.body;
    try {
        const { rows: tagRows } = await query('SELECT id FROM tags WHERE name = $1', [tag]);
        if (tagRows.length === 0) return res.status(404).json({ error: `Tag '${tag}' not found` });

        if (release) {
            await query("UPDATE injected_faults SET cleared_at = NOW() WHERE tag_id = $1 AND kind = 'override' AND cleared_at IS NULL", [tagRows[0].id]);
            return res.json({ message: `Override released for ${tag}` });
        }

        await query(`
      INSERT INTO injected_faults (tag_id, kind, magnitude) 
      VALUES ($1, 'override', $2);
    `, [tagRows[0].id, state]);

        res.json({ message: `Status overridden to ${state} for ${tag}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// not used yet
router.get('/faults', async (req, res) => {
    try {
        const { rows } = await query(`
      SELECT f.id, t.name AS tag, f.kind, f.magnitude, f.started_at 
      FROM injected_faults f 
      JOIN tags t ON f.tag_id = t.id 
      WHERE f.cleared_at IS NULL;
    `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/faults', async (req, res) => {
    const { tag, kind, magnitude = 0 } = req.body;
    try {
        const { rows: tagRows } = await query('SELECT id FROM tags WHERE name = $1', [tag]);
        if (tagRows.length === 0) return res.status(404).json({ error: `Tag '${tag}' not found` });

        const { rows } = await query(`
      INSERT INTO injected_faults (tag_id, kind, magnitude) 
      VALUES ($1, $2, $3) 
      RETURNING *;
    `, [tagRows[0].id, kind, magnitude]);

        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/faults', async (req, res) => {
    const { tag } = req.query;
    try {
        if (tag) {
            await query(`
        UPDATE injected_faults 
        SET cleared_at = NOW() 
        WHERE tag_id = (SELECT id FROM tags WHERE name = $1) AND cleared_at IS NULL;
      `, [tag]);
        } else {
            await query('UPDATE injected_faults SET cleared_at = NOW() WHERE cleared_at IS NULL;');
        }
        res.json({ message: 'Faults cleared' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// 4. UI Historical Events & Readings (Unauthenticated endpoints for TrendCanvas)
// ---------------------------------------------------------------------------
router.get('/events', async (req, res) => {
    const { asset, level, from, to, limit = 100 } = req.query;
    try {
        let sql = `
      SELECT e.id, e.name, e.occurrence, e.level, e.started_at, e.ended_at,
             a.code AS asset, b.batch_id, t.name AS tag_name
      FROM events e
      JOIN assets a ON e.asset_id = a.id
      LEFT JOIN batches b ON e.batch_pk = b.id
      LEFT JOIN tags t ON e.tag_id = t.id
      WHERE 1=1
    `;
        const params = [];
        if (asset && asset !== 'ALL') { params.push(asset); sql += ` AND a.code = $${params.length}`; }
        if (level && level !== 'ALL') { params.push(level); sql += ` AND e.level = $${params.length}`; }
        if (from && to) {
            params.push(new Date(from));
            params.push(new Date(to));
            sql += ` AND e.started_at <= $${params.length} AND (e.ended_at IS NULL OR e.ended_at >= $${params.length - 1})`;
        }
        sql += ` ORDER BY e.started_at DESC LIMIT $${params.length + 1};`;
        params.push(parseInt(limit, 10));

        const { rows } = await query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// 5. 1-Minute Rollup Audit & Data Verification (TimescaleDB readings_1min)
// ---------------------------------------------------------------------------
router.get('/rollups', async (req, res) => {
    const { asset, limit = 60 } = req.query;
    try {
        let sql = `
          SELECT 
            r.bucket AS "time",
            a.code AS "reactor",
            t.name AS "tag",
            t.description,
            t.parameter,
            t.units AS "unit",
            ROUND(r.avg_value::numeric, COALESCE(t.display_digits, 2)) AS "avg",
            ROUND(r.min_value::numeric, COALESCE(t.display_digits, 2)) AS "min",
            ROUND(r.max_value::numeric, COALESCE(t.display_digits, 2)) AS "max",
            r.sample_count AS "total_points",
            r.good_count AS "good_points",
            ROUND((r.good_count::numeric / NULLIF(r.sample_count, 0) * 100)::numeric, 1) AS "pct_good"
          FROM readings_1min r
          JOIN tags t ON r.tag_id = t.id
          JOIN assets a ON t.asset_id = a.id
          WHERE 1=1
        `;
        const params = [];
        if (asset && asset !== 'ALL') {
            params.push(asset);
            sql += ` AND a.code = $${params.length}`;
        }
        sql += ` ORDER BY r.bucket DESC, t.name ASC LIMIT $${params.length + 1};`;
        params.push(parseInt(limit, 10));

        const { rows } = await query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/readings', async (req, res) => {
    const { tags, from, to, resolution = 'auto' } = req.query;
    if (!tags || !from || !to) {
        return res.status(400).json({ error: 'Parameters "tags", "from", and "to" are required' });
    }

    const tagList = tags.split(',').map(t => t.trim());
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const spanHours = (toDate - fromDate) / (1000 * 3600);

    let targetRes = resolution;
    let downsampled = false;

    if (targetRes === 'auto') {
        if (spanHours <= 4) targetRes = 'raw';
        else if (spanHours <= 24) { targetRes = '1m'; downsampled = true; }
        else if (spanHours <= 168) { targetRes = '5m'; downsampled = true; }
        else { targetRes = '1h'; downsampled = true; }
    }

    try {
        let sql = '';
        if (targetRes === 'raw') {
            sql = `
        SELECT r.ts AS "time", t.name AS "tag", r.value, r.quality
        FROM readings r
        JOIN tags t ON r.tag_id = t.id
        WHERE t.name = ANY($1::text[]) AND r.ts >= $2 AND r.ts <= $3
        ORDER BY r.ts ASC;
      `;
        } else if (targetRes === '1m') {
            sql = `
        SELECT r.bucket AS "time", t.name AS "tag", r.avg_value AS value, 0 AS quality
        FROM readings_1min r
        JOIN tags t ON r.tag_id = t.id
        WHERE t.name = ANY($1::text[]) AND r.bucket >= $2 AND r.bucket <= $3
        ORDER BY r.bucket ASC;
      `;
        } else {
            const bucket = targetRes === '5m' ? '5 minutes' : '1 hour';
            sql = `
        SELECT time_bucket('${bucket}', r.ts) AS "time", t.name AS "tag",
               avg(r.value) AS value, min(r.quality) AS quality
        FROM readings r
        JOIN tags t ON r.tag_id = t.id
        WHERE t.name = ANY($1::text[]) AND r.ts >= $2 AND r.ts <= $3
        GROUP BY 1, 2
        ORDER BY 1 ASC;
      `;
        }

        const { rows } = await query(sql, [tagList, fromDate, toDate]);
        res.json({ resolution: targetRes, autoDownsampled: downsampled, count: rows.length, data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;