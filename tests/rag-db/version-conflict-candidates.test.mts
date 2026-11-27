import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { VersionConflict } from '../../src/lib/rag/context/version-conflicts.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const LEGACY_PROFILE = 'openai-3-small-1536';
const HALFVEC_PROFILE = 'voyage-4-large-1024';

type Row = Record<string, unknown>;

// Placeholder values only: the env module validates presence at import; no request leaves the process.
for (const [name, value] of Object.entries({
  OPENAI_API_KEY: 'placeholder-key',
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service',
})) {
  if (!process.env[name]) process.env[name] = value;
}
const { writeAnswerConflict } = await import('../../src/lib/rag/context/version-conflicts.ts');

interface Ctx {
  db: PGlite;
  key: string;
  userId: string | null;
  orgId: string | null;
  /** Another tenant's key (multi-tenant mode), or null. */
  otherKey: string | null;
}

async function createCtx(mode: DeploymentMode): Promise<Ctx> {
  if (mode === 'single-tenant') {
    const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS });
    return { db: fixture.db, key: 's:default', userId: null, orgId: null, otherKey: null };
  }
  const fixture = await createTwoTenantDatabase();
  return { db: fixture.db, key: `o:${TWO_TENANT_IDS.orgO}`, userId: TWO_TENANT_IDS.userA, orgId: TWO_TENANT_IDS.orgO, otherKey: `u:${TWO_TENANT_IDS.userB}` };
}

async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, params)).rows;
}

let sequence = 0;
const next = (label: string): string => `${label}${++sequence}`;

