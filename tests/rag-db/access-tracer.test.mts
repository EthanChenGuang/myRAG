import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, runFixtureRelex, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// Phase 4.3 tracer (SEC-12, D-02, D-03, D-05, D-11, D-12, A-14): a document labelled only g:<group-a> never reaches an outsider of the
// same tenant through runRetrieval (v2, chat), the v2 search stage, the pgvector backend and hybrid_search_chunks, while member-a and an
// admin still get it. Fixtures are neutral synthetic sentences.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const LEGACY = 'openai-3-small-1536';
const MARKER = 'zephyrquill lanternmoss restricted marker';
const MARKER_TOKENS = ['zephyrquill', 'lanternmoss'];
const MARKER_TEXT = `The ${MARKER} sentence describes a neutral synthetic record.`;
const CONTROL_TEXT = 'The zephyrquill open control sentence describes a neutral synthetic record for everyone.';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true, ragMode: 'balanced' as const };

const IDS = {
  memberA: '00000000-0000-4000-8000-00000000a0a1',
  outsider: '00000000-0000-4000-8000-00000000a0b1',
  org: '00000000-0000-4000-8000-00000000a0c1',
  groupA: '00000000-0000-4000-8000-00000000a0f1',
  restrictedDoc: '00000000-0000-4000-8000-00000000a0d1',
  restrictedChunk: '00000000-0000-4000-8000-00000000a0e1',
  controlDoc: '00000000-0000-4000-8000-00000000a0d2',
  controlChunk: '00000000-0000-4000-8000-00000000a0e2',
} as const;

const ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'true',
  RAG_RERANKER: 'none',
  RAG_REFUSAL_THRESHOLD: 'false',
  RAG_QUERY_LAYER: 'false',
  RAG_SEMANTIC_CACHE: 'off',
  RAG_DOC_ACCESS_GROUPS: 'off',
};

type Row = { leg: string; chunk_id: string };

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

const GROUP_KEY = `g:${IDS.groupA}`;

// One fake edge for the file: env.ts reads the edge URL once, so the second mode swaps the database behind the same URL.
let sharedEdge: FakeEdge | null = null;
const savedEnv: Record<string, string | undefined> = {};

