import { query } from '../db.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

export class ArchiveService {
  constructor() {
    this.archiveIntervalSec = config.archiveIntervalSec;
    this.maxBufferSize = config.maxArchiveBufferSize;
    this.archiveBuffer = [];
    this.secondsSinceLastArchive = 0;
  }

  /**
   * Stage a reading for the archive buffer.
   */
  stageReading(tagId, ts, val, quality) {
    if (this.archiveBuffer.length >= this.maxBufferSize) {
      logger.warn(`Archive buffer reached maximum capacity (${this.maxBufferSize}). Dropping oldest readings to prevent OOM.`, 'ArchiveService');
      this.archiveBuffer.splice(0, 1000);
    }

    this.archiveBuffer.push({ tagId, ts, val, quality });
  }

  /**
   * Bulk UPSERT current values into snapshots table.
   */
  async updateSnapshots(snapshotRecords) {
    if (!snapshotRecords || snapshotRecords.length === 0) return;

    const tagIds = snapshotRecords.map((r) => r.tagId);
    const times = snapshotRecords.map((r) => r.ts);
    const vals = snapshotRecords.map((r) => r.val);
    const qualities = snapshotRecords.map((r) => r.quality);

    try {
      await query(
        `INSERT INTO snapshots (tag_id, ts, value, quality)
         SELECT * FROM UNNEST($1::int[], $2::timestamptz[], $3::float8[], $4::smallint[])
         ON CONFLICT (tag_id) DO UPDATE 
         SET ts = EXCLUDED.ts, value = EXCLUDED.value, quality = EXCLUDED.quality`,
        [tagIds, times, vals, qualities]
      );
    } catch (err) {
      logger.error(`Error updating snapshots cache: ${err.message}`, 'ArchiveService');
    }
  }

  /**
   * Advance timer and flush to readings hypertable if interval reached.
   */
  async tickArchive() {
    this.secondsSinceLastArchive += 1;
    if (this.secondsSinceLastArchive >= this.archiveIntervalSec) {
      await this.flushArchive();
      this.secondsSinceLastArchive = 0;
    }
  }

  /**
   * Flush in-memory buffer to readings table.
   */
  async flushArchive() {
    if (this.archiveBuffer.length === 0) return;

    const toFlush = this.archiveBuffer;
    this.archiveBuffer = [];

    const bTag = toFlush.map((b) => b.tagId);
    const bTs = toFlush.map((b) => b.ts);
    const bVal = toFlush.map((b) => b.val);
    const bQ = toFlush.map((b) => b.quality);

    try {
      await query(
        `INSERT INTO readings (tag_id, ts, value, quality)
         SELECT * FROM UNNEST($1::int[], $2::timestamptz[], $3::float8[], $4::smallint[])
         ON CONFLICT (tag_id, ts) DO NOTHING`,
        [bTag, bTs, bVal, bQ]
      );
      logger.debug(`Persisted ${toFlush.length} readings to archive.`, 'ArchiveService');
    } catch (err) {
      logger.error(`Error writing archive batch: ${err.message}`, 'ArchiveService');
      // Re-queue unwritten items at head if within capacity limits
      if (this.archiveBuffer.length + toFlush.length <= this.maxBufferSize) {
        this.archiveBuffer = toFlush.concat(this.archiveBuffer);
      }
    }
  }

  /**
   * Drain any remaining buffered readings before graceful shutdown.
   */
  async drain() {
    if (this.archiveBuffer.length > 0) {
      logger.info(`Draining ${this.archiveBuffer.length} remaining buffered readings before shutdown...`, 'ArchiveService');
      await this.flushArchive();
    }
  }

  getPendingBufferSize() {
    return this.archiveBuffer.length;
  }
}
