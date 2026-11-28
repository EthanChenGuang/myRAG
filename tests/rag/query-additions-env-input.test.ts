import { afterEach, describe, expect, it } from 'vitest';
import { loadRagConfig } from '@/lib/rag/config';
import { getRagDeps, resetRagDepsForTests } from '@/lib/rag/deps';

// 06.2-36: the four 6.2 switches the two-tenant canary rows turn on must reach the RAG config through the default deps, as set in the process.
const NAMES = ['RAG_PIPELINE', 'RAG_QUERY_LAYER', 'RAG_QUERY_SUBQ_FILTERS', 'RAG_TRANSLATION_GLOSSARY', 'RAG_SCOPE_GATE', 'RAG_WHATSAPP_HISTORY'] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetRagDepsForTests();
});

describe('the 6.2 canary switches reach the RAG config through the default deps', () => {
  it('passes RAG_QUERY_SUBQ_FILTERS, RAG_TRANSLATION_GLOSSARY, RAG_SCOPE_GATE and RAG_WHATSAPP_HISTORY from the process', () => {
    resetRagDepsForTests();
    process.env.RAG_PIPELINE = 'v2';
    process.env.RAG_QUERY_LAYER = 'true';
    for (const name of ['RAG_QUERY_SUBQ_FILTERS', 'RAG_TRANSLATION_GLOSSARY', 'RAG_SCOPE_GATE', 'RAG_WHATSAPP_HISTORY'] as const) process.env[name] = 'true';
    const input = getRagDeps().ragEnv();
    expect([input.RAG_QUERY_SUBQ_FILTERS, input.RAG_TRANSLATION_GLOSSARY, input.RAG_SCOPE_GATE, input.RAG_WHATSAPP_HISTORY]).toEqual(['true', 'true', 'true', 'true']);
    const config = loadRagConfig(input);
    const { effective, whatsappHistory } = config.queryAdditions;
    expect([effective.subqFilters, effective.translationGlossary, effective.scopeGate, whatsappHistory]).toEqual([true, true, true, true]);
  });

  it('leaves every one of them off when unset', () => {
    resetRagDepsForTests();
    process.env.RAG_PIPELINE = 'v2';
    process.env.RAG_QUERY_LAYER = 'true';
    for (const name of ['RAG_QUERY_SUBQ_FILTERS', 'RAG_TRANSLATION_GLOSSARY', 'RAG_SCOPE_GATE', 'RAG_WHATSAPP_HISTORY'] as const) delete process.env[name];
    const { effective, whatsappHistory } = loadRagConfig(getRagDeps().ragEnv()).queryAdditions;
    expect([effective.subqFilters, effective.translationGlossary, effective.scopeGate, whatsappHistory]).toEqual([false, false, false, false]);
  });
});
