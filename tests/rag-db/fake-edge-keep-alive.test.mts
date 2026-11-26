import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

// PGlite runs in the same process as the fake edge, and its synchronous WASM work can block the event loop for seconds
// (train 30: an UPDATE over ~600 halfvec(2048) rows under CI load). A request on a kept-alive socket after such a block
// must not fail with "fetch failed" because the server timed the idle socket out in the same turn.
describe('fake edge after a blocked event loop', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let supabaseModule: typeof import('@/lib/supabase');

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  test('a kept-alive request after a seven-second block still reaches the database', async () => {
    const admin = supabaseModule.getSupabaseAdmin();
    const call = () => admin.rpc('rag_activate_embedding_profile' as never, { p_target: 'no-such-profile', p_actor: 'test' } as never);
    const warm = await call();
    assert.equal(warm.error?.code, '22023');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const end = Date.now() + 7000;
    while (Date.now() < end) {
      // block the event loop the way a long synchronous PGlite statement does
    }
    const afterBlock = await call();
    assert.equal(afterBlock.error?.code, '22023', JSON.stringify(afterBlock.error));
    assert.match(String(afterBlock.error?.message), /activation_refused: unknown_profile/);
  });
});
