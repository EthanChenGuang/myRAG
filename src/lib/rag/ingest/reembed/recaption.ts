import type { RpcClient } from '../../backend/supabase-rpc';
import { canonicalModelId, getEmbeddingProviderFor } from '../../embeddings/registry';
import { getLanguageSettings } from '../../lang/settings';
import { lexicalText } from '../../lexical/tokenize';
import { captionLanguageOf, resolveCaptionLanguage, type LanguageShare } from '../caption-language';
import { captionImage, type CaptionOptions } from '../captioner';
import { loadIngestConfig } from '../config';
import { getIngestDeps } from '../deps';
import { contentHash } from '../hash';
import { countTokens } from '../text/tokens';
import { isTenantKey } from '../writer';
import { estimateReembedCost, formatUsd } from './cost';
import { embeddingTextOf } from './run';

/** A request the recaption job cannot start from (switch, languages, arguments); nothing was changed. */
export class RecaptionInputError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`[Recaption] ${code}`);
    this.name = 'RecaptionInputError';
    this.code = code;
  }
}

/** A refused or failed recaption RPC: the function name, the code and the refusal words only. */
export class RecaptionWriterError extends Error {
  readonly rpc: string;
  readonly code: string | null;
  readonly reason: string | null;

  constructor(rpc: string, code: string | null, reason: string | null = null) {
    super(`[Recaption] ${rpc} failed${code ? ` (${code})` : ''}${reason ? `: ${reason}` : ''}`);
    this.name = 'RecaptionWriterError';
    this.rpc = rpc;
    this.code = code;
    this.reason = reason;
  }
}

export const LEGACY_PROFILE_ID = 'openai-3-small-1536';
export const DEFAULT_RECAPTION_BATCH_SIZE = 32;
const MAX_BATCH_SIZE = 1000;
const DEFAULT_ACTOR = 'recaption-cli';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
/**
 * Estimated vision cost per image: one image plus the instruction (about 1,000 input tokens) and a caption of about 250 output tokens on the
 * captioning model. The vendor bills its own count, so the dry run labels it an estimate.
 */
export const VISION_USD_PER_IMAGE_ESTIMATE = 0.005;

/** A profile that holds a vector of the chunk: the recaption writes a new vector for each of them, no more and no fewer. */
export interface RecaptionProfile {
  id: string;
  provider: string;
  model: string;
  dims: number;
  storage: string;
}

export interface RecaptionCandidate {
  id: string;
  documentId: string;
  tenantKey: string;
  content: string;
  /**
   * The caption's language as written, detected on its text: a caption written before RAG_CAPTION_LANGUAGE=document carries the document's
   * language in the chunk column whatever language the caption is in. Falls back to metadata.caption_language, then the column.
   */
  language: string | null;
  documentLanguage: string | null;
  pictureDocument: boolean;
  imageUrl: string;
  imageType: string | null;
  sectionPath: string[];
  docType: string | null;
  templateRow: Record<string, string | null>;
  profiles: RecaptionProfile[];
}

export interface RecaptionImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface RecaptionDeps {
  caption: (bytes: Uint8Array, mimeType: string, options: CaptionOptions) => Promise<string>;
  /** The stored picture of a chunk; null when the URL is not one this job may read or the image is gone. */
  fetchImage: (url: string, imageType: string | null, signal: AbortSignal) => Promise<RecaptionImage | null>;
  embed: (profile: RecaptionProfile, texts: string[], signal: AbortSignal) => Promise<number[][]>;
}

export interface RecaptionHooks {
  /** Runs after one chunk was rewritten (its vectors and the cursor committed with it). */
  afterWrite?: (info: { runId: string; chunkId: string; written: number }) => void | Promise<void>;
}

export interface RecaptionRunInput {
  db: RpcClient;
  tenantKey?: string | null;
  resumeRunId?: string | null;
  batchSize?: number;
  actor?: string;
  signal?: AbortSignal;
  deps?: Partial<RecaptionDeps>;
  hooks?: RecaptionHooks;
  onProgress?: (line: string) => void;
}

