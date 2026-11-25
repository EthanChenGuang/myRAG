export { RERANK_TEXT_VERSION } from './types';

const LEGACY_PREFIX =
  /^Document:\s*(.+?)\.\s*Chunk\s+\d+\s+of\s+\d+\.\s*Content:\s*/iu;

function stripLegacyContent(content: string): string {
  const match = content.match(LEGACY_PREFIX);
  if (!match) return content;
  return content.slice(match[0].length);
}

export interface RerankTextInput {
  sectionPath: readonly string[];
  content: string;
}

export interface RerankTextResult {
  text: string;
  /** Codepoint length of the section-path prefix (including trailing newline when present). */
  prefixLength: number;
}

/** Builds the text passed to rerankers: section path, then body, legacy chunk prefix stripped. */
export function rerankText(input: RerankTextInput): RerankTextResult {
  const body = stripLegacyContent(input.content);
  if (input.sectionPath.length === 0) {
    return { text: body, prefixLength: 0 };
  }
  const prefix = `${input.sectionPath.join(' > ')}\n`;
  return { text: `${prefix}${body}`, prefixLength: Array.from(prefix).length };
}