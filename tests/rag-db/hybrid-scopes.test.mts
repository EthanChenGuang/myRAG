import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const TOKEN = 'scopeprobe';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const A = 'region:r-one';
const B = 'region:r-two';
const C = 'department:d-three';

type Leg = 'dense' | 'lexical';
type Row = { leg: Leg; rank: number; chunk_id: string; dense_mode: string };
type Label = 'tagA' | 'tagB' | 'tagAC' | 'untagged';

const TAGS: Record<Label, string[]> = { tagA: [A], tagB: [B], tagAC: [A, C], untagged: [] };

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

function messageOf(error: unknown): string {
  return String((error as { message?: string }).message ?? '');
}

interface Call {
  tenantKey: string;
  scopes?: string[] | null;
  includeUntagged?: boolean | null;
  exactCutoff?: number;
  denseLimit?: number;
  lexicalLimit?: number;
}

interface Seeded {
  a: Record<Label, string>;
  b: Record<Label, string>;
  docIds: string[];
}

async function search(db: PGlite, docIds: string[], call: Call): Promise<Row[]> {
  return (
    await db.query<Row>(
      `SELECT leg, rank, chunk_id::text, dense_mode
       FROM hybrid_search_chunks(
         p_tenant_key => $1, p_profile_id => $2,
         p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
         p_dense_limit => $5, p_lexical_limit => $6, p_document_ids => $7::uuid[],
         p_exact_scan_cutoff => $8, p_scopes => $9::text[], p_scopes_include_untagged => $10::boolean
       ) ORDER BY leg, rank`,
      [
        call.tenantKey,
        LEGACY,
        vec(`${TOKEN} query`),
        [TOKEN],
        call.denseLimit ?? 50,
        call.lexicalLimit ?? 50,
        docIds,
        call.exactCutoff ?? 0,
        call.scopes === undefined ? null : call.scopes,
        call.includeUntagged === undefined ? false : call.includeUntagged,
      ],
    )
  ).rows;
}

function idsOf(rows: Row[], leg: Leg): Set<string> {
  return new Set(rows.filter((row) => row.leg === leg).map((row) => row.chunk_id));
}

