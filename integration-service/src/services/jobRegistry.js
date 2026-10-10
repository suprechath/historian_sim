import { logger } from '../utils/logger.js';

/**
 * Registry to manage active background future/continuous interval jobs.
 * Supports thread-safe lifecycle control, cancellation, and graceful shutdown.
 */
class JobRegistry {
    constructor() {
        this.jobs = new Map();
    }

    set(jobKey, jobRecord) {
        this.jobs.set(jobKey, jobRecord);
    }

    get(jobKey) {
        return this.jobs.get(jobKey);
    }

    has(jobKey) {
        return this.jobs.has(jobKey);
    }

    delete(jobKey) {
        return this.jobs.delete(jobKey);
    }

    entries() {
        return this.jobs.entries();
    }

    find(predicate) {
        for (const [key, job] of this.jobs.entries()) {
            if (predicate(job, key)) {
                return { key, job };
            }
        }
        return null;
    }

    async stopJob(jobKey) {
        if (!this.jobs.has(jobKey)) return false;
        const job = this.jobs.get(jobKey);
        logger.info('JobRegistry', `Stopping active job ${jobKey}`);

        try {
            if (typeof job.stop === 'function') {
                await job.stop();
            } else if (typeof job.cleanup === 'function') {
                job.cleanup();
            } else {
                if (job.startTimeoutId) clearTimeout(job.startTimeoutId);
                if (job.intervalId) clearInterval(job.intervalId);
                if (job.endTimeoutId) clearTimeout(job.endTimeoutId);
            }
        } catch (err) {
            logger.warn('JobRegistry', `Error while stopping job ${jobKey}:`, err.message);
        }

        this.jobs.delete(jobKey);
        return true;
    }

    async stopAllJobs() {
        const total = this.jobs.size;
        if (total === 0) return;
        logger.info('JobRegistry', `Stopping all ${total} active background interval jobs...`);
        for (const key of Array.from(this.jobs.keys())) {
            await this.stopJob(key);
        }
        logger.info('JobRegistry', 'All background interval jobs stopped.');
    }
}

export const jobRegistry = new JobRegistry();
export const activeFutureIntervalJobs = jobRegistry;
