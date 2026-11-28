/**
 * Source sync admin panel (Phase 6.3, D-08, D-09, D-10, D-26) — plain-text DOM only. No control starts a reconcile.
 */

const SOURCE_SYNC_LABELS = {
  en: {
    "panel.title": "Source sync",
    "panel.description": "Keeps the knowledge base in step with connected sources. A full reconcile lists every file at a source and removes documents whose file is gone. For each connection, choose what a deletion at the source does here.",
    "panel.tabsLabel": "Source sync views",
    "tab.connections": "Connections",
    "tab.settings": "Settings",
    "action.refresh": "Refresh connections",
    "action.loadMore": "Load more connections",
    "action.reload": "Reload panel",
    "action.openConnectors": "Open Connectors",
    "list.loading": "Loading connections…",
    "list.loaded": "Connections loaded: {count}. Overdue: {overdue}. Paused: {paused}.",
    "list.updatedAt": "Updated {time}",
    "list.empty.title": "No connections to manage",
    "list.empty.body": "Connections appear here after an account is connected under Connectors. In multi-tenant mode only connections in workspaces you administer are listed.",
    "list.unavailable": "Connections could not be loaded. Check that the main app is running, then select Reload panel.",
    "table.caption": "Connections and their reconcile status",
    "col.connection": "Connection",
    "col.documents": "Documents",
    "col.lastReconcile": "Last full reconcile",
    "col.status": "Status",
    "col.mode": "When a file is deleted at the source",
    "reconcile.never": "Never",
    "reconcile.connected": "Connected {time}",
    "status.inStep": "In step",
    "status.overdue": "Overdue",
    "status.paused": "Paused",
    "status.failed": "Last run failed",
    "status.incomplete": "Listing incomplete",
    "status.notRun": "Not run yet",
    "reason.overdue": "Days without a completed full reconcile: {age}. Limit: {days}.",
    "reason.failed": "The last run stopped with an error. The next run tries again.",
    "reason.incomplete": "The source did not return a complete file list, so nothing was removed.",
    "summary.overdue": "Connections past the reconcile age limit: {count}. Files deleted at those sources may still be used in answers. Check that the scheduled reconcile is running, or run {command}, then select Refresh connections.",
    "mode.aria": "Deletion mode for {connection}",
    "mode.default": "Default (current behaviour)",
    "mode.soft": "Soft delete",
    "mode.purge": "Purge",
    "mode.help.default": "Follows the ingestion pipeline settings: versions are kept under the unified pipeline with the async queue, and deleted otherwise.",
    "mode.help.soft": "The document stops being used in answers. Its versions stay for history and past citations.",
    "mode.help.purge": "Every version and everything built from it is removed from every store. Past citations show “Source withdrawn”. Cannot be undone.",
    "mode.saving": "Saving…",
    "mode.saved": "Deletion mode for {connection}: {mode}. It applies to deletions from now on.",
    "mode.failed": "The deletion mode was not changed. Try again.",
    "confirm.purgeMode.title": "Use Purge mode for {connection}?",
    "confirm.purgeMode.body": "From now on, when a file is deleted at this source, every version of its document and everything built from it is removed here: chunks, search vectors, cached answers, stored files and page images. Past answers show “Source withdrawn” instead of the quoted text. A purged document cannot be restored from this system. Documents removed earlier are not changed. A sync that would remove more than {share} of this connection's documents still pauses for confirmation.",
    "action.keepMode": "Keep current mode",
    "action.usePurge": "Use Purge mode",
    "paused.groupLabel": "Paused run for {connection}",
    "paused.body": "Documents whose file is missing at the source: {count} of {total} ({percent}). That is above the {share} limit, so nothing was removed.",
    "paused.bodyAll": "The source returned no files. All documents of this connection ({total}) would be removed, so nothing was removed.",
    "paused.bodyCap": "The source reported {count} deleted files after this connection reached its daily purge limit of {cap}, so they were not purged.",
    "paused.when": "Found {time}. Can be confirmed until {deadline}.",
    "paused.files": "Show files: {count}",
    "paused.filesMore": "Not shown: {count}",
    "paused.dismissHelp": "Dismiss run keeps every document. The next reconcile checks again.",
    "action.remove": "Remove documents…",
    "action.dismiss": "Dismiss run",
    "dismiss.running": "Dismissing…",
    "confirm.remove.title": "Remove documents from {connection}?",
    "confirm.remove.count": "Documents: {count}",
    "confirm.remove.body.default": "These documents stop being used in answers. In Default mode their versions are kept or deleted according to the ingestion pipeline settings.",
    "confirm.remove.body.soft": "These documents stop being used in answers. Their versions stay for history and past citations.",
    "confirm.remove.body.purge": "Every version of these documents and everything built from them is removed from every store. Past answers show “Source withdrawn” instead of the quoted text. This cannot be undone.",
    "action.goBack": "Go back",
    "action.removeConfirm": "Remove documents",
    "confirm.removing": "Removing…",
    "remove.done": "Removed from {connection}: {removed}.",
    "remove.partial": "Removed from {connection}: {removed}. Not removed: {failed}. Those stay in the knowledge base and the next reconcile tries again.",
    "remove.failed": "The documents were not removed. Try again.",
    "dismiss.done": "Run dismissed. No document was removed.",
    "expired.body": "This paused run is older than 24 hours and can no longer be confirmed. Nothing was removed. Start a sync under Connectors, or wait for the next scheduled reconcile, to get a fresh count.",
    "error.runGone": "This run was already confirmed or dismissed. The list was reloaded.",
    "error.connectionGone": "This connection no longer exists or is not in a workspace you administer. The list was reloaded.",
    "error.off": "Source sync is not available in this deployment: the feature is switched off, or the main app is a version without it. There is nothing to manage here."
  },
  zh: {
    "panel.title": "来源同步",
    "panel.description": "让知识库与已连接的来源保持一致。完整核对会列出来源中的全部文件，并移除文件已不存在的文档。可为每个连接选择：来源删除文件后，这里如何处理。",
    "panel.tabsLabel": "来源同步视图",
    "tab.connections": "连接",
    "tab.settings": "设置",
    "action.refresh": "刷新连接",
    "action.loadMore": "加载更多连接",
    "action.reload": "重新加载面板",
    "action.openConnectors": "打开 Connectors",
    "list.loading": "正在加载连接…",
    "list.loaded": "已加载连接：{count}。逾期：{overdue}。已暂停：{paused}。",
    "list.updatedAt": "更新于 {time}",
    "list.empty.title": "没有可管理的连接",
    "list.empty.body": "在 Connectors 中连接账户后，连接会显示在这里。多租户模式下只列出你管理的工作区中的连接。",
    "list.unavailable": "无法加载连接。请确认主应用正在运行，然后选择“重新加载面板”。",
    "table.caption": "连接及其核对状态",
    "col.connection": "连接",
    "col.documents": "文档",
    "col.lastReconcile": "上次完整核对",
    "col.status": "状态",
    "col.mode": "来源删除文件时",
    "reconcile.never": "从未",
    "reconcile.connected": "连接于 {time}",
    "status.inStep": "一致",
    "status.overdue": "已逾期",
    "status.paused": "已暂停",
    "status.failed": "上次运行失败",
    "status.incomplete": "列表不完整",
    "status.notRun": "尚未运行",
    "reason.overdue": "未完成完整核对的天数：{age}。上限：{days}。",
    "reason.failed": "上次运行因错误而中止。下次运行会重试。",
    "reason.incomplete": "来源没有返回完整的文件列表，因此没有移除任何内容。",
    "summary.overdue": "超过核对时限的连接：{count}。这些来源中已删除的文件可能仍被用于回答。请确认计划内的核对正在运行，或运行 {command}，然后选择“刷新连接”。",
    "mode.aria": "{connection} 的删除方式",
    "mode.default": "默认（当前行为）",
    "mode.soft": "软删除",
    "mode.purge": "彻底清除",
    "mode.help.default": "跟随摄取管线设置：使用统一管线和异步队列时保留各版本，否则删除各版本。",
    "mode.help.soft": "文档不再用于回答。其各版本保留，用于历史记录和过往引用。",
    "mode.help.purge": "所有版本及由其生成的全部内容都会从每个存储中移除。过往引用显示“来源已撤回”。无法撤销。",
    "mode.saving": "正在保存…",
    "mode.saved": "{connection} 的删除方式：{mode}。仅对此后的删除生效。",
    "mode.failed": "删除方式未更改。请重试。",
    "confirm.purgeMode.title": "对 {connection} 使用彻底清除方式？",
    "confirm.purgeMode.body": "从现在起，当该来源删除某个文件时，对应文档的所有版本及由其生成的全部内容都会在这里被移除：文本块、检索向量、缓存的回答、已存储的文件和页面图片。过往回答将显示“来源已撤回”，不再显示引用的原文。被彻底清除的文档无法从本系统恢复。此前已移除的文档不受影响。如果一次同步将移除该连接超过 {share} 的文档，仍会暂停并等待确认。",
    "action.keepMode": "保持当前方式",
    "action.usePurge": "使用彻底清除方式",
    "paused.groupLabel": "{connection} 的已暂停运行",
    "paused.body": "来源中文件缺失的文档：{total} 个中的 {count} 个（{percent}）。已超过 {share} 的上限，因此没有移除任何内容。",
    "paused.bodyAll": "来源没有返回任何文件。该连接的全部文档（{total} 个）都将被移除，因此没有移除任何内容。",
    "paused.bodyCap": "该连接已达到每日 {cap} 个的清除上限，来源之后报告删除的 {count} 个文件因此没有被清除。",
    "paused.when": "发现于 {time}。可在 {deadline} 之前确认。",
    "paused.files": "显示文件：{count}",
    "paused.filesMore": "未显示：{count}",
    "paused.dismissHelp": "“忽略此次运行”会保留所有文档。下次核对会重新检查。",
    "action.remove": "移除文档…",
    "action.dismiss": "忽略此次运行",
    "dismiss.running": "正在忽略…",
    "confirm.remove.title": "从 {connection} 移除文档？",
    "confirm.remove.count": "文档：{count}",
    "confirm.remove.body.default": "这些文档将不再用于回答。在默认方式下，其各版本按摄取管线设置保留或删除。",
    "confirm.remove.body.soft": "这些文档将不再用于回答。其各版本保留，用于历史记录和过往引用。",
    "confirm.remove.body.purge": "这些文档的所有版本及由其生成的全部内容都会从每个存储中移除。过往回答将显示“来源已撤回”，不再显示引用的原文。此操作无法撤销。",
    "action.goBack": "返回",
    "action.removeConfirm": "移除文档",
    "confirm.removing": "正在移除…",
    "remove.done": "已从 {connection} 移除：{removed}。",
    "remove.partial": "已从 {connection} 移除：{removed}。未移除：{failed}。这些文档仍在知识库中，下次核对会重试。",
    "remove.failed": "文档未被移除。请重试。",
    "dismiss.done": "已忽略此次运行。没有移除任何文档。",
    "expired.body": "此次已暂停的运行已超过 24 小时，无法再确认。没有移除任何内容。请在 Connectors 中启动一次同步，或等待下一次计划内的核对，以获得新的统计。",
    "error.runGone": "此次运行已被确认或忽略。列表已重新加载。",
    "error.connectionGone": "该连接已不存在，或不在你管理的工作区中。列表已重新加载。",
    "error.off": "此部署中没有来源同步：该功能已关闭，或主应用的版本不包含此功能。此处没有可管理的内容。"
  },
  it: {
    "panel.title": "Sincronizzazione delle fonti",
    "panel.description": "Mantiene la knowledge base allineata alle fonti collegate. Una riconciliazione completa elenca tutti i file di una fonte e rimuove i documenti il cui file non esiste più. Per ogni connessione, scegli che cosa comporta qui un'eliminazione alla fonte.",
    "panel.tabsLabel": "Viste della sincronizzazione",
    "tab.connections": "Connessioni",
    "tab.settings": "Impostazioni",
    "action.refresh": "Aggiorna connessioni",
    "action.loadMore": "Carica altre connessioni",
    "action.reload": "Ricarica pannello",
    "action.openConnectors": "Apri Connectors",
    "list.loading": "Caricamento delle connessioni…",
    "list.loaded": "Connessioni caricate: {count}. In ritardo: {overdue}. In pausa: {paused}.",
    "list.updatedAt": "Aggiornato alle {time}",
    "list.empty.title": "Nessuna connessione da gestire",
    "list.empty.body": "Le connessioni compaiono qui dopo aver collegato un account in Connectors. In modalità multi-tenant sono elencate solo le connessioni degli spazi di lavoro che amministri.",
    "list.unavailable": "Impossibile caricare le connessioni. Verifica che l'app principale sia in esecuzione, poi seleziona Ricarica pannello.",
    "table.caption": "Connessioni e stato di riconciliazione",
    "col.connection": "Connessione",
    "col.documents": "Documenti",
    "col.lastReconcile": "Ultima riconciliazione completa",
    "col.status": "Stato",
    "col.mode": "Quando un file viene eliminato alla fonte",
    "reconcile.never": "Mai",
    "reconcile.connected": "Collegata {time}",
    "status.inStep": "Allineata",
    "status.overdue": "In ritardo",
    "status.paused": "In pausa",
    "status.failed": "Ultima esecuzione non riuscita",
    "status.incomplete": "Elenco incompleto",
    "status.notRun": "Non ancora eseguita",
    "reason.overdue": "Giorni senza una riconciliazione completa: {age}. Limite: {days}.",
    "reason.failed": "L'ultima esecuzione si è interrotta per un errore. La prossima riprova.",
    "reason.incomplete": "La fonte non ha restituito un elenco completo dei file, quindi non è stato rimosso nulla.",
    "summary.overdue": "Connessioni oltre il limite di età della riconciliazione: {count}. I file eliminati in quelle fonti possono essere ancora usati nelle risposte. Verifica che la riconciliazione pianificata sia attiva, oppure esegui {command}, poi seleziona Aggiorna connessioni.",
    "mode.aria": "Modalità di eliminazione per {connection}",
    "mode.default": "Predefinita (comportamento attuale)",
    "mode.soft": "Eliminazione logica",
    "mode.purge": "Eliminazione definitiva",
    "mode.help.default": "Segue le impostazioni della pipeline di acquisizione: con pipeline unificata e coda asincrona le versioni restano, altrimenti vengono eliminate.",
    "mode.help.soft": "Il documento non viene più usato nelle risposte. Le versioni restano per lo storico e per le citazioni passate.",
    "mode.help.purge": "Ogni versione e tutto ciò che ne deriva viene rimosso da ogni archivio. Le citazioni passate mostrano «Fonte ritirata». Non si può annullare.",
    "mode.saving": "Salvataggio…",
    "mode.saved": "Modalità di eliminazione per {connection}: {mode}. Vale per le eliminazioni da ora in poi.",
    "mode.failed": "La modalità di eliminazione non è stata modificata. Riprova.",
    "confirm.purgeMode.title": "Usare l'eliminazione definitiva per {connection}?",
    "confirm.purgeMode.body": "Da ora in poi, quando un file viene eliminato in questa fonte, ogni versione del suo documento e tutto ciò che ne deriva viene rimosso qui: frammenti, vettori di ricerca, risposte in cache, file archiviati e immagini delle pagine. Le risposte passate mostrano «Fonte ritirata» al posto del testo citato. Un documento eliminato definitivamente non può essere ripristinato da questo sistema. I documenti rimossi in precedenza non cambiano. Una sincronizzazione che rimuoverebbe più del {share} dei documenti di questa connessione resta comunque in pausa in attesa di conferma.",
    "action.keepMode": "Mantieni la modalità attuale",
    "action.usePurge": "Usa l'eliminazione definitiva",
    "paused.groupLabel": "Esecuzione in pausa per {connection}",
    "paused.body": "Documenti il cui file manca alla fonte: {count} su {total} ({percent}). È oltre il limite del {share}, quindi non è stato rimosso nulla.",
    "paused.bodyAll": "La fonte non ha restituito alcun file. Tutti i documenti di questa connessione ({total}) verrebbero rimossi, quindi non è stato rimosso nulla.",
    "paused.bodyCap": "La fonte ha segnalato {count} file eliminati dopo che questa connessione ha raggiunto il limite giornaliero di {cap} eliminazioni definitive, quindi non sono stati eliminati.",
    "paused.when": "Rilevato il {time}. Si può confermare fino al {deadline}.",
    "paused.files": "Mostra file: {count}",
    "paused.filesMore": "Non mostrati: {count}",
    "paused.dismissHelp": "Ignora esecuzione conserva tutti i documenti. La prossima riconciliazione controlla di nuovo.",
    "action.remove": "Rimuovi documenti…",
    "action.dismiss": "Ignora esecuzione",
    "dismiss.running": "Operazione in corso…",
    "confirm.remove.title": "Rimuovere i documenti da {connection}?",
    "confirm.remove.count": "Documenti: {count}",
    "confirm.remove.body.default": "Questi documenti non verranno più usati nelle risposte. In modalità predefinita le versioni restano o vengono eliminate secondo le impostazioni della pipeline di acquisizione.",
    "confirm.remove.body.soft": "Questi documenti non verranno più usati nelle risposte. Le versioni restano per lo storico e per le citazioni passate.",
    "confirm.remove.body.purge": "Ogni versione di questi documenti e tutto ciò che ne deriva viene rimosso da ogni archivio. Le risposte passate mostrano «Fonte ritirata» al posto del testo citato. Non si può annullare.",
    "action.goBack": "Indietro",
    "action.removeConfirm": "Rimuovi documenti",
    "confirm.removing": "Rimozione…",
    "remove.done": "Rimossi da {connection}: {removed}.",
    "remove.partial": "Rimossi da {connection}: {removed}. Non rimossi: {failed}. Restano nella knowledge base e la prossima riconciliazione riprova.",
    "remove.failed": "I documenti non sono stati rimossi. Riprova.",
    "dismiss.done": "Esecuzione ignorata. Nessun documento è stato rimosso.",
    "expired.body": "Questa esecuzione in pausa ha più di 24 ore e non può più essere confermata. Non è stato rimosso nulla. Avvia una sincronizzazione in Connectors, oppure attendi la prossima riconciliazione pianificata, per ottenere un conteggio aggiornato.",
    "error.runGone": "Questa esecuzione è già stata confermata o ignorata. L'elenco è stato ricaricato.",
    "error.connectionGone": "Questa connessione non esiste più o non è in uno spazio di lavoro che amministri. L'elenco è stato ricaricato.",
    "error.off": "La sincronizzazione delle fonti non è disponibile in questa distribuzione: la funzione è disattivata oppure l'app principale è una versione che non la include. Qui non c'è nulla da gestire."
  },
};

