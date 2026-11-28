import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QdrantApi } from '@/lib/rag/backend/qdrant/client';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { RETRIEVAL_BACKEND_IDS, type BackendId } from '@/lib/rag/backend/types';
import type { WeaviateClientLike, WeaviateCollectionHandle, WeaviateTenantCollection } from '@/lib/rag/backend/weaviate/types';
import type { VectorStore } from '@/lib/rag/sync/stores/types';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';
import { CANARY_SENTENCE, canaryBackends, createCanaryEnv, isExternalBackend, type CanaryEnv, type CanaryTenant } from './factory';
import { CANARY_VOICE_SECRET, mintCanaryVoiceToken, resolvedRequest, type EntryConfig, type EntryOutcome } from './entry-points';
import { canaryText, ingestCanaryDocument, markerFor } from './seed';

// 07-39 (SEC-12, RET-06 to RET-08; D-12): the document access-group boundary on pgvector, Weaviate and Qdrant, seeded through ingest,
// the outbox and the drain. In tenant O a document is labelled g:<GA>; member G is in GA, member N is not. With RAG_DOC_ACCESS_GROUPS
// on, chat, voice and embed resolve access the way the routes do (resolveAccessScope from the verified identity) and the restricted
// document reaches G only. The negative control plants a point without access_groups under the restricted chunk's id: the filtered
// query does not return it, a filter-ignoring read client does, and group-aware re-validation drops it. Switch off: today's results.

const ENABLED = canaryBackends();
const SETUP_TIMEOUT = 240_000;

interface Fixture {
  env: CanaryEnv;
  o: CanaryTenant;
  b: CanaryTenant;
  userG: string;
  userN: string;
  groupId: string;
  groupKey: string;
  restrictedMarker: string;
  restrictedDocumentId: string;
  restrictedChunkIds: string[];
}

type Identity = { kind: 'user'; userId: string } | { kind: 'embed'; groupKey: string };
type Entry = 'chat' | 'voice' | 'embed';

function lowerUuid(): string {
  return crypto.randomUUID().toLowerCase();
}

