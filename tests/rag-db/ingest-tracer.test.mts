import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { TenantScope } from '@/lib/rag/tenant/scope';

type Row = Record<string, unknown>;

const MARKDOWN = [
  '# Warehouse Handbook',
  '',
  'Forklift batteries rotate every shift under the zebra quartz seventeen policy.',
  '',
  '## Receiving Dock',
  '',
  'Pallets arriving at the receiving dock are scanned by the night crew and staged beside bay four.',
  '',
  '## Shipping Cage',
  '',
  'Outbound pallets leave through the shipping cage after the supervisor signs the manifest.',
  '',
].join('\n');

const PHRASE = 'heliotrope marmalade quasar';

const SECTION_QUERY = 'Pallets arriving at the receiving dock are scanned by the night crew and staged beside bay four.';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };

describe('ingest tracer: one Markdown upload from ingest() to retrieval', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let runnerModule: typeof import('@/lib/rag/ingest/runner');
  let writerModule: typeof import('@/lib/rag/ingest/writer');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    ingestModule = await import('@/lib/rag/ingest');
    runnerModule = await import('@/lib/rag/ingest/runner');
    writerModule = await import('@/lib/rag/ingest/writer');
    depsModule = await import('@/lib/rag/ingest/deps');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(() => {
    objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
  });

  afterEach(() => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    mock.restoreAll();
  });

  const scopeOf = async (userId: string) => {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  };

  const upload = async (userId: string, text: string, filename: string) =>
    ingestModule.ingest({
      scope: await scopeOf(userId),
      source: 'config_upload',
      sourceKey: `root/${filename}`,
      text,
      filename,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

  const uploadFile = async (userId: string, file: Uint8Array, filename: string, mimeType: string) =>
    ingestModule.ingest({
      scope: await scopeOf(userId),
      source: 'config_upload',
      sourceKey: `root/${filename}`,
      file,
      filename,
      mimeType,
      signal: new AbortController().signal,
    });

  interface RecordedRpc {
    fn: string;
    args: Record<string, unknown>;
  }

  /** The real admin client behind a recorder; `failures` answers named functions with a database error instead. */
  const recordingDb = (failures: Record<string, { code: string; message: string }> = {}, passthrough = true) => {
    const calls: RecordedRpc[] = [];
    const real = supabaseModule.getSupabaseAdmin() as unknown as RpcClient;
    const db: RpcClient = {
      rpc(fn, args) {
        calls.push({ fn, args });
        const failure = failures[fn];
        if (!failure && passthrough) return real.rpc(fn, args);
        const response: RpcResponse = failure ? { data: null, error: failure } : { data: null, error: { code: 'XX000', message: 'refused' } };
        const request = {
          abortSignal: () => request,
          then: (onFulfilled: Parameters<Promise<RpcResponse>['then']>[0], onRejected: Parameters<Promise<RpcResponse>['then']>[1]) =>
            Promise.resolve(response).then(onFulfilled, onRejected),
        };
        return request as unknown as ReturnType<RpcClient['rpc']>;
      },
    };
    return { db, calls };
  };

  const captureConsole = () => {
    const lines: string[] = [];
    for (const method of ['error', 'warn', 'log', 'info'] as const) {
      mock.method(console, method, (...args: unknown[]) => {
        lines.push(`${method}: ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}`);
      });
    }
    return lines;
  };

  const rows = async (sql: string, params: unknown[]): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  let first: Awaited<ReturnType<typeof upload>>;

  test('a Markdown upload becomes a ready version-1 document with section-path chunks', async () => {
    first = await upload(TWO_TENANT_IDS.userA, MARKDOWN, 'warehouse-handbook.md');
    assert.equal(first.status, 'ready');
    assert.equal(first.version, 1);
    assert.equal(first.parserUsed, 'text');
    assert.ok(first.documentId);

    const documents = await rows('SELECT * FROM documents WHERE id = $1', [first.documentId]);
    assert.equal(documents.length, 1);
    const document = documents[0] as Row;
    assert.equal(document.is_current, true);
    assert.equal(document.status, 'ready');
    assert.equal(document.doc_type, 'general');
    assert.equal(document.tenant_key, `u:${TWO_TENANT_IDS.userA}`);
    assert.ok(document.file_sha256);
    assert.ok(document.content_hash);

    const chunks = await rows(
      'SELECT content, chunk_index, section_path, embedding_text_version, metadata, embedding IS NOT NULL AS embedded, is_current, status FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [first.documentId],
    );
    assert.equal(chunks.length, first.chunkCount);
    assert.deepEqual(
      chunks.map((chunk) => chunk.section_path),
      [['Warehouse Handbook'], ['Warehouse Handbook', 'Receiving Dock'], ['Warehouse Handbook', 'Shipping Cage']],
    );
    for (const [index, chunk] of chunks.entries()) {
      const content = String(chunk.content);
      assert.ok(!content.startsWith('Document:'), 'content carries no document prefix');
      assert.ok(!/Chunk \d+ of \d+/.test(content), 'content carries no chunk counter');
      assert.ok(!content.includes('Warehouse Handbook'), 'content carries no path prefix');
      assert.equal(chunk.embedding_text_version, 1);
      assert.equal(chunk.embedded, true);
      assert.equal(chunk.is_current, true);
      assert.equal(chunk.status, 'ready');
      const metadata = chunk.metadata as Row;
      assert.equal(metadata.document_title, 'warehouse-handbook.md');
      assert.equal(metadata.chunk_index, index);
      assert.equal(metadata.chunk_position, index + 1);
      assert.equal(metadata.total_chunks, chunks.length);
    }
    assert.ok(String(chunks[1]?.content).includes('receiving dock'));
  });

  test('the published version carries its ingestion fingerprint, built from the parts stored beside it, and no ledger row (D-10)', async () => {
    assert.ok(first?.documentId, 'the first test ingested the document');
    const { buildIngestFingerprint } = await import('@/lib/rag/ingest/fingerprint');
    const [document] = await rows('SELECT ingest_fingerprint, metadata FROM documents WHERE id = $1', [first.documentId]);
    assert.ok(document);
    const parts = (document.metadata as Row).ingest_fingerprint_parts as Parameters<typeof buildIngestFingerprint>[0];
    assert.ok(parts, 'metadata.ingest_fingerprint_parts is stored');
    assert.equal(parts.parser_used, 'text');
    assert.equal(parts.processing_profile_id, 'general@1');
    assert.match(String(document.ingest_fingerprint), /^[0-9a-f]{64}$/);
    assert.equal(document.ingest_fingerprint, buildIngestFingerprint(parts));
    assert.deepEqual(await rows('SELECT id FROM ingestion_jobs WHERE document_id = $1', [first.documentId]), [], 'an inline run writes no ledger row');
  });

  test('retrieval returns the ingested chunk for its tenant and never for the other tenant', async () => {
    assert.ok(first?.documentId, 'the first test ingested the document');
    const retrieve = async (userId: string) =>
      rag.runRetrieval({
        scope: await scopeOf(userId),
        query: SECTION_QUERY,
        profile: 'eval',
        options: OPTIONS,
        signal: new AbortController().signal,
      });

    const forA = await retrieve(TWO_TENANT_IDS.userA);
    const hit = forA.candidates.find((candidate) => candidate.document_id === first.documentId);
    assert.ok(hit, 'tenant A retrieves a chunk of its ingested document');
    assert.ok(hit.content.includes('receiving dock'));

    const forB = await retrieve(TWO_TENANT_IDS.userB);
    assert.equal(
      forB.candidates.some((candidate) => candidate.document_id === first.documentId),
      false,
      'tenant B never retrieves it',
    );
  });

  test('INGEST_STAGES lists the thirteen D-02 stages in order', () => {
    assert.deepEqual(
      [...runnerModule.INGEST_STAGES],
      [
        'identify',
        'file_hash_dedup',
        'store_original',
        'parse',
        'content_hash_dedup',
        'scan_injection',
        'chunk',
        'enrich',
        'extract',
        'images',
        'embed',
        'write',
        'publish',
      ],
    );
  });

  test('the same bytes ingested twice for tenant A return skipped_duplicate and add no chunks', async () => {
    const text = `# Duplicate Bytes\n\nThe amber ledger records every pallet moved across the north apron.\n`;
    const original = await upload(TWO_TENANT_IDS.userA, text, 'dup-bytes-one.md');
    assert.equal(original.status, 'ready');
    const chunkCount = async () => Number((await rows('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1', [original.documentId]))[0]?.n);
    const before = await chunkCount();

    const again = await upload(TWO_TENANT_IDS.userA, text, 'dup-bytes-two.md');
    assert.equal(again.status, 'skipped_duplicate');
    assert.equal(again.duplicateOf, original.documentId);
    assert.equal(again.documentId, null);
    assert.equal(again.chunkCount, 0);
    assert.equal(await chunkCount(), before);
    const sameBytes = await rows('SELECT count(*)::int AS n FROM documents WHERE file_sha256 = (SELECT file_sha256 FROM documents WHERE id = $1)', [original.documentId]);
    assert.equal(sameBytes[0]?.n, 1, 'no second row for the same bytes');
  });

  test('the same bytes for another tenant are ingested normally', async () => {
    const text = `# Shared Bytes\n\nThe cobalt manifest lists every crate on the west pier.\n`;
    const forA = await upload(TWO_TENANT_IDS.userA, text, 'shared-bytes.md');
    const forB = await upload(TWO_TENANT_IDS.userB, text, 'shared-bytes.md');
    assert.equal(forA.status, 'ready');
    assert.equal(forB.status, 'ready');
    assert.notEqual(forA.documentId, forB.documentId);
    const owner = await rows('SELECT tenant_key FROM documents WHERE id = $1', [forB.documentId]);
    assert.equal(owner[0]?.tenant_key, `u:${TWO_TENANT_IDS.userB}`);
  });

  test('the same Markdown with CRLF line endings is a content duplicate and its version is deleted', async () => {
    const lf = `# Line Endings\n\nThe copper tally sheet is filed by the dispatch clerk each evening.\n\nA second paragraph closes the sheet.\n`;
    const crlf = lf.replace(/\n/g, '\r\n');
    const original = await upload(TWO_TENANT_IDS.userA, lf, 'crlf-one.md');
    assert.equal(original.status, 'ready');

    const again = await upload(TWO_TENANT_IDS.userA, crlf, 'crlf-two.md');
    assert.equal(again.status, 'skipped_duplicate');
    assert.equal(again.duplicateOf, original.documentId);

    const tombstones = await rows(
      "SELECT id, status, (SELECT count(*)::int FROM document_chunks c WHERE c.document_id = d.id) AS chunks FROM documents d WHERE d.metadata->>'duplicate_of' = $1",
      [original.documentId],
    );
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0]?.status, 'deleted');
    assert.equal(tombstones[0]?.chunks, 0);
  });

  test('a PDF the tracer parser cannot read fails with no_parser_available and its version is marked failed', async () => {
    const pdf = new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n', 'utf8'));
    const result = await uploadFile(TWO_TENANT_IDS.userA, pdf, 'scan-one.pdf', 'application/pdf');
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'no_parser_available');
    assert.ok(result.documentId, 'the version row exists');

    const version = await rows(
      'SELECT status, is_current, processing_state, (SELECT count(*)::int FROM document_chunks c WHERE c.document_id = d.id) AS chunks FROM documents d WHERE d.id = $1',
      [result.documentId],
    );
    assert.equal(version[0]?.status, 'failed');
    assert.equal(version[0]?.is_current, false);
    assert.equal(version[0]?.chunks, 0);
    assert.equal((version[0]?.processing_state as Row).failure_reason, 'no_parser_available');
  });

  test('a failed rag_write_chunks surfaces as IngestWriterError and no log line or message carries document text', async () => {
    const failure = { code: '57014', message: `canceling statement while processing "${PHRASE}"` };
    const text = `# Leak Check\n\nThe ${PHRASE} entry must never reach a log line.\n`;

    const writer = writerModule.createIngestWriter({
      db: recordingDb({ rag_write_chunks: failure }).db,
      scope: await scopeOf(TWO_TENANT_IDS.userA),
      signal: new AbortController().signal,
    });
    const thrown = await writer
      .writeChunks('00000000-0000-4000-8000-0000000000f1', [], { embeddings: null, final: false, total: 0 })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(thrown instanceof writerModule.IngestWriterError);
    assert.equal(thrown.rpc, 'rag_write_chunks');
    assert.equal(thrown.code, '57014');
    assert.ok(!thrown.message.includes(PHRASE));

    const { db, calls } = recordingDb({ rag_write_chunks: failure });
    depsModule.setIngestDepsForTests({ db: () => db });
    const lines = captureConsole();
    const result = await upload(TWO_TENANT_IDS.userA, text, 'leak-check.md');

    assert.equal(result.status, 'failed');
    assert.ok(result.documentId);
    assert.ok(calls.some((call) => call.fn === 'rag_mark_document_failed'), 'the version was marked failed');
    const stored = await rows('SELECT status FROM documents WHERE id = $1', [result.documentId]);
    assert.equal(stored[0]?.status, 'failed');

    const ingestErrors = lines.filter((line) => line.startsWith('error: [Ingest]'));
    assert.equal(ingestErrors.length, 1, 'one [Ingest] error line');
    assert.ok(ingestErrors[0]?.includes('IngestWriterError'));
    assert.ok(ingestErrors[0]?.includes('rag_write_chunks'));
    assert.ok(ingestErrors[0]?.includes('57014'));
    for (const line of lines) assert.ok(!line.includes(PHRASE), `no log line carries document text: ${line.slice(0, 80)}`);
  });

  test('an object shaped like a scope is refused in identify before any RPC', async () => {
    const forged = { kind: 'personal', userId: TWO_TENANT_IDS.userA, organizationId: null } as unknown as TenantScope;
    const { db, calls } = recordingDb();
    depsModule.setIngestDepsForTests({ db: () => db });
    captureConsole();

    const result = await ingestModule.ingest({
      scope: forged,
      source: 'config_upload',
      sourceKey: 'root/forged.md',
      text: '# Forged\n\nA forged scope must never reach the database.\n',
      filename: 'forged.md',
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'invalid_scope');
    assert.equal(result.documentId, null);
    assert.equal(calls.length, 0);
  });

  test('the writer takes tenant key and ids from the scope, and sends no user id for a single-tenant scope', async () => {
    const send = async (scope: TenantScope) => {
      const { db, calls } = recordingDb({}, false);
      depsModule.setIngestDepsForTests({ db: () => db });
      captureConsole();
      await ingestModule.ingest({
        scope,
        source: 'chat_upload',
        sourceKey: 'root/scope-args.md',
        text: '# Scope\n\nArguments follow the scope.\n',
        filename: 'scope-args.md',
        mimeType: 'text/markdown',
        signal: new AbortController().signal,
      });
      mock.restoreAll();
      return calls.find((call) => call.fn === 'rag_begin_document_version')?.args;
    };

    const personal = await send(await scopeOf(TWO_TENANT_IDS.userA));
    assert.equal(personal?.p_tenant_key, `u:${TWO_TENANT_IDS.userA}`);
    assert.equal(personal?.p_user_id, TWO_TENANT_IDS.userA);
    assert.equal(personal?.p_org_id, null);

    const single = await resolver.resolveTenantScope({ deploymentMode: 'single-tenant', signal: new AbortController().signal });
    assert.ok(single.ok && single.scope);
    const singleArgs = await send(single.scope);
    assert.equal(singleArgs?.p_tenant_key, 's:default');
    assert.equal(singleArgs?.p_user_id, null);
    assert.equal(singleArgs?.p_org_id, null);
  });
});
