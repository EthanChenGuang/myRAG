import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RetrievalLogEntry } from '@/lib/rag-eval/contracts.generated';
import { getRagDeps } from '../deps';
import { detectLanguageWithConfidence, type LanguageDetection } from '../lang/detect';
import { maskPII } from '../trace/mask';
import { topkRedundancy } from '../v2/diversify';
import type { Candidate, LogChannel, LogContext, LogOutcomeValue, RagMode, RetrievalResult } from '../types';
import type { RetrievalLogLevel } from './config';
import { effectiveLogMode, type EffectiveLogModeDeps } from './settings';

export type { LogContext } from '../types';

export type RetrievalLogRow = Omit<RetrievalLogEntry, 'id' | 'tenant_key' | 'created_at'>;
type LogCandidate = NonNullable<RetrievalLogRow['candidates']>[number];

export interface BuildRetrievalLogRowInput {
  result: RetrievalResult;
  /** The collector's tenant key; the database computes its own and the writer compares the two. */
  tenantKey: string;
  stageLatency: Record<string, number>;
  latencyMs: number;
  logContext: LogContext;
  mode: Exclude<RetrievalLogLevel, 'off'>;
  /** Held in memory only: masked and stored in masked_query mode, otherwise read for its language code alone. */
  query: string | undefined;
}

export const MAX_LOGGED_CANDIDATES = 50;
export const MAX_QUERY_LENGTH = 2000;
export const WRITE_TIMEOUT_MS = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SHORT_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const STAGE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_CODE = /^[A-Za-z0-9_]{1,32}$/;
const CHANNELS: readonly LogChannel[] = ['chat', 'embed', 'voice'];
const RAG_MODES: readonly RagMode[] = ['strict', 'balanced', 'flexible', 'bypass'];
const OUTCOMES: readonly LogOutcomeValue[] = ['answered', 'refused_no_context', 'kb_unavailable', 'degraded_answer', 'unknown'];
const UNDETERMINED = 'und';

/** The value when it is a language code, else null; text is never passed through. */
export function toLanguageCode(value: unknown): string | null {
  return typeof value === 'string' && LANGUAGE_CODE.test(value) ? value : null;
}

