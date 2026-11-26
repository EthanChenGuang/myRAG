import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, FakeText, type FakeNode } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);

type Locale = 'en' | 'zh' | 'it';
type Message = { key: string; text: string; segments: Array<Record<string, unknown>> };
type FetchResult = { ok: boolean; status: number; body?: unknown; thrown?: boolean; timeout?: boolean };

interface GatesUi {
  GATES_UI_LABELS: Record<Locale, Record<string, string>>;
  gatesUiLocale: (value?: string) => Locale;
  gatesUiLabel: (key: string, locale: Locale, vars?: Record<string, unknown>) => string;
  gatesUiMessage: (key: string, locale: Locale, vars?: Record<string, unknown>) => Message;
  gatesUiPercent: (value: unknown, locale: Locale) => string;
  gatesUiRate: (numerator: unknown, denominator: unknown, locale: Locale) => string;
  gatesUiScore: (value: unknown, locale: Locale) => string;
  gatesUiDate: (value: unknown, locale: Locale, style?: string) => { iso: string; text: string } | null;
  gatesUiVerdictView: (value: unknown) => { key: string; classes: string; icon: string; known: boolean };
  gatesUiVerdict: (value: unknown, locale: Locale, reason?: string | null) => FakeElement;
  gatesUiEvidenceRows: (checks: unknown, locale: Locale) => { visible: Array<Record<string, unknown>>; hidden: Array<Record<string, unknown>> };
  gatesUiEvidenceTable: (checks: unknown, locale: Locale) => FakeElement;
  gatesUiShareBar: (share: unknown) => FakeElement;
  gatesUiSubTabs: (opts: Record<string, unknown>) => { root: FakeElement; tabs: FakeElement[]; panels: FakeElement[]; select: (id: string) => void };
  gatesUiConfirm: (opts: Record<string, unknown>) => Promise<boolean>;
  gatesUiMapError: (result: unknown, locale: Locale, ctx?: Record<string, unknown>) => Message & { kind: string };
  gatesUiFetch: (path: string, init: Record<string, unknown> | undefined, deps: Record<string, unknown>) => Promise<FetchResult>;
  gatesUiMessageEl: (tag: string, cls: string, message: Message) => FakeElement;
  gatesUiSetBusy: (el: FakeElement, busy: boolean) => void;
}

function load(): GatesUi {
  return require('../../scripts/config-ui/rag-panels/gates-ui.js') as GatesUi;
}

function withDoc<T>(fn: (doc: FakeDocument) => T | Promise<T>): Promise<T> {
  const doc = new FakeDocument();
  const holder = globalThis as unknown as { document?: unknown };
  const previous = holder.document;
  holder.document = doc;
  return Promise.resolve()
    .then(() => fn(doc))
    .finally(() => {
      holder.document = previous;
    });
}

function text(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(text).join('');
}

const XSS = '<img src=x onerror=alert(1)>';

describe('GATES_UI_LABELS', () => {
  it('has the same keys in en, zh and it, each non-empty', () => {
    const { GATES_UI_LABELS } = load();
    const en = Object.keys(GATES_UI_LABELS.en).sort();
    expect(en.length).toBeGreaterThan(50);
    expect(Object.keys(GATES_UI_LABELS.zh).sort()).toEqual(en);
    expect(Object.keys(GATES_UI_LABELS.it).sort()).toEqual(en);
    for (const locale of ['en', 'zh', 'it'] as const) for (const key of en) expect(GATES_UI_LABELS[locale][key], `${locale} ${key}`).toBeTruthy();
  });

  it('holds the UI-SPEC 12.2 words exactly', () => {
    const { gatesUiLabel } = load();
    expect(gatesUiLabel('verdict.pass', 'en')).toBe('Passed');
    expect(gatesUiLabel('verdict.error', 'en')).toBe('No result');
    expect(gatesUiLabel('verdict.error', 'zh')).toBe('无结果');
    expect(gatesUiLabel('verdict.skipped', 'it')).toBe('Saltato');
    expect(gatesUiLabel('limit.none', 'en')).toBe('no limit, report only');
  });

  it('writes counts as label: number, so no string needs a plural form', () => {
    const { GATES_UI_LABELS } = load();
    for (const locale of ['en', 'zh', 'it'] as const) {
      for (const [key, value] of Object.entries(GATES_UI_LABELS[locale])) {
        if (!value.includes('{count}') || key === 'measured.rate') continue;
        expect(value, `${locale} ${key}`).toMatch(/[:：]\s?\{count\}/);
      }
    }
  });

  it('carries no domain example strings', () => {
    const { GATES_UI_LABELS } = load();
    const all = Object.values(GATES_UI_LABELS.en).join('\n').toLowerCase();
    for (const word of ['travel', 'hotel', 'leave days', 'salary', 'restaurant', 'vpn', 'password']) expect(all).not.toContain(word);
  });
});

