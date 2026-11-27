/**
 * Answer rules and output safety card in the RAG Modes tab (D-57, D-58, UI-SPEC 6.11, 6.12, 12.3). The switches are static markup
 * saved by the page; this script adds the read-only blocks from GET /api/config/answer-rules, the combination warnings recomputed from
 * the page's own inputs, and the zh and it texts. DOM through the rag-ui.js helpers (createElement and textContent only); every server
 * value is text and never a link. A failed read leaves every switch usable.
 */

const ANSWER_RULES_ENDPOINT = '/api/config/answer-rules';
const ANSWER_RULES_TIMEOUT_MS = 15000;
const ANSWER_RULES_SWEEP_COMMAND = 'python -m rag_eval.sweep output-cap';
const ANSWER_RULES_JUDGE_COMMAND = 'python -m rag_eval.calibrate groundedness-judge';
const ANSWER_RULES_CAP_MODES = ['strict', 'balanced'];
const ANSWER_RULES_GUARD_MODES = ['off', 'flag', 'enforce'];
const ANSWER_RULES_HOST_IDS = {
  alerts: 'rag-answer-rules-alerts',
  judge: 'rag-answer-rules-judge-calibration',
  caps: 'rag-answer-rules-caps',
  guardNow: 'rag-answer-rules-guard-now',
  allowlist: 'rag-answer-rules-allowlist',
  guardRules: 'rag-answer-rules-guard-rules',
  events: 'rag-answer-rules-events-actions',
};
/** The inputs the combination warnings read; a change or input event on any of them recomputes the warnings. */
const ANSWER_RULES_WATCHED = [
  'RAG_CITATION_PER_SENTENCE',
  'RAG_CITATIONS',
  'RAG_CLAUDE_CITATIONS',
  'RAG_CLAIM_CHECK',
  'RAG_GROUNDEDNESS',
  'RAG_GROUNDEDNESS_LLM_JUDGE',
  'RAG_GROUNDEDNESS_JUDGE_MODEL',
  'RAG_REGISTRY_TEXTS',
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_MAX_OUTPUT_TOKENS',
  'RAG_OUTPUT_GUARD',
  'RAG_OUTPUT_LINK_ALLOWLIST',
  'RAG_SECURITY_EVENTS',
  'RAG_UPLOADER_ALERT_THRESHOLD',
  'RAG_UPLOADER_HOLD',
  'RAG_INGEST_PIPELINE',
];
/** The nine warnings in display order (UI-SPEC 6.12); the server remains the authority. */
const ANSWER_RULES_WARNING_KEYS = [
  'warn.perSentenceNeedsCitations',
  'warn.claimNeedsGroundedness',
  'warn.judgeNeedsModel',
  'warn.judgeSameFamily',
  'warn.registryNeedsLanguages',
  'warn.capAutoEmpty',
  'warn.guardEmptyAllowlist',
  'warn.alertNeedsEvents',
  'warn.holdNeedsApprovalPath',
];
const ANSWER_RULES_INFO_WARNINGS = new Set(['warn.guardEmptyAllowlist']);

