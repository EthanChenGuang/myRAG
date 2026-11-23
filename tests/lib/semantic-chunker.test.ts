import { describe, expect, test } from 'vitest';
import {
  createSemanticChunks,
  mergeSmallChunks,
  type ChunkingConfig,
  type SemanticChunk,
} from '@/lib/semantic-chunker';

const MAX_TOKENS = 80;
const JOIN_SLACK = 4; // sentence joins add whitespace the per-sentence estimate does not count

const BASE: ChunkingConfig = {
  targetTokens: 500,
  maxOutputTokens: MAX_TOKENS,
  minTokens: 10,
  overlapTokens: 0,
  preserveStructure: false,
  adaptiveSize: false,
};

function sentence(n: number): string {
  return `Sentence number ${n} describes the product behaviour in detail.`;
}

function paragraph(n: number): string {
  return Array.from({ length: 2 }, (_, i) => sentence(n * 10 + i)).join(' ');
}

describe('createSemanticChunks max token limit', () => {
  test('closes a paragraph chunk once the accumulated paragraphs pass maxOutputTokens', () => {
    const text = Array.from({ length: 6 }, (_, i) => paragraph(i)).join('\n\n');
    const chunks = createSemanticChunks(text, BASE);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.metadata.tokens).toBeLessThanOrEqual(MAX_TOKENS);
    }
    expect(chunks.map((c) => c.content).join('\n\n')).toBe(text);
  });

  test('splits a paragraph larger than maxOutputTokens by sentences', () => {
    const config = { ...BASE, maxOutputTokens: 60 };
    const text = Array.from({ length: 10 }, (_, i) => sentence(i)).join(' ');
    const chunks = createSemanticChunks(text, config);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.metadata.tokens).toBeLessThanOrEqual(60 + JOIN_SLACK);
      expect(chunk.metadata.boundaries.start).toBe('sentence');
    }
  });

  test('sentence-only chunking uses maxOutputTokens', () => {
    const config = { ...BASE, paragraphBoundaries: false };
    const text = Array.from({ length: 10 }, (_, i) => sentence(i)).join(' ');
    const chunks = createSemanticChunks(text, config);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.metadata.tokens).toBeLessThanOrEqual(MAX_TOKENS + JOIN_SLACK);
    }
  });

  test('plain token chunking uses maxOutputTokens', () => {
    const config = { ...BASE, paragraphBoundaries: false, sentenceBoundaries: false };
    const text = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const chunks = createSemanticChunks(text, config);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.metadata.tokens).toBeLessThanOrEqual(MAX_TOKENS + JOIN_SLACK);
      expect(chunk.metadata.type).toBe('mixed');
    }
  });
});

describe('mergeSmallChunks', () => {
  function chunk(content: string, tokens: number, position: number): SemanticChunk {
    return {
      content,
      metadata: {
        position,
        tokens,
        type: 'paragraph',
        density: 0.5,
        boundaries: { start: 'paragraph', end: 'paragraph' },
      },
    };
  }

  test('merges consecutive small chunks and keeps metadata keys', () => {
    const merged = mergeSmallChunks([chunk('a', 3, 0), chunk('b', 4, 1), chunk('c', 20, 2)], 6);
    expect(merged).toHaveLength(2);
    expect(merged[0].content).toBe('a\n\nb');
    expect(merged[0].metadata.tokens).toBe(7);
    expect(merged[0].metadata.type).toBe('mixed');
    expect(Object.keys(merged[0].metadata).sort()).toEqual([
      'boundaries',
      'density',
      'position',
      'tokens',
      'type',
    ]);
    expect(merged[1].content).toBe('c');
  });

  test('keeps a trailing small chunk', () => {
    const merged = mergeSmallChunks([chunk('a', 20, 0), chunk('b', 2, 1)], 6);
    expect(merged.map((c) => c.content)).toEqual(['a', 'b']);
  });
});
