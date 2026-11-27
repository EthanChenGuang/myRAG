import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { CitationRecordSchema } from '../../src/lib/rag-eval/contracts.generated.ts';
import { pickAnswerMetadata } from '../../src/lib/chat/answer-metadata.ts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const WITHDRAWN_AT = '2026-01-02T03:04:05Z';
const WITHDRAWN_AT_ISO = '2026-01-02T03:04:05.000Z';
const KEPT_KEYS = ['n', 'alias', 'chunkIds', 'documentId', 'documentVersion', 'strategy'] as const;

const FUNCTIONS = [
  'rag_withdrawn_citation(jsonb, timestamptz)',
  'rag_withdrawn_citations(jsonb, text[], timestamptz)',
  'rag_withdrawn_document_refs(jsonb, text[])',
  'rag_purge_image_pattern(text, uuid)',
  'rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz)',
  'rag_chat_messages_reference(jsonb, text[], text)',
  'rag_citation_leftover_count(jsonb, text[])',
  'rag_chat_messages_leftover_count(jsonb, text[])',
  'rag_purge_scrub_answer_records(text, uuid, uuid[], timestamptz)',
  'rag_purge_scrub_chats(text, uuid, uuid[], timestamptz)',
  'rag_purge_citation_leftovers(text, uuid[])',
];

type Json = Record<string, unknown>;
type Role = 'anon' | 'authenticated' | 'service_role';

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

function citation(n: number, documentId: string, quote: string): Json {
  return {
    n,
    alias: `S${n}`,
    chunkIds: [`chunk-${n}`],
    documentId,
    documentName: `synthetic-source-${n}.md`,
    documentVersion: 2,
    page: n + 3,
    sectionPath: ['Synthetic part', `Section ${n}`],
    quote,
    quoteHash: sha256(quote),
    strategy: 'chunk-alias',
  };
}

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  }
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function createOrganization(db: PGlite, ownerId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [id, 'Synthetic org', `org-${id.slice(0, 8)}`, ownerId]);
  return id;
}

async function insertRecord(db: PGlite, userId: string, organizationId: string | null, citations: Json[]): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO rag_answer_records (id, user_id, organization_id, rag_mode, citations) VALUES ($1, $2, $3, 'strict', $4::jsonb)",
    [id, userId, organizationId, JSON.stringify(citations)],
  );
  return id;
}

async function recordCitations(db: PGlite, id: string): Promise<Json[]> {
  const rows = await db.query<{ citations: Json[] }>('SELECT citations FROM rag_answer_records WHERE id = $1', [id]);
  return rows.rows[0]?.citations ?? [];
}

async function insertChat(db: PGlite, mode: DeploymentMode, userId: string, organizationId: string | null, messages: Json[]): Promise<string> {
  const id = crypto.randomUUID();
  if (mode === 'multi-tenant') {
    await db.query(
      "INSERT INTO chats (id, user_id, organization_id, title, messages, updated_at) VALUES ($1, $2, $3, 'Synthetic chat', $4::jsonb, '2025-01-01T00:00:00Z')",
      [id, userId, organizationId, JSON.stringify(messages)],
    );
  } else {
    await db.query(
      "INSERT INTO chats (id, user_id, title, messages, updated_at) VALUES ($1, $2, 'Synthetic chat', $3::jsonb, '2025-01-01T00:00:00Z')",
      [id, userId, JSON.stringify(messages)],
    );
  }
  return id;
}

async function chatRow(db: PGlite, id: string): Promise<{ messages: Json[]; updated_at: string }> {
  const rows = await db.query<{ messages: Json[]; updated_at: string }>('SELECT messages, updated_at::text AS updated_at FROM chats WHERE id = $1', [id]);
  const row = rows.rows[0];
  assert.ok(row, `chat ${id} exists`);
  return row;
}

function imageUrl(tenantKey: string, lineageId: string, encoded = false): string {
  const tenant = encoded ? tenantKey.replace(':', '%3A') : tenantKey;
  return `https://storage.example.invalid/storage/v1/object/public/chat-images/rag/${tenant}/${lineageId}/2/p1-1.png`;
}

