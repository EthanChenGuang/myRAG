import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { createPgliteAdmin } from '../helpers/pglite-admin.ts';
import { seedRetrievalLog, type SeedCell } from '../helpers/retrieval-log-seed.ts';

process.env.OPENAI_API_KEY ||= 'placeholder-openai-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key';
const { main, parseMonitorArgs, USAGE } = await import('../../src/lib/rag/monitor/cli.ts');

const WEBHOOK = 'https://hooks.example.test/monitor';
const SECRET = 's'.repeat(40);
const TENANT = 's:default';
const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
  RAG_RETRIEVAL_LOG: 'ids',
};
const ON_ENV = { ...BASE_ENV, RAG_MONITOR: 'true', RAG_MONITOR_WEBHOOK_URL: WEBHOOK, RAG_MONITOR_WEBHOOK_SECRET: SECRET };
const BASELINE_DAYS = ['2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'];
const NOW = new Date('2026-03-06T00:30:00Z');

interface Captured {
  out: string[];
  err: string[];
}

function io(): { io: { out: (line: string) => void; err: (line: string) => void }; captured: Captured } {
  const captured: Captured = { out: [], err: [] };
  return { io: { out: (line) => captured.out.push(line), err: (line) => captured.err.push(line) }, captured };
}

function fakeFetch(status: number): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fn = async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(null, { status });
  };
  return { fetch: fn as unknown as typeof fetch, urls };
}

const publicLookup = async () => [{ address: '203.0.113.10', family: 4 }];

function noClient(): () => never {
  return () => {
    throw new Error('no client may be created');
  };
}

describe('parseMonitorArgs', () => {
  test('defaults to daily and refuses unknown input', () => {
    assert.deepEqual(parseMonitorArgs([]), { command: 'daily' });
    assert.equal(parseMonitorArgs(['nonsense']).command, 'invalid');
    assert.equal(parseMonitorArgs(['daily', '--extra']).command, 'invalid');
    assert.equal(parseMonitorArgs(['record-change', '--keys', 'RAG_RERANKER']).command, 'invalid');
    assert.equal(parseMonitorArgs(['test-alert']).command, 'invalid');
    assert.match(USAGE, /record-change --keys/);
    assert.match(USAGE, /test-alert --tenant/);
  });
});

describe('rag:monitor without a database', () => {
  test('RAG_MONITOR off prints one notice and returns 0 without creating a client', async () => {
    for (const argv of [[], ['daily'], ['test-alert', '--tenant', TENANT]]) {
      const { io: cliIo, captured } = io();
      const code = await main(argv, cliIo, { env: { ...BASE_ENV, RAG_MONITOR: 'false' }, createClient: noClient() });
      assert.equal(code, 0);
      assert.equal(captured.out.length + captured.err.length, 1);
      assert.match([...captured.out, ...captured.err][0]!, /RAG_MONITOR is off/);
    }
  });

  test('an unknown subcommand or option returns 2 with the usage text', async () => {
    for (const argv of [['nonsense'], ['daily', '--since', 'x'], ['test-alert', '--tenant', 'bad-key'], ['record-change', '--keys', 'lower_case', '--reason', 'a neutral reason text']]) {
      const { io: cliIo, captured } = io();
      const code = await main(argv, cliIo, { env: ON_ENV, createClient: noClient() });
      assert.equal(code, 2, argv.join(' '));
      assert.ok(captured.err.some((line) => line.includes('usage: npm run rag:monitor')), argv.join(' '));
    }
  });

  test('record-change refuses a reason of 9 characters', async () => {
    const { io: cliIo, captured } = io();
    const code = await main(['record-change', '--keys', 'RAG_RERANKER', '--reason', '123456789'], cliIo, { env: ON_ENV, createClient: noClient() });
    assert.equal(code, 2);
    assert.ok(!captured.err.join('\n').includes('123456789'));
  });

  test('test-alert delivers a synthetic alert and prints one line per channel; a failed webhook returns 1', async () => {
    const ok = fakeFetch(204);
    const good = io();
    assert.equal(await main(['test-alert', '--tenant', TENANT], good.io, { env: ON_ENV, createClient: noClient(), fetch: ok.fetch, lookupHost: publicLookup }), 0);
    assert.deepEqual(ok.urls, [WEBHOOK]);
    assert.ok(good.captured.out.some((line) => /webhook: delivered/.test(line)));
    assert.ok(good.captured.out.some((line) => /langfuse: disabled/.test(line)));
    assert.ok(good.captured.out.some((line) => /banner: not stored/.test(line)));
    assert.ok(!good.captured.out.join('\n').includes('hooks.example.test'));
    assert.ok(!good.captured.out.join('\n').includes(SECRET));

    const bad = fakeFetch(500);
    const failed = io();
    assert.equal(await main(['test-alert', '--tenant', TENANT], failed.io, { env: ON_ENV, createClient: noClient(), fetch: bad.fetch, lookupHost: publicLookup }), 1);
    assert.ok(failed.captured.out.some((line) => /webhook: failed/.test(line)));
  });
});

