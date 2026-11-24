import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ingestModeGoldenPaths, mergeGoldenFiles } from './ingest-mode.mts';
import { runEval, type EvalRequestOptions } from './run-eval.mts';
import { loadRunConfig, RunConfigError } from './run-config.mts';
import type { DeploymentMode, FixtureMode } from './pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BASELINES: Record<FixtureMode, string> = {
  prechunked: path.join(REPO_ROOT, 'eval/baselines/fixture-baseline.json'),
  ingest: path.join(REPO_ROOT, 'eval/baselines/fixture-ingest-baseline.json'),
};
const DEFAULT_GOLDEN = 'eval/fixtures/golden.jsonl';
const NOISE_PATH = path.join(REPO_ROOT, 'eval/config/noise.json');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runPython(module: string, args: string[]): number {
  const result = spawnSync('uv', ['run', '--directory', path.join(REPO_ROOT, 'eval'), 'python', '-m', module, ...args], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (result.error) throw result.error;
  return result.status ?? 3;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      golden: { type: 'string' },
      corpus: { type: 'string', default: 'eval/fixtures/corpus' },
      'fixture-mode': { type: 'string', default: 'prechunked' },
      out: { type: 'string', default: 'eval/out/smoke' },
      'deployment-mode': { type: 'string', default: 'single-tenant' },
      'max-results': { type: 'string' },
      degrade: { type: 'string' },
      'base-url': { type: 'string' },
      'no-gate': { type: 'boolean', default: false },
      'embedding-profile': { type: 'string' },
      baseline: { type: 'string' },
      'include-drafts': { type: 'boolean', default: false },
      'run-config': { type: 'string' },
      org: { type: 'string' },
      user: { type: 'string' },
    },
    strict: true,
  });

  const deploymentMode = values['deployment-mode'];
  if (deploymentMode !== 'single-tenant' && deploymentMode !== 'multi-tenant') {
    throw new Error(`--deployment-mode must be single-tenant or multi-tenant, got ${String(deploymentMode)}`);
  }

  const fixtureMode = values['fixture-mode'];
  if (fixtureMode !== 'prechunked' && fixtureMode !== 'ingest') {
    throw new Error(`--fixture-mode must be prechunked or ingest, got ${String(fixtureMode)}`);
  }
  if (fixtureMode === 'ingest' && values['base-url']) {
    throw new Error('--fixture-mode ingest builds the fixture database itself and cannot be combined with --base-url');
  }

  let maxResults: number | undefined;
  if (values['max-results'] !== undefined) {
    maxResults = Number.parseInt(values['max-results'], 10);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
      throw new Error('--max-results must be an integer from 1 to 100');
    }
  }

  const embeddingProfileId = values['embedding-profile']?.trim();
  if (embeddingProfileId !== undefined && embeddingProfileId === '') {
    throw new Error('--embedding-profile must not be empty');
  }
  const baseUrl = values['base-url'];
  if (baseUrl && embeddingProfileId) {
    throw new Error('--embedding-profile is only supported for in-process fixture runs (omit --base-url)');
  }

  const runConfigFile = values['run-config']?.trim();
  if (runConfigFile !== undefined && runConfigFile === '') throw new RunConfigError('[Eval Harness] --run-config must not be empty');
  const runConfig = runConfigFile ? loadRunConfig(path.resolve(runConfigFile)) : undefined;
  if (runConfig && baseUrl && Object.keys(runConfig.env).length > 0) {
    throw new RunConfigError('[Eval Harness] a run-config env overlay applies to in-process runs only; omit --base-url or drop its env');
  }

  const requestOptions: EvalRequestOptions = {};
  if (maxResults !== undefined) requestOptions.max_results = maxResults;
  if (values.degrade !== undefined) {
    if (values.degrade !== 'drop_top_candidate') throw new Error('--degrade must be drop_top_candidate');
    requestOptions.degrade = values.degrade;
  }
  if (embeddingProfileId) requestOptions.embedding_profile = embeddingProfileId;
  for (const [flag, key] of [['org', 'organization_id'], ['user', 'user_id']] as const) {
    const value = values[flag]?.trim();
    if (value === undefined) continue;
    if (!UUID_RE.test(value)) throw new Error(`--${flag} must be a UUID`);
    requestOptions[key] = value.toLowerCase();
  }

  let gate = !values['no-gate'];
  if (embeddingProfileId) gate = false;
  if (gate && baseUrl && values.baseline === undefined) {
    console.error('[Eval Harness] a --base-url run needs --baseline <live baseline> or --no-gate');
    return 2;
  }
  const baselinePath = path.resolve(values.baseline ?? DEFAULT_BASELINES[fixtureMode]);

  const outDir = path.resolve(values.out as string);
  // Ingest mode scores the golden files it names itself unless --golden says otherwise, so its ingest-only items need no change here.
  const defaultGolden = fixtureMode === 'ingest' ? ingestModeGoldenPaths() : [DEFAULT_GOLDEN];
  const goldenFiles = values.golden !== undefined ? [path.resolve(values.golden)] : defaultGolden.map((file) => path.resolve(REPO_ROOT, file));
  const goldenPath = mergeGoldenFiles(goldenFiles, path.join(outDir, 'golden.merged.jsonl'));
  if (runPython('rag_sidecar.contracts.validate', ['--model', 'GoldenItem', '--jsonl', goldenPath]) !== 0) {
    console.error('[Eval Harness] golden file failed Pydantic validation; nothing was run');
    return 2;
  }
  const result = await runEval({
    goldenPath,
    corpusDir: path.resolve(values.corpus as string),
    outDir,
    deploymentMode: deploymentMode as DeploymentMode,
    fixtureMode,
    requestOptions,
    tier: baseUrl ? 'live' : 'smoke',
    baseUrl,
    includeDrafts: values['include-drafts'],
    embeddingProfileId,
    ...(runConfig ? { runConfig } : {}),
  });

  console.log(`[Eval Harness] wrote ${result.itemCount} trace(s) to ${result.tracesPath} (${result.skippedCount} golden item(s) not approved, skipped)`);

  const scoreCode = runPython('rag_eval.runner', [
    'score',
    '--traces',
    result.tracesPath,
    '--golden',
    goldenPath,
    '--manifest',
    result.runPath,
    '--out',
    outDir,
  ]);
  if (scoreCode !== 0) return scoreCode;
  console.log(`[Eval Harness] report: ${path.join(outDir, 'report.md')}`);

  if (!gate) return 0;

  const gateCode = runPython('rag_eval.gate', [
    '--report',
    path.join(outDir, 'report.json'),
    '--baseline',
    baselinePath,
    '--noise',
    NOISE_PATH,
    '--out',
    outDir,
  ]);
  console.log(`[Eval Harness] gate: ${path.join(outDir, 'gate.md')}`);
  return gateCode;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof RunConfigError) {
      console.error(error.message);
      if (error.names.length > 0) console.error(`[Eval Harness] not allowed in run-config env: ${error.names.join(', ')}`);
      process.exit(2);
    }
    console.error(`[Eval Harness] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  },
);
