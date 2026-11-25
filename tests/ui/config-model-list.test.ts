import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, XSS_PAYLOAD, functionSource, injectedElements } from './helpers/html-fake-dom';

const html = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/config-ui/index.html'), 'utf8');

const MODEL_FUNCTIONS = ['renderModels', 'removeModel', 'moveModel', 'confirmRemoveModel', 'modelStatusIcon'];

interface Model {
  id: string;
  displayName: string;
  isDefault?: boolean;
  supportsReasoning?: boolean;
  reasoningMethod?: string;
  isFree?: boolean;
  isOpenSource?: boolean;
  isUncensored?: boolean;
}

function setup(models: Model[]) {
  const doc = new FakeDocument();
  const container = doc.createElement('div');
  container.id = 'models-container';
  doc.body.appendChild(container);
  const toasts: string[] = [];
  const modelConfig = { provider: 'openrouter', openrouterModels: models, openaiModels: [] as Model[], groqModels: [] as Model[] };
  const context = vm.createContext({
    document: doc,
    modelConfig,
    showToast: (message: string) => toasts.push(message),
    setAsDefault: () => {},
    handleDragStart: () => {},
    handleDragEnd: () => {},
    handleDragOver: () => {},
    handleDrop: () => {},
    handleDragEnter: () => {},
    handleDragLeave: () => {},
    console,
  });
  const sources = MODEL_FUNCTIONS.filter((name) => new RegExp(`function\\s+${name}\\s*\\(`).test(html)).map((name) => functionSource(html, name));
  vm.runInContext(`${sources.join('\n')}\nglobalThis.__api = { renderModels, removeModel, moveModel: typeof moveModel === 'function' ? moveModel : undefined };`, context);
  const api = (context as unknown as { __api: { renderModels: () => void; removeModel: (i: number) => void; moveModel?: (i: number, d: number) => void } }).__api;
  return { doc, container, toasts, modelConfig, api };
}

function rows(container: FakeElement): FakeElement[] {
  return container.querySelectorAll('.model-item');
}

function buttonByText(root: FakeElement, text: RegExp): FakeElement | undefined {
  return root.querySelectorAll('button').find((b) => text.test(b.textContent) || text.test(b.getAttribute('aria-label') ?? ''));
}

describe('renderModels escapes model fields (XSS)', () => {
  it('renders an injected display name, id and reasoning method as text, creating no element', () => {
    const { container, api } = setup([
      { id: `evil/${XSS_PAYLOAD}`, displayName: XSS_PAYLOAD, supportsReasoning: true, reasoningMethod: XSS_PAYLOAD, isFree: true },
      { id: 'ok/model', displayName: 'Plain', isDefault: true },
    ]);
    api.renderModels();
    expect(rows(container)).toHaveLength(2);
    expect(injectedElements(container)).toEqual([]);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.textContent).toContain(XSS_PAYLOAD);
  });
});

describe('renderModels status icons are labelled', () => {
  it('each status icon has an accessible name and its svg is hidden from assistive tech', () => {
    const { container, api } = setup([{ id: 'a/b', displayName: 'All', supportsReasoning: true, reasoningMethod: 'effort', isFree: true, isOpenSource: true, isUncensored: true }]);
    api.renderModels();
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBe(4);
    for (const svg of svgs) {
      const labelled = svg.getAttribute('aria-hidden') === 'true' ? svg.parentNode : svg;
      expect(svg.getAttribute('aria-hidden') === 'true' || svg.hasAttribute('aria-label')).toBe(true);
      const host = labelled as FakeElement;
      const name = host.getAttribute('aria-label');
      expect(name && name.length > 0).toBe(true);
      if (host !== svg) expect(host.getAttribute('role')).toBe('img');
    }
    const names = svgs.map((svg) => ((svg.getAttribute('aria-hidden') === 'true' ? svg.parentNode : svg) as FakeElement).getAttribute('aria-label'));
    expect(names.join(' ')).toMatch(/reasoning/i);
    expect(names.join(' ')).toMatch(/free/i);
    expect(names.join(' ')).toMatch(/open source/i);
    expect(names.join(' ')).toMatch(/uncensored/i);
  });
});

describe('Remove model asks for confirmation', () => {
  it('opens a native dialog with focus on Cancel and keeps the model until confirmed', () => {
    const { doc, container, api, modelConfig } = setup([
      { id: 'a/one', displayName: 'One', isDefault: true },
      { id: 'b/two', displayName: XSS_PAYLOAD },
    ]);
    api.renderModels();
    const remove = buttonByText(rows(container)[1]!, /remove/i);
    expect(remove).toBeTruthy();
    remove!.click();
    expect(modelConfig.openrouterModels).toHaveLength(2);
    const dialog = doc.querySelector('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog!.open).toBe(true);
    expect(injectedElements(doc)).toEqual([]);
    expect(dialog!.textContent).toContain(XSS_PAYLOAD);
    const cancel = buttonByText(dialog!, /^cancel$/i);
    expect(doc.activeElement).toBe(cancel);
    cancel!.click();
    expect(modelConfig.openrouterModels).toHaveLength(2);
    expect(doc.querySelector('dialog')).toBeNull();
  });

  it('removes the model after Remove is confirmed', () => {
    const { doc, container, api, modelConfig, toasts } = setup([
      { id: 'a/one', displayName: 'One', isDefault: true },
      { id: 'b/two', displayName: 'Two' },
    ]);
    api.renderModels();
    buttonByText(rows(container)[1]!, /remove/i)!.click();
    const dialog = doc.querySelector('dialog') as FakeElement;
    expect(dialog).toBeTruthy();
    const confirm = dialog.querySelectorAll('button').find((b) => b !== doc.activeElement && /remove/i.test(b.textContent));
    expect(confirm).toBeTruthy();
    confirm!.click();
    expect(modelConfig.openrouterModels.map((m) => m.id)).toEqual(['a/one']);
    expect(rows(container)).toHaveLength(1);
    expect(toasts.some((t) => /removed/i.test(t))).toBe(true);
  });
});

describe('Models can be reordered without dragging', () => {
  it('Move up and Move down buttons reorder the list and disable at the ends', () => {
    const { container, api, modelConfig } = setup([
      { id: 'a', displayName: 'A', isDefault: true },
      { id: 'b', displayName: 'B' },
      { id: 'c', displayName: 'C' },
    ]);
    api.renderModels();
    const first = rows(container)[0]!;
    const last = rows(container)[2]!;
    expect(buttonByText(first, /move .*up/i)).toBeTruthy();
    expect(buttonByText(last, /move .*down/i)).toBeTruthy();
    expect(buttonByText(first, /move .*up/i)!.disabled).toBe(true);
    expect(buttonByText(last, /move .*down/i)!.disabled).toBe(true);
    buttonByText(rows(container)[1]!, /move .*up/i)!.click();
    expect(modelConfig.openrouterModels.map((m) => m.id)).toEqual(['b', 'a', 'c']);
    buttonByText(rows(container)[1]!, /move .*down/i)!.click();
    expect(modelConfig.openrouterModels.map((m) => m.id)).toEqual(['b', 'c', 'a']);
  });
});
