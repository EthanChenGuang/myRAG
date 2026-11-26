/**
 * Ingestion changes panel, impact dialog and the one save guard (UI-SPEC 6.4; D-11, D-12). Plain-text DOM only, built with the
 * rag-ui.js helpers. The impact route decides which changed settings are ingestion-side; the browser only sends what changed.
 */

const INGEST_IMPACT_LABELS = {
  en: {
    'panel.title': 'Ingestion changes',
    'panel.description':
      'Settings that change how documents are processed, and the rebuilds that bring stored documents up to date. A rebuild is built next to the live data and can be rolled back. Applies to every workspace.',
    'tab.rebuilds': 'Rebuilds',
    'tab.settings': 'Settings',
    'tabs.label': 'Ingestion changes views',
    'impact.title': 'Save changes that affect stored documents?',
    'impact.changedHeading': 'Changed settings',
    'impact.change': '{from}, changed to: {to}',
    'impact.notSet': 'Not set',
    'impact.counting': 'Counting affected documents…',
    'impact.caption': 'Affected documents per rebuild and document type',
    'impact.col.rebuild': 'Rebuild',
    'impact.col.docType': 'Document type',
    'impact.col.documents': 'Documents',
    'impact.total': 'All affected documents',
    'impact.warning':
      'New uploads use the new settings at once. Stored documents keep their current processing until you rebuild them. Saving rebuilds nothing.',
    'impact.security':
      'Stored documents are not checked again by saving. To check them, use Rescan existing documents under Quarantine, Checks.',
    'impact.unknown':
      'The affected documents could not be counted. You can still save; the count appears under Ingestion changes once the app is reachable and you are signed in as admin.',
    'impact.fingerprintGap': 'Documents not counted because they have no fingerprint yet: {count}. Run {command} to include them.',
    'impact.none': 'No stored document is affected.',
    'impact.kept': 'The ingestion settings were not changed. Your other changes were saved.',
    'impact.saved': 'Settings saved. To bring stored documents up to date, open RAG administration, Ingestion changes.',
    'action.keepSettings': 'Keep current settings',
    'action.saveSettings': 'Save settings',
    'mechanism.reparse': 'Parse again',
    'mechanism.rechunk': 'Rebuild chunks',
    'mechanism.relex': 'Rebuild word index',
    'mechanism.reembed': 'Rebuild embeddings',
    'mechanism.recaption': 'Rewrite image captions',
    'mechanism.retranslate': 'Translate again',
    'mechanism.rescan': 'Security rescan',
    'settings.affectsStored': 'Changing this affects documents already stored; saving shows how many.',
    'warn.needsLanguages': 'This setting has no effect until the supported languages are chosen in the Languages panel.',
    'warn.needsUnified': 'This setting works in the unified ingest pipeline only. The ingest pipeline is set to legacy under RAG Modes.',
  },
  zh: {
    'panel.title': '入库设置变更',
    'panel.description':
      '会改变文档处理方式的设置，以及让已入库文档跟上新设置的重建。重建在现有数据旁边进行，可以回滚。适用于所有工作区。',
    'tab.rebuilds': '重建',
    'tab.settings': '设置',
    'tabs.label': '入库设置变更视图',
    'impact.title': '要保存会影响已入库文档的更改吗？',
    'impact.changedHeading': '已更改的设置',
    'impact.change': '{from}，改为：{to}',
    'impact.notSet': '未设置',
    'impact.counting': '正在统计受影响的文档…',
    'impact.caption': '按重建方式和文档类型统计的受影响文档',
    'impact.col.rebuild': '重建方式',
    'impact.col.docType': '文档类型',
    'impact.col.documents': '文档数',
    'impact.total': '受影响的文档合计',
    'impact.warning': '新上传的文档立即使用新设置。已入库的文档在重建之前保持原有处理结果。保存本身不会触发重建。',
    'impact.security': '保存不会重新检查已入库的文档。如需检查，请使用“隔离区 → 检查项”中的“重新扫描已有文档”。',
    'impact.unknown': '无法统计受影响的文档。仍然可以保存；应用可访问且已以管理员身份登录后，数量会显示在“入库设置变更”中。',
    'impact.fingerprintGap': '因尚无指纹而未计入的文档：{count}。运行 {command} 后即可计入。',
    'impact.none': '没有已入库的文档受影响。',
    'impact.kept': '入库设置未更改。其他更改已保存。',
    'impact.saved': '设置已保存。要让已入库文档使用新设置，请打开“RAG 管理 → 入库设置变更”。',
    'action.keepSettings': '保留当前设置',
    'action.saveSettings': '保存设置',
    'mechanism.reparse': '重新解析',
    'mechanism.rechunk': '重建切块',
    'mechanism.relex': '重建词汇索引',
    'mechanism.reembed': '重建向量',
    'mechanism.recaption': '重写图片说明',
    'mechanism.retranslate': '重新翻译',
    'mechanism.rescan': '安全重新扫描',
    'settings.affectsStored': '更改此项会影响已入库的文档；保存时会显示数量。',
    'warn.needsLanguages': '在“语言”面板中选择支持的语言之前，此设置不会生效。',
    'warn.needsUnified': '此设置仅在统一入库流程中生效。“RAG 模式”中的入库流程目前为 legacy。',
    'RAG_LANGUAGE_AWARE_INGEST.label': '按语言处理',
    'RAG_LANGUAGE_AWARE_INGEST.help': '检测每个切块的语言，按该语言断句，并按支持的语言识别扫描件。',
    'RAG_LANGUAGE_AWARE_INGEST.opt.off': '关闭（与现在相同）',
    'RAG_LANGUAGE_AWARE_INGEST.opt.on': '开启',
    'RAG_TABLE_HEADER_REPEAT.label': '重复表头',
    'RAG_TABLE_HEADER_REPEAT.help': '表格被拆分时，在每个切块中重复表头，并把表头带到续页的表格中。',
    'RAG_TABLE_HEADER_REPEAT.opt.profile': '按文档类型',
    'RAG_TABLE_HEADER_REPEAT.opt.always': '始终',
    'RAG_TABLE_ROW_SERIALIZATION.label': '表格行以“列名=值”形式参与检索',
    'RAG_TABLE_ROW_SERIALIZATION.help': '在检索文本中为每一行增加一条“列名=值”。回答时读取的仍是表格本身。',
    'RAG_TABLE_ROW_SERIALIZATION.opt.false': '关闭',
    'RAG_TABLE_ROW_SERIALIZATION.opt.true': '开启',
    'RAG_CAPTION_LANGUAGE.label': '图片说明的语言',
    'RAG_CAPTION_LANGUAGE.help': '图片说明用英文书写，或用所在文档的语言书写。',
    'RAG_CAPTION_LANGUAGE.opt.en': '英文（与现在相同）',
    'RAG_CAPTION_LANGUAGE.opt.document': '文档的语言',
  },
  it: {
    'panel.title': 'Modifiche all’ingestione',
    'panel.description':
      'Impostazioni che cambiano l’elaborazione dei documenti e le ricostruzioni che aggiornano quelli già archiviati. Una ricostruzione avviene accanto ai dati in uso e può essere annullata. Vale per tutti gli spazi di lavoro.',
    'tab.rebuilds': 'Ricostruzioni',
    'tab.settings': 'Impostazioni',
    'tabs.label': 'Viste delle modifiche all’ingestione',
    'impact.title': 'Salvare modifiche che riguardano i documenti archiviati?',
    'impact.changedHeading': 'Impostazioni modificate',
    'impact.change': '{from}, modificato in: {to}',
    'impact.notSet': 'Non impostato',
    'impact.counting': 'Conteggio dei documenti interessati…',
    'impact.caption': 'Documenti interessati per ricostruzione e tipo di documento',
    'impact.col.rebuild': 'Ricostruzione',
    'impact.col.docType': 'Tipo di documento',
    'impact.col.documents': 'Documenti',
    'impact.total': 'Tutti i documenti interessati',
    'impact.warning':
      'I nuovi caricamenti usano subito le nuove impostazioni. I documenti archiviati mantengono l’elaborazione attuale finché non li ricostruisci. Il salvataggio non ricostruisce nulla.',
    'impact.security':
      'Il salvataggio non ricontrolla i documenti archiviati. Per farlo, usa Riesamina i documenti esistenti in Quarantena, Controlli.',
    'impact.unknown':
      'Non è stato possibile contare i documenti interessati. Puoi salvare comunque: il conteggio appare in Modifiche all’ingestione quando l’app è raggiungibile e hai effettuato l’accesso come amministratore.',
    'impact.fingerprintGap': 'Documenti non contati perché ancora senza impronta: {count}. Esegui {command} per includerli.',
    'impact.none': 'Nessun documento archiviato è interessato.',
    'impact.kept': 'Le impostazioni di ingestione non sono cambiate. Le altre modifiche sono state salvate.',
    'impact.saved': 'Impostazioni salvate. Per aggiornare i documenti archiviati, apri RAG administration, Modifiche all’ingestione.',
    'action.keepSettings': 'Mantieni le impostazioni attuali',
    'action.saveSettings': 'Salva le impostazioni',
    'mechanism.reparse': 'Nuovo parsing',
    'mechanism.rechunk': 'Ricostruzione dei chunk',
    'mechanism.relex': 'Ricostruzione dell’indice lessicale',
    'mechanism.reembed': 'Ricostruzione degli embedding',
    'mechanism.recaption': 'Riscrittura delle didascalie',
    'mechanism.retranslate': 'Nuova traduzione',
    'mechanism.rescan': 'Riesame di sicurezza',
    'settings.affectsStored': 'La modifica riguarda i documenti già archiviati; al salvataggio vedrai quanti.',
    'warn.needsLanguages': 'Questa impostazione non ha effetto finché non scegli le lingue supportate nel pannello Lingue.',
    'warn.needsUnified':
      'Questa impostazione funziona solo nella pipeline di ingestione unificata. In RAG Modes la pipeline è impostata su legacy.',
    'RAG_LANGUAGE_AWARE_INGEST.label': 'Elaborazione per lingua',
    'RAG_LANGUAGE_AWARE_INGEST.help':
      'Rileva la lingua di ogni chunk, divide le frasi secondo quella lingua e legge le scansioni con le lingue supportate.',
    'RAG_LANGUAGE_AWARE_INGEST.opt.off': 'Disattivata, come oggi',
    'RAG_LANGUAGE_AWARE_INGEST.opt.on': 'Attiva',
    'RAG_TABLE_HEADER_REPEAT.label': 'Ripetizione dell’intestazione delle tabelle',
    'RAG_TABLE_HEADER_REPEAT.help':
      'Ripete la riga di intestazione in ogni chunk di una tabella divisa e la riporta nella tabella che continua alla pagina successiva.',
    'RAG_TABLE_HEADER_REPEAT.opt.profile': 'Secondo il tipo di documento',
    'RAG_TABLE_HEADER_REPEAT.opt.always': 'Sempre',
    'RAG_TABLE_ROW_SERIALIZATION.label': 'Righe di tabella come «colonna = valore» per la ricerca',
    'RAG_TABLE_ROW_SERIALIZATION.help':
      'Aggiunge al testo di ricerca una riga «colonna = valore» per ogni riga. La risposta legge sempre la tabella.',
    'RAG_TABLE_ROW_SERIALIZATION.opt.false': 'Disattivate',
    'RAG_TABLE_ROW_SERIALIZATION.opt.true': 'Attive',
    'RAG_CAPTION_LANGUAGE.label': 'Lingua delle didascalie',
    'RAG_CAPTION_LANGUAGE.help': 'Le didascalie delle immagini sono scritte in inglese o nella lingua del documento.',
    'RAG_CAPTION_LANGUAGE.opt.en': 'Inglese, come oggi',
    'RAG_CAPTION_LANGUAGE.opt.document': 'La lingua del documento',
  },
};

