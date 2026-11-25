import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, XSS_PAYLOAD, injectedElements } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const uiSource = fs.readFileSync(path.join(repoRoot, 'scripts/config-ui/rag-panels/rag-ui.js'), 'utf8');

type Locale = 'en' | 'zh' | 'it';

function loadUi() {
  return require('../../scripts/config-ui/rag-panels/rag-ui.js') as Record<string, any> & {
    RAG_UI_LABELS: Record<Locale, Record<string, string>>;
  };
}

describe('rag-ui.js label table and names (UI-SPEC 6.1, 12.8)', () => {
  it('RAG_UI_LABELS has the same non-empty keys in en, zh and it', () => {
    const { RAG_UI_LABELS } = loadUi();
    const en = Object.keys(RAG_UI_LABELS.en).sort();
    expect(en.length).toBeGreaterThan(0);
    for (const loc of ['zh', 'it'] as const) {
      expect(Object.keys(RAG_UI_LABELS[loc]).sort()).toEqual(en);
      for (const key of en) expect(RAG_UI_LABELS[loc][key]!.length, `${loc} ${key}`).toBeGreaterThan(0);
    }
    expect(RAG_UI_LABELS.en['action.reload']).toBe('Reload panel');
    expect(RAG_UI_LABELS.zh['error.changed']).toBe('此项已被其他人更改。列表已重新加载。');
  });

  it('every top-level name carries the ragUi / RAG_UI_ prefix', () => {
    const names = [...uiSource.matchAll(/^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(3);
    for (const name of names) expect(name, name).toMatch(/^(ragUi|RagUi|RAG_UI_)/);
  });

  it('resolves the locale from navigator.language: zh, it, otherwise en', () => {
    const { ragUiResolveLocale } = loadUi();
    expect(ragUiResolveLocale('zh-CN')).toBe('zh');
    expect(ragUiResolveLocale('it-IT')).toBe('it');
    expect(ragUiResolveLocale('fr-FR')).toBe('en');
    expect(ragUiResolveLocale(undefined)).toBe('en');
  });

  it('ragUiEl sets text with textContent; injected markup creates no element', () => {
    const { ragUiEl } = loadUi();
    const doc = new FakeDocument();
    const el = ragUiEl(doc, 'p', { className: 'text-sm', text: XSS_PAYLOAD, attrs: { 'data-x': XSS_PAYLOAD } }) as FakeElement;
    doc.body.appendChild(el);
    expect(el.textContent).toBe(XSS_PAYLOAD);
    expect(injectedElements(doc)).toEqual([]);
    expect(doc.innerHtmlWrites).toBe(0);
  });

  it('ragUiEl refuses inline handler and link attributes', () => {
    const { ragUiEl } = loadUi();
    const doc = new FakeDocument();
    expect(() => ragUiEl(doc, 'span', { attrs: { onclick: 'x' } })).toThrow();
    expect(() => ragUiEl(doc, 'span', { attrs: { href: 'javascript:alert(1)' } })).toThrow();
  });

  it('never uses innerHTML or browser storage', () => {
    expect(uiSource).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
    expect(uiSource).not.toMatch(/Storage|document\.cookie|Authorization/);
  });
});
