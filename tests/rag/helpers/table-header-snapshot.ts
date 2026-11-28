import { createHash } from 'node:crypto';
import { chunkDocument, type ChunkerConfig } from '@/lib/rag/ingest/chunkers';
import { chunkParentChild } from '@/lib/rag/ingest/chunkers/parent-child';
import { buildProfileChunks, type ChunkingProfileRow } from '@/lib/rag/ingest/profile-chunks';
import processingProfiles from '../../../config/rag/processing-profiles.json';
import { fixtureSources } from './legacy-chunk-snapshot';

export const PROCESSING_PROFILES = (processingProfiles as { profiles: Array<{ id: string; doc_type: string; chunker: ChunkerConfig }> }).profiles;

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const PROFILE_ROWS: Array<Pick<ChunkingProfileRow, 'childTokens' | 'parentMode' | 'parentTokens'>> = [
  { childTokens: 48, parentMode: 'none', parentTokens: null },
  { childTokens: 48, parentMode: 'structure', parentTokens: 160 },
  { childTokens: 48, parentMode: 'fixed', parentTokens: 160 },
];

/**
 * sha256 of chunkDocument, chunkParentChild and buildProfileChunks for every ingest fixture and each of the six processing profiles with
 * RAG_TABLE_HEADER_REPEAT=profile (and with the option absent): the D-19 "profile mode is today's behaviour" snapshot.
 */
export function profileModeDigests(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of fixtureSources()) {
    for (const profile of PROCESSING_PROFILES) {
      const key = `${source.name}|${profile.id}`;
      out[`${key}|chunk`] = digest(chunkDocument(profile.chunker, { markdown: source.markdown }, { tableHeaderRepeat: 'profile' }));
      out[`${key}|chunk:absent`] = digest(chunkDocument(profile.chunker, { markdown: source.markdown }));
      for (const row of PROFILE_ROWS) {
        out[`${key}|parent-child:${row.parentMode}`] = digest(chunkParentChild(source.markdown, row, profile.chunker));
        const built = buildProfileChunks(
          { filename: 'fixture.md', chunker: profile.chunker, tableHeaderRepeat: 'profile' },
          source.markdown,
          { id: 'p', docType: profile.doc_type, status: 'active', ...row } as ChunkingProfileRow,
        );
        out[`${key}|profile-chunks:${row.parentMode}`] = digest(built);
      }
    }
  }
  return out;
}
