import { getLanguagePack } from '../../lang/registry';
import { splitTableBlocks } from '../chunkers/markdown-tables';

/** Added to the embedding-text version while RAG_TABLE_ROW_SERIALIZATION is on (D-21); processing-profiles.json is not edited (Pitfall 12). */
export const ROW_SERIALIZATION_VERSION_SUFFIX = 1000;

const FALLBACK_LANGUAGE = 'en';
const FALLBACK_SEPARATOR = ', ';

export function effectiveEmbeddingTextVersion(profileVersion: number, rowSerialization: boolean): number {
  void rowSerialization;
  return profileVersion;
}

export function serializeTableRows(markdownTable: string, pack: { list_separator: string }): string[] {
  void markdownTable;
  void pack;
  void splitTableBlocks;
  return [];
}

export interface TableRowLanguageInput {
  chunkLanguage?: string | null;
  documentLanguage?: string | null;
  primary?: string | null;
}

export function tableRowLanguage(input: TableRowLanguageInput): string {
  void input;
  return FALLBACK_LANGUAGE;
}

export function tableRowSeparator(enabled: boolean, chunkKind: string | null | undefined, language: string): string | null {
  void enabled;
  void chunkKind;
  void getLanguagePack;
  void language;
  void FALLBACK_SEPARATOR;
  return null;
}
