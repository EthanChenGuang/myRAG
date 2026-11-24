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
import { GoldenItemSchema, RagTraceSchema, RunManifestSchema, type GoldenItem, type RagRunRequest, type RagTrace, type RunManifest } from '../../src/lib/rag-eval/contracts.generated.ts';
import { canonicalJson, configHash } from '../../src/lib/rag-eval/trace.ts';
import { EMBEDDER_ID, EMBEDDER_VERSION, embedderSourceSha256 } from './fixture-embedder.mts';
import { createFixtureDatabase, FIXTURE_USER_ID, type DeploymentMode, type FixtureMode } from './pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from './fake-edge.mts';
import { applyFixtureProcessEnv } from './process-env.mts';
import { RunConfigError, type RunConfig } from './run-config.mts';

export type EvalTier = 'smoke' | 'nightly' | 'live';

export interface EvalRequestOptions {
  max_results?: number | null;
  organization_id?: string | null;
  user_id?: string | null;
  generator_model?: string | null;
  degrade?: 'drop_top_candidate' | null;
  embedding_profile?: string | null;
  retrieval_overrides?: NonNullable<RagRunRequest['options']>['retrieval_overrides'];
  retrieval_filters?: NonNullable<RagRunRequest['options']>['retrieval_filters'];
  disabled_stages?: Array<
    'refs' | 'analyze' | 'embed' | 'search' | 'legacy_rank' | 'post_filter' | 'assemble' | 'voice_keyword_fallback' | 'local_rerank'
  >;
}

export type EvalGenerator = 'stub' | 'live';

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
  fixtureUserId: string;
  corpusSha256: string;
  sqlSha256: Record<string, string>;
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
  /** Reuse a prepared in-process eval session (the harness keeps the edge open). */
  retainInProcess?: InProcessEval;
  /** Named configuration: an env overlay (in-process only) and eval overrides sent with every request. */
  runConfig?: RunConfig;
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
}

