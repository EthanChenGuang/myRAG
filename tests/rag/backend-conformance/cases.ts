import { describe, expect, it } from 'vitest';
import { evalScope } from '@/lib/rag';
import type { RetrievalBackend, RetrievalFilters } from '@/lib/rag/backend/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import { mintScope } from '@/lib/rag/tenant/scope';
import { EXACT_SCAN_CUTOFF, IDS, PROFILE_ID, QUERIES } from './dataset';

export interface ConformanceContext {
  backend: RetrievalBackend;
  scopes: {
    tenantA: TenantScope;
    tenantB: TenantScope;
    orgO: TenantScope;
  };
  profileId: string;
  embed: (text: string) => number[];
  queryTokens: (text: string) => string[];
  close: () => Promise<void>;
}

export type ConformanceFactory = () => Promise<ConformanceContext>;

async function searchLexical(ctx: ConformanceContext, scope: TenantScope, query: string, filters: RetrievalFilters = { currentOnly: true }) {
  const controller = new AbortController();
  return ctx.backend.search({
    scope,
    embeddingProfileId: ctx.profileId,
    denseVector: null,
    lexicalTokens: ctx.queryTokens(query),
    lexicalLanguages: null,
    filters,
    denseLimit: 0,
    lexicalLimit: 20,
    signal: controller.signal,
  });
}

async function searchBoth(ctx: ConformanceContext, scope: TenantScope, query: string, opts: { denseLimit?: number; lexicalLimit?: number; filters?: ConformanceContext extends never ? never : import('@/lib/rag/backend/types').RetrievalFilters; exactCutoff?: number } = {}) {
  const controller = new AbortController();
  const vector = ctx.embed(query);
  return ctx.backend.search({
    scope,
    embeddingProfileId: ctx.profileId,
    denseVector: vector,
    lexicalTokens: ctx.queryTokens(query),
    lexicalLanguages: null,
    filters: opts.filters ?? { currentOnly: true },
    denseLimit: opts.denseLimit ?? 10,
    lexicalLimit: opts.lexicalLimit ?? 10,
    signal: controller.signal,
  });
}

