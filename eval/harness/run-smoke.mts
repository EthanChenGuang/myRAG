import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runEval } from './run-eval.mts';
import type { DeploymentMode } from './pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BASELINE = path.join(REPO_ROOT, 'eval/baselines/fixture-baseline.json');
const NOISE_PATH = path.join(REPO_ROOT, 'eval/config/noise.json');

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
      golden: { type: 'string', default: 'eval/fixtures/golden.jsonl' },
      corpus: { type: 'string', default: 'eval/fixtures/corpus' },
      out: { type: 'string', default: 'eval/out/smoke' },
      'deployment-mode': { type: 'string', default: 'single-tenant' },
      'max-results': { type: 'string' },
      'base-url': { type: 'string' },
      'no-gate': { type: 'boolean', default: false },
      baseline: { type: 'string' },
    },
    strict: true,
  });

  const deploymentMode = values['deployment-mode'];
  if (deploymentMode !== 'single-tenant' && deploymentMode !== 'multi-tenant') {
    throw new Error(`--deployment-mode must be single-tenant or multi-tenant, got ${String(deploymentMode)}`);
  }

  let maxResults: number | undefined;
  if (values['max-results'] !== undefined) {
    maxResults = Number.parseInt(values['max-results'], 10);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
      throw new Error('--max-results must be an integer from 1 to 100');
    }
  }

  const gate = !values['no-gate'];
  const baseUrl = values['base-url'];
  if (gate && baseUrl && values.baseline === undefined) {
    console.error('[Eval Harness] a --base-url run needs --baseline <live baseline> or --no-gate');
    return 2;
  }
  const baselinePath = path.resolve(values.baseline ?? DEFAULT_BASELINE);

  const goldenPath = path.resolve(values.golden as string);
  const outDir = path.resolve(values.out as string);
  const result = await runEval({
    goldenPath,
    corpusDir: path.resolve(values.corpus as string),
    outDir,
    deploymentMode: deploymentMode as DeploymentMode,
    requestOptions: maxResults === undefined ? {} : { max_results: maxResults },
    tier: 'smoke',
    baseUrl,
  });

  console.log(`[Eval Harness] wrote ${result.itemCount} trace(s) to ${result.tracesPath}`);

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
    console.error(`[Eval Harness] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  },
);
