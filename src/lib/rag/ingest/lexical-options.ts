import type { ResolvedLexicalOptions } from '../lexical/resolve-options';
import { lexicalText } from '../lexical/tokenize';
import type { StageContext } from './types';

export interface IngestLexical {
  version: number;
  resolved: ResolvedLexicalOptions;
}

export async function ingestLexical(_ctx: StageContext): Promise<IngestLexical> {
  return { version: 2, resolved: { options: undefined, stamp: { dictVersion: null, patterns: null }, warnings: [] } };
}

export function lexicalFieldsFor(_lexical: IngestLexical, sectionPath: string[], content: string): { lexical_text: string; metadata: Record<string, unknown> } {
  return { lexical_text: lexicalText(sectionPath, content), metadata: {} };
}
