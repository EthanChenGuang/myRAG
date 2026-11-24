import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';

type Row = Record<string, unknown>;

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

interface SearchOpts {
  tenantKey: string;
  tokens?: string[];
  denseLimit?: number;
  lexicalLimit?: number;
  p_date_from?: string;
  p_date_to?: string;
  p_sources?: string[];
  p_document_ids?: string[];
  p_doc_types?: string[];
  p_languages?: string[];
  p_lexical_languages?: string[];
  p_supplier?: string;
  p_amount_min?: number;
  p_amount_max?: number;
  p_currency?: string;
  p_chunking_override?: Record<string, string>;
}

async function search(db: TwoTenantDatabase['db'], args: SearchOpts): Promise<Row[]> {
  const {
    tenantKey,
    tokens = ['filter-term'],
    denseLimit = 10,
    lexicalLimit = 10,
    p_date_from = null,
    p_date_to = null,
    p_sources = null,
    p_document_ids = null,
    p_doc_types = null,
    p_languages = null,
    p_lexical_languages = null,
    p_supplier = null,
    p_amount_min = null,
    p_amount_max = null,
    p_currency = null,
    p_chunking_override = null,
  } = args;
  return (
    await db.query<Row>(
      `SELECT leg, rank, chunk_id::text, document_id::text, similarity, dense_mode, language
       FROM hybrid_search_chunks(
         p_tenant_key => $1, p_profile_id => $2,
         p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
         p_dense_limit => $5, p_lexical_limit => $6,
         p_date_from => $7, p_date_to => $8, p_sources => $9, p_document_ids => $10::uuid[],
         p_doc_types => $11, p_languages => $12, p_iterative_scan => 'off', p_exact_scan_cutoff => 0,
         p_lexical_languages => $13, p_supplier => $14, p_amount_min => $15, p_amount_max => $16,
         p_currency => $17, p_chunking_override => $18::jsonb
       ) ORDER BY leg, rank`,
      [
        tenantKey,
        LEGACY,
        vec('filter-term query'),
        tokens,
        denseLimit,
        lexicalLimit,
        p_date_from,
        p_date_to,
        p_sources,
        p_document_ids,
        p_doc_types,
        p_languages,
        p_lexical_languages,
        p_supplier,
        p_amount_min,
        p_amount_max,
        p_currency,
        p_chunking_override ? JSON.stringify(p_chunking_override) : null,
      ],
    )
  ).rows;
}