function quiet(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

async function asService<T>(env: CanaryEnv, run: () => Promise<T>): Promise<T> {
  await env.db.exec('SET ROLE service_role');
  try {
    return await run();
  } finally {
    await env.db.exec('RESET ROLE');
  }
}

/** RAG_DOC_ACCESS_GROUPS through the dependency seam only; the startup verdict is recomputed on each switch. */
async function withAccessSwitch<T>(on: boolean, run: () => Promise<T>): Promise<T> {
  const [deps, startup, config] = await Promise.all([
    import('@/lib/rag/deps'),
    import('@/lib/rag/tenant/access-startup'),
    import('@/lib/rag/config'),
  ]);
  const previous = deps.getRagDeps().ragEnv;
  const base = previous();
  deps.setRagDepsForTests({ ragEnv: () => ({ ...base, RAG_DOC_ACCESS_GROUPS: on ? 'on' : 'off' }) });
  startup.resetAccessStartupForTests();
  config.resetRagConfigForTests();
  try {
    return await run();
  } finally {
    deps.setRagDepsForTests({ ragEnv: previous });
    startup.resetAccessStartupForTests();
    config.resetRagConfigForTests();
  }
}

/** The tenant scope an entry point resolves, then the access the route attaches from the verified identity. */
async function entryScope(fx: Fixture, entry: Entry, identity: Identity, rawBody: unknown = {}): Promise<TenantScope> {
  const { resolveAccessScope } = await import('@/lib/rag/tenant/access');
  let scope: TenantScope;
  if (entry === 'embed') {
    const { resolveEmbedScope, resetEmbedTenantLogForTests } = await import('@/lib/rag/tenant/embed');
    resetEmbedTenantLogForTests();
    const resolved = await resolveEmbedScope({
      rawBody,
      configuredTenant: `o:${fx.env.ids.orgO}`,
      deploymentMode: fx.env.mode,
      signal: new AbortController().signal,
    });
    if (!resolved.ok) throw new Error(`[Canary] embed scope refused (${resolved.reason})`);
    scope = resolved.scope;
  } else if (entry === 'voice') {
    if (identity.kind !== 'user') throw new Error('[Canary] voice needs a user');
    const { resolveVoiceScope, VOICE_SCOPE_HEADER } = await import('@/lib/rag/tenant/voice');
    const token = await mintCanaryVoiceToken(mintScope('org', identity.userId, fx.env.ids.orgO));
    const resolved = await resolveVoiceScope({
      headers: new Headers({ [VOICE_SCOPE_HEADER]: token }),
      secret: CANARY_VOICE_SECRET,
      deploymentMode: fx.env.mode,
      signal: new AbortController().signal,
    });
    if (!resolved.ok) throw new Error(`[Canary] voice scope refused (${resolved.reason})`);
    scope = resolved.scope;
  } else {
    if (identity.kind !== 'user') throw new Error('[Canary] chat needs a user');
    scope = mintScope('org', identity.userId, fx.env.ids.orgO);
  }
  const access = await resolveAccessScope({ scope, identity, signal: new AbortController().signal });
  if (!access.ok) throw new Error(`[Canary] access scope refused (${access.reason})`);
  return access.scope;
}

async function ask(fx: Fixture, entry: Entry, identity: Identity, question: string, config: EntryConfig, rawBody?: unknown): Promise<EntryOutcome> {
  const scope = await entryScope(fx, entry, identity, rawBody);
  return resolvedRequest(scope, entry, question, config);
}

function sees(outcome: EntryOutcome, fx: Fixture): boolean {
  const ids = new Set(fx.restrictedChunkIds);
  return outcome.ids.some((id) => ids.has(id)) || outcome.contents.some((content) => content.includes(fx.restrictedMarker));
}

function seesOpen(outcome: EntryOutcome, fx: Fixture): boolean {
  return outcome.contents.some((content) => content.includes(fx.o.marker));
}

function expectServedBy(outcome: EntryOutcome, backend: BackendId, label: string): void {
  expect(outcome.refused, `${label}: not refused`).toBeNull();
  expect(outcome.selection?.backend, `${label}: served by ${backend}`).toBe(backend);
  expect(outcome.selection?.fallbackReason ?? null, `${label}: no fallback`).toBeNull();
}

async function createFixture(backend: BackendId): Promise<Fixture> {
  const env = await createCanaryEnv(backend, 'multi-tenant');
  const o = env.tenants.o!;
  const b = env.tenants.b!;
  const userG = lowerUuid();
  const userN = lowerUuid();
  await env.sql('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
    userG,
    `canary-g-${env.nonce}@example.invalid`,
    userN,
    `canary-n-${env.nonce}@example.invalid`,
  ]);
  await env.sql("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')", [
    env.ids.orgO,
    userG,
    userN,
  ]);
  const created = await asService(env, () =>
    env.db.query<{ id: string }>('SELECT id FROM public.rag_access_group_create($1, $2, $3, $4)', [o.tenantKey, 'group-a', 'Group A', env.ids.userM]),
  );
  const groupId = String(created.rows[0]!.id).toLowerCase();
  await asService(env, () => env.db.query('SELECT * FROM public.rag_access_member_add($1, $2, $3, $4)', [o.tenantKey, groupId, userG, env.ids.userM]));
  const restrictedMarker = markerFor(env, 'g');
  const written = await ingestCanaryDocument(env, {
    scope: o.scope,
    filename: `canary-g-${env.nonce}.md`,
    text: canaryText(restrictedMarker),
    uploaderId: env.ids.userM,
  });
  if (written.status !== 'ready') throw new Error(`[Canary] restricted document is ${written.status}`);
  const groupKey = `g:${groupId}`;
  const labelled = await asService(env, () =>
    env.db.query<{ outcome: string }>('SELECT * FROM public.rag_set_document_access_groups($1, $2::uuid[], $3::text[], $4, $5, $6)', [
      o.tenantKey,
      [written.documentId],
      [groupKey],
      env.ids.userM,
      'admin',
      'canary_seed',
    ]),
  );
  if (labelled.rows.some((row) => row.outcome === 'not_found' || row.outcome === 'skipped_connector')) throw new Error('[Canary] label not applied');
  await env.settle();
  return {
    env,
    o,
    b,
    userG,
    userN,
    groupId,
    groupKey,
    restrictedMarker,
    restrictedDocumentId: written.documentId,
    restrictedChunkIds: written.chunkIds,
  };
}