describe('rag:monitor on PGlite', () => {
  let db: PGlite;
  let admin: SupabaseClient;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    admin = createPgliteAdmin(db, { jsonColumns: ['delivered', 'gate_summary'] }) as unknown as SupabaseClient;
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec(`
      DELETE FROM public.rag_monitor_runs;
      DELETE FROM public.rag_monitor_alerts;
      DELETE FROM public.rag_monitor_daily;
      DELETE FROM public.rag_config_change_records;
      DELETE FROM public.rag_retrieval_log;
    `);
  });

  test('daily aggregates, opens the alert, delivers it once and prints counts', async () => {
    const cells: SeedCell[] = [
      ...BASELINE_DAYS.map((day) => ({ tenantKey: TENANT, day, language: 'it', ragMode: 'strict' as const, channel: 'chat' as const, rows: 25, counts: { refused: 3 } })),
      { tenantKey: TENANT, day: '2026-03-05', language: 'it', ragMode: 'strict', channel: 'chat', rows: 100, counts: { refused: 38 } },
    ];
    await seedRetrievalLog(db, { seed: 'monitor-cli', cells });
    const hook = fakeFetch(204);
    const run = io();
    const code = await main([], run.io, { env: ON_ENV, createClient: () => admin, fetch: hook.fetch, lookupHost: publicLookup, now: NOW });
    assert.equal(code, 0, run.captured.err.join('\n'));
    const text = run.captured.out.join('\n');
    assert.match(text, /days_aggregated \d+/);
    assert.match(text, /alerts_opened [1-9]/);
    assert.match(text, /alerts_updated 0/);
    assert.match(text, /webhook delivered [1-9]/);
    assert.ok(!text.includes('hooks.example.test'));
    assert.ok(hook.urls.length >= 1);
    assert.ok(hook.urls.every((url) => url === WEBHOOK));

    const rows = (await db.query<{ delivered: Record<string, { state: string; attempts: number }> }>('SELECT delivered FROM public.rag_monitor_alerts')).rows;
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.equal(row.delivered.webhook?.state, 'delivered');
      assert.equal(row.delivered.webhook?.attempts, 1);
      assert.equal(row.delivered.langfuse?.state, 'disabled');
    }

    const again = fakeFetch(204);
    const second = io();
    assert.equal(await main(['daily'], second.io, { env: ON_ENV, createClient: () => admin, fetch: again.fetch, lookupHost: publicLookup, now: NOW }), 0);
    assert.deepEqual(again.urls, [], 'a delivered alert is not sent again');
  });

  test('daily with the retrieval log off prints a notice and returns 0', async () => {
    const run = io();
    const code = await main([], run.io, { env: { ...ON_ENV, RAG_RETRIEVAL_LOG: 'off' }, createClient: () => admin, now: NOW });
    assert.equal(code, 0);
    assert.match(run.captured.out.join('\n'), /retrieval log is off/);
    assert.equal((await db.query('SELECT 1 FROM public.rag_monitor_runs')).rows.length, 0);
  });

  test('record-change inserts one cli record with the keys and returns 0 without printing the reason', async () => {
    const reason = 'host settings updated after review';
    const run = io();
    const code = await main(['record-change', '--keys', 'RAG_RERANKER,RAG_PIPELINE', '--reason', reason], run.io, { env: ON_ENV, createClient: () => admin });
    assert.equal(code, 0, run.captured.err.join('\n'));
    assert.ok(!run.captured.out.join('\n').includes(reason));
    const rows = (
      await db.query<{ source: string; actor: string; changed_keys: string[]; gate_result: string; override_reason: string; before_hash: string; after_hash: string }>(
        'SELECT source, actor, changed_keys, gate_result, override_reason, before_hash, after_hash FROM public.rag_config_change_records',
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.source, 'cli');
    assert.equal(rows[0]!.actor, 'cli');
    assert.deepEqual([...rows[0]!.changed_keys].sort(), ['RAG_PIPELINE', 'RAG_RERANKER']);
    assert.equal(rows[0]!.gate_result, 'skipped');
    assert.equal(rows[0]!.override_reason, reason);
    assert.match(rows[0]!.before_hash, /^[a-f0-9]{64}$/);
    assert.match(run.captured.out.join('\n'), /change recorded [0-9a-f-]{36}/);
  });

  test('record-change also works with RAG_MONITOR off', async () => {
    const run = io();
    const code = await main(['record-change', '--keys', 'RAG_RERANKER', '--reason', 'declared host change'], run.io, { env: { ...BASE_ENV, RAG_MONITOR: 'false' }, createClient: () => admin });
    assert.equal(code, 0, run.captured.err.join('\n'));
    assert.equal((await db.query('SELECT 1 FROM public.rag_config_change_records')).rows.length, 1);
  });

  test('test-alert writes no alert row', async () => {
    const run = io();
    assert.equal(await main(['test-alert', '--tenant', TENANT], run.io, { env: ON_ENV, createClient: () => admin, fetch: fakeFetch(204).fetch, lookupHost: publicLookup }), 0);
    assert.equal((await db.query('SELECT 1 FROM public.rag_monitor_alerts')).rows.length, 0);
  });
});
