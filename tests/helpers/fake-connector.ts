import type { ChangePage, ListingResult, SourceChange, SourceChangeFeed, SourceChangeFeedReadInput } from '@/lib/nango/change-feed';

/**
 * A test-only connector (D-27): serves a listing and a change feed from in-memory fixtures. Ids and names are neutral
 * synthetic values supplied by the test (for example `file-a`, `file-a.pdf`).
 */
export interface FakeConnectorFixture {
    /** The files the source holds now; `list()` returns their ids. */
    files: string[];
    /** Change-feed pages in order; page i is served for cursor `null` (i = 0) or `cursor-<i>`. */
    pages?: SourceChange[][];
}

export interface FakeConnector extends SourceChangeFeed {
    list(input?: { connectionId?: string; signal?: AbortSignal }): Promise<ListingResult>;
    /** The next listing stops after `keep` files and reports `complete: false` (sticky until `reset`). */
    cutListing(keep: number): void;
    /** Every listing call throws (sticky until `reset`). */
    failListing(message?: string): void;
    /** Every feed read throws (sticky until `reset`). */
    failRead(message?: string): void;
    /** Mark the served page set as a full listing (a listing diff, D-33). */
    markFullListing(value?: boolean): void;
    /** Replace the files the source holds, e.g. to delete one at the source. */
    setFiles(files: string[]): void;
    reset(): void;
    readonly reads: Array<{ connectionId: string; cursor: string | null }>;
    readonly listings: number;
}

const cursorFor = (index: number) => `cursor-${index}`;

export function createFakeConnector(fixture: FakeConnectorFixture): FakeConnector {
    let files = [...fixture.files];
    const pages = (fixture.pages ?? []).map((page) => page.map((change) => ({ ...change })));
    let cut: number | null = null;
    let listingError: string | null = null;
    let readError: string | null = null;
    let fullListing = false;
    let listings = 0;
    const reads: Array<{ connectionId: string; cursor: string | null }> = [];

    const pageIndex = (cursor: string | null): number => {
        if (cursor === null) return 0;
        const match = /^cursor-(\d+)$/.exec(cursor);
        if (!match) throw new Error(`[fake-connector] unknown cursor: ${cursor}`);
        return Number(match[1]);
    };

    return {
        reads,
        get listings() {
            return listings;
        },
        async list(input) {
            input?.signal?.throwIfAborted();
            listings += 1;
            if (listingError !== null) throw new Error(listingError);
            if (cut !== null) return { fileIds: files.slice(0, cut), complete: false };
            return { fileIds: [...files], complete: true };
        },
        async read(input: SourceChangeFeedReadInput): Promise<ChangePage> {
            input.signal.throwIfAborted();
            reads.push({ connectionId: input.connectionId, cursor: input.cursor });
            if (readError !== null) throw new Error(readError);
            const index = pageIndex(input.cursor);
            const last = Math.max(pages.length - 1, 0);
            if (Date.now() > input.deadline) {
                return { changes: [], nextCursor: input.cursor, complete: false, fullListing };
            }
            const changes = (pages[index] ?? []).map((change) => ({ ...change }));
            const nextCursor = index < last ? cursorFor(index + 1) : null;
            return { changes, nextCursor, complete: nextCursor === null, fullListing };
        },
        cutListing(keep) {
            cut = Math.max(0, Math.trunc(keep));
        },
        failListing(message = 'fake listing failed') {
            listingError = message;
        },
        failRead(message = 'fake feed failed') {
            readError = message;
        },
        markFullListing(value = true) {
            fullListing = value;
        },
        setFiles(next) {
            files = [...next];
        },
        reset() {
            cut = null;
            listingError = null;
            readError = null;
            fullListing = false;
            files = [...fixture.files];
        },
    };
}
