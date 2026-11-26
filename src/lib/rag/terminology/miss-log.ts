import type { RpcClient } from '../backend/supabase-rpc';
import { getRagDeps } from '../deps';
import type { RefusalRecord } from '../refusal/types';
import { scopeKey, type TenantScope } from '../tenant/scope';
import { maskPII } from '../trace/mask';
import type { Candidate, Profile, RetrievalStatus } from '../types';
import type { TerminologyHashStage } from '../v2/config-hash';

/** D-25: the write never holds the request longer than this, and the response path never awaits it. */
export const MISS_LOG_TIMEOUT_MS = 500;
export const MISS_LOG_QUERY_MAX_CHARS = 500;

const MISS_LOG_PROFILES: ReadonlySet<Profile> = new Set<Profile>(['chat', 'embed', 'voice']);
const FAILED = '[RAG Terminology] miss log write failed';

export interface MissLogInput {
  /** RAG_TERMINOLOGY_MINING. */
  enabled: boolean;
  profile: Profile;
  scope: TenantScope | null;
  query: string;
  queryLanguage: string | null;
  status: RetrievalStatus;
  reason: string;
  refusal: RefusalRecord | null;
  /** The candidates the result carries. */
  candidates: readonly Candidate[];
  /** The scored candidates before a refusal emptied the list; the top fused score comes from these when given. */
  scoredCandidates?: readonly Candidate[];
  terminology?: TerminologyHashStage;
  retrievalConfigHash: string;
}

export interface MissLogOptions {
  /** Tests: the service-role client. */
  client?: RpcClient;
  timeoutMs?: number;
}

/** D-25: an empty request, a refusal or a degraded request with no candidates, for chat, embed and voice only. */
export function shouldRecordMiss(input: MissLogInput): boolean {
  if (!input.enabled || !input.scope || !MISS_LOG_PROFILES.has(input.profile)) return false;
  if (input.refusal?.decision === 'refuse') return true;
  if (input.status === 'empty') return true;
  return input.status === 'degraded' && input.candidates.length === 0;
}

function topScore(candidates: readonly Candidate[]): number | null {
  let best: number | null = null;
  for (const candidate of candidates) {
    const score = candidate.fused_score ?? candidate.final_score;
    if (typeof score === 'number' && Number.isFinite(score) && (best === null || score > best)) best = score;
  }
  return best;
}

function dictionaryVersion(stage: TerminologyHashStage | undefined): string | null {
  return stage?.enabled === true && typeof stage.version === 'string' ? stage.version : null;
}

function missRow(input: MissLogInput): Record<string, unknown> {
  const masked = maskPII(input.query);
  return {
    source: 'miss_log',
    query_masked: Array.from(masked).slice(0, MISS_LOG_QUERY_MAX_CHARS).join(''),
    language: input.queryLanguage,
    status: input.status,
    reason: input.reason,
    top_score: topScore(input.scoredCandidates ?? input.candidates),
    dictionary_version: dictionaryVersion(input.terminology),
    retrieval_config_hash: input.retrievalConfigHash,
    profile: input.profile,
  };
}

function failed(code: string): void {
  console.warn(FAILED, { code });
}

/**
 * D-25: records one masked miss through rag_term_record_miss. Never rejects; the caller does not await it.
 * A write still pending after the timeout is aborted and logged; the log never carries the query.
 */
export async function recordMiss(input: MissLogInput, options: MissLogOptions = {}): Promise<void> {
  if (!shouldRecordMiss(input) || !input.scope) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = options.client ?? (getRagDeps().adminClient() as unknown as RpcClient | null);
    if (!client) {
      failed('admin_client_unavailable');
      return;
    }
    const query = input.query.trim();
    if (!query) return;
    const request = client.rpc('rag_term_record_miss', { p_tenant_key: scopeKey(input.scope), p_row: missRow({ ...input, query }) });
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, options.timeoutMs ?? MISS_LOG_TIMEOUT_MS);
    });
    const outcome = await Promise.race([Promise.resolve(request.abortSignal(controller.signal)), timeout]);
    if (outcome === 'timeout') failed('timeout');
    else if (outcome.error) failed(outcome.error.code ?? 'rpc_error');
  } catch {
    failed('exception');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
