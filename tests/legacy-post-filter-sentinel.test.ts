import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE_PATH = path.join(ROOT, 'src/app/api/chat/route.ts');
const ASSEMBLE_PATH = path.join(ROOT, 'src/lib/rag/context/assemble.ts');
const RELEVANCE_PATH = path.join(ROOT, 'src/lib/rag/context/relevance.ts');
const route = readFileSync(ROUTE_PATH, 'utf8');
const assemble = readFileSync(ASSEMBLE_PATH, 'utf8');
const relevance = readFileSync(RELEVANCE_PATH, 'utf8');

const RE_CHECK =
  'Re-check tests/rag-assemble-differential.test.mts, tests/legacy-post-filter.test.ts and the chat snapshots in ' +
  'tests/fixtures/characterization/chat.json (tests/rag/characterize-chat.test.ts) before updating this sentinel.';

const ASSEMBLE_LITERALS: Array<[string, string]> = [
  ['Filter 1 condition', 'if (!applyRelevanceFilter || reason !== null) {'],
  ['Filter 1 kept-by label', "const keptBy: KeptBy = reason ?? (hasImage ? 'image' : 'similarity');"],
  ['Filter 2 condition', 'if (doc.similarity && (doc.similarity >= 0.6 || (doc.image_url && doc.similarity > 0.25))) return true;'],
  ['Filter 2 name match', 'term.length > 3 && docName.includes(term)'],
  ['refusal decision', 'const refusalCandidate ='],
  ['refusal requires no used documents', 'usedDocuments.length === 0 &&'],
  ['refusal context check', "context.trim().toLowerCase().startsWith('no relevant context found')"],
  ['context wrapper', '=== RELEVANT INFORMATION FROM DOCUMENTS ==='],
  ['image extensions', "const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];"],
];

const RELEVANCE_LITERALS: Array<[string, string]> = [
  ['legacy keep floors', 'const LEGACY_KEEP_FLOORS: LegacyKeepFloors = { text: 0.65, image: 0.25 };'],
  ['query term length filter', '.filter((term) => term.length > 3)'],
  ['query term stripping', ".map((term) => term.replace(/[^a-z0-9]/g, ''))"],
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
  file: 'route' | 'assemble' | 'relevance';
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
    label: 'legacy relevance helpers (normalizeQueryText, legacyQueryTerms, legacyKeepReason)',
    file: 'relevance',
    start: 'export function normalizeQueryText(input: unknown): string {',
    end: "  if (candidate.hasImage && scored && similarity > floors.image) return 'image';\n  return null;\n}",
    sha256: 'b3e9af6e3946220caf751f6ff7a778e0607db1b4abba854dcdc0dedc56d19c18',
  },
  {
    label: 'assemble function bodies (filterCandidates, buildContext)',
    file: 'assemble',
    start: 'export function filterCandidates<C extends AssemblyCandidate>(',
    end: '    ...(sentinel.count > 0 ? { neutralizedSentinels: sentinel.count } : {}),\n  };\n}',
    sha256: 'af5fb35196a086ac747f363e7cdda9b4e2828e4c3d545beed8e08b2da1e0f6b0',
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

  it.each(RELEVANCE_LITERALS)('relevance.ts still contains the %s literal', (label, literal) => {
    const message = `src/lib/rag/context/relevance.ts no longer contains the ${label} literal: ${literal}\n${RE_CHECK}`;
    expect(relevance.includes(literal), message).toBe(true);
  });

  it.each(ROUTE_LITERALS)('the chat route still contains the %s literal', (label, literal) => {
    const message = `src/app/api/chat/route.ts no longer contains the ${label} literal: ${literal}\n${RE_CHECK}`;
    expect(route.includes(literal), message).toBe(true);
  });

  it('keeps the term-filter literals in both the chunk filter and the document filter', () => {
    const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
    expect(occurrences(assemble, 'term.length > 3')).toBeGreaterThanOrEqual(1);
    expect(occurrences(relevance, 'term.length > 3')).toBeGreaterThanOrEqual(1);
    expect(occurrences(relevance, ".map((term) => term.replace(/[^a-z0-9]/g, ''))")).toBeGreaterThanOrEqual(1);
  });

  it.each(PINNED_REGIONS)('the $label is byte-identical to the pinned version', ({ label, file, start, end, sha256 }) => {
    const target = { route: 'src/app/api/chat/route.ts', assemble: 'src/lib/rag/context/assemble.ts', relevance: 'src/lib/rag/context/relevance.ts' }[file];
    const text = region({ route, assemble, relevance }[file], start, end);
    expect(text, `could not find a unique ${label} in ${target}`).not.toBeNull();
    const digest = createHash('sha256').update(text as string, 'utf8').digest('hex');
    const message = `${target} changed inside the ${label}. ${RE_CHECK} Then update the pinned sha256 in this test.`;
    expect(digest, message).toBe(sha256);
  });
});
