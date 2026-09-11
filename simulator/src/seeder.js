// simulator/src/seeder.js
import { pool } from './db.js';
import { PRNG } from './prng.js';
import { ReactorSimulation } from './stateMachine.js';

const SEED = parseInt(process.env.SIM_SEED || '20260908', 10);
const DAYS_TO_SEED = parseInt(process.argv[2] || '7', 10); // Default 7 days
const ARCHIVE_INTERVAL_SEC = 5;                           // 5-second archive persistence
const BATCH_FLUSH_SIZE = 40000;                           // Multi-row array buffer size

async function seedHistory() {
  const client = await pool.connect();
  const prng = new PRNG(SEED);

  try {
    console.log(`\n--- Starting Historical Train Backfill (${DAYS_TO_SEED} days, seed: ${SEED}) ---`);

    // 1. Fetch Assets and Tags
    const { rows: assets } = await client.query('SELECT id, code, display_name, capacity_l, role, material FROM assets ORDER BY id');
    const { rows: tags } = await client.query('SELECT id, name, asset_id, parameter, point_type FROM tags ORDER BY id');

    if (assets.length === 0 || tags.length === 0) {
      throw new Error('Assets or tags missing. Ensure 03_seeds.sql was executed.');
    }

    const tagLookup = new Map();
    tags.forEach(t => tagLookup.set(`${t.asset_id}_${t.parameter}`, t));

    // 2. Clean existing historical data
    console.log('Cleaning old historical records (monitoring, events, batches, readings)...');
    await client.query('TRUNCATE TABLE monitoring_outbox, monitoring_jobs, events, batches CASCADE');
    await client.query('TRUNCATE TABLE readings');

    // 3. Initialize Reactor State Machines
    const reactors = assets.map(a => new ReactorSimulation(a, prng));
    const r1 = reactors.find(r => r.code === 'R1');
    const r2 = reactors.find(r => r.code === 'R2');
    const r3 = reactors.find(r => r.code === 'R3');

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

    const lastIntegerStates = new Map();

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

    // Stagger initial phases so the train is mid-production from day 1
    r3.transitionNextPhase('Cooling ramp');
    r2.transitionNextPhase('pH adjust');
    r1.transitionNextPhase('Reaction hold');

    // Seed initial active batches for the 3 staggered reactors
    const year = startTime.getUTCFullYear();
    
    // Batch 1 in R3
    const b1Str = `B-${year}-${String(batchSeq++).padStart(4, '0')}`;
    const { rows: b1Rows } = await client.query(
      `INSERT INTO batches (batch_id, product_code, recipe_version, current_asset_id, started_at, status)
       VALUES ($1, 'API-7734', 'v2.1', $2, $3, 'Running') RETURNING id`,
      [b1Str, r3.asset.id, new Date(startTime.getTime() - 14 * 3600 * 1000)]
    );
    r3.activeBatch = { id: b1Rows[0].id, batch_id: b1Str, started_at: startTime };
    const { rows: up3Rows } = await client.query(
      `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
       VALUES ($1, $2, 'Unit procedure R3 — Crystallisation', 'Unit Procedure', $3) RETURNING id`,
      [r3.activeBatch.id, r3.asset.id, startTime]
    );
    r3.activeUnitProcedureId = up3Rows[0].id;

    // Batch 2 in R2
    const b2Str = `B-${year}-${String(batchSeq++).padStart(4, '0')}`;
    const { rows: b2Rows } = await client.query(
      `INSERT INTO batches (batch_id, product_code, recipe_version, current_asset_id, started_at, status)
       VALUES ($1, 'API-7734', 'v2.1', $2, $3, 'Running') RETURNING id`,
      [b2Str, r2.asset.id, new Date(startTime.getTime() - 7 * 3600 * 1000)]
    );
    r2.activeBatch = { id: b2Rows[0].id, batch_id: b2Str, started_at: startTime };
    const { rows: up2Rows } = await client.query(
      `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
       VALUES ($1, $2, 'Unit procedure R2 — Workup', 'Unit Procedure', $3) RETURNING id`,
      [r2.activeBatch.id, r2.asset.id, startTime]
    );
    r2.activeUnitProcedureId = up2Rows[0].id;

    // Batch 3 in R1
    const b3Str = `B-${year}-${String(batchSeq++).padStart(4, '0')}`;
    const { rows: b3Rows } = await client.query(
      `INSERT INTO batches (batch_id, product_code, recipe_version, current_asset_id, started_at, status)
       VALUES ($1, 'API-7734', 'v2.1', $2, $3, 'Running') RETURNING id`,
      [b3Str, r1.asset.id, startTime]
    );
    r1.activeBatch = { id: b3Rows[0].id, batch_id: b3Str, started_at: startTime };
    const { rows: up1Rows } = await client.query(
      `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
       VALUES ($1, $2, 'Unit procedure R1 — Synthesis', 'Unit Procedure', $3) RETURNING id`,
      [r1.activeBatch.id, r1.asset.id, startTime]
    );
    r1.activeUnitProcedureId = up1Rows[0].id;

    console.log(`Backfilling timeline from ${startTime.toISOString()} to ${now.toISOString()}...`);
    let lastLoggedDay = -1;

    // Advance timeline in 5-second archive increments
    while (currentTime <= now) {
      const daysElapsed = Math.floor((currentTime - startTime) / (24 * 60 * 60 * 1000));
      if (daysElapsed !== lastLoggedDay) {
        lastLoggedDay = daysElapsed;
        console.log(`-> Backfilling Day ${daysElapsed + 1}/${DAYS_TO_SEED} (${totalReadings.toLocaleString()} readings persisted)`);
      }

      // Check if R1 needs a new batch
      if (!r1.activeBatch && (r1.currentPhase === 'Charging' || r1.currentPhase === 'Idle')) {
        if (r1.currentPhase === 'Idle') r1.transitionNextPhase('Charging');
        const bStr = `B-${currentTime.getUTCFullYear()}-${String(batchSeq++).padStart(4, '0')}`;
        const { rows } = await client.query(
          `INSERT INTO batches (batch_id, product_code, recipe_version, current_asset_id, started_at, status)
           VALUES ($1, 'API-7734', 'v2.1', $2, $3, 'Running') RETURNING id`,
          [bStr, r1.asset.id, currentTime]
        );
        r1.activeBatch = { id: rows[0].id, batch_id: bStr, started_at: new Date(currentTime) };

        const { rows: upRows } = await client.query(
          `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
           VALUES ($1, $2, 'Unit procedure R1 — Synthesis', 'Unit Procedure', $3) RETURNING id`,
          [r1.activeBatch.id, r1.asset.id, currentTime]
        );
        r1.activeUnitProcedureId = upRows[0].id;

        const { rows: pRows } = await client.query(
          `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
           VALUES ($1, $2, $3, 'Charging', 'Phase', 1, $4) RETURNING id`,
          [r1.activeBatch.id, r1.asset.id, r1.activeUnitProcedureId, currentTime]
        );
        r1.activePhaseEventId = pRows[0].id;
      }

      // Tick all reactors by 5 seconds
      for (const sim of reactors) {
        const phaseFinished = sim.tick(ARCHIVE_INTERVAL_SEC);

        if (sim.activeBatch && sim.activeUnitProcedureId && !sim.activePhaseEventId && sim.currentPhase !== 'Idle') {
          const { rows } = await client.query(
            `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
             VALUES ($1, $2, $3, $4, 'Phase', $5, $6) RETURNING id`,
            [sim.activeBatch.id, sim.asset.id, sim.activeUnitProcedureId, sim.currentPhase, sim.phaseOccurrence, currentTime]
          );
          sim.activePhaseEventId = rows[0].id;
        }

        if (phaseFinished) {
          if (sim.activePhaseEventId) {
            await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [currentTime, sim.activePhaseEventId]);
            sim.activePhaseEventId = null;
          }

          if (sim.code === 'R1' && sim.currentPhase === 'Transfer') {
            if (sim.activeUnitProcedureId) {
              await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [currentTime, sim.activeUnitProcedureId]);
              sim.activeUnitProcedureId = null;
            }
            const transferred = sim.activeBatch;
            sim.activeBatch = null;
            sim.transitionNextPhase('Clean');

            if (transferred && r2) {
              r2.activeBatch = transferred;
              await client.query('UPDATE batches SET current_asset_id = $1 WHERE id = $2', [r2.asset.id, transferred.id]);

              const { rows: up2 } = await client.query(
                `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
                 VALUES ($1, $2, 'Unit procedure R2 — Workup', 'Unit Procedure', $3) RETURNING id`,
                [transferred.id, r2.asset.id, currentTime]
              );
              r2.activeUnitProcedureId = up2[0].id;
              r2.transitionNextPhase('Receive');

              const { rows: p2 } = await client.query(
                `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
                 VALUES ($1, $2, $3, 'Receive', 'Phase', $4, $5) RETURNING id`,
                [transferred.id, r2.asset.id, r2.activeUnitProcedureId, r2.phaseOccurrence, currentTime]
              );
              r2.activePhaseEventId = p2[0].id;
            }

          } else if (sim.code === 'R2' && sim.currentPhase === 'Transfer') {
            if (sim.activeUnitProcedureId) {
              await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [currentTime, sim.activeUnitProcedureId]);
              sim.activeUnitProcedureId = null;
            }
            const transferred = sim.activeBatch;
            sim.activeBatch = null;
            sim.transitionNextPhase('Clean');

            if (transferred && r3) {
              r3.activeBatch = transferred;
              await client.query('UPDATE batches SET current_asset_id = $1 WHERE id = $2', [r3.asset.id, transferred.id]);

              const { rows: up3 } = await client.query(
                `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
                 VALUES ($1, $2, 'Unit procedure R3 — Crystallisation', 'Unit Procedure', $3) RETURNING id`,
                [transferred.id, r3.asset.id, currentTime]
              );
              r3.activeUnitProcedureId = up3[0].id;
              r3.transitionNextPhase('Receive');

              const { rows: p3 } = await client.query(
                `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
                 VALUES ($1, $2, $3, 'Receive', 'Phase', $4, $5) RETURNING id`,
                [transferred.id, r3.asset.id, r3.activeUnitProcedureId, r3.phaseOccurrence, currentTime]
              );
              r3.activePhaseEventId = p3[0].id;
            }

          } else if (sim.code === 'R3' && sim.currentPhase === 'Transfer') {
            if (sim.activeUnitProcedureId) {
              await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [currentTime, sim.activeUnitProcedureId]);
              sim.activeUnitProcedureId = null;
            }
            if (sim.activeBatch) {
              await client.query(
                "UPDATE batches SET ended_at = $1, status = 'Completed', current_asset_id = NULL WHERE id = $2",
                [currentTime, sim.activeBatch.id]
              );
              sim.activeBatch = null;
            }
            sim.transitionNextPhase('Clean');

          } else {
            sim.transitionNextPhase();
          }
        }

        // Collect readings
        for (const param of Object.keys(sim.values)) {
          const tag = tagLookup.get(`${sim.asset.id}_${param}`);
          if (!tag) continue;

          const val = sim.values[param];
          const quality = 0; // Good quality

          const isInteger = tag.point_type === 'integer';
          const recordVal = isInteger ? (val !== null ? Math.round(val) : null) : val;

          if (isInteger) {
            const lastVal = lastIntegerStates.get(tag.id);
            if (lastVal === undefined || lastVal !== recordVal) {
              lastIntegerStates.set(tag.id, recordVal);
            }
          }

          bufTagId.push(tag.id);
          bufTs.push(currentTime.toISOString());
          bufVal.push(recordVal);
          bufQuality.push(quality);
        }
      }

      // Flush readings when buffer is full
      if (bufTagId.length >= BATCH_FLUSH_SIZE) {
        await flushReadings();
      }

      // Advance by 5 seconds
      currentTime = new Date(currentTime.getTime() + ARCHIVE_INTERVAL_SEC * 1000);
    }

    // Flush any remaining readings
    await flushReadings();

    // 4. Update Snapshots with current live values
    console.log('Writing final live snapshots cache...');
    const sTagIds = [];
    const sTimes = [];
    const sVals = [];
    const sQualities = [];

    for (const sim of reactors) {
      for (const param of Object.keys(sim.values)) {
        const tag = tagLookup.get(`${sim.asset.id}_${param}`);
        if (!tag) continue;
        sTagIds.push(tag.id);
        sTimes.push(now.toISOString());
        sVals.push(sim.values[param]);
        sQualities.push(0);
      }
    }

    await client.query(
      `INSERT INTO snapshots (tag_id, ts, value, quality)
       SELECT * FROM UNNEST($1::int[], $2::timestamptz[], $3::float8[], $4::smallint[])
       ON CONFLICT (tag_id) DO UPDATE 
       SET ts = EXCLUDED.ts, value = EXCLUDED.value, quality = EXCLUDED.quality`,
      [sTagIds, sTimes, sVals, sQualities]
    );

    console.log(`\n=== Historical Backfill Completed Successfully! ===`);
    console.log(`- Total Readings Persisted: ${totalReadings.toLocaleString()}`);
    console.log(`- Total Batches Generated: ${batchSeq - 1}`);

  } catch (err) {
    console.error('Seeder encountered an error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seedHistory();