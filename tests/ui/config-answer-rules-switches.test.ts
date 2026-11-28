import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

const SWITCHES = [
  'RAG_REGISTRY_TEXTS',
  'RAG_PARTIAL_ANSWER_RULE',
  'RAG_CONTEXT_RELEVANCE_RULE',
  'RAG_VERSION_LABELS',
  'RAG_CITATION_PER_SENTENCE',
  'RAG_CLAIM_CHECK',
  'RAG_GROUNDEDNESS_LLM_JUDGE',
  'RAG_GROUNDEDNESS_JUDGE_MODEL',
  'RAG_MAX_OUTPUT_TOKENS',
  'RAG_OUTPUT_GUARD',
  'RAG_SECURITY_EVENTS',
  'RAG_UPLOADER_ALERT_THRESHOLD',
  'RAG_UPLOADER_ALERT_WINDOW_HOURS',
  'RAG_UPLOADER_HOLD',
];
const CHECKBOXES = [
  'RAG_REGISTRY_TEXTS',
  'RAG_PARTIAL_ANSWER_RULE',
  'RAG_CONTEXT_RELEVANCE_RULE',
  'RAG_VERSION_LABELS',
  'RAG_CITATION_PER_SENTENCE',
  'RAG_CLAIM_CHECK',
  'RAG_GROUNDEDNESS_LLM_JUDGE',
  'RAG_SECURITY_EVENTS',
];
const GROUPS = [
  ['texts', 'Texts in the language of the question'],
  ['claims', 'What an answer may claim'],
  ['sources', 'A source for every sentence'],
  ['length', 'Answer length'],
  ['guard', 'Links and sign-in requests in answers'],
  ['events', 'Security events and uploaders'],
  ['calc', 'Calculations'],
  ['budget', 'Prompt size'],
] as const;

function card(): string {
  const start = html.indexOf('<!-- Answer rules and output safety -->');
  expect(start, 'answer rules card exists').toBeGreaterThan(-1);
  const end = html.indexOf('<!-- Info Box -->', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function tagOf(markup: string, name: string): string {
  const match = markup.match(new RegExp(`<(input|select)\\b[^>]*\\bid="${name}"[^>]*>`));
  expect(match, `${name} control`).not.toBeNull();
  return match![0];
}

function optionValues(markup: string, name: string): Array<[string, string]> {
  const start = markup.indexOf(`<select id="${name}"`);
  const select = markup.slice(start, markup.indexOf('</select>', start));
  return [...select.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1]!, m[2]!]);
}