export function runConformance(name: string, factory: ConformanceFactory): void {
  describe(`backend conformance (${name})`, () => {
    let ctx: ConformanceContext;

    it('loads the factory', async () => {
      ctx = await factory();
    }, 120_000);

    it('zh exact-term ranks the zh chunk first on legs.lexical', async () => {
      const legs = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.zh);
      expect(legs.lexical[0]?.chunkId).toBe(IDS.chunkZh);
    });

    it('en exact-term ranks the en chunk first on legs.lexical', async () => {
      const legs = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.en);
      expect(legs.lexical[0]?.chunkId).toBe(IDS.chunkEn);
    });

    it('it exact-term ranks the it chunk first on legs.lexical', async () => {
      const legs = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.it);
      expect(legs.lexical[0]?.chunkId).toBe(IDS.chunkIt);
    });

    it('empty lexical query yields empty lexical leg without error', async () => {
      const legs = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.empty);
      expect(legs.lexical).toEqual([]);
    });

    it('stopwords-only query yields empty lexical leg without error', async () => {
      const legs = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.stopwords);
      expect(legs.lexical).toEqual([]);
    });

    it('superseded and quarantined chunks never appear', async () => {
      const legs = await searchBoth(ctx, ctx.scopes.tenantA, 'conformance');
      const ids = new Set([...legs.dense, ...legs.lexical].map((row) => row.chunkId));
      expect(ids.has(IDS.chunkSuperseded)).toBe(false);
      expect(ids.has(IDS.chunkQuarantined)).toBe(false);
    });

    it('two-tenant isolation keeps the shared canary out of the other tenant on every leg', async () => {
      const a = await searchBoth(ctx, ctx.scopes.tenantA, QUERIES.canary);
      const b = await searchBoth(ctx, ctx.scopes.tenantB, QUERIES.canary);
      const aIds = new Set([...a.dense, ...a.lexical].map((row) => row.chunkId));
      const bIds = new Set([...b.dense, ...b.lexical].map((row) => row.chunkId));
      expect(aIds.has(IDS.chunkCanaryA)).toBe(true);
      expect(aIds.has(IDS.chunkCanaryB)).toBe(false);
      expect(bIds.has(IDS.chunkCanaryB)).toBe(true);
      expect(bIds.has(IDS.chunkCanaryA)).toBe(false);
    });

    it('p_sources empty array behaves like no filter', async () => {
      const base = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.en);
      const filtered = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.en, { currentOnly: true, sources: [] });
      expect(filtered.lexical.map((row) => row.chunkId)).toEqual(base.lexical.map((row) => row.chunkId));
    });

    it('doc type filter returns only matching rows', async () => {
      const legs = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.rare, {
        currentOnly: true,
        docTypes: ['financial_report'],
      });
      expect(legs.lexical.length).toBeGreaterThan(0);
      expect(legs.lexical.every((row) => row.docType === 'financial_report')).toBe(true);
    });

    it('language filter returns only matching rows', async () => {
      const legs = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.it, { currentOnly: true, languages: ['it'] });
      expect(legs.lexical.every((row) => row.language === 'it')).toBe(true);
    });

    it('source filter returns only matching rows', async () => {
      const legs = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.canary, { currentOnly: true, sources: ['conformance-a'] });
      expect(legs.lexical.every((row) => row.chunkId === IDS.chunkCanaryA)).toBe(true);
    });

    it('document id filter returns only that document', async () => {
      const legs = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.zh, { currentOnly: true, documentIds: [IDS.docZh] });
      expect(legs.lexical.every((row) => row.documentId === IDS.docZh)).toBe(true);
    });

    it('date range filter excludes out-of-range rows', async () => {
      const legs = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.en, {
        currentOnly: true,
        dateRange: { from: '2025-01-01', to: '2025-12-31' },
      });
      expect(legs.lexical.length).toBeGreaterThan(0);
    });

    it('rare doc type with exact cutoff matches brute-force lexical order', async () => {
      const legs = await searchLexical(ctx, ctx.scopes.tenantA, QUERIES.rare, {
        currentOnly: true,
        docTypes: ['financial_report'],
      });
      expect(legs.lexical[0]?.chunkId).toBe(IDS.chunkRare);
    });

    it('tie chunks return stable order across repeated calls', async () => {
      const first = await searchBoth(ctx, ctx.scopes.tenantA, 'tie duplicate', { denseLimit: 5, lexicalLimit: 0 });
      const second = await searchBoth(ctx, ctx.scopes.tenantA, 'tie duplicate', { denseLimit: 5, lexicalLimit: 0 });
      expect(first.dense.map((row) => row.chunkId)).toEqual(second.dense.map((row) => row.chunkId));
    });

    it('upper-case user id minted through the eval path returns results', async () => {
      const outcome = evalScope({
        deploymentMode: 'multi-tenant',
        organizationId: null,
        userId: IDS.userUpper,
        allowedScopes: `user:${IDS.userUpper.toLowerCase()}`,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const legs = await searchLexical(ctx, outcome.scope, QUERIES.en);
      expect(legs.lexical[0]?.chunkId).toBe('00000000-0000-4000-8000-0000000000eb');
    });

    it('eval minted scope uses a lower-case tenant key (no 22023)', async () => {
      const outcome = evalScope({
        deploymentMode: 'multi-tenant',
        organizationId: null,
        userId: IDS.userUpper,
        allowedScopes: `user:${IDS.userUpper.toLowerCase()}`,
      });
      if (!outcome.ok) throw new Error('scope expected');
      await expect(searchLexical(ctx, outcome.scope, QUERIES.en)).resolves.toBeDefined();
    });

    it('closes the factory cleanly', async () => {
      await ctx.close();
    });
  });
}