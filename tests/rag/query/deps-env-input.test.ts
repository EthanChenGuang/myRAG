import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import { loadRagConfig, type RagConfig, type RagEnvInput } from '@/lib/rag/config';
import { getRagDeps, resetRagDepsForTests } from '@/lib/rag/deps';

type SwitchName = keyof RagEnvInput & keyof typeof env;

interface SwitchCase {
  name: SwitchName;
  /** A non-default value the deployment could set. */
  set: string;
  read: (config: RagConfig) => unknown;
  expected: unknown;
}

// Phase 6.2 D-28: every new switch must reach the RAG config through the default deps, otherwise setting it changes nothing.
const SWITCHES: SwitchCase[] = [
  { name: 'RAG_QUERY_DECOMPOSE_COMPLETENESS', set: 'false', read: (c) => c.queryAdditions.effective.completeness, expected: false },
  { name: 'RAG_QUERY_SUBQ_FILTERS', set: 'true', read: (c) => c.queryAdditions.effective.subqFilters, expected: true },
  { name: 'RAG_DECOMPOSED_ANSWER', set: 'false', read: (c) => c.queryAdditions.effective.decomposedAnswer, expected: false },
  { name: 'RAG_TRANSLATION_GLOSSARY', set: 'true', read: (c) => c.queryAdditions.effective.translationGlossary, expected: true },
  { name: 'RAG_LANGID_SIDECAR', set: 'true', read: (c) => c.queryAdditions.effective.langidSidecar, expected: true },
  { name: 'RAG_SPECULATIVE_RETRIEVAL', set: 'true', read: (c) => c.queryAdditions.effective.speculativeRetrieval, expected: true },
  { name: 'RAG_QUERY_HISTORY_FALLBACK', set: 'false', read: (c) => c.queryAdditions.effective.historyFallback, expected: false },
  { name: 'RAG_SCOPE_GATE', set: 'true', read: (c) => c.queryAdditions.effective.scopeGate, expected: true },
  { name: 'RAG_WHATSAPP_HISTORY', set: 'true', read: (c) => c.queryAdditions.whatsappHistory, expected: true },
  { name: 'RAG_MODEL_ROUTING', set: 'auto', read: (c) => c.modelRouting.mode, expected: 'auto' },
  { name: 'RAG_ROUTING_FAST_MODEL', set: 'example/fast-model-1', read: (c) => c.modelRouting.fastModel, expected: 'example/fast-model-1' },
  { name: 'RAG_ROUTING_QUALITY_MODEL', set: 'example/quality-model-1', read: (c) => c.modelRouting.qualityModel, expected: 'example/quality-model-1' },
];

const NAMES = ['RAG_PIPELINE', 'RAG_QUERY_LAYER', ...SWITCHES.map((entry) => entry.name)];

beforeEach(() => {
  resetRagDepsForTests();
  for (const name of NAMES) vi.stubEnv(name, undefined);
  vi.stubEnv('RAG_PIPELINE', 'v2');
  vi.stubEnv('RAG_QUERY_LAYER', 'true');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetRagDepsForTests();
});

describe('Phase 6.2 D-28 switches reach the RAG config through the default deps', () => {
  it.each(SWITCHES)('$name set in the process environment reaches the query layer config', ({ name, set, read, expected }) => {
    vi.stubEnv(name, set);
    const input = getRagDeps().ragEnv();
    expect(input[name]).toBe(set);
    expect(read(loadRagConfig(input))).toEqual(expected);
  });

  it.each(SWITCHES)('$name unset falls back to the env.ts default', ({ name }) => {
    expect(getRagDeps().ragEnv()[name]).toBe(env[name]);
  });
});

describe('parity off: with the D-28 switches unset the config equals the config without them', () => {
  function withoutSwitches(input: RagEnvInput): RagEnvInput {
    const copy: Record<string, unknown> = { ...input };
    for (const { name } of SWITCHES) delete copy[name];
    return copy as RagEnvInput;
  }

  function comparable(config: RagConfig) {
    return { ...config, warnings: [...config.warnings] };
  }

  it.each([
    ['layer on', 'true'],
    ['layer off', 'false'],
  ])('%s', (_label, layer) => {
    vi.stubEnv('RAG_QUERY_LAYER', layer);
    const input = getRagDeps().ragEnv();
    const withDefaults = loadRagConfig(input);
    const bare = loadRagConfig(withoutSwitches(input));
    expect(comparable(withDefaults)).toStrictEqual(comparable(bare));
  });

  it('layer off keeps every D-28 switch inert even when set', () => {
    vi.stubEnv('RAG_QUERY_LAYER', 'false');
    for (const { name, set } of SWITCHES) vi.stubEnv(name, set);
    const config = loadRagConfig(getRagDeps().ragEnv());
    expect(Object.values(config.queryAdditions.effective).every((value) => value === false)).toBe(true);
    expect(config.modelRouting.mode).toBe('off');
  });
});
