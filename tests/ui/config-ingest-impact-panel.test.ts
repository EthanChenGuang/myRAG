import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { blockFrom, FakeDocument } from './helpers/html-fake-dom';
import {
  buttonByText,
  flush,
  impactAnswer,
  indexHtml,
  loadImpactPage,
  maybeButton,
  wait,
  type Json,
  type ImpactPage,
} from './helpers/ingest-impact-harness';

type Guard = (next: Json, saved: Json, options?: Json) => Promise<unknown>;

function guardOf(page: ImpactPage): Guard {
  const guard = page.context.ragIngestImpactGuard;
  expect(typeof guard, 'window.ragIngestImpactGuard').toBe('function');
  return guard as Guard;
}

function factoryGuard(page: ImpactPage, options: Json): Guard {
  const create = page.context.ingestImpactCreateGuard;
  expect(typeof create, 'ingestImpactCreateGuard').toBe('function');
  return (create as (o: Json) => Guard)(options);
}

const SAVED: Json = {
  RAG_TABLE_HEADER_REPEAT: 'profile',
  RAG_PIPELINE: 'legacy',
  RAG_CAPTION_LANGUAGE: 'en',
  RAG_SUPPORTED_LANGUAGES: 'zh,en',
  RAG_SIDECAR_SECRET: 'placeholder-secret-one',
  NEXT_PUBLIC_THEME: 'dark',
};

function nextOf(changes: Json): Json {
  return { ...SAVED, ...changes };
}

/** Starts the guard, lets the request settle and returns the pending promise. */
async function initPanel(page: ImpactPage): Promise<void> {
  const init = page.context.initIngestImpactPanel;
  expect(typeof init, 'initIngestImpactPanel').toBe('function');
  await (init as () => Promise<void>)();
}

async function ask(page: ImpactPage, guard: Guard, next: Json, saved: Json = SAVED) {
  let settled = false;
  let value: unknown;
  const promise = guard(next, saved).then((v) => {
    settled = true;
    value = v;
    return v;
  });
  await flush();
  return { promise, settled: () => settled, value: () => value };
}

