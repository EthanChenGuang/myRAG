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

describe('ragUiMapError covers every row of UI-SPEC 8.2', () => {
  const { ragUiMapError } = loadUi();
  const map = (result: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
    ragUiMapError(result, 'en', { unavailable: 'View is unavailable right now. Select Reload panel in a moment.', ...opts });

  it('thrown or timeout: the shared network sentence, or outcome unknown after an action that changes state', () => {
    expect(map({ thrown: true })).toMatchObject({ key: 'error.network', kind: 'network' });
    expect(map({ thrown: true })!.message).toContain('Config UI server');
    expect(map({ thrown: true }, { action: 'activate' })).toMatchObject({ key: 'error.outcomeUnknown', reload: true });
  });

  it('401 and 403 Admin access required: the shared sign-in sentence with the app address filled', () => {
    for (const result of [{ status: 401, body: {} }, { status: 403, body: { error: 'Admin access required' } }]) {
      const mapped = map(result);
      expect(mapped.kind).toBe('signIn');
      expect(mapped.message).toContain('http://localhost:3000');
      expect(mapped.message).not.toContain('{appUrl}');
    }
  });

  it('403 Forbidden: the workspace sentence', () => {
    expect(map({ status: 403, body: { error: 'Forbidden' } })).toMatchObject({ key: 'error.workspace', kind: 'workspace' });
  });

  it('503: the view sentence, or the two named 503 codes', () => {
    expect(map({ status: 503, body: { error: 'Admin verification is unavailable' } })).toMatchObject({
      kind: 'unavailable',
      message: 'View is unavailable right now. Select Reload panel in a moment.',
    });
    expect(map({ status: 503, body: { error: 'languages_not_configured' } })).toMatchObject({ key: 'error.languagesNotConfigured' });
    expect(map({ status: 503, body: { error: 'upload_approval_requires_unified_pipeline' } })).toMatchObject({ key: 'error.approvalNeedsUnified' });
  });

  it('400: hidden_text_needs_sidecar, then details[0] with its field, then the bare error', () => {
    expect(map({ status: 400, body: { error: 'hidden_text_needs_sidecar' } })).toMatchObject({ key: 'error.hiddenNeedsSidecar' });
    const invalid = map({ status: 400, body: { error: 'Invalid', details: [{ path: 'value', message: 'too long' }] } });
    expect(invalid).toMatchObject({ key: 'error.invalid', field: 'value', message: 'The request was not accepted: too long' });
  });

  it('404 and 409 not_pending / not_quarantined / already_decided: item changed, reload', () => {
    for (const result of [
      { status: 404, body: {} },
      { status: 409, body: { error: 'not_pending' } },
      { status: 409, body: { error: 'not_quarantined' } },
      { status: 409, body: { error: 'already_decided' } },
    ]) {
      expect(map(result)).toMatchObject({ key: 'error.changed', reload: true });
    }
  });

  it('409 with another error and a reason is handed to the panel as a conflict', () => {
    expect(map({ status: 409, body: { error: 'activation_refused', reason: 'eval_missing' } })).toMatchObject({
      kind: 'conflict',
      code: 'activation_refused',
      reason: 'eval_missing',
    });
  });

  it('anything else: the shared generic sentence with the status code', () => {
    expect(map({ status: 500, body: {} })).toMatchObject({ key: 'error.generic', message: 'Request failed (500).' });
  });

  it('zh and it messages come from the right tables', () => {
    expect(ragUiMapError({ status: 404, body: {} }, 'zh', {})!.message).toBe('此项已被其他人更改。列表已重新加载。');
    expect(ragUiMapError({ thrown: true }, 'it', {})!.message).toContain('Config UI');
  });
});

describe('unknown codes are shown in a full sentence', () => {
  it('ragUiCodeSentence puts the code in monospace inside a sentence and creates no markup', () => {
    const { ragUiCodeSentence } = loadUi();
    const doc = new FakeDocument();
    const node = ragUiCodeSentence(doc, 'en', XSS_PAYLOAD) as FakeElement;
    doc.body.appendChild(node);
    const code = node.querySelector('code') as FakeElement;
    expect(code.textContent).toBe(XSS_PAYLOAD);
    expect(code.className).toContain('font-mono');
    expect(node.textContent.length).toBeGreaterThan(XSS_PAYLOAD.length + 5);
    expect(injectedElements(doc)).toEqual([]);
  });
});

describe('counts are "label: number" (UI-SPEC 12)', () => {
  it.each([
    ['en', 'Pending: 12,345'],
    ['it', 'Pending: 12.345'],
    ['zh', 'Pending：12,345'],
  ] as const)('%s', (locale, expected) => {
    const { ragUiCount } = loadUi();
    expect(ragUiCount('Pending', 12345, locale)).toBe(expected);
  });
});

describe('sub-tabs with roving tabindex (UI-SPEC 9.2)', () => {
  function build() {
    const { ragUiSubTabs } = loadUi();
    const doc = new FakeDocument();
    const selected: string[] = [];
    const tabs = ragUiSubTabs(doc, {
      label: 'Views',
      idPrefix: 'demo',
      tabs: [
        { id: 'one', label: 'One' },
        { id: 'two', label: 'Two' },
        { id: 'three', label: 'Three' },
      ],
      selected: 'one',
      onSelect: (id: string) => selected.push(id),
    });
    doc.body.appendChild(tabs.tablist);
    for (const panel of Object.values(tabs.panels) as FakeElement[]) doc.body.appendChild(panel);
    const buttons = tabs.tablist.querySelectorAll('button') as FakeElement[];
    return { doc, tabs, buttons, selected };
  }

  it('marks up tablist, tabs and panels', () => {
    const { tabs, buttons } = build();
    expect(tabs.tablist.getAttribute('role')).toBe('tablist');
    expect(tabs.tablist.getAttribute('aria-label')).toBe('Views');
    expect(buttons.map((b) => b.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(buttons.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    const panel = tabs.panels.two as FakeElement;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(buttons[1]!.id);
    expect(buttons[1]!.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('tabindex')).toBe('0');
    expect(panel.hidden).toBe(true);
  });

  it('Right, Left, Home and End move focus and activate; the ends wrap', () => {
    const { doc, buttons, selected, tabs } = build();
    buttons[0]!.dispatch('keydown', { key: 'ArrowRight' });
    expect(doc.activeElement).toBe(buttons[1]);
    expect(buttons[1]!.getAttribute('aria-selected')).toBe('true');
    expect(buttons[1]!.getAttribute('tabindex')).toBe('0');
    expect(buttons[0]!.getAttribute('tabindex')).toBe('-1');
    expect((tabs.panels.two as FakeElement).hidden).toBe(false);
    expect((tabs.panels.one as FakeElement).hidden).toBe(true);
    buttons[1]!.dispatch('keydown', { key: 'End' });
    expect(doc.activeElement).toBe(buttons[2]);
    buttons[2]!.dispatch('keydown', { key: 'ArrowRight' });
    expect(doc.activeElement).toBe(buttons[0]);
    buttons[0]!.dispatch('keydown', { key: 'ArrowLeft' });
    expect(doc.activeElement).toBe(buttons[2]);
    buttons[2]!.dispatch('keydown', { key: 'Home' });
    expect(doc.activeElement).toBe(buttons[0]);
    expect(selected).toEqual(['two', 'three', 'one', 'three', 'one']);
  });

  it('a click selects', () => {
    const { buttons, selected } = build();
    buttons[2]!.click();
    expect(selected).toEqual(['three']);
    expect(buttons[2]!.getAttribute('aria-selected')).toBe('true');
  });
});

describe('confirmation dialog (UI-SPEC 9.6, 12.1)', () => {
  function open(onConfirm: () => Promise<unknown>, tone: 'primary' | 'error' = 'primary') {
    const { ragUiConfirmDialog } = loadUi();
    const doc = new FakeDocument();
    const opener = doc.createElement('button');
    doc.body.appendChild(opener);
    opener.focus();
    const done = ragUiConfirmDialog(doc, {
      title: `Delete ${XSS_PAYLOAD}?`,
      body: 'This can’t be undone.',
      keepLabel: 'Keep document',
      confirmLabel: 'Delete document',
      runningLabel: 'Deleting…',
      tone,
      opener,
      onConfirm,
    }) as Promise<boolean>;
    const dialog = doc.body.querySelector('dialog') as FakeElement;
    return { doc, opener, dialog, done };
  }

  it('is a dialog.modal opened with showModal, labelled and described, focus on the safe button', () => {
    const { doc, dialog } = open(async () => undefined);
    expect(dialog.className).toContain('modal');
    expect(dialog.open).toBe(true);
    const titleId = dialog.getAttribute('aria-labelledby')!;
    const bodyId = dialog.getAttribute('aria-describedby')!;
    expect(doc.getElementById(titleId)!.textContent).toBe(`Delete ${XSS_PAYLOAD}?`);
    expect(doc.getElementById(bodyId)!.textContent).toBe('This can’t be undone.');
    expect(doc.activeElement!.textContent).toBe('Keep document');
    expect(injectedElements(doc)).toEqual([]);
  });

  it('the destructive tone uses btn-error, the reversible one btn-primary', () => {
    expect(buttonText(open(async () => undefined, 'error').dialog, 'Delete document').className).toContain('btn-error');
    expect(buttonText(open(async () => undefined, 'primary').dialog, 'Delete document').className).toContain('btn-primary');
  });

  it('Keep closes, resolves false and returns focus to the opener', async () => {
    const onConfirm = async () => undefined;
    const { doc, dialog, opener, done } = open(onConfirm);
    buttonText(dialog, 'Keep document').click();
    expect(await done).toBe(false);
    expect(dialog.open).toBe(false);
    expect(doc.activeElement).toBe(opener);
  });

  it('confirm runs the action; Escape is ignored while it runs; then focus returns', async () => {
    let release: () => void = () => {};
    const { doc, dialog, opener, done } = open(() => new Promise<void>((resolve) => (release = resolve)));
    const confirm = buttonText(dialog, 'Delete document');
    confirm.click();
    expect(confirm.textContent).toContain('Deleting…');
    expect(confirm.disabled).toBe(true);
    expect(buttonText(dialog, 'Keep document').disabled).toBe(true);
    const cancel = dialog.dispatch('cancel');
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(true);
    release();
    expect(await done).toBe(true);
    expect(dialog.open).toBe(false);
    expect(doc.activeElement).toBe(opener);
  });
});

function buttonText(root: FakeElement, text: string): FakeElement {
  const found = root.querySelectorAll('button').find((b) => b.textContent.includes(text));
  if (!found) throw new Error('no button ' + text);
  return found;
}

describe('inert evidence block (UI-SPEC 6.5.1)', () => {
  it('replaces control, zero-width and bidirectional characters by [U+XXXX], keeps line feed and tab', () => {
    const { ragUiVisibleControls } = loadUi();
    expect(ragUiVisibleControls('a​b‮c\u0007d\ne\tf⁦g﻿')).toBe('a[U+200B]b[U+202E]c[U+0007]d\ne\tf[U+2066]g[U+FEFF]');
  });

  it('renders figure, caption and a focusable pre region with text only, no link and no element from markup', () => {
    const { ragUiEvidence } = loadUi();
    const doc = new FakeDocument();
    const text = `${XSS_PAYLOAD} javascript:alert(1) https://example.test/x ​`;
    const figure = ragUiEvidence(doc, { tone: 'untrusted', caption: 'Very small text, page 3', text, locale: 'en' }) as FakeElement;
    doc.body.appendChild(figure);
    expect(figure.tagName).toBe('figure');
    expect(figure.className).toContain('border-l-4');
    expect(figure.className).toContain('border-warning');
    expect(figure.querySelector('figcaption')!.textContent).toBe('Very small text, page 3');
    const pre = figure.querySelector('pre') as FakeElement;
    expect(pre.getAttribute('tabindex')).toBe('0');
    expect(pre.getAttribute('role')).toBe('region');
    expect(pre.getAttribute('aria-label')).toBe('Very small text, page 3');
    expect(pre.getAttribute('translate')).toBe('no');
    expect(pre.textContent).toContain('[U+200B]');
    expect(pre.textContent).toContain('javascript:alert(1)');
    expect(pre.children).toEqual([]);
    expect(doc.body.querySelectorAll('a')).toEqual([]);
    expect(injectedElements(doc)).toEqual([]);
    expect(figure.title).toBe('');
  });

  it('cuts at 2,000 characters with the evidence.cut line, and the quote tone uses border-base-300', () => {
    const { ragUiEvidence } = loadUi();
    const doc = new FakeDocument();
    const figure = ragUiEvidence(doc, { tone: 'quote', caption: 'Quote', text: 'x'.repeat(2500), locale: 'it' }) as FakeElement;
    expect(figure.className).toContain('border-base-300');
    expect(figure.querySelector('pre')!.textContent).toHaveLength(2000);
    expect(figure.textContent).toContain('Troncato a 2.000 caratteri.');
  });

  it('the inert line and the show-all summary are shared labels', () => {
    const { ragUiLabel } = loadUi();
    expect(ragUiLabel('evidence.inert', 'en')).toBe('Shown as text. Never a link.');
    expect(ragUiLabel('evidence.showAll', 'zh', { count: 7 })).toBe('显示全部：7');
  });
});

describe('hold line (UI-SPEC 1, 9.8)', () => {
  it('renders state, reason and action in that DOM order, with the state word as text', () => {
    const { ragUiHoldLine } = loadUi();
    const doc = new FakeDocument();
    const action = doc.createElement('button');
    action.textContent = 'Release document';
    const line = ragUiHoldLine(doc, { tone: 'warning', icon: 'shield-exclamation', word: 'Quarantined', reason: XSS_PAYLOAD, action }) as FakeElement;
    doc.body.appendChild(line);
    const parts = line.children;
    expect(parts[0]!.className).toContain('badge');
    expect(parts[0]!.textContent).toBe('Quarantined');
    expect(parts[0]!.querySelector('i')!.getAttribute('aria-hidden')).toBe('true');
    expect(parts[1]!.textContent).toBe(XSS_PAYLOAD);
    expect(parts[2]).toBe(action);
    expect(injectedElements(doc)).toEqual([]);
  });
});

describe('list and button states (UI-SPEC 7.1)', () => {
  it('first load shows a spinner with its text; refresh dims with aria-busy and keeps content', () => {
    const { ragUiListLoading, ragUiListBusy } = loadUi();
    const doc = new FakeDocument();
    const host = doc.createElement('div');
    ragUiListLoading(doc, host, 'Loading things…');
    expect(host.querySelector('.loading')).toBeTruthy();
    expect(host.textContent).toContain('Loading things…');
    host.replaceChildren(doc.createElement('table'));
    ragUiListBusy(host, true);
    expect(host.className).toContain('opacity-60');
    expect(host.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('table')).toBeTruthy();
    ragUiListBusy(host, false);
    expect(host.className).not.toContain('opacity-60');
    expect(host.getAttribute('aria-busy')).toBeNull();
  });

  it('401/403 alert: person-lock, the sign-in sentence and Reload panel; no password field', () => {
    const { ragUiSignInAlert } = loadUi();
    const doc = new FakeDocument();
    let reloads = 0;
    const alert = ragUiSignInAlert(doc, 'en', () => (reloads += 1)) as FakeElement;
    expect(alert.className).toContain('alert-warning');
    expect(alert.querySelector('i')!.className).toContain('bi-person-lock');
    expect(alert.textContent).toContain('Admin sign-in required');
    expect(alert.querySelectorAll('input')).toEqual([]);
    buttonText(alert, 'Reload panel').click();
    expect(reloads).toBe(1);
  });

  it('503 or network alert: error tone, its sentence and Reload panel', () => {
    const { ragUiUnavailableAlert } = loadUi();
    const doc = new FakeDocument();
    const alert = ragUiUnavailableAlert(doc, 'zh', 'X is unavailable.', () => {}) as FakeElement;
    expect(alert.className).toContain('alert-error');
    expect(alert.textContent).toContain('X is unavailable.');
    expect(alert.textContent).toContain('重新加载面板');
  });

  it('a running action shows a spinner and in-flight text and disables its siblings; restore undoes it', () => {
    const { ragUiButtonBusy } = loadUi();
    const doc = new FakeDocument();
    const button = doc.createElement('button');
    button.textContent = 'Save languages';
    const sibling = doc.createElement('button');
    const restore = ragUiButtonBusy(doc, button, 'Saving…', [sibling]);
    expect(button.disabled).toBe(true);
    expect(sibling.disabled).toBe(true);
    expect(button.querySelector('.loading')).toBeTruthy();
    expect(button.textContent).toContain('Saving…');
    restore();
    expect(button.disabled).toBe(false);
    expect(sibling.disabled).toBe(false);
    expect(button.textContent).toBe('Save languages');
  });
});
