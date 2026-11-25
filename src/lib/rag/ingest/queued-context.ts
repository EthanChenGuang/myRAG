import { z } from 'zod/v3';
import type { IngestionJob } from '@/lib/rag-eval/contracts.generated';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import { loadArtifact, versionPrefix, type ArtifactContext } from './artifacts';
import { loadIngestConfig, type IngestCheckMode, type IngestConfig } from './config';
import { getIngestDeps } from './deps';
import { ORIGINALS_BUCKET, getObjectStore } from './object-store';
import { getProcessingProfile, profileFor, type DocType } from './profiles/load';
import type { StateStore } from './state-store';
import { ingestStateFromRecord } from './status';
import {
  INGEST_SOURCES,
  type DocTypeOrigin,
  type IngestInput,
  type IngestOptions,
  type IngestSource,
  type IngestState,
  type StageContext,
  type TypeChangeState,
} from './types';
import { createIngestWriter } from './writer';

/** Written by enqueue next to the original: what the callbacks need of the upload and of the identify outcome, with no bytes. */
export const QUEUED_INPUT_ARTIFACT = 'queued-input.json';

const RecordSchema = z.object({
  v: z.literal(1),
  source: z.enum(INGEST_SOURCES),
  sourceKey: z.string().min(1),
  filename: z.string(),
  mimeType: z.string(),
  kind: z.enum(['file', 'text']),
  docType: z.string().optional(),
  options: z.record(z.unknown()).optional(),
  typeChange: z.record(z.unknown()).optional(),
  state: z.record(z.unknown()),
});

export interface QueuedInputRecord {
  v: 1;
  source: IngestSource;
  sourceKey: string;
  filename: string;
  mimeType: string;
  kind: 'file' | 'text';
  docType?: string;
  options?: IngestOptions;
  typeChange?: TypeChangeState;
  /** The state slices identify and the earlier stages produced; the ledger's stage_state is laid over it. */
  state: Record<string, unknown>;
}

export function encodeQueuedInput(record: QueuedInputRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

export function decodeQueuedInput(bytes: Uint8Array): QueuedInputRecord | null {
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(new TextDecoder('utf-8').decode(bytes)));
    return parsed.success ? (parsed.data as unknown as QueuedInputRecord) : null;
  } catch {
    return null;
  }
}

export type QueuedContextFailure =
  | 'db_unavailable'
  | 'document_missing'
  | 'document_not_found'
  | 'document_not_processing'
  | 'lineage_missing'
  | 'queued_input_missing'
  | 'original_unavailable';

export interface BuildQueuedContextInput {
  job: IngestionJob;
  /** Minted from the job row by scopeFromIngestionJob; never from a request body. */
  scope: TenantScope;
  signal: AbortSignal;
  /** Budget in milliseconds from now. */
  deadlineMs: number;
  /** Load the stored original into the context (parse needs it, the post-parse stages do not). */
  withOriginal: boolean;
  store: StateStore;
}

export type BuildQueuedContextResult = { ok: true; ctx: StageContext; record: QueuedInputRecord } | { ok: false; reason: QueuedContextFailure };

function profileOf(source: IngestSource, docType: string, warnings: string[]): { docType: DocType; profile: ReturnType<typeof profileFor> } {
  try {
    return { docType: docType as DocType, profile: profileFor(source, docType as DocType) };
  } catch {
    warnings.push('doc_type_invalid');
    return { docType: 'general', profile: getProcessingProfile('general') };
  }
}

const CHECK_RANK: Readonly<Record<IngestCheckMode, number>> = { off: 0, flag: 1, quarantine: 2 };

/**
 * The hidden-text mode of a queued job: the stricter of the current variable and the job's snapshot (D-33). The worker checked the
 * original under the snapshot's mode, so a later relaxation of RAG_HIDDEN_TEXT_CHECK does not let the job skip it; a snapshot without
 * the field (off) changes nothing.
 */
export function withSnapshotChecks(config: IngestConfig, job: Pick<IngestionJob, 'settings'>): IngestConfig {
  const snapshot = job.settings.hidden_text_check ?? 'off';
  return CHECK_RANK[snapshot] > CHECK_RANK[config.hiddenTextCheck] ? { ...config, hiddenTextCheck: snapshot } : config;
}