describe('gatesUiLocale and gatesUiLabel', () => {
  it('resolves zh and it, anything else is en', () => {
    const { gatesUiLocale } = load();
    expect(gatesUiLocale('zh-CN')).toBe('zh');
    expect(gatesUiLocale('it')).toBe('it');
    expect(gatesUiLocale('fr-FR')).toBe('en');
    expect(gatesUiLocale('')).toBe('en');
  });

  it('falls back to English for a key missing in the locale', () => {
    const mod = load();
    const saved = mod.GATES_UI_LABELS.it['verdict.pass'];
    delete mod.GATES_UI_LABELS.it['verdict.pass'];
    try {
      expect(mod.gatesUiLabel('verdict.pass', 'it')).toBe('Passed');
    } finally {
      mod.GATES_UI_LABELS.it['verdict.pass'] = saved;
    }
  });

  it('turns command, variable, code and id placeholders into code segments', () => {
    const { gatesUiMessage } = load();
    const message = gatesUiMessage('reason.other', 'en', { code: 'weird_code' });
    expect(message.text).toBe('Reason code: weird_code.');
    expect(message.segments).toContainEqual({ code: 'weird_code' });
    const plain = gatesUiMessage('workspace.line', 'en', { name: 'w-01' });
    expect(plain.segments).toEqual([{ text: 'Workspace: w-01' }]);
  });
});

describe('formatters', () => {
  it('percentages have one decimal and their count', () => {
    const { gatesUiRate, gatesUiPercent } = load();
    expect(gatesUiRate(76, 200, 'en')).toBe('38.0% (76 of 200)');
    expect(gatesUiPercent(0.05, 'en')).toBe('5.0%');
    expect(gatesUiRate(76, 200, 'it')).toContain('76 su 200');
  });

  it('scores have two decimals', () => {
    const { gatesUiScore } = load();
    expect(gatesUiScore(0.712, 'en')).toBe('0.71');
    expect(gatesUiScore(0.5, 'it')).toBe('0,50');
    expect(gatesUiScore(null, 'en')).toBe('');
  });

  it('dates use dateStyle medium', () => {
    const { gatesUiDate } = load();
    const view = gatesUiDate('2026-11-03', 'en');
    expect(view).toEqual({ iso: '2026-11-03', text: new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date('2026-11-03T00:00:00Z')) });
    expect(gatesUiDate('not a date', 'en')).toBeNull();
  });
});

