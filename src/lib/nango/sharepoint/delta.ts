import type { getSupabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import type { ChangePage, SourceChange, SourceChangeFeed, SourceChangeFeedReadInput } from '../change-feed';
import { sharePointIntegrationKey, type SharePointProvider } from './config';
import {
    GraphDeadlineError,
    GraphHttpError,
    graphEndpointOf,
    graphGet,
    nangoGraphTransport,
    pathAndQueryOf,
    type GraphTransport,
} from './graph';

/**
 * Microsoft Graph drive delta as a SourceChangeFeed (Phase 6.3, D-21, D-40, DATA-25).
 *
 * One feed reads one drive (`/v1.0/drives/{drive-id}/root/delta`). It pages `@odata.nextLink` until
 * `@odata.deltaLink`, keeps the last occurrence of each item id, and never persists a cursor: the caller applies the
 * page and only then calls `commitDeltaCursor`. The stored delta link is the next read's `cursor`; an enumeration cut
 * at the deadline returns its in-progress next link (`complete: false`), which the caller stores in `next_link` and
 * passes back as `nextLink`. A 410 drops the stored link (through `onResync`) and restarts without a token. An
 * enumeration that started without a token reports `fullListing: true` once it reaches its delta link; when it was
 * resumed across several reads, the full listing is the union of the file ids of those reads.
 */
export const GRAPH_DELTA_FEED = 'graph_delta';
const DELTA_TOKENS_TABLE = 'rag_source_delta_tokens';
const MAX_PAGES_PER_READ = 1_000;

export interface GraphSourceChange extends SourceChange {
    /** The drive the item belongs to, kept next to the item id for lookups (A5). */
    driveId: string;
    siteId?: string;
}

export interface GraphChangePage extends ChangePage {
    changes: GraphSourceChange[];
    /** True when a 410 dropped the stored link and this read restarted without a token. */
    resynced: boolean;
    /** Ids of drive root items seen in this read (they end a parent walk; see scope.ts). */
    rootIds?: string[];
}

export interface GraphDeltaReadInput extends SourceChangeFeedReadInput {
    /** The resumable link of an enumeration cut at an earlier deadline (`next_link`); preferred over `cursor`. */
    nextLink?: string | null;
}

export interface GraphDeltaFeedOptions {
    provider: SharePointProvider;
    driveId: string;
    /** Defaults to `nango.proxy` with the provider's integration id and the read's connection id. */
    transport?: GraphTransport;
    /** Called once when the service answered 410 for the stored link, before the restart; clears the stored cursor. */
    onResync?: () => Promise<void>;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface DriveItem {
    id?: unknown;
    name?: unknown;
    eTag?: unknown;
    lastModifiedDateTime?: unknown;
    file?: unknown;
    folder?: unknown;
    root?: unknown;
    deleted?: unknown;
    parentReference?: { id?: unknown; driveId?: unknown; siteId?: unknown } | null;
}

interface DeltaBody {
    value?: unknown;
    '@odata.nextLink'?: unknown;
    '@odata.deltaLink'?: unknown;
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const isFacet = (value: unknown): boolean => value !== undefined && value !== null && typeof value === 'object';

function toChange(item: DriveItem, driveId: string): GraphSourceChange | null {
    const fileId = asString(item.id);
    if (!fileId || isFacet(item.root)) return null;
    const kind: SourceChange['kind'] = isFacet(item.folder) ? 'folder' : 'file';
    if (isFacet(item.deleted)) return { fileId, deleted: true, kind, driveId };
    if (!isFacet(item.file) && !isFacet(item.folder)) return null;
    const change: GraphSourceChange = { fileId, deleted: false, kind, driveId: asString(item.parentReference?.driveId) ?? driveId };
    const name = asString(item.name);
    if (name) change.name = name;
    if (kind === 'file') {
        const etag = asString(item.eTag);
        if (etag) change.etag = etag;
        const modifiedAt = asString(item.lastModifiedDateTime);
        if (modifiedAt) change.modifiedAt = modifiedAt;
    }
    const parentId = asString(item.parentReference?.id);
    if (parentId) change.parentId = parentId;
    const siteId = asString(item.parentReference?.siteId);
    if (siteId) change.siteId = siteId;
    return change;
}

function abortError(): Error {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}

export class GraphDeltaFeed implements SourceChangeFeed {
    constructor(private readonly options: GraphDeltaFeedOptions) {
        if (!options.driveId || options.driveId.length > 256 || /[/?#\\\s]/.test(options.driveId)) {
            throw new Error('graph_drive_id_invalid');
        }
    }

    private startEndpoint(): string {
        return `/v1.0/drives/${encodeURIComponent(this.options.driveId)}/root/delta`;
    }

    async read(input: GraphDeltaReadInput): Promise<GraphChangePage> {
        const transport =
            this.options.transport ?? nangoGraphTransport(sharePointIntegrationKey(this.options.provider), input.connectionId);
        const resumeLink = input.nextLink ?? null;
        const storedLink = resumeLink ?? input.cursor;
        const tokenless = input.cursor === null;
        const firstEndpoint = storedLink ? graphEndpointOf(storedLink) : this.startEndpoint();
        try {
            return await this.enumerate(transport, firstEndpoint, tokenless, false, input);
        } catch (error) {
            if (!(error instanceof GraphHttpError) || error.status !== 410 || storedLink === null) throw error;
            logger.warn('SharePoint', 'Delta link no longer served; restarting the enumeration', { status: 410 });
            await this.options.onResync?.();
            return this.enumerate(transport, this.startEndpoint(), true, true, input);
        }
    }

    private async enumerate(
        transport: GraphTransport,
        firstEndpoint: string,
        fullListing: boolean,
        resynced: boolean,
        input: GraphDeltaReadInput,
    ): Promise<GraphChangePage> {
        const now = this.options.now ?? Date.now;
        const seen = new Map<string, GraphSourceChange>();
        const rootIds = new Set<string>();
        const result = (nextCursor: string | null, complete: boolean): GraphChangePage => ({
            changes: [...seen.values()],
            nextCursor,
            complete,
            fullListing: complete && fullListing,
            resynced,
            rootIds: [...rootIds],
        });

        let endpoint = firstEndpoint;
        for (let page = 0; page < MAX_PAGES_PER_READ; page++) {
            if (input.signal.aborted) throw abortError();
            if (now() >= input.deadline) return result(endpoint, false);
            let response;
            try {
                response = await graphGet(transport, endpoint, {
                    signal: input.signal,
                    deadline: input.deadline,
                    now,
                    sleep: this.options.sleep,
                });
            } catch (error) {
                if (error instanceof GraphDeadlineError) return result(endpoint, false);
                throw error;
            }
            const body = (response.data ?? {}) as DeltaBody;
            const items = Array.isArray(body.value) ? (body.value as DriveItem[]) : [];
            for (const item of items) {
                const rootId = isFacet(item.root) ? asString(item.id) : undefined;
                if (rootId) rootIds.add(rootId);
                const change = toChange(item, this.options.driveId);
                if (!change) continue;
                seen.delete(change.fileId);
                seen.set(change.fileId, change);
            }
            const nextLink = asString(body['@odata.nextLink']);
            if (nextLink) {
                endpoint = pathAndQueryOf(nextLink);
                continue;
            }
            const deltaLink = asString(body['@odata.deltaLink']);
            if (!deltaLink) throw new Error('graph_delta_link_missing');
            return result(pathAndQueryOf(deltaLink), true);
        }
        return result(endpoint, false);
    }
}

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
/** The service-role client (or a stand-in with the same `from` builder). */
export type DeltaTokenClient = Pick<SupabaseAdmin, 'from'>;

export interface DeltaCursorKey {
    /** `nango_connections.id` (uuid), not the Nango connection id. */
    connectionRowId: string;
    driveId: string;
}

export interface DeltaCursorState {
    deltaLink: string | null;
    nextLink: string | null;
}

export async function readDeltaCursor(client: DeltaTokenClient, key: DeltaCursorKey): Promise<DeltaCursorState> {
    const { data, error } = await client
        .from(DELTA_TOKENS_TABLE)
        .select('delta_link, next_link')
        .eq('connection_id', key.connectionRowId)
        .eq('feed', GRAPH_DELTA_FEED)
        .eq('feed_key', key.driveId)
        .maybeSingle();
    if (error) throw new Error('delta_cursor_read_failed');
    const row = (data ?? null) as { delta_link: string | null; next_link: string | null } | null;
    return { deltaLink: row?.delta_link ?? null, nextLink: row?.next_link ?? null };
}

/**
 * Stores the cursor of a page the caller has applied. A complete page replaces the delta link and clears the resumable
 * link; an incomplete page stores only the resumable link and leaves the delta link as it is.
 */
export async function commitDeltaCursor(client: DeltaTokenClient, input: DeltaCursorKey & { page: ChangePage }): Promise<void> {
    const { page } = input;
    if (page.nextCursor === null) return;
    const cursor = graphEndpointOf(page.nextCursor);
    const row: Record<string, unknown> = {
        connection_id: input.connectionRowId,
        feed: GRAPH_DELTA_FEED,
        feed_key: input.driveId,
        updated_at: new Date().toISOString(),
    };
    if (page.complete) {
        row.delta_link = cursor;
        row.next_link = null;
    } else {
        row.next_link = cursor;
    }
    const { error } = await client.from(DELTA_TOKENS_TABLE).upsert(row, { onConflict: 'connection_id,feed,feed_key' });
    if (error) throw new Error('delta_cursor_write_failed');
}

/** Drops the stored links of one drive (after a 410, or when the drive leaves the selection). */
export async function clearDeltaCursor(client: DeltaTokenClient, key: DeltaCursorKey): Promise<void> {
    const { error } = await client
        .from(DELTA_TOKENS_TABLE)
        .delete()
        .eq('connection_id', key.connectionRowId)
        .eq('feed', GRAPH_DELTA_FEED)
        .eq('feed_key', key.driveId);
    if (error) throw new Error('delta_cursor_clear_failed');
}
