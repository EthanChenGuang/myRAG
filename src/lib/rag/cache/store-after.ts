import { CachedAnswerSchema, type CachedAnswer, type CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../backend/supabase-rpc';
import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { readGenerationConfig } from '../generation/config';
import type { AnswerGroundedness } from '../generation/groundedness';
import type { TenantScope } from '../tenant/scope';
import { scheduleAfterResponse } from '../trace/schedule';
import type { RetrievalResult, RetrievalStatus } from '../types';
import { storeBypassReason, type BypassReason, type StoreTurnFacts } from './bypass';
import { hashedTenantKey } from './index';
import { resolveCachedSources, type ResolvedSource } from './sources';
import type { CacheTicket, SemanticCache } from './types';

/** Phase 5 scores within 20 s (RAG_GROUNDEDNESS_TIMEOUT_MS default) plus the record update; a label later than this is not waited for. */
export const CACHE_STORE_GROUNDEDNESS_WAIT_MS = 25_000;
const RESOLVE_TIMEOUT_MS = 2000;

/** What the entry point knows about the finished turn; the check-time facts come from the ticket. */
export interface CacheStoreFacts {
  chatId: string | null;
  sourceImages: boolean;
  retrievalStatus: RetrievalStatus;
  answerText: string;
  isRefusal: boolean;
  /** A tool result (webSearch, MCP) reached the answer although the turn was checked as tool-free. */
  toolsUsed?: boolean;
}

export interface CacheStoreSource {
  documentId: string;
  name: string;
  /** The version the context block carried; null when the assembly did not know it. */
  version: number | null;
}

export interface ScheduleCacheStoreInput {
  /** The request's scope; the ticket carries none. */
  scope: TenantScope | null;
  ticket: CacheTicket | undefined;
  /** The trace id of the turn that produced the answer; a later hit reports it. */
  traceId: string;
  facts: CacheStoreFacts;
  /** Full Phase 5 records of the answer (never the capped metadata copy). */
  citations?: CitationRecord[];
  sources?: CacheStoreSource[];
  /** Phase 5's post-stream groundedness of this answer; settles with null when no label was produced. */
  groundedness?: Promise<AnswerGroundedness | null> | null;
}

export interface CacheStoreDeps {
  cache: () => SemanticCache | null;
  schedule: (task: () => Promise<void>) => void;
  resolveSources: (scope: TenantScope, documentIds: readonly string[], signal: AbortSignal) => Promise<Map<string, ResolvedSource>>;
  readConfig: () => { groundedness: boolean; embedStore: boolean };
  now: () => Date;
}

const defaultDeps: CacheStoreDeps = {
  cache: () => getRagDeps().semanticCache(),
  schedule: scheduleAfterResponse,
  resolveSources: (scope, documentIds, signal) =>
    resolveCachedSources(scope, documentIds, { client: getRagDeps().adminClient() as unknown as RpcClient | null, signal }),
  readConfig: () => ({
    groundedness: readGenerationConfig().groundedness,
    embedStore: loadRagConfig(getRagDeps().ragEnv()).semanticCache.embedStore,
  }),
  now: () => new Date(),
};

class StoreSkipped extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'StoreSkipped';
  }
}

function notChecked(reason: string, now: Date): AnswerGroundedness {
  return {
    status: 'not_checked',
    label: 'not_checked',
    scorer: 'none',
    score: null,
    threshold: null,
    thresholdSource: null,
    reason,
    truncated: false,
    latencyMs: 0,
    checkedAt: now.toISOString(),
  };
}

/** Each document of the context once, in render order: the non-image blocks, else the kept chunks. */
export function cacheSourcesFromResult(result: Pick<RetrievalResult, 'kept'> & Partial<Pick<RetrievalResult, 'blocks'>>): CacheStoreSource[] {
  const seen = new Map<string, CacheStoreSource>();
  const blocks = (result.blocks ?? []).filter((block) => !block.isImage);
  if (blocks.length > 0) {
    for (const block of blocks) {
      const known = seen.get(block.documentId);
      if (!known) seen.set(block.documentId, { documentId: block.documentId, name: block.documentName, version: block.documentVersion });
      else if (known.version === null && block.documentVersion !== null) known.version = block.documentVersion;
    }
  } else {
    for (const chunk of result.kept ?? []) {
      if (!seen.has(chunk.document_id)) seen.set(chunk.document_id, { documentId: chunk.document_id, name: chunk.document_name, version: null });
    }
  }
  return [...seen.values()];
}

