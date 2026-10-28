import test from 'node:test';
import assert from 'node:assert/strict';

import {
    formatReadingValue,
    formatBatchLineDate,
    formatExecutedTimestamp,
    parseBatchLineDate,
    cleanInstructionId,
    extractTextValue,
    cleanPayloadField
} from './src/utils/formatters.js';

import {
    extractTimeTriggers,
    extractExceptionTriggers,
    extractRecordDurationMs,
    extractInterpretMapping,
    mapInstructionKey,
    parseIntervalString,
    parseDurationString,
    parseRecordInstructionConfig,
    parsePrintLabelPayload,
    extractInstructionPayload,
    hasHealthCheckTrigger,
    hasPrevBatchTrigger
} from './src/utils/instructionParsers.js';
import { handleOnDemandHealthCheck } from './src/services/healthCheckService.js';
import { handlePreviousBatchInstruction } from './src/services/previousBatchService.js';
import { handleInstructionWebhook, handleStatusPost } from './src/controllers/externalController.js';
import externalRouter from './src/routes/external.js';

import {
    resolveMetric,
    computeMetricValue,
    resolveWaveDirections,
    buildIntervalConsolidatedValues
} from './src/services/mathService.js';
import { handleRecordMode } from './src/services/case3Service.js';

import { getHighExceptionDedupeKey } from './src/services/highExceptionService.js';
import { jobRegistry } from './src/services/jobRegistry.js';
import { extractBatchStatusPayload, isProductSpecExcluded, assignBatchToQueue } from './src/services/batchQueueService.js';
import { auditLog } from './src/middleware/auditLog.js';
import { requireApiKey } from './src/middleware/requireApiKey.js';
import {
    createMockResponse,
    ensureTemplateTables,
    instantiatePredefinedBatchInstructions,
    getPredefinedTemplates,
    upsertPredefinedTemplate
} from './src/services/instructionTemplateService.js';

// ============================================================================
// 1. FORMATTERS & DATE PARSING TESTS
// ============================================================================
test('formatReadingValue handles precision and rounding', () => {
    assert.equal(formatReadingValue(null, 2), '0');
    assert.equal(formatReadingValue(undefined, 2), '0');
    assert.equal(formatReadingValue(45.678, 2), '45.68');
    assert.equal(formatReadingValue(45.678, 1), '45.7');
    assert.equal(formatReadingValue(45.678, 0), '46');
    assert.equal(formatReadingValue(45.4, null), '45');
    assert.equal(formatReadingValue('raw_str', 2), 'raw_str');
});

test('formatBatchLineDate and formatExecutedTimestamp format UTC correctly', () => {
    const fixedDate = new Date('2026-03-27T15:07:22.000Z');
    const blDate = formatBatchLineDate(fixedDate);
    assert.equal(blDate, 'Mar 27, 2026 15:07:22');

    const execTs = formatExecutedTimestamp(fixedDate);
    assert.equal(execTs, '2026-03-27T15:07:22+00:00');

    assert.equal(formatBatchLineDate(null), null);
    assert.equal(formatExecutedTimestamp(null), null);
});

test('parseBatchLineDate handles various formats', () => {
    assert.equal(parseBatchLineDate('skip instruction'), null);
    assert.equal(parseBatchLineDate('null'), null);
    assert.equal(parseBatchLineDate(''), null);

    const utcWrapped = parseBatchLineDate('UTC(2026-03-27 15:07:22)');
    assert.ok(utcWrapped instanceof Date);
    assert.equal(utcWrapped.toISOString(), '2026-03-27T15:07:22.000Z');

    const isoDate = parseBatchLineDate('2026-03-27T15:07:22.000Z');
    assert.ok(isoDate instanceof Date);
    assert.equal(isoDate.getTime(), new Date('2026-03-27T15:07:22.000Z').getTime());
});

test('cleanInstructionId strips brackets and uppercases', () => {
    assert.equal(cleanInstructionId('[STEP_1]'), 'STEP_1');
    assert.equal(cleanInstructionId('[[INST_42]]'), 'INST_42');
    assert.equal(cleanInstructionId('inst_42'), 'INST_42');
    assert.equal(cleanInstructionId(''), '');
});

test('extractTextValue handles scalars and arrays', () => {
    assert.equal(extractTextValue(null), '');
    assert.equal(extractTextValue(100), '100');
    assert.equal(extractTextValue(['50', null, '150']), '50, 150');
    assert.equal(extractTextValue(['']), '');
});

test('cleanPayloadField filters empty/null strings', () => {
    assert.equal(cleanPayloadField('null'), null);
    assert.equal(cleanPayloadField('  undefined  '), null);
    assert.equal(cleanPayloadField(''), null);
    assert.equal(cleanPayloadField('Valid Value'), 'Valid Value');
});

// ============================================================================
// 2. INSTRUCTION PARSING & REGEX UTILITIES TESTS
// ============================================================================
test('extractTimeTriggers extracts targets and values', () => {
    const text = 'Take reading when [TIME: VALUE=130] and [TIME: VALUE=140]';
    const triggers = extractTimeTriggers(text);
    assert.equal(triggers.length, 2);
    assert.equal(triggers[0].targetValue, 130);
    assert.equal(triggers[1].targetValue, 140);
});

test('extractExceptionTriggers extracts exception directives', () => {
    const text = 'Log deviations: [EXCEPTION: REF=EX_1, PHASE=Reaction, TAG=R1.TEMP]';
    const triggers = extractExceptionTriggers(text);
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].targetRef, 'EX_1');
    assert.equal(triggers[0].filterPhase, 'Reaction');
    assert.equal(triggers[0].filterTag, 'R1.TEMP');
});

test('extractRecordDurationMs parses duration units', () => {
    assert.equal(extractRecordDurationMs('Wait [RECORD: DURATION=5m]'), 300000);
    assert.equal(extractRecordDurationMs('Wait [DURATION=30s]'), 30000);
    assert.equal(extractRecordDurationMs('Wait [RECORD: DURATION=1h]'), 3600000);
    assert.equal(extractRecordDurationMs('Wait [RECORD: DURATION=200m]'), 200 * 60 * 1000);
    assert.equal(extractRecordDurationMs('No duration specified'), 0);
});

test('extractInterpretMapping maps custom labels', () => {
    const text = 'State reading: [INTERPRET: 1="Running", 0="Stopped"]';
    const mapping = extractInterpretMapping(text);
    assert.ok(mapping);
    assert.equal(mapping.interpret(1), 'Running');
    assert.equal(mapping.interpret(0), 'Stopped');
    assert.equal(mapping.interpret('1'), 'Running');
    assert.equal(mapping.interpret('0'), 'Stopped');
    assert.equal(mapping.interpret(null), 'Stopped');
});

test('mapInstructionKey maps print label instruction parameter keys', () => {
    assert.equal(mapInstructionKey('[PARM_TAG]'), 'RefElement');
    assert.equal(mapInstructionKey('[REF_INST]'), 'RefInstruction');
    assert.equal(mapInstructionKey('[AGG_AVG]'), 'RefType');
    assert.equal(mapInstructionKey('[STH_60]'), 'START');
    assert.equal(mapInstructionKey('[ETH_80]'), 'STOP');
    assert.equal(mapInstructionKey('[INV_1m]'), 'INTERVAL');
    assert.equal(mapInstructionKey('[DUR_10m]'), 'DURATION');
    assert.equal(mapInstructionKey('[DIR_RISE]'), 'DIRECTION');
    assert.equal(mapInstructionKey('[ST_TIME]'), 'RefStartTime');
    assert.equal(mapInstructionKey('[ET_TIME]'), 'RefEndTime');
});

