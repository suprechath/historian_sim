// simulator/src/stateMachine.js

export const REACTOR_PHASES = {
  R1: ['Idle', 'Charging', 'Heating', 'Reaction hold', 'Cooling', 'Transfer', 'Clean'],
  R2: ['Idle', 'Receive', 'pH adjust', 'Settle & separate', 'Solvent swap', 'Transfer', 'Clean'],
  R3: ['Idle', 'Receive', 'Heat to dissolve', 'Cooling ramp', 'Age', 'Transfer', 'Clean']
};

export const PHASE_DURATIONS = {
  R1: {
    'Idle':          { min: 300,  max: 3600 },   // 5m – 60m
    'Charging':      { min: 1200, max: 2400 },   // 20m – 40m
    'Heating':       { min: 2700, max: 5400 },   // 45m – 90m
    'Reaction hold': { min: 7200, max: 21600 },  // 2h – 6h
    'Cooling':       { min: 3600, max: 7200 },   // 60m – 120m
    'Transfer':      { min: 1200, max: 2400 },   // 20m – 40m
    'Clean':         { min: 1800, max: 3600 }    // 30m – 60m
  },
  R2: {
    'Idle':              { min: 300,  max: 3600 },
    'Receive':           { min: 1200, max: 2400 },
    'pH adjust':         { min: 2700, max: 5400 },
    'Settle & separate': { min: 1800, max: 3600 },
    'Solvent swap':      { min: 3600, max: 7200 },
    'Transfer':          { min: 1200, max: 2400 },
    'Clean':             { min: 1800, max: 3600 }
  },
  R3: {
    'Idle':             { min: 300,  max: 3600 },
    'Receive':          { min: 1200, max: 2400 },
    'Heat to dissolve': { min: 1800, max: 3600 },
    'Cooling ramp':     { min: 3600, max: 7200 },
    'Age':              { min: 3600, max: 10800 },
    'Transfer':         { min: 1200, max: 2400 },
    'Clean':            { min: 1800, max: 3600 }
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

  // First-order response helper with Gaussian sensor noise
  approach(current, target, rateSec, noiseStdev, deltaSec = 1) {
    const step = (target - current) * (1 - Math.exp(-deltaSec / Math.max(1, rateSec)));
    const noise = this.prng.gaussian(0, noiseStdev);
    return current + step + noise;
  }

  // Advance simulation by deltaSeconds
  tick(deltaSec = 1) {
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
    let targetTemp = 22.0;

    switch (p) {
      case 'Idle':
        targetTemp = 22.0;
        v.JKT_MODE = 0;
        v.JKT_TEMP = this.approach(v.JKT_TEMP, 20.0, 180, 0.02, dt);
        v.TEMP = this.approach(v.TEMP, 22.0, 300, 0.02, dt);
        v.PRES = Math.max(0, this.approach(v.PRES, 0.05, 120, 0.005, dt));
        v.AGIT_RUN = 0;
        v.AGIT = this.approach(v.AGIT, 0, 30, 0.1, dt);
        v.VOL = 0;
        v.N2_BLANKET = 1;
        break;

      case 'Charging':
        targetTemp = 22.0;
        v.JKT_MODE = 0;
        v.VOL = Math.min(4000, prog * 3900);
        v.AGIT_RUN = v.VOL > 800 ? 1 : 0;
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 70, 45, 0.2, dt) : this.approach(v.AGIT, 0, 30, 0.1, dt);
        v.JKT_TEMP = this.approach(v.JKT_TEMP, 22.0, 180, 0.02, dt);
        v.TEMP = this.approach(v.TEMP, 22.0, 240, 0.03, dt);
        v.PRES = this.approach(v.PRES, 0.2, 120, 0.005, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Heating':
        targetTemp = 85.0;
        v.JKT_MODE = 1; // Heating
        // Jacket runs 15 °C above target to drive heat transfer
        const jktTargetHeat = Math.min(105, v.TEMP + 16.0);
        v.JKT_TEMP = this.approach(v.JKT_TEMP, jktTargetHeat, 90, 0.04, dt);
        // Product follows with thermal lag and slight overshoot
        const tempTarget = prog > 0.85 ? 86.5 : 85.0;
        v.TEMP = this.approach(v.TEMP, tempTarget, 220, 0.03, dt);
        // Pressure rises as solvent heats
        const presTarget = 0.2 + (v.TEMP / 85.0) * 2.8;
        v.PRES = this.approach(v.PRES, presTarget, 180, 0.015, dt);
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 140, 60, 0.2, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Reaction hold':
        targetTemp = 85.0;
        // JKT_MODE alternates between heating and cooling in short bursts
        v.JKT_MODE = Math.sin(this.phaseElapsedSec / 120) > 0 ? 1 : 2;
        v.JKT_TEMP = this.approach(v.JKT_TEMP, 85.0 + Math.sin(this.phaseElapsedSec / 120) * 2.5, 60, 0.04, dt);
        // Product oscillates gently ±0.4 °C around target
        v.TEMP = this.approach(v.TEMP, 85.0 + Math.sin((this.phaseElapsedSec - 60) / 120) * 0.4, 180, 0.02, dt);
        v.PRES = this.approach(v.PRES, 3.2 + Math.sin(this.phaseElapsedSec / 300) * 0.1, 180, 0.01, dt);
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 140, 60, 0.2, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Cooling':
        targetTemp = 25.0;
        v.JKT_MODE = 2; // Cooling
        v.JKT_TEMP = this.approach(v.JKT_TEMP, 12.0, 90, 0.04, dt);
        v.TEMP = this.approach(v.TEMP, 25.0, 240, 0.03, dt);
        v.PRES = this.approach(v.PRES, 0.3, 180, 0.01, dt);
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 70, 60, 0.2, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Transfer':
        targetTemp = 22.0;
        v.JKT_MODE = 0;
        v.VOL = Math.max(0, (1 - prog) * 3900);
        v.AGIT_RUN = v.VOL > 500 ? 1 : 0;
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 40, 45, 0.2, dt) : this.approach(v.AGIT, 0, 30, 0.1, dt);
        v.TEMP = this.approach(v.TEMP, 24.0, 300, 0.02, dt);
        v.JKT_TEMP = this.approach(v.JKT_TEMP, 20.0, 200, 0.02, dt);
        v.PRES = this.approach(v.PRES, 0.05, 120, 0.005, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Clean':
        targetTemp = 70.0;
        v.JKT_MODE = prog < 0.75 ? 1 : 0;
        v.VOL = prog < 0.75 ? 2000 : Math.max(0, (1 - (prog - 0.75) / 0.25) * 2000);
        v.AGIT_RUN = v.VOL > 300 ? 1 : 0;
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 160, 45, 0.3, dt) : this.approach(v.AGIT, 0, 30, 0.1, dt);
        v.JKT_TEMP = prog < 0.75 ? this.approach(v.JKT_TEMP, 75.0, 120, 0.04, dt) : this.approach(v.JKT_TEMP, 25.0, 120, 0.04, dt);
        v.TEMP = prog < 0.75 ? this.approach(v.TEMP, 70.0, 200, 0.03, dt) : this.approach(v.TEMP, 30.0, 200, 0.03, dt);
        v.PRES = this.approach(v.PRES, 0.5, 120, 0.01, dt);
        v.N2_BLANKET = 1;
        break;
    }

    // Physical clamps
    v.TEMP = Math.max(-20, Math.min(150, v.TEMP));
    v.JKT_TEMP = Math.max(-25, Math.min(160, v.JKT_TEMP));
    v.PRES = Math.max(-1, Math.min(6, v.PRES));
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
        v.TEMP = this.approach(v.TEMP, 22.0, 300, 0.02, dt);
        v.DOSE_FLOW = 0;
        v.DOSE_PUMP = 0;
        v.AGIT_RUN = 0;
        v.N2_BLANKET = 1;
        break;

      case 'Receive':
        // Reset DOSE_TOTAL at start
        if (this.phaseElapsedSec <= dt) v.DOSE_TOTAL = 0.0;
        v.VOL = Math.min(3900, prog * 3900);
        v.AGIT_RUN = v.VOL > 800 ? 1 : 0;
        v.PH = this.approach(v.PH, 2.4, 180, 0.01, dt);
        v.TEMP = this.approach(v.TEMP, 28.0, 240, 0.02, dt);
        v.DOSE_FLOW = 0;
        v.DOSE_PUMP = 0;
        v.N2_BLANKET = 1;
        break;

      case 'pH adjust':
        v.AGIT_RUN = 1;
        v.DOSE_PUMP = prog < 0.9 ? 1 : 0;
        // Dosing flow starts strong then tapers
        const targetFlow = v.DOSE_PUMP ? Math.max(40, (1 - prog * 0.8) * 260) : 0;
        v.DOSE_FLOW = this.approach(v.DOSE_FLOW, targetFlow, 20, 0.5, dt);
        // Integrate total dosed volume (Flow in L/h -> L/s)
        v.DOSE_TOTAL += (v.DOSE_FLOW / 3600.0) * dt;
        // Volume increases by dosing
        v.VOL = 3900 + v.DOSE_TOTAL;
        // pH rises asymptotically toward 7.0
        const phTarget = 2.4 + (1 - Math.exp(-prog * 4.5)) * 4.6;
        v.PH = this.approach(v.PH, phTarget, 60, 0.01, dt);
        // Neutralization exotherm
        v.TEMP = this.approach(v.TEMP, 38.0 + (prog < 0.8 ? prog * 6 : 4.8), 120, 0.03, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Settle & separate':
        v.DOSE_PUMP = 0;
        v.DOSE_FLOW = 0;
        // Agitator stops to allow phase separation
        v.AGIT_RUN = prog > 0.95 ? 1 : 0;
        // Aqueous layer drained at 70% of phase duration
        if (prog >= 0.70) {
          v.VOL = this.approach(v.VOL, 3100, 60, 0.1, dt);
        }
        v.PH = this.approach(v.PH, 7.0, 180, 0.005, dt);
        v.TEMP = this.approach(v.TEMP, 30.0, 300, 0.02, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Solvent swap':
        v.AGIT_RUN = 1;
        v.DOSE_PUMP = 0;
        v.DOSE_FLOW = 0;
        // Heated to drive off extraction solvent
        v.TEMP = this.approach(v.TEMP, 62.0, 200, 0.03, dt);
        // Volume drops from boil-off, then recovers as replacement solvent is added
        const swapVol = prog < 0.6 ? 3100 - prog * 900 : 2560 + (prog - 0.6) * 400;
        v.VOL = this.approach(v.VOL, swapVol, 120, 0.2, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Transfer':
        v.DOSE_PUMP = 0;
        v.DOSE_FLOW = 0;
        v.VOL = Math.max(0, (1 - prog) * 2700);
        v.AGIT_RUN = v.VOL > 500 ? 1 : 0;
        v.TEMP = this.approach(v.TEMP, 35.0, 240, 0.02, dt);
        v.N2_BLANKET = 1;
        break;

      case 'Clean':
        v.VOL = prog < 0.75 ? 2000 : Math.max(0, (1 - (prog - 0.75) / 0.25) * 2000);
        v.AGIT_RUN = v.VOL > 300 ? 1 : 0;
        v.TEMP = prog < 0.75 ? this.approach(v.TEMP, 65.0, 180, 0.03, dt) : this.approach(v.TEMP, 25.0, 180, 0.03, dt);
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
        v.TEMP = this.approach(v.TEMP, 22.0, 300, 0.02, dt);
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
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 70, 45, 0.2, dt) : 0;
        v.TEMP = this.approach(v.TEMP, 35.0, 240, 0.02, dt);
        v.TURB = this.approach(v.TURB, 280, 120, 1.5, dt);
        v.COOL_RAMP = 0;
        v.SEEDED = 0;
        break;

      case 'Heat to dissolve':
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 90, 45, 0.2, dt);
        v.TEMP = this.approach(v.TEMP, 72.0, 180, 0.03, dt);
        // Turbidity drops to near 0 as solids dissolve
        v.TURB = this.approach(v.TURB, 12.0, 120, 0.5, dt);
        v.COOL_RAMP = 0;
        v.SEEDED = 0;
        break;

      case 'Cooling ramp':
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 75, 45, 0.2, dt);
        v.COOL_RAMP = 1;
        // Controlled linear cooling ramp from 72 °C to 12 °C
        const rampTemp = 72.0 - prog * 60.0;
        v.TEMP = this.approach(v.TEMP, rampTemp, 60, 0.03, dt);
        // Seed addition occurs at ~40% through cooling ramp
        if (prog >= 0.40) {
          v.SEEDED = 1;
          // Turbidity sharply surges 5-10 min after seeding
          const seedProg = (prog - 0.40) / 0.60;
          const turbTarget = 15.0 + Math.min(750, seedProg * 800);
          v.TURB = this.approach(v.TURB, turbTarget, 90, 2.0, dt);
        } else {
          v.SEEDED = 0;
          v.TURB = this.approach(v.TURB, 15.0, 60, 0.5, dt);
        }
        break;

      case 'Age':
        v.AGIT_RUN = 1;
        v.AGIT = this.approach(v.AGIT, 70, 45, 0.2, dt);
        v.COOL_RAMP = 0;
        // Chilled hold at 5 °C
        v.TEMP = this.approach(v.TEMP, 5.0, 180, 0.02, dt);
        // Crystal growth plateaus at high turbidity
        v.TURB = this.approach(v.TURB, 860, 180, 1.5, dt);
        v.SEEDED = 1;
        break;

      case 'Transfer':
        v.VOL = Math.max(0, (1 - prog) * 2500);
        v.AGIT_RUN = v.VOL > 300 ? 1 : 0;
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 50, 45, 0.2, dt) : 0;
        v.TEMP = this.approach(v.TEMP, 10.0, 240, 0.02, dt);
        v.COOL_RAMP = 0;
        v.SEEDED = 1;
        break;

      case 'Clean':
        v.VOL = prog < 0.75 ? 1500 : Math.max(0, (1 - (prog - 0.75) / 0.25) * 1500);
        v.AGIT_RUN = v.VOL > 200 ? 1 : 0;
        v.AGIT = v.AGIT_RUN ? this.approach(v.AGIT, 140, 45, 0.3, dt) : 0;
        v.TEMP = prog < 0.75 ? this.approach(v.TEMP, 65.0, 180, 0.03, dt) : this.approach(v.TEMP, 25.0, 180, 0.03, dt);
        v.TURB = this.approach(v.TURB, 0, 90, 0.2, dt);
        v.COOL_RAMP = 0;
        v.SEEDED = 0;
        break;
    }

    // Maintain 3-minute sliding window to compute COOL_RATE (dTEMP/dt in °C/h)
    this.tempHistory.push({ t: this.phaseElapsedSec, temp: v.TEMP });
    if (this.tempHistory.length > 180) this.tempHistory.shift();

    if (this.tempHistory.length >= 10) {
      const oldest = this.tempHistory[0];
      const newest = this.tempHistory[this.tempHistory.length - 1];
      const dtSec = newest.t - oldest.t;
      if (dtSec > 0) {
        // dTEMP / dtSec * 3600 gives °C/hour
        v.COOL_RATE = Number((((newest.temp - oldest.temp) / dtSec) * 3600).toFixed(1));
      }
    } else {
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
    const phases = REACTOR_PHASES[this.code];
    if (forcedPhase) {
      this.currentPhase = forcedPhase;
    } else {
      const idx = phases.indexOf(this.currentPhase);
      this.currentPhase = phases[(idx + 1) % phases.length];
    }

    this.phaseElapsedSec = 0;
    this.tempHistory = [];
    const durConfig = PHASE_DURATIONS[this.code][this.currentPhase];
    this.phaseDurationSec = this.prng.rangeInt(durConfig.min, durConfig.max);

    return this.currentPhase;
  }
}