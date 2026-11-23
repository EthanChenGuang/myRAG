export interface MediaContextRow {
  document_id: string;
  content: string;
  similarity: number;
}

const IMAGE_CONTEXT_MAX_CHARS = 4000;
const IMAGE_CHUNKS_PER_DOCUMENT = 3;

/** Context text for image generation: top chunks per document, joined, truncated. Empty only when there are no rows. */
export function formatImageContext(rows: MediaContextRow[]): string {
  if (rows.length === 0) return '';

  let contextText = '';

  const chunksByDocument = rows.reduce((acc: Record<string, MediaContextRow[]>, chunk) => {
    if (!acc[chunk.document_id]) {
      acc[chunk.document_id] = [];
    }
    acc[chunk.document_id].push(chunk);
    return acc;
  }, {});

  for (const chunks of Object.values(chunksByDocument)) {
    const sortedChunks = chunks
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, IMAGE_CHUNKS_PER_DOCUMENT);

    contextText += sortedChunks
      .map((chunk) => chunk.content.trim())
      .filter((content) => content.length > 0)
      .join('\n---\n');
    contextText += '\n\n';
  }

  return contextText.slice(0, IMAGE_CONTEXT_MAX_CHARS);
}

/** Context text for video prompt rewriting: every chunk in retrieval order, space-joined. */
export function formatVideoContext(rows: MediaContextRow[]): string {
  return rows.map((chunk) => chunk.content).join(' ');
}
