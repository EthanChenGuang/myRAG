import type { ChangePage, SourceChange, SourceChangeFeed, SourceChangeFeedReadInput } from '../change-feed';
import type { GraphTransport } from './graph';
import type { SharePointProvider } from './config';

export interface GraphSourceChange extends SourceChange {
    driveId: string;
    siteId?: string;
}

export interface GraphChangePage extends ChangePage {
    changes: GraphSourceChange[];
    resynced: boolean;
}

export interface GraphDeltaReadInput extends SourceChangeFeedReadInput {
    nextLink?: string | null;
}

export interface GraphDeltaFeedOptions {
    provider: SharePointProvider;
    driveId: string;
    transport?: GraphTransport;
    onResync?: () => Promise<void>;
    now?: () => number;
}

export class GraphDeltaFeed implements SourceChangeFeed {
    constructor(private readonly options: GraphDeltaFeedOptions) {}

    async read(_input: GraphDeltaReadInput): Promise<GraphChangePage> {
        return { changes: [], nextCursor: null, complete: false, fullListing: false, resynced: false };
    }
}

type Client = { from: (table: string) => any };
interface CursorKey {
    connectionRowId: string;
    driveId: string;
}

export async function readDeltaCursor(_client: Client, _key: CursorKey): Promise<{ deltaLink: string | null; nextLink: string | null }> {
    return { deltaLink: 'stub', nextLink: 'stub' };
}

export async function commitDeltaCursor(_client: Client, _input: CursorKey & { page: GraphChangePage }): Promise<void> {}

export async function clearDeltaCursor(_client: Client, _key: CursorKey): Promise<void> {}
