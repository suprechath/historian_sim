import { query } from '../db.js';
import { logger } from '../utils/logger.js';

let ensureTablePromise = null;

/**
 * Ensures the persistent scheduled_instructions table and indexes exist in PostgreSQL.
 */
export async function ensureScheduledInstructionsTable() {
    if (!ensureTablePromise) {
        ensureTablePromise = (async () => {
            try {
                await query(`
                    CREATE TABLE IF NOT EXISTS scheduled_instructions (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        case_type INT NOT NULL,
                        batch_id TEXT,
                        ref_instruction TEXT NOT NULL,
                        tag_id INT,
                        scheduled_time TIMESTAMPTZ NOT NULL,
                        payload JSONB NOT NULL,
                        status TEXT NOT NULL DEFAULT 'pending',
                        attempts INT NOT NULL DEFAULT 0,
                        max_attempts INT NOT NULL DEFAULT 3,
                        last_error TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        executed_at TIMESTAMPTZ
                    );

                    CREATE INDEX IF NOT EXISTS idx_scheduled_instructions_due 
                    ON scheduled_instructions (scheduled_time, status) 
                    WHERE status = 'pending';

                    CREATE INDEX IF NOT EXISTS idx_scheduled_instructions_active_ref 
                    ON scheduled_instructions (batch_id, ref_instruction) 
                    WHERE status = 'pending';
                `);
                logger.info('ScheduledService', 'Scheduled instructions table and indexes verified.');
            } catch (err) {
                logger.warn('ScheduledService', 'Could not ensure scheduled_instructions table:', { error: err.message });
            }
        })();
    }
    return ensureTablePromise;
}

/**
 * Retrieves scheduled instructions with flexible filtering, search, and pagination.
 *
 * @param {Object} options
 * @param {string} [options.status='pending'] - Filter by status ('pending', 'completed', 'cancelled', 'failed', 'processing', 'all')
 * @param {number} [options.caseType] - Filter by case_type (1, 2, 3, 4)
 * @param {string} [options.batchId] - Filter by exact or partial batch_id
 * @param {string} [options.search] - Search across batch_id, ref_instruction, last_error
 * @param {number} [options.limit=100] - Limit of tasks returned
 * @param {number} [options.offset=0] - Pagination offset
 * @param {string} [options.sortBy] - Sort column ('scheduled_time', 'created_at', 'status', 'batch_id', 'attempts')
 * @param {string} [options.sortOrder='asc'] - Sort direction ('asc', 'desc')
 */
