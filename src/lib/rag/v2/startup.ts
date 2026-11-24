import type { SupabaseClient } from '@supabase/supabase-js';
import { loadRagConfig, type RagEnvInput } from '../config';
import { getRagDeps } from '../deps';
import { icuSegmentsChinese } from '../lexical/icu-check';
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10));
  const pb = b.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const left = pa[index] ?? 0;
    const right = pb[index] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

export type V2StartupStatus = 'ok' | 'degraded' | 'not_checked';

export interface V2StartupVerdict {
  status: V2StartupStatus;
  icuAvailable: boolean;
  adminKeyPresent: boolean;
  pgvectorVersion: string | null;
  reasons: readonly string[];
  checkedAt: number | null;
}

export interface V2StartupDeps {
  ragEnv: () => RagEnvInput;
  adminClient: () => SupabaseClient | null;
  icuSegmentsChinese?: () => boolean;
  pgvectorVersion?: (client: SupabaseClient) => Promise<string | null>;
}

const loggedKeys = new Set<string>();

let verdict: V2StartupVerdict = {
  status: 'not_checked',
  icuAvailable: true,
  adminKeyPresent: true,
  pgvectorVersion: null,
  reasons: [],
  checkedAt: null,
};

let startupRun: Promise<V2StartupVerdict> | null = null;

function logOnce(key: string, level: 'error' | 'warn', message: string, data?: Record<string, unknown>): void {
  if (loggedKeys.has(key)) return;
  loggedKeys.add(key);
  const line = data ? `${message} ${JSON.stringify(data)}` : message;
  if (level === 'error') console.error(`[RAG Config] ${line}`);
  else console.warn(`[RAG Config] ${line}`);
}

async function readPgvectorVersion(client: SupabaseClient): Promise<string | null> {
  const { data, error } = await client
    .from('pg_extension' as never)
    .select('extversion')
    .eq('extname', 'vector')
    .maybeSingle();
  if (error || !data || typeof (data as { extversion?: string }).extversion !== 'string') return null;
  return (data as { extversion: string }).extversion;
}

async function runChecks(deps: V2StartupDeps): Promise<V2StartupVerdict> {
  const config = loadRagConfig(deps.ragEnv());
  if (config.pipeline !== 'v2') {
    verdict = { status: 'not_checked', icuAvailable: true, adminKeyPresent: true, pgvectorVersion: null, reasons: [], checkedAt: null };
    return verdict;
  }

  const reasons: string[] = [];
  const icu = deps.icuSegmentsChinese ?? icuSegmentsChinese;
  const icuAvailable = icu();
  if (!icuAvailable) {
    reasons.push('icu_unavailable');
    logOnce('icu', 'error', `ICU cannot segment Chinese as expected (icu ${process.versions.icu})`);
  }

  const admin = deps.adminClient();
  const adminKeyPresent = admin !== null;
  if (!adminKeyPresent) {
    reasons.push('admin_key_missing');
    logOnce('admin_key', 'error', 'SUPABASE_SERVICE_ROLE_KEY is missing; retrieval RPCs are unavailable');
  }

  let pgvectorVersion: string | null = null;
  if (admin) {
    try {
      pgvectorVersion = deps.pgvectorVersion ? await deps.pgvectorVersion(admin) : await readPgvectorVersion(admin);
    } catch {
      pgvectorVersion = null;
    }
  }

  if (config.v2.iterativeScan !== 'off' && pgvectorVersion && compareSemver(pgvectorVersion, '0.8.0') < 0) {
    reasons.push('pgvector_iterative_scan_unsupported');
    logOnce('pgvector_iterative', 'warn', 'iterative scan needs pgvector 0.8.0 or newer', {
      found: pgvectorVersion,
      required: '0.8.0',
    });
  }

  verdict = {
    status: reasons.length === 0 ? 'ok' : 'degraded',
    icuAvailable,
    adminKeyPresent,
    pgvectorVersion,
    reasons,
    checkedAt: Date.now(),
  };
  return verdict;
}

export function getV2StartupVerdict(): V2StartupVerdict {
  return verdict;
}

export function verifyV2Startup(deps?: Partial<V2StartupDeps>): Promise<V2StartupVerdict> {
  const base = getRagDeps();
  const resolved: V2StartupDeps = {
    ragEnv: deps?.ragEnv ?? base.ragEnv,
    adminClient: deps?.adminClient ?? base.adminClient,
    ...(deps?.icuSegmentsChinese ? { icuSegmentsChinese: deps.icuSegmentsChinese } : {}),
    ...(deps?.pgvectorVersion ? { pgvectorVersion: deps.pgvectorVersion } : {}),
  };
  if (!startupRun) {
    startupRun = runChecks(resolved).catch(() => {
      verdict = { ...verdict, status: 'degraded', reasons: [...verdict.reasons, 'startup_failed'], checkedAt: Date.now() };
      return verdict;
    });
  }
  return startupRun;
}

export function resetV2StartupForTests(): void {
  loggedKeys.clear();
  startupRun = null;
  verdict = {
    status: 'not_checked',
    icuAvailable: true,
    adminKeyPresent: true,
    pgvectorVersion: null,
    reasons: [],
    checkedAt: null,
  };
}