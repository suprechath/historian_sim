import { auditLog } from './auditLog.js';
import { requireApiKey } from './requireApiKey.js';

export { auditLog, requireApiKey };
export const authAndAudit = [auditLog, requireApiKey];