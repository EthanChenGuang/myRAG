import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');
const scripts = Object.keys((JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts);

const INGEST_ORDER = ['RAG_PAGE_BOILERPLATE', 'RAG_SECTION_RULES', 'RAG_DOC_ATTRIBUTES', 'RAG_ATTRIBUTE_HEADER'];
const CHECKBOXES = ['RAG_DOC_ATTRIBUTES', 'RAG_ATTRIBUTE_HEADER', 'RAG_LEXICAL_QUANTITY'];
const SELECTS = ['RAG_PAGE_BOILERPLATE', 'RAG_SECTION_RULES', 'RAG_ATTRIBUTE_FILTER'];
const ALL = [...INGEST_ORDER, 'RAG_LEXICAL_QUANTITY', 'RAG_ATTRIBUTE_FILTER'];

const OPTIONS: Record<string, Array<[string, string]>> = {
  RAG_PAGE_BOILERPLATE: [
    ['off', 'Off'],
    ['detect', 'Detect repeated lines'],
    ['rules', 'Workspace rules'],
    ['both', 'Detect and workspace rules'],
  ],
  RAG_SECTION_RULES: [
    ['off', 'Off'],
    ['on', 'On'],
  ],
  RAG_ATTRIBUTE_FILTER: [
    ['off', 'off'],
    ['hard', 'hard'],
    ['soft', 'soft'],
  ],
};

const DESCRIBED_BY: Record<string, string> = {
  RAG_PAGE_BOILERPLATE: 'rag-page-boilerplate-help',
  RAG_SECTION_RULES: 'rag-section-rules-help',
  RAG_DOC_ATTRIBUTES: 'rag-doc-attributes-help',
  RAG_ATTRIBUTE_HEADER: 'rag-attribute-header-help',
  RAG_LEXICAL_QUANTITY: 'rag-lexical-quantity-help rag-lexical-quantity-stored',
  RAG_ATTRIBUTE_FILTER: 'rag-attribute-filter-help',
};

const LABELS: Record<string, string> = {
  RAG_PAGE_BOILERPLATE: 'Page boilerplate cleaning',
  RAG_SECTION_RULES: 'Section rule sets',
  RAG_DOC_ATTRIBUTES: 'Document attributes',
  RAG_ATTRIBUTE_HEADER: 'Attribute header in search text',
  RAG_LEXICAL_QUANTITY: 'Numbers with units as single search terms',
  RAG_ATTRIBUTE_FILTER: 'Attribute filter',
};

const HELP: Record<string, string> = {
  RAG_PAGE_BOILERPLATE:
    'Before a document is split into chunks, removes lines that repeat at the top or bottom of its pages, lines that match the workspace’s rules, or both. The stored parse output is not changed. Needs the unified ingest pipeline.',
  RAG_SECTION_RULES:
    'Splits a document at the headings that its workspace’s rule set allows; other headings stay body text. A document that does not satisfy its rule set is split the usual way and marked for review. A workspace without a rule set is not changed. Needs the unified ingest pipeline.',
  RAG_DOC_ATTRIBUTES:
    'Stores attributes with each document and its chunks, checked against the workspace’s attribute schema. A value with an unknown key or the wrong type is rejected. Needs the unified ingest pipeline.',
  RAG_ATTRIBUTE_HEADER:
    'Adds one line, rendered from the workspace’s header template and the document’s attributes, to the text used for embedding and keyword search. The line is never sent to the answering model. Needs document attributes.',
  RAG_LEXICAL_QUANTITY:
    'A number followed by a unit symbol also matches as one term in keyword search, whatever its spacing, digit grouping, decimal separator or letter case. Calibrated refusal thresholds belong to one tokenizer version; calibrate them again after the rebuild.',
  RAG_ATTRIBUTE_FILTER:
    'off ignores attributes. hard limits retrieval to the documents whose attributes match a value named in the question or sent with the request, and searches again without the limit when that finds nothing. soft keeps every document and ranks the matching ones higher. Needs document attributes and the v2 pipeline.',
};

const STORED_SCRIPT: Record<string, string> = {
  RAG_PAGE_BOILERPLATE: 'rag:rechunk',
  RAG_SECTION_RULES: 'rag:rechunk',
  RAG_DOC_ATTRIBUTES: 'rag:attributes',
  RAG_ATTRIBUTE_HEADER: 'rag:rechunk',
  RAG_LEXICAL_QUANTITY: 'rag:relex',
};

function baseId(name: string): string {
  return `rag-${name.replace(/^RAG_/, '').toLowerCase().replace(/_/g, '-')}`;
}

function openingTag(id: string): string {
  const matches = [...html.matchAll(new RegExp(`<(input|select)\\b[^>]*\\bid="${id}"[^>]*>`, 'g'))];
  expect(matches, `exactly one control with id ${id}`).toHaveLength(1);
  return matches[0]![0];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

function textOf(markup: string): string {
  return markup.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** The element that opens with an attribute, up to its matching close tag. */
function element(attribute: string): string {
  const at = html.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<', at);
  const tag = /^<([a-z0-9]+)/.exec(html.slice(start))![1]!;
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`unclosed element for ${attribute}`);
}

function ingestGroup(): string {
  const start = html.indexOf('data-rag-settings-group="ingest"');
  const end = html.indexOf('data-rag-settings-group="', start + 1);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, end);
}

function formControlOf(id: string): string {
  const at = html.indexOf(`id="${id}"`);
  const start = html.lastIndexOf('<div class="form-control', at);
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`unclosed form-control for ${id}`);
}

