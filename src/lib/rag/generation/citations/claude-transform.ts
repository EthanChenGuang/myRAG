import type { StreamTextTransform, ToolSet } from 'ai';
import type { AliasMap } from './blocks';

export interface ClaudeCitation {
  alias: string;
  citedText: string;
  startCharIndex: number | null;
  endCharIndex: number | null;
}

export interface ClaudeCitationSink {
  cite(citation: ClaudeCitation): void;
  invalid(filename: string | null): void;
}

export function claudeMarkerTransform(_aliasMap: Pick<AliasMap, 'aliases'>, _sink: ClaudeCitationSink): StreamTextTransform<ToolSet> {
  return () => new TransformStream();
}
