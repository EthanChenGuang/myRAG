import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import type { BackendSearchRequest, RetrievalBackend, RetrievalFilters } from '../../src/lib/rag/backend/types.ts';
import type { SubQuestionFilter } from '../../src/lib/rag/query/subq-filters.ts';
import type { TenantScope } from '../../src/lib/rag/tenant/scope.ts';

/**
 * 06.2-16 (QRY-10, D-06, D-08, T-06.2-45, T-06.2-46): a sub-question's narrowed filter, taken through narrowFilters, the plan and
 * the search stage's intersection, returns a subset of the shared filter's result on the real hybrid_search_chunks, never another
 * tenant's chunk, in both deployment modes; end to end, a part whose filter matches nothing still retrieves through the one retry.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = 'openai-3-small-1536';
const TOKEN = 'quillonmark';
const QUERY = `${TOKEN} synthetic ledger entry`;
const USER_B = '00000000-0000-4000-8000-0000000616b1';

interface Seed {
  docType: string;
  language: string;
  docDate: string | null;
  scopes: string[];
}

const SEEDS_A: Seed[] = [
  { docType: 'general', language: 'en', docDate: '2023-03-10', scopes: ['region:north', 'department:unit-one'] },
  { docType: 'general', language: 'it', docDate: '2023-09-01', scopes: ['region:south'] },
  { docType: 'contract_legal', language: 'en', docDate: '2024-02-14', scopes: ['region:north'] },
  { docType: 'contract_legal', language: 'zh', docDate: '2024-11-30', scopes: ['department:unit-two'] },
  { docType: 'product_technical', language: 'en', docDate: null, scopes: [] },
  { docType: 'general', language: 'en', docDate: '2025-05-05', scopes: ['region:south', 'department:unit-one'] },
];

// Tenant B holds the same token with values tenant A does not have (doc type, scope slugs).
const SEEDS_B: Seed[] = [
  { docType: 'invoice_receipt', language: 'en', docDate: '2023-04-04', scopes: ['region:east'] },
  { docType: 'general', language: 'en', docDate: '2024-06-06', scopes: ['department:unit-nine'] },
];

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

async function seedRows(db: PGlite, mode: DeploymentMode, tenantKey: string, userId: string | null, seeds: readonly Seed[]): Promise<Map<string, string>> {
  const owner = new Map<string, string>();
  for (const [index, seed] of seeds.entries()) {
    const docId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    const content = `${QUERY} row ${index} ${tenantKey}`;
    if (mode === 'multi-tenant') {
      await db.query(
        `INSERT INTO documents (id, filename, content, metadata, user_id, lineage_id, source_key, status, is_current, doc_type, doc_date, language)
         VALUES ($1, $2, $3, '{}'::jsonb, $4, $1, $5, 'ready', true, $6, $7, $8)`,
        [docId, `doc-${docId}.md`, content, userId, `legacy:${docId}`, seed.docType, seed.docDate, seed.language],
      );
    } else {
      await db.query(
        `INSERT INTO documents (id, filename, content, metadata, lineage_id, source_key, status, is_current, doc_type, doc_date, language)
         VALUES ($1, $2, $3, '{}'::jsonb, $1, $4, 'ready', true, $5, $6, $7)`,
        [docId, `doc-${docId}.md`, content, `legacy:${docId}`, seed.docType, seed.docDate, seed.language],
      );
    }
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, source, doc_date, doc_type, language, scopes)
       VALUES ($1, $2, $3, $4::vector, $3, $5, true, 'ready', 'manual', $6, $7, $8, $9::text[])`,
      [chunkId, docId, content, vec(content), tenantKey, seed.docDate, seed.docType, seed.language, seed.scopes],
    );
    owner.set(chunkId, tenantKey);
  }
  return owner;
}

const PROPOSALS: Array<{ label: string; filter: SubQuestionFilter }> = [
  { label: 'date range', filter: { date_range: { from: '2023-01-01', to: '2023-12-31' }, doc_types: null, languages: null, scopes: null } },
  { label: 'later date range', filter: { date_range: { from: '2024-01-01', to: '2025-12-31' }, doc_types: null, languages: null, scopes: null } },
  { label: 'doc type', filter: { date_range: null, doc_types: ['contract_legal'], languages: null, scopes: null } },
  { label: 'two doc types', filter: { date_range: null, doc_types: ['general', 'product_technical'], languages: null, scopes: null } },
  { label: 'language', filter: { date_range: null, doc_types: null, languages: ['en'], scopes: null } },
  { label: 'scope', filter: { date_range: null, doc_types: null, languages: null, scopes: { region: ['north'] } } },
  { label: 'two scope dimensions', filter: { date_range: null, doc_types: null, languages: null, scopes: { region: ['south'], department: ['unit-one'] } } },
  {
    label: 'every field',
    filter: { date_range: { from: '2023-01-01', to: '2025-12-31' }, doc_types: ['general'], languages: ['en'], scopes: { region: ['north', 'south'] } },
  },
];

const BASES: Array<{ label: string; filters: RetrievalFilters }> = [
  { label: 'no base filter', filters: { currentOnly: true } },
  { label: 'a base date range and doc types', filters: { currentOnly: true, dateRange: { from: '2023-06-01', to: '2025-12-31' }, docTypes: ['general', 'contract_legal'] } },
  { label: 'a base scope', filters: { currentOnly: true, scopes: ['region:south'] } },
];

// Runs first: the in-process eval route reads the process environment the per-mode suites below change.
describe('end to end: a scripted filter-returning decomposer through the eval route (single-tenant)', () => {
  const QUESTION = `How did the ${TOKEN} ledger figures differ between 2025 and 2026?`;
  const SUB_2025 = `What were the ${TOKEN} ledger figures in 2025?`;
  const SUB_2026 = `What were the ${TOKEN} ledger figures in 2026?`;
  let prepared: InProcessEval;
  let depsModule: typeof import('../../src/lib/rag/deps.ts');
  let fake: import('../../eval/harness/fake-query-llm.mts').FakeQueryLlm;
  const dated = new Set<string>();

  before(async () => {
    prepared = await prepareInProcessEval({
      corpusDir: path.join(REPO_ROOT, 'eval/fixtures/corpus'),
      deploymentMode: 'single-tenant',
      envOverrides: {
        RAG_PIPELINE: 'v2',
        RAG_LEXICAL_SEARCH: 'true',
        RAG_QUERY_LAYER: 'true',
        RAG_QUERY_DECOMPOSE: 'true',
        RAG_QUERY_SUBQ_FILTERS: 'true',
      },
    });
    const db = prepared.fixtureDb;
    for (const [index, docDate] of ['2025-02-01', '2025-08-15'].entries()) {
      const docId = crypto.randomUUID();
      const chunkId = crypto.randomUUID();
      const content = `${TOKEN} ledger figures recorded for the synthetic period, entry ${index}`;
      await db.query(
        `INSERT INTO documents (id, filename, content, metadata, lineage_id, source_key, status, is_current, doc_type, doc_date, language)
         VALUES ($1, $2, $3, '{}'::jsonb, $1, $4, 'ready', true, 'general', $5, 'en')`,
        [docId, `ledger-${index}.md`, content, `legacy:${docId}`, docDate],
      );
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, source, doc_date, doc_type, language)
         VALUES ($1, $2, $3, $4::vector, $3, 's:default', true, 'ready', 'manual', $5, 'general', 'en')`,
        [chunkId, docId, content, vec(content), docDate],
      );
      dated.add(chunkId);
    }
    const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
    const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
    depsModule = await import('../../src/lib/rag/deps.ts');
    const fakeModule = await import('../../eval/harness/fake-query-llm.mts');
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    await verifyV2Startup();
    const base = fakeModule.loadFakeQueryLlmTable();
    fake = fakeModule.createFakeQueryLlm({
      table: {
        ...base,
        entries: [
          ...base.entries,
          {
            transform: 'decompose',
            item_id: 'q62-subq-filter-retry-e2e',
            query: QUESTION,
            output: {
              questions: [
                { text: SUB_2025, filter: { date_range: { from: '2025-01-01', to: '2025-12-31' }, scopes: null, doc_types: null, languages: null } },
                { text: SUB_2026, filter: { date_range: { from: '2026-01-01', to: '2026-12-31' }, scopes: null, doc_types: null, languages: null } },
              ],
            },
          },
        ],
      } as never,
    });
    depsModule.setRagDepsForTests({ queryLlm: () => fake });
  });

  after(async () => {
    depsModule?.resetRagDepsForTests();
    await prepared?.close();
  });

  test('each part is searched with its filter, the empty part retries once, and the trace counts the searches', async () => {
    const req = new NextRequest('http://localhost/api/internal/rag/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
      body: JSON.stringify({ schema_version: 1, rag_mode: 'balanced', options: {}, query: QUESTION }),
    });
    const res = await prepared.POST(req);
    const body = await res.text();
    assert.equal(res.status, 200, body.slice(0, 400));
    const json = JSON.parse(body) as {
      query_plan: null | {
        variants: Array<{ kind: string; text: string; filter_applied?: boolean }>;
        filter_trace?: Array<{ index: number; status: string; retried: boolean; retry_skipped_cap: boolean }>;
      };
      candidates: Array<{ chunk_id: string; legs?: Record<string, number> }>;
      searches_counted?: number;
    };
    assert.ok(fake.calls.some((call) => call.transform === 'decompose'), 'the scripted decomposer ran');
    const plan = json.query_plan;
    assert.ok(plan, 'query_plan in the trace');
    const subs = plan.variants.filter((variant) => variant.kind === 'sub_question');
    assert.deepEqual(subs.map((variant) => [variant.text, variant.filter_applied]), [
      [SUB_2025, true],
      [SUB_2026, true],
    ]);
    assert.deepEqual(plan.filter_trace, [
      { index: 0, status: 'applied', retried: false, retry_skipped_cap: false },
      { index: 1, status: 'applied', retried: true, retry_skipped_cap: false },
    ]);
    assert.equal(json.searches_counted, plan.variants.length + 1);

    const index2025 = plan.variants.findIndex((variant) => variant.text === SUB_2025);
    const index2026 = plan.variants.findIndex((variant) => variant.text === SUB_2026);
    const fromList = (index: number) =>
      json.candidates.filter((row) => Object.keys(row.legs ?? {}).some((leg) => leg === `dense:${index}` || leg === `lexical:${index}`));
    const filteredPart = fromList(index2025);
    assert.ok(filteredPart.length > 0, 'the 2025 part retrieved');
    for (const row of filteredPart) assert.ok(dated.has(row.chunk_id), 'the 2025 part retrieved only its filtered documents');
    assert.ok(fromList(index2026).length > 0, 'the 2026 part still retrieved through the retry');
  });
});

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  const tenantA = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';

  describe(`sub-question filters on hybrid_search_chunks (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;
    let backend: RetrievalBackend;
    let scopeA: TenantScope;
    let owner: Map<string, string>;
    let planModule: typeof import('../../src/lib/rag/query/plan.ts');
    let subqModule: typeof import('../../src/lib/rag/query/subq-filters.ts');
    let searchModule: typeof import('../../src/lib/rag/v2/stages/search.ts');
    let accessModule: typeof import('../../src/lib/rag/tenant/access.ts');
    let tokenize: typeof import('../../src/lib/rag/lexical/tokenize.ts');

    const savedEnv = { ...process.env };

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      edge = await startFakeEdge({ db });
      const env = fixtureProcessEnv(edge.url);
      Object.assign(process.env, env);
      const client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
      const { createPgvectorBackend } = await import('../../src/lib/rag/backend/pgvector.ts');
      const { loadRagConfig } = await import('../../src/lib/rag/config.ts');
      const scopeModule = await import('../../src/lib/rag/tenant/scope.ts');
      planModule = await import('../../src/lib/rag/query/plan.ts');
      subqModule = await import('../../src/lib/rag/query/subq-filters.ts');
      searchModule = await import('../../src/lib/rag/v2/stages/search.ts');
      accessModule = await import('../../src/lib/rag/tenant/access.ts');
      tokenize = await import('../../src/lib/rag/lexical/tokenize.ts');
      const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_HNSW_ITERATIVE_SCAN: 'off', RAG_EXACT_SCAN_CUTOFF: '0' });
      backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config, pgvectorVersion: () => null });
      scopeA = mode === 'multi-tenant' ? scopeModule.mintScope('personal', FIXTURE_USER_ID, null) : scopeModule.mintScope('single', null, null);
      owner = await seedRows(db, mode, tenantA, mode === 'multi-tenant' ? FIXTURE_USER_ID : null, SEEDS_A);
      if (mode === 'multi-tenant') {
        await db.query(
          `INSERT INTO auth.users (id, email) VALUES ($1, 'tenant-b@example.invalid') ON CONFLICT (id) DO NOTHING`,
          [USER_B],
        ).catch(() => undefined);
        for (const [chunk, key] of await seedRows(db, mode, `u:${USER_B}`, USER_B, SEEDS_B)) owner.set(chunk, key);
      }
    });

    after(async () => {
      await edge?.close();
      await db?.close();
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    });

    async function chunkIds(filters: RetrievalFilters, scope: TenantScope = scopeA): Promise<string[]> {
      const legs = await backend.search({
        scope,
        embeddingProfileId: PROFILE,
        denseVector: embedText(QUERY),
        lexicalTokens: tokenize.queryLexicalTokens(QUERY),
        lexicalLanguages: null,
        filters,
        denseLimit: 50,
        lexicalLimit: 50,
        access: accessModule.scopeAccessFilter(scope),
        signal: new AbortController().signal,
      } as BackendSearchRequest);
      return [...new Set([...legs.dense, ...legs.lexical].map((hit) => hit.chunkId))].sort();
    }

    function vocabularyA() {
      return {
        docTypes: [...new Set(SEEDS_A.map((seed) => seed.docType))],
        languages: ['en', 'it', 'zh'],
        scopes: [...new Set(SEEDS_A.flatMap((seed) => seed.scopes))].map((tag) => ({ dimension: tag.split(':')[0]!, slug: tag.split(':')[1]! })),
      };
    }

    /** The production path: narrowFilters, the plan's variant, then the search stage's intersection with the shared filters. */
    function variantFilters(base: RetrievalFilters, proposal: SubQuestionFilter | null): { filters: RetrievalFilters; status: string } {
      const { currentOnly: _currentOnly, ...baseInput } = base;
      const narrowed = subqModule.narrowFilters(baseInput, proposal, vocabularyA());
      const plan = planModule.buildQueryPlan({
        original: QUERY,
        gate: { rewrite: true, transforms: ['decompose'], reasons: ['compound'], lang: 'en', protectedTokens: [] } as never,
        framework: 'llamaindex',
        subQuestions: [`${QUERY} part`],
        subQuestionSpecs: [{ text: `${QUERY} part`, filter: narrowed.applied }],
      });
      const variant = planModule.planToVariants(plan).find((item) => item.kind === 'sub_question');
      assert.ok(variant, 'the sub-question variant is planned');
      return { filters: searchModule.applyVariantFilters(base, variant), status: narrowed.status };
    }

    test('the fixture holds every seeded row of tenant A under its key', async () => {
      const ids = await chunkIds({ currentOnly: true });
      assert.equal(ids.length, SEEDS_A.length);
      assert.ok(ids.every((id) => owner.get(id) === tenantA));
    });

    for (const base of BASES) {
      for (const proposal of PROPOSALS) {
        test(`${proposal.label} under ${base.label}: the narrowed result is a subset of the base result`, async () => {
          const baseIds = await chunkIds(base.filters);
          const { filters, status } = variantFilters(base.filters, proposal.filter);
          const narrowedIds = await chunkIds(filters);
          const outside = narrowedIds.filter((id) => !baseIds.includes(id));
          assert.deepEqual(outside, [], `${status}: narrowed returned rows outside the base`);
          assert.ok(narrowedIds.every((id) => owner.get(id) === tenantA), 'only tenant A rows');
        });
      }
    }

    test('a narrowing filter returns fewer rows than its base, and only the matching ones', async () => {
      const { filters } = variantFilters({ currentOnly: true }, PROPOSALS[2]!.filter);
      const ids = await chunkIds(filters);
      assert.equal(ids.length, SEEDS_A.filter((seed) => seed.docType === 'contract_legal').length);
      const rows = await db.query<{ doc_type: string }>('SELECT doc_type FROM document_chunks WHERE id = ANY($1::uuid[])', [ids]);
      assert.ok(rows.rows.every((row) => row.doc_type === 'contract_legal'));
    });

    test("a proposal naming another tenant's doc type or scope slug is dropped for tenant A, and no foreign chunk is returned", async () => {
      const foreign: SubQuestionFilter = { date_range: null, doc_types: ['invoice_receipt'], languages: null, scopes: { region: ['east'] } };
      const { filters, status } = variantFilters({ currentOnly: true }, foreign);
      assert.equal(status, 'dropped_unknown_values');
      assert.deepEqual(filters, { currentOnly: true });
      const ids = await chunkIds(filters);
      assert.ok(ids.length > 0);
      for (const id of ids) assert.equal(owner.get(id), tenantA, 'no tenant B chunk in tenant A results');
      if (mode === 'multi-tenant') {
        const direct = await chunkIds({ currentOnly: true, docTypes: ['invoice_receipt'], scopes: ['region:east'] });
        assert.deepEqual(direct, [], "even a filter on tenant B's values reads only tenant A");
      }
    });

    test('the retry filters (the shared base) never widen past the base and stay in the tenant', async () => {
      const base: RetrievalFilters = { currentOnly: true, docTypes: ['general'] };
      const { filters } = variantFilters(base, { date_range: { from: '1990-01-01', to: '1990-12-31' }, doc_types: null, languages: null, scopes: null });
      assert.deepEqual(await chunkIds(filters), [], 'the filtered search is empty');
      const retryIds = await chunkIds(base);
      assert.ok(retryIds.length > 0);
      assert.ok(retryIds.every((id) => owner.get(id) === tenantA));
    });
  });
}
