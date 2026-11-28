import { createClient } from '@supabase/supabase-js';
import { createPgvectorBackend } from '@/lib/rag/backend/pgvector';
import { loadRagConfig } from '@/lib/rag/config';
import { mintScope } from '@/lib/rag/tenant/scope';
import { queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import crypto from 'node:crypto';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
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
      seedVersionHistory: async () => {
        const token = 'versionhistorymarker';
        const identifier = 'vh-0001';
        const lineage = crypto.randomUUID();
        const [oldDoc, newDoc, oldChunk, newChunk] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
        const rows = [
          { doc: newDoc, chunk: newChunk, version: 2, current: true, text: `${token} second neutral wording`, created: '2025-06-02T00:00:00Z' },
          { doc: oldDoc, chunk: oldChunk, version: 1, current: false, text: `${token} first neutral wording`, created: '2025-06-01T00:00:00Z' },
        ];
        for (const row of rows) {
          await db.query(
            `INSERT INTO documents (id, filename, content, user_id, lineage_id, version, is_current, status, superseded_by, content_hash, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready', $8, $9, $10::timestamptz)`,
            [row.doc, `history-v${row.version}.md`, row.text, IDS.userA, lineage, row.version, row.current, row.current ? null : newDoc, `hash-${row.version}-${lineage}`, row.created],
          );
          await db.query(
            `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, chunk_index, metadata, language, doc_type, is_current, status, identifiers_norm)
             VALUES ($1, $2, $3, $4::vector, $5, 0, '{}'::jsonb, 'en', 'general', $6, 'ready', $7::text[])`,
            [
              row.chunk,
              row.doc,
              row.text,
              row.current ? `[${embedText(row.text).join(',')}]` : null,
              chunkLexicalText({ sectionPath: [], content: row.text, documentFilename: `history-v${row.version}.md` }),
              row.current,
              row.current ? [identifier] : null,
            ],
          );
        }
        return { token, identifier, supersededChunkId: oldChunk, currentChunkId: newChunk };
      },
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