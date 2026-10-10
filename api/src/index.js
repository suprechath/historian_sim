import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { query, pool } from './db.js';
import uiRoutes, { ensureSimulationControl } from './routes/ui.js';
import { startJobsWorker, stopJobsWorker } from './jobsWorker.js';
import { logger } from './utils/logger.js';

// Resolve and load root .env (two levels up from api/src)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (req.path !== '/ui/stream') {
            logger.info('HistorianAPI', `${req.method} ${req.path} ${res.statusCode} (${duration}ms)`);
        }
    });
    next();
});

// 1. Unauthenticated health probe
app.get('/health', async (req, res) => {
    try {
        await query('SELECT 1');
        res.json({
            status: 'healthy',
            service: 'historian-api',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        logger.error('HistorianAPI', 'Health probe failed', { error: err.message });
        res.status(503).json({
            status: 'unhealthy',
            service: 'historian-api',
            error: err.message
        });
    }
});

// 2. Gateway Security Middleware for /ui routes
const requireFrontendGateway = (req, res, next) => {
    const secret = req.headers['x-internal-gateway-secret'];
    const expectedSecret = process.env.INTERNAL_UI_SECRET;

    if (expectedSecret && secret !== expectedSecret) {
        return res.status(403).json({
            error: 'Forbidden: /ui routes are strictly reserved for the Historian frontend gateway. External integrations must access the Historian Integration Service on port 4001.'
        });
    }
    next();
};

// 3. Mount UI & Telemetry Layer (Stream, Mimic, Batch History & Demo Controls)
app.use('/ui', requireFrontendGateway, uiRoutes);

// 4. 404 Not Found Handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        message: `Route ${req.method} ${req.originalUrl} does not exist on Historian Core API. For BatchLine / external integrations, use Historian Integration Service (port 4001).`
    });
});

// 5. Global Error Handler Middleware
app.use((err, req, res, next) => {
    logger.error('HistorianAPI', 'Unhandled error', {
        path: req.path,
        method: req.method,
        error: err.message,
        stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    });
    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal server error')
    });
});

// 6. Initialize Database state and Background Workers
await ensureSimulationControl();
startJobsWorker();

const server = app.listen(PORT, () => {
    logger.info('HistorianAPI', `Core Historian API running on port ${PORT}`);
    logger.info('HistorianAPI', ` - UI & Telemetry: http://localhost:${PORT}/ui/*`);
    logger.info('HistorianAPI', ` - Health:         http://localhost:${PORT}/health`);
});

// 7. Graceful Termination Handling
const shutdown = () => {
    logger.info('HistorianAPI', 'Gracefully terminating HTTP server, worker, and DB pool...');
    stopJobsWorker();
    server.close(async () => {
        try {
            await pool.end();
            logger.info('HistorianAPI', 'DB pool cleanly disconnected. Process terminated.');
        } catch (poolErr) {
            logger.error('HistorianAPI', 'Error disconnecting DB pool', { error: poolErr.message });
        }
        process.exit(0);
    });

    // Force exit after 5s if still hanging
    setTimeout(() => {
        logger.warn('HistorianAPI', 'Forced shutdown after timeout.');
        process.exit(1);
    }, 5000).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);