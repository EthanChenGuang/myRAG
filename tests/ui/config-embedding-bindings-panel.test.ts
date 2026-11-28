import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, XSS_PAYLOAD, injectedElements } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);
const PANEL = path.resolve(import.meta.dirname, '../../scripts/config-ui/rag-panels/embedding-bindings.js');
const INDEX = path.resolve(import.meta.dirname, '../../scripts/config-ui/index.html');

const TYPE_A = 'doc_type_a';
const TYPE_B = 'doc_type_b';
const TENANT = 'o:00000000-0000-4000-8000-0000000000c1';
const ACTIVE = '00000000-0000-4000-8000-0000000000d1';
const STAGED = '00000000-0000-4000-8000-0000000000d2';
const FREE = '00000000-0000-4000-8000-0000000000d3';

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a classic browser script without types
type Panel = Record<string, any>;

function view(): Panel {
  return require(PANEL) as Panel;
}

function binding(id: string, over: Row = {}): Row {
  return {
    id,
    doc_type: TYPE_A,
    tenant_key: null,
    profile_id: 'scoped-b-1024',
    model: 'model-b',
    status: 'available',
    stale: false,
    has_evidence: false,
    baseline_global_profile: null,
    previous_binding_id: null,
    activated_at: null,
    activated_by: null,
    created_at: '2026-11-02T00:00:00.000Z',
    completeness: null,
    ...over,
  };
}

function listBody(over: Row = {}): Row {
  return {
    success: true,
    switch: 'on',
    profiles_switch: 'on',
    global_active: 'global-a-2048',
    doc_types: [TYPE_A, TYPE_B],
    profiles: [
      { id: 'global-a-2048', provider: 'p', model: 'model-a', dims: 2048, status: 'active', doc_types: null },
      { id: 'scoped-b-1024', provider: 'p', model: 'model-b', dims: 1024, status: 'available', doc_types: [TYPE_A] },
      { id: 'scoped-c-1024', provider: 'p', model: 'model-c', dims: 1024, status: 'available', doc_types: [TYPE_B] },
    ],
    bindings: [
      binding(FREE, { doc_type: TYPE_B, profile_id: 'scoped-c-1024' }),
      binding(STAGED, { tenant_key: TENANT, status: 'backfilling', completeness: { state: 'measured', chunks: 10, missing: 4, percent: 60 } }),
      binding(ACTIVE, {
        status: 'active',
        has_evidence: true,
        baseline_global_profile: 'global-a-2048',
        previous_binding_id: FREE,
        activated_at: '2026-11-03T00:00:00.000Z',
        activated_by: 'admin:someone',
        completeness: { state: 'measured', chunks: 1000, missing: 1, percent: 99.9 },
      }),
    ],
    ...over,
  };
}

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function sectionMarkup(): string {
  const html = fs.readFileSync(INDEX, 'utf8');
  const start = html.indexOf('<section id="rag-administration-bindings"');
  const end = html.indexOf('</section>', start);
  const open = html.indexOf('>', start) + 1;
  return html.slice(open, end);
}

