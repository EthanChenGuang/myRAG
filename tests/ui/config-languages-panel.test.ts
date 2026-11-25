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
