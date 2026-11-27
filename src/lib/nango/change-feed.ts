/**
 * Source change feeds and listings (Phase 6.3, D-03, D-04, D-08). Types only: no Nango or database import, so every
 * feed (Nango records, Microsoft Graph delta, the test fake connector) builds against one shape.
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
