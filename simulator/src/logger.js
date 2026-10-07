import { config } from './config.js';

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevelWeight = LOG_LEVELS[config.logLevel] ?? LOG_LEVELS.info;

function formatMessage(level, message, context = '', meta = null) {
  const ts = new Date().toISOString();
  const ctx = context ? ` [${context}]` : '';
  const metaStr = meta ? (meta instanceof Error ? `\n${meta.stack || meta.message}` : ` ${JSON.stringify(meta)}`) : '';
  return `${ts} [${level.toUpperCase()}]${ctx} ${message}${metaStr}`;
}

export const logger = {
  debug(message, context = '', meta = null) {
    if (currentLevelWeight <= LOG_LEVELS.debug) {
      console.debug(formatMessage('debug', message, context, meta));
    }
  },
  info(message, context = '', meta = null) {
    if (currentLevelWeight <= LOG_LEVELS.info) {
      console.log(formatMessage('info', message, context, meta));
    }
  },
  warn(message, context = '', meta = null) {
    if (currentLevelWeight <= LOG_LEVELS.warn) {
      console.warn(formatMessage('warn', message, context, meta));
    }
  },
  error(message, context = '', meta = null) {
    if (currentLevelWeight <= LOG_LEVELS.error) {
      console.error(formatMessage('error', message, context, meta));
    }
  },
};
