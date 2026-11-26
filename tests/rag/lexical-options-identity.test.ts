import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import type { LexicalOptions } from '@/lib/rag/lexical/options';
import {
  LEXICAL_VERSION,
  identifierLexicalLookupForms,
  lexicalText,
  lexicalTokens,
  queryLexicalTokens,
} from '@/lib/rag/lexical/tokenize';

// D-08/D-42: with the options argument absent, undefined, empty or inert, every exported function
// returns what it returns without it. The untouched cases of lexical-tokenize.test.ts and
// tokenize-v2.test.ts pin the absolute values; this file feeds the same strings and the fixture corpus.

const ROOT = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(ROOT, 'eval', 'fixtures', 'corpus');

function corpusFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? corpusFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
    .sort();
}

function existingCaseStrings(): string[] {
  const files = ['tests/rag/lexical-tokenize.test.ts', 'tests/rag/lexical/tokenize-v2.test.ts'];
  const out = new Set<string>();
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/gu)) {
      const raw = match[1] ?? match[2] ?? '';
      if (raw.startsWith('@/') || raw === 'vitest') continue;
      out.add(raw.replace(/\\(.)/gu, '$1'));
    }
  }
  return [...out];
}

const INERT: Array<[string, LexicalOptions]> = [
  ['empty options', {}],
  ['stemming off for it', { language: 'it', stemIt: false }],
  ['stemming on for a language without a stemmer', { language: 'en', stemIt: true }],
  ['stemming on without a language', { language: null, stemIt: true }],
  ['null dictionary', { dictionary: null }],
  ['dictionary without matches', { dictionary: { version: 's0.w0', match: () => [] } }],
];

const corpus = corpusFiles(CORPUS).map((file) => [path.relative(ROOT, file), fs.readFileSync(file, 'utf8')] as const);
const cases = existingCaseStrings();

describe('tokenizer version guard (D-42)', () => {
  it('LEXICAL_VERSION stays 2: a bump would make every chunk and every refusal cell stale while the switches are off', () => {
    expect(LEXICAL_VERSION).toBe(2);
  });

  it('reads a non-empty corpus and the existing cases', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(19);
    expect(cases.length).toBeGreaterThan(20);
  });
});

function expectSameOutputs(text: string): void {
  const lines = text.split('\n');
  const base = {
    tokens: lexicalTokens(text),
    query: queryLexicalTokens(text),
    text: lexicalText(['Sezione uno', '第一章 总则'], text),
    lines: lines.map((line) => [queryLexicalTokens(line), identifierLexicalLookupForms(line.slice(0, 48))]),
    chunk: chunkLexicalText({ sectionPath: ['Part'], content: text, chunkKind: 'image', metadata: { image_url: 'u', name: 'n' }, documentFilename: 'file.pdf', tableRowSeparator: ',' }),
  };
  expect({
    tokens: lexicalTokens(text, undefined),
    query: queryLexicalTokens(text, undefined),
    text: lexicalText(['Sezione uno', '第一章 总则'], text, undefined),
    lines: lines.map((line) => [queryLexicalTokens(line, undefined), identifierLexicalLookupForms(line.slice(0, 48), undefined)]),
    chunk: chunkLexicalText({ sectionPath: ['Part'], content: text, chunkKind: 'image', metadata: { image_url: 'u', name: 'n' }, documentFilename: 'file.pdf', tableRowSeparator: ',' }, undefined),
  }).toEqual(base);
  for (const [, options] of INERT) {
    expect({
      tokens: lexicalTokens(text, options),
      query: queryLexicalTokens(text, options),
      text: lexicalText(['Sezione uno', '第一章 总则'], text, options),
      lines: lines.map((line) => [queryLexicalTokens(line, options), identifierLexicalLookupForms(line.slice(0, 48), options)]),
      chunk: chunkLexicalText({ sectionPath: ['Part'], content: text, chunkKind: 'image', metadata: { image_url: 'u', name: 'n' }, documentFilename: 'file.pdf', tableRowSeparator: ',' }, options),
    }).toEqual(base);
  }
}

describe('fixture corpus: omitted, undefined and inert options give identical output', () => {
  it.each(corpus)('%s', (_name, text) => {
    expectSameOutputs(text);
  });
});

describe('existing test strings: omitted, undefined and inert options give identical output', () => {
  it('every string literal of the existing tokenizer tests', () => {
    for (const text of cases) expectSameOutputs(text);
  });
});
