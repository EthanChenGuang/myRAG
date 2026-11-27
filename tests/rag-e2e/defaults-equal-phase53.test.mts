import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import type { ProbeItem } from './phase53-defaults-probe.mts';

// D-57 (plan 05.3-48): with the six Phase 5.3 switches at their defaults, fixture retrieval and answers equal the committed
// reference, no table of migrations 0960 to 0979 gets a row from any entry point, and the monitor, sample and drift routes answer 404.
// Record the reference again only on purpose: PHASE53_RECORD_REFERENCE=1 node --import tsx --test <this file>.

const REPO_ROOT = process.cwd();
const REFERENCE_PATH = path.join(REPO_ROOT, 'tests/rag-e2e/defaults-equal-phase53.reference.json');
const PROBE_PATH = path.join(REPO_ROOT, 'tests/rag-e2e/phase53-defaults-probe.mts');
const RECORD = process.env.PHASE53_RECORD_REFERENCE === '1';

const PHASE_53_SWITCHES = [
  'RAG_MONITOR',
  'RAG_MONITOR_WEBHOOK_URL',
  'RAG_MONITOR_WEBHOOK_SECRET',
  'RAG_CONFIG_GATE',
  'RAG_CONFIG_GATE_LIVE',
  'RAG_REPRESENTATIVE_SAMPLE',
] as const;

// @/lib/env snapshots process.env at its first import: the switches are cleared before any app module loads.
const SAVED_SWITCHES = new Map(PHASE_53_SWITCHES.map((name) => [name, process.env[name]]));
for (const name of PHASE_53_SWITCHES) delete process.env[name];
process.env.OPENAI_API_KEY ||= 'placeholder-openai-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

// One fake edge for both modes, started before any app module reads the environment; each mode swaps its own database behind it.
const bootstrap = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' });
const sharedEdge: FakeEdge = await startFakeEdge({ db: bootstrap.db });
Object.assign(process.env, fixtureProcessEnv(sharedEdge.url));
const ADMIN_ID = '00000000-0000-4000-8000-000000005348';
const ADMIN_TOKEN = 'phase53-defaults-admin-token';
const ALERT_ID = '00000000-0000-4000-8000-0000000053a1';

after(async () => {
  await sharedEdge.close();
  await bootstrap.db.close();
  for (const [name, value] of SAVED_SWITCHES) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Every table a Phase 5.3 migration (0960 to 0979) creates, read from the files. */
function phase53Tables(): string[] {
  const dir = path.join(REPO_ROOT, 'supabase/migrations');
  const names = new Set<string>();
  for (const file of fs.readdirSync(dir)) {
    const stem = Number(file.slice(0, 4));
    if (!(stem >= 960 && stem <= 979)) continue;
    for (const match of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z0-9_]+)/gi)) names.add(match[1]!);
  }
  return [...names].sort();
}

interface Reference {
  recorded_at_commit: string;
  note: string;
  switches: Record<string, string>;
  items: ProbeItem[];
}

function gitHead(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function envWithoutSwitches(): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...process.env };
  for (const name of PHASE_53_SWITCHES) delete child[name];
  delete child.PHASE53_RECORD_REFERENCE;
  // A child of node:test with this variable set reports TAP on stdout instead of running as a plain script.
  delete child.NODE_TEST_CONTEXT;
  return child;
}

describe('defaults equal Phase 5.3: the six switch names and their off values (D-57)', () => {
  test('the switch list here names exactly the keys of PHASE53_SWITCH_DEFAULTS', async () => {
    const { PHASE53_SWITCH_DEFAULTS } = await import('@/lib/rag/monitor/config');
    assert.deepEqual(Object.keys(PHASE53_SWITCH_DEFAULTS).sort(), [...PHASE_53_SWITCHES].sort());
  });

  test('unset, and set to the default strings, every switch resolves to off; the eval env pins the defaults', async () => {
    const { PHASE53_SWITCH_DEFAULTS, monitorSettings } = await import('@/lib/rag/monitor/config');
    const off = { monitor: false, webhookUrl: null, webhookSecret: null, configGate: 'off', configGateLive: false, representativeSample: false };
    assert.deepEqual(monitorSettings({}), off);
    assert.deepEqual(monitorSettings({ ...PHASE53_SWITCH_DEFAULTS }), off);
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8')) as Record<string, string>;
    for (const name of PHASE_53_SWITCHES) assert.equal(pinned[name], PHASE53_SWITCH_DEFAULTS[name], name);
  });

  test('the migration files create the Phase 5.3 tables this test counts', () => {
    const tables = phase53Tables();
    assert.ok(tables.length >= 14, `parsed ${tables.length} Phase 5.3 tables`);
    for (const table of ['rag_config_change_records', 'rag_eval_run_requests', 'rag_monitor_daily', 'rag_monitor_alerts', 'rag_monitor_runs', 'rag_pilot_users']) {
      assert.ok(tables.includes(table), table);
    }
  });
});