/** The single mapping from the detector to a stored confidence; Phase 7 may replace it with a calibrated score. */
export function queryLanguageConfidence(detection: LanguageDetection, storedLanguage: string | null): number | null {
  const detected = toLanguageCode(detection.language);
  if (detected === null || detected !== storedLanguage) return null;
  return detection.confident ? 1 : 0.5;
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function shortCodeOrNull(value: unknown): string | null {
  return typeof value === 'string' && SHORT_CODE.test(value) ? value : null;
}

function normaliseForFingerprint(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function logCandidate(item: Candidate, rank: number, keptIds: ReadonlySet<string>): LogCandidate | null {
  const chunkId = typeof item.chunk_id === 'string' ? item.chunk_id : String(item.chunk_id ?? '');
  if (chunkId.length === 0 || chunkId.length > 128 || !UUID.test(item.document_id ?? '')) return null;
  const entry: LogCandidate = {
    chunk_id: chunkId,
    document_id: item.document_id,
    rank,
    similarity: finite(item.similarity) ? item.similarity : 0,
    kept: keptIds.has(chunkId),
  };
  if (finite(item.rerank_score)) entry.rerank_score = item.rerank_score;
  if (finite(item.fused_score)) entry.fused_score = item.fused_score;
  const language = toLanguageCode(item.language);
  if (language !== null) entry.language = language;
  return entry;
}

function chunkLanguages(result: RetrievalResult): string[] {
  const languageById = new Map<string, string | null>();
  for (const item of result.candidates) {
    if (!languageById.has(String(item.chunk_id))) languageById.set(String(item.chunk_id), toLanguageCode(item.language));
  }
  const ordered = result.kept
    .map((chunk, index) => ({ chunk, index }))
    .sort((a, b) => (finite(a.chunk.rank) && finite(b.chunk.rank) ? a.chunk.rank - b.chunk.rank : 0) || a.index - b.index);
  const languages: string[] = [];
  for (const { chunk } of ordered) {
    const language = languageById.get(String(chunk.chunk_id)) ?? UNDETERMINED;
    if (!languages.includes(language)) languages.push(language);
  }
  return languages;
}

function topScore(result: RetrievalResult): number | null {
  const first = result.candidates[0];
  if (!first) return null;
  if (finite(first.rerank_score)) return first.rerank_score;
  return finite(first.similarity) ? first.similarity : null;
}

function stageLatency(raw: Record<string, number>): Record<string, number> {
  const latency: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (STAGE_KEY.test(name) && finite(value) && value >= 0) latency[name] = value;
  }
  return latency;
}

/** Pure: ids, ranks, scores, codes and counts; the masked query only in masked_query mode. Never chunk, answer or document text. */
export function buildRetrievalLogRow(input: BuildRetrievalLogRowInput): RetrievalLogRow {
  const { result, logContext, mode } = input;
  const query = typeof input.query === 'string' ? input.query : '';
  const keptIds = new Set(result.kept.map((chunk) => String(chunk.chunk_id)));

  const candidates: LogCandidate[] = [];
  result.candidates.slice(0, MAX_LOGGED_CANDIDATES).forEach((item, index) => {
    const entry = logCandidate(item, index + 1, keptIds);
    if (entry) candidates.push(entry);
  });

  const detection = detectLanguageWithConfidence(query);
  const queryLanguage = toLanguageCode(result.queryLanguage) ?? toLanguageCode(detection.language);

  let queryMasked: string | null = null;
  let queryFingerprint: string | null = null;
  if (mode === 'masked_query' && query.length > 0) {
    const masked = maskPII(query);
    queryMasked = masked.slice(0, MAX_QUERY_LENGTH);
    queryFingerprint = createHash('sha256').update(normaliseForFingerprint(masked)).digest('hex');
  }

  const holder = result.logOutcome;
  const outcome = holder && OUTCOMES.includes(holder.value) ? holder.value : 'unknown';
  const channel = logContext.channel && CHANNELS.includes(logContext.channel) ? logContext.channel : 'chat';
  const ragMode = logContext.ragMode && RAG_MODES.includes(logContext.ragMode) ? logContext.ragMode : null;
  const configHash = typeof result.retrievalConfigHash === 'string' && result.retrievalConfigHash.length <= 128 ? result.retrievalConfigHash : null;
  const redundancy = topkRedundancy(result.kept);

  return {
    trace_id: result.traceId,
    user_id: uuidOrNull(logContext.userId),
    organization_id: uuidOrNull(logContext.organizationId),
    chat_id: uuidOrNull(logContext.chatId),
    answer_id: null,
    channel,
    rag_mode: ragMode,
    pipeline: holder?.pipeline === 'v2' ? 'v2' : 'legacy',
    retrieval_config_hash: configHash,
    query_language: queryLanguage,
    query_language_confidence: queryLanguageConfidence(detection, queryLanguage),
    chunk_languages: chunkLanguages(result),
    answer_language: toLanguageCode(holder?.answerLanguage),
    query_masked: queryMasked,
    query_fingerprint: queryFingerprint,
    status: result.status,
    refusal_decision: shortCodeOrNull(result.refusal?.decision),
    refusal_reason: shortCodeOrNull(result.refusal?.reason),
    outcome,
    candidates,
    candidate_count: result.candidates.length,
    top_score: topScore(result),
    latency_ms: finite(input.latencyMs) && input.latencyMs >= 0 ? Math.round(input.latencyMs) : 0,
    stage_latency: stageLatency(input.stageLatency),
    feedback_vote: null,
    feedback_kind: null,
    feedback_reasons: [],
    feedback_at: null,
    source_opened_count: 0,
    ...(redundancy !== null ? { topk_redundancy: redundancy } : {}),
  };
}

interface DbResponse {
  data: { id?: unknown; tenant_key?: unknown } | null;
  error: unknown;
}

/** The query-builder surface the writer uses. */
interface LogQuery extends PromiseLike<DbResponse> {
  insert(row: unknown): LogQuery;
  select(columns: string): LogQuery;
  delete(): LogQuery;
  eq(column: string, value: unknown): LogQuery;
  abortSignal(signal: AbortSignal): LogQuery;
  single(): LogQuery;
}

/** The database client surface the writer uses; the admin client in production. */
interface LogClient {
  from(table: string): LogQuery;
}

export interface WriteRetrievalLogOptions {
  /** The collector's tenant key; a row whose generated tenant_key differs is deleted again. */
  expectedTenantKey: string;
  /** Defaults to the admin client from the RAG deps. */
  client?: SupabaseClient | LogClient | null;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Overrides for the tenant-setting read (D-06); the writer's client is used when none is given. */
  settings?: EffectiveLogModeDeps;
}

class WriteTimeout extends Error {}

function traceHash(traceId: string): string {
  return createHash('sha256').update(traceId).digest('hex').slice(0, 12);
}

function errorClass(error: unknown): string {
  if (error instanceof WriteTimeout) return 'timeout';
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code;
    const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === 'string' && ERROR_CODE.test(name)) return name;
  }
  return 'unknown';
}

