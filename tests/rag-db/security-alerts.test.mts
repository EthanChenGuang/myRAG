import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants.ts';
import { AUTHENTICATED_ALLOW_LIST, normalizeSignature } from '../helpers/security-definer-allow-list.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const GRANTS_MIGRATION = 'supabase/migrations/0410_security_definer_rpc_grants.sql';
const SECURITY_MIGRATIONS = ['supabase/migrations/0942_rag_security_events.sql', 'supabase/migrations/0943_rag_security_alerts_holds.sql'];

const NEW_FUNCTIONS = [
  'rag_set_document_version_label(text, uuid, text)',
  'rag_record_security_events(text, jsonb, integer, integer, boolean)',
  'rag_hold_uploader(text, uuid, uuid, text)',
  'rag_release_uploader_hold(text, uuid, uuid)',
  'rag_acknowledge_security_alert(text, uuid, uuid)',
  'rag_uploader_hold_active(text, uuid)',
  'rag_active_uploader_holds(text, uuid[])',
  'rag_list_security_events(text[], text, uuid, timestamp with time zone, integer, integer)',
  'rag_list_security_alerts(text[])',
  'rag_list_security_uploaders(text[], integer)',
];

type Role = 'anon' | 'authenticated' | 'service_role';

interface RecordResult {
  event_ids: string[];
  alert_ids: string[];
}

interface AlertRow {
  id: string;
  tenant_key: string;
  uploader_id: string;
  event_count: number;
  status: string;
  held: boolean;
}

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsWith(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => sqlState(error) === code);
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function service<T extends Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', async () => (await db.query<T>(sql, params)).rows);
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function createDocument(db: PGlite, userId: string): Promise<{ id: string; tenantKey: string }> {
  const id = crypto.randomUUID();
  await db.query("INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'fixture.txt', 'fixture body', $2)", [id, userId]);
  const tenantKey = (await db.query<{ tenant_key: string }>('SELECT tenant_key FROM documents WHERE id = $1', [id])).rows[0]?.tenant_key as string;
  return { id, tenantKey };
}

function events(count: number, uploader: string | null, extra: Record<string, unknown> = {}): Record<string, unknown>[] {
  return Array.from({ length: count }, () => ({ source: 'ingest_injection', action: 'detected', detector: 'rules', rule_ids: ['r1'], uploader_id: uploader, ...extra }));
}

async function recordEvents(db: PGlite, tenantKey: string, list: unknown[], threshold: number, autoHold = false, windowHours = 24): Promise<RecordResult> {
  const rows = await service<{ result: RecordResult }>(db, 'SELECT public.rag_record_security_events($1, $2::jsonb, $3, $4, $5) AS result', [
    tenantKey,
    JSON.stringify(list),
    threshold,
    windowHours,
    autoHold,
  ]);
  assert.ok(rows[0]);
  return rows[0].result;
}

async function alertsOf(db: PGlite, tenantKeys: string[]): Promise<AlertRow[]> {
  return service<AlertRow & Record<string, unknown>>(
    db,
    'SELECT id, tenant_key, uploader_id, event_count, status, held FROM public.rag_list_security_alerts($1::text[]) ORDER BY created_at, id',
    [tenantKeys],
  );
}

async function holdActive(db: PGlite, tenantKey: string, userId: string): Promise<boolean> {
  const rows = await service<{ active: boolean }>(db, 'SELECT public.rag_uploader_hold_active($1, $2) AS active', [tenantKey, userId]);
  return rows[0]?.active === true;
}

async function word(db: PGlite, sql: string, params: unknown[]): Promise<string> {
  const rows = await service<{ status: string }>(db, `SELECT ${sql} AS status`, params);
  return rows[0]?.status as string;
}

