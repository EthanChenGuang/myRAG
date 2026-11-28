import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const RECHECK_SQL = 'SELECT chunk_id::text AS id FROM rag_source_recheck($1, $2::uuid[]) ORDER BY 1';

interface Tenant {
  key: string;
  userId: string | null;
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

async function errorOf(db: PGlite, sql: string, params: unknown[] = []): Promise<{ code?: string; message: string } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return { code: codeOf(error), message: error instanceof Error ? error.message : String(error) };
  }
}

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

async function insertDoc(db: PGlite, mode: DeploymentMode, tenant: Tenant, opts: { status?: string; isCurrent?: boolean } = {}): Promise<string> {
  const id = crypto.randomUUID();
  if (mode === 'multi-tenant') {
    await db.query('INSERT INTO documents (id, filename, content, user_id, is_current, status, doc_type) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      id,
      `recheck-${id}.md`,
      'recheck fixture',
      tenant.userId,
      opts.isCurrent ?? true,
      opts.status ?? 'ready',
      'general',
    ]);
  } else {
    await db.query('INSERT INTO documents (id, filename, content, is_current, status, doc_type) VALUES ($1, $2, $3, $4, $5, $6)', [
      id,
      `recheck-${id}.md`,
      'recheck fixture',
      opts.isCurrent ?? true,
      opts.status ?? 'ready',
      'general',
    ]);
  }
  return id;
}

