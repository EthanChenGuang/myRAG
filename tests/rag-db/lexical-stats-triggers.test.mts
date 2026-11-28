import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * 0901: statement triggers on document_chunks stage one signed delta per changed member chunk for tenants that keep lexical statistics
 * (D-11, D-15, D-16, D-32). With no state row nothing is written. Tokens are neutral generated words (w0..wN).
 */
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SECOND_USER_ID = '00000000-0000-4000-8000-0000000000b2';
const STATS_TABLES = ['rag_lexical_stats_state', 'rag_lexical_stats_pending', 'rag_lexical_df', 'rag_lexical_corpus'];
const TRIGGER_FUNCTIONS = ['rag_lexstats_chunks_insert()', 'rag_lexstats_chunks_update()', 'rag_lexstats_chunks_delete()'];

interface PendingRow {
  tenant_key: string;
  corpus: string;
  chunking_profile_id: string;
  language: string;
  sign: number;
  lexemes: string[];
  dl: number;
}

function words(seed: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `w${(seed * 7 + i * 3) % 23}`).join(' ');
}

function distinct(text: string): string[] {
  return [...new Set(text.split(' ').filter(Boolean))].sort();
}

async function pending(db: PGlite): Promise<PendingRow[]> {
  const rows = (
    await db.query<PendingRow>(
      'SELECT tenant_key, corpus, chunking_profile_id, language, sign::int AS sign, lexemes, dl FROM public.rag_lexical_stats_pending ORDER BY id',
    )
  ).rows;
  return rows.map((row) => ({ ...row, lexemes: [...row.lexemes].sort() }));
}

async function countAll(db: PGlite): Promise<number[]> {
  const out: number[] = [];
  for (const table of STATS_TABLES) out.push((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0]!.n);
  return out;
}

async function createDocument(db: PGlite, mode: DeploymentMode, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  if (mode === 'multi-tenant') {
    await db.query("INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid)", [
      id,
      `lexstats-${id}.txt`,
      userId,
    ]);
  } else {
    // The single-tenant insert policy admits an owner's chunks; the owner is the fixture user.
    await db.query("INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid)", [
      id,
      `lexstats-${id}.txt`,
      userId,
    ]);
  }
  return id;
}

interface ChunkSpec {
  text: string | null;
  language?: string | null;
  status?: string;
  isCurrent?: boolean;
  profile?: string;
}

/** Inserts all specs of one document in a single statement and returns the chunk ids in order. */
async function insertChunks(db: PGlite, docId: string, specs: ChunkSpec[]): Promise<string[]> {
  const ids = specs.map(() => crypto.randomUUID());
  await db.query(
    `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, status, is_current, chunking_profile_id)
     SELECT u.id, $1::uuid, 'neutral sample', '{}'::jsonb, u.ord::int - 1, u.txt, u.lang, u.status, u.cur, u.profile
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::boolean[], $7::text[]) WITH ORDINALITY AS u(id, txt, lang, status, cur, profile, ord)`,
    [
      docId,
      ids,
      specs.map((s) => s.text),
      specs.map((s) => (s.language === undefined ? 'en' : s.language)),
      specs.map((s) => s.status ?? 'ready'),
      specs.map((s) => s.isCurrent ?? true),
      specs.map((s) => s.profile ?? 'legacy'),
    ],
  );
  return ids;
}

async function reset(db: PGlite): Promise<void> {
  await db.exec(`
    DELETE FROM public.rag_lexical_stats_pending;
    DELETE FROM public.rag_lexical_stats_state;
    DELETE FROM public.rag_lexical_df;
    DELETE FROM public.rag_lexical_corpus;
    DELETE FROM public.document_chunks;
    DELETE FROM public.documents;
  `);
}

async function enable(db: PGlite, tenantKey: string): Promise<void> {
  await db.query('INSERT INTO public.rag_lexical_stats_state (tenant_key) VALUES ($1)', [tenantKey]);
}

