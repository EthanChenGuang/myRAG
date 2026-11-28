import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');
const server = fs.readFileSync('scripts/config-server.js', 'utf8');
const initEnv = fs.readFileSync('scripts/init-env.js', 'utf8');
const envTs = fs.readFileSync('src/lib/env.ts', 'utf8');
const manifest: unknown = JSON.parse(fs.readFileSync('scripts/rag/env-manifest.json', 'utf8'));
const classification: unknown = JSON.parse(fs.readFileSync('config/rag/settings-classification.json', 'utf8'));
const evalEnv = JSON.parse(fs.readFileSync('eval/config/rag-eval-env.json', 'utf8')) as Record<string, string>;

const DEFAULTS = { RAG_LEXICAL_SCORING: 'ts_rank_cd', RAG_LEXICAL_BM25_K1: '1.2', RAG_LEXICAL_BM25_B: '0.75' } as const;
const NAMES = Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[];
const ANCHOR = 'RAG_LEXICAL_STEM_IT';

function entries<T extends { name: string }>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      if (Array.isArray(child) && child.some((item) => item && typeof item === 'object' && 'name' in item)) return child as T[];
    }
  }
  return [];
}

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

function phase4Box(): string {
  const heading = html.indexOf('Phase 4 retrieval switches (off = current behaviour)');
  expect(heading).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div', heading);
  const end = html.indexOf('id="rag-tuning-switches"', heading);
  return html.slice(start, end);
}

describe('Phase 4.4 lexical scoring variables in every config location (04.4-01, D-05, D-07)', () => {
  it('init-env.js writes each default next to the stemming switch', () => {
    for (const name of NAMES) expect(initEnv, name).toMatch(new RegExp(`^${name}=${DEFAULTS[name].replace('.', '\\.')}$`, 'm'));
  });

  it('every config-server.js template that lists the stemming switch lists the three variables with their defaults', () => {
    const anchors = [...server.matchAll(new RegExp(`${ANCHOR}=`, 'g'))].length;
    expect(anchors).toBeGreaterThanOrEqual(3);
    for (const name of NAMES) {
      expect([...server.matchAll(new RegExp(`${name}=`, 'g'))].length, name).toBe(anchors);
      expect(server, name).toContain(`'${name}=${DEFAULTS[name]}'`);
      expect(server, name).toContain(`${name}=\${getEnvValue('${name}') || '${DEFAULTS[name]}'}`);
    }
  });

  it('env.ts reads each variable with its default', () => {
    for (const name of NAMES) expect(envTs, name).toContain(`${name}: process.env.${name} || '${DEFAULTS[name]}'`);
  });

  it('the env manifest manages each variable', () => {
    const rows = entries<{ name: string; status: string }>(manifest);
    for (const name of NAMES) expect(rows.find((row) => row.name === name)?.status, name).toBe('managed');
  });

  it('each variable is query-side with no rebuild mechanism', () => {
    const rows = entries<{ name: string; side: string; mechanism?: string }>(classification);
    for (const name of NAMES) {
      const row = rows.find((item) => item.name === name);
      expect(row?.side, name).toBe('query');
      expect(row?.mechanism, name).toBeUndefined();
    }
  });

  it('the eval env pins the defaults', () => {
    for (const name of NAMES) expect(evalEnv[name], name).toBe(DEFAULTS[name]);
  });
});

