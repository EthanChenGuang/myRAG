import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetRagConfigForTests, type RagEnvInput } from '@/lib/rag/config';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { LEGACY_PROFILE } from '@/lib/rag/embeddings/active-profile';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';
import {
  SCOPE_CENTROID_CACHE_TTL_MS,
  centroidRefreshesSettledForTests,
  getCentroidSnapshot,
  invalidateCentroidCache,
  resetCentroidCacheForTests,
} from '@/lib/rag/scope/centroids';
import { addScopeExample, deleteScopeExample, scopeGateStatus, startScopeRebuild } from '@/lib/rag/scope/admin';
import { SCOPE_CENTROIDS_HOOK, runScopeCentroidsHook } from '@/lib/rag/scope/post-publish';
import { afterPublish, postPublishSettledForTests, resetPostPublishHooksForTests } from '@/lib/rag/ingest/post-publish';
import { main as scopeCli, parseScopeCentroidArgs } from '@/lib/rag/scope/rebuild/cli';

const USER_A = '00000000-0000-4000-8000-00000000a001';
const USER_B = '00000000-0000-4000-8000-00000000b001';
const SCOPE_A = mintScope('personal', USER_A, null);
const SCOPE_B = mintScope('personal', USER_B, null);
const KEY_A = `u:${USER_A}`;
const KEY_B = `u:${USER_B}`;
const PROFILE = LEGACY_PROFILE.id;
const DIMS = 4;
const SECRET_TEXT = 'zebrafishquartz neutral synthetic example';

const LAYER_ON: RagEnvInput = { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_SCOPE_GATE: 'true' };
const LAYER_OFF: RagEnvInput = {};

type Row = Record<string, unknown>;
type Handler = (args: Row) => Promise<{ data: unknown; error: { code: string; message: string } | null }> | { data: unknown; error: { code: string; message: string } | null };

interface Call {
  fn: string;
  args: Row;
}

function fakeClient(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const client = {
    calls,
    rpc(fn: string, args: Row) {
      calls.push({ fn, args });
      const handler = handlers[fn];
      const run = Promise.resolve().then(() => (handler ? handler(args) : { data: null, error: { code: '42883', message: 'missing' } }));
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => run.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return client;
}

function vec(values: number[]): string {
  const out = new Array<number>(DIMS).fill(0);
  values.forEach((value, index) => {
    out[index] = value;
  });
  return `[${out.join(',')}]`;
}

function centroidRows(tenantKey: string, count = 2): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      group_kind: i === 0 ? 'tenant' : 'doc_type',
      group_key: i === 0 ? 'tenant/en' : `general${i}/en`,
      centroid: vec(tenantKey === KEY_A ? [3, 4] : [0, 0, 2]),
      dims: DIMS,
      member_count: 10 + i,
      updated_at: '2026-11-27T00:00:00Z',
    });
  }
  return rows;
}

function statusRow(over: Row = {}): Row {
  return {
    doc_type_groups: 1,
    scope_tag_groups: 0,
    tenant_groups: 1,
    chunks_included: 21,
    newest_update: '2026-11-27T00:00:00Z',
    has_scoped_binding: false,
    examples: 0,
    ...over,
  };
}

function readHandlers(overrides: Partial<Record<string, Handler>> = {}): Record<string, Handler> {
  return {
    rag_scope_centroids_list: (args) => ({ data: centroidRows(String(args.p_tenant_key)), error: null }),
    rag_scope_examples_list: () => ({ data: [], error: null }),
    rag_scope_status: () => ({ data: [statusRow()], error: null }),
    ...overrides,
  } as Record<string, Handler>;
}

let clock = 1_000_000;
let warn: ReturnType<typeof vi.spyOn>;

function install(client: ReturnType<typeof fakeClient> | null, env: RagEnvInput = LAYER_ON, embedder?: (text: string) => Promise<number[]>) {
  setRagDepsForTests({
    adminClient: () => client as never,
    now: () => clock,
    ragEnv: () => env,
    embedder: async (text: string) => (embedder ? embedder(text) : new Array<number>(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0))),
  });
}

