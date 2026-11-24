import { isEmbeddingProfilesEnabled, ProfileUnavailableError } from '../../embeddings/active-profile';
import { EmbeddingProfileMismatch } from '../../embeddings/mrl';
import { canonicalModelId, getEmbeddingProvider } from '../../embeddings/registry';
import type { RpcClient } from '../../backend/supabase-rpc';
import { backfillScope } from '../../tenant/backfill-scope';
import type { TenantScope } from '../../tenant/scope';
import { PARSE_ARTIFACT, loadArtifact, type ArtifactContext } from '../artifacts';
import { getIngestDeps } from '../deps';
import { resolveEmbeddingTargets, type EmbeddingTarget } from '../embedding-targets';
import { ObjectStoreError } from '../object-store';
import { buildProfileChunks, writeProfileChunks, type BuiltProfileChunks, type ChunkingProfileRow } from '../profile-chunks';
import { getProcessingProfile, profileFor, type DocType } from '../profiles/load';
import { templateHeaderFor } from '../text/embedding-text';
import { countTokens } from '../text/tokens';
import { INGEST_SOURCES, type IngestSource } from '../types';
import { IngestWriterError, createIngestWriter, isTenantKey, type IngestWriter, type ProfileVectors } from '../writer';
import { estimateRechunkCost, type RechunkCostReport } from './cost';

/** A request the job cannot start from (bad arguments, a profile it must not build, a run that does not match); nothing was changed. */
export class RechunkInputError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`[RAG Rechunk] ${code}`);
    this.name = 'RechunkInputError';
    this.code = code;
  }
}

/** A failed rechunk RPC that was not a refusal. Carries the function name and the error code only, never the database message. */
export class RechunkDatabaseError extends Error {
  readonly rpc: string;
  readonly code: string | null;

  constructor(rpc: string, code: string | null) {
    super(`[RAG Rechunk] ${rpc} failed${code ? ` (${code})` : ''}`);
    this.name = 'RechunkDatabaseError';
    this.rpc = rpc;
    this.code = code;
  }
}

export interface RechunkDocumentInfo {
  runId: string;
  documentId: string;
  tenantKey: string;
  /** 1-based number of the document within this call. */
  position: number;
  outcome: 'written' | 'gap';
}

export interface RechunkHooks {
  /** Runs after a document was written (or recorded as a gap) and the cursor committed with it. */
  afterDocument?: (info: RechunkDocumentInfo) => void | Promise<void>;
}

export interface RunRechunkInput {
  db: RpcClient;
  profileId?: string | null;
  /** Only needed when the same profile id exists for more than one document type. */
  docType?: string | null;
  tenantKey?: string | null;
  resumeRunId?: string | null;
  /** Documents read per page; default 20. */
  batchSize?: number;
  /** Stop after this many documents; the run stays open and the next call continues it. */
  maxDocuments?: number;
  /** Time budget of this call in milliseconds; the call stops at a document boundary when it runs out, after at least one document. */
  deadlineMs?: number;
  signal?: AbortSignal;
  hooks?: RechunkHooks;
  onProgress?: (line: string) => void;
  /** The tenant scope the writer of one document uses; null refuses the document. Default: the operator backfill scope resolver. */
  scopeFor?: (tenantKey: string, signal: AbortSignal) => Promise<TenantScope | null>;
}

export type RechunkRunStatus = 'running' | 'completed' | 'incomplete' | 'failed';

export interface RechunkGap {
  documentId: string;
  tenantKey: string;
  reason: string;
  detail: string | null;
}

export interface RechunkReport {
  runId: string;
  profileId: string;
  docType: string;
  tenantKey: string | null;
  /** running: a bounded call ended with documents left; completed: every document in scope has children; incomplete: some do not (see gaps). */
  status: RechunkRunStatus;
  /** Why a failed run stopped: embed_failed, embedding_profile_mismatch, embedding_profile_unavailable, profile_write_failed or object_store_unavailable. */
  reason: string | null;
  profileStatus: string;
  resumed: boolean;
  documentsWritten: number;
  documentsGapped: number;
  parentsWritten: number;
  childrenWritten: number;
  docsDone: number;
  docsTotal: number;
  /** True while the run is still open: call again to continue. */
  more: boolean;
  cursor: string | null;
  tenants: Record<string, { documents: number; children: number; tokens: number }>;
  gaps: RechunkGap[];
  warnings: string[];
}

