/**
 * Reactor State Machine & Chemical Process Physics Engine.
 * Models ISA-88 phases, thermodynamics, fluid dynamics, reagent dosing,
 * crystallization kinetics, and realistic sensor noise.
 */

export const REACTOR_PHASES = {
  R1: ['Idle', 'Charging', 'Heating', 'Distillation', 'Reaction hold', 'Cooling', 'Transfer', 'Clean'],
  R2: ['Idle', 'Receive', 'pH adjust', 'Settle & separate', 'Solvent swap', 'Filter & transfer', 'Clean'],
  R3: ['Idle', 'Receive', 'Heat to dissolve', 'Cooling ramp', 'Age', 'Transfer', 'Clean'],
};

export const PHASE_DURATIONS = {
  R1: {
    'Idle': { min: 300, max: 1200 },              // 5m – 20m
    'Charging': { min: 600, max: 1800 },          // 10m – 30m
    'Heating': { min: 2700, max: 3300 },          // 45m – 55m
    'Distillation': { min: 2100, max: 2700 },     // 35m – 45m (Azeotropic water/solvent distillation)
    'Reaction hold': { min: 9600, max: 12000 },   // 160m – 200m (Condensation hold)
    'Cooling': { min: 2400, max: 3600 },          // 40m – 60m (Controlled cooling to ~80 °C safe transfer)
    'Transfer': { min: 600, max: 1800 },          // 10m – 30m (Cooled transfer to R2)
    'Clean': { min: 600, max: 1800 },             // 10m – 30m
  },
  R2: {
    'Idle': { min: 300, max: 3600 },
    'Receive': { min: 600, max: 1800 },           // Matched with R1 Transfer
    'pH adjust': { min: 2700, max: 5400 },
    'Settle & separate': { min: 1800, max: 3600 },
    'Solvent swap': { min: 3600, max: 7200 },
    'Filter & transfer': { min: 300, max: 720 }, // 5m – 12m (Inline polish transfer to R3)
    'Clean': { min: 1800, max: 3600 },
  },
  R3: {
    'Idle': { min: 300, max: 3600 },
    'Receive': { min: 600, max: 1800 },           // Matched with R2 Filter & transfer
    'Heat to dissolve': { min: 1800, max: 3600 },
    'Cooling ramp': { min: 14400, max: 18000 },   // 4h – 5h (realistic -12 to -15 °C/h cooling rate)
    'Age': { min: 3600, max: 7200 },              // 1h – 2h
    'Transfer': { min: 600, max: 1800 },          // 10m – 30m
    'Clean': { min: 1800, max: 3600 },
  },
};

export class ReactorSimulation {
  constructor(asset, prng) {
    this.asset = asset; // { id, code, display_name, capacity_l, role, material }
    this.prng = prng;
    this.code = asset.code; // 'R1', 'R2', or 'R3'

    this.currentPhase = 'Idle';
    this.phaseElapsedSec = 0;
    this.phaseDurationSec = 1800;
    this.phaseOccurrence = 1;

    // ISA-88 Execution Context
    this.activeBatch = null;           // { id, batch_id, started_at }
    this.activeUnitProcedureId = null; // PK of current Unit Procedure event
    this.activePhaseEventId = null;    // PK of current Phase event

    // Temperature history sliding window for derivative (dTEMP/dt)
    this.tempHistory = [];

    // R1 Differential Pressure (FILTER_DP) State
    this.filterClogBaseline = 0.55;    // Base DP across clean filter (bar)
    this.filterClogAccum = 0.0;        // Accumulation across batches
    this.filterAlarmTimerSec = 0;
    this.filterNeedsReplacement = false;
    this.chargeBatchCount = 0;
    this.batchCount = 0;

    // Overheat / Fault State
    this.tempFaultActive = false;

    // R2 & R3 Random Occasional Deviation Flags per Batch (low probability)
    this.r2HasPhOvershoot = false;
    this.r2HasDoseFlowSurge = false;
    this.r2HasTempOverrun = false;
    this.r3HasCoolRateGlitch = false;
    this.r3HasAgitSpike = false;

    // Tag values and quality (0 = Good, 1 = Uncertain, 2 = Bad)
    this.values = {};
    this.qualities = {};
    this.initReactorValues();
  }

