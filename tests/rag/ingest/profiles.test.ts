import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessingProfileSetSchema } from '@/lib/rag-eval/contracts.generated';
import {
  getClausePatterns,
  getProcessingProfile,
  loadProcessingProfiles,
  parseProcessingProfileSet,
  resetProcessingProfilesForTests,
  type DocType,
} from '@/lib/rag/ingest/profiles/load';
import rawProfiles from '../../../config/rag/processing-profiles.json';

const SIX_TYPES: DocType[] = [
  'general',
  'financial_report',
  'contract_legal',
  'invoice_receipt',
  'product_technical',
  'scanned_image',
];

const D25_CLAUSE_PATTERNS = [
  '第[一二三四五六七八九十百零〇\\d]+条',
  '^\\d+(\\.\\d+)*[.)]?\\s',
  '^[（(][一二三四五六七八九十]+[)）]',
  '^Art\\.?\\s*\\d+',
  '^Articolo\\s+\\d+',
  '^Article\\s+\\d+',
];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

beforeEach(() => {
  vi.restoreAllMocks();
  resetProcessingProfilesForTests();
});

describe('processing profile loader', () => {
  it('loads exactly one profile per document type, id <doc_type>@1', () => {
    const set = loadProcessingProfiles();
    expect(set.profiles).toHaveLength(6);
    expect(set.profiles.map((profile) => profile.doc_type).sort()).toEqual([...SIX_TYPES].sort());
    for (const profile of set.profiles) expect(profile.id).toBe(`${profile.doc_type}@1`);
  });

  it('returns the contract profile with its six clause patterns and zh/en/it lead-in phrases', () => {
    const profile = getProcessingProfile('contract_legal');
    expect(profile.doc_type).toBe('contract_legal');
    expect(profile.chunker.kind).toBe('legal_clauses');
    expect(profile.chunker.max_tokens).toBe(768);
    expect(profile.chunker.clause_patterns).toEqual(D25_CLAUSE_PATTERNS);
    const leadIns = (profile.chunker.lead_in_phrases ?? []).join(' ').toLowerCase();
    for (const phrase of ['但以下情况除外', 'except as follows', 'salvo quanto segue']) expect(leadIns).toContain(phrase);
  });

  it('throws for an unknown document type', () => {
    expect(() => getProcessingProfile('memo' as DocType)).toThrow(/unknown doc type/i);
  });

  it('validates and parses the bundled JSON once per process', () => {
    const parse = vi.spyOn(ProcessingProfileSetSchema, 'parse');
    const first = loadProcessingProfiles();
    getProcessingProfile('general');
    getProcessingProfile('invoice_receipt');
    expect(loadProcessingProfiles()).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('carries the D-14 starting values for every type', () => {
    const expected: Record<DocType, [string[], string, number, boolean, string[]]> = {
      general: [['configured'], 'markdown_sections', 512, false, ['dates', 'urls']],
      financial_report: [['configured'], 'table_aware', 512, true, ['dates', 'financial']],
      contract_legal: [['configured'], 'legal_clauses', 768, false, ['dates']],
      invoice_receipt: [['docling', 'configured'], 'invoice', 1024, true, ['invoice']],
      product_technical: [['configured'], 'markdown_sections', 512, false, ['urls']],
      scanned_image: [['docling'], 'markdown_sections', 512, false, ['dates']],
    };
    for (const docType of SIX_TYPES) {
      const [preference, kind, maxTokens, repeatHeader, extractors] = expected[docType];
      const profile = getProcessingProfile(docType);
      expect(profile.parser.preference, docType).toEqual(preference);
      expect(profile.chunker.kind, docType).toBe(kind);
      expect(profile.chunker.max_tokens, docType).toBe(maxTokens);
      expect(profile.chunker.repeat_table_header, docType).toBe(repeatHeader);
      expect(profile.extractors, docType).toEqual(extractors);
      expect(profile.parser.ocr_languages, docType).toEqual(['zh', 'en', 'it']);
      expect(profile.scan_injection, docType).toBe(true);
    }
    expect(getProcessingProfile('financial_report').parser.docling.table_mode).toBe('accurate');
    expect(getProcessingProfile('scanned_image').parser.docling.force_full_page_ocr).toBe(true);
    expect(getProcessingProfile('invoice_receipt').parser.docling.ocr).toBe(true);
  });

  it('keeps the invoice header template and leaves it empty for the other types', () => {
    expect(getProcessingProfile('invoice_receipt').embedding_text_template).toEqual({
      version: 1,
      header: 'Invoice {invoice_number} | {supplier_name} | {supplier_tax_id}',
    });
    for (const docType of SIX_TYPES.filter((type) => type !== 'invoice_receipt')) {
      expect(getProcessingProfile(docType).embedding_text_template.header, docType).toBeNull();
    }
  });

  it('keeps the reserved tier and parent_child fields explicit and empty', () => {
    for (const profile of loadProcessingProfiles().profiles) {
      expect([profile.min_tier, profile.max_tier, profile.parent_child], profile.id).toEqual([null, null, null]);
    }
  });

  it('compiles every clause pattern once with the u flag and matches the D-25 heading shapes', () => {
    const patterns = getClausePatterns('contract_legal');
    expect(patterns).toHaveLength(6);
    expect(getClausePatterns('contract_legal')).toBe(patterns);
    for (const pattern of patterns) {
      expect(pattern.flags).toContain('u');
      expect(pattern.flags).not.toMatch(/[gy]/);
    }
    const headings = ['第五条 适用范围', '1.2 Scope', '（一）适用', 'Art. 5 Scope', 'Articolo 3 Oggetto', 'Article 9 Term'];
    headings.forEach((heading, index) => expect(patterns[index].test(heading), heading).toBe(true));
    for (const pattern of patterns) expect(pattern.test('This agreement is entered into by the parties.')).toBe(false);
    expect(getClausePatterns('general')).toEqual([]);
  });
});

describe('parseProcessingProfileSet mirrors the Pydantic rules the Zod schema cannot express', () => {
  it('accepts the bundled data', () => {
    expect(parseProcessingProfileSet(clone(rawProfiles)).profiles).toHaveLength(6);
  });

  it.each([
    ['a missing type', (set: any) => set.profiles.pop()],
    ['a repeated type', (set: any) => set.profiles.push(clone(set.profiles[0]))],
    ['a repeat hiding a missing type', (set: any) => (set.profiles[5] = clone(set.profiles[0]))],
    ['an id that is not doc_type@version', (set: any) => (set.profiles[0].id = 'contract_legal@1')],
    ['overlap not below max_tokens', (set: any) => (set.profiles[0].chunker.overlap_tokens = set.profiles[0].chunker.max_tokens)],
    ['min_chunk_tokens above max_tokens', (set: any) => (set.profiles[0].chunker.min_chunk_tokens = 9999)],
    ['inverted tiers', (set: any) => Object.assign(set.profiles[0], { min_tier: 'premium', max_tier: 'fast' })],
    ['an invalid clause pattern', (set: any) => (set.profiles[2].chunker.clause_patterns = ['(unclosed'])],
    ['an unknown key', (set: any) => (set.profiles[0].rogue = true)],
    ['a repeated extractor', (set: any) => (set.profiles[0].extractors = ['dates', 'dates'])],
  ])('rejects %s', (_name, mutate) => {
    const set = clone(rawProfiles);
    mutate(set);
    expect(() => parseProcessingProfileSet(set)).toThrow();
  });
});
