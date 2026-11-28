import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, XSS_PAYLOAD, injectedElements } from './helpers/html-fake-dom';

const configUiDir = path.resolve(import.meta.dirname, '../../scripts/config-ui');
const pickerPath = path.join(configUiDir, 'pickers/sharepoint-scope-picker.js');
const html = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

type Reply = { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

function fakeFetch(handler: (url: string, method: string, body: unknown) => Reply) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const reply = await handler(url, method, body);
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => reply.body ?? {} };
  };
  return { fn, calls };
}

interface Loaded {
  doc: FakeDocument;
  context: Record<string, unknown>;
  timers: Array<{ fn: () => void; ms: number }>;
}

function loadContext(fetchFn?: unknown, extra: Record<string, unknown> = {}): Loaded {
  const doc = new FakeDocument();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const context: Record<string, unknown> = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: (id: number) => {
      if (timers[id - 1]) timers[id - 1]!.fn = () => {};
    },
    fetch: fetchFn,
    ...extra,
  };
  context.window = context;
  vm.createContext(context);
  new vm.Script(fs.readFileSync(path.join(configUiDir, 'utils/modal.js'), 'utf8')).runInContext(context);
  new vm.Script(
    `${fs.readFileSync(pickerPath, 'utf8')}\nglobalThis.SharePointScopePickerModal = SharePointScopePickerModal; globalThis.buildSharePointScopeSummary = buildSharePointScopeSummary;`,
    { filename: 'sharepoint-scope-picker.js' },
  ).runInContext(context);
  return { doc, context, timers };
}

function loadConnectorsManager(loaded: Loaded) {
  const source = fs.readFileSync(path.join(configUiDir, 'connectors-config.js'), 'utf8');
  const start = source.indexOf('class ConnectorsConfigManager');
  const end = source.indexOf('\n}\n', start);
  new vm.Script(`${source.slice(start, end + 2)}\nglobalThis.__Manager = ConnectorsConfigManager;`).runInContext(loaded.context);
  const Klass = loaded.context.__Manager as { prototype: object };
  return Object.create(Klass.prototype) as Record<string, unknown> & Record<string, (...args: unknown[]) => unknown>;
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

type Picker = Record<string, unknown> & Record<string, (...args: unknown[]) => unknown>;

function newPicker(loaded: Loaded, provider: string, options: Record<string, unknown> = {}): Picker {
  const Klass = loaded.context.SharePointScopePickerModal as new (provider: string, options: Record<string, unknown>) => Picker;
  return new Klass(provider, options);
}

function modalOf(loaded: Loaded): FakeElement {
  const el = loaded.doc.body.querySelector('.modal');
  expect(el, 'picker modal in the page').not.toBeNull();
  return el!;
}

function buttonByText(root: FakeElement, text: string): FakeElement {
  const found = root.querySelectorAll('button').find((b) => b.textContent.replace(/\s+/g, ' ').trim() === text);
  expect(found, `button "${text}"`).toBeTruthy();
  return found!;
}

function buttonByLabel(root: FakeElement, label: string): FakeElement {
  const found = root.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === label);
  expect(found, `button labelled "${label}"`).toBeTruthy();
  return found!;
}

function checkboxFor(root: FakeElement, name: string): FakeElement {
  const row = root.querySelectorAll('li').find((li) => li.querySelector('input') && li.querySelector('[title]')?.getAttribute('title') === name);
  expect(row, `row "${name}"`).toBeTruthy();
  return row!.querySelector('input')!;
}

function rowOf(root: FakeElement, name: string): FakeElement {
  const row = root.querySelectorAll('li').find((li) => li.querySelector('input') && li.querySelector('[title]')?.getAttribute('title') === name);
  expect(row, `row "${name}"`).toBeTruthy();
  return row!;
}

function check(box: FakeElement, value = true) {
  box.checked = value;
  box.dispatch('change');
}

const SITES = { items: [{ id: 'site-a', name: 'Site A', has_children: true }, { id: 'site-b', name: 'Site B', has_children: true }], cursor: null };
const DRIVES = { items: [{ id: 'drive-1', name: 'Library 1', has_children: true }, { id: 'drive-2', name: 'Library 2', has_children: true }], cursor: null };
const FOLDERS = { items: [{ id: 'folder-1', name: 'Folder 1', has_children: true }, { id: 'folder-2', name: 'Folder 2', has_children: false }], cursor: null };

