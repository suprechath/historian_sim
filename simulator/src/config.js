import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Resolve and load root .env (two levels up from simulator/src)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config(); // Also check local .env if present

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://admin:FT1234@localhost:5432/reactor',
  autoSeedDays: parseInt(process.env.AUTO_SEED_DAYS || '3', 10),
  defaultSpeed: Math.max(1, Math.min(3600, parseInt(process.env.SIMULATION_SPEED || process.env.DEFAULT_SIM_SPEED || '1', 10))),
  archiveIntervalSec: parseInt(process.env.ARCHIVE_INTERVAL_SEC || '5', 10),
  maxArchiveBufferSize: parseInt(process.env.MAX_ARCHIVE_BUFFER_SIZE || '50000', 10),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  
  // Chaos Engine Configuration
  chaos: {
    enabled: process.env.CHAOS_ENABLED === 'true',
    minIntervalSec: parseInt(process.env.CHAOS_MIN_INTERVAL_SEC || '60', 10),
    maxIntervalSec: parseInt(process.env.CHAOS_MAX_INTERVAL_SEC || '240', 10),
    minDurationSec: parseInt(process.env.CHAOS_MIN_DURATION_SEC || '20', 10),
    maxDurationSec: parseInt(process.env.CHAOS_MAX_DURATION_SEC || '45', 10),
    maxActive: parseInt(process.env.CHAOS_MAX_ACTIVE || '1', 10),
  },

  // Connection Pool Configuration
  dbPool: {
    max: parseInt(process.env.DB_POOL_MAX || '10', 10),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '5000', 10),
  }
};
