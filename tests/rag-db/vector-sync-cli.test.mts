import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { main, parseSyncArgs } from '@/lib/rag/sync/cli';
import { createFakeVectorStore, type FakeVectorStore } from '@/lib/rag/sync/stores/fake';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const KEYS = [`u:${TWO_TENANT_IDS.userA}`, `u:${TWO_TENANT_IDS.userB}`, `o:${TWO_TENANT_IDS.orgO}`];

interface Captured {
  out: string[];
  err: string[];
}

function io(): Captured & { out: string[]; err: string[]; io: { out: (l: string) => void; err: (l: string) => void } } {
  const captured = { out: [] as string[], err: [] as string[] };
  return { ...captured, io: { out: (l: string) => captured.out.push(l), err: (l: string) => captured.err.push(l) } };
}

function assertNoTenantKeys(lines: string[]): void {
  const text = lines.join('\n');
  for (const key of KEYS) assert.ok(!text.includes(key), 'output carries no tenant key');
  for (const id of Object.values(TWO_TENANT_IDS)) assert.ok(!text.includes(String(id)), 'output carries no tenant id');
}

describe('vector sync CLI arguments', () => {
  test('every subcommand parses; unknown ones and unknown targets are refused', () => {
    assert.deepEqual(parseSyncArgs(['vector-sync', 'drain']), { ok: true, command: 'drain' });
    assert.deepEqual(parseSyncArgs(['vector-sync', 'status']), { ok: true, command: 'status' });
    assert.deepEqual(parseSyncArgs(['vector-sync', 'backfill', '--target', 'qdrant']), { ok: true, command: 'backfill', target: 'qdrant' });
    assert.deepEqual(parseSyncArgs(['vector-sync', 'targets', 'enable', 'weaviate']), { ok: true, command: 'targets', enabled: true, target: 'weaviate' });
    assert.deepEqual(parseSyncArgs(['vector-sync', 'targets', 'disable', 'qdrant']), { ok: true, command: 'targets', enabled: false, target: 'qdrant' });
    assert.deepEqual(parseSyncArgs(['vector-sync', 'requeue-dead', '--target', 'qdrant']), { ok: true, command: 'requeue-dead', target: 'qdrant' });
    assert.deepEqual(parseSyncArgs(['reconcile']), { ok: true, command: 'reconcile' });
    for (const argv of [
      ['vector-sync', 'purge'],
      ['vector-sync'],
      ['vector-sync', 'backfill', '--target', 'pinecone'],
      ['vector-sync', 'backfill'],
      ['vector-sync', 'targets', 'enable', 'pgvector'],
      ['vector-sync', 'targets', 'toggle', 'qdrant'],
      ['vector-sync', 'drain', '--fast'],
      ['reconcile', '--all'],
      ['other'],
    ]) {
      assert.equal(parseSyncArgs(argv).ok, false, argv.join(' '));
    }
  });

  test('an unknown subcommand or target exits 2 with usage; a missing service-role key exits 3', async () => {
    for (const argv of [['vector-sync', 'purge'], ['vector-sync', 'backfill', '--target', 'pinecone']]) {
      const c = io();
      assert.equal(await main(argv, c.io, { rpc: {} as RpcClient }), 2);
      assert.ok(c.err.some((line) => line.includes('usage: npm run rag:vector-sync')));
    }
    const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9';
    try {
      const c = io();
      assert.equal(await main(['vector-sync', 'status'], c.io), 3);
      assert.ok(c.err.some((line) => line.includes('SUPABASE_SERVICE_ROLE_KEY')));
    } finally {
      if (saved.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
      if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
  });
});

describe('vector sync CLI over the PGlite fixture (multi-tenant)', () => {
  let db: PGlite;
  let edge: FakeEdge;
  let client: RpcClient;
  let store: FakeVectorStore;
  const deps = () => ({ rpc: client, factories: { qdrant: async () => store, weaviate: async () => createFakeVectorStore('weaviate') }, actor: 'cli-test' });

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    edge = await startFakeEdge({ db });
    const env = fixtureProcessEnv(edge.url);
    client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as RpcClient;
    store = createFakeVectorStore('qdrant');
  });

  after(async () => {
    await edge?.close();
    await db?.close();
  });

  test('0708 rag_vector_sync_status is SECURITY INVOKER, search_path empty, service role only', async () => {
    const row = (
      await db.query<{ prosecdef: boolean; proconfig: string[] | null; public_exec: boolean; anon_exec: boolean; auth_exec: boolean; service_exec: boolean }>(
        `SELECT p.prosecdef, p.proconfig,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rag_vector_sync_status'`,
      )
    ).rows;
    assert.equal(row.length, 1);
    assert.equal(row[0].prosecdef, false);
    assert.ok((row[0].proconfig ?? []).includes('search_path=""'));
    assert.deepEqual([row[0].public_exec, row[0].anon_exec, row[0].auth_exec, row[0].service_exec], [false, false, false, true]);
  });

  test('status before enabling: both targets disabled, nothing pending, no tenant keys', async () => {
    const c = io();
    assert.equal(await main(['vector-sync', 'status'], c.io, deps()), 0);
    assert.deepEqual(c.out, [
      '[Vector Sync] qdrant: disabled, pending 0, leased 0, dead 0, oldest pending -',
      '[Vector Sync] weaviate: disabled, pending 0, leased 0, dead 0, oldest pending -',
    ]);
  });

  test('drain and reconcile with no target enabled do nothing and exit 0', async () => {
    for (const argv of [['vector-sync', 'drain'], ['reconcile']]) {
      const c = io();
      assert.equal(await main(argv, c.io, deps()), 0);
      assert.ok(c.out[0].includes('no target is enabled'));
    }
  });

  test('backfill of a disabled target refuses with exit 1', async () => {
    const c = io();
    assert.equal(await main(['vector-sync', 'backfill', '--target', 'qdrant'], c.io, deps()), 1);
    assert.ok(c.err[0].includes('targets enable qdrant'));
  });

  test('targets enable qdrant prints the enqueued tenant count; status shows the pending rows without tenant keys', async () => {
    const tenants = Number(
      (await db.query<{ n: number }>('SELECT count(DISTINCT tenant_key)::int AS n FROM public.documents WHERE is_current AND tenant_key IS NOT NULL')).rows[0].n,
    );
    assert.ok(tenants >= 2);
    const c = io();
    assert.equal(await main(['vector-sync', 'targets', 'enable', 'qdrant'], c.io, deps()), 0);
    assert.deepEqual(c.out, [`[Vector Sync] qdrant enabled; tenants enqueued: ${tenants}`]);
    const s = io();
    assert.equal(await main(['vector-sync', 'status'], s.io, deps()), 0);
    assert.match(s.out[0], new RegExp(`^\\[Vector Sync\\] qdrant: enabled, pending ${tenants}, leased 0, dead 0, oldest pending \\d+s$`));
    assertNoTenantKeys([...c.out, ...s.out]);
  });

  test('backfill --target qdrant drains, then reconciles: every tenant ends ready and the output carries no tenant key', async () => {
    const c = io();
    assert.equal(await main(['vector-sync', 'backfill', '--target', 'qdrant'], c.io, deps()), 0, c.err.join('\n'));
    const slices = c.out.filter((line) => line.startsWith('[Vector Sync] slice '));
    assert.ok(slices.some((line) => line.includes('"mode":"drain"')));
    assert.ok(slices.some((line) => line.includes('"mode":"reconcile"')), 'the bulk operation is followed by reconcile (D-05)');
    assert.ok(c.out.some((line) => /^\[Vector Sync\] reconcile qdrant ready: \d+$/.test(line)));
    assertNoTenantKeys(c.out);
    const states = (await db.query<{ state: string }>("SELECT state FROM public.rag_backend_index_state WHERE target = 'qdrant'")).rows;
    assert.ok(states.length >= 2);
    assert.ok(states.every((row) => row.state === 'ready'), JSON.stringify(states));
  });

  test('rag:reconcile exits 0 while every tenant is ready and 1 after drift', async () => {
    const ready = io();
    assert.equal(await main(['reconcile'], ready.io, deps()), 0, ready.err.join('\n'));
    const key = KEYS.find((k) => store.points('openai-3-small-1536', k).length > 0);
    assert.ok(key, 'some tenant has points');
    const victim = store.points('openai-3-small-1536', key)[0];
    await store.deleteIds('openai-3-small-1536', key, [victim.id]);
    const drift = io();
    assert.equal(await main(['reconcile'], drift.io, deps()), 1);
    assertNoTenantKeys(drift.out);
    const repaired = io();
    assert.equal(await main(['vector-sync', 'drain'], repaired.io, deps()), 0);
    const again = io();
    assert.equal(await main(['reconcile'], again.io, deps()), 0, 'the drain repaired the drift');
  });

  test('requeue-dead --target qdrant prints the requeued count', async () => {
    await db.query(
      "INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key, status, attempts, last_error) VALUES ('qdrant', 'tenant', $1, $1, 'dead', 8, 'store_error')",
      [KEYS[0]],
    );
    const c = io();
    assert.equal(await main(['vector-sync', 'requeue-dead', '--target', 'qdrant'], c.io, deps()), 0);
    assert.deepEqual(c.out, ['[Vector Sync] qdrant: requeued 1 dead rows']);
    const d = io();
    assert.equal(await main(['vector-sync', 'drain'], d.io, deps()), 0);
  });

  test('targets disable qdrant turns it off and enqueues nothing', async () => {
    const c = io();
    assert.equal(await main(['vector-sync', 'targets', 'disable', 'qdrant'], c.io, deps()), 0);
    assert.deepEqual(c.out, ['[Vector Sync] qdrant disabled; tenants enqueued: 0']);
    const s = io();
    await main(['vector-sync', 'status'], s.io, deps());
    assert.match(s.out[0], /^\[Vector Sync\] qdrant: disabled, /);
  });
});

