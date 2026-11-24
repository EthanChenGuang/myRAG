import type { ChunkDraft } from '../types';
import type { ChunkerConfig } from './index';

export interface ParentChildProfile {
  childTokens: number;
  parentMode: 'none' | 'structure' | 'fixed';
  parentTokens: number | null;
}

export interface ParentDraft {
  parent_index: number;
  section_path: string[];
  content: string;
  token_count: number;
}

export interface ChildDraft extends ChunkDraft {
  parent_index: number | null;
}

export interface ParentChildResult {
  parents: ParentDraft[];
  children: ChildDraft[];
  warnings: string[];
}

export function chunkParentChild(_markdown: string, _profile: ParentChildProfile, _chunker: ChunkerConfig): ParentChildResult {
  return { parents: [], children: [], warnings: [] };
}
