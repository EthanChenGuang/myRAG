import { randomBytes } from 'node:crypto';
import { getRagDeps } from '../deps';
import type { Profile, StageFailureReason, StageRecord, StageRunStatus } from '../types';

const TRACE_ID = /^[0-9a-f]{32}$/;

export interface StageEntry {
  name: string;
  status: StageRunStatus;
  reason?: StageFailureReason | 'disabled';
  startedAt: number;
  endedAt: number;
  candidatesIn?: number | null;
  candidatesOut?: number | null;
  rules?: string[];
  detail?: string;
}

export interface TraceCollector {
  readonly traceId: string;
  readonly profile: Profile;
  readonly tenantKey: string;
  readonly startedAt: number;
  now(): number;
  record(entry: StageEntry): StageRecord;
  stages(): StageRecord[];
  toStageLatency(): Record<string, number>;
  toStageStatus(): Record<string, StageRunStatus>;
}

export interface TraceCollectorOptions {
  profile: Profile;
  tenantKey: string;
}

function normaliseTraceId(raw: string): string {
  const candidate = raw.replace(/-/g, '').toLowerCase();
  return TRACE_ID.test(candidate) ? candidate : randomBytes(16).toString('hex');
}

export function createTraceCollector(options: TraceCollectorOptions): TraceCollector {
  const deps = getRagDeps();
  const records: StageRecord[] = [];
  const traceId = normaliseTraceId(deps.randomId());
  const startedAt = deps.now();

  return {
    traceId,
    profile: options.profile,
    tenantKey: options.tenantKey,
    startedAt,
    now: () => deps.now(),
    record(entry) {
      const record: StageRecord = {
        name: entry.name,
        status: entry.status,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        latency_ms: Math.max(0, entry.endedAt - entry.startedAt),
        candidates_in: entry.candidatesIn ?? null,
        candidates_out: entry.candidatesOut ?? null,
        rules: entry.rules ?? [],
      };
      if (entry.reason !== undefined) record.reason = entry.reason;
      if (entry.detail !== undefined) record.detail = entry.detail;
      records.push(record);
      return record;
    },
    stages: () => records.slice(),
    toStageLatency() {
      const latency: Record<string, number> = {};
      for (const record of records) latency[record.name] = record.latency_ms;
      return latency;
    },
    toStageStatus() {
      const status: Record<string, StageRunStatus> = {};
      for (const record of records) status[record.name] = record.status;
      return status;
    },
  };
}