export interface DryRunRechunkInput {
  db: RpcClient;
  profileId: string;
  docType?: string | null;
  tenantKey?: string | null;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface DryRunRechunkTenant {
  tenantKey: string;
  /** Current ready documents without children in the profile that have stored parse output: what a run would build. */
  eligibleDocuments: number;
  /** Current ready documents a run could not build (no stored parse output), listed for a budgeted re-ingest. */
  gapDocuments: number;
  parents: number;
  children: number;
  /** cl100k_base tokens of the embedding text of the children. */
  tokens: number;
}

export interface DryRunRechunkReport {
  profileId: string;
  docType: string;
  profileStatus: string;
  childTokens: number;
  parentMode: string;
  tenants: DryRunRechunkTenant[];
  gaps: RechunkGap[];
  /** The embedding profiles a run would embed for (active, backfilling and the previous active one) and what that costs. */
  embeddingProfiles: string[];
  cost: RechunkCostReport;
}

type Row = Record<string, unknown>;

export const DEFAULT_BATCH_SIZE = 20;
export const MAX_BATCH_SIZE = 1000;
/** Room kept for one document (parse read, embedding, write) before a time-limited call starts another. */
const MIN_DOCUMENT_MS = 5000;
const EMBED_GROUP = 100;
const PROGRESS_EVERY_DOCUMENTS = 10;
const REFUSAL = /^rechunk_refused: ([a-z_]+)/;
const PARENT_MODES = new Set(['none', 'structure', 'fixed']);

/** A reason the whole run stops for; the run is marked failed and can be resumed. */
class RunFailure extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`[RAG Rechunk] run failure (${reason})`);
    this.name = 'RunFailure';
    this.reason = reason;
  }
}

/** A target that could not be embedded; mismatch means the provider answered with the wrong model or dimensions. */
class TargetFailure extends Error {
  readonly reason: 'embed_failed' | 'embedding_profile_mismatch';

  constructor(reason: 'embed_failed' | 'embedding_profile_mismatch') {
    super(`[RAG Rechunk] embedding target failed (${reason})`);
    this.name = 'TargetFailure';
    this.reason = reason;
  }
}

function checkBatchSize(value: number | undefined): number {
  const size = value ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) throw new RechunkInputError('invalid_batch_size');
  return size;
}

function checkTenantKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isTenantKey(value)) throw new RechunkInputError('invalid_tenant_key');
  return value;
}

/** True when no value was asked for or the asked-for value is the actual one. */
function agrees(requested: string | null | undefined, actual: string | null): boolean {
  return !requested || requested === actual;
}

function checkLimit(value: number | undefined, code: string): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1) throw new RechunkInputError(code);
  return value;
}

