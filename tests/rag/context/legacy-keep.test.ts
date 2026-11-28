import { describe, expect, it } from 'vitest';
import { filterCandidates, type AssembleInput } from '@/lib/rag/context/assemble';
import { legacyKeepReason, legacyQueryTerms } from '@/lib/rag/context/relevance';

function assembleInput(queryText: unknown): AssembleInput {
  return {
    queryText,
    candidates: [],
    documents: new Map(),
    chunkMetadata: new Map(),
    referenced: null,
    isGPTModel: false,
    ragMode: 'strict',
    webSearchEnabled: false,
    applyRelevanceFilter: true,
  };
}

const QUERIES: unknown[] = [
  'Where is the Quarterly Widget report?',
  'a bb ccc dddd',
  '  spaced   words\tand-hyphens, punctuation!  ',
  [{ type: 'text', text: 'Alpha BETA gamma' }],
  [{ type: 'image', url: 'x' }],
  '',
  null,
  42,
];

describe('legacyQueryTerms', () => {
  it('legacy terms match queryTermsOf', () => {
    expect(legacyQueryTerms('Where is the Quarterly Widget report?')).toEqual(['where', 'quarterly', 'widget', 'report']);
    expect(legacyQueryTerms('and-hyphens, ok')).toEqual(['andhyphens']);
    for (const query of QUERIES) {
      expect(legacyQueryTerms(query)).toEqual(filterCandidates(assembleInput(query)).queryTerms);
    }
  });

  it('non-latin long word yields the empty term', () => {
    expect(legacyQueryTerms('示例问题文本 alpha')).toEqual(['', 'alpha']);
    expect(legacyQueryTerms('短 示例')).toEqual([]);
  });
});

describe('legacyKeepReason', () => {
  const base = { similarity: 0.1, hasImage: false, filename: 'notes.md', text: 'plain sample text' };

  it('keep reason order similarity name image', () => {
    expect(legacyKeepReason({ ...base, similarity: 0.7, filename: 'widget.md', hasImage: true }, ['widget'])).toBe('similarity');
    expect(legacyKeepReason({ ...base, filename: 'Widget-Guide.md', hasImage: true, similarity: 0.5 }, ['widget'])).toBe('name');
    expect(legacyKeepReason({ ...base, text: 'About the WIDGET line' }, ['widget'])).toBe('name');
    expect(legacyKeepReason({ ...base, hasImage: true, similarity: 0.3 }, ['widget'])).toBe('image');
    expect(legacyKeepReason({ ...base, hasImage: true, similarity: 0.25 }, ['widget'])).toBeNull();
    expect(legacyKeepReason({ ...base, similarity: 0.65 }, ['widget'])).toBeNull();
  });

  it('uses the given floors and treats a missing similarity as no score', () => {
    expect(legacyKeepReason({ ...base, similarity: 0.2 }, [], { text: 0.15, image: 0.1 })).toBe('similarity');
    expect(legacyKeepReason({ ...base, similarity: null, hasImage: true }, [])).toBeNull();
    expect(legacyKeepReason({ ...base, similarity: null, text: 'the widget' }, ['widget'])).toBe('name');
    expect(legacyKeepReason({ ...base, filename: null, text: null }, ['widget'])).toBeNull();
  });

  it('an empty term matches any filename', () => {
    expect(legacyKeepReason(base, [''])).toBe('name');
  });
});