  initReactorValues() {
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
        N2_BLANKET: 1,
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
        N2_BLANKET: 1,
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
        SEEDED: 0,
      };
    }

    for (const key of Object.keys(this.values)) {
      this.qualities[key] = 0;
    }
  }

  /**
   * First-order exponential lag response helper with subtle Gaussian sensor micro-noise.
   */
  approach(current, target, rateSec, noiseStdev = 0, deltaSec = 1) {
    if (deltaSec <= 0 || !Number.isFinite(current)) return current;
    const safeRate = Math.max(1, rateSec);
    const step = (target - current) * (1 - Math.exp(-deltaSec / safeRate));
    const noise = noiseStdev > 0 ? this.prng.gaussian(0, noiseStdev * 0.1) : 0;
    const val = current + step + noise;
    return Number.isFinite(val) ? val : target;
  }

  /**
   * Advance simulation time by deltaSec.
   * Returns true if the active phase duration has expired.
   */
  tick(deltaSec = 1) {
    // If Idle without an active batch, remain in clean resting state
    if (this.currentPhase === 'Idle' && !this.activeBatch) {
      this.phaseElapsedSec = 0;
      this._applyRestingState(deltaSec);
      return false;
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

    return this.phaseElapsedSec >= this.phaseDurationSec;
  }

  _applyRestingState(dt) {
    if (this.code === 'R1') {
      this.values.VOL = 0;
      this.values.AGIT_RUN = 0;
      this.values.AGIT = 0;
      this.values.JKT_MODE = 0;
      this.values.FILTER_DP = 0.0;
      this.values.TEMP = this.approach(this.values.TEMP, 22.0, 300, 0.01, dt);
      this.values.JKT_TEMP = this.approach(this.values.JKT_TEMP, 20.0, 300, 0.01, dt);
      this.values.PRES = this.approach(this.values.PRES, 0.05, 300, 0.003, dt);
      this.values.N2_BLANKET = 1;
    } else if (this.code === 'R2') {
      this.values.VOL = 0;
      this.values.PH = 7.0;
      this.values.DOSE_FLOW = 0;
      this.values.DOSE_PUMP = 0;
      this.values.DOSE_TOTAL = 0;
      this.values.AGIT_RUN = 0;
      this.values.TEMP = this.approach(this.values.TEMP, 22.0, 300, 0.01, dt);
      this.values.N2_BLANKET = 1;
    } else if (this.code === 'R3') {
      this.values.VOL = 0;
      this.values.TEMP = this.approach(this.values.TEMP, 22.0, 300, 0.01, dt);
      this.values.COOL_RATE = 0;
      this.values.AGIT_RUN = 0;
      this.values.AGIT = 0;
      this.values.TURB = 0;
      this.values.COOL_RAMP = 0;
      this.values.SEEDED = 0;
    }
  }

  // --- R1 Physics (Synthesis) ---
  _tickR1(dt, prog) {
    const p = this.currentPhase;
    const v = this.values;

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
          const currentBatchDirt = ((prog - 0.02) / 0.96) * 0.25;
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
        let targetTempHeat = 142.5;
        // Thermal inertia overshoot peak at ~147.2 °C (alarm_high is 145.0 °C)
        if (prog >= 0.82 && prog <= 0.96) {
          const overshootProg = Math.sin(((prog - 0.82) / 0.14) * Math.PI);
          targetTempHeat = 142.5 + overshootProg * 4.7; // Peaks at ~147.2 °C
        }
        const jktTargetHeat = Math.min(160, Math.max(v.TEMP + 16.0, targetTempHeat + 8.0));
        v.JKT_TEMP = this.approach(v.JKT_TEMP, jktTargetHeat, 90, 0.02, dt);
        v.TEMP = this.approach(v.TEMP, targetTempHeat, 90, 0.015, dt);
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

        let targetPresDist = 0.35;
        // Solvent vapor boil-up surge & overhead condenser backpressure: reliably peaks at ~4.75 - 4.88 bar g (> 4.50 bar g alarm)
        if (prog >= 0.12 && prog <= 0.36) {
          const boilupProg = Math.sin(((prog - 0.12) / 0.24) * Math.PI);
          targetPresDist = 0.35 + boilupProg * 4.95; // Target peaks at 5.30 bar g
        }
        v.PRES = this.approach(v.PRES, targetPresDist, 50, 0.005, dt);
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 120, 60, 0.1, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Reaction hold':
        v.JKT_MODE = 1;
        let targetTempHold = 142.5;
        // Exothermic condensation reaction surge peak at ~146.8 °C (alarm_high is 145.0 °C)
        if (prog >= 0.35 && prog <= 0.52) {
          const exothermProg = Math.sin(((prog - 0.35) / 0.17) * Math.PI);
          targetTempHold = 142.5 + exothermProg * 4.3; // Peaks at ~146.8 °C
        }
        v.JKT_TEMP = this.approach(v.JKT_TEMP, 143.0, 60, 0.015, dt);
        v.TEMP = this.approach(v.TEMP, targetTempHold, 80, 0.01, dt);
        v.PRES = this.approach(v.PRES, 0.35, 180, 0.005, dt);
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 140, 60, 0.1, dt);
        v.VOL = 3000;
        v.N2_BLANKET = 1;
        break;

      case 'Cooling':
        const coolTarget = 142.5 - prog * 62.5; // Controlled linear ramp 142.5 -> 80.0 °C
        v.JKT_MODE = 2; // Cooling
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

    // Overheat fault simulation
    if (this.tempFaultActive && (p === 'Heating' || p === 'Distillation' || p === 'Reaction hold')) {
      v.JKT_MODE = 1;
      v.JKT_TEMP = this.approach(v.JKT_TEMP, 168.0, 60, 0.03, dt);
      v.TEMP = this.approach(v.TEMP, 152.0, 90, 0.02, dt);
    }

    // Physical bounds clamps
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
        let targetFlow = v.DOSE_PUMP ? Math.max(30, (1 - prog * 0.85) * 250) : 0;
        if (this.r2HasDoseFlowSurge && prog >= 0.10 && prog <= 0.28) {
          targetFlow = 450; // Dosing valve surge peaking at ~435 - 445 L/h (> 400 L/h alarm)
        }
        v.DOSE_FLOW = this.approach(v.DOSE_FLOW, targetFlow, 15, 0.1, dt);
        v.DOSE_TOTAL += (v.DOSE_FLOW / 3600.0) * dt;
        v.VOL = 3000 + v.DOSE_TOTAL;
        let phTarget = 2.4 + (1 - Math.exp(-prog * 4.5)) * 4.6;
        if (this.r2HasPhOvershoot && prog >= 0.76 && prog <= 0.92) {
          const overshoot = Math.sin(((prog - 0.76) / 0.16) * Math.PI);
          phTarget += overshoot * 3.2; // Alkaline overshoot peaking at ~9.85 - 10.1 pH (> 9.50 alarm)
        }
        v.PH = this.approach(v.PH, phTarget, 45, 0.005, dt);
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
        let targetSwapTemp = 62.0;
        if (this.r2HasTempOverrun && prog >= 0.35 && prog <= 0.65) {
          const overrunProg = Math.sin(((prog - 0.35) / 0.30) * Math.PI);
          targetSwapTemp = 62.0 + overrunProg * 32.0; // Solvent swap temperature creep peaking at ~92.5 - 93.5 °C (> 90.0 °C alarm)
        }
        v.TEMP = this.approach(v.TEMP, targetSwapTemp, 90, 0.015, dt);
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

    // Physical bounds clamps
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
        let agitSpeedR3 = 75;
        if (this.r3HasAgitSpike && prog >= 0.28 && prog <= 0.44) {
          agitSpeedR3 = 148; // Slurry viscosity compensation speed spike peaking at ~145 - 147 rpm (> 140 rpm alarm)
        }
        v.AGIT = this.approach(v.AGIT, agitSpeedR3, 25, 0.1, dt);
        v.COOL_RAMP = 1;
        let rampTemp = 72.0 - prog * 60.0; // Controlled linear ramp 72 -> 12 °C
        if (this.r3HasCoolRateGlitch && prog >= 0.38 && prog <= 0.54) {
          rampTemp -= Math.sin(((prog - 0.38) / 0.16) * Math.PI) * 4.2; // Chiller pulse causing cooling rate dip to -23.0 to -26.0 °C/h (< -20.0 °C/h alarm)
        }
        v.TEMP = this.approach(v.TEMP, rampTemp, 30, 0.015, dt);
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

    // Cooling rate sliding window derivative calculation
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

    // Physical bounds clamps
    v.TEMP = Math.max(-20, Math.min(120, v.TEMP));
    v.COOL_RATE = Math.max(-30, Math.min(30, v.COOL_RATE));
    v.AGIT = Math.max(0, Math.min(150, v.AGIT));
    v.TURB = Math.max(0, Math.min(1000, v.TURB));
    v.VOL = Math.max(0, Math.min(3000, v.VOL));
  }

  /**
   * Transition to the next phase in the defined sequence or a forced phase.
   */
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
        // 1 exception every two batches: even batches foul the filter (> 1.5 bar)
        if (this.chargeBatchCount % 2 === 0) {
          this.filterClogAccum = 0.85; // Clogged cake pushes DP above 1.5 bar
        } else {
          this.filterClogAccum = 0.0;  // Clean baseline
        }
      }
      if (this.currentPhase === 'Idle' || this.currentPhase === 'Clean') {
        this.filterNeedsReplacement = false;
        this.filterAlarmTimerSec = 0;
      }
    } else if (this.code === 'R2') {
      if (this.currentPhase === 'Receive' && prevPhase !== 'Receive') {
        this.r2HasPhOvershoot = this.prng.next() < 0.50;   // 50% per batch
        this.r2HasDoseFlowSurge = this.prng.next() < 0.50; // 50% per batch
        this.r2HasTempOverrun = this.prng.next() < 0.50;   // 50% per batch
      }
    } else if (this.code === 'R3') {
      if (this.currentPhase === 'Receive' && prevPhase !== 'Receive') {
        this.r3HasCoolRateGlitch = this.prng.next() < 0.50; // 50% per batch
        this.r3HasAgitSpike = this.prng.next() < 0.50;      // 50% per batch
      }
    }

    this.phaseElapsedSec = 0;
    this.tempHistory = [];
    const durConfig = PHASE_DURATIONS[this.code][this.currentPhase] || { min: 600, max: 1800 };
    this.phaseDurationSec = this.prng.rangeInt(durConfig.min, durConfig.max);

    return this.currentPhase;
  }
}