import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadCorpus } from './corpus.mts';
import { startFakeEdge, type FakeEdge } from './fake-edge.mts';
import { createEmptyFixtureDatabase, type DeploymentMode, type FixtureDatabase } from './pglite-supabase.mts';
import { applyFixtureProcessEnv } from './process-env.mts';

const MANIFEST_PATH = path.join('eval/fixtures/ingest/manifest.json');

interface ManifestFixture {
  id: string;
  doc_type: string;
  mime: string;
  path: string;
  file_sha256: string;
  expected?: { injection?: { expected_status?: string } };
}

export type IngestRouting = 'fixed' | 'tiered';
export type ForcedTier = 'fast' | 'structured' | 'premium';
export interface IngestRoutingOptions {
  routing: IngestRouting;
  forceTier?: ForcedTier;
}

export interface ParseFixtureDocument {
  id: string;
  class: string;
  language: string;
  filename: string;
  path: string;
  sha256: string;
  pageCount: number;
  typedTwin: boolean;
}

export function ingestModeParseFixtures(): ParseFixtureDocument[] {
  return [];
}

export function parseIngestRoutingFlags(_values: { routing?: string; 'force-tier'?: string }): IngestRoutingOptions | undefined {
  return undefined;
}

/** Repo-relative golden files the ingest mode scores; ingest-only items are added here. */
export function ingestModeGoldenPaths(): string[] {
  return ['eval/fixtures/golden.jsonl', 'eval/fixtures/ingest/golden-ingest.jsonl'];
}

/**
 * Retrieval-time env for ingest-mode fixture eval. The ingest builder turns exact-id lookup on; the recorded ingest baseline
 * assumes retrieval still runs it. Pinned smoke env sets it off, and live process.env must override frozen `@/lib/env` for
 * v2 harness overlays, so this is applied again when the eval route is prepared.
 */
export function ingestModeRetrievalEnv(): Record<string, string> {
  return { RAG_EXACT_ID_LOOKUP: 'true' };
}

