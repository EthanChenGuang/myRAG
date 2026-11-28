import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ReplacesChooserBody,
  ReplacesLine,
  ReplacesPicker,
  ReplacesTitle,
  filterReplaceCandidates,
  nextRovingIndex,
  replacesChooserKeyAction,
  type ReplaceCandidate,
  type ReplacesChooserBodyProps,
  type ReplacesPickerProps,
} from '@/components/ui/replaces-picker';
import { replacesText } from '@/components/ui/replaces-labels';
import { buildChatUploadFormData } from '@/components/ui/doc-type-picker';
import { UploadQueueRow } from '@/components/ui/upload-queue-row';

const CANDIDATES: ReplaceCandidate[] = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'alpha-notes.pdf', uploadedAt: new Date('2026-11-20T10:00:00.000Z') },
  { id: '22222222-2222-4222-8222-222222222222', name: 'beta-summary.docx', uploadedAt: new Date('2026-11-21T10:00:00.000Z') },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Gamma-Overview.txt', uploadedAt: null },
];

function renderBody(extra: Partial<ReplacesChooserBodyProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ReplacesChooserBody, {
      language: 'en',
      candidates: CANDIDATES,
      query: '',
      onQueryChange: () => undefined,
      selectedId: null,
      onSelect: () => undefined,
      ...extra,
    }),
  );
}

function renderPicker(extra: Partial<ReplacesPickerProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ReplacesPicker, {
      enabled: true,
      confirmedAtOnce: false,
      fileName: 'sample-notes.pdf',
      candidates: CANDIDATES,
      language: 'en',
      value: null,
      onChange: () => undefined,
      ...extra,
    }),
  );
}

describe('replaces labels', () => {
  it.each([
    ['en', 'Replaces…', 'Which document does a.pdf replace?', 'Choose document', 'Close chooser'],
    ['zh', '替换…', 'a.pdf 要替换哪份文档？', '选择文档', '关闭选择'],
    ['it', 'Sostituisce…', 'Quale documento sostituisce a.pdf?', 'Scegli documento', 'Chiudi selezione'],
  ])('has the %s strings', (language, trigger, title, confirm, close) => {
    expect(replacesText('trigger', language)).toBe(trigger);
    expect(replacesText('title', language, { file: 'a.pdf' })).toBe(title);
    expect(replacesText('confirm', language)).toBe(confirm);
    expect(replacesText('close', language)).toBe(close);
  });

  it('falls back to English', () => {
    expect(replacesText('search', 'xx')).toBe('Search documents');
  });
});

describe('filterReplaceCandidates', () => {
  it('matches the file name case-insensitively and ignores surrounding spaces', () => {
    expect(filterReplaceCandidates(CANDIDATES, '  gamma ').map((c) => c.name)).toEqual(['Gamma-Overview.txt']);
    expect(filterReplaceCandidates(CANDIDATES, '').map((c) => c.name)).toHaveLength(3);
    expect(filterReplaceCandidates(CANDIDATES, 'zzz')).toEqual([]);
  });
});

describe('keyboard in the chooser', () => {
  it('moves with Up and Down, wraps, and jumps with Home and End', () => {
    expect(nextRovingIndex(0, 'ArrowDown', 3)).toBe(1);
    expect(nextRovingIndex(2, 'ArrowDown', 3)).toBe(0);
    expect(nextRovingIndex(0, 'ArrowUp', 3)).toBe(2);
    expect(nextRovingIndex(1, 'Home', 3)).toBe(0);
    expect(nextRovingIndex(1, 'End', 3)).toBe(2);
    expect(nextRovingIndex(1, 'a', 3)).toBe(1);
    expect(nextRovingIndex(0, 'ArrowDown', 0)).toBe(0);
  });

  it('selects with Space or Enter and closes with Escape', () => {
    expect(replacesChooserKeyAction(' ')).toBe('select');
    expect(replacesChooserKeyAction('Enter')).toBe('select');
    expect(replacesChooserKeyAction('Escape')).toBe('close');
    expect(replacesChooserKeyAction('ArrowDown')).toBe('move');
    expect(replacesChooserKeyAction('x')).toBe(null);
  });
});

describe('ReplacesChooserBody', () => {
  it('has a labelled search field and a radiogroup with roving tabindex', () => {
    const html = renderBody({ selectedId: CANDIDATES[1]?.id ?? null });
    expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Search documents<\/label>/);
    const id = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain('type="search"');
    expect(html).toContain('name="replaces-search"');
    expect(html).toMatch(/autocomplete="off"/i);
    expect(html).toContain('lucide-search');
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"|tabindex="0"[^>]*aria-checked="true"/);
    expect(html).toContain('lucide-check');
  });

  it('starts the roving tabindex on the first row when nothing is chosen', () => {
    const html = renderBody();
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.indexOf('tabindex="0"')).toBeLessThan(html.indexOf('beta-summary.docx'));
    expect(html).not.toContain('aria-checked="true"');
  });

  it('shows the file name with truncate and a title, and the upload date', () => {
    const html = renderBody();
    expect(html).toMatch(/class="[^"]*truncate[^"]*" title="alpha-notes.pdf">alpha-notes.pdf</);
    expect(html).toContain('Nov 20, 2026');
  });

  it('shows the empty sentence when the workspace has no document', () => {
    const html = renderBody({ candidates: [] });
    expect(html).toContain('No documents in this workspace yet.');
    expect(html).not.toContain('role="radio"');
  });

  it('shows the no-match sentence with the query as text', () => {
    const html = renderBody({ query: '<script>x</script>' });
    expect(html).toContain('No document matches “&lt;script&gt;x&lt;/script&gt;”.');
    expect(html).not.toContain('<script>');
  });

  it('renders file names as text, never as markup', () => {
    const html = renderBody({ candidates: [{ id: 'd1', name: '<img src=x onerror=1>.pdf', uploadedAt: null }] });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=1&gt;.pdf');
  });
});