describe('hybrid_search_chunks filters (D-05, DATA-08, DATA-09)', () => {
  let fixture: TwoTenantDatabase;
  let db: TwoTenantDatabase['db'];
  const tenant = `u:${TWO_TENANT_IDS.userA}`;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
  });

  after(async () => {
    await db.close();
  });

  test('p_sources empty array returns no rows', async () => {
    const rows = await search(db, { tenantKey: tenant, p_sources: [] });
    assert.equal(rows.length, 0);
  });

  test('foreign document id filter returns nothing', async () => {
    const rows = await search(db, { tenantKey: tenant, p_document_ids: [TWO_TENANT_IDS.docB] });
    assert.equal(rows.length, 0);
  });

  test('date range excludes rows with null doc_date', async () => {
    const docId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    await db.query(
      'INSERT INTO documents (id, filename, content, user_id, doc_date, is_current, status) VALUES ($1, $2, $3, $4, NULL, true, $5)',
      [docId, 'undated.md', 'filter-term undated body', TWO_TENANT_IDS.userA, 'ready'],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, source, doc_date)
       VALUES ($1, $2, $3, $4::vector, $3, $5, true, 'ready', 'manual', NULL)`,
      [chunkId, docId, 'filter-term undated body', vec('filter-term undated body'), tenant],
    );
    const rows = await search(db, {
      tenantKey: tenant,
      tokens: ['filter-term'],
      p_date_from: '2024-01-01',
      p_date_to: '2024-12-31',
    });
    assert.ok(!rows.some((row) => row.chunk_id === chunkId));
  });

  test('supplier substring and tax id plus amount and currency filters narrow both legs', async () => {
    const docId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    await db.query(
      `INSERT INTO documents (id, filename, content, user_id, supplier_name, supplier_tax_id, gross_total, currency, is_current, status, doc_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, 'ready', 'invoice_receipt')`,
      [docId, 'inv.md', 'filter-term ACME invoice', TWO_TENANT_IDS.userA, 'Acme Supplies Ltd', 'TAX-123', 1500.5, 'USD'],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, doc_type, is_current, status)
       VALUES ($1, $2, $3, $4::vector, $3, $5, 'invoice_receipt', true, 'ready')`,
      [chunkId, docId, 'filter-term ACME invoice', vec('filter-term ACME invoice'), tenant],
    );
    const hit = await search(db, {
      tenantKey: tenant,
      tokens: ['acme'],
      p_supplier: 'acme',
      p_amount_min: 1000,
      p_amount_max: 2000,
      p_currency: 'USD',
    });
    assert.ok(hit.length >= 1);
    assert.ok(hit.every((row) => row.document_id === docId));
  });

  test('p_lexical_languages restricts only the lexical leg', async () => {
    const itDoc = crypto.randomUUID();
    const itChunk = crypto.randomUUID();
    const enDoc = crypto.randomUUID();
    const enChunk = crypto.randomUUID();
    const text = 'filter-term lingua condivisa';
    await db.query('INSERT INTO documents (id, filename, content, user_id, language, is_current, status) VALUES ($1, $2, $3, $4, $5, true, $6)', [
      itDoc,
      'it.md',
      text,
      TWO_TENANT_IDS.userA,
      'it',
      'ready',
    ]);
    await db.query('INSERT INTO documents (id, filename, content, user_id, language, is_current, status) VALUES ($1, $2, $3, $4, $5, true, $6)', [
      enDoc,
      'en.md',
      text,
      TWO_TENANT_IDS.userA,
      'en',
      'ready',
    ]);
    for (const [chunkId, docId, lang] of [
      [itChunk, itDoc, 'it'],
      [enChunk, enDoc, 'en'],
    ] as const) {
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, language, is_current, status)
         VALUES ($1, $2, $3, $4::vector, $3, $5, $6, true, 'ready')`,
        [chunkId, docId, text, vec(text), tenant, lang],
      );
    }
    const rows = await search(db, { tenantKey: tenant, tokens: ['condivisa'], p_lexical_languages: ['it'] });
    const lexical = rows.filter((row) => row.leg === 'lexical');
    const dense = rows.filter((row) => row.leg === 'dense');
    assert.ok(lexical.every((row) => row.language === 'it'));
    assert.ok(dense.some((row) => row.language === 'en'));
  });

  test('p_chunking_override serves p256 children for one doc type and rejects unknown profiles', async () => {
    await db.query(
      `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
       VALUES ('p256', 'contract_legal', 256, 'none', NULL, 'ready', '256/1024')
       ON CONFLICT (id, doc_type) DO NOTHING`,
    );
    const docId = crypto.randomUUID();
    const legacyChunk = crypto.randomUUID();
    const childChunk = crypto.randomUUID();
    const body = 'filter-term override contract';
    await db.query(
      'INSERT INTO documents (id, filename, content, user_id, is_current, status, doc_type) VALUES ($1, $2, $3, $4, true, $5, $6)',
      [docId, 'c.md', body, TWO_TENANT_IDS.userA, 'ready', 'contract_legal'],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, doc_type, is_current, status, chunking_profile_id)
       VALUES ($1, $2, $3, $4::vector, $3, $5, 'contract_legal', true, 'ready', 'legacy')`,
      [legacyChunk, docId, body, vec(body), tenant],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, doc_type, is_current, status, chunking_profile_id)
       VALUES ($1, $2, $3, $4::vector, $3, $5, 'contract_legal', true, 'variant', 'p256')`,
      [childChunk, docId, `${body} variant`, vec(`${body} variant`), tenant],
    );
    const rows = await search(db, {
      tenantKey: tenant,
      tokens: ['override'],
      p_chunking_override: { contract_legal: 'p256' },
    });
    const ids = rows.map((row) => row.chunk_id);
    assert.ok(ids.includes(childChunk));
    assert.ok(!ids.includes(legacyChunk));
    await assert.rejects(
      () => search(db, { tenantKey: tenant, p_chunking_override: { contract_legal: 'no-such' } }),
      (error: unknown) => codeOf(error) === '22023',
    );
  });

  test('legacy fallback for a document missing from the active profile', async () => {
    await db.query(`UPDATE chunking_profiles SET status = 'retired' WHERE doc_type = 'contract_legal' AND id = 'legacy'`);
    await db.query(
      `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
       VALUES ('p256', 'contract_legal', 256, 'none', NULL, 'active', '256/1024')
       ON CONFLICT (id, doc_type) DO UPDATE SET status = 'active'`,
    );
    const c1 = crypto.randomUUID();
    const c2 = crypto.randomUUID();
    const c1p = crypto.randomUUID();
    const c2legacy = crypto.randomUUID();
    const c2dup = crypto.randomUUID();
    const c1Body = 'filter-term contract-one-alpha';
    const c2Body = 'filter-term legacy-fallback-only-c2';
    await db.query(
      'INSERT INTO documents (id, filename, content, user_id, is_current, status, doc_type, doc_date) VALUES ($1, $2, $3, $4, true, $5, $6, $7)',
      [c1, 'c1.md', c1Body, TWO_TENANT_IDS.userA, 'ready', 'contract_legal', '2024-06-01'],
    );
    await db.query(
      'INSERT INTO documents (id, filename, content, user_id, is_current, status, doc_type, doc_date) VALUES ($1, $2, $3, $4, true, $5, $6, $7)',
      [c2, 'c2.md', c2Body, TWO_TENANT_IDS.userA, 'ready', 'contract_legal', '2024-07-01'],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, doc_type, doc_date, is_current, status, chunking_profile_id)
       VALUES ($1, $2, $3, $4::vector, $3, $5, 'contract_legal', '2024-06-01', true, 'variant', 'p256')`,
      [c1p, c1, c1Body, vec(c1Body), tenant],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, doc_type, doc_date, is_current, status, chunking_profile_id)
       VALUES ($1, $2, $3, $4::vector, $3, $5, 'contract_legal', '2024-07-01', true, 'ready', 'legacy')`,
      [c2legacy, c2, c2Body, vec(c2Body), tenant],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, doc_type, doc_date, is_current, status, chunking_profile_id)
       VALUES ($1, $2, $3, $4::vector, $3, $5, 'contract_legal', '2024-07-01', false, 'variant', 'p256')`,
      [c2dup, c2, c2Body, vec(c2Body), tenant],
    );

    const lexical = await search(db, { tenantKey: tenant, tokens: ['legacy-fallback-only-c2'], denseLimit: 0, lexicalLimit: 10 });
    assert.ok(lexical.some((row) => row.chunk_id === c2legacy));
    assert.ok(!lexical.some((row) => row.chunk_id === c1p));

    const dense = await search(db, { tenantKey: tenant, tokens: [], denseLimit: 10, lexicalLimit: 0 });
    assert.ok(dense.some((row) => row.document_id === c2));

    const narrowed = await search(db, {
      tenantKey: tenant,
      tokens: ['legacy-fallback-only-c2'],
      p_document_ids: [c2],
      denseLimit: 0,
      lexicalLimit: 10,
    });
    assert.ok(narrowed.every((row) => row.document_id === c2));

    const dated = await search(db, {
      tenantKey: tenant,
      tokens: ['legacy-fallback-only-c2'],
      p_date_from: '2024-07-01',
      p_date_to: '2024-07-31',
      denseLimit: 0,
      lexicalLimit: 10,
    });
    assert.ok(dated.some((row) => row.chunk_id === c2legacy));
    assert.ok(!dated.some((row) => row.document_id === c1));
  });
});