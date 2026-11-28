import { after, afterEach, before, describe, mock, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { createPgliteAdmin } from '../helpers/pglite-admin';
import { createFakeConnector, type FakeConnector } from '../helpers/fake-connector';
import type { TenantScope } from '@/lib/rag';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';

/**
 * EVAL-31 deletion canary (Phase 6.3, D-27): a synthetic document deleted at a fake connector's source leaves no
 * retrieval candidate, context text, cache entry, citation quote or table row after the next sync, in soft and purge
 * mode; the safety behaviours fire (age alert D-10/D-39, mass-delete pause D-09, complete-listing rule D-48, daily
 * purge cap D-49). PGlite fixture database, multi-tenant, synthetic neutral content only. Purge destroys data by design.
 */

type Row = Record<string, unknown>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../fixtures/rag-e2e/deletion-canary');
const CANARY_A = fs.readFileSync(path.join(FIXTURES, 'canary-a.md'), 'utf8');
const CANARY_B = fs.readFileSync(path.join(FIXTURES, 'canary-b.md'), 'utf8');
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };
const OWNER: string = TWO_TENANT_IDS.userA;
const TENANT = `u:${OWNER}`;
const CACHE_PROFILE = 'canary-cache-profile';
const CACHE_EMBEDDING = '[1,0,0,0]';
const SYNC_TARGET = 'qdrant';
const DRAIN_PROFILE = 'canary-drain-profile';

type Mode = 'soft' | 'purge' | null;

interface Ingested {
  fileId: string;
  documentId: string;
  lineageId: string;
  marker: string;
  query: string;
  quote: string;
  chunkId: string;
}

