import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

const RECONCILE_FIELDS = [
  { id: 'RAG_SOURCE_RECONCILE_INTERVAL_DAYS', min: '1', step: '1', max: undefined, placeholder: '7', inputmode: 'numeric' },
  { id: 'RAG_SOURCE_RECONCILE_MAX_AGE_DAYS', min: '1', step: '1', max: undefined, placeholder: '7', inputmode: 'numeric' },
  { id: 'RAG_SOURCE_RECONCILE_MAX_DELETE_SHARE', min: '0.05', step: '0.05', max: '1', placeholder: '0.3', inputmode: 'decimal' },
];
const KEY_FIELDS = [
  { id: 'NANGO_SHAREPOINT_INTEGRATION_KEY', placeholder: 'sharepoint-online' },
  { id: 'NANGO_ONEDRIVE_INTEGRATION_KEY', placeholder: 'one-drive' },
];
const ALL_IDS = [
  'RAG_SOURCE_RECHECK',
  ...RECONCILE_FIELDS.map((field) => field.id),
  'NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED',
  ...KEY_FIELDS.map((field) => field.id),
];

function openingTag(id: string): string {
  const matches = [...html.matchAll(new RegExp(`<(input|select)\\b[^>]*\\bid="${id}"[^>]*>`, 'g'))];
  expect(matches, `exactly one control with id ${id}`).toHaveLength(1);
  return matches[0]![0];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

function between(start: string, end: string): string {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return html.slice(from, to);
}

function sourceSyncSection(): string {
  return between('<section id="rag-administration-source-sync"', '</section>');
}

function sharePointCard(): string {
  return between('<!-- SharePoint and OneDrive -->', '<!-- Nango Sync Configuration -->');
}

function describedHelp(id: string): string {
  const describedBy = attr(openingTag(id), 'aria-describedby');
  expect(describedBy, `${id} aria-describedby`).toBeTruthy();
  const help = new RegExp(`<[a-z]+\\b[^>]*\\bid="${describedBy}"[^>]*>([^<]*)<`).exec(html);
  expect(help, `help line ${describedBy}`).not.toBeNull();
  return help![1]!;
}

describe('Phase 6.3 source sync fields in the Config UI (UI-SPEC 6.4, 6.7)', () => {
  it('every new control has a name equal to its id and a label pointing at it', () => {
    for (const id of ALL_IDS) {
      expect(attr(openingTag(id), 'name'), id).toBe(id);
      expect(html, `label for ${id}`).toMatch(new RegExp(`<label\\b[^>]*\\bfor="${id}"`));
    }
  });

  it('RAG_SOURCE_RECHECK is a false-first select right after the exact identifier lookup control', () => {
    const tag = openingTag('RAG_SOURCE_RECHECK');
    expect(tag.startsWith('<select')).toBe(true);
    expect(attr(tag, 'translate')).toBe('no');
    const exact = html.indexOf('id="RAG_EXACT_ID_LOOKUP"');
    const recheck = html.indexOf('id="RAG_SOURCE_RECHECK"');
    expect(recheck).toBeGreaterThan(exact);
    const gap = html.slice(exact, recheck);
    expect(gap.match(/<select\b/g) ?? [], 'only the recheck select opens in between').toHaveLength(1);
    const options = between('id="RAG_SOURCE_RECHECK"', '</select>').match(/value="([^"]*)"/g);
    expect(options).toEqual(['value="false"', 'value="true"']);
    expect(describedHelp('RAG_SOURCE_RECHECK')).toMatch(/^false keeps today's retrieval\./);
  });

  it('the reconcile settings are number fields with the UI-SPEC limits, no autofill and a help line', () => {
    for (const field of RECONCILE_FIELDS) {
      const tag = openingTag(field.id);
      expect(tag.startsWith('<input'), field.id).toBe(true);
      expect(attr(tag, 'type'), field.id).toBe('number');
      expect(attr(tag, 'min'), field.id).toBe(field.min);
      expect(attr(tag, 'step'), field.id).toBe(field.step);
      expect(attr(tag, 'max'), field.id).toBe(field.max);
      expect(attr(tag, 'placeholder'), field.id).toBe(field.placeholder);
      expect(attr(tag, 'inputmode'), field.id).toBe(field.inputmode);
      expect(attr(tag, 'autocomplete'), field.id).toBe('off');
      expect(attr(tag, 'translate'), field.id).toBe('no');
      expect(describedHelp(field.id).length, field.id).toBeGreaterThan(20);
    }
  });

  it('the source sync section sits once before the embedding profiles and holds the settings block, a status region and a content host', () => {
    expect(html.match(/id="rag-administration-source-sync"/g) ?? []).toHaveLength(1);
    expect(html.indexOf('id="rag-administration-source-sync"')).toBeLessThan(html.indexOf('id="rag-administration-profiles"'));
    const section = sourceSyncSection();
    expect(section).toContain('>Source sync</h3>');
    expect(section).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(section).toContain('data-source-sync-content');
    expect(section).toContain('data-source-sync-alert');
    const settings = between('<!-- rag-source-sync-settings:start -->', '<!-- rag-source-sync-settings:end -->');
    expect(section).toContain(settings);
    for (const field of RECONCILE_FIELDS) expect(settings, field.id).toContain(`id="${field.id}"`);
    expect(settings).toContain('Saved with Save All Changes at the top of the page.');
    expect(settings).toMatch(/<button\b[^>]*type="button"[^>]*>Open RAG Modes<\/button>/);
    expect(html).toMatch(/source sync and purge records/);
  });

  it('the SharePoint and OneDrive card follows the Nango API card with a toggle and two text key inputs', () => {
    expect(html.indexOf('<!-- SharePoint and OneDrive -->')).toBeGreaterThan(html.indexOf('<!-- Nango API Configuration -->'));
    const card = sharePointCard();
    expect(card).toContain('SharePoint and OneDrive</h3>');
    const toggle = openingTag('NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED');
    expect(card).toContain(toggle);
    expect(attr(toggle, 'type')).toBe('checkbox');
    expect(attr(toggle, 'class')).toContain('toggle toggle-primary');
    for (const field of KEY_FIELDS) {
      const tag = openingTag(field.id);
      expect(card, field.id).toContain(tag);
      expect(attr(tag, 'type'), field.id).toBe('text');
      expect(attr(tag, 'placeholder'), field.id).toBe(field.placeholder);
      expect(attr(tag, 'spellcheck'), field.id).toBe('false');
      expect(attr(tag, 'autocomplete'), field.id).toBe('off');
      expect(attr(tag, 'translate'), field.id).toBe('no');
      expect(describedHelp(field.id)).toBe('The integration id set for this provider in the Nango dashboard. Leave empty to use the default.');
    }
    expect(card).toContain('Saved with Save All Changes at the top of the page, not with Save Changes below.');
  });

  it('no new markup uses an inline event handler', () => {
    for (const block of [sourceSyncSection(), sharePointCard(), between('id="RAG_SOURCE_RECHECK"', '</div>')]) {
      expect(block).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });
});
