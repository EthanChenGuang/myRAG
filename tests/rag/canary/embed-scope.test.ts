import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRIEVAL_BACKEND_IDS, type BackendId } from '@/lib/rag/backend/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import { CANARY_SENTENCE, LEGACY_PROFILE, canaryBackends, createCanaryEnv, foreignMarkers, isExternalBackend, type CanaryEnv, type CanaryLabel } from './factory';
import { embedRequest, filterIgnoringReader, filterIgnoringRpc, type EntryConfig, type EntryOutcome } from './entry-points';

const ENABLED = canaryBackends();
const SETUP_TIMEOUT = 180_000;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let errors: string[] = [];

function captureLogs(): void {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')));
}

function foreignChunkIds(env: CanaryEnv, own: CanaryLabel): string[] {
  return Object.values(env.tenants)
    .filter((tenant) => tenant !== undefined && tenant.label !== own)
    .flatMap((tenant) => tenant!.chunkIds);
}

function leakedFrom(outcome: EntryOutcome, markers: string[], chunkIds: string[]): string[] {
  const ids = new Set(chunkIds);
  return outcome.ids.filter((id, index) => ids.has(id) || markers.some((marker) => outcome.contents[index]!.includes(marker)));
}

function expectOwnCanary(outcome: EntryOutcome, marker: string, backend: BackendId, label: string): void {
  expect(outcome.refused, `${label}: not refused`).toBeNull();
  expect(outcome.selection?.backend, `${label}: served by ${backend}`).toBe(backend);
  expect(outcome.selection?.fallbackReason ?? null).toBeNull();
  expect(outcome.selection?.legs.dense, `${label}: dense leg answered`).toBeGreaterThan(0);
  expect(outcome.selection?.legs.lexical, `${label}: lexical leg answered`).toBeGreaterThan(0);
  expect(outcome.contents.some((content) => content.includes(marker)), `${label}: own canary answered`).toBe(true);
}

function expectRefusedBeforeRetrieval(outcome: EntryOutcome, refused: EntryOutcome['refused'], name: string): void {
  expect(outcome.refused, name).toEqual(refused);
  expect(outcome.result, `${name}: no retrieval`).toBeNull();
  expect(outcome.rpcCalls, `${name}: no search`).toEqual([]);
}

async function resolvedEmbedScope(env: CanaryEnv, configuredTenant: string): Promise<TenantScope> {
  const { resolveEmbedScope } = await import('@/lib/rag/tenant/embed');
  const resolved = await resolveEmbedScope({ rawBody: {}, configuredTenant, deploymentMode: env.mode, signal: new AbortController().signal });
  if (!resolved.ok) throw new Error(`[Canary] embed scope refused (${resolved.reason})`);
  return resolved.scope;
}

