import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

const SELECTS = ['RAG_PIPELINE', 'RAG_RERANKER', 'RAG_REFUSAL_FLOOR', 'RAG_RERANK_TIER_CHAT', 'RAG_RERANK_TIER_VOICE', 'RAG_HNSW_ITERATIVE_SCAN'];
const TEXT_INPUTS = ['RAG_RERANK_VOYAGE_MODEL_BY_LANG', 'COHERE_API_KEY', 'COHERE_BASE_URL', 'RAG_RETRIEVAL_PARAMS_OVERRIDE'];
const NUMBER_INPUTS = ['RAG_CONTEXT_TOKEN_BUDGET', 'RAG_EXACT_SCAN_CUTOFF'];
const CHECKBOXES = ['RAG_LEXICAL_SEARCH', 'RAG_REFUSAL_THRESHOLD', 'RAG_CONTEXT_EDGE_ORDER', 'RAG_CONTEXT_COMPRESSION', 'RAG_PARENT_CHILD', 'RAG_LEXICAL_TRANSLATION'];

function openingTag(id: string): string {
  const matches = [...html.matchAll(new RegExp(`<(input|select)\\b[^>]*\\bid="${id}"[^>]*>`, 'g'))];
  expect(matches, `exactly one control with id ${id}`).toHaveLength(1);
  return matches[0]![0];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

describe('Phase 4 retrieval switches in the Config UI (web-design-guidelines, plan 04-02 controls)', () => {
  it('every control has a name and an accessible label', () => {
    for (const id of [...SELECTS, ...TEXT_INPUTS, ...NUMBER_INPUTS]) {
      expect(attr(openingTag(id), 'name'), id).toBe(id);
      expect(html, `label for ${id}`).toMatch(new RegExp(`<label\\b[^>]*\\bfor="${id}"`));
    }
    for (const id of CHECKBOXES) {
      const tag = openingTag(id);
      expect(attr(tag, 'name'), id).toBe(id);
      const before = html.slice(0, html.indexOf(tag));
      expect(before.lastIndexOf('<label'), `${id} sits inside its label`).toBeGreaterThan(before.lastIndexOf('</label>'));
    }
  });

  it('text, secret, URL and number fields opt out of autofill and spellcheck and use the right input type', () => {
    for (const id of [...TEXT_INPUTS, ...NUMBER_INPUTS]) expect(attr(openingTag(id), 'autocomplete'), id).toBe('off');
    for (const id of TEXT_INPUTS) expect(attr(openingTag(id), 'spellcheck'), id).toBe('false');
    for (const id of NUMBER_INPUTS) expect(attr(openingTag(id), 'inputmode'), id).toBe('numeric');
    expect(attr(openingTag('COHERE_BASE_URL'), 'type')).toBe('url');
    expect(attr(openingTag('COHERE_API_KEY'), 'type')).toBe('password');
  });

  it('example placeholders end with an ellipsis', () => {
    for (const id of ['RAG_RERANK_VOYAGE_MODEL_BY_LANG', 'RAG_RETRIEVAL_PARAMS_OVERRIDE', 'COHERE_API_KEY']) {
      expect(attr(openingTag(id), 'placeholder'), id).toMatch(/…$/);
    }
  });

  it('the Cohere key reveal button is a named, non-submitting button', () => {
    const button = /<button\b[^>]*data-for="COHERE_API_KEY"[^>]*>/.exec(html)?.[0] ?? '';
    expect(attr(button, 'type')).toBe('button');
    expect(attr(button, 'aria-label')).toMatch(/Cohere API key/);
  });

  it('help text is tied to its control and code tokens are not machine-translated', () => {
    for (const id of ['RAG_PIPELINE', 'RAG_RERANK_VOYAGE_MODEL_BY_LANG', 'RAG_REFUSAL_FLOOR']) {
      const describedBy = attr(openingTag(id), 'aria-describedby');
      expect(describedBy, id).toBeTruthy();
      expect(html).toContain(`id="${describedBy}"`);
    }
    for (const id of SELECTS) expect(attr(openingTag(id), 'translate'), id).toBe('no');
    const legacyNotes = [...html.matchAll(/\(legacy, not read by (<span translate="no">)?RAG_PIPELINE=v2/g)];
    expect(legacyNotes.length).toBeGreaterThanOrEqual(4);
    for (const note of legacyNotes) expect(note[1], note[0]).toBeDefined();
    expect(html).toMatch(/Lexical search leg \(<span translate="no">RAG_LEXICAL_SEARCH<\/span>\)/);
  });

  it('the reranker offers auto and the refusal floor offers similarity and legacy_rule, with today\'s defaults selected', () => {
    const options = (id: string) => {
      const block = new RegExp(`<select\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? '';
      return [...block.matchAll(/<option value="([^"]*)"( selected)?>/g)].map((m) => ({ value: m[1], selected: Boolean(m[2]) }));
    };
    const reranker = options('RAG_RERANKER');
    expect(reranker.map((o) => o.value)).toEqual(['none', 'auto', 'cohere', 'voyage', 'local_bm25']);
    expect(reranker.filter((o) => o.selected).map((o) => o.value)).toEqual(['none']);
    const floor = options('RAG_REFUSAL_FLOOR');
    expect(floor.map((o) => o.value)).toEqual(['similarity', 'legacy_rule']);
    expect(floor.filter((o) => o.selected).map((o) => o.value)).toEqual(['similarity']);
  });

  it('the switch group heading wraps evenly', () => {
    expect(html).toMatch(/<h4 class="[^"]*\btext-balance\b[^"]*">Phase 4 retrieval switches/);
  });
});
