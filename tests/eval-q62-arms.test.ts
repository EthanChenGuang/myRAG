import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadRunConfig, parseRunConfig, RunConfigError } from '../eval/harness/run-config.mts';

const RUNS = join(__dirname, '..', 'eval', 'config', 'runs');
const load = (name: string) => loadRunConfig(join(RUNS, `q62-${name}.json`));

const BASE = { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_QUERY_DECOMPOSE: 'false' };

describe('Phase 6.2 comparison arms (06.2-30, D-10)', () => {
  test('single-pass is the layer on with decompose off', () => {
    expect(load('single-pass').env).toEqual(BASE);
  });

  test.each([
    ['decompose', { RAG_QUERY_DECOMPOSE: 'true' }],
    ['completeness', { RAG_QUERY_DECOMPOSE: 'true', RAG_QUERY_DECOMPOSE_COMPLETENESS: 'true' }],
    [
      'subq-filters',
      { RAG_QUERY_DECOMPOSE: 'true', RAG_QUERY_DECOMPOSE_COMPLETENESS: 'true', RAG_QUERY_SUBQ_FILTERS: 'true' },
    ],
    ['glossary', { RAG_TRANSLATION_GLOSSARY: 'true' }],
    ['scope-gate', { RAG_SCOPE_GATE: 'true' }],
    ['speculative', { RAG_SPECULATIVE_RETRIEVAL: 'true' }],
    ['routing', { RAG_MODEL_ROUTING: 'auto' }],
  ])('%s adds only its own switches to the previous arm', (name, extra) => {
    const config = load(name);
    expect(config.name).toBe(`q62-${name}`);
    expect(config.env).toEqual({ ...BASE, ...extra });
    expect(config.overrides).toBeNull();
    expect(config.entryProfile).toBeUndefined();
  });

  test('only the routing arm selects a model, and it selects auto', () => {
    expect(load('routing').selectedModel).toBe('auto');
    for (const name of ['single-pass', 'decompose', 'completeness', 'subq-filters', 'glossary', 'scope-gate', 'speculative']) {
      expect(load(name).selectedModel).toBeUndefined();
    }
  });
});

describe('run-config selected_model (D-19, D-20)', () => {
  test('accepts auto or a model id and is absent by default', () => {
    expect(parseRunConfig({ name: 'plain', env: {} }, 'test').selectedModel).toBeUndefined();
    expect(parseRunConfig({ name: 'auto', env: {}, selected_model: 'auto' }, 'test').selectedModel).toBe('auto');
    expect(parseRunConfig({ name: 'explicit', env: {}, selected_model: 'openai/gpt-4.1-mini' }, 'test').selectedModel).toBe(
      'openai/gpt-4.1-mini',
    );
  });

  test('rejects a malformed value and the voice entry', () => {
    expect(() => parseRunConfig({ name: 'bad', env: {}, selected_model: '' }, 'test')).toThrow(RunConfigError);
    expect(() => parseRunConfig({ name: 'bad', env: {}, selected_model: 7 }, 'test')).toThrow(RunConfigError);
    expect(() => parseRunConfig({ name: 'bad', env: {}, selected_model: 'a b' }, 'test')).toThrow(RunConfigError);
    expect(() => parseRunConfig({ name: 'voice', env: {}, entry_profile: 'voice', selected_model: 'auto' }, 'test')).toThrow(
      RunConfigError,
    );
  });
});
