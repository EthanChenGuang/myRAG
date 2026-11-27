/**
 * Question sources panel (EVAL-27, EVAL-30, D-39, D-41, D-51, D-52; UI-SPEC 6.10 and 12.6): where review-queue questions come from
 * besides failed answers. Per workspace (#workspace-selector). Sub-tabs: Weekly sample (counts and dates from the sample status route),
 * Pilot users (masked e-mail or user id), Import questions (a file read in the browser and sent in JSON batches of at most 60 KB; counts
 * only) and Settings (the sample group of #rag-phase053-settings). Nothing a user wrote is shown, and nothing from a file is written to
 * web storage. DOM through the gates-ui helpers (cuiEl, createElement, textContent).
 */

const QUESTION_SOURCES_GATES =
  typeof gatesUiMessageFrom === 'function'
    ? {
        GATES_UI_LABELS,
        gatesUiMessageFrom,
        gatesUiLocale,
        gatesUiNumber,
        gatesUiPercent,
        gatesUiDate,
        gatesUiLanguageName,
        gatesUiEl,
        gatesUiIcon,
        gatesUiSpinner,
        gatesUiAppendMessage,
        gatesUiMessageEl,
        gatesUiAlert,
        gatesUiStatus,
        gatesUiSetBusy,
        gatesUiLoadingBlock,
        gatesUiEmptyBlock,
        gatesUiErrorAlert,
        gatesUiMapError,
        gatesUiFetch,
        gatesUiSubTabs,
        gatesUiConfirm,
      }
    : require('./gates-ui.js');

const QUESTION_SOURCES_SAMPLE_API = '/api/rag/admin/monitor/sample';
const QUESTION_SOURCES_PILOT_API = '/api/rag/admin/pilot-users';
const QUESTION_SOURCES_IMPORT_API = '/api/rag/admin/questions-import';
const QUESTION_SOURCES_TABS = ['sample', 'pilot', 'import', 'settings'];
const QUESTION_SOURCES_SOURCES = ['representative', 'pilot', 'drift_fill'];
const QUESTION_SOURCES_PREREQUISITES = { log: { key: 'sample.needs.log', variable: 'RAG_RETRIEVAL_LOG' }, review: { key: 'sample.needs.review', variable: 'RAG_DOMAIN_EXPERT_REVIEW' } };
/** Client-side import limits (UI-SPEC 6.10.3, the route's IMPORT_LIMITS). A question longer than maxQuestionChars is cut before sending; the server shortens to 2,000 characters after masking and counts it. */
const QUESTION_SOURCES_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxRows: 20000,
  maxBatchBytes: 60 * 1024,
  maxBatchRows: 2000,
  maxQuestionChars: 8000,
  maxColumnChars: 128,
  batchTimeoutMs: 60000,
};

