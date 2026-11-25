/**
 * Batch API backfill, SQL side (D-35): a deferred job writes chunks without vectors and is parked at embed_deferred; the CLI fills the
 * vectors by chunk id and publishes, and publish refuses while a chunk lacks its active-profile vector (rag_vectors_complete).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-1024';
const WORKER = 'vectors-complete-worker';
const A = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
const B = { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB };

type Row = Record<string, unknown>;
type Tenant = typeof A;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function vector(dims: number, hot: number): number[] {
  return Array.from({ length: dims }, (_, index) => (index === hot % dims ? 1 : 0));
}

function settings(embedMode: 'sync' | 'batch_api'): Row {
  return {
    cloud_allowed: false,
    doc_type: 'general',
    embed_mode: embedMode,
    escalation: true,
    max_tier: null,
    min_tier: null,
    ocr_languages: ['en'],
    premium_max_pages_per_doc: 0,
    premium_page_budget: 0,
    profile_id: 'general',
    profile_version: 1,
    progressive: false,
    routing: 'fixed',
    routing_config_version: '1',
    vlm_detect: false,
    vlm_model: null,
  };
}

let sequence = 0;

describe('rag_vectors_complete and the deferred publish (D-35)', () => {
  let fixture: TwoTenantDatabase;

  before(async () => {
    fixture = await createTwoTenantDatabase();
  });

  after(async () => {
    await fixture?.db.close();
  });

  const query = async (sql: string, params: unknown[] = []): Promise<Row[]> => {
    try {
      return (await fixture.db.query<Row>(sql, params)).rows;
    } catch (error) {
      return assert.fail(`${sql.slice(0, 80).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
    }
  };

  const errorOf = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    try {
      await fixture.db.query(sql, params);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  };

  async function begin(tenant: Tenant, sourceKey: string): Promise<string> {
    const rows = await query(
      `SELECT * FROM rag_begin_document_version(
         p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL, p_source => 'config_upload', p_source_key => $3, p_filename => $3,
         p_file_sha256 => $4, p_doc_type => 'general', p_doc_type_origin => 'fallback', p_profile_id => 'general-1', p_profile_version => 1)`,
      [tenant.key, tenant.userId, sourceKey, crypto.createHash('sha256').update(`${sourceKey}:${++sequence}`).digest('hex')],
    );
    assert.equal(rows[0]?.outcome, 'created');
    return String(rows[0]?.document_id);
  }

  const chunksOf = (count: number, label: string) =>
    Array.from({ length: count }, (_, index) => ({
      content: `${label} chunk ${index} of the deferred embedding fixture`,
      chunk_index: index,
      section_path: ['Deferred'],
      chunk_kind: 'text',
      embedding_text_version: 2,
      metadata: {},
    }));

  const write = (documentId: string, tenant: Tenant, chunks: unknown[], embeddings: unknown) =>
    query(
      `SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => $5)`,
      [documentId, tenant.key, JSON.stringify(chunks), JSON.stringify(embeddings), chunks.length],
    );

  const complete = async (documentId: string, profileId: string, tenantKey: string): Promise<boolean> => {
    const [row] = await query('SELECT rag_vectors_complete($1, $2, $3) AS ok', [documentId, profileId, tenantKey]);
    return row?.ok === true;
  };

  const chunkIds = async (documentId: string): Promise<string[]> =>
    (await query('SELECT id FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId])).map((row) => String(row.id));

  async function createBatch(tenant: Tenant): Promise<string> {
    const [row] = await query("SELECT id FROM rag_create_ingestion_batch($1, 'folder', 'fixture', NULL, 4, 'worker', NULL)", [tenant.key]);
    return String(row?.id);
  }

  /** A claimed backfill job whose version has `count` chunks written without vectors, the way the deferred write stage leaves it. */
  async function writtenJob(
    tenant: Tenant,
    options: { embedMode?: 'sync' | 'batch_api'; sourceKey?: string; count?: number; batchId?: string } = {},
  ): Promise<{ batchId: string; jobId: string; documentId: string }> {
    const batchId = options.batchId ?? (await createBatch(tenant));
    const sourceKey = options.sourceKey ?? `deferred/${++sequence}.txt`;
    await query('SELECT rag_enqueue_backfill_jobs($1, $2::jsonb)', [
      batchId,
      JSON.stringify([{ kind: 'ingest', source: 'config_upload', source_key: sourceKey, settings: settings(options.embedMode ?? 'batch_api') }]),
    ]);
    const [job] = await query('SELECT id FROM ingestion_jobs WHERE batch_id = $1 AND source_key = $2', [batchId, sourceKey]);
    const jobId = String(job?.id);
    const claimed = await query('SELECT id FROM rag_claim_ingestion_job($1, $2)', [jobId, WORKER]);
    assert.equal(claimed[0]?.id, jobId, 'claimed');
    const documentId = await begin(tenant, sourceKey);
    await query("SELECT id FROM rag_advance_ingestion_job($1, $2, 'write', 'embedding', NULL, NULL, $3::jsonb)", [
      jobId,
      WORKER,
      JSON.stringify({ document_id: documentId }),
    ]);
    await write(documentId, tenant, chunksOf(options.count ?? 3, sourceKey), null);
    return { batchId, jobId, documentId };
  }

  const defer = (jobId: string, worker = WORKER) => query('SELECT * FROM rag_defer_ingestion_embed($1, $2)', [jobId, worker]);

  test('rag_vectors_complete: false while one chunk lacks a vector of the profile, true once every chunk has one', async () => {
    const documentId = await begin(A, `complete/${++sequence}.txt`);
    const chunks = chunksOf(3, 'complete');
    await write(documentId, A, chunks, null);
    assert.equal(await complete(documentId, LEGACY, A.key), false, 'no vector at all');
    assert.equal(await complete(documentId, VOYAGE, A.key), false);

    await write(documentId, A, chunks, { [LEGACY]: chunks.map((_, i) => vector(1536, i)), [VOYAGE]: { vectors: chunks.map((_, i) => vector(1024, i)), host: 'voyage' } });
    assert.equal(await complete(documentId, LEGACY, A.key), true);
    assert.equal(await complete(documentId, VOYAGE, A.key), true);

    const [last] = (await chunkIds(documentId)).slice(-1);
    await query('UPDATE document_chunks SET embedding = NULL WHERE id = $1', [last]);
    await query('DELETE FROM chunk_embeddings WHERE chunk_id = $1 AND profile_id = $2', [last, VOYAGE]);
    assert.equal(await complete(documentId, LEGACY, A.key), false, 'one chunk lacks its legacy vector');
    assert.equal(await complete(documentId, VOYAGE, A.key), false, 'one chunk lacks its voyage row');
  });

  test('rag_vectors_complete: another tenant key, an unknown document and an unknown profile are refused', async () => {
    const documentId = await begin(A, `complete-tenant/${++sequence}.txt`);
    await write(documentId, A, chunksOf(1, 'tenant'), null);
    assert.match(String(await errorOf('SELECT rag_vectors_complete($1, $2, $3)', [documentId, LEGACY, B.key])), /tenant_mismatch/);
    assert.match(String(await errorOf('SELECT rag_vectors_complete($1, $2, $3)', [crypto.randomUUID(), LEGACY, A.key])), /tenant_mismatch/);
    assert.match(String(await errorOf('SELECT rag_vectors_complete($1, $2, $3)', [documentId, 'no-such-profile', A.key])), /embedding_profile_unsupported/);
  });

  test('every deferred-embedding function is executable by service_role only', async () => {
    const signatures = [
      'public.rag_vectors_complete(uuid, text, text)',
      'public.rag_defer_ingestion_embed(uuid, text)',
      'public.rag_deferred_embed_chunks(uuid, text, uuid, integer)',
      'public.rag_write_deferred_vectors(uuid, text, jsonb)',
      'public.rag_publish_deferred_ingestion_job(uuid, text)',
      'public.rag_batch_progress(uuid)',
    ];
    for (const signature of signatures) {
      const [row] = await query(
        `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', $1, 'EXECUTE') AS service`,
        [signature],
      );
      assert.deepEqual(row, { anon: false, authenticated: false, service: true }, signature);
    }
  });

  test('defer: a batch_api backfill job is parked at embed_deferred with its lease released; it is not claimed again and counts apart', async () => {
    const { batchId, jobId, documentId } = await writtenJob(A);
    const [row] = await defer(jobId);
    assert.equal(row?.status, 'embedding');
    assert.equal(row?.stage, 'embed_deferred');
    assert.equal(row?.locked_by, null);
    assert.equal(row?.lease_until, null);
    const [doc] = await query('SELECT status, is_current, processing_status FROM documents WHERE id = $1', [documentId]);
    assert.deepEqual(doc, { status: 'processing', is_current: false, processing_status: 'embedding' });
    const reclaimed = await query('SELECT id FROM rag_claim_ingestion_job($1, $2)', [jobId, 'another-worker']);
    assert.ok(reclaimed.every((r) => r.id === null), 'a deferred job is never claimed');
    const [progress] = await query('SELECT rag_batch_progress($1) AS p', [batchId]);
    assert.deepEqual((progress?.p as Row).counts, { ingest: { embed_deferred: 1 } });
  });

  test('defer: refused for a sync job and for a worker without the lease', async () => {
    const sync = await writtenJob(A, { embedMode: 'sync' });
    assert.match(String(await errorOf('SELECT * FROM rag_defer_ingestion_embed($1, $2)', [sync.jobId, WORKER])), /defer_not_allowed/);
    const other = await writtenJob(A);
    assert.match(String(await errorOf('SELECT * FROM rag_defer_ingestion_embed($1, $2)', [other.jobId, 'not-the-holder'])), /lease_lost/);
  });

  test('publish: a deferred job with a missing vector raises vectors_incomplete and the previous version stays current', async () => {
    const sourceKey = `deferred-swap/${++sequence}.txt`;
    const previous = await begin(A, sourceKey);
    await write(previous, A, chunksOf(2, 'previous'), { [LEGACY]: [vector(1536, 0), vector(1536, 1)] });
    const [published] = await query('SELECT * FROM rag_publish_document_version($1, $2)', [previous, A.key]);
    assert.equal(published?.outcome, 'published');

    const { batchId, jobId, documentId } = await writtenJob(A, { sourceKey });
    await defer(jobId);
    const ids = await chunkIds(documentId);
    assert.equal(ids.length, 3);

    const listed = await query('SELECT id, job_id, embedding_text_version, content FROM rag_deferred_embed_chunks($1, $2, NULL, 100)', [batchId, LEGACY]);
    assert.deepEqual(
      listed.map((row) => row.id),
      [...ids].sort(),
    );
    assert.ok(listed.every((row) => row.job_id === jobId && row.embedding_text_version === 2));

    // Two of three vectors: one stale text version is skipped, so the version stays incomplete.
    const rows = ids.map((id, index) => ({ chunk_id: id, embedding_text_version: index === 2 ? 1 : 2, embedding: vector(1536, index) }));
    const [result] = await query('SELECT * FROM rag_write_deferred_vectors($1, $2, $3::jsonb)', [batchId, LEGACY, JSON.stringify(rows)]);
    assert.deepEqual(result, { written: 2, skipped: 1 });
    assert.equal(await complete(documentId, LEGACY, A.key), false);

    const refusal = await errorOf('SELECT * FROM rag_publish_deferred_ingestion_job($1, $2)', [jobId, LEGACY]);
    assert.match(String(refusal), /vectors_incomplete/);
    const [kept] = await query('SELECT is_current, status FROM documents WHERE id = $1', [previous]);
    assert.deepEqual(kept, { is_current: true, status: 'ready' }, 'the previous version stays current');
    const [stillDeferred] = await query('SELECT status, stage FROM ingestion_jobs WHERE id = $1', [jobId]);
    assert.deepEqual(stillDeferred, { status: 'embedding', stage: 'embed_deferred' });

    const remaining = await query('SELECT id FROM rag_deferred_embed_chunks($1, $2, NULL, 100)', [batchId, LEGACY]);
    assert.deepEqual(remaining.map((row) => row.id), [ids[2]]);
    const [last] = await query('SELECT * FROM rag_write_deferred_vectors($1, $2, $3::jsonb)', [
      batchId,
      LEGACY,
      JSON.stringify([{ chunk_id: ids[2], embedding_text_version: 2, embedding: vector(1536, 2) }]),
    ]);
    assert.deepEqual(last, { written: 1, skipped: 0 });

    const [done] = await query('SELECT * FROM rag_publish_deferred_ingestion_job($1, $2)', [jobId, LEGACY]);
    assert.equal(done?.status, 'ready');
    assert.equal(done?.stage, 'ready');
    const docs = await query('SELECT id, is_current, status, processing_status FROM documents WHERE id = ANY($1) ORDER BY version', [[previous, documentId]]);
    assert.deepEqual([docs[0]?.id, docs[0]?.is_current, docs[0]?.status], [previous, false, 'ready'], 'the previous version is superseded');
    assert.deepEqual(docs[1], { id: documentId, is_current: true, status: 'ready', processing_status: 'ready' });
    const [again] = await query('SELECT status FROM rag_publish_deferred_ingestion_job($1, $2)', [jobId, LEGACY]);
    assert.equal(again?.status, 'ready', 'a repeated publish answers with the finished job');
  });

  test('publish: a non-active profile cannot vouch for completeness, and a job that is not deferred is refused', async () => {
    const { jobId } = await writtenJob(A);
    assert.match(String(await errorOf('SELECT * FROM rag_publish_deferred_ingestion_job($1, $2)', [jobId, LEGACY])), /not_deferred/);
    await defer(jobId);
    assert.match(String(await errorOf('SELECT * FROM rag_publish_deferred_ingestion_job($1, $2)', [jobId, VOYAGE])), /profile_not_active/);
  });

  test('write: only chunks of the batch deferred jobs are written; another tenant chunk is skipped and wrong dimensions are refused', async () => {
    const mine = await writtenJob(A, { count: 1 });
    await defer(mine.jobId);
    const foreign = await writtenJob(B, { count: 1 });
    await defer(foreign.jobId);
    const [foreignChunk] = await chunkIds(foreign.documentId);
    const [myChunk] = await chunkIds(mine.documentId);

    const [result] = await query('SELECT * FROM rag_write_deferred_vectors($1, $2, $3::jsonb)', [
      mine.batchId,
      VOYAGE,
      JSON.stringify([
        { chunk_id: myChunk, embedding_text_version: 2, embedding: vector(1024, 1), host: 'batch' },
        { chunk_id: foreignChunk, embedding_text_version: 2, embedding: vector(1024, 2) },
      ]),
    ]);
    assert.deepEqual(result, { written: 1, skipped: 1 });
    const stored = await query('SELECT chunk_id, tenant_key, embedding_host FROM chunk_embeddings WHERE chunk_id = ANY($1) AND profile_id = $2', [
      [myChunk, foreignChunk],
      VOYAGE,
    ]);
    assert.deepEqual(stored, [{ chunk_id: myChunk, tenant_key: A.key, embedding_host: 'batch' }]);
    const listedForeign = await query('SELECT id FROM rag_deferred_embed_chunks($1, $2, NULL, 100)', [mine.batchId, LEGACY]);
    assert.deepEqual(listedForeign.map((row) => row.id), [myChunk], 'the listing never crosses into another batch or tenant');

    const mismatch = await errorOf('SELECT * FROM rag_write_deferred_vectors($1, $2, $3::jsonb)', [
      mine.batchId,
      LEGACY,
      JSON.stringify([{ chunk_id: myChunk, embedding_text_version: 2, embedding: vector(1024, 1) }]),
    ]);
    assert.match(String(mismatch), /embedding_profile_mismatch/);
  });
});
