import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import util from 'node:util';
import { NextRequest } from 'next/server';
import { spawnSync } from 'node:child_process';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type { FakeLangChainTable } from '../../src/lib/rag/query/langchain/fake.ts';
import { GoldenItemSchema, RagTraceSchema, RunManifestSchema, TerminologyImportRowSchema, type GoldenItem, type RagRunRequest, type RagTrace, type RunManifest } from '../../src/lib/rag-eval/contracts.generated.ts';
import { canonicalJson, configHash } from '../../src/lib/rag-eval/trace.ts';
import { EMBEDDER_ID, EMBEDDER_VERSION, embedderSourceSha256 } from './fixture-embedder.mts';
import { ingestModeRetrievalEnv, partitionIngestModeItems } from './ingest-mode.mts';
import { closeTableSplitTenants, isTableSplitItem, TABLE_SPLIT_USER_ID, withTableSplitTenant, type TableSplitTenant } from './table-split.mts';
import { createFixtureDatabase, FIXTURE_USER_ID, seedTerminology, type DeploymentMode, type FixtureMode, type TerminologySeedRow } from './pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from './fake-edge.mts';
import { applyFixtureProcessEnv } from './process-env.mts';
import { FAKE_CITATION_GENERATOR_MODEL, installFakeCitationGenerator } from './fake-citation-generator.mts';
import { startFakeGroundedness, type FakeGroundedness } from './fake-groundedness.mts';
import { CHUNKING_PROFILES_NEED_INGEST, RunConfigError, type RunConfig } from './run-config.mts';
import { CACHE_PAIRS_APP_ENV, CACHE_PAIRS_FILE, cachePairOptions, cachePairSpecs, cachePairsRun, runCachePairs } from './cache-pairs.mts';

export type EvalTier = 'smoke' | 'nightly' | 'live';

export interface EvalRequestOptions {
  max_results?: number | null;
  organization_id?: string | null;
  user_id?: string | null;
  generator_model?: string | null;
  degrade?: 'drop_top_candidate' | null;
  embedding_profile?: string | null;
  embedding_bindings?: NonNullable<RagRunRequest['options']>['embedding_bindings'];
  domain_control_leg?: NonNullable<RagRunRequest['options']>['domain_control_leg'];
  retrieval_overrides?: NonNullable<RagRunRequest['options']>['retrieval_overrides'];
  retrieval_filters?: NonNullable<RagRunRequest['options']>['retrieval_filters'];
  disabled_stages?: Array<
    'refs' | 'analyze' | 'embed' | 'search' | 'legacy_rank' | 'post_filter' | 'assemble' | 'voice_keyword_fallback' | 'local_rerank'
  >;
  citations?: boolean;
  groundedness?: boolean;
  /** D-38 eval-only query-layer overrides, sent as they are. */
  query_framework?: NonNullable<RagRunRequest['options']>['query_framework'];
  query_layer?: NonNullable<RagRunRequest['options']>['query_layer'];
  query_transforms?: NonNullable<RagRunRequest['options']>['query_transforms'];
  semantic_cache?: NonNullable<RagRunRequest['options']>['semantic_cache'];
  query_params?: NonNullable<RagRunRequest['options']>['query_params'];
}

/** 'fake' is the deterministic citation generator (D-24); it serves fixture runs with --citations or --groundedness. */
export type EvalGenerator = 'stub' | 'live' | 'fake';

export const STUB_GENERATOR_MODEL = 'stub/extractive-v1';
export const LIVE_KEY_MISSING_NOTICE = '[RAG Eval] OPENROUTER_API_KEY not set; live generation skipped';

export class LiveGenerationKeyMissingError extends Error {
  constructor() {
    super(LIVE_KEY_MISSING_NOTICE);
    this.name = 'LiveGenerationKeyMissingError';
  }
}

export interface InProcessEval {
  POST: (req: NextRequest) => Promise<Response>;
  secret: string;
  edge: FakeEdge;
  /** The fixture database the edge serves between table_split items. */
  fixtureDb: import('@electric-sql/pglite').PGlite;
  /** Set when the session was prepared for table_split items (ingest mode only). */
  tableSplitTenants?: TableSplitTenant[];
  /** Ingest mode only: golden corpus document id to the id of the document the build wrote from the same file. */
  ingestDocumentIds?: ReadonlyMap<string, string>;
  fixtureUserId: string;
  corpusSha256: string;
  sqlSha256: Record<string, string>;
  fakeQueryLlm?: import('./fake-query-llm.mts').FakeQueryLlm;
  close: () => Promise<void>;
}

