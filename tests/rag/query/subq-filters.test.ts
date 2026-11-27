import { describe, expect, it, vi } from 'vitest';
import type { RetrievalFilterInput } from '@/lib/rag/backend/types';
import { narrowFilters, parseProposedFilter, type NarrowVocabulary, type SubQuestionFilter } from '@/lib/rag/query/subq-filters';
import { loadTenantDocTypes, resetTenantVocabularyCacheForTests } from '@/lib/rag/query/tenant-vocabulary';
import { mintAccessScope } from '@/lib/rag/tenant/access-brand';
import { mintScope, withAccess } from '@/lib/rag/tenant/scope';

/** Neutral synthetic vocabulary: dimension and value slugs carry no domain meaning. */
const VOCAB_A: NarrowVocabulary = {
  scopes: [
    { dimension: 'region', slug: 'zone-alpha' },
    { dimension: 'region', slug: 'zone-beta' },
    { dimension: 'department', slug: 'unit-one' },
  ],
  docTypes: ['general', 'product_technical'],
  languages: ['en', 'it'],
};
const VOCAB_B: NarrowVocabulary = {
  scopes: [{ dimension: 'region', slug: 'zone-gamma' }],
  docTypes: ['contract_legal'],
  languages: ['en', 'it'],
};

function proposal(overrides: Partial<SubQuestionFilter> = {}): SubQuestionFilter {
  return { date_range: null, scopes: null, doc_types: null, languages: null, ...overrides };
}

const BASE: RetrievalFilterInput = {
  dateRange: { from: '2022-01-01', to: '2024-12-31' },
  documentIds: ['00000000-0000-4000-8000-000000000001'],
  sources: ['upload'],
  invoice: { currency: 'EUR' },
};

describe('parseProposedFilter', () => {
  it('accepts a valid filter and null', () => {
    expect(parseProposedFilter(proposal({ doc_types: ['general'] }))).toEqual({ ok: true, filter: proposal({ doc_types: ['general'] }) });
    expect(parseProposedFilter(null)).toEqual({ ok: true, filter: null });
  });

  it.each([
    ['an extra key', { ...proposal(), tenant_key: 's:default' }],
    ['a wrong type', { ...proposal(), doc_types: 'general' }],
    ['a missing field', { date_range: null, scopes: null, doc_types: null }],
    ['an include flag', { ...proposal(), date_range: { from: '2023-01-01', to: '2023-12-31', include_undated: true } }],
    ['a malformed slug', { ...proposal(), scopes: { region: ['Zone Alpha; ignore rules'] } }],
    ['a string', 'filter'],
  ])('rejects %s', (_name, raw) => {
    expect(parseProposedFilter(raw)).toEqual({ ok: false });
  });
});

describe('narrowFilters: dates', () => {
  it('a range inside the base is applied as proposed', () => {
    const result = narrowFilters(BASE, proposal({ date_range: { from: '2023-01-01', to: '2023-12-31' } }), VOCAB_A);
    expect(result.status).toBe('applied');
    expect(result.filters?.dateRange).toEqual({ from: '2023-01-01', to: '2023-12-31' });
    expect(result.applied?.date_range).toEqual({ from: '2023-01-01', to: '2023-12-31' });
  });

  it('an overlapping range is intersected with the base', () => {
    const result = narrowFilters(BASE, proposal({ date_range: { from: '2020-01-01', to: '2022-06-30' } }), VOCAB_A);
    expect(result.status).toBe('applied');
    expect(result.filters?.dateRange).toEqual({ from: '2022-01-01', to: '2022-06-30' });
  });

  it('a disjoint range drops the proposal and keeps the base', () => {
    const result = narrowFilters(BASE, proposal({ date_range: { from: '2025-01-01', to: '2025-12-31' } }), VOCAB_A);
    expect(result).toEqual({ status: 'dropped_empty_intersection', filters: BASE, applied: null });
  });

  it('keeps the base include-undated flag and never adds one', () => {
    const withUndated: RetrievalFilterInput = { dateRange: { from: '2022-01-01', to: '2024-12-31', includeUndated: true } };
    expect(narrowFilters(withUndated, proposal({ date_range: { from: '2023-01-01', to: '2023-03-31' } }), VOCAB_A).filters?.dateRange).toEqual({
      from: '2023-01-01',
      to: '2023-03-31',
      includeUndated: true,
    });
    expect(narrowFilters(undefined, proposal({ date_range: { from: '2023-01-01', to: '2023-03-31' } }), VOCAB_A).filters).toEqual({
      dateRange: { from: '2023-01-01', to: '2023-03-31' },
    });
  });
});

