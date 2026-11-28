/**
 * Purge dialog, purge receipt and Purge records panel (Phase 6.3, D-12, D-16, D-18, D-34, D-35) — plain-text DOM only.
 * Records hold ids only; the file name is on screen only while the dialog that started the purge is open.
 */

const PURGE_LABELS = {
  en: {
    "panel.title": "Purge records",
    "panel.description": "Every purge, started by an admin or by a connection in Purge mode, with its reason and what the check found afterwards. Records hold ids only, never file names or text. To purge a document, use Purge in the Documents table under Document Processing.",
    "action.openDocuments": "Open Document Processing",
    "action.refresh": "Refresh records",
    "action.loadMore": "Load more records",
    "action.reload": "Reload panel",
    "list.loading": "Loading purge records…",
    "list.loaded": "Purge records loaded: {count}.",
    "list.updatedAt": "Updated {time}",
    "list.empty.title": "No purge records",
    "list.empty.body": "Nothing has been purged in the workspaces you administer.",
    "list.unavailable": "Purge records could not be loaded. Check that the main app is running, then select Reload panel.",
    "table.caption": "Purge records, newest first",
    "col.when": "When",
    "col.who": "Started by",
    "col.reason": "Reason",
    "col.document": "Document",
    "col.result": "Check",
    "who.admin": "Admin {id}",
    "who.sourceSync": "Source sync, {connection}",
    "document.versions": "Versions: {count}",
    "note.none": "No note",
    "result.verified": "Nothing left",
    "result.pending": "Cleanup pending",
    "result.remaining": "Rows left: {count}",
    "result.unchecked": "Not checked",
    "result.noCheck": "No check has run for this record.",
    "action.details": "Show check",
    "action.verify": "Check again",
    "action.verifyAria": "Check purge record {id} again",
    "verify.running": "Checking…",
    "verify.done": "Checked {time}.",
    "ledger.caption": "Check after purge, by store",
    "ledger.col.store": "Store",
    "ledger.col.removed": "Removed",
    "ledger.col.left": "Left",
    "ledger.notReported": "Not reported",
    "ledger.leftSr": "rows still left in this store",
    "ledger.pendingFiles": "Stored files waiting for cleanup: {count}.",
    "ledger.pendingHelp": "The next scheduled reconcile tries again.",
    "ledger.queued": "Deletions queued for the external index: {count}.",
    "ledger.notCovered": "Not reached by a purge: ids in the retrieval log and the review queue (no text, short retention), and traces already sent to the tracing service.",
    "dialog.title": "Purge “{name}”?",
    "dialog.what": "Removes every version of this document and everything built from it, from every store: chunks, search vectors, cached answers, stored files and page images. Past answers keep their citation number and show “Source withdrawn” instead of the quoted text. This cannot be undone.",
    "dialog.vsDelete": "Delete removes the document and its chunks. Purge also clears cached answers, ingestion records, page images and the quoted text in past chats, and writes a purge record.",
    "dialog.connector": "This file came from a connected source. After a purge, later syncs skip it even while it is still at the source.",
    "dialog.reasonLabel": "Reason",
    "dialog.reasonPlaceholder": "Choose a reason",
    "dialog.noteLabel": "Note",
    "dialog.noteOptional": "optional",
    "dialog.noteRequired": "required for Other",
    "dialog.noteHelp": "Say why, not what the document contains. The note is kept in the purge record. Up to 500 characters.",
    "dialog.needReason": "Choose a reason to continue.",
    "dialog.needNote": "Add a note for Other.",
    "action.keep": "Keep document",
    "action.purge": "Purge document",
    "dialog.purging": "Purging…",
    "result.title.verified": "Purged. Nothing left.",
    "result.title.pending": "Purged. Cleanup is not finished.",
    "result.title.remaining": "Purged, but rows are left.",
    "result.body.pending": "The database rows are gone. Some stored files could not be removed yet; the next scheduled reconcile tries again. Select Check again in Purge records to see the current state.",
    "result.body.remaining": "The check found rows in the stores marked below. Select Check again in Purge records; if rows are still left, report it with record id {id}.",
    "action.close": "Close dialog",
    "action.openRecords": "Open purge records",
    "error.notFound": "This document no longer exists or is not in a workspace you administer. Nothing was removed.",
    "error.readOnly": "The document dashboard is read-only, so purging is turned off. Nothing was removed.",
    "error.invalidReason": "The reason was not accepted. Choose a reason and, for Other, add a note.",
    "error.failed": "The purge did not finish. Open Purge records to see whether a record was written before trying again.",
    "error.recordGone": "This record no longer exists. The list was reloaded.",
    "error.off": "Purge records are not available in this deployment: the feature is switched off, or the main app is a version without it. There is nothing to show here.",
    "reason.owner_request": "Requested by the content owner",
    "reason.added_in_error": "Added by mistake",
    "reason.retention_ended": "Retention period ended",
    "reason.legal_or_policy": "Legal or policy requirement",
    "reason.restricted_content": "Contains content that must not be stored",
    "reason.other": "Other (describe in the note)",
    "reason.source_deleted": "Deleted at the source",
    "store.documents": "Document versions",
    "store.chunks": "Text chunks",
    "store.vectors": "Search vectors",
    "store.parents": "Parent chunks",
    "store.ingestion_jobs": "Ingestion records",
    "store.parse_cache": "Parse cache",
    "store.semantic_cache": "Cached answers",
    "store.answer_citations": "Quoted text in answer records",
    "store.chat_messages": "Quoted text in saved chats",
    "store.table_rows": "Table rows",
    "store.duplicate_groups": "Duplicate groups",
    "store.translations": "Stored translations",
    "store.original_files": "Original and parsed files",
    "store.parse_cache_files": "Parse cache files",
    "store.page_images": "Page images",
    "store.uploaded_image": "Uploaded image",
    "store.sync_records": "Connector sync records",
  },
  zh: {
    "panel.title": "清除记录",
    "panel.description": "每一次彻底清除（由管理员发起，或由处于彻底清除方式的连接触发）及其原因和清除后的检查结果。记录只保存 ID，不保存文件名或正文。要彻底清除文档，请在 Document Processing 的文档表中使用 Purge。",
    "action.openDocuments": "打开 Document Processing",
    "action.refresh": "刷新记录",
    "action.loadMore": "加载更多记录",
    "action.reload": "重新加载面板",
    "list.loading": "正在加载清除记录…",
    "list.loaded": "已加载清除记录：{count}。",
    "list.updatedAt": "更新于 {time}",
    "list.empty.title": "没有清除记录",
    "list.empty.body": "你管理的工作区中尚未彻底清除任何内容。",
    "list.unavailable": "无法加载清除记录。请确认主应用正在运行，然后选择“重新加载面板”。",
    "table.caption": "清除记录，最新在前",
    "col.when": "时间",
    "col.who": "发起方",
    "col.reason": "原因",
    "col.document": "文档",
    "col.result": "检查",
    "who.admin": "管理员 {id}",
    "who.sourceSync": "来源同步，{connection}",
    "document.versions": "版本：{count}",
    "note.none": "没有备注",
    "result.verified": "无残留",
    "result.pending": "清理未完成",
    "result.remaining": "残留行：{count}",
    "result.unchecked": "未检查",
    "result.noCheck": "此记录尚未进行检查。",
    "action.details": "显示检查结果",
    "action.verify": "重新检查",
    "action.verifyAria": "重新检查清除记录 {id}",
    "verify.running": "正在检查…",
    "verify.done": "检查于 {time}。",
    "ledger.caption": "清除后按存储检查",
    "ledger.col.store": "存储",
    "ledger.col.removed": "已移除",
    "ledger.col.left": "残留",
    "ledger.notReported": "未报告",
    "ledger.leftSr": "该存储中仍有残留行",
    "ledger.pendingFiles": "等待清理的已存储文件：{count}。",
    "ledger.pendingHelp": "下一次计划内的核对会重试。",
    "ledger.queued": "排队等待外部索引删除：{count}。",
    "ledger.notCovered": "彻底清除不会触及：检索日志和审核队列中的 ID（不含正文，保留期短），以及已发送到追踪服务的记录。",
    "dialog.title": "彻底清除“{name}”？",
    "dialog.what": "将从每个存储中移除该文档的所有版本及由其生成的全部内容：文本块、检索向量、缓存的回答、已存储的文件和页面图片。过往回答保留引用编号，但显示“来源已撤回”，不再显示引用的原文。此操作无法撤销。",
    "dialog.vsDelete": "Delete 会移除文档及其文本块。Purge 还会清除缓存的回答、摄取记录、页面图片和过往对话中引用的原文，并写入一条清除记录。",
    "dialog.connector": "该文件来自已连接的来源。彻底清除后，即使文件仍在来源中，之后的同步也会跳过它。",
    "dialog.reasonLabel": "原因",
    "dialog.reasonPlaceholder": "选择原因",
    "dialog.noteLabel": "备注",
    "dialog.noteOptional": "可选",
    "dialog.noteRequired": "选择“其他”时必填",
    "dialog.noteHelp": "请说明原因，不要写文档的内容。备注会保存在清除记录中。最多 500 个字符。",
    "dialog.needReason": "请先选择原因。",
    "dialog.needNote": "选择“其他”时请填写备注。",
    "action.keep": "保留文档",
    "action.purge": "彻底清除文档",
    "dialog.purging": "正在清除…",
    "result.title.verified": "已彻底清除。无残留。",
    "result.title.pending": "已彻底清除。清理尚未完成。",
    "result.title.remaining": "已清除，但仍有残留行。",
    "result.body.pending": "数据库中的行已移除。部分已存储的文件暂时未能移除，下一次计划内的核对会重试。在“清除记录”中选择“重新检查”可查看当前状态。",
    "result.body.remaining": "检查在下方标记的存储中发现了残留行。请在“清除记录”中选择“重新检查”；如果仍有残留，请连同记录 ID {id} 一并报告。",
    "action.close": "关闭对话框",
    "action.openRecords": "打开清除记录",
    "error.notFound": "该文档已不存在，或不在你管理的工作区中。没有移除任何内容。",
    "error.readOnly": "文档面板处于只读状态，因此无法彻底清除。没有移除任何内容。",
    "error.invalidReason": "原因未被接受。请选择原因；选择“其他”时请填写备注。",
    "error.failed": "彻底清除未完成。重试之前，请打开“清除记录”查看是否已写入记录。",
    "error.recordGone": "此记录已不存在。列表已重新加载。",
    "error.off": "此部署中没有清除记录：该功能已关闭，或主应用的版本不包含此功能。此处没有可显示的内容。",
    "reason.owner_request": "内容所有者要求",
    "reason.added_in_error": "误添加",
    "reason.retention_ended": "保留期已结束",
    "reason.legal_or_policy": "法律或政策要求",
    "reason.restricted_content": "含有不得存储的内容",
    "reason.other": "其他（请在备注中说明）",
    "reason.source_deleted": "已在来源中删除",
    "store.documents": "文档版本",
    "store.chunks": "文本块",
    "store.vectors": "检索向量",
    "store.parents": "父级文本块",
    "store.ingestion_jobs": "摄取记录",
    "store.parse_cache": "解析缓存",
    "store.semantic_cache": "缓存的回答",
    "store.answer_citations": "回答记录中的引用原文",
    "store.chat_messages": "已保存对话中的引用原文",
    "store.table_rows": "表格行",
    "store.duplicate_groups": "重复分组",
    "store.translations": "已存储的译文",
    "store.original_files": "原始文件和解析文件",
    "store.parse_cache_files": "解析缓存文件",
    "store.page_images": "页面图片",
    "store.uploaded_image": "上传的图片",
    "store.sync_records": "连接器同步记录",
  },
  it: {
    "panel.title": "Registro delle eliminazioni definitive",
    "panel.description": "Ogni eliminazione definitiva, avviata da un amministratore o da una connessione in modalità Eliminazione definitiva, con il motivo e l'esito del controllo successivo. I record contengono solo ID, mai nomi di file o testo. Per eliminare definitivamente un documento, usa Purge nella tabella dei documenti in Document Processing.",
    "action.openDocuments": "Apri Document Processing",
    "action.refresh": "Aggiorna record",
    "action.loadMore": "Carica altri record",
    "action.reload": "Ricarica pannello",
    "list.loading": "Caricamento dei record…",
    "list.loaded": "Record caricati: {count}.",
    "list.updatedAt": "Aggiornato alle {time}",
    "list.empty.title": "Nessun record",
    "list.empty.body": "Nulla è stato eliminato definitivamente negli spazi di lavoro che amministri.",
    "list.unavailable": "Impossibile caricare i record. Verifica che l'app principale sia in esecuzione, poi seleziona Ricarica pannello.",
    "table.caption": "Record delle eliminazioni, dal più recente",
    "col.when": "Quando",
    "col.who": "Avviata da",
    "col.reason": "Motivo",
    "col.document": "Documento",
    "col.result": "Controllo",
    "who.admin": "Amministratore {id}",
    "who.sourceSync": "Sincronizzazione delle fonti, {connection}",
    "document.versions": "Versioni: {count}",
    "note.none": "Nessuna nota",
    "result.verified": "Nessun residuo",
    "result.pending": "Pulizia in sospeso",
    "result.remaining": "Righe rimaste: {count}",
    "result.unchecked": "Non controllato",
    "result.noCheck": "Nessun controllo eseguito per questo record.",
    "action.details": "Mostra controllo",
    "action.verify": "Controlla di nuovo",
    "action.verifyAria": "Controlla di nuovo il record {id}",
    "verify.running": "Controllo…",
    "verify.done": "Controllato il {time}.",
    "ledger.caption": "Controllo dopo l'eliminazione, per archivio",
    "ledger.col.store": "Archivio",
    "ledger.col.removed": "Rimossi",
    "ledger.col.left": "Rimasti",
    "ledger.notReported": "Non riportato",
    "ledger.leftSr": "righe ancora presenti in questo archivio",
    "ledger.pendingFiles": "File archiviati in attesa di pulizia: {count}.",
    "ledger.pendingHelp": "La prossima riconciliazione pianificata riprova.",
    "ledger.queued": "Eliminazioni in coda per l'indice esterno: {count}.",
    "ledger.notCovered": "Non raggiunti da un'eliminazione definitiva: gli ID nel registro di recupero e nella coda di revisione (senza testo, conservazione breve) e le tracce già inviate al servizio di tracciamento.",
    "dialog.title": "Eliminare definitivamente «{name}»?",
    "dialog.what": "Rimuove da ogni archivio tutte le versioni di questo documento e tutto ciò che ne deriva: frammenti, vettori di ricerca, risposte in cache, file archiviati e immagini delle pagine. Le risposte passate mantengono il numero di citazione e mostrano «Fonte ritirata» al posto del testo citato. Non si può annullare.",
    "dialog.vsDelete": "Delete rimuove il documento e i suoi frammenti. Purge elimina anche le risposte in cache, i record di acquisizione, le immagini delle pagine e il testo citato nelle chat passate, e scrive un record.",
    "dialog.connector": "Questo file proviene da una fonte collegata. Dopo l'eliminazione definitiva, le sincronizzazioni successive lo saltano anche se è ancora presente alla fonte.",
    "dialog.reasonLabel": "Motivo",
    "dialog.reasonPlaceholder": "Scegli un motivo",
    "dialog.noteLabel": "Nota",
    "dialog.noteOptional": "facoltativa",
    "dialog.noteRequired": "obbligatoria per Altro",
    "dialog.noteHelp": "Indica il perché, non il contenuto del documento. La nota resta nel record. Massimo 500 caratteri.",
    "dialog.needReason": "Scegli un motivo per continuare.",
    "dialog.needNote": "Aggiungi una nota per Altro.",
    "action.keep": "Mantieni documento",
    "action.purge": "Elimina definitivamente",
    "dialog.purging": "Eliminazione…",
    "result.title.verified": "Eliminato definitivamente. Nessun residuo.",
    "result.title.pending": "Eliminato definitivamente. Pulizia non terminata.",
    "result.title.remaining": "Eliminato, ma restano righe.",
    "result.body.pending": "Le righe del database sono state rimosse. Alcuni file archiviati non sono ancora stati rimossi; la prossima riconciliazione pianificata riprova. Seleziona Controlla di nuovo nel registro per vedere lo stato attuale.",
    "result.body.remaining": "Il controllo ha trovato righe negli archivi segnalati qui sotto. Seleziona Controlla di nuovo nel registro; se restano righe, segnalalo con l'ID del record {id}.",
    "action.close": "Chiudi finestra",
    "action.openRecords": "Apri il registro",
    "error.notFound": "Questo documento non esiste più o non è in uno spazio di lavoro che amministri. Non è stato rimosso nulla.",
    "error.readOnly": "La dashboard dei documenti è in sola lettura, quindi l'eliminazione definitiva è disattivata. Non è stato rimosso nulla.",
    "error.invalidReason": "Il motivo non è stato accettato. Scegli un motivo e, per Altro, aggiungi una nota.",
    "error.failed": "L'eliminazione definitiva non è terminata. Prima di riprovare, apri il registro per vedere se è stato scritto un record.",
    "error.recordGone": "Questo record non esiste più. L'elenco è stato ricaricato.",
    "error.off": "Il registro delle eliminazioni definitive non è disponibile in questa distribuzione: la funzione è disattivata oppure l'app principale è una versione che non la include. Qui non c'è nulla da mostrare.",
    "reason.owner_request": "Richiesto dal titolare del contenuto",
    "reason.added_in_error": "Aggiunto per errore",
    "reason.retention_ended": "Periodo di conservazione terminato",
    "reason.legal_or_policy": "Obbligo legale o di policy",
    "reason.restricted_content": "Contiene contenuti che non devono essere conservati",
    "reason.other": "Altro (descrivi nella nota)",
    "reason.source_deleted": "Eliminato alla fonte",
    "store.documents": "Versioni del documento",
    "store.chunks": "Frammenti di testo",
    "store.vectors": "Vettori di ricerca",
    "store.parents": "Frammenti padre",
    "store.ingestion_jobs": "Record di acquisizione",
    "store.parse_cache": "Cache di analisi",
    "store.semantic_cache": "Risposte in cache",
    "store.answer_citations": "Testo citato nei record delle risposte",
    "store.chat_messages": "Testo citato nelle chat salvate",
    "store.table_rows": "Righe di tabella",
    "store.duplicate_groups": "Gruppi di duplicati",
    "store.translations": "Traduzioni archiviate",
    "store.original_files": "File originali e analizzati",
    "store.parse_cache_files": "File della cache di analisi",
    "store.page_images": "Immagini delle pagine",
    "store.uploaded_image": "Immagine caricata",
    "store.sync_records": "Record di sincronizzazione del connettore",
  },
};

