// simulator/src/seeder.js
import { pool } from './db.js';
import { PRNG } from './prng.js';
import { ReactorSimulation } from './stateMachine.js';

const SEED = Date.now();
const DAYS_TO_SEED = parseInt(process.argv[2] || '3', 10);
const ARCHIVE_INTERVAL_SEC = 5;                           // 5-second archive persistence
const BATCH_FLUSH_SIZE = 40000;                           // Multi-row array buffer size

async function seedHistory() {
  const client = await pool.connect();
  const prng = new PRNG(SEED);

  try {
    console.log(`\n--- Starting Historical Train Backfill (${DAYS_TO_SEED} days, seed: ${SEED}) ---`);

    // 1. Fetch Assets and Tags
    const { rows: assets } = await client.query('SELECT id, code, display_name, capacity_l, role, material FROM assets ORDER BY id');
    const { rows: tags } = await client.query(`
      SELECT id, name, asset_id, parameter, point_type, alarm_low, alarm_high, alarm_state_int 
      FROM tags ORDER BY id
    `);

    if (assets.length === 0 || tags.length === 0) {
      throw new Error('Assets or tags missing. Ensure 03_seeds.sql was executed.');
    }

    const tagLookup = new Map();
    tags.forEach(t => tagLookup.set(`${t.asset_id}_${t.parameter}`, t));

    // 2. Clean existing historical data and reset stale injected faults
    console.log('Cleaning old historical records (monitoring, events, batches, batch_exceptions, readings, faults)...');
    await client.query('TRUNCATE TABLE monitoring_outbox, monitoring_jobs, events, batches, batch_exceptions, injected_faults CASCADE');
    await client.query('TRUNCATE TABLE readings');

    // 3. Initialize Reactor State Machines (All start in Idle)
    const reactors = assets.map(a => new ReactorSimulation(a, prng));
    const r1 = reactors.find(r => r.code === 'R1');
    const r2 = reactors.find(r => r.code === 'R2');
    const r3 = reactors.find(r => r.code === 'R3');

    const now = new Date();
    const startTime = new Date(now.getTime() - DAYS_TO_SEED * 24 * 60 * 60 * 1000);
    let currentTime = new Date(startTime);

    let batchSeq = 1;
    let totalReadings = 0;
    let trainBatch = null; // { id, batch_id, started_at }

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

    // Exception tracking buffers
    const seederActiveExceptions = new Map();
    const finishedExceptions = [];
    let totalExceptionsCount = 0;

    const flushExceptions = async () => {
      if (finishedExceptions.length === 0) return;
      const bPks = finishedExceptions.map(e => e.batchPk);
      const aIds = finishedExceptions.map(e => e.assetId);
      const tIds = finishedExceptions.map(e => e.tagId);
      const pNames = finishedExceptions.map(e => e.phaseName);
      const eTypes = finishedExceptions.map(e => e.exceptionType);
      const lVals = finishedExceptions.map(e => e.limitValue);
      const pVals = finishedExceptions.map(e => e.peakValue);
      const sAts = finishedExceptions.map(e => e.startedAt);
      const eAts = finishedExceptions.map(e => e.endedAt);
      const dSecs = finishedExceptions.map(e => e.durationSec);
      const details = finishedExceptions.map(e => JSON.stringify({ peak: e.peakValue, limit: e.limitValue }));

      await client.query(
        `INSERT INTO batch_exceptions (batch_pk, asset_id, tag_id, phase_name, exception_type, limit_value, peak_value, started_at, ended_at, duration_sec, details)
         SELECT * FROM UNNEST($1::int[], $2::int[], $3::int[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::timestamptz[], $9::timestamptz[], $10::int[], $11::jsonb[])`,
        [bPks, aIds, tIds, pNames, eTypes, lVals, pVals, sAts, eAts, dSecs, details]
      );
      totalExceptionsCount += finishedExceptions.length;
      finishedExceptions.length = 0;
    };

    console.log(`Backfilling single-batch timeline from ${startTime.toISOString()} to ${now.toISOString()}...`);
    let lastLoggedDay = -1;

    // Helper to open a phase event
    const openPhaseEvent = async (sim, phaseName, batchPk, parentId = null) => {
      const { rows } = await client.query(
        `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
         VALUES ($1, $2, $3, $4, 'Phase', $5, $6) RETURNING id`,
        [batchPk || null, sim.asset.id, parentId || null, phaseName, sim.phaseOccurrence || 1, currentTime]
      );
      sim.activePhaseEventId = rows[0].id;
    };

    // Helper to close an event
    const closeEvent = async (eventId) => {
      if (!eventId) return;
      await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [currentTime, eventId]);
    };

    // Advance timeline in 5-second archive increments
    while (currentTime <= now) {
      const daysElapsed = Math.floor((currentTime - startTime) / (24 * 60 * 60 * 1000));
      if (daysElapsed !== lastLoggedDay) {
        lastLoggedDay = daysElapsed;
        console.log(`-> Backfilling Day ${daysElapsed + 1}/${DAYS_TO_SEED} (${totalReadings.toLocaleString()} readings persisted)`);
      }

      // 1. Train Orchestration: Ensure EXACTLY ONE batch is in the train
      if (!trainBatch && r1.currentPhase === 'Idle') {
        const bStr = `B-${currentTime.getUTCFullYear()}-${String(batchSeq++).padStart(4, '0')}`;
        const { rows: bRows } = await client.query(
          `INSERT INTO batches (batch_id, product_code, recipe_version, current_asset_id, started_at, status)
           VALUES ($1, 'API-7734', 'v2.1', $2, $3, 'Running') RETURNING id`,
          [bStr, r1.asset.id, currentTime]
        );
        trainBatch = { id: bRows[0].id, batch_id: bStr, started_at: new Date(currentTime) };
        r1.activeBatch = trainBatch;

        // Open Unit Procedure event for R1
        const { rows: upRows } = await client.query(
          `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
           VALUES ($1, $2, 'Unit procedure R1 — Synthesis', 'Unit Procedure', $3) RETURNING id`,
          [trainBatch.id, r1.asset.id, currentTime]
        );
        r1.activeUnitProcedureId = upRows[0].id;

        // Transition R1 into Charging
        r1.transitionNextPhase('Charging');
        await openPhaseEvent(r1, 'Charging', trainBatch.id, r1.activeUnitProcedureId);
      }

      // 2. Advance simulation ticks for all reactors
      for (const sim of reactors) {
        const phaseFinished = sim.tick(ARCHIVE_INTERVAL_SEC);

        if (phaseFinished) {
          // Close active phase event
          if (sim.activePhaseEventId) {
            await closeEvent(sim.activePhaseEventId);
            sim.activePhaseEventId = null;
          }

          // Strict ISA-88 Phase Flow
          if (sim.code === 'R1') {
            switch (sim.currentPhase) {
              case 'Charging':
                sim.transitionNextPhase('Heating');
                await openPhaseEvent(sim, 'Heating', trainBatch?.id, sim.activeUnitProcedureId);
                break;
              case 'Heating':
                sim.transitionNextPhase('Distillation');
                await openPhaseEvent(sim, 'Distillation', trainBatch?.id, sim.activeUnitProcedureId);
                break;
              case 'Distillation':
                sim.transitionNextPhase('Reaction hold');
                await openPhaseEvent(sim, 'Reaction hold', trainBatch?.id, sim.activeUnitProcedureId);
                break;
              case 'Reaction hold':
                sim.transitionNextPhase('Cooling');
                await openPhaseEvent(sim, 'Cooling', trainBatch?.id, sim.activeUnitProcedureId);
                break;
              case 'Cooling':
                // Synchronized Handoff to R2!
                const r1TransferDur = prng.rangeInt(900, 1500); // 15-25 min
                sim.transitionNextPhase('Transfer');
                sim.phaseDurationSec = r1TransferDur;
                await openPhaseEvent(sim, 'Transfer', trainBatch?.id, sim.activeUnitProcedureId);

                // R2 enters Receive at the exact same moment
                r2.activeBatch = trainBatch;
                r2.transitionNextPhase('Receive');
                r2.phaseDurationSec = r1TransferDur;
                await openPhaseEvent(r2, 'Receive', trainBatch?.id, null);
                break;
              case 'Transfer':
                // R1 handoff complete! Close R1 unit procedure
                if (sim.activeUnitProcedureId) {
                  await closeEvent(sim.activeUnitProcedureId);
                  sim.activeUnitProcedureId = null;
                }
                sim.activeBatch = null;
                sim.transitionNextPhase('Clean');
                await openPhaseEvent(sim, 'Clean', null);
                break;
              case 'Clean':
                sim.transitionNextPhase('Idle');
                // R1 stays in Idle until current train batch completes in R3
                break;
            }
          } else if (sim.code === 'R2') {
            switch (sim.currentPhase) {
              case 'Receive':
                // Material received from R1! Open R2 Unit Procedure
                await client.query('UPDATE batches SET current_asset_id = $1 WHERE id = $2', [r2.asset.id, trainBatch.id]);
                const { rows: up2Rows } = await client.query(
                  `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
                   VALUES ($1, $2, 'Unit procedure R2 — Workup', 'Unit Procedure', $3) RETURNING id`,
                  [trainBatch.id, r2.asset.id, currentTime]
                );
                r2.activeUnitProcedureId = up2Rows[0].id;
                sim.transitionNextPhase('pH adjust');
                await openPhaseEvent(sim, 'pH adjust', trainBatch?.id, sim.activeUnitProcedureId);
                break;
              case 'pH adjust':
                sim.transitionNextPhase('Settle & separate');
                await openPhaseEvent(sim, 'Settle & separate', trainBatch?.id, sim.activeUnitProcedureId);
                break;
              case 'Settle & separate':
                sim.transitionNextPhase('Solvent swap');
                await openPhaseEvent(sim, 'Solvent swap', trainBatch?.id, sim.activeUnitProcedureId);
                break;
              case 'Solvent swap':
                // Synchronized Handoff to R3!
                const r2TransferDur = prng.rangeInt(600, 1200); // 10-20 min
                sim.transitionNextPhase('Filter & transfer');
                sim.phaseDurationSec = r2TransferDur;
                await openPhaseEvent(sim, 'Filter & transfer', trainBatch?.id, sim.activeUnitProcedureId);

                // R3 enters Receive at the exact same moment
                r3.activeBatch = trainBatch;
                r3.transitionNextPhase('Receive');
                r3.phaseDurationSec = r2TransferDur;
                await openPhaseEvent(r3, 'Receive', trainBatch?.id, null);
                break;
              case 'Filter & transfer':
              case 'Transfer':
                // R2 handoff complete! Close R2 unit procedure
                if (sim.activeUnitProcedureId) {
                  await closeEvent(sim.activeUnitProcedureId);
                  sim.activeUnitProcedureId = null;
                }
                sim.activeBatch = null;
                sim.transitionNextPhase('Clean');
                await openPhaseEvent(sim, 'Clean', null);
                break;
              case 'Clean':
                sim.transitionNextPhase('Idle');
                // R2 stays in Idle
                break;
            }
          } else if (sim.code === 'R3') {
            switch (sim.currentPhase) {
              case 'Receive':
                // Material received from R2! Open R3 Unit Procedure
                await client.query('UPDATE batches SET current_asset_id = $1 WHERE id = $2', [r3.asset.id, trainBatch.id]);
                const { rows: up3Rows } = await client.query(
                  `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
                   VALUES ($1, $2, 'Unit procedure R3 — Crystallisation', 'Unit Procedure', $3) RETURNING id`,
                  [trainBatch.id, r3.asset.id, currentTime]
                );
                r3.activeUnitProcedureId = up3Rows[0].id;
                sim.transitionNextPhase('Heat to dissolve');
                await openPhaseEvent(sim, 'Heat to dissolve', trainBatch?.id, sim.activeUnitProcedureId);
                break;
              case 'Heat to dissolve':
                sim.transitionNextPhase('Cooling ramp');
                await openPhaseEvent(sim, 'Cooling ramp', trainBatch?.id, sim.activeUnitProcedureId);
                break;
              case 'Cooling ramp':
                sim.transitionNextPhase('Age');
                await openPhaseEvent(sim, 'Age', trainBatch?.id, sim.activeUnitProcedureId);
                break;
              case 'Age':
                sim.transitionNextPhase('Transfer');
                await openPhaseEvent(sim, 'Transfer', trainBatch?.id, sim.activeUnitProcedureId);
                break;
              case 'Transfer':
                // Batch Completed!
                if (sim.activeUnitProcedureId) {
                  await closeEvent(sim.activeUnitProcedureId);
                  sim.activeUnitProcedureId = null;
                }
                if (trainBatch) {
                  await client.query(
                    "UPDATE batches SET ended_at = $1, status = 'Completed', current_asset_id = NULL WHERE id = $2",
                    [currentTime, trainBatch.id]
                  );
                  trainBatch = null;
                }
                sim.activeBatch = null;
                sim.transitionNextPhase('Clean');
                await openPhaseEvent(sim, 'Clean', null);
                break;
              case 'Clean':
                sim.transitionNextPhase('Idle');
                // Train is fully cleared; R1 will now be eligible to start next batch!
                break;
            }
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

          // Check for operational exception in historical backfill
          let exType = null;
          let limitVal = null;
          if (tag.alarm_high !== null && val > tag.alarm_high) {
            exType = 'HIGH_LIMIT';
            limitVal = tag.alarm_high;
          } else if (tag.alarm_low !== null && val < tag.alarm_low) {
            exType = 'LOW_LIMIT';
            limitVal = tag.alarm_low;
          } else if (tag.alarm_state_int !== null && Math.round(val) === tag.alarm_state_int) {
            exType = 'STATE_ALARM';
            limitVal = tag.alarm_state_int;
          }

          const exKey = `${tag.id}`;
          const currentEx = seederActiveExceptions.get(exKey);

          if (exType && sim.activeBatch && val !== null) {
            if (!currentEx) {
              seederActiveExceptions.set(exKey, {
                batchPk: sim.activeBatch.id,
                assetId: sim.asset.id,
                tagId: tag.id,
                phaseName: sim.currentPhase,
                exceptionType: exType,
                limitValue: limitVal,
                peakValue: val,
                startedAt: new Date(currentTime)
              });
            } else {
              if (currentEx.exceptionType === 'HIGH_LIMIT' && val > currentEx.peakValue) {
                currentEx.peakValue = val;
              } else if (currentEx.exceptionType === 'LOW_LIMIT' && val < currentEx.peakValue) {
                currentEx.peakValue = val;
              }
            }
          } else if (currentEx) {
            seederActiveExceptions.delete(exKey);
            const durationSec = Math.max(1, Math.round((currentTime.getTime() - currentEx.startedAt.getTime()) / 1000));
            finishedExceptions.push({
              ...currentEx,
              endedAt: new Date(currentTime),
              durationSec
            });
          }
        }
      }

      // Flush readings when buffer is full
      if (bufTagId.length >= BATCH_FLUSH_SIZE) {
        await flushReadings();
      }
      if (finishedExceptions.length >= 2000) {
        await flushExceptions();
      }

      // Advance by 5 seconds
      currentTime = new Date(currentTime.getTime() + ARCHIVE_INTERVAL_SEC * 1000);
    }

    // Flush any remaining readings & exceptions
    await flushReadings();
    for (const [key, currentEx] of seederActiveExceptions.entries()) {
      const durationSec = Math.max(1, Math.round((currentTime.getTime() - currentEx.startedAt.getTime()) / 1000));
      finishedExceptions.push({
        ...currentEx,
        endedAt: new Date(currentTime),
        durationSec
      });
    }
    await flushExceptions();

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
    console.log(`- Active In-Flight Batch: ${trainBatch ? trainBatch.batch_id : 'None (idle train)'}`);
    console.log(`- Total Batch Exceptions Persisted: ${totalExceptionsCount}`);

  } catch (err) {
    console.error('Seeder encountered an error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seedHistory();