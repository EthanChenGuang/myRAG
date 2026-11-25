import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeElement, XSS_PAYLOAD, injectedElements } from './helpers/html-fake-dom';
import {
  buttonByText,
  flush,
  languagesAnswer,
  loadLanguagesPage,
  pack,
  primaryRadio,
  rowFor,
  toggle,
  useBox,
  type Json,
} from './helpers/languages-harness';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const html = fs.readFileSync(path.join(repoRoot, 'scripts/config-ui/index.html'), 'utf8');
const languagesSource = fs.readFileSync(path.join(repoRoot, 'scripts/config-ui/rag-panels/languages.js'), 'utf8');

type Locale = 'en' | 'zh' | 'it';

interface RowView {
  code: string;
  nativeName: string;
  uiName: string | null;
  selectable: boolean;
  blocked: Array<{ key: string; vars: Record<string, string> }>;
  count: number | null;
}

function loadModule() {
  return require('../../scripts/config-ui/rag-panels/languages.js') as {
    LANGUAGES_LABELS: Record<Locale, Record<string, string>>;
    languagesLabel: (key: string, locale: Locale, vars?: Record<string, unknown>) => string;
    languagesBuildView: (answer: Json, options: { locale: Locale; counts?: Array<{ language: string; documents: number }> | null }) => {
      configured: boolean;
      firstRun: boolean;
      rows: RowView[];
      banner: { form: 'notice' | 'blocking'; variable: string | null } | null;
      saved: { languages: string[]; primary: string | null };
      verified: boolean;
      countsAvailable: boolean;
    };
    languagesBannerForm: (answer: Json) => { form: 'notice' | 'blocking'; variable: string | null } | null;
    languagesSaveBody: (rows: RowView[], checked: string[], primary: string | null) => { languages: string[]; primary: string | null };
  };
}

async function mounted(options: Parameters<typeof loadLanguagesPage>[0] = {}) {
  const page = loadLanguagesPage(options);
  page.doc.dispatch('DOMContentLoaded');
  await flush();
  (page.context.initLanguagesPanel as () => void)();
  await flush();
  return page;
}

describe('languagesBuildView turns the config-server answer into rows (UI-SPEC 6.2.2)', () => {
  it('keeps registry order with native name, UI-language name (omitted when equal), code and blocking reasons', () => {
    const { languagesBuildView } = loadModule();
    const answer = languagesAnswer({
      packs: [
        pack('zh', '中文', 'Chinese'),
        pack('en', 'English', 'English'),
        pack('it', 'Italiano', 'Italian', {
          selectable: false,
          reasons: [
            { code: 'embedding_profile_unsupported', id: 'profile-default' },
            { code: 'reranker_unsupported', id: 'local_bm25' },
          ],
        }),
      ],
    });
    const view = languagesBuildView(answer, { locale: 'en', counts: null });
    expect(view.rows.map((r) => r.code)).toEqual(['zh', 'en', 'it']);
    expect(view.rows[0]).toMatchObject({ nativeName: '中文', uiName: 'Chinese', selectable: true, blocked: [] });
    expect(view.rows[1]!.uiName).toBeNull();
    expect(view.rows[2]!.selectable).toBe(false);
    expect(view.rows[2]!.blocked).toEqual([
      { key: 'blocked.embedding', vars: { profile: 'profile-default' } },
      { key: 'blocked.reranker', vars: { reranker: 'local_bm25' } },
    ]);
    expect(view.countsAvailable).toBe(false);
    expect(view.rows.every((r) => r.count === null)).toBe(true);
  });

  it('omits the UI-language name when the UI speaks the language itself', () => {
    const { languagesBuildView } = loadModule();
    const view = languagesBuildView(languagesAnswer(), { locale: 'zh', counts: null });
    expect(view.rows[0]!.uiName).toBeNull();
    expect(view.rows[1]!.uiName).toBeTruthy();
  });

  it('reads counts by language and the saved values', () => {
    const { languagesBuildView } = loadModule();
    const view = languagesBuildView(languagesAnswer({ configured: true, languages: ['zh', 'en'], primary: 'en' }), {
      locale: 'en',
      counts: [{ language: 'zh', documents: 132 }, { language: 'en', documents: 48 }],
    });
    expect(view.rows.map((r) => r.count)).toEqual([132, 48, 0]);
    expect(view.countsAvailable).toBe(true);
    expect(view.saved).toEqual({ languages: ['zh', 'en'], primary: 'en' });
    expect(view.configured).toBe(true);
    expect(view.firstRun).toBe(false);
  });

  it('writes the save body in registry order', () => {
    const { languagesBuildView, languagesSaveBody } = loadModule();
    const view = languagesBuildView(languagesAnswer(), { locale: 'en', counts: null });
    expect(languagesSaveBody(view.rows, ['it', 'zh'], 'it')).toEqual({ languages: ['zh', 'it'], primary: 'it' });
  });
});

