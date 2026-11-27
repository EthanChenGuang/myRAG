import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  ACCESS_IDS,
  ACCESS_LANGUAGES,
  CONTROL_TEXT,
  TRANSLATION_TARGET,
  addMember,
  childQuery,
  createAccessGroupsDatabase,
  exactQuery,
  leakedMarkers,
  removeMember,
  restrictedMarkers,
  seedAccessLookups,
  setDocumentAccess,
  type AccessGroupsDatabase,
  type AccessGroupsSeed,
  type AccessLanguage,
} from '../../eval/harness/access-groups.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import type { DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { V2_DUP_QUERY, identifierQuery, tableQuery } from '../../eval/harness/two-tenant-v2.mts';

// Phase 4.3 plan 51 (EVAL-21; D-08, D-09, D-17, D-19, D-23, D-26, D-32; SEC-12 criterion 1): the same-tenant cross-group canary matrix for
// pgvector. One database per deployment mode holds one tenant with member-a, member-b, an outsider and an admin, groups group-a and group-b,
// and per language (zh, en, it) a neutral synthetic document restricted to group-a with a marker for every path. Scopes are resolved through
// resolveAccessScope with the eval identity (the eval run's RagRunOptions.user_id), never minted. For every leg, pipeline, language and mode
// the outsider gets no restricted marker or id and, in strict mode, the empty (information-not-available) status; member-a and the admin get
// the restricted chunk. Variants: membership removal, relabel to group-b, a new version inheriting the label, the semantic cache, the
// citation recheck with its id-only security event and the retrieval log. Negative controls prove the matrix fails without the filter.
// The Qdrant and Weaviate canaries are Phase 7's (07-39, A-14).

type TenantScope = import('@/lib/rag/tenant/scope').TenantScope;
type RetrievalResult = import('@/lib/rag').RetrievalResult;
type Pipeline = 'legacy' | 'v2';
type Identity = 'outsider' | 'memberA' | 'memberB' | 'admin';

const BASE_ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'true',
  RAG_RERANKER: 'none',
  RAG_REFUSAL_THRESHOLD: 'false',
  RAG_QUERY_LAYER: 'false',
  RAG_SEMANTIC_CACHE: 'off',
  RAG_DOC_ACCESS_GROUPS: 'on',
  RAG_SUPPORTED_LANGUAGES: 'zh,en,it',
  RAG_PRIMARY_LANGUAGE: 'en',
};
const BALANCED = { maxResults: 25, fallbackToLowerThreshold: true, ragMode: 'balanced' as const };
const STRICT = { maxResults: 25, fallbackToLowerThreshold: false, ragMode: 'strict' as const };
/** The Phase 3.3 attribute resolver (1008) runs after the 0920 block; rag_access_readiness names it until a later file filters it (SEAMS). */
const PENDING_1008 = new Set(['rag_attribute_filter_values', 'rag_attribute_documents']);
const LEGACY_PROFILE = 'openai-3-small-1536';
const REUPLOAD_MARKER = 'quorvelreupload';
const PATH_ENV = {
  table_rows: { RAG_TABLE_LOOKUP: 'true' },
  identifier: { RAG_IDENTIFIER_INDEX: 'true', RAG_IDENTIFIER_FILTER: 'true' },
  dup_cluster: { RAG_DUP_CLUSTERS: 'true', RAG_RESULT_DIVERSITY: 'collapse' },
} as const;

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

/** Drops timing and per-run ids, so two runs over the same rows compare equal. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (/latency|_ms$|ms$|trace_?id|timing|started|finished|duration|elapsed|at$/i.test(key)) continue;
      out[key] = stable(inner);
    }
    return out;
  }
  return value;
}

type RpcRequestLike = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): RpcRequestLike };

/**
 * The real readiness answer without the PENDING 1008 objects (and only those): any other object that cannot filter still keeps the switch
 * from turning on, so a new gap fails this suite.
 */
