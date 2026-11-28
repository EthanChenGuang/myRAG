import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { RETRIEVAL_BACKEND_IDS, type BackendId } from '@/lib/rag/backend/types';
import type { CanaryAnswer, CanaryEnv } from './factory';
import { CANARY_SENTENCE, canaryBackends, createCanaryEnv, isExternalBackend, leaked } from './factory';
import { canaryText, ingestCanaryDocument, markerFor } from './seed';

const ENABLED = canaryBackends();
const SETUP_TIMEOUT = 180_000;
const CASE_TIMEOUT = 120_000;
const OTHER_TARGET: Record<string, string> = { qdrant: 'weaviate', weaviate: 'qdrant' };

interface Doc {
  documentId: string;
  chunkIds: string[];
  marker: string;
}

interface RepairCall {
  fn: string;
  args: Record<string, unknown>;
}

function silenceLogs(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function searchAttributes(answer: CanaryAnswer): Record<string, unknown> {
  return (answer.result.stages.find((stage) => stage.name === 'search')?.attributes ?? {}) as Record<string, unknown>;
}

function countOf(calls: string[], fn: string): number {
  return calls.filter((name) => name === fn).length;
}

for (const backend of RETRIEVAL_BACKEND_IDS as readonly BackendId[]) {
  if (!isExternalBackend(backend)) continue;
  describe.runIf(ENABLED.includes(backend))(`forced source-of-truth recheck and its repair (${backend})`, () => {
    let env: CanaryEnv;
    let repair: typeof import('@/lib/rag/backend/stale-repair');
    let deps: typeof import('@/lib/rag/deps');
    let config: typeof import('@/lib/rag/config');
    let factory: typeof import('@/lib/rag/backend/factory');
    const tasks: Array<() => Promise<void>> = [];
    const repairCalls: RepairCall[] = [];
    let kicks = 0;

    const installRepair = () => {
      repair.resetStaleRepairForTests();
      tasks.length = 0;
      repairCalls.length = 0;
      kicks = 0;
      const recording = {
        rpc(fn: string, args: Record<string, unknown>) {
          repairCalls.push({ fn, args });
          return env.client.rpc(fn, args);
        },
      } as unknown as RpcClient;
      // The scheduler is injected: the task is collected and run right after the response, in place of next/server after().
      repair.setStaleRepairDepsForTests({ schedule: (task) => void tasks.push(task), kick: () => void (kicks += 1), rpc: () => recording });
    };

    /** One request with RAG_SOURCE_RECHECK set as given; ask() layers the v2 pipeline and the backend under test on top. */
    const askWith = async (label: 'a' | 'b', question: string, sourceRecheck: boolean): Promise<CanaryAnswer> => {
      const current = deps.getRagDeps();
      const previous = current.ragEnv;
      const base = previous();
      deps.setRagDepsForTests({ ragEnv: () => ({ ...base, RAG_SOURCE_RECHECK: sourceRecheck ? 'true' : 'false' }) });
      config.resetRagConfigForTests();
      // The external backend keeps the admin client it was built with; rebuilding it inside ask() puts the re-validation call on the
      // request's recording client, so rpcCalls counts every rag_validate_chunks call of this request.
      factory.resetBackendFactoryForTests();
      try {
        return await env.ask(env.tenants[label]!.scope, question);
      } finally {
        deps.setRagDepsForTests({ ragEnv: previous });
        config.resetRagConfigForTests();
        factory.resetBackendFactoryForTests();
      }
    };

    const seedDoc = async (label: string): Promise<Doc> => {
      const a = env.tenants.a!;
      const marker = markerFor(env, label);
      const written = await ingestCanaryDocument(env, { scope: a.scope, filename: `canary-${label}-${env.nonce}.md`, text: canaryText(marker), uploaderId: a.userId });
      expect(written.status).toBe('ready');
      await env.settle();
      return { documentId: written.documentId, chunkIds: written.chunkIds.map((id) => id.toLowerCase()), marker };
    };

    const storeIds = async (doc: Doc): Promise<string[]> => {
      const { LEGACY_PROFILE } = await import('./factory');
      return (await env.store!.listDocumentIds(LEGACY_PROFILE, env.tenants.a!.tenantKey, doc.documentId)).map((id) => id.toLowerCase()).sort();
    };

    /** Deleted in Supabase; the outbox row the delete enqueued is not drained (the drain is paused). */
    const deleteWithoutDrain = async (doc: Doc): Promise<void> => {
      await env.sql('DELETE FROM public.documents WHERE id = $1', [doc.documentId]);
      expect(await storeIds(doc), 'negative control: the store still holds the deleted document').toEqual([...doc.chunkIds].sort());
    };

    const expectDropped = (answer: CanaryAnswer, doc: Doc) => {
      expect(answer.backend, `${backend} served the request`).toBe(backend);
      expect(answer.documentIds).not.toContain(doc.documentId);
      expect(answer.chunkIds.filter((id) => doc.chunkIds.includes(id.toLowerCase()))).toEqual([]);
      expect(answer.texts.some((text) => text.includes(doc.marker)), 'no text of the deleted document').toBe(false);
      expect(Number(searchAttributes(answer).stale_index_drop)).toBeGreaterThanOrEqual(1);
      expect(answer.result.sourceRecheck?.dropped).toBeGreaterThanOrEqual(1);
      expect(countOf(answer.rpcCalls, 'rag_validate_chunks'), 'one re-validation query').toBe(1);
      expect(countOf(answer.rpcCalls, 'rag_source_recheck'), 'no second recheck query').toBe(0);
      expect(answer.result.stages.some((stage) => stage.name === 'source_recheck')).toBe(false);
      expect(countOf(answer.rpcCalls, 'rag_vector_sync_enqueue_stale'), 'nothing is enqueued before the response').toBe(0);
    };

    /** Runs the scheduled repair, checks it enqueued chunk rows for this backend and tenant a only, then one drain clears the points. */
    const repairAndDrain = async (doc: Doc) => {
      expect(tasks.length, 'one repair is scheduled').toBe(1);
      const before = await env.sql<{ id: string }>('SELECT id::text AS id FROM public.vector_sync_outbox');
      const seen = new Set(before.map((row) => row.id));
      for (const task of tasks.splice(0)) await task();
      const enqueued = repairCalls.filter((call) => call.fn === 'rag_vector_sync_enqueue_stale');
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.args).toMatchObject({ p_target: backend, p_tenant_key: env.tenants.a!.tenantKey });
      const ids = (enqueued[0]!.args.p_chunk_ids as string[]).map((id) => id.toLowerCase());
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => doc.chunkIds.includes(id)), 'only the dropped chunks').toBe(true);
      expect(kicks).toBe(1);

      const rows = await env.sql<{ id: string; target: string; tenant_key: string; entity: string; entity_id: string }>(
        'SELECT id::text AS id, target, tenant_key, entity, entity_id FROM public.vector_sync_outbox',
      );
      const added = rows.filter((row) => !seen.has(row.id));
      expect(added.length, 'the repair wrote chunk rows').toBeGreaterThan(0);
      for (const row of added) {
        expect(row).toMatchObject({ target: backend, tenant_key: env.tenants.a!.tenantKey, entity: 'chunk' });
        expect(doc.chunkIds).toContain(String(row.entity_id).toLowerCase());
      }
      expect(added.some((row) => row.target === OTHER_TARGET[backend]), 'nothing for the other backend').toBe(false);

      await env.drain();
      expect(await storeIds(doc), 'one drain removes the stale points').toEqual([]);
    };

    beforeAll(async () => {
      silenceLogs();
      env = await createCanaryEnv(backend, 'multi-tenant');
      [repair, deps, config, factory] = await Promise.all([
        import('@/lib/rag/backend/stale-repair'),
        import('@/lib/rag/deps'),
        import('@/lib/rag/config'),
        import('@/lib/rag/backend/factory'),
      ]);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      repair?.resetStaleRepairForTests();
      await env?.close();
      vi.restoreAllMocks();
    });

    beforeEach(() => {
      silenceLogs();
      installRepair();
    });

    it(
      'RAG_SOURCE_RECHECK off: a deleted, undrained document never reaches the result, stale_index_drop counts it, the repair clears the store',
      async () => {
        const doc = await seedDoc('rcoff');
        const question = `${CANARY_SENTENCE} ${doc.marker}`;
        const control = await askWith('a', question, false);
        expect(control.documentIds, 'negative control: the document is found before the delete').toContain(doc.documentId);
        expect(Number(searchAttributes(control).stale_index_drop)).toBe(0);
        const bBefore = await askWith('b', CANARY_SENTENCE, false);
        installRepair();

        await deleteWithoutDrain(doc);
        const legs = await env.search(env.tenants.a!.scope, question);
        expect(legs.selection.backend).toBe(backend);
        expect(leaked(legs.legs.dense, [doc.marker], doc.chunkIds), 'dense leg').toEqual([]);
        expect(leaked(legs.legs.lexical, [doc.marker], doc.chunkIds), 'lexical leg').toEqual([]);

        const answer = await askWith('a', question, false);
        expectDropped(answer, doc);

        const bAfter = await askWith('b', CANARY_SENTENCE, false);
        expect(bAfter.backend).toBe(backend);
        expect(bAfter.chunkIds.sort(), 'tenant b is unchanged').toEqual(bBefore.chunkIds.sort());
        expect(bAfter.documentIds.sort()).toEqual(bBefore.documentIds.sort());
        expect(Number(searchAttributes(bAfter).stale_index_drop)).toBe(0);

        await repairAndDrain(doc);
        const again = await askWith('a', question, false);
        expect(again.backend).toBe(backend);
        expect(Number(searchAttributes(again).stale_index_drop), 'nothing left to drop').toBe(0);
        expect(again.documentIds).not.toContain(doc.documentId);
      },
      CASE_TIMEOUT,
    );

    it(
      'RAG_SOURCE_RECHECK on: the same result with one rag_validate_chunks call and no second recheck query',
      async () => {
        const doc = await seedDoc('rcon');
        const question = `${CANARY_SENTENCE} ${doc.marker}`;
        const control = await askWith('a', question, true);
        expect(control.documentIds, 'negative control: the document is found before the delete').toContain(doc.documentId);
        installRepair();

        await deleteWithoutDrain(doc);
        const answer = await askWith('a', question, true);
        expectDropped(answer, doc);

        await repairAndDrain(doc);
        const again = await askWith('a', question, true);
        expect(Number(searchAttributes(again).stale_index_drop)).toBe(0);
        expect(countOf(again.rpcCalls, 'rag_source_recheck')).toBe(0);
      },
      CASE_TIMEOUT,
    );
  });
}
