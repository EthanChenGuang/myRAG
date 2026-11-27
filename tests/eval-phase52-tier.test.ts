import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadRunConfig } from '../eval/harness/run-config.mts';
import { PHASE52_SMOKE_RUNS, phase52GoldenLines, phase52TierExitCode, runPhase52Tier } from '../eval/harness/phase52-tier.mts';

const REPO_ROOT = process.cwd();

function tempOut(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase52-tier-'));
}

function writeGate(outDir: string, allZero: boolean): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'gate.json'), JSON.stringify({ passed: true, paired: { all_zero: allZero } }));
}

describe('Phase 5.2 smoke tier (05.2-32)', () => {
  test('runs the six Phase 5.2 configurations, each of which loads', () => {
    expect(PHASE52_SMOKE_RUNS.map((run) => run.name)).toEqual([
      'p52-all-off',
      'p52-rules-on',
      'p52-violating-partial',
      'p52-violating-versions',
      'p52-violating-offtopic',
      'p52-sec-output-guard',
    ]);
    for (const run of PHASE52_SMOKE_RUNS) {
      expect(loadRunConfig(path.join(REPO_ROOT, 'eval/config/runs', `${run.name}.json`)).name).toBe(run.name);
    }
  });

  test('each run goes through run-smoke with its config, its own out directory and the absolute gates in report mode', () => {
    const out = tempOut();
    const calls: string[][] = [];
    const results = runPhase52Tier({
      repoRoot: REPO_ROOT,
      outDir: out,
      spawn: (args) => {
        calls.push(args);
        writeGate(args[args.indexOf('--out') + 1], true);
        return 0;
      },
    });
    expect(phase52TierExitCode(results)).toBe(0);
    expect(calls).toHaveLength(6);
    for (const [index, args] of calls.entries()) {
      const name = PHASE52_SMOKE_RUNS[index].name;
      expect(args.slice(0, 4)).toEqual(['--run-config', path.join(REPO_ROOT, 'eval/config/runs', `${name}.json`), '--out', path.join(out, name)]);
      expect(args).toContain('--gates-mode');
      expect(args[args.indexOf('--gates-mode') + 1]).toBe('report');
      expect(args).not.toContain('--no-gate');
    }
  });

  test('fails with the first failing gate code and runs the remaining configurations', () => {
    const out = tempOut();
    let index = 0;
    const results = runPhase52Tier({
      repoRoot: REPO_ROOT,
      outDir: out,
      spawn: (args) => {
        writeGate(args[args.indexOf('--out') + 1], true);
        index += 1;
        return index === 3 ? 10 : 0;
      },
    });
    expect(results).toHaveLength(6);
    expect(results[2]).toEqual({ name: 'p52-violating-partial', code: 10, reason: 'gate' });
    expect(phase52TierExitCode(results)).toBe(10);
  });

  test('the all-off run fails when a paired difference against the baseline is not zero', () => {
    const out = tempOut();
    const results = runPhase52Tier({
      repoRoot: REPO_ROOT,
      outDir: out,
      spawn: (args) => {
        const dir = args[args.indexOf('--out') + 1];
        writeGate(dir, path.basename(dir) !== 'p52-all-off');
        return 0;
      },
    });
    expect(results[0]).toEqual({ name: 'p52-all-off', code: 10, reason: 'paired_not_zero' });
    expect(results.slice(1).every((result) => result.code === 0)).toBe(true);
  });

  test('run-smoke exposes the tier as --phase52', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'eval/harness/run-smoke.mts'), 'utf8');
    expect(source).toContain("phase52: { type: 'boolean', default: false }");
    expect(source).toContain('runPhase52Tier(');
  });

  test('the nightly slice keeps exactly the answer-rule and link-injection items of the golden set', () => {
    const lines = phase52GoldenLines(fs.readFileSync(path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl'), 'utf8'));
    const items = lines.map((line) => JSON.parse(line) as { category: string; tags: string[] });
    expect(items).toHaveLength(48);
    const counts = new Map<string, number>();
    for (const item of items) {
      const key = item.tags.includes('link_injection') ? 'link_injection' : item.category;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({ partial_answer: 12, stale_version: 12, off_topic_context: 12, link_injection: 12 });
  });

  test('run-nightly exposes the slice as --phase52 under the rule-following switches', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'eval/harness/run-nightly.mts'), 'utf8');
    expect(source).toContain("phase52: { type: 'boolean', default: false }");
    expect(source).toContain('runPhase52Nightly(');
  });
});
