import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const TOKEN = 'effdateprobe';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const D = '2025-03-15';

type Leg = 'dense' | 'lexical';
type Row = { leg: Leg; rank: number; chunk_id: string; dense_mode: string };

const WINDOWS = {
  fromOnD: { from: D, to: null },
  toOnD: { from: null, to: D },
  fromDayAfter: { from: '2025-03-16', to: null },
  toDayBefore: { from: null, to: '2025-03-14' },
  onlyFrom: { from: '2025-01-01', to: null },
  onlyTo: { from: null, to: '2025-12-31' },
  bothNull: { from: null, to: null },
  around: { from: '2025-03-10', to: '2025-03-20' },
  singleDay: { from: D, to: D },
  past: { from: '2024-01-01', to: '2024-12-31' },
} as const;
type Label = keyof typeof WINDOWS;

const MATCH_ON_D: Label[] = ['fromOnD', 'toOnD', 'onlyFrom', 'onlyTo', 'bothNull', 'around', 'singleDay'];

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

async function search(db: PGlite, docIds: string[], tenantKey: string, effectiveOn: string | null, exactCutoff = 0): Promise<Row[]> {
  return (
    await db.query<Row>(
      `SELECT leg, rank, chunk_id::text, dense_mode
       FROM hybrid_search_chunks(
         p_tenant_key => $1, p_profile_id => $2,
         p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
         p_dense_limit => 50, p_lexical_limit => 50, p_document_ids => $5::uuid[],
         p_exact_scan_cutoff => $6, p_effective_on => $7::date
       ) ORDER BY leg, rank`,
      [tenantKey, LEGACY, vec(`${TOKEN} query`), [TOKEN], docIds, exactCutoff, effectiveOn],
    )
  ).rows;
}

function idsOf(rows: Row[], leg: Leg): Set<string> {
  return new Set(rows.filter((row) => row.leg === leg).map((row) => row.chunk_id));
}

async function seedTenant(db: PGlite, userId: string, tenantKey: string, docIds: string[], labels: Label[]): Promise<Record<Label, string>> {
  const out = {} as Record<Label, string>;
  for (const label of labels) {
    const docId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    const text = `${TOKEN} ${label} neutral sample sentence`;
    const { from, to } = WINDOWS[label];
    await db.query(
      `INSERT INTO documents (id, filename, content, user_id, effective_from, effective_to, is_current, status)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, true, 'ready')`,
      [docId, `${label}.md`, text, userId, from, to],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, effective_from, effective_to, is_current, status)
       VALUES ($1, $2, $3, $4::vector, $3, $5, $6::date, $7::date, true, 'ready')`,
      [chunkId, docId, text, vec(text), tenantKey, from, to],
    );
    out[label] = chunkId;
    docIds.push(docId);
  }
  return out;
}

describe('hybrid_search_chunks p_effective_on (0802, D-44)', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;
  let a: Record<Label, string>;
  let b: Record<Label, string>;
  const docIds: string[] = [];

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
    a = await seedTenant(db, TWO_TENANT_IDS.userA, TENANT_A, docIds, Object.keys(WINDOWS) as Label[]);
    b = await seedTenant(db, TWO_TENANT_IDS.userB, TENANT_B, docIds, ['bothNull', 'fromOnD']);
  });

  after(async () => {
    await db.close();
  });

  for (const leg of ['dense', 'lexical'] as const) {
    test(`${leg} leg: inclusive bounds on D; the day after the end and the day before the start do not match`, async () => {
      const got = idsOf(await search(db, docIds, TENANT_A, D), leg);
      assert.deepEqual(got, new Set(MATCH_ON_D.map((label) => a[label])));
      assert.ok(!got.has(a.fromDayAfter), 'effective_from = D + 1');
      assert.ok(!got.has(a.toDayBefore), 'effective_to = D - 1');
      assert.ok(got.has(a.bothNull), 'both dates null always pass');
    });

    test(`${leg} leg: p_effective_on NULL returns every chunk`, async () => {
      const got = idsOf(await search(db, docIds, TENANT_A, null), leg);
      assert.deepEqual(got, new Set(Object.values(a)));
    });

    test(`${leg} leg: tenant A never receives tenant B's chunks whatever the date`, async () => {
      const foreign = new Set(Object.values(b));
      for (const on of [D, null, '1900-01-01', '2999-12-31']) {
        const got = idsOf(await search(db, docIds, TENANT_A, on), leg);
        assert.ok(![...got].some((id) => foreign.has(id)), String(on));
      }
      assert.deepEqual(idsOf(await search(db, docIds, TENANT_B, D), leg), new Set([b.bothNull, b.fromOnD]));
    });
  }

  test('the exact-count probe applies the date predicate', async () => {
    const n = MATCH_ON_D.length;
    const exact = await search(db, docIds, TENANT_A, D, n);
    assert.ok(exact.filter((row) => row.leg === 'dense').every((row) => row.dense_mode === 'exact'));
    assert.deepEqual(idsOf(exact, 'dense'), new Set(MATCH_ON_D.map((label) => a[label])));
    const ann = await search(db, docIds, TENANT_A, D, n - 1);
    assert.ok(ann.filter((row) => row.leg === 'dense').every((row) => row.dense_mode === 'ann'));
  });

  test('the date does not bypass the tenant key guard', async () => {
    await assert.rejects(
      () => search(db, docIds, 'x:1', D),
      (error: unknown) => codeOf(error) === '22023',
    );
  });
});