describe('ragIngestImpactGuard asks the impact route about the changed settings (UI-SPEC 6.4.1)', () => {
  it('posts only the changed RAG_* keys, never a secret-named one or a non-RAG key', async () => {
    const page = loadImpactPage({ replies: { impact: { status: 200, body: impactAnswer({ ingestion_keys: [], by_mechanism: [] }) } } });
    const guard = guardOf(page);
    const next = nextOf({ RAG_TABLE_HEADER_REPEAT: 'always', RAG_PIPELINE: 'v2', RAG_SIDECAR_SECRET: 'placeholder-secret-two', NEXT_PUBLIC_THEME: 'light' });
    const result = await guard(next, SAVED);
    expect(page.calls('impact')).toHaveLength(1);
    expect(page.calls('impact')[0]!.body).toEqual({ proposed: { RAG_PIPELINE: 'v2', RAG_TABLE_HEADER_REPEAT: 'always' } });
    expect(result).toBe(true);
    expect(page.dialog()).toBeNull();
  });

  it('asks nothing when no RAG_* setting changed', async () => {
    const page = loadImpactPage();
    const result = await guardOf(page)(nextOf({ NEXT_PUBLIC_THEME: 'light' }), SAVED);
    expect(result).toBe(true);
    expect(page.ragCalls).toHaveLength(0);
  });

  it('an ingestion-side change with zero affected documents saves without a dialog and adds the toast line', async () => {
    const page = loadImpactPage({
      replies: { impact: { status: 200, body: impactAnswer({ by_mechanism: [{ mechanism: 'rechunk', doc_type: 'general', affected: 0 }] }) } },
    });
    const result = await guardOf(page)(nextOf({ RAG_TABLE_HEADER_REPEAT: 'always' }), SAVED);
    expect(result).toBe(true);
    expect(page.dialog()).toBeNull();
    expect(page.toasts.map((t) => t.message)).toContain('No stored document is affected.');
  });

  it('affected documents open the dialog with the count per mechanism and document type, the warning and focus on Keep current settings', async () => {
    const page = loadImpactPage();
    const run = await ask(page, guardOf(page), nextOf({ RAG_TABLE_HEADER_REPEAT: 'always' }));
    const dialog = page.dialog();
    expect(dialog, 'impact dialog').not.toBeNull();
    expect(run.settled()).toBe(false);
    const text = dialog!.textContent;
    expect(text).toContain('Save changes that affect stored documents?');
    expect(text).toContain('Changed settings');
    expect(text).toContain('Table header repetition');
    expect(text).toContain('Follow the document type, changed to: Always');
    expect(text).toContain('RAG_TABLE_HEADER_REPEAT');
    const rows = dialog!.querySelectorAll('tbody tr').map((tr) => tr.textContent);
    expect(rows.some((r) => r.includes('Rebuild chunks') && r.includes('212'))).toBe(true);
    expect(rows.some((r) => r.includes('Rebuild chunks') && r.includes('41'))).toBe(true);
    expect(rows.some((r) => r.includes('Rebuild chunks') && r.includes('0') && !r.includes('41') && !r.includes('212'))).toBe(false);
    expect(rows[rows.length - 1]).toContain('All affected documents');
    expect(rows[rows.length - 1]).toContain('253');
    expect(text).toContain('Saving rebuilds nothing.');
    const keep = buttonByText(dialog, 'Keep current settings');
    const save = buttonByText(dialog, 'Save settings');
    expect(page.doc.activeElement).toBe(keep);
    expect(save.disabled).toBe(false);
    expect(dialog!.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog!.getAttribute('aria-describedby')).toBeTruthy();
    keep.click();
    await run.promise;
  });

  it('Keep current settings restores only the ingestion-side inputs and lets the other changes save', async () => {
    const page = loadImpactPage();
    page.input('RAG_TABLE_HEADER_REPEAT').value = 'always';
    const next = nextOf({ RAG_TABLE_HEADER_REPEAT: 'always', RAG_PIPELINE: 'v2' });
    const run = await ask(page, guardOf(page), next);
    buttonByText(page.dialog(), 'Keep current settings').click();
    const result = (await run.promise) as Json;
    expect(result).toMatchObject({ RAG_TABLE_HEADER_REPEAT: 'profile', RAG_PIPELINE: 'v2', NEXT_PUBLIC_THEME: 'dark' });
    expect(page.input('RAG_TABLE_HEADER_REPEAT').value).toBe('profile');
    expect(page.dialog()).toBeNull();
    expect(page.status().textContent).toContain('The ingestion settings were not changed. Your other changes were saved.');
  });

  it('Escape works as Keep current settings', async () => {
    const page = loadImpactPage();
    const run = await ask(page, guardOf(page), nextOf({ RAG_TABLE_HEADER_REPEAT: 'always' }));
    const dialog = page.dialog()!;
    dialog.dispatch('cancel');
    dialog.close('cancel');
    const result = (await run.promise) as Json;
    expect(result.RAG_TABLE_HEADER_REPEAT).toBe('profile');
  });

  it('Save settings resolves with the full config and points to the Ingestion changes panel', async () => {
    const page = loadImpactPage();
    const next = nextOf({ RAG_TABLE_HEADER_REPEAT: 'always', RAG_PIPELINE: 'v2' });
    const run = await ask(page, guardOf(page), next);
    buttonByText(page.dialog(), 'Save settings').click();
    const result = await run.promise;
    expect(result).toBe(true);
    expect(page.dialog()).toBeNull();
    expect(page.toasts.map((t) => t.message).join('\n')).toContain('open RAG administration, Ingestion changes');
  });

  it('documents without a fingerprint add the gap line with the backfill command', async () => {
    const page = loadImpactPage({ replies: { impact: { status: 200, body: impactAnswer({ without_fingerprint: 17 }) } } });
    const run = await ask(page, guardOf(page), nextOf({ RAG_TABLE_HEADER_REPEAT: 'always' }));
    const dialog = page.dialog()!;
    expect(dialog.textContent).toContain('Documents not counted because they have no fingerprint yet: 17.');
    expect(dialog.querySelectorAll('code').map((c) => c.textContent)).toContain('npm run rag:fingerprint -- backfill');
    buttonByText(dialog, 'Save settings').click();
    await run.promise;
  });

  it('uncounted documents keep the dialog even when the counted ones are zero', async () => {
    const page = loadImpactPage({
      replies: { impact: { status: 200, body: impactAnswer({ by_mechanism: [{ mechanism: 'rechunk', doc_type: 'general', affected: 0 }], without_fingerprint: 5 }) } },
    });
    const run = await ask(page, guardOf(page), nextOf({ RAG_TABLE_HEADER_REPEAT: 'always' }));
    expect(page.dialog()).not.toBeNull();
    buttonByText(page.dialog(), 'Save settings').click();
    await run.promise;
  });

  it('a security check change adds the rescan sentence', async () => {
    const page = loadImpactPage({
      replies: {
        impact: {
          status: 200,
          body: impactAnswer({ ingestion_keys: ['RAG_INGEST_LINK_CHECK'], by_mechanism: [{ mechanism: 'rescan', doc_type: 'general', affected: 9 }] }),
        },
      },
    });
    const run = await ask(page, guardOf(page), nextOf({ RAG_INGEST_LINK_CHECK: 'flag' }), { ...SAVED, RAG_INGEST_LINK_CHECK: 'off' });
    expect(page.dialog()!.textContent).toContain('Rescan existing documents under Quarantine, Checks');
    buttonByText(page.dialog(), 'Save settings').click();
    await run.promise;
  });

  it.each([
    ['401', { status: 401, body: { error: 'Unauthorized' } }],
    ['403', { status: 403, body: { error: 'Admin access required' } }],
    ['503', { status: 503, body: { success: false, error: 'fingerprint_unavailable' } }],
    ['network failure', { status: 0, throws: true }],
  ])('%s opens the dialog in its count-unavailable form', async (_name, reply) => {
    const page = loadImpactPage({ replies: { impact: reply } });
    const run = await ask(page, guardOf(page), nextOf({ RAG_TABLE_HEADER_REPEAT: 'always', RAG_PIPELINE: 'v2' }));
    const dialog = page.dialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('The affected documents could not be counted. You can still save');
    expect(dialog!.querySelectorAll('table')).toHaveLength(0);
    expect(buttonByText(dialog, 'Save settings').disabled).toBe(false);
    expect(buttonByText(dialog, 'Keep current settings').disabled).toBe(false);
    buttonByText(dialog, 'Keep current settings').click();
    const result = (await run.promise) as Json;
    expect(result).toMatchObject({ RAG_TABLE_HEADER_REPEAT: 'profile', RAG_PIPELINE: 'legacy' });
  });

  it('while counting, the dialog shows the counting text and Save settings stays disabled until the answer', async () => {
    const page = loadImpactPage({ hold: ['impact'] });
    const run = await ask(page, factoryGuard(page, { openDelayMs: 0 }), nextOf({ RAG_TABLE_HEADER_REPEAT: 'always' }));
    const dialog = page.dialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('Counting affected documents…');
    expect(buttonByText(dialog, 'Save settings').disabled).toBe(true);
    page.release('impact', { status: 200, body: impactAnswer() });
    await flush();
    expect(page.dialog()!.textContent).toContain('All affected documents');
    expect(buttonByText(page.dialog(), 'Save settings').disabled).toBe(false);
    buttonByText(page.dialog(), 'Save settings').click();
    expect(await run.promise).toBe(true);
  });

  it('a count that never arrives turns into the count-unavailable form after the timeout', async () => {
    const page = loadImpactPage({ hold: ['impact'] });
    const run = await ask(page, factoryGuard(page, { openDelayMs: 0, timeoutMs: 40 }), nextOf({ RAG_TABLE_HEADER_REPEAT: 'always' }));
    expect(buttonByText(page.dialog(), 'Save settings').disabled).toBe(true);
    await wait(80);
    await flush();
    expect(page.dialog()!.textContent).toContain('The affected documents could not be counted.');
    expect(buttonByText(page.dialog(), 'Save settings').disabled).toBe(false);
    buttonByText(page.dialog(), 'Save settings').click();
    expect(await run.promise).toBe(true);
  });

  it('a counting dialog closes by itself when the answer says nothing is affected', async () => {
    const page = loadImpactPage({ hold: ['impact'] });
    const run = await ask(page, factoryGuard(page, { openDelayMs: 0 }), nextOf({ RAG_PIPELINE: 'v2' }));
    expect(page.dialog()).not.toBeNull();
    page.release('impact', { status: 200, body: impactAnswer({ ingestion_keys: [], by_mechanism: [] }) });
    expect(await run.promise).toBe(true);
    expect(page.dialog()).toBeNull();
  });

  it('the first language choice saves without a dialog when the count is zero or cannot be made', async () => {
    for (const reply of [
      { status: 503, body: { success: false, error: 'fingerprint_unavailable' } },
      { status: 200, body: impactAnswer({ ingestion_keys: ['RAG_SUPPORTED_LANGUAGES'], by_mechanism: [{ mechanism: 'reparse', doc_type: 'general', affected: 0 }] }) },
    ]) {
      const page = loadImpactPage({ replies: { impact: reply } });
      const saved = { ...SAVED, RAG_SUPPORTED_LANGUAGES: '', RAG_PRIMARY_LANGUAGE: '' };
      const result = await guardOf(page)({ ...saved, RAG_SUPPORTED_LANGUAGES: 'zh,en', RAG_PRIMARY_LANGUAGE: 'en' }, saved);
      expect(result).toBe(true);
      expect(page.dialog()).toBeNull();
    }
  });

  it('a second save while the dialog is open waits for the first decision and does not ask again about an accepted change', async () => {
    const page = loadImpactPage();
    const guard = guardOf(page);
    const next = nextOf({ RAG_TABLE_HEADER_REPEAT: 'always' });
    const first = await ask(page, guard, next);
    const second = guard(next, SAVED);
    await flush();
    expect(page.doc.querySelectorAll('dialog').filter((d) => d.open)).toHaveLength(1);
    buttonByText(page.dialog(), 'Save settings').click();
    expect(await first.promise).toBe(true);
    expect(await second).toBe(true);
    expect(page.calls('impact')).toHaveLength(1);
  });

  it('caller-supplied title, row labels, total label and note replace the defaults', async () => {
    const page = loadImpactPage();
    const guard = guardOf(page);
    const run = guard(nextOf({ RAG_TABLE_HEADER_REPEAT: 'always' }), SAVED, {
      title: 'Synthetic dialog title',
      rowLabels: { rechunk: 'Synthetic row label' },
      totalLabel: 'Synthetic total label',
      note: 'Synthetic caller note.',
    });
    await flush();
    const text = page.dialog()!.textContent;
    expect(text).toContain('Synthetic dialog title');
    expect(text).toContain('Synthetic row label');
    expect(text).toContain('Synthetic total label');
    expect(text).toContain('Synthetic caller note.');
    expect(text).not.toContain('Rebuild chunks');
    buttonByText(page.dialog(), 'Save settings').click();
    await run;
  });

  it('the dialog follows the browser language', async () => {
    const page = loadImpactPage({ locale: 'zh-CN' });
    const run = await ask(page, guardOf(page), nextOf({ RAG_TABLE_HEADER_REPEAT: 'always' }));
    expect(page.dialog()!.textContent).toContain('要保存会影响已入库文档的更改吗？');
    buttonByText(page.dialog(), '保留当前设置').click();
    await run.promise;
  });
});

