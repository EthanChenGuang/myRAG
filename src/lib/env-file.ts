import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import { isWritableEnvName } from '@/lib/config-env-allowlist';

/**
 * Names the admin routes write as structured (JSON or free-text) values. They are not writable through
 * POST /api/config, but they must still go through this writer so no route builds env lines by hand.
 */
export const STRUCTURED_ENV_NAMES: ReadonlySet<string> = new Set([
  'RAG_PRE_CONTEXT',
  'RAG_POST_CONTEXT',
  'NEXT_PUBLIC_OPENAI_MODELS',
  'NEXT_PUBLIC_OPENROUTER_MODELS',
  'NEXT_PUBLIC_GROQ_MODELS',
  'MCP_CUSTOM_SERVERS',
]);

/**
 * Prompt text is stored with a literal backslash-n for each line break, and every reader turns that back into a newline.
 * A double-quoted value makes the loader do that conversion itself, which is equivalent for these names only.
 */
const NEWLINE_ESCAPE_NAMES: ReadonlySet<string> = new Set(['RAG_PRE_CONTEXT', 'RAG_POST_CONTEXT']);

export const MAX_ENV_VALUE_LENGTH = 200_000;

export type EnvWriteFailure = 'name' | 'value' | 'roundtrip' | 'io';

export class EnvWriteError extends Error {
  constructor(
    message: string,
    readonly reason: EnvWriteFailure,
    readonly names: string[] = [],
  ) {
    super(message);
    this.name = 'EnvWriteError';
  }
}

const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000a-\\u001f\\u007f\\u0085\\u2028\\u2029]');
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const LINE_SOURCE =
  '(?:^|^)\\s*(?:export\\s+)?([\\w.-]+)(?:\\s*=\\s*?|:\\s+?)(\\s*\'(?:\\\\\'|[^\'])*\'|\\s*"(?:\\\\"|[^"])*"|\\s*`(?:\\\\`|[^`])*`|[^#\\r\\n]+)?\\s*(?:#.*)?(?:$|$)';

export function isEnvWritableName(name: string): boolean {
  return ENV_NAME.test(name) && (STRUCTURED_ENV_NAMES.has(name) || isWritableEnvName(name));
}

/** Why a value can never be written to .env.local, or null when it can. */
export function invalidEnvValueReason(value: string): string | null {
  if (value.length > MAX_ENV_VALUE_LENGTH) return 'value is too long';
  if (CONTROL_CHARS.test(value)) return 'value contains a line break or control character';
  return null;
}

/** Escapes `$` so the loader's variable expansion cannot read it, and quotes only when the loader would otherwise alter the value. */
export function encodeEnvValue(value: string, options: { escapedNewlines?: boolean } = {}): string {
  const reason = invalidEnvValueReason(value);
  if (reason) throw new EnvWriteError(reason, 'value');

  const escaped = value.replace(/\$/g, () => '\\$');
  const needsQuote = escaped.includes('#') || /^\s|\s$/.test(escaped) || /^['"`]/.test(escaped);
  if (!needsQuote) return escaped;

  if (escaped.endsWith('\\')) {
    throw new EnvWriteError('value cannot end with a backslash', 'value');
  }
  for (const quote of ["'", '`']) {
    if (!escaped.includes(quote)) return `${quote}${escaped}${quote}`;
  }
  const newlineSafe = options.escapedNewlines ? !/\\r/.test(escaped) : !/\\[nr]/.test(escaped);
  if (!escaped.includes('"') && newlineSafe) return `"${escaped}"`;
  throw new EnvWriteError('value mixes quote characters that .env.local cannot hold', 'value');
}

/**
 * Serialises structured data so the text needs no quoting and nothing the env loader treats specially:
 * `$`, `#`, quotes, backticks and unicode line separators become JSON unicode escapes, which parse back to the same data.
 */
export function stringifyJsonForEnv(data: unknown): string {
  return JSON.stringify(data).replace(/[$#'`\u0085\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Parses env text the way @next/env loads it for a literal value: dotenv parsing plus the `\$` escape. */
export function parseEnvContent(content: string): Record<string, string> {
  const parsed = dotenv.parse(content);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    out[name] = value.replace(/\\\$/g, () => '$');
  }
  return out;
}

export function envFilePath(): string {
  return path.join(process.cwd(), '.env.local');
}

export function readEnvFile(): Record<string, string> {
  const envPath = envFilePath();
  if (!fs.existsSync(envPath)) return {};
  return parseEnvContent(fs.readFileSync(envPath, 'utf8'));
}

interface Span {
  name: string;
  start: number;
  end: number;
}

function findAssignments(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = new RegExp(LINE_SOURCE, 'gdm');
  for (const match of text.matchAll(pattern)) {
    const indices = (match as RegExpMatchArray & { indices: Array<[number, number] | undefined> }).indices;
    const key = indices[1];
    if (!key) continue;
    let end: number;
    const value = indices[2];
    if (value) {
      end = value[1];
    } else {
      const separator = /^(?:\s*=\s*?|:\s+?)/.exec(text.slice(key[1]));
      end = key[1] + (separator ? separator[0].length : 0);
    }
    spans.push({ name: match[1], start: key[0], end });
  }
  return spans;
}

/** Returns env text with the given variables set. Throws EnvWriteError unless every value loads back as the exact literal. */
export function applyEnvUpdates(content: string, updates: Record<string, string>): string {
  const names = Object.keys(updates);
  const badNames = names.filter((name) => !isEnvWritableName(name));
  if (badNames.length > 0) {
    throw new EnvWriteError('variable name is not writable', 'name', badNames);
  }
  const badValues = names.filter((name) => invalidEnvValueReason(updates[name]) !== null);
  if (badValues.length > 0) {
    throw new EnvWriteError(invalidEnvValueReason(updates[badValues[0]]) ?? 'value is not allowed', 'value', badValues);
  }

  const normalized = content.replace(/\r\n?/g, '\n');
  let text = normalized;

  for (const name of names) {
    const line = `${name}=${encodeEnvValue(updates[name], { escapedNewlines: NEWLINE_ESCAPE_NAMES.has(name) })}`;
    const spans = findAssignments(text).filter((span) => span.name === name);
    if (spans.length === 0) {
      if (text.length > 0 && !text.endsWith('\n')) text += '\n';
      text += `${line}\n`;
      continue;
    }
    for (const span of [...spans].reverse()) {
      const rest = text.slice(span.end);
      text = text.slice(0, span.start) + line + (rest.startsWith('#') ? ' ' : '') + rest;
    }
  }

  const before = parseEnvContent(normalized);
  const after = parseEnvContent(text);
  const expected = { ...before, ...updates };
  const expectedNames = Object.keys(expected);
  const loadedAs = (name: string) =>
    NEWLINE_ESCAPE_NAMES.has(name) && name in updates ? after[name]?.replace(/\n/g, () => '\\n') : after[name];
  const failed = expectedNames.filter((name) => loadedAs(name) !== expected[name]);
  const extra = Object.keys(after).filter((name) => !(name in expected));
  if (failed.length > 0 || extra.length > 0) {
    throw new EnvWriteError('refusing a write that would not load back unchanged', 'roundtrip', [...failed, ...extra]);
  }

  return text;
}

/** The only code path that writes .env.local on behalf of the web routes. */
export function writeEnvUpdates(updates: Record<string, string>): void {
  const envPath = envFilePath();
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const next = applyEnvUpdates(current, updates);
  try {
    fs.writeFileSync(envPath, next, { mode: 0o600 });
  } catch {
    throw new EnvWriteError('could not write the env file', 'io');
  }
}
