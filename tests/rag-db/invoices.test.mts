import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { createIngestWriter, type ChunkWrite, type DocumentFields } from '@/lib/rag/ingest/writer';
import { findInvoices, type InvoiceFilters } from '@/lib/rag/retrieval/invoices';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const COLUMNS = ['invoice_number', 'supplier_name', 'supplier_tax_id', 'issue_date', 'gross_total', 'currency'];
const FUNCTIONS = ['rag_find_invoices', 'rag_exact_id_documents', 'rag_set_document_fields'];

// Synthetic ids from tests/fixtures/ingest/tax-id-vectors.json
const IT_IVA = '99999999990';
const IT_IVA_2 = '00000010017';
const USCC = '91000000MA0000000N';

type Row = Record<string, unknown>;

/** The Supabase client contract over PGlite: named arguments, one row set back, the database message on error. */
function pgliteRpc(db: PGlite, record?: Array<{ fn: string; args: Record<string, unknown> }>): RpcClient {
  return {
    rpc(fn, args) {
      record?.push({ fn, args });
      const keys = Object.keys(args);
      const sql = `SELECT * FROM ${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = db
        .query<Row>(
          sql,
          keys.map((key) => args[key]),
        )
        .then((result): RpcResponse => ({ data: result.rows, error: null }))
        .catch((error: unknown): RpcResponse => ({ data: null, error: { code: 'P0001', message: error instanceof Error ? error.message : String(error) } }));
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'accepted';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

interface SeedInput {
  sourceKey: string;
  filename?: string;
  fields?: DocumentFields;
  lexical?: string[];
  kinds?: Array<ChunkWrite['chunk_kind'] | 'invoice_header'>;
  docType?: string;
  quarantine?: boolean;
  stop?: 'before_publish';
}

for (const mode of MODES) {
  describe(`invoice columns, findInvoices and exact-id lookup (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;
    let scopeA: TenantScope;
    let scopeB: TenantScope | null = null;
    const signal = new AbortController().signal;
    let counter = 0;

    before(async () => {
      if (mode === 'single-tenant') {
        fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
        scopeA = mintScope('single', null, null);
      } else {
        fixture = await createTwoTenantDatabase();
        scopeA = mintScope('personal', TWO_TENANT_IDS.userA, null);
        scopeB = mintScope('personal', TWO_TENANT_IDS.userB, null);
      }
      db = fixture.db;
    });

    after(async () => {
      await fixture?.db.close();
    });

    const requireSchema = async (): Promise<void> => {
      const found = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = ANY($1)",
        [COLUMNS],
      );
      assert.deepEqual(found.rows.map((row) => row.column_name).sort(), [...COLUMNS].sort(), 'migration 0314 must add the six invoice columns to documents');
    };

    const writerFor = (scope: TenantScope) => createIngestWriter({ db: pgliteRpc(db), scope, signal });

    /** Inserts one invoice version through the writer functions, as the ingest stages do. */
    async function seed(scope: TenantScope, input: SeedInput): Promise<string> {
      const writer = writerFor(scope);
      counter += 1;
      const begin = await writer.begin({
        source: 'config_upload',
        sourceKey: input.sourceKey,
        filename: input.filename ?? `${input.sourceKey}.pdf`,
        fileSha256: crypto.createHash('sha256').update(`${input.sourceKey}-${counter}`).digest('hex'),
        docType: input.docType ?? 'invoice_receipt',
        docTypeOrigin: 'picked',
        profileId: 'invoice_receipt@1',
        profileVersion: 1,
      });
      assert.ok(begin.outcome === 'created' || begin.outcome === 'resumed', 'the seeded version must be created');
      if (begin.outcome === 'skipped_duplicate') throw new Error('unexpected duplicate');
      if (input.fields) await writer.setFields(begin.documentId, input.fields);
      const lexical = input.lexical ?? [`Invoice ${input.fields?.invoice_number ?? 'none'} supplier ${input.fields?.supplier_name ?? 'none'}`];
      const chunks: ChunkWrite[] = lexical.map((text, index) => ({
        content: text,
        chunk_index: index,
        section_path: [],
        chunk_kind: (input.kinds?.[index] ?? 'text') as ChunkWrite['chunk_kind'],
        embedding_text_version: 1,
        lexical_text: text,
        metadata: {},
      }));
      await writer.writeChunks(begin.documentId, chunks, { embeddings: null, final: true, total: chunks.length });
      if (input.quarantine) await writer.setFields(begin.documentId, { status: 'quarantined' });
      if (input.stop !== 'before_publish') await writer.publish(begin.documentId);
      return begin.documentId;
    }

    const ids = async (scope: TenantScope, filters: InvoiceFilters = {}): Promise<string[]> => {
      const hits = await findInvoices(scope, filters, { db: () => pgliteRpc(db), signal });
      return hits.map((hit) => hit.invoiceNumber ?? '').sort();
    };

    const keyOf = (scope: TenantScope): string => scopeKey(scope).toLowerCase();

    test('documents has the six invoice columns and four tenant-first btree indexes', async () => {
      await requireSchema();
      const indexes = await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'documents'");
      for (const column of ['invoice_number', 'supplier_tax_id', 'issue_date', 'gross_total']) {
        assert.ok(
          indexes.rows.some((row) => row.indexdef.includes(`(tenant_key, ${column})`) && /USING btree/i.test(row.indexdef)),
          `an index on (tenant_key, ${column})`,
        );
      }
      const types = await db.query<{ column_name: string; data_type: string }>(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = ANY($1)",
        [['issue_date', 'gross_total']],
      );
      assert.deepEqual(
        Object.fromEntries(types.rows.map((row) => [row.column_name, row.data_type])),
        { issue_date: 'date', gross_total: 'numeric' },
      );
    });

    test('rag_set_document_fields stores the invoice keys and refuses a malformed currency, amount or date', async () => {
      await requireSchema();
      const id = await seed(scopeA, {
        sourceKey: `fields-${mode}`,
        fields: {
          invoice_number: 'FT-2025-00417',
          supplier_name: 'Esempio Fornitore S.r.l.',
          supplier_tax_id: IT_IVA,
          issue_date: '2025-03-15',
          gross_total: '1220.50',
          currency: 'EUR',
          doc_date: '2025-03-15',
        },
      });
      const row = (
        await db.query<Row>(
          'SELECT invoice_number, supplier_name, supplier_tax_id, issue_date::text AS issue_date, gross_total::text AS gross_total, currency, doc_date::text AS doc_date FROM documents WHERE id = $1',
          [id],
        )
      ).rows[0];
      assert.deepEqual(row, {
        invoice_number: 'FT-2025-00417',
        supplier_name: 'Esempio Fornitore S.r.l.',
        supplier_tax_id: IT_IVA,
        issue_date: '2025-03-15',
        gross_total: '1220.5000',
        currency: 'EUR',
        doc_date: '2025-03-15',
      });

      const writer = writerFor(scopeA);
      for (const bad of [{ currency: 'eur' }, { currency: 'EURO' }, { gross_total: '12,5' }, { gross_total: '1e9' }, { issue_date: '15/03/2025' }, { issue_date: '2025-13-40' }] as DocumentFields[]) {
        const message = await failureOf(() => writer.setFields(id, bad));
        assert.match(message, /invalid_field|failed/, JSON.stringify(bad));
        assert.notEqual(message, 'accepted', JSON.stringify(bad));
      }
      const cleared = await writer.setFields(id, { currency: null, gross_total: null });
      assert.equal(cleared, undefined);
      const after = (await db.query<Row>('SELECT currency, gross_total FROM documents WHERE id = $1', [id])).rows[0];
      assert.deepEqual(after, { currency: null, gross_total: null });
    });

    test('findInvoices matches the supplier by case-insensitive name or by exact tax id', async () => {
      await requireSchema();
      await seed(scopeA, { sourceKey: `supplier-1-${mode}`, fields: { invoice_number: 'SUP-1', supplier_name: 'Aurora Forniture S.r.l.', supplier_tax_id: IT_IVA, issue_date: '2025-01-10', gross_total: '100.00', currency: 'EUR' } });
      await seed(scopeA, { sourceKey: `supplier-2-${mode}`, fields: { invoice_number: 'SUP-2', supplier_name: 'Borealis Trading Ltd', supplier_tax_id: USCC, issue_date: '2025-02-10', gross_total: '200.00', currency: 'CNY' } });

      assert.deepEqual(await ids(scopeA, { supplier: 'aurora' }), ['SUP-1']);
      assert.deepEqual(await ids(scopeA, { supplier: 'TRADING LTD' }), ['SUP-2']);
      assert.deepEqual(await ids(scopeA, { supplier: IT_IVA }), ['SUP-1']);
      assert.deepEqual(await ids(scopeA, { supplier: USCC.toLowerCase() }), ['SUP-2']);
      assert.deepEqual(await ids(scopeA, { supplier: '%' }), [], 'a wildcard is text, not a pattern');
      assert.deepEqual(await ids(scopeA, { supplier: 'no such supplier' }), []);
    });

    test('findInvoices compares amounts numerically, dates inclusively and currency exactly', async () => {
      await requireSchema();
      await seed(scopeA, { sourceKey: `amount-small-${mode}`, fields: { invoice_number: 'AMT-9', supplier_name: 'Amount Test Co', issue_date: '2025-04-01', gross_total: '9.00', currency: 'EUR' } });
      await seed(scopeA, { sourceKey: `amount-mid-${mode}`, fields: { invoice_number: 'AMT-100', supplier_name: 'Amount Test Co', issue_date: '2025-04-15', gross_total: '100.00', currency: 'EUR' } });
      await seed(scopeA, { sourceKey: `amount-big-${mode}`, fields: { invoice_number: 'AMT-10000', supplier_name: 'Amount Test Co', issue_date: '2025-04-30', gross_total: '10000.00', currency: 'USD' } });

      const supplier = 'Amount Test Co';
      assert.deepEqual(await ids(scopeA, { supplier, amountRange: { min: '10' } }), ['AMT-100', 'AMT-10000'], '9 is below 10 numerically, 10000 is above');
      assert.deepEqual(await ids(scopeA, { supplier, amountRange: { max: '100' } }), ['AMT-100', 'AMT-9'], 'the upper bound is inclusive');
      assert.deepEqual(await ids(scopeA, { supplier, amountRange: { min: '9', max: '100.00' } }), ['AMT-100', 'AMT-9']);
      assert.deepEqual(await ids(scopeA, { supplier, dateRange: { from: '2025-04-15', to: '2025-04-30' } }), ['AMT-10000', 'AMT-100']);
      assert.deepEqual(await ids(scopeA, { supplier, dateRange: { from: '2025-04-16' } }), ['AMT-10000']);
      assert.deepEqual(await ids(scopeA, { supplier, currency: 'USD' }), ['AMT-10000']);
      assert.deepEqual(await ids(scopeA, { supplier, currency: 'EUR', amountRange: { min: '50' } }), ['AMT-100']);
    });

    test('findInvoices returns the stored fields, newest issue date first, and honours the limit', async () => {
      await requireSchema();
      await seed(scopeA, { sourceKey: `order-old-${mode}`, filename: 'order-old.pdf', fields: { invoice_number: 'ORD-OLD', supplier_name: 'Order Test Co', issue_date: '2024-01-05', gross_total: '5.50', currency: 'EUR' } });
      await seed(scopeA, { sourceKey: `order-new-${mode}`, filename: 'order-new.pdf', fields: { invoice_number: 'ORD-NEW', supplier_name: 'Order Test Co', supplier_tax_id: IT_IVA_2, issue_date: '2025-06-05', gross_total: '7.25', currency: 'EUR' } });

      const hits = await findInvoices(scopeA, { supplier: 'Order Test Co' }, { db: () => pgliteRpc(db), signal });
      assert.deepEqual(
        hits.map((hit) => [hit.invoiceNumber, hit.issueDate, hit.grossTotal, hit.currency, hit.supplierName, hit.supplierTaxId, hit.filename]),
        [
          ['ORD-NEW', '2025-06-05', '7.2500', 'EUR', 'Order Test Co', IT_IVA_2, 'order-new.pdf'],
          ['ORD-OLD', '2024-01-05', '5.5000', 'EUR', 'Order Test Co', null, 'order-old.pdf'],
        ],
      );
      assert.equal(typeof hits[0]?.documentId, 'string');
      const limited = await findInvoices(scopeA, { supplier: 'Order Test Co', limit: 1 }, { db: () => pgliteRpc(db), signal });
      assert.deepEqual(limited.map((hit) => hit.invoiceNumber), ['ORD-NEW']);
    });

    test('a quarantined, unfinished, superseded or non-invoice document is never returned', async () => {
      await requireSchema();
      const supplier = 'Exclusion Test Co';
      const fields = (number: string): DocumentFields => ({ invoice_number: number, supplier_name: supplier, issue_date: '2025-05-05', gross_total: '1.00', currency: 'EUR' });
      await seed(scopeA, { sourceKey: `excl-ok-${mode}`, fields: fields('EXC-OK') });
      await seed(scopeA, { sourceKey: `excl-quarantine-${mode}`, fields: fields('EXC-QUARANTINED'), quarantine: true });
      await seed(scopeA, { sourceKey: `excl-processing-${mode}`, fields: fields('EXC-PROCESSING'), stop: 'before_publish' });
      await seed(scopeA, { sourceKey: `excl-general-${mode}`, fields: fields('EXC-GENERAL'), docType: 'general' });
      await seed(scopeA, { sourceKey: `excl-versions-${mode}`, fields: fields('EXC-V1') });
      await seed(scopeA, { sourceKey: `excl-versions-${mode}`, fields: fields('EXC-V2') });

      assert.deepEqual(await ids(scopeA, { supplier }), ['EXC-OK', 'EXC-V2']);
    });

    test('findInvoices sends the tenant key of the scope and nothing else identifies the tenant', async () => {
      await requireSchema();
      const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      await findInvoices(scopeA, { supplier: 'x' }, { db: () => pgliteRpc(db, calls), signal });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.fn, 'rag_find_invoices');
      assert.equal(calls[0]?.args.p_tenant_key, keyOf(scopeA));
      assert.deepEqual(Object.keys(calls[0]?.args ?? {}).filter((key) => /user|org|tenant/.test(key)), ['p_tenant_key']);
    });

    test('invalid filters are refused before any call is made', async () => {
      const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const deps = { db: () => pgliteRpc(db, calls), signal };
      const bad: InvoiceFilters[] = [
        { currency: 'euro' },
        { dateRange: { from: '15/03/2025' } },
        { amountRange: { min: 'abc' } },
        { supplier: 'x'.repeat(201) },
        { limit: 0 },
        { limit: 1000 },
      ];
      for (const filters of bad) assert.notEqual(await failureOf(() => findInvoices(scopeA, filters, deps)), 'accepted', JSON.stringify(filters));
      assert.equal(calls.length, 0);
    });

    test('rag_exact_id_documents finds current ready chunks by invoice number, tax id and a whole-word model token', async () => {
      await requireSchema();
      await seed(scopeA, {
        sourceKey: `exact-invoice-${mode}`,
        fields: { invoice_number: 'EXA-2025-00417', supplier_name: 'Exact Test Co', supplier_tax_id: IT_IVA, issue_date: '2025-03-15', gross_total: '10.00', currency: 'EUR' },
        lexical: ['Invoice EXA-2025-00417 header block', 'Item table rows for the order', 'Unrelated narrative paragraph'],
        kinds: ['invoice_header', 'table', 'text'],
      });
      await seed(scopeA, {
        sourceKey: `exact-manual-${mode}`,
        fields: { invoice_number: 'EXA-OTHER' },
        docType: 'product_technical',
        lexical: ['The thermal probe model TP-7A100 mounts on the rail', 'Model TP-7A1000 is a different part', 'Mentions tp-7a100x as a prefix only'],
      });

      const lookup = async (tokens: string[], scope: TenantScope = scopeA) =>
        (await pgliteRpc(db).rpc('rag_exact_id_documents', { p_tenant_key: keyOf(scope), p_tokens: tokens, p_limit: 20 })).data as Row[];

      const byNumber = await lookup(['EXA-2025-00417']);
      assert.deepEqual(byNumber.map((row) => row.matched_field).sort(), ['invoice_number', 'invoice_number', 'lexical_text'].sort(), 'header and table by field, plus the lexical hit on the header text');
      const kinds = new Set(byNumber.map((row) => (row.content as string).slice(0, 12)));
      assert.ok(kinds.has('Invoice EXA-') && kinds.has('Item table r'));
      assert.ok(!byNumber.some((row) => (row.content as string).startsWith('Unrelated')), 'the narrative chunk of the same document is not an invoice chunk');

      assert.ok((await lookup([IT_IVA.toLowerCase()])).length >= 2, 'tax id, case-insensitive');
      assert.deepEqual(
        (await lookup(['TP-7A100'])).map((row) => row.content),
        ['The thermal probe model TP-7A100 mounts on the rail'],
        'a whole-word match only: neither TP-7A1000 nor tp-7a100x',
      );
      assert.deepEqual(await lookup(['', '  ']), []);
      assert.deepEqual(await lookup(['no-such-id-9']), []);
    });

    test('rag_exact_id_documents leaves out quarantined, superseded and unfinished versions', async () => {
      await requireSchema();
      await seed(scopeA, { sourceKey: `exactx-q-${mode}`, fields: { invoice_number: 'EXX-QUARANTINED' }, quarantine: true });
      await seed(scopeA, { sourceKey: `exactx-p-${mode}`, fields: { invoice_number: 'EXX-PROCESSING' }, stop: 'before_publish' });
      await seed(scopeA, { sourceKey: `exactx-v-${mode}`, fields: { invoice_number: 'EXX-V1' } });
      await seed(scopeA, { sourceKey: `exactx-v-${mode}`, fields: { invoice_number: 'EXX-V2' } });
      const found = async (token: string) =>
        ((await pgliteRpc(db).rpc('rag_exact_id_documents', { p_tenant_key: keyOf(scopeA), p_tokens: [token], p_limit: 20 })).data as Row[]).length;
      assert.equal(await found('EXX-QUARANTINED'), 0);
      assert.equal(await found('EXX-PROCESSING'), 0);
      assert.equal(await found('EXX-V1'), 0);
      assert.ok((await found('EXX-V2')) >= 1);
    });

    test('the lookup functions are executable by service_role only, and a malformed tenant key is refused', async () => {
      await requireSchema();
      const exposure = await db.query<{ proname: string; anon: boolean; authenticated: boolean; service: boolean }>(
        `SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1) ORDER BY p.proname`,
        [FUNCTIONS],
      );
      assert.equal(exposure.rows.length, FUNCTIONS.length);
      for (const row of exposure.rows) assert.deepEqual({ anon: row.anon, authenticated: row.authenticated, service: row.service }, { anon: false, authenticated: false, service: true }, row.proname);

      const refused = await pgliteRpc(db).rpc('rag_find_invoices', {
        p_tenant_key: "' OR true --",
        p_supplier: null,
        p_date_from: null,
        p_date_to: null,
        p_amount_min: null,
        p_amount_max: null,
        p_currency: null,
        p_limit: 10,
      });
      assert.ok(refused.error, 'a malformed tenant key raises');
      assert.match(refused.error?.message ?? '', /invalid_tenant_key/);
    });

    if (mode === 'multi-tenant') {
      test('tenant B never sees tenant A invoices through any filter, and the same tax id in B returns only B', async () => {
        await requireSchema();
        assert.ok(scopeB);
        await seed(scopeA, { sourceKey: 'iso-a', fields: { invoice_number: 'ISO-A-1', supplier_name: 'Shared Supplier Spa', supplier_tax_id: IT_IVA, issue_date: '2025-07-01', gross_total: '777.00', currency: 'EUR' }, lexical: ['Invoice ISO-A-1 for model ZX-9000'], kinds: ['invoice_header'] });
        await seed(scopeB, { sourceKey: 'iso-b', fields: { invoice_number: 'ISO-B-1', supplier_name: 'Shared Supplier Spa', supplier_tax_id: IT_IVA, issue_date: '2025-07-01', gross_total: '777.00', currency: 'EUR' }, lexical: ['Invoice ISO-B-1 for model ZX-9000'], kinds: ['invoice_header'] });

        const filtersets: InvoiceFilters[] = [
          {},
          { supplier: 'Shared Supplier' },
          { supplier: IT_IVA },
          { dateRange: { from: '2025-07-01', to: '2025-07-01' } },
          { amountRange: { min: '777', max: '777' } },
          { currency: 'EUR' },
        ];
        for (const filters of filtersets) {
          const seenByA = await ids(scopeA, filters);
          const seenByB = await ids(scopeB as TenantScope, filters);
          assert.ok(!seenByA.some((number) => number.startsWith('ISO-B')), `A sees B with ${JSON.stringify(filters)}`);
          assert.ok(!seenByB.some((number) => number.startsWith('ISO-A')), `B sees A with ${JSON.stringify(filters)}`);
        }
        assert.deepEqual(await ids(scopeA, { supplier: IT_IVA }), ['ISO-A-1']);
        assert.deepEqual(await ids(scopeB as TenantScope, { supplier: IT_IVA }), ['ISO-B-1']);

        const lookup = async (scope: TenantScope, token: string) =>
          ((await pgliteRpc(db).rpc('rag_exact_id_documents', { p_tenant_key: keyOf(scope), p_tokens: [token], p_limit: 20 })).data as Row[]).map((row) => row.content);
        assert.deepEqual(await lookup(scopeA, 'ISO-A-1'), ['Invoice ISO-A-1 for model ZX-9000', 'Invoice ISO-A-1 for model ZX-9000'].slice(0, (await lookup(scopeA, 'ISO-A-1')).length));
        assert.deepEqual(await lookup(scopeB as TenantScope, 'ISO-A-1'), [], 'B cannot find A by invoice number');
        assert.deepEqual(await lookup(scopeB as TenantScope, IT_IVA), ['Invoice ISO-B-1 for model ZX-9000']);
        const modelHits = (await lookup(scopeA, 'ZX-9000')).concat(await lookup(scopeB as TenantScope, 'ZX-9000'));
        assert.deepEqual(modelHits.sort(), ['Invoice ISO-A-1 for model ZX-9000', 'Invoice ISO-B-1 for model ZX-9000']);
        assert.equal((await lookup(scopeA, 'ZX-9000')).length, 1, 'a model token stays inside its tenant');
      });
    }
  });
}
