/**
 * Translation targets panel (UI-SPEC 6.9, D-28 to D-31). A workspace admin chooses the languages its chunks are translated into
 * for search and sees the coverage per target. Saving stores the choice only; it never starts a translation run. No chunk text,
 * translation text, model name or cost figure is rendered. Every value goes through rag-ui.js helpers as text.
 */

const TRANSLATION_TARGETS_LABELS = {
  en: {
    'panel.title': 'Translation targets',
    'panel.description':
      'Stores a translation of each chunk for search only, so a question in another language can find it. Answers and citations always use the original text. Follows the workspace chosen under Document Processing.',
    'panel.workspaceDefault': 'Default workspace',
    'targets.enable': "Translate this workspace's documents",
    'targets.legend': 'Translate into',
    'targets.needEnable': 'Turn on translation for this workspace to choose languages.',
    'targets.needOne': 'Choose at least one language to translate into.',
    'targets.unchanged': 'No changes to save.',
    'targets.deploymentOff':
      "Document translation is off for this deployment, so targets can't be changed here. Turn on Document translation under Settings below and save all changes; targets can be chosen once the app runs with it on.",
    'targets.dataFlow': 'Chunk text is sent to the translation model set under Settings.',
    'targets.loading': 'Loading translation targets…',
    'targets.unavailable': 'Translation targets are unavailable right now. Select Reload panel in a moment.',
    'targets.loaded': 'Translation targets loaded.',
    'targets.saved': 'Translation targets saved.',
    'col.language': 'Language',
    'col.translated': 'Chunks translated',
    'col.gaps': 'Gaps',
    'coverage.label': 'Translation coverage',
    'coverage.value': '{done} of {total}',
    'coverage.none': 'No target languages are saved for this workspace yet.',
    'gaps.none': 'Not recorded yet',
    'action.saveTargets': 'Save targets',
    'action.saving': 'Saving targets…',
    'error.targetNotSupported': 'Not saved. {language} is not one of the supported languages.',
  },
  zh: {
    'panel.title': '翻译目标语言',
    'panel.description': '为每个切块保存一份仅用于检索的译文，让其他语言的提问也能找到它。回答和引用始终使用原文。跟随“文档处理”中选择的工作区。',
    'panel.workspaceDefault': '默认工作区',
    'targets.enable': '翻译此工作区的文档',
    'targets.legend': '翻译为',
    'targets.needEnable': '请先为此工作区开启翻译，再选择语言。',
    'targets.needOne': '请至少选择一种目标语言。',
    'targets.unchanged': '没有需要保存的更改。',
    'targets.deploymentOff': '此部署的文档翻译已关闭，因此这里无法更改目标语言。请在下方“设置”中开启文档翻译并保存所有更改；应用以开启状态运行后即可选择目标语言。',
    'targets.dataFlow': '切块文本会发送给“设置”中指定的翻译模型。',
    'targets.loading': '正在加载翻译目标语言…',
    'targets.unavailable': '暂时无法获取翻译目标语言。请稍后选择“重新加载面板”。',
    'targets.loaded': '翻译目标语言已加载。',
    'targets.saved': '翻译目标语言已保存。',
    'col.language': '语言',
    'col.translated': '已翻译的切块',
    'col.gaps': '缺口',
    'coverage.label': '翻译覆盖情况',
    'coverage.value': '{done} / {total}',
    'coverage.none': '此工作区尚未保存目标语言。',
    'gaps.none': '尚未记录',
    'action.saveTargets': '保存目标语言',
    'action.saving': '正在保存目标语言…',
    'error.targetNotSupported': '未保存。{language}不在支持的语言之内。',
  },
  it: {
    'panel.title': 'Lingue di traduzione',
    'panel.description':
      "Salva una traduzione di ogni chunk solo per la ricerca, così una domanda in un'altra lingua può trovarlo. Risposte e citazioni usano sempre il testo originale. Segue lo spazio di lavoro scelto in Document Processing.",
    'panel.workspaceDefault': 'Spazio di lavoro predefinito',
    'targets.enable': 'Traduci i documenti di questo spazio di lavoro',
    'targets.legend': 'Traduci in',
    'targets.needEnable': 'Attiva la traduzione per questo spazio di lavoro per scegliere le lingue.',
    'targets.needOne': 'Scegli almeno una lingua di destinazione.',
    'targets.unchanged': 'Nessuna modifica da salvare.',
    'targets.deploymentOff':
      "La traduzione dei documenti è disattivata per questa installazione, quindi qui le lingue non si possono cambiare. Attiva Traduzione dei documenti in Impostazioni qui sotto e salva tutte le modifiche; potrai scegliere le lingue quando l'app sarà in esecuzione con la traduzione attiva.",
    'targets.dataFlow': 'Il testo dei chunk viene inviato al modello di traduzione indicato in Impostazioni.',
    'targets.loading': 'Caricamento delle lingue di traduzione…',
    'targets.unavailable': 'Le lingue di traduzione non sono disponibili. Seleziona Ricarica pannello tra poco.',
    'targets.loaded': 'Lingue di traduzione caricate.',
    'targets.saved': 'Lingue di traduzione salvate.',
    'col.language': 'Lingua',
    'col.translated': 'Chunk tradotti',
    'col.gaps': 'Lacune',
    'coverage.label': 'Copertura della traduzione',
    'coverage.value': '{done} di {total}',
    'coverage.none': 'Per questo spazio di lavoro non è ancora salvata nessuna lingua di destinazione.',
    'gaps.none': 'Non ancora registrate',
    'action.saveTargets': 'Salva le lingue di traduzione',
    'action.saving': 'Salvataggio delle lingue…',
    'error.targetNotSupported': 'Non salvato. {language} non è tra le lingue supportate.',
  },
};