/** Runs ConfigManager.saveConfig() from index.html against a stub page. */
function loadSaveConfig(globals: Json, config: Json, savedConfig: Json) {
  const start = indexHtml.indexOf('async saveConfig() {');
  expect(start, 'saveConfig in index.html').toBeGreaterThan(-1);
  const source = blockFrom(indexHtml, start);
  const posts: Json[] = [];
  const doc = new FakeDocument();
  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {} },
    setTimeout,
    showToast() {},
    saveRagPrompt: async () => true,
    fetch: async (url: string, init: Json = {}) => {
      if (url === '/api/config' && init.method === 'POST') posts.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => ({}) };
    },
    ...globals,
  };
  context.window = context;
  vm.createContext(context);
  const manager = vm.runInContext(`({ ${source}, showSaveIndicator() {} })`, context) as Json & { saveConfig: () => Promise<void> };
  manager.config = config;
  manager.savedConfig = savedConfig;
  return { manager, posts };
}

describe('saveConfig() in index.html awaits the one guard before posting (UI-SPEC 6.4.1, decision 4)', () => {
  it('calls window.ragIngestImpactGuard before the POST and posts what it returns', async () => {
    const order: string[] = [];
    const { manager, posts } = loadSaveConfig(
      {
        ragIngestImpactGuard: async (next: Json, saved: Json) => {
          order.push('guard');
          expect(next.RAG_TABLE_HEADER_REPEAT).toBe('always');
          expect(saved.RAG_TABLE_HEADER_REPEAT).toBe('profile');
          return { ...next, RAG_TABLE_HEADER_REPEAT: 'profile' };
        },
      },
      { RAG_TABLE_HEADER_REPEAT: 'always', RAG_PIPELINE: 'v2' },
      { RAG_TABLE_HEADER_REPEAT: 'profile', RAG_PIPELINE: 'legacy' },
    );
    await manager.saveConfig();
    expect(order).toEqual(['guard']);
    expect(posts).toEqual([{ config: { RAG_TABLE_HEADER_REPEAT: 'profile', RAG_PIPELINE: 'v2' } }]);
    expect(manager.config).toEqual({ RAG_TABLE_HEADER_REPEAT: 'profile', RAG_PIPELINE: 'v2' });
    expect(manager.savedConfig).toEqual({ RAG_TABLE_HEADER_REPEAT: 'profile', RAG_PIPELINE: 'v2' });
  });

  it('proceeds unchanged when the guard is missing or throws', async () => {
    for (const globals of [{}, { ragIngestImpactGuard: async () => { throw new Error('boom'); } }]) {
      const { manager, posts } = loadSaveConfig(globals, { RAG_PIPELINE: 'v2' }, { RAG_PIPELINE: 'legacy' });
      await manager.saveConfig();
      expect(posts).toEqual([{ config: { RAG_PIPELINE: 'v2' } }]);
    }
  });

  it('the snapshot of the saved config is taken at load', () => {
    const load = blockFrom(indexHtml, indexHtml.indexOf('async loadConfig() {'));
    expect(load).toMatch(/this\.savedConfig\s*=\s*\{\s*\.\.\.this\.config\s*\}/);
  });

  it('the header button and the auto-saves all go through saveConfig, and the guard call precedes its fetch', () => {
    const source = blockFrom(indexHtml, indexHtml.indexOf('async saveConfig() {'));
    expect(source.indexOf('ragIngestImpactGuard')).toBeGreaterThan(-1);
    expect(source.indexOf('ragIngestImpactGuard')).toBeLessThan(source.indexOf("fetch('/api/config'"));
    const wholeConfigPosts = [...indexHtml.matchAll(/JSON\.stringify\(\{\s*config:\s*this\.config\s*\}\)/g)].map((m) => m.index!);
    const saveStart = indexHtml.indexOf('async saveConfig() {');
    expect(wholeConfigPosts.every((at) => at > saveStart && at < saveStart + source.length)).toBe(true);
  });
});