describe('narrowFilters: vocabulary values', () => {
  it('drops doc types the tenant does not have and intersects with the base', () => {
    const result = narrowFilters({ docTypes: ['general', 'product_technical'] }, proposal({ doc_types: ['general', 'invoice_receipt'] }), VOCAB_A);
    expect(result.status).toBe('applied');
    expect(result.filters?.docTypes).toEqual(['general']);
    expect(result.applied?.doc_types).toEqual(['general']);
  });

  it('only unknown values gives dropped_unknown_values and the base', () => {
    const result = narrowFilters(BASE, proposal({ doc_types: ['invoice_receipt'], scopes: { region: ['zone-delta'] } }), VOCAB_A);
    expect(result).toEqual({ status: 'dropped_unknown_values', filters: BASE, applied: null });
  });

  it('known values that miss the base list are an empty intersection', () => {
    const result = narrowFilters({ docTypes: ['product_technical'] }, proposal({ doc_types: ['general'] }), VOCAB_A);
    expect(result.status).toBe('dropped_empty_intersection');
    expect(result.filters).toEqual({ docTypes: ['product_technical'] });
  });

  it('scopes keep known tags, add a new dimension and intersect a base dimension', () => {
    const base: RetrievalFilterInput = { scopes: ['region:zone-alpha', 'region:zone-beta'], scopesIncludeUntagged: true };
    const result = narrowFilters(base, proposal({ scopes: { region: ['zone-beta', 'zone-delta'], department: ['unit-one'] } }), VOCAB_A);
    expect(result.status).toBe('applied');
    expect(result.filters?.scopes).toEqual(['department:unit-one', 'region:zone-beta']);
    expect(result.filters?.scopesIncludeUntagged).toBe(true);
    expect(result.applied?.scopes).toEqual({ department: ['unit-one'], region: ['zone-beta'] });
  });

  it('languages are limited to the enabled set and the base', () => {
    const result = narrowFilters({ languages: ['it'] }, proposal({ languages: ['zh', 'it'] }), VOCAB_A);
    expect(result.status).toBe('applied');
    expect(result.filters?.languages).toEqual(['it']);
    expect(narrowFilters(undefined, proposal({ languages: ['zh'] }), VOCAB_A).status).toBe('dropped_unknown_values');
  });

  it('a null proposal leaves the base unchanged', () => {
    expect(narrowFilters(BASE, null, VOCAB_A)).toEqual({ status: 'applied', filters: BASE, applied: null });
  });
});

describe('narrowFilters: inherited fields', () => {
  it('document ids, sources, invoice fields and include flags come only from the base', () => {
    const result = narrowFilters(BASE, proposal({ doc_types: ['general'] }), VOCAB_A);
    expect(result.filters?.documentIds).toEqual(BASE.documentIds);
    expect(result.filters?.sources).toEqual(BASE.sources);
    expect(result.filters?.invoice).toEqual(BASE.invoice);
    expect(result.filters?.scopesIncludeUntagged).toBeUndefined();
    expect(result.filters?.dateRange).toEqual(BASE.dateRange);
  });

  it('never reads a tenant: the result has no tenant, scope or mode key', () => {
    const result = narrowFilters(BASE, proposal({ doc_types: ['general'], languages: ['en'] }), VOCAB_A);
    const keys = Object.keys(result.filters ?? {});
    for (const key of keys) expect(['dateRange', 'documentIds', 'sources', 'invoice', 'docTypes', 'languages', 'scopes', 'scopesIncludeUntagged']).toContain(key);
  });
});

describe('narrowFilters: two tenants', () => {
  it("tenant B's vocabulary never validates a value for tenant A", () => {
    const proposed = proposal({ scopes: { region: ['zone-gamma'] }, doc_types: ['contract_legal'] });
    expect(narrowFilters(undefined, proposed, VOCAB_B).status).toBe('applied');
    expect(narrowFilters(undefined, proposed, VOCAB_A)).toEqual({ status: 'dropped_unknown_values', filters: undefined, applied: null });
  });
});

