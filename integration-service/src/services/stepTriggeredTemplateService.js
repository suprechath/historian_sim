import { query } from '../db.js';
import { logger } from '../utils/logger.js';
import { formatBatchLineDate, parseBatchLineDate } from '../utils/formatters.js';
import { extractInstructionPayload } from '../utils/instructionParsers.js';
import { handleCase1PointInTime } from './case1Service.js';
import { handleCase2PhaseTimestamp } from './case2Service.js';
import { handleCase3TimeRange } from './case3Service.js';
import { createMockResponse } from './instructionTemplateService.js';
import {
    findEventForBatch,
    enqueueScheduledInstruction,
    rescheduleInstruction
} from '../dal/externalDal.js';

let ensureStepTablePromise = null;

export const CASE_TYPE_EVENT_DEPENDENT = 4;
export const STEP_EVENT_POLL_INTERVAL_SECONDS = 10;
export const STEP_EVENT_MAX_ATTEMPTS = Math.floor((48 * 3600) / STEP_EVENT_POLL_INTERVAL_SECONDS);


/**
 * Ensures the step_triggered_instruction_templates table exists in PostgreSQL.
 * Matches predefined_instruction_templates schema 1:1 plus trigger & dynamic resolution attributes.
 */
export async function ensureStepTriggeredTables() {
    if (!ensureStepTablePromise) {
        ensureStepTablePromise = (async () => {
            try {
                await query(`
                    CREATE TABLE IF NOT EXISTS step_triggered_instruction_templates (
                        id                          SERIAL PRIMARY KEY,
                        recipe_version              TEXT NOT NULL DEFAULT 'v2.1',
                        name                        TEXT NOT NULL,
                        
                        -- Trigger identification
                        trigger_instruction_id      TEXT NOT NULL,
                        time_source                 TEXT NOT NULL CHECK (time_source IN ('HISTORIAN_EVENT', 'PAYLOAD', 'STATIC')),

                        -- Standard instruction attributes (1:1 with predefined_instruction_templates)
                        instruction_id              TEXT,
                        instruction_description     TEXT NOT NULL,
                        ref_instruction             TEXT NOT NULL,
                        event_type                  INTEGER NOT NULL CHECK (event_type IN (1, 2, 3)),
                        ref_event                   TEXT,
                        ref_type                    TEXT,
                        ref_element                 TEXT,
                        ref_time                    TEXT,
                        ref_start_time              TEXT,
                        ref_end_time                TEXT,
                        expected_result             TEXT,
                        is_active                   BOOLEAN NOT NULL DEFAULT TRUE,

                        -- Resolution: Historian Event Sourcing (Type 1)
                        ref_start_event             TEXT,
                        ref_start_type              TEXT DEFAULT 'StartTime' CHECK (ref_start_type IN ('StartTime', 'EndTime')),
                        ref_end_event               TEXT,
                        ref_end_type                TEXT CHECK (ref_end_type IS NULL OR ref_end_type IN ('StartTime', 'EndTime')),

                        -- Resolution: Payload Sourcing (Type 2)
                        payload_start_field         TEXT DEFAULT 'ActualResult',
                        payload_end_field           TEXT,
                        offset_duration_ms          INTEGER DEFAULT 0,

                        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        UNIQUE (recipe_version, trigger_instruction_id, ref_instruction)
                    );

                    CREATE INDEX IF NOT EXISTS idx_step_templates_trigger 
                    ON step_triggered_instruction_templates (recipe_version, trigger_instruction_id, is_active);

                    CREATE INDEX IF NOT EXISTS idx_step_templates_ref 
                    ON step_triggered_instruction_templates (ref_instruction);
                `);
                logger.info('StepTriggeredService', 'step_triggered_instruction_templates table verified.');

            } catch (err) {
                logger.warn('StepTriggeredService', 'Could not ensure step_triggered_instruction_templates table:', err.message);
            }
        })();
    }
    return ensureStepTablePromise;
}

/**
 * Fetch list of step-triggered instruction templates with optional filters.
 */
