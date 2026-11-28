import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const TABLES = ['rag_security_events', 'rag_security_alerts', 'rag_uploader_holds'];
const EVENT_COLUMNS = [
  'action',
  'chunk_id',
  'created_at',
  'detector',
  'document_id',
  'id',
  'rule_ids',
  'source',
  'tenant_key',
  'trace_id',
  'uploader_id',
];

type Role = 'anon' | 'authenticated' | 'service_role';

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsWith(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => sqlState(error) === code);
}

async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  }
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

function tenantKeyFor(mode: DeploymentMode, userId: string): string {
  return mode === 'single-tenant' ? 's:default' : `u:${userId}`;
}

async function record(db: PGlite, tenantKey: string, events: unknown[]): Promise<{ event_ids: string[]; alert_ids: string[] }> {
  return asRole(db, 'service_role', null, async () => {
    const row = (
      await db.query<{ result: { event_ids: string[]; alert_ids: string[] } }>(
        'SELECT public.rag_record_security_events($1, $2::jsonb, 0, 24, false) AS result',
        [tenantKey, JSON.stringify(events)],
      )
    ).rows[0];
    assert.ok(row);
    return row.result;
  });
}

for (const mode of MODES) {
  describe(`rag_security_events (${mode})`, () => {
    let db: PGlite;
    let uploader: string;
    let tenantKey: string;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseFunctionDefaults: true })).db;
      uploader = await createUser(db);
      tenantKey = tenantKeyFor(mode, uploader);
    });

    after(async () => {
      await db.close();
    });

    test('the table has the D-43 columns and no text column', async () => {
      const columns = (
        await db.query<{ column_name: string; data_type: string }>(
          "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_security_events' ORDER BY column_name",
        )
      ).rows;
      assert.deepEqual(
        columns.map((column) => column.column_name),
        EVENT_COLUMNS,
      );
      for (const forbidden of ['text', 'content', 'query', 'answer', 'excerpt', 'snippet']) {
        assert.equal(columns.some((column) => column.column_name.includes(forbidden)), false, `no ${forbidden} column`);
      }
    });

    test('RLS is on with no policy on all three tables', async () => {
      for (const table of TABLES) {
        const rls = (await db.query<{ relrowsecurity: boolean }>('SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass', [`public.${table}`])).rows[0];
        assert.equal(rls?.relrowsecurity, true, `${table} has RLS on`);
        const policies = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_policies WHERE tablename = $1', [table])).rows[0];
        assert.equal(policies?.n, 0, `${table} has no policy`);
      }
    });

    test('anon and authenticated cannot select, insert, update or delete any of the three tables', async () => {
      await record(db, tenantKey, [{ source: 'ingest_injection', action: 'detected', detector: 'rules', rule_ids: ['r1'], uploader_id: uploader }]);
      for (const role of ['anon', 'authenticated'] as const) {
        for (const table of TABLES) {
          await rejectsWith(() => asRole(db, role, uploader, () => db.query(`SELECT * FROM public.${table}`)), '42501');
          await rejectsWith(() => asRole(db, role, uploader, () => db.query(`DELETE FROM public.${table}`)), '42501');
          await rejectsWith(() => asRole(db, role, uploader, () => db.query(`UPDATE public.${table} SET tenant_key = tenant_key`)), '42501');
        }
        await rejectsWith(
          () =>
            asRole(db, role, uploader, () =>
              db.query("INSERT INTO public.rag_security_events (tenant_key, source, action, detector) VALUES ($1, 'output_guard', 'removed', 'rules')", [tenantKey]),
            ),
          '42501',
        );
      }
    });

    test('source and action are checked; every source and action of D-43 is accepted', async () => {
      const sources = ['ingest_injection', 'retrieval_injection', 'output_guard', 'hidden_text', 'untrusted_link'];
      const actions = ['detected', 'quarantined', 'dropped', 'downweighted', 'removed', 'blocked', 'warned'];
      const result = await record(
        db,
        tenantKey,
        sources.flatMap((source) => actions.map((action) => ({ source, action, detector: 'rules' }))),
      );
      assert.equal(result.event_ids.length, sources.length * actions.length);
      await rejectsWith(() => record(db, tenantKey, [{ source: 'other', action: 'detected', detector: 'rules' }]), '23514');
      await rejectsWith(() => record(db, tenantKey, [{ source: 'output_guard', action: 'erased', detector: 'rules' }]), '23514');
    });

    test('an event row stores ids only and the identifiers are shape-checked', async () => {
      const documentId = crypto.randomUUID();
      const chunkId = crypto.randomUUID();
      const result = await record(db, tenantKey, [
        {
          source: 'retrieval_injection',
          action: 'dropped',
          detector: 'rules',
          rule_ids: ['inj.override', 'inj.role'],
          document_id: documentId,
          chunk_id: chunkId,
          uploader_id: uploader,
          trace_id: 'trace-0001',
        },
      ]);
      const row = (
        await db.query<Record<string, unknown>>('SELECT tenant_key, source, action, detector, rule_ids, document_id, chunk_id, uploader_id, trace_id FROM rag_security_events WHERE id = $1', [
          result.event_ids[0],
        ])
      ).rows[0];
      assert.deepEqual(row, {
        tenant_key: tenantKey,
        source: 'retrieval_injection',
        action: 'dropped',
        detector: 'rules',
        rule_ids: ['inj.override', 'inj.role'],
        document_id: documentId,
        chunk_id: chunkId,
        uploader_id: uploader,
        trace_id: 'trace-0001',
      });
      await rejectsWith(() => record(db, tenantKey, [{ source: 'output_guard', action: 'removed', detector: 'free text with spaces' }]), '22023');
      await rejectsWith(() => record(db, tenantKey, [{ source: 'output_guard', action: 'removed', detector: 'rules', rule_ids: ['a rule; with text'] }]), '22023');
      await rejectsWith(() => record(db, tenantKey, [{ source: 'output_guard', action: 'removed', detector: 'rules', trace_id: 'x'.repeat(201) }]), '22023');
      await rejectsWith(() => record(db, tenantKey, ['not an object']), '22023');
      await rejectsWith(() => asRole(db, 'service_role', null, () => db.query("SELECT public.rag_record_security_events($1, '{}'::jsonb, 0, 24, false)", [tenantKey])), '22023');
    });

    test('a direct insert with a malformed tenant key is rejected', async () => {
      await rejectsWith(
        () =>
          asRole(db, 'service_role', null, () =>
            db.query("INSERT INTO public.rag_security_events (tenant_key, source, action, detector) VALUES ('tenant', 'output_guard', 'removed', 'rules')"),
          ),
        '23514',
      );
    });
  });
}

describe('0942 and 0943 stay out of the setup files', () => {
  test('neither setup file defines the security tables or functions', () => {
    for (const file of ['supabase/single-tenant-setup.sql', 'supabase/multi-tenant-setup.sql']) {
      const sql = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      for (const marker of [...TABLES, 'rag_record_security_events', 'rag_hold_uploader', 'rag_list_security_events']) {
        assert.equal(sql.includes(marker), false, `${file} must not fold ${marker}`);
      }
    }
  });
});
