/**
 * Refusal calibration status panel (D-17, F-19): read-only. Shows the refusal switch, the reranker and model per use and question
 * language, every threshold cell with its point estimate and 95% upper bound, and the route's warnings. One GET through ragFetch over
 * the forwarded admin_session cookie; DOM built with createElement and textContent only.
 */

const REFUSAL_LABELS = {
  en: {
    'panel.title': 'Refusal calibration',
    'panel.description':
      'Read-only. Shows which refusal thresholds the app can use and how they scored when they were calibrated. Thresholds change only through the calibration tool and a pull request. Applies to every workspace in this deployment.',
    'action.refresh': 'Refresh status',
    'action.reload': 'Reload panel',
    'status.loading': 'Loading refusal calibration…',
    'status.loaded': 'Status loaded. Thresholds: {cells}. Warnings: {warnings}.',
    'status.updatedAt': 'Updated {time}',
    'summary.pipeline': 'Pipeline',
    'pipeline.legacy': 'Legacy',
    'summary.refusal': 'Threshold refusal',
    'value.on': 'On',
    'value.off': 'Off',
    'summary.reranker': 'Reranker',
    'reranker.none': 'None',
    'reranker.local_bm25': 'Local BM25',
    'summary.scores': 'Score type',
    'scores.calibrated': 'Comparable across questions',
    'scores.relative': "Relative to each question's candidates",
    'scores.none': 'No reranker',
    'models.caption': 'Reranker model by use and question language',
    'use.chat': 'Chat ({tier})',
    'use.voice': 'Voice ({tier})',
    'tier.quality': 'quality tier',
    'tier.fast': 'fast tier',
    'summary.versions': 'Current versions: tokenizer {tokenizer}, rerank text {rerankText}. Thresholds calibrated with other versions are not used.',
    'note.legacyPipeline': 'The legacy pipeline is selected. Threshold refusal works only with the v2 pipeline (RAG Modes, Retrieval pipeline).',
    'note.refusalOff': 'Threshold refusal is off, so no threshold below is applied to live answers. Turn it on under RAG Modes, Retrieval pipeline.',
    'note.pending': 'Settings show threshold refusal {draft}; the app uses {live} until it restarts with the saved value.',
    'note.pendingReranker': 'Settings show the reranker {draft}; the app uses {live} until it restarts with the saved value.',
    'warnings.heading': 'Warnings',
    'warnings.none': 'No warnings for the current settings.',
    'warning.refusal_on_without_calibrated_cell':
      'Threshold refusal is on, but there is no calibrated live threshold for questions in {languages} with the current reranker. For those questions the similarity floor decides instead. To use thresholds there, run {command} against the live app for the models listed below, commit the result and redeploy.',
    'warning.missingItem': '{use}: {model}, {language}',
    'warning.fixture_cells_only':
      'All thresholds below come from the test fixture. They show that the calibration tool works and are used in evaluation only, never for live answers. Run {command} against the live app to get thresholds for your data.',
    'warning.stale_cells':
      'Thresholds calibrated with an older tokenizer or rerank text version: {count}. They are marked Stale below and are not used. Run {command} again, commit the result and redeploy.',
    'warning.relative_reranker':
      'The {provider} reranker scores each candidate relative to the others for the same question, so a threshold cannot apply to it. The similarity floor decides instead. To use threshold refusal, choose Cohere or Voyage as the reranker under RAG Modes.',
    'warning.thresholds_invalid':
      'The threshold file in this deployment (eval/config/refusal-thresholds.json) is not valid, so no threshold is applied and the similarity floor decides. Run {command} again, commit the result and redeploy.',
    'cells.heading': 'Thresholds',
    'cells.caption': 'Refusal thresholds by reranker model and question language',
    'cells.explain':
      'False refusals are answerable questions that were refused. Correct refusals are questions with no answer in the knowledge base that were refused. The 95% upper bound is the highest false-refusal rate the data still allows; with few items it is far above the point estimate.',
    'cells.empty.title': 'No thresholds yet',
    'cells.empty.body':
      'No calibration result is in this deployment, so threshold refusal applies nowhere and the similarity floor decides. Run {command}, commit the result and redeploy.',
    'cells.noThreshold': 'None',
    'col.model': 'Reranker model',
    'col.language': 'Question language',
    'col.pairing': 'Document language',
    'pairing.same': 'Same as the question',
    'pairing.cross': 'Different from the question',
    'col.status': 'Status',
    'col.threshold': 'Threshold',
    'group.dev': 'Dev set',
    'group.holdout': 'Holdout set',
    'col.falseRefusal': 'False refusals',
    'col.falseRefusalSub': 'point estimate, 95% upper bound',
    'col.correctRefusal': 'Correct refusals',
    'col.correctRefusalSub': 'point estimate',
    'col.recorded': 'Recorded',
    'cell.point': 'point estimate',
    'cell.upper': '95% upper bound {value}',
    'cell.n': 'n = {n}',
    'cell.noAnswerable': 'No answerable items',
    'cell.noNoAnswer': 'No no-answer items',
    'status.calibrated': 'Calibrated',
    'status.uncalibrated': 'Not calibrated',
    'status.insufficient_data': 'Not enough data',
    'status.failed_holdout': 'Failed the holdout check',
    'status.hint.calibrated': 'Passed the holdout check.',
    'status.hint.uncalibrated': 'No threshold was fitted. Never causes a refusal.',
    'status.hint.insufficient_data': 'Too few items to fit a threshold. Never causes a refusal.',
    'status.hint.failed_holdout': 'The threshold did not hold on the holdout set. Never causes a refusal.',
    'badge.fixture': 'Fixture, eval only',
    'badge.stale': 'Stale',
    'legend.summary': 'What the statuses mean',
    'legend.fixture': 'Fixture, eval only: calibrated on the built-in test data. Used when evaluating, never for live answers.',
    'legend.stale': 'Stale: calibrated with another tokenizer or rerank text version than the app runs now. Not used until calibrated again.',
    'error.unavailable': 'Refusal calibration is unavailable right now. Select Reload panel in a moment.',
    'error.statusUnreadable': 'The refusal calibration status could not be read. Select Reload panel. If it repeats, check the app log for [RAG Admin].',
    'pointer.text': 'Calibration status and warnings are under RAG administration, Refusal calibration.',
    'pointer.open': 'Open refusal calibration',
    'lang.zh': 'Chinese',
    'lang.en': 'English',
    'lang.it': 'Italian',
  },
  zh: {
    'panel.title': '拒答校准',
    'panel.description': '只读。显示应用可以使用哪些拒答阈值，以及校准时的表现。阈值只能通过校准工具和合并请求修改。对本部署的所有工作区生效。',
    'action.refresh': '刷新状态',
    'action.reload': '重新加载面板',
    'status.loading': '正在加载拒答校准…',
    'status.loaded': '状态已加载。阈值：{cells} 个。警告：{warnings} 条。',
    'status.updatedAt': '更新于 {time}',
    'summary.pipeline': '检索流程',
    'pipeline.legacy': '旧版',
    'summary.refusal': '阈值拒答',
    'value.on': '开',
    'value.off': '关',
    'summary.reranker': '重排模型',
    'reranker.none': '无',
    'reranker.local_bm25': '本地 BM25',
    'summary.scores': '分数类型',
    'scores.calibrated': '不同问题之间可比较',
    'scores.relative': '仅在同一问题的候选之间有意义',
    'scores.none': '没有重排模型',
    'models.caption': '按用途和提问语言列出的重排模型',
    'use.chat': '聊天（{tier}）',
    'use.voice': '语音（{tier}）',
    'tier.quality': '质量档',
    'tier.fast': '快速档',
    'summary.versions': '当前版本：分词器 {tokenizer}，重排文本 {rerankText}。用其他版本校准的阈值不会被使用。',
    'note.legacyPipeline': '当前选择的是旧版流程。阈值拒答只在 v2 流程下生效（RAG Modes，Retrieval pipeline）。',
    'note.refusalOff': '阈值拒答已关闭，下方的阈值都不会用于实际回答。可在 RAG Modes 的 Retrieval pipeline 中开启。',
    'note.pending': '设置中的阈值拒答为“{draft}”；在应用以保存的值重启之前，仍为“{live}”。',
    'note.pendingReranker': '设置中的重排模型为“{draft}”；在应用以保存的值重启之前，仍为“{live}”。',
    'warnings.heading': '警告',
    'warnings.none': '当前设置下没有警告。',
    'warning.refusal_on_without_calibrated_cell':
      '阈值拒答已开启，但在当前重排模型下，{languages}提问没有经过校准的实际阈值。这些问题改由相似度下限决定。要在这些语言上使用阈值，请针对下列模型在实际应用上运行 {command}，提交结果并重新部署。',
    'warning.missingItem': '{use}：{model}，{language}',
    'warning.fixture_cells_only':
      '下方所有阈值都来自测试数据。它们只说明校准工具可用，仅用于评估，不会用于实际回答。请在实际应用上运行 {command}，得到针对你的数据的阈值。',
    'warning.stale_cells': '用旧版分词器或重排文本校准的阈值：{count} 个。它们在下方标为“已过期”，不会被使用。请重新运行 {command}，提交结果并重新部署。',
    'warning.relative_reranker':
      '{provider} 重排模型的分数只在同一问题的候选之间有意义，因此无法应用阈值。此时由相似度下限决定。要使用阈值拒答，请在 RAG Modes 中选择 Cohere 或 Voyage 作为重排模型。',
    'warning.thresholds_invalid':
      '本部署中的阈值文件（eval/config/refusal-thresholds.json）无效，因此不会应用任何阈值，由相似度下限决定。请重新运行 {command}，提交结果并重新部署。',
    'cells.heading': '阈值',
    'cells.caption': '按重排模型和提问语言列出的拒答阈值',
    'cells.explain':
      '误拒答是指本可回答却被拒答的问题。正确拒答是指知识库中没有答案并被拒答的问题。95% 上界是数据仍然允许的最高误拒答率；条目很少时，它会远高于点估计。',
    'cells.empty.title': '还没有阈值',
    'cells.empty.body': '本部署中没有校准结果，因此阈值拒答不会生效，由相似度下限决定。请运行 {command}，提交结果并重新部署。',
    'cells.noThreshold': '无',
    'col.model': '重排模型',
    'col.language': '提问语言',
    'col.pairing': '文档语言',
    'pairing.same': '与提问相同',
    'pairing.cross': '与提问不同',
    'col.status': '状态',
    'col.threshold': '阈值',
    'group.dev': '开发集',
    'group.holdout': '留出集',
    'col.falseRefusal': '误拒答',
    'col.falseRefusalSub': '点估计，95% 上界',
    'col.correctRefusal': '正确拒答',
    'col.correctRefusalSub': '点估计',
    'col.recorded': '记录日期',
    'cell.point': '点估计',
    'cell.upper': '95% 上界 {value}',
    'cell.n': 'n = {n}',
    'cell.noAnswerable': '没有可回答的条目',
    'cell.noNoAnswer': '没有无答案的条目',
    'status.calibrated': '已校准',
    'status.uncalibrated': '未校准',
    'status.insufficient_data': '数据不足',
    'status.failed_holdout': '未通过留出集检查',
    'status.hint.calibrated': '已通过留出集检查。',
    'status.hint.uncalibrated': '没有拟合出阈值，不会导致拒答。',
    'status.hint.insufficient_data': '条目太少，无法拟合阈值，不会导致拒答。',
    'status.hint.failed_holdout': '阈值在留出集上不成立，不会导致拒答。',
    'badge.fixture': '测试数据，仅用于评估',
    'badge.stale': '已过期',
    'legend.summary': '状态说明',
    'legend.fixture': '测试数据，仅用于评估：用内置测试数据校准，只在评估时使用，不会用于实际回答。',
    'legend.stale': '已过期：校准时使用的分词器或重排文本版本与应用当前版本不同。重新校准之前不会使用。',
    'error.unavailable': '暂时无法读取拒答校准。请稍后点击“重新加载面板”。',
    'error.statusUnreadable': '无法读取拒答校准状态。请点击“重新加载面板”。如果再次出现，请在应用日志中查找 [RAG Admin]。',
    'pointer.text': '校准状态和警告位于 RAG administration 的“拒答校准”中。',
    'pointer.open': '打开拒答校准',
    'lang.zh': '中文',
    'lang.en': '英语',
    'lang.it': '意大利语',
  },
  it: {
    'panel.title': 'Calibrazione del rifiuto',
    'panel.description':
      "Sola lettura. Mostra quali soglie di rifiuto l'app può usare e come si sono comportate in calibrazione. Le soglie cambiano solo tramite lo strumento di calibrazione e una pull request. Vale per tutti gli spazi di lavoro di questa installazione.",
    'action.refresh': 'Aggiorna stato',
    'action.reload': 'Ricarica pannello',
    'status.loading': 'Caricamento della calibrazione del rifiuto…',
    'status.loaded': 'Stato caricato. Soglie: {cells}. Avvisi: {warnings}.',
    'status.updatedAt': 'Aggiornato alle {time}',
    'summary.pipeline': 'Pipeline',
    'pipeline.legacy': 'Legacy',
    'summary.refusal': 'Rifiuto a soglia',
    'value.on': 'Attivo',
    'value.off': 'Disattivo',
    'summary.reranker': 'Reranker',
    'reranker.none': 'Nessuno',
    'reranker.local_bm25': 'BM25 locale',
    'summary.scores': 'Tipo di punteggio',
    'scores.calibrated': 'Confrontabile tra domande',
    'scores.relative': 'Relativo ai candidati di ogni domanda',
    'scores.none': 'Nessun reranker',
    'models.caption': 'Modello di reranking per uso e lingua della domanda',
    'use.chat': 'Chat ({tier})',
    'use.voice': 'Voce ({tier})',
    'tier.quality': 'livello qualità',
    'tier.fast': 'livello rapido',
    'summary.versions':
      'Versioni attuali: tokenizer {tokenizer}, testo di reranking {rerankText}. Le soglie calibrate con altre versioni non vengono usate.',
    'note.legacyPipeline': 'È selezionata la pipeline legacy. Il rifiuto a soglia funziona solo con la pipeline v2 (RAG Modes, Retrieval pipeline).',
    'note.refusalOff':
      'Il rifiuto a soglia è disattivo: nessuna delle soglie qui sotto viene applicata alle risposte reali. Attivalo in RAG Modes, Retrieval pipeline.',
    'note.pending': "Nelle impostazioni il rifiuto a soglia è {draft}; l'app usa {live} finché non viene riavviata con il valore salvato.",
    'note.pendingReranker': "Nelle impostazioni il reranker è {draft}; l'app usa {live} finché non viene riavviata con il valore salvato.",
    'warnings.heading': 'Avvisi',
    'warnings.none': 'Nessun avviso per le impostazioni attuali.',
    'warning.refusal_on_without_calibrated_cell':
      "Il rifiuto a soglia è attivo, ma con il reranker attuale non esiste una soglia reale calibrata per le domande in {languages}. Per queste domande decide la soglia minima di similarità. Per usare le soglie, esegui {command} sull'app reale per i modelli elencati qui sotto, salva il risultato nel repository e ridistribuisci.",
    'warning.missingItem': '{use}: {model}, {language}',
    'warning.fixture_cells_only':
      "Tutte le soglie qui sotto provengono dai dati di prova. Dimostrano che lo strumento di calibrazione funziona e sono usate solo nella valutazione, mai per le risposte reali. Esegui {command} sull'app reale per ottenere soglie per i tuoi dati.",
    'warning.stale_cells':
      'Soglie calibrate con una versione precedente del tokenizer o del testo di reranking: {count}. Qui sotto sono contrassegnate come «Obsoleta» e non vengono usate. Esegui di nuovo {command}, salva il risultato nel repository e ridistribuisci.',
    'warning.relative_reranker':
      'Il reranker {provider} dà a ogni candidato un punteggio relativo agli altri della stessa domanda, quindi una soglia non può applicarsi. Decide la soglia minima di similarità. Per usare il rifiuto a soglia, scegli Cohere o Voyage come reranker in RAG Modes.',
    'warning.thresholds_invalid':
      'Il file delle soglie di questa installazione (eval/config/refusal-thresholds.json) non è valido: nessuna soglia viene applicata e decide la soglia minima di similarità. Esegui di nuovo {command}, salva il risultato nel repository e ridistribuisci.',
    'cells.heading': 'Soglie',
    'cells.caption': 'Soglie di rifiuto per modello di reranking e lingua della domanda',
    'cells.explain':
      'I rifiuti errati sono domande a cui si poteva rispondere e che sono state rifiutate. I rifiuti corretti sono domande senza risposta nella base di conoscenza e rifiutate. Il limite superiore al 95% è il tasso di rifiuti errati più alto ancora compatibile con i dati; con pochi elementi è molto più alto della stima puntuale.',
    'cells.empty.title': 'Nessuna soglia',
    'cells.empty.body':
      "In questa installazione non c'è alcun risultato di calibrazione: il rifiuto a soglia non si applica e decide la soglia minima di similarità. Esegui {command}, salva il risultato nel repository e ridistribuisci.",
    'cells.noThreshold': 'Nessuna',
    'col.model': 'Modello di reranking',
    'col.language': 'Lingua della domanda',
    'col.pairing': 'Lingua del documento',
    'pairing.same': 'Uguale alla domanda',
    'pairing.cross': 'Diversa dalla domanda',
    'col.status': 'Stato',
    'col.threshold': 'Soglia',
    'group.dev': 'Set di sviluppo',
    'group.holdout': 'Set di verifica',
    'col.falseRefusal': 'Rifiuti errati',
    'col.falseRefusalSub': 'stima puntuale, limite superiore al 95%',
    'col.correctRefusal': 'Rifiuti corretti',
    'col.correctRefusalSub': 'stima puntuale',
    'col.recorded': 'Registrata il',
    'cell.point': 'stima puntuale',
    'cell.upper': 'limite superiore al 95% {value}',
    'cell.n': 'n = {n}',
    'cell.noAnswerable': 'Nessun elemento con risposta',
    'cell.noNoAnswer': 'Nessun elemento senza risposta',
    'status.calibrated': 'Calibrata',
    'status.uncalibrated': 'Non calibrata',
    'status.insufficient_data': 'Dati insufficienti',
    'status.failed_holdout': 'Verifica non superata',
    'status.hint.calibrated': 'Ha superato la verifica.',
    'status.hint.uncalibrated': 'Nessuna soglia calcolata. Non causa mai un rifiuto.',
    'status.hint.insufficient_data': 'Troppi pochi elementi per calcolare una soglia. Non causa mai un rifiuto.',
    'status.hint.failed_holdout': 'La soglia non ha retto sul set di verifica. Non causa mai un rifiuto.',
    'badge.fixture': 'Dati di prova, solo valutazione',
    'badge.stale': 'Obsoleta',
    'legend.summary': 'Significato degli stati',
    'legend.fixture': 'Dati di prova, solo valutazione: calibrata sui dati di prova integrati. Usata nella valutazione, mai per le risposte reali.',
    'legend.stale':
      'Obsoleta: calibrata con una versione del tokenizer o del testo di reranking diversa da quella in uso. Non viene usata finché non è ricalibrata.',
    'error.unavailable': 'La calibrazione del rifiuto non è disponibile al momento. Seleziona «Ricarica pannello» tra poco.',
    'error.statusUnreadable':
      "Non è stato possibile leggere lo stato della calibrazione. Seleziona «Ricarica pannello». Se si ripete, cerca [RAG Admin] nel log dell'app.",
    'pointer.text': 'Lo stato della calibrazione e gli avvisi sono in RAG administration, Calibrazione del rifiuto.',
    'pointer.open': 'Apri calibrazione del rifiuto',
    'lang.zh': 'Cinese',
    'lang.en': 'Inglese',
    'lang.it': 'Italiano',
  },
};

