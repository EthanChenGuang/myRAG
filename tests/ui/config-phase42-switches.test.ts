import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement } from './helpers/html-fake-dom';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');
const SCRIPT_PATH = 'scripts/config-ui/rag-panels/retrieval-tuning-switches.js';
const packageScripts = (JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;

/** UI-SPEC section 12 command constants, one per ingestion-side switch. */
const STORED: Record<string, string> = {
  RAG_LEXICAL_DICTIONARY: 'npm run rag:relex -- --tenant <key> --stale-dictionary',
  RAG_LEXICAL_STEM_IT: 'npm run rag:relex -- --tenant <key>',
  RAG_TABLE_LOOKUP: 'npm run rag:table-rows -- --tenant <key>',
  RAG_DUP_CLUSTERS: 'npm run rag:dup-clusters -- --tenant <key>',
  RAG_IDENTIFIER_INDEX: 'npm run rag:identifiers -- --tenant <key>',
};
const QUESTION_SIDE = ['RAG_VERSION_SCOPE', 'RAG_EMBED_VERSION_SCOPE', 'RAG_RESULT_DIVERSITY', 'RAG_IDENTIFIER_FILTER'];

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

function storedId(name: string): string {
  return helpId(name).replace(/-help$/, '-stored');
}

function box(): string {
  const start = html.indexOf('<div id="rag-tuning-switches"');
  expect(start, 'the tuning switch box exists').toBeGreaterThan(-1);
  const end = html.indexOf('<!-- Query layer -->', start);
  return html.slice(start, end);
}

describe('Phase 4.2 retrieval tuning switches in the Config UI (plan 04.2-02, UI-SPEC 6.2)', () => {
  it('has exactly one box, after the Phase 4 box and at the end of the Retrieval pipeline card (plan 07-20 moved the fields after it and the Vector backends card)', () => {
    expect([...html.matchAll(/id="rag-tuning-switches"/g)]).toHaveLength(1);
    const phase4 = html.indexOf('Phase 4 retrieval switches (off = current behaviour)');
    const tuning = html.indexOf('id="rag-tuning-switches"');
    const next = html.indexOf('<!-- Query layer -->');
    expect(phase4).toBeGreaterThan(-1);
    expect(tuning).toBeGreaterThan(phase4);
    expect(next).toBeGreaterThan(tuning);
    expect(html.slice(tuning, next)).not.toMatch(/id="RAG_EMBED_TENANT"/);
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

  it('every control has a help line tied to it through aria-describedby, followed by its stored line when it has one', () => {
    for (const id of [...CHECKBOXES, SELECT]) {
      const describedBy = attr(openingTag(id), 'aria-describedby') ?? '';
      const expected = id in STORED ? `${helpId(id)} ${storedId(id)}` : helpId(id);
      expect(describedBy, id).toBe(expected);
      for (const ref of describedBy.split(' ')) {
        expect([...html.matchAll(new RegExp(`id="${ref}"`, 'g'))], ref).toHaveLength(1);
      }
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
    const between = content.slice(scope + 'id="RAG_VERSION_SCOPE"'.length, content.lastIndexOf('<input', embed));
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

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The element that carries an attribute, up to its matching close tag. */
function element(source: string, attribute: string): string {
  const at = source.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  const start = source.lastIndexOf('<', at);
  const tag = /^<([a-z0-9]+)/.exec(source.slice(start))![1]!;
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return source.slice(start, m.index + m[0].length);
  }
  throw new Error(`unclosed element for ${attribute}`);
}

/** The flags a CLI accepts, read from the USAGE constant of the file its package.json script runs. */
function usageFlags(script: string): Set<string> {
  const command = packageScripts[script];
  expect(command, `package.json has ${script}`).toBeDefined();
  const file = /\btsx\s+(\S+\.ts)\b/.exec(command!)?.[1];
  expect(file, `${script} runs a tsx file`).toBeDefined();
  const source = fs.readFileSync(file!, 'utf8');
  const usage = /export const USAGE\s*=\s*\n?\s*'([^']*)'/.exec(source)?.[1];
  expect(usage, `${file} exports USAGE`).toBeDefined();
  return new Set([...usage!.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
}

describe('Phase 4.2 tuning box: stored-documents lines (plan 04.2-25, UI-SPEC 6.2 and 12.2)', () => {
  it('each ingestion-side switch has one stored line that starts with "Stored documents:" and holds exactly its command', () => {
    const content = box();
    for (const [id, command] of Object.entries(STORED)) {
      const line = element(content, `id="${storedId(id)}"`);
      expect(line.startsWith('<p'), id).toBe(true);
      expect(textOf(line).startsWith('Stored documents:'), id).toBe(true);
      const codes = [...line.matchAll(/<code\b([^>]*)>([^<]*)<\/code>/g)];
      expect(codes, `${id} has exactly one command`).toHaveLength(1);
      expect(attr(` ${codes[0]![1]!}`, 'translate'), id).toBe('no');
      expect(textOf(codes[0]![2]!), id).toBe(command);
      expect(line, `${id} stored line sits outside the label`).not.toMatch(/<label\b/);
    }
  });

  it('the box holds the five stored lines of this phase plus the Phase 3.3 quantity line, and no others', () => {
    const content = box();
    const lines = [...content.matchAll(/<p\b[^>]*\bid="(rag-[a-z0-9-]+-stored)"/g)].map((m) => m[1]);
    expect(lines.sort()).toEqual([...Object.keys(STORED).map(storedId), 'rag-lexical-quantity-stored'].sort());
    for (const id of QUESTION_SIDE) expect(content, id).not.toContain(`id="${storedId(id)}"`);
  });

  it('every printed command names a package.json script and only flags its USAGE accepts', () => {
    for (const command of Object.values(STORED)) {
      const m = /^npm run (\S+) -- (.*)$/.exec(command);
      expect(m, command).not.toBeNull();
      const flags = usageFlags(m![1]!);
      for (const flag of m![2]!.match(/--[a-z][a-z-]*/g) ?? []) expect(flags.has(flag), `${command}: ${flag}`).toBe(true);
    }
    expect(usageFlags('rag:relex').has('--dry-run')).toBe(true);
  });

  it('the stored lines carry their i18n keys and the English copy of section 12.2', () => {
    const content = box();
    const expected: Record<string, string> = {
      RAG_LEXICAL_DICTIONARY: `Stored documents: they match as before until you run ${STORED.RAG_LEXICAL_DICTIONARY}. Run it again after the dictionary changes.`,
      RAG_LEXICAL_STEM_IT: `Stored documents: rebuild their search text with ${STORED.RAG_LEXICAL_STEM_IT}.`,
      RAG_TABLE_LOOKUP: `Stored documents: their tables have no rows to look up until you run ${STORED.RAG_TABLE_LOOKUP}.`,
      RAG_DUP_CLUSTERS: `Stored documents: they are not grouped until you run ${STORED.RAG_DUP_CLUSTERS}.`,
      RAG_IDENTIFIER_INDEX: `Stored documents: they have no identifiers in the index until you run ${STORED.RAG_IDENTIFIER_INDEX}.`,
    };
    for (const [id, text] of Object.entries(expected)) {
      const line = element(content, `id="${storedId(id)}"`);
      expect(line, id).toContain(`data-rag-i18n="${id}.stored"`);
      expect(textOf(line), id).toBe(text);
    }
  });
});

describe('Phase 4.2 tuning box: pointer and combination notes in the markup', () => {
  it('the pointer row sits under the identifier index stored line, outside any label, before the identifier filter', () => {
    const content = box();
    const stored = content.indexOf(`id="${storedId('RAG_IDENTIFIER_INDEX')}"`);
    const button = content.indexOf('data-identifier-patterns-pointer>');
    const text = content.indexOf('data-identifier-patterns-pointer-text');
    const filter = content.indexOf('id="RAG_IDENTIFIER_FILTER"');
    expect(stored).toBeGreaterThan(-1);
    expect(text).toBeGreaterThan(stored);
    expect(button).toBeGreaterThan(text);
    expect(filter).toBeGreaterThan(button);
    const before = content.slice(0, button);
    expect(before.lastIndexOf('</label>')).toBeGreaterThan(before.lastIndexOf('<label'));
    const tag = /<button\b[^>]*data-identifier-patterns-pointer>/.exec(content)?.[0] ?? '';
    expect(attr(tag, 'type')).toBe('button');
    expect(attr(tag, 'class')?.split(/\s+/)).toEqual(expect.arrayContaining(['btn', 'btn-link', 'btn-xs', 'px-0']));
    expect(textOf(element(content, 'data-identifier-patterns-pointer>'))).toBe('Open identifier patterns');
    expect(textOf(element(content, 'data-identifier-patterns-pointer-text'))).toBe(
      'Patterns for your own identifier formats are under RAG administration, Identifier patterns.',
    );
    const row = /<div class="([^"]*)">\s*<span\b[^>]*data-identifier-patterns-pointer-text/.exec(content)?.[1] ?? '';
    expect(row.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'items-center', 'gap-x-2', 'pl-8']));
  });

  it('three notes, hidden, role status, warning icon hidden from assistive technology, sentence in base content', () => {
    const content = box();
    const notes = [...content.matchAll(/<p\b[^>]*data-rag-tuning-note="([^"]+)"[^>]*>/g)];
    expect(notes.map((m) => m[1])).toEqual(['note.needsV2', 'note.diversityNeedsClusters', 'note.filterNeedsIndex']);
    for (const m of notes) {
      const tag = m[0];
      expect(tag, m[1]).toMatch(/\shidden[\s>]/);
      expect(attr(tag, 'role'), m[1]).toBe('status');
      expect(attr(tag, 'class')?.split(/\s+/), m[1]).toEqual(expect.arrayContaining(['label-text-alt', 'flex', 'items-start', 'gap-1']));
      const note = element(content, `data-rag-tuning-note="${m[1]}"`);
      expect(note, m[1]).toMatch(/<i class="bi bi-exclamation-triangle text-warning[^"]*" aria-hidden="true"><\/i>/);
      expect(note, m[1]).not.toMatch(/<span class="[^"]*text-warning/);
      expect(note, m[1]).toContain('data-rag-tuning-note-text');
    }
  });

  it('notes sit where section 6.2 puts them', () => {
    const content = box();
    const pos = (needle: string) => content.indexOf(needle);
    expect(pos('data-rag-tuning-note="note.needsV2"')).toBeGreaterThan(pos('data-rag-i18n="intro"'));
    expect(pos('data-rag-tuning-note="note.needsV2"')).toBeLessThan(pos('id="RAG_LEXICAL_DICTIONARY"'));
    expect(pos('data-rag-tuning-note="note.diversityNeedsClusters"')).toBeGreaterThan(pos('id="rag-result-diversity-help"'));
    expect(pos('data-rag-tuning-note="note.diversityNeedsClusters"')).toBeLessThan(pos('id="RAG_IDENTIFIER_INDEX"'));
    expect(pos('data-rag-tuning-note="note.filterNeedsIndex"')).toBeGreaterThan(pos('id="rag-identifier-filter-help"'));
    expect(pos('data-rag-tuning-note="note.filterNeedsIndex"')).toBeLessThan(pos('id="RAG_ATTRIBUTE_FILTER"'));
    const filterNote = /<p\b[^>]*data-rag-tuning-note="note.filterNeedsIndex"[^>]*>/.exec(content)?.[0] ?? '';
    expect(attr(filterNote, 'class')?.split(/\s+/)).toContain('pl-8');
  });

  it('the script tag loads after the other rag-panels scripts, and the script never writes markup', () => {
    const tags = [...html.matchAll(/<script src="rag-panels\/([^"]+)"><\/script>/g)].map((m) => m[1]);
    expect(tags.filter((t) => t === 'retrieval-tuning-switches.js')).toHaveLength(1);
    expect(tags[tags.length - 1]).toBe('retrieval-tuning-switches.js');
    const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(source).not.toContain('innerHTML');
    expect(source).not.toContain('insertAdjacentHTML');
    expect(source).not.toMatch(/\bfetch\(|ragFetch\(/);
    for (const m of source.matchAll(/^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      expect(m[1], 'top-level prefix').toMatch(/^(RetrievalTuning|RETRIEVAL_TUNING_|retrievalTuning|bindRetrievalTuning)/);
    }
  });
});

type Values = Record<string, string | boolean>;
const require = createRequire(import.meta.url);

function loadModule(): {
  retrievalTuningWarnings: (values: Values) => string[];
  RETRIEVAL_TUNING_LABELS: Record<string, Record<string, string>>;
} {
  return require(path.resolve(SCRIPT_PATH));
}

const ALL_OFF: Values = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_DICTIONARY: false,
  RAG_LEXICAL_STEM_IT: false,
  RAG_VERSION_SCOPE: false,
  RAG_EMBED_VERSION_SCOPE: false,
  RAG_TABLE_LOOKUP: false,
  RAG_DUP_CLUSTERS: false,
  RAG_RESULT_DIVERSITY: 'off',
  RAG_IDENTIFIER_INDEX: false,
  RAG_IDENTIFIER_FILTER: false,
  RAG_ATTRIBUTE_FILTER: 'off',
};

describe('retrievalTuningWarnings (UI-SPEC 6.2 table)', () => {
  const warnings = (patch: Values) => loadModule().retrievalTuningWarnings({ ...ALL_OFF, ...patch });

  it('legacy with every switch off, and v2 with every switch off, show nothing', () => {
    expect(warnings({ RAG_PIPELINE: 'legacy' })).toEqual([]);
    expect(warnings({})).toEqual([]);
  });

  it('legacy with any one switch on shows needsV2; an empty pipeline counts as legacy', () => {
    for (const id of CHECKBOXES) expect(warnings({ RAG_PIPELINE: 'legacy', [id]: true })[0], id).toBe('note.needsV2');
    expect(warnings({ RAG_PIPELINE: 'legacy', RAG_RESULT_DIVERSITY: 'mmr', RAG_DUP_CLUSTERS: true })).toEqual(['note.needsV2']);
    expect(warnings({ RAG_PIPELINE: 'legacy', RAG_ATTRIBUTE_FILTER: 'soft' })).toEqual(['note.needsV2']);
    expect(warnings({ RAG_PIPELINE: '', RAG_TABLE_LOOKUP: true })).toEqual(['note.needsV2']);
    expect(warnings({ RAG_PIPELINE: 'v2', RAG_TABLE_LOOKUP: true })).toEqual([]);
  });

  it('collapse or mmr with duplicate clusters off shows diversityNeedsClusters', () => {
    expect(warnings({ RAG_RESULT_DIVERSITY: 'collapse' })).toEqual(['note.diversityNeedsClusters']);
    expect(warnings({ RAG_RESULT_DIVERSITY: 'mmr' })).toEqual(['note.diversityNeedsClusters']);
    expect(warnings({ RAG_RESULT_DIVERSITY: 'mmr', RAG_DUP_CLUSTERS: true })).toEqual([]);
    expect(warnings({ RAG_RESULT_DIVERSITY: 'off', RAG_DUP_CLUSTERS: false })).toEqual([]);
  });

  it('filter on with the index off shows filterNeedsIndex', () => {
    expect(warnings({ RAG_IDENTIFIER_FILTER: true })).toEqual(['note.filterNeedsIndex']);
    expect(warnings({ RAG_IDENTIFIER_FILTER: true, RAG_IDENTIFIER_INDEX: true })).toEqual([]);
    expect(warnings({ RAG_IDENTIFIER_INDEX: true })).toEqual([]);
  });

  it('keys come in on-screen order and combine', () => {
    expect(warnings({ RAG_PIPELINE: 'legacy', RAG_RESULT_DIVERSITY: 'collapse', RAG_IDENTIFIER_FILTER: true })).toEqual([
      'note.needsV2',
      'note.diversityNeedsClusters',
      'note.filterNeedsIndex',
    ]);
  });

  it('labels exist in en, zh and it for the notes and the pointer, and every section 12.2 key has zh and it', () => {
    const labels = loadModule().RETRIEVAL_TUNING_LABELS;
    for (const key of ['note.needsV2', 'note.diversityNeedsClusters', 'note.filterNeedsIndex', 'pointer.text', 'pointer.open']) {
      for (const locale of ['en', 'zh', 'it']) expect(labels[locale]?.[key], `${locale} ${key}`).toBeTruthy();
    }
    const keys = [...box().matchAll(/data-rag-i18n="([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((k) => !k.startsWith('RAG_LEXICAL_QUANTITY.') && !k.startsWith('RAG_ATTRIBUTE_FILTER.'));
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      for (const locale of ['zh', 'it']) expect(labels[locale]?.[key], `${locale} ${key}`).toBeTruthy();
    }
    expect(labels.en!['note.needsV2']).toBe(
      'These switches are read by the v2 pipeline only. Pipeline is set to legacy above, so they have no effect yet.',
    );
  });
});

interface Page {
  doc: FakeDocument;
  context: Record<string, unknown>;
  scrolls: unknown[];
  fetches: number;
  adminClicks: number;
  note(key: string): FakeElement;
  input(id: string): FakeElement;
}

function boxMarkup(): string {
  const start = html.indexOf('<div id="rag-tuning-switches"');
  return element(html.slice(start), 'id="rag-tuning-switches"');
}

function loadPage(options: { locale?: string; reduceMotion?: boolean; pipeline?: string } = {}): Page {
  const doc = new FakeDocument();
  doc.body.innerHTML = `
    <a class="menu-item" data-tab="rag-modes">RAG Modes</a>
    <a class="menu-item" data-tab="rag-modes">RAG Modes</a>
    <a class="menu-item" data-tab="rag-administration">RAG administration</a>
    <div id="rag-modes" class="tab-content active">
      <select id="RAG_PIPELINE" name="RAG_PIPELINE"><option value="legacy">legacy</option><option value="v2">v2</option></select>
      ${boxMarkup()}
    </div>
    <div id="rag-administration" class="tab-content">
      <section id="rag-administration-identifiers">
        <h3 id="rag-identifier-patterns-title" tabindex="-1" data-identifier-patterns-title>Identifier patterns</h3>
      </section>
    </div>`;
  const pipeline = doc.getElementById('RAG_PIPELINE')!;
  pipeline.value = options.pipeline ?? 'legacy';
  for (const el of doc.querySelectorAll('select')) if (el.id !== 'RAG_PIPELINE') el.value = 'off';
  const page: Page = {
    doc,
    context: {},
    scrolls: [],
    fetches: 0,
    adminClicks: 0,
    note: (key) => doc.querySelector(`[data-rag-tuning-note="${key}"]`)!,
    input: (id) => doc.getElementById(id)!,
  };
  const section = doc.getElementById('rag-administration-identifiers') as unknown as { scrollIntoView: (o: unknown) => void };
  section.scrollIntoView = (o: unknown) => {
    page.scrolls.push(o);
  };
  doc.querySelector('[data-tab="rag-administration"]')!.addEventListener('click', () => {
    page.adminClicks += 1;
  });
  const context: Record<string, unknown> = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: { language: options.locale ?? 'en-US' },
    matchMedia: (query: string) => ({ matches: Boolean(options.reduceMotion) && query.includes('reduce') }),
    fetch: () => {
      page.fetches += 1;
      return Promise.reject(new Error('no fetch'));
    },
    ragFetch: () => {
      page.fetches += 1;
      return Promise.reject(new Error('no fetch'));
    },
  };
  context.window = context;
  page.context = context;
  vm.createContext(context);
  new vm.Script(fs.readFileSync(SCRIPT_PATH, 'utf8'), { filename: SCRIPT_PATH }).runInContext(context);
  doc.dispatch('DOMContentLoaded');
  return page;
}

function shown(page: Page): string[] {
  return ['note.needsV2', 'note.diversityNeedsClusters', 'note.filterNeedsIndex'].filter((k) => !page.note(k).hidden);
}

describe('retrieval-tuning-switches.js in a page (UI-SPEC 6.2, finding 5)', () => {
  it('on DOMContentLoaded the notes match the loaded values', () => {
    expect(shown(loadPage())).toEqual([]);
    const page = loadPage();
    page.input('RAG_TABLE_LOOKUP').checked = true;
    page.doc.dispatch('DOMContentLoaded');
    expect(shown(page)).toEqual(['note.needsV2']);
  });

  it('values set without change are picked up when a RAG Modes tab is clicked, on every RAG Modes tab element', () => {
    const page = loadPage({ pipeline: 'v2' });
    page.input('RAG_IDENTIFIER_FILTER').checked = true;
    expect(shown(page)).toEqual([]);
    const tabs = page.doc.querySelectorAll('[data-tab="rag-modes"]');
    tabs[1]!.click();
    expect(shown(page)).toEqual(['note.filterNeedsIndex']);
    page.input('RAG_IDENTIFIER_INDEX').checked = true;
    tabs[0]!.click();
    expect(shown(page)).toEqual([]);
  });

  it('a change on any input it reads updates the notes; the notes never change a value', () => {
    const page = loadPage({ pipeline: 'v2' });
    const diversity = page.input('RAG_RESULT_DIVERSITY');
    diversity.value = 'collapse';
    diversity.dispatch('change');
    expect(shown(page)).toEqual(['note.diversityNeedsClusters']);
    const clusters = page.input('RAG_DUP_CLUSTERS');
    clusters.checked = true;
    clusters.dispatch('change');
    expect(shown(page)).toEqual([]);
    const pipeline = page.input('RAG_PIPELINE');
    pipeline.value = 'legacy';
    pipeline.dispatch('change');
    expect(shown(page)).toEqual(['note.needsV2']);
    expect(diversity.value).toBe('collapse');
    expect(clusters.checked).toBe(true);
    expect(pipeline.value).toBe('legacy');
  });

  it('binding twice adds no second listener', () => {
    const page = loadPage();
    page.doc.dispatch('DOMContentLoaded');
    page.doc.dispatch('DOMContentLoaded');
    for (const id of ['RAG_PIPELINE', 'RAG_TABLE_LOOKUP', 'RAG_RESULT_DIVERSITY']) {
      expect(page.input(id).listeners.get('change') ?? [], id).toHaveLength(1);
    }
    expect(page.doc.querySelectorAll('[data-tab="rag-modes"]')[0]!.listeners.get('click') ?? []).toHaveLength(1);
    expect(page.doc.querySelector('[data-identifier-patterns-pointer]')!.listeners.get('click') ?? []).toHaveLength(1);
  });

  it('the pointer opens RAG administration, scrolls without smooth motion under reduced motion and focuses the heading, with no request', () => {
    const page = loadPage({ reduceMotion: true });
    page.doc.querySelector('[data-identifier-patterns-pointer]')!.click();
    expect(page.adminClicks).toBe(1);
    expect(page.scrolls).toEqual([{ behavior: 'auto', block: 'start' }]);
    expect(page.doc.activeElement).toBe(page.doc.querySelector('[data-identifier-patterns-title]'));
    expect(page.fetches).toBe(0);
    const smooth = loadPage();
    smooth.doc.querySelector('[data-identifier-patterns-pointer]')!.click();
    expect(smooth.scrolls).toEqual([{ behavior: 'smooth', block: 'start' }]);
  });

  it('English keeps the static markup; zh localizes the notes, pointer and lines and keeps each command as code', () => {
    const en = loadPage();
    expect(en.note('note.filterNeedsIndex').textContent.trim()).toBe(
      'The identifier index is off, so the filter cannot run and retrieval stays unfiltered. Turn on Identifier index and run its command.',
    );
    const zh = loadPage({ locale: 'zh-CN' });
    expect(zh.note('note.needsV2').textContent).toContain('这些开关只在 v2 流程中生效');
    expect(zh.doc.querySelector('[data-identifier-patterns-pointer]')!.textContent).toBe('打开标识符模式');
    const stored = zh.doc.getElementById(storedId('RAG_LEXICAL_DICTIONARY'))!;
    expect(stored.textContent).toContain('已入库文档');
    const codes = stored.querySelectorAll('code');
    expect(codes).toHaveLength(1);
    expect(codes[0]!.textContent).toBe(STORED.RAG_LEXICAL_DICTIONARY);
    expect(codes[0]!.getAttribute('translate')).toBe('no');
    const intro = zh.doc.querySelector('[data-rag-i18n="intro"]')!;
    expect(intro.querySelectorAll('code').map((c) => c.textContent)).toEqual(['--dry-run', '<key>', 's:default', 'o:<组织 ID>']);
    const label = zh.doc.querySelector('[data-rag-i18n="RAG_IDENTIFIER_INDEX.label"]')!;
    expect(label.textContent).toBe('标识符索引');
    expect(zh.input('RAG_IDENTIFIER_INDEX').parentNode!.textContent).toContain('RAG_IDENTIFIER_INDEX');
    const quantity = zh.doc.querySelector('[data-rag-i18n="RAG_LEXICAL_QUANTITY.label"]')!;
    expect(quantity.textContent).toBe('Numbers with units as single search terms');
    expect(quantity.getAttribute('lang')).toBe('en');
    const it = loadPage({ locale: 'it-IT' });
    expect(it.note('note.diversityNeedsClusters').querySelectorAll('code').map((c) => c.textContent)).toEqual(['collapse', 'mmr']);
  });
});
