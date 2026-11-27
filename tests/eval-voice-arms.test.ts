import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadRunConfig, parseRunConfig, RunConfigError } from '../eval/harness/run-config.mts';

const RUNS = join(__dirname, '..', 'eval', 'config', 'runs');
const OFF = join(RUNS, 'q62-voice-no-translate.json');
const ON = join(RUNS, 'q62-voice-translate.json');

describe('voice cross-language arms (Phase 6.2 D-16)', () => {
  test('both run configs load, set entry_profile voice and differ only in RAG_QUERY_VOICE_TRANSFORMS', () => {
    const off = loadRunConfig(OFF);
    const on = loadRunConfig(ON);
    expect(off.entryProfile).toBe('voice');
    expect(on.entryProfile).toBe('voice');
    expect(off.env.RAG_QUERY_VOICE_TRANSFORMS).toBe('condense_history,normalize_dates');
    expect(on.env.RAG_QUERY_VOICE_TRANSFORMS).toBe('condense_history,normalize_dates,translate');
    const { RAG_QUERY_VOICE_TRANSFORMS: _off, ...offRest } = off.env;
    const { RAG_QUERY_VOICE_TRANSFORMS: _on, ...onRest } = on.env;
    expect(onRest).toEqual(offRest);
    expect(on.overrides).toEqual(off.overrides);
    const rawOff = JSON.parse(readFileSync(OFF, 'utf8')) as Record<string, unknown>;
    const rawOn = JSON.parse(readFileSync(ON, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(rawOn).sort()).toEqual(Object.keys(rawOff).sort());
  });

  test('the committed voice baseline was recorded from the no-translate arm and carries every language pair slice', () => {
    const baseline = JSON.parse(readFileSync(join(__dirname, '..', 'eval', 'baselines', 'fixture-voice-baseline.json'), 'utf8')) as {
      request_options: Record<string, unknown>;
      slices: Record<string, unknown>;
    };
    expect(baseline.request_options.entry_profile).toBe('voice');
    const pairs = Object.keys(baseline.slices).filter((name) => name.startsWith('pair:')).sort();
    expect(pairs).toEqual(['pair:en->it', 'pair:en->zh', 'pair:it->en', 'pair:it->zh', 'pair:zh->en', 'pair:zh->it']);
  });

  test('entry_profile accepts eval and voice only; eval is the default and is not recorded', () => {
    expect(parseRunConfig({ name: 'plain', env: {} }, 'test').entryProfile).toBeUndefined();
    expect(parseRunConfig({ name: 'explicit-eval', env: {}, entry_profile: 'eval' }, 'test').entryProfile).toBeUndefined();
    expect(parseRunConfig({ name: 'voice', env: {}, entry_profile: 'voice' }, 'test').entryProfile).toBe('voice');
    expect(() => parseRunConfig({ name: 'chat', env: {}, entry_profile: 'chat' }, 'test')).toThrow(RunConfigError);
  });
});
