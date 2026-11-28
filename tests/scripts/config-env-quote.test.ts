import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const MODULE = path.join(ROOT, 'scripts', 'config-env-quote.js');
const PROMPTS = ['RAG_FT_SLOT_A_QUERY_PROMPT', 'RAG_FT_SLOT_A_DOCUMENT_PROMPT', 'RAG_FT_SLOT_B_QUERY_PROMPT', 'RAG_FT_SLOT_B_DOCUMENT_PROMPT'];

function formatter(): (value: string) => string {
  expect(fs.existsSync(MODULE), 'scripts/config-env-quote.js exists').toBe(true);
  return (require(MODULE) as { formatEnvValue: (value: string) => string }).formatEnvValue;
}

function roundTrip(value: string): string {
  return dotenv.parse(`RAG_FT_SLOT_A_QUERY_PROMPT=${formatter()(value)}\nNEXT=after\n`).RAG_FT_SLOT_A_QUERY_PROMPT;
}

describe('slot prompts written to .env.local (06.1 W1)', () => {
  it('keeps an empty or plain value byte for byte', () => {
    const format = formatter();
    expect(format('')).toBe('');
    expect(format('plain-value')).toBe('plain-value');
  });

  it('round-trips a prompt with a newline, a trailing space, a leading space, a hash and quotes through dotenv', () => {
    for (const value of [
      'Instruct: Given a question, retrieve passages that answer it\nQuery:',
      'query: ',
      ' leading space',
      'value # not a comment',
      'say "hello"',
      "it's quoted",
      'both "double" and \'single\'',
      'multi\nline "with" quotes',
      'windows\r\nline',
    ]) {
      expect(roundTrip(value)).toBe(value);
    }
  });

  it('every config-server template writes the four slot prompts through formatEnvValue', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'config-server.js'), 'utf8');
    for (const key of PROMPTS) {
      const lines = source.split('\n').filter((line) => line.includes(`${key}=\${`));
      expect(lines.length, key).toBe(3);
      for (const line of lines) expect(line, key).toContain('formatEnvValue(');
    }
  });

  it('the Config UI edits each slot prompt in a textarea', () => {
    const html = fs.readFileSync(path.join(ROOT, 'scripts', 'config-ui', 'index.html'), 'utf8');
    for (const key of PROMPTS) {
      expect(html, key).toMatch(new RegExp(`<textarea[^>]*id="${key}"`));
      expect(html, key).not.toMatch(new RegExp(`<input[^>]*id="${key}"`));
    }
  });
});
