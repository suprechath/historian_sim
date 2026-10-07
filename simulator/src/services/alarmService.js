import { query } from '../db.js';
import { logger } from '../logger.js';

export class AlarmService {
  constructor() {
    this.activeAlarms = new Map();       // tagId -> { id, msg }
    this.activeExceptions = new Map();   // tagId -> { id, batchPk, type, limitVal, peakVal, startedAt }
    this.lastIntegerStates = new Map();  // tagId -> lastVal
  }

  /**
   * Evaluate tag value against alarms, batch exceptions, and integer state transitions.
   */
  async evaluateTag(sim, tag, val, quality, now) {
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
    await this._handleAlarmEvent(alarmKey, isAlarmActive, alarmMsg, sim, tag, val, now);
    await this._handleBatchException(alarmKey, exceptionType, limitValue, sim, tag, val, now);
    await this._handleIntegerStateChange(sim, tag, val, now);
  }

  async _handleAlarmEvent(key, isAlarmActive, alarmMsg, sim, tag, val, now) {
    const existing = this.activeAlarms.get(key);

    if (isAlarmActive) {
      if (!existing) {
        try {
          const { rows } = await query(
            `INSERT INTO events (batch_pk, asset_id, parent_id, tag_id, name, level, started_at, details)
             VALUES ($1, $2, $3, $4, $5, 'Alarm', $6, $7) RETURNING id`,
            [
              sim.activeBatch ? sim.activeBatch.id : null,
              sim.asset.id,
              sim.activePhaseEventId,
              tag.id,
              alarmMsg,
              now,
              JSON.stringify({ val }),
            ]
          );
          this.activeAlarms.set(key, { id: rows[0].id, msg: alarmMsg });
          logger.warn(`ALARM TRIGGERED: ${alarmMsg}`, 'AlarmService');
        } catch (err) {
          logger.error(`Error logging alarm event: ${err.message}`, 'AlarmService');
        }
      }
    } else if (existing) {
      this.activeAlarms.delete(key);
      try {
        await query('UPDATE events SET ended_at = $1 WHERE id = $2', [now, existing.id]);
        logger.info(`ALARM CLEARED: ${tag.name} returned to normal.`, 'AlarmService');
      } catch (err) {
        logger.error(`Error clearing alarm event: ${err.message}`, 'AlarmService');
      }
    }
  }

  async _handleBatchException(key, exceptionType, limitValue, sim, tag, val, now) {
    const existingEx = this.activeExceptions.get(key);

    if (exceptionType && sim.activeBatch && val !== null) {
      if (!existingEx) {
        try {
          const { rows: exRows } = await query(
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
              JSON.stringify({
                initial_val: val,
                phase: sim.currentPhase,
                occurrence: sim.phaseOccurrence || 1,
              }),
            ]
          );
          this.activeExceptions.set(key, {
            id: exRows[0].id,
            batchPk: sim.activeBatch.id,
            type: exceptionType,
            limitVal: limitValue,
            peakVal: val,
            startedAt: now,
          });
        } catch (err) {
          logger.error(`Error logging batch exception: ${err.message}`, 'AlarmService');
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
            await query('UPDATE batch_exceptions SET peak_value = $1 WHERE id = $2', [
              existingEx.peakVal,
              existingEx.id,
            ]);
          } catch (err) {
            logger.error(`Error updating batch exception peak: ${err.message}`, 'AlarmService');
          }
        }
      }
    } else if (existingEx) {
      this.activeExceptions.delete(key);
      const durationSec = Math.max(
        1,
        Math.round((now.getTime() - new Date(existingEx.startedAt).getTime()) / 1000)
      );
      try {
        await query(
          'UPDATE batch_exceptions SET ended_at = $1, duration_sec = $2, peak_value = $3 WHERE id = $4',
          [now, durationSec, existingEx.peakVal, existingEx.id]
        );
      } catch (err) {
        logger.error(`Error closing batch exception: ${err.message}`, 'AlarmService');
      }
    }
  }

  async _handleIntegerStateChange(sim, tag, val, now) {
    if (tag.point_type !== 'integer') return;

    const recordVal = val !== null ? Math.round(val) : null;
    const lastVal = this.lastIntegerStates.get(tag.id);

    if (lastVal === undefined || lastVal !== recordVal) {
      this.lastIntegerStates.set(tag.id, recordVal);

      if (sim.activeBatch && sim.activePhaseEventId && lastVal !== undefined) {
        try {
          await query(
            `INSERT INTO events (batch_pk, asset_id, parent_id, tag_id, name, level, started_at, ended_at, details)
             VALUES ($1, $2, $3, $4, $5, 'StateChange', $6, $6, $7)`,
            [
              sim.activeBatch.id,
              sim.asset.id,
              sim.activePhaseEventId,
              tag.id,
              `${tag.name} -> ${recordVal}`,
              now,
              JSON.stringify({ from: lastVal, to: recordVal }),
            ]
          );
        } catch (err) {
          logger.debug(`Error inserting state change event: ${err.message}`, 'AlarmService');
        }
      }
    }
  }

  /**
   * Reset all active exception states (e.g., during batch displacement).
   */
  clear() {
    this.activeAlarms.clear();
    this.activeExceptions.clear();
    this.lastIntegerStates.clear();
  }
}
