import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv } from '../../eval/harness/fake-edge.mts';
import { buildIngestFixtureDatabase } from '../../eval/harness/ingest-mode.mts';
import type { FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { findInvoices } from '@/lib/rag/retrieval/invoices';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

const CORPUS_DIR = path.join(process.cwd(), 'eval/fixtures/corpus');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'eval/fixtures/ingest/manifest.json'), 'utf8')) as {
  fixtures: Array<{
    id: string;
    doc_type: string;
    file_sha256: string;
    path: string;
    expected: Record<string, unknown>;
  }>;
};

type Row = Record<string, unknown>;
const PROFILES = ['chat', 'embed', 'voice', 'media', 'eval'] as const;
const INJECTION_IDS = ['injection-zh', 'injection-en', 'injection-it'] as const;

describe('typed ingest fixtures through buildIngestFixtureDatabase', () => {
  let fixture: FixtureDatabase;
  let scope = mintScope('single', null, null);

  before(async () => {
    fixture = await buildIngestFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR });
    Object.assign(process.env, fixtureProcessEnv(fixture.edge!.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    process.env.RAG_EXACT_ID_LOOKUP = 'true';
    const ragDeps = await import('@/lib/rag/deps');
    ragDeps.setRagDepsForTests({ embedder: async (text) => embedText(text) });
  });

  after(async () => {
    await fixture?.edge?.close();
    await fixture?.db.close();
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  const manifestEntry = (id: string) => {
    const entry = MANIFEST.fixtures.find((fixture) => fixture.id === id);
    assert.ok(entry, id);
    return entry;
  };

  const documentByFilename = async (filename: string): Promise<Row> => {
    const [row] = await rows(
      'SELECT id, filename, status, doc_type, doc_type_origin, parser_used, invoice_number, supplier_name, issue_date, gross_total, currency, metadata FROM documents WHERE filename = $1',
      [filename],
    );
    assert.ok(row, filename);
    return row;
  };

  test('each typed fixture reaches the expected status and picked doc_type', async () => {
    for (const entry of MANIFEST.fixtures) {
      const filename = path.basename(entry.path);
      const doc = await documentByFilename(filename);
      const expectedStatus = (entry.expected as { injection?: { expected_status?: string } }).injection?.expected_status ?? 'ready';
      assert.equal(doc.status, expectedStatus, `${entry.id} status`);
      assert.equal(doc.doc_type, entry.doc_type, `${entry.id} doc_type`);
      assert.equal(doc.doc_type_origin, 'picked', `${entry.id} origin`);
    }
  });

  test('LlamaParse is never called and PDF fixtures record parser_used docling', async () => {
    assert.equal(fixture.ingestLlamaParseAttempts, 0);
    const pdfs = await rows("SELECT filename, parser_used, status FROM documents WHERE filename LIKE '%.pdf'");
    assert.ok(pdfs.length >= MANIFEST.fixtures.length);
    for (const row of pdfs) {
      if (String(row.filename).startsWith('injection-')) continue;
      if (row.status === 'quarantined') continue;
      assert.equal(row.parser_used, 'docling', String(row.filename));
    }
  });

  test('sidecar parser options follow each profile (OCR full-page for scans, table mode for the financial report)', () => {
    const uploads = fixture.ingestSidecarUploads ?? [];
    assert.ok(uploads.length >= MANIFEST.fixtures.length);
    for (const entry of MANIFEST.fixtures) {
      const upload = uploads.find((row) => row.fileSha256 === entry.file_sha256);
      assert.ok(upload, `${entry.id} upload`);
      const request = upload.request as { docling?: Record<string, unknown> };
      const profile = getProcessingProfile(entry.doc_type as never);
      assert.deepEqual(request.docling, profile.parser.docling, `${entry.id} docling options`);
    }
  });

  test('every table chunk repeats the header and separator rows', async () => {
    const tableRows = await rows(
      `SELECT c.content FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.filename = 'report-zh-table.pdf' AND c.chunk_kind = 'table'`,
    );
    assert.ok(tableRows.length >= 1);
    const header = String(tableRows[0]?.content).split('\n').slice(0, 2).join('\n');
    for (const row of tableRows) assert.ok(String(row.content).startsWith(header), 'table chunk header');
  });

  test('the contract exception list is one chunk and clause pieces end with the clause heading', async () => {
    const chunks = await rows(
      `SELECT c.content, c.section_path, c.chunk_kind FROM document_chunks c
       JOIN documents d ON d.id = c.document_id WHERE d.filename = 'contract-zh.pdf' ORDER BY c.chunk_index`,
    );
    const clause = manifestEntry('contract-zh').expected.clause as { exception_quote: string; heading: string; items: string[]; lead_in: string };
    const listChunk = chunks.find(
      (chunk) => String(chunk.content).includes(clause.lead_in) && clause.items.every((item) => String(chunk.content).includes(item.replace(/^- /, ''))),
    );
    assert.ok(listChunk, 'exception list chunk');
    const clausePieces = chunks.filter((chunk) => String(chunk.content).includes('（一）'));
    assert.ok(clausePieces.length >= 1);
    for (const piece of clausePieces) {
      const sectionPath = piece.section_path as string[];
      assert.ok(sectionPath.at(-1)?.includes(clause.heading), sectionPath.join(' > '));
    }
  });

  test('quarantined injection documents are absent from runRetrieval for every profile', async () => {
    const rag = await import('@/lib/rag');
    const injectionFacts = INJECTION_IDS.map((id) => {
      const entry = manifestEntry(id);
      const injection = entry.expected.injection as { phrase: string };
      const fact = entry.expected.normal_fact;
      assert.ok(typeof fact === 'string' && fact.length > 0, `${id} normal_fact`);
      return { id, phrase: injection.phrase, fact, filename: path.basename(entry.path) };
    });
    for (const profile of PROFILES) {
      for (const item of injectionFacts) {
        const doc = await documentByFilename(item.filename);
        const result = await rag.runRetrieval({
          scope,
          query: item.fact,
          profile,
          options: { maxResults: 25, fallbackToLowerThreshold: true },
          signal: new AbortController().signal,
        });
        assert.notEqual(result.status, 'error', `${profile} ${item.id} retrieval ran (${result.reason})`);
        const dump = JSON.stringify(result);
        assert.ok(!dump.includes(item.phrase), `${profile} ${item.id} phrase`);
        assert.ok(!dump.includes(String(doc.id)), `${profile} ${item.id} document id`);
      }
    }
  });

  test('findInvoices filters zh, en and it invoices and the invoice-number question returns the exact invoice first', async () => {
    const pgliteRpc = (): RpcClient => ({
      rpc(fn, args) {
        const keys = Object.keys(args);
        const sql = `SELECT * FROM ${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
        const run = fixture.db
          .query<Row>(sql, keys.map((key) => args[key]))
          .then((result): RpcResponse => ({ data: result.rows, error: null }))
          .catch((error: unknown): RpcResponse => ({ data: null, error: { message: String(error) } }));
        const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
        return request;
      },
    });
    const deps = { db: () => pgliteRpc(), signal: new AbortController().signal };
    const zh = manifestEntry('invoice-zh').expected.invoice as { invoice_number: string; supplier: { name: string }; gross_total: string; issue_date: string };
    const en = manifestEntry('invoice-en').expected.invoice as typeof zh;
    const hitsZh = await findInvoices(
      scope,
      {
        supplier: zh.supplier.name.slice(0, 4),
        dateRange: { from: '2025-03-01', to: '2025-03-31' },
        amountRange: { min: '1000', max: '1500' },
        currency: 'CNY',
      },
      deps,
    );
    assert.deepEqual(
      hitsZh.map((hit) => hit.invoiceNumber),
      [zh.invoice_number],
    );
    const hitsEn = await findInvoices(
      scope,
      { supplier: en.supplier.name, dateRange: { from: '2025-03-01', to: '2025-03-31' }, currency: 'EUR' },
      deps,
    );
    assert.deepEqual(
      hitsEn.map((hit) => hit.invoiceNumber),
      [en.invoice_number],
    );
    const rag = await import('@/lib/rag');
    const exact = await rag.runRetrieval({
      scope,
      query: `What is the total on invoice ${en.invoice_number}?`,
      profile: 'chat',
      options: { maxResults: 25, fallbackToLowerThreshold: true },
      signal: new AbortController().signal,
    });
    assert.equal(exact.candidates[0]?.match_reason, 'exact_id');
    const enDoc = await documentByFilename('invoice-en.pdf');
    assert.equal(exact.candidates[0]?.document_id, enDoc.id);
  });

  test('image chunks on the figures PDF carry page numbers and image_url metadata', async () => {
    const imageChunks = await rows(
      `SELECT c.page_start, c.metadata FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.filename = 'images-en.pdf' AND c.chunk_kind = 'image'
       ORDER BY c.page_start`,
    );
    assert.ok(imageChunks.length >= 2, `expected two image chunks, got ${imageChunks.length}`);
    assert.deepEqual(
      imageChunks.map((row) => row.page_start),
      [1, 2],
    );
    for (const row of imageChunks) {
      const metadata = row.metadata as { image_url?: string };
      assert.ok(metadata.image_url?.startsWith('http'), 'image_url');
    }
  });

  test('the ingest-mode builder ingested every manifest fixture', async () => {
    const filenames = MANIFEST.fixtures.map((entry) => path.basename(entry.path));
    const { rows: found } = await fixture.db.query<{ filename: string }>(
      'SELECT filename FROM documents WHERE filename = ANY($1::text[]) ORDER BY filename',
      [filenames],
    );
    assert.deepEqual(
      found.map((row) => row.filename),
      [...filenames].sort(),
    );
  });
});