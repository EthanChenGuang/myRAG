import { after, afterEach, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { TenantScope } from '@/lib/rag';

type Row = Record<string, unknown>;

const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };
const TOKEN = 'zqxsoftdel8871';
const FILENAME = 'shipment-log.md';
const markdown = (body: string) => `# Shipment log\n\n${body}\n`;

describe('soft delete lineage (D-27)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let softDeleteModule: typeof import('@/lib/rag/ingest/soft-delete');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let fetchRows: typeof import('@/lib/rag/context/fetch-rows');

  let scopeA: TenantScope;
  let caseCounter = 0;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    ingestModule = await import('@/lib/rag/ingest');
    softDeleteModule = await import('@/lib/rag/ingest/soft-delete');
    depsModule = await import('@/lib/rag/ingest/deps');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    fetchRows = await import('@/lib/rag/context/fetch-rows');
    scopeA = await scopeOf(TWO_TENANT_IDS.userA);
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  afterEach(() => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    mock.restoreAll();
  });

  async function scopeOf(userId: string) {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  }

  async function ingestReady(scope: TenantScope, token: string) {
    objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
    caseCounter += 1;
    const sourceKey = `archive/case-${caseCounter}-${token}.md`;
    const body = `${TOKEN} ${token} case ${caseCounter}: pier schedules and dock manifests.`;
    const ready = await ingestModule.ingest({
      scope,
      source: 'config_upload',
      sourceKey,
      text: markdown(body),
      filename: FILENAME,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });
    assert.equal(ready.status, 'ready');
    assert.ok(ready.documentId);
    const lineageRow = await rows('SELECT lineage_id FROM documents WHERE id = $1', [ready.documentId]);
    const lineageId = String(lineageRow[0]?.lineage_id ?? ready.documentId);
    const chunkIds = (await rows('SELECT id FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [ready.documentId])).map((row) =>
      String(row.id),
    );
    assert.ok(chunkIds.length > 0);
    return { ready, lineageId, chunkIds, query: body };
  }

  const rows = async (sql: string, params: unknown[]): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  const softDelete = async (scope: TenantScope, lineage: string, source: 'config_upload' | 'nango' = 'config_upload') =>
    softDeleteModule.softDeleteLineage(scope, lineage, source, { signal: new AbortController().signal });

  const retrieve = async (scope: TenantScope, query: string) =>
    rag.runRetrieval({
      scope,
      query,
      profile: 'eval',
      options: OPTIONS,
      signal: new AbortController().signal,
    });

  test('soft delete clears current flags, keeps rows, sets status deleted and writes one delete ledger row', async () => {
    const { lineageId } = await ingestReady(scopeA, 'ledger');
    const beforeJobs = await rows('SELECT count(*)::int AS n FROM ingestion_jobs WHERE kind = $1 AND lineage_id = $2::uuid', ['delete', lineageId]);
    const result = await softDelete(scopeA, lineageId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.outcome, 'deleted');

    const flags = await rows(
      `SELECT d.is_current AS doc_current, d.status AS doc_status, c.is_current AS chunk_current, c.status AS chunk_status
         FROM documents d JOIN document_chunks c ON c.document_id = d.id
        WHERE d.lineage_id = $1`,
      [lineageId],
    );
    assert.ok(flags.length > 0);
    for (const row of flags) {
      assert.equal(row.doc_current, false);
      assert.equal(row.chunk_current, false);
      assert.equal(row.doc_status, 'deleted');
      assert.equal(row.chunk_status, 'deleted');
    }
    assert.equal((await rows('SELECT 1 FROM documents WHERE lineage_id = $1 AND is_current', [lineageId])).length, 0);
    assert.equal(
      (await rows('SELECT 1 FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.lineage_id = $1 AND c.is_current', [lineageId]))
        .length,
      0,
    );

    const jobs = await rows(
      `SELECT kind, status, source FROM ingestion_jobs WHERE kind = 'delete' AND lineage_id = $1::uuid ORDER BY created_at`,
      [lineageId],
    );
    assert.equal(jobs.length, (beforeJobs[0]?.n as number) + 1);
    assert.deepEqual(jobs.at(-1), { kind: 'delete', status: 'ready', source: 'config_upload' });
  });

  test('retrieval drops the lineage while stored citations still resolve', async () => {
    const { lineageId, chunkIds, query, ready } = await ingestReady(scopeA, 'retrieval');
    await softDelete(scopeA, lineageId);
    const hit = await retrieve(scopeA, query);
    const docIds = (await rows('SELECT id FROM documents WHERE lineage_id = $1', [lineageId])).map((row) => String(row.id));
    assert.equal(
      hit.candidates.some((candidate) => chunkIds.includes(candidate.chunk_id) || docIds.includes(candidate.document_id)),
      false,
      'no chunk of the lineage is retrieved',
    );

    const admin = supabaseModule.getSupabaseAdmin();
    const assembled = await fetchRows.fetchAssemblyRows(
      [{ chunk_id: chunkIds[0] as string, document_id: ready.documentId as string }] as unknown as Parameters<
        typeof fetchRows.fetchAssemblyRows
      >[0],
      { adminClient: admin, signal: new AbortController().signal },
    );
    assert.ok(assembled.chunkMetadata.has(chunkIds[0] as string));
    const chunk = await admin.from('document_chunks').select('content').eq('id', chunkIds[0] as string);
    assert.equal(chunk.error, null);
    assert.ok(String(chunk.data?.[0]?.content).includes(TOKEN));
  });

  test('a lineage of another tenant raises 22023 and changes nothing', async () => {
    const scopeB = await scopeOf(TWO_TENANT_IDS.userB);
    const { lineageId: lineageB } = await ingestReady(scopeB, 'tenant-b');
    await ingestReady(scopeA, 'tenant-a');

    const result = await softDelete(scopeA, lineageB);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'tenant_mismatch');

    const untouched = await rows('SELECT status, is_current FROM documents WHERE lineage_id = $1', [lineageB]);
    assert.ok(untouched.every((row) => row.status === 'ready' && row.is_current === true));
  });

  test('a second soft delete is a no-op and does not add another ledger row', async () => {
    const { lineageId } = await ingestReady(scopeA, 'idempotent');
    const first = await softDelete(scopeA, lineageId);
    assert.equal(first.ok, true);
    const jobsAfterFirst = await rows(`SELECT count(*)::int AS n FROM ingestion_jobs WHERE kind = 'delete' AND lineage_id = $1::uuid`, [lineageId]);
    const second = await softDelete(scopeA, lineageId);
    assert.equal(second.ok, true);
    if (!second.ok || !first.ok) return;
    assert.equal(second.outcome, 'already_deleted');
    const jobsAfterSecond = await rows(`SELECT count(*)::int AS n FROM ingestion_jobs WHERE kind = 'delete' AND lineage_id = $1::uuid`, [lineageId]);
    assert.equal(jobsAfterSecond[0]?.n, jobsAfterFirst[0]?.n);
  });

  test('anon and authenticated cannot execute rag_soft_delete_document', async () => {
    const { lineageId } = await ingestReady(scopeA, 'grants');
    const exposure = await rows(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rag_soft_delete_document'`,
      [],
    );
    assert.equal(exposure.length, 1);
    assert.deepEqual(
      { anon: exposure[0]?.anon, authenticated: exposure[0]?.authenticated, service: exposure[0]?.service },
      { anon: false, authenticated: false, service: true },
    );

    for (const role of ['anon', 'authenticated'] as const) {
      await fixture.db.exec(`SET ROLE ${role}`);
      try {
        await assert.rejects(
          () => fixture.db.query('SELECT * FROM rag_soft_delete_document($1, $2::uuid, $3)', [`u:${TWO_TENANT_IDS.userA}`, lineageId, 'config_upload']),
          /permission denied|42501/i,
        );
      } finally {
        await fixture.db.exec('RESET ROLE');
      }
    }
  });
});