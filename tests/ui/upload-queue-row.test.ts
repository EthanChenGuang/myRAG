import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UploadQueueRow, type UploadQueueRowProps } from '@/components/ui/upload-queue-row';

const noop = () => undefined;

function render(extra: Partial<UploadQueueRowProps> = {}): string {
  return renderToStaticMarkup(
    createElement(UploadQueueRow, {
      fileName: 'sample-notes.pdf',
      fileSize: 1572864,
      language: 'en',
      disabled: false,
      docType: null,
      onRemove: noop,
      ...extra,
    }),
  );
}

// Markup of the queue row as document-dashboard.tsx rendered it before plan 03.2-64.
const BEFORE_NO_PICKER =
  '<div class="group flex items-center justify-between gap-2 px-4 py-2 hover:bg-white/50 dark:hover:bg-[#212121]"><div class="grid gap-0.5 min-w-0 flex-1 mr-2"><p class="text-sm font-medium text-gray-900 dark:text-white truncate">sample-notes.pdf</p><p class="text-xs text-gray-600 dark:text-gray-400">1.50 MB</p></div>__REMOVE__</div>';

describe('UploadQueueRow with tags and "Replaces…" off', () => {
  it('renders exactly the row of today without the doc-type picker', () => {
    const html = render();
    const remove = html.slice(html.indexOf('<button'), html.lastIndexOf('</button>') + '</button>'.length);
    expect(html).toBe(BEFORE_NO_PICKER.replace('__REMOVE__', remove));
    expect(remove).toContain('<span class="sr-only">Remove file</span>');
  });

  it('matches the snapshot of today with and without the doc-type picker', () => {
    expect(render()).toMatchSnapshot('no-picker');
    expect(render({ docType: { value: 'auto', onChange: noop } })).toMatchSnapshot('doc-type-picker');
  });
});