export async function getStepTriggeredTemplates({ recipeVersion = null, triggerInstructionId = null, activeOnly = false } = {}) {
    await ensureStepTriggeredTables();
    let sql = `
        SELECT 
            id, recipe_version, name, trigger_instruction_id, time_source,
            instruction_id, instruction_description, ref_instruction,
            event_type, ref_event, ref_type, ref_element,
            ref_time, ref_start_time, ref_end_time, expected_result, is_active,
            ref_start_event, ref_start_type, ref_end_event, ref_end_type,
            payload_start_field, payload_end_field, offset_duration_ms,
            created_at, updated_at
        FROM step_triggered_instruction_templates
        WHERE 1=1
    `;
    const params = [];

    if (recipeVersion) {
        params.push(recipeVersion);
        sql += ` AND recipe_version = $${params.length}`;
    }
    if (triggerInstructionId) {
        params.push(String(triggerInstructionId).trim());
        sql += ` AND (trigger_instruction_id = $${params.length} OR LOWER(trigger_instruction_id) = LOWER($${params.length}))`;
    }
    if (activeOnly) {
        sql += ' AND is_active = TRUE';
    }
    sql += ' ORDER BY id ASC';

    const { rows } = await query(sql, params);
    return rows;
}

/**
 * Upsert a step-triggered instruction template.
 */
export async function upsertStepTriggeredTemplate({
    recipeVersion = 'v2.1',
    name,
    triggerInstructionId,
    timeSource = 'HISTORIAN_EVENT',
    instructionId = null,
    instructionDescription,
    refInstruction,
    eventType,
    refEvent = null,
    refType = null,
    refElement = null,
    refTime = null,
    refStartTime = null,
    refEndTime = null,
    expectedResult = null,
    isActive = true,
    refStartEvent = null,
    refStartType = 'StartTime',
    refEndEvent = null,
    refEndType = null,
    payloadStartField = 'ActualResult',
    payloadEndField = null,
    offsetDurationMs = 0
}) {
    await ensureStepTriggeredTables();
    const cleanRef = String(refInstruction).trim().toUpperCase();
    const cleanTrigger = String(triggerInstructionId).trim();

    const { rows } = await query(`
        INSERT INTO step_triggered_instruction_templates 
        (
            recipe_version, name, trigger_instruction_id, time_source,
            instruction_id, instruction_description, ref_instruction,
            event_type, ref_event, ref_type, ref_element,
            ref_time, ref_start_time, ref_end_time, expected_result, is_active,
            ref_start_event, ref_start_type, ref_end_event, ref_end_type,
            payload_start_field, payload_end_field, offset_duration_ms, updated_at
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
            $17, $18, $19, $20, $21, $22, $23, NOW()
        )
        ON CONFLICT (recipe_version, trigger_instruction_id, ref_instruction) DO UPDATE
        SET name = EXCLUDED.name,
            time_source = EXCLUDED.time_source,
            instruction_id = EXCLUDED.instruction_id,
            instruction_description = EXCLUDED.instruction_description,
            event_type = EXCLUDED.event_type,
            ref_event = EXCLUDED.ref_event,
            ref_type = EXCLUDED.ref_type,
            ref_element = EXCLUDED.ref_element,
            ref_time = EXCLUDED.ref_time,
            ref_start_time = EXCLUDED.ref_start_time,
            ref_end_time = EXCLUDED.ref_end_time,
            expected_result = EXCLUDED.expected_result,
            is_active = EXCLUDED.is_active,
            ref_start_event = EXCLUDED.ref_start_event,
            ref_start_type = EXCLUDED.ref_start_type,
            ref_end_event = EXCLUDED.ref_end_event,
            ref_end_type = EXCLUDED.ref_end_type,
            payload_start_field = EXCLUDED.payload_start_field,
            payload_end_field = EXCLUDED.payload_end_field,
            offset_duration_ms = EXCLUDED.offset_duration_ms,
            updated_at = NOW()
        RETURNING *;
    `, [
        recipeVersion, name, cleanTrigger, timeSource,
        instructionId, instructionDescription, cleanRef,
        eventType, refEvent, refType, refElement,
        refTime, refStartTime, refEndTime, expectedResult, isActive,
        refStartEvent, refStartType, refEndEvent, refEndType,
        payloadStartField, payloadEndField, offsetDurationMs
    ]);

    return rows[0];
}

