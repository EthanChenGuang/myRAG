import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY = 'openai-3-small-1536';
const TOKEN = 'undatedprobe';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const RANGE = { from: '2024-01-01', to: '2024-12-31' };

type Leg = 'dense' | 'lexical';
type Row = { leg: Leg; rank: number; chunk_id: string; similarity: number | null; lexical_score: number | null };

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

interface Call {
  tenantKey: string;
  from?: string | null;
  to?: string | null;
  includeUndated?: boolean | null;
}

async function search(db: PGlite, call: Call): Promise<Row[]> {
  const flag = call.includeUndated === undefined ? '' : ', p_include_undated => $9::boolean';
  const params: unknown[] = [call.tenantKey, LEGACY, vec(`${TOKEN} query`), [TOKEN], 50, 50, call.from ?? null, call.to ?? null];
  if (call.includeUndated !== undefined) params.push(call.includeUndated);
  return (
    await db.query<Row>(
      `SELECT leg, rank, chunk_id::text, similarity, lexical_score
       FROM hybrid_search_chunks(
         p_tenant_key => $1, p_profile_id => $2,
         p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
         p_dense_limit => $5, p_lexical_limit => $6,
         p_date_from => $7::date, p_date_to => $8::date${flag}
       ) ORDER BY leg, rank`,
      params,
    )
  ).rows;
}

function idsOf(rows: Row[], leg: Leg): string[] {
  return rows.filter((row) => row.leg === leg).map((row) => row.chunk_id);
}

interface Seeded {
  inRange: string;
  outOfRange: string;
  undatedA: string;
  undatedB: string;
}