describe('page banner form (UI-SPEC 6.2.1, D-02)', () => {
  it('notice when both variables are unset and no pipeline variable is explicit', () => {
    const { languagesBannerForm } = loadModule();
    expect(languagesBannerForm(languagesAnswer())).toEqual({ form: 'notice', variable: null });
  });

  it('blocking form naming RAG_PIPELINE or RAG_INGEST_PIPELINE when set explicitly', () => {
    const { languagesBannerForm } = loadModule();
    expect(
      languagesBannerForm(
        languagesAnswer({ pipelines: { RAG_PIPELINE: { value: 'v2', explicit: true }, RAG_INGEST_PIPELINE: { value: null, explicit: false } } }),
      ),
    ).toEqual({ form: 'blocking', variable: 'RAG_PIPELINE' });
    expect(
      languagesBannerForm(
        languagesAnswer({
          pipelines: { RAG_PIPELINE: { value: 'legacy', explicit: true }, RAG_INGEST_PIPELINE: { value: 'unified', explicit: true } },
        }),
      ),
    ).toEqual({ form: 'blocking', variable: 'RAG_INGEST_PIPELINE' });
  });

  it('no banner once languages are configured', () => {
    const { languagesBannerForm } = loadModule();
    expect(languagesBannerForm(languagesAnswer({ configured: true, languages: ['en'], primary: 'en' }))).toBeNull();
  });

  it('renders the notice on DOMContentLoaded with a neutral button that opens the panel', async () => {
    const page = loadLanguagesPage();
    page.doc.dispatch('DOMContentLoaded');
    await flush();
    const alert = page.banner.querySelector('.alert') as FakeElement;
    expect(alert).toBeTruthy();
    expect(alert.className).toContain('alert-warning');
    expect(alert.getAttribute('role')).toBeNull();
    expect(alert.textContent).toContain('Supported languages not chosen');
    expect(alert.textContent).toContain('Questions are still answered by the legacy pipelines.');
    const button = buttonByText(page.banner, 'Choose languages');
    expect(button.className).not.toContain('btn-primary');
    button.click();
    await flush();
    expect(page.tabClicks).toEqual(['desktop']);
    expect(page.doc.activeElement).toBe(page.heading);
  });

  it('renders the blocking form with the variable in code', async () => {
    const page = loadLanguagesPage({
      get: {
        status: 200,
        body: languagesAnswer({ pipelines: { RAG_PIPELINE: { value: 'v2', explicit: true }, RAG_INGEST_PIPELINE: { value: null, explicit: false } } }),
      },
    });
    page.doc.dispatch('DOMContentLoaded');
    await flush();
    const alert = page.banner.querySelector('.alert') as FakeElement;
    expect(alert.className).toContain('alert-error');
    expect(alert.querySelector('code')!.textContent).toBe('RAG_PIPELINE');
    expect(alert.textContent).toContain('RAG_PIPELINE is set, but no language is chosen.');
    expect(alert.textContent).not.toContain('{variable}');
  });
});