export function itemRequestOptions(base: EvalRequestOptions, item: GoldenItem): EvalRequestOptions {
  const options: EvalRequestOptions = { ...base };
  if (item.retrieval_filters) options.retrieval_filters = item.retrieval_filters;
  return options;
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

export async function prepareInProcessEval(options: {
  corpusDir: string;
  deploymentMode: DeploymentMode;
  fixtureMode?: FixtureMode;
  allowedScopes?: string[];
  embeddingProfileId?: string;
  ingestFixture?: import('./pglite-supabase.mts').FixtureDatabase;
  /** Applied after the pinned eval env, before the eval route is imported. */
  envOverrides?: Record<string, string>;
}): Promise<InProcessEval> {
  const { corpusDir, deploymentMode, fixtureMode, allowedScopes = [], embeddingProfileId, ingestFixture, envOverrides } =
    options;
  const existingSecret = process.env.RAG_EVAL_SECRET ?? '';
  const secret = existingSecret.length >= 32 ? existingSecret : crypto.randomBytes(24).toString('hex');
  const evalEnv = {
    RAG_EVAL_SECRET: secret,
    RAG_EVAL_ALLOWED_SCOPES: [`user:${FIXTURE_USER_ID}`, ...allowedScopes].join(','),
    ...(embeddingProfileId ? { RAG_EMBEDDING_PROFILES: 'on' } : {}),
  };
  const fixture =
    ingestFixture ??
    (await createFixtureDatabase({ deploymentMode, corpusDir, fixtureMode, processEnv: evalEnv }));
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

  applyFixtureProcessEnv({
    edgeUrl: startedEdge.url,
    deploymentMode,
    extra: { ...evalEnv, ...envOverrides },
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

  return {
    POST: route.POST as unknown as InProcessEval['POST'],
    secret,
    edge: startedEdge,
    fixtureUserId: fixture.fixtureUserId,
    corpusSha256: fixture.corpusSha256,
    sqlSha256: fixture.sqlSha256,
    close: async () => {
      translatorModule?.resetTranslatorForTests();
      if (!ingestFixture) {
        await startedEdge.close();
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
    includeAnswer = false,
    generator,
    includeDrafts = false,
    embeddingProfileId,
    ingestFixture,
    retainInProcess,
    runConfig,
  } = options;
  const requestOptions: EvalRequestOptions = { ...(options.requestOptions ?? {}) };
  if (runConfig) {
    if (baseUrl && Object.keys(runConfig.env).length > 0) {
      throw new RunConfigError('[Eval Harness] a run-config env overlay applies to in-process runs only; omit --base-url or drop its env');
    }
    if (retainInProcess && Object.keys(runConfig.env).length > 0) {
      throw new RunConfigError('[Eval Harness] a run-config env overlay must be applied when the in-process session is prepared');
    }
    if (runConfig.overrides) requestOptions.retrieval_overrides = runConfig.overrides;
  }

  let liveApiKey = '';
  if (includeAnswer) {
    if (generator !== 'stub' && generator !== 'live') {
      throw new Error("[Eval Harness] includeAnswer requires generator 'stub' or 'live'");
    }
    if (baseUrl && generator === 'stub') {
      throw new Error('[Eval Harness] the stub generator cannot be used with --base-url');
    }
    if (generator === 'live') {
      liveApiKey = (process.env.OPENROUTER_API_KEY ?? '').trim();
      if (liveApiKey === fixtureProcessEnv('').OPENROUTER_API_KEY) liveApiKey = '';
      if (!baseUrl && liveApiKey === '') throw new LiveGenerationKeyMissingError();
    }
    if (generator === 'stub' && !requestOptions.generator_model) requestOptions.generator_model = STUB_GENERATOR_MODEL;
  }

  const goldenFilter = goldenFilterFor(includeDrafts);
  const allItems = readGolden(goldenPath);
  const items = selectGolden(allItems, goldenFilter);
  if (items.length === 0) {
    throw new Error(`[Eval Harness] no golden items with review_status in [${goldenFilter.review_statuses.join(', ')}] in ${goldenPath}`);
  }
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
  let edgeErrors = 0;
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
          ...(runConfig && Object.keys(runConfig.env).length > 0 ? { envOverrides: runConfig.env } : {}),
        });
        inProcess = prepared;
      }
      if (includeAnswer) {
        answerModule = await import('../../src/lib/rag-eval/answer.ts');
        if (generator === 'stub') {
          answerModule.setEvalLanguageModelFactory(() => createStubLanguageModel());
        } else {
          const provider = createOpenRouter({ apiKey: liveApiKey, baseURL: 'https://openrouter.ai/api/v1' });
          answerModule.setEvalLanguageModelFactory((modelId) => provider(modelId) as unknown as LanguageModel);
        }
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

    for (const item of items) {
      const options = itemRequestOptions(requestOptions, item);
      if (inProcess && deploymentMode === 'multi-tenant' && !options.user_id) {
        options.user_id = inProcess.fixtureUserId;
      }
      const payload = {
        schema_version: 1 as const,
        query: item.question,
        conversation: item.conversation,
        rag_mode: 'strict' as const,
        web_search: false as const,
        options,
        item_id: item.id,
        ...(includeAnswer ? { include_answer: true as const } : {}),
      } as RagRunRequest;

      const { status, body } = await send(payload);
      if (status !== 200) {
        const detail = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : 'no error body';
        throw new Error(`[Eval Harness] item ${item.id}: route returned ${status} (${detail})`);
      }
      const trace = RagTraceSchema.parse(body);
      trace.item_id = item.id;
      if (firstEffectiveConfig === null) {
        firstEffectiveConfig = trace.effective_config;
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
    ...(requestOptions.retrieval_overrides ? { retrieval_overrides: requestOptions.retrieval_overrides } : {}),
    ...(requestOptions.disabled_stages?.length ? { disabled_stages: requestOptions.disabled_stages } : {}),
    ...(includeAnswer ? { generator_model: requestOptions.generator_model ?? null } : {}),
  };
  const embedder = baseUrl
    ? null
    : { id: EMBEDDER_ID, version: String(EMBEDDER_VERSION), source_sha256: embedderSourceSha256() };
  const goldenSha256 = sha256File(goldenPath);
  const runConfigRecord = runConfig ? { name: runConfig.name, env: runConfig.env, overrides: runConfig.overrides } : null;
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
    item_count: items.length,
    edge_errors: edgeErrors,
    ...(runConfigRecord ? { run_config: runConfigRecord } : {}),
  });
  const runPath = path.join(outDir, 'run.json');
  fs.writeFileSync(runPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { tracesPath, logPath, itemCount: items.length, skippedCount: allItems.length - items.length, tier, deploymentMode: effectiveDeploymentMode, edgeErrors, runPath, manifest };
}
