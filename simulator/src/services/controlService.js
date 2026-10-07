import { query } from '../db.js';
import { logger } from '../logger.js';

export class ControlService {
  /**
   * Poll simulation_control table for control signals.
   */
  async getControlState() {
    try {
      const { rows } = await query(
        'SELECT running, speed, phase_skip_asset, mode, assigned_batch_id, batch_command, single_batch_status FROM simulation_control WHERE id = 1'
      );
      if (rows.length > 0) {
        return {
          running: rows[0].running ?? true,
          speed: Math.max(1, Math.min(3600, rows[0].speed || 1)),
          phaseSkipAsset: rows[0].phase_skip_asset || null,
          mode: rows[0].mode || 'continuous',
          assignedBatchId: rows[0].assigned_batch_id || null,
          batchCommand: rows[0].batch_command || null,
          singleBatchStatus: rows[0].single_batch_status || 'idle',
        };
      }
    } catch (err) {
      logger.debug(`simulation_control query skipped (may be uninitialized): ${err.message}`, 'ControlService');
    }

    return {
      running: true,
      speed: 1,
      phaseSkipAsset: null,
      mode: 'continuous',
      assignedBatchId: null,
      batchCommand: null,
      singleBatchStatus: 'idle',
    };
  }

  /**
   * Reset simulation speed to default (1x) on container startup.
   */
  async resetSpeedToDefault(defaultSpeed = 1) {
    try {
      await query(
        `INSERT INTO simulation_control (id, running, speed, mode)
         VALUES (1, true, $1, 'continuous')
         ON CONFLICT (id) DO UPDATE SET speed = $1, updated_at = NOW()`,
        [defaultSpeed]
      );
      logger.info(`Simulation speed initialized to default: ${defaultSpeed}x`, 'ControlService');
    } catch (err) {
      logger.warn(`Could not initialize default simulation speed: ${err.message}`, 'ControlService');
    }
  }

  /**
   * Clear processed phase_skip_asset trigger.
   */
  async clearPhaseSkip() {
    try {
      await query('UPDATE simulation_control SET phase_skip_asset = NULL WHERE id = 1');
    } catch (err) {
      logger.error(`Failed to clear phase skip: ${err.message}`, 'ControlService');
    }
  }

  /**
   * Acknowledge user batch command.
   */
  async ackBatchCommand(batchId) {
    try {
      await query(
        "UPDATE simulation_control SET batch_command = NULL, assigned_batch_id = $1, single_batch_status = 'running', updated_at = NOW() WHERE id = 1",
        [batchId]
      );
    } catch (err) {
      logger.error(`Failed to ack batch command: ${err.message}`, 'ControlService');
    }
  }

  /**
   * Update single batch status.
   */
  async updateSingleBatchStatus(status) {
    try {
      await query(
        'UPDATE simulation_control SET single_batch_status = $1, updated_at = NOW() WHERE id = 1',
        [status]
      );
    } catch (err) {
      logger.error(`Failed to update single batch status: ${err.message}`, 'ControlService');
    }
  }
}
