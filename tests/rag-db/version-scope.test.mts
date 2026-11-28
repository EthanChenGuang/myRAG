import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

/**
 * 0856 version scope (D-12, D-40) and identifier filter (D-31, D-45) at the RPC, and 0855 rag_document_versions (D-44), in both
 * deployment modes. All text is synthetic and neutral.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const LEGACY = 'openai-3-small-1536';
const TOKEN = 'verscopeprobe';

type Leg = 'dense' | 'lexical';
type Row = Record<string, unknown>;

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

interface Ctx {
  mode: DeploymentMode;
  db: PGlite;
  key: string;
  userId: string | null;
  otherKey: string | null;
  otherUserId: string | null;
  wrongModeKey: string;
}

async function createCtx(mode: DeploymentMode): Promise<Ctx> {
  if (mode === 'single-tenant') {
    const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS });
    return { mode, db: fixture.db, key: 's:default', userId: null, otherKey: null, otherUserId: null, wrongModeKey: `u:${TWO_TENANT_IDS.userA}` };
  }
  const fixture = await createTwoTenantDatabase();
  return {
    mode,
    db: fixture.db,
    key: `u:${TWO_TENANT_IDS.userA}`,
    userId: TWO_TENANT_IDS.userA,
    otherKey: `u:${TWO_TENANT_IDS.userB}`,
    otherUserId: TWO_TENANT_IDS.userB,
    wrongModeKey: 's:default',
  };
}

interface VersionSpec {
  text: string;
  current: boolean;
  status?: string;
  provisional?: boolean;
  contentHash: string;
  createdAt: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  identifiers?: string[] | null;
}

interface Seeded {
  docIds: string[];
  chunkIds: string[];
}

/** One lineage, oldest version first; every version but the last points at its successor through superseded_by. */
async function seedLineage(ctx: Ctx, versions: VersionSpec[], tenant: { key: string; userId: string | null } = ctx): Promise<Seeded> {
  const lineage = crypto.randomUUID();
  const docIds = versions.map(() => crypto.randomUUID());
  const chunkIds = versions.map(() => crypto.randomUUID());
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const v = versions[i] as VersionSpec;
    const status = v.status ?? 'ready';
    const columns: [string, unknown, string?][] = [
      ['id', docIds[i]],
      ['filename', `lineage-${lineage.slice(0, 8)}-v${i + 1}.md`],
      ['content', v.text],
      ['lineage_id', lineage],
      ['version', i + 1],
      ['is_current', v.current],
      ['status', status],
      ['superseded_by', v.current ? null : docIds[i + 1]],
      ['provisional', v.provisional ?? false],
      ['content_hash', v.contentHash],
      ['created_at', v.createdAt, 'timestamptz'],
      ['effective_from', v.effectiveFrom ?? null, 'date'],
      ['effective_to', v.effectiveTo ?? null, 'date'],
      ...(tenant.userId ? [['user_id', tenant.userId] as [string, unknown]] : []),
    ];
    await ctx.db.query(
      `INSERT INTO documents (${columns.map(([name]) => name).join(', ')})
       VALUES (${columns.map(([, , cast], index) => (cast ? `$${index + 1}::${cast}` : `$${index + 1}`)).join(', ')})`,
      columns.map(([, value]) => value),
    );
    const chunkStatus = status === 'ready' ? 'ready' : status;
    await ctx.db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, chunk_index, identifiers_norm, provisional)
       VALUES ($1, $2, $3, $4::vector, $3, $5, $6, $7, 0, $8::text[], $9)`,
      [chunkIds[i], docIds[i], v.text, v.current ? vec(v.text) : null, tenant.key, v.current, chunkStatus, v.identifiers ?? null, v.provisional ?? false],
    );
  }
  return { docIds, chunkIds };
}

interface SearchCall {
  key: string;
  scope?: unknown;
  identifiers?: string[] | null;
  documentIds?: string[] | null;
  tokens?: string[];
}

async function search(db: PGlite, call: SearchCall): Promise<Row[]> {
  const extra: string[] = [];
  const params: unknown[] = [call.key, LEGACY, vec(`${TOKEN} query`), call.tokens ?? [TOKEN], call.documentIds ?? null];
  if (call.scope !== undefined) {
    params.push(call.scope === null ? null : JSON.stringify(call.scope));
    extra.push(`, p_version_scope => $${params.length}::jsonb`);
  }
  if (call.identifiers !== undefined) {
    params.push(call.identifiers);
    extra.push(`, p_identifiers_norm => $${params.length}::text[]`);
  }
  return (
    await db.query<Row>(
      `SELECT leg, rank, chunk_id::text, document_id::text, dup_cluster_id::text, is_current, document_version
       FROM hybrid_search_chunks(
         p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
         p_dense_limit => 100, p_lexical_limit => 100, p_document_ids => $5::uuid[]${extra.join('')}
       ) ORDER BY leg, rank`,
      params,
    )
  ).rows;
}

function ids(rows: Row[], leg: Leg): Set<string> {
  return new Set(rows.filter((row) => row.leg === leg).map((row) => String(row.chunk_id)));
}

const D = (n: number): string => `hash-${n}-${crypto.randomUUID()}`;

for (const mode of ['single-tenant', 'multi-tenant'] as DeploymentMode[]) {
  describe(`hybrid_search_chunks version scope and identifier filter (0856, ${mode})`, () => {
    let ctx: Ctx;
    let changed: Seeded;
    let provisional: Seeded;
    let identical: Seeded;
    let quarantined: Seeded;
    let deletedEarlier: Seeded;
    let deletedCurrent: Seeded;
    let other: Seeded | null = null;
    let scopeDocs: string[];

    before(async () => {
      ctx = await createCtx(mode);
      changed = await seedLineage(ctx, [
        { text: `${TOKEN} first wording of the sample notice`, current: false, contentHash: D(1), createdAt: '2024-01-10T00:00:00Z', identifiers: ['idx-0001'] },
        { text: `${TOKEN} second wording of the sample notice`, current: true, contentHash: D(2), createdAt: '2024-06-01T00:00:00Z', identifiers: ['idx-0002'] },
      ]);
      provisional = await seedLineage(ctx, [
        { text: `${TOKEN} fast draft of a sample page`, current: false, provisional: true, contentHash: D(3), createdAt: '2024-01-10T00:00:00Z' },
        { text: `${TOKEN} full text of a sample page`, current: true, contentHash: D(4), createdAt: '2024-01-11T00:00:00Z' },
      ]);
      const same = D(5);
      identical = await seedLineage(ctx, [
        { text: `${TOKEN} unchanged sample paragraph`, current: false, contentHash: same, createdAt: '2024-01-10T00:00:00Z' },
        { text: `${TOKEN} unchanged sample paragraph`, current: true, contentHash: same, createdAt: '2024-02-10T00:00:00Z' },
      ]);
      quarantined = await seedLineage(ctx, [
        { text: `${TOKEN} withheld earlier sample text`, current: false, status: 'quarantined', contentHash: D(6), createdAt: '2024-01-10T00:00:00Z' },
        { text: `${TOKEN} released later sample text`, current: true, contentHash: D(7), createdAt: '2024-02-10T00:00:00Z' },
      ]);
      deletedEarlier = await seedLineage(ctx, [
        { text: `${TOKEN} removed earlier sample text`, current: false, status: 'deleted', contentHash: D(8), createdAt: '2024-01-10T00:00:00Z' },
        { text: `${TOKEN} kept later sample text`, current: true, contentHash: D(9), createdAt: '2024-02-10T00:00:00Z' },
      ]);
      deletedCurrent = await seedLineage(ctx, [
        { text: `${TOKEN} removed only sample text`, current: true, status: 'deleted', contentHash: D(10), createdAt: '2024-01-10T00:00:00Z' },
      ]);
      if (ctx.otherKey) {
        other = await seedLineage(
          ctx,
          [
            { text: `${TOKEN} other tenant first sample`, current: false, contentHash: D(11), createdAt: '2024-01-10T00:00:00Z', identifiers: ['idx-0001'] },
            { text: `${TOKEN} other tenant second sample`, current: true, contentHash: D(12), createdAt: '2024-06-01T00:00:00Z', identifiers: ['idx-0001'] },
          ],
          { key: ctx.otherKey, userId: ctx.otherUserId },
        );
      }
      scopeDocs = [changed, provisional, identical, quarantined, deletedEarlier, deletedCurrent].flatMap((s) => s.docIds);
    });

    after(async () => {
      await ctx?.db.close();
    });

    const currentChunks = (): string[] =>
      [changed, provisional, identical, quarantined, deletedEarlier].map((s) => s.chunkIds[s.chunkIds.length - 1] as string);

    test('scope null and {"mode":"current"} return current rows only, on both legs', async () => {
      const base = await search(ctx.db, { key: ctx.key, documentIds: scopeDocs });
      for (const scope of [null, { mode: 'current' }]) {
        const rows = await search(ctx.db, { key: ctx.key, documentIds: scopeDocs, scope });
        assert.deepEqual(rows, base, JSON.stringify(scope));
      }
      assert.deepEqual(ids(base, 'lexical'), new Set(currentChunks()));
      assert.deepEqual(ids(base, 'dense'), new Set(currentChunks()));
      assert.ok(base.every((row) => row.is_current === true));
    });

    test('scope all adds the changed superseded version on the lexical leg only', async () => {
      const rows = await search(ctx.db, { key: ctx.key, documentIds: scopeDocs, scope: { mode: 'all' } });
      assert.deepEqual(ids(rows, 'lexical'), new Set([...currentChunks(), changed.chunkIds[0] as string]));
      assert.deepEqual(ids(rows, 'dense'), new Set(currentChunks()), 'the dense leg never returns a superseded row');
      const old = rows.find((row) => row.chunk_id === changed.chunkIds[0]);
      assert.equal(old?.is_current, false);
      assert.equal(old?.document_version, 1);
      for (const excluded of [provisional, identical, quarantined, deletedEarlier]) {
        assert.ok(!ids(rows, 'lexical').has(excluded.chunkIds[0] as string));
      }
      assert.ok(!ids(rows, 'lexical').has(deletedCurrent.chunkIds[0] as string));
    });

    test('a range returns only versions whose period overlaps it', async () => {
      const [v1, v2] = changed.chunkIds as [string, string];
      const lex = async (from: string | null, to: string | null): Promise<Set<string>> => {
        const scope: Record<string, string> = { mode: 'range' };
        if (from) scope.from = from;
        if (to) scope.to = to;
        const got = ids(await search(ctx.db, { key: ctx.key, documentIds: changed.docIds, scope }), 'lexical');
        return got;
      };
      assert.deepEqual(await lex('2024-02-01', '2024-03-01'), new Set([v1]));
      assert.deepEqual(await lex('2024-07-01', null), new Set([v2]));
      assert.deepEqual(await lex('2024-05-01', '2024-07-01'), new Set([v1, v2]));
      assert.deepEqual(await lex('2024-06-01', '2024-06-01'), new Set([v2]), 'the successor start ends the earlier period');
      assert.deepEqual(await lex(null, '2023-12-31'), new Set());
      const dense = ids(await search(ctx.db, { key: ctx.key, documentIds: changed.docIds, scope: { mode: 'range', from: '2024-02-01', to: '2024-03-01' } }), 'dense');
      assert.deepEqual(dense, new Set(), 'the dense leg keeps current rows only and the current period starts later');
    });

    test('effective dates set the period when present', async () => {
      await ctx.db.query("UPDATE documents SET effective_from = '2023-01-01', effective_to = '2023-03-31' WHERE id = $1", [changed.docIds[0]]);
      try {
        const scope = { mode: 'range', from: '2023-02-01', to: '2023-02-28' };
        assert.deepEqual(ids(await search(ctx.db, { key: ctx.key, documentIds: changed.docIds, scope }), 'lexical'), new Set([changed.chunkIds[0]]));
        const later = { mode: 'range', from: '2024-02-01', to: '2024-03-01' };
        assert.deepEqual(ids(await search(ctx.db, { key: ctx.key, documentIds: changed.docIds, scope: later }), 'lexical'), new Set());
      } finally {
        await ctx.db.query('UPDATE documents SET effective_from = NULL, effective_to = NULL WHERE id = $1', [changed.docIds[0]]);
      }
    });

    test('an invalid scope raises 22023', async () => {
      for (const scope of [
        [],
        'all',
        { mode: 'every' },
        { mode: 'range', from: 'not-a-date' },
        { mode: 'range', from: '2024-05-01', to: '2024-01-01' },
        { mode: 'range', from: 20240101 },
        { mode: 'all', extra: true },
      ]) {
        await assert.rejects(
          () => search(ctx.db, { key: ctx.key, scope }),
          (error: unknown) => codeOf(error) === '22023',
          JSON.stringify(scope),
        );
      }
    });

    test('p_identifiers_norm keeps only chunks that carry the identifier, on both legs, and combines with other filters', async () => {
      const one = await search(ctx.db, { key: ctx.key, identifiers: ['idx-0002'] });
      assert.deepEqual(ids(one, 'lexical'), new Set([changed.chunkIds[1]]));
      assert.deepEqual(ids(one, 'dense'), new Set([changed.chunkIds[1]]));
      assert.equal((await search(ctx.db, { key: ctx.key, identifiers: ['idx-none'] })).length, 0);
      assert.equal((await search(ctx.db, { key: ctx.key, identifiers: [] })).length, 0);
      assert.equal((await search(ctx.db, { key: ctx.key, identifiers: ['idx-0002'], documentIds: provisional.docIds })).length, 0);
      const history = await search(ctx.db, { key: ctx.key, identifiers: ['idx-0001'], scope: { mode: 'all' } });
      assert.deepEqual(ids(history, 'lexical'), new Set([changed.chunkIds[0]]));
      assert.deepEqual(ids(history, 'dense'), new Set());
      assert.equal((await search(ctx.db, { key: ctx.key, identifiers: null })).length, (await search(ctx.db, { key: ctx.key })).length);
    });

    test('hits carry dup_cluster_id, is_current and the document version', async () => {
      const cluster = crypto.randomUUID();
      await ctx.db.query(
        `INSERT INTO rag_dup_clusters (id, tenant_key, embedding_profile_id, representative_chunk_id, member_count)
         VALUES ($1, $2, $3, $4::uuid, 1)`,
        [cluster, ctx.key, LEGACY, changed.chunkIds[1]],
      );
      await ctx.db.query('UPDATE document_chunks SET dup_cluster_id = $1 WHERE id = $2', [cluster, changed.chunkIds[1]]);
      const rows = await search(ctx.db, { key: ctx.key, documentIds: changed.docIds });
      assert.ok(rows.length >= 2);
      for (const row of rows) {
        assert.equal(row.dup_cluster_id, cluster);
        assert.equal(row.is_current, true);
        assert.equal(row.document_version, 2);
      }
    });

    test('a tenant key of the other deployment mode is rejected with the new parameters set', async () => {
      await assert.rejects(
        () => search(ctx.db, { key: ctx.wrongModeKey, scope: { mode: 'all' }, identifiers: ['idx-0001'] }),
        (error: unknown) => codeOf(error) === '22023',
      );
    });

    if (mode === 'multi-tenant') {
      test('with scope all a tenant never receives another tenant superseded or current chunk', async () => {
        const foreign = new Set(other?.chunkIds ?? []);
        for (const call of [{ scope: { mode: 'all' } }, { scope: { mode: 'range', from: '2000-01-01' } }, { identifiers: ['idx-0001'], scope: { mode: 'all' } }]) {
          const rows = await search(ctx.db, { key: ctx.key, ...call });
          assert.ok(!rows.some((row) => foreign.has(String(row.chunk_id))), JSON.stringify(call));
        }
        const theirs = await search(ctx.db, { key: ctx.otherKey as string, scope: { mode: 'all' } });
        assert.deepEqual(ids(theirs, 'lexical'), new Set(other?.chunkIds));
      });
    }

    test('rag_exact_id_documents takes the version scope and the identifier filter', async () => {
      const exact = async (scope: unknown, identifiers?: string[] | null): Promise<Set<string>> => {
        const params: unknown[] = [ctx.key, [TOKEN], 100];
        let extra = '';
        if (scope !== undefined) {
          params.push(scope === null ? null : JSON.stringify(scope));
          extra += `, p_version_scope => $${params.length}::jsonb`;
        }
        if (identifiers !== undefined) {
          params.push(identifiers);
          extra += `, p_identifiers_norm => $${params.length}::text[]`;
        }
        const rows = await ctx.db.query<Row>(
          `SELECT chunk_id::text FROM rag_exact_id_documents(p_tenant_key => $1, p_tokens => $2::text[], p_limit => $3${extra})`,
          params,
        );
        return new Set(rows.rows.map((row) => String(row.chunk_id)));
      };
      const base = await exact(undefined);
      assert.deepEqual(await exact(null), base);
      assert.deepEqual(await exact({ mode: 'current' }), base);
      assert.ok(!base.has(changed.chunkIds[0] as string));
      const all = await exact({ mode: 'all' });
      assert.ok(all.has(changed.chunkIds[0] as string));
      for (const excluded of [provisional, identical, quarantined, deletedEarlier]) assert.ok(!all.has(excluded.chunkIds[0] as string));
      assert.deepEqual(await exact({ mode: 'range', from: '2024-02-01', to: '2024-03-01' }, ['idx-0001']), new Set([changed.chunkIds[0]]));
      assert.deepEqual(await exact(undefined, ['idx-0002']), new Set([changed.chunkIds[1]]));
      assert.deepEqual(await exact(undefined, ['idx-none']), new Set());
      await assert.rejects(() => exact({ mode: 'nope' }), (error: unknown) => codeOf(error) === '22023');
      if (other) for (const id of other.chunkIds) assert.ok(!all.has(id));
    });

    test('rag_document_versions returns version, currency and effective dates of the tenant documents only', async () => {
      await ctx.db.query("UPDATE documents SET effective_from = '2024-06-01' WHERE id = $1", [changed.docIds[1]]);
      const requested = [...changed.docIds, ...(other?.docIds ?? []), crypto.randomUUID()];
      const rows = (
        await ctx.db.query<Row>(
          'SELECT document_id::text, version, is_current, effective_from::text, effective_to::text FROM rag_document_versions($1, $2::uuid[])',
          [ctx.key, requested],
        )
      ).rows;
      assert.deepEqual(rows, [
        { document_id: changed.docIds[0], version: 1, is_current: false, effective_from: null, effective_to: null },
        { document_id: changed.docIds[1], version: 2, is_current: true, effective_from: '2024-06-01', effective_to: null },
      ].sort((a, b) => String(a.document_id).localeCompare(String(b.document_id))));
      assert.equal((await ctx.db.query('SELECT * FROM rag_document_versions($1, $2::uuid[])', [ctx.key, []])).rows.length, 0);
      const tooMany = Array.from({ length: 501 }, () => crypto.randomUUID());
      await assert.rejects(
        () => ctx.db.query('SELECT * FROM rag_document_versions($1, $2::uuid[])', [ctx.key, tooMany]),
        (error: unknown) => codeOf(error) === '22023',
      );
      await assert.rejects(
        () => ctx.db.query('SELECT * FROM rag_document_versions($1, $2::uuid[])', [ctx.wrongModeKey, changed.docIds]),
        (error: unknown) => codeOf(error) === '22023',
      );
    });

    // Destructive: runs last. The period expression is built at call time, so a database without the effective-date columns still works.
    test('the range scope works on a database without the effective-date columns', async () => {
      await ctx.db.query('ALTER TABLE documents DROP COLUMN effective_from CASCADE, DROP COLUMN effective_to CASCADE');
      const lex = async (scope: Record<string, string>) => ids(await search(ctx.db, { key: ctx.key, documentIds: changed.docIds, scope }), 'lexical');
      assert.deepEqual(await lex({ mode: 'range', from: '2024-02-01', to: '2024-03-01' }), new Set([changed.chunkIds[0]]));
      assert.deepEqual(await lex({ mode: 'range', from: '2024-07-01' }), new Set([changed.chunkIds[1]]));
      const versions = (await ctx.db.query<Row>('SELECT effective_from, effective_to FROM rag_document_versions($1, $2::uuid[])', [ctx.key, changed.docIds])).rows;
      assert.equal(versions.length, 2);
      assert.ok(versions.every((row) => row.effective_from === null && row.effective_to === null));
    });
  });
}
