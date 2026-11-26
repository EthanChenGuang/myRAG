import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

const CHECKBOXES = [
  'RAG_LEXICAL_DICTIONARY',
  'RAG_LEXICAL_STEM_IT',
  'RAG_VERSION_SCOPE',
  'RAG_EMBED_VERSION_SCOPE',
  'RAG_TABLE_LOOKUP',
  'RAG_DUP_CLUSTERS',
  'RAG_IDENTIFIER_INDEX',
  'RAG_IDENTIFIER_FILTER',
];
const SELECT = 'RAG_RESULT_DIVERSITY';
const D04_ORDER = [
  'RAG_LEXICAL_DICTIONARY',
  'RAG_LEXICAL_STEM_IT',
  'RAG_VERSION_SCOPE',
  'RAG_EMBED_VERSION_SCOPE',
  'RAG_TABLE_LOOKUP',
  'RAG_DUP_CLUSTERS',
  'RAG_RESULT_DIVERSITY',
  'RAG_IDENTIFIER_INDEX',
  'RAG_IDENTIFIER_FILTER',
];

function openingTag(id: string): string {
  const matches = [...html.matchAll(new RegExp(`<(input|select)\\b[^>]*\\bid="${id}"[^>]*>`, 'g'))];
  expect(matches, `exactly one control with id ${id}`).toHaveLength(1);
  return matches[0]![0];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

function helpId(name: string): string {
  return `rag-${name.replace(/^RAG_/, '').toLowerCase().replace(/_/g, '-')}-help`;
}

function box(): string {
  const start = html.indexOf('<div id="rag-tuning-switches"');
  expect(start, 'the tuning switch box exists').toBeGreaterThan(-1);
  const end = html.indexOf('id="RAG_EMBED_TENANT"', start);
  return html.slice(start, end);
}

describe('Phase 4.2 retrieval tuning switches in the Config UI (plan 04.2-02, UI-SPEC 6.2)', () => {
  it('has exactly one box, after the Phase 4 box and before the embedded chat tenant field', () => {
    expect([...html.matchAll(/id="rag-tuning-switches"/g)]).toHaveLength(1);
    const phase4 = html.indexOf('Phase 4 retrieval switches (off = current behaviour)');
    const tuning = html.indexOf('id="rag-tuning-switches"');
    const tenant = html.indexOf('id="RAG_EMBED_TENANT"');
    expect(phase4).toBeGreaterThan(-1);
    expect(tuning).toBeGreaterThan(phase4);
    expect(tenant).toBeGreaterThan(tuning);
    expect(html.slice(phase4, tuning)).toContain('id="RAG_RETRIEVAL_PARAMS_OVERRIDE"');
  });

  it('the box uses the classes of the Phase 4 box and its heading wraps evenly', () => {
    const tag = /<div id="rag-tuning-switches"[^>]*>/.exec(html)?.[0] ?? '';
    for (const cls of ['border', 'border-base-300', 'rounded-lg', 'p-4', 'mb-4', 'space-y-4']) {
      expect(attr(tag, 'class')?.split(/\s+/), cls).toContain(cls);
    }
    expect(box()).toMatch(/<h4 class="[^"]*\btext-balance\b[^"]*"[^>]*>(<span[^>]*>)?Retrieval tuning switches \(off = current behaviour\)/);
  });

  it('every control has a name equal to its id; checkboxes sit inside their label; the select has a label for it', () => {
    for (const id of CHECKBOXES) {
      const tag = openingTag(id);
      expect(attr(tag, 'type'), id).toBe('checkbox');
      expect(attr(tag, 'name'), id).toBe(id);
      const before = html.slice(0, html.indexOf(tag));
      expect(before.lastIndexOf('<label'), `${id} sits inside its label`).toBeGreaterThan(before.lastIndexOf('</label>'));
      expect(html, `${id} label shows the variable untranslated`).toMatch(new RegExp(`\\(<span translate="no">${id}</span>\\)`));
    }
    const select = openingTag(SELECT);
    expect(attr(select, 'name')).toBe(SELECT);
    expect(attr(select, 'translate')).toBe('no');
    expect(html).toMatch(new RegExp(`<label\\b[^>]*\\bfor="${SELECT}"`));
  });

  it('every control has a help line tied to it through aria-describedby', () => {
    for (const id of [...CHECKBOXES, SELECT]) {
      const describedBy = attr(openingTag(id), 'aria-describedby');
      expect(describedBy, id).toBe(helpId(id));
      expect([...html.matchAll(new RegExp(`id="${describedBy}"`, 'g'))], describedBy).toHaveLength(1);
    }
  });

  it('result diversity offers off, collapse and mmr with off selected', () => {
    const block = new RegExp(`<select\\b[^>]*\\bid="${SELECT}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? '';
    const options = [...block.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)];
    expect(options.map((m) => m[1])).toEqual(['off', 'collapse', 'mmr']);
    expect(options.map((m) => m[3])).toEqual(['off', 'collapse', 'mmr']);
    expect(options.filter((m) => m[2]).map((m) => m[1])).toEqual(['off']);
  });

  it('the embed version-scope switch directly follows RAG_VERSION_SCOPE in the Versions group (D-58)', () => {
    const content = box();
    const scope = content.indexOf('id="RAG_VERSION_SCOPE"');
    const embed = content.indexOf('id="RAG_EMBED_VERSION_SCOPE"');
    expect(scope).toBeGreaterThan(-1);
    expect(embed).toBeGreaterThan(scope);
    const between = content.slice(scope + 'id="RAG_VERSION_SCOPE"'.length, embed);
    expect(between).not.toMatch(/<(input|select)\b/);
    expect(between).not.toMatch(/border-t border-base-300 pt-4/);
    const help = new RegExp(`<p\\b[^>]*\\bid="${helpId('RAG_EMBED_VERSION_SCOPE')}"[^>]*>([^<]*)</p>`).exec(content)?.[1] ?? '';
    expect(help).toContain('Works only while the version scope filter is on');
    expect(content).not.toContain('id="rag-embed-version-scope-stored"');
  });

  it('the nine controls sit in the box in the D-04 order, in five groups', () => {
    const content = box();
    const positions = D04_ORDER.map((id) => content.indexOf(`id="${id}"`));
    for (const [i, id] of D04_ORDER.entries()) expect(positions[i], id).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect([...content.matchAll(/border-t border-base-300 pt-4/g)]).toHaveLength(4);
  });

  it('the box is static markup: no script, no inline handler', () => {
    const content = box();
    expect(content).not.toMatch(/<script\b/i);
    expect(content).not.toMatch(/\son[a-z]+=/i);
  });
});
