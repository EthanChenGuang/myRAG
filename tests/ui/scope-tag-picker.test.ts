import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  SCOPE_TAG_ITEM_CLASS,
  SCOPE_TAG_MENU_CLASS,
  ScopeTagPicker,
  buildScopeTagGroups,
  keepScopeTagMenuOpen,
  scopeTagTriggerLabel,
  toggleScopeTag,
  type ScopeTagPickerProps,
  type ScopeTagVocabularyEntry,
} from '@/components/ui/scope-tag-picker';
import { scopeDimensionLabel, scopeTagText } from '@/components/ui/scope-tag-labels';
import { buildChatUploadFormData } from '@/components/ui/doc-type-picker';
import { UploadQueueRow } from '@/components/ui/upload-queue-row';

const VOCABULARY: ScopeTagVocabularyEntry[] = [
  { dimension: 'region', value: 'north', label: 'North' },
  { dimension: 'region', value: 'south', label: 'South' },
  { dimension: 'department', value: 'unit-a', label: 'Unit A' },
];

function renderPicker(extra: Partial<ScopeTagPickerProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ScopeTagPicker, {
      enabled: true,
      vocabulary: VOCABULARY,
      value: [],
      language: 'en',
      fileName: 'sample-notes.pdf',
      onChange: () => undefined,
      ...extra,
    }),
  );
}

describe('scope tag labels', () => {
  it.each([
    ['en', 'Tags', 'Tags: 2', 'Choose tags for a.pdf', 'Clear tags'],
    ['zh', '标签', '标签：2', '为 a.pdf 选择标签', '清除标签'],
    ['it', 'Tag', 'Tag: 2', 'Scegli i tag per a.pdf', 'Rimuovi i tag'],
  ])('has the %s strings', (language, trigger, count, aria, clear) => {
    expect(scopeTagText('trigger', language)).toBe(trigger);
    expect(scopeTagText('count', language, { n: 2 })).toBe(count);
    expect(scopeTagText('aria', language, { file: 'a.pdf' })).toBe(aria);
    expect(scopeTagText('clear', language)).toBe(clear);
  });

  it('names the dimensions in words and falls back to English', () => {
    expect(scopeDimensionLabel('legal_entity', 'en')).toBe('Legal entity');
    expect(scopeDimensionLabel('region', 'zh')).toBe('地区');
    expect(scopeDimensionLabel('department', 'it')).toBe('Reparto');
    expect(scopeDimensionLabel('region', 'xx')).toBe('Region');
    expect(scopeTagText('trigger', 'xx')).toBe('Tags');
  });
});

describe('buildScopeTagGroups', () => {
  it('groups active entries by dimension in vocabulary order with the dimension name in words', () => {
    const groups = buildScopeTagGroups(VOCABULARY, 'en', ['region:south']);
    expect(groups.map((g) => [g.dimension, g.label])).toEqual([
      ['region', 'Region'],
      ['department', 'Department'],
    ]);
    expect(groups[0]?.items).toEqual([
      { tag: 'region:north', label: 'North', checked: false },
      { tag: 'region:south', label: 'South', checked: true },
    ]);
    expect(groups[1]?.items).toEqual([{ tag: 'department:unit-a', label: 'Unit A', checked: false }]);
  });

  it('skips malformed entries and has no group for an empty vocabulary', () => {
    expect(buildScopeTagGroups([], 'en', [])).toEqual([]);
    const bad = [{ dimension: '', value: 'x', label: 'X' }, { dimension: 'region', value: '', label: 'Y' }] as ScopeTagVocabularyEntry[];
    expect(buildScopeTagGroups(bad, 'en', [])).toEqual([]);
  });

  it('renders a 200-value dimension inside the capped scroll container of the menu', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ dimension: 'region', value: `v${i}`, label: `Value ${i}` }));
    expect(buildScopeTagGroups(many, 'en', [])[0]?.items).toHaveLength(200);
    expect(SCOPE_TAG_MENU_CLASS).toContain('max-h-72');
    expect(SCOPE_TAG_MENU_CLASS).toContain('overflow-y-auto');
  });

  it('lets a long tag label wrap in its menu item', () => {
    expect(SCOPE_TAG_ITEM_CLASS).toContain('whitespace-normal');
    expect(SCOPE_TAG_ITEM_CLASS).toContain('break-words');
    expect(SCOPE_TAG_ITEM_CLASS).not.toContain('truncate');
  });
});

