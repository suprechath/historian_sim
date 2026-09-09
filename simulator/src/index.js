import { pool } from './db.js';
import { PRNG } from './prng.js';
import { ReactorSimulation } from './stateMachine.js';

const ARCHIVE_INTERVAL_SEC = 5; //
const prng = new PRNG(Date.now());

async function startEngine() {
    const client = await pool.connect();

    try {
        console.log('--- Initializing Continuous Simulation Engine ---');

        // 1. Fetch Assets and Tags
        const { rows: assets } = await client.query('SELECT id, code, capacity_l FROM assets ORDER BY id');
        const { rows: tags } = await client.query('SELECT id, name, asset_id, parameter FROM tags ORDER BY id');

        if (assets.length === 0 || tags.length === 0) {
            throw new Error('Assets or tags missing. Ensure 03_seeds.sql was executed.');
        }

        const tagLookup = new Map();
        const tagIdToParam = new Map();
        tags.forEach(t => {
            tagLookup.set(`${t.asset_id}_${t.parameter}`, t.id);
            tagIdToParam.set(t.id, t.parameter);
        });

        // 2. Initialize State Machines
        const reactors = assets.map(a => new ReactorSimulation(a, prng));

        // Check for open batches and events from previous runs to resume cleanly
        for (const sim of reactors) {
            const { rows: openBatch } = await client.query(
                "SELECT id, batch_id, started_at FROM batches WHERE asset_id = $1 AND status = 'Running' ORDER BY started_at DESC LIMIT 1",
                [sim.asset.id]
            );
            if (openBatch.length > 0) {
                sim.activeBatch = openBatch[0];
            }

            const { rows: openEvent } = await client.query(
                "SELECT id, name, occurrence FROM events WHERE asset_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
                [sim.asset.id]
            );
            if (openEvent.length > 0) {
                sim.currentPhase = openEvent[0].name;
                sim.phaseOccurrence = openEvent[0].occurrence;
                sim.activeEventId = openEvent[0].id;
            } else {
                sim.transitionNextPhase('Idle');
            }
        }

        // 3. Batch Counter Initialization
        const { rows: maxBatch } = await client.query(
            "SELECT batch_id FROM batches WHERE batch_id LIKE 'B-2026-%' ORDER BY batch_id DESC LIMIT 1"
        );
        let batchSeq = maxBatch.length > 0 ? parseInt(maxBatch[0].batch_id.split('-')[2], 10) + 1 : 1;

        console.log(`Simulation ready. Managing ${reactors.length} reactors with ${tags.length} tags.`);

        // Archive write buffer
        let archiveBuffer = [];
        let secondsSinceLastArchive = 0;

        // Monotonic clock timer with drift compensation
        let expectedNextTick = Date.now() + 1000;

        const tick = async () => {
            const now = new Date();

            try {
                // Query active injected faults[cite: 1]
                const { rows: faults } = await client.query(
                    'SELECT tag_id, kind, magnitude FROM injected_faults WHERE cleared_at IS NULL'
                );
                const activeFaultMap = new Map();
                faults.forEach(f => activeFaultMap.set(f.tag_id, f));

                // Snapshot buffer for multi-row UPSERT
                const snapshotTagIds = [];
                const snapshotVals = [];
                const snapshotQualities = [];
                const snapshotTimes = [];

                for (const sim of reactors) {
                    // Advance physical models by 1 second[cite: 1]
                    const phaseFinished = sim.tick(1);

                    // Handle batch progression[cite: 1]
                    if (sim.currentPhase === 'Charging' && !sim.activeBatch) {
                        const batchIdStr = `B-2026-${String(batchSeq++).padStart(4, '0')}`;
                        const { rows } = await client.query(
                            "INSERT INTO batches (batch_id, asset_id, started_at, status) VALUES ($1, $2, $3, 'Running') RETURNING id",
                            [batchIdStr, sim.asset.id, now]
                        );
                        sim.activeBatch = { id: rows[0].id, batch_id: batchIdStr, started_at: now };
                    }

                    // Handle phase event logging[cite: 1]
                    if (!sim.activeEventId && sim.currentPhase !== 'Idle') {
                        const { rows } = await client.query(
                            "INSERT INTO events (batch_pk, asset_id, name, level, occurrence, started_at) VALUES ($1, $2, $3, 'Phase', $4, $5) RETURNING id",
                            [sim.activeBatch ? sim.activeBatch.id : null, sim.asset.id, sim.currentPhase, sim.phaseOccurrence, now]
                        );
                        sim.activeEventId = rows[0].id;
                    }

                    if (phaseFinished) {
                        if (sim.activeEventId) {
                            await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, sim.activeEventId]);
                            sim.activeEventId = null;
                        }

                        if (sim.currentPhase === 'Discharge' && sim.activeBatch) {
                            await client.query("UPDATE batches SET ended_at = $1, status = 'Completed' WHERE id = $2", [now, sim.activeBatch.id]);
                            sim.activeBatch = null;
                        }

                        sim.transitionNextPhase();
                    }

                    // Evaluate readings and apply active faults
                    for (const param of ['TEMP', 'PRES', 'AGIT', 'VOL']) {
                        const tagId = tagLookup.get(`${sim.asset.id}_${param}`);
                        let val = sim.values[param];
                        let quality = sim.qualities[param]; // 0 = Good[cite: 1]

                        const fault = activeFaultMap.get(tagId);
                        if (fault) {
                            switch (fault.kind) {
                                case 'stuck':
                                    val = fault.magnitude ?? val;
                                    quality = 1; // Questionable[cite: 1]
                                    break;
                                case 'drift':
                                    val += (fault.magnitude ?? 5.0);
                                    quality = 1; // Questionable[cite: 1]
                                    break;
                                case 'dropout':
                                    val = null;
                                    quality = 2; // Bad sensor fault[cite: 1]
                                    break;
                                case 'spike':
                                    val += (fault.magnitude ?? 50.0);
                                    quality = 1;
                                    break;
                            }
                        }

                        // Stage for snapshots table
                        snapshotTagIds.push(tagId);
                        snapshotVals.push(val);
                        snapshotQualities.push(quality);
                        snapshotTimes.push(now.toISOString());

                        // Buffer for 5-second archive hypertable[cite: 1]
                        archiveBuffer.push({ tagId, ts: now.toISOString(), val, quality });
                    }
                }

                // 1. Overwrite snapshots table (1s live cache)[cite: 1]
                await client.query(
                    `INSERT INTO snapshots (tag_id, ts, value, quality)
           SELECT * FROM UNNEST($1::int[], $2::timestamptz[], $3::float8[], $4::smallint[])
           ON CONFLICT (tag_id) DO UPDATE 
           SET ts = EXCLUDED.ts, value = EXCLUDED.value, quality = EXCLUDED.quality`,
                    [snapshotTagIds, snapshotTimes, snapshotVals, snapshotQualities]
                );

                // 2. Persist to readings hypertable every 5 seconds[cite: 1]
                secondsSinceLastArchive += 1;
                if (secondsSinceLastArchive >= ARCHIVE_INTERVAL_SEC) {
                    const bTag = archiveBuffer.map(b => b.tagId);
                    const bTs = archiveBuffer.map(b => b.ts);
                    const bVal = archiveBuffer.map(b => b.val);
                    const bQ = archiveBuffer.map(b => b.quality);

                    await client.query(
                        `INSERT INTO readings (tag_id, ts, value, quality)
             SELECT * FROM UNNEST($1::int[], $2::timestamptz[], $3::float8[], $4::smallint[])
             ON CONFLICT (tag_id, ts) DO NOTHING`,
                        [bTag, bTs, bVal, bQ]
                    );

                    archiveBuffer = [];
                    secondsSinceLastArchive = 0;
                }

            } catch (loopErr) {
                console.error('Error in simulation tick:', loopErr);
            }

            // Drift-compensated scheduling
            expectedNextTick += 1000;
            const drift = expectedNextTick - Date.now();
            setTimeout(tick, Math.max(0, drift));
        };

        // Begin loop
        tick();

    } catch (err) {
        console.error('Engine failed to start:', err);
        client.release();
        process.exit(1);
    }
}

// Graceful termination
const shutdown = () => {
    console.log('\nStopping simulation loop gracefully...');
    pool.end().then(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startEngine();