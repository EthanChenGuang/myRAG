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

async function installHarnessEmbeddingProviders(): Promise<void> {
  const registry = await import('../../src/lib/rag/embeddings/registry');
  registry.setEmbeddingProvidersForTests({
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

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      out: { type: 'string', default: 'eval/out/compare' },
      corpus: { type: 'string', default: 'eval/fixtures/corpus' },
    },
    strict: true,
  });
  const VOYAGE = 'voyage-4-large-2048';
  const target = values.target?.trim() || VOYAGE;
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

  let runId = '';
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
      const started = await writer.start({ profileId: target, tenantKey: null, actor: 'profile-compare-harness', derivedFrom: null });
      runId = started.runId;
    },
  });

  const ingestEdge = full.buildState.edge;
  const { fixtureAdminClient } = await import('./ingest-fakes.mts');
  const { runReembed } = await import('../../src/lib/rag/ingest/reembed/run.ts');
  const backfill = await runReembed({
    db: fixtureAdminClient(ingestEdge.url),
    resumeRunId: runId,
    batchSize: 16,
    signal: new AbortController().signal,
  });
  if (!runId) runId = backfill.runId;

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
  if (backfill.status !== 'completed') {
    throw new Error(`re-embed for ${target} failed: ${backfill.reason ?? 'unknown'}`);
  }

  const goldenPath = mergeGoldenFiles(
    ingestModeGoldenPaths().map((file) => path.join(REPO_ROOT, file)),
    path.join(outDir, 'golden.merged.jsonl'),
  );

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
    const targetGated = await runProfileEval({ outDir: path.join(outDir, 'target-gated'), embeddingProfileId: target });
    const targetCandidate = await runProfileEval({
      outDir: path.join(outDir, 'target-candidate'),
      embeddingProfileId: target,
      candidateMetrics: true,
    });

    const preMigration = path.join(outDir, 'pre-migration.json');
    fs.writeFileSync(preMigration, JSON.stringify({ run_id: runId, corpus_documents_before_run: half }, null, 2));

    return runPython('rag_eval.profile_compare_cli', [
      '--active-gated',
      activeGated,
      '--active-candidate',
      activeCandidate,
      '--target-gated',
      targetGated,
      '--target-candidate',
      targetCandidate,
      '--target-profile',
      target,
      '--noise',
      NOISE_PATH,
      '--pre-migration-meta',
      preMigration,
      '--backfill-run-id',
      runId,
      '--out',
      path.join(outDir, 'comparison.json'),
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