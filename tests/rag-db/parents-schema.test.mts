import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import {
  createEmptyFixtureDatabase,
  createFixtureDatabase,
  type DeploymentMode,
  type FixtureDatabase,
} from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const DOC_TYPES = [
  'financial_report',
  'contract_legal',
  'invoice_receipt',
  'product_technical',
  'scanned_image',
  'general',
] as const;

const VALID_UUID = '00000000-0000-4000-8000-0000000000a1';
const KEY_A = `u:${TWO_TENANT_IDS.userA}`;
const KEY_B = `u:${TWO_TENANT_IDS.userB}`;

type Role = 'anon' | 'authenticated' | 'service_role';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

async function tryQuery(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query(
    "SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)",
    [userId ?? '', role],
  );
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)");
  }
}

async function assertTenantKey(
  db: PGlite,
  key: string | null,
  expect: 'pass' | 'malformed' | 'mode',
): Promise<void> {
  const error = await tryQuery(db, 'SELECT rag_assert_tenant_key($1)', [key]);
  if (expect === 'pass') {
    assert.equal(error, null, `expected ${String(key)} to pass: ${error}`);
    return;
  }
  assert.ok(error, `expected ${String(key)} to raise`);
  assert.match(error ?? '', expect === 'malformed' ? /malformed tenant key/ : /tenant key not valid for this deployment mode/);
}

async function relfilenode(db: PGlite): Promise<number> {
  const result = await db.query<{ relfilenode: number }>(
    `SELECT c.relfilenode::int AS relfilenode FROM pg_class c WHERE c.oid = 'public.document_chunks'::regclass`,
  );
  return Number(result.rows[0]?.relfilenode);
}

async function functionPrivileges(db: PGlite, name: string): Promise<{ anon: boolean; authenticated: boolean; service: boolean }> {
  const result = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
    `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
     FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
    [name],
  );
  return result.rows[0] ?? { anon: true, authenticated: true, service: false };
}

for (const mode of MODES) {
  describe(`rag_assert_tenant_key (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true });
    });

    after(async () => {
      await fixture.db.close();
    });

    test('accepts and refuses keys per deployment mode', async () => {
      const { db } = fixture;
      const lowerU = `u:${VALID_UUID}`;
      const lowerO = `o:${VALID_UUID}`;
      const upperU = `u:${VALID_UUID.toUpperCase()}`;
      const injection = `u:${VALID_UUID}' OR '1'='1`;

      if (mode === 'multi-tenant') {
        await assertTenantKey(db, lowerU, 'pass');
        await assertTenantKey(db, lowerO, 'pass');
        await assertTenantKey(db, null, 'malformed');
        await assertTenantKey(db, 's:default', 'mode');
        await assertTenantKey(db, upperU, 'malformed');
        await assertTenantKey(db, injection, 'malformed');
        await assertTenantKey(db, "' OR true --", 'malformed');
      } else {
        await assertTenantKey(db, 's:default', 'pass');
        await assertTenantKey(db, null, 'malformed');
        await assertTenantKey(db, lowerU, 'mode');
        await assertTenantKey(db, lowerO, 'mode');
        await assertTenantKey(db, upperU, 'malformed');
      }
    });

    test('is executable by service_role only', async () => {
      const priv = await functionPrivileges(fixture.db, 'rag_assert_tenant_key');
      assert.deepEqual(priv, { anon: false, authenticated: false, service: true });
    });
  });
}

