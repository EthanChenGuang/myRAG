import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

function block(): string {
  const start = html.indexOf('<!-- rag-phase043-settings:start -->');
  const end = html.indexOf('<!-- rag-phase043-settings:end -->');
  expect(start, 'phase 4.3 settings block start marker').toBeGreaterThan(-1);
  expect(end, 'phase 4.3 settings block end marker').toBeGreaterThan(start);
  return html.slice(start, end);
}

function accessGroup(): string {
  const markup = block();
  const open = markup.indexOf('<div data-rag-settings-group="access">');
  expect(open, 'access settings group').toBeGreaterThan(-1);
  return markup.slice(open);
}

function openingTag(markup: string, id: string): string {
  const matches = [...markup.matchAll(new RegExp(`<(input|select)\\b[^>]*\\bid="${id}"[^>]*>`, 'g'))];
  expect(matches, `exactly one control with id ${id}`).toHaveLength(1);
  return matches[0]![0];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

describe('Phase 4.3 access settings in the Config UI (UI-SPEC 6.6, 12.5)', () => {
  it('the block is hidden and holds the access group', () => {
    const markup = block();
    expect(markup).toMatch(/<div id="rag-phase043-settings" class="hidden">/);
    expect(markup).toContain('<div data-rag-settings-group="access">');
  });

  it('RAG_DOC_ACCESS_GROUPS is a select with exactly the values off and on, off selected', () => {
    const group = accessGroup();
    const tag = openingTag(group, 'RAG_DOC_ACCESS_GROUPS');
    expect(tag.startsWith('<select')).toBe(true);
    expect(attr(tag, 'name')).toBe('RAG_DOC_ACCESS_GROUPS');
    expect(attr(tag, 'translate')).toBe('no');
    expect(attr(tag, 'class')).toContain('select select-bordered select-sm');
    expect(html).toMatch(/<label\b[^>]*\bfor="RAG_DOC_ACCESS_GROUPS"/);
    const selectBody = group.slice(group.indexOf(tag), group.indexOf('</select>', group.indexOf(tag)));
    const options = [...selectBody.matchAll(/<option\b([^>]*)>/g)].map((m) => m[1]!);
    expect(options.map((o) => attr(` ${o}`, 'value'))).toEqual(['off', 'on']);
    expect(options[0]).toMatch(/\bselected\b/);
    expect(options[1]).not.toMatch(/\bselected\b/);
  });

  it('the option text uses the UI-SPEC labels', () => {
    const group = accessGroup();
    expect(group).toContain('Off, as today');
    expect(group).toContain('>On<');
    expect(group).toContain('Access groups');
  });

  it('RAG_EMBED_ACCESS_GROUP is a labelled text input in the access group with autofill, spellcheck and translation off', () => {
    const group = accessGroup();
    const tag = openingTag(group, 'RAG_EMBED_ACCESS_GROUP');
    expect(tag.startsWith('<input')).toBe(true);
    expect(attr(tag, 'type')).toBe('text');
    expect(attr(tag, 'name')).toBe('RAG_EMBED_ACCESS_GROUP');
    expect(attr(tag, 'autocomplete')).toBe('off');
    expect(attr(tag, 'spellcheck')).toBe('false');
    expect(attr(tag, 'translate')).toBe('no');
    expect(attr(tag, 'class')).toContain('input input-bordered input-sm font-mono');
    expect(html).toMatch(/<label\b[^>]*\bfor="RAG_EMBED_ACCESS_GROUP"/);
    const describedBy = attr(tag, 'aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(group).toContain(`id="${describedBy}"`);
    expect(group).toContain('Embedded chat group');
  });
});
