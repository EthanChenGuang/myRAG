import { LEXICAL_VERSION, lexicalText, lexicalTokens } from './tokenize';

const LEGACY_PREFIX =
  /^Document:\s*(.+?)\.\s*Chunk\s+\d+\s+of\s+\d+\.\s*Content:\s*/iu;

export interface ChunkLexicalInput {
  sectionPath: readonly string[];
  content: string;
  chunkKind?: string | null;
  metadata?: Record<string, unknown> | null;
  documentFilename?: string | null;
}

function isImageChunk(chunkKind: string | null | undefined, metadata: Record<string, unknown> | null | undefined): boolean {
  if (chunkKind === 'image') return true;
  const url = metadata?.image_url;
  return typeof url === 'string' && url !== '';
}

function stripLegacyContent(content: string): { title: string | null; body: string } {
  const match = content.match(LEGACY_PREFIX);
  if (!match) return { title: null, body: content };
  return { title: match[1]?.trim() ?? null, body: content.slice(match[0].length) };
}

/** Builds lexical_text for a stored chunk (ingest, rag:relex, re-chunk). */
export function chunkLexicalText(input: ChunkLexicalInput): string {
  const { title, body } = stripLegacyContent(input.content);
  const path = [...input.sectionPath];
  if (title !== null && path.length === 0) path.unshift(title);

  const extras: string[] = [];
  if (isImageChunk(input.chunkKind, input.metadata)) {
    if (typeof input.documentFilename === 'string' && input.documentFilename !== '') extras.push(input.documentFilename);
    const name = input.metadata?.name;
    const imageContext = input.metadata?.image_context;
    if (typeof name === 'string' && name !== '') extras.push(name);
    if (typeof imageContext === 'string' && imageContext !== '') extras.push(imageContext);
  }

  return lexicalText(path, [...extras, body].filter(Boolean).join('\n'));
}

export { LEXICAL_VERSION, lexicalTokens };