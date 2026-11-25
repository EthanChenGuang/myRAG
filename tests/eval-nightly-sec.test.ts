import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  injectionGoldenLines,
  LAKERA_SKIP_NOTICE,
  planSecNightly,
  PROMPT_GUARD_SKIP_NOTICE,
  secZeroFailures,
  type InjectionReportLike,
} from '../eval/harness/nightly-sec.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function report(overrides: Partial<InjectionReportLike> = {}): InjectionReportLike {
  const rates: InjectionReportLike['attack_success_rate'] = { 'category:injection': { value: 0, n: 12 } };
  for (const language of ['zh', 'en', 'it']) rates[`language_category:${language}:injection`] = { value: 0, n: 4 };
  return { config_label: 'recommended', attack_success_rate: rates, rules_false_positive_count: 0, ...overrides };
}

describe('SEC nightly matrix (D-14, A-13)', () => {
  test('without keys it runs tagging only and recommended, gates only recommended, and prints a notice per skipped detector', () => {
    const plan = planSecNightly({});
    expect(plan.legs.map((leg) => [leg.name, leg.gated])).toEqual([
      ['tagging_only', false],
      ['recommended', true],
    ]);
    expect(plan.notices).toEqual([PROMPT_GUARD_SKIP_NOTICE, LAKERA_SKIP_NOTICE]);
    expect(plan.legs[0].runConfig.env).toMatchObject({ RAG_CONTEXT_TAGGING: 'true', RAG_INJECTION_CHECK: 'off' });
    expect(plan.legs[1].runConfig.env).toMatchObject({ RAG_CONTEXT_TAGGING: 'true', RAG_INJECTION_CHECK: 'drop' });
  });

  test('each ML detector leg is the recommended configuration plus that detector, reported and never gated', () => {
    const plan = planSecNightly({
      LAKERA_GUARD_API_KEY: 'placeholder',
      PROMPT_GUARD_SIDECAR_URL: 'https://sidecar.example.invalid',
      PROMPT_GUARD_SIDECAR_SECRET: 'placeholder',
    });
    expect(plan.notices).toEqual([]);
    const byName = Object.fromEntries(plan.legs.map((leg) => [leg.name, leg]));
    expect(byName.recommended_lakera.gated).toBe(false);
    expect(byName.recommended_lakera.runConfig.env).toMatchObject({ RAG_INJECTION_CHECK: 'drop', RAG_INJECTION_LAKERA: 'true', RAG_INJECTION_PROMPT_GUARD: 'false' });
    expect(byName.recommended_prompt_guard.runConfig.env).toMatchObject({ RAG_INJECTION_CHECK: 'drop', RAG_INJECTION_PROMPT_GUARD: 'true', RAG_INJECTION_LAKERA: 'false' });
    expect(byName.recommended_prompt_guard.appEnv).toEqual({ RAG_SIDECAR_URL: 'https://sidecar.example.invalid', RAG_SIDECAR_SECRET: 'placeholder' });
    for (const leg of plan.legs) expect(JSON.stringify(leg.runConfig)).not.toContain('placeholder');
  });

  test('a half-configured Prompt Guard sidecar is skipped', () => {
    expect(planSecNightly({ PROMPT_GUARD_SIDECAR_URL: 'https://sidecar.example.invalid' }).notices).toContain(PROMPT_GUARD_SKIP_NOTICE);
  });

  test('the absolute-zero check passes a clean recommended report and names every failure', () => {
    expect(secZeroFailures(report())).toEqual([]);
    expect(secZeroFailures(null)).toEqual(['no injection block in the report']);
    expect(secZeroFailures(report({ config_label: 'other' }))[0]).toMatch(/not recommended/);
    expect(secZeroFailures(report({ rules_false_positive_count: 1 }))).toEqual(['rules flagged 1 clean chunk(s)']);
    const success = report();
    success.attack_success_rate['category:injection'] = { value: 1 / 12, n: 12 };
    expect(secZeroFailures(success)).toHaveLength(1);
    const few = report();
    few.attack_success_rate['language_category:it:injection'] = { value: 0, n: 3 };
    expect(secZeroFailures(few)[0]).toMatch(/too few injection items/);
  });

  test('the nightly golden subset keeps exactly the injection and injection_evasive items', () => {
    const lines = injectionGoldenLines(fs.readFileSync(path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl'), 'utf8'));
    const categories = lines.map((line) => (JSON.parse(line) as { category: string }).category);
    expect(categories.length).toBe(18);
    expect(new Set(categories)).toEqual(new Set(['injection', 'injection_evasive']));
  });
});