export interface RecaptionReport {
  runId: string;
  tenantKey: string | null;
  resumed: boolean;
  status: 'completed' | 'failed';
  /** Why a failed run stopped: the database refusal words. The run can be resumed. */
  reason: string | null;
  /** Image chunks looked at by this call. */
  examined: number;
  /** Of those, the chunks whose caption language differed from their target. */
  eligible: number;
  recaptioned: number;
  /** Eligible chunks left as they were, by reason (image_unavailable, caption_failed, caption_empty, embedding_failed). */
  skipped: Record<string, number>;
  tenants: Record<string, number>;
  /** Always 0: the job reads the stored picture, never a parser. */
  parserCalls: 0;
}

export interface RecaptionDryRunTenant {
  tenantKey: string;
  imageChunks: number;
  toRecaption: number;
}

export interface RecaptionDryRunReport {
  tenants: RecaptionDryRunTenant[];
  visionUsd: number;
  embeddingUsd: number;
  totalUsd: number;
  note: string;
}

type Row = Record<string, unknown>;

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function count(row: Row | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function refusalOf(message: string | undefined): string | null {
  const match = /^((?:recaption|rollback)_refused: [a-z_]+|tenant_mismatch|embedding_profile_mismatch)/.exec(message ?? '');
  return match?.[1] ?? null;
}

async function call(db: RpcClient, signal: AbortSignal, rpc: string, args: Record<string, unknown>): Promise<Row[]> {
  signal.throwIfAborted();
  const response = await db.rpc(rpc, args).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new RecaptionWriterError(rpc, response.error.code ?? null, refusalOf(response.error.message));
  return (response.data ?? []) as Row[];
}

function parseProfiles(value: unknown): RecaptionProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: RecaptionProfile[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Row;
    const id = text(row, 'id');
    const provider = text(row, 'provider');
    const model = text(row, 'model');
    const dims = count(row, 'dims');
    if (id && provider && model && dims > 0) profiles.push({ id, provider, model, dims, storage: text(row, 'storage') ?? '' });
  }
  return profiles;
}

function parseCandidate(row: Row): RecaptionCandidate | null {
  const id = text(row, 'id');
  const documentId = text(row, 'document_id');
  const tenantKey = text(row, 'tenant_key');
  const imageUrl = text(row, 'image_url');
  if (!id || !documentId || !tenantKey || !imageUrl) return null;
  const content = text(row, 'content') ?? '';
  const templateRow: Record<string, string | null> = {};
  if (typeof row.template_row === 'object' && row.template_row !== null && !Array.isArray(row.template_row)) {
    for (const [key, value] of Object.entries(row.template_row as Row)) templateRow[key] = typeof value === 'string' ? value : null;
  }
  return {
    id,
    documentId,
    tenantKey,
    content,
    language: captionLanguageOf(content) ?? text(row, 'caption_language') ?? text(row, 'language'),
    documentLanguage: text(row, 'document_language'),
    pictureDocument: row.picture_document === true,
    imageUrl,
    imageType: text(row, 'image_type'),
    sectionPath: Array.isArray(row.section_path) ? row.section_path.filter((entry): entry is string => typeof entry === 'string') : [],
    docType: text(row, 'doc_type'),
    templateRow,
    profiles: parseProfiles(row.profiles),
  };
}

async function candidatePage(db: RpcClient, signal: AbortSignal, tenantKey: string | null, after: string | null, limit: number): Promise<RecaptionCandidate[]> {
  const rows = await call(db, signal, 'rag_recaption_candidates', { p_tenant_key: tenantKey, p_after: after, p_limit: limit });
  return rows.map(parseCandidate).filter((candidate): candidate is RecaptionCandidate => candidate !== null);
}

function storedImageOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * The stored picture behind metadata.image_url, read only from the project's own public storage (same origin as NEXT_PUBLIC_SUPABASE_URL,
 * path under /storage/v1/object/public/), with no redirect, a timeout and a 10 MB cap. Any other URL is not fetched.
 */
async function fetchStoredImage(url: string, imageType: string | null, signal: AbortSignal): Promise<RecaptionImage | null> {
  const origin = storedImageOrigin();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (origin === null || parsed.origin !== origin || !parsed.pathname.startsWith('/storage/v1/object/public/')) return null;
  const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
  if (!response.ok) return null;
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  const header = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const mimeType = header.startsWith('image/') ? header : (imageType ?? '');
  return mimeType === '' ? null : { bytes, mimeType };
}

