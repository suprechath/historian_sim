import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PRNG } from '../src/prng.js';
import { ReactorSimulation, REACTOR_PHASES } from '../src/stateMachine.js';

describe('ReactorSimulation State Machine', () => {
  const dummyAssetR1 = { id: 1, code: 'R1', capacity_l: 5000, role: 'Synthesis', material: 'Glass-lined steel' };
  const dummyAssetR2 = { id: 2, code: 'R2', capacity_l: 5000, role: 'Workup', material: 'Stainless steel 316L' };
  const dummyAssetR3 = { id: 3, code: 'R3', capacity_l: 3000, role: 'Crystalliser', material: 'Glass-lined steel' };

  test('initializes reactors with clean resting values', () => {
    const prng = new PRNG(100);
    const r1 = new ReactorSimulation(dummyAssetR1, prng);
    const r2 = new ReactorSimulation(dummyAssetR2, prng);
    const r3 = new ReactorSimulation(dummyAssetR3, prng);

    assert.equal(r1.currentPhase, 'Idle');
    assert.equal(r1.values.TEMP, 22.0);
    assert.equal(r1.values.VOL, 0.0);
    assert.equal(r1.values.N2_BLANKET, 1);

    assert.equal(r2.values.PH, 7.0);
    assert.equal(r2.values.DOSE_TOTAL, 0.0);

    assert.equal(r3.values.COOL_RATE, 0.0);
    assert.equal(r3.values.TURB, 0.0);
  });

  test('approach function is numerically stable with zero dt or extreme targets', () => {
    const prng = new PRNG(101);
    const r1 = new ReactorSimulation(dummyAssetR1, prng);

    // Delta sec = 0 returns current value without changes
    const unchanged = r1.approach(50, 100, 100, 0, 0);
    assert.equal(unchanged, 50);

    // Normal approach
    const stepped = r1.approach(20, 100, 50, 0, 10);
    assert.ok(stepped > 20 && stepped < 100, `Expected value between 20 and 100, got ${stepped}`);

    // Fast approach
    const converged = r1.approach(20, 100, 1, 0, 10);
    assert.ok(Math.abs(converged - 100) < 0.01);
  });

  test('transitions through R1 phases in sequence', () => {
    const prng = new PRNG(102);
    const r1 = new ReactorSimulation(dummyAssetR1, prng);
    const phases = REACTOR_PHASES.R1;

    for (let i = 1; i < phases.length; i++) {
      const next = r1.transitionNextPhase();
      assert.equal(next, phases[i], `Expected phase ${phases[i]}, got ${next}`);
    }
  });

  test('calculates R3 cooling rate derivative during Cooling ramp', () => {
    const prng = new PRNG(103);
    const r3 = new ReactorSimulation(dummyAssetR3, prng);
    r3.activeBatch = { id: 1, batch_id: 'B-2026-0001' };
    r3.values.TEMP = 72.0; // Dissolution temperature before cooling ramp
    r3.transitionNextPhase('Cooling ramp');

    // Run ticks
    for (let i = 0; i < 20; i++) {
      r3.tick(1);
    }

    assert.ok(Number.isFinite(r3.values.COOL_RATE));
    assert.ok(r3.values.COOL_RATE <= 0, `Expected negative cooling rate, got ${r3.values.COOL_RATE}`);
  });

  test('enforces physical clamping limits', () => {
    const prng = new PRNG(104);
    const r1 = new ReactorSimulation(dummyAssetR1, prng);
    r1.activeBatch = { id: 1, batch_id: 'B-2026-0001' };
    r1.transitionNextPhase('Heating');

    // Simulate overheat
    r1.tempFaultActive = true;
    for (let i = 0; i < 300; i++) {
      r1.tick(1);
    }

    assert.ok(r1.values.TEMP <= 170, `TEMP ${r1.values.TEMP} exceeded physical clamp of 170`);
    assert.ok(r1.values.JKT_TEMP <= 180, `JKT_TEMP ${r1.values.JKT_TEMP} exceeded physical clamp of 180`);
  });
});