export async function getScheduledInstructions({
    status = 'pending',
    caseType,
    batchId,
    search,
    limit = 100,
    offset = 0,
    sortBy,
    sortOrder
} = {}) {
    await ensureScheduledInstructionsTable();

    const conditions = [];
    const params = [];

    // Status filter: 'pending' (default) excludes completed and cancelled
    if (status && status !== 'all' && status !== 'ALL') {
        params.push(status.toLowerCase());
        conditions.push(`s.status = $${params.length}`);
    }

    // Case type filter
    if (caseType !== undefined && caseType !== null && !isNaN(caseType)) {
        params.push(parseInt(caseType, 10));
        conditions.push(`s.case_type = $${params.length}`);
    }

    // Batch ID filter
    if (batchId && String(batchId).trim() !== '') {
        params.push(`%${String(batchId).trim()}%`);
        conditions.push(`s.batch_id ILIKE $${params.length}`);
    }

    // Text search filter
    if (search && String(search).trim() !== '') {
        params.push(`%${String(search).trim()}%`);
        conditions.push(`(
            s.batch_id ILIKE $${params.length}
            OR s.ref_instruction ILIKE $${params.length}
            OR s.last_error ILIKE $${params.length}
            OR (s.payload->>'refEvent') ILIKE $${params.length}
            OR (s.payload->>'instructionDescription') ILIKE $${params.length}
        )`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count matching
    const countSql = `SELECT COUNT(*)::int AS total FROM scheduled_instructions s ${whereClause};`;
    const { rows: countRows } = await query(countSql, params);
    const totalMatching = countRows[0]?.total || 0;

    // Sorting logic
    const safeSortCols = {
        scheduled_time: 's.scheduled_time',
        created_at: 's.created_at',
        executed_at: 's.executed_at',
        status: 's.status',
        batch_id: 's.batch_id',
        ref_instruction: 's.ref_instruction',
        case_type: 's.case_type',
        attempts: 's.attempts'
    };

    const direction = (sortOrder && String(sortOrder).toLowerCase() === 'desc') ? 'DESC' : 'ASC';
    let orderClause = '';

    if (sortBy && safeSortCols[sortBy]) {
        orderClause = `ORDER BY ${safeSortCols[sortBy]} ${direction} NULLS LAST`;
    } else if (status === 'pending') {
        // Pending tasks: soonest due first
        orderClause = 'ORDER BY s.scheduled_time ASC, s.created_at ASC';
    } else {
        // History / all tasks: newest first
        orderClause = 'ORDER BY s.created_at DESC, s.scheduled_time DESC';
    }

    const queryParams = [...params];
    queryParams.push(Math.max(1, Math.min(500, parseInt(limit, 10) || 100)));
    const limitPlaceholder = `$${queryParams.length}`;

    queryParams.push(Math.max(0, parseInt(offset, 10) || 0));
    const offsetPlaceholder = `$${queryParams.length}`;

    const dataSql = `
        SELECT 
            s.id,
            s.case_type,
            s.batch_id,
            s.ref_instruction,
            s.tag_id,
            s.scheduled_time,
            s.payload,
            s.status,
            s.attempts,
            s.max_attempts,
            s.last_error,
            s.created_at,
            s.executed_at,
            t.name AS tag_name
        FROM scheduled_instructions s
        LEFT JOIN tags t ON s.tag_id = t.id
        ${whereClause}
        ${orderClause}
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder};
    `;

    const { rows: tasks } = await query(dataSql, queryParams);

    return {
        tasks,
        totalMatching
    };
}

/**
 * Returns aggregated metrics for the scheduled instructions queue.
 */
export async function getScheduledInstructionsSummary() {
    await ensureScheduledInstructionsTable();

    const sql = `
        SELECT 
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
            COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_count,
            COUNT(*) FILTER (WHERE status = 'completed' AND (executed_at >= NOW() - INTERVAL '24 hours' OR executed_at IS NULL))::int AS completed_24h,
            COUNT(*) FILTER (WHERE status = 'failed' AND (executed_at >= NOW() - INTERVAL '24 hours' OR executed_at IS NULL))::int AS failed_24h,
            COUNT(*) FILTER (WHERE status = 'cancelled' AND (executed_at >= NOW() - INTERVAL '24 hours' OR executed_at IS NULL))::int AS cancelled_24h,
            COUNT(*)::int AS total_all_time,
            MIN(scheduled_time) FILTER (WHERE status = 'pending') AS earliest_pending_time
        FROM scheduled_instructions;
    `;

    const { rows } = await query(sql);
    const summary = rows[0] || {};

    return {
        pendingCount: summary.pending_count || 0,
        processingCount: summary.processing_count || 0,
        completed24hCount: summary.completed_24h || 0,
        failed24hCount: summary.failed_24h || 0,
        cancelled24hCount: summary.cancelled_24h || 0,
        totalAllTime: summary.total_all_time || 0,
        earliestPendingTime: summary.earliest_pending_time || null
    };
}

/**
 * Retrieves a single scheduled instruction by ID with full details.
 */
export async function getScheduledInstructionById(id) {
    await ensureScheduledInstructionsTable();

    const { rows } = await query(`
        SELECT 
            s.id,
            s.case_type,
            s.batch_id,
            s.ref_instruction,
            s.tag_id,
            s.scheduled_time,
            s.payload,
            s.status,
            s.attempts,
            s.max_attempts,
            s.last_error,
            s.created_at,
            s.executed_at,
            t.name AS tag_name
        FROM scheduled_instructions s
        LEFT JOIN tags t ON s.tag_id = t.id
        WHERE s.id = $1;
    `, [id]);

    return rows[0] || null;
}

/**
 * Cancels a pending scheduled instruction.
 *
 * @param {string} id - Task UUID
 * @param {string} [reason='Cancelled by operator via UI'] - Cancellation reason
 */
export async function cancelScheduledInstruction(id, reason = 'Cancelled by operator via UI') {
    await ensureScheduledInstructionsTable();

    const current = await getScheduledInstructionById(id);
    if (!current) {
        throw new Error(`Scheduled instruction '${id}' not found`);
    }

    if (current.status !== 'pending') {
        throw new Error(`Cannot cancel task '${id}' because its status is '${current.status}' (only 'pending' tasks can be cancelled)`);
    }

    const { rows } = await query(`
        UPDATE scheduled_instructions
        SET status = 'cancelled',
            last_error = $2,
            executed_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING *;
    `, [id, reason || 'Cancelled by operator via UI']);

    if (rows.length === 0) {
        throw new Error(`Task '${id}' was modified by another process during cancellation`);
    }

    logger.info('ScheduledService', `Cancelled scheduled instruction ${id} (Batch: ${current.batch_id}, Ref: ${current.ref_instruction})`);
    return rows[0];
}

/**
 * Triggers a pending scheduled instruction for immediate execution by setting scheduled_time to NOW().
 *
 * @param {string} id - Task UUID
 */
export async function triggerScheduledInstructionNow(id) {
    await ensureScheduledInstructionsTable();

    const current = await getScheduledInstructionById(id);
    if (!current) {
        throw new Error(`Scheduled instruction '${id}' not found`);
    }

    if (current.status !== 'pending') {
        throw new Error(`Cannot trigger task '${id}' because its status is '${current.status}' (only 'pending' tasks can be triggered)`);
    }

    const { rows } = await query(`
        UPDATE scheduled_instructions
        SET scheduled_time = NOW(),
            last_error = 'Triggered immediately by operator'
        WHERE id = $1 AND status = 'pending'
        RETURNING *;
    `, [id]);

    if (rows.length === 0) {
        throw new Error(`Task '${id}' was modified by another process`);
    }

    logger.info('ScheduledService', `Triggered immediate execution for task ${id} (Batch: ${current.batch_id}, Ref: ${current.ref_instruction})`);
    return rows[0];
}

