import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { blockFrom, FakeDocument } from './helpers/html-fake-dom';
import {
  buttonByText,
  coverageAnswer,
  everything,
  flush,
  impactAnswer,
  pendingRow,
  runRow,
  indexHtml,
  loadImpactPage,
  maybeButton,
  wait,
  type Json,
  type ImpactPage,
  type Reply,
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

async function mountPanel(page: ImpactPage, options: Json = {}): Promise<void> {
  const init = page.context.initIngestImpactPanel;
  expect(typeof init, 'initIngestImpactPanel').toBe('function');
  await (init as (o: Json) => Promise<void>)(options);
  await flush();
}

function rebuildsTable(page: ImpactPage) {
  return page.root!.querySelectorAll('table').find((t) => t.getAttribute('data-ingest-impact-table') === 'rebuilds') ?? null;
}

function pendingTable(page: ImpactPage) {
  return page.root!.querySelectorAll('table').find((t) => t.getAttribute('data-ingest-impact-table') === 'pending') ?? null;
}

function rowsOf(table: ReturnType<typeof rebuildsTable>) {
  return table ? table.querySelectorAll('tbody tr') : [];
}

function coverageWith(extra: Json): Reply {
  return { status: 200, body: coverageAnswer(extra) };
}

describe('Rebuilds view: documents on previous settings (UI-SPEC 6.4.2, finding 5)', () => {
  it('lists each pending mechanism with Start rebuild, the command with Copy command, or the needs-async sentence', async () => {
    const page = loadImpactPage({
      replies: {
        coverage: coverageWith({
          pending: [
            pendingRow('reparse', 7, 'needs_async'),
            pendingRow('rechunk', 253, 'ui'),
            pendingRow('relex', 12, 'cli', 'npm run rag:relex'),
            pendingRow('reembed', 0, 'cli'),
          ],
        }),
      },
    });
    await mountPanel(page);
    const rows = rowsOf(pendingTable(page));
    expect(rows).toHaveLength(3);
    const byLabel = (label: string) => rows.find((r) => r.querySelector('th')!.textContent === label)!;
    const rechunk = byLabel('Rebuild chunks');
    expect(rechunk.textContent).toContain('253');
    const start = buttonByText(rechunk, 'Start rebuild');
    expect(start.className).toContain('btn-primary');
    expect(start.getAttribute('aria-label')).toBe('Start rebuild: Rebuild chunks');
    const relex = byLabel('Rebuild word index');
    expect(relex.querySelector('code')!.textContent).toBe('npm run rag:relex');
    expect(maybeButton(relex, 'Start rebuild')).toBeUndefined();
    buttonByText(relex, 'Copy command').click();
    await flush();
    expect(page.clipboardWrites).toEqual(['npm run rag:relex']);
    expect(page.status().textContent).toContain('Command copied.');
    const reparse = byLabel('Parse again');
    expect(reparse.textContent).toContain('Parsing again runs through the async ingest queue, which is off.');
    expect(reparse.querySelector('code')!.textContent).toBe('npm run rag:rebuild -- start --mechanism reparse');
    expect(maybeButton(reparse, 'Start rebuild')).toBeUndefined();
    expect(page.root!.textContent).not.toContain('Rebuild embeddings');
  });

  it('renders no Copy command button when the clipboard API is missing', async () => {
    const page = loadImpactPage({ clipboard: false, replies: { coverage: coverageWith({ pending: [pendingRow('relex', 3, 'cli', 'npm run rag:relex')] }) } });
    await mountPanel(page);
    expect(maybeButton(page.root, 'Copy command')).toBeUndefined();
    expect(page.root!.querySelector('code')!.textContent).toBe('npm run rag:relex');
  });

  it('Start rebuild posts the mechanism only, shows its in-flight text, then announces and reloads', async () => {
    const page = loadImpactPage({ hold: ['start'], replies: { coverage: coverageWith({ pending: [pendingRow('rechunk', 253, 'ui')] }) } });
    await mountPanel(page);
    const start = buttonByText(pendingTable(page), 'Start rebuild');
    start.click();
    await flush();
    expect(page.calls('start')[0]!.body).toEqual({ mechanism: 'rechunk' });
    expect(start.disabled).toBe(true);
    expect(start.textContent).toContain('Starting…');
    page.release('start', { status: 200, body: { success: true, mechanism: 'rechunk', affected: 253, status: 'started', run: runRow({ mechanism: 'rechunk' }) } });
    await flush();
    expect(page.status().textContent).toContain('Rebuild started: Rebuild chunks.');
    expect(page.calls('coverage')).toHaveLength(2);
  });

  it('documents without a fingerprint show the coverage line with the backfill command', async () => {
    const page = loadImpactPage({ replies: { coverage: coverageWith({ without_fingerprint: { count: 31, command: 'npm run rag:fingerprint -- backfill' } }) } });
    await mountPanel(page);
    expect(page.root!.textContent).toContain('Stored documents without a fingerprint: 31.');
    expect(page.root!.querySelectorAll('code').map((c) => c.textContent)).toContain('npm run rag:fingerprint -- backfill');
  });
});

describe('Rebuilds view: rebuild rows, activation and rollback (UI-SPEC 6.4.2, D-12, finding 6)', () => {
  it('nothing pending and no rebuild shows the empty title and body', async () => {
    const page = loadImpactPage();
    await mountPanel(page);
    expect(page.root!.textContent).toContain('No documents to rebuild');
    expect(page.root!.textContent).toContain('Every stored document matches the saved ingestion settings.');
    expect(pendingTable(page)).toBeNull();
  });

  it('pending documents without any rebuild show the no-rebuild sentence', async () => {
    const page = loadImpactPage({ replies: { coverage: coverageWith({ pending: [pendingRow('rechunk', 5, 'ui')] }) } });
    await mountPanel(page);
    expect(page.root!.textContent).toContain('No rebuild has been started.');
    expect(page.root!.textContent).not.toContain('No documents to rebuild');
  });

  it('a running rebuild shows the badge with word and icon, a native progress element and its progress text', async () => {
    const page = loadImpactPage({ replies: { coverage: coverageWith({ rebuilds: [runRow()] }) } });
    await mountPanel(page);
    const row = rowsOf(rebuildsTable(page))[0]!;
    const badge = row.querySelector('.badge')!;
    expect(badge.textContent).toContain('Running');
    expect(badge.querySelector('i.bi-arrow-repeat')).not.toBeNull();
    const progress = row.querySelector('progress')!;
    expect(progress.getAttribute('value')).toBe('120');
    expect(progress.getAttribute('max')).toBe('310');
    expect(row.textContent).toContain('120 of 310');
    const time = row.querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe('2026-11-20T09:30:00.000Z');
    expect(maybeButton(row, 'Activate rebuild')).toBeUndefined();
  });

  it('Activate and Roll back appear only for a held reparse batch; rechunk and reembed point to their panels', async () => {
    const page = loadImpactPage({
      replies: {
        coverage: coverageWith({
          rebuilds: [
            runRow({ id: 'run-built', state: 'built', done: 310, started: '2026-11-21T09:00:00.000Z' }),
            runRow({ id: 'run-active', state: 'active', done: 310, started: '2026-11-19T09:00:00.000Z' }),
            runRow({ id: 'run-rechunk', mechanism: 'rechunk', state: 'built', done: 253, total: 253, activation: 'chunking_profiles', started: '2026-11-18T09:00:00.000Z' }),
            runRow({ id: 'run-reembed', mechanism: 'reembed', state: 'built', done: 9, total: 9, activation: 'embedding_profiles', started: '2026-11-17T09:00:00.000Z' }),
            runRow({ id: 'run-relex', mechanism: 'relex', state: 'completed', done: 4, total: 4, activation: 'none', started: '2026-11-16T09:00:00.000Z' }),
          ],
        }),
      },
    });
    await mountPanel(page);
    const rows = rowsOf(rebuildsTable(page));
    const built = rows.find((r) => r.textContent.includes('Built, not active') && r.textContent.includes('Parse again'))!;
    expect(buttonByText(built, 'Activate rebuild').className).toContain('btn-primary');
    const active = rows.find((r) => r.textContent.includes('Active') && r.textContent.includes('Parse again') && !r.textContent.includes('not active'))!;
    expect(buttonByText(active, 'Roll back rebuild').className).toContain('btn-outline');
    const rechunk = rows.find((r) => r.textContent.includes('Rebuild chunks'))!;
    expect(maybeButton(rechunk, 'Activate rebuild')).toBeUndefined();
    expect(maybeButton(rechunk, 'Roll back rebuild')).toBeUndefined();
    buttonByText(rechunk, 'Open chunking profiles').click();
    expect(page.doc.activeElement).toBe(page.doc.getElementById('rag-chunking-title'));
    const reembed = rows.find((r) => r.textContent.includes('Rebuild embeddings'))!;
    buttonByText(reembed, 'Open embedding profiles').click();
    expect(page.doc.activeElement).toBe(page.doc.getElementById('rag-profiles-title'));
    const relex = rows.find((r) => r.textContent.includes('Rebuild word index'))!;
    expect(relex.textContent).toContain('Completed');
    expect(relex.querySelectorAll('button')).toHaveLength(0);
  });

  it('Activate asks for confirmation with focus on Keep current versions, then posts, announces and reloads', async () => {
    const page = loadImpactPage({ replies: { coverage: coverageWith({ rebuilds: [runRow({ id: 'run-built', state: 'built', done: 310 })] }) } });
    await mountPanel(page);
    buttonByText(rowsOf(rebuildsTable(page))[0]!, 'Activate rebuild').click();
    await flush();
    const dialog = page.dialog()!;
    expect(dialog.textContent).toContain('Activate this rebuild?');
    expect(dialog.textContent).toContain('Documents in this rebuild: 310.');
    expect(page.doc.activeElement).toBe(buttonByText(dialog, 'Keep current versions'));
    expect(page.calls('activate')).toHaveLength(0);
    buttonByText(dialog, 'Activate rebuild').click();
    await flush();
    expect(page.calls('activate')[0]!.path).toBe('/api/rag/admin/ingest-fingerprint/rebuild/run-built/activate');
    expect(page.status().textContent).toContain('Rebuild activated.');
    expect(page.calls('coverage')).toHaveLength(2);
  });

  it('Keep current versions sends nothing', async () => {
    const page = loadImpactPage({ replies: { coverage: coverageWith({ rebuilds: [runRow({ state: 'built', done: 310 })] }) } });
    await mountPanel(page);
    buttonByText(rowsOf(rebuildsTable(page))[0]!, 'Activate rebuild').click();
    await flush();
    buttonByText(page.dialog(), 'Keep current versions').click();
    await flush();
    expect(page.calls('activate')).toHaveLength(0);
  });

  it.each([
    ['eval_missing', 'Not activated. No evaluation result is recorded for this rebuild.'],
    ['eval_failed', 'Not activated. The evaluation of this rebuild shows a slice dropping beyond the noise band.'],
    ['incomplete', 'Not activated. Some documents are not rebuilt yet.'],
  ])('a refused activation (409 %s) shows the gate sentence in a role=alert block and reloads', async (reason, sentence) => {
    const page = loadImpactPage({
      replies: {
        coverage: coverageWith({ rebuilds: [runRow({ state: 'built', done: 310 })] }),
        activate: { status: 409, body: { success: false, error: 'activation_refused', reason } },
      },
    });
    await mountPanel(page);
    buttonByText(rowsOf(rebuildsTable(page))[0]!, 'Activate rebuild').click();
    await flush();
    buttonByText(page.dialog(), 'Activate rebuild').click();
    await flush();
    expect(page.dialog()).toBeNull();
    const alert = page.root!.querySelector('[data-ingest-impact-alert]')!.querySelector('[role="alert"]')!;
    expect(alert).not.toBeNull();
    expect(alert.className).toContain('alert-warning');
    expect(alert.textContent).toContain(sentence);
    expect(page.calls('coverage')).toHaveLength(2);
  });

  it('an unknown refusal reason is shown as its code inside the gate.other sentence', async () => {
    const page = loadImpactPage({
      replies: {
        coverage: coverageWith({ rebuilds: [runRow({ state: 'active', done: 310 })] }),
        rollback: { status: 409, body: { success: false, error: 'rollback_refused', reason: 'not_active' } },
      },
    });
    await mountPanel(page);
    buttonByText(rowsOf(rebuildsTable(page))[0]!, 'Roll back rebuild').click();
    await flush();
    expect(page.dialog()!.textContent).toContain('Roll back this rebuild?');
    buttonByText(page.dialog(), 'Roll back rebuild').click();
    await flush();
    const alert = page.root!.querySelector('[data-ingest-impact-alert]')!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Not changed. The server gave the reason not_active.');
    expect(alert.querySelector('code')!.textContent).toBe('not_active');
  });

  it('a successful rollback announces it', async () => {
    const page = loadImpactPage({ replies: { coverage: coverageWith({ rebuilds: [runRow({ state: 'active', done: 310 })] }) } });
    await mountPanel(page);
    buttonByText(rowsOf(rebuildsTable(page))[0]!, 'Roll back rebuild').click();
    await flush();
    buttonByText(page.dialog(), 'Roll back rebuild').click();
    await flush();
    expect(page.status().textContent).toContain('Rebuild rolled back.');
  });

  it('a rebuild with gaps shows the Incomplete badge, the gaps line and Start rebuild again for the rest', async () => {
    const page = loadImpactPage({
      replies: {
        coverage: coverageWith({
          pending: [pendingRow('rechunk', 4, 'ui')],
          rebuilds: [runRow({ mechanism: 'rechunk', state: 'incomplete', done: 249, total: 253, gaps: 4, activation: 'chunking_profiles' })],
        }),
      },
    });
    await mountPanel(page);
    const row = rowsOf(rebuildsTable(page))[0]!;
    expect(row.querySelector('.badge')!.textContent).toContain('Incomplete');
    expect(row.querySelector('.badge')!.className).toContain('badge-warning');
    expect(row.textContent).toContain('Documents that could not be rebuilt: 4');
    expect(buttonByText(pendingTable(page), 'Start rebuild')).toBeTruthy();
  });

  it('rows are ordered running, incomplete, built, active, then by start time, and page by 20 with Load more rebuilds', async () => {
    const many = Array.from({ length: 23 }, (_, i) =>
      runRow({ id: `run-${i}`, mechanism: 'relex', state: 'completed', activation: 'none', done: 1, total: 1, started: `2026-10-${String(i + 1).padStart(2, '0')}T08:00:00.000Z` }),
    );
    const page = loadImpactPage({
      replies: {
        coverage: coverageWith({
          rebuilds: [
            ...many,
            runRow({ id: 'a', state: 'active', done: 310 }),
            runRow({ id: 'b', state: 'built', done: 310 }),
            runRow({ id: 'c', mechanism: 'rechunk', state: 'incomplete', gaps: 2, activation: 'chunking_profiles' }),
            runRow({ id: 'd', state: 'running' }),
          ],
        }),
      },
    });
    await mountPanel(page);
    let rows = rowsOf(rebuildsTable(page));
    expect(rows).toHaveLength(20);
    expect(rows.slice(0, 4).map((r) => r.querySelector('.badge')!.textContent)).toEqual(['Running', 'Incomplete', 'Built, not active', 'Active']);
    expect(rows[4]!.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-23T08:00:00.000Z');
    buttonByText(page.root, 'Load more rebuilds').click();
    await flush();
    rows = rowsOf(rebuildsTable(page));
    expect(rows).toHaveLength(27);
    expect(maybeButton(page.root, 'Load more rebuilds')).toBeUndefined();
  });

  it('never renders batch ids, run ids or fingerprint values', async () => {
    const fingerprint = 'f'.repeat(64);
    const page = loadImpactPage({
      replies: {
        coverage: coverageWith({
          fingerprint,
          pending: [{ ...pendingRow('rechunk', 4, 'ui'), fingerprint, batch_id: 'batch-0000-secret' }],
          rebuilds: [{ ...runRow({ state: 'built', done: 310 }), batch_id: 'batch-0000-secret', fingerprint }],
        }),
      },
    });
    await mountPanel(page);
    const all = everything(page.root!);
    expect(all).not.toContain('7d1c2a3b-0000-4000-8000-00000000abcd');
    expect(all).not.toContain('batch-0000-secret');
    expect(all).not.toContain(fingerprint);
  });

  it('401 replaces the Rebuilds view with the sign-in alert and keeps Settings usable; 503 shows the unavailable alert', async () => {
    const signIn = loadImpactPage({ replies: { coverage: { status: 401, body: { error: 'Unauthorized' } } } });
    await mountPanel(signIn);
    expect(signIn.root!.textContent).toContain('Reload panel');
    expect(signIn.root!.querySelector('.alert-warning i.bi-person-lock')).not.toBeNull();
    expect(signIn.root!.contains(signIn.input('RAG_TABLE_HEADER_REPEAT'))).toBe(true);
    const down = loadImpactPage({ replies: { coverage: { status: 503, body: { success: false, error: 'fingerprint_unavailable' } } } });
    await mountPanel(down);
    expect(down.root!.textContent).toContain('Ingestion changes are unavailable right now. Select Reload panel in a moment.');
    buttonByText(down.root, 'Reload panel').click();
    await flush();
    expect(down.calls('coverage')).toHaveLength(2);
  });
});

describe('Rebuilds view: polling while a rebuild runs (UI-SPEC 6.4.2 Refresh, decision 7)', () => {
  it('refreshes while a rebuild runs and the tab is visible, and announces the end state', async () => {
    let n = 0;
    const page = loadImpactPage({
      replies: {
        coverage: () => {
          n += 1;
          return coverageWith({ rebuilds: [n < 3 ? runRow({ done: 100 + n }) : runRow({ state: 'built', done: 310 })] });
        },
      },
    });
    await mountPanel(page, { pollMs: 20, announceMs: 1000 });
    await wait(120);
    await flush();
    expect(page.calls('coverage').length).toBe(3);
    expect(page.status().textContent).toContain('Built, not active');
    await wait(60);
    expect(page.calls('coverage').length).toBe(3);
  });

  it('does not poll without a running rebuild, while the tab is inactive or while the document is hidden', async () => {
    for (const options of [
      { replies: { coverage: coverageWith({ rebuilds: [runRow({ state: 'built', done: 310 })] }) } },
      { activeTab: false, replies: { coverage: coverageWith({ rebuilds: [runRow()] }) } },
      { visibility: 'hidden' as const, replies: { coverage: coverageWith({ rebuilds: [runRow()] }) } },
    ]) {
      const page = loadImpactPage(options);
      await mountPanel(page, { pollMs: 20 });
      await wait(80);
      expect(page.calls('coverage')).toHaveLength(1);
    }
  });

  it('announces progress at most once per announce interval', async () => {
    let n = 0;
    const page = loadImpactPage({ replies: { coverage: () => coverageWith({ rebuilds: [runRow({ done: 100 + (n += 1) })] }) } });
    await mountPanel(page, { pollMs: 15, announceMs: 10_000 });
    const first = page.status().textContent;
    expect(first).toContain('Parse again');
    await wait(80);
    expect(page.calls('coverage').length).toBeGreaterThan(2);
    expect(page.status().textContent).toBe(first);
    (page.context.ingestImpactPanel as { stopPolling: () => void }).stopPolling();
  });
});