after(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await sharedEdge?.close();
});

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  describe(`a restricted document stays invisible to an outsider of the same tenant (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;
    let rag: typeof import('@/lib/rag');
    let scopeModule: typeof import('@/lib/rag/tenant/scope');
    let accessModule: typeof import('@/lib/rag/tenant/access');
    let configModule: typeof import('@/lib/rag/config');
    let registryModule: typeof import('@/lib/rag/backend/registry');
    const recorded: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const multi = mode === 'multi-tenant';
    const tenantKey = multi ? `o:${IDS.org}` : 's:default';

    before(async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, relex: false });
      db = fixture.db;
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
        IDS.memberA,
        'member-a@example.invalid',
        IDS.outsider,
        'outsider@example.invalid',
      ]);
      if (multi) {
        await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
          IDS.org,
          'Neutral workspace',
          'neutral-workspace',
          IDS.memberA,
        ]);
        await db.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')",
          [IDS.org, IDS.memberA, IDS.outsider],
        );
        await db.query('INSERT INTO rag_access_groups (id, key, name, organization_id) VALUES ($1, $2, $3, $4)', [
          IDS.groupA,
          'group-a',
          'Group A',
          IDS.org,
        ]);
      } else {
        await db.query('INSERT INTO rag_access_groups (id, key, name) VALUES ($1, $2, $3)', [IDS.groupA, 'group-a', 'Group A']);
      }
      await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [IDS.groupA, IDS.memberA]);

      for (const doc of [
        { docId: IDS.restrictedDoc, chunkId: IDS.restrictedChunk, text: MARKER_TEXT, groups: [GROUP_KEY], name: 'restricted.md' },
        { docId: IDS.controlDoc, chunkId: IDS.controlChunk, text: CONTROL_TEXT, groups: ['all'], name: 'control.md' },
      ]) {
        await db.query(
          `INSERT INTO documents (id, filename, content, metadata, user_id${multi ? ', organization_id' : ''}, language, access_groups)
           VALUES ($1, $2, $3, '{}'::jsonb, $4${multi ? ', $6' : ''}, 'en', $5::text[])`,
          multi ? [doc.docId, doc.name, doc.text, IDS.memberA, doc.groups, IDS.org] : [doc.docId, doc.name, doc.text, IDS.memberA, doc.groups],
        );
        // The writer sends {all}; the copy trigger replaces it with the document's array (D-03).
        await db.query(
          `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata${multi ? ', organization_id' : ''}, access_groups)
           VALUES ($1, $2, $3, $4::vector, 0, '{}'::jsonb${multi ? ', $5' : ''}, '{all}')`,
          multi ? [doc.chunkId, doc.docId, doc.text, vec(doc.text), IDS.org] : [doc.chunkId, doc.docId, doc.text, vec(doc.text)],
        );
      }
      await runFixtureRelex(db);

      if (sharedEdge === null) {
        sharedEdge = await startFakeEdge({ db });
        const names = ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'MYRAG_DEPLOYMENT_MODE', ...Object.keys(ENV), ...Object.keys(fixtureProcessEnv(sharedEdge.url))];
        for (const name of names) savedEnv[name] = process.env[name];
      } else {
        sharedEdge.useDatabase(db);
      }
      edge = sharedEdge;
      const processEnv = fixtureProcessEnv(edge.url);
      Object.assign(process.env, processEnv, ENV);
      process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
      process.env.MYRAG_DEPLOYMENT_MODE = mode;
      rag = await import('@/lib/rag');
      scopeModule = await import('@/lib/rag/tenant/scope');
      accessModule = await import('@/lib/rag/tenant/access');
      configModule = await import('@/lib/rag/config');
      registryModule = await import('@/lib/rag/backend/registry');
      const depsModule = await import('@/lib/rag/deps');
      const real = createClient(edge.url, processEnv.SUPABASE_SERVICE_ROLE_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      // Records every RPC's arguments; ragEnv stays the default reader of process.env.
      const recording = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'rpc') {
            return (fn: string, args?: Record<string, unknown>, opts?: Parameters<SupabaseClient['rpc']>[2]) => {
              recorded.push({ fn, args: { ...(args ?? {}) } });
              return target.rpc(fn, args, opts);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      // Each mode has its own fake edge: drop clients cached against the previous one.
      (await import('@/lib/rag/embeddings/registry')).resetEmbeddingProvidersForTests();
      (await import('@/lib/rag/embeddings/active-profile')).resetActiveProfileForTests();
      depsModule.resetRagDepsForTests();
      depsModule.setRagDepsForTests({ adminClient: () => recording });
      configModule.resetRagConfigForTests();
      registryModule.resetRetrievalBackendForTests();
    });

    after(async () => {
      configModule?.resetRagConfigForTests();
      registryModule?.resetRetrievalBackendForTests();
      (await import('@/lib/rag/deps')).resetRagDepsForTests();
      await db?.close();
    });

    const baseScope = (userId: string) =>
      multi ? scopeModule.mintScope('org', userId, IDS.org) : scopeModule.mintScope('single', null, null);
    const outsiderScope = () =>
      scopeModule.withAccess(baseScope(IDS.outsider), accessModule.mintAccessScope('keys', ['all', `u:${IDS.outsider}`]));
    const memberScope = () =>
      scopeModule.withAccess(baseScope(IDS.memberA), accessModule.mintAccessScope('keys', ['all', `u:${IDS.memberA}`, GROUP_KEY]));
    const adminScope = () => scopeModule.withAccess(baseScope(IDS.memberA), accessModule.mintAccessScope('admin_all', []));

    const retrieve = async (scope: import('@/lib/rag/tenant/scope').TenantScope, query = MARKER_TEXT) => {
      const start = recorded.length;
      const result = await rag.runRetrieval({ scope, query, profile: 'chat', options: OPTIONS, signal: new AbortController().signal });
      return { result, calls: recorded.slice(start) };
    };

    const hybridCalls = (calls: typeof recorded) => calls.filter((call) => call.fn === 'hybrid_search_chunks');
    const bodyOf = (call: (typeof recorded)[number]) => call.args;

    /** hybrid_search_chunks called directly as service_role with the scope's accessRpcArgs. */
    const direct = async (
      scope: import('@/lib/rag/tenant/scope').TenantScope,
      opts: { dense: number; lexical: number; exactCutoff?: number },
    ): Promise<Row[]> => {
      const args = accessModule.accessRpcArgs(accessModule.scopeAccessFilter(scope));
      await db.exec('SET ROLE service_role');
      try {
        return (
          await db.query<Row>(
            `SELECT leg, chunk_id::text FROM hybrid_search_chunks(
               p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
               p_dense_limit => $5, p_lexical_limit => $6, p_exact_scan_cutoff => $7, p_lexical_languages => $8::text[],
               p_access_keys => $9::text[], p_access_all => $10::boolean)`,
            [
              tenantKey,
              LEGACY,
              vec(MARKER_TEXT),
              MARKER_TOKENS,
              opts.dense,
              opts.lexical,
              opts.exactCutoff ?? 0,
              ['en'],
              args.p_access_keys ?? null,
              args.p_access_all ?? false,
            ],
          )
        ).rows;
      } finally {
        await db.exec('RESET ROLE');
      }
    };

    test('the chunk carries its document array whatever the writer sent; the catalog pins the column (A-14 seam 2)', async () => {
      const rows = await db.query<{ id: string; groups: string[] }>(
        'SELECT id::text, access_groups AS groups FROM document_chunks WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[IDS.restrictedChunk, IDS.controlChunk]],
      );
      assert.deepEqual(
        Object.fromEntries(rows.rows.map((row) => [row.id, row.groups])),
        { [IDS.restrictedChunk]: [GROUP_KEY], [IDS.controlChunk]: ['all'] },
      );
      await db.query("UPDATE document_chunks SET access_groups = '{all}' WHERE id = $1", [IDS.restrictedChunk]);
      const after = await db.query<{ groups: string[] }>('SELECT access_groups AS groups FROM document_chunks WHERE id = $1', [IDS.restrictedChunk]);
      assert.deepEqual(after.rows[0]?.groups, [GROUP_KEY]);

      for (const table of ['documents', 'document_chunks']) {
        const column = await db.query<{ type: string; notnull: boolean; def: string | null }>(
          `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE a.attrelid = $1::regclass AND a.attname = 'access_groups' AND NOT a.attisdropped`,
          [`public.${table}`],
        );
        assert.deepEqual(column.rows[0], { type: 'text[]', notnull: true, def: "'{all}'::text[]" }, table);
      }
      for (const bad of [[], ['all', GROUP_KEY], ['g:not-a-uuid'], ['G:' + IDS.groupA], ['everyone']]) {
        await assert.rejects(
          () => db.query('UPDATE documents SET access_groups = $2::text[] WHERE id = $1', [IDS.controlDoc, bad]),
          (error: unknown) => (error as { code?: string }).code === '23514',
          JSON.stringify(bad),
        );
      }
    });

    test('the outsider gets no marker anywhere in the result or the trace; the backend sent its keys', async () => {
      const { result, calls } = await retrieve(outsiderScope());
      assert.ok(result.stages.some((stage) => stage.name === 'fuse'), 'the v2 graph ran');
      // The query is the restricted text itself; every other occurrence of the marker would come from the restricted chunk.
      const { queryTerms: _queryTerms, ...rest } = result as typeof result & { queryTerms?: unknown };
      const serialized = JSON.stringify(rest).toLowerCase().split(MARKER_TEXT.toLowerCase()).join('<query>');
      assert.ok(!serialized.includes('lanternmoss'), 'marker text leaked');
      assert.ok(!serialized.includes('restricted.md'), 'restricted filename leaked');
      assert.ok(!serialized.includes(IDS.restrictedChunk), 'restricted chunk id leaked');
      assert.ok(!serialized.includes(IDS.restrictedDoc), 'restricted document id leaked');
      assert.ok(result.candidates.some((candidate) => candidate.chunk_id === IDS.controlChunk), 'the {all} control is still returned');
      const searches = hybridCalls(calls);
      assert.ok(searches.length > 0);
      for (const call of searches) {
        const body = bodyOf(call);
        assert.deepEqual(body.p_access_keys, ['all', `u:${IDS.outsider}`].sort());
        assert.equal(body.p_access_all, false);
      }
    });

    test('member-a and admin_all get the restricted chunk', async () => {
      for (const [label, scope] of [
        ['member-a', memberScope()],
        ['admin_all', adminScope()],
      ] as const) {
        const { result } = await retrieve(scope);
        assert.ok(
          result.candidates.some((candidate) => candidate.chunk_id === IDS.restrictedChunk),
          `${label} lost the restricted chunk`,
        );
      }
    });

    test('each leg on its own: lexical-only, dense-only (also limit 1) and the exact-count probe', async () => {
      const cases = [
        { name: 'lexical-only', opts: { dense: 0, lexical: 20 } },
        { name: 'dense-only', opts: { dense: 20, lexical: 0 } },
        { name: 'dense-only limit 1', opts: { dense: 1, lexical: 0 } },
        { name: 'probe', opts: { dense: 20, lexical: 20, exactCutoff: 1000 } },
      ];
      for (const { name, opts } of cases) {
        const member = await direct(memberScope(), opts);
        assert.ok(member.some((row) => row.chunk_id === IDS.restrictedChunk), `${name}: member-a lost the marker`);
        const outsider = await direct(outsiderScope(), opts);
        assert.ok(!outsider.some((row) => row.chunk_id === IDS.restrictedChunk), `${name}: the outsider got the marker`);
        if (opts.dense === 1) assert.equal(outsider.filter((row) => row.leg === 'dense').length, 1, `${name}: the outsider gets another chunk`);
      }
    });

    test('switch off with an unresolved scope: today\'s request body, the marker is returned', async () => {
      const { result, calls } = await retrieve(baseScope(IDS.outsider));
      assert.ok(result.candidates.some((candidate) => candidate.chunk_id === IDS.restrictedChunk));
      const searches = hybridCalls(calls);
      assert.ok(searches.length > 0);
      for (const call of searches) {
        const body = bodyOf(call);
        assert.ok(!('p_access_keys' in body), 'off sends no p_access_keys');
        assert.ok(!('p_access_all' in body), 'off sends no p_access_all');
      }
    });

    test('switch on with an unresolved scope: retrieval error status, no search sent', async () => {
      process.env.RAG_DOC_ACCESS_GROUPS = 'on';
      configModule.resetRagConfigForTests();
      try {
        const { result, calls } = await retrieve(baseScope(IDS.outsider));
        assert.equal(result.status, 'error');
        assert.equal(result.reason, 'access_scope_missing');
        assert.equal(hybridCalls(calls).length, 0);
        assert.deepEqual(result.candidates, []);
        assert.equal(result.context, '');
      } finally {
        process.env.RAG_DOC_ACCESS_GROUPS = 'off';
        configModule.resetRagConfigForTests();
      }
    });

    test('the function refuses missing keys while enforcement is on and an empty key array always', async () => {
      const call = (keys: string[] | null) =>
        db.query(
          `SELECT 1 FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL, p_lexical_tokens => $3::text[],
             p_dense_limit => 0, p_lexical_limit => 5, p_access_keys => $4::text[])`,
          [tenantKey, LEGACY, MARKER_TOKENS, keys],
        );
      await db.exec('SET ROLE service_role');
      try {
        await call(null);
        await assert.rejects(() => call([]), (error: unknown) => (error as { code?: string }).code === '22023');
        await db.exec('RESET ROLE');
        await db.query('UPDATE rag_access_group_settings SET enforced = true');
        await db.exec('SET ROLE service_role');
        await assert.rejects(
          () => call(null),
          (error: unknown) => (error as { code?: string }).code === '42501' && /access_scope_required/.test(String((error as Error).message)),
        );
        await call(['all']);
      } finally {
        await db.exec('RESET ROLE');
        await db.query('UPDATE rag_access_group_settings SET enforced = false');
      }
    });

    test('exactly one hybrid_search_chunks overload: SECURITY INVOKER, empty search_path, service_role only', async () => {
      const rows = await db.query<{ definer: boolean; config: string[] | null; sig: string }>(
        "SELECT p.prosecdef AS definer, p.proconfig AS config, p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = 'hybrid_search_chunks'",
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0]?.definer, false);
      assert.deepEqual(rows.rows[0]?.config, ['search_path=""']);
      const privileges = await db.query<{ role: string; allowed: boolean }>(
        `SELECT r.role, has_function_privilege(r.role, $1, 'EXECUTE') AS allowed FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
        [rows.rows[0]?.sig],
      );
      assert.deepEqual(Object.fromEntries(privileges.rows.map((row) => [row.role, row.allowed])), {
        anon: false,
        authenticated: false,
        service_role: true,
      });
    });
  });
}