const REFUSAL_API = '/api/rag/admin/refusal-calibration';
const REFUSAL_CALIBRATE_COMMAND = 'python -m rag_eval.calibrate refusal';
const REFUSAL_LANGUAGES = Object.freeze(['zh', 'en', 'it']);
const REFUSAL_STATUSES = Object.freeze(['calibrated', 'uncalibrated', 'insufficient_data', 'failed_holdout']);
const REFUSAL_DEFAULT_TIERS = Object.freeze({ chat: 'quality', voice: 'fast' });
const REFUSAL_WARNING_STYLE = Object.freeze({
  thresholds_invalid: { tone: 'error', icon: 'bi-x-octagon' },
  refusal_on_without_calibrated_cell: { tone: 'warning', icon: 'bi-exclamation-triangle' },
  stale_cells: { tone: 'warning', icon: 'bi-exclamation-triangle' },
  relative_reranker: { tone: 'warning', icon: 'bi-exclamation-triangle' },
  fixture_cells_only: { tone: 'info', icon: 'bi-info-circle' },
});

function refusalLocale(locale) {
  return locale === 'zh' || locale === 'it' ? locale : 'en';
}

function refusalDetectLocale() {
  const lang = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').slice(0, 2);
  return refusalLocale(lang);
}

function refusalTemplate(key, locale) {
  const table = REFUSAL_LABELS[refusalLocale(locale)] || REFUSAL_LABELS.en;
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  if (Object.prototype.hasOwnProperty.call(REFUSAL_LABELS.en, key)) return REFUSAL_LABELS.en[key];
  return null;
}

