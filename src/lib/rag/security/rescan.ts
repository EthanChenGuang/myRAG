export type RescanCheck = 'hidden_text' | 'links';

export interface RescanInput {
  check: RescanCheck;
  tenantKey?: string | null;
  dryRun?: boolean;
}

export interface RescanReport {
  check: RescanCheck;
  mode: 'flag' | 'quarantine';
  dryRun: boolean;
  checked: number;
  skipped: number;
  affectedIds: string[];
  quarantined: number;
  flagged: number;
  unavailable: number;
  artifactsFailed: number;
}

export type RescanResult = { ok: true; report: RescanReport } | { ok: false; reason: 'check_off' | 'invalid_tenant' | 'unavailable' };

export async function rescanDocuments(_input: RescanInput): Promise<RescanResult> {
  return { ok: false, reason: 'unavailable' };
}
