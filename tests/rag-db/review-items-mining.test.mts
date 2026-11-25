import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/feedback-mining.json'), 'utf8')) as Record<string, unknown>;

const SINCE = '2026-11-16T00:00:00Z';
const UNTIL = '2026-11-23T00:00:00Z';
const INSIDE = '2026-11-20T12:00:00Z';

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

async function createOrganization(db: PGlite, ownerId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [id, 'Fixture org', `fixture-${id.slice(0, 8)}`, ownerId]);
  return id;
}

function fingerprintOf(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

interface Tenant {
  key: string;
  organizationId: string;
  userId: string;
}

async function createTenant(db: PGlite): Promise<Tenant> {
  const userId = await createUser(db);
  const organizationId = await createOrganization(db, userId);
  return { key: `o:${organizationId}`, organizationId, userId };
}

let counter = 0;

async function insertLog(db: PGlite, tenant: Tenant, row: Row = {}): Promise<{ id: string; trace_id: string }> {
  counter += 1;
  const question = typeof row.query_masked === 'string' ? row.query_masked : `Synthetic question number ${counter} about the sample topic`;
  const values: Row = {
    trace_id: crypto.randomUUID(),
    user_id: tenant.userId,
    organization_id: tenant.organizationId,
    chat_id: crypto.randomUUID(),
    channel: 'chat',
    pipeline: 'legacy',
    status: 'ok',
    outcome: 'answered',
    candidate_count: 3,
    top_score: 0.7,
    created_at: INSIDE,
    query_fingerprint: fingerprintOf(question),
    ...row,
    query_masked: 'query_masked' in row ? row.query_masked : question,
  };
  const names = Object.keys(values);
  const result = await db.query<{ id: string; trace_id: string }>(
    `INSERT INTO rag_retrieval_log (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, trace_id`,
    names.map((name) => values[name]),
  );
  return result.rows[0] as { id: string; trace_id: string };
}

async function insertAnswerRecord(db: PGlite, tenant: Tenant, traceId: string, fields: { feedback?: unknown; groundedness?: unknown }): Promise<void> {
  await db.query(
    `INSERT INTO rag_answer_records (id, user_id, organization_id, trace_id, rag_mode, feedback, groundedness)
     VALUES ($1, $2, $3, $4, 'strict', $5, $6)`,
    [crypto.randomUUID(), tenant.userId, tenant.organizationId, traceId, fields.feedback === undefined ? null : JSON.stringify(fields.feedback), JSON.stringify(fields.groundedness ?? {})],
  );
}

interface MineRow {
  tenant_key: string;
  reason: string;
  inserted: number;
}

async function mine(db: PGlite, config: Row = CONFIG, since = SINCE, until = UNTIL): Promise<MineRow[]> {
  return (
    await db.query<MineRow>('SELECT tenant_key, reason, inserted FROM public.rag_mine_failed_queries($1, $2, $3) ORDER BY tenant_key, reason', [
      since,
      until,
      JSON.stringify(config),
    ])
  ).rows;
}

async function items(db: PGlite, tenantKey?: string): Promise<Row[]> {
  const where = tenantKey ? 'WHERE tenant_key = $1' : '';
  return (await db.query<Row>(`SELECT * FROM rag_review_items ${where} ORDER BY mined_at, trace_id`, tenantKey ? [tenantKey] : [])).rows;
}

async function itemFor(db: PGlite, traceId: string): Promise<Row | undefined> {
  return (await db.query<Row>('SELECT * FROM rag_review_items WHERE trace_id = $1', [traceId])).rows[0];
}

describe('rag_mine_failed_queries (multi-tenant)', () => {
  let db: PGlite;
  let tenantA: Tenant;
  let tenantB: Tenant;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
  });

  beforeEach(async () => {
    await db.query('DELETE FROM rag_review_items');
    await db.query('DELETE FROM rag_answer_records');
    await db.query('DELETE FROM rag_retrieval_log');
    await db.query('DELETE FROM rag_tenant_feedback_settings');
    tenantA = await createTenant(db);
    tenantB = await createTenant(db);
  });

  after(async () => {
    await db.close();
  });

  test('every reason is assigned from its own signal, and rows that match none produce no item', async () => {
    const cases: Array<{ name: string; row: Row; record?: { feedback?: unknown; groundedness?: unknown }; expected: string[] | null }> = [
      { name: 'answer vote', row: { feedback_vote: -1, feedback_kind: 'answer' }, expected: ['feedback_negative'] },
      { name: 'embed vote', row: { channel: 'embed', feedback_vote: -1, feedback_kind: 'embed' }, expected: ['feedback_negative'] },
      { name: 'phase 5 vote', row: {}, record: { feedback: { vote: 'not_helpful', reasons: [] } }, expected: ['feedback_negative'] },
      { name: 'phase 5 helpful', row: {}, record: { feedback: { vote: 'helpful', reasons: [] } }, expected: null },
      { name: 'refusal disputed', row: { outcome: 'refused_no_context', top_score: 0.1, feedback_vote: -1, feedback_kind: 'refusal' }, expected: ['refusal_disputed'] },
      { name: 'refusal confirmed', row: { outcome: 'refused_no_context', top_score: 0.1, feedback_vote: 1, feedback_kind: 'refusal' }, expected: null },
      { name: 'groundedness', row: {}, record: { groundedness: { label: 'possibly_unreliable' } }, expected: ['groundedness_flagged'] },
      { name: 'verified', row: {}, record: { groundedness: { label: 'verified' } }, expected: null },
      { name: 'refused high (outcome)', row: { outcome: 'refused_no_context', top_score: 0.6 }, expected: ['refused_high_score'] },
      { name: 'refused high (decision)', row: { outcome: 'unknown', refusal_decision: 'refuse', top_score: 0.55 }, expected: ['refused_high_score'] },
      { name: 'refused low', row: { outcome: 'refused_no_context', top_score: 0.3 }, expected: null },
      {
        name: 'refused high (rerank floor)',
        row: { outcome: 'refused_no_context', top_score: 0.52, candidates: JSON.stringify([{ chunk_id: 'c1', document_id: 'd1', rank: 1, similarity: 0.4, rerank_score: 0.52, kept: false }]) },
        expected: ['refused_high_score'],
      },
      { name: 'zero results', row: { outcome: 'answered', candidate_count: 0, top_score: null }, expected: ['zero_results'] },
      { name: 'zero results kb unavailable', row: { outcome: 'kb_unavailable', status: 'error', candidate_count: 0, top_score: null }, expected: null },
      { name: 'low score', row: { top_score: 0.2 }, expected: ['low_score'] },
      {
        name: 'low score rerank ceiling',
        row: { top_score: 0.3, candidates: JSON.stringify([{ chunk_id: 'c1', document_id: 'd1', rank: 1, similarity: 0.8, rerank_score: 0.3, kept: true }]) },
        expected: null,
      },
      {
        name: 'low score rerank below ceiling',
        row: { top_score: 0.1, candidates: JSON.stringify([{ chunk_id: 'c1', document_id: 'd1', rank: 1, similarity: 0.8, rerank_score: 0.1, kept: true }]) },
        expected: ['low_score'],
      },
      { name: 'healthy', row: {}, expected: null },
      { name: 'no source opened alone', row: { source_opened_count: 0 }, expected: null },
      { name: 'combined', row: { feedback_vote: -1, feedback_kind: 'answer', top_score: 0.1 }, expected: ['feedback_negative', 'low_score'] },
    ];
    const traces = new Map<string, string>();
    for (const entry of cases) {
      const log = await insertLog(db, tenantA, entry.row);
      if (entry.record) await insertAnswerRecord(db, tenantA, log.trace_id, entry.record);
      traces.set(entry.name, log.trace_id);
    }
    await mine(db);
    for (const entry of cases) {
      const item = await itemFor(db, traces.get(entry.name) as string);
      if (entry.expected === null) {
        assert.equal(item, undefined, entry.name);
      } else {
        assert.deepEqual(item?.reasons, entry.expected, entry.name);
      }
    }
  });

  test('no_source_opened appears only with another reason and only when the signal switch is on', async () => {
    const alone = await insertLog(db, tenantA, { source_opened_count: 0 });
    const withLow = await insertLog(db, tenantA, { source_opened_count: 0, top_score: 0.1 });
    const opened = await insertLog(db, tenantA, { source_opened_count: 2, top_score: 0.1 });
    await mine(db, { ...CONFIG, source_open_signal: true });
    assert.equal(await itemFor(db, alone.trace_id), undefined);
    assert.deepEqual((await itemFor(db, withLow.trace_id))?.reasons, ['low_score', 'no_source_opened']);
    assert.deepEqual((await itemFor(db, opened.trace_id))?.reasons, ['low_score']);
  });

  test('without the signal switch no_source_opened is never assigned', async () => {
    const row = await insertLog(db, tenantA, { source_opened_count: 0, top_score: 0.1 });
    await mine(db);
    assert.deepEqual((await itemFor(db, row.trace_id))?.reasons, ['low_score']);
  });

  test('rows without query_masked and rows outside the window are skipped', async () => {
    const masked = await insertLog(db, tenantA, { top_score: 0.1 });
    await insertLog(db, tenantA, { top_score: 0.1, query_masked: null, query_fingerprint: null });
    await insertLog(db, tenantA, { top_score: 0.1, created_at: '2026-11-15T23:59:59Z' });
    await insertLog(db, tenantA, { top_score: 0.1, created_at: UNTIL });
    await mine(db);
    const all = await items(db);
    assert.deepEqual(all.map((item) => item.trace_id), [masked.trace_id]);
  });

  test('rows of the same fingerprint collapse into one item with the occurrence count and the newest trace', async () => {
    const question = 'A repeated synthetic question about the sample topic';
    await insertLog(db, tenantA, { query_masked: question, top_score: 0.1, created_at: '2026-11-17T00:00:00Z' });
    await insertLog(db, tenantA, { query_masked: question, feedback_vote: -1, feedback_kind: 'answer', created_at: '2026-11-18T00:00:00Z' });
    const newest = await insertLog(db, tenantA, { query_masked: question, top_score: 0.2, created_at: '2026-11-19T00:00:00Z' });
    const otherTenant = await insertLog(db, tenantB, { query_masked: question, top_score: 0.1 });
    await mine(db);
    const itemsA = await items(db, tenantA.key);
    assert.equal(itemsA.length, 1);
    assert.equal(itemsA[0]?.occurrences, 3);
    assert.equal(itemsA[0]?.trace_id, newest.trace_id);
    assert.equal(itemsA[0]?.retrieval_log_id, newest.id);
    assert.deepEqual(itemsA[0]?.reasons, ['feedback_negative', 'low_score']);
    const itemsB = await items(db, tenantB.key);
    assert.equal(itemsB.length, 1);
    assert.equal(itemsB[0]?.trace_id, otherTenant.trace_id);
    assert.equal(itemsB[0]?.occurrences, 1);
  });

  test('per_tenant_limit keeps the highest-priority items per tenant', async () => {
    const low = await insertLog(db, tenantA, { top_score: 0.1 });
    const zero = await insertLog(db, tenantA, { candidate_count: 0, top_score: null });
    const negative = await insertLog(db, tenantA, { feedback_vote: -1, feedback_kind: 'answer' });
    const grounded = await insertLog(db, tenantA, {});
    await insertAnswerRecord(db, tenantA, grounded.trace_id, { groundedness: { label: 'possibly_unreliable' } });
    const bLow = await insertLog(db, tenantB, { top_score: 0.1 });
    const bDisputed = await insertLog(db, tenantB, { outcome: 'refused_no_context', top_score: 0.1, feedback_vote: -1, feedback_kind: 'refusal' });
    const bHigh = await insertLog(db, tenantB, { outcome: 'refused_no_context', top_score: 0.9 });
    const counts = await mine(db, { ...CONFIG, per_tenant_limit: 2 });
    assert.deepEqual(new Set((await items(db, tenantA.key)).map((item) => item.trace_id)), new Set([negative.trace_id, grounded.trace_id]));
    assert.deepEqual(new Set((await items(db, tenantB.key)).map((item) => item.trace_id)), new Set([bDisputed.trace_id, bHigh.trace_id]));
    assert.equal(await itemFor(db, low.trace_id), undefined);
    assert.equal(await itemFor(db, zero.trace_id), undefined);
    assert.equal(await itemFor(db, bLow.trace_id), undefined);
    assert.deepEqual(counts, [
      { tenant_key: tenantA.key, reason: 'feedback_negative', inserted: 1 },
      { tenant_key: tenantA.key, reason: 'groundedness_flagged', inserted: 1 },
      { tenant_key: tenantB.key, reason: 'refusal_disputed', inserted: 1 },
      { tenant_key: tenantB.key, reason: 'refused_high_score', inserted: 1 },
    ].sort((a, b) => (a.tenant_key + a.reason < b.tenant_key + b.reason ? -1 : 1)));
  });

  test('a second call with the same window inserts nothing and reports 0 for every tenant and reason', async () => {
    await insertLog(db, tenantA, { top_score: 0.1 });
    await insertLog(db, tenantA, { feedback_vote: -1, feedback_kind: 'answer' });
    await insertLog(db, tenantB, { candidate_count: 0, top_score: null });
    const first = await mine(db);
    assert.ok(first.length >= 3);
    assert.ok(first.every((row) => row.inserted === 1));
    const before = await items(db);
    const second = await mine(db);
    assert.deepEqual(
      second,
      first.map((row) => ({ ...row, inserted: 0 })),
    );
    assert.deepEqual(await items(db), before);
  });

  test('an existing tagged item is neither duplicated nor changed by a second run (D-29)', async () => {
    const row = await insertLog(db, tenantA, { top_score: 0.1 });
    await mine(db);
    await db.query("UPDATE rag_review_items SET tags = '{representative}' WHERE trace_id = $1", [row.trace_id]);
    const before = await items(db);
    await mine(db);
    assert.deepEqual(await items(db), before);
    assert.deepEqual((await itemFor(db, row.trace_id))?.tags, ['representative']);
  });

  test('interleaved tenants: every item copies tenant, user, chat, snapshot and language columns from its own source row', async () => {
    const sources: Array<{ tenant: Tenant; trace: string; row: Row }> = [];
    const languages: Array<Row> = [
      { query_language: 'zh', query_language_confidence: 1, answer_language: 'zh', chunk_languages: ['zh', 'en'] },
      { query_language: 'it', query_language_confidence: 0.5, answer_language: 'it', chunk_languages: ['it'] },
      { query_language: 'en', query_language_confidence: null, answer_language: null, chunk_languages: ['und'] },
      { query_language: 'zh-Hant', query_language_confidence: 1, answer_language: 'en', chunk_languages: [] },
    ];
    for (let index = 0; index < 8; index += 1) {
      const tenant = index % 2 === 0 ? tenantA : tenantB;
      const candidates = [
        { chunk_id: `chunk-${index}-1`, document_id: crypto.randomUUID(), rank: 1, similarity: 0.2, kept: true, language: 'en' },
        { chunk_id: `chunk-${index}-2`, document_id: crypto.randomUUID(), rank: 2, similarity: 0.1, kept: false },
      ];
      const row: Row = {
        top_score: 0.2,
        retrieval_config_hash: `cfg-${index}`,
        channel: index % 3 === 0 ? 'embed' : 'chat',
        candidates: JSON.stringify(candidates),
        ...languages[index % languages.length],
      };
      const log = await insertLog(db, tenant, row);
      sources.push({ tenant, trace: log.trace_id, row: { ...row, candidates } });
    }
    await mine(db);
    for (const source of sources) {
      const item = await itemFor(db, source.trace);
      const log = (await db.query<Row>('SELECT * FROM rag_retrieval_log WHERE trace_id = $1', [source.trace])).rows[0] as Row;
      assert.ok(item, source.trace);
      assert.equal(item.tenant_key, source.tenant.key);
      assert.equal(item.tenant_key, log.tenant_key);
      assert.equal(item.user_id, log.user_id);
      assert.equal(item.chat_id, log.chat_id);
      assert.equal(item.retrieval_log_id, log.id);
      for (const column of ['query_masked', 'query_fingerprint', 'query_language', 'query_language_confidence', 'answer_language', 'chunk_languages', 'channel', 'outcome', 'candidates', 'retrieval_config_hash']) {
        assert.deepEqual(item[column], log[column], column);
      }
      assert.deepEqual(item.candidates, source.row.candidates);
      assert.deepEqual(item.tags, []);
      assert.equal(item.status, 'open');
      assert.equal(item.occurrences, 1);
      assert.equal(new Date(item.mining_window as string).toISOString(), '2026-11-23T00:00:00.000Z');
      const ttlDays = (new Date(item.expires_at as string).getTime() - new Date(item.mined_at as string).getTime()) / 86_400_000;
      assert.ok(Math.abs(ttlDays - Number(CONFIG.open_item_ttl_days)) < 0.01, `ttl ${ttlDays}`);
    }
  });

  test('a feedback record of another tenant on the same trace id is ignored', async () => {
    const log = await insertLog(db, tenantA, {});
    await insertAnswerRecord(db, tenantB, log.trace_id, { feedback: { vote: 'not_helpful', reasons: [] } });
    await mine(db);
    assert.equal(await itemFor(db, log.trace_id), undefined);
  });

  test('tenants that lowered their log level to ids or off are not mined', async () => {
    const a = await insertLog(db, tenantA, { top_score: 0.1 });
    const b = await insertLog(db, tenantB, { top_score: 0.1 });
    await db.query("INSERT INTO rag_tenant_feedback_settings (tenant_key, retrieval_log) VALUES ($1, 'ids')", [tenantA.key]);
    await mine(db);
    assert.equal(await itemFor(db, a.trace_id), undefined);
    assert.ok(await itemFor(db, b.trace_id));
  });

  test('invalid arguments are refused with 22023', async () => {
    await rejectsWith(() => mine(db, CONFIG, UNTIL, SINCE), '22023');
    await rejectsWith(() => db.query('SELECT * FROM public.rag_mine_failed_queries(NULL, $1, $2)', [UNTIL, JSON.stringify(CONFIG)]), '22023');
    await rejectsWith(() => mine(db, { ...CONFIG, per_tenant_limit: 0 }), '22023');
    await rejectsWith(() => mine(db, { ...CONFIG, low_score_ceiling: {} }), '22023');
    await rejectsWith(() => mine(db, { ...CONFIG, refused_high_score_floor: { similarity: 'high', rerank: 0.5 } }), '22023');
    await rejectsWith(() => mine(db, { ...CONFIG, open_item_ttl_days: -1 }), '22023');
  });

  test('the function is refused for anon and authenticated and allowed for service_role', async () => {
    const user = await createUser(db);
    for (const role of ['anon', 'authenticated'] as const) {
      await rejectsWith(() => asRole(db, role, role === 'anon' ? null : user, () => mine(db)), '42501');
    }
    await asRole(db, 'service_role', null, () => mine(db));
    const fn = (
      await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
        "SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.rag_mine_failed_queries(timestamptz, timestamptz, jsonb)'::regprocedure",
      )
    ).rows[0];
    assert.equal(fn?.prosecdef, true);
    assert.deepEqual(fn?.proconfig, ['search_path=""']);
  });
});

describe('rag_mine_failed_queries (single-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
  });

  after(async () => {
    await db.close();
  });

  test('mines s:default rows', async () => {
    const userId = await createUser(db);
    const question = 'A synthetic single-tenant question';
    const log = (
      await db.query<{ trace_id: string }>(
        `INSERT INTO rag_retrieval_log (trace_id, user_id, channel, pipeline, status, outcome, candidate_count, top_score, created_at, query_masked, query_fingerprint)
         VALUES ($1, $2, 'chat', 'legacy', 'ok', 'answered', 2, 0.1, $3, $4, $5) RETURNING trace_id`,
        [crypto.randomUUID(), userId, INSIDE, question, fingerprintOf(question)],
      )
    ).rows[0] as { trace_id: string };
    const counts = await mine(db);
    assert.deepEqual(counts, [{ tenant_key: 's:default', reason: 'low_score', inserted: 1 }]);
    assert.equal((await itemFor(db, log.trace_id))?.tenant_key, 's:default');
  });
});
