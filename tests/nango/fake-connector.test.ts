import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import type { ChangePage, ListingResult, SourceChangeFeed } from '@/lib/nango/change-feed';
import { createFakeConnector } from '../helpers/fake-connector';
import { createPgliteAdmin } from '../helpers/pglite-admin';

const change = (fileId: string, deleted = false) => ({ fileId, deleted, kind: 'file' as const, name: `${fileId}.pdf` });
const read = (feed: SourceChangeFeed, cursor: string | null) =>
  feed.read({ connectionId: 'conn-fake', cursor, deadline: Date.now() + 60_000, signal: new AbortController().signal });

describe('change-feed types', () => {
  it('requires completeness on pages and listings', () => {
    expectTypeOf<ChangePage['fullListing']>().toEqualTypeOf<boolean>();
    expectTypeOf<ChangePage['complete']>().toEqualTypeOf<boolean>();
    expectTypeOf<ListingResult['complete']>().toEqualTypeOf<boolean>();
    expectTypeOf<ChangePage['nextCursor']>().toEqualTypeOf<string | null>();
  });
});

describe('fake connector (D-27)', () => {
  it('serves pages in order with nextCursor until null', async () => {
    const feed = createFakeConnector({ files: ['file-a'], pages: [[change('file-a')], [change('file-b', true)], [change('file-c')]] });
    const first = await read(feed, null);
    const second = await read(feed, first.nextCursor);
    const third = await read(feed, second.nextCursor);
    expect([first.nextCursor, second.nextCursor, third.nextCursor]).toEqual(['cursor-1', 'cursor-2', null]);
    expect([first.complete, second.complete, third.complete]).toEqual([false, false, true]);
    expect(second.changes).toEqual([change('file-b', true)]);
    expect(feed.reads.map((entry) => entry.cursor)).toEqual([null, 'cursor-1', 'cursor-2']);
    expect(first.fullListing).toBe(false);
  });

  it('lists completely, then reports a cut listing as incomplete', async () => {
    const feed = createFakeConnector({ files: ['file-a', 'file-b', 'file-c'] });
    await expect(feed.list()).resolves.toEqual({ fileIds: ['file-a', 'file-b', 'file-c'], complete: true });
    feed.cutListing(1);
    await expect(feed.list()).resolves.toEqual({ fileIds: ['file-a'], complete: false });
    feed.reset();
    feed.setFiles(['file-a', 'file-b']);
    await expect(feed.list()).resolves.toEqual({ fileIds: ['file-a', 'file-b'], complete: true });
  });

  it('throws on a failing listing and a failing read', async () => {
    const feed = createFakeConnector({ files: ['file-a'], pages: [[change('file-a')]] });
    feed.failListing();
    await expect(feed.list()).rejects.toThrow('fake listing failed');
    await expect(feed.list()).rejects.toThrow('fake listing failed');
    feed.failRead('feed down');
    await expect(read(feed, null)).rejects.toThrow('feed down');
  });

  it('marks a page set as a full listing', async () => {
    const feed = createFakeConnector({ files: [], pages: [[change('file-a', true)]] });
    feed.markFullListing();
    const page = await read(feed, null);
    expect(page.fullListing).toBe(true);
    expect(page.complete).toBe(true);
  });
});

describe('createPgliteAdmin().rpc', () => {
  const LINEAGE = '00000000-0000-4000-8000-0000000fe001';
  let db: PGlite;
  let admin: ReturnType<typeof createPgliteAdmin>;

  beforeAll(async () => {
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' }));
    admin = createPgliteAdmin(db);
    await db.query(
      "INSERT INTO documents (id, filename, content, source, source_key, lineage_id, version, is_current, status) VALUES ($1, 'file-a.pdf', 'neutral body', 'nango', 'file-a', $1, 1, true, 'ready')",
      [LINEAGE],
    );
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('runs a rag function with named arguments and returns its rows', async () => {
    const result = await admin.rpc('rag_soft_delete_document', { p_tenant_key: 's:default', p_lineage_id: LINEAGE, p_source: 'nango' });
    expect(result.error).toBeNull();
    expect(result.data).toEqual([expect.objectContaining({ outcome: 'deleted', lineage_id: LINEAGE })]);
    const status = await db.query<{ status: string }>('SELECT status FROM documents WHERE id = $1', [LINEAGE]);
    expect(status.rows[0]?.status).toBe('deleted');
  });

  it('maps a database error to { message, code }', async () => {
    const result = await admin.rpc('rag_soft_delete_document', {
      p_tenant_key: 's:default',
      p_lineage_id: '00000000-0000-4000-8000-0000000fe999',
      p_source: 'nango',
    });
    expect(result.data).toBeNull();
    expect(result.error).toEqual({ message: expect.stringContaining('tenant_mismatch'), code: '22023' });
  });

  it('chains abortSignal and refuses an aborted call', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await admin.rpc('rag_soft_delete_document', { p_tenant_key: 's:default', p_lineage_id: LINEAGE, p_source: 'nango' }).abortSignal(controller.signal);
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe('20');
  });

  it('refuses names outside the rag pattern and bad argument names without touching the database', async () => {
    const before = admin.queries.length;
    for (const name of ['pg_sleep', 'rag_x; DROP TABLE documents', 'public.rag_soft_delete_document', 'RAG_SOFT_DELETE_DOCUMENT']) {
      const result = await admin.rpc(name, {});
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('PGRST202');
    }
    const badArg = await admin.rpc('rag_soft_delete_document', { 'p_tenant_key => 1); --': 'x' });
    expect(badArg.error?.code).toBe('PGRST202');
    expect(admin.queries.length).toBe(before);
  });
});
