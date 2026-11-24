import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { TenantScope } from '@/lib/rag/tenant/scope';

const LEGACY = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-2048';
const VOYAGE_MODEL = 'voyage-4-large';
const PROFILE = 'p256';
const RETIRED = 'p256-retired';
const EMPTY_TYPE = 'p256-invoice';
const WRITE_PATH = '/rest/v1/rpc/rag_write_profile_chunks';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string;
}

const A: Tenant = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
const B: Tenant = { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB };

function vector(dims: number, hot: number): number[] {
  return Array.from({ length: dims }, (_, index) => (index === hot % dims ? 1 : 0));
}

function contractText(label: string): string {
  return [
    `# Supply Agreement ${label}`,
    '',
    '## 1. Definitions',
    '',
    `In this agreement ${label} means the buyer and the supplier of forklifts and pallets named in the schedule.`,
    '',
    '## 2. Delivery',
    '',
    `The supplier shall deliver the equipment of ${label} within thirty days of the order and shall bear the transport risk until the apron.`,
    '',
    '## 3. Warranty',
    '',
    `The supplier warrants every forklift of ${label} for twelve months. Defects reported inside that period are repaired at no charge.`,
    '',
    '## 4. Termination',
    '',
    `Either party may terminate ${label} with ninety days of written notice when the other party breaches a material clause.`,
    '',
  ].join('\n');
}

