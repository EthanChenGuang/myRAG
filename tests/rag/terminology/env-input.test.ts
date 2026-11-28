import { afterEach, describe, expect, it } from 'vitest';
import { loadRagConfig } from '@/lib/rag/config';
import { getRagDeps, resetRagDepsForTests } from '@/lib/rag/deps';

const NAMES = ['RAG_TERMINOLOGY', 'RAG_TERMINOLOGY_DENSE', 'RAG_TERMINOLOGY_MINING'] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetRagDepsForTests();
});

// The default deps read the RAG config input from the process; the terminology switches must reach it like every other switch.
describe('the terminology switches reach the RAG config through the default deps', () => {
  it('passes the three switches from the process environment', () => {
    resetRagDepsForTests();
    for (const name of NAMES) process.env[name] = 'true';
    const input = getRagDeps().ragEnv();
    expect(NAMES.map((name) => input[name])).toEqual(['true', 'true', 'true']);
    const config = loadRagConfig(input);
    expect([config.v2.terminology, config.v2.terminologyDense, config.v2.terminologyMining]).toEqual([true, true, true]);
  });

  it('leaves the stage off when the switches are unset', () => {
    resetRagDepsForTests();
    for (const name of NAMES) delete process.env[name];
    const config = loadRagConfig(getRagDeps().ragEnv());
    expect([config.v2.terminology, config.v2.terminologyDense, config.v2.terminologyMining]).toEqual([false, false, false]);
  });
});

describe('the config input with the switches unset', () => {
  it('carries no terminology value, as before the switches were read', () => {
    resetRagDepsForTests();
    for (const name of NAMES) delete process.env[name];
    const input = getRagDeps().ragEnv();
    expect(NAMES.map((name) => input[name])).toEqual([undefined, undefined, undefined]);
  });
});
