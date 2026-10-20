import {
    cleanInstructionId,
    cleanPayloadField,
    parseBatchLineDate
} from './formatters.js';

/**
 * Extracts [TIME: ...] target values from text (e.g. [TIME: VALUE=130]).
 */
export function extractTimeTriggers(text) {
    if (!text || typeof text !== 'string') return [];
    const regex = /\[TIME:\s*([^\]]+)\]/gi;
    const triggers = [];
    const seen = new Set();
    let m;
    while ((m = regex.exec(text)) !== null) {
        const content = m[1];
        const valMatch = content.match(/\bVALUE\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
        if (!valMatch) continue;

        const targetValue = parseFloat(valMatch[1]);
        if (seen.has(targetValue)) continue;
        seen.add(targetValue);

        triggers.push({
            targetValue
        });
    }
    return triggers;
}

/**
 * Checks if [SCHEDULE] tag is present in text.
 */
export function hasScheduleTrigger(text) {
    if (!text || typeof text !== 'string') return false;
    return /\[SCHEDULE\]/i.test(text);
}

/**
 * Checks if a Health Check trigger is present in text.
 * Matches: [HEALTH_CHECK], [HEALTHCHECK], [PING], or [HEALTH]
 */
export function hasHealthCheckTrigger(text) {
    if (!text || typeof text !== 'string') return false;
    return /\[(HEALTH_CHECK|HEALTHCHECK|PING|HEALTH)\]/i.test(text);
}

/**
 * Checks if a Previous Batch trigger is present in text.
 * Matches: [PREVBATCH], [PREV_BATCH], [PREV-BATCH], with optional inner whitespace.
 */
export function hasPrevBatchTrigger(text) {
    if (!text || typeof text !== 'string') return false;
    return /\[\s*PREV[-_]?BATCH\s*\]/i.test(text);
}

/**
 * Extracts [EXCEPTION: REF=...] triggers from text (e.g. [EXCEPTION: REF=REFINST] or [EXCEPTION]).
 */