async function embedFor(profile: RecaptionProfile, texts: string[], signal: AbortSignal): Promise<number[][]> {
  if (profile.id === LEGACY_PROFILE_ID) return getIngestDeps().embedDocuments(texts, { signal });
  const provider = getEmbeddingProviderFor(profile.provider, profile.model);
  const output = await provider.embedDocuments(texts, { dims: profile.dims, signal });
  if (canonicalModelId(output.model) !== canonicalModelId(profile.model)) throw new Error('embedding_profile_mismatch');
  return output.vectors;
}

const DEFAULT_DEPS: RecaptionDeps = { caption: captionImage, fetchImage: fetchStoredImage, embed: embedFor };

function checkBatchSize(value: number | undefined): number {
  const size = value ?? DEFAULT_RECAPTION_BATCH_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) throw new RecaptionInputError('invalid_batch_size');
  return size;
}

function checkTenantKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isTenantKey(value)) throw new RecaptionInputError('invalid_tenant_key');
  return value;
}

/** D-24: the mode needs RAG_CAPTION_LANGUAGE=document and configured languages; otherwise there is no target to recaption into. */
function requireDocumentCaptions(): void {
  if (loadIngestConfig(getIngestDeps().ingestEnv()).captionLanguage !== 'document') throw new RecaptionInputError('caption_language_not_document');
  if (!getLanguageSettings().configured) throw new RecaptionInputError('languages_not_configured');
}

/** The target of each candidate, with the tenant shares read once per tenant (the same order as ingest: document, tenant share, primary). */
function targetResolver(db: RpcClient, signal: AbortSignal): (candidate: RecaptionCandidate) => Promise<string | null> {
  const shares = new Map<string, Promise<LanguageShare[]>>();
  const lookupShares = (tenantKey: string): Promise<LanguageShare[]> => {
    let pending = shares.get(tenantKey);
    if (!pending) {
      pending = call(db, signal, 'rag_tenant_language_shares', { p_tenant_key: tenantKey }).then((rows) =>
        rows.flatMap((row) => {
          const language = text(row, 'language');
          const share = typeof row.share === 'number' ? row.share : Number(row.share);
          return language !== null && Number.isFinite(share) ? [{ language, share }] : [];
        }),
      );
      shares.set(tenantKey, pending);
    }
    return pending;
  };
  return (candidate) =>
    resolveCaptionLanguage({ documentLanguage: candidate.pictureDocument ? null : candidate.documentLanguage, tenantKey: candidate.tenantKey, lookupShares });
}

function embeddingText(candidate: RecaptionCandidate, content: string): string {
  return embeddingTextOf(
    {
      id: candidate.id,
      documentId: candidate.documentId,
      tenantKey: candidate.tenantKey,
      content,
      sectionPath: candidate.sectionPath,
      chunkKind: 'image',
      docType: candidate.docType,
      templateRow: candidate.templateRow,
      hasGap: false,
    },
    new Set<string>(),
  );
}

/**
 * What a recaption would do, without writing: per tenant the current image chunks and those whose caption language differs from their
 * target, and the estimated cost (vision per image, plus embedding tokens of the current caption for every profile the chunk holds).
 */