async function insertChunk(
  db: PGlite,
  docId: string,
  tenant: Tenant,
  spec: { status?: string; isCurrent?: boolean; profile?: string; content?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const body = spec.content ?? `recheck synthetic sentence ${id}`;
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index, embedding, lexical_text, tenant_key, doc_type, is_current, status,
                                  chunking_profile_id, chunk_kind)
     VALUES ($1, $2, $3, '{}'::jsonb, 0, $4::vector, $3, $5, 'general', $6, $7, $8, 'text')`,
    [id, docId, body, vec(body), tenant.key, spec.isCurrent ?? true, spec.status ?? 'ready', spec.profile ?? 'legacy'],
  );
  return id;
}

for (const mode of MODES) {
  describe(`rag_source_recheck SQL (${mode})`, () => {
    let db: PGlite;
    let a: Tenant;
    let b: Tenant | null = null;
    const ids: Record<string, string> = {};

    const recheck = async (key: string, chunkIds: string[]): Promise<string[]> =>
      (await db.query<{ id: string }>(RECHECK_SQL, [key, chunkIds])).rows.map((row) => row.id);

    before(async () => {
      if (mode === 'multi-tenant') {
        db = (await createTwoTenantDatabase()).db;
        a = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
        b = { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB };
      } else {
        db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS })).db;
        a = { key: 's:default', userId: null };
      }
      const docA = await insertDoc(db, mode, a);
      ids.ready = await insertChunk(db, docA, a);
      ids.variant = await insertChunk(db, docA, a, { profile: 'p-recheck-variant' });
      ids.chunkQuarantined = await insertChunk(db, docA, a, { status: 'quarantined' });
      ids.chunkFailed = await insertChunk(db, docA, a, { status: 'failed' });
      ids.chunkDeleted = await insertChunk(db, docA, a, { status: 'deleted', isCurrent: false });
      ids.chunkSuperseded = await insertChunk(db, docA, a, { isCurrent: false });

      const softDeleted = await insertDoc(db, mode, a);
      ids.docSoftDeleted = await insertChunk(db, softDeleted, a);
      await db.query("UPDATE documents SET is_current = false, status = 'deleted' WHERE id = $1", [softDeleted]);
      const quarantined = await insertDoc(db, mode, a);
      ids.docQuarantined = await insertChunk(db, quarantined, a);
      await db.query("UPDATE documents SET status = 'quarantined' WHERE id = $1", [quarantined]);
      const notCurrent = await insertDoc(db, mode, a);
      ids.docNotCurrent = await insertChunk(db, notCurrent, a);
      await db.query('UPDATE documents SET is_current = false WHERE id = $1', [notCurrent]);
      const hardDeleted = await insertDoc(db, mode, a);
      ids.docDeleted = await insertChunk(db, hardDeleted, a);
      await db.query('DELETE FROM document_chunks WHERE document_id = $1', [hardDeleted]);
      await db.query('DELETE FROM documents WHERE id = $1', [hardDeleted]);

      if (b) {
        const docB = await insertDoc(db, mode, b);
        ids.foreign = await insertChunk(db, docB, b);
      }
    });

    after(async () => {
      await db?.close();
    });

    test('a ready and a variant chunk of a current, ready document are returned', async () => {
      assert.deepEqual(await recheck(a.key, [ids.ready!, ids.variant!]), [ids.ready, ids.variant].sort());
    });

    test('soft-deleted, quarantined, not-current and deleted documents and quarantined, failed, deleted or superseded chunks are not returned', async () => {
      for (const name of ['docSoftDeleted', 'docQuarantined', 'docNotCurrent', 'docDeleted', 'chunkQuarantined', 'chunkFailed', 'chunkDeleted', 'chunkSuperseded']) {
        assert.deepEqual(await recheck(a.key, [ids[name]!]), [], name);
      }
      assert.deepEqual(await recheck(a.key, [ids.ready!, ids.docSoftDeleted!, ids.chunkQuarantined!]), [ids.ready]);
    });

    test("another tenant's ids are not returned", { skip: mode === 'single-tenant' }, async () => {
      assert.ok(b);
      assert.deepEqual(await recheck(a.key, [ids.foreign!, ids.ready!]), [ids.ready]);
      assert.deepEqual(await recheck(b.key, [ids.foreign!, ids.ready!]), [ids.foreign]);
    });

    test('a key of the other deployment mode and malformed keys raise 22023', async () => {
      const wrong = mode === 'single-tenant' ? `u:${TWO_TENANT_IDS.userA}` : 's:default';
      for (const key of [wrong, null, '', 'tenant']) {
        assert.equal((await errorOf(db, RECHECK_SQL, [key, [ids.ready]]))?.code, '22023', String(key));
      }
    });

    test('501 ids raise 22023; 500, empty and NULL input do not', async () => {
      const many = Array.from({ length: 501 }, () => crypto.randomUUID());
      const error = await errorOf(db, RECHECK_SQL, [a.key, many]);
      assert.equal(error?.code, '22023');
      assert.match(String(error?.message), /invalid_argument/);
      assert.deepEqual(await recheck(a.key, many.slice(0, 500)), []);
      assert.deepEqual(await recheck(a.key, []), []);
      assert.deepEqual((await db.query('SELECT * FROM rag_source_recheck($1, NULL)', [a.key])).rows, []);
    });

    test('anon and authenticated get 42501; service_role succeeds', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          assert.equal((await errorOf(db, RECHECK_SQL, [a.key, [ids.ready]]))?.code, '42501', role);
        } finally {
          await db.exec('RESET ROLE');
        }
      }
      await db.exec('SET ROLE service_role');
      try {
        assert.deepEqual(await recheck(a.key, [ids.ready!]), [ids.ready]);
      } finally {
        await db.exec('RESET ROLE');
      }
    });

    test('SECURITY DEFINER, empty search_path, no PUBLIC execute, one overload, the tenant guard first', async () => {
      const rows = (
        await db.query<Record<string, unknown>>(
          `SELECT p.prosecdef AS definer, p.prosrc AS src,
                  COALESCE((SELECT c FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'), '') AS search_path,
                  COALESCE((SELECT bool_or(g.grantee = 0) FROM aclexplode(p.proacl) g WHERE g.privilege_type = 'EXECUTE'), true) AS public_exec
             FROM pg_proc p WHERE p.oid = to_regprocedure('public.rag_source_recheck(text,uuid[])')`,
        )
      ).rows;
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.definer, true);
      assert.equal(String(row.search_path).replace(/\s/g, ''), 'search_path=""');
      assert.equal(row.public_exec, false);
      const src = String(row.src);
      assert.ok(src.indexOf('rag_assert_tenant_key') >= 0 && src.indexOf('rag_assert_tenant_key') < src.indexOf('RETURN QUERY'));
      assert.doesNotMatch(src, /current_setting|set_config/i);
      const overloads = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'rag_source_recheck'")).rows[0]?.n;
      assert.equal(overloads, 1);
    });
  });
}

const ROUTE_PATH = '/api/internal/rag/run';
const QUERY = 'What is SKU LV-RC-0030?';
const TENANT = 's:default';
// No fixture chunk scores this high, so the refusal stage's top score shows whether a stale hit reached the rank stages.
const STALE_SIMILARITY = 0.999;

interface TraceBody {
  candidates: Array<{ chunk_id: string; content: string }>;
  stage_status: Record<string, string>;
  stage_latency_ms: Record<string, number>;
  stage_counts?: Record<string, Record<string, number>>;
  stale_index_drop?: number;
  refusal?: { top_score: number | null } | null;
}

describe('source_recheck stage on the v2 eval path (D-19, D-38, D-46)', () => {
  let prepared: InProcessEval;
  let registry: typeof import('../../src/lib/rag/backend/registry.ts');
  const stale: Array<{ chunkId: string; documentId: string; content: string }> = [];

  async function postEval(itemId: string): Promise<{ status: number; json: TraceBody }> {
    const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
      body: JSON.stringify({ schema_version: 1, query: QUERY, item_id: itemId, rag_mode: 'strict', options: {} }),
    });
    const res = await prepared.POST(req);
    return { status: res.status, json: (await res.json()) as TraceBody };
  }

  function staleHit(row: { chunkId: string; documentId: string; content: string }, rank: number) {
    return {
      rank,
      chunkId: row.chunkId,
      documentId: row.documentId,
      parentId: null,
      content: row.content,
      metadata: {},
      chunkIndex: 0,
      sectionPath: [],
      chunkKind: 'text',
      similarity: STALE_SIMILARITY,
      lexicalScore: null,
      docType: 'general',
      language: 'en',
      document: { filename: `recheck-${row.documentId}.md`, createdAt: null, metadata: {}, contentPreview: '' },
    };
  }

  async function withSwitch<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const previous = process.env.RAG_SOURCE_RECHECK;
    if (value === undefined) delete process.env.RAG_SOURCE_RECHECK;
    else process.env.RAG_SOURCE_RECHECK = value;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.RAG_SOURCE_RECHECK;
      else process.env.RAG_SOURCE_RECHECK = previous;
    }
  }

  before(async () => {
    prepared = await prepareInProcessEval({
      corpusDir: REAL_CORPUS,
      deploymentMode: 'single-tenant',
      envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' },
    });
    registry = await import('../../src/lib/rag/backend/registry.ts');
    const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
    registry.resetRetrievalBackendForTests();
    resetV2StartupForTests();
    await verifyV2Startup();

    const db = prepared.fixtureDb;
    const tenant: Tenant = { key: TENANT, userId: null };
    // Two chunks of a document deleted directly in the database, and one of a document removed through a soft delete: the stubbed
    // index below keeps returning all three, as an index that missed the deletes would.
    const gone = await insertDoc(db, 'single-tenant', tenant);
    for (const n of [1, 2]) {
      const content = `SKU LV-RC-0030 stale synthetic sentence ${n}`;
      stale.push({ chunkId: await insertChunk(db, gone, tenant, { content }), documentId: gone, content });
    }
    const soft = await insertDoc(db, 'single-tenant', tenant);
    const softContent = 'SKU LV-RC-0030 soft-deleted synthetic sentence';
    stale.push({ chunkId: await insertChunk(db, soft, tenant, { content: softContent }), documentId: soft, content: softContent });

    await db.query('DELETE FROM document_chunks WHERE document_id = $1', [gone]);
    await db.query('DELETE FROM documents WHERE id = $1', [gone]);
    await db.query("UPDATE documents SET is_current = false, status = 'deleted' WHERE id = $1", [soft]);
    await db.query("UPDATE document_chunks SET is_current = false, status = 'deleted' WHERE document_id = $1", [soft]);

    const real = registry.getRetrievalBackend();
    registry.setRetrievalBackendForTests({
      id: real.id,
      health: () => real.health(),
      isReady: (scope) => real.isReady(scope),
      ...(real.searchTranslations ? { searchTranslations: (req) => real.searchTranslations!(req) } : {}),
      search: async (req) => {
        const legs = await real.search(req);
        const injected = stale.map((row, index) => staleHit(row, index + 1));
        return { ...legs, dense: [...injected, ...legs.dense.map((hit) => ({ ...hit, rank: hit.rank + injected.length }))] };
      },
    });
  });

  after(async () => {
    registry?.resetRetrievalBackendForTests();
    await prepared?.close();
  });

  test('switch off: no source_recheck key in the trace, no stale_index_drop, the stale ids reach the candidates', async () => {
    await withSwitch(undefined, async () => {
      const { status, json } = await postEval('recheck-off');
      assert.equal(status, 200);
      assert.equal(json.stage_status.source_recheck, undefined);
      assert.equal(json.stage_latency_ms.source_recheck, undefined);
      assert.equal(json.stage_counts?.source_recheck, undefined);
      assert.equal(json.stale_index_drop, undefined);
      assert.equal(json.refusal?.top_score, STALE_SIMILARITY, 'the stubbed index should put stale hits into the rank input with the switch off');
    });
    await withSwitch('false', async () => {
      const { json } = await postEval('recheck-off-explicit');
      assert.equal(json.stage_status.source_recheck, undefined);
      assert.equal(json.stale_index_drop, undefined);
    });
  });

  test('switch on: the stale ids are dropped before rerank and counted on the trace', async () => {
    const logged: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => {
      logged.push(args.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
    };
    try {
      await withSwitch('true', async () => {
        const { status, json } = await postEval('recheck-on');
        assert.equal(status, 200);
        assert.equal(json.stage_status.source_recheck, 'ok');
        const ids = new Set(json.candidates.map((row) => row.chunk_id));
        for (const row of stale) assert.equal(ids.has(row.chunkId), false, `stale ${row.chunkId} survived`);
        assert.notEqual(json.refusal?.top_score, STALE_SIMILARITY, 'a stale hit reached the rank stages');
        assert.equal(json.stale_index_drop, stale.length);
        const counts = json.stage_counts?.source_recheck;
        assert.ok(counts);
        assert.equal(counts.stale_index_drop, stale.length);
        assert.ok(counts.checked >= stale.length);
        assert.ok(ids.size > 0, 'the live candidates continue');
      });
    } finally {
      console.info = original;
    }
    const lines = logged.filter((line) => line.startsWith('[Document Search]'));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0]!, /"dropped":3/);
    assert.match(lines[0]!, /"checked":\d+/);
    for (const row of stale) {
      assert.equal(lines[0]!.includes(row.chunkId), false);
      assert.equal(lines[0]!.includes(row.content), false);
    }
  });

  test('switch on with nothing stale: no drop line and stale_index_drop 0', async () => {
    const saved = stale.splice(0, stale.length);
    try {
      await withSwitch('true', async () => {
        const { json } = await postEval('recheck-clean');
        assert.equal(json.stage_status.source_recheck, 'ok');
        assert.equal(json.stale_index_drop, 0);
      });
    } finally {
      stale.push(...saved);
    }
  });

  test('degraded: with rag_source_recheck missing the stage is skipped, the candidates continue unchecked and the request succeeds', async () => {
    await prepared.fixtureDb.exec('DROP FUNCTION public.rag_source_recheck(text, uuid[])');
    await withSwitch('true', async () => {
      const { status, json } = await postEval('recheck-degraded');
      assert.equal(status, 200);
      assert.equal(json.stage_status.source_recheck, 'skipped');
      assert.equal(json.stale_index_drop, undefined);
      assert.equal(json.stage_counts?.source_recheck, undefined);
      assert.equal(json.refusal?.top_score, STALE_SIMILARITY, 'unchecked candidates continue into the rank stages');
    });
  });
});