/**
 * The stage context of a queued job, rebuilt from the job row, the tenant-scoped document row, the stored original and the
 * queued-input record. Every read goes through the writer of the scope that was minted from the job, so another tenant's document
 * id is a miss (document_not_found), and the original must lie under the job tenant's own prefix.
 */
export async function buildQueuedContext(input: BuildQueuedContextInput): Promise<BuildQueuedContextResult> {
  const { job, scope, signal } = input;
  assertTenantScope(scope);
  const deps = getIngestDeps();
  const db = deps.db();
  if (!db) return { ok: false, reason: 'db_unavailable' };
  const documentId = job.document_id;
  if (!documentId) return { ok: false, reason: 'document_missing' };

  const writer = createIngestWriter({ db, scope, signal });
  const row = await writer.getDocument(documentId);
  if (!row) return { ok: false, reason: 'document_not_found' };
  if (row.status !== 'processing') return { ok: false, reason: 'document_not_processing' };
  const origin = await writer.getOrigin(documentId);
  if (!origin?.lineageId) return { ok: false, reason: 'lineage_missing' };

  const tenantKey = scopeKey(scope).toLowerCase();
  const artifactCtx: ArtifactContext = {
    identity: { tenantKey },
    document: { lineageId: origin.lineageId, version: row.version },
    signal,
    state: { artifacts: {} },
  };
  const stored = await loadArtifact(artifactCtx, QUEUED_INPUT_ARTIFACT);
  const record = stored ? decodeQueuedInput(stored.bytes) : null;
  if (!record) return { ok: false, reason: 'queued_input_missing' };

  let bytes: Uint8Array | null = null;
  if (input.withOriginal) {
    const ref = job.original_ref;
    const prefix = versionPrefix(tenantKey, origin.lineageId, row.version);
    // A backfill job keeps its staged original_ref; begin stored the version's own copy, which the document row records (D-31).
    const path =
      ref && ref.bucket === ORIGINALS_BUCKET && ref.path.startsWith(prefix)
        ? ref.path
        : origin.originalPath && origin.originalPath.startsWith(prefix)
          ? origin.originalPath
          : null;
    if (!path) return { ok: false, reason: 'original_unavailable' };
    const original = await getObjectStore().get(path, { signal });
    if (!original) return { ok: false, reason: 'original_unavailable' };
    bytes = original.bytes;
  }

  const state: IngestState = ingestStateFromRecord({ ...record.state, typeChange: record.typeChange, ...job.stage_state });
  state.artifacts = { ...state.artifacts, [QUEUED_INPUT_ARTIFACT]: `${versionPrefix(tenantKey, origin.lineageId, row.version)}${QUEUED_INPUT_ARTIFACT}` };
  const warnings: string[] = [];
  const { docType, profile } = profileOf(record.source, row.docType, warnings);
  const base = {
    scope,
    source: record.source,
    sourceKey: record.sourceKey,
    filename: record.filename,
    mimeType: record.mimeType,
    ...(record.docType ? { docType: record.docType as DocType | 'auto' } : {}),
    ...(record.options !== undefined ? { options: record.options } : {}),
    ...(state.typeChange ? { typeChange: state.typeChange } : {}),
    signal,
  };
  const ingestInput: IngestInput =
    record.kind === 'text'
      ? { ...base, text: bytes ? new TextDecoder('utf-8').decode(bytes) : '' }
      : { ...base, file: bytes ?? new Uint8Array(0) };

  const docTypeOrigin: DocTypeOrigin = state.docTypeOrigin ?? 'fallback';
  const ctx: StageContext = {
    input: ingestInput,
    deps,
    writer,
    config: withSnapshotChecks(loadIngestConfig(deps.ingestEnv()), job),
    signal,
    deadline: deps.now() + input.deadlineMs,
    state,
    store: input.store,
    warnings,
    identity: {
      tenantKey,
      filename: row.filename,
      fileSha256: job.file_sha256 ?? '',
      docType,
      docTypeOrigin,
      profile,
      bytes,
    },
    document: { id: documentId, version: row.version, lineageId: origin.lineageId, originalPath: origin.originalPath, resumed: true },
    parserUsed: row.parserUsed,
    work: { parseText: null, parserVersion: null, chunks: [], chunksWritten: 0 },
  };
  return { ok: true, ctx, record };
}
