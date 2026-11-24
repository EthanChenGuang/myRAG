import { createClient } from '@supabase/supabase-js';
import { createPgvectorBackend } from '@/lib/rag/backend/pgvector';
import { loadRagConfig } from '@/lib/rag/config';
import { mintScope } from '@/lib/rag/tenant/scope';
import { queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { createEmptyFixtureDatabase, runFixtureRelex } from '../../../eval/harness/pglite-supabase.mts';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { fixtureProcessEnv, startFakeEdge } from '../../../eval/harness/fake-edge.mts';
import type { ConformanceContext } from './cases';
import { EXACT_SCAN_CUTOFF, IDS, PROFILE_ID, loadConformanceDataset } from './dataset';

export async function pgvectorFactory(): Promise<ConformanceContext> {
  const empty = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', supabaseGrants: true });
  const { db } = empty;
  try {
    await loadConformanceDataset(db);
    await runFixtureRelex(db);
    const edge = await startFakeEdge({ db });
    const env = fixtureProcessEnv(edge.url);
    const client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const config = loadRagConfig({
      RAG_PIPELINE: 'v2',
      RAG_EXACT_SCAN_CUTOFF: String(EXACT_SCAN_CUTOFF),
      RAG_HNSW_ITERATIVE_SCAN: 'off',
    });
    const backend = createPgvectorBackend({
      adminClient: () => client,
      getConfig: () => config,
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
        await edge.close();
        await db.close();
      },
    };
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}