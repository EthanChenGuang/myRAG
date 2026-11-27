import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config as loadDotenv } from 'dotenv';
import type { IngestFixtureBuildState } from './ingest-mode.mts';
import type { EvalRequestOptions } from './run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
loadDotenv({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });

function runPython(module: string, args: string[]): number {
  const result = spawnSync('uv', ['run', '--directory', path.join(REPO_ROOT, 'eval'), 'python', '-m', module, ...args], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `/home/ubuntu/.local/bin:${process.env.PATH ?? ''}` },
  });
  if (result.error) throw result.error;
  return result.status ?? 3;
}

function padded(vector: number[], dims: number): number[] {
  return [...vector, ...new Array<number>(Math.max(0, dims - vector.length)).fill(0)];
}

function seedHarnessEnv(): void {
  for (const [name, value] of Object.entries({
    OPENAI_API_KEY: 'test-openai-key-placeholder',
    OPENROUTER_API_KEY: 'sk-or-abcdefghijklmnopqrstuvwxyzabcdef',
    RAG_EVAL_SECRET: crypto.randomBytes(24).toString('hex'),
    RAG_EVAL_ENDPOINT_ENABLED: 'true',
    NODE_ENV: 'test',
  })) {
    if (!process.env[name]) process.env[name] = value;
  }
}

const VOYAGE = 'voyage-4-large-2048';
const BGE_M3 = 'bge-m3-1024';
const BGE_M3_FIXTURE_HOST = 'fixture-bge-m3';
type ServingMode = 'hosted' | 'sidecar';

interface ServingMeasurement {
  mode: ServingMode;
  measured: boolean;
  source?: string;
  ingest_chunks_per_second?: number | null;
  query_embed_p50_ms?: number | null;
  query_embed_p95_ms?: number | null;
  usd_per_million_tokens?: number | null;
  run_tokens?: number | null;
  run_cost_usd?: number | null;
}

async function installHarnessEmbeddingProviders(): Promise<void> {
  const registry = await import('../../src/lib/rag/embeddings/registry');
  const { BGE_M3_MODEL_ID } = await import('../../src/lib/rag/embeddings/types');
  registry.setEmbeddingProvidersForTests({
    'bge-m3': {
      id: 'bge-m3',
      model: BGE_M3_MODEL_ID,
      maxInputTokens: 8192,
      supportedDims: [1024],
      normalize: true,
      async embedDocuments(texts, opts) {
        const { embedText } = await import('./fixture-embedder.mts');
        return {
          vectors: texts.map((text) => embedText(text, opts.dims)),
          model: BGE_M3_MODEL_ID,
          host: BGE_M3_FIXTURE_HOST,
          usage: { tokens: texts.length },
        };
      },
      async embedQuery(text, opts) {
        const { embedText } = await import('./fixture-embedder.mts');
        return { vectors: [embedText(text, opts.dims)], model: BGE_M3_MODEL_ID, host: BGE_M3_FIXTURE_HOST, usage: { tokens: 1 } };
      },
    },
    voyage: {
      id: 'voyage',
      model: 'voyage-4-large',
      maxInputTokens: 8000,
      supportedDims: [1024, 2048],
      normalize: true,
      async embedDocuments(texts, opts) {
        const { embedText } = await import('./fixture-embedder.mts');
        return {
          vectors: texts.map((text) => padded(embedText(text), opts.dims)),
          model: 'voyage-4-large',
          host: 'fake-host',
          usage: { tokens: texts.length },
        };
      },
      async embedQuery(text, opts) {
        const { embedText } = await import('./fixture-embedder.mts');
        return {
          vectors: [padded(embedText(text), opts.dims)],
          model: 'voyage-4-large',
          host: 'fake-host',
          usage: { tokens: 1 },
        };
      },
    },
  });
}

/**
 * The fixture run measures the serving mode RAG_BGE_M3_SERVING selects, with the fixture embedder standing in for it; the other mode is
 * reported unmeasured. Live figures for both modes are plan 03.2.1-05.
 */
