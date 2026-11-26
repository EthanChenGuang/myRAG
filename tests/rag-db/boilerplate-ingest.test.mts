import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';

/**
 * Plan 03.3-10 (TPL-02, TPL-08; D-06 to D-11): page boilerplate cleaning inside the real pipeline against the fixture database, and the
 * review flag function of migration 1004 in both deployment modes. Documents and rules are invented and described by structure.
 */

type Row = Record<string, unknown>;

const FLAG_SQL = 'SELECT * FROM rag_flag_document_review(p_document_id => $1, p_tenant_key => $2, p_reason => $3)';
const RULED_LINE = 'Internal circulation marker qv';
const PATTERN = '^Internal circulation marker';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<{ message: string; code: string | null } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return { message: messageOf(error), code: (error as { code?: string }).code ?? null };
  }
}

function documentText(seed: string): string {
  const sections = ['first', 'second', 'third'].map((name) =>
    [`## Section ${name} ${seed}`, '', RULED_LINE, '', `The ${name} section of the ${seed} sample holds ordinary neutral sentences that describe a plain process in several steps.`, ''].join('\n'),
  );
  return [`# Sample ${seed}`, '', ...sections].join('\n');
}

async function beginDocument(db: PGlite, key: string, userId: string | null, orgId: string | null, label: string): Promise<string> {
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await db.query<Row>(
    `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'chat_upload', $4, $5, $6, 'general', 'fallback', 'general-1', 1)`,
    [key, userId, orgId, `upload/${name}.md`, `${name}.md`, crypto.createHash('sha256').update(name).digest('hex')],
  );
  return String(result.rows[0]?.document_id);
}

async function flagState(db: PGlite, id: string): Promise<Row> {
  return (await db.query<Row>("SELECT needs_review, needs_review_reason, metadata -> 'review_reasons' AS reasons, status FROM documents WHERE id = $1", [id])).rows[0]!;
}

async function flagFunctionChecks(db: PGlite, own: { key: string; id: string }, foreign: { key: string; id: string } | null): Promise<void> {
  const first = await db.query<Row>(FLAG_SQL, [own.id, own.key, 'boilerplate_above_threshold']);
  assert.equal(first.rows[0]?.needs_review, true);
  await db.query(FLAG_SQL, [own.id, own.key, 'tenant_pattern_timeout']);
  await db.query(FLAG_SQL, [own.id, own.key, 'boilerplate_above_threshold']);
  const state = await flagState(db, own.id);
  assert.equal(state.needs_review, true);
  assert.equal(state.needs_review_reason, 'boilerplate_above_threshold', 'the first reason is kept');
  assert.deepEqual(state.reasons, ['boilerplate_above_threshold', 'tenant_pattern_timeout'], 'every code once, in order');

  const bad = await failure(db, FLAG_SQL, [own.id, own.key, 'something_else']);
  assert.equal(bad?.code, '22023');

  if (foreign) {
    const before = await flagState(db, foreign.id);
    const refused = await failure(db, FLAG_SQL, [foreign.id, own.key, 'tenant_pattern_timeout']);
    assert.match(refused?.message ?? '', /not_found/);
    assert.deepEqual(await flagState(db, foreign.id), before, 'another tenant’s document is unchanged');
  }
  const unknown = await failure(db, FLAG_SQL, [crypto.randomUUID(), own.key, 'tenant_pattern_timeout']);
  assert.match(unknown?.message ?? '', /not_found/);

  for (const role of ['anon', 'authenticated']) {
    await db.query(`SET ROLE ${role}`);
    try {
      const denied = await failure(db, FLAG_SQL, [own.id, own.key, 'tenant_pattern_timeout']);
      assert.match(denied?.message ?? '', /permission denied/, `${role} cannot execute the flag function`);
    } finally {
      await db.query('RESET ROLE');
    }
  }

  const fn = (
    await db.query<Row>(
      `SELECT p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'rag_flag_document_review'`,
    )
  ).rows;
  assert.equal(fn.length, 1);
  assert.equal(fn[0]?.prosecdef, false, 'invoker rights');
  assert.ok(String(fn[0]?.proconfig).includes('search_path=""'), 'empty search_path');
}

describe('rag_flag_document_review in single-tenant mode', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
  });

  after(async () => {
    await db?.close();
  });

  test('flags, keeps the first reason, appends each code once, refuses bad codes, other keys and client roles', async () => {
    const own = await beginDocument(db, 's:default', null, null, 'flag-own');
    await flagFunctionChecks(db, { key: 's:default', id: own }, null);
    const wrongMode = await failure(db, FLAG_SQL, [own, `u:${TWO_TENANT_IDS.userA}`, 'tenant_pattern_timeout']);
    assert.ok(wrongMode, 'a key of the other deployment mode is refused');
  });
});

