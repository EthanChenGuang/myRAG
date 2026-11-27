import { afterEach, describe, expect, it } from 'vitest';
import { loadRagConfig } from '@/lib/rag/config';
import { getRagDeps, resetRagDepsForTests } from '@/lib/rag/deps';

const NAMES = ['RAG_SPECULATIVE_RETRIEVAL', 'RAG_QUERY_LAYER', 'RAG_PIPELINE'] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetRagDepsForTests();
});

// Phase 6.2 D-21: the default deps must pass RAG_SPECULATIVE_RETRIEVAL from the process to the RAG config like every other switch.
describe('RAG_SPECULATIVE_RETRIEVAL reaches the RAG config through the default deps', () => {
  it('reads the switch from the process environment', () => {
    resetRagDepsForTests();
    process.env.RAG_SPECULATIVE_RETRIEVAL = 'true';
    process.env.RAG_QUERY_LAYER = 'true';
    process.env.RAG_PIPELINE = 'v2';
    const input = getRagDeps().ragEnv();
    expect(input.RAG_SPECULATIVE_RETRIEVAL).toBe('true');
    expect(loadRagConfig(input).queryAdditions.effective.speculativeRetrieval).toBe(true);
  });

  it('stays off when the switch is unset', () => {
    resetRagDepsForTests();
    delete process.env.RAG_SPECULATIVE_RETRIEVAL;
    process.env.RAG_QUERY_LAYER = 'true';
    const config = loadRagConfig(getRagDeps().ragEnv());
    expect(config.queryAdditions.effective.speculativeRetrieval).toBe(false);
  });
});