function loggedText(): string {
  return warn.mock.calls.map((call: unknown[]) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')).join('\n');
}

beforeEach(() => {
  clock = 1_000_000;
  resetCentroidCacheForTests();
  resetRagConfigForTests();
  resetPostPublishHooksForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(async () => {
  await centroidRefreshesSettledForTests();
  resetRagDepsForTests();
  vi.restoreAllMocks();
});

describe('getCentroidSnapshot: cached, never waits for the database', () => {
  test('a cold cache answers null at once and schedules one refresh; afterwards the snapshot is served', async () => {
    const client = fakeClient(readHandlers());
    install(client);
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)).toBeNull();
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)).toBeNull();
    await centroidRefreshesSettledForTests();
    expect(client.calls.filter((call) => call.fn === 'rag_scope_centroids_list')).toHaveLength(1);
    const snapshot = getCentroidSnapshot(SCOPE_A, PROFILE);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.tenantKey).toBe(KEY_A);
    expect(snapshot?.profileId).toBe(PROFILE);
    expect(snapshot?.unsupported).toBe(false);
    expect(snapshot?.centroids).toHaveLength(2);
    const first = snapshot!.centroids[0]!;
    expect(first.vector).toBeInstanceOf(Float32Array);
    expect(first.vector[0]).toBeCloseTo(0.6, 5);
    expect(first.vector[1]).toBeCloseTo(0.8, 5);
    for (const call of client.calls) expect(call.args.p_tenant_key).toBe(KEY_A);
  });

  test('the request path never awaits I/O: a hanging read still answers synchronously', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = fakeClient(
      readHandlers({
        rag_scope_centroids_list: async (args) => {
          await gate;
          return { data: centroidRows(String(args.p_tenant_key)), error: null };
        },
      }),
    );
    install(client);
    const started = performance.now();
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
    release();
    await centroidRefreshesSettledForTests();
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)).not.toBeNull();
  });

  test('after 60 s the stale snapshot is served while one background refresh runs', async () => {
    let version = 0;
    const client = fakeClient(
      readHandlers({
        rag_scope_centroids_list: (args) => {
          version += 1;
          return { data: centroidRows(String(args.p_tenant_key), version === 1 ? 1 : 3), error: null };
        },
      }),
    );
    install(client);
    getCentroidSnapshot(SCOPE_A, PROFILE);
    await centroidRefreshesSettledForTests();
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)?.centroids).toHaveLength(1);
    clock += SCOPE_CENTROID_CACHE_TTL_MS - 1;
    getCentroidSnapshot(SCOPE_A, PROFILE);
    await centroidRefreshesSettledForTests();
    expect(version).toBe(1);
    clock += 2;
    const stale = getCentroidSnapshot(SCOPE_A, PROFILE);
    expect(stale?.centroids).toHaveLength(1);
    getCentroidSnapshot(SCOPE_A, PROFILE);
    await centroidRefreshesSettledForTests();
    expect(version).toBe(2);
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)?.centroids).toHaveLength(3);
  });

  test('at most 200 centroids by member count and 100 examples, all unit-normalized', async () => {
    const many: Row[] = Array.from({ length: 260 }, (_, i) => ({
      group_kind: 'doc_type',
      group_key: `type${i}/en`,
      centroid: vec([1, i]),
      dims: DIMS,
      member_count: i,
      updated_at: '2026-11-27T00:00:00Z',
    }));
    const examples: Row[] = Array.from({ length: 120 }, (_, i) => ({ id: `ex-${i}`, text: SECRET_TEXT, embedding: vec([0, 0, 0, 2 + i]), dims: DIMS }));
    install(fakeClient(readHandlers({ rag_scope_centroids_list: () => ({ data: many, error: null }), rag_scope_examples_list: () => ({ data: examples, error: null }) })));
    getCentroidSnapshot(SCOPE_A, PROFILE);
    await centroidRefreshesSettledForTests();
    const snapshot = getCentroidSnapshot(SCOPE_A, PROFILE)!;
    expect(snapshot.centroids).toHaveLength(200);
    expect(Math.min(...snapshot.centroids.map((c) => c.memberCount))).toBe(60);
    expect(snapshot.examples).toHaveLength(100);
    for (const vector of [...snapshot.centroids.map((c) => c.vector), ...snapshot.examples]) {
      const norm = Math.sqrt(Array.from(vector).reduce((sum, value) => sum + value * value, 0));
      expect(norm).toBeCloseTo(1, 4);
    }
    expect(JSON.stringify(snapshot)).not.toContain('zebrafishquartz');
  });

  test('a load error keeps the previous snapshot, logs once and never throws', async () => {
    let fail = false;
    const client = fakeClient(
      readHandlers({
        rag_scope_centroids_list: (args) =>
          fail ? { data: null, error: { code: 'XX000', message: 'boom' } } : { data: centroidRows(String(args.p_tenant_key)), error: null },
      }),
    );
    install(client);
    getCentroidSnapshot(SCOPE_A, PROFILE);
    await centroidRefreshesSettledForTests();
    fail = true;
    clock += SCOPE_CENTROID_CACHE_TTL_MS + 1;
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)?.centroids).toHaveLength(2);
    await centroidRefreshesSettledForTests();
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)?.centroids).toHaveLength(2);
    clock += SCOPE_CENTROID_CACHE_TTL_MS + 1;
    getCentroidSnapshot(SCOPE_A, PROFILE);
    await centroidRefreshesSettledForTests();
    const failures = warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('[Scope Gate]'));
    expect(failures).toHaveLength(1);

    resetCentroidCacheForTests();
    install(fakeClient(readHandlers({ rag_scope_status: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) })));
    expect(() => getCentroidSnapshot(SCOPE_B, PROFILE)).not.toThrow();
    await centroidRefreshesSettledForTests();
    expect(getCentroidSnapshot(SCOPE_B, PROFILE)).toBeNull();
    install(null);
    resetCentroidCacheForTests();
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)).toBeNull();
    await centroidRefreshesSettledForTests();
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)).toBeNull();
  });

  test('two tenants have separate entries; invalidating one tenant drops only that tenant', async () => {
    const client = fakeClient(readHandlers());
    install(client);
    getCentroidSnapshot(SCOPE_A, PROFILE);
    getCentroidSnapshot(SCOPE_B, PROFILE);
    await centroidRefreshesSettledForTests();
    const a = getCentroidSnapshot(SCOPE_A, PROFILE)!;
    const b = getCentroidSnapshot(SCOPE_B, PROFILE)!;
    expect(a.tenantKey).toBe(KEY_A);
    expect(b.tenantKey).toBe(KEY_B);
    expect(a.centroids[0]!.vector[0]).toBeCloseTo(0.6, 5);
    expect(b.centroids[0]!.vector[2]).toBeCloseTo(1, 5);
    expect(getCentroidSnapshot(SCOPE_A, 'bge-m3-1024')).toBeNull();
    invalidateCentroidCache(SCOPE_A);
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)).toBeNull();
    expect(getCentroidSnapshot(SCOPE_B, PROFILE)?.tenantKey).toBe(KEY_B);
  });

  test('a tenant with a doc-type-scoped binding is reported unsupported', async () => {
    install(fakeClient(readHandlers({ rag_scope_status: () => ({ data: [statusRow({ has_scoped_binding: true })], error: null }) })));
    getCentroidSnapshot(SCOPE_A, PROFILE);
    await centroidRefreshesSettledForTests();
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)?.unsupported).toBe(true);
  });
});

