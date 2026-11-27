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
    ['RAG_LEXICAL_BM25_K1', '0.5', '3', '1.2'],
    ['RAG_LEXICAL_BM25_B', '0', '1', '0.75'],
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
      expect([...html.matchAll(new RegExp(`id="${describedBy}"`, 'g'))], describedBy).toHaveLength(1);
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
