import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE_PATH = path.join(ROOT, 'src/app/api/chat/route.ts');
const ASSEMBLE_PATH = path.join(ROOT, 'src/lib/rag/context/assemble.ts');
const route = readFileSync(ROUTE_PATH, 'utf8');
const assemble = readFileSync(ASSEMBLE_PATH, 'utf8');

const RE_CHECK =
  'Re-check tests/rag-assemble-differential.test.mts, tests/legacy-post-filter.test.ts and the chat snapshots in ' +
  'tests/fixtures/characterization/chat.json (tests/rag/characterize-chat.test.ts) before updating this sentinel.';

const ASSEMBLE_LITERALS: Array<[string, string]> = [
  ['Filter 1 condition', 'if (!applyRelevanceFilter || chunk.similarity > 0.65 || isRelevantByName || (hasImage && chunk.similarity > 0.25)) {'],
  ['query term length filter', '.filter((term) => term.length > 3)'],
  ['query term stripping', ".map((term) => term.replace(/[^a-z0-9]/g, ''))"],
  ['Filter 2 condition', 'if (doc.similarity && (doc.similarity >= 0.6 || (doc.image_url && doc.similarity > 0.25))) return true;'],
  ['Filter 2 name match', 'term.length > 3 && docName.includes(term)'],
  ['refusal decision', 'const refusalCandidate ='],
  ['refusal requires no used documents', 'usedDocuments.length === 0 &&'],
  ['refusal context check', "context.trim().toLowerCase().startsWith('no relevant context found')"],
  ['context wrapper', '=== RELEVANT INFORMATION FROM DOCUMENTS ==='],
  ['image extensions', "const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];"],
];

const ROUTE_LITERALS: Array<[string, string]> = [
  ['refusal decision', 'const shouldBlockNoContextResponse ='],
  ['refusal requires no used documents', 'usedDocuments.length === 0 &&'],
  ['refusal context check', "context.trim().toLowerCase().startsWith('no relevant context found')"],
  ['maxResults expression', "maxResults: parseInt(env.RAG_FINAL_RESULT_COUNT || '25'),"],
  ['isGPTModel', "const isGPTModel = model.includes('gpt-4') || model.includes('o1') || model.includes('chatgpt');"],
];

interface PinnedRegion {
  label: string;
  file: 'route' | 'assemble';
  start: string;
  end: string;
  sha256: string;
}

const PINNED_REGIONS: PinnedRegion[] = [
  {
    label: 'route normalize() helper',
    file: 'route',
    start: 'const normalize = (input: unknown): string => {',
    end: '\n};\n',
    sha256: '9dd38a202878ab110bb9a8265dd1cdc21b5a86754152b551c8eca500b375bb10',
  },
  {
    label: 'assemble query-term helpers (normalizeQueryText, queryTermsOf)',
    file: 'assemble',
    start: 'export function normalizeQueryText(input: unknown): string {',
    end: ".map((term) => term.replace(/[^a-z0-9]/g, ''));\n}",
    sha256: '1b7b86393df4d017c1f37727429ced90f2185ed415465ea9b92b4a98e35205ae',
  },
  {
    label: 'assemble function bodies (filterCandidates, buildContext)',
    file: 'assemble',
    start: 'export function filterCandidates<C extends AssemblyCandidate>(',
    end: 'return { context, usedDocuments, relevantChunks, kept, queryTerms, sourceImages, links, refusalCandidate };\n}',
    sha256: '1f9390ab31d184f4e27ee986494233bd859dc939f4f2047e71d4dc9ad7661c73',
  },
];

function region(text: string, start: string, end: string): string | null {
  const source = text.replace(/\r\n/g, '\n');
  const from = source.indexOf(start);
  if (from === -1 || source.indexOf(start, from + 1) !== -1) return null;
  const to = source.indexOf(end, from);
  return to === -1 ? null : source.slice(from, to + end.length);
}

describe('shared assembly sentinel', () => {
  it.each(ASSEMBLE_LITERALS)('assemble.ts still contains the %s literal', (label, literal) => {
    const message = `src/lib/rag/context/assemble.ts no longer contains the ${label} literal: ${literal}\n${RE_CHECK}`;
    expect(assemble.includes(literal), message).toBe(true);
  });

  it.each(ROUTE_LITERALS)('the chat route still contains the %s literal', (label, literal) => {
    const message = `src/app/api/chat/route.ts no longer contains the ${label} literal: ${literal}\n${RE_CHECK}`;
    expect(route.includes(literal), message).toBe(true);
  });

  it('keeps the term-filter literals in both the chunk filter and the document filter', () => {
    const occurrences = (needle: string) => assemble.split(needle).length - 1;
    expect(occurrences('term.length > 3')).toBeGreaterThanOrEqual(2);
    expect(occurrences(".map((term) => term.replace(/[^a-z0-9]/g, ''))")).toBeGreaterThanOrEqual(1);
  });

  it.each(PINNED_REGIONS)('the $label is byte-identical to the pinned version', ({ label, file, start, end, sha256 }) => {
    const target = file === 'route' ? 'src/app/api/chat/route.ts' : 'src/lib/rag/context/assemble.ts';
    const text = region(file === 'route' ? route : assemble, start, end);
    expect(text, `could not find a unique ${label} in ${target}`).not.toBeNull();
    const digest = createHash('sha256').update(text as string, 'utf8').digest('hex');
    const message = `${target} changed inside the ${label}. ${RE_CHECK} Then update the pinned sha256 in this test.`;
    expect(digest, message).toBe(sha256);
  });
});