test('parseIntervalString and parseDurationString handle time units', () => {
    const intervalS = parseIntervalString('30s');
    assert.equal(intervalS.intervalMs, 30000);
    assert.equal(intervalS.intervalMinutes, 0.5);

    const intervalM = parseIntervalString('5m');
    assert.equal(intervalM.intervalMs, 300000);
    assert.equal(intervalM.intervalMinutes, 5);

    const durH = parseDurationString('2h');
    assert.equal(durH, 120);

    assert.equal(parseIntervalString('invalid'), null);
    assert.equal(parseDurationString('skip instruction'), null);
});

test('parseRecordInstructionConfig discriminates SENTINEL, PROFILE, RECORD, and AGGREGATE modes', () => {
    // 1. Sentinel mode (continuous open-ended collection)
    const sentinelText = 'Log values continuously [RECORD: INTERVAL=1m SENTINEL]';
    const sentinelConf = parseRecordInstructionConfig(sentinelText, 'avg');
    assert.equal(sentinelConf.isRecord, true);
    assert.equal(sentinelConf.mode, 'SENTINEL');
    assert.equal(sentinelConf.isSentinel, true);
    assert.equal(sentinelConf.intervalConfig.intervalMs, 60000);

    // 2. Sentinel mode with START threshold
    const sentinelWithStart = 'Log values on trigger [RECORD: START=50 DIRECTION=Rise INTERVAL=30s SENTINEL]';
    const sentinelStartConf = parseRecordInstructionConfig(sentinelWithStart, 'avg');
    assert.equal(sentinelStartConf.mode, 'SENTINEL');
    assert.equal(sentinelStartConf.profileConfig.start, 50);
    assert.equal(sentinelStartConf.profileConfig.direction, 'rise');

    // 2b. Sentinel mode with full START, STOP, DIRECTION, INTERVAL, and DURATION
    const sentinelFull = '[RECORD: START=140, STOP=140, DIRECTION=Rise, INTERVAL=4m, DURATION=200m] SENTINEL';
    const sentinelFullConf = parseRecordInstructionConfig(sentinelFull, 'avg');
    assert.equal(sentinelFullConf.mode, 'SENTINEL');
    assert.equal(sentinelFullConf.isSentinel, true);
    assert.equal(sentinelFullConf.profileConfig.start, 140);
    assert.equal(sentinelFullConf.profileConfig.stop, 140);
    assert.equal(sentinelFullConf.profileConfig.direction, 'rise');
    assert.equal(sentinelFullConf.profileConfig.durationMinutes, 200);
    assert.equal(sentinelFullConf.intervalConfig.intervalMs, 240000);

    // 3. Profile mode with START, STOP, DURATION, DIRECTION, INTERVAL (non-sentinel)
    const profileText = 'Capture cycle [RECORD: START=40 STOP=80 DURATION=15m DIRECTION=Rise INTERVAL=30s]';
    const profileConf = parseRecordInstructionConfig(profileText, 'max');
    assert.equal(profileConf.isRecord, true);
    assert.equal(profileConf.mode, 'PROFILE');
    assert.equal(profileConf.profileConfig.start, 40);
    assert.equal(profileConf.profileConfig.stop, 80);
    assert.equal(profileConf.profileConfig.durationMinutes, 15);
    assert.equal(profileConf.profileConfig.direction, 'rise');
    assert.equal(profileConf.profileConfig.metric, 'max');
    assert.equal(profileConf.intervalConfig.intervalMs, 30000);
    assert.equal(profileConf.isSentinel, false);

    // 4. Uniform Record mode without START and without SENTINEL
    const uniformText = 'Log values [RECORD: INTERVAL=2m]';
    const uniformConf = parseRecordInstructionConfig(uniformText, 'avg');
    assert.equal(uniformConf.isRecord, true);
    assert.equal(uniformConf.mode, 'RECORD');
    assert.equal(uniformConf.isSentinel, false);
    assert.equal(uniformConf.intervalConfig.intervalMs, 120000);

    // 5. Aggregate mode without [RECORD] block
    const aggText = 'Standard temperature observation step';
    const aggConf = parseRecordInstructionConfig(aggText, 'avg');
    assert.equal(aggConf.isRecord, false);
    assert.equal(aggConf.mode, 'AGGREGATE');
    assert.equal(aggConf.profileConfig, null);
});

// ============================================================================
// 3. MATHEMATICAL & STATISTICAL AGGREGATION TESTS
// ============================================================================
test('resolveMetric identifies valid metrics', () => {
    assert.equal(resolveMetric('MIN'), 'min');
    assert.equal(resolveMetric('MAX'), 'max');
    assert.equal(resolveMetric('SUM'), 'sum');
    assert.equal(resolveMetric('FIRST'), 'first');
    assert.equal(resolveMetric('LAST'), 'last');
    assert.equal(resolveMetric('AVERAGE'), 'avg');
    assert.equal(resolveMetric(null), 'avg');
});

test('computeMetricValue computes correct statistical aggregates', () => {
    const vals = [10, 20, 30, 40, 50];
    assert.equal(computeMetricValue(vals, 'min'), 10);
    assert.equal(computeMetricValue(vals, 'max'), 50);
    assert.equal(computeMetricValue(vals, 'sum'), 150);
    assert.equal(computeMetricValue(vals, 'avg'), 30);
    assert.equal(computeMetricValue(vals, 'first'), 10);
    assert.equal(computeMetricValue(vals, 'last'), 50);
});

test('resolveWaveDirections calculates rise, fall, and envelope waves', () => {
    // Upward ramp
    const rampUp = resolveWaveDirections(20, 80);
    assert.equal(rampUp.startDirection, 'rise');
    assert.equal(rampUp.stopDirection, 'rise');
    assert.equal(rampUp.isEnvelope, false);

    // Pulse/Peak envelope returning across start threshold
    const peakEnvelope = resolveWaveDirections(50, 50);
    assert.equal(peakEnvelope.startDirection, 'rise');
    assert.equal(peakEnvelope.stopDirection, 'fall');
    assert.equal(peakEnvelope.isEnvelope, true);
});

test('buildIntervalConsolidatedValues buckets time series correctly', () => {
    const start = new Date('2026-03-27T10:00:00Z');
    const end = new Date('2026-03-27T10:05:00Z');
    const rows = [
        { ts: '2026-03-27T10:00:30Z', value: 10 },
        { ts: '2026-03-27T10:01:30Z', value: 20 },
        { ts: '2026-03-27T10:02:30Z', value: 30 },
        { ts: '2026-03-27T10:03:30Z', value: 40 },
        { ts: '2026-03-27T10:04:30Z', value: 50 },
    ];

    // 1-minute intervals (60,000 ms) over a 5-minute window = 5 buckets
    const buckets = buildIntervalConsolidatedValues(rows, start, end, 60000, 'avg', 2, 0);
    assert.equal(buckets.length, 5);
    assert.equal(buckets[0].repeat_no, 1);
    assert.equal(buckets[0].value, '10');
    assert.equal(buckets[4].repeat_no, 5);
    assert.equal(buckets[4].value, '50');
});

