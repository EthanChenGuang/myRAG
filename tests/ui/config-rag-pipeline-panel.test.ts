import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, blockFrom, injectedElements, XSS_PAYLOAD } from './helpers/html-fake-dom';
import { compatAnswer, entry, flush, indexHtml, loadPipelinePage, secretEntry, type Call } from './helpers/rag-pipeline-harness';

const SCRIPT = fs.readFileSync('scripts/config-ui/rag-panels/rag-pipeline.js', 'utf8');

function text(el: FakeElement | null | undefined): string {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

const FIXTURE = [
  entry('RAG_INGEST_PIPELINE', { group: 'data', type: 'enum', options: ['legacy', 'unified'], default: 'legacy', value: 'unified', label: 'Ingestion pipeline' }),
  entry('RAG_PIPELINE', { group: 'retrieval', type: 'enum', options: ['legacy', 'v2'], default: 'legacy', label: 'Pipeline' }),
  entry('RAG_LEXICAL_SEARCH', { group: 'retrieval', type: 'bool', default: 'false', requires: ['RAG_PIPELINE=v2'], label: 'Lexical search', help: 'Adds a lexical list next to the dense list.' }),
  entry('RAG_RERANKER', { group: 'ranking', type: 'enum', options: ['none', 'cohere', 'voyage', 'local_bm25', 'auto'], default: 'none', requires: ['RAG_PIPELINE=v2'], label: 'Reranker' }),
  entry('RAG_CONTEXT_TOKEN_BUDGET', { group: 'ranking', type: 'number', default: '6000', requires: ['RAG_PIPELINE=v2'], label: 'Context token budget' }),
  entry('RAG_QUERY_LLM_MODEL', { group: 'query', type: 'string', default: 'model-a', requires: ['RAG_PIPELINE=v2'], label: 'Query model' }),
  entry('RAG_QUERY_LAYER', { group: 'query', type: 'bool', default: 'false', value: 'true', label: 'Query layer' }),
  entry('RAG_SWITCH_ON_OFF', { group: 'query', type: 'enum', options: ['off', 'on'], default: 'off', label: 'On or off switch' }),
  entry('QDRANT_URL', { group: 'backends', type: 'url', provider: 'qdrant', requires: ['RAG_PIPELINE=v2'], label: 'Qdrant URL' }),
  secretEntry('QDRANT_API_KEY', { provider: 'qdrant', requires: ['RAG_PIPELINE=v2'], label: 'Qdrant API key', secret: { state: 'set', last4: 'a1b2' } }),
  secretEntry('VOYAGE_API_KEY', { group: 'ranking', provider: 'voyage', label: 'Voyage API key', secret: { state: 'set' } }),
  entry('RAG_RETRIEVAL_BACKEND', { group: 'backends', type: 'enum', options: ['pgvector', 'weaviate', 'qdrant'], default: 'pgvector', label: 'Retrieval backend' }),
  entry('RAG_ODD_SETTING', { group: 'zeta', type: 'matrix', label: 'Odd setting' }),
  entry('RAG_PARSE_ROUTING', { group: 'data', type: 'enum', options: ['fixed', 'tiered'], default: 'fixed', value: 'tiered', label: 'Parse routing' }),
  entry('OPENROUTER_API_KEY_LIKE_URL', { group: 'generation', type: 'url', provider: 'openrouter', label: 'Router URL' }),
];

const STAGING = `<div class="tab-content" id="rag-administration"><div id="rag-ingestion-settings" class="hidden">
  <select id="RAG_PARSE_ROUTING"><option value="fixed">fixed</option><option value="tiered">tiered</option></select></div></div>
  <a data-tab="rag-administration">RAG administration</a>`;

async function mounted(options: Parameters<typeof loadPipelinePage>[0] = {}) {
  const page = loadPipelinePage({ entries: FIXTURE, before: STAGING, ...options });
  await flush();
  return page;
}

describe('generated RAG pipeline section: rows (07-20 Task 2)', () => {
  it('every managed entry has exactly one row; a control that exists outside the section becomes a hosted row', async () => {
    const { doc, section, row } = await mounted();
    for (const e of FIXTURE) expect(section().querySelectorAll(`[data-rag-pipeline-row="${e.name}"]`), String(e.name)).toHaveLength(1);
    const hosted = row('RAG_PARSE_ROUTING')!;
    expect(hosted.querySelector('select')).toBeNull();
    expect(hosted.querySelector('input')).toBeNull();
    expect(text(hosted)).toContain('Current value: tiered');
    expect(text(hosted)).toContain('Edited under RAG administration.');
    expect(text(hosted.querySelector('[data-rag-pipeline-show]'))).toBe('Show setting');
    const all = doc.querySelectorAll('select').filter((el) => el.id === 'RAG_PARSE_ROUTING');
    expect(all).toHaveLength(1);
  });

  it('groups render in the fixed order with an unknown group last', async () => {
    const { section } = await mounted();
    const groups = section().querySelectorAll('[data-rag-pipeline-group]').map((el) => el.getAttribute('data-rag-pipeline-group'));
    expect(groups).toEqual(['data', 'query', 'retrieval', 'ranking', 'generation', 'backends', 'zeta']);
    expect(text(section().querySelector('[data-rag-pipeline-group="zeta"] h4'))).toBe('zeta');
    const jumps = section().querySelectorAll('[data-rag-pipeline-jump]').map((el) => el.getAttribute('data-rag-pipeline-jump'));
    expect(jumps).toEqual(groups);
  });

  it('a bool entry is a checkbox writing true or false; an on/off enum is a select in manifest order', async () => {
    const { control } = await mounted();
    const bool = control('RAG_QUERY_LAYER')!;
    expect(bool.tagName).toBe('input');
    expect(bool.getAttribute('type')).toBe('checkbox');
    expect(bool.getAttribute('name')).toBe('RAG_QUERY_LAYER');
    expect(bool.checked).toBe(true);
    const select = control('RAG_SWITCH_ON_OFF')!;
    expect(select.tagName).toBe('select');
    expect(select.querySelectorAll('option').map((o) => o.getAttribute('value'))).toEqual(['off', 'on']);
    expect(select.value).toBe('off');
    expect(control('RAG_RERANKER')!.querySelectorAll('option').map((o) => o.getAttribute('value'))).toEqual(['none', 'cohere', 'voyage', 'local_bm25', 'auto']);
  });

  it('help: an entry with help renders it and the control references it; an entry without help has no help paragraph', async () => {
    const { doc, control } = await mounted();
    expect(text(doc.getElementById('rag-pipeline-help-RAG_LEXICAL_SEARCH'))).toBe('Adds a lexical list next to the dense list.');
    expect(control('RAG_LEXICAL_SEARCH')!.getAttribute('aria-describedby')).toContain('rag-pipeline-help-RAG_LEXICAL_SEARCH');
    expect(doc.getElementById('rag-pipeline-help-RAG_RERANKER')).toBeNull();
    expect(control('RAG_RERANKER')!.getAttribute('aria-describedby')).not.toContain('rag-pipeline-help');
  });

  it('an unset non-secret entry shows the manifest default as placeholder and in the default line; a changed value gets the badge', async () => {
    const { row, control, section } = await mounted();
    expect(control('RAG_CONTEXT_TOKEN_BUDGET')!.placeholder).toBe('6000');
    expect(control('RAG_CONTEXT_TOKEN_BUDGET')!.getAttribute('type')).toBe('number');
    expect(control('RAG_QUERY_LLM_MODEL')!.placeholder).toBe('model-a');
    expect(text(row('RAG_CONTEXT_TOKEN_BUDGET'))).toContain('Default: 6000');
    expect(row('RAG_CONTEXT_TOKEN_BUDGET')!.querySelector('[data-rag-pipeline-changed]')).toBeNull();
    expect(row('RAG_QUERY_LAYER')!.querySelector('[data-rag-pipeline-changed]')).not.toBeNull();
    expect(text(row('RAG_QUERY_LAYER'))).toContain('Default: Off');
    expect(text(section().querySelector('[data-rag-pipeline-jump="query"]'))).toContain('Changed: 1');
    expect(text(row('QDRANT_URL'))).toContain('Default: empty');
  });

  it('requires: unmet requirements disable bool, enum, number and string controls with a hint; url and secret stay enabled', async () => {
    const { control, doc } = await mounted();
    for (const name of ['RAG_LEXICAL_SEARCH', 'RAG_RERANKER', 'RAG_CONTEXT_TOKEN_BUDGET', 'RAG_QUERY_LLM_MODEL']) {
      expect(control(name)!.disabled, name).toBe(true);
      const hint = doc.getElementById(`rag-pipeline-requires-${name}`)!;
      expect(hint.hidden).toBe(false);
      expect(text(hint)).toBe('Used only when Pipeline is v2.');
      expect(control(name)!.getAttribute('aria-describedby')).toContain(`rag-pipeline-requires-${name}`);
    }
    for (const name of ['QDRANT_URL', 'QDRANT_API_KEY']) {
      expect(control(name)!.disabled, name).toBe(false);
      expect(text(doc.getElementById(`rag-pipeline-requires-${name}`))).toBe('Used only when Pipeline is v2.');
    }
    const pipeline = control('RAG_PIPELINE')!;
    pipeline.value = 'v2';
    pipeline.dispatch('change');
    for (const name of ['RAG_LEXICAL_SEARCH', 'RAG_RERANKER', 'RAG_CONTEXT_TOKEN_BUDGET', 'RAG_QUERY_LLM_MODEL']) {
      expect(control(name)!.disabled, name).toBe(false);
      expect(doc.getElementById(`rag-pipeline-requires-${name}`)!.hidden).toBe(true);
    }
  });

  it('secrets: an empty password field, the stored line with last4 only, and no reveal button carrying data-for', async () => {
    const { control, row } = await mounted();
    const key = control('QDRANT_API_KEY')!;
    expect(key.getAttribute('type')).toBe('password');
    expect(key.value).toBe('');
    expect(key.hasAttribute('value')).toBe(false);
    expect(key.placeholder).toBe('Type a new value to replace the stored one');
    expect(text(row('QDRANT_API_KEY'))).toContain('Stored, ends in a1b2');
    expect(text(row('VOYAGE_API_KEY'))).toContain('Stored');
    expect(row('QDRANT_API_KEY')!.querySelector('[data-for]')).toBeNull();
    expect(row('QDRANT_API_KEY')!.querySelector('[data-rag-pipeline-changed]')).toBeNull();
    key.value = 'typed-value-xyz';
    key.dispatch('input');
    expect(text(row('QDRANT_API_KEY'))).toContain('New value typed.');
  });

  it('after rag-config-saved a typed secret is emptied, dropped from configManager.config and its stored line reloaded', async () => {
    const page = await mounted();
    const key = page.control('QDRANT_API_KEY')!;
    key.value = 'typed-value-xyz';
    key.dispatch('input');
    page.configManager.config.QDRANT_API_KEY = 'typed-value-xyz';
    page.configManager.config.RAG_PIPELINE = 'v2';
    page.doc.dispatch('rag-config-saved');
    await flush();
    expect(key.value).toBe('');
    expect(key.getAttribute('type')).toBe('password');
    expect(page.configManager.config.QDRANT_API_KEY).toBeUndefined();
    expect(page.configManager.config.RAG_PIPELINE).toBe('v2');
    expect(text(page.row('QDRANT_API_KEY'))).toContain('Stored, ends in a1b2');
    expect(text(page.section().querySelector('[data-rag-pipeline-status]'))).toContain('Qdrant API key: new value stored.');
    expect(page.calls.filter((c) => c.path === '/api/rag-pipeline/manifest')).toHaveLength(2);
  });

  it('the section writes nothing into the page config by itself, so only changed values are posted', async () => {
    const page = await mounted();
    expect(page.configManager.config).toEqual({});
  });

  it('an unknown type renders a read-only row with a warning instead of throwing', async () => {
    const { row } = await mounted();
    const odd = row('RAG_ODD_SETTING')!;
    expect(odd.querySelector('input')).toBeNull();
    expect(odd.querySelector('select')).toBeNull();
    expect(text(odd)).toContain('This page does not know this setting’s type (matrix). Edit it in .env.local.');
  });

  it('a failed or empty manifest shows the error alert with Reload settings and no rows', async () => {
    const failed = loadPipelinePage({ manifest: { status: 500, body: { success: false } } });
    await flush();
    expect(text(failed.section())).toContain('The settings could not be loaded from the Config UI server.');
    expect(failed.section().querySelectorAll('[data-rag-pipeline-row]')).toHaveLength(0);
    const empty = loadPipelinePage({ entries: [] });
    await flush();
    expect(text(empty.section())).toContain('The settings list is empty.');
  });

  it('manifest text is inert: labels, help, defaults and values never become elements', async () => {
    const page = loadPipelinePage({
      entries: [
        entry('RAG_PIPELINE', { label: XSS_PAYLOAD, help: '<script>PWNED(2)</script>', default: XSS_PAYLOAD, value: XSS_PAYLOAD, type: 'enum', options: [XSS_PAYLOAD] }),
        entry('RAG_OTHER', { group: XSS_PAYLOAD, provider: XSS_PAYLOAD, type: 'url' }),
      ],
    });
    await flush();
    expect(injectedElements(page.doc)).toHaveLength(0);
    expect(page.doc.created).not.toContain('script');
    expect(page.doc.innerHtmlWrites).toBe(0);
  });

  it('localizes the section text', async () => {
    const page = loadPipelinePage({ entries: FIXTURE, locale: 'it-IT' });
    await flush();
    expect(text(page.section().querySelector('[data-rag-pipeline-title]'))).toBe('Impostazioni della pipeline RAG');
    expect(page.section().getAttribute('lang')).toBe('it');
  });
});

describe('index.html wiring (07-20 Task 2)', () => {
  const configManager = blockFrom(indexHtml, indexHtml.indexOf('class ConfigManager'));

  function method(name: string): string {
    return blockFrom(configManager, configManager.search(new RegExp(`\\n\\s+(?:async\\s+)?${name}\\(\\)\\s*\\{`)));
  }

  it('saveConfig dispatches rag-config-saved after a successful POST and not after a failed one', async () => {
    for (const ok of [true, false]) {
      const doc = new FakeDocument();
      const events: string[] = [];
      doc.addEventListener('rag-config-saved', () => events.push('saved'));
      (doc as unknown as { dispatchEvent: (e: { type: string }) => boolean }).dispatchEvent = (e) => {
        doc.dispatch(e.type);
        return true;
      };
      const context: Record<string, unknown> = {
        document: doc,
        console: { log() {}, error() {}, warn() {} },
        CustomEvent: class {
          type: string;
          constructor(type: string) {
            this.type = type;
          }
        },
        fetch: async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ success: ok }) }),
        ragGuardedSave: async (_opts: unknown, post: () => Promise<unknown>) => post(),
        ragGateRequiredAnswer: () => false,
        showRagSaveHeld() {},
        showToast() {},
        setTimeout,
      };
      context.window = context;
      vm.createContext(context);
      vm.runInContext(`${configManager}; this.cm = Object.create(ConfigManager.prototype);`, context);
      const cm = context.cm as { config: Record<string, string>; savedConfig: Record<string, string>; showSaveIndicator: () => void; saveConfig: () => Promise<void> };
      cm.config = { RAG_PIPELINE: 'v2' };
      cm.savedConfig = {};
      cm.showSaveIndicator = () => {};
      await cm.saveConfig();
      expect(events, `ok=${ok}`).toEqual(ok ? ['saved'] : []);
    }
  });

  it('populateFields skips every field inside #rag-pipeline-settings', () => {
    const body = method('populateFields');
    expect(body.match(/closest\('#rag-pipeline-settings'\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Test connection, warnings and sync (07-20 Task 3)', () => {
  it('probe map: every probe id named by rag-pipeline.js is in PROVIDER_IDS of provider-probes.ts', async () => {
    const source = fs.readFileSync('src/lib/rag/admin/provider-probes.ts', 'utf8');
    const block = source.slice(source.indexOf('export const PROVIDER_IDS'), source.indexOf('] as const', source.indexOf('export const PROVIDER_IDS')));
    const ids = new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]));
    const mod = (await import('../../scripts/config-ui/rag-panels/rag-pipeline.js')) as unknown as { default?: unknown } & Record<string, unknown>;
    const probes = ((mod.RAG_PIPELINE_PROVIDER_PROBES ?? (mod.default as Record<string, unknown>).RAG_PIPELINE_PROVIDER_PROBES) as Record<string, string[]>);
    const named = Object.values(probes).flat();
    expect(named.length).toBeGreaterThan(0);
    for (const id of named) expect(ids.has(id), id).toBe(true);
    expect(probes.qdrant).toEqual(['backend:qdrant']);
    expect(probes.voyage).toEqual(['embedding:voyage', 'rerank:voyage']);
    for (const none of ['openrouter', 'judge', 'prompt_guard']) expect(probes[none]).toBeUndefined();
  });

  it('a provider with probes has one Test connection button that posts once per probe in order and words each result', async () => {
    const page = await mounted({
      test: (call: Call) => {
        const provider = (call.body as { provider: string }).provider;
        return provider === 'rerank:voyage'
          ? { status: 200, body: { provider, ok: false, latencyMs: 0, code: 'unauthorized', message: 'x' } }
          : { status: 200, body: { provider, ok: true, latencyMs: 42, code: 'ok', message: 'x' } };
      },
    });
    const block = page.section().querySelector('[data-rag-pipeline-provider="voyage"]')!;
    const buttons = block.querySelectorAll('[data-rag-pipeline-test]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Test connection: Voyage AI');
    buttons[0]!.click();
    await flush();
    const posted = page.calls.filter((c) => c.path === '/api/rag/admin/providers/test').map((c) => c.body);
    expect(posted).toEqual([{ provider: 'embedding:voyage' }, { provider: 'rerank:voyage' }]);
    const lines = block.querySelectorAll('[data-rag-pipeline-test-line]').map(text);
    expect(lines).toEqual(['Embeddings: Connected. Answered in 42 ms.', 'Reranker: The provider refused the key. Check the key, restart the app, then test again.']);
    expect(JSON.stringify(page.calls)).not.toMatch(/api_key|https?:\/\//i);
  });

  it('a provider without a probe shows the no-test line and no button; unknown codes are worded with the code', async () => {
    const page = await mounted({ test: (call) => ({ status: 200, body: { provider: (call.body as { provider: string }).provider, ok: false, latencyMs: 0, code: 'rate_limited', message: 'x' } }) });
    const router = page.section().querySelector('[data-rag-pipeline-provider="openrouter"]')!;
    expect(router.querySelector('[data-rag-pipeline-test]')).toBeNull();
    expect(text(router)).toContain('No connection test exists for this provider.');
    const qdrant = page.section().querySelector('[data-rag-pipeline-provider="qdrant"]')!;
    qdrant.querySelector('[data-rag-pipeline-test]')!.click();
    await flush();
    expect(text(qdrant.querySelector('[data-rag-pipeline-test-result]'))).toContain('The test failed (rate_limited).');
  });

  it('a 401 from the test route shows the sign-in sentence', async () => {
    const page = await mounted({ test: () => ({ status: 401, body: { error: 'unauthorized' } }) });
    const qdrant = page.section().querySelector('[data-rag-pipeline-provider="qdrant"]')!;
    qdrant.querySelector('[data-rag-pipeline-test]')!.click();
    await flush();
    expect(text(qdrant.querySelector('[data-rag-pipeline-test-result]'))).toContain('Admin sign-in required');
    expect(text(page.section().querySelector('[data-rag-pipeline-alert]'))).toContain('You can change settings without signing in.');
  });

  it('the warnings banner lists each index-compat warning with its code and backend, and is absent without warnings', async () => {
    const quiet = await mounted();
    expect(quiet.section().querySelector('[data-rag-pipeline-compat-alert]')).toBeNull();
    expect(text(quiet.section().querySelector('[data-rag-pipeline-compat-ok]'))).toBe('No index compatibility warnings.');
    const page = await mounted({
      compat: {
        status: 200,
        body: compatAnswer({
          warnings: [
            { code: 'sync_not_enabled', backend: 'qdrant', detail: {} },
            { code: 'dimension_mismatch', backend: 'weaviate', detail: { profileId: 'profile-a', profileDims: 1024, collectionDims: 1536 } },
            { code: 'brand_new_code', backend: 'qdrant', detail: {} },
          ],
        }),
      },
    });
    const items = page.section().querySelectorAll('[data-rag-pipeline-warning]');
    expect(items.map((li) => li.getAttribute('data-rag-pipeline-warning'))).toEqual(['sync_not_enabled', 'dimension_mismatch', 'brand_new_code']);
    expect(text(items[0])).toContain('Qdrant is selected, but sync to it is off.');
    expect(text(items[1])).toContain('The Weaviate collection has 1536 dimensions; the active embedding profile has 1024.');
    expect(text(items[2])).toContain('A warning this page does not know was reported for Qdrant.');
    expect(text(page.section().querySelector('[data-rag-pipeline-jump="backends"]'))).toContain('Warnings: 3');
  });

  it('the backends group shows a sync toggle per target with counts and switches it through PUT after the dialog', async () => {
    const page = await mounted({
      compat: {
        status: 200,
        body: compatAnswer({
          backends: [
            { target: 'qdrant', enabled: false, pending: 3, leased: 1, dead: 2, oldestPendingSeconds: 30, profiles: [{ profileId: 'profile-a', ready: 12, building: 1, stale: 0, failed: 0 }] },
            { target: 'weaviate', enabled: true, pending: 0, leased: 0, dead: 0, oldestPendingSeconds: null, profiles: [] },
          ],
        }),
      },
      targets: { status: 200, body: { success: true, targets: [{ target: 'qdrant', enabled: false }, { target: 'weaviate', enabled: true }] } },
    });
    const qdrant = page.section().querySelector('[data-rag-pipeline-sync-target="qdrant"]')!;
    expect(text(qdrant)).toContain('Waiting: 3');
    expect(text(qdrant)).toContain('In progress: 1');
    expect(text(qdrant)).toContain('Failed permanently: 2');
    expect(text(qdrant.querySelector('table'))).toContain('profile-a');
    expect(text(page.section().querySelector('[data-rag-pipeline-sync-target="weaviate"]'))).toContain('No index state yet.');
    const toggle = page.doc.getElementById('rag-pipeline-sync-qdrant')!;
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.checked).toBe(false);
    toggle.click();
    const dialog = page.doc.querySelector('dialog')!;
    expect(text(dialog)).toContain('Turn on sync to Qdrant?');
    const confirm = dialog.querySelectorAll('button').find((b) => text(b) === 'Turn on sync')!;
    confirm.click();
    await flush();
    expect(page.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ target: 'qdrant', enabled: true }]);
    expect(text(page.section().querySelector('[data-rag-pipeline-status]'))).toContain('Sync to Qdrant is on. Workspaces queued: 3.');
  });

  it('admin routes unavailable: the sync block says so and the rows stay usable', async () => {
    const page = await mounted({ compat: { status: 503, body: { error: 'x' } } });
    expect(text(page.section().querySelector('[data-rag-pipeline-admin-unavailable]'))).toContain('Connection tests, sync status and warnings are unavailable right now.');
    expect(page.control('QDRANT_URL')!.disabled).toBe(false);
  });

  it('shows the restart note when .env.local changed after envLoadedAt', async () => {
    const newer = await mounted({ envModifiedAt: '2026-11-21T10:00:00.000Z' });
    expect(text(newer.section().querySelector('[data-rag-pipeline-alert]'))).toContain('.env.local changed after the app started.');
    const older = await mounted({ envModifiedAt: '2026-11-19T10:00:00.000Z' });
    expect(text(older.section().querySelector('[data-rag-pipeline-alert]'))).not.toContain('.env.local changed');
  });

  it('index.html has the section skeleton in the RAG Modes tab and loads rag-pipeline.js once, after rag-fetch.js and directly after rag-ui.js', () => {
    expect(indexHtml.match(/rag-panels\/rag-pipeline\.js/g)).toHaveLength(1);
    expect(indexHtml).toMatch(/<script src="rag-panels\/rag-ui\.js"><\/script>\s*<script src="rag-panels\/rag-pipeline\.js"><\/script>/);
    expect(indexHtml.indexOf('rag-panels/rag-pipeline.js')).toBeGreaterThan(indexHtml.indexOf('rag-panels/rag-fetch.js'));
    const tabStart = indexHtml.indexOf('id="rag-modes"');
    const tabEnd = indexHtml.indexOf('<!-- RAG Settings Tab -->', tabStart);
    const section = indexHtml.indexOf('id="rag-pipeline-settings"');
    expect(section).toBeGreaterThan(tabStart);
    expect(section).toBeLessThan(tabEnd);
    for (const marker of ['data-rag-pipeline-title', 'data-rag-pipeline-description', 'data-rag-pipeline-secrets-note', 'data-rag-pipeline-alert', 'data-rag-pipeline-nav', 'data-rag-pipeline-content', 'data-rag-pipeline-status']) {
      expect(indexHtml.indexOf(marker, section), marker).toBeGreaterThan(section);
    }
    expect(SCRIPT).toContain("document.addEventListener('DOMContentLoaded', initRagPipelineSettings)");
  });
});
