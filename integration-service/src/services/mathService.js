import { EXTERNAL_CONFIG } from '../config/externalConfig.js';
import { formatReadingValue, formatExecutedTimestamp } from '../utils/formatters.js';

/**
 * Resolves aggregation metric from RefType
 */
export function resolveMetric(refType) {
    if (!refType) return 'avg';
    const rUpper = String(refType).trim().toUpperCase();
    if (rUpper === 'MIN' || rUpper === 'MINIMUM') return 'min';
    if (rUpper === 'MAX' || rUpper === 'MAXIMUM') return 'max';
    if (rUpper === 'SUM') return 'sum';
    if (rUpper === 'FIRST') return 'first';
    if (rUpper === 'LAST') return 'last';
    return 'avg';
}

/**
 * Computes single aggregated metric value from an array of numbers
 */
export function computeMetricValue(vals, metric) {
    if (!vals || vals.length === 0) return 0;
    if (metric === 'min') return Math.min(...vals);
    if (metric === 'max') return Math.max(...vals);
    if (metric === 'sum') return vals.reduce((acc, v) => acc + v, 0);
    if (metric === 'first') return vals[0];
    if (metric === 'last') return vals[vals.length - 1];
    return vals.reduce((acc, v) => acc + v, 0) / vals.length;
}

/**
 * Resolves start/stop directions and whether the waveform represents an envelope/pulse.
 */
export function resolveWaveDirections(startThreshold, stopThreshold, userDirection = null, initialVal = null) {
    let startDirection = userDirection ? String(userDirection).trim().toLowerCase() : null;
    if (!startDirection) {
        if (stopThreshold !== null && stopThreshold !== startThreshold) {
            startDirection = (stopThreshold > startThreshold) ? 'rise' : 'fall';
        } else if (initialVal !== null) {
            startDirection = (initialVal <= startThreshold) ? 'rise' : 'fall';
        } else {
            startDirection = 'rise';
        }
    }

    const isFall = (startDirection === 'fall' || startDirection === 'down');
    const effectiveStartDirection = isFall ? 'fall' : 'rise';

    let stopDirection = null;
    let isEnvelope = false;

    if (stopThreshold !== null) {
        if (stopThreshold === startThreshold) {
            // Equal thresholds: envelope / pulse wave (stop when returning across the same threshold)
            stopDirection = isFall ? 'rise' : 'fall';
            isEnvelope = true;
        } else if (isFall) {
            // Starting with a fall: if stopThreshold > startThreshold, it's recovering upward (dip/valley envelope)
            stopDirection = (stopThreshold > startThreshold) ? 'rise' : 'fall';
            isEnvelope = (stopThreshold > startThreshold);
        } else {
            // Starting with a rise: if stopThreshold < startThreshold, it's falling back down (peak envelope with hysteresis)
            stopDirection = (stopThreshold < startThreshold) ? 'fall' : 'rise';
            isEnvelope = (stopThreshold < startThreshold);
        }
    }

    return {
        startDirection: effectiveStartDirection,
        stopDirection,
        isFall,
        isEnvelope
    };
}

/**
 * Consolidates readings within a window into intervals of intervalMs,
 * aggregating each interval's readings using the specified metric (min, max, avg, sum, first, last).
 */
export function buildIntervalConsolidatedValues(
    rows,
    windowStart,
    windowEnd,
    intervalMs,
    metric,
    displayDigits,
    fallbackVal = 0,
    interpretConfig = null
) {
    const startMs = windowStart.getTime();
    const endMs = windowEnd.getTime();
    const windowDurationMs = Math.max(0, endMs - startMs);

    // Rule: Window < Interval or Zero duration -> single point
    if (windowDurationMs < intervalMs || startMs === endMs) {
        let singleVal = fallbackVal;
        if (rows && rows.length > 0) {
            singleVal = computeMetricValue(rows.map(r => Number(r.value)), metric);
        }
        const standardFormattedValue = formatReadingValue(singleVal, displayDigits);
        const formattedValue = interpretConfig ? interpretConfig.interpret(singleVal) : standardFormattedValue;
        return [{
            repeat_no: 1,
            value: formattedValue,
            standard_formatted_value: standardFormattedValue,
            raw_value: singleVal,
            bucket_start: windowStart.toISOString(),
            bucket_end: windowEnd.toISOString(),
            samples: rows ? rows.length : 0,
            executed_timestamp: formatExecutedTimestamp(windowStart)
        }];
    }

    let intervalCount = Math.max(1, Math.ceil(windowDurationMs / intervalMs));
    const maxAllowed = EXTERNAL_CONFIG.MAX_PROFILE_SAMPLES || EXTERNAL_CONFIG.MAX_PERIODIC_REPEATS || 50;
    if (intervalCount > maxAllowed) {
        intervalCount = maxAllowed;
    }

    let lastKnown = (rows && rows.length > 0)
        ? Number(rows[0].value)
        : ((fallbackVal !== null && fallbackVal !== undefined) ? Number(fallbackVal) : 0);

    const values = [];

    for (let i = 0; i < intervalCount; i++) {
        const bStartMs = startMs + i * intervalMs;
        const bEndMs = Math.min(startMs + (i + 1) * intervalMs, endMs);
        const bStart = new Date(bStartMs);
        const bEnd = new Date(bEndMs);

        const isLast = (i === intervalCount - 1);
        const bucketVals = [];

        if (rows && rows.length > 0) {
            for (let j = 0; j < rows.length; j++) {
                const rTs = new Date(rows[j].ts).getTime();
                if (rTs >= bStartMs && (isLast ? (rTs <= bEndMs) : (rTs < bEndMs))) {
                    const val = Number(rows[j].value);
                    if (!Number.isNaN(val)) bucketVals.push(val);
                }
            }
        }

        let resolvedVal;
        if (bucketVals.length > 0) {
            resolvedVal = computeMetricValue(bucketVals, metric);
            lastKnown = resolvedVal;
        } else {
            resolvedVal = lastKnown;
        }

        const standardFormattedValue = formatReadingValue(resolvedVal, displayDigits);
        const formattedValue = interpretConfig ? interpretConfig.interpret(resolvedVal) : standardFormattedValue;

        values.push({
            repeat_no: i + 1,
            value: formattedValue,
            standard_formatted_value: standardFormattedValue,
            raw_value: resolvedVal,
            bucket_start: bStart.toISOString(),
            bucket_end: bEnd.toISOString(),
            samples: bucketVals.length,
            executed_timestamp: formatExecutedTimestamp(bStart)
        });
    }

    return values;
}