describe('Languages panel saves a selection (D-08)', () => {
  it('renders rows with textContent only and no markup from server strings', async () => {
    const page = await mounted({
      get: {
        status: 200,
        body: languagesAnswer({
          packs: [
            pack('zh', XSS_PAYLOAD, 'javascript:alert(1)'),
            pack('en', 'English', 'English', { selectable: false, reasons: [{ code: 'reranker_unsupported', id: XSS_PAYLOAD }] }),
          ],
        }),
      },
    });
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(injectedElements(page.doc)).toEqual([]);
    expect(page.section.querySelectorAll('a')).toEqual([]);
    expect(page.section.textContent).toContain(XSS_PAYLOAD);
    expect(languagesSource).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  });

  it('posts { languages, primary }, writes the mirrors only after a 200, and removes the banner', async () => {
    const page = await mounted({ counts: { status: 401, body: {} } });
    expect(page.banner.querySelector('.alert')).toBeTruthy();
    toggle(useBox(page.content, 'zh'), true);
    toggle(useBox(page.content, 'en'), true);
    const radio = primaryRadio(page.content, 'en');
    radio.checked = true;
    radio.dispatch('change');
    page.holdPosts();
    buttonByText(page.content, 'Save languages').click();
    await flush();
    const post = page.calls.find((c) => c.init.method === 'POST')!;
    expect(post.url).toBe('/api/config/languages');
    expect(post.init.credentials).toBe('same-origin');
    expect(post.body).toEqual({ languages: ['zh', 'en'], primary: 'en' });
    expect(JSON.stringify(post.init.headers ?? {})).not.toMatch(/Authorization/i);
    expect(page.mirror('RAG_SUPPORTED_LANGUAGES').value).toBe('');
    expect(page.configManager.config.RAG_SUPPORTED_LANGUAGES).toBe('');
    page.releasePost({ status: 200, body: { success: true, languages: ['zh', 'en'], primary: 'en', warnings: [], verifiedAgainstActiveProfile: true } });
    await flush();
    expect(page.mirror('RAG_SUPPORTED_LANGUAGES').value).toBe('zh,en');
    expect(page.mirror('RAG_PRIMARY_LANGUAGE').value).toBe('en');
    expect(page.configManager.config).toMatchObject({ RAG_SUPPORTED_LANGUAGES: 'zh,en', RAG_PRIMARY_LANGUAGE: 'en', OTHER: 'kept' });
    expect(page.status.textContent).toContain('Languages saved.');
    expect(page.section.textContent).toContain('The app uses the new languages after it restarts.');
    expect(page.banner.querySelector('.alert')).toBeNull();
  });

  it('keeps the mirrors untouched when the save is refused', async () => {
    const page = await mounted({
      post: { status: 400, body: { success: false, error: 'Invalid language settings', details: [{ code: 'empty_set' }] } },
    });
    toggle(useBox(page.content, 'zh'), true);
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(page.mirror('RAG_SUPPORTED_LANGUAGES').value).toBe('');
    expect(page.configManager.config.RAG_SUPPORTED_LANGUAGES).toBe('');
    expect(page.banner.querySelector('.alert')).toBeTruthy();
  });

  it('moves the languages settings group (the mirrors) into the panel on mount', async () => {
    const page = await mounted();
    expect(page.mirrorsHost.contains(page.group)).toBe(true);
  });

  it('initLanguagesPanel is idempotent', async () => {
    const page = await mounted();
    const first = page.context.languagesPanel;
    const gets = page.calls.filter((c) => c.init.method === undefined || c.init.method === 'GET').length;
    (page.context.initLanguagesPanel as () => void)();
    await flush();
    expect(page.context.languagesPanel).toBe(first);
    expect(page.content.querySelectorAll('table')).toHaveLength(1);
    expect(page.calls.filter((c) => c.init.method === undefined || c.init.method === 'GET').length).toBeGreaterThan(gets);
  });

  it('rows carry the native name with its lang, the code in mono with translate=no', async () => {
    const page = await mounted();
    const row = rowFor(page.content, 'zh');
    const native = row.querySelector('[lang="zh"]') as FakeElement;
    expect(native.textContent).toBe('中文');
    const code = row.querySelector('code') as FakeElement;
    expect(code.textContent).toBe('zh');
    expect(code.getAttribute('translate')).toBe('no');
  });
});