describe('example service', () => {
  function exampleClient(existing: Row[] = []) {
    const stored: Row[] = [...existing];
    return {
      stored,
      client: fakeClient(
        readHandlers({
          rag_scope_examples_list: () => ({ data: stored, error: null }),
          rag_scope_example_add: (args) => {
            stored.push({ id: `id-${stored.length}`, text: args.p_text, embedding: args.p_embedding, dims: 1536, created_by: args.p_actor, created_at: 'now' });
            return { data: [{ id: `id-${stored.length - 1}`, created_at: '2026-11-27T00:00:00Z' }], error: null };
          },
          rag_scope_example_delete: (args) => ({ data: args.p_id === 'id-0', error: null }),
        }),
      ),
    };
  }

  test('a valid example is embedded with the active profile and stored with its vector', async () => {
    const { client, stored } = exampleClient();
    const embedded: string[] = [];
    install(client, LAYER_ON, async (text) => {
      embedded.push(text);
      return new Array<number>(1536).fill(0.5);
    });
    const result = await addScopeExample(SCOPE_A, { text: `  ${SECRET_TEXT}  `, actorId: USER_A });
    expect(result).toMatchObject({ ok: true });
    expect(embedded).toEqual([SECRET_TEXT]);
    expect(stored).toHaveLength(1);
    const add = client.calls.find((call) => call.fn === 'rag_scope_example_add')!;
    expect(add.args.p_tenant_key).toBe(KEY_A);
    expect(add.args.p_profile_id).toBe(PROFILE);
    expect(add.args.p_text).toBe(SECRET_TEXT);
    expect(String(add.args.p_embedding).startsWith('[0.5,')).toBe(true);
    expect(loggedText()).not.toContain('zebrafishquartz');
  });

  test('empty, too long, duplicate and limit cases return their codes and embed nothing', async () => {
    const embedded: string[] = [];
    const embed = async (text: string) => {
      embedded.push(text);
      return new Array<number>(1536).fill(0.5);
    };
    install(exampleClient().client, LAYER_ON, embed);
    expect(await addScopeExample(SCOPE_A, { text: '   ', actorId: USER_A })).toEqual({ ok: false, code: 'text_empty' });
    expect(await addScopeExample(SCOPE_A, { text: 'x'.repeat(501), actorId: USER_A })).toEqual({ ok: false, code: 'text_too_long' });
    install(exampleClient([{ id: 'id-0', text: 'A  Neutral Example', created_at: 'now' }]).client, LAYER_ON, embed);
    expect(await addScopeExample(SCOPE_A, { text: 'a neutral   example', actorId: USER_A })).toEqual({ ok: false, code: 'example_exists' });
    const full = Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, text: `example ${i}`, created_at: 'now' }));
    install(exampleClient(full).client, LAYER_ON, embed);
    expect(await addScopeExample(SCOPE_A, { text: 'one more example', actorId: USER_A })).toEqual({ ok: false, code: 'limit' });
    expect(embedded).toEqual([]);
  });

  test('the database refusals map to the same codes', async () => {
    const codes: Array<[string, string]> = [
      ['23505', 'example_exists'],
      ['54000', 'limit'],
      ['22001', 'text_too_long'],
    ];
    for (const [sqlState, code] of codes) {
      install(
        fakeClient(readHandlers({ rag_scope_example_add: () => ({ data: null, error: { code: sqlState, message: 'refused' } }) })),
        LAYER_ON,
      );
      expect(await addScopeExample(SCOPE_A, { text: 'a neutral example', actorId: USER_A })).toEqual({ ok: false, code });
    }
  });

  test('an embedding failure returns embedding_unavailable and stores nothing', async () => {
    const { client, stored } = exampleClient();
    install(client, LAYER_ON, async () => {
      throw new Error('provider down');
    });
    expect(await addScopeExample(SCOPE_A, { text: SECRET_TEXT, actorId: USER_A })).toEqual({ ok: false, code: 'embedding_unavailable' });
    install(client, LAYER_ON, async () => [1, 2, 3]);
    expect(await addScopeExample(SCOPE_A, { text: SECRET_TEXT, actorId: USER_A })).toEqual({ ok: false, code: 'embedding_unavailable' });
    expect(stored).toHaveLength(0);
    expect(client.calls.some((call) => call.fn === 'rag_scope_example_add')).toBe(false);
  });

  test('add and delete invalidate only that tenant; delete reports not_found', async () => {
    const { client } = exampleClient();
    install(client);
    getCentroidSnapshot(SCOPE_A, PROFILE);
    getCentroidSnapshot(SCOPE_B, PROFILE);
    await centroidRefreshesSettledForTests();
    await addScopeExample(SCOPE_A, { text: 'a neutral example', actorId: USER_A });
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)).toBeNull();
    expect(getCentroidSnapshot(SCOPE_B, PROFILE)).not.toBeNull();
    await centroidRefreshesSettledForTests();
    expect(await deleteScopeExample(SCOPE_A, 'id-0')).toEqual({ ok: true });
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)).toBeNull();
    expect(await deleteScopeExample(SCOPE_A, 'id-9')).toEqual({ ok: false, code: 'not_found' });
    const deletes = client.calls.filter((call) => call.fn === 'rag_scope_example_delete');
    for (const call of deletes) expect(call.args.p_tenant_key).toBe(KEY_A);
  });
});

