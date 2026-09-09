export class PRNG {
    constructor(seed = 20260908) {
        this.s = Math.floor(seed);
    }

    // Uniform float [0, 1)
    next() {
        let t = (this.s += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    // Uniform float in [min, max]
    range(min, max) {
        return min + this.next() * (max - min);
    }

    // Uniform integer in [min, max]
    rangeInt(min, max) {
        return Math.floor(this.range(min, max + 1));
    }

    // Gaussian/Normal distribution (Box-Muller transform)
    gaussian(mean = 0, stdev = 1) {
        let u = 1 - this.next();
        let v = this.next();
        let z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        return z * stdev + mean;
    }
}