async function seedTenant(db: PGlite, userId: string, tenantKey: string, docIds: string[]): Promise<Record<Label, string>> {
  const out = {} as Record<Label, string>;
  for (const label of Object.keys(TAGS) as Label[]) {
    const docId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    const text = `${TOKEN} ${label} neutral sample sentence`;
    await db.query(
      'INSERT INTO documents (id, filename, content, user_id, scopes, is_current, status) VALUES ($1, $2, $3, $4, $5::text[], true, $6)',
      [docId, `${label}.md`, text, userId, TAGS[label], 'ready'],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, scopes, is_current, status)
       VALUES ($1, $2, $3, $4::vector, $3, $5, $6::text[], true, 'ready')`,
      [chunkId, docId, text, vec(text), tenantKey, TAGS[label]],
    );
    out[label] = chunkId;
    docIds.push(docId);
  }
  return out;
}

describe('hybrid_search_chunks p_scopes (0802, D-39)', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;
  let ids: Seeded;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
    const docIds: string[] = [];
    const a = await seedTenant(db, TWO_TENANT_IDS.userA, TENANT_A, docIds);
    const b = await seedTenant(db, TWO_TENANT_IDS.userB, TENANT_B, docIds);
    ids = { a, b, docIds };
  });

  after(async () => {
    await db.close();
  });

  const expectA = (...labels: Label[]): Set<string> => new Set(labels.map((label) => ids.a[label]));

  const cases: { name: string; scopes: string[] | null; untagged: boolean; expected: Label[] }[] = [
    { name: 'no filter', scopes: null, untagged: false, expected: ['tagA', 'tagB', 'tagAC', 'untagged'] },
    { name: 'an empty array equals no filter', scopes: [], untagged: false, expected: ['tagA', 'tagB', 'tagAC', 'untagged'] },
    { name: 'an empty array with include-untagged equals no filter', scopes: [], untagged: true, expected: ['tagA', 'tagB', 'tagAC', 'untagged'] },
    { name: 'A returns the two chunks tagged A', scopes: [A], untagged: false, expected: ['tagA', 'tagAC'] },
    { name: 'A and B (one dimension) are OR', scopes: [A, B], untagged: false, expected: ['tagA', 'tagB', 'tagAC'] },
    { name: 'A and C (two dimensions) are AND', scopes: [A, C], untagged: false, expected: ['tagAC'] },
    { name: 'A with include-untagged adds the untagged chunk', scopes: [A], untagged: true, expected: ['tagA', 'tagAC', 'untagged'] },
    { name: 'A and B with include-untagged adds the untagged chunk', scopes: [A, B], untagged: true, expected: ['tagA', 'tagB', 'tagAC', 'untagged'] },
    {
      name: 'A and C with include-untagged admits chunks without a tag in a filtered dimension',
      scopes: [A, C],
      untagged: true,
      expected: ['tagA', 'tagAC', 'untagged'],
    },
    { name: 'a duplicated tag changes nothing', scopes: [A, A], untagged: false, expected: ['tagA', 'tagAC'] },
  ];

  for (const testCase of cases) {
    test(`${testCase.name}: dense and lexical legs agree and tenant B never appears`, async () => {
      const rows = await search(db, ids.docIds, { tenantKey: TENANT_A, scopes: testCase.scopes, includeUntagged: testCase.untagged });
      const expected = expectA(...testCase.expected);
      assert.deepEqual(idsOf(rows, 'dense'), expected, 'dense');
      assert.deepEqual(idsOf(rows, 'lexical'), expected, 'lexical');
      const foreign = new Set(Object.values(ids.b));
      assert.ok(!rows.some((row) => foreign.has(row.chunk_id)), 'no tenant B chunk');
    });
  }

  test('the exact-count probe counts the same rows as the legs', async () => {
    for (const testCase of cases) {
      const n = testCase.expected.length;
      const exact = await search(db, ids.docIds, {
        tenantKey: TENANT_A,
        scopes: testCase.scopes,
        includeUntagged: testCase.untagged,
        exactCutoff: n,
        lexicalLimit: 0,
      });
      assert.ok(exact.length > 0 && exact.every((row) => row.dense_mode === 'exact'), `${testCase.name}: exact at cutoff ${n}`);
      assert.deepEqual(idsOf(exact, 'dense'), expectA(...testCase.expected), `${testCase.name}: exact rows`);
      if (n > 1) {
        const ann = await search(db, ids.docIds, {
          tenantKey: TENANT_A,
          scopes: testCase.scopes,
          includeUntagged: testCase.untagged,
          exactCutoff: n - 1,
          lexicalLimit: 0,
        });
        assert.ok(ann.every((row) => row.dense_mode === 'ann'), `${testCase.name}: ann at cutoff ${n - 1}`);
      }
    }
  });

  test('tenant B with the same tags sees only its own chunks', async () => {
    const rows = await search(db, ids.docIds, { tenantKey: TENANT_B, scopes: [A], includeUntagged: true });
    const expected = new Set([ids.b.tagA, ids.b.tagAC, ids.b.untagged]);
    assert.deepEqual(idsOf(rows, 'dense'), expected);
    assert.deepEqual(idsOf(rows, 'lexical'), expected);
  });

  test('a scope filter never widens across tenants without a document filter', async () => {
    const rows = (
      await db.query<{ chunk_id: string }>(
        `SELECT chunk_id::text FROM hybrid_search_chunks(
           p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
           p_dense_limit => 200, p_lexical_limit => 200, p_scopes => $5::text[], p_scopes_include_untagged => true)`,
        [TENANT_A, LEGACY, vec(`${TOKEN} query`), [TOKEN], [A, B, C]],
      )
    ).rows;
    assert.ok(rows.length > 0);
    const foreign = new Set([...Object.values(ids.b), TWO_TENANT_IDS.chunkB]);
    assert.ok(!rows.some((row) => foreign.has(row.chunk_id)));
  });

  for (const bad of [['site:x'], [A, 'site:x'], ['region'], ['region:'], [':r-one'], ['REGION:r-one'], [null]] as (string | null)[][]) {
    test(`invalid tag ${JSON.stringify(bad)} raises invalid_scope`, async () => {
      await assert.rejects(
        () => search(db, ids.docIds, { tenantKey: TENANT_A, scopes: bad as string[] }),
        (error: unknown) => codeOf(error) === '22023' && /invalid_scope/.test(messageOf(error)),
      );
    });
  }

  test('a tag string is bound as data, never as SQL', async () => {
    const rows = await search(db, ids.docIds, { tenantKey: TENANT_A, scopes: ["region:x') OR true OR ('"] });
    assert.equal(rows.length, 0);
  });

  test('the scope filter does not bypass the tenant key guard', async () => {
    await assert.rejects(
      () => search(db, ids.docIds, { tenantKey: 'x:1', scopes: [A] }),
      (error: unknown) => codeOf(error) === '22023',
    );
  });
});
