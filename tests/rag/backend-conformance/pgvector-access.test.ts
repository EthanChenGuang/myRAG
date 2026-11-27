import { createClient } from '@supabase/supabase-js';
import { createPgvectorBackend } from '@/lib/rag/backend/pgvector';
import { loadRagConfig } from '@/lib/rag/config';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import { queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { fixtureProcessEnv, startFakeEdge } from '../../../eval/harness/fake-edge.mts';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { createEmptyFixtureDatabase, runFixtureRelex } from '../../../eval/harness/pglite-supabase.mts';
import { runAccessConformance, type AccessConformanceContext, type AccessDataset } from './access-cases';
import { EXACT_SCAN_CUTOFF, PROFILE_ID } from './dataset';

async function pgvectorAccessFactory(dataset: AccessDataset): Promise<AccessConformanceContext> {
  const { db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', supabaseGrants: true });
  try {
    const { memberA, outsider, admin } = dataset.members;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
      memberA,
      'access-member-a@example.invalid',
      outsider,
      'access-outsider@example.invalid',
      admin,
      'access-admin@example.invalid',
    ]);
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
      dataset.orgId,
      'Access conformance workspace',
      'access-conformance',
      admin,
    ]);
    await db.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'admin')",
      [dataset.orgId, memberA, outsider, admin],
    );
    await db.query('INSERT INTO rag_access_groups (id, key, name, organization_id) VALUES ($1, $2, $3, $4)', [
      dataset.groupA,
      'group-a',
      'Group A',
      dataset.orgId,
    ]);
    await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [dataset.groupA, memberA]);
    for (const row of dataset.rows) {
      const stored = `Document: ${row.filename}. Chunk 1 of 1. Content: ${row.body}`;
      await db.query(
        `INSERT INTO documents (id, filename, content, user_id, organization_id, language, doc_type, is_current, status, access_groups)
         VALUES ($1, $2, $3, $4, $5, $6, 'general', true, 'ready', $7::text[])`,
        [row.documentId, row.filename, row.body, admin, dataset.orgId, row.language, row.accessGroups],
      );
      // The copy trigger (0921) gives the chunk its document's array.
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, chunk_index, metadata, organization_id, language, doc_type, is_current, status)
         VALUES ($1, $2, $3, $4::vector, $5, 0, '{}'::jsonb, $6, $7, 'general', true, 'ready')`,
        [
          row.chunkId,
          row.documentId,
          stored,
          `[${embedText(row.body).join(',')}]`,
          chunkLexicalText({ sectionPath: [], content: stored, documentFilename: row.filename }),
          dataset.orgId,
          row.language,
        ],
      );
    }
    await runFixtureRelex(db);
    const edge = await startFakeEdge({ db });
    const env = fixtureProcessEnv(edge.url);
    const client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_EXACT_SCAN_CUTOFF: String(EXACT_SCAN_CUTOFF), RAG_HNSW_ITERATIVE_SCAN: 'off' });
    return {
      backend: createPgvectorBackend({ adminClient: () => client, getConfig: () => config }),
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

runAccessConformance('pgvector', pgvectorAccessFactory);