async function callRpc(db: RpcClient, signal: AbortSignal, rpc: string, args: Record<string, unknown>): Promise<Row[]> {
  signal.throwIfAborted();
  const response = await db.rpc(rpc, args).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) {
    const refusal = REFUSAL.exec(response.error.message ?? '')?.[1];
    if (refusal) throw new RechunkInputError(refusal);
    throw new RechunkDatabaseError(rpc, response.error.code ?? null);
  }
  return (response.data ?? []) as Row[];
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function count(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function requireText(rpc: string, row: Row, key: string): string {
  const value = text(row, key);
  if (value === null) throw new RechunkDatabaseError(rpc, 'bad_response');
  return value;
}

interface RunRow {
  runId: string;
  profileId: string;
  docType: string;
  tenantKey: string | null;
  cursor: string | null;
  docsTotal: number;
  docsDone: number;
  status: string;
  profile: ChunkingProfileRow;
}

function parseRun(rpc: string, row: Row): RunRow {
  const parentMode = text(row, 'parent_mode');
  const profileStatus = text(row, 'profile_status');
  if (parentMode === null || !PARENT_MODES.has(parentMode)) throw new RechunkDatabaseError(rpc, 'bad_response');
  if (profileStatus !== 'building' && profileStatus !== 'ready' && profileStatus !== 'active' && profileStatus !== 'retired') throw new RechunkDatabaseError(rpc, 'bad_response');
  const profileId = requireText(rpc, row, 'profile_id');
  const docType = requireText(rpc, row, 'doc_type');
  const parentTokens = row.parent_tokens;
  return {
    runId: requireText(rpc, row, 'run_id'),
    profileId,
    docType,
    tenantKey: text(row, 'tenant_key'),
    cursor: text(row, 'cursor_document_id'),
    docsTotal: count(row, 'docs_total'),
    docsDone: count(row, 'docs_done'),
    status: text(row, 'status') ?? 'running',
    profile: {
      id: profileId,
      docType,
      childTokens: count(row, 'child_tokens'),
      parentMode: parentMode as ChunkingProfileRow['parentMode'],
      parentTokens: typeof parentTokens === 'number' ? parentTokens : null,
      status: profileStatus,
    },
  };
}

interface RechunkDocument {
  id: string;
  tenantKey: string;
  lineageId: string | null;
  version: number;
  filename: string;
  docType: string;
  source: string | null;
  templateRow: Record<string, string | null>;
}

function parseDocument(row: Row): RechunkDocument {
  const templateRow: Record<string, string | null> = {};
  if (typeof row.template_row === 'object' && row.template_row !== null && !Array.isArray(row.template_row)) {
    for (const [key, value] of Object.entries(row.template_row as Row)) templateRow[key] = typeof value === 'string' ? value : null;
  }
  return {
    id: requireText('rag_rechunk_documents', row, 'document_id'),
    tenantKey: requireText('rag_rechunk_documents', row, 'tenant_key'),
    lineageId: text(row, 'lineage_id'),
    version: count(row, 'version'),
    filename: text(row, 'filename') ?? '',
    docType: requireText('rag_rechunk_documents', row, 'doc_type'),
    source: text(row, 'source'),
    templateRow,
  };
}

async function listDocuments(db: RpcClient, signal: AbortSignal, profile: ChunkingProfileRow, tenantKey: string | null, after: string | null, limit: number): Promise<RechunkDocument[]> {
  const rows = await callRpc(db, signal, 'rag_rechunk_documents', {
    p_profile_id: profile.id,
    p_doc_type: profile.docType,
    p_tenant_key: tenantKey,
    p_after: after,
    p_limit: limit,
  });
  return rows.map(parseDocument);
}

async function listGaps(db: RpcClient, signal: AbortSignal, runId: string): Promise<RechunkGap[]> {
  const rows = await callRpc(db, signal, 'rag_rechunk_gaps', { p_run_id: runId });
  return rows.map((row) => ({
    documentId: requireText('rag_rechunk_gaps', row, 'document_id'),
    tenantKey: requireText('rag_rechunk_gaps', row, 'tenant_key'),
    reason: requireText('rag_rechunk_gaps', row, 'reason'),
    detail: text(row, 'detail'),
  }));
}

type Prepared = { kind: 'ready'; built: BuiltProfileChunks; tokens: number } | { kind: 'gap'; reason: 'no_parse_output' | 'failed'; detail: string };

/** The stored parse output of the document's version, or null when it was never stored (written before Phase 3) or its key is not valid. */
async function loadParseText(doc: RechunkDocument, signal: AbortSignal): Promise<string | null> {
  if (doc.lineageId === null || !Number.isInteger(doc.version) || doc.version < 1) return null;
  const context: ArtifactContext = {
    identity: { tenantKey: doc.tenantKey },
    document: { lineageId: doc.lineageId, version: doc.version },
    signal,
    state: { artifacts: {} },
  };
  let stored;
  try {
    stored = await loadArtifact(context, PARSE_ARTIFACT);
  } catch (error) {
    if (signal.aborted) throw error;
    // A key the store refuses (a prefix that is not valid) means there is no stored output; any other store failure stops the run.
    if (error instanceof ObjectStoreError && error.op !== 'key') throw new RunFailure('object_store_unavailable');
    return null;
  }
  return stored === null ? null : new TextDecoder().decode(stored.bytes);
}

function processingProfileOf(doc: RechunkDocument) {
  const source = (INGEST_SOURCES as readonly string[]).includes(doc.source ?? '') ? (doc.source as IngestSource) : null;
  return source === null ? getProcessingProfile(doc.docType as DocType) : profileFor(source, doc.docType as DocType);
}

/**
 * Cuts the document's stored parse output into the parents and children of the profile. Pure apart from the object-store read: the parser is
 * never called (D-21). A document with no stored parse output, an unknown type or nothing to index becomes a gap.
 */
async function prepare(doc: RechunkDocument, profile: ChunkingProfileRow, signal: AbortSignal, warnings: Set<string>): Promise<Prepared> {
  const markdown = await loadParseText(doc, signal);
  if (markdown === null) return { kind: 'gap', reason: 'no_parse_output', detail: 'no_parse_output' };
  if (markdown.trim() === '') return { kind: 'gap', reason: 'failed', detail: 'empty_parse_output' };

  let processing;
  try {
    processing = processingProfileOf(doc);
  } catch {
    return { kind: 'gap', reason: 'failed', detail: 'unknown_doc_type' };
  }
  let built: BuiltProfileChunks;
  try {
    const templateHeader = templateHeaderFor(processing.embedding_text_template, doc.templateRow);
    built = buildProfileChunks({ filename: doc.filename, chunker: processing.chunker, templateHeader }, markdown, profile);
  } catch (error) {
    if (signal.aborted) throw error;
    return { kind: 'gap', reason: 'failed', detail: 'chunking_failed' };
  }
  for (const warning of built.warnings) warnings.add(warning);
  if (built.children.length === 0) return { kind: 'gap', reason: 'failed', detail: 'no_children' };
  return { kind: 'ready', built, tokens: built.embeddingTexts.reduce((sum, embeddingText) => sum + countTokens(embeddingText), 0) };
}

function assertProviderFits(target: EmbeddingTarget): void {
  const { profile } = target;
  let provider;
  try {
    provider = getEmbeddingProvider(profile.provider);
  } catch {
    throw new TargetFailure('embed_failed');
  }
  if (canonicalModelId(provider.model) !== canonicalModelId(profile.model) || !provider.supportedDims.includes(profile.dims)) {
    throw new TargetFailure('embedding_profile_mismatch');
  }
}

function assertShape(target: EmbeddingTarget, vectors: number[][], expected: number): void {
  if (vectors.length !== expected || vectors.some((vector) => vector.length !== target.profile.dims)) throw new TargetFailure('embedding_profile_mismatch');
}

/** Embeds the texts of one document for one target, in groups so a request never carries a whole long document. Embedding goes through the registered providers only. */
async function embedForTarget(target: EmbeddingTarget, texts: string[], signal: AbortSignal): Promise<{ vectors: number[][]; host: string | null }> {
  const { profile } = target;
  const vectors: number[][] = [];
  let host: string | null = null;
  try {
    if (profile.storage !== 'legacy_column' || isEmbeddingProfilesEnabled()) assertProviderFits(target);
    for (let start = 0; start < texts.length; start += EMBED_GROUP) {
      signal.throwIfAborted();
      const group = texts.slice(start, start + EMBED_GROUP);
      if (profile.storage === 'legacy_column') {
        const part = await getIngestDeps().embedDocuments(group, { signal });
        assertShape(target, part, group.length);
        vectors.push(...part);
      } else {
        const output = await getEmbeddingProvider(profile.provider).embedDocuments(group, { dims: profile.dims, signal });
        if (canonicalModelId(output.model) !== canonicalModelId(profile.model)) throw new TargetFailure('embedding_profile_mismatch');
        assertShape(target, output.vectors, group.length);
        vectors.push(...output.vectors);
        host ??= output.host;
      }
    }
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof TargetFailure) throw error;
    throw new TargetFailure(error instanceof EmbeddingProfileMismatch ? 'embedding_profile_mismatch' : 'embed_failed');
  }
  return { vectors, host };
}

