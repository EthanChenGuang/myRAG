import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * Plan 03.2-66 (D-46): for each arm of eval/config/phase32-comparison.json, two fixture runs that differ only in that switch, then
 * rag_eval.phase_compare (schema 3) over the pair. An ingestion-side switch rebuilds the fixture tenant, so each run is its own child
 * process with its own ingest build; the switch reaches ingestion through the build's ingest env and is recorded in the retrieval env.
 * The doc_translation arm reuses run-translation-compare.mts (its arm A and arm B differ only in RAG_DOC_TRANSLATION); it is optional,
 * so its failure leaves the arm "not run" instead of failing the comparison. Fixture runs are wiring proof only.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC_PATH = path.join(REPO_ROOT, 'eval/config/phase32-comparison.json');
const SELF = fileURLToPath(import.meta.url);

interface ArmSpec {
  name: string;
  switch: string;
  off: string;
  on: string;
  side: 'ingestion' | 'query';
  fixture_mode?: 'ingest' | 'prechunked';
  runner?: 'smoke' | 'translation';
  optional?: boolean;
}

function runPython(module: string, args: string[]): number {
  const result = spawnSync('uv', ['run', '--directory', path.join(REPO_ROOT, 'eval'), 'python', '-m', module, ...args], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (result.error) throw result.error;
  return result.status ?? 3;
}

function spawnNode(args: string[], logPath: string): number {
  const result = spawnSync(process.execPath, ['--import', 'tsx', ...args], { cwd: REPO_ROOT, env: process.env, encoding: 'utf8', maxBuffer: 1 << 30 });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.error) throw result.error;
  return result.status ?? 3;
}

/** Child mode: one in-process ingest-mode run with the switch at `value`, scored into <out>/report.json. */
async function childRun(armName: string, value: string, outDir: string): Promise<number> {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as { arms: ArmSpec[] };
  const arm = spec.arms.find((candidate) => candidate.name === armName);
  if (!arm) throw new Error(`unknown arm ${armName}`);
  const fixtureMode = arm.fixture_mode ?? 'ingest';
  const { ingestModeGoldenPaths, mergeGoldenFiles } = await import('./ingest-mode.mts');
  const { dropTableSplitItems } = await import('./table-split.mts');
  const { runEval } = await import('./run-eval.mts');
  fs.mkdirSync(outDir, { recursive: true });
  const merged = mergeGoldenFiles(
    (fixtureMode === 'ingest' ? ingestModeGoldenPaths() : ['eval/fixtures/golden.jsonl']).map((file: string) => path.join(REPO_ROOT, file)),
    path.join(outDir, 'golden.merged.jsonl'),
  );
  const goldenPath = fixtureMode === 'ingest' ? merged : dropTableSplitItems(merged, path.join(outDir, 'golden.no-table-split.jsonl'));
  const switchEnv = { [arm.switch]: value };
  const result = await runEval({
    goldenPath,
    corpusDir: path.join(REPO_ROOT, 'eval/fixtures/corpus'),
    outDir,
    deploymentMode: 'single-tenant',
    fixtureMode,
    tier: 'smoke',
    ...(arm.side === 'ingestion' && fixtureMode === 'ingest' ? { ingestBuildEnv: switchEnv } : { appEnv: switchEnv }),
  });
  console.log(`[Phase 3.2 Compare] ${armName}=${value}: ${result.itemCount} trace(s)`);
  return runPython('rag_eval.runner', ['score', '--traces', result.tracesPath, '--golden', goldenPath, '--manifest', result.runPath, '--out', outDir]);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'eval/reports/phase32' },
      work: { type: 'string', default: 'eval/out/phase32-compare' },
      arms: { type: 'string' },
      child: { type: 'boolean', default: false },
      arm: { type: 'string' },
      value: { type: 'string' },
    },
    strict: true,
  });
  if (values.child) {
    if (!values.arm || values.value === undefined) throw new Error('--child needs --arm and --value');
    return childRun(values.arm, values.value, path.resolve(values.work as string));
  }

  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as { arms: ArmSpec[] };
  const wanted = values.arms ? new Set(values.arms.split(',').map((name) => name.trim())) : null;
  const work = path.resolve(values.work as string);
  fs.mkdirSync(work, { recursive: true });
  const manifest: Record<string, { off: string; on: string }> = {};
  let harnessFailures = 0;

  for (const arm of spec.arms) {
    if (wanted && !wanted.has(arm.name)) continue;
    const armDir = path.join(work, arm.name);
    if (arm.runner === 'translation') {
      console.log(`[Phase 3.2 Compare] ${arm.name}: run-translation-compare.mts`);
      const code = spawnNode([path.join(REPO_ROOT, 'eval/harness/run-translation-compare.mts'), '--out', armDir], path.join(armDir, 'run.log'));
      const off = path.join(armDir, 'arm-a', 'report.json');
      const on = path.join(armDir, 'arm-b', 'report.json');
      if (code === 0 && fs.existsSync(off) && fs.existsSync(on)) manifest[arm.name] = { off, on };
      else {
        console.error(`[Phase 3.2 Compare] ${arm.name} exited ${code}; see ${path.join(armDir, 'run.log')}`);
        if (!arm.optional) harnessFailures += 1;
      }
      continue;
    }
    const reports: Record<'off' | 'on', string> = { off: '', on: '' };
    let failed = false;
    for (const side of ['off', 'on'] as const) {
      const value = arm[side];
      const outDir = path.join(armDir, side);
      console.log(`[Phase 3.2 Compare] ${arm.name}: ${arm.switch}=${value}`);
      const code = spawnNode([SELF, '--child', '--arm', arm.name, '--value', value, '--work', outDir], path.join(outDir, 'run.log'));
      const report = path.join(outDir, 'report.json');
      if (code !== 0 || !fs.existsSync(report)) {
        console.error(`[Phase 3.2 Compare] ${arm.name} ${side} run exited ${code}; see ${path.join(outDir, 'run.log')}`);
        failed = true;
        break;
      }
      reports[side] = report;
    }
    if (!failed) manifest[arm.name] = reports;
    else if (!arm.optional) harnessFailures += 1;
  }

  const runsPath = path.join(work, 'runs.json');
  fs.writeFileSync(runsPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const code = runPython('rag_eval.phase_compare', ['--spec', SPEC_PATH, '--runs', runsPath, '--out', path.resolve(values.out as string)]);
  if (harnessFailures > 0) {
    console.error(`[Phase 3.2 Compare] ${harnessFailures} required arm(s) did not run`);
    return 3;
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[Phase 3.2 Compare] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  },
);