describe('page boilerplate cleaning through the pipeline (multi-tenant)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let rulesModule: typeof import('@/lib/rag/ingest/rules/load');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let store: import('../helpers/fake-object-store').FakeObjectStore;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    rulesModule = await import('@/lib/rag/ingest/rules/load');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(() => {
    store = fakeStoreModule.createFakeObjectStore();
    objectStoreModule.setObjectStoreForTests(store);
    rulesModule.resetTenantRuleCacheForTests();
  });

  afterEach(async () => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    await fixture.db.query('DELETE FROM public.rag_boilerplate_rules');
    mock.restoreAll();
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

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

  /** Counts rpc calls by name on the real admin client; optional clock jump after the images stage saved its state. */
  const countingDeps = (env: Record<string, string>, options: { interrupt?: boolean } = {}) => {
    const real = supabaseModule.getSupabaseAdmin() as unknown as RpcClient;
    const counts = new Map<string, number>();
    let clock = 1_000_000;
    let armed = options.interrupt === true;
    const db: RpcClient = {
      rpc(fn, args) {
        counts.set(fn, (counts.get(fn) ?? 0) + 1);
        const state = args.p_state as { lastCompleted?: string } | undefined;
        if (armed && fn === 'rag_save_ingest_state' && state?.lastCompleted === 'images') {
          clock += 49_500;
          armed = false;
        }
        return real.rpc(fn, args);
      },
    };
    depsModule.setIngestDepsForTests({ db: () => db, now: () => clock, ingestEnv: () => ({ RAG_INGEST_PIPELINE: 'unified', ...env }) });
    return counts;
  };

  const addLineRule = async (tenantKey: string) => {
    await fixture.db.query(
      "INSERT INTO public.rag_boilerplate_rules (tenant_key, name, kind, pattern, flags) VALUES ($1, $2, 'line', $3, 'u')",
      [tenantKey, `rule-${crypto.randomUUID().slice(0, 6)}`, PATTERN],
    );
  };

  const upload = async (userId: string, text: string, filename: string) =>
    ingestModule.ingest({
      scope: await scopeOf(userId),
      source: 'config_upload',
      sourceKey: `root/${filename}`,
      text,
      filename,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

  const chunkContents = async (documentId: string) =>
    (await rows('SELECT content FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId])).map((row) => String(row.content));

  const parseMd = (documentId: string): string | null => {
    for (const [key, value] of store.objects) {
      if (key.endsWith('/parse.md') && key.includes('/')) {
        void documentId;
        return new TextDecoder().decode(value.bytes);
      }
    }
    return null;
  };

  test('rules mode with a tenant line rule: chunks and content lose the line, parse.md and the content hash stay raw, the report is stored, the document is published', async () => {
    const text = documentText('ruled');
    countingDeps({ RAG_PAGE_BOILERPLATE: 'off' });
    const plain = await upload(TWO_TENANT_IDS.userB, text, 'ruled-off.md');
    assert.equal(plain.status, 'ready');
    const plainParse = parseMd(plain.documentId!);

    store = fakeStoreModule.createFakeObjectStore();
    objectStoreModule.setObjectStoreForTests(store);
    await addLineRule(`u:${TWO_TENANT_IDS.userA}`);
    countingDeps({ RAG_PAGE_BOILERPLATE: 'rules' });
    const cleaned = await upload(TWO_TENANT_IDS.userA, text, 'ruled-on.md');
    assert.equal(cleaned.status, 'ready');
    const id = cleaned.documentId!;

    for (const content of await chunkContents(id)) assert.ok(!content.includes(RULED_LINE), 'no chunk holds the ruled line');
    const [doc] = await rows("SELECT content, content_hash, status, is_current, metadata -> 'boilerplate' AS report, needs_review FROM documents WHERE id = $1", [id]);
    assert.ok(!String(doc?.content).includes(RULED_LINE), 'documents.content is cleaned');
    assert.equal(doc?.status, 'ready');
    assert.equal(doc?.is_current, true);
    assert.equal(parseMd(id), plainParse, 'parse.md keeps the parse-stage bytes');
    assert.ok(String(parseMd(id)).includes(RULED_LINE));
    const [plainDoc] = await rows('SELECT content_hash FROM documents WHERE id = $1', [plain.documentId]);
    assert.equal(doc?.content_hash, plainDoc?.content_hash, 'the version content hash follows the raw parse text');
    const report = doc?.report as Row;
    assert.equal(report.lines_removed, 3);
    assert.equal(report.cleaner_version, 1);
    const [plainMeta] = await rows("SELECT metadata ? 'boilerplate' AS has FROM documents WHERE id = $1", [plain.documentId]);
    assert.equal(plainMeta?.has, false, 'the switch off writes no report');
  });

  test('another tenant’s line rule removes nothing from this tenant’s document', async () => {
    await addLineRule(`u:${TWO_TENANT_IDS.userA}`);
    countingDeps({ RAG_PAGE_BOILERPLATE: 'rules' });
    const result = await upload(TWO_TENANT_IDS.userB, documentText('foreign'), 'foreign.md');
    assert.equal(result.status, 'ready');
    const contents = (await chunkContents(result.documentId!)).join('\n');
    assert.ok(contents.includes(RULED_LINE), 'tenant B keeps the line tenant A rules away');
    const [doc] = await rows("SELECT (metadata -> 'boilerplate' ->> 'lines_removed')::int AS removed, needs_review FROM documents WHERE id = $1", [result.documentId]);
    assert.equal(doc?.removed, 0);
    assert.equal(doc?.needs_review, false);
  });

  test('detect on a plain-text document warns boilerplate_pages_unavailable and ingests unchanged', async () => {
    countingDeps({ RAG_PAGE_BOILERPLATE: 'detect' });
    const text = documentText('plain');
    const result = await upload(TWO_TENANT_IDS.userA, text, 'plain-detect.md');
    assert.equal(result.status, 'ready');
    assert.ok(result.warnings.includes('boilerplate_pages_unavailable'));
    assert.ok((await chunkContents(result.documentId!)).join('\n').includes(RULED_LINE));
  });

  test('resume: a run stopped after the chunk stage resumes to the same chunks after the rule is deleted, with no rule load', async () => {
    const text = documentText('resume');
    await addLineRule(`u:${TWO_TENANT_IDS.userB}`);
    countingDeps({ RAG_PAGE_BOILERPLATE: 'rules' });
    const reference = await upload(TWO_TENANT_IDS.userB, text, 'resume-reference.md');
    assert.equal(reference.status, 'ready');

    await addLineRule(`u:${TWO_TENANT_IDS.userA}`);
    rulesModule.resetTenantRuleCacheForTests();
    countingDeps({ RAG_PAGE_BOILERPLATE: 'rules' }, { interrupt: true });
    const interrupted = await upload(TWO_TENANT_IDS.userA, text, 'resume-run.md');
    assert.equal(interrupted.status, 'processing');
    const [saved] = await rows('SELECT processing_state FROM documents WHERE id = $1', [interrupted.documentId]);
    assert.ok((saved?.processing_state as Row).chunkPrep, 'the snapshot is saved with the state');

    await fixture.db.query('DELETE FROM public.rag_boilerplate_rules WHERE tenant_key = $1', [`u:${TWO_TENANT_IDS.userA}`]);
    rulesModule.resetTenantRuleCacheForTests();
    const counts = countingDeps({ RAG_PAGE_BOILERPLATE: 'rules' });
    const resumed = await ingestModule.resumeIngest(await scopeOf(TWO_TENANT_IDS.userA), interrupted.documentId!);
    assert.equal(resumed.status, 'ready');
    assert.ok(!resumed.warnings.includes('write_incomplete'));
    assert.equal(counts.get('rag_tenant_rules_for') ?? 0, 0, 'the resumed run loads no rules');
    assert.equal(resumed.chunkCount, reference.chunkCount);
    assert.deepEqual(await chunkContents(interrupted.documentId!), await chunkContents(reference.documentId!));
  });

  test('flag function: two tenants', async () => {
    const own = await beginDocument(fixture.db, `u:${TWO_TENANT_IDS.userA}`, TWO_TENANT_IDS.userA, null, 'mt-own');
    const foreign = await beginDocument(fixture.db, `u:${TWO_TENANT_IDS.userB}`, TWO_TENANT_IDS.userB, null, 'mt-foreign');
    await flagFunctionChecks(fixture.db, { key: `u:${TWO_TENANT_IDS.userA}`, id: own }, { key: `u:${TWO_TENANT_IDS.userB}`, id: foreign });
  });
});
