import { logger } from '../utils/logger.js';
import { cancelScheduledInstructionsForBatch } from '../dal/externalDal.js';

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

    async stopAllForBatch(batchId) {
        if (!batchId) return 0;
        const clean = String(batchId).trim();
        let stoppedCount = 0;
        for (const [key, job] of Array.from(this.jobs.entries())) {
            if (job.batchId === clean || key.startsWith(`${clean}_`)) {
                await this.stopJob(key);
                stoppedCount++;
            }
        }

        try {
            const dbCancelled = await cancelScheduledInstructionsForBatch(clean);
            if (dbCancelled > 0) {
                logger.info('JobRegistry', `Cancelled ${dbCancelled} persistent scheduled instruction(s) in PostgreSQL for batch ${clean}`);
            }
        } catch (dbErr) {
            logger.warn('JobRegistry', `Error cancelling scheduled instructions for batch ${clean}:`, dbErr.message);
        }

        if (stoppedCount > 0) {
            logger.info('JobRegistry', `Stopped ${stoppedCount} active background interval job(s) for batch ${clean}`);
        }
        return stoppedCount;
    }
}

export const jobRegistry = new JobRegistry();
export const activeFutureIntervalJobs = jobRegistry;
