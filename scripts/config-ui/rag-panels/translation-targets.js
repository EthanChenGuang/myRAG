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
    'targets.enable': 'Translate this workspace’s documents',
    'targets.legend': 'Translate into',
    'targets.needEnable': 'Turn on translation for this workspace to choose languages.',
    'targets.needOne': 'Choose at least one language to translate into.',
    'targets.unchanged': 'No changes to save.',
    'targets.deploymentOff':
      'Document translation is off for this deployment, so targets can’t be changed here. Turn on Document translation under Settings below and save all changes; targets can be chosen once the app runs with it on.',
    'targets.deploymentOffShort': 'Document translation is off for this deployment; turn it on under Settings below.',
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
    'targets.monolingual': 'This deployment supports one language, so there is nothing to translate into.',
    'targets.stale': 'The embedding profile changed, so stored translations are not used for search. Run {command} to use them again.',
    'coverage.staleBadge': 'Not used for search',
    'coverage.gaps': 'Some chunks were left untranslated because a name, number or code would not have stayed exactly as written. They are still found in their original language.',
    'backfill.help': 'Saving translates nothing by itself. New documents are translated after they are published; for existing ones run:',
    'backfill.dryRun': 'Report first, nothing is translated:',
    'backfill.run': 'Then translate, stopping at the budget you set in USD:',
    'command.dryRun': 'report',
    'command.run': 'translate',
    'command.reembed': 'reuse stored translations',
    'action.copy': 'Copy command',
    'action.copyAria': 'Copy command: {name}',
    'copy.done': 'Command copied.',
    'copy.failed': 'The command could not be copied. Select it and copy it by hand.',
    'settings.title': 'Settings',
    'settings.affectsStored': 'Changing this affects documents already stored; saving shows how many.',
    'RAG_DOC_TRANSLATION.label': 'Document translation',
    'RAG_DOC_TRANSLATION.help': 'Allows workspaces to store search-only translations of their chunks.',
    'RAG_DOC_TRANSLATION_MODEL.label': 'Translation model',
    'RAG_DOC_TRANSLATION_MODEL.help': 'Empty uses the query model.',
    'onOff.opt.off': 'Off',
    'onOff.opt.on': 'On',
    'warn.needsLanguages': 'This setting has no effect until the supported languages are chosen in the Languages panel.',
    'warn.monolingualTranslation': 'One language is supported, so document translation stays off.',
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
    'targets.deploymentOffShort': '此部署的文档翻译已关闭；请在下方“设置”中开启。',
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
    'targets.monolingual': '此部署只支持一种语言，因此没有可翻译的目标语言。',
    'targets.stale': 'Embedding 配置已更换，已保存的译文暂不用于检索。运行 {command} 后可恢复使用。',
    'coverage.staleBadge': '暂不用于检索',
    'coverage.gaps': '部分切块未翻译，因为其中的名称、数字或代码无法保持原样。这些切块仍可按原文语言被检索到。',
    'backfill.help': '保存本身不会触发翻译。新文档在发布后翻译；已有文档请运行：',
    'backfill.dryRun': '先查看报告，不会翻译任何内容：',
    'backfill.run': '然后执行翻译，达到你设定的美元预算时停止：',
    'command.dryRun': '报告',
    'command.run': '翻译',
    'command.reembed': '恢复使用已保存的译文',
    'action.copy': '复制命令',
    'action.copyAria': '复制命令：{name}',
    'copy.done': '命令已复制。',
    'copy.failed': '无法复制命令。请手动选择并复制。',
    'settings.title': '设置',
    'settings.affectsStored': '更改此项会影响已入库的文档；保存时会显示数量。',
    'RAG_DOC_TRANSLATION.label': '文档翻译',
    'RAG_DOC_TRANSLATION.help': '允许各工作区为切块保存仅用于检索的译文。',
    'RAG_DOC_TRANSLATION_MODEL.label': '翻译模型',
    'RAG_DOC_TRANSLATION_MODEL.help': '留空则使用查询模型。',
    'onOff.opt.off': '关闭',
    'onOff.opt.on': '开启',
    'warn.needsLanguages': '在“语言”面板中选择支持的语言之前，此设置不会生效。',
    'warn.monolingualTranslation': '只支持一种语言，因此文档翻译保持关闭。',
  },
  it: {
    'panel.title': 'Lingue di traduzione',
    'panel.description':
      'Salva una traduzione di ogni chunk solo per la ricerca, così una domanda in un’altra lingua può trovarlo. Risposte e citazioni usano sempre il testo originale. Segue lo spazio di lavoro scelto in Document Processing.',
    'panel.workspaceDefault': 'Spazio di lavoro predefinito',
    'targets.enable': 'Traduci i documenti di questo spazio di lavoro',
    'targets.legend': 'Traduci in',
    'targets.needEnable': 'Attiva la traduzione per questo spazio di lavoro per scegliere le lingue.',
    'targets.needOne': 'Scegli almeno una lingua di destinazione.',
    'targets.unchanged': 'Nessuna modifica da salvare.',
    'targets.deploymentOff':
      'La traduzione dei documenti è disattivata per questa installazione, quindi qui le lingue non si possono cambiare. Attiva Traduzione dei documenti in Impostazioni qui sotto e salva tutte le modifiche; potrai scegliere le lingue quando l’app sarà in esecuzione con la traduzione attiva.',
    'targets.deploymentOffShort': 'La traduzione dei documenti è disattivata per questa installazione; attivala in Impostazioni qui sotto.',
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
    'targets.monolingual': 'Questa installazione supporta una sola lingua, quindi non c’è nulla in cui tradurre.',
    'targets.stale': 'Il profilo di embedding è cambiato, quindi le traduzioni salvate non vengono usate nella ricerca. Esegui {command} per riutilizzarle.',
    'coverage.staleBadge': 'Non usate nella ricerca',
    'coverage.gaps': 'Alcuni chunk non sono stati tradotti perché un nome, un numero o un codice non sarebbe rimasto identico. Vengono comunque trovati nella lingua originale.',
    'backfill.help': 'Il salvataggio non traduce nulla. I nuovi documenti vengono tradotti dopo la pubblicazione; per quelli esistenti esegui:',
    'backfill.dryRun': 'Prima il resoconto, senza tradurre nulla:',
    'backfill.run': 'Poi traduci, fermandoti al budget in USD che imposti:',
    'command.dryRun': 'resoconto',
    'command.run': 'traduzione',
    'command.reembed': 'riuso delle traduzioni salvate',
    'action.copy': 'Copia il comando',
    'action.copyAria': 'Copia il comando: {name}',
    'copy.done': 'Comando copiato.',
    'copy.failed': 'Non è stato possibile copiare il comando. Selezionalo e copialo a mano.',
    'settings.title': 'Impostazioni',
    'settings.affectsStored': 'La modifica riguarda i documenti già archiviati; al salvataggio vedrai quanti.',
    'RAG_DOC_TRANSLATION.label': 'Traduzione dei documenti',
    'RAG_DOC_TRANSLATION.help': 'Permette agli spazi di lavoro di salvare traduzioni dei chunk solo per la ricerca.',
    'RAG_DOC_TRANSLATION_MODEL.label': 'Modello di traduzione',
    'RAG_DOC_TRANSLATION_MODEL.help': 'Vuoto usa il modello delle query.',
    'onOff.opt.off': 'Disattivato',
    'onOff.opt.on': 'Attivo',
    'warn.needsLanguages': 'Questa impostazione non ha effetto finché non scegli le lingue supportate nel pannello Lingue.',
    'warn.monolingualTranslation': 'È supportata una sola lingua, quindi la traduzione dei documenti resta disattivata.',
  },
};

