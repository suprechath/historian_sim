import { query, withTransaction } from '../db.js';
import { logger } from '../logger.js';

export class BatchOrchestrator {
  constructor(reactors, prng) {
    this.reactors = reactors;
    this.r1 = reactors.find((r) => r.code === 'R1');
    this.r2 = reactors.find((r) => r.code === 'R2');
    this.r3 = reactors.find((r) => r.code === 'R3');
    this.prng = prng;
    this.trainBatch = null;
    this.batchSeq = 1;
  }

  /**
   * Initialize batch sequence counter and recover in-flight batch from crash.
   */
  async initialize() {
    // 1. Fetch latest batch sequence
    const { rows: maxBatch } = await query(
      'SELECT batch_id FROM batches ORDER BY id DESC LIMIT 1'
    );
    if (maxBatch.length > 0) {
      const parts = maxBatch[0].batch_id.split('-');
      if (parts.length === 3) {
        this.batchSeq = parseInt(parts[2], 10) + 1;
      }
    }

    // 2. Crash Recovery & Rehydration
    try {
      const { rows: activeBatches } = await query(
        "SELECT id, batch_id, current_asset_id, started_at FROM batches WHERE status = 'Running' ORDER BY started_at DESC"
      );

      if (activeBatches.length > 0) {
        this.trainBatch = activeBatches[0];

        // Clean up any extraneous running batches
        if (activeBatches.length > 1) {
          const olderIds = activeBatches.slice(1).map((b) => b.id);
          await query(
            "UPDATE batches SET status = 'Completed', ended_at = NOW(), current_asset_id = NULL WHERE id = ANY($1::int[])",
            [olderIds]
          );
        }

        // Rehydrate the active reactor holding the batch
        for (const sim of this.reactors) {
          if (sim.asset.id === this.trainBatch.current_asset_id) {
            sim.activeBatch = this.trainBatch;

            const { rows: upEv } = await query(
              "SELECT id FROM events WHERE batch_pk = $1 AND asset_id = $2 AND level = 'Unit Procedure' AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
              [this.trainBatch.id, sim.asset.id]
            );
            if (upEv.length > 0) sim.activeUnitProcedureId = upEv[0].id;

            const { rows: phEv } = await query(
              "SELECT id, name, occurrence FROM events WHERE asset_id = $1 AND level = 'Phase' AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
              [sim.asset.id]
            );
            if (phEv.length > 0) {
              sim.activePhaseEventId = phEv[0].id;
              sim.currentPhase = phEv[0].name;
              sim.phaseOccurrence = phEv[0].occurrence || 1;
            }
            logger.info(
              `Restored in-flight batch ${this.trainBatch.batch_id} in ${sim.code} (Phase: ${sim.currentPhase})`,
              'BatchOrchestrator'
            );
          } else {
            // Check if this vessel has an active Clean phase event
            const { rows: cleanEv } = await query(
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
        this.reactors.forEach((r) => {
          r.currentPhase = 'Idle';
          r.activeBatch = null;
        });
      }

      // Close dangling phase/UP events from previous orphaned sessions
      const activeEvIds = this.reactors
        .flatMap((r) => [r.activePhaseEventId, r.activeUnitProcedureId])
        .filter(Boolean);
      if (activeEvIds.length > 0) {
        await query(
          'UPDATE events SET ended_at = NOW() WHERE ended_at IS NULL AND id != ALL($1::int[])',
          [activeEvIds]
        );
      }
    } catch (err) {
      logger.warn(`Startup batch recovery warning: ${err.message}`, 'BatchOrchestrator');
    }
  }

  async openPhaseEvent(sim, phaseName, batchPk, parentId = null, now = new Date()) {
    const { rows } = await query(
      `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
       VALUES ($1, $2, $3, $4, 'Phase', $5, $6) RETURNING id`,
      [batchPk || null, sim.asset.id, parentId || null, phaseName, sim.phaseOccurrence || 1, now]
    );
    sim.activePhaseEventId = rows[0].id;
  }

  async closeEvent(eventId, now = new Date()) {
    if (!eventId) return;
    await query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, eventId]);
  }

  /**
   * Handle user-initiated batch command.
   */
  async handleUserBatchCommand(assignedBatchId, now, controlService) {
    await withTransaction(async (client) => {
      // Displace all active events & batches across all vessels
      for (const vessel of this.reactors) {
        if (vessel.activePhaseEventId) {
          await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, vessel.activePhaseEventId]);
          vessel.activePhaseEventId = null;
        }
        if (vessel.activeUnitProcedureId) {
          await client.query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, vessel.activeUnitProcedureId]);
          vessel.activeUnitProcedureId = null;
        }
        vessel.activeBatch = null;
        vessel.transitionNextPhase('Idle');
        vessel.phaseElapsedSec = 0;
      }

