export type TerminologyAdminFailure = 'not_admin' | 'not_found' | 'version_conflict' | 'workspace_layer_unavailable' | 'limit' | 'invalid' | 'unavailable';
type Failed = { ok: false; reason: TerminologyAdminFailure; currentVersion?: number; issues?: Array<{ code: string; severity: string }> };
type Any = { ok: true; [key: string]: any } | Failed; // eslint-disable-line @typescript-eslint/no-explicit-any
const no = async (..._args: unknown[]): Promise<Any> => ({ ok: false, reason: 'unavailable' });
export const terminologyEnabledLanguages = (): string[] => [];
export const listEntries = no;
export const createEntry = no;
export const updateEntry = no;
export const deleteEntry = no;
export const setSuppression = no;
export const getVersions = no;
export const listAudit = no;