describe('Phase 4.4 lexical scoring controls in the Config UI (04.4-01, D-39)', () => {
  it('the three controls sit in the Phase 4 box after the lexical search switch and before the reranker', () => {
    const content = phase4Box();
    const lexical = content.indexOf('id="RAG_LEXICAL_SEARCH"');
    const positions = NAMES.map((name) => content.indexOf(`id="${name}"`));
    const reranker = content.indexOf('id="RAG_RERANKER"');
    expect(lexical).toBeGreaterThan(-1);
    for (const [i, name] of NAMES.entries()) expect(positions[i], name).toBeGreaterThan(lexical);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(reranker).toBeGreaterThan(positions[positions.length - 1]!);
  });

  it('the scoring select offers ts_rank_cd and bm25 with ts_rank_cd selected', () => {
    const tag = openingTag('RAG_LEXICAL_SCORING');
    expect(attr(tag, 'name')).toBe('RAG_LEXICAL_SCORING');
    expect(attr(tag, 'translate')).toBe('no');
    expect(html).toMatch(/<label\b[^>]*\bfor="RAG_LEXICAL_SCORING"/);
    const block = /<select\b[^>]*\bid="RAG_LEXICAL_SCORING"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
    const options = [...block.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)];
    expect(options.map((m) => m[1])).toEqual(['ts_rank_cd', 'bm25']);
    expect(options.filter((m) => m[2]).map((m) => m[1])).toEqual(['ts_rank_cd']);
  });

  it.each([
    ['RAG_LEXICAL_BM25_K1', '0.5', '3', '1.2…'],
    ['RAG_LEXICAL_BM25_B', '0', '1', '0.75…'],
  ])('%s is a bounded number input', (name, min, max, placeholder) => {
    const tag = openingTag(name);
    expect(attr(tag, 'type')).toBe('number');
    expect(attr(tag, 'name')).toBe(name);
    expect(attr(tag, 'min')).toBe(min);
    expect(attr(tag, 'max')).toBe(max);
    expect(attr(tag, 'step')).toBe('0.05');
    expect(attr(tag, 'placeholder')).toBe(placeholder);
    expect(attr(tag, 'inputmode')).toBe('decimal');
    expect(html).toMatch(new RegExp(`<label\\b[^>]*\\bfor="${name}"`));
  });

  it('every control has one help line through aria-describedby, with i18n keys and the variable untranslated', () => {
    for (const name of NAMES) {
      const describedBy = attr(openingTag(name), 'aria-describedby');
      expect(describedBy, name).toBe(helpId(name));
      expect([...html.matchAll(new RegExp(`id="${helpId(name)}"`, 'g'))], name).toHaveLength(1);
      expect(html, name).toContain(`data-rag-i18n="${name}.label"`);
      expect(html, name).toContain(`data-rag-i18n="${name}.help"`);
      expect(html, name).toContain(`<span translate="no">${name}</span>`);
    }
  });

  it('the help text names the statistics command and the two parameters', () => {
    const help = (name: string) => new RegExp(`<p\\b[^>]*\\bid="${helpId(name)}"[^>]*>([\\s\\S]*?)</p>`).exec(html)?.[1] ?? '';
    expect(help('RAG_LEXICAL_SCORING')).toContain('npm run rag:lexstats');
    expect(help('RAG_LEXICAL_SCORING')).toContain('RAG_LEXICAL_SEARCH');
    expect(help('RAG_LEXICAL_BM25_K1').toLowerCase()).toContain('term-frequency saturation');
    expect(help('RAG_LEXICAL_BM25_B').toLowerCase()).toContain('length normalisation');
  });
});

const NOTE_ID = 'rag-lexical-scoring-needs-lexical';
const PARAMS = ['RAG_LEXICAL_BM25_K1', 'RAG_LEXICAL_BM25_B'] as const;

interface StubControl {
  id: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
}

function stubControl(id: string, init: Partial<Pick<StubControl, 'value' | 'checked' | 'hidden'>> = {}): StubControl {
  const attributes = new Map<string, string>();
  return {
    id,
    value: init.value ?? '',
    checked: init.checked ?? false,
    disabled: false,
    hidden: init.hidden ?? true,
    attributes,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name)! : null;
    },
  };
}

