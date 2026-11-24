import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChunkerUnavailableError, type ChunkerConfig } from '@/lib/rag/ingest/chunkers';
import { chunkParentChild, type ParentChildProfile, type ParentChildResult } from '@/lib/rag/ingest/chunkers/parent-child';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { buildEmbeddingText } from '@/lib/rag/ingest/text/embedding-text';
import { countTokens } from '@/lib/rag/ingest/text/tokens';

const LEGAL: ChunkerConfig = getProcessingProfile('contract_legal').chunker;
const SECTIONS: ChunkerConfig = { kind: 'markdown_sections', max_tokens: 512, overlap_tokens: 0, min_chunk_tokens: 0, repeat_table_header: true };
const TABLES: ChunkerConfig = { ...SECTIONS, kind: 'table_aware' };

const STRUCTURE_256: ParentChildProfile = { childTokens: 256, parentMode: 'structure', parentTokens: 1024 };
const FIXED_128: ParentChildProfile = { childTokens: 128, parentMode: 'fixed', parentTokens: 512 };

const embeddingTokens = (chunk: { section_path: string[]; content: string }): number =>
  countTokens(buildEmbeddingText({ section_path: chunk.section_path, content: chunk.content }));

const CONTRACT_FIXTURE = fs.readFileSync(path.resolve(__dirname, '../../../eval/fixtures/ingest/text/contract-zh.md'), 'utf8');

const item = (index: number): string =>
  `(${String.fromCharCode(96 + (index % 26) + 1)}${index}) The supplier shall deliver lot ${index} of the equipment to the buyer within ${10 + index} days and bear the transport risk until acceptance.`;
const LONG_CLAUSE = ['Article 9 Obligations', 'The supplier has the following obligations:', ...Array.from({ length: 40 }, (_, index) => item(index))].join('\n');

const SENTENCES = Array.from({ length: 60 }, (_, index) => `Sentence number ${index} explains how the warranty period of the equipment is counted from delivery.`);
const PROSE = `## Warranty\n\n${SENTENCES.join(' ')}`;

const HEADER = '|Item|Closing|Opening|Note|';
const SEPARATOR = '|---|---|---|---|';
const ROWS = Array.from({ length: 40 }, (_, index) => `|Item ${index}|${1000 + index}.00|${2000 + index}.00|note text ${index}|`);
const TABLE = `## Balance sheet\n\n${[HEADER, SEPARATOR, ...ROWS].join('\n')}\n`;

function assertChildrenInsideParents(result: ParentChildResult): void {
  for (const child of result.children) {
    const parent = result.parents[child.parent_index ?? -1];
    expect(parent, 'child without a parent').toBeDefined();
    expect(child.section_path).toEqual(parent?.section_path);
    for (const line of child.content.split('\n')) {
      if (line.trim() === '') continue;
      expect(parent?.content.includes(line.trim()), `child line not inside its parent: ${line.slice(0, 40)}`).toBe(true);
    }
  }
}

