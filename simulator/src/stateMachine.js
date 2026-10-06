// simulator/src/stateMachine.js

export const REACTOR_PHASES = {
  R1: ['Idle', 'Charging', 'Heating', 'Distillation', 'Reaction hold', 'Cooling', 'Transfer', 'Clean'],
  R2: ['Idle', 'Receive', 'pH adjust', 'Settle & separate', 'Solvent swap', 'Filter & transfer', 'Clean'],
  R3: ['Idle', 'Receive', 'Heat to dissolve', 'Cooling ramp', 'Age', 'Transfer', 'Clean']
};

export const PHASE_DURATIONS = {
  R1: {
    'Idle': { min: 300, max: 1200 },       // 5m – 20m
    'Charging': { min: 600, max: 1800 },   // 10m – 30m
    'Heating': { min: 2700, max: 3300 },   // 45m – 55m
    'Distillation': { min: 2100, max: 2700 }, // 35m – 45m (Azeotropic water/solvent distillation)
    'Reaction hold': { min: 9600, max: 12000 }, // 160m – 200m (Metformin condensation hold)
    'Cooling': { min: 2400, max: 3600 },   // 40m – 60m (Controlled cooling to ~80 °C safe transfer temp)
    'Transfer': { min: 600, max: 1800 },   // 10m – 30m (Cooled transfer to R2)
    'Clean': { min: 600, max: 1800 }       // 10m – 30m
  },
  R2: {
    'Idle': { min: 300, max: 3600 },
    'Receive': { min: 600, max: 1800 },    // Matched with R1 Transfer
    'pH adjust': { min: 2700, max: 5400 },
    'Settle & separate': { min: 1800, max: 3600 },
    'Solvent swap': { min: 3600, max: 7200 },
    'Filter & transfer': { min: 600, max: 1800 }, // 10m – 30m (Polish filtration & inline transfer to R3)
    'Clean': { min: 1800, max: 3600 }
  },
  R3: {
    'Idle': { min: 300, max: 3600 },
    'Receive': { min: 600, max: 1800 },    // Matched with R2 Filter & transfer
    'Heat to dissolve': { min: 1800, max: 3600 },
    'Cooling ramp': { min: 14400, max: 18000 },  // 4h – 5h (realistic -12 to -15 °C/h cooling rate)
    'Age': { min: 3600, max: 7200 },           // 1h – 2h
    'Transfer': { min: 600, max: 1800 },       // 10m – 30m
    'Clean': { min: 1800, max: 3600 }
  }
};

export class ReactorSimulation {
  constructor(asset, prng) {
    this.asset = asset; // { id, code, capacity_l, role, material }
    this.prng = prng;
    this.code = asset.code; // 'R1', 'R2', or 'R3'

    this.currentPhase = 'Idle';
    this.phaseElapsedSec = 0;
    this.phaseDurationSec = 1800;
    this.phaseOccurrence = 1;

    // ISA-88 Context
    this.activeBatch = null;           // { id, batch_id, started_at }
    this.activeUnitProcedureId = null; // PK of current Unit Procedure event
    this.activePhaseEventId = null;    // PK of current Phase event

    // Previous integer states for change-of-state detection
    this.prevIntegerStates = {};

    // Temperature history buffer for R3.COOL_RATE derivative (slope)
    this.tempHistory = [];

    // R1 Charge Filter Differential Pressure (FILTER_DP) State
    this.filterClogBaseline = 0.55;    // Clean filter base DP (bar)
    this.filterClogAccum = 0.0;        // Dirt accumulation across batches
    this.filterAlarmTimerSec = 0;      // Continuous duration above threshold
    this.filterNeedsReplacement = false;
    this.chargeBatchCount = 0;
    this.batchCount = 0;
    // Overheat / Fault State
    this.tempFaultActive = false;

    // Initialize values based on reactor type
    this.values = {};
    this.qualities = {};
    this._initReactorValues();
  }

