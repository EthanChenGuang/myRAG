/**
 * Languages panel and page banner (UI-SPEC 6.2; D-02, D-07, D-08). Plain-text DOM only, built with the rag-ui.js helpers.
 * Packs, saved values and validation come from the config server; document counts come from the app and are optional.
 */

const LANGUAGES_LABELS = {
  en: {
    'banner.title': 'Supported languages not chosen',
    'banner.bodyLegacy':
      'Questions are still answered by the legacy pipelines. Choose the languages before you turn on the newer ones.',
    'banner.bodyExplicit':
      '{variable} is set, but no language is chosen. Until you choose, the knowledge base answers “temporarily unavailable” and new uploads are refused.',
    'banner.action': 'Choose languages',
    'panel.title': 'Languages',
    'panel.description':
      "The languages this deployment’s knowledge base supports. Parsing, text recognition, chunking, detection and translation work for these languages only. Applies to every workspace.",
    'firstRun.title': 'Choose the languages of your documents',
    'firstRun.body':
      'Tick every language your documents and questions use, then pick the primary one. It is used when a language cannot be detected. You can change this later.',
    'col.use': 'Use',
    'col.language': 'Language',
    'col.code': 'Code',
    'col.documents': 'Documents',
    'col.primary': 'Primary',
    'col.useAria': 'Use {language}',
    'col.primaryAria': 'Make {language} the primary language',
    'docs.noCount': 'Count unavailable',
    'docs.unavailable': 'Document counts need an admin sign-in on the main app. You can choose languages without them.',
    'blocked.embedding': 'The active embedding profile, {profile}, does not declare this language. Switch profiles first.',
    'blocked.reranker': 'The active reranker, {reranker}, does not declare this language.',
    'primary.moved': '{language} is now the primary language.',
    'note.monolingual': 'With one language, language detection, query translation and document translation are off.',
    'note.groundedness': 'Answers in {language} are not checked for groundedness and are recorded as “not checked”.',
    'note.removed': 'Documents in {language} stay searchable. Detection and translation stop for this language.',
    'action.save': 'Save languages',
    'action.reset': 'Reset selection',
    'save.needOne': 'Choose at least one language.',
    'save.running': 'Saving…',
    'save.done': 'Languages saved.',
    'save.restart': 'The app uses the new languages after it restarts.',
    'error.empty_set': 'Not saved. Choose at least one language.',
    'error.primary_not_in_set': 'Not saved. The primary language must be one of the chosen languages.',
    'error.incomplete_pack': 'Not saved. {language} is not fully supported yet, so it cannot be chosen.',
    'error.embedding_profile_unsupported':
      'Not saved. The active embedding profile, {profile}, does not declare {language}. Activate a profile that does, then save again.',
    'error.reranker_unsupported':
      'Not saved. The active reranker, {reranker}, does not declare {language}. Choose another reranker under RAG Modes, then save again.',
    'warn.notVerified':
      'The embedding profile could not be read from the database, so the languages were not verified against the active profile.',
    'list.loading': 'Loading languages…',
    'list.unavailable':
      'The language list is unavailable right now. Check that the Config UI server is running, then select Reload panel.',
  },
  zh: {
    'banner.title': '尚未选择支持的语言',
    'banner.bodyLegacy': '问题仍由旧版流程回答。启用新流程之前，请先选择语言。',
    'banner.bodyExplicit': '已设置 {variable}，但尚未选择语言。选择之前，知识库会回答“暂时不可用”，新上传会被拒绝。',
    'banner.action': '选择语言',
    'panel.title': '语言',
    'panel.description': '此部署的知识库所支持的语言。解析、文字识别、切块、语言检测和翻译只针对这些语言。适用于所有工作区。',
    'firstRun.title': '选择文档所用的语言',
    'firstRun.body': '勾选文档和提问会用到的所有语言，再选择主要语言。无法检测语言时会使用主要语言。以后可以更改。',
    'col.use': '启用',
    'col.language': '语言',
    'col.code': '代码',
    'col.documents': '文档数',
    'col.primary': '主要语言',
    'col.useAria': '启用{language}',
    'col.primaryAria': '将{language}设为主要语言',
    'docs.noCount': '数量不可用',
    'docs.unavailable': '文档数量需要在主应用以管理员身份登录后才能显示。没有数量也可以选择语言。',
    'blocked.embedding': '当前的 Embedding 配置 {profile} 未声明支持此语言。请先切换配置。',
    'blocked.reranker': '当前的重排模型 {reranker} 未声明支持此语言。',
    'primary.moved': '{language}现在是主要语言。',
    'note.monolingual': '只选一种语言时，语言检测、查询翻译和文档翻译都会关闭。',
    'note.groundedness': '{language}的回答不做依据核查，会记录为“未核查”。',
    'note.removed': '{language}的文档仍可检索，但不再对该语言做检测和翻译。',
    'action.save': '保存语言',
    'action.reset': '恢复已保存的选择',
    'save.needOne': '请至少选择一种语言。',
    'save.running': '正在保存…',
    'save.done': '语言已保存。',
    'save.restart': '应用重启后才会使用新的语言设置。',
    'error.empty_set': '未保存。请至少选择一种语言。',
    'error.primary_not_in_set': '未保存。主要语言必须是已选语言之一。',
    'error.incomplete_pack': '未保存。{language}尚未完整支持，无法选择。',
    'error.embedding_profile_unsupported': '未保存。当前的 Embedding 配置 {profile} 未声明支持{language}。请先启用支持它的配置，再保存。',
    'error.reranker_unsupported': '未保存。当前的重排模型 {reranker} 未声明支持{language}。请在“RAG 模式”中换一个重排模型，再保存。',
    'warn.notVerified': '无法从数据库读取 Embedding 配置，因此未按当前配置核对语言。',
    'list.loading': '正在加载语言…',
    'list.unavailable': '暂时无法获取语言列表。请确认 Config UI 服务器正在运行，然后选择“重新加载面板”。',
  },
  it: {
    'banner.title': 'Lingue supportate non scelte',
    'banner.bodyLegacy':
      'Alle domande rispondono ancora le pipeline legacy. Scegli le lingue prima di attivare quelle nuove.',
    'banner.bodyExplicit':
      '{variable} è impostata, ma nessuna lingua è scelta. Finché non scegli, la knowledge base risponde «temporaneamente non disponibile» e i nuovi caricamenti vengono rifiutati.',
    'banner.action': 'Scegli le lingue',
    'panel.title': 'Lingue',
    'panel.description':
      'Le lingue supportate dalla knowledge base di questa installazione. Parsing, riconoscimento del testo, suddivisione, rilevamento e traduzione funzionano solo per queste lingue. Vale per tutti gli spazi di lavoro.',
    'firstRun.title': 'Scegli le lingue dei tuoi documenti',
    'firstRun.body':
      'Seleziona tutte le lingue usate da documenti e domande, poi scegli quella principale: viene usata quando una lingua non può essere rilevata. Potrai cambiarle in seguito.',
    'col.use': 'Usa',
    'col.language': 'Lingua',
    'col.code': 'Codice',
    'col.documents': 'Documenti',
    'col.primary': 'Principale',
    'col.useAria': 'Usa {language}',
    'col.primaryAria': 'Imposta {language} come lingua principale',
    'docs.noCount': 'Conteggio non disponibile',
    'docs.unavailable':
      'I conteggi dei documenti richiedono l’accesso come amministratore nell’app principale. Puoi scegliere le lingue anche senza.',
    'blocked.embedding': 'Il profilo di embedding attivo, {profile}, non dichiara questa lingua. Cambia prima profilo.',
    'blocked.reranker': 'Il reranker attivo, {reranker}, non dichiara questa lingua.',
    'primary.moved': '{language} è ora la lingua principale.',
    'note.monolingual':
      'Con una sola lingua, rilevamento della lingua, traduzione delle domande e traduzione dei documenti sono disattivati.',
    'note.groundedness': 'Le risposte in {language} non vengono verificate rispetto alle fonti e sono registrate come «non verificate».',
    'note.removed': 'I documenti in {language} restano ricercabili. Rilevamento e traduzione si fermano per questa lingua.',
    'action.save': 'Salva le lingue',
    'action.reset': 'Ripristina la selezione',
    'save.needOne': 'Scegli almeno una lingua.',
    'save.running': 'Salvataggio…',
    'save.done': 'Lingue salvate.',
    'save.restart': 'L’app usa le nuove lingue dopo il riavvio.',
    'error.empty_set': 'Non salvato. Scegli almeno una lingua.',
    'error.primary_not_in_set': 'Non salvato. La lingua principale deve essere una di quelle scelte.',
    'error.incomplete_pack': 'Non salvato. {language} non è ancora supportata per intero e non può essere scelta.',
    'error.embedding_profile_unsupported':
      'Non salvato. Il profilo di embedding attivo, {profile}, non dichiara {language}. Attiva un profilo che la dichiara, poi salva di nuovo.',
    'error.reranker_unsupported':
      'Non salvato. Il reranker attivo, {reranker}, non dichiara {language}. Scegli un altro reranker in RAG Modes, poi salva di nuovo.',
    'warn.notVerified':
      'Non è stato possibile leggere il profilo di embedding dal database, quindi le lingue non sono state verificate rispetto al profilo attivo.',
    'list.loading': 'Caricamento delle lingue…',
    'list.unavailable':
      'L’elenco delle lingue non è disponibile. Verifica che il server della Config UI sia in esecuzione, poi seleziona Ricarica pannello.',
  },
};

