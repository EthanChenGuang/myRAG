import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { seedRate, seedRetrievalLog, type SeedCell, type SeededRow } from '../helpers/retrieval-log-seed.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0971_rag_monitor_aggregate.sql'), 'utf8');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const DAY = '2026-03-10';
const LATENCY_EDGES = [0, 50, 100, 150, 200, 300, 400, 500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000];
const COUNT_COLUMNS = [
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
] as const;

type CountColumn = (typeof COUNT_COLUMNS)[number];
type CellRow = Record<CountColumn, number> & {
  tenant_key: string;
  day: string;
  language: string;
  rag_mode: string;
  channel: string;
  doc_type: string;
  judge_score_sums: Record<string, number | string>;
  top_score_hist: Record<string, number[]>;
  latency_hist: number[];
};

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

function tenants(mode: DeploymentMode): string[] {
  if (mode === 'single-tenant') return ['s:default'];
  return [`o:${crypto.randomUUID()}`, `u:${crypto.randomUUID()}`];
}

function scoreBin(score: number): number {
  if (score < 0) return 0;
  if (score > 1) return 21;
  return 1 + Math.min(Math.floor(Math.round(score * 10000) / 500), 19);
}

function latencyBin(ms: number): number {
  let bin = 0;
  for (const edge of LATENCY_EDGES) if (ms >= edge) bin += 1;
  return bin;
}

function zeros(): number[] {
  return Array.from({ length: 22 }, () => 0);
}

function expectedHistograms(rows: SeededRow[]): { top: Record<string, number[]>; latency: number[] } {
  const top: Record<string, number[]> = { rerank: zeros(), similarity: zeros() };
  const latency = zeros();
  for (const row of rows) {
    if (row.scoreKind && row.score !== null) (top[row.scoreKind] as number[])[scoreBin(row.score)] += 1;
    latency[latencyBin(row.latencyMs)] += 1;
  }
  return { top, latency };
}

function cellKey(cell: Pick<CellRow, 'tenant_key' | 'language' | 'rag_mode' | 'channel' | 'doc_type'>): string {
  return [cell.tenant_key, cell.language, cell.rag_mode, cell.channel, cell.doc_type].join('|');
}

async function cells(db: PGlite, day = DAY): Promise<Map<string, CellRow>> {
  const result = await db.query<CellRow>(
    `SELECT tenant_key, day::text AS day, language, rag_mode, channel, doc_type, ${COUNT_COLUMNS.join(', ')},
            judge_score_sums, top_score_hist, latency_hist
       FROM public.rag_monitor_daily WHERE day = $1::date`,
    [day],
  );
  return new Map(result.rows.map((row) => [cellKey(row), row]));
}

async function aggregate(db: PGlite, day = DAY): Promise<number> {
  return (await db.query<{ n: number }>('SELECT public.rag_monitor_aggregate($1::date) AS n', [day])).rows[0]?.n ?? -1;
}

/** One cell per tenant, language and channel, each with its own exact counts. */
function weekCells(tenantKeys: string[]): SeedCell[] {
  const out: SeedCell[] = [];
  let k = 0;
  for (const tenantKey of tenantKeys) {
    for (const language of ['en', 'it']) {
      for (const channel of ['chat', 'voice'] as const) {
        k += 1;
        const rows = 20 + k * 3;
        out.push({
          tenantKey,
          day: DAY,
          language,
          ragMode: 'strict',
          channel,
          rows,
          counts: {
            refused: seedRate(rows, 0.2) + k,
            belowThreshold: k,
            error: 2 + (k % 2),
            kbUnavailable: 1,
            degraded: k % 3,
            zeroResult: 1 + (k % 2),
            helpful: 4 + k,
            notHelpful: 2 + (k % 3),
            groundednessFlagged: k % 4,
            judged: 3 + (k % 2),
          },
          topScore: { kind: k % 2 === 0 ? 'rerank' : 'similarity', mean: 0.6, spread: 0.3 },
          latencyMs: { mean: 900, spread: 850 },
          docType: k % 2 === 0 ? 'general' : 'product_technical',
          judgeScores: { faithfulness: 0.75, answer_relevance: 0.5 },
        });
      }
    }
  }
  return out;
}

