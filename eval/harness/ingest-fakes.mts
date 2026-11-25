// Loaded on demand (import()) after the process environment is set: it imports app modules that read `@/lib/env` once.
import { createClient } from '@supabase/supabase-js';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { resetIngestConfigForTests, type IngestEnvInput } from '@/lib/rag/ingest/config';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { resetObjectStoreForTests, setObjectStoreForTests } from '@/lib/rag/ingest/object-store';
import { resetLlamaParseParserForTests, setLlamaParseParserForTests } from '@/lib/rag/ingest/parsers/llamaparse-v2';
import { ParserError, type DocumentParser } from '@/lib/rag/ingest/parsers/shared';
import { createSidecarParser, resetSidecarParserForTests, setSidecarParserForTests } from '@/lib/rag/ingest/parsers/sidecar-docling';
import { fixtureProcessEnv } from './fake-edge.mts';
import { embedText } from './fixture-embedder.mts';
import { createFakeObjectStore, type FakeObjectStore } from '../../tests/helpers/fake-object-store.ts';
import { startFakeSidecar, type FakeSidecar } from '../../tests/helpers/fake-sidecar.ts';
import captions from '../../tests/fixtures/ingest/caption-recorded.json';

/** What ingest mode runs with: the unified pipeline and LlamaParse as the configured parser, which the stub below leaves unavailable. */
export const INGEST_MODE_ENV: IngestEnvInput = { RAG_INGEST_PIPELINE: 'unified', RAG_PARSER: 'llamaparse' };

/** Feature switches the ingest-mode builder turns on inside the harness only (plan 03-44). */
export const INGEST_MODE_FEATURE_ENV: IngestEnvInput = {
  ...INGEST_MODE_ENV,
  RAG_INJECTION_SCAN: 'quarantine',
  RAG_PDF_IMAGE_CHUNKS: 'true',
  RAG_EXACT_ID_LOOKUP: 'true',
};

/** The service-role client of the fake edge. It is built here, not taken from the app singleton, so every build talks to its own edge. */
export function fixtureAdminClient(edgeUrl: string): RpcClient {
  const key = fixtureProcessEnv(edgeUrl).SUPABASE_SERVICE_ROLE_KEY as string;
  return createClient(edgeUrl, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as RpcClient;
}

let llamaParseAttempts = 0;

const llamaParseStub: DocumentParser = {
  name: 'llamaparse',
  unavailableReason: () => 'missing_key',
  async parse() {
    llamaParseAttempts += 1;
    throw new ParserError('llamaparse', 'missing_key');
  },
};

export interface IngestFakes {
  /** The HTTP stand-in for the sidecar; it serves the recorded ParseResults of eval/fixtures/ingest/manifest.json by file hash. */
  sidecar: FakeSidecar;
  /** The in-memory store that keeps originals and parse artifacts. */
  objectStore: FakeObjectStore;
  /** How many times the LlamaParse stub was asked to parse (expected zero when the key is missing). */
  llamaParseAttempts(): number;
  uninstall(): Promise<void>;
}

/**
 * Replaces everything ingest() would call outside the database with a local fake: the sidecar client talks to the fake sidecar over
 * HTTP, LlamaParse is an always-unavailable stub, storage is in memory and embeddings come from the fixture embedder. The database is
 * the caller's, so ingest() runs the real writer functions on it. Test setters only; production modules keep their real defaults.
 */
export async function installIngestFakes(options: { db: RpcClient; env?: IngestEnvInput }): Promise<IngestFakes> {
  llamaParseAttempts = 0;
  const sidecar = await startFakeSidecar();
  const objectStore = createFakeObjectStore();
  const { installFakePublicImageStore } = await import('../../tests/helpers/fake-public-image-store.ts');
  installFakePublicImageStore();
  const { setCaptionerForTests, resetCaptionerForTests } = await import('@/lib/rag/ingest/captioner');
  const { setInvoiceClientForTests } = await import('@/lib/rag/ingest/invoice-client');
  const { InvoiceFieldsSchema } = await import('@/lib/rag-eval/contracts.generated');
  setCaptionerForTests(async () => captions.captions.chart);
  setInvoiceClientForTests({
    config: () => ({ baseUrl: sidecar.url, secret: sidecar.secret }),
    fetch: (async (_url: unknown, init?: RequestInit) => {
      const markdown = (JSON.parse(String(init?.body)) as { markdown: string }).markdown;
      const number = /(?:Invoice No\.:\s*|发票号码[:：]\s*|Numero fattura:\s*)(\S+)/i.exec(markdown)?.[1] ?? 'UNKNOWN';
      const supplierZh = /销售方[\s\S]*?名称：([^\n]+)/.exec(markdown)?.[1]?.trim();
      const supplier =
        /Supplier:\s*(.+)/.exec(markdown)?.[1]?.trim() ??
        /Fornitore:\s*(.+)/.exec(markdown)?.[1]?.trim() ??
        supplierZh ??
        'Example Supplier';
      const gross =
        /Total:\s*EUR\s*([\d,]+\.\d{2})/i.exec(markdown)?.[1]?.replace(/,/g, '') ??
        /价税合计（小写）：¥([\d,]+\.\d{2})/.exec(markdown)?.[1]?.replace(/,/g, '') ??
        /Totale:\s*EUR\s*([\d,]+\.\d{2})/i.exec(markdown)?.[1]?.replace(/,/g, '') ??
        '0.00';
      const taxId =
        /VAT No\.:\s*(\S+)/.exec(markdown)?.[1] ??
        /(?:纳税人识别号|统一社会信用代码)[:：]\s*(\S+)/.exec(markdown)?.[1] ??
        /Partita IVA:\s*(\S+)/i.exec(markdown)?.[1] ??
        '00000000000';
      const fields = InvoiceFieldsSchema.parse({
        invoice_number: number,
        issue_date: '2025-03-15',
        supplier: {
          name: supplier,
          tax_id: taxId,
          tax_id_scheme: number.startsWith('FP-') ? 'cn_uscc' : 'eu_vat',
        },
        buyer: { name: 'Example Buyer' },
        currency: markdown.includes('¥') || number.startsWith('FP-') ? 'CNY' : 'EUR',
        gross_total: gross,
        confidence: 1,
      });
      return new Response(JSON.stringify(fields), { status: 200 });
    }) as typeof fetch,
  });
  resetIngestConfigForTests();
  setIngestDepsForTests({
    db: () => options.db,
    embedDocuments: async (texts) => texts.map((text) => embedText(text)),
    ingestEnv: () => options.env ?? INGEST_MODE_FEATURE_ENV,
  });
  setObjectStoreForTests(objectStore);
  setLlamaParseParserForTests(llamaParseStub);
  setSidecarParserForTests(createSidecarParser({ baseUrl: sidecar.url, secret: sidecar.secret, sleep: async () => undefined }));
  return {
    sidecar,
    objectStore,
    llamaParseAttempts: () => llamaParseAttempts,
    async uninstall() {
      resetCaptionerForTests();
      setInvoiceClientForTests(null);
      resetSidecarParserForTests();
      resetLlamaParseParserForTests();
      resetObjectStoreForTests();
      resetIngestDepsForTests();
      resetIngestConfigForTests();
      await sidecar.close();
    },
  };
}
