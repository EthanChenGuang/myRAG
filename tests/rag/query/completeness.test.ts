import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkDecompositionCompleteness,
  collectRequiredTerms,
  containsTerm,
  type RequiredTerm,
} from '@/lib/rag/query/completeness';
import { checkSubQuestions, checkSubQuestionsWithCompleteness, DEFAULT_POST_CHECK_LIMITS } from '@/lib/rag/query/post-checks';
import { finishDecompose } from '@/lib/rag/query/llamaindex/decompose';
import { needsRewrite } from '@/lib/rag/query/rewrite-gate';
import { loadTenantVocabulary, resetTenantVocabularyCacheForTests } from '@/lib/rag/query/tenant-vocabulary';
import { mintScope } from '@/lib/rag/tenant/scope';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';

const LIMITS = DEFAULT_POST_CHECK_LIMITS;
const NOW = new Date('2026-06-15T12:00:00Z');

function gateOf(query: string) {
  return needsRewrite(query, { hasHistory: false, now: NOW });
}

function required(query: string, sources: Parameters<typeof collectRequiredTerms>[2] = {}): RequiredTerm[] {
  return collectRequiredTerms(query, gateOf(query), sources);
}

function repair(query: string, questions: string[], sources: Parameters<typeof collectRequiredTerms>[2] = {}) {
  const gate = gateOf(query);
  return checkSubQuestionsWithCompleteness(
    { questions, input: query, protectedTokens: gate.protectedTokens },
    LIMITS,
    collectRequiredTerms(query, gate, sources),
  );
}

afterEach(() => {
  resetRagDepsForTests();
  resetTenantVocabularyCacheForTests();
});

describe('collectRequiredTerms', () => {
  it('collects protected tokens, explicit dates and years once each, a year inside a date not twice', () => {
    const terms = required('Compare QX-210 on 2024-03-01 with the 2025 figures.');
    expect(terms.map((t) => [t.cls, t.surface])).toEqual([
      ['protected', 'QX-210'],
      ['period', '2024-03-01'],
      ['period', '2025'],
    ]);
  });

  it('takes the relative-time spans the gate matched (R2) as periods', () => {
    const query = 'Compare the sample index last year and this year.';
    expect(gateOf(query).reasons).toContain('R2_RELATIVE_TIME');
    expect(required(query).map((t) => [t.cls, t.surface])).toEqual([
      ['period', 'last year'],
      ['period', 'this year'],
    ]);
  });

  it('finds Latin entities: capitalized runs not at a sentence start and not stopwords', () => {
    const terms = required('How do the Alder Module and the Birch Module differ? The Cedar unit is new.');
    expect(terms.filter((t) => t.cls === 'entity').map((t) => t.surface)).toEqual(['Alder Module', 'Birch Module', 'Cedar']);
    expect(required('Alder notes are short.').filter((t) => t.cls === 'entity')).toEqual([]);
  });

  it('finds no heuristic entity in Han text; Han terms come only from vocabulary and dictionary matches', () => {
    const query = '标准模块和高级模块有什么区别？';
    expect(required(query)).toEqual([]);
    const terms = required(query, { vocabulary: [{ label: '标准模块', aliases: [] }], termSurfaces: ['高级模块'] });
    expect(terms.map((t) => [t.cls, t.surface])).toEqual([
      ['scope', '标准模块'],
      ['entity', '高级模块'],
    ]);
  });

  it('adds vocabulary values only when the tenant has them, matched through label or alias', () => {
    const query = 'Quali sono le regole del modulo campione per la zona alfa e per la zona beta?';
    expect(required(query).filter((t) => t.cls === 'scope')).toEqual([]);
    const vocabulary = [
      { label: 'Zona Alfa', aliases: [] },
      { label: 'Settore Beta', aliases: ['zona beta'] },
      { label: 'Zona Gamma', aliases: [] },
    ];
    const terms = required(query, { vocabulary }).filter((t) => t.cls === 'scope');
    expect(terms.map((t) => t.surface)).toEqual(['zona alfa', 'zona beta']);
  });
});

describe('containsTerm', () => {
  it('ignores case, accent and elision differences for lexical classes (normalizeLexical)', () => {
    const [entity] = required('Quali regole valgono per la Città Alfa?').filter((t) => t.cls === 'entity');
    expect(entity.surface).toBe('Città Alfa');
    expect(containsTerm("Quali regole valgono nella citta alfa?", entity)).toBe(true);
    const [elided] = required("Cosa dice l'Archivio Nord sul modulo?").filter((t) => t.cls === 'entity');
    expect(containsTerm("cosa dice l' archivio nord?", elided)).toBe(true);
  });

  it('keeps the verbatim rule for protected tokens', () => {
    const [token] = required('What does QX-210 report?');
    expect(token.cls).toBe('protected');
    expect(containsTerm('What does qx-210 report?', token)).toBe(false);
    expect(containsTerm('What does QX-210 report now?', token)).toBe(true);
  });
});