  _initReactorValues() {
    if (this.code === 'R1') {
      this.values = {
        TEMP: 22.0,
        JKT_TEMP: 20.0,
        PRES: 0.05,
        FILTER_DP: 0.0,
        AGIT: 0.0,
        VOL: 0.0,
        AGIT_RUN: 0,
        JKT_MODE: 0,
        N2_BLANKET: 1
      };
    } else if (this.code === 'R2') {
      this.values = {
        PH: 7.0,
        TEMP: 22.0,
        DOSE_FLOW: 0.0,
        DOSE_TOTAL: 0.0,
        VOL: 0.0,
        AGIT_RUN: 0,
        DOSE_PUMP: 0,
        N2_BLANKET: 1
      };
    } else if (this.code === 'R3') {
      this.values = {
        TEMP: 22.0,
        COOL_RATE: 0.0,
        AGIT: 0.0,
        TURB: 0.0,
        VOL: 0.0,
        AGIT_RUN: 0,
        COOL_RAMP: 0,
        SEEDED: 0
      };
    }

    for (const key of Object.keys(this.values)) {
      this.qualities[key] = 0; // 0 = Good
    }
  }

  // First-order response helper with subtle, realistic Gaussian sensor noise (smooth, no zigzags)
  approach(current, target, rateSec, noiseStdev, deltaSec = 1) {
    if (deltaSec === 0) return current; // Frozen in place when simulation is paused
    const step = (target - current) * (1 - Math.exp(-deltaSec / Math.max(1, rateSec)));
    // Realistic micro-noise: provides authentic sensor feel without jagged random walk wander
    const noise = noiseStdev > 0 ? this.prng.gaussian(0, noiseStdev * 0.1) : 0;
    return current + step + noise;
  }

  // Advance simulation by deltaSeconds
  tick(deltaSec = 1) {
    // If Idle without an active batch, remain in clean resting state indefinitely
    if (this.currentPhase === 'Idle' && !this.activeBatch) {
      this.phaseElapsedSec = 0;
      if (this.code === 'R1') {
        this.values.VOL = 0;
        this.values.AGIT_RUN = 0;
        this.values.AGIT = 0;
        this.values.JKT_MODE = 0;
        this.values.FILTER_DP = 0.0;
        this.values.TEMP = this.approach(this.values.TEMP, 22.0, 300, 0.01, deltaSec);
        this.values.JKT_TEMP = this.approach(this.values.JKT_TEMP, 20.0, 300, 0.01, deltaSec);
        this.values.PRES = this.approach(this.values.PRES, 0.05, 300, 0.003, deltaSec);
        this.values.N2_BLANKET = 1;
      } else if (this.code === 'R2') {
        this.values.VOL = 0;
        this.values.PH = 7.0;
        this.values.DOSE_FLOW = 0;
        this.values.DOSE_PUMP = 0;
        this.values.DOSE_TOTAL = 0;
        this.values.AGIT_RUN = 0;
        this.values.TEMP = this.approach(this.values.TEMP, 22.0, 300, 0.01, deltaSec);
        this.values.N2_BLANKET = 1;
      } else if (this.code === 'R3') {
        this.values.VOL = 0;
        this.values.TEMP = this.approach(this.values.TEMP, 22.0, 300, 0.01, deltaSec);
        this.values.COOL_RATE = 0;
        this.values.AGIT_RUN = 0;
        this.values.AGIT = 0;
        this.values.TURB = 0;
        this.values.COOL_RAMP = 0;
        this.values.SEEDED = 0;
      }
      return false; // Idle does not auto-expire without batch activity
    }

    this.phaseElapsedSec += deltaSec;
    const progress = Math.min(1.0, this.phaseElapsedSec / Math.max(1, this.phaseDurationSec));

    if (this.code === 'R1') {
      this._tickR1(deltaSec, progress);
    } else if (this.code === 'R2') {
      this._tickR2(deltaSec, progress);
    } else if (this.code === 'R3') {
      this._tickR3(deltaSec, progress);
    }

    // Check if current phase duration has elapsed
    return this.phaseElapsedSec >= this.phaseDurationSec;
  }

