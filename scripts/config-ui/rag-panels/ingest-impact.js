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
    'pending.heading': 'Documents on previous settings',
    'pending.col.next': 'Next step',
    'rebuilds.heading': 'Rebuilds',
    'rebuilds.col.state': 'State',
    'rebuilds.col.started': 'Started',
    'rebuilds.col.actions': 'Actions',
    'rebuilds.none': 'No rebuild has been started.',
    'rebuilds.empty.title': 'No documents to rebuild',
    'rebuilds.empty.body': 'Every stored document matches the saved ingestion settings. When you change one, the affected documents appear here.',
    'rebuilds.loading': 'Loading rebuilds…',
    'rebuilds.unavailable': 'Ingestion changes are unavailable right now. Select Reload panel in a moment.',
    'rebuilds.loaded': '{pending}. {rebuilds}.',
    'coverage.missing': 'Stored documents without a fingerprint: {count}. They are not counted until you run {command}.',
    'action.start': 'Start rebuild',
    'action.startAria': 'Start rebuild: {mechanism}',
    'rebuild.starting': 'Starting…',
    'rebuild.started': 'Rebuild started: {mechanism}.',
    'rebuild.nothing': 'Nothing to rebuild: {mechanism}.',
    'rebuild.cli': 'Run this command on the server:',
    'rebuild.needsAsync':
      'Parsing again runs through the async ingest queue, which is off. Turn it on under Ingestion, Settings, or run this command:',
    'action.copy': 'Copy command',
    'action.copyAria': 'Copy command: {mechanism}',
    'copy.done': 'Command copied.',
    'copy.failed': 'The command could not be copied. Select it and copy it by hand.',
    'rebuild.progress': '{done} of {total}',
    'rebuild.gaps': 'Documents that could not be rebuilt: {count}',
    'rebuild.announce': '{mechanism}: {progress}',
    'rebuild.ended': 'Rebuild finished: {mechanism}, {state}.',
    'state.running': 'Running',
    'state.incomplete': 'Incomplete',
    'state.built': 'Built, not active',
    'state.active': 'Active',
    'state.completed': 'Completed',
    'state.rolledBack': 'Rolled back',
    'state.failed': 'Failed',
    'action.activate': 'Activate rebuild',
    'action.activateAria': 'Activate rebuild: {mechanism}',
    'action.rollback': 'Roll back rebuild',
    'action.rollbackAria': 'Roll back rebuild: {mechanism}',
    'rebuild.activating': 'Activating…',
    'rebuild.rollingBack': 'Rolling back…',
    'action.keepVersions': 'Keep current versions',
    'action.openChunking': 'Open chunking profiles',
    'action.openEmbedding': 'Open embedding profiles',
    'action.refresh': 'Refresh rebuilds',
    'action.loadMore': 'Load more rebuilds',
    'confirm.activate.title': 'Activate this rebuild?',
    'confirm.activate.body':
      'Documents in this rebuild: {count}. Their rebuilt versions replace the current ones in every workspace, starting at once. The current versions are kept, and Roll back rebuild returns to them.',
    'confirm.rollback.title': 'Roll back this rebuild?',
    'confirm.rollback.body':
      'Documents in this rebuild: {count}. They go back to their previous versions in every workspace, starting at once. The rebuilt versions are kept and can be activated again.',
    'activate.done': 'Rebuild activated.',
    'rollback.done': 'Rebuild rolled back.',
    'gate.eval_missing': 'Not activated. No evaluation result is recorded for this rebuild. Run the evaluation, then activate again.',
    'gate.eval_failed': 'Not activated. The evaluation of this rebuild shows a slice dropping beyond the noise band. The current versions stay in use.',
    'gate.incomplete': 'Not activated. Some documents are not rebuilt yet. Start the rebuild again for the rest, then activate.',
    'gate.other': 'Not changed. The server gave the reason {code}. Select Refresh rebuilds and try again.',
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
    'pending.heading': '仍使用旧设置的文档',
    'pending.col.next': '下一步',
    'rebuilds.heading': '重建记录',
    'rebuilds.col.state': '状态',
    'rebuilds.col.started': '开始时间',
    'rebuilds.col.actions': '操作',
    'rebuilds.none': '尚未开始任何重建。',
    'rebuilds.empty.title': '没有需要重建的文档',
    'rebuilds.empty.body': '所有已入库文档都与已保存的入库设置一致。更改设置后，受影响的文档会显示在这里。',
    'rebuilds.loading': '正在加载重建记录…',
    'rebuilds.unavailable': '暂时无法获取入库设置变更。请稍后选择“重新加载面板”。',
    'rebuilds.loaded': '{pending}。{rebuilds}。',
    'coverage.missing': '尚无指纹的已入库文档：{count}。运行 {command} 之前它们不会被计入。',
    'action.start': '开始重建',
    'action.startAria': '开始重建：{mechanism}',
    'rebuild.starting': '正在开始…',
    'rebuild.started': '重建已开始：{mechanism}。',
    'rebuild.nothing': '没有需要重建的文档：{mechanism}。',
    'rebuild.cli': '请在服务器上运行此命令：',
    'rebuild.needsAsync': '重新解析需要通过异步入库队列进行，而该队列目前关闭。请在“文档入库 → 设置”中开启，或运行此命令：',
    'action.copy': '复制命令',
    'action.copyAria': '复制命令：{mechanism}',
    'copy.done': '命令已复制。',
    'copy.failed': '无法复制命令。请手动选择并复制。',
    'rebuild.progress': '{done} / {total}',
    'rebuild.gaps': '无法重建的文档：{count}',
    'rebuild.announce': '{mechanism}：{progress}',
    'rebuild.ended': '重建结束：{mechanism}，{state}。',
    'state.running': '进行中',
    'state.incomplete': '未完成',
    'state.built': '已构建，未启用',
    'state.active': '已启用',
    'state.completed': '已完成',
    'state.rolledBack': '已回滚',
    'state.failed': '失败',
    'action.activate': '启用重建结果',
    'action.activateAria': '启用重建结果：{mechanism}',
    'action.rollback': '回滚重建',
    'action.rollbackAria': '回滚重建：{mechanism}',
    'rebuild.activating': '正在启用…',
    'rebuild.rollingBack': '正在回滚…',
    'action.keepVersions': '保留当前版本',
    'action.openChunking': '打开切块配置',
    'action.openEmbedding': '打开 Embedding 配置',
    'action.refresh': '刷新重建记录',
    'action.loadMore': '加载更多重建记录',
    'confirm.activate.title': '要启用这次重建的结果吗？',
    'confirm.activate.body': '本次重建的文档：{count}。重建后的版本会立即在所有工作区取代当前版本。当前版本会保留，“回滚重建”可以恢复它们。',
    'confirm.rollback.title': '要回滚这次重建吗？',
    'confirm.rollback.body': '本次重建的文档：{count}。它们会立即在所有工作区恢复为之前的版本。重建后的版本会保留，可以再次启用。',
    'activate.done': '重建结果已启用。',
    'rollback.done': '重建已回滚。',
    'gate.eval_missing': '未启用。这次重建没有评估结果记录。请先运行评估，再启用。',
    'gate.eval_failed': '未启用。这次重建的评估显示有分组下降超出噪声范围。继续使用当前版本。',
    'gate.incomplete': '未启用。还有文档尚未重建。请对其余文档再次开始重建，然后启用。',
    'gate.other': '未更改。服务器给出的原因是 {code}。请选择“刷新重建记录”后重试。',
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
    'pending.heading': 'Documenti con le impostazioni precedenti',
    'pending.col.next': 'Passo successivo',
    'rebuilds.heading': 'Ricostruzioni',
    'rebuilds.col.state': 'Stato',
    'rebuilds.col.started': 'Avviata',
    'rebuilds.col.actions': 'Azioni',
    'rebuilds.none': 'Nessuna ricostruzione avviata.',
    'rebuilds.empty.title': 'Nessun documento da ricostruire',
    'rebuilds.empty.body':
      'Tutti i documenti archiviati corrispondono alle impostazioni salvate. Quando ne cambi una, i documenti interessati appaiono qui.',
    'rebuilds.loading': 'Caricamento delle ricostruzioni…',
    'rebuilds.unavailable': 'Le modifiche all’ingestione non sono disponibili. Seleziona Ricarica pannello tra poco.',
    'rebuilds.loaded': '{pending}. {rebuilds}.',
    'coverage.missing': 'Documenti archiviati senza impronta: {count}. Non vengono contati finché non esegui {command}.',
    'action.start': 'Avvia ricostruzione',
    'action.startAria': 'Avvia ricostruzione: {mechanism}',
    'rebuild.starting': 'Avvio…',
    'rebuild.started': 'Ricostruzione avviata: {mechanism}.',
    'rebuild.nothing': 'Niente da ricostruire: {mechanism}.',
    'rebuild.cli': 'Esegui questo comando sul server:',
    'rebuild.needsAsync':
      'Il nuovo parsing passa dalla coda di ingestione asincrona, che è disattivata. Attivala in Ingestione, Impostazioni, oppure esegui questo comando:',
    'action.copy': 'Copia il comando',
    'action.copyAria': 'Copia il comando: {mechanism}',
    'copy.done': 'Comando copiato.',
    'copy.failed': 'Impossibile copiare il comando. Selezionalo e copialo a mano.',
    'rebuild.progress': '{done} di {total}',
    'rebuild.gaps': 'Documenti non ricostruiti: {count}',
    'rebuild.announce': '{mechanism}: {progress}',
    'rebuild.ended': 'Ricostruzione terminata: {mechanism}, {state}.',
    'state.running': 'In corso',
    'state.incomplete': 'Incompleta',
    'state.built': 'Costruita, non attiva',
    'state.active': 'Attiva',
    'state.completed': 'Completata',
    'state.rolledBack': 'Annullata',
    'state.failed': 'Non riuscita',
    'action.activate': 'Attiva ricostruzione',
    'action.activateAria': 'Attiva ricostruzione: {mechanism}',
    'action.rollback': 'Annulla ricostruzione',
    'action.rollbackAria': 'Annulla ricostruzione: {mechanism}',
    'rebuild.activating': 'Attivazione…',
    'rebuild.rollingBack': 'Annullamento…',
    'action.keepVersions': 'Mantieni le versioni attuali',
    'action.openChunking': 'Apri i profili di chunking',
    'action.openEmbedding': 'Apri i profili di embedding',
    'action.refresh': 'Aggiorna le ricostruzioni',
    'action.loadMore': 'Carica altre ricostruzioni',
    'confirm.activate.title': 'Attivare questa ricostruzione?',
    'confirm.activate.body':
      'Documenti in questa ricostruzione: {count}. Le versioni ricostruite sostituiscono subito quelle attuali in tutti gli spazi di lavoro. Le versioni attuali restano conservate e Annulla ricostruzione le ripristina.',
    'confirm.rollback.title': 'Annullare questa ricostruzione?',
    'confirm.rollback.body':
      'Documenti in questa ricostruzione: {count}. Tornano subito alle versioni precedenti in tutti gli spazi di lavoro. Le versioni ricostruite restano conservate e possono essere riattivate.',
    'activate.done': 'Ricostruzione attivata.',
    'rollback.done': 'Ricostruzione annullata.',
    'gate.eval_missing':
      'Non attivata. Nessun risultato di valutazione è registrato per questa ricostruzione. Esegui la valutazione, poi attiva di nuovo.',
    'gate.eval_failed':
      'Non attivata. La valutazione di questa ricostruzione mostra un calo oltre la banda di rumore. Restano in uso le versioni attuali.',
    'gate.incomplete': 'Non attivata. Alcuni documenti non sono ancora ricostruiti. Avvia di nuovo la ricostruzione per i restanti, poi attiva.',
    'gate.other': 'Nessuna modifica. Il server ha indicato il motivo {code}. Seleziona Aggiorna le ricostruzioni e riprova.',
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

