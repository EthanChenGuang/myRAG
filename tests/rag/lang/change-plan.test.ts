import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import registryJson from '../../../config/rag/language-packs.json';
import { baselineChecker, planLanguageChange, type LanguageChangeContext } from '@/lib/rag/lang/change-plan';
import { main, parseLanguagesArgs, type CliIo } from '@/lib/rag/lang/cli';

// LANG-11 (plan 07-52): adding a language needs its pack, golden slice, a supporting profile and a recorded baseline;
// removing one changes the query side only.

type Registry = { packs: Array<Record<string, unknown> & { code: string }> };
const shipped = registryJson as unknown as Registry;

function registryWith(edit?: (pack: Record<string, unknown> & { code: string }) => void): Registry {
  const copy = JSON.parse(JSON.stringify(shipped)) as Registry;
  if (edit) copy.packs.forEach(edit);
  return copy;
}

function context(options: { baselines?: string[]; profileLanguages?: string[]; registry?: Registry } = {}): LanguageChangeContext {
  const baselines = new Set(options.baselines ?? ['it']);
  return {
    registry: options.registry ?? registryWith(),
    reranker: null,
    embeddingProfile: { id: 'fixture-profile', supportedLanguages: options.profileLanguages ?? ['zh', 'en', 'it'] },
    hasBaseline: (code) => baselines.has(code),
  };
}

const ADD = { current: ['zh', 'en'], proposed: ['zh', 'en', 'it'], primary: 'zh' };

function captureIo(): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (line) => lines.push(line), err: (line) => errors.push(line) };
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('planLanguageChange', () => {
  it('an addition with a complete pack, golden slice, supporting profile and baseline plans baseline, save, rebuild(language_add)', () => {
    const plan = planLanguageChange(ADD, context());
    expect(plan.ok).toBe(true);
    expect(plan.added).toEqual(['it']);
    expect(plan.removed).toEqual([]);
    expect(plan.refusals).toEqual([]);
    expect(plan.steps).toEqual([
      { kind: 'baseline', languages: ['it'], state: 'recorded' },
      { kind: 'save' },
      { kind: 'rebuild', selection: 'language_add', mechanism: 'reparse' },
    ]);
    expect(plan.normalized).toEqual({ languages: ['zh', 'en', 'it'], primary: 'zh', supported: 'zh,en,it' });
  });

  it('without the baseline record it refuses with language_baseline_missing and the command, and plans no step', () => {
    const plan = planLanguageChange(ADD, context({ baselines: [] }));
    expect(plan.ok).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.normalized).toBeNull();
    expect(plan.refusals).toEqual([{ code: 'language_baseline_missing', language: 'it', command: 'npm run rag:languages -- baseline it' }]);
  });

  it('a profile that does not declare the language refuses with embedding_profile_unsupported, before the baseline code', () => {
    const plan = planLanguageChange(ADD, context({ baselines: [], profileLanguages: ['zh', 'en'] }));
    expect(plan.refusals.map((refusal) => refusal.code)).toEqual(['embedding_profile_unsupported', 'language_baseline_missing']);
  });

  it('an incomplete pack (no golden slice) refuses with incomplete_pack in the validator order', () => {
    const registry = registryWith((pack) => {
      if (pack.code === 'it') pack.fixtures = { corpus: true, golden_slices: false };
    });
    const plan = planLanguageChange(ADD, context({ registry }));
    expect(plan.ok).toBe(false);
    expect(plan.refusals[0]).toEqual({ code: 'incomplete_pack', language: 'it' });
  });

  it('a removal-only proposal plans the save alone, no rebuild, and the note that the documents stay searchable', () => {
    const plan = planLanguageChange({ current: ['zh', 'en', 'it'], proposed: ['zh', 'en'], primary: 'zh' }, context({ baselines: [] }));
    expect(plan.ok).toBe(true);
    expect(plan.removed).toEqual(['it']);
    expect(plan.steps).toEqual([{ kind: 'save' }]);
    expect(plan.rebuild).toBeNull();
    expect(plan.notes).toEqual([{ code: 'removed_documents_stay_searchable', language: 'it' }]);
  });

  it('a change that adds and removes applies the addition rules to the added codes only', () => {
    const plan = planLanguageChange({ current: ['zh', 'en'], proposed: ['zh', 'it'], primary: 'zh' }, context({ baselines: [] }));
    expect(plan.added).toEqual(['it']);
    expect(plan.removed).toEqual(['en']);
    expect(plan.refusals.map((refusal) => refusal.code)).toEqual(['language_baseline_missing']);
    const accepted = planLanguageChange({ current: ['zh', 'en'], proposed: ['zh', 'it'], primary: 'zh' }, context());
    expect(accepted.steps.map((step) => step.kind)).toEqual(['baseline', 'save', 'rebuild']);
    expect(accepted.notes).toEqual([{ code: 'removed_documents_stay_searchable', language: 'en' }]);
  });

  it('the first choice of languages (nothing saved) needs no baseline and plans no rebuild', () => {
    const plan = planLanguageChange({ current: [], proposed: ['zh', 'en'], primary: 'zh' }, context({ baselines: [] }));
    expect(plan.ok).toBe(true);
    expect(plan.firstChoice).toBe(true);
    expect(plan.steps).toEqual([{ kind: 'save' }]);
    expect(plan.rebuild).toBeNull();
  });

  it('baselineChecker reads eval/baselines/languages/<code>.json and ignores a record of another language', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-baseline-'));
    temps.push(root);
    const check = baselineChecker(root);
    expect(check('it')).toBe(false);
    fs.mkdirSync(path.join(root, 'eval/baselines/languages'), { recursive: true });
    fs.writeFileSync(path.join(root, 'eval/baselines/languages/it.json'), JSON.stringify({ language: 'en' }));
    expect(check('it')).toBe(false);
    fs.writeFileSync(path.join(root, 'eval/baselines/languages/it.json'), JSON.stringify({ language: 'it' }));
    expect(check('it')).toBe(true);
    expect(check('../it')).toBe(false);
  });
});

