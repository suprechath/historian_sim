import { pool } from './db.js';
import { PRNG } from './prng.js';
import { PHASES, PHASE_DURATIONS, ReactorSimulation } from './stateMachine.js';

const SEED = parseInt(process.env.SIM_SEED || '20260908', 10);
const DAYS_TO_SEED = parseInt(process.argv[2] || '90', 10); // Default 90 days
const ARCHIVE_INTERVAL_SEC = 5; // 5-second archive persistence
const BATCH_FLUSH_SIZE = 40000; // Multi-row array buffer size

async function seedHistory() {
    const client = await pool.connect();
    const prng = new PRNG(SEED);

    try {
        console.log(`\n--- Starting Historical Backfill (${DAYS_TO_SEED} days, seed: ${SEED}) ---`);

        // 1. Fetch Assets and Tags
        const { rows: assets } = await client.query('SELECT id, code, capacity_l FROM assets ORDER BY id');
        const { rows: tags } = await client.query('SELECT id, name, asset_id, parameter FROM tags ORDER BY id');

        if (assets.length === 0 || tags.length === 0) {
            throw new Error('Assets or tags not found. Ensure 03_seeds.sql was executed.');
        }

        const tagLookup = new Map();
        tags.forEach(t => tagLookup.set(`${t.asset_id}_${t.parameter}`, t.id));

        // 2. Clean existing historical data
        console.log('Cleaning old historical tables...');
        await client.query('TRUNCATE TABLE monitoring_outbox, monitoring_jobs, events, batches CASCADE');
        await client.query('TRUNCATE TABLE readings');

        // 3. Initialize Reactor State Machines
        const reactors = assets.map(a => new ReactorSimulation(a, prng));

        // Stagger initial phases so reactors are not in lockstep
        reactors[0].transitionNextPhase('Hold');
        reactors[1].transitionNextPhase('Heating');
        reactors[2].transitionNextPhase('Cooling');

        const now = new Date();
        const startTime = new Date(now.getTime() - DAYS_TO_SEED * 24 * 60 * 60 * 1000);
        let currentTime = new Date(startTime);

        let batchSeq = 1;
        let totalReadings = 0;

        // Buffer arrays for high-performance UNNEST bulk insert
        let bufTagId = [];
        let bufTs = [];
        let bufVal = [];
        let bufQuality = [];

        const flushReadings = async () => {
            if (bufTagId.length === 0) return;
            await client.query(
                `INSERT INTO readings (tag_id, ts, value, quality)
         SELECT * FROM UNNEST($1::int[], $2::timestamptz[], $3::float8[], $4::smallint[])
         ON CONFLICT (tag_id, ts) DO NOTHING`,
                [bufTagId, bufTs, bufVal, bufQuality]
            );
            totalReadings += bufTagId.length;
            bufTagId = [];
            bufTs = [];
            bufVal = [];
            bufQuality = [];
        };

        console.log(`Simulating timeline from ${startTime.toISOString()} to ${now.toISOString()}...`);
        let lastLoggedDay = -1;

        // Advance timeline in 5-second archive increments
        while (currentTime <= now) {
            const daysElapsed = Math.floor((currentTime - startTime) / (24 * 60 * 60 * 1000));
            if (daysElapsed !== lastLoggedDay && daysElapsed % 10 === 0) {
                lastLoggedDay = daysElapsed;
                console.log(`-> Progress: Day ${daysElapsed}/${DAYS_TO_SEED} (${totalReadings.toLocaleString()} readings persisted)`);
            }

            for (const sim of reactors) {
                // Run internal simulation tick
                const phaseFinished = sim.tick(ARCHIVE_INTERVAL_SEC);

                // Manage Batch and Event Lifecycles
                if (sim.currentPhase === 'Charging' && !sim.activeBatch) {
                    const year = currentTime.getUTCFullYear();
                    const batchIdStr = `B-${year}-${String(batchSeq++).padStart(4, '0')}`;

                    const { rows } = await client.query(
                        `INSERT INTO batches (batch_id, asset_id, started_at, status)
             VALUES ($1, $2, $3, 'Running') RETURNING id`,
                        [batchIdStr, sim.asset.id, currentTime]
                    );
                    sim.activeBatch = { id: rows[0].id, batch_id: batchIdStr, started_at: new Date(currentTime) };
                }

                // Open/Close Phase Events
                if (!sim.activeEventId && sim.currentPhase !== 'Idle') {
                    const { rows } = await client.query(
                        `INSERT INTO events (batch_pk, asset_id, name, level, occurrence, started_at)
             VALUES ($1, $2, $3, 'Phase', $4, $5) RETURNING id`,
                        [sim.activeBatch ? sim.activeBatch.id : null, sim.asset.id, sim.currentPhase, sim.phaseOccurrence, currentTime]
                    );
                    sim.activeEventId = rows[0].id;
                }

                // Handle phase completion
                if (phaseFinished) {
                    if (sim.activeEventId) {
                        await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [currentTime, sim.activeEventId]);
                        sim.activeEventId = null;
                    }

                    if (sim.currentPhase === 'Discharge' && sim.activeBatch) {
                        await client.query(
                            "UPDATE batches SET ended_at = $1, status = 'Completed' WHERE id = $2",
                            [currentTime, sim.activeBatch.id]
                        );
                        sim.activeBatch = null;
                    }

                    sim.transitionNextPhase();
                }

                // Queue 4 readings per reactor for persistence
                for (const param of ['TEMP', 'PRES', 'AGIT', 'VOL']) {
                    const tagId = tagLookup.get(`${sim.asset.id}_${param}`);
                    bufTagId.push(tagId);
                    bufTs.push(currentTime.toISOString());
                    bufVal.push(sim.values[param]);
                    bufQuality.push(sim.qualities[param]);
                }

                if (bufTagId.length >= BATCH_FLUSH_SIZE) {
                    await flushReadings();
                }
            }

            currentTime = new Date(currentTime.getTime() + ARCHIVE_INTERVAL_SEC * 1000);
        }

        // Flush any remaining readings
        await flushReadings();

        // 4. Update the Snapshots table with the final live values
        console.log('Updating snapshots table to current tick...');
        for (const sim of reactors) {
            for (const param of ['TEMP', 'PRES', 'AGIT', 'VOL']) {
                const tagId = tagLookup.get(`${sim.asset.id}_${param}`);
                await client.query(
                    `INSERT INTO snapshots (tag_id, ts, value, quality)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tag_id) DO UPDATE 
           SET ts = EXCLUDED.ts, value = EXCLUDED.value, quality = EXCLUDED.quality`,
                    [tagId, now, sim.values[param], sim.qualities[param]]
                );
            }
        }

        console.log(`\n✔ Seeding completed successfully!`);
        console.log(`Total Readings Written: ${totalReadings.toLocaleString()}`);
        console.log(`Total Batches Generated: ${batchSeq - 1}`);

    } catch (err) {
        console.error('Seeding failed:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

seedHistory();