/**
 * Synthesizes a standard BatchLine instruction payload matching BatchLine request schema 1:1.
 */
export function buildSynthesizedStepInstructionPayload({
    template,
    cleanBatchId,
    callbackKey = null,
    triggeredByEmail = null,
    resolvedTime = null,
    resolvedStartTime = null,
    resolvedEndTime = null
}) {
    const synthesizedInstruction = {
        InstructionId: template.instruction_id || template.ref_instruction,
        InstructionDescription: template.instruction_description || '',
        InstructionType: 'Instruction',
        ExpectedResult: template.expected_result || null,
        RefElement: template.ref_element || null,
        RefTime: resolvedTime || template.ref_time || null,
        RefRecipe: cleanBatchId,
        RefEvent: template.ref_event || null,
        RefStartTime: resolvedStartTime || template.ref_start_time || null,
        RefEndTime: resolvedEndTime || template.ref_end_time || null,
        RefType: template.ref_type || null,
        RefInstruction: template.ref_instruction,
        EventType: Number(template.event_type),
        TriggeredByEmail: triggeredByEmail || null,
        ActualResult: null
    };

    return {
        Topic: 'batch_active_instruction.update',
        CallbackKey: callbackKey,
        Data: {
            Batch: {
                BatchId: cleanBatchId,
                Phase: {
                    Step: {
                        Instruction: synthesizedInstruction
                    }
                }
            }
        }
    };
}

/**
 * Resolves Start and End times from Historian events table.
 * Supports:
 * - Single event with Start and End time (e.g. Charging started_at to ended_at)
 * - Two separate events (e.g. PreHeat started_at to Cooling ended_at)
 * - Start time only (ref_end_type is NULL) for open-ended / sentinel Case 3 subcases
 */
export async function resolveHistorianEventTimes(tpl, batchId) {
    const startEventName = tpl.ref_start_event || tpl.ref_event;
    const endEventName = tpl.ref_end_event || tpl.ref_event;

    if (!startEventName) {
        return { isReady: false, reason: 'Missing required ref_event or ref_start_event in template' };
    }

    // 1. Resolve Start Event
    const startEv = await findEventForBatch({ refRecipe: batchId, refEvent: startEventName });
    const isStartType = String(tpl.ref_start_type || 'StartTime').toLowerCase() === 'starttime';
    const startTime = startEv ? (isStartType ? startEv.started_at : startEv.ended_at) : null;

    if (!startTime) {
        const reason = !startEv
            ? `Phase "${startEventName}" not yet created in database`
            : `Phase "${startEv.name}" ${isStartType ? 'started_at' : 'ended_at'} is not set yet`;
        return { isReady: false, reason };
    }

    // 2. Resolve End Event (Only if ref_end_type is defined!)
    let endTime = null;
    if (tpl.ref_end_type) {
        const isEndStartType = String(tpl.ref_end_type).toLowerCase() === 'starttime';
        const endEv = (startEventName === endEventName)
            ? startEv
            : await findEventForBatch({ refRecipe: batchId, refEvent: endEventName });

        endTime = endEv ? (isEndStartType ? endEv.started_at : endEv.ended_at) : null;
        if (!endTime) {
            const reason = !endEv
                ? `Phase "${endEventName}" not yet created in database`
                : `Phase "${endEv.name}" ${isEndStartType ? 'started_at' : 'ended_at'} is not set yet`;
            return { isReady: false, reason };
        }
    }

    return {
        isReady: true,
        startTime: startTime ? formatBatchLineDate(startTime) : null,
        endTime: endTime ? formatBatchLineDate(endTime) : null,
        rawStartTime: startTime,
        rawEndTime: endTime
    };
}

/**
 * Resolves Start and End times directly from an incoming BatchLine Webhook Payload.
 */
