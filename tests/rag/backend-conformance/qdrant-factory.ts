import { createQdrantBackend } from '@/lib/rag/backend/qdrant/adapter';
import { buildQdrantClients } from '@/lib/rag/backend/qdrant/client';
import { qdrantErrorStatus } from '@/lib/rag/backend/qdrant/errors';
import { qdrantCollectionName } from '@/lib/rag/backend/tenant-key';
import { queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { createQdrantStore } from '@/lib/rag/sync/stores/qdrant';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createEmptyFixtureDatabase } from '../../../eval/harness/pglite-supabase.mts';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { startFakeEdge } from '../../../eval/harness/fake-edge.mts';
import type { ConformanceContext } from './cases';
import { IDS, PROFILE_ID } from './dataset';
import { seedExternalStore } from './external-seed';

/** The local compose service's placeholder keys (docker-compose.backends.yml); CI overrides them through the environment. */
const LOCAL_WRITE_KEY = 'local-qdrant-write-key-placeholder-000000';
const LOCAL_READ_KEY = 'local-qdrant-read-key-placeholder-0000000';

/**
 * The Phase 4 dataset in PGlite, seeded into a real Qdrant only through the outbox and the drain (write key), then served by the Qdrant
 * backend over the read key with every id re-validated against PGlite. The collection is dropped before seeding and on close.
 */
export async function qdrantFactory(): Promise<ConformanceContext> {
  const url = process.env.QDRANT_URL ?? '';
  if (!url) throw new Error('qdrantFactory needs QDRANT_URL');
  const clients = buildQdrantClients(
    {
      url,
      apiKey: process.env.QDRANT_API_KEY || LOCAL_WRITE_KEY,
      readApiKey: process.env.QDRANT_READ_API_KEY || LOCAL_READ_KEY,
      nodeEnv: 'test',
    },
    { warn: () => undefined },
  );
  const collection = qdrantCollectionName(PROFILE_ID);
  const drop = async () => {
    try {
      await clients.write.deleteCollection(collection);
    } catch (error) {
      if (qdrantErrorStatus(error) !== 404) throw error;
    }
  };
  await drop();

  const { db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', supabaseGrants: true });
  const edge = await startFakeEdge({ db });
  try {
    const store = createQdrantStore({ writeClient: clients.write });
    const { client } = await seedExternalStore({ db, edge, store, target: 'qdrant', profileId: PROFILE_ID });
    const backend = createQdrantBackend({
      readClient: clients.read,
      adminClient: () => client,
      readiness: async () => true,
    });
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
        await drop();
        await edge.close();
        await db.close();
      },
    };
  } catch (error) {
    await drop().catch(() => undefined);
    await edge.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    throw error;
  }
}
