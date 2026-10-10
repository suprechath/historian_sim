import { MONTH_NAMES } from '../config/externalConfig.js';

/**
 * Formats a numeric reading value to fixed display digits or rounded integer.
 */
export function formatReadingValue(value, displayDigits) {
    if (value === null || value === undefined) return '0';
    const num = Number(value);
    if (isNaN(num)) return String(value);
    if (displayDigits !== null && displayDigits !== undefined) {
        if (displayDigits === 0) return String(Math.round(num));
        return String(Number(num.toFixed(displayDigits)));
    }
    return String(Math.round(num));
}

/**
 * Formats a Date object into BatchLine's required date string: "MMM DD, YYYY HH:mm:ss" UTC.
 */
export function formatBatchLineDate(date) {
    if (!date) return null;
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;

    const month = MONTH_NAMES[d.getUTCMonth()];
    const day = String(d.getUTCDate()).padStart(2, '0');
    const year = d.getUTCFullYear();
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const minutes = String(d.getUTCMinutes()).padStart(2, '0');
    const seconds = String(d.getUTCSeconds()).padStart(2, '0');

    return `${month} ${day}, ${year} ${hours}:${minutes}:${seconds}`;
}

/**
 * Formats timestamp into ISO execution string: "YYYY-MM-DDTHH:mm:ss+00:00"
 */
export function formatExecutedTimestamp(date) {
    if (!date) return null;
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19) + '+00:00';
}

/**
 * Parses BatchLine date strings, handling UTC(...) wrappers, ISO strings, and standard formats.
 */
export function parseBatchLineDate(dateStr) {
    if (!dateStr) return null;
    const str = String(dateStr).trim();
    if (['null', 'undefined', 'none', 'nil', '', 'skip instruction'].includes(str.toLowerCase())) return null;
    const utcMatch = str.match(/^UTC\((.*?)\)$/i);
    if (utcMatch) {
        const d = new Date(utcMatch[1].trim() + ' UTC');
        if (!isNaN(d.getTime())) return d;
    }
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

/**
 * Strips surrounding brackets and converts instruction IDs to uppercase.
 */
export function cleanInstructionId(instructionId = '') {
    if (!instructionId) return '';
    return String(instructionId).trim().replace(/^\[+/, '').replace(/\]+$/, '').toUpperCase();
}

/**
 * Extracts a clean non-empty string from a scalar or array limit field.
 */
export function extractTextValue(val) {
    if (val === null || val === undefined) return '';
    if (Array.isArray(val)) {
        const filtered = val
            .map(v => (v === null || v === undefined) ? '' : String(v).trim())
            .filter(v => v.length > 0);
        return filtered.join(', ');
    }
    return String(val).trim();
}

/**
 * Sanitizes payload string fields, converting empty/null-like strings to null.
 */
export function cleanPayloadField(val) {
    if (val === null || val === undefined) return null;
    const s = String(val).trim();
    if (['null', 'undefined', 'none', 'nil', ''].includes(s.toLowerCase())) return null;
    return s;
}

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
