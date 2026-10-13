import { logger } from '../utils/logger.js';
import {
    parseBatchLineDate,
    cleanInstructionId
} from '../utils/formatters.js';
import {
    getCombinedDescription,
    extractExceptionTriggers,
    extractInterpretMapping,
    parsePrintLabelPayload,
    parseIntervalString,
    parseDurationString
} from '../utils/instructionParsers.js';
import { reportError } from '../clients/batchLineClient.js';
import { resolveTag, cancelPendingScheduledInstruction } from '../dal/externalDal.js';
import { resolveMetric } from './mathService.js';
import { jobRegistry } from './jobRegistry.js';
import { handleBatchExceptionTrigger } from './exceptionTriggerService.js';
import { handleContinuousIntervalMode } from './continuousIntervalService.js';
import { handleProfileMode, handleRecordMode } from './case3Service.js';

export { handleContinuousIntervalMode };

/**
 * Main coordinator for Print Label Instruction (EBR User Record trigger)
 */
export async function handlePrintLabelInstruction(req, res) {
    let ctx = null;
    try {
        const parsed = parsePrintLabelPayload(req.body);

        logger.info('PrintLabelWebhook', 'Parsed parameters summary:', {
            batch_id: parsed.batchId,
            callback_key: parsed.callbackKey,
            ref_instruction: parsed.refInstruction,
            parameters: parsed.parameters,
            parsed_dates: parsed.parsedDates,
            incoming_instruction_ids: parsed.incomingInstructionIds
        });

        // 1. Check if this request is a STOP signal for an active continuous or future interval job
        const incomingIds = [...(parsed.incomingInstructionIds || [])];
        if (parsed.refInstruction && !incomingIds.includes(cleanInstructionId(parsed.refInstruction))) {
            incomingIds.push(cleanInstructionId(parsed.refInstruction));
        }

        if (parsed.batchId && incomingIds.length > 0) {
            const stoppedJobs = [];
            for (const instId of incomingIds) {
                const cleanInst = cleanInstructionId(instId);
                const jobKey = `${parsed.batchId}_${cleanInst}`;

                // 1. Cancel in persistent PostgreSQL queue directly (cluster & restart safe)
                const dbCancelledCount = await cancelPendingScheduledInstruction(parsed.batchId, instId);
                logger.info('PrintLabel', `Received STOP signal for instruction ${instId} on batch ${parsed.batchId}. Stopping job.`);

                // 2. Also stop legacy in-memory timer if active
                let targetJobKey = null;
                if (jobRegistry.has(jobKey)) {
                    targetJobKey = jobKey;
                } else {
                    const match = jobRegistry.find((job) =>
                        job.batchId === parsed.batchId &&
                        (job.cleanRefInstruction === cleanInst || cleanInstructionId(job.refInstruction) === cleanInst)
                    );
                    if (match) targetJobKey = match.key;
                }

                let totalRepeatsSent = null;
                if (targetJobKey) {
                    const job = jobRegistry.get(targetJobKey);
                    logger.info('PrintLabel', `Received STOP signal for instruction ${job.refInstruction} on batch ${parsed.batchId}. Stopping job.`);
                    totalRepeatsSent = typeof job.getNextBucketIndex === 'function' ? job.getNextBucketIndex() : null;
                    await jobRegistry.stopJob(targetJobKey);
                }

                if (targetJobKey || (dbCancelledCount && dbCancelledCount > 0)) {
                    stoppedJobs.push({
                        refInstruction: instId,
                        totalRepeatsSent
                    });
                }
            }

            if (stoppedJobs.length > 0) {
                return res.json({
                    status: 'stopped',
                    message: `Continuous periodic collection stopped for instruction(s): ${stoppedJobs.map(j => j.refInstruction).join(', ')}`,
                    batch_id: parsed.batchId,
                    stopped_jobs: stoppedJobs
                });
            }

            if (!parsed.parameters.RefElement && !parsed.parameters.RefStartTime) {
                logger.info('PrintLabel', `Received instruction update for [${parsed.incomingInstructionIds.join(', ')}] on batch ${parsed.batchId} with no active job. Acknowledged.`);
                return res.json({
                    status: 'acknowledged',
                    message: `No active continuous job found for instruction(s) ${parsed.incomingInstructionIds.join(', ')}`,
                    batch_id: parsed.batchId
                });
            }
        }

        ctx = {
            topic: parsed.topic,
            batchId: parsed.batchId,
            callbackKey: parsed.callbackKey,
            refElement: parsed.parameters.RefElement,
            refInstruction: parsed.refInstruction,
            refType: parsed.parameters.RefType,
            triggeredByEmail: parsed.user?.executedUserEmail || req.body.TriggeredByEmail || null,
            rawBody: req.body,
            instruction: req.body
        };

        const printLabelDesc = getCombinedDescription(ctx) || [req.body.InstructionDescription, req.body.Description].filter(Boolean).join(' ');
        const interpretConfig = extractInterpretMapping(printLabelDesc);
        if (interpretConfig) {
            logger.info('PrintLabel', 'Found [INTERPRET] mapping for instruction:', interpretConfig.raw);
        }

        const exceptionTriggers = extractExceptionTriggers(printLabelDesc, parsed.refInstruction);
        if (exceptionTriggers.length > 0) {
            return await handleBatchExceptionTrigger(ctx, res, exceptionTriggers);
        }

        if (!parsed.parameters.RefElement) {
            await reportError('[BatchLine PrintLabel]: Missing required RefElement in instruction parameters', { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
            return res.status(400).json({ error: 'Missing required RefElement in instruction parameters' });
        }

        if (!parsed.parameters.RefStartTime) {
            await reportError('[BatchLine PrintLabel]: Missing required RefStartTime in instruction parameters', { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
            return res.status(400).json({ error: 'Missing required RefStartTime in instruction parameters' });
        }

        const startDate = parseBatchLineDate(parsed.parameters.RefStartTime);
        if (!startDate || isNaN(startDate.getTime())) {
            const errMsg = `Invalid date format for RefStartTime ("${parsed.parameters.RefStartTime}")`;
            await reportError(`[BatchLine PrintLabel]: ${errMsg}`, { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
            return res.status(400).json({ error: errMsg });
        }

        let actualStart = startDate;
        let actualEnd = null;

        if (parsed.parameters.RefEndTime && !['null', 'undefined', 'none', ''].includes(String(parsed.parameters.RefEndTime).trim().toLowerCase())) {
            const endDate = parseBatchLineDate(parsed.parameters.RefEndTime);
            if (endDate && !isNaN(endDate.getTime())) {
                [actualStart, actualEnd] = startDate > endDate ? [endDate, startDate] : [startDate, endDate];
            } else {
                const errMsg = `Invalid date format for RefEndTime ("${parsed.parameters.RefEndTime}")`;
                await reportError(`[BatchLine PrintLabel]: ${errMsg}`, { batchId: parsed.batchId, callbackKey: parsed.callbackKey });
                return res.status(400).json({ error: errMsg });
            }
        }

        ctx = {
            topic: parsed.topic,
            batchId: parsed.batchId,
            callbackKey: parsed.callbackKey,
            refElement: parsed.parameters.RefElement,
            refInstruction: parsed.refInstruction,
            refStartTime: actualStart.toISOString(),
            refEndTime: actualEnd ? actualEnd.toISOString() : null,
            refType: parsed.parameters.RefType,
            triggeredByEmail: parsed.user?.executedUserEmail || req.body.TriggeredByEmail || null,
            instructionDescription: '',
            parsedParameters: parsed.parameters,
            instruction: req.body
        };

        const tag = await resolveTag(ctx.refElement, ctx);
        if (!tag) {
            await reportError(`[BatchLine PrintLabel]: Could not resolve tag for RefElement: "${ctx.refElement}"`, ctx);
            return res.status(404).json({ error: `Could not resolve tag for RefElement: "${ctx.refElement}"` });
        }

        const rawStart = parsed.parameters.START;
        const hasStart = rawStart !== null && rawStart !== '' && !isNaN(parseFloat(rawStart));
        const rawStop = parsed.parameters.STOP;
        const hasStop = rawStop !== null && rawStop !== '' && !isNaN(parseFloat(rawStop));

        const intervalConfig = parseIntervalString(parsed.parameters.INTERVAL);
        const durationMinutes = parseDurationString(parsed.parameters.DURATION);

        // Mode 1: Continuous Interval Mode
        if (!actualEnd) {
            if (!intervalConfig) {
                const errMsg = 'Missing required RefEndTime in instruction parameters (or INTERVAL for continuous periodic collection)';
                await reportError(`[BatchLine PrintLabel]: ${errMsg}`, ctx);
                return res.status(400).json({ error: errMsg });
            }
            const startThreshold = hasStart ? parseFloat(rawStart) : null;
            const stopThreshold = hasStop ? parseFloat(rawStop) : null;
            const startDirection = parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null;
            logger.info('PrintLabel', `Identified Continuous Interval Mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
            return await handleContinuousIntervalMode(ctx, res, tag, actualStart, intervalConfig, startThreshold, startDirection, interpretConfig, {
                stopThreshold,
                durationMinutes
            });
        }

        // Mode 2: Future Interval Record Mode
        if (intervalConfig && actualEnd.getTime() > Date.now()) {
            const startThreshold = hasStart ? parseFloat(rawStart) : null;
            const stopThreshold = hasStop ? parseFloat(rawStop) : null;
            const startDirection = parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null;
            logger.info('PrintLabel', `Identified Future Interval Record Mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
            return await handleContinuousIntervalMode(ctx, res, tag, actualStart, intervalConfig, startThreshold, startDirection, interpretConfig, {
                stopThreshold,
                durationMinutes
            });
        }

        // Mode 2b: Future/Live Profile Mode
        if (hasStart && (actualEnd.getTime() > Date.now() || (durationMinutes && durationMinutes > 0))) {
            const startThreshold = parseFloat(rawStart);
            const stopThreshold = hasStop ? parseFloat(rawStop) : null;
            const startDirection = parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null;

            let effectiveIntervalConfig = intervalConfig;
            if (!effectiveIntervalConfig) {
                const sampleCount = 30;
                const durMs = (durationMinutes && durationMinutes > 0)
                    ? (durationMinutes * 60 * 1000)
                    : Math.max(1000, actualEnd.getTime() - actualStart.getTime());
                const intervalMs = Math.max(1000, Math.round(durMs / sampleCount));
                effectiveIntervalConfig = {
                    rawInterval: `${Math.round(intervalMs / 1000)}s`,
                    intervalMinutes: intervalMs / 60000,
                    intervalMs
                };
            }

            let effectiveEnd = actualEnd;
            if (durationMinutes && durationMinutes > 0) {
                const minEndMs = actualStart.getTime() + durationMinutes * 60 * 1000;
                if (!effectiveEnd || effectiveEnd.getTime() < minEndMs) {
                    effectiveEnd = new Date(minEndMs);
                }
            }

            if (effectiveEnd.getTime() > Date.now()) {
                logger.info('PrintLabel', `Identified Future/Live Profile Mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
                return await handleContinuousIntervalMode(ctx, res, tag, actualStart, effectiveIntervalConfig, startThreshold, startDirection, interpretConfig, {
                    stopThreshold,
                    durationMinutes
                });
            }
        }

        // Mode 3: Profile Mode (START specified and RefEndTime is in past/now)
        if (hasStart) {
            const profileConfig = {
                start: parseFloat(rawStart),
                stop: hasStop ? parseFloat(rawStop) : null,
                durationMinutes,
                direction: parsed.parameters.DIRECTION ? String(parsed.parameters.DIRECTION).trim().toLowerCase() : null,
                metric: resolveMetric(ctx.refType)
            };
            logger.info('PrintLabel', `Identified Profile Mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
            return await handleProfileMode(ctx, res, tag, actualStart, actualEnd, profileConfig, intervalConfig, interpretConfig);
        }

        // Mode 4: Record Mode
        logger.info('PrintLabel', `Identified Record Mode for tag "${tag.name}" (batch: ${ctx.batchId})`);
        return await handleRecordMode(ctx, res, tag, actualStart, actualEnd, intervalConfig, interpretConfig);
    } catch (err) {
        logger.error('PrintLabel', 'Webhook error:', err);
        await reportError('[Print Label Webhook Fatal Error]: ' + err.message, ctx || {}, err.stack);
        return res.status(500).json({ error: err.message });
    }
}