async function currentDocument(ctx: Ctx, label: string): Promise<string> {
  const name = next(label);
  const begun = await rows(
    ctx.db,
    `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'config_upload', $4, $5, $6, 'general', 'fallback', 'general-1', 1)`,
    [ctx.key, ctx.userId, ctx.orgId, `conflict/${name}.md`, `${name}.md`, crypto.createHash('sha256').update(name).digest('hex')],
  );
  const id = String(begun[0]?.document_id);
  const texts = [`${name} neutral synthetic sentence about a shared topic`];
  const chunks = texts.map((content, index) => ({ chunk_index: index, content, lexical_text: content, metadata: {} }));
  const embeddings = {
    [LEGACY_PROFILE]: texts.map((text) => embedText(text)),
    [HALFVEC_PROFILE]: texts.map((text) => embedText(text).slice(0, 1024)),
  };
  await rows(
    ctx.db,
    `SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => $5::int)`,
    [id, ctx.key, JSON.stringify(chunks), JSON.stringify(embeddings), texts.length],
  );
  const published = await rows(ctx.db, 'SELECT outcome FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, ctx.key]);
  assert.equal(published[0]?.outcome, 'published');
  return id;
}

/** The admin client's rpc, run as service_role against PGlite with named arguments. */
function serviceRpc(db: PGlite) {
  return async (fn: string, args: Record<string, unknown>) => {
    assert.match(fn, /^rag_[a-z_]+$/);
    const names = Object.keys(args);
    const params = names.map((name) => {
      const value = args[name];
      return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
    });
    const list = names.map((name, index) => `${name} => $${index + 1}`).join(', ');
    await db.exec('SET ROLE service_role');
    try {
      const result = await db.query<Row>(`SELECT * FROM public.${fn}(${list})`, params);
      const first = result.rows[0];
      const keys = first ? Object.keys(first) : [];
      const data = keys.length === 1 && keys[0] === fn ? first![fn] : result.rows;
      return { data, error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
    } finally {
      await db.exec('RESET ROLE');
    }
  };
}

function conflictOf(older: string, newer: string): VersionConflict {
  return {
    document_ids: [older, newer],
    latest_document_id: newer,
    group_rule: 'title_match',
    pairs: [
      {
        documentIds: [older, newer],
        newerDocumentId: newer,
        olderDocumentId: older,
        rule: 'title_match',
        signals: { title_match: true, content_overlap_percent: 80, conflicting_numbers: 1 },
      },
    ],
  };
}

async function candidatesFor(ctx: Ctx, a: string, b: string): Promise<Row[]> {
  return rows(
    ctx.db,
    `SELECT document_id::text, candidate_document_id::text, status, origin, direction, tenant_key FROM rag_supersession_candidates
     WHERE LEAST(document_id, candidate_document_id) = LEAST($1::uuid, $2::uuid) AND GREATEST(document_id, candidate_document_id) = GREATEST($1::uuid, $2::uuid)`,
    [a, b],
  );
}

for (const mode of MODES) {
  describe(`answer-conflict hand-off (D-52, D-55) (${mode})`, () => {
    let ctx: Ctx;
    const it = (name: string, run: () => Promise<void>) => test(`${name} [${mode}]`, run);

    before(async () => {
      ctx = await createCtx(mode);
    });

    after(async () => {
      await ctx.db.close();
    });

    it('a conflict writes one pending answer_conflict candidate; the same pair again writes none', async () => {
      const older = await currentDocument(ctx, 'older');
      const newer = await currentDocument(ctx, 'newer');
      const rpc = serviceRpc(ctx.db);
      const deps = { rpc, enqueueDeps: { enabled: () => false }, log: () => {} };
      const first = await writeAnswerConflict({ tenantKey: ctx.key, conflict: conflictOf(older, newer) }, deps);
      assert.equal(first.raised, 1);
      const second = await writeAnswerConflict({ tenantKey: ctx.key, conflict: conflictOf(older, newer) }, deps);
      assert.equal(second.failed, 0);
      const found = await candidatesFor(ctx, older, newer);
      assert.equal(found.length, 1);
      assert.deepEqual(found[0], {
        document_id: newer,
        candidate_document_id: older,
        status: 'pending',
        origin: 'answer_conflict',
        direction: 'document_newer',
        tenant_key: ctx.key,
      });
    });

    it('nothing is superseded: both documents stay current and ready', async () => {
      const older = await currentDocument(ctx, 'older');
      const newer = await currentDocument(ctx, 'newer');
      await writeAnswerConflict({ tenantKey: ctx.key, conflict: conflictOf(older, newer) }, { rpc: serviceRpc(ctx.db), enqueueDeps: { enabled: () => false }, log: () => {} });
      const states = await rows(ctx.db, 'SELECT status, is_current, superseded_by FROM documents WHERE id = ANY($1::uuid[]) ORDER BY id', [[older, newer]]);
      assert.deepEqual(states, [
        { status: 'ready', is_current: true, superseded_by: null },
        { status: 'ready', is_current: true, superseded_by: null },
      ]);
      const linkRows = await rows(ctx.db, 'SELECT count(*)::int AS n FROM rag_supersession_links WHERE older_document_id = ANY($1::uuid[]) OR newer_document_id = ANY($1::uuid[])', [[older, newer]]);
      assert.equal(linkRows[0]?.n, 0);
    });

    it('one version_conflict review item names both documents when the expert queue is on', async () => {
      const older = await currentDocument(ctx, 'older');
      const newer = await currentDocument(ctx, 'newer');
      const rpc = serviceRpc(ctx.db);
      const out = await writeAnswerConflict(
        { tenantKey: ctx.key, conflict: conflictOf(older, newer), traceId: 'trace-conflict-1' },
        { rpc, enqueueDeps: { rpc, enabled: () => true, log: () => {} }, log: () => {} },
      );
      assert.ok(out.reviewItem, 'the review item id is returned');
      const item = (await rows(ctx.db, 'SELECT * FROM rag_review_items WHERE id = $1', [out.reviewItem]))[0]!;
      assert.equal(item.tenant_key, ctx.key);
      assert.deepEqual(item.reasons, ['version_conflict']);
      const text = JSON.stringify(item);
      assert.ok(text.includes(older) && text.includes(newer), 'both document ids are in the item');
    });

    it('a write failure is logged once with ids and never throws', async () => {
      const older = await currentDocument(ctx, 'older');
      const missing = crypto.randomUUID();
      const lines: Array<Record<string, unknown>> = [];
      const out = await writeAnswerConflict(
        { tenantKey: ctx.key, conflict: conflictOf(older, missing) },
        { rpc: serviceRpc(ctx.db), enqueueDeps: { enabled: () => false }, log: (_line, detail) => lines.push(detail) },
      );
      assert.equal(out.failed, 1);
      assert.deepEqual(lines, [{ documentId: missing, candidateDocumentId: older, reason: 'not_found' }]);
      assert.equal((await candidatesFor(ctx, older, missing)).length, 0);
    });

    if (mode === 'multi-tenant') {
      it("another tenant's key never raises a candidate for these documents", async () => {
        const older = await currentDocument(ctx, 'older');
        const newer = await currentDocument(ctx, 'newer');
        const lines: Array<Record<string, unknown>> = [];
        const out = await writeAnswerConflict(
          { tenantKey: ctx.otherKey!, conflict: conflictOf(older, newer) },
          { rpc: serviceRpc(ctx.db), enqueueDeps: { enabled: () => false }, log: (_line, detail) => lines.push(detail) },
        );
        assert.equal(out.raised, 0);
        assert.equal(lines.length, 1);
        assert.equal((await candidatesFor(ctx, older, newer)).length, 0);
      });
    }
  });
}