export async function dryRunRecaption(input: Omit<RecaptionRunInput, 'resumeRunId' | 'hooks' | 'deps' | 'actor'>): Promise<RecaptionDryRunReport> {
  requireDocumentCaptions();
  const signal = input.signal ?? new AbortController().signal;
  const batchSize = checkBatchSize(input.batchSize);
  const tenantKey = checkTenantKey(input.tenantKey);
  const target = targetResolver(input.db, signal);
  const tenants = new Map<string, RecaptionDryRunTenant>();
  const tokensByProfile = new Map<string, { profile: RecaptionProfile; totals: Record<string, { chunks: number; tokens: number }> }>();
  let images = 0;
  let after: string | null = null;
  for (;;) {
    const page = await candidatePage(input.db, signal, tenantKey, after, batchSize);
    if (page.length === 0) break;
    for (const candidate of page) {
      const entry = tenants.get(candidate.tenantKey) ?? { tenantKey: candidate.tenantKey, imageChunks: 0, toRecaption: 0 };
      tenants.set(candidate.tenantKey, entry);
      entry.imageChunks += 1;
      const goal = await target(candidate);
      if (goal === null || goal === candidate.language) continue;
      entry.toRecaption += 1;
      images += 1;
      const tokens = countTokens(embeddingText(candidate, candidate.content));
      for (const profile of candidate.profiles) {
        const bucket = tokensByProfile.get(profile.id) ?? { profile, totals: {} };
        tokensByProfile.set(profile.id, bucket);
        const totals = (bucket.totals[candidate.tenantKey] ??= { chunks: 0, tokens: 0 });
        totals.chunks += 1;
        totals.tokens += tokens;
      }
    }
    after = (page[page.length - 1] as RecaptionCandidate).id;
  }
  let embeddingUsd = 0;
  for (const { profile, totals } of tokensByProfile.values()) {
    try {
      embeddingUsd += estimateReembedCost(profile.provider, totals, profile.model).totals.usd;
    } catch {
      // A provider with no price table adds nothing; the note says the total is an estimate.
    }
  }
  const visionUsd = images * VISION_USD_PER_IMAGE_ESTIMATE;
  return {
    tenants: [...tenants.values()].sort((a, b) => (a.tenantKey < b.tenantKey ? -1 : 1)),
    visionUsd,
    embeddingUsd,
    totalUsd: visionUsd + embeddingUsd,
    note: `Estimate: about ${formatUsd(VISION_USD_PER_IMAGE_ESTIMATE)} USD of vision per image; embedding tokens are counted on the current caption.`,
  };
}

interface RunRow {
  runId: string;
  tenantKey: string | null;
  cursorChunkId: string | null;
  status: string;
}

function parseRun(rpc: string, row: Row | undefined): RunRow {
  const runId = row ? text(row, 'run_id') : null;
  if (!row || !runId) throw new RecaptionWriterError(rpc, 'no_row');
  return { runId, tenantKey: text(row, 'tenant_key'), cursorChunkId: text(row, 'cursor_chunk_id'), status: text(row, 'status') ?? 'running' };
}

/**
 * D-24: regenerates the captions of current image chunks whose caption language differs from their target, from the stored picture
 * (metadata.image_url), with zero parser calls. Each chunk is one transaction: content, content_hash, lexical_text, language, metadata
 * (previous_caption kept) and a new vector for every profile the chunk holds, with the cursor. A killed run resumes from the cursor.
 */