describe('parent-child chunker', () => {
  it('structure mode 256/1024 on the contract fixture: each clause up to 1024 tokens is one parent and every child lies inside one parent', () => {
    const result = chunkParentChild(CONTRACT_FIXTURE, STRUCTURE_256, LEGAL);
    const clauseParents = result.parents.filter((parent) => parent.section_path.some((part) => /^第[4-6]条/.test(part)));
    expect(clauseParents.map((parent) => parent.section_path.at(-1))).toEqual(['第4条 服务内容', '第5条 适用范围', '第6条 费用与支付']);
    const fifth = clauseParents[1];
    expect(fifth?.content).toContain('但以下情况除外');
    expect(fifth?.content).toContain('（四）双方另行书面约定不适用本合同的设备。');
    for (const parent of result.parents) {
      expect(parent.token_count).toBe(countTokens(parent.content));
      expect(embeddingTokens(parent)).toBeLessThanOrEqual(1024);
    }
    expect(result.children.length).toBeGreaterThanOrEqual(result.parents.length);
    for (const child of result.children) expect(embeddingTokens(child)).toBeLessThanOrEqual(256);
    assertChildrenInsideParents(result);
  });

  it('structure mode splits a clause longer than the parent cap at item boundaries into parents that repeat the clause heading', () => {
    const result = chunkParentChild(`${LONG_CLAUSE}\n`, STRUCTURE_256, LEGAL);
    expect(countTokens(LONG_CLAUSE)).toBeGreaterThan(1024);
    expect(result.parents.length).toBeGreaterThanOrEqual(2);
    for (const parent of result.parents) {
      expect(parent.content.startsWith('Article 9 Obligations')).toBe(true);
      expect(embeddingTokens(parent)).toBeLessThanOrEqual(1024);
    }
    expect(result.children.length).toBeGreaterThan(result.parents.length);
    for (const child of result.children) expect(embeddingTokens(child)).toBeLessThanOrEqual(256);
    assertChildrenInsideParents(result);
    const items = result.parents.flatMap((parent) => parent.content.split('\n').filter((line) => /^\([a-z]\d+\)/.test(line)));
    expect(items).toHaveLength(40);
  });

  it('fixed mode 128/512 cuts parents of at most 512 tokens at sentence ends and children of at most 128 tokens', () => {
    const result = chunkParentChild(PROSE, FIXED_128, SECTIONS);
    expect(result.parents.length).toBeGreaterThanOrEqual(2);
    result.parents.forEach((parent, index) => {
      expect(embeddingTokens(parent)).toBeLessThanOrEqual(512);
      expect(parent.section_path).toEqual(['Warranty']);
      expect(parent.content.endsWith('.'), `parent ${index} does not end at a sentence end`).toBe(true);
      expect(parent.parent_index).toBe(index);
    });
    expect(result.children.length).toBeGreaterThan(result.parents.length);
    for (const child of result.children) expect(embeddingTokens(child)).toBeLessThanOrEqual(128);
    assertChildrenInsideParents(result);
    const text = result.children.map((child) => child.content).join(' ');
    for (let index = 0; index < SENTENCES.length; index += 1) expect(text).toContain(`Sentence number ${index} explains`);
  });

  it('never splits a table row in a child and repeats the header and separator on every piece of a table larger than child_tokens', () => {
    for (const [profile, chunker] of [
      [STRUCTURE_256, TABLES],
      [{ childTokens: 128, parentMode: 'structure', parentTokens: 512 } satisfies ParentChildProfile, TABLES],
      [FIXED_128, SECTIONS],
    ] as const) {
      const result = chunkParentChild(TABLE, profile, chunker);
      const tableChildren = result.children.filter((child) => child.content.includes('|'));
      expect(tableChildren.length).toBeGreaterThan(1);
      const known = new Set([HEADER, SEPARATOR, ...ROWS]);
      const seen = new Set<string>();
      for (const child of tableChildren) {
        const lines = child.content.split('\n').filter((line) => line.startsWith('|'));
        expect(lines.slice(0, 2)).toEqual([HEADER, SEPARATOR]);
        for (const line of lines) {
          expect(known.has(line), `split or invented row: ${line}`).toBe(true);
          seen.add(line);
        }
        expect(embeddingTokens(child)).toBeLessThanOrEqual(profile.childTokens);
      }
      for (const row of ROWS) expect(seen.has(row), `row lost: ${row}`).toBe(true);
    }
  });

  it('is deterministic and numbers parents from zero', () => {
    const first = chunkParentChild(`${LONG_CLAUSE}\n`, STRUCTURE_256, LEGAL);
    const second = chunkParentChild(`${LONG_CLAUSE}\n`, STRUCTURE_256, LEGAL);
    expect(second).toEqual(first);
    expect(first.parents.map((parent) => parent.parent_index)).toEqual(first.parents.map((_, index) => index));
    const order = first.children.map((child) => child.parent_index ?? -1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('reads the chunker kind from the profile data: the same text gives clause parents under legal_clauses and section parents under markdown_sections', () => {
    const markdown = ['## Terms', '', 'Article 1 Scope', 'This agreement covers the supply.', '', 'Article 2 Price', 'The price is fixed.'].join('\n');
    const legal = chunkParentChild(markdown, STRUCTURE_256, LEGAL);
    const sections = chunkParentChild(markdown, STRUCTURE_256, SECTIONS);
    expect(legal.parents.map((parent) => parent.section_path.at(-1))).toEqual(['Article 1 Scope', 'Article 2 Price']);
    expect(sections.parents.map((parent) => parent.section_path)).toEqual([['Terms']]);
  });

  it('answers a kind that has no chunker with ChunkerUnavailableError', () => {
    expect(() => chunkParentChild('text', STRUCTURE_256, { ...SECTIONS, kind: 'unregistered' as ChunkerConfig['kind'] })).toThrow(ChunkerUnavailableError);
  });

  it('gives no parents for a profile without a parent mode, and nothing for a caption-only picture', () => {
    const flat = chunkParentChild(PROSE, { childTokens: 128, parentMode: 'none', parentTokens: null }, SECTIONS);
    expect(flat.parents).toEqual([]);
    expect(flat.children.length).toBeGreaterThan(1);
    expect(flat.children.every((child) => child.parent_index === null)).toBe(true);
    const picture = chunkParentChild('![image](x.png)', STRUCTURE_256, { ...SECTIONS, kind: 'image_caption' });
    expect(picture).toEqual({ parents: [], children: [], warnings: [] });
  });
});
