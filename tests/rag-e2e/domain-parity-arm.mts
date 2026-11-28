/**
 * One arm of the domain-embedding off-parity test (plan 03.1.1-14), run in its own process because the app reads part of its
 * environment at import time. Usage: node --import tsx tests/rag-e2e/domain-parity-arm.mts <prechunked|ingest> <outDir> <envJson>
 *
 * The arm runs the smoke golden set in process with the given app variables, like `npm run test-rag`, and records every outbound
 * fetch (URL and the JSON body's `model`) to <outDir>/fetch-spy.json, so the parent can prove no domain vendor model was called.
 * The variables reach retrieval; the ingest fixture build keeps its pinned ingest env (INGEST_MODE_FEATURE_ENV), as in every smoke run.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [fixtureMode, outArg, envJson] = process.argv.slice(2);
if ((fixtureMode !== 'prechunked' && fixtureMode !== 'ingest') || !outArg || !envJson) {
  console.error('usage: domain-parity-arm.mts <prechunked|ingest> <outDir> <envJson>');
  process.exit(2);
}
const appEnv = JSON.parse(envJson) as Record<string, string>;
const outDir = path.resolve(outArg);
fs.mkdirSync(outDir, { recursive: true });

interface SpiedRequest {
  url: string;
  model: string | null;
}
const spied: SpiedRequest[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let model: string | null = null;
  if (typeof init?.body === 'string') {
    try {
      const parsed = JSON.parse(init.body) as { model?: unknown };
      if (typeof parsed.model === 'string') model = parsed.model;
    } catch {
      // not JSON
    }
  }
  spied.push({ url, model });
  return realFetch(input, init);
}) as typeof fetch;

const REPO_ROOT = process.cwd();
if (!process.env.RAG_EVAL_SECRET || process.env.RAG_EVAL_SECRET.length < 32) process.env.RAG_EVAL_SECRET = crypto.randomBytes(24).toString('hex');

const { ingestModeGoldenPaths, mergeGoldenFiles } = await import('../../eval/harness/ingest-mode.mts');
const { dropTableSplitItems } = await import('../../eval/harness/table-split.mts');
const { runEval } = await import('../../eval/harness/run-eval.mts');

const corpusDir = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const goldenFiles = (fixtureMode === 'ingest' ? ingestModeGoldenPaths() : ['eval/fixtures/golden.jsonl']).map((file) => path.resolve(REPO_ROOT, file));
const merged = mergeGoldenFiles(goldenFiles, path.join(outDir, 'golden.merged.jsonl'));
const goldenPath = fixtureMode === 'ingest' ? merged : dropTableSplitItems(merged, path.join(outDir, 'golden.no-table-split.jsonl'));

let code = 0;
try {
  const result = await runEval({
    goldenPath,
    corpusDir,
    outDir,
    deploymentMode: 'single-tenant',
    fixtureMode,
    tier: 'smoke',
    appEnv,
  });
  fs.writeFileSync(
    path.join(outDir, 'arm.json'),
    `${JSON.stringify({ tracesPath: result.tracesPath, runPath: result.runPath, goldenPath, itemCount: result.itemCount, edgeErrors: result.edgeErrors }, null, 2)}\n`,
  );
} catch (error) {
  console.error(`[Domain Parity] arm failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  code = 3;
} finally {
  fs.writeFileSync(path.join(outDir, 'fetch-spy.json'), `${JSON.stringify(spied, null, 2)}\n`);
}
process.exit(code);
