import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config as loadDotenv } from 'dotenv';

/**
 * XLG-04, D-31: two eval runs over the same fixture tenant with the fixture translator, differing only in RAG_DOC_TRANSLATION and the
 * tenant's translation setting. Arm A: query translation alone (RAG_LEXICAL_TRANSLATION=true). Arm B: plus the stored chunk translations.
 * The producer translates the fixture tenant between the build and the runs; its rows, bytes, estimated cost and wall time are the
 * cost columns. A fixture run is wiring proof only (rag_eval.translation_compare labels it and prints no recommendation).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
loadDotenv({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });

const TENANT = 's:default';
const TRANSLATION_TABLE_PATH = path.join(REPO_ROOT, 'eval/fixtures/translation-table.json');

function runPython(module: string, args: string[]): number {
  const result = spawnSync('uv', ['run', '--directory', path.join(REPO_ROOT, 'eval'), 'python', '-m', module, ...args], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 3;
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

interface DirectionCost {
  rows: number;
  bytes: number;
  usd: number;
  ingestion_seconds: number;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'eval/out/translation-compare' },
      corpus: { type: 'string', default: 'eval/fixtures/corpus' },
    },
    strict: true,
  });
  const outDir = path.resolve(values.out as string);
  fs.mkdirSync(outDir, { recursive: true });
  seedHarnessEnv();

  const ingestMode = await import('./ingest-mode.mts');
  const runEvalModule = await import('./run-eval.mts');
  const corpusDir = path.resolve(values.corpus as string);
  const full = await ingestMode.buildIngestFixtureDatabase({
    deploymentMode: 'single-tenant',
    corpusDir,
    includeTypedFixtures: true,
    processEnv: { RAG_LANGUAGE_AWARE_INGEST: 'on', RAG_EVAL_SECRET: process.env.RAG_EVAL_SECRET! },
  });
  const edge = full.buildState.edge;

  const { applyFixtureProcessEnv } = await import('./process-env.mts');
  applyFixtureProcessEnv({ edgeUrl: edge.url, deploymentMode: 'single-tenant', extra: { RAG_EVAL_SECRET: process.env.RAG_EVAL_SECRET! } });
  const { fixtureAdminClient } = await import('./ingest-fakes.mts');
  const ingestDeps = await import('../../src/lib/rag/ingest/deps.ts');
  const translator = await import('../../src/lib/rag/ingest/translate/translator.ts');
  const produce = await import('../../src/lib/rag/ingest/translate/produce.ts');
  const baseIngestEnv = ingestDeps.getIngestDeps().ingestEnv();
  ingestDeps.setIngestDepsForTests({
    db: () => fixtureAdminClient(edge.url),
    ingestEnv: () => ({ ...baseIngestEnv, RAG_DOC_TRANSLATION: 'on', RAG_LANGUAGE_AWARE_INGEST: 'on' }),
  });
  translator.setChunkTranslationModelForTests(
    translator.createFixtureChunkTranslationModel(JSON.parse(fs.readFileSync(TRANSLATION_TABLE_PATH, 'utf8'))),
  );

  const targets = ['zh', 'en', 'it'];
  await full.db.query(
    'INSERT INTO rag_translation_settings (tenant_key, target_languages, enabled) VALUES ($1, $2::text[], true) ON CONFLICT (tenant_key) DO UPDATE SET target_languages = EXCLUDED.target_languages, enabled = true',
    [TENANT, targets],
  );

  const estimate = await produce.estimateTranslation(TENANT);
  const startedAt = Date.now();
  const run = await produce.translatePending(TENANT, { budgetMs: 10 * 60 * 1000 });
  const seconds = (Date.now() - startedAt) / 1000;
  if (!run.ok) throw new Error(`translation refused: ${run.reason}`);

  const rows = await full.db.query<{ source: string; target: string; rows: number; bytes: number }>(
    `SELECT c.language AS source, t.language AS target, count(*)::int AS rows, COALESCE(sum(octet_length(t.content)), 0)::int AS bytes
       FROM chunk_translations t JOIN document_chunks c ON c.id = t.chunk_id
      WHERE t.tenant_key = $1 GROUP BY c.language, t.language ORDER BY 1, 2`,
    [TENANT],
  );
  const totalRows = rows.rows.reduce((sum, row) => sum + row.rows, 0);
  const usdByTarget = new Map(estimate.ok ? estimate.languages.map((entry) => [entry.language, entry.estimatedUsd]) : []);
  const rowsByTarget = new Map<string, number>();
  for (const row of rows.rows) rowsByTarget.set(row.target, (rowsByTarget.get(row.target) ?? 0) + row.rows);
  const byDirection: Record<string, DirectionCost> = {};
  for (const row of rows.rows) {
    const share = (rowsByTarget.get(row.target) ?? 0) > 0 ? row.rows / rowsByTarget.get(row.target)! : 0;
    byDirection[`${row.source}->${row.target}`] = {
      rows: row.rows,
      bytes: row.bytes,
      usd: Math.round((usdByTarget.get(row.target) ?? 0) * share * 10000) / 10000,
      ingestion_seconds: totalRows > 0 ? Math.round(seconds * (row.rows / totalRows) * 1000) / 1000 : 0,
    };
  }
  const costPath = path.join(outDir, 'cost.json');
  fs.writeFileSync(costPath, `${JSON.stringify({ by_direction: byDirection, translator: 'fixture-translator' }, null, 2)}\n`);
  console.log('[Translation Compare] translated', { translated: run.translated, gaps: run.gaps, rows: totalRows });

  const mergedPath = ingestMode.mergeGoldenFiles(
    ingestMode.ingestModeGoldenPaths().map((file: string) => path.join(REPO_ROOT, file)),
    path.join(outDir, 'golden.merged.jsonl'),
  );
  // The table_split tenants are not part of this comparison; their items need a separately loaded session.
  const { isTableSplitItem } = await import('./table-split.mts');
  const goldenPath = path.join(outDir, 'golden.jsonl');
  const kept = fs
    .readFileSync(mergedPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !isTableSplitItem(JSON.parse(line) as { category: string }));
  fs.writeFileSync(goldenPath, `${kept.join('\n')}\n`);
  const inProcess = await runEvalModule.prepareInProcessEval({
    corpusDir,
    deploymentMode: 'single-tenant',
    fixtureMode: 'ingest',
    ingestFixture: full,
    envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_TRANSLATION: 'true' },
  });
  const configModule = await import('../../src/lib/rag/config.ts');

  async function arm(name: 'arm-a' | 'arm-b', docTranslation: 'off' | 'on'): Promise<string> {
    process.env.RAG_DOC_TRANSLATION = docTranslation;
    configModule.resetRagConfigForTests();
    const armDir = path.join(outDir, name);
    const result = await runEvalModule.runEval({
      goldenPath,
      corpusDir,
      outDir: armDir,
      deploymentMode: 'single-tenant',
      fixtureMode: 'ingest',
      tier: 'smoke',
      ingestFixture: full,
      retainInProcess: inProcess,
    });
    const code = runPython('rag_eval.runner', [
      'score',
      '--traces',
      result.tracesPath,
      '--golden',
      goldenPath,
      '--manifest',
      result.runPath,
      '--out',
      armDir,
    ]);
    if (code !== 0) throw new Error(`scoring failed for ${name}`);
    return path.join(armDir, 'report.json');
  }

  try {
    const armA = await arm('arm-a', 'off');
    const armB = await arm('arm-b', 'on');
    return runPython('rag_eval.translation_compare', [
      '--arm-a',
      armA,
      '--arm-b',
      armB,
      '--cost',
      costPath,
      '--noise',
      path.join(REPO_ROOT, 'eval/config/noise.json'),
      '--out',
      outDir,
    ]);
  } finally {
    delete process.env.RAG_DOC_TRANSLATION;
    translator.resetChunkTranslationModelForTests();
    ingestDeps.resetIngestDepsForTests();
    await inProcess.close();
    await full.db.close().catch(() => undefined);
    await full.edge?.close().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[Translation Compare] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  },
);