describe('rechunk job (src/lib/rag/ingest/rechunk)', () => {
  let fixture: TwoTenantDatabase;
  let edge: import('../../eval/harness/fake-edge.mts').FakeEdge;
  let rechunk: typeof import('@/lib/rag/ingest/rechunk/run');
  let costModule: typeof import('@/lib/rag/ingest/rechunk/cost');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let registryModule: typeof import('@/lib/rag/embeddings/registry');
  let activeModule: typeof import('@/lib/rag/embeddings/active-profile');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let cliModule: typeof import('@/lib/rag/ingest/rechunk/cli');
  let childEnv: Record<string, string> = {};
  let store: import('../helpers/fake-object-store').FakeObjectStore;
  let embeddedTexts: string[] = [];
  let embedMode: 'ok' | 'throw' = 'ok';
  const outbound: string[] = [];
  const realFetch = globalThis.fetch;
  const docs: { a1: string; a2: string; b1: string; legacyA: string; generalA: string } = { a1: '', a2: '', b1: '', legacyA: '', generalA: '' };

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const db = () => depsModule.getIngestDeps().db() as RpcClient;

  const scopeFor = async (tenantKey: string): Promise<TenantScope | null> => {
    if (tenantKey === A.key) return scopeModule.mintScope('personal', A.userId, null);
    if (tenantKey === B.key) return scopeModule.mintScope('personal', B.userId, null);
    return null;
  };

  const useEnv = (env: Record<string, string>) => {
    configModule.resetIngestConfigForTests();
    depsModule.setIngestDepsForTests({
      ingestEnv: () => env,
      embedDocuments: async (texts) => {
        if (embedMode === 'throw') throw new Error('vendor unavailable');
        embeddedTexts.push(...texts);
        return texts.map((text, index) => vector(1536, text.length + index));
      },
    });
    activeModule.resetActiveProfileForTests();
  };

  async function upload(tenant: Tenant, label: string, docType: 'contract_legal' | 'general'): Promise<string> {
    const result = await ingestModule.ingest({
      scope: scopeModule.mintScope('personal', tenant.userId, null),
      source: 'config_upload',
      sourceKey: `root/${label}.md`,
      text: contractText(label),
      filename: `${label}.md`,
      mimeType: 'text/markdown',
      docType,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'ready', `${label} ingests`);
    return String(result.documentId);
  }

  /** A contract written before Phase 3: published chunks, no stored parse output. */
  async function seedLegacyContract(tenant: Tenant, label: string): Promise<string> {
    const sourceKey = `${label}.md`;
    const begun = await rows(
      `SELECT * FROM rag_begin_document_version(
         p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL, p_source => 'config_upload', p_source_key => $3, p_filename => $3,
         p_file_sha256 => $4, p_doc_type => 'contract_legal', p_doc_type_origin => 'fallback', p_profile_id => 'contract_legal@1', p_profile_version => 1)`,
      [tenant.key, tenant.userId, sourceKey, crypto.createHash('sha256').update(sourceKey).digest('hex')],
    );
    const documentId = String(begun[0]?.document_id);
    const chunk = { content: `${label} supplier warranty clause`, chunk_index: 0, section_path: ['Contract'], chunk_kind: 'text', embedding_text_version: 1, metadata: {} };
    await rows('SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => NULL, p_final => true, p_total => 1)', [
      documentId,
      tenant.key,
      JSON.stringify([chunk]),
    ]);
    await rows('SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, tenant.key]);
    return documentId;
  }

  before(async () => {
    const { fixtureProcessEnv, startFakeEdge } = await import('../../eval/harness/fake-edge.mts');
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    childEnv = fixtureProcessEnv(edge.url);
    Object.assign(process.env, childEnv);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(edge.url)) outbound.push(url);
      return realFetch(input, init);
    }) as typeof fetch;
    rechunk = await import('@/lib/rag/ingest/rechunk/run');
    costModule = await import('@/lib/rag/ingest/rechunk/cost');
    cliModule = await import('@/lib/rag/ingest/rechunk/cli');
    depsModule = await import('@/lib/rag/ingest/deps');
    configModule = await import('@/lib/rag/ingest/config');
    registryModule = await import('@/lib/rag/embeddings/registry');
    activeModule = await import('@/lib/rag/embeddings/active-profile');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    ingestModule = await import('@/lib/rag/ingest');
    scopeModule = await import('@/lib/rag/tenant/scope');
    store = (await import('../helpers/fake-object-store')).createFakeObjectStore();
    objectStoreModule.setObjectStoreForTests(store);
    await fixture.db.exec(`
      INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
      VALUES ('${PROFILE}', 'contract_legal', 256, 'structure', 1024, 'building', '256/1024'),
             ('${RETIRED}', 'contract_legal', 256, 'structure', 1024, 'retired', '256/1024'),
             ('${PROFILE}', 'general', 256, 'structure', 1024, 'building', '256/1024'),
             ('${EMPTY_TYPE}', 'invoice_receipt', 256, 'structure', 1024, 'building', '256/1024')
      ON CONFLICT DO NOTHING`);
    await fixture.db.exec(`DELETE FROM chunking_profiles WHERE id = '${PROFILE}' AND doc_type = 'general'`);
    useEnv({ RAG_EMBEDDING_PROFILES: 'off' });
    docs.a1 = await upload(A, 'rechunk-a1', 'contract_legal');
    docs.a2 = await upload(A, 'rechunk-a2', 'contract_legal');
    docs.b1 = await upload(B, 'rechunk-b1', 'contract_legal');
    docs.generalA = await upload(A, 'rechunk-general', 'general');
    docs.legacyA = await seedLegacyContract(A, 'rechunk-legacy');
  });

  after(async () => {
    globalThis.fetch = realFetch;
    objectStoreModule?.resetObjectStoreForTests();
    depsModule?.resetIngestDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(async () => {
    embeddedTexts = [];
    embedMode = 'ok';
    outbound.length = 0;
    await fixture.db.exec(`
      DELETE FROM chunking_build_gaps;
      DELETE FROM chunking_build_runs;
      DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE chunking_profile_id <> 'legacy');
      DELETE FROM document_chunks WHERE chunking_profile_id <> 'legacy';
      DELETE FROM document_parents;
      UPDATE chunking_profiles SET status = 'building', activated_at = NULL, activated_by = NULL WHERE id = '${PROFILE}';
      UPDATE chunking_profiles SET status = 'active' WHERE id = 'legacy' AND doc_type = 'contract_legal';
      UPDATE documents SET status = 'ready' WHERE id = '${docs.legacyA}';
      UPDATE embedding_profiles SET status = 'available', activated_at = NULL, activated_by = NULL, previous_active_id = NULL;
      UPDATE embedding_profiles SET status = 'active', activated_at = now() - interval '2 hours' WHERE id = '${LEGACY}';
    `);
    useEnv({ RAG_EMBEDDING_PROFILES: 'off' });
    store.calls.length = 0;
    edge.calls.length = 0;
  });

  afterEach(() => {
    registryModule.resetEmbeddingProvidersForTests();
    activeModule.resetActiveProfileForTests();
  });

  const writeCalls = (): number => edge.calls.filter((call) => call.path === WRITE_PATH).length;
  const profileStatus = async (id = PROFILE): Promise<string> =>
    String((await rows(`SELECT status FROM chunking_profiles WHERE id = $1 AND doc_type = 'contract_legal'`, [id]))[0]?.status);
  const childrenOf = (documentId: string, profileId = PROFILE): Promise<Row[]> =>
    rows('SELECT id, parent_id, status, is_current, tenant_key FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2 ORDER BY chunk_index', [documentId, profileId]);
  const parentsOf = (documentId: string, profileId = PROFILE): Promise<Row[]> =>
    rows('SELECT id, tenant_key FROM document_parents WHERE document_id = $1 AND chunking_profile_id = $2', [documentId, profileId]);
  const runRow = async (runId: string): Promise<Row> => (await rows('SELECT * FROM chunking_build_runs WHERE id = $1', [runId]))[0] as Row;
  const filled = async (): Promise<string[]> =>
    (await rows(`SELECT DISTINCT document_id FROM document_chunks WHERE chunking_profile_id = $1 ORDER BY 1`, [PROFILE])).map((row) => String(row.document_id));

  test('builds parents and children of the three documents from stored parse output and records the legacy contract as a gap', async () => {
    const report = await rechunk.runRechunk({ db: db(), profileId: PROFILE, scopeFor });
    assert.equal(report.reason, null);
    assert.equal(report.status, 'incomplete', 'a document without parse output keeps the run incomplete');
    assert.equal(report.documentsWritten, 3);
    assert.equal(report.documentsGapped, 1);
    assert.equal(report.docType, 'contract_legal');
    assert.equal(report.profileStatus, 'building', 'the profile stays building while a document is missing children');
    assert.equal(await profileStatus(), 'building');
    assert.deepEqual(new Set(await filled()), new Set([docs.a1, docs.a2, docs.b1]));

    for (const [documentId, tenant] of [[docs.a1, A], [docs.a2, A], [docs.b1, B]] as const) {
      const children = await childrenOf(documentId);
      assert.ok(children.length >= 1, 'the document has children');
      assert.ok(children.every((child) => child.parent_id !== null), 'children point to a parent');
      assert.ok(children.every((child) => child.tenant_key === tenant.key && child.is_current === true));
      const parents = await parentsOf(documentId);
      assert.ok(parents.length >= 1 && parents.every((parent) => parent.tenant_key === tenant.key));
    }
    assert.equal((await childrenOf(docs.legacyA)).length, 0, 'a gap document gets no children');
    assert.equal((await childrenOf(docs.generalA)).length, 0, 'documents of another type are left alone');

    const gaps = await rows('SELECT document_id, reason FROM chunking_build_gaps WHERE run_id = $1', [report.runId]);
    assert.deepEqual(gaps.map((gap) => [String(gap.document_id), gap.reason]), [[docs.legacyA, 'no_parse_output']]);
    assert.deepEqual(report.gaps.map((gap) => [gap.documentId, gap.reason, gap.tenantKey]), [[docs.legacyA, 'no_parse_output', A.key]]);
    const run = await runRow(report.runId);
    assert.equal(run.status, 'incomplete');
    assert.equal(run.docs_done, 4);
    assert.equal(run.doc_type, 'contract_legal');

    assert.deepEqual(outbound, [], 'no request left for anything but the database: no parser, sidecar or LlamaParse call');
    assert.ok(store.calls.length >= 3);
    assert.ok(store.calls.every((call) => call.op === 'get' && call.key.endsWith('/parse.md')), 'the object store was only read, and only for parse.md');
    assert.ok(embeddedTexts.length >= 3, 'the children were embedded');
  });

  test('the profile becomes ready when no current ready document of the type is missing children, and a second run writes nothing', async () => {
    await fixture.db.query(`UPDATE documents SET status = 'deleted' WHERE id = $1`, [docs.legacyA]);
    const first = await rechunk.runRechunk({ db: db(), profileId: PROFILE, scopeFor });
    assert.equal(first.status, 'completed');
    assert.equal(first.documentsWritten, 3);
    assert.equal(first.profileStatus, 'ready');
    assert.equal(await profileStatus(), 'ready');
    assert.equal((await runRow(first.runId)).status, 'completed');

    edge.calls.length = 0;
    embeddedTexts = [];
    const second = await rechunk.runRechunk({ db: db(), profileId: PROFILE, scopeFor });
    assert.equal(second.status, 'completed');
    assert.equal(second.documentsWritten, 0);
    assert.equal(writeCalls(), 0, 'complete documents are not rewritten');
    assert.deepEqual(embeddedTexts, [], 'complete documents are not embedded again');
    assert.equal(await profileStatus(), 'ready', 'a ready profile stays ready');
  });

  test('a run killed after its first document resumes from its cursor and writes each other document once', async () => {
    const controller = new AbortController();
    await assert.rejects(
      rechunk.runRechunk({
        db: db(),
        profileId: PROFILE,
        scopeFor,
        signal: controller.signal,
        hooks: { afterDocument: () => controller.abort(new Error('killed')) },
      }),
      /killed/,
    );
    const open = (await rows(`SELECT id, status, cursor_document_id, docs_done FROM chunking_build_runs`))[0] as Row;
    assert.equal(open.status, 'running');
    assert.equal(open.docs_done, 1);
    assert.ok(open.cursor_document_id, 'the cursor moved with the first document');

    const resumed = await rechunk.runRechunk({ db: db(), resumeRunId: String(open.id), scopeFor });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.runId, String(open.id));
    assert.equal(resumed.status, 'incomplete');
    assert.equal(writeCalls(), 3, 'three documents, each written once in total');
    assert.deepEqual(new Set(await filled()), new Set([docs.a1, docs.a2, docs.b1]));
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM chunking_build_runs'))[0]?.n), 1, 'a resume does not open another run');
    assert.equal((await runRow(String(open.id))).docs_done, 4);
  });

  test('--dry-run lists eligible and gap documents per tenant with child counts, tokens and a cost estimate, and writes nothing', async () => {
    const report = await rechunk.dryRunRechunk({ db: db(), profileId: PROFILE, batchSize: 2 });
    assert.equal(report.profileId, PROFILE);
    assert.equal(report.docType, 'contract_legal');
    assert.equal(report.profileStatus, 'building');
    const byTenant = new Map(report.tenants.map((tenant) => [tenant.tenantKey, tenant]));
    assert.equal(byTenant.get(A.key)?.eligibleDocuments, 2);
    assert.equal(byTenant.get(A.key)?.gapDocuments, 1);
    assert.equal(byTenant.get(B.key)?.eligibleDocuments, 1);
    assert.equal(byTenant.get(B.key)?.gapDocuments, 0);
    for (const tenant of report.tenants) {
      if (tenant.eligibleDocuments === 0) continue;
      assert.ok(tenant.children >= tenant.eligibleDocuments && tenant.parents >= tenant.eligibleDocuments && tenant.tokens > 0);
    }
    assert.deepEqual(report.gaps.map((gap) => [gap.documentId, gap.reason]), [[docs.legacyA, 'no_parse_output']]);
    const children = report.tenants.reduce((sum, tenant) => sum + tenant.children, 0);
    const tokens = report.tenants.reduce((sum, tenant) => sum + tenant.tokens, 0);
    assert.equal(report.cost.totals.chunks, children);
    assert.equal(report.cost.totals.tokens, tokens);
    assert.ok(report.cost.totals.usd > 0);
    assert.deepEqual(report.embeddingProfiles, [LEGACY]);

    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM chunking_build_runs'))[0]?.n), 0, 'a dry run opens no run');
    assert.equal((await filled()).length, 0);
    assert.equal(writeCalls(), 0);
    assert.deepEqual(embeddedTexts, []);
    assert.ok(!edge.calls.some((call) => /rag_rechunk_(start|advance|record|finish|resume)/.test(call.path)));
    assert.ok(store.calls.every((call) => call.op === 'get' && call.key.endsWith('/parse.md')));
  });

  test('runRechunkBatch with maxDocuments 1 processes one document per call on one run and reports progress until done', async () => {
    const reports: Awaited<ReturnType<typeof rechunk.runRechunkBatch>>[] = [];
    for (let call = 0; call < 8; call += 1) {
      const report = await rechunk.runRechunkBatch({ db: db(), profileId: PROFILE, maxDocuments: 1, scopeFor });
      reports.push(report);
      assert.ok(report.documentsWritten + report.documentsGapped <= 1);
      if (!report.more) break;
    }
    assert.equal(reports.length, 4, 'four eligible documents, one per call');
    assert.deepEqual(reports.slice(0, 3).map((report) => report.status), ['running', 'running', 'running']);
    assert.equal(reports[3]?.status, 'incomplete');
    assert.equal(new Set(reports.map((report) => report.runId)).size, 1, 'the calls continue one run');
    assert.deepEqual(reports.map((report) => report.docsDone), [1, 2, 3, 4]);
    assert.equal(writeCalls(), 3);
    assert.equal((await filled()).length, 3);
  });

  test('runRechunkBatch stops at a document boundary when its time budget is spent, after at least one document', async () => {
    const report = await rechunk.runRechunkBatch({ db: db(), profileId: PROFILE, deadlineMs: 1, scopeFor });
    assert.equal(report.documentsWritten + report.documentsGapped, 1);
    assert.equal(report.more, true);
    assert.equal(report.status, 'running');
    const next = await rechunk.runRechunkBatch({ db: db(), profileId: PROFILE, scopeFor });
    assert.equal(next.runId, report.runId);
    assert.equal(next.more, false);
    assert.equal(next.docsDone, 4);
  });

  test('--tenant restricts the run to one tenant, and the profile stays building while the other tenant lacks children', async () => {
    const report = await rechunk.runRechunk({ db: db(), profileId: PROFILE, tenantKey: B.key, scopeFor });
    assert.equal(report.status, 'completed', 'every document in scope has children');
    assert.equal(report.tenantKey, B.key);
    assert.equal(report.documentsWritten, 1);
    assert.deepEqual(await filled(), [docs.b1]);
    assert.equal(report.profileStatus, 'building', 'tenant A still lacks children');
    assert.equal((await runRow(report.runId)).tenant_key, B.key);
  });

  test('rechunk repairs an active profile in place', async () => {
    await rechunk.runRechunk({ db: db(), profileId: PROFILE, scopeFor });
    const before = new Map<string, string[]>();
    for (const id of [docs.a1, docs.a2, docs.b1]) before.set(id, (await childrenOf(id)).map((row) => String(row.id)));
    await fixture.db.query(`DELETE FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2`, [docs.a2, PROFILE]);
    await fixture.db.query(`DELETE FROM document_parents WHERE document_id = $1 AND chunking_profile_id = $2`, [docs.a2, PROFILE]);
    await fixture.db.exec(`
      UPDATE chunking_profiles SET status = 'ready' WHERE id = 'legacy' AND doc_type = 'contract_legal';
      UPDATE chunking_profiles SET status = 'active', activated_at = now(), activated_by = 'test' WHERE id = '${PROFILE}' AND doc_type = 'contract_legal';
    `);
    const registry = async () => rows('SELECT id, doc_type, status, activated_at, activated_by, previous_active_id FROM chunking_profiles ORDER BY doc_type, id');
    const snapshot = await registry();
    edge.calls.length = 0;
    embeddedTexts = [];
    outbound.length = 0;

    const report = await rechunk.runRechunk({ db: db(), profileId: PROFILE, scopeFor });
    assert.equal(report.documentsWritten, 1, 'only the contract without children is processed');
    assert.equal(writeCalls(), 1);
    const rebuilt = await childrenOf(docs.a2);
    assert.ok(rebuilt.length >= 1);
    assert.equal(embeddedTexts.length, rebuilt.length, 'only the rebuilt document was embedded');
    for (const id of [docs.a1, docs.b1]) {
      assert.deepEqual((await childrenOf(id)).map((row) => String(row.id)), before.get(id), 'a complete document keeps its rows');
    }
    assert.equal(report.profileStatus, 'active');
    assert.equal(await profileStatus(), 'active', 'the pointer never moves');
    assert.equal(await profileStatus('legacy'), 'ready');
    assert.deepEqual(await registry(), snapshot, 'chunking_profiles records no change');
    assert.equal(report.status, 'incomplete', 'the contract without parse output stays a gap');
    assert.deepEqual(outbound, []);
  });

  test('children are embedded for the active and the backfilling embedding profiles', async () => {
    await fixture.db.query(`UPDATE embedding_profiles SET status = 'backfilling' WHERE id = $1`, [VOYAGE]);
    const seen: string[] = [];
    registryModule.setEmbeddingProvidersForTests({
      voyage: {
        id: 'voyage',
        model: VOYAGE_MODEL,
        maxInputTokens: 8000,
        supportedDims: [1024, 2048],
        normalize: true,
        async embedDocuments(texts, opts) {
          seen.push(...texts);
          return { vectors: texts.map((text, index) => vector(opts.dims, text.length + index)), model: VOYAGE_MODEL, host: 'fake-host', usage: { tokens: texts.length * 10 } };
        },
        async embedQuery(text, opts) {
          return { vectors: [vector(opts.dims, text.length)], model: VOYAGE_MODEL, host: 'fake-host', usage: { tokens: 1 } };
        },
      },
    });
    useEnv({ RAG_EMBEDDING_PROFILES: 'on' });
    const report = await rechunk.runRechunk({ db: db(), profileId: PROFILE, tenantKey: B.key, scopeFor });
    assert.equal(report.status, 'completed');
    const children = await childrenOf(docs.b1);
    assert.ok(children.length >= 1);
    const legacyVectors = await rows(`SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2 AND embedding IS NOT NULL`, [docs.b1, PROFILE]);
    assert.equal(Number(legacyVectors[0]?.n), children.length, 'the active (legacy column) profile has a vector for every child');
    const halfvecs = await rows(`SELECT count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1 AND chunk_id = ANY($2::uuid[])`, [VOYAGE, children.map((child) => String(child.id))]);
    assert.equal(Number(halfvecs[0]?.n), children.length, 'the backfilling profile has a vector for every child');
    assert.equal(seen.length, children.length);
    assert.equal(embeddedTexts.length, children.length);
  });

  test('a failing active embedding target fails the run, writes nothing, and the run resumes', async () => {
    embedMode = 'throw';
    const failed = await rechunk.runRechunk({ db: db(), profileId: PROFILE, scopeFor });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'embed_failed');
    assert.equal((await filled()).length, 0);
    assert.equal(writeCalls(), 0);
    assert.equal((await runRow(failed.runId)).status, 'failed');
    assert.equal(await profileStatus(), 'building');

    embedMode = 'ok';
    const resumed = await rechunk.runRechunk({ db: db(), resumeRunId: failed.runId, scopeFor });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.documentsWritten, 3);
    assert.equal(resumed.status, 'incomplete');
  });

  test('each document is written under the scope of its own tenant: a wrong or refused scope leaves the document as a failed gap', async () => {
    const onlyA = async (tenantKey: string) => (tenantKey === A.key ? scopeFor(tenantKey) : tenantKey === B.key ? scopeFor(A.key) : null);
    const crossed = await rechunk.runRechunk({ db: db(), profileId: PROFILE, scopeFor: onlyA });
    assert.deepEqual(new Set(await filled()), new Set([docs.a1, docs.a2]), "the other tenant's document was refused by the writer");
    const refused = crossed.gaps.find((gap) => gap.documentId === docs.b1);
    assert.equal(refused?.reason, 'failed');
    assert.equal(refused?.detail, 'tenant_mismatch');
    assert.equal((await childrenOf(docs.b1)).length, 0);

    const none = await rechunk.runRechunk({ db: db(), profileId: PROFILE, tenantKey: B.key, scopeFor: async () => null });
    const noScope = none.gaps.find((gap) => gap.documentId === docs.b1);
    assert.equal(noScope?.reason, 'failed');
    assert.equal(noScope?.detail, 'tenant_scope_refused');
    assert.equal((await childrenOf(docs.b1)).length, 0);
  });

  test('refuses what it must not build: unknown, legacy and retired profiles, bad tenant keys and batch sizes, unknown and foreign runs', async () => {
    const code = (promise: Promise<unknown>) => promise.then(() => 'no error', (error: { code?: string }) => error.code ?? String(error));
    assert.equal(await code(rechunk.runRechunk({ db: db(), profileId: 'no-such-profile', scopeFor })), 'unknown_profile');
    assert.equal(await code(rechunk.runRechunk({ db: db(), profileId: 'legacy', scopeFor })), 'profile_is_legacy');
    assert.equal(await code(rechunk.runRechunk({ db: db(), profileId: RETIRED, scopeFor })), 'profile_retired');
    assert.equal(await code(rechunk.runRechunk({ db: db(), scopeFor })), 'profile_required');
    assert.equal(await code(rechunk.runRechunk({ db: db(), profileId: PROFILE, tenantKey: 'not-a-key', scopeFor })), 'invalid_tenant_key');
    assert.equal(await code(rechunk.runRechunk({ db: db(), profileId: PROFILE, batchSize: 0, scopeFor })), 'invalid_batch_size');
    assert.equal(await code(rechunk.runRechunk({ db: db(), resumeRunId: crypto.randomUUID(), scopeFor })), 'run_not_found');
    assert.equal(await code(rechunk.dryRunRechunk({ db: db(), profileId: 'legacy' })), 'profile_is_legacy');
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM chunking_build_runs'))[0]?.n), 0, 'a refused start opens no run');

    const first = await rechunk.runRechunk({ db: db(), profileId: PROFILE, tenantKey: B.key, scopeFor });
    assert.equal(await code(rechunk.runRechunk({ db: db(), resumeRunId: first.runId, tenantKey: A.key, scopeFor })), 'resume_mismatch');
    assert.equal(await code(rechunk.runRechunk({ db: db(), resumeRunId: first.runId, profileId: RETIRED, scopeFor })), 'resume_mismatch');
    assert.equal(await code(rechunk.runRechunk({ db: db(), resumeRunId: first.runId, scopeFor })), 'run_not_resumable', 'a completed run is not resumed');
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // CLI: npm run rag:rechunk
  // ---------------------------------------------------------------------------------------------------------------------------------

  const cli = async (argv: string[], extra: { scopeFor?: typeof scopeFor } = {}) => {
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    const code = await cliModule.main(argv, io, undefined, extra);
    return { code, output: lines.join('\n') };
  };

  test('CLI --dry-run prints the per-tenant table, the gap list and the cost, exits 0 and writes nothing', async () => {
    const { code, output } = await cli(['--profile', PROFILE, '--dry-run', '--batch-size', '2']);
    assert.equal(code, 0, output);
    assert.match(output, /dry run, nothing written/);
    assert.match(output, new RegExp(`profile ${PROFILE} \\(contract_legal, building`));
    assert.match(output, new RegExp(`${A.key}: documents 2, parents \\d+, children \\d+, tokens \\d+, estimated cost [0-9.]+ USD, without parse output 1`));
    assert.match(output, new RegExp(`${B.key}: documents 1`));
    assert.match(output, /total: documents 3, /);
    assert.match(output, new RegExp(`${docs.legacyA}[^\\n]*no_parse_output`), 'the gap document is listed');
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM chunking_build_runs'))[0]?.n), 0);
    assert.equal(writeCalls(), 0);
    assert.ok(!/sk-|service-role|apikey/i.test(output), 'no key material in the output');
  });

  test('CLI run prints the run id, the profile status and the gap list, and exits 3 while documents are missing children', async () => {
    const { code, output } = await cli(['--profile', PROFILE, '--batch-size', '2'], { scopeFor });
    assert.equal(code, 3, output);
    const runId = String((await rows('SELECT id FROM chunking_build_runs'))[0]?.id);
    assert.ok(output.includes(runId), 'the run id is printed');
    assert.match(output, /incomplete/);
    assert.match(output, /built 3 documents/);
    assert.match(output, new RegExp(`profile ${PROFILE} is building`));
    assert.match(output, new RegExp(`${docs.legacyA}[^\\n]*no_parse_output`));
    assert.equal(await profileStatus(), 'building');
  });

  test('CLI run exits 0 once nothing is missing and the profile is ready', async () => {
    await fixture.db.query(`UPDATE documents SET status = 'deleted' WHERE id = $1`, [docs.legacyA]);
    const { code, output } = await cli(['--profile', PROFILE], { scopeFor });
    assert.equal(code, 0, output);
    assert.match(output, /completed/);
    assert.match(output, new RegExp(`profile ${PROFILE} is ready`));
    assert.equal(await profileStatus(), 'ready');
  });

  test('CLI exits 1 with a resume hint when a run fails, and --resume finishes it', async () => {
    await fixture.db.query(`UPDATE documents SET status = 'deleted' WHERE id = $1`, [docs.legacyA]);
    embedMode = 'throw';
    const failed = await cli(['--profile', PROFILE], { scopeFor });
    assert.equal(failed.code, 1, failed.output);
    const runId = String((await rows('SELECT id FROM chunking_build_runs'))[0]?.id);
    assert.match(failed.output, /embed_failed/);
    assert.match(failed.output, new RegExp(`--resume ${runId}`));

    embedMode = 'ok';
    const resumed = await cli(['--resume', runId], { scopeFor });
    assert.equal(resumed.code, 0, resumed.output);
    assert.match(resumed.output, /completed/);
    assert.equal(await profileStatus(), 'ready');
  });

  test('CLI refuses wrong arguments with exit 2 and a usage line, and a refused profile with exit 2', async () => {
    for (const argv of [[], ['--dry-run'], ['--profile'], ['--profile', PROFILE, '--tenant', 'nope'], ['--profile', PROFILE, '--batch-size', '0'], ['--profile', PROFILE, '--bogus'], ['--resume', 'not-a-uuid'], ['--resume', crypto.randomUUID(), '--dry-run']]) {
      const { code, output } = await cli(argv);
      assert.equal(code, 2, `${argv.join(' ')}: ${output}`);
      assert.match(output, /usage: npm run rag:rechunk/);
    }
    for (const [profile, reason] of [['legacy', 'profile_is_legacy'], ['no-such-profile', 'unknown_profile'], [RETIRED, 'profile_retired']] as const) {
      const { code, output } = await cli(['--profile', profile]);
      assert.equal(code, 2, output);
      assert.match(output, new RegExp(reason));
    }
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM chunking_build_runs'))[0]?.n), 0);
  });

  test('CLI refuses to run without SUPABASE_SERVICE_ROLE_KEY', async () => {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const { code, output } = await cli(['--profile', PROFILE, '--dry-run']);
      assert.equal(code, 1, output);
      assert.match(output, /SUPABASE_SERVICE_ROLE_KEY/);
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    }
    assert.equal(edge.calls.length, 0, 'nothing was asked of the database');
  });

  async function spawnCli(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const { spawn } = await import('node:child_process');
    const merged: Record<string, string | undefined> = { ...process.env, ...childEnv, ...env };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/lib/rag/ingest/rechunk/cli.ts', ...args], { env: merged as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('the CLI did not finish in 90 s'));
      }, 90_000);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  test('the spawned CLI runs --dry-run against the fixture edge, exits 0 and writes nothing; its exit codes follow the contract', async () => {
    const dry = await spawnCli(['--profile', EMPTY_TYPE, '--dry-run']);
    assert.equal(dry.code, 0, `${dry.stdout}\n${dry.stderr}`);
    assert.match(dry.stdout, /dry run, nothing written/);
    assert.match(dry.stdout, new RegExp(`profile ${EMPTY_TYPE} \\(invoice_receipt, building`));
    assert.match(dry.stdout, /total: documents 0, /);
    const paths = edge.calls.map((call) => call.path);
    assert.ok(paths.includes('/rest/v1/rpc/rag_rechunk_documents'), 'the job ran against the database');
    assert.ok(!paths.some((path) => /rag_rechunk_(start|advance|record|finish|resume)|rag_write_profile_chunks/.test(path)));
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM chunking_build_runs'))[0]?.n), 0);

    const missing = await spawnCli(['--dry-run']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--profile is required/);
    const unknown = await spawnCli(['--profile', 'no-such-profile', '--dry-run']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown_profile/);
    const keyless = await spawnCli(['--profile', EMPTY_TYPE, '--dry-run'], { SUPABASE_SERVICE_ROLE_KEY: '' });
    assert.equal(keyless.code, 1);
    assert.match(keyless.stderr, /SUPABASE_SERVICE_ROLE_KEY/);
  });

  test('package.json has the rag:rechunk script', () => {
    const scripts = (JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
    assert.equal(scripts['rag:rechunk'], 'tsx src/lib/rag/ingest/rechunk/cli.ts');
  });

  test('the job modules import no parser, sidecar, LlamaParse client or OpenAI client', () => {
    for (const file of ['run.ts', 'cost.ts', 'cli.ts']) {
      const source = fs.readFileSync(`src/lib/rag/ingest/rechunk/${file}`, 'utf8');
      const imports = [...source.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1] as string);
      assert.ok(imports.length > 0 || file === 'cost.ts');
      for (const specifier of imports) {
        assert.doesNotMatch(specifier, /parsers|sidecar|llama|docling|openai|captioner|images/i, `${file} imports ${specifier}`);
      }
    }
    assert.match(fs.readFileSync('src/lib/rag/ingest/rechunk/run.ts', 'utf8'), /loadArtifact/);
  });

  test('cost: prices the children per tenant for every embedding profile, with the Phase 3 price table', () => {
    const report = costModule.estimateRechunkCost(
      [
        { profileId: 'a', provider: 'openai' },
        { profileId: 'b', provider: 'voyage' },
      ],
      { 't-2': { chunks: 1, tokens: 500_000 }, 't-1': { chunks: 2, tokens: 1_000_000 } },
    );
    assert.deepEqual(report.tenants.map((tenant) => tenant.tenantKey), ['t-1', 't-2']);
    assert.equal(report.tenants[0]?.usd.toFixed(6), '0.140000');
    assert.equal(report.totals.chunks, 3);
    assert.equal(report.totals.tokens, 1_500_000);
    assert.equal(report.totals.usd.toFixed(6), '0.210000');
    assert.deepEqual(report.profiles.map((profile) => [profile.profileId, profile.usd.toFixed(6)]), [['a', '0.030000'], ['b', '0.180000']]);
    assert.equal(report.estimated, true, 'a non-OpenAI token count is an estimate');
    assert.ok(report.note);
    assert.throws(() => costModule.estimateRechunkCost([{ profileId: 'x', provider: 'unknown' }], {}), /no price table/);
  });
});
