import { waitForDatabase, query } from './db.js';
import { seedHistory } from './seeder.js';
import { config } from './config.js';
import { logger } from './logger.js';

async function bootstrap() {
  try {
    logger.info('Starting Reactor Process Historian Simulator Service...', 'Bootstrap');

    // 1. Resiliently wait for database readiness and schema initialization
    await waitForDatabase(45, 1500);

    // 2. Check if historical readings exist
    const { rows } = await query('SELECT 1 FROM readings LIMIT 1;');

    if (rows.length === 0) {
      logger.info(
        `Empty Database Detected: Automatically seeding ${config.autoSeedDays}-day history...`,
        'Bootstrap'
      );
      try {
        await seedHistory({ days: config.autoSeedDays });
        logger.info('Auto-seeding completed successfully.', 'Bootstrap');
      } catch (seedErr) {
        logger.error(
          `Auto-seeding encountered an error: ${seedErr.message}. Starting continuous engine anyway...`,
          'Bootstrap',
          seedErr
        );
      }
    } else {
      logger.info('Historical readings already present. Skipping auto-seeder.', 'Bootstrap');
      // Ensure continuous aggregates cover existing historical records
      try {
        const { rows: aggCheck } = await query('SELECT count(*) FROM readings_1min;');
        if (parseInt(aggCheck[0]?.count || '0', 10) < 5000) {
          logger.info('Backfilled continuous aggregates missing. Refreshing readings_1min...', 'Bootstrap');
          await query("CALL refresh_continuous_aggregate('readings_1min', NOW() - INTERVAL '7 days', NOW());");
          logger.info('Continuous aggregate refresh completed.', 'Bootstrap');
        }
      } catch (aggErr) {
        // Non-blocking
      }
    }

    // 3. Launch continuous simulation engine
    logger.info('Launching continuous simulation engine...', 'Bootstrap');
    await import('./index.js');
  } catch (err) {
    logger.error(`Bootstrap fatal error: ${err.message}`, 'Bootstrap', err);
    process.exit(1);
  }
}

bootstrap();