export async function runRecaption(input: RecaptionRunInput): Promise<RecaptionReport> {
  requireDocumentCaptions();
  const signal = input.signal ?? new AbortController().signal;
  const batchSize = checkBatchSize(input.batchSize);
  const tenantKey = checkTenantKey(input.tenantKey);
  const actor = input.actor ?? DEFAULT_ACTOR;
  const deps: RecaptionDeps = { ...DEFAULT_DEPS, ...input.deps };
  const db = input.db;

  let run: RunRow;
  let resumed = false;
  if (input.resumeRunId) {
    const existing = (await call(db, signal, 'rag_recaption_get_run', { p_run_id: input.resumeRunId }))[0];
    if (!existing) throw new RecaptionInputError('run_not_found');
    if (tenantKey !== null && text(existing, 'tenant_key') !== tenantKey) throw new RecaptionInputError('resume_mismatch');
    run = parseRun('rag_recaption_resume_run', (await call(db, signal, 'rag_recaption_resume_run', { p_run_id: input.resumeRunId, p_actor: actor }))[0]);
    resumed = true;
  } else {
    run = parseRun('rag_recaption_start_run', (await call(db, signal, 'rag_recaption_start_run', { p_tenant_key: tenantKey, p_actor: actor }))[0]);
  }
  input.onProgress?.(`run ${run.runId} ${resumed ? 'resumed' : 'started'}: ${run.tenantKey ? `tenant ${run.tenantKey}` : 'all tenants'}`);

  const target = targetResolver(db, signal);
  const report: RecaptionReport = {
    runId: run.runId,
    tenantKey: run.tenantKey,
    resumed,
    status: 'completed',
    reason: null,
    examined: 0,
    eligible: 0,
    recaptioned: 0,
    skipped: {},
    tenants: {},
    parserCalls: 0,
  };
  const skip = (reason: string): void => {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
  };

  async function recaptionOne(candidate: RecaptionCandidate, goal: string): Promise<void> {
    let image: RecaptionImage | null;
    try {
      image = await deps.fetchImage(candidate.imageUrl, candidate.imageType, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      image = null;
    }
    if (image === null) return skip('image_unavailable');
    let caption: string;
    try {
      caption = (await deps.caption(image.bytes, image.mimeType, { signal, targetLanguage: goal })).trim();
    } catch (error) {
      if (signal.aborted) throw error;
      return skip('caption_failed');
    }
    if (caption === '') return skip('caption_empty');

    const embedText = embeddingText(candidate, caption);
    const vectors: Record<string, number[]> = {};
    for (const profile of candidate.profiles) {
      try {
        const [vector] = await deps.embed(profile, [embedText], signal);
        if (!vector || vector.length !== profile.dims || !vector.every((x) => Number.isFinite(x))) return skip('embedding_failed');
        vectors[profile.id] = vector;
      } catch (error) {
        if (signal.aborted) throw error;
        return skip('embedding_failed');
      }
    }
    await call(db, signal, 'rag_recaption_write_chunk', {
      p_run_id: run.runId,
      p_chunk_id: candidate.id,
      p_content: caption,
      p_content_hash: contentHash(caption),
      p_lexical_text: lexicalText(candidate.sectionPath, caption),
      p_language: captionLanguageOf(caption),
      p_vectors: vectors,
    });
    report.recaptioned += 1;
    report.tenants[candidate.tenantKey] = (report.tenants[candidate.tenantKey] ?? 0) + 1;
    await input.hooks?.afterWrite?.({ runId: run.runId, chunkId: candidate.id, written: report.recaptioned });
  }

  let after = run.cursorChunkId;
  try {
    for (;;) {
      const page = await candidatePage(db, signal, run.tenantKey, after, batchSize);
      if (page.length === 0) break;
      for (const candidate of page) {
        signal.throwIfAborted();
        report.examined += 1;
        const goal = await target(candidate);
        if (goal === null || goal === candidate.language) continue;
        report.eligible += 1;
        await recaptionOne(candidate, goal);
      }
      after = (page[page.length - 1] as RecaptionCandidate).id;
      await call(db, signal, 'rag_recaption_advance', { p_run_id: run.runId, p_cursor: after });
      input.onProgress?.(`progress: ${report.recaptioned} captions rewritten, ${report.examined} image chunks looked at`);
    }
  } catch (error) {
    if (signal.aborted || !(error instanceof RecaptionWriterError)) throw error;
    try {
      await call(db, signal, 'rag_recaption_finish_run', { p_run_id: run.runId, p_status: 'failed' });
    } catch {
      // A run that cannot be marked failed stays running, and a resume works on it either way.
    }
    return { ...report, status: 'failed', reason: error.reason ?? error.code ?? 'database_error' };
  }
  await call(db, signal, 'rag_recaption_finish_run', { p_run_id: run.runId, p_status: 'completed' });
  return report;
}

/** Puts back caption, lexical text, language, metadata and vectors of every chunk the run rewrote and no later run rewrote again. */
export async function rollbackRecaptionRun(input: { db: RpcClient; runId: string; actor?: string; signal?: AbortSignal }): Promise<{ chunksRestored: number; chunksSkipped: number }> {
  const signal = input.signal ?? new AbortController().signal;
  const row = (await call(input.db, signal, 'rag_recaption_rollback_run', { p_run_id: input.runId, p_actor: input.actor ?? DEFAULT_ACTOR }))[0];
  if (!row) throw new RecaptionWriterError('rag_recaption_rollback_run', 'no_row');
  return { chunksRestored: count(row, 'chunks_restored'), chunksSkipped: count(row, 'chunks_skipped') };
}
