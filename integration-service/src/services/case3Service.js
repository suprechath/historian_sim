import { EXTERNAL_CONFIG, STAT_OPERATIONS } from '../config/externalConfig.js';
import { logger } from '../utils/logger.js';
import { query } from '../db.js';
import {
    formatReadingValue,
    formatExecutedTimestamp,
    parseBatchLineDate
} from '../utils/formatters.js';
import {
    getCombinedDescription,
    extractInterpretMapping,
    parseRecordInstructionConfig
} from '../utils/instructionParsers.js';
import { reportError, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';
import { resolveTag } from '../dal/externalDal.js';
import {
    resolveMetric,
    resolveWaveDirections,
    detectWaveInReadings,
    buildIntervalConsolidatedValues
} from './mathService.js';
import { handleContinuousIntervalMode } from './continuousIntervalService.js';

/**
 * Case 3 - Submode: Profile Wave Detection & Downsampling
 */
export async function handleProfileMode(ctx, res, tag, actualStart, actualEnd, profileConfig, intervalConfig = null, interpretConfig = null) {
    const startThreshold = profileConfig.start;
    const stopThreshold = profileConfig.stop;

    const { rows } = await query(`
        SELECT ts, value
        FROM readings
        WHERE tag_id = $1
          AND ts >= $2::timestamptz
          AND ts <= $3::timestamptz
        ORDER BY ts ASC;
    `, [tag.id, actualStart, actualEnd]);

    if (rows.length === 0) {
        const errMsg = `No readings found for tag "${tag.name}" between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`;
        await reportError(`[BatchLine Profile]: ${errMsg}`, ctx);
        return res.status(404).json({ error: errMsg });
    }

    const { waveStartTs: detectedStartTs, waveStopTs: detectedStopTs, startDirection } = detectWaveInReadings(rows, profileConfig);
    let waveStartTs = detectedStartTs;
    let waveStopTs = detectedStopTs;

    if (!waveStartTs) {
        const errMsg = `Reading value for tag "${tag.name}" never ${startDirection === 'rise' ? 'rose to or above' : 'fell to or below'} START threshold (${startThreshold}) between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`;
        await reportError(`[BatchLine Profile]: ${errMsg}`, ctx);
        return res.status(404).json({ error: errMsg });
    }

    if (!waveStopTs) {
        if (profileConfig.durationMinutes !== null && profileConfig.durationMinutes > 0) {
            const targetStop = new Date(new Date(waveStartTs).getTime() + profileConfig.durationMinutes * 60 * 1000);
            const lastTs = new Date(rows[rows.length - 1].ts);
            waveStopTs = (targetStop < lastTs) ? targetStop.toISOString() : lastTs.toISOString();
        } else {
            waveStopTs = rows[rows.length - 1].ts;
        }
    }

    const waveStart = new Date(waveStartTs);
    const waveStop = new Date(waveStopTs);

    const waveRows = rows.filter(r => {
        if (r.value === null || r.value === undefined || Number.isNaN(Number(r.value))) return false;
        const t = new Date(r.ts).getTime();
        return t >= waveStart.getTime() && t <= waveStop.getTime();
    });

    const totalCount = waveRows.length;
    if (totalCount === 0) {
        const errMsg = `No readings found for tag "${tag.name}" in the captured wave between ${waveStart.toISOString()} and ${waveStop.toISOString()}`;
        await reportError(`[BatchLine Profile]: ${errMsg}`, ctx);
        return res.status(404).json({ error: errMsg });
    }

    let valuesToSend = [];
    const durationMs = waveStop.getTime() - waveStart.getTime();

    if (intervalConfig && intervalConfig.intervalMs) {
        valuesToSend = buildIntervalConsolidatedValues(
            waveRows,
            waveStart,
            waveStop,
            intervalConfig.intervalMs,
            profileConfig.metric || 'avg',
            tag.display_digits,
            startThreshold,
            interpretConfig
        );
    } else if (totalCount <= EXTERNAL_CONFIG.MAX_PROFILE_SAMPLES || durationMs <= 1000) {
        valuesToSend = waveRows.slice(0, EXTERNAL_CONFIG.MAX_PROFILE_SAMPLES).map((r, idx) => {
            const standardFormattedValue = formatReadingValue(r.value, tag.display_digits);
            const formattedValue = interpretConfig ? interpretConfig.interpret(r.value) : standardFormattedValue;
            return {
                repeat_no: idx + 1,
                value: formattedValue,
                standard_formatted_value: standardFormattedValue,
                raw_value: r.value,
                ts: r.ts,
                executed_timestamp: formatExecutedTimestamp(r.ts)
            };
        });
    } else {
        const sampleCount = EXTERNAL_CONFIG.MAX_PROFILE_SAMPLES || 30;
        const lastBucketIndex = sampleCount - 1;

        const { rows: bucketRows } = await query(`
            WITH bounds AS (
                SELECT $2::timestamptz AS t_start, $3::timestamptz AS t_end
            ),
            buckets AS (
                SELECT 
                    i AS bucket_no,
                    t_start + (i * (t_end - t_start) / $4) AS b_start,
                    t_start + ((i + 1) * (t_end - t_start) / $4) AS b_end
                FROM bounds, generate_series(0, $5) AS i
            )
            SELECT 
                b.bucket_no,
                b.b_start,
                b.b_end,
                AVG(r.value) AS avg_val,
                MIN(r.value) AS min_val,
                MAX(r.value) AS max_val,
                COUNT(r.value)::int AS samples
            FROM buckets b
            LEFT JOIN readings r 
              ON r.tag_id = $1 
             AND r.ts >= b.b_start 
             AND (CASE WHEN b.bucket_no = $5 THEN r.ts <= b.b_end ELSE r.ts < b.b_end END)
            GROUP BY b.bucket_no, b.b_start, b.b_end
            ORDER BY b.bucket_no;
        `, [tag.id, waveStart, waveStop, sampleCount, lastBucketIndex]);

        let lastKnown = null;
        const bucketList = bucketRows.map(r => {
            let metricVal = null;
            if (profileConfig.metric === 'min') metricVal = r.min_val;
            else if (profileConfig.metric === 'max') metricVal = r.max_val;
            else metricVal = r.avg_val;

            if (metricVal !== null && metricVal !== undefined) {
                lastKnown = Number(metricVal);
            }
            return {
                bucket_no: r.bucket_no,
                b_start: r.b_start,
                b_end: r.b_end,
                value: (metricVal !== null && metricVal !== undefined) ? Number(metricVal) : lastKnown,
                samples: r.samples
            };
        });

        const firstKnown = bucketList.find(b => b.value !== null)?.value ?? startThreshold;
        valuesToSend = bucketList.map((b, idx) => {
            const resolvedVal = b.value !== null ? b.value : firstKnown;
            const standardFormattedValue = formatReadingValue(resolvedVal, tag.display_digits);
            const formattedValue = interpretConfig ? interpretConfig.interpret(resolvedVal) : standardFormattedValue;
            return {
                repeat_no: idx + 1,
                value: formattedValue,
                standard_formatted_value: standardFormattedValue,
                raw_value: resolvedVal,
                bucket_start: b.b_start,
                bucket_end: b.b_end,
                samples: b.samples,
                executed_timestamp: formatExecutedTimestamp(b.b_start)
            };
        });
    }

    if (interpretConfig) {
        logger.info('Case3Profile', `Applied [INTERPRET] mapping on tag "${tag.name}" (${interpretConfig.raw})`);
    }

    logger.info('Case3Profile', `Pushing ${valuesToSend.length} values for captured first wave...`);
    const actualResult = valuesToSend.map((item, idx) => ({
        repeat_no: item.repeat_no || (idx + 1),
        value: item.value,
        executed_timestamp: item.executed_timestamp || formatExecutedTimestamp(item.bucket_start || item.ts),
        executed_user_email: ctx.triggeredByEmail || null
    }));

    const cbResult = await sendBatchLineInstructionUpdate({
        refInstruction: ctx.refInstruction,
        batchId: ctx.batchId,
        callbackKey: ctx.callbackKey,
        actualResult
    });

    if (!cbResult?.ok) {
        await reportError(`Failed to update BatchLine Case 3 profile (${valuesToSend.length} items)`, ctx, cbResult?.data?.error?.detail || cbResult?.error);
    }

    return res.json({
        status: 'success',
        case: 3,
        mode: 'record_profile',
        batch_id: ctx.batchId,
        tag: tag.name,
        metric: (profileConfig.metric || 'avg').toUpperCase(),
        ref_type: ctx.refType,
        start_threshold: startThreshold,
        stop_threshold: profileConfig.stop ?? null,
        duration_minutes: profileConfig.durationMinutes ?? null,
        direction: startDirection,
        interval: intervalConfig ? intervalConfig.rawInterval : null,
        interval_minutes: intervalConfig ? intervalConfig.intervalMinutes : null,
        interpret: interpretConfig ? { raw: interpretConfig.raw, mapping: interpretConfig.mapping } : null,
        wave_start: waveStart.toISOString(),
        wave_stop: waveStop.toISOString(),
        wave_duration_sec: Math.max(1, (waveStop - waveStart) / 1000),
        total_samples: totalCount,
        records_sent: valuesToSend.length,
        records: valuesToSend,
        callback: cbResult,
        callbacks: cbResult ? [cbResult] : []
    });
}

/**
 * Case 3 - Submode: Uniform Range Recording (Record Mode)
 */
export async function handleRecordMode(ctx, res, tag, actualStart, actualEnd, intervalConfig = null, interpretConfig = null) {
    let metric = resolveMetric(ctx.refType);

    const { rows: allRows } = await query(`
        SELECT ts, value
        FROM readings
        WHERE tag_id = $1
          AND ts >= $2::timestamptz
          AND ts <= $3::timestamptz
        ORDER BY ts ASC;
    `, [tag.id, actualStart, actualEnd]);

    if (allRows.length === 0) {
        const errMsg = `No readings found for tag "${tag.name}" between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`;
        await reportError(`[BatchLine Record]: ${errMsg}`, ctx);
        return res.status(404).json({ error: errMsg });
    }

    const totalCount = allRows.length;
    let valuesToSend = [];
    const durationMs = actualEnd.getTime() - actualStart.getTime();

    if (intervalConfig && intervalConfig.intervalMs) {
        valuesToSend = buildIntervalConsolidatedValues(
            allRows,
            actualStart,
            actualEnd,
            intervalConfig.intervalMs,
            metric,
            tag.display_digits,
            allRows[0]?.value ?? 0,
            interpretConfig
        );
    } else if (totalCount <= EXTERNAL_CONFIG.MAX_PROFILE_SAMPLES || durationMs <= 1000) {
        valuesToSend = allRows.slice(0, EXTERNAL_CONFIG.MAX_PROFILE_SAMPLES).map((r, idx) => {
            const standardFormattedValue = formatReadingValue(r.value, tag.display_digits);
            const formattedValue = interpretConfig ? interpretConfig.interpret(r.value) : standardFormattedValue;
            return {
                repeat_no: idx + 1,
                value: formattedValue,
                standard_formatted_value: standardFormattedValue,
                raw_value: r.value,
                ts: r.ts,
                executed_timestamp: formatExecutedTimestamp(r.ts)
            };
        });
    } else {
        const sampleCount = EXTERNAL_CONFIG.MAX_PROFILE_SAMPLES || 30;
        const lastBucketIndex = sampleCount - 1;

        const { rows: bucketRows } = await query(`
            WITH bounds AS (
                SELECT $2::timestamptz AS t_start, $3::timestamptz AS t_end
            ),
            buckets AS (
                SELECT 
                    i AS bucket_no,
                    t_start + (i * (t_end - t_start) / $4) AS b_start,
                    t_start + ((i + 1) * (t_end - t_start) / $4) AS b_end
                FROM bounds, generate_series(0, $5) AS i
            )
            SELECT 
                b.bucket_no,
                b.b_start,
                b.b_end,
                AVG(r.value) AS avg_val,
                MIN(r.value) AS min_val,
                MAX(r.value) AS max_val,
                COUNT(r.value)::int AS samples
            FROM buckets b
            LEFT JOIN readings r 
              ON r.tag_id = $1 
             AND r.ts >= b.b_start 
             AND (CASE WHEN b.bucket_no = $5 THEN r.ts <= b.b_end ELSE r.ts < b.b_end END)
            GROUP BY b.bucket_no, b.b_start, b.b_end
            ORDER BY b.bucket_no;
        `, [tag.id, actualStart, actualEnd, sampleCount, lastBucketIndex]);

        let lastKnown = null;
        const bucketList = bucketRows.map(r => {
            let metricVal = null;
            if (metric === 'min') metricVal = r.min_val;
            else if (metric === 'max') metricVal = r.max_val;
            else metricVal = r.avg_val;

            if (metricVal !== null && metricVal !== undefined) {
                lastKnown = Number(metricVal);
            }
            return {
                bucket_no: r.bucket_no,
                b_start: r.b_start,
                b_end: r.b_end,
                value: (metricVal !== null && metricVal !== undefined) ? Number(metricVal) : lastKnown,
                samples: r.samples
            };
        });

        const firstKnown = bucketList.find(b => b.value !== null)?.value ?? 0;
        valuesToSend = bucketList.map((b, idx) => {
            const resolvedVal = b.value !== null ? b.value : firstKnown;
            const standardFormattedValue = formatReadingValue(resolvedVal, tag.display_digits);
            const formattedValue = interpretConfig ? interpretConfig.interpret(resolvedVal) : standardFormattedValue;
            return {
                repeat_no: idx + 1,
                value: formattedValue,
                standard_formatted_value: standardFormattedValue,
                raw_value: resolvedVal,
                bucket_start: b.b_start,
                bucket_end: b.b_end,
                samples: b.samples,
                executed_timestamp: formatExecutedTimestamp(b.b_start)
            };
        });
    }

    if (interpretConfig) {
        logger.info('Case3Record', `Applied [INTERPRET] mapping on tag "${tag.name}" (${interpretConfig.raw})`);
    }

    logger.info('Case3Record', `Pushing ${valuesToSend.length} consolidated values for tag ${tag.name}...`);
    const actualResult = valuesToSend.map((item, idx) => ({
        repeat_no: item.repeat_no || (idx + 1),
        value: item.value,
        executed_timestamp: item.executed_timestamp || formatExecutedTimestamp(item.ts || item.bucket_start),
        executed_user_email: ctx.triggeredByEmail || null
    }));

    const cbResult = await sendBatchLineInstructionUpdate({
        refInstruction: ctx.refInstruction,
        batchId: ctx.batchId,
        callbackKey: ctx.callbackKey,
        actualResult
    });

    if (!cbResult?.ok) {
        await reportError(`Failed to update BatchLine Case 3 record (${valuesToSend.length} items)`, ctx, cbResult?.data?.error?.detail || cbResult?.error);
    }

    const responseData = {
        status: 'success',
        case: 3,
        mode: 'record',
        batch_id: ctx.batchId,
        tag: tag.name,
        metric: metric.toUpperCase(),
        ref_type: ctx.refType,
        ref_start_time: ctx.refStartTime,
        interval: intervalConfig ? intervalConfig.rawInterval : null,
        interval_minutes: intervalConfig ? intervalConfig.intervalMinutes : null,
        interpret: interpretConfig ? { raw: interpretConfig.raw, mapping: interpretConfig.mapping } : null,
        total_samples: totalCount,
        records_sent: valuesToSend.length,
        records: valuesToSend,
        callback: cbResult,
        callbacks: cbResult ? [cbResult] : []
    };
    if (ctx.refEndTime) {
        responseData.ref_end_time = ctx.refEndTime;
    }

    return res.json(responseData);
}

/**
 * Case 3 - Submode: Standard Statistical / Aggregate Calculations
 */
export async function handleAggregateMode(ctx, res, tag, actualStart, actualEnd, statField, interpretConfig = null) {
    const { rows } = await query(`
        SELECT 
            COUNT(*)::int AS sample_count,
            MIN(r.value) AS min,
            MAX(r.value) AS max,
            AVG(r.value) AS avg,
            SUM(r.value) AS sum,
            STDDEV(r.value) AS stddev,
            VARIANCE(r.value) AS variance,
            (MAX(r.value) - MIN(r.value)) AS range,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.value) AS median,
            first(r.value, r.ts) AS first,
            last(r.value, r.ts) AS last,
            (last(r.value, r.ts) - first(r.value, r.ts)) AS diff
        FROM readings r
        WHERE r.tag_id = $1
          AND r.ts >= $2::timestamptz
          AND r.ts <= $3::timestamptz;
    `, [tag.id, actualStart, actualEnd]);

    const stats = rows[0] || {};
    if (!stats.sample_count || Number(stats.sample_count) === 0) {
        const errMsg = `No readings found for tag "${tag.name}" between ${actualStart.toISOString()} and ${actualEnd.toISOString()}`;
        await reportError(`[BatchLine Aggregate]: ${errMsg}`, ctx);
        return res.status(404).json({ error: errMsg });
    }

    let rawResult = stats[statField];
    if (rawResult === null || rawResult === undefined) {
        if (statField === 'stddev' || statField === 'variance') {
            rawResult = 0;
        } else {
            const errMsg = `Unable to compute "${ctx.refType}" for tag "${tag.name}" in the specified time range.`;
            await reportError(`[BatchLine Aggregate]: ${errMsg}`, ctx);
            return res.status(404).json({ error: errMsg });
        }
    }

    const standardFormattedValue = (statField === 'sample_count')
        ? String(rawResult)
        : formatReadingValue(rawResult, tag.display_digits);
    const formattedValue = interpretConfig ? interpretConfig.interpret(rawResult) : standardFormattedValue;

    if (interpretConfig) {
        logger.info('Case3Aggregate', `Applied [INTERPRET] mapping on tag "${tag.name}": raw value ${rawResult} (${standardFormattedValue}) -> "${formattedValue}"`);
    }

    const callbackResult = await sendBatchLineInstructionUpdate({
        refInstruction: ctx.refInstruction,
        batchId: ctx.batchId,
        callbackKey: ctx.callbackKey,
        actualResult: [
            {
                repeat_no: 1,
                value: formattedValue,
                executed_timestamp: formatExecutedTimestamp(actualEnd || new Date()),
                executed_user_email: ctx.triggeredByEmail
            }
        ]
    });

    if (callbackResult?.ok) {
        logger.info('Case3Aggregate', `Successfully updated ${statField} for tag ${tag.name} with value "${formattedValue}"`);
    } else {
        await reportError('[BatchLine Aggregate]: Failed to update instruction', ctx, callbackResult?.data || callbackResult?.error);
    }

    const responseData = {
        status: 'success',
        case: 3,
        batch_id: ctx.batchId,
        tag: tag.name,
        ref_type: ctx.refType,
        operation: statField,
        ref_start_time: ctx.refStartTime,
        sample_count: stats.sample_count,
        raw_value: rawResult,
        standard_formatted_value: standardFormattedValue,
        formatted_value: formattedValue,
        interpret: interpretConfig ? { raw: interpretConfig.raw, mapping: interpretConfig.mapping } : null,
        statistics: {
            min: stats.min,
            max: stats.max,
            avg: stats.avg,
            sum: stats.sum,
            stddev: stats.stddev,
            variance: stats.variance,
            range: stats.range,
            median: stats.median,
            first: stats.first,
            last: stats.last,
            diff: stats.diff,
            sample_count: stats.sample_count
        },
        callback: callbackResult
    };
    if (ctx.refEndTime) {
        responseData.ref_end_time = ctx.refEndTime;
    }

    return res.json(responseData);
}

/**
 * Case 3 Dispatcher: Parses options and routes to profile, record, or aggregate mode
 */
export async function handleCase3TimeRange(ctx, res) {
    if (!ctx.refElement) {
        await reportError('[BatchLine Case 3]: Missing required RefElement in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefElement in instruction payload' });
    }
    if (!ctx.refStartTime) {
        await reportError('[BatchLine Case 3]: Missing required RefStartTime in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefStartTime in instruction payload' });
    }
    if (!ctx.refType) {
        await reportError('[BatchLine Case 3]: Missing required RefType in instruction payload', ctx);
        return res.status(400).json({ error: 'Missing required RefType in instruction payload' });
    }

    const startDate = parseBatchLineDate(ctx.refStartTime) || new Date(ctx.refStartTime);
    if (isNaN(startDate.getTime())) {
        const errMsg = `Invalid date format for RefStartTime ("${ctx.refStartTime}")`;
        await reportError(`[BatchLine Case 3]: ${errMsg}`, ctx);
        return res.status(400).json({ error: errMsg });
    }

    const desc = [
        typeof ctx.instructionDescription === 'string' ? ctx.instructionDescription : '',
        getCombinedDescription(ctx)
    ].filter(Boolean).join(' ');

    const interpretConfig = extractInterpretMapping(desc);
    if (interpretConfig) {
        logger.info('Case3', 'Found [INTERPRET] mapping for instruction:', interpretConfig.raw);
    }

    const metric = resolveMetric(ctx.refType);
    const recordConfig = parseRecordInstructionConfig(desc, metric);

    let statField = null;
    if (!recordConfig.isRecord) {
        const statKey = String(ctx.refType).trim().toUpperCase();
        statField = STAT_OPERATIONS[statKey];

        if (!statField) {
            await reportError(`[BatchLine Case 3]: Unsupported RefType operation: "${ctx.refType}"`, ctx);
            return res.status(400).json({
                error: `Unsupported RefType operation: "${ctx.refType}". Supported operations: ${Object.keys(STAT_OPERATIONS).join(', ')}`
            });
        }
    }

    const tag = await resolveTag(ctx.refElement, ctx);
    if (!tag) {
        await reportError(`[BatchLine Case 3]: Could not resolve tag for RefElement: "${ctx.refElement}"`, ctx);
        return res.status(404).json({ error: `Could not resolve tag for RefElement: "${ctx.refElement}"` });
    }

    let endDate = null;
    if (ctx.refEndTime && !recordConfig.isSentinel) {
        endDate = parseBatchLineDate(ctx.refEndTime) || new Date(ctx.refEndTime);
        if (isNaN(endDate.getTime())) {
            const errMsg = `Invalid date format for RefEndTime ("${ctx.refEndTime}")`;
            await reportError(`[BatchLine Case 3]: ${errMsg}`, ctx);
            return res.status(400).json({ error: errMsg });
        }
    }

    let actualStart = startDate;
    let actualEnd = endDate;
    if (actualStart && actualEnd && actualStart > actualEnd) {
        [actualStart, actualEnd] = [actualEnd, actualStart];
    }

    if (!actualEnd) {
        actualEnd = new Date();
    }

    switch (recordConfig.mode) {
        case 'SENTINEL': {
            const effInterval = recordConfig.intervalConfig || { rawInterval: '1m', intervalMinutes: 1, intervalMs: 60000 };
            const profileConfig = recordConfig.profileConfig;
            const startThreshold = profileConfig ? profileConfig.start : null;
            const startDirection = profileConfig ? profileConfig.direction : null;

            const now = new Date();
            const isPast = actualStart.getTime() < now.getTime();

            // Scenario 3: START threshold specified (e.g. START=140, DIRECTION=Rise, INTERVAL=5m)
            if (startThreshold !== null && startThreshold !== undefined) {
                let crossedStartMs = null;
                let effectiveStartDir = startDirection;

                if (isPast) {
                    // Check historical readings between actualStart and now for crossing
                    const { rows } = await query(`
                        SELECT ts, value
                        FROM readings
                        WHERE tag_id = $1
                          AND ts >= $2::timestamptz
                          AND ts <= $3::timestamptz
                        ORDER BY ts ASC;
                    `, [tag.id, actualStart, now]);

                    const wave = detectWaveInReadings(rows, profileConfig);
                    if (wave.waveStartTs) {
                        crossedStartMs = new Date(wave.waveStartTs).getTime();
                        effectiveStartDir = wave.startDirection || startDirection;
                        logger.info('Case3', `Sentinel mode for tag "${tag.name}": Crossed START threshold (${startThreshold}) at ${wave.waveStartTs} in past readings. Streaming from wave start with interval ${effInterval.rawInterval} until stopped by user.`);
                    } else {
                        logger.info('Case3', `Sentinel mode for tag "${tag.name}": START threshold (${startThreshold}) not yet crossed in past readings. Enqueuing continuous mode to await threshold crossing.`);
                    }
                } else {
                    logger.info('Case3', `Sentinel mode for tag "${tag.name}": Scheduled from ${actualStart.toISOString()} to monitor START threshold (${startThreshold}) with interval ${effInterval.rawInterval}.`);
                }

                return await handleContinuousIntervalMode(
                    ctx,
                    res,
                    tag,
                    actualStart,
                    effInterval,
                    startThreshold,
                    effectiveStartDir,
                    interpretConfig,
                    {
                        crossedStartMs
                    }
                );
            }

            // Scenarios 1 & 2: Pure interval RECORD mode (no START threshold)
            // (1: default 1m interval, 2: custom INTERVAL e.g. 10s or 5m)
            let crossedStartMs = null;
            if (isPast) {
                crossedStartMs = actualStart.getTime();
                logger.info('Case3', `Sentinel mode for tag "${tag.name}": Past RefStartTime (${actualStart.toISOString()}). Backfilling intervals (${effInterval.rawInterval}) to now, then continuing live streaming until stopped by user.`);
            } else {
                logger.info('Case3', `Sentinel mode for tag "${tag.name}": Starting from ${actualStart.toISOString()} with interval (${effInterval.rawInterval}) until stopped by user.`);
            }

            return await handleContinuousIntervalMode(
                ctx,
                res,
                tag,
                actualStart,
                effInterval,
                null,
                null,
                interpretConfig,
                {
                    crossedStartMs
                }
            );
        }
        case 'PROFILE':
            return await handleProfileMode(ctx, res, tag, actualStart, actualEnd, recordConfig.profileConfig, recordConfig.intervalConfig, interpretConfig);
        case 'RECORD':
            return await handleRecordMode(ctx, res, tag, actualStart, actualEnd, recordConfig.intervalConfig, interpretConfig);
        default:
            return await handleAggregateMode(ctx, res, tag, actualStart, actualEnd, statField, interpretConfig);
    }
}
