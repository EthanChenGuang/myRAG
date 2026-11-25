import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

async function hybridIds(
  db: PGlite,
  tenantKey: string,
  leg: 'dense' | 'lexical',
  tokens: string[] = ['canary'],
): Promise<string[]> {
  const col = leg === 'dense' ? 'p_dense_limit' : 'p_lexical_limit';
  const other = leg === 'dense' ? 'p_lexical_limit' : 'p_dense_limit';
  const result = await db.query<{ chunk_id: string }>(
    `SELECT chunk_id::text FROM hybrid_search_chunks(
       p_tenant_key => $1, p_profile_id => $2,
       p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
       p_dense_limit => $5, p_lexical_limit => $6
     ) WHERE leg = $7 ORDER BY rank`,
    [tenantKey, LEGACY, vec('two tenant isolation canary phrase'), tokens, leg === 'dense' ? 50 : 0, leg === 'lexical' ? 50 : 0, leg],
  );
  return result.rows.map((row) => row.chunk_id);
}

async function workspaceChunkIds(db: PGlite, orgId: string | null, userId: string, count = 1000): Promise<Set<string>> {
  const docs = await db.query<{ document_id: string }>(
    'SELECT document_id::text FROM match_documents_by_workspace($1::vector, $2, -1, $3::uuid, $4::uuid)',
    [vec('two tenant isolation canary phrase'), count, orgId, userId],
  );
  const ids = docs.rows.map((row) => row.document_id);
  if (ids.length === 0) return new Set();
  const rows = await db.query<{ chunk_id: string }>(
    `SELECT id::text AS chunk_id FROM document_chunks
     WHERE document_id = ANY($1::uuid[]) AND is_current AND status IN ('ready', 'variant')`,
    [ids],
  );
  return new Set(rows.rows.map((row) => row.chunk_id));
}

