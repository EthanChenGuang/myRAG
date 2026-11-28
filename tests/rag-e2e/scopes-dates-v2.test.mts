import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

type RetrievalFilterInput = import('@/lib/rag/backend/types').RetrievalFilterInput;
type TenantScope = import('@/lib/rag/tenant/scope').TenantScope;

const QUERY = 'two tenant isolation canary phrase';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };
const V2_ENV = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_REFUSAL_THRESHOLD: 'false', RAG_SCOPE_TAGS: 'true' };
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const ACTOR = '00000000-0000-4000-8000-0000000000f9';

const DOCS = {
  aTagged: { docId: '00000000-0000-4000-8000-00000000a101', chunkId: '00000000-0000-4000-8000-00000000a1c1', userId: TWO_TENANT_IDS.userA, scopes: ['region:a1'] },
  aUntagged: { docId: '00000000-0000-4000-8000-00000000a102', chunkId: '00000000-0000-4000-8000-00000000a1c2', userId: TWO_TENANT_IDS.userA, scopes: [] },
  aOtherValue: { docId: '00000000-0000-4000-8000-00000000a103', chunkId: '00000000-0000-4000-8000-00000000a1c3', userId: TWO_TENANT_IDS.userA, scopes: ['region:b2'] },
  bTagged: { docId: '00000000-0000-4000-8000-00000000b101', chunkId: '00000000-0000-4000-8000-00000000b1c1', userId: TWO_TENANT_IDS.userB, scopes: ['region:a1'] },
} as const;

/** The injected clock: 2026-03-15 in UTC, late enough that a zone east of UTC would already read the next day. */
const NOW = Date.parse('2026-03-15T23:30:00.000Z');
const ONE_DAY = 24 * 60 * 60 * 1000;
const DATED = {
  future: { docId: '00000000-0000-4000-8000-00000000a201', chunkId: '00000000-0000-4000-8000-00000000a2c1', userId: TWO_TENANT_IDS.userA, from: '2026-03-16', to: null },
  expired: { docId: '00000000-0000-4000-8000-00000000a202', chunkId: '00000000-0000-4000-8000-00000000a2c2', userId: TWO_TENANT_IDS.userA, from: null, to: '2026-03-14' },
  current: { docId: '00000000-0000-4000-8000-00000000a203', chunkId: '00000000-0000-4000-8000-00000000a2c3', userId: TWO_TENANT_IDS.userA, from: '2026-01-01', to: '2026-03-15' },
  bFuture: { docId: '00000000-0000-4000-8000-00000000b201', chunkId: '00000000-0000-4000-8000-00000000b2c1', userId: TWO_TENANT_IDS.userB, from: '2026-03-16', to: null },
} as const;