// ============================================================================
// 4. HIGH EXCEPTION & JOB REGISTRY TESTS
// ============================================================================
test('getHighExceptionDedupeKey generates deterministic compound key', () => {
    const batch = { BatchId: 'B-2026-0142' };
    const phase = { PhaseId: 'PH-10' };
    const step = { StepId: 'ST-01' };
    const instruction = { InstructionId: 'INST-99' };
    const item = { RepeatNo: 3, What: 'High temp' };

    const key = getHighExceptionDedupeKey(batch, phase, step, instruction, item);
    assert.equal(key, 'B-2026-0142:PH-10:ST-01:INST-99:3');
});

test('jobRegistry registers, stops, and cleans up jobs safely', async () => {
    let stopped = false;
    const dummyJob = {
        batchId: 'B-TEST',
        refInstruction: 'INST-TEST',
        stop: async () => { stopped = true; }
    };

    jobRegistry.set('test_key', dummyJob);
    assert.equal(jobRegistry.has('test_key'), true);

    await jobRegistry.stopJob('test_key');
    assert.equal(stopped, true);
    assert.equal(jobRegistry.has('test_key'), false);
});

test('jobRegistry.stopAllForBatch stops all jobs matching batchId', async () => {
    let stopped1 = false;
    let stopped2 = false;
    jobRegistry.set('B-99_INST-1', {
        batchId: 'B-99',
        refInstruction: 'INST-1',
        stop: async () => { stopped1 = true; }
    });
    jobRegistry.set('B-99_INST-2', {
        batchId: 'B-99',
        refInstruction: 'INST-2',
        stop: async () => { stopped2 = true; }
    });
    jobRegistry.set('B-OTHER_INST-1', {
        batchId: 'B-OTHER',
        refInstruction: 'INST-1',
        stop: async () => {}
    });

    const count = await jobRegistry.stopAllForBatch('B-99');
    assert.equal(count, 2);
    assert.equal(stopped1, true);
    assert.equal(stopped2, true);
    assert.equal(jobRegistry.has('B-99_INST-1'), false);
    assert.equal(jobRegistry.has('B-99_INST-2'), false);
    assert.equal(jobRegistry.has('B-OTHER_INST-1'), true);

    await jobRegistry.stopJob('B-OTHER_INST-1');
});

// ============================================================================
// 5. BATCH STATUS WEBHOOK & QUEUE PAYLOAD TESTS
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
    assert.equal(extracted.productSpecificationId, 'FF_test');
    assert.equal(extracted.batchStatus, 'Started');
    assert.equal(extracted.isStarted, true);
});

test('extractBatchStatusPayload returns isStarted=false for non-Started statuses', () => {
    const payload = {
        Topic: 'batch_status.update',
        Data: {
            Batch: {
                BatchId: 'ff_261009_3_1',
                BatchStatus: 'Completed'
            }
        }
    };

    const extracted = extractBatchStatusPayload(payload);
    assert.equal(extracted.batchId, 'ff_261009_3_1');
    assert.equal(extracted.batchStatus, 'Completed');
    assert.equal(extracted.isStarted, false);
});

test('isProductSpecExcluded handles null, undefined, and empty string safely', async () => {
    assert.equal(await isProductSpecExcluded(null), false);
    assert.equal(await isProductSpecExcluded(undefined), false);
    assert.equal(await isProductSpecExcluded(''), false);
    assert.equal(await isProductSpecExcluded('   '), false);
});

// ============================================================================
// 6. MIDDLEWARE TESTS (UNAUTHENTICATED AUDIT & API KEY AUTH)
// ============================================================================
test('auditLog allows unauthenticated webhook calls and invokes next()', () => {
    let nextCalled = false;
    const req = {
        method: 'POST',
        originalUrl: '/instruction',
        path: '/instruction',
        query: {},
        headers: {}
    };
    const res = {
        statusCode: 200,
        on: (event, cb) => { /* mock listener */ }
    };

    auditLog(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, true, 'auditLog must never block unauthenticated webhook calls');
});

test('requireApiKey rejects requests missing X-API-Key with 401', async () => {
    let statusCode = null;
    let jsonBody = null;

    const req = {
        headers: {}
    };
    const res = {
        status: (code) => {
            statusCode = code;
            return {
                json: (body) => { jsonBody = body; }
            };
        }
    };

    await requireApiKey(req, res, () => {
        assert.fail('next() should not be called when API key is missing');
    });

    assert.equal(statusCode, 401);
    assert.match(jsonBody.error, /Missing required X-API-Key/);
});

// ============================================================================
// 9. SCHEDULED INSTRUCTION WORKER & EXTENSIBLE DISPATCHER TESTS
// ============================================================================
import {
    registerCaseDispatcher,
    startScheduledInstructionWorker,
    stopScheduledInstructionWorker
} from './src/services/scheduledInstructionWorker.js';
import { executeScheduledCase1 } from './src/services/case1Service.js';
import { executeScheduledCase2 } from './src/services/case2Service.js';
import { executeScheduledCase3 } from './src/services/continuousIntervalService.js';

test('registerCaseDispatcher allows registering handlers for different case types', () => {
    let customCaseExecuted = false;
    registerCaseDispatcher(99, async (task) => {
        customCaseExecuted = true;
        assert.equal(task.case_type, 99);
    });

    assert.equal(typeof executeScheduledCase1, 'function');
    assert.equal(typeof executeScheduledCase2, 'function');
    assert.equal(typeof executeScheduledCase3, 'function');
    assert.equal(typeof startScheduledInstructionWorker, 'function');
    assert.equal(typeof stopScheduledInstructionWorker, 'function');
});

test('scheduledInstructionWorker starts and stops cleanly without errors', () => {
    startScheduledInstructionWorker(60000); // 60s test interval
    stopScheduledInstructionWorker();
});

// ============================================================================
// 10. WAVE DETECTION & SENTINEL SCENARIOS TESTS
// ============================================================================
import { detectWaveInReadings } from './src/services/mathService.js';
import { pool } from './src/db.js';

test('detectWaveInReadings detects rise start and stop threshold crossing', () => {
    const rows = [
        { ts: '2026-10-12T10:00:00Z', value: 10 },
        { ts: '2026-10-12T10:01:00Z', value: 20 },
        { ts: '2026-10-12T10:02:00Z', value: 55 }, // crosses start threshold (50)
        { ts: '2026-10-12T10:03:00Z', value: 70 },
        { ts: '2026-10-12T10:04:00Z', value: 15 }  // crosses stop threshold (20)
    ];

    const profileConfig = {
        start: 50,
        stop: 20,
        durationMinutes: null,
        direction: 'rise'
    };

    const res = detectWaveInReadings(rows, profileConfig);
    assert.equal(res.waveStartTs, '2026-10-12T10:02:00Z');
    assert.equal(res.waveStopTs, '2026-10-12T10:04:00Z');
    assert.equal(res.startDirection, 'rise');
});

test('detectWaveInReadings detects durationMinutes timeout correctly', () => {
    const rows = [
        { ts: '2026-10-12T10:00:00Z', value: 10 },
        { ts: '2026-10-12T10:01:00Z', value: 60 }, // crosses start threshold (50)
        { ts: '2026-10-12T10:02:00Z', value: 65 },
        { ts: '2026-10-12T10:03:00Z', value: 62 }  // +2 minutes after 10:01
    ];

    const profileConfig = {
        start: 50,
        stop: null,
        durationMinutes: 2,
        direction: 'rise'
    };

    const res = detectWaveInReadings(rows, profileConfig);
    assert.equal(res.waveStartTs, '2026-10-12T10:01:00Z');
    assert.equal(res.waveStopTs, '2026-10-12T10:03:00Z');
});

