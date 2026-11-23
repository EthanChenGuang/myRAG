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
});
