import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';

const LEGACY = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-2048';
const QWEN = 'qwen3-8b-1024';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string;
}

const A: Tenant = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
const B: Tenant = { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The deterministic chunk id of rag_write_chunks: the first 16 bytes of sha256(document id : chunk index). */
function chunkId(documentId: string, index: number): string {
  const hex = crypto.createHash('sha256').update(`${documentId}:${index}`, 'utf8').digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function vector(dims: number, hot: number): number[] {
  return Array.from({ length: dims }, (_, index) => (index === hot % dims ? 1 : 0));
}

let sequence = 0;

async function rowsOf(db: TwoTenantDatabase['db'], sql: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return (await db.query<Row>(sql, params)).rows;
  } catch (error) {
    return assert.fail(`${sql.slice(0, 70).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
  }
}

describe('ingest writer: embeddings for every profile, gaps and the version swap', () => {
  let fixture: TwoTenantDatabase;

  before(async () => {
    fixture = await createTwoTenantDatabase();
  });

  after(async () => {
    await fixture?.db.close();
  });

  const query = (sql: string, params: unknown[] = []): Promise<Row[]> => rowsOf(fixture.db, sql, params);

  async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
    try {
      await fixture.db.query(sql, params);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  async function begin(tenant: Tenant, sourceKey = `dual-write-${++sequence}.md`): Promise<string> {
    const rows = await query(
      `SELECT * FROM rag_begin_document_version(
         p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL, p_source => 'config_upload', p_source_key => $3, p_filename => $3,
         p_file_sha256 => $4, p_doc_type => 'general', p_doc_type_origin => 'fallback', p_profile_id => 'general-1', p_profile_version => 1)`,
      [tenant.key, tenant.userId, sourceKey, crypto.createHash('sha256').update(`${sourceKey}:${++sequence}`).digest('hex')],
    );
    assert.equal(rows[0]?.outcome, 'created');
    return String(rows[0]?.document_id);
  }

  const chunksOf = (count: number, label = 'chunk') =>
    Array.from({ length: count }, (_, index) => ({
      content: `${label} ${index} of the dual write fixture`,
      chunk_index: index,
      section_path: ['Dual Write'],
      chunk_kind: 'text',
      embedding_text_version: 1,
      metadata: {},
    }));

  const WRITE_SQL = `SELECT * FROM rag_write_chunks(
    p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => $5, p_total => $6)`;

  const writeParams = (documentId: string, tenant: Tenant, chunks: unknown[], embeddings: unknown): unknown[] => [
    documentId,
    tenant.key,
    JSON.stringify(chunks),
    JSON.stringify(embeddings),
    true,
    chunks.length,
  ];

  const write = (documentId: string, tenant: Tenant, chunks: unknown[], embeddings: unknown) =>
    query(WRITE_SQL, writeParams(documentId, tenant, chunks, embeddings));

  const writeError = (documentId: string, tenant: Tenant, chunks: unknown[], embeddings: unknown) =>
    errorOf(WRITE_SQL, writeParams(documentId, tenant, chunks, embeddings));

  const publish = (documentId: string, tenant: Tenant) =>
    query('SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, tenant.key]);

  const profileRows = (documentId: string, profileId: string) =>
    query(
      `SELECT e.chunk_id, e.profile_id, e.tenant_key, e.embedding_model, e.dims, e.embedding_host
       FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id
       WHERE c.document_id = $1 AND e.profile_id = $2 ORDER BY c.chunk_index`,
      [documentId, profileId],
    );

  const openRun = async (profileId: string, tenantKey: string | null = null, status = 'running'): Promise<string> => {
    const rows = await query('INSERT INTO embedding_backfill_runs (profile_id, tenant_key, status) VALUES ($1, $2, $3) RETURNING id', [
      profileId,
      tenantKey,
      status,
    ]);
    return String(rows[0]?.id);
  };

  const GAP_SQL = `SELECT * FROM rag_record_backfill_gap(
    p_run_id => $1::uuid, p_chunk_ids => $2::uuid[], p_profile_id => $3, p_reason => $4, p_tenant_key => $5)`;

  test('a write with vectors for the legacy and another profile fills the legacy column and one chunk_embeddings row per chunk', async () => {
    const documentId = await begin(A);
    const chunks = chunksOf(3);
    const written = await write(documentId, A, chunks, {
      [LEGACY]: chunks.map((_, index) => vector(1536, index)),
      [VOYAGE]: { vectors: chunks.map((_, index) => vector(2048, index)), host: 'voyage' },
    });
    assert.equal(written[0]?.chunks_written, 3);

    const legacy = await query('SELECT embedding IS NOT NULL AS embedded FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId]);
    assert.deepEqual(
      legacy.map((row) => row.embedded),
      [true, true, true],
    );
    const rows = await profileRows(documentId, VOYAGE);
    assert.equal(rows.length, 3, 'one row per chunk');
    for (const [index, row] of rows.entries()) {
      assert.equal(row.chunk_id, chunkId(documentId, index));
      assert.equal(row.tenant_key, A.key, 'the tenant key comes from the document');
      assert.equal(row.embedding_model, 'voyage-4-large');
      assert.equal(row.dims, 2048);
      assert.equal(row.embedding_host, 'voyage');
    }
    assert.equal((await profileRows(documentId, QWEN)).length, 0, 'a profile that was not sent has no rows');
  });

  test('a vector whose length differs from the profile dims is rejected and nothing is written', async () => {
    const documentId = await begin(A);
    const chunks = chunksOf(2);
    const error = await writeError(documentId, A, chunks, { [VOYAGE]: { vectors: chunks.map((_, index) => vector(1024, index)), host: 'voyage' } });
    assert.ok(error, 'a 1024-length vector for the 2048 profile must be refused');
    assert.match(error, /embedding_profile_mismatch/);
    const stored = await query('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1', [documentId]);
    assert.equal(stored[0]?.n, 0, 'the call is one transaction');
  });

  test('an unknown profile id is rejected', async () => {
    const documentId = await begin(A);
    const chunks = chunksOf(1);
    const error = await writeError(documentId, A, chunks, { 'no-such-profile-512': [vector(512, 0)] });
    assert.ok(error, 'an unknown profile must be refused');
    assert.match(error, /embedding_profile_unsupported/);
  });

  test('a vector list that does not line up with the chunks is rejected', async () => {
    const documentId = await begin(A);
    const chunks = chunksOf(2);
    const error = await writeError(documentId, A, chunks, { [VOYAGE]: { vectors: [vector(2048, 0)], host: 'voyage' } });
    assert.ok(error);
    assert.match(error, /embedding_count_mismatch/);
  });

  test('writing the same chunks again upserts the rows and updates the host', async () => {
    const documentId = await begin(A);
    const chunks = chunksOf(2);
    await write(documentId, A, chunks, { [VOYAGE]: { vectors: chunks.map((_, index) => vector(2048, index)), host: 'primary' } });
    await write(documentId, A, chunks, { [VOYAGE]: { vectors: chunks.map((_, index) => vector(2048, index + 1)), host: 'fallback' } });
    const rows = await profileRows(documentId, VOYAGE);
    assert.equal(rows.length, 2, 'no duplicate rows');
    assert.deepEqual(
      rows.map((row) => row.embedding_host),
      ['fallback', 'fallback'],
    );
    const chunkCount = await query('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1', [documentId]);
    assert.equal(chunkCount[0]?.n, 2);
  });

  test('a rewrite with other text drops the old vector of a profile that is not sent again', async () => {
    const documentId = await begin(A);
    const original = chunksOf(2, 'before');
    await write(documentId, A, original, { [VOYAGE]: { vectors: original.map((_, index) => vector(2048, index)), host: 'voyage' } });
    const changed = [original[0], { ...original[1], content: 'a different second chunk' }];
    await write(documentId, A, changed, { [LEGACY]: changed.map((_, index) => vector(1536, index)) });
    const rows = await profileRows(documentId, VOYAGE);
    assert.deepEqual(
      rows.map((row) => row.chunk_id),
      [chunkId(documentId, 0)],
      'the unchanged chunk keeps its vector, the changed chunk loses the stale one',
    );
  });

  test('publishing version 2 deletes version 1 chunk_embeddings rows and keeps its chunk rows', async () => {
    const sourceKey = `swap-${++sequence}.md`;
    const first = await begin(A, sourceKey);
    const firstChunks = chunksOf(2, 'v1');
    await write(first, A, firstChunks, {
      [LEGACY]: firstChunks.map((_, index) => vector(1536, index)),
      [VOYAGE]: { vectors: firstChunks.map((_, index) => vector(2048, index)), host: 'voyage' },
    });
    assert.equal((await publish(first, A))[0]?.outcome, 'published');
    assert.equal((await profileRows(first, VOYAGE)).length, 2);

    const second = await begin(A, sourceKey);
    assert.notEqual(second, first);
    const secondChunks = chunksOf(2, 'v2');
    await write(second, A, secondChunks, {
      [LEGACY]: secondChunks.map((_, index) => vector(1536, index + 5)),
      [VOYAGE]: { vectors: secondChunks.map((_, index) => vector(2048, index + 5)), host: 'voyage' },
    });
    const outcome = await publish(second, A);
    assert.equal(outcome[0]?.outcome, 'published');
    assert.equal(outcome[0]?.superseded_document_id, first);

    assert.equal((await profileRows(first, VOYAGE)).length, 0, 'the superseded version has no profile vectors');
    assert.equal((await profileRows(second, VOYAGE)).length, 2, 'the new version keeps its own');
    const oldChunks = await query('SELECT embedding IS NULL AS no_vector, is_current FROM document_chunks WHERE document_id = $1', [first]);
    assert.equal(oldChunks.length, 2, 'the old chunk rows stay for citations');
    assert.ok(oldChunks.every((row) => row.no_vector === true && row.is_current === false));
  });

  test('rag_record_backfill_gap records one gap row per chunk and a repeat changes nothing', async () => {
    const documentId = await begin(A);
    const chunks = chunksOf(3);
    await write(documentId, A, chunks, { [LEGACY]: chunks.map((_, index) => vector(1536, index)) });
    const runId = await openRun(VOYAGE);
    const ids = chunks.map((_, index) => chunkId(documentId, index));

    const first = await query(GAP_SQL, [runId, ids, VOYAGE, 'provider_failed', A.key]);
    assert.equal(first[0]?.gaps_recorded, 3);
    await query(GAP_SQL, [runId, ids, VOYAGE, 'provider_failed', A.key]);
    const gaps = await query('SELECT chunk_id, profile_id, reason, run_id FROM embedding_backfill_gaps WHERE run_id = $1 ORDER BY chunk_id', [runId]);
    assert.equal(gaps.length, 3);
    assert.ok(gaps.every((gap) => gap.profile_id === VOYAGE && gap.reason === 'provider_failed' && gap.run_id === runId));
    assert.deepEqual(gaps.map((gap) => gap.chunk_id).sort(), [...ids].sort());
  });

  test('a gap for a chunk of another tenant is refused and nothing is recorded', async () => {
    const documentId = await begin(B);
    const chunks = chunksOf(2);
    await write(documentId, B, chunks, { [LEGACY]: chunks.map((_, index) => vector(1536, index)) });
    const runId = await openRun(VOYAGE);
    const ids = chunks.map((_, index) => chunkId(documentId, index));

    const error = await errorOf(GAP_SQL, [runId, ids, VOYAGE, 'provider_failed', A.key]);
    assert.ok(error, 'tenant A cannot record a gap for a chunk of tenant B');
    assert.match(error, /tenant_mismatch/);
    assert.equal((await query('SELECT count(*)::int AS n FROM embedding_backfill_gaps WHERE run_id = $1', [runId]))[0]?.n, 0);

    const unknown = await errorOf(GAP_SQL, [runId, [crypto.randomUUID()], VOYAGE, 'provider_failed', A.key]);
    assert.match(unknown ?? '', /tenant_mismatch/, 'an unknown chunk id is not distinguishable from another tenant');
  });

  test('a gap is refused for a run of another profile, an unknown run and a run limited to another tenant', async () => {
    const documentId = await begin(A);
    const chunks = chunksOf(1);
    await write(documentId, A, chunks, { [LEGACY]: [vector(1536, 0)] });
    const ids = [chunkId(documentId, 0)];

    const otherProfile = await openRun(QWEN);
    assert.match((await errorOf(GAP_SQL, [otherProfile, ids, VOYAGE, 'provider_failed', A.key])) ?? '', /run_profile_mismatch/);
    assert.match((await errorOf(GAP_SQL, [crypto.randomUUID(), ids, VOYAGE, 'provider_failed', A.key])) ?? '', /run_not_found/);
    const otherTenant = await openRun(VOYAGE, B.key);
    assert.match((await errorOf(GAP_SQL, [otherTenant, ids, VOYAGE, 'provider_failed', A.key])) ?? '', /tenant_mismatch/);
    assert.match((await errorOf(GAP_SQL, [await openRun(VOYAGE), ids, VOYAGE, '', A.key])) ?? '', /invalid_gap/);
  });

  test('writing the missing vector later removes its recorded gap', async () => {
    const documentId = await begin(A);
    const chunks = chunksOf(2);
    await write(documentId, A, chunks, { [LEGACY]: chunks.map((_, index) => vector(1536, index)) });
    const runId = await openRun(VOYAGE);
    await query(GAP_SQL, [runId, chunks.map((_, index) => chunkId(documentId, index)), VOYAGE, 'provider_failed', A.key]);
    assert.equal((await query('SELECT count(*)::int AS n FROM embedding_backfill_gaps WHERE run_id = $1', [runId]))[0]?.n, 2);

    await write(documentId, A, chunks, {
      [LEGACY]: chunks.map((_, index) => vector(1536, index)),
      [VOYAGE]: { vectors: chunks.map((_, index) => vector(2048, index)), host: 'voyage' },
    });
    assert.equal((await query('SELECT count(*)::int AS n FROM embedding_backfill_gaps WHERE run_id = $1', [runId]))[0]?.n, 0);
  });

  test('rag_latest_backfill_runs prefers a running run and shows a tenant only the runs that apply to it', async () => {
    const isolated = await createTwoTenantDatabase();
    try {
      const run = async (profileId: string, tenantKey: string | null, status: string, startedAt: string) =>
        String(
          (
            await rowsOf(
              isolated.db,
              'INSERT INTO embedding_backfill_runs (profile_id, tenant_key, status, started_at) VALUES ($1, $2, $3, $4) RETURNING id',
              [profileId, tenantKey, status, startedAt],
            )
          )[0]?.id,
        );
      const completed = await run(VOYAGE, null, 'completed', '2026-01-01T00:00:00Z');
      const running = await run(VOYAGE, null, 'running', '2025-12-01T00:00:00Z');
      const forB = await run(QWEN, B.key, 'running', '2026-01-02T00:00:00Z');
      assert.notEqual(completed, running);

      const seenByA = await rowsOf(isolated.db, 'SELECT * FROM rag_latest_backfill_runs(p_tenant_key => $1)', [A.key]);
      assert.deepEqual(
        seenByA.map((row) => [row.profile_id, row.run_id, row.status]),
        [[VOYAGE, running, 'running']],
        'a running run wins over a newer completed one and the run limited to tenant B is not shown',
      );
      const seenByB = await rowsOf(isolated.db, 'SELECT * FROM rag_latest_backfill_runs(p_tenant_key => $1)', [B.key]);
      assert.deepEqual(seenByB.map((row) => row.run_id).sort(), [forB, running].sort());
    } finally {
      await isolated.db.close();
    }
  });

  test('the gap and run functions are not executable by anon or authenticated', async () => {
    const exposed = await query(
      `SELECT p.proname FROM pg_proc p
       WHERE p.proname IN ('rag_record_backfill_gap', 'rag_latest_backfill_runs', 'rag_write_chunks', 'rag_publish_document_version')
         AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
    );
    assert.deepEqual(exposed, []);
    const defined = await query(
      "SELECT proname FROM pg_proc WHERE proname IN ('rag_record_backfill_gap', 'rag_latest_backfill_runs') ORDER BY proname",
    );
    assert.deepEqual(
      defined.map((row) => row.proname),
      ['rag_latest_backfill_runs', 'rag_record_backfill_gap'],
    );
  });
});