async function bgeM3Serving(
  backfill: { chunks: number; tokens: number; seconds: number },
  gatedReportPath: string,
): Promise<ServingMeasurement[]> {
  const { priceFor } = await import('../../src/lib/rag/embeddings/prices');
  const price = priceFor('bge-m3').usdPerMillionTokens;
  const report = JSON.parse(fs.readFileSync(gatedReportPath, 'utf8')) as { latency?: Record<string, { p50_ms: number; p95_ms: number }> | null };
  const embed = report.latency?.embed ?? null;
  const measuredMode: ServingMode = process.env.RAG_BGE_M3_SERVING === 'sidecar' ? 'sidecar' : 'hosted';
  const measured: ServingMeasurement = {
    mode: measuredMode,
    measured: true,
    source: 'fixture embedder',
    ingest_chunks_per_second: backfill.seconds > 0 ? Number((backfill.chunks / backfill.seconds).toFixed(3)) : null,
    query_embed_p50_ms: embed ? embed.p50_ms : null,
    query_embed_p95_ms: embed ? embed.p95_ms : null,
    usd_per_million_tokens: measuredMode === 'hosted' ? price : null,
    run_tokens: backfill.tokens,
    run_cost_usd: measuredMode === 'hosted' ? (backfill.tokens * price) / 1_000_000 : null,
  };
  return (['hosted', 'sidecar'] as const).map((mode) => (mode === measuredMode ? measured : { mode, measured: false }));
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', multiple: true },
      out: { type: 'string', default: 'eval/out/compare' },
      corpus: { type: 'string', default: 'eval/fixtures/corpus' },
    },
    strict: true,
  });
  const requested = (values.target ?? []).map((value) => value.trim()).filter(Boolean);
  const targets = [...new Set(requested.length > 0 ? requested : [VOYAGE, BGE_M3])];
  const outDir = path.resolve(values.out as string);
  fs.mkdirSync(outDir, { recursive: true });

  seedHarnessEnv();

  const ingestMode = await import('./ingest-mode.mts');
  const runEvalModule = await import('./run-eval.mts');
  const { mergeGoldenFiles, ingestModeGoldenPaths, buildIngestFixtureDatabase } = ingestMode;
  const { prepareInProcessEval, runEval } = runEvalModule;
  const NOISE_PATH = path.join(REPO_ROOT, 'eval/config/noise.json');

  const corpusDir = path.resolve(values.corpus as string);
  const { loadCorpus } = await import('./corpus.mts');
  const corpus = loadCorpus(corpusDir);
  const half = Math.ceil(corpus.documents.length / 2);

  const runIds = new Map<string, string>();
  const full = await buildIngestFixtureDatabase({
    deploymentMode: 'single-tenant',
    corpusDir,
    splitAtCorpusIndex: half,
    includeTypedFixtures: true,
    processEnv: { RAG_EMBEDDING_PROFILES: 'on', RAG_EVAL_SECRET: process.env.RAG_EVAL_SECRET! },
    onAfterCorpusSlice: async (state: IngestFixtureBuildState) => {
      await installHarnessEmbeddingProviders();
      const { fixtureAdminClient } = await import('./ingest-fakes.mts');
      const { createReembedWriter } = await import('../../src/lib/rag/ingest/writer.ts');
      const writer = createReembedWriter({ db: fixtureAdminClient(state.edge.url), signal: new AbortController().signal });
      for (const target of targets) {
        const started = await writer.start({ profileId: target, tenantKey: null, actor: 'profile-compare-harness', derivedFrom: null });
        runIds.set(target, started.runId);
      }
    },
  });

  const ingestEdge = full.buildState.edge;
  const { fixtureAdminClient } = await import('./ingest-fakes.mts');
  const { runReembed } = await import('../../src/lib/rag/ingest/reembed/run.ts');
  const backfills = new Map<string, { status: string; reason?: string | null; chunks: number; tokens: number; seconds: number }>();
  for (const target of targets) {
    const startedAt = performance.now();
    const backfill = await runReembed({
      db: fixtureAdminClient(ingestEdge.url),
      resumeRunId: runIds.get(target),
      batchSize: 16,
      signal: new AbortController().signal,
    });
    if (!runIds.get(target)) runIds.set(target, backfill.runId);
    backfills.set(target, {
      status: backfill.status,
      reason: backfill.reason,
      chunks: backfill.chunksEmbedded,
      tokens: backfill.tokens,
      seconds: (performance.now() - startedAt) / 1000,
    });
  }

  // Refresh RAG deps on the ingest edge before in-process eval (matches run-smoke fixture ordering).
  const { applyFixtureProcessEnv } = await import('./process-env.mts');
  applyFixtureProcessEnv({
    edgeUrl: ingestEdge.url,
    deploymentMode: 'single-tenant',
    extra: { RAG_EMBEDDING_PROFILES: 'on', RAG_EVAL_SECRET: process.env.RAG_EVAL_SECRET! },
    vendorEmbeddingRoutes: true,
  });
  const deps = await import('../../src/lib/rag/deps');
  deps.resetRagDepsForTests();
  for (const [target, backfill] of backfills) {
    if (backfill.status !== 'completed') {
      throw new Error(`re-embed for ${target} failed: ${backfill.reason ?? 'unknown'}`);
    }
  }

  const mergedPath = mergeGoldenFiles(
    ingestModeGoldenPaths().map((file) => path.join(REPO_ROOT, file)),
    path.join(outDir, 'golden.merged.jsonl'),
  );
  // The table_split tenants are not loaded by this one-database build; their items need a separately loaded session.
  const { isTableSplitItem } = await import('./table-split.mts');
  const goldenPath = path.join(outDir, 'golden.jsonl');
  const kept = fs
    .readFileSync(mergedPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !isTableSplitItem(JSON.parse(line) as { category: string }));
  fs.writeFileSync(goldenPath, `${kept.join('\n')}\n`);

  const inProcess = await prepareInProcessEval({
    corpusDir,
    deploymentMode: 'single-tenant',
    fixtureMode: 'ingest',
    ingestFixture: full,
  });

  async function runProfileEval(options: {
    outDir: string;
    embeddingProfileId?: string;
    candidateMetrics?: boolean;
  }): Promise<string> {
    const requestOptions: EvalRequestOptions = {};
    if (options.embeddingProfileId) requestOptions.embedding_profile = options.embeddingProfileId;
    if (options.candidateMetrics) requestOptions.disabled_stages = ['post_filter'];
    if (options.candidateMetrics) process.env.RAG_EVAL_RETRIEVAL_MIN_SIMILARITY = '-1';
    else delete process.env.RAG_EVAL_RETRIEVAL_MIN_SIMILARITY;
    process.env.RAG_EMBEDDING_PROFILES = 'on';

    const result = await runEval({
      goldenPath,
      corpusDir: path.join(REPO_ROOT, 'eval/fixtures/corpus'),
      outDir: options.outDir,
      deploymentMode: 'single-tenant',
      fixtureMode: 'ingest',
      requestOptions,
      tier: 'smoke',
      ingestFixture: full,
      retainInProcess: inProcess,
    });
    const rankFlag = options.candidateMetrics ? 'candidates' : 'kept';
    const scoreCode = runPython('rag_eval.runner', [
      'score',
      '--traces',
      result.tracesPath,
      '--golden',
      goldenPath,
      '--manifest',
      result.runPath,
      '--out',
      options.outDir,
      '--rank-source',
      rankFlag,
    ]);
    if (scoreCode !== 0) throw new Error(`scoring failed for ${options.outDir}`);
    return path.join(options.outDir, 'report.json');
  }

  try {
    const activeGated = await runProfileEval({ outDir: path.join(outDir, 'active-gated') });
    const activeCandidate = await runProfileEval({ outDir: path.join(outDir, 'active-candidate'), candidateMetrics: true });
    const armArgs: string[] = [];
    const serving: Record<string, ServingMeasurement[]> = {};
    for (const target of targets) {
      const gated = await runProfileEval({ outDir: path.join(outDir, `${target}-gated`), embeddingProfileId: target });
      const candidate = await runProfileEval({
        outDir: path.join(outDir, `${target}-candidate`),
        embeddingProfileId: target,
        candidateMetrics: true,
      });
      armArgs.push('--arm', target, gated, candidate);
      if (target === BGE_M3) serving[target] = await bgeM3Serving(backfills.get(target)!, gated);
    }

    const firstRunId = runIds.get(targets[0]!)!;
    const preMigration = path.join(outDir, 'pre-migration.json');
    fs.writeFileSync(
      preMigration,
      JSON.stringify({ run_id: firstRunId, run_ids: Object.fromEntries(runIds), corpus_documents_before_run: half }, null, 2),
    );
    const servingPath = path.join(outDir, 'serving.json');
    fs.writeFileSync(servingPath, JSON.stringify(serving, null, 2));

    return runPython('rag_eval.profile_compare_cli', [
      '--active-gated',
      activeGated,
      '--active-candidate',
      activeCandidate,
      ...armArgs,
      '--serving',
      servingPath,
      '--wiring-proof',
      '--noise',
      NOISE_PATH,
      '--pre-migration-meta',
      preMigration,
      '--backfill-run-id',
      firstRunId,
      '--out',
      path.join(outDir, 'comparison.json'),
      '--text-out',
      path.join(outDir, 'comparison.txt'),
    ]);
  } finally {
    await inProcess.close();
    await full.db.close().catch(() => undefined);
    await full.edge?.close().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[Profile Compare] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  },
);