/**
 * High-performance deterministic Pseudo-Random Number Generator (Mulberry32).
 * Includes Box-Muller Gaussian transformation for realistic sensor micro-noise.
 */
export class PRNG {
  constructor(seed = 20260908) {
    this.s = Math.floor(Number(seed) || 20260908);
  }

  // Uniform float in [0, 1)
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Uniform float in [min, max]
  range(min, max) {
    if (min >= max) return min;
    return min + this.next() * (max - min);
  }

  // Uniform integer in [min, max] inclusive
  rangeInt(min, max) {
    if (min >= max) return Math.floor(min);
    return Math.floor(this.range(min, max + 1));
  }

  // Gaussian/Normal distribution (Box-Muller transform)
  gaussian(mean = 0, stdev = 1) {
    const u = Math.max(1e-15, 1 - this.next());
    const v = this.next();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return z * stdev + mean;
  }
}