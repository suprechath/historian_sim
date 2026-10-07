import { query } from '../db.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

export class ChaosService {
  constructor(prng, tags) {
    this.prng = prng;
    this.tags = tags;
    this.enabled = config.chaos.enabled;
    this.minIntervalSec = config.chaos.minIntervalSec;
    this.maxIntervalSec = config.chaos.maxIntervalSec;
    this.minDurationSec = config.chaos.minDurationSec;
    this.maxDurationSec = config.chaos.maxDurationSec;
    this.maxActive = config.chaos.maxActive;

    this.activeChaosFaults = new Map();
    this.nextChaosTime = Date.now() + this.prng.rangeInt(60, 180) * 1000;
  }

  /**
   * Reset stale un-cleared faults on startup for deterministic initial state.
   */
  async initialize() {
    try {
      await query('UPDATE injected_faults SET cleared_at = NOW() WHERE cleared_at IS NULL');
      logger.info('Stale injected faults cleared.', 'ChaosService');
    } catch (err) {
      logger.debug(`Could not clear stale faults: ${err.message}`, 'ChaosService');
    }
  }

  /**
   * Query all currently active injected faults.
   */
  async getActiveFaultMap() {
    try {
      const { rows: faults } = await query(
        'SELECT tag_id, kind, magnitude FROM injected_faults WHERE cleared_at IS NULL'
      );
      const activeMap = new Map();
      faults.forEach((f) => activeMap.set(f.tag_id, f));
      return activeMap;
    } catch (err) {
      logger.error(`Error querying active faults: ${err.message}`, 'ChaosService');
      return new Map();
    }
  }

  /**
   * Run autonomous chaos cycle if enabled.
   */
  async tick(now, simRunning) {
    if (!this.enabled || !simRunning) return;

    // 1. Clear expired autonomous faults
    for (const [faultId, faultInfo] of this.activeChaosFaults.entries()) {
      if (now.getTime() >= faultInfo.clearTime) {
        try {
          await query(
            'UPDATE injected_faults SET cleared_at = $1 WHERE id = $2 AND cleared_at IS NULL',
            [now, faultId]
          );
          this.activeChaosFaults.delete(faultId);
          logger.info(`Cleared autonomous fault #${faultId}: ${faultInfo.kind} on ${faultInfo.tagName}`, 'ChaosService');
        } catch (err) {
          logger.error(`Error clearing autonomous fault #${faultId}: ${err.message}`, 'ChaosService');
        }
      }
    }

    // 2. Schedule new fault if due
    if (now.getTime() >= this.nextChaosTime && this.activeChaosFaults.size < this.maxActive) {
      this.nextChaosTime = now.getTime() + this.prng.rangeInt(this.minIntervalSec, this.maxIntervalSec) * 1000;
      
      const candidateTags = this.tags.filter(
        (t) => t.point_type === 'float' || t.point_type === 'float_calculated'
      );

      if (candidateTags.length > 0) {
        const selectedTag = candidateTags[this.prng.rangeInt(0, candidateTags.length - 1)];
        const kinds = ['dropout', 'spike', 'drift', 'stuck', 'quality'];
        const selectedKind = kinds[this.prng.rangeInt(0, kinds.length - 1)];

        let magnitude = null;
        if (selectedKind === 'spike') magnitude = this.prng.range(5.0, 15.0);
        else if (selectedKind === 'drift') magnitude = (this.prng.next() > 0.5 ? 1 : -1) * this.prng.range(2.0, 5.0);
        else if (selectedKind === 'stuck') magnitude = 50.0;
        else if (selectedKind === 'quality') magnitude = 1.0;

        const durationSec = this.prng.rangeInt(this.minDurationSec, this.maxDurationSec);
        const clearTime = now.getTime() + durationSec * 1000;
        const cleanMagnitude = magnitude !== null ? parseFloat(magnitude.toFixed(2)) : null;

        try {
          const { rows: inserted } = await query(
            'INSERT INTO injected_faults (tag_id, kind, magnitude, started_at) VALUES ($1, $2, $3, $4) RETURNING id',
            [selectedTag.id, selectedKind, cleanMagnitude, now]
          );
          const faultId = inserted[0].id;
          this.activeChaosFaults.set(faultId, {
            id: faultId,
            tagId: selectedTag.id,
            tagName: selectedTag.name,
            kind: selectedKind,
            magnitude: cleanMagnitude,
            clearTime,
          });
          logger.info(`Injected autonomous fault #${faultId}: ${selectedKind} on ${selectedTag.name} (${durationSec}s)`, 'ChaosService');
        } catch (err) {
          logger.error(`Failed to inject autonomous fault: ${err.message}`, 'ChaosService');
        }
      }
    }
  }
}
