import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteClient } from '../helpers/pglite-rest-client';
import {
  CHUNK_A,
  CHUNK_A_SUPERSEDED,
  CHUNK_A_ZH,
  CHUNK_B,
  DOC_A,
  DOC_B,
  EXPERT_A,
  EXPERT_B,
  OWNER_A,
  OWNER_B,
  TENANT_A,
  TENANT_B,
  TEXT_A,
  TEXT_A_ZH,
  TEXT_B,
  createReviewFixture,
} from '../helpers/review-fixture';
import { judgeCalibrationStatus } from '@/lib/rag/judge/calibration-status';

const FP_NIGHTLY = 'a'.repeat(64);
const FP_ONLINE = 'b'.repeat(64);
const FP_OTHER = 'c'.repeat(64);
const TODAY = new Date('2026-11-26T12:00:00Z');

const GATES = {
  accuracy_floor: 0.8,
  kappa_floor: 0.6,
  length_bias_max_delta: 0.1,
  max_age_days: 35,
  min_labels_per_language: 100,
  perturbation_max_delta: 0.1,
  seed_min_labels_per_language: 50,
};

function cell(over: Record<string, unknown> = {}) {
  const role = (over.role as string) ?? 'nightly';
  const fingerprint = (over.fingerprint as string) ?? FP_NIGHTLY;
  const language = (over.language as string) ?? 'en';
  const metric = (over.metric as string) ?? 'faithfulness';
  return {
    key: `${fingerprint}|${role}|${language}|deepeval.${metric}`,
    fingerprint,
    role,
    language,
    library: 'deepeval',
    metric,
    status: 'gating',
    kappa: 0.71,
    accuracy: 0.88,
    n: 120,
    source: 'review_queue',
    labels_human_confirmed: true,
    unsupported_recall: 0.91,
    unsupported_precision: 0.84,
    length_bias_delta: 0.03,
    expanded_delta: 0.02,
    assertive_delta: 0.04,
    recorded_at: '2026-11-03',
    ...over,
  };
}

function calibration(cells: unknown[], running: Record<string, string> = { nightly: FP_NIGHTLY, online: FP_ONLINE }) {
  return { schema_version: 1, provenance: { source: 'calibration' }, config_hash: null, running_fingerprints: running, cells };
}

const codes = (status: { warnings: Array<{ code: string }> }) => status.warnings.map((warning) => warning.code);