interface FakeProviderOptions {
  fail?: boolean;
  dims?: number;
  model?: string;
  host?: string;
}

function fakeProvider(id: 'voyage' | 'qwen3', model: string, dims: number, options: FakeProviderOptions = {}) {
  const seen: string[] = [];
  const provider: EmbeddingProvider = {
    id,
    model,
    maxInputTokens: 8000,
    supportedDims: [1024, 2048],
    normalize: true,
    async embedDocuments(texts) {
      if (options.fail) throw new Error('vendor unavailable');
      seen.push(...texts);
      const width = options.dims ?? dims;
      return {
        vectors: texts.map((text, index) => vector(width, text.length + index)),
        model: options.model ?? model,
        host: options.host ?? 'fake-host',
        usage: { tokens: texts.length },
      };
    },
    async embedQuery(text) {
      return { vectors: [vector(dims, text.length)], model, host: 'fake-host', usage: { tokens: 1 } };
    },
  };
  return { provider, seen };
}

describe('ingest() writes every profile that must stay complete', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let activeModule: typeof import('@/lib/rag/embeddings/active-profile');
  let registryModule: typeof import('@/lib/rag/embeddings/registry');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let legacyTexts: string[] = [];

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    configModule = await import('@/lib/rag/ingest/config');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    activeModule = await import('@/lib/rag/embeddings/active-profile');
    registryModule = await import('@/lib/rag/embeddings/registry');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  const setProfiles = async (states: Record<string, { status: string; previous?: string }>) => {
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available', previous_active_id = NULL WHERE status <> 'active'");
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available', previous_active_id = NULL WHERE status = 'active'");
    for (const [id, state] of Object.entries(states)) {
      await fixture.db.query('UPDATE embedding_profiles SET status = $2, previous_active_id = $3 WHERE id = $1', [id, state.status, state.previous ?? null]);
    }
    activeModule.resetActiveProfileForTests();
  };

  const useEnv = (env: Record<string, string>) => {
    configModule.resetIngestConfigForTests();
    depsModule.setIngestDepsForTests({
      ingestEnv: () => env,
      embedDocuments: async (texts) => {
        legacyTexts.push(...texts);
        return texts.map((text, index) => vector(1536, text.length + index));
      },
    });
  };

  beforeEach(async () => {
    legacyTexts = [];
    objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
    await fixture.db.query('DELETE FROM embedding_backfill_runs');
    await setProfiles({ [LEGACY]: { status: 'active' } });
    useEnv({ RAG_EMBEDDING_PROFILES: 'on' });
  });

  afterEach(() => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    registryModule.resetEmbeddingProvidersForTests();
    activeModule.resetActiveProfileForTests();
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

  const upload = async (userId: string, label: string, sourceKey = `root/${label}.md`) =>
    ingestModule.ingest({
      scope: await scopeOf(userId),
      source: 'config_upload',
      sourceKey,
      text: `# ${label}\n\nThe ${label} ledger lists every pallet that crossed the apron.\n\n## Second\n\nA second section about ${label} keeps the batch above one chunk.\n`,
      filename: `${label}.md`,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  const vectorsOf = (documentId: string | null, profileId: string) =>
    rows(
      `SELECT e.embedding_model, e.dims, e.embedding_host, e.tenant_key FROM chunk_embeddings e
       JOIN document_chunks c ON c.id = e.chunk_id WHERE c.document_id = $1 AND e.profile_id = $2`,
      [documentId, profileId],
    );

  const legacyCount = async (documentId: string | null): Promise<number> =>
    Number((await rows('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1 AND embedding IS NOT NULL', [documentId]))[0]?.n);

  const gapsOf = (documentId: string | null) =>
    rows(
      `SELECT g.profile_id, g.reason, g.run_id FROM embedding_backfill_gaps g
       JOIN document_chunks c ON c.id = g.chunk_id WHERE c.document_id = $1 ORDER BY c.chunk_index`,
      [documentId],
    );

  const newRun = async (profileId: string, tenantKey: string | null = null): Promise<string> =>
    String((await rows("INSERT INTO embedding_backfill_runs (profile_id, tenant_key, status) VALUES ($1, $2, 'running') RETURNING id", [profileId, tenantKey]))[0]?.id);

  test('with RAG_EMBEDDING_PROFILES off a document gets the legacy vector only and no provider is called', async () => {
    useEnv({});
    await setProfiles({ [LEGACY]: { status: 'available' }, [VOYAGE]: { status: 'backfilling' } });
    const voyage = fakeProvider('voyage', 'voyage-4-large', 2048);
    registryModule.setEmbeddingProvidersForTests({ voyage: voyage.provider });
    const result = await upload(TWO_TENANT_IDS.userA, 'switch-off');
    assert.equal(result.status, 'ready');
    assert.ok(result.chunkCount >= 2);
    assert.equal(await legacyCount(result.documentId), result.chunkCount);
    assert.equal((await vectorsOf(result.documentId, VOYAGE)).length, 0);
    assert.equal(voyage.seen.length, 0);
    const state = (await rows('SELECT processing_state FROM documents WHERE id = $1', [result.documentId]))[0]?.processing_state as Row;
    assert.deepEqual(state.embeddingTargets, [LEGACY]);
  });

  test('a document ingested while voyage is backfilling has vectors in both profiles, from the same embedding text', async () => {
    await setProfiles({ [LEGACY]: { status: 'active' }, [VOYAGE]: { status: 'backfilling' } });
    const voyage = fakeProvider('voyage', 'voyage-4-large', 2048, { host: 'voyage-primary' });
    registryModule.setEmbeddingProvidersForTests({ voyage: voyage.provider });
    const result = await upload(TWO_TENANT_IDS.userA, 'mid-migration');
    assert.equal(result.status, 'ready');
    assert.equal(await legacyCount(result.documentId), result.chunkCount);
    const stored = await vectorsOf(result.documentId, VOYAGE);
    assert.equal(stored.length, result.chunkCount);
    for (const row of stored) {
      assert.deepEqual([row.embedding_model, row.dims, row.embedding_host, row.tenant_key], ['voyage-4-large', 2048, 'voyage-primary', `u:${TWO_TENANT_IDS.userA}`]);
    }
    assert.deepEqual(voyage.seen, legacyTexts, 'every target embeds the same text per chunk');
    assert.deepEqual((await gapsOf(result.documentId)), []);
    const state = (await rows('SELECT processing_state FROM documents WHERE id = $1', [result.documentId]))[0]?.processing_state as Row;
    assert.deepEqual(state.embeddingTargets, [LEGACY, VOYAGE]);
  });

  test('a failing backfilling provider still publishes on the active profile and records each chunk as a gap of the open run', async () => {
    await setProfiles({ [LEGACY]: { status: 'active' }, [VOYAGE]: { status: 'backfilling' } });
    registryModule.setEmbeddingProvidersForTests({ voyage: fakeProvider('voyage', 'voyage-4-large', 2048, { fail: true }).provider });
    mock.method(console, 'warn', () => undefined);
    const runId = await newRun(VOYAGE);
    const result = await upload(TWO_TENANT_IDS.userA, 'provider-down');
    assert.equal(result.status, 'ready');
    assert.equal(await legacyCount(result.documentId), result.chunkCount);
    assert.equal((await vectorsOf(result.documentId, VOYAGE)).length, 0);
    const gaps = await gapsOf(result.documentId);
    assert.equal(gaps.length, result.chunkCount, 'every chunk of the document is a gap');
    assert.ok(gaps.every((gap) => gap.profile_id === VOYAGE && gap.reason === 'provider_failed' && gap.run_id === runId));
    assert.ok(result.warnings.includes(`embedding_gap:${VOYAGE}`));
  });

  test('a backfilling provider that answers with the wrong dims or model is a gap with reason embedding_profile_mismatch', async () => {
    await setProfiles({ [LEGACY]: { status: 'active' }, [VOYAGE]: { status: 'backfilling' } });
    mock.method(console, 'warn', () => undefined);
    const runId = await newRun(VOYAGE);
    registryModule.setEmbeddingProvidersForTests({ voyage: fakeProvider('voyage', 'voyage-4-large', 2048, { dims: 1024 }).provider });
    const wrongDims = await upload(TWO_TENANT_IDS.userA, 'wrong-dims');
    assert.equal(wrongDims.status, 'ready');
    assert.equal((await vectorsOf(wrongDims.documentId, VOYAGE)).length, 0);
    assert.ok((await gapsOf(wrongDims.documentId)).every((gap) => gap.reason === 'embedding_profile_mismatch' && gap.run_id === runId));

    registryModule.setEmbeddingProvidersForTests({ voyage: fakeProvider('voyage', 'voyage-4-large', 2048, { model: 'another-model' }).provider });
    const wrongModel = await upload(TWO_TENANT_IDS.userA, 'wrong-model');
    assert.equal(wrongModel.status, 'ready');
    assert.equal((await vectorsOf(wrongModel.documentId, VOYAGE)).length, 0);
    assert.equal((await gapsOf(wrongModel.documentId)).length, wrongModel.chunkCount);
  });

  test('with voyage active and the legacy profile as its previous both are written; a failing active provider fails the run and a retry succeeds', async () => {
    await setProfiles({ [VOYAGE]: { status: 'active', previous: LEGACY } });
    mock.method(console, 'error', () => undefined);
    registryModule.setEmbeddingProvidersForTests({ voyage: fakeProvider('voyage', 'voyage-4-large', 2048, { fail: true }).provider });
    const failed = await upload(TWO_TENANT_IDS.userA, 'active-down');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'embed_failed');
    const version = (await rows('SELECT status, is_current FROM documents WHERE id = $1', [failed.documentId]))[0] as Row;
    assert.deepEqual([version.status, version.is_current], ['failed', false]);

    registryModule.setEmbeddingProvidersForTests({ voyage: fakeProvider('voyage', 'voyage-4-large', 2048).provider });
    const retried = await upload(TWO_TENANT_IDS.userA, 'active-down');
    assert.equal(retried.status, 'ready');
    assert.equal((await vectorsOf(retried.documentId, VOYAGE)).length, retried.chunkCount);
    assert.equal(await legacyCount(retried.documentId), retried.chunkCount, 'the previous active profile stays complete for a rollback');
  });

  test('a provider that answers with the wrong model or dims for the active profile fails the run with embedding_profile_mismatch', async () => {
    await setProfiles({ [VOYAGE]: { status: 'active', previous: LEGACY } });
    mock.method(console, 'error', () => undefined);
    registryModule.setEmbeddingProvidersForTests({ voyage: fakeProvider('voyage', 'voyage-4-large', 2048, { model: 'another-model' }).provider });
    const wrongModel = await upload(TWO_TENANT_IDS.userA, 'active-wrong-model');
    assert.equal(wrongModel.status, 'failed');
    assert.equal(wrongModel.reason, 'embedding_profile_mismatch');

    registryModule.setEmbeddingProvidersForTests({ voyage: fakeProvider('voyage', 'voyage-4-large', 2048, { dims: 1024 }).provider });
    const wrongDims = await upload(TWO_TENANT_IDS.userA, 'active-wrong-dims');
    assert.equal(wrongDims.status, 'failed');
    assert.equal(wrongDims.reason, 'embedding_profile_mismatch');
  });

  test('under the unified pipeline the legacy target refuses to write when the configured OpenAI model is not the legacy profile model', async () => {
    mock.method(console, 'error', () => undefined);
    for (const env of [{ RAG_INGEST_PIPELINE: 'unified' }, { RAG_EMBEDDING_PROFILES: 'on' }]) {
      useEnv(env);
      activeModule.resetActiveProfileForTests();
      const openai = fakeProvider('voyage', 'text-embedding-3-large', 1536).provider;
      registryModule.setEmbeddingProvidersForTests({ openai: { ...openai, id: 'openai', supportedDims: [1536] } });
      const refused = await upload(TWO_TENANT_IDS.userA, `model-swap-${Object.keys(env)[0]}`);
      assert.equal(refused.status, 'failed');
      assert.equal(refused.reason, 'embedding_profile_mismatch');
      assert.equal(legacyTexts.length, 0, 'nothing was embedded under the wrong model');
    }
    registryModule.resetEmbeddingProvidersForTests();
    useEnv({});
    const unchanged = await upload(TWO_TENANT_IDS.userA, 'model-swap-off');
    assert.equal(unchanged.status, 'ready', 'with the switch off and the legacy pipeline nothing changes');
  });

  test('two tenants: vectors and gaps stay with the tenant of the document and a run limited to another tenant is not used', async () => {
    await setProfiles({ [LEGACY]: { status: 'active' }, [VOYAGE]: { status: 'backfilling' } });
    mock.method(console, 'warn', () => undefined);
    registryModule.setEmbeddingProvidersForTests({ voyage: fakeProvider('voyage', 'voyage-4-large', 2048, { fail: true }).provider });
    const runForB = await newRun(VOYAGE, `u:${TWO_TENANT_IDS.userB}`);
    const forA = await upload(TWO_TENANT_IDS.userA, 'tenant-a-doc');
    const forB = await upload(TWO_TENANT_IDS.userB, 'tenant-b-doc');
    assert.equal(forA.status, 'ready');
    assert.equal(forB.status, 'ready');
    assert.deepEqual(await gapsOf(forA.documentId), [], 'the only run is limited to tenant B, so tenant A has none to record against');
    const gapsB = await gapsOf(forB.documentId);
    assert.equal(gapsB.length, forB.chunkCount);
    assert.ok(gapsB.every((gap) => gap.run_id === runForB));

    registryModule.setEmbeddingProvidersForTests({ voyage: fakeProvider('voyage', 'voyage-4-large', 2048).provider });
    const okA = await upload(TWO_TENANT_IDS.userA, 'tenant-a-second');
    const okB = await upload(TWO_TENANT_IDS.userB, 'tenant-b-second');
    assert.ok((await vectorsOf(okA.documentId, VOYAGE)).every((row) => row.tenant_key === `u:${TWO_TENANT_IDS.userA}`));
    assert.ok((await vectorsOf(okB.documentId, VOYAGE)).every((row) => row.tenant_key === `u:${TWO_TENANT_IDS.userB}`));
    const crossed = await rows(
      `SELECT count(*)::int AS n FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE e.tenant_key <> c.tenant_key`,
    );
    assert.equal(crossed[0]?.n, 0);
  });

  test('replacing a document gives the new version vectors in both profiles and deletes the old version vectors', async () => {
    await setProfiles({ [LEGACY]: { status: 'active' }, [VOYAGE]: { status: 'backfilling' } });
    registryModule.setEmbeddingProvidersForTests({ voyage: fakeProvider('voyage', 'voyage-4-large', 2048).provider });
    const first = await ingestModule.ingest({
      scope: await scopeOf(TWO_TENANT_IDS.userA),
      source: 'config_upload',
      sourceKey: 'root/replace-me.md',
      text: '# Replace\n\nThe first edition of the manual lists the old forklift rules.\n\n## Rules\n\nOld rules apply to every shift.\n',
      filename: 'replace-me.md',
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });
    assert.equal(first.status, 'ready');
    assert.equal((await vectorsOf(first.documentId, VOYAGE)).length, first.chunkCount);
    const second = await ingestModule.ingest({
      scope: await scopeOf(TWO_TENANT_IDS.userA),
      source: 'config_upload',
      sourceKey: 'root/replace-me.md',
      text: '# Replace\n\nThe second edition of the manual lists the new forklift rules.\n\n## Rules\n\nNew rules apply to every shift.\n',
      filename: 'replace-me.md',
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });
    assert.equal(second.status, 'ready');
    assert.equal(second.version, 2);
    assert.equal((await vectorsOf(first.documentId, VOYAGE)).length, 0);
    assert.equal((await vectorsOf(second.documentId, VOYAGE)).length, second.chunkCount);
    assert.equal(await legacyCount(second.documentId), second.chunkCount);
    assert.equal(await legacyCount(first.documentId), 0);
  });
});