export interface RunEvalOptions {
  goldenPath: string;
  corpusDir: string;
  outDir: string;
  deploymentMode: DeploymentMode;
  fixtureMode?: FixtureMode;
  requestOptions?: EvalRequestOptions;
  tier?: EvalTier;
  baseUrl?: string;
  includeAnswer?: boolean;
  generator?: EvalGenerator;
  includeDrafts?: boolean;
  /** When set (in-process smoke only), backfill this profile via runReembed before traces are collected. */
  embeddingProfileId?: string;
  /** Reuse an ingest-mode fixture database instead of building a new one. */
  ingestFixture?: import('./pglite-supabase.mts').FixtureDatabase;
  /** Ingest mode only: fill the database through the queue per routing mode or forced tier (D-40). */
  ingestRouting?: import('./ingest-mode.mts').IngestRoutingOptions;
  /**
   * Eval check only: load the table_split documents with this processing-profile doc type instead of the manifest's (the
   * header-in-context check under RAG_TABLE_HEADER_REPEAT=always runs every profile). Changes the corpus hash, so such a run is
   * never gated against the default baseline.
   */
  tableSplitDocType?: string;
  /** Eval check only: ingestion switches for the in-process ingest build, also recorded in the retrieval env (never gated). */
  ingestBuildEnv?: Record<string, string>;
  /** Reuse a prepared in-process eval session (the harness keeps the edge open). */
  retainInProcess?: InProcessEval;
  /** Named configuration: an env overlay (in-process only) and eval overrides sent with every request. */
  runConfig?: RunConfig;
  /** Sets options.citations on every request; implies includeAnswer. */
  citations?: boolean;
  /** Sets options.groundedness on every request; implies includeAnswer. In-process runs score against the fake sidecar. */
  groundedness?: boolean;
  /**
   * Trusted harness input (never a run config): app variables for an in-process run, applied after the pinned eval env, such as
   * the nightly's Prompt Guard sidecar endpoint. Never recorded in the manifest.
   */
  appEnv?: Record<string, string>;
  /** D-37: run the golden cache pairs (anchor stored, candidate checked) and write cache-pairs.json instead of item traces. */
  cachePairs?: boolean;
  /** With cachePairs and baseUrl: the live run seeds and probes a live cache (plan 06-46); refused without it. */
  allowLiveCache?: boolean;
}

export interface RunEvalResult {
  tracesPath: string;
  logPath: string;
  itemCount: number;
  skippedCount: number;
  tier: EvalTier;
  deploymentMode: DeploymentMode;
  edgeErrors: number;
  runPath: string;
  manifest: RunManifest;
  /** Set by a cache-pairs run. */
  cachePairsPath?: string;
}

/** An item filter names a document id that ingest mode did not write from any corpus file: the run stops instead of dropping it. */
export class UnmappedFilterDocumentIdError extends Error {
  readonly itemId: string;
  readonly documentId: string;
  constructor(itemId: string, documentId: string) {
    super(`[Eval Harness] item ${itemId}: retrieval filter document id ${documentId} has no document written by ingest mode`);
    this.name = 'UnmappedFilterDocumentIdError';
    this.itemId = itemId;
    this.documentId = documentId;
  }
}

/**
 * The request options of one item. With `ingestDocumentIds` (ingest mode), every `retrieval_filters.document_ids` value is replaced by
 * the id of the document ingest mode wrote from the same corpus file; an id without one throws, so a filter is never dropped and an item
 * never runs unfiltered. Without it (prechunked mode) the golden ids are sent unchanged.
 */
export function itemRequestOptions(
  base: EvalRequestOptions,
  item: GoldenItem,
  ingestDocumentIds?: ReadonlyMap<string, string>,
): EvalRequestOptions {
  const options: EvalRequestOptions = { ...base };
  const filters = item.retrieval_filters;
  if (!filters) return options;
  if (ingestDocumentIds === undefined || !filters.document_ids) {
    options.retrieval_filters = filters;
    return options;
  }
  const documentIds = filters.document_ids.map((id) => {
    const mapped = ingestDocumentIds.get(id);
    if (mapped === undefined) throw new UnmappedFilterDocumentIdError(item.id, id);
    return mapped;
  });
  options.retrieval_filters = { ...filters, document_ids: documentIds };
  return options;
}

// D-07: every harness request runs in strict mode; run.json and the report carry it, run_config_hash does not.
const EVAL_RAG_MODE = 'strict' as const;
const NO_INGEST_DOCUMENT_IDS: ReadonlyMap<string, string> = new Map();

const INJECTION_CATEGORIES: ReadonlySet<string> = new Set(['injection', 'injection_evasive']);

/**
 * D-14: the smoke tier asks the stub extractive generator to answer the injection and injection_evasive items, so attack success
 * (canary or forbidden claim in the answer) is measured in CI. Every other item, and every other tier, is sent exactly as before.
 */
export function answersItemForInjectionMetrics(tier: EvalTier, item: GoldenItem): boolean {
  return tier === 'smoke' && INJECTION_CATEGORIES.has(item.category);
}

const ROUTE_PATH = '/api/internal/rag/run';
const FIRST_SENTENCE_RE = /^[\s\S]*?[.!?。！？](?=\s|$)/;
const NO_CONTEXT_ANSWER = 'No context was provided.';

function stubAnswerFromSystemPrompt(system: string): string {
  const marker = system.indexOf('Content:');
  if (marker === -1) return NO_CONTEXT_ANSWER;
  const body = system
    .slice(marker + 'Content:'.length)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .trim();
  if (body === '') return NO_CONTEXT_ANSWER;
  const sentence = FIRST_SENTENCE_RE.exec(body);
  return (sentence ? sentence[0] : body.split('\n')[0]).trim();
}

