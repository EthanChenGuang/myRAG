import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { resetIdentifierPatternCacheForTests } from '@/lib/rag/identifiers/patterns';
import { DICT_TOKEN_PREFIX } from '@/lib/rag/lexical/options';
import { resetLexicalOptionsForTests, resolveLexicalOptions, type LexicalSwitches } from '@/lib/rag/lexical/resolve-options';
import { lexicalTokens, queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { loadTenantGlossary, requiredTranslations } from '@/lib/rag/query/glossary';
import { resetTerminologyLexiconForTests } from '@/lib/rag/terminology/lexicon';
import { invalidateTerminologyCache } from '@/lib/rag/terminology/load';
import { mintScope } from '@/lib/rag/tenant/scope';

/**
 * 06.2-25 Task 3 (XLG-05, D-14): glossary pairs are TERM translation entries, so their targets reach the Phase 4.2 LANG-07 tokenizer
 * dictionary through the same per-tenant loader and become one lexical term each. Invented, neutral terms only.
 */
const LATIN_SOURCE = 'vorla tenki';
const LATIN_TARGET = 'mirasto delvane';
const HAN_SOURCE = 'qelto rimbas';
const HAN_TARGET = '星蓝矩阵';

const USER_A = '11111111-1111-4111-8111-1111111625a1';
const USER_B = '22222222-2222-4222-8222-2222222625b1';
const scopeA = mintScope('personal', USER_A, null);
const scopeB = mintScope('personal', USER_B, null);
const KEY_A = `u:${USER_A}`;

type Row = Record<string, unknown>;

function translation(id: string, target: string, sources: string[], targetLanguage: string): Row {
  return {
    entry_id: id,
    layer: 'workspace',
    canonical: target,
    variants: sources,
    normalized_variants: sources,
    language: 'en',
    kind: 'translation',
    mode: 'one_way',
    source_language: 'en',
    target_language: targetLanguage,
    shared_version: 3,
    tenant_version: 5,
  };
}

const DICT_A: Row[] = [translation('00000000-0000-4000-8000-0000000625c1', LATIN_TARGET, [LATIN_SOURCE], 'it'), translation('00000000-0000-4000-8000-0000000625c2', HAN_TARGET, [HAN_SOURCE], 'zh')];

function fakeClient(): RpcClient {
  return {
    rpc(fn, args) {
      const tenant = (args as Row | undefined)?.p_tenant_key;
      let response: RpcResponse;
      if (fn === 'rag_term_effective') response = { data: tenant === KEY_A ? DICT_A : [], error: null };
      else if (fn === 'rag_identifier_patterns_list') response = { data: [], error: null };
      else response = { data: null, error: { message: 'unknown', code: 'PGRST202' } };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

const DICTIONARY_ON: LexicalSwitches = { v2: { lexicalDictionary: true, lexicalStemIt: false, identifierIndex: false } };
const dictTokens = (tokens: string[]) => tokens.filter((token) => token.startsWith(DICT_TOKEN_PREFIX));

beforeEach(() => {
  const client = fakeClient();
  setRagDepsForTests({ adminClient: () => client as never, now: () => 1_000_000 });
  setIngestDepsForTests({ db: () => client, now: () => 1_000_000 });
  invalidateTerminologyCache('all');
  resetTerminologyLexiconForTests();
  resetIdentifierPatternCacheForTests();
});

afterEach(() => {
  resetLexicalOptionsForTests();
  resetRagDepsForTests();
  resetIngestDepsForTests();
  invalidateTerminologyCache('all');
  resetIdentifierPatternCacheForTests();
  vi.restoreAllMocks();
});

describe('glossary targets in the LANG-07 tokenizer dictionary (D-14)', () => {
  it('a multi-word Latin required translation is one lexical term for its target language', async () => {
    const glossary = await loadTenantGlossary(scopeA, { client: fakeClient(), now: () => 1_000_000 });
    const required = requiredTranslations(`What does ${LATIN_SOURCE} cover?`, 'en', 'it', glossary!);
    expect(required.map((item) => item.target)).toEqual([LATIN_TARGET]);

    const { options } = await resolveLexicalOptions(scopeA, DICTIONARY_ON, { language: 'it' });
    const indexed = dictTokens(lexicalTokens(`Il documento descrive ${LATIN_TARGET} in breve.`, options));
    expect(indexed).toEqual([`${DICT_TOKEN_PREFIX}mirasto_delvane`]);
    expect(dictTokens(queryLexicalTokens(`Che cosa copre ${LATIN_TARGET}?`, options))).toEqual(indexed);
  });

  it('a Han glossary target is one term in the zh segmentation', async () => {
    const glossary = await loadTenantGlossary(scopeA, { client: fakeClient(), now: () => 1_000_000 });
    const required = requiredTranslations(`Where is ${HAN_SOURCE} described?`, 'en', 'zh', glossary!);
    expect(required.map((item) => item.target)).toEqual([HAN_TARGET]);

    const { options } = await resolveLexicalOptions(scopeA, DICTIONARY_ON, { language: 'zh' });
    expect(dictTokens(lexicalTokens(`文档说明${HAN_TARGET}的范围`, options))).toEqual([`${DICT_TOKEN_PREFIX}${HAN_TARGET}`]);
  });

  it("another tenant's dictionary holds no glossary target of this tenant", async () => {
    const { options } = await resolveLexicalOptions(scopeB, DICTIONARY_ON, { language: 'it' });
    expect(dictTokens(lexicalTokens(`Il documento descrive ${LATIN_TARGET}.`, options))).toEqual([]);
  });
});
