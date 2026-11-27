/**
 * Glossary view of the Terminology panel (06.2 UI-SPEC 6.2): translation pairs of the selected dictionary layer, their
 * form, delete and the glossary additions to the panel's import flow. Plain-text DOM only (rag-ui.js builder); every
 * change event of a field here stops before the page-wide config writer. A target language is never guessed (D-36).
 */

const GLOSSARY_LABELS = {
  en: {
    'tab.glossary': 'Glossary',
    'view.description': 'Each entry fixes how a term is translated. Query translation, document translation and query rewriting keep to it.',
    'view.loading': 'Loading the glossary…',
    'view.loaded': 'Glossary loaded. Entries: {count}.',
    'view.count': 'Entries: {count}',
    'view.unavailable': 'The glossary is unavailable right now. Select Reload panel in a moment.',
    'note.switchOff': 'The glossary is not enforced: the translation glossary switch is off in the settings. Entries saved now apply once it is on.',
    'action.openSettings': 'Open query layer settings',
    'note.monolingual': 'One language is supported, so there is nothing to translate between. The glossary needs at least two supported languages.',
    'filter.from': 'Source language',
    'filter.to': 'Target language',
    'filter.any': 'Any language',
    'filter.search': 'Search glossary',
    'action.clearFilters': 'Clear filters',
    'table.caption': 'Glossary entries: source terms and their required translation',
    'table.region': 'Glossary entries',
    'col.source': 'Source terms',
    'col.translation': 'Required translation',
    'col.state': 'State',
    'col.actions': 'Actions',
    'source.more': 'Other forms: {count}',
    'cell.none': 'None',
    'state.enabled': 'In use',
    'state.disabled': 'Turned off',
    'state.incomplete': 'Incomplete',
    'reason.incomplete': 'No target language, so this entry is not enforced.',
    'reason.targetNotSupported': '{language} is not a supported language now, so this entry is not enforced.',
    'action.add': 'Add glossary entry',
    'action.import': 'Import glossary CSV',
    'action.edit': 'Edit entry',
    'action.editAria': 'Edit entry: {term}',
    'action.setTarget': 'Set target language',
    'action.setTargetAria': 'Set target language: {term}',
    'action.delete': 'Delete entry',
    'action.deleteAria': 'Delete entry: {term}',
    'form.titleAdd': 'Add glossary entry',
    'form.titleEdit': 'Edit glossary entry',
    'form.legendSource': 'Source',
    'form.legendTranslation': 'Translation',
    'form.sourceLanguage': 'Source language',
    'form.sourceTerms': 'Source terms',
    'form.sourceTermsHelp': 'The term as it is written in the source language. Add other spellings or forms of the same term: up to 16, each up to 64 characters.',
    'form.targetLanguage': 'Target language',
    'form.translation': 'Required translation',
    'form.translationHelp': 'The one translation to use in the target language. Up to 64 characters.',
    'form.note': 'Note (optional)',
    'form.enabled': 'Use this entry',
    'form.chooseLanguage': 'Choose a language',
    'form.save': 'Save entry',
    'form.saving': 'Saving…',
    'form.close': 'Close form',
    'form.discardAsk': 'Discard what you typed?',
    'form.keepEditing': 'Keep editing',
    'form.discard': 'Discard changes',
    'save.done': 'Saved: {term}.',
    'warn.overrides': 'Saved. This workspace entry replaces a shared entry for {term}.',
    'error.needTerm': 'Enter at least one source term.',
    'error.needTranslation': 'Enter the required translation.',
    'error.needTarget': 'Choose a target language.',
    'error.sameLanguage': 'Choose a target language different from the source language.',
    'error.tooLong': 'Up to {max} characters. This has {count}.',
    'error.tooMany': 'Up to 16 source terms. This entry has {count}.',
    'error.versionConflict': 'This dictionary changed since you loaded it. Reload the entries; what you typed stays in the form.',
    'action.reloadEntries': 'Reload entries',
    'error.layerFull': 'This dictionary layer has reached its entry limit. Delete entries before adding more.',
    'issue.conflict': '{term} already has a different required translation into {language} in this layer. Edit that entry, or remove the term here.',
    'issue.invalid_variant': '{term} is too short or contains no word that can be matched. Use the full term.',
    'issue.target_language_not_enabled': '{language} is not a supported language. Choose one of the supported languages.',
    'issue.other': 'The entry was not accepted. Code: {code}',
    'delete.title': 'Delete the glossary entry for {term}?',
    'delete.body': "The translation of {term} is no longer fixed. This can't be undone.",
    'delete.keep': 'Keep entry',
    'delete.confirm': 'Delete entry',
    'delete.running': 'Deleting…',
    'delete.done': 'Deleted: {term}.',
    'empty.title': 'No glossary entries',
    'empty.body': 'Add an entry when a term must always be translated the same way. Select Add glossary entry, or import a CSV file.',
    'empty.filtered': 'No entry matches these filters.',
    'import.format': 'A glossary row has the kind {kind} and a {column} column with the language code of the required translation.',
    'import.targetCol': 'Target language',
    'import.issue.target_required': 'A translation row needs a target_language value.',
    'import.replaceWarning': 'Replace covers the whole dictionary layer, not only the glossary. Entries of every kind that are missing from the file are deleted.',
  },
  zh: {
    'tab.glossary': '术语对照表',
    'view.description': '每个条目规定一个术语的固定译法。查询翻译、文档翻译和查询改写都会遵守。',
    'view.loading': '正在加载术语对照表…',
    'view.loaded': '术语对照表已加载。条目：{count}。',
    'view.count': '条目：{count}',
    'view.unavailable': '术语对照表暂时不可用。请稍后选择“重新加载面板”。',
    'note.switchOff': '术语对照表尚未生效：设置中的“翻译术语对照表”开关处于关闭状态。现在保存的条目会在开启后生效。',
    'action.openSettings': '打开查询层设置',
    'note.monolingual': '只支持一种语言，因此没有可以互译的语言。术语对照表至少需要两种支持的语言。',
    'filter.from': '源语言',
    'filter.to': '目标语言',
    'filter.any': '任意语言',
    'filter.search': '搜索术语对照表',
    'action.clearFilters': '清除筛选',
    'table.caption': '术语对照表条目：源术语及其规定译法',
    'table.region': '术语对照表条目',
    'col.source': '源术语',
    'col.translation': '规定译法',
    'col.state': '状态',
    'col.actions': '操作',
    'source.more': '其他写法：{count}',
    'cell.none': '无',
    'state.enabled': '使用中',
    'state.disabled': '已停用',
    'state.incomplete': '不完整',
    'reason.incomplete': '没有目标语言，因此此条目不会生效。',
    'reason.targetNotSupported': '{language} 目前不是支持的语言，因此此条目不会生效。',
    'action.add': '添加对照条目',
    'action.import': '导入对照表 CSV',
    'action.edit': '编辑条目',
    'action.editAria': '编辑条目：{term}',
    'action.setTarget': '设置目标语言',
    'action.setTargetAria': '设置目标语言：{term}',
    'action.delete': '删除条目',
    'action.deleteAria': '删除条目：{term}',
    'form.titleAdd': '添加对照条目',
    'form.titleEdit': '编辑对照条目',
    'form.legendSource': '源',
    'form.legendTranslation': '译法',
    'form.sourceLanguage': '源语言',
    'form.sourceTerms': '源术语',
    'form.sourceTermsHelp': '按源语言中的实际写法填写术语。可以再加入同一术语的其他写法：最多 16 个，每个不超过 64 个字符。',
    'form.targetLanguage': '目标语言',
    'form.translation': '规定译法',
    'form.translationHelp': '在目标语言中唯一使用的译法。不超过 64 个字符。',
    'form.note': '备注（可选）',
    'form.enabled': '使用此条目',
    'form.chooseLanguage': '选择一种语言',
    'form.save': '保存条目',
    'form.saving': '正在保存…',
    'form.close': '关闭表单',
    'form.discardAsk': '要放弃已输入的内容吗？',
    'form.keepEditing': '继续编辑',
    'form.discard': '放弃更改',
    'save.done': '已保存：{term}。',
    'warn.overrides': '已保存。此工作区条目取代了 {term} 的共享条目。',
    'error.needTerm': '请至少填写一个源术语。',
    'error.needTranslation': '请填写规定译法。',
    'error.needTarget': '请选择目标语言。',
    'error.sameLanguage': '请选择与源语言不同的目标语言。',
    'error.tooLong': '不超过 {max} 个字符。当前为 {count} 个。',
    'error.tooMany': '最多 16 个源术语。此条目有 {count} 个。',
    'error.versionConflict': '自你加载以来，词典已被更改。请重新加载条目；你输入的内容会保留在表单中。',
    'action.reloadEntries': '重新加载条目',
    'error.layerFull': '此词典层级的条目数已达上限。请先删除条目再添加。',
    'issue.conflict': '在此层级中，{term} 已有另一个译为{language}的规定译法。请编辑那个条目，或在这里移除该术语。',
    'issue.invalid_variant': '{term} 太短，或不包含可匹配的词。请使用完整术语。',
    'issue.target_language_not_enabled': '{language} 不是支持的语言。请选择一种支持的语言。',
    'issue.other': '条目未被接受。代码：{code}',
    'delete.title': '删除 {term} 的对照条目？',
    'delete.body': '{term} 的译法将不再固定。此操作无法撤销。',
    'delete.keep': '保留条目',
    'delete.confirm': '删除条目',
    'delete.running': '正在删除…',
    'delete.done': '已删除：{term}。',
    'empty.title': '还没有对照条目',
    'empty.body': '当某个术语必须始终按同一译法翻译时，请添加条目。选择“添加对照条目”，或导入 CSV 文件。',
    'empty.filtered': '没有符合这些筛选条件的条目。',
    'import.format': '对照表的行使用 {kind} 类型，并在 {column} 列中填写规定译法的语言代码。',
    'import.targetCol': '目标语言',
    'import.issue.target_required': 'translation 类型的行需要填写 target_language。',
    'import.replaceWarning': '“替换”作用于整个词典层级，而不只是术语对照表。文件中没有的各类条目都会被删除。',
  },
  it: {
    'tab.glossary': 'Glossario',
    'view.description': 'Ogni voce stabilisce come si traduce un termine. La traduzione delle domande, la traduzione dei documenti e la riscrittura delle domande la rispettano.',
    'view.loading': 'Caricamento del glossario…',
    'view.loaded': 'Glossario caricato. Voci: {count}.',
    'view.count': 'Voci: {count}',
    'view.unavailable': 'Il glossario non è disponibile in questo momento. Seleziona Ricarica pannello tra poco.',
    'note.switchOff': "Il glossario non viene applicato: l'interruttore del glossario di traduzione è disattivato nelle impostazioni. Le voci salvate ora valgono da quando viene attivato.",
    'action.openSettings': 'Apri le impostazioni del livello di query',
    'note.monolingual': "È supportata una sola lingua, quindi non c'è nulla da tradurre. Il glossario richiede almeno due lingue supportate.",
    'filter.from': 'Lingua di origine',
    'filter.to': 'Lingua di destinazione',
    'filter.any': 'Qualsiasi lingua',
    'filter.search': 'Cerca nel glossario',
    'action.clearFilters': 'Rimuovi filtri',
    'table.caption': 'Voci del glossario: termini di origine e traduzione richiesta',
    'table.region': 'Voci del glossario',
    'col.source': 'Termini di origine',
    'col.translation': 'Traduzione richiesta',
    'col.state': 'Stato',
    'col.actions': 'Azioni',
    'source.more': 'Altre forme: {count}',
    'cell.none': 'Nessuna',
    'state.enabled': 'In uso',
    'state.disabled': 'Disattivata',
    'state.incomplete': 'Incompleta',
    'reason.incomplete': 'Manca la lingua di destinazione, quindi questa voce non viene applicata.',
    'reason.targetNotSupported': '{language} non è più una lingua supportata, quindi questa voce non viene applicata.',
    'action.add': 'Aggiungi voce al glossario',
    'action.import': 'Importa CSV del glossario',
    'action.edit': 'Modifica voce',
    'action.editAria': 'Modifica voce: {term}',
    'action.setTarget': 'Imposta lingua di destinazione',
    'action.setTargetAria': 'Imposta lingua di destinazione: {term}',
    'action.delete': 'Elimina voce',
    'action.deleteAria': 'Elimina voce: {term}',
    'form.titleAdd': 'Aggiungi voce al glossario',
    'form.titleEdit': 'Modifica voce del glossario',
    'form.legendSource': 'Origine',
    'form.legendTranslation': 'Traduzione',
    'form.sourceLanguage': 'Lingua di origine',
    'form.sourceTerms': 'Termini di origine',
    'form.sourceTermsHelp': 'Il termine come è scritto nella lingua di origine. Aggiungi altre grafie o forme dello stesso termine: fino a 16, ciascuna di 64 caratteri al massimo.',
    'form.targetLanguage': 'Lingua di destinazione',
    'form.translation': 'Traduzione richiesta',
    'form.translationHelp': "L'unica traduzione da usare nella lingua di destinazione. Fino a 64 caratteri.",
    'form.note': 'Nota (facoltativa)',
    'form.enabled': 'Usa questa voce',
    'form.chooseLanguage': 'Scegli una lingua',
    'form.save': 'Salva voce',
    'form.saving': 'Salvataggio…',
    'form.close': 'Chiudi modulo',
    'form.discardAsk': 'Vuoi scartare ciò che hai scritto?',
    'form.keepEditing': 'Continua a modificare',
    'form.discard': 'Scarta modifiche',
    'save.done': 'Salvata: {term}.',
    'warn.overrides': 'Salvata. Questa voce dello spazio di lavoro sostituisce una voce condivisa per {term}.',
    'error.needTerm': 'Inserisci almeno un termine di origine.',
    'error.needTranslation': 'Inserisci la traduzione richiesta.',
    'error.needTarget': 'Scegli una lingua di destinazione.',
    'error.sameLanguage': 'Scegli una lingua di destinazione diversa da quella di origine.',
    'error.tooLong': 'Fino a {max} caratteri. Questo ne ha {count}.',
    'error.tooMany': 'Fino a 16 termini di origine. Questa voce ne ha {count}.',
    'error.versionConflict': 'Il dizionario è cambiato da quando lo hai caricato. Ricarica le voci: ciò che hai scritto resta nel modulo.',
    'action.reloadEntries': 'Ricarica voci',
    'error.layerFull': 'Questo livello del dizionario ha raggiunto il limite di voci. Elimina delle voci prima di aggiungerne altre.',
    'issue.conflict': "{term} ha già un'altra traduzione richiesta in {language} in questo livello. Modifica quella voce, oppure togli il termine qui.",
    'issue.invalid_variant': '{term} è troppo breve o non contiene parole che si possano riconoscere. Usa il termine completo.',
    'issue.target_language_not_enabled': '{language} non è una lingua supportata. Scegline una tra quelle supportate.',
    'issue.other': 'La voce non è stata accettata. Codice: {code}',
    'delete.title': 'Eliminare la voce del glossario per {term}?',
    'delete.body': 'La traduzione di {term} non è più fissata. L\'operazione non può essere annullata.',
    'delete.keep': 'Mantieni voce',
    'delete.confirm': 'Elimina voce',
    'delete.running': 'Eliminazione…',
    'delete.done': 'Eliminata: {term}.',
    'empty.title': 'Nessuna voce nel glossario',
    'empty.body': 'Aggiungi una voce quando un termine va tradotto sempre allo stesso modo. Seleziona Aggiungi voce al glossario, oppure importa un file CSV.',
    'empty.filtered': 'Nessuna voce corrisponde a questi filtri.',
    'import.format': 'Una riga di glossario ha il tipo {kind} e una colonna {column} con il codice della lingua della traduzione richiesta.',
    'import.targetCol': 'Lingua di destinazione',
    'import.issue.target_required': 'Una riga di tipo translation richiede un valore in target_language.',
    'import.replaceWarning': 'Sostituisci riguarda l\'intero livello del dizionario, non solo il glossario. Le voci di ogni tipo che mancano nel file vengono eliminate.',
  },
};

