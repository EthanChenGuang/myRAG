export interface GraphResponse {
    status: number;
    data: unknown;
    headers: Record<string, string | undefined>;
}

export type GraphTransport = (request: { endpoint: string; signal?: AbortSignal }) => Promise<GraphResponse>;

export function pathAndQueryOf(_link: string): string {
    throw new Error('not implemented');
}

export async function graphGet(_transport: GraphTransport, _endpoint: string, _options: { signal?: AbortSignal } = {}): Promise<GraphResponse> {
    throw new Error('not implemented');
}