for (const mode of MODES) {
  describe(`document_parents schema (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true });
    });

    after(async () => {
      await fixture.db.close();
    });

    test('adds parent columns without rewriting document_chunks', async () => {
      const empty = await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseGrants: true, migrations: false });
      const files = migrationFiles(mode).filter((file) => !file.includes('0404_document_parents'));
      await applyMigrationFiles(empty.db, files);
      const beforeNode = await relfilenode(empty.db);
      const bump = migrationFiles(mode).filter((file) => file.includes('0404_document_parents'));
      await applyMigrationFiles(empty.db, bump);
      const afterNode = await relfilenode(empty.db);
      assert.equal(beforeNode, afterNode, 'document_chunks heap relfilenode must stay the same');

      const chunks = await empty.db.query<{ parent_id: string | null; chunking_profile_id: string }>(
        'SELECT parent_id, chunking_profile_id FROM document_chunks LIMIT 5',
      );
      for (const row of chunks.rows) {
        assert.equal(row.parent_id, null);
        assert.equal(row.chunking_profile_id, 'legacy');
      }
      await empty.db.close();
    });

    test('stores variant chunks when profile is not legacy', async () => {
      const { db } = fixture;
      const chunkId = '00000000-0000-4000-8000-00000000c001';
      const docId = '00000000-0000-4000-8000-00000000d001';
      if (mode === 'multi-tenant') {
        await db.query(
          'INSERT INTO documents (id, filename, content, metadata, user_id) VALUES ($1, $2, $3, $4::jsonb, $5)',
          [docId, 'variant-doc.md', 'body', '{}', TWO_TENANT_IDS.userA],
        );
      } else {
        await db.query('INSERT INTO documents (id, filename, content, metadata) VALUES ($1, $2, $3, $4::jsonb)', [
          docId,
          'variant-doc.md',
          'body',
          '{}',
        ]);
      }
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, chunking_profile_id, status)
         VALUES ($1, $2, $3, $4::vector, 0, '{}'::jsonb, 'p256', 'ready')`,
        [chunkId, docId, 'variant child', vectorLiteral(embedText('variant child'))],
      );
      const row = await db.query<{ status: string }>('SELECT status FROM document_chunks WHERE id = $1', [chunkId]);
      assert.equal(row.rows[0]?.status, 'variant');
      const backToReady = await tryQuery(db, 'UPDATE document_chunks SET status = $1 WHERE id = $2', ['ready', chunkId]);
      assert.equal(backToReady, null);
      const after = await db.query<{ status: string }>('SELECT status FROM document_chunks WHERE id = $1', [chunkId]);
      assert.equal(after.rows[0]?.status, 'variant');
      const quarantine = await tryQuery(db, 'UPDATE document_chunks SET status = $1 WHERE id = $2', ['quarantined', chunkId]);
      assert.equal(quarantine, null);

      const legacyId = '00000000-0000-4000-8000-00000000c002';
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, chunking_profile_id, status)
         VALUES ($1, $2, $3, $4::vector, 1, '{}'::jsonb, 'legacy', 'ready')`,
        [legacyId, docId, 'legacy child', vectorLiteral(embedText('legacy child'))],
      );
      const legacy = await db.query<{ status: string }>('SELECT status FROM document_chunks WHERE id = $1', [legacyId]);
      assert.equal(legacy.rows[0]?.status, 'ready');
    });

    test('legacy retrieval RPCs never return a variant chunk', async () => {
      const two = await createTwoTenantDatabase();
      const { db } = two;
      const variantId = '00000000-0000-4000-8000-00000000c0aa';
      const query = embedText('Two tenant isolation canary phrase: alpha personal notes');
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, chunking_profile_id, status)
         VALUES ($1, $2, $3, $4::vector, 99, '{}'::jsonb, 'p256', 'ready')`,
        [
          variantId,
          TWO_TENANT_IDS.docA,
          'Document: tenant-a-personal.md. Chunk 99. Content: variant sidecar',
          vectorLiteral(query),
        ],
      );

      if (mode === 'multi-tenant') {
        const hits = await db.query<{ chunk_id: string }>(
          'SELECT dc.id AS chunk_id FROM match_documents_by_workspace($1::vector, 100, -1, NULL::uuid, $2::uuid) m JOIN document_chunks dc ON dc.document_id = m.document_id WHERE dc.id = $3',
          [vectorLiteral(query), TWO_TENANT_IDS.userA, variantId],
        );
        assert.equal(hits.rows.length, 0);
      } else {
        const hits = await db.query<{ chunk_id: string }>(
          'SELECT chunk_id FROM match_document_chunks($1::vector, -1, 100) WHERE chunk_id = $2',
          [vectorLiteral(query), variantId],
        );
        assert.equal(hits.rows.length, 0);
      }
      await db.close();
    });
  });
}