const GLOSSARY_PAGE = 25;
const GLOSSARY_MAX_TERM = 64;
const GLOSSARY_MAX_TERMS = 16;
const GLOSSARY_MAX_NOTE = 500;
const GLOSSARY_SEARCH_DELAY_MS = 300;
const GLOSSARY_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const GLOSSARY_TARGET_CODES = { target_language_required: 'error.needTarget', target_language_same: 'error.sameLanguage', target_language_not_enabled: 'issue.target_language_not_enabled' };
const GLOSSARY_FIELDS = ['source_language', 'variants', 'target_language', 'canonical', 'note', 'enabled'];

let glossaryUi = null;
if (typeof require !== 'undefined') {
  try {
    glossaryUi = require('./rag-ui.js');
  } catch {
    glossaryUi = null;
  }
}

function glossaryUiLib() {
  if (glossaryUi) return glossaryUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

function glossaryLabel(key, locale, vars) {
  const ui = glossaryUiLib();
  const text = ui.ragUiLookup(GLOSSARY_LABELS, key, locale, vars);
  return text === undefined ? ui.ragUiLabel(key, locale, vars) : text;
}

function glossaryText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function glossaryIsCode(value) {
  return typeof value === 'string' && value.length <= 32 && GLOSSARY_CODE.test(value);
}

function glossaryCodes(list) {
  return Array.isArray(list) ? list.filter(glossaryIsCode) : [];
}

/** "{name in the UI language} ({code})" (UI-SPEC 6.2.1); the code alone when Intl has no name. */
function glossaryLanguageName(code, locale) {
  const text = glossaryText(code);
  if (!glossaryIsCode(text)) return text;
  let name = null;
  try {
    name = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames([locale || 'en'], { type: 'language' }).of(text) : null;
  } catch {
    name = null;
  }
  return name && name !== text ? name + ' (' + text + ')' : text;
}

/** One row as plain values: never a guessed target (D-36); the state follows the server's target and the enabled list. */
function glossaryRowView(item, enabled, locale) {
  const e = item && typeof item === 'object' ? item : {};
  const terms = Array.isArray(e.variants) ? e.variants.map(glossaryText).filter((v) => v !== '') : [];
  const source = glossaryIsCode(e.source_language) ? e.source_language : glossaryIsCode(e.language) ? e.language : '';
  const target = glossaryIsCode(e.target_language) ? e.target_language : '';
  let state = e.enabled === false ? 'disabled' : 'enabled';
  let reason = '';
  if (!target) {
    state = 'incomplete';
    reason = glossaryLabel('reason.incomplete', locale);
  } else if (!enabled.includes(target)) {
    state = 'incomplete';
    reason = glossaryLabel('reason.targetNotSupported', locale, { language: glossaryLanguageName(target, locale) });
  }
  return {
    id: glossaryText(e.id),
    term: terms[0] || glossaryText(e.canonical),
    more: Math.max(0, terms.length - 1),
    source,
    sourceName: source ? glossaryLanguageName(source, locale) : '',
    translation: glossaryText(e.canonical),
    target,
    targetName: target ? glossaryLanguageName(target, locale) : '',
    missingTarget: !target,
    state,
    reason,
  };
}

function glossaryEmptyDraft(enabled) {
  return { source_language: enabled[0] || '', variantsText: '', target_language: '', canonical: '', note: '', enabled: true };
}

/** Form values from an entry; a target that is no longer supported is left empty rather than replaced. */
function glossaryDraftFromEntry(item, enabled) {
  const e = item && typeof item === 'object' ? item : {};
  const source = glossaryIsCode(e.source_language) ? e.source_language : glossaryIsCode(e.language) ? e.language : '';
  const target = glossaryIsCode(e.target_language) && enabled.includes(e.target_language) ? e.target_language : '';
  return {
    source_language: enabled.includes(source) ? source : enabled[0] || '',
    variantsText: Array.isArray(e.variants) ? e.variants.map(glossaryText).join('\n') : '',
    target_language: target,
    canonical: glossaryText(e.canonical),
    note: glossaryText(e.note),
    enabled: e.enabled !== false,
  };
}

function glossaryTerms(text) {
  return glossaryText(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Client checks on submit (UI-SPEC 6.2.2): { field: message } in DOM order, never a blocked keystroke. */
function glossaryClientIssues(draft, locale) {
  const t = (key, vars) => glossaryLabel(key, locale, vars);
  const issues = {};
  const terms = glossaryTerms(draft.variantsText);
  const longest = terms.reduce((max, term) => Math.max(max, term.length), 0);
  if (!draft.source_language) issues.source_language = t('form.chooseLanguage');
  if (terms.length === 0) issues.variants = t('error.needTerm');
  else if (terms.length > GLOSSARY_MAX_TERMS) issues.variants = t('error.tooMany', { count: terms.length });
  else if (longest > GLOSSARY_MAX_TERM) issues.variants = t('error.tooLong', { max: GLOSSARY_MAX_TERM, count: longest });
  if (!draft.target_language) issues.target_language = t('error.needTarget');
  else if (draft.target_language === draft.source_language) issues.target_language = t('error.sameLanguage');
  const canonical = glossaryText(draft.canonical).trim();
  if (!canonical) issues.canonical = t('error.needTranslation');
  else if (canonical.length > GLOSSARY_MAX_TERM) issues.canonical = t('error.tooLong', { max: GLOSSARY_MAX_TERM, count: canonical.length });
  const note = glossaryText(draft.note).trim();
  if (note.length > GLOSSARY_MAX_NOTE) issues.note = t('error.tooLong', { max: GLOSSARY_MAX_NOTE, count: note.length });
  return issues;
}

/** The entry body: kind translation, one_way, the source as its language (D-15). */
function glossaryEntryBody(draft) {
  const note = glossaryText(draft.note).trim();
  return {
    canonical: glossaryText(draft.canonical).trim(),
    variants: glossaryTerms(draft.variantsText),
    kind: 'translation',
    language: draft.source_language,
    mode: 'one_way',
    source_language: draft.source_language,
    target_language: draft.target_language,
    enabled: draft.enabled !== false,
    note: note ? note : null,
  };
}

function glossaryBody(result) {
  return result && result.body && typeof result.body === 'object' ? result.body : {};
}

function glossaryIsVersionConflict(result) {
  return Boolean(result && !result.thrown && result.status === 409 && glossaryBody(result).error === 'version_conflict');
}

/** Stops a change event of a panel-local field before the page-wide config writer (UI-SPEC 6.1, finding 3). */
function glossaryStopChange(event) {
  if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
}

class GlossaryView {
  constructor(host, api) {
    this.host = host;
    this.api = api;
    this.doc = api.doc || (typeof document !== 'undefined' ? document : null);
    this.locale = api.locale || glossaryUiLib().ragUiBrowserLocale();
    this.filters = { from: '', to: '', search: '' };
    this.offset = 0;
    this.list = null;
    this.layerVersion = null;
    this.enabled = glossaryCodes(api.enabled ? api.enabled() : []);
    this.toolbarKey = null;
    this.seq = 0;
    this.searchTimer = null;
    this.form = null;
    this.hosts = {};
  }

  t(key, vars) {
    return glossaryLabel(key, this.locale, vars);
  }

  ui() {
    return glossaryUiLib();
  }

  el(tag, options, children) {
    return this.ui().ragUiEl(this.doc, tag, options, children);
  }

  btn(text, options, onClick) {
    const opts = options || {};
    const attrs = { type: 'button', ...(opts.attrs || {}) };
    const button = opts.icon
      ? this.el('button', { className: opts.className || 'btn md:btn-sm', attrs }, [this.ui().ragUiIcon(this.doc, opts.icon), this.el('span', { text })])
      : this.el('button', { className: opts.className || 'btn md:btn-sm', text, attrs });
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  announce(text, isError) {
    if (this.api.announce) this.api.announce(text, isError);
  }

  mount() {
    const view = this.el('div', { className: 'flex flex-col gap-4 min-w-0', attrs: { 'data-glossary-view': '', lang: this.locale } });
    view.addEventListener('change', glossaryStopChange);
    this.hosts.notes = this.el('div', { className: 'flex flex-col gap-2 min-w-0 empty:hidden' });
    this.hosts.alert = this.el('div', { className: 'flex flex-col gap-2 min-w-0 empty:hidden' });
    this.hosts.toolbar = this.el('div', { className: 'min-w-0' });
    this.hosts.results = this.el('div', { className: 'flex flex-col gap-2 min-w-0', attrs: { 'data-glossary-results': '' } });
    view.append(
      this.el('p', { className: 'text-sm text-base-content/70 max-w-prose', text: this.t('view.description') }),
      this.hosts.notes,
      this.hosts.alert,
      this.hosts.toolbar,
      this.hosts.results,
    );
    this.host.replaceChildren(view);
    this.view = view;
    this.bindUnload();
    return this.load();
  }

  /** Typed values in an open form ask before the page is left (web-design-guidelines: unsaved changes). */
  bindUnload() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    window.addEventListener('beforeunload', (event) => {
      if (!this.form || !this.form.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  refresh() {
    return this.load();
  }

  // --- Notes (UI-SPEC 6.2.1, 7.2)

  switchOff() {
    const box = this.doc.getElementById('RAG_TRANSLATION_GLOSSARY');
    return Boolean(box) && !box.checked;
  }

  openSettings() {
    const link = this.doc.querySelector('.menu-item[data-tab="rag-modes"]') || this.doc.querySelector('[data-tab="rag-modes"]');
    if (link && typeof link.click === 'function') link.click();
    const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const card = this.doc.getElementById('query-layer-card');
    if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    const box = this.doc.getElementById('RAG_TRANSLATION_GLOSSARY');
    if (box && typeof box.focus === 'function') box.focus({ preventScroll: true });
  }

  renderNotes() {
    const ui = this.ui();
    const nodes = [];
    if (this.switchOff()) {
      const open = this.btn(this.t('action.openSettings'), { className: 'btn btn-link btn-xs px-0 h-auto min-h-0' }, () => this.openSettings());
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('note.switchOff')], actions: [open] }));
    }
    if (this.enabled.length === 1) nodes.push(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('note.monolingual')] }));
    this.hosts.notes.replaceChildren(...nodes);
  }

  canWrite() {
    return this.enabled.length >= 2;
  }

  // --- Toolbar (built once per language set, so typing in the search keeps focus)

  languageSelect(id, labelKey, value) {
    const select = this.el('select', { className: 'select select-bordered select-sm w-full sm:w-auto max-w-full', id, attrs: { name: id } });
    select.appendChild(this.el('option', { text: this.t('filter.any'), attrs: { value: '' } }));
    for (const code of this.enabled) select.appendChild(this.el('option', { text: glossaryLanguageName(code, this.locale), attrs: { value: code, lang: null } }));
    select.value = this.enabled.includes(value) ? value : '';
    const wrap = this.el('div', { className: 'form-control min-w-0' }, [
      this.el('label', { className: 'label py-1', attrs: { for: id } }, [this.el('span', { className: 'label-text', text: this.t(labelKey) })]),
      select,
    ]);
    return { wrap, select };
  }

  renderToolbar() {
    const key = this.enabled.join(',') + '|' + this.canWrite();
    if (this.toolbarKey === key && this.hosts.toolbar.firstChild) return;
    this.toolbarKey = key;
    const from = this.languageSelect('rag-glossary-filter-from', 'filter.from', this.filters.from);
    const to = this.languageSelect('rag-glossary-filter-to', 'filter.to', this.filters.to);
    from.select.addEventListener('change', () => this.setFilter('from', from.select.value));
    to.select.addEventListener('change', () => this.setFilter('to', to.select.value));
    const searchId = 'rag-glossary-search';
    const search = this.el('input', {
      className: 'input input-bordered input-sm w-full sm:w-56',
      id: searchId,
      attrs: { type: 'search', name: searchId, autocomplete: 'off', spellcheck: 'false' },
    });
    search.value = this.filters.search;
    const runSearch = () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = null;
      const value = glossaryText(search.value).trim().slice(0, GLOSSARY_MAX_TERM);
      if (value === this.filters.search) return;
      this.filters.search = value;
      this.offset = 0;
      this.load();
    };
    search.addEventListener('input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(runSearch, GLOSSARY_SEARCH_DELAY_MS);
    });
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      runSearch();
    });
    this.hosts.search = search;
    this.hosts.from = from.select;
    this.hosts.to = to.select;
    const actions = [];
    if (this.canWrite()) {
      actions.push(this.btn(this.t('action.import'), { className: 'btn btn-outline btn-sm', icon: 'upload' }, () => this.api.openImport && this.api.openImport()));
      actions.push(this.btn(this.t('action.add'), { className: 'btn btn-primary btn-sm', icon: 'plus-lg' }, (event) => this.openForm('add', null, event.currentTarget)));
    }
    this.hosts.toolbar.replaceChildren(
      this.el('div', { className: 'flex flex-wrap items-end gap-2 min-w-0' }, [
        from.wrap,
        to.wrap,
        this.el('div', { className: 'form-control min-w-0 w-full sm:w-auto' }, [
          this.el('label', { className: 'label py-1', attrs: { for: searchId } }, [this.el('span', { className: 'label-text', text: this.t('filter.search') })]),
          search,
        ]),
        actions.length ? this.el('div', { className: 'flex flex-wrap gap-2 md:ml-auto' }, actions) : null,
      ]),
    );
  }

  setFilter(name, value) {
    if (this.filters[name] === value) return;
    this.filters[name] = value;
    this.offset = 0;
    this.load();
  }

  clearFilters() {
    this.filters = { from: '', to: '', search: '' };
    this.offset = 0;
    if (this.hosts.from) this.hosts.from.value = '';
    if (this.hosts.to) this.hosts.to.value = '';
    if (this.hosts.search) this.hosts.search.value = '';
    return this.load().then(() => {
      if (this.hosts.from && typeof this.hosts.from.focus === 'function') this.hosts.from.focus();
    });
  }

  filtered() {
    return Boolean(this.filters.from || this.filters.to || this.filters.search);
  }

  // --- Loading (UI-SPEC 7.1, 8.2)

  async load(options) {
    const ui = this.ui();
    const seq = ++this.seq;
    const hadContent = Boolean(this.list);
    if (hadContent) ui.ragUiListBusy(this.hosts.results, true);
    else ui.ragUiListLoading(this.doc, this.hosts.results, this.t('view.loading'));
    const result = await this.api.request('', {
      layer: this.api.layer(),
      kind: 'translation',
      source_language: this.filters.from,
      target_language: this.filters.to,
      search: this.filters.search,
      limit: GLOSSARY_PAGE,
      offset: this.offset,
    });
    if (seq !== this.seq) return;
    if (!(result && result.ok)) {
      this.failed(result, hadContent);
      return;
    }
    const body = glossaryBody(result);
    const enabled = glossaryCodes(body.enabled_languages);
    if (enabled.length) this.enabled = enabled;
    this.list = { items: Array.isArray(body.items) ? body.items : [], total: Number.isInteger(body.total) && body.total >= 0 ? body.total : null };
    this.layerVersion = Number.isInteger(body.layer_version) ? body.layer_version : null;
    this.hosts.alert.replaceChildren();
    ui.ragUiListBusy(this.hosts.results, false);
    this.renderNotes();
    this.renderToolbar();
    this.renderResults();
    if (!(options && options.quiet)) {
      const count = this.list.total === null ? this.list.items.length : this.list.total;
      this.announce(this.t('view.loaded', { count: ui.ragUiFormatNumber(count, this.locale) }));
    }
  }

  failed(result, hadContent) {
    const ui = this.ui();
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('view.unavailable') });
    const reload = () => this.load();
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.list = null;
      this.toolbarKey = null;
      this.hosts.toolbar.replaceChildren();
      this.hosts.results.replaceChildren();
      ui.ragUiListBusy(this.hosts.results, false);
      this.hosts.alert.replaceChildren(
        mapped.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, reload)
          : ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [mapped.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, reload)] }),
      );
    } else {
      const message = mapped.kind === 'network' || mapped.kind === 'unavailable' ? this.t('view.unavailable') : mapped.message;
      this.hosts.alert.replaceChildren(ui.ragUiUnavailableAlert(this.doc, this.locale, message, reload));
      if (hadContent) ui.ragUiListBusy(this.hosts.results, true, true);
      else this.hosts.results.replaceChildren();
    }
    this.announce(mapped.message, true);
  }

  // --- Table (UI-SPEC 6.2.1)

  renderResults() {
    const ui = this.ui();
    const items = this.list.items;
    const nodes = [];
    if (this.list.total !== null && items.length) {
      nodes.push(this.el('p', { className: 'text-xs text-base-content/70 tabular-nums', text: this.t('view.count', { count: ui.ragUiFormatNumber(this.list.total, this.locale) }) }));
    }
    if (items.length === 0) {
      if (this.filtered()) {
        nodes.push(
          this.el('div', { className: 'py-8 flex flex-col items-center gap-2 text-center' }, [
            this.el('p', { className: 'text-sm', text: this.t('empty.filtered') }),
            this.btn(this.t('action.clearFilters'), { className: 'btn btn-outline btn-sm' }, () => this.clearFilters()),
          ]),
        );
      } else {
        nodes.push(
          this.el('div', { className: 'py-8 flex flex-col items-center gap-1 text-center' }, [
            this.el('p', { className: 'text-base font-semibold text-balance', text: this.t('empty.title') }),
            this.el('p', { className: 'text-sm text-base-content/70 max-w-prose', text: this.t('empty.body') }),
          ]),
        );
      }
      this.hosts.results.replaceChildren(...nodes);
      return;
    }
    const th = (key, className) => this.el('th', { className: 'font-semibold align-bottom ' + (className || ''), text: this.t(key), attrs: { scope: 'col' } });
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('table.caption') }),
      this.el('thead', {}, [this.el('tr', {}, [th('col.source'), th('col.translation'), th('col.state'), th('col.actions')])]),
      this.el('tbody', {}, items.map((item) => this.renderRow(item))),
    ]);
    nodes.push(
      this.el(
        'div',
        { className: 'overflow-x-auto rounded bg-base-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('table.region') } },
        [table],
      ),
    );
    nodes.push(this.renderPager(items.length));
    this.hosts.results.replaceChildren(...nodes);
  }

  renderPager(count) {
    const ui = this.ui();
    const total = this.list.total === null ? this.offset + count : this.list.total;
    const from = this.offset + 1;
    const to = this.offset + count;
    const pager = this.el('div', { className: 'flex flex-col items-start gap-2' }, [
      this.el('span', {
        className: 'text-xs text-base-content/70 tabular-nums',
        text: this.api.label('list.range', { from: ui.ragUiFormatNumber(from, this.locale), to: ui.ragUiFormatNumber(to, this.locale), total: ui.ragUiFormatNumber(total, this.locale) }),
      }),
    ]);
    if (this.offset > 0 || to < total) {
      const prev = this.btn(this.api.label('action.previous'), { className: 'btn btn-ghost md:btn-sm' }, () => {
        this.offset = Math.max(0, this.offset - GLOSSARY_PAGE);
        this.load();
      });
      prev.disabled = this.offset === 0;
      const next = this.btn(this.api.label('action.next'), { className: 'btn btn-ghost md:btn-sm' }, () => {
        this.offset += GLOSSARY_PAGE;
        this.load();
      });
      next.disabled = to >= total;
      pager.appendChild(this.el('div', { className: 'flex flex-wrap gap-2' }, [prev, next]));
    }
    return pager;
  }

  termNode(text, lang, className) {
    const ui = this.ui();
    return this.el('span', { className: (className || 'text-sm') + ' break-words [overflow-wrap:anywhere]', text: ui.ragUiVisibleControls(text), attrs: { lang: glossaryIsCode(lang) ? lang : null, translate: 'no' } });
  }

  renderRow(item) {
    const ui = this.ui();
    const row = glossaryRowView(item, this.enabled, this.locale);
    const muted = 'block text-xs text-base-content/70 break-words';
    const sourceCell = this.el('th', { className: 'font-normal min-w-40 max-w-xs align-top', attrs: { scope: 'row' } }, [
      this.el('span', { className: 'block' }, [this.termNode(row.term, row.source)]),
      row.more ? this.el('span', { className: muted + ' tabular-nums', text: this.t('source.more', { count: ui.ragUiFormatNumber(row.more, this.locale) }) }) : null,
      row.sourceName ? this.el('span', { className: muted, text: row.sourceName }) : null,
    ]);
    const translationCell = this.el(
      'td',
      { className: 'min-w-40 max-w-xs align-top' },
      row.missingTarget
        ? [this.el('span', { className: 'text-sm text-base-content/70', text: this.t('cell.none') })]
        : [this.el('span', { className: 'block' }, [this.termNode(row.translation, row.target)]), this.el('span', { className: muted, text: row.targetName })],
    );
    const badge = {
      enabled: ['badge-success badge-outline', 'check-circle', 'state.enabled'],
      disabled: ['badge-ghost', 'dash-circle', 'state.disabled'],
      incomplete: ['badge-warning badge-outline', 'exclamation-triangle', 'state.incomplete'],
    }[row.state];
    const stateCell = this.el('td', { className: 'min-w-36 max-w-xs align-top' }, [
      this.el('span', { className: 'badge badge-sm gap-1 whitespace-nowrap ' + badge[0] }, [ui.ragUiIcon(this.doc, badge[1]), this.el('span', { text: this.t(badge[2]) })]),
      row.reason ? this.el('p', { className: 'text-xs mt-1 break-words', text: row.reason }) : null,
    ]);
    const actions = [];
    if (row.missingTarget) {
      actions.push(this.btn(this.t('action.setTarget'), { className: 'btn btn-outline md:btn-sm', attrs: { 'aria-label': this.t('action.setTargetAria', { term: row.term }), 'data-glossary-open': row.id } }, (event) => this.openForm('target', item, event.currentTarget)));
    } else {
      actions.push(this.btn(this.t('action.edit'), { className: 'btn btn-outline md:btn-sm', attrs: { 'aria-label': this.t('action.editAria', { term: row.term }), 'data-glossary-open': row.id } }, (event) => this.openForm('edit', item, event.currentTarget)));
    }
    actions.push(this.btn(this.t('action.delete'), { className: 'btn btn-outline btn-error md:btn-sm', attrs: { 'aria-label': this.t('action.deleteAria', { term: row.term }) } }, (event) => this.confirmDelete(row, event.currentTarget)));
    const actionsCell = this.el('td', { className: 'align-top' }, [this.el('div', { className: 'flex flex-col md:flex-row flex-wrap gap-1' }, actions)]);
    return this.el('tr', {}, [sourceCell, translationCell, stateCell, actionsCell]);
  }

  // --- Form (UI-SPEC 6.2.2)

  openForm(mode, item, opener) {
    if (this.form) return;
    const draft = mode === 'add' ? glossaryEmptyDraft(this.enabled) : glossaryDraftFromEntry(item, this.enabled);
    const row = item ? glossaryRowView(item, this.enabled, this.locale) : null;
    this.form = { mode, id: row ? row.id : null, draft, dirty: false, running: false, issues: {}, opener: opener || null };
    this.buildDialog();
    const focusField = mode === 'add' ? 'source_language' : mode === 'target' ? 'target_language' : 'canonical';
    this.form.dialog.showModal();
    this.focusField(focusField);
  }

  focusField(name) {
    const control = this.form && this.form.controls[name];
    if (control && typeof control.focus === 'function') control.focus();
  }

  buildDialog() {
    const f = this.form;
    const titleId = 'rag-glossary-form-title';
    const alertId = 'rag-glossary-form-alert';
    const dialog = this.el('dialog', { className: 'modal', attrs: { 'aria-labelledby': titleId, 'aria-describedby': alertId, 'data-glossary-dialog': '', lang: this.locale } });
    dialog.addEventListener('change', glossaryStopChange);
    f.dialog = dialog;
    f.controls = {};
    f.messages = {};
    f.alert = this.el('div', { className: 'flex flex-col gap-2 min-w-0 empty:hidden mb-4', id: alertId });
    const source = this.fieldset('form.legendSource', [this.languageField('source_language', 'form.sourceLanguage', false), this.textField('variants', 'form.sourceTerms', 'form.sourceTermsHelp', true)]);
    const translation = this.fieldset('form.legendTranslation', [this.languageField('target_language', 'form.targetLanguage', true), this.textField('canonical', 'form.translation', 'form.translationHelp', false)]);
    const extra = this.el('div', { className: 'flex flex-col gap-2 min-w-0 md:col-span-2' }, [this.textField('note', 'form.note', null, true), this.checkboxField()]);
    f.footer = this.el('div', { className: 'modal-action flex-wrap gap-2' });
    const box = this.el('div', { className: 'modal-box w-11/12 max-w-3xl min-w-0 overscroll-contain' }, [
      this.el('h3', { className: 'text-base font-semibold mb-4 break-words text-balance', id: titleId, text: this.t(f.mode === 'add' ? 'form.titleAdd' : 'form.titleEdit') }),
      f.alert,
      this.el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-6 min-w-0' }, [source, translation, extra]),
      f.footer,
    ]);
    const backdrop = this.el('form', { className: 'modal-backdrop', attrs: { method: 'dialog' } }, [this.el('button', { className: 'cursor-default', text: this.t('form.close'), attrs: { type: 'submit', tabindex: '-1' } })]);
    backdrop.addEventListener('submit', (event) => {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      this.requestClose();
    });
    dialog.addEventListener('cancel', (event) => {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      this.requestClose();
    });
    dialog.addEventListener('close', () => this.afterClose());
    dialog.append(box, backdrop);
    this.renderFooter(false);
    this.syncTargetOptions();
    this.syncLang();
    this.doc.body.appendChild(dialog);
  }

  fieldset(legendKey, children) {
    return this.el('fieldset', { className: 'flex flex-col gap-2 min-w-0' }, [this.el('legend', { className: 'text-sm font-semibold mb-1', text: this.t(legendKey) }), ...children]);
  }

  fieldIds(name) {
    const id = 'rag-glossary-field-' + name;
    return { id, help: id + '-help', message: id + '-message' };
  }

  describe(control, name, hasHelp) {
    const ids = this.fieldIds(name);
    const parts = [hasHelp ? ids.help : null, this.form.issues[name] ? ids.message : null].filter(Boolean);
    if (parts.length) control.setAttribute('aria-describedby', parts.join(' '));
    else control.removeAttribute('aria-describedby');
    if (this.form.issues[name]) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
    const line = this.form.messages[name];
    if (line) line.textContent = this.form.issues[name] || '';
  }

  messageLine(name) {
    const line = this.el('p', { className: 'text-xs text-error mt-1 break-words empty:hidden', id: this.fieldIds(name).message });
    this.form.messages[name] = line;
    return line;
  }

  languageField(name, labelKey, isTarget) {
    const ids = this.fieldIds(name);
    const select = this.el('select', { className: 'select select-bordered select-sm w-full', id: ids.id, attrs: { name: ids.id, 'data-glossary-field': name } });
    if (!isTarget) {
      for (const code of this.enabled) select.appendChild(this.el('option', { text: glossaryLanguageName(code, this.locale), attrs: { value: code } }));
      select.value = this.form.draft.source_language;
    }
    select.addEventListener('change', () => {
      this.form.draft[name] = select.value;
      this.form.dirty = true;
      if (!isTarget && this.form.draft.target_language === select.value) this.form.draft.target_language = '';
      if (!isTarget) this.syncTargetOptions();
      this.syncLang();
    });
    this.form.controls[name] = select;
    this.describe(select, name, false);
    return this.el('div', { className: 'form-control min-w-0' }, [
      this.el('label', { className: 'label py-1', attrs: { for: ids.id } }, [this.el('span', { className: 'label-text', text: this.t(labelKey) })]),
      select,
      this.messageLine(name),
    ]);
  }

  /** Target options: the supported languages, the selected source disabled; a cleared target shows the choose option. */
  syncTargetOptions() {
    const select = this.form.controls.target_language;
    if (!select) return;
    const options = [this.el('option', { text: this.t('form.chooseLanguage'), attrs: { value: '' } })];
    for (const code of this.enabled) {
      const option = this.el('option', { text: glossaryLanguageName(code, this.locale), attrs: { value: code, disabled: code === this.form.draft.source_language } });
      option.disabled = code === this.form.draft.source_language;
      options.push(option);
    }
    select.replaceChildren(...options);
    select.value = this.form.draft.target_language;
  }

  syncLang() {
    const c = this.form.controls;
    const set = (control, code) => {
      if (!control) return;
      if (glossaryIsCode(code)) control.setAttribute('lang', code);
      else control.removeAttribute('lang');
    };
    set(c.variants, this.form.draft.source_language);
    set(c.canonical, this.form.draft.target_language);
  }

  textField(name, labelKey, helpKey, multiline) {
    const ids = this.fieldIds(name);
    const key = name === 'variants' ? 'variantsText' : name;
    const term = name === 'variants' || name === 'canonical';
    const control = this.el(multiline ? 'textarea' : 'input', {
      className: multiline ? 'textarea textarea-bordered textarea-sm w-full' : 'input input-bordered input-sm w-full',
      id: ids.id,
      attrs: {
        type: multiline ? null : 'text',
        name: ids.id,
        rows: multiline ? (name === 'variants' ? '3' : '2') : null,
        autocomplete: 'off',
        spellcheck: term ? 'false' : null,
        translate: term ? 'no' : null,
        'data-glossary-field': name,
      },
    });
    control.value = this.form.draft[key];
    control.addEventListener('input', () => {
      this.form.draft[key] = control.value;
      this.form.dirty = true;
    });
    control.addEventListener('change', () => {
      this.form.draft[key] = control.value;
      this.form.dirty = true;
    });
    control.addEventListener('keydown', (event) => {
      const submit = multiline ? event.key === 'Enter' && (event.ctrlKey || event.metaKey) : event.key === 'Enter';
      if (!submit) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      this.save();
    });
    this.form.controls[name] = control;
    this.describe(control, name, Boolean(helpKey));
    return this.el('div', { className: 'form-control min-w-0' }, [
      this.el('label', { className: 'label py-1', attrs: { for: ids.id } }, [this.el('span', { className: 'label-text', text: this.t(labelKey) })]),
      control,
      helpKey ? this.el('p', { className: 'text-xs text-base-content/70 mt-1 max-w-prose', id: ids.help, text: this.t(helpKey) }) : null,
      this.messageLine(name),
    ]);
  }

  checkboxField() {
    const ids = this.fieldIds('enabled');
    const box = this.el('input', { className: 'checkbox checkbox-sm', id: ids.id, attrs: { type: 'checkbox', name: ids.id, 'data-glossary-field': 'enabled' } });
    box.checked = this.form.draft.enabled !== false;
    box.addEventListener('change', () => {
      this.form.draft.enabled = Boolean(box.checked);
      this.form.dirty = true;
    });
    this.form.controls.enabled = box;
    return this.el('label', { className: 'label cursor-pointer justify-start gap-2 w-fit min-h-11 md:min-h-8', attrs: { for: ids.id } }, [box, this.el('span', { className: 'label-text', text: this.t('form.enabled') })]);
  }

  renderFooter(asking) {
    const f = this.form;
    if (asking) {
      const keep = this.btn(this.t('form.keepEditing'), { className: 'btn btn-sm' }, () => this.renderFooter(false));
      const discard = this.btn(this.t('form.discard'), { className: 'btn btn-outline btn-sm' }, () => this.closeForm());
      f.footer.replaceChildren(this.el('p', { className: 'text-sm w-full md:w-auto md:mr-auto', text: this.t('form.discardAsk') }), keep, discard);
      f.asking = true;
      keep.focus();
      return;
    }
    const close = this.btn(this.t('form.close'), { className: 'btn btn-ghost btn-sm' }, () => this.requestClose());
    const save = this.btn(this.t('form.save'), { className: 'btn btn-primary btn-sm' }, () => this.save());
    f.closeButton = close;
    f.saveButton = save;
    f.footer.replaceChildren(close, save);
    if (f.asking) {
      f.asking = false;
      save.focus();
    }
  }

  requestClose() {
    const f = this.form;
    if (!f || f.running) return;
    if (f.dirty && !f.asking) this.renderFooter(true);
    else if (!f.dirty) this.closeForm();
  }

  closeForm(focusStatus) {
    const f = this.form;
    if (!f) return;
    f.focusStatus = Boolean(focusStatus);
    f.dialog.close();
  }

  afterClose() {
    const f = this.form;
    if (!f) return;
    this.form = null;
    f.dialog.remove();
    const status = this.api.status ? this.api.status() : null;
    const target = !f.focusStatus && f.opener && f.opener.isConnected !== false ? f.opener : this.reopenTarget(f.id) || status;
    if (target && typeof target.focus === 'function') target.focus();
  }

  reopenTarget(id) {
    if (!id || !this.view) return null;
    return this.view.querySelectorAll('[data-glossary-open]').find((b) => b.getAttribute('data-glossary-open') === id) || null;
  }

  setIssues(issues, alertNodes) {
    const f = this.form;
    f.issues = issues;
    for (const name of GLOSSARY_FIELDS) if (f.controls[name]) this.describe(f.controls[name], name, name === 'variants' || name === 'canonical');
    f.alert.replaceChildren(...(alertNodes || []));
  }

  focusFirstIssue() {
    const f = this.form;
    const first = GLOSSARY_FIELDS.find((name) => f.issues[name]);
    if (first) this.focusField(first);
    else {
      const alert = f.alert.querySelector('[role="alert"]') || f.alert.firstChild;
      if (alert && typeof alert.focus === 'function') alert.focus();
    }
  }

  alertNode(tone, body, actions) {
    const node = this.ui().ragUiAlert(this.doc, { tone, icon: tone === 'warning' ? 'arrow-repeat' : 'exclamation-circle', body, role: 'alert', actions });
    node.setAttribute('tabindex', '-1');
    return node;
  }

  /** 422 issues and 400 codes (UI-SPEC 8.2): at their field, or in the alert above the fields with the code in font-mono. */
  serverIssues(result) {
    const ui = this.ui();
    const body = glossaryBody(result);
    const draft = this.form.draft;
    const term = glossaryTerms(draft.variantsText)[0] || glossaryText(draft.canonical);
    const language = glossaryLanguageName(draft.target_language, this.locale);
    const issues = {};
    const alerts = [];
    const place = (field, text) => {
      issues[field] = issues[field] ? issues[field] + ' ' + text : text;
    };
    const codeFor = (code) => {
      if (code === 'conflict') place('variants', this.t('issue.conflict', { term, language }));
      else if (code === 'invalid_variant') place('variants', this.t('issue.invalid_variant', { term }));
      else if (Object.prototype.hasOwnProperty.call(GLOSSARY_TARGET_CODES, code)) place('target_language', this.t(GLOSSARY_TARGET_CODES[code], { language }));
      else return false;
      return true;
    };
    if (result.status === 422) {
      const list = Array.isArray(body.issues) ? body.issues : [];
      for (const issue of list) {
        if (!issue || typeof issue !== 'object' || issue.severity === 'warning') continue;
        const code = glossaryText(issue.code);
        if (!codeFor(code)) alerts.push(this.alertNode('error', [this.el('p', { className: 'text-sm' }, ui.ragUiTemplateNodes(this.doc, this.t('issue.other'), { code }, ['code']))]));
      }
      if (!list.length) alerts.push(this.alertNode('error', [this.el('p', { className: 'text-sm' }, ui.ragUiTemplateNodes(this.doc, this.t('issue.other'), { code: glossaryText(body.error) }, ['code']))]));
    } else if (!codeFor(glossaryText(body.error))) {
      const mapped = ui.ragUiMapError(result, this.locale);
      const path = mapped.field && GLOSSARY_FIELDS.includes(mapped.field) ? mapped.field : null;
      if (path) place(path, mapped.message);
      else alerts.push(this.alertNode('error', [mapped.message]));
    }
    return { issues, alerts };
  }

  async save() {
    const f = this.form;
    if (!f || f.running) return;
    if (f.asking) this.renderFooter(false);
    const clientIssues = glossaryClientIssues(f.draft, this.locale);
    if (Object.keys(clientIssues).length) {
      this.setIssues(clientIssues);
      this.focusFirstIssue();
      return;
    }
    this.setIssues({});
    const body = this.api.withOrganization({ ...glossaryEntryBody(f.draft), layer: this.api.layer(), expected_version: this.layerVersion ?? 0 });
    f.running = true;
    const restore = this.ui().ragUiButtonBusy(this.doc, f.saveButton, this.t('form.saving'), [f.closeButton]);
    let result;
    try {
      result = f.mode === 'add' ? await this.api.send('', { method: 'POST', body: JSON.stringify(body) }) : await this.api.send('/' + encodeURIComponent(f.id), { method: 'PATCH', body: JSON.stringify(body) });
    } finally {
      f.running = false;
      if (this.form === f) restore();
    }
    const term = body.variants[0] || body.canonical;
    if (result && result.ok) {
      const warnings = Array.isArray(glossaryBody(result).warnings) ? glossaryBody(result).warnings : [];
      const override = warnings.some((w) => w && w.code === 'override');
      this.closeForm();
      await this.afterWrite(override ? this.t('warn.overrides', { term }) : this.t('save.done', { term }));
      return;
    }
    if (!result || result.thrown) {
      this.closeForm(true);
      await this.afterWrite(this.ui().ragUiLabel('error.outcomeUnknown', this.locale), true);
      return;
    }
    if (glossaryIsVersionConflict(result)) {
      const reload = this.btn(this.t('action.reloadEntries'), { className: 'btn btn-sm' }, () => this.load({ quiet: true }));
      this.setIssues({}, [this.alertNode('warning', [this.t('error.versionConflict')], [reload])]);
      this.focusFirstIssue();
      this.announce(this.t('error.versionConflict'), true);
      return;
    }
    if (result.status === 404) {
      this.closeForm(true);
      await this.afterWrite(this.ui().ragUiLabel('error.changed', this.locale), true);
      return;
    }
    if (result.status === 413) {
      this.setIssues({}, [this.alertNode('error', [this.t('error.layerFull')])]);
      this.focusFirstIssue();
      return;
    }
    if (result.status === 422 || result.status === 400) {
      const mapped = this.serverIssues(result);
      this.setIssues(mapped.issues, mapped.alerts);
      this.focusFirstIssue();
      return;
    }
    const mapped = this.ui().ragUiMapError(result, this.locale, { unavailable: this.t('view.unavailable') });
    this.setIssues({}, [this.alertNode('error', [mapped.message])]);
    this.focusFirstIssue();
    this.announce(mapped.message, true);
  }

  async afterWrite(message, isError) {
    if (this.api.changed) await this.api.changed();
    await this.load({ quiet: true });
    this.announce(message, isError);
  }

  // --- Delete (UI-SPEC 6.2.3)

  confirmDelete(row, opener) {
    const ui = this.ui();
    return ui.ragUiConfirmDialog(this.doc, {
      title: this.t('delete.title', { term: row.term }),
      body: [this.t('delete.body', { term: row.term })],
      keepLabel: this.t('delete.keep'),
      confirmLabel: this.t('delete.confirm'),
      runningLabel: this.t('delete.running'),
      tone: 'error',
      opener,
      fallbackFocus: this.api.status ? this.api.status() : null,
      onConfirm: async () => {
        const result = await this.api.request('/' + encodeURIComponent(row.id), { layer: this.api.layer(), expected_version: this.layerVersion ?? 0 }, { method: 'DELETE' });
        if (result && result.ok) {
          await this.afterWrite(this.t('delete.done', { term: row.term }));
          return null;
        }
        if (glossaryIsVersionConflict(result)) {
          await this.load({ quiet: true });
          return { keepOpen: true, message: this.t('error.versionConflict') };
        }
        if (!result || result.thrown) {
          await this.afterWrite(ui.ragUiLabel('error.outcomeUnknown', this.locale), true);
          return null;
        }
        if (result.status === 404) {
          await this.afterWrite(ui.ragUiLabel('error.changed', this.locale), true);
          return null;
        }
        const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('view.unavailable') });
        return { keepOpen: true, message: mapped.message };
      },
    });
  }
}

