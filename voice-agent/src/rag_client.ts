import axios from 'axios';

export interface RAGResult {
    content: string;
    similarity: number;
    document_id: string;
    metadata?: any;
}

// Source image data from Image RAG
export interface SourceImage {
    url: string;
    name: string;
    type: string;
}

export interface RAGResponse {
    context: string;
    sources: Array<{
        id: string;
        name: string;
        similarity: number;
    }>;
    source_images: SourceImage[];
}

export type RAGFailureReason = 'unauthorized' | 'unavailable' | 'error';

export type RAGQueryResult = ({ ok: true } & RAGResponse) | { ok: false; reason: RAGFailureReason };

function classifyFailure(error: unknown): RAGFailureReason {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 503) return 'unavailable';
    return 'error';
}

export class RAGClient {
    private apiUrl: string;
    private apiKey: string;

    constructor(apiUrl: string, apiKey: string) {
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
    }

    async query(userQuery: string, scopeToken?: string, userId?: string): Promise<RAGQueryResult> {
        try {
            console.log(`[RAG] Querying internal API: "${userQuery}"`);

            const headers: Record<string, string> = {
                'x-api-key': this.apiKey,
                'Content-Type': 'application/json'
            };
            if (scopeToken) {
                headers['x-rag-scope-token'] = scopeToken;
            }

            const response = await axios.post(
                this.apiUrl,
                {
                    query: userQuery,
                    userId: userId,
                    matchCount: 5
                },
                { headers }
            );

            const results: RAGResult[] = response.data.results || [];

            if (results.length === 0) {
                console.log('[RAG] No relevant context found.');
                // DEBUG: Print what we DID get
                console.log(`[RAG] Response keys: ${Object.keys(response.data).join(', ')}`);
                console.log(`[RAG] API URL used: ${this.apiUrl}`);
                return { ok: true, context: '', sources: [], source_images: [] };
            }

            // DEBUG: Inspect raw response for images
            console.log(`[RAG] Raw response keys: ${Object.keys(response.data).join(', ')}`);
            if (response.data.source_images) {
                console.log(`[RAG] Raw source_images length: ${response.data.source_images.length}`);
            } else {
                console.log('[RAG] Raw source_images is MISSING or undefined in response.data');
            }

            // Extract source images from API response (Image RAG support)
            const sourceImages: SourceImage[] = response.data.source_images || [];
            if (sourceImages.length > 0) {
                console.log(`[RAG] 🖼️ Retrieved ${sourceImages.length} source images`);
            }

            // Format context for LLM
            console.log(`[RAG] Found ${results.length} context chunks.`);
            const contextText = results.map(r => `[Context from document ${r.document_id}]: ${r.content}`).join('\n\n');

            // Format sources for UI
            const sources = results.map(r => {
                // Ensure document_id exists
                const docId = r.document_id || 'unknown';
                const shortId = docId.length >= 8 ? docId.substring(0, 8) : docId;

                return {
                    id: docId,
                    name: r.metadata?.filename || r.metadata?.name || `Document ${shortId}`,
                    similarity: r.similarity
                };
            });

            // Deduplicate sources by ID
            const uniqueSources = Array.from(new Map(sources.map(s => [s.id, s])).values());

            return {
                ok: true,
                context: contextText,
                sources: uniqueSources,
                source_images: sourceImages
            };

        } catch (error) {
            const reason = classifyFailure(error);
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            console.error('[RAG] Error querying internal API:', { reason, status, message: error instanceof Error ? error.message : String(error) });
            return { ok: false, reason };
        }
    }
}
