/**
 * Versions and dates panel (UI-SPEC 6.8; DATA-19, DATA-20, D-41 to D-44, D-50). Follows #workspace-selector. Possible older
 * versions are decided here (confirm, dismiss, undo) and effective dates are applied, dismissed or edited. Every server value is
 * set with textContent through ragUiEl; no document text other than the evidence quote of a date is shown, and that quote only
 * in the inert evidence block. No score, raw signal object, run id or tenant key is rendered.
 */

const VERSIONS_DATES_LABELS = {
  en: {
    'panel.title': 'Versions and dates',
    'panel.description': 'Decide when an older document stops being used, and from when a document applies. Nothing is replaced and no date hides a document without your decision. Follows the workspace chosen under Document Processing.',
    'tab.candidates': 'Possible older versions: {count}',
    'tab.dates': 'Effective dates: {count}',
    'candidate.title': '{older} may be an older version of {newer}',
    'candidate.titleUnknown': '{a} and {b} may be two versions of one document',
    'status.bothCurrent': 'Both in use',
    'hold.candidate': 'Both documents answer questions until you decide.',
    'origin.detected': 'Detected',
    'origin.uploader': 'Named by the uploader',
    'origin.answer_conflict': 'Conflicting answers',
    'signal.title_match': 'The titles are the same apart from a year or version mark.',
    'signal.content_overlap': 'Most of the content is the same, with different numbers.',
    'signal.uploader': 'The uploader said this upload replaces the other document.',
    'signal.answer_conflict': 'An answer found different values in the two documents.',
    'signal.other': 'Flagged for the reason {code}.',
    'col.older': 'Older',
    'col.newer': 'Newer',
    'col.docA': 'Document A',
    'col.docB': 'Document B',
    'row.file': 'File',
    'row.docType': 'Document type',
    'row.docDate': 'Document date',
    'row.effective': 'Effective',
    'row.uploaded': 'Uploaded',
    'candidate.whichOlder': 'Which document is the older one?',
    'candidate.pickFirst': 'Choose the older document first.',
    'action.swap': 'Swap older and newer',
    'action.confirmReplacement': 'Confirm replacement',
    'action.keepBoth': 'Keep both documents',
    'action.dismissCandidate': 'Dismiss candidate',
    'replace.title': 'Replace {older} with {newer}?',
    'replace.body': '{older} stops being used for answers at once. Citations in earlier chats still open it. Undo replacement brings it back.',
    'replace.done': '{newer} now replaces {older}.',
    'candidate.dismissed': 'Candidate dismissed. Both documents stay in use.',
    'confirmed.summary': 'Confirmed replacements: {count}',
    'confirmed.col.when': 'Confirmed',
    'action.undo': 'Undo replacement',
    'action.keepReplacement': 'Keep replacement',
    'undo.title': 'Undo the replacement of {older}?',
    'undo.body': '{older} is used for answers again, next to {newer}.',
    'undo.done': 'Replacement undone. Both documents are in use.',
    'candidates.detectOff': 'Automatic detection is off. Only replacements named at upload appear here.',
    'candidates.empty.title': 'No possible older versions',
    'candidates.empty.body': 'When an upload looks like a newer version of a document that is still in use, both appear here for you to decide.',
    'status.datesToConfirm': 'Dates to confirm',
    'dates.origin.extracted': 'Read from the document',
    'dates.origin.admin': 'Set by an admin',
    'dates.col.from': 'From',
    'dates.col.to': 'To',
    'dates.col.confidence': 'Confidence',
    'dates.col.effect': 'Effect today',
    'dates.filter.awaiting': 'Awaiting confirmation',
    'dates.filter.all': 'All with dates',
    'dates.quote': 'Text the dates were read from',
    'effect.future': 'Not used until {date}',
    'effect.expired': 'Ended on {date}; kept as history, not used for answers',
    'effect.inForce': 'In force today',
    'effect.open': 'No dates; always used',
    'dates.utc': 'Dates are compared with today\'s date in UTC.',
    'action.applyDates': 'Apply dates',
    'action.editDates': 'Edit dates',
    'action.saveDates': 'Save dates',
    'action.dismissDates': 'Dismiss dates',
    'action.keepWithoutDates': 'Keep document in use',
    'applyDates.title': 'Apply these dates to {file}?',
    'applyDates.bodyFuture': 'The document will not be used for answers until {date}.',
    'applyDates.bodyExpired': 'The document ended on {date}. It will no longer be used for answers.',
    'dates.applied': 'Dates saved: {file}.',
    'dates.dismissed': 'Dates dismissed: {file}. The document stays in use.',
    'dates.order': '"From" must not be later than "To".',
    'dates.off': 'Effective dates are stored and can be edited, but they do not limit answers while RAG_EFFECTIVE_DATES is off.',
    'dates.empty.title': 'No dates to confirm',
    'dates.empty.body': 'Extracted dates that would take a document out of today\'s answers wait here for your decision.',
    'dates.search': 'Search by file name',
    'dates.noMatch': 'No document matches this search.',
    'versions.loading': 'Loading versions and dates…',
    'versions.unavailable': 'Versions and dates are unavailable right now. Select Reload panel in a moment.',
    'action.refreshCandidates': 'Refresh versions',
    'action.refreshDates': 'Refresh dates',
    'RAG_SUPERSESSION_DETECT.label': 'Detect possible older versions',
    'RAG_SUPERSESSION_DETECT.help': 'Compares each new document with documents of the same type and lists likely pairs for an admin. Nothing is replaced without confirmation.',
    'RAG_EFFECTIVE_DATES.label': 'Use effective dates in answers',
    'RAG_EFFECTIVE_DATES.help': 'A document that has not started yet, or has ended, is not used for answers.',
    'RAG_EFFECTIVE_DATE_LLM_EXTRACT.label': 'Read dates with a model',
    'RAG_EFFECTIVE_DATE_LLM_EXTRACT.help': 'Adds a small-model call when the rules find no date. A date is kept only when its quote is found word for word in the document.',
    'panel.workspaceDefault': 'Default workspace',
    'tabs.label': 'Versions and dates views',
    'tab.settings': 'Settings',
    'onOff.opt.off': 'Off',
    'onOff.opt.on': 'On',
    'warn.needsUnified': 'This setting works in the unified ingest pipeline only. The ingest pipeline is set to legacy under RAG Modes.',
    'warn.datesNeedV2': 'This filter applies in the v2 retrieval pipeline only. The pipeline is set to legacy under RAG Modes.',
    'candidates.loaded': 'Possible older versions: {count}',
    'dates.loaded': 'Dates to confirm: {count}',
    'dates.loading': 'Loading dates…',
    'candidate.stale': 'One of these documents changed after this was found. Check both before you decide.',
    'doc.unavailable': 'This document is no longer available.',
    'doc.uploadedBy': 'by {name}',
    'effective.from': 'from {date}',
    'effective.to': 'until {date}',
    'effective.none': 'No dates',
    'date.noStart': 'No start date',
    'date.noEnd': 'No end date',
    'date.none': 'No date',
    'compare.caption': 'Comparison of the two documents',
    'action.confirmReplacementAria': 'Confirm replacement: {file}',
    'action.dismissCandidateAria': 'Dismiss candidate: {file}',
    'action.undoAria': 'Undo replacement: {file}',
    'action.applyDatesAria': 'Apply dates: {file}',
    'action.editDatesAria': 'Edit dates: {file}',
    'action.dismissDatesAria': 'Dismiss dates: {file}',
    'action.confirming': 'Confirming…',
    'action.dismissing': 'Dismissing…',
    'action.undoing': 'Undoing…',
    'action.applying': 'Applying…',
    'action.savingDates': 'Saving…',
    'action.loadMoreVersions': 'Load more versions',
    'action.loadMoreDates': 'Load more dates',
    'confirmed.caption': 'Confirmed replacements',
    'confirmed.col.actions': 'Actions',
    'confirmed.empty': 'No replacement has been confirmed yet.',
    'confirmed.by': 'by {name}',
    'dates.caption': 'Effective dates of documents',
    'dates.filterLabel': 'Show',
    'dates.col.actions': 'Actions',
    'dates.searchHint': 'Search by file name to find any document and set its dates.',
    'dates.lowConfidence': 'Read from the document, not applied',
    'dates.editLegend': 'Edit dates: {file}',
    'dates.clearHint': 'Either date may stay empty. Leave both empty to remove the dates.',
  },
  zh: {
    'panel.title': '版本与日期',
    'panel.description': '决定旧文档何时停止使用，以及文档从何时起生效。未经你确认，不会替换任何文档，也不会有日期让文档退出回答。跟随“文档处理”中选择的工作区。',
    'tab.candidates': '可能的旧版本：{count}',
    'tab.dates': '生效日期：{count}',
    'candidate.title': '{older} 可能是 {newer} 的旧版本',
    'candidate.titleUnknown': '{a} 和 {b} 可能是同一文档的两个版本',
    'status.bothCurrent': '两份都在使用',
    'hold.candidate': '在你决定之前，两份文档都会用于回答。',
    'origin.detected': '自动发现',
    'origin.uploader': '上传者指定',
    'origin.answer_conflict': '回答冲突',
    'signal.title_match': '除年份或版本标记外，标题相同。',
    'signal.content_overlap': '大部分内容相同，但数字不同。',
    'signal.uploader': '上传者表示此上传替换另一份文档。',
    'signal.answer_conflict': '回答时在两份文档中发现了不同的数值。',
    'signal.other': '因 {code} 被标记。',
    'col.older': '旧版本',
    'col.newer': '新版本',
    'col.docA': '文档 A',
    'col.docB': '文档 B',
    'row.file': '文件',
    'row.docType': '文档类型',
    'row.docDate': '文档日期',
    'row.effective': '生效期',
    'row.uploaded': '上传',
    'candidate.whichOlder': '哪一份是旧版本？',
    'candidate.pickFirst': '请先选择旧版本。',
    'action.swap': '交换新旧',
    'action.confirmReplacement': '确认替换',
    'action.keepBoth': '两份都保留',
    'action.dismissCandidate': '忽略此项',
    'replace.title': '要用 {newer} 替换 {older} 吗？',
    'replace.body': '{older} 会立即停止用于回答。以往对话中的引用仍可打开它。“撤销替换”可以恢复。',
    'replace.done': '{newer} 已替换 {older}。',
    'candidate.dismissed': '已忽略。两份文档继续使用。',
    'confirmed.summary': '已确认的替换：{count}',
    'confirmed.col.when': '确认时间',
    'action.undo': '撤销替换',
    'action.keepReplacement': '保持替换',
    'undo.title': '要撤销对 {older} 的替换吗？',
    'undo.body': '{older} 会重新用于回答，与 {newer} 并存。',
    'undo.done': '替换已撤销。两份文档都在使用。',
    'candidates.detectOff': '自动发现已关闭。这里只显示上传时指定的替换。',
    'candidates.empty.title': '没有可能的旧版本',
    'candidates.empty.body': '当某个上传看起来是使用中文档的新版本时，两份文档会显示在这里供你决定。',
    'status.datesToConfirm': '日期待确认',
    'dates.origin.extracted': '从文档中读取',
    'dates.origin.admin': '由管理员设置',
    'dates.col.from': '生效自',
    'dates.col.to': '生效至',
    'dates.col.confidence': '置信度',
    'dates.col.effect': '今天的效果',
    'dates.filter.awaiting': '待确认',
    'dates.filter.all': '所有带日期的文档',
    'dates.quote': '读取日期所依据的文字',
    'effect.future': '{date} 之前不使用',
    'effect.expired': '已于 {date} 失效；仅作为历史保留，不用于回答',
    'effect.inForce': '今天有效',
    'effect.open': '无日期；始终使用',
    'dates.utc': '日期按 UTC 的当天日期比较。',
    'action.applyDates': '应用日期',
    'action.editDates': '编辑日期',
    'action.saveDates': '保存日期',
    'action.dismissDates': '忽略日期',
    'action.keepWithoutDates': '继续使用文档',
    'applyDates.title': '要把这些日期应用到 {file} 吗？',
    'applyDates.bodyFuture': '{date} 之前，该文档不会用于回答。',
    'applyDates.bodyExpired': '该文档已于 {date} 失效，将不再用于回答。',
    'dates.applied': '日期已保存：{file}。',
    'dates.dismissed': '已忽略日期：{file}。文档继续使用。',
    'dates.order': '“生效自”不能晚于“生效至”。',
    'dates.off': '生效日期会被保存并可编辑，但在 RAG_EFFECTIVE_DATES 关闭时不会限制回答。',
    'dates.empty.title': '没有待确认的日期',
    'dates.empty.body': '会让文档退出今天回答的提取日期会在这里等待你的决定。',
    'dates.search': '按文件名搜索',
    'dates.noMatch': '没有与此搜索匹配的文档。',
    'versions.loading': '正在加载版本与日期…',
    'versions.unavailable': '暂时无法获取版本与日期。请稍后选择“重新加载面板”。',
    'action.refreshCandidates': '刷新版本列表',
    'action.refreshDates': '刷新日期列表',
    'RAG_SUPERSESSION_DETECT.label': '发现可能的旧版本',
    'RAG_SUPERSESSION_DETECT.help': '把每份新文档与同类型文档比较，并把可能的新旧配对列给管理员。未经确认不会替换任何文档。',
    'RAG_EFFECTIVE_DATES.label': '回答时使用生效日期',
    'RAG_EFFECTIVE_DATES.help': '尚未生效或已经失效的文档不用于回答。',
    'RAG_EFFECTIVE_DATE_LLM_EXTRACT.label': '用模型读取日期',
    'RAG_EFFECTIVE_DATE_LLM_EXTRACT.help': '规则找不到日期时，增加一次小模型调用。只有引文能在文档中逐字找到时，日期才会保留。',
    'panel.workspaceDefault': '默认工作区',
    'tabs.label': '版本与日期视图',
    'tab.settings': '设置',
    'onOff.opt.off': '关闭',
    'onOff.opt.on': '开启',
    'warn.needsUnified': '此设置仅在统一入库流程中生效。“RAG 模式”中的入库流程目前为 legacy。',
    'warn.datesNeedV2': '此过滤仅在 v2 检索流程中生效。“RAG 模式”中的流程目前为 legacy。',
    'candidates.loaded': '可能的旧版本：{count}',
    'dates.loaded': '日期待确认：{count}',
    'dates.loading': '正在加载日期…',
    'candidate.stale': '发现此项后，其中一份文档已有变化。请先核对两份文档再决定。',
    'doc.unavailable': '此文档已不可用。',
    'doc.uploadedBy': '上传者 {name}',
    'effective.from': '自 {date}',
    'effective.to': '至 {date}',
    'effective.none': '无日期',
    'date.noStart': '无开始日期',
    'date.noEnd': '无结束日期',
    'date.none': '无日期',
    'compare.caption': '两份文档的比较',
    'action.confirmReplacementAria': '确认替换：{file}',
    'action.dismissCandidateAria': '忽略此项：{file}',
    'action.undoAria': '撤销替换：{file}',
    'action.applyDatesAria': '应用日期：{file}',
    'action.editDatesAria': '编辑日期：{file}',
    'action.dismissDatesAria': '忽略日期：{file}',
    'action.confirming': '正在确认…',
    'action.dismissing': '正在忽略…',
    'action.undoing': '正在撤销…',
    'action.applying': '正在应用…',
    'action.savingDates': '正在保存…',
    'action.loadMoreVersions': '加载更多版本',
    'action.loadMoreDates': '加载更多日期',
    'confirmed.caption': '已确认的替换',
    'confirmed.col.actions': '操作',
    'confirmed.empty': '还没有已确认的替换。',
    'confirmed.by': '确认人 {name}',
    'dates.caption': '文档的生效日期',
    'dates.filterLabel': '显示',
    'dates.col.actions': '操作',
    'dates.searchHint': '按文件名搜索，可以找到任意文档并设置其日期。',
    'dates.lowConfidence': '从文档中读取，未应用',
    'dates.editLegend': '编辑日期：{file}',
    'dates.clearHint': '任一日期都可以留空。两项都留空即删除日期。',
  },
  it: {
    'panel.title': 'Versioni e date',
    'panel.description': 'Decidi quando un documento più vecchio smette di essere usato e da quando un documento si applica. Nulla viene sostituito e nessuna data nasconde un documento senza la tua decisione. Segue lo spazio di lavoro scelto in Document Processing.',
    'tab.candidates': 'Possibili versioni precedenti: {count}',
    'tab.dates': 'Date di validità: {count}',
    'candidate.title': '{older} potrebbe essere una versione precedente di {newer}',
    'candidate.titleUnknown': '{a} e {b} potrebbero essere due versioni dello stesso documento',
    'status.bothCurrent': 'Entrambi in uso',
    'hold.candidate': 'Entrambi i documenti rispondono alle domande finché non decidi.',
    'origin.detected': 'Rilevato',
    'origin.uploader': 'Indicato da chi ha caricato',
    'origin.answer_conflict': 'Risposte in conflitto',
    'signal.title_match': 'I titoli sono uguali a parte un anno o un\'indicazione di versione.',
    'signal.content_overlap': 'Gran parte del contenuto è uguale, con numeri diversi.',
    'signal.uploader': 'Chi ha caricato ha indicato che questo caricamento sostituisce l\'altro documento.',
    'signal.answer_conflict': 'Una risposta ha trovato valori diversi nei due documenti.',
    'signal.other': 'Segnalato per il motivo {code}.',
    'col.older': 'Precedente',
    'col.newer': 'Più recente',
    'col.docA': 'Documento A',
    'col.docB': 'Documento B',
    'row.file': 'File',
    'row.docType': 'Tipo di documento',
    'row.docDate': 'Data del documento',
    'row.effective': 'Validità',
    'row.uploaded': 'Caricato',
    'candidate.whichOlder': 'Quale documento è il più vecchio?',
    'candidate.pickFirst': 'Scegli prima il documento più vecchio.',
    'action.swap': 'Scambia precedente e più recente',
    'action.confirmReplacement': 'Conferma sostituzione',
    'action.keepBoth': 'Mantieni entrambi i documenti',
    'action.dismissCandidate': 'Ignora la segnalazione',
    'replace.title': 'Sostituire {older} con {newer}?',
    'replace.body': '{older} smette subito di essere usato nelle risposte. Le citazioni nelle chat precedenti lo aprono ancora. Annulla sostituzione lo ripristina.',
    'replace.done': '{newer} ora sostituisce {older}.',
    'candidate.dismissed': 'Segnalazione ignorata. Entrambi i documenti restano in uso.',
    'confirmed.summary': 'Sostituzioni confermate: {count}',
    'confirmed.col.when': 'Confermata',
    'action.undo': 'Annulla sostituzione',
    'action.keepReplacement': 'Mantieni la sostituzione',
    'undo.title': 'Annullare la sostituzione di {older}?',
    'undo.body': '{older} torna a essere usato nelle risposte, accanto a {newer}.',
    'undo.done': 'Sostituzione annullata. Entrambi i documenti sono in uso.',
    'candidates.detectOff': 'Il rilevamento automatico è disattivato. Qui appaiono solo le sostituzioni indicate al caricamento.',
    'candidates.empty.title': 'Nessuna possibile versione precedente',
    'candidates.empty.body': 'Quando un caricamento sembra una versione più recente di un documento ancora in uso, entrambi appaiono qui per la tua decisione.',
    'status.datesToConfirm': 'Date da confermare',
    'dates.origin.extracted': 'Lette dal documento',
    'dates.origin.admin': 'Impostate da un amministratore',
    'dates.col.from': 'Dal',
    'dates.col.to': 'Al',
    'dates.col.confidence': 'Confidenza',
    'dates.col.effect': 'Effetto oggi',
    'dates.filter.awaiting': 'In attesa di conferma',
    'dates.filter.all': 'Tutti con date',
    'dates.quote': 'Testo da cui sono state lette le date',
    'effect.future': 'Non usato fino al {date}',
    'effect.expired': 'Terminato il {date}; conservato come storico, non usato nelle risposte',
    'effect.inForce': 'In vigore oggi',
    'effect.open': 'Nessuna data; sempre usato',
    'dates.utc': 'Le date sono confrontate con la data odierna in UTC.',
    'action.applyDates': 'Applica le date',
    'action.editDates': 'Modifica le date',
    'action.saveDates': 'Salva le date',
    'action.dismissDates': 'Ignora le date',
    'action.keepWithoutDates': 'Mantieni il documento in uso',
    'applyDates.title': 'Applicare queste date a {file}?',
    'applyDates.bodyFuture': 'Il documento non sarà usato nelle risposte fino al {date}.',
    'applyDates.bodyExpired': 'Il documento è terminato il {date}. Non sarà più usato nelle risposte.',
    'dates.applied': 'Date salvate: {file}.',
    'dates.dismissed': 'Date ignorate: {file}. Il documento resta in uso.',
    'dates.order': '«Dal» non può essere successivo ad «Al».',
    'dates.off': 'Le date di validità sono salvate e modificabili, ma non limitano le risposte finché RAG_EFFECTIVE_DATES è disattivato.',
    'dates.empty.title': 'Nessuna data da confermare',
    'dates.empty.body': 'Qui attendono la tua decisione le date estratte che escluderebbero un documento dalle risposte di oggi.',
    'dates.search': 'Cerca per nome del file',
    'dates.noMatch': 'Nessun documento corrisponde a questa ricerca.',
    'versions.loading': 'Caricamento di versioni e date…',
    'versions.unavailable': 'Versioni e date non sono disponibili. Seleziona Ricarica pannello tra poco.',
    'action.refreshCandidates': 'Aggiorna le versioni',
    'action.refreshDates': 'Aggiorna le date',
    'RAG_SUPERSESSION_DETECT.label': 'Rileva possibili versioni precedenti',
    'RAG_SUPERSESSION_DETECT.help': 'Confronta ogni nuovo documento con quelli dello stesso tipo ed elenca le coppie probabili per un amministratore. Nulla viene sostituito senza conferma.',
    'RAG_EFFECTIVE_DATES.label': 'Usa le date di validità nelle risposte',
    'RAG_EFFECTIVE_DATES.help': 'Un documento non ancora in vigore, o già terminato, non viene usato nelle risposte.',
    'RAG_EFFECTIVE_DATE_LLM_EXTRACT.label': 'Leggi le date con un modello',
    'RAG_EFFECTIVE_DATE_LLM_EXTRACT.help': 'Aggiunge una chiamata a un modello piccolo quando le regole non trovano una data. Una data resta solo se la citazione si trova parola per parola nel documento.',
    'panel.workspaceDefault': 'Spazio di lavoro predefinito',
    'tabs.label': 'Viste di versioni e date',
    'tab.settings': 'Impostazioni',
    'onOff.opt.off': 'Disattivato',
    'onOff.opt.on': 'Attivo',
    'warn.needsUnified': 'Questa impostazione funziona solo nella pipeline di ingestione unificata. In RAG Modes la pipeline è impostata su legacy.',
    'warn.datesNeedV2': 'Questo filtro si applica solo nella pipeline di recupero v2. In RAG Modes la pipeline è impostata su legacy.',
    'candidates.loaded': 'Possibili versioni precedenti: {count}',
    'dates.loaded': 'Date da confermare: {count}',
    'dates.loading': 'Caricamento delle date…',
    'candidate.stale': 'Uno dei due documenti è cambiato dopo la segnalazione. Controllali entrambi prima di decidere.',
    'doc.unavailable': 'Questo documento non è più disponibile.',
    'doc.uploadedBy': 'da {name}',
    'effective.from': 'dal {date}',
    'effective.to': 'fino al {date}',
    'effective.none': 'Nessuna data',
    'date.noStart': 'Nessuna data di inizio',
    'date.noEnd': 'Nessuna data di fine',
    'date.none': 'Nessuna data',
    'compare.caption': 'Confronto tra i due documenti',
    'action.confirmReplacementAria': 'Conferma sostituzione: {file}',
    'action.dismissCandidateAria': 'Ignora la segnalazione: {file}',
    'action.undoAria': 'Annulla sostituzione: {file}',
    'action.applyDatesAria': 'Applica le date: {file}',
    'action.editDatesAria': 'Modifica le date: {file}',
    'action.dismissDatesAria': 'Ignora le date: {file}',
    'action.confirming': 'Conferma in corso…',
    'action.dismissing': 'Operazione in corso…',
    'action.undoing': 'Annullamento in corso…',
    'action.applying': 'Applicazione in corso…',
    'action.savingDates': 'Salvataggio in corso…',
    'action.loadMoreVersions': 'Carica altre versioni',
    'action.loadMoreDates': 'Carica altre date',
    'confirmed.caption': 'Sostituzioni confermate',
    'confirmed.col.actions': 'Azioni',
    'confirmed.empty': 'Nessuna sostituzione è stata ancora confermata.',
    'confirmed.by': 'da {name}',
    'dates.caption': 'Date di validità dei documenti',
    'dates.filterLabel': 'Mostra',
    'dates.col.actions': 'Azioni',
    'dates.searchHint': 'Cerca per nome del file per trovare qualsiasi documento e impostarne le date.',
    'dates.lowConfidence': 'Lette dal documento, non applicate',
    'dates.editLegend': 'Modifica le date: {file}',
    'dates.clearHint': 'Una delle due date può restare vuota. Lasciale entrambe vuote per rimuovere le date.',
  },
};

