import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { embedText } from '../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, type FixtureDatabase } from '../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../eval/harness/fake-edge.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');

interface SyntheticCandidate {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: null;
}

async function seedCandidates(fixture: FixtureDatabase, count: number): Promise<SyntheticCandidate[]> {
  const documentCount = Math.ceil(count / 3);
  const documentIds = Array.from({ length: documentCount }, () => crypto.randomUUID());
  for (const [index, id] of documentIds.entries()) {
    await fixture.db.query('INSERT INTO documents (id, filename, content, metadata) VALUES ($1, $2, $3, $4::jsonb)', [
      id,
      `synthetic-${index}.md`,
      `synthetic document ${index}`,
      JSON.stringify({}),
    ]);
  }
  const embedding = `[${embedText('synthetic').join(',')}]`;
  const candidates: SyntheticCandidate[] = [];
  for (let index = 0; index < count; index += 1) {
    const chunkId = crypto.randomUUID();
    const documentId = documentIds[index % documentCount];
    const content = `synthetic chunk ${index}`;
    await fixture.db.query('INSERT INTO document_chunks (id, document_id, content, embedding, metadata) VALUES ($1, $2, $3, $4::vector, $5::jsonb)', [
      chunkId,
      documentId,
      content,
      embedding,
      JSON.stringify({}),
    ]);
    candidates.push({ chunk_id: chunkId, document_id: documentId, content, similarity: 0.9, metadata: null });
  }
  return candidates;
}

describe('assembly lookups use a fixed number of queries', () => {
  const closers: Array<() => Promise<void>> = [];
  after(async () => {
    for (const close of closers.reverse()) await close();
  });

  for (const count of [5, 25, 100]) {
    test(`fetchAssemblyRows + assembleContext issue exactly 2 GETs for ${count} chunks`, async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: REAL_CORPUS });
      closers.push(() => fixture.db.close());
      const edge: FakeEdge = await startFakeEdge({ db: fixture.db });
      closers.push(() => edge.close());

      const env = fixtureProcessEnv(edge.url);
      const adminClient = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { fetchAssemblyRows } = await import('@/lib/rag/context/fetch-rows');
      const { assembleContext } = await import('@/lib/rag/context/assemble');

      const candidates = await seedCandidates(fixture, count);
      edge.calls.length = 0;

      const rows = await fetchAssemblyRows(candidates, { adminClient, signal: new AbortController().signal });
      const result = assembleContext({
        queryText: 'synthetic',
        candidates,
        documents: rows.documents,
        chunkMetadata: rows.chunkMetadata,
        referenced: null,
        isGPTModel: false,
        ragMode: 'strict',
        webSearchEnabled: false,
        applyRelevanceFilter: true,
      });

      const reads = edge.calls.filter((call) => call.method === 'GET');
      assert.deepEqual(reads.map((call) => call.path).sort(), ['/rest/v1/document_chunks', '/rest/v1/documents']);
      assert.equal(edge.calls.length, 2);
      assert.equal(rows.documents.size, Math.ceil(count / 3));
      assert.equal(rows.chunkMetadata.size, count);
      assert.equal(result.relevantChunks.length, count);
      assert.deepEqual(edge.errors, []);
    });
  }
});
