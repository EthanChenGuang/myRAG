import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeElement } from './helpers/html-fake-dom';
import { buttonByText, flush, languagesAnswer, loadLanguagesPage, pack, rowFor, toggle, useBox, type Json, type Reply } from './helpers/languages-harness';

// LANG-11 (plan 07-52, 07-UI-SPEC 6.5, 7.5, 12.5): the Languages panel's addition and removal states.

const require = createRequire(import.meta.url);
const { LANGUAGES_LABELS } = require('../../scripts/config-ui/rag-panels/languages.js') as { LANGUAGES_LABELS: Record<string, Record<string, string>> };

const configuredAnswer = (packs?: Json[]) =>
  languagesAnswer({
    configured: true,
    languages: ['zh', 'en'],
    primary: 'zh',
    variablesSet: { RAG_SUPPORTED_LANGUAGES: true, RAG_PRIMARY_LANGUAGE: true },
    ...(packs ? { packs } : {}),
  });

async function mounted(options: Parameters<typeof loadLanguagesPage>[0]) {
  const page = loadLanguagesPage(options);
  page.doc.dispatch('DOMContentLoaded');
  await flush();
  (page.context.initLanguagesPanel as () => void)();
  await flush();
  return page;
}

function savedPost(extra: Json) {
  return (body: unknown): Reply => {
    const request = body as Json;
    return { status: 200, body: { success: true, languages: request.languages, primary: request.primary, warnings: [], verifiedAgainstActiveProfile: true, ...extra, ...(request.preview ? { preview: true } : {}) } };
  };
}

const writes = (page: ReturnType<typeof loadLanguagesPage>) => page.calls.filter((c) => c.init.method === 'POST' && (c.body as Json).preview !== true);