describe('Phase 3.3 switches in the Config UI (03.3-UI-SPEC section 10)', () => {
  it('1. each variable has exactly one control and its name equals its id', () => {
    for (const id of ALL) expect(attr(openingTag(id), 'name'), id).toBe(id);
  });

  it('2. three checkboxes inside their label, three selects with a label for them', () => {
    for (const id of CHECKBOXES) {
      const tag = openingTag(id);
      expect(attr(tag, 'type'), id).toBe('checkbox');
      expect(attr(tag, 'class')?.split(/\s+/), id).toEqual(expect.arrayContaining(['checkbox', 'checkbox-primary']));
      const before = html.slice(0, html.indexOf(tag));
      expect(before.lastIndexOf('<label'), `${id} sits inside its label`).toBeGreaterThan(before.lastIndexOf('</label>'));
    }
    for (const id of SELECTS) {
      expect(openingTag(id).startsWith('<select'), id).toBe(true);
      expect(html, id).toMatch(new RegExp(`<label\\b[^>]*\\bfor="${id}"`));
    }
  });

  it('3. options in order with their texts; ingest selects carry their keys, the tuning-box select is untranslated', () => {
    for (const [id, expected] of Object.entries(OPTIONS)) {
      const select = element(`id="${id}"`);
      const options = [...select.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)];
      expect(options.map((m) => [attr(` ${m[1]!}`, 'value'), m[2]]), id).toEqual(expected);
      if (id === 'RAG_ATTRIBUTE_FILTER') {
        expect(options.map((m) => /\bselected\b/.test(m[1]!))).toEqual([true, false, false]);
        expect(attr(openingTag(id), 'translate')).toBe('no');
      } else {
        const tag = openingTag(id);
        expect(attr(tag, 'class')?.split(/\s+/)).toEqual(expect.arrayContaining(['select', 'select-bordered', 'select-sm']));
        expect(attr(tag, 'autocomplete')).toBe('off');
        for (const m of options) expect(m[1], `${id} option key`).toContain(`data-rag-i18n="${id}.opt.`);
        expect(options.some((m) => /\bselected\b/.test(m[1]!)), `${id} has no selected attribute`).toBe(false);
        expect(formControlOf(id)).toContain(`data-rag-i18n="${id}.label"`);
      }
    }
  });

  it('4. placement: ingest group after the caption language in order; tuning box positions', () => {
    const group = ingestGroup();
    const caption = group.indexOf('id="RAG_CAPTION_LANGUAGE"');
    const positions = INGEST_ORDER.map((id) => group.indexOf(`id="${id}"`));
    expect(caption).toBeGreaterThan(-1);
    for (const p of positions) expect(p).toBeGreaterThan(caption);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    const pos = (id: string) => html.indexOf(`id="${id}"`);
    const boxStart = html.indexOf('<div id="rag-tuning-switches"');
    expect(pos('RAG_LEXICAL_QUANTITY')).toBeGreaterThan(Math.max(boxStart, pos('RAG_LEXICAL_STEM_IT')));
    expect(pos('RAG_LEXICAL_QUANTITY')).toBeLessThan(pos('RAG_VERSION_SCOPE'));
    expect(pos('RAG_ATTRIBUTE_FILTER')).toBeGreaterThan(pos('RAG_IDENTIFIER_FILTER'));
    expect(pos('RAG_ATTRIBUTE_FILTER')).toBeLessThan(pos('RAG_EMBED_TENANT'));
  });

  it('5. aria-describedby names the help ids, each present once', () => {
    for (const [id, value] of Object.entries(DESCRIBED_BY)) {
      expect(attr(openingTag(id), 'aria-describedby'), id).toBe(value);
      for (const ref of value.split(' ')) expect(html.match(new RegExp(`\\bid="${ref}"`, 'g')), ref).toHaveLength(1);
    }
  });

  it('6. labels follow section 8; variable names are shown untranslated', () => {
    for (const [id, label] of Object.entries(LABELS)) {
      expect(textOf(element(`data-rag-i18n="${id}.label"`)), id).toBe(label);
    }
    expect(html).toContain('(<span translate="no">RAG_LEXICAL_QUANTITY</span>)');
    for (const id of INGEST_ORDER) {
      expect(formControlOf(id), id).toContain(`<code class="font-mono text-xs break-all" translate="no">${id}</code>`);
    }
  });

  it('7. help texts follow section 8, with the needs sentence last', () => {
    for (const [id, help] of Object.entries(HELP)) {
      const text = textOf(element(`data-rag-i18n="${id}.help"`));
      expect(text, id).toBe(help);
      if (help.includes('Needs ')) expect(text.slice(text.lastIndexOf('. ', text.length - 2) + 2).startsWith('Needs '), id).toBe(true);
    }
  });

  it('8. every stored-documents line names one existing script; keyed ingest nodes hold text only', () => {
    expect(html).not.toContain('id="rag-attribute-filter-stored"');
    for (const [id, script] of Object.entries(STORED_SCRIPT)) {
      const marker = `id="${baseId(id)}-stored"`;
      if (!html.includes(marker)) {
        // One-directional: a line may be missing only while its script is missing (D-24 adds rag:attributes and its line).
        if (script !== 'rag:attributes') expect(scripts, `${id} needs its stored line`).not.toContain(script);
        continue;
      }
      const stored = element(marker);
      expect(textOf(stored).startsWith('Stored documents:'), id).toBe(true);
      const codes = [...stored.matchAll(/<code\b[^>]*>([^<]*)<\/code>/g)];
      expect(codes, id).toHaveLength(1);
      const named = /npm run (\S+)/.exec(codes[0]![1]!)?.[1];
      expect(named, id).toBe(script);
      expect(scripts, id).toContain(script);
    }
    for (const id of INGEST_ORDER) {
      const control = formControlOf(id);
      for (const m of control.matchAll(/<(\w+)\b[^>]*data-rag-i18n="[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)) {
        expect(m[2], `${id} keyed node has no element child`).not.toMatch(/</);
      }
    }
  });

  it('9. the new markup has no script, no inline handler and no affectsStored marker', () => {
    for (const id of ALL) {
      const control = id === 'RAG_LEXICAL_QUANTITY' ? element(`id="${baseId(id)}-help"`) + element(`id="${baseId(id)}-stored"`) : formControlOf(id);
      expect(control, id).not.toMatch(/<script/i);
      expect(control, id).not.toMatch(/\son[a-z]+=/i);
      expect(control, id).not.toContain('settings.affectsStored');
    }
  });
});
