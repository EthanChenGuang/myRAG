import { beforeEach, describe, expect, test } from 'vitest';
import { enforceGlossary, loadTenantGlossary, requiredTranslations, type GlossaryPair } from '@/lib/rag/query/glossary';
import { invalidateTerminologyCache } from '@/lib/rag/terminology/load';
import { resetTerminologyLexiconForTests } from '@/lib/rag/terminology/lexicon';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';

const ZH_EN: GlossaryPair = { entryId: '00000000-0000-4000-8000-000000000001', sourceLanguage: 'zh', targetLanguage: 'en', sources: ['星桥模块'], target: 'Starbridge Module' };
const ZH_IT: GlossaryPair = { entryId: '00000000-0000-4000-8000-000000000002', sourceLanguage: 'zh', targetLanguage: 'it', sources: ['星桥模块'], target: 'Modulo Ponte Stellare' };
const EN_ZH: GlossaryPair = { entryId: '00000000-0000-4000-8000-000000000003', sourceLanguage: 'en', targetLanguage: 'zh', sources: ['quartz relay unit'], target: '石英中继单元' };
const IT_EN: GlossaryPair = { entryId: '00000000-0000-4000-8000-000000000004', sourceLanguage: 'it', targetLanguage: 'en', sources: ['unità di raccordo'], target: 'junction unit' };
const ELIDED: GlossaryPair = { entryId: '00000000-0000-4000-8000-000000000005', sourceLanguage: 'it', targetLanguage: 'en', sources: ['indice sintetico'], target: 'synthetic index' };

const PAIRS = [ZH_EN, ZH_IT, EN_ZH, IT_EN, ELIDED];

describe('requiredTranslations', () => {
  test('a zh source term with a zh to en row requires its en target; the zh to it row is ignored', () => {
    const required = requiredTranslations('星桥模块的周期是多少？', 'zh', 'en', PAIRS);
    expect(required.map((item) => item.target)).toEqual(['Starbridge Module']);
    expect(required[0]!.entryId).toBe(ZH_EN.entryId);
  });

  test('a multi-word Latin source term is found on word boundaries, case-insensitively', () => {
    expect(requiredTranslations('How often does the Quartz Relay Unit report?', 'en', 'zh', PAIRS).map((item) => item.target)).toEqual(['石英中继单元']);
    expect(requiredTranslations('How often does the quartz relay units report?', 'en', 'zh', PAIRS)).toEqual([]);
  });

  test('accents and elisions follow normalizeLexical', () => {
    expect(requiredTranslations("Quando si aggiorna l'unita di raccordo?", 'it', 'en', PAIRS).map((item) => item.target)).toEqual(['junction unit']);
    expect(requiredTranslations("Che cosa misura l'indice sintetico?", 'it', 'en', PAIRS).map((item) => item.target)).toEqual(['synthetic index']);
  });

  test('an empty or absent glossary gives no requirements', () => {
    expect(requiredTranslations('星桥模块的周期是多少？', 'zh', 'en', [])).toEqual([]);
    expect(requiredTranslations('星桥模块的周期是多少？', 'zh', 'en', null)).toEqual([]);
  });
});

describe('enforceGlossary', () => {
  const required = requiredTranslations('星桥模块的周期是多少？', 'zh', 'en', PAIRS);

  test('the required target present gives ok and the output unchanged', () => {
    expect(enforceGlossary('What is the cycle of the Starbridge Module?', required)).toEqual({
      status: 'ok',
      text: 'What is the cycle of the Starbridge Module?',
    });
  });

  test('target missing but the source surface still in the output gives exactly one replacement', () => {
    expect(enforceGlossary('What is the cycle of the 星桥模块 and the 星桥模块 log?', required)).toEqual({
      status: 'corrected',
      text: 'What is the cycle of the Starbridge Module and the 星桥模块 log?',
      replacements: 1,
    });
  });

  test('a Latin source surface is replaced in the original spelling of the output', () => {
    const latin = requiredTranslations('Come si configura la Unità di Raccordo?', 'it', 'en', PAIRS);
    expect(enforceGlossary('How is the Unità di Raccordo configured?', latin)).toEqual({
      status: 'corrected',
      text: 'How is the junction unit configured?',
      replacements: 1,
    });
  });

  test('neither the target nor the source surface gives lost', () => {
    expect(enforceGlossary('What is the cycle of the star bridge part?', required)).toEqual({ status: 'lost' });
  });

  test('no requirement gives ok', () => {
    expect(enforceGlossary('Any text at all', [])).toEqual({ status: 'ok', text: 'Any text at all' });
  });
});

function fakeClient(rowsByTenant: Record<string, Array<Record<string, unknown>>>): { client: RpcClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      const tenant = String(args.p_tenant_key);
      calls.push(`${name}:${tenant}`);
      const result = { data: rowsByTenant[tenant] ?? [], error: null };
      const request = Promise.resolve(result) as Promise<typeof result> & { abortSignal: (signal: AbortSignal) => unknown };
      request.abortSignal = () => request;
      return request;
    },
  } as unknown as RpcClient;
  return { client, calls };
}

function translationRow(entryId: string, source: string, target: string, sourceLanguage: string, targetLanguage: string, version: number) {
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

describe('loadTenantGlossary', () => {
  beforeEach(() => {
    invalidateTerminologyCache('all');
    resetTerminologyLexiconForTests();
  });

  test("tenant B's rows never appear in tenant A's requirements", async () => {
    const tenantA = mintScope('personal', '11111111-1111-4111-8111-111111111111', null);
    const tenantB = mintScope('personal', '22222222-2222-4222-8222-222222222222', null);
    const { client, calls } = fakeClient({
      'u:11111111-1111-4111-8111-111111111111': [translationRow('00000000-0000-4000-8000-00000000000a', '星桥模块', 'Starbridge Module', 'zh', 'en', 3)],
      'u:22222222-2222-4222-8222-222222222222': [translationRow('00000000-0000-4000-8000-00000000000b', '月港组件', 'Moonharbor Part', 'zh', 'en', 7)],
    });
    const a = await loadTenantGlossary(tenantA, { client });
    const b = await loadTenantGlossary(tenantB, { client });
    expect(a?.pairs.map((pair) => pair.target)).toEqual(['Starbridge Module']);
    expect(b?.pairs.map((pair) => pair.target)).toEqual(['Moonharbor Part']);
    expect(a?.version).toBe('s1.w3');
    expect(requiredTranslations('月港组件和星桥模块', 'zh', 'en', a)).toEqual([expect.objectContaining({ target: 'Starbridge Module' })]);
    expect(calls).toEqual(['rag_term_effective:u:11111111-1111-4111-8111-111111111111', 'rag_term_effective:u:22222222-2222-4222-8222-222222222222']);
  });

  test('a load failure gives null, never a throw', async () => {
    const tenant = mintScope('personal', '33333333-3333-4333-8333-333333333333', null);
    const client = {
      rpc() {
        const request = Promise.resolve({ data: null, error: { code: 'XX000' } }) as Promise<unknown> & { abortSignal: () => unknown };
        request.abortSignal = () => request;
        return request;
      },
    } as unknown as RpcClient;
    await expect(loadTenantGlossary(tenant, { client })).resolves.toBeNull();
  });
});