describe('Config UI: answer rules and output safety card (UI-SPEC 6.12, 12.3)', () => {
  it('sits in the RAG Modes tab after "Prompt-injection defense"', () => {
    const modes = html.indexOf('id="rag-modes"');
    const injection = html.indexOf('<!-- Prompt-injection defense -->');
    const answer = html.indexOf('id="rag-answer-rules"');
    const nextTab = html.indexOf('id="rag-settings"');
    expect(modes).toBeGreaterThan(-1);
    expect(injection).toBeGreaterThan(modes);
    expect(answer).toBeGreaterThan(injection);
    expect(nextTab).toBeGreaterThan(answer);
    expect(html.match(/id="rag-answer-rules"/g)).toHaveLength(1);
    expect(card()).toContain('>Answer rules and output safety</h3>');
  });

  it('holds each of the fourteen switches exactly once on the page, id and name equal to the env name', () => {
    expect(SWITCHES).toHaveLength(14);
    const markup = card();
    for (const name of SWITCHES) {
      expect(html.match(new RegExp(`\\bid="${name}"`, 'g')), name).toHaveLength(1);
      expect(tagOf(markup, name)).toContain(`name="${name}"`);
    }
    expect(html).not.toContain('id="WHATSAPP_LINK_PREVIEW_HOSTS"');
  });

  it('groups the switches under the eight headings in order, with the Phase 5.2.1 groups empty', () => {
    const markup = card();
    const positions = GROUPS.map(([key, title]) => {
      const heading = `id="rag-answer-rules-group-${key}" class="text-base font-semibold mt-6 mb-2 text-balance" data-rag-i18n="group.${key}">${title}</h4>`;
      expect(markup, key).toContain(heading);
      return markup.indexOf(heading);
    });
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const key of ['calc', 'budget']) {
      const section = markup.slice(markup.indexOf(`data-answer-rules-group="${key}"`));
      const body = section.slice(0, section.indexOf('</section>'));
      expect(body).not.toMatch(/<(input|select|button)\b/);
      expect(body).toContain(`id="rag-answer-rules-${key}"`);
    }
  });

  it('renders the eight booleans as checkboxes with a help line ending in the env name', () => {
    const markup = card();
    for (const name of CHECKBOXES) {
      const tag = tagOf(markup, name);
      expect(tag).toContain('type="checkbox"');
      expect(tag).toContain('class="checkbox checkbox-primary"');
    }
    for (const name of SWITCHES) expect(markup, name).toContain(`<code translate="no">${name}</code>`);
    for (const name of [...CHECKBOXES, 'RAG_OUTPUT_GUARD', 'RAG_UPLOADER_ALERT_THRESHOLD', 'RAG_UPLOADER_ALERT_WINDOW_HOURS', 'RAG_UPLOADER_HOLD']) {
      expect(tagOf(markup, name), name).toContain(`aria-describedby="${name}-help"`);
      expect(markup.match(new RegExp(`id="${name}-help"`, 'g')), name).toHaveLength(1);
    }
  });

  it('renders the guard and the hold as selects whose values are the env values and whose text is the human label', () => {
    const markup = card();
    expect(optionValues(markup, 'RAG_OUTPUT_GUARD')).toEqual([
      ['off', 'Off'],
      ['flag', 'Record only'],
      ['enforce', 'Remove and block'],
    ]);
    expect(optionValues(markup, 'RAG_UPLOADER_HOLD')).toEqual([
      ['off', 'Never'],
      ['manual', 'When an admin chooses'],
      ['auto', 'Automatically when an alert opens'],
    ]);
  });

  it('renders the alert level and window as bounded number inputs', () => {
    const markup = card();
    const threshold = tagOf(markup, 'RAG_UPLOADER_ALERT_THRESHOLD');
    for (const attr of ['type="number"', 'min="0"', 'step="1"', 'inputmode="numeric"']) expect(threshold).toContain(attr);
    const window = tagOf(markup, 'RAG_UPLOADER_ALERT_WINDOW_HOURS');
    for (const attr of ['type="number"', 'min="1"', 'max="720"', 'step="1"', 'placeholder="24"']) expect(window).toContain(attr);
  });

  it('renders the judge model as a monospace text input with the egress note always visible', () => {
    const markup = card();
    const tag = tagOf(markup, 'RAG_GROUNDEDNESS_JUDGE_MODEL');
    for (const attr of ['type="text"', 'autocomplete="off"', 'spellcheck="false"', 'translate="no"', 'font-mono']) {
      expect(tag).toContain(attr);
    }
    expect(tag).toContain('aria-describedby="rag-answer-rules-judge-egress"');
    expect(markup).toMatch(/id="rag-answer-rules-judge-egress"[^>]*>.*go to this model’s provider/);
  });

  it('keeps the answer-length select and number without env ids so only the hidden input is saved', () => {
    const markup = card();
    const hidden = tagOf(markup, 'RAG_MAX_OUTPUT_TOKENS');
    expect(hidden).toContain('type="hidden"');
    expect(hidden).toContain('value="off"');
    const mode = markup.match(/<select\b[^>]*data-answer-cap="mode"[^>]*>/)![0];
    const amount = markup.match(/<input\b[^>]*data-answer-cap="value"[^>]*>/)![0];
    expect(mode).not.toMatch(/\bid=/);
    expect(amount).not.toMatch(/\bid=/);
    expect(amount).toContain('min="256"');
    const select = markup.slice(markup.indexOf('data-answer-cap="mode"'), markup.indexOf('</select>', markup.indexOf('data-answer-cap="mode"')));
    expect([...select.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]])).toEqual([
      ['off', 'Off'],
      ['auto', 'Chosen by evaluation'],
      ['fixed', 'Fixed limit'],
    ]);
  });

  it('leaves stable empty hosts for the read-only blocks of plan 05.2-36', () => {
    const markup = card();
    for (const id of [
      'rag-answer-rules-alerts',
      'rag-answer-rules-judge-calibration',
      'rag-answer-rules-caps',
      'rag-answer-rules-guard-now',
      'rag-answer-rules-allowlist',
      'rag-answer-rules-guard-rules',
      'rag-answer-rules-events-actions',
    ]) {
      expect(markup).toMatch(new RegExp(`<div id="${id}" class="min-w-0"[^>]*></div>`));
    }
    expect(markup).not.toContain('id="RAG_OUTPUT_LINK_ALLOWLIST"');
  });

  it('builds no anchor, no innerHTML and no href from data', () => {
    const markup = card();
    expect(markup).not.toMatch(/<a\b/);
    expect(markup).not.toMatch(/\bhref=/);
    const script = inlineScript();
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|createElement\(['"]a['"]\)|setAttribute\(['"]href/);
  });
});

function inlineScript(): string {
  const markup = card();
  const start = markup.indexOf('<script>');
  expect(start).toBeGreaterThan(-1);
  return markup.slice(start + '<script>'.length, markup.indexOf('</script>', start));
}

type Listener = (event: { type: string; target: FakeNode }) => void;