      if (this.trainBatch) {
        await client.query(
          "UPDATE batches SET ended_at = $1, status = 'Aborted', current_asset_id = NULL WHERE id = $2",
          [now, this.trainBatch.id]
        );
        logger.info(
          `Displaced active batch ${this.trainBatch.batch_id} for user command batch`,
          'BatchOrchestrator'
        );
        this.trainBatch = null;
      }

      let batchIdStr = (assignedBatchId || '').trim();
      if (!batchIdStr) {
        const year = now.getUTCFullYear();
        batchIdStr = `B-${year}-${String(this.batchSeq++).padStart(4, '0')}`;
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
        [batchIdStr, this.r1.asset.id, now]
      );
      this.trainBatch = { id: bRows[0].id, batch_id: batchIdStr, started_at: now };
      this.r1.activeBatch = this.trainBatch;

      // Open Unit Procedure event for R1
      const { rows: upRows } = await client.query(
        `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
         VALUES ($1, $2, 'Unit procedure R1 — Synthesis', 'Unit Procedure', $3) RETURNING id`,
        [this.trainBatch.id, this.r1.asset.id, now]
      );
      this.r1.activeUnitProcedureId = upRows[0].id;

      // Transition R1 to Charging
      this.r1.transitionNextPhase('Charging');
      const { rows: phRows } = await client.query(
        `INSERT INTO events (batch_pk, asset_id, parent_id, name, level, occurrence, started_at)
         VALUES ($1, $2, $3, 'Charging', 'Phase', $4, $5) RETURNING id`,
        [this.trainBatch.id, this.r1.asset.id, this.r1.activeUnitProcedureId, this.r1.phaseOccurrence || 1, now]
      );
      this.r1.activePhaseEventId = phRows[0].id;

