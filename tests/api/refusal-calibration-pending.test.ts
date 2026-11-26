import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface State {
  denied: boolean;
  admin: boolean;
  throwOn: string | null;
  errorOn: string | null;
  tables: Record<string, Row[]>;
  calls: Array<{ table: string; ops: string[] }>;
}

let state: State;

vi.mock('@/lib/admin-route-auth', () => ({
  requireAdminOrDeny: vi.fn(async () =>
    state.denied ? NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) : null,
  ),
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => {
    if (!state.admin) return null;
    return {
      from(table: string) {
        const call = { table, ops: [] as string[] };
        state.calls.push(call);
        if (state.throwOn === table) throw new Error('boom');
        const builder: Record<string, unknown> = {};
        for (const op of ['select', 'gte', 'overlaps', 'order', 'limit', 'eq', 'in']) {
          builder[op] = (...args: unknown[]) => {
            call.ops.push(`${op}:${JSON.stringify(args)}`);
            return builder;
          };
        }
        builder.then = (resolve: (value: unknown) => unknown) =>
          resolve(
            state.errorOn === table
              ? { data: null, error: { code: '42P01', message: 'relation does not exist' } }
              : { data: state.tables[table] ?? [], error: null },
          );
        return builder;
      },
    };
  },
}));

const CHANGE_TODAY = { created_at: new Date().toISOString(), changed_keys: ['RAG_RERANKER'] };
const ALERT_ZH = { id: '33333333-3333-4333-8333-333333333333', language: 'zh', day: '2026-11-26' };

async function get(): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await import('@/app/api/rag/admin/refusal-calibration/route');
  const response = await GET(new Request('http://localhost/api/rag/admin/refusal-calibration'));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function baseline(): Promise<Record<string, unknown>> {
  const { currentRefusalCalibrationStatus } = await import('@/lib/rag');
  return JSON.parse(JSON.stringify({ success: true, ...currentRefusalCalibrationStatus() })) as Record<string, unknown>;
}

const cells = (body: Record<string, unknown>) => body.cells as Array<{ key: string; status: string; pending?: unknown }>;
const warning = (body: Record<string, unknown>, code: string) =>
  (body.warnings as Array<{ code: string } & Record<string, unknown>>).find((entry) => entry.code === code);

beforeEach(() => {
  state = { denied: false, admin: true, throwOn: null, errorOn: null, tables: {}, calls: [] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/rag/admin/refusal-calibration pending marks', () => {
  it('refuses a non-admin before reading any table', async () => {
    state.denied = true;
    const { status } = await get();
    expect(status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it('adds per-cell pending and the uncalibrated_after_change warning from a reranker change record', async () => {
    state.tables.rag_config_change_records = [CHANGE_TODAY];
    const { status, body } = await get();
    expect(status).toBe(200);
    const calibrated = cells(body).filter((entry) => entry.status === 'calibrated');
    expect(calibrated.length).toBeGreaterThan(0);
    for (const entry of calibrated) expect(entry.pending).toMatchObject({ reason: 'reranker_model', changed_keys: ['RAG_RERANKER'] });
    for (const entry of cells(body).filter((cell) => cell.status !== 'calibrated')) expect(entry.pending).toBeNull();
    expect(warning(body, 'uncalibrated_after_change')).toMatchObject({
      keys: calibrated.map((entry) => entry.key),
      changed_keys: ['RAG_RERANKER'],
    });
    expect(warning(body, 'possibly_stale_scores')).toBeUndefined();
  });

  it('marks the cells of an open top_score_psi alert as possibly stale', async () => {
    state.tables.rag_monitor_alerts = [ALERT_ZH];
    const { body } = await get();
    const zh = cells(body).filter((entry) => entry.status === 'calibrated' && entry.key.includes('|zh|'));
    expect(zh.length).toBeGreaterThan(0);
    for (const entry of zh) expect(entry.pending).toEqual({ reason: 'score_shift', since: '2026-11-26', alert_id: ALERT_ZH.id });
    expect(warning(body, 'possibly_stale_scores')).toMatchObject({ keys: zh.map((entry) => entry.key), alert_id: ALERT_ZH.id });
    expect(warning(body, 'uncalibrated_after_change')).toBeUndefined();
  });

  it('reads only pending-category change records and open or acknowledged top_score_psi alerts', async () => {
    await get();
    const changes = state.calls.find((call) => call.table === 'rag_config_change_records');
    const alerts = state.calls.find((call) => call.table === 'rag_monitor_alerts');
    expect(changes?.ops.some((op) => op.startsWith('overlaps:') && op.includes('RAG_RERANKER') && op.includes('OPENAI_EMBEDDING_MODEL'))).toBe(true);
    expect(changes?.ops.some((op) => op.startsWith('gte:'))).toBe(true);
    expect(alerts?.ops).toEqual(expect.arrayContaining(['eq:["rule","top_score_psi"]', 'in:["status",["open","acknowledged"]]']));
  });

  it('answers exactly as before when the change-record table is missing', async () => {
    state.errorOn = 'rag_config_change_records';
    state.tables.rag_monitor_alerts = [ALERT_ZH];
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual(await baseline());
    expect(cells(body).every((entry) => !('pending' in entry))).toBe(true);
  });

  it('answers exactly as before when a read throws or no admin client exists', async () => {
    state.throwOn = 'rag_monitor_alerts';
    const thrown = await get();
    expect(thrown.status).toBe(200);
    expect(thrown.body).toEqual(await baseline());

    state = { ...state, throwOn: null, admin: false };
    const noClient = await get();
    expect(noClient.status).toBe(200);
    expect(noClient.body).toEqual(await baseline());
  });

  it('answers exactly as before when a row has an unexpected shape', async () => {
    state.tables.rag_config_change_records = [{ created_at: 7, changed_keys: 'RAG_RERANKER' }];
    const { body } = await get();
    expect(body).toEqual(await baseline());
  });
});