/** Template to segments: a var given as { code } or { mono } keeps its own segment, { time } becomes a time element. */
function refusalFill(template, vars) {
  const segments = [];
  const source = String(template);
  const re = /\{(\w+)\}/g;
  let last = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (match.index > last) segments.push({ text: source.slice(last, match.index) });
    const value = vars && Object.prototype.hasOwnProperty.call(vars, match[1]) ? vars[match[1]] : undefined;
    if (value && typeof value === 'object' && typeof value.code === 'string') segments.push({ code: value.code });
    else if (value && typeof value === 'object' && typeof value.mono === 'string') segments.push({ mono: value.mono });
    else if (value && typeof value === 'object' && value.time) segments.push({ time: value.time });
    else if (value === undefined || value === null) segments.push({ text: match[0] });
    else segments.push({ text: String(value) });
    last = re.lastIndex;
  }
  if (last < source.length) segments.push({ text: source.slice(last) });
  const merged = [];
  for (const segment of segments) {
    const prev = merged[merged.length - 1];
    if (segment.text !== undefined && prev && prev.text !== undefined) prev.text += segment.text;
    else merged.push(segment);
  }
  return merged;
}

function refusalSegmentsText(segments) {
  return segments.map((s) => (s.text !== undefined ? s.text : s.code !== undefined ? s.code : s.mono !== undefined ? s.mono : s.time.text)).join('');
}

