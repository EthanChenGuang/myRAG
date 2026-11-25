import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EnvWriteError,
  applyEnvUpdates,
  encodeEnvValue,
  invalidEnvValueReason,
  stringifyJsonForEnv,
  writeEnvUpdates,
} from '@/lib/env-file';
import { loadLikeNext } from '../helpers/next-env-loader';

const BASE = [
  '# header comment',
  'SUPABASE_SERVICE_ROLE_KEY=placeholder-service-role',
  'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321',
  'NEXT_PUBLIC_APP_NAME=Demo # trailing comment',
  '',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE=multi-tenant',
  '',
].join('\n');

function write(updates: Record<string, string>, base = BASE) {
  return applyEnvUpdates(base, updates);
}

function expectOnlyThisChanged(next: string, name: string, literal: string) {
  const before = loadLikeNext(BASE);
  const after = loadLikeNext(next);
  expect(after[name]).toBe(literal);
  for (const key of Object.keys(before)) {
    if (key !== name) expect(after[key]).toBe(before[key]);
  }
  expect(Object.keys(after).sort()).toEqual([...new Set([...Object.keys(before), name])].sort());
}

describe('env-file writer', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['carriage return', 'x\rNEXT_PUBLIC_SUPABASE_URL=https://attacker'],
    ['line feed', 'x\nNEXT_PUBLIC_SUPABASE_URL=https://attacker'],
    ['NUL', 'x\0y'],
    ['escape', 'x\u001by'],
    ['line separator', 'x\u2028y'],
    ['next line', 'x\u0085y'],
  ])('rejects a value with a %s', (_label, value) => {
    expect(invalidEnvValueReason(value)).not.toBeNull();
    expect(() => write({ RAG_PRE_CONTEXT: value })).toThrow(EnvWriteError);
  });

  it('a lone carriage return never creates a second variable, even through the real loader', () => {
    expect(() => write({ RAG_PRE_CONTEXT: 'hello\rSUPABASE_URL=https://evil' })).toThrow(/line break/);
  });

  it.each([
    ['backtick pattern', '$`'],
    ['match pattern', '$&'],
    ['post-match pattern', "$'"],
    ['group pattern', '$1 $$'],
    ['variable expansion', '${SUPABASE_SERVICE_ROLE_KEY}'],
    ['bare variable', '$SUPABASE_SERVICE_ROLE_KEY'],
    ['default expansion', '${MISSING:-fallback}'],
    ['escaped dollar', 'a\\$b'],
    ['comment marker', 'before # after'],
    ['edge whitespace', '  padded  '],
    ['quoted', '"quoted"'],
    ['apostrophe', "it's"],
    ['mixed quotes', `it's "a" \`b\``],
    ['backslash n text', 'line one\\nline two'],
    ['empty', ''],
  ])('loads the exact literal back for %s', (_label, value) => {
    const next = write({ RAG_PRE_CONTEXT: value });
    expectOnlyThisChanged(next, 'RAG_PRE_CONTEXT', value);
  });

  it('updates an existing line in place without touching the others', () => {
    const next = write({ NEXT_PUBLIC_APP_NAME: '$`' });
    expectOnlyThisChanged(next, 'NEXT_PUBLIC_APP_NAME', '$`');
    expect(next.split('\n').filter((line) => line.startsWith('NEXT_PUBLIC_APP_NAME=')).length).toBe(1);
    expect(next).toContain('# header comment');
  });

  it('structured JSON with every special character loads back as the same data', () => {
    const data = [{ id: 'm', displayName: '$` O\'Brien #1 ${SUPABASE_SERVICE_ROLE_KEY} "q" \\' }];
    const text = stringifyJsonForEnv(data);
    expect(text).not.toMatch(/[$#'`]/);
    const next = write({ NEXT_PUBLIC_OPENAI_MODELS: text });
    expect(JSON.parse(loadLikeNext(next).NEXT_PUBLIC_OPENAI_MODELS)).toEqual(data);
  });

  it('a backtick-dollar display name does not copy earlier lines into the value', () => {
    const next = write({ NEXT_PUBLIC_OPENAI_MODELS: JSON.stringify([{ id: 'm', displayName: '$`' }]) });
    const loaded = loadLikeNext(next);
    expect(loaded.NEXT_PUBLIC_OPENAI_MODELS).not.toContain('placeholder-service-role');
    expect(JSON.parse(loaded.NEXT_PUBLIC_OPENAI_MODELS)[0].displayName).toBe('$`');
  });

  it('refuses a name that is not writable', () => {
    for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'NODE_OPTIONS', 'BAD NAME']) {
      expect(() => write({ [name]: 'x' })).toThrow(EnvWriteError);
    }
  });

  it('refuses a value that ends in a backslash when it needs quoting', () => {
    expect(() => encodeEnvValue('see # here\\')).toThrow(EnvWriteError);
    expect(() => write({ RAG_PRE_CONTEXT: 'see # here\\' })).toThrow(EnvWriteError);
    expectOnlyThisChanged(write({ RAG_PRE_CONTEXT: 'plain\\' }), 'RAG_PRE_CONTEXT', 'plain\\');
  });

  it('prompt text with hash, apostrophes, backticks and escaped newlines loads back with the same line breaks', () => {
    const value = "# Rules\\nDon't use `code` #1\\nCosts $5";
    const next = write({ RAG_PRE_CONTEXT: value });
    const loaded = loadLikeNext(next).RAG_PRE_CONTEXT;
    expect(loaded.replace(/\n/g, '\\n')).toBe(value);
  });

  it('the same text under a name that does not use escaped newlines is refused rather than altered', () => {
    expect(() => write({ NEXT_PUBLIC_APP_NAME: "# Rules\\nDon't use `code`" })).toThrow(EnvWriteError);
  });

  it('a value that mixes every quote character is refused instead of written wrong', () => {
    expect(() => write({ RAG_PRE_CONTEXT: `# 'a' "b" \`c\` \\n` })).toThrow(EnvWriteError);
  });

  it('replaces an existing multi-line quoted value as a whole', () => {
    const base = 'RAG_PRE_CONTEXT="line one\nline two"\nNEXT_PUBLIC_APP_NAME=Demo\n';
    const next = applyEnvUpdates(base, { RAG_PRE_CONTEXT: 'single' });
    const loaded = loadLikeNext(next);
    expect(loaded.RAG_PRE_CONTEXT).toBe('single');
    expect(loaded.NEXT_PUBLIC_APP_NAME).toBe('Demo');
    expect(next).not.toContain('line two');
  });

  it('keeps a trailing comment readable after an updated value', () => {
    const next = write({ NEXT_PUBLIC_APP_NAME: 'Renamed' });
    const loaded = loadLikeNext(next);
    expect(loaded.NEXT_PUBLIC_APP_NAME).toBe('Renamed');
  });

  it('normalises CRLF files without creating extra variables', () => {
    const next = applyEnvUpdates('NEXT_PUBLIC_APP_NAME=Demo\r\nNEXT_PUBLIC_SITE_TITLE=T\r\n', { NEXT_PUBLIC_APP_NAME: 'B' });
    expect(loadLikeNext(next)).toEqual({ NEXT_PUBLIC_APP_NAME: 'B', NEXT_PUBLIC_SITE_TITLE: 'T' });
  });

  it('survives random printable values through the real loader', () => {
    const alphabet = ['a', 'Z', '0', ' ', '#', '$', '{', '}', '\\', "'", '"', '`', '=', '&', '\t', 'n', 'r', ':', '-', 'é'];
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let written = 0;
    for (let i = 0; i < 400; i += 1) {
      const length = 1 + Math.floor(rand() * 14);
      let value = '';
      for (let j = 0; j < length; j += 1) value += alphabet[Math.floor(rand() * alphabet.length)];
      let next: string;
      try {
        next = write({ RAG_PRE_CONTEXT: value });
      } catch (error) {
        expect(error).toBeInstanceOf(EnvWriteError);
        continue;
      }
      written += 1;
      expectOnlyThisChanged(next, 'RAG_PRE_CONTEXT', value);
    }
    expect(written).toBeGreaterThan(200);
  });

  it('writeEnvUpdates reads and writes the .env.local in the working directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-env-file-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    fs.writeFileSync(path.join(dir, '.env.local'), BASE);

    writeEnvUpdates({ NEXT_PUBLIC_APP_NAME: '${SUPABASE_SERVICE_ROLE_KEY}' });

    const loaded = loadLikeNext(fs.readFileSync(path.join(dir, '.env.local'), 'utf8'));
    expect(loaded.NEXT_PUBLIC_APP_NAME).toBe('${SUPABASE_SERVICE_ROLE_KEY}');
    expect(loaded.SUPABASE_SERVICE_ROLE_KEY).toBe(process.env.SUPABASE_SERVICE_ROLE_KEY);

    expect(() => writeEnvUpdates({ NEXT_PUBLIC_APP_NAME: 'a\rb' })).toThrow(EnvWriteError);
    expect(fs.readFileSync(path.join(dir, '.env.local'), 'utf8')).toContain('NEXT_PUBLIC_APP_NAME=');
  });
});
