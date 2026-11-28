import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { createPgliteAdmin } from '../helpers/pglite-admin';
import { startFakeGraph, type FakeGraph } from '../helpers/fake-graph';
import {
    GraphDeltaFeed,
    clearDeltaCursor,
    commitDeltaCursor,
    readDeltaCursor,
    type GraphChangePage,
    type GraphDeltaReadInput,
} from '@/lib/nango/sharepoint/delta';
import { graphGet, pathAndQueryOf } from '@/lib/nango/sharepoint/graph';
import { isSharePointEnabled, sharePointIntegrationKey } from '@/lib/nango/sharepoint/config';
import { PROVIDER_CONFIG } from '@/lib/nango/types';

const DRIVE = 'drive-a';
const CONNECTION_ROW = '00000000-0000-4000-8000-00000000c0a1';
const START = `/v1.0/drives/${DRIVE}/root/delta`;

const read = (feed: GraphDeltaFeed, extra: Partial<GraphDeltaReadInput> = {}) =>
    feed.read({ connectionId: 'nango-conn-a', cursor: null, deadline: Date.now() + 60_000, signal: new AbortController().signal, ...extra });

let graph: FakeGraph | undefined;
afterEach(async () => {
    const running = graph;
    graph = undefined;
    await running?.close();
});

describe('provider registration (D-24, D-40)', () => {
    it('keeps SharePoint off by default and defaults the integration ids to the provider ids', () => {
        const saved = process.env.NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED;
        delete process.env.NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED;
        try {
            expect(isSharePointEnabled()).toBe(false);
            process.env.NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED = 'true';
            expect(isSharePointEnabled()).toBe(true);
        } finally {
            if (saved === undefined) delete process.env.NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED;
            else process.env.NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED = saved;
        }
        expect(PROVIDER_CONFIG['sharepoint-online'].integrationId).toBe('sharepoint-online');
        expect(PROVIDER_CONFIG['one-drive'].integrationId).toBe('one-drive');
        expect(PROVIDER_CONFIG['sharepoint-online'].displayName).toBe('SharePoint Online');
        expect(PROVIDER_CONFIG['one-drive'].displayName).toBe('OneDrive for Business');
        expect(PROVIDER_CONFIG['sharepoint-online'].syncName).toBeUndefined();
    });

    it('reads the integration key settings when set', () => {
        const saved = process.env.NANGO_SHAREPOINT_INTEGRATION_KEY;
        process.env.NANGO_SHAREPOINT_INTEGRATION_KEY = 'sp-integration-1';
        try {
            expect(sharePointIntegrationKey('sharepoint-online')).toBe('sp-integration-1');
            expect(sharePointIntegrationKey('one-drive')).toBe(process.env.NANGO_ONEDRIVE_INTEGRATION_KEY || 'one-drive');
        } finally {
            if (saved === undefined) delete process.env.NANGO_SHAREPOINT_INTEGRATION_KEY;
            else process.env.NANGO_SHAREPOINT_INTEGRATION_KEY = saved;
        }
    });
});