describe('checkDecompositionCompleteness repairs', () => {
  it('clones the sibling sub-question for a dropped period (R2 span)', () => {
    const result = repair('Compare the sample index last year and this year.', ['What was the sample index last year?']);
    expect(result.subQuestions).toEqual(['What was the sample index last year?', 'What was the sample index this year?']);
    expect(result.completeness).toEqual({ required_count: 2, missing_count: 1, action: 'added' });
  });

  it('clones the sibling sub-question for a dropped scope value', () => {
    const query = 'Quali sono le regole del modulo campione per la zona alfa e per la zona beta?';
    const vocabulary = [
      { label: 'Zona Alfa', aliases: [] },
      { label: 'Zona Beta', aliases: [] },
    ];
    const result = repair(query, ['Quali sono le regole del modulo campione per la Zona Alfa?'], { vocabulary });
    expect(result.subQuestions).toEqual([
      'Quali sono le regole del modulo campione per la Zona Alfa?',
      'Quali sono le regole del modulo campione per la zona beta?',
    ]);
    expect(result.completeness?.action).toBe('added');
  });

  it('repairs a dropped protected token that the union check alone would discard', () => {
    const query = '比较 QX-210 和 QX-220 的状态码含义有什么区别？';
    const kept = ['QX-210 的状态码含义是什么？'];
    const tokens = gateOf(query).protectedTokens;
    expect(checkSubQuestions({ questions: kept, input: query, protectedTokens: tokens }, LIMITS).subQuestions).toEqual([]);
    const result = repair(query, kept);
    expect(result.subQuestions).toEqual(['QX-210 的状态码含义是什么？', 'QX-220 的状态码含义是什么？']);
    expect(result.skipped).toEqual([]);
    expect(result.completeness).toEqual({ required_count: 2, missing_count: 1, action: 'added' });
  });

  it('clones for a dropped entity', () => {
    const result = repair('How do the Alder Module and the Birch Module differ in setup?', ['How is the Alder Module set up?']);
    expect(result.subQuestions).toEqual(['How is the Alder Module set up?', 'How is the Birch Module set up?']);
  });

  it('adds the original question when no sibling of the class exists', () => {
    const query = 'What does the sample guide say about 2024 and the Alder Module?';
    const result = repair(query, ['What does the sample guide say about 2024?']);
    expect(result.subQuestions).toEqual(['What does the sample guide say about 2024?', query]);
    expect(result.completeness).toEqual({ required_count: 2, missing_count: 1, action: 'added' });
  });

  it('discards the decomposition when a repair needs a fifth sub-question', () => {
    const query = 'Compare the sample totals of 2023 and 2024 in each quarter.';
    const four = ['first', 'second', 'third', 'fourth'].map((q) => `What were the sample totals in the ${q} quarter of 2023?`);
    const result = repair(query, four);
    expect(result.subQuestions).toEqual([]);
    expect(result.notCompound).toBe(false);
    expect(result.completeness).toEqual({ required_count: 2, missing_count: 1, action: 'discarded' });
  });

  it('reports ok and leaves the list unchanged when every term is kept', () => {
    const query = 'How do the Alder Module and the Birch Module differ in setup?';
    const questions = ['How is the alder module set up?', 'How is the Birch Module set up?'];
    const result = repair(query, questions);
    expect(result.subQuestions).toEqual(questions);
    expect(result.completeness).toEqual({ required_count: 2, missing_count: 0, action: 'ok' });
  });

  it('never puts a term string into the completeness record', () => {
    const outcome = checkDecompositionCompleteness({
      original: 'Compare the sample index last year and this year.',
      subQuestions: ['What was the sample index last year?'],
      required: required('Compare the sample index last year and this year.'),
      maxSubQuestions: 4,
    });
    expect(Object.keys(outcome.completeness).sort()).toEqual(['action', 'missing_count', 'required_count']);
    expect(JSON.stringify(outcome.completeness)).not.toMatch(/year|sample/u);
  });
});

describe('switch off: the D-15 checks unchanged', () => {
  const input = 'compare AB12 and AB13 battery, price, weight, size, colour and warranty';
  const tokens = ['AB12', 'AB13'];
  const cases: string[][] = [
    ['battery', 'price', 'weight', 'size', 'colour', 'warranty'].map((f) => `AB12 vs AB13 ${f}`),
    ['AB12 battery', 'battery only', 'AB13 price', 'AB12 weight', 'AB13 size', 'AB12 colour'],
    ['What is the AB12 battery life?', 'What is the AB13 battery life?'],
    ['What is the AB12 battery life?', 'What is the AB12 price?'],
    [],
    [` ${input.toUpperCase()} `],
    ['AB12 and AB13 price', `AB12 ${'q'.repeat(600)}`],
  ];

  it('finishDecompose without required terms equals checkSubQuestions for every post-checks case', () => {
    for (const questions of cases) {
      const protectedTokens = questions.length === 1 ? [] : tokens;
      const expected = checkSubQuestions({ questions, input, protectedTokens }, LIMITS);
      const result = finishDecompose({ query: input, language: 'en', protectedTokens }, { questions });
      expect(result.variants.map((v) => v.text)).toEqual(expected.subQuestions.map((q) => q.trim()));
      expect(result.skipped).toEqual(expected.skipped);
      expect(result.notCompound).toBe(expected.notCompound);
      expect('completeness' in result).toBe(false);
    }
  });

  it('a completeness failure falls back to the D-15 result with a decompose skip of reason error', () => {
    const broken = [{ cls: 'entity', surface: 'x', forms: null, verbatim: false }] as unknown as RequiredTerm[];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const questions = cases[2];
    const result = finishDecompose({ query: input, language: 'en', protectedTokens: tokens, requiredTerms: broken }, { questions });
    expect(result.variants.map((v) => v.text)).toEqual(questions);
    expect(result.skipped).toEqual([{ kind: 'decompose', reason: 'error' }]);
    expect('completeness' in result).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('AB12');
    warn.mockRestore();
  });
});

