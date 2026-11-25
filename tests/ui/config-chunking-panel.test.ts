import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { RefusalThresholdsSchema } from '@/lib/rag-eval/contracts.generated';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { refusalCalibrationStatus } from '@/lib/rag/refusal/status';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const panelDir = path.join(repoRoot, 'scripts/config-ui/rag-panels');

type Findings = { errors: string[]; warnings: string[] };
type ValidationContext = Record<string, number | undefined>;

interface CaseRow {
  input: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

interface CaseTable {
  cases: CaseRow[];
  default_context: { max_child_tokens: number; top_k: number; context_budget: number };
  error_codes: string[];
  warning_codes: string[];
}

function loadValidator() {
  return require('../../scripts/config-ui/rag-panels/chunking-validate.js') as {
    CHUNKING_PRESETS: Record<string, { child_tokens: number; parent_tokens: number; parent_mode: string }>;
    validateChunking: (input: Record<string, unknown>, context?: ValidationContext) => Findings;
    chunkingPresetSizes: (
      preset: string,
      custom?: Record<string, unknown>,
    ) => { preset: string; child_tokens: unknown; parent_tokens: unknown; parent_mode: unknown } | null;
  };
}

function loadCaseTable(): CaseTable {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'rag-sidecar/schemas/chunking-profile-cases.json'), 'utf8')) as CaseTable;
}

describe('chunking validator parity with chunking-profile-cases.json (D-21)', () => {
  const table = loadCaseTable();
  const { validateChunking } = loadValidator();
  const camel = {
    maxChildTokens: table.default_context.max_child_tokens,
    topK: table.default_context.top_k,
    contextBudget: table.default_context.context_budget,
  };

  it('the case table has rows', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(5);
  });

  it.each(loadCaseTable().cases.map((row) => [String(row.input.id), row] as const))('row %s gives the Pydantic errors and warnings', (_id, row) => {
    expect(validateChunking(row.input, camel)).toEqual({ errors: row.errors, warnings: row.warnings });
  });

  it('accepts the context in the case table spelling too', () => {
    for (const row of table.cases) {
      expect(validateChunking(row.input, table.default_context as unknown as ValidationContext)).toEqual({ errors: row.errors, warnings: row.warnings });
    }
  });

  it('reports only codes the case table names', () => {
    const known = new Set([...table.error_codes, ...table.warning_codes]);
    for (const row of table.cases) {
      const found = validateChunking(row.input, camel);
      for (const code of [...found.errors, ...found.warnings]) expect(known.has(code)).toBe(true);
    }
  });

  it('skips a rule whose context value is missing (UI-SPEC section 14 row 1)', () => {
    const contextCodes = new Set(['child_exceeds_embedding_input', 'top_k_parent_over_budget']);
    for (const row of table.cases) {
      const expected = {
        errors: row.errors.filter((code) => !contextCodes.has(code)),
        warnings: row.warnings.filter((code) => !contextCodes.has(code)),
      };
      expect(validateChunking(row.input, {})).toEqual(expected);
      expect(validateChunking(row.input)).toEqual(expected);
    }
    const partial = validateChunking({ child_tokens: 256, parent_mode: 'structure', parent_tokens: 1024 }, { topK: 8 });
    expect(partial.warnings).not.toContain('top_k_parent_over_budget');
  });

  it('answers invalid_shape for sizes that are not whole numbers of 1 or more', () => {
    expect(validateChunking({ child_tokens: 0, parent_mode: 'structure', parent_tokens: 1024 }, camel).errors).toEqual(['invalid_shape']);
    expect(validateChunking({ child_tokens: 256.5, parent_mode: 'fixed', parent_tokens: 1024 }, camel).errors).toEqual(['invalid_shape']);
    expect(validateChunking({ child_tokens: 256, parent_mode: 'sideways', parent_tokens: 1024 }, camel).errors).toEqual(['invalid_shape']);
    expect(validateChunking({ child_tokens: 256, parent_mode: 'fixed', parent_tokens: '1024' }, camel).errors).toEqual(['invalid_shape']);
  });
});

describe('chunking presets', () => {
  const { CHUNKING_PRESETS, chunkingPresetSizes } = loadValidator();

  it('128/512, 256/1024 and 256/2048 expand to their sizes with structure parents', () => {
    expect(chunkingPresetSizes('128/512')).toEqual({ preset: '128/512', child_tokens: 128, parent_tokens: 512, parent_mode: 'structure' });
    expect(chunkingPresetSizes('256/1024')).toEqual({ preset: '256/1024', child_tokens: 256, parent_tokens: 1024, parent_mode: 'structure' });
    expect(chunkingPresetSizes('256/2048')).toEqual({ preset: '256/2048', child_tokens: 256, parent_tokens: 2048, parent_mode: 'structure' });
    expect(Object.keys(CHUNKING_PRESETS)).toEqual(['128/512', '256/1024', '256/2048']);
  });

  it('a preset ignores typed values; custom keeps them', () => {
    expect(chunkingPresetSizes('256/2048', { child_tokens: 1, parent_tokens: 2, parent_mode: 'fixed' })).toMatchObject({
      child_tokens: 256,
      parent_tokens: 2048,
      parent_mode: 'structure',
    });
    expect(chunkingPresetSizes('custom', { child_tokens: 300, parent_tokens: 1800, parent_mode: 'fixed' })).toEqual({
      preset: 'custom',
      child_tokens: 300,
      parent_tokens: 1800,
      parent_mode: 'fixed',
    });
  });
});

