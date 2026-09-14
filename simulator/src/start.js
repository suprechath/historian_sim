import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { pool } from './db.js';
import { spawnSync } from 'child_process';

// Resolve and load root .env (two levels up from simulator/src)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function bootstrap() {
  try {
    const client = await pool.connect();

    // Check if readings already exist
    const { rows } = await client.query('SELECT 1 FROM readings LIMIT 1;');
    client.release();

    if (rows.length === 0) {
      const daysToSeed = process.env.AUTO_SEED_DAYS;
      console.log(`--- Empty Database Detected: Automatically seeding ${daysToSeed}-day history ---`);
      const seedProcess = spawnSync('node', ['src/seeder.js', daysToSeed], {
        stdio: 'inherit',
        env: process.env
      });

      if (seedProcess.status !== 0) {
        console.error('Auto-seeding failed. Starting continuous engine anyway...');
      } else {
        console.log('--- Auto-seeding complete! ---');
      }
    } else {
      console.log('Historical readings present. Skipping auto-seeder.');
    }
  } catch (err) {
    console.error('Startup check warning (DB might still be initializing):', err.message);
  }

  // Launch continuous 1-second simulation loop
  await import('./index.js');
}

bootstrap();