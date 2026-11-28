import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { createPgliteAdmin } from '../helpers/pglite-admin.ts';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import type { InsertAnswerRecordInput } from '@/lib/answers/store';

process.env.OPENAI_API_KEY ||= 'placeholder-openai-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key';
const {
  answerIdsInMessages,
  appendReviewReason,
  attachAnswersToChat,
  insertAnswerRecord,
  listOwnedAnswerRecordsForChat,
  readOwnedAnswerRecord,
  setAnswerFeedback,
  updateAnswerGroundedness,
} = await import('@/lib/answers/store');

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const JSON_COLUMNS = ['citations', 'groundedness', 'feedback', 'messages'];

type Row = Record<string, unknown>;

function client(db: PGlite, asUser?: string): SupabaseClient {
  return createPgliteAdmin(db, { jsonColumns: JSON_COLUMNS, asUser }) as unknown as SupabaseClient;
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function createChat(db: PGlite, userId: string, organizationId: string | null, messages: unknown[] = []): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO chats (id, user_id, organization_id, title, messages) VALUES ($1, $2, $3, $4, $5::jsonb)', [
    id,
    userId,
    organizationId,
    'Placeholder chat',
    JSON.stringify(messages),
  ]);
  return id;
}

function citation(n: number, documentId: string) {
  return {
    n,
    alias: `S${n}`,
    chunkIds: [`chunk-${n}`],
    documentId,
    documentName: `policy-${n}.md`,
    documentVersion: 1,
    page: null,
    sectionPath: ['Leave'],
    quote: `Placeholder quote ${n} about annual leave.`,
    quoteHash: crypto.createHash('sha256').update(`quote-${n}`).digest('hex'),
    strategy: 'chunk-alias' as const,
  };
}

function input(scope: TenantScope, userId: string, over: Partial<InsertAnswerRecordInput> = {}): InsertAnswerRecordInput {
  return {
    id: crypto.randomUUID(),
    scope,
    userId,
    chatId: null,
    traceId: `trace-${crypto.randomUUID()}`,
    modelId: 'placeholder/model',
    citationStrategy: 'chunk-alias',
    ragMode: 'strict',
    answerLanguage: 'en',
    invalidCitations: 0,
    citations: [citation(1, crypto.randomUUID())],
    groundedness: { status: 'pending', scorer: null, score: null, label: null, threshold: null, thresholdSource: null, reason: null, truncated: false, latencyMs: null, checkedAt: null },
    ...over,
  };
}

async function rowOf(db: PGlite, id: string): Promise<Row | undefined> {
  return (await db.query<Row>('SELECT *, tenant_key FROM rag_answer_records WHERE id = $1', [id])).rows[0];
}

async function ageRecord(db: PGlite, id: string): Promise<string> {
  await db.query("UPDATE rag_answer_records SET updated_at = now() - interval '1 hour' WHERE id = $1", [id]);
  return String((await db.query<{ t: string }>('SELECT updated_at::text AS t FROM rag_answer_records WHERE id = $1', [id])).rows[0]?.t);
}

async function updatedAtOf(db: PGlite, id: string): Promise<string> {
  return String((await db.query<{ t: string }>('SELECT updated_at::text AS t FROM rag_answer_records WHERE id = $1', [id])).rows[0]?.t);
}

