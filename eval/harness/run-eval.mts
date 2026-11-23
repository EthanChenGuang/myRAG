import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { NextRequest } from 'next/server';
import { spawnSync } from 'node:child_process';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel } from 'ai';
import { GoldenItemSchema, RagTraceSchema, RunManifestSchema, type GoldenItem, type RagRunRequest, type RunManifest } from '../../src/lib/rag-eval/contracts.generated.ts';
import { canonicalJson, configHash } from '../../src/lib/rag-eval/trace.ts';
import { loadPinnedEvalEnv } from './eval-env.mts';
import { EMBEDDER_ID, EMBEDDER_VERSION, embedderSourceSha256 } from './fixture-embedder.mts';
import { createFixtureDatabase, type DeploymentMode } from './pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from './fake-edge.mts';

export type EvalTier = 'smoke' | 'nightly' | 'live';

export interface EvalRequestOptions {
  max_results?: number | null;
  organization_id?: string | null;
  user_id?: string | null;
  generator_model?: string | null;
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
  requestOptions?: EvalRequestOptions;
  tier?: EvalTier;
  baseUrl?: string;
  includeAnswer?: boolean;
  generator?: EvalGenerator;
}

export interface RunEvalResult {
  tracesPath: string;
  logPath: string;
  itemCount: number;
  tier: EvalTier;
  deploymentMode: DeploymentMode;
  edgeErrors: number;
  runPath: string;
  manifest: RunManifest;
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

type MutableEnv = Record<string, string | undefined>;

export async function prepareInProcessEval(options: { corpusDir: string; deploymentMode: DeploymentMode }): Promise<InProcessEval> {
  const { corpusDir, deploymentMode } = options;
  const fixture = await createFixtureDatabase({ deploymentMode, corpusDir });
  let edge: FakeEdge | undefined;
  try {
    edge = await startFakeEdge({ db: fixture.db });
  } catch (error) {
    await fixture.db.close().catch(() => undefined);
    throw error;
  }
  const startedEdge = edge;

  const env = process.env as MutableEnv;
  for (const name of Object.keys(env)) {
    if (name.startsWith('RAG_') || name.startsWith('NEXT_PUBLIC_RAG_')) delete env[name];
  }
  Object.assign(env, loadPinnedEvalEnv());
  Object.assign(env, fixtureProcessEnv(startedEdge.url));
  const secret = crypto.randomBytes(24).toString('hex');
  env.NODE_ENV = 'test';
  env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = deploymentMode;
  env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
  env.RAG_EVAL_SECRET = secret;

  const route = await import('../../src/app/api/internal/rag/run/route.ts');

  return {
    POST: route.POST as unknown as InProcessEval['POST'],
    secret,
    edge: startedEdge,
    fixtureUserId: fixture.fixtureUserId,
    corpusSha256: fixture.corpusSha256,
    sqlSha256: fixture.sqlSha256,
    close: async () => {
      await startedEdge.close();
      await fixture.db.close().catch(() => undefined);
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
  const { goldenPath, corpusDir, outDir, deploymentMode, tier = 'smoke', baseUrl, includeAnswer = false, generator } = options;
  const requestOptions: EvalRequestOptions = { ...(options.requestOptions ?? {}) };

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

  const items = readGolden(goldenPath);
  fs.mkdirSync(outDir, { recursive: true });
  const tracesPath = path.join(outDir, 'traces.jsonl');
  const logPath = path.join(outDir, 'harness.log');
  fs.writeFileSync(tracesPath, '');
  fs.writeFileSync(logPath, '');

  let httpSecret = '';
  if (baseUrl) {
    httpSecret = process.env.RAG_EVAL_SECRET ?? '';
    if (!httpSecret) throw new Error('[Eval Harness] RAG_EVAL_SECRET must be set for --base-url runs');
  }

  const restoreConsole = redirectConsole(logPath);
  let inProcess: InProcessEval | undefined;
  let answerModule: typeof import('../../src/lib/rag-eval/answer.ts') | undefined;
  let edgeErrors = 0;
  let firstEffectiveConfig: unknown = null;
  let manifestInputs: { corpusSha256: string | null; sqlSha256: Record<string, string> } = { corpusSha256: null, sqlSha256: {} };
  try {
    let send: (payload: RagRunRequest) => Promise<{ status: number; body: unknown }>;
    if (baseUrl) {
      const url = `${baseUrl.replace(/\/+$/, '')}${ROUTE_PATH}`;
      send = async (payload) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rag-eval-secret': httpSecret },
          body: JSON.stringify(payload),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
    } else {
      const prepared = await prepareInProcessEval({ corpusDir, deploymentMode });
      inProcess = prepared;
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
        const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
          body: JSON.stringify(payload),
        });
        const res = await prepared.POST(req);
        return { status: res.status, body: await res.json().catch(() => null) };
      };
    }

    for (const item of items) {
      const options: EvalRequestOptions = { ...requestOptions };
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
      if (firstEffectiveConfig === null) firstEffectiveConfig = trace.effective_config;
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
    if (inProcess) await inProcess.close();
  }

  const normalizedOptions = {
    max_results: requestOptions.max_results ?? null,
    organization_id: requestOptions.organization_id ?? null,
    user_id: requestOptions.user_id ?? null,
    ...(includeAnswer ? { generator_model: requestOptions.generator_model ?? null } : {}),
  };
  const embedder = baseUrl
    ? null
    : { id: EMBEDDER_ID, version: String(EMBEDDER_VERSION), source_sha256: embedderSourceSha256() };
  const goldenSha256 = sha256File(goldenPath);
  const effectiveConfigHash = configHash(firstEffectiveConfig);
  const runConfigHash = crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        effective_config_hash: effectiveConfigHash,
        embedder,
        corpus_sha256: manifestInputs.corpusSha256,
        golden_sha256: goldenSha256,
        sql_sha256: manifestInputs.sqlSha256,
        request_options: normalizedOptions,
        deployment_mode: deploymentMode,
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
    deployment_mode: deploymentMode,
    embedder,
    corpus_sha256: manifestInputs.corpusSha256,
    golden_path: path.relative(process.cwd(), goldenPath) || goldenPath,
    golden_sha256: goldenSha256,
    sql_sha256: manifestInputs.sqlSha256,
    request_options: normalizedOptions,
    effective_config_hash: effectiveConfigHash,
    run_config_hash: runConfigHash,
    item_count: items.length,
    edge_errors: edgeErrors,
  });
  const runPath = path.join(outDir, 'run.json');
  fs.writeFileSync(runPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { tracesPath, logPath, itemCount: items.length, tier, deploymentMode, edgeErrors, runPath, manifest };
}
