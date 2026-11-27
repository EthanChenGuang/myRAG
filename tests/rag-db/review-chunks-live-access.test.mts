import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { pgliteClient } from '../helpers/pglite-rest-client.ts';

// T-04.3-131 (G6, NF-3): the review chunk route checks visibility live (rag_chunks_visible with the expert's resolved access scope)
// instead of trusting the item's stored access_sets, so a relabelled document and an item written before enforcement (access_sets
// NULL) no longer serve restricted chunk text. Neutral synthetic data only.

process.env.OPENAI_API_KEY ||= 'placeholder-openai-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key';
const { getReviewItemChunks } = await import('@/lib/rag/feedback-loop/review-access');
const depsModule = await import('@/lib/rag/deps');
const startupModule = await import('@/lib/rag/tenant/access-startup');
const configModule = await import('@/lib/rag/config');

type Row = Record<string, unknown>;

const OWNER = '00000000-0000-4000-8000-00000000e1a0';
const MEMBER = '00000000-0000-4000-8000-00000000e1a1';
const OUTSIDER = '00000000-0000-4000-8000-00000000e1a2';
const ORG = '00000000-0000-4000-8000-00000000e1f1';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const MARKER = 'Synthetic chunk sentence marker 6604.';

async function rows<T = Row>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function asService<T = Row>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    return (await tx.query<T>(sql, params)).rows;
  });
}

/** rag_chunks_visible returns SETOF uuid: read every row (the PGlite helper's rpc returns the first row only), as service_role. */
async function chunksVisible(db: PGlite, args: Row): Promise<{ data: unknown; error: unknown }> {
  try {
    const found = await asService<{ id: string }>(db, 'SELECT id::text AS id FROM public.rag_chunks_visible($1, $2::uuid[], $3::text[], $4) AS id', [
      args.p_tenant_key,
      args.p_chunk_ids,
      args.p_access_keys ?? null,
      args.p_access_all ?? null,
    ]);
    return { data: found.map((row) => row.id), error: null };
  } catch (error) {
    return { data: null, error: { code: (error as { code?: string }).code ?? 'unknown', message: 'failed' } };
  }
}