function createStubLanguageModel(): LanguageModel {
  return new MockLanguageModelV3({
    provider: 'stub',
    modelId: STUB_GENERATOR_MODEL,
    doGenerate: async (callOptions) => {
      const systemMessage = callOptions.prompt.find((message) => message.role === 'system');
      const system = systemMessage && typeof systemMessage.content === 'string' ? systemMessage.content : '';
      return {
        content: [{ type: 'text' as const, text: stubAnswerFromSystemPrompt(system) }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
  }) as unknown as LanguageModel;
}

const TRANSLATION_TABLE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/translation-table.json');

function switchIsOn(value: string | undefined, expected: string): boolean {
  return (value ?? '').trim().toLowerCase() === expected;
}

/** The fixture translator serves v2 runs whose overlay turns RAG_LEXICAL_TRANSLATION on; legacy runs never get it. */
export function shouldInstallFixtureTranslator(env: Record<string, string> | undefined): boolean {
  return switchIsOn(env?.RAG_PIPELINE, 'v2') && switchIsOn(env?.RAG_LEXICAL_TRANSLATION, 'true');
}

/**
 * D-39: an in-process v2 run whose overlay or request options turn the query layer on gets the deterministic fake query LLM, so
 * no fixture run calls a live model. Legacy keeps the layer inert, so it never needs one.
 */
export function shouldInstallFakeQueryLlm(env: Record<string, string | undefined> | undefined, options: { queryLayer?: boolean } = {}): boolean {
  if (!switchIsOn(env?.RAG_PIPELINE, 'v2')) return false;
  return switchIsOn(env?.RAG_QUERY_LAYER, 'true') || options.queryLayer === true;
}

const FIXTURE_TERMINOLOGY_PATH = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), 'eval/fixtures/terminology/dictionary.jsonl');

/** D-27: the fixture dictionary (eval/fixtures/terminology/dictionary.jsonl) as shared-layer seed rows; each line is a TerminologyImportRow. */
export function loadFixtureTerminologySeed(filePath: string = FIXTURE_TERMINOLOGY_PATH): TerminologySeedRow[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim() !== '')
    .map(({ line, index }) => {
      const parsed = TerminologyImportRowSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`[Eval Harness] ${path.basename(filePath)} line ${index + 1} is not a TerminologyImportRow`);
      const row = parsed.data;
      return {
        layer: 'shared',
        canonical: row.canonical,
        variants: row.variants,
        language: row.language,
        kind: row.kind,
        mode: row.mode,
        source_language: row.source_language,
        target_language: row.target_language,
      };
    });
}

/** A caller-built database gets the seed too, unless the caller already wrote a shared layer (or built it without the terminology tables). */
async function seedCallerFixture(db: import('@electric-sql/pglite').PGlite, rows: readonly TerminologySeedRow[]): Promise<void> {
  if (rows.length === 0) return;
  const table = await db.query<{ present: boolean }>("SELECT to_regclass('public.rag_term_layers') IS NOT NULL AS present");
  if (!table.rows[0]?.present) return;
  const layers = new Set(rows.map((row) => row.layer));
  const existing = await db.query<{ layer_key: string }>('SELECT layer_key FROM public.rag_term_layers WHERE layer_key = ANY($1::text[])', [[...layers]]);
  if (existing.rows.length > 0) return;
  await seedTerminology(db, rows);
}

