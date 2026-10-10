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
    parsePrintLabelPayload,
    extractInstructionPayload
} from './src/utils/instructionParsers.js';

import {
    resolveMetric,
    computeMetricValue,
    resolveWaveDirections,
    buildIntervalConsolidatedValues
} from './src/services/mathService.js';

import { getHighExceptionDedupeKey } from './src/services/highExceptionService.js';
import { jobRegistry } from './src/services/jobRegistry.js';
import { extractBatchStatusPayload } from './src/services/batchQueueService.js';
import { auditLog } from './src/middleware/auditLog.js';
import { requireApiKey } from './src/middleware/requireApiKey.js';

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
    const text = 'Take reading when [TIME: VALUE=130, REF=INST_130] and [TIME: VALUE=140]';
    const triggers = extractTimeTriggers(text, 'DEFAULT_REF');
    assert.equal(triggers.length, 2);
    assert.equal(triggers[0].targetValue, 130);
    assert.equal(triggers[0].targetRef, 'INST_130');
    assert.equal(triggers[1].targetValue, 140);
    assert.equal(triggers[1].targetRef, 'DEFAULT_REF');
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