async function defaultScopeFor(tenantKey: string, signal: AbortSignal): Promise<TenantScope | null> {
  const result = await backfillScope(tenantKey, { signal });
  return result.ok ? result.scope : null;
}

interface Session {
  db: RpcClient;
  signal: AbortSignal;
  profile: ChunkingProfileRow;
  scopeFor: NonNullable<RunRechunkInput['scopeFor']>;
  warnings: Set<string>;
  writers: Map<string, IngestWriter | null>;
  targets: Map<string, EmbeddingTarget[]>;
}

async function writerFor(session: Session, tenantKey: string): Promise<IngestWriter | null> {
  if (session.writers.has(tenantKey)) return session.writers.get(tenantKey) ?? null;
  const scope = await session.scopeFor(tenantKey, session.signal);
  const writer = scope ? createIngestWriter({ db: session.db, scope, signal: session.signal }) : null;
  session.writers.set(tenantKey, writer);
  return writer;
}

async function targetsFor(session: Session, tenantKey: string, writer: IngestWriter): Promise<EmbeddingTarget[]> {
  const known = session.targets.get(tenantKey);
  if (known) return known;
  try {
    const targets = await resolveEmbeddingTargets(writer);
    session.targets.set(tenantKey, targets);
    return targets;
  } catch (error) {
    if (session.signal.aborted) throw error;
    if (error instanceof ProfileUnavailableError) throw new RunFailure('embedding_profile_unavailable');
    throw error;
  }
}