test('detectWaveInReadings returns null when threshold is never breached', () => {
    const rows = [
        { ts: '2026-10-12T10:00:00Z', value: 10 },
        { ts: '2026-10-12T10:01:00Z', value: 20 }
    ];

    const profileConfig = {
        start: 100,
        stop: 50,
        durationMinutes: null,
        direction: 'rise'
    };

    const res = detectWaveInReadings(rows, profileConfig);
    assert.equal(res.waveStartTs, null);
    assert.equal(res.waveStopTs, null);
});

test('buildIntervalConsolidatedValues forward-fills gaps with last known reading', () => {
    const start = new Date('2026-03-27T10:00:00Z');
    const end = new Date('2026-03-27T10:04:00Z');
    // Only readings in minute 0 and minute 3 (minutes 1 and 2 are empty gaps)
    const rows = [
        { ts: '2026-03-27T10:00:20Z', value: 100 },
        { ts: '2026-03-27T10:03:40Z', value: 200 }
    ];

    const buckets = buildIntervalConsolidatedValues(rows, start, end, 60000, 'avg', 1, 0);
    assert.equal(buckets.length, 4);
    assert.equal(buckets[0].value, '100'); // minute 0: actual
    assert.equal(buckets[1].value, '100'); // minute 1: gap, forward-filled
    assert.equal(buckets[2].value, '100'); // minute 2: gap, forward-filled
    assert.equal(buckets[3].value, '200'); // minute 3: actual
});

test('handleRecordMode rejects future RefStartTime with 400', async () => {
    let statusCode = null;
    let jsonBody = null;
    const mockRes = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(payload) {
            jsonBody = payload;
            return this;
        }
    };
    const futureDate = new Date(Date.now() + 3600 * 1000);
    const pastDate = new Date(Date.now() - 3600 * 1000);
    await handleRecordMode({}, mockRes, { id: 1, name: 'TAG_1' }, futureDate, pastDate);
    assert.equal(statusCode, 400);
    assert.match(jsonBody.error, /must be in the past/);
});

test('handleRecordMode rejects future RefEndTime with 400', async () => {
    let statusCode = null;
    let jsonBody = null;
    const mockRes = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(payload) {
            jsonBody = payload;
            return this;
        }
    };
    const pastDate = new Date(Date.now() - 3600 * 1000);
    const futureDate = new Date(Date.now() + 3600 * 1000);
    await handleRecordMode({}, mockRes, { id: 1, name: 'TAG_1' }, pastDate, futureDate);
    assert.equal(statusCode, 400);
    assert.match(jsonBody.error, /must be in the past/);
});

test('hasHealthCheckTrigger recognizes all health check aliases', () => {
    assert.equal(hasHealthCheckTrigger('[HEALTH_CHECK]'), true);
    assert.equal(hasHealthCheckTrigger('[health_check]'), true);
    assert.equal(hasHealthCheckTrigger('Check system [HEALTHCHECK] now'), true);
    assert.equal(hasHealthCheckTrigger('[PING]'), true);
    assert.equal(hasHealthCheckTrigger('[HEALTH]'), true);
    assert.equal(hasHealthCheckTrigger('[EXCEPTION: REF=INST-1]'), false);
    assert.equal(hasHealthCheckTrigger(''), false);
    assert.equal(hasHealthCheckTrigger(null), false);
});

test('handleOnDemandHealthCheck always returns 200 with diagnostics', async () => {
    let statusCode = null;
    let jsonBody = null;
    const mockRes = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(payload) {
            jsonBody = payload;
            return this;
        }
    };

    const mockReq = {
        body: {
            Topic: 'batch_active_instruction.update',
            Data: {
                Batch: {
                    BatchId: 'B-HEALTH-001',
                    Phase: {
                        Step: {
                            Instruction: {
                                InstructionId: 'INST-HEALTH',
                                InstructionDescription: 'Run connectivity test [HEALTH_CHECK]'
                            }
                        }
                    }
                }
            }
        }
    };

    await handleOnDemandHealthCheck(mockReq, mockRes);
    assert.equal(statusCode, 200);
    assert.equal(jsonBody.status, 'received');
    assert.ok(jsonBody.healthCheck);
    assert.equal(jsonBody.healthCheck.type, 'on_demand');
    assert.ok(['passed', 'failed'].includes(jsonBody.healthCheck.result));
    assert.ok(typeof jsonBody.healthCheck.latencyMs === 'number');
});

test('handleInstructionWebhook routes [HEALTH_CHECK] with RefInstruction and sends BatchId back to BatchLine', async () => {
    const origFetch = global.fetch;
    const fetchCalls = [];

    global.fetch = async (url, opts) => {
        const bodyStr = opts?.body;
        let parsedBody = null;
        try { parsedBody = JSON.parse(bodyStr); } catch {}
        fetchCalls.push({ url: String(url), method: opts?.method, body: parsedBody, headers: opts?.headers });
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ status: 'success' })
        };
    };

    try {
        let statusCode = null;
        let jsonBody = null;
        const mockRes = {
            status(code) {
                statusCode = code;
                return this;
            },
            json(payload) {
                jsonBody = payload;
                return this;
            }
        };

        const mockReq = {
            body: {
                Topic: 'batch_active_instruction.update',
                Data: {
                    Batch: {
                        BatchId: 'VV_261022_PoC_1',
                        ProcessNumber: 'VV_261022_PoC',
                        MaterialId: 'Aspirin',
                        Phase: {
                            PhaseId: '1',
                            PhaseDescription: 'Case 1',
                            Step: {
                                StepId: '1',
                                StepDescription: 'Single Value',
                                Instruction: {
                                    InstructionId: '1',
                                    InstructionDescription: 'Click for send request to historian [HEALTH_CHECK]',
                                    InstructionType: 'Instruction',
                                    ExpectedResult: null,
                                    RefElement: 'R1.N2_BLANKET',
                                    RefTime: null,
                                    RefRecipe: null,
                                    RefEvent: null,
                                    RefStartTime: null,
                                    RefEndTime: null,
                                    RefType: null,
                                    RefInstruction: 'EXC',
                                    EventType: 1,
                                    TriggeredByEmail: 'qa1@cs.com',
                                    ActualResult: null
                                }
                            }
                        }
                    }
                },
                CallbackKey: '27340ec0-f56b-4bac-b18c-5eae13b37840'
            }
        };

        await handleInstructionWebhook(mockReq, mockRes);

        assert.equal(statusCode, 200);
        assert.equal(jsonBody.status, 'received');
        assert.ok(jsonBody.healthCheck);
        assert.equal(jsonBody.healthCheck.refInstruction, 'EXC');
        assert.equal(jsonBody.healthCheck.refInstructionUpdated, true);

        // Verify outgoing instruction update call to BatchLine
        const updateCall = fetchCalls.find(c => c.url.includes('/api/v1/batch/instruction/update/EXC'));
        assert.ok(updateCall, 'Expected outbound call to /api/v1/batch/instruction/update/EXC');
        assert.equal(updateCall.body.batch_id, 'VV_261022_PoC_1');
        assert.equal(updateCall.body.actual_result[0].value, 'VV_261022_PoC_1');
        assert.equal(updateCall.body.actual_result[0].executed_user_email, 'qa1@cs.com');
    } finally {
        global.fetch = origFetch;
    }
});

