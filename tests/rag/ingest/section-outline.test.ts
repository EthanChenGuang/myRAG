import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkDocument, type DoclingChunk } from '@/lib/rag/ingest/chunkers';
import {
  compileSectionOutlines,
  loadSectionOutlines,
  normalizeWithOutline,
  outlineMarkdown,
  resetSectionOutlinesForTests,
  sectionOutlineInputFor,
  sectionOutlineStamp,
  type SectionOutlineInput,
} from '@/lib/rag/ingest/outline';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import {
  ALPHA,
  ALPHA_LABEL,
  BETA,
  BETA_LABEL,
  CONTENTS,
  DOCUMENT,
  OUTLINE,
  SECTION_PATHS,
  TITLE,
  outlineFile,
  writeOutlineFile,
} from './section-outline-fixture';

const config = (docType: Parameters<typeof getProcessingProfile>[0]) => getProcessingProfile(docType).chunker;

const DOCLING_CHUNKS: DoclingChunk[] = [
  { contextualized_text: 'Sheet\nplain text', headings: ['Sheet'], is_table: false, pages: [1], table_header: null, text: 'plain text' },
];

const input = (outlines: unknown[] = [OUTLINE], tenantKey: string | null = 's:default'): SectionOutlineInput => ({
  outlines: compileSectionOutlines(outlineFile(outlines)),
  tenantKey,
});

const headings = (markdown: string): string[] => markdown.split('\n').filter((line) => /^#{1,6} /.test(line));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetSectionOutlinesForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('section outlines off', () => {
  const unmatched = input([{ ...OUTLINE, detect: { pattern: 'Gadget Ledger', within_chars: 200 } }]);

  for (const docType of ['general', 'financial_report', 'contract_legal'] as const) {
    for (const [name, source] of [
      ['markdown only', { markdown: DOCUMENT }],
      ['with Docling chunks', { markdown: DOCUMENT, chunks: DOCLING_CHUNKS }],
    ] as const) {
      it(`gives today's chunks for ${docType}, ${name}`, () => {
        const plain = chunkDocument(config(docType), source);
        const variants = [
          chunkDocument(config(docType), source, {}),
          chunkDocument(config(docType), source, { sectionOutline: null }),
          chunkDocument(config(docType), source, { sectionOutline: { outlines: null, tenantKey: 's:default' } }),
          chunkDocument(config(docType), source, { sectionOutline: unmatched }),
        ];
        for (const result of variants) {
          expect(result).toEqual(plain);
          expect('sectionOutline' in result).toBe(false);
          expect(result.chunks.every((chunk) => !('section_outline' in chunk.metadata))).toBe(true);
        }
      });
    }
  }

  it('reads nothing for an empty or absent path', () => {
    expect(loadSectionOutlines('')).toBeNull();
    expect(loadSectionOutlines('   ')).toBeNull();
    expect(loadSectionOutlines(undefined)).toBeNull();
    expect(loadSectionOutlines(null)).toBeNull();
    expect(sectionOutlineInputFor('', 's:default')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves other chunker kinds alone', () => {
    expect(outlineMarkdown(DOCUMENT, 'rule_sections', input())).toEqual({ markdown: DOCUMENT, report: null });
    expect(outlineMarkdown(DOCUMENT, 'invoice', input())).toEqual({ markdown: DOCUMENT, report: null });
  });
});