function vectorLiteral(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

describe('scopes filter and effective dates through the v2 pipeline, two tenants', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let scopesModule: typeof import('@/lib/rag/query/scopes');
  let filtersModule: typeof import('@/lib/rag/query/filters');
  let configModule: typeof import('@/lib/rag/config');
  let depsModule: typeof import('@/lib/rag/deps');
  const saved: Record<string, string | undefined> = {};

  async function seedDocument(doc: (typeof DOCS)[keyof typeof DOCS], label: string) {
    const text = `Two tenant isolation canary phrase: scoped sample ${label}`;
    await fixture.db.query('INSERT INTO documents (id, filename, content, user_id, scopes) VALUES ($1, $2, $3, $4, $5::text[])', [
      doc.docId,
      `${label}.md`,
      text,
      doc.userId,
      doc.scopes,
    ]);
    await fixture.db.query(
      'INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, scopes) VALUES ($1, $2, $3, $4::vector, 0, $5::jsonb, $6::text[])',
      [doc.chunkId, doc.docId, `Document: ${label}.md. Content: ${text}`, vectorLiteral(text), '{}', doc.scopes],
    );
  }

  async function seedDated(doc: (typeof DATED)[keyof typeof DATED], label: string) {
    const text = `Two tenant isolation canary phrase: dated sample ${label}`;
    await fixture.db.query(
      'INSERT INTO documents (id, filename, content, user_id, effective_from, effective_to) VALUES ($1, $2, $3, $4, $5::date, $6::date)',
      [doc.docId, `${label}.md`, text, doc.userId, doc.from, doc.to],
    );
    await fixture.db.query(
      'INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, effective_from, effective_to) VALUES ($1, $2, $3, $4::vector, 0, $5::jsonb, $6::date, $7::date)',
      [doc.chunkId, doc.docId, `Document: ${label}.md. Content: ${text}`, vectorLiteral(text), '{}', doc.from, doc.to],
    );
  }

  async function seedVocabulary(tenantKey: string, value: string) {
    await fixture.db.query(
      `INSERT INTO rag_scope_vocabulary (tenant_key, dimension, value, label, created_by, updated_by) VALUES ($1, 'region', $2, $3, $4, $4)`,
      [tenantKey, value, `Label ${value}`, ACTOR],
    );
  }

  before(async () => {
    fixture = await createTwoTenantDatabase();
    await seedDocument(DOCS.aTagged, 'a-tagged');
    await seedDocument(DOCS.aUntagged, 'a-untagged');
    await seedDocument(DOCS.aOtherValue, 'a-other');
    await seedDocument(DOCS.bTagged, 'b-tagged');
    for (const [label, doc] of Object.entries(DATED)) await seedDated(doc, label);
    await seedVocabulary(TENANT_A, 'a1');
    await seedVocabulary(TENANT_A, 'b2');
    await seedVocabulary(TENANT_B, 'a1');
    edge = await startFakeEdge({ db: fixture.db });
    for (const name of ['RAG_EFFECTIVE_DATES', ...Object.keys(V2_ENV)]) saved[name] = process.env[name];
    Object.assign(process.env, fixtureProcessEnv(edge.url), V2_ENV);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    scopesModule = await import('@/lib/rag/query/scopes');
    filtersModule = await import('@/lib/rag/query/filters');
    configModule = await import('@/lib/rag/config');
    depsModule = await import('@/lib/rag/deps');
    depsModule.setRagDepsForTests({ now: () => NOW });
    const { resetRetrievalBackendForTests } = await import('@/lib/rag/backend/registry');
    configModule.resetRagConfigForTests();
    resetRetrievalBackendForTests();
  });

  after(async () => {
    depsModule?.resetRagDepsForTests();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await edge?.close();
    await fixture?.db.close();
  });

  const scopeOf = async (userId: string): Promise<TenantScope> => {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  };

  /** Parses the body field and checks the vocabulary the way the chat route does, then runs v2 retrieval. */
  const retrieve = async (userId: string, body: unknown) => {
    const scope = await scopeOf(userId);
    const parsed = filtersModule.parseRetrievalFilters(body);
    assert.ok(parsed.ok, 'the body filter parses');
    const filters: RetrievalFilterInput | undefined = await scopesModule.resolveScopesFilter(parsed.filters, { scope });
    const start = edge.calls.length;
    const result = await rag.runRetrieval({
      scope,
      query: QUERY,
      profile: 'chat',
      options: { ...OPTIONS, ragMode: 'balanced' },
      signal: new AbortController().signal,
      ...(filters ? { retrievalFilters: filters } : {}),
    });
    if (process.env.RAG_PIPELINE === 'v2') assert.ok(result.stages.some((entry) => entry.name === 'fuse'), 'the v2 graph ran');
    return {
      docs: new Set(result.candidates.map((candidate) => candidate.document_id)),
      calls: edge.calls.slice(start),
      hash: result.retrievalConfigHash,
    };
  };

  test('a scopes filter returns chunks of the tagged document only', async () => {
    const { docs } = await retrieve(TWO_TENANT_IDS.userA, { scopes: { region: ['a1'] } });
    assert.deepEqual([...docs], [DOCS.aTagged.docId]);
  });

  test('values of one dimension are OR', async () => {
    const { docs } = await retrieve(TWO_TENANT_IDS.userA, { scopes: { region: ['b2', 'a1'] } });
    assert.deepEqual([...docs].sort(), [DOCS.aTagged.docId, DOCS.aOtherValue.docId].sort());
  });

  test('includeUntagged also admits documents with no tag in that dimension', async () => {
    const { docs } = await retrieve(TWO_TENANT_IDS.userA, { scopes: { region: ['a1'] }, includeUntagged: true });
    assert.ok(docs.has(DOCS.aTagged.docId));
    assert.ok(docs.has(DOCS.aUntagged.docId));
    assert.ok(docs.has(TWO_TENANT_IDS.docA));
    assert.ok(!docs.has(DOCS.aOtherValue.docId), 'a document tagged with another value of the dimension stays out');
    assert.ok(!docs.has(DOCS.bTagged.docId));
  });

  test('without a filter every document of the tenant is searched', async () => {
    const { docs } = await retrieve(TWO_TENANT_IDS.userA, undefined);
    for (const id of [DOCS.aTagged.docId, DOCS.aUntagged.docId, DOCS.aOtherValue.docId, TWO_TENANT_IDS.docA]) assert.ok(docs.has(id), id);
    assert.ok(!docs.has(DOCS.bTagged.docId));
  });

  test("tenant B's identically tagged document never appears for tenant A, and the other way round", async () => {
    const a = await retrieve(TWO_TENANT_IDS.userA, { scopes: { region: ['a1'] }, includeUntagged: true });
    assert.ok(!a.docs.has(DOCS.bTagged.docId));
    for (const call of a.calls) {
      const named = decodeURIComponent(call.query ?? '');
      assert.ok(!named.includes(DOCS.bTagged.docId), `A's request ${call.path} named B's document`);
    }
    const b = await retrieve(TWO_TENANT_IDS.userB, { scopes: { region: ['a1'] } });
    assert.deepEqual([...b.docs], [DOCS.bTagged.docId]);
  });

  test('a value outside the tenant vocabulary is unknown_scope_value (400), even when another tenant has it', async () => {
    const scope = await scopeOf(TWO_TENANT_IDS.userB);
    const error = await scopesModule.resolveScopesFilter({ scopes: ['region:b2'] }, { scope }).catch((caught: unknown) => caught);
    assert.ok(error instanceof scopesModule.ScopeFilterError);
    assert.equal(error.code, 'unknown_scope_value');
    assert.equal(error.status, 400);
  });

  test('with RAG_SCOPE_TAGS false a scopes filter is scopes_disabled (400)', async () => {
    process.env.RAG_SCOPE_TAGS = 'false';
    try {
      const scope = await scopeOf(TWO_TENANT_IDS.userA);
      const error = await scopesModule.resolveScopesFilter({ scopes: ['region:a1'] }, { scope }).catch((caught: unknown) => caught);
      assert.ok(error instanceof scopesModule.ScopeFilterError);
      assert.equal(error.code, 'scopes_disabled');
      assert.equal(error.status, 400);
    } finally {
      process.env.RAG_SCOPE_TAGS = 'true';
    }
  });
  const withEnv = async <T,>(values: Record<string, string>, run: () => Promise<T>): Promise<T> => {
    const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    Object.assign(process.env, values);
    configModule.resetRagConfigForTests();
    try {
      return await run();
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      configModule.resetRagConfigForTests();
    }
  };

  test('RAG_EFFECTIVE_DATES off: dated documents are retrieved as today', async () => {
    const { docs } = await retrieve(TWO_TENANT_IDS.userA, undefined);
    for (const doc of [DATED.future, DATED.expired, DATED.current]) assert.ok(docs.has(doc.docId), doc.docId);
  });

  test('RAG_EFFECTIVE_DATES on: a future document is not used yet, an expired one is excluded, null bounds pass', async () => {
    await withEnv({ RAG_EFFECTIVE_DATES: 'true' }, async () => {
      const { docs, calls } = await retrieve(TWO_TENANT_IDS.userA, undefined);
      assert.ok(!docs.has(DATED.future.docId), 'not effective yet');
      assert.ok(!docs.has(DATED.expired.docId), 'expired');
      assert.ok(docs.has(DATED.current.docId), 'inside its window, ending today');
      assert.ok(docs.has(TWO_TENANT_IDS.docA), 'undated');
      assert.ok(docs.has(DOCS.aTagged.docId), 'undated and tagged');
      assert.ok(!docs.has(DATED.bFuture.docId));
      assert.ok(calls.some((call) => call.path.includes('/rpc/hybrid_search_chunks')));
    });
  });

  test('RAG_EFFECTIVE_DATES on: moving the clock one day makes the future document effective', async () => {
    await withEnv({ RAG_EFFECTIVE_DATES: 'true' }, async () => {
      depsModule.setRagDepsForTests({ now: () => NOW + ONE_DAY });
      try {
        const { docs } = await retrieve(TWO_TENANT_IDS.userA, undefined);
        assert.ok(docs.has(DATED.future.docId), 'effective from the next day');
        assert.ok(!docs.has(DATED.current.docId), 'its window ended the day before');
        assert.ok(!docs.has(DATED.bFuture.docId), "tenant B's document stays out");
      } finally {
        depsModule.setRagDepsForTests({ now: () => NOW });
      }
    });
  });

  test('the retrieval config hash is unchanged with the switch off and names the date with it on', async () => {
    const off = await retrieve(TWO_TENANT_IDS.userA, undefined);
    const onToday = await withEnv({ RAG_EFFECTIVE_DATES: 'true' }, () => retrieve(TWO_TENANT_IDS.userA, undefined));
    depsModule.setRagDepsForTests({ now: () => NOW + ONE_DAY });
    try {
      const offTomorrow = await retrieve(TWO_TENANT_IDS.userA, undefined);
      const onTomorrow = await withEnv({ RAG_EFFECTIVE_DATES: 'true' }, () => retrieve(TWO_TENANT_IDS.userA, undefined));
      assert.equal(offTomorrow.hash, off.hash, 'switch off: the clock does not reach the hash');
      assert.equal(new Set([off.hash, onToday.hash, onTomorrow.hash]).size, 3);
    } finally {
      depsModule.setRagDepsForTests({ now: () => NOW });
    }
  });

  test('the legacy pipeline returns every dated document as today, with the switch on', async () => {
    await withEnv({ RAG_EFFECTIVE_DATES: 'true', RAG_PIPELINE: 'legacy' }, async () => {
      const { docs } = await retrieve(TWO_TENANT_IDS.userA, undefined);
      for (const doc of [DATED.future, DATED.expired, DATED.current]) assert.ok(docs.has(doc.docId), doc.docId);
      assert.ok(!docs.has(DATED.bFuture.docId));
    });
  });
});
