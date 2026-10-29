import { query } from '../db.js';
import { logger } from '../utils/logger.js';
import { extractInstructionPayload } from '../utils/instructionParsers.js';
import { handleCase1PointInTime } from './case1Service.js';
import { handleCase2PhaseTimestamp } from './case2Service.js';
import { handleCase3TimeRange } from './case3Service.js';

let ensureTablePromise = null;

/**
 * Creates an in-memory mock Express response object that captures
 * handler output without HTTP socket overhead.
 */
export function createMockResponse() {
    let statusCode = 200;
    let responseData = null;
    let headersSent = false;

    const res = {
        get headersSent() { return headersSent; },
        get statusCode() { return statusCode; },
        get data() { return responseData; },
        status(code) {
            statusCode = code;
            return res;
        },
        json(data) {
            responseData = data;
            headersSent = true;
            return data;
        },
        send(data) {
            responseData = data;
            headersSent = true;
            return data;
        }
    };
    return res;
}


/**
 * Ensures the predefined_instruction_templates table exists with broken-down attributes.
 * Automatically handles schema migrations and seeds default templates for Recipe v2.1.
 */
export async function ensureTemplateTables() {
    if (!ensureTablePromise) {
        ensureTablePromise = (async () => {
            try {
                await query(`
                    CREATE TABLE IF NOT EXISTS predefined_instruction_templates (
                        id                      SERIAL PRIMARY KEY,
                        name                    TEXT NOT NULL,
                        instruction_id          TEXT,
                        instruction_description TEXT NOT NULL,
                        ref_instruction         TEXT NOT NULL,
                        event_type              INTEGER NOT NULL CHECK (event_type IN (1, 2, 3)),
                        ref_event               TEXT,
                        ref_type                TEXT,
                        ref_element             TEXT,
                        ref_time                TEXT,
                        ref_start_time          TEXT,
                        ref_end_time            TEXT,
                        expected_result         TEXT,
                        is_active               BOOLEAN NOT NULL DEFAULT TRUE,
                        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        UNIQUE (ref_instruction)
                    );

                    -- Safe schema migrations if table existed previously with JSONB
                    ALTER TABLE predefined_instruction_templates ADD COLUMN IF NOT EXISTS instruction_id TEXT;
                    ALTER TABLE predefined_instruction_templates ADD COLUMN IF NOT EXISTS instruction_description TEXT;
                    ALTER TABLE predefined_instruction_templates ADD COLUMN IF NOT EXISTS event_type INTEGER;
                    ALTER TABLE predefined_instruction_templates ADD COLUMN IF NOT EXISTS ref_event TEXT;
                    ALTER TABLE predefined_instruction_templates ADD COLUMN IF NOT EXISTS ref_type TEXT;
                    ALTER TABLE predefined_instruction_templates ADD COLUMN IF NOT EXISTS ref_element TEXT;
                    ALTER TABLE predefined_instruction_templates ADD COLUMN IF NOT EXISTS ref_time TEXT;
                    ALTER TABLE predefined_instruction_templates ADD COLUMN IF NOT EXISTS ref_start_time TEXT;
                    ALTER TABLE predefined_instruction_templates ADD COLUMN IF NOT EXISTS ref_end_time TEXT;
                    ALTER TABLE predefined_instruction_templates ADD COLUMN IF NOT EXISTS expected_result TEXT;

                    -- Drop recipe_version column if present and ensure UNIQUE (ref_instruction)
                    ALTER TABLE predefined_instruction_templates DROP COLUMN IF EXISTS recipe_version CASCADE;

                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_constraint WHERE conname = 'predefined_instruction_templates_ref_instruction_key'
                        ) THEN
                            ALTER TABLE predefined_instruction_templates ADD CONSTRAINT predefined_instruction_templates_ref_instruction_key UNIQUE (ref_instruction);
                        END IF;
                    EXCEPTION WHEN duplicate_table OR duplicate_object THEN
                        -- already exists
                    END $$;

                    CREATE INDEX IF NOT EXISTS idx_predefined_templates_active 
                    ON predefined_instruction_templates (is_active);
                    CREATE INDEX IF NOT EXISTS idx_predefined_templates_ref 
                    ON predefined_instruction_templates (ref_instruction);
                `);

                logger.info('TemplateService', 'predefined_instruction_templates table verified.');
            } catch (err) {
                logger.warn('TemplateService', 'Could not ensure predefined templates table:', err.message);
            }
        })();
    }
    return ensureTablePromise;
}

/**
 * Automatically instantiates and schedules all predefined instructions for a batch.
 * Triggered exclusively when an On-Demand HEALTH_CHECK evaluates to PASSED.
 *
 * @param {Object} options
 * @param {string} options.batchId - The batch identifier (e.g. VV_261022_PoC_1 or B-2026-0001)
 * @param {string} [options.callbackKey] - BatchLine callback key
 * @param {string} [options.triggeredByEmail] - Operator email triggering the health check
 * @returns {Promise<Object>} Summary of instantiated tasks
 */