// ============================================================================
// 10. PREVIOUS BATCH ([PREVBATCH]) TESTS
// ============================================================================
test('hasPrevBatchTrigger recognizes all prevbatch variants and aliases', () => {
    assert.equal(hasPrevBatchTrigger('[PREVBATCH]'), true);
    assert.equal(hasPrevBatchTrigger('[prevbatch]'), true);
    assert.equal(hasPrevBatchTrigger('[PrevBatch]'), true);
    assert.equal(hasPrevBatchTrigger('[PREV_BATCH]'), true);
    assert.equal(hasPrevBatchTrigger('[prev_batch]'), true);
    assert.equal(hasPrevBatchTrigger('[PREV-BATCH]'), true);
    assert.equal(hasPrevBatchTrigger('[  PREVBATCH  ]'), true);
    assert.equal(hasPrevBatchTrigger('Check previous batch: [PREVBATCH] for line clearance'), true);
    assert.equal(hasPrevBatchTrigger('[TIME: VALUE=10]'), false);
    assert.equal(hasPrevBatchTrigger('PREVBATCH'), false); // must have brackets
    assert.equal(hasPrevBatchTrigger(''), false);
    assert.equal(hasPrevBatchTrigger(null), false);
    assert.equal(hasPrevBatchTrigger(undefined), false);
});

test('handlePreviousBatchInstruction rejects missing RefElement with 400', async () => {
    let statusCode = null;
    let jsonBody = null;
    const mockRes = {
        status(code) { statusCode = code; return this; },
        json(payload) { jsonBody = payload; return this; }
    };

    const ctx = {
        refElement: null,
        refInstruction: 'INST-01',
        batchId: 'B-2026-0001'
    };

    await handlePreviousBatchInstruction(ctx, mockRes);
    assert.equal(statusCode, 400);
    assert.match(jsonBody.error, /Missing required RefElement/);
});

test('handlePreviousBatchInstruction rejects missing RefInstruction with 400', async () => {
    let statusCode = null;
    let jsonBody = null;
    const mockRes = {
        status(code) { statusCode = code; return this; },
        json(payload) { jsonBody = payload; return this; }
    };

    const ctx = {
        refElement: 'R1',
        refInstruction: null,
        batchId: 'B-2026-0001'
    };

    await handlePreviousBatchInstruction(ctx, mockRes);
    assert.equal(statusCode, 400);
    assert.match(jsonBody.error, /Missing required RefInstruction/);
});

test('handlePreviousBatchInstruction rejects missing BatchId with 400', async () => {
    let statusCode = null;
    let jsonBody = null;
    const mockRes = {
        status(code) { statusCode = code; return this; },
        json(payload) { jsonBody = payload; return this; }
    };

    const ctx = {
        refElement: 'R1',
        refInstruction: 'INST-01',
        batchId: null
    };

    await handlePreviousBatchInstruction(ctx, mockRes);
    assert.equal(statusCode, 400);
    assert.match(jsonBody.error, /Missing required BatchId/);
});

test('handlePreviousBatchInstruction allows RefTime to be null', async () => {
    let statusCode = null;
    let jsonBody = null;
    const mockRes = {
        status(code) { statusCode = code; return this; },
        json(payload) { jsonBody = payload; return this; }
    };

    const ctx = {
        refElement: 'NON_EXISTENT_ASSET_XYZ',
        refInstruction: 'INST-01',
        batchId: 'B-2026-0001',
        refTime: null
    };

    await handlePreviousBatchInstruction(ctx, mockRes);
    // Should pass RefTime validation and reach asset resolution or 404/500, but NOT 400
    assert.notEqual(statusCode, 400);
});

test('handleInstructionWebhook routes EventType 1 with [PREVBATCH] without requiring RefTime', async () => {
    let statusCode = null;
    let jsonBody = null;
    const mockRes = {
        status(code) { statusCode = code; return this; },
        json(payload) { jsonBody = payload; return this; }
    };

    const req = {
        body: {
            Topic: 'batch_active_instruction.update',
            Data: {
                Batch: {
                    BatchId: 'B-2026-0010',
                    Phase: {
                        Step: {
                            Instruction: {
                                EventType: 1,
                                InstructionId: 'INST-RECORD-PREV',
                                InstructionDescription: 'Find and record [PREVBATCH] into step',
                                RefElement: 'Reactor 1',
                                RefInstruction: 'INST-TARGET-01',
                                RefTime: null // Explicitly null as specified in user requirement
                            }
                        }
                    }
                }
            }
        }
    };

    await handleInstructionWebhook(req, mockRes);
    // Should route to previous batch handler and not fail with 400 (EventType/RefTime missing)
    assert.notEqual(statusCode, 400);
});

test('handlePreviousBatchInstruction succeeds and returns previous batch when found in database', async () => {
    let statusCode = 200;
    let jsonBody = null;
    const mockRes = {
        status(code) { statusCode = code; return this; },
        json(payload) { jsonBody = payload; return this; }
    };

    const origQuery = pool.query;
    pool.query = async (text, params) => {
        const queryStr = String(text).toLowerCase();
        // Asset query
        if (queryStr.includes('from assets')) {
            return {
                rows: [{ id: 1, code: 'R1', display_name: 'Reactor 1 — Synthesis', asset_type: 'Reactor' }]
            };
        }
        // Current batch existence query
        if (queryStr.includes('select id, batch_id, started_at, status from batches')) {
            return {
                rows: [{ id: 2, batch_id: 'B-2026-0005', started_at: new Date('2026-10-20T10:00:00Z'), status: 'Running' }]
            };
        }
        // Previous batch query
        if (queryStr.includes('from batches b')) {
            return {
                rows: [{
                    id: 1,
                    batch_id: 'B-2026-0004',
                    started_at: new Date('2026-10-19T10:00:00Z'),
                    ended_at: new Date('2026-10-19T18:00:00Z'),
                    status: 'Completed'
                }]
            };
        }
        return { rows: [] };
    };

    try {
        const ctx = {
            refElement: 'R1',
            refInstruction: 'INST-PREV-01',
            batchId: 'B-2026-0005',
            refTime: null,
            instructionDescription: 'Record previous batch [PREVBATCH]'
        };

        await handlePreviousBatchInstruction(ctx, mockRes);
        assert.equal(statusCode, 200);
        assert.equal(jsonBody.status, 'success');
        assert.equal(jsonBody.case, 1);
        assert.equal(jsonBody.subcase, 'previous_batch');
        assert.equal(jsonBody.previous_batch.batch_id, 'B-2026-0004');
        assert.equal(jsonBody.asset.code, 'R1');
        assert.equal(jsonBody.target_instruction, 'INST-PREV-01');
    } finally {
        pool.query = origQuery;
    }
});