const SOURCE_SYNC_PAGE_SIZE = 50;
const SOURCE_SYNC_MAX_NAMES = 20;
const SOURCE_SYNC_COMMAND = 'npm run rag:source-reconcile';
const SOURCE_SYNC_MODES = ['', 'soft', 'purge'];
/** Below 1024px each connection stacks into one block, so no column of the table sits in sideways scroll. */
const SOURCE_SYNC_STACK = {
  table: 'max-lg:block max-lg:w-full',
  head: 'max-lg:hidden',
  body: 'max-lg:block',
  row: 'max-lg:flex max-lg:flex-col max-lg:gap-3 max-lg:py-3',
  cell: 'max-lg:block max-lg:w-full max-lg:max-w-none max-lg:p-0',
  label: 'lg:hidden text-xs font-semibold mb-1',
};
const SOURCE_SYNC_SOLID_BUTTON = 'btn bg-base-100 text-base-content border-base-300 hover:bg-base-200';
const SOURCE_SYNC_SELECT_FOCUS = 'focus-visible:[outline-color:var(--fallback-p,oklch(var(--p)/1))]';
const SOURCE_SYNC_TOUCH = 'max-md:min-h-12';

const SOURCE_SYNC_STATES = {
  in_step: { key: 'status.inStep', className: 'badge badge-success badge-outline badge-sm', icon: 'bi-check-circle' },
  overdue: { key: 'status.overdue', className: 'badge badge-warning badge-sm', icon: 'bi-clock-history' },
  paused: { key: 'status.paused', className: 'badge badge-warning badge-sm', icon: 'bi-pause-circle' },
  failed: { key: 'status.failed', className: 'badge badge-error badge-outline badge-sm', icon: 'bi-x-octagon' },
  incomplete: { key: 'status.incomplete', className: 'badge badge-warning badge-outline badge-sm', icon: 'bi-exclamation-triangle' },
  not_run: { key: 'status.notRun', className: 'badge badge-ghost badge-sm', icon: 'bi-hourglass' },
};