describe('gatesUiVerdict', () => {
  it('maps every server value onto the closed word list; only pass, passed and success are green', () => {
    const { gatesUiVerdictView } = load();
    for (const v of ['pass', 'passed', 'success']) expect(gatesUiVerdictView(v).classes).toContain('badge-success');
    expect(gatesUiVerdictView('fail').key).toBe('verdict.fail');
    expect(gatesUiVerdictView('skipped')).toMatchObject({ key: 'verdict.skipped', classes: expect.stringContaining('badge-outline') });
    expect(gatesUiVerdictView('insufficient_sample').key).toBe('verdict.insufficient');
    expect(gatesUiVerdictView('insufficient_n').key).toBe('verdict.insufficient');
    for (const v of ['weird', undefined, null, '', 42, 'PASS ']) {
      const view = gatesUiVerdictView(v);
      expect(view.key, String(v)).toBe('verdict.error');
      expect(view.classes).not.toContain('badge-success');
    }
    for (const v of ['fail', 'error', 'skipped', 'insufficient_n', 'report_only', 'not_applicable', 'not_required', 'running', 'pending', 'queued', 'weird']) {
      expect(gatesUiVerdictView(v).classes, v).not.toContain('badge-success');
    }
  });

  it('passed renders the success badge with the word', async () => {
    await withDoc(() => {
      const { gatesUiVerdict } = load();
      const el = gatesUiVerdict('passed', 'en');
      const badge = el.querySelector('.badge') as FakeElement;
      expect(badge.className).toContain('badge-success');
      expect(text(badge).trim()).toBe('Passed');
      expect(badge.querySelector('i')?.getAttribute('aria-hidden')).toBe('true');
    });
  });

  it('skipped carries a reason sentence, even without a reason code', async () => {
    await withDoc(() => {
      const { gatesUiVerdict } = load();
      expect(text(gatesUiVerdict('skipped', 'en', 'no_real_set'))).toContain('This workspace has no test set of its own on this machine.');
      const bare = text(gatesUiVerdict('skipped', 'en'));
      expect(bare).toContain('Skipped');
      expect(bare.replace('Skipped', '').trim().length).toBeGreaterThan(0);
    });
  });

  it('unknown and missing values render as No result with a reason, never as Passed', async () => {
    await withDoc(() => {
      const { gatesUiVerdict } = load();
      const weird = text(gatesUiVerdict('weird', 'en'));
      expect(weird).toContain('No result');
      expect(weird).not.toContain('Passed');
      expect(weird).toContain('weird');
      const missing = text(gatesUiVerdict(undefined, 'en'));
      expect(missing).toContain('No result');
      expect(missing).not.toContain('Passed');
    });
  });

  it('an unknown reason code is shown in a code element inside a sentence', async () => {
    await withDoc(() => {
      const { gatesUiVerdict } = load();
      const el = gatesUiVerdict('skipped', 'en', 'brand_new_reason');
      expect(el.querySelector('code')?.textContent).toBe('brand_new_reason');
      expect(text(el)).toContain('Reason code: brand_new_reason.');
    });
  });
});

describe('gatesUiEvidenceRows and gatesUiEvidenceTable', () => {
  const checks = [
    { check: 'false_answer_rate', slice: 'overall', measured: 0.15, numerator: 3, denominator: 20, limit: 0.05, limit_kind: 'max', result: 'pass' },
    { check: 'false_refusal_rate', slice: 'language:it', measured: 0.2, numerator: 4, denominator: 20, limit: 0.1, limit_kind: 'max', result: 'fail' },
    { check: 'faithfulness', slice: 'overall', measured: 0.81, result: 'report_only' },
    { check: 'answer_relevance', slice: 'overall', measured: 0.7, limit: 0.6, limit_kind: 'min', result: 'mystery' },
  ];

  it('puts failed and no-result rows first and the rest in a details summary with the count', () => {
    const { gatesUiEvidenceRows } = load();
    const rows = gatesUiEvidenceRows(checks, 'en');
    expect(rows.visible.map((r) => r.verdictKey)).toEqual(['verdict.fail', 'verdict.error']);
    expect(rows.hidden.map((r) => r.verdictKey)).toEqual(['verdict.pass', 'verdict.reportOnly']);
    expect(rows.visible[0]).toMatchObject({ checkLabel: 'False refusals', slice: 'Questions in Italian', measured: '20.0% (4 of 20)', limit: 'at most 10.0%' });
  });

  it('a check without a limit shows limit.none, never an invented limit', () => {
    const { gatesUiEvidenceRows } = load();
    const rows = gatesUiEvidenceRows(checks, 'en');
    expect(rows.hidden.find((r) => r.verdictKey === 'verdict.reportOnly')?.limit).toBe('no limit, report only');
  });

  it('renders a table with a caption, column headers and a Show all checks details', async () => {
    await withDoc(() => {
      const { gatesUiEvidenceTable } = load();
      const el = gatesUiEvidenceTable(checks, 'en');
      expect(el.querySelector('caption')?.textContent).toBe('Checks and their results');
      expect((el.querySelector('table') as FakeElement).querySelectorAll('th[scope="col"]').map((th) => th.textContent)).toEqual(['Check', 'Questions', 'Measured', 'Limit', 'Result']);
      const summary = el.querySelector('summary') as FakeElement;
      expect(summary.textContent).toBe('Show all checks: 2');
      expect(el.querySelectorAll('th[scope="row"]').length).toBe(4);
    });
  });

  it('an unknown check name is shown in a code element', async () => {
    await withDoc(() => {
      const { gatesUiEvidenceTable } = load();
      const el = gatesUiEvidenceTable([{ check: 'new_metric', slice: 'overall', measured: 0.5, result: 'fail' }], 'en');
      expect(el.querySelector('th[scope="row"] code')?.textContent).toBe('new_metric');
    });
  });
});