/** The product calls rpc(...).abortSignal(signal); the PGlite client returns a plain promise, so the builder method is added here. */
function withAbortSignal(db: PGlite, client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'rpc') {
        return (name: string, args?: Row) => {
          const pending =
            name === 'rag_chunks_visible'
              ? chunksVisible(db, args ?? {})
              : (target as unknown as { rpc: (n: string, a?: Row) => Promise<unknown> }).rpc(name, args);
          return Object.assign(pending, { abortSignal: () => pending });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

async function setSwitch(on: boolean, admin: SupabaseClient): Promise<void> {
  process.env.RAG_DOC_ACCESS_GROUPS = on ? 'on' : 'off';
  configModule.resetRagConfigForTests();
  depsModule.resetRagDepsForTests();
  depsModule.setRagDepsForTests({ adminClient: () => admin });
  startupModule.resetAccessStartupForTests();
  const verdict = await startupModule.verifyAccessGroupsStartup({ backendCapabilities: async () => ({ accessFilter: true }) } as never);
  assert.equal(verdict.status, on ? 'ready' : 'off', `access startup: ${verdict.reasons.join(',')}`);
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const tenantKey = multi ? `o:${ORG}` : 's:default';

  describe(`review chunk route live access check (${mode})`, () => {
    let db: PGlite;
    let admin: SupabaseClient;
    let groupA: string;

    function ssr(userId: string): SupabaseClient {
      return pgliteClient(db, { role: 'authenticated', userId, label: 'ssr', calls: [] }) as unknown as SupabaseClient;
    }

    async function createDocument(labels: string[]): Promise<{ documentId: string; chunkId: string }> {
      const documentId = crypto.randomUUID();
      const chunkId = crypto.randomUUID();
      await db.query(
        "INSERT INTO documents (id, filename, content, user_id, organization_id) VALUES ($1, 'fixture.txt', 'A neutral synthetic body.', $2, $3)",
        [documentId, OWNER, multi ? ORG : null],
      );
      await db.query("INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, $3, 0, '{}'::jsonb)", [chunkId, documentId, MARKER]);
      await relabel(documentId, chunkId, labels);
      return { documentId, chunkId };
    }

    async function relabel(documentId: string, chunkId: string, labels: string[]): Promise<void> {
      await db.query('UPDATE documents SET access_groups = $2::text[] WHERE id = $1', [documentId, labels]);
      await db.query('UPDATE document_chunks SET access_groups = $2::text[] WHERE id = $1', [chunkId, labels]);
    }

    async function enqueue(documentId: string, chunkId: string): Promise<string> {
      const result = await asService<{ id: string }>(db, 'SELECT public.rag_enqueue_review_item($1, $2, $3::jsonb, $4::jsonb) AS id', [
        tenantKey,
        'output_guard',
        JSON.stringify({ chunk_ids: [chunkId], document_ids: [documentId] }),
        JSON.stringify({ detector: 'rules' }),
      ]);
      const id = result[0]!.id;
      await db.query('UPDATE rag_review_items SET candidates = $2::jsonb WHERE id = $1', [id, JSON.stringify([{ chunk_id: chunkId, document_id: documentId, rank: 1, similarity: 0.5 }])]);
      return id;
    }

    async function servedText(userId: string, itemId: string): Promise<string[]> {
      const result = await getReviewItemChunks(ssr(userId), admin, itemId, userId);
      if (!result.ok) return [];
      return result.chunks.filter((chunk) => chunk.available).map((chunk) => chunk.text ?? '');
    }

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      admin = withAbortSignal(db, pgliteClient(db, { role: 'service_role', label: 'admin', calls: [] }) as unknown as SupabaseClient);
      for (const id of [OWNER, MEMBER, OUTSIDER]) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, `user-${id.slice(-4)}@example.invalid`]);
      }
      if (multi) {
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace', 'review-live', $2, false)", [ORG, OWNER]);
        await db.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member') ON CONFLICT DO NOTHING",
          [ORG, OWNER, MEMBER, OUTSIDER],
        );
        groupA = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name, organization_id) VALUES ('group-a', 'Group', $1) RETURNING id", [ORG]))[0]!.id;
      } else {
        await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [OWNER]);
        groupA = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name) VALUES ('group-a', 'Group') RETURNING id"))[0]!.id;
      }
      await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [groupA, MEMBER]);
      await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING', [tenantKey, MEMBER, OUTSIDER]);
    });

    beforeEach(async () => {
      await db.query('DELETE FROM rag_review_items');
    });

    after(async () => {
      delete process.env.RAG_DOC_ACCESS_GROUPS;
      configModule.resetRagConfigForTests();
      startupModule.resetAccessStartupForTests();
      depsModule.resetRagDepsForTests();
      await db?.close();
    });

    test('after a document is relabelled to a group, its stale all set no longer serves the text to an outside expert', async () => {
      await setSwitch(true, admin);
      const { documentId, chunkId } = await createDocument(['all']);
      const itemId = await enqueue(documentId, chunkId);
      assert.deepEqual((await rows(db, 'SELECT access_sets FROM rag_review_items WHERE id = $1', [itemId]))[0]?.access_sets, [['all']]);
      await relabel(documentId, chunkId, [`g:${groupA}`]);
      assert.deepEqual(await servedText(OUTSIDER, itemId), [], 'the outsider gets no text for the relabelled chunk');
      assert.deepEqual(await servedText(MEMBER, itemId), [MARKER], 'the group member still gets the evidence');
    });

    test('an item written before enforcement (access_sets NULL) serves no restricted text to an outside expert once access is on', async () => {
      await setSwitch(false, admin);
      const { documentId, chunkId } = await createDocument([`g:${groupA}`]);
      const itemId = await enqueue(documentId, chunkId);
      assert.equal((await rows(db, 'SELECT access_sets FROM rag_review_items WHERE id = $1', [itemId]))[0]?.access_sets, null);
      await setSwitch(true, admin);
      assert.deepEqual(await servedText(OUTSIDER, itemId), [], 'the outsider gets no text for the NULL-set item');
      assert.deepEqual(await servedText(MEMBER, itemId), [MARKER]);
    });

    test('while access is off the NULL-set item serves its text to every expert, as today', async () => {
      await setSwitch(false, admin);
      const { documentId, chunkId } = await createDocument([`g:${groupA}`]);
      const itemId = await enqueue(documentId, chunkId);
      assert.deepEqual(await servedText(OUTSIDER, itemId), [MARKER]);
    });
  });
}