  // --- R1 Physics (Synthesis) ---
  _tickR1(dt, prog) {
    const p = this.currentPhase;
    const v = this.values;

    // Filter DP behavior: Liquid flows through charge filter only during 'Charging'
    if (p !== 'Charging') {
      v.FILTER_DP = Math.max(0, this.approach(v.FILTER_DP, 0.0, 10, 0.002, dt));
      this.filterAlarmTimerSec = 0;
    }

    switch (p) {
      case 'Idle':
        v.JKT_MODE = 0;
        v.JKT_TEMP = this.approach(v.JKT_TEMP, 20.0, 180, 0.01, dt);
        v.TEMP = this.approach(v.TEMP, 22.0, 300, 0.01, dt);
        v.PRES = Math.max(0, this.approach(v.PRES, 0.05, 120, 0.003, dt));
        v.AGIT_RUN = 0;
        v.AGIT = this.approach(v.AGIT, 0, 30, 0.05, dt);
        v.VOL = 0;
        v.N2_BLANKET = 1;
        break;

      case 'Charging':
        const flowActive = prog >= 0.02 && prog <= 0.98;
        if (flowActive) {
          const currentBatchDirt = ((prog - 0.02) / 0.96) * 0.15;
          const targetDP = this.filterClogBaseline + this.filterClogAccum + currentBatchDirt;
          v.FILTER_DP = this.approach(v.FILTER_DP, targetDP, 15, 0.005, dt);

          if (v.FILTER_DP > 1.5) {
            this.filterAlarmTimerSec += dt;
            if (this.filterAlarmTimerSec >= 45) {
              this.filterNeedsReplacement = true;
            }
          } else {
            this.filterAlarmTimerSec = Math.max(0, this.filterAlarmTimerSec - dt * 0.5);
          }
        } else {
          v.FILTER_DP = Math.max(0, this.approach(v.FILTER_DP, 0.0, 8, 0.002, dt));
        }

        v.JKT_MODE = 0;
        v.VOL = Math.min(3950, prog * 3950);
        v.AGIT_RUN = v.VOL > 800 ? 1 : 0;
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 70, 45, 0.1, dt) : this.approach(v.AGIT, 0, 30, 0.05, dt);
        v.JKT_TEMP = this.approach(v.JKT_TEMP, 22.0, 180, 0.01, dt);
        v.TEMP = this.approach(v.TEMP, 22.0, 240, 0.01, dt);
        v.PRES = this.approach(v.PRES, 0.2, 120, 0.004, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Heating':
        v.JKT_MODE = 1; // Heating
        const jktTargetHeat = Math.min(160, v.TEMP + 16.0);
        v.JKT_TEMP = this.approach(v.JKT_TEMP, jktTargetHeat, 90, 0.02, dt);
        v.TEMP = this.approach(v.TEMP, 142.5, 220, 0.015, dt);
        const presTarget = 0.2 + (v.TEMP / 142.5) * 1.6;
        v.PRES = this.approach(v.PRES, presTarget, 180, 0.008, dt);
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 140, 60, 0.1, dt);
        v.VOL = 3950;
        v.N2_BLANKET = 1;
        break;

      case 'Distillation':
        v.JKT_MODE = 1;
        v.JKT_TEMP = this.approach(v.JKT_TEMP, 155.0, 90, 0.02, dt);
        v.TEMP = this.approach(v.TEMP, 141.5, 120, 0.015, dt);
        v.VOL = Math.max(3000, 3950 - prog * 950);
        v.PRES = this.approach(v.PRES, 0.35, 120, 0.005, dt);
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 120, 60, 0.1, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Reaction hold':
        v.JKT_MODE = 1;
        v.JKT_TEMP = this.approach(v.JKT_TEMP, 143.0, 60, 0.015, dt);
        v.TEMP = this.approach(v.TEMP, 142.5, 180, 0.01, dt);
        v.PRES = this.approach(v.PRES, 0.35, 180, 0.005, dt);
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 140, 60, 0.1, dt);
        v.VOL = 3000;
        v.N2_BLANKET = 1;
        break;