function standardFetch(overrides: (url: string, method: string, body: unknown) => Reply | undefined = () => undefined) {
  return fakeFetch((url, method, body) => {
    const custom = overrides(url, method, body);
    if (custom) return custom;
    if (method === 'PATCH') return { body: { success: true } };
    if (url.startsWith('/api/nango/sharepoint/sites')) return { body: SITES };
    if (url.startsWith('/api/nango/sharepoint/drives')) return { body: DRIVES };
    if (url.startsWith('/api/nango/sharepoint/folders')) return { body: FOLDERS };
    return { status: 404, body: { error: 'Not found' } };
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('connectors route: SharePoint and OneDrive only with the switch on (D-24)', () => {
  async function loadRoute(rows: Array<Record<string, unknown>>) {
    vi.doMock('@/lib/admin-route-auth', () => ({
      checkAdmin: async () => ({ ok: false }),
      requireAdminOrDeny: async () => null,
    }));
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from: () => ({
          select: () => ({ order: async () => ({ data: rows, error: null }) }),
        }),
      }),
    }));
    vi.doMock('@/lib/env', () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'placeholder' } }));
    return import('@/app/api/config/connectors/route');
  }

  const baseRows = [
    { provider: 'dropbox', enabled: true, show_on_dashboard: true, button_label: 'Dropbox', description: 'd', supported_file_types: ['pdf'], max_files_per_sync: 10 },
    { provider: 'google-drive', enabled: true, show_on_dashboard: true, button_label: 'Google Drive', description: 'g', supported_file_types: ['pdf'], max_files_per_sync: 10 },
  ];

  it('switch off: neither provider is sent, even when a connector_config row exists', async () => {
    vi.stubEnv('NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED', 'false');
    const route = await loadRoute([...baseRows, { ...baseRows[0], provider: 'sharepoint-online', button_label: 'SP' }]);
    const body = await (await route.GET({} as never)).json();
    expect(body.providers.map((p: { provider: string }) => p.provider)).toEqual(['dropbox', 'google-drive']);
  });

  it('switch on: rows are used when present, otherwise default entries with neutral descriptions', async () => {
    vi.stubEnv('NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED', 'true');
    const route = await loadRoute([...baseRows, { ...baseRows[0], provider: 'one-drive', button_label: 'OneDrive row' }]);
    const body = await (await route.GET({} as never)).json();
    const byKey = Object.fromEntries(body.providers.map((p: { provider: string }) => [p.provider, p]));
    expect(Object.keys(byKey).sort()).toEqual(['dropbox', 'google-drive', 'one-drive', 'sharepoint-online']);
    expect(byKey['one-drive'].button_label).toBe('OneDrive row');
    expect(byKey['sharepoint-online']).toMatchObject({ button_label: 'SharePoint Online', enabled: true, show_on_dashboard: true });
    expect(byKey['sharepoint-online'].description).toBe('Sync documents from SharePoint Online sites and libraries');
  });
});