let sourceSyncSharedLabel = null;
if (typeof require !== 'undefined') {
  try {
    sourceSyncSharedLabel = require('../document-processing/status-monitor.js').ingestLabel;
  } catch {
    sourceSyncSharedLabel = null;
  }
}

function sourceSyncLocale() {
  const lang = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').slice(0, 2);
  return lang === 'zh' || lang === 'it' ? lang : 'en';
}

function sourceSyncFill(text, vars) {
  if (!text || !vars) return text;
  let out = text;
  for (const [key, value] of Object.entries(vars)) out = out.split('{' + key + '}').join(String(value ?? ''));
  return out;
}

function sourceSyncShared(key, locale, vars) {
  if (typeof window !== 'undefined' && typeof window.ingestLabel === 'function') return window.ingestLabel(key, locale, vars);
  if (sourceSyncSharedLabel) return sourceSyncSharedLabel(key, locale, vars);
  return key;
}

function sourceSyncLabel(key, locale, vars) {
  const loc = locale === 'zh' || locale === 'it' ? locale : 'en';
  const table = SOURCE_SYNC_LABELS[loc];
  if (table[key]) return sourceSyncFill(table[key], vars);
  if (SOURCE_SYNC_LABELS.en[key]) return sourceSyncFill(SOURCE_SYNC_LABELS.en[key], vars);
  return sourceSyncShared(key, loc, vars);
}

function sourceSyncNumber(value, locale) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat(locale).format(n);
}

function sourceSyncPercent(value, locale) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(n);
}

function sourceSyncTime(iso, locale, now) {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const absolute = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  const diff = (ms - (Number.isFinite(now) ? now : Date.now())) / 1000;
  const abs = Math.abs(diff);
  const units = [
    ['second', 60],
    ['minute', 3600],
    ['hour', 86400],
    ['day', 86400 * 30],
    ['month', 86400 * 365],
  ];
  const sizes = { second: 1, minute: 60, hour: 3600, day: 86400, month: 86400 * 30, year: 86400 * 365 };
  let unit = 'year';
  for (const [name, limit] of units) {
    if (abs < limit) {
      unit = name;
      break;
    }
  }
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(diff / sizes[unit]), unit);
  return { iso, absolute, relative };
}

function sourceSyncModeValue(mode) {
  if (mode === null || mode === undefined || mode === '') return '';
  return String(mode);
}

function sourceSyncModeLabel(value, locale) {
  if (value === '') return sourceSyncLabel('mode.default', locale);
  if (value === 'soft' || value === 'purge') return sourceSyncLabel('mode.' + value, locale);
  return value;
}

function sourceSyncModeHelp(value, locale) {
  if (value === '' || value === 'soft' || value === 'purge') return sourceSyncLabel('mode.help.' + (value || 'default'), locale);
  return '';
}

