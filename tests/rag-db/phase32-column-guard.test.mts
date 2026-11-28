import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// Phase 3.2 verification UF-2 (0937): a signed-in owner (single-tenant) or organization member (multi-tenant) cannot change the Phase 3.2
// language, fingerprint, hidden-text, scope, effective-date and approval columns through the tables; service_role still can, and ordinary
// edits of the owner still work. Neutral synthetic rows.

type Role = 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const ZERO_VECTOR = `[${new Array(1536).fill(0).join(',')}]`;
const UPLOADER = '00000000-0000-4000-8000-0000000093a1';
const MEMBER = '00000000-0000-4000-8000-0000000093a2';
const ORG = '00000000-0000-4000-8000-0000000093e1';
const DOC = '00000000-0000-4000-8000-0000000093d1';
const CHUNK = '00000000-0000-4000-8000-0000000093c1';

const DOCUMENT_CHANGES: Array<[string, string]> = [
  ['languages', "languages = ARRAY['und']"],
  ['ingest_fingerprint', "ingest_fingerprint = 'forged'"],
  ['hidden_text_check', "hidden_text_check = 'clean'"],
  ['scopes', "scopes = ARRAY['forged-scope']"],
  ['effective_from', "effective_from = DATE '2001-01-01'"],
  ['effective_to', "effective_to = DATE '2001-12-31'"],
  ['effective_dates_origin', "effective_dates_origin = 'admin'"],
  ['effective_dates_confidence', 'effective_dates_confidence = 0.5'],
  ['approved_by', `approved_by = '${UPLOADER}'`],
  ['approved_at', 'approved_at = now()'],
];

const CHUNK_CHANGES: Array<[string, string]> = [
  ['language_confidence', 'language_confidence = 0.5'],
  ['scopes', "scopes = ARRAY['forged-scope']"],
  ['effective_from', "effective_from = DATE '2001-01-01'"],
  ['effective_to', "effective_to = DATE '2001-12-31'"],
  ['approved_by', `approved_by = '${UPLOADER}'`],
];

async function attempt(db: PGlite, role: Role, userId: string | null, sql: string): Promise<{ ok: boolean; message: string }> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)", [userId ?? '', role]);
  await db.exec(`SET ROLE ${role}`);
  try {
    await db.query(sql);
    return { ok: true, message: '' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)");
  }
}

async function snapshot(db: PGlite, table: 'documents' | 'document_chunks', id: string): Promise<string> {
  const result = await db.query<{ row: string }>(`SELECT to_jsonb(t)::text AS row FROM public.${table} t WHERE id = $1`, [id]);
  return result.rows[0]!.row;
}

for (const mode of ['single-tenant', 'multi-tenant'] as DeploymentMode[]) {
  describe(`client roles cannot change the Phase 3.2 columns (${mode})`, () => {
    const multi = mode === 'multi-tenant';
    const actor = multi ? MEMBER : UPLOADER;
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseGrants: true })).db;
      await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'u1@example.invalid'), ($2, 'u2@example.invalid') ON CONFLICT DO NOTHING", [UPLOADER, MEMBER]);
      if (multi) {
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Org', 'org-phase32-guard', $2, false)", [ORG, UPLOADER]);
        await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [ORG, UPLOADER, MEMBER]);
        await db.query("INSERT INTO documents (id, filename, content, user_id, organization_id) VALUES ($1, 'doc.md', 'Neutral synthetic record.', $2, $3)", [DOC, UPLOADER, ORG]);
        await db.query('INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, organization_id) VALUES ($1, $2, $3, $4, 0, $5)', [CHUNK, DOC, 'A neutral synthetic sentence.', ZERO_VECTOR, ORG]);
      } else {
        await db.query("INSERT INTO documents (id, filename, content) VALUES ($1, 'doc.md', 'Neutral synthetic record.')", [DOC]);
        await db.query('UPDATE documents SET user_id = $2 WHERE id = $1', [DOC, UPLOADER]);
        await db.query('INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index) VALUES ($1, $2, $3, $4, 0)', [CHUNK, DOC, 'A neutral synthetic sentence.', ZERO_VECTOR]);
      }
    });

    after(async () => {
      await db?.close();
    });

    test('the owner can still edit an ordinary column (the table UPDATE policy applies to the actor)', async () => {
      const result = await attempt(db, 'authenticated', actor, `UPDATE documents SET filename = 'renamed.md' WHERE id = '${DOC}'`);
      assert.equal(result.ok, true, result.message);
      const row = await db.query<Row>('SELECT filename FROM documents WHERE id = $1', [DOC]);
      assert.equal(row.rows[0]?.filename, 'renamed.md');
    });

    for (const [column, change] of DOCUMENT_CHANGES) {
      test(`authenticated cannot change documents.${column}`, async () => {
        const before = await snapshot(db, 'documents', DOC);
        const result = await attempt(db, 'authenticated', actor, `UPDATE documents SET ${change} WHERE id = '${DOC}'`);
        assert.equal(await snapshot(db, 'documents', DOC), before, `row changed (ok=${result.ok})`);
        assert.equal(result.ok, false, 'the statement must be refused');
        assert.match(result.message, /ingest state column/);
      });
    }

    for (const [column, change] of CHUNK_CHANGES) {
      test(`authenticated cannot change document_chunks.${column}`, async () => {
        const before = await snapshot(db, 'document_chunks', CHUNK);
        const result = await attempt(db, 'authenticated', UPLOADER, `UPDATE document_chunks SET ${change} WHERE id = '${CHUNK}'`);
        assert.equal(await snapshot(db, 'document_chunks', CHUNK), before, `row changed (ok=${result.ok})`);
        if (!multi) {
          assert.equal(result.ok, false, 'a single-tenant owner has a chunk UPDATE policy; the trigger must refuse');
          assert.match(result.message, /ingest state column/);
        }
      });
    }

    test('service_role still writes every guarded column', async () => {
      const docs = await attempt(db, 'service_role', null, `UPDATE documents SET ${DOCUMENT_CHANGES.map(([, c]) => c).join(', ')} WHERE id = '${DOC}'`);
      assert.equal(docs.ok, true, docs.message);
      const chunks = await attempt(db, 'service_role', null, `UPDATE document_chunks SET ${CHUNK_CHANGES.map(([, c]) => c).join(', ')} WHERE id = '${CHUNK}'`);
      assert.equal(chunks.ok, true, chunks.message);
      const row = await db.query<Row>('SELECT ingest_fingerprint, scopes FROM documents WHERE id = $1', [DOC]);
      assert.equal(row.rows[0]?.ingest_fingerprint, 'forged');
    });

    test('0937 is idempotent', async () => {
      const fs = await import('node:fs');
      const sql = fs.readFileSync(new URL('../../supabase/migrations/0937_phase32_column_guard.sql', import.meta.url), 'utf8');
      await db.exec(sql);
      const triggers = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'rag_guard_phase32_columns'");
      assert.equal(triggers.rows[0]?.n, 2);
    });
  });
}
