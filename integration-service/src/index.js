import express from 'express';
import cors from 'cors';
import { EXTERNAL_CONFIG } from './config/externalConfig.js';
import { query, ensureDefaultApiKey, pool } from './db.js';
import { auditLog } from './middleware/auditLog.js';
import externalRoutes from './routes/external.js';
import {
    handleInstructionWebhook,
    handleStatusPost,
    handleStatusGet
} from './controllers/externalController.js';
import { ensureForwardedExceptionsTable } from './dal/externalDal.js';
import { ensureSimulationControl } from './services/batchQueueService.js';
import { jobRegistry } from './services/jobRegistry.js';
import { logger } from './utils/logger.js';

const app = express();
const PORT = EXTERNAL_CONFIG.PORT || 4001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 1. Unauthenticated health probe
app.get('/health', async (req, res) => {
    try {
        await query('SELECT 1');
        res.json({
            service: 'historian-integration-service',
            status: 'healthy',
            timestamp: new Date()
        });
    } catch (err) {
        res.status(500).json({
            service: 'historian-integration-service',
            status: 'unhealthy',
            error: err.message
        });
    }
});

// 2. Integration Webhook Layer (Unauthenticated & Audited)
// BatchLine webhooks require zero authentication and are recorded in request_log for diagnostics.
app.use(['/api/v1', '/external'], auditLog, externalRoutes);

// Root webhooks for BatchLine compatibility (/instruction, /status)
app.post('/instruction', auditLog, handleInstructionWebhook);
app.post('/status', auditLog, handleStatusPost);
app.get('/status', auditLog, handleStatusGet);

// 3. 404 Handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        service: 'historian-integration-service'
    });
});

// 4. Global Error Handler Middleware
app.use((err, req, res, next) => {
    logger.error('IntegrationServiceError', 'Unhandled error:', err);
    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : (err.message || 'Internal server error'),
        service: 'historian-integration-service'
    });
});

// 5. Initialize Database Dependencies & Start Server
await ensureDefaultApiKey();
await ensureSimulationControl();
await ensureForwardedExceptionsTable();

const server = app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(` Historian Integration Service running on port ${PORT}`);
    console.log(` - BatchLine Webhooks: http://localhost:${PORT}/api/v1/*`);
    console.log(` - Direct Root Hooks:  http://localhost:${PORT}/instruction`);
    console.log(` - Health Probe:       http://localhost:${PORT}/health`);
    console.log(`======================================================\n`);
});

// 6. Graceful Termination Handling
const shutdown = () => {
    logger.info('HistorianIntegrationService', 'Gracefully terminating HTTP server & DB pool...');
    server.close(async () => {
        try {
            await jobRegistry.stopAllJobs();
            await pool.end();
            logger.info('HistorianIntegrationService', 'DB connection pool closed. Process terminated.');
        } catch (err) {
            logger.error('HistorianIntegrationService', 'Error during shutdown pool cleanup', { error: err.message });
        }
        process.exit(0);
    });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
