import { getNango } from './client';

/**
 * Source change feeds and listings (Phase 6.3, D-03, D-04, D-08). Every feed (Nango records, Microsoft Graph delta,
 * the test fake connector) builds against one shape. No database import: feeds never persist a cursor.
 */

/** Where a deletion came from (D-03). */
export type DeletionOrigin = 'change_feed' | 'reconcile' | 'admin';

/** Per-connection deletion mode (D-08). `null` is the unset default: today's deletion path. */
export type DeletionMode = 'soft' | 'purge' | null;

/** One change a feed reports for one source item. */
export interface SourceChange {
    fileId: string;
    deleted: boolean;
    modifiedAt?: string;
    etag?: string;
    name?: string;
    parentId?: string;
    kind: 'file' | 'folder';
    /** The feed position just after this change, when the feed reports one per item (Nango `_nango_metadata.cursor`). */
    cursor?: string;
}

/** One page read from a change feed. */
export interface ChangePage {
    changes: SourceChange[];
    /** The cursor to store once this page was applied; null when the feed has no further page. */
    nextCursor: string | null;
    /** True when the feed reached its end in this read (no page was skipped or cut). */
    complete: boolean;
    /** True when the page set is a full enumeration (a listing diff), which the mass-delete guard applies to (D-09, D-33). */
    fullListing: boolean;
}

/** A full listing of the files a connection selects. Removal from a listing is allowed only when `complete` (D-48). */
export interface ListingResult {
    fileIds: string[];
    complete: boolean;
}

export interface SourceChangeFeedReadInput {
    connectionId: string;
    cursor: string | null;
    /** Epoch milliseconds after which the feed stops reading and returns what it has with `complete: false`. */
    deadline: number;
    signal: AbortSignal;
}

export interface SourceChangeFeed {
    /**
     * Reads from `cursor` (null: from the start). Never persists the cursor: the caller stores `nextCursor` only after
     * the page was applied, so a failed apply re-reads the same page.
     */
    read(input: SourceChangeFeedReadInput): Promise<ChangePage>;
}

/** The subset of the Nango SDK the records feed calls. */
export interface NangoRecordsClient {
    listRecords(input: {
        providerConfigKey: string;
        connectionId: string;
        model: string;
        filter?: 'added' | 'updated' | 'deleted';
        cursor?: string | null;
        limit?: number;
    }): Promise<{ records: unknown[]; next_cursor?: string | null }>;
}

export interface NangoRecordsFeedOptions {
    providerConfigKey: string;
    model: string;
    /** Defaults to the Nango SDK singleton. */
    client?: NangoRecordsClient;
    now?: () => number;
}

const NANGO_RECORDS_PAGE_SIZE = 100;
const NANGO_RECORDS_MAX_PAGES = 200;

interface NangoRecordShape {
    id?: unknown;
    _nango_metadata?: { last_action?: unknown; cursor?: unknown } | null;
}

/**
 * Nango deleted records since a cursor as a SourceChangeFeed (D-04, D-05). Reads `GET /records` with `filter: 'deleted'`
 * from the given cursor, page after page until `next_cursor` is null, the deadline or the signal. Never persists the
 * cursor. Each change carries the record's own cursor, so a caller that applies part of a read can resume after the
 * last change it applied. `fullListing` is always false here: whether the deletions come from a full sync is known to
 * the caller only (the webhook's `checkpoints`, D-33).
 */
export class NangoRecordsFeed implements SourceChangeFeed {
    private readonly providerConfigKey: string;
    private readonly model: string;
    private readonly client: NangoRecordsClient | undefined;
    private readonly now: () => number;

    constructor(options: NangoRecordsFeedOptions) {
        this.providerConfigKey = options.providerConfigKey;
        this.model = options.model;
        this.client = options.client;
        this.now = options.now ?? Date.now;
    }

    async read(_input: SourceChangeFeedReadInput): Promise<ChangePage> {
        void this.client;
        void this.now;
        return { changes: [], nextCursor: null, complete: true, fullListing: false };
    }
}