describe('npm run rag:languages', () => {
  it('parses the four commands and refuses unknown options', () => {
    expect(parseLanguagesArgs(['baseline', 'it'])).toMatchObject({ ok: true, command: 'baseline', code: 'it', fixtureMode: 'prechunked' });
    expect(parseLanguagesArgs(['add', 'it', '--dry-run'])).toMatchObject({ ok: true, command: 'add', code: 'it', dryRun: true });
    expect(parseLanguagesArgs(['plan', '--languages', 'zh,EN'])).toMatchObject({ ok: true, languages: ['zh', 'en'] });
    expect(parseLanguagesArgs(['remove', 'it', '--force', 'x'])).toMatchObject({ ok: false });
    expect(parseLanguagesArgs(['add', '../x'])).toMatchObject({ ok: false });
  });

  it('baseline first: add without a baseline exits 2 and never saves or rebuilds', async () => {
    const calls: string[] = [];
    const io = captureIo();
    const code = await main(['add', 'it'], io, {
      readSaved: () => ({ languages: ['zh', 'en'], primary: 'zh' }),
      context: async () => context({ baselines: [] }),
      save: () => calls.push('save'),
      startRebuild: async () => {
        calls.push('rebuild');
        throw new Error('not reached');
      },
    });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(io.errors.join('\n')).toContain('language_baseline_missing');
    expect(io.errors.join('\n')).toContain('npm run rag:languages -- baseline it');
  });

  it('baseline first: with the baseline it saves through the writer, then starts the language_add rebuild and prints the groups', async () => {
    const calls: string[] = [];
    const io = captureIo();
    const code = await main(['add', 'it'], io, {
      readSaved: () => ({ languages: ['zh', 'en'], primary: 'zh' }),
      context: async () => context(),
      save: (normalized) => calls.push(`save:${normalized.languages.join(',')}:${normalized.primary}`),
      startRebuild: async (saved) => {
        calls.push(`rebuild:${saved.languages.join(',')}`);
        return { status: 'dry_run', mechanism: 'reparse', affected: 6, withoutFingerprint: 0, groups: { und: 1, scanned: 2, stale: 3 }, plan: { kind: 'nothing', mechanism: 'reparse', affected: 0 } };
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['save:zh,en,it:zh', 'rebuild:zh,en,it']);
    expect(io.lines.join('\n')).toContain('und 1, scanned 2, stale 3, total 6');
  });

  it('remove saves the smaller set and starts no rebuild', async () => {
    const calls: string[] = [];
    const io = captureIo();
    const code = await main(['remove', 'it'], io, {
      readSaved: () => ({ languages: ['zh', 'en', 'it'], primary: 'zh' }),
      context: async () => context({ baselines: [] }),
      save: (normalized) => calls.push(`save:${normalized.languages.join(',')}`),
      startRebuild: async () => {
        calls.push('rebuild');
        throw new Error('not reached');
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['save:zh,en']);
    expect(io.lines.join('\n')).toContain('stay searchable');
  });

  it('baseline writes eval/baselines/languages/<code>.json from the eval run with the config hash and golden sha256', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-cli-'));
    temps.push(root);
    const io = captureIo();
    const code = await main(['baseline', 'it'], io, {
      root,
      now: () => new Date('2026-01-01T00:00:00Z'),
      runBaseline: ({ out }) => {
        fs.writeFileSync(out, JSON.stringify({ run_config_hash: 'a'.repeat(64), golden_sha256: 'b'.repeat(64), runs: [1, 2, 3], slices: { 'language:it': { mrr: { mean: 1 } } } }));
        return 0;
      },
    });
    expect(code).toBe(0);
    const record = JSON.parse(fs.readFileSync(path.join(root, 'eval/baselines/languages/it.json'), 'utf8'));
    expect(record).toMatchObject({ language: 'it', run_config_hash: 'a'.repeat(64), golden_sha256: 'b'.repeat(64), runs: 3, population: 'fixture' });
    expect(baselineChecker(root)('it')).toBe(true);
  });

  it('baseline refuses a language with no golden slice in the run and records nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-cli-'));
    temps.push(root);
    const io = captureIo();
    const code = await main(['baseline', 'it'], io, {
      root,
      runBaseline: ({ out }) => {
        fs.writeFileSync(out, JSON.stringify({ run_config_hash: 'a'.repeat(64), golden_sha256: 'b'.repeat(64), slices: {} }));
        return 0;
      },
    });
    expect(code).toBe(2);
    expect(io.errors.join('\n')).toContain('golden_slice_missing');
    expect(fs.existsSync(path.join(root, 'eval/baselines/languages/it.json'))).toBe(false);
  });
});
