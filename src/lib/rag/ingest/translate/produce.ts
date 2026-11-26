import { createHash } from 'node:crypto';
import type { RpcClient } from '../../backend/supabase-rpc';
import { LEGACY_PROFILE, getActiveProfile, isEmbeddingProfilesEnabled, type EmbeddingProfile } from '../../embeddings/active-profile';
import { priceFor } from '../../embeddings/prices';
import { getEmbeddingProviderFor } from '../../embeddings/registry';
import type { EmbeddingProviderId } from '../../embeddings/types';
import { getLanguageSettings } from '../../lang/settings';
import { registryOrder } from '../../lang/registry';
import { chunkLexicalText } from '../../lexical/chunk-text';
import { currentIngestConfig } from '../current-config';
import { getIngestDeps } from '../deps';
import type { PostPublishEvent } from '../post-publish';
import { queueConfigFromProcessEnv } from '../queue-config';
import { countTokens } from '../text/tokens';
import { isTenantKey } from '../writer';
import { glossaryFor, type Glossary } from './glossary';
import {
  TRANSLATION_INPUT_TOKEN_LIMIT,
  TranslationModelUnavailable,
  getChunkTranslationModel,
  translateChunk,
  type TranslationGapReason,
} from './translator';

/**
 * Producing retrieval-only chunk translations (XLG-04, D-28, D-29, D-31). Nothing is sent to the translation model unless the deployment
 * switch RAG_DOC_TRANSLATION is on, the deployment has more than one configured language, and the tenant's own translation setting is
 * enabled with at least one supported target: every entry point (the post-publish hook, the CLI, a queued job) goes through the same gate.
 * Eligible chunks come from the database (current text and table chunks of a current ready document, language known, not und, not the
 * target); a translation is stored with the sha256 of its source's UTF-8 bytes, so a changed source is pending again. Vectors are made for
 * the active global profile only. A run stops at its time or spend budget, or when the model cannot be reached, and reports how many
 * chunks remain; it never fails or delays ingestion. Logs carry ids and counts only.
 */

export type TranslationRefusal =
  | 'switch_off'
  | 'monolingual'
  | 'languages_not_configured'
  | 'tenant_disabled'
  | 'no_targets'
  | 'invalid_argument'
  | 'unavailable';

export type TranslationStop = 'time_budget' | 'usd_budget' | 'model_unavailable' | 'aborted' | 'write_failed';

export interface TranslationLanguageCounts {
  translated: number;
  gaps: number;
  remaining: number;
}

export interface TranslationRunSummary {
  ok: true;
  translated: number;
  gaps: number;
  reembedded: number;
  /** Chunks still pending for the targets of this run (for the document when the run was for one), after the run. */
  remaining: number;
  stopped: TranslationStop | null;
  byLanguage: Record<string, TranslationLanguageCounts>;
  /** Estimated spend of this run (model and embedding), USD rounded to 4 decimals. */
  estimatedUsd: number;
}

export type TranslationRunResult = TranslationRunSummary | { ok: false; reason: TranslationRefusal };

export interface TranslationRunOptions {
  /** Wall-clock budget; the run starts no new chunk once it is spent. */
  budgetMs?: number;
  /** Spend budget (CLI); the run starts no chunk whose estimate would exceed it. */
  budgetUsd?: number | null;
  /** Restricts the run to these targets (they must also be the tenant's targets). */
  languages?: readonly string[];
  signal?: AbortSignal;
  maxInputTokens?: number;
  pageSize?: number;
  /** Writes vectors of the active profile for up-to-date translations that lack one; never calls the translation model. */
  reembedOnly?: boolean;
}

