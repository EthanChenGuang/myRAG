import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// 1013 (Phase 6.3 G2): the OBS-03 store accepts the source-sync and stale-index rules, the retrieval log keeps the source recheck
// counts, and rag_monitor_stale_index_drop sums them per tenant and UTC day. Service role only.

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
type Role = 'anon' | 'authenticated' | 'service_role';

const sqlState = (error: unknown): string => (typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '');

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

function alert(tenantKey: string, rule: string, kind: string): Record<string, unknown> {
  return {
    tenant_key: tenantKey,
    rule,
    kind,
    language: 'all',
    day: '2026-11-27',
    window_days: 1,
    severity: 'alert',
    observed_count: 6,
    observed_total: 10,
    dedup_key: crypto.randomBytes(32).toString('hex'),
  };
}

for (const mode of MODES) {
  describe(`OBS-03 source-sync and stale-index rules (${mode})`, () => {
    let db: PGlite;
    let tenantKey: string;
    let userId: string | null = null;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (mode === 'multi-tenant') {
        userId = crypto.randomUUID();
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [userId, `synthetic-${userId.slice(0, 8)}@example.invalid`]);
        tenantKey = `u:${userId}`;
      } else {
        tenantKey = 's:default';
      }
    });

    after(async () => {
      await db?.close();
    });

    async function log(createdAt: string, rechecked: number | null, dropped: number | null): Promise<void> {
      await db.query(
        `INSERT INTO public.rag_retrieval_log (trace_id, user_id, channel, pipeline, status, source_rechecked, stale_index_drop, created_at)
         VALUES ($1, $2, 'chat', 'v2', 'ok', $3, $4, $5::timestamptz)`,
        [`trace-${crypto.randomUUID()}`, userId, rechecked, dropped, createdAt],
      );
    }

    test('rag_monitor_alert_upsert stores the four source_sync rules and stale_index_drop_rate; other codes stay refused', async () => {
      for (const rule of ['source_reconcile_paused', 'source_reconcile_overdue', 'source_reconcile_failed', 'source_reconcile_incomplete']) {
        const stored = await db.query<{ id: string | null }>('SELECT public.rag_monitor_alert_upsert($1::jsonb) AS id', [JSON.stringify(alert(tenantKey, rule, 'source_sync'))]);
        assert.ok(stored.rows[0]?.id, rule);
      }
      const stale = await db.query<{ id: string | null }>('SELECT public.rag_monitor_alert_upsert($1::jsonb) AS id', [
        JSON.stringify(alert(tenantKey, 'stale_index_drop_rate', 'stale_index_drop')),
      ]);
      assert.ok(stale.rows[0]?.id);
      await rejectsWith('23514', () => db.query('SELECT public.rag_monitor_alert_upsert($1::jsonb)', [JSON.stringify(alert(tenantKey, 'source_reconcile_other', 'source_sync'))]));
      await rejectsWith('23514', () => db.query('SELECT public.rag_monitor_alert_upsert($1::jsonb)', [JSON.stringify(alert(tenantKey, 'refusal_rate', 'source_other'))]));
    });

    test('the retrieval log keeps the recheck counts only as a consistent pair', async () => {
      await log('2026-11-27T05:00:00Z', null, null);
      await rejectsWith('23514', () => log('2026-11-27T05:00:00Z', 2, 3));
      await rejectsWith('23514', () => log('2026-11-27T05:00:00Z', 2, null));
    });

    test('rag_monitor_stale_index_drop sums one UTC day per tenant and skips rows without a recheck', async () => {
      await log('2026-11-26T00:00:00Z', 10, 1);
      await log('2026-11-26T23:59:59Z', 30, 2);
      await log('2026-11-26T12:00:00Z', null, null);
      await log('2026-11-25T23:59:59Z', 99, 9);
      await log('2026-11-27T00:00:00Z', 50, 5);
      const result = await db.query<{ tenant_key: string; retrievals: string; checked: string; dropped: string }>(
        "SELECT * FROM public.rag_monitor_stale_index_drop('2026-11-26'::date)",
      );
      assert.deepEqual(
        result.rows.map((row) => [row.tenant_key, Number(row.retrievals), Number(row.checked), Number(row.dropped)]),
        [[tenantKey, 2, 40, 3]],
      );
    });

    test('anon and authenticated get 42501 on rag_monitor_stale_index_drop', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        await rejectsWith('42501', () => asRole(db, role, () => db.query("SELECT * FROM public.rag_monitor_stale_index_drop('2026-11-26'::date)")));
      }
      const allowed = await asRole(db, 'service_role', () => db.query("SELECT count(*) AS n FROM public.rag_monitor_stale_index_drop('2026-11-26'::date)"));
      assert.equal(allowed.rows.length, 1);
    });

    test('1013 applies a second time without error', async () => {
      const fs = await import('node:fs');
      const sql = fs.readFileSync(new URL('../../supabase/migrations/1013_source_monitor_alerts.sql', import.meta.url), 'utf8');
      await db.exec(sql);
      const again = await db.query<{ id: string | null }>('SELECT public.rag_monitor_alert_upsert($1::jsonb) AS id', [
        JSON.stringify(alert(tenantKey, 'source_reconcile_paused', 'source_sync')),
      ]);
      assert.ok(again.rows[0]?.id);
    });
  });
}
