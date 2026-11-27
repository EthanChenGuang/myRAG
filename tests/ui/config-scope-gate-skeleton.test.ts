import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.join(__dirname, '../../scripts/config-ui/index.html'), 'utf8');

function at(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(index, needle).toBeGreaterThan(-1);
  return index;
}

function scopeGate(): string {
  const start = at(html, '<section id="rag-administration-scope-gate"');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end + '</section>'.length);
}

function card(): string {
  const start = at(html, '<!-- Query layer -->');
  const end = html.indexOf('<!-- Ingestion and embedding profiles -->', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function tagWith(source: string, hook: string): string {
  const match = new RegExp(`<[a-z0-9]+\\b[^>]*\\b${hook}\\b[^>]*>`).exec(source);
  expect(match, hook).not.toBeNull();
  return match![0];
}

function classes(tag: string): string[] {
  return (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/).filter(Boolean);
}

const HOSTS = ['data-scope-gate-note', 'data-scope-gate-alert', 'data-scope-gate-content', 'data-scope-gate-status'];

describe('Scope gate section: static skeleton', () => {
  it('orders heading, description, switch, help line, note, alert, content and status', () => {
    const section = scopeGate();
    const order = [
      'id="rag-scope-gate-title"',
      'data-scope-gate-description',
      'id="RAG_SCOPE_GATE"',
      'id="rag-scope-gate-help"',
      ...HOSTS,
    ].map((needle) => at(section, needle));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('writes the English description with the refusal description classes', () => {
    const section = scopeGate();
    const tag = tagWith(section, 'data-scope-gate-description');
    expect(tag.startsWith('<p ')).toBe(true);
    expect(classes(tag)).toEqual(expect.arrayContaining(['text-sm', 'text-base-content/70', 'mb-4', 'max-w-prose']));
    expect(section).toContain(
      "Skips retrieval for questions that are clearly outside what this knowledge base covers. What is in scope is learned only from the workspace’s own documents, document types and tags; no topic list is built in.",
    );
  });

  it('puts the derived note host directly under the help line', () => {
    const section = scopeGate();
    const helpEnd = section.indexOf('</label>', at(section, 'id="rag-scope-gate-help"')) + '</label>'.length;
    const note = tagWith(section, 'data-scope-gate-note');
    expect(section.slice(helpEnd, section.indexOf(note)).trim()).toBe('');
    expect(note.startsWith('<div ')).toBe(true);
    expect(classes(note)).toEqual(expect.arrayContaining(['pl-8', 'text-sm']));
  });

  it('marks the status host as a polite status region', () => {
    const tag = tagWith(scopeGate(), 'data-scope-gate-status');
    expect(tag.startsWith('<div ')).toBe(true);
    expect(classes(tag)).toEqual(expect.arrayContaining(['text-sm', 'mt-4']));
    expect(tag).toMatch(/\brole="status"/);
    expect(tag).toMatch(/\baria-live="polite"/);
  });

  it('leaves every host empty and each hook appears once on the page', () => {
    const section = scopeGate();
    for (const hook of HOSTS) {
      const tag = tagWith(section, hook);
      expect(section.slice(section.indexOf(tag) + tag.length).startsWith('</div>'), hook).toBe(true);
      expect(html.split(hook).length - 1, hook).toBe(1);
    }
  });

  it('keeps RAG_SCOPE_GATE the only input, select or textarea in the section', () => {
    const fields = scopeGate().match(/<(?:input|select|textarea)\b[^>]*>/g) ?? [];
    expect(fields).toHaveLength(1);
    expect(fields[0]).toContain('id="RAG_SCOPE_GATE"');
    expect(scopeGate()).not.toMatch(/<script\b/);
  });
});

describe('Query layer card: pointer to the Scope gate panel', () => {
  it('sits after the Speed box and before the Semantic cache box', () => {
    const section = card();
    const speedBoxEnd = section.lastIndexOf('<div class="border', at(section, '>Semantic cache</h4>'));
    const row = at(section, '<div class="flex flex-wrap items-center gap-x-2 mb-4">');
    const pointer = at(section, 'data-scope-gate-pointer-text');
    expect(pointer).toBeGreaterThan(at(section, 'id="RAG_ROUTING_QUALITY_MODEL"'));
    expect(row).toBeLessThan(pointer);
    expect(pointer).toBeLessThan(speedBoxEnd);
    expect(section.slice(row, speedBoxEnd).match(/<div class="border/g)).toBeNull();
  });

  it('holds the pointer text and an unwired Open scope gate button', () => {
    const section = card();
    const text = tagWith(section, 'data-scope-gate-pointer-text');
    expect(text.startsWith('<span ')).toBe(true);
    expect(classes(text)).toEqual(expect.arrayContaining(['label-text-alt', 'text-base-content/70']));
    expect(section).toContain(
      'The scope gate switch, its thresholds and out-of-scope examples are under RAG administration, Scope gate.</span>',
    );
    const button = tagWith(section, 'data-scope-gate-pointer(?!-)');
    expect(button.startsWith('<button ')).toBe(true);
    expect(button).toMatch(/\btype="button"/);
    expect(classes(button)).toEqual(expect.arrayContaining(['btn', 'btn-link', 'btn-xs']));
    expect(button).not.toMatch(/\bhref=|\bon[a-z]+=/);
    expect(section.slice(section.indexOf(button) + button.length)).toMatch(/^Open scope gate<\/button>/);
    expect(html.split('data-scope-gate-pointer-text').length - 1).toBe(1);
  });

  it('adds no form field to the pointer row and no second RAG_SCOPE_GATE control', () => {
    const section = card();
    const row = at(section, '<div class="flex flex-wrap items-center gap-x-2 mb-4">');
    const rowEnd = section.indexOf('</div>', row);
    expect(section.slice(row, rowEnd)).not.toMatch(/<(?:input|select|textarea|a)\b/);
    expect(section).not.toContain('RAG_SCOPE_GATE');
  });

  it('carries no domain example words in the skeleton and pointer copy', () => {
    const row = at(card(), 'data-scope-gate-pointer-text');
    const text = (scopeGate() + card().slice(row, row + 400)).replace(/<[^>]+>/g, ' ').toLowerCase();
    for (const word of ['travel', 'hotel', 'lodging', 'leave day', 'salary', 'restaurant', 'vpn', 'password', 'branch']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('Narrow widths', () => {
  it('lets long env names wrap inside the Query layer card and the Scope gate section', () => {
    expect(html).toMatch(/id="query-layer-card">\s*<div class="card-body \[overflow-wrap:anywhere\]">/);
    expect(scopeGate()).toMatch(/^<section[^>]*>\s*<div class="card-body \[overflow-wrap:anywhere\]">/);
  });
});
