// simulator/src/index.js
import { pool } from './db.js';
import { PRNG } from './prng.js';
import { ReactorSimulation } from './stateMachine.js';

const ARCHIVE_INTERVAL_SEC = 5;
const prng = new PRNG(Date.now());

async function startEngine() {
  const client = await pool.connect();

  try {
    console.log('--- Initializing Continuous Simulation Engine (Single-Batch Train) ---');

    // 1. Fetch Assets and Tags
    const { rows: assets } = await client.query('SELECT id, code, display_name, capacity_l, role, material FROM assets ORDER BY id');
    const { rows: tags } = await client.query(`
      SELECT id, name, asset_id, parameter, point_type, range_min, range_max, 
             alarm_low, alarm_high, alarm_state_int, is_cpp, display_digits
      FROM tags ORDER BY id
    `);

    if (assets.length === 0 || tags.length === 0) {
      throw new Error('Assets or tags missing. Ensure 03_seeds.sql was executed.');
    }

    const tagLookup = new Map();
    const tagById = new Map();
    tags.forEach(t => {
      tagLookup.set(`${t.asset_id}_${t.parameter}`, t);
      tagById.set(t.id, t);
    });

    // 2. Initialize State Machines for R1, R2, R3
    const reactors = assets.map(a => new ReactorSimulation(a, prng));
    const r1 = reactors.find(r => r.code === 'R1');
    const r2 = reactors.find(r => r.code === 'R2');
    const r3 = reactors.find(r => r.code === 'R3');

    // 3. Batch Counter Initialization
    const { rows: maxBatch } = await client.query(
      "SELECT batch_id FROM batches ORDER BY id DESC LIMIT 1"
    );
    let batchSeq = 1;
    if (maxBatch.length > 0) {
      const parts = maxBatch[0].batch_id.split('-');
      if (parts.length === 3) batchSeq = parseInt(parts[2], 10) + 1;
    }

    // Active alarms tracking map: `${tagId}` -> eventId
    const activeAlarms = new Map();

    // Active batch exceptions tracking map: `${tagId}` -> { id, batchPk, type, limitVal, peakVal, startedAt }
    const activeExceptions = new Map();

    // Previous integer states map: `${tagId}` -> lastValue
    const lastIntegerStates = new Map();

    // Archive write buffer for 5-second float samples and change-of-state integer samples
    let archiveBuffer = [];
    let secondsSinceLastArchive = 0;

    // Outbox & Monitoring check counter
    let outboxCheckCounter = 0;

    // -------------------------------------------------------------
    // Autonomous Chaos Engine Configuration & Tracking (Disabled by default)
    // -------------------------------------------------------------
    const CHAOS_ENABLED = process.env.CHAOS_ENABLED === 'true';
    const CHAOS_MIN_INTERVAL_SEC = parseInt(process.env.CHAOS_MIN_INTERVAL_SEC || '60', 10);
    const CHAOS_MAX_INTERVAL_SEC = parseInt(process.env.CHAOS_MAX_INTERVAL_SEC || '240', 10);
    const CHAOS_MIN_DURATION_SEC = parseInt(process.env.CHAOS_MIN_DURATION_SEC || '20', 10);
    const CHAOS_MAX_DURATION_SEC = parseInt(process.env.CHAOS_MAX_DURATION_SEC || '45', 10);
    const CHAOS_MAX_ACTIVE = parseInt(process.env.CHAOS_MAX_ACTIVE || '1', 10);

    let nextChaosTime = Date.now() + prng.rangeInt(60, 180) * 1000;
    const activeChaosFaults = new Map();

    // Clear any stale un-cleared faults on startup to ensure clean initial conditions
    try {
      await client.query("UPDATE injected_faults SET cleared_at = NOW() WHERE cleared_at IS NULL");
    } catch (e) {
      // ignore if table not present
    }

    // -------------------------------------------------------------
    // Single-Batch Train Crash Recovery & Rehydration
    // -------------------------------------------------------------
    let trainBatch = null;

    try {
      const { rows: activeBatches } = await client.query(
        "SELECT id, batch_id, current_asset_id, started_at FROM batches WHERE status = 'Running' ORDER BY started_at DESC"
      );

      if (activeBatches.length > 0) {
        trainBatch = activeBatches[0];

        // Clean up any extraneous running batches (enforce single batch in train)
        if (activeBatches.length > 1) {
          const olderIds = activeBatches.slice(1).map(b => b.id);
          await client.query(
            "UPDATE batches SET status = 'Completed', ended_at = NOW(), current_asset_id = NULL WHERE id = ANY($1::int[])",
            [olderIds]
          );
        }

        // Rehydrate the active reactor holding the batch
        for (const sim of reactors) {
          if (sim.asset.id === trainBatch.current_asset_id) {
            sim.activeBatch = trainBatch;

            const { rows: upEv } = await client.query(
              "SELECT id FROM events WHERE batch_pk = $1 AND asset_id = $2 AND level = 'Unit Procedure' AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
              [trainBatch.id, sim.asset.id]
            );
            if (upEv.length > 0) sim.activeUnitProcedureId = upEv[0].id;

            const { rows: phEv } = await client.query(
              "SELECT id, name, occurrence FROM events WHERE asset_id = $1 AND level = 'Phase' AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
              [sim.asset.id]
            );
            if (phEv.length > 0) {
              sim.activePhaseEventId = phEv[0].id;
              sim.currentPhase = phEv[0].name;
              sim.phaseOccurrence = phEv[0].occurrence || 1;
            }
            console.log(`[Crash Recovery] Restored train batch ${trainBatch.batch_id} in ${sim.code} (Phase: ${sim.currentPhase})`);
          } else {
            // Check if this vessel has an active Clean phase event
            const { rows: cleanEv } = await client.query(
              "SELECT id, name FROM events WHERE asset_id = $1 AND level = 'Phase' AND name = 'Clean' AND ended_at IS NULL LIMIT 1",
              [sim.asset.id]
            );
            if (cleanEv.length > 0) {
              sim.activePhaseEventId = cleanEv[0].id;
              sim.currentPhase = 'Clean';
              sim.activeBatch = null;
            } else {
              sim.activeBatch = null;
              sim.currentPhase = 'Idle';
              sim.activePhaseEventId = null;
              sim.activeUnitProcedureId = null;
            }
          }
        }
      } else {
        // All reactors start in Idle
        reactors.forEach(r => {
          r.currentPhase = 'Idle';
          r.activeBatch = null;
        });
      }

      // Close dangling phase/UP events from orphaned records
      const activeEvIds = reactors.flatMap(r => [r.activePhaseEventId, r.activeUnitProcedureId]).filter(Boolean);
      if (activeEvIds.length > 0) {
        await client.query(
          "UPDATE events SET ended_at = NOW() WHERE ended_at IS NULL AND id != ALL($1::int[])",
          [activeEvIds]
        );
      }
    } catch (e) {
      console.warn('Startup batch recovery note:', e.message);
    }

    console.log(`Simulation ready. Managing single-batch train across 3 reactors with ${tags.length} tags.`);

    // Helper functions for event management
    const openPhaseEvent = async (sim, phaseName, batchPk, parentId = null, now = new Date()) => {
      const { rows } = await client.query(
        `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
         VALUES ($1, $2, $3, $4, 'Phase', $5, $6) RETURNING id`,
        [batchPk || null, sim.asset.id, parentId || null, phaseName, sim.phaseOccurrence || 1, now]
      );
      sim.activePhaseEventId = rows[0].id;
    };

    const closeEvent = async (eventId, now = new Date()) => {
      if (!eventId) return;
      await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, eventId]);
    };

    // Monotonic clock timer with drift compensation
    let expectedNextTick = Date.now() + 1000;

    const tick = async () => {
      const now = new Date();

      try {
        // 0. Poll simulation_control state
        let simRunning = true;
        let simSpeed = 1;
        let phaseSkipAsset = null;
        let simMode = 'continuous';
        let assignedBatchId = null;
        let batchCommand = null;
        let singleBatchStatus = 'idle';

        try {
          const { rows: ctrl } = await client.query('SELECT running, speed, phase_skip_asset, mode, assigned_batch_id, batch_command, single_batch_status FROM simulation_control WHERE id = 1');
          if (ctrl.length > 0) {
            simRunning = ctrl[0].running;
            simSpeed = ctrl[0].speed;
            phaseSkipAsset = ctrl[0].phase_skip_asset;
            simMode = ctrl[0].mode || 'continuous';
            assignedBatchId = ctrl[0].assigned_batch_id || null;
            batchCommand = ctrl[0].batch_command || null;
            singleBatchStatus = ctrl[0].single_batch_status || 'idle';
          }
        } catch (ctrlErr) {
          // Table may not yet be initialized
        }

        if (phaseSkipAsset) {
          await client.query('UPDATE simulation_control SET phase_skip_asset = NULL WHERE id = 1').catch(() => {});
        }

        // 0b. Process User-Assigned Batch Commands
        if (batchCommand) {
          await client.query("UPDATE simulation_control SET batch_command = NULL, single_batch_status = 'running', updated_at = NOW() WHERE id = 1").catch(() => {});

          await client.query('BEGIN');
          try {
            // Displace all active events & batches across all vessels
            for (const vessel of reactors) {
              if (vessel.activePhaseEventId) {
                await closeEvent(vessel.activePhaseEventId, now);
                vessel.activePhaseEventId = null;
              }
              if (vessel.activeUnitProcedureId) {
                await closeEvent(vessel.activeUnitProcedureId, now);
                vessel.activeUnitProcedureId = null;
              }
              vessel.activeBatch = null;
              vessel.transitionNextPhase('Idle');
              vessel.phaseElapsedSec = 0;
            }

            if (trainBatch) {
              await client.query("UPDATE batches SET ended_at = $1, status = 'Aborted', current_asset_id = NULL WHERE id = $2", [now, trainBatch.id]);
              console.log(`[Single Batch] Displaced previous batch ${trainBatch.batch_id} for user batch ${assignedBatchId}`);
              trainBatch = null;
            }

            let batchIdStr = (assignedBatchId || '').trim();
            if (!batchIdStr) {
              const year = now.getUTCFullYear();
              batchIdStr = `B-${year}-${String(batchSeq++).padStart(4, '0')}`;
            } else if (/^\d+$/.test(batchIdStr)) {
              const year = now.getUTCFullYear();
              batchIdStr = `B-${year}-${batchIdStr.padStart(4, '0')}`;
            }

            const { rows: existing } = await client.query('SELECT id FROM batches WHERE batch_id = $1', [batchIdStr]);
            if (existing.length > 0) {
              batchIdStr = `${batchIdStr}-${Date.now().toString().slice(-4)}`;
            }

            const { rows: bRows } = await client.query(
              `INSERT INTO batches (batch_id, product_code, recipe_version, current_asset_id, started_at, status)
               VALUES ($1, 'API-7734', 'v2.1', $2, $3, 'Running') RETURNING id`,
              [batchIdStr, r1.asset.id, now]
            );
            trainBatch = { id: bRows[0].id, batch_id: batchIdStr, started_at: now };
            r1.activeBatch = trainBatch;

            // Open Unit Procedure event for R1
            const { rows: upRows } = await client.query(
              `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
               VALUES ($1, $2, 'Unit procedure R1 — Synthesis', 'Unit Procedure', $3) RETURNING id`,
              [trainBatch.id, r1.asset.id, now]
            );
            r1.activeUnitProcedureId = upRows[0].id;

            // Transition R1 to Charging
            r1.transitionNextPhase('Charging');
            await openPhaseEvent(r1, 'Charging', trainBatch.id, r1.activeUnitProcedureId, now);

            await client.query('UPDATE simulation_control SET assigned_batch_id = $1, single_batch_status = $2 WHERE id = 1', [batchIdStr, 'running']);
            await client.query('COMMIT');
            console.log(`[Single Batch] Started user batch ${batchIdStr} in R1 (Charging)`);
          } catch (txErr) {
            await client.query('ROLLBACK');
            console.error('[Single Batch] Transaction error starting assigned batch:', txErr.message);
          }
        }

        // -------------------------------------------------------------
        // AUTONOMOUS CHAOS ENGINE (Optional, disabled by default)
        // -------------------------------------------------------------
        if (CHAOS_ENABLED && simRunning) {
          for (const [faultId, faultInfo] of activeChaosFaults.entries()) {
            if (now.getTime() >= faultInfo.clearTime) {
              try {
                await client.query('UPDATE injected_faults SET cleared_at = $1 WHERE id = $2 AND cleared_at IS NULL', [now, faultId]);
                activeChaosFaults.delete(faultId);
                console.log(`[CHAOS ENGINE] Cleared fault #${faultId}: ${faultInfo.kind} on ${faultInfo.tagName}`);
              } catch (err) {
                console.error(`[CHAOS ENGINE] Error clearing fault #${faultId}:`, err.message);
              }
            }
          }

          if (now.getTime() >= nextChaosTime && activeChaosFaults.size < CHAOS_MAX_ACTIVE) {
            nextChaosTime = now.getTime() + prng.rangeInt(CHAOS_MIN_INTERVAL_SEC, CHAOS_MAX_INTERVAL_SEC) * 1000;
            const candidateTags = tags.filter(t => t.point_type === 'float' || t.point_type === 'float_calculated');
            if (candidateTags.length > 0) {
              const selectedTag = candidateTags[prng.rangeInt(0, candidateTags.length - 1)];
              const kinds = ['dropout', 'spike', 'drift', 'stuck', 'quality'];
              const selectedKind = kinds[prng.rangeInt(0, kinds.length - 1)];

              let magnitude = null;
              if (selectedKind === 'spike') magnitude = prng.range(5.0, 15.0);
              else if (selectedKind === 'drift') magnitude = (prng.next() > 0.5 ? 1 : -1) * prng.range(2.0, 5.0);
              else if (selectedKind === 'stuck') magnitude = 50.0;
              else if (selectedKind === 'quality') magnitude = 1.0;

              const durationSec = prng.rangeInt(CHAOS_MIN_DURATION_SEC, CHAOS_MAX_DURATION_SEC);
              const clearTime = now.getTime() + durationSec * 1000;
              const cleanMagnitude = magnitude !== null ? parseFloat(magnitude.toFixed(2)) : null;

              try {
                const { rows: inserted } = await client.query(
                  `INSERT INTO injected_faults (tag_id, kind, magnitude, started_at) VALUES ($1, $2, $3, $4) RETURNING id`,
                  [selectedTag.id, selectedKind, cleanMagnitude, now]
                );
                const faultId = inserted[0].id;
                activeChaosFaults.set(faultId, { id: faultId, tagId: selectedTag.id, tagName: selectedTag.name, kind: selectedKind, magnitude: cleanMagnitude, clearTime });
              } catch (err) {
                console.error('[CHAOS ENGINE] Failed to inject autonomous fault:', err.message);
              }
            }
          }
        }

        // Query active injected faults
        const { rows: faults } = await client.query('SELECT tag_id, kind, magnitude FROM injected_faults WHERE cleared_at IS NULL');
        const activeFaultMap = new Map();
        faults.forEach(f => activeFaultMap.set(f.tag_id, f));

        // Buffer for multi-row UPSERT into snapshots
        const snapshotTagIds = [];
        const snapshotVals = [];
        const snapshotQualities = [];
        const snapshotTimes = [];

        // -------------------------------------------------------------
        // A. ADVANCE TRAIN & MANAGE ISA-88 BATCH / EVENT LIFECYCLES
        // -------------------------------------------------------------

        // 1. In continuous mode, start a new batch if train is completely empty and R1 is Idle
        if (simMode === 'continuous' && simRunning && !trainBatch && r1.currentPhase === 'Idle') {
          const year = now.getUTCFullYear();
          let bRows = [];
          let batchIdStr = '';
          while (bRows.length === 0) {
            batchIdStr = `B-${year}-${String(batchSeq++).padStart(4, '0')}`;
            const res = await client.query(
              `INSERT INTO batches (batch_id, product_code, recipe_version, current_asset_id, started_at, status)
               VALUES ($1, 'API-7734', 'v2.1', $2, $3, 'Running')
               ON CONFLICT (batch_id) DO NOTHING RETURNING id`,
              [batchIdStr, r1.asset.id, now]
            );
            bRows = res.rows;
          }
          trainBatch = { id: bRows[0].id, batch_id: batchIdStr, started_at: now };
          r1.activeBatch = trainBatch;

          // Open Unit Procedure event for R1
          const { rows: upRows } = await client.query(
            `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
             VALUES ($1, $2, 'Unit procedure R1 — Synthesis', 'Unit Procedure', $3) RETURNING id`,
            [trainBatch.id, r1.asset.id, now]
          );
          r1.activeUnitProcedureId = upRows[0].id;

          // Transition R1 into Charging
          r1.transitionNextPhase('Charging');
          await openPhaseEvent(r1, 'Charging', trainBatch.id, r1.activeUnitProcedureId, now);
          console.log(`[Batch Train] Started Batch ${batchIdStr} in R1 (Charging)`);
        }

        // 2. Advance simulation ticks for R1, R2, R3
        const deltaSec = simRunning ? simSpeed : 0;
        for (const sim of reactors) {
          const forcePhaseFinish = Boolean(phaseSkipAsset && sim.code === phaseSkipAsset);
          const phaseFinished = (simRunning && sim.tick(deltaSec)) || forcePhaseFinish;

          if (phaseFinished) {
            // Close active phase event
            if (sim.activePhaseEventId) {
              await closeEvent(sim.activePhaseEventId, now);
              sim.activePhaseEventId = null;
            }

            // Strict ISA-88 Phase Flow
            if (sim.code === 'R1') {
              switch (sim.currentPhase) {
                case 'Charging':
                  sim.transitionNextPhase('Heating');
                  await openPhaseEvent(sim, 'Heating', trainBatch?.id, sim.activeUnitProcedureId, now);
                  break;
                case 'Heating':
                  sim.transitionNextPhase('Distillation');
                  await openPhaseEvent(sim, 'Distillation', trainBatch?.id, sim.activeUnitProcedureId, now);
                  break;
                case 'Distillation':
                  sim.transitionNextPhase('Reaction hold');
                  await openPhaseEvent(sim, 'Reaction hold', trainBatch?.id, sim.activeUnitProcedureId, now);
                  break;
                case 'Reaction hold':
                  sim.transitionNextPhase('Cooling');
                  await openPhaseEvent(sim, 'Cooling', trainBatch?.id, sim.activeUnitProcedureId, now);
                  break;
                case 'Cooling':
                  // Synchronized Handoff to R2!
                  const r1TransferDur = prng.rangeInt(900, 1500); // 15-25 min
                  sim.transitionNextPhase('Transfer');
                  sim.phaseDurationSec = r1TransferDur;
                  await openPhaseEvent(sim, 'Transfer', trainBatch?.id, sim.activeUnitProcedureId, now);

                  // R2 enters Receive at the exact same moment
                  r2.activeBatch = trainBatch;
                  r2.transitionNextPhase('Receive');
                  r2.phaseDurationSec = r1TransferDur;
                  await openPhaseEvent(r2, 'Receive', trainBatch?.id, null, now);
                  console.log(`[Batch Train] Batch ${trainBatch?.batch_id} transferring R1 -> R2 (Receive)`);
                  break;
                case 'Transfer':
                  // R1 handoff complete! Close R1 unit procedure
                  if (sim.activeUnitProcedureId) {
                    await closeEvent(sim.activeUnitProcedureId, now);
                    sim.activeUnitProcedureId = null;
                  }
                  sim.activeBatch = null;
                  sim.transitionNextPhase('Clean');
                  await openPhaseEvent(sim, 'Clean', null, null, now);
                  break;
                case 'Clean':
                  sim.transitionNextPhase('Idle');
                  // R1 stays in Idle until current train batch finishes R3
                  break;
              }
            } else if (sim.code === 'R2') {
              switch (sim.currentPhase) {
                case 'Receive':
                  // Material received from R1! Open R2 Unit Procedure
                  if (trainBatch) {
                    await client.query('UPDATE batches SET current_asset_id = $1 WHERE id = $2', [r2.asset.id, trainBatch.id]);
                    const { rows: up2Rows } = await client.query(
                      `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
                       VALUES ($1, $2, 'Unit procedure R2 — Workup', 'Unit Procedure', $3) RETURNING id`,
                      [trainBatch.id, r2.asset.id, now]
                    );
                    r2.activeUnitProcedureId = up2Rows[0].id;
                  }
                  sim.transitionNextPhase('pH adjust');
                  await openPhaseEvent(sim, 'pH adjust', trainBatch?.id, sim.activeUnitProcedureId, now);
                  break;
                case 'pH adjust':
                  sim.transitionNextPhase('Settle & separate');
                  await openPhaseEvent(sim, 'Settle & separate', trainBatch?.id, sim.activeUnitProcedureId, now);
                  break;
                case 'Settle & separate':
                  sim.transitionNextPhase('Solvent swap');
                  await openPhaseEvent(sim, 'Solvent swap', trainBatch?.id, sim.activeUnitProcedureId, now);
                  break;
                case 'Solvent swap':
                  // Synchronized Handoff to R3!
                  const r2TransferDur = prng.rangeInt(600, 1200); // 10-20 min
                  sim.transitionNextPhase('Filter & transfer');
                  sim.phaseDurationSec = r2TransferDur;
                  await openPhaseEvent(sim, 'Filter & transfer', trainBatch?.id, sim.activeUnitProcedureId, now);

                  // R3 enters Receive at the exact same moment
                  r3.activeBatch = trainBatch;
                  r3.transitionNextPhase('Receive');
                  r3.phaseDurationSec = r2TransferDur;
                  await openPhaseEvent(r3, 'Receive', trainBatch?.id, null, now);
                  console.log(`[Batch Train] Batch ${trainBatch?.batch_id} transferring R2 -> R3 (Receive)`);
                  break;
                case 'Filter & transfer':
                case 'Transfer':
                  // R2 handoff complete! Close R2 unit procedure
                  if (sim.activeUnitProcedureId) {
                    await closeEvent(sim.activeUnitProcedureId, now);
                    sim.activeUnitProcedureId = null;
                  }
                  sim.activeBatch = null;
                  sim.transitionNextPhase('Clean');
                  await openPhaseEvent(sim, 'Clean', null, null, now);
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
                  if (trainBatch) {
                    await client.query('UPDATE batches SET current_asset_id = $1 WHERE id = $2', [r3.asset.id, trainBatch.id]);
                    const { rows: up3Rows } = await client.query(
                      `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
                       VALUES ($1, $2, 'Unit procedure R3 — Crystallisation', 'Unit Procedure', $3) RETURNING id`,
                      [trainBatch.id, r3.asset.id, now]
                    );
                    r3.activeUnitProcedureId = up3Rows[0].id;
                  }
                  sim.transitionNextPhase('Heat to dissolve');
                  await openPhaseEvent(sim, 'Heat to dissolve', trainBatch?.id, sim.activeUnitProcedureId, now);
                  break;
                case 'Heat to dissolve':
                  sim.transitionNextPhase('Cooling ramp');
                  await openPhaseEvent(sim, 'Cooling ramp', trainBatch?.id, sim.activeUnitProcedureId, now);
                  break;
                case 'Cooling ramp':
                  sim.transitionNextPhase('Age');
                  await openPhaseEvent(sim, 'Age', trainBatch?.id, sim.activeUnitProcedureId, now);
                  break;
                case 'Age':
                  sim.transitionNextPhase('Transfer');
                  await openPhaseEvent(sim, 'Transfer', trainBatch?.id, sim.activeUnitProcedureId, now);
                  break;
                case 'Transfer':
                  // Batch Completed!
                  if (sim.activeUnitProcedureId) {
                    await closeEvent(sim.activeUnitProcedureId, now);
                    sim.activeUnitProcedureId = null;
                  }
                  if (trainBatch) {
                    const finishedId = trainBatch.batch_id;
                    await client.query(
                      "UPDATE batches SET ended_at = $1, status = 'Completed', current_asset_id = NULL WHERE id = $2",
                      [now, trainBatch.id]
                    );
                    console.log(`[Batch Train] Batch ${finishedId} Completed successfully!`);
                    trainBatch = null;

                    if (simMode === 'single') {
                      await client.query("UPDATE simulation_control SET single_batch_status = 'completed', updated_at = NOW() WHERE id = 1").catch(() => {});
                    }
                  }
                  sim.activeBatch = null;
                  sim.transitionNextPhase('Clean');
                  await openPhaseEvent(sim, 'Clean', null, null, now);
                  break;
                case 'Clean':
                  sim.transitionNextPhase('Idle');
                  // Train is fully cleared; R1 will start next batch at next tick in continuous mode!
                  break;
              }
            }
          }
        }

        // -------------------------------------------------------------
        // B. EVALUATE READINGS, FAULTS, ALARMS, AND ARCHIVING
        // -------------------------------------------------------------
        for (const sim of reactors) {
          for (const param of Object.keys(sim.values)) {
            const tag = tagLookup.get(`${sim.asset.id}_${param}`);
            if (!tag) continue;

            let val = sim.values[param];
            let quality = sim.qualities[param] || 0;

            // Apply injected fault if present
            const fault = activeFaultMap.get(tag.id);
            if (fault) {
              switch (fault.kind) {
                case 'stuck':
                  val = fault.magnitude ?? val;
                  quality = 1;
                  break;
                case 'drift':
                  val += (fault.magnitude ?? 5.0);
                  quality = 1;
                  break;
                case 'dropout':
                  val = null;
                  quality = 2;
                  break;
                case 'spike':
                  val += (fault.magnitude ?? 10.0);
                  quality = 1;
                  break;
                case 'quality':
                  quality = fault.magnitude ? Math.floor(fault.magnitude) : 2;
                  break;
                case 'override':
                  val = fault.magnitude ?? val;
                  break;
              }
            }

            // Stage for snapshots table (live 1s cache)
            snapshotTagIds.push(tag.id);
            snapshotVals.push(val);
            snapshotQualities.push(quality);
            snapshotTimes.push(now.toISOString());

            // Check Process Alarms & Sensor Faults
            let isAlarmActive = false;
            let alarmMsg = '';
            let exceptionType = null;
            let limitValue = null;

            if (quality === 2 || val === null) {
              isAlarmActive = true;
              alarmMsg = `${tag.name} Sensor Fault (Dropout / Disconnected)`;
            } else {
              const digits = tag.display_digits ?? 1;
              if (tag.alarm_high !== null && val > tag.alarm_high) {
                isAlarmActive = true;
                exceptionType = 'HIGH_LIMIT';
                limitValue = tag.alarm_high;
                alarmMsg = `${tag.name} High Alarm (${val.toFixed(digits)} > ${tag.alarm_high})`;
              } else if (tag.alarm_low !== null && val < tag.alarm_low) {
                isAlarmActive = true;
                exceptionType = 'LOW_LIMIT';
                limitValue = tag.alarm_low;
                alarmMsg = `${tag.name} Low Alarm (${val.toFixed(digits)} < ${tag.alarm_low})`;
              } else if (tag.alarm_state_int !== null && Math.round(val) === tag.alarm_state_int) {
                isAlarmActive = true;
                exceptionType = 'STATE_ALARM';
                limitValue = tag.alarm_state_int;
                alarmMsg = `${tag.name} State Alarm (State = ${tag.alarm_state_int})`;
              }
            }

            const alarmKey = `${tag.id}`;
            const existingAlarm = activeAlarms.get(alarmKey);

            if (isAlarmActive) {
              if (!existingAlarm) {
                try {
                  const { rows: aRows } = await client.query(
                    `INSERT INTO events (batch_pk, asset_id, parent_id, tag_id, name, level, started_at, details)
                     VALUES ($1, $2, $3, $4, $5, 'Alarm', $6, $7) RETURNING id`,
                    [sim.activeBatch ? sim.activeBatch.id : null, sim.asset.id, sim.activePhaseEventId, tag.id, alarmMsg, now, JSON.stringify({ val })]
                  );
                  activeAlarms.set(alarmKey, { id: aRows[0].id, msg: alarmMsg });
                  console.log(`[ALARM TRIGGERED] ${alarmMsg}`);
                } catch (e) {
                  console.error('Error logging alarm event:', e.message);
                }
              }
            } else if (existingAlarm) {
              activeAlarms.delete(alarmKey);
              try {
                await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, existingAlarm.id]);
                console.log(`[ALARM CLEARED] ${tag.name} returned to normal.`);
              } catch (e) {
                console.error('Error clearing alarm event:', e.message);
              }
            }

            // Track Batch Exceptions
            const existingEx = activeExceptions.get(alarmKey);
            if (exceptionType && sim.activeBatch && val !== null) {
              if (!existingEx) {
                try {
                  const { rows: exRows } = await client.query(
                    `INSERT INTO batch_exceptions (batch_pk, asset_id, tag_id, phase_name, exception_type, limit_value, peak_value, started_at, details)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
                    [
                      sim.activeBatch.id,
                      sim.asset.id,
                      tag.id,
                      sim.currentPhase,
                      exceptionType,
                      limitValue,
                      val,
                      now,
                      JSON.stringify({ initial_val: val, phase: sim.currentPhase, occurrence: sim.phaseOccurrence || 1 })
                    ]
                  );
                  activeExceptions.set(alarmKey, {
                    id: exRows[0].id,
                    batchPk: sim.activeBatch.id,
                    type: exceptionType,
                    limitVal: limitValue,
                    peakVal: val,
                    startedAt: now
                  });
                } catch (e) {
                  console.error('Error logging batch exception:', e.message);
                }
              } else {
                let isNewPeak = false;
                if (existingEx.type === 'HIGH_LIMIT' && val > existingEx.peakVal) {
                  existingEx.peakVal = val;
                  isNewPeak = true;
                } else if (existingEx.type === 'LOW_LIMIT' && val < existingEx.peakVal) {
                  existingEx.peakVal = val;
                  isNewPeak = true;
                }
                if (isNewPeak) {
                  try {
                    await client.query('UPDATE batch_exceptions SET peak_value = $1 WHERE id = $2', [existingEx.peakVal, existingEx.id]);
                  } catch (e) {
                    console.error('Error updating batch exception peak value:', e.message);
                  }
                }
              }
            } else if (existingEx) {
              activeExceptions.delete(alarmKey);
              const durationSec = Math.max(1, Math.round((now.getTime() - new Date(existingEx.startedAt).getTime()) / 1000));
              try {
                await client.query(
                  'UPDATE batch_exceptions SET ended_at = $1, duration_sec = $2, peak_value = $3 WHERE id = $4',
                  [now, durationSec, existingEx.peakVal, existingEx.id]
                );
              } catch (e) {
                console.error('Error closing batch exception:', e.message);
              }
            }

            // Archiving
            const isInteger = tag.point_type === 'integer';
            const recordVal = isInteger ? (val !== null ? Math.round(val) : null) : val;

            if (isInteger) {
              const lastVal = lastIntegerStates.get(tag.id);
              if (lastVal === undefined || lastVal !== recordVal) {
                lastIntegerStates.set(tag.id, recordVal);

                if (sim.activeBatch && sim.activePhaseEventId && lastVal !== undefined) {
                  try {
                    await client.query(
                      `INSERT INTO events (batch_pk, asset_id, parent_id, tag_id, name, level, started_at, ended_at, details)
                       VALUES ($1, $2, $3, $4, $5, 'StateChange', $6, $6, $7)`,
                      [
                        sim.activeBatch.id, sim.asset.id, sim.activePhaseEventId, tag.id,
                        `${tag.name} -> ${recordVal}`, now, JSON.stringify({ from: lastVal, to: recordVal })
                      ]
                    );
                  } catch (e) { /* ignore state change event failure */ }
                }
              }
            }

            archiveBuffer.push({ tagId: tag.id, ts: now.toISOString(), val: recordVal, quality });
          }
        }

        // -------------------------------------------------------------
        // C. WRITE LIVE SNAPSHOTS & PERIODIC ARCHIVE HYPERTABLE
        // -------------------------------------------------------------
        await client.query(
          `INSERT INTO snapshots (tag_id, ts, value, quality)
           SELECT * FROM UNNEST($1::int[], $2::timestamptz[], $3::float8[], $4::smallint[])
           ON CONFLICT (tag_id) DO UPDATE 
           SET ts = EXCLUDED.ts, value = EXCLUDED.value, quality = EXCLUDED.quality`,
          [snapshotTagIds, snapshotTimes, snapshotVals, snapshotQualities]
        );

        secondsSinceLastArchive += 1;
        if (secondsSinceLastArchive >= ARCHIVE_INTERVAL_SEC && archiveBuffer.length > 0) {
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

        // -------------------------------------------------------------
        // D. DISPATCH DUE OUTBOUND MONITORING JOBS
        // -------------------------------------------------------------
        outboxCheckCounter++;
        if (outboxCheckCounter >= 5) {
          outboxCheckCounter = 0;

          const { rows: dueJobs } = await client.query(`
            SELECT j.id, j.batch_pk, j.sequence, j.interval_sec, j.kind, j.end_at, j.max_samples,
                   b.batch_id,
                   array_agg(mjt.tag_id) as tag_ids
            FROM monitoring_jobs j
            JOIN batches b ON j.batch_pk = b.id
            JOIN monitoring_job_tags mjt ON j.id = mjt.job_id
            WHERE j.state = 'active' AND j.next_fire_at <= $1
            GROUP BY j.id, b.batch_id
          `, [now]);

          for (const job of dueJobs) {
            const nextSeq = job.sequence + 1;

            const { rows: sRows } = await client.query(`
              SELECT t.name, s.value, s.quality, s.ts
              FROM snapshots s
              JOIN tags t ON s.tag_id = t.id
              WHERE s.tag_id = ANY($1::int[])
            `, [job.tag_ids]);

            const payload = {
              jobId: job.id,
              batchId: job.batch_id,
              sequence: nextSeq,
              scheduledAt: now.toISOString(),
              sampledAt: now.toISOString(),
              samples: sRows.map(r => ({ tag: r.name, value: r.value, quality: r.quality }))
            };

            await client.query(`
              INSERT INTO monitoring_outbox (job_id, sequence, scheduled_at, sampled_at, payload)
              VALUES ($1, $2, $3, $4, $5)
            `, [job.id, nextSeq, now, now, JSON.stringify(payload)]);

            const isExpired = (job.kind === 'fixed' && job.end_at && now >= new Date(job.end_at)) ||
                              (job.max_samples && nextSeq >= job.max_samples);

            const nextState = isExpired ? 'completed' : 'active';
            await client.query(`
              UPDATE monitoring_jobs
              SET sequence = $1,
                  state = $2,
                  next_fire_at = next_fire_at + ($3 * INTERVAL '1 second'),
                  completed_at = CASE WHEN $2 = 'completed' THEN $4 ELSE completed_at END
              WHERE id = $5
            `, [nextSeq, nextState, job.interval_sec, now, job.id]);
          }
        }

      } catch (loopErr) {
        console.error('Error in simulation tick:', loopErr);
      }

      expectedNextTick += 1000;
      const drift = expectedNextTick - Date.now();
      setTimeout(tick, Math.max(0, drift));
    };

    tick();

  } catch (err) {
    console.error('Engine failed to start:', err);
    client.release();
    process.exit(1);
  }
}

const shutdown = () => {
  console.log('\nStopping simulation engine gracefully...');
  pool.end().then(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startEngine();