describe('scopeGateStatus and startScopeRebuild', () => {
  function rebuildRows(): Row[] {
    return [
      { group_kind: 'doc_type', groups: 2, chunks: 4 },
      { group_kind: 'scope_tag', groups: 1, chunks: 2 },
      { group_kind: 'tenant', groups: 2, chunks: 4 },
    ];
  }

  test('status reports per-kind counts, chunks included, newest update, unsupported and the CLI command', async () => {
    install(fakeClient(readHandlers({ rag_scope_status: () => ({ data: [statusRow({ has_scoped_binding: true, examples: 3, scope_tag_groups: 4 })], error: null }) })));
    const status = await scopeGateStatus(SCOPE_A);
    expect(status).toEqual({
      ok: true,
      status: {
        profileId: PROFILE,
        groups: { doc_type: 1, scope_tag: 4, tenant: 1 },
        chunksIncluded: 21,
        newestUpdate: '2026-11-27T00:00:00Z',
        examples: 3,
        rebuildRunning: false,
        unsupported: true,
        command: `npm run rag:scope-centroids -- --tenant ${KEY_A}`,
      },
    });
  });

  test('a quick rebuild answers done with the counts and invalidates the tenant cache', async () => {
    const client = fakeClient(readHandlers({ rag_scope_centroids_rebuild: () => ({ data: rebuildRows(), error: null }) }));
    install(client);
    getCentroidSnapshot(SCOPE_A, PROFILE);
    await centroidRefreshesSettledForTests();
    const result = await startScopeRebuild(SCOPE_A, { waitMs: 1000 });
    expect(result).toMatchObject({ status: 'done', result: { tenantKey: KEY_A, profileId: PROFILE, counts: { doc_type: { groups: 2, chunks: 4 }, scope_tag: { groups: 1, chunks: 2 }, tenant: { groups: 2, chunks: 4 } } } });
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)).toBeNull();
  });

  test('a slow rebuild answers started, reports running, and a second start answers running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    install(
      fakeClient(
        readHandlers({
          rag_scope_centroids_rebuild: async () => {
            await gate;
            return { data: rebuildRows(), error: null };
          },
        }),
      ),
    );
    expect(await startScopeRebuild(SCOPE_A, { waitMs: 5 })).toEqual({ status: 'started' });
    expect(await startScopeRebuild(SCOPE_A, { waitMs: 5 })).toEqual({ status: 'running' });
    const status = await scopeGateStatus(SCOPE_A);
    expect(status.ok && status.status.rebuildRunning).toBe(true);
    const other = await scopeGateStatus(SCOPE_B);
    expect(other.ok && other.status.rebuildRunning).toBe(false);
    release();
    await vi.waitFor(async () => {
      const after = await scopeGateStatus(SCOPE_A);
      expect(after.ok && after.status.rebuildRunning).toBe(false);
    });
  });

  test('a failing rebuild answers failed with a code', async () => {
    install(fakeClient(readHandlers({ rag_scope_centroids_rebuild: () => ({ data: null, error: { code: '42501', message: 'denied' } }) })));
    expect(await startScopeRebuild(SCOPE_A, { waitMs: 1000 })).toEqual({ status: 'failed', code: 'rebuild_failed' });
  });
});

