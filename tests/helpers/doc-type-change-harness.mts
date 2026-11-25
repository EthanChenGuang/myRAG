import assert from 'node:assert/strict';
import { mock } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import type { FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import type { ParseRequest, DocumentParser, NetworkParserName } from '@/lib/rag/ingest/parsers/shared';
import type { FakeObjectStore } from './fake-object-store';

/** Wiring shared by the two doc-type-change test files. They are separate files because the admin client of the app is a per-process singleton: one process serves one deployment mode. */
export type Row = Record<string, unknown>;

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
export const A = TWO_TENANT_IDS.userA;
export const B = TWO_TENANT_IDS.userB;
export const ORG = TWO_TENANT_IDS.orgO;
export const ST_ADMIN = '00000000-0000-4000-8000-0000000000f3';
export const ST_PLAIN = '00000000-0000-4000-8000-0000000000f4';
const encoder = new TextEncoder();

const AGREEMENT = [
  '# Supply Agreement',
  '',
  'Article 1 Payment. The buyer pays every invoice within thirty days of the invoice date and bears the bank charges of the transfer to the seller.',
  '',
  'Article 2 Delivery. The seller delivers the goods to the receiving dock of the buyer on the agreed date and notifies the carrier in advance of the visit.',
  '',
  'Article 3 Liability. Each party answers for the damage it causes to the other party under this agreement up to the value of the contract in force.',
  '',
].join('\n');

interface Parsers {
  llama: ParseRequest[];
  docling: ParseRequest[];
}

function recordingParser(name: NetworkParserName, markdown: string, calls: ParseRequest[]): DocumentParser {
  return {
    name,
    unavailableReason: () => null,
    async parse(request) {
      calls.push(request);
      return {
        kind: 'done',
        result: {
          markdown,
          chunks: [],
          pictures: [],
          page_count: 2,
          language: 'en',
          parser: name,
          parser_version: `${name}-test`,
          partial: false,
          text_layer_page_share: null,
          warnings: [],
        },
        artifacts: name === 'docling' ? [{ name: 'docling.json', bytes: encoder.encode('{"fake":true}'), contentType: 'application/json' }] : [],
        warnings: [],
      };
    },
  };
}

interface Modules {
  ingest: typeof import('@/lib/rag/ingest');
  change: typeof import('@/lib/rag/ingest/change-doc-type');
  adminScope: typeof import('@/lib/rag/tenant/ingest-scope');
  scopes: typeof import('@/lib/rag/tenant/scope');
  deps: typeof import('@/lib/rag/ingest/deps');
  config: typeof import('@/lib/rag/ingest/config');
  objectStore: typeof import('@/lib/rag/ingest/object-store');
  fakeStore: typeof import('./fake-object-store');
  resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  supabase: typeof import('@/lib/supabase');
  llama: typeof import('@/lib/rag/ingest/parsers/llamaparse-v2');
  sidecar: typeof import('@/lib/rag/ingest/parsers/sidecar-docling');
}

async function loadModules(): Promise<Modules> {
  return {
    ingest: await import('@/lib/rag/ingest'),
    change: await import('@/lib/rag/ingest/change-doc-type'),
    adminScope: await import('@/lib/rag/tenant/ingest-scope'),
    scopes: await import('@/lib/rag/tenant/scope'),
    deps: await import('@/lib/rag/ingest/deps'),
    config: await import('@/lib/rag/ingest/config'),
    objectStore: await import('@/lib/rag/ingest/object-store'),
    fakeStore: await import('./fake-object-store'),
    resolver: await import('@/lib/rag/tenant/resolve-chat'),
    supabase: await import('@/lib/supabase'),
    llama: await import('@/lib/rag/ingest/parsers/llamaparse-v2'),
    sidecar: await import('@/lib/rag/ingest/parsers/sidecar-docling'),
  };
}

export const signal = () => new AbortController().signal;

/** Shared fixture wiring for one deployment mode. */
export function harness(mode: 'multi-tenant' | 'single-tenant') {
  let fixture: FixtureDatabase;
  let edge: FakeEdge;
  let m: Modules;
  let store: FakeObjectStore;
  let parsers: Parsers;
  let counter = 0;

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  const setup = async (build: () => Promise<FixtureDatabase>) => {
    fixture = await build();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
    process.env.MYRAG_DEPLOYMENT_MODE = mode;
    m = await loadModules();
  };

  const teardown = async () => {
    await edge?.close();
    await fixture?.db.close();
  };

  const each = () => {
    store = m.fakeStore.createFakeObjectStore();
    m.objectStore.setObjectStoreForTests(store);
    m.config.resetIngestConfigForTests();
    m.deps.setIngestDepsForTests({ ingestEnv: () => ({}) });
    parsers = { llama: [], docling: [] };
    m.llama.setLlamaParseParserForTests(recordingParser('llamaparse', AGREEMENT, parsers.llama));
    m.sidecar.setSidecarParserForTests(recordingParser('docling', AGREEMENT, parsers.docling));
  };

  const afterEachTest = () => {
    m.objectStore.resetObjectStoreForTests();
    m.deps.resetIngestDepsForTests();
    m.config.resetIngestConfigForTests();
    m.llama.resetLlamaParseParserForTests();
    m.sidecar.resetSidecarParserForTests();
    mock.restoreAll();
  };

  const scopeOf = async (userId: string, organizationId: string | null = null) => {
    const resolved = await m.resolver.resolveTenantScope({
      requestedOrganizationId: organizationId,
      deploymentMode: mode,
      getUser: async () => ({ id: userId }),
      admin: m.supabase.getSupabaseAdmin(),
      signal: signal(),
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  };

  /** A PDF-named upload through the parser chain; the nonce keeps every upload distinct so no dedup applies. */
  const uploadPdf = async (userId: string, options: { filename?: string; source?: 'config_upload' | 'nango'; organizationId?: string | null; extra?: Row } = {}) => {
    counter += 1;
    const filename = options.filename ?? `agreement-${counter}.pdf`;
    const bytes = encoder.encode(`%PDF-1.4 fixture ${mode} ${counter}`);
    const source = options.source ?? 'config_upload';
    parsers.llama.length = 0;
    m.llama.setLlamaParseParserForTests(recordingParser('llamaparse', `${AGREEMENT}\nReference nr${mode.slice(0, 1)}${counter}.\n`, parsers.llama));
    parsers.docling.length = 0;
    m.sidecar.setSidecarParserForTests(recordingParser('docling', `${AGREEMENT}\nReference nr${mode.slice(0, 1)}${counter}.\n`, parsers.docling));
    const result = await m.ingest.ingest({
      scope: await scopeOf(userId, options.organizationId ?? null),
      source,
      sourceKey: source === 'nango' ? `file-${counter}` : `root/${filename}`,
      file: bytes,
      filename,
      mimeType: 'application/pdf',
      ...(options.extra ?? {}),
      signal: signal(),
    });
    assert.equal(result.status, 'ready');
    assert.ok(result.documentId);
    return { result, id: result.documentId, bytes, filename, counter };
  };

  const documentRow = async (id: string) =>
    (
      await rows(
        `SELECT id, version, is_current, status, doc_type, doc_type_origin, processing_profile_id, parser_used, parser_version, original_path,
                superseded_by, lineage_id, user_id, organization_id, source, source_key, source_provider, source_file_id, source_connection_id, metadata, processing_state
         FROM documents WHERE id = $1`,
        [id],
      )
    )[0] as Row;

  const chunksOf = (id: string) =>
    rows('SELECT chunk_index, content, section_path, is_current, status FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [id]);

  return {
    get fixture() {
      return fixture;
    },
    get m() {
      return m;
    },
    get store() {
      return store;
    },
    get parsers() {
      return parsers;
    },
    rows,
    setup,
    teardown,
    each,
    afterEachTest,
    scopeOf,
    uploadPdf,
    documentRow,
    chunksOf,
  };
}