describe('XSS: server strings are text', () => {
  it('a rule id, reason code, metric name and slice holding markup create no element', async () => {
    await withDoc((doc) => {
      const { gatesUiEvidenceTable, gatesUiVerdict, gatesUiMessageEl, gatesUiMessage } = load();
      doc.created = [];
      const table = gatesUiEvidenceTable([{ check: XSS, slice: XSS, measured: 0.5, limit: 0.1, limit_kind: XSS, result: XSS }], 'en');
      const verdict = gatesUiVerdict(XSS, 'en', XSS);
      const message = gatesUiMessageEl('p', 'text-sm', gatesUiMessage('error.unknownCode', 'en', { code: XSS }));
      doc.body.append(table, verdict, message);
      expect(doc.created).not.toContain('img');
      expect(doc.body.querySelectorAll('img')).toHaveLength(0);
      expect(doc.innerHtmlWrites).toBe(0);
      expect(text(doc.body)).toContain(XSS);
    });
  });
});

describe('gatesUiMapError', () => {
  it('401 and 403 map to the sign-in message with the app address, never the raw placeholder', () => {
    const { gatesUiMapError } = load();
    for (const status of [401, 403]) {
      const m = gatesUiMapError({ ok: false, status }, 'en', { appUrl: 'http://app.example' });
      expect(m.kind).toBe('signIn');
      expect(m.text).toContain('http://app.example');
      expect(m.text).not.toContain('{appUrl}');
    }
  });

  it('404 with the switch saved on maps to error.switchedOffApp; with it off to the off state', () => {
    const { gatesUiMapError } = load();
    expect(gatesUiMapError({ ok: false, status: 404 }, 'en', { switchedOn: true }).kind).toBe('switchedOff');
    expect(gatesUiMapError({ ok: false, status: 404 }, 'en', { switchedOn: true }).text).toContain('The app answered that this feature is off.');
    expect(gatesUiMapError({ ok: false, status: 404 }, 'en', { switchedOn: false }).kind).toBe('off');
  });

  it('500 and 503 map to error.unavailable with the view name', () => {
    const { gatesUiMapError } = load();
    for (const status of [500, 503]) {
      const m = gatesUiMapError({ ok: false, status }, 'en', { view: 'Judge calibration' });
      expect(m.kind).toBe('unavailable');
      expect(m.text).toBe('Judge calibration is unavailable right now. Select Reload panel in a moment.');
    }
  });

  it('a thrown fetch and a timeout map to the network message; other statuses to the generic one', () => {
    const { gatesUiMapError } = load();
    expect(gatesUiMapError({ thrown: true }, 'en').kind).toBe('network');
    expect(gatesUiMapError({ thrown: true, timeout: true }, 'en').text).toContain("Can't reach the Config UI server");
    expect(gatesUiMapError(null, 'en').kind).toBe('network');
    expect(gatesUiMapError({ ok: false, status: 418 }, 'en')).toMatchObject({ kind: 'generic', text: 'Request failed (418).' });
  });
});