export function resolvePayloadTimes(tpl, body) {
    const data = body.Data || {};
    const batch = data.Batch || {};
    const phase = batch.Phase || {};
    const step = phase.Step || {};
    const instruction = step.Instruction || body.Instruction || {};
    const actualResults = Array.isArray(instruction.ActualResult)
        ? instruction.ActualResult
        : (instruction.ActualResult ? [instruction.ActualResult] : []);
    const latestResult = actualResults[actualResults.length - 1] || actualResults[0] || {};

    // 1. Extract Start Time
    let rawStart = null;
    const startField = String(tpl.payload_start_field || 'ActualResult').toLowerCase();

    if (startField === 'executedtimestamp') {
        rawStart = latestResult.ExecutedTimestamp || latestResult.executed_timestamp || instruction.ExecutedTimestamp || body.ExecutedTimestamp;
    } else if (startField === 'refstarttime') {
        rawStart = instruction.RefStartTime || body.RefStartTime;
    } else {
        // Default: ActualResult value or RefTime
        rawStart = latestResult.Value || latestResult.value || instruction.RefTime || body.RefTime;
    }

    const parsedStart = rawStart ? (parseBatchLineDate(rawStart) || new Date(rawStart)) : null;

    // 2. Extract End Time (Optional)
    let rawEnd = null;
    if (tpl.payload_end_field) {
        const endField = String(tpl.payload_end_field).toLowerCase();
        if (endField === 'refendtime') {
            rawEnd = instruction.RefEndTime || body.RefEndTime;
        } else if (endField.includes('actualresult[1]') || endField === 'actualresult2') {
            rawEnd = actualResults[1]?.Value || actualResults[1]?.value;
        } else {
            rawEnd = instruction[tpl.payload_end_field] || body[tpl.payload_end_field];
        }
    } else if (tpl.offset_duration_ms > 0 && parsedStart && !isNaN(parsedStart.getTime())) {
        rawEnd = new Date(parsedStart.getTime() + tpl.offset_duration_ms);
    }

    const parsedEnd = rawEnd ? (parseBatchLineDate(rawEnd) || new Date(rawEnd)) : null;

    return {
        startTime: parsedStart && !isNaN(parsedStart.getTime()) ? formatBatchLineDate(parsedStart) : null,
        endTime: parsedEnd && !isNaN(parsedEnd.getTime()) ? formatBatchLineDate(parsedEnd) : null,
        targetDate: parsedStart && !isNaN(parsedStart.getTime()) ? parsedStart : null
    };
}

/**
 * Worker execution handler for persistent scheduled event-dependent step tasks (case_type: 4).
 * Called by scheduledInstructionWorker when task is due.
 */
export async function executeScheduledEventDependentStep(task) {
    const payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : task.payload;
    const { template, cleanBatchId, callbackKey, triggeredByEmail } = payload;

    const resolved = await resolveHistorianEventTimes(template, cleanBatchId);

    // If event timestamp is still not reached, reschedule to check again
    if (!resolved.isReady) {
        logger.debug('StepTriggeredWorker', `Task ${task.id} (${template.ref_instruction}): ${resolved.reason}. Rescheduling in ${STEP_EVENT_POLL_INTERVAL_SECONDS}s...`);
        await rescheduleInstruction(task.id, STEP_EVENT_POLL_INTERVAL_SECONDS, resolved.reason);
        return { scheduled: true, reason: resolved.reason };
    }

    logger.info('StepTriggeredWorker', `Historian events resolved for task ${task.id} (${template.ref_instruction}): Start=${resolved.startTime}, End=${resolved.endTime || 'N/A'}. Executing Case ${template.event_type}...`);

    const synthesizedBody = buildSynthesizedStepInstructionPayload({
        template,
        cleanBatchId,
        callbackKey,
        triggeredByEmail,
        resolvedTime: resolved.startTime,
        resolvedStartTime: resolved.startTime,
        resolvedEndTime: resolved.endTime
    });

    const ctx = extractInstructionPayload(synthesizedBody);
    ctx.batchId = cleanBatchId;
    ctx.callbackKey = callbackKey;
    ctx.triggeredByEmail = triggeredByEmail;
    if (!ctx.refRecipe) ctx.refRecipe = cleanBatchId;

    const eventType = Number(template.event_type);
    const mockRes = createMockResponse();
    let dispatchResult = null;

    if (eventType === 1) {
        dispatchResult = await handleCase1PointInTime(ctx, mockRes);
    } else if (eventType === 2) {
        dispatchResult = await handleCase2PhaseTimestamp(ctx, mockRes);
    } else if (eventType === 3) {
        dispatchResult = await handleCase3TimeRange(ctx, mockRes);
    } else {
        throw new Error(`Unsupported EventType ${eventType} for step template "${template.ref_instruction}"`);
    }

    const responseData = mockRes.data || dispatchResult || {};
    logger.info('StepTriggeredWorker', `Successfully executed step template "${template.ref_instruction}" for task ${task.id} (Status: ${responseData.status || 'success'})`);
    return responseData;
}