      case 'Cooling':
        const coolTarget = 142.5 - prog * 62.5; // Controlled linear ramp 142.5 °C -> 80.0 °C
        v.JKT_MODE = 2; // Active cooling mode
        const jktTargetCool = Math.max(20.0, v.TEMP - 30.0);
        v.JKT_TEMP = this.approach(v.JKT_TEMP, jktTargetCool, 90, 0.02, dt);
        v.TEMP = this.approach(v.TEMP, coolTarget, 140, 0.015, dt);
        const presCoolTarget = 0.08 + Math.max(0, (v.TEMP - 80.0) / (142.5 - 80.0)) * 0.27;
        v.PRES = this.approach(v.PRES, presCoolTarget, 120, 0.005, dt);
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 110, 60, 0.1, dt);
        v.VOL = 3000;
        v.N2_BLANKET = 1;
        break;

      case 'Transfer':
        v.JKT_MODE = 0;
        v.VOL = Math.max(0, (1 - prog) * 3000);
        v.AGIT_RUN = v.VOL > 400 ? 1 : 0;
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 40, 45, 0.1, dt) : this.approach(v.AGIT, 0, 30, 0.05, dt);
        v.TEMP = this.approach(v.TEMP, 80.0, 360, 0.01, dt);
        v.JKT_TEMP = this.approach(v.JKT_TEMP, 72.0, 200, 0.01, dt);
        v.PRES = this.approach(v.PRES, 0.05, 120, 0.003, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Clean':
        v.JKT_MODE = prog < 0.75 ? 1 : 0;
        v.VOL = prog < 0.75 ? 2000 : Math.max(0, (1 - (prog - 0.75) / 0.25) * 2000);
        v.AGIT_RUN = v.VOL > 300 ? 1 : 0;
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 160, 45, 0.1, dt) : this.approach(v.AGIT, 0, 30, 0.05, dt);
        v.JKT_TEMP = prog < 0.75 ? this.approach(v.JKT_TEMP, 85.0, 120, 0.02, dt) : this.approach(v.JKT_TEMP, 25.0, 120, 0.02, dt);
        v.TEMP = prog < 0.75 ? this.approach(v.TEMP, 80.0, 200, 0.015, dt) : this.approach(v.TEMP, 25.0, 200, 0.015, dt);
        v.PRES = this.approach(v.PRES, 0.5, 120, 0.005, dt);
        v.N2_BLANKET = 1;
        break;
    }

    // In explicit fault condition (overheat testing)
    if (this.tempFaultActive && (p === 'Heating' || p === 'Distillation' || p === 'Reaction hold')) {
      v.JKT_MODE = 1;
      v.JKT_TEMP = this.approach(v.JKT_TEMP, 168.0, 60, 0.03, dt);
      v.TEMP = this.approach(v.TEMP, 152.0, 90, 0.02, dt);
    }

    // Physical clamps
    v.TEMP = Math.max(-20, Math.min(170, v.TEMP));
    v.JKT_TEMP = Math.max(-25, Math.min(180, v.JKT_TEMP));
    v.PRES = Math.max(-1, Math.min(6, v.PRES));
    v.FILTER_DP = Math.max(0, Math.min(3, v.FILTER_DP));
    v.AGIT = Math.max(0, Math.min(200, v.AGIT));
    v.VOL = Math.max(0, Math.min(5000, v.VOL));
  }

  // --- R2 Physics (Workup) ---
  _tickR2(dt, prog) {
    const p = this.currentPhase;
    const v = this.values;

    switch (p) {
      case 'Idle':
        v.VOL = 0;
        v.PH = 7.0;
        v.TEMP = this.approach(v.TEMP, 22.0, 300, 0.01, dt);
        v.DOSE_FLOW = 0;
        v.DOSE_PUMP = 0;
        v.AGIT_RUN = 0;
        v.N2_BLANKET = 1;
        break;

      case 'Receive':
        if (this.phaseElapsedSec <= dt) v.DOSE_TOTAL = 0.0;
        v.VOL = Math.min(3000, prog * 3000);
        v.AGIT_RUN = v.VOL > 600 ? 1 : 0;
        v.PH = this.approach(v.PH, 2.4, 180, 0.005, dt);
        v.TEMP = this.approach(v.TEMP, 80.0 - prog * 45.0, 180, 0.015, dt);
        v.DOSE_FLOW = 0;
        v.DOSE_PUMP = 0;
        v.N2_BLANKET = 1;
        break;

      case 'pH adjust':
        v.AGIT_RUN = 1;
        v.DOSE_PUMP = prog < 0.85 ? 1 : 0;
        const targetFlow = v.DOSE_PUMP ? Math.max(30, (1 - prog * 0.85) * 250) : 0;
        v.DOSE_FLOW = this.approach(v.DOSE_FLOW, targetFlow, 20, 0.1, dt);
        v.DOSE_TOTAL += (v.DOSE_FLOW / 3600.0) * dt;
        v.VOL = 3000 + v.DOSE_TOTAL;
        const phTarget = 2.4 + (1 - Math.exp(-prog * 4.5)) * 4.6;
        v.PH = this.approach(v.PH, phTarget, 60, 0.005, dt);
        v.TEMP = this.approach(v.TEMP, 38.0 + (prog < 0.8 ? prog * 6 : 4.8), 120, 0.015, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Settle & separate':
        v.DOSE_PUMP = 0;
        v.DOSE_FLOW = 0;
        v.AGIT_RUN = prog > 0.95 ? 1 : 0;
        if (prog >= 0.70) {
          v.VOL = this.approach(v.VOL, 3100, 60, 0.05, dt);
        }
        v.PH = this.approach(v.PH, 7.0, 180, 0.003, dt);
        v.TEMP = this.approach(v.TEMP, 30.0, 300, 0.01, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Solvent swap':
        v.AGIT_RUN = 1;
        v.DOSE_PUMP = 0;
        v.DOSE_FLOW = 0;
        v.TEMP = this.approach(v.TEMP, 62.0, 200, 0.015, dt);
        const swapVol = prog < 0.6 ? 3100 - prog * 900 : 2560 + (prog - 0.6) * 400;
        v.VOL = this.approach(v.VOL, swapVol, 120, 0.05, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Filter & transfer':
      case 'Transfer':
        v.DOSE_PUMP = 0;
        v.DOSE_FLOW = 0;
        v.VOL = Math.max(0, (1 - prog) * 2700);
        v.AGIT_RUN = v.VOL > 500 ? 1 : 0;
        v.TEMP = this.approach(v.TEMP, 35.0, 240, 0.01, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Clean':
        v.VOL = prog < 0.75 ? 2000 : Math.max(0, (1 - (prog - 0.75) / 0.25) * 2000);
        v.AGIT_RUN = v.VOL > 300 ? 1 : 0;
        v.TEMP = prog < 0.75 ? this.approach(v.TEMP, 65.0, 180, 0.015, dt) : this.approach(v.TEMP, 25.0, 180, 0.015, dt);
        v.PH = 7.0;
        v.DOSE_FLOW = 0;
        v.DOSE_PUMP = 0;
        v.N2_BLANKET = 1;
        break;
    }

    // Physical clamps
    v.PH = Math.max(0, Math.min(14, v.PH));
    v.TEMP = Math.max(-10, Math.min(120, v.TEMP));
    v.DOSE_FLOW = Math.max(0, Math.min(500, v.DOSE_FLOW));
    v.DOSE_TOTAL = Math.max(0, Math.min(2000, v.DOSE_TOTAL));
    v.VOL = Math.max(0, Math.min(5000, v.VOL));
  }

  // --- R3 Physics (Crystalliser) ---
  _tickR3(dt, prog) {
    const p = this.currentPhase;
    const v = this.values;

    switch (p) {
      case 'Idle':
        v.VOL = 0;
        v.TEMP = this.approach(v.TEMP, 22.0, 300, 0.01, dt);
        v.COOL_RATE = 0;
        v.AGIT_RUN = 0;
        v.AGIT = 0;
        v.TURB = 0;
        v.COOL_RAMP = 0;
        v.SEEDED = 0;
        break;

      case 'Receive':
        if (this.phaseElapsedSec <= dt) v.SEEDED = 0;
        v.VOL = Math.min(2500, prog * 2500);
        v.AGIT_RUN = v.VOL > 500 ? 1 : 0;
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 70, 45, 0.1, dt) : 0;
        v.TEMP = this.approach(v.TEMP, 35.0, 240, 0.01, dt);
        v.TURB = this.approach(v.TURB, 280, 120, 0.5, dt);
        v.COOL_RAMP = 0;
        v.SEEDED = 0;
        break;

      case 'Heat to dissolve':
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 90, 45, 0.1, dt);
        v.TEMP = this.approach(v.TEMP, 72.0, 180, 0.015, dt);
        v.TURB = this.approach(v.TURB, 12.0, 120, 0.2, dt);
        v.COOL_RAMP = 0;
        v.SEEDED = 0;
        break;

      case 'Cooling ramp':
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 75, 45, 0.1, dt);
        v.COOL_RAMP = 1;
        const rampTemp = 72.0 - prog * 60.0; // Controlled linear cooling 72 °C -> 12 °C
        v.TEMP = this.approach(v.TEMP, rampTemp, 50, 0.015, dt);
        if (prog >= 0.40) {
          v.SEEDED = 1;
          const seedProg = (prog - 0.40) / 0.60;
          const turbTarget = 15.0 + Math.min(750, seedProg * 800);
          v.TURB = this.approach(v.TURB, turbTarget, 90, 0.5, dt);
        } else {
          v.SEEDED = 0;
          v.TURB = this.approach(v.TURB, 15.0, 60, 0.2, dt);
        }
        break;

      case 'Age':
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 70, 45, 0.1, dt);
        v.COOL_RAMP = 0;
        v.TEMP = this.approach(v.TEMP, 5.0, 180, 0.01, dt);
        v.TURB = this.approach(v.TURB, 860, 180, 0.5, dt);
        v.SEEDED = 1;
        break;

      case 'Transfer':
        v.VOL = Math.max(0, (1 - prog) * 2500);
        v.AGIT_RUN = v.VOL > 300 ? 1 : 0;
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 50, 45, 0.1, dt) : 0;
        v.TEMP = this.approach(v.TEMP, 10.0, 240, 0.01, dt);
        v.COOL_RAMP = 0;
        v.SEEDED = 1;
        break;

      case 'Clean':
        v.VOL = prog < 0.75 ? 1500 : Math.max(0, (1 - (prog - 0.75) / 0.25) * 1500);
        v.AGIT_RUN = v.VOL > 200 ? 1 : 0;
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 115, 45, 0.1, dt) : 0;
        v.TEMP = prog < 0.75 ? this.approach(v.TEMP, 65.0, 180, 0.015, dt) : this.approach(v.TEMP, 25.0, 180, 0.015, dt);
        v.TURB = this.approach(v.TURB, 0, 90, 0.1, dt);
        v.COOL_RAMP = 0;
        v.SEEDED = 0;
        break;
    }

    // Maintain sliding window to compute COOL_RATE (dTEMP/dt in °C/h) only during Cooling ramp
    if (p === 'Cooling ramp') {
      this.tempHistory.push({ t: this.phaseElapsedSec, temp: v.TEMP });
      if (this.tempHistory.length > 180) this.tempHistory.shift();

      if (this.tempHistory.length >= 10) {
        const oldest = this.tempHistory[0];
        const newest = this.tempHistory[this.tempHistory.length - 1];
        const dtSec = newest.t - oldest.t;
        if (dtSec > 0) {
          v.COOL_RATE = Number((((newest.temp - oldest.temp) / dtSec) * 3600).toFixed(1));
        }
      } else {
        v.COOL_RATE = -10.0;
      }
    } else {
      this.tempHistory = [];
      v.COOL_RATE = 0.0;
    }

    // Physical clamps
    v.TEMP = Math.max(-20, Math.min(120, v.TEMP));
    v.COOL_RATE = Math.max(-30, Math.min(30, v.COOL_RATE));
    v.AGIT = Math.max(0, Math.min(150, v.AGIT));
    v.TURB = Math.max(0, Math.min(1000, v.TURB));
    v.VOL = Math.max(0, Math.min(3000, v.VOL));
  }

  // Transition to next phase in sequence or forced phase
  transitionNextPhase(forcedPhase = null) {
    const prevPhase = this.currentPhase;
    const phases = REACTOR_PHASES[this.code];
    if (forcedPhase) {
      this.currentPhase = forcedPhase;
    } else {
      const idx = phases.indexOf(this.currentPhase);
      this.currentPhase = phases[(idx + 1) % phases.length];
    }

    if ((this.code === 'R1' && this.currentPhase === 'Charging' && prevPhase !== 'Charging') ||
      ((this.code === 'R2' || this.code === 'R3') && this.currentPhase === 'Receive' && prevPhase !== 'Receive')) {
      this.batchCount++;
    }

    if (this.code === 'R1') {
      if (this.currentPhase === 'Charging' && prevPhase !== 'Charging') {
        this.chargeBatchCount++;
        // Maintain clean filter DP baseline
        this.filterClogAccum = 0.0;
      }
      if ((this.currentPhase === 'Idle' || this.currentPhase === 'Clean') && this.filterNeedsReplacement) {
        this.filterClogAccum = 0.0;
        this.filterNeedsReplacement = false;
        this.filterAlarmTimerSec = 0;
      }
    }

    this.phaseElapsedSec = 0;
    this.tempHistory = [];
    const durConfig = PHASE_DURATIONS[this.code][this.currentPhase];
    this.phaseDurationSec = this.prng.rangeInt(durConfig.min, durConfig.max);

    return this.currentPhase;
  }
}