describe('Connectors tab provider cards (UI-SPEC 6.7)', () => {
  const spProvider = (provider: string, user_connection: unknown) => ({
    provider,
    button_label: provider === 'one-drive' ? 'OneDrive for Business' : 'SharePoint Online',
    enabled: true,
    show_on_dashboard: true,
    supported_file_types: [],
    max_files_per_sync: 100,
    stats: { connected_users: 1, total_syncs: 0, failed_syncs: 0, last_sync: null },
    user_connection,
  });

  function render(providers: unknown[]) {
    const loaded = loadContext();
    const list = loaded.doc.createElement('div');
    list.id = 'providers-list';
    loaded.doc.body.appendChild(list);
    const manager = loadConnectorsManager(loaded);
    Object.assign(manager, { config: { providers } });
    manager.renderProvidersList();
    return { loaded, list, manager };
  }

  const syncButton = (list: FakeElement) => list.querySelectorAll('button').find((b) => b.textContent.trim() === 'Sync')!;

  it('a connected SharePoint card has one dashed selection button and Sync disabled until a selection exists', () => {
    const { list } = render([spProvider('sharepoint-online', { connected: true, connection_id: 'c1', source_scope: null, deletion_mode: null })]);
    const dashed = list.querySelectorAll('button').filter((b) => b.className.includes('border-dashed'));
    expect(dashed).toHaveLength(1);
    expect(dashed[0]!.textContent.trim()).toBe('Choose sites, libraries and folders');
    expect(dashed[0]!.querySelector('i')!.className).toContain('bi-diagram-3');
    expect(syncButton(list).getAttribute('disabled')).not.toBeNull();
  });

  it('a saved selection turns the button into the summary and enables Sync; OneDrive drops the sites part', () => {
    const scope = { sites: [{ id: 's1', name: 'Site A' }], drives: [], folders: [] };
    const { list } = render([spProvider('sharepoint-online', { connected: true, connection_id: 'c1', source_scope: scope, deletion_mode: null })]);
    const dashed = list.querySelectorAll('button').filter((b) => b.className.includes('border-dashed'));
    expect(dashed[0]!.textContent.trim()).toBe('Sites: 1, libraries: 0, folders: 0');
    expect(dashed[0]!.querySelector('span')!.className).toContain('text-success');
    expect(syncButton(list).getAttribute('disabled')).toBeNull();

    const od = render([spProvider('one-drive', { connected: true, connection_id: 'c2', source_scope: { sites: [], drives: [{ id: 'd1', name: 'Library 1' }], folders: [] }, deletion_mode: 'soft' })]);
    const odButton = od.list.querySelectorAll('button').find((b) => b.className.includes('border-dashed'))!;
    expect(odButton.textContent.trim()).toBe('Libraries: 1, folders: 0');
  });

  it('a not-connected card and other providers render no SharePoint selection button', () => {
    const { list } = render([
      spProvider('sharepoint-online', null),
      { ...spProvider('google-drive', { connected: true, connection_id: 'g', sync_folder_id: null, sync_file_ids: [] }), button_label: 'Google Drive' },
    ]);
    expect(list.querySelectorAll('[data-sharepoint-scope-host]')).toHaveLength(0);
    expect(list.textContent).not.toContain('Choose sites');
  });

  it('switch off: loading the configuration makes no connections request; on: the operator connection is attached', async () => {
    const off = fakeFetch((url) => (url === '/api/config/connectors' ? { body: { providers: [spProvider('google-drive', undefined)] } } : { body: { connections: [] } }));
    const loadedOff = loadContext(off.fn);
    const managerOff = loadConnectorsManager(loadedOff);
    Object.assign(managerOff, { renderConfiguration() {}, showLoading() {}, showError() {} });
    await managerOff.loadConfiguration();
    expect(off.calls.map((c) => c.url)).toEqual(['/api/config/connectors']);

    const on = fakeFetch((url) =>
      url === '/api/config/connectors'
        ? { body: { providers: [spProvider('sharepoint-online', undefined)] } }
        : { body: { connections: [{ provider: 'sharepoint-online', status: 'connected', connection_id: 'c9', deletion_mode: 'purge', metadata: { source_scope: { sites: [], drives: [{ id: 'd', name: 'L' }], folders: [] } } }] } },
    );
    const loadedOn = loadContext(on.fn);
    const managerOn = loadConnectorsManager(loadedOn);
    Object.assign(managerOn, { renderConfiguration() {}, showLoading() {}, showError() {} });
    await managerOn.loadConfiguration();
    expect(on.calls.map((c) => c.url)).toEqual(['/api/config/connectors', '/api/nango/connections']);
    const conn = (managerOn.config as { providers: Array<{ user_connection: Record<string, unknown> }> }).providers[0]!.user_connection;
    expect(conn).toMatchObject({ connected: true, connection_id: 'c9', deletion_mode: 'purge' });
    expect(conn.source_scope).toEqual({ sites: [], drives: [{ id: 'd', name: 'L' }], folders: [] });
  });

  it('the picker script is loaded once, right after the Notion page picker', () => {
    expect(html.match(/pickers\/sharepoint-scope-picker\.js/g)).toHaveLength(1);
    const notion = html.indexOf('pickers/notion-page-picker.js');
    const picker = html.indexOf('pickers/sharepoint-scope-picker.js');
    expect(picker).toBeGreaterThan(notion);
    expect(html.slice(notion, picker).match(/<script/g)).toHaveLength(1);
  });
});