describe('Ingestion changes section, script tag and Settings sub-view (UI-SPEC 6.1, 6.3)', () => {
  it('index.html has the section after Ingestion and the script tag after languages.js', () => {
    expect(indexHtml).toContain('id="rag-administration-ingest-impact"');
    const ingestion = indexHtml.indexOf('id="rag-administration-ingestion"');
    const impact = indexHtml.indexOf('id="rag-administration-ingest-impact"');
    const quarantine = indexHtml.indexOf('id="rag-administration-quarantine"');
    expect(impact).toBeGreaterThan(ingestion);
    expect(impact).toBeLessThan(quarantine);
    const languagesTag = indexHtml.indexOf('<script src="rag-panels/languages.js"></script>');
    const impactTag = indexHtml.indexOf('<script src="rag-panels/ingest-impact.js"></script>');
    expect(impactTag).toBeGreaterThan(languagesTag);
    expect(indexHtml.indexOf('<script src="rag-panels/rag-ui.js"></script>')).toBeLessThan(impactTag);
  });

  it('mounting moves the ingest settings group into the Settings sub-view', async () => {
    const page = loadImpactPage();
    await initPanel(page);
    await flush();
    const group = page.doc.querySelector('[data-rag-settings-group="ingest"]')!;
    expect(page.root!.contains(group)).toBe(true);
    const settingsTab = page.root!.querySelectorAll('[role="tab"]').find((t) => t.textContent === 'Settings')!;
    expect(settingsTab).toBeTruthy();
    const panel = page.doc.getElementById(settingsTab.getAttribute('aria-controls')!)!;
    expect(panel.contains(group)).toBe(true);
    for (const id of ['RAG_LANGUAGE_AWARE_INGEST', 'RAG_TABLE_HEADER_REPEAT', 'RAG_TABLE_ROW_SERIALIZATION', 'RAG_CAPTION_LANGUAGE']) {
      expect(group.contains(page.input(id)), id).toBe(true);
    }
  });

  it('computes the combination warnings of UI-SPEC 6.3 on change', async () => {
    const page = loadImpactPage();
    await initPanel(page);
    await flush();
    const aware = page.input('RAG_LANGUAGE_AWARE_INGEST');
    page.input('RAG_SUPPORTED_LANGUAGES').value = '';
    page.pipeline.value = 'legacy';
    aware.value = 'on';
    aware.dispatch('change');
    const warnings = () => page.root!.querySelectorAll('.alert-warning').map((a) => a.textContent).join('\n');
    expect(warnings()).toContain('This setting has no effect until the supported languages are chosen in the Languages panel.');
    expect(warnings()).toContain('This setting works in the unified ingest pipeline only.');
    page.input('RAG_SUPPORTED_LANGUAGES').value = 'zh,en';
    page.pipeline.value = 'unified';
    page.pipeline.dispatch('change');
    aware.dispatch('change');
    expect(warnings()).toBe('');
    const caption = page.input('RAG_CAPTION_LANGUAGE');
    aware.value = 'off';
    caption.value = 'document';
    page.input('RAG_SUPPORTED_LANGUAGES').value = '';
    caption.dispatch('change');
    expect(warnings()).toContain('supported languages are chosen');
    expect(warnings()).not.toContain('unified ingest pipeline');
  });

  it('Settings labels follow the browser language through data-rag-i18n', async () => {
    const page = loadImpactPage({ locale: 'it-IT' });
    await initPanel(page);
    await flush();
    const group = page.doc.querySelector('[data-rag-settings-group="ingest"]')!;
    expect(group.textContent).toContain('Ripetizione dell’intestazione delle tabelle');
    expect(group.textContent).toContain('La modifica riguarda i documenti già archiviati; al salvataggio vedrai quanti.');
    expect(maybeButton(page.root, 'Impostazioni') ?? page.root!.querySelectorAll('[role="tab"]').find((t) => t.textContent === 'Impostazioni')).toBeTruthy();
  });
});
