import { beforeEach, describe, expect, it } from 'vitest';
import { createSupabaseFake } from './helpers/chat-route-fakes';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const ORG = '00000000-0000-4000-8000-0000000000e1';

function seed() {
  const fake = createSupabaseFake();
  fake.store.documents = [
    { id: A, filename: 'Refund Policy.pdf', organization_id: null, user_id: 'u1' },
    { id: B, filename: 'shipping.md', organization_id: ORG, user_id: 'u1' },
    { id: C, filename: 'REFUND-faq.md', organization_id: null, user_id: 'u2' },
  ] as never;
  return fake;
}

async function rows(builder: unknown) {
  const result = (await builder) as { data: Array<{ id: string }>; error: unknown };
  expect(result.error).toBeNull();
  return result.data.map((row) => row.id);
}

describe('createSupabaseFake filtering', () => {
  let fake: ReturnType<typeof seed>;
  beforeEach(() => {
    fake = seed();
  });

  it('in() keeps only the listed ids', async () => {
    expect(await rows(fake.client.from('documents').select('*').in('id', [A, C]))).toEqual([A, C]);
  });

  it('is() with null keeps only rows whose column is null or missing', async () => {
    expect(await rows(fake.client.from('documents').select('*').is('organization_id', null))).toEqual([A, C]);
  });

  it('eq() still filters and chains with is()', async () => {
    const result = fake.client.from('documents').select('*').is('organization_id', null).eq('user_id', 'u2');
    expect(await rows(result)).toEqual([C]);
  });

  it('ilike() matches case-insensitively with % wildcards', async () => {
    expect(await rows(fake.client.from('documents').select('*').ilike('filename', '%Refund%'))).toEqual([A, C]);
    expect(await rows(fake.client.from('documents').select('*').ilike('filename', 'ship%'))).toEqual([B]);
    expect(await rows(fake.client.from('documents').select('*').ilike('filename', 'ship'))).toEqual([]);
  });

  it('limit() truncates the filtered rows', async () => {
    expect(await rows(fake.client.from('documents').select('*').in('id', [A, B, C]).limit(2))).toEqual([A, B]);
  });

  it('single() and maybeSingle() keep their result shapes', async () => {
    const found = await fake.client.from('documents').select('*').eq('id', B).single();
    expect(found).toMatchObject({ data: { id: B }, error: null });
    const missing = await fake.client.from('documents').select('*').eq('id', 'nope').single();
    expect(missing).toMatchObject({ data: null, error: { code: 'PGRST116' } });
    const maybe = await fake.client.from('documents').select('*').eq('id', 'nope').maybeSingle();
    expect(maybe).toEqual({ data: null, error: null });
  });

  it('serves tables other than documents and document_chunks from the same rows map', async () => {
    fake.store.organization_members = [{ organization_id: ORG, user_id: 'u1', role: 'member' }];
    const hit = await fake.client.from('organization_members').select('*').eq('organization_id', ORG).eq('user_id', 'u1').maybeSingle();
    expect((hit as { data: { role: string } }).data.role).toBe('member');
    const miss = await fake.client.from('organization_members').select('*').eq('organization_id', ORG).eq('user_id', 'u9').maybeSingle();
    expect(miss).toEqual({ data: null, error: null });
  });

  it('or() and not() stay pass-through filters', async () => {
    expect(await rows(fake.client.from('documents').select('*').or('filename.ilike.%x%').not('id', 'is', null))).toEqual([A, B, C]);
  });
});

describe('createSupabaseFake call recorder', () => {
  it('records every chained call with table, method and arguments', async () => {
    const fake = seed();
    await fake.client.from('documents').select('id,filename').in('id', [A, B]).is('organization_id', null).limit(5);
    expect(fake.store.calls).toEqual([
      { table: 'documents', method: 'select', args: ['id,filename'] },
      { table: 'documents', method: 'in', args: ['id', [A, B]] },
      { table: 'documents', method: 'is', args: ['organization_id', null] },
      { table: 'documents', method: 'limit', args: [5] },
    ]);
  });

  it('records or and not even though they do not filter', async () => {
    const fake = seed();
    await fake.client.from('document_chunks').select('id').or('content.ilike.%x%').not('metadata->>image_url', 'is', 'null');
    expect(fake.store.calls.map((call) => ('method' in call ? call.method : call.rpc))).toEqual(['select', 'or', 'not']);
  });

  it('records rpc calls separately and in call order', async () => {
    const fake = seed();
    await fake.client.rpc('match_documents_by_workspace', { p_org_id: null, p_user_id: A });
    expect(fake.store.rpcCalls).toEqual([{ rpc: 'match_documents_by_workspace', args: { p_org_id: null, p_user_id: A } }]);
    expect(fake.store.calls).toEqual(fake.store.rpcCalls);
  });

  it('reset() clears recorded calls but keeps rows', async () => {
    const fake = seed();
    await fake.client.from('documents').select('*');
    await fake.client.rpc('x', {});
    fake.store.reset();
    expect(fake.store.calls).toEqual([]);
    expect(fake.store.rpcCalls).toEqual([]);
    expect(fake.store.documents).toHaveLength(3);
  });
});