/** Qdrant write client whose upserts lose access_groups: the planted point the negative control needs, written with the write key. */
function strippingQdrant(inner: QdrantApi): QdrantApi {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'upsert') {
        return (collection: string, body: { points: Array<{ payload?: Record<string, unknown> }> }) => {
          const points = body.points.map((point) => {
            const payload = { ...(point.payload ?? {}) };
            delete payload.access_groups;
            return { ...point, payload };
          });
          return target.upsert(collection, { ...body, points } as never);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function proxyWith<T extends object>(target: T, replaced: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(object, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(replaced, prop)) return replaced[prop];
      const value = Reflect.get(object, prop, receiver);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

/** Weaviate client whose tenant handles rewrite (writes: drop access_groups) or loosen (reads: drop filters) the data path only. */
function weaviateTenantProxy(
  inner: WeaviateClientLike,
  wrap: (tenant: WeaviateTenantCollection) => WeaviateTenantCollection,
): WeaviateClientLike {
  const collections = proxyWith(inner.collections, {
    use: (name: string) => {
      const handle: WeaviateCollectionHandle = inner.collections.use(name);
      return proxyWith(handle, { withTenant: (tenant: string) => wrap(handle.withTenant(tenant)) });
    },
  });
  return proxyWith(inner, { collections });
}

function strippingWeaviate(inner: WeaviateClientLike): WeaviateClientLike {
  return weaviateTenantProxy(inner, (tenant) =>
    proxyWith(tenant, {
      data: proxyWith(tenant.data, {
        insertMany: (objects: Array<{ properties?: Record<string, unknown> }>) =>
          tenant.data.insertMany(
            objects.map((object) => {
              const properties = { ...(object.properties ?? {}) };
              delete properties.access_groups;
              return { ...object, properties };
            }) as never,
          ),
      }),
    }),
  );
}

function isAccessCondition(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { key?: unknown }).key === 'access_groups';
}

function stripAccessClauses(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => !isAccessCondition(item)).map(stripAccessClauses);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, stripAccessClauses(child)]));
}

/** The filter-ignoring read clients: Qdrant drops the access clauses (tenant clauses kept), Weaviate drops every filter of both legs. */
function ignoringQdrant(inner: QdrantApi, seen: Set<string>): QdrantApi {
  return proxyWith(inner, {
    queryBatch: async (collection: string, batch: unknown) => {
      const responses = await inner.queryBatch(collection, stripAccessClauses(batch) as never);
      for (const response of responses) for (const point of response.points ?? []) seen.add(String(point.id));
      return responses;
    },
  });
}

function ignoringWeaviate(inner: WeaviateClientLike, seen: Set<string>): WeaviateClientLike {
  return weaviateTenantProxy(inner, (tenant) =>
    proxyWith(tenant, {
      query: proxyWith(tenant.query, {
        nearVector: async (vector: number[], opts: Record<string, unknown>, call?: unknown) => {
          const result = await tenant.query.nearVector(vector, { ...opts, filters: undefined } as never, call as never);
          for (const object of result.objects ?? []) if (typeof object.uuid === 'string') seen.add(object.uuid);
          return result;
        },
        bm25: async (text: string, opts: Record<string, unknown>, call?: unknown) => {
          const result = await tenant.query.bm25(text, { ...opts, filters: undefined } as never, call as never);
          for (const object of result.objects ?? []) if (typeof object.uuid === 'string') seen.add(object.uuid);
          return result;
        },
      }),
    }),
  );
}

