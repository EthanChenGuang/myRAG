import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { startFakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

describe('eval profile harness fixtures', () => {
  let db: Awaited<ReturnType<typeof createEmptyFixtureDatabase>>['db'] | undefined;
  let edge: Awaited<ReturnType<typeof startFakeEdge>> | undefined;

  after(async () => {
    await edge?.close();
    await db?.close();
  });

  test('embedText default dims matches the historical 1536 baseline', () => {
    const a = embedText('refund policy annual window');
    const b = embedText('refund policy annual window', 1536);
    assert.equal(a.length, 1536);
    assert.deepEqual(a, b);
  });

  test('embedText with 2048 is deterministic and unit norm', () => {
    const first = embedText('onboarding workflow', 2048);
    const second = embedText('onboarding workflow', 2048);
    assert.equal(first.length, 2048);
    assert.deepEqual(first, second);
    const norm = Math.sqrt(first.reduce((sum, x) => sum + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-6);
  });

  test('fake edge voyage embeddings honour output_dimension', async () => {
    const fixture = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' });
    db = fixture.db;
    edge = await startFakeEdge({ db });
    const res = await fetch(`${edge.url}/voyage/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello', output_dimension: 2048, input_type: 'query' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
    assert.equal(body.data[0]?.embedding.length, 2048);
    const voyageCall = edge.calls.find((call) => call.path === '/voyage/v1/embeddings');
    assert.ok(voyageCall);
  });
});