/**
 * Industrial-grade structured logger for Historian External API.
 */
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

const currentLevel = process.env.LOG_LEVEL
    ? (LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] ?? LOG_LEVELS.INFO)
    : LOG_LEVELS.INFO;

function formatMessage(prefix, message, extra = null) {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] [${prefix}] ${message}`;
    if (extra !== null && extra !== undefined) {
        if (typeof extra === 'object') {
            try {
                return `${formatted} ${JSON.stringify(extra)}`;
            } catch {
                return `${formatted} [Object]`;
            }
        }
        return `${formatted} ${extra}`;
    }
    return formatted;
}

export const logger = {
    debug(prefix, message, extra = null) {
        if (currentLevel <= LOG_LEVELS.DEBUG) {
            console.debug(formatMessage(prefix, message, extra));
        }
    },
    info(prefix, message, extra = null) {
        if (currentLevel <= LOG_LEVELS.INFO) {
            console.log(formatMessage(prefix, message, extra));
        }
    },
    warn(prefix, message, extra = null) {
        if (currentLevel <= LOG_LEVELS.WARN) {
            console.warn(formatMessage(prefix, message, extra));
        }
    },
    error(prefix, message, extra = null) {
        if (currentLevel <= LOG_LEVELS.ERROR) {
            console.error(formatMessage(prefix, message, extra));
        }
    }
};