async function plantWithoutAccessGroups(fx: Fixture): Promise<void> {
  const { env } = fx;
  let store: VectorStore;
  if (env.backend === 'qdrant') {
    const [{ createQdrantStore }, { getQdrantWriteClient }] = await Promise.all([import('@/lib/rag/sync/stores/qdrant'), import('@/lib/rag/backend/qdrant/client')]);
    store = createQdrantStore({ writeClient: strippingQdrant(getQdrantWriteClient()) });
  } else {
    const [{ createWeaviateStore }, { getWeaviateWriteClient }] = await Promise.all([import('@/lib/rag/sync/stores/weaviate'), import('@/lib/rag/backend/weaviate/client')]);
    store = createWeaviateStore({ client: strippingWeaviate(await getWeaviateWriteClient()) });
  }
  // A relabel that keeps the document restricted (g:<GA> plus G's own key) queues the document again; the stripping write client then
  // rewrites its point under the same id without the field.
  const relabelled = await asService(env, () =>
    env.db.query<{ outcome: string }>('SELECT * FROM public.rag_set_document_access_groups($1, $2::uuid[], $3::text[], $4, $5, $6)', [
      fx.o.tenantKey,
      [fx.restrictedDocumentId],
      [fx.groupKey, `u:${fx.userG}`],
      env.ids.userM,
      'admin',
      'canary_plant',
    ]),
  );
  expect(relabelled.rows.map((row) => row.outcome)).not.toContain('not_found');
  const drain = await import('@/lib/rag/sync/drain');
  const reports = await drain.drainUntilEmpty({ store, rpc: env.client, budgetMs: 60_000, batch: 100, trace: false, sink: () => undefined, maxSlices: 20 });
  expect(reports.reduce((n, report) => n + report.upserted, 0), 'the planted point was written').toBeGreaterThan(0);
  (await import('@/lib/rag/backend/readiness')).resetReadinessCacheForTests();
}

