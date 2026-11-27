import { weaviateCollectionName } from '@/lib/rag/backend/tenant-key';
import { createWeaviateBackend } from '@/lib/rag/backend/weaviate/adapter';
import { getWeaviateReadClient, getWeaviateWriteClient } from '@/lib/rag/backend/weaviate/client';
import type { WeaviateClientLike } from '@/lib/rag/backend/weaviate/types';
import { queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { createWeaviateStore } from '@/lib/rag/sync/stores/weaviate';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createEmptyFixtureDatabase } from '../../../eval/harness/pglite-supabase.mts';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { startFakeEdge } from '../../../eval/harness/fake-edge.mts';
import type { ConformanceContext } from './cases';
import { IDS, PROFILE_ID } from './dataset';
import { seedExternalStore } from './external-seed';

/**
 * D-12: the conformance dataset reaches Weaviate only through the database, the outbox and drainSlice with the write client;
 * retrieval uses the read client and re-validates every id against the same PGlite database. The collection is dropped on close.
 */
export async function weaviateFactory(clients?: { read: WeaviateClientLike; write: WeaviateClientLike }): Promise<ConformanceContext> {
  const { db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', supabaseGrants: true });
  const collection = weaviateCollectionName(PROFILE_ID);
  let edge: Awaited<ReturnType<typeof startFakeEdge>> | null = null;
  try {
    edge = await startFakeEdge({ db });
    const writeClient = clients?.write ?? (await getWeaviateWriteClient());
    const readClient = clients?.read ?? (await getWeaviateReadClient());
    if (await writeClient.collections.exists(collection)) await writeClient.collections.delete(collection);
    const store = createWeaviateStore({ client: writeClient });
    const seeded = await seedExternalStore({ db, edge, store, target: 'weaviate', profileId: PROFILE_ID });
    const backend = createWeaviateBackend({
      readClient,
      revalidate: () => seeded.client,
      readiness: async () => true,
    });
    const openEdge = edge;
    return {
      backend,
      scopes: {
        tenantA: mintScope('personal', IDS.userA, null),
        tenantB: mintScope('personal', IDS.userB, null),
        orgO: mintScope('org', IDS.userA, IDS.orgO),
      },
      profileId: PROFILE_ID,
      embed: embedText,
      queryTokens: queryLexicalTokens,
      close: async () => {
        await writeClient.collections.delete(collection).catch(() => undefined);
        await openEdge.close();
        await db.close();
      },
    };
  } catch (error) {
    await edge?.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    throw error;
  }
}
