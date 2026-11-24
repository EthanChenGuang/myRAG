import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const CORPUS_DIR = path.resolve(import.meta.dirname, '../../eval/fixtures/corpus');
const ZERO_VECTOR = `[${new Array(1536).fill(0).join(',')}]`;

const USER_A = '00000000-0000-4000-8000-0000000071a1';
const USER_B = '00000000-0000-4000-8000-0000000071b1';
const MEMBER = '00000000-0000-4000-8000-0000000071c1';
const ORG = '00000000-0000-4000-8000-0000000071e1';

const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const DOCS = {
  ready: id('7d01', 1),
  quarantined: id('7d01', 2),
  quarantinedCurrent: id('7d01', 3),
  superseded: id('7d01', 4),
  processing: id('7d01', 5),
  drift: id('7d01', 6),
  legacy: id('7d01', 7),
  orgReady: id('7d01', 8),
  orgQuarantined: id('7d01', 9),
  otherReady: id('7d01', 10),
} as const;

const chunkOf = (doc: string): string => doc.replace('7d01', '7c01');

async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)", [userId ?? '', role]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)");
  }
}

interface Seed {
  doc: string;
  status: string;
  current: boolean;
  user: string | null;
  org?: string | null;
  chunkStatus?: string;
  chunkCurrent?: boolean;
  content?: string;
  legacy?: boolean;
}

async function seed(db: PGlite, mode: DeploymentMode, item: Seed): Promise<void> {
  const multi = mode === 'multi-tenant';
  const columns = ['id', 'filename', 'content', ...(multi ? ['user_id', 'organization_id'] : []), ...(item.legacy ? [] : ['status', 'is_current', 'source', 'source_key', 'lineage_id'])];
  const values: unknown[] = [item.doc, `${item.doc}.md`, 'document body', ...(multi ? [item.user, item.org ?? null] : []), ...(item.legacy ? [] : [item.status, item.current, 'config_upload', `root/${item.doc}`, item.doc])];
  await db.query(`INSERT INTO documents (${columns.join(', ')}) VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})`, values);
  const chunkColumns = ['id', 'document_id', 'content', 'embedding', 'chunk_index', ...(multi ? ['organization_id'] : []), ...(item.legacy ? [] : ['status', 'is_current'])];
  const chunkValues: unknown[] = [
    chunkOf(item.doc),
    item.doc,
    item.content ?? `chunk of ${item.doc}`,
    ZERO_VECTOR,
    0,
    ...(multi ? [item.org ?? null] : []),
    ...(item.legacy ? [] : [item.chunkStatus ?? item.status, item.chunkCurrent ?? item.current]),
  ];
  await db.query(`INSERT INTO document_chunks (${chunkColumns.join(', ')}) VALUES (${chunkValues.map((_, index) => `$${index + 1}`).join(', ')})`, chunkValues);
}

async function build(mode: DeploymentMode): Promise<FixtureDatabase> {
  const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS_DIR, supabaseGrants: true });
  const { db } = fixture;
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6) ON CONFLICT DO NOTHING', [
    USER_A,
    'a@example.invalid',
    USER_B,
    'b@example.invalid',
    MEMBER,
    'member@example.invalid',
  ]);
  const multi = mode === 'multi-tenant';
  if (multi) {
    await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Org', 'org-rls', $2, false)", [ORG, USER_A]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [ORG, USER_A, MEMBER]);
  }
  const owner = multi ? USER_A : null;
  await seed(db, mode, { doc: DOCS.ready, status: 'ready', current: true, user: owner, content: 'zzreadyword in a ready current chunk' });
  await seed(db, mode, { doc: DOCS.quarantined, status: 'quarantined', current: false, user: owner, content: 'zzquarword in a quarantined chunk' });
  await seed(db, mode, { doc: DOCS.quarantinedCurrent, status: 'quarantined', current: true, user: owner, content: 'zzquarcurrent in a current but quarantined chunk' });
  await seed(db, mode, { doc: DOCS.superseded, status: 'ready', current: false, user: owner, content: 'zzoldversion in a superseded chunk' });
  await seed(db, mode, { doc: DOCS.processing, status: 'processing', current: false, user: owner, content: 'zzprocessing in an unfinished chunk' });
  await seed(db, mode, { doc: DOCS.drift, status: 'quarantined', current: false, user: owner, chunkStatus: 'ready', chunkCurrent: true, content: 'zzdrift in a chunk whose copy of the status drifted' });
  await seed(db, mode, { doc: DOCS.legacy, status: 'ready', current: true, user: owner, legacy: true, content: 'zzlegacyword in a legacy chunk' });
  if (multi) {
    await seed(db, mode, { doc: DOCS.orgReady, status: 'ready', current: true, user: USER_A, org: ORG, content: 'zzorgready in an organization chunk' });
    await seed(db, mode, { doc: DOCS.orgQuarantined, status: 'quarantined', current: false, user: USER_A, org: ORG, content: 'zzorgquar in a quarantined organization chunk' });
    await seed(db, mode, { doc: DOCS.otherReady, status: 'ready', current: true, user: USER_B, content: 'zzotherready of another tenant' });
  }
  return fixture;
}