for (const backend of RETRIEVAL_BACKEND_IDS as readonly BackendId[]) {
  describe.runIf(ENABLED.includes(backend))(`embed-scope canary, multi-tenant (${backend})`, () => {
    let env: CanaryEnv;
    const config: EntryConfig = { backend };

    beforeAll(async () => {
      env = await createCanaryEnv(backend, 'multi-tenant');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await env?.close();
    });

    beforeEach(captureLogs);

    it("RAG_EMBED_TENANT=o:<O> returns O's canary and never A's or B's, for the sentence and every marker", async () => {
      const o = env.tenants.o!;
      const configured = `o:${env.ids.orgO}`;
      const own = await embedRequest(env, configured, {}, CANARY_SENTENCE, config);
      expectOwnCanary(own, o.marker, backend, 'embed o');
      expect(own.scope).toMatchObject({ kind: 'org', userId: null, organizationId: env.ids.orgO });
      expect(own.ids.every((id) => o.chunkIds.includes(id))).toBe(true);
      const foreign = foreignMarkers(env, 'o');
      for (const query of [...foreign.map((marker) => `${CANARY_SENTENCE} ${marker}`), ...foreign]) {
        const outcome = await embedRequest(env, configured, {}, query, config);
        expect(outcome.refused).toBeNull();
        expect(leakedFrom(outcome, foreign, foreignChunkIds(env, 'o')), `embed o, query "${query}"`).toEqual([]);
      }
    });

    it("RAG_EMBED_TENANT=u:<B> returns B's canary only", async () => {
      const b = env.tenants.b!;
      const configured = `u:${env.ids.userB}`;
      expectOwnCanary(await embedRequest(env, configured, {}, CANARY_SENTENCE, config), b.marker, backend, 'embed b');
      const foreign = foreignMarkers(env, 'b');
      for (const query of [CANARY_SENTENCE, ...foreign.map((marker) => `${CANARY_SENTENCE} ${marker}`)]) {
        const outcome = await embedRequest(env, configured, {}, query, config);
        expect(leakedFrom(outcome, foreign, foreignChunkIds(env, 'b')), `embed b, query "${query}"`).toEqual([]);
      }
    });

    it('a raw body naming another workspace is refused before retrieval; one naming the configured workspace is served', async () => {
      const configured = `o:${env.ids.orgO}`;
      const bodies: Array<[string, unknown]> = [
        ['organizationId of another organization', { organizationId: crypto.randomUUID() }],
        ["workspaceId of A's personal workspace", { workspaceId: env.ids.userA }],
        ["tenant naming A's personal workspace", { tenant: `u:${env.ids.userA}` }],
        ['tenant naming the single-tenant workspace', { tenant: 's:default' }],
      ];
      for (const [name, body] of bodies) {
        expectRefusedBeforeRetrieval(await embedRequest(env, configured, body, CANARY_SENTENCE, config), { status: 403, reason: 'workspace_mismatch' }, name);
      }
      const same = await embedRequest(env, configured, { organizationId: env.ids.orgO, tenant: configured }, CANARY_SENTENCE, config);
      expectOwnCanary(same, env.tenants.o!.marker, backend, 'body naming the configured workspace');
    });

    it('multi-tenant mode fails closed when RAG_EMBED_TENANT is unset, invalid for the mode or an unknown organization', async () => {
      expectRefusedBeforeRetrieval(
        await embedRequest(env, undefined, {}, CANARY_SENTENCE, config),
        { status: 'retrieval_error', reason: 'embed_tenant_unconfigured' },
        'unset',
      );
      expectRefusedBeforeRetrieval(
        await embedRequest(env, 's:default', {}, CANARY_SENTENCE, config),
        { status: 'retrieval_error', reason: 'embed_tenant_invalid' },
        's:default in multi-tenant mode',
      );
      expectRefusedBeforeRetrieval(
        await embedRequest(env, `o:${crypto.randomUUID()}`, {}, CANARY_SENTENCE, config),
        { status: 'retrieval_error', reason: 'embed_tenant_unknown' },
        'unknown organization',
      );
    });

    it.runIf(isExternalBackend(backend))(
      "O's index state stale: the embed request falls back to pgvector, degraded with backend_not_ready, and stays isolated",
      async () => {
        const { resetReadinessCacheForTests } = await import('@/lib/rag/backend/readiness');
        const o = env.tenants.o!;
        await env.sql("UPDATE public.rag_backend_index_state SET state = 'stale' WHERE target = $1 AND tenant_key = $2", [backend, o.tenantKey]);
        resetReadinessCacheForTests();
        try {
          const outcome = await embedRequest(env, `o:${env.ids.orgO}`, {}, `${CANARY_SENTENCE} ${env.tenants.a!.marker}`, config);
          expect(outcome.selection).toMatchObject({ backend: 'pgvector', fallbackReason: 'backend_not_ready', degraded: true });
          expect(outcome.contents.some((content) => content.includes(o.marker)), "O's own canary from pgvector").toBe(true);
          expect(leakedFrom(outcome, foreignMarkers(env, 'o'), foreignChunkIds(env, 'o'))).toEqual([]);
        } finally {
          await env.sql("UPDATE public.rag_backend_index_state SET state = 'ready' WHERE target = $1 AND tenant_key = $2", [backend, o.tenantKey]);
          resetReadinessCacheForTests();
        }
      },
    );

    it.runIf(isExternalBackend(backend))(
      "negative control: a filter-ignoring read client returns A's ids for O's embed scope, and the Supabase re-check drops them",
      async () => {
        const a = env.tenants.a!;
        const o = env.tenants.o!;
        const reader = await filterIgnoringReader(env, a);
        try {
          const outcome = await embedRequest(env, `o:${env.ids.orgO}`, {}, CANARY_SENTENCE, config);
          const raw = reader.rawIds();
          for (const id of a.chunkIds) expect(raw.has(id), `the control fired: A's ${id} came back from the store`).toBe(true);
          const foreignRaw = [...raw].filter((id) => !o.chunkIds.includes(id));
          expect(foreignRaw.length).toBeGreaterThan(0);
          expect(outcome.selection?.backend, `served by ${backend}`).toBe(backend);
          expect(outcome.ids.filter((id) => foreignRaw.includes(id)), 'no foreign id survives').toEqual([]);
          expect(leakedFrom(outcome, foreignMarkers(env, 'o'), foreignChunkIds(env, 'o'))).toEqual([]);
          expect(outcome.selection?.tenantValidationDropped).toBe(foreignRaw.length);
          const security = errors.filter((line) => line.startsWith('[RAG Security]'));
          expect(security).toHaveLength(1);
          expect(security[0]).not.toMatch(UUID_ANYWHERE);
          for (const tenant of Object.values(env.tenants)) expect(security[0]).not.toContain(tenant!.marker);
          expect(security[0]).not.toContain(CANARY_SENTENCE);
        } finally {
          reader.uninstall();
        }
      },
    );
  });
}

