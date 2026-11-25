import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LiveGenerationKeyMissingError, runEval, type EvalGenerator } from './run-eval.mts';
import type { DeploymentMode } from './pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function validateWithPydantic(model: string, flag: '--jsonl' | '--json', file: string): number {
  const result = spawnSync(
    'uv',
    ['run', '--project', path.join(REPO_ROOT, 'rag-sidecar'), 'python', '-m', 'rag_sidecar.contracts.validate', '--model', model, flag, path.resolve(file)],
    { stdio: 'inherit', cwd: REPO_ROOT },
  );
  if (result.error) throw result.error;
  return result.status ?? 3;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      generator: { type: 'string', default: 'live' },
      golden: { type: 'string', default: 'eval/fixtures/golden.jsonl' },
      corpus: { type: 'string', default: 'eval/fixtures/corpus' },
      out: { type: 'string', default: 'eval/out/nightly' },
      'generator-model': { type: 'string' },
      'deployment-mode': { type: 'string', default: 'single-tenant' },
      'include-drafts': { type: 'boolean', default: false },
      citations: { type: 'boolean', default: false },
      groundedness: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const generator = values.generator;
  if (generator !== 'stub' && generator !== 'live') {
    throw new Error(`--generator must be stub or live, got ${String(generator)}`);
  }
  const deploymentMode = values['deployment-mode'];
  if (deploymentMode !== 'single-tenant' && deploymentMode !== 'multi-tenant') {
    throw new Error(`--deployment-mode must be single-tenant or multi-tenant, got ${String(deploymentMode)}`);
  }

  const goldenPath = path.resolve(values.golden as string);
  const goldenCode = validateWithPydantic('GoldenItem', '--jsonl', goldenPath);
  if (goldenCode !== 0) {
    console.error('[Eval Harness] golden file failed Pydantic validation; nothing was run');
    return 2;
  }

  let result;
  try {
    result = await runEval({
      goldenPath,
      corpusDir: path.resolve(values.corpus as string),
      outDir: path.resolve(values.out as string),
      deploymentMode: deploymentMode as DeploymentMode,
      requestOptions: values['generator-model'] ? { generator_model: values['generator-model'] } : {},
      tier: 'nightly',
      includeAnswer: true,
      generator: generator as EvalGenerator,
      includeDrafts: values['include-drafts'],
      // D-24: the judge tier compares Faithfulness per citation strategy; groundedness is scored against the fake sidecar.
      ...(values.citations ? { citations: true } : {}),
      ...(values.groundedness ? { groundedness: true } : {}),
    });
  } catch (error) {
    if (error instanceof LiveGenerationKeyMissingError) {
      console.error(error.message);
      return 4;
    }
    throw error;
  }

  console.log(`[Eval Harness] wrote ${result.itemCount} nightly trace(s) to ${result.tracesPath}`);

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