describe('buildSharePointScopeSummary', () => {
  it('labels empty and saved selections per provider', () => {
    const { context } = loadContext();
    const build = context.buildSharePointScopeSummary as (s: unknown, p: string) => { hasSelection: boolean; label: string };
    expect(build(null, 'sharepoint-online')).toMatchObject({ hasSelection: false, label: 'Choose sites, libraries and folders' });
    expect(build({ sites: [], drives: [], folders: [] }, 'one-drive')).toMatchObject({ hasSelection: false, label: 'Choose libraries and folders' });
    expect(build({ sites: [{ id: 'a', name: 'A' }], drives: [{ id: 'b', name: 'B' }], folders: [{ id: 'c', name: 'C', driveId: 'b' }] }, 'sharepoint-online')).toMatchObject({
      hasSelection: true,
      label: 'Sites: 1, libraries: 1, folders: 1',
    });
    expect(build({ sites: [], drives: [], folders: [{ id: 'c', name: 'C', driveId: 'b' }] }, 'one-drive').label).toBe('Libraries: 0, folders: 1');
  });
});

describe('SharePointScopePickerModal (UI-SPEC 6.7)', () => {
  async function openSharePoint(fetchMock = standardFetch(), options: Record<string, unknown> = {}) {
    const loaded = loadContext(fetchMock.fn);
    const picker = newPicker(loaded, 'sharepoint-online', { modeLabel: 'Soft delete', ...options });
    const closed = picker.openPicker() as Promise<unknown>;
    await flush();
    return { loaded, picker, closed, modal: modalOf(loaded), fetchMock };
  }

  it('tracer: lists sites, opens a site, checks a library and saves one PATCH with the selection', async () => {
    const { modal, fetchMock, closed } = await openSharePoint();
    expect(fetchMock.calls[0]!.url).toBe('/api/nango/sharepoint/sites');
    buttonByLabel(modal, 'Open site Site A').click();
    await flush();
    expect(fetchMock.calls[1]!.url).toBe('/api/nango/sharepoint/drives?site_id=site-a');
    check(checkboxFor(modal, 'Library 1'));
    buttonByText(modal, 'Save selection').click();
    await flush();
    const patches = fetchMock.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe('/api/nango/connections');
    expect(patches[0]!.body).toEqual({
      provider: 'sharepoint-online',
      sourceScope: { sites: [], drives: [{ id: 'drive-1', name: 'Library 1', parentId: 'site-a' }], folders: [] },
    });
    await expect(closed).resolves.toMatchObject({ saved: true });
  });

  it('has the fixed title and never renders a Graph URL, cursor or extra response field', async () => {
    const fetchMock = standardFetch((url) =>
      url.startsWith('/api/nango/sharepoint/sites')
        ? { body: { items: [{ id: 'site-a', name: 'Site A', has_children: true, webUrl: 'https://graph.microsoft.com/v1.0/sites/x', '@odata.deltaLink': 'https://graph.microsoft.com/delta' }], cursor: 'spc1.aHR0cHM6Ly9ncmFwaC5taWNyb3NvZnQuY29t' } }
        : undefined,
    );
    const { modal, loaded } = await openSharePoint(fetchMock);
    expect(modal.querySelector('h3')!.textContent).toBe('Choose what to sync');
    const text = loaded.doc.body.innerHTML;
    expect(text).not.toContain('graph.microsoft.com');
    expect(text).not.toContain('spc1.');
    expect(text).not.toContain('deltaLink');
    expect(loaded.doc.innerHtmlWrites).toBe(1);
  });

  it('loading: aria-busy with the level text, then focus on the level heading with the count', async () => {
    let release: (value: { body: unknown }) => void = () => {};
    const fetchMock = fakeFetch(() => new Promise((resolve) => (release = resolve)));
    const loaded = loadContext(fetchMock.fn);
    newPicker(loaded, 'sharepoint-online').openPicker();
    await flush();
    const modal = modalOf(loaded);
    const region = modal.querySelector('[data-sharepoint-scope-list]')!;
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(region.textContent).toContain('Loading sites…');
    expect(region.querySelector('.loading-spinner')).not.toBeNull();
    release({ body: SITES });
    await flush();
    expect(region.getAttribute('aria-busy')).toBe('false');
    const heading = region.querySelector('h4')!;
    expect(heading.textContent).toBe('Sites: 2');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(loaded.doc.activeElement).toBe(heading);
  });

  it('empty sites, a search with no match (query as text, 300 ms, two characters) and the search label', async () => {
    const fetchMock = fakeFetch(() => ({ body: { items: [], cursor: null } }));
    const loaded = loadContext(fetchMock.fn);
    newPicker(loaded, 'sharepoint-online').openPicker();
    await flush();
    const modal = modalOf(loaded);
    expect(modal.textContent).toContain('No site was found for this account. The connected account needs access to at least one site.');
    expect(modal.textContent).toContain('Type at least 2 characters to find a site.');
    const input = modal.querySelector('input[type="search"]')!;
    expect(input.getAttribute('placeholder')).toBe('Search sites by name…');
    const label = modal.querySelector(`label[for="${input.id}"]`)!;
    expect(label.textContent.trim()).toBe('Search sites');

    input.value = 'a';
    input.dispatch('input');
    loaded.timers.at(-1)!.fn();
    await flush();
    expect(fetchMock.calls.filter((c) => c.url.includes('query='))).toHaveLength(0);

    input.value = XSS_PAYLOAD;
    input.dispatch('input');
    expect(loaded.timers.at(-1)!.ms).toBe(300);
    loaded.timers.at(-1)!.fn();
    await flush();
    expect(fetchMock.calls.at(-1)!.url).toBe(`/api/nango/sharepoint/sites?query=${encodeURIComponent(XSS_PAYLOAD)}`);
    expect(modal.textContent).toContain(`No site matches “${XSS_PAYLOAD}”.`);
    expect(injectedElements(loaded.doc)).toEqual([]);
  });

  it('empty libraries and empty folders show their sentences; the search is shown on the Sites level only', async () => {
    const fetchMock = standardFetch((url) => (url.startsWith('/api/nango/sharepoint/drives') || url.startsWith('/api/nango/sharepoint/folders') ? { body: { items: [], cursor: null } } : undefined));
    const { modal } = await openSharePoint(fetchMock);
    buttonByLabel(modal, 'Open site Site A').click();
    await flush();
    expect(modal.textContent).toContain('This site has no document library the connected account can read.');
    expect(modal.querySelector('input[type="search"]')).toBeNull();

    const od = loadContext(fakeFetch((url) => (url.includes('/drives') ? { body: DRIVES } : { body: { items: [], cursor: null } })).fn);
    newPicker(od, 'one-drive').openPicker();
    await flush();
    const odModal = modalOf(od);
    buttonByLabel(odModal, 'Open library Library 1').click();
    await flush();
    expect(odModal.textContent).toContain('This folder has no sub-folders. Select it to sync the files in it.');
  });

  it('a 429 shows the throttled alert, any other failure the load-failed alert, each with Reload list', async () => {
    let status = 429;
    const fetchMock = fakeFetch(() => (status === 200 ? { body: SITES } : { status, body: { error: 'x' } }));
    const loaded = loadContext(fetchMock.fn);
    newPicker(loaded, 'sharepoint-online').openPicker();
    await flush();
    const modal = modalOf(loaded);
    expect(modal.querySelector('.alert-warning')!.textContent).toContain('The source is limiting requests. Wait a moment, then select Reload list.');
    status = 502;
    buttonByText(modal, 'Reload list').click();
    await flush();
    expect(modal.querySelector('.alert-error')!.textContent).toContain('This list could not be loaded.');
    status = 200;
    buttonByText(modal, 'Reload list').click();
    await flush();
    expect(modal.querySelector('h4')!.textContent).toBe('Sites: 2');
    expect(fetchMock.calls).toHaveLength(3);
  });

  it('selecting an ancestor removes covered descendants, which then show as checked, disabled and included', async () => {
    const { modal } = await openSharePoint();
    buttonByLabel(modal, 'Open site Site A').click();
    await flush();
    buttonByLabel(modal, 'Open library Library 1').click();
    await flush();
    check(checkboxFor(modal, 'Folder 1'));
    expect(modal.textContent).toContain('Selected: sites 0, libraries 0, folders 1');
    const crumbs = modal.querySelector('nav[aria-label="Location"]')!;
    expect(crumbs.querySelector('[aria-current="page"]')!.textContent).toBe('Library 1');
    buttonByText(crumbs, 'Site A').click();
    await flush();
    check(checkboxFor(modal, 'Library 1'));
    expect(modal.textContent).toContain('Selected: sites 0, libraries 1, folders 0');
    buttonByLabel(modal, 'Open library Library 1').click();
    await flush();
    const box = checkboxFor(modal, 'Folder 1');
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(rowOf(modal, 'Folder 1').textContent).toContain('Included by Library 1');
  });

  it('removing a saved item shows the narrowing warning with the mode words; Close or Discard says what it does', async () => {
    const saved = { sites: [], drives: [{ id: 'drive-1', name: 'Library 1', parentId: 'site-a' }], folders: [] };
    const { modal, closed, fetchMock } = await openSharePoint(standardFetch(), { savedScope: saved, modeLabel: 'Soft delete' });
    expect(buttonByText(modal, 'Save selection').disabled).toBe(true);
    buttonByText(modal, 'Close picker');
    buttonByLabel(modal, 'Open site Site A').click();
    await flush();
    expect(checkboxFor(modal, 'Library 1').checked).toBe(true);
    check(checkboxFor(modal, 'Library 1'), false);
    expect(modal.textContent).toContain('Nothing selected');
    const warning = modal.querySelector('.alert-warning')!;
    expect(warning.textContent).toContain(
      "Removed from the selection: 1. Files outside the new selection are removed from the knowledge base at the next full sync, following this connection's deletion mode (Soft delete).",
    );
    expect(buttonByText(modal, 'Save selection').disabled).toBe(false);
    buttonByText(modal, 'Discard changes').click();
    await expect(closed).resolves.toMatchObject({ saved: false });
    expect(fetchMock.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('save: Saving… while it runs, Escape is inert, a failure keeps the modal open with the alert line', async () => {
    let release: (value: { status: number; body: unknown }) => void = () => {};
    const fetchMock = standardFetch((_url, method) => (method === 'PATCH' ? new Promise((resolve) => (release = resolve)) : undefined));
    const { modal, loaded, picker } = await openSharePoint(fetchMock);
    check(checkboxFor(modal, 'Site A'));
    buttonByText(modal, 'Save selection').click();
    await flush();
    const save = modal.querySelectorAll('button').find((b) => b.textContent.includes('Saving…'))!;
    expect(save.disabled).toBe(true);
    for (const fn of loaded.doc.listeners.get('keydown') ?? []) fn({ key: 'Escape', type: 'keydown' } as never);
    expect(picker.isOpen).toBe(true);
    release({ status: 500, body: { error: 'x' } });
    await flush();
    expect(picker.isOpen).toBe(true);
    expect(modal.querySelector('[role="alert"]')!.textContent).toBe('The selection was not saved. Try again.');
    expect(buttonByText(modal, 'Save selection').disabled).toBe(false);
  });

  it('a successful save closes the modal and reports "Selection saved for {provider}."', async () => {
    const onSaved = vi.fn();
    const { modal, picker } = await openSharePoint(standardFetch(), { onSaved });
    check(checkboxFor(modal, 'Site B'));
    buttonByText(modal, 'Save selection').click();
    await flush();
    expect(picker.isOpen).toBe(false);
    expect(onSaved).toHaveBeenCalledWith('Selection saved for SharePoint Online.', { sites: [{ id: 'site-b', name: 'Site B' }], drives: [], folders: [] });
  });

  it('Load more sends the cursor and appends the next page; folders without sub-folders have no Open button', async () => {
    const fetchMock = standardFetch((url) => {
      if (url === '/api/nango/sharepoint/sites') return { body: { items: SITES.items, cursor: 'spc1.next' } };
      if (url.startsWith('/api/nango/sharepoint/sites?cursor=')) return { body: { items: [{ id: 'site-c', name: 'Site C', has_children: true }], cursor: null } };
      return undefined;
    });
    const { modal } = await openSharePoint(fetchMock);
    buttonByText(modal, 'Load more sites').click();
    await flush();
    expect(fetchMock.calls.at(-1)!.url).toBe('/api/nango/sharepoint/sites?cursor=spc1.next');
    expect(modal.querySelector('h4')!.textContent).toBe('Sites: 3');
    expect(modal.querySelectorAll('button').some((b) => b.textContent.trim() === 'Load more sites')).toBe(false);

    buttonByLabel(modal, 'Open site Site A').click();
    await flush();
    buttonByLabel(modal, 'Open library Library 1').click();
    await flush();
    expect(fetchMock.calls.at(-1)!.url).toBe('/api/nango/sharepoint/folders?drive_id=drive-1');
    expect(modal.querySelector('h4')!.textContent).toBe('Folders in Library 1: 2');
    expect(modal.querySelectorAll('button').some((b) => b.getAttribute('aria-label') === 'Open folder Folder 2')).toBe(false);
    buttonByLabel(modal, 'Open folder Folder 1');
    const list = modal.querySelector('[data-sharepoint-scope-list]')!;
    expect(list.className).toContain('max-h-96');
  });

  it('Show selection lists paths with a labelled Remove button that updates the summary', async () => {
    const { modal } = await openSharePoint();
    buttonByLabel(modal, 'Open site Site A').click();
    await flush();
    check(checkboxFor(modal, 'Library 2'));
    const details = modal.querySelector('details')!;
    expect(details.querySelector('summary')!.textContent).toBe('Show selection');
    expect(details.textContent).toContain('Site A / Library 2');
    buttonByLabel(modal, 'Remove Library 2 from the selection').click();
    expect(modal.textContent).toContain('Nothing selected');
    expect(checkboxFor(modal, 'Library 2').checked).toBe(false);
  });

  it('OneDrive starts at Libraries, sends the provider and never sends sites', async () => {
    const fetchMock = standardFetch();
    const loaded = loadContext(fetchMock.fn);
    newPicker(loaded, 'one-drive').openPicker();
    await flush();
    const modal = modalOf(loaded);
    expect(fetchMock.calls[0]!.url).toBe('/api/nango/sharepoint/drives?provider=one-drive');
    expect(modal.querySelector('h4')!.textContent).toBe('Libraries: 2');
    expect(modal.querySelector('[aria-current="page"]')!.textContent).toBe('Libraries');
    buttonByLabel(modal, 'Open library Library 1').click();
    await flush();
    expect(fetchMock.calls.at(-1)!.url).toBe('/api/nango/sharepoint/folders?drive_id=drive-1&provider=one-drive');
    check(checkboxFor(modal, 'Folder 2'));
    buttonByText(modal, 'Save selection').click();
    await flush();
    expect(fetchMock.calls.at(-1)!.body).toEqual({
      provider: 'one-drive',
      sourceScope: { sites: [], drives: [], folders: [{ id: 'folder-2', name: 'Folder 2', driveId: 'drive-1' }] },
    });
  });

  it('markup and script in names render as text in rows, breadcrumb, Show selection and the card summary', async () => {
    const evil = `${XSS_PAYLOAD}javascript:alert(1)${'x'.repeat(200)}`;
    const fetchMock = standardFetch((url) => {
      if (url.startsWith('/api/nango/sharepoint/sites')) return { body: { items: [{ id: 'site-a', name: evil, has_children: true }], cursor: null } };
      if (url.startsWith('/api/nango/sharepoint/drives')) return { body: { items: [{ id: 'drive-1', name: evil, has_children: true }], cursor: null } };
      return undefined;
    });
    const { modal, loaded } = await openSharePoint(fetchMock);
    buttonByLabel(modal, `Open site ${evil}`).click();
    await flush();
    check(checkboxFor(modal, evil));
    expect(modal.querySelector('nav')!.textContent).toContain(evil);
    expect(modal.querySelector('nav [title]')!.className).toContain('max-w-40');
    expect(modal.querySelector('details')!.textContent).toContain(`${evil} / ${evil}`);
    expect(modal.querySelector('details li span')!.className).toContain('break-words');
    expect(injectedElements(loaded.doc)).toEqual([]);
    expect(loaded.doc.body.querySelectorAll('a')).toHaveLength(0);
    expect(loaded.doc.innerHtmlWrites).toBe(1);
  });
});

describe('in-app connector grid (D-24, D-26)', () => {
  it('lists SharePoint Online and OneDrive only with the switch on', async () => {
    vi.stubEnv('NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED', 'false');
    const off = await import('@/components/ui/nango/connector-grid');
    expect(off.connectorGridProviders()).toEqual(['google-drive', 'dropbox', 'notion']);
    vi.stubEnv('NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED', 'true');
    expect(off.connectorGridProviders()).toEqual(['google-drive', 'dropbox', 'notion', 'sharepoint-online', 'one-drive']);
  });
});
