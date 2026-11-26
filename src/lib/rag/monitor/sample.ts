export interface WeeklySampleConfig {
  weekly_cap: number;
  pilot_multiplier: number;
  pilot_cap_share: number;
  drift_fill_share: number;
}

export interface SampleCandidateRow {
  id: string;
  trace_id: string | null;
  query_masked: string;
  query_fingerprint: string;
  language: string | null;
  channel: 'chat' | 'embed' | 'voice';
  user_id: string | null;
  cluster: string | null;
}

export function allocateStrata(_strata: ReadonlyArray<{ key: string; size: number }>, _cap: number): Map<string, number> {
  return new Map();
}
export function isoWeekLabel(_monday: Date): string {
  return '';
}
export function sampleWindow(_now: Date): { since: string; until: string; week: string } {
  return { since: '', until: '', week: '' };
}
export function stratumKey(_row: { cluster: string | null; language: string | null; channel: string }): string {
  return '';
}
export function loadSampleConfig(_raw?: unknown): WeeklySampleConfig {
  return { weekly_cap: 0, pilot_multiplier: 0, pilot_cap_share: 0, drift_fill_share: 0 };
}
export function planWeeklySample(_input: unknown): {
  items: Array<{ row: SampleCandidateRow; source: string; stratum: string; sampling_weight: number }>;
  by_source: Record<string, number>;
  by_language: Record<string, number>;
  excluded_queued: number;
} {
  return { items: [], by_source: {}, by_language: {}, excluded_queued: 0 };
}
export async function drawWeeklySample(_admin: unknown, _options: unknown): Promise<any> {
  return { written: false, missing: [] };
}
export async function sampleStatus(_admin: unknown, _tenantKey: string, _options?: unknown): Promise<any> {
  return { enabled: false, missing: [], clusters: {}, by_language: {} };
}
export async function sampleTenants(_admin: unknown, _now: Date): Promise<string[]> {
  return [];
}