describe('deletion canary', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let objectStore: typeof import('@/lib/rag/ingest/object-store');
  let publicStore: typeof import('@/lib/rag/ingest/images/public-store');
  let fakeStore: typeof import('../helpers/fake-object-store');
  let fakePublic: typeof import('../helpers/fake-public-image-store');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let deletions: typeof import('@/lib/nango/source-deletions');
  let reconcile: typeof import('@/lib/nango/reconcile');
  let syncManager: typeof import('@/lib/nango/sync-manager');
  let sourceSyncAdmin: typeof import('@/lib/nango/source-sync-admin');
  let answers: typeof import('@/lib/answers/store');
  let contracts: typeof import('@/lib/rag-eval/contracts.generated');
  let scope: TenantScope;
  let serviceUrl = '';
  let serviceKey = '';
  let counter = 0;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    const env = fixtureProcessEnv(edge.url);
    Object.assign(process.env, env);
    serviceUrl = edge.url;
    serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    objectStore = await import('@/lib/rag/ingest/object-store');
    publicStore = await import('@/lib/rag/ingest/images/public-store');
    fakeStore = await import('../helpers/fake-object-store');
    fakePublic = await import('../helpers/fake-public-image-store');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    deletions = await import('@/lib/nango/source-deletions');
    reconcile = await import('@/lib/nango/reconcile');
    syncManager = await import('@/lib/nango/sync-manager');
    sourceSyncAdmin = await import('@/lib/nango/source-sync-admin');
    answers = await import('@/lib/answers/store');
    contracts = await import('@/lib/rag-eval/contracts.generated');
    await fixture.db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [OWNER]);
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: OWNER }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    scope = resolved.scope;
    assert.equal(rag.scopeKey(scope), TENANT, 'connector documents live in the owner personal workspace');
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  afterEach(async () => {
    objectStore.resetObjectStoreForTests();
    publicStore.resetPublicImageStoreForTests();
    depsModule.resetIngestDepsForTests();
    mock.restoreAll();
    await fixture.db.exec('UPDATE public.rag_vector_sync_targets SET enabled = false');
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await rows(sql, params))[0]?.n ?? 0);
  const admin = () => createPgliteAdmin(fixture.db) as never;
  const hex = (bytes = 4) => crypto.randomBytes(bytes).toString('hex');

  function installStores() {
    const objects = fakeStore.createFakeObjectStore();
    objectStore.setObjectStoreForTests(objects);
    fakePublic.installFakePublicImageStore();
    return objects;
  }

  async function insertConnection(mode: Mode, provider = `provider-${hex()}`) {
    const id = crypto.randomUUID();
    const connectionId = `conn-canary-${hex()}`;
    await fixture.db.query(
      "INSERT INTO nango_connections (id, user_id, connection_id, provider, status, deletion_mode, connected_at) VALUES ($1, $2, $3, $4, 'connected', $5, now())",
      [id, OWNER, connectionId, provider, mode],
    );
    return { id, connection_id: connectionId, user_id: OWNER, provider, deletion_mode: mode };
  }

  /** Ingests one fixture text as a connector file of the connection and writes its sync record. */
  async function ingestFile(connection: { connection_id: string; provider: string }, base: string, label: string): Promise<Ingested> {
    counter += 1;
    const fileId = `file-${label}-${hex()}`;
    const marker = `zqcanary${counter}${hex(3)}`;
    const text = `${base}\nRun marker ${marker} for the ${label} sample.\n`;
    const ready = await ingestModule.ingest({
      scope,
      source: 'nango',
      sourceKey: fileId,
      text,
      filename: `${fileId}.md`,
      mimeType: 'text/markdown',
      options: { origin: { sourceProvider: connection.provider, sourceFileId: fileId, sourceConnectionId: connection.connection_id } },
      signal: new AbortController().signal,
    });
    assert.equal(ready.status, 'ready', `ingest of ${label} is ready`);
    assert.ok(ready.documentId);
    const documentId = String(ready.documentId);
    const lineage = await rows('SELECT lineage_id FROM documents WHERE id = $1', [documentId]);
    const chunk = (await rows('SELECT id, content FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index LIMIT 1', [documentId]))[0];
    assert.ok(chunk, `${label} has a chunk`);
    await fixture.db.query(
      "INSERT INTO nango_sync_records (user_id, connection_id, provider, file_id, file_name, document_id, status) VALUES ($1, $2, $3, $4, $5, $6, 'completed')",
      [OWNER, connection.connection_id, connection.provider, fileId, `${fileId}.md`, documentId],
    );
    return {
      fileId,
      documentId,
      lineageId: String(lineage[0]?.lineage_id ?? documentId),
      marker,
      query: text,
      quote: String(chunk.content).slice(0, 160),
      chunkId: String(chunk.id),
    };
  }

  const versionIds = async (doc: Ingested): Promise<string[]> =>
    (await rows('SELECT id FROM documents WHERE lineage_id = $1 ORDER BY version', [doc.lineageId])).map((row) => String(row.id));

  const retrieve = (query: string) => rag.runRetrieval({ scope, query, profile: 'eval', options: OPTIONS, signal: new AbortController().signal });

  async function retrievable(doc: Ingested, ids?: string[]): Promise<boolean> {
    const docIds = ids ?? (await versionIds(doc));
    const result = await retrieve(doc.query);
    return result.candidates.some((candidate) => docIds.includes(candidate.document_id));
  }

  function cacheKeyHash(doc: Ingested): string {
    return crypto.createHash('sha256').update(`canary-cache-${doc.marker}`).digest('hex');
  }

  async function storeCache(doc: Ingested): Promise<string> {
    const stored = await rows(
      'SELECT public.rag_cache_store($1, $2, $3, $4::halfvec, $5, $6::jsonb, $7::jsonb, false, 3600) AS id',
      [
        TENANT,
        cacheKeyHash(doc),
        CACHE_PROFILE,
        CACHE_EMBEDDING,
        'masked canary query',
        JSON.stringify({ text: `An answer that quotes ${doc.marker}.` }),
        JSON.stringify([{ document_id: doc.documentId, version: 1 }]),
      ],
    );
    return String(stored[0]?.id);
  }

  async function cacheServes(doc: Ingested): Promise<boolean> {
    const hit = (await rows('SELECT * FROM public.rag_cache_check($1, $2, $3, $4::halfvec, 0.05)', [TENANT, cacheKeyHash(doc), CACHE_PROFILE, CACHE_EMBEDDING]))[0];
    return hit?.hit === true;
  }

  function citationOf(doc: Ingested) {
    return {
      n: 1,
      alias: 'S1',
      chunkIds: [doc.chunkId],
      documentId: doc.documentId,
      documentName: `${doc.fileId}.md`,
      documentVersion: 1,
      page: null,
      sectionPath: null,
      quote: doc.quote,
      quoteHash: crypto.createHash('sha256').update(doc.quote).digest('hex'),
      strategy: 'chunk-alias' as const,
    };
  }

  /** An answer record and a saved chat citing the document, written through the Phase 5 store. */
  async function answerFrom(doc: Ingested): Promise<{ answerId: string; chatId: string }> {
    const chatId = crypto.randomUUID();
    const answerId = crypto.randomUUID();
    const citation = citationOf(doc);
    const messages = [
      { id: 'm-user', role: 'user', content: 'A synthetic question about the sample.' },
      { id: 'm-assistant', role: 'assistant', content: [{ type: 'text', text: 'A synthetic answer [S1].' }], metadata: { answerId, citations: [citation] } },
    ];
    await fixture.db.query("INSERT INTO chats (id, user_id, title, messages) VALUES ($1, $2, 'Canary chat', $3::jsonb)", [chatId, OWNER, JSON.stringify(messages)]);
    const inserted = await answers.insertAnswerRecord(admin(), {
      id: answerId,
      scope,
      userId: OWNER,
      chatId,
      traceId: `trace-${hex()}`,
      modelId: 'fixture/model',
      citationStrategy: 'chunk-alias',
      ragMode: 'strict',
      answerLanguage: 'en',
      invalidCitations: 0,
      citations: [citation],
      groundedness: { status: 'not_checked', label: 'not_checked', reason: 'disabled' } as never,
    });
    assert.equal(inserted.inserted, true, 'the answer record is stored');
    return { answerId, chatId };
  }

  async function tableRowsLeft(t: TestContext, ids: string[]): Promise<void> {
    const exists = (await rows("SELECT to_regclass('public.rag_table_rows') IS NOT NULL AS ok"))[0]?.ok === true;
    if (!exists) {
      t.diagnostic('RET-12 table rows: skipped (rag_table_rows not on trunk)');
      return;
    }
    assert.equal(await count('SELECT count(*) AS n FROM public.rag_table_rows WHERE document_id = ANY ($1::uuid[])', [ids]), 0, 'no table row of the deleted document');
    t.diagnostic('RET-12 table rows: ran');
  }

  /** The shared "no trace left" assertions of D-27 for the deleted document, and the kept one still answers. */
  async function assertGone(t: TestContext, gone: Ingested, ids: string[], kept: Ingested): Promise<void> {
    const result = await retrieve(gone.query);
    assert.ok(!result.candidates.some((candidate) => ids.includes(candidate.document_id)), 'no retrieval candidate of the deleted document');
    assert.ok(!result.context.includes(gone.marker), 'the assembled context holds none of its text');
    for (const block of result.blocks ?? []) assert.ok(!JSON.stringify(block).includes(gone.marker), 'no context block of it');
    assert.equal(
      await count("SELECT count(*) AS n FROM rag_semantic_cache c, jsonb_array_elements(c.source_versions) s WHERE (s ->> 'document_id')::uuid = ANY ($1::uuid[])", [ids]),
      0,
      'no cache entry references its versions',
    );
    assert.equal(await cacheServes(gone), false, 'the cached query is served nothing');
    assert.equal(await retrievable(kept), true, 'the other document is still retrievable');
    await tableRowsLeft(t, ids);
  }

  for (const mode of ['soft', 'purge'] as const) {
    test(`a document deleted at the source leaves no trace after the next sync (${mode})`, async (t) => {
      const objects = installStores();
      const connection = await insertConnection(mode);
      const a = await ingestFile(connection, CANARY_A, 'alpha');
      const b = await ingestFile(connection, CANARY_B, 'bravo');
      for (const key of objects.keys()) assert.ok(key.length > 0);
      assert.equal(await retrievable(a), true, 'canary-a is retrievable before the deletion');
      assert.equal(await retrievable(b), true, 'canary-b is retrievable before the deletion');
      await storeCache(a);
      assert.equal(await cacheServes(a), true, 'the cache serves the query before the deletion');
      const { answerId, chatId } = await answerFrom(a);
      const ids = await versionIds(a);

      const source: FakeConnector = createFakeConnector({
        files: [a.fileId, b.fileId],
        pages: [[{ fileId: a.fileId, deleted: true, kind: 'file' }]],
      });
      source.setFiles([b.fileId]);

      let points: { store: import('@/lib/rag/sync/stores/fake').FakeVectorStore; seeded: number } | null = null;
      if (mode === 'soft') {
        const page = await source.read({ connectionId: connection.connection_id, cursor: null, deadline: Date.now() + 60_000, signal: new AbortController().signal });
        const removedIds = page.changes.filter((change) => change.deleted).map((change) => change.fileId);
        const outcome = await deletions.applySourceDeletions(connection, removedIds, 'change_feed', { admin: admin() });
        assert.deepEqual(outcome, { removed: 1, failed: 0, deferred: 0 });
      } else {
        await fixture.db.exec('DELETE FROM public.vector_sync_outbox; DELETE FROM public.vector_sync_purges;');
        await fixture.db.query('UPDATE public.rag_vector_sync_targets SET enabled = (target = $1)', [SYNC_TARGET]);
        points = await seedExternalPoints(ids);
        const result = await reconcile.runSourceReconcile({
          deadlineMs: 120_000,
          connectionId: connection.id,
          deps: { admin: admin(), listFiles: async () => source.list() },
        });
        assert.equal(result.processed, 1);
        assert.equal(result.removed, 1, 'the full listing removes canary-a');
        assert.equal(result.paused, 0);
        assert.equal(result.failed, 0);
      }

      await assertGone(t, a, ids, b);
      assert.equal(await count('SELECT count(*) AS n FROM nango_sync_records WHERE file_id = $1', [a.fileId]), 0, 'the sync record is gone');
      assert.equal(await count('SELECT count(*) AS n FROM nango_sync_records WHERE file_id = $1', [b.fileId]), 1, 'canary-b keeps its sync record');

      if (mode === 'soft') {
        const versions = await rows('SELECT status, is_current FROM documents WHERE lineage_id = $1', [a.lineageId]);
        assert.ok(versions.length > 0, 'soft keeps the versions');
        assert.ok(versions.every((row) => row.status === 'deleted' && row.is_current === false), 'every version is deleted');
        return;
      }

      assert.equal(await count('SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [a.lineageId]), 0, 'no version remains');
      const verify = await rows('SELECT store, remaining, state FROM public.rag_purge_verify($1, $2::uuid)', [TENANT, a.lineageId]);
      for (const entry of verify) {
        if (String(entry.store).startsWith('external:')) continue;
        assert.equal(Number(entry.remaining), 0, `store ${entry.store} still holds ${entry.remaining}`);
      }
      const record = (await rows('SELECT citations FROM rag_answer_records WHERE id = $1', [answerId]))[0];
      const citation = ((record?.citations as Row[]) ?? [])[0] ?? {};
      assert.equal(citation.withdrawn, true, 'the past citation is a withdrawn marker');
      assert.ok(contracts.CitationRecordSchema.safeParse(citation).success, 'the withdrawn marker passes CitationRecordSchema');
      assert.ok(!JSON.stringify(citation).includes(a.marker), 'the citation holds no quote of the document');
      const chat = (await rows('SELECT messages FROM chats WHERE id = $1', [chatId]))[0];
      assert.ok(!JSON.stringify(chat?.messages).includes(a.marker), 'the chat scrub leaves no quote');
      const audit = await rows('SELECT actor_kind, actor_id, reason_code FROM rag_purge_audit WHERE lineage_id = $1', [a.lineageId]);
      assert.deepEqual(audit, [{ actor_kind: 'source_sync', actor_id: connection.id, reason_code: 'source_deleted' }]);

      await externalTarget(t, a, ids, points);
    });
  }

  /** Points of the purged versions in a fake external store (Phase 7), so a drain has something to delete. */
  async function seedExternalPoints(ids: string[]) {
    let fake: typeof import('@/lib/rag/sync/stores/fake');
    try {
      fake = await import('@/lib/rag/sync/stores/fake');
    } catch {
      return null;
    }
    const store = fake.createFakeVectorStore(SYNC_TARGET);
    await store.ensureCollection({ profileId: DRAIN_PROFILE, dims: 4 });
    let seeded = 0;
    for (const documentId of ids) {
      await store.upsert(DRAIN_PROFILE, TENANT, [
        {
          id: crypto.randomUUID(),
          vector: [1, 0, 0, 0],
          payload: {
            tenant_key: TENANT,
            document_id: documentId,
            doc_type: 'general',
            doc_date: null,
            language: 'en',
            source: 'nango',
            chunking_profile_id: null,
            parent_id: null,
            lexical_text: 'neutral sample words',
            content_hash: 'h',
            lexical_version: 1,
            access_groups: ['all'],
          },
        },
      ]);
      seeded += 1;
    }
    return { store, seeded };
  }

  /** D-15, D-37, D-45: the purge outbox and ledger for an enabled sync target, then one drain slice when Phase 7 has it. */
  async function externalTarget(
    t: TestContext,
    doc: Ingested,
    ids: string[],
    points: { store: import('@/lib/rag/sync/stores/fake').FakeVectorStore; seeded: number } | null,
  ): Promise<void> {
    const has0740 = (await rows("SELECT to_regprocedure('public.rag_vector_sync_enqueue_purge(text,uuid,uuid[],text,text)') IS NOT NULL AS ok"))[0]?.ok === true;
    if (!has0740) {
      t.diagnostic('Phase 7 purge seam (0740): absent; checking pending document rows');
      for (const id of ids) {
        assert.equal(
          await count("SELECT count(*) AS n FROM vector_sync_outbox WHERE target = $1 AND entity = 'document' AND entity_id = $2 AND status = 'pending'", [SYNC_TARGET, id]),
          1,
          `a pending document row for version ${id}`,
        );
      }
      return;
    }
    t.diagnostic('Phase 7 purge seam (0740): ran');
    const purgeRows = await rows("SELECT entity_id FROM vector_sync_outbox WHERE target = $1 AND entity = 'purge'", [SYNC_TARGET]);
    assert.equal(purgeRows.length, 1, 'one purge outbox row');
    const ledger = await rows('SELECT * FROM vector_sync_purges WHERE id = $1', [purgeRows[0]?.entity_id]);
    assert.equal(ledger.length, 1, 'one purge record');
    const named = JSON.stringify(ledger[0]);
    for (const id of ids) assert.ok(named.includes(id), `the purge record names version ${id}`);
    const before = await rows('SELECT store, remaining, state FROM public.rag_purge_verify($1, $2::uuid)', [TENANT, doc.lineageId]);
    const pending = before.find((entry) => entry.store === `external:${SYNC_TARGET}`);
    assert.equal(pending?.state, 'pending', 'verify reports the target pending until a drain completes it');

    let drain: typeof import('@/lib/rag/sync/drain');
    try {
      drain = await import('@/lib/rag/sync/drain');
    } catch {
      t.diagnostic('Phase 7 drain: skipped (drainSlice not on trunk)');
      return;
    }
    if (!points) {
      t.diagnostic('Phase 7 drain: skipped (fake vector store not on trunk)');
      return;
    }
    t.diagnostic('Phase 7 drain: ran');
    const rpc = createClient(serviceUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as RpcClient;
    for (let slice = 0; slice < 3; slice += 1) {
      const report = await drain.drainSlice({ store: points.store, rpc, budgetMs: 30_000, batch: 100, sink: () => undefined, trace: false });
      assert.equal(report.failed, 0, 'the drain slice has no failure');
      const open = await count("SELECT count(*) AS n FROM vector_sync_outbox WHERE target = $1 AND entity = 'purge' AND status <> 'done'", [SYNC_TARGET]);
      if (open === 0) break;
    }
    assert.equal(points.store.points(DRAIN_PROFILE, TENANT).filter((point) => ids.includes(point.payload.document_id)).length, 0, 'no point of the document');
    const afterDrain = await rows('SELECT store, remaining, state FROM public.rag_purge_verify($1, $2::uuid)', [TENANT, doc.lineageId]);
    assert.equal(afterDrain.find((entry) => entry.store === `external:${SYNC_TARGET}`)?.state, 'done', 'verify reports the target done');
  }

  test('a connector whose listing keeps failing raises the age alert once past the limit and removes nothing (D-10, D-39)', async () => {
    installStores();
    const connection = await insertConnection('soft');
    const a = await ingestFile(connection, CANARY_A, 'alpha');
    const source = createFakeConnector({ files: [a.fileId] });
    source.failListing();
    const run = () => reconcile.runSourceReconcile({ deadlineMs: 60_000, connectionId: connection.id, deps: { admin: admin(), listFiles: async () => source.list() } });

    const first = await run();
    assert.equal(first.failed, 1, 'the first scheduled run records the failed listing');
    assert.equal(first.overdue, 0, 'no age alert inside the limit');
    const status = async () => String((await rows('SELECT last_reconcile_status FROM nango_connections WHERE id = $1', [connection.id]))[0]?.last_reconcile_status);
    assert.equal(await status(), 'failed');

    const maxAge = Number(process.env.RAG_SOURCE_RECONCILE_MAX_AGE_DAYS || 0) || 7;
    await fixture.db.query("UPDATE nango_connections SET connected_at = now() - make_interval(days => $2) WHERE id = $1", [connection.id, maxAge + 3]);
    const second = await run();
    assert.equal(second.failed, 1);
    assert.equal(second.overdue, 1, 'the next run raises the age alert');
    assert.equal(second.removed, 0);
    assert.equal(await status(), 'overdue', 'the alert is recorded on the connection');
    const runs = await rows("SELECT status FROM rag_source_reconcile_runs WHERE connection_id = $1::uuid AND origin = 'scheduled' ORDER BY created_at", [connection.id]);
    assert.deepEqual(runs.map((row) => row.status), ['failed', 'failed']);
    assert.equal(await count('SELECT count(*) AS n FROM nango_sync_records WHERE file_id = $1', [a.fileId]), 1, 'nothing removed');
    assert.equal(await retrievable(a), true, 'the document is still retrievable');
  });

  test('a listing that would remove most documents pauses: nothing is removed and one run awaits confirmation (D-09)', async () => {
    installStores();
    const connection = await insertConnection('soft');
    const docs: Ingested[] = [];
    for (let index = 0; index < 10; index += 1) docs.push(await ingestFile(connection, index % 2 === 0 ? CANARY_A : CANARY_B, `bulk${index}`));
    const source = createFakeConnector({ files: docs.map((doc) => doc.fileId) });
    source.setFiles(docs.slice(0, 2).map((doc) => doc.fileId));

    const result = await reconcile.runSourceReconcile({ deadlineMs: 120_000, connectionId: connection.id, deps: { admin: admin(), listFiles: async () => source.list() } });
    assert.equal(result.removed, 0, 'nothing is removed');
    assert.equal(result.paused, 1);
    const runs = await rows("SELECT status, candidate_file_ids FROM rag_source_reconcile_runs WHERE connection_id = $1::uuid AND status = 'awaiting_confirmation'", [connection.id]);
    assert.equal(runs.length, 1, 'one run awaits confirmation');
    assert.deepEqual([...(runs[0]?.candidate_file_ids as string[])].sort(), docs.slice(2).map((doc) => doc.fileId).sort(), 'the 8 missing files are the candidates');
    assert.equal(String((await rows('SELECT last_reconcile_status FROM nango_connections WHERE id = $1', [connection.id]))[0]?.last_reconcile_status), 'paused');
    assert.equal(await count('SELECT count(*) AS n FROM nango_sync_records WHERE connection_id = $1', [connection.connection_id]), 10);
    for (const doc of docs) assert.equal(await retrievable(doc), true, `${doc.fileId} is still retrievable`);
  });

  test('a generic-path connector removes nothing from an incomplete listing in the default mode, then removes after a complete one (D-48)', async () => {
    installStores();
    const connection = await insertConnection(null, 'dropbox');
    const a = await ingestFile(connection, CANARY_A, 'alpha');
    const b = await ingestFile(connection, CANARY_B, 'bravo');
    const ids = await versionIds(a);
    const source = createFakeConnector({ files: [b.fileId, a.fileId] });
    source.cutListing(1);

    const cut = await source.list();
    assert.equal(cut.complete, false);
    assert.ok(!cut.fileIds.includes(a.fileId), 'the cut listing lacks canary-a');
    const removedCut = await syncManager.removeOrphans(connection, cut.fileIds, 'sync', { complete: cut.complete, admin: admin() });
    assert.equal(removedCut, 0, 'the cut listing removes nothing');
    assert.equal(await retrievable(a), true, 'canary-a is still retrievable');
    assert.equal(await count('SELECT count(*) AS n FROM nango_sync_records WHERE file_id = $1', [a.fileId]), 1, 'its sync record stays');
    const runs = await rows("SELECT origin, status FROM rag_source_reconcile_runs WHERE connection_id = $1::uuid", [connection.id]);
    assert.deepEqual(runs, [{ origin: 'sync', status: 'incomplete' }], 'one incomplete run is recorded');

    source.reset();
    source.setFiles([b.fileId]);
    const complete = await source.list();
    assert.equal(complete.complete, true);
    const removed = await syncManager.removeOrphans(connection, complete.fileIds, 'sync', { complete: complete.complete, admin: admin() });
    assert.equal(removed, 1, 'the complete listing removes canary-a');
    const result = await retrieve(a.query);
    assert.ok(!result.candidates.some((candidate) => ids.includes(candidate.document_id)), 'no retrieval candidate of canary-a');
    assert.ok(!result.context.includes(a.marker), 'no context text of canary-a');
    assert.equal(await retrievable(b), true, 'canary-b is still retrievable');
  });

  test('the daily purge cap purges exactly the cap and holds the rest for an admin (D-49)', async (t) => {
    // env.ts snapshots process.env at import, so the case sets both and restores both.
    const loaded = (await import('@/lib/env')).env as unknown as Record<string, string | undefined>;
    const previous = { process: process.env.RAG_SOURCE_PURGE_DAILY_CAP, loaded: loaded.RAG_SOURCE_PURGE_DAILY_CAP };
    process.env.RAG_SOURCE_PURGE_DAILY_CAP = '1';
    loaded.RAG_SOURCE_PURGE_DAILY_CAP = '1';
    t.after(() => {
      if (previous.process === undefined) delete process.env.RAG_SOURCE_PURGE_DAILY_CAP;
      else process.env.RAG_SOURCE_PURGE_DAILY_CAP = previous.process;
      loaded.RAG_SOURCE_PURGE_DAILY_CAP = previous.loaded;
    });
    installStores();
    const connection = await insertConnection('purge');
    const a = await ingestFile(connection, CANARY_A, 'alpha');
    const b = await ingestFile(connection, CANARY_B, 'bravo');
    const idsA = await versionIds(a);
    const idsB = await versionIds(b);
    await storeCache(a);
    await storeCache(b);
    const answerA = await answerFrom(a);

    const source = createFakeConnector({
      files: [a.fileId, b.fileId],
      pages: [
        [
          { fileId: a.fileId, deleted: true, kind: 'file' },
          { fileId: b.fileId, deleted: true, kind: 'file' },
        ],
      ],
    });
    const page = await source.read({ connectionId: connection.connection_id, cursor: null, deadline: Date.now() + 60_000, signal: new AbortController().signal });
    const removedIds = page.changes.filter((change) => change.deleted).map((change) => change.fileId);
    const outcome = await deletions.applySourceDeletions(connection, removedIds, 'change_feed', { admin: admin() });
    assert.equal(outcome.removed, 1, 'exactly the cap is purged');
    assert.equal(outcome.failed, 0);
    assert.equal(outcome.held, 1, 'the rest is held');

    assert.equal(await count('SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [a.lineageId]), 0, 'canary-a is purged');
    assert.equal(await count('SELECT count(*) AS n FROM document_chunks WHERE document_id = ANY ($1::uuid[])', [idsA]), 0, 'no chunk of canary-a');
    assert.equal(await cacheServes(a), false, 'no cache entry of canary-a serves');
    const record = (await rows('SELECT citations FROM rag_answer_records WHERE id = $1', [answerA.answerId]))[0];
    assert.ok(!JSON.stringify(record?.citations).includes(a.marker), 'no citation text of canary-a');
    assert.equal(await retrievable(b, idsB), true, 'canary-b is still retrievable before the confirmation');
    assert.equal(await count('SELECT count(*) AS n FROM nango_sync_records WHERE file_id = $1', [b.fileId]), 1, 'canary-b keeps its sync record');

    const held = await rows(
      "SELECT id, candidate_file_ids, pause_reason FROM rag_source_reconcile_runs WHERE connection_id = $1::uuid AND status = 'awaiting_confirmation'",
      [connection.id],
    );
    assert.equal(held.length, 1, 'one paused run');
    assert.equal(held[0]?.pause_reason, 'purge_daily_cap');
    assert.deepEqual(held[0]?.candidate_file_ids, [b.fileId], 'canary-b is the only candidate');

    // confirmReconcileRun takes no admin injection; route the service client's table and RPC calls to the PGlite admin
    // for this call only (the fake edge serves no nango table reads). mock.restoreAll in afterEach undoes it.
    const service = supabaseModule.getSupabaseAdmin() as unknown as Record<string, (...args: unknown[]) => unknown>;
    const pglite = createPgliteAdmin(fixture.db) as unknown as Record<string, (...args: unknown[]) => unknown>;
    mock.method(service, 'from', (...args: unknown[]) => pglite.from!(...args));
    mock.method(service, 'rpc', (...args: unknown[]) => pglite.rpc!(...args));
    const confirmed = await sourceSyncAdmin.confirmReconcileRun({ runId: String(held[0]?.id), actorUserId: OWNER });
    mock.restoreAll();
    assert.ok(confirmed.ok, `confirm failed: ${confirmed.ok ? '' : confirmed.reason}`);
    assert.equal(confirmed.removed, 1);
    assert.equal(confirmed.failed, 0);
    assert.equal(await count('SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [b.lineageId]), 0, 'canary-b is purged after the confirmation');
    assert.equal(await retrievable(a, idsA), false);
    assert.equal(await retrievable(b, idsB), false, 'neither document is retrievable');
    assert.equal(await cacheServes(b), false);
  });

  test('an admin-purged file that was already synced is withdrawn again on its next listing: the purge removed its sync record (D-35)', async () => {
    installStores();
    const purgeModule = await import('@/lib/rag/ingest/purge');
    const connection = await insertConnection(null);
    const a = await ingestFile(connection, CANARY_A, 'alpha');
    const purged = await purgeModule.purgeDocumentAsAdmin({
      documentId: a.documentId,
      actorUserId: OWNER,
      reasonCode: 'owner_request',
      reasonNote: null,
      signal: new AbortController().signal,
    });
    assert.ok(purged.ok, `admin purge failed: ${purged.ok ? '' : purged.reason}`);
    assert.equal(
      await count('SELECT count(*) AS n FROM nango_sync_records WHERE connection_id = $1 AND file_id = $2', [connection.connection_id, a.fileId]),
      0,
      'the admin purge removes the sync record, so the unchanged-file skip cannot bypass the tombstone check',
    );
    const owner = rag.nangoOwnerScope({ ownerUserId: OWNER });
    assert.ok(owner.ok);
    assert.deepEqual(await purgeModule.isPurgeTombstoned(owner.scope, connection.connection_id, a.fileId, { signal: new AbortController().signal }), {
      ok: true,
      tombstoned: true,
    });
    const { purgeTombstoneCheck } = await import('@/lib/nango/purge-tombstone');
    assert.equal(await purgeTombstoneCheck(OWNER, connection.connection_id)(a.fileId), 'withdrawn', 'the next listing withdraws the file instead of ingesting it');
  });
});