describe('document_parents RLS (multi-tenant)', () => {
  let two: TwoTenantDatabase;

  before(async () => {
    two = await createTwoTenantDatabase();
  });

  after(async () => {
    await two.db.close();
  });

  test('tenant A sees only A parents; B cannot read or write parents', async () => {
    const { db } = two;
    const parentA = '00000000-0000-4000-8000-00000000p0a1';
    const parentB = '00000000-0000-4000-8000-00000000p0b1';
    await db.query(
      `INSERT INTO document_parents (id, document_id, tenant_key, version, is_current, chunking_profile_id, section_path, content, token_count, parent_index, organization_id)
       VALUES ($1, $2, $3, 1, true, 'legacy', '{}', 'parent A', 10, 0, NULL),
              ($4, $5, $6, 1, true, 'legacy', '{}', 'parent B', 10, 0, NULL)`,
      [parentA, TWO_TENANT_IDS.docA, KEY_A, parentB, TWO_TENANT_IDS.docB, KEY_B],
    );

    const visibleA = await asRole(db, 'authenticated', TWO_TENANT_IDS.userA, () =>
      db.query<{ id: string }>('SELECT id FROM document_parents ORDER BY id'),
    );
    assert.deepEqual(
      visibleA.rows.map((row) => row.id).sort(),
      [parentA],
    );

    const visibleB = await asRole(db, 'authenticated', TWO_TENANT_IDS.userB, () =>
      db.query<{ id: string }>('SELECT id FROM document_parents ORDER BY id'),
    );
    assert.deepEqual(visibleB.rows.map((row) => row.id).sort(), [parentB]);

    await assert.rejects(
      () =>
        asRole(db, 'authenticated', TWO_TENANT_IDS.userA, () =>
          db.query('INSERT INTO document_parents (document_id, tenant_key, content, token_count, parent_index) VALUES ($1, $2, $3, 1, 0)', [
            TWO_TENANT_IDS.docA,
            KEY_A,
            'tamper',
          ]),
        ),
      /permission denied|42501/,
    );
  });
});

