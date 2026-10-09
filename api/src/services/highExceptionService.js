import { EXTERNAL_CONFIG } from '../config/externalConfig.js';
import { logger } from '../utils/logger.js';
import { extractTextValue } from '../utils/formatters.js';
import { sendHighExceptionToMake } from '../clients/makeClient.js';
import {
    checkInstructionAlertCooldown,
    recordInstructionAlert,
    claimHighExceptions
} from '../dal/externalDal.js';

/**
 * Builds a deterministic deduplication key for an individual exception item in ActualResult.
 */
export function getHighExceptionDedupeKey(batch = {}, phase = {}, step = {}, instruction = {}, item = {}, idx = 0) {
    const batchId = String(batch.BatchId || '').trim();
    const phaseId = phase.PhaseId !== undefined && phase.PhaseId !== null ? String(phase.PhaseId).trim() : '';
    const stepId = step.StepId !== undefined && step.StepId !== null ? String(step.StepId).trim() : '';
    const instructionId = instruction.InstructionId !== undefined && instruction.InstructionId !== null ? String(instruction.InstructionId).trim() : '';
    const repeatNo = (item.RepeatNo !== undefined && item.RepeatNo !== null) ? String(item.RepeatNo).trim() : '';
    const itemIdentifier = repeatNo || (item.ExecutedDate ? String(item.ExecutedDate).trim() : idx);
    return `${batchId}:${phaseId}:${stepId}:${instructionId}:${itemIdentifier}`;
}

/**
 * Checks an incoming BatchLine instruction payload for High Exceptions that require shopfloor intervention.
 */
export async function checkAndForwardHighExceptions(body = {}) {
    const data = body.Data || {};
    const batch = data.Batch || {};
    const phase = batch.Phase || {};
    const step = phase.Step || {};
    const instruction = step.Instruction || {};
    const actualResults = Array.isArray(instruction.ActualResult) ? instruction.ActualResult : [];

    if (actualResults.length === 0) {
        return { matched: false, results: [] };
    }

    // 1. Pre-extract static instruction-level metadata once (O(1))
    const basePayload = {
        BatchId: batch.BatchId || '',
        ProcessNumber: batch.ProcessNumber || '',
        PhaseId: phase.PhaseId !== undefined && phase.PhaseId !== null ? String(phase.PhaseId) : '',
        PhaseDescription: phase.PhaseDescription || '',
        StepId: step.StepId !== undefined && step.StepId !== null ? String(step.StepId) : '',
        StepDescription: step.StepDescription || '',
        InstructionId: instruction.InstructionId !== undefined && instruction.InstructionId !== null ? String(instruction.InstructionId) : '',
        InstructionDescription: instruction.InstructionDescription || '',
        ExpectedResult: extractTextValue(instruction.ExpectedResult),
        LowerLimit: extractTextValue(instruction.LowerLimit),
        UpperLimit: extractTextValue(instruction.UpperLimit)
    };

    // Instruction identifier representing (BatchId + PhaseId + StepId + InstructionId)
    const instructionKey = `${basePayload.BatchId}:${basePayload.PhaseId}:${basePayload.StepId}:${basePayload.InstructionId}`;

    // 2. Fast single-pass filter for candidate high exceptions
    const candidates = [];
    for (let idx = 0; idx < actualResults.length; idx++) {
        const item = actualResults[idx];
        if (!item) continue;

        // Fast rejection for non-exception items
        const hasEx = item.HasException === true || String(item.HasException).toLowerCase() === 'true';
        if (!hasEx) continue;

        const isHigh = String(item.ExceptionLevel || '').trim().toLowerCase() === 'high';
        if (!isHigh) continue;

        const what = item.What ? String(item.What).trim() : '';
        const why = item.Why ? String(item.Why).trim() : '';
        if (!what || !why) continue;

        const dedupeKey = getHighExceptionDedupeKey(batch, phase, step, instruction, item, idx);

        candidates.push({
            dedupeKey,
            basePayload,
            exceptionItem: {
                RepeatNo: (item.RepeatNo !== undefined && item.RepeatNo !== null) ? item.RepeatNo : null,
                Value: item.Value !== null && item.Value !== undefined ? String(item.Value) : '',
                What: what,
                Why: why
            }
        });
    }

    if (candidates.length === 0) {
        return { matched: false, results: [] };
    }

    // 3. 10-Minute Cooldown Check: Suppress if an alert was already dispatched within cooldown window
    const cooldownStatus = await checkInstructionAlertCooldown(instructionKey, EXTERNAL_CONFIG.HIGH_EXCEPTION_COOLDOWN_MINUTES);
    if (cooldownStatus.inCooldown) {
        await claimHighExceptions(candidates);
        logger.info('HighException', `Suppressed alert for Batch ${basePayload.BatchId}, Instruction ${basePayload.InstructionId} (${candidates.length} exception(s) within ${EXTERNAL_CONFIG.HIGH_EXCEPTION_COOLDOWN_MINUTES}m cooldown window; last sent at ${cooldownStatus.lastAlertedAt}).`);
        return {
            matched: true,
            suppressed: true,
            reason: `Alert suppressed: within ${EXTERNAL_CONFIG.HIGH_EXCEPTION_COOLDOWN_MINUTES}-minute cooldown for instruction ${instructionKey}`,
            lastAlertedAt: cooldownStatus.lastAlertedAt,
            results: []
        };
    }

    // 4. Atomic claim in PostgreSQL
    const claimed = await claimHighExceptions(candidates);
    if (claimed.length === 0) {
        return { matched: false, results: [] };
    }

    const exceptionItems = claimed.map(c => c.exceptionItem);
    const totalCount = exceptionItems.length;

    // 5. Build readable text summary
    const summaryLines = [
        `${totalCount} High Exception${totalCount > 1 ? 's' : ''} detected for Batch ${basePayload.BatchId}, Instruction ${basePayload.InstructionId}:`
    ];
    for (const ex of exceptionItems) {
        const repLabel = ex.RepeatNo != null ? `Repeat ${ex.RepeatNo}` : 'Repeat N/A';
        const valLabel = ex.Value ? ` (Value: ${ex.Value})` : '';
        summaryLines.push(`• ${repLabel}${valLabel}: ${ex.What}${ex.Why && ex.Why !== ex.What ? ` - ${ex.Why}` : ''}`);
    }
    const summaryText = summaryLines.join('\n');

    // Consolidated payload containing strictly the base metadata and the text Summary
    const consolidatedPayload = {
        ...basePayload,
        Summary: summaryText
    };

    logger.info('HighException', `Atomically claimed ${totalCount} new High Exception(s). Dispatching consolidated alert to Make.com...`);

    // 6. Record alert dispatch timestamp in PostgreSQL for cooldown enforcement
    await recordInstructionAlert(
        instructionKey,
        basePayload.BatchId,
        basePayload.PhaseId,
        basePayload.StepId,
        basePayload.InstructionId
    );

    // 7. Send exactly ONE consolidated message to Make.com
    const res = await sendHighExceptionToMake(consolidatedPayload);

    return { matched: true, suppressed: false, results: [{ payload: consolidatedPayload, result: res }] };
}