describe('chunking-validate.js runs in the browser', () => {
  it('has no import or require and defines window.validateChunking in a classic-script context', () => {
    const code = fs.readFileSync(path.join(panelDir, 'chunking-validate.js'), 'utf8');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\brequire\(/);
    const context: Record<string, unknown> = {};
    context.window = context;
    vm.createContext(context);
    new vm.Script(code, { filename: 'chunking-validate.js' }).runInContext(context);
    const validate = context.validateChunking as (input: Record<string, unknown>, ctx?: ValidationContext) => Findings;
    expect(typeof validate).toBe('function');
    expect(validate({ child_tokens: 256, parent_mode: 'fixed', parent_tokens: 400 }, {})).toEqual({
      errors: ['parent_below_twice_child'],
      warnings: [],
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// A minimal DOM for the panel scripts. innerHTML throws, so a panel that parses markup fails the test; every created tag is recorded.

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  type: string;
  key?: string;
  target?: FakeElement;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

class FakeText {
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
  set textContent(value: string) {
    this.data = String(value);
  }
}

type FakeNode = FakeElement | FakeText;

class FakeElement {
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  style: Record<string, string> = {};
  disabled = false;
  hidden = false;
  value = '';
  checked = false;
  readOnly = false;
  open = false;
  returnValue = '';
  type = '';
  name = '';
  method = '';
  constructor(
    public tagName: string,
    public doc: FakeDocument,
  ) {}
  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(value: string) {
    this.attributes.set('class', String(value));
  }
  get id(): string {
    return this.attributes.get('id') ?? '';
  }
  set id(value: string) {
    this.attributes.set('id', String(value));
  }
  get classList() {
    const read = () => this.className.split(/\s+/).filter(Boolean);
    const write = (names: string[]) => {
      this.className = names.join(' ');
    };
    return {
      add: (...names: string[]) => write([...new Set([...read(), ...names])]),
      remove: (...names: string[]) => write(read().filter((n) => !names.includes(n))),
      toggle: (name: string, force?: boolean) => {
        const has = read().includes(name);
        const want = force === undefined ? !has : force;
        if (want && !has) write([...read(), name]);
        if (!want && has) write(read().filter((n) => n !== name));
        return want;
      },
      contains: (name: string) => read().includes(name),
    };
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(value: string) {
    this.replaceChildren();
    if (value !== '' && value !== null && value !== undefined) this.appendChild(new FakeText(String(value)));
  }
  set innerHTML(_value: string) {
    throw new Error('innerHTML is not allowed in Config UI panels');
  }
  get innerHTML(): string {
    throw new Error('innerHTML is not allowed in Config UI panels');
  }
  insertAdjacentHTML(): void {
    throw new Error('insertAdjacentHTML is not allowed in Config UI panels');
  }
  get isConnected(): boolean {
    return this.doc.documentElement.contains(this);
  }
  appendChild<T extends FakeNode>(node: T): T {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new FakeText(node) : node);
  }
  insertBefore<T extends FakeNode>(node: T, ref: FakeNode | null): T {
    if (!ref) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = this.childNodes.indexOf(ref);
    node.parentNode = this;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
    return node;
  }
  removeChild<T extends FakeNode>(node: T): T {
    this.childNodes = this.childNodes.filter((n) => n !== node);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? (this.attributes.get(name) as string) : null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    );
  }
  dispatch(type: string, extra: Partial<FakeEvent> = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra,
    };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
  click(): void {
    if (!this.disabled) this.dispatch('click');
  }
  focus(): void {
    this.doc.activeElement = this;
  }
  scrollIntoView(): void {}
  showModal(): void {
    this.open = true;
  }
  close(value?: string): void {
    this.open = false;
    if (value !== undefined) this.returnValue = value;
    this.dispatch('close');
  }
  contains(node: FakeNode | null): boolean {
    let current: FakeNode | FakeElement | null = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  matches(selector: string): boolean {
    const m = selector.match(/^([a-z0-9]*)(?:#([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i);
    if (!m) throw new Error(`fake DOM does not support selector ${selector}`);
    const [, tag, id, attr, attrValue] = m;
    if (tag && this.tagName !== tag.toLowerCase()) return false;
    if (id && this.id !== id) return false;
    if (attr && !this.attributes.has(attr)) return false;
    if (attr && attrValue !== undefined && this.attributes.get(attr) !== attrValue) return false;
    return true;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  created: string[] = [];
  activeElement: FakeElement | null = null;
  documentElement: FakeElement;
  body: FakeElement;
  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string): FakeElement {
    this.created.push(tag.toLowerCase());
    return new FakeElement(tag.toLowerCase(), this);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(String(text));
  }
  getElementById(id: string): FakeElement | null {
    return this.documentElement.querySelector(`#${id}`);
  }
  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }
  addEventListener(): void {}
}

function withFakeDocument<T>(fn: (doc: FakeDocument) => Promise<T>): Promise<T> {
  const doc = new FakeDocument();
  const holder = globalThis as unknown as { document?: unknown };
  const previous = holder.document;
  holder.document = doc;
  return fn(doc).finally(() => {
    holder.document = previous;
  });
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function textNodes(el: FakeElement): string[] {
  const out: string[] = [];
  const walk = (node: FakeNode) => {
    if (node instanceof FakeText) out.push(node.data);
    else node.childNodes.forEach(walk);
  };
  walk(el);
  return out;
}

const XSS = '<img src=x onerror=alert(1)>';

type FetchResult = { ok: boolean; status: number; body: unknown; message?: string };
type Fetcher = (apiPath: string, init?: { method?: string; body?: string }) => Promise<FetchResult>;

function fakeFetcher(routes: Record<string, FetchResult | ((init?: { method?: string; body?: string }) => FetchResult)>) {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const fetcher: Fetcher = async (apiPath, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ path: apiPath, method, body: init?.body });
    const route = routes[`${method} ${apiPath}`];
    if (!route) return { ok: false, status: 404, body: { error: 'not stubbed' } };
    return typeof route === 'function' ? route(init) : route;
  };
  return { fetcher, calls };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Chunking profiles panel (Task 2)

type Locale = 'en' | 'zh' | 'it';

interface ProfileGroup {
  docType: string;
  activeId: string;
  missingFromActive: number | null;
  onlyLegacy: boolean;
  rows: Array<Record<string, unknown>>;
}

interface Message {
  key: string;
  text: string;
  segments: Array<{ text?: string; code?: string }>;
}

function loadChunkingPanel() {
  return require('../../scripts/config-ui/rag-panels/chunking-profiles.js') as {
    CHUNKING_LABELS: Record<Locale, Record<string, string>>;
    CHUNKING_DOC_TYPE_ORDER: string[];
    chunkingLabel: (key: string, locale: Locale, vars?: Record<string, unknown>) => string;
    profilesByDocType: (list: Record<string, unknown>) => ProfileGroup[];
    coverageWarning: (group: ProfileGroup, locale: Locale) => (Message & { count: number | null; showBuild: boolean }) | null;
    refusalMessage: (reason: string, locale: Locale, vars?: Record<string, unknown>) => Message;
    reportRows: (report: Record<string, unknown>, slice?: string) => Array<Record<string, any>>;
    chunkingReportSlices: (
      report: Record<string, unknown>,
      languages?: string[],
    ) => Array<{ value: string; group: string | null; key: string | null }>;
    chunkingLanguageCodesFrom: (body: unknown) => string[] | null;
    loadChunkingLanguages: (fetchImpl: (path: string, init?: Record<string, unknown>) => Promise<unknown>) => Promise<string[] | null>;
    resetChunkingLanguagesForTests: () => void;
    chunkingDecisionRows: (decisions: Array<Record<string, unknown>>) => Array<{ docType: string; decision: Record<string, unknown> | null }>;
    chunkingFormFindings: (fields: Record<string, unknown>) => {
      body: Record<string, unknown> | null;
      fieldErrors: Record<string, string>;
      errors: string[];
      warnings: string[];
      blocking: boolean;
    };
    chunkingSuggestedId: (child: unknown, parent: unknown, docType: string) => string;
    mapChunkingError: (
      result: Record<string, unknown>,
      route: string,
      locale: Locale,
      ctx?: Record<string, unknown>,
    ) => Message & { signIn?: boolean; reload?: boolean; field?: string; findings?: string[]; paused?: boolean };
    runChunkingBuild: (opts: {
      post: () => Promise<FetchResult>;
      shouldPause?: () => boolean;
      onStep?: (answer: Record<string, unknown>) => void;
    }) => Promise<{ outcome: string; last: Record<string, unknown> | null; result?: Record<string, unknown> }>;
    ChunkingProfilesPanel: new (
      root: unknown,
      deps: { fetcher: Fetcher; locale?: Locale; appUrl?: string },
    ) => { mount: () => Promise<void>; selectTab: (name: string) => void; root: unknown };
  };
}

const REPORT = JSON.parse(fs.readFileSync(path.join(repoRoot, 'eval/reports/chunking-sweep.json'), 'utf8')) as Record<string, any>;
const DECISIONS = JSON.parse(fs.readFileSync(path.join(repoRoot, 'eval/decisions/chunking/index.json'), 'utf8')) as Array<Record<string, any>>;
const DOC_TYPES = ['general', 'financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image'];

function legacyRow(docType: string, active = true): Record<string, unknown> {
  return {
    id: 'legacy',
    doc_type: docType,
    child_tokens: 512,
    parent_mode: 'none',
    parent_tokens: null,
    status: 'ready',
    preset: '256/1024',
    is_active: active,
    previous_active_id: null,
    created_at: '2026-11-01T00:00:00Z',
    activated_at: null,
    activated_by: null,
    completeness: null,
  };
}

function profileRow(id: string, docType: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    doc_type: docType,
    child_tokens: 256,
    parent_mode: 'structure',
    parent_tokens: 1024,
    status: 'ready',
    preset: '256/1024',
    is_active: false,
    previous_active_id: null,
    created_at: '2026-11-20T00:00:00Z',
    activated_at: null,
    activated_by: 'MARKER_ACTIVATED_BY',
    completeness: { current_ready_documents: 123, documents_with_children: 123, missing_documents: 0 },
    ...extra,
  };
}

function listBody(): Record<string, unknown> {
  const profiles = DOC_TYPES.filter((t) => t !== 'contract_legal').map((t) => legacyRow(t));
  profiles.push(legacyRow('contract_legal', false));
  profiles.push(
    profileRow('p256-1024-contract_legal', 'contract_legal', {
      status: 'active',
      is_active: true,
      previous_active_id: 'legacy',
      activated_at: '2026-11-24T10:00:00Z',
      completeness: { current_ready_documents: 123, documents_with_children: 120, missing_documents: 3 },
    }),
    profileRow('p128-512-contract_legal', 'contract_legal', { child_tokens: 128, parent_tokens: 512, preset: '128/512' }),
    profileRow('p256-2048-contract_legal', 'contract_legal', {
      status: 'building',
      parent_tokens: 2048,
      preset: '256/2048',
      created_at: '2026-11-22T00:00:00Z',
      completeness: { current_ready_documents: 123, documents_with_children: 40, missing_documents: 83 },
    }),
    profileRow('old-contract_legal', 'contract_legal', { status: 'retired', created_at: '2026-10-01T00:00:00Z' }),
  );
  const active: Record<string, string> = {};
  const missing: Record<string, number | null> = {};
  for (const t of DOC_TYPES) {
    active[t] = 'legacy';
    missing[t] = 0;
  }
  active.contract_legal = 'p256-1024-contract_legal';
  missing.contract_legal = 3;
  return { success: true, active, missing_from_active: missing, profiles };
}

describe('chunking panel labels', () => {
  it('every key exists in en, zh and it, without a leftover placeholder for a missing var', () => {
    const { CHUNKING_LABELS } = loadChunkingPanel();
    const keys = new Set([...Object.keys(CHUNKING_LABELS.en), ...Object.keys(CHUNKING_LABELS.zh), ...Object.keys(CHUNKING_LABELS.it)]);
    expect(keys.size).toBeGreaterThan(100);
    for (const key of keys) {
      for (const locale of ['en', 'zh', 'it'] as const) expect(CHUNKING_LABELS[locale][key], `${locale} ${key}`).toBeTruthy();
    }
  });

  it('says point estimate and 95% upper bound in English', () => {
    const { chunkingLabel } = loadChunkingPanel();
    expect(chunkingLabel('report.rateSub', 'en')).toBe('point estimate, 95% upper bound');
    expect(chunkingLabel('cell.upper', 'en', { value: '28.8%' })).toBe('95% upper bound 28.8%');
  });
});

describe('profilesByDocType', () => {
  const { profilesByDocType, CHUNKING_DOC_TYPE_ORDER } = loadChunkingPanel();
  const groups = profilesByDocType(listBody());

  it('lists the six doc types in the fixed order and marks the active pointer', () => {
    expect(CHUNKING_DOC_TYPE_ORDER).toEqual(DOC_TYPES);
    expect(groups.map((g) => g.docType)).toEqual(DOC_TYPES);
    const contract = groups.find((g) => g.docType === 'contract_legal') as ProfileGroup;
    expect(contract.activeId).toBe('p256-1024-contract_legal');
    expect(contract.missingFromActive).toBe(3);
    expect(contract.onlyLegacy).toBe(false);
    expect(contract.rows.map((r) => r.id)).toEqual([
      'p256-1024-contract_legal',
      'p128-512-contract_legal',
      'p256-2048-contract_legal',
      'legacy',
      'old-contract_legal',
    ]);
    expect(contract.rows.map((r) => r.status)).toEqual(['active', 'ready', 'building', 'ready', 'retired']);
    expect(contract.rows.filter((r) => r.active).map((r) => r.id)).toEqual(['p256-1024-contract_legal']);
  });

  it('gives each row exactly one next step', () => {
    const contract = groups.find((g) => g.docType === 'contract_legal') as ProfileGroup;
    expect(contract.rows.map((r) => r.action)).toEqual([null, 'activate', 'continue', 'activate', null]);
    const fresh = profilesByDocType({
      active: { general: 'legacy' },
      missing_from_active: { general: 0 },
      profiles: [
        legacyRow('general'),
        profileRow('p1-general', 'general', { status: 'building', completeness: null }),
        profileRow('p2-general', 'general', { completeness: { current_ready_documents: 5, documents_with_children: 4, missing_documents: 1 } }),
      ],
    }).find((g) => g.docType === 'general') as ProfileGroup;
    expect(fresh.rows.map((r) => [r.id, r.action])).toEqual([
      ['legacy', null],
      ['p2-general', 'buildMissing'],
      ['p1-general', 'build'],
    ]);
  });

  it('a type with only legacy has no other rows; legacy never carries sizes, mode or preset', () => {
    const general = groups.find((g) => g.docType === 'general') as ProfileGroup;
    expect(general.onlyLegacy).toBe(true);
    for (const group of groups) {
      for (const row of group.rows.filter((r) => r.id === 'legacy')) {
        expect(row.childTokens).toBeUndefined();
        expect(row.parentTokens).toBeUndefined();
        expect(row.parentMode).toBeUndefined();
        expect(row.preset).toBeUndefined();
      }
    }
    expect(JSON.stringify(groups)).not.toContain('MARKER_ACTIVATED_BY');
  });
});

describe('coverageWarning', () => {
  const { profilesByDocType, coverageWarning } = loadChunkingPanel();
  const groups = profilesByDocType(listBody());

  it('is null when nothing is missing', () => {
    const general = groups.find((g) => g.docType === 'general') as ProfileGroup;
    expect(coverageWarning(general, 'en')).toBeNull();
  });

  it('names the count and the rebuild hint in en, zh and it, counts only', () => {
    const contract = groups.find((g) => g.docType === 'contract_legal') as ProfileGroup;
    for (const locale of ['en', 'zh', 'it'] as const) {
      const warning = coverageWarning(contract, locale);
      expect(warning?.count).toBe(3);
      expect(warning?.showBuild).toBe(true);
      expect(warning?.text).toContain('3');
      expect(warning?.text).toContain('p256-1024-contract_legal');
      expect(warning?.text).not.toMatch(/\{\w+\}/);
    }
    expect(coverageWarning(contract, 'en')?.text).toMatch(/Until the profile is rebuilt, questions about them are answered from legacy chunks/);
    expect(coverageWarning(contract, 'en')?.text).toMatch(/Build missing documents/);
    expect(coverageWarning(contract, 'zh')?.text).toContain('构建缺失文档');
    expect(coverageWarning(contract, 'it')?.text).toContain('Costruisci documenti mancanti');
  });

  it('says the count is unknown when the coverage has no row', () => {
    const contract = { ...(groups.find((g) => g.docType === 'contract_legal') as ProfileGroup), missingFromActive: null };
    const warning = coverageWarning(contract, 'en');
    expect(warning?.key).toBe('coverage.unknown');
    expect(warning?.showBuild).toBe(false);
  });
});

describe('refusalMessage (activation gate)', () => {
  const { refusalMessage } = loadChunkingPanel();
  const reasons = ['incomplete', 'open_gaps', 'no_evidence', 'eval_failed', 'stale_evidence', 'not_ready', 'ambiguous_profile'];

  it.each(reasons)('%s is a plain sentence in en, zh and it', (reason) => {
    for (const locale of ['en', 'zh', 'it'] as const) {
      const message = refusalMessage(reason, locale, { id: 'p256-1024-contract_legal', type: 'Contract' });
      expect(message.key).toBe(`gate.${reason}`);
      expect(message.text.length).toBeGreaterThan(30);
      expect(message.text).not.toMatch(/\{\w+\}/);
      expect(message.text).not.toBe(reason);
    }
  });

  it('no_evidence names the record-decision command as code', () => {
    const message = refusalMessage('no_evidence', 'en', { id: 'p1', type: 'General' });
    expect(message.segments).toContainEqual({ code: 'npm run rag:chunking -- record-decision <decision.json>' });
  });

  it('an unknown reason is shown as code inside a full sentence', () => {
    const message = refusalMessage('something_new', 'en', { id: 'p1', type: 'General' });
    expect(message.key).toBe('gate.other');
    expect(message.segments).toContainEqual({ code: 'something_new' });
    expect(message.text).toMatch(/Reload panel/);
  });
});

describe('reportRows and the sweep decisions', () => {
  const { reportRows, chunkingReportSlices, chunkingDecisionRows } = loadChunkingPanel();

  it('one row per profile with every CHK-05 metric and a 95% upper bound next to each refusal rate', () => {
    const rows = reportRows(REPORT, 'overall');
    expect(rows.map((r) => r.profileId)).toEqual(REPORT.profiles.map((p: { profile_id: string }) => p.profile_id));
    const overall = REPORT.profiles[1].metrics.overall;
    const row = rows[1];
    expect(row.recall).toBe(overall.recall_at_k.value);
    expect(row.mrr).toBe(overall.mrr.value);
    expect(row.falseRefusal).toEqual({ value: overall.false_refusal_rate.value, upper95: overall.false_refusal_rate.upper_95, n: overall.false_refusal_rate.n });
    expect(row.correctRefusal).toEqual({
      value: overall.correct_refusal_rate.value,
      upper95: overall.correct_refusal_rate.upper_95,
      n: overall.correct_refusal_rate.n,
    });
    expect(row.judge).toEqual({ skipped: true, value: null, n: 0 });
    expect(row.contextTokens).toBe(overall.context_tokens.value);
    expect(row.latencyP50).toBe(overall.latency_p50_ms.value);
    expect(row.latencyP95).toBe(overall.latency_p95_ms.value);
    expect(row.gate.kind).toBe('failed');
    expect(row.gate.regressions.length).toBe(3);
    expect(rows[0].gate.kind).toBe('baseline');
  });

  it('reads a doc type, a language or a question kind slice', () => {
    const byType = reportRows(REPORT, 'contract_legal');
    expect(byType[0].falseRefusal.upper95).toBe(REPORT.profiles[0].metrics.by_doc_type.contract_legal.false_refusal_rate.upper_95);
    expect(reportRows(REPORT, 'doc_type:contract_legal')).toEqual(byType);
    expect(reportRows(REPORT, 'language:it')[0].recall).toBe(REPORT.profiles[0].metrics.by_language.it.recall_at_k.value);
    expect(reportRows(REPORT, 'kind:clause')[0].mrr).toBe(REPORT.profiles[0].metrics.by_question_kind.clause.mrr.value);
    expect(reportRows(REPORT, 'language:xx')[0].recall).toBeNull();
  });

  it('offers overall, six doc types, the configured languages and the question kinds present', () => {
    const slices = chunkingReportSlices(REPORT, ['zh', 'en', 'it']).map((s) => s.value);
    expect(slices[0]).toBe('overall');
    expect(slices).toContain('doc_type:scanned_image');
    expect(slices.filter((v) => v.startsWith('language:'))).toEqual(['language:zh', 'language:en', 'language:it']);
    expect(slices).toContain('kind:clause');
  });

  it('offers no language slice before the languages answer has arrived', () => {
    const { resetChunkingLanguagesForTests } = loadChunkingPanel();
    resetChunkingLanguagesForTests();
    const slices = chunkingReportSlices(REPORT).map((s) => s.value);
    expect(slices.some((v) => v.startsWith('language:'))).toBe(false);
    expect(slices).toContain('doc_type:scanned_image');
  });

  it('one decision row per doc type, in the fixed order', () => {
    const rows = chunkingDecisionRows(DECISIONS);
    expect(rows.map((r) => r.docType)).toEqual(DOC_TYPES);
    expect(rows.find((r) => r.docType === 'contract_legal')?.decision?.profile_id).toBe('legacy');
    expect(rows.find((r) => r.docType === 'general')?.decision).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('report_hash');
    expect(JSON.stringify(rows)).not.toContain('fixture-demo');
  });
});

describe('language codes from the config server (D-06)', () => {
  const { chunkingLanguageCodesFrom, loadChunkingLanguages, resetChunkingLanguagesForTests, chunkingReportSlices } = loadChunkingPanel();
  const answer = { packs: [{ code: 'zh' }, { code: 'en' }, { code: 'it' }, { code: 'en' }, { code: '<b>' }, null] };

  it('reads the pack codes in order, dropping duplicates and malformed codes', () => {
    expect(chunkingLanguageCodesFrom(answer)).toEqual(['zh', 'en', 'it']);
    expect(chunkingLanguageCodesFrom({})).toBeNull();
    expect(chunkingLanguageCodesFrom({ packs: [] })).toBeNull();
  });

  it('fetches GET /api/config/languages once and caches the codes', async () => {
    resetChunkingLanguagesForTests();
    const calls: string[] = [];
    const fetchImpl = async (path: string) => {
      calls.push(path);
      return { ok: true, json: async () => answer };
    };
    const [a, b] = await Promise.all([loadChunkingLanguages(fetchImpl), loadChunkingLanguages(fetchImpl)]);
    expect(a).toEqual(['zh', 'en', 'it']);
    expect(b).toEqual(['zh', 'en', 'it']);
    await loadChunkingLanguages(fetchImpl);
    expect(calls).toEqual(['/api/config/languages']);
    expect(chunkingReportSlices(REPORT).filter((s) => s.group === 'language').map((s) => s.key)).toEqual(['zh', 'en', 'it']);
    resetChunkingLanguagesForTests();
  });

  it('a failed request leaves the codes unset and the next call tries again', async () => {
    resetChunkingLanguagesForTests();
    let attempts = 0;
    const failing = async () => {
      attempts += 1;
      throw new Error('offline');
    };
    expect(await loadChunkingLanguages(failing)).toBeNull();
    expect(await loadChunkingLanguages(async () => ({ ok: false, json: async () => ({}) }))).toBeNull();
    expect(attempts).toBe(1);
    expect(chunkingReportSlices(REPORT).some((s) => s.group === 'language')).toBe(false);
    expect(await loadChunkingLanguages(async () => ({ ok: true, json: async () => answer }))).toEqual(['zh', 'en', 'it']);
    resetChunkingLanguagesForTests();
  });
});

describe('new profile form findings', () => {
  const { chunkingFormFindings, chunkingSuggestedId } = loadChunkingPanel();
  const base = { docType: 'contract_legal', preset: 'custom', child: '256', parent: '1024', mode: 'structure', id: 'p256-1024-contract_legal' };

  it('suggests the sweep id', () => {
    expect(chunkingSuggestedId(256, 1024, 'contract_legal')).toBe('p256-1024-contract_legal');
  });

  it('a hard error blocks Create; warnings do not', () => {
    const hard = chunkingFormFindings({ ...base, parent: '400', mode: 'fixed' });
    expect(hard.errors).toEqual(['parent_below_twice_child']);
    expect(hard.blocking).toBe(true);
    const warn = chunkingFormFindings({ ...base, child: '128', parent: '1536', mode: 'fixed' });
    expect(warn.errors).toEqual([]);
    expect(warn.warnings).toEqual(['ratio_outside_4_8']);
    expect(warn.blocking).toBe(false);
    expect(warn.body).toEqual({
      id: 'p256-1024-contract_legal',
      doc_type: 'contract_legal',
      child_tokens: 128,
      parent_mode: 'fixed',
      parent_tokens: 1536,
      preset: 'custom',
    });
  });

  it('presets fix the sizes and structure parents', () => {
    const preset = chunkingFormFindings({ ...base, preset: '256/2048', child: '1', parent: '1', mode: 'fixed' });
    expect(preset.body).toMatchObject({ child_tokens: 256, parent_tokens: 2048, parent_mode: 'structure', preset: '256/2048' });
    expect(preset.blocking).toBe(false);
  });

  it('field-format errors block Create', () => {
    expect(chunkingFormFindings({ ...base, child: '2.5' }).fieldErrors.child).toBe('form.number');
    expect(chunkingFormFindings({ ...base, id: 'Bad ID' }).fieldErrors.id).toBe('form.idInvalid');
    expect(chunkingFormFindings({ ...base, id: 'legacy' }).fieldErrors.id).toBe('form.idReserved');
    expect(chunkingFormFindings({ ...base, parent: '' }).blocking).toBe(true);
    expect(chunkingFormFindings({ ...base, parent: '', mode: 'fixed' }).errors).toEqual(['parent_tokens_required']);
  });
});

describe('runChunkingBuild (UI-SPEC section 14 row 2)', () => {
  const { runChunkingBuild } = loadChunkingPanel();
  const step = (docsDone: number, more: boolean, extra: Record<string, unknown> = {}): FetchResult => ({
    ok: true,
    status: 200,
    body: { success: true, run_id: 'run', status: more ? 'running' : 'completed', docsDone, docsTotal: 10, gaps: 0, gap_reasons: {}, more, ...extra },
  });

  it('keeps going while more is true, even after a gap', async () => {
    const answers = [step(3, true, { gaps: 1, gap_reasons: { failed: 1 } }), step(6, true, { gaps: 1, gap_reasons: { failed: 1 } }), step(10, false, { status: 'incomplete', gaps: 1, gap_reasons: { failed: 1 } })];
    const seen: unknown[] = [];
    const result = await runChunkingBuild({ post: async () => answers.shift() as FetchResult, onStep: (a) => seen.push(a.docsDone) });
    expect(seen).toEqual([3, 6, 10]);
    expect(result.outcome).toBe('incomplete');
  });

  it('stops on completed, failed, pause, stall, 499 and errors', async () => {
    expect((await runChunkingBuild({ post: async () => step(10, false) })).outcome).toBe('completed');
    expect((await runChunkingBuild({ post: async () => step(4, false, { status: 'failed' }) })).outcome).toBe('failed');
    let n = 0;
    const paused = await runChunkingBuild({ post: async () => step((n += 1), true), shouldPause: () => n >= 2 });
    expect(paused.outcome).toBe('paused');
    expect(n).toBe(2);
    let calls = 0;
    const stalled = await runChunkingBuild({
      post: async () => {
        calls += 1;
        return step(5, true);
      },
    });
    expect(stalled.outcome).toBe('stalled');
    expect(calls).toBe(3);
    expect((await runChunkingBuild({ post: async () => ({ ok: false, status: 499, body: { error: 'build_aborted' } }) })).outcome).toBe('paused');
    const failed = await runChunkingBuild({ post: async () => ({ ok: false, status: 503, body: { error: 'chunking_admin_unavailable' } }) });
    expect(failed.outcome).toBe('error');
    const thrown = await runChunkingBuild({
      post: async () => {
        throw new Error('network');
      },
    });
    expect(thrown.outcome).toBe('error');
    expect(thrown.result).toMatchObject({ thrown: true });
  });
});

describe('mapChunkingError (UI-SPEC section 8)', () => {
  const { mapChunkingError } = loadChunkingPanel();

  it('401 and 403 give the shared sign-in message with the app address filled in', () => {
    for (const status of [401, 403]) {
      const mapped = mapChunkingError({ ok: false, status, body: { error: 'Admin authentication required' } }, 'list', 'en', { appUrl: 'https://app.example.test' });
      expect(mapped.signIn).toBe(true);
      expect(mapped.text).toContain('https://app.example.test');
      expect(mapped.text).not.toContain('{appUrl}');
      expect(mapped.text).not.toMatch(/password/i);
    }
  });

  it('maps the per-route 503, 500, 404, 409 and 400 answers', () => {
    const r = (status: number, body: Record<string, unknown>) => ({ ok: false, status, body });
    expect(mapChunkingError(r(503, { error: 'chunking_admin_unavailable' }), 'list', 'en').key).toBe('error.listUnavailable');
    expect(mapChunkingError(r(503, { error: 'chunking_admin_unavailable' }), 'validate', 'en').key).toBe('form.serverUnchecked');
    expect(mapChunkingError(r(503, { error: 'chunking_admin_unavailable' }), 'create', 'en').key).toBe('error.createUnavailable');
    expect(mapChunkingError(r(503, { error: 'chunking_admin_unavailable' }), 'build', 'en').key).toBe('build.unavailable');
    expect(mapChunkingError(r(503, { error: 'chunking_admin_unavailable' }), 'activate', 'en').key).toBe('error.changeUnknown');
    expect(mapChunkingError({ thrown: true }, 'rollback', 'en').key).toBe('error.changeUnknown');
    expect(mapChunkingError({ thrown: true }, 'build', 'en').key).toBe('build.network');
    expect(mapChunkingError(r(500, { error: 'chunking_report_invalid' }), 'report', 'en').key).toBe('report.unreadable');
    expect(mapChunkingError(r(500, { error: 'chunking_report_unavailable' }), 'report', 'en').key).toBe('report.unavailable');
    expect(mapChunkingError(r(404, { error: 'profile_not_found' }), 'activate', 'en')).toMatchObject({ key: 'error.profileGone', reload: true });
    expect(mapChunkingError(r(409, { error: 'profile_exists' }), 'create', 'en')).toMatchObject({ key: 'error.profileExists', field: 'id' });
    expect(mapChunkingError(r(409, { error: 'activation_refused', reason: 'no_evidence' }), 'activate', 'en', { id: 'p1', type: 'General' })).toMatchObject({
      key: 'gate.no_evidence',
      reload: true,
    });
    expect(mapChunkingError(r(409, { error: 'rollback_refused', reason: 'no_previous' }), 'rollback', 'en', { type: 'General' }).key).toBe('gate.no_previous');
    expect(mapChunkingError(r(409, { error: 'build_refused', reason: 'profile_retired' }), 'build', 'en').key).toBe('build.refused.profile_retired');
    const other = mapChunkingError(r(409, { error: 'build_refused', reason: 'odd' }), 'build', 'en');
    expect(other.key).toBe('build.refused.other');
    expect(other.segments).toContainEqual({ code: 'odd' });
    expect(mapChunkingError(r(499, { error: 'build_aborted' }), 'build', 'en').paused).toBe(true);
    const findings = mapChunkingError(
      r(400, { error: 'invalid_chunking_profile', details: [{ path: 'child_tokens', message: 'child_exceeds_embedding_input' }], warnings: [] }),
      'create',
      'en',
    );
    expect(findings.findings).toEqual(['child_exceeds_embedding_input']);
    expect(mapChunkingError(r(400, { error: 'invalid_chunking_profile', details: [{ path: '', message: 'rejected_by_database' }] }), 'create', 'en').key).toBe(
      'error.rejected',
    );
    expect(mapChunkingError(r(400, { error: 'Invalid request data', details: [{ path: 'parent_tokens', message: 'x' }] }), 'create', 'en')).toMatchObject({
      key: 'error.invalidField',
      field: 'parent_tokens',
    });
    expect(mapChunkingError(r(418, {}), 'list', 'en').text).toContain('418');
  });
});

describe('chunking-profiles.js request and storage rules (T-04-77, T-04-78)', () => {
  const code = fs.readFileSync(path.join(panelDir, 'chunking-profiles.js'), 'utf8');

  it('calls /api/rag/admin/chunking-profiles through ragFetch and only the config languages answer with fetch', () => {
    expect(code).toContain('/api/rag/admin/chunking-profiles');
    const bareFetches = [...code.matchAll(/\bfetch\(/g)];
    expect(bareFetches.length).toBe(1);
    expect(code).toMatch(/this\.languagesFetcher = d\.languagesFetcher \|\| \(\(apiPath, init\) => fetch\(apiPath, init\)\);/);
    const paths = [...code.matchAll(/['`](\/api\/[^'`$]*)/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith('/api/rag/admin/chunking-profiles') || p === '/api/config/languages').toBe(true);
    }
  });

  it('never parses markup, stores tokens or sends Authorization', () => {
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(code).not.toMatch(/Authorization/);
    expect(code).not.toMatch(/type\s*=\s*['"]password/);
  });
});

describe('ChunkingProfilesPanel renders server strings as text only', () => {
  it('a profile id and a report note carrying markup create no element (T-04-78) and hidden fields stay hidden', async () => {
    await withFakeDocument(async (doc) => {
      const { ChunkingProfilesPanel } = loadChunkingPanel();
      const list = listBody();
      (list.profiles as Array<Record<string, unknown>>).push(profileRow(XSS, 'general', { activated_by: 'MARKER_ACTIVATED_BY' }));
      const report: Record<string, unknown> = {
        ...REPORT,
        config_hash: 'MARKER_CONFIG_HASH',
        notes: [...REPORT.notes, XSS],
        profiles: [...REPORT.profiles, { ...REPORT.profiles[1], profile_id: XSS }],
      };
      const { fetcher, calls } = fakeFetcher({
        'GET /api/rag/admin/chunking-profiles': { ok: true, status: 200, body: list },
        'GET /api/rag/admin/chunking-profiles/report': { ok: true, status: 200, body: { success: true, report, decisions: DECISIONS } },
        'POST /api/rag/admin/chunking-profiles/validate': { ok: true, status: 200, body: { success: true, valid: true, errors: [], warnings: [] } },
      });
      const root = doc.createElement('section');
      root.id = 'rag-administration-chunking';
      for (const attr of ['data-chunking-title', 'data-chunking-description', 'data-chunking-alert', 'data-chunking-content', 'data-chunking-status']) {
        const el = doc.createElement(attr === 'data-chunking-title' ? 'h3' : 'div');
        el.setAttribute(attr, '');
        root.appendChild(el);
      }
      doc.body.appendChild(root);
      doc.created = [];

      const panel = new ChunkingProfilesPanel(root, { fetcher, locale: 'en', appUrl: 'https://app.example.test' });
      await panel.mount();
      await flush();
      panel.selectTab('report');
      await flush();

      expect(doc.created).not.toContain('img');
      expect(doc.created).not.toContain('script');
      const texts = textNodes(root);
      expect(texts.filter((t) => t.includes(XSS)).length).toBeGreaterThanOrEqual(3);
      const all = texts.join('\n');
      expect(all).toContain('p256-1024-contract_legal');
      expect(all).toContain('Documents missing from the active profile p256-1024-contract_legal: 3.');
      expect(all).not.toContain('MARKER_ACTIVATED_BY');
      expect(all).not.toContain('MARKER_CONFIG_HASH');
      expect(all).not.toContain('fixture-demo');
      expect(all).not.toContain(DECISIONS[0].report_hash);
      for (const call of calls) expect(call.path.startsWith('/api/rag/admin/chunking-profiles')).toBe(true);
    });
  });

  it('shows the language slices only once the config languages answer has arrived', async () => {
    await withFakeDocument(async (doc) => {
      const { ChunkingProfilesPanel, resetChunkingLanguagesForTests } = loadChunkingPanel() as ReturnType<typeof loadChunkingPanel> & {
        ChunkingProfilesPanel: new (root: unknown, deps: Record<string, unknown>) => { mount: () => Promise<void>; selectTab: (name: string) => void };
      };
      resetChunkingLanguagesForTests();
      const { fetcher } = fakeFetcher({
        'GET /api/rag/admin/chunking-profiles': { ok: true, status: 200, body: listBody() },
        'GET /api/rag/admin/chunking-profiles/report': { ok: true, status: 200, body: { success: true, report: REPORT, decisions: DECISIONS } },
      });
      let release: (value: unknown) => void = () => {};
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const languageCalls: string[] = [];
      const languagesFetcher = async (apiPath: string) => {
        languageCalls.push(apiPath);
        await pending;
        return { ok: true, json: async () => ({ packs: [{ code: 'zh' }, { code: 'en' }, { code: 'it' }] }) };
      };
      const root = doc.createElement('section');
      for (const attr of ['data-chunking-title', 'data-chunking-description', 'data-chunking-alert', 'data-chunking-content', 'data-chunking-status']) {
        const el = doc.createElement(attr === 'data-chunking-title' ? 'h3' : 'div');
        el.setAttribute(attr, '');
        root.appendChild(el);
      }
      doc.body.appendChild(root);
      const panel = new ChunkingProfilesPanel(root, { fetcher, languagesFetcher, locale: 'en' });
      const mounted = panel.mount();
      await flush();
      panel.selectTab('report');
      await flush();
      const before = textNodes(root);
      expect(before).not.toContain('Italian');
      expect(before).not.toContain('Chinese');
      release(null);
      await mounted;
      await flush();
      const after = textNodes(root);
      expect(after).toContain('Chinese');
      expect(after).toContain('English');
      expect(after).toContain('Italian');
      expect(languageCalls).toEqual(['/api/config/languages']);
      resetChunkingLanguagesForTests();
    });
  });

  it('401 replaces the panel with the sign-in message and no password field', async () => {
    await withFakeDocument(async (doc) => {
      const { ChunkingProfilesPanel } = loadChunkingPanel();
      const denied = { ok: false, status: 401, body: { error: 'Admin authentication required' } };
      const { fetcher } = fakeFetcher({
        'GET /api/rag/admin/chunking-profiles': denied,
        'GET /api/rag/admin/chunking-profiles/report': denied,
      });
      const root = doc.createElement('section');
      for (const attr of ['data-chunking-title', 'data-chunking-description', 'data-chunking-alert', 'data-chunking-content', 'data-chunking-status']) {
        const el = doc.createElement('div');
        el.setAttribute(attr, '');
        root.appendChild(el);
      }
      doc.body.appendChild(root);
      const panel = new ChunkingProfilesPanel(root, { fetcher, locale: 'en', appUrl: 'https://app.example.test' });
      await panel.mount();
      await flush();
      const all = textNodes(root).join('\n');
      expect(all).toContain('https://app.example.test');
      expect(all).not.toContain('{appUrl}');
      expect(root.querySelectorAll('input').length).toBe(0);
      expect((root.querySelector('[data-chunking-content]') as FakeElement).hidden).toBe(true);
    });
  });
});

function chunkingRoot(doc: FakeDocument): FakeElement {
  const root = doc.createElement('section');
  root.id = 'rag-administration-chunking';
  for (const attr of ['data-chunking-title', 'data-chunking-description', 'data-chunking-alert', 'data-chunking-content', 'data-chunking-status']) {
    const el = doc.createElement('div');
    el.setAttribute(attr, '');
    root.appendChild(el);
  }
  doc.body.appendChild(root);
  return root;
}

function buttonByText(root: FakeElement, text: string): FakeElement {
  const match = root.querySelectorAll('button').find((b) => b.textContent.includes(text));
  if (!match) throw new Error(`no button ${text}`);
  return match;
}

describe('ChunkingProfilesPanel flows', () => {
  const reportRoute = { ok: true, status: 200, body: { success: true, report: REPORT, decisions: DECISIONS } };

  it('the form disables Create on a hard error and keeps it enabled for warnings', async () => {
    await withFakeDocument(async (doc) => {
      const { ChunkingProfilesPanel } = loadChunkingPanel();
      const { fetcher } = fakeFetcher({
        'GET /api/rag/admin/chunking-profiles': { ok: true, status: 200, body: listBody() },
        'GET /api/rag/admin/chunking-profiles/report': reportRoute,
        'POST /api/rag/admin/chunking-profiles/validate': { ok: true, status: 200, body: { success: true, valid: true, errors: [], warnings: ['top_k_parent_over_budget'] } },
      });
      const root = chunkingRoot(doc);
      const panel = new ChunkingProfilesPanel(root, { fetcher, locale: 'en' });
      await panel.mount();
      await flush();
      buttonByText(root, 'New profile').click();
      const create = buttonByText(root, 'Create profile');
      expect(create.disabled).toBe(false);
      expect((root.querySelector('#chunking-form-id') as FakeElement).value).toBe('p256-1024-general');

      const custom = root.querySelector('#chunking-form-preset-custom') as FakeElement;
      custom.checked = true;
      custom.dispatch('change');
      const parent = root.querySelector('#chunking-form-parent') as FakeElement;
      parent.value = '400';
      parent.dispatch('input');
      expect(create.disabled).toBe(true);
      expect(parent.getAttribute('aria-invalid')).toBe('true');
      expect(textNodes(root).join(' ')).toContain('The parent size must be at least twice the child size: 512 or more.');

      parent.value = '1536';
      parent.dispatch('input');
      expect(create.disabled).toBe(false);
      expect((root.querySelector('#chunking-form-id') as FakeElement).value).toBe('p256-1536-general');
    });
  });

  it('Build missing documents loops through gaps and reports them by reason', async () => {
    await withFakeDocument(async (doc) => {
      const { ChunkingProfilesPanel } = loadChunkingPanel();
      const steps = [
        { ok: true, status: 200, body: { success: true, run_id: 'MARKER_RUN', status: 'running', docsDone: 1, docsTotal: 3, gaps: 1, gap_reasons: { no_parse_output: 1 }, more: true } },
        { ok: true, status: 200, body: { success: true, run_id: 'MARKER_RUN', status: 'incomplete', docsDone: 3, docsTotal: 3, gaps: 1, gap_reasons: { no_parse_output: 1 }, more: false } },
      ];
      const { fetcher, calls } = fakeFetcher({
        'GET /api/rag/admin/chunking-profiles': { ok: true, status: 200, body: listBody() },
        'GET /api/rag/admin/chunking-profiles/report': reportRoute,
        'POST /api/rag/admin/chunking-profiles/p256-1024-contract_legal/build': () => steps.shift() as FetchResult,
      });
      const root = chunkingRoot(doc);
      const panel = new ChunkingProfilesPanel(root, { fetcher, locale: 'en' });
      await panel.mount();
      await flush();
      buttonByText(root, 'Build missing documents').click();
      await flush(20);
      const builds = calls.filter((c) => c.path.endsWith('/build'));
      expect(builds.length).toBe(2);
      expect(JSON.parse(builds[0].body as string)).toEqual({ doc_type: 'contract_legal' });
      const all = textNodes(root).join(' ');
      expect(all).toContain('Build finished, but some documents were left out: 1.');
      expect(all).toContain('npm run rag:rechunk -- --profile p256-1024-contract_legal --dry-run');
      expect(all).not.toContain('MARKER_RUN');
    });
  });

  it('Activate asks for confirmation and shows the gate refusal sentence on 409', async () => {
    await withFakeDocument(async (doc) => {
      const { ChunkingProfilesPanel } = loadChunkingPanel();
      const { fetcher, calls } = fakeFetcher({
        'GET /api/rag/admin/chunking-profiles': { ok: true, status: 200, body: listBody() },
        'GET /api/rag/admin/chunking-profiles/report': reportRoute,
        'POST /api/rag/admin/chunking-profiles/p128-512-contract_legal/activate': {
          ok: false,
          status: 409,
          body: { success: false, error: 'activation_refused', reason: 'no_evidence' },
        },
      });
      const root = chunkingRoot(doc);
      const panel = new ChunkingProfilesPanel(root, { fetcher, locale: 'en' });
      await panel.mount();
      await flush();
      const activate = root.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Activate profile p128-512-contract_legal for Contract & legal');
      expect(activate).toBeTruthy();
      activate?.click();
      const dialog = doc.body.querySelector('dialog') as FakeElement;
      expect(dialog.open).toBe(true);
      expect(doc.activeElement?.textContent).toBe('Keep current profile');
      const backdrop = dialog.querySelector('form') as FakeElement;
      expect(backdrop.querySelector('button')?.getAttribute('aria-label')).toBe('Keep current profile');
      expect(calls.some((c) => c.path.endsWith('/activate'))).toBe(false);
      buttonByText(dialog, 'Activate profile').click();
      await flush(20);
      const activation = calls.find((c) => c.path.endsWith('/activate'));
      expect(JSON.parse(activation?.body as string)).toEqual({ doc_type: 'contract_legal' });
      const all = textNodes(root).join(' ');
      expect(all).toContain('Not activated. No sweep decision is recorded in the database for p128-512-contract_legal.');
      expect(all).toContain('npm run rag:chunking -- record-decision <decision.json>');
      expect(root.querySelectorAll('div').some((el) => el.getAttribute('role') === 'alert')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Refusal calibration panel (Task 3)

interface RefusalCellRow {
  provider: string;
  model: string;
  language: string;
  pairing: string;
  statusKey: string;
  statusLabel: string;
  statusHint: string;
  fixture: boolean;
  fixtureLabel: string | null;
  stale: boolean;
  staleLabel: string | null;
  threshold: string;
  dev: { falseRefusal: Record<string, unknown>; correctRefusal: Record<string, unknown> };
  holdout: { falseRefusal: Record<string, unknown>; correctRefusal: Record<string, unknown> };
  recorded: { iso: string; text: string } | null;
}

function loadRefusalPanel() {
  return require('../../scripts/config-ui/rag-panels/refusal-calibration.js') as {
    REFUSAL_LABELS: Record<Locale, Record<string, string>>;
    refusalLabel: (key: string, locale: Locale, vars?: Record<string, unknown>) => string;
    cellRows: (status: Record<string, unknown>, locale: Locale) => RefusalCellRow[];
    refusalWarningView: (
      warning: Record<string, unknown>,
      locale: Locale,
    ) => Message & { code: string; tone: string; icon: string; lang?: string; missing: Array<{ text: string }> };
    refusalSummary: (
      status: Record<string, unknown>,
      locale: Locale,
      page?: { refusalThreshold?: boolean | null; reranker?: string | null },
    ) => { notes: Message[]; models: unknown[] | null; items: Array<{ key: string; value: string }> };
    mapRefusalError: (result: Record<string, unknown>, locale: Locale, ctx?: Record<string, unknown>) => Message & { signIn?: boolean };
    RefusalCalibrationPanel: new (
      root: unknown,
      deps: { fetcher: Fetcher; locale?: Locale; appUrl?: string; page?: { refusalThreshold?: boolean | null; reranker?: string | null } },
    ) => { mount: () => Promise<void> };
  };
}

const THRESHOLDS = RefusalThresholdsSchema.parse(JSON.parse(fs.readFileSync(path.join(repoRoot, 'eval/config/refusal-thresholds.json'), 'utf8')));

function statusFor(env: Record<string, string>, cells = THRESHOLDS.cells ?? []): Record<string, unknown> {
  resetRagConfigForTests();
  const status = refusalCalibrationStatus({ ...THRESHOLDS, cells }, loadRagConfig({ RAG_PIPELINE: 'v2', ...env }));
  resetRagConfigForTests();
  return JSON.parse(JSON.stringify({ success: true, ...status })) as Record<string, unknown>;
}

describe('refusal calibration labels', () => {
  it('every key exists in en, zh and it', () => {
    const { REFUSAL_LABELS } = loadRefusalPanel();
    const keys = new Set([...Object.keys(REFUSAL_LABELS.en), ...Object.keys(REFUSAL_LABELS.zh), ...Object.keys(REFUSAL_LABELS.it)]);
    expect(keys.size).toBeGreaterThan(60);
    for (const key of keys) for (const locale of ['en', 'zh', 'it'] as const) expect(REFUSAL_LABELS[locale][key], `${locale} ${key}`).toBeTruthy();
  });

  it('uses the words point estimate and 95% upper bound and never a target claim', () => {
    const { REFUSAL_LABELS, refusalLabel } = loadRefusalPanel();
    expect(refusalLabel('col.falseRefusalSub', 'en')).toBe('point estimate, 95% upper bound');
    expect(refusalLabel('cell.upper', 'en', { value: '77.6%' })).toBe('95% upper bound 77.6%');
    const all = Object.values(REFUSAL_LABELS.en).join('\n');
    expect(all).not.toMatch(/at most|≤|meets the target|within target/i);
  });
});

describe('cellRows', () => {
  const { cellRows } = loadRefusalPanel();
  const status = statusFor({ RAG_RERANKER: 'cohere', RAG_REFUSAL_THRESHOLD: 'true' });
  const rows = cellRows(status, 'en');
  const cells = (status.cells as Array<Record<string, any>>);

  it('one row per cell, in the route order, with status, source, threshold and both splits', () => {
    expect(rows.length).toBe(cells.length);
    rows.forEach((row, i) => {
      const cell = cells[i];
      expect(row.model).toBe(cell.model);
      expect(row.statusKey).toBe(cell.status);
      expect(row.fixture).toBe(cell.source === 'fixture');
      expect(row.fixtureLabel?.toLowerCase()).toBe('fixture, eval only');
      expect(row.threshold).toBe(cell.threshold === null ? 'None' : cell.threshold.toFixed(3));
    });
  });

  it('a false-refusal rate carries its point estimate, 95% upper bound and n; an empty split says so', () => {
    const index = cells.findIndex((c) => c.dev.answerable_count > 0);
    const dev = rows[index].dev.falseRefusal;
    expect(dev.empty).toBe(false);
    expect(dev.point).toBe(new Intl.NumberFormat('en', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(cells[index].dev.false_refusal_point_estimate));
    expect(dev.upper).toBe(new Intl.NumberFormat('en', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(cells[index].dev.false_refusal_upper_bound_95));
    expect(dev.n).toBe(String(cells[index].dev.answerable_count));
    const emptyIndex = cells.findIndex((c) => c.holdout.answerable_count === 0);
    expect(rows[emptyIndex].holdout.falseRefusal).toMatchObject({ empty: true, text: 'No answerable items' });
  });

  it('marks stale cells and hides the raw key and per-cell versions', () => {
    const stale = cellRows(statusFor({ RAG_RERANKER: 'cohere' }, (THRESHOLDS.cells ?? []).map((c) => ({ ...c, tokenizer_version: 99 }))), 'en');
    expect(stale.every((r) => r.stale && r.staleLabel === 'Stale')).toBe(true);
    const json = JSON.stringify(rows);
    for (const cell of cells) expect(json).not.toContain(cell.key);
    expect(json).not.toContain('tokenizer_version');
    expect(json).not.toContain('holdout_evaluations');
  });
});

describe('refusal warnings', () => {
  const { refusalWarningView } = loadRefusalPanel();

  it('each warning code is a sentence in en, zh and it', () => {
    const warnings = [
      { code: 'refusal_on_without_calibrated_cell', languages: ['zh', 'en'], missing: [{ tier: 'chat', model: 'rerank-v3.5', query_language: 'zh' }], message: 'x' },
      { code: 'fixture_cells_only', message: 'x' },
      { code: 'stale_cells', keys: ['a', 'b'], message: 'x' },
      { code: 'relative_reranker', provider: 'local_bm25', message: 'x' },
      { code: 'thresholds_invalid', message: 'x' },
    ];
    for (const warning of warnings) {
      for (const locale of ['en', 'zh', 'it'] as const) {
        const view = refusalWarningView(warning, locale);
        expect(view.key).toBe(`warning.${warning.code}`);
        expect(view.text.length).toBeGreaterThan(40);
        expect(view.text).not.toMatch(/\{\w+\}/);
      }
    }
    expect(refusalWarningView(warnings[2], 'en').text).toContain(': 2.');
    expect(refusalWarningView(warnings[2], 'en').text).not.toContain('a, b');
    expect(refusalWarningView(warnings[3], 'en').text).toContain('Local BM25');
    expect(refusalWarningView(warnings[4], 'en').tone).toBe('error');
    expect(refusalWarningView(warnings[1], 'en').tone).toBe('info');
  });

  it('refusal_on_without_calibrated_cell names the languages that fall back to the similarity floor and lists what is missing', () => {
    const view = refusalWarningView(
      { code: 'refusal_on_without_calibrated_cell', languages: ['zh', 'it'], missing: [{ tier: 'voice', model: 'rerank-v3.5', query_language: 'it' }], message: 'x' },
      'en',
    );
    expect(view.text).toContain('Chinese and Italian');
    expect(view.text).toContain('similarity floor');
    expect(view.missing.map((m) => m.text)).toEqual(['Voice (fast tier): rerank-v3.5, Italian']);
    expect(view.segments).toContainEqual({ code: 'python -m rag_eval.calibrate refusal' });
  });

  it('an unknown code shows the route message as English text', () => {
    const view = refusalWarningView({ code: 'something_new', message: 'Route says so.' }, 'zh');
    expect(view.text).toBe('Route says so.');
    expect(view.lang).toBe('en');
  });
});

describe('refusal summary notes', () => {
  const { refusalSummary } = loadRefusalPanel();

  it('notes legacy pipeline, refusal off, and saved settings that differ from the running value', () => {
    resetRagConfigForTests();
    const legacy = JSON.parse(JSON.stringify(refusalCalibrationStatus(THRESHOLDS, loadRagConfig({ RAG_PIPELINE: 'legacy' })))) as Record<string, unknown>;
    resetRagConfigForTests();
    const view = refusalSummary(legacy, 'en', { refusalThreshold: true, reranker: 'voyage' });
    const keys = view.notes.map((n) => n.key);
    expect(keys).toEqual(['note.legacyPipeline', 'note.refusalOff', 'note.pending', 'note.pendingReranker']);
    expect(view.notes[2].text).toBe('Settings show threshold refusal On; the app uses Off until it restarts with the saved value.');
    expect(view.models).toBeNull();
    const same = refusalSummary(statusFor({ RAG_RERANKER: 'cohere', RAG_REFUSAL_THRESHOLD: 'true' }), 'en', { refusalThreshold: true, reranker: 'cohere' });
    expect(same.notes).toEqual([]);
    expect(same.models).not.toBeNull();
  });
});

describe('mapRefusalError', () => {
  const { mapRefusalError } = loadRefusalPanel();
  it('maps 401, 403, 503, 500 and network failures', () => {
    const signIn = mapRefusalError({ ok: false, status: 401, body: {} }, 'en', { appUrl: 'https://app.example.test' });
    expect(signIn.signIn).toBe(true);
    expect(signIn.text).toContain('https://app.example.test');
    expect(mapRefusalError({ ok: false, status: 403, body: {} }, 'en').signIn).toBe(true);
    expect(mapRefusalError({ ok: false, status: 503, body: { error: 'Admin verification is unavailable' } }, 'en').key).toBe('error.unavailable');
    expect(mapRefusalError({ ok: false, status: 500, body: { error: 'refusal_status_unavailable' } }, 'en').key).toBe('error.statusUnreadable');
    expect(mapRefusalError({ thrown: true }, 'en').key).toBe('error.network');
  });
});

describe('refusal-calibration.js is read-only (D-17)', () => {
  const code = fs.readFileSync(path.join(panelDir, 'refusal-calibration.js'), 'utf8');

  it('sends only GET /api/rag/admin/refusal-calibration and reads only the two page switches', () => {
    expect(code).toContain('95%');
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/);
    const paths = [...code.matchAll(/['`](\/api\/[^'`$]*)/g)].map((m) => m[1]);
    expect(paths).toEqual(['/api/rag/admin/refusal-calibration']);
    const ids = [...code.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).filter((id) => /^[A-Z_]+$/.test(id));
    expect(new Set(ids)).toEqual(new Set(['RAG_REFUSAL_THRESHOLD', 'RAG_RERANKER']));
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/localStorage|sessionStorage|document\.cookie|Authorization/);
    expect(code).not.toMatch(/(KEY|SECRET|TOKEN|PASSWORD)['"]/);
  });

  it('renders no control that edits a threshold, and markup in a model id or warning message stays text', async () => {
    await withFakeDocument(async (doc) => {
      const { RefusalCalibrationPanel } = loadRefusalPanel();
      const status = statusFor({ RAG_RERANKER: 'cohere', RAG_REFUSAL_THRESHOLD: 'true' });
      (status.cells as Array<Record<string, unknown>>)[0].model = XSS;
      (status.cells as Array<Record<string, unknown>>)[0].key = 'MARKER_CELL_KEY';
      status.config_hash = 'MARKER_CONFIG_HASH';
      (status.warnings as Array<Record<string, unknown>>).push({ code: 'brand_new_warning', message: XSS });
      const { fetcher, calls } = fakeFetcher({ 'GET /api/rag/admin/refusal-calibration': { ok: true, status: 200, body: status } });
      const root = doc.createElement('section');
      for (const attr of ['data-refusal-title', 'data-refusal-description', 'data-refusal-alert', 'data-refusal-content', 'data-refusal-status']) {
        const el = doc.createElement('div');
        el.setAttribute(attr, '');
        root.appendChild(el);
      }
      doc.body.appendChild(root);
      doc.created = [];
      const panel = new RefusalCalibrationPanel(root, { fetcher, locale: 'en', page: { refusalThreshold: true, reranker: 'cohere' } });
      await panel.mount();
      await flush();
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/rag/admin/refusal-calibration']);
      expect(doc.created).not.toContain('img');
      for (const tag of ['input', 'select', 'textarea']) expect(root.querySelectorAll(tag).length).toBe(0);
      expect(root.querySelectorAll('button').map((b) => b.textContent.trim())).toEqual(['Refresh status']);
      const texts = textNodes(root);
      expect(texts.filter((t) => t.includes(XSS)).length).toBeGreaterThanOrEqual(2);
      const all = texts.join('\n');
      expect(all).toContain('Fixture, eval only');
      expect(all).toContain('95% upper bound');
      expect(all).toContain('point estimate');
      expect(all).not.toContain('MARKER_CELL_KEY');
      expect(all).not.toContain('MARKER_CONFIG_HASH');
      const status2 = textNodes(root.querySelector('[data-refusal-status]') as FakeElement).join('');
      expect(status2).toMatch(/Thresholds: \d+\. Warnings: \d+\./);
    });
  });

  it('401 shows the sign-in message', async () => {
    await withFakeDocument(async (doc) => {
      const { RefusalCalibrationPanel } = loadRefusalPanel();
      const { fetcher } = fakeFetcher({ 'GET /api/rag/admin/refusal-calibration': { ok: false, status: 401, body: { error: 'Admin authentication required' } } });
      const root = doc.createElement('section');
      for (const attr of ['data-refusal-title', 'data-refusal-description', 'data-refusal-alert', 'data-refusal-content', 'data-refusal-status']) {
        const el = doc.createElement('div');
        el.setAttribute(attr, '');
        root.appendChild(el);
      }
      doc.body.appendChild(root);
      const panel = new RefusalCalibrationPanel(root, { fetcher, locale: 'en', appUrl: 'https://app.example.test' });
      await panel.mount();
      await flush();
      expect(textNodes(root).join(' ')).toContain('https://app.example.test');
      expect((root.querySelector('[data-refusal-content]') as FakeElement).hidden).toBe(true);
    });
  });
});

describe('index.html mounts both panels and the pointer', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'scripts/config-ui/index.html'), 'utf8');
  it('loads the three scripts once each after ingestion.js, in order', () => {
    const order = ['rag-panels/ingestion.js', 'rag-panels/chunking-validate.js', 'rag-panels/chunking-profiles.js', 'rag-panels/refusal-calibration.js'];
    const positions = order.map((src) => html.indexOf(`<script src="${src}"></script>`));
    for (const src of order) expect(html.split(`<script src="${src}"></script>`).length - 1).toBe(1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('has both sections and the pointer next to the refusal switch, without changing the switch', () => {
    expect(html).toContain('id="rag-administration-chunking"');
    expect(html).toContain('id="rag-administration-refusal"');
    expect(html.split('id="RAG_REFUSAL_THRESHOLD"').length - 1).toBe(1);
    const afterSwitch = html.slice(html.indexOf('id="RAG_REFUSAL_THRESHOLD"'), html.indexOf('id="RAG_CONTEXT_EDGE_ORDER"'));
    expect(afterSwitch).toContain('data-refusal-pointer');
  });
});