const LANGUAGES_ENDPOINT = '/api/config/languages';
const LANGUAGES_COUNTS_PATH = '/api/rag/admin/languages';
const LANGUAGES_PIPELINE_FORCING = [
  ['RAG_PIPELINE', 'v2'],
  ['RAG_INGEST_PIPELINE', 'unified'],
];
const LANGUAGES_BLOCK_KEYS = {
  embedding_profile_unsupported: ['blocked.embedding', 'profile'],
  reranker_unsupported: ['blocked.reranker', 'reranker'],
};

let languagesUi = null;
if (typeof require !== 'undefined') {
  try {
    languagesUi = require('./rag-ui.js');
  } catch {
    languagesUi = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function languagesUiLib() {
  if (languagesUi) return languagesUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

function languagesLabel(key, locale, vars) {
  const loc = locale === 'zh' || locale === 'it' ? locale : 'en';
  const text = (LANGUAGES_LABELS[loc] && LANGUAGES_LABELS[loc][key]) || LANGUAGES_LABELS.en[key];
  if (text === undefined) return languagesUiLib().ragUiLabel(key, loc, vars);
  return languagesUiLib().ragUiFill(text, vars);
}

function languagesString(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/** The language's name in the UI language; null when it equals the native name. */
function languagesUiName(code, nativeName, englishName, locale) {
  let name = englishName;
  if (locale !== 'en') {
    try {
      const display = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames([locale], { type: 'language' }) : null;
      const localized = display ? display.of(code) : null;
      if (localized && localized !== code) name = localized;
    } catch {
      name = englishName;
    }
  }
  name = languagesString(name);
  return name && name !== nativeName ? name : null;
}

/** D-02 banner: null when configured, the blocking form when a newer pipeline is forced explicitly, else the notice. */
function languagesBannerForm(answer) {
  if (!answer || typeof answer !== 'object' || answer.configured === true) return null;
  const pipelines = answer.pipelines && typeof answer.pipelines === 'object' ? answer.pipelines : {};
  for (const [name, forcing] of LANGUAGES_PIPELINE_FORCING) {
    const entry = pipelines[name];
    if (entry && entry.explicit === true && languagesString(entry.value).trim() === forcing) {
      return { form: 'blocking', variable: name };
    }
  }
  return { form: 'notice', variable: null };
}

/** Pure view model of a GET /api/config/languages answer and the optional counts (UI-SPEC 6.2.2, 8.1). Named fields only. */
function languagesBuildView(answer, options) {
  const locale = (options && options.locale) || 'en';
  const counts = options && Array.isArray(options.counts) ? options.counts : null;
  const byLanguage = new Map();
  if (counts) {
    for (const entry of counts) {
      if (entry && typeof entry.language === 'string' && Number.isFinite(Number(entry.documents))) {
        byLanguage.set(entry.language, Number(entry.documents));
      }
    }
  }
  const body = answer && typeof answer === 'object' ? answer : {};
  const packs = Array.isArray(body.packs) ? body.packs : [];
  const rows = packs
    .filter((p) => p && typeof p.code === 'string' && p.code)
    .map((p) => {
      const nativeName = languagesString(p.nativeName) || p.code;
      const reasons = Array.isArray(p.reasons) ? p.reasons : [];
      const blocked = reasons
        .filter((r) => r && typeof r.code === 'string')
        .map((r) => {
          const known = LANGUAGES_BLOCK_KEYS[r.code];
          if (known) return { key: known[0], vars: { [known[1]]: languagesString(r.id) } };
          return { key: 'error.invalid', vars: { detail: r.code } };
        });
      return {
        code: p.code,
        nativeName,
        uiName: languagesUiName(p.code, nativeName, p.englishName, locale),
        groundedness: languagesString(p.groundedness),
        selectable: p.selectable !== false,
        blocked,
        count: counts ? byLanguage.get(p.code) ?? 0 : null,
      };
    });
  const codes = new Set(rows.map((r) => r.code));
  const savedLanguages = (Array.isArray(body.languages) ? body.languages : []).filter((c) => codes.has(c));
  const savedPrimary = typeof body.primary === 'string' && codes.has(body.primary) ? body.primary : null;
  const variablesSet = body.variablesSet && typeof body.variablesSet === 'object' ? body.variablesSet : {};
  const configured = body.configured === true;
  return {
    configured,
    firstRun: !configured && variablesSet.RAG_SUPPORTED_LANGUAGES !== true && variablesSet.RAG_PRIMARY_LANGUAGE !== true,
    rows,
    banner: languagesBannerForm(body),
    saved: { languages: savedLanguages, primary: savedPrimary },
    verified: body.verifiedAgainstActiveProfile === true,
    countsAvailable: Boolean(counts),
  };
}

/** The POST body: languages in registry order, the primary as chosen. */
function languagesSaveBody(rows, checked, primary) {
  const set = new Set(checked);
  return { languages: rows.filter((r) => set.has(r.code)).map((r) => r.code), primary: primary || null };
}

/**
 * The selection the panel starts from: the saved values; on a first run with counts, every selectable language that has
 * documents, with the one that has the most as primary (D-08). Without counts nothing is pre-checked.
 */
function languagesInitialSelection(view) {
  if (view.firstRun) {
    if (!view.countsAvailable) return { checked: [], primary: null };
    const found = view.rows.filter((r) => r.selectable && r.count > 0);
    let primary = null;
    let most = 0;
    for (const row of found) {
      if (row.count > most) {
        most = row.count;
        primary = row.code;
      }
    }
    return { checked: found.map((r) => r.code), primary };
  }
  return { checked: [...view.saved.languages], primary: view.saved.primary };
}

/** After a change: the primary stays if its row is checked, else it moves to the first checked row in registry order. */
function languagesNextPrimary(rows, checked, primary) {
  const set = new Set(checked);
  if (primary && set.has(primary)) return { primary, moved: false };
  const first = rows.find((r) => set.has(r.code));
  const next = first ? first.code : null;
  return { primary: next, moved: Boolean(primary && next && next !== primary) };
}

function languagesSameSet(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((code) => right.has(code));
}

function languagesNameOf(rows, code) {
  const row = rows.find((r) => r.code === code);
  return row ? row.nativeName : languagesString(code);
}

/** The notes under the table, recomputed on every change (UI-SPEC 6.2.2). */
function languagesNotes(view, checked) {
  const set = new Set(checked);
  const notes = [];
  if (set.size === 1) notes.push({ key: 'note.monolingual', icon: 'info-circle', tone: 'info', vars: {} });
  for (const row of view.rows) {
    if (set.has(row.code) && row.groundedness === 'none') {
      notes.push({ key: 'note.groundedness', icon: 'exclamation-triangle', tone: 'warning', vars: { language: row.nativeName } });
    }
  }
  if (view.configured) {
    for (const code of view.saved.languages) {
      if (!set.has(code)) notes.push({ key: 'note.removed', icon: 'info-circle', tone: 'info', vars: { language: languagesNameOf(view.rows, code) } });
    }
  }
  if (!view.countsAvailable) notes.push({ key: 'docs.unavailable', icon: null, tone: 'muted', vars: {} });
  return notes;
}

const LANGUAGES_SAVE_ERRORS = new Set(['empty_set', 'primary_not_in_set', 'incomplete_pack', 'embedding_profile_unsupported', 'reranker_unsupported']);

/** One sentence per D-07 error of a refused save: { key, vars, codeVars } for known codes, { unknown: code } otherwise. */
function languagesErrorItems(details, rows) {
  return (Array.isArray(details) ? details : [])
    .filter((d) => d && typeof d === 'object' && typeof d.code === 'string')
    .map((d) => {
      if (!LANGUAGES_SAVE_ERRORS.has(d.code)) return { unknown: d.code };
      const vars = {};
      if (d.language !== undefined) vars.language = languagesNameOf(rows, d.language);
      if (d.code === 'embedding_profile_unsupported') vars.profile = languagesString(d.id);
      if (d.code === 'reranker_unsupported') vars.reranker = languagesString(d.id);
      return { key: 'error.' + d.code, vars, codeVars: ['profile', 'reranker'] };
    });
}

/** Warnings of a successful save: groundedness_not_checked becomes note.groundedness; anything else its code. */
function languagesWarningItems(warnings, rows) {
  return (Array.isArray(warnings) ? warnings : [])
    .filter((w) => w && typeof w === 'object' && typeof w.code === 'string')
    .map((w) =>
      w.code === 'groundedness_not_checked'
        ? { key: 'note.groundedness', vars: { language: languagesNameOf(rows, w.language) }, codeVars: [] }
        : { unknown: w.code },
    );
}

function languagesBannerHost() {
  return typeof document !== 'undefined' ? document.getElementById('rag-language-banner') : null;
}

function languagesClearBanner() {
  const host = languagesBannerHost();
  if (host) host.replaceChildren();
}

/** Opens the panel from the banner: activates the tab, scrolls to the section and focuses its heading. */
function languagesOpenPanel() {
  const link = document.querySelector('.menu-item[data-tab="rag-administration"]') || document.querySelector('[data-tab="rag-administration"]');
  if (link) link.click();
  initLanguagesPanel();
  const section = document.getElementById('rag-administration-languages');
  if (section && typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'start' });
  const heading = document.getElementById('rag-languages-title');
  if (heading) heading.focus();
}

/** Renders the page banner (UI-SPEC 6.2.1) or removes it. Not dismissible, no alert role. */
function languagesRenderBanner(form, locale) {
  const host = languagesBannerHost();
  if (!host) return;
  host.replaceChildren();
  if (!form) return;
  host.setAttribute('lang', locale);
  const doc = document;
  const blocking = form.form === 'blocking';
  const body = blocking
    ? languagesUiLib().ragUiEl(doc, 'p', { className: 'text-sm' }, languagesUiLib().ragUiTemplateNodes(doc, languagesLabel('banner.bodyExplicit', locale), { variable: form.variable }, ['variable']))
    : languagesUiLib().ragUiEl(doc, 'p', { className: 'text-sm', text: languagesLabel('banner.bodyLegacy', locale) });
  const action = languagesUiLib().ragUiEl(doc, 'button', { className: 'btn btn-sm', text: languagesLabel('banner.action', locale), attrs: { type: 'button' } });
  action.addEventListener('click', () => languagesOpenPanel());
  host.appendChild(
    languagesUiLib().ragUiAlert(doc, {
      tone: blocking ? 'error' : 'warning',
      icon: blocking ? 'exclamation-octagon' : 'translate',
      title: languagesLabel('banner.title', locale),
      body: [body],
      actions: [action],
      className: 'mb-6',
    }),
  );
}

async function languagesFetchSettings() {
  return languagesUiLib().ragUiFetchJson(LANGUAGES_ENDPOINT, { method: 'GET' });
}

async function languagesLoadBanner() {
  const locale = languagesUiLib().ragUiBrowserLocale();
  const result = await languagesFetchSettings();
  if (!result.ok || !result.body || typeof result.body !== 'object') {
    languagesRenderBanner(null, locale);
    return;
  }
  languagesRenderBanner(languagesBannerForm(result.body), locale);
}

class LanguagesPanel {
  constructor(root) {
    this.root = root;
    this.doc = document;
    this.locale = languagesUiLib().ragUiBrowserLocale();
    this.mounted = false;
    this.view = null;
    this.checked = new Set();
    this.primary = null;
    this.saving = false;
    this.loading = null;
    this.verified = true;
    this.findings = [];
    this.hosts = {
      title: root.querySelector('[data-languages-title]'),
      description: root.querySelector('[data-languages-description]'),
      alert: root.querySelector('[data-languages-alert]'),
      content: root.querySelector('[data-languages-content]'),
      mirrors: root.querySelector('[data-languages-mirrors]'),
      status: root.querySelector('[data-languages-status]'),
    };
  }

  t(key, vars) {
    return languagesLabel(key, this.locale, vars);
  }

  el(tag, options, children) {
    return languagesUiLib().ragUiEl(this.doc, tag, options, children);
  }

  sentence(key, vars, codeVars) {
    return languagesUiLib().ragUiTemplateNodes(this.doc, this.t(key), vars || {}, codeVars || []);
  }

  mount() {
    if (this.mounted) return this.refresh();
    this.mounted = true;
    this.root.setAttribute('lang', this.locale);
    if (this.hosts.title) this.hosts.title.textContent = this.t('panel.title');
    if (this.hosts.description) this.hosts.description.textContent = this.t('panel.description');
    if (this.hosts.status) this.hosts.status.setAttribute('tabindex', '-1');
    const group = document.querySelector('[data-rag-settings-group="languages"]');
    if (group && this.hosts.mirrors && !this.hosts.mirrors.contains(group)) this.hosts.mirrors.appendChild(group);
    return this.refresh();
  }

  refresh() {
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async load() {
    const ui = languagesUiLib();
    const content = this.hosts.content;
    if (this.view) ui.ragUiListBusy(content, true);
    else ui.ragUiListLoading(this.doc, content, this.t('list.loading'));
    const [settings, counts] = await Promise.all([
      languagesFetchSettings(),
      ui.ragUiRagRequest(LANGUAGES_COUNTS_PATH, { method: 'GET' }),
    ]);
    if (!settings.ok || !settings.body || typeof settings.body !== 'object' || !Array.isArray(settings.body.packs)) {
      languagesRenderBanner(null, this.locale);
      this.showUnavailable();
      return;
    }
    if (this.hosts.alert) this.hosts.alert.replaceChildren();
    ui.ragUiListBusy(content, false);
    const countList = counts && counts.ok && counts.body && Array.isArray(counts.body.counts) ? counts.body.counts : null;
    this.view = languagesBuildView(settings.body, { locale: this.locale, counts: countList });
    const initial = languagesInitialSelection(this.view);
    this.checked = new Set(initial.checked);
    this.primary = languagesNextPrimary(this.view.rows, initial.checked, initial.primary).primary;
    this.verified = this.view.verified;
    this.findings = [];
    languagesRenderBanner(this.view.banner, this.locale);
    this.render();
  }

  showUnavailable() {
    const ui = languagesUiLib();
    const content = this.hosts.content;
    if (this.view) ui.ragUiListBusy(content, true, true);
    else if (content) content.replaceChildren();
    if (this.hosts.alert) {
      this.hosts.alert.replaceChildren(ui.ragUiUnavailableAlert(this.doc, this.locale, this.t('list.unavailable'), () => this.refresh()));
    }
  }

  render() {
    const view = this.view;
    const content = this.hosts.content;
    if (!view || !content) return;
    const nodes = [];
    if (view.firstRun) {
      nodes.push(
        this.el('div', { className: 'mb-4 max-w-prose' }, [
          this.el('h4', { className: 'text-base font-semibold text-balance', text: this.t('firstRun.title') }),
          this.el('p', { className: 'text-sm', text: this.t('firstRun.body') }),
        ]),
      );
    }
    nodes.push(this.renderTable());
    this.notesHost = this.el('div', { className: 'mt-4 flex flex-col gap-2 max-w-prose empty:hidden', attrs: { 'data-languages-notes': '' } });
    this.findingsHost = this.el('div', { className: 'mt-4 flex flex-col gap-2 empty:hidden', attrs: { 'data-languages-findings': '' } });
    nodes.push(this.notesHost, this.findingsHost);
    const reasonId = 'languages-save-reason';
    this.saveReason = this.el('p', { className: 'text-xs text-base-content/70 mt-2', id: reasonId });
    this.saveButton = this.el('button', { className: 'btn btn-primary btn-sm', text: this.t('action.save'), attrs: { type: 'button' } });
    this.saveButton.addEventListener('click', () => this.save());
    this.resetButton = this.el('button', { className: 'btn btn-ghost btn-sm', text: this.t('action.reset'), attrs: { type: 'button' } });
    this.resetButton.addEventListener('click', () => this.reset());
    nodes.push(this.el('div', { className: 'flex flex-wrap gap-2 mt-4' }, [this.saveButton, this.resetButton]));
    nodes.push(this.saveReason);
    this.restartHost = this.el('p', { className: 'text-xs text-base-content/70 mt-2 empty:hidden' });
    nodes.push(this.restartHost);
    content.replaceChildren(...nodes);
    this.updateControls();
    this.renderFindings();
  }

  renderTable() {
    const th = (key, extra) =>
      this.el('th', { className: 'text-xs font-semibold' + (extra ? ' ' + extra : ''), text: this.t(key), attrs: { scope: 'col' } });
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('panel.title') }),
      this.el('thead', {}, [
        this.el('tr', {}, [
          th('col.use'),
          th('col.language'),
          th('col.code', 'hidden md:table-cell'),
          th('col.documents', 'text-right hidden md:table-cell'),
          th('col.primary'),
        ]),
      ]),
      this.el('tbody', {}, this.view.rows.map((row) => this.renderRow(row))),
    ]);
    return this.el(
      'div',
      {
        className: 'overflow-x-auto max-w-full rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('panel.title') },
      },
      [table],
    );
  }

  renderRow(row) {
    const ui = languagesUiLib();
    const nameVars = { language: row.nativeName };
    const box = this.el('input', {
      className: 'checkbox checkbox-sm',
      attrs: { type: 'checkbox', 'aria-label': this.t('col.useAria', nameVars) },
    });
    box.disabled = !row.selectable;
    box.addEventListener('change', () => this.onUse(row.code, box.checked));
    const radio = this.el('input', {
      className: 'radio radio-sm',
      attrs: { type: 'radio', name: 'rag-primary-language', value: row.code, 'aria-label': this.t('col.primaryAria', nameVars) },
    });
    radio.addEventListener('change', () => {
      if (radio.checked) this.onPrimary(row.code);
    });
    const nameCell = this.el('th', { className: 'min-w-0 font-normal text-left align-top', attrs: { scope: 'row' } }, [
      this.el('span', { className: 'text-sm break-words', text: row.nativeName, attrs: { lang: row.code } }),
    ]);
    if (row.uiName) nameCell.appendChild(this.el('p', { className: 'text-xs text-base-content/70 break-words', text: row.uiName }));
    const blockedIds = [];
    row.blocked.forEach((reason, index) => {
      const id = 'languages-blocked-' + row.code + '-' + index;
      blockedIds.push(id);
      const text = this.el('span', { className: 'min-w-0 break-words', id });
      if (reason.key === 'error.invalid') text.appendChild(ui.ragUiCodeSentence(this.doc, this.locale, reason.vars.detail));
      else text.append(...this.sentence(reason.key, reason.vars, Object.keys(reason.vars)));
      nameCell.appendChild(
        this.el('p', { className: 'flex items-start gap-1 text-xs mt-1' }, [ui.ragUiIcon(this.doc, 'exclamation-triangle', 'text-warning shrink-0'), text]),
      );
    });
    if (blockedIds.length) box.setAttribute('aria-describedby', blockedIds.join(' '));
    const countCell = this.el('td', { className: 'text-right tabular-nums align-top hidden md:table-cell' });
    if (row.count === null) {
      countCell.appendChild(this.el('span', { text: '—', attrs: { 'aria-hidden': 'true' } }));
      countCell.appendChild(this.el('span', { className: 'sr-only', text: this.t('docs.noCount') }));
    } else {
      countCell.textContent = ui.ragUiFormatNumber(row.count, this.locale);
      nameCell.appendChild(
        this.el('p', { className: 'text-xs text-base-content/70 tabular-nums md:hidden', text: ui.ragUiCount(this.t('col.documents'), row.count, this.locale) }),
      );
    }
    return this.el('tr', { attrs: { 'data-language': row.code } }, [
      this.el('td', { className: 'align-top' }, [this.el('label', { className: 'inline-flex p-2 -m-2' + (row.selectable ? ' cursor-pointer' : '') }, [box])]),
      nameCell,
      this.el('td', { className: 'align-top hidden md:table-cell' }, [
        this.el('code', { className: 'font-mono text-xs', text: row.code, attrs: { translate: 'no' } }),
      ]),
      countCell,
      this.el('td', { className: 'align-top' }, [this.el('label', { className: 'inline-flex p-2 -m-2 cursor-pointer' }, [radio])]),
    ]);
  }

  rowElements() {
    const content = this.hosts.content;
    return content ? Array.from(content.querySelectorAll('tr')).filter((tr) => tr.getAttribute('data-language')) : [];
  }

  onUse(code, checked) {
    if (this.saving) return;
    if (checked) this.checked.add(code);
    else this.checked.delete(code);
    const next = languagesNextPrimary(this.view.rows, [...this.checked], this.primary);
    this.primary = next.primary;
    this.updateControls();
    if (next.moved) this.announce(this.t('primary.moved', { language: languagesNameOf(this.view.rows, next.primary) }));
  }

  onPrimary(code) {
    if (this.saving || !this.checked.has(code)) return;
    this.primary = code;
    this.updateControls();
  }

  reset() {
    if (this.saving || !this.view) return;
    this.checked = new Set(this.view.saved.languages);
    this.primary = languagesNextPrimary(this.view.rows, this.view.saved.languages, this.view.saved.primary).primary;
    this.updateControls();
  }

  isChanged() {
    const saved = this.view.saved;
    return !languagesSameSet(saved.languages, [...this.checked]) || saved.primary !== this.primary;
  }

  announce(text, isError) {
    const status = this.hosts.status;
    if (!status) return;
    status.classList.toggle('text-error', Boolean(isError));
    status.replaceChildren();
    if (isError) status.appendChild(languagesUiLib().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'));
    status.appendChild(this.doc.createTextNode(text));
  }

  updateControls() {
    for (const tr of this.rowElements()) {
      const code = tr.getAttribute('data-language');
      const box = tr.querySelector('input[type="checkbox"]');
      const radio = tr.querySelector('input[type="radio"]');
      if (box) box.checked = this.checked.has(code);
      if (radio) {
        radio.disabled = !this.checked.has(code);
        radio.checked = this.primary === code;
      }
    }
    this.renderNotes();
    if (!this.saveButton || this.saving) return;
    const none = this.checked.size === 0;
    const unchanged = this.view.configured && !this.isChanged();
    this.saveButton.disabled = none || unchanged;
    if (this.resetButton) this.resetButton.disabled = !this.view.configured || !this.isChanged();
    if (this.saveReason) this.saveReason.textContent = none ? this.t('save.needOne') : '';
    if (none) this.saveButton.setAttribute('aria-describedby', this.saveReason.id);
    else this.saveButton.removeAttribute('aria-describedby');
  }

  renderNotes() {
    if (!this.notesHost || !this.view) return;
    const ui = languagesUiLib();
    const items = languagesNotes(this.view, [...this.checked]).map((note) => {
      const muted = note.tone === 'muted';
      return this.el('p', { className: 'flex items-start gap-2 ' + (muted ? 'text-xs text-base-content/70' : 'text-sm leading-5') }, [
        note.icon ? ui.ragUiIcon(this.doc, note.icon, 'shrink-0' + (note.tone === 'warning' ? ' text-warning' : '')) : null,
        this.el('span', { className: 'min-w-0 break-words', text: this.t(note.key, note.vars) }),
      ]);
    });
    this.notesHost.replaceChildren(...items);
  }

  itemNode(item) {
    if (item.unknown !== undefined) return languagesUiLib().ragUiCodeSentence(this.doc, this.locale, item.unknown);
    return this.el('span', {}, this.sentence(item.key, item.vars, item.codeVars));
  }

  /** Findings: the refused-save alert, the warnings of the last save and the "not verified" line (never a pass mark). */
  renderFindings() {
    if (!this.findingsHost) return;
    const ui = languagesUiLib();
    const nodes = [];
    for (const finding of this.findings) {
      const list = this.el('ul', { className: 'list-disc pl-4 text-sm flex flex-col gap-1' }, finding.items.map((item) => this.el('li', {}, [this.itemNode(item)])));
      const alert = ui.ragUiAlert(this.doc, {
        tone: finding.tone,
        icon: finding.tone === 'error' ? 'exclamation-circle' : 'exclamation-triangle',
        body: [list],
        role: finding.tone === 'error' ? 'alert' : null,
      });
      if (finding.tone === 'error') alert.setAttribute('tabindex', '-1');
      nodes.push(alert);
    }
    if (!this.verified) {
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', body: [this.t('warn.notVerified')] }));
    }
    this.findingsHost.replaceChildren(...nodes);
    return nodes;
  }

  async askGuard(body) {
    const guard = typeof window !== 'undefined' ? window.ragIngestImpactGuard : null;
    if (typeof guard !== 'function' || !this.view.configured) return true;
    if (languagesSameSet(this.view.saved.languages, body.languages)) return true;
    const next = { RAG_SUPPORTED_LANGUAGES: body.languages.join(','), RAG_PRIMARY_LANGUAGE: body.primary || '' };
    const saved = { RAG_SUPPORTED_LANGUAGES: this.view.saved.languages.join(','), RAG_PRIMARY_LANGUAGE: this.view.saved.primary || '' };
    try {
      const answer = await guard(next, saved);
      if (answer === true) return true;
      return Boolean(answer && typeof answer === 'object' && answer.RAG_SUPPORTED_LANGUAGES === next.RAG_SUPPORTED_LANGUAGES);
    } catch {
      return true;
    }
  }

  async save() {
    if (this.saving || !this.view || this.checked.size === 0) return;
    const ui = languagesUiLib();
    const body = languagesSaveBody(this.view.rows, [...this.checked], this.primary);
    this.saving = true;
    const restore = ui.ragUiButtonBusy(this.doc, this.saveButton, this.t('save.running'), [this.resetButton]);
    const boxes = this.rowElements().map((tr) => tr.querySelectorAll('input'));
    const inputs = boxes.flatMap((list) => Array.from(list)).map((input) => [input, input.disabled]);
    for (const [input] of inputs) input.disabled = true;
    let result = null;
    let proceed = false;
    try {
      proceed = await this.askGuard(body);
      if (proceed) result = await ui.ragUiFetchJson(LANGUAGES_ENDPOINT, { method: 'POST', body: JSON.stringify(body) });
    } finally {
      this.saving = false;
      restore();
      for (const [input, disabled] of inputs) input.disabled = disabled;
    }
    if (!proceed) {
      this.updateControls();
      return;
    }
    if (result.ok && result.body && result.body.success === true) {
      this.applySaved(result.body);
      return;
    }
    const details = result.body && Array.isArray(result.body.details) ? result.body.details : [];
    const items = result.status === 400 ? languagesErrorItems(details, this.view.rows) : [];
    if (items.length) {
      this.findings = [{ tone: 'error', items }];
      this.updateControls();
      const nodes = this.renderFindings();
      if (nodes[0]) nodes[0].focus();
      this.announce('');
      return;
    }
    this.updateControls();
    this.announce(ui.ragUiMapError(result, this.locale, { unavailable: this.t('list.unavailable') }).message, true);
  }

  applySaved(answer) {
    const codes = new Set(this.view.rows.map((r) => r.code));
    const languages = (Array.isArray(answer.languages) ? answer.languages : []).filter((c) => codes.has(c));
    const primary = typeof answer.primary === 'string' && codes.has(answer.primary) ? answer.primary : null;
    const values = { RAG_SUPPORTED_LANGUAGES: languages.join(','), RAG_PRIMARY_LANGUAGE: primary || '' };
    for (const [id, value] of Object.entries(values)) {
      const input = document.getElementById(id);
      if (input) input.value = value;
      if (typeof window !== 'undefined' && window.configManager && window.configManager.config) {
        window.configManager.config[id] = value;
      }
    }
    this.view = { ...this.view, configured: true, firstRun: false, banner: null, saved: { languages, primary } };
    this.checked = new Set(languages);
    this.primary = primary;
    this.verified = answer.verifiedAgainstActiveProfile === true;
    const warnings = languagesWarningItems(answer.warnings, this.view.rows);
    this.findings = warnings.length ? [{ tone: 'warning', items: warnings }] : [];
    languagesClearBanner();
    this.render();
    if (this.restartHost) this.restartHost.textContent = this.t('save.restart');
    this.announce(this.t('save.done'));
  }
}

let languagesPanelInstance = null;

function initLanguagesPanel() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rag-administration-languages');
  if (!root) return null;
  if (!languagesPanelInstance) {
    languagesPanelInstance = new LanguagesPanel(root);
    if (typeof window !== 'undefined') window.languagesPanel = languagesPanelInstance;
    return languagesPanelInstance.mount();
  }
  return languagesPanelInstance.refresh();
}

function languagesBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-languages-bound')) return;
    link.setAttribute('data-languages-bound', '1');
    link.addEventListener('click', () => initLanguagesPanel());
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initLanguagesPanel = initLanguagesPanel;
  window.languagesLabel = languagesLabel;
  window.languagesBuildView = languagesBuildView;
  window.languagesBannerForm = languagesBannerForm;
  languagesBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    languagesBindPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initLanguagesPanel();
    else languagesLoadBanner();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LANGUAGES_LABELS,
    languagesLabel,
    languagesBuildView,
    languagesBannerForm,
    languagesSaveBody,
    languagesInitialSelection,
    languagesNextPrimary,
    languagesNotes,
    languagesErrorItems,
    languagesWarningItems,
    LanguagesPanel,
    initLanguagesPanel,
  };
}
