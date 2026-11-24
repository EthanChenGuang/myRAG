import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { ListLegacyDocuments } from '@/lib/rag/ingest/backfill-hashes';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';

type Row = Record<string, unknown>;

const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const TENANT_O = `o:${TWO_TENANT_IDS.orgO}`;
const BASE_IDS = [TWO_TENANT_IDS.docA, TWO_TENANT_IDS.docB, TWO_TENANT_IDS.docO];

describe('legacy content-hash backfill (D-09)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let backfill: typeof import('@/lib/rag/ingest/backfill-hashes');
  let hashModule: typeof import('@/lib/rag/ingest/hash');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  const inserted: string[] = [];

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    backfill = await import('@/lib/rag/ingest/backfill-hashes');
    hashModule = await import('@/lib/rag/ingest/hash');
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(async () => {
    await fixture.db.query("UPDATE documents SET content_hash = NULL, metadata = metadata - 'content_hash_version' WHERE id = ANY($1::uuid[])", [BASE_IDS]);
  });

  afterEach(async () => {
    depsModule.resetIngestDepsForTests();
    mock.restoreAll();
    const ids = inserted.splice(0);
    if (ids.length > 0) await fixture.db.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [ids]);
  });

  const rows = async (sql: string, params: unknown[]): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const hashOf = async (id: string) => (await rows('SELECT content_hash, metadata FROM documents WHERE id = $1', [id]))[0] as Row;

  const insertLegacy = async (userId: string, content: string, presetHash: string | null = null): Promise<string> => {
    const id = randomUUID();
    await fixture.db.query('INSERT INTO documents (id, filename, content, metadata, user_id, content_hash) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [
      id,
      `legacy-${id.slice(0, 8)}.md`,
      content,
      JSON.stringify({ relpath: 'legacy/test' }),
      userId,
      presetHash,
    ]);
    inserted.push(id);
    return id;
  };

  const pgliteLister: ListLegacyDocuments = async ({ tenantKey, afterId, limit }) =>
    (
      await fixture.db.query<Row>(
        `SELECT id, tenant_key, content FROM documents
         WHERE content_hash IS NULL AND status = 'ready'
           AND ($1::text IS NULL OR tenant_key = $1)
           AND ($2::uuid IS NULL OR id > $2::uuid)
         ORDER BY id LIMIT $3`,
        [tenantKey, afterId, limit],
      )
    ).rows.map((row) => ({ id: String(row.id), tenantKey: String(row.tenant_key), content: String(row.content) }));

  const run = (options: { tenantKey?: string | null; dryRun?: boolean; batchSize?: number; db?: RpcClient } = {}) =>
    backfill.backfillContentHashes({
      db: (options.db ?? supabaseModule.getSupabaseAdmin()) as unknown as Parameters<typeof backfill.backfillContentHashes>[0]['db'],
      tenantKey: options.tenantKey ?? null,
      dryRun: options.dryRun ?? false,
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
      list: pgliteLister,
    });

  test('every legacy row gets the normalised content hash and the hash version, per tenant, without touching its other metadata', async () => {
    const report = await run();

    for (const id of BASE_IDS) {
      const content = String((await rows('SELECT content FROM documents WHERE id = $1', [id]))[0]?.content);
      const stored = await hashOf(id);
      assert.equal(stored.content_hash, hashModule.contentHash(content), 'the hash comes from the one TypeScript normaliser');
      const metadata = stored.metadata as Row;
      assert.equal(metadata.content_hash_version, hashModule.HASH_NORMALIZATION_VERSION);
      assert.equal(metadata.relpath, 'two-tenant/' + String((await rows('SELECT filename FROM documents WHERE id = $1', [id]))[0]?.filename), 'existing metadata is kept');
    }
    assert.deepEqual(report.tenants[TENANT_A], { scanned: 1, hashed: 1, skippedEmpty: 0, failed: 0 });
    assert.deepEqual(report.tenants[TENANT_B], { scanned: 1, hashed: 1, skippedEmpty: 0, failed: 0 });
    assert.deepEqual(report.tenants[TENANT_O], { scanned: 1, hashed: 1, skippedEmpty: 0, failed: 0 });
    assert.deepEqual(report.totals, { scanned: 3, hashed: 3, skippedEmpty: 0, failed: 0 });
    assert.equal(report.dryRun, false);

    const again = await run();
    assert.deepEqual(again.totals, { scanned: 0, hashed: 0, skippedEmpty: 0, failed: 0 }, 'a second run finds nothing to do');
  });

  test('--dry-run reports the counts per tenant and writes nothing', async () => {
    const calls: string[] = [];
    const real = supabaseModule.getSupabaseAdmin() as unknown as RpcClient;
    const db: RpcClient = {
      rpc(fn, args) {
        calls.push(fn);
        return real.rpc(fn, args);
      },
    };
    const report = await run({ dryRun: true, db });

    assert.equal(report.dryRun, true);
    assert.deepEqual(report.tenants[TENANT_A], { scanned: 1, hashed: 1, skippedEmpty: 0, failed: 0 });
    assert.deepEqual(report.totals, { scanned: 3, hashed: 3, skippedEmpty: 0, failed: 0 });
    assert.deepEqual(calls, [], 'no RPC was called');
    const still = await rows('SELECT count(*)::int AS n FROM documents WHERE id = ANY($1::uuid[]) AND content_hash IS NULL', [BASE_IDS]);
    assert.equal(still[0]?.n, 3, 'every row still has no hash');
  });

  test('--tenant limits the run to one tenant key', async () => {
    const report = await run({ tenantKey: TENANT_A });

    assert.deepEqual(Object.keys(report.tenants), [TENANT_A]);
    assert.ok((await hashOf(TWO_TENANT_IDS.docA)).content_hash, 'tenant A was hashed');
    assert.equal((await hashOf(TWO_TENANT_IDS.docB)).content_hash, null, 'tenant B was not touched');
    assert.equal((await hashOf(TWO_TENANT_IDS.docO)).content_hash, null, 'the organization tenant was not touched');
  });

  test('rows that already have a content hash are not touched, and blank content is never hashed', async () => {
    const preset = await insertLegacy(TWO_TENANT_IDS.userA, 'Content of a row that already carries a hash.', 'preset-hash-from-another-rule');
    const blank = await insertLegacy(TWO_TENANT_IDS.userA, '  \r\n \t ');
    const report = await run();

    assert.equal((await hashOf(preset)).content_hash, 'preset-hash-from-another-rule', 'a hash that exists is never overwritten');
    assert.equal(((await hashOf(preset)).metadata as Row).content_hash_version, undefined, 'and its metadata is left alone');
    assert.equal((await hashOf(blank)).content_hash, null, 'a blank document gets no hash, so it cannot become the duplicate of every other blank one');
    assert.deepEqual(report.tenants[TENANT_A], { scanned: 2, hashed: 1, skippedEmpty: 1, failed: 0 });
  });

  test('paging with a batch size of one still reaches every row', async () => {
    const extra = [
      await insertLegacy(TWO_TENANT_IDS.userA, 'First extra legacy document about quartz harbours.'),
      await insertLegacy(TWO_TENANT_IDS.userB, 'Second extra legacy document about amber lanterns.'),
    ];
    const report = await run({ batchSize: 1 });

    assert.equal(report.totals.hashed, 5);
    for (const id of [...BASE_IDS, ...extra]) assert.ok((await hashOf(id)).content_hash, `row ${id} was hashed`);
  });

  test('after the backfill, the exact text of a legacy document uploaded to the same tenant is a duplicate of it, and another tenant is not', async () => {
    const text = 'The legacy tide ledger lists every berth assignment for the winter season.';
    const legacyId = await insertLegacy(TWO_TENANT_IDS.userA, text);
    await run();

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
    const upload = async (userId: string) =>
      ingestModule.ingest({
        scope: await scopeOf(userId),
        source: 'config_upload',
        sourceKey: 'root/tide-ledger.md',
        text,
        filename: 'tide-ledger.md',
        mimeType: 'text/markdown',
        signal: new AbortController().signal,
      });

    const sameTenant = await upload(TWO_TENANT_IDS.userA);
    assert.equal(sameTenant.status, 'skipped_duplicate');
    assert.equal(sameTenant.duplicateOf, legacyId);
    assert.equal(sameTenant.chunkCount, 0);

    const otherTenant = await upload(TWO_TENANT_IDS.userB);
    assert.equal(otherTenant.status, 'ready', 'a hash of tenant A never deduplicates tenant B');
    assert.notEqual(otherTenant.documentId, legacyId);
  });

  test('the command line options are parsed and validated', () => {
    assert.deepEqual(backfill.parseBackfillArgs([]), { ok: true, tenantKey: null, dryRun: false, batchSize: 200 });
    assert.deepEqual(backfill.parseBackfillArgs(['--dry-run', '--tenant', TENANT_A, '--batch-size', '50']), {
      ok: true,
      tenantKey: TENANT_A,
      dryRun: true,
      batchSize: 50,
    });
    assert.deepEqual(backfill.parseBackfillArgs(['--tenant', 's:default']), { ok: true, tenantKey: 's:default', dryRun: false, batchSize: 200 });
    for (const bad of [['--tenant'], ['--tenant', 'someone'], ['--tenant', `x:${TWO_TENANT_IDS.userA}`], ['--batch-size', '0'], ['--batch-size', '5000'], ['--batch-size', 'many'], ['--unknown']]) {
      const parsed = backfill.parseBackfillArgs(bad);
      assert.equal(parsed.ok, false, `rejects ${bad.join(' ')}`);
    }
  });

  test('the service-role reader asks for ready rows without a hash, after the cursor, in id order, within the tenant filter', async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const name of ['select', 'is', 'eq', 'gt', 'order', 'limit']) {
      builder[name] = (...args: unknown[]) => {
        calls.push([name, ...args]);
        return builder;
      };
    }
    builder.abortSignal = (signal: AbortSignal) => {
      calls.push(['abortSignal', signal.aborted]);
      return Promise.resolve({ data: [{ id: 'row-1', tenant_key: TENANT_A, content: 'body' }], error: null });
    };
    const admin = { from: (table: string) => (calls.push(['from', table]), builder) };
    const list = backfill.createSupabaseLister(admin as unknown as Parameters<typeof backfill.createSupabaseLister>[0]);

    const result = await list({ tenantKey: TENANT_A, afterId: TWO_TENANT_IDS.docA, limit: 7, signal: new AbortController().signal });
    assert.deepEqual(result, [{ id: 'row-1', tenantKey: TENANT_A, content: 'body' }]);
    assert.deepEqual(calls.map((call) => call[0]), ['from', 'select', 'is', 'eq', 'eq', 'gt', 'order', 'limit', 'abortSignal']);
    assert.deepEqual(calls[0], ['from', 'documents']);
    assert.deepEqual(calls[2], ['is', 'content_hash', null]);
    assert.deepEqual(calls[3], ['eq', 'status', 'ready']);
    assert.deepEqual(calls[4], ['eq', 'tenant_key', TENANT_A]);
    assert.deepEqual(calls[5], ['gt', 'id', TWO_TENANT_IDS.docA]);
    assert.deepEqual(calls[6], ['order', 'id', { ascending: true }]);
    assert.deepEqual(calls[7], ['limit', 7]);

    const failing = { from: () => ({ ...builder, abortSignal: () => Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement for "secret phrase"' } }) }) };
    const failingList = backfill.createSupabaseLister(failing as unknown as Parameters<typeof backfill.createSupabaseLister>[0]);
    const thrown = await failingList({ tenantKey: null, afterId: null, limit: 5, signal: new AbortController().signal }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(thrown instanceof Error);
    assert.ok(thrown.message.includes('57014'));
    assert.ok(!thrown.message.includes('secret phrase'), 'the database message is not echoed');
  });
});