function lexicalScoringMethod(): (this: unknown) => void {
  const signature = 'updateLexicalScoringControls() {';
  const start = html.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  let depth = 0;
  let end = start + signature.length - 1;
  for (; end < html.length; end += 1) {
    if (html[end] === '{') depth += 1;
    if (html[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = html.slice(start + signature.length, end);
  return new Function('document', `return function () {${body}};`) as never;
}

function runWiring(state: { mode: string; lexical: boolean; k1?: string; b?: string }) {
  const controls = new Map<string, StubControl>([
    ['RAG_LEXICAL_SCORING', stubControl('RAG_LEXICAL_SCORING', { value: state.mode })],
    ['RAG_LEXICAL_SEARCH', stubControl('RAG_LEXICAL_SEARCH', { checked: state.lexical })],
    ['RAG_LEXICAL_BM25_K1', stubControl('RAG_LEXICAL_BM25_K1', { value: state.k1 ?? '1.4' })],
    ['RAG_LEXICAL_BM25_B', stubControl('RAG_LEXICAL_BM25_B', { value: state.b ?? '0.6' })],
    [NOTE_ID, stubControl(NOTE_ID, { hidden: true })],
  ]);
  const doc = { getElementById: (id: string) => controls.get(id) ?? null };
  const factory = lexicalScoringMethod() as unknown as (d: typeof doc) => () => void;
  factory(doc).call({});
  return controls;
}

describe('Phase 4.4 lexical scoring dependency wiring in the Config UI (04.4-06, D-39)', () => {
  it('ts_rank_cd disables both parameters with aria-disabled and keeps their values', () => {
    const controls = runWiring({ mode: 'ts_rank_cd', lexical: true, k1: '1.4', b: '0.6' });
    for (const name of PARAMS) {
      expect(controls.get(name)!.disabled, name).toBe(true);
      expect(controls.get(name)!.getAttribute('aria-disabled'), name).toBe('true');
    }
    expect(controls.get('RAG_LEXICAL_BM25_K1')!.value).toBe('1.4');
    expect(controls.get('RAG_LEXICAL_BM25_B')!.value).toBe('0.6');
  });

  it('bm25 enables both parameters and removes aria-disabled', () => {
    const controls = runWiring({ mode: 'bm25', lexical: true });
    for (const name of PARAMS) {
      expect(controls.get(name)!.disabled, name).toBe(false);
      expect(controls.get(name)!.getAttribute('aria-disabled'), name).toBeNull();
    }
    expect(controls.get(NOTE_ID)!.hidden).toBe(true);
  });

  it('bm25 with lexical search off shows the dependency note and leaves the select editable', () => {
    const controls = runWiring({ mode: 'bm25', lexical: false });
    expect(controls.get(NOTE_ID)!.hidden).toBe(false);
    expect(controls.get('RAG_LEXICAL_SCORING')!.disabled).toBe(false);
    expect(controls.get('RAG_LEXICAL_SCORING')!.getAttribute('aria-describedby')).toBe(`rag-lexical-scoring-help ${NOTE_ID}`);
  });

  it('ts_rank_cd with lexical search off shows no note, since nothing is ignored', () => {
    const controls = runWiring({ mode: 'ts_rank_cd', lexical: false });
    expect(controls.get(NOTE_ID)!.hidden).toBe(true);
    expect(controls.get('RAG_LEXICAL_SCORING')!.getAttribute('aria-describedby')).toBe('rag-lexical-scoring-help');
  });

  it('the wiring runs after the fields are populated and on change of the select and the lexical switch', () => {
    const populate = /populateFields\(\) \{([\s\S]*?)\n {12}\}/.exec(html)?.[1] ?? '';
    expect(populate).toContain('this.updateLexicalScoringControls()');
    for (const id of ['RAG_LEXICAL_SCORING', 'RAG_LEXICAL_SEARCH']) {
      expect(html, id).toMatch(new RegExp(`\\['RAG_LEXICAL_SCORING', 'RAG_LEXICAL_SEARCH'\\]|getElementById\\('${id}'\\)[\\s\\S]{0,120}addEventListener\\('change'`));
    }
  });

  it('the dependency note is a hidden status line, linked from the select, with i18n and neutral copy', () => {
    const note = new RegExp(`<p\\b([^>]*)\\bid="${NOTE_ID}"([^>]*)>([\\s\\S]*?)</p>`).exec(html);
    expect(note, NOTE_ID).not.toBeNull();
    const attrs = `${note![1]}${note![2]}`;
    expect(attrs).toContain('role="status"');
    expect(attrs).toMatch(/\shidden(\s|$)/);
    expect(attrs).toContain('data-rag-i18n="RAG_LEXICAL_SCORING.needsLexical"');
    expect(attrs).not.toMatch(/\bflex\b/);
    expect(note![3]).toContain('RAG_LEXICAL_SEARCH');
    expect(attr(openingTag('RAG_LEXICAL_SCORING'), 'autocomplete')).toBe('off');
  });

  it('the help and note copy contains no example-domain words', () => {
    const domainWords = /travel|lodging|hotel|leave days|salar|restaurant|\bfaq\b|vpn|password|branch|reimburs|expense|vacation/i;
    const ids = [...NAMES.map(helpId), NOTE_ID];
    for (const id of ids) {
      const text = new RegExp(`<p\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</p>`).exec(html)?.[1] ?? '';
      expect(text, id).not.toBe('');
      expect(text, id).not.toMatch(domainWords);
    }
  });
});

describe('Phase 4.4 BM25 document frequency mode in every config location (04.4-16, D-44)', () => {
  const NAME = 'RAG_LEXICAL_DF_MODE';

  it('the five locations, the manifest, the classification and the eval pin carry it with default raw', () => {
    expect(initEnv).toMatch(/^RAG_LEXICAL_DF_MODE=raw$/m);
    expect(server).toContain(`'${NAME}=raw'`);
    expect(server).toContain(`${NAME}=\${getEnvValue('${NAME}') || 'raw'}`);
    expect([...server.matchAll(new RegExp(`${NAME}=`, 'g'))].length).toBe([...server.matchAll(/RAG_LEXICAL_STEM_IT=/g)].length);
    expect(envTs).toContain(`${NAME}: process.env.${NAME} || 'raw'`);
    const row = entries<{ name: string; status: string; default?: string; options?: string[] }>(manifest).find((item) => item.name === NAME);
    expect(row?.status).toBe('managed');
    expect(row?.default).toBe('raw');
    expect(row?.options).toEqual(['raw', 'cluster']);
    const side = entries<{ name: string; side: string; mechanism?: string }>(classification).find((item) => item.name === NAME);
    expect(side?.side).toBe('query');
    expect(side?.mechanism).toBeUndefined();
    expect(evalEnv[NAME]).toBe('raw');
  });

  it('the select sits after the BM25 parameters and before the reranker, offers raw and cluster with raw selected', () => {
    const content = phase4Box();
    const b = content.indexOf('id="RAG_LEXICAL_BM25_B"');
    const df = content.indexOf(`id="${NAME}"`);
    expect(df).toBeGreaterThan(b);
    expect(content.indexOf('id="RAG_RERANKER"')).toBeGreaterThan(df);
    const tag = openingTag(NAME);
    expect(attr(tag, 'name')).toBe(NAME);
    expect(attr(tag, 'translate')).toBe('no');
    expect(attr(tag, 'aria-describedby')).toBe(helpId(NAME));
    const block = new RegExp(`<select\\b[^>]*\\bid="${NAME}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? '';
    const options = [...block.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)];
    expect(options.map((m) => m[1])).toEqual(['raw', 'cluster']);
    expect(options.filter((m) => m[2]).map((m) => m[1])).toEqual(['raw']);
    expect(html).toContain(`data-rag-i18n="${NAME}.label"`);
    expect(html).toContain(`data-rag-i18n="${NAME}.help"`);
    const help = new RegExp(`<p\\b[^>]*\\bid="${helpId(NAME)}"[^>]*>([\\s\\S]*?)</p>`).exec(html)?.[1] ?? '';
    expect(help).toContain('Counts a duplicate cluster once in BM25 document frequency.');
    expect(help).toContain('RAG_DUP_CLUSTERS');
  });

  it('a status note says cluster has no effect while bm25 is chosen and duplicate clusters are off; it is described only while shown', () => {
    expect(html).toMatch(/<p\b[^>]*\bid="rag-lexical-df-mode-needs-dup-clusters"[^>]*\brole="status"[^>]*\bhidden>/);
    expect(html).toContain('data-rag-i18n="RAG_LEXICAL_DF_MODE.needsDupClusters"');
    expect(html).toMatch(/\['RAG_LEXICAL_DF_MODE', 'RAG_DUP_CLUSTERS'\]\) \{\s*const field = document\.getElementById\(id\);\s*if \(field\) field\.addEventListener\('change'/);
    const method = lexicalScoringMethod();
    const cases: Array<[string, string, boolean, boolean]> = [
      ['bm25', 'cluster', false, true],
      ['bm25', 'cluster', true, false],
      ['bm25', 'raw', false, false],
      ['ts_rank_cd', 'cluster', false, false],
    ];
    for (const [mode, df, dup, shown] of cases) {
      const select = stubControl(NAME, { value: df });
      const note = stubControl('rag-lexical-df-mode-needs-dup-clusters', { hidden: true });
      const controls = new Map<string, StubControl>([
        ['RAG_LEXICAL_SCORING', stubControl('RAG_LEXICAL_SCORING', { value: mode })],
        ['RAG_LEXICAL_SEARCH', stubControl('RAG_LEXICAL_SEARCH', { checked: true })],
        ['RAG_DUP_CLUSTERS', stubControl('RAG_DUP_CLUSTERS', { checked: dup })],
        [NAME, select],
        [note.id, note],
      ]);
      (method as unknown as (d: unknown) => () => void)({ getElementById: (id: string) => controls.get(id) ?? null }).call({});
      const label = `${mode}/${df}/dup=${dup}`;
      expect(note.hidden, label).toBe(!shown);
      expect(select.getAttribute('aria-describedby'), label).toBe(shown ? `${helpId(NAME)} ${note.id}` : helpId(NAME));
    }
  });

  it('the select is disabled while the scoring is not bm25, like k1 and b', () => {
    const method = lexicalScoringMethod();
    for (const mode of ['ts_rank_cd', 'bm25']) {
      const select = stubControl(NAME, { value: 'raw' });
      const controls = new Map<string, StubControl>([
        ['RAG_LEXICAL_SCORING', stubControl('RAG_LEXICAL_SCORING', { value: mode })],
        ['RAG_LEXICAL_SEARCH', stubControl('RAG_LEXICAL_SEARCH', { checked: true })],
        [NAME, select],
      ]);
      const doc = { getElementById: (id: string) => controls.get(id) ?? null };
      (method as unknown as (d: unknown) => () => void)(doc).call({});
      expect(select.disabled, mode).toBe(mode !== 'bm25');
      expect(select.getAttribute('aria-disabled'), mode).toBe(mode === 'bm25' ? null : 'true');
    }
  });
});

describe('Phase 4.4 local reranker statistics in every config location (04.4-20, D-54)', () => {
  const NAME = 'RAG_RERANK_LOCAL_STATS';

  it('the five locations, the manifest, the classification and the eval pin carry it with default pool', () => {
    expect(initEnv).toMatch(/^RAG_RERANK_LOCAL_STATS=pool$/m);
    expect(server).toContain(`'${NAME}=pool'`);
    expect(server).toContain(`${NAME}=\${getEnvValue('${NAME}') || 'pool'}`);
    expect([...server.matchAll(new RegExp(`${NAME}=`, 'g'))].length).toBe([...server.matchAll(/RAG_LEXICAL_STEM_IT=/g)].length);
    expect(envTs).toContain(`${NAME}: process.env.${NAME} || 'pool'`);
    const row = entries<{ name: string; status: string; default?: string; options?: string[] }>(manifest).find((item) => item.name === NAME);
    expect(row?.status).toBe('managed');
    expect(row?.default).toBe('pool');
    expect(row?.options).toEqual(['pool', 'tenant']);
    const side = entries<{ name: string; side: string; mechanism?: string }>(classification).find((item) => item.name === NAME);
    expect(side?.side).toBe('query');
    expect(side?.mechanism).toBeUndefined();
    expect(evalEnv[NAME]).toBe('pool');
  });

  it('the select sits after the lexical scoring controls and before the reranker, offers pool and tenant with pool selected', () => {
    const content = phase4Box();
    const df = content.indexOf('id="RAG_LEXICAL_DF_MODE"');
    const stats = content.indexOf(`id="${NAME}"`);
    expect(stats).toBeGreaterThan(df);
    expect(content.indexOf('id="RAG_RERANKER"')).toBeGreaterThan(stats);
    const tag = openingTag(NAME);
    expect(attr(tag, 'name')).toBe(NAME);
    expect(attr(tag, 'translate')).toBe('no');
    expect(attr(tag, 'aria-describedby')).toBe(helpId(NAME));
    const block = new RegExp(`<select\\b[^>]*\\bid="${NAME}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? '';
    const options = [...block.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)];
    expect(options.map((m) => m[1])).toEqual(['pool', 'tenant']);
    expect(options.filter((m) => m[2]).map((m) => m[1])).toEqual(['pool']);
    expect(html).toContain(`<label class="label" for="${NAME}">`);
    expect(html).toContain(`data-rag-i18n="${NAME}.label"`);
    expect(html).toContain(`data-rag-i18n="${NAME}.help"`);
    const help = new RegExp(`<p\\b[^>]*\\bid="${helpId(NAME)}"[^>]*>([\\s\\S]*?)</p>`).exec(html)?.[1] ?? '';
    expect(help).toContain('npm run rag:lexstats -- enable');
    expect(help).toContain('tenants without ready statistics keep pool statistics');
    expect(help).toContain('RAG_PIPELINE=v2');
    expect(help).not.toMatch(/travel|lodging|hotel|leave days|salar|restaurant|\bfaq\b|vpn|password|branch|reimburs|expense|vacation/i);
  });

  it('the control is not tied to the bm25 scoring mode (it applies to the local reranker under either lexical scoring)', () => {
    expect(String(lexicalScoringMethod())).toContain('RAG_LEXICAL_DF_MODE');
    expect(String(lexicalScoringMethod())).not.toContain(NAME);
  });
});