for (const mode of MODES) {
  describe(`answer-record store (${mode})`, () => {
    let db: PGlite;
    let userA: string;
    let userB: string;
    let orgId: string | null = null;
    let otherOrgId: string | null = null;
    let scopeA: TenantScope;
    let scopeB: TenantScope;
    let orgScopeA: TenantScope | null = null;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      userA = await createUser(db);
      userB = await createUser(db);
      if (mode === 'multi-tenant') {
        orgId = crypto.randomUUID();
        otherOrgId = crypto.randomUUID();
        for (const [id, slug] of [
          [orgId, 'shared'],
          [otherOrgId, 'other'],
        ] as const) {
          await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [id, `Org ${slug}`, `${slug}-${id.slice(0, 8)}`, userA]);
        }
        await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member') ON CONFLICT DO NOTHING", [
          orgId,
          userA,
          userB,
        ]);
        scopeA = mintScope('personal', userA, null);
        scopeB = mintScope('personal', userB, null);
        orgScopeA = mintScope('org', userA, orgId);
      } else {
        scopeA = mintScope('single', null, null);
        scopeB = mintScope('single', null, null);
      }
    });

    after(async () => {
      await db.close();
    });

    test('insert stores the scope organization, the tenant key equals scopeKey and a duplicate id is ignored', async () => {
      const admin = client(db);
      const personal = input(scopeA, userA);
      assert.deepEqual(await insertAnswerRecord(admin, personal), { inserted: true });
      const stored = await rowOf(db, personal.id);
      assert.equal(stored?.user_id, userA);
      assert.equal(stored?.organization_id, null);
      assert.equal(stored?.tenant_key, scopeKey(scopeA));
      assert.equal(stored?.rag_mode, 'strict');
      assert.equal(stored?.trace_id, personal.traceId);
      assert.deepEqual(stored?.citations, personal.citations);
      assert.equal((stored?.groundedness as Row).status, 'pending');

      const again = await insertAnswerRecord(admin, { ...personal, traceId: 'trace-replaced', ragMode: 'balanced' });
      assert.deepEqual(again, { inserted: false });
      const unchanged = await rowOf(db, personal.id);
      assert.equal(unchanged?.trace_id, personal.traceId);
      assert.equal(unchanged?.rag_mode, 'strict');

      if (orgScopeA) {
        const organization = input(orgScopeA, userA);
        assert.deepEqual(await insertAnswerRecord(admin, organization), { inserted: true });
        const orgRow = await rowOf(db, organization.id);
        assert.equal(orgRow?.organization_id, orgId);
        assert.equal(orgRow?.tenant_key, scopeKey(orgScopeA));
      }
    });

    test('insert refuses a scope that does not belong to the record user', async () => {
      if (mode !== 'multi-tenant') return;
      const admin = client(db);
      const mismatch = input(scopeB, userA);
      await assert.rejects(() => insertAnswerRecord(admin, mismatch), /scope/i);
      assert.equal(await rowOf(db, mismatch.id), undefined);
    });

    test('updateAnswerGroundedness replaces groundedness and moves updated_at', async () => {
      const admin = client(db);
      const record = input(scopeA, userA);
      await insertAnswerRecord(admin, record);
      const before = await ageRecord(db, record.id);
      const scored = {
        status: 'scored' as const,
        scorer: 'hhem_2_1_open' as const,
        score: 0.8,
        label: 'verified' as const,
        threshold: 0.5,
        thresholdSource: 'default' as const,
        reason: null,
        truncated: false,
        latencyMs: 120,
        checkedAt: '2026-11-25T00:00:00.000Z',
      };
      assert.equal(await updateAnswerGroundedness(admin, { id: record.id, groundedness: scored }), true);
      const stored = await rowOf(db, record.id);
      assert.deepEqual(stored?.groundedness, scored);
      assert.notEqual(await updatedAtOf(db, record.id), before);
      assert.equal(await updateAnswerGroundedness(admin, { id: crypto.randomUUID(), groundedness: scored }), false);
    });

    test('appendReviewReason keeps one entry per reason and moves updated_at', async () => {
      const admin = client(db);
      const record = input(scopeA, userA);
      await insertAnswerRecord(admin, record);
      const before = await ageRecord(db, record.id);
      assert.equal(await appendReviewReason(admin, { id: record.id, reason: 'feedback_negative' }), true);
      assert.notEqual(await updatedAtOf(db, record.id), before);
      assert.equal(await appendReviewReason(admin, { id: record.id, reason: 'feedback_negative' }), true);
      assert.equal(await appendReviewReason(admin, { id: record.id, reason: 'groundedness_flagged' }), true);
      assert.deepEqual((await rowOf(db, record.id))?.review_reasons, ['feedback_negative', 'groundedness_flagged']);
      assert.equal(await appendReviewReason(admin, { id: crypto.randomUUID(), reason: 'feedback_negative' }), false);
    });

    test("setAnswerFeedback writes the owner's record and returns null for another user's", async () => {
      const admin = client(db);
      const record = input(scopeA, userA);
      await insertAnswerRecord(admin, record);
      const before = await ageRecord(db, record.id);
      const feedback = { vote: 'not_helpful' as const, reasons: ['wrong' as const], comment: null, updatedAt: '2026-11-25T00:00:00.000Z' };
      assert.equal(await setAnswerFeedback(admin, { id: record.id, userId: userB, feedback }), null);
      assert.equal((await rowOf(db, record.id))?.feedback, null);
      assert.equal(await updatedAtOf(db, record.id), before);

      const written = await setAnswerFeedback(admin, { id: record.id, userId: userA, feedback });
      assert.equal(written?.id, record.id);
      assert.deepEqual(written?.feedback, feedback);
      assert.deepEqual((await rowOf(db, record.id))?.feedback, feedback);
      assert.notEqual(await updatedAtOf(db, record.id), before);
    });

    test("attachAnswersToChat links only the user's unlinked rows of the chat's organization", async () => {
      const admin = client(db);
      const chatOrg = mode === 'multi-tenant' ? orgId : null;
      const chatScope = orgScopeA ?? scopeA;
      const chat = { id: await createChat(db, userA, chatOrg), organization_id: chatOrg };
      const elsewhere = await createChat(db, userA, chatOrg);

      const mine = input(chatScope, userA);
      const mineLinked = input(chatScope, userA, { chatId: elsewhere });
      const foreign = input(mode === 'multi-tenant' ? mintScope('org', userB, orgId) : scopeB, userB);
      for (const record of [mine, mineLinked, foreign]) await insertAnswerRecord(admin, record);
      const crossOrg = mode === 'multi-tenant' ? input(mintScope('org', userA, otherOrgId), userA) : null;
      const personalInOrgChat = mode === 'multi-tenant' ? input(scopeA, userA) : null;
      for (const record of [crossOrg, personalInOrgChat]) if (record) await insertAnswerRecord(admin, record);

      const ids = [mine.id, mineLinked.id, foreign.id, crossOrg?.id, personalInOrgChat?.id, 'not-a-uuid', mine.id].filter((id): id is string => typeof id === 'string');
      assert.equal(await attachAnswersToChat(admin, { userId: userA, chat, answerIds: ids }), 1);
      assert.equal((await rowOf(db, mine.id))?.chat_id, chat.id);
      assert.equal((await rowOf(db, mineLinked.id))?.chat_id, elsewhere);
      assert.equal((await rowOf(db, foreign.id))?.chat_id, null);
      if (crossOrg) assert.equal((await rowOf(db, crossOrg.id))?.chat_id, null);
      if (personalInOrgChat) assert.equal((await rowOf(db, personalInOrgChat.id))?.chat_id, null);

      assert.equal(await attachAnswersToChat(admin, { userId: userA, chat, answerIds: [] }), 0);
      assert.equal(await attachAnswersToChat(admin, { userId: userA, chat, answerIds: [mine.id] }), 0, 'already linked rows are not counted again');

      if (mode === 'multi-tenant') {
        const personalChat = { id: await createChat(db, userA, null), organization_id: null };
        assert.equal(await attachAnswersToChat(admin, { userId: userA, chat: personalChat, answerIds: [personalInOrgChat!.id, crossOrg!.id] }), 1);
        assert.equal((await rowOf(db, personalInOrgChat!.id))?.chat_id, personalChat.id);
        assert.equal((await rowOf(db, crossOrg!.id))?.chat_id, null);
      }
    });

    test('answerIdsInMessages returns assistant answerIds in order and ignores malformed metadata', () => {
      const one = crypto.randomUUID();
      const two = crypto.randomUUID();
      const messages = [
        { role: 'user', content: 'q', metadata: { answerId: crypto.randomUUID() } },
        { role: 'assistant', content: 'a', metadata: { ragTraceId: 't', answerId: one } },
        { role: 'assistant', content: 'b', metadata: { answerId: 42 } },
        { role: 'assistant', content: 'c', metadata: 'broken' },
        { role: 'assistant', content: 'd', metadata: { answerId: 'not-a-uuid' } },
        null,
        'text',
        { role: 'assistant', content: 'e' },
        { role: 'assistant', content: 'f', metadata: { answerId: two.toUpperCase() } },
        { role: 'assistant', content: 'g', metadata: { answerId: one } },
      ];
      assert.deepEqual(answerIdsInMessages(messages), [one, two]);
      assert.deepEqual(answerIdsInMessages(null), []);
      assert.deepEqual(answerIdsInMessages({ role: 'assistant' }), []);
    });

    test('owned reads use the given client under RLS and add user_id as a second guard', async () => {
      const admin = client(db);
      const chatOrg = mode === 'multi-tenant' ? orgId : null;
      const chatScope = orgScopeA ?? scopeA;
      const chatId = await createChat(db, userA, chatOrg);
      const first = input(chatScope, userA, { chatId });
      const second = input(chatScope, userA, { chatId });
      const foreign = input(mode === 'multi-tenant' ? mintScope('org', userB, orgId) : scopeB, userB, { chatId });
      for (const record of [first, second, foreign]) await insertAnswerRecord(admin, record);
      await db.query("UPDATE rag_answer_records SET created_at = now() - interval '2 minutes' WHERE id = $1", [first.id]);

      const sessionA = client(db, userA);
      assert.equal((await readOwnedAnswerRecord(sessionA, { id: first.id, userId: userA }))?.id, first.id);
      assert.equal(await readOwnedAnswerRecord(sessionA, { id: foreign.id, userId: userA }), null, 'RLS hides the foreign row');
      assert.equal(await readOwnedAnswerRecord(admin, { id: foreign.id, userId: userA }), null, 'the user_id guard holds without RLS');
      assert.equal(await readOwnedAnswerRecord(client(db, userB), { id: first.id, userId: userB }), null);

      assert.deepEqual(
        (await listOwnedAnswerRecordsForChat(sessionA, { chatId, userId: userA })).map((row) => row.id),
        [first.id, second.id],
      );
      assert.deepEqual(
        (await listOwnedAnswerRecordsForChat(admin, { chatId, userId: userA })).map((row) => row.id),
        [first.id, second.id],
        'the user_id guard holds without RLS',
      );
      assert.deepEqual(
        (await listOwnedAnswerRecordsForChat(client(db, userB), { chatId, userId: userB })).map((row) => row.id),
        [foreign.id],
      );
    });
  });
}
