import { SimulationEngine } from './engine.js';
import { logger } from './logger.js';

export const engine = new SimulationEngine();

let isShuttingDown = false;
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`Received ${signal}. Gracefully stopping simulation engine...`, 'Process');
  try {
    await engine.stop();
  } catch (err) {
    logger.error(`Error during engine shutdown: ${err.message}`, 'Process', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection detected', 'Process', reason);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`, 'Process', err);
  shutdown('uncaughtException');
});

// Auto-start engine when imported or run
(async () => {
  try {
    await engine.initialize();
    engine.start();
  } catch (err) {
    logger.error(`Engine failed to start: ${err.message}`, 'Process', err);
    process.exit(1);
  }
})();