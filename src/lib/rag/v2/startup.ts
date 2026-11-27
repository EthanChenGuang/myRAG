import type { SupabaseClient } from '@supabase/supabase-js';
import { getChunkingCoverage, type ChunkingCoverageRow } from '../chunking/profile-ops';
import { loadRagConfig, type RagConfig, type RagEnvInput } from '../config';
import { getRagDeps } from '../deps';
import { icuSegmentsChinese } from '../lexical/icu-check';
import { resolveEffectivePipeline } from './readiness';

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

/** How many current ready documents each doc type's active non-legacy chunking profile lacks (counts only). */
export interface V2ChunkingCoverage {
  state: 'checked' | 'coverage_unchecked' | 'not_checked';
  missing: Record<string, number>;
}

export interface V2StartupVerdict {
  status: V2StartupStatus;
  icuAvailable: boolean;
  adminKeyPresent: boolean;
  pgvectorVersion: string | null;
  reasons: readonly string[];
  chunkingCoverage: V2ChunkingCoverage;
  checkedAt: number | null;
}

export interface V2StartupDeps {
  ragEnv: () => RagEnvInput;
  adminClient: () => SupabaseClient | null;
  icuSegmentsChinese?: () => boolean;
  pgvectorVersion?: (client: SupabaseClient) => Promise<string | null>;
  chunkingCoverage?: (signal: AbortSignal) => Promise<ChunkingCoverageRow[]>;
  chunkingCoverageTimeoutMs?: number;
}

/** The coverage read is informational: it never holds startup longer than this, and a slow or failing read is only recorded. */
const COVERAGE_TIMEOUT_MS = 3_000;
const NOT_CHECKED_COVERAGE: V2ChunkingCoverage = { state: 'not_checked', missing: {} };

const loggedKeys = new Set<string>();

let verdict: V2StartupVerdict = {
  status: 'not_checked',
  icuAvailable: true,
  adminKeyPresent: true,
  pgvectorVersion: null,
  reasons: [],
  chunkingCoverage: NOT_CHECKED_COVERAGE,
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

async function readChunkingCoverage(deps: V2StartupDeps): Promise<V2ChunkingCoverage> {
  const read = deps.chunkingCoverage ?? ((signal: AbortSignal) => getChunkingCoverage({ signal }));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, deps.chunkingCoverageTimeoutMs ?? COVERAGE_TIMEOUT_MS);
  });
  let rows: ChunkingCoverageRow[] | 'timeout';
  try {
    rows = await Promise.race([read(controller.signal), timeout]);
  } catch (error) {
    const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
    console.warn('[RAG Chunking] coverage unchecked at startup', { reason: typeof code === 'string' ? code : 'read_failed' });
    return { state: 'coverage_unchecked', missing: {} };
  } finally {
    clearTimeout(timer);
  }
  if (rows === 'timeout') {
    console.warn('[RAG Chunking] coverage unchecked at startup', { reason: 'timeout' });
    return { state: 'coverage_unchecked', missing: {} };
  }

  const missing: Record<string, number> = {};
  for (const row of rows) {
    if (!row.isActive || row.profileId === 'legacy' || row.missingDocuments <= 0) continue;
    missing[row.docType] = row.missingDocuments;
    console.warn(
      `[RAG Chunking] active profile ${row.profileId} for ${row.docType} is missing ${row.missingDocuments} current documents; run npm run rag:rechunk -- --profile ${row.profileId}`,
      { docType: row.docType, profileId: row.profileId, missingDocuments: row.missingDocuments },
    );
  }
  return { state: 'checked', missing };
}

function switchRequested(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/** D-04, D-40: both combinations resolve to a narrower behaviour in loadRagConfig; startup only records and warns. */
function checkSwitchCombinations(env: RagEnvInput, config: RagConfig, reasons: string[]): void {
  if (switchRequested(env.RAG_VERSION_SCOPE) && !config.v2.lexicalSearch) {
    reasons.push('version_scope_needs_lexical');
    logOnce('version_scope_needs_lexical', 'warn', 'invalid switch combination: version scope needs lexical search, retrieval scopes to current versions only', {
      switches: ['RAG_VERSION_SCOPE', 'RAG_LEXICAL_SEARCH'],
    });
  }
  if (switchRequested(env.RAG_IDENTIFIER_FILTER) && !config.v2.identifierIndex) {
    reasons.push('identifier_filter_needs_index');
    logOnce('identifier_filter_needs_index', 'warn', 'invalid switch combination: the identifier filter needs the identifier index, retrieval runs unfiltered', {
      switches: ['RAG_IDENTIFIER_FILTER', 'RAG_IDENTIFIER_INDEX'],
    });
  }
}

async function runChecks(deps: V2StartupDeps): Promise<V2StartupVerdict> {
  const env = deps.ragEnv();
  const config = loadRagConfig(env);
  if (resolveEffectivePipeline(env).pipeline === 'legacy') {
    verdict = {
      status: 'not_checked',
      icuAvailable: true,
      adminKeyPresent: true,
      pgvectorVersion: null,
      reasons: [],
      chunkingCoverage: NOT_CHECKED_COVERAGE,
      checkedAt: null,
    };
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

  const coverageRead: Promise<V2ChunkingCoverage> = admin
    ? readChunkingCoverage(deps)
    : Promise.resolve({ state: 'coverage_unchecked', missing: {} });

  let pgvectorVersion: string | null = null;
  if (admin) {
    try {
      pgvectorVersion = deps.pgvectorVersion ? await deps.pgvectorVersion(admin) : await readPgvectorVersion(admin);
    } catch {
      pgvectorVersion = null;
    }
  }

  const chunkingCoverage = await coverageRead;

  if (config.v2.iterativeScan !== 'off' && pgvectorVersion && compareSemver(pgvectorVersion, '0.8.0') < 0) {
    reasons.push('pgvector_iterative_scan_unsupported');
    logOnce('pgvector_iterative', 'warn', 'iterative scan needs pgvector 0.8.0 or newer', {
      found: pgvectorVersion,
      required: '0.8.0',
    });
  }

  checkSwitchCombinations(env, config, reasons);

  // D-30: a hard attribute filter narrows the approximate dense leg; without an exact scan or iterative scan it can come back short.
  // A warning only: readiness and the reasons list are unchanged.
  if (config.v2.attributeFilter === 'hard' && config.v2.exactScanCutoff === 0 && config.v2.iterativeScan === 'off') {
    logOnce(
      'attribute_filter_hard_approximate',
      'warn',
      'RAG_ATTRIBUTE_FILTER=hard with RAG_EXACT_SCAN_CUTOFF=0 and RAG_HNSW_ITERATIVE_SCAN=off: filtered dense searches can return fewer chunks than asked',
    );
  }

  verdict = {
    status: reasons.length === 0 ? 'ok' : 'degraded',
    icuAvailable,
    adminKeyPresent,
    pgvectorVersion,
    reasons,
    chunkingCoverage,
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
    ...(deps?.chunkingCoverage ? { chunkingCoverage: deps.chunkingCoverage } : {}),
    ...(deps?.chunkingCoverageTimeoutMs !== undefined ? { chunkingCoverageTimeoutMs: deps.chunkingCoverageTimeoutMs } : {}),
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
    chunkingCoverage: NOT_CHECKED_COVERAGE,
    checkedAt: null,
  };
}