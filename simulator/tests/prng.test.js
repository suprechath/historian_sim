import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PRNG } from '../src/prng.js';

describe('PRNG (Mulberry32 & Box-Muller)', () => {
  test('generates repeatable sequence with identical seed', () => {
    const rng1 = new PRNG(12345);
    const rng2 = new PRNG(12345);

    for (let i = 0; i < 50; i++) {
      assert.equal(rng1.next(), rng2.next());
    }
  });

  test('range produces numbers within specified interval', () => {
    const rng = new PRNG(42);
    for (let i = 0; i < 100; i++) {
      const val = rng.range(10.5, 25.5);
      assert.ok(val >= 10.5 && val <= 25.5, `Value ${val} out of range [10.5, 25.5]`);
    }
  });

  test('rangeInt produces integers within specified interval', () => {
    const rng = new PRNG(99);
    for (let i = 0; i < 100; i++) {
      const val = rng.rangeInt(5, 10);
      assert.ok(Number.isInteger(val), 'Value should be an integer');
      assert.ok(val >= 5 && val <= 10, `Value ${val} out of range [5, 10]`);
    }
  });

  test('gaussian produces values roughly centered around mean', () => {
    const rng = new PRNG(2026);
    let sum = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) {
      sum += rng.gaussian(50, 5);
    }
    const sampleMean = sum / n;
    assert.ok(Math.abs(sampleMean - 50) < 1.0, `Sample mean ${sampleMean} too far from 50`);
  });
});
