import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// Phase 3.2 verification UF-3: hybrid_search_translations (0810, access filter from 0933) with two access groups. A document of group A and a
// document of group B each have a translation that matches the same lexical token. A member of group B never gets group A's source text
// through the translation leg, and the reverse; a caller in both groups gets both. Neutral synthetic fixtures.

const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const IDS = {
  owner: id('9471', 1),
  memberA: id('9471', 2),
  memberB: id('9471', 3),
  org: id('9472', 1),
  docA: id('9473', 1),
  docB: id('9473', 2),
  chunkA: id('9474', 1),
  chunkB: id('9474', 2),
} as const;

const PROFILE = 'openai-3-small-1536';
const WORD = 'quorvelith';
const TEXT_A = 'Restricted synthetic sentence for group alpha.';
const TEXT_B = 'Restricted synthetic sentence for group beta.';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

type Row = Record<string, unknown>;

for (const mode of MODES) {
  describe(`translation leg with two access groups (${mode})`, () => {
    let db: PGlite;
    let corpusDir: string;
    let groupA: string;
    let groupB: string;
    const multi = mode === 'multi-tenant';
    const tenantKey = multi ? `o:${IDS.org}` : 's:default';

    async function search(keys: string[], all = false, enforced = true): Promise<Row[]> {
      await db.exec('BEGIN');
      try {
        if (enforced) await db.query('UPDATE public.rag_access_group_settings SET enforced = true');
        await db.exec('SET LOCAL ROLE service_role');
        return (
          await db.query<Row>(
            `SELECT * FROM public.hybrid_search_translations(p_tenant_key => $1, p_profile_id => $2, p_language => 'it', p_query_embedding => NULL,
               p_lexical_tokens => $3::text[], p_dense_limit => 0, p_lexical_limit => 10, p_access_keys => $4::text[], p_access_all => $5)`,
            [tenantKey, PROFILE, [WORD], keys, all],
          )
        ).rows;
      } finally {
        await db.exec('ROLLBACK');
      }
    }

    const docs = (rows: Row[]): string[] => [...new Set(rows.map((row) => String(row.document_id)))].sort();
    const texts = (rows: Row[]): string[] => rows.map((row) => String(row.content ?? ''));

    before(async () => {
      corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-translations-two-groups-'));
      db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir, supabaseGrants: true })).db;
      for (const [user, email] of [
        [IDS.owner, 'owner@example.invalid'],
        [IDS.memberA, 'member-a@example.invalid'],
        [IDS.memberB, 'member-b@example.invalid'],
      ] as const) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user, email]);
      }
      if (multi) {
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace', 'access-two-groups', $2, false)", [IDS.org, IDS.owner]);
        for (const user of [IDS.owner, IDS.memberA, IDS.memberB]) {
          await db.query('INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [IDS.org, user, user === IDS.owner ? 'owner' : 'member']);
        }
      }
      const group = async (key: string): Promise<string> =>
        (
          await db.query<{ id: string }>(
            `INSERT INTO rag_access_groups (key, name${multi ? ', organization_id' : ''}) VALUES ($1, $1${multi ? ', $2' : ''}) RETURNING id`,
            multi ? [key, IDS.org] : [key],
          )
        ).rows[0]!.id;
      groupA = await group('group-alpha');
      groupB = await group('group-beta');

      for (const entry of [
        { doc: IDS.docA, chunk: IDS.chunkA, group: groupA, text: TEXT_A },
        { doc: IDS.docB, chunk: IDS.chunkB, group: groupB, text: TEXT_B },
      ]) {
        await db.query(
          `INSERT INTO public.documents (id, filename, content, user_id, access_groups${multi ? ', organization_id' : ''})
           VALUES ($1, $2, 'Neutral synthetic record.', $3, $4::text[]${multi ? ', $5' : ''})`,
          [entry.doc, `${entry.doc}.md`, IDS.owner, [`g:${entry.group}`], ...(multi ? [IDS.org] : [])],
        );
        await db.query('INSERT INTO public.document_chunks (id, document_id, content, chunk_index) VALUES ($1, $2, $3, 0)', [entry.chunk, entry.doc, entry.text]);
        await db.query(
          `INSERT INTO public.chunk_translations (chunk_id, document_id, tenant_key, language, content, lexical_text, source_content_hash, model)
           VALUES ($1, $2, $3, 'it', 'Una frase sintetica neutra.', $4, 'hash', 'test-model')`,
          [entry.chunk, entry.doc, tenantKey, `${WORD} frase sintetica`],
        );
      }
    });

    after(async () => {
      await db?.close();
      if (corpusDir) fs.rmSync(corpusDir, { recursive: true, force: true });
    });

    test('each translation row carries the label of its own document', async () => {
      const found = await db.query<{ document_id: string; access_groups: string[] }>('SELECT document_id, access_groups FROM public.chunk_translations ORDER BY document_id');
      assert.deepEqual(
        found.rows.map((row) => [row.document_id, row.access_groups]),
        [
          [IDS.docA, [`g:${groupA}`]],
          [IDS.docB, [`g:${groupB}`]],
        ],
      );
    });

    test('a member of group B gets only group B source text through the translation leg', async () => {
      const rows = await search(['all', `u:${IDS.memberB}`, `g:${groupB}`]);
      assert.deepEqual(docs(rows), [IDS.docB]);
      assert.ok(!texts(rows).includes(TEXT_A), 'group A text leaked to a group B member');
    });

    test('a member of group A gets only group A source text through the translation leg', async () => {
      const rows = await search(['all', `u:${IDS.memberA}`, `g:${groupA}`]);
      assert.deepEqual(docs(rows), [IDS.docA]);
      assert.ok(!texts(rows).includes(TEXT_B), 'group B text leaked to a group A member');
    });

    test('a caller in neither group gets nothing; a caller in both groups and admin_all get both', async () => {
      assert.deepEqual(docs(await search(['all', `u:${IDS.owner}`])), []);
      assert.deepEqual(docs(await search(['all', `g:${groupA}`, `g:${groupB}`])), [IDS.docA, IDS.docB].sort());
      assert.deepEqual(docs(await search(['all'], true)), [IDS.docA, IDS.docB].sort());
    });
  });
}