describe('hybrid_search_chunks two-tenant isolation', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
    for (const [id, marker] of [
      [TWO_TENANT_IDS.chunkA, 'alpha'],
      [TWO_TENANT_IDS.chunkB, 'bravo'],
      [TWO_TENANT_IDS.chunkO, 'organization'],
    ] as const) {
      await db.query(`UPDATE document_chunks SET lexical_text = $2 WHERE id = $1`, [
        id,
        `two tenant isolation canary phrase xr-2000 xr2000 ${marker}`,
      ]);
    }
  });

  after(async () => {
    await db.close();
  });

  const scopes = [
    { label: 'personal A', tenant: `u:${TWO_TENANT_IDS.userA}`, org: null, user: TWO_TENANT_IDS.userA, own: TWO_TENANT_IDS.chunkA },
    { label: 'personal B', tenant: `u:${TWO_TENANT_IDS.userB}`, org: null, user: TWO_TENANT_IDS.userB, own: TWO_TENANT_IDS.chunkB },
    { label: 'org O', tenant: `o:${TWO_TENANT_IDS.orgO}`, org: TWO_TENANT_IDS.orgO, user: TWO_TENANT_IDS.userA, own: TWO_TENANT_IDS.chunkO },
  ];

  for (const scope of scopes) {
    for (const leg of ['dense', 'lexical'] as const) {
      test(`${scope.label} ${leg} leg is a subset of match_documents_by_workspace and never crosses canaries`, async () => {
        const allowed = await workspaceChunkIds(db, scope.org, scope.user);
        const got = await hybridIds(db, scope.tenant, leg);
        assert.ok(got.every((id) => allowed.has(id)), `${scope.label} ${leg}`);
        assert.ok(got.includes(scope.own));
        const foreign: string[] = scopes.filter((s) => s.tenant !== scope.tenant).map((s) => s.own);
        assert.ok(got.every((id) => !foreign.includes(id)));
      });
    }
  }

  test('superseded, quarantined and inactive variant profile rows are absent', async () => {
    const hidden = crypto.randomUUID();
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata, status, is_current, tenant_key, lexical_text, chunking_profile_id)
       VALUES ($1, $2, 'hidden', 99, '{}'::jsonb, 'quarantined', true, $3, 'canary hidden', 'legacy')`,
      [hidden, TWO_TENANT_IDS.docA, `u:${TWO_TENANT_IDS.userA}`],
    );
    const superseded = crypto.randomUUID();
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata, status, is_current, tenant_key, lexical_text, chunking_profile_id)
       VALUES ($1, $2, 'hidden', 98, '{}'::jsonb, 'ready', false, $3, 'canary hidden', 'legacy')`,
      [superseded, TWO_TENANT_IDS.docA, `u:${TWO_TENANT_IDS.userA}`],
    );
    const variant = crypto.randomUUID();
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata, status, is_current, tenant_key, lexical_text, chunking_profile_id, embedding)
       VALUES ($1, $2, 'variant inactive', 97, '{}'::jsonb, 'variant', true, $3, 'canary variant', 'p256', $4::vector)`,
      [variant, TWO_TENANT_IDS.docA, `u:${TWO_TENANT_IDS.userA}`, vec('canary variant')],
    );
    const dense = await hybridIds(db, `u:${TWO_TENANT_IDS.userA}`, 'dense');
    const lexical = await hybridIds(db, `u:${TWO_TENANT_IDS.userA}`, 'lexical');
    for (const id of [hidden, superseded, variant]) {
      assert.ok(!dense.includes(id));
      assert.ok(!lexical.includes(id));
    }
  });

  test('legacy fallback stays inside the tenant', async () => {
    await db.query(`UPDATE chunking_profiles SET status = 'retired' WHERE doc_type = 'contract_legal' AND id = 'legacy'`);
    await db.query(
      `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
       VALUES ('p256', 'contract_legal', 256, 'none', NULL, 'active', '256/1024')
       ON CONFLICT (id, doc_type) DO UPDATE SET status = 'active'`,
    );

    const docA = crypto.randomUUID();
    const docB = crypto.randomUUID();
    const legacyA = crypto.randomUUID();
    const legacyB = crypto.randomUUID();
    const childB = crypto.randomUUID();
    const bodyA = 'tenant-a-only zz-cross-contract-a';
    const bodyB = 'tenant-b-only zz-cross-contract-b';
    await db.query(
      'INSERT INTO documents (id, filename, content, user_id, is_current, status, doc_type) VALUES ($1, $2, $3, $4, true, $5, $6)',
      [docA, 'contract-a.md', bodyA, TWO_TENANT_IDS.userA, 'ready', 'contract_legal'],
    );
    await db.query(
      'INSERT INTO documents (id, filename, content, user_id, is_current, status, doc_type) VALUES ($1, $2, $3, $4, true, $5, $6)',
      [docB, 'contract-b.md', bodyB, TWO_TENANT_IDS.userB, 'ready', 'contract_legal'],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, doc_type, is_current, status, chunking_profile_id, chunk_index)
       VALUES ($1, $2, $3, $4::vector, $3, $5, 'contract_legal', true, $6, $7, 0)`,
      [legacyA, docA, bodyA, vec(bodyA), `u:${TWO_TENANT_IDS.userA}`, 'ready', 'legacy'],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, doc_type, is_current, status, chunking_profile_id, chunk_index)
       VALUES ($1, $2, $3, $4::vector, $3, $5, 'contract_legal', true, $6, $7, 0)`,
      [legacyB, docB, bodyB, vec(bodyB), `u:${TWO_TENANT_IDS.userB}`, 'ready', 'legacy'],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, doc_type, is_current, status, chunking_profile_id, chunk_index)
       VALUES ($1, $2, $3, $4::vector, $3, $5, 'contract_legal', true, $6, $7, 0)`,
      [childB, docB, bodyB, vec(bodyB), `u:${TWO_TENANT_IDS.userB}`, 'variant', 'p256'],
    );

    const rowsA = await hybridIds(db, `u:${TWO_TENANT_IDS.userA}`, 'lexical', ['zz-cross-contract-a']);
    const rowsB = await hybridIds(db, `u:${TWO_TENANT_IDS.userB}`, 'lexical', ['zz-cross-contract-b']);
    assert.ok(rowsA.includes(legacyA), `tenant A legacy fallback: ${rowsA.join(',')}`);
    assert.ok(!rowsA.includes(legacyB) && !rowsA.includes(childB));
    assert.ok(rowsB.includes(childB), `tenant B p256 child: ${rowsB.join(',')}`);
    assert.ok(!rowsB.includes(legacyA) && !rowsB.includes(legacyB));
  });

  test('malformed or wrong-mode tenant keys raise 22023 in multi-tenant mode', async () => {
    const cases = [
      `u:${TWO_TENANT_IDS.userA}' OR '1'='1`,
      's:default',
      `u:${TWO_TENANT_IDS.userA.toUpperCase()}`,
      null,
    ];
    for (const key of cases) {
      await assert.rejects(
        () =>
          db.query('SELECT 1 FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[], p_dense_limit => 1, p_lexical_limit => 0)', [
            key,
            LEGACY,
            vec('x'),
            [],
          ]),
        (error: unknown) => codeOf(error) === '22023',
      );
    }
  });
});

for (const mode of ['single-tenant', 'multi-tenant'] as DeploymentMode[]) {
  describe(`hybrid tenant key mode guard (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      if (mode === 'single-tenant') {
        const fx = await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseGrants: true });
        db = fx.db;
      } else {
        const fx = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
        db = fx.db;
      }
    });

    after(async () => {
      await db.close();
    });

    test(mode === 'single-tenant' ? 'u:uuid raises and s:default succeeds' : 's:default raises in multi-tenant', async () => {
      if (mode === 'single-tenant') {
        await assert.rejects(
          () =>
            db.query(
              'SELECT 1 FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[], p_dense_limit => 1, p_lexical_limit => 0)',
              [`u:${FIXTURE_USER_ID}`, LEGACY, vec('x'), []],
            ),
          (error: unknown) => codeOf(error) === '22023',
        );
        await db.query(
          'SELECT 1 FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[], p_dense_limit => 1, p_lexical_limit => 0) LIMIT 1',
          ['s:default', LEGACY, vec('x'), []],
        );
      } else {
        await assert.rejects(
          () =>
            db.query(
              'SELECT 1 FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[], p_dense_limit => 1, p_lexical_limit => 0)',
              ['s:default', LEGACY, vec('x'), []],
            ),
          (error: unknown) => codeOf(error) === '22023',
        );
      }
    });
  });
}