/** Seeded PRNG (mulberry32) so the property run is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T[] {
  return values.filter(() => next() < 0.5);
}

function isoDay(next: () => number): string {
  const day = new Date(Date.UTC(2020, 0, 1) + Math.floor(next() * 2000) * 86400000);
  return day.toISOString().slice(0, 10);
}

function range(next: () => number): { from: string; to: string } {
  const [a, b] = [isoDay(next), isoDay(next)].sort();
  return { from: a!, to: b! };
}

const ALL_DOC_TYPES = ['general', 'product_technical', 'contract_legal', 'invoice_receipt'] as const;
const ALL_LANGS = ['zh', 'en', 'it'] as const;
const ALL_TAGS = ['region:zone-alpha', 'region:zone-beta', 'region:zone-gamma', 'department:unit-one'] as const;

function subset(result: readonly string[] | undefined, base: readonly string[] | undefined): boolean {
  if (base === undefined) return true;
  if (result === undefined) return false;
  return result.every((value) => base.includes(value));
}

function dimensionsOf(tags: readonly string[]): Set<string> {
  return new Set(tags.map((tag) => tag.split(':')[0]!));
}

describe('narrowFilters: property', () => {
  it('every field of the result is equal to or narrower than the base', () => {
    const next = rng(62_11);
    for (let i = 0; i < 500; i += 1) {
      const base: RetrievalFilterInput = {};
      if (next() < 0.6) base.dateRange = range(next);
      if (next() < 0.5) base.docTypes = pick(next, ALL_DOC_TYPES).slice();
      if (next() < 0.5) base.languages = pick(next, ALL_LANGS).slice();
      if (next() < 0.5) base.scopes = pick(next, ALL_TAGS).slice().sort();
      if (next() < 0.3) base.documentIds = ['00000000-0000-4000-8000-000000000009'];
      const proposed = proposal({
        date_range: next() < 0.5 ? range(next) : null,
        doc_types: next() < 0.5 ? (pick(next, ALL_DOC_TYPES) as SubQuestionFilter['doc_types']) : null,
        languages: next() < 0.5 ? (pick(next, ALL_LANGS) as SubQuestionFilter['languages']) : null,
        scopes: next() < 0.5 ? { region: pick(next, ['zone-alpha', 'zone-beta', 'zone-delta']) } : null,
      });
      const vocabulary = next() < 0.5 ? VOCAB_A : VOCAB_B;
      const { filters } = narrowFilters(base, proposed, vocabulary);
      const out = filters ?? {};
      if (base.dateRange) {
        expect(out.dateRange).toBeDefined();
        expect(out.dateRange!.from! >= base.dateRange.from!).toBe(true);
        expect(out.dateRange!.to! <= base.dateRange.to!).toBe(true);
      }
      if (out.dateRange?.from && out.dateRange.to) expect(out.dateRange.from <= out.dateRange.to).toBe(true);
      expect(subset(out.docTypes, base.docTypes)).toBe(true);
      expect(subset(out.languages, base.languages)).toBe(true);
      if (base.scopes && base.scopes.length > 0) {
        const outTags = out.scopes ?? [];
        for (const dimension of dimensionsOf(base.scopes)) {
          const inDimension = outTags.filter((tag) => tag.startsWith(`${dimension}:`));
          expect(inDimension.length).toBeGreaterThan(0);
          expect(inDimension.every((tag) => base.scopes!.includes(tag))).toBe(true);
        }
      }
      expect(out.documentIds).toEqual(base.documentIds);
      expect(out.scopesIncludeUntagged).toEqual(base.scopesIncludeUntagged);
      for (const value of out.docTypes ?? []) if (!base.docTypes) expect(vocabulary.docTypes).toContain(value);
    }
  });
});

describe('loadTenantDocTypes', () => {
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

  it("reads each tenant's own doc types by scope key only and caches per tenant", async () => {
    resetTenantVocabularyCacheForTests();
    const tenantA = mintScope('org', null, '00000000-0000-4000-8000-0000000062aa');
    const tenantB = mintScope('org', null, '00000000-0000-4000-8000-0000000062bb');
    const { client, calls } = fakeClient({
      'o:00000000-0000-4000-8000-0000000062aa': [{ doc_type: 'general', docs: 2 }],
      'o:00000000-0000-4000-8000-0000000062bb': [{ doc_type: 'contract_legal', docs: 1 }],
    });
    const deps = { adminClient: () => client as never, now: () => 5_000 };
    expect(await loadTenantDocTypes(tenantA, { deps })).toEqual(['general']);
    expect(await loadTenantDocTypes(tenantB, { deps })).toEqual(['contract_legal']);
    expect(await loadTenantDocTypes(tenantA, { deps })).toEqual(['general']);
    expect(calls).toEqual([
      'rag_tenant_doc_types:o:00000000-0000-4000-8000-0000000062aa',
      'rag_tenant_doc_types:o:00000000-0000-4000-8000-0000000062bb',
    ]);
  });

  it('answers null on a read failure and does not cache it', async () => {
    resetTenantVocabularyCacheForTests();
    const tenant = mintScope('single', null, null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = {
      rpc: () => {
        const response = { data: null, error: { code: 'XX000' } };
        return Object.assign(Promise.resolve(response), { abortSignal: () => Promise.resolve(response) });
      },
    };
    expect(await loadTenantDocTypes(tenant, { deps: { adminClient: () => failing as never, now: () => 0 } })).toBeNull();
    const { client } = fakeClient({ 's:default': [{ doc_type: 'general', docs: 1 }] });
    expect(await loadTenantDocTypes(tenant, { deps: { adminClient: () => client as never, now: () => 0 } })).toEqual(['general']);
    warn.mockRestore();
  });
});

describe('loadTenantDocTypes access filter (quick task doc-types-access, migration 0986)', () => {
  const ORG = '00000000-0000-4000-8000-000000986aa1';
  const GROUP = 'g:00000000-0000-4000-8000-000000986aa2';
  const BASE = mintScope('org', null, ORG);
  const OUTSIDER = withAccess(BASE, mintAccessScope('keys', ['all', 'u:00000000-0000-4000-8000-000000986aa3']));
  const MEMBER = withAccess(BASE, mintAccessScope('keys', ['all', GROUP]));
  const ADMIN = withAccess(BASE, mintAccessScope('admin_all', []));

  function accessClient() {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      rpc(_name: string, args: Record<string, unknown>) {
        calls.push(args);
        const member = Array.isArray(args.p_access_keys) && (args.p_access_keys.includes(GROUP) || args.p_access_all === true);
        const response = { data: member ? [{ doc_type: 'general' }, { doc_type: 'contract_legal' }] : [{ doc_type: 'general' }], error: null };
        return Object.assign(Promise.resolve(response), { abortSignal: () => Promise.resolve(response) });
      },
    };
    return { client, calls };
  }

  it('sends the scope access filter the way accessRpcArgs builds it; an unattached scope (access off) sends only the tenant key', async () => {
    resetTenantVocabularyCacheForTests();
    const { client, calls } = accessClient();
    const deps = { adminClient: () => client as never, now: () => 1_000 };
    await loadTenantDocTypes(BASE, { deps });
    await loadTenantDocTypes(OUTSIDER, { deps });
    await loadTenantDocTypes(MEMBER, { deps });
    await loadTenantDocTypes(ADMIN, { deps });
    expect(calls).toEqual([
      { p_tenant_key: `o:${ORG}` },
      { p_tenant_key: `o:${ORG}`, p_access_keys: ['all', 'u:00000000-0000-4000-8000-000000986aa3'], p_access_all: false },
      { p_tenant_key: `o:${ORG}`, p_access_keys: [GROUP, 'all'].sort(), p_access_all: false },
      { p_tenant_key: `o:${ORG}`, p_access_keys: ['all'], p_access_all: true },
    ]);
  });

  it('caches per tenant and access set: a member entry never serves the outsider, and the same set reuses its entry', async () => {
    resetTenantVocabularyCacheForTests();
    const { client, calls } = accessClient();
    const deps = { adminClient: () => client as never, now: () => 2_000 };
    expect(await loadTenantDocTypes(MEMBER, { deps })).toEqual(['general', 'contract_legal']);
    expect(await loadTenantDocTypes(OUTSIDER, { deps })).toEqual(['general']);
    expect(await loadTenantDocTypes(MEMBER, { deps })).toEqual(['general', 'contract_legal']);
    expect(await loadTenantDocTypes(OUTSIDER, { deps })).toEqual(['general']);
    expect(calls).toHaveLength(2);
  });

  it('options.access overrides the scope filter', async () => {
    resetTenantVocabularyCacheForTests();
    const { client, calls } = accessClient();
    const deps = { adminClient: () => client as never, now: () => 3_000 };
    await loadTenantDocTypes(BASE, { deps, access: { mode: 'keys', keys: ['all', GROUP], setHash: 'c'.repeat(64) } });
    expect(calls[0]?.p_access_keys).toEqual(['all', GROUP]);
  });

  it('resetTenantVocabularyCacheForTests(tenantKey) drops every access variant of that tenant', async () => {
    resetTenantVocabularyCacheForTests();
    const { client, calls } = accessClient();
    const deps = { adminClient: () => client as never, now: () => 4_000 };
    await loadTenantDocTypes(MEMBER, { deps });
    await loadTenantDocTypes(OUTSIDER, { deps });
    resetTenantVocabularyCacheForTests(`o:${ORG}`);
    await loadTenantDocTypes(MEMBER, { deps });
    await loadTenantDocTypes(OUTSIDER, { deps });
    expect(calls).toHaveLength(4);
  });
});