function withoutPendingReadiness(client: SupabaseClient): SupabaseClient {
  const filtered = (request: RpcRequestLike): RpcRequestLike => {
    const pending = Promise.resolve(request).then((response) => {
      const rows = Array.isArray(response.data) ? response.data : [response.data];
      const row = rows[0] as { ready?: boolean; reasons?: string[]; objects?: string[] } | undefined;
      if (!row || response.error || !Array.isArray(row.objects) || !Array.isArray(row.reasons)) return response;
      const keep = row.objects.map((name) => !PENDING_1008.has(name));
      const objects = row.objects.filter((_, index) => keep[index]);
      const reasons = row.reasons.filter((_, index) => keep[index]);
      return { ...response, data: [{ ready: objects.length === 0, reasons, objects }] };
    });
    return { abortSignal: (signal) => filtered(request.abortSignal(signal)), then: (a, b) => pending.then(a, b) };
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'rpc') {
        return (fn: string, args?: Record<string, unknown>, opts?: Parameters<SupabaseClient['rpc']>[2]) => {
          const request = target.rpc(fn, args, opts) as unknown as RpcRequestLike;
          return fn === 'rag_access_readiness' ? filtered(request) : request;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

let sharedEdge: FakeEdge | null = null;
const savedEnv: Record<string, string | undefined> = {};
const caseCount: Record<string, number> = {};
function count(leg: string): void {
  caseCount[leg] = (caseCount[leg] ?? 0) + 1;
}

after(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await sharedEdge?.close();
  console.log('[Access canary] cases per leg', caseCount);
});

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  describe(`same-tenant cross-group canary matrix (${mode})`, () => {
    let fixture: AccessGroupsDatabase;
    let db: PGlite;
    let seed: AccessGroupsSeed;
    let edge: FakeEdge;
    let client: SupabaseClient;
    let rag: typeof import('@/lib/rag');
    let scopeModule: typeof import('@/lib/rag/tenant/scope');
    let accessModule: typeof import('@/lib/rag/tenant/access');
    let startupModule: typeof import('@/lib/rag/tenant/access-startup');
    let configModule: typeof import('@/lib/rag/config');
    let registryModule: typeof import('@/lib/rag/backend/registry');
    let languageModule: typeof import('@/lib/rag/lang/settings');
    const multi = mode === 'multi-tenant';

    function resetModules(): void {
      configModule.resetRagConfigForTests();
      registryModule.resetRetrievalBackendForTests();
      languageModule.resetLanguageSettingsForTests();
    }

    /** Sets the access switch and syncs the database flag through the product startup check (D-10). */
    async function setAccessSwitch(on: boolean): Promise<void> {
      process.env.RAG_DOC_ACCESS_GROUPS = on ? 'on' : 'off';
      resetModules();
      startupModule.resetAccessStartupForTests();
      const verdict = await startupModule.verifyAccessGroupsStartup();
      assert.equal(verdict.status, on ? 'ready' : 'off', `access startup: ${verdict.reasons.join(',')}`);
    }

    async function withEnv<T>(extra: Record<string, string>, run: () => Promise<T>): Promise<T> {
      const saved = Object.fromEntries(Object.keys(extra).map((name) => [name, process.env[name]]));
      Object.assign(process.env, extra);
      resetModules();
      try {
        return await run();
      } finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        resetModules();
      }
    }

    const userOf: Record<Identity, string> = {
      outsider: ACCESS_IDS.outsider,
      memberA: ACCESS_IDS.memberA,
      memberB: ACCESS_IDS.memberB,
      admin: ACCESS_IDS.admin,
    };

    const baseScope = (userId: string): TenantScope =>
      multi ? scopeModule.mintScope('org', userId, ACCESS_IDS.org) : scopeModule.mintScope('single', null, null);

    /** A-15, D-07: the eval run's user_id is the access identity; groups come from the server-side resolver. */
    async function scopeFor(who: Identity): Promise<TenantScope> {
      const resolved = await accessModule.resolveAccessScope({
        scope: baseScope(userOf[who]),
        identity: { kind: 'eval', userId: userOf[who] },
        signal: new AbortController().signal,
      });
      assert.ok(resolved.ok, `access scope for ${who} refused: ${resolved.ok ? '' : resolved.reason}`);
      return resolved.scope;
    }

    async function retrieve(scope: TenantScope, input: Partial<import('@/lib/rag').RunRetrievalInput> = {}): Promise<RetrievalResult> {
      return rag.runRetrieval({
        scope,
        query: CONTROL_TEXT,
        profile: 'chat',
        options: BALANCED,
        signal: new AbortController().signal,
        ...input,
      } as import('@/lib/rag').RunRetrievalInput);
    }

    function assertNoLeak(value: unknown, label: string): void {
      assert.deepEqual(leakedMarkers(seed, value), [], `${label}: restricted content reached the outsider`);
    }

    const hasChunk = (result: RetrievalResult, chunkId: string) => result.candidates.some((candidate) => candidate.chunk_id === chunkId);

    before(async () => {
      fixture = await createAccessGroupsDatabase({ mode });
      db = fixture.db;
      seed = fixture.seed;
      if (sharedEdge === null) {
        sharedEdge = await startFakeEdge({ db, documentFilenameFilter: true });
        const names = ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'MYRAG_DEPLOYMENT_MODE', ...Object.keys(BASE_ENV), ...Object.keys(fixtureProcessEnv(sharedEdge.url))];
        for (const name of [...names, ...Object.values(PATH_ENV).flatMap((env) => Object.keys(env)), 'RAG_EXACT_ID_LOOKUP']) {
          if (!(name in savedEnv)) savedEnv[name] = process.env[name];
        }
      } else {
        sharedEdge.useDatabase(db);
      }
      edge = sharedEdge;
      const processEnv = fixtureProcessEnv(edge.url);
      Object.assign(process.env, processEnv, BASE_ENV);
      process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
      process.env.MYRAG_DEPLOYMENT_MODE = mode;
      rag = await import('@/lib/rag');
      scopeModule = await import('@/lib/rag/tenant/scope');
      accessModule = await import('@/lib/rag/tenant/access');
      startupModule = await import('@/lib/rag/tenant/access-startup');
      configModule = await import('@/lib/rag/config');
      registryModule = await import('@/lib/rag/backend/registry');
      languageModule = await import('@/lib/rag/lang/settings');
      const depsModule = await import('@/lib/rag/deps');
      const real = createClient(edge.url, processEnv.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
      client = withoutPendingReadiness(real);
      (await import('@/lib/rag/embeddings/registry')).resetEmbeddingProvidersForTests();
      (await import('@/lib/rag/embeddings/active-profile')).resetActiveProfileForTests();
      depsModule.resetRagDepsForTests();
      depsModule.setRagDepsForTests({ adminClient: () => client });
      resetModules();
      await seedAccessLookups(fixture);
      await db.query(
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedded_at)
         SELECT c.id, $1, c.tenant_key, c.embedding::halfvec, 'fixture', 1536, now() FROM document_chunks c WHERE c.embedding IS NOT NULL`,
        [LEGACY_PROFILE],
      );
      await setAccessSwitch(true);
    });

    after(async () => {
      startupModule?.resetAccessStartupForTests();
      configModule?.resetRagConfigForTests();
      registryModule?.resetRetrievalBackendForTests();
      (await import('@/lib/rag/deps')).resetRagDepsForTests();
      await fixture?.close();
    });

    test('the seed: groups, members and labels were written through the SQL functions, and only the 1008 objects are pending', async () => {
      const groups = await db.query<{ key: string }>('SELECT key FROM rag_access_groups WHERE tenant_key = $1 ORDER BY key', [seed.tenantKey]);
      assert.deepEqual(groups.rows.map((row) => row.key), ['group-a', 'group-b']);
      const audit = await db.query<{ action: string }>('SELECT DISTINCT action FROM rag_access_audit WHERE tenant_key = $1 ORDER BY action', [seed.tenantKey]);
      for (const action of ['document_set', 'group_create']) assert.ok(audit.rows.some((row) => row.action === action), `audit lacks ${action}`);
      for (const language of ACCESS_LANGUAGES) {
        const { ids } = seed.languages[language];
        const labels = await db.query<{ g: string[] }>(
          `SELECT access_groups AS g FROM documents WHERE id = $1 UNION ALL SELECT access_groups FROM document_chunks WHERE document_id = $1
           UNION ALL SELECT access_groups FROM document_parents WHERE document_id = $1 UNION ALL SELECT access_groups FROM chunk_translations WHERE document_id = $1`,
          [ids.doc],
        );
        assert.ok(labels.rows.length >= 5);
        for (const row of labels.rows) assert.deepEqual(row.g, [seed.groupAKey], `${language} label`);
      }
      const readiness = await db.query<{ objects: string[] }>('SELECT objects FROM public.rag_access_readiness()');
      assert.deepEqual([...new Set(readiness.rows[0]!.objects)].sort(), [...PENDING_1008].sort(), 'a new object cannot filter');
      assert.ok(restrictedMarkers(seed).length > 40);
    });

    describe('every leg, both pipelines, three languages (Task 1, Task 2)', () => {
      for (const language of ACCESS_LANGUAGES) {
        for (const pipeline of ['legacy', 'v2'] as Pipeline[]) {
          const legs: Array<[string, Record<string, string>]> =
            pipeline === 'v2'
              ? [
                  ['dense', { RAG_LEXICAL_SEARCH: 'false' }],
                  ['dense+lexical', { RAG_LEXICAL_SEARCH: 'true' }],
                ]
              : [['legacy search', {}]];
          for (const [leg, extra] of legs) {
            test(`${language} ${pipeline} ${leg}: outsider refused in strict mode with no marker; member-a and admin get the chunk`, async () => {
              await withEnv({ RAG_PIPELINE: pipeline, ...extra }, async () => {
                const { ids } = seed.languages[language];
                const outsider = await retrieve(await scopeFor('outsider'), { query: childQuery(language), options: STRICT });
                assertNoLeak(outsider, `${language} ${pipeline} ${leg} strict`);
                assert.equal(outsider.status, 'empty', `${language} ${pipeline} ${leg}: outsider not refused (${outsider.status}/${outsider.reason})`);
                const balanced = await retrieve(await scopeFor('outsider'), { query: childQuery(language) });
                assertNoLeak(balanced, `${language} ${pipeline} ${leg} balanced`);
                for (const who of ['memberA', 'admin'] as const) {
                  const result = await retrieve(await scopeFor(who), { query: childQuery(language), options: STRICT });
                  assert.ok(hasChunk(result, ids.chunk), `${who} lost the ${language} restricted chunk (${pipeline} ${leg}, ${result.status})`);
                }
                const memberB = await retrieve(await scopeFor('memberB'), { query: childQuery(language) });
                assertNoLeak(memberB, `${language} ${pipeline} ${leg} member-b`);
                count(`${pipeline} ${leg}`);
              });
            });
          }

          test(`${language} ${pipeline} exact id: the identifier only the restricted document holds finds nothing for the outsider`, async () => {
            await withEnv({ RAG_PIPELINE: pipeline, RAG_EXACT_ID_LOOKUP: 'true' }, async () => {
              const { ids } = seed.languages[language];
              const outsider = await retrieve(await scopeFor('outsider'), { query: exactQuery(language), options: STRICT });
              assertNoLeak(outsider, `${language} ${pipeline} exact id`);
              assert.equal(outsider.status, 'empty');
              const member = await retrieve(await scopeFor('memberA'), { query: exactQuery(language) });
              assert.ok(hasChunk(member, ids.idChunk), `member-a lost the ${language} exact-id chunk (${pipeline})`);
              count(`${pipeline} exact id`);
            });
          });

          for (const [profileLeg, input] of [
            ['voice', { profile: 'voice' }],
            ['media', { profile: 'media' }],
            ['overview', { options: { ...BALANCED, generalOverview: true } }],
          ] as const) {
            test(`${language} ${pipeline} ${profileLeg}: no marker for the outsider, the marker for member-a`, async () => {
              await withEnv({ RAG_PIPELINE: pipeline }, async () => {
                const outsider = await retrieve(await scopeFor('outsider'), { query: childQuery(language), ...(input as object) });
                assert.notEqual(outsider.status, 'error', `${profileLeg} errored: ${outsider.reason}`);
                assertNoLeak(outsider, `${language} ${pipeline} ${profileLeg}`);
                const member = await retrieve(await scopeFor('memberA'), { query: childQuery(language), ...(input as object) });
                assert.ok(leakedMarkers(seed, member).length > 0, `member-a lost the ${language} marker (${pipeline} ${profileLeg})`);
                count(`${pipeline} ${profileLeg}`);
              });
            });
          }

          test(`${language} ${pipeline} document references: a reference to the restricted file or id resolves to nothing`, async () => {
            await withEnv({ RAG_PIPELINE: pipeline }, async () => {
              const entry = seed.languages[language];
              const refs = {
                documentRefs: { mentions: [entry.filename.replace(/\.md$/, '')], documentParts: [{ id: entry.ids.doc, name: 'referenced part' }] },
              };
              const outsider = await retrieve(await scopeFor('outsider'), { query: childQuery(language), ...refs } as never);
              assertNoLeak(outsider, `${language} ${pipeline} references`);
              const member = await retrieve(await scopeFor('memberA'), { query: childQuery(language), ...refs } as never);
              assert.ok(member.usedDocuments.some((doc) => doc.id === entry.ids.doc), `member-a lost the referenced ${language} document`);
              count(`${pipeline} references`);
            });
          });
        }

        test(`${language} parents: expansion never fetches the restricted parent for the outsider`, async () => {
          const { expandParents } = await import('@/lib/rag/parents/expand');
          const { ids } = seed.languages[language];
          const survivors = [{ chunk_id: ids.chunk, document_id: ids.doc, parent_id: ids.parent }];
          const expand = async (who: Identity) => {
            const scope = await scopeFor(who);
            const result = await expandParents({ survivors, scope, admin: client as never, signal: new AbortController().signal, access: accessModule.scopeAccessFilter(scope) } as never);
            return (result as { candidates: Array<{ parent?: { id: string } }> }).candidates.map((candidate) => candidate.parent ?? null);
          };
          const outsider = await expand('outsider');
          assertNoLeak(outsider, `${language} parents`);
          assert.deepEqual(outsider, [null]);
          assert.equal((await expand('memberA'))[0]?.id, ids.parent);
          assert.equal((await expand('admin'))[0]?.id, ids.parent);
          count('parents');
        });

        test(`${language} translations: the stored translation of the restricted child never reaches the outsider`, async () => {
          const target = TRANSLATION_TARGET[language];
          const marker = seed.languages[language].markers.translated;
          const search = async (who: Identity) => {
            const args = accessModule.accessRpcArgs(accessModule.scopeAccessFilter(await scopeFor(who)));
            const { data, error } = await client.rpc('hybrid_search_translations', {
              p_tenant_key: seed.tenantKey,
              p_profile_id: LEGACY_PROFILE,
              p_language: target,
              p_query_embedding: null,
              p_lexical_tokens: [marker],
              p_dense_limit: 0,
              p_lexical_limit: 10,
              ...args,
            });
            assert.equal(error, null, `hybrid_search_translations failed: ${JSON.stringify(error)}`);
            return (data ?? []) as Array<{ chunk_id: string }>;
          };
          const outsider = await search('outsider');
          assertNoLeak(outsider, `${language} translations`);
          assert.equal(outsider.length, 0);
          assert.ok((await search('memberA')).some((row) => row.chunk_id === seed.languages[language].ids.chunk));
          count('translations');
        });

        test(`${language} match_chunks_by_profile (halfvec): the outsider gets no restricted chunk`, async () => {
          const query = childQuery(language);
          const match = async (who: Identity) => {
            const args = accessModule.accessRpcArgs(accessModule.scopeAccessFilter(await scopeFor(who)));
            const { data, error } = await client.rpc('match_chunks_by_profile', {
              p_tenant_key: seed.tenantKey,
              p_profile_id: LEGACY_PROFILE,
              p_dims: 1536,
              p_query: vec(query),
              p_match_count: 25,
              p_min_similarity: 0,
              p_require_active: false,
              ...args,
            });
            assert.equal(error, null, `match_chunks_by_profile failed: ${JSON.stringify(error)}`);
            return (data ?? []) as Array<{ id: string }>;
          };
          const outsider = await match('outsider');
          assertNoLeak(outsider, `${language} halfvec`);
          assert.ok(outsider.some((row) => row.id === ACCESS_IDS.controlChunk), 'the all control is still returned');
          assert.ok((await match('memberA')).some((row) => row.id === seed.languages[language].ids.chunk));
          count('match_chunks_by_profile');
        });
      }

      for (const [path, query] of [
        ['table_rows', () => tableQuery(seed.lookup!.markers)],
        ['identifier', () => identifierQuery(seed.lookup!.markers)],
        ['dup_cluster', () => V2_DUP_QUERY],
      ] as const) {
        test(`v2 ${path}: the Phase 4.2 store returns nothing restricted to the outsider and serves member-a`, async () => {
          await withEnv({ RAG_PIPELINE: 'v2', ...PATH_ENV[path] }, async () => {
            const outsider = await retrieve(await scopeFor('outsider'), { query: query() });
            assert.notEqual(outsider.status, 'error', `${path} errored: ${outsider.reason}`);
            assertNoLeak(outsider, `v2 ${path}`);
            const member = await retrieve(await scopeFor('memberA'), { query: query() });
            assert.ok(leakedMarkers(seed, member).length > 0, `member-a lost the ${path} rows`);
            count(path);
          });
        });
      }

      test('with RAG_DOC_ACCESS_GROUPS off every case equals the baseline run without any label (D-09)', async () => {
        await setAccessSwitch(false);
        try {
          const restricted = ACCESS_LANGUAGES.flatMap((language) => [seed.languages[language].ids.doc, seed.languages[language].ids.idDoc]);
          const runAll = async () => {
            const out: unknown[] = [];
            for (const pipeline of ['legacy', 'v2'] as Pipeline[]) {
              await withEnv({ RAG_PIPELINE: pipeline, RAG_EXACT_ID_LOOKUP: 'true' }, async () => {
                for (const language of ACCESS_LANGUAGES) {
                  for (const query of [childQuery(language), exactQuery(language)]) {
                    const scope = await scopeFor('outsider');
                    assert.equal(accessModule.scopeAccessFilter(scope).mode, 'off');
                    out.push(stable(await retrieve(scope, { query, options: STRICT })));
                  }
                }
              });
            }
            return out;
          };
          const labelled = await runAll();
          await setDocumentAccess(db, seed, restricted, ['all']);
          const baseline = await runAll();
          await setDocumentAccess(db, seed, restricted, [seed.groupAKey]);
          assert.deepEqual(labelled, baseline);
          assert.ok(leakedMarkers(seed, labelled).length > 0, 'off serves the restricted documents as today');
          count('off baseline');
        } finally {
          await setAccessSwitch(true);
        }
      });
    });

    describe('variants and negative controls (Task 3)', () => {
      test('member removed from group-a: member-a is refused on the next request, and gets the chunk again once re-added (D-08)', async () => {
        const { ids } = seed.languages.en;
        await removeMember(db, seed, seed.groupA, ACCESS_IDS.memberA);
        try {
          const removed = await retrieve(await scopeFor('memberA'), { query: childQuery('en'), options: STRICT });
          assertNoLeak(removed, 'removed member-a');
          assert.equal(removed.status, 'empty');
        } finally {
          await addMember(db, seed, seed.groupA, ACCESS_IDS.memberA);
        }
        assert.ok(hasChunk(await retrieve(await scopeFor('memberA'), { query: childQuery('en'), options: STRICT }), ids.chunk));
        count('variant member removed');
      });

      test('relabelled to group-b: member-b gets the chunk, member-a and the outsider do not (D-17)', async () => {
        const docs = ACCESS_LANGUAGES.flatMap((language) => [seed.languages[language].ids.doc, seed.languages[language].ids.idDoc]);
        await setDocumentAccess(db, seed, docs, [seed.groupBKey]);
        try {
          for (const language of ACCESS_LANGUAGES) {
            const member = await retrieve(await scopeFor('memberB'), { query: childQuery(language), options: STRICT });
            assert.ok(hasChunk(member, seed.languages[language].ids.chunk), `member-b lost the relabelled ${language} chunk`);
            for (const who of ['memberA', 'outsider'] as const) {
              const result = await retrieve(await scopeFor(who), { query: childQuery(language), options: STRICT });
              assertNoLeak(result, `${who} after relabel (${language})`);
              assert.equal(result.status, 'empty');
            }
          }
        } finally {
          await setDocumentAccess(db, seed, docs, [seed.groupAKey]);
        }
        count('variant relabel');
      });

      test('cache: an entry stored for member-a under the restricted source is a miss for the outsider and stays for member-a (D-23)', async () => {
        const { cacheAccessKeyPart } = await import('@/lib/rag/cache/access-key');
        const member = await scopeFor('memberA');
        const outsider = await scopeFor('outsider');
        assert.notEqual(cacheAccessKeyPart(member), cacheAccessKeyPart(outsider), 'the access set is part of the cache key');
        const keyHash = 'a'.repeat(64);
        const source = seed.languages.en.ids.doc;
        const service = async <T,>(run: () => Promise<T>) => {
          await db.exec('SET ROLE service_role');
          try {
            return await run();
          } finally {
            await db.exec('RESET ROLE');
          }
        };
        await service(() =>
          db.query('SELECT public.rag_cache_store($1, $2, $3, $4::halfvec, $5, $6::jsonb, $7::jsonb, $8, $9)', [
            seed.tenantKey,
            keyHash,
            'p1',
            '[1,0,0,0]',
            'masked query placeholder',
            JSON.stringify({ text: 'placeholder answer', citations: [] }),
            JSON.stringify([{ document_id: source, version: 1 }]),
            false,
            3600,
          ]),
        );
        const check = async (scope: TenantScope) => {
          const args = accessModule.accessRpcArgs(accessModule.scopeAccessFilter(scope));
          const rows = await service(() =>
            db.query<{ hit: boolean; answer: unknown }>('SELECT * FROM public.rag_cache_check($1, $2, $3, $4::halfvec, $5, $6::text[], $7)', [
              seed.tenantKey,
              keyHash,
              'p1',
              '[1,0,0,0]',
              0.05,
              args.p_access_keys,
              args.p_access_all,
            ]),
          );
          return rows.rows[0]!;
        };
        const miss = await check(outsider);
        assert.equal(miss.hit, false);
        assertNoLeak(miss, 'cache lookup');
        assert.equal((await check(member)).hit, true, 'the entry remains for member-a');
        count('variant cache');
      });

      test('citations: a citation injected for a restricted chunk is dropped by the recheck and recorded with ids only (D-26)', async () => {
        const outsider = await scopeFor('outsider');
        const recheck = rag.createCitationRecheck(outsider);
        assert.ok(recheck, 'the recheck runs while access is on');
        const { ids } = seed.languages.zh;
        const visible = await recheck([ids.chunk, ACCESS_IDS.controlChunk]);
        assert.deepEqual([...visible], [ACCESS_IDS.controlChunk]);
        const dropped = [ids.chunk].filter((id) => !visible.has(id));
        assert.ok(await rag.recordSecurityEvent(outsider, { event: 'citation_access_violation', chunkIds: dropped, documentIds: [ids.doc], userId: ACCESS_IDS.outsider }));
        const events = await db.query<Record<string, unknown>>('SELECT * FROM rag_access_security_events WHERE tenant_key = $1 AND user_id = $2', [
          seed.tenantKey,
          ACCESS_IDS.outsider,
        ]);
        assert.equal(events.rows.length, 1);
        const event = events.rows[0]!;
        assert.deepEqual(event.chunk_ids, [ids.chunk]);
        assert.deepEqual(
          Object.keys(event).sort(),
          ['chunk_ids', 'created_at', 'document_ids', 'event', 'id', 'request_id', 'tenant_key', 'user_id'],
          'the payload holds ids and codes only',
        );
        const text = JSON.stringify(event).toLowerCase();
        for (const marker of Object.values(seed.languages.zh.markers)) assert.ok(!text.includes(marker.toLowerCase()), 'no text in the event');
        const member = await rag.createCitationRecheck(await scopeFor('memberA'))!([ids.chunk]);
        assert.ok(member.has(ids.chunk), 'member-a keeps the citation');
        count('variant citations');
      });

      test('retrieval log: the outsider row holds no restricted chunk id (D-25)', async () => {
        const { buildRetrievalLogRow } = await import('@/lib/rag/feedback-loop/retrieval-log');
        for (const language of ACCESS_LANGUAGES) {
          const result = await retrieve(await scopeFor('outsider'), { query: childQuery(language) });
          const row = buildRetrievalLogRow({
            result,
            tenantKey: seed.tenantKey,
            stageLatency: {},
            latencyMs: 1,
            logContext: { channel: 'chat', ragMode: 'balanced', userId: ACCESS_IDS.outsider, organizationId: multi ? ACCESS_IDS.org : null, chatId: null },
            mode: 'masked_query',
            query: childQuery(language),
          } as never);
          assertNoLeak(row, `${language} retrieval log`);
        }
        count('variant retrieval log');
      });

      test('a new version uploaded without a choice inherits group-a; the outsider still gets nothing from it (D-19)', async () => {
        const { ids } = seed.languages.en;
        const newDoc = '00000000-0000-4000-8000-000000ac0fd1';
        const newChunk = '00000000-0000-4000-8000-000000ac0fe1';
        const text = `Neutral synthetic record: the ${REUPLOAD_MARKER} entry describes an ordinary sample arrangement.`;
        const orgColumn = multi ? ', organization_id' : '';
        await db.query(
          `INSERT INTO documents (id, filename, content, metadata, user_id${orgColumn}, language, lineage_id, version, is_current, status)
           VALUES ($1, $2, $3, '{}'::jsonb, $4${multi ? ', $6' : ''}, 'en', $5, 2, false, 'processing')`,
          multi ? [newDoc, seed.languages.en.filename, text, ACCESS_IDS.memberA, ids.doc, ACCESS_IDS.org] : [newDoc, seed.languages.en.filename, text, ACCESS_IDS.memberA, ids.doc],
        );
        const inherited = await db.query<{ g: string[] }>('SELECT access_groups AS g FROM documents WHERE id = $1', [newDoc]);
        assert.deepEqual(inherited.rows[0]!.g, [seed.groupAKey], 'the new version inherited the lineage label');
        await db.query(
          `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata${orgColumn})
           VALUES ($1, $2, $3, $4::vector, 0, '{}'::jsonb${multi ? ', $5' : ''})`,
          multi ? [newChunk, newDoc, text, vec(text), ACCESS_IDS.org] : [newChunk, newDoc, text, vec(text)],
        );
        await db.query("UPDATE documents SET is_current = false, status = 'superseded' WHERE id = $1", [ids.doc]).catch(async () => {
          await db.query('UPDATE documents SET is_current = false WHERE id = $1', [ids.doc]);
        });
        await db.query("UPDATE documents SET is_current = true, status = 'ready' WHERE id = $1", [newDoc]);
        await db.query('UPDATE document_chunks SET is_current = (document_id = $2) WHERE document_id IN ($1, $2)', [ids.doc, newDoc]);
        const { runFixtureRelex } = await import('../../eval/harness/pglite-supabase.mts');
        await runFixtureRelex(db);
        for (const pipeline of ['legacy', 'v2'] as Pipeline[]) {
          await withEnv({ RAG_PIPELINE: pipeline }, async () => {
            const outsider = await retrieve(await scopeFor('outsider'), { query: childQuery('en'), options: STRICT });
            assertNoLeak(outsider, `re-upload ${pipeline}`);
            assert.ok(!JSON.stringify(outsider).toLowerCase().includes(REUPLOAD_MARKER), `re-upload marker leaked (${pipeline})`);
            assert.equal(outsider.status, 'empty');
            const member = await retrieve(await scopeFor('memberA'), { query: childQuery('en') });
            assert.ok(hasChunk(member, newChunk), `member-a lost the new version (${pipeline})`);
          });
        }
        count('variant re-upload');
      });

      test('negative control: a copy of hybrid_search_chunks without the access predicate makes the outsider case fail', async () => {
        const def = (await db.query<{ oid: string; sig: string; def: string }>(
          `SELECT p.oid::text AS oid, p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'hybrid_search_chunks'`,
        )).rows;
        assert.equal(def.length, 1, 'one hybrid_search_chunks overload');
        let replaced = 0;
        const stripped = def[0]!.def.replace(/AND [cd]\.access_groups && \$\d+::text\[\]/g, () => {
          replaced += 1;
          return 'AND true';
        });
        assert.ok(replaced >= 2, 'the access predicate was found in the function body');
        const sig = def[0]!.sig;
        await db.exec(`ALTER FUNCTION public.${sig} RENAME TO hybrid_search_chunks_canary_real`);
        try {
          await db.exec(stripped);
          await withEnv({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }, async () => {
            const result = await retrieve(await scopeFor('outsider'), { query: childQuery('en') });
            assert.ok(leakedMarkers(seed, result).length > 0, 'the canary detects the missing predicate');
          });
        } finally {
          await db.exec(`DROP FUNCTION public.${sig}`);
          const realSig = sig.replace(/^hybrid_search_chunks\(/, 'hybrid_search_chunks_canary_real(');
          await db.exec(`ALTER FUNCTION public.${realSig} RENAME TO hybrid_search_chunks`);
        }
        await withEnv({ RAG_PIPELINE: 'v2' }, async () => {
          assertNoLeak(await retrieve(await scopeFor('outsider'), { query: childQuery('en') }), 'restored function');
        });
        count('negative control sql');
      });

      test('negative control: a backend wrapper that ignores req.access makes the outsider case fail', async () => {
        await withEnv({ RAG_PIPELINE: 'v2' }, async () => {
          const real = registryModule.getRetrievalBackend();
          const admin = scopeModule.withAccess(baseScope(ACCESS_IDS.admin), accessModule.mintAccessScope('admin_all', []));
          const leaky = Object.create(real) as typeof real;
          leaky.search = (req) => real.search({ ...req, scope: admin, access: accessModule.scopeAccessFilter(admin) });
          registryModule.setRetrievalBackendForTests(leaky);
          try {
            const result = await retrieve(await scopeFor('outsider'), { query: childQuery('it') });
            assert.ok(leakedMarkers(seed, result).length > 0, 'the canary detects a leg that drops its filter');
          } finally {
            registryModule.resetRetrievalBackendForTests();
          }
          assertNoLeak(await retrieve(await scopeFor('outsider'), { query: childQuery('it') }), 'restored backend');
        });
        count('negative control backend');
      });

      test('the fixture edge saw no unsupported request', () => {
        assert.deepEqual(edge.errors, []);
      });
    });
  });
}