const VERSIONS_DATES_SUPERSESSION_PATH = '/api/rag/admin/supersession';
const VERSIONS_DATES_DATES_PATH = '/api/rag/admin/effective-dates';
const VERSIONS_DATES_PAGE = 50;
const VERSIONS_DATES_SEARCH_DELAY_MS = 400;
const VERSIONS_DATES_SEARCH_MAX = 200;
const VERSIONS_DATES_ORIGINS = { detected: 'search', uploader: 'person', answer_conflict: 'chat-dots' };
const VERSIONS_DATES_ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const VERSIONS_DATES_SETTINGS = ['RAG_SUPERSESSION_DETECT', 'RAG_EFFECTIVE_DATES', 'RAG_PIPELINE', 'RAG_INGEST_PIPELINE'];

let versionsDatesUi = null;
if (typeof require !== 'undefined') {
  try {
    versionsDatesUi = require('./rag-ui.js');
  } catch {
    versionsDatesUi = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function versionsDatesUiLib() {
  if (versionsDatesUi) return versionsDatesUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

function versionsDatesLabel(key, locale, vars) {
  const ui = versionsDatesUiLib();
  const text = ui.ragUiLookup(VERSIONS_DATES_LABELS, key, locale, vars);
  return text === undefined ? ui.ragUiLabel(key, locale, vars) : text;
}

function versionsDatesText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/** An ISO calendar day (YYYY-MM-DD) or null. */
function versionsDatesDay(value) {
  const text = versionsDatesText(value).slice(0, 10);
  return VERSIONS_DATES_ISO_DAY.test(text) ? text : null;
}

/** Today's date in UTC as YYYY-MM-DD; retrieval compares effective windows with it (UI-SPEC 6.8, dates.utc). */
function versionsDatesTodayUtc(now) {
  const date = now instanceof Date ? now : new Date();
  return date.toISOString().slice(0, 10);
}

/**
 * The effect of a window today, bounds inclusive: a start after today hides the document until then, an end before today hides it
 * for good, a window around today keeps it in use, no dates at all mean always used.
 */
function versionsDatesEffect(from, to, today) {
  const start = versionsDatesDay(from);
  const end = versionsDatesDay(to);
  const day = versionsDatesDay(today) || versionsDatesTodayUtc();
  if (start && start > day) return { key: 'effect.future', date: start, hides: true };
  if (end && end < day) return { key: 'effect.expired', date: end, hides: true };
  if (!start && !end) return { key: 'effect.open', date: null, hides: false };
  return { key: 'effect.inForce', date: null, hides: false };
}

function versionsDatesDocTypeLabel(docType, locale) {
  if (!docType) return '';
  if (typeof window !== 'undefined' && typeof window.docTypeLabelForLocale === 'function') return window.docTypeLabelForLocale(docType, locale);
  return docType;
}

/** One document of a candidate or link: named fields only. */
function versionsDatesDocumentView(value, locale) {
  if (!value || typeof value !== 'object') return null;
  const id = versionsDatesText(value.id);
  if (!id) return null;
  const docType = versionsDatesText(value.doc_type);
  const uploader = value.uploader && typeof value.uploader === 'object' ? versionsDatesText(value.uploader.display) : '';
  return {
    id,
    file: versionsDatesText(value.file_name),
    docType,
    docTypeLabel: versionsDatesDocTypeLabel(docType, locale),
    docDate: versionsDatesDay(value.document_date),
    from: versionsDatesDay(value.effective_from),
    to: versionsDatesDay(value.effective_to),
    uploadedAt: versionsDatesText(value.uploaded_at),
    uploader,
  };
}

/**
 * The signal sentences of a candidate: the origin first (uploader, answer conflict), then the rules that matched. The overlap
 * percentage and the count of differing numbers decide whether the content sentence shows; neither is ever displayed.
 */
function versionsDatesSignals(origin, signals) {
  const out = [];
  if (origin === 'uploader') out.push({ key: 'signal.uploader' });
  else if (origin === 'answer_conflict') out.push({ key: 'signal.answer_conflict' });
  else if (origin !== 'detected') out.push({ key: 'signal.other', code: origin });
  const s = signals && typeof signals === 'object' ? signals : {};
  if (s.title_match === true) out.push({ key: 'signal.title_match' });
  if (Number(s.content_overlap_percent) > 0 && Number(s.conflicting_numbers) > 0) out.push({ key: 'signal.content_overlap' });
  return out;
}

/**
 * A pending candidate as the block shows it. direction document_newer: the published document is newer; candidate_newer: the
 * matched document is newer; null: the admin chooses (columns A and B).
 */
function versionsDatesCandidateView(item, locale) {
  const data = item && typeof item === 'object' ? item : {};
  const documentView = versionsDatesDocumentView(data.document, locale);
  const candidateView = versionsDatesDocumentView(data.candidate_document, locale);
  const origin = versionsDatesText(data.origin) || 'detected';
  const direction = data.direction === 'document_newer' || data.direction === 'candidate_newer' ? data.direction : null;
  let older = null;
  let newer = null;
  if (direction === 'document_newer') {
    older = candidateView;
    newer = documentView;
  } else if (direction === 'candidate_newer') {
    older = documentView;
    newer = candidateView;
  }
  const directed = direction !== null && Boolean(older) && Boolean(newer);
  const name = (view) => (view ? view.file : versionsDatesLabel('doc.unavailable', locale));
  const title = directed
    ? versionsDatesLabel('candidate.title', locale, { older: name(older), newer: name(newer) })
    : versionsDatesLabel('candidate.titleUnknown', locale, { a: name(documentView), b: name(candidateView) });
  return {
    id: versionsDatesText(data.id),
    origin: Object.prototype.hasOwnProperty.call(VERSIONS_DATES_ORIGINS, origin) ? origin : null,
    signals: versionsDatesSignals(origin, data.signals),
    stale: data.stale === true,
    directed,
    older: directed ? older : null,
    newer: directed ? newer : null,
    a: documentView,
    b: candidateView,
    title,
  };
}

/** A confirmed replacement (kind link). */
function versionsDatesLinkView(item, locale) {
  const data = item && typeof item === 'object' ? item : {};
  return {
    id: versionsDatesText(data.id),
    older: versionsDatesDocumentView(data.older_document, locale),
    newer: versionsDatesDocumentView(data.newer_document, locale),
    decidedAt: versionsDatesText(data.decided_at),
    decidedBy: data.decided_by && typeof data.decided_by === 'object' ? versionsDatesText(data.decided_by.display) : '',
  };
}

/** The GET supersession answer: candidates and confirmed links, named fields only. */
function versionsDatesSupersessionView(body, locale) {
  const data = body && typeof body === 'object' ? body : {};
  const candidates = [];
  const links = [];
  let rows = 0;
  for (const item of Array.isArray(data.items) ? data.items : []) {
    if (!item || typeof item !== 'object' || !versionsDatesText(item.id)) continue;
    rows += 1;
    if (item.kind === 'link') links.push(versionsDatesLinkView(item, locale));
    else if (item.kind === 'candidate') candidates.push(versionsDatesCandidateView(item, locale));
  }
  const total = Number(data.total);
  return { detect: data.detect === 'on' ? 'on' : 'off', total: Number.isFinite(total) ? Math.max(total, rows) : rows, rows, candidates, links };
}

/** One row of the Effective dates table: the proposed window while a proposal is stored, otherwise the stored window. */
function versionsDatesDateRowView(item, today) {
  const data = item && typeof item === 'object' ? item : {};
  const p = data.proposal && typeof data.proposal === 'object' ? data.proposal : null;
  const stored = { from: versionsDatesDay(data.effective_from), to: versionsDatesDay(data.effective_to) };
  const proposal = p
    ? {
        from: versionsDatesDay(p.from),
        to: versionsDatesDay(p.to),
        awaiting: p.awaiting === true,
      }
    : null;
  const range = proposal ? { from: proposal.from, to: proposal.to } : stored;
  const rawConfidence = proposal ? Number(p.confidence) : data.origin === 'extracted' ? Number(data.confidence) : NaN;
  const confidence = Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : null;
  const quote = proposal && typeof p.evidence_quote === 'string' && p.evidence_quote !== '' ? p.evidence_quote : null;
  const origin = data.origin === 'admin' || data.origin === 'extracted' ? data.origin : null;
  return {
    id: versionsDatesText(data.id),
    file: versionsDatesText(data.file_name),
    origin,
    stored,
    proposal,
    awaiting: Boolean(proposal && proposal.awaiting),
    window: range,
    confidence,
    quote,
    effect: versionsDatesEffect(range.from, range.to, today),
  };
}

/** The GET effective-dates answer. */
function versionsDatesDatesView(body, today) {
  const data = body && typeof body === 'object' ? body : {};
  const rows = [];
  for (const item of Array.isArray(data.items) ? data.items : []) {
    if (!item || typeof item !== 'object' || !versionsDatesText(item.id)) continue;
    rows.push(versionsDatesDateRowView(item, today));
  }
  const total = Number(data.total);
  return { total: Number.isFinite(total) ? Math.max(total, rows.length) : rows.length, rows };
}

/** Combination warnings of the versions group, read from the page's own inputs (UI-SPEC 6.3). */
function versionsDatesSettingsWarnings(values) {
  const v = values || {};
  const out = [];
  if (versionsDatesText(v.RAG_SUPERSESSION_DETECT).trim() === 'on' && versionsDatesText(v.RAG_INGEST_PIPELINE).trim() !== 'unified') out.push('warn.needsUnified');
  if (versionsDatesText(v.RAG_EFFECTIVE_DATES).trim() === 'true' && versionsDatesText(v.RAG_PIPELINE).trim() !== 'v2') out.push('warn.datesNeedV2');
  return out;
}

/** Badge with base-content text and a coloured border and icon (contrast call of plans 56 to 60). */
function versionsDatesBadge(doc, tone, icon, word) {
  const ui = versionsDatesUiLib();
  const classes =
    tone === 'ghost'
      ? 'badge badge-sm badge-ghost gap-1 shrink-0 whitespace-nowrap'
      : 'badge badge-sm badge-outline border-' + tone + ' text-base-content gap-1 shrink-0 whitespace-nowrap';
  return ui.ragUiEl(doc, 'span', { className: classes }, [
    icon ? ui.ragUiIcon(doc, icon, tone === 'ghost' ? null : 'text-' + tone) : null,
    ui.ragUiEl(doc, 'span', { text: word }),
  ]);
}

function versionsDatesStop(event) {
  if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
}

class VersionsDatesPanel {
  constructor(root) {
    this.root = root;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.locale = versionsDatesUiLib().ragUiBrowserLocale();
    this.organizationId = null;
    this.tabs = null;
    this.supHost = null;
    this.datesHost = null;
    this.sup = null;
    this.supSeq = 0;
    this.supAlert = null;
    this.supUpdatedAt = null;
    this.supRefresh = null;
    this.picks = {};
    this.dates = null;
    this.datesSeq = 0;
    this.datesAlert = null;
    this.datesUpdatedAt = null;
    this.datesRefresh = null;
    this.datesFilter = 'awaiting';
    this.datesQuery = '';
    this.awaitingCount = null;
    this.datesToolbar = null;
    this.datesList = null;
    this.searchTimer = null;
    this.editor = null;
  }

  t(key, vars) {
    return versionsDatesLabel(key, this.locale, vars);
  }

  ui() {
    return versionsDatesUiLib();
  }

  el(tag, options, children) {
    return this.ui().ragUiEl(this.doc, tag, options, children);
  }

  statusEl() {
    return this.root.querySelector('[data-versions-dates-status]');
  }

  announce(text, isError) {
    const host = this.statusEl();
    if (!host) return;
    host.classList.toggle('text-error', Boolean(isError));
    if (isError) host.replaceChildren(this.ui().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text }));
    else host.textContent = text;
  }

  focus(target) {
    if (target && typeof target.focus === 'function') target.focus();
  }

  query(extra) {
    const params = new URLSearchParams();
    if (this.organizationId) params.set('organizationId', this.organizationId);
    for (const [key, value] of Object.entries(extra || {})) {
      if (value === null || value === undefined || value === '') continue;
      params.set(key, String(value));
    }
    const text = params.toString();
    return text ? '?' + text : '';
  }

  today() {
    return versionsDatesTodayUtc(new Date());
  }

  async mount() {
    const ui = this.ui();
    this.root.setAttribute('lang', this.locale);
    const title = this.root.querySelector('[data-versions-dates-title]');
    if (title) title.textContent = this.t('panel.title');
    const description = this.root.querySelector('[data-versions-dates-description]');
    if (description) description.textContent = this.t('panel.description');
    this.tabs = ui.ragUiSubTabs(this.doc, {
      label: this.t('tabs.label'),
      idPrefix: 'rag-versions-dates',
      tabs: [
        { id: 'candidates', label: this.t('tab.candidates', { count: '…' }) },
        { id: 'dates', label: this.t('tab.dates', { count: '…' }) },
        { id: 'settings', label: this.t('tab.settings') },
      ],
      selected: 'candidates',
    });
    this.supHost = this.el('div', { className: 'min-w-0' });
    this.datesHost = this.el('div', { className: 'min-w-0' });
    this.tabs.panels.candidates.appendChild(this.supHost);
    this.tabs.panels.dates.appendChild(this.datesHost);
    const group = this.doc.querySelector('[data-rag-settings-group="versions"]');
    if (group) {
      this.tabs.panels.settings.appendChild(group);
      this.localizeSettings(group);
    }
    const content = this.root.querySelector('[data-versions-dates-content]');
    if (content) content.replaceChildren(this.tabs.tablist, this.tabs.panels.candidates, this.tabs.panels.dates, this.tabs.panels.settings);
    for (const id of VERSIONS_DATES_SETTINGS) {
      const control = this.doc.getElementById(id);
      if (control) {
        control.addEventListener('change', () => {
          this.renderAlerts();
          if (id === 'RAG_EFFECTIVE_DATES' && this.dates) this.renderDates();
        });
      }
    }
    this.bindWorkspace();
    this.renderAlerts();
    await Promise.all([this.loadCandidates('first'), this.loadDates('first')]);
  }

  async refresh() {
    this.readWorkspace();
    this.renderAlerts();
    await Promise.all([this.loadCandidates('refresh'), this.loadDates('refresh')]);
  }

  /** zh and it through data-rag-i18n; English is the static markup (UI-SPEC 6.3). */
  localizeSettings(group) {
    if (this.locale === 'en') return;
    const table = VERSIONS_DATES_LABELS[this.locale] || {};
    for (const node of Array.from(group.querySelectorAll('[data-rag-i18n]'))) {
      const text = table[node.getAttribute('data-rag-i18n')];
      if (text !== undefined) node.textContent = text;
    }
  }

  selector() {
    return this.doc.getElementById('workspace-selector');
  }

  readWorkspace() {
    const selector = this.selector();
    this.organizationId = selector && selector.value ? String(selector.value) : null;
    const line = this.root.querySelector('[data-versions-dates-workspace]');
    if (line) line.textContent = this.ui().ragUiLabel('panel.workspace', this.locale, { name: this.workspaceName() });
  }

  workspaceName() {
    const selector = this.selector();
    if (!selector || !selector.value) return this.t('panel.workspaceDefault');
    const option = Array.from(selector.querySelectorAll('option')).find((o) => o.getAttribute('value') === selector.value);
    const name = option ? option.textContent.trim() : '';
    return name || this.t('panel.workspaceDefault');
  }

  bindWorkspace() {
    const selector = this.selector();
    this.readWorkspace();
    if (!selector) return;
    selector.addEventListener('change', async () => {
      this.readWorkspace();
      this.sup = null;
      this.dates = null;
      this.picks = {};
      this.editor = null;
      this.awaitingCount = null;
      this.datesQuery = '';
      this.datesToolbar = null;
      await Promise.all([this.loadCandidates('first'), this.loadDates('first')]);
    });
  }

  controlValue(id) {
    const control = this.doc.getElementById(id);
    return control ? versionsDatesText(control.value) : '';
  }

  renderAlerts() {
    const host = this.root.querySelector('[data-versions-dates-alert]');
    if (!host) return;
    const values = {};
    for (const id of VERSIONS_DATES_SETTINGS) values[id] = this.controlValue(id);
    const nodes = versionsDatesSettingsWarnings(values).map((key) => this.ui().ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', body: [this.t(key)] }));
    if (this.supAlert) nodes.push(this.supAlert);
    if (this.datesAlert && this.datesAlert !== this.supAlert) nodes.push(this.datesAlert);
    host.replaceChildren(...nodes);
  }

  setTabCount(id, key, count) {
    const tab = this.doc.getElementById('rag-versions-dates-tab-' + id);
    if (tab) tab.textContent = this.t(key, { count: this.ui().ragUiFormatNumber(count, this.locale) });
  }

  formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return versionsDatesText(value);
    try {
      return new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  /** A timestamp in a time element. */
  timeNode(value) {
    if (!value) return this.missing('date.none');
    return this.el('time', { className: 'tabular-nums', text: this.formatTime(value), attrs: { datetime: value } });
  }

  /** A calendar day the admin can edit: shown as YYYY-MM-DD (UI-SPEC 12) in a time element. */
  dayNode(day, missingKey) {
    if (!day) return this.missing(missingKey || 'date.none');
    return this.el('time', { className: 'tabular-nums whitespace-nowrap', text: day, attrs: { datetime: day } });
  }

  /** An em dash with a visually hidden word for a missing value. */
  missing(key) {
    return this.el('span', {}, [this.el('span', { text: '—', attrs: { 'aria-hidden': 'true' } }), this.el('span', { className: 'sr-only', text: this.t(key) })]);
  }

  updatedLine(at) {
    return this.el('p', { className: 'text-xs text-base-content/70', text: at ? this.ui().ragUiLabel('panel.updated', this.locale, { time: this.formatTime(at) }) : '' });
  }

  emptyBlock(title, body) {
    return this.el('div', { className: 'py-8 text-center' }, [
      this.el('p', { className: 'text-base font-semibold text-balance', text: title }),
      this.el('p', { className: 'text-sm text-base-content/70 mt-2 max-w-prose mx-auto', text: body }),
    ]);
  }

  tableRegion(label, table) {
    return this.el(
      'div',
      {
        className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': label },
      },
      [table],
    );
  }

  th(text, extra) {
    return this.el('th', { className: 'font-semibold' + (extra ? ' ' + extra : ''), text, attrs: { scope: 'col' } });
  }

  actionButton(label, aria, tone) {
    return this.el('button', {
      className: 'btn ' + (tone === 'primary' ? 'btn-primary' : 'btn-outline') + ' md:btn-sm whitespace-nowrap',
      text: label,
      attrs: { type: 'button', 'aria-label': aria || null },
    });
  }

  /** A failed load: sign-in or workspace alerts replace the view; anything else becomes the unavailable alert in the alert host. */
  loadFailure(result, host, hadContent) {
    const ui = this.ui();
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('versions.unavailable') });
    if (mapped.kind === 'signIn') {
      host.replaceChildren(ui.ragUiSignInAlert(this.doc, this.locale, () => this.refresh()));
      return { mapped, replaced: true };
    }
    if (mapped.kind === 'workspace') {
      host.replaceChildren(
        ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [mapped.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, () => this.refresh())] }),
      );
      return { mapped, replaced: true };
    }
    if (hadContent) ui.ragUiListBusy(host, true, true);
    else host.replaceChildren();
    return { mapped, replaced: false, alert: ui.ragUiUnavailableAlert(this.doc, this.locale, mapped.message, () => this.refresh()) };
  }

  /**
   * A failed action: 404 and 409 mean someone else changed the item (error.changed, reload); no answer on confirm or undo means the
   * outcome is unknown (reload). Returns the mapped error.
   */
  async actionFailed(result, action, reload) {
    const ui = this.ui();
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('versions.unavailable'), action });
    const conflict = result && !result.thrown && result.status === 409;
    const message = conflict ? ui.ragUiLabel('error.changed', this.locale) : mapped.message;
    this.announce(message, true);
    if (conflict || mapped.reload) await reload();
    return mapped;
  }

  // ---- Possible older versions

  async loadCandidates(source, offset) {
    if (!this.supHost) return;
    const ui = this.ui();
    const seq = ++this.supSeq;
    const more = Number(offset) > 0;
    const hadContent = Boolean(this.sup);
    if (hadContent) ui.ragUiListBusy(this.supHost, true);
    else if (source !== 'action') ui.ragUiListLoading(this.doc, this.supHost, this.t('versions.loading'));
    let restore = null;
    if (source === 'refresh' && this.supRefresh && this.supRefresh.isConnected !== false) restore = ui.ragUiButtonBusy(this.doc, this.supRefresh, this.t('versions.loading'));
    let result;
    try {
      result = await ui.ragUiRagRequest(VERSIONS_DATES_SUPERSESSION_PATH + this.query({ limit: VERSIONS_DATES_PAGE, offset: more ? offset : null }), { method: 'GET' });
    } finally {
      if (restore) restore();
    }
    if (seq !== this.supSeq) return;
    ui.ragUiListBusy(this.supHost, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      const view = versionsDatesSupersessionView(result.body, this.locale);
      if (more && this.sup) {
        view.candidates = this.sup.candidates.concat(view.candidates);
        view.links = this.sup.links.concat(view.links);
        view.rows = this.sup.rows + view.rows;
      }
      this.sup = view;
      this.supUpdatedAt = new Date();
      this.supAlert = null;
      this.renderAlerts();
      this.renderCandidates();
      if (source === 'first' || source === 'refresh') this.announce(this.t('candidates.loaded', { count: ui.ragUiFormatNumber(view.candidates.length, this.locale) }));
      return;
    }
    const failure = this.loadFailure(result, this.supHost, hadContent);
    if (failure.replaced) this.sup = null;
    this.supAlert = failure.alert || null;
    this.renderAlerts();
    this.announce(failure.mapped.message, true);
  }

  renderCandidates() {
    const view = this.sup;
    if (!view || !this.supHost) return;
    this.setTabCount('candidates', 'tab.candidates', view.candidates.length);
    this.supRefresh = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.refreshCandidates'), attrs: { type: 'button' } });
    this.supRefresh.addEventListener('click', () => this.loadCandidates('refresh'));
    const nodes = [this.el('div', { className: 'flex flex-wrap items-center justify-end gap-2 mb-4' }, [this.updatedLine(this.supUpdatedAt), this.supRefresh])];
    if (view.detect === 'off') nodes.push(this.el('p', { className: 'text-sm text-base-content/70 mb-4 max-w-prose', text: this.t('candidates.detectOff') }));
    if (!view.candidates.length) nodes.push(this.emptyBlock(this.t('candidates.empty.title'), this.t('candidates.empty.body')));
    for (const candidate of view.candidates) nodes.push(this.renderCandidate(candidate));
    if (view.rows < view.total) {
      const more = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.loadMoreVersions'), attrs: { type: 'button' } });
      more.addEventListener('click', () => this.loadCandidates('more', view.rows));
      nodes.push(this.el('div', { className: 'mb-4' }, [more]));
    }
    nodes.push(this.renderConfirmed(view.links));
    this.supHost.replaceChildren(...nodes);
  }

  /** The older and newer document of a candidate: the known direction, or the admin's choice among A and B. */
  pair(candidate) {
    if (candidate.directed) return { older: candidate.older, newer: candidate.newer };
    const pick = this.picks[candidate.id];
    if (!pick || !candidate.a || !candidate.b) return null;
    if (pick === candidate.a.id) return { older: candidate.a, newer: candidate.b };
    if (pick === candidate.b.id) return { older: candidate.b, newer: candidate.a };
    return null;
  }

  renderCandidate(candidate) {
    const ui = this.ui();
    const article = this.el('article', { className: 'border border-base-300 rounded-lg p-4 mb-4 min-w-0' });
    article.appendChild(this.el('h4', { className: 'text-base font-semibold mb-2 break-words text-balance', text: candidate.title }));
    article.appendChild(ui.ragUiHoldLine(this.doc, { tone: 'info', icon: 'files', word: this.t('status.bothCurrent'), reason: this.t('hold.candidate') }));
    const signals = this.el('div', { className: 'flex flex-wrap items-start gap-2 mt-2' });
    if (candidate.origin) signals.appendChild(this.el('span', { className: 'badge badge-outline badge-sm gap-1 shrink-0 whitespace-nowrap' }, [ui.ragUiIcon(this.doc, VERSIONS_DATES_ORIGINS[candidate.origin]), this.el('span', { text: this.t('origin.' + candidate.origin) })]));
    const lines = this.el('ul', { className: 'text-sm min-w-0 flex-1 space-y-1' });
    for (const signal of candidate.signals) {
      if (signal.key === 'signal.other') lines.appendChild(this.el('li', {}, [ui.ragUiCodeSentence(this.doc, this.locale, signal.code, this.t('signal.other'))]));
      else lines.appendChild(this.el('li', { text: this.t(signal.key) }));
    }
    signals.appendChild(lines);
    article.appendChild(signals);
    if (candidate.stale) article.appendChild(this.el('p', { className: 'text-sm mt-2 max-w-prose', text: this.t('candidate.stale') }));

    const columns = candidate.directed
      ? [
          { header: this.t('col.older'), doc: candidate.older },
          { header: this.t('col.newer'), doc: candidate.newer },
        ]
      : [
          { header: this.t('col.docA'), doc: candidate.a },
          { header: this.t('col.docB'), doc: candidate.b },
        ];
    const compare = this.el('div', { className: 'grid gap-4 md:grid-cols-2 mt-4 min-w-0', attrs: { role: 'group', 'aria-label': this.t('compare.caption') } });
    for (const column of columns) compare.appendChild(this.renderDocumentColumn(column.header, column.doc));
    article.appendChild(compare);

    const reasonId = 'rag-versions-dates-pick-' + candidate.id;
    const pair = this.pair(candidate);
    if (!candidate.directed) article.appendChild(this.renderDirectionChoice(candidate, reasonId, Boolean(pair)));
    const targetName = (pair && pair.older ? pair.older.file : candidate.a ? candidate.a.file : '') || '';
    const confirm = this.actionButton(this.t('action.confirmReplacement'), this.t('action.confirmReplacementAria', { file: targetName }), 'primary');
    const dismiss = this.actionButton(this.t('action.dismissCandidate'), this.t('action.dismissCandidateAria', { file: targetName }));
    if (!pair) {
      confirm.disabled = true;
      confirm.setAttribute('aria-describedby', reasonId);
    }
    confirm.addEventListener('click', () => this.confirmCandidate(candidate, confirm));
    dismiss.addEventListener('click', () => this.dismissCandidate(candidate, dismiss, confirm));
    article.appendChild(this.el('div', { className: 'flex flex-col md:flex-row md:flex-wrap gap-2 mt-4' }, [confirm, dismiss]));
    return article;
  }

  renderDocumentColumn(header, view) {
    const section = this.el('section', { className: 'border border-base-300 rounded-lg p-3 min-w-0' });
    section.appendChild(this.el('h5', { className: 'text-sm font-semibold mb-2', text: header }));
    if (!view) {
      section.appendChild(this.el('p', { className: 'text-sm', text: this.t('doc.unavailable') }));
      return section;
    }
    const dl = this.el('dl', { className: 'grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm' });
    const row = (label, value) => {
      dl.appendChild(this.el('dt', { className: 'text-base-content/70', text: label }));
      dl.appendChild(this.el('dd', { className: 'min-w-0 break-words' }, Array.isArray(value) ? value : [value]));
    };
    row(this.t('row.file'), this.el('span', { className: 'font-medium break-all', text: view.file }));
    row(this.t('row.docType'), view.docTypeLabel ? this.el('span', { text: view.docTypeLabel }) : this.missing('date.none'));
    row(this.t('row.docDate'), this.dayNode(view.docDate));
    row(this.t('row.effective'), this.effectiveNodes(view.from, view.to));
    const uploaded = [this.timeNode(view.uploadedAt)];
    if (view.uploader) uploaded.push(' ', this.el('span', { className: 'break-all', text: this.t('doc.uploadedBy', { name: view.uploader }) }));
    row(this.t('row.uploaded'), uploaded);
    section.appendChild(dl);
    return section;
  }

  /** "from <time> until <time>", one side only, or "No dates". */
  effectiveNodes(from, to) {
    if (!from && !to) return [this.el('span', { text: this.t('effective.none') })];
    const nodes = [];
    if (from) nodes.push(...this.dayPhrase('effective.from', from));
    if (from && to) nodes.push(' ');
    if (to) nodes.push(...this.dayPhrase('effective.to', to));
    return nodes;
  }

  /** A sentence with a {date} placeholder whose date becomes a time element. */
  dayPhrase(key, day) {
    const template = this.t(key, { date: '\u0000' });
    const [before, after] = template.split('\u0000');
    return [before || '', this.dayNode(day), after || ''].filter((n) => n !== '');
  }

  renderDirectionChoice(candidate, reasonId, chosen) {
    const name = 'rag-versions-dates-older-' + candidate.id;
    const fieldset = this.el('fieldset', { className: 'mt-4 min-w-0' }, [this.el('legend', { className: 'text-sm font-semibold mb-2', text: this.t('candidate.whichOlder') })]);
    for (const view of [candidate.a, candidate.b]) {
      if (!view) continue;
      const id = name + '-' + view.id;
      const input = this.el('input', { className: 'radio radio-sm', id, attrs: { type: 'radio', name, value: view.id, required: true } });
      input.checked = this.picks[candidate.id] === view.id;
      input.addEventListener('input', versionsDatesStop);
      input.addEventListener('change', (event) => {
        versionsDatesStop(event);
        this.picks[candidate.id] = view.id;
        this.renderCandidates();
        this.focus(this.doc.getElementById(id));
      });
      fieldset.appendChild(
        this.el('div', { className: 'flex items-center gap-2 py-1 min-w-0' }, [input, this.el('label', { className: 'text-sm break-all cursor-pointer', text: view.file, attrs: { for: id } })]),
      );
    }
    if (!chosen) fieldset.appendChild(this.el('p', { className: 'text-sm text-base-content/70 mt-1', id: reasonId, text: this.t('candidate.pickFirst') }));
    return fieldset;
  }

  async confirmCandidate(candidate, button) {
    const pair = this.pair(candidate);
    if (!pair || !pair.older || !pair.newer) {
      this.announce(this.t('candidate.pickFirst'), true);
      return;
    }
    const ui = this.ui();
    const names = { older: pair.older.file, newer: pair.newer.file };
    await ui.ragUiConfirmDialog(this.doc, {
      title: this.t('replace.title', names),
      body: [this.t('replace.body', names)],
      keepLabel: this.t('action.keepBoth'),
      confirmLabel: this.t('action.confirmReplacement'),
      runningLabel: this.t('action.confirming'),
      opener: button,
      fallbackFocus: this.statusEl(),
      onConfirm: async () => {
        const result = await ui.ragUiRagRequest(VERSIONS_DATES_SUPERSESSION_PATH + '/' + encodeURIComponent(candidate.id) + '/confirm' + this.query(), {
          method: 'POST',
          body: JSON.stringify({ olderDocumentId: pair.older.id }),
        });
        if (result && result.ok) {
          delete this.picks[candidate.id];
          await this.loadCandidates('action');
          this.announce(this.t('replace.done', names));
          return;
        }
        if (result && !result.thrown && result.status === 400 && result.body && result.body.error === 'direction_required') {
          this.announce(this.t('candidate.pickFirst'), true);
          return;
        }
        await this.actionFailed(result, 'confirm', () => this.loadCandidates('action'));
      },
    });
  }

  async dismissCandidate(candidate, button, sibling) {
    const ui = this.ui();
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('action.dismissing'), [sibling]);
    let result;
    try {
      result = await ui.ragUiRagRequest(VERSIONS_DATES_SUPERSESSION_PATH + '/' + encodeURIComponent(candidate.id) + '/dismiss' + this.query(), { method: 'POST' });
    } finally {
      restore();
    }
    if (result && result.ok) {
      delete this.picks[candidate.id];
      await this.loadCandidates('action');
      this.announce(this.t('candidate.dismissed'));
      return;
    }
    await this.actionFailed(result, 'dismiss', () => this.loadCandidates('action'));
  }

  renderConfirmed(links) {
    const ui = this.ui();
    const details = this.el('details', { className: 'mt-6 min-w-0' });
    details.appendChild(
      this.el('summary', {
        className: 'text-sm font-semibold cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        text: this.t('confirmed.summary', { count: ui.ragUiFormatNumber(links.length, this.locale) }),
      }),
    );
    if (!links.length) {
      details.appendChild(this.el('p', { className: 'text-sm text-base-content/70 mt-2', text: this.t('confirmed.empty') }));
      return details;
    }
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('confirmed.caption') }),
      this.el('thead', {}, [this.el('tr', {}, [this.th(this.t('col.older')), this.th(this.t('col.newer')), this.th(this.t('confirmed.col.when')), this.th(this.t('confirmed.col.actions'))])]),
    ]);
    const body = this.el('tbody');
    for (const link of links) body.appendChild(this.renderLinkRow(link));
    table.appendChild(body);
    details.appendChild(this.el('div', { className: 'mt-2' }, [this.tableRegion(this.t('confirmed.caption'), table)]));
    return details;
  }

  renderLinkRow(link) {
    const name = (view) => (view ? view.file : this.t('doc.unavailable'));
    const when = [this.timeNode(link.decidedAt)];
    if (link.decidedBy) when.push(' ', this.el('span', { className: 'break-all', text: this.t('confirmed.by', { name: link.decidedBy }) }));
    const undo = this.actionButton(this.t('action.undo'), this.t('action.undoAria', { file: name(link.older) }));
    undo.addEventListener('click', () => this.undoLink(link, undo));
    return this.el('tr', {}, [
      this.el('th', { className: 'font-normal break-all min-w-[10rem]', text: name(link.older), attrs: { scope: 'row' } }),
      this.el('td', { className: 'break-all min-w-[10rem]', text: name(link.newer) }),
      this.el('td', { className: 'min-w-[10rem]' }, when),
      this.el('td', {}, [undo]),
    ]);
  }

  async undoLink(link, button) {
    const ui = this.ui();
    const names = { older: link.older ? link.older.file : this.t('doc.unavailable'), newer: link.newer ? link.newer.file : this.t('doc.unavailable') };
    await ui.ragUiConfirmDialog(this.doc, {
      title: this.t('undo.title', names),
      body: [this.t('undo.body', names)],
      keepLabel: this.t('action.keepReplacement'),
      confirmLabel: this.t('action.undo'),
      runningLabel: this.t('action.undoing'),
      opener: button,
      fallbackFocus: this.statusEl(),
      onConfirm: async () => {
        const result = await ui.ragUiRagRequest(VERSIONS_DATES_SUPERSESSION_PATH + '/' + encodeURIComponent(link.id) + '/undo' + this.query(), { method: 'POST' });
        if (result && result.ok) {
          await this.loadCandidates('action');
          this.announce(this.t('undo.done'));
          return;
        }
        await this.actionFailed(result, 'undo', () => this.loadCandidates('action'));
      },
    });
  }

  // ---- Effective dates

  async loadDates(source, offset) {
    if (!this.datesHost) return;
    const ui = this.ui();
    const seq = ++this.datesSeq;
    const more = Number(offset) > 0;
    const hadContent = Boolean(this.dates);
    if (hadContent && this.datesList) ui.ragUiListBusy(this.datesList, true);
    else if (!hadContent && source !== 'action') ui.ragUiListLoading(this.doc, this.datesHost, this.t('dates.loading'));
    let restore = null;
    if (source === 'refresh' && this.datesRefresh && this.datesRefresh.isConnected !== false) restore = ui.ragUiButtonBusy(this.doc, this.datesRefresh, this.t('dates.loading'));
    const queryText = this.datesQuery.trim();
    let result;
    try {
      result = await ui.ragUiRagRequest(VERSIONS_DATES_DATES_PATH + this.query({ query: queryText, limit: VERSIONS_DATES_PAGE, offset: more ? offset : null }), { method: 'GET' });
    } finally {
      if (restore) restore();
    }
    if (seq !== this.datesSeq) return;
    if (this.datesList) ui.ragUiListBusy(this.datesList, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      const view = versionsDatesDatesView(result.body, this.today());
      view.query = queryText;
      if (more && this.dates) view.rows = this.dates.rows.concat(view.rows);
      this.dates = view;
      if (!queryText) this.awaitingCount = view.rows.filter((r) => r.awaiting).length;
      if (this.editor && !view.rows.some((r) => r.id === this.editor.id)) this.editor = null;
      this.datesUpdatedAt = new Date();
      this.datesAlert = null;
      this.renderAlerts();
      this.renderDates();
      if (source === 'first' || source === 'refresh') this.announce(this.t('dates.loaded', { count: ui.ragUiFormatNumber(this.awaitingCount || 0, this.locale) }));
      return;
    }
    const failure = this.loadFailure(result, this.datesHost, hadContent);
    if (failure.replaced) {
      this.dates = null;
      this.datesToolbar = null;
      this.datesList = null;
    }
    this.datesAlert = failure.alert || null;
    this.renderAlerts();
    this.announce(failure.mapped.message, true);
  }

  /** The toolbar is built once per load cycle so the search field keeps its focus and value while the rows change. */
  ensureDatesLayout() {
    if (this.datesToolbar && this.datesList && this.datesHost.contains(this.datesToolbar)) return;
    this.datesToolbar = this.renderDatesToolbar();
    this.datesOffNote = this.el('div', { className: 'empty:hidden mb-4' });
    this.datesList = this.el('div', { className: 'min-w-0' });
    this.datesHost.replaceChildren(this.datesToolbar, this.datesOffNote, this.datesList);
  }

  renderDatesToolbar() {
    const group = 'rag-versions-dates-filter';
    const filters = this.el('fieldset', { className: 'flex flex-wrap items-center gap-x-4 gap-y-2 min-w-0' }, [this.el('legend', { className: 'sr-only', text: this.t('dates.filterLabel') })]);
    for (const [value, key] of [
      ['awaiting', 'dates.filter.awaiting'],
      ['all', 'dates.filter.all'],
    ]) {
      const id = group + '-' + value;
      const input = this.el('input', { className: 'radio radio-sm', id, attrs: { type: 'radio', name: group, value } });
      input.checked = this.datesFilter === value;
      input.addEventListener('input', versionsDatesStop);
      input.addEventListener('change', (event) => {
        versionsDatesStop(event);
        this.datesFilter = value;
        this.editor = null;
        this.renderDates();
      });
      filters.appendChild(this.el('div', { className: 'flex items-center gap-2' }, [input, this.el('label', { className: 'text-sm cursor-pointer', text: this.t(key), attrs: { for: id } })]));
    }
    const searchId = 'rag-versions-dates-search';
    const search = this.el('input', {
      className: 'input input-bordered input-sm w-full md:w-64',
      id: searchId,
      attrs: { type: 'search', name: 'versions-dates-search', autocomplete: 'off', spellcheck: 'false', maxlength: String(VERSIONS_DATES_SEARCH_MAX) },
    });
    search.value = this.datesQuery;
    const run = () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = null;
      const next = versionsDatesText(search.value).slice(0, VERSIONS_DATES_SEARCH_MAX);
      if (next.trim() === this.datesQuery.trim() && this.dates && this.dates.query === next.trim()) return;
      this.datesQuery = next;
      this.editor = null;
      this.loadDates('search');
    };
    search.addEventListener('input', (event) => {
      versionsDatesStop(event);
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(run, VERSIONS_DATES_SEARCH_DELAY_MS);
    });
    search.addEventListener('change', versionsDatesStop);
    search.addEventListener('keydown', (event) => {
      if (event && event.key === 'Enter') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        run();
      }
    });
    this.datesRefresh = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.refreshDates'), attrs: { type: 'button' } });
    this.datesRefresh.addEventListener('click', () => this.loadDates('refresh'));
    return this.el('div', { className: 'flex flex-col lg:flex-row lg:flex-wrap lg:items-end gap-3 mb-4 min-w-0' }, [
      filters,
      this.el('div', { className: 'form-control min-w-0' }, [
        this.el('label', { className: 'label py-1', attrs: { for: searchId } }, [this.el('span', { className: 'label-text', text: this.t('dates.search') })]),
        search,
      ]),
      this.el('div', { className: 'flex flex-wrap items-center gap-2 lg:ml-auto' }, [this.updatedLine(this.datesUpdatedAt), this.datesRefresh]),
    ]);
  }

  visibleDateRows() {
    if (!this.dates) return [];
    if (this.datesFilter === 'awaiting') return this.dates.rows.filter((r) => r.awaiting);
    return this.dates.rows;
  }

  renderDates() {
    if (!this.dates || !this.datesHost) return;
    const ui = this.ui();
    this.setTabCount('dates', 'tab.dates', this.awaitingCount || 0);
    this.ensureDatesLayout();
    const updated = this.datesToolbar.querySelector('p');
    if (updated) updated.textContent = this.datesUpdatedAt ? ui.ragUiLabel('panel.updated', this.locale, { time: this.formatTime(this.datesUpdatedAt) }) : '';
    this.datesOffNote.replaceChildren(
      ...(this.controlValue('RAG_EFFECTIVE_DATES').trim() === 'true' ? [] : [ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('dates.off')] })]),
    );
    const rows = this.visibleDateRows();
    const nodes = [];
    const searching = this.dates.query !== '';
    if (!rows.length) {
      if (searching) nodes.push(this.el('p', { className: 'text-sm py-4', text: this.t('dates.noMatch') }));
      else if (this.datesFilter === 'all') nodes.push(this.el('p', { className: 'text-sm py-4 max-w-prose', text: this.t('dates.searchHint') }));
      else nodes.push(this.emptyBlock(this.t('dates.empty.title'), this.t('dates.empty.body')));
    } else {
      if (this.datesFilter === 'all' && !searching) nodes.push(this.el('p', { className: 'text-sm text-base-content/70 mb-2 max-w-prose', text: this.t('dates.searchHint') }));
      nodes.push(this.tableRegion(this.t('dates.caption'), this.renderDatesTable(rows)));
      if (this.dates.rows.length < this.dates.total) {
        const more = this.el('button', { className: 'btn btn-outline btn-sm mt-4', text: this.t('action.loadMoreDates'), attrs: { type: 'button' } });
        more.addEventListener('click', () => this.loadDates('more', this.dates.rows.length));
        nodes.push(more);
      }
    }
    nodes.push(this.el('p', { className: 'text-xs text-base-content/70 mt-2', text: this.t('dates.utc') }));
    this.datesList.replaceChildren(...nodes);
  }

  renderDatesTable(rows) {
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('dates.caption') }),
      this.el('thead', {}, [
        this.el('tr', {}, [
          this.th(this.t('row.file')),
          this.th(this.t('dates.col.from')),
          this.th(this.t('dates.col.to')),
          this.th(this.t('dates.col.confidence'), 'hidden lg:table-cell'),
          this.th(this.t('dates.col.effect')),
          this.th(this.t('dates.col.actions')),
        ]),
      ]),
    ]);
    const body = this.el('tbody');
    for (const row of rows) {
      body.appendChild(this.renderDateRow(row));
      if (row.quote) {
        body.appendChild(
          this.el('tr', {}, [
            this.el('td', { attrs: { colspan: '6' } }, [this.ui().ragUiEvidence(this.doc, { tone: 'quote', caption: this.t('dates.quote'), text: row.quote, locale: this.locale })]),
          ]),
        );
      }
      if (this.editor && this.editor.id === row.id) body.appendChild(this.renderEditorRow(row));
    }
    table.appendChild(body);
    return table;
  }

  confidenceText(value) {
    try {
      return new Intl.NumberFormat(this.locale, { style: 'percent', maximumFractionDigits: 0 }).format(value);
    } catch {
      return Math.round(value * 100) + '%';
    }
  }

  stateBadge(row) {
    if (row.awaiting) return versionsDatesBadge(this.doc, 'warning', 'calendar-event', this.t('status.datesToConfirm'));
    if (row.proposal) return versionsDatesBadge(this.doc, 'ghost', null, this.t('dates.lowConfidence'));
    if (row.origin === 'extracted') return versionsDatesBadge(this.doc, 'ghost', null, this.t('dates.origin.extracted'));
    if (row.origin === 'admin') return versionsDatesBadge(this.doc, 'ghost', null, this.t('dates.origin.admin'));
    return null;
  }

  renderDateRow(row) {
    const confidence = row.confidence === null ? this.missing('date.none') : this.el('span', { className: 'tabular-nums', text: this.confidenceText(row.confidence) });
    const effect = row.effect;
    const actions = this.el('div', { className: 'flex flex-col md:flex-row md:flex-wrap gap-2' });
    const buttons = [];
    let apply = null;
    if (row.proposal) {
      apply = this.actionButton(this.t('action.applyDates'), this.t('action.applyDatesAria', { file: row.file }), 'primary');
      buttons.push(apply);
    }
    const edit = this.actionButton(this.t('action.editDates'), this.t('action.editDatesAria', { file: row.file }));
    buttons.push(edit);
    let dismiss = null;
    if (row.proposal) {
      dismiss = this.actionButton(this.t('action.dismissDates'), this.t('action.dismissDatesAria', { file: row.file }));
      buttons.push(dismiss);
    }
    if (apply) apply.addEventListener('click', () => this.applyDates(row, apply, buttons.filter((b) => b !== apply)));
    edit.addEventListener('click', () => this.openEditor(row));
    if (dismiss) dismiss.addEventListener('click', () => this.dismissDates(row, dismiss, buttons.filter((b) => b !== dismiss)));
    for (const b of buttons) actions.appendChild(b);
    const badge = this.stateBadge(row);
    return this.el('tr', {}, [
      this.el('th', { className: 'font-normal min-w-[10rem]', attrs: { scope: 'row' } }, [
        this.el('span', { className: 'block font-medium break-all', text: row.file }),
        badge ? this.el('span', { className: 'block mt-1' }, [badge]) : null,
      ]),
      this.el('td', {}, [this.dayNode(row.window.from, 'date.noStart'), row.confidence === null ? null : this.el('span', { className: 'block text-xs text-base-content/70 lg:hidden tabular-nums', text: this.t('dates.col.confidence') + ': ' + this.confidenceText(row.confidence) })]),
      this.el('td', {}, [this.dayNode(row.window.to, 'date.noEnd')]),
      this.el('td', { className: 'hidden lg:table-cell' }, [confidence]),
      this.el('td', { className: 'min-w-[10rem]' }, this.effectNodes(effect)),
      this.el('td', {}, [actions]),
    ]);
  }

  effectNodes(effect) {
    if (!effect.date) return [this.el('span', { text: this.t(effect.key) })];
    return [this.el('span', {}, this.dayPhrase(effect.key, effect.date))];
  }

  async applyDates(row, button, siblings) {
    if (!row.proposal) return;
    const ui = this.ui();
    const range = { from: row.proposal.from, to: row.proposal.to };
    const effect = versionsDatesEffect(range.from, range.to, this.today());
    const send = async () => {
      const result = await this.putDates(row, range);
      if (result && result.ok) {
        await this.loadDates('action');
        this.announce(this.t('dates.applied', { file: row.file }));
        return true;
      }
      await this.actionFailed(result, 'apply', () => this.loadDates('action'));
      return false;
    };
    if (!effect.hides) {
      const restore = ui.ragUiButtonBusy(this.doc, button, this.t('action.applying'), siblings);
      try {
        await send();
      } finally {
        restore();
      }
      return;
    }
    await ui.ragUiConfirmDialog(this.doc, {
      title: this.t('applyDates.title', { file: row.file }),
      body: [this.t(effect.key === 'effect.future' ? 'applyDates.bodyFuture' : 'applyDates.bodyExpired', { date: effect.date })],
      keepLabel: this.t('action.keepWithoutDates'),
      confirmLabel: this.t('action.applyDates'),
      runningLabel: this.t('action.applying'),
      opener: button,
      fallbackFocus: this.statusEl(),
      onConfirm: send,
    });
  }

  putDates(row, range) {
    return this.ui().ragUiRagRequest(VERSIONS_DATES_DATES_PATH + '/' + encodeURIComponent(row.id) + this.query(), {
      method: 'PUT',
      body: JSON.stringify({ from: range.from || null, to: range.to || null }),
    });
  }

  async dismissDates(row, button, siblings) {
    const ui = this.ui();
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('action.dismissing'), siblings);
    let result;
    try {
      result = await ui.ragUiRagRequest(VERSIONS_DATES_DATES_PATH + '/' + encodeURIComponent(row.id) + '/dismiss' + this.query(), { method: 'POST' });
    } finally {
      restore();
    }
    if (result && result.ok) {
      await this.loadDates('action');
      this.announce(this.t('dates.dismissed', { file: row.file }));
      return;
    }
    await this.actionFailed(result, 'dismiss', () => this.loadDates('action'));
  }

  openEditor(row) {
    const start = row.proposal ? row.proposal : row.stored;
    this.editor = { id: row.id, from: start.from || '', to: start.to || '', error: null };
    this.renderDates();
    this.focus(this.doc.getElementById('rag-versions-dates-edit-from'));
  }

  closeEditor(row) {
    this.editor = null;
    this.renderDates();
    const opener = this.datesList
      ? this.datesList.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === this.t('action.editDatesAria', { file: row.file }))
      : null;
    this.focus(opener || this.statusEl());
  }

  editorOrderError() {
    const e = this.editor;
    return Boolean(e && e.from && e.to && e.from > e.to);
  }

  renderEditorRow(row) {
    const e = this.editor;
    const ids = { from: 'rag-versions-dates-edit-from', to: 'rag-versions-dates-edit-to', order: 'rag-versions-dates-edit-order', hint: 'rag-versions-dates-edit-hint', error: 'rag-versions-dates-edit-error' };
    const orderError = this.editorOrderError();
    const field = (key, label) => {
      const invalid = (orderError && key === 'to') || Boolean(e.error);
      const input = this.el('input', {
        className: 'input input-bordered input-sm w-full' + (invalid ? ' input-error' : ''),
        id: ids[key],
        attrs: {
          type: 'date',
          name: 'versions-dates-' + key,
          autocomplete: 'off',
          min: key === 'to' && e.from ? e.from : null,
          max: key === 'from' && e.to ? e.to : null,
          'aria-describedby': ids.hint + (orderError && key === 'to' ? ' ' + ids.order : '') + (e.error ? ' ' + ids.error : ''),
          'aria-invalid': invalid ? 'true' : null,
        },
      });
      input.value = e[key];
      input.addEventListener('input', (event) => {
        versionsDatesStop(event);
        this.editor[key] = versionsDatesDay(input.value) || '';
        this.editor.error = null;
        this.updateEditor();
      });
      input.addEventListener('change', versionsDatesStop);
      return this.el('div', { className: 'form-control min-w-0' }, [
        this.el('label', { className: 'label py-1', attrs: { for: ids[key] } }, [this.el('span', { className: 'label-text', text: label })]),
        input,
      ]);
    };
    const save = this.el('button', { className: 'btn btn-primary md:btn-sm', text: this.t('action.saveDates'), attrs: { type: 'button', 'data-versions-dates-save': '' } });
    const cancel = this.el('button', { className: 'btn btn-outline md:btn-sm', text: this.t('action.cancelEdit'), attrs: { type: 'button' } });
    save.disabled = orderError;
    if (orderError) save.setAttribute('aria-describedby', ids.order);
    save.addEventListener('click', () => this.saveEditor(row, save, cancel));
    cancel.addEventListener('click', () => this.closeEditor(row));
    const fieldset = this.el('fieldset', { className: 'min-w-0' }, [
      this.el('legend', { className: 'text-sm font-semibold mb-2 break-all', text: this.t('dates.editLegend', { file: row.file }) }),
      this.el('div', { className: 'grid gap-3 md:grid-cols-2 max-w-xl' }, [field('from', this.t('dates.col.from')), field('to', this.t('dates.col.to'))]),
      this.el('p', { className: 'text-xs text-base-content/70 mt-2', id: ids.hint, text: this.t('dates.clearHint') }),
      this.el('p', { className: 'text-sm text-error mt-2', id: ids.order, text: orderError ? this.t('dates.order') : '', attrs: { 'data-versions-dates-order': '' } }),
      e.error ? this.el('p', { className: 'text-sm text-error mt-2', id: ids.error, text: e.error, attrs: { role: 'alert' } }) : null,
      this.el('div', { className: 'flex flex-col md:flex-row gap-2 mt-3' }, [save, cancel]),
    ]);
    fieldset.addEventListener('keydown', (event) => {
      if (event && event.key === 'Escape') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        this.closeEditor(row);
      }
    });
    return this.el('tr', { attrs: { 'data-versions-dates-editor': row.id } }, [this.el('td', { attrs: { colspan: '6' } }, [fieldset])]);
  }

  /** Updates the order finding and Save dates in place, so typing keeps the focus in the date field. */
  updateEditor() {
    const save = this.datesList ? this.datesList.querySelector('[data-versions-dates-save]') : null;
    const order = this.datesList ? this.datesList.querySelector('[data-versions-dates-order]') : null;
    const from = this.doc.getElementById('rag-versions-dates-edit-from');
    const to = this.doc.getElementById('rag-versions-dates-edit-to');
    const bad = this.editorOrderError();
    if (order) order.textContent = bad ? this.t('dates.order') : '';
    if (save) {
      save.disabled = bad;
      if (bad) save.setAttribute('aria-describedby', 'rag-versions-dates-edit-order');
      else save.removeAttribute('aria-describedby');
    }
    const errorLine = this.doc.getElementById('rag-versions-dates-edit-error');
    if (errorLine) errorLine.remove();
    if (to) {
      if (this.editor.from) to.setAttribute('min', this.editor.from);
      else to.removeAttribute('min');
      if (bad) to.setAttribute('aria-invalid', 'true');
      else to.removeAttribute('aria-invalid');
      to.classList.toggle('input-error', bad);
      to.setAttribute('aria-describedby', 'rag-versions-dates-edit-hint' + (bad ? ' rag-versions-dates-edit-order' : ''));
    }
    if (from) {
      if (this.editor.to) from.setAttribute('max', this.editor.to);
      else from.removeAttribute('max');
      from.removeAttribute('aria-invalid');
      from.classList.remove('input-error');
      from.setAttribute('aria-describedby', 'rag-versions-dates-edit-hint');
    }
  }

  async saveEditor(row, button, sibling) {
    if (!this.editor || this.editorOrderError()) return;
    const ui = this.ui();
    const range = { from: this.editor.from || null, to: this.editor.to || null };
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('action.savingDates'), [sibling]);
    let result;
    try {
      result = await this.putDates(row, range);
    } finally {
      restore();
    }
    if (result && result.ok) {
      this.editor = null;
      await this.loadDates('action');
      this.announce(this.t('dates.applied', { file: row.file }));
      return;
    }
    if (result && !result.thrown && result.status === 400) {
      const body = result.body && typeof result.body === 'object' ? result.body : {};
      const message = body.error === 'invalid_window' ? this.t('dates.order') : ui.ragUiMapError(result, this.locale).message;
      this.editor.error = message;
      this.renderDates();
      this.focus(this.doc.getElementById('rag-versions-dates-edit-from'));
      this.announce(message, true);
      return;
    }
    this.editor = null;
    await this.actionFailed(result, 'apply', () => this.loadDates('action'));
  }
}