describe('vector sync scheduler recipe (supabase/optional/vector-sync-schedule.sql)', () => {
  const sql = fs.readFileSync('supabase/optional/vector-sync-schedule.sql', 'utf8');

  test('Vault-stored placeholders, the 58 s pg_net timeout, minutely drain, daily reconcile and a cleanup job', () => {
    assert.ok(sql.includes("'<APP_URL>'") && sql.includes("'<RAG_VECTOR_SYNC_SECRET>'"));
    assert.equal((sql.match(/vault\.create_secret/g) ?? []).length, 2);
    assert.equal((sql.match(/timeout_milliseconds := 58000/g) ?? []).length, 2);
    assert.match(sql, /'rag-vector-sync-drain',\s*'\* \* \* \* \*'/);
    assert.match(sql, /'rag-vector-sync-reconcile',\s*'17 3 \* \* \*'/);
    assert.match(sql, /cron\.job_run_details/);
    assert.match(sql, /NOT A MIGRATION/);
  });

  test('no job command embeds the secret: every Authorization header reads it from Vault', () => {
    for (const header of sql.match(/'Authorization', [^\n]+/g) ?? []) assert.match(header, /vault\.decrypted_secrets/);
    assert.ok(!/Bearer [A-Za-z0-9_-]{16,}/.test(sql));
  });

  test('the recipe is outside the migrations and vercel.json has no crons entry', () => {
    assert.ok(!fs.readdirSync('supabase/migrations').some((name) => name.includes('vector-sync-schedule')));
    assert.ok(!fs.readFileSync('vercel.json', 'utf8').includes('"crons"'));
  });
});
