/**
 * Quarantine panel (UI-SPEC 6.5; D-32 to D-35, D-50). Held documents with their reasons and the inert evidence block, the
 * documents no hidden-text checker covered, and the ingestion checks. Every server string, span and link target is set as
 * text through the rag-ui.js element builder; evidence is never a link, an attribute value or a request.
 */

const QUARANTINE_LABELS = {
  en: {
    'panel.title': 'Quarantine',
    'panel.description':
      'Documents held out of answers by an injection rule, hidden text or a link outside the allowlist, the documents no hidden-text check covers, and the checks themselves. Lists every workspace you administer.',
    'tabs.label': 'Quarantine views',
    'tab.quarantined': 'Quarantined: {count}',
    'tab.notChecked': 'Not checked: {count}',
    'tab.checks': 'Checks',
    'hold.quarantined': 'Held out of answers: {reasons}.',
    'hold.kind.injection_rule': 'an injection rule',
    'hold.kind.hidden_text': 'hidden text',
    'hold.kind.untrusted_link': 'links outside the allowlist',
    'hold.kind.invoice_extraction': 'invoice fields',
    'hold.kind.unknown': 'another reason',
    'kind.injection_rule': 'Injection rule',
    'kind.hidden_text': 'Hidden text',
    'kind.untrusted_link': 'Link outside the allowlist',
    'kind.invoice_extraction': 'Invoice fields',
    'reason.rules': 'Matched rules: {rules}',
    'reason.hidden': 'Hidden text found: {count}. It was removed from the text and is not searchable.',
    'reason.links': 'Link targets outside the allowlist: {count}',
    'reason.invoice': 'The invoice fields could not be extracted safely.',
    'reason.other': 'Stopped for the reason {code}.',
    'evidence.page': 'page {n}',
    'evidence.targets': 'Link targets, domains and e-mail addresses',
    'evidence.snippet': 'Text that matched the rule',
    'span.near_background': 'Text in the background colour',
    'span.tiny_font': 'Very small text',
    'span.off_page': 'Text outside the page',
    'span.covered': 'Text covered by another object',
    'span.invisible_render': 'Invisible text',
    'span.zero_width': 'Zero-width characters',
    'span.word_vanish': 'Hidden Word text',
    'span.word_comment': 'Word comment',
    'span.word_deleted': 'Tracked deletion',
    'span.unknown': 'Hidden text',
    'meta.workspace': 'Workspace',
    'meta.source': 'Source',
    'meta.version': 'Version',
    'meta.uploader': 'Uploaded by',
    'meta.quarantined': 'Quarantined',
    'meta.none': 'Not recorded',
    'action.release': 'Release document',
    'action.releaseAria': 'Release document: {file}',
    'action.delete': 'Delete document',
    'action.deleteAria': 'Delete document: {file}',
    'action.keepQuarantine': 'Keep in quarantine',
    'action.keepDocument': 'Keep document',
    'action.refresh': 'Refresh quarantine',
    'action.loadMore': 'Load more documents',
    'release.title': 'Release {file} from quarantine?',
    'release.effect': 'The document becomes searchable at once.',
    'release.hidden': 'The hidden text stays removed and will not be searchable.',
    'release.links':
      'The listed link targets are recorded as reviewed for this document and are not flagged in its next version. The allowlist does not change.',
    'release.rules': 'The matched rules are recorded as reviewed for this document.',
    'release.unlocated': 'Hidden text that could not be removed: {count}. If you release the document, that text becomes searchable.',
    'release.approves': 'This upload is also awaiting approval. Releasing it approves it.',
    'release.running': 'Releasing…',
    'release.done': '{file} is released and searchable.',
    'delete.title': 'Delete {file}?',
    'delete.body': "The quarantined version is removed. This can't be undone.",
    'delete.running': 'Deleting…',
    'delete.done': '{file} is deleted.',
    'list.loading': 'Loading quarantined documents…',
    'list.unavailable': 'Quarantine is unavailable right now. Select Reload panel in a moment.',
    'list.loaded': 'Quarantined: {count}',
    'quarantine.empty.title': 'No quarantined documents',
    'quarantine.empty.body': 'Documents stopped by an injection rule, hidden text or a link outside the allowlist appear here.',
    'notChecked.description':
      'These documents are searchable. Their format has no hidden-text check: text from connectors, web pages, presentations and spreadsheets.',
    'notChecked.off': 'The hidden-text check is off, so no document is checked. Turn it on under Checks.',
    'notChecked.empty': 'Every stored document has been checked.',
    'notChecked.loading': 'Loading documents that were not checked…',
    'notChecked.unavailable': 'The list of documents that were not checked is unavailable right now. Select Reload panel in a moment.',
    'notChecked.caption': 'Documents without a hidden-text check',
    'col.file': 'File',
    'col.docType': 'Document type',
    'col.source': 'Source',
    'col.uploaded': 'Uploaded',
    'checks.heading': 'Checks at ingestion',
    'checks.col.check': 'Check',
    'checks.col.setting': 'Setting',
    'checks.col.effect': 'What it does now',
    'check.name.rules': 'Injection rules',
    'check.name.hidden': 'Hidden text',
    'check.name.links': 'Links',
    'check.rulesPointer': 'Set under RAG Modes.',
    'check.rules.value.off': 'Off',
    'check.rules.value.quarantine': 'Quarantine',
    'check.rules.off': 'Documents are not checked against the injection rules.',
    'check.rules.quarantine': 'A document that matches an injection rule is quarantined until an admin releases it.',
    'check.hidden.off': 'Documents are not checked for hidden text.',
    'check.hidden.flag': 'Hidden text is recorded on the document. The document is indexed unchanged.',
    'check.hidden.quarantine': 'Hidden text is removed and the document is quarantined until an admin releases it.',
    'check.links.off': 'Links in documents are not checked.',
    'check.links.flag': 'Link targets outside the allowlist are recorded on the document. The document is indexed.',
    'check.links.quarantine': 'A document with any link, domain or e-mail address outside the allowlist is quarantined.',
    'check.unknown': 'The value {code} is not one this page knows.',
    'allowlist.label': 'Allowed link domains',
    'allowlist.help': 'One domain per line, without https:// and without a path. Subdomains are included.',
    'allowlist.own': '{domain} is always allowed.',
    'allowlist.invalid': 'Not a domain: {line}. Write it like example.com.',
    'allowlist.refused': 'Not saved. The allowed link domains under Quarantine, Checks have lines that are not domains.',
    'warn.emptyAllowlist':
      'The allowlist is empty, so every document with a link, domain or e-mail address outside this app is quarantined. Add the domains your documents may link to.',
    'rescan.heading': 'Existing documents',
    'rescan.body': 'Saving a check does not check documents that are already stored.',
    'rescan.cli': 'Run this command on the server:',
    'rescan.unavailable': 'Whether stored documents can be rescanned is unknown right now. Select Reload panel in a moment.',
    'action.rescan': 'Rescan existing documents',
    'action.keepAsIs': 'Keep documents as they are',
    'rescan.title': 'Rescan existing documents?',
    'rescan.confirmBody':
      'Documents to check: {count}. A document that fails a check set to quarantine leaves the answers until an admin releases it.',
    'rescan.running': 'Starting…',
    'rescan.started': 'Rescan started. Follow it under Ingestion changes, Rebuilds.',
  },
  zh: {
    'panel.title': '隔离区',
    'panel.description':
      '因注入规则、隐藏文字或白名单之外的链接而未进入回答的文档、未做隐藏文字检查的文档，以及检查项本身。列出你管理的所有工作区。',
    'tabs.label': '隔离区视图',
    'tab.quarantined': '已隔离：{count}',
    'tab.notChecked': '未检查：{count}',
    'tab.checks': '检查项',
    'hold.quarantined': '未进入回答，原因：{reasons}。',
    'hold.kind.injection_rule': '注入规则',
    'hold.kind.hidden_text': '隐藏文字',
    'hold.kind.untrusted_link': '白名单之外的链接',
    'hold.kind.invoice_extraction': '发票字段',
    'hold.kind.unknown': '其他原因',
    'kind.injection_rule': '注入规则',
    'kind.hidden_text': '隐藏文字',
    'kind.untrusted_link': '白名单之外的链接',
    'kind.invoice_extraction': '发票字段',
    'reason.rules': '命中的规则：{rules}',
    'reason.hidden': '发现隐藏文字：{count}。已从文本中移除，无法被检索。',
    'reason.links': '白名单之外的链接目标：{count}',
    'reason.invoice': '无法安全地提取发票字段。',
    'reason.other': '因 {code} 被拦截。',
    'evidence.page': '第 {n} 页',
    'evidence.targets': '链接目标、域名和电子邮件地址',
    'evidence.snippet': '命中规则的文本',
    'span.near_background': '与背景同色的文字',
    'span.tiny_font': '极小字号的文字',
    'span.off_page': '页面范围之外的文字',
    'span.covered': '被其他对象遮住的文字',
    'span.invisible_render': '不可见文字',
    'span.zero_width': '零宽字符',
    'span.word_vanish': 'Word 隐藏文字',
    'span.word_comment': 'Word 批注',
    'span.word_deleted': '修订中已删除的文字',
    'span.unknown': '隐藏文字',
    'meta.workspace': '工作区',
    'meta.source': '来源',
    'meta.version': '版本',
    'meta.uploader': '上传者',
    'meta.quarantined': '隔离时间',
    'meta.none': '未记录',
    'action.release': '解除隔离',
    'action.releaseAria': '解除隔离：{file}',
    'action.delete': '删除文档',
    'action.deleteAria': '删除文档：{file}',
    'action.keepQuarantine': '继续隔离',
    'action.keepDocument': '保留文档',
    'action.refresh': '刷新隔离区',
    'action.loadMore': '加载更多文档',
    'release.title': '要解除对 {file} 的隔离吗？',
    'release.effect': '文档会立即可被检索。',
    'release.hidden': '隐藏文字仍保持移除状态，不会被检索到。',
    'release.links': '所列链接目标会记录为此文档已审核，其下一版本不再因此被标记。白名单不会改变。',
    'release.rules': '命中的规则会记录为此文档已审核。',
    'release.unlocated': '未能移除的隐藏文字：{count}。如果解除隔离，这些文字会被检索到。',
    'release.approves': '此上传同时在等待批准。解除隔离即表示批准。',
    'release.running': '正在解除隔离…',
    'release.done': '{file} 已解除隔离，可以检索。',
    'delete.title': '要删除 {file} 吗？',
    'delete.body': '被隔离的版本将被移除。此操作无法撤销。',
    'delete.running': '正在删除…',
    'delete.done': '{file} 已删除。',
    'list.loading': '正在加载被隔离的文档…',
    'list.unavailable': '暂时无法获取隔离区。请稍后选择“重新加载面板”。',
    'list.loaded': '已隔离：{count}',
    'quarantine.empty.title': '没有被隔离的文档',
    'quarantine.empty.body': '被注入规则、隐藏文字或白名单之外的链接拦截的文档会显示在这里。',
    'notChecked.description': '这些文档可以检索。它们的格式不支持隐藏文字检查：来自连接器的文本、网页、演示文稿和电子表格。',
    'notChecked.off': '隐藏文字检查已关闭，因此没有文档被检查。请在“检查项”中开启。',
    'notChecked.empty': '所有已入库文档都已检查。',
    'notChecked.loading': '正在加载未检查的文档…',
    'notChecked.unavailable': '暂时无法获取未检查文档的列表。请稍后选择“重新加载面板”。',
    'notChecked.caption': '未做隐藏文字检查的文档',
    'col.file': '文件',
    'col.docType': '文档类型',
    'col.source': '来源',
    'col.uploaded': '上传时间',
    'checks.heading': '入库时的检查',
    'checks.col.check': '检查项',
    'checks.col.setting': '设置',
    'checks.col.effect': '当前效果',
    'check.name.rules': '注入规则',
    'check.name.hidden': '隐藏文字',
    'check.name.links': '链接',
    'check.rulesPointer': '在“RAG 模式”中设置。',
    'check.rules.value.off': '关闭',
    'check.rules.value.quarantine': '隔离',
    'check.rules.off': '不按注入规则检查文档。',
    'check.rules.quarantine': '命中注入规则的文档会被隔离，直到管理员解除。',
    'check.hidden.off': '不检查文档中的隐藏文字。',
    'check.hidden.flag': '隐藏文字会记录在文档上。文档按原样入库。',
    'check.hidden.quarantine': '隐藏文字会被移除，文档被隔离，直到管理员解除。',
    'check.links.off': '不检查文档中的链接。',
    'check.links.flag': '白名单之外的链接目标会记录在文档上。文档照常入库。',
    'check.links.quarantine': '只要含有白名单之外的链接、域名或电子邮件地址，文档就会被隔离。',
    'check.unknown': '此页面不认识取值 {code}。',
    'allowlist.label': '允许的链接域名',
    'allowlist.help': '每行一个域名，不带 https:// 和路径。包含其子域名。',
    'allowlist.own': '{domain} 始终允许。',
    'allowlist.invalid': '不是域名：{line}。请写成 example.com 这样的形式。',
    'allowlist.refused': '未保存。“隔离区 → 检查项”中允许的链接域名里有不是域名的行。',
    'warn.emptyAllowlist': '白名单为空，因此凡是含有本应用之外的链接、域名或电子邮件地址的文档都会被隔离。请添加文档可以链接到的域名。',
    'rescan.heading': '已有文档',
    'rescan.body': '保存检查设置不会检查已入库的文档。',
    'rescan.cli': '在服务器上运行此命令：',
    'rescan.unavailable': '暂时无法确定能否重新扫描已入库的文档。请稍后选择“重新加载面板”。',
    'action.rescan': '重新扫描已有文档',
    'action.keepAsIs': '保持文档现状',
    'rescan.title': '要重新扫描已有文档吗？',
    'rescan.confirmBody': '待检查的文档：{count}。未通过“隔离”级别检查的文档会退出回答，直到管理员解除隔离。',
    'rescan.running': '正在开始…',
    'rescan.started': '重新扫描已开始。可在“入库设置变更 → 重建”中查看进度。',
  },
  it: {
    'panel.title': 'Quarantena',
    'panel.description':
      'I documenti esclusi dalle risposte da una regola di injection, da testo nascosto o da un link fuori dalla lista consentita, i documenti senza controllo del testo nascosto e i controlli stessi. Elenca tutti gli spazi di lavoro che amministri.',
    'tabs.label': 'Viste della quarantena',
    'tab.quarantined': 'In quarantena: {count}',
    'tab.notChecked': 'Non controllati: {count}',
    'tab.checks': 'Controlli',
    'hold.quarantined': 'Escluso dalle risposte: {reasons}.',
    'hold.kind.injection_rule': 'una regola di injection',
    'hold.kind.hidden_text': 'testo nascosto',
    'hold.kind.untrusted_link': 'link fuori dalla lista consentita',
    'hold.kind.invoice_extraction': 'campi della fattura',
    'hold.kind.unknown': 'un altro motivo',
    'kind.injection_rule': 'Regola di injection',
    'kind.hidden_text': 'Testo nascosto',
    'kind.untrusted_link': 'Link fuori dalla lista consentita',
    'kind.invoice_extraction': 'Campi della fattura',
    'reason.rules': 'Regole corrispondenti: {rules}',
    'reason.hidden': 'Testo nascosto trovato: {count}. È stato rimosso dal testo e non è ricercabile.',
    'reason.links': 'Destinazioni dei link fuori dalla lista consentita: {count}',
    'reason.invoice': 'Non è stato possibile estrarre i campi della fattura in modo sicuro.',
    'reason.other': 'Fermato per il motivo {code}.',
    'evidence.page': 'pagina {n}',
    'evidence.targets': 'Destinazioni dei link, domini e indirizzi e-mail',
    'evidence.snippet': 'Testo che corrisponde alla regola',
    'span.near_background': 'Testo nel colore dello sfondo',
    'span.tiny_font': 'Testo molto piccolo',
    'span.off_page': 'Testo fuori dalla pagina',
    'span.covered': 'Testo coperto da un altro oggetto',
    'span.invisible_render': 'Testo invisibile',
    'span.zero_width': 'Caratteri a larghezza zero',
    'span.word_vanish': 'Testo nascosto di Word',
    'span.word_comment': 'Commento di Word',
    'span.word_deleted': 'Eliminazione tracciata',
    'span.unknown': 'Testo nascosto',
    'meta.workspace': 'Spazio di lavoro',
    'meta.source': 'Origine',
    'meta.version': 'Versione',
    'meta.uploader': 'Caricato da',
    'meta.quarantined': 'In quarantena dal',
    'meta.none': 'Non registrato',
    'action.release': 'Rilascia documento',
    'action.releaseAria': 'Rilascia documento: {file}',
    'action.delete': 'Elimina documento',
    'action.deleteAria': 'Elimina documento: {file}',
    'action.keepQuarantine': 'Mantieni in quarantena',
    'action.keepDocument': 'Mantieni documento',
    'action.refresh': 'Aggiorna la quarantena',
    'action.loadMore': 'Carica altri documenti',
    'release.title': 'Rilasciare {file} dalla quarantena?',
    'release.effect': 'Il documento diventa subito ricercabile.',
    'release.hidden': 'Il testo nascosto resta rimosso e non sarà ricercabile.',
    'release.links':
      'Le destinazioni elencate vengono registrate come riviste per questo documento e non saranno segnalate nella versione successiva. La lista consentita non cambia.',
    'release.rules': 'Le regole corrispondenti vengono registrate come riviste per questo documento.',
    'release.unlocated':
      'Testo nascosto che non è stato possibile rimuovere: {count}. Se rilasci il documento, quel testo diventa ricercabile.',
    'release.approves': 'Questo caricamento è anche in attesa di approvazione. Rilasciandolo lo approvi.',
    'release.running': 'Rilascio…',
    'release.done': '{file} è stato rilasciato ed è ricercabile.',
    'delete.title': 'Eliminare {file}?',
    'delete.body': 'La versione in quarantena viene rimossa. L’operazione non può essere annullata.',
    'delete.running': 'Eliminazione…',
    'delete.done': '{file} è stato eliminato.',
    'list.loading': 'Caricamento dei documenti in quarantena…',
    'list.unavailable': 'La quarantena non è disponibile. Seleziona Ricarica pannello tra poco.',
    'list.loaded': 'In quarantena: {count}',
    'quarantine.empty.title': 'Nessun documento in quarantena',
    'quarantine.empty.body':
      'Qui appaiono i documenti fermati da una regola di injection, da testo nascosto o da un link fuori dalla lista consentita.',
    'notChecked.description':
      'Questi documenti sono ricercabili. Il loro formato non ha un controllo del testo nascosto: testo dai connettori, pagine web, presentazioni e fogli di calcolo.',
    'notChecked.off': 'Il controllo del testo nascosto è disattivato, quindi nessun documento viene controllato. Attivalo in Controlli.',
    'notChecked.empty': 'Tutti i documenti archiviati sono stati controllati.',
    'notChecked.loading': 'Caricamento dei documenti non controllati…',
    'notChecked.unavailable': 'L’elenco dei documenti non controllati non è disponibile. Seleziona Ricarica pannello tra poco.',
    'notChecked.caption': 'Documenti senza controllo del testo nascosto',
    'col.file': 'File',
    'col.docType': 'Tipo di documento',
    'col.source': 'Origine',
    'col.uploaded': 'Caricato',
    'checks.heading': 'Controlli in ingestione',
    'checks.col.check': 'Controllo',
    'checks.col.setting': 'Impostazione',
    'checks.col.effect': 'Che cosa fa ora',
    'check.name.rules': 'Regole di injection',
    'check.name.hidden': 'Testo nascosto',
    'check.name.links': 'Link',
    'check.rulesPointer': 'Si imposta in RAG Modes.',
    'check.rules.value.off': 'Disattivato',
    'check.rules.value.quarantine': 'Quarantena',
    'check.rules.off': 'I documenti non vengono controllati con le regole di injection.',
    'check.rules.quarantine': 'Un documento che corrisponde a una regola di injection va in quarantena finché un amministratore non lo rilascia.',
    'check.hidden.off': 'I documenti non vengono controllati per il testo nascosto.',
    'check.hidden.flag': 'Il testo nascosto viene registrato sul documento. Il documento è indicizzato senza modifiche.',
    'check.hidden.quarantine': 'Il testo nascosto viene rimosso e il documento va in quarantena finché un amministratore non lo rilascia.',
    'check.links.off': 'I link nei documenti non vengono controllati.',
    'check.links.flag': 'Le destinazioni fuori dalla lista consentita vengono registrate sul documento. Il documento è indicizzato.',
    'check.links.quarantine': 'Un documento con un link, un dominio o un indirizzo e-mail fuori dalla lista consentita va in quarantena.',
    'check.unknown': 'Il valore {code} non è noto a questa pagina.',
    'allowlist.label': 'Domini consentiti per i link',
    'allowlist.help': 'Un dominio per riga, senza https:// e senza percorso. I sottodomini sono inclusi.',
    'allowlist.own': '{domain} è sempre consentito.',
    'allowlist.invalid': 'Non è un dominio: {line}. Scrivilo come example.com.',
    'allowlist.refused': 'Non salvato. I domini consentiti in Quarantena, Controlli hanno righe che non sono domini.',
    'warn.emptyAllowlist':
      'La lista consentita è vuota, quindi ogni documento con un link, un dominio o un indirizzo e-mail esterno a questa app va in quarantena. Aggiungi i domini a cui i documenti possono rimandare.',
    'rescan.heading': 'Documenti esistenti',
    'rescan.body': 'Salvare un controllo non controlla i documenti già archiviati.',
    'rescan.cli': 'Esegui questo comando sul server:',
    'rescan.unavailable': 'Al momento non si sa se i documenti archiviati possano essere riesaminati. Seleziona Ricarica pannello tra poco.',
    'action.rescan': 'Riesamina i documenti esistenti',
    'action.keepAsIs': 'Mantieni i documenti come sono',
    'rescan.title': 'Riesaminare i documenti esistenti?',
    'rescan.confirmBody':
      'Documenti da controllare: {count}. Un documento che non supera un controllo impostato su quarantena esce dalle risposte finché un amministratore non lo rilascia.',
    'rescan.running': 'Avvio…',
    'rescan.started': 'Riesame avviato. Seguilo in Modifiche all’ingestione, Ricostruzioni.',
  },
};