describe('GraphDeltaFeed enumeration (D-21, D-25)', () => {
    it('enumerates a drive over two pages: last occurrence wins, delta link as cursor, full listing', async () => {
        graph = await startFakeGraph('drive-delta-initial');
        const feed = new GraphDeltaFeed({ provider: 'sharepoint-online', driveId: DRIVE, transport: graph.transport() });
        const page = await read(feed);

        expect(graph.calls.map((call) => call.pathAndQuery)).toEqual([START, `${START}?token=page-0002`]);
        expect(page.complete).toBe(true);
        expect(page.fullListing).toBe(true);
        expect(page.nextCursor).toBe(`${START}?token=delta-0001`);

        const files = page.changes.filter((change) => change.kind === 'file' && !change.deleted);
        const folders = page.changes.filter((change) => change.kind === 'folder');
        const deleted = page.changes.filter((change) => change.deleted);
        expect(files.map((change) => change.fileId).sort()).toEqual(['item-file-a', 'item-file-b', 'item-file-c']);
        expect(folders.map((change) => change.fileId)).toEqual(['item-folder-1']);
        expect(deleted.map((change) => change.fileId)).toEqual(['item-gone-1']);
        expect(page.changes.filter((change) => change.fileId === 'item-file-a')).toHaveLength(1);
        expect(page.changes.some((change) => change.fileId === 'item-root')).toBe(false);
        expect(page.rootIds).toEqual(['item-root']);
    });

    it('takes etag from eTag and modifiedAt from lastModifiedDateTime; deleted items carry only id and the flag', async () => {
        graph = await startFakeGraph('drive-delta-initial');
        const feed = new GraphDeltaFeed({ provider: 'one-drive', driveId: DRIVE, transport: graph.transport() });
        const page = await read(feed);
        const fileA = page.changes.find((change) => change.fileId === 'item-file-a');
        expect(fileA).toEqual({
            fileId: 'item-file-a',
            deleted: false,
            kind: 'file',
            name: 'file-a.pdf',
            etag: '"{00000000-0000-0000-0000-0000000000a1},2"',
            modifiedAt: '2026-01-05T00:00:00Z',
            parentId: 'item-folder-1',
            driveId: DRIVE,
            siteId: 'site-a',
        });
        expect(page.changes.find((change) => change.fileId === 'item-gone-1')).toEqual({
            fileId: 'item-gone-1',
            deleted: true,
            kind: 'file',
            driveId: DRIVE,
        });
    });

    it('reads changes from a stored delta link: one changed file and one deleted file, not a full listing', async () => {
        graph = await startFakeGraph('drive-delta-initial', 'drive-delta-changes');
        const feed = new GraphDeltaFeed({ provider: 'sharepoint-online', driveId: DRIVE, transport: graph.transport() });
        const page = await read(feed, { cursor: `${START}?token=delta-0001` });
        expect(page.complete).toBe(true);
        expect(page.fullListing).toBe(false);
        expect(page.nextCursor).toBe(`${START}?token=delta-0002`);
        expect(page.changes).toEqual([
            {
                fileId: 'item-file-b',
                deleted: false,
                kind: 'file',
                name: 'file-b.docx',
                etag: '"{00000000-0000-0000-0000-0000000000b1},2"',
                modifiedAt: '2026-02-01T00:00:00Z',
                parentId: 'item-root',
                driveId: DRIVE,
                siteId: 'site-a',
            },
            { fileId: 'item-file-c', deleted: true, kind: 'file', driveId: DRIVE },
        ]);
    });

    it('never sends deltaExcludeParent and never asks for sharing changes', async () => {
        graph = await startFakeGraph('drive-delta-initial', 'drive-delta-changes');
        const feed = new GraphDeltaFeed({ provider: 'sharepoint-online', driveId: DRIVE, transport: graph.transport() });
        await read(feed);
        await read(feed, { cursor: `${START}?token=delta-0001` });
        expect(graph.calls).toHaveLength(3);
        expect(graph.calls.every((call) => !call.hasDeltaExcludeParent && !call.hasPrefer)).toBe(true);
        expect(graph.calls.every((call) => !/deltaExcludeParent/i.test(call.pathAndQuery))).toBe(true);
    });

    it('refuses a stored cursor that is not a Graph path', async () => {
        graph = await startFakeGraph('drive-delta-initial');
        const feed = new GraphDeltaFeed({ provider: 'sharepoint-online', driveId: DRIVE, transport: graph.transport() });
        await expect(read(feed, { cursor: '//attacker.example/v1.0/drives/drive-a/root/delta' })).rejects.toThrow(/graph_link_refused/);
        await expect(read(feed, { cursor: 'https://attacker.example/v1.0/drives/drive-a/root/delta' })).rejects.toThrow(/graph_link_refused/);
        expect(graph.calls).toHaveLength(0);
    });
});

describe('410 restart (D-21, A3)', () => {
    it('clears the stored link on 410, restarts without a token and reports a full listing', async () => {
        graph = await startFakeGraph('drive-delta-initial', 'drive-delta-resync');
        let cleared = 0;
        const feed = new GraphDeltaFeed({
            provider: 'sharepoint-online',
            driveId: DRIVE,
            transport: graph.transport(),
            onResync: async () => {
                cleared += 1;
            },
        });
        const page = await read(feed, { cursor: `${START}?token=expired-0001` });
        expect(cleared).toBe(1);
        expect(page.resynced).toBe(true);
        expect(page.fullListing).toBe(true);
        expect(page.complete).toBe(true);
        expect(page.nextCursor).toBe(`${START}?token=delta-0001`);
        expect(graph.calls.map((call) => call.pathAndQuery)).toEqual([`${START}?token=expired-0001`, START, `${START}?token=page-0002`]);
    });

    it('a 410 on a resumed next link also restarts from the beginning', async () => {
        graph = await startFakeGraph('drive-delta-initial');
        graph.respondOnce(`${START}?token=page-0002`, { status: 410, body: { error: { code: 'resyncRequired' } } });
        let cleared = 0;
        const feed = new GraphDeltaFeed({
            provider: 'sharepoint-online',
            driveId: DRIVE,
            transport: graph.transport(),
            onResync: async () => {
                cleared += 1;
            },
        });
        const page = await read(feed, { cursor: `${START}?token=delta-0000`, nextLink: `${START}?token=page-0002` });
        expect(cleared).toBe(1);
        expect(page.fullListing).toBe(true);
        expect(page.nextCursor).toBe(`${START}?token=delta-0001`);
    });

    it('a 410 on a token-less enumeration is an error, not a loop', async () => {
        graph = await startFakeGraph();
        graph.respondOnce(START, { status: 410, body: { error: { code: 'resyncRequired' } } });
        const feed = new GraphDeltaFeed({ provider: 'sharepoint-online', driveId: DRIVE, transport: graph.transport() });
        await expect(read(feed)).rejects.toThrow(/graph_http_410/);
        expect(graph.calls).toHaveLength(1);
    });
});

