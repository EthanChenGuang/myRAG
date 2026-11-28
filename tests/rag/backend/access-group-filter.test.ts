import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { createQdrantBackend, searchQdrantLegs } from '@/lib/rag/backend/qdrant/adapter';
import { QDRANT_DENSE_VECTOR, QDRANT_LEXICAL_FIELD } from '@/lib/rag/backend/qdrant/collection';
import { assertScoped, qdrantScopedBatch, qdrantScopedRequest, type QdrantQueryNode } from '@/lib/rag/backend/qdrant/scoped-request';
import { revalidateChunks } from '@/lib/rag/backend/revalidate';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { canonicalTenantKey, qdrantCollectionName } from '@/lib/rag/backend/tenant-key';
import type { BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { createWeaviateBackend } from '@/lib/rag/backend/weaviate/adapter';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import { queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { drainSlice } from '@/lib/rag/sync/drain';
import { createQdrantStore } from '@/lib/rag/sync/stores/qdrant';
import type { StoreSearchRequest, VectorStore, VectorSyncTarget } from '@/lib/rag/sync/stores/types';
import { createWeaviateStore } from '@/lib/rag/sync/stores/weaviate';
import { mintAccessScope, scopeAccessFilter } from '@/lib/rag/tenant/access';
import { mintScope, withAccess, type TenantScope } from '@/lib/rag/tenant/scope';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../../eval/harness/fake-edge.mts';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { createEmptyFixtureDatabase, runFixtureRelex } from '../../../eval/harness/pglite-supabase.mts';
import {
  ACCESS_DATASET,
  ACCESS_IDS,
  ACCESS_QUERY,
  runAccessConformance,
  type AccessConformanceContext,
  type AccessDataset,
} from '../backend-conformance/access-cases';
import { PROFILE_ID } from '../backend-conformance/dataset';
import { createFakeQdrantClient, type FakeQdrantClient } from './qdrant-fake-client';
import { createFakeWeaviate, type FakeWeaviate } from './weaviate-fake';

// 07-39 (SEC-12, D-08): the Qdrant and Weaviate adapters filter by the caller's access keys in the store and Supabase re-checks every
// hit against the same keys. GA and UA are fixed fixture uuids of a group and a user of tenant A.

const GA = `g:${ACCESS_IDS.groupA}`;
const UA = `u:${ACCESS_IDS.memberA}`;
const OUTSIDER = `u:${ACCESS_IDS.outsider}`;
const ACCESS_CLAUSE_KEY = 'access_groups';
/** The scope's keys as minted (sorted), which is the order the adapters send. */
const MEMBER_KEYS = ['all', UA, GA].sort();
const OPEN_KEYS = ['all', OUTSIDER].sort();

function orgScope(userId: string): TenantScope {
  return mintScope('org', userId, ACCESS_IDS.org);
}

function keysScope(userId: string, keys: string[]): TenantScope {
  return withAccess(orgScope(userId), mintAccessScope('keys', keys));
}

const SCOPES = {
  open: () => keysScope(ACCESS_IDS.outsider, ['all', OUTSIDER]),
  member: () => keysScope(ACCESS_IDS.memberA, ['all', UA, GA]),
  admin: () => withAccess(orgScope(ACCESS_IDS.admin), mintAccessScope('admin_all', [])),
  off: () => withAccess(orgScope(ACCESS_IDS.outsider), mintAccessScope('off', [])),
};

function backendRequest(scope: TenantScope, overrides: Partial<BackendSearchRequest> = {}): BackendSearchRequest {
  return {
    scope,
    embeddingProfileId: PROFILE_ID,
    denseVector: embedText(ACCESS_QUERY),
    lexicalTokens: queryLexicalTokens(ACCESS_QUERY),
    lexicalLanguages: null,
    access: scopeAccessFilter(scope),
    filters: { currentOnly: true },
    denseLimit: 10,
    lexicalLimit: 10,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function idsOf(legs: { dense: Array<{ chunkId: string }>; lexical: Array<{ chunkId: string }> }): Set<string> {
  return new Set([...legs.dense, ...legs.lexical].map((hit) => hit.chunkId));
}

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

/** Records every rpc name and argument object, then forwards to the PGlite-backed client. */
function recording(inner: RpcClient, calls: RpcCall[]): RpcClient {
  return {
    rpc(fn, args) {
      calls.push({ fn, args: structuredClone(args) });
      return inner.rpc(fn, args);
    },
  };
}

interface AccessEnv {
  db: PGlite;
  edge: FakeEdge;
  client: RpcClient;
}

/** The ACCESS_DATASET in PGlite, with the target enabled first so the rows reach the store through the outbox and the drain only. */
async function seedAccessEnv(dataset: AccessDataset, store: VectorStore, target: VectorSyncTarget): Promise<AccessEnv> {
  const { db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', supabaseGrants: true });
  const edge = await startFakeEdge({ db });
  const env = fixtureProcessEnv(edge.url);
  const client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as RpcClient;
  const call = async (fn: string, args: Record<string, unknown>) => {
    const response = await client.rpc(fn, args).abortSignal(new AbortController().signal);
    if (response.error) throw new Error(`seed ${fn} failed (${response.error.code ?? 'rpc_error'})`);
  };
  await call('rag_vector_sync_set_target', { p_target: target, p_enabled: true, p_actor: 'access-group-filter' });
  const { memberA, outsider, admin } = dataset.members;
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
    memberA,
    'access-member-a@example.invalid',
    outsider,
    'access-outsider@example.invalid',
    admin,
    'access-admin@example.invalid',
  ]);
  await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
    dataset.orgId,
    'Access filter workspace',
    'access-filter',
    admin,
  ]);
  await db.query(
    "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'admin')",
    [dataset.orgId, memberA, outsider, admin],
  );
  await db.query('INSERT INTO rag_access_groups (id, key, name, organization_id) VALUES ($1, $2, $3, $4)', [
    dataset.groupA,
    'group-a',
    'Group A',
    dataset.orgId,
  ]);
  await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [dataset.groupA, memberA]);
  for (const row of dataset.rows) {
    const stored = `Document: ${row.filename}. Chunk 1 of 1. Content: ${row.body}`;
    await db.query(
      `INSERT INTO documents (id, filename, content, user_id, organization_id, language, doc_type, is_current, status, access_groups)
       VALUES ($1, $2, $3, $4, $5, $6, 'general', true, 'ready', $7::text[])`,
      [row.documentId, row.filename, row.body, admin, dataset.orgId, row.language, row.accessGroups],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, chunk_index, metadata, organization_id, language, doc_type, is_current, status)
       VALUES ($1, $2, $3, $4::vector, $5, 0, '{}'::jsonb, $6, $7, 'general', true, 'ready')`,
      [
        row.chunkId,
        row.documentId,
        stored,
        `[${embedText(row.body).join(',')}]`,
        chunkLexicalText({ sectionPath: [], content: stored, documentFilename: row.filename }),
        dataset.orgId,
        row.language,
      ],
    );
  }
  await runFixtureRelex(db);
  for (let slice = 0; slice < 20; slice += 1) {
    const report = await drainSlice({ store, rpc: client, budgetMs: 60_000, batch: 100 });
    if (report.failed > 0) throw new Error(`seed: ${report.failed} outbox rows failed`);
    if (report.claimed === 0) return { db, edge, client };
  }
  throw new Error('seed: the outbox did not drain');
}

async function closeEnv(env: AccessEnv | undefined): Promise<void> {
  await env?.edge.close().catch(() => undefined);
  await env?.db.close().catch(() => undefined);
}

function qdrantContext(fake: FakeQdrantClient, calls: RpcCall[]) {
  return async (dataset: AccessDataset): Promise<AccessConformanceContext & { env: AccessEnv }> => {
    const env = await seedAccessEnv(dataset, createQdrantStore({ writeClient: fake }), 'qdrant');
    return {
      env,
      backend: createQdrantBackend({ readClient: fake, adminClient: () => recording(env.client, calls), readiness: async () => true }),
      profileId: PROFILE_ID,
      embed: embedText,
      queryTokens: queryLexicalTokens,
      close: () => closeEnv(env),
    };
  };
}

function weaviateContext(fake: FakeWeaviate, calls: RpcCall[]) {
  return async (dataset: AccessDataset): Promise<AccessConformanceContext & { env: AccessEnv }> => {
    const env = await seedAccessEnv(dataset, createWeaviateStore({ client: fake }), 'weaviate');
    return {
      env,
      backend: createWeaviateBackend({ readClient: fake, revalidate: () => recording(env.client, calls), readiness: async () => true }),
      profileId: PROFILE_ID,
      embed: embedText,
      queryTokens: queryLexicalTokens,
      close: () => closeEnv(env),
    };
  };
}

function storeRequest(scope: TenantScope, extra: Partial<StoreSearchRequest> = {}): StoreSearchRequest {
  return {
    scope,
    profileId: PROFILE_ID,
    denseVector: [0.1, 0.2, 0.3],
    lexicalTokens: ['neutral', 'record'],
    denseLimit: 5,
    lexicalLimit: 5,
    filters: { currentOnly: true, docTypes: ['general'] },
    signal: new AbortController().signal,
    ...extra,
  };
}

function accessClause(keys: string[]) {
  return { key: ACCESS_CLAUSE_KEY, match: { any: keys } };
}

describe('qdrantScopedRequest access groups (D-08 extended)', () => {
  const scope = SCOPES.member();
  const tenant = { key: 'tenant_key', match: { value: canonicalTenantKey(scope) } };
  const keys = ['all', UA, GA];
  const nested: QdrantQueryNode = {
    query: { fusion: 'rrf' },
    limit: 10,
    prefetch: [
      { query: [0.1, 0.2], using: QDRANT_DENSE_VECTOR, limit: 20, prefetch: { query: [0.3, 0.4], using: QDRANT_DENSE_VECTOR, limit: 40 } },
      { query: { text: 'neutral record' }, using: QDRANT_LEXICAL_FIELD, limit: 20, filter: { must: [{ key: 'doc_type', match: { any: ['general'] } }] } },
    ],
  };

  it('injects the group clause into the top-level filter and every prefetch, next to the tenant clause', () => {
    const out = qdrantScopedRequest(scope, nested, { accessGroups: keys });
    const filters = [out.filter, ...(out.prefetch as QdrantQueryNode[]).map((p) => p.filter)];
    filters.push(((out.prefetch as QdrantQueryNode[])[0].prefetch as QdrantQueryNode[])[0].filter);
    expect(filters).toHaveLength(4);
    for (const filter of filters) {
      expect(filter?.must).toEqual(expect.arrayContaining([tenant, accessClause(keys)]));
    }
    const lexical = (out.prefetch as QdrantQueryNode[])[1];
    expect(lexical.filter?.must).toEqual([tenant, accessClause(keys), { key: 'doc_type', match: { any: ['general'] } }]);
    expect(lexical.params?.idf).toEqual({ corpus: { must: [tenant] } });
  });

  it('every prefetch must carry the group clause: the assertion throws when one lacks it', () => {
    const out = structuredClone(qdrantScopedRequest(scope, nested, { accessGroups: keys })) as QdrantQueryNode;
    expect(() => assertScoped(out, scope, { accessGroups: keys })).not.toThrow();
    const inner = ((out.prefetch as QdrantQueryNode[])[0].prefetch as QdrantQueryNode[])[0];
    inner.filter = { must: [tenant] };
    expect(() => assertScoped(out, scope, { accessGroups: keys })).toThrow(/access groups clause/);
    const top = structuredClone(qdrantScopedRequest(scope, nested, { accessGroups: keys })) as QdrantQueryNode;
    top.filter = { must: [tenant] };
    expect(() => assertScoped(top, scope, { accessGroups: keys })).toThrow(/access groups clause/);
    const other = structuredClone(qdrantScopedRequest(scope, nested, { accessGroups: keys })) as QdrantQueryNode;
    (other.prefetch as QdrantQueryNode[])[1].filter = { must: [tenant, accessClause(['all', UA, `g:${ACCESS_IDS.docOpen}`])] };
    expect(() => assertScoped(other, scope, { accessGroups: keys })).toThrow(/access groups clause/);
  });

  it('the batch builder injects the clause into every search', () => {
    const batch = qdrantScopedBatch(scope, { searches: [{ query: [0.1], using: QDRANT_DENSE_VECTOR }, { query: { text: 'x' }, using: QDRANT_LEXICAL_FIELD }] }, { accessGroups: keys });
    for (const search of batch.searches) expect(search.filter?.must).toEqual([tenant, accessClause(keys)]);
  });

  it('refuses an empty or malformed key list and a caller-built group clause', () => {
    expect(() => qdrantScopedRequest(scope, nested, { accessGroups: [] })).toThrow(/access groups/);
    expect(() => qdrantScopedRequest(scope, nested, { accessGroups: ['g1'] })).toThrow(/access groups/);
    expect(() => qdrantScopedRequest(scope, { query: [0.1], filter: { must: [accessClause(['all'])] } })).toThrow(/set only by the wrapper/);
  });

  it('without the option the request is byte-identical to the one built before 07-39', () => {
    const plain = JSON.stringify(qdrantScopedRequest(scope, nested));
    expect(JSON.stringify(qdrantScopedRequest(scope, nested, {}))).toBe(plain);
    expect(JSON.stringify(qdrantScopedRequest(scope, nested, { accessGroups: undefined }))).toBe(plain);
    expect(plain).not.toContain(ACCESS_CLAUSE_KEY);
  });
});

describe('Qdrant legs follow the request access (byte-identical when off)', () => {
  async function recordedBody(access: StoreSearchRequest['access'] | 'absent'): Promise<string> {
    const fake = createFakeQdrantClient();
    await fake.createCollection(qdrantCollectionName(PROFILE_ID), { vectors: {} } as never);
    const req = access === 'absent' ? storeRequest(SCOPES.member()) : storeRequest(SCOPES.member(), { access });
    await searchQdrantLegs(fake, req);
    const batch = fake.requests.filter((r) => r.method === 'queryBatch');
    expect(batch).toHaveLength(1);
    return JSON.stringify(batch[0].body);
  }

  it('mode off, admin_all and no access field send the byte-identical request of today', async () => {
    const today = await recordedBody('absent');
    expect(await recordedBody({ mode: 'off' })).toBe(today);
    expect(await recordedBody({ mode: 'admin_all' })).toBe(today);
    const key = canonicalTenantKey(SCOPES.member());
    const tenant = { key: 'tenant_key', match: { value: key } };
    expect(JSON.parse(today)).toEqual({
      searches: [
        {
          query: [0.1, 0.2, 0.3],
          using: QDRANT_DENSE_VECTOR,
          limit: 5,
          filter: { must: [tenant, { key: 'doc_type', match: { any: ['general'] } }] },
          params: { acorn: { enable: true } },
          with_payload: false,
        },
        {
          query: { text: 'neutral record' },
          using: QDRANT_LEXICAL_FIELD,
          limit: 5,
          filter: { must: [tenant, { key: 'doc_type', match: { any: ['general'] } }] },
          with_payload: false,
          params: { idf: { corpus: { must: [tenant] } } },
        },
      ],
    });
  });

  it('mode keys adds the group clause to both searches', async () => {
    const filter = scopeAccessFilter(SCOPES.member());
    const body = JSON.parse(await recordedBody(filter)) as { searches: QdrantQueryNode[] };
    for (const search of body.searches) expect(search.filter?.must).toEqual(expect.arrayContaining([accessClause(MEMBER_KEYS)]));
  });
});

describe('revalidateChunks access modes', () => {
  function fakeRpc(calls: RpcCall[]): RpcClient {
    return {
      rpc(fn, args): RpcRequest {
        const request: RpcRequest = {
          abortSignal: () => request,
          then(onFulfilled, onRejected) {
            calls.push({ fn, args });
            return Promise.resolve({ data: [], error: null } as RpcResponse).then(onFulfilled, onRejected);
          },
        };
        return request;
      },
    };
  }
  const opts = (calls: RpcCall[]) => ({ client: fakeRpc(calls), profileId: PROFILE_ID, signal: new AbortController().signal });
  const ids = [ACCESS_IDS.chunkOpen];

  it('mode keys calls rag_validate_chunks_for_groups with exactly the keys', async () => {
    const calls: RpcCall[] = [];
    const scope = SCOPES.member();
    await revalidateChunks(scope, ids, { ...opts(calls), access: scopeAccessFilter(scope) });
    expect(calls).toEqual([
      {
        fn: 'rag_validate_chunks_for_groups',
        args: { p_tenant_key: canonicalTenantKey(scope), p_ids: ids, p_profile_id: PROFILE_ID, p_access_groups: MEMBER_KEYS },
      },
    ]);
  });

  it('modes off, admin_all and no access call plain rag_validate_chunks with today\'s arguments', async () => {
    for (const access of [{ mode: 'off' } as const, { mode: 'admin_all' } as const, undefined]) {
      const calls: RpcCall[] = [];
      await revalidateChunks(SCOPES.admin(), ids, { ...opts(calls), access });
      expect(calls).toEqual([{ fn: 'rag_validate_chunks', args: { p_tenant_key: canonicalTenantKey(SCOPES.admin()), p_ids: ids, p_profile_id: PROFILE_ID } }]);
    }
  });

  it('a keys filter without keys fails closed', async () => {
    const calls: RpcCall[] = [];
    await expect(
      revalidateChunks(SCOPES.member(), ids, { ...opts(calls), access: { mode: 'keys', keys: [], setHash: 'x'.repeat(64) } }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

type Kind = 'qdrant' | 'weaviate';

describe.each<Kind>(['qdrant', 'weaviate'])('%s backend respects the caller\'s groups end to end', (kind) => {
  const calls: RpcCall[] = [];
  const qdrantFake = createFakeQdrantClient();
  const weaviateFake = createFakeWeaviate();
  let ctx: (AccessConformanceContext & { env: AccessEnv }) | undefined;
  let backend: RetrievalBackend;

  beforeAll(async () => {
    ctx = await (kind === 'qdrant' ? qdrantContext(qdrantFake, calls) : weaviateContext(weaviateFake, calls))(ACCESS_DATASET);
    backend = ctx.backend;
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('declares capabilities.accessFilter: true', () => {
    expect(backend.capabilities?.accessFilter).toBe(true);
  });

  it('a caller with all only gets all-documents; a group member also gets g:<GA>; each re-validated with exactly its keys', async () => {
    calls.length = 0;
    const open = SCOPES.open();
    expect(idsOf(await backend.search(backendRequest(open)))).toEqual(new Set([ACCESS_IDS.chunkOpen]));
    const member = SCOPES.member();
    expect(idsOf(await backend.search(backendRequest(member)))).toEqual(
      new Set([ACCESS_IDS.chunkOpen, ACCESS_IDS.chunkRestricted, ACCESS_IDS.chunkPrivate]),
    );
    expect(calls.map((c) => [c.fn, c.args.p_access_groups])).toEqual([
      ['rag_validate_chunks_for_groups', OPEN_KEYS],
      ['rag_validate_chunks_for_groups', MEMBER_KEYS],
    ]);
  });

  it('admin_all sees g:<GA> and u:<UA> documents and re-validates with rag_validate_chunks, not the group-aware call', async () => {
    calls.length = 0;
    const ids = idsOf(await backend.search(backendRequest(SCOPES.admin())));
    expect(ids).toEqual(new Set(ACCESS_DATASET.rows.map((row) => row.chunkId)));
    expect(calls.map((c) => c.fn)).toEqual(['rag_validate_chunks']);
    expect(calls[0].args).not.toHaveProperty('p_access_groups');
  });

  it('switch off (mode off) returns every row with plain re-validation, as today', async () => {
    calls.length = 0;
    const ids = idsOf(await backend.search(backendRequest(SCOPES.off())));
    expect(ids).toEqual(new Set(ACCESS_DATASET.rows.map((row) => row.chunkId)));
    expect(calls.map((c) => c.fn)).toEqual(['rag_validate_chunks']);
  });

  it('a request access that differs from the scope (a group claimed outside the server) is refused before any store call', async () => {
    calls.length = 0;
    const open = SCOPES.open();
    const claimed = scopeAccessFilter(SCOPES.member());
    await expect(backend.search(backendRequest(open, { access: claimed }))).rejects.toMatchObject({ code: 'access_filter_mismatch' });
    await expect(backend.search(backendRequest(open, { access: { mode: 'off' } }))).rejects.toMatchObject({ code: 'access_filter_mismatch' });
    expect(calls).toEqual([]);
  });

  if (kind === 'qdrant') {
    it('every Qdrant search of a keys request carries the group clause', async () => {
      qdrantFake.requests.length = 0;
      await backend.search(backendRequest(SCOPES.open()));
      const batches = qdrantFake.requests.filter((r) => r.method === 'queryBatch');
      expect(batches).toHaveLength(1);
      const searches = (batches[0].body as { searches: QdrantQueryNode[] }).searches;
      expect(searches).toHaveLength(2);
      for (const search of searches) expect(search.filter?.must).toEqual(expect.arrayContaining([accessClause(OPEN_KEYS)]));
    });

    it('layer 2 holds when the store ignores the filter: the restricted rows are dropped by group-aware re-validation', async () => {
      qdrantFake.filterMode = 'ignore';
      try {
        calls.length = 0;
        const ids = idsOf(await backend.search(backendRequest(SCOPES.open())));
        expect(ids).toEqual(new Set([ACCESS_IDS.chunkOpen]));
        expect(calls.map((c) => c.fn)).toEqual(['rag_validate_chunks_for_groups']);
      } finally {
        qdrantFake.filterMode = 'evaluate';
      }
    });
  } else {
    it('weaviate both legs carry the access_groups containsAny filter in mode keys and neither does otherwise', async () => {
      const legsOf = () => weaviateFake.calls.filter((c) => c.op === 'nearVector' || c.op === 'bm25');
      const groupFilters = (args: unknown): unknown[] => {
        const found: unknown[] = [];
        const walk = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          const f = value as { operator?: string; target?: { property?: string }; value?: unknown; filters?: unknown[] };
          if (f.target?.property === ACCESS_CLAUSE_KEY) found.push({ operator: f.operator, value: f.value });
          for (const child of f.filters ?? []) walk(child);
        };
        walk((args as { filters?: unknown }).filters);
        return found;
      };
      weaviateFake.calls.length = 0;
      await backend.search(backendRequest(SCOPES.member()));
      const keyed = legsOf();
      expect(keyed.map((c) => c.op).sort()).toEqual(['bm25', 'nearVector']);
      for (const call of keyed) {
        expect(call.tenant).not.toBeNull();
        expect(groupFilters(call.args)).toEqual([{ operator: 'ContainsAny', value: MEMBER_KEYS }]);
      }
      for (const scope of [SCOPES.admin(), SCOPES.off()]) {
        weaviateFake.calls.length = 0;
        await backend.search(backendRequest(scope));
        const legs = legsOf();
        expect(legs).toHaveLength(2);
        for (const call of legs) expect(groupFilters(call.args)).toEqual([]);
      }
    });
  }
});

const conformanceQdrant = createFakeQdrantClient();
runAccessConformance('qdrant', qdrantContext(conformanceQdrant, []));
const conformanceWeaviate = createFakeWeaviate();
runAccessConformance('weaviate', weaviateContext(conformanceWeaviate, []));
