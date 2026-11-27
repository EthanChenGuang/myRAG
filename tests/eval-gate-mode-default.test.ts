import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { measuredTierModes, resolveGatesMode, type GatesMode } from '../eval/harness/gate-mode.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PR_SMOKE = path.join(REPO_ROOT, '.github/workflows/pr-smoke.yml');
const SMOKE_COMMAND_RE = /npm run test-rag\b([^\n]*)/g;

interface Invocation {
  job: string;
  args: string;
  out: string;
  explicit: GatesMode | undefined;
  fixtureMode: 'prechunked' | 'ingest';
  live: boolean;
  customInputs: boolean;
}

function gatedInvocations(): Invocation[] {
  const workflow = parse(fs.readFileSync(PR_SMOKE, 'utf8')) as { jobs: Record<string, { steps?: Array<{ run?: string }> }> };
  const found: Invocation[] = [];
  for (const [job, body] of Object.entries(workflow.jobs)) {
    for (const step of body.steps ?? []) {
      for (const match of String(step.run ?? '').matchAll(SMOKE_COMMAND_RE)) {
        const args = match[1] ?? '';
        if (/--no-gate\b|--phase52\b|--cache-pairs\b/.test(args)) continue;
        const customInputs = /--gates\s|--golden\s/.test(args);
        const explicit = /--gates-mode\s+(enforce|report)\b/.exec(args)?.[1] as GatesMode | undefined;
        found.push({
          job,
          args,
          out: /--out\s+(\S+)/.exec(args)?.[1] ?? 'eval/out/smoke',
          explicit,
          fixtureMode: /--fixture-mode\s+ingest\b/.test(args) ? 'ingest' : 'prechunked',
          live: /--base-url\b/.test(args),
          customInputs,
        });
      }
    }
  }
  return found;
}

/** The mode rag_eval.gate applies: the mode run-smoke passes, or the gate's own default. */
function applied(mode: GatesMode | undefined): GatesMode {
  return mode ?? 'enforce';
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function record(tiers: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-mode-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'measurement.json');
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, tiers }));
  return file;
}

describe('local test-rag gate mode follows the measured tier (O-1, H-10)', () => {
  const invocations = gatedInvocations();
  const measured = measuredTierModes();
  const byOut = new Map([...measured.values()].filter((tier) => tier.out).map((tier) => [tier.out!, tier]));

  test('pr-smoke has gated smoke invocations for both fixture modes', () => {
    expect(invocations.some((run) => run.out === 'eval/out/smoke')).toBe(true);
    expect(invocations.some((run) => run.out === 'eval/out/smoke-ingest')).toBe(true);
  });

  test.each(invocations.map((run) => [run.out, run] as const))('%s: local default equals the mode pr-smoke applies', (_out, run) => {
    const local = applied(resolveGatesMode(undefined, { fixtureMode: run.fixtureMode, live: run.live, customInputs: run.customInputs }).mode);
    const ci = applied(run.explicit ?? resolveGatesMode(undefined, { fixtureMode: run.fixtureMode, live: run.live, customInputs: run.customInputs }).mode);
    const tier = byOut.get(run.out);
    if (tier) {
      // A measured tier: the record, pr-smoke and a bare local run agree.
      expect(tier.mode).not.toBeNull();
      expect(ci).toBe(tier.mode);
      expect(local).toBe(ci);
    } else {
      // An unmeasured control (the prompt control) states its mode; it must not rely on the default.
      expect(run.explicit, `${run.job} step writing ${run.out} must pass --gates-mode`).toBeDefined();
    }
  });

  test('the bare local defaults are report for prechunked and enforce for ingest on the committed record', () => {
    expect(resolveGatesMode(undefined, { fixtureMode: 'prechunked', live: false })).toEqual({
      mode: measured.get('smoke')?.mode,
      source: 'measured_tier',
      tier: 'smoke',
    });
    expect(resolveGatesMode(undefined, { fixtureMode: 'ingest', live: false }).mode).toBe(measured.get('smoke-ingest')?.mode);
    expect(measured.get('smoke-ingest')?.mode).toBe('enforce');
  });

  test('an explicit flag wins over the measured tier', () => {
    expect(resolveGatesMode('enforce', { fixtureMode: 'prechunked', live: false })).toEqual({ mode: 'enforce', source: 'flag', tier: null });
    expect(resolveGatesMode('report', { fixtureMode: 'ingest', live: false }).mode).toBe('report');
  });

  test('live runs, --gates or --golden overrides, a missing record and an unmeasured tier keep the gate default (enforce)', () => {
    expect(resolveGatesMode(undefined, { fixtureMode: 'prechunked', live: true }).mode).toBeUndefined();
    expect(resolveGatesMode(undefined, { fixtureMode: 'prechunked', live: false, customInputs: true }).mode).toBeUndefined();
    expect(resolveGatesMode(undefined, { fixtureMode: 'prechunked', live: false }, '/nonexistent/measurement.json').mode).toBeUndefined();
    const onlyIngest = record([{ name: 'smoke-ingest', stage: 'after', mode: 'enforce', out: 'eval/out/smoke-ingest' }]);
    expect(resolveGatesMode(undefined, { fixtureMode: 'prechunked', live: false }, onlyIngest)).toEqual({
      mode: undefined,
      source: 'gate_default',
      tier: 'smoke',
    });
  });

  test('the latest stage decides, and a stage without a mode falls back to enforce', () => {
    const flipped = record([
      { name: 'smoke', stage: 'after', mode: 'enforce', out: 'eval/out/smoke' },
      { name: 'smoke', stage: 'before', mode: 'report', out: 'eval/out/smoke' },
    ]);
    expect(resolveGatesMode(undefined, { fixtureMode: 'prechunked', live: false }, flipped).mode).toBe('enforce');
    const noMode = record([{ name: 'smoke', stage: 'before', out: 'eval/out/smoke' }]);
    expect(resolveGatesMode(undefined, { fixtureMode: 'prechunked', live: false }, noMode).mode).toBeUndefined();
  });
});