const INGEST_IMPACT_PATHS = {
  coverage: '/api/rag/admin/ingest-fingerprint',
  impact: '/api/rag/admin/ingest-fingerprint/impact',
  rebuild: '/api/rag/admin/ingest-fingerprint/rebuild',
};
const INGEST_IMPACT_MECHANISMS = ['reparse', 'rechunk', 'relex', 'reembed', 'recaption', 'retranslate', 'rescan'];
const INGEST_IMPACT_BACKFILL_COMMAND = 'npm run rag:fingerprint -- backfill';
/** The names the impact route accepts are classified RAG_* settings; secret-named values never leave the page (UI-SPEC 11.6). */
const INGEST_IMPACT_SETTING_NAME = /^RAG_[A-Z0-9_]+$/;
const INGEST_IMPACT_SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD)/i;
const INGEST_IMPACT_MAX_KEYS = 200;
const INGEST_IMPACT_MAX_VALUE = 2048;
const INGEST_IMPACT_OPEN_DELAY_MS = 300;
const INGEST_IMPACT_TIMEOUT_MS = 15000;
const INGEST_IMPACT_LANGUAGE_KEYS = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'];
const INGEST_IMPACT_SETTINGS_IDS = ['RAG_LANGUAGE_AWARE_INGEST', 'RAG_TABLE_HEADER_REPEAT', 'RAG_TABLE_ROW_SERIALIZATION', 'RAG_CAPTION_LANGUAGE'];

