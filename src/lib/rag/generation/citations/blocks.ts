import { neutralizeCitationMarkers } from '@/lib/citations/marker-grammar';
import type { CitationLabeler, ContextBlock } from '../../types';

export type AliasedBlock = ContextBlock & { alias: string };

export interface AliasMap {
  aliases: ReadonlySet<string>;
  byAlias: ReadonlyMap<string, AliasedBlock>;
  ordered: readonly AliasedBlock[];
}

/** Labels each non-image block "[S<ordinal>] <title>" and neutralizes marker-like text inside it. */
export function createCitationLabeler(): CitationLabeler {
  return (block, ordinal) => {
    const alias = `S${ordinal}`;
    return { alias, header: `[${alias}] ${block.title}`, text: neutralizeCitationMarkers(block.text) };
  };
}

/** Builds the per-request alias map from the final context blocks; aliases must run S1..Sn in order. */
export function buildAliasMap(blocks: readonly ContextBlock[] | undefined): AliasMap {
  const ordered: AliasedBlock[] = [];
  for (const block of blocks ?? []) {
    if (block.alias === null || block.isImage) continue;
    const expected = `S${ordered.length + 1}`;
    if (block.alias !== expected) {
      throw new Error(`alias order broken at position ${ordered.length + 1}`);
    }
    ordered.push(block as AliasedBlock);
  }
  return {
    aliases: new Set(ordered.map((block) => block.alias)),
    byAlias: new Map(ordered.map((block) => [block.alias, block])),
    ordered,
  };
}
