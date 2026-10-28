import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
    simState,
    extractBatchStatusPayload,
    assignBatchToQueue
} from './src/services/batchQueueService.js';
import { pool } from './src/db.js';
import { logger } from './src/utils/logger.js';
import { startInternalHeartbeatWorker, stopInternalHeartbeatWorker } from './src/services/heartbeatService.js';

after(async () => {
    await pool.end();
});

// ============================================================================
// 1. BATCH STATUS WEBHOOK PAYLOAD PARSING
// ============================================================================
test('extractBatchStatusPayload extracts Started status and batchId correctly', () => {
    const payload = {
        Topic: 'batch_status.update',
        Data: {
            Batch: {
                BatchId: 'ff_261009_3_1',
                ProcessNumber: 'ff_261009_3',
                ProductSpecificationId: 'FF_test',
                ErpRecipeId: 'FF_test',
                StageSpecificationId: 'FF_test',
                BatchStatus: 'Started',
                ExecutedDate: '2026-10-09T13:57:22+00:00',
                ExecutedUser: '318, Supervisor1 CS (Supervisor)',
                ExecutedUserEmail: 'sv1@cs.com'
            }
        }
    };

    const extracted = extractBatchStatusPayload(payload);
    assert.equal(extracted.topic, 'batch_status.update');
    assert.equal(extracted.batchId, 'ff_261009_3_1');
    assert.equal(extracted.batchStatus, 'Started');
    assert.equal(extracted.isStarted, true);
});

test('extractBatchStatusPayload handles flat Batch payload', () => {
    const payload = {
        Topic: 'batch.start',
        Batch: {
            BatchId: 'B-2026-9999',
            BatchStatus: 'started'
        }
    };

    const extracted = extractBatchStatusPayload(payload);
    assert.equal(extracted.batchId, 'B-2026-9999');
    assert.equal(extracted.batchStatus, 'started');
    assert.equal(extracted.isStarted, true);
});

test('extractBatchStatusPayload returns isStarted=false for Completed and Aborted', () => {
    const completed = extractBatchStatusPayload({
        Data: { Batch: { BatchId: 'B-01', BatchStatus: 'Completed' } }
    });
    assert.equal(completed.isStarted, false);
    assert.equal(completed.batchStatus, 'Completed');

    const aborted = extractBatchStatusPayload({
        Data: { Batch: { BatchId: 'B-02', BatchStatus: 'Aborted' } }
    });
    assert.equal(aborted.isStarted, false);
    assert.equal(aborted.batchStatus, 'Aborted');
});

test('extractBatchStatusPayload handles empty or null payload gracefully', () => {
    const empty = extractBatchStatusPayload(null);
    assert.equal(empty.topic, null);
    assert.equal(empty.batchId, null);
    assert.equal(empty.batchStatus, null);
    assert.equal(empty.isStarted, false);

    const undefinedPayload = extractBatchStatusPayload({});
    assert.equal(undefinedPayload.batchId, null);
    assert.equal(undefinedPayload.isStarted, false);
});

// ============================================================================
// 2. BATCH ASSIGNMENT & QUEUE VALIDATION
// ============================================================================
test('assignBatchToQueue validates batch ID presence', async () => {
    await assert.rejects(
        async () => {
            await assignBatchToQueue({ batchId: '' });
        },
        /Batch number or identifier is required/
    );

    await assert.rejects(
        async () => {
            await assignBatchToQueue({ batchId: null });
        },
        /Batch number or identifier is required/
    );
});

test('assignBatchToQueue validates batch ID character constraints', async () => {
    await assert.rejects(
        async () => {
            await assignBatchToQueue({ batchId: 'INVALID BATCH ID WITH SPACES' });
        },
        /Batch identifier may only contain alphanumeric characters/
    );

    await assert.rejects(
        async () => {
            await assignBatchToQueue({ batchId: 'batch<script>alert(1)</script>' });
        },
        /Batch identifier may only contain alphanumeric characters/
    );
});

test('assignBatchToQueue defers start when on-demand health check is pending and fromHealthCheckClose is false', async () => {
    const origQuery = pool.query;
    pool.query = async (text, params) => {
        const queryStr = String(text).toLowerCase();
        if (queryStr.includes('from simulation_control')) {
            return { rows: [{ running: true, speed: 1, mode: 'continuous', updated_at: new Date() }] };
        }
        if (queryStr.includes('from batches where batch_id')) {
            return { rows: [] };
        }
        if (queryStr.includes('from batch_queue where batch_id')) {
            return { rows: [] };
        }
        if (queryStr.includes('from integration_health_checks')) {
            return { rows: [{ id: 'hc-api-test-01', created_at: new Date() }] };
        }
        return { rows: [] };
    };

    try {
        const result = await assignBatchToQueue({ batchId: 'B-2026-API-HC-DEFER' });
        assert.equal(result.cleanBatchId, 'B-2026-API-HC-DEFER');
        assert.equal(result.cmd, 'awaiting_health_check_close');
        assert.equal(result.initialStatus, 'awaiting_health_check');
        assert.equal(result.pendingHealthCheck, true);
        assert.equal(result.alreadyInQueue, false);
    } finally {
        pool.query = origQuery;
    }
});

