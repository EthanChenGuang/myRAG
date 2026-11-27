import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRIEVAL_BACKEND_IDS, type BackendId } from '@/lib/rag/backend/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import { CANARY_SENTENCE, LEGACY_PROFILE, canaryBackends, createCanaryEnv, foreignMarkers, isExternalBackend, type CanaryEnv, type CanaryLabel } from './factory';
import {
  CANARY_VOICE_SECRET,
  chatRequest,
  filterIgnoringReader,
  filterIgnoringRpc,
  mintCanaryVoiceToken,
  voiceRequest,
  type EntryConfig,
  type EntryOutcome,
} from './entry-points';

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

/** Chunk ids or contents of the outcome that belong to another tenant. */
function leakedFrom(outcome: EntryOutcome, markers: string[], chunkIds: string[]): string[] {
  const ids = new Set(chunkIds);
  return outcome.ids.filter((id, index) => ids.has(id) || markers.some((marker) => outcome.contents[index]!.includes(marker)));
}

/** The positive control: the tenant's own canary is answered, on both legs, by the backend the switch names. */
function expectOwnCanary(outcome: EntryOutcome, marker: string, backend: BackendId, label: string): void {
  expect(outcome.refused, `${label}: not refused`).toBeNull();
  expect(outcome.selection?.backend, `${label}: served by ${backend}`).toBe(backend);
  expect(outcome.selection?.fallbackReason ?? null).toBeNull();
  expect(outcome.selection?.legs.dense, `${label}: dense leg answered`).toBeGreaterThan(0);
  expect(outcome.selection?.legs.lexical, `${label}: lexical leg answered`).toBeGreaterThan(0);
  expect(outcome.contents.some((content) => content.includes(marker)), `${label}: own canary answered`).toBe(true);
}

function expectSecurityLine(lines: string[], forbidden: string[]): void {
  const security = lines.filter((line) => line.startsWith('[RAG Security]'));
  expect(security, 'exactly one [RAG Security] line').toHaveLength(1);
  const line = security[0]!;
  expect(line).toContain('tenant_validation_dropped');
  expect(line).not.toMatch(UUID_ANYWHERE);
  for (const text of forbidden) expect(line, 'the security line carries no id, marker or text').not.toContain(text);
}

function tamper(token: string): string {
  const [payload, signature] = token.split('.') as [string, string];
  const last = signature.at(-1) === 'A' ? 'B' : 'A';
  return `${payload}.${signature.slice(0, -1)}${last}`;
}

/** A's signature over B's claims: the payload of a token minted for B with the signature of one minted for A. */
function swapClaims(tokenForA: string, tokenForB: string): string {
  return `${tokenForB.split('.')[0]}.${tokenForA.split('.')[1]}`;
}

async function resolvedVoiceScope(env: CanaryEnv, scope: TenantScope): Promise<TenantScope> {
  const { resolveVoiceScope, VOICE_SCOPE_HEADER } = await import('@/lib/rag/tenant/voice');
  const headers = new Headers({ [VOICE_SCOPE_HEADER]: await mintCanaryVoiceToken(scope) });
  const resolved = await resolveVoiceScope({ headers, secret: CANARY_VOICE_SECRET, deploymentMode: env.mode, signal: new AbortController().signal });
  if (!resolved.ok) throw new Error(`[Canary] voice scope refused (${resolved.reason})`);
  return resolved.scope;
}