type Outcome =
  | { kind: 'written'; parents: number; children: number; tokens: number }
  | { kind: 'gap'; reason: 'no_parse_output' | 'failed'; detail: string };

/**
 * Builds one document's profile from its stored parse output, embeds the children for the active, backfilling and previous embedding profiles
 * and writes them under the document's own tenant scope in one transaction. A failing active target stops the run; a failing other target
 * leaves its vectors out. A refusal by the writer (a tenant that does not match, a document that is no longer writable) leaves the document as a gap.
 */
async function buildDocument(session: Session, doc: RechunkDocument): Promise<Outcome> {
  const prepared = await prepare(doc, session.profile, session.signal, session.warnings);
  if (prepared.kind === 'gap') return prepared;

  const writer = await writerFor(session, doc.tenantKey);
  if (!writer) return { kind: 'gap', reason: 'failed', detail: 'tenant_scope_refused' };
  const targets = await targetsFor(session, doc.tenantKey, writer);
  const { built } = prepared;

  const outcomes = await Promise.all(
    targets.map(async (target) => {
      try {
        return { target, failure: null, result: await embedForTarget(target, built.embeddingTexts, session.signal) };
      } catch (error) {
        if (!(error instanceof TargetFailure)) throw error;
        return { target, failure: error, result: null };
      }
    }),
  );
  session.signal.throwIfAborted();

  const embeddings: Record<string, ProfileVectors> = {};
  for (const { target, failure, result } of outcomes) {
    if (failure || !result) {
      if (target.role === 'active') throw new RunFailure(failure?.reason ?? 'embed_failed');
      session.warnings.add(`embedding_gap:${target.profile.id}`);
      continue;
    }
    embeddings[target.profile.id] = target.profile.storage === 'legacy_column' ? result.vectors : { vectors: result.vectors, host: result.host };
  }

  try {
    await writeProfileChunks(writer, doc.id, session.profile.id, built, embeddings);
  } catch (error) {
    if (session.signal.aborted) throw error;
    if (error instanceof IngestWriterError && error.reason !== null) return { kind: 'gap', reason: 'failed', detail: error.reason };
    throw new RunFailure('profile_write_failed');
  }
  return { kind: 'written', parents: built.parents.length, children: built.children.length, tokens: prepared.tokens };
}