describe('defaults equal Phase 5.3: fixture retrieval and answers equal the committed reference (D-57)', () => {
  test('every fixture item has the reference ranked chunk ids, scores, refusal decision and answer hash', { timeout: 600_000 }, () => {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phase53-probe-')), 'items.json');
    const run = spawnSync(process.execPath, ['--import', 'tsx', PROBE_PATH, outFile], { cwd: REPO_ROOT, env: envWithoutSwitches(), encoding: 'utf8' });
    assert.equal(run.status, 0, `probe failed: ${run.stderr.slice(-2000)}`);
    const { items } = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { items: ProbeItem[] };
    fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
    assert.ok(items.length > 0, 'the probe returned no item');
    assert.ok(items.every((item) => item.refused === true || item.answer_sha256 !== null), 'an item that was not refused has no answer');

    if (RECORD) {
      const reference: Reference = {
        recorded_at_commit: gitHead(),
        note:
          'Recorded with every Phase 5.3 switch unset (prechunked, single-tenant, fake citation generator). Ids, scores and answer hashes only; see the 05.3-48 SUMMARY for why this commit and not the pre-phase commit.',
        switches: Object.fromEntries(PHASE_53_SWITCHES.map((name) => [name, 'unset'])),
        items,
      };
      fs.writeFileSync(REFERENCE_PATH, `${JSON.stringify(reference, null, 1)}\n`);
      return;
    }

    const reference = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8')) as Reference;
    assert.match(reference.recorded_at_commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(
      items.map((item) => item.item_id),
      reference.items.map((item) => item.item_id),
      'the fixture item set differs from the reference',
    );
    const expected = new Map(reference.items.map((item) => [item.item_id, item]));
    const differing = items.filter((item) => JSON.stringify(item) !== JSON.stringify(expected.get(item.item_id))).map((item) => item.item_id);
    assert.deepEqual(differing, [], `${differing.length} item(s) differ from the reference`);
  });
});

for (const mode of MODES) {
  describe(`defaults equal Phase 5.3 (${mode}): no entry point writes a Phase 5.3 row and the gated routes answer 404 (D-57)`, () => {
    let db: PGlite;
    let edge: FakeEdge;
    let cwd: string;
    let envDir: string;
    let tenantKey: string;
    let scope: import('@/lib/rag/tenant/scope').TenantScope;
    let admin: import('@supabase/supabase-js').SupabaseClient;
    const tables = phase53Tables();
    const saved = new Map<string, string | undefined>();
    const restoreMocks: Array<() => void> = [];

    const rowCounts = async (): Promise<Record<string, number>> => {
      const counts: Record<string, number> = {};
      for (const table of tables) counts[table] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0]?.n ?? -1;
      return counts;
    };
    const zero = Object.fromEntries(tables.map((table) => [table, 0]));

    const bearer = (url: string, init: { method?: string; body?: unknown } = {}): Request =>
      new Request(url, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });

    const newBatch = async (): Promise<string> => {
      const [row] = (await db.query<{ id: string }>("SELECT id FROM rag_create_ingestion_batch($1, 'folder', 'fixture', NULL, 1, 'worker', NULL)", [tenantKey])).rows;
      return row!.id;
    };

    const finish = async (batchId: string) => {
      const { finishBatch } = await import('@/lib/rag/ingest/backfill/orchestrate');
      const io = { out: () => {}, err: () => {} };
      return finishBatch({ id: batchId, scope }, { rpc: admin as never, signal: new AbortController().signal, io: io as never });
    };

    before(async () => {
      for (const name of ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'RAG_RETRIEVAL_LOG', 'RAG_DOMAIN_EXPERT_REVIEW']) {
        saved.set(name, process.env[name]);
        delete process.env[name];
      }
      cwd = process.cwd();
      envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase53-env-'));
      fs.writeFileSync(path.join(envDir, '.env.local'), 'RAG_BEHAVIOR_MODE=strict\nRAG_PRE_CONTEXT=placeholder pre-context\n');
      const empty = await createEmptyFixtureDatabase({ deploymentMode: mode });
      db = empty.db;
      edge = sharedEdge;
      edge.useDatabase(db);
      process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ADMIN_ID, 'phase53-admin@example.invalid']);
      await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [ADMIN_ID]);
      const supabase = await import('@/lib/supabase');
      admin = supabase.getSupabaseAdmin() as unknown as import('@supabase/supabase-js').SupabaseClient;
      const auth = (admin as unknown as { auth: { getUser: (token: string) => Promise<unknown> } }).auth;
      const getUser = mock.method(auth, 'getUser', async (token: string) =>
        token === ADMIN_TOKEN ? { data: { user: { id: ADMIN_ID } }, error: null } : { data: { user: null }, error: { message: 'invalid' } },
      );
      restoreMocks.push(() => getUser.mock.restore());
      const { mintScope, scopeKey } = await import('@/lib/rag/tenant/scope');
      scope = mode === 'single-tenant' ? mintScope('single', null, null) : mintScope('personal', ADMIN_ID, null);
      tenantKey = scopeKey(scope);
    });

    after(async () => {
      process.chdir(cwd);
      for (const restore of restoreMocks) restore();
      await db?.close();
      fs.rmSync(envDir, { recursive: true, force: true });
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    test('a backfill completion and a re-embed completion request no tenant nightly', async () => {
      const batchId = await newBatch();
      await finish(batchId);
      const [batch] = (await db.query<{ status: string }>('SELECT status FROM ingestion_batches WHERE id = $1', [batchId])).rows;
      assert.equal(batch?.status, 'completed');
      const { runReembed } = await import('@/lib/rag/ingest/reembed/run');
      const report = await runReembed({ db: admin as never, profileId: 'voyage-4-large-2048', batchSize: 4 });
      assert.equal(report.status, 'completed');
      assert.deepEqual(await rowCounts(), zero);
    });

    test('the daily monitor run and the weekly sample read and write nothing', async () => {
      const { runDaily } = await import('@/lib/rag/monitor/daily');
      const { drawWeeklySample } = await import('@/lib/rag/monitor/sample');
      const callsBefore = edge.calls.length;
      assert.deepEqual(await runDaily(admin, { source: 'cli' } as never), { ran: false, reason: 'switched_off' });
      const sample = await drawWeeklySample(admin, { tenantKey });
      assert.equal(sample.written, false);
      assert.equal(edge.calls.length, callsBefore, 'the off paths reached the database');
      assert.deepEqual(await rowCounts(), zero);
    });

    test('one save through each app env writer is written without a check or a change record', async () => {
      const configRoute = await import('@/app/api/config/route');
      const modelsRoute = await import('@/app/api/config/models/route');
      const promptRoute = await import('@/app/api/config/rag-prompt/route');
      process.chdir(envDir);
      try {
        const saves: Array<[string, Response]> = [
          ['config', await configRoute.POST(bearer('http://localhost/api/config', { method: 'POST', body: { config: { RAG_BEHAVIOR_MODE: 'balanced' } } }))],
          [
            'models',
            await modelsRoute.POST(
              bearer('http://localhost/api/config/models', {
                method: 'POST',
                body: {
                  provider: 'openrouter',
                  openaiModels: [{ id: 'model-a', displayName: 'Model A' }],
                  openrouterModels: [{ id: 'vendor/model-b', displayName: 'Model B' }],
                  groqModels: [],
                },
              }) as never,
            ),
          ],
          ['rag-prompt', await promptRoute.POST(bearer('http://localhost/api/config/rag-prompt', { method: 'POST', body: { preContext: 'a neutral placeholder pre-context' } }) as never)],
        ];
        for (const [route, response] of saves) {
          const body = (await response.json()) as Record<string, unknown>;
          assert.equal(response.status, 200, `${route}: ${JSON.stringify(body)}`);
          assert.ok(body.ragGate === undefined || body.ragGate === null, `${route} carried a gate result`);
        }
        const written = fs.readFileSync(path.join(envDir, '.env.local'), 'utf8');
        assert.match(written, /^RAG_BEHAVIOR_MODE=balanced$/m);
        assert.match(written, /^NEXT_PUBLIC_AI_PROVIDER=openrouter$/m);
        assert.ok(!fs.existsSync(path.join(envDir, 'eval/out/config-gate')), 'a gate check was stored');
      } finally {
        process.chdir(cwd);
      }
      assert.deepEqual(await rowCounts(), zero);
    });

    test('the monitor, alert, judge-score, sample, drift and cluster routes answer 404 before the admin check', async () => {
      const base = 'http://localhost/api/rag/admin/monitor';
      const run = await import('@/app/api/rag/admin/monitor/run/route');
      const alerts = await import('@/app/api/rag/admin/monitor/alerts/route');
      const alertAction = await import('@/app/api/rag/admin/monitor/alerts/[id]/[action]/route');
      const judge = await import('@/app/api/rag/admin/monitor/judge-scores/route');
      const sample = await import('@/app/api/rag/admin/monitor/sample/route');
      const driftInputs = await import('@/app/api/rag/admin/monitor/drift-inputs/route');
      const drift = await import('@/app/api/rag/admin/monitor/drift/route');
      const assign = await import('@/app/api/rag/admin/monitor/assign-clusters/route');
      const callsBefore = edge.calls.length;
      const answers: Array<[string, Response]> = [
        ['run POST', await run.POST(bearer(`${base}/run`, { method: 'POST', body: {} }))],
        ['alerts GET', await alerts.GET(bearer(`${base}/alerts`))],
        [
          'alert action POST',
          await alertAction.POST(bearer(`${base}/alerts/${ALERT_ID}/acknowledge`, { method: 'POST', body: {} }), {
            params: Promise.resolve({ id: ALERT_ID, action: 'acknowledge' }),
          }),
        ],
        ['judge-scores POST', await judge.POST(bearer(`${base}/judge-scores`, { method: 'POST', body: { scores: [] } }))],
        ['sample GET', await sample.GET(bearer(`${base}/sample`))],
        ['sample POST', await sample.POST(bearer(`${base}/sample`, { method: 'POST', body: {} }))],
        ['drift-inputs GET', await driftInputs.GET(bearer(`${base}/drift-inputs`))],
        ['drift GET', await drift.GET(bearer(`${base}/drift`))],
        ['drift POST', await drift.POST(bearer(`${base}/drift`, { method: 'POST', body: {} }))],
        ['assign-clusters POST', await assign.POST(bearer(`${base}/assign-clusters`, { method: 'POST', body: { items: [] } }))],
      ];
      for (const [name, response] of answers) assert.equal(response.status, 404, name);
      assert.equal(edge.calls.length, callsBefore, 'a gated route reached the database');
      assert.deepEqual(await rowCounts(), zero);
    });

    test('the change-record and pilot-user lists are empty', async () => {
      // The fake edge serves no table read of these stores; the list functions run on a PGlite-backed admin client instead.
      const { createPgliteAdmin } = await import('../helpers/pglite-admin.ts');
      const { listChangeRecords } = await import('@/lib/rag/config-gate/gate-core');
      const { listPilotUsers } = await import('@/lib/rag/monitor/pilot-users');
      const direct = createPgliteAdmin(db) as never;
      assert.deepEqual(await listChangeRecords(direct, { since: '2000-01-01T00:00:00.000Z', limit: 200 }), { ok: true, records: [] });
      const page = await listPilotUsers(direct, tenantKey, null);
      assert.deepEqual(page.users, []);
      assert.deepEqual(await rowCounts(), zero);
    });

    test('control: with RAG_CONFIG_GATE=warn the same nightly request writes its row, so the counts above can see a row', async () => {
      const { requestTenantNightly } = await import('@/lib/rag/config-gate/eval-run-requests');
      const { monitorSettings } = await import('@/lib/rag/monitor/config');
      const batchId = await newBatch();
      const off = await requestTenantNightly(admin as never, { tenantKey, reason: 'backfill_completed', refId: batchId });
      assert.deepEqual(off, { ok: true, requested: false });
      const warn = await requestTenantNightly(
        admin as never,
        { tenantKey, reason: 'backfill_completed', refId: batchId },
        { settings: () => monitorSettings({ RAG_CONFIG_GATE: 'warn' }) },
      );
      assert.equal(warn.ok, true);
      const counts = await rowCounts();
      assert.equal(counts.rag_eval_run_requests, 1);
      assert.deepEqual({ ...counts, rag_eval_run_requests: 0 }, zero);
    });
  });
}