test('assignBatchToQueue starts batch with status waiting_r1 when fromHealthCheckClose is true', async () => {
    const origQuery = pool.query;
    let insertedQueueRow = false;
    pool.query = async (text, params) => {
        const queryStr = String(text).toLowerCase();
        if (queryStr.includes('from simulation_control')) {
            return { rows: [{ running: true, speed: 1, mode: 'continuous', updated_at: new Date() }] };
        }
        if (queryStr.includes('from batches where batch_id')) {
            return { rows: [] };
        }
        if (queryStr.includes('from batch_queue where batch_id')) {
            return { rows: [] };
        }
        if (queryStr.includes('insert into batch_queue')) {
            insertedQueueRow = true;
            return {
                rows: [{
                    id: 201,
                    batch_id: 'B-2026-API-HC-START',
                    command: 'start_immediate',
                    status: 'waiting_r1'
                }]
            };
        }
        if (queryStr.includes('update simulation_control')) {
            return {
                rows: [{
                    running: true,
                    speed: 1,
                    mode: 'single',
                    assigned_batch_id: 'B-2026-API-HC-START',
                    single_batch_status: 'waiting_r1',
                    updated_at: new Date()
                }]
            };
        }
        return { rows: [] };
    };

    try {
        const result = await assignBatchToQueue({
            batchId: 'B-2026-API-HC-START',
            startImmediate: true,
            fromHealthCheckClose: true
        });
        assert.equal(insertedQueueRow, true);
        assert.equal(result.cleanBatchId, 'B-2026-API-HC-START');
        assert.equal(result.cmd, 'start_immediate');
        assert.equal(result.initialStatus, 'waiting_r1');
        assert.equal(result.queueEntry.id, 201);
    } finally {
        pool.query = origQuery;
    }
});

test('assignBatchToQueue avoids duplicate queue entry when batch is already in batch_queue (Condition 3.1)', async () => {
    const origQuery = pool.query;
    let attemptedInsert = false;
    pool.query = async (text, params) => {
        const queryStr = String(text).toLowerCase();
        if (queryStr.includes('from simulation_control')) {
            return { rows: [{ running: true, speed: 1, mode: 'single', updated_at: new Date() }] };
        }
        if (queryStr.includes('from batches where batch_id')) {
            return { rows: [] };
        }
        if (queryStr.includes('from batch_queue where batch_id')) {
            return {
                rows: [{
                    id: 88,
                    batch_id: 'B-2026-API-ALREADY-QUEUED',
                    command: 'start_immediate',
                    status: 'waiting_r1'
                }]
            };
        }
        if (queryStr.includes('insert into batch_queue')) {
            attemptedInsert = true;
            return { rows: [] };
        }
        return { rows: [] };
    };

    try {
        const result = await assignBatchToQueue({
            batchId: 'B-2026-API-ALREADY-QUEUED',
            startImmediate: true
        });
        assert.equal(attemptedInsert, false, 'Should avoid inserting duplicate queue entry');
        assert.equal(result.alreadyInQueue, true);
        assert.equal(result.cleanBatchId, 'B-2026-API-ALREADY-QUEUED');
        assert.equal(result.initialStatus, 'waiting_r1');
        assert.equal(result.queueEntry.id, 88);
    } finally {
        pool.query = origQuery;
    }
});

test('assignBatchToQueue avoids duplicate queue entry when batch is already in batches table (Condition 3.1)', async () => {
    const origQuery = pool.query;
    let attemptedInsert = false;
    pool.query = async (text, params) => {
        const queryStr = String(text).toLowerCase();
        if (queryStr.includes('from simulation_control')) {
            return { rows: [{ running: true, speed: 1, mode: 'single', updated_at: new Date() }] };
        }
        if (queryStr.includes('from batches where batch_id')) {
            return {
                rows: [{
                    id: 2,
                    batch_id: 'B-2026-API-ALREADY-STARTED',
                    status: 'Running',
                    started_at: new Date()
                }]
            };
        }
        if (queryStr.includes('insert into batch_queue')) {
            attemptedInsert = true;
            return { rows: [] };
        }
        return { rows: [] };
    };

    try {
        const result = await assignBatchToQueue({
            batchId: 'B-2026-API-ALREADY-STARTED',
            startImmediate: true
        });
        assert.equal(attemptedInsert, false, 'Should avoid inserting duplicate queue entry');
        assert.equal(result.alreadyInQueue, true);
        assert.equal(result.alreadyStarted, true);
        assert.equal(result.initialStatus, 'Running');
    } finally {
        pool.query = origQuery;
    }
});

// ============================================================================
// 3. SIMULATION STATE INITIALIZATION
// ============================================================================
test('simState provides initial defaults', () => {
    assert.ok(typeof simState === 'object');
    assert.equal(typeof simState.running, 'boolean');
    assert.ok(simState.speed >= 1);
    assert.ok(['continuous', 'single'].includes(simState.mode));
    assert.ok(simState.updatedAt instanceof Date);
});

// ============================================================================
// 4. STRUCTURED LOGGER BEHAVIOR
// ============================================================================
test('logger provides debug, info, warn, error methods', () => {
    assert.equal(typeof logger.debug, 'function');
    assert.equal(typeof logger.info, 'function');
    assert.equal(typeof logger.warn, 'function');
    assert.equal(typeof logger.error, 'function');

    // Verify calling methods does not throw
    assert.doesNotThrow(() => {
        logger.info('TestRunner', 'Unit test running logger verification', { test: true });
        logger.debug('TestRunner', 'Debug level message');
        logger.warn('TestRunner', 'Warn level message');
        logger.error('TestRunner', 'Error level message', { code: 500 });
    });
});

// ============================================================================
// 5. INTERNAL 24/7 HEARTBEAT WORKER LIFECYCLE
// ============================================================================
test('startInternalHeartbeatWorker and stopInternalHeartbeatWorker manage worker lifecycle cleanly', () => {
    assert.doesNotThrow(() => {
        startInternalHeartbeatWorker();
        startInternalHeartbeatWorker();
        stopInternalHeartbeatWorker();
        stopInternalHeartbeatWorker();
    });
});