/** Awaits the query with an abort signal and a timer of its own, so a client that ignores the signal still cannot hang the task. */
async function timeBoxed<T>(timeoutMs: number, run: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new WriteTimeout());
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(run(controller.signal)), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Inserts one row with the admin client, time-boxed; never throws and logs codes and counts only (D-27). */
export async function writeRetrievalLog(row: RetrievalLogRow, options: WriteRetrievalLogOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.warn(line));
  const timeoutMs = options.timeoutMs ?? WRITE_TIMEOUT_MS;
  const report = (code: string, error: string | null): void => {
    try {
      log(
        `[Retrieval Log] ${JSON.stringify({
          code,
          trace: traceHash(row.trace_id),
          ...(error !== null ? { error } : {}),
          candidates: row.candidates?.length ?? 0,
        })}`,
      );
    } catch {
      // logging must never affect the request
    }
  };

  try {
    if (!TENANT_KEY.test(options.expectedTenantKey)) return;
    const client = (options.client === undefined ? getRagDeps().adminClient() : options.client) as unknown as LogClient | null;
    if (!client) {
      report('write_failed', 'no_admin_client');
      return;
    }

    // D-06: the tenant may lower the level; an opted-out tenant gets no row and an ids tenant no query text. Fails closed to off.
    const mode = await effectiveLogMode(options.expectedTenantKey, {
      client: client as unknown as SupabaseClient,
      ...(options.settings ?? {}),
    });
    if (mode === 'off') return;
    const stored: RetrievalLogRow = mode === 'ids' ? { ...row, query_masked: null, query_fingerprint: null } : row;

    const inserted = await timeBoxed<DbResponse>(timeoutMs, (signal) =>
      client.from('rag_retrieval_log').insert(stored).select('id, tenant_key').abortSignal(signal).single(),
    );
    if (inserted.error) {
      report('write_failed', errorClass(inserted.error));
      return;
    }
    const tenantKey = inserted.data?.tenant_key;
    if (tenantKey === options.expectedTenantKey) return;

    let remove = client.from('rag_retrieval_log').delete().eq('trace_id', row.trace_id);
    if (typeof inserted.data?.id === 'string') remove = remove.eq('id', inserted.data.id);
    try {
      const removed = await timeBoxed<DbResponse>(timeoutMs, (signal) => remove.abortSignal(signal));
      report('tenant_mismatch', removed?.error ? errorClass(removed.error) : null);
    } catch (error) {
      report('tenant_mismatch', errorClass(error));
    }
  } catch (error) {
    report('write_failed', errorClass(error));
  }
}