const ids = (rows: Row[]): string[] => rows.map((row) => String(row.id)).sort();

for (const mode of ['single-tenant', 'multi-tenant'] as const) {
  describe(`direct table reads of quarantined rows (${mode})`, () => {
    const roles: Array<{ role: Role; user: string | null; label: string; readable: string[]; chunkReadable: string[] }> =
      mode === 'single-tenant'
        ? [
            { role: 'anon', user: null, label: 'anon', readable: [DOCS.ready, DOCS.legacy], chunkReadable: [DOCS.ready, DOCS.legacy] },
            { role: 'authenticated', user: USER_B, label: 'authenticated', readable: [DOCS.ready, DOCS.legacy], chunkReadable: [DOCS.ready, DOCS.legacy] },
          ]
        : [
            { role: 'anon', user: null, label: 'anon', readable: [], chunkReadable: [] },
            { role: 'authenticated', user: USER_A, label: 'the owner', readable: [DOCS.ready, DOCS.legacy, DOCS.orgReady], chunkReadable: [DOCS.ready, DOCS.legacy, DOCS.orgReady] },
            { role: 'authenticated', user: MEMBER, label: 'an organization member', readable: [DOCS.orgReady], chunkReadable: [DOCS.orgReady] },
            { role: 'authenticated', user: USER_B, label: 'another tenant', readable: [DOCS.otherReady], chunkReadable: [DOCS.otherReady] },
          ];

    for (const { role, user, label, readable, chunkReadable } of roles) {
      test(`${label} reads ready, current documents and chunks as today and nothing quarantined, superseded or unfinished`, async () => {
        const fixture = await build(mode);
        try {
          const { db } = fixture;
          await asRole(db, role, user, async () => {
            const documents = (await db.query<Row>('SELECT id FROM documents')).rows;
            assert.deepEqual(ids(documents), [...readable].sort(), 'documents');
            const chunks = (await db.query<Row>('SELECT document_id AS id FROM document_chunks')).rows;
            assert.deepEqual(ids(chunks), [...chunkReadable].sort(), 'chunks');

            for (const hidden of [DOCS.quarantined, DOCS.quarantinedCurrent, DOCS.drift, DOCS.superseded, DOCS.processing, DOCS.orgQuarantined]) {
              assert.equal((await db.query('SELECT 1 FROM documents WHERE id = $1', [hidden])).rows.length, 0, `document ${hidden} by id`);
              assert.equal((await db.query('SELECT 1 FROM document_chunks WHERE document_id = $1', [hidden])).rows.length, 0, `chunks of ${hidden} by document id`);
              assert.equal((await db.query('SELECT 1 FROM document_chunks WHERE id = $1', [chunkOf(hidden)])).rows.length, 0, `chunk of ${hidden} by id`);
            }
            const text = (await db.query<Row>("SELECT content FROM document_chunks WHERE content LIKE '%zz%'")).rows.map((row) => String(row.content)).join('|');
            for (const word of ['zzquarword', 'zzquarcurrent', 'zzdrift', 'zzoldversion', 'zzprocessing', 'zzorgquar']) assert.ok(!text.includes(word), `${word} is not readable`);
          });
        } finally {
          await fixture.db.close();
        }
      });
    }

    test('service_role still reads every row', async () => {
      const fixture = await build(mode);
      try {
        await asRole(fixture.db, 'service_role', null, async () => {
          const documents = (await fixture.db.query<Row>('SELECT id FROM documents')).rows;
          assert.ok(documents.length >= 7);
          assert.ok(ids(documents).includes(DOCS.quarantined));
        });
      } finally {
        await fixture.db.close();
      }
    });

    test('exactly one policy applies to SELECT on each table, so no permissive leftover can reopen the read', async () => {
      const fixture = await build(mode);
      try {
        for (const table of ['documents', 'document_chunks']) {
          const policies = (await fixture.db.query<Row>("SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND cmd IN ('SELECT', 'ALL')", [table])).rows;
          assert.equal(policies.length, 1, `${table}: ${policies.map((row) => String(row.policyname)).join(', ')}`);
        }
      } finally {
        await fixture.db.close();
      }
    });

    test('a database that still carries the old permissive policies is closed by applying the migration again', async () => {
      const fixture = await build(mode);
      try {
        const { db } = fixture;
        await db.exec(`
          CREATE POLICY "Allow full access to authenticated users" ON documents FOR ALL USING (auth.role() = 'authenticated');
          CREATE POLICY "Allow full access to authenticated users" ON document_chunks FOR ALL USING (auth.role() = 'authenticated');`);
        await asRole(db, 'authenticated', USER_B, async () => {
          assert.ok((await db.query('SELECT 1 FROM documents WHERE id = $1', [DOCS.quarantined])).rows.length === 1, 'the old policy leaks, as the control');
        });
        await applyMigrationFiles(db, migrationFiles(mode).filter((file) => file.includes('0316_quarantine_admin')));
        await asRole(db, 'authenticated', USER_B, async () => {
          assert.equal((await db.query('SELECT 1 FROM documents WHERE id = $1', [DOCS.quarantined])).rows.length, 0);
          assert.equal((await db.query('SELECT 1 FROM document_chunks WHERE document_id = $1', [DOCS.quarantined])).rows.length, 0);
        });
      } finally {
        await fixture.db.close();
      }
    });
  });
}

