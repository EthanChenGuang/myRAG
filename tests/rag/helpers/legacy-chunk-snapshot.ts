import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CHUNKERS, type ChunkerConfig } from '@/lib/rag/ingest/chunkers';
import { chunkParentChild } from '@/lib/rag/ingest/chunkers/parent-child';
import processingProfiles from '../../../config/rag/processing-profiles.json';

const ROOT = path.resolve(__dirname, '../../..');
const TEXT_DIR = path.join(ROOT, 'eval/fixtures/ingest/text');
const RECORDED_DIR = path.join(ROOT, 'eval/fixtures/ingest/recorded');
const BUDGETS = [512, 64, 24] as const;

/** Every Markdown source of the ingest fixtures: the text documents and the recorded parse output of the PDF documents. */
export function fixtureSources(): Array<{ name: string; markdown: string }> {
  const sources: Array<{ name: string; markdown: string }> = [];
  for (const file of fs.readdirSync(TEXT_DIR).filter((entry) => entry.endsWith('.md')).sort()) {
    sources.push({ name: `text/${file}`, markdown: fs.readFileSync(path.join(TEXT_DIR, file), 'utf8') });
  }
  for (const file of fs.readdirSync(RECORDED_DIR).filter((entry) => entry.endsWith('.parse.json')).sort()) {
    const parsed = JSON.parse(fs.readFileSync(path.join(RECORDED_DIR, file), 'utf8')) as { markdown?: string };
    if (typeof parsed.markdown === 'string' && parsed.markdown.trim() !== '') sources.push({ name: `recorded/${file}`, markdown: parsed.markdown });
  }
  return sources;
}

function chunkers(): Array<{ docType: string; chunker: ChunkerConfig }> {
  const seen = new Set<string>();
  const out: Array<{ docType: string; chunker: ChunkerConfig }> = [];
  for (const profile of (processingProfiles as { profiles: Array<{ doc_type: string; chunker: ChunkerConfig }> }).profiles) {
    if (seen.has(profile.chunker.kind) || profile.chunker.kind === 'image_caption') continue;
    seen.add(profile.chunker.kind);
    out.push({ docType: profile.doc_type, chunker: profile.chunker });
  }
  return out;
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** sha256 of the chunker output for every fixture, chunker kind and budget, plus the three parent-child modes. */
export function legacyChunkDigests(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of fixtureSources()) {
    for (const { docType, chunker } of chunkers()) {
      for (const maxTokens of BUDGETS) {
        const config: ChunkerConfig = { ...chunker, max_tokens: maxTokens, overlap_tokens: Math.min(chunker.overlap_tokens, Math.floor(maxTokens / 4)), min_chunk_tokens: Math.min(chunker.min_chunk_tokens, Math.floor(maxTokens / 4)) };
        const run = CHUNKERS[chunker.kind];
        if (!run) continue;
        out[`${source.name}|${docType}|${maxTokens}`] = digest(run(source.markdown, config));
      }
      for (const parentMode of ['none', 'structure', 'fixed'] as const) {
        const result = chunkParentChild(source.markdown, { childTokens: 48, parentMode, parentTokens: parentMode === 'none' ? null : 160 }, chunker);
        out[`${source.name}|${docType}|parent-child:${parentMode}`] = digest(result);
      }
    }
  }
  return out;
}
