import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROUTE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/api/chat/route.ts');
const route = readFileSync(ROUTE_PATH, 'utf8');

const REPLICATED_LITERALS: Array<[string, string]> = [
  ['Filter 1 condition', 'if (chunk.similarity > 0.65 || isRelevantByName || (hasImage && chunk.similarity > 0.25)) {'],
  ['query term length filter', '.filter(term => term.length > 3)'],
  ['query term stripping', ".map(term => term.replace(/[^a-z0-9]/g, ''))"],
  ['Filter 2 condition', 'if (doc.similarity && (doc.similarity >= 0.6 || (doc.image_url && doc.similarity > 0.25))) {'],
  ['Filter 2 name match', 'term.length > 3 && docName.includes(term)'],
  ['refusal decision', 'const shouldBlockNoContextResponse ='],
  ['refusal requires no used documents', 'usedDocuments.length === 0 &&'],
  ['refusal context check', "context.trim().toLowerCase().startsWith('no relevant context found')"],
  ['maxResults expression', "maxResults: parseInt(env.RAG_FINAL_RESULT_COUNT || '25'),"],
  ['context wrapper', '=== RELEVANT INFORMATION FROM DOCUMENTS ==='],
  ['image extensions', "const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];"],
  ['isGPTModel', "const isGPTModel = model.includes('gpt-4') || model.includes('o1') || model.includes('chatgpt');"],
];

const PINNED_REGIONS: Array<{ label: string; start: string; end: string; sha256: string }> = [
  {
    label: 'normalize() helper',
    start: 'const normalize = (input: unknown): string => {',
    end: '\n};\n',
    sha256: '9dd38a202878ab110bb9a8265dd1cdc21b5a86754152b551c8eca500b375bb10',
  },
  {
    label: 'post-filter block (query terms, Filter 1, context assembly, Filter 2, refusal decision)',
    start: '// CHANGE 2: Add keyword-based document filtering',
    end: "context.trim().toLowerCase().startsWith('no relevant context found');",
    sha256: 'cb6dc74d02f60336790d6c59015ceac32722526c47356070ddf461ba7d71652b',
  },
];

function region(start: string, end: string): string | null {
  const text = route.replace(/\r\n/g, '\n');
  const from = text.indexOf(start);
  if (from === -1 || text.indexOf(start, from + 1) !== -1) return null;
  const to = text.indexOf(end, from);
  return to === -1 ? null : text.slice(from, to + end.length);
}

describe('legacy post-filter replica sentinel', () => {
  it.each(REPLICATED_LITERALS)('chat route still contains the %s literal', (label, literal) => {
    const message =
      `src/app/api/chat/route.ts no longer contains the ${label} literal the eval replica copies: ${literal}\n` +
      'The replica in src/lib/rag-eval/legacy-post-filter.ts (and its tests in tests/legacy-post-filter.test.ts) must be updated in the same change.';
    expect(route.includes(literal), message).toBe(true);
  });

  it('keeps the term-filter literals in both the chunk filter and the document filter', () => {
    const occurrences = (needle: string) => route.split(needle).length - 1;
    expect(occurrences('.filter(term => term.length > 3)')).toBeGreaterThanOrEqual(2);
    expect(occurrences(".map(term => term.replace(/[^a-z0-9]/g, ''))")).toBeGreaterThanOrEqual(2);
  });

  it.each(PINNED_REGIONS)('the $label is byte-identical to the replicated version', ({ label, start, end, sha256 }) => {
    const text = region(start, end);
    expect(text, `could not find a unique ${label} in src/app/api/chat/route.ts`).not.toBeNull();
    const digest = createHash('sha256').update(text as string, 'utf8').digest('hex');
    const message =
      `src/app/api/chat/route.ts changed inside the ${label}. Re-check src/lib/rag-eval/legacy-post-filter.ts ` +
      'and tests/legacy-post-filter.test.ts against it, then update the pinned sha256 in this test.';
    expect(digest, message).toBe(sha256);
  });
});
