import type { ChunkerConfig } from './chunkers';
import type { ChunkWrite } from './writer';

export interface ChunkingProfileRow {
  id: string;
  docType: string;
  childTokens: number;
  parentMode: 'none' | 'structure' | 'fixed';
  parentTokens: number | null;
  status: 'building' | 'ready' | 'active' | 'retired';
}

export interface ProfileDocument {
  filename: string;
  chunker: ChunkerConfig;
  templateHeader?: string;
}

export interface ProfileParentWrite {
  parent_index: number;
  section_path: string[];
  content: string;
  token_count: number;
}

export interface ProfileChildWrite extends ChunkWrite {
  parent_index: number | null;
}

export interface BuiltProfileChunks {
  parents: ProfileParentWrite[];
  children: ProfileChildWrite[];
  embeddingTexts: string[];
  warnings: string[];
}

export function buildProfileChunks(_document: ProfileDocument, _parseMarkdown: string, _profile: ChunkingProfileRow): BuiltProfileChunks {
  return { parents: [], children: [], embeddingTexts: [], warnings: [] };
}

export async function writeProfileChunks(): Promise<void> {
  return undefined;
}
