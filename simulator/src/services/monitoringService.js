import { query } from '../db.js';
import { logger } from '../logger.js';

export class MonitoringService {
  constructor() {
    this.checkCounter = 0;
  }

  /**
   * Check and dispatch outbound monitoring jobs every 5 ticks.
   */
  async tick(now) {
    this.checkCounter++;
    if (this.checkCounter < 5) return;
    this.checkCounter = 0;

    try {
      const { rows: dueJobs } = await query(
        `SELECT j.id, j.batch_pk, j.sequence, j.interval_sec, j.kind, j.end_at, j.max_samples,
                b.batch_id,
                array_agg(mjt.tag_id) as tag_ids
         FROM monitoring_jobs j
         JOIN batches b ON j.batch_pk = b.id
         JOIN monitoring_job_tags mjt ON j.id = mjt.job_id
         WHERE j.state = 'active' AND j.next_fire_at <= $1
         GROUP BY j.id, b.batch_id`,
        [now]
      );

      for (const job of dueJobs) {
        await this._dispatchJob(job, now);
      }
    } catch (err) {
      logger.error(`Error processing outbound monitoring jobs: ${err.message}`, 'MonitoringService');
    }
  }

  async _dispatchJob(job, now) {
    try {
      const nextSeq = job.sequence + 1;

      const { rows: sRows } = await query(
        `SELECT t.name, s.value, s.quality, s.ts
         FROM snapshots s
         JOIN tags t ON s.tag_id = t.id
         WHERE s.tag_id = ANY($1::int[])`,
        [job.tag_ids]
      );

      const payload = {
        jobId: job.id,
        batchId: job.batch_id,
        sequence: nextSeq,
        scheduledAt: now.toISOString(),
        sampledAt: now.toISOString(),
        samples: sRows.map((r) => ({ tag: r.name, value: r.value, quality: r.quality })),
      };

      await query(
        `INSERT INTO monitoring_outbox (job_id, sequence, scheduled_at, sampled_at, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [job.id, nextSeq, now, now, JSON.stringify(payload)]
      );

      const isExpired =
        (job.kind === 'fixed' && job.end_at && now >= new Date(job.end_at)) ||
        (job.max_samples && nextSeq >= job.max_samples);

      const nextState = isExpired ? 'completed' : 'active';
      await query(
        `UPDATE monitoring_jobs
         SET sequence = $1,
             state = $2,
             next_fire_at = next_fire_at + ($3 * INTERVAL '1 second'),
             completed_at = CASE WHEN $2 = 'completed' THEN $4 ELSE completed_at END
         WHERE id = $5`,
        [nextSeq, nextState, job.interval_sec, now, job.id]
      );

      logger.debug(`Dispatched monitoring job ${job.id} (sequence #${nextSeq})`, 'MonitoringService');
    } catch (err) {
      logger.error(`Failed to dispatch monitoring job ${job.id}: ${err.message}`, 'MonitoringService');
    }
  }
}