export async function instantiatePredefinedBatchInstructions({
    batchId,
    callbackKey = null,
    triggeredByEmail = null
}) {
    if (!batchId || batchId === 'UNKNOWN' || typeof batchId !== 'string' || !batchId.trim()) {
        logger.warn('TemplateService', 'Skipping template instantiation: invalid or missing BatchId');
        return { total: 0, enqueued: 0, results: [] };
    }

    const cleanBatchId = String(batchId || '').replace(/[\[\]]/g, '').trim();
    await ensureTemplateTables();

    // 1. Fetch active templates with all broken-down columns
    const { rows: templates } = await query(`
        SELECT 
            id, name, instruction_id, instruction_description,
            ref_instruction, event_type, ref_event, ref_type, ref_element,
            ref_time, ref_start_time, ref_end_time, expected_result
        FROM predefined_instruction_templates
        WHERE is_active = TRUE
        ORDER BY id ASC;
    `);

    if (templates.length === 0) {
        logger.info('TemplateService', 'No active predefined instruction templates found.');
        return { total: 0, enqueued: 0, results: [] };
    }

    logger.info('TemplateService', `Instantiating ${templates.length} predefined instruction(s) for Batch "${cleanBatchId}"...`);

    const results = [];
    let enqueuedCount = 0;

    for (const tpl of templates) {
        // 2. Synthesize BatchLine Instruction object mirroring actual BatchLine request schema 1:1
        const synthesizedInstruction = {
            InstructionId: tpl.instruction_id || tpl.ref_instruction,
            InstructionDescription: tpl.instruction_description || '',
            InstructionType: 'Instruction',
            ExpectedResult: tpl.expected_result || null,
            RefElement: tpl.ref_element || null,
            RefTime: tpl.ref_time || null,
            RefRecipe: cleanBatchId,
            RefEvent: tpl.ref_event || null,
            RefStartTime: tpl.ref_start_time || null,
            RefEndTime: tpl.ref_end_time || null,
            RefType: tpl.ref_type || null,
            RefInstruction: tpl.ref_instruction,
            EventType: Number(tpl.event_type),
            TriggeredByEmail: triggeredByEmail || null,
            ActualResult: null
        };

        const synthesizedBody = {
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

        const ctx = extractInstructionPayload(synthesizedBody);
        ctx.batchId = cleanBatchId;
        ctx.callbackKey = callbackKey;
        ctx.triggeredByEmail = triggeredByEmail;
        if (!ctx.refRecipe) ctx.refRecipe = cleanBatchId;

        const eventType = Number(ctx.rawEventType || tpl.event_type);
        const mockRes = createMockResponse();

        try {
            let dispatchResult = null;
            if (eventType === 1) {
                dispatchResult = await handleCase1PointInTime(ctx, mockRes);
            } else if (eventType === 2) {
                dispatchResult = await handleCase2PhaseTimestamp(ctx, mockRes);
            } else if (eventType === 3) {
                dispatchResult = await handleCase3TimeRange(ctx, mockRes);
            } else {
                throw new Error(`Unsupported EventType ${eventType} for instruction "${tpl.ref_instruction}"`);
            }

            const responseData = mockRes.data || dispatchResult || {};
            const isScheduled = responseData.status === 'scheduled';
            const isSuccess = responseData.status === 'success';

            if (isScheduled || isSuccess) {
                enqueuedCount++;
            }

            results.push({
                refInstruction: tpl.ref_instruction,
                name: tpl.name,
                eventType,
                refEvent: tpl.ref_event,
                refType: tpl.ref_type,
                status: responseData.status || (mockRes.statusCode < 400 ? 'ok' : 'error'),
                jobId: responseData.job_id || null,
                detail: responseData.message || null
            });
        } catch (dispatchErr) {
            logger.error('TemplateService', `Error instantiating template "${tpl.ref_instruction}": ${dispatchErr.message}`);
            results.push({
                refInstruction: tpl.ref_instruction,
                name: tpl.name,
                eventType,
                status: 'error',
                error: dispatchErr.message
            });
        }
    }

    logger.info('TemplateService', `Completed template instantiation for Batch "${cleanBatchId}": ${enqueuedCount}/${templates.length} enqueued/processed.`);
    return {
        batchId: cleanBatchId,
        total: templates.length,
        enqueued: enqueuedCount,
        results
    };
}

/**
 * Fetch list of predefined templates with clean broken-down attributes.
 */
export async function getPredefinedTemplates({ activeOnly = false } = {}) {
    await ensureTemplateTables();
    let sql = `
        SELECT 
            id, name, instruction_id, instruction_description,
            ref_instruction, event_type, ref_event, ref_type, ref_element,
            ref_time, ref_start_time, ref_end_time, expected_result,
            is_active, created_at, updated_at
        FROM predefined_instruction_templates 
        WHERE 1=1
    `;
    const params = [];

    
    if (activeOnly) {
        sql += ' AND is_active = TRUE';
    }
    sql += ' ORDER BY id ASC';

    const { rows } = await query(sql, params);
    return rows;
}

/**
 * Upsert a predefined instruction template with broken-down attributes.
 */
export async function upsertPredefinedTemplate({
    name,
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
    isActive = true
}) {
    await ensureTemplateTables();
    const cleanRef = String(refInstruction).trim().toUpperCase();

    const { rows } = await query(`
        INSERT INTO predefined_instruction_templates 
        (
            name, instruction_id, instruction_description, 
            ref_instruction, event_type, ref_event, ref_type, 
            ref_element, ref_time, ref_start_time, ref_end_time, 
            expected_result, is_active, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
        ON CONFLICT (ref_instruction) DO UPDATE
        SET name = EXCLUDED.name,
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
            updated_at = NOW()
        RETURNING *;
    `, [
        name,
        instructionId,
        instructionDescription,
        cleanRef,
        Number(eventType),
        refEvent,
        refType,
        refElement,
        refTime,
        refStartTime,
        refEndTime,
        expectedResult,
        isActive
    ]);

    return rows[0];
}