// ============================================================================
// 11. HEALTH_CHECK DIALOGUE & BATCH QUEUE ASSIGNMENT (CONDITION 3.1)
// ============================================================================
test('assignBatchToQueue defers start when on-demand health check is pending and fromHealthCheckClose is false', async () => {
    const origQuery = pool.query;
    pool.query = async (text, params) => {
        const queryStr = String(text).toLowerCase();
        if (queryStr.includes('from simulation_control')) {
            return { rows: [{ running: true, speed: 1, mode: 'continuous' }] };
        }
        if (queryStr.includes('from batches where batch_id')) {
            return { rows: [] };
        }
        if (queryStr.includes('from batch_queue where batch_id')) {
            return { rows: [] };
        }
        if (queryStr.includes('from integration_health_checks')) {
            return { rows: [{ id: 'hc-uuid-test-01', created_at: new Date() }] };
        }
        return { rows: [] };
    };

    try {
        const result = await assignBatchToQueue({ batchId: 'B-2026-HC-DEFER' });
        assert.equal(result.cleanBatchId, 'B-2026-HC-DEFER');
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
            return { rows: [{ running: true, speed: 1, mode: 'continuous' }] };
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
                    id: 101,
                    batch_id: 'B-2026-HC-START',
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
                    assigned_batch_id: 'B-2026-HC-START',
                    single_batch_status: 'waiting_r1',
                    updated_at: new Date()
                }]
            };
        }
        return { rows: [] };
    };

    try {
        const result = await assignBatchToQueue({
            batchId: 'B-2026-HC-START',
            startImmediate: true,
            fromHealthCheckClose: true
        });
        assert.equal(insertedQueueRow, true);
        assert.equal(result.cleanBatchId, 'B-2026-HC-START');
        assert.equal(result.cmd, 'start_immediate');
        assert.equal(result.initialStatus, 'waiting_r1');
        assert.equal(result.queueEntry.id, 101);
    } finally {
        pool.query = origQuery;
    }
});