/** One golden file to score: a single path is returned as it is, several are concatenated in order into `outPath`. */
export function mergeGoldenFiles(paths: string[], outPath: string): string {
  const [first, ...rest] = paths;
  if (first === undefined) throw new Error('[Ingest Mode] no golden file to merge');
  if (rest.length === 0) return first;
  const lines = paths.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== ''));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`);
  return outPath;
}

/**
 * The corpus hash of an ingest-mode run. The chunks differ from the prechunked ones, so a run must not be gated against the
 * prechunked baseline: the gate compares this value and refuses the pair.
 */
function ingestCorpusSha256(corpusSha256: string): string {
  return crypto.createHash('sha256').update('fixture-mode:ingest').update(Buffer.from([0])).update(corpusSha256).digest('hex');
}

function loadTypedManifest(): ManifestFixture[] {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { fixtures: ManifestFixture[] };
  return manifest.fixtures;
}

/**
 * The fixture database filled by the real ingest(): every corpus document, with the chunk markers and the fixture-meta line already
 * removed by the corpus loader, goes through the stages as a picked-general config upload of the fixture tenant. Typed fixtures from
 * eval/fixtures/ingest/manifest.json follow, each with its picked doc_type. The fake edge it ingests through stays up and is handed to
 * the caller together with the database; the app environment points at it.
 */
export interface IngestFixtureBuildState {
  fixture: FixtureDatabase;
  edge: FakeEdge;
  scope: import('@/lib/rag/tenant/scope').TenantScope;
}

export async function buildIngestFixtureDatabase(options: {
  deploymentMode: DeploymentMode;
  corpusDir: string;
  processEnv?: Record<string, string>;
  supabaseGrants?: boolean;
  migrations?: boolean;
  setupSqlPath?: string;
  /** When set, only these corpus documents are ingested (half-open range). */
  corpusRange?: { start: number; end: number };
  includeTypedFixtures?: boolean;
  continueFrom?: IngestFixtureBuildState;
  onAfterCorpusSlice?: (state: IngestFixtureBuildState) => Promise<void>;
  /** Ingest corpus documents [0, index) first, run the callback, then ingest [index, end) and typed fixtures. */
  splitAtCorpusIndex?: number;
  typedFixtureIds?: string[];
  parseFixtureIds?: string[];
  routing?: IngestRoutingOptions;
}): Promise<FixtureDatabase & { buildState: IngestFixtureBuildState }> {
  const { deploymentMode } = options;
  const includeTyped = options.includeTypedFixtures ?? true;
  const corpus = loadCorpus(options.corpusDir);
  const corpusStart = options.corpusRange?.start ?? 0;
  const corpusEnd = options.corpusRange?.end ?? corpus.documents.length;
  const splitAt = options.splitAtCorpusIndex;
  const corpusSlice =
    splitAt === undefined
      ? corpus.documents.slice(corpusStart, corpusEnd)
      : corpus.documents.slice(corpusStart, Math.min(splitAt, corpusEnd));
  const corpusTail =
    splitAt === undefined ? [] : corpus.documents.slice(Math.max(corpusStart, splitAt), corpusEnd);
  const empty = options.continueFrom?.fixture ?? (await createEmptyFixtureDatabase(options));
  let edge: FakeEdge | undefined;
  let scope: import('@/lib/rag/tenant/scope').TenantScope | undefined;
  let uninstall: (() => Promise<void>) | undefined;
  let sidecarUploads: FixtureDatabase['ingestSidecarUploads'];
  let llamaAttempts = 0;
  const harnessEnv: Record<string, string> = {
    RAG_INGEST_PIPELINE: 'unified',
    RAG_PARSER: 'llamaparse',
    RAG_INJECTION_SCAN: 'quarantine',
    RAG_PDF_IMAGE_CHUNKS: 'true',
    RAG_EXACT_ID_LOOKUP: 'true',
    LLAMA_CLOUD_API_KEY: '',
    ...options.processEnv,
  };
  try {
    edge = options.continueFrom?.edge ?? (await startFakeEdge({ db: empty.db }));
    applyFixtureProcessEnv({
      edgeUrl: edge.url,
      deploymentMode,
      extra: options.continueFrom ? { ...harnessEnv, ...options.processEnv } : harnessEnv,
      vendorEmbeddingRoutes: Boolean(harnessEnv.RAG_EMBEDDING_PROFILES === 'on' || options.processEnv?.RAG_EMBEDDING_PROFILES === 'on'),
    });

    const { fixtureAdminClient, installIngestFakes } = await import('./ingest-fakes.mts');
    const { ingest } = await import('@/lib/rag/ingest');
    const { buildSourceKey } = await import('@/lib/rag/ingest/identity');
    const { mintScope } = await import('@/lib/rag/tenant/scope');

    const { INGEST_MODE_FEATURE_ENV } = await import('./ingest-fakes.mts');
    const fakes = await installIngestFakes({ db: fixtureAdminClient(edge.url), env: INGEST_MODE_FEATURE_ENV });
    uninstall = fakes.uninstall;

    scope =
      options.continueFrom?.scope ??
      (deploymentMode === 'multi-tenant' ? mintScope('personal', empty.fixtureUserId, null) : mintScope('single', null, null));
    for (const doc of corpusSlice) {
      const result = await ingest({
        scope,
        source: 'config_upload',
        sourceKey: buildSourceKey('config_upload', { filename: doc.filename }),
        text: doc.content,
        filename: doc.filename,
        mimeType: 'text/markdown',
        docType: 'general',
        signal: new AbortController().signal,
      });
      if (result.status !== 'ready') {
        throw new Error(`[Ingest Mode] ${doc.relpath} ended ${result.status} (${result.reason ?? 'no reason'}; warnings: ${result.warnings.join(', ') || 'none'})`);
      }
    }

    if (options.onAfterCorpusSlice && edge !== undefined) {
      const partialFixture = { ...empty, corpusSha256: ingestCorpusSha256(corpus.corpusSha256) } as FixtureDatabase;
      await options.onAfterCorpusSlice({ fixture: partialFixture, edge, scope });
    }

    for (const doc of corpusTail) {
      const result = await ingest({
        scope,
        source: 'config_upload',
        sourceKey: buildSourceKey('config_upload', { filename: doc.filename }),
        text: doc.content,
        filename: doc.filename,
        mimeType: 'text/markdown',
        docType: 'general',
        signal: new AbortController().signal,
      });
      if (result.status !== 'ready') {
        throw new Error(`[Ingest Mode] ${doc.relpath} ended ${result.status} (${result.reason ?? 'no reason'})`);
      }
    }

    const ingestTyped = includeTyped && (splitAt === undefined || corpusTail.length > 0);
    if (ingestTyped) for (const entry of loadTypedManifest()) {
      const filePath = path.join('eval/fixtures/ingest', entry.path);
      const bytes = fs.readFileSync(filePath);
      const filename = path.basename(entry.path);
      const expected = entry.expected?.injection?.expected_status === 'quarantined' ? 'quarantined' : 'ready';
      const result = await ingest({
        scope,
        source: 'config_upload',
        sourceKey: buildSourceKey('config_upload', { filename }),
        file: new Uint8Array(bytes),
        filename,
        mimeType: entry.mime,
        docType: entry.doc_type as import('@/lib/rag/ingest/profiles/load').DocType,
        signal: new AbortController().signal,
      });
      if (result.status !== expected) {
        throw new Error(
          `[Ingest Mode] typed fixture ${entry.id} ended ${result.status} (expected ${expected}; ${result.reason ?? 'no reason'}; warnings: ${result.warnings.join(', ') || 'none'})`,
        );
      }
    }

    sidecarUploads = fakes.sidecar.uploads.map((upload) => ({
      fileSha256: upload.fileSha256,
      request: upload.request,
    }));
    llamaAttempts = fakes.llamaParseAttempts();

    if (edge.errors.length > 0) {
      const sample = edge.errors
        .slice(0, 3)
        .map((error) => `${error.method} ${error.url} -> ${error.status}`)
        .join('; ');
      throw new Error(`[Ingest Mode] the fake edge refused ${edge.errors.length} request(s) while ingesting: ${sample}`);
    }
  } catch (error) {
    await edge?.close().catch(() => undefined);
    await empty.db.close().catch(() => undefined);
    throw error;
  } finally {
    await uninstall?.();
  }

  if (edge === undefined || scope === undefined) throw new Error('[Ingest Mode] internal error: ingest did not finish');
  const fixtureWithCorpus = { ...empty, corpusSha256: ingestCorpusSha256(corpus.corpusSha256) } as FixtureDatabase;
  const buildState: IngestFixtureBuildState = { fixture: fixtureWithCorpus, edge, scope };
  return {
    ...empty,
    corpusSha256: ingestCorpusSha256(corpus.corpusSha256),
    edge,
    ingestSidecarUploads: sidecarUploads,
    ingestLlamaParseAttempts: llamaAttempts,
    buildState,
  };
}