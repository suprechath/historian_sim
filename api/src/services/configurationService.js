import { query } from '../db.js';
import { logger } from '../utils/logger.js';

let ensureTablesPromise = null;

/**
 * Ensures both predefined_instruction_templates and step_triggered_instruction_templates exist.
 */
export async function ensureConfigurationTables() {
    if (!ensureTablesPromise) {
        ensureTablesPromise = (async () => {
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

                    CREATE INDEX IF NOT EXISTS idx_predefined_templates_active 
                    ON predefined_instruction_templates (is_active);

                    CREATE INDEX IF NOT EXISTS idx_predefined_templates_ref 
                    ON predefined_instruction_templates (ref_instruction);

                    CREATE TABLE IF NOT EXISTS step_triggered_instruction_templates (
                        id                          SERIAL PRIMARY KEY,
                        name                        TEXT NOT NULL,
                        trigger_instruction_id      TEXT NOT NULL,
                        time_source                 TEXT NOT NULL CHECK (time_source IN ('HISTORIAN_EVENT', 'PAYLOAD', 'STATIC')),
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
                        ref_start_event             TEXT,
                        ref_start_type              TEXT DEFAULT 'StartTime' CHECK (ref_start_type IN ('StartTime', 'EndTime')),
                        ref_end_event               TEXT,
                        ref_end_type                TEXT CHECK (ref_end_type IS NULL OR ref_end_type IN ('StartTime', 'EndTime')),
                        payload_start_field         TEXT DEFAULT 'ActualResult',
                        payload_end_field           TEXT,
                        offset_duration_ms          INTEGER DEFAULT 0,
                        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        UNIQUE (trigger_instruction_id, ref_instruction)
                    );

                    CREATE INDEX IF NOT EXISTS idx_step_templates_trigger 
                    ON step_triggered_instruction_templates (trigger_instruction_id, is_active);

                    CREATE INDEX IF NOT EXISTS idx_step_templates_ref 
                    ON step_triggered_instruction_templates (ref_instruction);
                `);
                logger.info('ConfigurationService', 'Configuration tables verified.');
            } catch (err) {
                logger.warn('ConfigurationService', 'Could not ensure configuration tables:', { error: err.message });
            }
        })();
    }
    return ensureTablesPromise;
}

/**
 * Returns metadata for autocomplete dropdowns (available tags, recipe phases).
 */
export async function getConfigurationMeta() {
    await ensureConfigurationTables();

    let tags = [];
    let phases = [];

    try {
        const tagRes = await query(`
            SELECT t.name, t.parameter, a.code AS asset_code
            FROM tags t
            JOIN assets a ON t.asset_id = a.id
            ORDER BY t.name ASC;
        `);
        tags = tagRes.rows;
    } catch (_) {
        tags = [];
    }

    try {
        const phaseRes = await query(`
            SELECT DISTINCT name
            FROM events
            WHERE level = 'Phase' AND name IS NOT NULL
            ORDER BY name ASC;
        `);
        phases = phaseRes.rows.map(r => r.name);
    } catch (_) {
        phases = [];
    }

    if (phases.length === 0) {
        phases = ['Charging', 'Heating', 'Reaction hold', 'Cooling', 'Filter & transfer'];
    }

    return { tags, phases };
}

// ============================================================================
// 1. PREDEFINED INSTRUCTION TEMPLATES (Layer-1 Base Batch Templates)
// ============================================================================

export async function getPredefinedTemplates() {
    await ensureConfigurationTables();
    const { rows } = await query(`
        SELECT 
            id,
            name,
            instruction_id,
            instruction_description,
            ref_instruction,
            event_type,
            ref_event,
            ref_type,
            ref_element,
            ref_time,
            ref_start_time,
            ref_end_time,
            expected_result,
            is_active,
            created_at,
            updated_at
        FROM predefined_instruction_templates
        ORDER BY id ASC;
    `);
    return rows;
}

export async function createPredefinedTemplate(tpl) {
    await ensureConfigurationTables();
    const {
        name,
        instruction_id = null,
        instruction_description = '[SCHEDULE]',
        ref_instruction,
        event_type = 2,
        ref_event = null,
        ref_type = 'StartTime',
        ref_element = null,
        ref_time = null,
        ref_start_time = null,
        ref_end_time = null,
        expected_result = null,
        is_active = true
    } = tpl;

    if (!name || !ref_instruction) {
        throw new Error('Template name and ref_instruction are required');
    }

    const { rows } = await query(`
        INSERT INTO predefined_instruction_templates (
            name, instruction_id, instruction_description, ref_instruction,
            event_type, ref_event, ref_type, ref_element,
            ref_time, ref_start_time, ref_end_time, expected_result,
            is_active, updated_at
        ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8,
            $9, $10, $11, $12,
            $13, NOW()
        )
        RETURNING *;
    `, [
        name, instruction_id, instruction_description, ref_instruction,
        event_type, ref_event, ref_type, ref_element,
        ref_time, ref_start_time, ref_end_time, expected_result,
        Boolean(is_active)
    ]);
    return rows[0];
}

export async function updatePredefinedTemplate(id, tpl) {
    await ensureConfigurationTables();
    const {
        name,
        instruction_id = null,
        instruction_description,
        ref_instruction,
        event_type,
        ref_event = null,
        ref_type = null,
        ref_element = null,
        ref_time = null,
        ref_start_time = null,
        ref_end_time = null,
        expected_result = null,
        is_active
    } = tpl;

    const { rows } = await query(`
        UPDATE predefined_instruction_templates
        SET
            name = COALESCE($1, name),
            instruction_id = $2,
            instruction_description = COALESCE($3, instruction_description),
            ref_instruction = COALESCE($4, ref_instruction),
            event_type = COALESCE($5, event_type),
            ref_event = $6,
            ref_type = $7,
            ref_element = $8,
            ref_time = $9,
            ref_start_time = $10,
            ref_end_time = $11,
            expected_result = $12,
            is_active = COALESCE($13, is_active),
            updated_at = NOW()
        WHERE id = $14
        RETURNING *;
    `, [
        name, instruction_id, instruction_description, ref_instruction,
        event_type, ref_event, ref_type, ref_element,
        ref_time, ref_start_time, ref_end_time, expected_result,
        is_active, id
    ]);

    if (rows.length === 0) {
        throw new Error(`Predefined template id ${id} not found`);
    }
    return rows[0];
}

export async function togglePredefinedTemplate(id) {
    await ensureConfigurationTables();
    const { rows } = await query(`
        UPDATE predefined_instruction_templates
        SET is_active = NOT is_active, updated_at = NOW()
        WHERE id = $1
        RETURNING *;
    `, [id]);
    if (rows.length === 0) {
        throw new Error(`Predefined template id ${id} not found`);
    }
    return rows[0];
}

export async function deletePredefinedTemplate(id) {
    await ensureConfigurationTables();
    const { rows } = await query(`
        DELETE FROM predefined_instruction_templates
        WHERE id = $1
        RETURNING *;
    `, [id]);
    if (rows.length === 0) {
        throw new Error(`Predefined template id ${id} not found`);
    }
    return rows[0];
}

// ============================================================================
// 2. STEP-TRIGGERED INSTRUCTION TEMPLATES (Layer-2 On-Demand Schedulers)
// ============================================================================

export async function getStepTriggeredTemplates() {
    await ensureConfigurationTables();
    const { rows } = await query(`
        SELECT 
            id,
            name,
            trigger_instruction_id,
            time_source,
            instruction_id,
            instruction_description,
            ref_instruction,
            event_type,
            ref_event,
            ref_type,
            ref_element,
            ref_time,
            ref_start_time,
            ref_end_time,
            expected_result,
            is_active,
            ref_start_event,
            ref_start_type,
            ref_end_event,
            ref_end_type,
            payload_start_field,
            payload_end_field,
            offset_duration_ms,
            created_at,
            updated_at
        FROM step_triggered_instruction_templates
        ORDER BY id ASC;
    `);
    return rows;
}

export async function createStepTriggeredTemplate(tpl) {
    await ensureConfigurationTables();
    const {
        name,
        trigger_instruction_id,
        time_source = 'HISTORIAN_EVENT',
        instruction_id = null,
        instruction_description = '[RECORD]',
        ref_instruction,
        event_type = 3,
        ref_event = null,
        ref_type = 'MAX',
        ref_element = null,
        ref_time = null,
        ref_start_time = null,
        ref_end_time = null,
        expected_result = null,
        is_active = true,
        ref_start_event = null,
        ref_start_type = 'StartTime',
        ref_end_event = null,
        ref_end_type = null,
        payload_start_field = 'ActualResult',
        payload_end_field = null,
        offset_duration_ms = 0
    } = tpl;

    if (!name || !trigger_instruction_id || !ref_instruction) {
        throw new Error('Template name, trigger_instruction_id, and ref_instruction are required');
    }

    const { rows } = await query(`
        INSERT INTO step_triggered_instruction_templates (
            name, trigger_instruction_id, time_source,
            instruction_id, instruction_description, ref_instruction,
            event_type, ref_event, ref_type, ref_element,
            ref_time, ref_start_time, ref_end_time, expected_result, is_active,
            ref_start_event, ref_start_type, ref_end_event, ref_end_type,
            payload_start_field, payload_end_field, offset_duration_ms,
            updated_at
        ) VALUES (
            $1, $2, $3,
            $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13, $14, $15,
            $16, $17, $18, $19,
            $20, $21, $22,
            NOW()
        )
        RETURNING *;
    `, [
        name, trigger_instruction_id, time_source,
        instruction_id, instruction_description, ref_instruction,
        event_type, ref_event, ref_type, ref_element,
        ref_time, ref_start_time, ref_end_time, expected_result, Boolean(is_active),
        ref_start_event, ref_start_type, ref_end_event, ref_end_type,
        payload_start_field, payload_end_field, parseInt(offset_duration_ms, 10) || 0
    ]);
    return rows[0];
}

export async function updateStepTriggeredTemplate(id, tpl) {
    await ensureConfigurationTables();
    const {
        name,
        trigger_instruction_id,
        time_source,
        instruction_id = null,
        instruction_description,
        ref_instruction,
        event_type,
        ref_event = null,
        ref_type = null,
        ref_element = null,
        ref_time = null,
        ref_start_time = null,
        ref_end_time = null,
        expected_result = null,
        is_active,
        ref_start_event = null,
        ref_start_type = 'StartTime',
        ref_end_event = null,
        ref_end_type = null,
        payload_start_field = 'ActualResult',
        payload_end_field = null,
        offset_duration_ms = 0
    } = tpl;

    const { rows } = await query(`
        UPDATE step_triggered_instruction_templates
        SET
            name = COALESCE($1, name),
            trigger_instruction_id = COALESCE($2, trigger_instruction_id),
            time_source = COALESCE($3, time_source),
            instruction_id = $4,
            instruction_description = COALESCE($5, instruction_description),
            ref_instruction = COALESCE($6, ref_instruction),
            event_type = COALESCE($7, event_type),
            ref_event = $8,
            ref_type = $9,
            ref_element = $10,
            ref_time = $11,
            ref_start_time = $12,
            ref_end_time = $13,
            expected_result = $14,
            is_active = COALESCE($15, is_active),
            ref_start_event = $16,
            ref_start_type = $17,
            ref_end_event = $18,
            ref_end_type = $19,
            payload_start_field = $20,
            payload_end_field = $21,
            offset_duration_ms = $22,
            updated_at = NOW()
        WHERE id = $23
        RETURNING *;
    `, [
        name, trigger_instruction_id, time_source,
        instruction_id, instruction_description, ref_instruction,
        event_type, ref_event, ref_type, ref_element,
        ref_time, ref_start_time, ref_end_time, expected_result, is_active,
        ref_start_event, ref_start_type, ref_end_event, ref_end_type,
        payload_start_field, payload_end_field, parseInt(offset_duration_ms, 10) || 0,
        id
    ]);

    if (rows.length === 0) {
        throw new Error(`Step triggered template id ${id} not found`);
    }
    return rows[0];
}

export async function toggleStepTriggeredTemplate(id) {
    await ensureConfigurationTables();
    const { rows } = await query(`
        UPDATE step_triggered_instruction_templates
        SET is_active = NOT is_active, updated_at = NOW()
        WHERE id = $1
        RETURNING *;
    `, [id]);
    if (rows.length === 0) {
        throw new Error(`Step triggered template id ${id} not found`);
    }
    return rows[0];
}

export async function deleteStepTriggeredTemplate(id) {
    await ensureConfigurationTables();
    const { rows } = await query(`
        DELETE FROM step_triggered_instruction_templates
        WHERE id = $1
        RETURNING *;
    `, [id]);
    if (rows.length === 0) {
        throw new Error(`Step triggered template id ${id} not found`);
    }
    return rows[0];
}
