import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const BROWSER_ROLES = ['anon', 'authenticated'] as const;
const TABLES = ['rag_monitor_daily', 'rag_monitor_alerts'];
const FUNCTIONS = ['rag_monitor_purge(integer)', 'rag_monitor_alert_upsert(jsonb)', 'rag_monitor_alert_set_status(uuid,text,uuid)'];

type Role = 'anon' | 'authenticated' | 'service_role';

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function rejectsWith(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.equal(sqlState(error), code, String((error as Error).message));
    return true;
  });
}

function tenantKeys(mode: DeploymentMode): { own: string; other: string; foreign: string } {
  if (mode === 'single-tenant') return { own: 's:default', other: 's:default', foreign: `o:${crypto.randomUUID()}` };
  return { own: `o:${crypto.randomUUID()}`, other: `u:${crypto.randomUUID()}`, foreign: 's:default' };
}

function histogram(): number[] {
  return Array.from({ length: 22 }, () => 0);
}

async function insertCell(db: PGlite, tenantKey: string, ageDays: number, overrides: Record<string, unknown> = {}): Promise<void> {
  const cell = {
    language: 'und',
    rag_mode: 'strict',
    channel: 'chat',
    doc_type: 'unknown',
    retrievals: 10,
    refused: 2,
    ...overrides,
  };
  await db.query(
    `INSERT INTO public.rag_monitor_daily (tenant_key, day, language, rag_mode, channel, doc_type, retrievals, refused, top_score_hist, latency_hist)
     VALUES ($1, current_date - $2::int, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
    [
      tenantKey,
      ageDays,
      cell.language,
      cell.rag_mode,
      cell.channel,
      cell.doc_type,
      cell.retrievals,
      cell.refused,
      JSON.stringify({ similarity: histogram() }),
      JSON.stringify(histogram()),
    ],
  );
}

function alertPayload(tenantKey: string, dedupKey: string, day: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_key: tenantKey,
    rule: 'refusal_rate',
    kind: 'rate',
    language: 'und',
    day,
    window_days: 1,
    severity: 'alert',
    observed_count: 38,
    observed_total: 100,
    baseline_count: 12,
    baseline_total: 100,
    observed_rate: 0.38,
    baseline_rate: 0.12,
    band: { ratio: 2, min_abs_delta: 0.05, min_z: 3 },
    breakdown: { rag_mode: { strict: 38 } },
    companions: { not_helpful_rate: 0.02 },
    sample_trace_ids: [crypto.randomBytes(16).toString('hex')],
    config_changes: [],
    suggestion: 'check_recent_config_changes',
    delivered: {},
    dedup_key: dedupKey,
    ...overrides,
  };
}

async function upsertAlert(db: PGlite, payload: Record<string, unknown>): Promise<string | null> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ id: string | null }>('SELECT public.rag_monitor_alert_upsert($1::jsonb) AS id', [JSON.stringify(payload)]),
  );
  return result.rows[0]?.id ?? null;
}

async function setStatus(db: PGlite, id: string, status: string): Promise<boolean> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ ok: boolean }>('SELECT public.rag_monitor_alert_set_status($1::uuid, $2, $3::uuid) AS ok', [id, status, crypto.randomUUID()]),
  );
  return result.rows[0]?.ok === true;
}

async function alertRows(db: PGlite, dedupKey: string): Promise<Array<{ id: string; day: string; status: string; observed_count: number }>> {
  return (
    await db.query<{ id: string; day: string; status: string; observed_count: number }>(
      "SELECT id, to_char(day, 'YYYY-MM-DD') AS day, status, observed_count FROM public.rag_monitor_alerts WHERE dedup_key = $1 ORDER BY created_at, day",
      [dedupKey],
    )
  ).rows;
}

for (const mode of MODES) {
  describe(`monitor storage: rag_monitor_daily (${mode})`, () => {
    let db: PGlite;
    let keys: ReturnType<typeof tenantKeys>;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      keys = tenantKeys(mode);
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      if ((await db.query<{ t: string | null }>("SELECT to_regclass('public.rag_monitor_daily')::text AS t")).rows[0]?.t) {
        await db.exec('DELETE FROM public.rag_monitor_daily');
      }
    });

    test('the table exists with the six cell columns as its primary key', async () => {
      const rows = await db.query<{ column_name: string }>(
        `SELECT a.attname AS column_name
           FROM pg_catalog.pg_index i
           JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
          WHERE i.indrelid = to_regclass('public.rag_monitor_daily') AND i.indisprimary
          ORDER BY a.attname`,
      );
      assert.deepEqual(
        rows.rows.map((row) => row.column_name),
        ['channel', 'day', 'doc_type', 'language', 'rag_mode', 'tenant_key'],
      );
    });

    test('holds counts and histograms only: no column can carry query, answer, chunk or document text', async () => {
      const columns = (
        await db.query<{ column_name: string; data_type: string }>(
          "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_monitor_daily' ORDER BY ordinal_position",
        )
      ).rows;
      const names = columns.map((column) => column.column_name);
      for (const required of [
        'retrievals',
        'refused',
        'kb_unavailable',
        'degraded',
        'error',
        'zero_result',
        'below_threshold',
        'helpful',
        'not_helpful',
        'judged',
        'groundedness_flagged',
        'judge_score_sums',
        'top_score_hist',
        'latency_hist',
      ]) {
        assert.ok(names.includes(required), `missing column ${required}`);
      }
      const textColumns = columns.filter((column) => column.data_type === 'text').map((column) => column.column_name).sort();
      assert.deepEqual(textColumns, ['channel', 'doc_type', 'language', 'rag_mode', 'tenant_key']);
    });

    test('a second insert of the same cell violates the primary key', async () => {
      await insertCell(db, keys.own, 1);
      await rejectsWith('23505', () => insertCell(db, keys.own, 1));
      await insertCell(db, keys.own, 1, { channel: 'voice' });
      if (mode === 'multi-tenant') await insertCell(db, keys.other, 1);
    });

    test('negative counts, free text in code columns and malformed histograms are rejected', async () => {
      await rejectsWith('23514', () => insertCell(db, keys.own, 2, { retrievals: -1 }));
      await rejectsWith('23514', () => insertCell(db, keys.own, 2, { refused: -3 }));
      await rejectsWith('23514', () => insertCell(db, keys.own, 2, { doc_type: 'a sentence with spaces' }));
      await rejectsWith('23514', () => insertCell(db, keys.own, 2, { language: 'not a code' }));
      await rejectsWith('23514', () => insertCell(db, keys.own, 2, { channel: 'whatsapp' }));
      await rejectsWith('23514', () => insertCell(db, keys.own, 2, { rag_mode: 'other' }));
      await rejectsWith('23514', () =>
        db.query(
          `INSERT INTO public.rag_monitor_daily (tenant_key, day, language, rag_mode, channel, doc_type, top_score_hist)
           VALUES ($1, current_date, 'und', 'strict', 'chat', 'unknown', $2::jsonb)`,
          [keys.own, JSON.stringify({ similarity: [1, 2, 3] })],
        ),
      );
      await rejectsWith('23514', () =>
        db.query(
          `INSERT INTO public.rag_monitor_daily (tenant_key, day, language, rag_mode, channel, doc_type, top_score_hist)
           VALUES ($1, current_date, 'und', 'strict', 'chat', 'unknown', $2::jsonb)`,
          [keys.own, JSON.stringify({ cosine: histogram() })],
        ),
      );
      await rejectsWith('23514', () =>
        db.query(
          `INSERT INTO public.rag_monitor_daily (tenant_key, day, language, rag_mode, channel, doc_type)
           VALUES ('tenant-a', current_date, 'und', 'strict', 'chat', 'unknown')`,
        ),
      );
    });

    test('rag_monitor_purge(400) deletes a cell dated 401 days ago and keeps one dated 399 days ago', async () => {
      await insertCell(db, keys.own, 401);
      await insertCell(db, keys.own, 399);
      const purged = await asRole(db, 'service_role', () => db.query<{ n: number }>('SELECT public.rag_monitor_purge(400) AS n'));
      assert.equal(purged.rows[0]?.n, 1);
      const left = await db.query<{ age: number }>('SELECT (current_date - day)::int AS age FROM public.rag_monitor_daily');
      assert.deepEqual(left.rows.map((row) => row.age), [399]);
      const byDefault = await asRole(db, 'service_role', () => db.query<{ n: number }>('SELECT public.rag_monitor_purge() AS n'));
      assert.equal(byDefault.rows[0]?.n, 0);
    });

    test('rag_monitor_purge refuses a window below one day', async () => {
      await rejectsWith('22023', () => asRole(db, 'service_role', () => db.query('SELECT public.rag_monitor_purge(0)')));
    });
  });

  describe(`monitor storage: rag_monitor_alerts (${mode})`, () => {
    let db: PGlite;
    let keys: ReturnType<typeof tenantKeys>;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      keys = tenantKeys(mode);
    });

    after(async () => {
      await db?.close();
    });

    test('has no free-text column: every text column is a code, an id or a hash', async () => {
      const columns = (
        await db.query<{ column_name: string; data_type: string }>(
          "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_monitor_alerts'",
        )
      ).rows;
      const names = new Set(columns.map((column) => column.column_name));
      for (const required of [
        'id',
        'tenant_key',
        'rule',
        'kind',
        'language',
        'day',
        'window_days',
        'severity',
        'status',
        'observed_count',
        'baseline_count',
        'band',
        'breakdown',
        'companions',
        'sample_trace_ids',
        'config_changes',
        'suggestion',
        'delivered',
        'dedup_key',
        'acknowledged_at',
        'acknowledged_by',
        'resolved_at',
        'created_at',
        'updated_at',
      ]) {
        assert.ok(names.has(required), `missing column ${required}`);
      }
      for (const forbidden of ['message', 'query', 'answer', 'note', 'text', 'title', 'description', 'document_name']) {
        assert.ok(!names.has(forbidden), `unexpected column ${forbidden}`);
      }
      const checks = (
        await db.query<{ def: string }>(
          "SELECT pg_get_constraintdef(oid) AS def FROM pg_catalog.pg_constraint WHERE conrelid = 'public.rag_monitor_alerts'::regclass AND contype = 'c'",
        )
      ).rows.map((row) => row.def);
      for (const column of columns.filter((c) => c.data_type === 'text').map((c) => c.column_name)) {
        assert.ok(
          checks.some((def) => def.includes(column)),
          `text column ${column} has no CHECK constraining it to a code`,
        );
      }
      await rejectsWith('23514', () =>
        upsertAlert(db, alertPayload(keys.own, `free-text-${crypto.randomUUID()}`, '2026-11-01', { suggestion: 'Please look at the query about leave.' })),
      );
    });

    test('a new dedup_key inserts an open alert and returns its id', async () => {
      const dedup = `refusal_rate:${crypto.randomUUID()}`;
      const id = await upsertAlert(db, alertPayload(keys.own, dedup, '2026-11-05'));
      assert.match(String(id), /^[0-9a-f-]{36}$/);
      const rows = await alertRows(db, dedup);
      assert.deepEqual(rows.map((row) => [row.id, row.status, row.day]), [[id, 'open', '2026-11-05']]);
      const stored = (await db.query<{ tenant_key: string }>('SELECT tenant_key FROM public.rag_monitor_alerts WHERE id = $1', [id])).rows[0];
      assert.equal(stored?.tenant_key, keys.own);
    });

    test('the same dedup_key on a later day updates day, counts and band on the same row', async () => {
      const dedup = `refusal_rate:${crypto.randomUUID()}`;
      const first = await upsertAlert(db, alertPayload(keys.own, dedup, '2026-11-05'));
      const second = await upsertAlert(
        db,
        alertPayload(keys.own, dedup, '2026-11-06', { observed_count: 41, band: { ratio: 2, min_abs_delta: 0.05, min_z: 3, measured_ratio: 3.4 } }),
      );
      assert.equal(second, first);
      const rows = await alertRows(db, dedup);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.day, '2026-11-06');
      assert.equal(rows[0]?.observed_count, 41);
      const band = (await db.query<{ band: Record<string, number> }>('SELECT band FROM public.rag_monitor_alerts WHERE id = $1', [first])).rows[0]?.band;
      assert.equal(band?.measured_ratio, 3.4);
    });

    test('an earlier day does not move an open alert back', async () => {
      const dedup = `refusal_rate:${crypto.randomUUID()}`;
      const first = await upsertAlert(db, alertPayload(keys.own, dedup, '2026-11-06'));
      const again = await upsertAlert(db, alertPayload(keys.own, dedup, '2026-11-04', { observed_count: 1 }));
      assert.equal(again, first);
      const rows = await alertRows(db, dedup);
      assert.deepEqual(rows.map((row) => [row.day, row.observed_count]), [['2026-11-06', 38]]);
    });

    test('an acknowledged alert is updated and stays acknowledged', async () => {
      const dedup = `refusal_rate:${crypto.randomUUID()}`;
      const id = (await upsertAlert(db, alertPayload(keys.own, dedup, '2026-11-05'))) as string;
      assert.equal(await setStatus(db, id, 'acknowledged'), true);
      const again = await upsertAlert(db, alertPayload(keys.own, dedup, '2026-11-07', { observed_count: 50 }));
      assert.equal(again, id);
      const rows = await alertRows(db, dedup);
      assert.deepEqual(rows.map((row) => [row.id, row.status, row.day, row.observed_count]), [[id, 'acknowledged', '2026-11-07', 50]]);
    });

    test('a resolved alert is not reopened by the same day; a later day opens a new row', async () => {
      const dedup = `refusal_rate:${crypto.randomUUID()}`;
      const id = (await upsertAlert(db, alertPayload(keys.own, dedup, '2026-11-05'))) as string;
      assert.equal(await setStatus(db, id, 'resolved'), true);
      const sameDay = await upsertAlert(db, alertPayload(keys.own, dedup, '2026-11-05', { observed_count: 99 }));
      assert.equal(sameDay, null);
      let rows = await alertRows(db, dedup);
      assert.deepEqual(rows.map((row) => [row.id, row.status, row.observed_count]), [[id, 'resolved', 38]]);

      const later = await upsertAlert(db, alertPayload(keys.own, dedup, '2026-11-06'));
      assert.ok(later && later !== id);
      rows = await alertRows(db, dedup);
      assert.deepEqual(rows.map((row) => [row.id, row.status]), [[id, 'resolved'], [later, 'open']]);
    });

    test('the unique index allows one non-resolved row per dedup_key', async () => {
      const dedup = `refusal_rate:${crypto.randomUUID()}`;
      await upsertAlert(db, alertPayload(keys.own, dedup, '2026-11-05'));
      await rejectsWith('23505', () =>
        db.query(
          `INSERT INTO public.rag_monitor_alerts (tenant_key, rule, kind, language, day, window_days, severity, dedup_key)
           VALUES ($1, 'refusal_rate', 'rate', 'und', '2026-11-09', 1, 'alert', $2)`,
          [keys.own, dedup],
        ),
      );
    });

    test('rag_monitor_alert_set_status allows open to acknowledged and open or acknowledged to resolved only', async () => {
      const dedup = `refusal_rate:${crypto.randomUUID()}`;
      const id = (await upsertAlert(db, alertPayload(keys.own, dedup, '2026-11-05'))) as string;
      assert.equal(await setStatus(db, id, 'open'), false);
      assert.equal(await setStatus(db, id, 'acknowledged'), true);
      const acked = (
        await db.query<{ acknowledged_at: string | null; acknowledged_by: string | null }>(
          'SELECT acknowledged_at, acknowledged_by FROM public.rag_monitor_alerts WHERE id = $1',
          [id],
        )
      ).rows[0];
      assert.ok(acked?.acknowledged_at && acked.acknowledged_by);
      assert.equal(await setStatus(db, id, 'acknowledged'), false);
      assert.equal(await setStatus(db, id, 'resolved'), true);
      assert.equal(await setStatus(db, id, 'resolved'), false);
      assert.equal(await setStatus(db, id, 'acknowledged'), false);
      assert.equal(await setStatus(db, id, 'open'), false);
      assert.equal(await setStatus(db, id, 'closed'), false);
      assert.equal(await setStatus(db, crypto.randomUUID(), 'resolved'), false);

      const direct = (await upsertAlert(db, alertPayload(keys.own, `refusal_rate:${crypto.randomUUID()}`, '2026-11-05'))) as string;
      assert.equal(await setStatus(db, direct, 'resolved'), true);
      const resolved = (await db.query<{ resolved_at: string | null }>('SELECT resolved_at FROM public.rag_monitor_alerts WHERE id = $1', [direct])).rows[0];
      assert.ok(resolved?.resolved_at);
    });

    test('eleven sample trace ids, and rule, kind, severity or status outside their lists are rejected', async () => {
      const traces = Array.from({ length: 11 }, () => crypto.randomBytes(16).toString('hex'));
      await rejectsWith('23514', () => upsertAlert(db, alertPayload(keys.own, `r:${crypto.randomUUID()}`, '2026-11-05', { sample_trace_ids: traces })));
      const ten = await upsertAlert(db, alertPayload(keys.own, `r:${crypto.randomUUID()}`, '2026-11-05', { sample_trace_ids: traces.slice(0, 10) }));
      assert.ok(ten);
      await rejectsWith('23514', () => upsertAlert(db, alertPayload(keys.own, `r:${crypto.randomUUID()}`, '2026-11-05', { rule: 'made_up_rule' })));
      await rejectsWith('23514', () => upsertAlert(db, alertPayload(keys.own, `r:${crypto.randomUUID()}`, '2026-11-05', { kind: 'other' })));
      await rejectsWith('23514', () => upsertAlert(db, alertPayload(keys.own, `r:${crypto.randomUUID()}`, '2026-11-05', { severity: 'critical' })));
      await rejectsWith('23514', () =>
        upsertAlert(db, alertPayload(keys.own, `r:${crypto.randomUUID()}`, '2026-11-05', { sample_trace_ids: ['not a trace id'] })),
      );
      await rejectsWith('23514', () =>
        db.query(
          `INSERT INTO public.rag_monitor_alerts (tenant_key, rule, kind, language, day, window_days, severity, status, dedup_key)
           VALUES ($1, 'refusal_rate', 'rate', 'und', '2026-11-09', 1, 'alert', 'snoozed', $2)`,
          [keys.own, `r:${crypto.randomUUID()}`],
        ),
      );
      const reserved = await upsertAlert(
        db,
        alertPayload(keys.own, `language_drop:${crypto.randomUUID()}`, '2026-11-05', { rule: 'language_drop', kind: 'language_drop', language: 'all' }),
      );
      assert.ok(reserved);
    });

    test('a tenant key of the other deployment mode raises 22023 in the upsert', async () => {
      await rejectsWith('22023', () => upsertAlert(db, alertPayload(keys.foreign, `r:${crypto.randomUUID()}`, '2026-11-05')));
      await rejectsWith('22023', () => upsertAlert(db, alertPayload('tenant-a', `r:${crypto.randomUUID()}`, '2026-11-05')));
    });

    test('two tenants keep separate alerts even when a dedup_key is reused', async () => {
      if (mode === 'single-tenant') return;
      const shared = `refusal_rate:${crypto.randomUUID()}`;
      const a = await upsertAlert(db, alertPayload(keys.own, shared, '2026-11-05'));
      const b = await upsertAlert(db, alertPayload(keys.other, shared, '2026-11-06', { observed_count: 7 }));
      assert.ok(a && b && a !== b);
      const rows = (await db.query<{ tenant_key: string; observed_count: number }>('SELECT tenant_key, observed_count FROM public.rag_monitor_alerts WHERE id = $1', [a])).rows;
      assert.deepEqual(rows, [{ tenant_key: keys.own, observed_count: 38 }]);
      const owners = (await db.query<{ tenant_key: string }>('SELECT tenant_key FROM public.rag_monitor_alerts WHERE id = ANY($1::uuid[]) ORDER BY tenant_key', [[a, b]])).rows;
      assert.deepEqual(owners.map((row) => row.tenant_key), [keys.own, keys.other].sort());
    });
  });

  describe(`monitor storage: browser roles (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db?.close();
    });

    for (const role of BROWSER_ROLES) {
      test(`${role} is refused with 42501 on every table and function`, async () => {
        for (const table of TABLES) {
          await rejectsWith('42501', () => asRole(db, role, () => db.query(`SELECT 1 FROM public.${table} LIMIT 1`)));
          await rejectsWith('42501', () => asRole(db, role, () => db.query(`DELETE FROM public.${table}`)));
        }
        await rejectsWith('42501', () => asRole(db, role, () => db.query('SELECT public.rag_monitor_purge(400)')));
        await rejectsWith('42501', () => asRole(db, role, () => db.query("SELECT public.rag_monitor_alert_upsert('{}'::jsonb)")));
        await rejectsWith('42501', () =>
          asRole(db, role, () => db.query("SELECT public.rag_monitor_alert_set_status($1::uuid, 'resolved', NULL)", [crypto.randomUUID()])),
        );
      });
    }

    test('the functions are SECURITY INVOKER with an empty search_path, executable by service_role only', async () => {
      for (const signature of FUNCTIONS) {
        const row = (
          await db.query<{ definer: boolean; config: string[] | null; pub: boolean; anon: boolean; auth: boolean; svc: boolean }>(
            `SELECT p.prosecdef AS definer, p.proconfig AS config,
                    has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                    has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
               FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure($1)`,
            [`public.${signature}`],
          )
        ).rows[0];
        assert.ok(row, `${signature} is missing`);
        assert.equal(row.definer, false, `${signature} must be SECURITY INVOKER`);
        assert.ok((row.config ?? []).some((entry) => entry === 'search_path=""' || entry === 'search_path='), `${signature} search_path`);
        assert.deepEqual([row.pub, row.anon, row.auth, row.svc], [false, false, false, true], signature);
      }
    });

    test('row level security is on and no policy exists on either table', async () => {
      for (const table of TABLES) {
        const rls = (await db.query<{ on: boolean }>('SELECT relrowsecurity AS on FROM pg_catalog.pg_class WHERE oid = $1::regclass', [`public.${table}`])).rows[0];
        assert.equal(rls?.on, true, table);
        const policies = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = $1", [table])).rows[0];
        assert.equal(policies?.n, 0, table);
      }
    });
  });
}