describe('post-publish hook', () => {
  function hookClient(rebuild: Handler = () => ({ data: [], error: null })) {
    return fakeClient(readHandlers({ rag_scope_centroids_rebuild: rebuild }));
  }

  test('after a publish the hook rebuilds that tenant for the active profile and invalidates its cache entry', async () => {
    const client = hookClient();
    install(client);
    getCentroidSnapshot(SCOPE_A, PROFILE);
    getCentroidSnapshot(SCOPE_B, PROFILE);
    await centroidRefreshesSettledForTests();
    await afterPublish({ documentId: '00000000-0000-4000-8000-0000000000d1', tenantKey: KEY_A });
    await postPublishSettledForTests();
    const rebuilds = client.calls.filter((call) => call.fn === 'rag_scope_centroids_rebuild');
    expect(rebuilds).toEqual([{ fn: 'rag_scope_centroids_rebuild', args: { p_tenant_key: KEY_A, p_profile_id: PROFILE } }]);
    expect(getCentroidSnapshot(SCOPE_A, PROFILE)).toBeNull();
    expect(getCentroidSnapshot(SCOPE_B, PROFILE)).not.toBeNull();
  });

  test('a rebuild error or timeout is logged once and the publish still resolves', async () => {
    install(hookClient(() => ({ data: null, error: { code: 'XX000', message: 'boom' } })));
    await expect(afterPublish({ documentId: '00000000-0000-4000-8000-0000000000d1', tenantKey: KEY_A })).resolves.toBeUndefined();
    await expect(afterPublish({ documentId: '00000000-0000-4000-8000-0000000000d2', tenantKey: KEY_A })).resolves.toBeUndefined();
    const scopeLines = warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('[Scope Gate]'));
    expect(scopeLines).toHaveLength(1);

    const controller = new AbortController();
    install(hookClient(() => new Promise(() => undefined)));
    const run = runScopeCentroidsHook({ documentId: '00000000-0000-4000-8000-0000000000d3', tenantKey: KEY_B }, controller.signal);
    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });

  test('with RAG_SCOPE_GATE off the hook does nothing', async () => {
    const client = hookClient();
    install(client, LAYER_OFF);
    await afterPublish({ documentId: '00000000-0000-4000-8000-0000000000d1', tenantKey: KEY_A });
    await runScopeCentroidsHook({ documentId: '00000000-0000-4000-8000-0000000000d1', tenantKey: KEY_A }, new AbortController().signal);
    install(client, { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' });
    resetRagConfigForTests();
    await afterPublish({ documentId: '00000000-0000-4000-8000-0000000000d1', tenantKey: KEY_A });
    expect(client.calls).toEqual([]);
    expect(SCOPE_CENTROIDS_HOOK).toBe('scope_centroids');
  });

  test('a malformed tenant key in the event makes no SQL call', async () => {
    const client = hookClient();
    install(client);
    await runScopeCentroidsHook({ documentId: '00000000-0000-4000-8000-0000000000d1', tenantKey: 'u:not-a-uuid' }, new AbortController().signal);
    expect(client.calls).toEqual([]);
  });
});

describe('rag:scope-centroids CLI', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
  }

  test('argument parsing', () => {
    expect(parseScopeCentroidArgs(['--tenant', KEY_A])).toEqual({ ok: true, help: false, tenantKey: KEY_A, profileId: null });
    expect(parseScopeCentroidArgs(['--tenant', 's:default', '--profile', 'bge-m3-1024'])).toEqual({ ok: true, help: false, tenantKey: 's:default', profileId: 'bge-m3-1024' });
    expect(parseScopeCentroidArgs(['--help'])).toMatchObject({ ok: true, help: true });
    expect(parseScopeCentroidArgs([])).toMatchObject({ ok: false });
    expect(parseScopeCentroidArgs(['--tenant'])).toMatchObject({ ok: false });
    expect(parseScopeCentroidArgs(['--tenant', 'x:bad'])).toMatchObject({ ok: false });
    expect(parseScopeCentroidArgs(['--tenant', KEY_A, '--profile', 'bad profile'])).toMatchObject({ ok: false });
    expect(parseScopeCentroidArgs(['--tenant', KEY_A, '--tenant', KEY_B])).toMatchObject({ ok: false });
    expect(parseScopeCentroidArgs(['--tenant', KEY_A, '--other'])).toMatchObject({ ok: false });
  });

  test('a missing or malformed tenant key exits non-zero with a usage line; --help exits 0', async () => {
    const missing = io();
    expect(await scopeCli([], missing.io)).toBe(2);
    expect(missing.err.some((line) => line.startsWith('usage: npm run rag:scope-centroids'))).toBe(true);
    const malformed = io();
    expect(await scopeCli(['--tenant', 'u:nope'], malformed.io)).toBe(2);
    expect(malformed.err.some((line) => line.startsWith('usage:'))).toBe(true);
    const help = io();
    expect(await scopeCli(['--help'], help.io)).toBe(0);
    expect(help.out.some((line) => line.startsWith('usage: npm run rag:scope-centroids'))).toBe(true);
  });

  test('rebuilds one tenant and prints counts', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'placeholder-service-role');
    const client = fakeClient(
      readHandlers({
        rag_scope_centroids_rebuild: () => ({
          data: [
            { group_kind: 'doc_type', groups: 2, chunks: 4 },
            { group_kind: 'scope_tag', groups: 0, chunks: 0 },
            { group_kind: 'tenant', groups: 1, chunks: 4 },
          ],
          error: null,
        }),
        rag_list_embedding_profiles: () => ({ data: [], error: null }),
      }),
    );
    install(client);
    const run = io();
    expect(await scopeCli(['--tenant', KEY_A], run.io)).toBe(0);
    expect(client.calls.filter((call) => call.fn === 'rag_scope_centroids_rebuild')).toEqual([
      { fn: 'rag_scope_centroids_rebuild', args: { p_tenant_key: KEY_A, p_profile_id: PROFILE } },
    ]);
    expect(run.out.join('\n')).toContain('doc_type: 2 groups, 4 chunks');
    expect(run.out.join('\n')).toContain('tenant: 1 groups, 4 chunks');
    vi.unstubAllEnvs();
  });

  test('without the service-role key the CLI refuses', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const run = io();
    expect(await scopeCli(['--tenant', KEY_A], run.io)).toBe(1);
    vi.unstubAllEnvs();
  });
});

test('scope keys in fixtures are minted scopes', () => {
  expect(scopeKey(SCOPE_A)).toBe(KEY_A);
});
