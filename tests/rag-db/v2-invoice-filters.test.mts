import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';
const SUPPLIER = 'Fornitore Alfa';

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

interface TraceBody {
  kept: Array<{ chunk_id: string; document_id: string; content: string }>;
  used_documents: Array<{ document_id: string; name: string }>;
  refused: boolean;
  refusal_reason: string | null;
}

interface SeedRow {
  userId: string;
  invoiceNumber: string;
  gross: number;
  status?: 'ready' | 'quarantined';
  lexical?: string;
}

let fixture: TwoTenantDatabase;
let prepared: InProcessEval;

const seededDocs = new Map<string, { userId: string; invoiceNumber: string; gross: number; status: string }>();

async function seedInvoice(row: SeedRow): Promise<string> {
  const docId = crypto.randomUUID();
  const chunkId = crypto.randomUUID();
  const tenantKey = `u:${row.userId}`;
  const body = row.lexical ?? `fattura ${SUPPLIER} numero ${row.invoiceNumber} importo ${row.gross}`;
  const status = row.status ?? 'ready';
  await fixture.db.query(
    `INSERT INTO documents (
      id, filename, content, user_id, supplier_name, invoice_number, issue_date, gross_total, currency,
      is_current, status, doc_type
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, 'invoice_receipt')`,
  [docId, `${row.invoiceNumber}.pdf`, body, row.userId, SUPPLIER, row.invoiceNumber, '2025-06-01', row.gross, 'EUR', status],
  );
  await fixture.db.query(
    `INSERT INTO document_chunks (
      id, document_id, content, embedding, lexical_text, tenant_key, doc_type, is_current, status
    ) VALUES ($1, $2, $3, $4::vector, $3, $5, 'invoice_receipt', true, $6)`,
    [chunkId, docId, body, vec(body), tenantKey, status],
  );
  seededDocs.set(docId, { userId: row.userId, invoiceNumber: row.invoiceNumber, gross: row.gross, status });
  return docId;
}

async function postEval(
  userId: string,
  query: string,
  invoice?: { supplier: string; amount_min: string; amount_max: string; currency?: string },
): Promise<{ status: number; json: TraceBody }> {
  const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({
      schema_version: 1,
      query,
      rag_mode: 'strict',
      options: {
        user_id: userId,
        ...(invoice
          ? {
              retrieval_filters: {
                current_only: true,
                date_range: null,
                sources: null,
                document_ids: null,
                doc_types: null,
                languages: null,
                invoice: {
                  supplier: invoice.supplier,
                  amount_min: invoice.amount_min,
                  amount_max: invoice.amount_max,
                  currency: invoice.currency ?? 'EUR',
                },
              },
            }
          : {}),
      },
    }),
  });
  const res = await prepared.POST(req);
  return { status: res.status, json: (await res.json()) as TraceBody };
}

function assertKeptMatchTenantA(json: TraceBody, allowedDocIds: Set<string>): void {
  assert.ok(json.kept.length >= 1, 'expected kept chunks');
  for (const chunk of json.kept) {
    assert.ok(allowedDocIds.has(chunk.document_id), `unexpected document ${chunk.document_id}`);
    const meta = seededDocs.get(chunk.document_id);
    assert.ok(meta, 'kept chunk document must be seeded');
    assert.equal(meta.userId, TWO_TENANT_IDS.userA);
    assert.equal(meta.status, 'ready');
    assert.equal(meta.gross >= 100 && meta.gross <= 2000, true);
  }
}