export interface TranslationEstimateLanguage {
  language: string;
  chunks: number;
  tooLong: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export type TranslationEstimateResult =
  | { ok: true; languages: TranslationEstimateLanguage[]; chunks: number; estimatedUsd: number; model: string; profileId: string }
  | { ok: false; reason: TranslationRefusal };

/** List prices used for the estimate when the model's own are not known (USD per million tokens); the figure is an estimate. */
export const TRANSLATION_PRICE_USD_PER_MILLION = Object.freeze({ input: 0.1, output: 0.4 });
/** Instruction, language names and protected-token list sent with every chunk. */
export const TRANSLATION_PROMPT_OVERHEAD_TOKENS = 200;
export const DEFAULT_PAGE_SIZE = 16;
const MAX_PAGE_SIZE = 500;

type Row = Record<string, unknown>;

class StoreError extends Error {
  constructor(
    readonly fn: string,
    readonly code: string | null,
  ) {
    super(`[Translation] ${fn} failed`);
    this.name = 'TranslationStoreError';
  }
}

async function rpc(db: RpcClient, fn: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const response = await db.rpc(fn, args).abortSignal(signal);
  if (response.error) throw new StoreError(fn, response.error.code ?? null);
  return response.data;
}

function rowsOf(data: unknown): Row[] {
  return (Array.isArray(data) ? data : data ? [data] : []) as Row[];
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

export function sourceContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function roundUsd(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

// --- Gate -------------------------------------------------------------------------------------------------------------------------------

interface Gate {
  db: RpcClient;
  targets: string[];
}

/** D-29 and D-31: the deployment switch, more than one configured language, and the tenant's enabled setting with a supported target. */
async function gate(tenantKey: string, languages: readonly string[] | undefined, signal: AbortSignal): Promise<Gate | { reason: TranslationRefusal }> {
  if (!isTenantKey(tenantKey)) return { reason: 'invalid_argument' };
  let switchOn = false;
  try {
    switchOn = currentIngestConfig().docTranslation === 'on';
  } catch {
    switchOn = false;
  }
  if (!switchOn) return { reason: 'switch_off' };
  const settings = getLanguageSettings();
  if (!settings.configured || settings.languages.length === 0) return { reason: 'languages_not_configured' };
  if (settings.monolingual || settings.languages.length === 1) return { reason: 'monolingual' };
  const db = getIngestDeps().db();
  if (!db) return { reason: 'unavailable' };
  let row: Row | undefined;
  try {
    row = rowsOf(await rpc(db, 'rag_translation_settings_get', { p_tenant_key: tenantKey }, signal))[0];
  } catch (error) {
    console.error('[Translation] settings unavailable', { code: error instanceof StoreError ? error.code : null });
    return { reason: 'unavailable' };
  }
  if (!row || row.enabled !== true) return { reason: 'tenant_disabled' };
  const supported = new Set(settings.languages);
  const stored = Array.isArray(row.target_languages) ? row.target_languages.filter((code): code is string => typeof code === 'string') : [];
  const wanted = languages ? new Set(languages) : null;
  const targets = registryOrder(stored.filter((code) => supported.has(code) && (wanted === null || wanted.has(code))));
  if (targets.length === 0) return { reason: 'no_targets' };
  return { db, targets };
}

async function activeProfile(): Promise<EmbeddingProfile> {
  return isEmbeddingProfilesEnabled() ? getActiveProfile() : LEGACY_PROFILE;
}

async function embedTexts(profile: EmbeddingProfile, texts: string[], signal: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  const vectors =
    profile.storage === 'legacy_column'
      ? await getIngestDeps().embedDocuments(texts, { signal })
      : (await getEmbeddingProviderFor(profile.provider, profile.model).embedDocuments(texts, { dims: profile.dims, signal })).vectors;
  if (vectors.length !== texts.length || vectors.some((vector) => vector.length !== profile.dims)) throw new Error('embedding_profile_mismatch');
  return vectors;
}

// --- Cost -------------------------------------------------------------------------------------------------------------------------------

interface Tokens {
  input: number;
  output: number;
}

function embeddingRate(profile: EmbeddingProfile): number {
  try {
    return priceFor(profile.provider as EmbeddingProviderId, profile.model).usdPerMillionTokens;
  } catch {
    return 0;
  }
}

/** Integer token totals to dollars: model input and output at the list prices, the translated text embedded once. */
function usdOf(tokens: Tokens, embeddingUsdPerMillion: number): number {
  return (
    (tokens.input * TRANSLATION_PRICE_USD_PER_MILLION.input +
      tokens.output * TRANSLATION_PRICE_USD_PER_MILLION.output +
      tokens.output * embeddingUsdPerMillion) /
    1_000_000
  );
}

function chunkTokens(content: string): Tokens {
  const tokens = countTokens(content);
  return { input: tokens + TRANSLATION_PROMPT_OVERHEAD_TOKENS, output: tokens };
}

// --- Translation run --------------------------------------------------------------------------------------------------------------------

interface PendingChunk {
  chunkId: string;
  documentId: string;
  sourceLanguage: string;
  content: string;
  chunkKind: string;
}

function pendingOf(row: Row): PendingChunk | null {
  const chunkId = typeof row.chunk_id === 'string' ? row.chunk_id : null;
  const documentId = typeof row.document_id === 'string' ? row.document_id : null;
  const sourceLanguage = typeof row.language === 'string' ? row.language : null;
  const content = typeof row.content === 'string' ? row.content : null;
  if (!chunkId || !documentId || !sourceLanguage || content === null) return null;
  return { chunkId, documentId, sourceLanguage, content, chunkKind: typeof row.chunk_kind === 'string' ? row.chunk_kind : 'text' };
}

async function scanPending(
  db: RpcClient,
  tenantKey: string,
  language: string,
  documentId: string | null,
  after: string | null,
  limit: number,
  signal: AbortSignal,
): Promise<PendingChunk[]> {
  const data = await rpc(
    db,
    'rag_translation_pending_scan',
    { p_tenant_key: tenantKey, p_language: language, p_document_id: documentId, p_after: after, p_limit: limit },
    signal,
  );
  return rowsOf(data).map(pendingOf).filter((row): row is PendingChunk => row !== null);
}

async function pendingCount(db: RpcClient, tenantKey: string, language: string, documentId: string | null, signal: AbortSignal): Promise<number> {
  const data = await rpc(db, 'rag_translation_pending_count', { p_tenant_key: tenantKey, p_language: language, p_document_id: documentId }, signal);
  return count(Array.isArray(data) ? (data[0] as Row | undefined)?.rag_translation_pending_count ?? data[0] : data);
}

interface Translated {
  chunk: PendingChunk;
  language: string;
  content: string;
  glossaryVersion: string;
}

interface Gap {
  chunk: PendingChunk;
  language: string;
  reason: TranslationGapReason;
}

function pageSizeOf(options: TranslationRunOptions): number {
  const size = options.pageSize ?? DEFAULT_PAGE_SIZE;
  return Number.isInteger(size) && size > 0 ? Math.min(size, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

async function flush(
  db: RpcClient,
  tenantKey: string,
  profile: EmbeddingProfile,
  modelId: string,
  translated: Translated[],
  gaps: Gap[],
  signal: AbortSignal,
): Promise<void> {
  if (translated.length > 0) {
    const vectors = await embedTexts(
      profile,
      translated.map((item) => item.content),
      signal,
    );
    const rows = translated.map((item, index) => ({
      chunk_id: item.chunk.chunkId,
      language: item.language,
      content: item.content,
      lexical_text: chunkLexicalText({ sectionPath: [], content: item.content, chunkKind: item.chunk.chunkKind }),
      source_content_hash: sourceContentHash(item.chunk.content),
      model: modelId,
      glossary_version: item.glossaryVersion,
      profile_id: profile.id,
      embedding: vectors[index],
      embedding_model: profile.model,
    }));
    await rpc(db, 'rag_write_chunk_translations', { p_tenant_key: tenantKey, p_rows: rows }, signal);
  }
  if (gaps.length > 0) {
    const rows = gaps.map((gap) => ({
      chunk_id: gap.chunk.chunkId,
      language: gap.language,
      source_content_hash: sourceContentHash(gap.chunk.content),
      reason: gap.reason,
      model: modelId,
    }));
    await rpc(db, 'rag_record_translation_gaps', { p_tenant_key: tenantKey, p_rows: rows }, signal);
  }
}

async function runTranslations(tenantKey: string, documentId: string | null, options: TranslationRunOptions): Promise<TranslationRunResult> {
  const signal = options.signal ?? new AbortController().signal;
  const gated = await gate(tenantKey, options.languages, signal);
  if ('reason' in gated) return { ok: false, reason: gated.reason };
  const { db, targets } = gated;
  let profile: EmbeddingProfile;
  try {
    profile = await activeProfile();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (options.reembedOnly) return reembed(db, tenantKey, profile, options, signal);

  const now = () => getIngestDeps().now();
  const deadline = options.budgetMs !== undefined && Number.isFinite(options.budgetMs) ? now() + Math.max(0, options.budgetMs) : Infinity;
  const budgetUsd = options.budgetUsd ?? null;
  const embeddingUsd = embeddingRate(profile);
  const pageSize = pageSizeOf(options);
  const model = getChunkTranslationModel();
  const byLanguage: Record<string, TranslationLanguageCounts> = {};
  const spent: Tokens = { input: 0, output: 0 };
  let stopped: TranslationStop | null = null;
  let translatedTotal = 0;
  let gapTotal = 0;

  for (const language of targets) {
    const counts: TranslationLanguageCounts = { translated: 0, gaps: 0, remaining: 0 };
    byLanguage[language] = counts;
    if (stopped) continue;
    const glossaries = new Map<string, Glossary>();
    let after: string | null = null;
    for (;;) {
      let page: PendingChunk[];
      try {
        page = await scanPending(db, tenantKey, language, documentId, after, pageSize, signal);
      } catch (error) {
        stopped = signal.aborted ? 'aborted' : 'write_failed';
        if (!signal.aborted) console.error('[Translation] pending scan failed', { documentId, code: error instanceof StoreError ? error.code : null });
        break;
      }
      if (page.length === 0) break;
      const translated: Translated[] = [];
      const gaps: Gap[] = [];
      for (const chunk of page) {
        if (signal.aborted) stopped = 'aborted';
        else if (now() >= deadline) stopped = 'time_budget';
        else if (budgetUsd !== null) {
          const cost = chunkTokens(chunk.content);
          if (usdOf({ input: spent.input + cost.input, output: spent.output + cost.output }, embeddingUsd) > budgetUsd) stopped = 'usd_budget';
        }
        if (stopped) break;
        after = chunk.chunkId;
        let glossary = glossaries.get(chunk.sourceLanguage);
        if (!glossary) {
          glossary = await glossaryFor({ tenantKey }, chunk.sourceLanguage, language);
          glossaries.set(chunk.sourceLanguage, glossary);
        }
        try {
          const outcome = await translateChunk(chunk.content, {
            sourceLanguage: chunk.sourceLanguage,
            targetLanguage: language,
            model,
            signal,
            glossary,
            maxInputTokens: options.maxInputTokens ?? TRANSLATION_INPUT_TOKEN_LIMIT,
          });
          if (outcome.attempts > 0) {
            const cost = chunkTokens(chunk.content);
            spent.input += cost.input * outcome.attempts;
            spent.output += cost.output * outcome.attempts;
          }
          if (outcome.ok) translated.push({ chunk, language, content: outcome.content, glossaryVersion: glossary.version });
          else gaps.push({ chunk, language, reason: outcome.reason });
        } catch (error) {
          stopped = signal.aborted ? 'aborted' : 'model_unavailable';
          console.warn('[Translation] model unavailable, run stopped', {
            documentId: chunk.documentId,
            kind: error instanceof TranslationModelUnavailable ? error.kind : 'error',
          });
          break;
        }
      }
      try {
        await flush(db, tenantKey, profile, model.model, translated, gaps, signal);
        counts.translated += translated.length;
        counts.gaps += gaps.length;
      } catch (error) {
        stopped = signal.aborted ? 'aborted' : 'write_failed';
        console.error('[Translation] write failed', { documentId, error: error instanceof StoreError ? error.fn : error instanceof Error ? error.message.slice(0, 60) : 'unknown' });
      }
      if (stopped || page.length < pageSize) break;
    }
    translatedTotal += counts.translated;
    gapTotal += counts.gaps;
  }

  let remaining = 0;
  const countSignal = signal.aborted ? new AbortController().signal : signal;
  for (const language of targets) {
    try {
      byLanguage[language]!.remaining = await pendingCount(db, tenantKey, language, documentId, countSignal);
    } catch {
      byLanguage[language]!.remaining = 0;
    }
    remaining += byLanguage[language]!.remaining;
  }
  const summary: TranslationRunSummary = {
    ok: true,
    translated: translatedTotal,
    gaps: gapTotal,
    reembedded: 0,
    remaining,
    stopped,
    byLanguage,
    estimatedUsd: roundUsd(usdOf(spent, embeddingUsd)),
  };
  console.log('[Translation] run finished', { documentId, translated: translatedTotal, gaps: gapTotal, remaining, stopped });
  return summary;
}

async function reembed(db: RpcClient, tenantKey: string, profile: EmbeddingProfile, options: TranslationRunOptions, signal: AbortSignal): Promise<TranslationRunResult> {
  const pageSize = pageSizeOf(options);
  const embeddingUsd = embeddingRate(profile);
  const now = () => getIngestDeps().now();
  const deadline = options.budgetMs !== undefined && Number.isFinite(options.budgetMs) ? now() + Math.max(0, options.budgetMs) : Infinity;
  const budgetUsd = options.budgetUsd ?? null;
  let tokens = 0;
  let reembedded = 0;
  let stopped: TranslationStop | null = null;
  let after: string | null = null;
  for (;;) {
    if (signal.aborted) stopped = 'aborted';
    else if (now() >= deadline) stopped = 'time_budget';
    if (stopped) break;
    let page: Row[];
    try {
      page = rowsOf(
        await rpc(db, 'rag_translation_vectors_missing', { p_tenant_key: tenantKey, p_profile_id: profile.id, p_after: after, p_limit: pageSize }, signal),
      );
    } catch {
      stopped = signal.aborted ? 'aborted' : 'write_failed';
      break;
    }
    if (page.length === 0) break;
    const batch: Row[] = [];
    for (const row of page) {
      const content = typeof row.content === 'string' ? row.content : '';
      const next = tokens + countTokens(content);
      if (budgetUsd !== null && (next * embeddingUsd) / 1_000_000 > budgetUsd) {
        stopped = 'usd_budget';
        break;
      }
      tokens = next;
      after = String(row.translation_id);
      batch.push(row);
    }
    if (batch.length > 0) {
      try {
        const vectors = await embedTexts(
          profile,
          batch.map((row) => String(row.content)),
          signal,
        );
        const rows = batch.map((row, index) => ({
          chunk_id: row.chunk_id,
          language: row.language,
          content: row.content,
          lexical_text: row.lexical_text ?? '',
          source_content_hash: row.source_content_hash,
          model: row.model,
          glossary_version: row.glossary_version ?? null,
          profile_id: profile.id,
          embedding: vectors[index],
          embedding_model: profile.model,
        }));
        await rpc(db, 'rag_write_chunk_translations', { p_tenant_key: tenantKey, p_rows: rows }, signal);
        reembedded += rows.length;
      } catch (error) {
        stopped = signal.aborted ? 'aborted' : 'write_failed';
        console.error('[Translation] re-embed write failed', { error: error instanceof StoreError ? error.fn : 'embed' });
      }
    }
    if (stopped || page.length < pageSize) break;
  }
  let remaining = 0;
  if (stopped) {
    try {
      remaining = rowsOf(
        await rpc(db, 'rag_translation_vectors_missing', { p_tenant_key: tenantKey, p_profile_id: profile.id, p_after: null, p_limit: 1000 }, new AbortController().signal),
      ).length;
    } catch {
      remaining = 0;
    }
  }
  console.log('[Translation] re-embed finished', { profileId: profile.id, reembedded, remaining, stopped });
  return { ok: true, translated: 0, gaps: 0, reembedded, remaining, stopped, byLanguage: {}, estimatedUsd: roundUsd((tokens * embeddingUsd) / 1_000_000) };
}

/** The current chunks of one published document version, into the tenant's targets (the post-publish hook and the queued job). */
export async function translateDocumentChunks(documentId: string, tenantKey: string, options: TranslationRunOptions = {}): Promise<TranslationRunResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) return { ok: false, reason: 'invalid_argument' };
  return runTranslations(tenantKey, documentId, { ...options, reembedOnly: false });
}

/** Every pending chunk of the tenant (the CLI), or with reembedOnly the vectors the active profile lacks. */
export async function translatePending(tenantKey: string, options: TranslationRunOptions = {}): Promise<TranslationRunResult> {
  return runTranslations(tenantKey, null, options);
}

/** The dry run: pending chunks per target and an estimated cost from integer token counts. Writes nothing and calls no model. */
export async function estimateTranslation(tenantKey: string, options: Pick<TranslationRunOptions, 'languages' | 'signal' | 'maxInputTokens'> = {}): Promise<TranslationEstimateResult> {
  const signal = options.signal ?? new AbortController().signal;
  const gated = await gate(tenantKey, options.languages, signal);
  if ('reason' in gated) return { ok: false, reason: gated.reason };
  let profile: EmbeddingProfile;
  try {
    profile = await activeProfile();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const embeddingUsd = embeddingRate(profile);
  const limit = options.maxInputTokens ?? TRANSLATION_INPUT_TOKEN_LIMIT;
  const languages: TranslationEstimateLanguage[] = [];
  const total: Tokens = { input: 0, output: 0 };
  try {
    for (const language of gated.targets) {
      const entry: TranslationEstimateLanguage = { language, chunks: 0, tooLong: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
      let after: string | null = null;
      for (;;) {
        const page = await scanPending(gated.db, tenantKey, language, null, after, MAX_PAGE_SIZE, signal);
        for (const chunk of page) {
          after = chunk.chunkId;
          entry.chunks += 1;
          if (countTokens(chunk.content) > limit) {
            entry.tooLong += 1;
            continue;
          }
          const tokens = chunkTokens(chunk.content);
          entry.inputTokens += tokens.input;
          entry.outputTokens += tokens.output;
        }
        if (page.length < MAX_PAGE_SIZE) break;
      }
      entry.estimatedUsd = roundUsd(usdOf({ input: entry.inputTokens, output: entry.outputTokens }, embeddingUsd));
      total.input += entry.inputTokens;
      total.output += entry.outputTokens;
      languages.push(entry);
    }
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  return {
    ok: true,
    languages,
    chunks: languages.reduce((sum, entry) => sum + entry.chunks, 0),
    estimatedUsd: roundUsd(usdOf(total, embeddingUsd)),
    model: getChunkTranslationModel().model,
    profileId: profile.id,
  };
}

// --- Post-publish hook ------------------------------------------------------------------------------------------------------------------

export const TRANSLATION_HOOK = 'translation';
/** The inline run's share of a publish; the rest is left for npm run rag:translate (or a queued job). */
export const INLINE_TRANSLATION_BUDGET_MS = 15_000;
const HOOK_MARGIN_MS = 10_000;

/** Translation after publish at all: the deployment switch is on and more than one language is configured. */
export function translationAfterPublishOn(): boolean {
  try {
    if (currentIngestConfig().docTranslation !== 'on') return false;
    const settings = getLanguageSettings();
    return settings.configured && !settings.monolingual && settings.languages.length >= 2;
  } catch {
    return false;
  }
}

/** Inline translation after publish: switch on, more than one language, and asynchronous ingestion off (on, it is a queued job). */
export function inlineTranslationOn(): boolean {
  try {
    return translationAfterPublishOn() && !queueConfigFromProcessEnv().ingestAsync;
  } catch {
    return false;
  }
}

/** The tenant's targets under the same gate as every run (switch, languages, tenant setting); used to enqueue one job per target. */
export async function translationTargets(tenantKey: string, signal: AbortSignal): Promise<{ ok: true; targets: string[] } | { ok: false; reason: TranslationRefusal }> {
  const gated = await gate(tenantKey, undefined, signal);
  if ('reason' in gated) return { ok: false, reason: gated.reason };
  return { ok: true, targets: gated.targets };
}

type Register = (name: string, run: (event: PostPublishEvent, signal: AbortSignal) => Promise<void>, options: { timeoutMs: number }) => void;

export function registerTranslationHook(register: Register): void {
  register(
    TRANSLATION_HOOK,
    async (event, signal) => {
      await translateDocumentChunks(event.documentId, event.tenantKey, { budgetMs: INLINE_TRANSLATION_BUDGET_MS, signal });
    },
    { timeoutMs: INLINE_TRANSLATION_BUDGET_MS + HOOK_MARGIN_MS },
  );
}