function sourceSyncStates(row) {
  const states = Array.isArray(row && row.states) ? row.states.filter((s) => typeof s === 'string') : [];
  const paused = states.filter((s) => s === 'paused');
  return paused.concat(states.filter((s) => s !== 'paused'));
}

function sourceSyncGroup(row) {
  const states = sourceSyncStates(row);
  if (states.includes('paused')) return 0;
  if (states.includes('overdue')) return 1;
  if (states.includes('failed') || states.includes('incomplete')) return 2;
  return 3;
}

function sourceSyncSortRows(rows) {
  const text = (v) => (typeof v === 'string' ? v : '');
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const g = sourceSyncGroup(a.row) - sourceSyncGroup(b.row);
      if (g) return g;
      const p = text(a.row.provider_name).localeCompare(text(b.row.provider_name));
      if (p) return p;
      const o = text(a.row.owner && a.row.owner.label).localeCompare(text(b.row.owner && b.row.owner.label));
      return o || a.index - b.index;
    })
    .map((entry) => entry.row);
}

function buildPausedRunView(run, locale, now, limits) {
  if (!run || typeof run !== 'object') return null;
  const loc = locale === 'zh' || locale === 'it' ? locale : 'en';
  const at = Number.isFinite(now) ? now : Date.now();
  const count = Number(run.candidate_count) || 0;
  const total = Number(run.total_count) || 0;
  const share = limits && Number.isFinite(Number(limits.max_delete_share)) ? Number(limits.max_delete_share) : null;
  let body;
  if (run.pause_reason === 'purge_daily_cap') {
    const cap = run.daily_cap ?? (limits && limits.purge_daily_cap);
    body = sourceSyncLabel('paused.bodyCap', loc, { count: sourceSyncNumber(count, loc), cap: sourceSyncNumber(cap, loc) });
  } else if (total > 0 && count >= total) {
    body = sourceSyncLabel('paused.bodyAll', loc, { total: sourceSyncNumber(total, loc) });
  } else {
    body = sourceSyncLabel('paused.body', loc, {
      count: sourceSyncNumber(count, loc),
      total: sourceSyncNumber(total, loc),
      percent: sourceSyncPercent(total > 0 ? count / total : 0, loc),
      share: share === null ? '' : sourceSyncPercent(share, loc),
    });
  }
  const sentNames = (Array.isArray(run.file_names) ? run.file_names : []).filter((n) => typeof n === 'string');
  const names = sentNames.slice(0, SOURCE_SYNC_MAX_NAMES);
  const ids = names.length ? [] : (Array.isArray(run.file_ids) ? run.file_ids : []).filter((n) => typeof n === 'string').slice(0, SOURCE_SYNC_MAX_NAMES);
  const notSent = Number(run.names_not_sent);
  const notShown = names.length
    ? Math.max(0, (Number.isFinite(notSent) ? notSent : count - sentNames.length) + sentNames.length - names.length)
    : Math.max(0, count - ids.length);
  const expiresMs = Date.parse(run.expires_at);
  return {
    id: typeof run.id === 'string' ? run.id : '',
    count,
    body,
    expired: Number.isFinite(expiresMs) && expiresMs <= at,
    expiredBody: sourceSyncLabel('expired.body', loc),
    foundAt: sourceSyncTime(run.found_at, loc, at),
    expiresAt: sourceSyncTime(run.expires_at, loc, at),
    names,
    ids,
    filesSummary: sourceSyncLabel('paused.files', loc, { count: sourceSyncNumber(count, loc) }),
    filesMore: notShown > 0 ? sourceSyncLabel('paused.filesMore', loc, { count: sourceSyncNumber(notShown, loc) }) : null,
  };
}

function buildSourceSyncRowView(row, locale, limits, now) {
  const loc = locale === 'zh' || locale === 'it' ? locale : 'en';
  const at = Number.isFinite(now) ? now : Date.now();
  const str = (v) => (typeof v === 'string' ? v : '');
  const states = sourceSyncStates(row);
  const badges = states.map((state) => {
    const spec = SOURCE_SYNC_STATES[state];
    if (!spec) return { state, label: state, className: 'badge badge-outline badge-sm', icon: null, unknown: true };
    return { state, label: sourceSyncLabel(spec.key, loc), className: spec.className, icon: spec.icon, unknown: false };
  });
  const reasonLines = [];
  if (states.includes('overdue')) {
    reasonLines.push(
      sourceSyncLabel('reason.overdue', loc, {
        age: sourceSyncNumber(row.days_without_reconcile, loc),
        days: sourceSyncNumber(limits && limits.max_age_days, loc),
      }),
    );
  }
  if (states.includes('failed')) reasonLines.push(sourceSyncLabel('reason.failed', loc));
  if (states.includes('incomplete')) reasonLines.push(sourceSyncLabel('reason.incomplete', loc));
  const lastReconcile = sourceSyncTime(row.last_full_reconcile_at, loc, at);
  const connected = sourceSyncTime(row.connected_at, loc, at);
  const mode = sourceSyncModeValue(row.deletion_mode);
  const sentRuns = Array.isArray(row.paused_runs) && row.paused_runs.length ? row.paused_runs : row.paused_run ? [row.paused_run] : [];
  const pausedRuns = sentRuns.map((run) => buildPausedRunView(run, loc, at, limits)).filter(Boolean);
  return {
    id: str(row.id),
    connection: str(row.provider_name) || str(row.provider),
    owner: str(row.owner && row.owner.label),
    workspaceKey: str(row.workspace_key),
    documents: sourceSyncNumber(row.document_count, loc),
    lastReconcile,
    never: !lastReconcile,
    neverLabel: sourceSyncLabel('reconcile.never', loc),
    connectedLine: connected ? sourceSyncLabel('reconcile.connected', loc, { time: connected.relative }) : '',
    connectedAt: connected,
    badges,
    reasonLines,
    mode,
    modeHelp: sourceSyncModeHelp(mode, loc),
    pausedRun: pausedRuns[0] || null,
    pausedRuns,
  };
}

function sourceSyncAppUrl(fallback) {
  if (fallback) return fallback;
  if (typeof window !== 'undefined' && typeof window.getConfiguredMyRAGAppUrl === 'function') return window.getConfiguredMyRAGAppUrl();
  if (typeof window !== 'undefined' && window.location && window.location.origin) return window.location.origin;
  return 'http://localhost:3000';
}

const SOURCE_SYNC_KNOWN_CODES = new Set(['not_found', 'invalid_argument', 'run_not_pending', 'confirmation_expired', 'unavailable']);

function mapSourceSyncError(result, locale, context, appUrl) {
  const loc = locale === 'zh' || locale === 'it' ? locale : 'en';
  const status = result && result.status;
  const body = (result && result.body) || {};
  const code = body && typeof body.error === 'string' ? body.error : '';
  const msg = (key, vars) => ({ key, message: sourceSyncLabel(key, loc, vars) });
  if (result && result.thrown) return { ...msg('error.network'), kind: 'network' };
  if (status === 401 || status === 403) {
    return { ...msg('error.signIn', { appUrl: sourceSyncAppUrl(appUrl) }), kind: 'auth' };
  }
  if (context === 'list') {
    if (status === 404) return { ...msg('error.off'), kind: 'off' };
    if (status === 503 || (status >= 500 && status < 600)) return { ...msg('list.unavailable'), kind: 'unavailable' };
  }
  if (context === 'mode') {
    if (status === 404) return { ...msg('error.connectionGone'), reload: true };
    if (status === 503) return { ...msg('error.unavailable'), kind: 'unavailable' };
    if (status === 400 || status === 409 || (status >= 500 && status < 600)) return msg('mode.failed');
  }
  if (context === 'confirm' || context === 'dismiss') {
    if (status === 409 && code === 'confirmation_expired') return { ...msg('expired.body'), expired: true };
    if (status === 404 || (status === 409 && code === 'run_not_pending')) return { ...msg('error.runGone'), reload: true };
    if (context === 'confirm' && status >= 500 && status < 600) return msg('remove.failed');
  }
  if (status === 503) return { ...msg('error.unavailable'), kind: 'unavailable' };
  const out = msg('error.generic', { status: status || '?' });
  if (code && !SOURCE_SYNC_KNOWN_CODES.has(code)) out.code = code;
  return out;
}

function sourceSyncEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function sourceSyncIcon(name) {
  const icon = document.createElement('i');
  icon.className = 'bi ' + name;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function sourceSyncSpinner() {
  const spin = document.createElement('span');
  spin.className = 'loading loading-spinner loading-sm motion-reduce:hidden';
  spin.setAttribute('aria-hidden', 'true');
  return spin;
}

function sourceSyncTimeEl(time, text) {
  const el = document.createElement('time');
  el.setAttribute('datetime', time.iso);
  el.title = time.absolute;
  el.textContent = text === undefined ? time.relative : text;
  return el;
}

/** Fills a template whose placeholders become DOM nodes (times, code); everything else stays text. */
function sourceSyncFillNodes(parent, template, nodes) {
  const parts = String(template).split(/(\{[a-zA-Z]+\})/);
  for (const part of parts) {
    const m = /^\{([a-zA-Z]+)\}$/.exec(part);
    if (m && nodes[m[1]]) parent.appendChild(nodes[m[1]]);
    else if (part) parent.appendChild(document.createTextNode(part));
  }
  return parent;
}

function sourceSyncButtonBusy(button, busy, text) {
  if (busy) {
    if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
    button.replaceChildren(sourceSyncSpinner(), document.createTextNode(text));
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.replaceChildren(document.createTextNode(button.dataset.idleText || button.textContent));
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

class SourceSyncPanel {
  constructor(root) {
    this.root = root;
    this.locale = sourceSyncLocale();
    this.mounted = false;
    this.rows = [];
    this.total = 0;
    this.limits = {};
    this.loaded = false;
    this.loading = false;
    this.updatedAt = null;
    this.expiredRuns = new Set();
    this.runErrors = new Map();
    this.partialMessage = '';
    this.activeTab = 'connections';
    this.appUrl = (root && root.dataset && root.dataset.appUrl) || null;
  }

  t(key, vars) {
    return sourceSyncLabel(key, this.locale, vars);
  }

  mount() {
    if (this.mounted) {
      this.refresh();
      return;
    }
    this.mounted = true;
    this.root.setAttribute('lang', this.locale);
    const title = this.root.querySelector('[data-source-sync-title]');
    if (title) title.textContent = this.t('panel.title');
    const desc = this.root.querySelector('[data-source-sync-description]');
    if (desc) desc.textContent = this.t('panel.description');
    this.alertHost = this.root.querySelector('[data-source-sync-alert]');
    this.statusEl = this.root.querySelector('[data-source-sync-status]');
    this.buildChrome();
    this.refresh();
  }

  buildChrome() {
    const content = this.root.querySelector('[data-source-sync-content]') || this.root;
    const tablist = sourceSyncEl('div', 'tabs tabs-bordered mb-4');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', this.t('panel.tabsLabel'));
    this.tabs = {};
    this.tabPanels = {};
    for (const name of ['connections', 'settings']) {
      const tab = sourceSyncEl('button', 'tab', this.t('tab.' + name));
      tab.type = 'button';
      tab.id = 'rag-source-sync-tab-' + name;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'rag-source-sync-panel-' + name);
      tab.addEventListener('click', () => this.selectTab(name));
      tab.addEventListener('keydown', (event) => this.onTabKey(event, name));
      tablist.appendChild(tab);
      this.tabs[name] = tab;
      const panel = sourceSyncEl('div', 'min-w-0');
      panel.id = 'rag-source-sync-panel-' + name;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      this.tabPanels[name] = panel;
    }
    this.view = sourceSyncEl('div', 'min-w-0');
    this.view.setAttribute('data-source-sync-view', '');
    this.tabPanels.connections.appendChild(this.view);
    const settings = document.getElementById('rag-source-sync-settings');
    if (settings) this.tabPanels.settings.appendChild(settings);
    const openModes = this.tabPanels.settings.querySelector('[data-source-sync-open-rag-modes]');
    if (openModes) openModes.addEventListener('click', () => this.openTab('rag-modes', 'RAG_SOURCE_RECHECK'));
    content.append(tablist, this.tabPanels.connections, this.tabPanels.settings);
    this.selectTab(this.activeTab, false);
  }

  selectTab(name, focus) {
    this.activeTab = name;
    for (const key of Object.keys(this.tabs)) {
      const active = key === name;
      this.tabs[key].classList.toggle('tab-active', active);
      this.tabs[key].setAttribute('aria-selected', active ? 'true' : 'false');
      this.tabs[key].setAttribute('tabindex', active ? '0' : '-1');
      this.tabPanels[key].hidden = !active;
    }
    if (focus) this.tabs[name].focus();
  }

  onTabKey(event, name) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.preventDefault) event.preventDefault();
    this.selectTab(name === 'connections' ? 'settings' : 'connections', true);
  }

  openTab(tab, focusId) {
    const link = document.querySelector('.menu-item[data-tab="' + tab + '"]') || document.querySelector('[data-tab="' + tab + '"]');
    if (link) link.click();
    if (focusId) {
      const target = document.getElementById(focusId);
      if (target) target.focus();
    }
  }

  announce(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  async rag(path, init) {
    const fetcher = typeof window !== 'undefined' && window.ragFetch ? window.ragFetch : null;
    if (!fetcher) return { ok: false, status: 0, thrown: true };
    try {
      return await fetcher(path, init);
    } catch (e) {
      return { ok: false, status: 0, thrown: true, error: e };
    }
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
    if (this.refreshButton) sourceSyncButtonBusy(this.refreshButton, busy, this.t('list.loading'));
  }

  async loadList(opts) {
    const append = !!(opts && opts.append);
    const keepPartial = !!(opts && opts.keepPartial);
    if (this.loading) return;
    this.loading = true;
    if (!keepPartial) this.partialMessage = '';
    if (!this.loaded) {
      this.view.replaceChildren(sourceSyncEl('p', 'flex items-center gap-2 text-sm'));
      this.view.firstChild.append(sourceSyncSpinner(), document.createTextNode(this.t('list.loading')));
    } else {
      this.setBusy(true);
    }
    const offset = append ? this.rows.length : 0;
    const result = await this.rag('admin/source-sync/connections?limit=' + SOURCE_SYNC_PAGE_SIZE + '&offset=' + offset, { method: 'GET' });
    this.loading = false;
    if (!result.ok) {
      const mapped = mapSourceSyncError(result, this.locale, 'list', this.appUrl);
      if (this.loaded) this.setBusy(false);
      if (mapped.kind === 'auth') {
        this.renderAlert('');
        this.loaded = false;
        this.rows = [];
        this.view.classList.remove('opacity-60');
        this.view.replaceChildren(this.reloadAlert('alert alert-warning text-sm', mapped));
        return;
      }
      if (mapped.kind === 'off') {
        this.renderAlert('');
        this.loaded = false;
        this.rows = [];
        this.view.classList.remove('opacity-60');
        const off = sourceSyncEl('div', 'alert items-start text-left text-sm');
        off.setAttribute('data-source-sync-off', '');
        off.append(sourceSyncIcon('bi-info-circle'), sourceSyncEl('p', 'max-w-prose', mapped.message));
        this.view.replaceChildren(off);
        this.announce(mapped.message);
        return;
      }
      this.renderAlert(mapped);
      if (this.loaded) this.view.classList.add('opacity-60');
      else this.view.replaceChildren();
      return;
    }
    this.renderAlert('');
    const body = result.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    this.rows = sourceSyncSortRows(append ? this.rows.concat(items) : items);
    this.total = Number(body.total) || this.rows.length;
    this.limits = body.limits || {};
    this.loaded = true;
    this.updatedAt = Date.now();
    this.render();
    this.setBusy(false);
    const overdue = this.rows.filter((r) => sourceSyncStates(r).includes('overdue')).length;
    const paused = this.rows.filter((r) => sourceSyncStates(r).includes('paused')).length;
    if (!(opts && opts.quiet)) this.announce(this.t('list.loaded', { count: sourceSyncNumber(this.rows.length, this.locale), overdue, paused }));
    if (opts && opts.focusConnection) this.focusMode(opts.focusConnection);
    if (append && this.loadMoreButton) this.loadMoreButton.focus();
  }

  reloadAlert(className, mapped) {
    const alert = sourceSyncEl('div', className);
    const p = sourceSyncEl('p', 'max-w-prose', mapped.message);
    if (mapped.code) {
      p.appendChild(document.createTextNode(' '));
      const code = sourceSyncEl('span', 'font-mono text-xs', mapped.code);
      code.setAttribute('lang', 'en');
      p.appendChild(code);
    }
    const reload = sourceSyncEl('button', SOURCE_SYNC_SOLID_BUTTON + ' btn-sm ' + SOURCE_SYNC_TOUCH, this.t('action.reload'));
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

  focusMode(connectionId) {
    const select = this.root.querySelector('[data-source-sync-mode="' + connectionId + '"]');
    if (select) select.focus();
  }

  render() {
    const view = this.view;
    view.replaceChildren();
    const toolbar = sourceSyncEl('div', 'flex flex-wrap items-center gap-2 mb-4');
    const updated = sourceSyncEl('span', 'ml-auto text-xs text-base-content/70');
    const time = sourceSyncTime(new Date(this.updatedAt).toISOString(), this.locale, this.updatedAt);
    const timeShort = new Intl.DateTimeFormat(this.locale, { timeStyle: 'short' }).format(new Date(this.updatedAt));
    sourceSyncFillNodes(updated, this.t('list.updatedAt'), { time: sourceSyncTimeEl(time, timeShort) });
    const refresh = sourceSyncEl('button', 'btn btn-outline btn-sm');
    refresh.type = 'button';
    refresh.append(sourceSyncIcon('bi-arrow-clockwise'), document.createTextNode(this.t('action.refresh')));
    refresh.dataset.idleText = this.t('action.refresh');
    refresh.addEventListener('click', () => this.refresh());
    this.refreshButton = refresh;
    toolbar.append(updated, refresh);
    view.appendChild(toolbar);

    if (this.partialMessage) {
      const partial = sourceSyncEl('div', 'alert alert-warning text-sm mb-4');
      partial.append(sourceSyncIcon('bi-exclamation-triangle'), sourceSyncEl('p', 'max-w-prose', this.partialMessage));
      view.appendChild(partial);
    }

    if (!this.rows.length) {
      const empty = sourceSyncEl('div', 'py-8 flex flex-col items-start gap-2');
      empty.appendChild(sourceSyncEl('h4', 'text-base font-semibold', this.t('list.empty.title')));
      empty.appendChild(sourceSyncEl('p', 'text-sm max-w-prose', this.t('list.empty.body')));
      const open = sourceSyncEl('button', 'btn btn-outline btn-sm', this.t('action.openConnectors'));
      open.type = 'button';
      open.addEventListener('click', () => this.openTab('connectors'));
      empty.appendChild(open);
      view.appendChild(empty);
      this.loadMoreButton = null;
      return;
    }

    const overdue = this.rows.filter((r) => sourceSyncStates(r).includes('overdue')).length;
    if (overdue > 0) {
      const summary = sourceSyncEl('div', 'alert alert-warning items-start text-left text-sm mb-4');
      const p = sourceSyncEl('p', 'max-w-prose');
      sourceSyncFillNodes(p, this.t('summary.overdue', { count: sourceSyncNumber(overdue, this.locale) }), {
        command: sourceSyncEl('code', 'font-mono text-xs break-all', SOURCE_SYNC_COMMAND),
      });
      p.querySelector('code').setAttribute('translate', 'no');
      summary.append(sourceSyncIcon('bi-exclamation-triangle'), p);
      view.appendChild(summary);
    }

    const region = sourceSyncEl('div', 'overflow-x-auto');
    region.setAttribute('tabindex', '0');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', this.t('table.caption'));
    const table = sourceSyncEl('table', 'table table-sm ' + SOURCE_SYNC_STACK.table);
    table.appendChild(sourceSyncEl('caption', 'sr-only', this.t('table.caption')));
    const thead = sourceSyncEl('thead', SOURCE_SYNC_STACK.head);
    const headRow = document.createElement('tr');
    const cols = [
      ['col.connection', 'text-xs font-semibold'],
      ['col.documents', 'hidden lg:table-cell text-xs font-semibold text-right'],
      ['col.lastReconcile', 'text-xs font-semibold'],
      ['col.status', 'text-xs font-semibold'],
      ['col.mode', 'text-xs font-semibold'],
    ];
    for (const [key, cls] of cols) {
      const th = sourceSyncEl('th', cls, this.t(key));
      th.setAttribute('scope', 'col');
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = sourceSyncEl('tbody', SOURCE_SYNC_STACK.body);
    for (const row of this.rows) this.renderRow(tbody, row);
    table.appendChild(tbody);
    region.appendChild(table);
    view.appendChild(region);

    this.loadMoreButton = null;
    if (this.rows.length < this.total) {
      const more = sourceSyncEl('button', 'btn btn-outline btn-sm mt-4', this.t('action.loadMore'));
      more.type = 'button';
      more.addEventListener('click', () => this.loadList({ append: true, quiet: false }));
      this.loadMoreButton = more;
      view.appendChild(more);
    }
  }

  renderRow(tbody, row) {
    const view = buildSourceSyncRowView(row, this.locale, this.limits, Date.now());
    const tr = sourceSyncEl('tr', SOURCE_SYNC_STACK.row);
    const th = sourceSyncEl('th', 'font-normal align-top min-w-0 max-w-xs ' + SOURCE_SYNC_STACK.cell);
    th.setAttribute('scope', 'row');
    const name = sourceSyncEl('div', 'text-sm break-words', view.connection);
    name.setAttribute('translate', 'no');
    th.appendChild(name);
    if (view.owner) th.appendChild(sourceSyncEl('div', 'text-xs text-base-content/70 break-words', view.owner));
    if (view.workspaceKey) {
      const key = sourceSyncEl('div', 'font-mono text-xs break-all', view.workspaceKey);
      key.setAttribute('translate', 'no');
      th.appendChild(key);
    }
    th.appendChild(sourceSyncEl('div', 'lg:hidden text-xs tabular-nums', this.t('col.documents') + ': ' + view.documents));
    tr.appendChild(th);

    tr.appendChild(sourceSyncEl('td', 'hidden lg:table-cell align-top text-right tabular-nums', view.documents));

    const last = sourceSyncEl('td', 'align-top text-sm ' + SOURCE_SYNC_STACK.cell);
    last.appendChild(sourceSyncEl('div', SOURCE_SYNC_STACK.label, this.t('col.lastReconcile')));
    if (view.lastReconcile) last.appendChild(sourceSyncTimeEl(view.lastReconcile));
    else {
      last.appendChild(sourceSyncEl('div', '', view.neverLabel));
      if (view.connectedAt) {
        const line = sourceSyncEl('div', 'text-xs text-base-content/70');
        sourceSyncFillNodes(line, this.t('reconcile.connected'), { time: sourceSyncTimeEl(view.connectedAt) });
        last.appendChild(line);
      }
    }
    tr.appendChild(last);

    const statusTd = sourceSyncEl('td', 'align-top ' + SOURCE_SYNC_STACK.cell);
    statusTd.appendChild(sourceSyncEl('div', SOURCE_SYNC_STACK.label, this.t('col.status')));
    const badges = sourceSyncEl('div', 'flex flex-wrap gap-1');
    for (const badge of view.badges) {
      const el = sourceSyncEl('span', badge.className + ' gap-1 h-auto whitespace-normal');
      if (badge.icon) el.appendChild(sourceSyncIcon(badge.icon));
      const word = sourceSyncEl('span', badge.unknown ? 'font-mono' : '', badge.label);
      if (badge.unknown) word.setAttribute('lang', 'en');
      el.appendChild(word);
      badges.appendChild(el);
    }
    statusTd.appendChild(badges);
    for (const line of view.reasonLines) statusTd.appendChild(sourceSyncEl('p', 'text-xs text-base-content/70 mt-1 max-w-xs', line));
    tr.appendChild(statusTd);

    tr.appendChild(this.renderModeCell(row, view));
    tbody.appendChild(tr);

    for (const pausedRun of view.pausedRuns) {
      const runTr = sourceSyncEl('tr', SOURCE_SYNC_STACK.row);
      const td = sourceSyncEl('td', SOURCE_SYNC_STACK.cell);
      td.setAttribute('colspan', '5');
      td.appendChild(this.renderPausedBlock(row, { ...view, pausedRun }));
      runTr.appendChild(td);
      tbody.appendChild(runTr);
    }
  }

  renderModeCell(row, view) {
    const td = sourceSyncEl('td', 'align-top ' + SOURCE_SYNC_STACK.cell);
    const modeLabel = sourceSyncEl('div', SOURCE_SYNC_STACK.label, this.t('col.mode'));
    modeLabel.setAttribute('aria-hidden', 'true');
    td.appendChild(modeLabel);
    const select = sourceSyncEl(
      'select',
      'select select-bordered select-sm min-w-40 max-w-full max-lg:w-full max-md:h-12 ' + SOURCE_SYNC_SELECT_FOCUS,
    );
    const helpId = 'rag-source-sync-mode-help-' + view.id;
    select.setAttribute('aria-label', this.t('mode.aria', { connection: view.connection }));
    select.setAttribute('aria-describedby', helpId);
    select.setAttribute('data-source-sync-mode', view.id);
    const values = SOURCE_SYNC_MODES.includes(view.mode) ? SOURCE_SYNC_MODES : SOURCE_SYNC_MODES.concat([view.mode]);
    for (const value of values) {
      const option = sourceSyncEl('option', '', sourceSyncModeLabel(value, this.locale));
      option.value = value;
      if (value === view.mode) option.setAttribute('selected', '');
      select.appendChild(option);
    }
    select.value = view.mode;
    select.dataset.previous = view.mode;
    const help = sourceSyncEl('p', 'text-xs text-base-content/70 mt-1 max-w-xs', view.modeHelp);
    help.id = helpId;
    const error = sourceSyncEl('p', 'text-xs text-error mt-1 max-w-xs');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    select.addEventListener('change', () => this.onModeChange(row, view, select, help, error));
    td.append(select, help, error);
    return td;
  }

  onModeChange(row, view, select, help, error) {
    const previous = select.dataset.previous || '';
    const next = select.value;
    error.textContent = '';
    error.hidden = true;
    if (next === previous) return;
    if (next === 'purge') {
      this.openPurgeModeDialog(view, (confirmed) => {
        if (confirmed) this.saveMode(row, view, select, help, error, next, previous);
        else {
          select.value = previous;
          select.focus();
        }
      });
      return;
    }
    this.saveMode(row, view, select, help, error, next, previous);
  }

  async saveMode(row, view, select, help, error, next, previous) {
    select.disabled = true;
    help.replaceChildren(sourceSyncSpinner(), document.createTextNode(' ' + this.t('mode.saving')));
    const result = await this.rag('admin/source-sync/connections/' + encodeURIComponent(view.id) + '/deletion-mode', {
      method: 'PUT',
      body: JSON.stringify({ mode: next === '' ? null : next }),
    });
    select.disabled = false;
    if (!result.ok) {
      const mapped = mapSourceSyncError(result, this.locale, 'mode', this.appUrl);
      select.value = previous;
      help.textContent = sourceSyncModeHelp(previous, this.locale);
      if (mapped.reload) {
        this.announce(mapped.message);
        await this.loadList({ quiet: true });
        return;
      }
      error.textContent = mapped.message;
      error.hidden = false;
      select.focus();
      return;
    }
    row.deletion_mode = next === '' ? null : next;
    select.dataset.previous = next;
    help.textContent = sourceSyncModeHelp(next, this.locale);
    this.announce(this.t('mode.saved', { connection: view.connection, mode: sourceSyncModeLabel(next, this.locale) }));
    select.focus();
  }

  buildDialog(titleText, bodyNodes, cancelText, confirmText) {
    const dialog = sourceSyncEl('dialog', 'modal');
    dialog.setAttribute('lang', this.locale);
    const box = sourceSyncEl('div', 'modal-box overscroll-contain');
    const titleId = 'rag-source-sync-dialog-' + Math.random().toString(36).slice(2);
    const title = sourceSyncEl('h3', 'text-base font-semibold mb-2 break-words', titleText);
    title.id = titleId;
    dialog.setAttribute('aria-labelledby', titleId);
    box.appendChild(title);
    for (const node of bodyNodes) box.appendChild(node);
    const actions = sourceSyncEl('div', 'modal-action flex-wrap');
    const cancel = sourceSyncEl('button', 'btn', cancelText);
    cancel.type = 'button';
    cancel.setAttribute('autofocus', '');
    const confirm = sourceSyncEl('button', 'btn btn-error', confirmText);
    confirm.type = 'button';
    actions.append(cancel, confirm);
    box.appendChild(actions);
    dialog.appendChild(box);
    const backdrop = sourceSyncEl('form', 'modal-backdrop');
    backdrop.method = 'dialog';
    const close = sourceSyncEl('button', '', cancelText);
    close.type = 'submit';
    backdrop.appendChild(close);
    dialog.appendChild(backdrop);
    const state = { busy: false };
    dialog.addEventListener('cancel', (event) => {
      if (state.busy && event.preventDefault) event.preventDefault();
    });
    cancel.addEventListener('click', () => {
      if (!state.busy) dialog.close('cancel');
    });
    document.body.appendChild(dialog);
    return {
      dialog,
      cancel,
      confirm,
      setBusy: (busy, text) => {
        state.busy = busy;
        cancel.disabled = busy;
        close.disabled = busy;
        sourceSyncButtonBusy(confirm, busy, text);
      },
    };
  }

  openPurgeModeDialog(view, done) {
    const share = Number(this.limits && this.limits.max_delete_share);
    const body = sourceSyncEl(
      'p',
      'text-sm max-w-prose',
      this.t('confirm.purgeMode.body', { share: Number.isFinite(share) ? sourceSyncPercent(share, this.locale) : '' }),
    );
    const d = this.buildDialog(
      this.t('confirm.purgeMode.title', { connection: view.connection }),
      [body],
      this.t('action.keepMode'),
      this.t('action.usePurge'),
    );
    d.confirm.addEventListener('click', () => d.dialog.close('confirm'));
    d.dialog.addEventListener('close', () => {
      d.dialog.remove();
      done(d.dialog.returnValue === 'confirm');
    });
    d.dialog.showModal();
    d.cancel.focus();
  }

  renderPausedBlock(row, view) {
    const run = view.pausedRun;
    const expired = run.expired || this.expiredRuns.has(run.id);
    const block = sourceSyncEl('div', expired ? 'alert items-start text-left text-sm' : 'alert alert-warning items-start text-left text-sm');
    block.setAttribute('role', 'group');
    block.setAttribute('aria-label', this.t('paused.groupLabel', { connection: view.connection }));
    block.setAttribute('data-source-sync-run', run.id);
    block.appendChild(sourceSyncIcon(expired ? 'bi-clock' : 'bi-pause-circle'));
    const inner = sourceSyncEl('div', 'flex flex-col gap-2 min-w-0 w-full');
    if (expired) {
      inner.appendChild(sourceSyncEl('p', 'max-w-prose', run.expiredBody));
    } else {
      const body = sourceSyncEl('p', 'max-w-prose', run.body);
      if (run.id) {
        body.id = 'source-sync-run-body-' + run.id;
        block.setAttribute('aria-describedby', body.id);
      }
      inner.appendChild(body);
      if (run.foundAt && run.expiresAt) {
        const when = sourceSyncEl('p', 'text-xs');
        sourceSyncFillNodes(when, this.t('paused.when'), {
          time: sourceSyncTimeEl(run.foundAt, run.foundAt.absolute),
          deadline: sourceSyncTimeEl(run.expiresAt, run.expiresAt.absolute),
        });
        inner.appendChild(when);
      }
      if (run.count > 0) {
        const details = document.createElement('details');
        details.appendChild(sourceSyncEl('summary', 'cursor-pointer rounded py-1 max-md:py-3 ' + SOURCE_SYNC_TOUCH, run.filesSummary));
        const list = sourceSyncEl('ul', 'max-h-40 overflow-y-auto mt-2 text-sm');
        for (const name of run.names) list.appendChild(sourceSyncEl('li', 'break-words', name));
        for (const id of run.ids) {
          const li = sourceSyncEl('li', 'font-mono text-xs break-all', id);
          li.setAttribute('translate', 'no');
          list.appendChild(li);
        }
        details.appendChild(list);
        if (run.filesMore) details.appendChild(sourceSyncEl('p', 'text-xs mt-1', run.filesMore));
        inner.appendChild(details);
      }
    }
    const buttons = sourceSyncEl('div', 'flex flex-wrap items-center gap-2');
    let remove = null;
    if (!expired) {
      remove = sourceSyncEl('button', 'btn btn-error md:btn-sm', this.t('action.remove'));
      remove.type = 'button';
      buttons.appendChild(remove);
    }
    const dismiss = sourceSyncEl('button', SOURCE_SYNC_SOLID_BUTTON + ' md:btn-sm', this.t('action.dismiss'));
    dismiss.type = 'button';
    buttons.appendChild(dismiss);
    buttons.appendChild(sourceSyncEl('span', 'text-xs', this.t('paused.dismissHelp')));
    inner.appendChild(buttons);
    const error = sourceSyncEl('p', 'text-sm text-error');
    error.setAttribute('role', 'alert');
    const runError = this.runErrors.get(run.id);
    error.textContent = runError || '';
    error.hidden = !runError;
    inner.appendChild(error);
    block.appendChild(inner);
    if (remove) remove.addEventListener('click', () => this.openRemoveDialog(row, view, remove));
    dismiss.addEventListener('click', () => this.dismissRun(view, dismiss, remove));
    return block;
  }

  openRemoveDialog(row, view, opener) {
    const run = view.pausedRun;
    const modeKey = view.mode === 'soft' || view.mode === 'purge' ? view.mode : 'default';
    const count = sourceSyncEl('p', 'text-sm tabular-nums mb-2', this.t('confirm.remove.count', { count: sourceSyncNumber(run.count, this.locale) }));
    const body = sourceSyncEl('p', 'text-sm max-w-prose', this.t('confirm.remove.body.' + modeKey));
    const d = this.buildDialog(
      this.t('confirm.remove.title', { connection: view.connection }),
      [count, body],
      this.t('action.goBack'),
      this.t('action.removeConfirm'),
    );
    let outcome = null;
    d.confirm.addEventListener('click', async () => {
      d.setBusy(true, this.t('confirm.removing'));
      const result = await this.rag('admin/source-sync/runs/' + encodeURIComponent(run.id) + '/confirm', { method: 'POST', body: '{}' });
      d.setBusy(false);
      outcome = result;
      d.dialog.close('done');
    });
    d.dialog.addEventListener('close', async () => {
      d.dialog.remove();
      if (!outcome) {
        opener.focus();
        return;
      }
      await this.afterConfirm(view, opener, outcome);
    });
    d.dialog.showModal();
    d.cancel.focus();
  }

  async afterConfirm(view, opener, result) {
    const run = view.pausedRun;
    if (result.ok) {
      const body = result.body || {};
      const removed = sourceSyncNumber(body.removed, this.locale);
      const failed = Number(body.failed) || 0;
      this.runErrors.delete(run.id);
      let message;
      if (failed > 0) {
        message = this.t('remove.partial', { connection: view.connection, removed, failed: sourceSyncNumber(failed, this.locale) });
        this.partialMessage = message;
      } else {
        message = this.t('remove.done', { connection: view.connection, removed });
      }
      await this.loadList({ keepPartial: true, quiet: true, focusConnection: view.id });
      this.announce(message);
      return;
    }
    const mapped = mapSourceSyncError(result, this.locale, 'confirm', this.appUrl);
    if (mapped.expired) {
      this.expiredRuns.add(run.id);
      this.render();
      this.focusDismiss(run.id);
      return;
    }
    if (mapped.reload) {
      await this.loadList({ quiet: true, focusConnection: view.id });
      this.announce(mapped.message);
      return;
    }
    this.runErrors.set(run.id, mapped.message);
    this.render();
    this.focusRunButton(view.connection, this.t('action.remove'), run.id);
  }

  focusRunButton(connection, label, runId) {
    const group = this.root
      .querySelectorAll('[role="group"]')
      .find(
        (g) =>
          g.getAttribute('aria-label') === this.t('paused.groupLabel', { connection }) &&
          (!runId || g.getAttribute('data-source-sync-run') === runId),
      );
    if (!group) return;
    const button = group.querySelectorAll('button').find((b) => b.textContent === label);
    if (button) button.focus();
  }

  focusDismiss(runId) {
    const row = this.rows.find(
      (r) => (r.paused_run && r.paused_run.id === runId) || (Array.isArray(r.paused_runs) && r.paused_runs.some((p) => p && p.id === runId)),
    );
    if (row) this.focusRunButton(buildSourceSyncRowView(row, this.locale, this.limits).connection, this.t('action.dismiss'), runId);
  }

  async dismissRun(view, button, sibling) {
    const run = view.pausedRun;
    if (sibling) sibling.disabled = true;
    sourceSyncButtonBusy(button, true, this.t('dismiss.running'));
    const result = await this.rag('admin/source-sync/runs/' + encodeURIComponent(run.id) + '/dismiss', { method: 'POST', body: '{}' });
    if (result.ok) {
      this.runErrors.delete(run.id);
      await this.loadList({ quiet: true, focusConnection: view.id });
      this.announce(this.t('dismiss.done'));
      return;
    }
    const mapped = mapSourceSyncError(result, this.locale, 'dismiss', this.appUrl);
    if (mapped.reload) {
      await this.loadList({ quiet: true, focusConnection: view.id });
      this.announce(mapped.message);
      return;
    }
    this.runErrors.set(run.id, mapped.message + (mapped.code ? ' ' + mapped.code : ''));
    this.render();
    this.focusRunButton(view.connection, this.t('action.dismiss'), run.id);
  }
}

let sourceSyncPanelInstance = null;

function initSourceSyncPanel() {
  const root = document.getElementById('rag-administration-source-sync');
  if (!root) return;
  if (!sourceSyncPanelInstance) {
    sourceSyncPanelInstance = new SourceSyncPanel(root);
    window.sourceSyncPanel = sourceSyncPanelInstance;
    sourceSyncPanelInstance.mount();
  } else {
    sourceSyncPanelInstance.refresh();
  }
}

function bindSourceSyncPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-source-sync-bound')) return;
    link.setAttribute('data-source-sync-bound', '1');
    link.addEventListener('click', () => initSourceSyncPanel());
  });
}

if (typeof window !== 'undefined') {
  window.initSourceSyncPanel = initSourceSyncPanel;
  window.sourceSyncLabel = sourceSyncLabel;
  bindSourceSyncPanel();
  document.addEventListener('DOMContentLoaded', () => {
    bindSourceSyncPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initSourceSyncPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SOURCE_SYNC_LABELS,
    sourceSyncLabel,
    sourceSyncSortRows,
    buildSourceSyncRowView,
    buildPausedRunView,
    mapSourceSyncError,
    initSourceSyncPanel,
    SourceSyncPanel,
  };
}
