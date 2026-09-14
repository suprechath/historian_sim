// simulator/src/index.js
import { pool } from './db.js';
import { PRNG } from './prng.js';
import { ReactorSimulation } from './stateMachine.js';

const ARCHIVE_INTERVAL_SEC = 5;
const prng = new PRNG(Date.now());

async function startEngine() {
  const client = await pool.connect();

  try {
    console.log('--- Initializing Continuous Simulation Engine (PRD v0.2) ---');

    // 1. Fetch Assets and Tags
    const { rows: assets } = await client.query('SELECT id, code, display_name, capacity_l, role, material FROM assets ORDER BY id');
    const { rows: tags } = await client.query(`
      SELECT id, name, asset_id, parameter, point_type, range_min, range_max, 
             alarm_low, alarm_high, alarm_state_int, is_cpp 
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
      "SELECT batch_id FROM batches WHERE batch_id LIKE 'B-2026-%' ORDER BY id DESC LIMIT 1"
    );
    let batchSeq = 1;
    if (maxBatch.length > 0) {
      const parts = maxBatch[0].batch_id.split('-');
      if (parts.length === 3) batchSeq = parseInt(parts[2], 10) + 1;
    }

    // Active alarms tracking map: `${tagId}` -> eventId
    const activeAlarms = new Map();

    // Previous integer states map: `${tagId}` -> lastValue
    const lastIntegerStates = new Map();

    // Archive write buffer for 5-second float samples and change-of-state integer samples
    let archiveBuffer = [];
    let secondsSinceLastArchive = 0;

    // Outbox & Monitoring check counter
    let outboxCheckCounter = 0;

    // -------------------------------------------------------------
    // Autonomous Chaos Engine Configuration & Tracking
    // -------------------------------------------------------------
    const CHAOS_ENABLED = process.env.CHAOS_ENABLED !== 'false';
    const CHAOS_MIN_INTERVAL_SEC = parseInt(process.env.CHAOS_MIN_INTERVAL_SEC || '45', 10);
    const CHAOS_MAX_INTERVAL_SEC = parseInt(process.env.CHAOS_MAX_INTERVAL_SEC || '180', 10);
    const CHAOS_MIN_DURATION_SEC = parseInt(process.env.CHAOS_MIN_DURATION_SEC || '20', 10);
    const CHAOS_MAX_DURATION_SEC = parseInt(process.env.CHAOS_MAX_DURATION_SEC || '60', 10);
    const CHAOS_MAX_ACTIVE = parseInt(process.env.CHAOS_MAX_ACTIVE || '2', 10);

    // Schedule initial chaos injection 15-25s after engine start
    let nextChaosTime = Date.now() + prng.rangeInt(15, 25) * 1000;
    const activeChaosFaults = new Map(); // faultId -> { id, tagId, tagName, kind, clearTime }

    if (CHAOS_ENABLED) {
      console.log(`[CHAOS ENGINE] Autonomous chaos generator initialized (Interval: ${CHAOS_MIN_INTERVAL_SEC}-${CHAOS_MAX_INTERVAL_SEC}s, Duration: ${CHAOS_MIN_DURATION_SEC}-${CHAOS_MAX_DURATION_SEC}s).`);
    }

    // Monotonic clock timer with drift compensation
    let expectedNextTick = Date.now() + 1000;

    console.log(`Simulation ready. Managing 3 reactors in train with ${tags.length} tags.`);

    const tick = async () => {
      const now = new Date();

      try {
        // 0. Poll simulation_control state
        let simRunning = true;
        let simSpeed = 1;
        let phaseSkipAsset = null;

        try {
          const { rows: ctrl } = await client.query('SELECT running, speed, phase_skip_asset FROM simulation_control WHERE id = 1');
          if (ctrl.length > 0) {
            simRunning = ctrl[0].running;
            simSpeed = ctrl[0].speed;
            phaseSkipAsset = ctrl[0].phase_skip_asset;
          }
        } catch (ctrlErr) {
          // Table may not yet be initialized
        }

        if (phaseSkipAsset) {
          await client.query('UPDATE simulation_control SET phase_skip_asset = NULL WHERE id = 1').catch(() => {});
        }

        // -------------------------------------------------------------
        // AUTONOMOUS CHAOS ENGINE: Auto-Clear & Autonomous Injection
        // -------------------------------------------------------------
        if (CHAOS_ENABLED && simRunning) {
          // 1. Auto-clear expired autonomous faults
          for (const [faultId, faultInfo] of activeChaosFaults.entries()) {
            if (now.getTime() >= faultInfo.clearTime) {
              try {
                await client.query(
                  'UPDATE injected_faults SET cleared_at = $1 WHERE id = $2 AND cleared_at IS NULL',
                  [now, faultId]
                );
                activeChaosFaults.delete(faultId);
                console.log(`[CHAOS ENGINE] Cleared fault #${faultId}: ${faultInfo.kind} on ${faultInfo.tagName} (duration elapsed)`);
              } catch (err) {
                console.error(`[CHAOS ENGINE] Error clearing fault #${faultId}:`, err.message);
              }
            }
          }

          // 2. Generate new autonomous fault if scheduled
          if (now.getTime() >= nextChaosTime && activeChaosFaults.size < CHAOS_MAX_ACTIVE) {
            nextChaosTime = now.getTime() + prng.rangeInt(CHAOS_MIN_INTERVAL_SEC, CHAOS_MAX_INTERVAL_SEC) * 1000;

            const candidateTags = tags.filter(t => t.point_type === 'float' || t.point_type === 'float_calculated');
            if (candidateTags.length > 0) {
              const selectedTag = candidateTags[prng.rangeInt(0, candidateTags.length - 1)];
              const kinds = ['dropout', 'spike', 'drift', 'stuck', 'quality', 'override'];
              const selectedKind = kinds[prng.rangeInt(0, kinds.length - 1)];

              let magnitude = null;
              switch (selectedKind) {
                case 'dropout':
                  magnitude = null;
                  break;
                case 'spike':
                  if (selectedTag.parameter.includes('TEMP')) magnitude = prng.range(25.0, 45.0);
                  else if (selectedTag.parameter.includes('PRES')) magnitude = prng.range(1.5, 2.5);
                  else if (selectedTag.parameter.includes('AGIT')) magnitude = prng.range(30.0, 60.0);
                  else if (selectedTag.parameter.includes('TURB')) magnitude = prng.range(100.0, 300.0);
                  else magnitude = prng.range(20.0, 50.0);
                  break;
                case 'drift':
                  if (selectedTag.parameter === 'PH') magnitude = (prng.next() > 0.5 ? 1 : -1) * prng.range(1.0, 2.2);
                  else if (selectedTag.parameter.includes('TEMP')) magnitude = (prng.next() > 0.5 ? 1 : -1) * prng.range(6.0, 15.0);
                  else magnitude = (prng.next() > 0.5 ? 1 : -1) * prng.range(5.0, 20.0);
                  break;
                case 'stuck':
                  if (selectedTag.range_min !== null && selectedTag.range_max !== null) {
                    magnitude = prng.range(selectedTag.range_min * 0.4 + selectedTag.range_max * 0.6, selectedTag.range_max * 0.85);
                  } else {
                    magnitude = 50.0;
                  }
                  break;
                case 'quality':
                  magnitude = prng.next() > 0.3 ? 1.0 : 2.0; // 1 = Questionable, 2 = Bad
                  break;
                case 'override':
                  if (selectedTag.alarm_high !== null) {
                    magnitude = selectedTag.alarm_high + prng.range(2.0, 8.0);
                  } else if (selectedTag.alarm_low !== null) {
                    magnitude = selectedTag.alarm_low - prng.range(2.0, 5.0);
                  } else {
                    magnitude = (selectedTag.range_max || 100) * 0.95;
                  }
                  break;
              }

              const durationSec = prng.rangeInt(CHAOS_MIN_DURATION_SEC, CHAOS_MAX_DURATION_SEC);
              const clearTime = now.getTime() + durationSec * 1000;
              const cleanMagnitude = magnitude !== null ? parseFloat(magnitude.toFixed(2)) : null;

              try {
                const { rows: inserted } = await client.query(
                  `INSERT INTO injected_faults (tag_id, kind, magnitude, started_at)
                   VALUES ($1, $2, $3, $4)
                   RETURNING id`,
                  [selectedTag.id, selectedKind, cleanMagnitude, now]
                );

                const faultId = inserted[0].id;
                activeChaosFaults.set(faultId, {
                  id: faultId,
                  tagId: selectedTag.id,
                  tagName: selectedTag.name,
                  kind: selectedKind,
                  magnitude: cleanMagnitude,
                  clearTime
                });

                console.log(`[CHAOS ENGINE] Injected autonomous fault #${faultId}: ${selectedKind} on ${selectedTag.name} (magnitude: ${cleanMagnitude ?? 'N/A'}, duration: ${durationSec}s)`);
              } catch (err) {
                console.error('[CHAOS ENGINE] Failed to inject autonomous fault:', err.message);
              }
            }
          }
        }

        // Query active injected faults
        const { rows: faults } = await client.query(
          'SELECT tag_id, kind, magnitude FROM injected_faults WHERE cleared_at IS NULL'
        );
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

        // 1. Check if R1 needs to start a new batch
        if (simRunning && !r1.activeBatch && (r1.currentPhase === 'Idle' || r1.currentPhase === 'Charging')) {
          if (r1.currentPhase === 'Idle') {
            r1.transitionNextPhase('Charging');
          }

          const year = now.getUTCFullYear();
          const batchIdStr = `B-${year}-${String(batchSeq++).padStart(4, '0')}`;

          const { rows: bRows } = await client.query(
            `INSERT INTO batches (batch_id, product_code, recipe_version, current_asset_id, started_at, status)
             VALUES ($1, 'API-7734', 'v2.1', $2, $3, 'Running') RETURNING id`,
            [batchIdStr, r1.asset.id, now]
          );
          r1.activeBatch = { id: bRows[0].id, batch_id: batchIdStr, started_at: now };

          // Open Unit Procedure event for R1
          const { rows: upRows } = await client.query(
            `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
             VALUES ($1, $2, 'Unit procedure R1 — Synthesis', 'Unit Procedure', $3) RETURNING id`,
            [r1.activeBatch.id, r1.asset.id, now]
          );
          r1.activeUnitProcedureId = upRows[0].id;

          // Open Phase event for Charging
          const { rows: pRows } = await client.query(
            `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
             VALUES ($1, $2, $3, 'Charging', 'Phase', $4, $5) RETURNING id`,
            [r1.activeBatch.id, r1.asset.id, r1.activeUnitProcedureId, r1.phaseOccurrence, now]
          );
          r1.activePhaseEventId = pRows[0].id;
          console.log(`[Batch Train] Started Batch ${batchIdStr} in R1 (Charging)`);
        }

        // 2. Advance simulation ticks for R1, R2, R3
        const deltaSec = simRunning ? simSpeed : 0;
        for (const sim of reactors) {
          const forcePhaseFinish = Boolean(phaseSkipAsset && sim.code === phaseSkipAsset);
          const phaseFinished = (simRunning && sim.tick(deltaSec)) || forcePhaseFinish;

          // If phase just started without an open event, open it
          if (sim.activeBatch && sim.activeUnitProcedureId && !sim.activePhaseEventId && sim.currentPhase !== 'Idle') {
            const { rows: pRows } = await client.query(
              `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
               VALUES ($1, $2, $3, $4, 'Phase', $5, $6) RETURNING id`,
              [sim.activeBatch.id, sim.asset.id, sim.activeUnitProcedureId, sim.currentPhase, sim.phaseOccurrence, now]
            );
            sim.activePhaseEventId = pRows[0].id;
          }

          // Handle phase completion
          if (phaseFinished) {
            // Close active phase event
            if (sim.activePhaseEventId) {
              await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, sim.activePhaseEventId]);
              sim.activePhaseEventId = null;
            }

            // Phase specific transition & handoffs
            if (sim.code === 'R1' && sim.currentPhase === 'Transfer') {
              // R1 finished Transfer -> Hand off to R2 Receive
              if (sim.activeUnitProcedureId) {
                await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, sim.activeUnitProcedureId]);
                sim.activeUnitProcedureId = null;
              }

              const transferredBatch = sim.activeBatch;
              sim.activeBatch = null;

              // Transition R1 to Clean
              sim.transitionNextPhase('Clean');

              // If R2 is idle or ready, hand off batch to R2
              if (transferredBatch && r2) {
                r2.activeBatch = transferredBatch;
                await client.query(
                  'UPDATE batches SET current_asset_id = $1 WHERE id = $2',
                  [r2.asset.id, transferredBatch.id]
                );

                // Open Unit Procedure event for R2
                const { rows: up2Rows } = await client.query(
                  `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
                   VALUES ($1, $2, 'Unit procedure R2 — Workup', 'Unit Procedure', $3) RETURNING id`,
                  [transferredBatch.id, r2.asset.id, now]
                );
                r2.activeUnitProcedureId = up2Rows[0].id;

                // Move R2 to Receive
                r2.transitionNextPhase('Receive');

                const { rows: p2Rows } = await client.query(
                  `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
                   VALUES ($1, $2, $3, 'Receive', 'Phase', $4, $5) RETURNING id`,
                  [transferredBatch.id, r2.asset.id, r2.activeUnitProcedureId, r2.phaseOccurrence, now]
                );
                r2.activePhaseEventId = p2Rows[0].id;
                console.log(`[Batch Train] Batch ${transferredBatch.batch_id} handed off from R1 to R2 (Receive)`);
              }

            } else if (sim.code === 'R2' && sim.currentPhase === 'Transfer') {
              // R2 finished Transfer -> Hand off to R3 Receive
              if (sim.activeUnitProcedureId) {
                await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, sim.activeUnitProcedureId]);
                sim.activeUnitProcedureId = null;
              }

              const transferredBatch = sim.activeBatch;
              sim.activeBatch = null;

              // Transition R2 to Clean
              sim.transitionNextPhase('Clean');

              // If R3 is ready, hand off batch to R3
              if (transferredBatch && r3) {
                r3.activeBatch = transferredBatch;
                await client.query(
                  'UPDATE batches SET current_asset_id = $1 WHERE id = $2',
                  [r3.asset.id, transferredBatch.id]
                );

                // Open Unit Procedure event for R3
                const { rows: up3Rows } = await client.query(
                  `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
                   VALUES ($1, $2, 'Unit procedure R3 — Crystallisation', 'Unit Procedure', $3) RETURNING id`,
                  [transferredBatch.id, r3.asset.id, now]
                );
                r3.activeUnitProcedureId = up3Rows[0].id;

                // Move R3 to Receive
                r3.transitionNextPhase('Receive');

                const { rows: p3Rows } = await client.query(
                  `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
                   VALUES ($1, $2, $3, 'Receive', 'Phase', $4, $5) RETURNING id`,
                  [transferredBatch.id, r3.asset.id, r3.activeUnitProcedureId, r3.phaseOccurrence, now]
                );
                r3.activePhaseEventId = p3Rows[0].id;
                console.log(`[Batch Train] Batch ${transferredBatch.batch_id} handed off from R2 to R3 (Receive)`);
              }

            } else if (sim.code === 'R3' && sim.currentPhase === 'Transfer') {
              // R3 finished Transfer -> Complete Batch!
              if (sim.activeUnitProcedureId) {
                await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, sim.activeUnitProcedureId]);
                sim.activeUnitProcedureId = null;
              }

              if (sim.activeBatch) {
                await client.query(
                  "UPDATE batches SET ended_at = $1, status = 'Completed', current_asset_id = NULL WHERE id = $2",
                  [now, sim.activeBatch.id]
                );
                console.log(`[Batch Train] Batch ${sim.activeBatch.batch_id} Completed successfully!`);
                sim.activeBatch = null;
              }

              sim.transitionNextPhase('Clean');

            } else {
              // Standard in-reactor phase progression
              sim.transitionNextPhase();
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
                  quality = 1; // Questionable
                  break;
                case 'drift':
                  val += (fault.magnitude ?? 5.0);
                  quality = 1;
                  break;
                case 'dropout':
                  val = null;
                  quality = 2; // Bad
                  break;
                case 'spike':
                  val += (fault.magnitude ?? 40.0);
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

            // Check Process Alarms
            let isAlarmActive = false;
            let alarmMsg = '';

            if (val !== null && quality === 0) {
              if (tag.alarm_high !== null && val > tag.alarm_high) {
                isAlarmActive = true;
                alarmMsg = `${tag.name} High Alarm (${val.toFixed(tag.display_digits)} > ${tag.alarm_high})`;
              } else if (tag.alarm_low !== null && val < tag.alarm_low) {
                isAlarmActive = true;
                alarmMsg = `${tag.name} Low Alarm (${val.toFixed(tag.display_digits)} < ${tag.alarm_low})`;
              } else if (tag.alarm_state_int !== null && Math.round(val) === tag.alarm_state_int) {
                isAlarmActive = true;
                alarmMsg = `${tag.name} State Alarm (State = ${tag.alarm_state_int})`;
              }
            }

            const alarmKey = `${tag.id}`;
            if (isAlarmActive && !activeAlarms.has(alarmKey)) {
              // Open new Alarm Event
              try {
                const { rows: aRows } = await client.query(
                  `INSERT INTO events (batch_pk, asset_id, parent_id, tag_id, name, level, started_at, details)
                   VALUES ($1, $2, $3, $4, $5, 'Alarm', $6, $7) RETURNING id`,
                  [sim.activeBatch ? sim.activeBatch.id : null, sim.asset.id, sim.activePhaseEventId, tag.id, alarmMsg, now, JSON.stringify({ val })]
                );
                activeAlarms.set(alarmKey, aRows[0].id);
                console.log(`[ALARM TRIGGERED] ${alarmMsg}`);
              } catch (e) {
                console.error('Error logging alarm event:', e.message);
              }
            } else if (!isAlarmActive && activeAlarms.has(alarmKey)) {
              // Clear active alarm event
              const eventId = activeAlarms.get(alarmKey);
              activeAlarms.delete(alarmKey);
              try {
                await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, eventId]);
                console.log(`[ALARM CLEARED] ${tag.name} returned to normal.`);
              } catch (e) {
                console.error('Error clearing alarm event:', e.message);
              }
            }

            // Archiving:
            const isInteger = tag.point_type === 'integer';
            const recordVal = isInteger ? (val !== null ? Math.round(val) : null) : val;

            if (isInteger) {
              const lastVal = lastIntegerStates.get(tag.id);
              if (lastVal === undefined || lastVal !== recordVal) {
                lastIntegerStates.set(tag.id, recordVal);

                // Log state change event if under active batch
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

            // Continuously archive all tags (floats and integers) into archive buffer
            archiveBuffer.push({ tagId: tag.id, ts: now.toISOString(), val: recordVal, quality });
          }
        }

        // -------------------------------------------------------------
        // C. WRITE LIVE SNAPSHOTS & PERIODIC ARCHIVE HYPERTABLE
        // -------------------------------------------------------------

        // 1. Live Snapshots update (every 1 second)
        await client.query(
          `INSERT INTO snapshots (tag_id, ts, value, quality)
           SELECT * FROM UNNEST($1::int[], $2::timestamptz[], $3::float8[], $4::smallint[])
           ON CONFLICT (tag_id) DO UPDATE 
           SET ts = EXCLUDED.ts, value = EXCLUDED.value, quality = EXCLUDED.quality`,
          [snapshotTagIds, snapshotTimes, snapshotVals, snapshotQualities]
        );

        // 2. Persist to readings hypertable every 5 seconds
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

            // Fetch current snapshots for the subscribed tags
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

            // Check if job expired or hit safety limits
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

      // Drift-compensated 1-second scheduling
      expectedNextTick += 1000;
      const drift = expectedNextTick - Date.now();
      setTimeout(tick, Math.max(0, drift));
    };

    // Begin simulation loop
    tick();

  } catch (err) {
    console.error('Engine failed to start:', err);
    client.release();
    process.exit(1);
  }
}

// Graceful termination
const shutdown = () => {
  console.log('\nStopping simulation engine gracefully...');
  pool.end().then(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startEngine();