import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * D-40 on the prechunked fixture: every earlier version of a fixture lineage is seeded the way rag_publish_document_version leaves a
 * superseded version, including the content hash the unified pipeline writes, so a non-current version scope reaches it through the
 * lexical leg. Without the hash both versions compare NULL to NULL, read as a re-publish of the same text, and the leg returns none.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const LEGACY = 'openai-3-small-1536';

type Row = Record<string, unknown>;

interface Lineage {
  tenantKey: string;
  oldId: string;
  newId: string;
  oldHash: string | null;
  newHash: string | null;
  tokens: string[];
}

async function lineages(db: PGlite): Promise<Lineage[]> {
  const rows = (
    await db.query<Row>(
      `SELECT d.tenant_key, d.id::text AS old_id, s.id::text AS new_id, d.content_hash AS old_hash, s.content_hash AS new_hash,
              (SELECT array_agg(t.word ORDER BY t.word) FROM (
                 SELECT DISTINCT unnest(tsvector_to_array(c.lexical_tsv)) AS word
                   FROM document_chunks c WHERE c.document_id = d.id AND c.lexical_tsv IS NOT NULL) t) AS tokens
         FROM documents d JOIN documents s ON s.id = d.superseded_by
        WHERE d.lineage_id IS NOT NULL AND NOT d.is_current
        ORDER BY d.id`,
    )
  ).rows;
  return rows.map((row) => ({
    tenantKey: String(row.tenant_key),
    oldId: String(row.old_id),
    newId: String(row.new_id),
    oldHash: (row.old_hash as string | null) ?? null,
    newHash: (row.new_hash as string | null) ?? null,
    tokens: ((row.tokens as string[] | null) ?? []).slice(0, 8),
  }));
}

async function lexicalHits(db: PGlite, lineage: Lineage, scope: unknown): Promise<Row[]> {
  const params: unknown[] = [lineage.tenantKey, LEGACY, `[${embedText('probe').join(',')}]`, lineage.tokens, [lineage.oldId, lineage.newId]];
  let extra = '';
  if (scope !== undefined) {
    params.push(JSON.stringify(scope));
    extra = `, p_version_scope => $${params.length}::jsonb`;
  }
  return (
    await db.query<Row>(
      `SELECT leg, chunk_id::text, document_id::text, is_current
         FROM hybrid_search_chunks(
           p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
           p_dense_limit => 0, p_lexical_limit => 100, p_document_ids => $5::uuid[]${extra}
         ) WHERE leg = 'lexical'`,
      params,
    )
  ).rows;
}

for (const mode of ['single-tenant', 'multi-tenant'] as const satisfies readonly DeploymentMode[]) {
  describe(`prechunked fixture lineages reach history (${mode})`, () => {
    let db: PGlite;
    let seeded: Lineage[];

    before(async () => {
      db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS })).db;
      seeded = await lineages(db);
    });
    after(async () => {
      await db?.close();
    });

    test('every superseded version carries a content hash that differs from its successor', () => {
      assert.ok(seeded.length > 0, 'the corpus declares at least one lineage');
      for (const lineage of seeded) {
        assert.ok(lineage.oldHash, `superseded ${lineage.oldId} has a content hash`);
        assert.ok(lineage.newHash, `successor ${lineage.newId} has a content hash`);
        assert.notEqual(lineage.oldHash, lineage.newHash);
      }
    });

    test('rag_version_history_ok admits every superseded version', async () => {
      for (const lineage of seeded) {
        const { rows } = await db.query<{ ok: boolean }>('SELECT public.rag_version_history_ok($1::uuid, $2) AS ok', [lineage.oldId, lineage.tenantKey]);
        assert.equal(rows[0]?.ok, true, `history admits ${lineage.oldId}`);
      }
    });

    test('scope all returns superseded chunks on the lexical leg; the current scope never does', async () => {
      for (const lineage of seeded) {
        assert.ok(lineage.tokens.length > 0, `superseded ${lineage.oldId} has lexical text`);
        const all = await lexicalHits(db, lineage, { mode: 'all' });
        assert.ok(
          all.some((row) => row.document_id === lineage.oldId && row.is_current === false),
          `scope all reaches superseded ${lineage.oldId}`,
        );
        const current = await lexicalHits(db, lineage, undefined);
        assert.ok(current.every((row) => row.is_current === true && row.document_id !== lineage.oldId));
      }
    });
  });
}