function chatMessages(tenantKey: string, lineageId: string, otherLineageId: string, purgedId: string, otherId: string): Json[] {
  return [
    { id: 'm-user', role: 'user', content: 'A synthetic question about the sample.' },
    {
      id: 'm-assistant',
      role: 'assistant',
      content: [
        {
          type: 'source_images',
          source_images: [
            { name: 'page one', size: 0, type: 'image/png', url: imageUrl(tenantKey, lineageId) },
            { name: 'page one encoded', size: 0, type: 'image/png', url: imageUrl(tenantKey, lineageId, true) },
            { name: 'other page', size: 0, type: 'image/png', url: imageUrl(tenantKey, otherLineageId) },
          ],
        },
        { type: 'text', text: 'A synthetic answer [S1] [S2].' },
        {
          type: 'metadata',
          usedDocuments: [
            { id: purgedId, name: 'synthetic-source-1.md', filename: 'synthetic-source-1.md', similarity: 0.9, content_preview: 'Synthetic sentence alpha.', matched_chunk: 'Synthetic sentence alpha.', explicitly_referenced: true },
            { id: otherId, name: 'synthetic-source-3.md', similarity: 0.7, content_preview: 'Synthetic sentence gamma.', matched_chunk: 'Synthetic sentence gamma.' },
          ],
        },
      ],
      metadata: {
        ragTraceId: 'trace-synthetic',
        citations: [citation(1, purgedId, 'Synthetic sentence alpha.'), citation(2, otherId, 'Synthetic sentence gamma.')],
      },
    },
  ];
}

function assertMarker(value: Json, original: Json): void {
  for (const key of KEPT_KEYS) assert.deepEqual(value[key], original[key], `${key} kept`);
  assert.equal(value.quote, '');
  assert.equal(value.quoteHash, EMPTY_SHA256);
  assert.equal(value.withdrawn, true);
  assert.equal(value.withdrawnAt, WITHDRAWN_AT_ISO);
  assert.equal(value.documentName, '');
  assert.equal(value.sectionPath, null);
  assert.equal(value.page, null);
  const parsed = CitationRecordSchema.safeParse(value);
  assert.ok(parsed.success, `CitationRecordSchema accepts the marker: ${parsed.success ? '' : parsed.error.message}`);
}

async function scrubRecords(db: PGlite, tenantKey: string, lineageId: string, ids: string[]): Promise<number> {
  const rows = await db.query<{ n: number }>('SELECT public.rag_purge_scrub_answer_records($1, $2::uuid, $3::uuid[], $4::timestamptz) AS n', [tenantKey, lineageId, ids, WITHDRAWN_AT]);
  return Number(rows.rows[0]?.n);
}

async function scrubChats(db: PGlite, tenantKey: string, lineageId: string, ids: string[]): Promise<number> {
  const rows = await db.query<{ n: number }>('SELECT public.rag_purge_scrub_chats($1, $2::uuid, $3::uuid[], $4::timestamptz) AS n', [tenantKey, lineageId, ids, WITHDRAWN_AT]);
  return Number(rows.rows[0]?.n);
}

async function leftovers(db: PGlite, tenantKey: string, ids: string[]): Promise<Record<string, number>> {
  const rows = await db.query<{ store: string; remaining: string | number }>('SELECT store, remaining FROM public.rag_purge_citation_leftovers($1, $2::uuid[])', [tenantKey, ids]);
  return Object.fromEntries(rows.rows.map((row) => [row.store, Number(row.remaining)]));
}