const PURGE_PAGE_SIZE = 50;
const PURGE_NOTE_MAX = 500;
const PURGE_ADMIN_REASONS = ['owner_request', 'added_in_error', 'retention_ended', 'legal_or_policy', 'restricted_content', 'other'];
const PURGE_CONNECTOR_SOURCES = new Set(['nango', 'connector']);

const PURGE_RESULTS = {
  verified: { key: 'result.verified', className: 'badge badge-success badge-sm', icon: 'bi-check-circle-fill' },
  pending: { key: 'result.pending', className: 'badge badge-warning badge-sm', icon: 'bi-hourglass-split' },
  remaining: { key: 'result.remaining', className: 'badge badge-error badge-outline badge-sm', icon: 'bi-exclamation-triangle' },
  unchecked: { key: 'result.unchecked', className: 'badge badge-ghost badge-sm', icon: null },
};

let purgeSharedLabel = null;
if (typeof require !== 'undefined') {
  try {
    purgeSharedLabel = require('../document-processing/status-monitor.js').ingestLabel;
  } catch {
    purgeSharedLabel = null;
  }
}

function purgeLocale() {
  const lang = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').slice(0, 2);
  return lang === 'zh' || lang === 'it' ? lang : 'en';
}

function purgeLoc(locale) {
  return locale === 'zh' || locale === 'it' ? locale : 'en';
}