let ingestImpactUi = null;
if (typeof require !== 'undefined') {
  try {
    ingestImpactUi = require('./rag-ui.js');
  } catch {
    ingestImpactUi = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function ingestImpactUiLib() {
  if (ingestImpactUi) return ingestImpactUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

function ingestImpactLocale() {
  return ingestImpactUiLib().ragUiBrowserLocale();
}

function ingestImpactLabel(key, locale, vars) {
  const text = ingestImpactUiLib().ragUiLookup(INGEST_IMPACT_LABELS, key, locale, vars);
  return text === undefined ? ingestImpactUiLib().ragUiLabel(key, locale, vars) : text;
}

function ingestImpactValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function ingestImpactCount(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0;
}

/** The RAG_* settings whose value differs from the saved one, sorted; secret-named and oversized values are never sent. */
function ingestImpactChangedKeys(next, saved) {
  const a = next || {};
  const b = saved || {};
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names]
    .filter((name) => INGEST_IMPACT_SETTING_NAME.test(name) && !INGEST_IMPACT_SECRET_NAME.test(name))
    .filter((name) => ingestImpactValue(a[name]) !== ingestImpactValue(b[name]))
    .filter((name) => ingestImpactValue(a[name]).length <= INGEST_IMPACT_MAX_VALUE)
    .sort();
}

/** One impact request per 200 keys (the route's limit). */
function ingestImpactRequestBodies(next, keys) {
  const bodies = [];
  for (let i = 0; i < keys.length; i += INGEST_IMPACT_MAX_KEYS) {
    const proposed = {};
    for (const name of keys.slice(i, i + INGEST_IMPACT_MAX_KEYS)) proposed[name] = ingestImpactValue((next || {})[name]);
    bodies.push({ proposed });
  }
  return bodies;
}

/** Named fields of the FingerprintImpact answers only (UI-SPEC 11.4), merged across requests. */
function ingestImpactBuildView(answers) {
  const keys = new Set();
  const mechanisms = new Set();
  const counts = new Map();
  let withoutFingerprint = 0;
  for (const answer of answers || []) {
    const body = answer && typeof answer === 'object' ? answer : {};
    for (const name of Array.isArray(body.ingestion_keys) ? body.ingestion_keys : []) {
      if (typeof name === 'string' && INGEST_IMPACT_SETTING_NAME.test(name)) keys.add(name);
    }
    for (const row of Array.isArray(body.by_mechanism) ? body.by_mechanism : []) {
      if (!row || typeof row !== 'object' || typeof row.mechanism !== 'string') continue;
      const docType = typeof row.doc_type === 'string' ? row.doc_type : 'general';
      mechanisms.add(row.mechanism);
      const id = row.mechanism + '\u0000' + docType;
      const prior = counts.get(id) || { mechanism: row.mechanism, docType, affected: 0 };
      prior.affected += ingestImpactCount(row.affected);
      counts.set(id, prior);
    }
    withoutFingerprint = Math.max(withoutFingerprint, ingestImpactCount(body.without_fingerprint));
  }
  const order = (mechanism) => {
    const index = INGEST_IMPACT_MECHANISMS.indexOf(mechanism);
    return index < 0 ? INGEST_IMPACT_MECHANISMS.length : index;
  };
  const rows = [...counts.values()].filter((row) => row.affected > 0).sort((x, y) => order(x.mechanism) - order(y.mechanism));
  return {
    ingestionKeys: [...keys].sort(),
    mechanisms: [...mechanisms],
    rows,
    totalAffected: rows.reduce((sum, row) => sum + row.affected, 0),
    withoutFingerprint,
    security: mechanisms.has('rescan'),
  };
}

/** UI-SPEC decision 5: the first language choice from unset never blocks on a zero or missing count. */
function ingestImpactIsFirstLanguage(keys, saved) {
  if (!keys.length || !keys.includes('RAG_SUPPORTED_LANGUAGES')) return false;
  if (ingestImpactValue((saved || {}).RAG_SUPPORTED_LANGUAGES).trim() !== '') return false;
  return keys.every((name) => INGEST_IMPACT_LANGUAGE_KEYS.includes(name));
}

/** proceed: save without a dialog; none: save and add the toast line; dialog; unknown: the count-unavailable dialog. */
function ingestImpactDecision(view, failed, firstLanguage) {
  if (failed) return firstLanguage ? 'proceed' : 'unknown';
  if (!view.ingestionKeys.length) return 'proceed';
  if (view.totalAffected === 0 && (view.withoutFingerprint === 0 || firstLanguage)) return 'none';
  return 'dialog';
}

/** A copy of next with the given keys back at their saved values. */
function ingestImpactRevert(next, saved, keys) {
  const copy = { ...(next || {}) };
  for (const name of keys) {
    if (saved && Object.prototype.hasOwnProperty.call(saved, name)) copy[name] = saved[name];
    else delete copy[name];
  }
  return copy;
}

/** UI-SPEC 6.3 combination warnings of the ingest group, read from the page's own inputs. */
function ingestImpactWarnings(values) {
  const v = values || {};
  const keys = [];
  const languagesUnset = ingestImpactValue(v.languages).trim() === '';
  if (languagesUnset && (v.aware === 'on' || v.caption === 'document')) keys.push('warn.needsLanguages');
  if (v.aware === 'on' && ingestImpactValue(v.pipeline) !== 'unified') keys.push('warn.needsUnified');
  return keys;
}

function ingestImpactMechanismLabel(mechanism, locale, rowLabels) {
  if (rowLabels && typeof rowLabels[mechanism] === 'string') return rowLabels[mechanism];
  const key = 'mechanism.' + mechanism;
  const text = ingestImpactUiLib().ragUiLookup(INGEST_IMPACT_LABELS, key, locale);
  return text === undefined ? null : text;
}

/** A mechanism the UI does not know shows its code in monospace (UI-SPEC 6.4.1). */
function ingestImpactMechanismNode(doc, mechanism, locale, rowLabels) {
  const ui = ingestImpactUiLib();
  const label = ingestImpactMechanismLabel(mechanism, locale, rowLabels);
  if (label !== null) return ui.ragUiEl(doc, 'span', { text: label });
  return ui.ragUiEl(doc, 'code', { className: 'font-mono text-xs break-all', text: mechanism, attrs: { translate: 'no' } });
}

function ingestImpactDocTypeNode(doc, docType, locale) {
  const ui = ingestImpactUiLib();
  let label = '';
  if (typeof window !== 'undefined' && typeof window.docTypeLabelForLocale === 'function') {
    try {
      label = window.docTypeLabelForLocale(docType, locale) || '';
    } catch {
      label = '';
    }
  }
  if (label && label !== docType) return ui.ragUiEl(doc, 'span', { text: label });
  return ui.ragUiEl(doc, 'code', { className: 'font-mono text-xs break-all', text: docType, attrs: { translate: 'no' } });
}

/** The visible label of a setting and the text of a value, read from the page's own control (human option labels). */
function ingestImpactSettingText(doc, name, value, locale) {
  const label = doc.querySelector('label[for="' + name + '"] .label-text');
  const control = doc.getElementById(name);
  const raw = ingestImpactValue(value);
  let text = raw;
  if (control && control.tagName && control.tagName.toLowerCase() === 'select') {
    const option = Array.from(control.querySelectorAll('option')).find((o) => o.getAttribute('value') === raw);
    if (option) text = option.textContent.trim();
  }
  if (text.trim() === '') text = ingestImpactLabel('impact.notSet', locale);
  return { label: label ? label.textContent.trim() : null, value: text };
}

function ingestImpactStatusHost() {
  return typeof document !== 'undefined' ? document.querySelector('[data-ingest-impact-status]') : null;
}

function ingestImpactToast(message) {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') window.showToast(message, 'info');
}

/** Puts the page inputs of the given settings back to their saved values without firing change (no auto-save loop). */
function ingestImpactRevertInputs(doc, saved, keys) {
  for (const name of keys) {
    const control = doc.getElementById(name);
    if (!control) continue;
    const value = ingestImpactValue((saved || {})[name]);
    if (control.type === 'checkbox') control.checked = value === 'true';
    else control.value = value;
  }
  if (typeof window !== 'undefined' && window.ingestImpactPanel && typeof window.ingestImpactPanel.renderWarnings === 'function') {
    window.ingestImpactPanel.renderWarnings();
  }
}

/**
 * The impact dialog (UI-SPEC 6.4.1). options: changes [{ name, from, to }], rowLabels, title, totalLabel, note.
 * Returns { setCounting, setCounted(view), setUnknown(), setChanges(changes), close(), choice } where choice resolves 'keep' or 'save'.
 */
function ingestImpactOpenDialog(doc, locale, options) {
  const ui = ingestImpactUiLib();
  const opts = options || {};
  const t = (key, vars) => ingestImpactLabel(key, locale, vars);
  const opener = doc.activeElement || null;
  const titleId = ui.ragUiNextId('rag-ingest-impact-title');
  const warningId = ui.ragUiNextId('rag-ingest-impact-warning');
  const dialog = ui.ragUiEl(doc, 'dialog', { className: 'modal', attrs: { 'aria-labelledby': titleId, 'aria-describedby': warningId, lang: locale } });
  const changesHost = ui.ragUiEl(doc, 'div', { className: 'mb-4' });
  const countHost = ui.ragUiEl(doc, 'div', { className: 'mb-4 min-w-0' });
  const notesHost = ui.ragUiEl(doc, 'div', { className: 'flex flex-col gap-2 text-sm max-w-prose' });
  const keep = ui.ragUiEl(doc, 'button', { className: 'btn btn-sm', text: t('action.keepSettings'), attrs: { type: 'button' } });
  const save = ui.ragUiEl(doc, 'button', { className: 'btn btn-sm btn-primary', text: t('action.saveSettings'), attrs: { type: 'button' } });
  const box = ui.ragUiEl(doc, 'div', { className: 'modal-box min-w-0 overscroll-contain' }, [
    ui.ragUiEl(doc, 'h3', { className: 'text-base font-semibold mb-4 break-words text-balance', id: titleId, text: opts.title || t('impact.title') }),
    changesHost,
    countHost,
    notesHost,
    ui.ragUiEl(doc, 'div', { className: 'modal-action flex-wrap gap-2' }, [keep, save]),
  ]);
  const backdropButton = ui.ragUiEl(doc, 'button', { className: 'cursor-default', text: t('action.keepSettings'), attrs: { type: 'submit', tabindex: '-1' } });
  const backdrop = ui.ragUiEl(doc, 'form', { className: 'modal-backdrop', attrs: { method: 'dialog' } }, [backdropButton]);
  dialog.appendChild(box);
  dialog.appendChild(backdrop);
  doc.body.appendChild(dialog);

  let chosen = null;
  let resolveChoice = null;
  const choice = new Promise((resolve) => {
    resolveChoice = resolve;
  });
  dialog.addEventListener('cancel', () => {
    chosen = chosen || 'keep';
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    const target = opener && opener.isConnected !== false && typeof opener.focus === 'function' ? opener : ingestImpactStatusHost();
    if (target && typeof target.focus === 'function') target.focus();
    resolveChoice(chosen || 'keep');
  });
  keep.addEventListener('click', () => {
    chosen = 'keep';
    dialog.close('keep');
  });
  save.addEventListener('click', () => {
    if (save.disabled) return;
    chosen = 'save';
    dialog.close('save');
  });

  const setSaveEnabled = (enabled) => {
    save.disabled = !enabled;
    if (enabled) save.removeAttribute('aria-disabled');
    else save.setAttribute('aria-disabled', 'true');
  };

  const setChanges = (changes) => {
    const list = ui.ragUiEl(doc, 'dl', { className: 'flex flex-col gap-2 text-sm' });
    for (const change of changes || []) {
      const from = ingestImpactSettingText(doc, change.name, change.from, locale);
      const to = ingestImpactSettingText(doc, change.name, change.to, locale);
      list.appendChild(ui.ragUiEl(doc, 'dt', { className: 'font-semibold break-words', text: from.label || change.name }));
      list.appendChild(
        ui.ragUiEl(doc, 'dd', { className: 'min-w-0' }, [
          ui.ragUiEl(doc, 'span', { className: 'break-words', text: t('impact.change', { from: from.value, to: to.value }) }),
          ui.ragUiEl(doc, 'code', { className: 'block font-mono text-xs break-all mt-1', text: change.name, attrs: { translate: 'no' } }),
        ]),
      );
    }
    changesHost.replaceChildren(ui.ragUiEl(doc, 'h4', { className: 'text-sm font-semibold mb-2', text: t('impact.changedHeading') }), list);
  };

  const notes = (view) => {
    const nodes = [
      ui.ragUiEl(doc, 'p', { className: 'flex items-start gap-2', id: warningId }, [
        ui.ragUiIcon(doc, 'exclamation-triangle', 'text-warning mt-0.5'),
        ui.ragUiEl(doc, 'span', { text: t('impact.warning') }),
      ]),
    ];
    if (view && view.security) nodes.push(ui.ragUiEl(doc, 'p', { text: t('impact.security') }));
    if (view && view.withoutFingerprint > 0) {
      const template = t('impact.fingerprintGap');
      const vars = { count: ui.ragUiFormatNumber(view.withoutFingerprint, locale), command: INGEST_IMPACT_BACKFILL_COMMAND };
      nodes.push(ui.ragUiEl(doc, 'p', {}, ui.ragUiTemplateNodes(doc, template, vars, ['command'])));
    }
    if (typeof opts.note === 'string' && opts.note) nodes.push(ui.ragUiEl(doc, 'p', { text: opts.note }));
    notesHost.replaceChildren(...nodes);
  };

  const table = (view) => {
    const num = 'text-right tabular-nums';
    const head = ui.ragUiEl(doc, 'thead', {}, [
      ui.ragUiEl(doc, 'tr', {}, [
        ui.ragUiEl(doc, 'th', { className: 'font-semibold', text: t('impact.col.rebuild'), attrs: { scope: 'col' } }),
        ui.ragUiEl(doc, 'th', { className: 'font-semibold', text: t('impact.col.docType'), attrs: { scope: 'col' } }),
        ui.ragUiEl(doc, 'th', { className: 'font-semibold ' + num, text: t('impact.col.documents'), attrs: { scope: 'col' } }),
      ]),
    ]);
    const body = ui.ragUiEl(doc, 'tbody');
    for (const row of view.rows) {
      body.appendChild(
        ui.ragUiEl(doc, 'tr', {}, [
          ui.ragUiEl(doc, 'th', { className: 'font-normal break-words', attrs: { scope: 'row' } }, [ingestImpactMechanismNode(doc, row.mechanism, locale, opts.rowLabels)]),
          ui.ragUiEl(doc, 'td', { className: 'break-words' }, [ingestImpactDocTypeNode(doc, row.docType, locale)]),
          ui.ragUiEl(doc, 'td', { className: num, text: ui.ragUiFormatNumber(row.affected, locale) }),
        ]),
      );
    }
    body.appendChild(
      ui.ragUiEl(doc, 'tr', { className: 'font-semibold' }, [
        ui.ragUiEl(doc, 'th', { className: 'font-semibold', text: opts.totalLabel || t('impact.total'), attrs: { scope: 'row', colspan: '2' } }),
        ui.ragUiEl(doc, 'td', { className: num, text: ui.ragUiFormatNumber(view.totalAffected, locale) }),
      ]),
    );
    const caption = ui.ragUiEl(doc, 'caption', { className: 'sr-only', text: t('impact.caption') });
    return ui.ragUiEl(doc, 'div', { className: 'overflow-x-auto', attrs: { tabindex: '0', role: 'region', 'aria-label': t('impact.caption') } }, [
      ui.ragUiEl(doc, 'table', { className: 'table table-sm' }, [caption, head, body]),
    ]);
  };

  const controller = {
    choice,
    setChanges,
    setCounting() {
      countHost.replaceChildren(ui.ragUiSpinner(doc, t('impact.counting')));
      countHost.setAttribute('aria-busy', 'true');
      notes(null);
      setSaveEnabled(false);
    },
    setCounted(view) {
      countHost.removeAttribute('aria-busy');
      countHost.replaceChildren(table(view));
      notes(view);
      setSaveEnabled(true);
    },
    setUnknown() {
      countHost.removeAttribute('aria-busy');
      countHost.replaceChildren(ui.ragUiEl(doc, 'p', { className: 'text-sm max-w-prose', text: t('impact.unknown') }));
      notes(null);
      setSaveEnabled(true);
    },
    close() {
      if (dialog.open) {
        chosen = chosen || 'save';
        dialog.close('save');
      }
    },
  };
  dialog.showModal();
  keep.focus();
  return controller;
}

/**
 * The save guard (UI-SPEC 6.4.1, decision 4). guard(next, saved, options) resolves true (save as is) or a copy of next whose
 * ingestion-side keys are back at their saved values ("Keep current settings"). options: title, rowLabels, totalLabel, note.
 * Calls are serialized, so a second auto-save waits for the open dialog; a change the admin already accepted is not asked again.
 */
function ingestImpactCreateGuard(factoryOptions) {
  const settings = factoryOptions || {};
  const openDelayMs = typeof settings.openDelayMs === 'number' ? settings.openDelayMs : INGEST_IMPACT_OPEN_DELAY_MS;
  const timeoutMs = typeof settings.timeoutMs === 'number' ? settings.timeoutMs : INGEST_IMPACT_TIMEOUT_MS;
  const accepted = new Map();
  let chain = Promise.resolve();

  const count = async (next, keys) => {
    const ui = ingestImpactUiLib();
    const bodies = ingestImpactRequestBodies(next, keys);
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ failed: true }), timeoutMs);
    });
    const requests = (async () => {
      const answers = [];
      for (const body of bodies) {
        const result = await ui.ragUiRagRequest(INGEST_IMPACT_PATHS.impact, { method: 'POST', body: JSON.stringify(body) }, timeoutMs);
        if (!result || !result.ok || !result.body || typeof result.body !== 'object') return { failed: true, status: result ? result.status : 0 };
        answers.push(result.body);
      }
      return { failed: false, view: ingestImpactBuildView(answers) };
    })();
    try {
      return await Promise.race([requests, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const run = async (next, saved, options) => {
    const doc = typeof document !== 'undefined' ? document : null;
    const locale = ingestImpactLocale();
    for (const [name, value] of [...accepted]) {
      if (ingestImpactValue((saved || {})[name]) === value || ingestImpactValue((next || {})[name]) !== value) accepted.delete(name);
    }
    const keys = ingestImpactChangedKeys(next, saved).filter((name) => accepted.get(name) !== ingestImpactValue(next[name]));
    if (!keys.length || !doc) return true;
    const firstLanguage = ingestImpactIsFirstLanguage(keys, saved);
    const changes = (names) => names.map((name) => ({ name, from: (saved || {})[name], to: next[name] }));

    const counting = count(next, keys);
    let dialog = null;
    let outcome = null;
    if (!firstLanguage) {
      const early = openDelayMs > 0 ? await Promise.race([counting, new Promise((resolve) => setTimeout(() => resolve(null), openDelayMs))]) : null;
      outcome = early;
      if (!early) {
        dialog = ingestImpactOpenDialog(doc, locale, options);
        dialog.setChanges(changes(keys));
        dialog.setCounting();
      }
    }
    if (!outcome) {
      const finished = await Promise.race([counting.then((value) => ({ value })), dialog ? dialog.choice.then((picked) => ({ picked })) : new Promise(() => {})]);
      if (finished.picked) return finish(finished.picked, next, saved, keys, locale);
      outcome = finished.value;
    }

    const view = outcome.failed ? null : outcome.view;
    const decision = ingestImpactDecision(view || { ingestionKeys: [] }, outcome.failed, firstLanguage);
    if (decision === 'proceed' || decision === 'none') {
      if (dialog) dialog.close();
      if (decision === 'none') ingestImpactToast(ingestImpactLabel('impact.none', locale));
      return true;
    }
    const revertKeys = decision === 'unknown' ? keys : view.ingestionKeys.filter((name) => keys.includes(name));
    if (!dialog) {
      dialog = ingestImpactOpenDialog(doc, locale, options);
    }
    dialog.setChanges(changes(revertKeys.length ? revertKeys : keys));
    if (decision === 'unknown') dialog.setUnknown();
    else dialog.setCounted(view);
    const picked = await dialog.choice;
    return finish(picked, next, saved, revertKeys.length ? revertKeys : keys, locale);
  };

  const finish = (picked, next, saved, revertKeys, locale) => {
    const doc = typeof document !== 'undefined' ? document : null;
    if (picked === 'save') {
      for (const name of revertKeys) accepted.set(name, ingestImpactValue(next[name]));
      ingestImpactToast(ingestImpactLabel('impact.saved', locale));
      return true;
    }
    if (doc) ingestImpactRevertInputs(doc, saved, revertKeys);
    const status = ingestImpactStatusHost();
    if (status) status.textContent = ingestImpactLabel('impact.kept', locale);
    return ingestImpactRevert(next, saved, revertKeys);
  };

  return (next, saved, options) => {
    const result = chain.then(() => run(next || {}, saved || {}, options || {}));
    chain = result.catch(() => undefined);
    return result;
  };
}

class IngestImpactPanel {
  constructor(root) {
    this.root = root;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.locale = ingestImpactLocale();
    this.mounted = false;
    this.tabs = null;
    this.warningsHost = null;
    this.rebuildsHost = null;
  }

  t(key, vars) {
    return ingestImpactLabel(key, this.locale, vars);
  }

  el(tag, options, children) {
    return ingestImpactUiLib().ragUiEl(this.doc, tag, options, children);
  }

  announce(text, isError) {
    const host = this.root.querySelector('[data-ingest-impact-status]');
    if (!host) return;
    host.classList.toggle('text-error', Boolean(isError));
    if (isError) host.replaceChildren(ingestImpactUiLib().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text }));
    else host.textContent = text;
  }

  async mount() {
    const ui = ingestImpactUiLib();
    this.mounted = true;
    this.root.setAttribute('lang', this.locale);
    const title = this.root.querySelector('[data-ingest-impact-title]');
    if (title) title.textContent = this.t('panel.title');
    const description = this.root.querySelector('[data-ingest-impact-description]');
    if (description) description.textContent = this.t('panel.description');
    const content = this.root.querySelector('[data-ingest-impact-content]');
    this.tabs = ui.ragUiSubTabs(this.doc, {
      label: this.t('tabs.label'),
      idPrefix: 'rag-ingest-impact',
      tabs: [
        { id: 'rebuilds', label: this.t('tab.rebuilds') },
        { id: 'settings', label: this.t('tab.settings') },
      ],
      selected: 'rebuilds',
    });
    this.rebuildsHost = this.el('div', { className: 'min-w-0' });
    this.tabs.panels.rebuilds.appendChild(this.rebuildsHost);
    this.warningsHost = this.el('div', { className: 'flex flex-col gap-2 mb-4 empty:mb-0' });
    this.tabs.panels.settings.appendChild(this.warningsHost);
    const group = this.doc.querySelector('[data-rag-settings-group="ingest"]');
    if (group) {
      this.tabs.panels.settings.appendChild(group);
      this.localizeSettings(group);
    }
    if (content) content.replaceChildren(this.tabs.tablist, this.tabs.panels.rebuilds, this.tabs.panels.settings);
    for (const id of [...INGEST_IMPACT_SETTINGS_IDS, 'RAG_INGEST_PIPELINE', 'RAG_SUPPORTED_LANGUAGES']) {
      const control = this.doc.getElementById(id);
      if (control) control.addEventListener('change', () => this.renderWarnings());
    }
    this.renderWarnings();
    await this.loadRebuilds();
  }

  async refresh() {
    await this.loadRebuilds();
  }

  /** zh and it through data-rag-i18n; English is the static markup (UI-SPEC 6.3). */
  localizeSettings(group) {
    if (this.locale === 'en') return;
    const table = INGEST_IMPACT_LABELS[this.locale] || {};
    for (const node of Array.from(group.querySelectorAll('[data-rag-i18n]'))) {
      const text = table[node.getAttribute('data-rag-i18n')];
      if (text !== undefined) node.textContent = text;
    }
  }

  valueOf(id) {
    const control = this.doc.getElementById(id);
    return control ? ingestImpactValue(control.value) : '';
  }

  renderWarnings() {
    if (!this.warningsHost) return;
    const ui = ingestImpactUiLib();
    const keys = ingestImpactWarnings({
      aware: this.valueOf('RAG_LANGUAGE_AWARE_INGEST'),
      caption: this.valueOf('RAG_CAPTION_LANGUAGE'),
      languages: this.valueOf('RAG_SUPPORTED_LANGUAGES'),
      pipeline: this.valueOf('RAG_INGEST_PIPELINE'),
    });
    this.warningsHost.replaceChildren(
      ...keys.map((key) => ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', body: [this.t(key)] })),
    );
  }

  async loadRebuilds() {}
}

let ingestImpactPanelInstance = null;

function initIngestImpactPanel() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rag-administration-ingest-impact');
  if (!root) return null;
  if (!ingestImpactPanelInstance) {
    ingestImpactPanelInstance = new IngestImpactPanel(root);
    if (typeof window !== 'undefined') window.ingestImpactPanel = ingestImpactPanelInstance;
    return ingestImpactPanelInstance.mount();
  }
  return ingestImpactPanelInstance.refresh();
}

function ingestImpactBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-ingest-impact-bound')) return;
    link.setAttribute('data-ingest-impact-bound', '1');
    link.addEventListener('click', () => initIngestImpactPanel());
  });
}

if (typeof window !== 'undefined') {
  window.INGEST_IMPACT_LABELS = INGEST_IMPACT_LABELS;
  window.ingestImpactCreateGuard = ingestImpactCreateGuard;
  window.ragIngestImpactGuard = ingestImpactCreateGuard();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initIngestImpactPanel = initIngestImpactPanel;
  ingestImpactBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    ingestImpactBindPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initIngestImpactPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    INGEST_IMPACT_LABELS,
    ingestImpactLabel,
    ingestImpactChangedKeys,
    ingestImpactRequestBodies,
    ingestImpactBuildView,
    ingestImpactIsFirstLanguage,
    ingestImpactDecision,
    ingestImpactRevert,
    ingestImpactWarnings,
    ingestImpactCreateGuard,
    IngestImpactPanel,
    initIngestImpactPanel,
  };
}
