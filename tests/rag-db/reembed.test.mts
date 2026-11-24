import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
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

type QueryFn = (sql: string, params?: unknown[]) => Promise<Row[]>;

interface SeedOptions {
  docType?: string;
  profileId?: string;
  fields?: Record<string, unknown>;
  chunkKind?: string;
  sectionPath?: string[];
}

async function seedDocumentWith(
  query: QueryFn,
  tenant: Tenant,
  label: string,
  count: number,
  sourceKey = `reembed-${++sequence}.md`,
  options: SeedOptions = {},
): Promise<{ documentId: string; chunkIds: string[] }> {
  const begun = await query(
    `SELECT * FROM rag_begin_document_version(
       p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL, p_source => 'config_upload', p_source_key => $3, p_filename => $3,
       p_file_sha256 => $4, p_doc_type => $5, p_doc_type_origin => 'fallback', p_profile_id => $6, p_profile_version => 1)`,
    [
      tenant.key,
      tenant.userId,
      sourceKey,
      crypto.createHash('sha256').update(`${sourceKey}:${++sequence}`).digest('hex'),
      options.docType ?? 'general',
      options.profileId ?? 'general-1',
    ],
  );
  const documentId = String(begun[0]?.document_id);
  if (options.fields) {
    await query('SELECT * FROM rag_set_document_fields(p_document_id => $1, p_tenant_key => $2, p_fields => $3::jsonb)', [
      documentId,
      tenant.key,
      JSON.stringify(options.fields),
    ]);
  }
  const chunks = Array.from({ length: count }, (_, index) => ({
    content: `${label} chunk ${index} about pallets and forklifts`,
    chunk_index: index,
    section_path: options.sectionPath ?? ['Re-embed', label],
    chunk_kind: options.chunkKind ?? 'text',
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

  const seedDocument = (tenant: Tenant, label: string, count: number, sourceKey?: string) => seedDocumentWith(query, tenant, label, count, sourceKey);

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

    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [VOYAGE]);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'active', activated_at = now(), previous_active_id = NULL WHERE id = $1", [LEGACY]);
    assert.match((await errorOf('SELECT * FROM rag_reembed_rollback_run(p_run_id => $1, p_actor => $2)', [runId, 'test'])) ?? 'no error', /rollback_refused: recently_active/);
    assert.equal(await rowCount(VOYAGE), batch.length);

    await fixture.db.query("UPDATE embedding_profiles SET activated_at = now() - interval '11 minutes'");
    const rolled = await query('SELECT * FROM rag_reembed_rollback_run(p_run_id => $1, p_actor => $2)', [runId, 'test']);
    assert.equal(Number(rolled[0]?.rows_deleted), batch.length);
    assert.equal(await rowCount(VOYAGE), 0);
  });

  test('the legacy guard reports documents past version 1 and profiles other than the legacy one that are in use or hold vectors', async () => {
    const clean = await query('SELECT * FROM rag_reembed_legacy_guard()');
    const baseline = Number(clean[0]?.versioned_documents);
    assert.deepEqual(clean[0]?.profiles_in_use, [], 'only the legacy profile is active and none holds vectors');

    await seedDocument(A, 'guard-v1', 1, 'reembed-guard-edition.md');
    await seedDocument(A, 'guard-v2', 1, 'reembed-guard-edition.md');
    await fixture.db.query("UPDATE embedding_profiles SET status = 'backfilling' WHERE id = $1", [VOYAGE]);
    const used = await query('SELECT * FROM rag_reembed_legacy_guard()');
    assert.equal(Number(used[0]?.versioned_documents), baseline + 1, 'one more document is past version 1');
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

// ---------------------------------------------------------------------------------------------------------------------
// The TypeScript job over the same fixture, with fake providers only.
// ---------------------------------------------------------------------------------------------------------------------

class Killed extends Error {
  constructor() {
    super('the process was killed');
    this.name = 'Killed';
  }
}

function vectorFor(text: string, dims: number): number[] {
  const digest = crypto.createHash('sha256').update(text).digest();
  const raw = Array.from({ length: dims }, (_, index) => (digest[index % 32] as number) / 255 - 0.4 + (index % 5) * 0.01);
  const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0));
  return raw.map((x) => x / norm);
}

type Behaviour = 'ok' | 'wrong_dims' | 'wrong_model' | 'throw';

interface FakeProviderOptions {
  id: 'voyage' | 'qwen3';
  model: string;
  behave?: (call: number) => Behaviour;
  hostFor?: (call: number) => string;
}

function fakeEmbeddingProvider(options: FakeProviderOptions) {
  const seen: string[] = [];
  const batches: number[] = [];
  let calls = 0;
  const provider: import('@/lib/rag/embeddings/types').EmbeddingProvider = {
    id: options.id,
    model: options.model,
    maxInputTokens: 8000,
    supportedDims: [1024, 2048],
    normalize: true,
    async embedDocuments(texts, opts) {
      calls += 1;
      const mode = options.behave?.(calls) ?? 'ok';
      if (mode === 'throw') throw new Error('vendor unavailable');
      seen.push(...texts);
      batches.push(texts.length);
      const width = mode === 'wrong_dims' ? Math.floor(opts.dims / 2) : opts.dims;
      return {
        vectors: texts.map((text) => vectorFor(text, width)),
        model: mode === 'wrong_model' ? 'another-model' : options.model,
        host: options.hostFor?.(calls) ?? 'fake-host',
        usage: { tokens: texts.length * 10 },
      };
    },
    async embedQuery(text, opts) {
      return { vectors: [vectorFor(text, opts.dims)], model: options.model, host: 'fake-host', usage: { tokens: 1 } };
    },
  };
  return {
    provider,
    seen,
    batches,
    get calls() {
      return calls;
    },
  };
}

const VOYAGE_MODEL = 'voyage-4-large';
const QWEN_MODEL = 'Qwen/Qwen3-Embedding-8B';

describe('re-embed job (src/lib/rag/ingest/reembed)', () => {
  let fixture: TwoTenantDatabase;
  let edge: import('../../eval/harness/fake-edge.mts').FakeEdge;
  let reembed: typeof import('@/lib/rag/ingest/reembed/run');
  let costModule: typeof import('@/lib/rag/ingest/reembed/cost');
  let cliModule: typeof import('@/lib/rag/ingest/reembed/cli');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let registryModule: typeof import('@/lib/rag/embeddings/registry');
  let activeModule: typeof import('@/lib/rag/embeddings/active-profile');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let embeddingText: typeof import('@/lib/rag/ingest/text/embedding-text');
  let tokensModule: typeof import('@/lib/rag/ingest/text/tokens');
  let writerModule: typeof import('@/lib/rag/ingest/writer');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let targetsModule: typeof import('@/lib/rag/ingest/embedding-targets');
  let legacyTexts: string[] = [];

  before(async () => {
    const { fixtureProcessEnv, startFakeEdge } = await import('../../eval/harness/fake-edge.mts');
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    reembed = await import('@/lib/rag/ingest/reembed/run');
    costModule = await import('@/lib/rag/ingest/reembed/cost');
    cliModule = await import('@/lib/rag/ingest/reembed/cli');
    depsModule = await import('@/lib/rag/ingest/deps');
    configModule = await import('@/lib/rag/ingest/config');
    registryModule = await import('@/lib/rag/embeddings/registry');
    activeModule = await import('@/lib/rag/embeddings/active-profile');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    ingestModule = await import('@/lib/rag/ingest');
    embeddingText = await import('@/lib/rag/ingest/text/embedding-text');
    tokensModule = await import('@/lib/rag/ingest/text/tokens');
    writerModule = await import('@/lib/rag/ingest/writer');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    targetsModule = await import('@/lib/rag/ingest/embedding-targets');
    await fixture.db.exec(`
      CREATE TABLE IF NOT EXISTS test_embedding_writes (chunk_id uuid NOT NULL, profile_id text NOT NULL, n integer NOT NULL DEFAULT 0, PRIMARY KEY (chunk_id, profile_id));
      CREATE OR REPLACE FUNCTION test_count_embedding_write() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        INSERT INTO test_embedding_writes (chunk_id, profile_id, n) VALUES (NEW.chunk_id, NEW.profile_id, 1)
        ON CONFLICT (chunk_id, profile_id) DO UPDATE SET n = test_embedding_writes.n + 1;
        RETURN NEW;
      END $fn$;
      DROP TRIGGER IF EXISTS test_count_embedding_write ON chunk_embeddings;
      CREATE TRIGGER test_count_embedding_write AFTER INSERT OR UPDATE ON chunk_embeddings
        FOR EACH ROW EXECUTE FUNCTION test_count_embedding_write();
    `);
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const query: QueryFn = rows;
  const db = () => depsModule.getIngestDeps().db() as import('@/lib/rag/backend/supabase-rpc').RpcClient;

  const useEnv = (env: Record<string, string>) => {
    configModule.resetIngestConfigForTests();
    depsModule.setIngestDepsForTests({
      ingestEnv: () => env,
      embedDocuments: async (texts) => {
        legacyTexts.push(...texts);
        return texts.map((text, index) => vector(1536, text.length + index));
      },
    });
    activeModule.resetActiveProfileForTests();
  };

  beforeEach(async () => {
    legacyTexts = [];
    await fixture.db.query('DELETE FROM embedding_backfill_gaps');
    await fixture.db.query('DELETE FROM embedding_backfill_runs');
    await fixture.db.query('DELETE FROM chunk_embeddings');
    await fixture.db.query('DELETE FROM test_embedding_writes');
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available', activated_at = NULL, activated_by = NULL, previous_active_id = NULL");
    await fixture.db.query("UPDATE embedding_profiles SET status = 'active', activated_at = now() - interval '2 hours' WHERE id = $1", [LEGACY]);
    useEnv({ RAG_EMBEDDING_PROFILES: 'on' });
    edge.calls.length = 0;
  });

  afterEach(() => {
    registryModule.resetEmbeddingProvidersForTests();
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    activeModule.resetActiveProfileForTests();
  });

  const currentChunks = async (tenantKey: string | null = null): Promise<Row[]> =>
    rows(`SELECT id, tenant_key, content, section_path FROM document_chunks WHERE is_current AND status = 'ready' AND ($1::text IS NULL OR tenant_key = $1) ORDER BY id`, [tenantKey]);

  const rowCount = async (profileId: string): Promise<number> => Number((await rows('SELECT count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1', [profileId]))[0]?.n);

  const maxWrites = async (): Promise<{ chunks: number; max: number }> => {
    const result = (await rows('SELECT count(*)::int AS chunks, COALESCE(max(n), 0)::int AS max FROM test_embedding_writes'))[0] as Row;
    return { chunks: Number(result.chunks), max: Number(result.max) };
  };

  const useProvider = (fake: ReturnType<typeof fakeEmbeddingProvider>) => registryModule.setEmbeddingProvidersForTests({ [fake.provider.id]: fake.provider });

  const runRow = async (runId: string): Promise<Row> => (await rows('SELECT * FROM embedding_backfill_runs WHERE id = $1', [runId]))[0] as Row;

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

  const upload = async (userId: string, label: string) =>
    ingestModule.ingest({
      scope: await scopeOf(userId),
      source: 'config_upload',
      sourceKey: `root/${label}.md`,
      text: `# ${label}\n\nThe ${label} ledger lists every pallet that crossed the apron.\n\n## Second\n\nA second section about ${label} keeps the batch above one chunk.\n`,
      filename: `${label}.md`,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

  test('a run over the corpus fills every current ready chunk once, with the text ingest embeds for the same chunk', async () => {
    const uploaded = await upload(TWO_TENANT_IDS.userA, 'reembed-parity');
    assert.equal(uploaded.status, 'ready');
    const ingested = [...legacyTexts];
    assert.ok(ingested.length >= 2, 'ingest embedded the chunks of the new document');

    const fake = fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL });
    useProvider(fake);
    const report = await reembed.runReembed({ db: db(), profileId: VOYAGE, batchSize: 4 });

    const chunks = await currentChunks();
    assert.equal(report.status, 'completed');
    assert.equal(report.reason, null);
    assert.equal(report.chunksEmbedded, chunks.length);
    assert.equal(await rowCount(VOYAGE), chunks.length, 'one row per current ready chunk');
    const unembedded = await rows(
      `SELECT count(*)::int AS n FROM document_chunks c WHERE c.is_current AND c.status = 'ready'
         AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = $1)`,
      [VOYAGE],
    );
    assert.equal(unembedded[0]?.n, 0);
    assert.equal(fake.seen.length, chunks.length, 'each chunk was embedded exactly once');
    assert.ok(fake.batches.every((size) => size <= 4), 'batches respect the batch size');
    assert.deepEqual(await maxWrites(), { chunks: chunks.length, max: 1 });

    const available = new Map<string, number>();
    for (const text of fake.seen) available.set(text, (available.get(text) ?? 0) + 1);
    for (const text of ingested) {
      assert.ok((available.get(text) ?? 0) > 0, 'the text ingest embedded is the text the job embedded');
      available.set(text, (available.get(text) ?? 0) - 1);
    }

    const run = await runRow(report.runId);
    assert.deepEqual([run.status, Number(run.chunks_done)], ['completed', chunks.length]);
    assert.equal((await rows('SELECT status FROM embedding_profiles WHERE id = $1', [VOYAGE]))[0]?.status, 'backfilling');
    assert.ok(report.batches >= Math.ceil(chunks.length / 4));
  });

  test('the job makes no parser, sidecar, object-store or OpenAI call', async () => {
    const { startFakeSidecar } = await import('../helpers/fake-sidecar');
    const { startFakeLlamaParse } = await import('../helpers/fake-llamaparse');
    const sidecar = await startFakeSidecar();
    const llama = await startFakeLlamaParse();
    const previous = { url: process.env.RAG_SIDECAR_URL, secret: process.env.RAG_SIDECAR_SECRET, llama: process.env.LLAMA_CLOUD_API_KEY };
    process.env.RAG_SIDECAR_URL = sidecar.url;
    process.env.RAG_SIDECAR_SECRET = sidecar.secret;
    process.env.LLAMA_CLOUD_API_KEY = llama.apiKey;
    try {
      const refuse = (name: string) => async () => {
        throw new Error(`${name} must not be called by the re-embed job`);
      };
      objectStoreModule.setObjectStoreForTests({ put: refuse('object store'), get: refuse('object store'), remove: refuse('object store'), exists: refuse('object store') });
      depsModule.setIngestDepsForTests({ embedDocuments: refuse('legacy embedder'), rehydrate: refuse('rehydrate') as never });
      const fake = fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL });
      useProvider(fake);
      const report = await reembed.runReembed({ db: db(), profileId: VOYAGE, batchSize: 8 });
      assert.equal(report.status, 'completed');
      assert.equal(sidecar.calls.length, 0, 'no request reached the sidecar');
      assert.equal(llama.calls.length, 0, 'no request reached LlamaParse');
      const unexpected = edge.calls.filter(
        (call) => !(call.path.startsWith('/rest/v1/rpc/rag_reembed_') || call.path === '/rest/v1/rpc/rag_list_embedding_profiles'),
      );
      assert.deepEqual(unexpected, [], 'the edge saw re-embed and registry calls only: no embeddings, no document or object reads');
    } finally {
      await sidecar.close();
      await llama.close();
      for (const [key, value] of [['RAG_SIDECAR_URL', previous.url], ['RAG_SIDECAR_SECRET', previous.secret], ['LLAMA_CLOUD_API_KEY', previous.llama]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('a process killed between batches resumes from its cursor and ends with every chunk embedded exactly once', async () => {
    const fake = fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL });
    useProvider(fake);
    let runId = '';
    await assert.rejects(
      reembed.runReembed({
        db: db(),
        profileId: VOYAGE,
        batchSize: 4,
        hooks: {
          afterWrite: (info) => {
            runId = info.runId;
            if (info.batch === 2) throw new Killed();
          },
        },
      }),
      Killed,
    );
    const total = (await currentChunks()).length;
    const killed = await runRow(runId);
    assert.equal(killed.status, 'running', 'a killed process leaves its run running');
    assert.equal(Number(killed.chunks_done), 8);
    assert.ok(killed.cursor_chunk_id, 'two batches committed their cursor');
    assert.equal(await rowCount(VOYAGE), 8);

    const report = await reembed.runReembed({ db: db(), resumeRunId: runId, batchSize: 4 });
    assert.equal(report.status, 'completed');
    assert.equal(report.resumed, true);
    assert.equal(report.runId, runId);
    assert.equal(await rowCount(VOYAGE), total, 'one complete set');
    assert.equal(fake.seen.length, total, 'the batches that were committed were not embedded again');
    assert.deepEqual(await maxWrites(), { chunks: total, max: 1 }, 'no chunk was upserted twice');
    assert.equal((await runRow(runId)).status, 'completed');
  });

  test('a process killed after a batch was embedded and before it was written loses only that batch', async () => {
    const fake = fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL });
    useProvider(fake);
    let runId = '';
    await assert.rejects(
      reembed.runReembed({
        db: db(),
        profileId: VOYAGE,
        batchSize: 4,
        hooks: {
          beforeWrite: (info) => {
            runId = info.runId;
            if (info.batch === 3) throw new Killed();
          },
        },
      }),
      Killed,
    );
    assert.equal(await rowCount(VOYAGE), 8, 'the third batch was embedded but never written');
    assert.equal(fake.seen.length, 12);

    const report = await reembed.runReembed({ db: db(), resumeRunId: runId, batchSize: 4 });
    const total = (await currentChunks()).length;
    assert.equal(report.status, 'completed');
    assert.equal(await rowCount(VOYAGE), total);
    assert.deepEqual(await maxWrites(), { chunks: total, max: 1 }, 'every chunk was written once');
    assert.equal(fake.seen.length, total + 4, 'only the unfinished batch was embedded twice');
  });

  test('a resumed run must name the profile and tenant it was started with', async () => {
    const fake = fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL });
    useProvider(fake);
    let runId = '';
    await assert.rejects(
      reembed.runReembed({
        db: db(),
        profileId: VOYAGE,
        tenantKey: A.key,
        batchSize: 2,
        hooks: {
          afterWrite: (info) => {
            runId = info.runId;
            throw new Killed();
          },
        },
      }),
      Killed,
    );
    await assert.rejects(reembed.runReembed({ db: db(), resumeRunId: runId, profileId: QWEN_2048 }), (error: unknown) => (error as { code?: string }).code === 'resume_mismatch');
    await assert.rejects(reembed.runReembed({ db: db(), resumeRunId: runId, tenantKey: B.key }), (error: unknown) => (error as { code?: string }).code === 'resume_mismatch');
    assert.equal((await runRow(runId)).status, 'running', 'a refused resume changes nothing');
    const report = await reembed.runReembed({ db: db(), resumeRunId: runId, tenantKey: A.key, profileId: VOYAGE });
    assert.equal(report.status, 'completed');
  });

  test('a dry run reports chunks, tokens and cost per tenant, labels the token counts as estimates and writes nothing', async () => {
    const fake = fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL });
    useProvider(fake);
    await upload(TWO_TENANT_IDS.userA, 'dry-run-a');
    edge.calls.length = 0;
    const report = await reembed.dryRunReembed({ db: db(), profileId: VOYAGE, batchSize: 5 });

    const expected = new Map<string, { chunks: number; tokens: number }>();
    for (const chunk of await currentChunks()) {
      const text = embeddingText.buildEmbeddingText({
        section_path: chunk.section_path as string[],
        content: String(chunk.content),
        template_header: '',
      });
      const entry = expected.get(String(chunk.tenant_key)) ?? { chunks: 0, tokens: 0 };
      entry.chunks += 1;
      entry.tokens += tokensModule.countTokens(text);
      expected.set(String(chunk.tenant_key), entry);
    }
    assert.deepEqual(
      report.cost.tenants.map((tenant) => [tenant.tenantKey, tenant.chunks, tenant.tokens]).sort(),
      [...expected.entries()].map(([key, value]) => [key, value.chunks, value.tokens]).sort(),
    );
    const totalTokens = [...expected.values()].reduce((sum, entry) => sum + entry.tokens, 0);
    assert.equal(report.cost.totals.tokens, totalTokens);
    assert.ok(Math.abs(report.cost.totals.usd - (totalTokens * 0.12) / 1_000_000) < 1e-12, 'priced with the Voyage price table');
    assert.equal(report.cost.estimated, true);
    assert.match(report.cost.note ?? '', /estimate/i);
    assert.deepEqual([report.provider, report.dims, report.derived], ['voyage', 2048, false]);

    assert.equal(fake.calls, 0, 'a dry run calls no provider');
    assert.equal(await rowCount(VOYAGE), 0);
    assert.equal((await rows('SELECT count(*)::int AS n FROM embedding_backfill_runs'))[0]?.n, 0, 'and creates no run');
    assert.equal((await rows('SELECT status FROM embedding_profiles WHERE id = $1', [VOYAGE]))[0]?.status, 'available', 'the profile is not touched');
    const writes = edge.calls.filter((call) => /rag_reembed_(start|write|derive|finish|rollback|resume)/.test(call.path));
    assert.deepEqual(writes, [], 'only read functions ran');
  });

  test('--derive-from fills a 1024-dimension profile from stored 2048-dimension vectors with no provider call', async () => {
    const source = fakeEmbeddingProvider({ id: 'qwen3', model: QWEN_MODEL });
    useProvider(source);
    const first = await reembed.runReembed({ db: db(), profileId: QWEN_2048, batchSize: 8 });
    assert.equal(first.status, 'completed');
    const callsAfterSource = source.calls;

    const silent = fakeEmbeddingProvider({ id: 'qwen3', model: QWEN_MODEL, behave: () => 'throw' });
    useProvider(silent);
    const report = await reembed.runReembed({ db: db(), profileId: QWEN_1024, deriveFrom: QWEN_2048, batchSize: 8 });
    const total = (await currentChunks()).length;
    assert.equal(report.status, 'completed');
    assert.equal(report.derived, true);
    assert.equal(silent.calls, 0, 'a derived profile makes zero provider calls');
    assert.equal(source.calls, callsAfterSource);
    assert.equal(report.chunksEmbedded, total);
    assert.equal(await rowCount(QWEN_1024), total);
    const stored = await rows(
      `SELECT e.dims, sqrt(sum(x * x))::float8 AS norm
       FROM chunk_embeddings e, LATERAL unnest(e.embedding::real[]) AS x WHERE e.profile_id = $1 GROUP BY e.chunk_id, e.dims`,
      [QWEN_1024],
    );
    assert.equal(stored.length, total);
    assert.ok(stored.every((row) => Number(row.dims) === 1024 && Math.abs(Number(row.norm) - 1) < 0.01), 'unit vectors of 1024 dimensions');
    assert.equal((await runRow(report.runId)).derived_from, QWEN_2048);
  });

  test('a derive run whose source profile is incomplete fails with derive_source_incomplete and calls no provider', async () => {
    const source = fakeEmbeddingProvider({ id: 'qwen3', model: QWEN_MODEL });
    useProvider(source);
    await reembed.runReembed({ db: db(), profileId: QWEN_2048, tenantKey: A.key, batchSize: 8 });
    const report = await reembed.runReembed({ db: db(), profileId: QWEN_1024, deriveFrom: QWEN_2048, batchSize: 8 });
    assert.equal(report.status, 'failed');
    assert.equal(report.reason, 'derive_source_incomplete');
    assert.ok(report.chunksMissing > 0);
    assert.equal(report.chunksEmbedded, (await currentChunks(A.key)).length);
  });

  test('an answer with the wrong dimensions stops the run with embedding_profile_mismatch and leaves the cursor at the last good batch', async () => {
    const fake = fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL, behave: (call) => (call >= 3 ? 'wrong_dims' : 'ok') });
    useProvider(fake);
    const report = await reembed.runReembed({ db: db(), profileId: VOYAGE, batchSize: 4 });
    assert.equal(report.status, 'failed');
    assert.equal(report.reason, 'embedding_profile_mismatch');
    const ids = (await currentChunks()).map((chunk) => String(chunk.id));
    const run = await runRow(report.runId);
    assert.equal(run.status, 'failed');
    assert.equal(run.cursor_chunk_id, ids[7], 'the cursor sits on the last chunk of the second batch');
    assert.equal(await rowCount(VOYAGE), 8, 'nothing of the wrong batch was stored');
  });

  test('an answer from another model of the same dimensions stops the run with embedding_profile_mismatch', async () => {
    useProvider(fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL, behave: (call) => (call === 2 ? 'wrong_model' : 'ok') }));
    const report = await reembed.runReembed({ db: db(), profileId: VOYAGE, batchSize: 4 });
    assert.equal(report.status, 'failed');
    assert.equal(report.reason, 'embedding_profile_mismatch');
    assert.equal(await rowCount(VOYAGE), 4);
  });

  test('a provider that is not configured for the profile model is refused before any chunk is embedded', async () => {
    const fake = fakeEmbeddingProvider({ id: 'voyage', model: 'some-other-voyage-model' });
    useProvider(fake);
    const report = await reembed.runReembed({ db: db(), profileId: VOYAGE, batchSize: 4 });
    assert.equal(report.status, 'failed');
    assert.equal(report.reason, 'embedding_profile_mismatch');
    assert.equal(fake.calls, 0);
  });

  test('a vendor outage fails the run as provider_failed and a resume finishes it', async () => {
    let down = true;
    const fake = fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL, behave: (call) => (down && call === 2 ? 'throw' : 'ok') });
    useProvider(fake);
    const failed = await reembed.runReembed({ db: db(), profileId: VOYAGE, batchSize: 4 });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'provider_failed');
    assert.equal(await rowCount(VOYAGE), 4);
    down = false;
    const resumed = await reembed.runReembed({ db: db(), resumeRunId: failed.runId, batchSize: 4 });
    assert.equal(resumed.status, 'completed');
    assert.equal(await rowCount(VOYAGE), (await currentChunks()).length);
    assert.deepEqual(await maxWrites(), { chunks: (await currentChunks()).length, max: 1 });
  });

  test('the report gives the share of rows per serving host, the fallback share for Qwen3', async () => {
    useProvider(fakeEmbeddingProvider({ id: 'qwen3', model: QWEN_MODEL, hostFor: (call) => (call % 3 === 0 ? 'openrouter' : 'deepinfra') }));
    const report = await reembed.runReembed({ db: db(), profileId: QWEN_2048, batchSize: 4 });
    assert.equal(report.status, 'completed');
    const stored = await rows('SELECT embedding_host, count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1 GROUP BY embedding_host ORDER BY embedding_host', [QWEN_2048]);
    const total = (await currentChunks()).length;
    assert.deepEqual(
      [...report.hosts].sort((a, b) => a.host.localeCompare(b.host)).map((entry) => [entry.host, entry.chunks]),
      stored.map((row) => [row.embedding_host, row.n]),
    );
    assert.ok(report.hosts.some((entry) => entry.host === 'openrouter' && entry.chunks > 0), 'the fallback host served some rows');
    assert.ok(Math.abs(report.hosts.reduce((sum, entry) => sum + entry.share, 0) - 1) < 1e-9);
    const fallback = report.hosts.find((entry) => entry.host === 'openrouter');
    assert.ok(Math.abs((fallback?.share ?? 0) - Number(stored.find((row) => row.embedding_host === 'openrouter')?.n) / total) < 1e-9);
  });

  test('two tenants: a re-embed limited to tenant A never reads, sends or writes tenant B', async () => {
    await seedDocumentWith(query, A, 'iso-a', 3);
    await seedDocumentWith(query, B, 'iso-b', 3);
    const fake = fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL });
    useProvider(fake);
    const report = await reembed.runReembed({ db: db(), profileId: VOYAGE, tenantKey: A.key, batchSize: 3 });
    assert.equal(report.status, 'completed');
    assert.deepEqual(Object.keys(report.tenants), [A.key]);

    const forA = await currentChunks(A.key);
    assert.equal(await rowCount(VOYAGE), forA.length);
    const foreign = await rows(
      `SELECT count(*)::int AS n FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE e.profile_id = $1 AND c.tenant_key <> $2`,
      [VOYAGE, A.key],
    );
    assert.equal(foreign[0]?.n, 0, 'no vector exists for a chunk of another tenant');
    const others = (await rows(`SELECT content FROM document_chunks WHERE tenant_key <> $1`, [A.key])).map((row) => String(row.content));
    assert.ok(others.length > 0);
    assert.ok(
      fake.seen.every((text) => !others.some((content) => text.includes(content))),
      'no text of another tenant was sent to the provider',
    );
    assert.equal(fake.seen.length, forA.length);

    const toB = await db().rpc('rag_reembed_write_batch', {
      p_run_id: report.runId,
      p_rows: [{ chunk_id: String((await currentChunks(B.key))[0]?.id), vector: vector(2048, 1), host: 'fake' }],
      p_cursor: null,
      p_tokens: 0,
    });
    assert.equal(toB.error?.message === undefined, false, 'the run cannot be used to write a vector for tenant B');
  });

  test('a rollback deletes the run rows and is refused for the active profile', async () => {
    useProvider(fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL }));
    const report = await reembed.runReembed({ db: db(), profileId: VOYAGE, batchSize: 8 });
    const total = (await currentChunks()).length;
    assert.equal(await rowCount(VOYAGE), total);

    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [LEGACY]);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'active', activated_at = now() - interval '1 hour' WHERE id = $1", [VOYAGE]);
    await assert.rejects(reembed.rollbackReembedRun({ db: db(), runId: report.runId }), (error: unknown) => (error as { detail?: string }).detail === 'profile_is_active');
    assert.equal(await rowCount(VOYAGE), total, 'a refused rollback deletes nothing');

    await fixture.db.query("UPDATE embedding_profiles SET status = 'available', activated_at = NULL WHERE id = $1", [VOYAGE]);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'active', activated_at = now() - interval '2 hours' WHERE id = $1", [LEGACY]);
    const rolled = await reembed.rollbackReembedRun({ db: db(), runId: report.runId });
    assert.deepEqual(rolled, { rowsDeleted: total, profileStatus: 'available' });
    assert.equal(await rowCount(VOYAGE), 0);
    assert.equal((await runRow(report.runId)).status, 'rolled_back');
  });

  test('with RAG_EMBEDDING_PROFILES off ingestion, the active pointer and dual-write targets do not change while a run exists', async () => {
    useEnv({});
    useProvider(fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL }));
    const report = await reembed.runReembed({ db: db(), profileId: VOYAGE, batchSize: 8 });
    assert.equal(report.status, 'completed');
    assert.ok(report.warnings.includes('profiles_switch_off'), 'the operator is told that dual-write is inactive');
    assert.equal((await rows('SELECT status FROM embedding_profiles WHERE id = $1', [VOYAGE]))[0]?.status, 'backfilling');

    assert.equal((await activeModule.getActiveProfile()).id, LEGACY, 'queries still use the legacy profile');
    const targets = await targetsModule.resolveEmbeddingTargets({ findBackfillRuns: async () => [] });
    assert.deepEqual(targets.map((target) => target.profile.id), [LEGACY], 'ingestion still writes the legacy vector alone');
    const uploaded = await upload(TWO_TENANT_IDS.userB, 'switch-off-after-run');
    assert.equal(uploaded.status, 'ready');
    const vectors = await rows('SELECT count(*)::int AS n FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE c.document_id = $1', [uploaded.documentId]);
    assert.equal(vectors[0]?.n, 0, 'a document ingested with the switch off has no vector in the backfilling profile');
    const again = await reembed.runReembed({ db: db(), profileId: VOYAGE, batchSize: 8 });
    assert.equal(again.chunksEmbedded, Number(uploaded.chunkCount), 'a later run picks up exactly what the switch-off ingestion left');
  });

  test('image chunks are re-embedded from their stored caption and invoice chunks with their template header', async () => {
    const image = await seedDocumentWith(query, A, 'figure', 1, 'reembed-image.md', { chunkKind: 'image', sectionPath: ['Figures'] });
    const invoice = await seedDocumentWith(query, A, 'invoice-body', 1, 'reembed-invoice.md', {
      docType: 'invoice_receipt',
      profileId: 'invoice_receipt@1',
      sectionPath: ['Invoice INV-77', 'Lines'],
      fields: { doc_type: 'invoice_receipt', invoice_number: 'INV-77', supplier_name: 'Acme Srl', supplier_tax_id: 'IT00000000000' },
    });
    const fake = fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL });
    useProvider(fake);
    const report = await reembed.runReembed({ db: db(), profileId: VOYAGE, tenantKey: A.key, batchSize: 50 });
    assert.equal(report.status, 'completed');
    assert.ok(fake.seen.includes('Figures\n\nfigure chunk 0 about pallets and forklifts'), 'the caption is the stored content');
    assert.ok(
      fake.seen.includes('Invoice INV-77 > Lines\n\nInvoice INV-77 | Acme Srl | IT00000000000\ninvoice-body chunk 0 about pallets and forklifts'),
      'the document columns render the profile header',
    );
    assert.equal(
      Number((await rows('SELECT count(*)::int AS n FROM chunk_embeddings WHERE chunk_id = ANY($1::uuid[]) AND profile_id = $2', [[...image.chunkIds, ...invoice.chunkIds], VOYAGE]))[0]?.n),
      2,
    );
  });

  test('the job modules import no parser, sidecar, object-store or OpenAI client', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve('src/lib/rag/ingest/reembed');
    for (const file of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] as string);
      for (const spec of imports) {
        assert.ok(!/parsers|sidecar|object-store|llamaparse|stages|runner|openai/i.test(spec), `${file} imports ${spec}`);
      }
    }
    assert.ok(writerModule.createReembedWriter, 'the writer is the door to the database');
  });

  test('cost estimates use the registry price table and label non-OpenAI token counts as estimates', () => {
    const totals = { 'u:one': { chunks: 2, tokens: 1_000_000 }, 'u:two': { chunks: 1, tokens: 500_000 } };
    const openai = costModule.estimateReembedCost('openai', totals);
    assert.equal(openai.estimated, false);
    assert.equal(openai.note, null);
    assert.ok(Math.abs(openai.totals.usd - 0.03) < 1e-9);
    assert.deepEqual(
      openai.tenants.map((tenant) => tenant.tenantKey),
      ['u:one', 'u:two'],
    );
    const voyage = costModule.estimateReembedCost('voyage', totals);
    assert.equal(voyage.estimated, true);
    assert.match(voyage.note ?? '', /estimate/i);
    assert.ok(Math.abs(voyage.totals.usd - 0.18) < 1e-9);
    const qwen = costModule.estimateReembedCost('qwen3', totals);
    assert.ok(Math.abs(qwen.totals.usd - 0.015) < 1e-9);
    assert.equal(costModule.formatUsd(0.000012), '0.000012');
    assert.equal(costModule.formatUsd(1.5), '1.50');
    assert.throws(() => costModule.estimateReembedCost('unknown-vendor', totals));
  });

  test('the CLI accepts the documented flag combinations and refuses the contradictory ones', () => {
    const { parseReembedArgs } = cliModule;
    const uuid = '11111111-1111-4111-8111-111111111111';
    assert.deepEqual(parseReembedArgs(['--profile', VOYAGE]), { ok: true, mode: 'run', profileId: VOYAGE, tenantKey: null, batchSize: 128, deriveFrom: null, dryRun: false });
    assert.deepEqual(parseReembedArgs(['--profile', VOYAGE, '--dry-run', '--batch-size', '64', '--tenant', A.key]), {
      ok: true,
      mode: 'run',
      profileId: VOYAGE,
      tenantKey: A.key,
      batchSize: 64,
      deriveFrom: null,
      dryRun: true,
    });
    assert.deepEqual(parseReembedArgs(['--profile', QWEN_1024, '--derive-from', QWEN_2048]), {
      ok: true,
      mode: 'run',
      profileId: QWEN_1024,
      tenantKey: null,
      batchSize: 128,
      deriveFrom: QWEN_2048,
      dryRun: false,
    });
    assert.deepEqual(parseReembedArgs(['--resume', uuid]), { ok: true, mode: 'resume', runId: uuid, profileId: null, tenantKey: null, batchSize: 128 });
    assert.deepEqual(parseReembedArgs(['--rollback', uuid]), { ok: true, mode: 'rollback', runId: uuid });
    for (const bad of [
      [],
      ['--dry-run'],
      ['--profile'],
      ['--profile', VOYAGE, '--batch-size', '0'],
      ['--profile', VOYAGE, '--batch-size', '5000'],
      ['--profile', VOYAGE, '--batch-size', 'abc'],
      ['--profile', VOYAGE, '--tenant', 'somebody'],
      ['--profile', VOYAGE, '--bogus'],
      ['--resume', 'not-a-uuid'],
      ['--rollback', uuid, '--profile', VOYAGE],
      ['--rollback', uuid, '--resume', uuid],
      ['--resume', uuid, '--dry-run'],
      ['--resume', uuid, '--derive-from', QWEN_2048],
      ['--derive-from', QWEN_2048],
      ['--profile', QWEN_2048, '--derive-from', QWEN_2048],
    ]) {
      assert.equal(cliModule.parseReembedArgs(bad).ok, false, `${bad.join(' ') || '(no arguments)'} must be refused`);
    }
  });

  test('the CLI dry run prints counts and costs only, never a word of stored text, and exits 0', async () => {
    useProvider(fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL }));
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await cliModule.main(['--profile', VOYAGE, '--dry-run', '--batch-size', '6'], { out: (line) => lines.push(line), err: (line) => errors.push(line) });
    assert.equal(code, 0, errors.join('\n'));
    const output = lines.join('\n');
    assert.match(output, /dry run, nothing written/);
    assert.match(output, new RegExp(`${A.key}: chunks \\d+, tokens \\d+, estimated cost [0-9.]+ USD`));
    assert.match(output, /estimates/i);
    for (const chunk of await currentChunks()) {
      const content = String(chunk.content);
      assert.ok(!output.includes(content.slice(0, 25)), 'no stored text in the output');
    }
    assert.ok(!/sk-|service-role|apikey/i.test(output + errors.join('\n')), 'no key material in the output');
    assert.equal(await rowCount(VOYAGE), 0);
  });

  test('the CLI runs, resumes and rolls back, prints the run id and exits non-zero when a run fails', async () => {
    const { main } = cliModule;
    const fake = fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL, behave: (call) => (call === 2 ? 'wrong_dims' : 'ok') });
    useProvider(fake);
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    const failedCode = await main(['--profile', VOYAGE, '--batch-size', '4'], io);
    assert.equal(failedCode, 1);
    const runId = (await rows('SELECT id FROM embedding_backfill_runs'))[0]?.id as string;
    assert.ok(lines.join('\n').includes(runId), 'the run id is printed so it can be resumed');
    assert.match(lines.join('\n'), /embedding_profile_mismatch/);
    assert.match(lines.join('\n'), new RegExp(`--resume ${runId}`));

    useProvider(fakeEmbeddingProvider({ id: 'voyage', model: VOYAGE_MODEL }));
    lines.length = 0;
    assert.equal(await main(['--resume', runId, '--batch-size', '4'], io), 0, lines.join('\n'));
    assert.match(lines.join('\n'), /completed/);
    assert.equal(await rowCount(VOYAGE), (await currentChunks()).length);

    lines.length = 0;
    assert.equal(await main(['--rollback', runId], io), 0, lines.join('\n'));
    assert.match(lines.join('\n'), /deleted \d+ rows/);
    assert.equal(await rowCount(VOYAGE), 0);

    lines.length = 0;
    assert.equal(await main(['--profile', LEGACY], io), 1, 'the active profile is refused');
    assert.match(lines.join('\n'), /profile_is_active/);
  });
});