const GLOSSARY_VIEWS = typeof WeakMap === 'function' ? new WeakMap() : null;

/** Mounts the view on its host the first time; later calls refresh it and keep an open form (UI-SPEC 6.1). */
function initGlossaryView(host, api) {
  if (!host || !api) return null;
  const existing = GLOSSARY_VIEWS ? GLOSSARY_VIEWS.get(host) : null;
  if (existing) return existing.refresh();
  const view = new GlossaryView(host, api);
  if (GLOSSARY_VIEWS) GLOSSARY_VIEWS.set(host, view);
  return view.mount();
}

// --- Additions to the Terminology panel's import flow (UI-SPEC 6.2.4)

function glossaryImportFormat(doc, locale) {
  const ui = glossaryUiLib();
  return ui.ragUiEl(doc, 'p', { className: 'text-xs text-base-content/70 mt-1 max-w-prose', attrs: { 'data-glossary-import-format': '' } }, ui.ragUiTemplateNodes(doc, glossaryLabel('import.format', locale), { kind: 'translation', column: 'target_language' }, ['kind', 'column']));
}

function glossaryImportReplaceWarning(doc, locale) {
  const ui = glossaryUiLib();
  const node = ui.ragUiAlert(doc, { tone: 'warning', icon: 'exclamation-triangle', body: [glossaryLabel('import.replaceWarning', locale)] });
  node.setAttribute('data-glossary-replace-warning', '');
  return node;
}

function glossaryImportIssueLabel(code, locale) {
  return code === 'target_language_required' ? glossaryLabel('import.issue.target_required', locale) : null;
}

if (typeof window !== 'undefined') {
  window.GLOSSARY_LABELS = GLOSSARY_LABELS;
  window.initGlossaryView = initGlossaryView;
  window.glossaryLabel = glossaryLabel;
  window.glossaryImportFormat = glossaryImportFormat;
  window.glossaryImportReplaceWarning = glossaryImportReplaceWarning;
  window.glossaryImportIssueLabel = glossaryImportIssueLabel;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GLOSSARY_LABELS,
    glossaryLabel,
    glossaryLanguageName,
    glossaryRowView,
    glossaryDraftFromEntry,
    glossaryClientIssues,
    glossaryEntryBody,
    glossaryImportFormat,
    glossaryImportReplaceWarning,
    glossaryImportIssueLabel,
    GlossaryView,
    initGlossaryView,
  };
}