const ANSWER_RULES_LABELS = {
  en: {
    'card.title': 'Answer rules and output safety',
    'card.description':
      'Rules added to the answer prompt, checks that run after the answer, and limits on what an answer may contain. All off by default; with every switch off, answers are unchanged.',
    'group.texts': 'Texts in the language of the question',
    'group.claims': 'What an answer may claim',
    'group.sources': 'A source for every sentence',
    'group.length': 'Answer length',
    'group.guard': 'Links and sign-in requests in answers',
    'group.events': 'Security events and uploaders',
    'group.calc': 'Calculations',
    'group.budget': 'Prompt size',
    RAG_CALC_TOOL: 'Offer the calculation tool for questions with numbers or dates',
    'RAG_CALC_TOOL.help': 'The model passes the values and the rule; fixed code does the arithmetic. Models without tool support return the same steps in a block that is removed from the answer.',
    RAG_CALC_CHECK: 'Recompute every calculated number before the answer ends',
    'RAG_CALC_CHECK.help': 'A different result adds a correction under the answer. A value that cannot be found in its source marks the answer “Calculation not verified”.',
    RAG_PROMPT_BUDGET: 'Fit every request into the model’s context window',
    'RAG_PROMPT_BUDGET.help': 'Older conversation turns are dropped first, then the lowest-ranked documents. The question is always kept and always last.',
    RAG_CONTEXT_OVERFLOW: 'If the documents do not fit',
    'overflow.truncate': 'Keep the highest-ranked documents',
    'overflow.refine': 'Answer over several calls',
    'RAG_CONTEXT_OVERFLOW.help': 'Read only while the prompt budget is on. Several calls apply to the web chat only.',
    RAG_REGISTRY_TEXTS: 'Use the language registry for the refusal, notices and badge texts',
    'RAG_REGISTRY_TEXTS.help': 'Off keeps today’s texts. English answers read the same either way. Needs supported languages.',
    RAG_PARTIAL_ANSWER_RULE: 'Answer the covered part and name what the documents do not cover',
    'RAG_PARTIAL_ANSWER_RULE.help': 'Strict mode. Balanced mode labels anything that is not from the documents.',
    RAG_CONTEXT_RELEVANCE_RULE: 'Do not answer from documents on a neighbouring subject',
    'RAG_CONTEXT_RELEVANCE_RULE.help': 'Strict mode gives the “information not available” text; other modes label a general answer.',
    RAG_VERSION_LABELS: 'Label each document’s version and effective date, and answer from the latest',
    'RAG_VERSION_LABELS.help':
      'Two versions that disagree are sent to Versions and dates for your decision. Apply the version-label migration first.',
    RAG_CITATION_PER_SENTENCE: 'Ask for a source on every factual sentence and mark sentences without one',
    'RAG_CITATION_PER_SENTENCE.help': 'Needs inline citations or Claude Citations.',
    RAG_CLAIM_CHECK: 'Check each sentence against the documents after the answer',
    'RAG_CLAIM_CHECK.help': 'Runs after the stream ends. It never delays, deletes or blocks text. Needs groundedness scoring.',
    RAG_GROUNDEDNESS_LLM_JUDGE: 'Use a judge model for languages the groundedness scorer does not cover',
    'RAG_GROUNDEDNESS_LLM_JUDGE.help': 'Off keeps “Not checked” for those languages.',
    RAG_GROUNDEDNESS_JUDGE_MODEL: 'Judge model',
    'judge.egress':
      'Answer sentences and the document passages sent with them go to this model’s provider. Choose a model from a different family than the answer model.',
    'judge.title': 'Judge calibration',
    'judge.col.language': 'Language',
    'judge.col.status': 'Status',
    'judge.calibrated': 'Calibrated',
    'judge.uncalibrated': 'Not calibrated: the answer label stays “Not checked”; sentence marks still show',
    'judge.noneNeeded': 'Every supported language has a groundedness scorer.',
    'judge.command': 'Calibrate with {command}',
    'cap.mode': 'Limit',
    'cap.mode.off': 'Off',
    'cap.mode.auto': 'Chosen by evaluation',
    'cap.mode.fixed': 'Fixed limit',
    'cap.value': 'Limit in tokens',
    'cap.help':
      'Applies to strict and balanced answers that use the knowledge base. Not applied when a request sets its own limit or reasoning is on. The refusal text is never cut.',
    'cap.title': 'Limits chosen by evaluation',
    'cap.col.mode': 'Mode',
    'cap.col.limit': 'Limit',
    'cap.col.source': 'Source',
    'cap.none': 'No limit chosen',
    'cap.source.sweep': 'Evaluation run',
    'cap.source.default': 'Default',
    'cap.floor': 'Smallest limit accepted: {n} tokens',
    'cap.belowFloor': 'Enter {n} or more.',
    'cap.command': 'Choose limits with {command}',
    RAG_OUTPUT_GUARD: 'Answer guard',
    'guard.off': 'Off',
    'guard.flag': 'Record only',
    'guard.enforce': 'Remove and block',
    'guard.now.off': 'Answers are not checked.',
    'guard.now.flag': 'Links and sign-in requests are recorded as security events. The answer text is not changed.',
    'guard.now.enforce':
      'Links, domains and e-mail addresses outside the allowlist are replaced by “(link removed)”. A sentence asking for sign-in details is removed when it comes with a removed link or from flagged content; otherwise a caution is added under the answer.',
    'allow.title': 'Allowed link domains',
    'allow.always':
      'Always allowed: this app’s own domain, web-search results of the same turn, links this app issued and links the user wrote.',
    'allow.empty': 'No domain is on the allowlist.',
    'allow.edit': 'Edit allowlist',
    'guard.rules': 'Sign-in request rules: version {version}; zh: {zh}, en: {en}, it: {it}',
    RAG_SECURITY_EVENTS: 'Record security events with the document’s uploader',
    'RAG_SECURITY_EVENTS.help': 'Stores ids only: no question, answer or document text.',
    RAG_UPLOADER_ALERT_THRESHOLD: 'Alert level: events from one uploader',
    'RAG_UPLOADER_ALERT_THRESHOLD.help': 'An alert opens above this number. 0 means no alerts.',
    RAG_UPLOADER_ALERT_WINDOW_HOURS: 'Window in hours',
    RAG_UPLOADER_HOLD: 'Hold uploads',
    'hold.mode.off': 'Never',
    'hold.mode.manual': 'When an admin chooses',
    'hold.mode.auto': 'Automatically when an alert opens',
    'RAG_UPLOADER_HOLD.help': 'Held uploads wait in Upload approvals. Documents that are already searchable are not touched.',
    'events.open': 'Open security events',
    'data.loading': 'Loading current values…',
    'data.unavailable': 'Current values could not be read from the config server. The switches still work.',
    'copy.command': 'Copy command',
    'copy.done': 'Command copied.',
    'warn.perSentenceNeedsCitations':
      'A source for every sentence needs inline citations or Claude Citations. Until one is on, this switch has no effect.',
    'warn.claimNeedsGroundedness': 'The sentence check needs groundedness scoring. Until it is on, this switch has no effect.',
    'warn.judgeNeedsModel': 'Enter a judge model. Without one the judge does not run.',
    'warn.judgeSameFamily':
      'The judge model is from the same family as the answer model, so the judge does not run. Choose a model from another family.',
    'warn.registryNeedsLanguages': 'Choose supported languages first. Until then today’s texts stay in use.',
    'warn.capAutoEmpty': 'No limit has been chosen by evaluation yet, so answers are not limited.',
    'warn.guardEmptyAllowlist':
      'The allowlist is empty: every link in an answer is removed, except the ones listed under “Always allowed”.',
    'warn.alertNeedsEvents':
      'Alerts and holds need recorded security events. Turn on “Record security events with the document’s uploader”.',
    'warn.holdNeedsApprovalPath':
      'Holding uploads needs the unified ingestion pipeline. With the legacy pipeline nothing is held.',
  },
  zh: {
    'card.title': '回答规则与输出安全',
    'card.description': '追加到回答提示词的规则、回答之后运行的检查，以及对回答内容的限制。默认全部关闭；全部关闭时，回答保持不变。',
    'group.texts': '按提问语言显示固定文本',
    'group.claims': '回答可以陈述的内容',
    'group.sources': '每句话都要有来源',
    'group.length': '回答长度',
    'group.guard': '回答中的链接与登录信息请求',
    'group.events': '安全事件与上传者',
    'group.calc': '计算',
    'group.budget': '提示词大小',
    RAG_CALC_TOOL: '对含有数字或日期的问题提供计算工具',
    'RAG_CALC_TOOL.help': '模型提供数值和规则，由固定代码完成运算。不支持工具的模型会在一个从回答中移除的区块里返回相同的步骤。',
    RAG_CALC_CHECK: '在回答结束前重新计算每个算出的数字',
    'RAG_CALC_CHECK.help': '结果不同时，会在回答下方添加更正。数值在其来源中找不到时，回答会标为“计算未核实”。',
    RAG_PROMPT_BUDGET: '让每个请求都不超出模型的上下文窗口',
    'RAG_PROMPT_BUDGET.help': '先舍弃较早的对话轮次，再舍弃排名最低的文档。问题始终保留并放在最后。',
    RAG_CONTEXT_OVERFLOW: '文档放不下时',
    'overflow.truncate': '保留排名最高的文档',
    'overflow.refine': '分多次调用作答',
    'RAG_CONTEXT_OVERFLOW.help': '仅在提示词预算开启时生效。多次调用仅适用于网页聊天。',
    RAG_REGISTRY_TEXTS: '拒答、提示和徽标文本使用语言注册表',
    'RAG_REGISTRY_TEXTS.help': '关闭时保留现有文本。英文回答在两种情况下都相同。需要先选择支持的语言。',
    RAG_PARTIAL_ANSWER_RULE: '回答文档覆盖的部分，并说明文档未涉及的部分',
    'RAG_PARTIAL_ANSWER_RULE.help': '适用于严格模式。平衡模式会标注所有非文档内容。',
    RAG_CONTEXT_RELEVANCE_RULE: '不使用相邻主题的文档来回答',
    'RAG_CONTEXT_RELEVANCE_RULE.help': '严格模式给出“暂无相关信息”文本；其他模式会标注通用回答。',
    RAG_VERSION_LABELS: '标注每份文档的版本和生效日期，并以最新版本作答',
    'RAG_VERSION_LABELS.help': '内容不一致的两个版本会送到“版本与日期”等待你决定。请先应用版本标签迁移。',
    RAG_CITATION_PER_SENTENCE: '要求每个事实句都有来源，并标记没有来源的句子',
    'RAG_CITATION_PER_SENTENCE.help': '需要开启行内引用或 Claude Citations。',
    RAG_CLAIM_CHECK: '回答结束后逐句对照文档检查',
    'RAG_CLAIM_CHECK.help': '在流式输出结束后运行，不会延迟、删除或拦截文本。需要开启可靠性评分。',
    RAG_GROUNDEDNESS_LLM_JUDGE: '对评分器不支持的语言使用评审模型',
    'RAG_GROUNDEDNESS_LLM_JUDGE.help': '关闭时，这些语言保持“未核验”。',
    RAG_GROUNDEDNESS_JUDGE_MODEL: '评审模型',
    'judge.egress': '回答的句子及随附的文档片段会发送给该模型的提供方。请选择与回答模型不同系列的模型。',
    'judge.title': '评审校准',
    'judge.col.language': '语言',
    'judge.col.status': '状态',
    'judge.calibrated': '已校准',
    'judge.uncalibrated': '未校准：回答标签保持“未核验”，句子标记仍会显示',
    'judge.noneNeeded': '所有支持的语言都有评分器。',
    'judge.command': '使用 {command} 进行校准',
    'cap.mode': '上限',
    'cap.mode.off': '关闭',
    'cap.mode.auto': '由评估选定',
    'cap.mode.fixed': '固定上限',
    'cap.value': '上限（token 数）',
    'cap.help': '适用于使用知识库的严格和平衡模式回答。请求自带上限或开启推理时不适用。拒答文本不会被截断。',
    'cap.title': '由评估选定的上限',
    'cap.col.mode': '模式',
    'cap.col.limit': '上限',
    'cap.col.source': '来源',
    'cap.none': '尚未选定上限',
    'cap.source.sweep': '评估运行',
    'cap.source.default': '默认',
    'cap.floor': '可接受的最小上限：{n} token',
    'cap.belowFloor': '请输入不小于 {n} 的数值。',
    'cap.command': '使用 {command} 选定上限',
    RAG_OUTPUT_GUARD: '回答防护',
    'guard.off': '关闭',
    'guard.flag': '仅记录',
    'guard.enforce': '移除并拦截',
    'guard.now.off': '不检查回答。',
    'guard.now.flag': '链接和登录信息请求会记录为安全事件，回答文本不变。',
    'guard.now.enforce':
      '白名单之外的链接、域名和电子邮件地址会替换为“（链接已移除）”。索取登录信息的句子如伴随被移除的链接或来自被标记的内容，会被移除；否则在回答下方添加提醒。',
    'allow.title': '允许的链接域名',
    'allow.always': '始终允许：本应用自身的域名、同一轮的网络搜索结果、本应用生成的链接以及用户自己写的链接。',
    'allow.empty': '白名单中没有域名。',
    'allow.edit': '编辑白名单',
    'guard.rules': '登录信息请求规则：版本 {version}；zh：{zh}，en：{en}，it：{it}',
    RAG_SECURITY_EVENTS: '记录安全事件及文档上传者',
    'RAG_SECURITY_EVENTS.help': '只保存标识，不保存问题、回答或文档文本。',
    RAG_UPLOADER_ALERT_THRESHOLD: '提醒级别：单个上传者的事件数',
    'RAG_UPLOADER_ALERT_THRESHOLD.help': '超过该数值时发出提醒。0 表示不提醒。',
    RAG_UPLOADER_ALERT_WINDOW_HOURS: '统计窗口（小时）',
    RAG_UPLOADER_HOLD: '暂缓上传',
    'hold.mode.off': '从不',
    'hold.mode.manual': '由管理员决定',
    'hold.mode.auto': '提醒发出时自动执行',
    'RAG_UPLOADER_HOLD.help': '被暂缓的上传在“上传审批”中等待。已可检索的文档不受影响。',
    'events.open': '打开安全事件',
    'data.loading': '正在加载当前值…',
    'data.unavailable': '无法从配置服务器读取当前值。开关仍可使用。',
    'copy.command': '复制命令',
    'copy.done': '命令已复制。',
    'warn.perSentenceNeedsCitations': '“每句话都要有来源”需要开启行内引用或 Claude Citations。开启之前，此开关不起作用。',
    'warn.claimNeedsGroundedness': '逐句检查需要开启可靠性评分。开启之前，此开关不起作用。',
    'warn.judgeNeedsModel': '请填写评审模型。未填写时评审不会运行。',
    'warn.judgeSameFamily': '评审模型与回答模型属于同一系列，因此评审不会运行。请选择其他系列的模型。',
    'warn.registryNeedsLanguages': '请先选择支持的语言。在此之前继续使用现有文本。',
    'warn.capAutoEmpty': '评估尚未选定上限，因此回答不受限制。',
    'warn.guardEmptyAllowlist': '白名单为空：回答中的所有链接都会被移除，“始终允许”中列出的除外。',
    'warn.alertNeedsEvents': '提醒和暂缓上传需要记录安全事件。请开启“记录安全事件及文档上传者”。',
    'warn.holdNeedsApprovalPath': '暂缓上传需要统一的入库流程。使用旧流程时不会暂缓任何上传。',
  },
  it: {
    'card.title': "Regole di risposta e sicurezza dell'output",
    'card.description':
      'Regole aggiunte al prompt di risposta, controlli eseguiti dopo la risposta e limiti su ciò che una risposta può contenere. Tutto disattivato per impostazione predefinita; con ogni interruttore spento le risposte non cambiano.',
    'group.texts': 'Testi nella lingua della domanda',
    'group.claims': 'Che cosa può affermare una risposta',
    'group.sources': 'Una fonte per ogni frase',
    'group.length': 'Lunghezza della risposta',
    'group.guard': 'Link e richieste di accesso nelle risposte',
    'group.events': 'Eventi di sicurezza e autori dei caricamenti',
    'group.calc': 'Calcoli',
    'group.budget': 'Dimensione del prompt',
    RAG_CALC_TOOL: 'Offri lo strumento di calcolo per domande con numeri o date',
    'RAG_CALC_TOOL.help': 'Il modello passa i valori e la regola; il calcolo è eseguito da codice fisso. I modelli senza supporto agli strumenti restituiscono gli stessi passaggi in un blocco rimosso dalla risposta.',
    RAG_CALC_CHECK: 'Ricalcola ogni numero calcolato prima che la risposta termini',
    'RAG_CALC_CHECK.help': 'Un risultato diverso aggiunge una correzione sotto la risposta. Un valore non trovato nella sua fonte contrassegna la risposta come “Calcolo non verificato”.',
    RAG_PROMPT_BUDGET: 'Fai rientrare ogni richiesta nella finestra di contesto del modello',
    'RAG_PROMPT_BUDGET.help': 'Vengono eliminati prima i turni di conversazione più vecchi, poi i documenti con il punteggio più basso. La domanda è sempre mantenuta e sempre ultima.',
    RAG_CONTEXT_OVERFLOW: 'Se i documenti non rientrano',
    'overflow.truncate': 'Mantieni i documenti con il punteggio più alto',
    'overflow.refine': 'Rispondi con più chiamate',
    'RAG_CONTEXT_OVERFLOW.help': 'Letto solo con il budget del prompt attivo. Le chiamate multiple valgono solo per la chat web.',
    RAG_REGISTRY_TEXTS: 'Usa il registro delle lingue per rifiuto, avvisi e testi del badge',
    'RAG_REGISTRY_TEXTS.help': 'Spento mantiene i testi attuali. Le risposte in inglese restano identiche. Richiede le lingue supportate.',
    RAG_PARTIAL_ANSWER_RULE: 'Rispondi alla parte coperta e indica ciò che i documenti non coprono',
    'RAG_PARTIAL_ANSWER_RULE.help': 'Modalità rigorosa. La modalità bilanciata etichetta ciò che non proviene dai documenti.',
    RAG_CONTEXT_RELEVANCE_RULE: 'Non rispondere con documenti su un argomento vicino',
    'RAG_CONTEXT_RELEVANCE_RULE.help':
      'La modalità rigorosa mostra il testo “informazione non disponibile”; le altre etichettano una risposta generale.',
    RAG_VERSION_LABELS: 'Etichetta versione e data di validità di ogni documento e rispondi dalla più recente',
    'RAG_VERSION_LABELS.help':
      "Due versioni in disaccordo vengono inviate a Versioni e date per la tua decisione. Applica prima la migrazione dell'etichetta di versione.",
    RAG_CITATION_PER_SENTENCE: 'Richiedi una fonte per ogni frase fattuale e segnala quelle che ne sono prive',
    'RAG_CITATION_PER_SENTENCE.help': 'Richiede le citazioni in linea o Claude Citations.',
    RAG_CLAIM_CHECK: 'Controlla ogni frase sui documenti dopo la risposta',
    'RAG_CLAIM_CHECK.help': 'Viene eseguito al termine dello stream. Non ritarda, elimina o blocca il testo. Richiede il punteggio di fondatezza.',
    RAG_GROUNDEDNESS_LLM_JUDGE: 'Usa un modello giudice per le lingue non coperte dal valutatore',
    'RAG_GROUNDEDNESS_LLM_JUDGE.help': 'Spento mantiene “Non verificata” per quelle lingue.',
    RAG_GROUNDEDNESS_JUDGE_MODEL: 'Modello giudice',
    'judge.egress':
      'Le frasi della risposta e i passaggi dei documenti inviati con esse vanno al fornitore di questo modello. Scegli un modello di una famiglia diversa da quella del modello di risposta.',
    'judge.title': 'Calibrazione del giudice',
    'judge.col.language': 'Lingua',
    'judge.col.status': 'Stato',
    'judge.calibrated': 'Calibrato',
    'judge.uncalibrated': "Non calibrato: l'etichetta resta “Non verificata”; i segni sulle frasi restano visibili",
    'judge.noneNeeded': 'Ogni lingua supportata ha un valutatore.',
    'judge.command': 'Calibra con {command}',
    'cap.mode': 'Limite',
    'cap.mode.off': 'Spento',
    'cap.mode.auto': 'Scelto dalla valutazione',
    'cap.mode.fixed': 'Limite fisso',
    'cap.value': 'Limite in token',
    'cap.help':
      'Si applica alle risposte rigorose e bilanciate che usano la base di conoscenza. Non si applica se la richiesta ha un proprio limite o il ragionamento è attivo. Il testo di rifiuto non viene mai troncato.',
    'cap.title': 'Limiti scelti dalla valutazione',
    'cap.col.mode': 'Modalità',
    'cap.col.limit': 'Limite',
    'cap.col.source': 'Origine',
    'cap.none': 'Nessun limite scelto',
    'cap.source.sweep': 'Esecuzione di valutazione',
    'cap.source.default': 'Predefinito',
    'cap.floor': 'Limite minimo accettato: {n} token',
    'cap.belowFloor': 'Inserisci {n} o più.',
    'cap.command': 'Scegli i limiti con {command}',
    RAG_OUTPUT_GUARD: 'Protezione delle risposte',
    'guard.off': 'Spento',
    'guard.flag': 'Solo registrazione',
    'guard.enforce': 'Rimuovi e blocca',
    'guard.now.off': 'Le risposte non vengono controllate.',
    'guard.now.flag': 'Link e richieste di accesso sono registrati come eventi di sicurezza. Il testo della risposta non cambia.',
    'guard.now.enforce':
      "Link, domini e indirizzi e-mail fuori dall'elenco consentito sono sostituiti da “(link rimosso)”. Una frase che chiede dati di accesso viene rimossa se accompagna un link rimosso o proviene da contenuto segnalato; altrimenti sotto la risposta compare un avviso.",
    'allow.title': 'Domini dei link consentiti',
    'allow.always':
      "Sempre consentiti: il dominio di questa app, i risultati della ricerca web dello stesso turno, i link emessi dall'app e quelli scritti dall'utente.",
    'allow.empty': "Nessun dominio nell'elenco consentito.",
    'allow.edit': 'Modifica elenco consentito',
    'guard.rules': 'Regole per le richieste di accesso: versione {version}; zh: {zh}, en: {en}, it: {it}',
    RAG_SECURITY_EVENTS: "Registra gli eventi di sicurezza con l'autore del caricamento",
    'RAG_SECURITY_EVENTS.help': 'Salva solo identificativi: nessun testo di domande, risposte o documenti.',
    RAG_UPLOADER_ALERT_THRESHOLD: 'Livello di allerta: eventi da un solo autore',
    'RAG_UPLOADER_ALERT_THRESHOLD.help': 'Un avviso si apre oltre questo numero. 0 significa nessun avviso.',
    RAG_UPLOADER_ALERT_WINDOW_HOURS: 'Finestra in ore',
    RAG_UPLOADER_HOLD: 'Sospendi i caricamenti',
    'hold.mode.off': 'Mai',
    'hold.mode.manual': 'Quando lo decide un amministratore',
    'hold.mode.auto': "Automaticamente all'apertura di un avviso",
    'RAG_UPLOADER_HOLD.help': 'I caricamenti sospesi attendono in Approvazione caricamenti. I documenti già ricercabili non vengono toccati.',
    'events.open': 'Apri eventi di sicurezza',
    'data.loading': 'Caricamento dei valori attuali…',
    'data.unavailable': 'Impossibile leggere i valori attuali dal server di configurazione. Gli interruttori funzionano comunque.',
    'copy.command': 'Copia comando',
    'copy.done': 'Comando copiato.',
    'warn.perSentenceNeedsCitations':
      'Una fonte per ogni frase richiede le citazioni in linea o Claude Citations. Finché non sono attive, questo interruttore non ha effetto.',
    'warn.claimNeedsGroundedness':
      'Il controllo delle frasi richiede il punteggio di fondatezza. Finché non è attivo, questo interruttore non ha effetto.',
    'warn.judgeNeedsModel': 'Inserisci un modello giudice. Senza, il giudice non viene eseguito.',
    'warn.judgeSameFamily':
      "Il modello giudice è della stessa famiglia del modello di risposta, quindi non viene eseguito. Scegli un modello di un'altra famiglia.",
    'warn.registryNeedsLanguages': 'Scegli prima le lingue supportate. Fino ad allora restano in uso i testi attuali.',
    'warn.capAutoEmpty': 'La valutazione non ha ancora scelto un limite, quindi le risposte non sono limitate.',
    'warn.guardEmptyAllowlist':
      "L'elenco consentito è vuoto: ogni link nelle risposte viene rimosso, tranne quelli indicati in “Sempre consentiti”.",
    'warn.alertNeedsEvents':
      "Avvisi e sospensioni richiedono la registrazione degli eventi di sicurezza. Attiva “Registra gli eventi di sicurezza con l'autore del caricamento”.",
    'warn.holdNeedsApprovalPath':
      'La sospensione dei caricamenti richiede la pipeline di acquisizione unificata. Con quella precedente nulla viene sospeso.',
  },
};