      await controlService.ackBatchCommand(batchIdStr);
      logger.info(`Started user-assigned batch ${batchIdStr} in R1 (Charging)`, 'BatchOrchestrator');
    });
  }

  /**
   * Advance batch lifecycle during continuous simulation.
   */
  async tick(simMode, simRunning, simSpeed, phaseSkipAsset, now, controlService) {
    // 1. In continuous mode, start new batch if train is completely empty and R1 is Idle
    if (simMode === 'continuous' && simRunning && !this.trainBatch && this.r1.currentPhase === 'Idle') {
      const year = now.getUTCFullYear();
      let bRows = [];
      let batchIdStr = '';
      while (bRows.length === 0) {
        batchIdStr = `B-${year}-${String(this.batchSeq++).padStart(4, '0')}`;
        const res = await query(
          `INSERT INTO batches (batch_id, product_code, recipe_version, current_asset_id, started_at, status)
           VALUES ($1, 'API-7734', 'v2.1', $2, $3, 'Running')
           ON CONFLICT (batch_id) DO NOTHING RETURNING id`,
          [batchIdStr, this.r1.asset.id, now]
        );
        bRows = res.rows;
      }
      this.trainBatch = { id: bRows[0].id, batch_id: batchIdStr, started_at: now };
      this.r1.activeBatch = this.trainBatch;

      // Open Unit Procedure event for R1
      const { rows: upRows } = await query(
        `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
         VALUES ($1, $2, 'Unit procedure R1 — Synthesis', 'Unit Procedure', $3) RETURNING id`,
        [this.trainBatch.id, this.r1.asset.id, now]
      );
      this.r1.activeUnitProcedureId = upRows[0].id;

      // Transition R1 into Charging
      this.r1.transitionNextPhase('Charging');
      await this.openPhaseEvent(this.r1, 'Charging', this.trainBatch.id, this.r1.activeUnitProcedureId, now);
      logger.info(`Started Batch ${batchIdStr} in R1 (Charging)`, 'BatchOrchestrator');
    }

    // 2. Advance simulation ticks for R1, R2, R3
    const deltaSec = simRunning ? simSpeed : 0;
    for (const sim of this.reactors) {
      const forcePhaseFinish = Boolean(phaseSkipAsset && sim.code === phaseSkipAsset);
      const phaseFinished = (simRunning && sim.tick(deltaSec)) || forcePhaseFinish;

      if (phaseFinished) {
        if (sim.activePhaseEventId) {
          await this.closeEvent(sim.activePhaseEventId, now);
          sim.activePhaseEventId = null;
        }

        await this._handlePhaseTransition(sim, now, simMode, controlService);
      }
    }
  }

  async _handlePhaseTransition(sim, now, simMode, controlService) {
    if (sim.code === 'R1') {
      switch (sim.currentPhase) {
        case 'Charging':
          sim.transitionNextPhase('Heating');
          await this.openPhaseEvent(sim, 'Heating', this.trainBatch?.id, sim.activeUnitProcedureId, now);
          break;
        case 'Heating':
          sim.transitionNextPhase('Distillation');
          await this.openPhaseEvent(sim, 'Distillation', this.trainBatch?.id, sim.activeUnitProcedureId, now);
          break;
        case 'Distillation':
          sim.transitionNextPhase('Reaction hold');
          await this.openPhaseEvent(sim, 'Reaction hold', this.trainBatch?.id, sim.activeUnitProcedureId, now);
          break;
        case 'Reaction hold':
          sim.transitionNextPhase('Cooling');
          await this.openPhaseEvent(sim, 'Cooling', this.trainBatch?.id, sim.activeUnitProcedureId, now);
          break;
        case 'Cooling':
          // Synchronized Handoff to R2
          const r1TransferDur = this.prng.rangeInt(900, 1500); // 15-25 min
          sim.transitionNextPhase('Transfer');
          sim.phaseDurationSec = r1TransferDur;
          await this.openPhaseEvent(sim, 'Transfer', this.trainBatch?.id, sim.activeUnitProcedureId, now);

          // R2 enters Receive at the exact same moment
          this.r2.activeBatch = this.trainBatch;
          this.r2.transitionNextPhase('Receive');
          this.r2.phaseDurationSec = r1TransferDur;
          await this.openPhaseEvent(this.r2, 'Receive', this.trainBatch?.id, null, now);
          logger.info(`Batch ${this.trainBatch?.batch_id} transferring R1 -> R2 (Receive)`, 'BatchOrchestrator');
          break;
        case 'Transfer':
          if (sim.activeUnitProcedureId) {
            await this.closeEvent(sim.activeUnitProcedureId, now);
            sim.activeUnitProcedureId = null;
          }
          sim.activeBatch = null;
          sim.transitionNextPhase('Clean');
          await this.openPhaseEvent(sim, 'Clean', null, null, now);
          break;
        case 'Clean':
          sim.transitionNextPhase('Idle');
          break;
      }
    } else if (sim.code === 'R2') {
      switch (sim.currentPhase) {
        case 'Receive':
          if (this.trainBatch) {
            await query('UPDATE batches SET current_asset_id = $1 WHERE id = $2', [this.r2.asset.id, this.trainBatch.id]);
            const { rows: up2Rows } = await query(
              `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
               VALUES ($1, $2, 'Unit procedure R2 — Workup', 'Unit Procedure', $3) RETURNING id`,
              [this.trainBatch.id, this.r2.asset.id, now]
            );
            this.r2.activeUnitProcedureId = up2Rows[0].id;
          }
          sim.transitionNextPhase('pH adjust');
          await this.openPhaseEvent(sim, 'pH adjust', this.trainBatch?.id, sim.activeUnitProcedureId, now);
          break;
        case 'pH adjust':
          sim.transitionNextPhase('Settle & separate');
          await this.openPhaseEvent(sim, 'Settle & separate', this.trainBatch?.id, sim.activeUnitProcedureId, now);
          break;
        case 'Settle & separate':
          sim.transitionNextPhase('Solvent swap');
          await this.openPhaseEvent(sim, 'Solvent swap', this.trainBatch?.id, sim.activeUnitProcedureId, now);
          break;
        case 'Solvent swap':
          // Synchronized Handoff to R3
          const r2TransferDur = this.prng.rangeInt(600, 1200); // 10-20 min
          sim.transitionNextPhase('Filter & transfer');
          sim.phaseDurationSec = r2TransferDur;
          await this.openPhaseEvent(sim, 'Filter & transfer', this.trainBatch?.id, sim.activeUnitProcedureId, now);

          // R3 enters Receive at the exact same moment
          this.r3.activeBatch = this.trainBatch;
          this.r3.transitionNextPhase('Receive');
          this.r3.phaseDurationSec = r2TransferDur;
          await this.openPhaseEvent(this.r3, 'Receive', this.trainBatch?.id, null, now);
          logger.info(`Batch ${this.trainBatch?.batch_id} transferring R2 -> R3 (Receive)`, 'BatchOrchestrator');
          break;
        case 'Filter & transfer':
        case 'Transfer':
          if (sim.activeUnitProcedureId) {
            await this.closeEvent(sim.activeUnitProcedureId, now);
            sim.activeUnitProcedureId = null;
          }
          sim.activeBatch = null;
          sim.transitionNextPhase('Clean');
          await this.openPhaseEvent(sim, 'Clean', null, null, now);
          break;
        case 'Clean':
          sim.transitionNextPhase('Idle');
          break;
      }
    } else if (sim.code === 'R3') {
      switch (sim.currentPhase) {
        case 'Receive':
          if (this.trainBatch) {
            await query('UPDATE batches SET current_asset_id = $1 WHERE id = $2', [this.r3.asset.id, this.trainBatch.id]);
            const { rows: up3Rows } = await query(
              `INSERT INTO events (batch_pk, asset_id, name, level, started_at)
               VALUES ($1, $2, 'Unit procedure R3 — Crystallisation', 'Unit Procedure', $3) RETURNING id`,
              [this.trainBatch.id, this.r3.asset.id, now]
            );
            this.r3.activeUnitProcedureId = up3Rows[0].id;
          }
          sim.transitionNextPhase('Heat to dissolve');
          await this.openPhaseEvent(sim, 'Heat to dissolve', this.trainBatch?.id, sim.activeUnitProcedureId, now);
          break;
        case 'Heat to dissolve':
          sim.transitionNextPhase('Cooling ramp');
          await this.openPhaseEvent(sim, 'Cooling ramp', this.trainBatch?.id, sim.activeUnitProcedureId, now);
          break;
        case 'Cooling ramp':
          sim.transitionNextPhase('Age');
          await this.openPhaseEvent(sim, 'Age', this.trainBatch?.id, sim.activeUnitProcedureId, now);
          break;
        case 'Age':
          sim.transitionNextPhase('Transfer');
          await this.openPhaseEvent(sim, 'Transfer', this.trainBatch?.id, sim.activeUnitProcedureId, now);
          break;
        case 'Transfer':
          if (sim.activeUnitProcedureId) {
            await this.closeEvent(sim.activeUnitProcedureId, now);
            sim.activeUnitProcedureId = null;
          }
          if (this.trainBatch) {
            const finishedId = this.trainBatch.batch_id;
            await query(
              "UPDATE batches SET ended_at = $1, status = 'Completed', current_asset_id = NULL WHERE id = $2",
              [now, this.trainBatch.id]
            );
            logger.info(`Batch ${finishedId} Completed successfully!`, 'BatchOrchestrator');
            this.trainBatch = null;

            if (simMode === 'single') {
              await controlService.updateSingleBatchStatus('completed');
            }
          }
          sim.activeBatch = null;
          sim.transitionNextPhase('Clean');
          await this.openPhaseEvent(sim, 'Clean', null, null, now);
          break;
        case 'Clean':
          sim.transitionNextPhase('Idle');
          break;
      }
    }
  }

  getActiveTrainBatch() {
    return this.trainBatch;
  }
}