test('assignBatchToQueue avoids a new queue if batch is already in batch_queue (Condition 3.1)', async () => {
    const origQuery = pool.query;
    let attemptedInsert = false;
    pool.query = async (text, params) => {
        const queryStr = String(text).toLowerCase();
        if (queryStr.includes('from simulation_control')) {
            return { rows: [{ running: true, speed: 1, mode: 'single' }] };
        }
        if (queryStr.includes('from batches where batch_id')) {
            return { rows: [] };
        }
        if (queryStr.includes('from batch_queue where batch_id')) {
            return {
                rows: [{
                    id: 55,
                    batch_id: 'B-2026-ALREADY-QUEUED',
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
            batchId: 'B-2026-ALREADY-QUEUED',
            startImmediate: true
        });
        assert.equal(attemptedInsert, false, 'Should avoid inserting a duplicate queue entry');
        assert.equal(result.alreadyInQueue, true);
        assert.equal(result.cleanBatchId, 'B-2026-ALREADY-QUEUED');
        assert.equal(result.initialStatus, 'waiting_r1');
        assert.equal(result.queueEntry.id, 55);
    } finally {
        pool.query = origQuery;
    }
});

test('assignBatchToQueue avoids a new queue if batch is already in batches table (Condition 3.1)', async () => {
    const origQuery = pool.query;
    let attemptedInsert = false;
    pool.query = async (text, params) => {
        const queryStr = String(text).toLowerCase();
        if (queryStr.includes('from simulation_control')) {
            return { rows: [{ running: true, speed: 1, mode: 'single' }] };
        }
        if (queryStr.includes('from batches where batch_id')) {
            return {
                rows: [{
                    id: 1,
                    batch_id: 'B-2026-ALREADY-STARTED',
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
            batchId: 'B-2026-ALREADY-STARTED',
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

test('handleStatusPost recognizes pending health check and duplicate queue avoidance cleanly', async () => {
    const origQuery = pool.query;
    let pendingHcMode = true;
    pool.query = async (text, params) => {
        const queryStr = String(text).toLowerCase();
        if (queryStr.includes('excluded_product_specifications')) {
            return { rows: [] }; // Not excluded
        }
        if (queryStr.includes('from simulation_control')) {
            return { rows: [{ running: true, speed: 1, mode: 'continuous' }] };
        }
        if (queryStr.includes('from batches where batch_id')) {
            return { rows: [] };
        }
        if (pendingHcMode) {
            if (queryStr.includes('from batch_queue where batch_id')) {
                return { rows: [] };
            }
            if (queryStr.includes('from integration_health_checks')) {
                return { rows: [{ id: 'hc-uuid-002', created_at: new Date() }] };
            }
        } else {
            // Duplicate queue mode
            if (queryStr.includes('from batch_queue where batch_id')) {
                return {
                    rows: [{
                        id: 77,
                        batch_id: 'B-2026-STATUS-TEST',
                        command: 'start_immediate',
                        status: 'waiting_r1'
                    }]
                };
            }
        }
        return { rows: [] };
    };

    try {
        // Case 1: Pending Health Check
        let jsonResponse = null;
        const mockRes1 = {
            json(payload) { jsonResponse = payload; return this; }
        };
        const mockReq1 = {
            body: {
                Topic: 'batch_execute.update',
                Data: {
                    Batch: {
                        BatchId: 'B-2026-STATUS-TEST',
                        BatchStatus: 'Started'
                    }
                }
            }
        };

        await handleStatusPost(mockReq1, mockRes1);
        assert.equal(jsonResponse.status, 'received');
        assert.equal(jsonResponse.batchAssignment.assigned, false);
        assert.equal(jsonResponse.batchAssignment.pendingHealthCheck, true);
        assert.equal(jsonResponse.batchAssignment.status, 'awaiting_health_check');

        // Case 2: Batch already in queue (Condition 3.1)
        pendingHcMode = false;
        let jsonResponse2 = null;
        const mockRes2 = {
            json(payload) { jsonResponse2 = payload; return this; }
        };

        await handleStatusPost(mockReq1, mockRes2);
        assert.equal(jsonResponse2.status, 'received');
        assert.equal(jsonResponse2.batchAssignment.assigned, false);
        assert.equal(jsonResponse2.batchAssignment.alreadyInQueue, true);
        assert.equal(jsonResponse2.batchAssignment.status, 'waiting_r1');
    } finally {
        pool.query = origQuery;
    }
});

// ============================================================================
// 12. PREDEFINED INSTRUCTION TEMPLATE TESTS
// ============================================================================
test('createMockResponse captures statusCode, json data, and headersSent cleanly', () => {
    const res = createMockResponse();
    assert.equal(res.headersSent, false);
    assert.equal(res.statusCode, 200);

    const payload = { test: 'value', number: 42 };
    const returned = res.status(201).json(payload);

    assert.equal(res.headersSent, true);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.data, payload);
    assert.deepEqual(returned, payload);
});

test('instantiatePredefinedBatchInstructions safely skips when batchId is invalid or UNKNOWN', async () => {
    const resNull = await instantiatePredefinedBatchInstructions({ batchId: null });
    assert.equal(resNull.total, 0);
    assert.equal(resNull.enqueued, 0);

    const resUnknown = await instantiatePredefinedBatchInstructions({ batchId: 'UNKNOWN' });
    assert.equal(resUnknown.total, 0);
    assert.equal(resUnknown.enqueued, 0);
});

test('instantiatePredefinedBatchInstructions correctly routes and enqueues Case 1, 2, and 3', async () => {
    const origQuery = pool.query;
    try {
        pool.query = async (sql, params = []) => {
            const queryStr = String(sql);
            if (queryStr.includes('predefined_instruction_templates')) {
                return {
                    rows: [
                        {
                            id: 1,
                            recipe_version: 'v2.1',
                            name: 'R1 Charging Start Time',
                            instruction_id: '1',
                            instruction_description: '[SCHEDULE] Record R1 Charging phase start time',
                            ref_instruction: 'INST_R1_CHARGE_START',
                            event_type: 2,
                            ref_event: 'Charging',
                            ref_type: 'StartTime',
                            ref_element: null,
                            ref_time: null,
                            ref_start_time: null,
                            ref_end_time: null,
                            expected_result: null
                        },
                        {
                            id: 2,
                            recipe_version: 'v2.1',
                            name: 'R1 Agitator State Check',
                            instruction_id: '2',
                            instruction_description: '[INTERPRET: 0=STOPPED, 1=RUNNING]',
                            ref_instruction: 'INST_R1_AGIT_STATE',
                            event_type: 1,
                            ref_event: null,
                            ref_type: null,
                            ref_element: 'R1.AGIT_RUN',
                            ref_time: null,
                            ref_start_time: null,
                            ref_end_time: null,
                            expected_result: null
                        }
                    ]
                };
            }
            if (queryStr.includes('FROM events') || queryStr.includes('FROM tags') || queryStr.includes('FROM readings') || queryStr.includes('FROM snapshots')) {
                if (queryStr.includes('FROM tags')) {
                    return { rows: [{ id: 10, name: 'R1.AGIT_RUN', display_digits: 0 }] };
                }
                if (queryStr.includes('FROM readings') || queryStr.includes('FROM snapshots')) {
                    return { rows: [{ tag_id: 10, value: 1, ts: new Date() }] };
                }
                return { rows: [] };
            }
            if (queryStr.includes('INSERT INTO scheduled_instructions')) {
                return { rows: [{ id: 'mock-sched-uuid-01', scheduled_time: new Date() }] };
            }
            return { rows: [] };
        };

        const result = await instantiatePredefinedBatchInstructions({
            batchId: 'B-2026-TPL-TEST',
            callbackKey: 'cb-key-test',
            triggeredByEmail: 'operator@plant.com',
            recipeVersion: 'v2.1'
        });

        assert.equal(result.batchId, 'B-2026-TPL-TEST');
        assert.equal(result.total, 2);
        assert.equal(result.enqueued, 2);
        assert.equal(result.results.length, 2);
        assert.equal(result.results[0].refInstruction, 'INST_R1_CHARGE_START');
        assert.equal(result.results[0].status, 'scheduled');
        assert.equal(result.results[1].refInstruction, 'INST_R1_AGIT_STATE');
    } finally {
        pool.query = origQuery;
    }
});

test('handleOnDemandHealthCheck records check and details with callbackKey and triggeredByEmail on PASSED check', async () => {
    const origQuery = pool.query;
    try {
        let recordedDetails = null;
        pool.query = async (sql, params = []) => {
            const queryStr = String(sql);
            if (queryStr.includes('SELECT 1')) {
                return { rows: [{ 1: 1 }] };
            }
            if (queryStr.includes('INSERT INTO integration_health_checks')) {
                recordedDetails = JSON.parse(params[6]);
                return { rows: [{ id: 'hc-mock-uuid' }] };
            }
            return { rows: [{ id: 'hc-mock-uuid' }] };
        };

        const req = {
            body: {
                Topic: 'batch_active_instruction.update',
                CallbackKey: 'cb-test',
                TriggeredByEmail: 'operator@pharma.com',
                Instruction: {
                    InstructionDescription: '[HEALTH_CHECK]'
                },
                Data: {
                    Batch: {
                        BatchId: 'B-2026-HC-PASSED'
                    }
                }
            }
        };

        let responseBody = null;
        const res = {
            status: () => res,
            json: (data) => { responseBody = data; return data; }
        };

        await handleOnDemandHealthCheck(req, res);
        assert.equal(responseBody.status, 'received');
        assert.equal(responseBody.healthCheck.result, 'passed');
        assert.ok(recordedDetails);
        assert.equal(recordedDetails.callbackKey, 'cb-test');
        assert.equal(recordedDetails.triggeredByEmail, 'operator@pharma.com');
    } finally {
        pool.query = origQuery;
    }
});

test('handleOnDemandHealthCheck auto-instantiates predefined instructions when refInstruction is updated successfully', async () => {
    const origQuery = pool.query;
    const origFetch = global.fetch;
    let templateInstantiated = false;

    global.fetch = async (url, opts) => {
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ status: 'success' })
        };
    };

    pool.query = async (sql, params = []) => {
        const queryStr = String(sql);
        if (queryStr.includes('SELECT 1')) {
            return { rows: [{ '?column?': 1 }] };
        }
        if (queryStr.includes('predefined_instruction_templates')) {
            templateInstantiated = true;
            return {
                rows: [
                    {
                        id: 501,
                        recipe_version: 'v2.1',
                        name: 'R1 Charging End Time (CGET)',
                        instruction_id: '501',
                        instruction_description: '[SCHEDULE] Charging end',
                        ref_instruction: 'CGET',
                        event_type: 2,
                        ref_event: 'Charging',
                        ref_type: 'EndTime',
                        ref_element: null,
                        ref_time: null,
                        ref_start_time: null,
                        ref_end_time: null,
                        expected_result: null
                    }
                ]
            };
        }
        if (queryStr.includes('FROM events')) {
            return { rows: [] };
        }
        if (queryStr.includes('INSERT INTO scheduled_instructions')) {
            return { rows: [{ id: 'sched-501', scheduled_time: new Date() }] };
        }
        if (queryStr.includes('INSERT INTO integration_health_checks')) {
            return { rows: [{ id: 'hc-auto-uuid', created_at: new Date() }] };
        }
        return { rows: [] };
    };

    try {
        const req = {
            body: {
                Topic: 'batch_active_instruction.update',
                CallbackKey: 'cb-auto-test',
                Data: {
                    Batch: {
                        BatchId: 'B-AUTO-TPL-01',
                        Phase: {
                            Step: {
                                Instruction: {
                                    InstructionId: 'INST-INIT',
                                    InstructionDescription: 'Start Batch Check [HEALTH_CHECK]',
                                    RefInstruction: 'REF_INIT_01',
                                    TriggeredByEmail: 'lead@pharma.com'
                                }
                            }
                        }
                    }
                }
            }
        };

        let responseBody = null;
        const res = {
            status: () => res,
            json: (data) => { responseBody = data; return data; }
        };

        await handleOnDemandHealthCheck(req, res);
        assert.equal(responseBody.status, 'received');
        assert.equal(responseBody.healthCheck.result, 'passed');
        assert.equal(responseBody.healthCheck.refInstruction, 'REF_INIT_01');
        assert.equal(responseBody.healthCheck.refInstructionUpdated, true);
        assert.equal(templateInstantiated, true);
        assert.ok(responseBody.healthCheck.templates);
        assert.equal(responseBody.healthCheck.templates.batchId, 'B-AUTO-TPL-01');
        assert.equal(responseBody.healthCheck.templates.enqueued, 1);
    } finally {
        pool.query = origQuery;
        global.fetch = origFetch;
    }
});

test('handleHealthClose acknowledges check, assigns batch to queue, and auto-instantiates predefined instructions', async () => {
    const origQuery = pool.query;
    try {
        let templateInstantiated = false;
        let acknowledged = false;

        const healthCloseLayer = externalRouter.stack.find(s => s.route && (s.route.path === '/health/close' || (Array.isArray(s.route.path) && s.route.path.includes('/health/close'))));
        const handleHealthClose = healthCloseLayer.route.stack[0].handle;

        pool.query = async (sql, params = []) => {
            const queryStr = String(sql);
            if (queryStr.includes('UPDATE integration_health_checks')) {
                acknowledged = true;
                return {
                    rows: [{
                        details: JSON.stringify({
                            callbackKey: 'cb-key-hc-close',
                            triggeredByEmail: 'operator@plant.com'
                        })
                    }]
                };
            }
            if (queryStr.includes('from simulation_control')) {
                return { rows: [{ running: true, speed: 1, mode: 'continuous' }] };
            }
            if (queryStr.includes('from batches where batch_id')) {
                return { rows: [] };
            }
            if (queryStr.includes('from batch_queue where batch_id')) {
                return { rows: [] };
            }
            if (queryStr.includes('insert into batch_queue')) {
                return {
                    rows: [{
                        id: 99,
                        batch_id: 'B-2026-HC-PASSED',
                        command: 'start_immediate',
                        status: 'waiting_r1'
                    }]
                };
            }
            if (queryStr.includes('predefined_instruction_templates')) {
                templateInstantiated = true;
                return {
                    rows: [
                        {
                            id: 101,
                            recipe_version: 'v2.1',
                            name: 'R1 Heat Start Time',
                            instruction_id: '101',
                            instruction_description: '[SCHEDULE] Heat start',
                            ref_instruction: 'INST_R1_HEAT_START',
                            event_type: 2,
                            ref_event: 'Heating',
                            ref_type: 'StartTime',
                            ref_element: null,
                            ref_time: null,
                            ref_start_time: null,
                            ref_end_time: null,
                            expected_result: null
                        }
                    ]
                };
            }
            if (queryStr.includes('INSERT INTO scheduled_instructions')) {
                return { rows: [{ id: 'sched-101', scheduled_time: new Date() }] };
            }
            return { rows: [] };
        };

        const req = {
            body: {
                id: 'hc-mock-uuid',
                batchId: 'B-2026-HC-PASSED'
            }
        };

        let responseBody = null;
        const res = {
            status: () => res,
            json: (data) => { responseBody = data; return data; }
        };

        await handleHealthClose(req, res);
        assert.equal(acknowledged, true);
        assert.equal(responseBody.status, 'closed');
        assert.equal(responseBody.batchAssignment.assigned, true);
        assert.equal(responseBody.batchAssignment.batchId, 'B-2026-HC-PASSED');
        assert.equal(templateInstantiated, true);
        assert.ok(responseBody.templates);
        assert.equal(responseBody.templates.batchId, 'B-2026-HC-PASSED');
        assert.equal(responseBody.templates.enqueued, 1);
        assert.equal(responseBody.templates.results[0].refInstruction, 'INST_R1_HEAT_START');
    } finally {
        pool.query = origQuery;
    }
});

test('handleHealthClose skips template instantiation when assignBatchToQueue fails or batchId is missing', async () => {
    const origQuery = pool.query;
    try {
        let templateInstantiated = false;

        const healthCloseLayer = externalRouter.stack.find(s => s.route && (s.route.path === '/health/close' || (Array.isArray(s.route.path) && s.route.path.includes('/health/close'))));
        const handleHealthClose = healthCloseLayer.route.stack[0].handle;

        pool.query = async (sql, params = []) => {
            const queryStr = String(sql);
            if (queryStr.includes('UPDATE integration_health_checks')) {
                return { rows: [{ details: {} }] };
            }
            if (queryStr.includes('predefined_instruction_templates')) {
                templateInstantiated = true;
                return { rows: [] };
            }
            return { rows: [] };
        };

        // Case 1: missing batchId
        let resBody1 = null;
        const res1 = {
            status: () => res1,
            json: (data) => { resBody1 = data; return data; }
        };
        await handleHealthClose({ body: { id: 'hc-uuid-empty' } }, res1);
        assert.equal(resBody1.status, 'closed');
        assert.equal(resBody1.batchAssignment, null);
        assert.equal(resBody1.templates, null);
        assert.equal(templateInstantiated, false);

        // Case 2: assignBatchToQueue fails due to invalid characters
        let resBody2 = null;
        const res2 = {
            status: () => res2,
            json: (data) => { resBody2 = data; return data; }
        };
        await handleHealthClose({ body: { id: 'hc-uuid-fail', batchId: 'INVALID CHARACTERS WITH SPACES' } }, res2);
        assert.equal(resBody2.status, 'closed');
        assert.equal(resBody2.batchAssignment.assigned, false);
        assert.equal(resBody2.templates, null);
        assert.equal(templateInstantiated, false);
    } finally {
        pool.query = origQuery;
    }
});

test('instantiatePredefinedBatchInstructions supports actual BatchLine instruction schema including CGET for VV_261022_PoC_1', async () => {
    const origQuery = pool.query;
    try {
        let enqueuedPayload = null;
        pool.query = async (sql, params = []) => {
            const queryStr = String(sql);
            if (queryStr.includes('predefined_instruction_templates')) {
                return {
                    rows: [
                        {
                            id: 42,
                            recipe_version: 'v2.1',
                            name: 'R1 Charging End Time (CGET)',
                            instruction_id: '2',
                            instruction_description: 'Schedule the charging event time fetching [SCHEDULE]',
                            ref_instruction: 'CGET',
                            event_type: 2,
                            ref_event: 'Charging',
                            ref_type: 'EndTime',
                            ref_element: null,
                            ref_time: null,
                            ref_start_time: null,
                            ref_end_time: null,
                            expected_result: null
                        }
                    ]
                };
            }
            if (queryStr.includes('FROM events')) {
                return { rows: [] }; // Charging not yet ended
            }
            if (queryStr.includes('INSERT INTO scheduled_instructions')) {
                enqueuedPayload = JSON.parse(params[5]);
                return { rows: [{ id: 'sched-cget-uuid-42', scheduled_time: new Date() }] };
            }
            return { rows: [] };
        };

        const result = await instantiatePredefinedBatchInstructions({
            batchId: 'VV_261022_PoC_1',
            callbackKey: '15849ab8-14b6-4ce7-9d30-2718f13e4bb6',
            triggeredByEmail: 'qa2@cs.com',
            recipeVersion: 'v2.1'
        });

        assert.equal(result.batchId, 'VV_261022_PoC_1');
        assert.equal(result.total, 1);
        assert.equal(result.enqueued, 1);
        assert.equal(result.results[0].refInstruction, 'CGET');
        assert.equal(result.results[0].eventType, 2);
        assert.equal(result.results[0].refEvent, 'Charging');
        assert.equal(result.results[0].refType, 'EndTime');
        assert.equal(result.results[0].status, 'scheduled');

        // Verify that enqueued task payload has exact BatchLine context
        assert.ok(enqueuedPayload);
        assert.equal(enqueuedPayload.recipeBatchId, 'VV_261022_PoC_1');
        assert.equal(enqueuedPayload.refEvent, 'Charging');
        assert.equal(enqueuedPayload.refType, 'EndTime');
        assert.equal(enqueuedPayload.ctx.callbackKey, '15849ab8-14b6-4ce7-9d30-2718f13e4bb6');
        assert.equal(enqueuedPayload.ctx.triggeredByEmail, 'qa2@cs.com');
    } finally {
        pool.query = origQuery;
    }
});

test('test suite teardown closes database pool', async () => {
    await pool.end();
});