/** D-33/A-3: verified and not_checked are storable; possibly_unreliable, pending, a failure or no label within the wait is not. */
async function settledGroundedness(input: ScheduleCacheStoreInput, enabled: boolean, now: () => Date): Promise<AnswerGroundedness | null> {
  if (input.facts.isRefusal) return notChecked('refusal', now());
  if (!enabled) return notChecked('disabled', now());
  if (!input.groundedness) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CACHE_STORE_GROUNDEDNESS_WAIT_MS);
  });
  try {
    const value = await Promise.race([input.groundedness.catch(() => null), timeout]);
    if (!value) return null;
    if (value.status === 'scored' && value.label === 'verified') return value;
    if (value.status === 'not_checked') return value;
    return value.label === 'possibly_unreliable' ? value : null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function currentSources(
  scope: TenantScope,
  input: ScheduleCacheStoreInput,
  deps: CacheStoreDeps,
): Promise<{ sources: NonNullable<CachedAnswer['sources']>; versions: Map<string, number> }> {
  const listed = input.sources ?? [];
  const ids = [...new Set([...listed.map((source) => source.documentId), ...(input.citations ?? []).map((citation) => citation.documentId)])];
  if (ids.length === 0) return { sources: [], versions: new Map() };
  const resolved = await deps.resolveSources(scope, ids, AbortSignal.timeout(RESOLVE_TIMEOUT_MS));
  const versions = new Map<string, number>();
  for (const id of ids) {
    const current = resolved.get(id);
    if (!current) throw new StoreSkipped('sources_unresolved');
    const known = listed.find((source) => source.documentId === id)?.version ?? null;
    if (known !== null && known !== current.version) throw new StoreSkipped('sources_changed');
    versions.set(id, current.version);
  }
  const sources = listed.map((source) => ({ document_id: source.documentId, name: resolved.get(source.documentId)!.name, version: versions.get(source.documentId)! }));
  return { sources, versions };
}

function logFailure(scope: TenantScope, reason: string): void {
  console.warn('[Semantic Cache] store failed, dropped', { op: 'store', reason, tenant: hashedTenantKey(scope) });
}

function reasonOf(error: unknown): string {
  if (error instanceof StoreSkipped) return error.reason;
  if (error instanceof Error) return error.name.slice(0, 64);
  return 'unknown';
}

/** What one store attempt did: stored, a bypass reason, or why it never reached the backend. */
export type CacheStoreOutcome = 'stored' | BypassReason | 'groundedness_unsettled' | 'no_ticket' | 'no_backend' | 'not_eval' | 'failed';

async function runStore(
  scope: TenantScope,
  ticket: CacheTicket,
  cache: SemanticCache,
  input: ScheduleCacheStoreInput,
  deps: CacheStoreDeps,
): Promise<CacheStoreOutcome> {
  const config = deps.readConfig();
  const groundedness = await settledGroundedness(input, config.groundedness, deps.now);
  if (!groundedness) return 'groundedness_unsettled';

  const facts: StoreTurnFacts = {
    ...ticket.turn,
    mcpTools: ticket.turn.mcpTools || input.facts.toolsUsed === true,
    chatId: input.facts.chatId,
    sourceImages: input.facts.sourceImages,
    retrievalStatus: input.facts.retrievalStatus,
    groundednessLabel: groundedness.label ?? null,
    embedStore: config.embedStore,
    answerText: input.facts.answerText,
  };
  const bypass = storeBypassReason(facts);
  if (bypass !== null) return bypass;

  const { sources, versions } = input.facts.isRefusal ? { sources: [], versions: new Map<string, number>() } : await currentSources(scope, input, deps);
  const citations = input.facts.isRefusal
    ? []
    : (input.citations ?? []).map((citation) => ({ ...citation, documentVersion: citation.documentVersion ?? versions.get(citation.documentId) ?? null }));
  const parsed = CachedAnswerSchema.safeParse({
    answer_text: input.facts.answerText,
    citations,
    sources,
    source_versions: [...versions].map(([document_id, version]) => ({ document_id, version })),
    answer_language: ticket.key.answerLanguage,
    rag_mode: ticket.key.ragMode,
    is_refusal: input.facts.isRefusal,
    groundedness,
    trace_id: input.traceId,
    created_at: deps.now().toISOString(),
  } satisfies CachedAnswer);
  if (!parsed.success) throw new StoreSkipped('invalid_answer');

  await cache.store(
    {
      ...ticket.key,
      scope,
      standalone: ticket.standalone,
      vector: ticket.vector,
      embeddingProfileId: ticket.embeddingProfileId,
    },
    parsed.data,
  );
  return 'stored';
}

/**
 * D-32/D-33/A-3: schedules one after-response task that waits for the groundedness label, applies storeBypassReason and stores the
 * answer under the request's scope. Never throws; a failure is logged once with a hashed tenant key and dropped (D-36).
 */
export function scheduleCacheStore(input: ScheduleCacheStoreInput, overrides: Partial<CacheStoreDeps> = {}): void {
  try {
    const { scope, ticket } = input;
    if (!scope || !ticket) return;
    const deps: CacheStoreDeps = { ...defaultDeps, ...overrides };
    const cache = deps.cache();
    if (!cache) return;
    deps.schedule(async () => {
      try {
        await runStore(scope, ticket, cache, input, deps);
      } catch (error) {
        logFailure(scope, reasonOf(error));
      }
    });
  } catch {
    // scheduling never affects the response
  }
}

/**
 * D-37/D-38: the eval route's synchronous store. The same rules as scheduleCacheStore, awaited before the response, for eval
 * tickets only (the eval entry profile the pipeline derived from the request profile, never from caller data). Never throws.
 */
export async function storeCacheAnswerNow(input: ScheduleCacheStoreInput, overrides: Partial<CacheStoreDeps> = {}): Promise<CacheStoreOutcome> {
  const { scope, ticket } = input;
  if (!scope || !ticket) return 'no_ticket';
  if (ticket.key.entryProfile !== 'eval' || ticket.turn.profile !== 'eval') return 'not_eval';
  try {
    const deps: CacheStoreDeps = { ...defaultDeps, ...overrides };
    const cache = deps.cache();
    if (!cache) return 'no_backend';
    return await runStore(scope, ticket, cache, input, deps);
  } catch (error) {
    logFailure(scope, reasonOf(error));
    return 'failed';
  }
}
