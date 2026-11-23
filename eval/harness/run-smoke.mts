import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runEval } from './run-eval.mts';
import type { DeploymentMode } from './pglite-supabase.mts';

function validateWithPydantic(model: string, flag: '--jsonl' | '--json', file: string): number {
  const result = spawnSync(
    'uv',
    ['run', '--project', 'rag-sidecar', 'python', '-m', 'rag_sidecar.contracts.validate', '--model', model, flag, file],
    { stdio: 'inherit' },
  );
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

  const result = await runEval({
    goldenPath: path.resolve(values.golden as string),
    corpusDir: path.resolve(values.corpus as string),
    outDir: path.resolve(values.out as string),
    deploymentMode: deploymentMode as DeploymentMode,
    requestOptions: maxResults === undefined ? {} : { max_results: maxResults },
    tier: 'smoke',
    baseUrl: values['base-url'],
  });

  console.log(`[Eval Harness] wrote ${result.itemCount} trace(s) to ${result.tracesPath}`);

  const traceCode = validateWithPydantic('RagTrace', '--jsonl', result.tracesPath);
  if (traceCode !== 0) return traceCode;
  return validateWithPydantic('RunManifest', '--json', result.runPath);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[Eval Harness] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  },
);