const TRANSLATION_TARGETS_PATH = '/api/rag/admin/translation-settings';
const TRANSLATION_TARGETS_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const TRANSLATION_TARGETS_ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSLATION_TARGETS_SETTINGS = ['RAG_DOC_TRANSLATION', 'RAG_SUPPORTED_LANGUAGES'];

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

/** Combination warnings of the translation group, read from the page's own inputs (UI-SPEC 6.3). */
function translationTargetsSettingsWarnings(values) {
  const v = values || {};
  if (translationTargetsText(v.RAG_DOC_TRANSLATION).trim() !== 'on') return [];
  const languages = translationTargetsText(v.RAG_SUPPORTED_LANGUAGES)
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
  if (languages.length === 0) return ['warn.needsLanguages'];
  if (languages.length === 1) return ['warn.monolingualTranslation'];
  return [];
}

/**
 * The --tenant value of the commands: o:<id> for an organization workspace; for the default workspace s:default in single-tenant mode
 * and a placeholder in multi-tenant mode (the personal workspace's key holds a user id the page does not know).
 */
function translationTargetsTenantKey(organizationId, multiTenant) {
  if (organizationId) return TRANSLATION_TARGETS_ORG_ID.test(organizationId) ? 'o:' + organizationId.toLowerCase() : 'o:<organization-id>';
  return multiTenant ? 'u:<user-id>' : 's:default';
}