let versionsDatesPanelInstance = null;

function initVersionsDatesPanel() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rag-administration-versions');
  if (!root) return null;
  if (!versionsDatesPanelInstance) {
    versionsDatesPanelInstance = new VersionsDatesPanel(root);
    if (typeof window !== 'undefined') window.versionsDatesPanel = versionsDatesPanelInstance;
    return versionsDatesPanelInstance.mount();
  }
  return versionsDatesPanelInstance.refresh();
}

function versionsDatesBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-versions-dates-bound')) return;
    link.setAttribute('data-versions-dates-bound', '1');
    link.addEventListener('click', () => initVersionsDatesPanel());
  });
}

if (typeof window !== 'undefined') {
  window.VERSIONS_DATES_LABELS = VERSIONS_DATES_LABELS;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initVersionsDatesPanel = initVersionsDatesPanel;
  versionsDatesBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    versionsDatesBindPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initVersionsDatesPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VERSIONS_DATES_LABELS,
    versionsDatesLabel,
    versionsDatesEffect,
    versionsDatesTodayUtc,
    versionsDatesCandidateView,
    versionsDatesLinkView,
    versionsDatesSupersessionView,
    versionsDatesDateRowView,
    versionsDatesDatesView,
    versionsDatesSettingsWarnings,
    VersionsDatesPanel,
    initVersionsDatesPanel,
  };
}
