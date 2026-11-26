import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stemItalian } from '@/lib/rag/lexical/stem-it';

const DIR = path.resolve(__dirname, '..', 'fixtures', 'snowball-italian');
const read = (name: string): Buffer => fs.readFileSync(path.join(DIR, name));
const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

function recordedHash(name: string): string {
  const source = read('SOURCE.md').toString('utf8');
  const row = source.split('\n').find((line) => line.startsWith(`| \`${name}\``));
  const match = row?.match(/`([0-9a-f]{64})`/u);
  if (!match) throw new Error(`SOURCE.md has no SHA-256 for ${name}`);
  return match[1]!;
}

const lines = (name: string): string[] => read(name).toString('utf8').split('\n').filter((line) => line !== '');

describe('stemItalian against the official Snowball vectors', () => {
  it.each(['voc.txt', 'output.txt', 'COPYING'])('%s matches the SHA-256 pinned in SOURCE.md', (name) => {
    expect(sha256(read(name))).toBe(recordedHash(name));
  });

  it('the licence notice sits beside the vectors', () => {
    expect(read('COPYING').toString('utf8')).toMatch(/Redistribution and use in source and binary forms/u);
  });

  it('returns the expected stem for every word of the vocabulary', () => {
    const words = lines('voc.txt');
    const stems = lines('output.txt');
    expect(words.length).toBe(stems.length);
    expect(words.length).toBeGreaterThan(30000);
    const mismatches: string[] = [];
    words.forEach((word, index) => {
      const actual = stemItalian(word);
      if (actual !== stems[index]) mismatches.push(`${word}: expected ${stems[index]}, got ${actual}`);
    });
    expect(mismatches.slice(0, 5), `${mismatches.length} mismatches, first: ${mismatches[0] ?? 'none'}`).toEqual([]);
  });
});

describe('stemItalian contract', () => {
  it('returns the empty string for the empty string', () => {
    expect(stemItalian('')).toBe('');
  });

  it('leaves a word without an Italian suffix unchanged', () => {
    expect(stemItalian('brt')).toBe('brt');
  });

  it('maps one synthetic singular and plural pair to one stem', () => {
    expect(stemItalian('zorvello')).toBe(stemItalian('zorvelli'));
    expect(stemItalian('zorvello')).not.toBe('zorvello');
  });

  it('is pure: the same word gives the same stem twice', () => {
    expect(stemItalian('zorvellini')).toBe(stemItalian('zorvellini'));
  });
});
