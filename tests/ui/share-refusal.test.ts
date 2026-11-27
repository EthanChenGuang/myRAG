import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShareRefusal, shareFailureOf } from '@/components/ui/share-chat-button';
import { SyncFailClosedLine, syncResultLines } from '@/components/ui/nango/connector-grid';

describe('shareFailureOf', () => {
  it('maps 403 restricted_content to the refusal', () => {
    expect(shareFailureOf(403, { error: 'restricted_content' })).toBe('restricted');
  });

  it('keeps every other failure generic', () => {
    expect(shareFailureOf(503, { error: 'access_groups_unavailable' })).toBe('generic');
    expect(shareFailureOf(403, { error: 'forbidden' })).toBe('generic');
    expect(shareFailureOf(400, { error: 'restricted_content' })).toBe('generic');
    expect(shareFailureOf(500, null)).toBe('generic');
    expect(shareFailureOf(403, 'restricted_content')).toBe('generic');
    expect(shareFailureOf(403, ['restricted_content'])).toBe('generic');
  });

  it('decides by the code, never by message text', () => {
    expect(shareFailureOf(403, { error: 'other', message: 'restricted_content' })).toBe('generic');
    expect(shareFailureOf(403, { message: 'This chat uses restricted content' })).toBe('generic');
  });
});

describe('ShareRefusal', () => {
  it('renders one alert block with the two sentences and no link or button', () => {
    const html = renderToStaticMarkup(createElement(ShareRefusal, { language: 'en' }));
    expect(html.match(/role="alert"/g)?.length).toBe(1);
    expect(html).toContain("This chat can&#x27;t be shared by link, because it uses documents that only some members can see.");
    expect(html).toContain('If it should be shareable, ask an admin to make those documents visible to everyone.');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('/shared/');
  });

  it('uses the zh and it strings', () => {
    expect(renderToStaticMarkup(createElement(ShareRefusal, { language: 'zh' }))).toContain('此对话无法通过链接分享');
    expect(renderToStaticMarkup(createElement(ShareRefusal, { language: 'it' }))).toContain('Questa chat non può essere condivisa tramite link');
  });
});

describe('syncResultLines', () => {
  it('adds sync.failClosed with the count in single-tenant mode', () => {
    expect(syncResultLines({ failClosed: 3 }, 'single', 'en')).toEqual([
      'Visible only to you and admins: 3. Their sharing at the source is not matched to an access group yet. An admin can map it under Access groups.',
    ]);
  });

  it('formats the count for the language', () => {
    expect(syncResultLines({ failClosed: 12000 }, 'single', 'en')[0]).toContain('12,000');
    expect(syncResultLines({ failClosed: 12000 }, 'single', 'it')[0]).toContain('12.000');
  });

  it('adds nothing in multi-tenant mode', () => {
    expect(syncResultLines({ failClosed: 3 }, 'multi', 'en')).toEqual([]);
  });

  it('adds nothing for zero, a missing count or no stats', () => {
    expect(syncResultLines({ failClosed: 0 }, 'single', 'en')).toEqual([]);
    expect(syncResultLines({} as { failClosed: number }, 'single', 'en')).toEqual([]);
    expect(syncResultLines(null, 'single', 'en')).toEqual([]);
    expect(syncResultLines({ failClosed: Number.NaN }, 'single', 'en')).toEqual([]);
  });
});

describe('SyncFailClosedLine', () => {
  it('renders the sentence with the warning icon and no button', () => {
    const text = syncResultLines({ failClosed: 2 }, 'single', 'en')[0];
    const html = renderToStaticMarkup(createElement(SyncFailClosedLine, { text }));
    expect(html).toContain('Visible only to you and admins: 2.');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('text-amber-700');
    expect(html).not.toContain('<button');
  });
});
