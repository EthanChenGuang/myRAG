import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

const GROUPS: Record<string, string[]> = {
  languages: ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'],
  ingest: ['RAG_LANGUAGE_AWARE_INGEST', 'RAG_TABLE_HEADER_REPEAT', 'RAG_TABLE_ROW_SERIALIZATION', 'RAG_CAPTION_LANGUAGE'],
  security: ['RAG_HIDDEN_TEXT_CHECK', 'RAG_INGEST_LINK_CHECK', 'RAG_OUTPUT_LINK_ALLOWLIST'],
  approval: ['RAG_UPLOAD_APPROVAL'],
  scopes: ['RAG_SCOPE_TAGS', 'RAG_SCOPE_TAG_SUGGEST'],
  versions: ['RAG_SUPERSESSION_DETECT', 'RAG_EFFECTIVE_DATES', 'RAG_EFFECTIVE_DATE_LLM_EXTRACT'],
  translation: ['RAG_DOC_TRANSLATION', 'RAG_DOC_TRANSLATION_MODEL'],
  bge: ['RAG_BGE_M3_SERVING'],
};

const SELECT_OPTIONS: Record<string, [string, string][]> = {
  RAG_LANGUAGE_AWARE_INGEST: [['off', 'Off, as today'], ['on', 'On']],
  RAG_TABLE_HEADER_REPEAT: [['profile', 'Follow the document type'], ['always', 'Always']],
  RAG_TABLE_ROW_SERIALIZATION: [['false', 'Off'], ['true', 'On']],
  RAG_CAPTION_LANGUAGE: [['en', 'English, as today'], ['document', 'The document’s language']],
  RAG_HIDDEN_TEXT_CHECK: [['off', 'Off'], ['flag', 'Record only'], ['quarantine', 'Remove and quarantine']],
  RAG_INGEST_LINK_CHECK: [['off', 'Off'], ['flag', 'Record only'], ['quarantine', 'Quarantine']],
  RAG_UPLOAD_APPROVAL: [['off', 'None'], ['members', 'Uploads by members'], ['all', 'Every upload']],
  RAG_SCOPE_TAGS: [['false', 'Off'], ['true', 'On']],
  RAG_SCOPE_TAG_SUGGEST: [['false', 'Off'], ['true', 'On']],
  RAG_SUPERSESSION_DETECT: [['off', 'Off'], ['on', 'On']],
  RAG_EFFECTIVE_DATES: [['false', 'Off'], ['true', 'On']],
  RAG_EFFECTIVE_DATE_LLM_EXTRACT: [['false', 'Off'], ['true', 'On']],
  RAG_DOC_TRANSLATION: [['off', 'Off'], ['on', 'On']],
  RAG_BGE_M3_SERVING: [['hosted', 'Hosted API'], ['sidecar', 'Sidecar, in-house']],
};

const LABELS: Record<string, string> = {
  RAG_LANGUAGE_AWARE_INGEST: 'Language-aware processing',
  RAG_TABLE_HEADER_REPEAT: 'Table header repetition',
  RAG_TABLE_ROW_SERIALIZATION: 'Table rows as “column = value” for search',
  RAG_CAPTION_LANGUAGE: 'Image caption language',
  RAG_HIDDEN_TEXT_CHECK: 'Hidden text',
  RAG_INGEST_LINK_CHECK: 'Links',
  RAG_OUTPUT_LINK_ALLOWLIST: 'Allowed link domains',
  RAG_UPLOAD_APPROVAL: 'Uploads that need approval',
  RAG_SCOPE_TAGS: 'Document tags',
  RAG_SCOPE_TAG_SUGGEST: 'Tag suggestions',
  RAG_SUPERSESSION_DETECT: 'Detect possible older versions',
  RAG_EFFECTIVE_DATES: 'Use effective dates in answers',
  RAG_EFFECTIVE_DATE_LLM_EXTRACT: 'Read dates with a model',
  RAG_DOC_TRANSLATION: 'Document translation',
  RAG_DOC_TRANSLATION_MODEL: 'Translation model',
  RAG_BGE_M3_SERVING: 'BGE-M3 serving',
};

const AFFECTS_STORED = [
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_LANGUAGE_AWARE_INGEST',
  'RAG_TABLE_HEADER_REPEAT',
  'RAG_TABLE_ROW_SERIALIZATION',
  'RAG_CAPTION_LANGUAGE',
  'RAG_DOC_TRANSLATION',
  'RAG_DOC_TRANSLATION_MODEL',
  'RAG_HIDDEN_TEXT_CHECK',
  'RAG_INGEST_LINK_CHECK',
  'RAG_OUTPUT_LINK_ALLOWLIST',
];

function block(): string {
  const start = html.indexOf('<!-- rag-phase032-settings:start -->');
  const end = html.indexOf('<!-- rag-phase032-settings:end -->');
  expect(start, 'block start marker').toBeGreaterThan(-1);
  expect(end, 'block end marker').toBeGreaterThan(start);
  return html.slice(start, end);
}