function refusalSharedTemplate(key, locale) {
  let text = null;
  if (typeof window !== 'undefined' && typeof window.ingestLabel === 'function') text = window.ingestLabel(key, locale, {});
  else if (typeof require === 'function') {
    try {
      text = require('../document-processing/status-monitor.js').ingestLabel(key, locale, {});
    } catch {
      text = null;
    }
  }
  if (text && text !== key) return text;
  if (key === 'error.network') return "Can't reach the Config UI server. Check that it is running, then reload.";
  if (key === 'error.signIn') return 'Admin sign-in required. Sign in to the main myRAG app at {appUrl} (Settings → Admin tab), then reload the Config UI.';
  return 'Request failed ({status}).';
}

function refusalMessage(key, locale, vars) {
  const shared = key === 'error.signIn' || key === 'error.network' || key === 'error.generic';
  const template = shared ? refusalSharedTemplate(key, refusalLocale(locale)) : refusalTemplate(key, locale);
  const segments = refusalFill(template === null ? key : template, vars || {});
  return { key, segments, text: refusalSegmentsText(segments) };
}

function refusalLabel(key, locale, vars) {
  return refusalMessage(key, locale, vars).text;
}

function refusalAppUrl(fallback) {
  if (fallback) return fallback;
  if (typeof window !== 'undefined' && typeof window.getConfiguredMyRAGAppUrl === 'function') return window.getConfiguredMyRAGAppUrl();
  if (typeof window !== 'undefined' && window.location && window.location.origin) return window.location.origin;
  return 'http://localhost:3000';
}

function refusalNumber(value, locale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Intl.NumberFormat(refusalLocale(locale)).format(value);
}