describe('tag selection', () => {
  it('passes the selection up as dimension:value strings', () => {
    expect(toggleScopeTag([], 'region:north', true)).toEqual(['region:north']);
    expect(toggleScopeTag(['region:north'], 'department:unit-a', true)).toEqual(['region:north', 'department:unit-a']);
    expect(toggleScopeTag(['region:north'], 'region:north', true)).toEqual(['region:north']);
    expect(toggleScopeTag(['region:north', 'department:unit-a'], 'region:north', false)).toEqual(['department:unit-a']);
  });

  it('keeps the menu open when an item is selected', () => {
    const preventDefault = vi.fn();
    keepScopeTagMenuOpen({ preventDefault } as unknown as Event);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('shows the label alone, or the count, on the trigger', () => {
    expect(scopeTagTriggerLabel(0, 'en')).toBe('Tags');
    expect(scopeTagTriggerLabel(3, 'en')).toBe('Tags: 3');
    expect(scopeTagTriggerLabel(1, 'zh')).toBe('标签：1');
  });
});

describe('ScopeTagPicker', () => {
  it('renders an outline trigger whose accessible name includes the file name', () => {
    const html = renderPicker({ value: ['region:north', 'department:unit-a'] });
    expect(html).toContain('aria-label="Choose tags for sample-notes.pdf"');
    expect(html).toContain('Tags: 2');
    expect(html).toContain('title="North, Unit A"');
    expect(html).toContain('lucide-tags');
    expect(html).toContain('h-8');
    expect(html).toContain('text-xs');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it('renders nothing when tags are not enabled or no value is active', () => {
    expect(renderPicker({ enabled: false })).toBe('');
    expect(renderPicker({ vocabulary: [] })).toBe('');
  });

  it('renders the file name and labels as text, never as markup', () => {
    const html = renderPicker({
      fileName: '<img src=x onerror=alert(1)>.pdf',
      vocabulary: [{ dimension: 'region', value: 'north', label: '<b>North</b>' }],
      value: ['region:north'],
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.pdf');
  });

  it('shows the unknown-tag sentence at the picker', () => {
    const html = renderPicker({ error: scopeTagText('unknownTag', 'en') });
    expect(html).toContain('role="alert"');
    expect(html).toContain('A chosen tag no longer exists. The tag list was reloaded; choose again.');
  });
});

describe('upload form fields for tags', () => {
  const file = new File(['x'], 'a.txt', { type: 'text/plain' });

  it('appends one scopes field per tag when tags are chosen', () => {
    const form = buildChatUploadFormData({ file, pickerEnabled: true, docType: 'auto', scopes: ['region:north', 'department:unit-a'] });
    expect(form.getAll('scopes')).toEqual(['region:north', 'department:unit-a']);
  });

  it('adds no scopes field without tags', () => {
    const form = buildChatUploadFormData({ file, pickerEnabled: true, docType: 'auto', scopes: [] });
    expect(form.has('scopes')).toBe(false);
    expect([...buildChatUploadFormData({ file, pickerEnabled: false }).keys()]).toEqual(['file']);
  });
});

describe('UploadQueueRow with the tag picker', () => {
  it('renders the picker beside the doc-type picker in a wrapping control group', () => {
    const html = renderToStaticMarkup(
      createElement(UploadQueueRow, {
        fileName: 'sample-notes.pdf',
        fileSize: 1024,
        language: 'en',
        disabled: false,
        docType: { value: 'auto', onChange: () => undefined },
        tags: { vocabulary: VOCABULARY, value: [], onChange: () => undefined, error: null },
        onRemove: () => undefined,
      }),
    );
    expect(html).toContain('aria-label="Choose tags for sample-notes.pdf"');
    expect(html).toContain('flex flex-wrap items-center justify-end gap-2');
    expect(html.indexOf('role="combobox"')).toBeLessThan(html.indexOf('Choose tags for'));
  });

  it('gives a 200-character unbroken file name the truncate class and a title', () => {
    const name = `${'n'.repeat(196)}.pdf`;
    const html = renderToStaticMarkup(
      createElement(UploadQueueRow, {
        fileName: name,
        fileSize: 1024,
        language: 'en',
        disabled: false,
        docType: null,
        tags: { vocabulary: VOCABULARY, value: [], onChange: () => undefined, error: null },
        onRemove: () => undefined,
      }),
    );
    expect(html).toMatch(new RegExp(`<p class="[^"]*truncate[^"]*" title="${name}">${name}</p>`));
  });
});

describe('tags block of the picker-defaults answer', () => {
  it('keeps the picker hidden unless tags are enabled with at least one well-formed value', async () => {
    const { readUploadTags } = await import('@/components/ui/upload-queue-config');
    expect(readUploadTags(undefined).enabled).toBe(false);
    expect(readUploadTags({ enabled: false, vocabulary: VOCABULARY }).enabled).toBe(false);
    expect(readUploadTags({ enabled: true, vocabulary: [] }).enabled).toBe(false);
    expect(readUploadTags({ enabled: true, vocabulary: [{ dimension: 'region', value: 1, label: 'x' }] }).enabled).toBe(false);
    expect(readUploadTags({ enabled: true, vocabulary: VOCABULARY })).toEqual({ enabled: true, vocabulary: VOCABULARY });
  });
});