function mountPanel(respond: (call: Call) => { ok: boolean; status: number; body: unknown; message?: string }) {
  const doc = new FakeDocument();
  const root = doc.createElement('section');
  root.id = 'rag-administration-bindings';
  root.innerHTML = sectionMarkup();
  doc.body.appendChild(root);
  const link = doc.createElement('a');
  link.setAttribute('data-tab', 'rag-administration');
  doc.body.appendChild(link);
  const calls: Call[] = [];
  const context: Record<string, unknown> = {
    document: doc,
    console,
    navigator: { language: 'en-US' },
    setTimeout,
    clearTimeout,
    docTypeLabelForLocale: (id: string) => (id === TYPE_A ? 'Label A' : id),
    authMessage: (status: number) => `sign in (${status})`,
    ragFetch: async (apiPath: string, init: { method: string; body?: string }) => {
      const call = { path: apiPath, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      return respond(call);
    },
  };
  context.window = context;
  vm.createContext(context);
  new vm.Script(fs.readFileSync(PANEL, 'utf8'), { filename: 'embedding-bindings.js' }).runInContext(context);
  doc.dispatch('DOMContentLoaded');
  link.click();
  return { doc, root, calls, context };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function text(el: FakeElement | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ');
}

function button(root: FakeElement, focusKey: string): FakeElement {
  const found = root.querySelector(`[data-rag-bindings-focus="${focusKey}"]`);
  if (!found) throw new Error(`no button ${focusKey}`);
  return found;
}

describe('embedding bindings panel view model', () => {
  it('never shows 100% while chunks are missing', () => {
    const { bindingsPercentText, bindingsCompletenessView } = view();
    expect(bindingsPercentText({ state: 'measured', chunks: 1000, missing: 1, percent: 99.9 })).toBe('99%');
    expect(bindingsPercentText({ state: 'measured', chunks: 10, missing: 0, percent: 100 })).toBe('100%');
    expect(bindingsPercentText({ state: 'measured', chunks: 3, missing: 3, percent: 0 })).toBe('0%');
    expect(bindingsCompletenessView(null).kind).toBe('none');
    expect(bindingsCompletenessView({ state: 'unavailable' }).kind).toBe('unavailable');
    expect(bindingsCompletenessView({ state: 'measured', chunks: 0, missing: 0, percent: 100 }).kind).toBe('empty');
  });

  it('offers actions by status and gates activate on evidence only', () => {
    const { bindingsActionsFor } = view();
    const kinds = (row: Row) => bindingsActionsFor(row).map((action: { kind: string }) => action.kind);
    expect(kinds({ status: 'available' })).toEqual(['stage', 'activate', 'retire']);
    expect(kinds({ status: 'backfilling' })).toEqual(['activate', 'markAvailable', 'retire']);
    expect(kinds({ status: 'retired' })).toEqual(['markAvailable']);
    expect(kinds({ status: 'active', previous_binding_id: FREE })).toEqual(['rollback', 'deactivate']);
    expect(kinds({ status: 'active', previous_binding_id: null })).toEqual(['deactivate']);
    expect(bindingsActionsFor({ status: 'backfilling', has_evidence: false })[0]).toEqual({ kind: 'activate', disabled: true });
    expect(bindingsActionsFor({ status: 'backfilling', has_evidence: true })[0]).toEqual({ kind: 'activate', disabled: false });
  });

  it('badges stale from the flag and incomplete only on an active row with missing chunks', () => {
    const { bindingsBadges } = view();
    const texts = (row: Row) => bindingsBadges(row).map((badge: { text: string }) => badge.text);
    expect(texts({ status: 'active', stale: true, completeness: { state: 'measured', chunks: 2, missing: 1, percent: 50 } })).toEqual(['Active', 'Stale', 'Incomplete']);
    expect(texts({ status: 'backfilling', completeness: { state: 'measured', chunks: 2, missing: 1, percent: 50 } })).toEqual(['Backfilling']);
    expect(texts({ status: 'odd_state' })).toEqual(['odd_state']);
  });

  it('groups by the API doc type order, deployment rows first, then tenant rows by status', () => {
    const { bindingsGroups } = view();
    const groups = bindingsGroups(listBody());
    expect(groups.map((group: { docType: string }) => group.docType)).toEqual([TYPE_A, TYPE_B]);
    expect(groups[0].rows.map((row: Row) => row.id)).toEqual([ACTIVE, STAGED]);
  });

  it('lists only profiles scoped to the chosen doc type and validates the tenant key', () => {
    const { bindingsProfilesFor, bindingsValidateForm, bindingsCreateBody } = view();
    expect(bindingsProfilesFor(listBody().profiles, TYPE_A).map((profile: Row) => profile.id)).toEqual(['scoped-b-1024']);
    expect(Object.keys(bindingsValidateForm({ doc_type: '', profile_id: '', scope: 'tenant', tenant_key: 'x' })).sort()).toEqual(['doc_type', 'profile_id', 'tenant_key']);
    expect(bindingsValidateForm({ doc_type: TYPE_A, profile_id: 'p-1', scope: 'tenant', tenant_key: TENANT })).toEqual({});
    expect(bindingsCreateBody({ doc_type: TYPE_A, profile_id: 'p-1', scope: 'deployment', tenant_key: TENANT })).toEqual({
      action: 'create',
      doc_type: TYPE_A,
      profile_id: 'p-1',
      tenant_key: null,
    });
  });

  it('is domain neutral: names no doc type id, label, provider or model of its own', async () => {
    const source = fs.readFileSync(PANEL, 'utf8');
    const { DOC_TYPE_CHOICES, docTypeLabel } = await import('@/components/ui/doc-type-labels');
    for (const id of DOC_TYPE_CHOICES) {
      expect(source).not.toContain(`'${id}'`);
      for (const locale of ['en', 'zh', 'it'] as const) {
        const label = docTypeLabel(id, locale);
        if (label.length > 4) expect(source, label).not.toContain(label);
      }
    }
    expect(source).not.toMatch(/voyage|openai|cohere|qwen|jina|bge|text-embedding/i);
    expect(source).not.toContain('innerHTML');
  });
});

describe('embedding bindings panel in the page', () => {
  it('index.html mounts the panel next to Embedding profiles', () => {
    const html = fs.readFileSync(INDEX, 'utf8');
    expect(html).toContain('<script src="rag-panels/embedding-bindings.js"></script>');
    const profiles = html.indexOf('id="rag-administration-profiles"');
    const bindings = html.indexOf('id="rag-administration-bindings"');
    const chunking = html.indexOf('id="rag-administration-chunking"');
    expect(profiles).toBeGreaterThan(0);
    expect(bindings).toBeGreaterThan(profiles);
    expect(chunking).toBeGreaterThan(bindings);
  });

  it('renders groups, badges, completeness and the evidence gate, calling only the list route', async () => {
    const { root, calls } = mountPanel(() => ({ ok: true, status: 200, body: listBody() }));
    await flush();
    expect(calls).toEqual([{ path: 'admin/embedding-bindings', method: 'GET', body: undefined }]);
    const list = text(root.querySelector('[data-rag-bindings-list]'));
    expect(list).toContain('Label A');
    expect(list).toContain('Whole deployment');
    expect(list).toContain(TENANT);
    expect(list).toContain('Incomplete');
    expect(list).toContain('99%');
    expect(list).not.toContain('100%');
    const activate = button(root, `activate:${STAGED}`);
    expect(activate.getAttribute('disabled')).not.toBeNull();
    expect(activate.getAttribute('aria-disabled')).toBe('true');
    const hint = root.querySelector(`#${activate.getAttribute('aria-describedby')}`);
    expect(text(hint)).toContain(`npm run rag:embedding -- record-binding-evidence <comparison.json> --binding ${STAGED}`);
    expect(text(root.querySelector('[data-rag-bindings-state]'))).toContain('global-a-2048');
  });

  it('shows the switch-off note', async () => {
    const { root } = mountPanel(() => ({ ok: true, status: 200, body: listBody({ switch: 'off' }) }));
    await flush();
    const state = text(root.querySelector('[data-rag-bindings-state]'));
    expect(state).toContain('Off');
    expect(state).toContain('Bindings are stored but not used');
  });

  it('asks for confirmation before deactivate and posts the binding key; Keep as is sends nothing', async () => {
    const { root, doc, calls } = mountPanel((call) =>
      call.method === 'GET' ? { ok: true, status: 200, body: listBody() } : { ok: true, status: 200, body: { success: true, deactivated: ACTIVE } },
    );
    await flush();
    button(root, `deactivate:${ACTIVE}`).click();
    let dialog = doc.querySelector('dialog');
    expect(dialog?.open).toBe(true);
    expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
    [...dialog!.querySelectorAll('button')].find((el) => el.textContent === 'Keep as is')!.click();
    expect(calls.filter((call) => call.method === 'POST')).toEqual([]);

    button(root, `deactivate:${ACTIVE}`).click();
    dialog = doc.querySelector('dialog');
    [...dialog!.querySelectorAll('button')].find((el) => el.textContent === 'Deactivate')!.click();
    await flush();
    await flush();
    expect(calls.filter((call) => call.method === 'POST')).toEqual([
      { path: 'admin/embedding-bindings/deactivate', method: 'POST', body: { doc_type: TYPE_A, tenant_key: null } },
    ]);
    expect(text(root.querySelector('[data-rag-bindings-status]'))).toContain('Deactivated');
  });

  it('shows a gate refusal verbatim, with its detail, and escapes untrusted text', async () => {
    const body = listBody();
    (body.bindings as Row[]).push(binding('00000000-0000-4000-8000-0000000000d4', { doc_type: TYPE_B, tenant_key: `u:${XSS_PAYLOAD}`, status: 'backfilling', has_evidence: true, profile_id: 'scoped-c-1024' }));
    const { root, doc, calls } = mountPanel((call) =>
      call.method === 'GET'
        ? { ok: true, status: 200, body }
        : { ok: false, status: 409, body: { success: false, error: 'binding_refused', reason: 'binding_refused: eval_missing', detail: `binding_refused: eval_missing ${XSS_PAYLOAD}` } },
    );
    await flush();
    button(root, 'activate:00000000-0000-4000-8000-0000000000d4').click();
    [...doc.querySelector('dialog')!.querySelectorAll('button')].find((el) => el.textContent === 'Activate')!.click();
    await flush();
    await flush();
    expect(calls.filter((call) => call.method === 'POST')).toEqual([
      { path: 'admin/embedding-bindings/00000000-0000-4000-8000-0000000000d4/activate', method: 'POST', body: {} },
    ]);
    expect(text(root.querySelector('[data-rag-bindings-status]'))).toContain('Refused: binding_refused: eval_missing');
    const list = text(root.querySelector('[data-rag-bindings-list]'));
    expect(list).toContain('The gate refused this change.');
    expect(list).toContain(`binding_refused: eval_missing ${XSS_PAYLOAD}`);
    expect(injectedElements(doc)).toEqual([]);
  });

  it('stages without a dialog through set_status', async () => {
    const { root, calls } = mountPanel((call) =>
      call.method === 'GET' ? { ok: true, status: 200, body: listBody() } : { ok: true, status: 200, body: { success: true, binding_id: FREE, status: 'backfilling' } },
    );
    await flush();
    button(root, `stage:${FREE}`).click();
    await flush();
    await flush();
    expect(calls.filter((call) => call.method === 'POST')).toEqual([
      { path: 'admin/embedding-bindings', method: 'POST', body: { action: 'set_status', binding_id: FREE, status: 'backfilling' } },
    ]);
  });

  it('shows the registry alert on 503 and the sign-in alert on 401', async () => {
    const down = mountPanel(() => ({ ok: false, status: 503, body: { success: false, error: 'embedding_registry_unavailable' } }));
    await flush();
    expect(text(down.root.querySelector('[data-rag-bindings-alert]'))).toContain('The embedding registry can’t be reached');
    const out = mountPanel(() => ({ ok: false, status: 401, body: { success: false } }));
    await flush();
    expect(text(out.root.querySelector('[data-rag-bindings-alert]'))).toContain('sign in (401)');
    expect(out.root.querySelector('[data-rag-bindings-content]')?.hidden).toBe(true);
  });

  it('creates a binding from the form with only scoped profiles offered', async () => {
    const { root, calls } = mountPanel((call) =>
      call.method === 'GET' ? { ok: true, status: 200, body: listBody() } : { ok: true, status: 201, body: { success: true, binding_id: FREE, status: 'available', created: true } },
    );
    await flush();
    root.querySelector('[data-rag-bindings-new]')!.click();
    const docSelect = root.querySelector('#rag-bindings-form-doctype')!;
    docSelect.value = TYPE_B;
    docSelect.dispatch('change');
    const options = root.querySelectorAll('#rag-bindings-form-profile option').map((option) => option.getAttribute('value'));
    expect(options).toEqual(['', 'scoped-c-1024']);
    const profile = root.querySelector('#rag-bindings-form-profile')!;
    profile.value = 'scoped-c-1024';
    profile.dispatch('change');
    root.querySelector('#rag-bindings-form form')!.dispatch('submit');
    await flush();
    await flush();
    expect(calls.filter((call) => call.method === 'POST')).toEqual([
      { path: 'admin/embedding-bindings', method: 'POST', body: { action: 'create', doc_type: TYPE_B, profile_id: 'scoped-c-1024', tenant_key: null } },
    ]);
    expect(text(root.querySelector('[data-rag-bindings-status]'))).toContain('Binding created');
  });
});

describe('UI review fixes (03.1.1-UI-REVIEW, quick 261127-cuf)', () => {
  const classes = (el: FakeElement | null) => (el?.className ?? '').split(/\s+/).filter(Boolean);

  it('BLOCKER 1: below md every row stacks into labelled lines; no fixed min width on Scope below md', async () => {
    const { root } = mountPanel(() => ({ ok: true, status: 200, body: listBody() }));
    await flush();
    const table = root.querySelector('[data-rag-bindings-list] table')!;
    expect(classes(table.querySelector('thead'))).toEqual(expect.arrayContaining(['sr-only', 'md:not-sr-only']));
    const rows = table.querySelectorAll('tbody tr').filter((tr) => tr.querySelector('th'));
    expect(rows.length).toBeGreaterThan(0);
    for (const tr of rows) {
      expect(classes(tr)).toEqual(expect.arrayContaining(['flex', 'flex-col', 'md:table-row']));
      const cells = [...tr.children];
      for (const cell of cells) expect(classes(cell)).toEqual(expect.arrayContaining(['block', 'md:table-cell']));
      expect(classes(cells[0])).not.toContain('min-w-40');
      const labels = tr.querySelectorAll('[data-rag-bindings-cell-label]').map((el) => el.textContent);
      expect(labels).toEqual(['Profile', 'Status', 'Complete', 'Evidence']);
      for (const label of tr.querySelectorAll('[data-rag-bindings-cell-label]')) expect(classes(label)).toContain('md:hidden');
    }
    expect(text(root.querySelector('[data-rag-bindings-list]'))).not.toMatch(/break-all/);
    expect(root.querySelectorAll('[data-rag-bindings-list] .break-all')).toEqual([]);
  });

  it('WARNING 2: the form secondary button says Close form', async () => {
    const { BINDINGS_COPY } = view();
    expect(BINDINGS_COPY['form.cancel']).toBe('Close form');
    const { root } = mountPanel(() => ({ ok: true, status: 200, body: listBody() }));
    await flush();
    root.querySelector('[data-rag-bindings-new]')!.click();
    expect(root.querySelectorAll('#rag-bindings-form button').map((b) => b.textContent)).toContain('Close form');
  });

  it('WARNING 3: Create binding is disabled while the chosen type has no scoped profile', async () => {
    const body = listBody({ doc_types: [TYPE_A, TYPE_B, 'doc_type_c'] });
    const { root } = mountPanel(() => ({ ok: true, status: 200, body }));
    await flush();
    root.querySelector('[data-rag-bindings-new]')!.click();
    const docSelect = root.querySelector('#rag-bindings-form-doctype')!;
    docSelect.value = 'doc_type_c';
    docSelect.dispatch('change');
    const submit = root.querySelectorAll('#rag-bindings-form button').find((b) => b.textContent === 'Create binding')!;
    expect(submit.getAttribute('disabled')).not.toBeNull();
    docSelect.value = TYPE_B;
    docSelect.dispatch('change');
    const again = root.querySelectorAll('#rag-bindings-form button').find((b) => b.textContent === 'Create binding')!;
    expect(again.getAttribute('disabled')).toBeNull();
  });

  it('WARNING 4: a stale row without a baseline never reads "recorded against None"', async () => {
    const body = listBody({ bindings: [binding(ACTIVE, { status: 'active', stale: true, has_evidence: true, baseline_global_profile: null })] });
    const { root } = mountPanel(() => ({ ok: true, status: 200, body }));
    await flush();
    const list = text(root.querySelector('[data-rag-bindings-list]'));
    expect(list).not.toContain('recorded against None');
    expect(list).toContain('Its evidence has no recorded baseline');
  });

  it('WARNING 5: form.profile.none matches the UI-SPEC copy table', () => {
    const { BINDINGS_COPY } = view();
    const spec = fs.readFileSync(path.resolve(import.meta.dirname, '../../.planning/phases/03.1.1-domain-embedding-model-candidates-and-per-doc-type-model-sel/03.1.1-UI-SPEC.md'), 'utf8');
    for (const key of ['form.profile.none', 'form.cancel', 'hint.staleNoBaseline']) {
      const row = spec.split('\n').find((line) => line.startsWith('| `' + key + '` |'));
      expect(row, key).toBeTruthy();
      expect(row!.replace(/ \|$/, '').split(' | ')[1]).toBe(BINDINGS_COPY[key]);
    }
  });

  it('WARNING 6: a proxy error when the main app is down shows the error alert with Try again', async () => {
    let down = true;
    const { root, calls } = mountPanel(() =>
      down
        ? { ok: false, status: 500, body: { error: 'Unable to connect to main myRAG app at http://127.0.0.1:3000.' }, message: 'Unable to connect to main myRAG app at http://127.0.0.1:3000.' }
        : { ok: true, status: 200, body: listBody() },
    );
    await flush();
    const alert = root.querySelector('[data-rag-bindings-alert] .alert-error');
    expect(text(alert)).toContain('Unable to connect to main myRAG app');
    expect(text(root.querySelector('[data-rag-bindings-status]'))).toBe('');
    down = false;
    root.querySelectorAll('[data-rag-bindings-alert] button').find((b) => b.textContent === 'Try again')!.click();
    await flush();
    expect(calls).toHaveLength(2);
    expect(root.querySelector('[data-rag-bindings-alert] .alert')).toBeNull();
  });

  it('WARNING 7: with no scoped profile and no binding the sentence shows once', async () => {
    const body = listBody({ bindings: [], profiles: [{ id: 'global-a-2048', provider: 'p', model: 'model-a', dims: 2048, status: 'active', doc_types: null }] });
    const { root } = mountPanel(() => ({ ok: true, status: 200, body }));
    await flush();
    expect(text(root).split('No embedding profile is scoped to a document type').length - 1).toBe(1);
  });

  it('WARNING 8: the switch-off note is a quiet bordered note, not a filled info alert', async () => {
    const { root } = mountPanel(() => ({ ok: true, status: 200, body: listBody({ switch: 'off' }) }));
    await flush();
    const note = root.querySelector('[data-rag-bindings-off-note]')!;
    expect(classes(note)).not.toContain('alert-info');
    expect(classes(note)).toEqual(expect.arrayContaining(['border', 'border-info/40', 'bg-base-100']));
    expect(text(note)).toContain('Bindings are stored but not used');
  });

  it('WARNINGS 9-11: gated Activate keeps an outline, Retire is outlined and does not wrap, the CLI hint is left aligned', async () => {
    const { root } = mountPanel(() => ({ ok: true, status: 200, body: listBody() }));
    await flush();
    const activate = button(root, `activate:${STAGED}`);
    expect(classes(activate)).toEqual(expect.arrayContaining(['btn-outline', 'disabled:border-base-content/40', 'disabled:text-base-content/70', 'disabled:bg-transparent']));
    expect(classes(activate)).not.toContain('btn-primary');
    const retire = button(root, `retire:${STAGED}`);
    expect(classes(retire)).toEqual(expect.arrayContaining(['btn-outline', 'whitespace-nowrap']));
    expect(classes(retire.parentElement)).toContain('md:flex-nowrap');
    const hint = root.querySelector(`#${activate.getAttribute('aria-describedby')}`)!;
    expect(classes(hint)).toContain('text-left');
    expect(classes(hint)).not.toContain('text-right');
    expect(classes(hint)).not.toContain('ml-auto');
  });

  it('WARNING 12: the missing-chunks warning icon aligns to the first line', async () => {
    const { root } = mountPanel(() => ({ ok: true, status: 200, body: listBody() }));
    await flush();
    const icon = root.querySelectorAll('[data-rag-bindings-list] .bi-exclamation-triangle-fill').find((el) => text(el.parentElement).includes('chunks missing'))!;
    // The icon flows inline with the text (no flex row that could centre it or push it away from a wrapped line).
    expect(classes(icon.parentElement)).not.toContain('flex');
    expect(classes(icon.parentElement)).not.toContain('items-center');
    expect(icon.parentElement!.children[0]).toBe(icon);
  });

  it('WARNING 13: a 401 on create closes the form state, so a reload does not reopen a stale form', async () => {
    let post401 = true;
    const { root } = mountPanel((call) => (call.method === 'POST' && post401 ? { ok: false, status: 401, body: {} } : { ok: true, status: 200, body: listBody() }));
    await flush();
    root.querySelector('[data-rag-bindings-new]')!.click();
    const docSelect = root.querySelector('#rag-bindings-form-doctype')!;
    docSelect.value = TYPE_B;
    docSelect.dispatch('change');
    const profile = root.querySelector('#rag-bindings-form-profile')!;
    profile.value = 'scoped-c-1024';
    profile.dispatch('change');
    root.querySelector('#rag-bindings-form form')!.dispatch('submit');
    await flush();
    expect(text(root.querySelector('[data-rag-bindings-alert]'))).toContain('sign in (401)');
    post401 = false;
    root.querySelectorAll('[data-rag-bindings-alert] button').find((b) => b.textContent === 'Reload panel')!.click();
    await flush();
    expect(root.querySelector('#rag-bindings-form')).toBeNull();
    expect(root.querySelector('[data-rag-bindings-new]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('WARNING 14: a 503 mutation followed by a 503 reload shows one message', async () => {
    let registryUp = true;
    const { root } = mountPanel((call) => {
      if (call.method === 'POST') {
        registryUp = false;
        return { ok: false, status: 503, body: { success: false, error: 'embedding_registry_unavailable' } };
      }
      return registryUp ? { ok: true, status: 200, body: listBody() } : { ok: false, status: 503, body: { success: false } };
    });
    await flush();
    button(root, `stage:${FREE}`).click();
    await flush();
    await flush();
    const status = text(root.querySelector('[data-rag-bindings-status]'));
    const alert = text(root.querySelector('[data-rag-bindings-alert]'));
    expect(status).toBe('');
    expect(alert).toContain('The server did not confirm the change');
    expect(alert).toContain('The embedding registry can’t be reached');
    expect(root.querySelectorAll('[data-rag-bindings-alert] .alert')).toHaveLength(1);
  });

  it('15: mono ids carry an explicit size and wrap with break-words; the state block spaces by gap, not stacked margins', async () => {
    const { root } = mountPanel(() => ({ ok: true, status: 200, body: listBody({ switch: 'off' }) }));
    await flush();
    for (const el of root.querySelectorAll('[translate="no"]').filter((node) => classes(node).includes('font-mono'))) {
      expect(classes(el).some((c) => /^text-(xs|sm)$/.test(c)), el.className).toBe(true);
    }
    const state = root.querySelector('[data-rag-bindings-state]')!;
    expect(classes(state.children[0])).toEqual(expect.arrayContaining(['flex', 'flex-col', 'gap-2']));
    expect(state.querySelectorAll('.mt-2')).toEqual([]);
  });
});

describe('re-audit column widths (03.1.1-UI-REVIEW W-1..W-3, quick 261127-cuf)', () => {
  const classes = (el: FakeElement | null) => (el?.className ?? '').split(/\s+/).filter(Boolean);

  it('from md the profile id stays on one line and Profile, Status and Evidence keep a minimum width', async () => {
    const { root } = mountPanel(() => ({ ok: true, status: 200, body: listBody() }));
    await flush();
    const row = root.querySelectorAll('[data-rag-bindings-list] tbody tr').find((tr) => tr.querySelector('th'))!;
    const [, profile, status, , evidence] = [...row.children];
    expect(classes(profile)).toContain('md:min-w-48');
    expect(classes(profile.querySelector('[translate="no"]'))).toContain('md:whitespace-nowrap');
    expect(classes(status).some((c) => c.startsWith('md:min-w-'))).toBe(false);
    expect(classes(evidence)).toContain('md:min-w-28');
  });
});