function refusalPercent(value, locale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Intl.NumberFormat(refusalLocale(locale), { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

function refusalDate(value, locale, style) {
  if (typeof value !== 'string' || value === '') return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? value + 'T00:00:00Z' : value);
  if (Number.isNaN(parsed.getTime())) return null;
  const options = style === 'time' ? { timeStyle: 'short' } : { dateStyle: 'medium' };
  if (dateOnly) options.timeZone = 'UTC';
  return { iso: value, text: new Intl.DateTimeFormat(refusalLocale(locale), options).format(parsed) };
}

function refusalLanguageName(code, locale) {
  return refusalTemplate('lang.' + code, locale) === null ? String(code) : refusalLabel('lang.' + code, locale);
}

function refusalProviderName(provider, locale) {
  if (provider === 'cohere') return 'Cohere';
  if (provider === 'voyage') return 'Voyage';
  if (provider === 'local_bm25') return refusalLabel('reranker.local_bm25', locale);
  if (provider === 'none' || provider === null || provider === undefined) return refusalLabel('reranker.none', locale);
  return String(provider);
}

function refusalListFormat(items, locale) {
  if (typeof Intl !== 'undefined' && typeof Intl.ListFormat === 'function') {
    return new Intl.ListFormat(refusalLocale(locale), { type: 'conjunction' }).format(items);
  }
  return items.join(', ');
}

function refusalUseLabel(use, rerankTier, locale) {
  const tier = rerankTier === 'fast' || rerankTier === 'quality' ? rerankTier : REFUSAL_DEFAULT_TIERS[use] || 'quality';
  return refusalLabel(use === 'voice' ? 'use.voice' : 'use.chat', locale, { tier: refusalLabel('tier.' + tier, locale) });
}

function refusalWhole(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** A false-refusal rate with its 95% upper bound and n, or the no-items text. */
function refusalFalseRate(split, locale) {
  const n = refusalWhole(split && split.answerable_count);
  const point = split && typeof split.false_refusal_point_estimate === 'number' ? split.false_refusal_point_estimate : null;
  if (n === 0 || point === null) return { empty: true, text: refusalLabel('cell.noAnswerable', locale) };
  const upper = typeof split.false_refusal_upper_bound_95 === 'number' ? split.false_refusal_upper_bound_95 : null;
  const clamp = (v) => Math.max(0, Math.min(100, v * 100));
  return {
    empty: false,
    point: refusalPercent(point, locale),
    upper: upper === null ? null : refusalPercent(upper, locale),
    n: refusalNumber(n, locale),
    pointPct: clamp(point),
    upperPct: upper === null ? null : clamp(upper),
  };
}

function refusalCorrectRate(split, locale) {
  const n = refusalWhole(split && split.no_answer_count);
  const point = split && typeof split.correct_refusal_point_estimate === 'number' ? split.correct_refusal_point_estimate : null;
  if (n === 0 || point === null) return { empty: true, text: refusalLabel('cell.noNoAnswer', locale) };
  return { empty: false, point: refusalPercent(point, locale), n: refusalNumber(n, locale) };
}

/** One view row per threshold cell, in the route's order, with only the fields UI-SPEC section 6.8 names. */
function cellRows(status, locale) {
  const cells = status && Array.isArray(status.cells) ? status.cells : [];
  return cells.map((cell) => {
    const statusKey = REFUSAL_STATUSES.includes(cell.status) ? cell.status : 'uncalibrated';
    const fixture = cell.source === 'fixture';
    const stale = cell.stale === true;
    return {
      provider: refusalProviderName(cell.provider, locale),
      model: String(cell.model),
      language: refusalLanguageName(cell.query_language, locale),
      pairing: refusalLabel(cell.pairing === 'cross' ? 'pairing.cross' : 'pairing.same', locale),
      statusKey,
      statusLabel: refusalLabel('status.' + statusKey, locale),
      statusHint: refusalLabel('status.hint.' + statusKey, locale),
      fixture,
      fixtureLabel: fixture ? refusalLabel('badge.fixture', locale) : null,
      stale,
      staleLabel: stale ? refusalLabel('badge.stale', locale) : null,
      threshold:
        typeof cell.threshold === 'number' && Number.isFinite(cell.threshold)
          ? new Intl.NumberFormat(refusalLocale(locale), { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(cell.threshold)
          : refusalLabel('cells.noThreshold', locale),
      dev: { falseRefusal: refusalFalseRate(cell.dev, locale), correctRefusal: refusalCorrectRate(cell.dev, locale) },
      holdout: { falseRefusal: refusalFalseRate(cell.holdout, locale), correctRefusal: refusalCorrectRate(cell.holdout, locale) },
      recorded: refusalDate(cell.recorded_at, locale, 'date'),
    };
  });
}

/** A route warning as a localized sentence (UI-SPEC section 12.5); an unknown code shows the route's own message in English. */
function refusalWarningView(warning, locale, status) {
  const w = warning && typeof warning === 'object' ? warning : {};
  const code = String(w.code);
  const style = REFUSAL_WARNING_STYLE[code];
  if (!style) {
    const text = typeof w.message === 'string' ? w.message : code;
    return { key: 'warning.other', code, tone: 'warning', icon: 'bi-exclamation-triangle', segments: [{ text }], text, lang: 'en', missing: [] };
  }
  const vars = { command: { code: REFUSAL_CALIBRATE_COMMAND } };
  const missing = [];
  if (code === 'refusal_on_without_calibrated_cell') {
    const languages = Array.isArray(w.languages) ? w.languages : [];
    vars.languages = refusalListFormat(
      languages.map((l) => refusalLanguageName(l, locale)),
      locale,
    );
    const tiers = status && status.reranker && status.reranker.tiers ? status.reranker.tiers : {};
    for (const entry of Array.isArray(w.missing) ? w.missing : []) {
      const use = entry.tier === 'voice' ? 'voice' : 'chat';
      missing.push(
        refusalMessage('warning.missingItem', locale, {
          use: refusalUseLabel(use, tiers[use] && tiers[use].tier, locale),
          model: { mono: String(entry.model) },
          language: refusalLanguageName(entry.query_language, locale),
        }),
      );
    }
  }
  if (code === 'stale_cells') vars.count = refusalNumber(Array.isArray(w.keys) ? w.keys.length : 0, locale);
  if (code === 'relative_reranker') vars.provider = refusalProviderName(w.provider, locale);
  return { ...refusalMessage('warning.' + code, locale, vars), code, tone: style.tone, icon: style.icon, missing };
}

/**
 * The summary list, the model matrix (null without a reranker), the versions line and the derived notes. page: the saved settings on the
 * RAG Modes tab ({ refusalThreshold, reranker }); null values are not compared.
 */
function refusalSummary(status, locale, page) {
  const s = status && typeof status === 'object' ? status : {};
  const reranker = s.reranker && typeof s.reranker === 'object' ? s.reranker : {};
  const provider = typeof reranker.provider === 'string' ? reranker.provider : 'none';
  const semantics = reranker.score_semantics;
  const refusalOn = s.refusal_threshold === true;
  const items = [
    { key: 'summary.pipeline', value: s.pipeline === 'legacy' ? refusalLabel('pipeline.legacy', locale) : String(s.pipeline || 'v2') },
    { key: 'summary.refusal', value: refusalLabel(refusalOn ? 'value.on' : 'value.off', locale) },
    { key: 'summary.reranker', value: refusalProviderName(provider, locale) },
    {
      key: 'summary.scores',
      value: refusalLabel(semantics === 'calibrated' ? 'scores.calibrated' : semantics === 'relative' ? 'scores.relative' : 'scores.none', locale),
    },
  ];
  let models = null;
  if (provider !== 'none' && reranker.tiers && typeof reranker.tiers === 'object') {
    models = ['chat', 'voice'].map((use) => {
      const tier = reranker.tiers[use] || {};
      const byLanguage = tier.models && typeof tier.models === 'object' ? tier.models : {};
      return { use: refusalUseLabel(use, tier.tier, locale), models: REFUSAL_LANGUAGES.map((l) => (typeof byLanguage[l] === 'string' ? byLanguage[l] : '')) };
    });
  }
  const versions = s.versions && typeof s.versions === 'object' ? s.versions : {};
  const notes = [];
  if (s.pipeline === 'legacy') notes.push(refusalMessage('note.legacyPipeline', locale));
  if (!refusalOn) notes.push(refusalMessage('note.refusalOff', locale));
  const p = page || {};
  if (typeof p.refusalThreshold === 'boolean' && p.refusalThreshold !== refusalOn) {
    notes.push(
      refusalMessage('note.pending', locale, {
        draft: refusalLabel(p.refusalThreshold ? 'value.on' : 'value.off', locale),
        live: refusalLabel(refusalOn ? 'value.on' : 'value.off', locale),
      }),
    );
  }
  if (typeof p.reranker === 'string' && p.reranker !== '' && p.reranker !== provider) {
    notes.push(refusalMessage('note.pendingReranker', locale, { draft: refusalProviderName(p.reranker, locale), live: refusalProviderName(provider, locale) }));
  }
  return {
    items,
    models,
    versions: refusalMessage('summary.versions', locale, {
      tokenizer: refusalNumber(versions.tokenizer, locale),
      rerankText: refusalNumber(versions.rerank_text, locale),
    }),
    notes,
  };
}

function mapRefusalError(result, locale, ctx) {
  const c = ctx || {};
  if (!result || result.thrown) return refusalMessage('error.network', locale);
  const status = typeof result.status === 'number' ? result.status : 0;
  const body = result.body && typeof result.body === 'object' ? result.body : {};
  if (status === 401 || status === 403) return { ...refusalMessage('error.signIn', locale, { appUrl: refusalAppUrl(c.appUrl) }), signIn: true };
  if (status === 503) return refusalMessage('error.unavailable', locale);
  if (status === 500 && body.error === 'refusal_status_unavailable') return refusalMessage('error.statusUnreadable', locale);
  return refusalMessage('error.generic', locale, { status: status || '?' });
}

/** The two saved settings on the RAG Modes tab; the only page inputs this panel reads, never writes. */
function refusalPageSettings() {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return {};
  const toggle = document.getElementById('RAG_REFUSAL_THRESHOLD');
  const reranker = document.getElementById('RAG_RERANKER');
  return {
    refusalThreshold: toggle && typeof toggle.checked === 'boolean' ? toggle.checked : null,
    reranker: reranker && typeof reranker.value === 'string' ? reranker.value : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// DOM (createElement and textContent only)

function refusalEl(tag, opts, children) {
  const el = document.createElement(tag);
  const o = opts || {};
  if (o.cls) el.className = o.cls;
  if (o.text !== undefined && o.text !== null) el.textContent = String(o.text);
  if (o.attrs) {
    for (const [name, value] of Object.entries(o.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (o.on) for (const [type, fn] of Object.entries(o.on)) el.addEventListener(type, fn);
  if (children) for (const child of children) if (child) el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  return el;
}

function refusalIcon(name, extra) {
  return refusalEl('i', { cls: 'bi ' + name + (extra ? ' ' + extra : ''), attrs: { 'aria-hidden': 'true' } });
}

function refusalSpinner() {
  return refusalEl('span', { cls: 'loading loading-spinner loading-sm motion-reduce:hidden', attrs: { 'aria-hidden': 'true' } });
}

function refusalAppendMessage(el, message) {
  for (const segment of message.segments) {
    if (segment.text !== undefined) el.appendChild(document.createTextNode(segment.text));
    else if (segment.code !== undefined) el.appendChild(refusalEl('code', { cls: 'font-mono text-xs break-all', text: segment.code }));
    else if (segment.mono !== undefined) el.appendChild(refusalEl('span', { cls: 'font-mono break-all', text: segment.mono }));
    else if (segment.time) el.appendChild(refusalEl('time', { text: segment.time.text, attrs: { datetime: segment.time.iso } }));
  }
  return el;
}

function refusalMessageEl(tag, cls, message) {
  return refusalAppendMessage(refusalEl(tag, { cls }), message);
}

function refusalAlert(tone, icon, message, extra, lang) {
  const text = refusalMessageEl('p', 'text-sm', message);
  if (lang) text.setAttribute('lang', lang);
  const body = refusalEl('div', { cls: 'flex flex-col gap-2 items-start max-w-prose' }, [text]);
  for (const node of extra || []) if (node) body.appendChild(node);
  return refusalEl('div', { cls: 'alert alert-' + tone + ' items-start text-left' }, [refusalIcon(icon, 'mt-0.5'), body]);
}

/** The rate cell (UI-SPEC section 6.9): point estimate, 95% upper bound, n, and a neutral mark. */
function refusalRateCell(view, locale) {
  if (view.empty) return refusalEl('span', { cls: 'text-sm text-base-content/70', text: view.text });
  const mark = refusalEl('div', { cls: 'relative w-24 h-1 rounded-full bg-base-300 hidden md:block shrink-0', attrs: { 'aria-hidden': 'true' } });
  if (view.upperPct !== null && view.upperPct !== undefined) {
    const range = refusalEl('div', { cls: 'absolute inset-y-0 left-0 rounded-full bg-base-content/30' });
    range.style.width = view.upperPct + '%';
    mark.appendChild(range);
  }
  const dot = refusalEl('div', { cls: 'absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-base-content' });
  dot.style.left = 'calc((100% - 0.5rem) * ' + (view.pointPct / 100).toFixed(4) + ')';
  mark.appendChild(dot);
  const out = refusalEl('div', { cls: 'flex flex-col gap-1' }, [
    refusalEl('div', { cls: 'flex items-center gap-2' }, [
      refusalEl('span', { cls: 'text-sm tabular-nums' }, [refusalEl('span', { cls: 'sr-only', text: refusalLabel('cell.point', locale) + ' ' }), view.point]),
      mark,
    ]),
  ]);
  if (view.upper !== null && view.upper !== undefined) {
    out.appendChild(refusalEl('div', { cls: 'text-xs text-base-content/70 tabular-nums', text: refusalLabel('cell.upper', locale, { value: view.upper }) }));
  }
  out.appendChild(refusalEl('div', { cls: 'text-xs text-base-content/70 tabular-nums', text: refusalLabel('cell.n', locale, { n: view.n }) }));
  return out;
}

function refusalCorrectCell(view, locale) {
  if (view.empty) return refusalEl('span', { cls: 'text-sm text-base-content/70', text: view.text });
  return refusalEl('div', { cls: 'flex flex-col gap-1' }, [
    refusalEl('span', { cls: 'text-sm tabular-nums' }, [refusalEl('span', { cls: 'sr-only', text: refusalLabel('cell.point', locale) + ' ' }), view.point]),
    refusalEl('span', { cls: 'text-xs text-base-content/70 tabular-nums', text: refusalLabel('cell.n', locale, { n: view.n }) }),
  ]);
}

class RefusalCalibrationPanel {
  constructor(root, deps) {
    const d = deps || {};
    this.root = root;
    this.locale = refusalLocale(d.locale || refusalDetectLocale());
    this.fetcher = d.fetcher || ((apiPath, init) => window.ragFetch(apiPath, init));
    this.appUrl = d.appUrl || null;
    this.page = d.page || null;
    this.mounted = false;
    this.status = null;
    this.updatedAt = null;
    this.loading = false;
    this.hosts = {
      title: root.querySelector('[data-refusal-title]'),
      description: root.querySelector('[data-refusal-description]'),
      alert: root.querySelector('[data-refusal-alert]'),
      content: root.querySelector('[data-refusal-content]'),
      status: root.querySelector('[data-refusal-status]'),
    };
  }

  t(key, vars) {
    return refusalLabel(key, this.locale, vars);
  }

  async mount() {
    if (!this.mounted) {
      this.mounted = true;
      this.root.setAttribute('lang', this.locale);
      if (this.hosts.title) this.hosts.title.textContent = this.t('panel.title');
      if (this.hosts.description) this.hosts.description.textContent = this.t('panel.description');
      if (this.hosts.status) this.hosts.status.setAttribute('tabindex', '-1');
      this.buildChrome();
    }
    return this.load();
  }

  buildChrome() {
    const content = this.hosts.content;
    if (!content) return;
    this.updatedEl = refusalEl('span', { cls: 'text-xs text-base-content/70' });
    this.refreshButton = refusalEl('button', { cls: 'btn btn-outline btn-sm', attrs: { type: 'button' }, on: { click: () => this.load() } }, [
      refusalIcon('bi-arrow-clockwise'),
      this.t('action.refresh'),
    ]);
    this.body = refusalEl('div', { cls: 'flex flex-col gap-6' });
    content.replaceChildren(refusalEl('div', { cls: 'flex flex-wrap items-center justify-end gap-2 mb-4' }, [this.updatedEl, this.refreshButton]), this.body);
  }

  setStatus(message, isError) {
    const host = this.hosts.status;
    if (!host) return;
    host.replaceChildren();
    host.classList.toggle('text-error', Boolean(isError));
    if (isError) host.appendChild(refusalIcon('bi-exclamation-circle', 'mr-1'));
    if (typeof message === 'string') host.appendChild(document.createTextNode(message));
    else refusalAppendMessage(host, message);
  }

  reloadButton() {
    return refusalEl('button', { cls: 'btn btn-sm', text: this.t('action.reload'), attrs: { type: 'button' }, on: { click: () => this.reload() } });
  }

  reload() {
    if (this.hosts.content) this.hosts.content.hidden = false;
    if (this.hosts.alert) this.hosts.alert.replaceChildren();
    return this.load();
  }

  setBusy(busy) {
    this.loading = busy;
    if (!this.body) return;
    const hasContent = Boolean(this.status);
    this.body.classList.toggle('opacity-60', busy && hasContent);
    if (busy && hasContent) this.body.setAttribute('aria-busy', 'true');
    else this.body.removeAttribute('aria-busy');
    this.refreshButton.disabled = busy;
    this.refreshButton.replaceChildren(busy ? refusalSpinner() : refusalIcon('bi-arrow-clockwise'), this.t('action.refresh'));
    if (busy && !hasContent) {
      this.body.replaceChildren(refusalEl('p', { cls: 'flex items-center gap-2 text-sm text-base-content/70' }, [refusalSpinner(), this.t('status.loading')]));
      this.setStatus(this.t('status.loading'));
    }
  }

  async load() {
    if (this.loading || !this.body) return;
    this.setBusy(true);
    let result;
    try {
      result = (await this.fetcher(REFUSAL_API, { method: 'GET' })) || { thrown: true };
    } catch {
      result = { thrown: true };
    }
    this.setBusy(false);
    if (!result.ok) {
      const mapped = mapRefusalError(result, this.locale, { appUrl: this.appUrl });
      if (mapped.signIn) {
        if (this.hosts.content) this.hosts.content.hidden = true;
        if (this.hosts.alert) this.hosts.alert.replaceChildren(refusalAlert('warning', 'bi-person-lock', mapped, [this.reloadButton()]));
      } else {
        if (this.hosts.alert) this.hosts.alert.replaceChildren(refusalAlert('error', 'bi-exclamation-octagon', mapped, [this.reloadButton()]));
        if (this.status) this.body.classList.add('opacity-60');
        else this.body.replaceChildren();
      }
      this.setStatus(mapped, true);
      return;
    }
    if (this.hosts.alert) this.hosts.alert.replaceChildren();
    this.status = result.body && typeof result.body === 'object' ? result.body : {};
    this.updatedAt = new Date();
    this.render();
    const cells = Array.isArray(this.status.cells) ? this.status.cells.length : 0;
    const warnings = Array.isArray(this.status.warnings) ? this.status.warnings.length : 0;
    this.setStatus(this.t('status.loaded', { cells: refusalNumber(cells, this.locale), warnings: refusalNumber(warnings, this.locale) }));
  }

  render() {
    this.updatedEl.replaceChildren();
    const time = refusalDate(this.updatedAt.toISOString(), this.locale, 'time');
    if (time) refusalAppendMessage(this.updatedEl, refusalMessage('status.updatedAt', this.locale, { time: { time } }));
    this.body.classList.remove('opacity-60');
    this.body.replaceChildren(this.renderSummary(), this.renderWarnings(), this.renderCells());
  }

  renderSummary() {
    const summary = refusalSummary(this.status, this.locale, this.page || refusalPageSettings());
    const dl = refusalEl('dl', { cls: 'grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2' });
    for (const item of summary.items) {
      dl.appendChild(
        refusalEl('div', null, [refusalEl('dt', { cls: 'text-xs text-base-content/70', text: this.t(item.key) }), refusalEl('dd', { cls: 'text-sm', text: item.value })]),
      );
    }
    const nodes = [dl];
    if (summary.models) {
      const tbody = refusalEl('tbody');
      for (const row of summary.models) {
        const cells = [refusalEl('th', { cls: 'font-normal text-sm', text: row.use, attrs: { scope: 'row' } })];
        for (const model of row.models) cells.push(refusalEl('td', { cls: 'font-mono text-xs break-all', text: model }));
        tbody.appendChild(refusalEl('tr', null, cells));
      }
      const head = refusalEl('tr', null, [refusalEl('td')]);
      for (const language of REFUSAL_LANGUAGES) {
        head.appendChild(refusalEl('th', { cls: 'text-xs font-semibold', text: refusalLanguageName(language, this.locale), attrs: { scope: 'col' } }));
      }
      nodes.push(
        refusalEl('div', { cls: 'overflow-x-auto' }, [
          refusalEl('table', { cls: 'table table-sm' }, [
            refusalEl('caption', { cls: 'text-left text-xs font-semibold text-base-content/70 pb-1', text: this.t('models.caption') }),
            refusalEl('thead', null, [head]),
            tbody,
          ]),
        ]),
      );
    }
    nodes.push(refusalMessageEl('p', 'text-xs text-base-content/70', summary.versions));
    for (const note of summary.notes) nodes.push(refusalMessageEl('p', 'text-sm text-base-content/70 max-w-prose', note));
    return refusalEl('div', { cls: 'flex flex-col gap-4' }, nodes);
  }

  renderWarnings() {
    const warnings = Array.isArray(this.status.warnings) ? this.status.warnings : [];
    const list = refusalEl('div', { cls: 'grid gap-2' });
    if (warnings.length === 0) list.appendChild(refusalEl('p', { cls: 'text-sm text-base-content/70', text: this.t('warnings.none') }));
    for (const warning of warnings) {
      const view = refusalWarningView(warning, this.locale, this.status);
      const extra = [];
      if (view.missing.length > 0) {
        const ul = refusalEl('ul', { cls: 'text-xs flex flex-col gap-1 list-disc pl-5' });
        for (const item of view.missing) ul.appendChild(refusalMessageEl('li', '', item));
        extra.push(ul);
      }
      list.appendChild(refusalAlert(view.tone, view.icon, view, extra, view.lang));
    }
    return refusalEl('div', null, [refusalEl('h4', { cls: 'text-base font-semibold mb-2', text: this.t('warnings.heading') }), list]);
  }

  renderCells() {
    const rows = cellRows(this.status, this.locale);
    const nodes = [
      refusalEl('h4', { cls: 'text-base font-semibold', text: this.t('cells.heading') }),
      refusalEl('p', { cls: 'text-xs text-base-content/70 max-w-prose mt-1 mb-2', text: this.t('cells.explain') }),
    ];
    if (rows.length === 0) {
      nodes.push(
        refusalEl('div', { cls: 'py-8 flex flex-col items-center text-center gap-2' }, [
          refusalEl('p', { cls: 'text-base font-semibold', text: this.t('cells.empty.title') }),
          refusalMessageEl('p', 'text-sm text-base-content/70 max-w-prose', refusalMessage('cells.empty.body', this.locale, { command: { code: REFUSAL_CALIBRATE_COMMAND } })),
        ]),
      );
      return refusalEl('div', null, nodes);
    }
    const th = (key, cls, extra) =>
      refusalEl('th', { cls: 'text-xs font-semibold align-bottom ' + (cls || ''), attrs: { scope: 'col', ...(extra || {}) } }, [refusalEl('div', { text: this.t(key) })]);
    const thSub = (key, sub, cls) =>
      refusalEl('th', { cls: 'text-xs font-semibold align-bottom ' + (cls || ''), attrs: { scope: 'col' } }, [
        refusalEl('div', { text: this.t(key) }),
        refusalEl('div', { cls: 'font-normal text-base-content/70', text: this.t(sub) }),
      ]);
    const groupHead = (key) => [
      refusalEl('th', { cls: 'text-xs font-semibold text-center hidden lg:table-cell', text: this.t(key), attrs: { scope: 'colgroup', colspan: '2' } }),
      refusalEl('th', { cls: 'text-xs font-semibold text-center lg:hidden', text: this.t(key), attrs: { scope: 'colgroup', colspan: '1' } }),
    ];
    const head1 = refusalEl('tr', null, [
      th('col.model', '', { rowspan: '2' }),
      th('col.language', '', { rowspan: '2' }),
      th('col.pairing', 'hidden md:table-cell', { rowspan: '2' }),
      th('col.status', '', { rowspan: '2' }),
      th('col.threshold', 'text-right', { rowspan: '2' }),
      ...groupHead('group.dev'),
      ...groupHead('group.holdout'),
      th('col.recorded', 'hidden lg:table-cell', { rowspan: '2' }),
    ]);
    const head2 = refusalEl('tr', null, [
      thSub('col.falseRefusal', 'col.falseRefusalSub'),
      thSub('col.correctRefusal', 'col.correctRefusalSub', 'hidden lg:table-cell'),
      thSub('col.falseRefusal', 'col.falseRefusalSub'),
      thSub('col.correctRefusal', 'col.correctRefusalSub', 'hidden lg:table-cell'),
    ]);
    const tbody = refusalEl('tbody');
    for (const row of rows) {
      const statusCls =
        row.statusKey === 'calibrated'
          ? 'badge badge-success badge-outline badge-sm'
          : row.statusKey === 'failed_holdout'
            ? 'badge badge-warning badge-sm'
            : 'badge badge-ghost badge-sm';
      const badges = refusalEl('div', { cls: 'flex flex-wrap gap-1' }, [refusalEl('span', { cls: statusCls, text: row.statusLabel })]);
      if (row.fixture) badges.appendChild(refusalEl('span', { cls: 'badge badge-info badge-outline badge-sm', text: row.fixtureLabel }));
      if (row.stale) badges.appendChild(refusalEl('span', { cls: 'badge badge-warning badge-outline badge-sm', text: row.staleLabel }));
      tbody.appendChild(
        refusalEl('tr', null, [
          refusalEl('th', { cls: 'font-normal align-top', attrs: { scope: 'row' } }, [
            refusalEl('div', { cls: 'text-sm', text: row.provider }),
            refusalEl('div', { cls: 'font-mono text-xs break-all', text: row.model }),
          ]),
          refusalEl('td', { cls: 'align-top' }, [
            refusalEl('div', { cls: 'text-sm', text: row.language }),
            refusalEl('div', { cls: 'text-xs text-base-content/70 md:hidden', text: row.pairing }),
          ]),
          refusalEl('td', { cls: 'align-top text-sm hidden md:table-cell', text: row.pairing }),
          refusalEl('td', { cls: 'align-top' }, [badges, refusalEl('div', { cls: 'text-xs text-base-content/70 mt-1', text: row.statusHint })]),
          refusalEl('td', { cls: 'align-top text-right tabular-nums text-sm', text: row.threshold }),
          refusalEl('td', { cls: 'align-top' }, [refusalRateCell(row.dev.falseRefusal, this.locale)]),
          refusalEl('td', { cls: 'align-top hidden lg:table-cell' }, [refusalCorrectCell(row.dev.correctRefusal, this.locale)]),
          refusalEl('td', { cls: 'align-top' }, [refusalRateCell(row.holdout.falseRefusal, this.locale)]),
          refusalEl('td', { cls: 'align-top hidden lg:table-cell' }, [refusalCorrectCell(row.holdout.correctRefusal, this.locale)]),
          refusalEl('td', { cls: 'align-top text-sm tabular-nums hidden lg:table-cell' }, [
            row.recorded ? refusalEl('time', { text: row.recorded.text, attrs: { datetime: row.recorded.iso } }) : null,
          ]),
        ]),
      );
    }
    nodes.push(
      refusalEl(
        'div',
        {
          cls: 'overflow-x-auto rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
          attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('cells.caption') },
        },
        [refusalEl('table', { cls: 'table table-sm' }, [refusalEl('caption', { cls: 'sr-only', text: this.t('cells.caption') }), refusalEl('thead', null, [head1, head2]), tbody])],
      ),
    );
    const legend = refusalEl('ul', { cls: 'flex flex-col gap-1 mt-2 text-xs max-w-prose' });
    for (const key of REFUSAL_STATUSES) {
      legend.appendChild(refusalEl('li', null, [refusalEl('span', { cls: 'font-semibold', text: this.t('status.' + key) }), ': ' + this.t('status.hint.' + key)]));
    }
    legend.appendChild(refusalEl('li', { text: this.t('legend.fixture') }));
    legend.appendChild(refusalEl('li', { text: this.t('legend.stale') }));
    nodes.push(
      refusalEl('details', { cls: 'mt-4' }, [
        refusalEl('summary', {
          cls: 'text-sm cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
          text: this.t('legend.summary'),
        }),
        legend,
      ]),
    );
    return refusalEl('div', null, nodes);
  }
}

let REFUSAL_PANEL_INSTANCE = null;

function initRefusalCalibrationPanel() {
  const root = document.getElementById('rag-administration-refusal');
  if (!root) return;
  if (!REFUSAL_PANEL_INSTANCE) {
    REFUSAL_PANEL_INSTANCE = new RefusalCalibrationPanel(root);
    window.refusalCalibrationPanel = REFUSAL_PANEL_INSTANCE;
  }
  REFUSAL_PANEL_INSTANCE.mount();
}

/** Selects the RAG administration tab, scrolls the refusal panel into view and moves focus to its heading. No request of its own. */
function openRefusalCalibrationPanel() {
  const link = document.querySelector('.menu-item[data-tab="rag-administration"]');
  if (link) link.click();
  const section = document.getElementById('rag-administration-refusal');
  if (!section) return;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  const heading = section.querySelector('[data-refusal-title]');
  if (heading) heading.focus({ preventScroll: true });
}

function bindRefusalCalibrationPanel() {
  const locale = refusalDetectLocale();
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-refusal-bound')) return;
    link.setAttribute('data-refusal-bound', '1');
    link.addEventListener('click', () => initRefusalCalibrationPanel());
  });
  document.querySelectorAll('[data-refusal-pointer]').forEach((button) => {
    if (button.getAttribute('data-refusal-bound')) return;
    button.setAttribute('data-refusal-bound', '1');
    button.textContent = refusalLabel('pointer.open', locale);
    button.addEventListener('click', () => openRefusalCalibrationPanel());
  });
  document.querySelectorAll('[data-refusal-pointer-text]').forEach((el) => {
    el.textContent = refusalLabel('pointer.text', locale);
  });
}

if (typeof window !== 'undefined') {
  window.initRefusalCalibrationPanel = initRefusalCalibrationPanel;
  window.openRefusalCalibrationPanel = openRefusalCalibrationPanel;
  window.refusalLabel = refusalLabel;
  window.refusalCellRows = cellRows;
  window.refusalWarningView = refusalWarningView;
  bindRefusalCalibrationPanel();
  document.addEventListener('DOMContentLoaded', () => {
    bindRefusalCalibrationPanel();
    const tab = document.getElementById('rag-administration');
    if (tab && tab.classList.contains('active')) initRefusalCalibrationPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REFUSAL_LABELS,
    refusalLabel,
    refusalMessage,
    cellRows,
    refusalWarningView,
    refusalSummary,
    mapRefusalError,
    RefusalCalibrationPanel,
    initRefusalCalibrationPanel,
  };
}