const QUESTION_SOURCES_LABELS = {
  en: {
    'panel.title': 'Question sources',
    'panel.description': 'Where review-queue questions come from besides failed answers: a weekly sample of real questions, pilot users, and imported past questions. For the selected workspace.',
    'panel.tabsLabel': 'Question source views',
    'tab.sample': 'Weekly sample',
    'tab.pilot': 'Pilot users',
    'tab.import': 'Import questions',
    'tab.settings': 'Settings',
    'count.item': '{label}: {value}',
    'sample.loading': 'Loading the weekly sample…',
    'sample.state': 'Weekly sampling',
    'sample.last': 'Last sample',
    'sample.added': 'Questions added to the review queue',
    'sample.source.representative': 'From the weekly sample',
    'sample.source.pilot': 'From pilot users',
    'sample.source.drift_fill': 'From under-covered topic groups',
    'sample.clusters': 'Topic groups: {count}, refitted {date}',
    'sample.clusters.noDate': 'Topic groups: {count}',
    'sample.novel': 'Questions not in any group',
    'sample.byLanguage': 'By language',
    'sample.col.added': 'Questions added',
    'action.refreshSample': 'Refresh sample',
    'action.runSample': 'Run sample now',
    'run.running': 'Drawing the sample…',
    'run.done': 'Sample finished. Questions added to the review queue: {count}.',
    'run.failed': 'The sample did not finish. Nothing was added. Select Run sample now again in a moment.',
    'sample.off.title': 'Weekly sampling is off',
    'sample.off.body': 'Only failed answers reach the review queue. To add a weekly sample of all real questions, set Weekly sampling to On under Settings and save.',
    'sample.needs.log': 'Sampling needs the retrieval log at the level masked_query. Set {variable}.',
    'sample.needs.review': 'Sampling needs expert review switched on. Set {variable} to true.',
    'sample.empty.title': 'No sample yet',
    'sample.empty.body': 'The first sample is drawn by the weekly job, or now with Run sample now.',
    'settings.sample.label': 'Weekly sampling',
    'settings.sample.help': 'On: each week a sample of all real questions, spread across topic groups, languages and channels, is added to the review queue.',
    'warn.sampleNeedsLog': 'Weekly sampling is on, but the retrieval log is not at the level masked_query. Nothing will be sampled.',
    'warn.sampleNeedsReview': 'Weekly sampling is on, but expert review is off. Nothing will be sampled.',
    'pilot.loading': 'Loading pilot users…',
    'pilot.explain': 'Questions from pilot users are sampled {weight} times as often, up to {share} of each weekly sample. Use this while there is little real traffic.',
    'pilot.explain.plain': 'Questions from pilot users are sampled more often than others. Use this while there is little real traffic.',
    'pilot.field.label': 'User e-mail or user ID',
    'action.addPilot': 'Add pilot user',
    'pilot.empty.field': 'Enter an e-mail address or a user ID.',
    'pilot.added': 'Pilot user added.',
    'pilot.notFound': 'No user with that e-mail or ID belongs to this workspace.',
    'pilot.exists': 'This user is already a pilot user.',
    'pilot.gone': 'This pilot user was already removed. The list has been reloaded.',
    'pilot.caption': 'Pilot users of this workspace',
    'pilot.col.user': 'User',
    'pilot.col.added': 'Added',
    'pilot.col.actions': 'Actions',
    'pilot.shown': 'Pilot users shown: {count}',
    'action.removePilot': 'Remove pilot user',
    'action.removeAria': 'Remove pilot user {user}',
    'action.morePilot': 'Load more pilot users',
    'confirm.remove.title': 'Remove this pilot user?',
    'confirm.remove.body': '{user} goes back to the normal sampling rate. Questions already in the review queue stay there.',
    'confirm.remove.keep': 'Keep pilot user',
    'pilot.removed': 'Pilot user removed.',
    'pilot.empty.title': 'No pilot users',
    'pilot.empty.body': 'Add the people who try the system first. Their questions reach the review queue more often.',
    'import.explain': 'Import questions people asked before this system was in use, from a CSV or JSONL export. Personal data is masked on import, and a question that still looks personal after masking is rejected. Only counts are shown here, and the file is not kept. Imported questions count as real once an expert labels them.',
    'import.file.label': 'File (CSV or JSONL)',
    'import.column.label': 'Column with the question',
    'import.column.help': 'Read from the first line of the file.',
    'import.chooseFirst': 'Choose a file to check.',
    'action.checkFile': 'Check file',
    'action.import': 'Import questions',
    'action.reset': 'Choose another file',
    'import.progress': '{done} of {total} questions',
    'import.barLabel': 'Import progress',
    'import.result.check': 'Check result. Nothing was imported yet.',
    'import.result.done': 'Import result',
    'import.count.read': 'Questions read',
    'import.count.wouldAdd': 'Would be added to the review queue',
    'import.count.added': 'Added to the review queue',
    'import.count.duplicates': 'Already in the queue',
    'import.count.rejected': 'Rejected: still personal after masking',
    'import.count.truncated': 'Shortened to 2,000 characters',
    'import.count.empty': 'Empty rows skipped',
    'import.counts.caption': 'Question counts',
    'import.col.count': 'Count',
    'import.col.language': 'Language',
    'import.col.questions': 'Questions',
    'import.done': 'Import finished. Questions added to the review queue: {count}.',
    'import.nothingNew': 'Nothing new to import: every question is already in the queue, was rejected or is empty.',
    'import.tooLarge': 'This file is too large (limit: {size}, {rows} rows). Split it and import the parts one after the other.',
    'import.badFormat': 'This file could not be read as CSV or JSONL. Line {line} is not valid. Fix the file and choose it again.',
    'import.noColumn': 'No column could be read from the first line. A CSV file needs a header row; a JSONL file needs one object per line.',
    'import.interrupted': 'The import stopped after {done} of {total} questions. Select Import questions again: questions already added are counted as already in the queue.',
    'import.needs.review': 'Importing needs expert review switched on. Set {variable} to true.',
  },
  zh: {
    'panel.title': '问题来源',
    'panel.description': '除失败回答外，审核队列中问题的其他来源：每周对真实问题的抽样、试点用户，以及导入的历史问题。针对所选工作区。',
    'panel.tabsLabel': '问题来源视图',
    'tab.sample': '每周抽样',
    'tab.pilot': '试点用户',
    'tab.import': '导入问题',
    'tab.settings': '设置',
    'count.item': '{label}：{value}',
    'sample.loading': '正在加载每周抽样…',
    'sample.state': '每周抽样',
    'sample.last': '最近一次抽样',
    'sample.added': '加入审核队列的问题数',
    'sample.source.representative': '来自每周抽样',
    'sample.source.pilot': '来自试点用户',
    'sample.source.drift_fill': '来自覆盖不足的主题分组',
    'sample.clusters': '主题分组：{count} 个，重新划分于 {date}',
    'sample.clusters.noDate': '主题分组：{count} 个',
    'sample.novel': '不属于任何分组的问题数',
    'sample.byLanguage': '按语言',
    'sample.col.added': '已加入的问题数',
    'action.refreshSample': '刷新抽样',
    'action.runSample': '立即运行抽样',
    'run.running': '正在抽样…',
    'run.done': '抽样已完成。加入审核队列的问题数：{count}。',
    'run.failed': '抽样没有完成，未添加任何问题。请稍后再次点击“立即运行抽样”。',
    'sample.off.title': '每周抽样已关闭',
    'sample.off.body': '目前只有失败的回答会进入审核队列。若要每周从全部真实问题中抽样，请在“设置”中将“每周抽样”设为开启并保存。',
    'sample.needs.log': '抽样需要检索日志级别为 masked_query。请设置 {variable}。',
    'sample.needs.review': '抽样需要开启专家审核。请将 {variable} 设为 true。',
    'sample.empty.title': '尚未抽样',
    'sample.empty.body': '第一次抽样由每周任务完成，也可以点击“立即运行抽样”。',
    'settings.sample.label': '每周抽样',
    'settings.sample.help': '开启：每周从全部真实问题中按主题分组、语言和渠道分层抽样，并加入审核队列。',
    'warn.sampleNeedsLog': '每周抽样已开启，但检索日志级别不是 masked_query。不会进行抽样。',
    'warn.sampleNeedsReview': '每周抽样已开启，但专家审核处于关闭状态。不会进行抽样。',
    'pilot.loading': '正在加载试点用户…',
    'pilot.explain': '试点用户的问题被抽中的概率为普通用户的 {weight} 倍，最多占每次每周抽样的 {share}。适合在真实流量较少时使用。',
    'pilot.explain.plain': '试点用户的问题比其他用户的问题更容易被抽中。适合在真实流量较少时使用。',
    'pilot.field.label': '用户邮箱或用户 ID',
    'action.addPilot': '添加试点用户',
    'pilot.empty.field': '请输入邮箱地址或用户 ID。',
    'pilot.added': '已添加试点用户。',
    'pilot.notFound': '该工作区中没有使用此邮箱或 ID 的用户。',
    'pilot.exists': '该用户已经是试点用户。',
    'pilot.gone': '该试点用户已被移除。列表已重新加载。',
    'pilot.caption': '该工作区的试点用户',
    'pilot.col.user': '用户',
    'pilot.col.added': '添加日期',
    'pilot.col.actions': '操作',
    'pilot.shown': '已显示的试点用户：{count}',
    'action.removePilot': '移除试点用户',
    'action.removeAria': '移除试点用户 {user}',
    'action.morePilot': '加载更多试点用户',
    'confirm.remove.title': '移除此试点用户？',
    'confirm.remove.body': '{user} 将恢复正常的抽样概率。已在审核队列中的问题保留不变。',
    'confirm.remove.keep': '保留试点用户',
    'pilot.removed': '已移除试点用户。',
    'pilot.empty.title': '没有试点用户',
    'pilot.empty.body': '添加最先试用系统的人员。他们的问题会更频繁地进入审核队列。',
    'import.explain': '从 CSV 或 JSONL 导出文件中导入系统投入使用之前人们提出的问题。导入时会对个人数据脱敏，脱敏后仍疑似包含个人信息的问题会被拒绝。这里只显示计数，文件不会被保留。导入的问题经专家标注后即视为真实问题。',
    'import.file.label': '文件（CSV 或 JSONL）',
    'import.column.label': '问题所在的列',
    'import.column.help': '从文件的第一行读取。',
    'import.chooseFirst': '请先选择要检查的文件。',
    'action.checkFile': '检查文件',
    'action.import': '导入问题',
    'action.reset': '选择其他文件',
    'import.progress': '已处理 {total} 个问题中的 {done} 个',
    'import.barLabel': '导入进度',
    'import.result.check': '检查结果。尚未导入任何内容。',
    'import.result.done': '导入结果',
    'import.count.read': '读取的问题数',
    'import.count.wouldAdd': '将加入审核队列',
    'import.count.added': '已加入审核队列',
    'import.count.duplicates': '队列中已存在',
    'import.count.rejected': '已拒绝：脱敏后仍含个人信息',
    'import.count.truncated': '截短至 2,000 个字符',
    'import.count.empty': '跳过的空行',
    'import.counts.caption': '问题计数',
    'import.col.count': '数量',
    'import.col.language': '语言',
    'import.col.questions': '问题数',
    'import.done': '导入已完成。加入审核队列的问题数：{count}。',
    'import.nothingNew': '没有可导入的新问题：所有问题都已在队列中、已被拒绝或为空。',
    'import.tooLarge': '文件过大（上限：{size}，{rows} 行）。请拆分后依次导入。',
    'import.badFormat': '无法将此文件读取为 CSV 或 JSONL。第 {line} 行无效。请修正文件后重新选择。',
    'import.noColumn': '无法从第一行读取任何列。CSV 文件需要表头行；JSONL 文件每行需要一个对象。',
    'import.interrupted': '导入在处理 {total} 个问题中的 {done} 个后中止。请再次点击“导入问题”：已添加的问题会计为队列中已存在。',
    'import.needs.review': '导入需要开启专家审核。请将 {variable} 设为 true。',
  },
  it: {
    'panel.title': 'Fonti delle domande',
    'panel.description': "Da dove arrivano le domande della coda di revisione oltre alle risposte non riuscite: un campione settimanale di domande reali, gli utenti pilota e le domande passate importate. Per l'area di lavoro selezionata.",
    'panel.tabsLabel': 'Viste delle fonti delle domande',
    'tab.sample': 'Campione settimanale',
    'tab.pilot': 'Utenti pilota',
    'tab.import': 'Importa domande',
    'tab.settings': 'Impostazioni',
    'count.item': '{label}: {value}',
    'sample.loading': 'Caricamento del campione settimanale…',
    'sample.state': 'Campionamento settimanale',
    'sample.last': 'Ultimo campione',
    'sample.added': 'Domande aggiunte alla coda di revisione',
    'sample.source.representative': 'Dal campione settimanale',
    'sample.source.pilot': 'Dagli utenti pilota',
    'sample.source.drift_fill': 'Dai gruppi di argomenti poco coperti',
    'sample.clusters': 'Gruppi di argomenti: {count}, ricalcolati il {date}',
    'sample.clusters.noDate': 'Gruppi di argomenti: {count}',
    'sample.novel': 'Domande in nessun gruppo',
    'sample.byLanguage': 'Per lingua',
    'sample.col.added': 'Domande aggiunte',
    'action.refreshSample': 'Aggiorna campione',
    'action.runSample': 'Esegui campionamento ora',
    'run.running': 'Campionamento in corso…',
    'run.done': 'Campionamento terminato. Domande aggiunte alla coda di revisione: {count}.',
    'run.failed': 'Il campionamento non è terminato. Non è stato aggiunto nulla. Seleziona di nuovo Esegui campionamento ora tra poco.',
    'sample.off.title': 'Il campionamento settimanale è disattivato',
    'sample.off.body': 'Solo le risposte non riuscite arrivano alla coda di revisione. Per aggiungere un campione settimanale di tutte le domande reali, imposta Campionamento settimanale su Attivo in Impostazioni e salva.',
    'sample.needs.log': 'Il campionamento richiede il log di recupero al livello masked_query. Imposta {variable}.',
    'sample.needs.review': 'Il campionamento richiede la revisione degli esperti attiva. Imposta {variable} su true.',
    'sample.empty.title': 'Nessun campione finora',
    'sample.empty.body': 'Il primo campione viene estratto dal job settimanale, oppure ora con Esegui campionamento ora.',
    'settings.sample.label': 'Campionamento settimanale',
    'settings.sample.help': 'Attivo: ogni settimana un campione di tutte le domande reali, distribuito tra gruppi di argomenti, lingue e canali, viene aggiunto alla coda di revisione.',
    'warn.sampleNeedsLog': 'Il campionamento settimanale è attivo ma il log di recupero non è al livello masked_query. Non verrà campionato nulla.',
    'warn.sampleNeedsReview': 'Il campionamento settimanale è attivo ma la revisione degli esperti è disattivata. Non verrà campionato nulla.',
    'pilot.loading': 'Caricamento degli utenti pilota…',
    'pilot.explain': 'Le domande degli utenti pilota vengono campionate {weight} volte più spesso, fino al {share} di ogni campione settimanale. Utile finché il traffico reale è scarso.',
    'pilot.explain.plain': 'Le domande degli utenti pilota vengono campionate più spesso delle altre. Utile finché il traffico reale è scarso.',
    'pilot.field.label': "E-mail o ID dell'utente",
    'action.addPilot': 'Aggiungi utente pilota',
    'pilot.empty.field': 'Inserisci un indirizzo e-mail o un ID utente.',
    'pilot.added': 'Utente pilota aggiunto.',
    'pilot.notFound': "Nessun utente con questa e-mail o questo ID appartiene a quest'area di lavoro.",
    'pilot.exists': 'Questo utente è già un utente pilota.',
    'pilot.gone': "Questo utente pilota era già stato rimosso. L'elenco è stato ricaricato.",
    'pilot.caption': "Utenti pilota di quest'area di lavoro",
    'pilot.col.user': 'Utente',
    'pilot.col.added': 'Aggiunto',
    'pilot.col.actions': 'Azioni',
    'pilot.shown': 'Utenti pilota mostrati: {count}',
    'action.removePilot': 'Rimuovi utente pilota',
    'action.removeAria': 'Rimuovi utente pilota {user}',
    'action.morePilot': 'Carica altri utenti pilota',
    'confirm.remove.title': 'Rimuovere questo utente pilota?',
    'confirm.remove.body': '{user} torna alla normale frequenza di campionamento. Le domande già nella coda di revisione restano.',
    'confirm.remove.keep': 'Mantieni utente pilota',
    'pilot.removed': 'Utente pilota rimosso.',
    'pilot.empty.title': 'Nessun utente pilota',
    'pilot.empty.body': 'Aggiungi le persone che provano il sistema per prime. Le loro domande arrivano più spesso alla coda di revisione.',
    'import.explain': "Importa le domande poste prima che questo sistema fosse in uso, da un'esportazione CSV o JSONL. I dati personali vengono mascherati all'importazione e una domanda che dopo il mascheramento sembra ancora personale viene scartata. Qui si vedono solo i conteggi e il file non viene conservato. Le domande importate contano come reali quando un esperto le etichetta.",
    'import.file.label': 'File (CSV o JSONL)',
    'import.column.label': 'Colonna con la domanda',
    'import.column.help': 'Letta dalla prima riga del file.',
    'import.chooseFirst': 'Scegli un file da controllare.',
    'action.checkFile': 'Controlla file',
    'action.import': 'Importa domande',
    'action.reset': 'Scegli un altro file',
    'import.progress': '{done} di {total} domande',
    'import.barLabel': "Avanzamento dell'importazione",
    'import.result.check': 'Esito del controllo. Nulla è stato ancora importato.',
    'import.result.done': "Esito dell'importazione",
    'import.count.read': 'Domande lette',
    'import.count.wouldAdd': 'Verrebbero aggiunte alla coda di revisione',
    'import.count.added': 'Aggiunte alla coda di revisione',
    'import.count.duplicates': 'Già in coda',
    'import.count.rejected': 'Scartate: ancora personali dopo il mascheramento',
    'import.count.truncated': 'Accorciate a 2.000 caratteri',
    'import.count.empty': 'Righe vuote saltate',
    'import.counts.caption': 'Conteggi delle domande',
    'import.col.count': 'Numero',
    'import.col.language': 'Lingua',
    'import.col.questions': 'Domande',
    'import.done': 'Importazione terminata. Domande aggiunte alla coda di revisione: {count}.',
    'import.nothingNew': 'Niente di nuovo da importare: ogni domanda è già in coda, è stata scartata o è vuota.',
    'import.tooLarge': "Il file è troppo grande (limite: {size}, {rows} righe). Dividilo e importa le parti una dopo l'altra.",
    'import.badFormat': 'Il file non può essere letto come CSV o JSONL. La riga {line} non è valida. Correggi il file e sceglilo di nuovo.',
    'import.noColumn': 'Dalla prima riga non è stato possibile leggere alcuna colonna. Un file CSV richiede una riga di intestazione; un file JSONL un oggetto per riga.',
    'import.interrupted': "L'importazione si è fermata dopo {done} di {total} domande. Seleziona di nuovo Importa domande: quelle già aggiunte risultano come già in coda.",
    'import.needs.review': "L'importazione richiede la revisione degli esperti attiva. Imposta {variable} su true.",
  },
};