for (const mode of MODES) {
  const tenantA = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const tenantB = mode === 'multi-tenant' ? `u:${SECOND_USER_ID}` : null;

  describe(`0901 lexical statistics triggers (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (mode === 'multi-tenant') await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'second-user@example.invalid')", [SECOND_USER_ID]);
      else await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user@example.invalid')", [FIXTURE_USER_ID]);
    });

    after(async () => {
      await db.close();
    });

    beforeEach(async () => {
      await reset(db);
    });

    test('the three functions are SECURITY DEFINER with an empty search_path; client roles cannot execute them', async () => {
      for (const fn of TRIGGER_FUNCTIONS) {
        const r = await db.query<{ secdef: boolean; cfg: string[] | null }>(
          'SELECT prosecdef AS secdef, proconfig AS cfg FROM pg_proc WHERE oid = to_regprocedure($1)',
          [`public.${fn}`],
        );
        assert.equal(r.rows.length, 1, `${fn} is missing`);
        assert.equal(r.rows[0]?.secdef, true, fn);
        assert.deepEqual(r.rows[0]?.cfg, ['search_path=""'], fn);
        for (const role of ['public', 'anon', 'authenticated']) {
          const ok = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, `public.${fn}`]);
          assert.equal(ok.rows[0]?.ok, false, `${role} EXECUTE ${fn}`);
        }
      }
    });

    test('statement-level AFTER INSERT, UPDATE and DELETE triggers with transition tables', async () => {
      const r = await db.query<{ name: string; def: string }>(
        `SELECT tgname AS name, pg_get_triggerdef(oid) AS def FROM pg_trigger
          WHERE tgrelid = 'public.document_chunks'::regclass AND NOT tgisinternal AND tgname LIKE 'rag_lexstats_%' ORDER BY 1`,
      );
      assert.deepEqual(
        r.rows.map((row) => row.name),
        ['rag_lexstats_chunks_delete', 'rag_lexstats_chunks_insert', 'rag_lexstats_chunks_update'],
      );
      for (const row of r.rows) {
        assert.match(row.def, /AFTER (INSERT|UPDATE|DELETE) ON public\.document_chunks REFERENCING .* FOR EACH STATEMENT/, row.def);
      }
    });

    test('with no state row any sequence of chunk writes leaves all four tables empty', async () => {
      const docA = await createDocument(db, mode, FIXTURE_USER_ID);
      const [a1] = await insertChunks(db, docA, [{ text: words(1, 6) }, { text: words(2, 5) }]);
      if (tenantB) {
        const docB = await createDocument(db, mode, SECOND_USER_ID);
        await insertChunks(db, docB, [{ text: words(3, 4) }]);
      }
      await db.query('UPDATE public.document_chunks SET lexical_text = $1 WHERE id = $2', [words(9, 4), a1]);
      await db.query("UPDATE public.document_chunks SET status = 'quarantined'");
      await db.query('UPDATE public.document_chunks SET is_current = false');
      await db.query('DELETE FROM public.document_chunks');
      assert.deepEqual(await countAll(db), [0, 0, 0, 0]);
    });

    test('a state row for another tenant only stages nothing for this tenant', async () => {
      await enable(db, mode === 'multi-tenant' ? 'u:00000000-0000-4000-8000-0000000000ff' : 's:unused');
      const docA = await createDocument(db, mode, FIXTURE_USER_ID);
      const [a1] = await insertChunks(db, docA, [{ text: words(1, 6) }]);
      await db.query('UPDATE public.document_chunks SET lexical_text = $1 WHERE id = $2', [words(4, 3), a1]);
      await db.query('DELETE FROM public.document_chunks');
      assert.deepEqual(await pending(db), []);
    });

    test('inserts stage one +1 row per member chunk of an enabled tenant, with its distinct lexemes and length', async () => {
      await enable(db, tenantA);
      const t1 = 'w1 w2 w1 w3';
      const t2 = 'w4 w5';
      const docA = await createDocument(db, mode, FIXTURE_USER_ID);
      await insertChunks(db, docA, [
        { text: t1 },
        { text: t2, language: null },
        { text: '' },
        { text: null },
        { text: 'w6', status: 'pending_review' },
        { text: 'w7', isCurrent: false },
        { text: 'w8', status: 'variant', profile: 'probe-profile' },
      ]);
      if (tenantB) {
        const docB = await createDocument(db, mode, SECOND_USER_ID);
        await insertChunks(db, docB, [{ text: words(3, 4) }]);
      }
      const rows = await pending(db);
      const expected: PendingRow[] = [
        { tenant_key: tenantA, corpus: 'chunks', chunking_profile_id: 'legacy', language: 'en', sign: 1, lexemes: distinct(t1), dl: 4 },
        { tenant_key: tenantA, corpus: 'chunks', chunking_profile_id: 'legacy', language: 'und', sign: 1, lexemes: distinct(t2), dl: 2 },
        { tenant_key: tenantA, corpus: 'chunks', chunking_profile_id: 'probe-profile', language: 'en', sign: 1, lexemes: ['w8'], dl: 1 },
      ];
      const key = (r: PendingRow): string => JSON.stringify(r);
      assert.deepEqual(rows.map(key).sort(), expected.map(key).sort());
      assert.deepEqual((await countAll(db)).slice(2), [0, 0], 'no counter is touched on the write path');
    });

    test('updates stage -1/+1 only for tracked changes; a no-op update stages nothing', async () => {
      const docA = await createDocument(db, mode, FIXTURE_USER_ID);
      const [c1, c2, c3] = await insertChunks(db, docA, [{ text: 'w1 w2' }, { text: 'w3 w3 w4' }, { text: '' }]);
      await enable(db, tenantA);

      await db.query("UPDATE public.document_chunks SET content = 'neutral sample changed', chunk_index = chunk_index + 10");
      assert.deepEqual(await pending(db), [], 'a multi-row update of untracked columns stages nothing');

      await db.query("UPDATE public.document_chunks SET lexical_text = 'w5 w6 w5' WHERE id = $1", [c1]);
      assert.deepEqual(
        (await pending(db)).map((r) => [r.sign, r.lexemes, r.dl]),
        [
          [-1, ['w1', 'w2'], 2],
          [1, ['w5', 'w6'], 3],
        ],
      );
      await db.exec('DELETE FROM public.rag_lexical_stats_pending');

      await db.query('UPDATE public.document_chunks SET is_current = false WHERE id = $1', [c2]);
      assert.deepEqual((await pending(db)).map((r) => [r.sign, r.lexemes]), [[-1, ['w3', 'w4']]]);
      await db.query('UPDATE public.document_chunks SET is_current = true WHERE id = $1', [c2]);
      await db.exec('DELETE FROM public.rag_lexical_stats_pending');

      await db.query("UPDATE public.document_chunks SET status = 'quarantined' WHERE id = $1", [c2]);
      assert.deepEqual((await pending(db)).map((r) => r.sign), [-1]);
      await db.query("UPDATE public.document_chunks SET status = 'ready' WHERE id = $1", [c2]);
      assert.deepEqual((await pending(db)).map((r) => r.sign), [-1, 1]);
      await db.exec('DELETE FROM public.rag_lexical_stats_pending');

      await db.query("UPDATE public.document_chunks SET language = 'it' WHERE id = $1", [c2]);
      assert.deepEqual(
        (await pending(db)).map((r) => [r.sign, r.language, r.chunking_profile_id]),
        [
          [-1, 'en', 'legacy'],
          [1, 'it', 'legacy'],
        ],
      );
      await db.exec('DELETE FROM public.rag_lexical_stats_pending');

      await db.query("UPDATE public.document_chunks SET chunking_profile_id = 'probe-profile' WHERE id = $1", [c2]);
      assert.deepEqual(
        (await pending(db)).map((r) => [r.sign, r.chunking_profile_id]),
        [
          [-1, 'legacy'],
          [1, 'probe-profile'],
        ],
      );
      await db.exec('DELETE FROM public.rag_lexical_stats_pending');

      await db.query('UPDATE public.document_chunks SET language = NULL WHERE id = $1', [c2]);
      assert.deepEqual(
        (await pending(db)).map((r) => [r.sign, r.language]),
        [
          [-1, 'it'],
          [1, 'und'],
        ],
      );
      await db.exec('DELETE FROM public.rag_lexical_stats_pending');

      await db.query("UPDATE public.document_chunks SET status = 'quarantined' WHERE id = $1", [c3]);
      await db.query("UPDATE public.document_chunks SET lexical_text = NULL, status = 'ready' WHERE id = $1", [c3]);
      assert.deepEqual(await pending(db), [], 'a chunk with an empty or null vector never stages a row');

      await db.query("UPDATE public.document_chunks SET lexical_text = 'w9' WHERE id = $1", [c3]);
      assert.deepEqual((await pending(db)).map((r) => [r.sign, r.lexemes]), [[1, ['w9']]], 'gaining a vector stages a +1');
    });

    test('deletes stage -1 per member chunk; deleting a document stages one -1 per member chunk', async () => {
      await enable(db, tenantA);
      const docA = await createDocument(db, mode, FIXTURE_USER_ID);
      const [c1] = await insertChunks(db, docA, [{ text: 'w1' }, { text: 'w2 w3' }, { text: 'w4', status: 'failed' }, { text: 'w5' }]);
      await db.exec('DELETE FROM public.rag_lexical_stats_pending');

      await db.query('DELETE FROM public.document_chunks WHERE id = $1', [c1]);
      assert.deepEqual((await pending(db)).map((r) => [r.sign, r.lexemes]), [[-1, ['w1']]]);
      await db.exec('DELETE FROM public.rag_lexical_stats_pending');

      // Single-tenant chunks do not cascade from documents; the app deletes them first.
      if (mode === 'single-tenant') await db.query('DELETE FROM public.document_chunks WHERE document_id = $1', [docA]);
      await db.query('DELETE FROM public.documents WHERE id = $1', [docA]);
      assert.deepEqual((await pending(db)).map((r) => [r.sign, r.lexemes]).sort(), [
        [-1, ['w2', 'w3']],
        [-1, ['w5']],
      ]);
    });

    test('two tenants: only the enabled tenant stages rows, each under its own key', { skip: tenantB === null }, async () => {
      await enable(db, tenantA);
      const docA = await createDocument(db, mode, FIXTURE_USER_ID);
      const docB = await createDocument(db, mode, SECOND_USER_ID);
      await insertChunks(db, docA, [{ text: 'w1 w2' }]);
      await insertChunks(db, docB, [{ text: 'w3 w4' }]);
      await db.query("UPDATE public.document_chunks SET lexical_text = lexical_text || ' w9'");
      await db.query('DELETE FROM public.document_chunks');
      const rows = await pending(db);
      assert.equal(rows.length, 4);
      assert.ok(rows.every((r) => r.tenant_key === tenantA));
      assert.ok(rows.every((r) => !r.lexemes.includes('w3')));
      await enable(db, tenantB!);
      await db.exec('DELETE FROM public.rag_lexical_stats_pending');
      await insertChunks(db, docB, [{ text: 'w3 w4' }]);
      assert.deepEqual((await pending(db)).map((r) => [r.tenant_key, r.lexemes]), [[tenantB, ['w3', 'w4']]]);
    });

    test('an authenticated insert is refused (UF-1), and an owner delete still stages its row through the definer trigger', async () => {
      await enable(db, tenantA);
      const docA = await createDocument(db, mode, FIXTURE_USER_ID);
      const asOwner = async <T,>(run: () => Promise<T>): Promise<T> => {
        await db.exec('SET ROLE authenticated');
        try {
          await db.query("SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)", [FIXTURE_USER_ID]);
          return await run();
        } finally {
          await db.exec('RESET ROLE');
          await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)");
        }
      };
      await asOwner(async () => {
        await assert.rejects(() => db.query('SELECT 1 FROM public.rag_lexical_stats_pending'), (e: unknown) => (e as { code?: string }).code === '42501');
        await assert.rejects(() => insertChunks(db, docA, [{ text: 'w1 w2' }]), (e: unknown) => (e as { code?: string }).code === '42501');
      });
      assert.deepEqual(await pending(db), [], 'a refused insert stages nothing');
      const [chunk] = await insertChunks(db, docA, [{ text: 'w1 w2' }]);
      const deleted = await asOwner(() => db.query('DELETE FROM public.document_chunks WHERE id = $1 RETURNING id', [chunk]));
      assert.equal(deleted.rows.length, 1, 'the owner may delete their own chunk');
      assert.deepEqual((await pending(db)).map((r) => [r.tenant_key, r.sign, r.lexemes]), [
        [tenantA, 1, ['w1', 'w2']],
        [tenantA, -1, ['w1', 'w2']],
      ]);
    });
  });
}