describe.runIf(ENABLED.includes('pgvector'))('embed-scope canary, layer 2 parity (pgvector)', () => {
  let env: CanaryEnv;

  beforeAll(async () => {
    env = await createCanaryEnv('pgvector', 'multi-tenant');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await env?.close();
  });

  beforeEach(captureLogs);

  it("negative control: a filter-ignoring RPC returns A's rows for O's embed scope, and rag_validate_chunks under that scope drops them", async () => {
    const [{ createPgvectorBackend }, { loadRagConfig }, { getRagDeps }, { revalidateChunks }, { canonicalTenantKey }, { queryLexicalTokens }, { scopeAccessFilter }] = await Promise.all([
      import('@/lib/rag/backend/pgvector'),
      import('@/lib/rag/config'),
      import('@/lib/rag/deps'),
      import('@/lib/rag/backend/revalidate'),
      import('@/lib/rag/backend/tenant-key'),
      import('@/lib/rag/lexical/tokenize'),
      import('@/lib/rag/tenant/access'),
    ]);
    const a = env.tenants.a!;
    const o = env.tenants.o!;
    const scope = await resolvedEmbedScope(env, `o:${env.ids.orgO}`);
    expect(canonicalTenantKey(scope)).toBe(o.tenantKey);
    const fake = filterIgnoringRpc(env.client, a.tenantKey);
    const broken = createPgvectorBackend({ adminClient: () => fake.client, getConfig: () => loadRagConfig(getRagDeps().ragEnv()) });
    const legs = await broken.search({
      scope,
      // Phase 4.3 D-05: the backend refuses a request whose access filter is not its scope's own.
      access: scopeAccessFilter(scope),
      embeddingProfileId: LEGACY_PROFILE,
      denseVector: env.queryVector(CANARY_SENTENCE),
      lexicalTokens: queryLexicalTokens(CANARY_SENTENCE),
      lexicalLanguages: null,
      filters: { currentOnly: true },
      denseLimit: 50,
      lexicalLimit: 50,
      signal: new AbortController().signal,
    });
    const raw = [...new Set([...legs.dense, ...legs.lexical].map((hit) => hit.chunkId))];
    for (const id of a.chunkIds) expect(raw, `the control fired: A's ${id} came back for O's scope`).toContain(id);
    const validated = await revalidateChunks(scope, raw, { client: env.client, profileId: LEGACY_PROFILE, signal: new AbortController().signal });
    expect([...validated.chunks.keys()], 'no foreign id survives the re-check').toEqual([]);
    expect(validated).toMatchObject({ requested: raw.length, dropped: raw.length });
  });
});

describe.runIf(ENABLED.includes('pgvector'))('embed-scope canary, single-tenant (pgvector)', () => {
  let env: CanaryEnv;

  beforeAll(async () => {
    env = await createCanaryEnv('pgvector', 'single-tenant');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await env?.close();
  });

  beforeEach(captureLogs);

  it("RAG_EMBED_TENANT unset or s:default serves s:default's documents only; a workspace key is invalid in this mode", async () => {
    const s = env.tenants.s!;
    for (const configured of [undefined, 's:default']) {
      const outcome = await embedRequest(env, configured, {}, CANARY_SENTENCE, { backend: 'pgvector' });
      expectOwnCanary(outcome, s.marker, 'pgvector', `configured ${configured ?? 'unset'}`);
      expect(outcome.scope).toMatchObject({ kind: 'single' });
      expect(outcome.ids.every((id) => s.chunkIds.includes(id))).toBe(true);
    }
    expectRefusedBeforeRetrieval(
      await embedRequest(env, `o:${crypto.randomUUID()}`, {}, CANARY_SENTENCE, { backend: 'pgvector' }),
      { status: 'retrieval_error', reason: 'embed_tenant_invalid' },
      'a workspace key in single-tenant mode',
    );
    expectRefusedBeforeRetrieval(
      await embedRequest(env, undefined, { organizationId: crypto.randomUUID() }, CANARY_SENTENCE, { backend: 'pgvector' }),
      { status: 403, reason: 'workspace_mismatch' },
      'a body naming a workspace in single-tenant mode',
    );
  });
});
