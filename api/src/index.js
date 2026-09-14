import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { query, ensureDefaultApiKey } from './db.js';
import { authAndAudit } from './middleware/authAndAudit.js';
import externalRoutes from './routes/external.js';
import uiRoutes from './routes/ui.js';
import { startJobsWorker } from './jobsWorker.js';

// Resolve and load root .env (two levels up from api/src)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT;

app.use(cors());
app.use(express.json());

// 1. Unauthenticated health probe
app.get('/health', async (req, res) => {
    try {
        await query('SELECT 1');
        res.json({ status: 'healthy', timestamp: new Date() });
    } catch (err) {
        res.status(500).json({ status: 'unhealthy', error: err.message });
    }
});

// 2. Mount External Integration Layer (Authenticated + Audited)
app.use('/api/v1', authAndAudit, externalRoutes);

// 3. Mount UI & Telemetry Layer (Stream + Demo Controls)
app.use('/ui', uiRoutes);

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Global Error Handler Middleware
app.use((err, req, res, next) => {
    console.error('Unhandled API Error:', err);
    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal server error')
    });
});

// 4. Initialize Database Seed Keys, Dispatcher Worker, and Listen
await ensureDefaultApiKey();
startJobsWorker();

const server = app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(` Historian API running on port ${PORT}`);
    console.log(` - External API (Logged): http://localhost:${PORT}/api/v1/*`);
    console.log(` - UI & Streaming:        http://localhost:${PORT}/ui/*`);
    console.log(`======================================================\n`);
});

// Graceful termination handling
const shutdown = () => {
    console.log('\n[Historian Service] Gracefully terminating HTTP server & DB pool...');
    server.close(async () => {
        await pool.end();
        console.log('[Historian Service] DB connection pool closed. Process terminated.');
        process.exit(0);
    });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);