describe('judgeCalibrationStatus (D-29, UI-SPEC 6.9)', () => {
  it('reports none_enforced and no cells for the empty committed file', () => {
    const status = judgeCalibrationStatus({ schema_version: 1, provenance: { source: 'defaults' }, cells: [], running_fingerprints: {} }, { judge: GATES }, TODAY);
    expect(status.cells).toEqual([]);
    expect(codes(status)).toEqual(['none_enforced']);
    expect(status.floors).toEqual({ kappa: 0.6, accuracy: 0.8, min_labels: 100, seed_min_labels: 50, max_age_days: 35 });
    expect(status.running).toEqual({ nightly: null, online: null });
  });

  it('keeps a current gating cell gating with valid_until and no warning', () => {
    const status = judgeCalibrationStatus(calibration([cell()]), { judge: GATES }, TODAY);
    expect(status.cells).toHaveLength(1);
    expect(status.cells[0]).toMatchObject({
      role: 'nightly',
      language: 'en',
      library: 'deepeval',
      metric: 'faithfulness',
      status: 'gating',
      reasons: [],
      kappa: 0.71,
      accuracy: 0.88,
      n: 120,
      source: 'review_queue',
      recorded_at: '2026-11-03',
      valid_until: '2026-12-08',
    });
    expect(status.running).toEqual({ nightly: FP_NIGHTLY, online: FP_ONLINE });
    expect(status.warnings).toEqual([]);
  });

  it('demotes a gating cell recorded 36 days ago to uncalibrated with expired_cells', () => {
    const status = judgeCalibrationStatus(calibration([cell({ recorded_at: '2026-10-21' })]), { judge: GATES }, TODAY);
    expect(status.cells[0]).toMatchObject({ status: 'uncalibrated', reasons: ['expired'], valid_until: '2026-11-25' });
    expect(codes(status)).toEqual(['none_enforced', 'expired_cells']);
    const expired = status.warnings.find((warning) => warning.code === 'expired_cells') as { count: number; days: number };
    expect(expired).toMatchObject({ count: 1, days: 35 });
  });

  it('demotes a cell whose fingerprint differs from the running judge of its role (judge_changed)', () => {
    const status = judgeCalibrationStatus(calibration([cell({ fingerprint: FP_OTHER }), cell({ role: 'online', fingerprint: FP_ONLINE })]), { judge: GATES }, TODAY);
    const nightly = status.cells.find((entry) => entry.role === 'nightly');
    expect(nightly).toMatchObject({ status: 'uncalibrated', reasons: ['fingerprint_mismatch'] });
    expect(status.cells.find((entry) => entry.role === 'online')?.status).toBe('gating');
    expect(codes(status)).toEqual(['judge_changed']);
    expect(status.warnings.find((warning) => warning.code === 'judge_changed')).toMatchObject({ roles: ['nightly'] });
  });

  it('treats a role without a running fingerprint as changed (the safe direction)', () => {
    const status = judgeCalibrationStatus(calibration([cell()], { online: FP_ONLINE }), { judge: GATES }, TODAY);
    expect(status.cells[0]).toMatchObject({ status: 'uncalibrated', reasons: ['fingerprint_mismatch'] });
  });

  it('passes the stored reasons of a report_only cell through', () => {
    const status = judgeCalibrationStatus(
      calibration([cell({ status: 'report_only', kappa: 0.48, reasons: ['kappa_below_floor', 'labels_not_confirmed'], labels_human_confirmed: false })]),
      { judge: GATES },
      TODAY,
    );
    expect(status.cells[0]).toMatchObject({ status: 'report_only', reasons: ['kappa_below_floor', 'labels_not_confirmed'] });
    expect(codes(status)).toEqual(['none_enforced']);
  });

  it('gives calibration_invalid and no cells for a file that does not validate', () => {
    const status = judgeCalibrationStatus({ schema_version: 1, cells: [{ key: 'bad' }] }, { judge: GATES }, TODAY);
    expect(status.cells).toEqual([]);
    expect(codes(status)).toEqual(['calibration_invalid', 'none_enforced']);
  });

  it('orders rows by role, then language zh, en, it', () => {
    const status = judgeCalibrationStatus(
      calibration([cell({ language: 'it' }), cell({ role: 'online', fingerprint: FP_ONLINE }), cell({ language: 'zh' }), cell()]),
      { judge: GATES },
      TODAY,
    );
    expect(status.cells.map((entry) => `${entry.role}:${entry.language}`)).toEqual(['nightly:zh', 'nightly:en', 'nightly:it', 'online:en']);
  });
});

// --- Routes ---

const ADMIN = OWNER_A;
const QUESTION_A = 'A synthetic question about the sample component';
const ANSWER_A = 'A synthetic answer: the sample component restarts every night.';
const ANSWER_ZH = '示例组件每天晚上重新启动。';
const ANSWER_B = 'A synthetic answer of tenant bravo that alpha must never read.';

let db: PGlite;
const calls: string[] = [];
const guard = { session: null as { id: string } | null, lookupFails: false };
let labelledA: string;
let labelledZh: string;
let changedA: string;
let noAnswerA: string;
let unlabelledA: string;
let labelledB: string;

function adminClient() {
  const data = pgliteClient(db, { role: 'service_role', label: 'admin', calls });
  return {
    ...data,
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from(table: string) {
      if (table !== 'admin_users') return data.from(table);
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        abortSignal: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        maybeSingle() {
          if (guard.lookupFails) return Promise.resolve({ data: null, error: { message: 'down' } });
          return Promise.resolve({ data: filters.id === ADMIN ? { id: ADMIN } : null, error: null });
        },
      };
      return builder;
    },
  };
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: guard.session } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => adminClient(), getSupabase: () => ({}) }));
  return {
    status: await import('@/app/api/rag/admin/judge-calibration/route'),
    exportRoute: await import('@/app/api/rag/admin/judge-calibration/export/route'),
  };
}

const statusGet = () => new NextRequest('http://localhost/api/rag/admin/judge-calibration');
const exportGet = (query: string) => new NextRequest(`http://localhost/api/rag/admin/judge-calibration/export${query}`);

