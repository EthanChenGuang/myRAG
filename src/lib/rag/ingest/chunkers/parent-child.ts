import { countTokens } from '../text/tokens';
import type { ChunkDraft } from '../types';
import { CHUNKERS, ChunkerUnavailableError, type ChunkerConfig } from './index';
import { chunkMarkdownSections, type MarkdownChunkOptions } from './markdown-sections';
import { chunkTableSection } from './table-aware';

export interface ParentChildProfile {
  childTokens: number;
  parentMode: 'none' | 'structure' | 'fixed';
  /** Required for structure and fixed; the cap of a parent in tokens of its embedding text. */
  parentTokens: number | null;
}

export interface ParentDraft {
  parent_index: number;
  section_path: string[];
  content: string;
  token_count: number;
}

export interface ChildDraft extends ChunkDraft {
  /** Null only for a profile without parents. */
  parent_index: number | null;
}

export interface ParentChildResult {
  parents: ParentDraft[];
  children: ChildDraft[];
  warnings: string[];
}

function parentCap(profile: ParentChildProfile): number {
  const cap = profile.parentTokens;
  if (cap === null || !Number.isInteger(cap) || cap < profile.childTokens) {
    throw new RangeError('[Ingest] parentTokens must be an integer of at least childTokens');
  }
  return cap;
}

/** Whole sections, clauses or tables up to the cap, cut by the chunker kind the processing profile names. */
function structureParents(markdown: string, chunker: ChunkerConfig, cap: number): { drafts: ChunkDraft[]; warnings: string[] } {
  const chunk = CHUNKERS[chunker.kind];
  if (!chunk) throw new ChunkerUnavailableError(chunker.kind);
  const result = chunk(markdown, { ...chunker, max_tokens: cap, overlap_tokens: 0, min_chunk_tokens: 0 });
  return { drafts: result.captionOnly === true ? [] : result.chunks, warnings: result.warnings };
}

/** Windows of at most `cap` tokens that end at sentence boundaries and stay inside one heading section; a window that starts inside a table repeats its header. */
function fixedParents(markdown: string, cap: number): ChunkDraft[] {
  return chunkMarkdownSections(markdown, { maxTokens: cap, overlapTokens: 0, minChunkTokens: 0, repeatTableHeader: true });
}

/** Children of one parent: text packed to the child budget, tables by whole rows with the header row repeated. */
function childrenOf(parent: ParentDraft, options: MarkdownChunkOptions, warnings: Set<string>): ChunkDraft[] {
  return chunkTableSection(parent.section_path, parent.content.split('\n'), options, warnings);
}

/**
 * Cuts a parsed document into parents and children (CHK-03). Parents come from the processing profile's chunker in structure mode (its
 * sections, clauses or tables, capped at parentTokens) or are parentTokens windows in fixed mode. Each parent is then cut into children of at
 * most childTokens, measured on the embedding text, that never split a table row and repeat a table header when a table is cut. Children carry
 * the section path of their parent. The chunker kind comes from the processing profile data (a ChunkerConfig); no document type is compared here.
 */
export function chunkParentChild(markdown: string, profile: ParentChildProfile, chunker: ChunkerConfig): ParentChildResult {
  const warnings = new Set<string>();
  const childOptions: MarkdownChunkOptions = {
    maxTokens: profile.childTokens,
    overlapTokens: 0,
    minChunkTokens: Math.min(chunker.min_chunk_tokens, Math.floor(profile.childTokens / 2)),
    repeatTableHeader: true,
  };

  if (profile.parentMode === 'none') {
    const chunk = CHUNKERS[chunker.kind];
    if (!chunk) throw new ChunkerUnavailableError(chunker.kind);
    const result = chunk(markdown, {
      ...chunker,
      max_tokens: profile.childTokens,
      overlap_tokens: 0,
      min_chunk_tokens: childOptions.minChunkTokens,
      repeat_table_header: true,
    });
    for (const warning of result.warnings) warnings.add(warning);
    const children = result.captionOnly === true ? [] : result.chunks.map((draft): ChildDraft => ({ ...draft, section_path: [...draft.section_path], parent_index: null }));
    return { parents: [], children, warnings: [...warnings] };
  }

  const cap = parentCap(profile);
  let drafts: ChunkDraft[];
  if (profile.parentMode === 'structure') {
    const built = structureParents(markdown, chunker, cap);
    drafts = built.drafts;
    for (const warning of built.warnings) warnings.add(warning);
  } else {
    drafts = fixedParents(markdown, cap);
  }

  const parents: ParentDraft[] = [];
  for (const draft of drafts) {
    if (draft.content.trim() === '') continue;
    parents.push({
      parent_index: parents.length,
      section_path: [...draft.section_path],
      content: draft.content,
      token_count: countTokens(draft.content),
    });
  }

  const children: ChildDraft[] = [];
  for (const parent of parents) {
    for (const draft of childrenOf(parent, childOptions, warnings)) {
      children.push({ ...draft, section_path: [...parent.section_path], parent_index: parent.parent_index });
    }
  }
  return { parents, children, warnings: [...warnings] };
}