async function startRun(input: RunRechunkInput, signal: AbortSignal, tenantKey: string | null, resumeOpen: boolean): Promise<{ run: RunRow; resumed: boolean }> {
  if (input.resumeRunId) {
    const existing = (await callRpc(input.db, signal, 'rag_rechunk_get_run', { p_run_id: input.resumeRunId }))[0];
    if (!existing) throw new RechunkInputError('run_not_found');
    const current = parseRun('rag_rechunk_get_run', existing);
    const sameTenant = tenantKey === null || tenantKey === current.tenantKey;
    if (!agrees(input.profileId, current.profileId) || !agrees(input.docType, current.docType) || !sameTenant) throw new RechunkInputError('resume_mismatch');
    const resumed = await callRpc(input.db, signal, 'rag_rechunk_resume_run', { p_run_id: input.resumeRunId });
    return { run: parseRun('rag_rechunk_resume_run', resumed[0] ?? {}), resumed: true };
  }
  if (!input.profileId) throw new RechunkInputError('profile_required');
  const started = await callRpc(input.db, signal, 'rag_rechunk_start_run', {
    p_profile_id: input.profileId,
    p_doc_type: input.docType ?? null,
    p_tenant_key: tenantKey,
    p_resume_open: resumeOpen,
  });
  const run = parseRun('rag_rechunk_start_run', started[0] ?? {});
  return { run, resumed: run.docsDone > 0 || run.cursor !== null };
}

async function execute(input: RunRechunkInput, resumeOpen: boolean): Promise<RechunkReport> {
  const signal = input.signal ?? new AbortController().signal;
  const batchSize = checkBatchSize(input.batchSize);
  const tenantKey = checkTenantKey(input.tenantKey);
  const maxDocuments = checkLimit(input.maxDocuments, 'invalid_max_documents');
  const deadlineMs = checkLimit(input.deadlineMs, 'invalid_deadline');
  const hooks = input.hooks ?? {};
  const now = getIngestDeps().now;
  const startedAt = now();

  const { run, resumed } = await startRun(input, signal, tenantKey, resumeOpen);
  const session: Session = {
    db: input.db,
    signal,
    profile: run.profile,
    scopeFor: input.scopeFor ?? defaultScopeFor,
    warnings: new Set(),
    writers: new Map(),
    targets: new Map(),
  };
  const tenants: RechunkReport['tenants'] = {};
  let written = 0;
  let gapped = 0;
  let parents = 0;
  let children = 0;
  let docsDone = run.docsDone;
  let cursor = run.cursor;
  let processed = 0;
  input.onProgress?.(
    `run ${run.runId} ${resumed ? 'resumed' : 'started'}: profile ${run.profileId} (${run.profile.status}), ${run.docType}, ${run.tenantKey ? `tenant ${run.tenantKey}` : 'all tenants'}, ${run.docsTotal} documents to build`,
  );

  const stopNow = (): boolean => {
    if (maxDocuments !== null && processed >= maxDocuments) return true;
    return deadlineMs !== null && processed >= 1 && now() + MIN_DOCUMENT_MS > startedAt + deadlineMs;
  };

  function report(status: RechunkRunStatus, reason: string | null, profileStatus: string, gaps: RechunkGap[]): RechunkReport {
    return {
      runId: run.runId,
      profileId: run.profileId,
      docType: run.docType,
      tenantKey: run.tenantKey,
      status,
      reason,
      profileStatus,
      resumed,
      documentsWritten: written,
      documentsGapped: gapped,
      parentsWritten: parents,
      childrenWritten: children,
      docsDone,
      docsTotal: run.docsTotal,
      more: status === 'running',
      cursor,
      tenants,
      gaps,
      warnings: [...session.warnings].sort(),
    };
  }

  async function markFailed(reason: string): Promise<RechunkReport> {
    let profileStatus = run.profile.status as string;
    try {
      const done = (await callRpc(input.db, signal, 'rag_rechunk_finish_run', { p_run_id: run.runId, p_status: 'failed' }))[0];
      profileStatus = (done ? text(done, 'profile_status') : null) ?? profileStatus;
    } catch {
      // A run that cannot be marked failed stays running, and a resume works on it either way.
    }
    console.warn('[RAG Rechunk] run failed', { profile: run.profileId, reason, documentsWritten: written, documentsGapped: gapped });
    return report('failed', reason, profileStatus, await listGaps(input.db, signal, run.runId).catch(() => []));
  }

  let exhausted = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      if (stopNow()) break;
      const limit = maxDocuments === null ? batchSize : Math.min(batchSize, maxDocuments - processed);
      const page = await listDocuments(input.db, signal, run.profile, run.tenantKey, cursor, limit);
      if (page.length === 0) {
        exhausted = true;
        break;
      }
      for (const doc of page) {
        signal.throwIfAborted();
        const outcome = await buildDocument(session, doc);
        if (outcome.kind === 'gap') {
          await callRpc(input.db, signal, 'rag_rechunk_record_gap', { p_run_id: run.runId, p_document_id: doc.id, p_reason: outcome.reason, p_detail: outcome.detail });
          gapped += 1;
        } else {
          written += 1;
          parents += outcome.parents;
          children += outcome.children;
          const entry = (tenants[doc.tenantKey] ??= { documents: 0, children: 0, tokens: 0 });
          entry.documents += 1;
          entry.children += outcome.children;
          entry.tokens += outcome.tokens;
        }
        const advanced = (await callRpc(input.db, signal, 'rag_rechunk_advance', { p_run_id: run.runId, p_document_id: doc.id }))[0] ?? {};
        docsDone = count(advanced, 'docs_done');
        cursor = doc.id;
        processed += 1;
        if (processed % PROGRESS_EVERY_DOCUMENTS === 0) input.onProgress?.(`progress: ${written} documents built, ${gapped} gaps`);
        await hooks.afterDocument?.({ runId: run.runId, documentId: doc.id, tenantKey: doc.tenantKey, position: processed, outcome: outcome.kind === 'gap' ? 'gap' : 'written' });
        if (stopNow()) break;
      }
    }
    if (!exhausted) exhausted = (await listDocuments(input.db, signal, run.profile, run.tenantKey, cursor, 1)).length === 0;
  } catch (error) {
    if (error instanceof RunFailure) return markFailed(error.reason);
    throw error;
  }

  if (!exhausted) {
    const open = (await callRpc(input.db, signal, 'rag_rechunk_get_run', { p_run_id: run.runId }))[0];
    const profileStatus = (open ? text(open, 'profile_status') : null) ?? run.profile.status;
    input.onProgress?.(`paused: ${written} documents built, ${gapped} gaps; call again to continue`);
    return report('running', null, profileStatus, await listGaps(input.db, signal, run.runId));
  }

  const finished = (await callRpc(input.db, signal, 'rag_rechunk_finish_run', { p_run_id: run.runId, p_status: 'completed' }))[0] ?? {};
  const status = text(finished, 'status') === 'completed' ? 'completed' : 'incomplete';
  const gaps = await listGaps(input.db, signal, run.runId);
  console.log('[RAG Rechunk] run finished', {
    profile: run.profileId,
    status,
    documentsWritten: written,
    documentsGapped: gapped,
    childrenWritten: children,
    missingInScope: count(finished, 'docs_missing'),
    missingTotal: count(finished, 'docs_missing_total'),
  });
  return report(status, null, text(finished, 'profile_status') ?? run.profile.status, gaps);
}

