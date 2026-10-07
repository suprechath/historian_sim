import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveService } from '../src/services/archiveService.js';

describe('ArchiveService Buffer Management', () => {
  test('stages readings into in-memory queue', () => {
    const archive = new ArchiveService();
    assert.equal(archive.getPendingBufferSize(), 0);

    archive.stageReading(1, new Date().toISOString(), 45.2, 0);
    archive.stageReading(2, new Date().toISOString(), 1.25, 0);

    assert.equal(archive.getPendingBufferSize(), 2);
  });

  test('guards against unbounded memory growth', () => {
    const archive = new ArchiveService();
    archive.maxBufferSize = 100; // Small limit for test

    for (let i = 0; i < 150; i++) {
      archive.stageReading(1, new Date().toISOString(), i, 0);
    }

    assert.ok(archive.getPendingBufferSize() <= 100, `Buffer size exceeded max limit: ${archive.getPendingBufferSize()}`);
  });
});
