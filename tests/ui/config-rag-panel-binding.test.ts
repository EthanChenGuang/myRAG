import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);
const panelDir = path.resolve(import.meta.dirname, '../../scripts/config-ui/rag-panels');

const PANELS = [
  { file: 'ingestion.js', rootId: 'rag-administration-ingestion', instance: 'ingestionPanel' },
  { file: 'doc-types.js', rootId: 'rag-administration-doc-types', instance: 'docTypesPanel' },
  { file: 'embedding-profiles.js', rootId: 'rag-administration-profiles', instance: 'embeddingProfilesPanel' },
  { file: 'embedding-bindings.js', rootId: 'rag-administration-bindings', instance: 'embeddingBindingsPanel' },
] as const;

function addLink(doc: FakeDocument, label: string): FakeElement {
  const li = doc.createElement('li');
  const link = doc.createElement('a');
  link.className = 'menu-item';
  link.setAttribute('data-tab', 'rag-administration');
  link.setAttribute('data-test-link', label);
  link.textContent = 'RAG administration';
  li.appendChild(link);
  doc.body.appendChild(li);
  return link;
}

/** Runs a panel script the way index.html does: in <head>, before the menu links exist. */
function loadInHead(file: string, rootId: string) {
  const doc = new FakeDocument();
  const root = doc.createElement('section');
  root.id = rootId;
  const context: Record<string, unknown> = {
    document: doc,
    console,
    navigator: { language: 'en-US' },
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { origin: 'http://config.local', search: '' },
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    ragFetch: async () => ({ ok: true, status: 200, body: { items: [], profiles: [], tenants: [] } }),
  };
  context.window = context;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(panelDir, file), 'utf8');
  new vm.Script(code, { filename: file }).runInContext(context);
  return { doc, root, context };
}

describe.each(PANELS)('$file starts from every RAG administration link', ({ file, rootId, instance }) => {
  it('binds at DOMContentLoaded, so the desktop and the mobile drawer link both start the panel', () => {
    for (const which of ['desktop', 'mobile'] as const) {
      const { doc, root, context } = loadInHead(file, rootId);
      const desktop = addLink(doc, 'desktop');
      const mobile = addLink(doc, 'mobile');
      doc.body.appendChild(root);
      doc.dispatch('DOMContentLoaded');
      expect(context[instance]).toBeUndefined();
      (which === 'desktop' ? desktop : mobile).click();
      expect(context[instance], `${which} link`).toBeTruthy();
    }
  });

  it('binds each link once even if DOMContentLoaded handlers run again', () => {
    const { doc, root } = loadInHead(file, rootId);
    const desktop = addLink(doc, 'desktop');
    addLink(doc, 'mobile');
    doc.body.appendChild(root);
    doc.dispatch('DOMContentLoaded');
    doc.dispatch('DOMContentLoaded');
    expect(desktop.listeners.get('click')?.length ?? 0).toBeLessThanOrEqual(1);
  });
});

describe('ingestion sign-in message names the real app URL', () => {
  const { mapIngestionError } = require('../../scripts/config-ui/rag-panels/ingestion.js') as {
    mapIngestionError: (result: Record<string, unknown>, locale: 'en' | 'zh' | 'it', context?: unknown) => { key: string; message: string };
  };

  it.each(['en', 'zh', 'it'] as const)('fills {appUrl} for 401 in %s', (locale) => {
    const mapped = mapIngestionError({ ok: false, status: 401, body: {} }, locale, 'jobs');
    expect(mapped.key).toBe('error.signIn');
    expect(mapped.message).not.toContain('{appUrl}');
    expect(mapped.message).toContain('http://localhost:3000');
  });

  it('uses the configured app URL in the browser, as the chunking and refusal panels do', () => {
    const { context } = loadInHead('ingestion.js', 'rag-administration-ingestion');
    context.getConfiguredMyRAGAppUrl = () => 'https://app.example.test';
    context.ingestLabel = (_key: string, _locale: string, vars?: Record<string, string>) =>
      `Sign in at ${vars && vars.appUrl}`;
    const map = context.mapIngestionError as typeof mapIngestionError;
    const mapped = map({ ok: false, status: 403, body: { error: 'Admin access required' } }, 'en', 'jobs');
    expect(mapped.message).toBe('Sign in at https://app.example.test');
  });
});