/**
 * Builds a chunking profile side by side for the current ready documents of its doc type from stored parse output (D-21, CHK-04). A keyset
 * pass by document id loads parse.md through the artifact store, cuts it with the profile's parent-child chunker, embeds the children for the
 * active and backfilling embedding profiles and writes parents, children and vectors of one document in one transaction under that document's
 * tenant. The cursor moves after every document, so a run killed at any point resumes (resumeRunId) and a document is never written twice.
 * Documents without stored parse output are never mixed in: each becomes a row of chunking_build_gaps and the profile stays building. A profile
 * that is already active or ready is repaired in place: only documents that lack children are processed and its status never changes. There is no
 * parser, sidecar or LlamaParse call on this path.
 */
export function runRechunk(input: RunRechunkInput): Promise<RechunkReport> {
  return execute(input, false);
}

/**
 * One bounded slice of a build for callers with a time limit (an admin route inside its function limit): continues the open run of the profile
 * and tenant scope (or starts one), processes at most maxDocuments documents or until deadlineMs is spent, and reports whether to call again.
 */
export function runRechunkBatch(input: RunRechunkInput): Promise<RechunkReport> {
  return execute(input, true);
}

async function resolveProfile(db: RpcClient, signal: AbortSignal, profileId: string, docType: string | null): Promise<ChunkingProfileRow> {
  if (profileId === 'legacy') throw new RechunkInputError('profile_is_legacy');
  const rows = await callRpc(db, signal, 'rag_list_chunking_profiles', {});
  const matches = rows.filter((row) => text(row, 'id') === profileId && agrees(docType, text(row, 'doc_type')));
  if (matches.length === 0) throw new RechunkInputError('unknown_profile');
  if (matches.length > 1) throw new RechunkInputError('profile_ambiguous');
  const row = matches[0] as Row;
  const parentMode = text(row, 'parent_mode');
  const status = text(row, 'status');
  if (status === 'retired') throw new RechunkInputError('profile_retired');
  if (parentMode === null || !PARENT_MODES.has(parentMode) || (status !== 'building' && status !== 'ready' && status !== 'active')) {
    throw new RechunkDatabaseError('rag_list_chunking_profiles', 'bad_response');
  }
  return {
    id: profileId,
    docType: requireText('rag_list_chunking_profiles', row, 'doc_type'),
    childTokens: count(row, 'child_tokens'),
    parentMode: parentMode as ChunkingProfileRow['parentMode'],
    parentTokens: typeof row.parent_tokens === 'number' ? row.parent_tokens : null,
    status,
  };
}