describe('gatesUiFetch', () => {
  it('returns the fetcher result', async () => {
    const { gatesUiFetch } = load();
    const result = await gatesUiFetch('/api/rag/admin/x', { method: 'GET' }, { fetcher: async () => ({ ok: true, status: 200, body: { a: 1 } }) });
    expect(result).toEqual({ ok: true, status: 200, body: { a: 1 } });
  });

  it('a throwing fetcher becomes { thrown: true }', async () => {
    const { gatesUiFetch } = load();
    const result = await gatesUiFetch('/x', undefined, {
      fetcher: async () => {
        throw new Error('boom');
      },
    });
    expect(result.thrown).toBe(true);
  });

  it('stops after the timeout with { thrown: true, timeout: true }', async () => {
    const { gatesUiFetch } = load();
    const result = await gatesUiFetch('/x', undefined, { fetcher: () => new Promise(() => {}), timeoutMs: 5 });
    expect(result).toMatchObject({ thrown: true, timeout: true });
  });

  it('defaults to a 15-second timeout', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const source = fs.readFileSync('scripts/config-ui/rag-panels/gates-ui.js', 'utf8');
    expect(source).toMatch(/GATES_UI_TIMEOUT_MS = 15000/);
  });
});

describe('state helpers, share bar, sub-tabs and confirmation', () => {
  it('a refresh keeps content at 60% opacity with aria-busy', async () => {
    await withDoc((doc) => {
      const { gatesUiSetBusy } = load();
      const el = doc.createElement('div');
      gatesUiSetBusy(el, true);
      expect(el.className).toContain('opacity-60');
      expect(el.getAttribute('aria-busy')).toBe('true');
      gatesUiSetBusy(el, false);
      expect(el.className).not.toContain('opacity-60');
      expect(el.getAttribute('aria-busy')).toBeNull();
    });
  });

  it('the share bar is aria-hidden and clamps its fill', async () => {
    await withDoc(() => {
      const { gatesUiShareBar } = load();
      const bar = gatesUiShareBar(1.7);
      expect(bar.getAttribute('aria-hidden')).toBe('true');
      expect((bar.firstElementChild as FakeElement).style.width).toBe('100%');
      expect((gatesUiShareBar('x').firstElementChild as FakeElement).style.width).toBe('0%');
    });
  });

  it('sub-tabs have a roving tabindex and move with Left, Right, Home and End', async () => {
    await withDoc(() => {
      const { gatesUiSubTabs } = load();
      const selected: string[] = [];
      const tabs = gatesUiSubTabs({
        label: 'Views',
        idPrefix: 't',
        tabs: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
        ],
        onSelect: (id: string) => selected.push(id),
      });
      expect(tabs.root.getAttribute('role')).toBe('tablist');
      expect(tabs.tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
      const key = (k: string) => tabs.root.dispatch('keydown', { key: k, target: tabs.tabs[0] });
      key('ArrowRight');
      expect(tabs.tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
      key('End');
      key('ArrowRight');
      key('Home');
      key('ArrowLeft');
      expect(selected).toEqual(['b', 'c', 'a', 'a', 'c']);
      expect(tabs.panels[2].hidden).toBe(false);
      expect(tabs.panels[0].hidden).toBe(true);
      expect(tabs.panels[2].getAttribute('aria-labelledby')).toBe(tabs.tabs[2].id);
    });
  });

  it('the confirmation focuses the Keep button, cancels on Escape and returns focus', async () => {
    await withDoc(async (doc) => {
      const { gatesUiConfirm } = load();
      const opener = doc.createElement('button');
      doc.body.appendChild(opener);
      const pending = gatesUiConfirm({ title: 'Resolve this alert?', body: XSS, keepLabel: 'Keep alert open', confirmLabel: 'Resolve alert', opener, locale: 'en' });
      const dialog = doc.body.querySelector('dialog') as FakeElement;
      expect(dialog.open).toBe(true);
      expect(doc.activeElement?.textContent).toBe('Keep alert open');
      expect(doc.body.querySelectorAll('img')).toHaveLength(0);
      dialog.dispatch('cancel');
      await expect(pending).resolves.toBe(false);
      expect(doc.activeElement).toBe(opener);
      expect(doc.body.querySelector('dialog')).toBeNull();

      const second = gatesUiConfirm({ title: 'T', body: 'B', keepLabel: 'Keep', confirmLabel: 'Go', opener, locale: 'en' });
      const buttons = (doc.body.querySelector('dialog') as FakeElement).querySelectorAll('button');
      (buttons.find((b) => b.textContent === 'Go') as FakeElement).click();
      await expect(second).resolves.toBe(true);
    });
  });
});
