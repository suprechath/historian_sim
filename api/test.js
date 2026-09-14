import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const PORT = process.env.PORT || 4000;
const BASE = `http://localhost:${PORT}`;
const API_KEY = process.env.API_KEY_TEST || 'demo-key-2026';

const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m',
    dim: '\x1b[2m'
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(` ${colors.green}✔${colors.reset} ${name}`);
        passed++;
    } catch (err) {
        console.log(` ${colors.red}✖${colors.reset} ${name}`);
        console.log(`   ${colors.dim}${err.message}${colors.reset}`);
        failed++;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

const authHeaders = {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY
};

async function runTests() {
    console.log(`\n${colors.cyan}--- Starting Verification: External & UI Layers ---${colors.reset}\n`);

    // 1. Health & Security
    await test('GET /health - Service and Database probe', async () => {
        const res = await fetch(`${BASE}/health`);
        assert(res.status === 200);
        const body = await res.json();
        assert(body.status === 'healthy');
    });

    await test('GET /api/v1/tags - Reject request without X-API-Key', async () => {
        const res = await fetch(`${BASE}/api/v1/tags`);
        assert(res.status === 401, `Expected 401, got ${res.status}`);
    });

    await test('GET /api/v1/tags - Accept valid API key & return metadata', async () => {
        const res = await fetch(`${BASE}/api/v1/tags?asset=R1`, { headers: authHeaders });
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        const tags = await res.json();
        assert(Array.isArray(tags) && tags.length > 0, 'No tags returned');
        assert(tags.some(t => t.is_cpp), 'CPP tags not flagged');
    });

    // 2. EBR Cases 1 & 3
    await test('GET /api/v1/tags/:tag/value - Case 1: Point-in-time value lookup', async () => {
        const res = await fetch(`${BASE}/api/v1/tags/R1.TEMP/value`, { headers: authHeaders });
        assert(res.status === 200);
        const body = await res.json();
        assert(body.name === 'R1.TEMP');
        assert(body.value !== undefined);
    });

    await test('GET /api/v1/tags/:tag/summary - Case 3: Time-weighted summary', async () => {
        const from = new Date(Date.now() - 3600 * 1000).toISOString();
        const to = new Date().toISOString();
        const res = await fetch(`${BASE}/api/v1/tags/R1.TEMP/summary?from=${from}&to=${to}`, { headers: authHeaders });
        assert(res.status === 200);
        const body = await res.json();
        assert(body.time_weighted_avg !== undefined);
    });

    await test('GET /api/v1/tags/:tag/summary - Case 3: Integer time-in-state breakdown', async () => {
        const from = new Date(Date.now() - 3600 * 1000).toISOString();
        const to = new Date().toISOString();
        const res = await fetch(`${BASE}/api/v1/tags/R1.N2_BLANKET/summary?from=${from}&to=${to}`, { headers: authHeaders });
        assert(res.status === 200);
        const body = await res.json();
        assert(Array.isArray(body.timeInState));
    });

    // 3. Multi-tag Readings & Auto-Downsampling
    await test('GET /api/v1/readings - Multi-tag query with downsampling', async () => {
        const from = new Date(Date.now() - 86400 * 1000).toISOString();
        const to = new Date().toISOString();
        const res = await fetch(`${BASE}/api/v1/readings?tags=R1.TEMP,R1.PRES&from=${from}&to=${to}`, { headers: authHeaders });
        assert(res.status === 200);
        const body = await res.json();
        assert(body.resolution === '1m', `Expected 1m resolution, got ${body.resolution}`);
    });

    // 4. Batches & ISA-88 Tree (Case 2)
    let activeBatchId = null;
    await test('GET /api/v1/batches - List historical batches', async () => {
        const res = await fetch(`${BASE}/api/v1/batches?limit=5`, { headers: authHeaders });
        assert(res.status === 200);
        const batches = await res.json();
        assert(batches.length > 0, 'No batches in database');
        activeBatchId = batches[0].batch_id;
    });

    await test('GET /api/v1/batches/:id - Case 2: ISA-88 event tree', async () => {
        assert(activeBatchId, 'No batch ID available');
        const res = await fetch(`${BASE}/api/v1/batches/${activeBatchId}`, { headers: authHeaders });
        assert(res.status === 200);
        const body = await res.json();
        assert(body.batch && Array.isArray(body.events));
    });

    // 5. Outbound Monitoring Push Jobs (Cases 4 & 5)
    let createdJobId = null;
    await test('POST /api/v1/jobs - Schedule push job', async () => {
        assert(activeBatchId, 'Requires a batch ID');
        const res = await fetch(`${BASE}/api/v1/jobs`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
                batchId: activeBatchId,
                reactor: 'R2',
                tagNames: ['R2.PH', 'R2.TEMP'],
                intervalSec: 5,
                kind: 'manual',
                callbackUrl: 'https://httpbin.org/post',
                maxSamples: 10
            })
        });
        assert(res.status === 201);
        const job = await res.json();
        createdJobId = job.id;
    });

    await test('GET /api/v1/jobs/:id - Check job outbox audit log', async () => {
        assert(createdJobId, 'Job ID missing');
        const res = await fetch(`${BASE}/api/v1/jobs/${createdJobId}`, { headers: authHeaders });
        assert(res.status === 200);
        const body = await res.json();
        assert(body.job && Array.isArray(body.samples));
    });

    await test('POST /api/v1/jobs/:id/complete - Complete manual job', async () => {
        assert(createdJobId, 'Job ID missing');
        const res = await fetch(`${BASE}/api/v1/jobs/${createdJobId}/complete`, {
            method: 'POST',
            headers: authHeaders
        });
        assert(res.status === 200);
    });

    // 6. Internal UI Layer & Demo Controls
    await test('GET /ui/simulation/state - Read simulation clock & speed', async () => {
        const res = await fetch(`${BASE}/ui/simulation/state`);
        assert(res.status === 200);
        const state = await res.json();
        assert(state.speed !== undefined);
    });

    await test('POST /ui/simulation/state - Set speed to 60x', async () => {
        const res = await fetch(`${BASE}/ui/simulation/state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ running: true, speed: 60 })
        });
        assert(res.status === 200);
        const state = await res.json();
        assert(state.speed === 60);
    });

    await test('POST /ui/faults - Inject sensor dropout', async () => {
        const res = await fetch(`${BASE}/ui/faults`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: 'R3.TURB', kind: 'dropout' })
        });
        assert(res.status === 201);
    });

    await test('GET /ui/faults - Verify active faults list', async () => {
        const res = await fetch(`${BASE}/ui/faults`);
        assert(res.status === 200);
        const faults = await res.json();
        assert(faults.some(f => f.tag === 'R3.TURB'));
    });

    await test('DELETE /ui/faults - Clear all faults', async () => {
        const res = await fetch(`${BASE}/ui/faults`, { method: 'DELETE' });
        assert(res.status === 200);
    });

    // 7. Live SSE Stream
    await test('GET /ui/stream - Receive 1s composite SSE frame', async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const res = await fetch(`${BASE}/ui/stream`, { signal: controller.signal });
        assert(res.status === 200);
        assert(res.headers.get('content-type').includes('text/event-stream'));

        const reader = res.body.getReader();
        const { value } = await reader.read();
        clearTimeout(timeout);
        reader.cancel();

        const chunk = new TextDecoder().decode(value);
        assert(chunk.includes('data:'), 'Missing SSE event');
    });

    console.log(`\n${colors.cyan}-------------------------------------------${colors.reset}`);
    console.log(`Results: ${colors.green}${passed} Passed${colors.reset} | ${failed > 0 ? colors.red : colors.dim}${failed} Failed${colors.reset}\n`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests();