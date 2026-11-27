import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Plan 05.2-32 (D-42, D-54, D-62 a, b): the Phase 5.2 runs of the smoke tier. Each runs in its own child process (a second
 * in-process run keeps the first fake edge's embedder address) through run-smoke with the noise-band gate, which applies the
 * Phase 5.2 gate its generator names; the absolute quality gates are reported only, as in the prechunked smoke step.
 */
export interface Phase52Run {
  name: string;
  /** p52-all-off must also leave every paired difference against the baseline at zero (D-62 a). */
  pairedZero?: boolean;
}

export const PHASE52_SMOKE_RUNS: readonly Phase52Run[] = [
  { name: 'p52-all-off', pairedZero: true },
  { name: 'p52-rules-on' },
  { name: 'p52-violating-partial' },
  { name: 'p52-violating-versions' },
  { name: 'p52-violating-offtopic' },
  { name: 'p52-sec-output-guard' },
];

export interface Phase52RunResult {
  name: string;
  code: number;
  reason?: 'gate' | 'paired_not_zero' | 'no_gate_result';
}

export type SpawnRun = (args: string[]) => number;

function defaultSpawn(repoRoot: string): SpawnRun {
  return (args) => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'eval/harness/run-smoke.mts', ...args], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    return child.status ?? 3;
  };
}

function pairedAllZero(outDir: string): boolean | null {
  const file = path.join(outDir, 'gate.json');
  if (!fs.existsSync(file)) return null;
  const gate = JSON.parse(fs.readFileSync(file, 'utf8')) as { paired?: { all_zero?: boolean } | null };
  return gate.paired?.all_zero === true;
}

/** Runs every Phase 5.2 smoke run; the tier fails when any run's gate fails or the all-off run moves a paired difference. */
export function runPhase52Tier(options: {
  repoRoot: string;
  outDir: string;
  deploymentMode?: string;
  spawn?: SpawnRun;
}): Phase52RunResult[] {
  const spawn = options.spawn ?? defaultSpawn(options.repoRoot);
  const results: Phase52RunResult[] = [];
  for (const run of PHASE52_SMOKE_RUNS) {
    const outDir = path.join(options.outDir, run.name);
    const args = [
      '--run-config',
      path.join(options.repoRoot, 'eval', 'config', 'runs', `${run.name}.json`),
      '--out',
      outDir,
      '--gates-mode',
      'report',
      ...(options.deploymentMode ? ['--deployment-mode', options.deploymentMode] : []),
    ];
    console.log(`[Eval Harness] Phase 5.2 smoke run ${run.name}`);
    const code = spawn(args);
    if (code !== 0) {
      results.push({ name: run.name, code, reason: 'gate' });
      continue;
    }
    if (run.pairedZero) {
      const zero = pairedAllZero(outDir);
      if (zero !== true) {
        results.push({ name: run.name, code: 10, reason: zero === null ? 'no_gate_result' : 'paired_not_zero' });
        continue;
      }
    }
    results.push({ name: run.name, code: 0 });
  }
  return results;
}

/** The tier's exit code: the first failing run's code, else 0. */
export function phase52TierExitCode(results: readonly Phase52RunResult[]): number {
  return results.find((result) => result.code !== 0)?.code ?? 0;
}

/** The Phase 5.2 golden items: the three answer-rule categories and the link-injection items (D-42, D-54). */
export const PHASE52_CATEGORIES: ReadonlySet<string> = new Set(['partial_answer', 'stale_version', 'off_topic_context']);
export const LINK_INJECTION_TAG = 'link_injection';
/** The nightly slice answers with the live generator under the rule-following run's switches, not its fake. */
export const PHASE52_NIGHTLY_RUN_CONFIG = 'p52-rules-on';

export function phase52GoldenLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => {
      const item = JSON.parse(line) as { category?: string; tags?: string[] };
      return PHASE52_CATEGORIES.has(item.category ?? '') || (item.tags ?? []).includes(LINK_INJECTION_TAG);
    });
}