const INGEST_IMPACT_POLL_MS = 15000;
const INGEST_IMPACT_ANNOUNCE_MS = 30000;
const INGEST_IMPACT_PAGE = 20;
const INGEST_IMPACT_STARTS = ['ui', 'cli', 'needs_async'];
const INGEST_IMPACT_ACTIVATIONS = ['rebuild_batch', 'chunking_profiles', 'embedding_profiles', 'none'];
const INGEST_IMPACT_GATES = ['eval_missing', 'eval_failed', 'incomplete'];
const INGEST_IMPACT_STATE_RANK = { running: 0, incomplete: 1, built: 2, active: 3 };
const INGEST_IMPACT_STATE_BADGES = {
  running: { classes: 'badge-outline border-info', icon: 'arrow-repeat', iconClass: 'text-info', key: 'state.running' },
  incomplete: { classes: 'badge-warning', icon: 'exclamation-triangle', key: 'state.incomplete' },
  built: { classes: 'badge-info', icon: 'hourglass', key: 'state.built' },
  active: { classes: 'badge-success', icon: 'check-circle-fill', key: 'state.active' },
  completed: { classes: 'badge-success badge-outline', icon: 'check-circle', key: 'state.completed' },
  rolled_back: { classes: 'badge-ghost', icon: 'arrow-counterclockwise', key: 'state.rolledBack' },
  failed: { classes: 'badge-error', icon: 'x-octagon', key: 'state.failed' },
};
const INGEST_IMPACT_PANEL_TARGETS = {
  chunking_profiles: { section: 'rag-administration-chunking', key: 'action.openChunking' },
  embedding_profiles: { section: 'rag-administration-profiles', key: 'action.openEmbedding' },
};

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
    changesHost.replaceChildren(ui.ragUiEl(doc, 'h4', { className: 'text-xs font-semibold text-base-content/70 mb-2', text: t('impact.changedHeading') }), list);
  };

  const notes = (view) => {
    const nodes = [
      ui.ragUiEl(doc, 'p', { className: 'flex items-start gap-2', id: warningId }, [
        ui.ragUiIcon(doc, 'exclamation-triangle', 'text-warning'),
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
    return ui.ragUiEl(doc, 'div', { className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', role: 'region', 'aria-label': t('impact.caption') } }, [
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

function ingestImpactCommand(value) {
  return typeof value === 'string' && value.length <= 300 ? value : '';
}

function ingestImpactStartedAt(value) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * The GET ingest-fingerprint answer as the Rebuilds view needs it (UI-SPEC 8.1). Named fields only: a run id is kept for the action
 * request and never rendered; fingerprints, batch ids and any other field are dropped (UI-SPEC 11.4, 11.5).
 */
function ingestImpactRebuildsView(body) {
  const answer = body && typeof body === 'object' ? body : {};
  const pending = (Array.isArray(answer.pending) ? answer.pending : [])
    .filter((row) => row && typeof row === 'object' && typeof row.mechanism === 'string')
    .map((row) => ({
      mechanism: row.mechanism,
      affected: ingestImpactCount(row.affected),
      start: INGEST_IMPACT_STARTS.includes(row.start) ? row.start : 'cli',
      command: ingestImpactCommand(row.command),
    }))
    .filter((row) => row.affected > 0);
  const without = answer.without_fingerprint && typeof answer.without_fingerprint === 'object' ? answer.without_fingerprint : {};
  const rebuilds = (Array.isArray(answer.rebuilds) ? answer.rebuilds : [])
    .filter((row) => row && typeof row === 'object' && typeof row.id === 'string' && typeof row.mechanism === 'string')
    .map((row) => ({
      id: row.id,
      mechanism: row.mechanism,
      done: ingestImpactCount(row.done),
      total: ingestImpactCount(row.total),
      gaps: ingestImpactCount(row.gaps),
      state: typeof row.state === 'string' ? row.state : '',
      started: ingestImpactStartedAt(row.started) === null ? null : row.started,
      activation: INGEST_IMPACT_ACTIVATIONS.includes(row.activation) ? row.activation : 'none',
    }));
  const rank = (state) => (Object.prototype.hasOwnProperty.call(INGEST_IMPACT_STATE_RANK, state) ? INGEST_IMPACT_STATE_RANK[state] : 4);
  rebuilds.sort((a, b) => rank(a.state) - rank(b.state) || (ingestImpactStartedAt(b.started) ?? -Infinity) - (ingestImpactStartedAt(a.started) ?? -Infinity));
  return {
    pending,
    missing: { count: ingestImpactCount(without.count), command: ingestImpactCommand(without.command) || INGEST_IMPACT_BACKFILL_COMMAND },
    rebuilds,
    running: rebuilds.some((row) => row.state === 'running'),
    empty: pending.length === 0 && rebuilds.length === 0,
  };
}

/** The Actions cell (UI-SPEC 6.4.2, finding 6): Activate or Roll back only for a held reparse batch; links for the profile panels. */
function ingestImpactRowAction(row) {
  if (row.activation === 'rebuild_batch') {
    if (row.state === 'built') return 'activate';
    if (row.state === 'active') return 'rollback';
    return null;
  }
  if (INGEST_IMPACT_PANEL_TARGETS[row.activation]) return row.activation;
  return null;
}

class IngestImpactPanel {
  constructor(root, options) {
    const opts = options || {};
    this.root = root;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.locale = ingestImpactLocale();
    this.pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : INGEST_IMPACT_POLL_MS;
    this.announceMs = typeof opts.announceMs === 'number' ? opts.announceMs : INGEST_IMPACT_ANNOUNCE_MS;
    this.mounted = false;
    this.tabs = null;
    this.warningsHost = null;
    this.rebuildsHost = null;
    this.view = null;
    this.visible = INGEST_IMPACT_PAGE;
    this.loading = false;
    this.pollTimer = null;
    this.pollStopped = false;
    this.lastAnnounce = 0;
    this.runningIds = new Set();
    this.loadAlert = null;
    this.gateAlert = null;
    this.refreshButton = null;
    this.updatedAt = null;
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
    if (this.doc && typeof this.doc.addEventListener === 'function') {
      this.doc.addEventListener('visibilitychange', () => this.schedulePoll());
    }
    await this.loadRebuilds('first');
  }

  async refresh() {
    this.pollStopped = false;
    await this.loadRebuilds('refresh');
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


  tabActive() {
    const tab = this.doc.getElementById('rag-administration');
    return !tab || tab.classList.contains('active');
  }

  documentVisible() {
    return this.doc.visibilityState !== 'hidden';
  }

  stopPolling() {
    this.pollStopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** UI-SPEC 6.4.2: reload every 15 seconds only while a rebuild runs, the tab is active and the document is visible. */
  schedulePoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.pollStopped || !this.view || !this.view.running || !this.tabActive() || !this.documentVisible()) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.view && this.view.running && this.tabActive() && this.documentVisible()) this.loadRebuilds('poll');
    }, this.pollMs);
  }

  mechanismText(mechanism) {
    return ingestImpactMechanismLabel(mechanism, this.locale, null) || mechanism;
  }

  stateText(state) {
    const badge = INGEST_IMPACT_STATE_BADGES[state];
    return badge ? this.t(badge.key) : state;
  }

  renderAlerts() {
    const host = this.root.querySelector('[data-ingest-impact-alert]');
    if (!host) return;
    host.replaceChildren(...[this.gateAlert, this.loadAlert].filter(Boolean));
  }

  async loadRebuilds(source) {
    if (!this.rebuildsHost || this.loading) return;
    const ui = ingestImpactUiLib();
    this.loading = true;
    const hadContent = Boolean(this.view);
    if (hadContent) ui.ragUiListBusy(this.rebuildsHost, true);
    else ui.ragUiListLoading(this.doc, this.rebuildsHost, this.t('rebuilds.loading'));
    let restore = null;
    if (hadContent && this.refreshButton && this.refreshButton.isConnected !== false && source === 'refresh') {
      restore = ui.ragUiButtonBusy(this.doc, this.refreshButton, this.t('rebuilds.loading'));
    }
    let result;
    try {
      result = await ui.ragUiRagRequest(INGEST_IMPACT_PATHS.coverage, { method: 'GET' });
    } finally {
      this.loading = false;
      if (restore) restore();
    }
    if (result && result.ok && result.body && typeof result.body === 'object') {
      const previous = this.runningIds;
      this.view = ingestImpactRebuildsView(result.body);
      this.updatedAt = new Date();
      this.loadAlert = null;
      this.renderAlerts();
      ui.ragUiListBusy(this.rebuildsHost, false);
      this.renderRebuilds();
      this.announceLoad(source, previous);
    } else {
      const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('rebuilds.unavailable') });
      if (mapped.kind === 'signIn') {
        this.view = null;
        this.loadAlert = null;
        this.renderAlerts();
        ui.ragUiListBusy(this.rebuildsHost, false);
        this.rebuildsHost.replaceChildren(ui.ragUiSignInAlert(this.doc, this.locale, () => this.refresh()));
      } else {
        this.loadAlert = ui.ragUiUnavailableAlert(this.doc, this.locale, mapped.message, () => this.refresh());
        this.renderAlerts();
        if (hadContent) ui.ragUiListBusy(this.rebuildsHost, true, true);
        else this.rebuildsHost.replaceChildren();
      }
      this.announce(mapped.message, true);
    }
    this.schedulePoll();
  }

  /** Load counts on the first load and on Refresh; progress at most every 30 seconds; always the end state of a run. */
  announceLoad(source, previous) {
    const ui = ingestImpactUiLib();
    const view = this.view;
    const now = Date.now();
    const ended = view.rebuilds.filter((row) => previous.has(row.id) && row.state !== 'running');
    this.runningIds = new Set(view.rebuilds.filter((row) => row.state === 'running').map((row) => row.id));
    if (ended.length) {
      const row = ended[0];
      this.announce(this.t('rebuild.ended', { mechanism: this.mechanismText(row.mechanism), state: this.stateText(row.state) }));
      this.lastAnnounce = now;
      return;
    }
    const running = view.rebuilds.find((row) => row.state === 'running');
    if (running && (this.lastAnnounce === 0 || now - this.lastAnnounce >= this.announceMs)) {
      const progress = this.t('rebuild.progress', { done: ui.ragUiFormatNumber(running.done, this.locale), total: ui.ragUiFormatNumber(running.total, this.locale) });
      this.announce(this.t('rebuild.announce', { mechanism: this.mechanismText(running.mechanism), progress }));
      this.lastAnnounce = now;
      return;
    }
    if (source === 'first' || source === 'refresh') {
      const pending = view.pending.reduce((sum, row) => sum + row.affected, 0);
      this.announce(
        this.t('rebuilds.loaded', {
          pending: ui.ragUiCount(this.t('pending.heading'), pending, this.locale),
          rebuilds: ui.ragUiCount(this.t('rebuilds.heading'), view.rebuilds.length, this.locale),
        }),
      );
    }
  }

  formatTime(date, withDate) {
    try {
      const options = withDate ? { dateStyle: 'medium', timeStyle: 'short' } : { timeStyle: 'short' };
      return new Intl.DateTimeFormat(this.locale, options).format(date);
    } catch {
      return date.toISOString();
    }
  }

  tableRegion(label, table) {
    return this.el('div', { className: 'overflow-x-auto mb-6 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', role: 'region', 'aria-label': label } }, [table]);
  }

  th(text, extra) {
    return this.el('th', { className: 'font-semibold' + (extra ? ' ' + extra : ''), text, attrs: { scope: 'col' } });
  }

  renderRebuilds() {
    const ui = ingestImpactUiLib();
    const view = this.view;
    const nodes = [];
    this.refreshButton = this.el('button', { className: 'btn btn-sm', text: this.t('action.refresh'), attrs: { type: 'button' } });
    this.refreshButton.addEventListener('click', () => this.refresh());
    nodes.push(
      this.el('div', { className: 'flex flex-wrap items-center justify-between gap-2 mb-4' }, [
        this.el('span', { className: 'text-xs text-base-content/70', text: ui.ragUiLabel('panel.updated', this.locale, { time: this.formatTime(this.updatedAt, false) }) }),
        this.refreshButton,
      ]),
    );
    if (view.missing.count > 0) {
      const vars = { count: ui.ragUiFormatNumber(view.missing.count, this.locale), command: view.missing.command };
      nodes.push(this.el('p', { className: 'text-sm mb-4 max-w-prose' }, ui.ragUiTemplateNodes(this.doc, this.t('coverage.missing'), vars, ['command'])));
    }
    if (view.empty) {
      nodes.push(
        this.el('div', { className: 'py-8 text-center' }, [
          this.el('p', { className: 'text-base font-semibold mb-2 text-balance', text: this.t('rebuilds.empty.title') }),
          this.el('p', { className: 'text-sm text-base-content/70 max-w-prose mx-auto text-pretty', text: this.t('rebuilds.empty.body') }),
        ]),
      );
      this.rebuildsHost.replaceChildren(...nodes);
      return;
    }
    if (view.pending.length) {
      nodes.push(this.el('h4', { className: 'text-base font-semibold mb-2 text-balance', text: this.t('pending.heading') }));
      nodes.push(this.pendingTable(view.pending));
    }
    nodes.push(this.el('h4', { className: 'text-base font-semibold mb-2 text-balance', text: this.t('rebuilds.heading') }));
    if (view.rebuilds.length) {
      nodes.push(this.rebuildsTable(view.rebuilds.slice(0, this.visible)));
      if (view.rebuilds.length > this.visible) {
        const more = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.loadMore'), attrs: { type: 'button' } });
        more.addEventListener('click', () => {
          this.visible += INGEST_IMPACT_PAGE;
          this.renderRebuilds();
        });
        nodes.push(more);
      }
    } else {
      nodes.push(this.el('p', { className: 'text-sm', text: this.t('rebuilds.none') }));
    }
    this.rebuildsHost.replaceChildren(...nodes);
  }

  commandBlock(row, sentenceKey) {
    const children = [
      this.el('p', { className: 'text-sm max-w-prose', text: this.t(sentenceKey) }),
      this.el('div', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [
        this.el('code', { className: 'font-mono text-xs break-all min-w-0', text: row.command, attrs: { translate: 'no' } }),
        this.copyButton(row),
      ]),
    ];
    return this.el('div', { className: 'flex flex-col gap-1 min-w-0' }, children);
  }

  copyButton(row) {
    const clipboard = typeof navigator !== 'undefined' && navigator ? navigator.clipboard : null;
    if (!row.command || !clipboard || typeof clipboard.writeText !== 'function') return null;
    const button = this.el('button', {
      className: 'btn btn-ghost md:btn-sm',
      text: this.t('action.copy'),
      attrs: { type: 'button', 'aria-label': this.t('action.copyAria', { mechanism: this.mechanismText(row.mechanism) }) },
    });
    button.addEventListener('click', async () => {
      try {
        await clipboard.writeText(row.command);
        this.announce(this.t('copy.done'));
      } catch {
        this.announce(this.t('copy.failed'), true);
      }
    });
    return button;
  }

  pendingTable(rows) {
    const ui = ingestImpactUiLib();
    const body = this.el('tbody');
    for (const row of rows) {
      let next;
      if (row.start === 'ui') {
        const button = this.el('button', {
          className: 'btn btn-primary md:btn-sm',
          text: this.t('action.start'),
          attrs: { type: 'button', 'aria-label': this.t('action.startAria', { mechanism: this.mechanismText(row.mechanism) }) },
        });
        button.addEventListener('click', () => this.start(row, button));
        next = button;
      } else {
        next = row.command ? this.commandBlock(row, row.start === 'needs_async' ? 'rebuild.needsAsync' : 'rebuild.cli') : null;
      }
      body.appendChild(
        this.el('tr', {}, [
          this.el('th', { className: 'font-normal break-words', attrs: { scope: 'row' } }, [ingestImpactMechanismNode(this.doc, row.mechanism, this.locale, null)]),
          this.el('td', { className: 'text-right tabular-nums', text: ui.ragUiFormatNumber(row.affected, this.locale) }),
          this.el('td', { className: 'min-w-56' }, [next]),
        ]),
      );
    }
    const table = this.el('table', { className: 'table table-sm', attrs: { 'data-ingest-impact-table': 'pending' } }, [
      this.el('caption', { className: 'sr-only', text: this.t('pending.heading') }),
      this.el('thead', {}, [this.el('tr', {}, [this.th(this.t('impact.col.rebuild')), this.th(this.t('impact.col.documents'), 'text-right'), this.th(this.t('pending.col.next'))])]),
      body,
    ]);
    return this.tableRegion(this.t('pending.heading'), table);
  }

  stateBadge(state) {
    const ui = ingestImpactUiLib();
    const badge = INGEST_IMPACT_STATE_BADGES[state];
    if (!badge) {
      return this.el('span', { className: 'badge badge-sm badge-ghost gap-1' }, [
        this.el('span', { className: 'font-mono', text: state, attrs: { translate: 'no' } }),
      ]);
    }
    return this.el('span', { className: 'badge badge-sm gap-1 whitespace-nowrap ' + badge.classes }, [ui.ragUiIcon(this.doc, badge.icon, badge.iconClass), this.el('span', { text: this.t(badge.key) })]);
  }

  rebuildsTable(rows) {
    const ui = ingestImpactUiLib();
    const body = this.el('tbody');
    for (const row of rows) {
      const progressText = this.t('rebuild.progress', { done: ui.ragUiFormatNumber(row.done, this.locale), total: ui.ragUiFormatNumber(row.total, this.locale) });
      const documents = [];
      if (row.state === 'running') {
        documents.push(
          this.el('progress', {
            className: 'progress progress-primary w-full min-w-24',
            attrs: { value: String(row.done), max: String(Math.max(row.total, 1)), 'aria-label': progressText },
          }),
        );
      }
      documents.push(this.el('span', { className: 'text-sm tabular-nums', text: progressText }));
      if (row.gaps > 0) {
        documents.push(
          this.el('p', { className: 'flex items-start gap-1 text-xs mt-1' }, [
            ui.ragUiIcon(this.doc, 'exclamation-triangle', 'text-warning'),
            this.el('span', { text: this.t('rebuild.gaps', { count: ui.ragUiFormatNumber(row.gaps, this.locale) }) }),
          ]),
        );
      }
      const started = row.started
        ? this.el('time', { text: this.formatTime(new Date(row.started), true), attrs: { datetime: row.started } })
        : this.el('span', { text: '—' });
      body.appendChild(
        this.el('tr', {}, [
          this.el('th', { className: 'font-normal break-words', attrs: { scope: 'row' } }, [ingestImpactMechanismNode(this.doc, row.mechanism, this.locale, null)]),
          this.el('td', { className: 'min-w-0' }, [this.el('div', { className: 'flex flex-col gap-1' }, documents)]),
          this.el('td', {}, [this.stateBadge(row.state)]),
          this.el('td', { className: 'hidden lg:table-cell text-xs whitespace-nowrap' }, [started]),
          this.el('td', {}, [this.rowActionNode(row)]),
        ]),
      );
    }
    const table = this.el('table', { className: 'table table-sm', attrs: { 'data-ingest-impact-table': 'rebuilds' } }, [
      this.el('caption', { className: 'sr-only', text: this.t('rebuilds.heading') }),
      this.el('thead', {}, [
        this.el('tr', {}, [
          this.th(this.t('impact.col.rebuild')),
          this.th(this.t('impact.col.documents')),
          this.th(this.t('rebuilds.col.state')),
          this.th(this.t('rebuilds.col.started'), 'hidden lg:table-cell'),
          this.th(this.t('rebuilds.col.actions')),
        ]),
      ]),
      body,
    ]);
    return this.tableRegion(this.t('rebuilds.heading'), table);
  }

  rowActionNode(row) {
    const action = ingestImpactRowAction(row);
    const mechanism = this.mechanismText(row.mechanism);
    if (action === 'activate' || action === 'rollback') {
      const activate = action === 'activate';
      const button = this.el('button', {
        className: 'btn md:btn-sm ' + (activate ? 'btn-primary' : 'btn-outline'),
        text: this.t(activate ? 'action.activate' : 'action.rollback'),
        attrs: { type: 'button', 'aria-label': this.t(activate ? 'action.activateAria' : 'action.rollbackAria', { mechanism }) },
      });
      button.addEventListener('click', () => this.decide(row, action, button));
      return button;
    }
    if (action && INGEST_IMPACT_PANEL_TARGETS[action]) {
      const target = INGEST_IMPACT_PANEL_TARGETS[action];
      const link = this.el('button', { className: 'btn btn-link btn-sm px-0', text: this.t(target.key), attrs: { type: 'button' } });
      link.addEventListener('click', () => this.openPanel(target.section));
      return link;
    }
    return null;
  }

  openPanel(sectionId) {
    const section = this.doc.getElementById(sectionId);
    if (!section) return;
    if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'start' });
    const heading = section.querySelector('h3');
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus();
  }

  gate(reason) {
    const ui = ingestImpactUiLib();
    const code = typeof reason === 'string' && reason ? reason : 'unknown';
    const body = INGEST_IMPACT_GATES.includes(code)
      ? [this.t('gate.' + code)]
      : [this.el('p', { className: 'text-sm' }, ui.ragUiTemplateNodes(this.doc, this.t('gate.other'), { code }, ['code']))];
    this.gateAlert = ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', role: 'alert', body });
    this.renderAlerts();
  }

  /** The answer of a start, activate or rollback (UI-SPEC 8.2): gate refusals in the alert host, the rest in the status region. */
  async settle(result, action, doneText) {
    const ui = ingestImpactUiLib();
    if (result && result.ok) {
      this.announce(doneText);
      await this.loadRebuilds('action');
      return;
    }
    const body = result && result.body && typeof result.body === 'object' ? result.body : {};
    if (result && result.status === 409 && ['activation_refused', 'rollback_refused', 'start_refused'].includes(body.error)) {
      this.gate(body.reason);
      await this.loadRebuilds('action');
      return;
    }
    const mapped = ui.ragUiMapError(result, this.locale, { action, unavailable: this.t('rebuilds.unavailable') });
    this.announce(mapped.message, true);
    if (mapped.reload) await this.loadRebuilds('action');
  }

  async start(row, button) {
    const ui = ingestImpactUiLib();
    this.gateAlert = null;
    this.renderAlerts();
    const others = Array.from(this.rebuildsHost.querySelectorAll('button')).filter((b) => b !== button);
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('rebuild.starting'), others);
    let result;
    try {
      result = await ui.ragUiRagRequest(INGEST_IMPACT_PATHS.rebuild, { method: 'POST', body: JSON.stringify({ mechanism: row.mechanism }) }, 60000);
    } finally {
      restore();
    }
    const mechanism = this.mechanismText(row.mechanism);
    const nothing = result && result.ok && result.body && result.body.status === 'nothing';
    await this.settle(result, 'start', this.t(nothing ? 'rebuild.nothing' : 'rebuild.started', { mechanism }));
  }

  async decide(row, action, button) {
    const ui = ingestImpactUiLib();
    this.gateAlert = null;
    this.renderAlerts();
    const activate = action === 'activate';
    const path = INGEST_IMPACT_PATHS.rebuild + '/' + encodeURIComponent(row.id) + '/' + (activate ? 'activate' : 'rollback');
    let result = null;
    const confirmed = await ui.ragUiConfirmDialog(this.doc, {
      title: this.t(activate ? 'confirm.activate.title' : 'confirm.rollback.title'),
      body: [this.t(activate ? 'confirm.activate.body' : 'confirm.rollback.body', { count: ui.ragUiFormatNumber(row.total, this.locale) })],
      keepLabel: this.t('action.keepVersions'),
      confirmLabel: this.t(activate ? 'action.activate' : 'action.rollback'),
      runningLabel: this.t(activate ? 'rebuild.activating' : 'rebuild.rollingBack'),
      opener: button,
      fallbackFocus: this.root.querySelector('[data-ingest-impact-status]'),
      onConfirm: async () => {
        result = await ui.ragUiRagRequest(path, { method: 'POST', body: '{}' }, 60000);
      },
    });
    if (!confirmed) return;
    await this.settle(result, activate ? 'activate' : 'rollback', this.t(activate ? 'activate.done' : 'rollback.done'));
  }
}

let ingestImpactPanelInstance = null;

function initIngestImpactPanel(options) {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rag-administration-ingest-impact');
  if (!root) return null;
  if (!ingestImpactPanelInstance) {
    ingestImpactPanelInstance = new IngestImpactPanel(root, options);
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
    ingestImpactRebuildsView,
    ingestImpactRowAction,
    ingestImpactCreateGuard,
    IngestImpactPanel,
    initIngestImpactPanel,
  };
}