export function extractExceptionTriggers(text, defaultRef = null) {
    if (!text || typeof text !== 'string') return [];
    const regex = /\[EXCEPTION(?::\s*([^\]]*))?\]/gi;
    const triggers = [];
    const seen = new Set();
    let m;
    while ((m = regex.exec(text)) !== null) {
        const content = (m[1] || '').trim();
        const refMatch = content.match(/\bREF\s*=\s*([^,\s\]]+)/i);
        const targetRef = refMatch ? cleanInstructionId(refMatch[1]) : (defaultRef ? cleanInstructionId(defaultRef) : null);
        const phaseMatch = content.match(/\bPHASE\s*=\s*([^,\s\]]+)/i);
        const tagMatch = content.match(/\bTAG\s*=\s*([^,\s\]]+)/i);

        const dedupeKey = `${targetRef || ''}_${phaseMatch ? phaseMatch[1] : ''}_${tagMatch ? tagMatch[1] : ''}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        triggers.push({
            raw: m[0],
            targetRef,
            filterPhase: phaseMatch ? phaseMatch[1] : null,
            filterTag: tagMatch ? tagMatch[1] : null
        });
    }
    return triggers;
}

/**
 * Extracts duration in milliseconds from description if [RECORD: ... DURATION=... ] is present.
 * Units supported: s (seconds), m (minutes, default), h (hours).
 */
export function extractRecordDurationMs(text) {
    if (!text || typeof text !== 'string') return 0;

    let durationMatch = null;
    const recordBlockMatch = text.match(/\[RECORD:\s*([^\]]+)\]/i);
    if (recordBlockMatch) {
        durationMatch = recordBlockMatch[1].match(/\bDURATION\s*=\s*([+-]?\d+(?:\.\d+)?)\s*(s(?:ec(?:onds?)?)?|m(?:in(?:utes?)?)?|h(?:(?:ou)?rs?)?)?\b/i);
    }

    if (!durationMatch) {
        durationMatch = text.match(/\[DURATION:\s*([+-]?\d+(?:\.\d+)?)\s*(s(?:ec(?:onds?)?)?|m(?:in(?:utes?)?)?|h(?:(?:ou)?rs?)?)?\b\]/i) ||
            text.match(/\bDURATION\s*=\s*([+-]?\d+(?:\.\d+)?)\s*(s(?:ec(?:onds?)?)?|m(?:in(?:utes?)?)?|h(?:(?:ou)?rs?)?)?\b/i);
    }

    if (!durationMatch) return 0;

    const val = parseFloat(durationMatch[1]);
    if (isNaN(val)) return 0;
    const unitStr = (durationMatch[2] || 'm').toLowerCase();

    if (unitStr.startsWith('s')) return Math.round(val * 1000);
    if (unitStr.startsWith('h')) return Math.round(val * 3600 * 1000);
    return Math.round(val * 60 * 1000); // default minutes
}

/**
 * Creates an interpreter function from a key-value mapping object.
 *
 * @param {object} mapping - Mapping dictionary (e.g. { '0': 'No', '1': 'Yes' }).
 * @returns {((val: any, fallbackDefault?: string|null) => string)|null}
 */
export function createInterpreter(mapping) {
    if (!mapping || typeof mapping !== 'object') return null;
    return (val, fallbackDefault = null) => {
        if (val === null || val === undefined) {
            if (mapping['null'] !== undefined) return mapping['null'];
            if (mapping['0'] !== undefined) return mapping['0'];
            return fallbackDefault ?? '';
        }

        const numVal = Number(val);
        if (!isNaN(numVal)) {
            const intStr = String(Math.round(numVal));
            if (mapping[intStr] !== undefined) return mapping[intStr];
            if (mapping[String(numVal)] !== undefined) return mapping[String(numVal)];
            return fallbackDefault ?? String(val);
        }

        const strVal = String(val).trim();
        if (mapping[strVal] !== undefined) return mapping[strVal];
        return fallbackDefault ?? strVal;
    };
}

/**
 * Extracts [INTERPRET: ...] mappings from text (e.g. [INTERPRET: 1="Yes", 0="No"]).
 */
export function extractInterpretMapping(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/\[INTERPRET:\s*([^\]]+)\]/i);
    if (!match) return null;

    const content = match[1].trim();
    const mapping = {};
    const pairRegex = /(?:([+-]?\d+(?:\.\d+)?|"[^"]*"|'[^']*'|[a-zA-Z0-9_-]+))\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s\]]+))/g;
    let m;
    while ((m = pairRegex.exec(content)) !== null) {
        const rawKey = (m[1] || '').trim().replace(/^["']|["']$/g, '');
        const rawVal = (m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4] || '')).trim();
        mapping[rawKey] = rawVal;
        const numKey = Number(rawKey);
        if (!isNaN(numKey)) {
            mapping[String(numKey)] = rawVal;
            mapping[String(Math.round(numKey))] = rawVal;
        }
    }

    if (Object.keys(mapping).length === 0) return null;

    return {
        raw: match[0],
        mapping,
        interpret: createInterpreter(mapping)
    };
}

/**
 * Aggregates all possible description fields from instructions, steps, phases, and batch payloads.
 */
export function getCombinedDescription(ctx) {
    const texts = [];
    if (ctx?.instructionDescription) texts.push(ctx.instructionDescription);

    const body = ctx?.rawBody || {};
    if (body.InstructionDescription) texts.push(body.InstructionDescription);
    if (body.Description) texts.push(body.Description);

    const data = body.Data || {};
    const batch = data.Batch || {};
    if (batch.BatchDescription) texts.push(batch.BatchDescription);
    if (batch.Description) texts.push(batch.Description);

    const phases = Array.isArray(batch.Phases) ? batch.Phases : (batch.Phase ? [batch.Phase] : []);
    for (const phase of phases) {
        if (phase.PhaseDescription) texts.push(phase.PhaseDescription);
        if (phase.Description) texts.push(phase.Description);
        const steps = Array.isArray(phase.Steps) ? phase.Steps : (phase.Step ? [phase.Step] : []);
        for (const step of steps) {
            if (step.StepDescription) texts.push(step.StepDescription);
            if (step.Description) texts.push(step.Description);
            const instructions = Array.isArray(step.Instructions) ? step.Instructions : (step.Instruction ? [step.Instruction] : []);
            for (const inst of instructions) {
                if (inst.InstructionDescription) texts.push(inst.InstructionDescription);
                if (inst.Description) texts.push(inst.Description);
                if (inst.InstructionId) texts.push(inst.InstructionId);
            }
        }
    }

    if (ctx?.instruction) {
        if (ctx.instruction.InstructionDescription) texts.push(ctx.instruction.InstructionDescription);
        if (ctx.instruction.Description) texts.push(ctx.instruction.Description);
        if (ctx.instruction.InstructionId) texts.push(ctx.instruction.InstructionId);
    }

    return texts.filter(t => typeof t === 'string' && t.trim()).join(' ');
}

/**
 * Extracts and cleans instruction payload fields from incoming request body.
 */
export function extractInstructionPayload(body = {}) {
    const data = body.Data || {};
    const batch = data.Batch || {};
    const phase = batch.Phase || {};
    const step = phase.Step || {};
    const instruction = step.Instruction || {};

    return {
        topic: body.Topic || null,
        batchId: batch.BatchId || batch.BatchID || body.batch_id || body.BatchId || body.BatchID || null,
        rawEventType: instruction.EventType !== undefined ? instruction.EventType : null,
        instructionDescription: instruction.InstructionDescription || body.InstructionDescription || '',
        refElement: cleanPayloadField(instruction.RefElement || body.RefElement),
        refTime: cleanPayloadField(instruction.RefTime || body.RefTime),
        refInstruction: cleanPayloadField(instruction.RefInstruction || body.RefInstruction),
        refRecipe: cleanPayloadField(instruction.RefRecipe || body.RefRecipe),
        refEvent: cleanPayloadField(instruction.RefEvent || body.RefEvent),
        refType: cleanPayloadField(instruction.RefType || body.RefType),
        refStartTime: cleanPayloadField(instruction.RefStartTime || body.RefStartTime),
        refEndTime: cleanPayloadField(instruction.RefEndTime || body.RefEndTime),
        callbackKey: body.CallbackKey || body.callbackkey || null,
        triggeredByEmail: instruction.TriggeredByEmail || body.TriggeredByEmail || null
    };
}

/**
 * Maps instruction ID patterns to PrintLabel parameter keys.
 */
export function mapInstructionKey(instructionId = '') {
    const id = String(instructionId).trim().toUpperCase();
    if (id.includes('[PARM')) return 'RefElement';
    if (id.includes('[REF')) return 'RefInstruction';
    if (id.includes('[AGG')) return 'RefType';
    if (id.includes('[STH')) return 'START';
    if (id.includes('[ETH')) return 'STOP';
    if (id.includes('[INV')) return 'INTERVAL';
    if (id.includes('[DUR')) return 'DURATION';
    if (id.includes('[DIR')) return 'DIRECTION';
    if (id.includes('[ET') || id.includes('[NT') || id === 'ET' || id === 'NT') return 'RefEndTime';
    if (id.includes('[ST') || id === 'ST') return 'RefStartTime';
    return null;
}

/**
 * Parses full PrintLabel payload extracting parameters and normalized dates.
 */
export function parsePrintLabelPayload(body = {}) {
    const data = body.Data || {};
    const batch = data.Batch || {};
    const batchId = batch.BatchId || body.batch_id || body.batchid || null;
    const callbackKey = body.CallbackKey || data.CallbackKey || body.callbackkey || null;

    const parameters = {
        RefElement: null,
        RefInstruction: null,
        RefStartTime: null,
        RefEndTime: null,
        RefType: null,
        START: null,
        STOP: null,
        INTERVAL: null,
        DURATION: null,
        DIRECTION: null
    };

    let executedUserEmail = null;
    const incomingInstructionIds = [];

    const phases = Array.isArray(batch.Phases) ? batch.Phases : (batch.Phase ? [batch.Phase] : []);
    for (const phase of phases) {
        const steps = Array.isArray(phase.Steps) ? phase.Steps : (phase.Step ? [phase.Step] : []);
        for (const step of steps) {
            const instructions = Array.isArray(step.Instructions) ? step.Instructions : (step.Instruction ? [step.Instruction] : []);
            for (const inst of instructions) {
                if (inst.InstructionId) {
                    incomingInstructionIds.push(cleanInstructionId(inst.InstructionId));
                }
                const key = mapInstructionKey(inst.InstructionId);
                if (!key) continue;

                const result = Array.isArray(inst.ActualResult) ? inst.ActualResult[inst.ActualResult.length - 1] : inst.ActualResult;
                const val = result?.Value ? String(result.Value).trim() : null;

                if (val && !['skip instruction', 'null', 'undefined', 'none', ''].includes(val.toLowerCase())) {
                    parameters[key] = val;
                }
                if (result?.ExecutedUserEmail) {
                    executedUserEmail = result.ExecutedUserEmail;
                }
            }
        }
    }

    const startDate = parameters.RefStartTime ? parseBatchLineDate(parameters.RefStartTime) : null;
    const endDate = parameters.RefEndTime ? parseBatchLineDate(parameters.RefEndTime) : null;

    return {
        topic: body.Topic || null,
        batchId,
        callbackKey,
        refInstruction: parameters.RefInstruction || batch.RefInstruction || body.RefInstruction || null,
        user: executedUserEmail ? { executedUserEmail } : null,
        parameters,
        incomingInstructionIds,
        parsedDates: {
            startDate: startDate ? startDate.toISOString() : null,
            endDate: endDate ? endDate.toISOString() : null
        }
    };
}

/**
 * Parses interval string into numerical milliseconds and minutes.
 */
export function parseIntervalString(intervalStr) {
    if (!intervalStr) return null;
    const str = String(intervalStr).trim();
    if (str.toLowerCase() === 'skip instruction' || str === '') return null;
    const match = str.match(/^([+-]?\d+(?:\.\d+)?)\s*(s|m|h)?/i);
    if (!match) return null;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 0) return null;
    const unit = (match[2] || 'm').toLowerCase();
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
    return {
        rawInterval: str,
        intervalMinutes,
        intervalMs: Math.max(intervalMs, 1000)
    };
}

/**
 * Parses duration string into decimal minutes.
 */
export function parseDurationString(durationStr) {
    if (!durationStr) return null;
    const str = String(durationStr).trim();
    if (str.toLowerCase() === 'skip instruction' || str === '') return null;
    const match = str.match(/^([+-]?\d+(?:\.\d+)?)\s*(s|m|h)?/i);
    if (!match) return null;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 0) return null;
    const unit = (match[2] || 'm').toLowerCase();
    if (unit === 's') return val / 60;
    if (unit === 'h') return val * 60;
    return val;
}

/**
 * Parses [RECORD: ...] tag from instruction descriptions into a structured, validated config.
 * Supports mode discrimination:
 *  - 'SENTINEL': continuous live periodic collection (when SENTINEL / OPEN-END is specified)
 *  - 'PROFILE': threshold-based wave detection (when START threshold is specified)
 *  - 'RECORD': uniform time-range downsampling (when [RECORD] without START or SENTINEL)
 *  - 'AGGREGATE': default statistical aggregate calculation
 * 
 * @param {string} desc - The combined instruction description text.
 * @param {string} [metric='avg'] - The resolved aggregation metric.
 * @returns {object} The parsed record configuration with discriminated mode: 'SENTINEL', 'PROFILE', 'RECORD', or 'AGGREGATE'.
 */
export function parseRecordInstructionConfig(desc, metric = 'avg') {
    if (!desc || typeof desc !== 'string') {
        return { isRecord: false, mode: 'AGGREGATE', isSentinel: false, profileConfig: null, intervalConfig: null };
    }

    const sentinelRegex = /\b(SENTINEL|OPEN[-_\s]?END(?:ED)?)\b/i;
    const isSentinel = sentinelRegex.test(desc);

    const recordBlockMatch = desc.match(/\[RECORD(?::\s*([^\]]*))?\]/i);
    if (!recordBlockMatch && !isSentinel) {
        return { isRecord: false, mode: 'AGGREGATE', isSentinel: false, profileConfig: null, intervalConfig: null };
    }

    const content = (recordBlockMatch ? (recordBlockMatch[1] || '') : '').trim();

    // Parse INTERVAL (supports s/m/h units via parseIntervalString)
    let intervalConfig = null;
    const intervalMatch = content.match(/\bINTERVAL\s*=\s*([^,\s\]]+)/i);
    if (intervalMatch) {
        intervalConfig = parseIntervalString(intervalMatch[1]);
        if (intervalConfig) {
            intervalConfig.rawInterval = intervalMatch[0];
        }
    }

    // Parse DURATION (supports s/m/h units via parseDurationString)
    let durationMinutes = null;
    const durationMatch = content.match(/\bDURATION\s*=\s*([^,\s\]]+)/i);
    if (durationMatch) {
        durationMinutes = parseDurationString(durationMatch[1]);
    }

    // Parse START, STOP, and DIRECTION
    const startMatch = content.match(/\bSTART\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
    const stopMatch = content.match(/\bSTOP\s*=\s*([+-]?\d+(?:\.\d+)?)/i);
    const directionMatch = content.match(/\bDIRECTION\s*=\s*(Rise|Fall)/i);

    if (isSentinel) {
        return {
            isRecord: true,
            mode: 'SENTINEL',
            isSentinel: true,
            intervalConfig,
            profileConfig: startMatch ? {
                start: parseFloat(startMatch[1]),
                stop: stopMatch ? parseFloat(stopMatch[1]) : null,
                durationMinutes,
                direction: directionMatch ? directionMatch[1].toLowerCase() : null,
                metric,
                isSentinel: true
            } : null
        };
    }

    if (startMatch) {
        return {
            isRecord: true,
            mode: 'PROFILE',
            isSentinel: false,
            intervalConfig,
            profileConfig: {
                start: parseFloat(startMatch[1]),
                stop: stopMatch ? parseFloat(stopMatch[1]) : null,
                durationMinutes,
                direction: directionMatch ? directionMatch[1].toLowerCase() : null,
                metric,
                isSentinel: false
            }
        };
    }

    return {
        isRecord: true,
        mode: 'RECORD',
        isSentinel: false,
        intervalConfig,
        profileConfig: null
    };
}