/**
 * What a run would do, per tenant, without writing anything and without opening a run: the documents it would build (with parents, children
 * and cl100k_base tokens counted from the stored parse output, the only thing read besides the registry), the documents it could not build
 * (no stored parse output) for a budgeted re-ingest, and what embedding the children would cost with the Phase 3 price table.
 */
export async function dryRunRechunk(input: DryRunRechunkInput): Promise<DryRunRechunkReport> {
  const signal = input.signal ?? new AbortController().signal;
  const batchSize = checkBatchSize(input.batchSize);
  const tenantKey = checkTenantKey(input.tenantKey);
  const profile = await resolveProfile(input.db, signal, input.profileId, input.docType ?? null);

  let targets: EmbeddingTarget[];
  try {
    targets = await resolveEmbeddingTargets({ findBackfillRuns: async () => [] });
  } catch (error) {
    if (error instanceof ProfileUnavailableError) throw new RechunkInputError('embedding_profile_unavailable');
    throw error;
  }

  const warnings = new Set<string>();
  const tenants = new Map<string, DryRunRechunkTenant>();
  const gaps: RechunkGap[] = [];
  const entryOf = (key: string): DryRunRechunkTenant => {
    const found = tenants.get(key);
    if (found) return found;
    const created = { tenantKey: key, eligibleDocuments: 0, gapDocuments: 0, parents: 0, children: 0, tokens: 0 };
    tenants.set(key, created);
    return created;
  };

  let after: string | null = null;
  try {
    for (;;) {
      signal.throwIfAborted();
      const page = await listDocuments(input.db, signal, profile, tenantKey, after, batchSize);
      if (page.length === 0) break;
      for (const doc of page) {
        const prepared = await prepare(doc, profile, signal, warnings);
        const entry = entryOf(doc.tenantKey);
        if (prepared.kind === 'gap') {
          entry.gapDocuments += 1;
          gaps.push({ documentId: doc.id, tenantKey: doc.tenantKey, reason: prepared.reason, detail: prepared.detail });
        } else {
          entry.eligibleDocuments += 1;
          entry.parents += prepared.built.parents.length;
          entry.children += prepared.built.children.length;
          entry.tokens += prepared.tokens;
        }
        after = doc.id;
      }
    }
  } catch (error) {
    if (error instanceof RunFailure) throw new RechunkInputError(error.reason);
    throw error;
  }

  const rows = [...tenants.values()].sort((a, b) => (a.tenantKey < b.tenantKey ? -1 : a.tenantKey > b.tenantKey ? 1 : 0));
  const totals: Record<string, { chunks: number; tokens: number }> = {};
  for (const row of rows) totals[row.tenantKey] = { chunks: row.children, tokens: row.tokens };
  const cost = estimateRechunkCost(
    targets.map((target) => ({ profileId: target.profile.id, provider: target.profile.provider })),
    totals,
  );
  return {
    profileId: profile.id,
    docType: profile.docType,
    profileStatus: profile.status,
    childTokens: profile.childTokens,
    parentMode: profile.parentMode,
    tenants: rows,
    gaps,
    embeddingProfiles: targets.map((target) => target.profile.id),
    cost,
  };
}
