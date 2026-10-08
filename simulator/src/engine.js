import { query, closePool } from './db.js';
import { config } from './config.js';
import { PRNG } from './prng.js';
import { logger } from './logger.js';
import { ReactorSimulation } from './stateMachine.js';
import { ControlService } from './services/controlService.js';
import { ChaosService } from './services/chaosService.js';
import { AlarmService } from './services/alarmService.js';
import { ArchiveService } from './services/archiveService.js';
import { MonitoringService } from './services/monitoringService.js';
import { BatchOrchestrator } from './services/batchOrchestrator.js';

export class SimulationEngine {
  constructor() {
    this.prng = new PRNG(Date.now());
    this.isRunning = false;
    this.isStopping = false;
    this.timerId = null;

    // Services
    this.controlService = new ControlService();
    this.archiveService = new ArchiveService();
    this.monitoringService = new MonitoringService();
    this.alarmService = new AlarmService();

    // Domain data
    this.assets = [];
    this.tags = [];
    this.tagLookup = new Map();
    this.reactors = [];
    this.chaosService = null;
    this.batchOrchestrator = null;

    // Metrics
    this.totalTicks = 0;
    this.lastTickDurationMs = 0;
    this.expectedNextTick = 0;
  }

  async initialize() {
    logger.info('Initializing Continuous Simulation Engine (Single-Batch Train)...', 'Engine');

    // 0. Ensure simulation speed is initialized to default (1x) on container/engine launch
    await this.controlService.resetSpeedToDefault(config.defaultSpeed);

    // 1. Fetch Assets and Tags
    const { rows: assets } = await query(
      'SELECT id, code, display_name, capacity_l, role, material FROM assets ORDER BY id'
    );
    const { rows: tags } = await query(`
      SELECT id, name, asset_id, parameter, point_type, range_min, range_max, 
             alarm_low, alarm_high, alarm_state_int, is_cpp, display_digits
      FROM tags ORDER BY id
    `);

    if (assets.length === 0 || tags.length === 0) {
      throw new Error('Assets or tags missing. Ensure 03_seeds.sql was executed.');
    }

    this.assets = assets;
    this.tags = tags;
    this.tags.forEach((t) => this.tagLookup.set(`${t.asset_id}_${t.parameter}`, t));

    // 2. Initialize Reactors
    this.reactors = assets.map((a) => new ReactorSimulation(a, this.prng));

    // 3. Initialize Services
    this.chaosService = new ChaosService(this.prng, this.tags);
    await this.chaosService.initialize();

    this.batchOrchestrator = new BatchOrchestrator(this.reactors, this.prng);
    await this.batchOrchestrator.initialize();

    logger.info(`Simulation ready: 3 reactors initialized with ${this.tags.length} process tags.`, 'Engine');
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.expectedNextTick = Date.now() + 1000;
    logger.info('Continuous simulation loop started.', 'Engine');
    this._scheduleNextTick();
  }

  async stop() {
    if (this.isStopping) return;
    this.isStopping = true;
    this.isRunning = false;

    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }

    logger.info('Shutting down simulation engine gracefully...', 'Engine');

    // Drain all in-memory archive buffers to database
    try {
      await this.archiveService.drain();
    } catch (err) {
      logger.error(`Error draining archive during shutdown: ${err.message}`, 'Engine', err);
    }

    // Teardown database connection pool
    try {
      await closePool();
    } catch (err) {
      logger.error(`Error closing database pool: ${err.message}`, 'Engine', err);
    }

    logger.info('Simulation engine stopped cleanly.', 'Engine');
  }

  _scheduleNextTick() {
    if (!this.isRunning) return;

    this.expectedNextTick += 1000;
    const drift = this.expectedNextTick - Date.now();
    const delay = Math.max(0, drift);

    this.timerId = setTimeout(async () => {
      await this.tick();
      this._scheduleNextTick();
    }, delay);
  }

  async tick() {
    const tickStart = Date.now();
    const now = new Date();

    try {
      // 1. Poll Simulation Control State
      const ctrl = await this.controlService.getControlState();
      const simRunning = ctrl.running;
      const simSpeed = ctrl.speed;
      const simMode = ctrl.mode;
      const phaseSkipAsset = ctrl.phaseSkipAsset;
      const processSkipAsset = ctrl.processSkipAsset;

      if (phaseSkipAsset) {
        await this.controlService.clearPhaseSkip();
      }

      if (processSkipAsset) {
        await this.controlService.clearProcessSkip();
        await this.batchOrchestrator.skipReactorProcess(
          processSkipAsset,
          now,
          simMode,
          this.controlService
        );
      }

      // 2. Process User Batch Command
      if (ctrl.batchCommand) {
        await this.batchOrchestrator.handleUserBatchCommand(
          ctrl.assignedBatchId,
          ctrl.batchCommand,
          now,
          this.controlService
        );
      }

      // 3. Autonomous Chaos Tick
      await this.chaosService.tick(now, simRunning);
      const activeFaultMap = await this.chaosService.getActiveFaultMap();

      // 4. Advance Batch Train & Reactors
      await this.batchOrchestrator.tick(
        simMode,
        simRunning,
        simSpeed,
        phaseSkipAsset,
        now,
        this.controlService
      );

      // 5. Evaluate Readings, Faults, Alarms & Exceptions
      const snapshotRecords = [];

      for (const sim of this.reactors) {
        for (const param of Object.keys(sim.values)) {
          const tag = this.tagLookup.get(`${sim.asset.id}_${param}`);
          if (!tag) continue;

          let val = sim.values[param];
          let quality = sim.qualities[param] || 0;

          // Apply active faults
          const fault = activeFaultMap.get(tag.id);
          if (fault) {
            switch (fault.kind) {
              case 'stuck':
                val = fault.magnitude ?? val;
                quality = 1;
                break;
              case 'drift':
                val += fault.magnitude ?? 5.0;
                quality = 1;
                break;
              case 'dropout':
                val = null;
                quality = 2;
                break;
              case 'spike':
                val += fault.magnitude ?? 10.0;
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

          // Evaluate Alarms and Exceptions
          await this.alarmService.evaluateTag(sim, tag, val, quality, now);

          // Prepare Snapshot
          snapshotRecords.push({
            tagId: tag.id,
            ts: now.toISOString(),
            val,
            quality,
          });

          // Stage Reading for periodic archive hypertable
          const isInteger = tag.point_type === 'integer';
          const recordVal = isInteger ? (val !== null ? Math.round(val) : null) : val;
          this.archiveService.stageReading(tag.id, now.toISOString(), recordVal, quality);
        }
      }

      // 6. Persist Snapshots & Periodically Flush Archive
      await this.archiveService.updateSnapshots(snapshotRecords);
      await this.archiveService.tickArchive();

      // 7. Dispatch Outbound Monitoring Webhook Jobs
      await this.monitoringService.tick(now);

      this.totalTicks++;
      this.lastTickDurationMs = Date.now() - tickStart;

      if (this.lastTickDurationMs > 900) {
        logger.warn(
          `Tick execution duration high: ${this.lastTickDurationMs}ms (risk of clock drift)`,
          'Engine'
        );
      }
    } catch (err) {
      logger.error(`Error in simulation tick: ${err.message}`, 'Engine', err);
    }
  }

  getMetrics() {
    return {
      running: this.isRunning,
      totalTicks: this.totalTicks,
      lastTickDurationMs: this.lastTickDurationMs,
      pendingBufferSize: this.archiveService.getPendingBufferSize(),
      activeBatch: this.batchOrchestrator?.getActiveTrainBatch()?.batch_id || null,
    };
  }
}