function expectedCounts(cell: SeedCell): Record<CountColumn, number> {
  const c = cell.counts ?? {};
  return {
    retrievals: cell.rows,
    refused: c.refused ?? 0,
    kb_unavailable: c.kbUnavailable ?? 0,
    degraded: c.degraded ?? 0,
    error: c.error ?? 0,
    zero_result: c.zeroResult ?? 0,
    below_threshold: c.belowThreshold ?? 0,
    helpful: c.helpful ?? 0,
    not_helpful: c.notHelpful ?? 0,
    judged: c.judged ?? 0,
    groundedness_flagged: c.groundednessFlagged ?? 0,
  };
}

function rowCounts(rows: SeededRow[]): Record<CountColumn, number> {
  const kind = (...kinds: SeededRow['kind'][]) => rows.filter((r) => kinds.includes(r.kind)).length;
  return {
    retrievals: rows.length,
    refused: kind('refused', 'below_threshold'),
    kb_unavailable: kind('kb_unavailable'),
    degraded: kind('degraded'),
    error: kind('error', 'kb_unavailable'),
    zero_result: kind('zero_result'),
    below_threshold: kind('below_threshold'),
    helpful: rows.filter((r) => r.vote === 1).length,
    not_helpful: rows.filter((r) => r.vote === -1).length,
    judged: rows.filter((r) => r.judged).length,
    groundedness_flagged: rows.filter((r) => r.groundednessFlagged).length,
  };
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function utcDaysAgo(n: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - n * 86_400_000).toISOString().slice(0, 10);
}