describe('tenant vocabulary', () => {
  function fakeClient(rows: Record<string, unknown[]>) {
    const calls: string[] = [];
    const client = {
      rpc(name: string, args: { p_tenant_key: string }) {
        calls.push(`${name}:${args.p_tenant_key}`);
        const response = { data: rows[args.p_tenant_key] ?? [], error: null };
        return Object.assign(Promise.resolve(response), { abortSignal: () => Promise.resolve(response) });
      },
    };
    return { client, calls };
  }

  it("never makes tenant B's values required terms for tenant A, and caches per tenant key", async () => {
    const tenantA = mintScope('org', null, '00000000-0000-4000-8000-00000000000a');
    const tenantB = mintScope('org', null, '00000000-0000-4000-8000-00000000000b');
    const { client, calls } = fakeClient({
      'o:00000000-0000-4000-8000-00000000000a': [{ dimension: 'region', value: 'alfa', label: 'Zona Alfa', aliases: [], active: true }],
      'o:00000000-0000-4000-8000-00000000000b': [
        { dimension: 'region', value: 'beta', label: 'Zona Beta', aliases: [], active: true },
        { dimension: 'region', value: 'gamma', label: 'Zona Gamma', aliases: [], active: false },
      ],
    });
    const deps = { adminClient: () => client as never, now: () => 1_000 };
    const a = await loadTenantVocabulary(tenantA, { deps });
    const b = await loadTenantVocabulary(tenantB, { deps });
    expect(a?.map((v) => v.slug)).toEqual(['alfa']);
    expect(b?.map((v) => v.slug)).toEqual(['beta']);
    await loadTenantVocabulary(tenantA, { deps });
    expect(calls).toEqual([
      'rag_scope_vocabulary_for:o:00000000-0000-4000-8000-00000000000a',
      'rag_scope_vocabulary_for:o:00000000-0000-4000-8000-00000000000b',
    ]);
    const query = 'Quali sono le regole per la zona alfa e per la zona beta?';
    const scopeTerms = required(query, { vocabulary: a ?? [] }).filter((t) => t.cls === 'scope');
    expect(scopeTerms.map((t) => t.surface)).toEqual(['zona alfa']);
  });

  it('answers null on a read failure and does not cache it', async () => {
    const tenant = mintScope('single', null, null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = {
      rpc: () => {
        const response = { data: null, error: { code: 'XX000' } };
        return Object.assign(Promise.resolve(response), { abortSignal: () => Promise.resolve(response) });
      },
    };
    expect(await loadTenantVocabulary(tenant, { deps: { adminClient: () => failing as never, now: () => 0 } })).toBeNull();
    const { client } = fakeClient({ 's:default': [{ dimension: 'region', value: 'alfa', label: 'Zona Alfa', aliases: [], active: true }] });
    expect((await loadTenantVocabulary(tenant, { deps: { adminClient: () => client as never, now: () => 0 } }))?.length).toBe(1);
    warn.mockRestore();
  });
});

describe('requiredTermsFor (run-layer seam)', () => {
  it('reads vocabulary only with RAG_SCOPE_TAGS on and dictionary terms only while terminology is enabled', async () => {
    const { requiredTermsFor } = await import('@/lib/rag/query/run-layer');
    const scope = mintScope('single', null, null);
    const rpc = vi.fn(() => {
      const response = { data: [{ dimension: 'region', value: 'alfa', label: 'Zona Alfa', aliases: [], active: true }], error: null };
      return Object.assign(Promise.resolve(response), { abortSignal: () => Promise.resolve(response) });
    });
    setRagDepsForTests({ adminClient: () => ({ rpc }) as never });
    const query = 'Quali sono le regole per la zona alfa e per la zona beta?';
    const gate = gateOf(query);
    const signal = new AbortController().signal;
    const off = await requiredTermsFor({ query, gate, scope, scopeTags: false, terminology: false, signal });
    expect(off.filter((t) => t.cls === 'scope')).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    const on = await requiredTermsFor({ query, gate, scope, scopeTags: true, terminology: false, signal });
    expect(on.filter((t) => t.cls === 'scope').map((t) => t.surface)).toEqual(['zona alfa']);
    expect(rpc.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual(['rag_scope_vocabulary_for']);
  });
});