const QUARANTINE_PATH = '/api/rag/admin/quarantine';
const QUARANTINE_COVERAGE_PATH = '/api/rag/admin/ingest-fingerprint';
const QUARANTINE_REBUILD_PATH = '/api/rag/admin/ingest-fingerprint/rebuild';
const QUARANTINE_PAGE = 50;
/** UI-SPEC 6.5.2: one reason group per kind, in this order. */
const QUARANTINE_KINDS = ['injection_rule', 'hidden_text', 'untrusted_link', 'invoice_extraction'];
const QUARANTINE_SPAN_REASONS = [
  'near_background',
  'tiny_font',
  'off_page',
  'covered',
  'invisible_render',
  'zero_width',
  'word_vanish',
  'word_comment',
  'word_deleted',
];
const QUARANTINE_CHECK_VALUES = ['off', 'flag', 'quarantine'];
const QUARANTINE_RULES_VALUES = ['off', 'quarantine'];
/** UI-SPEC 6.5.1: at most 5 spans or snippets and 10 targets render directly; the rest sit behind "Show all". */
const QUARANTINE_INLINE_SPANS = 5;
const QUARANTINE_INLINE_TARGETS = 10;

let quarantineUi = null;
if (typeof require !== 'undefined') {
  try {
    quarantineUi = require('./rag-ui.js');
  } catch {
    quarantineUi = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function quarantineUiLib() {
  if (quarantineUi) return quarantineUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

function quarantineLabel(key, locale, vars) {
  const ui = quarantineUiLib();
  const text = ui.ragUiLookup(QUARANTINE_LABELS, key, locale, vars);
  return text === undefined ? ui.ragUiLabel(key, locale, vars) : text;
}

function quarantineText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function quarantineStrings(list) {
  return (Array.isArray(list) ? list : []).filter((v) => v !== null && v !== undefined).map((v) => quarantineText(v));
}

function quarantineCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The pre-3.2 view model: file name, rule ids joined, snippets as plain strings. */
function buildQuarantineItemView(item) {
  const ruleIds = Array.isArray(item.rule_ids) ? item.rule_ids.join(', ') : String(item.rule_ids || '');
  const snippets = Array.isArray(item.snippets) ? item.snippets.map((s) => String(s)) : [];
  return {
    filename: String(item.filename || 'Unknown file'),
    ruleIds,
    snippets,
    tenant: String(item.tenant_key || ''),
    id: String(item.id || ''),
  };
}

function quarantineSpanCaption(reason, page, locale) {
  const known = QUARANTINE_SPAN_REASONS.includes(reason);
  const label = quarantineLabel(known ? 'span.' + reason : 'span.unknown', locale);
  const where = page === null ? '' : (locale === 'zh' ? '，' : ', ') + quarantineLabel('evidence.page', locale, { n: page });
  return label + where + (known || !reason ? '' : ' (' + reason + ')');
}

function quarantinePage(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isInteger(n) && n > 0 ? n : null;
}

/** One reason as the card needs it: named fields only, never a bounding box or a checker version (UI-SPEC 11.5). */
function quarantineGroup(kind, reason, item, locale) {
  const group = { kind, known: QUARANTINE_KINDS.includes(kind), rules: [], snippets: [], spans: [], targets: [], unlocated: 0 };
  const data = reason && typeof reason === 'object' ? reason : {};
  group.unlocated = quarantineCount(data.unlocated);
  if (kind === 'injection_rule') {
    group.rules = quarantineStrings(item.rule_ids);
    group.snippets = quarantineStrings(item.snippets);
  } else if (kind === 'hidden_text') {
    group.spans = (Array.isArray(data.spans) ? data.spans : [])
      .filter((span) => span && typeof span === 'object')
      .map((span) => {
        const page = quarantinePage(span.page);
        const reasonCode = quarantineText(span.reason);
        return { text: quarantineText(span.text), reason: reasonCode, page, caption: quarantineSpanCaption(reasonCode, page, locale) };
      });
  } else if (kind === 'untrusted_link') {
    group.targets = quarantineStrings(data.targets);
  }
  return group;
}

/**
 * The route answer for one held document (UI-SPEC 8.1). An item written before this phase has no reasons: its rule ids and
 * snippets become an injection_rule reason. Unknown kinds keep their code and come after the known ones.
 */
function quarantineItemView(item, locale) {
  const data = item && typeof item === 'object' ? item : {};
  const reasons = (Array.isArray(data.reasons) ? data.reasons : []).filter((r) => r && typeof r === 'object' && typeof r.kind === 'string');
  const byKind = new Map();
  for (const reason of reasons) if (!byKind.has(reason.kind)) byKind.set(reason.kind, reason);
  const hasRules = quarantineStrings(data.rule_ids).length > 0 || quarantineStrings(data.snippets).length > 0;
  if (!byKind.has('injection_rule') && (hasRules || byKind.size === 0)) byKind.set('injection_rule', null);
  const kinds = [...QUARANTINE_KINDS.filter((k) => byKind.has(k)), ...[...byKind.keys()].filter((k) => !QUARANTINE_KINDS.includes(k))];
  const groups = kinds.map((kind) => quarantineGroup(kind, byKind.get(kind), data, locale));
  const hiddenGroup = groups.find((g) => g.kind === 'hidden_text');
  const uploader = data.uploader && typeof data.uploader === 'object' ? data.uploader : null;
  const uploaderId = uploader ? quarantineText(uploader.id) : '';
  const uploaderDisplay = uploader ? quarantineText(uploader.display) : '';
  return {
    id: quarantineText(data.id),
    file: quarantineText(data.filename) || quarantineText(data.id),
    workspace: quarantineText(data.tenant_key),
    source: quarantineText(data.source),
    version: Number.isFinite(Number(data.version)) && data.version !== null ? Number(data.version) : null,
    quarantinedAt: quarantineText(data.quarantined_at),
    uploader: uploaderId || uploaderDisplay ? { id: uploaderId, display: uploaderDisplay || uploaderId, isId: !uploaderDisplay || uploaderDisplay === uploaderId } : null,
    pendingApproval: data.pending_approval === true,
    unlocated: Math.max(quarantineCount(data.unlocated), hiddenGroup ? hiddenGroup.unlocated : 0),
    groups,
  };
}

function quarantineListView(body, locale) {
  const data = body && typeof body === 'object' ? body : {};
  const items = (Array.isArray(data.items) ? data.items : []).map((item) => quarantineItemView(item, locale)).filter((v) => v.id);
  const total = Number.isFinite(Number(data.total)) ? Math.max(Number(data.total), items.length) : items.length;
  return { total, items };
}

/** "hidden text and links outside the allowlist", joined the way the locale joins a list. */
function quarantineHoldReasons(groups, locale) {
  const parts = groups.map((g) => quarantineLabel(g.known ? 'hold.kind.' + g.kind : 'hold.kind.unknown', locale));
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(unique);
  } catch {
    return unique.join(locale === 'zh' ? '、' : ', ');
  }
}

/** The release dialog's consequence sentences for the reasons present (UI-SPEC 12.4). */
function quarantineReleaseLines(view, locale) {
  const kinds = new Set(view.groups.map((g) => g.kind));
  const lines = [quarantineLabel('release.effect', locale)];
  if (kinds.has('hidden_text')) lines.push(quarantineLabel('release.hidden', locale));
  if (kinds.has('untrusted_link')) lines.push(quarantineLabel('release.links', locale));
  if (kinds.has('injection_rule')) lines.push(quarantineLabel('release.rules', locale));
  if (view.pendingApproval) lines.push(quarantineLabel('release.approves', locale));
  return lines;
}

class QuarantinePanel {
  constructor(root) {
    this.root = root;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.locale = quarantineUiLib().ragUiBrowserLocale();
    this.tabs = null;
    this.listHost = null;
    this.view = null;
    this.loadSeq = 0;
    this.loading = false;
    this.loadAlert = null;
    this.alertHost = null;
    this.refreshButton = null;
    this.updatedAt = null;
  }

  t(key, vars) {
    return quarantineLabel(key, this.locale, vars);
  }

  el(tag, options, children) {
    return quarantineUiLib().ragUiEl(this.doc, tag, options, children);
  }

  statusEl() {
    return this.root.querySelector('[data-rag-quarantine-status]');
  }

  announce(text, isError) {
    const host = this.statusEl();
    if (!host) return;
    host.classList.toggle('text-error', Boolean(isError));
    if (isError) host.replaceChildren(quarantineUiLib().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text }));
    else host.textContent = text;
  }

  focusStatus() {
    const host = this.statusEl();
    if (host && typeof host.focus === 'function') host.focus();
  }

  async mount() {
    const ui = quarantineUiLib();
    this.root.setAttribute('lang', this.locale);
    this.root.classList.add('min-w-0', 'scroll-mt-4');
    const title = this.root.querySelector('h3');
    if (title) {
      title.textContent = this.t('panel.title');
      title.classList.add('text-balance');
    }
    const status = this.statusEl();
    if (status) {
      status.setAttribute('tabindex', '-1');
      status.classList.remove('mb-2');
      status.classList.add('mt-4');
    }
    const oldRefresh = this.root.querySelector('[data-rag-quarantine-refresh]');
    if (oldRefresh) oldRefresh.remove();
    const list = this.root.querySelector('[data-rag-quarantine-list]');
    const description = this.el('p', { className: 'text-sm text-base-content/70 max-w-prose mb-4', text: this.t('panel.description') });
    this.alertHost = this.el('div', { className: 'flex flex-col gap-2 empty:hidden mb-4', attrs: { 'data-quarantine-alert': '' } });
    this.tabs = ui.ragUiSubTabs(this.doc, {
      label: this.t('tabs.label'),
      idPrefix: 'rag-quarantine',
      tabs: [
        { id: 'quarantined', label: this.t('tab.quarantined', { count: '…' }) },
        { id: 'not-checked', label: this.t('tab.notChecked', { count: '…' }) },
        { id: 'checks', label: this.t('tab.checks') },
      ],
      selected: 'quarantined',
      onSelect: (id) => this.onSelect(id),
    });
    this.listHost = this.el('div', { className: 'min-w-0' });
    this.tabs.panels.quarantined.appendChild(this.listHost);
    const content = this.el('div', { className: 'min-w-0' }, [
      description,
      this.alertHost,
      this.tabs.tablist,
      this.tabs.panels.quarantined,
      this.tabs.panels['not-checked'],
      this.tabs.panels.checks,
    ]);
    if (list && list.parentNode) {
      list.parentNode.insertBefore(content, list);
      list.remove();
    }    else if (title && title.parentNode) title.parentNode.appendChild(content);
    if (status && status.parentNode) status.parentNode.appendChild(status);
    await this.loadList('first');
  }

  onSelect(_id) {}

  async refresh() {
    await this.loadList('refresh');
  }

  renderAlerts() {
    if (!this.alertHost) return;
    this.alertHost.replaceChildren(...(this.loadAlert ? [this.loadAlert] : []));
  }

  setTabCount(id, key, total) {
    const tab = this.doc.getElementById('rag-quarantine-tab-' + id);
    if (tab) tab.textContent = this.t(key, { count: typeof total === 'number' ? quarantineUiLib().ragUiFormatNumber(total, this.locale) : total });
  }

  formatTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return quarantineText(value);
    try {
      return new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  timeEl(value) {
    if (!value) return this.el('span', { text: this.t('meta.none') });
    const date = new Date(value);
    const valid = !Number.isNaN(date.getTime());
    return this.el('time', { className: 'tabular-nums', text: this.formatTime(value), attrs: { datetime: valid ? date.toISOString() : null } });
  }

  codeEl(value) {
    return this.el('code', { className: 'font-mono text-xs break-all', text: value, attrs: { translate: 'no' } });
  }

  emptyBlock(title, body) {
    return this.el('div', { className: 'py-8 text-center' }, [
      this.el('p', { className: 'text-base font-semibold text-balance', text: title }),
      body ? this.el('p', { className: 'text-sm text-base-content/70 mt-2 max-w-prose mx-auto', text: body }) : null,
    ]);
  }

  /** First load, refresh, sign-in and unavailable states of a list (UI-SPEC 7.1). Returns the result when it is usable. */
  async request(host, apiPath, { source, loadingText, unavailable, hadContent, button }) {
    const ui = quarantineUiLib();
    if (hadContent) ui.ragUiListBusy(host, true);
    else ui.ragUiListLoading(this.doc, host, loadingText);
    const restore = button && button.isConnected !== false && source !== 'first' ? ui.ragUiButtonBusy(this.doc, button, loadingText) : null;
    let result;
    try {
      result = await ui.ragUiRagRequest(apiPath, { method: 'GET' });
    } finally {
      if (restore) restore();
    }
    return { result, mapped: result && result.ok && result.body && typeof result.body === 'object' ? null : ui.ragUiMapError(result, this.locale, { unavailable }) };
  }

  /** A failed list load: sign-in replaces the view, other failures keep earlier content dimmed under an error alert. */
  showLoadFailure(host, mapped, hasContent, reload, setAlert) {
    const ui = quarantineUiLib();
    ui.ragUiListBusy(host, false);
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      host.replaceChildren(
        mapped.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, reload)
          : ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [mapped.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, reload)] }),
      );
      setAlert(null);
      return false;
    }
    setAlert(ui.ragUiUnavailableAlert(this.doc, this.locale, mapped.message, reload));
    if (hasContent) ui.ragUiListBusy(host, true, true);
    else host.replaceChildren();
    return true;
  }

  async loadList(source, offset) {
    if (!this.listHost) return;
    const ui = quarantineUiLib();
    const append = source === 'more';
    if (this.loading && !append && source !== 'first') return;
    const seq = ++this.loadSeq;
    this.loading = true;
    const hadContent = Boolean(this.view);
    const params = new URLSearchParams({ limit: String(QUARANTINE_PAGE), offset: String(append ? offset || 0 : 0) });
    const button = append ? this.root.querySelector('[data-quarantine-more]') : this.refreshButton;
    let outcome;
    try {
      outcome = await this.request(this.listHost, QUARANTINE_PATH + '?' + params.toString(), {
        source,
        loadingText: this.t('list.loading'),
        unavailable: this.t('list.unavailable'),
        hadContent: hadContent && !append,
        button,
      });
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
    if (seq !== this.loadSeq) return;
    const { result, mapped } = outcome;
    if (!mapped) {
      const next = quarantineListView(result.body, this.locale);
      let firstNew = null;
      if (append && this.view) {
        const known = new Set(this.view.items.map((v) => v.id));
        const added = next.items.filter((v) => !known.has(v.id));
        firstNew = added[0] ? added[0].id : null;
        this.view = { total: next.total, items: [...this.view.items, ...added] };
      } else {
        this.view = next;
      }
      this.updatedAt = new Date();
      this.loadAlert = null;
      this.renderAlerts();
      ui.ragUiListBusy(this.listHost, false);
      this.setTabCount('quarantined', 'tab.quarantined', this.view.total);
      this.renderList();
      if (firstNew) this.focusCard(firstNew);
      if (!append) this.announce(this.t('list.loaded', { count: ui.ragUiFormatNumber(this.view.total, this.locale) }));
      return;
    }
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') this.view = null;
    this.showLoadFailure(this.listHost, mapped, Boolean(this.view), () => this.refresh(), (alert) => {
      this.loadAlert = alert;
      this.renderAlerts();
    });
    if (!this.view) this.setTabCount('quarantined', 'tab.quarantined', '—');
    this.announce(mapped.message, true);
  }

  renderToolbar() {
    const ui = quarantineUiLib();
    this.refreshButton = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.refresh'), attrs: { type: 'button' } });
    this.refreshButton.addEventListener('click', () => this.loadList('refresh'));
    return this.el('div', { className: 'flex flex-wrap items-center justify-between gap-2 mb-4' }, [
      this.el('p', { className: 'text-xs text-base-content/70', text: this.updatedAt ? ui.ragUiLabel('panel.updated', this.locale, { time: this.formatTime(this.updatedAt) }) : '' }),
      this.refreshButton,
    ]);
  }

  renderList() {
    if (!this.view || !this.listHost) return;
    const nodes = [this.renderToolbar()];
    if (!this.view.items.length) {
      nodes.push(this.emptyBlock(this.t('quarantine.empty.title'), this.t('quarantine.empty.body')));
    } else {
      for (const item of this.view.items) nodes.push(this.renderCard(item));
      if (this.view.items.length < this.view.total) {
        const more = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.loadMore'), attrs: { type: 'button', 'data-quarantine-more': '' } });
        more.addEventListener('click', () => this.loadList('more', this.view ? this.view.items.length : 0));
        nodes.push(more);
      }
    }
    this.listHost.replaceChildren(...nodes);
  }

  focusCard(id) {
    const button = this.root.querySelector('[data-quarantine-release="' + id + '"]');
    if (button && typeof button.focus === 'function') button.focus();
  }

  metaItem(label, value) {
    return this.el('div', { className: 'flex flex-wrap gap-x-1 min-w-0' }, [
      this.el('dt', { className: 'font-semibold', text: label }),
      this.el('dd', { className: 'min-w-0 break-words' }, [typeof value === 'string' ? this.el('span', { text: value }) : value]),
    ]);
  }

  renderMeta(item) {
    const uploader = !item.uploader
      ? this.el('span', { text: this.t('meta.none') })
      : item.uploader.isId
        ? this.codeEl(item.uploader.id)
        : this.el('span', { className: '[overflow-wrap:anywhere]', text: item.uploader.display });
    return this.el('dl', { className: 'flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/70 mt-2' }, [
      item.workspace ? this.metaItem(this.t('meta.workspace'), this.codeEl(item.workspace)) : null,
      item.source ? this.metaItem(this.t('meta.source'), this.codeEl(item.source)) : null,
      item.version !== null ? this.metaItem(this.t('meta.version'), this.el('span', { className: 'tabular-nums', text: String(item.version) })) : null,
      this.metaItem(this.t('meta.uploader'), uploader),
      this.metaItem(this.t('meta.quarantined'), this.timeEl(item.quarantinedAt)),
    ]);
  }

  /** The hold-line badge with base-content text on a warning border: outline warning text is below 4.5:1 on the light theme. */
  readableBadge(holdLine) {
    const badge = holdLine && holdLine.querySelector('.badge');
    if (!badge) return;
    badge.classList.remove('badge-warning');
    badge.classList.add('border-warning', 'text-base-content');
    const icon = badge.querySelector('i');
    if (icon) icon.classList.add('text-warning');
  }

  renderCard(item) {
    const ui = quarantineUiLib();
    const release = this.el('button', {
      className: 'btn btn-primary md:btn-sm',
      text: this.t('action.release'),
      attrs: { type: 'button', 'aria-label': this.t('action.releaseAria', { file: item.file }), 'data-quarantine-release': item.id },
    });
    const remove = this.el('button', {
      className: 'btn btn-outline btn-error md:btn-sm',
      text: this.t('action.delete'),
      attrs: { type: 'button', 'aria-label': this.t('action.deleteAria', { file: item.file }), 'data-quarantine-delete': item.id },
    });
    release.addEventListener('click', () => this.release(item, release, remove));
    remove.addEventListener('click', () => this.remove(item, remove, release));
    const hold = ui.ragUiHoldLine(this.doc, {
      tone: 'warning',
      icon: 'shield-exclamation',
      word: ui.ragUiLabel('status.quarantined', this.locale),
      reason: this.t('hold.quarantined', { reasons: quarantineHoldReasons(item.groups, this.locale) }),
      action: release,
    });
    hold.setAttribute('data-quarantine-hold', '');
    this.readableBadge(hold);
    const children = [
      this.el('h4', { className: 'text-base font-semibold break-words mb-2', text: item.file }),
      hold,
      this.renderMeta(item),
    ];
    for (const group of item.groups) children.push(this.renderGroup(group));
    if (item.unlocated > 0) {
      children.push(
        ui.ragUiAlert(this.doc, {
          tone: 'warning',
          icon: 'exclamation-triangle',
          body: [this.t('release.unlocated', { count: ui.ragUiFormatNumber(item.unlocated, this.locale) })],
          className: 'mt-4',
        }),
      );
    }
    children.push(this.el('div', { className: 'flex flex-wrap gap-2 mt-4' }, [remove]));
    return this.el('article', { className: 'border border-base-300 rounded-lg p-4 mb-4 min-w-0', attrs: { 'data-quarantine-card': item.id } }, children);
  }

  kindBadge(group) {
    const icons = { injection_rule: 'chat-left-quote', hidden_text: 'eye-slash', untrusted_link: 'link-45deg', invoice_extraction: 'receipt' };
    const ui = quarantineUiLib();
    return this.el('span', { className: 'badge badge-outline badge-sm gap-1 shrink-0' }, [
      ui.ragUiIcon(this.doc, group.known ? icons[group.kind] : 'question-circle'),
      group.known ? this.el('span', { text: this.t('kind.' + group.kind) }) : this.el('span', { className: 'font-mono', text: group.kind, attrs: { translate: 'no' } }),
    ]);
  }

  detailNodes(group) {
    const ui = quarantineUiLib();
    const fmt = (n) => ui.ragUiFormatNumber(n, this.locale);
    switch (group.kind) {
      case 'injection_rule':
        return group.rules.length ? ui.ragUiTemplateNodes(this.doc, this.t('reason.rules'), { rules: group.rules.join(', ') }, ['rules']) : [];
      case 'hidden_text':
        return [this.doc.createTextNode(this.t('reason.hidden', { count: fmt(group.spans.length) }))];
      case 'untrusted_link':
        return [this.doc.createTextNode(this.t('reason.links', { count: fmt(group.targets.length) }))];
      case 'invoice_extraction':
        return [this.doc.createTextNode(this.t('reason.invoice'))];
      default:
        return [ui.ragUiCodeSentence(this.doc, this.locale, group.kind, this.t('reason.other'))];
    }
  }

  /** Items beyond the inline limit sit inside a disclosure "Show all: {count}". */
  withDisclosure(nodes, limit) {
    if (nodes.length <= limit) return nodes;
    const ui = quarantineUiLib();
    const details = this.el('details', { className: 'mt-2' }, [
      this.el('summary', {
        className: 'cursor-pointer text-sm rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        text: ui.ragUiLabel('evidence.showAll', this.locale, { count: ui.ragUiFormatNumber(nodes.length, this.locale) }),
      }),
      this.el('div', { className: 'flex flex-col gap-2 mt-2' }, nodes.slice(limit)),
    ]);
    return [...nodes.slice(0, limit), details];
  }

  targetFigure(targets) {
    const ui = quarantineUiLib();
    const caption = this.t('evidence.targets');
    const item = (target) =>
      this.el('li', { className: 'min-w-0' }, [this.el('code', { className: 'font-mono text-xs break-all', text: ui.ragUiVisibleControls(target), attrs: { translate: 'no' } })]);
    const inline = targets.slice(0, QUARANTINE_INLINE_TARGETS).map(item);
    const rest = targets.slice(QUARANTINE_INLINE_TARGETS).map(item);
    const figure = this.el('figure', { className: 'border-l-4 border-warning bg-base-100 rounded-r-lg p-2 min-w-0' }, [
      this.el('figcaption', { className: 'text-xs text-base-content/70 mb-1 break-words', text: caption }),
      this.el(
        'ul',
        {
          className: 'flex flex-col gap-1 max-h-40 overflow-y-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
          attrs: { tabindex: '0', role: 'region', 'aria-label': caption, translate: 'no' },
        },
        inline,
      ),
    ]);
    if (rest.length) {
      figure.appendChild(
        this.el('details', { className: 'mt-2' }, [
          this.el('summary', {
            className: 'cursor-pointer text-sm rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
            text: ui.ragUiLabel('evidence.showAll', this.locale, { count: ui.ragUiFormatNumber(targets.length, this.locale) }),
          }),
          this.el('ul', { className: 'flex flex-col gap-1 mt-2', attrs: { translate: 'no' } }, rest),
        ]),
      );
    }
    return figure;
  }

  renderGroup(group) {
    const ui = quarantineUiLib();
    const evidence = [];
    if (group.kind === 'injection_rule') {
      for (const snippet of group.snippets) {
        evidence.push(ui.ragUiEvidence(this.doc, { tone: 'untrusted', caption: this.t('evidence.snippet'), text: snippet, locale: this.locale }));
      }
    } else if (group.kind === 'hidden_text') {
      for (const span of group.spans) {
        evidence.push(ui.ragUiEvidence(this.doc, { tone: 'untrusted', caption: span.caption, text: span.text, locale: this.locale }));
      }
    }
    const blocks = [];
    if (evidence.length) blocks.push(...this.withDisclosure(evidence, QUARANTINE_INLINE_SPANS));
    if (group.kind === 'untrusted_link' && group.targets.length) blocks.push(this.targetFigure(group.targets));
    const detail = this.detailNodes(group);
    const children = [
      this.el('div', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [
        this.kindBadge(group),
        detail.length ? this.el('span', { className: 'text-sm min-w-0 break-words' }, detail) : null,
      ]),
    ];
    if (blocks.length) {
      children.push(this.el('p', { className: 'text-xs text-base-content/70 mt-2', text: ui.ragUiLabel('evidence.inert', this.locale) }));
      children.push(this.el('div', { className: 'flex flex-col gap-2 mt-1 min-w-0' }, blocks));
    }
    return this.el('section', { className: 'mt-4 min-w-0', attrs: { 'data-quarantine-reason': group.kind } }, children);
  }

  actionPath(item, release) {
    return QUARANTINE_PATH + '/' + encodeURIComponent(item.id) + (release ? '/release' : '');
  }

  /** A failed release or delete: someone else changed it, a sign-in is needed, or the error sentence is shown. */
  async actionFailed(result) {
    const ui = quarantineUiLib();
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('list.unavailable') });
    if (mapped.kind === 'changed') {
      await this.loadList('refresh');
      this.announce(mapped.message, true);
      this.focusStatus();
      return;
    }
    if (mapped.kind === 'signIn') {
      await this.loadList('first');
      return;
    }
    this.announce(mapped.message, true);
  }

  async decide(item, opener, sibling, release) {
    const ui = quarantineUiLib();
    let result = null;
    const body = release
      ? [...quarantineReleaseLines(item, this.locale)].map((line) => this.el('p', { className: 'mb-2', text: line }))
      : [this.el('p', { text: this.t('delete.body') })];
    if (release && item.unlocated > 0) {
      body.push(
        ui.ragUiAlert(this.doc, {
          tone: 'warning',
          icon: 'exclamation-triangle',
          body: [this.t('release.unlocated', { count: ui.ragUiFormatNumber(item.unlocated, this.locale) })],
        }),
      );
    }
    const confirmed = await ui.ragUiConfirmDialog(this.doc, {
      title: this.t(release ? 'release.title' : 'delete.title', { file: item.file }),
      body,
      keepLabel: this.t(release ? 'action.keepQuarantine' : 'action.keepDocument'),
      confirmLabel: this.t(release ? 'action.release' : 'action.delete'),
      runningLabel: this.t(release ? 'release.running' : 'delete.running'),
      tone: release ? 'primary' : 'error',
      opener,
      fallbackFocus: this.statusEl(),
      onConfirm: async () => {
        result = await ui.ragUiRagRequest(this.actionPath(item, release), release ? { method: 'POST', body: '{}' } : { method: 'DELETE' });
      },
    });
    if (!confirmed || !result) return;
    if (result.ok) {
      await this.loadList('refresh');
      this.announce(this.t(release ? 'release.done' : 'delete.done', { file: item.file }));
      this.focusStatus();
      return;
    }
    if (sibling) sibling.disabled = false;
    await this.actionFailed(result);
  }

  release(item, button, sibling) {
    return this.decide(item, button, sibling, true);
  }

  remove(item, button, sibling) {
    return this.decide(item, button, sibling, false);
  }
}

let quarantinePanelInstance = null;

function initQuarantinePanel() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rag-administration-quarantine');
  if (!root) return null;
  if (!quarantinePanelInstance) {
    quarantinePanelInstance = new QuarantinePanel(root);
    if (typeof window !== 'undefined') window.quarantinePanel = quarantinePanelInstance;
    return quarantinePanelInstance.mount();
  }
  return quarantinePanelInstance.refresh();
}

/** UI-SPEC finding 13: every RAG administration link, desktop and mobile drawer, starts the panel; each is bound once. */
function quarantineBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-quarantine-bound')) return;
    link.setAttribute('data-quarantine-bound', '1');
    link.addEventListener('click', () => initQuarantinePanel());
  });
}

if (typeof window !== 'undefined') {
  window.QUARANTINE_LABELS = QUARANTINE_LABELS;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initQuarantinePanel = initQuarantinePanel;
  quarantineBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    quarantineBindPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initQuarantinePanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    QUARANTINE_LABELS,
    buildQuarantineItemView,
    quarantineItemView,
    quarantineListView,
    quarantineHoldReasons,
    quarantineReleaseLines,
    QuarantinePanel,
    initQuarantinePanel,
  };
}