describe('index.html skeleton (UI-SPEC 6.1)', () => {
  it('has the banner host first in the main content block and the Languages section first in the tab', () => {
    const main = html.indexOf('<div class="p-6">');
    const bannerAt = html.indexOf('id="rag-language-banner"');
    const firstTab = html.indexOf('class="tab-content"', main);
    expect(bannerAt).toBeGreaterThan(main);
    expect(bannerAt).toBeLessThan(firstTab);
    const tab = html.indexOf('id="rag-administration"');
    const grid = html.indexOf('<div class="grid gap-6">', tab);
    const firstSection = html.indexOf('<section', grid);
    expect(html.slice(firstSection, firstSection + 120)).toContain('id="rag-administration-languages"');
  });

  it('section skeleton: focusable heading, description, alert host, content host, status region', () => {
    const start = html.indexOf('id="rag-administration-languages"');
    const end = html.indexOf('</section>', start);
    const section = html.slice(start, end);
    expect(section).toMatch(/<h3 id="rag-languages-title"[^>]*tabindex="-1"/);
    expect(section).toContain('data-languages-description');
    expect(section).toContain('data-languages-alert');
    expect(section).toContain('data-languages-content');
    expect(section).toMatch(/data-languages-status[^>]*role="status"[^>]*aria-live="polite"/);
  });

  it('loads rag-ui.js after rag-fetch.js and before languages.js and every other panel', () => {
    const fetchAt = html.indexOf('rag-panels/rag-fetch.js');
    const uiAt = html.indexOf('rag-panels/rag-ui.js');
    const languagesAt = html.indexOf('rag-panels/languages.js');
    expect(uiAt).toBeGreaterThan(fetchAt);
    expect(languagesAt).toBeGreaterThan(uiAt);
    expect(uiAt).toBeLessThan(html.indexOf('rag-panels/doc-types.js'));
  });

  it('uses the new intro sentence of the tab', () => {
    expect(html).toContain(
      'Choose languages, manage document-type defaults, ingestion and its changes, held uploads, tags, versions and translation, and the embedding and chunking profiles, using your existing admin session.',
    );
  });
});

function noteText(page: ReturnType<typeof loadLanguagesPage>): string {
  return (page.section.querySelector('[data-languages-notes]') as FakeElement).textContent;
}

function findingsHost(page: ReturnType<typeof loadLanguagesPage>): FakeElement {
  return page.section.querySelector('[data-languages-findings]') as FakeElement;
}