for (const backend of RETRIEVAL_BACKEND_IDS as readonly BackendId[]) {
  describe.runIf(ENABLED.includes(backend))(`voice-scope canary, multi-tenant (${backend})`, () => {
    let env: CanaryEnv;
    const voiceOn: EntryConfig = { voiceBackend: backend };

    beforeAll(async () => {
      env = await createCanaryEnv(backend, 'multi-tenant');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await env?.close();
    });

    beforeEach(captureLogs);

    it('RAG_RETRIEVAL_BACKEND_VOICE set to the backend: each voice scope sees only its own canary, for the sentence and every marker', async () => {
      for (const label of ['a', 'b', 'o'] as const) {
        const tenant = env.tenants[label]!;
        expectOwnCanary(await voiceRequest(env, tenant, CANARY_SENTENCE, voiceOn), tenant.marker, backend, label);
      }
      for (const label of ['a', 'b', 'o', 'm'] as const) {
        const tenant = env.tenants[label]!;
        const foreign = foreignMarkers(env, label);
        const chunks = foreignChunkIds(env, label);
        for (const query of [CANARY_SENTENCE, ...foreign.map((marker) => `${CANARY_SENTENCE} ${marker}`), ...foreign]) {
          const outcome = await voiceRequest(env, tenant, query, voiceOn);
          expect(outcome.refused, `${label} voice request is served`).toBeNull();
          expect(leakedFrom(outcome, foreign, chunks), `${label} voice, query "${query}"`).toEqual([]);
        }
      }
    });

    it("the organization's member gets the organization's canary only, and the member's personal voice scope never sees it", async () => {
      const o = env.tenants.o!;
      const viaOrg = await voiceRequest(env, o, CANARY_SENTENCE, voiceOn);
      expectOwnCanary(viaOrg, o.marker, backend, 'o');
      expect(viaOrg.scope).toMatchObject({ kind: 'org', userId: env.ids.userM, organizationId: env.ids.orgO });
      expect(viaOrg.ids.every((id) => o.chunkIds.includes(id))).toBe(true);
      const personal = await voiceRequest(env, env.tenants.m!, `${CANARY_SENTENCE} ${o.marker}`, voiceOn);
      expect(leakedFrom(personal, [o.marker], o.chunkIds)).toEqual([]);
    });

    it('a tampered token, a token carrying another tenant, a foreign secret and a left member are refused before retrieval', async () => {
      const a = env.tenants.a!;
      const b = env.tenants.b!;
      const tokenA = await mintCanaryVoiceToken(a.scope);
      const tokenB = await mintCanaryVoiceToken(b.scope);
      const cases: Array<[string, string, number, string]> = [
        ['tampered signature', tamper(tokenA), 401, 'bad_signature'],
        ["B's claims under A's signature", swapClaims(tokenA, tokenB), 401, 'bad_signature'],
        ['minted with another secret', await mintCanaryVoiceToken(b.scope, `${CANARY_VOICE_SECRET}-other-deployment`), 401, 'bad_signature'],
        ['not a token', 'not-a-token', 401, 'malformed'],
      ];
      for (const [name, token, status, reason] of cases) {
        const outcome = await voiceRequest(env, a, CANARY_SENTENCE, voiceOn, { token });
        expect(outcome.refused, name).toEqual({ status, reason });
        expect(outcome.result, `${name}: no retrieval`).toBeNull();
        expect(outcome.rpcCalls, `${name}: no search`).toEqual([]);
      }

      const tokenO = await mintCanaryVoiceToken(env.tenants.o!.scope);
      await env.sql('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [env.ids.orgO, env.ids.userM]);
      try {
        const left = await voiceRequest(env, env.tenants.o!, CANARY_SENTENCE, voiceOn, { token: tokenO });
        expect(left.refused).toEqual({ status: 403, reason: 'not_a_member' });
        expect(left.result).toBeNull();
      } finally {
        await env.sql("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [env.ids.orgO, env.ids.userM]);
      }
      expectOwnCanary(await voiceRequest(env, env.tenants.o!, CANARY_SENTENCE, voiceOn, { token: tokenO }), env.tenants.o!.marker, backend, 'o rejoined');
    });

    it.runIf(isExternalBackend(backend))(
      'RAG_RETRIEVAL_BACKEND set and RAG_RETRIEVAL_BACKEND_VOICE unset: voice is pgvector with no readiness call while chat uses the backend',
      async () => {
        const { resetReadinessCacheForTests } = await import('@/lib/rag/backend/readiness');
        const a = env.tenants.a!;
        const config: EntryConfig = { backend };
        resetReadinessCacheForTests();
        const voice = await voiceRequest(env, a, CANARY_SENTENCE, config);
        expect(voice.selection).toMatchObject({ backend: 'pgvector', fallbackReason: null, tenantValidationDropped: 0, degraded: false });
        expect(voice.rpcCalls).not.toContain('rag_backend_readiness');
        expect(voice.rpcCalls).not.toContain('rag_validate_chunks');
        expect(voice.contents.some((content) => content.includes(a.marker))).toBe(true);
        const chat = await chatRequest(a.scope, CANARY_SENTENCE, config);
        expect(chat.selection).toMatchObject({ backend, fallbackReason: null });
        expect(chat.rpcCalls).toContain('rag_backend_readiness');
      },
    );

    it.runIf(isExternalBackend(backend))(
      "RAG_RETRIEVAL_BACKEND_VOICE set and A's index state stale: voice falls back to pgvector, degraded with backend_not_ready, still isolated",
      async () => {
        const { resetReadinessCacheForTests } = await import('@/lib/rag/backend/readiness');
        const a = env.tenants.a!;
        await env.sql("UPDATE public.rag_backend_index_state SET state = 'stale' WHERE target = $1 AND tenant_key = $2", [backend, a.tenantKey]);
        resetReadinessCacheForTests();
        try {
          const outcome = await voiceRequest(env, a, `${CANARY_SENTENCE} ${env.tenants.b!.marker}`, voiceOn);
          expect(outcome.selection).toMatchObject({ backend: 'pgvector', fallbackReason: 'backend_not_ready', degraded: true });
          expect(outcome.rpcCalls).toContain('rag_backend_readiness');
          expect(outcome.contents.some((content) => content.includes(a.marker)), "A's own canary from pgvector").toBe(true);
          expect(leakedFrom(outcome, foreignMarkers(env, 'a'), foreignChunkIds(env, 'a'))).toEqual([]);
        } finally {
          await env.sql("UPDATE public.rag_backend_index_state SET state = 'ready' WHERE target = $1 AND tenant_key = $2", [backend, a.tenantKey]);
          resetReadinessCacheForTests();
        }
      },
    );

    it.runIf(isExternalBackend(backend))(
      'negative control: a filter-ignoring read client returns foreign ids, and the Supabase re-check drops every one of them',
      async () => {
        const a = env.tenants.a!;
        const b = env.tenants.b!;
        const reader = await filterIgnoringReader(env, b);
        try {
          const outcome = await voiceRequest(env, a, CANARY_SENTENCE, voiceOn);
          const raw = reader.rawIds();
          for (const id of b.chunkIds) expect(raw.has(id), `the control fired: B's ${id} came back from the store`).toBe(true);
          const foreignRaw = [...raw].filter((id) => !a.chunkIds.includes(id));
          expect(foreignRaw.length).toBeGreaterThan(0);
          expect(outcome.selection?.backend, `served by ${backend}`).toBe(backend);
          expect(outcome.ids.filter((id) => raw.has(id) && !a.chunkIds.includes(id)), 'no foreign id survives').toEqual([]);
          expect(leakedFrom(outcome, foreignMarkers(env, 'a'), foreignChunkIds(env, 'a'))).toEqual([]);
          expect(outcome.selection?.tenantValidationDropped).toBe(foreignRaw.length);
          expectSecurityLine(errors, [
            ...foreignRaw,
            ...a.chunkIds,
            ...Object.values(env.tenants).flatMap((tenant) => [tenant!.marker, tenant!.tenantKey]),
            CANARY_SENTENCE,
          ]);
        } finally {
          reader.uninstall();
        }
      },
    );
  });
}

describe.runIf(ENABLED.includes('pgvector'))('voice-scope canary, layer 2 parity and the voice default (pgvector)', () => {
  let env: CanaryEnv;

  beforeAll(async () => {
    env = await createCanaryEnv('pgvector', 'multi-tenant');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await env?.close();
  });

  beforeEach(captureLogs);

  it("negative control: a filter-ignoring RPC returns B's rows for A's voice scope, and rag_validate_chunks under that scope drops them", async () => {
    const [{ createPgvectorBackend }, { loadRagConfig }, { getRagDeps }, { revalidateChunks }, { canonicalTenantKey }, { queryLexicalTokens }] = await Promise.all([
      import('@/lib/rag/backend/pgvector'),
      import('@/lib/rag/config'),
      import('@/lib/rag/deps'),
      import('@/lib/rag/backend/revalidate'),
      import('@/lib/rag/backend/tenant-key'),
      import('@/lib/rag/lexical/tokenize'),
    ]);
    const a = env.tenants.a!;
    const b = env.tenants.b!;
    const scope = await resolvedVoiceScope(env, a.scope);
    expect(canonicalTenantKey(scope)).toBe(a.tenantKey);
    const fake = filterIgnoringRpc(env.client, b.tenantKey);
    const broken = createPgvectorBackend({ adminClient: () => fake.client, getConfig: () => loadRagConfig(getRagDeps().ragEnv()) });
    const legs = await broken.search({
      scope,
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
    for (const id of b.chunkIds) expect(raw, `the control fired: B's ${id} came back for A's scope`).toContain(id);
    expect(raw.some((id) => a.chunkIds.includes(id))).toBe(false);
    const validated = await revalidateChunks(scope, raw, { client: env.client, profileId: LEGACY_PROFILE, signal: new AbortController().signal });
    expect([...validated.chunks.keys()], 'no foreign id survives the re-check').toEqual([]);
    expect(validated).toMatchObject({ requested: raw.length, dropped: raw.length });
    const own = await revalidateChunks(scope, [...raw, ...a.chunkIds], { client: env.client, profileId: LEGACY_PROFILE, signal: new AbortController().signal });
    expect([...own.chunks.keys()].sort()).toEqual([...a.chunkIds].sort());
  });

  it('RAG_RETRIEVAL_BACKEND_VOICE unset with RAG_RETRIEVAL_BACKEND=qdrant: voice makes no readiness call, chat does', async () => {
    const { resetReadinessCacheForTests } = await import('@/lib/rag/backend/readiness');
    const a = env.tenants.a!;
    const config: EntryConfig = { backend: 'qdrant' };
    resetReadinessCacheForTests();
    const voice = await voiceRequest(env, a, CANARY_SENTENCE, config);
    expect(voice.selection).toMatchObject({ backend: 'pgvector', fallbackReason: null, degraded: false });
    expect(voice.rpcCalls).not.toContain('rag_backend_readiness');
    expect(voice.contents.some((content) => content.includes(a.marker))).toBe(true);
    const chat = await chatRequest(a.scope, CANARY_SENTENCE, config);
    expect(chat.rpcCalls).toContain('rag_backend_readiness');
    // Nothing is synced to Qdrant in this environment, so chat falls back, and says so.
    expect(chat.selection).toMatchObject({ backend: 'pgvector', fallbackReason: 'backend_not_ready', degraded: true });
  });
});

describe.runIf(ENABLED.includes('pgvector'))('voice-scope canary, single-tenant (pgvector)', () => {
  let env: CanaryEnv;

  beforeAll(async () => {
    env = await createCanaryEnv('pgvector', 'single-tenant');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await env?.close();
  });

  beforeEach(captureLogs);

  it('a single-tenant voice token carries s:default and is served its documents; a multi-tenant token is refused', async () => {
    const s = env.tenants.s!;
    const { verifyVoiceToken } = await import('@/lib/rag/tenant/voice-token');
    const token = await mintCanaryVoiceToken(s.scope);
    const verified = verifyVoiceToken(token, { secret: CANARY_VOICE_SECRET });
    expect(verified.ok && verified.payload.tk).toBe('s:default');
    const outcome = await voiceRequest(env, s, CANARY_SENTENCE, { voiceBackend: 'pgvector' });
    expectOwnCanary(outcome, s.marker, 'pgvector', 's');
    expect(outcome.scope).toMatchObject({ kind: 'single' });
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const personal = await mintCanaryVoiceToken(mintScope('personal', env.ids.userA, null));
    const refused = await voiceRequest(env, s, CANARY_SENTENCE, { voiceBackend: 'pgvector' }, { token: personal });
    expect(refused.refused).toEqual({ status: 401, reason: 'mode_mismatch' });
    expect(refused.result).toBeNull();
  });
});
