/**
 * Plan 03.1.1-08 (D-15, D-16, D-27): ingestion writes a binding profile's vectors in the same rag_write_chunks call as the global profiles,
 * only for documents of a bound doc type and tenant; a failing binding vendor never fails the document and records gaps against the
 * binding's open run; the publish guard keeps checking the active global profile only.
 */
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const LAW = 'voyage-law-2-1024';
const LAW_MODEL = 'voyage-law-2';

type Row = Record<string, unknown>;

interface VoyageRequest {
  model: unknown;
  hasOutputDimension: boolean;
  inputs: number;
}

interface FakeVoyage {
  url: string;
  requests: VoyageRequest[];
  /** Requests for this model answer 503. */
  failModel: string | null;
  close(): Promise<void>;
}

/** A Voyage-shaped embeddings endpoint that echoes the requested model, so the real provider's model check passes. */
async function startFakeVoyage(): Promise<FakeVoyage> {
  const state: FakeVoyage = { url: '', requests: [], failModel: null, close: async () => undefined };
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') as Record<string, unknown>;
      const inputs = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input)];
      state.requests.push({ model: body.model, hasOutputDimension: 'output_dimension' in body, inputs: inputs.length });
      if (state.failModel !== null && body.model === state.failModel) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"detail":"unavailable"}');
        return;
      }
      const dims = typeof body.output_dimension === 'number' ? body.output_dimension : 1024;
      const data = inputs.map((text, index) => ({
        index,
        embedding: Array.from({ length: dims }, (_, slot) => (slot === (text.length + index) % dims ? 1 : 0)),
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data, model: body.model, usage: { total_tokens: inputs.length } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

function vector(dims: number, hot: number): number[] {
  return Array.from({ length: dims }, (_, index) => (index === hot % dims ? 1 : 0));
}

describe('ingest() writes binding profiles for the doc types and tenants they cover (03.1.1-08)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let voyage: FakeVoyage;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let activeModule: typeof import('@/lib/rag/embeddings/active-profile');
  let bindingsModule: typeof import('@/lib/rag/embeddings/bindings');
  let registryModule: typeof import('@/lib/rag/embeddings/registry');
  let voyageModule: typeof import('@/lib/rag/embeddings/voyage');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  const tenantA = `u:${TWO_TENANT_IDS.userA}`;
  const tenantB = `u:${TWO_TENANT_IDS.userB}`;
  let sequence = 0;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    voyage = await startFakeVoyage();
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    configModule = await import('@/lib/rag/ingest/config');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    activeModule = await import('@/lib/rag/embeddings/active-profile');
    bindingsModule = await import('@/lib/rag/embeddings/bindings');
    registryModule = await import('@/lib/rag/embeddings/registry');
    voyageModule = await import('@/lib/rag/embeddings/voyage');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    await voyage?.close();
    await edge?.close();
    await fixture?.db.close();
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  const useEnv = (env: Record<string, string>) => {
    configModule.resetIngestConfigForTests();
    depsModule.setIngestDepsForTests({
      ingestEnv: () => env,
      embedDocuments: async (texts) => texts.map((text, index) => vector(1536, text.length + index)),
    });
    activeModule.resetActiveProfileForTests();
    bindingsModule.resetBindingsForTests();
  };

  const useRealLawProvider = () => {
    registryModule.setEmbeddingProvidersForTests({
      [`voyage:${LAW_MODEL}`]: voyageModule.createVoyageProvider({
        model: LAW_MODEL,
        config: () => ({ apiKey: 'voyage-fixture-placeholder-key-00000000', baseUrl: voyage.url }),
      }),
    });
  };

  beforeEach(async () => {
    voyage.requests.length = 0;
    voyage.failModel = null;
    objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
    await fixture.db.query('DELETE FROM embedding_backfill_gaps');
    await fixture.db.query('DELETE FROM embedding_backfill_runs');
    await fixture.db.query('DELETE FROM embedding_profile_bindings');
    useEnv({ RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: 'on' });
    useRealLawProvider();
  });

  afterEach(() => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    registryModule.resetEmbeddingProvidersForTests();
    activeModule.resetActiveProfileForTests();
    bindingsModule.resetBindingsForTests();
    mock.restoreAll();
  });

  async function stageBinding(tenantKey: string | null): Promise<string> {
    const created = (await rows("SELECT * FROM rag_create_embedding_binding('contract_legal', $1, $2, 'operator-test')", [tenantKey, LAW]))[0] as Row;
    await rows("SELECT * FROM rag_set_embedding_binding_status($1, 'backfilling', 'operator-test')", [created.binding_id]);
    bindingsModule.resetBindingsForTests();
    return String(created.binding_id);
  }

  const newRun = async (profileId: string, tenantKey: string | null = null): Promise<string> =>
    String((await rows("INSERT INTO embedding_backfill_runs (profile_id, tenant_key, status) VALUES ($1, $2, 'running') RETURNING id", [profileId, tenantKey]))[0]?.id);

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

  const upload = async (userId: string, docType: 'contract_legal' | 'general') => {
    const label = `sample-${docType}-${++sequence}`;
    return ingestModule.ingest({
      scope: await scopeOf(userId),
      source: 'config_upload',
      sourceKey: `root/${label}.md`,
      text: `# Record ${sequence}\n\nA neutral synthetic sentence about item ${sequence} in the first section.\n\n## Second\n\nAnother neutral synthetic sentence keeps record ${sequence} above one chunk.\n`,
      filename: `${label}.md`,
      mimeType: 'text/markdown',
      docType,
      signal: new AbortController().signal,
    });
  };

  const lawVectorsOf = (documentId: string | null) =>
    rows(
      `SELECT e.embedding_model, e.dims, e.tenant_key FROM chunk_embeddings e
       JOIN document_chunks c ON c.id = e.chunk_id WHERE c.document_id = $1 AND e.profile_id = $2`,
      [documentId, LAW],
    );

  const legacyCount = async (documentId: string | null): Promise<number> =>
    Number((await rows('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1 AND embedding IS NOT NULL', [documentId]))[0]?.n);

  const lawRequests = () => voyage.requests.filter((request) => request.model === LAW_MODEL);

  test('a deployment binding: a contract gets voyage-law-2 vectors for every chunk, a general document none', async () => {
    await stageBinding(null);
    const contract = await upload(TWO_TENANT_IDS.userA, 'contract_legal');
    assert.equal(contract.status, 'ready', contract.reason ?? '');
    assert.ok(contract.chunkCount >= 1);
    const stored = await lawVectorsOf(contract.documentId);
    assert.equal(stored.length, contract.chunkCount);
    for (const row of stored) assert.deepEqual([row.embedding_model, row.dims, row.tenant_key], [LAW_MODEL, 1024, tenantA]);
    assert.equal(await legacyCount(contract.documentId), contract.chunkCount, 'the global profile is written in the same call');
    assert.ok(lawRequests().length > 0);
    assert.ok(lawRequests().every((request) => !request.hasOutputDimension), 'voyage-law-2 is fixed-size: no output_dimension is sent');
    const state = (await rows('SELECT processing_state FROM documents WHERE id = $1', [contract.documentId]))[0]?.processing_state as Row;
    assert.deepEqual(state.embeddingTargets, [LEGACY, LAW]);

    voyage.requests.length = 0;
    const general = await upload(TWO_TENANT_IDS.userA, 'general');
    assert.equal(general.status, 'ready', general.reason ?? '');
    assert.equal((await lawVectorsOf(general.documentId)).length, 0);
    assert.equal(lawRequests().length, 0, 'no vendor call for a document outside the binding');
    const generalState = (await rows('SELECT processing_state FROM documents WHERE id = $1', [general.documentId]))[0]?.processing_state as Row;
    assert.deepEqual(generalState.embeddingTargets, [LEGACY]);
  });

  test('a failing binding vendor still publishes the contract, keeps the global vectors and records one gap per chunk on the binding run', async () => {
    await stageBinding(null);
    const runId = await newRun(LAW);
    voyage.failModel = LAW_MODEL;
    mock.method(console, 'warn', () => undefined);
    const contract = await upload(TWO_TENANT_IDS.userA, 'contract_legal');
    assert.equal(contract.status, 'ready', contract.reason ?? '');
    assert.equal(await legacyCount(contract.documentId), contract.chunkCount);
    assert.equal((await lawVectorsOf(contract.documentId)).length, 0);
    const gaps = await rows(
      `SELECT g.profile_id, g.reason, g.run_id FROM embedding_backfill_gaps g
       JOIN document_chunks c ON c.id = g.chunk_id WHERE c.document_id = $1`,
      [contract.documentId],
    );
    assert.equal(gaps.length, contract.chunkCount, 'every chunk of the document is a gap');
    assert.ok(gaps.every((gap) => gap.profile_id === LAW && gap.reason === 'provider_failed' && gap.run_id === runId));
    assert.ok(contract.warnings.includes(`embedding_gap:${LAW}`));
  });

  test('two tenants: a tenant binding for A writes law-2 vectors for A only; a deployment binding covers both', async () => {
    await stageBinding(tenantA);
    const forA = await upload(TWO_TENANT_IDS.userA, 'contract_legal');
    const forB = await upload(TWO_TENANT_IDS.userB, 'contract_legal');
    assert.equal(forA.status, 'ready', forA.reason ?? '');
    assert.equal(forB.status, 'ready', forB.reason ?? '');
    const vectorsA = await lawVectorsOf(forA.documentId);
    assert.equal(vectorsA.length, forA.chunkCount);
    assert.ok(vectorsA.every((row) => row.tenant_key === tenantA));
    assert.equal((await lawVectorsOf(forB.documentId)).length, 0, 'the tenant binding of A never reaches B');

    await fixture.db.query('DELETE FROM embedding_profile_bindings');
    await stageBinding(null);
    const deployA = await upload(TWO_TENANT_IDS.userA, 'contract_legal');
    const deployB = await upload(TWO_TENANT_IDS.userB, 'contract_legal');
    assert.equal((await lawVectorsOf(deployA.documentId)).length, deployA.chunkCount);
    const vectorsB = await lawVectorsOf(deployB.documentId);
    assert.equal(vectorsB.length, deployB.chunkCount);
    assert.ok(vectorsB.every((row) => row.tenant_key === tenantB));
    const crossed = await rows('SELECT count(*)::int AS n FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE e.tenant_key <> c.tenant_key');
    assert.equal(crossed[0]?.n, 0);
  });

  test('with RAG_DOMAIN_EMBEDDINGS off the same binding writes no law-2 vector and makes no law-2 request', async () => {
    await stageBinding(null);
    useEnv({ RAG_EMBEDDING_PROFILES: 'on' });
    const contract = await upload(TWO_TENANT_IDS.userA, 'contract_legal');
    assert.equal(contract.status, 'ready', contract.reason ?? '');
    assert.equal(await legacyCount(contract.documentId), contract.chunkCount);
    assert.equal((await lawVectorsOf(contract.documentId)).length, 0);
    assert.equal(lawRequests().length, 0);
    const state = (await rows('SELECT processing_state FROM documents WHERE id = $1', [contract.documentId]))[0]?.processing_state as Row;
    assert.deepEqual(state.embeddingTargets, [LEGACY]);
  });

  test('rag_vectors_complete checks the active global profile only: true for a contract whose law-2 vectors are missing (D-16)', async () => {
    await stageBinding(null);
    voyage.failModel = LAW_MODEL;
    mock.method(console, 'warn', () => undefined);
    const contract = await upload(TWO_TENANT_IDS.userA, 'contract_legal');
    assert.equal(contract.status, 'ready', contract.reason ?? '');
    assert.equal((await lawVectorsOf(contract.documentId)).length, 0);
    const [complete] = await rows('SELECT rag_vectors_complete($1, $2, $3) AS ok', [contract.documentId, LEGACY, tenantA]);
    assert.equal(complete?.ok, true);
    const [published] = await rows('SELECT is_current, status FROM documents WHERE id = $1', [contract.documentId]);
    assert.deepEqual([published?.is_current, published?.status], [true, 'ready']);
  });
});
