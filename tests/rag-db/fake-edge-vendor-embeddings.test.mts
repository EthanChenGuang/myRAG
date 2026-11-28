import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

// 07-25: the fixture regression re-embeds the corpus for bge-m3-1024 through the fake DeepInfra route; BAAI/bge-m3 is 1024-dimensional,
// so a 1536-dimensional answer made the re-embed fail with embedding_profile_mismatch.
describe('fake edge vendor embedding routes', () => {
  let db: PGlite;
  let edge: FakeEdge;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    edge = await startFakeEdge({ db });
  });

  after(async () => {
    await edge?.close();
    await db?.close();
  });

  async function embed(model: string): Promise<{ model: string; dims: number }> {
    const res = await fetch(`${edge.url}/deepinfra/v1/openai/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer deepinfra-fixture-placeholder-key-00' },
      body: JSON.stringify({ model, input: ['a neutral synthetic sentence'] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { model: string; data: Array<{ embedding: number[] }> };
    return { model: body.model, dims: body.data[0]!.embedding.length };
  }

  test('BAAI/bge-m3 answers with its native 1024 dimensions', async () => {
    assert.deepEqual(await embed('BAAI/bge-m3'), { model: 'BAAI/bge-m3', dims: 1024 });
  });

  test('a Qwen model keeps 4096 dimensions', async () => {
    assert.equal((await embed('Qwen/Qwen3-Embedding-8B')).dims, 4096);
  });
});
