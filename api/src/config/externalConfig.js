import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Resolve and load root .env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const EXTERNAL_CONFIG = {
    BATCHLINE_BASE_URL: process.env.BATCHLINE_BASE_URL || 'https://batch-demo.bl-client.com',
    BATCHLINE_NOTIFICATION_URL: process.env.BATCHLINE_NOTIFICATION_URL || 'https://demo.bl-client.com/Notification/push',
    BATCHLINE_API_KEY: process.env.BATCHLINE_API_KEY || '',
    MAKE_HIGH_EXCEPTION_WEBHOOK_URL: process.env.MAKE_HIGH_EXCEPTION_WEBHOOK_URL || 'https://hook.us2.make.com/4i6aszkeu5mrfg8al798u6jcttkdty3o',
    MAKE_API_KEY: process.env['x-make-apikey'] || process.env.X_MAKE_APIKEY || process.env.MAKE_API_KEY || process.env.x_make_apikey || '',
    HTTP_TIMEOUT_MS: parseInt(process.env.BATCHLINE_TIMEOUT_MS || '15000', 10),
    PUSH_DELAY_MS: parseInt(process.env.BATCHLINE_PUSH_DELAY_MS || process.env.PUSH_DELAY_MS || '200', 10),
    BATCHLINE_CHUNK_SIZE: parseInt(process.env.BATCHLINE_CHUNK_SIZE || '50', 10),
    MAX_PERIODIC_REPEATS: parseInt(process.env.MAX_PERIODIC_REPEATS || '100', 10),
    DEFAULT_PERIODIC_INTERVAL_MIN: parseInt(process.env.DEFAULT_PERIODIC_INTERVAL_MIN || '5', 10),
    MAX_PROFILE_SAMPLES: parseInt(process.env.MAX_PROFILE_SAMPLES || '30', 10),
    HIGH_EXCEPTION_COOLDOWN_MINUTES: parseInt(process.env.HIGH_EXCEPTION_COOLDOWN_MINUTES || '10', 10),
};

export const STAT_OPERATIONS = {
    MAX: 'max',
    MAXIMUM: 'max',
    MIN: 'min',
    MINIMUM: 'min',
    AVG: 'avg',
    AVERAGE: 'avg',
    MEAN: 'avg',
    SUM: 'sum',
    TOTAL: 'sum',
    COUNT: 'sample_count',
    SAMPLES: 'sample_count',
    STDDEV: 'stddev',
    STD: 'stddev',
    STDEV: 'stddev',
    STANDARD_DEVIATION: 'stddev',
    VARIANCE: 'variance',
    VAR: 'variance',
    RANGE: 'range',
    MEDIAN: 'median',
    FIRST: 'first',
    LAST: 'last',
};

export const MONTH_NAMES = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];