describe('resumable enumeration (D-21, Pitfall 16)', () => {
    it('stops at the deadline with the in-progress next link, then resumes from it to a delta link', async () => {
        graph = await startFakeGraph('drive-delta-initial');
        let clock = 0;
        const feed = new GraphDeltaFeed({ provider: 'sharepoint-online', driveId: DRIVE, transport: graph.transport(), now: () => clock });
        const original = graph.transport();
        const ticking = new GraphDeltaFeed({
            provider: 'sharepoint-online',
            driveId: DRIVE,
            now: () => clock,
            transport: async (request) => {
                const response = await original(request);
                clock += 100;
                return response;
            },
        });
        const first = await ticking.read({ connectionId: 'nango-conn-a', cursor: null, deadline: 50, signal: new AbortController().signal });
        expect(first.complete).toBe(false);
        expect(first.fullListing).toBe(false);
        expect(first.nextCursor).toBe(`${START}?token=page-0002`);
        expect(first.changes.map((change) => change.fileId)).toContain('item-file-a');

        const second = await feed.read({
            connectionId: 'nango-conn-a',
            cursor: null,
            nextLink: first.nextCursor,
            deadline: Number.MAX_SAFE_INTEGER,
            signal: new AbortController().signal,
        });
        expect(second.complete).toBe(true);
        expect(second.fullListing).toBe(true);
        expect(second.nextCursor).toBe(`${START}?token=delta-0001`);
        expect(graph.calls.map((call) => call.pathAndQuery)).toEqual([START, `${START}?token=page-0002`]);
    });

    it('a resumed incremental enumeration (a delta link is stored) is not a full listing', async () => {
        graph = await startFakeGraph('drive-delta-initial');
        const feed = new GraphDeltaFeed({ provider: 'sharepoint-online', driveId: DRIVE, transport: graph.transport() });
        const page = await read(feed, { cursor: `${START}?token=delta-0000`, nextLink: `${START}?token=page-0002` });
        expect(page.complete).toBe(true);
        expect(page.fullListing).toBe(false);
        expect(graph.calls.map((call) => call.pathAndQuery)).toEqual([`${START}?token=page-0002`]);
    });
});

describe('throttling (Pitfall 16)', () => {
    for (const status of [429, 503]) {
        it(`waits for Retry-After after a ${status} before the next request`, async () => {
            graph = await startFakeGraph('drive-delta-changes');
            const endpoint = `${START}?token=delta-0001`;
            graph.respondOnce(endpoint, { status, headers: { 'Retry-After': '1' }, body: { error: { code: 'activityLimitReached' } } });
            const feed = new GraphDeltaFeed({ provider: 'sharepoint-online', driveId: DRIVE, transport: graph.transport() });
            const page = await read(feed, { cursor: endpoint });
            expect(page.complete).toBe(true);
            expect(graph.calls).toHaveLength(2);
            expect(graph.calls[1].at - graph.calls[0].at).toBeGreaterThanOrEqual(990);
        });
    }

    it('gives up waiting when Retry-After would pass the deadline and returns resumable state', async () => {
        graph = await startFakeGraph('drive-delta-changes');
        const endpoint = `${START}?token=delta-0001`;
        graph.respondOnce(endpoint, { status: 429, headers: { 'Retry-After': '120' } });
        const feed = new GraphDeltaFeed({ provider: 'sharepoint-online', driveId: DRIVE, transport: graph.transport() });
        const page = await read(feed, { cursor: endpoint, deadline: Date.now() + 5_000 });
        expect(page.complete).toBe(false);
        expect(page.nextCursor).toBe(endpoint);
        expect(graph.calls).toHaveLength(1);
    });

    it('an abort during the wait sends no further request', async () => {
        graph = await startFakeGraph('drive-delta-changes');
        const endpoint = `${START}?token=delta-0001`;
        graph.respondOnce(endpoint, { status: 503, headers: { 'Retry-After': '5' } });
        const controller = new AbortController();
        const pending = graphGet(graph.transport(), endpoint, { signal: controller.signal });
        setTimeout(() => controller.abort(), 100);
        await expect(pending).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(graph.calls).toHaveLength(1);
    });
});