const TRANSLATION_TARGETS_PATH = '/api/rag/admin/translation-settings';
const TRANSLATION_TARGETS_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

let translationTargetsUi = null;
if (typeof require !== 'undefined') {
  try {
    translationTargetsUi = require('./rag-ui.js');
  } catch {
    translationTargetsUi = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function translationTargetsUiLib() {
  if (translationTargetsUi) return translationTargetsUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

function translationTargetsLabel(key, locale, vars) {
  const ui = translationTargetsUiLib();
  const text = ui.ragUiLookup(TRANSLATION_TARGETS_LABELS, key, locale, vars);
  return text === undefined ? ui.ragUiLabel(key, locale, vars) : text;
}

function translationTargetsText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function translationTargetsIsCode(value) {
  return typeof value === 'string' && value.length <= 32 && TRANSLATION_TARGETS_CODE.test(value);
}

/** A language's name in its own language (Intl), first letter in that language's upper case; the code when unknown. */
function translationTargetsLanguageName(code) {
  try {
    const display = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames([code], { type: 'language' }) : null;
    const name = display ? display.of(code) : null;
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
  return code;
}

function translationTargetsCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Pure view model of a GET or PUT translation-settings answer (UI-SPEC 8.1). Named fields only; codes outside the supported set are
 * dropped, and nothing else the answer may carry (model, tenant key, text) is copied.
 */
function translationTargetsView(body) {
  const b = body && typeof body === 'object' ? body : {};
  const supportedCodes = [];
  for (const code of Array.isArray(b.supportedLanguages) ? b.supportedLanguages : []) {
    if (translationTargetsIsCode(code) && !supportedCodes.includes(code)) supportedCodes.push(code);
  }
  const allowed = new Set(supportedCodes);
  const saved = new Set((Array.isArray(b.targets) ? b.targets : []).filter((code) => allowed.has(code)));
  const coverage = [];
  for (const row of Array.isArray(b.coverage) ? b.coverage : []) {
    if (!row || typeof row !== 'object' || !allowed.has(row.language) || coverage.some((c) => c.language === row.language)) continue;
    const gaps = row.gaps === null || row.gaps === undefined || !Number.isFinite(Number(row.gaps)) ? null : translationTargetsCount(row.gaps);
    coverage.push({
      language: row.language,
      name: translationTargetsLanguageName(row.language),
      done: translationTargetsCount(row.done),
      total: translationTargetsCount(row.total),
      gaps,
    });
  }
  return {
    enabled: b.enabled === true,
    targets: supportedCodes.filter((code) => saved.has(code)),
    supported: supportedCodes.map((code) => ({ code, name: translationTargetsLanguageName(code) })),
    languagesConfigured: b.languagesConfigured !== false,
    monolingual: b.monolingual === true,
    coverage,
    stale: b.stale === true ? true : b.stale === false ? false : null,
    deploymentOn: b.deploymentSwitch === 'on',
  };
}

class TranslationTargetsPanel {
  constructor(root) {
    this.root = root;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.locale = translationTargetsUiLib().ragUiBrowserLocale();
    this.organizationId = null;
    this.view = null;
    this.draft = null;
    this.seq = 0;
    this.loadAlert = null;
    this.fieldError = null;
    this.saving = false;
    this.formHost = null;
    this.coverageHost = null;
    this.controls = null;
  }

  t(key, vars) {
    return translationTargetsLabel(key, this.locale, vars);
  }

  ui() {
    return translationTargetsUiLib();
  }

  el(tag, options, children) {
    return this.ui().ragUiEl(this.doc, tag, options, children);
  }

  statusEl() {
    return this.root.querySelector('[data-translation-targets-status]');
  }

  announce(text, isError) {
    const host = this.statusEl();
    if (!host) return;
    host.classList.toggle('text-error', Boolean(isError));
    if (isError) host.replaceChildren(this.ui().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text }));
    else host.textContent = text;
  }

  query() {
    return this.organizationId ? '?' + new URLSearchParams({ organizationId: this.organizationId }).toString() : '';
  }

  async mount() {
    this.root.setAttribute('lang', this.locale);
    const title = this.root.querySelector('[data-translation-targets-title]');
    if (title) title.textContent = this.t('panel.title');
    const description = this.root.querySelector('[data-translation-targets-description]');
    if (description) description.textContent = this.t('panel.description');
    this.formHost = this.el('div', { className: 'flex flex-col gap-4 min-w-0' });
    this.coverageHost = this.el('div', { className: 'min-w-0 mt-6' });
    const content = this.root.querySelector('[data-translation-targets-content]');
    if (content) content.replaceChildren(this.formHost, this.coverageHost);
    this.bindWorkspace();
    this.renderAlerts();
    await this.load('first');
  }

  async refresh() {
    this.readWorkspace();
    await this.load('panel');
  }

  selector() {
    return this.doc.getElementById('workspace-selector');
  }

  workspaceName() {
    const selector = this.selector();
    if (!selector || !selector.value) return this.t('panel.workspaceDefault');
    const option = Array.from(selector.querySelectorAll('option')).find((o) => o.getAttribute('value') === selector.value);
    const name = option ? option.textContent.trim() : '';
    return name || this.t('panel.workspaceDefault');
  }

  readWorkspace() {
    const selector = this.selector();
    this.organizationId = selector && selector.value ? String(selector.value) : null;
    const line = this.root.querySelector('[data-translation-targets-workspace]');
    if (line) line.textContent = this.ui().ragUiLabel('panel.workspace', this.locale, { name: this.workspaceName() });
  }

  bindWorkspace() {
    const selector = this.selector();
    this.readWorkspace();
    if (!selector) return;
    selector.addEventListener('change', async () => {
      this.readWorkspace();
      this.view = null;
      this.draft = null;
      this.fieldError = null;
      await this.load('first');
    });
  }

  async load(source) {
    if (!this.formHost) return;
    const ui = this.ui();
    const seq = ++this.seq;
    const hadContent = Boolean(this.view);
    if (hadContent) ui.ragUiListBusy(this.formHost, true);
    else {
      this.coverageHost.replaceChildren();
      ui.ragUiListLoading(this.doc, this.formHost, this.t('targets.loading'));
    }
    const result = await ui.ragUiRagRequest(TRANSLATION_TARGETS_PATH + this.query(), { method: 'GET' });
    if (seq !== this.seq) return;
    ui.ragUiListBusy(this.formHost, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      this.applyView(translationTargetsView(result.body));
      if (source === 'panel') this.announce(this.t('targets.loaded'));
      return;
    }
    this.loadFailed(result, hadContent);
  }

  applyView(view) {
    this.view = view;
    this.draft = { enabled: view.enabled, targets: new Set(view.targets) };
    this.loadAlert = null;
    this.fieldError = null;
    this.render();
  }

  loadFailed(result, hadContent) {
    const ui = this.ui();
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('targets.unavailable') });
    const reload = () => this.refresh();
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.view = null;
      this.loadAlert = null;
      const alert =
        mapped.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, reload)
          : ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [mapped.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, reload)] });
      this.formHost.replaceChildren(alert);
      this.coverageHost.replaceChildren();
    } else {
      if (hadContent) ui.ragUiListBusy(this.formHost, true, true);
      else {
        this.formHost.replaceChildren();
        this.coverageHost.replaceChildren();
      }
      this.loadAlert = ui.ragUiUnavailableAlert(this.doc, this.locale, mapped.message, reload);
    }
    this.renderAlerts();
    this.announce(mapped.message, true);
  }

  renderAlerts() {
    const host = this.root.querySelector('[data-translation-targets-alert]');
    if (!host) return;
    const ui = this.ui();
    const nodes = [];
    const view = this.view;
    if (view && !view.languagesConfigured) {
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [ui.ragUiLabel('error.languagesNotConfigured', this.locale)] }));
    } else if (view && !view.deploymentOn) {
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('targets.deploymentOff')] }));
    }
    if (this.loadAlert) nodes.push(this.loadAlert);
    host.replaceChildren(...nodes);
  }

  render() {
    this.renderAlerts();
    this.renderForm();
    this.renderCoverage();
  }

  renderForm() {
    const view = this.view;
    const ui = this.ui();
    this.controls = null;
    if (!view || !view.languagesConfigured) {
      this.formHost.replaceChildren();
      return;
    }
    const enable = this.el('input', {
      className: 'checkbox checkbox-sm',
      id: 'rag-translation-targets-enabled',
      attrs: { type: 'checkbox', 'data-translation-targets-enabled': '' },
    });
    enable.checked = this.draft.enabled;
    enable.addEventListener('change', () => {
      this.draft.enabled = Boolean(enable.checked);
      this.clearFieldError();
      this.update();
    });
    const enableRow = this.el('label', { className: 'label cursor-pointer justify-start gap-3 w-fit', attrs: { for: 'rag-translation-targets-enabled' } }, [
      enable,
      this.el('span', { className: 'label-text', text: this.t('targets.enable') }),
    ]);

    const needEnableId = 'rag-translation-targets-need-enable';
    const errorId = 'rag-translation-targets-error';
    const boxes = [];
    const options = view.supported.map((language) => {
      const id = 'rag-translation-targets-target-' + language.code;
      const box = this.el('input', {
        className: 'checkbox checkbox-sm',
        id,
        attrs: { type: 'checkbox', value: language.code, 'data-translation-targets-target': language.code },
      });
      box.checked = this.draft.targets.has(language.code);
      box.addEventListener('change', () => {
        if (box.checked) this.draft.targets.add(language.code);
        else this.draft.targets.delete(language.code);
        this.clearFieldError();
        this.update();
      });
      boxes.push(box);
      return this.el('label', { className: 'label cursor-pointer justify-start gap-2 min-h-8 py-1', attrs: { for: id } }, [
        box,
        this.el('span', { className: 'label-text', text: language.name, attrs: { lang: language.code } }),
        ' ',
        this.el('code', { className: 'font-mono text-xs text-base-content/70', text: language.code, attrs: { translate: 'no' } }),
      ]);
    });
    const needEnable = this.el('p', { className: 'text-sm text-base-content/70 mt-1', id: needEnableId, text: this.t('targets.needEnable') });
    const error = this.el('p', { className: 'text-sm text-error mt-1', id: errorId, attrs: { role: 'alert' } });
    const fieldset = this.el('fieldset', { className: 'min-w-0', attrs: { 'aria-describedby': needEnableId + ' ' + errorId } }, [
      this.el('legend', { className: 'text-sm font-semibold mb-1', text: this.t('targets.legend') }),
      this.el('div', { className: 'flex flex-wrap gap-x-6 gap-y-1' }, options),
      needEnable,
      error,
    ]);

    const dataFlow = this.el('p', { className: 'text-sm flex items-start gap-2 max-w-prose' }, [
      ui.ragUiIcon(this.doc, 'info-circle', 'mt-0.5 shrink-0'),
      this.el('span', { text: this.t('targets.dataFlow') }),
    ]);

    const reasonId = 'rag-translation-targets-save-reason';
    const save = this.el('button', {
      className: 'btn btn-primary btn-sm',
      text: this.t('action.saveTargets'),
      attrs: { type: 'button', 'aria-describedby': reasonId },
    });
    save.addEventListener('click', () => this.save());
    const reason = this.el('p', { className: 'text-sm text-base-content/70', id: reasonId });
    const saveRow = this.el('div', { className: 'flex flex-wrap items-center gap-3' }, [save, reason]);

    this.controls = { enable, boxes, needEnable, error, fieldset, save, reason };
    this.formHost.replaceChildren(enableRow, fieldset, dataFlow, saveRow);
    this.update();
  }

  changed() {
    if (!this.view || !this.draft) return false;
    if (this.draft.enabled !== this.view.enabled) return true;
    if (this.draft.targets.size !== this.view.targets.length) return true;
    return this.view.targets.some((code) => !this.draft.targets.has(code));
  }

  saveBlockedReason() {
    if (!this.view) return null;
    if (!this.view.deploymentOn) return this.t('targets.deploymentOff');
    if (!this.changed()) return this.t('targets.unchanged');
    if (this.draft.enabled && this.draft.targets.size === 0) return this.t('targets.needOne');
    return null;
  }

  update() {
    const c = this.controls;
    if (!c) return;
    const locked = !this.view.deploymentOn || this.saving;
    c.enable.disabled = locked;
    for (const box of c.boxes) box.disabled = locked || !this.draft.enabled;
    c.needEnable.hidden = this.draft.enabled;
    c.error.textContent = this.fieldError || '';
    c.error.hidden = !this.fieldError;
    if (this.saving) return;
    const reason = this.saveBlockedReason();
    c.save.disabled = Boolean(reason);
    c.reason.textContent = reason || '';
  }

  clearFieldError() {
    this.fieldError = null;
  }

  orderedDraftTargets() {
    return this.view.supported.map((s) => s.code).filter((code) => this.draft.targets.has(code));
  }

  async save() {
    if (this.saving || !this.controls || this.saveBlockedReason()) return;
    const ui = this.ui();
    const body = { enabled: this.draft.enabled, targets: this.orderedDraftTargets() };
    if (this.organizationId) body.organizationId = this.organizationId;
    this.saving = true;
    this.fieldError = null;
    this.update();
    const restore = ui.ragUiButtonBusy(this.doc, this.controls.save, this.t('action.saving'));
    let result;
    try {
      result = await ui.ragUiRagRequest(TRANSLATION_TARGETS_PATH + this.query(), { method: 'PUT', body: JSON.stringify(body) });
    } finally {
      restore();
      this.saving = false;
    }
    if (result && result.ok) {
      await this.load('saved');
      this.announce(this.t('targets.saved'));
      return;
    }
    this.saveFailed(result, body.targets);
  }

  saveFailed(result, targets) {
    const ui = this.ui();
    const err = result && result.body && typeof result.body === 'object' && typeof result.body.error === 'string' ? result.body.error : '';
    let message;
    if (result && !result.thrown && result.status === 400 && err === 'target_not_supported') {
      const supported = new Set(this.view.supported.map((s) => s.code));
      const code = targets.find((c) => !supported.has(c)) || targets[0] || '';
      message = this.t('error.targetNotSupported', { language: code ? translationTargetsLanguageName(code) : '' });
      this.fieldError = message;
    } else {
      const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('targets.unavailable') });
      message = mapped.message;
      if (mapped.kind === 'invalid' && mapped.field === 'targets') this.fieldError = message;
    }
    this.update();
    this.announce(message, true);
  }

  renderCoverage() {
    const view = this.view;
    if (!view || !view.languagesConfigured) {
      this.coverageHost.replaceChildren();
      return;
    }
    if (view.coverage.length === 0) {
      this.coverageHost.replaceChildren(this.el('p', { className: 'text-sm text-base-content/70', text: this.t('coverage.none') }));
      return;
    }
    const ui = this.ui();
    const th = (text) => this.el('th', { className: 'font-semibold', text, attrs: { scope: 'col' } });
    const rows = view.coverage.map((row) =>
      this.el('tr', {}, [
        this.el('td', {}, [this.el('span', { text: row.name, attrs: { lang: row.language } })]),
        this.el('td', {
          className: 'tabular-nums whitespace-nowrap',
          text: this.t('coverage.value', { done: ui.ragUiFormatNumber(row.done, this.locale), total: ui.ragUiFormatNumber(row.total, this.locale) }),
        }),
        this.el('td', { className: 'tabular-nums' }, [row.gaps === null ? this.missing('gaps.none') : ui.ragUiFormatNumber(row.gaps, this.locale)]),
      ]),
    );
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('thead', {}, [this.el('tr', {}, [th(this.t('col.language')), th(this.t('col.translated')), th(this.t('col.gaps'))])]),
      this.el('tbody', {}, rows),
    ]);
    const region = this.el(
      'div',
      {
        className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('coverage.label') },
      },
      [table],
    );
    this.coverageHost.replaceChildren(region);
  }

  /** An em dash with a visually hidden word for a missing value. */
  missing(key) {
    return this.el('span', {}, [this.el('span', { text: '—', attrs: { 'aria-hidden': 'true' } }), this.el('span', { className: 'sr-only', text: this.t(key) })]);
  }
}

let translationTargetsPanelInstance = null;

function initTranslationTargetsPanel() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rag-administration-translation');
  if (!root) return null;
  if (!translationTargetsPanelInstance) {
    translationTargetsPanelInstance = new TranslationTargetsPanel(root);
    if (typeof window !== 'undefined') window.translationTargetsPanel = translationTargetsPanelInstance;
    return translationTargetsPanelInstance.mount();
  }
  return translationTargetsPanelInstance.refresh();
}

function translationTargetsBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-translation-targets-bound')) return;
    link.setAttribute('data-translation-targets-bound', '1');
    link.addEventListener('click', () => initTranslationTargetsPanel());
  });
}

if (typeof window !== 'undefined') {
  window.TRANSLATION_TARGETS_LABELS = TRANSLATION_TARGETS_LABELS;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initTranslationTargetsPanel = initTranslationTargetsPanel;
  translationTargetsBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    translationTargetsBindPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initTranslationTargetsPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TRANSLATION_TARGETS_LABELS,
    TRANSLATION_TARGETS_PATH,
    translationTargetsLabel,
    translationTargetsLanguageName,
    translationTargetsView,
    TranslationTargetsPanel,
    initTranslationTargetsPanel,
  };
}