describe('Languages panel states (UI-SPEC 6.2.2, 7.2)', () => {
  it('first run with counts: languages with documents pre-checked, the largest pre-selected as primary', async () => {
    const page = await mounted();
    expect(useBox(page.content, 'zh').checked).toBe(true);
    expect(useBox(page.content, 'en').checked).toBe(true);
    expect(useBox(page.content, 'it').checked).toBe(false);
    expect(primaryRadio(page.content, 'zh').checked).toBe(true);
    expect(primaryRadio(page.content, 'it').disabled).toBe(true);
    expect(page.section.textContent).toContain('Choose the languages of your documents');
    expect(rowFor(page.content, 'zh').textContent).toContain('Documents: 132');
  });

  it('first run without counts: nothing pre-checked, em dash with hidden label, Save disabled with its reason', async () => {
    const page = await mounted({ counts: { status: 401, body: {} } });
    for (const code of ['zh', 'en', 'it']) expect(useBox(page.content, code).checked).toBe(false);
    const cell = rowFor(page.content, 'zh').querySelectorAll('td').find((td) => td.textContent.includes('—'))!;
    expect(cell.querySelector('.sr-only')!.textContent).toBe('Count unavailable');
    const save = buttonByText(page.content, 'Save languages');
    expect(save.disabled).toBe(true);
    const reasonId = save.getAttribute('aria-describedby')!;
    expect(page.doc.getElementById(reasonId)!.textContent).toBe('Choose at least one language.');
    expect(noteText(page)).toContain('Document counts need an admin sign-in on the main app.');
  });

  it('without counts the picker still saves', async () => {
    const page = await mounted({ counts: { status: 503, body: {} } });
    toggle(useBox(page.content, 'en'), true);
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(page.calls.find((c) => c.init.method === 'POST')!.body).toEqual({ languages: ['en'], primary: 'en' });
  });

  it('unchecking the primary row moves the primary to the first checked row and announces it', async () => {
    const page = await mounted();
    toggle(useBox(page.content, 'zh'), false);
    expect(primaryRadio(page.content, 'en').checked).toBe(true);
    expect(primaryRadio(page.content, 'zh').disabled).toBe(true);
    expect(page.status.textContent).toBe('English is now the primary language.');
  });

  it('exactly one language: its radio is checked and the monolingual note shows', async () => {
    const page = await mounted({ counts: { status: 401, body: {} } });
    toggle(useBox(page.content, 'it'), true);
    expect(primaryRadio(page.content, 'it').checked).toBe(true);
    expect(noteText(page)).toContain('With one language, language detection, query translation and document translation are off.');
    toggle(useBox(page.content, 'en'), true);
    expect(noteText(page)).not.toContain('With one language');
  });

  it('a pack that is not selectable has a disabled checkbox with its reason lines', async () => {
    const page = await mounted({
      get: {
        status: 200,
        body: languagesAnswer({
          packs: [pack('en', 'English', 'English'), pack('it', 'Italiano', 'Italian', { selectable: false, reasons: [{ code: 'embedding_profile_unsupported', id: 'profile-x' }] })],
        }),
      },
    });
    const box = useBox(page.content, 'it');
    expect(box.disabled).toBe(true);
    const reason = page.doc.getElementById(box.getAttribute('aria-describedby')!)!;
    expect(reason.textContent).toBe('The active embedding profile, profile-x, does not declare this language. Switch profiles first.');
    expect(reason.querySelector('code')!.textContent).toBe('profile-x');
  });

  it('groundedness and removed-language notes follow the selection', async () => {
    const page = await mounted({
      get: {
        status: 200,
        body: languagesAnswer({
          configured: true,
          languages: ['zh', 'en'],
          primary: 'en',
          variablesSet: { RAG_SUPPORTED_LANGUAGES: true, RAG_PRIMARY_LANGUAGE: true },
          packs: [pack('zh', '中文', 'Chinese', { groundedness: 'none' }), pack('en', 'English', 'English'), pack('it', 'Italiano', 'Italian')],
        }),
      },
    });
    expect(noteText(page)).toContain('Answers in 中文 are not checked for groundedness');
    toggle(useBox(page.content, 'zh'), false);
    expect(noteText(page)).toContain('Documents in 中文 stay searchable.');
    expect(noteText(page)).not.toContain('not checked for groundedness');
  });

  it('configured and unchanged: the saved set is checked and Save languages is enabled only after a change', async () => {
    const page = await mounted({
      get: {
        status: 200,
        body: languagesAnswer({ configured: true, languages: ['en'], primary: 'en', variablesSet: { RAG_SUPPORTED_LANGUAGES: true, RAG_PRIMARY_LANGUAGE: true } }),
      },
    });
    expect(page.banner.querySelector('.alert')).toBeNull();
    expect(page.section.textContent).not.toContain('Choose the languages of your documents');
    expect(useBox(page.content, 'en').checked).toBe(true);
    expect(useBox(page.content, 'zh').checked).toBe(false);
    const save = buttonByText(page.content, 'Save languages');
    expect(save.disabled).toBe(true);
    toggle(useBox(page.content, 'zh'), true);
    expect(save.disabled).toBe(false);
  });

  it('profile check not run against the active profile: warn.notVerified in the findings area, never a pass mark', async () => {
    const page = await mounted({ get: { status: 200, body: languagesAnswer({ verifiedAgainstActiveProfile: false }) } });
    const findings = findingsHost(page);
    expect(findings.textContent).toContain('The embedding profile could not be read from the database, so the languages were not verified against the active profile.');
    expect(findings.querySelector('.alert')!.className).toContain('alert-warning');
    expect(findings.querySelector('.alert')!.getAttribute('role')).toBeNull();
    expect(page.section.querySelectorAll('.badge-success, .alert-success, .bi-check-circle')).toEqual([]);
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(findingsHost(page).textContent).toContain('were not verified against the active profile');
  });

  it('a save answered with verifiedAgainstActiveProfile false keeps the warning even when the load said true', async () => {
    const page = await mounted({
      post: (body) => ({ status: 200, body: { success: true, ...(body as Json), warnings: [], verifiedAgainstActiveProfile: false } }),
    });
    expect(findingsHost(page).textContent).not.toContain('not verified');
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(findingsHost(page).textContent).toContain('were not verified against the active profile');
  });

  it('a refused save shows one sentence per code in one error alert, keeps the selection and focuses the alert', async () => {
    const page = await mounted({
      post: {
        status: 400,
        body: {
          success: false,
          error: 'Invalid language settings',
          details: [
            { code: 'embedding_profile_unsupported', language: 'it', id: 'profile-x' },
            { code: 'reranker_unsupported', language: 'zh', id: 'local_bm25' },
            { code: 'primary_not_in_set', language: 'it' },
            { code: 'something_new', language: 'it' },
          ],
        },
      },
    });
    buttonByText(page.content, 'Save languages').click();
    await flush();
    const alerts = findingsHost(page).querySelectorAll('.alert');
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.className).toContain('alert-error');
    expect(alert.getAttribute('role')).toBe('alert');
    const sentences = alert.querySelectorAll('li').map((li) => li.textContent);
    expect(sentences).toHaveLength(4);
    expect(sentences[0]).toBe('Not saved. The active embedding profile, profile-x, does not declare Italiano. Activate a profile that does, then save again.');
    expect(sentences[1]).toBe('Not saved. The active reranker, local_bm25, does not declare 中文. Choose another reranker under RAG Modes, then save again.');
    expect(sentences[2]).toBe('Not saved. The primary language must be one of the chosen languages.');
    expect(alert.querySelectorAll('li')[3]!.querySelector('code')!.textContent).toBe('something_new');
    expect(page.doc.activeElement).toBe(alert);
    expect(useBox(page.content, 'zh').checked).toBe(true);
    expect(useBox(page.content, 'en').checked).toBe(true);
  });

  it('a save the server could not finish keeps the selection and says why in the status region', async () => {
    const page = await mounted({ post: { status: 500, body: { success: false, error: 'Language settings could not be saved' } } });
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(page.status.textContent).toContain('Request failed (500).');
    expect(page.mirror('RAG_SUPPORTED_LANGUAGES').value).toBe('');
    const network = await mounted({ post: { status: 0, throws: true } });
    buttonByText(network.content, 'Save languages').click();
    await flush();
    expect(network.status.textContent).toContain("Can't reach the Config UI server.");
  });

  it('server warnings after a save render as one warning alert', async () => {
    const page = await mounted({
      post: (body) => ({
        status: 200,
        body: { success: true, ...(body as Json), warnings: [{ code: 'groundedness_not_checked', language: 'zh' }], verifiedAgainstActiveProfile: true },
      }),
    });
    buttonByText(page.content, 'Save languages').click();
    await flush();
    const alert = findingsHost(page).querySelector('.alert-warning')!;
    expect(alert.textContent).toContain('Answers in 中文 are not checked for groundedness');
  });

  it('config server unreachable: no banner, the unavailable sentence with Reload panel that loads again', async () => {
    let fail = true;
    const page = loadLanguagesPage({ get: () => (fail ? { status: 0, throws: true } : { status: 200, body: languagesAnswer() }) });
    page.doc.dispatch('DOMContentLoaded');
    await flush();
    expect(page.banner.children).toEqual([]);
    (page.context.initLanguagesPanel as () => void)();
    await flush();
    expect(page.banner.children).toEqual([]);
    const alert = page.alertHost.querySelector('.alert-error')!;
    expect(alert.textContent).toContain('The language list is unavailable right now.');
    fail = false;
    buttonByText(alert, 'Reload panel').click();
    await flush();
    expect(page.alertHost.querySelector('.alert-error')).toBeNull();
    expect(page.content.querySelector('table')).toBeTruthy();
    expect(page.banner.querySelector('.alert')).toBeTruthy();
  });

  it('a failed refresh keeps the earlier table, dimmed', async () => {
    let fail = false;
    const page = loadLanguagesPage({ get: () => (fail ? { status: 0, throws: true } : { status: 200, body: languagesAnswer() }) });
    (page.context.initLanguagesPanel as () => void)();
    await flush();
    fail = true;
    (page.context.initLanguagesPanel as () => void)();
    await flush();
    expect(page.content.querySelector('table')).toBeTruthy();
    expect(page.content.className).toContain('opacity-60');
    expect(page.alertHost.textContent).toContain('The language list is unavailable right now.');
  });

  it('first load shows the loading text; a refresh keeps content with aria-busy', async () => {
    const page = loadLanguagesPage();
    const pending = (page.context.initLanguagesPanel as () => Promise<void>)();
    expect(page.content.textContent).toContain('Loading languages…');
    expect(page.content.querySelector('.loading')).toBeTruthy();
    await pending;
    await flush();
    const refresh = (page.context.initLanguagesPanel as () => Promise<void>)();
    expect(page.content.querySelector('table')).toBeTruthy();
    expect(page.content.getAttribute('aria-busy')).toBe('true');
    expect(page.content.className).toContain('opacity-60');
    await refresh;
    await flush();
    expect(page.content.getAttribute('aria-busy')).toBeNull();
  });

  it('a running save shows the spinner and Saving… on its button and disables Reset selection', async () => {
    const page = await mounted();
    page.holdPosts();
    const save = buttonByText(page.content, 'Save languages');
    save.click();
    await flush();
    expect(save.textContent).toContain('Saving…');
    expect(save.querySelector('.loading')).toBeTruthy();
    expect(buttonByText(page.content, 'Reset selection').disabled).toBe(true);
    page.releasePost({ status: 200, body: { success: true, languages: ['zh', 'en'], primary: 'zh', warnings: [], verifiedAgainstActiveProfile: true } });
    await flush();
    expect(buttonByText(page.content, 'Reset selection').disabled).toBe(false);
  });

  it('Reset selection restores the saved values', async () => {
    const page = await mounted({
      get: {
        status: 200,
        body: languagesAnswer({ configured: true, languages: ['zh', 'en'], primary: 'en', variablesSet: { RAG_SUPPORTED_LANGUAGES: true, RAG_PRIMARY_LANGUAGE: true } }),
      },
    });
    toggle(useBox(page.content, 'en'), false);
    toggle(useBox(page.content, 'it'), true);
    buttonByText(page.content, 'Reset selection').click();
    expect(useBox(page.content, 'zh').checked).toBe(true);
    expect(useBox(page.content, 'en').checked).toBe(true);
    expect(useBox(page.content, 'it').checked).toBe(false);
    expect(primaryRadio(page.content, 'en').checked).toBe(true);
  });
});

