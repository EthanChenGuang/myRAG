import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-2048';
const QWEN_2048 = 'qwen3-8b-2048';
const QWEN_1024 = 'qwen3-8b-1024';

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

function vector(dims: number, hot: number): number[] {
  return Array.from({ length: dims }, (_, index) => (index === hot % dims ? 1 : 0));
}

let sequence = 0;

describe('re-embed SQL functions (migration 0315)', () => {
  let fixture: TwoTenantDatabase;

  before(async () => {
    fixture = await createTwoTenantDatabase();
  });

  after(async () => {
    await fixture?.db.close();
  });

  async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
    try {
      return (await fixture.db.query<Row>(sql, params)).rows;
    } catch (error) {
      return assert.fail(`${sql.slice(0, 80).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
    }
  }

  async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
    try {
      await fixture.db.query(sql, params);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  beforeEach(async () => {
    await fixture.db.query('DELETE FROM embedding_backfill_gaps');
    await fixture.db.query('DELETE FROM embedding_backfill_runs');
    await fixture.db.query('DELETE FROM chunk_embeddings');
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available', activated_at = NULL, activated_by = NULL, previous_active_id = NULL");
    await fixture.db.query(
      `UPDATE embedding_profiles SET status = 'active', activated_at = now() - interval '2 hours', activated_by = 'test' WHERE id = $1`,
      [LEGACY],
    );
  });

  async function seedDocument(tenant: Tenant, label: string, count: number, sourceKey = `reembed-${++sequence}.md`): Promise<{ documentId: string; chunkIds: string[] }> {
    const begun = await query(
      `SELECT * FROM rag_begin_document_version(
         p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL, p_source => 'config_upload', p_source_key => $3, p_filename => $3,
         p_file_sha256 => $4, p_doc_type => 'general', p_doc_type_origin => 'fallback', p_profile_id => 'general-1', p_profile_version => 1)`,
      [tenant.key, tenant.userId, sourceKey, crypto.createHash('sha256').update(`${sourceKey}:${++sequence}`).digest('hex')],
    );
    const documentId = String(begun[0]?.document_id);
    const chunks = Array.from({ length: count }, (_, index) => ({
      content: `${label} chunk ${index} about pallets and forklifts`,
      chunk_index: index,
      section_path: ['Re-embed', label],
      chunk_kind: 'text',
      embedding_text_version: 1,
      metadata: {},
    }));
    await query('SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => NULL, p_final => true, p_total => $4)', [
      documentId,
      tenant.key,
      JSON.stringify(chunks),
      count,
    ]);
    await query('SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, tenant.key]);
    const ids = await query('SELECT id FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId]);
    return { documentId, chunkIds: ids.map((row) => String(row.id)) };
  }

  const currentIds = async (tenantKey: string | null): Promise<string[]> =>
    (
      await query(
        `SELECT id FROM document_chunks WHERE is_current AND status = 'ready' AND ($1::text IS NULL OR tenant_key = $1) ORDER BY id`,
        [tenantKey],
      )
    ).map((row) => String(row.id));

  const startRun = async (profileId: string, tenantKey: string | null = null, derivedFrom: string | null = null): Promise<string> => {
    const rows = await query('SELECT * FROM rag_reembed_start_run(p_profile_id => $1, p_tenant_key => $2, p_actor => $3, p_derived_from => $4)', [
      profileId,
      tenantKey,
      'test',
      derivedFrom,
    ]);
    return String(rows[0]?.run_id);
  };

  const startError = (profileId: string, tenantKey: string | null = null, actor: string | null = 'test', derivedFrom: string | null = null) =>
    errorOf('SELECT * FROM rag_reembed_start_run(p_profile_id => $1, p_tenant_key => $2, p_actor => $3, p_derived_from => $4)', [profileId, tenantKey, actor, derivedFrom]);

  const nextBatch = (runId: string, after: string | null, limit: number) =>
    query('SELECT * FROM rag_reembed_next_batch(p_run_id => $1, p_after => $2, p_limit => $3)', [runId, after, limit]);

  const writeRows = (runId: string, rows: unknown[], cursor: string | null, tokens = 0) =>
    query('SELECT * FROM rag_reembed_write_batch(p_run_id => $1, p_rows => $2::jsonb, p_cursor => $3, p_tokens => $4)', [runId, JSON.stringify(rows), cursor, tokens]);

  const writeError = (runId: string, rows: unknown[], cursor: string | null) =>
    errorOf('SELECT * FROM rag_reembed_write_batch(p_run_id => $1, p_rows => $2::jsonb, p_cursor => $3, p_tokens => 0)', [runId, JSON.stringify(rows), cursor]);

  const rowCount = async (profileId: string): Promise<number> =>
    Number((await query('SELECT count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1', [profileId]))[0]?.n);

  const profileStatus = async (profileId: string): Promise<string> =>
    String((await query('SELECT status FROM embedding_profiles WHERE id = $1', [profileId]))[0]?.status);

  test('start_run creates a running run, sets the profile to backfilling and counts the chunks in scope', async () => {
    await seedDocument(A, 'start-a', 3);
    await seedDocument(B, 'start-b', 2);
    const rows = await query('SELECT * FROM rag_reembed_start_run(p_profile_id => $1, p_tenant_key => $2, p_actor => $3, p_derived_from => NULL)', [VOYAGE, A.key, 'test']);
    assert.equal(rows.length, 1, 'start_run must return the new run');
    assert.equal(rows[0]?.profile_id, VOYAGE);
    assert.equal(rows[0]?.tenant_key, A.key);
    assert.equal(Number(rows[0]?.chunks_total), (await currentIds(A.key)).length);
    const run = (await query('SELECT status, tenant_key, cursor_chunk_id, chunks_done FROM embedding_backfill_runs WHERE id = $1', [rows[0]?.run_id]))[0];
    assert.deepEqual([run?.status, run?.tenant_key, run?.cursor_chunk_id, Number(run?.chunks_done)], ['running', A.key, null, 0]);
    assert.equal(await profileStatus(VOYAGE), 'backfilling');
    assert.equal(await profileStatus(LEGACY), 'active');
  });

  test('start_run is refused for the active profile, legacy storage, a retired or unknown profile, a bad tenant key and a missing actor', async () => {
    assert.match((await startError(LEGACY)) ?? 'no error', /reembed_refused: profile_is_active/);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [LEGACY]);
    assert.match((await startError(LEGACY)) ?? 'no error', /reembed_refused: legacy_storage/);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'active' WHERE id = $1", [LEGACY]);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'retired' WHERE id = $1", [VOYAGE]);
    assert.match((await startError(VOYAGE)) ?? 'no error', /reembed_refused: profile_retired/);
    assert.match((await startError('no-such-profile')) ?? 'no error', /reembed_refused: unknown_profile/);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [VOYAGE]);
    assert.match((await startError(VOYAGE, 'not-a-tenant-key')) ?? 'no error', /reembed_refused: invalid_tenant_key/);
    assert.match((await startError(VOYAGE, null, '  ')) ?? 'no error', /reembed_refused: actor_required/);
    assert.equal(await profileStatus(VOYAGE), 'available', 'a refused start changes nothing');
    assert.equal((await query('SELECT count(*)::int AS n FROM embedding_backfill_runs'))[0]?.n, 0);
  });

  test('a second running run of the same profile is refused when the tenants overlap and allowed when they do not', async () => {
    const first = await startRun(VOYAGE, A.key);
    assert.match((await startError(VOYAGE, A.key)) ?? 'no error', /reembed_refused: run_in_progress/);
    assert.match((await startError(VOYAGE, null)) ?? 'no error', /reembed_refused: run_in_progress/, 'an unlimited run overlaps every tenant');
    const second = await startRun(VOYAGE, B.key);
    assert.notEqual(first, second);
    await query("SELECT * FROM rag_reembed_finish_run(p_run_id => $1, p_status => 'failed')", [first]);
    assert.ok(await startRun(VOYAGE, A.key), 'a failed run no longer blocks a new one');
  });

  test('next_batch returns current ready chunks after the cursor in id order and skips chunks that already have a vector', async () => {
    const { documentId } = await seedDocument(A, 'cursor', 5);
    const superseded = await seedDocument(A, 'old-edition', 2, 'reembed-edition.md');
    await seedDocument(A, 'new-edition', 2, 'reembed-edition.md');
    const quarantined = await seedDocument(A, 'quarantined', 2);
    await fixture.db.query("UPDATE document_chunks SET status = 'quarantined' WHERE document_id = $1", [quarantined.documentId]);
    const runId = await startRun(VOYAGE, A.key);

    const expected = await currentIds(A.key);
    const all = await nextBatch(runId, null, 1000);
    assert.deepEqual(
      all.map((row) => row.id),
      expected,
      'every current ready chunk of the tenant, in id order',
    );
    for (const row of all) {
      assert.ok(!superseded.chunkIds.includes(String(row.id)), 'a superseded chunk is never returned');
      assert.ok(!quarantined.chunkIds.includes(String(row.id)), 'a quarantined chunk is never returned');
    }
    const first = all[0] as Row;
    assert.equal(first.tenant_key, A.key);
    assert.equal(typeof first.content, 'string');
    assert.ok(Array.isArray(first.section_path));
    assert.ok('chunk_kind' in first && 'doc_type' in first && 'template_row' in first && 'document_id' in first);

    const page = await nextBatch(runId, String(all[1]?.id), 2);
    assert.deepEqual(
      page.map((row) => row.id),
      expected.slice(2, 4),
      'the cursor is exclusive',
    );

    await writeRows(runId, [{ chunk_id: expected[0], vector: vector(2048, 0), host: 'fake' }], null);
    const remaining = await nextBatch(runId, null, 1000);
    assert.deepEqual(
      remaining.map((row) => row.id),
      expected.slice(1),
      'a chunk with a vector of this profile is skipped',
    );
    assert.ok(documentId);
  });

  test('a run limited to tenant A reads only tenant A and cannot write a vector for tenant B', async () => {
    const forA = await seedDocument(A, 'iso-a', 2);
    const forB = await seedDocument(B, 'iso-b', 2);
    const runId = await startRun(VOYAGE, A.key);
    const picked = await nextBatch(runId, null, 1000);
    assert.ok(picked.length >= forA.chunkIds.length);
    assert.ok(picked.every((row) => row.tenant_key === A.key), 'nothing of another tenant is returned');
    assert.ok(!picked.some((row) => forB.chunkIds.includes(String(row.id))));

    const error = await writeError(
      runId,
      [
        { chunk_id: forA.chunkIds[0], vector: vector(2048, 1), host: 'fake' },
        { chunk_id: forB.chunkIds[0], vector: vector(2048, 2), host: 'fake' },
      ],
      null,
    );
    assert.match(error ?? 'no error', /tenant_mismatch/);
    assert.equal(await rowCount(VOYAGE), 0, 'the refusal rolls the whole batch back, including the tenant A row');
  });

  test('write_batch upserts the rows, moves the cursor and counts in one transaction and rolls everything back on a wrong-length vector', async () => {
    const { chunkIds } = await seedDocument(A, 'write', 3);
    const runId = await startRun(VOYAGE, A.key);
    const batch = await nextBatch(runId, null, 1000);
    const ids = batch.map((row) => String(row.id));
    const first = ids.slice(0, 2);

    const written = await writeRows(
      runId,
      first.map((id, index) => ({ chunk_id: id, vector: vector(2048, index), host: 'host-one' })),
      first[1] ?? null,
      42,
    );
    assert.equal(Number(written[0]?.chunks_written), 2);
    const run = (await query('SELECT cursor_chunk_id, chunks_done, tokens FROM embedding_backfill_runs WHERE id = $1', [runId]))[0];
    assert.deepEqual([run?.cursor_chunk_id, Number(run?.chunks_done), Number(run?.tokens)], [first[1], 2, 42]);
    const stored = await query('SELECT embedding_model, dims, embedding_host, tenant_key FROM chunk_embeddings WHERE profile_id = $1', [VOYAGE]);
    assert.equal(stored.length, 2);
    assert.ok(stored.every((row) => row.embedding_model === 'voyage-4-large' && Number(row.dims) === 2048 && row.embedding_host === 'host-one' && row.tenant_key === A.key));

    await writeRows(runId, [{ chunk_id: first[0], vector: vector(2048, 9), host: 'host-two' }], null);
    assert.equal(await rowCount(VOYAGE), 2, 'a repeated chunk upserts, it does not add a row');
    assert.equal((await query('SELECT embedding_host FROM chunk_embeddings WHERE chunk_id = $1 AND profile_id = $2', [first[0], VOYAGE]))[0]?.embedding_host, 'host-two');
    assert.equal((await query('SELECT cursor_chunk_id FROM embedding_backfill_runs WHERE id = $1', [runId]))[0]?.cursor_chunk_id, first[1], 'a null cursor leaves it alone');

    const rest = ids.slice(2);
    assert.ok(rest.length >= 2, 'the tenant has at least two chunks without a vector');
    const refused = await writeError(
      runId,
      [
        { chunk_id: rest[0], vector: vector(2048, 3), host: 'fake' },
        { chunk_id: rest[1], vector: vector(1024, 4), host: 'fake' },
      ],
      rest[1] ?? null,
    );
    assert.match(refused ?? 'no error', /embedding_profile_mismatch/);
    assert.equal(await rowCount(VOYAGE), 2, 'nothing of the refused batch was written, not even its valid row');
    assert.equal((await query('SELECT cursor_chunk_id FROM embedding_backfill_runs WHERE id = $1', [runId]))[0]?.cursor_chunk_id, first[1], 'and the cursor did not move');
    assert.ok(chunkIds.length === 3);
  });

  test('write_batch refuses a run that is not running, a chunk that is not current and a malformed row list', async () => {
    const { chunkIds } = await seedDocument(A, 'guards', 2);
    const old = await seedDocument(A, 'guards-old', 1, 'reembed-guards-edition.md');
    await seedDocument(A, 'guards-new', 1, 'reembed-guards-edition.md');
    const runId = await startRun(VOYAGE, A.key);

    assert.match((await writeError(runId, [{ chunk_id: old.chunkIds[0], vector: vector(2048, 1), host: 'fake' }], null)) ?? 'no error', /reembed_refused: chunk_not_current/);
    assert.match((await writeError(runId, [], null)) ?? 'no error', /invalid_rows/);
    assert.match((await writeError(runId, [{ chunk_id: chunkIds[0], vector: 'nope' }], null)) ?? 'no error', /invalid_rows/);
    assert.match(
      (await writeError(
        runId,
        [
          { chunk_id: chunkIds[0], vector: vector(2048, 1), host: 'fake' },
          { chunk_id: chunkIds[0], vector: vector(2048, 2), host: 'fake' },
        ],
        null,
      )) ?? 'no error',
      /invalid_rows/,
      'the same chunk twice in one batch',
    );
    await query("SELECT * FROM rag_reembed_finish_run(p_run_id => $1, p_status => 'failed')", [runId]);
    assert.match((await writeError(runId, [{ chunk_id: chunkIds[0], vector: vector(2048, 1), host: 'fake' }], null)) ?? 'no error', /reembed_refused: run_not_running/);
    assert.equal(await rowCount(VOYAGE), 0);
  });

  test('missing_batch returns the chunks that lack a vector, gaps included, and a written vector clears its gap', async () => {
    const { chunkIds } = await seedDocument(A, 'gaps', 3);
    const runId = await startRun(VOYAGE, A.key);
    await query("INSERT INTO embedding_backfill_gaps (run_id, chunk_id, profile_id, reason) VALUES ($1, $2, $3, 'provider_failed')", [runId, chunkIds[1], VOYAGE]);
    await writeRows(runId, [{ chunk_id: chunkIds[0], vector: vector(2048, 0), host: 'fake' }], null);

    const missing = await query('SELECT * FROM rag_reembed_missing_batch(p_run_id => $1, p_after => NULL, p_limit => 1000)', [runId]);
    const ids = missing.map((row) => String(row.id));
    assert.ok(!ids.includes(String(chunkIds[0])), 'a chunk with a vector is not missing');
    assert.ok(ids.includes(String(chunkIds[1])) && ids.includes(String(chunkIds[2])));
    const gap = missing.find((row) => row.id === chunkIds[1]);
    assert.equal(gap?.has_gap, true);
    assert.equal(missing.find((row) => row.id === chunkIds[2])?.has_gap, false);

    await writeRows(runId, [{ chunk_id: chunkIds[1], vector: vector(2048, 1), host: 'fake' }], null);
    assert.equal(Number((await query('SELECT count(*)::int AS n FROM embedding_backfill_gaps WHERE chunk_id = $1', [chunkIds[1]]))[0]?.n), 0, 'the gap is resolved');
  });

  test('count reports chunks, missing chunks and content characters per tenant', async () => {
    const forA = await seedDocument(A, 'count-a', 3);
    await seedDocument(B, 'count-b', 2);
    const runId = await startRun(VOYAGE);
    await writeRows(runId, [{ chunk_id: forA.chunkIds[0], vector: vector(2048, 0), host: 'fake' }], null);

    const counts = await query('SELECT * FROM rag_reembed_count(p_profile_id => $1, p_tenant_key => NULL)', [VOYAGE]);
    const byTenant = new Map(counts.map((row) => [String(row.tenant_key), row]));
    const expectA = await query(
      `SELECT count(*)::int AS chunks, sum(length(content)) FILTER (WHERE id <> $2)::int AS missing_chars FROM document_chunks WHERE tenant_key = $1 AND is_current AND status = 'ready'`,
      [A.key, forA.chunkIds[0]],
    );
    assert.equal(Number(byTenant.get(A.key)?.chunks), Number(expectA[0]?.chunks));
    assert.equal(Number(byTenant.get(A.key)?.chunks_missing), Number(expectA[0]?.chunks) - 1);
    assert.equal(Number(byTenant.get(A.key)?.content_chars), Number(expectA[0]?.missing_chars));
    assert.ok(byTenant.has(B.key));
    const onlyB = await query('SELECT * FROM rag_reembed_count(p_profile_id => $1, p_tenant_key => $2)', [VOYAGE, B.key]);
    assert.deepEqual(
      onlyB.map((row) => row.tenant_key),
      [B.key],
    );
    assert.equal(await rowCount(VOYAGE), 1, 'counting writes nothing');
  });

  test('derive_batch fills a 1024 profile from 2048 vectors with unit vectors, tenant limited, and leaves chunks without a source missing', async () => {
    const forA = await seedDocument(A, 'derive-a', 3);
    const forB = await seedDocument(B, 'derive-b', 2);
    const source = await startRun(QWEN_2048);
    const wide = [...forA.chunkIds.slice(0, 2), ...forB.chunkIds];
    await writeRows(
      source,
      wide.map((id, index) => ({ chunk_id: id, vector: Array.from({ length: 2048 }, (_, k) => (k % 7) + index + 1), host: 'fake' })),
      null,
    );
    await query("SELECT * FROM rag_reembed_finish_run(p_run_id => $1, p_status => 'failed')", [source]);

    assert.match((await startError(QWEN_1024, null, 'test', VOYAGE)) ?? 'no error', /reembed_refused: derive_model_mismatch/);
    assert.match((await startError(QWEN_2048, null, 'test', QWEN_1024)) ?? 'no error', /reembed_refused: derive_dims_not_smaller/);

    const runId = await startRun(QWEN_1024, A.key, QWEN_2048);
    const derived = await query('SELECT * FROM rag_reembed_derive_batch(p_run_id => $1, p_limit => 100)', [runId]);
    assert.equal(Number(derived[0]?.chunks_derived), 2, 'only the two tenant A chunks that have a source vector');
    const rows = await query(
      `SELECT chunk_id, dims, tenant_key, embedding_model, embedding_host,
              sqrt(sum(x * x))::float8 AS norm
       FROM chunk_embeddings e, LATERAL unnest(e.embedding::real[]) AS x
       WHERE e.profile_id = $1 GROUP BY chunk_id, dims, tenant_key, embedding_model, embedding_host`,
      [QWEN_1024],
    );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(Number(row.dims), 1024);
      assert.equal(row.tenant_key, A.key, 'tenant B was not touched');
      assert.equal(row.embedding_model, 'Qwen/Qwen3-Embedding-8B');
      assert.ok(Math.abs(Number(row.norm) - 1) < 0.01, `the derived vector is unit length, got ${String(row.norm)}`);
    }
    const again = await query('SELECT * FROM rag_reembed_derive_batch(p_run_id => $1, p_limit => 100)', [runId]);
    assert.equal(Number(again[0]?.chunks_derived), 0);
    const left = await query('SELECT * FROM rag_reembed_remaining(p_run_id => $1)', [runId]);
    assert.ok(Number(Object.values(left[0] ?? {})[0]) > 0, 'chunks that have no source vector stay missing');
    assert.match(
      (await errorOf("SELECT * FROM rag_reembed_finish_run(p_run_id => $1, p_status => 'completed')", [runId])) ?? 'no error',
      /reembed_refused: incomplete/,
    );
  });

  test('finish_run completes a run only when no chunk of its scope is missing', async () => {
    const { chunkIds } = await seedDocument(A, 'finish', 2);
    const runId = await startRun(VOYAGE, A.key);
    assert.match((await errorOf("SELECT * FROM rag_reembed_finish_run(p_run_id => $1, p_status => 'completed')", [runId])) ?? 'no error', /reembed_refused: incomplete/);
    const everything = await currentIds(A.key);
    await writeRows(
      runId,
      everything.map((id, index) => ({ chunk_id: id, vector: vector(2048, index), host: 'fake' })),
      null,
    );
    const done = await query("SELECT * FROM rag_reembed_finish_run(p_run_id => $1, p_status => 'completed')", [runId]);
    assert.deepEqual([done[0]?.status, Number(done[0]?.chunks_missing)], ['completed', 0]);
    assert.equal(await profileStatus(VOYAGE), 'backfilling', 'the profile stays backfilling until the activation gate flips it');
    assert.match((await errorOf("SELECT * FROM rag_reembed_finish_run(p_run_id => $1, p_status => 'bogus')", [runId])) ?? 'no error', /reembed_refused: invalid_status/);
    assert.ok(chunkIds.length === 2);
  });

  test('rollback deletes the rows the run wrote and keeps the rows that existed before it', async () => {
    const forA = await seedDocument(A, 'rollback', 3);
    const earlier = await startRun(VOYAGE, A.key);
    await writeRows(earlier, [{ chunk_id: forA.chunkIds[0], vector: vector(2048, 0), host: 'fake' }], null);
    await query("SELECT * FROM rag_reembed_finish_run(p_run_id => $1, p_status => 'failed')", [earlier]);
    await fixture.db.query("UPDATE chunk_embeddings SET embedded_at = now() - interval '1 day' WHERE profile_id = $1", [VOYAGE]);
    await fixture.db.query("UPDATE embedding_backfill_runs SET started_at = now() - interval '2 days' WHERE id = $1", [earlier]);

    const runId = await startRun(VOYAGE, A.key);
    const batch = await nextBatch(runId, null, 1000);
    await writeRows(
      runId,
      batch.map((row, index) => ({ chunk_id: row.id, vector: vector(2048, index + 3), host: 'fake' })),
      String(batch[batch.length - 1]?.id),
    );
    await query("SELECT * FROM rag_reembed_finish_run(p_run_id => $1, p_status => 'completed')", [runId]);
    assert.equal(await rowCount(VOYAGE), (await currentIds(A.key)).length);

    const rolled = await query('SELECT * FROM rag_reembed_rollback_run(p_run_id => $1, p_actor => $2)', [runId, 'test']);
    assert.equal(Number(rolled[0]?.rows_deleted), batch.length, 'exactly the rows this run wrote');
    assert.equal(rolled[0]?.profile_status, 'available');
    assert.equal(await rowCount(VOYAGE), 1, 'the row from the earlier run stays');
    assert.equal((await query('SELECT status FROM embedding_backfill_runs WHERE id = $1', [runId]))[0]?.status, 'rolled_back');
    assert.equal(await profileStatus(VOYAGE), 'available');
    assert.match((await errorOf('SELECT * FROM rag_reembed_rollback_run(p_run_id => $1, p_actor => $2)', [runId, 'test'])) ?? 'no error', /rollback_refused: already_rolled_back/);
  });

  test('rollback is refused for the active profile, for a run still in progress and within 10 minutes of a pointer flip, and allowed after', async () => {
    await seedDocument(A, 'rollback-guards', 2);
    const runId = await startRun(VOYAGE, A.key);
    assert.match((await errorOf('SELECT * FROM rag_reembed_rollback_run(p_run_id => $1, p_actor => $2)', [runId, 'test'])) ?? 'no error', /rollback_refused: run_in_progress/);
    const batch = await nextBatch(runId, null, 1000);
    await writeRows(
      runId,
      batch.map((row, index) => ({ chunk_id: row.id, vector: vector(2048, index), host: 'fake' })),
      null,
    );
    await query("SELECT * FROM rag_reembed_finish_run(p_run_id => $1, p_status => 'completed')", [runId]);

    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [LEGACY]);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'active', activated_at = now() - interval '1 minute', previous_active_id = $2 WHERE id = $1", [VOYAGE, LEGACY]);
    assert.match((await errorOf('SELECT * FROM rag_reembed_rollback_run(p_run_id => $1, p_actor => $2)', [runId, 'test'])) ?? 'no error', /rollback_refused: profile_is_active/);
    assert.equal(await rowCount(VOYAGE), batch.length, 'a refused rollback deletes nothing');

    await fixture.db.query("UPDATE embedding_profiles SET status = 'active', activated_at = now(), previous_active_id = NULL WHERE id = $1", [LEGACY]);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [VOYAGE]);
    assert.match((await errorOf('SELECT * FROM rag_reembed_rollback_run(p_run_id => $1, p_actor => $2)', [runId, 'test'])) ?? 'no error', /rollback_refused: recently_active/);
    assert.equal(await rowCount(VOYAGE), batch.length);

    await fixture.db.query("UPDATE embedding_profiles SET activated_at = now() - interval '11 minutes'");
    const rolled = await query('SELECT * FROM rag_reembed_rollback_run(p_run_id => $1, p_actor => $2)', [runId, 'test']);
    assert.equal(Number(rolled[0]?.rows_deleted), batch.length);
    assert.equal(await rowCount(VOYAGE), 0);
  });

  test('the legacy guard reports documents past version 1 and profiles other than the legacy one that are in use or hold vectors', async () => {
    const clean = await query('SELECT * FROM rag_reembed_legacy_guard()');
    assert.equal(Number(clean[0]?.versioned_documents), 0);
    assert.deepEqual(clean[0]?.profiles_in_use, []);

    await seedDocument(A, 'guard-v1', 1, 'reembed-guard-edition.md');
    await seedDocument(A, 'guard-v2', 1, 'reembed-guard-edition.md');
    await fixture.db.query("UPDATE embedding_profiles SET status = 'backfilling' WHERE id = $1", [VOYAGE]);
    const used = await query('SELECT * FROM rag_reembed_legacy_guard()');
    assert.ok(Number(used[0]?.versioned_documents) >= 1);
    assert.deepEqual(used[0]?.profiles_in_use, [VOYAGE]);

    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [VOYAGE]);
    const { chunkIds } = await seedDocument(B, 'guard-vectors', 1);
    const runId = await startRun(QWEN_1024, B.key);
    await writeRows(runId, [{ chunk_id: chunkIds[0], vector: vector(1024, 0), host: 'fake' }], null);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [QWEN_1024]);
    const holding = await query('SELECT * FROM rag_reembed_legacy_guard()');
    assert.deepEqual(holding[0]?.profiles_in_use, [QWEN_1024], 'an available profile that holds vectors would lose them with the chunks');
  });

  test('every rag_reembed function is executable by the service role only', async () => {
    const functions = await query(
      `SELECT p.oid::regprocedure::text AS signature,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'rag\\_reembed\\_%'`,
    );
    const names = functions.map((row) => String(row.signature).split('(')[0]);
    for (const expected of [
      'rag_reembed_start_run',
      'rag_reembed_get_run',
      'rag_reembed_resume_run',
      'rag_reembed_next_batch',
      'rag_reembed_missing_batch',
      'rag_reembed_write_batch',
      'rag_reembed_derive_batch',
      'rag_reembed_count',
      'rag_reembed_preview_batch',
      'rag_reembed_remaining',
      'rag_reembed_finish_run',
      'rag_reembed_rollback_run',
      'rag_reembed_legacy_guard',
    ]) {
      assert.ok(names.includes(expected), `${expected} is missing`);
    }
    for (const row of functions) {
      assert.equal(row.anon_exec, false, `${String(row.signature)} must not be executable by anon`);
      assert.equal(row.auth_exec, false, `${String(row.signature)} must not be executable by authenticated`);
    }
    for (const row of functions.filter((entry) => !String(entry.signature).startsWith('rag_reembed_pick'))) {
      assert.equal(row.service_exec, true, `${String(row.signature)} must be executable by service_role`);
    }
  });
});