let answerRulesUi = null;
let answerRulesPanelInstance = null;
if (typeof require !== 'undefined') {
  try {
    answerRulesUi = require('./rag-ui.js');
  } catch {
    answerRulesUi = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function answerRulesUiLib() {
  if (answerRulesUi) return answerRulesUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

function answerRulesLabel(key, locale, vars) {
  const text = answerRulesUiLib().ragUiLookup(ANSWER_RULES_LABELS, key, locale, vars);
  return text === undefined ? key : text;
}

function answerRulesIsCount(value) {
  return Number.isInteger(value) && value >= 0;
}

/** The response contract of GET /api/config/answer-rules; anything else counts as unavailable. */
function isAnswerRulesSummary(summary) {
  if (!summary || typeof summary !== 'object') return false;
  const caps = summary.caps;
  const capsOk =
    Array.isArray(caps) &&
    caps.length === ANSWER_RULES_CAP_MODES.length &&
    ANSWER_RULES_CAP_MODES.every((mode) => caps.filter((cell) => cell && cell.mode === mode).length === 1) &&
    caps.every((cell) => (cell.limit === null || (Number.isInteger(cell.limit) && cell.limit > 0)) && (cell.source === 'default' || cell.source === 'sweep'));
  const judgeOk =
    Array.isArray(summary.judgeLanguages) &&
    summary.judgeLanguages.every((row) => row && typeof row.language === 'string' && row.language !== '' && typeof row.calibrated === 'boolean');
  const counts = summary.ruleCounts;
  return Boolean(
    capsOk &&
      Number.isInteger(summary.floor) &&
      summary.floor > 0 &&
      judgeOk &&
      (summary.sameFamily === null || typeof summary.sameFamily === 'boolean') &&
      Array.isArray(summary.allowlist) &&
      summary.allowlist.every((entry) => typeof entry === 'string') &&
      typeof summary.rulesVersion === 'string' &&
      counts &&
      typeof counts === 'object' &&
      !Array.isArray(counts) &&
      Object.keys(counts).length > 0 &&
      Object.keys(counts).every((lang) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang) && answerRulesIsCount(counts[lang])),
  );
}

/** The view model of the read-only blocks: named fields only, never the summary's own keys (UI-SPEC section 11, item 8). */
function answerRulesRows(summary, locale) {
  const t = (key, vars) => answerRulesLabel(key, locale, vars);
  const ui = answerRulesUiLib();
  return {
    caps: ANSWER_RULES_CAP_MODES.map((mode) => {
      const cell = summary.caps.find((entry) => entry.mode === mode);
      return {
        mode,
        limit: cell.limit === null ? t('cap.none') : ui.ragUiFormatNumber(cell.limit, locale),
        numeric: cell.limit !== null,
        source: t(cell.source === 'sweep' ? 'cap.source.sweep' : 'cap.source.default'),
      };
    }),
    capsEmpty: summary.caps.every((cell) => cell.limit === null),
    floor: summary.floor,
    judge: summary.judgeLanguages.map((row) => ({
      language: row.language,
      status: t(row.calibrated ? 'judge.calibrated' : 'judge.uncalibrated'),
    })),
    sameFamily: summary.sameFamily,
    allowlist: summary.allowlist.slice(),
    rules: Object.assign(
      { version: summary.rulesVersion },
      Object.fromEntries(Object.keys(summary.ruleCounts).map((lang) => [lang, ui.ragUiFormatNumber(summary.ruleCounts[lang], locale)])),
    ),
  };
}

/** Allowlist lines of the page's own field (the Phase 3.2 Checks sub-view): one entry per comma or line, lower case, once each. */
function answerRulesParseAllowlist(value) {
  const hosts = [];
  for (const raw of String(value || '').split(/[\n\r,]+/)) {
    const host = raw.trim().toLowerCase().replace(/\.$/, '');
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * D-58: the warning keys that hold for the page's own input values. state: the switch values read from the page; summary: the
 * loaded summary or null (warnings that need it are not shown before it loads); allowlist: the entries in force or null.
 */
function answerRulesWarnings(state, summary, allowlist) {
  const shown = new Set();
  if (state.perSentence && !state.citations && !state.claudeCitations) shown.add('warn.perSentenceNeedsCitations');
  if (state.claimCheck && !state.groundedness) shown.add('warn.claimNeedsGroundedness');
  if (state.llmJudge && state.judgeModel.trim() === '') shown.add('warn.judgeNeedsModel');
  if (summary && summary.sameFamily === true && state.judgeModelUnchanged && state.judgeModel.trim() !== '') shown.add('warn.judgeSameFamily');
  if (state.registryTexts && state.supportedLanguages.trim() === '') shown.add('warn.registryNeedsLanguages');
  if (summary && state.maxOutputTokens === 'auto' && summary.caps.every((cell) => cell.limit === null)) shown.add('warn.capAutoEmpty');
  if (state.guard === 'enforce' && Array.isArray(allowlist) && allowlist.length === 0) shown.add('warn.guardEmptyAllowlist');
  const threshold = parseInt(state.alertThreshold, 10);
  const holding = state.hold !== '' && state.hold !== 'off';
  if (((Number.isFinite(threshold) && threshold > 0) || holding) && !state.securityEvents) shown.add('warn.alertNeedsEvents');
  if (holding && state.ingestPipeline !== 'unified') shown.add('warn.holdNeedsApprovalPath');
  return ANSWER_RULES_WARNING_KEYS.filter((key) => shown.has(key));
}

async function loadAnswerRulesSummary(options = {}) {
  const fetcher =
    options.fetcher ||
    (typeof window !== 'undefined' && typeof window.fetch === 'function'
      ? (url, init) => window.fetch(url, init)
      : typeof fetch === 'function'
        ? (url, init) => fetch(url, init)
        : null);
  if (!fetcher) return null;
  const init = { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } };
  let timer = null;
  if (typeof AbortController === 'function') {
    const controller = new AbortController();
    init.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), options.timeoutMs || ANSWER_RULES_TIMEOUT_MS);
  }
  try {
    const response = await fetcher(ANSWER_RULES_ENDPOINT, init);
    if (!response || !response.ok) return null;
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return isAnswerRulesSummary(body) ? body : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class AnswerRulesPanel {
  constructor(root, options = {}) {
    this.root = root;
    this.doc = options.doc || root.ownerDocument || (typeof document !== 'undefined' ? document : null);
    this.fetcher = options.fetcher || null;
    this.locale = options.locale || answerRulesUiLib().ragUiBrowserLocale();
    this.summary = null;
    this.state = 'idle';
    this.loadedJudgeModel = null;
    this.warningSignature = null;
    this.guardNowMode = null;
  }

  t(key, vars) {
    return answerRulesLabel(key, this.locale, vars);
  }

  el(tag, options, children) {
    return answerRulesUiLib().ragUiEl(this.doc, tag, options, children);
  }

  host(name) {
    return this.doc.getElementById(ANSWER_RULES_HOST_IDS[name]);
  }

  control(id) {
    return this.doc.getElementById(id);
  }

  checked(id) {
    const el = this.control(id);
    return Boolean(el && el.checked);
  }

  value(id) {
    const el = this.control(id);
    return el && el.value !== undefined && el.value !== null ? String(el.value) : '';
  }

  mount() {
    this.applyTexts();
    for (const id of ANSWER_RULES_WATCHED) {
      const el = this.control(id);
      if (!el) continue;
      el.addEventListener('change', () => this.update());
      el.addEventListener('input', () => this.update());
    }
    this.renderGuardNow();
    this.renderEventsAction();
    this.update();
    return this.load();
  }

  /** zh and it on mount through data-rag-i18n; English stays the static HTML (UI-SPEC 6.11). */
  applyTexts() {
    this.root.setAttribute('lang', this.locale);
    if (this.locale === 'en') return;
    for (const el of this.root.querySelectorAll('[data-rag-i18n]')) {
      const key = el.getAttribute('data-rag-i18n');
      const text = ANSWER_RULES_LABELS[this.locale][key];
      if (typeof text === 'string') el.textContent = text;
    }
    for (const el of this.root.querySelectorAll('[data-rag-i18n-template]')) {
      const text = ANSWER_RULES_LABELS[this.locale][el.getAttribute('data-rag-i18n-template')];
      if (typeof text === 'string') el.setAttribute('data-template', text);
    }
  }

  async load() {
    if (this.state === 'loading' || this.state === 'loaded') return this.summary;
    this.state = 'loading';
    this.renderBlocks();
    const summary = await loadAnswerRulesSummary({ fetcher: this.fetcher });
    this.summary = summary;
    this.state = summary ? 'loaded' : 'failed';
    if (summary) {
      this.loadedJudgeModel = this.value('RAG_GROUNDEDNESS_JUDGE_MODEL').trim();
      this.applyFloor(summary.floor);
    } else {
      console.warn('[Answer Rules] summary unavailable');
    }
    this.renderBlocks();
    this.update();
    return summary;
  }

  /** The smallest accepted limit (D-31): the number input's min, and a stored fixed value under it is marked invalid. */
  applyFloor(floor) {
    const amount = this.root.querySelector('[data-answer-cap="value"]');
    const error = this.root.querySelector('[data-answer-cap="value-error"]');
    if (!amount) return;
    amount.setAttribute('min', String(floor));
    const stored = this.value('RAG_MAX_OUTPUT_TOKENS').trim();
    if (/^[1-9][0-9]*$/.test(stored) && parseInt(stored, 10) < floor) {
      amount.setAttribute('aria-invalid', 'true');
      if (error) error.textContent = (error.getAttribute('data-template') || this.t('cap.belowFloor')).replace('{n}', String(floor));
    }
  }

  readState() {
    const judgeModel = this.value('RAG_GROUNDEDNESS_JUDGE_MODEL');
    return {
      perSentence: this.checked('RAG_CITATION_PER_SENTENCE'),
      citations: this.checked('RAG_CITATIONS'),
      claudeCitations: this.checked('RAG_CLAUDE_CITATIONS'),
      claimCheck: this.checked('RAG_CLAIM_CHECK'),
      groundedness: this.checked('RAG_GROUNDEDNESS'),
      llmJudge: this.checked('RAG_GROUNDEDNESS_LLM_JUDGE'),
      judgeModel,
      judgeModelUnchanged: this.loadedJudgeModel !== null && judgeModel.trim() === this.loadedJudgeModel,
      registryTexts: this.checked('RAG_REGISTRY_TEXTS'),
      supportedLanguages: this.value('RAG_SUPPORTED_LANGUAGES'),
      maxOutputTokens: this.value('RAG_MAX_OUTPUT_TOKENS').trim(),
      guard: this.value('RAG_OUTPUT_GUARD') || 'off',
      securityEvents: this.checked('RAG_SECURITY_EVENTS'),
      alertThreshold: this.value('RAG_UPLOADER_ALERT_THRESHOLD'),
      hold: this.value('RAG_UPLOADER_HOLD') || 'off',
      ingestPipeline: this.value('RAG_INGEST_PIPELINE'),
    };
  }

  /** The entries in force: the page's Phase 3.2 field when present, else the summary, else unknown (null). */
  currentAllowlist() {
    const field = this.control('RAG_OUTPUT_LINK_ALLOWLIST');
    if (field) return answerRulesParseAllowlist(field.value);
    return this.summary ? this.summary.allowlist.slice() : null;
  }

  update() {
    this.renderWarnings();
    this.renderGuardNow();
    if (this.control('RAG_OUTPUT_LINK_ALLOWLIST') || this.state !== 'loading') this.renderAllowlist();
  }

  renderWarnings() {
    const alerts = this.host('alerts');
    if (!alerts) return;
    const ui = answerRulesUiLib();
    const nodes = [];
    if (this.state === 'failed') {
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', body: [this.t('data.unavailable')], className: 'mb-2' }));
    }
    const keys = answerRulesWarnings(this.readState(), this.summary, this.currentAllowlist());
    const signature = this.state + '|' + keys.join(',');
    if (signature === this.warningSignature) return;
    this.warningSignature = signature;
    for (const key of keys) {
      const info = ANSWER_RULES_INFO_WARNINGS.has(key);
      const alert = ui.ragUiAlert(this.doc, {
        tone: info ? 'info' : 'warning',
        icon: info ? 'info-circle' : 'exclamation-triangle',
        body: [this.t(key)],
        className: 'mb-2',
      });
      alert.setAttribute('data-answer-rules-warning', key);
      nodes.push(alert);
    }
    alerts.replaceChildren(...nodes);
  }

  renderGuardNow() {
    const host = this.host('guardNow');
    if (!host) return;
    const mode = ANSWER_RULES_GUARD_MODES.includes(this.value('RAG_OUTPUT_GUARD')) ? this.value('RAG_OUTPUT_GUARD') : 'off';
    if (mode === this.guardNowMode) return;
    this.guardNowMode = mode;
    host.replaceChildren(this.el('p', { className: 'text-sm mt-2 max-w-prose break-words', text: this.t(`guard.now.${mode}`) }));
  }

  renderBlocks() {
    if (this.state === 'loading') {
      for (const name of ['judge', 'caps', 'guardRules']) this.renderLoading(this.host(name));
      if (!this.control('RAG_OUTPUT_LINK_ALLOWLIST')) this.renderLoading(this.host('allowlist'));
      else this.renderAllowlist();
      return;
    }
    if (this.state === 'failed') {
      for (const name of ['judge', 'caps', 'guardRules']) this.renderDash(this.host(name));
      if (this.control('RAG_OUTPUT_LINK_ALLOWLIST')) this.renderAllowlist();
      else this.renderDash(this.host('allowlist'));
      return;
    }
    const rows = answerRulesRows(this.summary, this.locale);
    this.renderJudge(rows);
    this.renderCaps(rows);
    this.renderAllowlist();
    this.renderRules(rows);
  }

  renderLoading(host) {
    if (!host) return;
    host.replaceChildren(this.el('div', { className: 'mt-2' }, [answerRulesUiLib().ragUiSpinner(this.doc, this.t('data.loading'))]));
  }

  renderDash(host) {
    if (host) host.replaceChildren(this.el('p', { className: 'text-sm text-base-content/70 mt-2', text: '—' }));
  }

  code(text) {
    return this.el('code', { className: 'font-mono text-xs break-all', text, attrs: { translate: 'no' } });
  }

  /** A command line with Copy command; the copy result is announced in a polite status line. */
  commandLine(templateKey, command) {
    const ui = answerRulesUiLib();
    const status = this.el('span', { className: 'text-xs text-base-content/70', attrs: { role: 'status', 'aria-live': 'polite' } });
    const commandId = ui.ragUiNextId('rag-answer-rules-command');
    const button = this.el('button', { className: 'btn btn-ghost btn-sm', text: this.t('copy.command'), attrs: { type: 'button', 'aria-describedby': commandId } });
    button.addEventListener('click', () => {
      const clipboard = typeof navigator !== 'undefined' && navigator && navigator.clipboard ? navigator.clipboard : null;
      if (!clipboard || typeof clipboard.writeText !== 'function') return;
      Promise.resolve(clipboard.writeText(command))
        .then(() => {
          status.textContent = this.t('copy.done');
        })
        .catch(() => {});
    });
    return this.el('div', { className: 'flex flex-wrap items-center gap-2 mt-2 min-w-0' }, [
      this.el('p', { className: 'text-sm min-w-0 break-words', id: commandId }, ui.ragUiTemplateNodes(this.doc, this.t(templateKey), { command }, ['command'])),
      button,
      status,
    ]);
  }

  table(caption, headers, rows) {
    const head = this.el('thead', {}, [this.el('tr', {}, headers.map((h) => this.el('th', { className: h.numeric ? 'text-right' : '', text: h.label, attrs: { scope: 'col' } })))]);
    const body = this.el('tbody', {}, rows);
    return this.el('div', { className: 'overflow-x-auto mt-4' }, [
      this.el('table', { className: 'table table-sm' }, [
        this.el('caption', { className: 'text-left text-sm font-semibold mb-1', text: caption }),
        head,
        body,
      ]),
    ]);
  }

  renderJudge(rows) {
    const host = this.host('judge');
    if (!host) return;
    if (rows.judge.length === 0) {
      host.replaceChildren(this.el('p', { className: 'text-sm text-base-content/70 mt-2 max-w-prose break-words', text: this.t('judge.noneNeeded') }));
      return;
    }
    const body = rows.judge.map((row) =>
      this.el('tr', {}, [this.el('td', {}, [this.code(row.language)]), this.el('td', { className: 'break-words', text: row.status })]),
    );
    host.replaceChildren(
      this.table(this.t('judge.title'), [{ label: this.t('judge.col.language') }, { label: this.t('judge.col.status') }], body),
      this.commandLine('judge.command', ANSWER_RULES_JUDGE_COMMAND),
    );
  }

  renderCaps(rows) {
    const host = this.host('caps');
    if (!host) return;
    const body = rows.caps.map((row) =>
      this.el('tr', {}, [
        this.el('td', {}, [this.code(row.mode)]),
        this.el('td', { className: 'text-right' + (row.numeric ? ' tabular-nums' : ''), text: row.limit }),
        this.el('td', { text: row.source }),
      ]),
    );
    host.replaceChildren(
      this.table(
        this.t('cap.title'),
        [{ label: this.t('cap.col.mode') }, { label: this.t('cap.col.limit'), numeric: true }, { label: this.t('cap.col.source') }],
        body,
      ),
      this.el('p', { className: 'text-xs text-base-content/70 mt-2 tabular-nums', text: this.t('cap.floor', { n: answerRulesUiLib().ragUiFormatNumber(rows.floor, this.locale) }) }),
      this.commandLine('cap.command', ANSWER_RULES_SWEEP_COMMAND),
    );
  }

  renderAllowlist() {
    const host = this.host('allowlist');
    if (!host) return;
    const entries = this.currentAllowlist();
    if (entries === null) return;
    const field = this.control('RAG_OUTPUT_LINK_ALLOWLIST');
    const parts = [this.el('p', { className: 'text-sm font-semibold mt-4 mb-1', text: this.t('allow.title') })];
    if (entries.length === 0) parts.push(this.el('p', { className: 'text-sm text-base-content/70', text: this.t('allow.empty') }));
    else parts.push(this.el('ul', { className: 'list-disc pl-6 space-y-1 min-w-0' }, entries.map((entry) => this.el('li', { className: 'min-w-0' }, [this.code(entry)]))));
    parts.push(this.el('p', { className: 'text-xs text-base-content/70 mt-2 max-w-prose break-words', text: this.t('allow.always') }));
    if (field) {
      const edit = this.el('button', { className: 'btn btn-link btn-sm px-0', text: this.t('allow.edit'), attrs: { type: 'button' } });
      edit.addEventListener('click', () => this.openAdministration(() => {
        const panel = typeof window !== 'undefined' ? window.quarantinePanel : null;
        if (panel && panel.tabs && typeof panel.tabs.select === 'function') panel.tabs.select('checks');
        const target = this.control('RAG_OUTPUT_LINK_ALLOWLIST');
        if (target && typeof target.focus === 'function') target.focus();
      }));
      parts.push(edit);
    }
    host.replaceChildren(...parts);
  }

  renderRules(rows) {
    const host = this.host('guardRules');
    if (!host) return;
    const ui = answerRulesUiLib();
    host.replaceChildren(
      this.el('p', { className: 'text-sm mt-2 min-w-0 break-words tabular-nums' }, ui.ragUiTemplateNodes(this.doc, this.t('guard.rules'), rows.rules, ['version'])),
    );
  }

  /** Open security events: only when that panel is on the page (plan 05.2-37); otherwise nothing renders. */
  renderEventsAction() {
    const host = this.host('events');
    if (!host) return;
    if (!this.doc.getElementById('rag-administration-security-events')) {
      host.replaceChildren();
      return;
    }
    const open = this.el('button', { className: 'btn btn-outline btn-sm mt-2', text: this.t('events.open'), attrs: { type: 'button' } });
    open.addEventListener('click', () =>
      this.openAdministration(() => {
        const target = this.doc.getElementById('rag-administration-security-events');
        if (!target) return;
        if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
        const heading = target.querySelector('h3');
        if (heading && typeof heading.focus === 'function') {
          if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
          heading.focus();
        }
      }),
    );
    host.replaceChildren(open);
  }

  /** Activates RAG administration through its own menu link, so the page's tab logic and panel mounts run as on a click. */
  openAdministration(then) {
    const link = this.doc.querySelector('[data-tab="rag-administration"]');
    if (link && typeof link.click === 'function') link.click();
    then();
  }

  refresh() {
    this.renderEventsAction();
    this.update();
    if (this.state === 'failed') {
      this.state = 'idle';
      return this.load();
    }
    return Promise.resolve(this.summary);
  }
}

/** Idempotent mount (UI-SPEC 6.11): the first call builds and loads, later calls recompute and retry a failed read. */
function initAnswerRulesPanel(options = {}) {
  const doc = options.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return Promise.resolve(null);
  const root = doc.getElementById('rag-answer-rules');
  if (!root) return Promise.resolve(null);
  if (!answerRulesPanelInstance || answerRulesPanelInstance.root !== root) {
    answerRulesPanelInstance = new AnswerRulesPanel(root, { ...options, doc });
    return answerRulesPanelInstance.mount();
  }
  return answerRulesPanelInstance.refresh();
}

function renderAnswerRulesSummary(summary, options = {}) {
  const doc = options.doc || (typeof document !== 'undefined' ? document : null);
  const root = doc ? doc.getElementById('rag-answer-rules') : null;
  if (!root || !isAnswerRulesSummary(summary)) return null;
  const panel = new AnswerRulesPanel(root, { ...options, doc });
  panel.summary = summary;
  panel.state = 'loaded';
  panel.applyTexts();
  panel.renderBlocks();
  panel.update();
  return panel;
}

/** Every RAG Modes link, desktop and mobile drawer, starts the panel; each is bound once. */
function answerRulesBindPanel() {
  document.querySelectorAll('[data-tab="rag-modes"]').forEach((link) => {
    if (link.getAttribute('data-answer-rules-bound')) return;
    link.setAttribute('data-answer-rules-bound', '1');
    link.addEventListener('click', () => {
      void initAnswerRulesPanel();
    });
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.ANSWER_RULES_LABELS = ANSWER_RULES_LABELS;
  window.initAnswerRulesPanel = initAnswerRulesPanel;
  document.addEventListener('DOMContentLoaded', () => {
    answerRulesBindPanel();
    const active = document.getElementById('rag-modes');
    if (active && active.classList.contains('active')) void initAnswerRulesPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ANSWER_RULES_ENDPOINT,
    ANSWER_RULES_LABELS,
    ANSWER_RULES_WARNING_KEYS,
    ANSWER_RULES_SWEEP_COMMAND,
    ANSWER_RULES_JUDGE_COMMAND,
    isAnswerRulesSummary,
    answerRulesRows,
    answerRulesWarnings,
    answerRulesParseAllowlist,
    renderAnswerRulesSummary,
    loadAnswerRulesSummary,
    initAnswerRulesPanel,
    AnswerRulesPanel,
  };
}