function purgeFill(text, vars) {
  if (!text || !vars) return text;
  let out = text;
  for (const [key, value] of Object.entries(vars)) out = out.split('{' + key + '}').join(String(value ?? ''));
  return out;
}

function purgeShared(key, locale, vars) {
  if (typeof window !== 'undefined' && typeof window.ingestLabel === 'function') return window.ingestLabel(key, locale, vars);
  if (purgeSharedLabel) return purgeSharedLabel(key, locale, vars);
  return key;
}

function purgeLabel(key, locale, vars) {
  const loc = purgeLoc(locale);
  const table = PURGE_LABELS[loc];
  if (table[key]) return purgeFill(table[key], vars);
  if (PURGE_LABELS.en[key]) return purgeFill(PURGE_LABELS.en[key], vars);
  return purgeShared(key, loc, vars);
}

function purgeNumber(value, locale) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat(purgeLoc(locale)).format(n);
}

function purgeTime(iso, locale) {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return { iso, absolute: new Intl.DateTimeFormat(purgeLoc(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)) };
}

function purgeShortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : '';
}

function purgeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function purgeStoreLabel(store, locale) {
  const key = 'store.' + store;
  const loc = purgeLoc(locale);
  if (PURGE_LABELS[loc][key] || PURGE_LABELS.en[key]) return { label: purgeLabel(key, loc), known: true };
  return { label: store, known: false };
}

/** Receipt rows in the server's store order: the stores of the check first, then removed-only stores. Counts only. */
function buildPurgeReceiptView(check, removed, locale) {
  const loc = purgeLoc(locale);
  if (!check || typeof check !== 'object' || !check.left || typeof check.left !== 'object') return null;
  const left = check.left;
  const done = removed && typeof removed === 'object' ? removed : {};
  const order = Object.keys(left).concat(Object.keys(done).filter((store) => !Object.prototype.hasOwnProperty.call(left, store)));
  const rows = order.map((store) => {
    const { label, known } = purgeStoreLabel(store, loc);
    const hasRemoved = Object.prototype.hasOwnProperty.call(done, store) && Number.isFinite(Number(done[store]));
    const hasLeft = Object.prototype.hasOwnProperty.call(left, store) && Number.isFinite(Number(left[store]));
    const leftValue = hasLeft ? Number(left[store]) : null;
    return {
      store,
      label,
      known,
      removed: hasRemoved ? purgeNumber(done[store], loc) : null,
      left: hasLeft ? purgeNumber(leftValue, loc) : null,
      leftNonZero: leftValue !== null && leftValue > 0,
    };
  });
  const pendingFiles = purgeCount(check.pending_files);
  const queued = purgeCount(check.queued_external);
  return {
    caption: purgeLabel('ledger.caption', loc),
    rows,
    pendingFiles,
    pendingLine: pendingFiles ? purgeLabel('ledger.pendingFiles', loc, { count: purgeNumber(pendingFiles, loc) }) + ' ' + purgeLabel('ledger.pendingHelp', loc) : null,
    queued,
    queuedLine: queued ? purgeLabel('ledger.queued', loc, { count: purgeNumber(queued, loc) }) : null,
    leftTotal: rows.reduce((sum, row) => sum + (row.leftNonZero ? Number(left[row.store]) : 0), 0),
  };
}