describe('rag_fetch_parents (multi-tenant)', () => {
  let two: TwoTenantDatabase;

  before(async () => {
    two = await createTwoTenantDatabase();
  });

  after(async () => {
    await two.db.close();
  });

  test('returns only current parents of the requested tenant', async () => {
    const { db } = two;
    const currentA = '00000000-0000-4000-8000-00000000p1a1';
    const oldA = '00000000-0000-4000-8000-00000000p1a2';
    const parentB = '00000000-0000-4000-8000-00000000p1b1';
    await db.query(
      `INSERT INTO document_parents (id, document_id, tenant_key, version, is_current, chunking_profile_id, section_path, content, token_count, parent_index)
       VALUES ($1, $2, $3, 1, true, 'legacy', '{}', 'current parent', 12, 0),
              ($4, $2, $3, 0, false, 'legacy', '{}', 'old parent', 12, 0),
              ($5, $6, $7, 1, true, 'legacy', '{}', 'foreign parent', 12, 0)`,
      [currentA, TWO_TENANT_IDS.docA, KEY_A, oldA, parentB, TWO_TENANT_IDS.docB, KEY_B],
    );

    const rows = await db.query<{ id: string }>('SELECT id FROM rag_fetch_parents($1, $2::uuid[])', [
      KEY_A,
      [currentA, parentB, oldA],
    ]);
    assert.deepEqual(rows.rows.map((row) => row.id).sort(), [currentA]);

    const malformed = await tryQuery(db, 'SELECT * FROM rag_fetch_parents($1, $2::uuid[])', ["' OR 1=1 --", [currentA]]);
    assert.match(malformed ?? '', /malformed tenant key/);

    const tooMany = Array.from({ length: 201 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const many = await tryQuery(db, 'SELECT * FROM rag_fetch_parents($1, $2::uuid[])', [KEY_A, tooMany]);
    assert.match(many ?? '', /too many parent ids/);

    const priv = await functionPrivileges(db, 'rag_fetch_parents');
    assert.deepEqual(priv, { anon: false, authenticated: false, service: true });
  });

  test('deleting a document cascades parents and nulls child parent_id', async () => {
    const { db } = two;
    const docId = '00000000-0000-4000-8000-00000000d0c1';
    const parentId = '00000000-0000-4000-8000-00000000p0c1';
    const childId = '00000000-0000-4000-8000-00000000c0c1';
    await db.query(
      'INSERT INTO documents (id, filename, content, metadata, user_id) VALUES ($1, $2, $3, $4::jsonb, $5)',
      [docId, 'cascade.md', 'body', '{}', TWO_TENANT_IDS.userA],
    );
    await db.query(
      `INSERT INTO document_parents (id, document_id, tenant_key, version, is_current, chunking_profile_id, section_path, content, token_count, parent_index)
       VALUES ($1, $2, $3, 1, true, 'legacy', '{}', 'parent', 3, 0)`,
      [parentId, docId, KEY_A],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, parent_id, chunking_profile_id, status)
       VALUES ($1, $2, $3, $4::vector, 0, '{}'::jsonb, $5, 'legacy', 'ready')`,
      [childId, docId, 'child', vectorLiteral(embedText('child')), parentId],
    );
    await db.query('DELETE FROM documents WHERE id = $1', [docId]);
    const parents = await db.query('SELECT 1 FROM document_parents WHERE id = $1', [parentId]);
    assert.equal(parents.rows.length, 0);
    const child = await db.query<{ parent_id: string | null }>('SELECT parent_id FROM document_chunks WHERE id = $1', [childId]);
    assert.equal(child.rows[0]?.parent_id, null);
  });
});

for (const mode of MODES) {
  describe(`chunking_profiles (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true });
    });

    after(async () => {
      await fixture.db.close();
    });

    test('seeds one active legacy profile per doc type and enforces constraints', async () => {
      const { db } = fixture;
      const rows = await db.query<{ id: string; doc_type: string; status: string }>(
        "SELECT id, doc_type, status FROM chunking_profiles WHERE id = 'legacy' ORDER BY doc_type",
      );
      assert.equal(rows.rows.length, DOC_TYPES.length);
      for (const docType of DOC_TYPES) {
        const match = rows.rows.find((row) => row.doc_type === docType);
        assert.ok(match, docType);
        assert.equal(match?.status, 'active');
      }

      const dupActive = await tryQuery(
        db,
        `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
         VALUES ('dup', 'contract_legal', 256, 'none', NULL, 'active', 'custom')`,
      );
      assert.ok(dupActive, 'second active row for one doc type must fail');

      const missingParent = await tryQuery(
        db,
        `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
         VALUES ('bad-fixed', 'general', 256, 'fixed', NULL, 'building', 'custom')`,
      );
      assert.ok(missingParent);

      const ratio = await tryQuery(
        db,
        `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
         VALUES ('bad-ratio', 'general', 256, 'fixed', 400, 'building', 'custom')`,
      );
      assert.ok(ratio);
    });

    test('rag_list_chunking_profiles is service-role only and returns is_active', async () => {
      const { db } = fixture;
      const priv = await functionPrivileges(db, 'rag_list_chunking_profiles');
      assert.deepEqual(priv, { anon: false, authenticated: false, service: true });

      const tablePriv = await db.query<{ anon: boolean; authenticated: boolean }>(
        `SELECT has_table_privilege('anon', 'public.chunking_profiles', 'SELECT') AS anon,
                has_table_privilege('authenticated', 'public.chunking_profiles', 'SELECT') AS authenticated`,
      );
      assert.equal(tablePriv.rows[0]?.anon, false);
      assert.equal(tablePriv.rows[0]?.authenticated, false);

      const listed = await db.query<{ doc_type: string; is_active: boolean; id: string }>(
        'SELECT doc_type, is_active, id FROM rag_list_chunking_profiles() ORDER BY doc_type',
      );
      assert.equal(listed.rows.length, DOC_TYPES.length);
      for (const row of listed.rows) {
        assert.equal(row.id, 'legacy');
        assert.equal(row.is_active, true);
      }
    });
  });
}