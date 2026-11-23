import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import {
  CORE_STAGES,
  OPTIONAL_STAGES,
  PROFILE_STAGE_DEFAULTS,
  loadRagConfig,
  resetRagConfigForTests,
} from '@/lib/rag/config';

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  resetRagConfigForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

function configWarnings(): string[] {
  return warn.mock.calls
    .filter((call) => String(call[0]).includes('[RAG Config]'))
    .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
}

describe('stage tables', () => {
  test('core and optional stage names are the D-03 names', () => {
    expect([...CORE_STAGES]).toEqual(['embed', 'search']);
    expect([...OPTIONAL_STAGES]).toEqual([
      'analyze',
      'legacy_rank',
      'post_filter',
      'assemble',
      'voice_keyword_fallback',
      'local_rerank',
    ]);
  });

  test('profile defaults match the plan', () => {
    for (const profile of ['chat', 'embed', 'eval', 'media'] as const) {
      expect(PROFILE_STAGE_DEFAULTS[profile]).toEqual({
        analyze: 1000,
        embed: 15000,
        search: 15000,
        legacy_rank: 2000,
        post_filter: 10000,
        assemble: 10000,
      });
    }
    expect(PROFILE_STAGE_DEFAULTS.voice).toEqual({
      analyze: 500,
      embed: 5000,
      search: 5000,
      voice_keyword_fallback: 3000,
      local_rerank: 1000,
      post_filter: 3000,
      assemble: 3000,
    });
  });
});

describe('loadRagConfig', () => {
  test('empty values give legacy, nothing disabled and the profile defaults', () => {
    const config = loadRagConfig({});
    expect(config.pipeline).toBe('legacy');
    expect(config.disabledStages.size).toBe(0);
    expect(config.timeouts.chat).toEqual(PROFILE_STAGE_DEFAULTS.chat);
    expect(config.timeouts.voice).toEqual(PROFILE_STAGE_DEFAULTS.voice);
    expect(config.warnings).toEqual([]);
    expect(configWarnings()).toEqual([]);
  });

  test('an unimplemented or unknown pipeline value runs legacy and logs once per value', () => {
    for (const value of ['v2', 'foo']) {
      expect(loadRagConfig({ RAG_PIPELINE: value }).pipeline).toBe('legacy');
    }
    expect(configWarnings()).toHaveLength(2);
    for (let i = 0; i < 5; i += 1) loadRagConfig({ RAG_PIPELINE: 'v2' });
    expect(configWarnings()).toHaveLength(2);
  });

  test('legacy and blank pipeline values do not log', () => {
    loadRagConfig({ RAG_PIPELINE: 'legacy' });
    loadRagConfig({ RAG_PIPELINE: '  ' });
    expect(configWarnings()).toEqual([]);
  });

  test('optional stages can be disabled', () => {
    const config = loadRagConfig({ RAG_DISABLED_STAGES: 'legacy_rank, assemble' });
    expect([...config.disabledStages].sort()).toEqual(['assemble', 'legacy_rank']);
    expect(configWarnings()).toEqual([]);
  });

  test('a core stage in the disabled list is dropped and logged once', () => {
    const env = { RAG_DISABLED_STAGES: 'embed,legacy_rank,search' };
    const config = loadRagConfig(env);
    expect([...config.disabledStages]).toEqual(['legacy_rank']);
    expect(configWarnings()).toHaveLength(2);
    loadRagConfig(env);
    loadRagConfig({ RAG_DISABLED_STAGES: 'embed,legacy_rank,search ' });
    expect(configWarnings()).toHaveLength(2);
    expect(config.warnings.join(' ')).toContain('embed');
  });

  test('unknown stage names are dropped and logged', () => {
    const config = loadRagConfig({ RAG_DISABLED_STAGES: 'rerank,post_filter' });
    expect([...config.disabledStages]).toEqual(['post_filter']);
    expect(configWarnings()).toHaveLength(1);
    expect(configWarnings()[0]).toContain('rerank');
  });

  test('timeout overrides apply to every profile and invalid entries are logged', () => {
    const config = loadRagConfig({ RAG_STAGE_TIMEOUTS: 'embed=2000,search=abc,foo=5' });
    for (const profile of ['chat', 'embed', 'voice', 'media', 'eval'] as const) {
      expect(config.timeouts[profile].embed).toBe(2000);
    }
    expect(config.timeouts.chat.search).toBe(15000);
    expect(config.timeouts.voice.search).toBe(5000);
    expect(configWarnings()).toHaveLength(2);
    const text = configWarnings().join(' ');
    expect(text).toContain('search');
    expect(text).toContain('foo');
  });

  test('timeout values must be integers from 1 to 60000', () => {
    const config = loadRagConfig({
      RAG_STAGE_TIMEOUTS: 'embed=0,search=60001,analyze=1.5,assemble=60000,legacy_rank=1,post_filter=-5',
    });
    expect(config.timeouts.chat.embed).toBe(15000);
    expect(config.timeouts.chat.search).toBe(15000);
    expect(config.timeouts.chat.analyze).toBe(1000);
    expect(config.timeouts.chat.assemble).toBe(60000);
    expect(config.timeouts.chat.legacy_rank).toBe(1);
    expect(config.timeouts.chat.post_filter).toBe(10000);
    expect(configWarnings()).toHaveLength(4);
  });

  test('loading does not mutate the shared profile defaults', () => {
    loadRagConfig({ RAG_STAGE_TIMEOUTS: 'embed=1' });
    expect(PROFILE_STAGE_DEFAULTS.chat.embed).toBe(15000);
  });

  test('identical env snapshots are memoised', () => {
    const env = { RAG_STAGE_TIMEOUTS: 'embed=2000' };
    expect(loadRagConfig(env)).toBe(loadRagConfig({ ...env }));
  });
});
