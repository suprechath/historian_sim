export const PHASES = [
    'Idle',
    'Charging',
    'Heating',
    'Hold',
    'Cooling',
    'Discharge',
    'Clean'
]; //

// Duration ranges in seconds per phase[cite: 1]
export const PHASE_DURATIONS = {
    Idle: { min: 30 * 60, max: 120 * 60 },
    Charging: { min: 20 * 60, max: 40 * 60 },
    Heating: { min: 45 * 60, max: 90 * 60 },
    Hold: { min: 120 * 60, max: 360 * 60 },
    Cooling: { min: 60 * 60, max: 120 * 60 },
    Discharge: { min: 20 * 60, max: 40 * 60 },
    Clean: { min: 40 * 60, max: 60 * 60 },
};

export class ReactorSimulation {
    constructor(asset, prng) {
        this.asset = asset; // { id, code, capacity_l }[cite: 1]
        this.prng = prng;

        this.currentPhase = 'Idle'; //[cite: 1]
        this.phaseElapsedSec = 0;
        this.phaseDurationSec = 1800;
        this.phaseOccurrence = 1;
        this.activeBatch = null; // { id, batch_id, started_at }[cite: 1]
        this.activeEventId = null;

        // Initial state[cite: 1]
        this.values = {
            TEMP: 20.0,
            PRES: 1.0,
            AGIT: 0.0,
            VOL: 0.0
        };

        // Quality codes: 0 = Good, 1 = Questionable, 2 = Bad, 3 = Substituted
        this.qualities = {
            TEMP: 0,
            PRES: 0,
            AGIT: 0,
            VOL: 0
        };
    }

    // Determine setpoints based on current phase[cite: 1]
    getSetpoints() {
        const cap = this.asset.capacity_l;
        switch (this.currentPhase) {
            case 'Idle':
                return { TEMP: 20.0, PRES: 1.0, AGIT: 0.0, VOL: 0.0 };
            case 'Charging':
                return { TEMP: 22.0, PRES: 1.1, AGIT: 40.0, VOL: cap * 0.82 };
            case 'Heating':
                return { TEMP: 85.0, PRES: 3.5, AGIT: 145.0, VOL: cap * 0.82 };
            case 'Hold':
                return { TEMP: 85.0, PRES: 3.4, AGIT: 145.0, VOL: cap * 0.80 };
            case 'Cooling':
                return { TEMP: 25.0, PRES: 1.2, AGIT: 60.0, VOL: cap * 0.78 };
            case 'Discharge':
                return { TEMP: 22.0, PRES: 1.0, AGIT: 30.0, VOL: 0.0 };
            case 'Clean':
                return { TEMP: 70.0, PRES: 2.0, AGIT: 180.0, VOL: cap * 0.25 };
            default:
                return { TEMP: 20.0, PRES: 1.0, AGIT: 0.0, VOL: 0.0 };
        }
    }

    // Advance simulation by deltaSeconds
    tick(deltaSeconds = 1) {
        this.phaseElapsedSec += deltaSeconds;
        const targets = this.getSetpoints();

        // First-order lag approach towards target setpoint + realistic sensor noise
        const approach = (current, target, rate, noiseStdev) => {
            const step = (target - current) * (1 - Math.exp(-deltaSeconds / rate));
            const noise = this.prng.gaussian(0, noiseStdev);
            return current + step + noise;
        };

        this.values.TEMP = approach(this.values.TEMP, targets.TEMP, 180, 0.04);
        this.values.PRES = approach(this.values.PRES, targets.PRES, 90, 0.015);
        this.values.AGIT = approach(this.values.AGIT, targets.AGIT, 30, 0.2);
        this.values.VOL = Math.max(0, approach(this.values.VOL, targets.VOL, 120, 0.1));

        // Clamp within tag physical ranges[cite: 1]
        this.values.TEMP = Math.max(0, Math.min(150, this.values.TEMP));
        this.values.PRES = Math.max(0, Math.min(10, this.values.PRES));
        this.values.AGIT = Math.max(0, Math.min(300, this.values.AGIT));
        this.values.VOL = Math.max(0, Math.min(this.asset.capacity_l, this.values.VOL));

        // Check if phase expired
        if (this.phaseElapsedSec >= this.phaseDurationSec) {
            return true; // Indicates phase transition needed
        }
        return false;
    }

    // Transition to next phase in sequence[cite: 1]
    transitionNextPhase(forcedPhase = null) {
        if (forcedPhase) {
            this.currentPhase = forcedPhase;
        } else {
            const idx = PHASES.indexOf(this.currentPhase);
            this.currentPhase = PHASES[(idx + 1) % PHASES.length];
        }

        this.phaseElapsedSec = 0;
        const durConfig = PHASE_DURATIONS[this.currentPhase];
        this.phaseDurationSec = this.prng.rangeInt(durConfig.min, durConfig.max);

        return this.currentPhase;
    }
}