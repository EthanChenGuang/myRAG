import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNangoMemoryAdmin, type Row } from '../helpers/nango-memory-admin';

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => null }));

import { raiseSourceAlert } from '@/lib/nango/source-alerts';

// G2 of the 6.3 verification (D-10): with RAG_MONITOR on, a source alert is also an OBS-03 alert in rag_monitor_alerts through
// upsertAlerts; with it off the adapter does exactly what it did before (one connection-row update, no rpc).

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const CONNECTION_ID = '00000000-0000-4000-8000-00000000d001';
const TENANT = `u:${OWNER}`;
const NOW = new Date('2026-11-28T10:00:00.000Z');

function memory(rpc?: (name: string, args: Row) => { data: unknown; error: { code: string; message: string } | null }) {
  return createNangoMemoryAdmin(
    { nango_connections: [{ id: CONNECTION_ID, user_id: OWNER, connection_id: 'conn-unit', provider: 'google-drive' }], rag_monitor_alerts: [] },
    {
      rpc:
        rpc ??
        ((name) => {
          if (name === 'rag_nango_owner_tenant_key') return { data: TENANT, error: null };
          if (name === 'rag_monitor_alert_upsert') return { data: '00000000-0000-4000-8000-0000000000f1', error: null };
          return { data: null, error: null };
        }),
    },
  );
}

describe('raiseSourceAlert and the OBS-03 store', () => {
  it('RAG_MONITOR off: one connection-row update, no rpc, no alert row (unchanged)', async () => {
    const m = memory();
    const stored = await raiseSourceAlert({ id: CONNECTION_ID }, 'paused', { candidates: 6, total: 10 }, { admin: m.admin as never, env: { RAG_MONITOR: 'false' }, now: NOW });
    expect(stored).toBe('connection_status');
    expect(m.rpcs).toEqual([]);
    expect(m.ops).toEqual([
      { table: 'nango_connections', operation: 'update', filters: [{ kind: 'eq', column: 'id', value: CONNECTION_ID }], values: { last_reconcile_status: 'paused' } },
    ]);
  });

  it('RAG_MONITOR on: keeps the connection-row update and upserts one source_sync alert for the owner tenant', async () => {
    const m = memory();
    const stored = await raiseSourceAlert({ id: CONNECTION_ID }, 'paused', { candidates: 6, total: 10 }, { admin: m.admin as never, env: { RAG_MONITOR: 'true' }, now: NOW });
    expect(stored).toBe('monitor_alert');
    expect(m.tables.nango_connections?.[0]?.last_reconcile_status).toBe('paused');
    expect(m.rpcs.map((call) => call.name)).toEqual(['rag_nango_owner_tenant_key', 'rag_monitor_alert_upsert']);
    expect(m.rpcs[0]?.args).toEqual({ p_user_id: OWNER });
    const payload = m.rpcs[1]?.args.p_alert as Record<string, unknown>;
    expect(payload).toMatchObject({
      tenant_key: TENANT,
      rule: 'source_reconcile_paused',
      kind: 'source_sync',
      language: 'all',
      day: '2026-11-28',
      window_days: 1,
      severity: 'alert',
      observed_count: 6,
      observed_total: 10,
      dedup_key: createHash('sha256').update(`${TENANT}|all|source_reconcile_paused|${CONNECTION_ID}`, 'utf8').digest('hex'),
      delivered: {},
    });
    expect(JSON.stringify(payload)).not.toMatch(new RegExp(`conn-unit|google-drive|${CONNECTION_ID}`));
  });

  it('queues the webhook when RAG_MONITOR_WEBHOOK_URL is set, and maps overdue to a warning', async () => {
    const m = memory();
    await raiseSourceAlert(
      { id: CONNECTION_ID },
      'overdue',
      { days: 9, limit: 7 },
      { admin: m.admin as never, env: { RAG_MONITOR: 'true', RAG_MONITOR_WEBHOOK_URL: 'https://hooks.example.invalid/monitor' }, now: NOW },
    );
    const payload = m.rpcs.find((call) => call.name === 'rag_monitor_alert_upsert')?.args.p_alert as Record<string, unknown>;
    expect(payload).toMatchObject({ rule: 'source_reconcile_overdue', severity: 'warning', observed_count: 9, observed_total: 7 });
    expect(payload.delivered).toEqual({ webhook: { state: 'pending', attempts: 0, last_attempt_at: null } });
  });

  it('a failing alert write never throws and leaves the connection-row state', async () => {
    const m = memory((name) =>
      name === 'rag_nango_owner_tenant_key' ? { data: TENANT, error: null } : { data: null, error: { code: '23514', message: 'check' } },
    );
    const stored = await raiseSourceAlert({ id: CONNECTION_ID }, 'failed', {}, { admin: m.admin as never, env: { RAG_MONITOR: 'true' }, now: NOW });
    expect(stored).toBe('connection_status');
    expect(m.tables.nango_connections?.[0]?.last_reconcile_status).toBe('failed');
  });
});