describe('ReplacesTitle', () => {
  it('inserts a long file name as truncated text with the full name in title', () => {
    const name = `${'n'.repeat(196)}.pdf`;
    const html = renderToStaticMarkup(createElement(ReplacesTitle, { language: 'en', fileName: name }));
    expect(html).toContain('Which document does ');
    expect(html).toMatch(new RegExp(`<span class="[^"]*truncate[^"]*" title="${name}">${name}</span>`));
    expect(html).toContain(' replace?');
  });
});

describe('ReplacesPicker', () => {
  it('renders an outline trigger that opens a dialog', () => {
    const html = renderPicker();
    expect(html).toContain('Replaces…');
    expect(html).toContain('lucide-replace');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('h-8');
    expect(html).toContain('<span class="sr-only">(for sample-notes.pdf)</span>');
  });

  it('renders nothing when the server does not enable it', () => {
    expect(renderPicker({ enabled: false })).toBe('');
  });

  it('says whether the choice is confirmed at once or by an admin', () => {
    expect(replacesText('admin', 'en')).toBe('The chosen document stops being used for answers when this upload is ready.');
    expect(replacesText('member', 'en')).toBe('An admin confirms the replacement. Until then both documents are used for answers.');
  });
});

describe('ReplacesLine', () => {
  it('shows the chosen file name and a remove button with an sr-only name', () => {
    const html = renderToStaticMarkup(createElement(ReplacesLine, { language: 'en', name: 'alpha-notes.pdf', onRemove: () => undefined }));
    expect(html).toContain('Replaces: alpha-notes.pdf');
    expect(html).toContain('title="alpha-notes.pdf"');
    expect(html).toContain('<span class="sr-only">Clear replacement: alpha-notes.pdf</span>');
    expect(html).toContain('lucide-x');
  });
});

describe('upload form field for the replaced document', () => {
  const file = new File(['x'], 'a.txt', { type: 'text/plain' });

  it('appends replaces_document_id only when a document is chosen', () => {
    const chosen = buildChatUploadFormData({ file, pickerEnabled: true, docType: 'auto', replacesDocumentId: 'doc-7' });
    expect(chosen.get('replaces_document_id')).toBe('doc-7');
    const none = buildChatUploadFormData({ file, pickerEnabled: true, docType: 'auto', replacesDocumentId: null });
    expect(none.has('replaces_document_id')).toBe(false);
  });
});

describe('UploadQueueRow with "Replaces…"', () => {
  it('renders the trigger and the Replaces line in the left column', () => {
    const html = renderToStaticMarkup(
      createElement(UploadQueueRow, {
        fileName: 'sample-notes.pdf',
        fileSize: 1024,
        language: 'en',
        disabled: false,
        docType: null,
        replaces: {
          confirmedAtOnce: true,
          candidates: CANDIDATES,
          value: CANDIDATES[0] ?? null,
          onChange: () => undefined,
        },
        onRemove: () => undefined,
      }),
    );
    expect(html).toContain('Replaces: alpha-notes.pdf');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html.indexOf('Replaces: alpha-notes.pdf')).toBeLessThan(html.indexOf('aria-haspopup="dialog"'));
  });
});

describe('upload queue config from the picker-defaults answer', () => {
  it('shows "Replaces…" only on an explicit enabled flag and reads confirmedAtOnce', async () => {
    const { readUploadReplaces } = await import('@/components/ui/upload-queue-config');
    expect(readUploadReplaces(undefined)).toEqual({ enabled: false, confirmedAtOnce: false });
    expect(readUploadReplaces({ enabled: 'true' })).toEqual({ enabled: false, confirmedAtOnce: false });
    expect(readUploadReplaces({ enabled: true })).toEqual({ enabled: true, confirmedAtOnce: false });
    expect(readUploadReplaces({ enabled: true, confirmedAtOnce: true })).toEqual({ enabled: true, confirmedAtOnce: true });
  });

  it('offers only ready documents, once each', async () => {
    const { replaceCandidatesFrom } = await import('@/components/ui/upload-queue-config');
    const at = new Date('2026-11-20T10:00:00.000Z');
    const candidates = replaceCandidatesFrom([
      { id: 'd1', name: 'one.pdf', status: 'ready', uploadedAt: at },
      { id: 'd1', name: 'one.pdf', status: 'ready', uploadedAt: at },
      { id: 'd2', name: 'two.pdf', status: 'processing' },
      { id: 'd3', name: 'three.pdf', status: 'failed' },
      { id: 'd4', name: 'four.pdf', status: 'ready', ingest: { status: 'pending_review' } },
      { id: 'd5', name: 'five.pdf', status: 'ready', ingest: { status: 'ready' } },
    ]);
    expect(candidates).toEqual([
      { id: 'd1', name: 'one.pdf', uploadedAt: at },
      { id: 'd5', name: 'five.pdf', uploadedAt: null },
    ]);
  });
});