for (const mode of MODES) {
  describe(`purge citation scrub (${mode})`, () => {
    let db: PGlite;
    let userA: string;
    let userB: string;
    let orgA: string | null = null;
    let orgB: string | null = null;
    let tenantA: string;
    const otherModeKey = mode === 'multi-tenant' ? 's:default' : `o:${crypto.randomUUID()}`;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      userA = await createUser(db);
      userB = await createUser(db);
      if (mode === 'multi-tenant') {
        orgA = await createOrganization(db, userA);
        orgB = await createOrganization(db, userB);
        tenantA = `o:${orgA}`;
      } else {
        tenantA = 's:default';
      }
    });

    after(async () => {
      await db.close();
    });

    test('answer-record citations of a purged version become markers that pass CitationRecordSchema and pickAnswerMetadata', async () => {
      const lineage = crypto.randomUUID();
      const purged = crypto.randomUUID();
      const other = crypto.randomUUID();
      const original = [
        citation(1, purged, 'Synthetic sentence alpha.'),
        citation(2, other, 'Synthetic sentence gamma.'),
        citation(3, purged, 'Synthetic sentence beta.'),
      ];
      const id = await insertRecord(db, userA, orgA, original);

      assert.equal(await scrubRecords(db, tenantA, lineage, [purged]), 2);
      const after = await recordCitations(db, id);
      assert.equal(after.length, 3);
      assertMarker(after[0], original[0]);
      assert.deepEqual(after[1], original[1]);
      assertMarker(after[2], original[2]);
      assert.deepEqual(after.map((entry) => entry.n), [1, 2, 3]);

      const picked = pickAnswerMetadata({ citations: after });
      assert.equal(picked.citations?.length, 3, 'validCitations keeps every marker');
      assert.equal(picked.citations?.[0]?.withdrawn, true);
    });

    test('the marker carries no title, file name or text of the withdrawn content', async () => {
      const lineage = crypto.randomUUID();
      const purged = crypto.randomUUID();
      const other = crypto.randomUUID();
      const withDuplicate = { ...citation(2, other, 'Synthetic sentence delta.'), alsoIn: [{ chunkId: 'chunk-dup', documentId: purged, filename: 'synthetic-duplicate.md' }] };
      const id = await insertRecord(db, userA, orgA, [
        { ...citation(1, purged, 'Synthetic sentence epsilon.'), effectiveFrom: '2025-01-01', isCurrent: true, alsoIn: [{ chunkId: 'chunk-x', documentId: other, filename: 'synthetic-other.md' }] },
        withDuplicate,
      ]);

      await scrubRecords(db, tenantA, lineage, [purged]);
      const after = await recordCitations(db, id);
      const text = JSON.stringify(after[0]);
      for (const leaked of ['synthetic-source-1.md', 'Synthetic sentence epsilon.', 'Synthetic part', 'synthetic-other.md', '2025-01-01']) {
        assert.ok(!text.includes(leaked), `marker leaks ${leaked}`);
      }
      assert.equal('alsoIn' in after[1], false, 'a duplicate entry of the purged document is dropped from another citation');
      assert.equal(after[1].quote, 'Synthetic sentence delta.');
      assert.ok(CitationRecordSchema.safeParse(after[1]).success);
    });

    test('a second call returns 0 and changes nothing', async () => {
      const lineage = crypto.randomUUID();
      const purged = crypto.randomUUID();
      const id = await insertRecord(db, userA, orgA, [citation(1, purged, 'Synthetic sentence zeta.')]);
      assert.equal(await scrubRecords(db, tenantA, lineage, [purged]), 1);
      const first = await recordCitations(db, id);
      const later = await db.query<{ n: number }>("SELECT public.rag_purge_scrub_answer_records($1, $2::uuid, $3::uuid[], now() + interval '1 day') AS n", [tenantA, lineage, [purged]]);
      assert.equal(Number(later.rows[0]?.n), 0);
      assert.deepEqual(await recordCitations(db, id), first);
    });

    test('a key of the other mode is refused, and another tenant leaves the records untouched', async () => {
      const lineage = crypto.randomUUID();
      const purged = crypto.randomUUID();
      const original = [citation(1, purged, 'Synthetic sentence eta.')];
      const id = await insertRecord(db, userA, orgA, original);

      await assert.rejects(() => scrubRecords(db, otherModeKey, lineage, [purged]), (error: unknown) => sqlState(error) === '22023');
      await assert.rejects(() => scrubChats(db, otherModeKey, lineage, [purged]), (error: unknown) => sqlState(error) === '22023');
      await assert.rejects(() => leftovers(db, otherModeKey, [purged]), (error: unknown) => sqlState(error) === '22023');
      if (mode === 'multi-tenant') {
        assert.equal(await scrubRecords(db, `o:${orgB}`, lineage, [purged]), 0);
        assert.equal(await scrubRecords(db, `u:${userA}`, lineage, [purged]), 0, 'the personal tenant of the same user is another tenant');
      }
      assert.deepEqual(await recordCitations(db, id), original);
    });

    test('the chat scrub stays inside the purged tenant', async () => {
      const lineage = crypto.randomUUID();
      const purged = crypto.randomUUID();
      const other = crypto.randomUUID();
      const messages = chatMessages(tenantA, lineage, crypto.randomUUID(), purged, other);
      const cited = await insertChat(db, mode, userA, orgA, messages);
      const unrelated = await insertChat(db, mode, userA, orgA, chatMessages(tenantA, crypto.randomUUID(), crypto.randomUUID(), other, crypto.randomUUID()));
      const outside: string[] = [];
      if (mode === 'multi-tenant') {
        outside.push(await insertChat(db, mode, userA, null, messages));
        outside.push(await insertChat(db, mode, userB, orgB, messages));
      }
      const before = new Map<string, { messages: Json[]; updated_at: string }>();
      for (const id of [unrelated, ...outside]) before.set(id, await chatRow(db, id));

      assert.equal(await scrubChats(db, tenantA, lineage, [purged]), 1);
      assert.notDeepEqual((await chatRow(db, cited)).messages, messages);
      for (const [id, row] of before) assert.deepEqual(await chatRow(db, id), row, `chat ${id} untouched`);

      if (mode === 'multi-tenant') {
        const personalKey = `u:${userA}`;
        const personalLineage = crypto.randomUUID();
        const personalPurged = crypto.randomUUID();
        const personalMessages = chatMessages(personalKey, personalLineage, crypto.randomUUID(), personalPurged, other);
        const personal = await insertChat(db, mode, userA, null, personalMessages);
        const orgChat = await insertChat(db, mode, userA, orgA, personalMessages);
        const otherUser = await insertChat(db, mode, userB, null, personalMessages);
        const orgBefore = await chatRow(db, orgChat);
        const otherBefore = await chatRow(db, otherUser);
        assert.equal(await scrubChats(db, personalKey, personalLineage, [personalPurged]), 1);
        assert.notDeepEqual((await chatRow(db, personal)).messages, personalMessages);
        assert.deepEqual(await chatRow(db, orgChat), orgBefore);
        assert.deepEqual(await chatRow(db, otherUser), otherBefore);
      }
    });

    test('a rewritten message keeps markers for citations, blanks used documents and drops picture links of the lineage', async () => {
      const lineage = crypto.randomUUID();
      const otherLineage = crypto.randomUUID();
      const purged = crypto.randomUUID();
      const other = crypto.randomUUID();
      const messages = chatMessages(tenantA, lineage, otherLineage, purged, other);
      const id = await insertChat(db, mode, userA, orgA, messages);

      await scrubChats(db, tenantA, lineage, [purged]);
      const after = (await chatRow(db, id)).messages;
      assert.deepEqual(after[0], messages[0]);
      const assistant = after[1] as { content: Json[]; metadata: { ragTraceId: string; citations: Json[] } };
      const originalAssistant = messages[1] as { content: Json[]; metadata: { citations: Json[] } };

      assert.equal(assistant.metadata.ragTraceId, 'trace-synthetic');
      assertMarker(assistant.metadata.citations[0], originalAssistant.metadata.citations[0]);
      assert.deepEqual(assistant.metadata.citations[1], originalAssistant.metadata.citations[1]);
      assert.equal(pickAnswerMetadata(assistant.metadata).citations?.length, 2);

      const images = assistant.content[0].source_images as Json[];
      assert.deepEqual(images.map((image) => image.name), ['other page']);
      assert.deepEqual(assistant.content[1], originalAssistant.content[1]);

      const used = assistant.content[2].usedDocuments as Json[];
      assert.equal(used[0].id, purged);
      assert.equal(used[0].name, '');
      assert.equal(used[0].content_preview, '');
      assert.equal(used[0].matched_chunk, '');
      assert.equal(used[0].withdrawn, true);
      assert.equal(used[0].explicitly_referenced, true);
      assert.equal('filename' in used[0], false);
      assert.deepEqual(used[1], (originalAssistant.content[2].usedDocuments as Json[])[1]);

      const text = JSON.stringify(after);
      for (const leaked of ['Synthetic sentence alpha.', 'synthetic-source-1.md', lineage]) {
        assert.ok(!text.includes(leaked), `chat still holds ${leaked}`);
      }
      assert.equal(await scrubChats(db, tenantA, lineage, [purged]), 0, 'a second chat scrub rewrites nothing');
    });

    test('rag_purge_citation_leftovers counts unflagged citations and used documents per store until the scrub', async () => {
      const lineage = crypto.randomUUID();
      const purged = crypto.randomUUID();
      const other = crypto.randomUUID();
      await insertRecord(db, userA, orgA, [citation(1, purged, 'Synthetic sentence theta.'), citation(2, other, 'Synthetic sentence iota.')]);
      await insertChat(db, mode, userA, orgA, chatMessages(tenantA, lineage, crypto.randomUUID(), purged, other));

      assert.deepEqual(await leftovers(db, tenantA, [purged]), { answer_citations: 1, chat_messages: 2 });
      await scrubRecords(db, tenantA, lineage, [purged]);
      await scrubChats(db, tenantA, lineage, [purged]);
      assert.deepEqual(await leftovers(db, tenantA, [purged]), { answer_citations: 0, chat_messages: 0 });
      assert.deepEqual(await leftovers(db, tenantA, [other]), { answer_citations: 1, chat_messages: 2 }, 'other documents are not affected');
    });

    test('anon and authenticated get 42501 on every function; service_role may execute', async () => {
      for (const signature of FUNCTIONS) {
        const privileges = await db.query<{ anon: boolean; authenticated: boolean; service: boolean; public_role: boolean; definer: boolean; config: string[] | null }>(
          `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                  has_function_privilege('service_role', $1, 'EXECUTE') AS service,
                  EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                           WHERE p.oid = $1::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_role,
                  (SELECT prosecdef FROM pg_proc WHERE oid = $1::regprocedure) AS definer,
                  (SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure) AS config`,
          [`public.${signature}`],
        );
        const row = privileges.rows[0];
        assert.deepEqual(
          { anon: row?.anon, authenticated: row?.authenticated, service: row?.service, public_role: row?.public_role, definer: row?.definer },
          { anon: false, authenticated: false, service: true, public_role: false, definer: true },
          signature,
        );
        assert.deepEqual(row?.config, ['search_path=""'], `${signature} search_path`);
      }
      const ids = [crypto.randomUUID()];
      for (const role of ['anon', 'authenticated'] as const) {
        await assert.rejects(
          () => asRole(db, role, userA, () => db.query('SELECT public.rag_purge_scrub_answer_records($1, $2::uuid, $3::uuid[], now())', [tenantA, crypto.randomUUID(), ids])),
          (error: unknown) => sqlState(error) === '42501',
        );
        await assert.rejects(
          () => asRole(db, role, userA, () => db.query('SELECT public.rag_purge_scrub_chats($1, $2::uuid, $3::uuid[], now())', [tenantA, crypto.randomUUID(), ids])),
          (error: unknown) => sqlState(error) === '42501',
        );
        await assert.rejects(
          () => asRole(db, role, userA, () => db.query('SELECT * FROM public.rag_purge_citation_leftovers($1, $2::uuid[])', [tenantA, ids])),
          (error: unknown) => sqlState(error) === '42501',
        );
        await assert.rejects(
          () => asRole(db, role, userA, () => db.query("SELECT public.rag_withdrawn_citation('{}'::jsonb, now())")),
          (error: unknown) => sqlState(error) === '42501',
        );
      }
      const allowed = await asRole(db, 'service_role', null, () => db.query('SELECT * FROM public.rag_purge_citation_leftovers($1, $2::uuid[])', [tenantA, ids]));
      assert.equal(allowed.rows.length, 2);
    });
  });
}