async function seedChunk(db: PGlite, userId: string, tenantKey: string, docDate: string | null, label: string): Promise<string> {
  const docId = crypto.randomUUID();
  const chunkId = crypto.randomUUID();
  const text = `${TOKEN} ${label} body`;
  await db.query(
    'INSERT INTO documents (id, filename, content, user_id, doc_date, is_current, status) VALUES ($1, $2, $3, $4, $5::date, true, $6)',
    [docId, `${label}.md`, text, userId, docDate, 'ready'],
  );
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, source, doc_date)
     VALUES ($1, $2, $3, $4::vector, $3, $5, true, 'ready', 'manual', $6::date)`,
    [chunkId, docId, text, vec(text), tenantKey, docDate],
  );
  return chunkId;
}

async function seed(db: PGlite): Promise<Seeded> {
  return {
    inRange: await seedChunk(db, TWO_TENANT_IDS.userA, TENANT_A, '2024-06-01', 'in-range'),
    outOfRange: await seedChunk(db, TWO_TENANT_IDS.userA, TENANT_A, '2023-01-01', 'out-of-range'),
    undatedA: await seedChunk(db, TWO_TENANT_IDS.userA, TENANT_A, null, 'undated-a'),
    undatedB: await seedChunk(db, TWO_TENANT_IDS.userB, TENANT_B, null, 'undated-b'),
  };
}

describe('hybrid_search_chunks p_include_undated (0602, D-11)', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;
  let ids: Seeded;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
    ids = await seed(db);
  });

  after(async () => {
    await db.close();
  });

  test('exactly one hybrid_search_chunks function exists and it takes p_include_undated boolean after p_chunking_override', async () => {
    const rows = (
      await db.query<{ args: string }>(
        `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'hybrid_search_chunks'`,
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.match(rows[0]?.args ?? '', /p_chunking_override jsonb, p_include_undated boolean(, |$)/);
  });

  for (const leg of ['dense', 'lexical'] as const) {
    test(`${leg} leg: a date range with the flag keeps the in-range and the undated chunk, never the out-of-range one`, async () => {
      const got = idsOf(await search(db, { tenantKey: TENANT_A, ...RANGE, includeUndated: true }), leg);
      assert.ok(got.includes(ids.inRange), 'in-range dated chunk');
      assert.ok(got.includes(ids.undatedA), 'undated chunk');
      assert.ok(!got.includes(ids.outOfRange), 'out-of-range dated chunk');
    });

    test(`${leg} leg: the flag false or omitted drops the undated chunk`, async () => {
      for (const includeUndated of [false, undefined, null] as const) {
        const got = idsOf(await search(db, { tenantKey: TENANT_A, ...RANGE, includeUndated }), leg);
        assert.ok(got.includes(ids.inRange), `in-range (${String(includeUndated)})`);
        assert.ok(!got.includes(ids.undatedA), `undated (${String(includeUndated)})`);
        assert.ok(!got.includes(ids.outOfRange), `out-of-range (${String(includeUndated)})`);
      }
    });

    test(`${leg} leg: an open-ended range with the flag keeps undated rows and applies the bound to dated ones`, async () => {
      const fromOnly = idsOf(await search(db, { tenantKey: TENANT_A, from: RANGE.from, includeUndated: true }), leg);
      assert.ok(fromOnly.includes(ids.undatedA) && fromOnly.includes(ids.inRange) && !fromOnly.includes(ids.outOfRange));
      const toOnly = idsOf(await search(db, { tenantKey: TENANT_A, to: '2023-06-30', includeUndated: true }), leg);
      assert.ok(toOnly.includes(ids.undatedA) && toOnly.includes(ids.outOfRange) && !toOnly.includes(ids.inRange));
    });

    test(`${leg} leg: with the flag, tenant A never receives tenant B's undated chunk`, async () => {
      const gotA = idsOf(await search(db, { tenantKey: TENANT_A, ...RANGE, includeUndated: true }), leg);
      assert.ok(!gotA.includes(ids.undatedB));
      assert.ok(!gotA.includes(TWO_TENANT_IDS.chunkB));
      const gotB = idsOf(await search(db, { tenantKey: TENANT_B, ...RANGE, includeUndated: true }), leg);
      assert.ok(gotB.includes(ids.undatedB));
      assert.ok(gotB.every((id) => id === ids.undatedB || id === TWO_TENANT_IDS.chunkB), 'B sees only its own rows');
    });
  }

  test('without a date range the flag changes nothing', async () => {
    const off = await search(db, { tenantKey: TENANT_A, includeUndated: false });
    const on = await search(db, { tenantKey: TENANT_A, includeUndated: true });
    assert.deepEqual(on, off);
    assert.ok(idsOf(off, 'dense').includes(ids.undatedA));
  });

  test('the flag does not bypass the tenant key guard', async () => {
    await assert.rejects(
      () => search(db, { tenantKey: 'x:1', ...RANGE, includeUndated: true }),
      (error: unknown) => codeOf(error) === '22023',
    );
  });
});

describe('hybrid_search_chunks without the flag equals the Phase 4 function', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
    await seed(db);
  });

  after(async () => {
    await db.close();
  });

  test('same rows for the same inputs, with and without a date range', async () => {
    const calls: Call[] = [
      { tenantKey: TENANT_A, ...RANGE },
      { tenantKey: TENANT_A, from: RANGE.from },
      { tenantKey: TENANT_A },
      { tenantKey: TENANT_B, ...RANGE },
    ];
    const current: Row[][] = [];
    for (const call of calls) {
      current.push(await search(db, { ...call, includeUndated: false }));
      assert.deepEqual(await search(db, call), current.at(-1));
    }

    const sig =
      'text, text, vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer, text[], text, numeric, numeric, text, jsonb, boolean, text[], boolean, date';
    await db.exec(`DROP FUNCTION public.hybrid_search_chunks(${sig})`);
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0407_hybrid_search_chunks.sql'), 'utf8'));
    try {
      for (const [index, call] of calls.entries()) {
        assert.deepEqual(await search(db, call), current[index], `call ${index}`);
      }
    } finally {
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0802_hybrid_search_scopes_dates_und.sql'), 'utf8'));
    }
    const count = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'hybrid_search_chunks'");
    assert.equal(count.rows[0]?.n, 1, 're-applying 0802 on top of 0407 leaves one function');
  });
});
