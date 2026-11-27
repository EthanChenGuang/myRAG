import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The five model locations (AGENTS.md section 7); `.env.local` is per deployment and not committed, so four files are read. */
const LOCATIONS = ['src/lib/env.ts', 'scripts/init-env.js', 'scripts/config-server.js', 'scripts/config-ui/index.html'] as const;

/** The Config UI help text shows a placeholder model, not a default list entry. */
const NOT_A_MODEL = new Set(['model-id']);

/**
 * Listed models whose context window could not be confirmed from the provider's current model list (05.2.1-02 SUMMARY):
 * they run on the conservative default window with the context_length_unknown flag.
 */
const UNCONFIRMED_WINDOW: Readonly<Record<string, string>> = {
  'openai/gpt-5.2-chat': 'no longer in the OpenRouter model list',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition:free': 'the free variant is no longer in the OpenRouter model list',
  'mixtral-8x7b-32768': 'shut down by Groq; not in the current model list',
  'gemma-7b-it': 'shut down by Groq; not in the current model list',
  'llama3-groq-70b-8192-tool-use-preview': 'shut down by Groq; not in the current model list',
  'deepseek-r1-distill-llama-70b': 'shut down by Groq; not in the current model list',
  // 06.2-07 (D-19): the Auto entry is a routing alias for the fast or quality model, so it has no window of its own.
  auto: 'routing alias (RAG_MODEL_ROUTING); the routed model has the window',
};

interface Entry {
  file: string;
  id: string;
  contextLength: number | null;
}

const MODEL_OBJECT = /\{\s*"?id"?\s*:\s*['"]([^'"]+)['"]\s*,\s*"?displayName"?[^{}]*\}/g;
const CONTEXT_LENGTH = /"?contextLength"?\s*:\s*([^,}\s]+)/;

function entries(): Entry[] {
  const found: Entry[] = [];
  for (const file of LOCATIONS) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(MODEL_OBJECT)) {
      const id = match[1]!;
      if (NOT_A_MODEL.has(id)) continue;
      const raw = match[0].match(CONTEXT_LENGTH)?.[1];
      found.push({ file, id, contextLength: raw === undefined ? null : Number(raw) });
    }
  }
  return found;
}

describe('contextLength on every listed model (05.2.1 D-80)', () => {
  it('reads the default model lists of every location', () => {
    const all = entries();
    for (const file of LOCATIONS) expect(all.some((entry) => entry.file === file), file).toBe(true);
    expect(all.length).toBeGreaterThan(40);
  });

  it('gives every listed model a positive integer contextLength unless its window is a recorded exception', () => {
    for (const entry of entries()) {
      if (entry.id in UNCONFIRMED_WINDOW) {
        expect(entry.contextLength, `${entry.file} ${entry.id} is a recorded exception`).toBeNull();
        continue;
      }
      expect(entry.contextLength, `${entry.file} ${entry.id}`).not.toBeNull();
      expect(Number.isSafeInteger(entry.contextLength) && entry.contextLength! > 0, `${entry.file} ${entry.id}`).toBe(true);
    }
  });

  it('carries one contextLength per model id across the locations', () => {
    const byId = new Map<string, Set<number | null>>();
    for (const entry of entries()) {
      const values = byId.get(entry.id) ?? new Set<number | null>();
      values.add(entry.contextLength);
      byId.set(entry.id, values);
    }
    for (const [id, values] of byId) expect([...values], id).toHaveLength(1);
  });

  it('lists only exceptions that still appear in a model list', () => {
    const ids = new Set(entries().map((entry) => entry.id));
    for (const id of Object.keys(UNCONFIRMED_WINDOW)) expect(ids.has(id), id).toBe(true);
  });
});
