import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { setRagDepsForTests } from '@/lib/rag/deps';
import { glossaryFor, GlossaryUnavailable, NO_GLOSSARY_VERSION } from '@/lib/rag/ingest/translate/glossary';
import { invalidateTerminologyCache } from '@/lib/rag/terminology/load';
import { resetTerminologyLexiconForTests } from '@/lib/rag/terminology/lexicon';
import { uninstallDeps } from './helpers/pipeline-fakes';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const TENANT_A = `u:${USER_A}`;
const TENANT_B = `u:${USER_B}`;
const ON = { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_TRANSLATION_GLOSSARY: 'true', MYRAG_DEPLOYMENT_MODE: 'multi-tenant' };

function row(entryId: string, source: string, target: string, sourceLanguage: string, targetLanguage: string, version: number) {
  return {
    entry_id: entryId,
    layer: 'workspace',
    canonical: target,
    variants: [source],
    normalized_variants: [],
    language: sourceLanguage,
    kind: 'translation',
    mode: 'one_way',
    source_language: sourceLanguage,
    target_language: targetLanguage,
    shared_version: 1,
    tenant_version: version,
  };
}

const TERMS: Record<string, Array<Record<string, unknown>>> = {
  [TENANT_A]: [
    row('00000000-0000-4000-8000-00000000000a', '晶格中继模块', 'lattice relay module', 'zh', 'en', 4),
    row('00000000-0000-4000-8000-00000000000b', 'modulo reticolo', 'lattice module', 'it', 'en', 4),
  ],
  [TENANT_B]: [row('00000000-0000-4000-8000-00000000000c', '晶格中继模块', 'grid relay block', 'zh', 'en', 9)],
};

function install(env: Record<string, string>, options: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const rpc: RpcClient = {
    rpc(fn, args) {
      calls.push(`${fn}:${String(args.p_tenant_key)}`);
      const response: RpcResponse =
        fn === 'rag_term_effective' && !options.fail
          ? { data: TERMS[String(args.p_tenant_key)] ?? [], error: null }
          : { data: null, error: { code: 'P0001', message: 'unavailable' } };
      const request = {
        abortSignal: () => request,
        then: (resolve: (value: RpcResponse) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(response).then(resolve, reject),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
  setRagDepsForTests({ adminClient: () => rpc as never, ragEnv: () => env as never });
  return calls;
}

describe('glossaryFor (Phase 3.2 D-29 seam, 6.2 D-14)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    invalidateTerminologyCache('all');
    resetTerminologyLexiconForTests();
    vi.stubEnv('MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
    vi.stubEnv('NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    invalidateTerminologyCache('all');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('switch off: no terms, version none, no dictionary read', async () => {
    const calls = install({});
    expect(await glossaryFor({ tenantKey: TENANT_A }, 'zh', 'en')).toEqual({ version: NO_GLOSSARY_VERSION, terms: [] });
    const rawOnly = install({ RAG_TRANSLATION_GLOSSARY: 'true' });
    expect(await glossaryFor({ tenantKey: TENANT_A }, 'zh', 'en')).toEqual({ version: NO_GLOSSARY_VERSION, terms: [] });
    expect([...calls, ...rawOnly]).toEqual([]);
  });

  it("switch on: the tenant's pairs for that direction and the TERM effective version", async () => {
    const calls = install(ON);
    const glossary = await glossaryFor({ tenantKey: TENANT_A }, 'zh', 'en');
    expect(glossary.version).not.toBe(NO_GLOSSARY_VERSION);
    expect(glossary.terms).toEqual([{ source: '晶格中继模块', target: 'lattice relay module' }]);
    expect(glossary.pairs?.map((pair) => [pair.sourceLanguage, pair.targetLanguage, pair.target])).toEqual([['zh', 'en', 'lattice relay module']]);
    expect(calls).toEqual([`rag_term_effective:${TENANT_A}`]);
  });

  it("two tenants: tenant A's glossary never carries tenant B's pairs", async () => {
    install(ON);
    const a = await glossaryFor({ tenantKey: TENANT_A }, 'zh', 'en');
    const b = await glossaryFor({ tenantKey: TENANT_B }, 'zh', 'en');
    expect(a.terms.map((term) => term.target)).toEqual(['lattice relay module']);
    expect(b.terms.map((term) => term.target)).toEqual(['grid relay block']);
    expect(a.version).not.toBe(b.version);
  });

  it('switch on and the dictionary cannot be read: GlossaryUnavailable, never an unenforced glossary', async () => {
    install(ON, { fail: true });
    await expect(glossaryFor({ tenantKey: TENANT_A }, 'zh', 'en')).rejects.toBeInstanceOf(GlossaryUnavailable);
    await expect(glossaryFor({ tenantKey: 'not-a-key' }, 'zh', 'en')).rejects.toBeInstanceOf(GlossaryUnavailable);
  });
});