/** D-29 commands; the dry run comes first. Saving never runs one. */
function translationTargetsCommands(tenantKey) {
  const base = 'npm run rag:translate -- --tenant ' + tenantKey;
  return { dryRun: base + ' --dry-run', run: base + ' --budget <USD>', reembed: base + ' --reembed --budget <USD>' };
}

function translationTargetsIsMultiTenant() {
  const config = typeof window !== 'undefined' && window.currentConfig && typeof window.currentConfig === 'object' ? window.currentConfig : {};
  return (config.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE || config.MYRAG_DEPLOYMENT_MODE) === 'multi-tenant';
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
    this.backfillHost = null;
    this.settingsHost = null;
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
    this.coverageHost = this.el('div', { className: 'min-w-0 mt-6 empty:mt-0' });
    this.backfillHost = this.el('div', { className: 'min-w-0 mt-4 empty:mt-0' });
    this.settingsHost = this.el('div', { className: 'min-w-0 mt-8 border-t border-base-300 pt-6' }, [
      this.el('h4', { className: 'text-base font-semibold mb-4 text-balance', text: this.t('settings.title') }),
    ]);
    const group = this.doc.querySelector('[data-rag-settings-group="translation"]');
    if (group) {
      this.settingsHost.appendChild(group);
      this.localizeSettings(group);
    }
    const content = this.root.querySelector('[data-translation-targets-content]');
    if (content) content.replaceChildren(this.formHost, this.coverageHost, this.backfillHost, this.settingsHost);
    for (const id of TRANSLATION_TARGETS_SETTINGS) {
      const control = this.doc.getElementById(id);
      if (control) control.addEventListener('change', () => this.renderAlerts());
    }
    this.bindWorkspace();
    this.renderAlerts();
    await this.load('first');
  }

  async refresh() {
    this.readWorkspace();
    await this.load('panel');
  }

  /** zh and it through data-rag-i18n; English is the static markup (UI-SPEC 6.3). */
  localizeSettings(group) {
    if (this.locale === 'en') return;
    const table = TRANSLATION_TARGETS_LABELS[this.locale] || {};
    for (const node of Array.from(group.querySelectorAll('[data-rag-i18n]'))) {
      const text = table[node.getAttribute('data-rag-i18n')];
      if (text !== undefined) node.textContent = text;
    }
  }

  controlValue(id) {
    const control = this.doc.getElementById(id);
    return control ? translationTargetsText(control.value) : '';
  }

  commands() {
    return translationTargetsCommands(translationTargetsTenantKey(this.organizationId, translationTargetsIsMultiTenant()));
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
      this.backfillHost.replaceChildren();
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
      this.backfillHost.replaceChildren();
    } else {
      if (hadContent) ui.ragUiListBusy(this.formHost, true, true);
      else {
        this.formHost.replaceChildren();
        this.coverageHost.replaceChildren();
        this.backfillHost.replaceChildren();
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
    const values = {};
    for (const id of TRANSLATION_TARGETS_SETTINGS) values[id] = this.controlValue(id);
    const nodes = translationTargetsSettingsWarnings(values).map((key) => ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', body: [this.t(key)] }));
    const view = this.view;
    if (view && !view.languagesConfigured) {
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [ui.ragUiLabel('error.languagesNotConfigured', this.locale)] }));
    } else if (view && !view.deploymentOn) {
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('targets.deploymentOff')] }));
    }
    if (view && view.languagesConfigured && !view.monolingual && view.stale === true) {
      const command = this.commands().reembed;
      nodes.push(
        ui.ragUiAlert(this.doc, {
          tone: 'warning',
          icon: 'exclamation-triangle',
          body: [this.el('p', { className: 'text-sm' }, ui.ragUiTemplateNodes(this.doc, this.t('targets.stale'), { command }, ['command']))],
          actions: [this.copyButton(command, 'command.reembed')],
        }),
      );
    }
    if (this.loadAlert) nodes.push(this.loadAlert);
    host.replaceChildren(...nodes);
  }

  render() {
    this.renderAlerts();
    this.renderForm();
    this.renderCoverage();
    this.renderBackfill();
  }

  renderForm() {
    const view = this.view;
    const ui = this.ui();
    this.controls = null;
    if (!view || !view.languagesConfigured) {
      this.formHost.replaceChildren();
      return;
    }
    if (view.monolingual) {
      this.formHost.replaceChildren(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('targets.monolingual')] }));
      return;
    }
    const enable = this.el('input', {
      className: 'checkbox checkbox-sm',
      id: 'rag-translation-targets-enabled',
      attrs: { type: 'checkbox', name: 'rag-translation-targets-enabled', autocomplete: 'off', 'data-translation-targets-enabled': '' },
    });
    enable.checked = this.draft.enabled;
    enable.addEventListener('change', () => {
      this.draft.enabled = Boolean(enable.checked);
      this.clearFieldError();
      this.update();
    });
    const enableRow = this.el('label', { className: 'label cursor-pointer justify-start gap-3 w-fit min-h-11 md:min-h-8', attrs: { for: 'rag-translation-targets-enabled' } }, [
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
        attrs: { type: 'checkbox', name: 'rag-translation-targets-target', value: language.code, autocomplete: 'off', 'data-translation-targets-target': language.code },
      });
      box.checked = this.draft.targets.has(language.code);
      box.addEventListener('change', () => {
        if (box.checked) this.draft.targets.add(language.code);
        else this.draft.targets.delete(language.code);
        this.clearFieldError();
        this.update();
      });
      boxes.push(box);
      return this.el('label', { className: 'label cursor-pointer justify-start gap-2 min-h-11 md:min-h-8 py-1', attrs: { for: id } }, [
        box,
        this.el('span', { className: 'label-text', text: language.name, attrs: { lang: language.code } }),
        ' ',
        this.el('code', { className: 'font-mono text-xs text-base-content/70', text: language.code, attrs: { translate: 'no' } }),
      ]);
    });
    const needEnable = this.el('p', { className: 'text-sm text-base-content/70 mt-1', id: needEnableId, text: this.t('targets.needEnable') });
    const error = this.el('p', { className: 'text-sm text-error mt-1', id: errorId });
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
      className: 'btn btn-primary md:btn-sm',
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
    if (!this.view.deploymentOn) return this.t('targets.deploymentOffShort');
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

  focusFirstTarget() {
    const box = this.controls && this.controls.boxes.find((b) => !b.disabled);
    if (box && typeof box.focus === 'function') box.focus();
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
    if (this.fieldError) this.focusFirstTarget();
    this.announce(message, true);
  }

  renderCoverage() {
    const view = this.view;
    if (!view || !view.languagesConfigured || view.monolingual) {
      this.coverageHost.replaceChildren();
      return;
    }
    if (view.coverage.length === 0) {
      this.coverageHost.replaceChildren(this.el('p', { className: 'text-sm text-base-content/70', text: this.t('coverage.none') }));
      return;
    }
    const ui = this.ui();
    const th = (text) => this.el('th', { className: 'font-semibold whitespace-normal align-bottom', text, attrs: { scope: 'col' } });
    const rows = view.coverage.map((row) =>
      this.el('tr', {}, [
        this.el('td', {}, [
          this.el('div', { className: 'flex flex-wrap items-center gap-2' }, [
            this.el('span', { text: row.name, attrs: { lang: row.language } }),
            view.stale === true ? this.staleBadge() : null,
          ]),
        ]),
        this.el('td', {
          className: 'tabular-nums',
          text: this.t('coverage.value', { done: ui.ragUiFormatNumber(row.done, this.locale), total: ui.ragUiFormatNumber(row.total, this.locale) }),
        }),
        this.el('td', { className: 'tabular-nums' }, [row.gaps === null ? this.missing('gaps.none') : ui.ragUiFormatNumber(row.gaps, this.locale)]),
      ]),
    );
    const table = this.el('table', { className: 'table table-sm w-auto max-w-full' }, [
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
    const nodes = [region];
    if (view.coverage.some((row) => row.gaps !== null && row.gaps > 0)) {
      nodes.push(this.el('p', { className: 'text-sm text-base-content/70 mt-2 max-w-prose', text: this.t('coverage.gaps') }));
    }
    this.coverageHost.replaceChildren(...nodes);
  }

  staleBadge() {
    const ui = this.ui();
    return this.el('span', { className: 'badge badge-sm badge-outline border-warning text-base-content gap-1 shrink-0 whitespace-nowrap' }, [
      ui.ragUiIcon(this.doc, 'exclamation-triangle', 'text-warning'),
      this.el('span', { text: this.t('coverage.staleBadge') }),
    ]);
  }

  /** backfill.help and the two commands, the dry run first; shown once a target is saved. */
  renderBackfill() {
    const view = this.view;
    if (!view || !view.languagesConfigured || view.monolingual || view.targets.length === 0) {
      this.backfillHost.replaceChildren();
      return;
    }
    const commands = this.commands();
    this.backfillHost.replaceChildren(
      this.el('div', { className: 'flex flex-col gap-2 min-w-0' }, [
        this.el('p', { className: 'text-sm max-w-prose', text: this.t('backfill.help') }),
        this.commandLine('backfill.dryRun', commands.dryRun, 'command.dryRun'),
        this.commandLine('backfill.run', commands.run, 'command.run'),
      ]),
    );
  }

  commandLine(labelKey, command, nameKey) {
    return this.el('div', { className: 'flex flex-col gap-1 min-w-0' }, [
      this.el('p', { className: 'text-xs text-base-content/70', text: this.t(labelKey) }),
      this.el('div', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [
        this.el('code', { className: 'font-mono text-xs break-all min-w-0 bg-base-100 rounded px-2 py-1', text: command, attrs: { translate: 'no' } }),
        this.copyButton(command, nameKey),
      ]),
    ]);
  }

  /** Copy command, only where the clipboard exists; the command stays selectable text either way. */
  copyButton(command, nameKey) {
    const clipboard = typeof navigator !== 'undefined' && navigator ? navigator.clipboard : null;
    if (!clipboard || typeof clipboard.writeText !== 'function') return null;
    const button = this.el('button', {
      className: 'btn btn-ghost md:btn-sm',
      text: this.t('action.copy'),
      attrs: { type: 'button', 'aria-label': this.t('action.copyAria', { name: this.t(nameKey) }) },
    });
    button.addEventListener('click', async () => {
      try {
        await clipboard.writeText(command);
        this.announce(this.t('copy.done'));
      } catch {
        this.announce(this.t('copy.failed'), true);
      }
    });
    return button;
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
    translationTargetsSettingsWarnings,
    translationTargetsTenantKey,
    translationTargetsCommands,
    TranslationTargetsPanel,
    initTranslationTargetsPanel,
  };
}
