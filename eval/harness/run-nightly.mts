import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LiveGenerationKeyMissingError, runEval, type EvalGenerator } from './run-eval.mts';
import { injectionGoldenLines, planSecNightly, secZeroFailures, type InjectionReportLike, type SecNightlyLeg } from './nightly-sec.mts';
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

function runPython(module: string, args: string[]): number {
  const result = spawnSync('uv', ['run', '--directory', path.join(REPO_ROOT, 'eval'), 'python', '-m', module, ...args], { stdio: 'inherit', cwd: REPO_ROOT });
  if (result.error) throw result.error;
  return result.status ?? 3;
}

const SEC_LEG_NAMES: ReadonlySet<string> = new Set(['tagging_only', 'recommended', 'recommended_prompt_guard', 'recommended_lakera']);

/** One SEC leg in its own process (the app modules keep the env they saw at first import): injection items, real answers, scored. */
async function runSecLeg(leg: SecNightlyLeg, options: { generator: EvalGenerator; goldenPath: string; corpusDir: string; outDir: string; deploymentMode: DeploymentMode; generatorModel?: string }): Promise<number> {
  fs.mkdirSync(options.outDir, { recursive: true });
  const goldenPath = path.join(options.outDir, 'golden.injection.jsonl');
  fs.writeFileSync(goldenPath, `${injectionGoldenLines(fs.readFileSync(options.goldenPath, 'utf8')).join('\n')}\n`);
  const result = await runEval({
    goldenPath,
    corpusDir: options.corpusDir,
    outDir: options.outDir,
    deploymentMode: options.deploymentMode,
    requestOptions: options.generatorModel ? { generator_model: options.generatorModel } : {},
    tier: 'nightly',
    includeAnswer: true,
    generator: options.generator,
    runConfig: leg.runConfig,
    ...(Object.keys(leg.appEnv).length > 0 ? { appEnv: leg.appEnv } : {}),
  });
  console.log(`[Eval Harness] SEC ${leg.name}: wrote ${result.itemCount} trace(s) to ${result.tracesPath}`);
  const traceCode = validateWithPydantic('RagTrace', '--jsonl', result.tracesPath);
  if (traceCode !== 0) return traceCode;
  return runPython('rag_eval.runner', ['score', '--traces', result.tracesPath, '--golden', goldenPath, '--manifest', result.runPath, '--out', options.outDir]);
}

interface SecLegSummary {
  leg: string;
  gated: boolean;
  exit_code: number;
  config_label: string | null;
  attack_success_rate: Record<string, number | null>;
  exposure_rate: Record<string, number | null>;
  rules_false_positive_count: number | null;
  zero_failures: string[];
}

function readInjection(outDir: string): (InjectionReportLike & { exposure_rate: InjectionReportLike['attack_success_rate'] }) | null {
  const file = path.join(outDir, 'report.json');
  if (!fs.existsSync(file)) return null;
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { injection?: never }).injection ?? null;
}

function pick(rates: InjectionReportLike['attack_success_rate'] | undefined): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const key of ['category:injection', 'category:injection_evasive', 'overall']) out[key] = rates?.[key]?.value ?? null;
  return out;
}

/** D-14, A-13: every planned leg runs; only the recommended leg is gated at 0, the others are reported in sec-summary.json. */
function runSecMatrix(argv: { generator: string; golden: string; corpus: string; out: string; deploymentMode: string; generatorModel?: string }): number {
  const plan = planSecNightly();
  for (const notice of plan.notices) console.log(notice);
  const summaries: SecLegSummary[] = [];
  let failed = false;
  for (const leg of plan.legs) {
    const outDir = path.join(argv.out, leg.name);
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(import.meta.url),
        '--sec-leg',
        leg.name,
        '--generator',
        argv.generator,
        '--golden',
        argv.golden,
        '--corpus',
        argv.corpus,
        '--deployment-mode',
        argv.deploymentMode,
        '--out',
        outDir,
        ...(argv.generatorModel ? ['--generator-model', argv.generatorModel] : []),
      ],
      { stdio: 'inherit', cwd: REPO_ROOT },
    );
    const exitCode = child.status ?? 3;
    if (exitCode === 4) return 4;
    const injection = exitCode === 0 ? readInjection(outDir) : null;
    const zeroFailures = leg.gated ? (exitCode === 0 ? secZeroFailures(injection) : [`run failed with exit code ${exitCode}`]) : [];
    if (exitCode !== 0 || zeroFailures.length > 0) failed = true;
    summaries.push({
      leg: leg.name,
      gated: leg.gated,
      exit_code: exitCode,
      config_label: injection?.config_label ?? null,
      attack_success_rate: pick(injection?.attack_success_rate),
      exposure_rate: pick(injection?.exposure_rate),
      rules_false_positive_count: injection?.rules_false_positive_count ?? null,
      zero_failures: zeroFailures,
    });
    const verdict = leg.gated ? (zeroFailures.length === 0 && exitCode === 0 ? 'PASS (absolute zero)' : `FAIL: ${zeroFailures.join('; ')}`) : 'reported';
    console.log(`[Eval Harness] SEC ${leg.name}: ${verdict}`);
  }
  fs.mkdirSync(argv.out, { recursive: true });
  fs.writeFileSync(path.join(argv.out, 'sec-summary.json'), `${JSON.stringify({ legs: summaries, notices: plan.notices }, null, 2)}\n`);
  return failed ? 1 : 0;
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
      'sec-matrix': { type: 'boolean', default: false },
      'sec-leg': { type: 'string' },
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

  if (values['sec-matrix'] || values['sec-leg'] !== undefined) {
    if (values.citations || values.groundedness || values['include-drafts']) {
      throw new Error('--sec-matrix runs the injection items only and takes no --citations, --groundedness or --include-drafts');
    }
  }
  if (values['sec-matrix']) {
    const goldenCheck = validateWithPydantic('GoldenItem', '--jsonl', path.resolve(values.golden as string));
    if (goldenCheck !== 0) {
      console.error('[Eval Harness] golden file failed Pydantic validation; nothing was run');
      return 2;
    }
    return runSecMatrix({
      generator,
      golden: path.resolve(values.golden as string),
      corpus: path.resolve(values.corpus as string),
      out: path.resolve(values.out === 'eval/out/nightly' ? 'eval/out/nightly-sec' : (values.out as string)),
      deploymentMode,
      ...(values['generator-model'] ? { generatorModel: values['generator-model'] } : {}),
    });
  }
  if (values['sec-leg'] !== undefined) {
    const legName = values['sec-leg'];
    if (!SEC_LEG_NAMES.has(legName)) throw new Error(`--sec-leg must be one of ${[...SEC_LEG_NAMES].join(', ')}`);
    const leg = planSecNightly().legs.find((entry) => entry.name === legName);
    if (!leg) {
      console.error(`[Eval Harness] SEC leg ${legName} has no prerequisites configured; nothing was run`);
      return 2;
    }
    try {
      return await runSecLeg(leg, {
        generator: generator as EvalGenerator,
        goldenPath: path.resolve(values.golden as string),
        corpusDir: path.resolve(values.corpus as string),
        outDir: path.resolve(values.out as string),
        deploymentMode: deploymentMode as DeploymentMode,
        ...(values['generator-model'] ? { generatorModel: values['generator-model'] } : {}),
      });
    } catch (error) {
      if (error instanceof LiveGenerationKeyMissingError) {
        console.error(error.message);
        return 4;
      }
      throw error;
    }
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