class FakeNode {
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  hidden = false;
  textContent = '';
  dispatched: string[] = [];
  constructor(public selector: string, attrs: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(attrs)) this.attributes.set(key, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatchEvent(event: { type: string }): boolean {
    this.dispatched.push(event.type);
    for (const listener of this.listeners.get(event.type) ?? []) listener({ type: event.type, target: this });
    return true;
  }
}

class FakeField extends FakeNode {
  value = '';
}

class FakeInputBase extends FakeNode {
  #value = '';
  get value(): string {
    return this.#value;
  }
  set value(next: string) {
    this.#value = String(next);
  }
}

function mount(initial = 'off') {
  const hidden = new FakeInputBase('#RAG_MAX_OUTPUT_TOKENS');
  hidden.value = initial;
  const mode = new FakeField('mode');
  const amount = new FakeField('value', { min: '256' });
  const amountField = new FakeNode('value-field');
  amountField.hidden = true;
  const amountError = new FakeNode('value-error', { 'data-template': 'Enter {n} or more.' });
  const parts: Record<string, FakeNode> = {
    '[data-answer-cap="mode"]': mode,
    '[data-answer-cap="value"]': amount,
    '[data-answer-cap="value-field"]': amountField,
    '[data-answer-cap="value-error"]': amountError,
  };
  const cardNode = Object.assign(new FakeNode('#rag-answer-rules'), {
    querySelector: (selector: string) => parts[selector] ?? null,
  });
  const document = {
    getElementById: (id: string) => (id === 'rag-answer-rules' ? cardNode : id === 'RAG_MAX_OUTPUT_TOKENS' ? hidden : null),
  };
  class Event {
    readonly type: string;
    constructor(type: string) {
      this.type = type;
    }
  }
  vm.runInNewContext(inlineScript(), { document, Event, Object, String, parseInt });
  const change = (node: FakeField, value: string) => {
    node.value = value;
    node.dispatchEvent({ type: 'change' });
  };
  return { hidden, mode, amount, amountField, amountError, change };
}

describe('Config UI: answer length control writes the hidden RAG_MAX_OUTPUT_TOKENS (UI-SPEC 6.12)', () => {
  it('shows off with the number hidden for the default', () => {
    const ui = mount('off');
    expect(ui.mode.value).toBe('off');
    expect(ui.amountField.hidden).toBe(true);
    expect(ui.hidden.value).toBe('off');
  });

  it('writes auto, a fixed integer and off back, firing change on the hidden input each time', () => {
    const ui = mount('off');
    ui.change(ui.mode, 'auto');
    expect(ui.hidden.value).toBe('auto');
    expect(ui.hidden.dispatched).toEqual(['change']);

    ui.change(ui.mode, 'fixed');
    expect(ui.amountField.hidden).toBe(false);
    expect(ui.hidden.value).toBe('auto');
    ui.change(ui.amount, '600');
    expect(ui.hidden.value).toBe('600');
    expect(ui.hidden.dispatched).toEqual(['change', 'change']);

    ui.change(ui.mode, 'off');
    expect(ui.hidden.value).toBe('off');
    expect(ui.amountField.hidden).toBe(true);
    expect(ui.hidden.dispatched).toHaveLength(3);
  });

  it('marks a number under the floor invalid and leaves the hidden value unchanged', () => {
    const ui = mount('off');
    ui.change(ui.mode, 'fixed');
    ui.change(ui.amount, '100');
    expect(ui.amount.getAttribute('aria-invalid')).toBe('true');
    expect(ui.amountError.textContent).toBe('Enter 256 or more.');
    expect(ui.hidden.value).toBe('off');
    expect(ui.hidden.dispatched).toEqual([]);
    ui.change(ui.amount, '1.5');
    expect(ui.hidden.value).toBe('off');
    ui.change(ui.amount, '512');
    expect(ui.amount.getAttribute('aria-invalid')).toBeNull();
    expect(ui.amountError.textContent).toBe('');
    expect(ui.hidden.value).toBe('512');
  });

  it('follows a value the page loader writes into the hidden input', () => {
    const ui = mount('off');
    ui.hidden.value = '800';
    expect(ui.mode.value).toBe('fixed');
    expect(ui.amount.value).toBe('800');
    expect(ui.amountField.hidden).toBe(false);
    ui.hidden.value = 'auto';
    expect(ui.mode.value).toBe('auto');
    expect(ui.amountField.hidden).toBe(true);
    ui.hidden.value = 'garbage';
    expect(ui.mode.value).toBe('off');
    expect(ui.hidden.dispatched).toEqual([]);
  });

  it('starts from a stored fixed value', () => {
    const ui = mount('700');
    expect(ui.mode.value).toBe('fixed');
    expect(ui.amount.value).toBe('700');
  });
});