function purgeBadge(result, receipt, locale) {
  const loc = purgeLoc(locale);
  const key = PURGE_RESULTS[result] ? result : 'unchecked';
  const spec = PURGE_RESULTS[key];
  const vars = key === 'remaining' ? { count: purgeNumber(receipt ? receipt.leftTotal : 0, loc) } : undefined;
  return { result: key, label: purgeLabel(spec.key, loc, vars), className: spec.className, icon: spec.icon };
}

/** One record of GET admin/purges for the table. Reads only the listed fields, so nothing else the server sends reaches the page. */
function buildPurgeRecordView(record, locale) {
  const loc = purgeLoc(locale);
  const r = record && typeof record === 'object' ? record : {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const checked = r.result !== 'unchecked' && r.left && typeof r.left === 'object';
  const receipt = checked
    ? buildPurgeReceiptView({ left: r.left, pending_files: r.pending_files, queued_external: r.queued_external }, r.removed, loc)
    : null;
  const adminId = str(r.actor_id);
  const who =
    r.actor_kind === 'source_sync'
      ? { kind: 'source_sync', text: purgeLabel('who.sourceSync', loc, { connection: str(r.provider) || '—' }) }
      : { kind: 'admin', text: purgeLabel('who.admin', loc, { id: purgeShortId(adminId) }), idShort: purgeShortId(adminId), idFull: adminId };
  const code = str(r.reason_code);
  const reasonKey = 'reason.' + code;
  const reason = code && PURGE_LABELS.en[reasonKey] ? { text: purgeLabel(reasonKey, loc), known: true } : { text: code || '—', known: false };
  const note = typeof r.reason_note === 'string' && r.reason_note.trim() ? r.reason_note : null;
  const lineage = str(r.lineage_id);
  return {
    id: str(r.id),
    idShort: purgeShortId(str(r.id)),
    when: purgeTime(r.started_at, loc),
    who,
    workspaceKey: str(r.workspace_key),
    reason,
    note,
    noteNone: purgeLabel('note.none', loc),
    document: { idShort: purgeShortId(lineage), idFull: lineage, versions: purgeLabel('document.versions', loc, { count: purgeNumber(r.version_count, loc) }) },
    badge: purgeBadge(checked ? r.result : 'unchecked', receipt, loc),
    receipt,
    checkedAt: checked ? purgeTime(r.checked_at, loc) : null,
    noCheck: purgeLabel('result.noCheck', loc),
  };
}

function purgeAppUrl(fallback) {
  if (fallback) return fallback;
  if (typeof window !== 'undefined' && typeof window.getConfiguredMyRAGAppUrl === 'function') return window.getConfiguredMyRAGAppUrl();
  if (typeof window !== 'undefined' && window.location && window.location.origin) return window.location.origin;
  return 'http://localhost:3000';
}

/** Below 768px each record stacks into one block, so the Check badge and Check again stay on screen. */
const PURGE_STACK = {
  table: 'max-md:block max-md:w-full',
  head: 'max-md:hidden',
  body: 'max-md:block',
  row: 'max-md:flex max-md:flex-col max-md:gap-2 max-md:pt-3',
  cell: 'max-md:block max-md:w-full max-md:max-w-none max-md:p-0',
  label: 'md:hidden text-xs font-semibold mb-1',
};
const PURGE_SOLID_BUTTON = 'btn bg-base-100 text-base-content border-base-300 hover:bg-base-200';
const PURGE_SELECT_FOCUS = 'focus-visible:[outline-color:var(--fallback-p,oklch(var(--p)/1))]';
const PURGE_TOUCH = 'max-md:min-h-12';

const PURGE_KNOWN_CODES = new Set(['not_found', 'invalid_request', 'read_only', 'purge_unavailable']);

/** Maps a ragFetch result to the sentence of UI-SPEC 8.2. context: 'list' | 'purge' | 'verify'. */
function mapPurgeError(result, locale, context, appUrl) {
  const loc = purgeLoc(locale);
  const status = result && result.status;
  const body = (result && result.body) || {};
  const code = body && typeof body.error === 'string' ? body.error : '';
  const msg = (key, vars) => ({ key, message: purgeLabel(key, loc, vars) });
  if (context === 'purge') {
    if (result && result.thrown) return msg('error.failed');
    if (status === 403 && code === 'read_only') return msg('error.readOnly');
    if (status === 401 || status === 403) return { ...msg('error.signIn', { appUrl: purgeAppUrl(appUrl) }), kind: 'auth' };
    if (status === 404) return { ...msg('error.notFound'), notFound: true };
    if (status === 400) return { ...msg('error.invalidReason'), invalidReason: true };
    if (status >= 500 && status < 600) return msg('error.failed');
  } else {
    if (result && result.thrown) return context === 'list' ? { ...msg('list.unavailable'), kind: 'unavailable' } : { ...msg('error.network'), kind: 'network' };
    if (status === 401 || status === 403) return { ...msg('error.signIn', { appUrl: purgeAppUrl(appUrl) }), kind: 'auth' };
    if (context === 'list' && status === 404) return { ...msg('error.off'), kind: 'off' };
    if (context === 'list' && status >= 500 && status < 600) return { ...msg('list.unavailable'), kind: 'unavailable' };
    if (context === 'verify' && status === 404) return { ...msg('error.recordGone'), reload: true };
    if (status === 503) return { ...msg('error.unavailable'), kind: 'unavailable' };
  }
  const out = msg('error.generic', { status: status || '?' });
  if (code && !PURGE_KNOWN_CODES.has(code)) out.code = code;
  return out;
}

function purgeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function purgeIcon(name) {
  const icon = document.createElement('i');
  icon.className = 'bi ' + name;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function purgeSpinner() {
  const spin = document.createElement('span');
  spin.className = 'loading loading-spinner loading-sm motion-reduce:hidden';
  spin.setAttribute('aria-hidden', 'true');
  return spin;
}

function purgeSr(text) {
  return purgeEl('span', 'sr-only', text);
}

function purgeMono(text, title) {
  const el = purgeEl('span', 'font-mono text-xs', text);
  el.setAttribute('translate', 'no');
  if (title) el.title = title;
  return el;
}

function purgeTimeEl(time) {
  const el = document.createElement('time');
  el.setAttribute('datetime', time.iso);
  el.textContent = time.absolute;
  return el;
}

/** Fills a template whose placeholders become DOM nodes; everything else stays text. */
function purgeFillNodes(parent, template, nodes) {
  const parts = String(template).split(/(\{[a-zA-Z]+\})/);
  for (const part of parts) {
    const m = /^\{([a-zA-Z]+)\}$/.exec(part);
    if (m && nodes[m[1]]) parent.appendChild(nodes[m[1]]);
    else if (part) parent.appendChild(document.createTextNode(part));
  }
  return parent;
}

function purgeButtonBusy(button, busy, text) {
  if (busy) {
    if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
    button.replaceChildren(purgeSpinner(), document.createTextNode(text));
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.replaceChildren(document.createTextNode(button.dataset.idleText || button.textContent));
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function purgeRag(path, init) {
  const fetcher = typeof window !== 'undefined' && window.ragFetch ? window.ragFetch : null;
  if (!fetcher) return { ok: false, status: 0, thrown: true };
  try {
    return await fetcher(path, init);
  } catch (e) {
    return { ok: false, status: 0, thrown: true, error: e };
  }
}

function purgeOpenTab(tab) {
  const link = document.querySelector('.menu-item[data-tab="' + tab + '"]') || document.querySelector('[data-tab="' + tab + '"]');
  if (link) link.click();
}

/** The receipt (UI-SPEC 6.6): the Left column is the column of zeros; a non-zero cell carries an icon and hidden text. */
function purgeReceiptNode(view, locale, checkedAt) {
  const loc = purgeLoc(locale);
  const wrap = purgeEl('div', 'min-w-0');
  const scroll = purgeEl('div', 'overflow-x-auto max-w-full');
  const table = purgeEl('table', 'table table-sm w-auto max-md:[&_th]:px-1.5 max-md:[&_td]:px-1.5');
  table.appendChild(purgeEl('caption', 'sr-only', view.caption));
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  for (const [key, cls] of [
    ['ledger.col.store', 'text-xs font-semibold'],
    ['ledger.col.removed', 'text-xs font-semibold text-right'],
    ['ledger.col.left', 'text-xs font-semibold text-right'],
  ]) {
    const th = purgeEl('th', cls, purgeLabel(key, loc));
    th.setAttribute('scope', 'col');
    head.appendChild(th);
  }
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of view.rows) {
    const tr = document.createElement('tr');
    const th = purgeEl('th', 'font-normal text-sm');
    th.setAttribute('scope', 'row');
    if (row.known) th.textContent = row.label;
    else th.appendChild(purgeMono(row.label));
    const removed = purgeEl('td', 'text-right tabular-nums text-sm');
    if (row.removed === null) removed.append(document.createTextNode('—'), purgeSr(purgeLabel('ledger.notReported', loc)));
    else removed.textContent = row.removed;
    const left = purgeEl('td', 'text-right tabular-nums text-sm' + (row.leftNonZero ? ' font-semibold' : ''));
    if (row.left === null) left.append(document.createTextNode('—'), purgeSr(purgeLabel('ledger.notReported', loc)));
    else if (row.leftNonZero) {
      const icon = purgeIcon('bi-exclamation-triangle');
      icon.className += ' text-warning ml-1';
      left.append(document.createTextNode(row.left), icon, purgeSr(' ' + purgeLabel('ledger.leftSr', loc)));
    } else left.textContent = row.left;
    tr.append(th, removed, left);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  wrap.appendChild(scroll);
  if (view.pendingLine) wrap.appendChild(purgeEl('p', 'text-sm mt-4 max-w-prose', view.pendingLine));
  if (view.queuedLine) wrap.appendChild(purgeEl('p', 'text-sm mt-2 max-w-prose', view.queuedLine));
  if (checkedAt) {
    const done = purgeEl('p', 'text-xs text-base-content/70 mt-4');
    purgeFillNodes(done, purgeLabel('verify.done', loc), { time: purgeTimeEl(checkedAt) });
    wrap.appendChild(done);
  }
  wrap.appendChild(purgeEl('p', 'text-xs text-base-content/70 mt-1 max-w-prose', purgeLabel('ledger.notCovered', loc)));
  return wrap;
}

function purgeFocusDocuments() {
  const heading = document.getElementById('documents-management-title') || document.getElementById('refresh-documents-btn');
  if (heading) heading.focus();
}

function purgeOpenRecords() {
  purgeOpenTab('rag-administration');
  if (typeof window !== 'undefined' && typeof window.initPurgePanel === 'function') window.initPurgePanel();
  const section = document.getElementById('rag-administration-purge');
  if (!section) return;
  if (section.scrollIntoView) section.scrollIntoView({ block: 'start' });
  const heading = section.querySelector('[data-purge-title]');
  if (heading) heading.focus();
}

/** Opens the purge dialog of UI-SPEC 6.5 for one Documents table row. Sends only reason_code and reason_note. */
function openPurgeDialog(documentId, filename, source) {
  if (typeof document === 'undefined' || !documentId) return null;
  const loc = purgeLocale();
  const t = (key, vars) => purgeLabel(key, loc, vars);
  const opener = document.activeElement || null;
  const uid = 'rag-purge-dialog-' + Math.random().toString(36).slice(2);
  const state = { busy: false, purged: false, gone: false };

  const dialog = purgeEl('dialog', 'modal');
  dialog.setAttribute('lang', loc);
  dialog.setAttribute('aria-labelledby', uid + '-title');
  dialog.setAttribute('aria-describedby', uid + '-what');
  const box = purgeEl('div', 'modal-box overscroll-contain max-w-lg');
  const title = purgeEl('h3', 'text-base font-semibold mb-2 break-words', t('dialog.title', { name: String(filename ?? '') }));
  title.id = uid + '-title';
  const form = purgeEl('div', 'min-w-0');
  const what = purgeEl('p', 'text-sm max-w-prose', t('dialog.what'));
  what.id = uid + '-what';
  form.append(what, purgeEl('p', 'text-xs text-base-content/70 mt-2 max-w-prose', t('dialog.vsDelete')));
  if (PURGE_CONNECTOR_SOURCES.has(String(source || ''))) form.appendChild(purgeEl('p', 'text-sm mt-2 max-w-prose', t('dialog.connector')));

  const reasonField = purgeEl('div', 'form-control mt-4');
  const reasonLabel = purgeEl('label', 'label');
  reasonLabel.setAttribute('for', uid + '-reason');
  reasonLabel.appendChild(purgeEl('span', 'label-text', t('dialog.reasonLabel')));
  const select = purgeEl('select', 'select select-bordered select-sm w-full max-md:h-12 ' + PURGE_SELECT_FOCUS);
  select.id = uid + '-reason';
  select.setAttribute('name', 'reason_code');
  select.setAttribute('required', '');
  const placeholder = purgeEl('option', '', t('dialog.reasonPlaceholder'));
  placeholder.setAttribute('value', '');
  placeholder.setAttribute('disabled', '');
  placeholder.setAttribute('selected', '');
  select.appendChild(placeholder);
  for (const code of PURGE_ADMIN_REASONS) {
    const option = purgeEl('option', '', t('reason.' + code));
    option.setAttribute('value', code);
    select.appendChild(option);
  }
  select.value = '';
  reasonField.append(reasonLabel, select);

  const noteField = purgeEl('div', 'form-control mt-4');
  const noteLabel = purgeEl('label', 'label');
  noteLabel.setAttribute('for', uid + '-note');
  const noteHint = purgeEl('span', 'label-text-alt text-base-content/70', t('dialog.noteOptional'));
  noteLabel.append(purgeEl('span', 'label-text', t('dialog.noteLabel')), noteHint);
  const note = purgeEl('textarea', 'textarea textarea-bordered textarea-sm w-full break-words');
  note.id = uid + '-note';
  note.setAttribute('name', 'reason_note');
  note.setAttribute('rows', '3');
  note.setAttribute('maxlength', String(PURGE_NOTE_MAX));
  note.setAttribute('aria-describedby', uid + '-note-help');
  note.setAttribute('autocomplete', 'off');
  const noteHelp = purgeEl('p', 'text-xs text-base-content/70 mt-1 max-w-prose', t('dialog.noteHelp'));
  noteHelp.id = uid + '-note-help';
  noteField.append(noteLabel, note, noteHelp);
  form.append(reasonField, noteField);

  const alertLine = purgeEl('p', 'text-sm text-error mt-4 max-w-prose');
  alertLine.setAttribute('role', 'alert');
  alertLine.hidden = true;

  const actions = purgeEl('div', 'modal-action flex-wrap items-center');
  const need = purgeEl('p', 'text-xs text-base-content/70 mr-auto');
  need.setAttribute('role', 'status');
  const keep = purgeEl('button', 'btn', t('action.keep'));
  keep.type = 'button';
  keep.setAttribute('autofocus', '');
  const confirm = purgeEl('button', 'btn btn-error', t('action.purge'));
  confirm.type = 'button';
  actions.append(need, keep, confirm);

  box.append(title, form, alertLine, actions);
  dialog.appendChild(box);
  const backdrop = purgeEl('form', 'modal-backdrop');
  backdrop.method = 'dialog';
  const backdropClose = purgeEl('button', '', t('action.keep'));
  backdropClose.type = 'submit';
  backdrop.appendChild(backdropClose);
  dialog.appendChild(backdrop);

  const noteText = () => String(note.value || '').trim();
  const validate = () => {
    const code = String(select.value || '');
    const other = code === 'other';
    noteHint.textContent = other ? t('dialog.noteRequired') : t('dialog.noteOptional');
    if (other) note.setAttribute('aria-required', 'true');
    else note.removeAttribute('aria-required');
    let missing = '';
    if (!PURGE_ADMIN_REASONS.includes(code)) missing = t('dialog.needReason');
    else if (other && !noteText()) missing = t('dialog.needNote');
    need.textContent = missing;
    confirm.disabled = state.busy || state.gone || !!missing;
  };
  select.addEventListener('change', () => {
    select.removeAttribute('aria-invalid');
    validate();
  });
  note.addEventListener('input', validate);

  const setBusy = (busy) => {
    state.busy = busy;
    select.disabled = busy;
    note.disabled = busy;
    keep.disabled = busy;
    backdropClose.disabled = busy;
    if (busy) purgeButtonBusy(confirm, true, t('dialog.purging'));
    else {
      purgeButtonBusy(confirm, false);
      validate();
    }
  };

  dialog.addEventListener('cancel', (event) => {
    if (state.busy && event.preventDefault) event.preventDefault();
  });
  keep.addEventListener('click', () => {
    if (!state.busy) dialog.close('cancel');
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (state.purged || state.gone) {
      if (typeof window !== 'undefined' && window.documentManager && typeof window.documentManager.loadDocuments === 'function') {
        window.documentManager.loadDocuments();
      }
      if (!state.openRecords) purgeFocusDocuments();
    } else if (opener && typeof opener.focus === 'function' && opener !== document.body) {
      opener.focus();
    }
    if (state.openRecords) purgeOpenRecords();
  });

  const showResult = (body) => {
    state.purged = true;
    const check = body && body.check && typeof body.check === 'object' ? body.check : {};
    const result = check.result === 'pending' || check.result === 'remaining' ? check.result : 'verified';
    const recordId = body && typeof body.record_id === 'string' ? body.record_id : '';
    const view = buildPurgeReceiptView(check, body && body.removed, loc);
    const heading = purgeEl('h3', 'text-base font-semibold mb-2', t('result.title.' + result));
    heading.id = uid + '-result';
    heading.setAttribute('tabindex', '-1');
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.removeAttribute('aria-describedby');
    const nodes = [heading];
    if (result !== 'verified') {
      const p = purgeEl('p', 'text-sm max-w-prose mb-4 break-words');
      const template = t('result.body.' + result);
      purgeFillNodes(p, template, { id: purgeMono(recordId) });
      if (result === 'pending' && recordId) {
        p.appendChild(document.createTextNode(' '));
        p.appendChild(purgeMono(recordId));
      }
      nodes.push(p);
    }
    if (view) nodes.push(purgeReceiptNode(view, loc, purgeTime(body && body.checked_at, loc)));
    const buttons = purgeEl('div', 'modal-action flex-wrap mt-6');
    const openRecords = purgeEl('button', 'btn btn-outline', t('action.openRecords'));
    openRecords.type = 'button';
    openRecords.addEventListener('click', () => {
      state.openRecords = true;
      dialog.close('records');
    });
    const close = purgeEl('button', 'btn', t('action.close'));
    close.type = 'button';
    close.addEventListener('click', () => dialog.close('done'));
    buttons.append(openRecords, close);
    nodes.push(buttons);
    box.replaceChildren(...nodes);
    backdropClose.disabled = false;
    heading.focus();
  };

  confirm.addEventListener('click', async () => {
    validate();
    if (confirm.disabled || state.busy) return;
    const code = String(select.value || '');
    const text = noteText();
    alertLine.hidden = true;
    alertLine.textContent = '';
    setBusy(true);
    const result = await purgeRag('admin/documents/' + encodeURIComponent(String(documentId)) + '/purge', {
      method: 'POST',
      body: JSON.stringify({ reason_code: code, reason_note: text ? text.slice(0, PURGE_NOTE_MAX) : null }),
    });
    if (result && result.ok) {
      state.busy = false;
      showResult(result.body || {});
      return;
    }
    const mapped = mapPurgeError(result, loc, 'purge');
    alertLine.replaceChildren(document.createTextNode(mapped.message));
    if (mapped.code) alertLine.append(document.createTextNode(' '), purgeMono(mapped.code));
    alertLine.hidden = false;
    if (mapped.notFound) {
      state.gone = true;
      confirm.hidden = true;
      keep.dataset.idleText = '';
      keep.textContent = t('action.close');
    }
    setBusy(false);
    if (mapped.invalidReason) select.setAttribute('aria-invalid', 'true');
    (mapped.notFound ? keep : select).focus();
  });

  validate();
  document.body.appendChild(dialog);
  dialog.showModal();
  keep.focus();
  return dialog;
}

class PurgePanel {
  constructor(root) {
    this.root = root;
    this.locale = purgeLocale();
    this.mounted = false;
    this.records = [];
    this.hasMore = false;
    this.loaded = false;
    this.loading = false;
    this.updatedAt = null;
    this.openDetails = new Set();
    this.appUrl = (root && root.dataset && root.dataset.appUrl) || null;
  }

  t(key, vars) {
    return purgeLabel(key, this.locale, vars);
  }

  mount() {
    if (this.mounted) {
      this.refresh();
      return;
    }
    this.mounted = true;
    this.root.setAttribute('lang', this.locale);
    const title = this.root.querySelector('[data-purge-title]');
    if (title) title.textContent = this.t('panel.title');
    const desc = this.root.querySelector('[data-purge-description]');
    if (desc) desc.textContent = this.t('panel.description');
    this.alertHost = this.root.querySelector('[data-purge-alert]');
    this.statusEl = this.root.querySelector('[data-purge-status]');
    const content = this.root.querySelector('[data-purge-content]') || this.root;
    this.view = purgeEl('div', 'min-w-0');
    this.view.setAttribute('data-purge-view', '');
    content.appendChild(this.view);
    this.refresh();
  }

  announce(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  refresh() {
    return this.loadList({});
  }

  setBusy(busy) {
    if (busy) {
      this.view.setAttribute('aria-busy', 'true');
      this.view.classList.add('opacity-60');
    } else {
      this.view.removeAttribute('aria-busy');
      this.view.classList.remove('opacity-60');
    }
    if (this.refreshButton) purgeButtonBusy(this.refreshButton, busy, this.t('list.loading'));
  }

  async loadList(opts) {
    const append = !!(opts && opts.append);
    if (this.loading) return;
    this.loading = true;
    if (!this.loaded) {
      const p = purgeEl('p', 'flex items-center gap-2 text-sm');
      p.append(purgeSpinner(), document.createTextNode(this.t('list.loading')));
      this.view.replaceChildren(p);
    } else if (append) {
      if (this.loadMoreButton) purgeButtonBusy(this.loadMoreButton, true, this.t('list.loading'));
    } else {
      this.setBusy(true);
    }
    const offset = append ? this.records.length : 0;
    const result = await purgeRag('admin/purges?limit=' + PURGE_PAGE_SIZE + '&offset=' + offset, { method: 'GET' });
    this.loading = false;
    if (!result || !result.ok) {
      const mapped = mapPurgeError(result, this.locale, 'list', this.appUrl);
      if (this.loaded && !append) this.setBusy(false);
      if (append && this.loadMoreButton) purgeButtonBusy(this.loadMoreButton, false);
      if (mapped.kind === 'auth') {
        this.renderAlert(null);
        this.loaded = false;
        this.records = [];
        this.refreshButton = null;
        this.view.classList.remove('opacity-60');
        this.view.replaceChildren(this.reloadAlert('alert alert-warning text-sm', mapped));
        return;
      }
      if (mapped.kind === 'off') {
        this.renderAlert(null);
        this.loaded = false;
        this.records = [];
        this.refreshButton = null;
        this.view.classList.remove('opacity-60');
        const off = purgeEl('div', 'alert items-start text-left text-sm');
        off.setAttribute('data-purge-off', '');
        off.append(purgeIcon('bi-info-circle'), purgeEl('p', 'max-w-prose', mapped.message));
        this.view.replaceChildren(off);
        this.announce(mapped.message);
        return;
      }
      this.renderAlert(mapped);
      if (this.loaded) this.view.classList.add('opacity-60');
      else this.view.replaceChildren();
      return;
    }
    this.renderAlert(null);
    const body = result.body || {};
    const items = (Array.isArray(body.items) ? body.items : []).filter((item) => item && typeof item === 'object');
    this.hasMore = body.has_more === true;
    this.updatedAt = Date.now();
    if (append && this.loaded && this.tbody) {
      this.records = this.records.concat(items);
      const scrollTop = this.region ? this.region.scrollTop : 0;
      for (const record of items) this.renderRecord(this.tbody, record);
      if (this.region) this.region.scrollTop = scrollTop;
      this.renderUpdated();
      this.renderLoadMore();
      if (this.loadMoreButton) this.loadMoreButton.focus({ preventScroll: true });
    } else {
      this.records = items;
      this.loaded = true;
      this.render();
      this.setBusy(false);
    }
    if (!(opts && opts.quiet)) this.announce(this.t('list.loaded', { count: purgeNumber(this.records.length, this.locale) }));
  }

  reloadAlert(className, mapped) {
    const alert = purgeEl('div', className);
    const p = purgeEl('p', 'max-w-prose', mapped.message);
    if (mapped.code) {
      p.appendChild(document.createTextNode(' '));
      const code = purgeMono(mapped.code);
      code.setAttribute('lang', 'en');
      p.appendChild(code);
    }
    const reload = purgeEl('button', PURGE_SOLID_BUTTON + ' btn-sm ' + PURGE_TOUCH, this.t('action.reload'));
    reload.type = 'button';
    reload.addEventListener('click', () => this.refresh());
    alert.append(p, reload);
    return alert;
  }

  renderAlert(mapped) {
    if (!this.alertHost) return;
    this.alertHost.replaceChildren();
    if (!mapped) return;
    this.alertHost.appendChild(this.reloadAlert('alert alert-error text-sm', mapped));
  }

  renderUpdated() {
    if (!this.updatedEl || !this.updatedAt) return;
    const at = new Date(this.updatedAt);
    const time = document.createElement('time');
    time.setAttribute('datetime', at.toISOString());
    time.title = new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
    time.textContent = new Intl.DateTimeFormat(this.locale, { timeStyle: 'short' }).format(at);
    this.updatedEl.replaceChildren();
    purgeFillNodes(this.updatedEl, this.t('list.updatedAt'), { time });
  }

  renderLoadMore() {
    if (this.loadMoreButton) this.loadMoreButton.remove();
    this.loadMoreButton = null;
    if (!this.hasMore || !this.moreHost) return;
    const more = purgeEl('button', 'btn btn-outline btn-sm mt-4', this.t('action.loadMore'));
    more.type = 'button';
    more.addEventListener('click', () => this.loadList({ append: true }));
    this.loadMoreButton = more;
    this.moreHost.appendChild(more);
  }

  render() {
    const view = this.view;
    view.replaceChildren();
    this.tbody = null;
    this.region = null;
    const toolbar = purgeEl('div', 'flex flex-wrap items-center gap-2 mb-4');
    const openDocs = purgeEl('button', 'btn btn-outline btn-sm', this.t('action.openDocuments'));
    openDocs.type = 'button';
    openDocs.addEventListener('click', () => purgeOpenTab('document-processing'));
    this.updatedEl = purgeEl('span', 'ml-auto text-xs text-base-content/70');
    this.renderUpdated();
    const refresh = purgeEl('button', 'btn btn-outline btn-sm');
    refresh.type = 'button';
    refresh.append(purgeIcon('bi-arrow-clockwise'), document.createTextNode(this.t('action.refresh')));
    refresh.dataset.idleText = this.t('action.refresh');
    refresh.addEventListener('click', () => this.refresh());
    this.refreshButton = refresh;
    toolbar.append(openDocs, this.updatedEl, refresh);
    view.appendChild(toolbar);

    if (!this.records.length) {
      const empty = purgeEl('div', 'py-8 flex flex-col items-start gap-2');
      empty.appendChild(purgeEl('h4', 'text-base font-semibold', this.t('list.empty.title')));
      empty.appendChild(purgeEl('p', 'text-sm max-w-prose', this.t('list.empty.body')));
      const open = purgeEl('button', 'btn btn-outline btn-sm', this.t('action.openDocuments'));
      open.type = 'button';
      open.addEventListener('click', () => purgeOpenTab('document-processing'));
      empty.appendChild(open);
      view.appendChild(empty);
      this.loadMoreButton = null;
      return;
    }

    const region = purgeEl('div', 'overflow-x-auto');
    region.setAttribute('tabindex', '0');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', this.t('table.caption'));
    const table = purgeEl('table', 'table table-sm ' + PURGE_STACK.table);
    table.appendChild(purgeEl('caption', 'sr-only', this.t('table.caption')));
    const thead = purgeEl('thead', PURGE_STACK.head);
    const headRow = document.createElement('tr');
    for (const [key, cls] of [
      ['col.when', 'text-xs font-semibold'],
      ['col.who', 'text-xs font-semibold'],
      ['col.reason', 'hidden md:table-cell text-xs font-semibold'],
      ['col.document', 'hidden lg:table-cell text-xs font-semibold'],
      ['col.result', 'text-xs font-semibold'],
    ]) {
      const th = purgeEl('th', cls, this.t(key));
      th.setAttribute('scope', 'col');
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = purgeEl('tbody', PURGE_STACK.body);
    for (const record of this.records) this.renderRecord(tbody, record);
    table.appendChild(tbody);
    region.appendChild(table);
    view.appendChild(region);
    this.tbody = tbody;
    this.region = region;
    this.moreHost = purgeEl('div', 'min-w-0');
    view.appendChild(this.moreHost);
    this.renderLoadMore();
  }

  reasonNodes(view) {
    const reason = purgeEl('div', 'text-sm break-words');
    if (view.reason.known) reason.textContent = view.reason.text;
    else reason.appendChild(purgeMono(view.reason.text));
    const note = purgeEl('div', 'text-xs text-base-content/70 mt-1 break-words max-w-xs');
    if (view.note) note.textContent = view.note;
    else note.append(document.createTextNode('—'), purgeSr(view.noteNone));
    return [reason, note];
  }

  documentNodes(view) {
    const id = purgeEl('div', 'text-sm');
    id.append(document.createTextNode('ID '), purgeMono(view.document.idShort, view.document.idFull));
    const versions = purgeEl('div', 'text-xs text-base-content/70 mt-1 tabular-nums', view.document.versions);
    return [id, versions];
  }

  badgeNode(view) {
    const badge = purgeEl('span', view.badge.className + ' gap-1 h-auto whitespace-normal');
    if (view.badge.icon) badge.appendChild(purgeIcon(view.badge.icon));
    badge.appendChild(document.createTextNode(view.badge.label));
    return badge;
  }

  renderRecord(tbody, record, replace) {
    const view = buildPurgeRecordView(record, this.locale);
    const data = purgeEl('tr', PURGE_STACK.row);
    data.setAttribute('data-purge-record', view.id);
    const when = purgeEl('td', 'text-sm align-top whitespace-nowrap ' + PURGE_STACK.cell);
    when.appendChild(purgeEl('div', PURGE_STACK.label, this.t('col.when')));
    if (view.when) when.appendChild(purgeTimeEl(view.when));
    else when.appendChild(document.createTextNode('—'));
    const who = purgeEl('td', 'align-top min-w-0 ' + PURGE_STACK.cell);
    who.appendChild(purgeEl('div', PURGE_STACK.label, this.t('col.who')));
    const whoLine = purgeEl('div', 'text-sm break-words');
    if (view.who.kind === 'admin') {
      const template = this.t('who.admin');
      purgeFillNodes(whoLine, template, { id: purgeMono(view.who.idShort, view.who.idFull) });
    } else whoLine.textContent = view.who.text;
    const key = purgeEl('div', 'font-mono text-xs text-base-content/70 mt-1 break-all max-w-xs', view.workspaceKey);
    key.setAttribute('translate', 'no');
    who.append(whoLine, key);
    const reason = purgeEl('td', 'hidden md:table-cell align-top min-w-0');
    reason.append(...this.reasonNodes(view));
    const doc = purgeEl('td', 'hidden lg:table-cell align-top');
    doc.append(...this.documentNodes(view));
    const result = purgeEl('td', 'align-top ' + PURGE_STACK.cell);
    result.appendChild(purgeEl('div', PURGE_STACK.label, this.t('col.result')));
    result.appendChild(this.badgeNode(view));
    data.append(when, who, reason, doc, result);

    const detail = purgeEl('tr', PURGE_STACK.row);
    detail.setAttribute('data-purge-detail', view.id);
    const cell = purgeEl('td', 'pt-0 ' + PURGE_STACK.cell + ' max-md:pb-3');
    cell.setAttribute('colspan', '5');
    const line = purgeEl('div', 'flex flex-wrap items-start gap-2 max-md:flex-col max-md:items-stretch');
    const details = purgeEl('details', 'min-w-0 flex-1 max-md:w-full');
    if (this.openDetails.has(view.id)) details.setAttribute('open', '');
    details.addEventListener('toggle', () => {
      if (details.hasAttribute('open') || details.open) this.openDetails.add(view.id);
      else this.openDetails.delete(view.id);
    });
    const summary = purgeEl('summary', 'cursor-pointer text-sm rounded py-1 max-md:py-3 ' + PURGE_TOUCH + ' focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', this.t('action.details'));
    details.appendChild(summary);
    const inner = purgeEl('div', 'mt-2 min-w-0 max-w-full');
    const narrow = purgeEl('div', 'md:hidden mb-2');
    narrow.append(...this.reasonNodes(view));
    const narrowDoc = purgeEl('div', 'lg:hidden mb-2');
    narrowDoc.append(...this.documentNodes(view));
    inner.append(narrow, narrowDoc);
    if (view.receipt) inner.appendChild(purgeReceiptNode(view.receipt, this.locale, view.checkedAt));
    else inner.appendChild(purgeEl('p', 'text-sm', view.noCheck));
    details.appendChild(inner);
    const check = purgeEl('button', 'btn btn-outline md:btn-sm ml-auto max-md:ml-0 max-md:self-start', this.t('action.verify'));
    check.type = 'button';
    check.setAttribute('aria-label', this.t('action.verifyAria', { id: view.idShort }));
    check.addEventListener('click', () => this.verify(view.id, check));
    line.append(details, check);
    cell.appendChild(line);
    detail.appendChild(cell);

    if (replace) {
      tbody.insertBefore(data, replace.data);
      tbody.insertBefore(detail, replace.data);
      replace.data.remove();
      replace.detail.remove();
    } else {
      tbody.append(data, detail);
    }
    return { data, detail, check };
  }

  async verify(recordId, button) {
    if (this.loading || !recordId) return;
    this.loading = true;
    purgeButtonBusy(button, true, this.t('verify.running'));
    if (this.refreshButton) this.refreshButton.disabled = true;
    if (this.loadMoreButton) this.loadMoreButton.disabled = true;
    const result = await purgeRag('admin/purges/' + encodeURIComponent(recordId) + '/verify', { method: 'POST', body: '{}' });
    this.loading = false;
    if (this.refreshButton) this.refreshButton.disabled = false;
    if (this.loadMoreButton) this.loadMoreButton.disabled = false;
    if (!result || !result.ok) {
      purgeButtonBusy(button, false);
      const mapped = mapPurgeError(result, this.locale, 'verify', this.appUrl);
      if (mapped.reload) {
        this.announce(mapped.message);
        await this.loadList({ quiet: true });
        return;
      }
      if (mapped.kind === 'auth') {
        this.loaded = false;
        this.records = [];
        this.refreshButton = null;
        this.view.replaceChildren(this.reloadAlert('alert alert-warning text-sm', mapped));
        return;
      }
      this.renderAlert(mapped);
      button.focus();
      return;
    }
    const body = result.body || {};
    const check = body.check && typeof body.check === 'object' ? body.check : {};
    const index = this.records.findIndex((r) => r && r.id === recordId);
    if (index === -1) return;
    const next = {
      ...this.records[index],
      result: typeof check.result === 'string' ? check.result : 'unchecked',
      left: check.left && typeof check.left === 'object' ? check.left : null,
      pending_files: check.pending_files,
      queued_external: check.queued_external,
      checked_at: typeof body.checked_at === 'string' ? body.checked_at : null,
    };
    this.records[index] = next;
    this.openDetails.add(recordId);
    const data = this.tbody && this.tbody.querySelector('[data-purge-record="' + recordId + '"]');
    const detail = this.tbody && this.tbody.querySelector('[data-purge-detail="' + recordId + '"]');
    let fresh = null;
    if (data && detail) fresh = this.renderRecord(this.tbody, next, { data, detail });
    const time = purgeTime(next.checked_at, this.locale);
    this.announce(this.t('verify.done', { time: time ? time.absolute : '' }));
    if (fresh) fresh.check.focus();
  }
}

let purgePanelInstance = null;

function initPurgePanel() {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('rag-administration-purge');
  if (!root) return;
  if (!purgePanelInstance) {
    purgePanelInstance = new PurgePanel(root);
    window.purgePanel = purgePanelInstance;
    purgePanelInstance.mount();
  } else {
    purgePanelInstance.refresh();
  }
}

function bindPurgePanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-purge-bound')) return;
    link.setAttribute('data-purge-bound', '1');
    link.addEventListener('click', () => initPurgePanel());
  });
}

if (typeof window !== 'undefined') {
  window.initPurgePanel = initPurgePanel;
  window.openPurgeDialog = openPurgeDialog;
  window.purgeLabel = purgeLabel;
  bindPurgePanel();
  document.addEventListener('DOMContentLoaded', () => {
    bindPurgePanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initPurgePanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PURGE_LABELS,
    purgeLabel,
    buildPurgeReceiptView,
    buildPurgeRecordView,
    mapPurgeError,
    openPurgeDialog,
    initPurgePanel,
    PurgePanel,
  };
}
