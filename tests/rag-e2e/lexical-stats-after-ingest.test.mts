import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

// Plan 04.4-10 (LEX-03, D-17): with RAG_LEXICAL_SCORING=bm25 the publish stage keeps the tenant's lexical statistics current; with
// ts_rank_cd it touches nothing. Every text is a neutral synthetic sample.

type Row = Record<string, unknown>;

const TENANT = `u:${TWO_TENANT_IDS.userA}`;
const LEXICAL_ENV: Record<string, string> = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' };
const SCHEDULE_FILE = new URL('../../supabase/optional/lexical-stats-schedule.sql', import.meta.url);

function body(token: string, count: number): string {
  const paragraphs = Array.from({ length: count }, (_, index) => `## Part ${index + 1}\n\nSynthetic paragraph ${token} w${index} w${index + 3} canary ${'filler '.repeat(40)}`);
  return `# Notes ${token}\n\n${paragraphs.join('\n\n')}\n`;
}

describe('lexical statistics after ingest (bm25)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db, documentFilenameFilter: true });
    for (const name of [...Object.keys(LEXICAL_ENV), 'RAG_LEXICAL_SCORING']) saved[name] = process.env[name];
    Object.assign(process.env, fixtureProcessEnv(edge.url), LEXICAL_ENV);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(() => {
    objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
    depsModule.setIngestDepsForTests({ ingestEnv: () => ({ RAG_INGEST_PIPELINE: 'unified' }) });
  });

  afterEach(() => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    delete process.env.RAG_LEXICAL_SCORING;
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  const upload = async (sourceKey: string, text: string) => {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: TWO_TENANT_IDS.userA }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return ingestModule.ingest({
      scope: resolved.scope,
      source: 'config_upload',
      sourceKey,
      text,
      filename: sourceKey.split('/').pop() as string,
      mimeType: 'text/markdown',
      uploaderId: TWO_TENANT_IDS.userA,
      signal: new AbortController().signal,
    });
  };

  const memberCount = async (): Promise<number> =>
    Number(
      (
        await rows(
          `SELECT count(*)::int AS n FROM document_chunks
            WHERE tenant_key = $1 AND is_current AND status IN ('ready', 'variant') AND lexical_tsv IS NOT NULL AND lexical_tsv <> ''`,
          [TENANT],
        )
      )[0]?.n,
    );

  const check = async (): Promise<Row> => (await rows('SELECT public.rag_lexstats_check($1) AS c', [TENANT]))[0]?.c as Row;
  const status = async (): Promise<Row> => (await rows('SELECT public.rag_lexstats_status($1) AS s', [TENANT]))[0]?.s as Row;

  test('ts_rank_cd: an ingest leaves the statistics tables untouched', async () => {
    const result = await upload('root/plain-notes.md', body('zqxplain', 2));
    assert.equal(result.status, 'ready');
    assert.equal((await rows('SELECT * FROM rag_lexical_stats_state')).length, 0);
    assert.equal((await rows('SELECT * FROM rag_lexical_stats_pending')).length, 0);
  });

  test('bm25: a new document, then a new version of it, leave clean statistics that count the current version only', async () => {
    process.env.RAG_LEXICAL_SCORING = 'bm25';
    const first = await upload('root/lexical-notes.md', body('zqxfirst', 3));
    assert.equal(first.status, 'ready');
    let checked = await check();
    assert.equal(checked.clean, true, 'clean after the first publish');
    assert.equal(Number((await status()).pending), 0, 'compacted after the first publish');
    assert.equal(Number((await status()).chunk_count), await memberCount());
    assert.ok((await memberCount()) > 0);

    const second = await upload('root/lexical-notes.md', body('zqxsecond', 5));
    assert.equal(second.status, 'ready');
    assert.notEqual(second.documentId, first.documentId, 'the re-publish is a new version');
    checked = await check();
    assert.equal(checked.clean, true, 'clean after the re-publish');
    assert.equal(Number((await status()).pending), 0, 'compacted after the re-publish');
    const ofSecond = Number(
      (
        await rows(
          `SELECT count(*)::int AS n FROM document_chunks
            WHERE document_id = $1 AND is_current AND status IN ('ready', 'variant') AND lexical_tsv IS NOT NULL AND lexical_tsv <> ''`,
          [second.documentId],
        )
      )[0]?.n,
    );
    const ofFirst = Number((await rows('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1 AND is_current', [first.documentId]))[0]?.n);
    assert.equal(ofFirst, 0, 'the superseded version has no current chunk');
    // The tenant's other document (the ts_rank_cd upload above) is a member too; the superseded version is not.
    assert.equal(Number((await status()).chunk_count), await memberCount());
    const ofPlain = (await memberCount()) - ofSecond;
    assert.ok(ofSecond > 0 && ofPlain > 0);
  });

  test('the optional schedule is skipped without pg_cron and idempotent with it', async () => {
    const sql = readFileSync(SCHEDULE_FILE, 'utf8');
    await fixture.db.exec(sql);
    await fixture.db.exec(`
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text NOT NULL, command text NOT NULL);
      CREATE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS $f$
        INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_schedule, p_command) RETURNING jobid
      $f$;
      CREATE FUNCTION cron.unschedule(p_name text) RETURNS boolean LANGUAGE sql AS $f$
        WITH d AS (DELETE FROM cron.job WHERE jobname = p_name RETURNING 1) SELECT EXISTS (SELECT 1 FROM d)
      $f$;
    `);
    await fixture.db.exec(sql);
    await fixture.db.exec(sql);
    const jobs = await rows('SELECT jobname, schedule, command FROM cron.job');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.jobname, 'myrag-lexical-stats-compact');
    assert.equal(jobs[0]?.schedule, '*/5 * * * *');
    assert.match(String(jobs[0]?.command), /public\.rag_lexstats_compact_all\(5000\)/);
    await fixture.db.exec('SELECT public.rag_lexstats_compact_all(5000)');
    await fixture.db.exec('DROP SCHEMA cron CASCADE');
  });
});