describe('host check (T-06.3-18)', () => {
    it('returns path and query of a Graph link only', () => {
        expect(pathAndQueryOf('https://graph.microsoft.com/v1.0/drives/drive-a/root/delta?token=delta-0001')).toBe(
            '/v1.0/drives/drive-a/root/delta?token=delta-0001',
        );
    });

    it.each([
        'https://attacker.example/v1.0/drives/drive-a/root/delta?token=x',
        'http://graph.microsoft.com/v1.0/drives/drive-a/root/delta?token=x',
        '/v1.0/drives/drive-a/root/delta?token=x',
        'https://graph.microsoft.com.attacker.example/v1.0/drives/drive-a/root/delta',
        'https://graph.microsoft.com:8443/v1.0/drives/drive-a/root/delta',
        'https://user@graph.microsoft.com/v1.0/drives/drive-a/root/delta',
    ])('refuses %s', (link) => {
        expect(() => pathAndQueryOf(link)).toThrow(/graph_link_refused/);
    });

    it('a next link pointing at another host never reaches the transport', async () => {
        graph = await startFakeGraph();
        graph.respondOnce(START, {
            status: 200,
            body: { value: [], '@odata.nextLink': 'https://attacker.example/v1.0/drives/drive-a/root/delta?token=p2' },
        });
        const feed = new GraphDeltaFeed({ provider: 'sharepoint-online', driveId: DRIVE, transport: graph.transport() });
        await expect(read(feed)).rejects.toThrow(/graph_link_refused/);
        expect(graph.calls).toHaveLength(1);
    });
});

describe('delta cursor store (rag_source_delta_tokens)', () => {
    let db: PGlite;
    let admin: ReturnType<typeof createPgliteAdmin>;

    beforeAll(async () => {
        const fixture = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' });
        db = fixture.db;
        admin = createPgliteAdmin(db);
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [fixture.fixtureUserId, 'fixture-user@example.invalid']);
        await db.query("INSERT INTO public.nango_connections (id, user_id, connection_id, provider, status) VALUES ($1, $2, 'nango-conn-a', 'sharepoint-online', 'connected')", [
            CONNECTION_ROW,
            fixture.fixtureUserId,
        ]);
    }, 120_000);

    afterAll(async () => {
        await db?.close();
    });

    const rows = async () =>
        (await db.query<{ feed: string; feed_key: string; delta_link: string | null; next_link: string | null }>(
            'SELECT feed, feed_key, delta_link, next_link FROM public.rag_source_delta_tokens WHERE connection_id = $1',
            [CONNECTION_ROW],
        )).rows;

    it('a read alone writes nothing; commit after apply upserts one graph_delta row per drive', async () => {
        graph = await startFakeGraph('drive-delta-initial', 'drive-delta-changes');
        const client = admin as never;
        const feed = new GraphDeltaFeed({ provider: 'sharepoint-online', driveId: DRIVE, transport: graph.transport() });

        await expect(readDeltaCursor(client, { connectionRowId: CONNECTION_ROW, driveId: DRIVE })).resolves.toEqual({ deltaLink: null, nextLink: null });
        const first: GraphChangePage = await read(feed);
        expect(await rows()).toEqual([]);

        await commitDeltaCursor(client, { connectionRowId: CONNECTION_ROW, driveId: DRIVE, page: first });
        expect(await rows()).toEqual([{ feed: 'graph_delta', feed_key: DRIVE, delta_link: `${START}?token=delta-0001`, next_link: null }]);

        const state = await readDeltaCursor(client, { connectionRowId: CONNECTION_ROW, driveId: DRIVE });
        const second = await read(feed, { cursor: state.deltaLink, nextLink: state.nextLink });
        expect(await rows()).toHaveLength(1);
        await commitDeltaCursor(client, { connectionRowId: CONNECTION_ROW, driveId: DRIVE, page: second });
        expect(await rows()).toEqual([{ feed: 'graph_delta', feed_key: DRIVE, delta_link: `${START}?token=delta-0002`, next_link: null }]);
    });

    it('an incomplete page stores next_link and keeps delta_link; clear removes the row', async () => {
        const client = admin as never;
        await commitDeltaCursor(client, {
            connectionRowId: CONNECTION_ROW,
            driveId: DRIVE,
            page: { changes: [], nextCursor: `${START}?token=page-0009`, complete: false, fullListing: false },
        });
        expect(await rows()).toEqual([{ feed: 'graph_delta', feed_key: DRIVE, delta_link: `${START}?token=delta-0002`, next_link: `${START}?token=page-0009` }]);
        await expect(readDeltaCursor(client, { connectionRowId: CONNECTION_ROW, driveId: DRIVE })).resolves.toEqual({
            deltaLink: `${START}?token=delta-0002`,
            nextLink: `${START}?token=page-0009`,
        });
        await clearDeltaCursor(client, { connectionRowId: CONNECTION_ROW, driveId: DRIVE });
        expect(await rows()).toEqual([]);
    });
});