for (const backend of RETRIEVAL_BACKEND_IDS as readonly BackendId[]) {
  describe.runIf(ENABLED.includes(backend))(`access-group canary, multi-tenant (${backend})`, () => {
    let fx: Fixture;
    const config: EntryConfig = { backend, voiceBackend: backend };
    const question = (fixture: Fixture) => `${CANARY_SENTENCE} ${fixture.restrictedMarker}`;

    beforeAll(async () => {
      fx = await createFixture(backend);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await fx?.env.close();
    });

    beforeEach(quiet);

    it('switch off: every caller of the tenant gets the labelled document, as today, and tenant B gets nothing of O', async () => {
      await withAccessSwitch(false, async () => {
        for (const entry of ['chat', 'voice'] as const) {
          for (const userId of [fx.userG, fx.userN]) {
            const outcome = await ask(fx, entry, { kind: 'user', userId }, question(fx), config);
            expectServedBy(outcome, backend, `${entry} off`);
            expect(sees(outcome, fx), `${entry} off ${userId === fx.userG ? 'G' : 'N'}`).toBe(true);
          }
        }
        const embed = await ask(fx, 'embed', { kind: 'embed', groupKey: '' }, question(fx), config);
        expectServedBy(embed, backend, 'embed off');
        expect(sees(embed, fx), 'embed off').toBe(true);
        const other = await resolvedRequest(fx.b.scope, 'chat', question(fx), config);
        expect(sees(other, fx) || seesOpen(other, fx), 'tenant B').toBe(false);
      });
    });

    it('switch on, chat and voice: the group member gets the g:<GA> document, a member outside the group never does', async () => {
      await withAccessSwitch(true, async () => {
        for (const entry of ['chat', 'voice'] as const) {
          for (const query of [question(fx), fx.restrictedMarker]) {
            const member = await ask(fx, entry, { kind: 'user', userId: fx.userG }, query, config);
            expectServedBy(member, backend, `${entry} G`);
            if (query === question(fx)) expect(sees(member, fx), `${entry} G`).toBe(true);
            const outsider = await ask(fx, entry, { kind: 'user', userId: fx.userN }, query, config);
            expectServedBy(outsider, backend, `${entry} N`);
            expect(sees(outsider, fx), `${entry} N (${query === fx.restrictedMarker ? 'marker' : 'sentence'})`).toBe(false);
            if (query === question(fx)) expect(seesOpen(outsider, fx), `${entry} N still gets the all document`).toBe(true);
          }
        }
      });
    });

    it('switch on, embed: visitors see all documents only unless the embed configuration names the group; a body claim changes nothing', async () => {
      await withAccessSwitch(true, async () => {
        const plain = await ask(fx, 'embed', { kind: 'embed', groupKey: '' }, question(fx), config);
        expectServedBy(plain, backend, 'embed');
        expect(sees(plain, fx), 'embed without a group').toBe(false);
        expect(seesOpen(plain, fx), 'embed gets the all document').toBe(true);
        const claimed = await ask(fx, 'embed', { kind: 'embed', groupKey: '' }, question(fx), config, {
          accessGroups: [fx.groupKey],
          access_groups: [fx.groupKey],
          groups: ['group-a'],
        });
        expect(sees(claimed, fx), 'embed with a body claim').toBe(false);
        const configured = await ask(fx, 'embed', { kind: 'embed', groupKey: 'group-a' }, question(fx), config);
        expectServedBy(configured, backend, 'embed group-a');
        expect(sees(configured, fx), 'embed configured with group-a').toBe(true);
      });
    });

    it('switch on: a tenant B caller sees nothing of O whatever the groups', async () => {
      await withAccessSwitch(true, async () => {
        const { resolveAccessScope } = await import('@/lib/rag/tenant/access');
        const resolved = await resolveAccessScope({ scope: fx.b.scope, identity: { kind: 'user', userId: fx.env.ids.userB }, signal: new AbortController().signal });
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        for (const query of [question(fx), fx.restrictedMarker, fx.o.marker]) {
          const outcome = await resolvedRequest(resolved.scope, 'chat', query, config);
          expect(sees(outcome, fx) || seesOpen(outcome, fx), `tenant B: ${query}`).toBe(false);
        }
      });
    });

    it.runIf(isExternalBackend(backend))(
      'negative control: a point without access_groups under the restricted id is not returned by the filtered query; a filter-ignoring read client returns it raw and group-aware re-validation drops it',
      async () => {
        await plantWithoutAccessGroups(fx);
        await withAccessSwitch(true, async () => {
          const filtered = await ask(fx, 'chat', { kind: 'user', userId: fx.userN }, question(fx), config);
          expectServedBy(filtered, backend, 'filtered N');
          expect(sees(filtered, fx), 'filtered N').toBe(false);
          expect(filtered.selection?.tenantValidationDropped, 'the store filter kept the planted point out').toBe(0);

          const seen = new Set<string>();
          const { setExternalBackendForTests } = await import('@/lib/rag/backend/factory');
          const { getRagDeps } = await import('@/lib/rag/deps');
          const admin = () => getRagDeps().adminClient() as unknown as RpcClient | null;
          if (backend === 'qdrant') {
            const [{ createQdrantBackend }, { getQdrantReadClient }] = await Promise.all([import('@/lib/rag/backend/qdrant/adapter'), import('@/lib/rag/backend/qdrant/client')]);
            setExternalBackendForTests('qdrant', createQdrantBackend({ readClient: ignoringQdrant(getQdrantReadClient(), seen), adminClient: admin }));
          } else {
            const [{ createWeaviateBackend }, { getWeaviateReadClient }] = await Promise.all([import('@/lib/rag/backend/weaviate/adapter'), import('@/lib/rag/backend/weaviate/client')]);
            setExternalBackendForTests('weaviate', createWeaviateBackend({ readClient: ignoringWeaviate(await getWeaviateReadClient(), seen), revalidate: admin }));
          }
          try {
            const raw = await ask(fx, 'chat', { kind: 'user', userId: fx.userN }, question(fx), config);
            expectServedBy(raw, backend, 'filter-ignoring N');
            expect(fx.restrictedChunkIds.some((id) => seen.has(id)), 'the store answered the planted point raw').toBe(true);
            expect(sees(raw, fx), 'dropped by rag_validate_chunks_for_groups').toBe(false);
            expect(raw.rpcCalls).toContain('rag_validate_chunks_for_groups');
            expect(raw.rpcCalls).not.toContain('rag_validate_chunks');
            expect(raw.selection?.tenantValidationDropped ?? 0, 'counted in tenant_validation_dropped').toBeGreaterThan(0);
          } finally {
            setExternalBackendForTests(backend as 'qdrant' | 'weaviate', null);
          }
        });
      },
      SETUP_TIMEOUT,
    );
  });
}