export async function prepareInProcessEval(options: {
  corpusDir: string;
  deploymentMode: DeploymentMode;
  fixtureMode?: FixtureMode;
  allowedScopes?: string[];
  embeddingProfileId?: string;
  ingestFixture?: import('./pglite-supabase.mts').FixtureDatabase;
  ingestRouting?: import('./ingest-mode.mts').IngestRoutingOptions;
  /** Applied after the pinned eval env, before the eval route is imported. */
  envOverrides?: Record<string, string>;
  /** Trusted harness variables applied with the overlay; not part of the run's recorded configuration. */
  appEnv?: Record<string, string>;
  /** Ingest mode: seeded before the first document; the env overlay is then applied to the build too, so dual-write runs under v2. */
  chunkingProfiles?: import('../../src/lib/rag-eval/contracts.generated.ts').ChunkingProfile[];
  /** Ingest mode: also load the isolated table_split tenants (table-split.mts). */
  tableSplit?: boolean;
  /** Ingest mode: the doc type the table_split documents are loaded with (RunEvalOptions.tableSplitDocType). */
  tableSplitDocType?: string;
  /** Ingest mode: ingestion switches for the fixture build, also recorded in the retrieval env (RunEvalOptions.ingestBuildEnv). */
  ingestBuildEnv?: Record<string, string>;
  /** The run's requests set options.query_layer=true (D-38); with the env overlay it decides the fake query LLM install (D-39). */
  queryLayer?: boolean;
  /**
   * D-27: dictionary rows written into the fixture database, whatever RAG_TERMINOLOGY says. Defaults to the fixture dictionary; an empty
   * list seeds nothing. A caller-built ingestFixture is seeded only when it holds no layer of these rows yet.
   */
  terminologySeed?: readonly import('./pglite-supabase.mts').TerminologySeedRow[];
}): Promise<InProcessEval> {
  const {
    corpusDir,
    deploymentMode,
    fixtureMode,
    allowedScopes = [],
    embeddingProfileId,
    ingestFixture,
    envOverrides,
    chunkingProfiles,
    ingestRouting,
    appEnv,
  } = options;
  const tableSplit = options.tableSplit === true;
  if (ingestRouting && fixtureMode !== 'ingest') throw new Error('[Eval Harness] routing and forced tiers need --fixture-mode ingest');
  if (tableSplit && (fixtureMode !== 'ingest' || ingestRouting)) {
    throw new Error('[Eval Harness] table_split items run only in the inline ingest fixture mode');
  }
  const existingSecret = process.env.RAG_EVAL_SECRET ?? '';
  const secret = existingSecret.length >= 32 ? existingSecret : crypto.randomBytes(24).toString('hex');
  const evalEnv = {
    RAG_EVAL_SECRET: secret,
    RAG_EVAL_ALLOWED_SCOPES: [
      `user:${FIXTURE_USER_ID}`,
      ...(tableSplit && deploymentMode === 'multi-tenant' ? [`user:${TABLE_SPLIT_USER_ID}`] : []),
      ...allowedScopes,
    ].join(','),
    ...(embeddingProfileId ? { RAG_EMBEDDING_PROFILES: 'on' } : {}),
  };
  const seeding = !ingestFixture && (chunkingProfiles?.length ?? 0) > 0;
  const terminologySeed = options.terminologySeed ?? loadFixtureTerminologySeed();
  if (ingestFixture) await seedCallerFixture(ingestFixture.db, terminologySeed);
  const fixture =
    ingestFixture ??
    (await createFixtureDatabase({
      deploymentMode,
      corpusDir,
      fixtureMode,
      processEnv: seeding ? { ...evalEnv, ...envOverrides } : evalEnv,
      ...(seeding ? { chunkingProfiles } : {}),
      ...(ingestRouting ? { ingestRouting } : {}),
      ...(tableSplit ? { tableSplit: true } : {}),
      ...(tableSplit && options.tableSplitDocType ? { tableSplitDocType: options.tableSplitDocType } : {}),
      ...(options.ingestBuildEnv ? { ingestEnv: options.ingestBuildEnv } : {}),
      ...(terminologySeed.length ? { terminologySeed } : {}),
    }));
  if (tableSplit && !fixture.tableSplitTenants) {
    if (!ingestFixture) await fixture.db.close().catch(() => undefined);
    throw new Error('[Eval Harness] the ingest fixture was built without the table_split tenants');
  }
  let edge: FakeEdge | undefined;
  try {
    // The ingest mode ingests the corpus through its own edge and hands it over: a second edge would have another URL than the
    // one the app modules saw when they were first imported.
    edge = fixture.edge ?? (await startFakeEdge({ db: fixture.db }));
  } catch (error) {
    await fixture.db.close().catch(() => undefined);
    throw error;
  }
  const startedEdge = edge;
  // The caller closes what it passed in (the ingest fixture's database, and its edge when it brought one); close() releases the rest.
  const ownsDb = !ingestFixture;
  const ownsEdge = !ingestFixture?.edge;

  const retrievalEnv =
    fixtureMode === 'ingest' ? { ...ingestModeRetrievalEnv(), ...envOverrides } : envOverrides;
  applyFixtureProcessEnv({
    edgeUrl: startedEdge.url,
    deploymentMode,
    extra: { ...evalEnv, ...retrievalEnv, ...options.ingestBuildEnv, ...appEnv },
    vendorEmbeddingRoutes: !!(embeddingProfileId || ingestFixture),
  });

  if (embeddingProfileId && !ingestFixture) {
    const { fixtureAdminClient } = await import('./ingest-fakes.mts');
    const { runReembed } = await import('../../src/lib/rag/ingest/reembed/run.ts');
    const report = await runReembed({ db: fixtureAdminClient(startedEdge.url), profileId: embeddingProfileId, batchSize: 32 });
    if (report.status !== 'completed') {
      throw new Error(`[Eval Harness] re-embed for profile ${embeddingProfileId} failed: ${report.reason ?? 'unknown'}`);
    }
  }

  const route = await import('../../src/app/api/internal/rag/run/route.ts');

  let translatorModule: typeof import('../../src/lib/rag/query/translate.ts') | null = null;
  if (shouldInstallFixtureTranslator(envOverrides)) {
    translatorModule = await import('../../src/lib/rag/query/translate.ts');
    const table = JSON.parse(fs.readFileSync(TRANSLATION_TABLE_PATH, 'utf8')) as import('../../src/lib/rag/query/translate.ts').TranslationTable;
    translatorModule.setTranslatorForTests(translatorModule.createFixtureTranslator(table));
  }

  // The effective env: the pinned eval env with the overlay applied above.
  let fakeQueryLlm: import('./fake-query-llm.mts').FakeQueryLlm | undefined;
  let restoreQueryLlm: (() => void) | undefined;
  if (shouldInstallFakeQueryLlm(process.env, { queryLayer: options.queryLayer })) {
    const depsModule = await import('../../src/lib/rag/deps.ts');
    const { createFakeQueryLlm, loadFakeQueryLlmTable } = await import('./fake-query-llm.mts');
    const transformerModule = await import('../../src/lib/rag/query/transformer.ts');
    const { createFakeLangChainChatModel } = await import('../../src/lib/rag/query/langchain/fake.ts');
    const previous = depsModule.getRagDeps().queryLlm;
    const table = loadFakeQueryLlmTable();
    const fake = createFakeQueryLlm({ table });
    fakeQueryLlm = fake;
    depsModule.setRagDepsForTests({ queryLlm: () => fake });
    // The LangChain path reads the same table through its fake chat model, so it never builds ChatOpenAI (D-39).
    const langchainFake = createFakeLangChainChatModel({ table: table as unknown as FakeLangChainTable });
    transformerModule.setLangChainChatModelFactoryForTests(() => langchainFake);
    restoreQueryLlm = () => {
      depsModule.setRagDepsForTests({ queryLlm: previous });
      transformerModule.setLangChainChatModelFactoryForTests(null);
    };
  }

  const floorModule = await import('../../src/lib/rag/refusal/floor.ts');
  const { loadFixtureScoreCalibration } = await import('./fixture-floor.mts');
  floorModule.setEvalScoreCalibration(loadFixtureScoreCalibration(fixtureMode === 'ingest' ? 'ingest' : 'prechunked'));

  return {
    POST: route.POST as unknown as InProcessEval['POST'],
    secret,
    edge: startedEdge,
    fixtureDb: fixture.db,
    ...(fixture.tableSplitTenants ? { tableSplitTenants: fixture.tableSplitTenants } : {}),
    ...(fixtureMode === 'ingest' ? { ingestDocumentIds: new Map(Object.entries(fixture.ingestDocumentIds ?? {})) } : {}),
    fixtureUserId: fixture.fixtureUserId,
    corpusSha256: fixture.corpusSha256,
    sqlSha256: fixture.sqlSha256,
    ...(fakeQueryLlm ? { fakeQueryLlm } : {}),
    close: async () => {
      restoreQueryLlm?.();
      translatorModule?.resetTranslatorForTests();
      floorModule.resetEvalScoreCalibration();
      if (ownsEdge) await startedEdge.close();
      if (ownsDb) {
        await closeTableSplitTenants(fixture.tableSplitTenants);
        await fixture.db.close().catch(() => undefined);
      }
    },
  };
}