/**
 * Evaluates and dispatches step-triggered instruction templates when a BatchLine instruction update arrives.
 *
 * @param {Object} body - Incoming BatchLine webhook body
 * @param {string} [recipeVersion='v2.1'] - Recipe version
 * @returns {Promise<Object>} Execution / scheduling summary
 */
export async function handleStepTriggeredInstructions(body, recipeVersion = 'v2.1') {
    const data = body.Data || {};
    const batch = data.Batch || {};
    const phase = batch.Phase || {};
    const step = phase.Step || {};
    const instruction = step.Instruction || body.Instruction || {};

    const cleanBatchId = String(batch.BatchId || body.batch_id || body.BatchId || '').trim();
    const triggerId = String(instruction.InstructionId || instruction.RefInstruction || body.InstructionId || body.refInstruction || '').trim();
    const callbackKey = body.CallbackKey || body.callbackkey || null;
    const triggeredByEmail = instruction.TriggeredByEmail || body.TriggeredByEmail || null;

    if (!cleanBatchId || !triggerId) {
        return { matched: 0, enqueued: 0, executed: 0, results: [] };
    }

    // 1. Fetch matching Layer 2 templates for this triggerId
    const templates = await getStepTriggeredTemplates({
        recipeVersion,
        triggerInstructionId: triggerId,
        activeOnly: true
    });

    if (!templates || templates.length === 0) {
        return { matched: 0, enqueued: 0, executed: 0, results: [] };
    }

    logger.info('StepTriggeredService', `Found ${templates.length} Layer-2 template(s) triggered by "${triggerId}" for Batch "${cleanBatchId}".`);

    const results = [];
    let executedCount = 0;
    let enqueuedCount = 0;

    for (const tpl of templates) {
        try {
            const timeSource = tpl.time_source || 'HISTORIAN_EVENT';
            let resolvedTime = null;
            let resolvedStartTime = null;
            let resolvedEndTime = null;

            if (timeSource === 'HISTORIAN_EVENT') {
                const eventTimes = await resolveHistorianEventTimes(tpl, cleanBatchId);

                // If event timestamp not ready yet, enqueue into background polling queue (case_type: 4)
                if (!eventTimes.isReady) {
                    const queued = await enqueueScheduledInstruction({
                        caseType: CASE_TYPE_EVENT_DEPENDENT,
                        batchId: cleanBatchId,
                        refInstruction: tpl.ref_instruction,
                        tagId: null,
                        scheduledTime: new Date(Date.now() + STEP_EVENT_POLL_INTERVAL_SECONDS * 1000),
                        payload: {
                            template: tpl,
                            cleanBatchId,
                            callbackKey,
                            triggeredByEmail
                        },
                        maxAttempts: STEP_EVENT_MAX_ATTEMPTS
                    });

                    enqueuedCount++;
                    logger.info('StepTriggeredService', `Event for "${tpl.ref_instruction}" not ready (${eventTimes.reason}). Enqueued persistent task ${queued.id} (polling every ${STEP_EVENT_POLL_INTERVAL_SECONDS}s).`);
                    results.push({
                        refInstruction: tpl.ref_instruction,
                        status: 'scheduled',
                        jobId: queued.id,
                        reason: eventTimes.reason
                    });
                    continue;
                }

                resolvedTime = eventTimes.startTime;
                resolvedStartTime = eventTimes.startTime;
                resolvedEndTime = eventTimes.endTime;
            } else if (timeSource === 'PAYLOAD') {
                const payloadTimes = resolvePayloadTimes(tpl, body);
                resolvedTime = payloadTimes.startTime;
                resolvedStartTime = payloadTimes.startTime;
                resolvedEndTime = payloadTimes.endTime;

                const targetDate = payloadTimes.targetDate;
                const nowMs = Date.now();

                // If target time is set in the future, enqueue into scheduled queue
                if (targetDate && targetDate.getTime() > nowMs + 1000) {
                    const targetCase = Number(tpl.event_type);
                    const queued = await enqueueScheduledInstruction({
                        caseType: targetCase,
                        batchId: cleanBatchId,
                        refInstruction: tpl.ref_instruction,
                        tagId: null,
                        scheduledTime: targetDate,
                        payload: {
                            template: tpl,
                            cleanBatchId,
                            callbackKey,
                            triggeredByEmail,
                            ctx: extractInstructionPayload(buildSynthesizedStepInstructionPayload({
                                template: tpl,
                                cleanBatchId,
                                callbackKey,
                                triggeredByEmail,
                                resolvedTime,
                                resolvedStartTime,
                                resolvedEndTime
                            }))
                        },
                        maxAttempts: 3
                    });

                    enqueuedCount++;
                    logger.info('StepTriggeredService', `Payload target time is in the future (${targetDate.toISOString()}). Enqueued one-shot task ${queued.id} for "${tpl.ref_instruction}".`);
                    results.push({
                        refInstruction: tpl.ref_instruction,
                        status: 'scheduled',
                        jobId: queued.id,
                        scheduledTime: targetDate.toISOString()
                    });
                    continue;
                }
            } else {
                // STATIC time_source
                resolvedTime = tpl.ref_time;
                resolvedStartTime = tpl.ref_start_time;
                resolvedEndTime = tpl.ref_end_time;
            }

            // Ready for immediate execution!
            const synthesizedBody = buildSynthesizedStepInstructionPayload({
                template: tpl,
                cleanBatchId,
                callbackKey,
                triggeredByEmail,
                resolvedTime,
                resolvedStartTime,
                resolvedEndTime
            });

            const ctx = extractInstructionPayload(synthesizedBody);
            ctx.batchId = cleanBatchId;
            ctx.callbackKey = callbackKey;
            ctx.triggeredByEmail = triggeredByEmail;
            if (!ctx.refRecipe) ctx.refRecipe = cleanBatchId;

            const eventType = Number(tpl.event_type);
            const mockRes = createMockResponse();
            let dispatchResult = null;

            if (eventType === 1) {
                dispatchResult = await handleCase1PointInTime(ctx, mockRes);
            } else if (eventType === 2) {
                dispatchResult = await handleCase2PhaseTimestamp(ctx, mockRes);
            } else if (eventType === 3) {
                dispatchResult = await handleCase3TimeRange(ctx, mockRes);
            } else {
                throw new Error(`Unsupported EventType ${eventType} for step template "${tpl.ref_instruction}"`);
            }

            const responseData = mockRes.data || dispatchResult || {};
            executedCount++;
            results.push({
                refInstruction: tpl.ref_instruction,
                status: responseData.status || (mockRes.statusCode < 400 ? 'success' : 'error'),
                detail: responseData.message || null,
                data: responseData
            });
        } catch (stepErr) {
            logger.error('StepTriggeredService', `Error executing step template "${tpl.ref_instruction}": ${stepErr.message}`);
            results.push({
                refInstruction: tpl.ref_instruction,
                status: 'error',
                error: stepErr.message
            });
        }
    }

    return {
        batchId: cleanBatchId,
        triggerId,
        matched: templates.length,
        executed: executedCount,
        enqueued: enqueuedCount,
        results
    };
}