/** The markup of one div[data-rag-settings-group]: from its opening tag to the next group or the block end. */
function group(name: string): string {
  const text = block();
  const start = text.indexOf(`data-rag-settings-group="${name}"`);
  expect(start, `group ${name}`).toBeGreaterThan(-1);
  const next = text.indexOf('data-rag-settings-group="', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

function openingTag(id: string): string {
  const matches = [...html.matchAll(new RegExp(`<(input|select|textarea)\\b[^>]*\\bid="${id}"[^>]*>`, 'g'))];
  expect(matches, `exactly one control with id ${id}`).toHaveLength(1);
  return matches[0]![0];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** The form-control that holds the control with this id. */
function formControl(id: string): string {
  const text = block();
  const at = text.indexOf(`id="${id}"`);
  const start = text.lastIndexOf('<div class="form-control', at);
  const end = text.indexOf('<div class="form-control', at);
  return text.slice(start, end === -1 ? text.indexOf('data-rag-settings-group="', at) : end);
}

describe('Phase 3.2 settings block in the Config UI (UI-SPEC 6.3, 12.9)', () => {
  it('is one hidden block with the eight groups in order', () => {
    expect(html.match(/id="rag-phase032-settings"/g)).toHaveLength(1);
    expect(html).toMatch(/<div id="rag-phase032-settings" class="hidden">/);
    const order = [...block().matchAll(/data-rag-settings-group="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(Object.keys(GROUPS));
  });

  it('every one of the eighteen ids exists once, inside its group, with name equal to id', () => {
    const all = Object.values(GROUPS).flat();
    expect(all).toHaveLength(18);
    for (const [name, ids] of Object.entries(GROUPS)) {
      const markup = group(name);
      for (const id of ids) {
        expect(markup, `${id} in group ${name}`).toContain(`id="${id}"`);
        expect(attr(openingTag(id), 'name'), id).toBe(id);
      }
    }
  });

  it('the language mirrors are hidden inputs', () => {
    for (const id of GROUPS.languages!) {
      const tag = openingTag(id);
      expect(tag.startsWith('<input'), id).toBe(true);
      expect(attr(tag, 'type'), id).toBe('hidden');
    }
  });

  it('selects use the small bordered style, env values and the labels of 12.9', () => {
    for (const [id, options] of Object.entries(SELECT_OPTIONS)) {
      const tag = openingTag(id);
      expect(tag.startsWith('<select'), id).toBe(true);
      expect(attr(tag, 'class'), id).toMatch(/\bselect\b.*\bselect-bordered\b.*\bselect-sm\b/);
      const markup = formControl(id);
      const found = [...markup.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
      expect(found, id).toEqual(options);
    }
  });

  it('every visible control has a label with for and a help line tied by aria-describedby', () => {
    for (const [id, label] of Object.entries(LABELS)) {
      const labelMatch = new RegExp(`<label\\b[^>]*\\bfor="${id}"[^>]*>([\\s\\S]*?)</label>`).exec(html);
      expect(labelMatch, `label for ${id}`).not.toBeNull();
      expect(labelMatch![1]!.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim(), id).toBe(label);
      const describedBy = attr(openingTag(id), 'aria-describedby');
      expect(describedBy, id).toBeTruthy();
      expect(block()).toContain(`id="${describedBy}"`);
      expect(formControl(id), `${id} shows its env name`).toMatch(new RegExp(`<code class="font-mono text-xs[^"]*" translate="no">${id}</code>`));
      expect(attr(openingTag(id), 'autocomplete'), `${id} autocomplete`).toBe('off');
    }
  });

  it('the allowlist is a textarea that opts out of autofill, spellcheck and translation', () => {
    const tag = openingTag('RAG_OUTPUT_LINK_ALLOWLIST');
    expect(tag.startsWith('<textarea'), 'textarea').toBe(true);
    expect(attr(tag, 'autocomplete')).toBe('off');
    expect(attr(tag, 'spellcheck')).toBe('false');
    expect(attr(tag, 'translate')).toBe('no');
    const model = openingTag('RAG_DOC_TRANSLATION_MODEL');
    expect(attr(model, 'type')).toBe('text');
    expect(attr(model, 'autocomplete')).toBe('off');
    expect(attr(model, 'spellcheck')).toBe('false');
  });

  it('the ten ingestion-side controls end their help with settings.affectsStored, and only those', () => {
    const marker = 'data-rag-i18n="settings.affectsStored"';
    expect(block().split(marker).length - 1).toBe(AFFECTS_STORED.length);
    for (const id of AFFECTS_STORED) {
      const markup = formControl(id);
      expect(markup, id).toContain(marker);
      expect(markup).toContain('Changing this affects documents already stored; saving shows how many.');
    }
  });

  it('labels, help lines and option texts carry data-rag-i18n keys for zh and it', () => {
    for (const id of Object.keys(LABELS)) {
      expect(formControl(id), id).toMatch(/<span class="label-text" data-rag-i18n="[^"]+">/);
    }
    for (const [id, options] of Object.entries(SELECT_OPTIONS)) {
      for (const [value] of options) {
        expect(formControl(id), `${id} ${value}`).toMatch(new RegExp(`<option value="${value}" data-rag-i18n="[^"]+"( selected)?>`));
      }
    }
  });

  it('RAG_TABLE_HEADER_REPEAT preselects always, the default decided in eval/decisions/03.2-table-header-default.json', () => {
    const selected = [...formControl('RAG_TABLE_HEADER_REPEAT').matchAll(/<option value="([^"]*)"[^>]* selected>/g)].map((m) => m[1]);
    expect(selected).toEqual(['always']);
    for (const id of Object.keys(SELECT_OPTIONS).filter((name) => name !== 'RAG_TABLE_HEADER_REPEAT')) {
      expect(formControl(id), id).not.toMatch(/<option [^>]* selected>/);
    }
  });

  it('code tokens and brand names are not machine-translated; copy uses curly quotes', () => {
    expect(block()).toContain('<span translate="no">https://</span>');
    expect(block()).toContain('<span translate="no">BGE-M3</span>');
    const text = block().replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/"|'/);
  });

  it('adds no script and no inline handler', () => {
    expect(block()).not.toMatch(/<script\b|\son[a-z]+="/i);
  });
});