function readGolden(goldenPath: string): GoldenItem[] {
  const lines = fs
    .readFileSync(goldenPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  return lines.map((line, index) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`[Eval Harness] golden line ${index + 1} is not valid JSON`);
    }
    const parsed = GoldenItemSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`[Eval Harness] golden line ${index + 1} violates GoldenItemSchema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    return parsed.data;
  });
}

export interface GoldenFilter {
  review_statuses: Array<'approved' | 'draft'>;
  gate_split: 'dev';
}

export function goldenFilterFor(includeDrafts: boolean): GoldenFilter {
  return { review_statuses: includeDrafts ? ['approved', 'draft'] : ['approved'], gate_split: 'dev' };
}

export function selectGolden(items: GoldenItem[], filter: GoldenFilter): GoldenItem[] {
  const statuses = new Set<string>(filter.review_statuses);
  return items.filter((item) => statuses.has(item.review_status));
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('[Eval Harness] --base-url is not a valid URL');
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return;
  throw new Error('[Eval Harness] --base-url must use https (plain http is allowed only for localhost)');
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gitHeadSha(): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha === '' ? null : sha;
}

function redirectConsole(logPath: string): () => void {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const original = new Map<string, (...args: unknown[]) => void>();
  for (const method of methods) {
    original.set(method, console[method].bind(console));
    console[method] = (...args: unknown[]) => {
      fs.appendFileSync(logPath, `${util.format(...args)}\n`);
    };
  }
  return () => {
    for (const method of methods) console[method] = original.get(method)!;
  };
}

export async function runEval(options: RunEvalOptions): Promise<RunEvalResult> {
  const {
    goldenPath,
    corpusDir,
    outDir,
    deploymentMode,
    fixtureMode,
    tier = 'smoke',
    baseUrl,
    includeDrafts = false,
    embeddingProfileId,
    ingestFixture,
    ingestRouting,
    retainInProcess,
    runConfig,
  } = options;
  const cachePairs = options.cachePairs === true;
  if (cachePairs && baseUrl && options.allowLiveCache !== true) {
    throw new Error('[Eval Harness] a --cache-pairs run against --base-url seeds and probes a live cache; pass --allow-live-cache (plan 06-46)');
  }
  const requestOptions: EvalRequestOptions = { ...(options.requestOptions ?? {}) };
  const citations = options.citations === true;
  const groundedness = options.groundedness === true;
  const answerFeatures = citations || groundedness;
  if (citations) requestOptions.citations = true;
  if (groundedness) requestOptions.groundedness = true;
  // Citations and groundedness need an answer: a fixture run answers with the fake citation generator unless a live one is asked for.
  const includeAnswer = options.includeAnswer === true || answerFeatures;
  let generator = options.generator;
  if (answerFeatures) {
    if (baseUrl) generator ??= 'live';
    else if (generator === undefined || generator === 'stub') generator = 'fake';
  }
  if (runConfig) {
    if (baseUrl && Object.keys(runConfig.env).length > 0) {
      throw new RunConfigError('[Eval Harness] a run-config env overlay applies to in-process runs only; omit --base-url or drop its env');
    }
    if (retainInProcess && Object.keys(runConfig.env).length > 0) {
      throw new RunConfigError('[Eval Harness] a run-config env overlay must be applied when the in-process session is prepared');
    }
    if (runConfig.overrides) requestOptions.retrieval_overrides = runConfig.overrides;
    if (runConfig.chunkingProfiles?.length) {
      if (baseUrl) throw new RunConfigError('[Eval Harness] chunking_profiles seed the fixture database only; a --base-url run cannot use them');
      if (fixtureMode !== 'ingest') throw new RunConfigError(CHUNKING_PROFILES_NEED_INGEST);
      if (ingestFixture) {
        const built = new Set(ingestFixture.seededChunkingProfiles ?? []);
        const missing = runConfig.chunkingProfiles.filter((profile) => !built.has(profile.id)).map((profile) => profile.id);
        if (missing.length > 0) {
          throw new RunConfigError(`[Eval Harness] the ingest fixture was not built with chunking profile(s) ${missing.join(', ')}`);
        }
      }
    }
  }

  if (baseUrl && options.appEnv && Object.keys(options.appEnv).length > 0) {
    throw new Error('[Eval Harness] app variables apply to in-process runs only; omit --base-url');
  }

  let liveApiKey = '';
  if (includeAnswer) {
    if (generator !== 'stub' && generator !== 'live' && generator !== 'fake') {
      throw new Error("[Eval Harness] includeAnswer requires generator 'stub', 'fake' or 'live'");
    }
    if (baseUrl && generator !== 'live') {
      throw new Error(`[Eval Harness] the ${generator} generator cannot be used with --base-url`);
    }
    if (generator === 'live') {
      liveApiKey = (process.env.OPENROUTER_API_KEY ?? '').trim();
      if (liveApiKey === fixtureProcessEnv('').OPENROUTER_API_KEY) liveApiKey = '';
      if (!baseUrl && liveApiKey === '') throw new LiveGenerationKeyMissingError();
    }
    if (generator === 'stub' && !requestOptions.generator_model) requestOptions.generator_model = STUB_GENERATOR_MODEL;
    if (generator === 'fake' && !requestOptions.generator_model) requestOptions.generator_model = FAKE_CITATION_GENERATOR_MODEL;
  }

  const goldenFilter = goldenFilterFor(includeDrafts);
  const allItems = readGolden(goldenPath);
  // table_split items need the isolated tenants of the inline ingest fixture mode; every other run leaves them out.
  const tableSplitRunnable = !baseUrl && fixtureMode === 'ingest' && !ingestRouting;
  const items = selectGolden(allItems, goldenFilter).filter((item) => tableSplitRunnable || !isTableSplitItem(item));
  const routed = partitionIngestModeItems(items);
  if (items.length === 0) {
    throw new Error(`[Eval Harness] no golden items with review_status in [${goldenFilter.review_statuses.join(', ')}] in ${goldenPath}`);
  }
  // Run-level answers keep their own generator; otherwise an in-process smoke run answers the injection items with the stub only.
  const stubInjectionAnswers = !includeAnswer && !baseUrl && items.some((item) => answersItemForInjectionMetrics(tier, item));
  fs.mkdirSync(outDir, { recursive: true });
  const tracesPath = path.join(outDir, 'traces.jsonl');
  const logPath = path.join(outDir, 'harness.log');
  fs.writeFileSync(tracesPath, '');
  fs.writeFileSync(logPath, '');

  let httpSecret = '';
  if (baseUrl) {
    assertSafeBaseUrl(baseUrl);
    httpSecret = process.env.RAG_EVAL_SECRET ?? '';
    if (!httpSecret) throw new Error('[Eval Harness] RAG_EVAL_SECRET must be set for --base-url runs');
  }

  const restoreConsole = redirectConsole(logPath);
  let inProcess: InProcessEval | undefined;
  let answerModule: typeof import('../../src/lib/rag-eval/answer.ts') | undefined;
  let fakeGroundedness: FakeGroundedness | undefined;
  let edgeErrors = 0;
  let cachePairsPath: string | undefined;
  let firstEffectiveConfig: RagTrace['effective_config'] | null = null;
  let manifestInputs: { corpusSha256: string | null; sqlSha256: Record<string, string> } = { corpusSha256: null, sqlSha256: {} };
  try {
    let send: (payload: RagRunRequest) => Promise<{ status: number; body: unknown }>;
    if (baseUrl) {
      const url = `${baseUrl.replace(/\/+$/, '')}${ROUTE_PATH}`;
      send = async (payload) => {
        const res = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', 'x-rag-eval-secret': httpSecret },
          body: JSON.stringify(payload),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
    } else {
      const requestedScope = requestOptions.organization_id
        ? `org:${requestOptions.organization_id}`
        : requestOptions.user_id
          ? `user:${requestOptions.user_id}`
          : null;
      if (retainInProcess) {
        inProcess = retainInProcess;
      } else {
        const prepared = await prepareInProcessEval({
          corpusDir,
          deploymentMode,
          fixtureMode,
          allowedScopes: requestedScope ? [requestedScope] : [],
          embeddingProfileId,
          ingestFixture,
          ...(ingestRouting ? { ingestRouting } : {}),
          ...(routed.tableSplit.length > 0 ? { tableSplit: true } : {}),
          ...(routed.tableSplit.length > 0 && options.tableSplitDocType ? { tableSplitDocType: options.tableSplitDocType } : {}),
          ...(options.ingestBuildEnv ? { ingestBuildEnv: options.ingestBuildEnv } : {}),
          ...(runConfig && Object.keys(runConfig.env).length > 0 ? { envOverrides: runConfig.env } : {}),
          ...(runConfig?.chunkingProfiles?.length ? { chunkingProfiles: runConfig.chunkingProfiles } : {}),
          ...(cachePairs
            ? { appEnv: { ...options.appEnv, ...CACHE_PAIRS_APP_ENV } }
            : options.appEnv && Object.keys(options.appEnv).length > 0
              ? { appEnv: options.appEnv }
              : {}),
          ...(requestOptions.query_layer === true ? { queryLayer: true } : {}),
        });
        inProcess = prepared;
      }
      if (stubInjectionAnswers) {
        answerModule = await import('../../src/lib/rag-eval/answer.ts');
        answerModule.setEvalLanguageModelFactory(() => createStubLanguageModel());
      } else if (includeAnswer) {
        answerModule = await import('../../src/lib/rag-eval/answer.ts');
        if (generator === 'stub') {
          answerModule.setEvalLanguageModelFactory(() => createStubLanguageModel());
        } else if (generator === 'fake') {
          answerModule.setEvalLanguageModelFactory(installFakeCitationGenerator());
        } else {
          const provider = createOpenRouter({ apiKey: liveApiKey, baseURL: 'https://openrouter.ai/api/v1' });
          answerModule.setEvalLanguageModelFactory((modelId) => provider(modelId) as unknown as LanguageModel);
        }
      }
      if (groundedness) {
        // The eval route posts to this fake instead of RAG_SIDECAR_URL; the real client keeps the secret header and the contract.
        const fake = await startFakeGroundedness();
        fakeGroundedness = fake;
        const { requestGroundedness } = await import('../../src/lib/rag/generation/groundedness-client.ts');
        answerModule ??= await import('../../src/lib/rag-eval/answer.ts');
        answerModule.setEvalGroundednessRequest((request, callOptions) =>
          requestGroundedness(request, { ...callOptions, url: fake.url, secret: fake.secret }),
        );
      }
      send = async (payload) => {
        if (!inProcess) throw new Error('[Eval Harness] in-process eval is not prepared');
        const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rag-eval-secret': inProcess.secret },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(120_000),
        });
        const res = await inProcess.POST(req);
        return { status: res.status, body: await res.json().catch(() => null) };
      };
    }

    if (cachePairs) {
      const pairOptions = cachePairOptions(requestOptions);
      if (inProcess && deploymentMode === 'multi-tenant' && !pairOptions.user_id && !pairOptions.organization_id) {
        pairOptions.user_id = inProcess.fixtureUserId;
      }
      const session = inProcess;
      if (!session) console.warn('[Eval Harness] live cache-pair run: the cache is not cleared between pairs');
      const rows = await runCachePairs({
        specs: cachePairSpecs(items),
        options: pairOptions,
        send,
        // A fresh fixture database per run; clearing it per pair makes each distance the distance to the pair's own anchor.
        ...(session ? { clear: async () => void (await session.fixtureDb.query('DELETE FROM public.rag_semantic_cache')) } : {}),
        onTrace: (trace) => {
          firstEffectiveConfig ??= trace.effective_config ?? null;
          fs.appendFileSync(tracesPath, `${JSON.stringify(trace)}\n`);
        },
      });
      const pairsRun = cachePairsRun({
        rows,
        source: baseUrl ? 'live' : 'fixture',
        embeddingProfileId: baseUrl ? (requestOptions.embedding_profile ?? null) : EMBEDDER_ID,
      });
      cachePairsPath = path.join(outDir, CACHE_PAIRS_FILE);
      fs.writeFileSync(cachePairsPath, `${JSON.stringify(pairsRun, null, 2)}\n`);
    }

    const tableTenants = routed.tableSplit.length > 0 ? inProcess?.tableSplitTenants : undefined;
    if (routed.tableSplit.length > 0 && !tableTenants) {
      throw new Error('[Eval Harness] table_split items need an ingest session prepared with the table_split tenants');
    }
    // Ingest mode routes by category: the other items first, exactly as before, then each table_split item against its tenant.
    for (const item of cachePairs ? [] : [...routed.main, ...routed.tableSplit]) {
      // Ingest mode: filter ids name the documents the build wrote; the table_split tenants have no map, so their filters fail closed.
      const documentIds =
        fixtureMode === 'ingest'
          ? isTableSplitItem(item)
            ? NO_INGEST_DOCUMENT_IDS
            : (inProcess?.ingestDocumentIds ?? NO_INGEST_DOCUMENT_IDS)
          : undefined;
      const options = itemRequestOptions(requestOptions, item, documentIds);
      if (inProcess && deploymentMode === 'multi-tenant' && !options.user_id) {
        options.user_id = inProcess.fixtureUserId;
      }
      // In multi-tenant mode the table_split documents belong to their own fixture user: its tenant key is the request's scope.
      if (inProcess && deploymentMode === 'multi-tenant' && isTableSplitItem(item)) {
        options.user_id = TABLE_SPLIT_USER_ID;
        options.organization_id = null;
      }
      const stubAnswer = stubInjectionAnswers && answersItemForInjectionMetrics(tier, item);
      if (stubAnswer) options.generator_model = STUB_GENERATOR_MODEL;
      const payload = {
        schema_version: 1 as const,
        query: item.question,
        conversation: item.conversation,
        rag_mode: EVAL_RAG_MODE,
        web_search: false as const,
        options,
        item_id: item.id,
        ...(includeAnswer || stubAnswer ? { include_answer: true as const } : {}),
      } as RagRunRequest;

      const { status, body } =
        tableTenants && inProcess && isTableSplitItem(item)
          ? await withTableSplitTenant(inProcess.edge, inProcess.fixtureDb, tableTenants, item, () => send(payload))
          : await send(payload);
      if (status !== 200) {
        const detail = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : 'no error body';
        throw new Error(`[Eval Harness] item ${item.id}: route returned ${status} (${detail})`);
      }
      const trace = RagTraceSchema.parse(body);
      trace.item_id = item.id;
      if (firstEffectiveConfig === null) {
        // A per-item stub answer is not part of the run's configuration: the run-level hash stays what it was without it.
        firstEffectiveConfig = stubAnswer ? { ...trace.effective_config, generator_model: null } : trace.effective_config;
        const serverMode = trace.effective_config.deployment_mode;
        if (baseUrl && serverMode !== 'single-tenant' && serverMode !== 'multi-tenant') {
          throw new Error(`[Eval Harness] server reports unknown deployment_mode ${JSON.stringify(serverMode)}`);
        }
        if (baseUrl && serverMode === 'multi-tenant' && !requestOptions.organization_id && !requestOptions.user_id) {
          throw new Error('[Eval Harness] the server is multi-tenant: pass --org <uuid> or --user <uuid> to scope the run');
        }
      }
      fs.appendFileSync(tracesPath, `${JSON.stringify(trace)}\n`);
    }

    if (inProcess) {
      manifestInputs = { corpusSha256: inProcess.corpusSha256, sqlSha256: inProcess.sqlSha256 };
      edgeErrors = inProcess.edge.errors.length;
      if (edgeErrors > 0) {
        const sample = inProcess.edge.errors
          .slice(0, 3)
          .map((e) => `${e.method} ${e.url} -> ${e.status}`)
          .join('; ');
        throw new Error(`[Eval Harness] fake edge recorded ${edgeErrors} unsupported or failed request(s): ${sample}`);
      }
    }
  } finally {
    restoreConsole();
    answerModule?.setEvalLanguageModelFactory(null);
    answerModule?.setEvalGroundednessRequest(null);
    await fakeGroundedness?.close();
    if (inProcess && !retainInProcess) await inProcess.close();
  }

  const effectiveDeploymentMode: DeploymentMode =
    baseUrl && firstEffectiveConfig ? (firstEffectiveConfig.deployment_mode as DeploymentMode) : deploymentMode;
  if (effectiveDeploymentMode !== deploymentMode) {
    console.warn(`[Eval Harness] server deployment_mode ${effectiveDeploymentMode} overrides --deployment-mode ${deploymentMode}`);
  }

  const embeddingProfile = requestOptions.embedding_profile ?? embeddingProfileId ?? null;
  const normalizedOptions = {
    max_results: requestOptions.max_results ?? null,
    organization_id: requestOptions.organization_id ?? null,
    user_id: requestOptions.user_id ?? null,
    embedding_profile: embeddingProfile,
    ...(requestOptions.degrade ? { degrade: requestOptions.degrade } : {}),
    ...(requestOptions.embedding_bindings && Object.keys(requestOptions.embedding_bindings).length > 0
      ? { embedding_bindings: requestOptions.embedding_bindings }
      : {}),
    ...(requestOptions.domain_control_leg ? { domain_control_leg: requestOptions.domain_control_leg } : {}),
    ...(requestOptions.retrieval_overrides ? { retrieval_overrides: requestOptions.retrieval_overrides } : {}),
    ...(requestOptions.disabled_stages?.length ? { disabled_stages: requestOptions.disabled_stages } : {}),
    ...(includeAnswer ? { generator_model: requestOptions.generator_model ?? null } : {}),
    ...(citations ? { citations: true } : {}),
    ...(groundedness ? { groundedness: true } : {}),
  };
  const embedder = baseUrl
    ? null
    : { id: EMBEDDER_ID, version: String(EMBEDDER_VERSION), source_sha256: embedderSourceSha256() };
  const goldenSha256 = sha256File(goldenPath);
  const runConfigRecord = runConfig
    ? {
        name: runConfig.name,
        env: runConfig.env,
        overrides: runConfig.overrides,
        ...(runConfig.chunkingProfiles?.length ? { chunking_profiles: runConfig.chunkingProfiles } : {}),
      }
    : null;
  const effectiveConfigHash = configHash(firstEffectiveConfig);
  const runConfigHash = crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        effective_config_hash: effectiveConfigHash,
        embedder,
        corpus_sha256: manifestInputs.corpusSha256,
        golden_sha256: goldenSha256,
        golden_filter: goldenFilter,
        sql_sha256: manifestInputs.sqlSha256,
        request_options: normalizedOptions,
        deployment_mode: effectiveDeploymentMode,
        ...(runConfigRecord ? { run_config: runConfigRecord } : {}),
      }),
      'utf8',
    )
    .digest('hex');

  const manifest = RunManifestSchema.parse({
    schema_version: 1,
    run_id: crypto.randomUUID(),
    tier,
    created_at: new Date().toISOString(),
    git_sha: gitHeadSha(),
    deployment_mode: effectiveDeploymentMode,
    embedder,
    corpus_sha256: manifestInputs.corpusSha256,
    golden_path: path.relative(process.cwd(), goldenPath) || goldenPath,
    golden_sha256: goldenSha256,
    golden_filter: goldenFilter,
    sql_sha256: manifestInputs.sqlSha256,
    request_options: normalizedOptions,
    embedding_profile: embeddingProfile,
    effective_config_hash: effectiveConfigHash,
    run_config_hash: runConfigHash,
    rag_mode: EVAL_RAG_MODE,
    item_count: items.length,
    edge_errors: edgeErrors,
    ...(runConfigRecord ? { run_config: runConfigRecord } : {}),
  });
  const runPath = path.join(outDir, 'run.json');
  fs.writeFileSync(runPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    tracesPath,
    logPath,
    itemCount: items.length,
    skippedCount: allItems.length - items.length,
    tier,
    deploymentMode: effectiveDeploymentMode,
    edgeErrors,
    runPath,
    manifest,
    ...(cachePairsPath ? { cachePairsPath } : {}),
  };
}