async function functionAcls(db: PGlite): Promise<Record<string, { anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] | null }>> {
  const out: Record<string, { anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] | null }> = {};
  for (const signature of NEW_FUNCTIONS) {
    const row = (
      await db.query<{ anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] | null }>(
        `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service, p.prosecdef AS definer, p.proconfig AS config
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [`public.${signature}`],
      )
    ).rows[0];
    assert.ok(row, `${signature} exists`);
    out[signature] = row;
  }
  return out;
}

for (const mode of MODES) {
  describe(`security alerts and uploader holds (${mode})`, () => {
    let db: PGlite;
    let tenantA: string;
    let tenantB: string;
    let uploaderU: string;
    let uploaderV: string;
    let actor: string;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseFunctionDefaults: true })).db;
      uploaderU = await createUser(db);
      uploaderV = await createUser(db);
      actor = await createUser(db);
      tenantA = mode === 'single-tenant' ? 's:default' : `o:${crypto.randomUUID()}`;
      tenantB = `o:${crypto.randomUUID()}`;
    });

    after(async () => {
      await db.close();
    });

    test('crossing the threshold creates one open alert per uploader and window', async () => {
      const first = await recordEvents(db, tenantA, events(3, uploaderU), 2);
      assert.equal(first.event_ids.length, 3);
      assert.equal(first.alert_ids.length, 1);
      let alerts = (await alertsOf(db, [tenantA])).filter((alert) => alert.uploader_id === uploaderU);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]?.event_count, 3);
      assert.equal(alerts[0]?.status, 'open');
      assert.equal(alerts[0]?.held, false);

      const second = await recordEvents(db, tenantA, events(2, uploaderU), 2);
      assert.equal(second.event_ids.length, 2);
      assert.deepEqual(second.alert_ids, []);
      alerts = (await alertsOf(db, [tenantA])).filter((alert) => alert.uploader_id === uploaderU);
      assert.equal(alerts.length, 1);
      assert.equal(await holdActive(db, tenantA, uploaderU), false);
    });

    test('threshold 0 stores the events and never alerts', async () => {
      const result = await recordEvents(db, tenantA, events(10, uploaderV), 0);
      assert.equal(result.event_ids.length, 10);
      assert.deepEqual(result.alert_ids, []);
      assert.equal((await alertsOf(db, [tenantA])).some((alert) => alert.uploader_id === uploaderV), false);
    });

    test('a count equal to the threshold does not alert; events outside the window are not counted', async () => {
      const user = await createUser(db);
      await service(db, "INSERT INTO public.rag_security_events (tenant_key, source, action, detector, uploader_id, created_at) SELECT $1, 'output_guard', 'removed', 'rules', $2, now() - interval '72 hours' FROM generate_series(1, 5)", [
        tenantA,
        user,
      ]);
      assert.deepEqual((await recordEvents(db, tenantA, events(2, user), 2)).alert_ids, []);
      assert.equal((await recordEvents(db, tenantA, events(1, user), 2)).alert_ids.length, 1);
    });

    test('an event without uploader is stored, never counted, never alerts or holds', async () => {
      const before = (await alertsOf(db, [tenantA])).length;
      const result = await recordEvents(db, tenantA, events(5, null), 1, true);
      assert.equal(result.event_ids.length, 5);
      assert.deepEqual(result.alert_ids, []);
      assert.equal((await alertsOf(db, [tenantA])).length, before);
      const uploaders = await service<{ uploader_id: string | null }>(db, 'SELECT uploader_id FROM public.rag_list_security_uploaders($1::text[], 24)', [[tenantA]]);
      assert.equal(uploaders.some((row) => row.uploader_id === null), false);
      const stored = await service<{ n: number }>(db, 'SELECT count(*)::int AS n FROM public.rag_security_events WHERE tenant_key = $1 AND uploader_id IS NULL', [tenantA]);
      assert.equal(stored[0]?.n, 5);
    });

    test('with auto hold the alert creates an active hold; releasing it does not approve held documents', async () => {
      const user = await createUser(db);
      const result = await recordEvents(db, tenantA, events(2, user), 1, true);
      assert.equal(result.alert_ids.length, 1);
      const alert = (await alertsOf(db, [tenantA])).find((row) => row.id === result.alert_ids[0]);
      assert.equal(alert?.held, true);
      assert.equal(await holdActive(db, tenantA, user), true);
      const active = await service<{ id: string }>(db, 'SELECT public.rag_active_uploader_holds($1, $2::uuid[]) AS id', [tenantA, [user, uploaderV]]);
      assert.deepEqual(
        active.map((row) => row.id),
        [user],
      );

      const doc = await createDocument(db, user);
      const statusBefore = (await db.query<{ status: string }>('SELECT status FROM documents WHERE id = $1', [doc.id])).rows[0]?.status;
      assert.equal(await word(db, 'public.rag_release_uploader_hold($1, $2, $3)', [tenantA, user, actor]), 'ok');
      assert.equal(await holdActive(db, tenantA, user), false);
      const released = await service<{ released_at: string | null; released_by: string | null }>(
        db,
        'SELECT released_at, released_by FROM public.rag_uploader_holds WHERE tenant_key = $1 AND user_id = $2',
        [tenantA, user],
      );
      assert.equal(released.length, 1);
      assert.notEqual(released[0]?.released_at, null);
      assert.equal(released[0]?.released_by, actor);
      assert.equal((await db.query<{ status: string }>('SELECT status FROM documents WHERE id = $1', [doc.id])).rows[0]?.status, statusBefore);
      assert.equal(await word(db, 'public.rag_release_uploader_hold($1, $2, $3)', [tenantA, user, actor]), 'not_held');
    });

    test('manual hold, release and acknowledge return their status words', async () => {
      const user = await createUser(db);
      assert.equal(await word(db, 'public.rag_hold_uploader($1, $2, $3, $4)', [tenantA, user, actor, 'manual review']), 'ok');
      assert.equal(await word(db, 'public.rag_hold_uploader($1, $2, $3, $4)', [tenantA, user, actor, 'again']), 'already_held');
      const holds = await service<{ n: number }>(db, 'SELECT count(*)::int AS n FROM public.rag_uploader_holds WHERE tenant_key = $1 AND user_id = $2 AND released_at IS NULL', [
        tenantA,
        user,
      ]);
      assert.equal(holds[0]?.n, 1);
      await rejectsWith(() => word(db, 'public.rag_hold_uploader($1, $2, $3, $4)', [tenantA, user, actor, 'r'.repeat(201)]), '22023');
      await rejectsWith(() => word(db, 'public.rag_hold_uploader($1, $2, $3, $4)', [tenantA, null, actor, 'x']), '22023');

      const result = await recordEvents(db, tenantA, events(2, user), 1);
      const alertId = result.alert_ids[0] as string;
      assert.equal((await alertsOf(db, [tenantA])).find((row) => row.id === alertId)?.held, true, 'an alert for a held uploader reads held');
      assert.equal(await word(db, 'public.rag_acknowledge_security_alert($1, $2, $3)', [tenantA, alertId, actor]), 'ok');
      assert.equal(await word(db, 'public.rag_acknowledge_security_alert($1, $2, $3)', [tenantA, alertId, actor]), 'already_acknowledged');
      assert.equal(await word(db, 'public.rag_acknowledge_security_alert($1, $2, $3)', [tenantA, crypto.randomUUID(), actor]), 'not_found');
      const acknowledged = (await alertsOf(db, [tenantA])).find((row) => row.id === alertId);
      assert.equal(acknowledged?.status, 'acknowledged');
    });

    test('a conflicting alert row in the same window yields no second alert and no error', async () => {
      const user = await createUser(db);
      await service(
        db,
        `INSERT INTO public.rag_security_alerts (tenant_key, uploader_id, event_count, window_start, window_end)
         VALUES ($1, $2, 1, date_trunc('hour', now()) + interval '1 hour' - interval '24 hours', date_trunc('hour', now()) + interval '1 hour')`,
        [tenantA, user],
      );
      const [left, right] = await Promise.all([recordEvents(db, tenantA, events(3, user), 1), recordEvents(db, tenantA, events(3, user), 1)]);
      assert.deepEqual([...left.alert_ids, ...right.alert_ids], []);
      const count = await service<{ n: number }>(db, 'SELECT count(*)::int AS n FROM public.rag_security_alerts WHERE tenant_key = $1 AND uploader_id = $2', [tenantA, user]);
      assert.equal(count[0]?.n, 1);
      const unique = await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = 'rag_security_alerts' AND indexdef LIKE 'CREATE UNIQUE%'");
      assert.ok(unique.rows.some((row) => /\(tenant_key, uploader_id, window_start\)/.test(row.indexdef)));
    });

    test('two calls that both cross the threshold produce exactly one alert', async () => {
      const user = await createUser(db);
      const [left, right] = await Promise.all([recordEvents(db, tenantA, events(2, user), 1), recordEvents(db, tenantA, events(2, user), 1)]);
      assert.equal(left.alert_ids.length + right.alert_ids.length, 1);
    });

    test('the uploader of a tenant document is taken from the document; another tenant document is refused', async () => {
      const owner = await createUser(db);
      const doc = await createDocument(db, owner);
      const result = await recordEvents(db, doc.tenantKey, [{ source: 'output_guard', action: 'removed', detector: 'rules', document_id: doc.id, uploader_id: uploaderV }], 0);
      const stored = await service<{ uploader_id: string }>(db, 'SELECT uploader_id FROM public.rag_security_events WHERE id = $1', [result.event_ids[0]]);
      assert.equal(stored[0]?.uploader_id, owner);
      const foreignKey = mode === 'single-tenant' ? null : tenantB;
      if (foreignKey) {
        await rejectsWith(() => recordEvents(db, foreignKey, [{ source: 'output_guard', action: 'removed', detector: 'rules', document_id: doc.id }], 0), '22023');
      }
    });

    test('tenant isolation: tenant A calls never read, count, acknowledge or hold tenant B rows', async () => {
      const userB = await createUser(db);
      if (mode === 'multi-tenant') {
        const resultB = await recordEvents(db, tenantB, events(3, userB), 1, true);
        assert.equal(resultB.alert_ids.length, 1);
        const alertB = resultB.alert_ids[0] as string;
        const listedA = await service<{ tenant_key: string; uploader_id: string | null }>(
          db,
          'SELECT tenant_key, uploader_id FROM public.rag_list_security_events($1::text[], NULL, NULL, NULL, 500, 0)',
          [[tenantA]],
        );
        assert.equal(listedA.length > 0, true);
        assert.equal(listedA.every((row) => row.tenant_key === tenantA), true);
        assert.equal(listedA.some((row) => row.uploader_id === userB), false);
        assert.equal((await alertsOf(db, [tenantA])).some((row) => row.id === alertB || row.tenant_key === tenantB), false);
        const uploadersA = await service<{ uploader_id: string; tenant_key: string }>(db, 'SELECT tenant_key, uploader_id FROM public.rag_list_security_uploaders($1::text[], 24)', [[tenantA]]);
        assert.equal(uploadersA.some((row) => row.uploader_id === userB || row.tenant_key === tenantB), false);
        assert.equal(await word(db, 'public.rag_acknowledge_security_alert($1, $2, $3)', [tenantA, alertB, actor]), 'not_found');
        assert.equal((await alertsOf(db, [tenantB])).find((row) => row.id === alertB)?.status, 'open');
        assert.equal(await holdActive(db, tenantA, userB), false);
        assert.equal(await holdActive(db, tenantB, userB), true);
        assert.deepEqual(await service(db, 'SELECT public.rag_active_uploader_holds($1, $2::uuid[]) AS id', [tenantA, [userB]]), []);
        assert.equal(await word(db, 'public.rag_release_uploader_hold($1, $2, $3)', [tenantA, userB, actor]), 'not_held');
        assert.equal(await holdActive(db, tenantB, userB), true);
        const countedA = await recordEvents(db, tenantA, events(1, userB), 2);
        assert.deepEqual(countedA.alert_ids, [], 'tenant B events do not count toward tenant A');
        const both = await alertsOf(db, [tenantA, tenantB]);
        assert.equal(both.some((row) => row.tenant_key === tenantB), true);
      } else {
        await service(db, "INSERT INTO public.rag_security_events (tenant_key, source, action, detector, uploader_id) VALUES ($1, 'output_guard', 'removed', 'rules', $2)", [
          `u:${userB}`,
          userB,
        ]);
        const listed = await service<{ tenant_key: string }>(db, 'SELECT tenant_key FROM public.rag_list_security_events($1::text[], NULL, NULL, NULL, 500, 0)', [[tenantA]]);
        assert.equal(listed.every((row) => row.tenant_key === 's:default'), true);
        await rejectsWith(() => recordEvents(db, `u:${userB}`, events(1, userB), 0), '22023');
        await rejectsWith(() => alertsOf(db, [tenantA, `u:${userB}`]), '22023');
      }
    });

    test('list functions assert every key and validate their arguments', async () => {
      await rejectsWith(() => alertsOf(db, [tenantA, 'bogus']), '22023');
      await rejectsWith(() => service(db, 'SELECT * FROM public.rag_list_security_alerts(NULL)'), '22023');
      await rejectsWith(() => service(db, 'SELECT * FROM public.rag_list_security_uploaders($1::text[], 0)', [[tenantA]]), '22023');
      await rejectsWith(() => service(db, "SELECT * FROM public.rag_list_security_events($1::text[], 'other', NULL, NULL, 10, 0)", [[tenantA]]), '22023');
      const limited = await service(db, 'SELECT * FROM public.rag_list_security_events($1::text[], NULL, NULL, NULL, 2, 0)', [[tenantA]]);
      assert.equal(limited.length, 2);
      const filtered = await service<{ uploader_id: string; source: string }>(
        db,
        "SELECT uploader_id, source FROM public.rag_list_security_events($1::text[], 'ingest_injection', $2, now() - interval '1 hour', 500, 0)",
        [[tenantA], uploaderU],
      );
      assert.equal(filtered.length, 5);
      assert.equal(filtered.every((row) => row.uploader_id === uploaderU && row.source === 'ingest_injection'), true);
      await rejectsWith(() => recordEvents(db, tenantA, events(1, uploaderU), -1), '22023');
      await rejectsWith(() => recordEvents(db, tenantA, events(1, uploaderU), 1, false, 0), '22023');
    });

    test('every new function is SECURITY INVOKER with an empty search_path and callable by service_role only', async () => {
      const acls = await functionAcls(db);
      for (const [signature, acl] of Object.entries(acls)) {
        assert.deepEqual(acl, { anon: false, authenticated: false, service: true, definer: false, config: ['search_path=""'] }, signature);
        assert.equal(AUTHENTICATED_ALLOW_LIST[normalizeSignature(signature)], undefined, `${signature} is not allow-listed`);
      }
      for (const role of ['anon', 'authenticated'] as const) {
        await rejectsWith(() => asRole(db, role, () => db.query('SELECT public.rag_uploader_hold_active($1, $2)', [tenantA, uploaderU])), '42501');
        await rejectsWith(() => asRole(db, role, () => db.query("SELECT public.rag_record_security_events($1, '[]'::jsonb, 0, 24, false)", [tenantA])), '42501');
        await rejectsWith(() => asRole(db, role, () => db.query('SELECT public.rag_hold_uploader($1, $2, $3, $4)', [tenantA, uploaderU, actor, 'x'])), '42501');
        await rejectsWith(() => asRole(db, role, () => db.query('SELECT * FROM public.rag_list_security_alerts($1::text[])', [[tenantA]])), '42501');
      }
      await assertNoClientCallableRagFunctions(db);
    });

    test('re-running 0410 and the security migrations keeps the lock and changes nothing', async () => {
      const once = await functionAcls(db);
      const rows = await service<{ n: number }>(db, 'SELECT count(*)::int AS n FROM public.rag_security_alerts');
      await db.query('GRANT EXECUTE ON FUNCTION public.rag_uploader_hold_active(text, uuid) TO authenticated');
      for (const file of [...SECURITY_MIGRATIONS, GRANTS_MIGRATION]) await db.exec(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      assert.deepEqual(await functionAcls(db), once);
      assert.deepEqual(await service<{ n: number }>(db, 'SELECT count(*)::int AS n FROM public.rag_security_alerts'), rows);
    });

    test('0410 has a lock block for every new function', () => {
      const sql = fs.readFileSync(path.join(REPO_ROOT, GRANTS_MIGRATION), 'utf8');
      for (const signature of NEW_FUNCTIONS) {
        const key = signature.replace('timestamp with time zone', 'timestamptz');
        assert.ok(sql.includes(`to_regprocedure('public.${key}')`), `0410 guards ${key}`);
        assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${key} FROM PUBLIC, anon, authenticated;`), `0410 revokes ${key}`);
        assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${key} TO service_role;`), `0410 grants ${key}`);
      }
    });
  });
}