describe('SQL functions that read the tables for anon and authenticated (single-tenant)', () => {
  test('get_document_chunks is not executable by anon or authenticated and returns current ready chunks only to the server role', async () => {
    const fixture = await build('single-tenant');
    try {
      const { db } = fixture;
      for (const [role, user] of [
        ['anon', null],
        ['authenticated', USER_B],
      ] as const) {
        await asRole(db, role, user, async () => {
          await assert.rejects(db.query('SELECT * FROM get_document_chunks($1)', [DOCS.quarantined]), /permission denied/i, `${role} on a quarantined document`);
          await assert.rejects(db.query('SELECT * FROM get_document_chunks($1)', [DOCS.ready]), /permission denied/i, `${role} on a ready document`);
        });
      }
      await asRole(db, 'service_role', null, async () => {
        assert.equal((await db.query('SELECT * FROM get_document_chunks($1)', [DOCS.ready])).rows.length, 1);
        assert.equal((await db.query('SELECT * FROM get_document_chunks($1)', [DOCS.quarantined])).rows.length, 0, 'the function filters too');
        assert.equal((await db.query('SELECT * FROM get_document_chunks($1)', [DOCS.superseded])).rows.length, 0);
      });
    } finally {
      await fixture.db.close();
    }
  });

  test('the invoker search functions granted to anon and authenticated return no quarantined chunk', async () => {
    const fixture = await build('single-tenant');
    try {
      const { db } = fixture;
      for (const [role, user] of [
        ['anon', null],
        ['authenticated', USER_B],
      ] as const) {
        await asRole(db, role, user, async () => {
          const keyword = (await db.query<Row>("SELECT * FROM search_chunks_by_keywords('zzquarword zzdrift zzquarcurrent zzreadyword', 20)")).rows;
          const text = JSON.stringify(keyword);
          assert.ok(text.includes('zzreadyword'), `${role}: the ready chunk is found`);
          for (const word of ['zzquarword', 'zzdrift', 'zzquarcurrent']) assert.ok(!text.includes(word), `${role}: ${word}`);
          const byVector = JSON.stringify((await db.query<Row>(`SELECT * FROM match_document_chunks('${ZERO_VECTOR}'::vector, 0::double precision, 50)`)).rows);
          for (const word of ['zzquarword', 'zzdrift', 'zzquarcurrent']) assert.ok(!byVector.includes(word), `${role}: vector search ${word}`);
        });
      }
    } finally {
      await fixture.db.close();
    }
  });
});
