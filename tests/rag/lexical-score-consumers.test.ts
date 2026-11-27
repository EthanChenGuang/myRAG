import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * D-35: the lexical score is unbounded under BM25 (and on another scale under ts_rank_cd), so nothing compares it with a number, takes a
 * maximum over it or divides by it. Ranking uses ranks (RRF); refusal and rerank read similarity, standaloneSimilarity and rerank scores.
 */
const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const LEX = String.raw`[\w$.?!\[\]'"]*(?:lexicalScore|lexical_score)\b`;

/** Offence patterns, each against code with comments removed. */
const OFFENCES: Array<{ name: string; re: RegExp }> = [
  { name: 'compared with a value', re: new RegExp(String.raw`\b(?:lexicalScore|lexical_score)\b(?:['"]\])?\s*(?:\?\?\s*[\w.]+\s*)?(?:[<>]=?|===?\s*-?\d)`) },
  { name: 'compared from the left', re: new RegExp(String.raw`(?:[<>]=?|[!=]==?)\s*\(?\s*${LEX}`) },
  { name: 'maximum or minimum over it', re: new RegExp(String.raw`Math\.(?:max|min)\s*\([^)]*(?:lexicalScore|lexical_score)`) },
  { name: 'divided by it', re: new RegExp(String.raw`/\s*\(?\s*${LEX}`) },
  { name: 'divided', re: new RegExp(String.raw`\b(?:lexicalScore|lexical_score)\b(?:['"]\])?\s*(?:\?\?\s*[\w.]+\s*)?\)?\s*/(?![/*])`) },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs|cjs|mts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function offencesIn(name: string, text: string): string[] {
  const out: string[] = [];
  stripComments(text)
    .split('\n')
    .forEach((line, i) => {
      for (const offence of OFFENCES) if (offence.re.test(line)) out.push(`${name}:${i + 1}: lexical score ${offence.name}: ${line.trim()}`);
    });
  return out;
}

describe('no consumer thresholds or normalises the lexical score (D-35)', () => {
  test('the scan finds the offences it is meant to find', () => {
    const samples = [
      'if (hit.lexicalScore > 0.5) keep(hit);',
      'const ok = row.lexical_score >= floor;',
      'return 0.1 < hit.lexicalScore;',
      'const top = Math.max(...hits.map((h) => h.lexicalScore ?? 0));',
      'const norm = (hit.lexicalScore ?? 0) / top;',
      'const share = value / hit.lexicalScore;',
      "if (row['lexical_score'] > 1) drop(row);",
    ];
    for (const sample of samples) expect(offencesIn('sample', sample), sample).toHaveLength(1);
    const allowed = [
      'lexicalScore: row.lexical_score,',
      'lexicalScore: leg === "lexical" ? score : null,',
      'const legs = hits.map((h) => ({ ...h, lexicalScore: null }));',
      '// a comment may say lexicalScore > 0 without code doing it',
      "type ValidatedChunk = Omit<RankedHit, 'rank' | 'similarity' | 'lexicalScore'>;",
    ];
    for (const sample of allowed) expect(offencesIn('sample', sample), sample).toEqual([]);
  });

  test('no file under src/ compares, maximises or divides by lexicalScore or lexical_score', () => {
    const offences = sourceFiles(SRC).flatMap((file) => offencesIn(path.relative(ROOT, file), fs.readFileSync(file, 'utf8')));
    expect(offences, offences.join('\n')).toEqual([]);
  });

  test('the refusal and rerank code read similarity, standaloneSimilarity and rerank scores, never the lexical score', () => {
    const files = [
      path.join(SRC, 'lib/rag/v2/stages/rank.ts'),
      ...sourceFiles(path.join(SRC, 'lib/rag/refusal')),
      ...sourceFiles(path.join(SRC, 'lib/rag/rerank')),
    ];
    const readers = files.filter((file) => /lexicalScore|lexical_score/.test(stripComments(fs.readFileSync(file, 'utf8')))).map((file) => path.relative(ROOT, file));
    expect(readers).toEqual([]);
    const rank = stripComments(fs.readFileSync(path.join(SRC, 'lib/rag/v2/stages/rank.ts'), 'utf8'));
    const refusal = /function applyRefusal\b[\s\S]*?\n}\n/.exec(rank)?.[0] ?? '';
    expect(refusal, 'applyRefusal is defined in rank.ts').not.toBe('');
    expect(refusal).toMatch(/similarity/);
  });
});
