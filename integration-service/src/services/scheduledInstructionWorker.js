import { logger } from '../utils/logger.js';
import {
    claimDueScheduledInstructions,
    markScheduledInstructionCompleted,
    markScheduledInstructionFailed
} from '../dal/externalDal.js';
import { executeScheduledCase1 } from './case1Service.js';
import { executeScheduledCase2 } from './case2Service.js';
import { executeScheduledCase3 } from './continuousIntervalService.js';
import { executeScheduledEventDependentStep, CASE_TYPE_EVENT_DEPENDENT } from './stepTriggeredTemplateService.js';

let workerInterval = null;
let isProcessing = false;

/**
 * Registry of handlers by case type.
 * Easily extensible for Case 2, Case 3, Case 4 (Event-dependent step triggers), etc.
 */
const CASE_DISPATCHERS = {
    1: executeScheduledCase1,
    2: executeScheduledCase2,
    3: executeScheduledCase3,
    [CASE_TYPE_EVENT_DEPENDENT]: executeScheduledEventDependentStep
};

/**
 * Registers a custom case dispatcher handler (allows runtime extension).
 */
export function registerCaseDispatcher(caseType, handler) {
    CASE_DISPATCHERS[caseType] = handler;
}

/**
 * Polls and processes due scheduled instructions from the PostgreSQL persistent queue.
 */
export async function processDueInstructions() {
    if (isProcessing) return; // Prevent concurrent overlapping ticks
    isProcessing = true;

    try {
        const tasks = await claimDueScheduledInstructions(10);
        if (!tasks || tasks.length === 0) {
            return;
        }

        logger.info('ScheduledWorker', `Claimed ${tasks.length} due scheduled instruction(s) for execution.`);

        for (const task of tasks) {
            const handler = CASE_DISPATCHERS[task.case_type];
            if (!handler) {
                const errMsg = `No dispatcher registered for case_type ${task.case_type}`;
                logger.error('ScheduledWorker', errMsg, { taskId: task.id });
                await markScheduledInstructionFailed(task.id, errMsg, false);
                continue;
            }

            try {
                const schedTimeStr = task.scheduled_time instanceof Date ? task.scheduled_time.toISOString() : String(task.scheduled_time);
                logger.info('ScheduledWorker', `Executing task ${task.id} (Case ${task.case_type}, RefInstruction: ${task.ref_instruction}, Scheduled: ${schedTimeStr})...`);
                const result = await handler(task);

                // If handler rescheduled itself (e.g. still waiting for an event to occur), skip markScheduledInstructionCompleted
                if (result?.scheduled) {
                    continue;
                }

                await markScheduledInstructionCompleted(task.id);
                logger.info('ScheduledWorker', `Successfully executed and marked completed: task ${task.id}`);
            } catch (err) {
                logger.error('ScheduledWorker', `Failed executing task ${task.id}:`, err.message);
                await markScheduledInstructionFailed(task.id, err.message, true);
            }
        }
    } catch (err) {
        logger.error('ScheduledWorker', 'Error during scheduled queue processing tick:', err.message);
    } finally {
        isProcessing = false;
    }
}

/**
 * Starts the persistent scheduled instructions worker loop.
 */
export function startScheduledInstructionWorker(pollIntervalMs = 5000) {
    if (workerInterval) return;

    logger.info('ScheduledWorker', `Starting persistent scheduled instructions worker (interval: ${pollIntervalMs}ms)...`);
    workerInterval = setInterval(processDueInstructions, pollIntervalMs);

    // Initial check immediately on startup
    processDueInstructions().catch(err => {
        logger.warn('ScheduledWorker', 'Initial tick error:', err.message);
    });
}

/**
 * Stops the persistent scheduled instructions worker loop gracefully.
 */
export function stopScheduledInstructionWorker() {
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
        logger.info('ScheduledWorker', 'Scheduled instructions worker stopped.');
    }
}