describe('the impact guard of plan 57 (UI-SPEC 6.2.2, 6.4.1)', () => {
  const configured = {
    status: 200,
    body: languagesAnswer({ configured: true, languages: ['en'], primary: 'en', variablesSet: { RAG_SUPPORTED_LANGUAGES: true, RAG_PRIMARY_LANGUAGE: true } }),
  };

  it('a changed set on a configured deployment asks the guard first and saves nothing when it declines', async () => {
    const asked: unknown[] = [];
    const page = await mounted({
      get: configured,
      globals: {
        ragIngestImpactGuard: async (next: Json, saved: Json) => {
          asked.push({ next, saved });
          return false;
        },
      },
    });
    toggle(useBox(page.content, 'zh'), true);
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(asked).toEqual([
      {
        next: { RAG_SUPPORTED_LANGUAGES: 'zh,en', RAG_PRIMARY_LANGUAGE: 'en' },
        saved: { RAG_SUPPORTED_LANGUAGES: 'en', RAG_PRIMARY_LANGUAGE: 'en' },
      },
    ]);
    expect(page.calls.some((c) => c.init.method === 'POST')).toBe(false);
    expect(useBox(page.content, 'zh').checked).toBe(true);
    expect(buttonByText(page.content, 'Save languages').disabled).toBe(false);
  });

  it('saves when the guard agrees', async () => {
    const page = await mounted({ get: configured, globals: { ragIngestImpactGuard: async () => true } });
    toggle(useBox(page.content, 'zh'), true);
    buttonByText(page.content, 'Save languages').click();
    await flush();
    expect(page.calls.find((c) => c.init.method === 'POST')!.body).toEqual({ languages: ['zh', 'en'], primary: 'en' });
  });

  it('a changed primary alone, the first choice from unset and a missing guard all save directly', async () => {
    let asked = 0;
    const guard = async () => {
      asked += 1;
      return false;
    };
    const primaryOnly = await mounted({
      get: {
        status: 200,
        body: languagesAnswer({ configured: true, languages: ['zh', 'en'], primary: 'en', variablesSet: { RAG_SUPPORTED_LANGUAGES: true, RAG_PRIMARY_LANGUAGE: true } }),
      },
      globals: { ragIngestImpactGuard: guard },
    });
    const radio = primaryRadio(primaryOnly.content, 'zh');
    radio.checked = true;
    radio.dispatch('change');
    buttonByText(primaryOnly.content, 'Save languages').click();
    await flush();
    expect(primaryOnly.calls.some((c) => c.init.method === 'POST')).toBe(true);

    const firstRun = await mounted({ globals: { ragIngestImpactGuard: guard } });
    buttonByText(firstRun.content, 'Save languages').click();
    await flush();
    expect(firstRun.calls.some((c) => c.init.method === 'POST')).toBe(true);

    const noGuard = await mounted({ get: configured });
    toggle(useBox(noGuard.content, 'zh'), true);
    buttonByText(noGuard.content, 'Save languages').click();
    await flush();
    expect(noGuard.calls.some((c) => c.init.method === 'POST')).toBe(true);
    expect(asked).toBe(0);
  });
});
