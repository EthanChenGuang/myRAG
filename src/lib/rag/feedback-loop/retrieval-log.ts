import type { RetrievalLogEntry } from '@/lib/rag-eval/contracts.generated';
import type { LogContext, RetrievalResult } from '../types';
import type { RetrievalLogLevel } from './config';

export type { LogContext } from '../types';

export interface BuildRetrievalLogRowInput {
  result: RetrievalResult;
  tenantKey: string;
  stageLatency: Record<string, number>;
  latencyMs: number;
  logContext: LogContext;
  mode: Exclude<RetrievalLogLevel, 'off'>;
  query: string | undefined;
}

export type RetrievalLogRow = Omit<RetrievalLogEntry, 'id' | 'tenant_key' | 'created_at'>;

export function buildRetrievalLogRow(_input: BuildRetrievalLogRowInput): RetrievalLogRow {
  return {} as RetrievalLogRow;
}

export interface WriteRetrievalLogOptions {
  expectedTenantKey: string;
  client?: unknown;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export async function writeRetrievalLog(_row: RetrievalLogRow, _options: WriteRetrievalLogOptions): Promise<void> {}