for (const mode of MODES) {
  describe(`rag_monitor_aggregate (${mode})`, () => {
    let db: PGlite;
    let keys: string[];

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      keys = tenants(mode);
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      await db.exec(`
        DELETE FROM public.rag_monitor_daily;
        DELETE FROM public.rag_online_judge_scores;
        DELETE FROM public.rag_answer_records;
        DELETE FROM public.rag_retrieval_log;
      `);
    });

    test('one cell per tenant, language, mode, channel and doc type with exactly the seeded counts', async () => {
      const spec = weekCells(keys);
      const seeded = await seedRetrievalLog(db, { seed: `exact-${mode}`, cells: spec });
      const written = await aggregate(db);
      const stored = await cells(db);

      assert.equal(written, stored.size);
      for (const [index, cell] of spec.entries()) {
        const base = { tenant_key: cell.tenantKey, language: cell.language ?? 'und', rag_mode: cell.ragMode ?? 'unknown', channel: cell.channel };
        const cellRows = seeded.rows.filter((r) => r.cellIndex === index);
        const withDoc = cellRows.filter((r) => r.documentId !== null);
        const withoutDoc = cellRows.filter((r) => r.documentId === null);
        const parts = [
          { key: cellKey({ ...base, doc_type: cell.docType ?? 'general' }), rows: withDoc },
          { key: cellKey({ ...base, doc_type: 'unknown' }), rows: withoutDoc },
        ];
        const total = Object.fromEntries(COUNT_COLUMNS.map((column) => [column, 0])) as Record<CountColumn, number>;
        for (const part of parts) {
          const row = stored.get(part.key);
          assert.ok(row, `missing cell ${part.key}`);
          assert.equal(row.day, DAY);
          assert.deepEqual(
            Object.fromEntries(COUNT_COLUMNS.map((column) => [column, row[column]])),
            rowCounts(part.rows),
            `counts of ${part.key}`,
          );
          const hist = expectedHistograms(part.rows);
          assert.deepEqual(row.top_score_hist, hist.top, `top-score histogram of ${part.key}`);
          assert.deepEqual(row.latency_hist, hist.latency, `latency histogram of ${part.key}`);
          const judged = part.rows.filter((r) => r.judged).length;
          assert.equal(Number(row.judge_score_sums.faithfulness), judged * 0.75);
          assert.equal(Number(row.judge_score_sums.answer_relevance), judged * 0.5);
          for (const column of COUNT_COLUMNS) total[column] += row[column];
        }
        assert.deepEqual(total, expectedCounts(cell), `seeded counts of cell ${index}`);
      }
      assert.equal(stored.size, spec.length * 2);

      for (const tenantKey of keys) {
        const tenantRows = seeded.rows.filter((r) => r.tenantKey === tenantKey).length;
        const tenantCells = [...stored.values()].filter((row) => row.tenant_key === tenantKey);
        assert.equal(
          tenantCells.reduce((sum, row) => sum + row.retrievals, 0),
          tenantRows,
          `retrievals of ${tenantKey}`,
        );
      }
      assert.deepEqual(new Set([...stored.values()].map((row) => row.tenant_key)), new Set(keys));
    });

    test('re-running a day leaves the same cells and counts; a later vote is picked up by the next run', async () => {
      const spec = weekCells(keys);
      const seeded = await seedRetrievalLog(db, { seed: `rerun-${mode}`, cells: spec });
      assert.equal(await aggregate(db), spec.length * 2);
      const first = await cells(db);
      assert.equal(await aggregate(db), spec.length * 2);
      const second = await cells(db);
      assert.equal(second.size, first.size);
      for (const [key, row] of first) {
        const again = second.get(key) as CellRow;
        for (const column of COUNT_COLUMNS) assert.equal(again[column], row[column], `${column} of ${key}`);
        assert.deepEqual(again.top_score_hist, row.top_score_hist);
        assert.deepEqual(again.latency_hist, row.latency_hist);
      }

      const unvoted = seeded.rows.find((r) => r.vote === null && r.cellIndex === 0 && r.documentId !== null) as SeededRow;
      await db.query("UPDATE public.rag_retrieval_log SET feedback_vote = -1, feedback_kind = 'answer' WHERE trace_id = $1", [unvoted.traceId]);
      const cell = spec[0] as SeedCell;
      const key = cellKey({ tenant_key: cell.tenantKey, language: cell.language as string, rag_mode: 'strict', channel: cell.channel, doc_type: cell.docType as string });
      assert.equal(await aggregate(db), spec.length * 2);
      const third = await cells(db);
      assert.equal((third.get(key) as CellRow).not_helpful, (first.get(key) as CellRow).not_helpful + 1);
      for (const [other, row] of third) {
        if (other !== key) assert.equal(row.not_helpful, (first.get(other) as CellRow).not_helpful, other);
      }
    });

    test('judge scores and groundedness flags of another tenant under the same trace id never count', async () => {
      const [own] = keys as [string];
      const { rows } = await seedRetrievalLog(db, {
        seed: `foreign-${mode}`,
        cells: [{ tenantKey: own, day: DAY, language: 'en', ragMode: 'strict', channel: 'chat', rows: 5 }],
      });
      const foreign = mode === 'single-tenant' ? `o:${crypto.randomUUID()}` : `u:${crypto.randomUUID()}`;
      const traceId = (rows[0] as SeededRow).traceId;
      await db.query(
        "INSERT INTO public.rag_online_judge_scores (tenant_key, trace_id, metric, score, judge_id) VALUES ($1, $2, 'faithfulness', 1, 'seed-judge')",
        [foreign, traceId],
      );
      if (mode === 'multi-tenant') {
        const otherUser = foreign.slice(2);
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'other@example.invalid')", [otherUser]);
        await db.query(
          `INSERT INTO public.rag_answer_records (id, user_id, trace_id, rag_mode, groundedness)
           VALUES ($1, $2, $3, 'strict', '{"label":"possibly_unreliable"}'::jsonb)`,
          [crypto.randomUUID(), otherUser, traceId],
        );
      }
      await aggregate(db);
      const stored = [...(await cells(db)).values()];
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.tenant_key, own);
      assert.equal(stored[0]?.judged, 0);
      assert.equal(stored[0]?.groundedness_flagged, 0);
    });

    test('UTC day boundaries: 23:59:59 counts for its day, 00:00:00 for the next', async () => {
      const [own] = keys as [string];
      await seedRetrievalLog(db, {
        seed: `edges-${mode}`,
        cells: [
          { tenantKey: own, day: DAY, language: 'en', ragMode: 'strict', channel: 'chat', rows: 1, startSecond: 86_399 },
          { tenantKey: own, day: DAY, language: 'en', ragMode: 'strict', channel: 'chat', rows: 1, startSecond: 86_400 },
          { tenantKey: own, day: DAY, language: 'en', ragMode: 'strict', channel: 'chat', rows: 1, startSecond: 0 },
        ],
      });
      await aggregate(db, DAY);
      await aggregate(db, nextDay(DAY));
      const today = [...(await cells(db, DAY)).values()];
      const tomorrow = [...(await cells(db, nextDay(DAY))).values()];
      assert.equal(today.length, 1);
      assert.equal(today[0]?.retrievals, 2);
      assert.equal(tomorrow.length, 1);
      assert.equal(tomorrow[0]?.retrievals, 1);
    });

    test('a deleted document gives doc_type unknown; a null mode gives unknown and a null language und', async () => {
      const [own] = keys as [string];
      const { rows } = await seedRetrievalLog(db, {
        seed: `unknown-${mode}`,
        cells: [
          { tenantKey: own, day: DAY, language: 'en', ragMode: 'strict', channel: 'chat', rows: 3, docType: 'invoice_receipt' },
          { tenantKey: own, day: DAY, language: null, ragMode: null, channel: 'embed', rows: 2, docType: 'general' },
        ],
      });
      const deleted = rows.find((r) => r.cellIndex === 0)?.documentId as string;
      await db.query('DELETE FROM public.documents WHERE id = $1', [deleted]);
      await aggregate(db);
      const stored = await cells(db);
      assert.equal(stored.get(cellKey({ tenant_key: own, language: 'en', rag_mode: 'strict', channel: 'chat', doc_type: 'unknown' }))?.retrievals, 3);
      assert.equal(stored.get(cellKey({ tenant_key: own, language: 'und', rag_mode: 'unknown', channel: 'embed', doc_type: 'general' }))?.retrievals, 2);
      assert.equal(stored.size, 2);
    });

    test('top scores are kept per score kind; a score above 1 lands in the overflow bin', async () => {
      const [own] = keys as [string];
      await seedRetrievalLog(db, {
        seed: `kinds-${mode}`,
        cells: [
          { tenantKey: own, day: DAY, language: 'en', ragMode: 'strict', channel: 'chat', rows: 1, topScore: { kind: 'rerank', mean: 0.42, spread: 0 } },
          { tenantKey: own, day: DAY, language: 'en', ragMode: 'strict', channel: 'chat', rows: 1, topScore: { kind: 'similarity', mean: 0.81, spread: 0 } },
          { tenantKey: own, day: DAY, language: 'en', ragMode: 'strict', channel: 'chat', rows: 1, topScore: { kind: 'rerank', mean: 7.5, spread: 0 } },
        ],
      });
      await aggregate(db);
      const [cell] = [...(await cells(db)).values()];
      const rerank = zeros();
      rerank[scoreBin(0.42)] = 1;
      rerank[21] = 1;
      const similarity = zeros();
      similarity[scoreBin(0.81)] = 1;
      assert.deepEqual(cell?.top_score_hist, { rerank, similarity });
      assert.equal(scoreBin(0.42), 9);
      assert.equal(scoreBin(0.81), 17);
    });

    test('rag_monitor_days_to_aggregate returns the trailing days and older days that have log rows but no cell', async () => {
      const [own] = keys as [string];
      const missed = utcDaysAgo(12);
      const done = utcDaysAgo(15);
      await seedRetrievalLog(db, {
        seed: `days-${mode}`,
        cells: [
          { tenantKey: own, day: missed, language: 'en', ragMode: 'strict', channel: 'chat', rows: 2 },
          { tenantKey: own, day: done, language: 'en', ragMode: 'strict', channel: 'chat', rows: 2 },
        ],
      });
      await aggregate(db, done);
      const days = (await db.query<{ d: string }>('SELECT d::text AS d FROM public.rag_monitor_days_to_aggregate(7) AS d')).rows.map((r) => r.d);
      const trailing = Array.from({ length: 7 }, (_, i) => utcDaysAgo(7 - i));
      assert.deepEqual(days, [missed, ...trailing]);
      await aggregate(db, missed);
      const after = (await db.query<{ d: string }>('SELECT d::text AS d FROM public.rag_monitor_days_to_aggregate(7) AS d')).rows.map((r) => r.d);
      assert.deepEqual(after, trailing);
    });

    test('anon and authenticated cannot execute either function', async () => {
      for (const role of ['anon', 'authenticated']) {
        for (const call of ["SELECT public.rag_monitor_aggregate('2026-03-10'::date)", 'SELECT * FROM public.rag_monitor_days_to_aggregate(7)']) {
          await db.exec(`SET ROLE ${role}`);
          try {
            await assert.rejects(db.query(call), (error: unknown) => {
              assert.equal(sqlState(error), '42501', String((error as Error).message));
              return true;
            });
          } finally {
            await db.exec('RESET ROLE');
          }
        }
      }
    });

    test('without rag_retrieval_log the file applies and the aggregate writes nothing', async () => {
      await db.exec('DROP TABLE public.rag_retrieval_log CASCADE');
      await db.exec(MIGRATION);
      assert.equal(await aggregate(db), 0);
      assert.deepEqual((await db.query('SELECT * FROM public.rag_monitor_days_to_aggregate(7)')).rows, []);
    });
  });
}
