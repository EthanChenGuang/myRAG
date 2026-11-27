import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.join(__dirname, '../../scripts/config-ui/index.html'), 'utf8');

function card(): string {
  const start = html.indexOf('<!-- Query layer -->');
  const end = html.indexOf('<!-- Ingestion and embedding profiles -->', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function scopeGate(): string {
  const start = html.indexOf('<section id="rag-administration-scope-gate"');
  expect(start, 'scope gate section').toBeGreaterThan(-1);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end + '</section>'.length);
}

function control(section: string, id: string): string {
  const match = new RegExp(`<(?:input|select)[^>]*\\bid="${id}"[^>]*>`).exec(section);
  expect(match, id).not.toBeNull();
  return match![0];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

function at(section: string, needle: string): number {
  const index = section.indexOf(needle);
  expect(index, needle).toBeGreaterThan(-1);
  return index;
}

/** The div.form-control block that holds the control with this id. */
function block(section: string, id: string): string {
  const controlAt = at(section, `id="${id}"`);
  const open = section.lastIndexOf('<div class="form-control', controlAt);
  const close = section.indexOf('</div>', controlAt);
  return section.slice(open, close + '</div>'.length);
}

const CARD_SWITCHES: Array<[string, boolean]> = [
  ['RAG_QUERY_HISTORY_FALLBACK', true],
  ['RAG_QUERY_DECOMPOSE_COMPLETENESS', true],
  ['RAG_QUERY_SUBQ_FILTERS', false],
  ['RAG_DECOMPOSED_ANSWER', true],
  ['RAG_WHATSAPP_HISTORY', false],
  ['RAG_TRANSLATION_GLOSSARY', false],
  ['RAG_LANGID_SIDECAR', false],
  ['RAG_SPECULATIVE_RETRIEVAL', false],
];
const CARD_SELECTS = ['RAG_MODEL_ROUTING', 'RAG_ROUTING_FAST_MODEL', 'RAG_ROUTING_QUALITY_MODEL'];

describe('Query layer card: Phase 6.2 env controls', () => {
  it('writes the eleven controls with id and name equal to the env name, once each', () => {
    const section = card();
    for (const id of [...CARD_SWITCHES.map(([name]) => name), ...CARD_SELECTS]) {
      const tag = control(section, id);
      expect(attr(tag, 'name'), id).toBe(id);
      expect(html.split(`id="${id}"`).length - 1, id).toBe(1);
    }
  });

  it('gives every switch its D-28 default, the env name in span[translate=no] and a wired help line', () => {
    const section = card();
    for (const [id, checked] of CARD_SWITCHES) {
      const tag = control(section, id);
      expect(tag, id).toMatch(/type="checkbox"/);
      expect(/\bchecked\b/.test(tag), id).toBe(checked);
      const helpId = attr(tag, 'aria-describedby');
      expect(helpId, id).toBeTruthy();
      expect(section, id).toMatch(new RegExp(`<span class="label-text-alt min-w-0" id="${helpId}">[^<]`));
      expect(block(section, id), id).toContain(`(<span translate="no">${id}</span>)`);
    }
  });

  it('nests the four switches under their transform as div.form-control.pl-8, directly after the parent', () => {
    const section = card();
    const nested = [
      ['RAG_QUERY_CONDENSE', ['RAG_QUERY_HISTORY_FALLBACK']],
      ['RAG_QUERY_DECOMPOSE', ['RAG_QUERY_DECOMPOSE_COMPLETENESS', 'RAG_QUERY_SUBQ_FILTERS', 'RAG_DECOMPOSED_ANSWER']],
    ] as const;
    for (const [parent, children] of nested) {
      let cursor = section.indexOf('</div>', at(section, `id="${parent}"`)) + '</div>'.length;
      for (const child of children) {
        const childBlock = block(section, child);
        expect(childBlock.startsWith('<div class="form-control pl-8"'), child).toBe(true);
        const start = section.indexOf(childBlock);
        expect(section.slice(cursor, start).trim(), `${child} directly after ${parent}`).toBe('');
        cursor = start + childBlock.length;
      }
    }
    const transforms = section.slice(at(section, '>Transforms</h4>'), at(section, 'id="RAG_QUERY_VOICE_TRANSFORMS"'));
    for (const [, children] of nested) for (const child of children) expect(transforms).toContain(`id="${child}"`);
  });

  it('places WhatsApp history after Voice transforms, then the Languages and Speed boxes before the Semantic cache box', () => {
    const section = card();
    const order = [
      'id="RAG_QUERY_VOICE_TRANSFORMS"',
      'id="RAG_WHATSAPP_HISTORY"',
      'id="RAG_QUERY_TRANSLATE_DISABLED_PROFILES"',
      '>Languages</h4>',
      'id="RAG_TRANSLATION_GLOSSARY"',
      'id="RAG_LANGID_SIDECAR"',
      '>Speed</h4>',
      'id="RAG_SPECULATIVE_RETRIEVAL"',
      'id="RAG_MODEL_ROUTING"',
      'id="RAG_ROUTING_FAST_MODEL"',
      'id="RAG_ROUTING_QUALITY_MODEL"',
      '>Semantic cache</h4>',
    ].map((needle) => at(section, needle));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(block(section, 'RAG_WHATSAPP_HISTORY').startsWith('<div class="form-control mb-4"')).toBe(true);
    const languages = section.slice(order[3], order[6]);
    const speed = section.slice(order[6], order[11]);
    expect(languages.match(/No effect while the query layer is off\./g)).toHaveLength(1);
    expect(speed.match(/No effect while the query layer is off\./g)).toHaveLength(1);
  });

  it('offers routing off (selected) and auto, and the two model selects hold only "Not set"', () => {
    const section = card();
    expect(section).toMatch(/<select id="RAG_MODEL_ROUTING"[^>]*>\s*<option value="off" selected>off<\/option>\s*<option value="auto">auto<\/option>\s*<\/select>/);
    expect(attr(control(section, 'RAG_MODEL_ROUTING'), 'aria-describedby')).toBeTruthy();
    expect(section).toMatch(/<label class="label" for="RAG_MODEL_ROUTING"><span class="label-text">Model routing for the Auto entry \(<span translate="no">RAG_MODEL_ROUTING<\/span>\)<\/span><\/label>/);
    for (const id of ['RAG_ROUTING_FAST_MODEL', 'RAG_ROUTING_QUALITY_MODEL']) {
      const tag = control(section, id);
      expect(tag, id).toMatch(/translate="no"/);
      expect(section, id).toMatch(new RegExp(`<select id="${id}"[^>]*>\\s*<option value="">Not set</option>\\s*</select>`));
    }
    const pair = section.slice(at(section, 'id="RAG_SPECULATIVE_RETRIEVAL"'), at(section, 'id="RAG_ROUTING_QUALITY_MODEL"'));
    expect(pair).toContain('<div class="grid grid-cols-1 md:grid-cols-2 gap-4">');
  });

  it('carries no domain example words in the new labels and help lines', () => {
    const start = at(card(), 'id="RAG_QUERY_HISTORY_FALLBACK"');
    const text = card().slice(start).replace(/<[^>]+>/g, ' ').toLowerCase();
    for (const word of ['travel', 'hotel', 'lodging', 'leave day', 'salary', 'restaurant', 'vpn', 'password', 'branch']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('RAG administration: Scope gate section', () => {
  it('sits directly after the Refusal calibration section', () => {
    const refusal = at(html, '<section id="rag-administration-refusal"');
    const refusalEnd = html.indexOf('</section>', refusal) + '</section>'.length;
    const next = html.indexOf('<section', refusalEnd);
    expect(html.slice(next, next + 50)).toContain('id="rag-administration-scope-gate"');
  });

  it('uses the refusal card classes, the labelled heading and the unchecked switch with its help line', () => {
    const section = scopeGate();
    expect(section).toMatch(/^<section id="rag-administration-scope-gate" class="card bg-base-200 shadow-md min-w-0 scroll-mt-4" aria-labelledby="rag-scope-gate-title">/);
    expect(section).toMatch(/<h3 id="rag-scope-gate-title" class="text-lg font-semibold mb-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" tabindex="-1"[^>]*>Scope gate<\/h3>/);
    const tag = control(section, 'RAG_SCOPE_GATE');
    expect(attr(tag, 'name')).toBe('RAG_SCOPE_GATE');
    expect(tag).toMatch(/type="checkbox"/);
    expect(tag).toMatch(/class="checkbox checkbox-primary"/);
    expect(tag).not.toMatch(/\bchecked\b/);
    expect(attr(tag, 'aria-describedby')).toBe('rag-scope-gate-help');
    expect(section).toMatch(/<div class="form-control mb-4">\s*<label class="label cursor-pointer justify-start gap-3">/);
    expect(section).toMatch(/<span class="label-text" data-rag-i18n="switch\.label">Enable the scope gate \(<span translate="no">RAG_SCOPE_GATE<\/span>\)<\/span>/);
    expect(section).toMatch(/<label class="label pl-8">\s*<span class="label-text-alt min-w-0" id="rag-scope-gate-help" data-rag-i18n="switch\.help">Off sends every question to retrieval, as today\. Voice never uses the scope gate\.<\/span>/);
  });

  it('holds no form field other than the switch', () => {
    const fields = scopeGate().match(/<(?:input|select|textarea|button)\b/g) ?? [];
    expect(fields).toHaveLength(1);
    expect(html.split('id="RAG_SCOPE_GATE"').length - 1).toBe(1);
  });
});
