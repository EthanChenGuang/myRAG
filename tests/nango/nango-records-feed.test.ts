import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nango/client', () => ({ getNango: () => { throw new Error('no default client in tests'); } }));

import { NangoRecordsFeed, type NangoRecordsClient } from '@/lib/nango/change-feed';

type Call = Parameters<NangoRecordsClient['listRecords']>[0];

function pagedClient(pages: Array<{ records: unknown[]; next_cursor: string | null }>) {
  const calls: Call[] = [];
  const client: NangoRecordsClient = {
    async listRecords(input) {
      calls.push({ ...input });
      const page = pages[calls.length - 1];
      if (!page) throw new Error('unexpected page');
      return page;
    },
  };
  return { client, calls };
}

const deleted = (id: string, cursor: string) => ({ id, _nango_metadata: { last_action: 'DELETED', cursor } });
const signal = () => new AbortController().signal;

describe('NangoRecordsFeed (D-04, D-05)', () => {
  it('reads deleted records from the stored cursor over every page', async () => {
    const { client, calls } = pagedClient([
      { records: [deleted('file-1', 'c1')], next_cursor: 'p1' },
      { records: [deleted('file-2', 'c2')], next_cursor: null },
    ]);
    const feed = new NangoRecordsFeed({ providerConfigKey: 'box', model: 'files', client });
    const page = await feed.read({ connectionId: 'conn-1', cursor: 'stored', deadline: Date.now() + 10_000, signal: signal() });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ providerConfigKey: 'box', connectionId: 'conn-1', model: 'files', filter: 'deleted', cursor: 'stored', limit: 100 });
    expect(calls[1].cursor).toBe('p1');
    expect(calls.every((call) => call.filter === 'deleted')).toBe(true);
    expect(page.changes.map((change) => [change.fileId, change.deleted, change.cursor])).toEqual([
      ['file-1', true, 'c1'],
      ['file-2', true, 'c2'],
    ]);
    expect(page).toMatchObject({ nextCursor: 'c2', complete: true, fullListing: false });
  });

  it('stops at the deadline with complete false and the cursor of what it read', async () => {
    let clock = 0;
    const { client, calls } = pagedClient([
      { records: [deleted('file-1', 'c1')], next_cursor: 'p1' },
      { records: [deleted('file-2', 'c2')], next_cursor: null },
    ]);
    const feed = new NangoRecordsFeed({
      providerConfigKey: 'box',
      model: 'files',
      client: { listRecords: async (input) => { clock += 1_000; return client.listRecords(input); } },
      now: () => clock,
    });
    const page = await feed.read({ connectionId: 'conn-1', cursor: null, deadline: 1_000, signal: signal() });

    expect(calls).toHaveLength(1);
    expect(page).toMatchObject({ complete: false, nextCursor: 'p1' });
    expect(page.changes.map((change) => change.fileId)).toEqual(['file-1']);
  });

  it('returns no cursor when nothing was read and marks non-deleted actions as not deleted', async () => {
    const empty = pagedClient([{ records: [], next_cursor: null }]);
    const feed = new NangoRecordsFeed({ providerConfigKey: 'box', model: 'files', client: empty.client });
    expect(await feed.read({ connectionId: 'conn-1', cursor: null, deadline: Date.now() + 1_000, signal: signal() })).toEqual({
      changes: [],
      nextCursor: null,
      complete: true,
      fullListing: false,
    });

    const mixed = pagedClient([{ records: [{ id: 'file-3', _nango_metadata: { last_action: 'UPDATED', cursor: 'c3' } }], next_cursor: null }]);
    const page = await new NangoRecordsFeed({ providerConfigKey: 'box', model: 'files', client: mixed.client }).read({
      connectionId: 'conn-1',
      cursor: null,
      deadline: Date.now() + 1_000,
      signal: signal(),
    });
    expect(page.changes).toEqual([{ fileId: 'file-3', deleted: false, kind: 'file', cursor: 'c3' }]);
  });

  it('reads nothing once the signal is aborted', async () => {
    const { client, calls } = pagedClient([{ records: [deleted('file-1', 'c1')], next_cursor: null }]);
    const controller = new AbortController();
    controller.abort();
    const page = await new NangoRecordsFeed({ providerConfigKey: 'box', model: 'files', client }).read({
      connectionId: 'conn-1',
      cursor: null,
      deadline: Date.now() + 1_000,
      signal: controller.signal,
    });
    expect(calls).toHaveLength(0);
    expect(page.complete).toBe(false);
  });
});