before(async () => {
  fixture = await createTwoTenantDatabase();
  await seedInvoice({ userId: TWO_TENANT_IDS.userA, invoiceNumber: 'ALFA-A-500', gross: 500 });
  await seedInvoice({ userId: TWO_TENANT_IDS.userA, invoiceNumber: 'ALFA-A-3000', gross: 3000 });
  await seedInvoice({ userId: TWO_TENANT_IDS.userA, invoiceNumber: 'ALFA-A-Q', gross: 800, status: 'quarantined' });
  await seedInvoice({ userId: TWO_TENANT_IDS.userB, invoiceNumber: 'ALFA-B-500', gross: 500 });

  prepared = await prepareInProcessEval({
    corpusDir: CORPUS_DIR,
    deploymentMode: 'multi-tenant',
    ingestFixture: fixture,
    allowedScopes: [`user:${TWO_TENANT_IDS.userA}`, `user:${TWO_TENANT_IDS.userB}`],
    envOverrides: {
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'true',
      RAG_RERANKER: 'none',
      RAG_EXACT_ID_LOOKUP: 'true',
    },
  });

  const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
  const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  await verifyV2Startup();
});

after(async () => {
  await prepared?.close();
});

describe('v2 invoice filters through eval route (D-05)', () => {
  test('tenant A keeps only matching current invoices for supplier and amount range', async () => {
    const { status, json } = await postEval(TWO_TENANT_IDS.userA, `fattura ${SUPPLIER} numero ALFA-A-500 importo 500`, {
      supplier: SUPPLIER,
      amount_min: '100',
      amount_max: '2000',
    });
    assert.equal(status, 200);
    const allowed = new Set(
      [...seededDocs.entries()]
        .filter(([, meta]) => meta.userId === TWO_TENANT_IDS.userA && meta.status === 'ready' && meta.gross >= 100 && meta.gross <= 2000)
        .map(([id]) => id),
    );
    assertKeptMatchTenantA(json, allowed);
    assert.ok(!json.kept.some((chunk) => chunk.content.includes('ALFA-A-3000')));
    assert.ok(!json.kept.some((chunk) => chunk.content.includes('ALFA-A-Q')));
  });

  test('tenant B with the same filter never sees tenant A invoice chunks', async () => {
    const { status, json } = await postEval(TWO_TENANT_IDS.userB, `fattura ${SUPPLIER} numero ALFA-B-500 importo 500`, {
      supplier: SUPPLIER,
      amount_min: '100',
      amount_max: '2000',
    });
    assert.equal(status, 200);
    const tenantADocs = new Set(
      [...seededDocs.entries()].filter(([, meta]) => meta.userId === TWO_TENANT_IDS.userA).map(([id]) => id),
    );
    for (const chunk of json.kept) {
      assert.ok(!tenantADocs.has(chunk.document_id), 'tenant B must not see tenant A documents');
    }
    const tenantBAllowed = new Set(
      [...seededDocs.entries()]
        .filter(([, meta]) => meta.userId === TWO_TENANT_IDS.userB && meta.status === 'ready')
        .map(([id]) => id),
    );
    for (const chunk of json.kept) {
      assert.ok(tenantBAllowed.has(chunk.document_id));
    }
  });

  test('amountMax 50 excludes matching chunks and strict mode refuses', async () => {
    const { status, json } = await postEval(TWO_TENANT_IDS.userA, `Importo totale fatture di ${SUPPLIER}`, {
      supplier: SUPPLIER,
      amount_min: '0',
      amount_max: '50',
    });
    assert.equal(status, 200);
    assert.equal(json.kept.length, 0);
    assert.equal(json.refused, true);
    assert.ok(json.refusal_reason);
  });

  test('a quarantined matching invoice never appears in kept results', async () => {
    const { status, json } = await postEval(TWO_TENANT_IDS.userA, `fattura ${SUPPLIER} numero ALFA-A-500 importo 500`, {
      supplier: SUPPLIER,
      amount_min: '100',
      amount_max: '2000',
    });
    assert.equal(status, 200);
    assert.ok(!json.kept.some((chunk) => chunk.content.includes('ALFA-A-Q')));
    const quarantineId = [...seededDocs.entries()].find(([, meta]) => meta.invoiceNumber === 'ALFA-A-Q')?.[0];
    assert.ok(quarantineId);
    assert.ok(!json.kept.some((chunk) => chunk.document_id === quarantineId));
  });
});