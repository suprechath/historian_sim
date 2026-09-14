import { query } from './db.js';

export function startJobsWorker() {
    setInterval(async () => {
        try {
            // 1. Fetch active push jobs due for execution
            const { rows: jobs } = await query(`
        SELECT 
          j.id, j.batch_pk, j.asset_id, j.interval_sec, j.kind,
          j.end_at, j.max_samples, j.next_fire_at, j.sequence,
          j.callback_ref, b.batch_id, a.code AS asset_code
        FROM monitoring_jobs j
        JOIN batches b ON j.batch_pk = b.id
        JOIN assets a ON j.asset_id = a.id
        WHERE j.state = 'active' AND j.next_fire_at <= NOW()
        LIMIT 10;
      `);

            for (const job of jobs) {
                const now = new Date();

                // 2. Check expiry condition
                const isExpired = (job.end_at && now >= new Date(job.end_at)) ||
                    (job.max_samples && job.sequence >= job.max_samples);

                if (isExpired) {
                    await query(`
                        UPDATE monitoring_jobs 
                        SET state = 'completed', completed_at = NOW() 
                        WHERE id = $1;
                    `, [job.id]);
                    continue;
                }

                // 3. Collect tag readings for assigned job tags
                const { rows: tagData } = await query(`
                    SELECT t.name, t.parameter, s.value, s.quality, s.ts
                    FROM monitoring_job_tags mjt
                    JOIN tags t ON mjt.tag_id = t.id
                    JOIN snapshots s ON s.tag_id = t.id
                    WHERE mjt.job_id = $1;
                `, [job.id]);

                const nextSeq = job.sequence + 1;
                const payload = {
                    jobId: job.id,
                    batchId: job.batch_id,
                    reactor: job.asset_code,
                    sequence: nextSeq,
                    scheduledAt: job.next_fire_at,
                    sampledAt: now,
                    data: tagData
                };

                // 4. Dispatch HTTP POST webhook
                let httpStatus = null;
                let errorMessage = null;
                let deliveredAt = null;

                try {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 4000);
                    const res = await fetch(job.callback_ref, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                        signal: controller.signal
                    });
                    clearTimeout(timeout);
                    httpStatus = res.status;
                    deliveredAt = new Date();
                } catch (err) {
                    errorMessage = err.message;
                }

                // 5. Append to monitoring_outbox audit trail
                await query(`
          INSERT INTO monitoring_outbox
          (job_id, sequence, scheduled_at, sampled_at, payload, attempts, last_status, last_error, delivered_at)
          VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8);
        `, [
                    job.id, nextSeq, job.next_fire_at, now, JSON.stringify(payload),
                    httpStatus, errorMessage, deliveredAt
                ]);

                // 6. Advance schedule
                const nextFire = new Date(now.getTime() + job.interval_sec * 1000);
                await query(`
          UPDATE monitoring_jobs
          SET sequence = $1, next_fire_at = $2
          WHERE id = $3;
        `, [nextSeq, nextFire, job.id]);
            }
        } catch (err) {
            console.error('Monitoring job worker error:', err.message);
        }
    }, 3000);
}