describe('Languages panel: adding a language (07-UI-SPEC 6.5)', () => {
  it('baseline blocked: a baselineMissing row has a disabled checkbox and blocked.baseline with the command', async () => {
    const guardCalls: unknown[] = [];
    const page = await mounted({
      get: { status: 200, body: configuredAnswer([pack('zh', '中文', 'Chinese'), pack('en', 'English', 'English'), pack('it', 'Italiano', 'Italian', { baselineMissing: true })]) },
      globals: { ragIngestImpactGuard: async (...args: unknown[]) => (guardCalls.push(args), true) },
    });
    const box = useBox(page.content, 'it');
    expect(box.disabled).toBe(true);
    const row = rowFor(page.content, 'it');
    expect(row.textContent).toContain('No baseline is recorded for this language. Record it with');
    const code = row.querySelectorAll('code').find((el) => el.textContent === 'npm run rag:languages -- baseline it') as FakeElement | undefined;
    expect(code).toBeTruthy();
    expect(code!.className).toContain('font-mono');
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
    expect(useBox(page.content, 'zh').disabled).toBe(false);
    expect(guardCalls).toEqual([]);
  });

  it('dialog labels: an accepted addition hands the dialog the title, the three labelled groups, the total label and the note', async () => {
    const guardCalls: Array<[Json, Json, Json]> = [];
    const selection = { groups: { und: 1, scanned: 2, stale: 3 }, total: 6 };
    const page = await mounted({
      get: { status: 200, body: configuredAnswer() },
      post: savedPost({ added: ['it'], removed: [], selection, rebuild: { selection: 'language_add', mechanism: 'reparse' } }),
      globals: { ragIngestImpactGuard: async (next: Json, saved: Json, options: Json) => (guardCalls.push([next, saved, options]), true) },
    });
    toggle(useBox(page.content, 'it'), true);
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(page.calls.filter((c) => c.init.method === 'POST')[0]!.body).toEqual({ languages: ['zh', 'en', 'it'], primary: 'zh', preview: true });
    expect(guardCalls).toHaveLength(1);
    const options = guardCalls[0]![2];
    const en = LANGUAGES_LABELS.en!;
    expect(options.title).toBe('Add Italiano?');
    expect(options.totalLabel).toBe(en['add.total']);
    expect(options.note).toBe(en['add.note']);
    expect(options.groups).toEqual([
      { group: 'und', label: en['add.group.und'], count: 1 },
      { group: 'scanned', label: en['add.group.scanned'], count: 2 },
      { group: 'stale', label: en['add.group.stale'], count: 3 },
    ]);
    expect(options.rowLabels).toEqual({ und: en['add.group.und'], scanned: en['add.group.scanned'], stale: en['add.group.stale'] });
    expect(writes(page)).toHaveLength(1);
    expect(page.status.textContent).toBe('Italiano added. Documents to reprocess: 6. Start the rebuild under RAG administration, Ingestion changes.');
    const info = page.content.querySelectorAll('.alert-info');
    expect(info.some((el) => el.textContent.includes('Italiano added.'))).toBe(true);
  });

  it('dialog labels: with a total of 0 no dialog opens and save.addedNone is announced', async () => {
    let asked = 0;
    const page = await mounted({
      get: { status: 200, body: configuredAnswer() },
      post: savedPost({ added: ['it'], removed: [], selection: { groups: { und: 0, scanned: 0, stale: 0 }, total: 0 }, rebuild: { selection: 'language_add', mechanism: 'reparse' } }),
      globals: { ragIngestImpactGuard: async () => ((asked += 1), true) },
    });
    toggle(useBox(page.content, 'it'), true);
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(asked).toBe(0);
    expect(writes(page)).toHaveLength(1);
    expect(page.status.textContent).toBe('Italiano added. No stored document needs reprocessing.');
  });

  it('a 400 language_baseline_missing renders one sentence with the command and saves nothing', async () => {
    let asked = 0;
    const page = await mounted({
      get: { status: 200, body: configuredAnswer() },
      post: { status: 400, body: { success: false, error: 'Invalid language settings', details: [{ code: 'language_baseline_missing', language: 'it', command: 'npm run rag:languages -- baseline it' }] } },
      globals: { ragIngestImpactGuard: async () => ((asked += 1), true) },
    });
    toggle(useBox(page.content, 'it'), true);
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(asked).toBe(0);
    expect(writes(page)).toHaveLength(0);
    const alert = page.content.querySelectorAll('.alert-error')[0] as FakeElement;
    expect(alert.textContent).toBe('Not saved. No baseline is recorded for Italiano. Record it with npm run rag:languages -- baseline it, then save again.');
    expect(alert.querySelectorAll('code')[0]!.className).toContain('font-mono');
    expect(page.status.textContent).toBe(alert.textContent);
    expect(useBox(page.content, 'it').checked).toBe(true);
  });

  it('UI review 07 M-4: a 400 without details[] falls back to code.unknown, never a dangling colon', async () => {
    const page = await mounted({
      get: { status: 200, body: configuredAnswer() },
      post: { status: 400, body: { errors: [{ field: 'languages' }] } },
      globals: { ragIngestImpactGuard: async () => true },
    });
    toggle(useBox(page.content, 'it'), true);
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(page.status.textContent).toBe('The server reported 400.');
    expect(page.status.textContent).not.toContain('not accepted:');
  });

  it('a removal only opens no dialog, shows note.removed while unsaved and save.removed after the save', async () => {
    let asked = 0;
    const page = await mounted({
      get: { status: 200, body: configuredAnswer() },
      post: savedPost({ added: [], removed: ['en'], notes: [{ code: 'removed_documents_stay_searchable', language: 'en' }], rebuild: null }),
      globals: { ragIngestImpactGuard: async () => ((asked += 1), true) },
    });
    toggle(useBox(page.content, 'en'), false);
    expect(page.content.textContent).toContain('Documents in English stay searchable. Detection and translation stop for this language.');
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(asked).toBe(0);
    expect(page.calls.filter((c) => c.init.method === 'POST')).toHaveLength(1);
    expect(page.status.textContent).toBe('English removed from the supported languages. Its documents stay searchable; nothing was deleted or rebuilt.');
    expect(page.content.querySelectorAll('.alert-info').some((el) => el.textContent.includes('English removed'))).toBe(true);
  });

  it('the new copy exists in en, zh and it and never promises a deletion', () => {
    const keys = ['error.language_baseline_missing', 'blocked.baseline', 'add.title', 'add.col.group', 'add.col.count', 'add.group.und', 'add.group.scanned', 'add.group.stale', 'add.total', 'add.note', 'save.added', 'save.addedNone', 'save.removed'];
    for (const locale of ['en', 'zh', 'it']) for (const key of keys) expect(LANGUAGES_LABELS[locale]![key], `${locale} ${key}`).toBeTruthy();
    expect(LANGUAGES_LABELS.zh!['error.language_baseline_missing']).toContain('{command}');
    expect(Object.values(LANGUAGES_LABELS.en!).join(' ')).not.toMatch(/remove documents/i);
  });
});

describe('the quarantine allowlist guard keeps the caller options (plan 07-52 fix)', () => {
  it('forwards the dialog options to the inner impact guard', async () => {
    const { quarantineCreateGuard } = require('../../scripts/config-ui/rag-panels/quarantine.js') as {
      quarantineCreateGuard: (inner: (...args: unknown[]) => unknown) => (next: Json, saved: Json, options?: Json) => Promise<unknown>;
    };
    const seen: unknown[][] = [];
    const guard = quarantineCreateGuard(async (...args: unknown[]) => (seen.push(args), true));
    const options = { title: 'Add Italiano?', totalLabel: 'Documents to reprocess' };
    await guard({ RAG_SUPPORTED_LANGUAGES: 'zh,en,it' }, { RAG_SUPPORTED_LANGUAGES: 'zh,en' }, options);
    expect(seen[0]![2]).toEqual(options);
  });
});