async function chatItem(
  tenantKey: string,
  owner: string,
  candidates: unknown[],
  answer: string | null,
  question = QUESTION_A,
  language = 'en',
): Promise<string> {
  const traceId = crypto.randomUUID();
  let chatId: string | null = null;
  if (answer !== null) {
    chatId = crypto.randomUUID();
    await db.query('INSERT INTO chats (id, user_id, title, messages) VALUES ($1, $2, $3, $4::jsonb)', [
      chatId,
      owner,
      'Synthetic chat',
      JSON.stringify([
        { role: 'user', content: question },
        { role: 'assistant', content: answer, metadata: { ragTraceId: traceId } },
      ]),
    ]);
  }
  const result = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (tenant_key, trace_id, query_masked, query_language, query_fingerprint, channel, outcome, reasons, candidates, mining_window, chat_id, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'answered', ARRAY['low_score'], $7::jsonb, '2026-11-23T00:00:00Z', $8, $9) RETURNING id`,
    [
      tenantKey,
      traceId,
      question,
      language,
      crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
      answer === null ? 'voice' : 'chat',
      JSON.stringify(candidates),
      chatId,
      answer === null ? null : owner,
    ],
  );
  return result.rows[0].id;
}

const kept = (chunkId: string, documentId: string, rank = 1) => ({ chunk_id: chunkId, document_id: documentId, rank, similarity: 0.5, kept: true });

async function judgeLabel(itemId: string, tenantKey: string, expert: string, verdicts = { supported: true, relevant: true, unsupported_content: false }) {
  await db.query(
    'INSERT INTO rag_judge_labels (review_item_id, tenant_key, supported, relevant, unsupported_content, labelled_by) VALUES ($1, $2, $3, $4, $5, $6)',
    [itemId, tenantKey, verdicts.supported, verdicts.relevant, verdicts.unsupported_content, expert],
  );
}

function enable() {
  vi.stubEnv('MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
  vi.stubEnv('NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
}

beforeAll(async () => {
  ({ db } = await createReviewFixture());
  await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
  labelledA = await chatItem(TENANT_A, OWNER_A, [kept(CHUNK_A, DOC_A)], ANSWER_A);
  labelledZh = await chatItem(TENANT_A, OWNER_A, [kept(CHUNK_A_ZH, DOC_A), { ...kept(CHUNK_A, DOC_A, 2), kept: false }], ANSWER_ZH, '示例组件什么时候重启？', 'zh');
  changedA = await chatItem(TENANT_A, OWNER_A, [kept(CHUNK_A_SUPERSEDED, DOC_A)], ANSWER_A);
  noAnswerA = await chatItem(TENANT_A, OWNER_A, [kept(CHUNK_A, DOC_A)], null);
  unlabelledA = await chatItem(TENANT_A, OWNER_A, [kept(CHUNK_A, DOC_A)], ANSWER_A);
  labelledB = await chatItem(TENANT_B, OWNER_B, [kept(CHUNK_B, DOC_B)], ANSWER_B);
  await judgeLabel(labelledA, TENANT_A, EXPERT_A);
  await judgeLabel(labelledZh, TENANT_A, EXPERT_A, { supported: false, relevant: true, unsupported_content: true });
  await judgeLabel(changedA, TENANT_A, EXPERT_A);
  await judgeLabel(noAnswerA, TENANT_A, EXPERT_A);
  await judgeLabel(labelledB, TENANT_B, EXPERT_B);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  guard.session = null;
  guard.lookupFails = false;
  calls.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
});

describe('GET /api/rag/admin/judge-calibration', () => {
  it('denies without a session (401), for a non-admin (403) and when the guard is unavailable (503)', async () => {
    const { status } = await load();
    expect((await status.GET(statusGet())).status).toBe(401);
    guard.session = { id: OWNER_B };
    expect((await status.GET(statusGet())).status).toBe(403);
    guard.session = { id: ADMIN };
    guard.lookupFails = true;
    expect((await status.GET(statusGet())).status).toBe(503);
  });

  it('returns floors, running fingerprints, cells and warnings of the committed file, read-only, with no-store', async () => {
    guard.session = { id: ADMIN };
    const { status } = await load();
    const res = await status.GET(statusGet());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.floors).toEqual({ kappa: 0.6, accuracy: 0.8, min_labels: 100, seed_min_labels: 50, max_age_days: 35 });
    expect(body.cells).toEqual([]);
    expect(body.warnings.map((warning: { code: string }) => warning.code)).toEqual(['none_enforced']);
    expect(body.running).toEqual({ nightly: null, online: null });
    expect(Object.keys(status).filter((name) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(name))).toEqual([]);
  });
});

describe('GET /api/rag/admin/judge-calibration/export (D-31)', () => {
  it('runs the admin guard first and reads nothing before it', async () => {
    enable();
    const { exportRoute } = await load();
    expect((await exportRoute.GET(exportGet(`?tenant=${TENANT_A}`))).status).toBe(401);
    guard.session = { id: OWNER_B };
    expect((await exportRoute.GET(exportGet(`?tenant=${TENANT_A}`))).status).toBe(403);
    guard.session = { id: ADMIN };
    guard.lookupFails = true;
    expect((await exportRoute.GET(exportGet(`?tenant=${TENANT_A}`))).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('answers 400 for a missing or malformed tenant or an extra parameter, and 403 for a tenant the admin does not administer', async () => {
    enable();
    guard.session = { id: ADMIN };
    const { exportRoute } = await load();
    for (const query of ['', '?tenant=u:not-a-uuid', '?tenant=s:default', `?tenant=${TENANT_A}&user=${OWNER_B}`]) {
      expect((await exportRoute.GET(exportGet(query))).status, query).toBe(400);
    }
    expect(calls).toEqual([]);
    const foreign = await exportRoute.GET(exportGet(`?tenant=${TENANT_B}`));
    expect(foreign.status).toBe(403);
    expect(JSON.stringify(await foreign.json())).not.toContain(ANSWER_B);
    expect(calls.filter((call) => !call.startsWith('admin:rpc:'))).toEqual([]);
  });

  it("returns tenant A's labelled cases with masked text and verdicts, and counts the skipped ones", async () => {
    enable();
    guard.session = { id: ADMIN };
    const { exportRoute } = await load();
    const res = await exportRoute.GET(exportGet(`?tenant=${TENANT_A}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.tenant_key).toBe(TENANT_A);
    expect(body.skipped).toEqual({ no_answer: 1, changed_chunk: 1, no_context: 0 });
    const byId = new Map<string, Record<string, unknown>>(body.cases.map((entry: { item_id: string }) => [entry.item_id, entry]));
    expect([...byId.keys()].sort()).toEqual([labelledA, labelledZh].sort());
    expect(byId.get(labelledA)).toMatchObject({
      language: 'en',
      question: QUESTION_A,
      answer: ANSWER_A,
      contexts: [{ chunk_id: CHUNK_A, document_id: DOC_A, text: TEXT_A }],
      labels: [{ supported: true, relevant: true, unsupported_content: false }],
    });
    expect(byId.get(labelledZh)).toMatchObject({
      language: 'zh',
      answer: ANSWER_ZH,
      contexts: [{ chunk_id: CHUNK_A_ZH, document_id: DOC_A, text: TEXT_A_ZH }],
      labels: [{ supported: false, relevant: true, unsupported_content: true }],
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(unlabelledA);
    expect(text).not.toContain(labelledB);
    expect(text).not.toContain(ANSWER_B);
    expect(text).not.toContain(TEXT_B);
    expect(text).not.toContain(EXPERT_A);
  });

  it('logs no question, answer or chunk text from either route', async () => {
    enable();
    guard.session = { id: ADMIN };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { status, exportRoute } = await load();
    await status.GET(statusGet());
    await exportRoute.GET(exportGet(`?tenant=${TENANT_A}`));
    await exportRoute.GET(exportGet(`?tenant=${TENANT_B}`));
    const logged = JSON.stringify([...log.mock.calls, ...error.mock.calls, ...warn.mock.calls]);
    for (const secret of [QUESTION_A, ANSWER_A, ANSWER_ZH, ANSWER_B, TEXT_A, TEXT_A_ZH, TEXT_B, '示例组件什么时候重启']) {
      expect(logged).not.toContain(secret);
    }
  });
});