describe('invalid outline files', () => {
  const cases: Array<[string, () => string]> = [
    ['a missing path', () => `${writeOutlineFile(outlineFile())}.missing`],
    ['text that is not JSON', () => writeOutlineFile('{ not json')],
    ['an unknown key', () => writeOutlineFile(outlineFile([{ ...OUTLINE, extra: true }]))],
    ['level 4', () => writeOutlineFile(outlineFile([{ ...OUTLINE, sections: [...OUTLINE.sections, { key: '4', level: 4, pattern: '4 More' }] }]))],
    ['a variant_start that names no section', () => writeOutlineFile(outlineFile([{ ...OUTLINE, variant_start: '9' }]))],
    ['duplicate outline ids', () => writeOutlineFile(outlineFile([OUTLINE, OUTLINE]))],
    ['a pattern that does not compile', () => writeOutlineFile(outlineFile([{ ...OUTLINE, sections: [{ key: '1', level: 1, pattern: '1 (Name' }] }]))],
    ['a pattern that matches the empty string', () => writeOutlineFile(outlineFile([{ ...OUTLINE, detect: { pattern: 'Widget?|', within_chars: 10 } }]))],
  ];

  for (const [name, make] of cases) {
    it(`is off with one warning for ${name}`, () => {
      const filePath = make();
      expect(loadSectionOutlines(filePath)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[RAG Outline\]/);
      expect(JSON.stringify(warn.mock.calls[0]?.[1])).not.toContain('Name');
      expect(loadSectionOutlines(filePath)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const plain = chunkDocument(config('general'), { markdown: DOCUMENT });
      expect(chunkDocument(config('general'), { markdown: DOCUMENT }, { sectionOutline: sectionOutlineInputFor(filePath, 's:default') })).toEqual(plain);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  }

  it('loads a valid file once and caches it', () => {
    const filePath = writeOutlineFile(outlineFile());
    const first = loadSectionOutlines(filePath);
    expect(first).not.toBeNull();
    expect(loadSectionOutlines(filePath)).toBe(first);
    expect(first?.[0]?.sections.map((section) => section.pattern.flags)).toEqual(['giu', 'giu', 'giu', 'giu']);
    expect(first?.[0]?.detect.flags).toBe('iu');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('tenant_keys', () => {
  const tenantOutline = { ...OUTLINE, id: 'tenant-sheet', tenant_keys: ['S:Tenant-One'] };

  it('applies an outline only to the tenant keys it lists, in any letter case', () => {
    expect(normalizeWithOutline(DOCUMENT, input([tenantOutline, OUTLINE], 's:tenant-one')).report?.outline_id).toBe('tenant-sheet');
    expect(normalizeWithOutline(DOCUMENT, input([tenantOutline, OUTLINE], 'S:TENANT-ONE')).report?.outline_id).toBe('tenant-sheet');
    expect(normalizeWithOutline(DOCUMENT, input([tenantOutline, OUTLINE], 's:other')).report?.outline_id).toBe('neutral-sheet');
    expect(normalizeWithOutline(DOCUMENT, input([tenantOutline, OUTLINE], null)).report?.outline_id).toBe('neutral-sheet');
    expect(normalizeWithOutline(DOCUMENT, input([tenantOutline], 's:other'))).toEqual({ markdown: DOCUMENT, report: null });
    expect(normalizeWithOutline(DOCUMENT, input([tenantOutline], null))).toEqual({ markdown: DOCUMENT, report: null });
  });
});

describe('normalizeWithOutline', () => {
  it('keeps the contents line as it was and makes none of its markers a heading', () => {
    const { markdown } = normalizeWithOutline(DOCUMENT, input());
    expect(markdown.split('\n')).toContain(CONTENTS);
    expect(markdown.startsWith(`${TITLE}\n${CONTENTS}\n\n`)).toBe(true);
  });

  it('keeps a cross-reference inline and makes the real section a heading', () => {
    const { markdown } = normalizeWithOutline(DOCUMENT, input());
    expect(markdown).toContain('see section 3 Notes for more of it.');
    expect(headings(markdown).filter((line) => line === '## 3 Notes')).toHaveLength(2);
  });

  it('matches a cross-reference prefix only as a whole word', () => {
    const outline = { ...OUTLINE, cross_ref_prefixes: ['see', 'e'] };
    const { markdown } = normalizeWithOutline(DOCUMENT.replace('Alpha Widget, blue.', 'Alpha Widget, blue and oversee 2 Scope'), input([outline]));
    expect(markdown).toContain('oversee 2 Scope');
    const body = ALPHA.replace(' 2 Scope', ' the sample line 2 Scope').replace(' 3 Notes The', ' a single blue tone 3 Notes The');
    const kept = normalizeWithOutline(`${TITLE}\n${body}\n`, input([{ ...OUTLINE, cross_ref_prefixes: ['e'] }]));
    expect(headings(kept.markdown)).toEqual(['## 1 Name', '## 2 Scope', '### 2.1 Details', '## 3 Notes']);
  });

  it('does not take the short tail of one variant and the head of the next for a contents list', () => {
    const five = {
      ...OUTLINE,
      sections: ['Name', 'Scope', 'Details', 'Notes', 'Owner'].map((title, index) => ({ key: String(index + 1), level: 1, pattern: `${index + 1}\\s+${title}` })),
      toc: { max_span_chars: 90 },
    };
    const pad = 'plain sample words that fill this part of the synthetic sheet';
    const variant = (name: string) => `1 Name ${name}. 2 Scope ${pad} and ${pad}. 3 Details ${pad} and ${pad}. 4 Notes Plain. 5 Owner Lab.`;
    const { report } = normalizeWithOutline(`${TITLE}\n${variant('Alpha')} ${variant('Beta')}\n`, input([five]));
    expect(report?.variants).toHaveLength(2);
    expect(report?.markers_kept).toBe(10);
  });

  it('splits two variants under level-1 headings labelled from the body', () => {
    for (const outline of [OUTLINE, { ...OUTLINE, variant_label: 'body' }]) {
      const { markdown, report } = normalizeWithOutline(DOCUMENT, input([outline]));
      expect(headings(markdown)).toEqual([
        `# ${ALPHA_LABEL}`,
        '## 1 Name',
        '## 2 Scope',
        '### 2.1 Details',
        '## 3 Notes',
        `# ${BETA_LABEL}`,
        '## 1 Name',
        '## 2 Scope',
        '### 2.1 Details',
        '## 3 Notes',
      ]);
      expect(report?.variants).toEqual([ALPHA_LABEL, BETA_LABEL]);
    }
  });

  it('labels variants from the title with variant_label title', () => {
    const { markdown, report } = normalizeWithOutline(DOCUMENT, input([{ ...OUTLINE, variant_label: 'title' }]));
    expect(report?.variants).toEqual([`1 Name ${ALPHA_LABEL}`, `1 Name ${BETA_LABEL}`]);
    expect(headings(markdown).filter((line) => line.startsWith('# '))).toEqual([`# 1 Name ${ALPHA_LABEL}`, `# 1 Name ${BETA_LABEL}`]);
  });

  it('gives a one-variant document no level-1 heading', () => {
    const { markdown, report } = normalizeWithOutline([TITLE, ALPHA].join('\n'), input());
    expect(headings(markdown)).toEqual(['## 1 Name', '## 2 Scope', '### 2.1 Details', '## 3 Notes']);
    expect(report?.variants).toEqual([ALPHA_LABEL]);
  });

  it('cuts a long label to 120 characters', () => {
    const long = `1 Name ${'plain long label words '.repeat(10)}\nThe body of this widget is plain sample text.`;
    const { report } = normalizeWithOutline([TITLE, long].join('\n'), input());
    expect(report?.variants[0]).toHaveLength(120);
    expect(report?.variants[0]?.startsWith('plain long label words')).toBe(true);
  });

  it('labels a variant without a variant_start marker by its number', () => {
    const doc = [TITLE, '2 Scope The scope of this sample is a plain line of text.', '3 Notes The notes of this sample are a plain line too.'].join('\n');
    const { markdown, report } = normalizeWithOutline(doc, input([{ ...OUTLINE, toc: undefined }]));
    expect(report?.variants).toEqual(['Variant 1']);
    expect(headings(markdown)).toEqual(['## 2 Scope', '## 3 Notes']);
  });

  it('keeps a later mention of an earlier section inline', () => {
    const doc = [TITLE, `${ALPHA} The notes then name 2 Scope again as plain words.`].join('\n');
    const { markdown, report } = normalizeWithOutline(doc, input());
    expect(headings(markdown)).toEqual(['## 1 Name', '## 2 Scope', '### 2.1 Details', '## 3 Notes']);
    expect(markdown).toContain('name 2 Scope again as plain words.');
    expect(report?.markers_dropped).toBe(2);
  });

  it('leaves marker text inside fenced code and table rows as it was', () => {
    const doc = [TITLE, ALPHA, '', '```', '2 Scope inside code', '```', '', '| 3 Notes | cell |', '| --- | --- |', '| 2 Scope | row |', ''].join('\n');
    const { markdown, report } = normalizeWithOutline(doc, input());
    expect(markdown).toContain('```\n2 Scope inside code\n```');
    expect(markdown).toContain('| 3 Notes | cell |\n| --- | --- |\n| 2 Scope | row |');
    expect(headings(markdown)).toEqual(['## 1 Name', '## 2 Scope', '### 2.1 Details', '## 3 Notes']);
    expect(report?.markers_found).toBe(5);
  });

  it('replaces a heading line that holds a marker and re-levels headings after the first marker only', () => {
    const doc = [
      TITLE,
      '## Intro',
      'The intro is a plain line of sample text before the sheet starts.',
      '1 Name Alpha Widget, blue. The alpha widget is a sample part.',
      '2 Scope The scope is a plain line.',
      '## 2.1 Details',
      'The details are a plain line.',
      '## Extra',
      'The extra part is a plain line.',
      '3 Notes The notes are a plain line.',
    ].join('\n');
    const { markdown } = normalizeWithOutline(doc, input([{ ...OUTLINE, toc: undefined }]));
    expect(headings(markdown)).toEqual(['## Intro', '## 1 Name', '## 2 Scope', '### 2.1 Details', '#### Extra', '## 3 Notes']);
    expect(markdown.split('\n')).not.toContain('## 2.1 Details');
    expect(markdown.split('\n').some((line) => line.trim() === '##')).toBe(false);
  });

  it('turns CRLF into LF only when an outline applies', () => {
    const crlf = DOCUMENT.replace(/\n/g, '\r\n');
    expect(normalizeWithOutline(crlf, input()).markdown).not.toContain('\r');
    const unmatched = input([{ ...OUTLINE, detect: { pattern: 'Gadget Ledger', within_chars: 200 } }]);
    expect(normalizeWithOutline(crlf, unmatched).markdown).toBe(crlf);
  });

  it('returns the input with a null report when no marker is kept', () => {
    const doc = `${TITLE}\nNothing here names a section.`;
    expect(normalizeWithOutline(doc, input())).toEqual({ markdown: doc, report: null });
  });

  it('reports exactly the outline, the variants and the marker counts', () => {
    const { report } = normalizeWithOutline(DOCUMENT, input());
    expect(report).toEqual({
      outline_id: 'neutral-sheet',
      version: 1,
      variants: [ALPHA_LABEL, BETA_LABEL],
      markers_found: 13,
      markers_kept: 8,
      markers_dropped: 5,
    });
    expect(sectionOutlineStamp(report!)).toBe('neutral-sheet@1');
  });
});

describe('chunkDocument with an outline', () => {
  it('follows the outline in section_path and stamps every draft', () => {
    const filePath = writeOutlineFile(outlineFile());
    const sectionOutline = sectionOutlineInputFor(filePath, 's:default');
    const result = chunkDocument(config('general'), { markdown: DOCUMENT }, { sectionOutline });
    expect(result.chunks.map((chunk) => chunk.section_path)).toEqual([[], ...SECTION_PATHS(ALPHA_LABEL), ...SECTION_PATHS(BETA_LABEL)]);
    expect(result.chunks.every((chunk) => chunk.metadata.section_outline === 'neutral-sheet@1')).toBe(true);
    expect(result.sectionOutline).toEqual(normalizeWithOutline(DOCUMENT, sectionOutline).report);
    expect(chunkDocument(config('general'), { markdown: DOCUMENT, chunks: DOCLING_CHUNKS }, { sectionOutline })).toEqual(result);
    expect(chunkDocument(config('financial_report'), { markdown: DOCUMENT, chunks: DOCLING_CHUNKS }, { sectionOutline }).chunks.map((chunk) => chunk.section_path)).toEqual(
      result.chunks.map((chunk) => chunk.section_path),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps each section body in its own chunk', () => {
    const result = chunkDocument(config('general'), { markdown: [TITLE, ALPHA, BETA].join('\n') }, { sectionOutline: input() });
    const scope = result.chunks.find((chunk) => chunk.section_path.join('/') === `${BETA_LABEL}/2 Scope`);
    expect(scope?.content).toBe('The scope of the beta widget covers bench tests and shelf storage in a plain sample room for its parts.');
    expect(BETA).toContain(scope?.content ?? '-');
  });
});
