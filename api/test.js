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
import {
    getScheduledInstructions,
    getScheduledInstructionsSummary,
    getScheduledInstructionById,
    cancelScheduledInstruction,
    triggerScheduledInstructionNow
} from './src/services/scheduledInstructionsService.js';

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

// ============================================================================
// 6. SCHEDULED INSTRUCTIONS SERVICE (QUEUE & ABSENT STATUS LOGIC)
// ============================================================================
test('getScheduledInstructions defaults to status=pending and filters completed/cancelled tasks out', async () => {
    const origQuery = pool.query;
    let executedSql = '';
    let executedParams = [];

    pool.query = async (text, params) => {
        executedSql = String(text);
        executedParams = params || [];
        if (executedSql.toLowerCase().includes('count(*)::int as total')) {
            return { rows: [{ total: 2 }] };
        }
        return {
            rows: [
                {
                    id: '11111111-1111-1111-1111-111111111111',
                    case_type: 2,
                    batch_id: 'VV_261029_2_1',
                    ref_instruction: 'CGET',
                    status: 'pending',
                    scheduled_time: new Date()
                },
                {
                    id: '22222222-2222-2222-2222-222222222222',
                    case_type: 4,
                    batch_id: 'VV_261029_2_1',
                    ref_instruction: 'CGST',
                    status: 'pending',
                    scheduled_time: new Date()
                }
            ]
        };
    };

    try {
        const result = await getScheduledInstructions();
        assert.equal(result.totalMatching, 2);
        assert.equal(result.tasks.length, 2);
        assert.ok(executedSql.includes('s.status = $1'));
        assert.equal(executedParams[0], 'pending');
        assert.ok(executedSql.includes('ORDER BY s.scheduled_time ASC'));
    } finally {
        pool.query = origQuery;
    }
});

test('getScheduledInstructions handles status=all and filters by caseType and search', async () => {
    const origQuery = pool.query;
    let executedSql = '';
    let executedParams = [];

    pool.query = async (text, params) => {
        executedSql = String(text);
        executedParams = params || [];
        if (executedSql.toLowerCase().includes('count(*)::int as total')) {
            return { rows: [{ total: 1 }] };
        }
        return {
            rows: [
                {
                    id: '33333333-3333-3333-3333-333333333333',
                    case_type: 3,
                    batch_id: 'VV_261029_2_1',
                    ref_instruction: 'RECPRESS',
                    status: 'cancelled',
                    last_error: 'Explicitly cancelled'
                }
            ]
        };
    };

    try {
        const result = await getScheduledInstructions({
            status: 'all',
            caseType: 3,
            search: 'RECPRESS'
        });
        assert.equal(result.totalMatching, 1);
        assert.equal(result.tasks.length, 1);
        assert.ok(executedSql.includes('s.case_type = $1'));
        assert.equal(executedParams[0], 3);
        assert.ok(executedSql.includes('ILIKE $2'));
        assert.equal(executedParams[1], '%RECPRESS%');
    } finally {
        pool.query = origQuery;
    }
});

test('getScheduledInstructionsSummary aggregates counts accurately', async () => {
    const origQuery = pool.query;

    pool.query = async (text, params) => {
        return {
            rows: [
                {
                    pending_count: 5,
                    processing_count: 1,
                    completed_24h: 12,
                    failed_24h: 0,
                    cancelled_24h: 2,
                    total_all_time: 20,
                    earliest_pending_time: new Date('2026-10-29T16:00:00Z')
                }
            ]
        };
    };

    try {
        const summary = await getScheduledInstructionsSummary();
        assert.equal(summary.pendingCount, 5);
        assert.equal(summary.processingCount, 1);
        assert.equal(summary.completed24hCount, 12);
        assert.equal(summary.cancelled24hCount, 2);
        assert.equal(summary.totalAllTime, 20);
        assert.ok(summary.earliestPendingTime);
    } finally {
        pool.query = origQuery;
    }
});

test('cancelScheduledInstruction cancels pending task and rejects already completed task', async () => {
    const origQuery = pool.query;

    // Test 1: Rejects if status is not 'pending'
    pool.query = async (text, params) => {
        return {
            rows: [
                {
                    id: 'task-completed-01',
                    status: 'completed',
                    batch_id: 'VV_261029_2_1'
                }
            ]
        };
    };

    try {
        await assert.rejects(
            async () => {
                await cancelScheduledInstruction('task-completed-01');
            },
            /only 'pending' tasks can be cancelled/
        );
    } finally {
        pool.query = origQuery;
    }

    // Test 2: Successfully cancels if status is 'pending'
    let cancelled = false;
    pool.query = async (text, params) => {
        const sql = String(text);
        if (sql.includes('SELECT') && sql.includes('FROM scheduled_instructions')) {
            return {
                rows: [
                    {
                        id: 'task-pending-01',
                        status: 'pending',
                        batch_id: 'VV_261029_2_1',
                        ref_instruction: 'CGET'
                    }
                ]
            };
        }
        if (sql.includes('UPDATE scheduled_instructions') && sql.includes("status = 'cancelled'")) {
            cancelled = true;
            return {
                rows: [
                    {
                        id: 'task-pending-01',
                        status: 'cancelled',
                        last_error: 'Cancelled by operator via UI'
                    }
                ]
            };
        }
        return { rows: [] };
    };

    try {
        const res = await cancelScheduledInstruction('task-pending-01', 'Operator cancelled');
        assert.equal(cancelled, true);
        assert.equal(res.status, 'cancelled');
    } finally {
        pool.query = origQuery;
    }
});

test('triggerScheduledInstructionNow sets scheduled_time to NOW for pending task', async () => {
    const origQuery = pool.query;
    let triggered = false;

    pool.query = async (text, params) => {
        const sql = String(text);
        if (sql.includes('SELECT') && sql.includes('FROM scheduled_instructions')) {
            return {
                rows: [
                    {
                        id: 'task-pending-02',
                        status: 'pending',
                        batch_id: 'VV_261029_2_1',
                        ref_instruction: 'HTST'
                    }
                ]
            };
        }
        if (sql.includes('UPDATE scheduled_instructions') && sql.includes('scheduled_time = NOW()')) {
            triggered = true;
            return {
                rows: [
                    {
                        id: 'task-pending-02',
                        status: 'pending',
                        last_error: 'Triggered immediately by operator'
                    }
                ]
            };
        }
        return { rows: [] };
    };

    try {
        const res = await triggerScheduledInstructionNow('task-pending-02');
        assert.equal(triggered, true);
        assert.equal(res.id, 'task-pending-02');
    } finally {
        pool.query = origQuery;
    }
});
