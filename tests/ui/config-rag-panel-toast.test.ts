import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, functionSource } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);
const configUiDir = path.resolve(__dirname, '../../scripts/config-ui');
const panelDir = path.join(configUiDir, 'rag-panels');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');

const PANELS = [
  'chunking-profiles',
  'doc-types',
  'embedding-bindings',
  'embedding-profiles',
  'identifier-patterns',
  'monitor',
  'question-sources',
  'refusal-calibration',
  'setting-check',
];

type SetStatus = (host: unknown, render: () => void, isError?: boolean, options?: { toast?: boolean }) => void;

function loadHelper(): { ragPanelSetStatus: SetStatus } {
  const file = path.join(panelDir, 'panel-status.js');
  expect(fs.existsSync(file)).toBe(true);
  return fs.existsSync(file) ? (require(file) as { ragPanelSetStatus: SetStatus }) : { ragPanelSetStatus: () => {} };
}

function withToastSpy<T>(fn: (calls: unknown[][]) => T): T {
  const calls: unknown[][] = [];
  const g = globalThis as Record<string, unknown>;
  const before = g.showToast;
  g.showToast = (...args: unknown[]) => calls.push(args);
  try {
    return fn(calls);
  } finally {
    if (before === undefined) delete g.showToast;
    else g.showToast = before;
  }
}

function hostWith(doc: FakeDocument, text: string, isError: boolean): { host: FakeElement; render: () => void } {
  const host = doc.createElement('div');
  host.setAttribute('role', 'status');
  const render = () => {
    host.replaceChildren(doc.createTextNode(text));
    host.classList.toggle('text-error', isError);
  };
  return { host, render };
}

describe('ragPanelSetStatus (UI-SPEC amendment 261127-tfs)', () => {
  it('a completed action shows the same sentence in the status region and in an aria-hidden success toast', () => {
    const { ragPanelSetStatus } = loadHelper();
    const doc = new FakeDocument();
    const { host, render } = hostWith(doc, 'Item one disabled.', false);
    const calls = withToastSpy((c) => {
      ragPanelSetStatus(host, render, false, { toast: true });
      return c;
    });
    expect(host.textContent).toBe('Item one disabled.');
    expect(calls).toEqual([['Item one disabled.', 'success', { ariaHidden: true }]]);
  });

  it('an error renders the status region as before and never toasts, even when asked', () => {
    const { ragPanelSetStatus } = loadHelper();
    const doc = new FakeDocument();
    const { host, render } = hostWith(doc, 'The request failed.', true);
    const calls = withToastSpy((c) => {
      ragPanelSetStatus(host, render, true, { toast: true });
      return c;
    });
    expect(host.textContent).toBe('The request failed.');
    expect(host.classList.contains('text-error')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('loading and other lines without the toast option stay in the status region only; empty text never toasts', () => {
    const { ragPanelSetStatus } = loadHelper();
    const doc = new FakeDocument();
    const loading = hostWith(doc, 'Loading…', false);
    const empty = hostWith(doc, '   ', false);
    const calls = withToastSpy((c) => {
      ragPanelSetStatus(loading.host, loading.render, false);
      ragPanelSetStatus(empty.host, empty.render, false, { toast: true });
      return c;
    });
    expect(loading.host.textContent).toBe('Loading…');
    expect(calls).toEqual([]);
  });
});

describe('showToast aria-hidden option', () => {
  function runShowToast() {
    const doc = new FakeDocument();
    const toast = doc.createElement('div');
    toast.setAttribute('id', 'toast');
    toast.classList.add('hidden');
    const alert = doc.createElement('div');
    alert.classList.add('alert', 'alert-info');
    const message = doc.createElement('span');
    message.setAttribute('id', 'toastMessage');
    alert.appendChild(message);
    toast.appendChild(alert);
    doc.body.appendChild(toast);
    const context: Record<string, unknown> = { document: doc, console, setTimeout: () => 0 };
    vm.createContext(context);
    new vm.Script(functionSource(indexHtml, 'showToast') + '\nthis.showToast = showToast;').runInContext(context);
    return { toast, message, show: context.showToast as (m: string, t?: string, o?: { ariaHidden?: boolean }) => void };
  }

  it('sets aria-hidden for an echo toast and removes it for the page’s other toasts', () => {
    const { toast, message, show } = runShowToast();
    show('Saved.', 'success', { ariaHidden: true });
    expect(message.textContent).toBe('Saved.');
    expect(toast.getAttribute('aria-hidden')).toBe('true');
    expect(toast.classList.contains('hidden')).toBe(false);
    show('Configuration saved', 'success');
    expect(toast.hasAttribute('aria-hidden')).toBe(false);
  });
});

describe('panel wiring', () => {
  it('index.html loads panel-status.js right after rag-fetch.js, before every panel', () => {
    const scripts = [...indexHtml.matchAll(/<script src="rag-panels\/([\w-]+)\.js"><\/script>/g)].map((m) => m[1]);
    expect(scripts.indexOf('panel-status')).toBe(scripts.indexOf('rag-fetch') + 1);
    for (const panel of PANELS) expect(scripts.indexOf(panel)).toBeGreaterThan(scripts.indexOf('panel-status'));
  });

  it.each(PANELS)('%s routes setStatus through ragPanelSetStatus', (panel) => {
    const source = fs.readFileSync(path.join(panelDir, panel + '.js'), 'utf8');
    const start = source.search(/\n  setStatus\(/);
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    expect(body).toMatch(/_STATUS\(/);
    expect(source).toMatch(/typeof ragPanelSetStatus === 'function'/);
  });

  it('toasts only from completed-action call sites, never from loading or error lines', () => {
    for (const panel of PANELS) {
      const source = fs.readFileSync(path.join(panelDir, panel + '.js'), 'utf8');
      for (const line of source.split('\n').filter((l) => l.includes('toast: true'))) {
        expect(line).not.toMatch(/loading|running|progress|starting|, true, \{/);
      }
    }
  });
});
