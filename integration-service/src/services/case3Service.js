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
    extractInterpretMapping
} from '../utils/instructionParsers.js';
import { reportError, sendBatchLineInstructionUpdate } from '../clients/batchLineClient.js';
import { resolveTag } from '../dal/externalDal.js';
import {
    resolveMetric,
    resolveWaveDirections,
    buildIntervalConsolidatedValues
} from './mathService.js';

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

    const firstValidRow = rows.find(r => r.value !== null && r.value !== undefined && !Number.isNaN(Number(r.value)));
    const firstVal = firstValidRow ? Number(firstValidRow.value) : null;

    const { startDirection, stopDirection, isFall, isEnvelope } = resolveWaveDirections(
        startThreshold,
        stopThreshold,
        profileConfig.direction,
        firstVal
    );

    let armed = false;
    let waveStartTs = null;
    let waveStopTs = null;

    if (firstVal !== null) {
        if (isFall && firstVal >= startThreshold) armed = true;
        if (!isFall && firstVal <= startThreshold) armed = true;
    }

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.value === null || r.value === undefined) continue;
        const val = Number(r.value);
        if (Number.isNaN(val)) continue;

        if (!armed) {
            if (isFall && val >= startThreshold) armed = true;
            if (!isFall && val <= startThreshold) armed = true;
        }

        if (armed && !waveStartTs) {
            let reachedStart = false;
            if (i === 0) {
                reachedStart = isFall ? (val <= startThreshold) : (val >= startThreshold);
            } else {
                const prevVal = Number(rows[i - 1].value);
                reachedStart = isFall ? (val <= startThreshold && prevVal >= startThreshold)
                    : (val >= startThreshold && prevVal <= startThreshold);
            }

            if (reachedStart) waveStartTs = r.ts;
        } else if (waveStartTs && !waveStopTs) {
            if (profileConfig.durationMinutes !== null && profileConfig.durationMinutes > 0) {
                const durationMs = profileConfig.durationMinutes * 60 * 1000;
                if (new Date(r.ts).getTime() - new Date(waveStartTs).getTime() >= durationMs) {
                    waveStopTs = r.ts;
                    break;
                }
            } else if (stopThreshold !== null) {
                const isAfterStart = (new Date(r.ts).getTime() > new Date(waveStartTs).getTime());
                const reachedStop = (stopDirection === 'rise') ? (val >= stopThreshold) : (val <= stopThreshold);
                if (reachedStop && isAfterStart) {
                    waveStopTs = r.ts;
                    break;
                }

                if (!isEnvelope) {
                    const aborted = isFall ? (val > startThreshold) : (val < startThreshold);
                    if (aborted) {
                        waveStartTs = null;
                        armed = false;
                    }
                }
            }
        }
    }

    if (!waveStartTs) {
        for (const r of rows) {
            if (r.value === null || r.value === undefined) continue;
            const val = Number(r.value);
            if (Number.isNaN(val)) continue;
            if (isFall ? (val <= startThreshold) : (val >= startThreshold)) {
                waveStartTs = r.ts;
                break;
            }
        }
    }

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

    const recordBlockMatch = desc.match(/\[RECORD(?::\s*([^\]]*))?\]/i);
    const isRecordTrigger = Boolean(recordBlockMatch);

    let isProfileMode = false;
    let isSentinelMode = false;
    let profileConfig = null;
    let intervalConfig = null;
    let statField = null;

    if (isRecordTrigger) {
        const content = (recordBlockMatch[1] || '').trim();
        const metric = resolveMetric(ctx.refType);

        const startMatch = content.match(/\bSTART\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
        const stopMatch = content.match(/\bSTOP\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
        const durationMatch = content.match(/\bDURATION\s*=\s*(\d+(?:\.\d+)?)\s*(s|m|h)?/i);
        const directionMatch = content.match(/\bDIRECTION\s*=\s*(Rise|Fall)/i);
        const intervalMatch = content.match(/\bINTERVAL\s*=\s*(\d+(?:\.\d+)?)\s*(s|m|h)?/i);

        if (intervalMatch) {
            const val = parseFloat(intervalMatch[1]);
            const unit = (intervalMatch[2] || 'm').toLowerCase();
            let intervalMs;
            let intervalMinutes;
            if (unit === 's') {
                intervalMs = Math.round(val * 1000);
                intervalMinutes = val / 60;
            } else if (unit === 'h') {
                intervalMs = Math.round(val * 3600 * 1000);
                intervalMinutes = val * 60;
            } else {
                intervalMs = Math.round(val * 60 * 1000);
                intervalMinutes = val;
            }
            intervalConfig = {
                rawInterval: intervalMatch[0],
                intervalMinutes,
                intervalMs: Math.max(intervalMs, 1000)
            };
        }

        let durationMinutes = null;
        if (durationMatch) {
            const val = parseFloat(durationMatch[1]);
            const unit = (durationMatch[2] || 'm').toLowerCase();
            if (unit === 's') durationMinutes = val / 60;
            else if (unit === 'h') durationMinutes = val * 60;
            else durationMinutes = val;
        }

        const sentinelRegex = /\b(SENTINEL|OPEN[-_\s]?END(?:ED)?)\b/i;
        const sentinelMatch = content.match(sentinelRegex) || desc.match(sentinelRegex);
        isSentinelMode = Boolean(sentinelMatch);

        if (startMatch) {
            isProfileMode = true;
            profileConfig = {
                start: parseFloat(startMatch[1]),
                stop: stopMatch ? parseFloat(stopMatch[1]) : null,
                durationMinutes,
                direction: directionMatch ? directionMatch[1].toLowerCase() : null,
                metric,
                isSentinel: isSentinelMode
            };
        }
    } else {
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
    if (ctx.refEndTime && !isSentinelMode) {
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

    if (isProfileMode) {
        return await handleProfileMode(ctx, res, tag, actualStart, actualEnd, profileConfig, intervalConfig, interpretConfig);
    }

    if (isRecordTrigger) {
        return await handleRecordMode(ctx, res, tag, actualStart, actualEnd, intervalConfig, interpretConfig);
    }

    return await handleAggregateMode(ctx, res, tag, actualStart, actualEnd, statField, interpretConfig);
}