function questionSourcesHas(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function questionSourcesSharedLabels() {
  if (typeof GATES_UI_LABELS !== 'undefined') return GATES_UI_LABELS;
  return QUESTION_SOURCES_GATES.GATES_UI_LABELS;
}

/** A message from this panel's table, or from the shared gates-ui table for the keys it holds (workspace.line, updatedAt, value.*). */
function questionSourcesMessage(key, locale, vars) {
  const { gatesUiMessageFrom } = QUESTION_SOURCES_GATES;
  const own = questionSourcesHas(QUESTION_SOURCES_LABELS.en, key);
  return gatesUiMessageFrom(own ? QUESTION_SOURCES_LABELS : questionSourcesSharedLabels(), key, locale, vars);
}

function questionSourcesLabel(key, locale, vars) {
  return questionSourcesMessage(key, locale, vars).text;
}

function questionSourcesCount(value, locale) {
  return QUESTION_SOURCES_GATES.gatesUiNumber(typeof value === 'number' && Number.isFinite(value) ? value : 0, locale);
}

/** "label: number" in the locale's punctuation. */
function questionSourcesCountText(labelKey, value, locale) {
  return questionSourcesLabel('count.item', locale, { label: questionSourcesLabel(labelKey, locale), value: questionSourcesCount(value, locale) });
}

function questionSourcesTrue(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase() === 'true';
}

/** The saved switches this panel depends on: the loaded configuration first, then the page's own inputs. */
function questionSourcesSwitches(config, doc) {
  const c = config && typeof config === 'object' ? config : {};
  const byId = (id) => (doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null);
  const read = (name) => {
    if (questionSourcesHas(c, name)) return c[name];
    const el = byId(name);
    if (!el) return undefined;
    if (el.getAttribute && el.getAttribute('type') === 'checkbox') return el.checked ? 'true' : 'false';
    return el.value;
  };
  return {
    sample: questionSourcesTrue(read('RAG_REPRESENTATIVE_SAMPLE')),
    review: questionSourcesTrue(read('RAG_DOMAIN_EXPERT_REVIEW')),
  };
}

/** Pure: the Weekly sample view from the status route, named fields only (UI-SPEC 8.1, 11 rule 1). */
function questionSourcesSampleView(body, locale) {
  const { gatesUiDate, gatesUiMessageFrom, gatesUiLanguageName } = QUESTION_SOURCES_GATES;
  const b = body && typeof body === 'object' ? body : {};
  const missing = (Array.isArray(b.missing) ? b.missing : []).filter((m) => questionSourcesHas(QUESTION_SOURCES_PREREQUISITES, m));
  if (missing.length > 0) {
    return {
      kind: 'needs',
      needs: missing.map((m) => gatesUiMessageFrom(QUESTION_SOURCES_LABELS, QUESTION_SOURCES_PREREQUISITES[m].key, locale, { variable: QUESTION_SOURCES_PREREQUISITES[m].variable })),
    };
  }
  const last = gatesUiDate(typeof b.last_sample_at === 'string' ? b.last_sample_at : '', locale);
  if (!last) return { kind: 'empty' };
  const bySource = b.by_source && typeof b.by_source === 'object' ? b.by_source : {};
  const clusters = b.clusters && typeof b.clusters === 'object' ? b.clusters : {};
  const refit = gatesUiDate(typeof clusters.refit_at === 'string' ? clusters.refit_at : '', locale);
  const clusterCount = questionSourcesCount(clusters.count, locale);
  const byLanguage = b.by_language && typeof b.by_language === 'object' ? b.by_language : {};
  const languages = Object.keys(byLanguage)
    .filter((code) => typeof byLanguage[code] === 'number' && Number.isFinite(byLanguage[code]))
    .sort((x, y) => byLanguage[y] - byLanguage[x] || (x < y ? -1 : 1))
    .map((code) => ({ code, name: gatesUiLanguageName(code, locale), count: questionSourcesCount(byLanguage[code], locale) }));
  return {
    kind: 'populated',
    last,
    added: questionSourcesCountText('sample.added', b.added, locale),
    sources: QUESTION_SOURCES_SOURCES.map((s) => questionSourcesCountText('sample.source.' + s, bySource[s], locale)),
    clusters: refit
      ? gatesUiMessageFrom(QUESTION_SOURCES_LABELS, 'sample.clusters', locale, { count: clusterCount, date: { time: refit } })
      : gatesUiMessageFrom(QUESTION_SOURCES_LABELS, 'sample.clusters.noDate', locale, { count: clusterCount }),
    novel: questionSourcesCountText('sample.novel', clusters.novel, locale),
    languages,
  };
}

/** Pure: the Pilot users view, named fields only: the masked e-mail the route returns, else the user id in code (UI-SPEC 11 rule 7). */
function questionSourcesPilotView(body, locale) {
  const { gatesUiDate, gatesUiNumber, gatesUiPercent } = QUESTION_SOURCES_GATES;
  const b = body && typeof body === 'object' ? body : {};
  const rows = (Array.isArray(b.users) ? b.users : [])
    .filter((u) => u && typeof u === 'object' && typeof u.user_id === 'string')
    .map((u) => {
      const masked = typeof u.masked_email === 'string' && u.masked_email !== '' ? u.masked_email : null;
      return { userId: u.user_id, label: masked || u.user_id, mono: !masked, added: gatesUiDate(typeof u.added_at === 'string' ? u.added_at : '', locale) };
    });
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const explain =
    finite(b.weight) && finite(b.cap_share)
      ? questionSourcesLabel('pilot.explain', locale, { weight: gatesUiNumber(b.weight, locale), share: gatesUiPercent(b.cap_share, locale) })
      : questionSourcesLabel('pilot.explain.plain', locale);
  return { rows, explain };
}

/** Pure: the combination notes of UI-SPEC 6.12 for the sample group, read from the page's own inputs. */
function questionSourcesSettingsWarnings(values) {
  const v = values || {};
  if (!questionSourcesTrue(v.sample)) return [];
  const out = [];
  if (v.log !== undefined && v.log !== 'masked_query') out.push('warn.sampleNeedsLog');
  if (v.review !== undefined && !questionSourcesTrue(v.review)) out.push('warn.sampleNeedsReview');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Import file handling (UI-SPEC 6.10.3): pure, in the browser only. Rows are never rendered, logged or stored; errors name a line number.

function questionSourcesUtf8Length(value) {
  const str = String(value);
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(str).length;
  let bytes = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function questionSourcesStripBom(text) {
  const value = String(text === undefined || text === null ? '' : text);
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** RFC 4180 records with the physical line each starts on (the route's csvRecords). An unclosed quote is { ok: false, line }. */
function questionSourcesCsvRecords(text, maxRecords) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let quoteLine = 1;
  let line = 1;
  let recordLine = 1;
  const push = () => {
    record.push(field);
    if (!(record.length === 1 && record[0] === '')) records.push({ cells: record, line: recordLine });
    record = [];
    field = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      quoteLine = line;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      push();
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      line += 1;
      recordLine = line;
      if (maxRecords && records.length > maxRecords) return { ok: true, records, truncated: true };
    } else field += char;
  }
  if (quoted) return { ok: false, line: quoteLine };
  if (field !== '' || record.length > 0) push();
  return { ok: true, records, truncated: false };
}

function questionSourcesJsonObject(line) {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The file's format: its extension or type first, then its first character ({ means JSON lines). */
function questionSourcesFileFormat(name, type, text) {
  const lower = String(name || '').toLowerCase();
  if (/\.(jsonl|ndjson)$/.test(lower) || /ndjson|jsonl/.test(String(type || ''))) return 'jsonl';
  if (/\.csv$/.test(lower) || /csv/.test(String(type || ''))) return 'csv';
  return questionSourcesStripBom(text).trimStart().startsWith('{') ? 'jsonl' : 'csv';
}

/** The CSV header cells (trimmed) or the keys of the first JSON line; [] when the first line holds no column. */
function questionSourcesReadHeader(text, format) {
  const body = questionSourcesStripBom(text);
  if (format === 'jsonl') {
    const first = body.split(/\r?\n/).find((l) => l.trim() !== '');
    const obj = first === undefined ? null : questionSourcesJsonObject(first);
    return obj ? Object.keys(obj) : [];
  }
  const parsed = questionSourcesCsvRecords(body, 1);
  if (!parsed.ok || parsed.records.length === 0) return [];
  const header = parsed.records[0].cells.map((c) => c.trim());
  return header.some((h) => h !== '') ? header : [];
}

/**
 * Pure: the whole file read once. { ok: true, format, columns, rows } or { ok: false, reason: 'badFormat' | 'noColumn' | 'tooLarge', line }.
 * More than maxRows data rows is tooLarge; a malformed JSON line or an unclosed CSV quote is badFormat with its line number.
 */
function questionSourcesParseFile(text, format) {
  const body = questionSourcesStripBom(text);
  const max = QUESTION_SOURCES_LIMITS.maxRows;
  if (format === 'jsonl') {
    const lines = body.split(/\r?\n/);
    const entries = [];
    lines.forEach((l, i) => {
      if (l.trim() !== '') entries.push({ text: l, line: i + 1 });
    });
    const columns = entries.length > 0 ? questionSourcesReadHeader(entries[0].text, 'jsonl') : [];
    if (columns.length === 0) return { ok: false, reason: 'noColumn', line: entries.length > 0 ? entries[0].line : 1 };
    if (entries.length > max) return { ok: false, reason: 'tooLarge' };
    const rows = [];
    for (const entry of entries) {
      const obj = questionSourcesJsonObject(entry.text);
      if (!obj) return { ok: false, reason: 'badFormat', line: entry.line };
      rows.push(obj);
    }
    return { ok: true, format: 'jsonl', columns, rows };
  }
  const parsed = questionSourcesCsvRecords(body, max + 1);
  if (!parsed.ok) return { ok: false, reason: 'badFormat', line: parsed.line };
  if (parsed.records.length === 0) return { ok: false, reason: 'noColumn', line: 1 };
  const columns = parsed.records[0].cells.map((c) => c.trim());
  if (!columns.some((c) => c !== '')) return { ok: false, reason: 'noColumn', line: parsed.records[0].line };
  if (parsed.truncated || parsed.records.length - 1 > max) return { ok: false, reason: 'tooLarge' };
  return { ok: true, format: 'csv', columns, rows: parsed.records.slice(1).map((r) => r.cells) };
}

/** Pure: the question of each row from one column; a missing or non-text value is an empty row (counted by the server). */
function questionSourcesExtract(parsed, columnIndex) {
  if (!parsed || !parsed.ok) return [];
  const name = parsed.columns[columnIndex];
  const cap = QUESTION_SOURCES_LIMITS.maxQuestionChars;
  return parsed.rows.map((row) => {
    const value = parsed.format === 'jsonl' ? (row && typeof row[name] === 'string' ? row[name] : '') : typeof row[columnIndex] === 'string' ? row[columnIndex] : '';
    const chars = Array.from(value);
    return chars.length > cap ? chars.slice(0, cap).join('') : value;
  });
}

/**
 * Splits questions into batches whose JSON body ({ ...envelope, rows }) stays at or under maxBytes, at most 2,000 rows each, every
 * question once and in order. Without an envelope, room for the largest request fields is reserved.
 */
function questionSourcesBatches(questions, maxBytes, envelope) {
  const list = Array.isArray(questions) ? questions : [];
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : QUESTION_SOURCES_LIMITS.maxBatchBytes;
  const base = envelope && typeof envelope === 'object' ? questionSourcesUtf8Length(JSON.stringify({ ...envelope, rows: [] })) : 1024;
  const batches = [];
  let current = [];
  let size = base;
  for (const question of list) {
    const cost = questionSourcesUtf8Length(JSON.stringify(String(question))) + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && (size + cost > limit || current.length >= QUESTION_SOURCES_LIMITS.maxBatchRows)) {
      batches.push(current);
      current = [];
      size = base;
    }
    size += questionSourcesUtf8Length(JSON.stringify(String(question))) + (current.length > 0 ? 1 : 0);
    current.push(question);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const QUESTION_SOURCES_COUNT_FIELDS = ['read', 'added', 'duplicates', 'rejected_pii', 'truncated', 'empty'];

function questionSourcesEmptyCounts() {
  return { read: 0, added: 0, duplicates: 0, rejected_pii: 0, truncated: 0, empty: 0, by_language: {} };
}

/** Pure: adds one batch answer to the running sums (named fields only). */
function questionSourcesAddCounts(sums, body) {
  const out = { ...sums, by_language: { ...sums.by_language } };
  const b = body && typeof body === 'object' ? body : {};
  for (const field of QUESTION_SOURCES_COUNT_FIELDS) if (typeof b[field] === 'number' && Number.isFinite(b[field])) out[field] += b[field];
  const langs = b.by_language && typeof b.by_language === 'object' ? b.by_language : {};
  for (const code of Object.keys(langs)) if (typeof langs[code] === 'number' && Number.isFinite(langs[code])) out.by_language[code] = (out.by_language[code] || 0) + langs[code];
  return out;
}

/** Shows or hides an element: the hidden attribute alone loses to a display class such as flex, so the page's .hidden class is set too. */
function questionSourcesShow(el, shown) {
  if (!el) return;
  el.hidden = !shown;
  el.classList.toggle('hidden', !shown);
}

const QUESTION_SOURCES_PANEL_STATUS =
  typeof ragPanelSetStatus === 'function'
    ? ragPanelSetStatus
    : typeof require !== 'undefined'
      ? require('./panel-status.js').ragPanelSetStatus
      : null;

class QuestionSourcesPanel {
  constructor(root, deps) {
    const d = deps || {};
    this.root = root;
    this.locale = QUESTION_SOURCES_GATES.gatesUiLocale(d.locale);
    this.fetcher = d.fetcher || null;
    this.appUrl = d.appUrl || null;
    this.configSource = typeof d.config === 'function' ? d.config : null;
    this.mounted = false;
    this.current = 'sample';
    this.organizationId = null;
    this.views = {};
    this.loadedFor = {};
    this.sample = { data: null, loading: false, running: false, seq: 0 };
    this.hosts = {
      title: root.querySelector('[data-question-sources-title]'),
      description: root.querySelector('[data-question-sources-description]'),
      workspace: root.querySelector('[data-question-sources-workspace]'),
      alert: root.querySelector('[data-question-sources-alert]'),
      content: root.querySelector('[data-question-sources-content]'),
      status: root.querySelector('[data-question-sources-status]'),
    };
  }

  t(key, vars) {
    return questionSourcesLabel(key, this.locale, vars);
  }

  m(key, vars) {
    return questionSourcesMessage(key, this.locale, vars);
  }

  el(tag, opts, children) {
    return QUESTION_SOURCES_GATES.gatesUiEl(tag, opts, children);
  }

  config() {
    if (this.configSource) return this.configSource() || {};
    if (typeof window !== 'undefined' && window.configManager && window.configManager.savedConfig) return window.configManager.savedConfig;
    return null;
  }

  switches() {
    return questionSourcesSwitches(this.config(), document);
  }

  setStatus(message, isError, options) {
    const render = () => {
      QUESTION_SOURCES_GATES.gatesUiStatus(this.hosts.status, message, isError);
    };
    if (QUESTION_SOURCES_PANEL_STATUS) QUESTION_SOURCES_PANEL_STATUS(this.hosts.status, render, isError, options);
    else render();
  }

  query(extra) {
    const params = new URLSearchParams();
    if (this.organizationId) params.set('organizationId', this.organizationId);
    for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    const qs = params.toString();
    return qs ? '?' + qs : '';
  }

  request(path, init, timeoutMs) {
    return QUESTION_SOURCES_GATES.gatesUiFetch(path, init || { method: 'GET' }, { fetcher: this.fetcher || undefined, timeoutMs });
  }

  mapError(result, viewKey, switchedOn) {
    return QUESTION_SOURCES_GATES.gatesUiMapError(result, this.locale, { view: this.t(viewKey), switchedOn, appUrl: this.appUrl });
  }

  async mount() {
    if (!this.mounted) {
      this.mounted = true;
      this.root.setAttribute('lang', this.locale);
      if (this.hosts.title) this.hosts.title.textContent = this.t('panel.title');
      if (this.hosts.description) this.hosts.description.textContent = this.t('panel.description');
      if (this.hosts.status) this.hosts.status.setAttribute('tabindex', '-1');
      this.bindWorkspace();
      this.buildChrome();
      this.mountSettings();
    }
    return this.refresh();
  }

  bindWorkspace() {
    const selector = document.getElementById('workspace-selector');
    this.organizationId = selector && selector.value ? selector.value : null;
    this.renderWorkspace();
    if (!selector) return;
    selector.addEventListener('change', () => {
      this.organizationId = selector.value || null;
      this.renderWorkspace();
      this.loadedFor = {};
      this.onWorkspaceChange();
      this.refresh();
    });
  }

  workspaceName() {
    const selector = document.getElementById('workspace-selector');
    if (!selector || !this.organizationId) return null;
    const option = Array.from(selector.querySelectorAll('option')).find((o) => o.getAttribute('value') === this.organizationId);
    const name = option ? String(option.textContent || '').replace(/^[^\p{L}\p{N}]+/u, '').trim() : '';
    return name || null;
  }

  renderWorkspace() {
    const host = this.hosts.workspace;
    if (!host) return;
    host.replaceChildren();
    const name = this.workspaceName();
    if (name) host.textContent = this.t('workspace.line', { name });
  }

  onWorkspaceChange() {}

  buildChrome() {
    const content = this.hosts.content;
    if (!content) return;
    const tabs = QUESTION_SOURCES_GATES.gatesUiSubTabs({
      label: this.t('panel.tabsLabel'),
      idPrefix: 'rag-question-sources',
      tabs: QUESTION_SOURCES_TABS.map((id) => ({ id, label: this.t('tab.' + id) })),
      selected: this.current,
      onSelect: (id) => {
        this.current = id;
        this.setStatus('');
        this.refresh();
      },
    });
    this.tabs = tabs;
    // DaisyUI tabs are a grid, so the shared flex-wrap does not apply; as flex they wrap at 360px instead of scrolling the page sideways.
    tabs.root.classList.add('flex');
    tabs.tabs.forEach((tab, i) => {
      tab.setAttribute('data-question-sources-tab', QUESTION_SOURCES_TABS[i]);
      tab.classList.add('h-auto', 'min-h-8', 'whitespace-nowrap');
    });
    tabs.panels.forEach((panel, i) => {
      const id = QUESTION_SOURCES_TABS[i];
      panel.setAttribute('data-question-sources-view', id);
      this.views[id] = panel;
    });
    content.replaceChildren(tabs.root, ...tabs.panels);
    this.buildSampleView();
    this.buildPilotView();
    this.buildImportView();
  }

  async selectTab(id) {
    if (!this.tabs || !QUESTION_SOURCES_TABS.includes(id)) return;
    if (id === this.current) return this.refresh();
    this.tabs.select(id);
  }

  /** Loads the current view (each data view once per workspace; later calls refresh it). The Settings view makes no request. */
  async refresh() {
    if (this.current === 'sample') return this.loadSample();
    if (this.current === 'pilot') return this.loadPilot();
    if (this.current === 'import') return this.renderImportGate();
    return this.renderSettingsWarnings();
  }

  // -------------------------------------------------------------------------------------------------------------------------------------
  // Weekly sample (UI-SPEC 6.10.1)

  buildSampleView() {
    const view = this.views.sample;
    const { gatesUiIcon } = QUESTION_SOURCES_GATES;
    this.sampleUpdated = this.el('span', { className: 'text-xs text-base-content/70' });
    this.sampleRefresh = this.el('button', { className: 'btn btn-outline btn-sm', attrs: { type: 'button' }, on: { click: () => this.loadSample() } }, [
      gatesUiIcon('bi-arrow-clockwise'),
      this.t('action.refreshSample'),
    ]);
    this.sampleRun = this.el('button', { className: 'btn btn-outline btn-sm', attrs: { type: 'button' }, on: { click: () => this.runSample() } }, [this.t('action.runSample')]);
    this.sampleToolbar = this.el('div', { className: 'flex flex-wrap items-center justify-end gap-2 mb-4' }, [this.sampleUpdated, this.sampleRefresh, this.sampleRun]);
    this.sampleAlert = this.el('div', { className: 'mb-4 empty:mb-0' });
    this.sampleBody = this.el('div', { className: 'flex flex-col gap-6 min-w-0' });
    view.replaceChildren(this.sampleAlert, this.sampleToolbar, this.sampleBody);
  }

  /** The toolbar is left out with the switch off or a sign-in alert; Run sample now is left out while a prerequisite is missing. */
  sampleToolbarShown(shown, withRun) {
    const view = this.views.sample;
    if (!shown) {
      this.sampleToolbar.remove();
      return;
    }
    const children = [this.sampleUpdated, this.sampleRefresh];
    if (withRun !== false) children.push(this.sampleRun);
    this.sampleToolbar.replaceChildren(...children);
    if (this.sampleToolbar.parentNode !== view) view.insertBefore(this.sampleToolbar, this.sampleBody);
  }

  sampleSetBusy(busy) {
    const { gatesUiSetBusy, gatesUiSpinner, gatesUiIcon, gatesUiLoadingBlock } = QUESTION_SOURCES_GATES;
    this.sample.loading = busy;
    const hasContent = Boolean(this.sample.data);
    gatesUiSetBusy(this.sampleBody, busy && hasContent);
    this.sampleRefresh.disabled = busy;
    this.sampleRefresh.replaceChildren(busy ? gatesUiSpinner() : gatesUiIcon('bi-arrow-clockwise'), this.t('action.refreshSample'));
    if (busy && !hasContent) {
      this.sampleBody.replaceChildren(gatesUiLoadingBlock(this.t('sample.loading')));
      this.setStatus(this.t('sample.loading'));
    }
  }

  renderSampleOff() {
    const { gatesUiEmptyBlock } = QUESTION_SOURCES_GATES;
    this.sample.data = null;
    this.sampleAlert.replaceChildren();
    this.sampleToolbarShown(false);
    this.sampleBody.replaceChildren(gatesUiEmptyBlock(this.t('sample.off.title'), this.t('sample.off.body')));
  }

  async loadSample() {
    if (!this.sampleBody || this.sample.loading || this.sample.running) return;
    if (!this.switches().sample) {
      this.renderSampleOff();
      return;
    }
    this.sampleToolbarShown(true, Boolean(this.sample.data) && this.sampleRunAllowed);
    const seq = (this.sample.seq += 1);
    this.sampleSetBusy(true);
    const result = await this.request(QUESTION_SOURCES_SAMPLE_API + this.query(), { method: 'GET' });
    this.sampleSetBusy(false);
    if (seq !== this.sample.seq) return;
    if (!result.ok) return this.sampleFailed(result);
    this.loadedFor.sample = this.organizationId;
    this.sampleAlert.replaceChildren();
    this.sample.data = result.body && typeof result.body === 'object' ? result.body : {};
    this.sample.updatedAt = new Date();
    this.renderSample();
    const view = questionSourcesSampleView(this.sample.data, this.locale);
    this.setStatus(view.kind === 'populated' ? view.added : view.kind === 'needs' ? view.needs[0] : this.t('sample.empty.title'));
  }

  sampleFailed(result) {
    const { gatesUiErrorAlert, gatesUiSetBusy } = QUESTION_SOURCES_GATES;
    const mapped = this.mapError(result, 'tab.sample', true);
    this.sampleAlert.replaceChildren(gatesUiErrorAlert(mapped, this.locale, () => this.loadSample()));
    if (mapped.kind === 'signIn' || mapped.kind === 'switchedOff') {
      this.sample.data = null;
      this.sampleToolbarShown(false);
      this.sampleBody.replaceChildren();
    } else if (this.sample.data) gatesUiSetBusy(this.sampleBody, true);
    else this.sampleBody.replaceChildren();
    this.setStatus(mapped, true);
  }

  renderSample() {
    const { gatesUiDate, gatesUiAppendMessage, gatesUiMessageEl, gatesUiEmptyBlock, gatesUiSetBusy, gatesUiAlert } = QUESTION_SOURCES_GATES;
    this.sampleUpdated.replaceChildren();
    const time = this.sample.updatedAt ? gatesUiDate(this.sample.updatedAt.toISOString(), this.locale, 'time') : null;
    if (time) gatesUiAppendMessage(this.sampleUpdated, this.m('updatedAt', { time: { time } }));
    gatesUiSetBusy(this.sampleBody, false);
    const view = questionSourcesSampleView(this.sample.data, this.locale);
    this.sampleRunAllowed = view.kind !== 'needs';
    this.sampleToolbarShown(true, this.sampleRunAllowed);
    const stateLine = this.el('p', { className: 'text-sm', text: this.t('count.item', { label: this.t('sample.state'), value: this.t('value.on') }) });
    if (view.kind === 'needs') {
      this.sampleBody.replaceChildren(stateLine, ...view.needs.map((message) => gatesUiAlert('warning', 'bi-exclamation-triangle', message, [])));
      return;
    }
    if (view.kind === 'empty') {
      this.sampleBody.replaceChildren(stateLine, gatesUiEmptyBlock(this.t('sample.empty.title'), this.t('sample.empty.body')));
      return;
    }
    const item = (child, extra) => this.el('li', { className: 'text-sm tabular-nums break-words' + (extra ? ' ' + extra : '') }, [child]);
    const last = this.el('span', null, [
      this.t('count.item', { label: this.t('sample.last'), value: '' }),
      this.el('time', { text: view.last.text, attrs: { datetime: view.last.iso } }),
    ]);
    const list = this.el('ul', { className: 'grid gap-2 sm:grid-cols-2 max-w-3xl' }, [
      item(last),
      item(this.el('span', { text: view.added }), 'font-semibold'),
      ...view.sources.map((s) => item(this.el('span', { text: s }))),
      item(gatesUiMessageEl('span', '', view.clusters)),
      item(this.el('span', { text: view.novel })),
    ]);
    const nodes = [stateLine, list];
    if (view.languages.length > 0) nodes.push(this.languageTable(view.languages, this.t('sample.byLanguage'), this.t('sample.col.added')));
    this.sampleBody.replaceChildren(...nodes);
  }

  /** The by-language block: an h4 and a small table (Language | count). */
  languageTable(rows, title, countLabel) {
    const head = this.el('tr', null, [
      this.el('th', { className: 'text-xs font-semibold', text: this.t('import.col.language'), attrs: { scope: 'col' } }),
      this.el('th', { className: 'text-xs font-semibold text-right', text: countLabel, attrs: { scope: 'col' } }),
    ]);
    const body = this.el('tbody');
    for (const row of rows) {
      body.appendChild(
        this.el('tr', null, [
          this.el('th', { className: 'font-normal text-sm', text: row.name, attrs: { scope: 'row' } }),
          this.el('td', { className: 'text-sm text-right tabular-nums', text: row.count }),
        ]),
      );
    }
    const region = this.el(
      'div',
      {
        className: 'overflow-x-auto rounded-lg max-w-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': title },
      },
      [this.el('table', { className: 'table table-sm' }, [this.el('caption', { className: 'sr-only', text: title }), this.el('thead', null, [head]), body])],
    );
    return this.el('div', { className: 'flex flex-col gap-2 min-w-0' }, [this.el('h4', { className: 'text-base font-semibold text-balance', text: title }), region]);
  }

  async runSample() {
    if (this.sample.running || this.sample.loading) return;
    const { gatesUiSpinner } = QUESTION_SOURCES_GATES;
    this.sample.running = true;
    this.sampleRun.disabled = true;
    this.sampleRefresh.disabled = true;
    this.sampleRun.replaceChildren(gatesUiSpinner(), this.t('run.running'));
    this.setStatus(this.t('run.running'));
    const result = await this.request(QUESTION_SOURCES_SAMPLE_API + this.query(), { method: 'POST', body: JSON.stringify({}) });
    this.sample.running = false;
    this.sampleRun.disabled = false;
    this.sampleRefresh.disabled = false;
    this.sampleRun.replaceChildren(this.t('action.runSample'));
    if (!result.ok) {
      const mapped = this.mapError(result, 'tab.sample', true);
      if (mapped.kind === 'signIn' || mapped.kind === 'switchedOff') return this.sampleFailed(result);
      this.setStatus(this.m('run.failed'), true);
      return;
    }
    this.sample.data = result.body && typeof result.body === 'object' ? result.body : {};
    this.sample.updatedAt = new Date();
    this.renderSample();
    const run = this.sample.data.run && typeof this.sample.data.run === 'object' ? this.sample.data.run : {};
    if (run.written === false) {
      const view = questionSourcesSampleView({ missing: run.missing }, this.locale);
      if (view.kind === 'needs') {
        this.setStatus(view.needs[0], true);
        return;
      }
    }
    this.setStatus(this.t('run.done', { count: questionSourcesCount(run.added, this.locale) }), false, { toast: true });
  }

  // -------------------------------------------------------------------------------------------------------------------------------------
  // Pilot users (UI-SPEC 6.10.2)

  buildPilotView() {
    const view = this.views.pilot;
    const inputId = 'rag-question-sources-pilot-user';
    const helpId = 'rag-question-sources-pilot-help';
    this.pilot = { users: [], next: null, loading: false, adding: false, data: false, weight: null, cap: null, seq: 0 };
    this.pilotAlert = this.el('div', { className: 'mb-4 empty:mb-0' });
    this.pilotExplain = this.el('p', { className: 'text-sm max-w-prose mb-4', text: this.t('pilot.explain.plain') });
    this.pilotInput = this.el('input', {
      className: 'input input-bordered input-sm w-full sm:w-80 min-w-0',
      attrs: { type: 'text', id: inputId, name: 'pilot-user', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': helpId },
      on: { input: () => this.pilotFieldMessage(null) },
    });
    this.pilotAdd = this.el('button', { className: 'btn btn-primary btn-sm', attrs: { type: 'submit' } }, [this.t('action.addPilot')]);
    this.pilotHelp = this.el('p', { className: 'text-xs mt-1 min-h-4 empty:min-h-0', attrs: { id: helpId, 'data-question-sources-pilot-help': '' } });
    this.pilotForm = this.el(
      'form',
      { className: 'form-control mb-6 max-w-xl', attrs: { novalidate: true }, on: { submit: (event) => this.addPilot(event) } },
      [
        this.el('label', { className: 'label', attrs: { for: inputId } }, [this.el('span', { className: 'label-text', text: this.t('pilot.field.label') })]),
        this.el('div', { className: 'flex flex-wrap items-center gap-2' }, [this.pilotInput, this.pilotAdd]),
        this.pilotHelp,
      ],
    );
    this.pilotBody = this.el('div', { className: 'flex flex-col gap-4 min-w-0' });
    view.replaceChildren(this.pilotAlert, this.pilotExplain, this.pilotForm, this.pilotBody);
  }

  pilotFieldMessage(key) {
    this.pilotHelp.textContent = key ? this.t(key) : '';
    this.pilotHelp.classList.toggle('text-error', Boolean(key));
    if (key) {
      this.pilotInput.setAttribute('aria-invalid', 'true');
      this.pilotInput.classList.add('input-error');
    } else {
      this.pilotInput.removeAttribute('aria-invalid');
      this.pilotInput.classList.remove('input-error');
    }
  }

  async loadPilot(cursor) {
    if (!this.pilotBody || this.pilot.loading) return;
    const { gatesUiLoadingBlock, gatesUiSetBusy, gatesUiErrorAlert, gatesUiSpinner } = QUESTION_SOURCES_GATES;
    const seq = (this.pilot.seq += 1);
    this.pilot.loading = true;
    if (cursor && this.pilotMore) {
      this.pilotMore.disabled = true;
      this.pilotMore.replaceChildren(gatesUiSpinner(), this.t('action.morePilot'));
    } else if (this.pilot.data) gatesUiSetBusy(this.pilotBody, true);
    else {
      this.pilotBody.replaceChildren(gatesUiLoadingBlock(this.t('pilot.loading')));
      this.setStatus(this.t('pilot.loading'));
    }
    const result = await this.request(QUESTION_SOURCES_PILOT_API + this.query(cursor ? { cursor } : null), { method: 'GET' });
    this.pilot.loading = false;
    gatesUiSetBusy(this.pilotBody, false);
    if (seq !== this.pilot.seq) return;
    if (!result.ok) {
      const mapped = this.mapError(result, 'tab.pilot');
      this.pilotAlert.replaceChildren(gatesUiErrorAlert(mapped, this.locale, () => this.loadPilot()));
      const signIn = mapped.kind === 'signIn';
      questionSourcesShow(this.pilotForm, !signIn);
      questionSourcesShow(this.pilotExplain, !signIn);
      if (signIn || !this.pilot.data) {
        this.pilot.data = false;
        this.pilotBody.replaceChildren();
      } else {
        this.renderPilot();
        gatesUiSetBusy(this.pilotBody, true);
      }
      this.setStatus(mapped, true);
      return;
    }
    this.pilotAlert.replaceChildren();
    questionSourcesShow(this.pilotForm, true);
    questionSourcesShow(this.pilotExplain, true);
    const body = result.body && typeof result.body === 'object' ? result.body : {};
    const users = (Array.isArray(body.users) ? body.users : []).filter((u) => u && typeof u === 'object' && typeof u.user_id === 'string');
    this.pilot.users = cursor ? this.pilot.users.concat(users) : users;
    this.pilot.next = typeof body.next_cursor === 'string' && body.next_cursor !== '' ? body.next_cursor : null;
    this.pilot.weight = typeof body.weight === 'number' && Number.isFinite(body.weight) ? body.weight : null;
    this.pilot.cap = typeof body.cap_share === 'number' && Number.isFinite(body.cap_share) ? body.cap_share : null;
    this.pilot.data = true;
    this.loadedFor.pilot = this.organizationId;
    this.renderPilot();
    this.setStatus(this.t('pilot.shown', { count: questionSourcesCount(this.pilot.users.length, this.locale) }));
  }

  renderPilot() {
    const { gatesUiEmptyBlock } = QUESTION_SOURCES_GATES;
    const view = questionSourcesPilotView({ users: this.pilot.users, weight: this.pilot.weight, cap_share: this.pilot.cap }, this.locale);
    this.pilotExplain.textContent = view.explain;
    if (view.rows.length === 0) {
      this.pilotMore = null;
      this.pilotBody.replaceChildren(gatesUiEmptyBlock(this.t('pilot.empty.title'), this.t('pilot.empty.body')));
      return;
    }
    const caption = this.t('pilot.caption');
    const col = (key, cls) => this.el('th', { className: 'text-xs font-semibold' + (cls ? ' ' + cls : ''), text: this.t(key), attrs: { scope: 'col' } });
    const body = this.el('tbody');
    view.rows.forEach((row) => {
      const user = row.mono
        ? this.el('code', { className: 'font-mono text-xs break-all', text: row.label, attrs: { translate: 'no' } })
        : this.el('span', { className: 'break-all', text: row.label, attrs: { translate: 'no' } });
      const remove = this.el('button', {
        className: 'btn btn-outline md:btn-sm',
        text: this.t('action.removePilot'),
        attrs: { type: 'button', 'aria-label': this.t('action.removeAria', { user: row.label }), 'data-question-sources-user': row.userId },
      });
      remove.addEventListener('click', () => this.removePilot(row, remove));
      body.appendChild(
        this.el('tr', null, [
          this.el('th', { className: 'font-normal text-sm align-middle min-w-0', attrs: { scope: 'row' } }, [user]),
          this.el('td', { className: 'text-sm align-middle whitespace-nowrap' }, row.added ? [this.el('time', { text: row.added.text, attrs: { datetime: row.added.iso } })] : ['—']),
          this.el('td', { className: 'align-middle' }, [remove]),
        ]),
      );
    });
    const region = this.el(
      'div',
      {
        className: 'overflow-x-auto rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': caption },
      },
      [
        this.el('table', { className: 'table table-sm' }, [
          this.el('caption', { className: 'sr-only', text: caption }),
          this.el('thead', null, [this.el('tr', null, [col('pilot.col.user'), col('pilot.col.added'), col('pilot.col.actions')])]),
          body,
        ]),
      ],
    );
    const nodes = [region];
    this.pilotMore = null;
    if (this.pilot.next) {
      const next = this.pilot.next;
      this.pilotMore = this.el('button', { className: 'btn btn-outline btn-sm self-start', text: this.t('action.morePilot'), attrs: { type: 'button' }, on: { click: () => this.loadPilot(next) } });
      nodes.push(this.pilotMore);
    }
    this.pilotBody.replaceChildren(...nodes);
  }

  async addPilot(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (this.pilot.adding) return;
    const { gatesUiSpinner, gatesUiErrorAlert } = QUESTION_SOURCES_GATES;
    const value = String(this.pilotInput.value || '').trim();
    if (value === '') {
      this.pilotFieldMessage('pilot.empty.field');
      this.pilotInput.focus();
      return;
    }
    this.pilot.adding = true;
    this.pilotAdd.disabled = true;
    this.pilotAdd.replaceChildren(gatesUiSpinner(), this.t('action.addPilot'));
    const result = await this.request(QUESTION_SOURCES_PILOT_API + this.query(), { method: 'POST', body: JSON.stringify({ user: value }) });
    this.pilot.adding = false;
    this.pilotAdd.disabled = false;
    this.pilotAdd.replaceChildren(this.t('action.addPilot'));
    const code = result && result.body && typeof result.body === 'object' ? result.body.error : null;
    if (result.ok) {
      this.pilotInput.value = '';
      this.pilotFieldMessage(null);
      await this.loadPilot();
      this.setStatus(this.t('pilot.added'), false, { toast: true });
      this.pilotInput.focus();
      return;
    }
    if (result.status === 404 && (code === 'user_not_found' || !code)) this.pilotFieldMessage('pilot.notFound');
    else if (result.status === 409) this.pilotFieldMessage('pilot.exists');
    else {
      const mapped = this.mapError(result, 'tab.pilot');
      this.pilotAlert.replaceChildren(gatesUiErrorAlert(mapped, this.locale, () => this.loadPilot()));
      this.setStatus(mapped, true);
    }
    this.pilotInput.focus();
  }

  async removePilot(row, button) {
    const { gatesUiConfirm, gatesUiSpinner, gatesUiErrorAlert } = QUESTION_SOURCES_GATES;
    const confirmed = await gatesUiConfirm({
      title: this.t('confirm.remove.title'),
      body: this.m('confirm.remove.body', { user: row.label }),
      keepLabel: this.t('confirm.remove.keep'),
      confirmLabel: this.t('action.removePilot'),
      opener: button,
      fallbackFocus: this.pilotInput,
      locale: this.locale,
    });
    if (!confirmed) return;
    const index = this.pilot.users.findIndex((u) => u.user_id === row.userId);
    button.disabled = true;
    button.replaceChildren(gatesUiSpinner(), this.t('action.removePilot'));
    const result = await this.request(QUESTION_SOURCES_PILOT_API + this.query({ user_id: row.userId }), { method: 'DELETE' });
    if (result.ok) {
      this.pilot.users = this.pilot.users.filter((u) => u.user_id !== row.userId);
      this.renderPilot();
      this.setStatus(this.t('pilot.removed'), false, { toast: true });
      const buttons = this.pilotBody.querySelectorAll('tbody button');
      const next = buttons[Math.min(Math.max(index, 0), buttons.length - 1)];
      (next || this.pilotInput).focus();
      return;
    }
    if (result.status === 404) {
      await this.loadPilot();
      this.setStatus(this.t('pilot.gone'), false, { toast: true });
      this.pilotInput.focus();
      return;
    }
    button.disabled = false;
    button.replaceChildren(this.t('action.removePilot'));
    const mapped = this.mapError(result, 'tab.pilot');
    this.pilotAlert.replaceChildren(gatesUiErrorAlert(mapped, this.locale, () => this.loadPilot()));
    this.setStatus(mapped, true);
  }

  // -------------------------------------------------------------------------------------------------------------------------------------
  // Import questions (UI-SPEC 6.10.3)

  buildImportView() {
    const view = this.views.import;
    const fileId = 'rag-question-sources-file';
    const columnId = 'rag-question-sources-column';
    const ids = { fileMessage: 'rag-question-sources-file-message', columnHelp: 'rag-question-sources-column-help', chooseFirst: 'rag-question-sources-choose-first' };
    this.imp = { parsed: null, running: false, sums: null, checkedKey: null, phase: 'idle' };
    this.importNeeds = this.el('div', { className: 'min-w-0' });
    this.importFile = this.el('input', {
      className: 'file-input file-input-bordered file-input-sm w-full max-w-md',
      attrs: { type: 'file', id: fileId, name: 'question-file', accept: '.csv,.jsonl,text/csv,application/x-ndjson', 'aria-describedby': ids.fileMessage },
      on: { change: () => this.onImportFile() },
    });
    this.importFileMessage = this.el('p', { className: 'text-xs mt-1 empty:hidden max-w-prose', attrs: { id: ids.fileMessage, 'data-question-sources-file-message': '' } });
    this.importColumn = this.el('select', {
      className: 'select select-bordered select-sm w-full max-w-md',
      attrs: { id: columnId, name: 'question-column', 'aria-describedby': ids.columnHelp },
      on: { change: () => this.onImportColumn() },
    });
    this.importColumn.disabled = true;
    this.importCheck = this.el('button', { className: 'btn btn-primary btn-sm', attrs: { type: 'button', 'aria-describedby': ids.chooseFirst }, on: { click: () => this.runImport(true) } }, [
      this.t('action.checkFile'),
    ]);
    this.importRun = this.el('button', { className: 'btn btn-primary btn-sm', attrs: { type: 'button' }, on: { click: () => this.runImport(false) } }, [this.t('action.import')]);
    this.importReset = this.el('button', { className: 'btn btn-outline btn-sm', attrs: { type: 'button' }, on: { click: () => this.resetImport(true) } }, [this.t('action.reset')]);
    this.importChooseFirst = this.el('p', { className: 'text-xs text-base-content/70 empty:hidden', text: this.t('import.chooseFirst'), attrs: { id: ids.chooseFirst } });
    this.importActions = this.el('div', { className: 'flex flex-wrap items-center gap-2' });
    this.importProgress = this.el('div', { className: 'flex flex-col gap-1 max-w-md min-w-0' });
    questionSourcesShow(this.importProgress, false);
    this.importResult = this.el('div', { className: 'flex flex-col gap-4 min-w-0' });
    this.importForm = this.el('div', { className: 'flex flex-col gap-4 min-w-0' }, [
      this.el('p', { className: 'text-sm max-w-prose', text: this.t('import.explain') }),
      this.el('div', { className: 'form-control' }, [
        this.el('label', { className: 'label', attrs: { for: fileId } }, [this.el('span', { className: 'label-text', text: this.t('import.file.label') })]),
        this.importFile,
        this.importFileMessage,
      ]),
      this.el('div', { className: 'form-control' }, [
        this.el('label', { className: 'label', attrs: { for: columnId } }, [this.el('span', { className: 'label-text', text: this.t('import.column.label') })]),
        this.importColumn,
        this.el('div', { className: 'label' }, [this.el('span', { className: 'label-text-alt', text: this.t('import.column.help'), attrs: { id: ids.columnHelp } })]),
      ]),
      this.importActions,
      this.importProgress,
      this.importResult,
    ]);
    view.replaceChildren(this.importNeeds, this.importForm);
    this.resetImport(false);
  }

  renderImportGate() {
    if (!this.importForm) return;
    const { gatesUiAlert } = QUESTION_SOURCES_GATES;
    const on = this.switches().review;
    questionSourcesShow(this.importForm, on);
    if (on) {
      this.importNeeds.replaceChildren();
      if (!this.importForm.parentNode) this.views.import.appendChild(this.importForm);
      return;
    }
    if (this.imp.running) return;
    this.importForm.remove();
    this.importNeeds.replaceChildren(gatesUiAlert('warning', 'bi-exclamation-triangle', this.m('import.needs.review', { variable: 'RAG_DOMAIN_EXPERT_REVIEW' }), []));
  }

  onWorkspaceChange() {
    if (this.imp && !this.imp.running && this.imp.parsed) this.clearImportResult();
  }

  importFileError(key, vars) {
    const { gatesUiStatus } = QUESTION_SOURCES_GATES;
    this.importFileMessage.replaceChildren();
    this.importFileMessage.classList.toggle('text-error', Boolean(key));
    if (key) {
      QUESTION_SOURCES_GATES.gatesUiAppendMessage(this.importFileMessage, this.m(key, vars));
      this.importFile.setAttribute('aria-invalid', 'true');
      gatesUiStatus(this.hosts.status, this.m(key, vars), true);
    } else this.importFile.removeAttribute('aria-invalid');
  }

  tooLargeVars() {
    return { size: '10\u00a0MB', rows: questionSourcesCount(QUESTION_SOURCES_LIMITS.maxRows, this.locale) };
  }

  setImportActions(buttons) {
    this.importActions.replaceChildren(...buttons);
    if (buttons.includes(this.importCheck)) this.importActions.appendChild(this.importChooseFirst);
  }

  clearImportResult() {
    this.imp.sums = null;
    this.imp.checkedKey = null;
    this.importResult.replaceChildren();
    questionSourcesShow(this.importProgress, false);
    this.importProgress.replaceChildren();
    this.importCheck.disabled = !this.imp.parsed;
    this.importChooseFirst.textContent = this.imp.parsed ? '' : this.t('import.chooseFirst');
    if (this.imp.parsed) this.importCheck.removeAttribute('aria-describedby');
    else this.importCheck.setAttribute('aria-describedby', this.importChooseFirst.getAttribute('id'));
    this.setImportActions([this.importCheck]);
  }

  resetImport(focus) {
    this.imp.parsed = null;
    this.imp.phase = 'idle';
    this.importFile.value = '';
    this.importColumn.replaceChildren();
    this.importColumn.disabled = true;
    this.importFileError(null);
    this.clearImportResult();
    if (focus) this.importFile.focus();
  }

  async onImportFile() {
    if (this.imp.running) return;
    const files = this.importFile.files;
    const file = files && files.length > 0 ? files[0] : null;
    this.imp.parsed = null;
    this.importColumn.replaceChildren();
    this.importColumn.disabled = true;
    this.importFileError(null);
    this.clearImportResult();
    if (!file) return;
    if (typeof file.size === 'number' && file.size > QUESTION_SOURCES_LIMITS.maxFileBytes) return this.importFileError('import.tooLarge', this.tooLargeVars());
    let content;
    try {
      content = await file.text();
    } catch {
      return this.importFileError('import.badFormat', { line: questionSourcesCount(1, this.locale) });
    }
    if (questionSourcesUtf8Length(content) > QUESTION_SOURCES_LIMITS.maxFileBytes) return this.importFileError('import.tooLarge', this.tooLargeVars());
    const parsed = questionSourcesParseFile(content, questionSourcesFileFormat(file.name, file.type, content));
    content = null;
    if (!parsed.ok) {
      if (parsed.reason === 'tooLarge') return this.importFileError('import.tooLarge', this.tooLargeVars());
      if (parsed.reason === 'noColumn') return this.importFileError('import.noColumn');
      return this.importFileError('import.badFormat', { line: questionSourcesCount(parsed.line, this.locale) });
    }
    const usable = parsed.columns.map((name, index) => ({ name, index })).filter((c) => c.name !== '');
    if (usable.length === 0) return this.importFileError('import.noColumn');
    this.imp.parsed = parsed;
    const preferred = usable.find((c) => /^(question|query)$/i.test(c.name)) || usable[0];
    this.importColumn.replaceChildren(...usable.map((c) => this.el('option', { text: c.name, attrs: { value: String(c.index) } })));
    this.importColumn.value = String(preferred.index);
    this.importColumn.disabled = false;
    this.clearImportResult();
  }

  onImportColumn() {
    if (!this.imp.running) this.clearImportResult();
  }

  importControlsDisabled(disabled) {
    this.importFile.disabled = disabled;
    this.importColumn.disabled = disabled || !this.imp.parsed;
    for (const button of [this.importCheck, this.importRun, this.importReset]) button.disabled = disabled;
  }

  renderImportProgress(done, total) {
    const bar = this.el('progress', { className: 'progress progress-primary w-full', attrs: { max: String(total), value: String(done), 'aria-label': this.t('import.barLabel') } });
    this.importProgress.replaceChildren(
      bar,
      this.el('p', { className: 'text-xs tabular-nums', text: this.t('import.progress', { done: questionSourcesCount(done, this.locale), total: questionSourcesCount(total, this.locale) }) }),
    );
    questionSourcesShow(this.importProgress, true);
  }

  /** The counts list and the by-language table; counts only (UI-SPEC 11 rule 8). */
  renderImportCounts(sums, dryRun, headingKey) {
    const rows = [
      ['import.count.read', sums.read],
      [dryRun ? 'import.count.wouldAdd' : 'import.count.added', sums.added],
      ['import.count.duplicates', sums.duplicates],
      ['import.count.rejected', sums.rejected_pii],
      ['import.count.truncated', sums.truncated],
      ['import.count.empty', sums.empty],
    ];
    const caption = this.t('import.counts.caption');
    const body = this.el(
      'tbody',
      null,
      rows.map(([key, value]) =>
        this.el('tr', null, [
          this.el('th', { className: 'font-normal text-sm', text: this.t(key), attrs: { scope: 'row' } }),
          this.el('td', { className: 'text-sm text-right tabular-nums', text: questionSourcesCount(value, this.locale) }),
        ]),
      ),
    );
    const table = this.el(
      'div',
      {
        className: 'overflow-x-auto rounded-lg max-w-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': caption, 'data-question-sources-counts': '' },
      },
      [
        this.el('table', { className: 'table table-sm' }, [
          this.el('caption', { className: 'sr-only', text: caption }),
          this.el('thead', null, [
            this.el('tr', null, [
              this.el('th', { className: 'text-xs font-semibold', text: caption, attrs: { scope: 'col' } }),
              this.el('th', { className: 'text-xs font-semibold text-right', text: this.t('import.col.count'), attrs: { scope: 'col' } }),
            ]),
          ]),
          body,
        ]),
      ],
    );
    const nodes = [this.el('h4', { className: 'text-base font-semibold text-balance', text: this.t(headingKey) }), table];
    const langs = Object.keys(sums.by_language)
      .sort((x, y) => sums.by_language[y] - sums.by_language[x] || (x < y ? -1 : 1))
      .map((code) => ({ code, name: QUESTION_SOURCES_GATES.gatesUiLanguageName(code, this.locale), count: questionSourcesCount(sums.by_language[code], this.locale) }));
    if (langs.length > 0) nodes.push(this.languageTable(langs, this.t('sample.byLanguage'), this.t('import.col.questions')));
    return nodes;
  }

  async runImport(dryRun) {
    const parsed = this.imp.parsed;
    if (this.imp.running || !parsed) return;
    const { gatesUiSpinner, gatesUiErrorAlert, gatesUiAlert, gatesUiStatus } = QUESTION_SOURCES_GATES;
    const columnIndex = Number(this.importColumn.value);
    const column = String(parsed.columns[columnIndex] || '').slice(0, QUESTION_SOURCES_LIMITS.maxColumnChars);
    if (!column) return this.importFileError('import.noColumn');
    const questions = questionSourcesExtract(parsed, columnIndex);
    const envelope = { format: parsed.format, column, dry_run: dryRun };
    if (this.organizationId) envelope.organizationId = this.organizationId;
    const batches = questionSourcesBatches(questions, QUESTION_SOURCES_LIMITS.maxBatchBytes, envelope);
    const total = questions.length;
    const pressed = dryRun ? this.importCheck : this.importRun;
    this.imp.running = true;
    this.importResult.replaceChildren();
    this.importControlsDisabled(true);
    pressed.replaceChildren(gatesUiSpinner(), this.t(dryRun ? 'action.checkFile' : 'action.import'));
    this.renderImportProgress(0, total);
    let sums = questionSourcesEmptyCounts();
    let done = 0;
    let failure = null;
    let failedAt = 0;
    for (const rows of batches) {
      const result = await this.request(QUESTION_SOURCES_IMPORT_API, { method: 'POST', body: JSON.stringify({ ...envelope, rows }) }, QUESTION_SOURCES_LIMITS.batchTimeoutMs);
      if (!result.ok) {
        failure = result;
        failedAt = done;
        break;
      }
      sums = questionSourcesAddCounts(sums, result.body);
      done += rows.length;
      this.renderImportProgress(done, total);
    }
    this.imp.running = false;
    pressed.replaceChildren(this.t(dryRun ? 'action.checkFile' : 'action.import'));
    this.importControlsDisabled(false);
    questionSourcesShow(this.importProgress, false);
    const key = String(columnIndex) + '|' + (this.organizationId || '');
    if (failure) {
      const nodes = [];
      if (done > 0) nodes.push(...this.renderImportCounts(sums, dryRun, dryRun ? 'import.result.check' : 'import.result.done'));
      const interrupted = this.m('import.interrupted', { done: questionSourcesCount(done, this.locale), total: questionSourcesCount(total, this.locale) });
      nodes.push(gatesUiAlert('warning', 'bi-exclamation-triangle', interrupted, []));
      let mapped;
      if (failure.status === 400) mapped = this.m('import.badFormat', { line: questionSourcesCount(failedAt + (parsed.format === 'csv' ? 2 : 1), this.locale) });
      else if (failure.status === 413) mapped = this.m('import.tooLarge', this.tooLargeVars());
      else {
        mapped = this.mapError(failure, 'tab.import', true);
        if (mapped.kind === 'signIn' || mapped.kind === 'switchedOff') nodes.unshift(gatesUiErrorAlert(mapped, this.locale, () => this.renderImportGate()));
      }
      this.importResult.replaceChildren(...nodes);
      gatesUiStatus(this.hosts.status, mapped, true);
      this.setImportActions(dryRun ? [this.importCheck, this.importReset] : [this.importRun, this.importReset]);
      return;
    }
    this.imp.sums = sums;
    if (dryRun) {
      this.imp.checkedKey = key;
      const nodes = this.renderImportCounts(sums, true, 'import.result.check');
      if (sums.added > 0) {
        this.setImportActions([this.importRun, this.importReset]);
        this.setStatus(this.t('import.result.check'));
      } else {
        nodes.push(this.el('p', { className: 'text-sm max-w-prose', text: this.t('import.nothingNew') }));
        this.setImportActions([this.importReset]);
        this.setStatus(this.t('import.nothingNew'));
      }
      this.importResult.replaceChildren(...nodes);
      return;
    }
    const message = this.t('import.done', { count: questionSourcesCount(sums.added, this.locale) });
    this.importResult.replaceChildren(...this.renderImportCounts(sums, false, 'import.result.done'), this.el('p', { className: 'text-sm max-w-prose', text: message }));
    this.setImportActions([this.importReset]);
    this.setStatus(message, false, { toast: true });
  }

  // -------------------------------------------------------------------------------------------------------------------------------------
  // Settings (UI-SPEC 6.12, the sample group)

  mountSettings() {
    const view = this.views.settings;
    if (!view) return;
    this.settingsWarnings = this.el('div', { className: 'flex flex-col gap-2 mb-4 empty:mb-0' });
    view.replaceChildren(this.settingsWarnings);
    const block = document.getElementById('rag-phase053-settings');
    const group = (block && block.querySelector('[data-rag-settings-group="sample"]')) || document.querySelector('[data-rag-settings-group="sample"]');
    if (group) {
      view.appendChild(group);
      for (const el of group.querySelectorAll('[data-rag-i18n]')) {
        const key = el.getAttribute('data-rag-i18n');
        const own = questionSourcesHas(QUESTION_SOURCES_LABELS.en, key);
        const shared = questionSourcesHas(questionSourcesSharedLabels().en, key);
        if (own || shared) el.textContent = this.t(key);
      }
    }
    for (const id of ['RAG_REPRESENTATIVE_SAMPLE', 'RAG_RETRIEVAL_LOG', 'RAG_DOMAIN_EXPERT_REVIEW']) {
      const input = document.getElementById(id);
      if (input) input.addEventListener('change', () => this.renderSettingsWarnings());
    }
    this.renderSettingsWarnings();
  }

  renderSettingsWarnings() {
    if (!this.settingsWarnings) return;
    const { gatesUiAlert } = QUESTION_SOURCES_GATES;
    const byId = (id) => document.getElementById(id);
    const sample = byId('RAG_REPRESENTATIVE_SAMPLE');
    const log = byId('RAG_RETRIEVAL_LOG');
    const review = byId('RAG_DOMAIN_EXPERT_REVIEW');
    const keys = questionSourcesSettingsWarnings({
      sample: sample ? sample.value : 'false',
      log: log ? log.value : undefined,
      review: review ? (review.getAttribute('type') === 'checkbox' ? (review.checked ? 'true' : 'false') : review.value) : undefined,
    });
    this.settingsWarnings.replaceChildren(...keys.map((key) => gatesUiAlert('warning', 'bi-exclamation-triangle', this.m(key), [])));
  }
}

let QUESTION_SOURCES_PANEL_INSTANCE = null;

/** Idempotent: the first call mounts, later calls refresh the selected sub-view and keep its state. */
function initQuestionSourcesPanel() {
  if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return;
  const root = document.getElementById('rag-administration-question-sources');
  if (!root) return;
  if (!QUESTION_SOURCES_PANEL_INSTANCE) {
    QUESTION_SOURCES_PANEL_INSTANCE = new QuestionSourcesPanel(root);
    if (typeof window !== 'undefined') window.questionSourcesPanel = QUESTION_SOURCES_PANEL_INSTANCE;
    QUESTION_SOURCES_PANEL_INSTANCE.mount();
    return;
  }
  QUESTION_SOURCES_PANEL_INSTANCE.refresh();
}

function bindQuestionSourcesPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-question-sources-bound')) return;
    link.setAttribute('data-question-sources-bound', '1');
    link.addEventListener('click', () => initQuestionSourcesPanel());
  });
}

if (typeof window !== 'undefined') {
  window.initQuestionSourcesPanel = initQuestionSourcesPanel;
  bindQuestionSourcesPanel();
  document.addEventListener('DOMContentLoaded', () => {
    bindQuestionSourcesPanel();
    const tab = document.getElementById('rag-administration');
    if (tab && tab.classList.contains('active')) initQuestionSourcesPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    QUESTION_SOURCES_LABELS,
    QUESTION_SOURCES_LIMITS,
    questionSourcesLabel,
    questionSourcesMessage,
    questionSourcesSwitches,
    questionSourcesSampleView,
    questionSourcesPilotView,
    questionSourcesSettingsWarnings,
    questionSourcesFileFormat,
    questionSourcesReadHeader,
    questionSourcesParseFile,
    questionSourcesExtract,
    questionSourcesBatches,
    questionSourcesAddCounts,
    QuestionSourcesPanel,
    initQuestionSourcesPanel,
  };
}
