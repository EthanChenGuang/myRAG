/**
 * Generated "RAG pipeline settings" section of the RAG Modes tab (plan 07-20, D-14, D-15, D-16, D-24; 07-UI-SPEC 6.2).
 * Renders one row per managed manifest variable from GET /api/rag-pipeline/manifest; each control's id and name are the
 * env name, so the page's change listener saves it. Secrets arrive as { state, last4? } only. Text from the manifest and
 * the servers is inserted with textContent through the rag-ui.js builders, never as markup.
 */

const RAG_PIPELINE_LABEL_ROWS = [
  ["section.title", "RAG pipeline settings", "RAG 流程设置", "Impostazioni della pipeline RAG"],
  ["section.description", "Every switch and provider of the knowledge-base pipeline, grouped by layer. Changes save to .env.local automatically; the app uses them after it restarts.", "知识库流程的全部开关和服务商，按层分组。更改会自动保存到 .env.local，应用重启后生效。", "Tutti gli interruttori e i provider della pipeline della knowledge base, raggruppati per livello. Le modifiche vengono salvate automaticamente in .env.local; l’app le usa dopo il riavvio."],
  ["section.secretsNote", "Stored keys and secrets are never shown: only whether one is stored and, for long values, its last four characters. Leave a field empty to keep the stored value. To remove one, delete its line in .env.local.", "已保存的密钥不会显示，只显示是否已保存，以及较长密钥的末四位。字段留空表示保持不变。如需删除，请在 .env.local 中删除对应的行。", "Chiavi e segreti salvati non vengono mai mostrati: si vede solo se sono salvati e, per i valori lunghi, gli ultimi quattro caratteri. Lascia vuoto un campo per mantenere il valore salvato. Per rimuoverlo, elimina la sua riga in .env.local."],
  ["load.loading", "Loading settings…", "正在加载设置…", "Caricamento delle impostazioni…"],
  ["load.failed", "The settings could not be loaded from the Config UI server. Check that it is running, then select Reload settings. Until then, edit .env.local by hand.", "无法从 Config UI 服务器加载设置。请确认它正在运行，然后选择“重新加载设置”。在此之前，可以手动编辑 .env.local。", "Non è stato possibile caricare le impostazioni dal server della Config UI. Verifica che sia in esecuzione, poi seleziona Ricarica impostazioni. Nel frattempo, modifica .env.local a mano."],
  ["load.empty", "The settings list is empty. Check scripts/rag/env-manifest.json, then select Reload settings.", "设置列表为空。请检查 scripts/rag/env-manifest.json，然后选择“重新加载设置”。", "L’elenco delle impostazioni è vuoto. Controlla scripts/rag/env-manifest.json, poi seleziona Ricarica impostazioni."],
  ["action.reload", "Reload settings", "重新加载设置", "Ricarica impostazioni"],
  ["action.reloadStatus", "Reload status", "重新加载状态", "Ricarica lo stato"],
  ["nav.label", "Setting groups", "设置分组", "Gruppi di impostazioni"],
  ["nav.changed", "Changed: {count}", "已更改：{count}", "Modificate: {count}"],
  ["nav.warnings", "Warnings: {count}", "警告：{count}", "Avvisi: {count}"],
  ["group.data.title", "Documents and ingestion", "文档与入库", "Documenti e acquisizione"],
  ["group.data.description", "How uploads are parsed, chunked, checked and embedded.", "上传的文档如何解析、切块、检查并生成向量。", "Come i caricamenti vengono analizzati, suddivisi, controllati e trasformati in vettori."],
  ["group.query.title", "Query", "查询", "Query"],
  ["group.query.description", "How a question is rewritten, expanded and cached before retrieval.", "检索之前如何改写、扩展和缓存问题。", "Come una domanda viene riscritta, ampliata e messa in cache prima del recupero."],
  ["group.retrieval.title", "Retrieval", "检索", "Recupero"],
  ["group.retrieval.description", "Which pipeline runs and how candidates are searched.", "运行哪条流程，以及如何搜索候选内容。", "Quale pipeline viene eseguita e come vengono cercati i candidati."],
  ["group.ranking.title", "Reranking and context", "重排与上下文", "Riordinamento e contesto"],
  ["group.ranking.description", "How candidates are reordered, when an answer is refused, and how context is assembled.", "候选内容如何重排、何时拒答，以及如何组装上下文。", "Come i candidati vengono riordinati, quando una risposta viene rifiutata e come si compone il contesto."],
  ["group.generation.title", "Answers and citations", "回答与引用", "Risposte e citazioni"],
  ["group.generation.description", "Citations, groundedness checks and answer feedback.", "引用、依据核查和回答反馈。", "Citazioni, verifica rispetto alle fonti e feedback sulle risposte."],
  ["group.evaluation.title", "Evaluation", "评估", "Valutazione"],
  ["group.evaluation.description", "The evaluation endpoint and who may use it.", "评估接口及其访问权限。", "L’endpoint di valutazione e chi può usarlo."],
  ["group.backends.title", "Vector backends", "向量后端", "Backend vettoriali"],
  ["group.backends.description", "Where retrieval searches: pgvector in Supabase, or a synced copy in Weaviate or Qdrant. Supabase stays the source of every answer’s text.", "检索在哪里搜索：Supabase 中的 pgvector，或同步到 Weaviate、Qdrant 的副本。回答中的文字始终来自 Supabase。", "Dove cerca il recupero: pgvector in Supabase, oppure una copia sincronizzata in Weaviate o Qdrant. Il testo di ogni risposta proviene sempre da Supabase."],
  ["group.security.title", "Security", "安全", "Sicurezza"],
  ["group.security.description", "Prompt-injection checks and limits on what untrusted content can do.", "提示注入检查，以及对不可信内容的限制。", "Controlli contro la prompt injection e limiti a ciò che i contenuti non attendibili possono fare."],
  ["group.observability.title", "Tracing and monitoring", "追踪与监控", "Tracciamento e monitoraggio"],
  ["group.observability.description", "Traces, sampling and monitoring of answers.", "调用追踪、采样和回答监控。", "Tracce, campionamento e monitoraggio delle risposte."],
  ["group.sidecar.title", "Sidecar", "Sidecar 服务", "Sidecar"],
  ["group.sidecar.description", "The Python service that parses documents and scores answers.", "负责解析文档和给回答打分的 Python 服务。", "Il servizio Python che analizza i documenti e valuta le risposte."],
  ["group.unknown.description", "This page does not know this group yet. Its settings work as usual.", "此页面尚不认识这个分组，其中的设置可以照常使用。", "Questa pagina non conosce ancora questo gruppo. Le sue impostazioni funzionano normalmente."],
  ["provider.sidecar", "Sidecar", "Sidecar 服务", "Sidecar"],
  ["provider.judge", "Judge model", "评审模型", "Modello giudice"],
  ["provider.promptGuard", "Prompt Guard model host", "Prompt Guard 模型主机", "Host del modello Prompt Guard"],
  ["row.default", "Default: {value}", "默认值：{value}", "Predefinito: {value}"],
  ["row.defaultEmpty", "Default: empty", "默认值：空", "Predefinito: vuoto"],
  ["row.changed", "Changed", "已更改", "Modificata"],
  ["value.on", "On", "开", "Attivo"],
  ["value.off", "Off", "关", "Disattivo"],
  ["enum.unset", "Not set", "未设置", "Non impostato"],
  ["row.requires", "Used only when {setting} is {value}.", "仅在“{setting}”为 {value} 时使用。", "Usata solo quando {setting} è {value}."],
  ["row.requiresOn", "Used only when {setting} is on.", "仅在“{setting}”开启时使用。", "Usata solo quando {setting} è attiva."],
  ["row.hostedValue", "Current value: {value}", "当前值：{value}", "Valore attuale: {value}"],
  ["row.hostedUnset", "Current value: not set", "当前值：未设置", "Valore attuale: non impostato"],
  ["row.hosted", "Edited under {tab}.", "请在“{tab}”中修改。", "Si modifica in {tab}."],
  ["action.showSetting", "Show setting", "显示此设置", "Mostra impostazione"],
  ["row.hostedNoEditor", "This setting has no editor in the Config UI yet. Edit it in .env.local.", "此设置在 Config UI 中还没有编辑入口，请在 .env.local 中修改。", "Questa impostazione non ha ancora un editor nella Config UI. Modificala in .env.local."],
  ["action.openPanel", "Open {panel}", "打开“{panel}”", "Apri {panel}"],
  ["row.unknownType", "This page does not know this setting’s type ({type}). Edit it in .env.local.", "此页面无法识别该设置的类型（{type}）。请在 .env.local 中修改。", "Questa pagina non conosce il tipo di questa impostazione ({type}). Modificala in .env.local."],
  ["secret.set", "Stored", "已保存", "Salvata"],
  ["secret.setLast4", "Stored, ends in {last4}", "已保存，末四位为 {last4}", "Salvata, termina con {last4}"],
  ["secret.unset", "Not set", "未设置", "Non impostata"],
  ["secret.placeholderSet", "Type a new value to replace the stored one", "输入新值以替换已保存的值", "Digita un nuovo valore per sostituire quello salvato"],
  ["secret.placeholderUnset", "Paste the value…", "粘贴密钥…", "Incolla il valore…"],
  ["secret.pending", "New value typed. It replaces the stored one when the page saves.", "已输入新值，页面保存时将替换已保存的值。", "Nuovo valore inserito. Sostituirà quello salvato al prossimo salvataggio."],
  ["secret.replaced", "{setting}: new value stored.", "{setting}：新值已保存。", "{setting}: nuovo valore salvato."],
  ["secret.show", "Show typed value: {setting}", "显示输入的值：{setting}", "Mostra il valore digitato: {setting}"],
  ["secret.hide", "Hide typed value: {setting}", "隐藏输入的值：{setting}", "Nascondi il valore digitato: {setting}"],
  ["loaded.note", "Test connection and the sync status describe the configuration the running app loaded when it started.", "“测试连接”和同步状态反映的是应用启动时加载的配置。", "Prova connessione e lo stato della sincronizzazione descrivono la configurazione caricata dall’app all’avvio."],
  ["loaded.changed", ".env.local changed after the app started. The app, Test connection and the sync status still use the earlier values. Restart the app to use the new ones.", ".env.local 在应用启动之后有过更改。应用、“测试连接”和同步状态仍在使用之前的值。重启应用后才会使用新值。", ".env.local è cambiato dopo l’avvio dell’app. L’app, Prova connessione e lo stato della sincronizzazione usano ancora i valori precedenti. Riavvia l’app per usare quelli nuovi."],
  ["admin.note", "You can change settings without signing in. Connection tests, sync switches and warnings need the admin session.", "不登录也可以修改设置。测试连接、同步开关和警告需要管理员会话。", "Puoi modificare le impostazioni senza accedere. Prove di connessione, interruttori di sincronizzazione e avvisi richiedono la sessione di amministratore."],
  ["admin.unavailable", "Connection tests, sync status and warnings are unavailable right now. Check that the main app is running, then select Reload status.", "暂时无法使用测试连接、同步状态和警告。请确认主应用正在运行，然后选择“重新加载状态”。", "Prove di connessione, stato della sincronizzazione e avvisi non sono disponibili. Verifica che l’app principale sia in esecuzione, poi seleziona Ricarica lo stato."],
  ["test.action", "Test connection", "测试连接", "Prova connessione"],
  ["test.actionAria", "Test connection: {provider}", "测试连接：{provider}", "Prova connessione: {provider}"],
  ["test.running", "Testing…", "正在测试…", "Prova in corso…"],
  ["test.ok", "Connected. Answered in {ms} ms.", "连接成功，响应用时 {ms} 毫秒。", "Connesso. Risposta in {ms} ms."],
  ["test.fail.not_configured", "Not tested: the running app has no key or URL for this provider. Save the settings, restart the app, then test again.", "未测试：运行中的应用没有此服务商的密钥或地址。请保存设置并重启应用，然后再测试。", "Non provato: l’app in esecuzione non ha chiave o URL per questo provider. Salva le impostazioni, riavvia l’app, poi riprova."],
  ["test.fail.unauthorized", "The provider refused the key. Check the key, restart the app, then test again.", "服务商拒绝了密钥。请检查密钥并重启应用，然后再测试。", "Il provider ha rifiutato la chiave. Controlla la chiave, riavvia l’app, poi riprova."],
  ["test.fail.timeout", "No answer within 10 seconds. Check the URL and the provider’s status, then test again.", "10 秒内没有响应。请检查地址和服务商的状态，然后再测试。", "Nessuna risposta entro 10 secondi. Controlla l’URL e lo stato del provider, poi riprova."],
  ["test.fail.unreachable", "The provider could not be reached. Check the URL and the network, then test again.", "无法连接到服务商。请检查地址和网络，然后再测试。", "Impossibile raggiungere il provider. Controlla l’URL e la rete, poi riprova."],
  ["test.fail.collection_missing", "Connected, but the collection for the active embedding profile does not exist yet. Turn on sync for this backend, let it finish, then test again.", "连接成功，但当前 Embedding 配置对应的集合尚不存在。请为此后端开启同步，等待完成后再测试。", "Connesso, ma la raccolta per il profilo di embedding attivo non esiste ancora. Attiva la sincronizzazione per questo backend, attendi che finisca, poi riprova."],
  ["test.fail.other", "The test failed ({code}). Check this provider’s settings, then test again.", "测试失败（{code}）。请检查此服务商的设置，然后再测试。", "La prova non è riuscita ({code}). Controlla le impostazioni di questo provider, poi riprova."],
  ["test.role.embedding", "Embeddings: {result}", "向量生成：{result}", "Embedding: {result}"],
  ["test.role.rerank", "Reranker: {result}", "重排：{result}", "Reranker: {result}"],
  ["test.time", "Tested: {time}", "测试时间：{time}", "Provato: {time}"],
  ["test.none", "No connection test exists for this provider.", "此服务商没有连接测试。", "Per questo provider non esiste una prova di connessione."],
  ["test.announce", "{provider}: {result}", "{provider}：{result}", "{provider}: {result}"],
  ["steps.title", "Order of steps for an external backend", "启用外部后端的步骤顺序", "Ordine dei passaggi per un backend esterno"],
  ["steps.1", "Enter the URL and keys of Weaviate or Qdrant.", "填写 Weaviate 或 Qdrant 的地址和密钥。", "Inserisci URL e chiavi di Weaviate o Qdrant."],
  ["steps.2", "Restart the app, then select Test connection.", "重启应用，然后选择“测试连接”。", "Riavvia l’app, poi seleziona Prova connessione."],
  ["steps.3", "Turn on sync for that backend and wait until every workspace is ready.", "为该后端开启同步，等到所有工作区都就绪。", "Attiva la sincronizzazione per quel backend e attendi che ogni spazio di lavoro sia pronto."],
  ["steps.4", "Choose it as the retrieval backend and restart the app.", "把它选为检索后端，然后重启应用。", "Sceglilo come backend di recupero e riavvia l’app."],
  ["compat.title", "Retrieval backend and index do not match", "检索后端与索引不匹配", "Backend di recupero e indice non corrispondono"],
  ["compat.ok", "No index compatibility warnings.", "没有索引兼容性警告。", "Nessun avviso di compatibilità dell’indice."],
  ["compat.count", "Index compatibility warnings: {count}", "索引兼容性警告：{count}", "Avvisi di compatibilità dell’indice: {count}"],
  ["compat.backend_not_ready", "{backend} is not ready for the active embedding profile. Questions from workspaces that are not ready are answered from pgvector and marked degraded until sync catches up.", "{backend} 尚未为当前 Embedding 配置准备就绪。在同步跟上之前，未就绪工作区的问题由 pgvector 回答，并标记为降级。", "{backend} non è pronto per il profilo di embedding attivo. Finché la sincronizzazione non recupera, alle domande degli spazi di lavoro non pronti risponde pgvector, con stato degradato."],
  ["compat.backend_not_ready.counts", "Workspaces building: {building}; out of date: {stale}; failed: {failed}.", "构建中的工作区：{building}；已过期：{stale}；失败：{failed}。", "Spazi di lavoro in costruzione: {building}; non aggiornati: {stale}; non riusciti: {failed}."],
  ["compat.dimension_mismatch", "The {backend} collection has {actual} dimensions; the active embedding profile has {expected}. The collection must be rebuilt for this profile before {backend} can answer.", "{backend} 集合的维度为 {actual}，当前 Embedding 配置的维度为 {expected}。必须为此配置重建集合，{backend} 才能回答。", "La raccolta di {backend} ha {actual} dimensioni; il profilo di embedding attivo ne ha {expected}. La raccolta va ricostruita per questo profilo prima che {backend} possa rispondere."],
  ["compat.legacy_pipeline", "{backend} is selected, but the pipeline is legacy. External backends run only when {variable} is v2; until then every question uses pgvector.", "已选择 {backend}，但流程仍是 legacy。只有 {variable} 为 v2 时外部后端才会生效；在此之前所有问题都使用 pgvector。", "{backend} è selezionato, ma la pipeline è legacy. I backend esterni funzionano solo quando {variable} è v2; fino ad allora ogni domanda usa pgvector."],
  ["compat.sync_not_enabled", "{backend} is selected, but sync to it is off. Turn on sync below and wait until every workspace is ready.", "已选择 {backend}，但尚未开启向它的同步。请在下方开启同步，等到所有工作区都就绪。", "{backend} è selezionato, ma la sincronizzazione verso di esso è disattivata. Attivala qui sotto e attendi che ogni spazio di lavoro sia pronto."],
  ["compat.dead_letters", "Changes that failed permanently: {count}. They never reached {backend}. Run {command} to repair them.", "永久失败的更改：{count}。它们没有到达 {backend}。请运行 {command} 进行修复。", "Modifiche non riuscite in modo definitivo: {count}. Non hanno mai raggiunto {backend}. Esegui {command} per ripararle."],
  ["compat.backend_unreachable", "{backend} could not be reached, so its state is unknown. Check its URL and keys, then select Reload status.", "无法连接 {backend}，因此不知道它的状态。请检查地址和密钥，然后选择“重新加载状态”。", "Impossibile raggiungere {backend}, quindi il suo stato è sconosciuto. Controlla URL e chiavi, poi seleziona Ricarica lo stato."],
  ["compat.other", "A warning this page does not know was reported for {backend}.", "{backend} 报告了一条此页面不认识的警告。", "Per {backend} è stato segnalato un avviso che questa pagina non conosce."],
  ["sync.title", "Sync and index state", "同步与索引状态", "Sincronizzazione e stato dell’indice"],
  ["sync.description", "Sync copies vectors, the tokenized search text of each passage and filter fields to the backend, and keeps them up to date. Passage text as stored and document names stay in Supabase.", "同步会把向量、每个片段的分词检索文本和筛选字段复制到后端，并保持更新。片段原文和文档名称只保存在 Supabase。", "La sincronizzazione copia nel backend i vettori, il testo di ricerca tokenizzato di ogni passaggio e i campi di filtro, e li mantiene aggiornati. Il testo dei passaggi così com’è archiviato e i nomi dei documenti restano in Supabase."],
  ["sync.loading", "Loading sync status…", "正在加载同步状态…", "Caricamento dello stato della sincronizzazione…"],
  ["sync.toggle", "Sync to {backend}", "同步到 {backend}", "Sincronizza con {backend}"],
  ["sync.waiting", "Waiting: {count}", "等待中：{count}", "In attesa: {count}"],
  ["sync.inProgress", "In progress: {count}", "进行中：{count}", "In corso: {count}"],
  ["sync.failed", "Failed permanently: {count}", "永久失败：{count}", "Non riuscite in modo definitivo: {count}"],
  ["sync.oldest", "Oldest waiting: {age}", "最早等待：{age}", "Attesa più lunga: {age}"],
  ["sync.oldestNone", "Oldest waiting: none", "最早等待：无", "Attesa più lunga: nessuna"],
  ["sync.caption", "Workspaces by index state, per embedding profile: {backend}", "各 Embedding 配置下按索引状态统计的工作区：{backend}", "Spazi di lavoro per stato dell’indice, per profilo di embedding: {backend}"],
  ["col.profile", "Embedding profile", "Embedding 配置", "Profilo di embedding"],
  ["col.ready", "Ready", "就绪", "Pronti"],
  ["col.building", "Building", "构建中", "In costruzione"],
  ["col.stale", "Out of date", "已过期", "Non aggiornati"],
  ["col.failed", "Failed", "失败", "Non riusciti"],
  ["sync.noState", "No index state yet. It appears after sync is turned on and the first check has run.", "还没有索引状态。开启同步并完成第一次检查后会显示。", "Nessuno stato dell’indice per ora. Compare dopo l’attivazione della sincronizzazione e il primo controllo."],
  ["sync.turningOn", "Turning on…", "正在开启…", "Attivazione…"],
  ["sync.turningOff", "Turning off…", "正在关闭…", "Disattivazione…"],
  ["sync.on.done", "Sync to {backend} is on. Workspaces queued: {count}.", "已开启到 {backend} 的同步。已排队的工作区：{count}。", "La sincronizzazione con {backend} è attiva. Spazi di lavoro in coda: {count}."],
  ["sync.off.done", "Sync to {backend} is off.", "已关闭到 {backend} 的同步。", "La sincronizzazione con {backend} è disattivata."],
  ["sync.unknown", "No answer arrived, so the sync switch may or may not have changed. The status has been reloaded.", "没有收到响应，同步开关可能已更改，也可能没有。状态已重新加载。", "Nessuna risposta: l’interruttore di sincronizzazione potrebbe essere cambiato oppure no. Lo stato è stato ricaricato."],
  ["sync.refused", "The sync switch was not changed ({code}). Select Reload status, then try again.", "同步开关未更改（{code}）。请选择“重新加载状态”后重试。", "L’interruttore di sincronizzazione non è stato modificato ({code}). Seleziona Ricarica lo stato, poi riprova."],
  ["confirm.syncOn.title", "Turn on sync to {backend}?", "要开启到 {backend} 的同步吗？", "Attivare la sincronizzazione con {backend}?"],
  ["confirm.syncOn.body", "For every workspace, vectors, the tokenized search text of every passage and filter fields (workspace key, document ID, type, date, language, source) are copied to {backend} and kept up to date. Passage text as stored and document names are not sent. The first copy can take a while and may be billed by the provider.", "所有工作区的向量、每个片段的分词检索文本和筛选字段（工作区标识、文档 ID、类型、日期、语言、来源）都会复制到 {backend} 并保持更新。片段原文和文档名称不会发送。首次复制可能需要一些时间，服务商可能会收费。", "Per ogni spazio di lavoro, i vettori, il testo di ricerca tokenizzato di ogni passaggio e i campi di filtro (chiave dello spazio di lavoro, ID del documento, tipo, data, lingua, origine) vengono copiati in {backend} e mantenuti aggiornati. Il testo dei passaggi così com’è archiviato e i nomi dei documenti non vengono inviati. La prima copia può richiedere tempo e può essere fatturata dal provider."],
  ["confirm.syncOn.keep", "Keep sync off", "保持同步关闭", "Lascia la sincronizzazione disattivata"],
  ["confirm.syncOn.confirm", "Turn on sync", "开启同步", "Attiva sincronizzazione"],
  ["confirm.syncOff.title", "Turn off sync to {backend}?", "要关闭到 {backend} 的同步吗？", "Disattivare la sincronizzazione con {backend}?"],
  ["confirm.syncOff.body", "Changes stop reaching {backend} and its copy goes out of date. Nothing is deleted there. If {backend} is the retrieval backend, questions are answered from pgvector and marked degraded.", "更改将不再同步到 {backend}，那里的副本会逐渐过期，但不会删除任何内容。如果 {backend} 是检索后端，问题将由 pgvector 回答，并标记为降级。", "Le modifiche non raggiungono più {backend} e la sua copia diventa non aggiornata. Lì non viene eliminato nulla. Se {backend} è il backend di recupero, alle domande risponde pgvector, con stato degradato."],
  ["confirm.syncOff.keep", "Keep sync on", "保持同步开启", "Lascia la sincronizzazione attiva"],
  ["confirm.syncOff.confirm", "Turn off sync", "关闭同步", "Disattiva sincronizzazione"],
];

const RAG_PIPELINE_EXTRA_LABELS = [
  ['section.detectors', 'Prompt-injection detectors', '提示注入检测器', 'Rilevatori di prompt injection'],
];

const RAG_PIPELINE_LABELS = (() => {
  const table = { en: {}, zh: {}, it: {} };
  for (const [key, en, zh, it] of RAG_PIPELINE_LABEL_ROWS.concat(RAG_PIPELINE_EXTRA_LABELS)) {
    table.en[key] = en;
    table.zh[key] = zh;
    table.it[key] = it;
  }
  return table;
})();

const RAG_PIPELINE_GROUP_ORDER = ['data', 'query', 'retrieval', 'ranking', 'generation', 'evaluation', 'backends', 'security', 'observability', 'sidecar'];
const RAG_PIPELINE_KNOWN_TYPES = new Set(['bool', 'enum', 'number', 'string', 'url', 'secret']);
const RAG_PIPELINE_REQUIRE_DISABLES = new Set(['bool', 'enum', 'number', 'string']);

const RAG_PIPELINE_PROVIDER_NAMES = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  voyage: 'Voyage AI',
  deepinfra: 'DeepInfra',
  cohere: 'Cohere',
  anthropic: 'Anthropic',
  llamacloud: 'LlamaCloud',
  langfuse: 'Langfuse',
  lakera: 'Lakera',
  exa: 'Exa',
  vectara: 'Vectara',
  weaviate: 'Weaviate',
  qdrant: 'Qdrant',
};
const RAG_PIPELINE_PROVIDER_LABEL_KEYS = { sidecar: 'provider.sidecar', judge: 'provider.judge', prompt_guard: 'provider.promptGuard' };

/** Manifest provider id to the probe ids of POST /api/rag/admin/providers/test (plan 07-19 PROVIDER_IDS; 07-UI-SPEC 6.2.4). */
const RAG_PIPELINE_PROVIDER_PROBES = {
  openai: ['embedding:openai'],
  voyage: ['embedding:voyage', 'rerank:voyage'],
  deepinfra: ['embedding:deepinfra'],
  cohere: ['rerank:cohere'],
  weaviate: ['backend:weaviate'],
  qdrant: ['backend:qdrant'],
  sidecar: ['sidecar'],
  langfuse: ['langfuse'],
  vectara: ['vectara'],
  lakera: ['lakera'],
  llamacloud: ['llamacloud'],
  anthropic: ['anthropic'],
  exa: ['exa'],
};

/** Rows that end with a button to the hand-built panel that belongs to them (07-UI-SPEC 6.2.2). */
const RAG_PIPELINE_RELATED_PANELS = {
  RAG_REFUSAL_THRESHOLD: 'rag-administration-refusal',
  RAG_EMBEDDING_PROFILES: 'rag-administration-profiles',
  RAG_ROLLOUTS: 'rag-administration-rollouts',
};

const RAG_PIPELINE_BACKEND_NAMES = { weaviate: 'Weaviate', qdrant: 'Qdrant', pgvector: 'pgvector' };
const RAG_PIPELINE_TEST_CODES = new Set(['not_configured', 'unauthorized', 'timeout', 'unreachable', 'collection_missing']);
const RAG_PIPELINE_COMPAT_CODES = new Set(['backend_not_ready', 'dimension_mismatch', 'legacy_pipeline', 'sync_not_enabled', 'dead_letters', 'backend_unreachable']);
const RAG_PIPELINE_SECTION_ID = 'rag-pipeline-settings';
const RAG_PIPELINE_REQUEST_TIMEOUT_MS = 15000;
const RAG_PIPELINE_SYNC_TIMEOUT_MS = 30000;

function ragPipelineLocale(language) {
  const code = String(language || '').slice(0, 2).toLowerCase();
  return code === 'zh' || code === 'it' ? code : 'en';
}

function ragPipelineBrowserLocale() {
  return ragPipelineLocale(typeof navigator !== 'undefined' && navigator ? navigator.language : 'en');
}

function ragPipelineFill(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (all, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
}

function ragPipelineLabel(key, locale, vars) {
  const table = RAG_PIPELINE_LABELS[ragPipelineLocale(locale)] || RAG_PIPELINE_LABELS.en;
  const text = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : RAG_PIPELINE_LABELS.en[key];
  return ragPipelineFill(text === undefined ? key : text, vars);
}

function ragPipelineText(value) {
  return value === undefined || value === null ? '' : String(value);
}

/** Keeps only well-formed managed entries; every field is copied by name, never by iterating the object. */
function ragPipelineEntries(body) {
  const raw = body && Array.isArray(body.entries) ? body.entries : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item.name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(item.name)) continue;
    const secret = item.secret && typeof item.secret === 'object' ? { state: item.secret.state === 'set' ? 'set' : 'unset', last4: typeof item.secret.last4 === 'string' && item.secret.last4.length === 4 ? item.secret.last4 : null } : null;
    out.push({
      name: item.name,
      group: typeof item.group === 'string' && item.group ? item.group : 'unknown',
      label: typeof item.label === 'string' && item.label ? item.label : item.name,
      type: secret ? 'secret' : typeof item.type === 'string' ? item.type : '',
      options: Array.isArray(item.options) ? item.options.map(ragPipelineText) : [],
      requires: Array.isArray(item.requires) ? item.requires.filter((r) => typeof r === 'string' && r) : [],
      default: secret ? '' : ragPipelineText(item.default),
      provider: typeof item.provider === 'string' && item.provider ? item.provider : null,
      help: typeof item.help === 'string' && item.help ? item.help : null,
      value: secret ? null : item.value === undefined || item.value === null ? null : String(item.value),
      secret,
    });
  }
  return out;
}

/** Groups in the fixed order (unknown groups last, in order of first appearance); inside a group, plain rows then provider blocks. */
function ragPipelineGroups(entries) {
  const byGroup = new Map();
  for (const entry of entries) {
    if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
    byGroup.get(entry.group).push(entry);
  }
  const known = RAG_PIPELINE_GROUP_ORDER.filter((id) => byGroup.has(id));
  const unknown = [...byGroup.keys()].filter((id) => !RAG_PIPELINE_GROUP_ORDER.includes(id));
  return known.concat(unknown).map((id) => {
    const rows = [];
    const providers = [];
    const index = new Map();
    for (const entry of byGroup.get(id)) {
      if (entry.provider && (entry.type === 'url' || entry.type === 'secret')) {
        if (!index.has(entry.provider)) {
          index.set(entry.provider, { id: entry.provider, rows: [] });
          providers.push(index.get(entry.provider));
        }
        index.get(entry.provider).rows.push(entry);
      } else {
        rows.push(entry);
      }
    }
    return { id, known: RAG_PIPELINE_GROUP_ORDER.includes(id), rows, providers };
  });
}

/** "NAME=value" or "NAME" (a bool that must be on, or any other setting that must be non-empty). */
function ragPipelineParseRequirement(text) {
  const eq = text.indexOf('=');
  if (eq < 0) return { name: text.trim(), value: null };
  return { name: text.slice(0, eq).trim(), value: text.slice(eq + 1).trim() };
}

function ragPipelineRequirementMet(requirement, current) {
  const value = ragPipelineText(current).trim();
  if (requirement.value === null) return value !== '' && value.toLowerCase() !== 'false';
  return value.toLowerCase() === requirement.value.toLowerCase();
}

function ragPipelineIsChanged(entry, stored) {
  if (entry.type === 'secret' || entry.default === '') return false;
  const value = ragPipelineText(stored).trim();
  if (value === '') return false;
  if (entry.type === 'bool') return value.toLowerCase() !== entry.default.trim().toLowerCase();
  return value !== entry.default.trim();
}

function ragPipelineProviderName(id, locale) {
  if (Object.prototype.hasOwnProperty.call(RAG_PIPELINE_PROVIDER_NAMES, id)) return RAG_PIPELINE_PROVIDER_NAMES[id];
  if (Object.prototype.hasOwnProperty.call(RAG_PIPELINE_PROVIDER_LABEL_KEYS, id)) return ragPipelineLabel(RAG_PIPELINE_PROVIDER_LABEL_KEYS[id], locale);
  return null;
}

function ragPipelineProbes(id) {
  return Object.prototype.hasOwnProperty.call(RAG_PIPELINE_PROVIDER_PROBES, id) ? RAG_PIPELINE_PROVIDER_PROBES[id].slice() : [];
}

/** True when the env file changed after the running app read it. */
function ragPipelineEnvChanged(envModifiedAt, envLoadedAt) {
  const modified = Date.parse(envModifiedAt || '');
  const loaded = Date.parse(envLoadedAt || '');
  if (!Number.isFinite(modified) || !Number.isFinite(loaded)) return false;
  return modified > loaded;
}

function ragPipelineBackendName(id) {
  return Object.prototype.hasOwnProperty.call(RAG_PIPELINE_BACKEND_NAMES, id) ? RAG_PIPELINE_BACKEND_NAMES[id] : ragPipelineText(id);
}

/** The localized sentence of one index-compatibility warning, with its numbers; unknown codes use compat.other. */
function ragPipelineCompatSentence(warning, locale) {
  const code = ragPipelineText(warning && warning.code);
  const detail = (warning && warning.detail) || {};
  const backend = ragPipelineBackendName(warning && warning.backend);
  if (!RAG_PIPELINE_COMPAT_CODES.has(code)) return { template: ragPipelineLabel('compat.other', locale), vars: { backend } };
  const vars = { backend };
  if (code === 'dimension_mismatch') {
    vars.actual = ragPipelineText(detail.collectionDims);
    vars.expected = ragPipelineText(detail.profileDims);
  }
  if (code === 'dead_letters') {
    vars.count = ragPipelineText(detail.dead);
    vars.command = 'npm run rag:reconcile';
  }
  if (code === 'legacy_pipeline') vars.variable = 'RAG_PIPELINE';
  let template = ragPipelineLabel('compat.' + code, locale);
  if (code === 'backend_not_ready' && ['building', 'stale', 'failed'].every((k) => Number.isFinite(Number(detail[k])))) {
    template += ' ' + ragPipelineLabel('compat.backend_not_ready.counts', locale);
    vars.building = String(detail.building);
    vars.stale = String(detail.stale);
    vars.failed = String(detail.failed);
  }
  return { template, vars };
}

/** The result sentence of one probe answer (07-UI-SPEC 8.3). */
function ragPipelineTestSentence(result, locale) {
  if (result && result.thrown) return { ok: false, text: ragPipelineLabel('admin.unavailable', locale) };
  if (result && (result.status === 401 || result.status === 403)) return { ok: false, signIn: true };
  if (result && result.status >= 500) return { ok: false, text: ragPipelineLabel('admin.unavailable', locale) };
  if (result && result.status === 400) return { ok: false, text: ragPipelineLabel('test.fail.other', locale, { code: 'invalid_request' }), code: 'invalid_request' };
  const body = (result && result.body) || {};
  if (body.ok === true) return { ok: true, text: ragPipelineLabel('test.ok', locale, { ms: String(Math.max(0, Math.round(Number(body.latencyMs) || 0))) }) };
  const code = ragPipelineText(body.code) || 'unknown';
  if (RAG_PIPELINE_TEST_CODES.has(code)) return { ok: false, text: ragPipelineLabel('test.fail.' + code, locale) };
  return { ok: false, text: ragPipelineLabel('test.fail.other', locale, { code }), code };
}

function ragPipelineReadControl(control) {
  if (!control) return '';
  if (control.type === 'checkbox') return control.checked ? 'true' : 'false';
  return ragPipelineText(control.value);
}

/** A control outside the section with the variable's id: the hand-written control wins (07-UI-SPEC 6.2.1, decision 3). */
function ragPipelineHostedControl(doc, name) {
  const el = doc.getElementById(name);
  if (!el) return null;
  if (typeof el.closest === 'function' && el.closest('#' + RAG_PIPELINE_SECTION_ID)) return null;
  return el;
}

class RagPipelineSettings {
  constructor(doc, root) {
    this.doc = doc;
    this.root = root;
    this.locale = ragPipelineBrowserLocale();
    this.entries = [];
    this.rows = new Map();
    this.groupNav = new Map();
    this.providerBlocks = [];
    this.built = false;
    this.envModifiedAt = null;
    this.envLoadedAt = null;
    this.warnings = [];
    this.adminState = 'idle';
    this.host = {
      title: root.querySelector('[data-rag-pipeline-title]'),
      description: root.querySelector('[data-rag-pipeline-description]'),
      secretsNote: root.querySelector('[data-rag-pipeline-secrets-note]'),
      alert: root.querySelector('[data-rag-pipeline-alert]'),
      nav: root.querySelector('[data-rag-pipeline-nav]'),
      content: root.querySelector('[data-rag-pipeline-content]'),
      status: root.querySelector('[data-rag-pipeline-status]'),
    };
    root.setAttribute('lang', this.locale);
    if (this.host.title) this.host.title.textContent = this.t('section.title');
    if (this.host.description) this.host.description.textContent = this.t('section.description');
    if (this.host.secretsNote) this.host.secretsNote.textContent = this.t('section.secretsNote');
    if (this.host.nav) this.host.nav.setAttribute('aria-label', this.t('nav.label'));
    this.onSaved = () => this.afterSave();
    this.onDocumentChange = () => this.updateRequirements();
    doc.addEventListener('rag-config-saved', this.onSaved);
    doc.addEventListener('change', this.onDocumentChange);
  }

  t(key, vars) {
    return ragPipelineLabel(key, this.locale, vars);
  }

  el(tag, options, children) {
    return ragUiEl(this.doc, tag, options, children);
  }

  announce(text, isError) {
    if (!this.host.status) return;
    this.host.status.className = 'text-sm mt-4' + (isError ? ' text-error' : '');
    this.host.status.replaceChildren(...(isError ? [ragUiIcon(this.doc, 'exclamation-circle', 'mr-1')] : []), this.doc.createTextNode(String(text)));
  }

  async mount() {
    if (this.built) return this.refresh();
    return this.load();
  }

  async fetchManifest() {
    const result = await ragUiFetchJson('/api/rag-pipeline/manifest', { method: 'GET' }, RAG_PIPELINE_REQUEST_TIMEOUT_MS);
    if (!result || result.thrown || !result.ok || !result.body || typeof result.body !== 'object') return { failed: true };
    return { failed: false, entries: ragPipelineEntries(result.body), envModifiedAt: typeof result.body.envModifiedAt === 'string' ? result.body.envModifiedAt : null };
  }

  async load() {
    const content = this.host.content;
    if (!content) return;
    if (this.host.nav) this.host.nav.replaceChildren();
    content.replaceChildren(this.el('div', { className: 'py-8' }, [ragUiSpinner(this.doc, this.t('load.loading'))]));
    this.announce(this.t('load.loading'));
    const manifest = await this.fetchManifest();
    if (manifest.failed || manifest.entries.length === 0) {
      const reload = this.el('button', { className: 'btn btn-sm', text: this.t('action.reload'), attrs: { type: 'button' } });
      reload.addEventListener('click', () => this.load());
      const key = manifest.failed ? 'load.failed' : 'load.empty';
      content.replaceChildren(ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', body: [this.t(key)], actions: [reload] }));
      this.announce(this.t(key), true);
      return;
    }
    this.entries = manifest.entries;
    this.envModifiedAt = manifest.envModifiedAt;
    this.build();
    this.announce('');
    await this.loadAdmin();
  }

  build() {
    const content = this.host.content;
    content.replaceChildren();
    this.rows.clear();
    this.groupNav.clear();
    this.providerBlocks = [];
    for (const group of ragPipelineGroups(this.entries)) content.appendChild(this.buildGroup(group));
    this.built = true;
    this.updateRequirements();
    this.updateNav();
  }

  buildGroup(group) {
    const headingId = 'rag-pipeline-group-' + group.id.replace(/[^a-z0-9_-]/gi, '-');
    const title = group.known ? this.t('group.' + group.id + '.title') : group.id;
    const heading = this.el('h4', {
      id: headingId,
      className: 'text-base font-semibold mb-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2' + (group.known ? '' : ' font-mono'),
      text: title,
      attrs: { tabindex: '-1', translate: group.known ? null : 'no' },
    });
    const body = this.el('div', { className: 'card-body' }, [
      heading,
      this.el('p', { className: 'text-sm text-base-content/70 mb-4 max-w-prose', text: group.known ? this.t('group.' + group.id + '.description') : this.t('group.unknown.description') }),
    ]);
    const card = this.el('section', {
      className: 'card bg-base-200 shadow-md min-w-0 scroll-mt-4',
      attrs: { 'aria-labelledby': headingId, 'data-rag-pipeline-group': group.id },
    }, [body]);
    if (group.id === 'backends') {
      this.compatHost = this.el('div', { attrs: { 'data-rag-pipeline-compat': '' } });
      body.appendChild(this.compatHost);
      body.appendChild(this.buildSteps());
    }
    const rowsHost = this.el('div', { className: 'min-w-0' });
    for (const entry of group.rows) rowsHost.appendChild(this.buildRow(entry));
    body.appendChild(rowsHost);
    if (group.id === 'backends') {
      this.syncHost = this.el('div', { className: 'mt-6', attrs: { 'data-rag-pipeline-sync': '' } });
      this.syncHost.addEventListener('change', (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      });
      body.appendChild(this.syncHost);
    }
    group.providers.forEach((provider, index) => body.appendChild(this.buildProvider(provider, index === 0)));
    const navButton = this.el('button', { className: 'btn btn-ghost btn-xs', attrs: { type: 'button', 'data-rag-pipeline-jump': group.id } });
    navButton.addEventListener('click', () => {
      if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'start' });
      heading.focus();
    });
    if (this.host.nav) this.host.nav.appendChild(navButton);
    this.groupNav.set(group.id, { button: navButton, title, names: group.rows.concat(...group.providers.map((p) => p.rows)).map((e) => e.name) });
    return card;
  }

  buildSteps() {
    return this.el('div', { className: 'mb-4' }, [
      this.el('h5', { className: 'text-sm font-semibold mb-2', text: this.t('steps.title') }),
      this.el('ol', { className: 'list-decimal pl-4 text-sm max-w-prose' }, ['steps.1', 'steps.2', 'steps.3', 'steps.4'].map((key) => this.el('li', { text: this.t(key) }))),
    ]);
  }

  buildProvider(provider, first) {
    const name = ragPipelineProviderName(provider.id, this.locale);
    const block = this.el('div', { className: 'border-l-4 border-base-300 rounded-lg p-4 mt-4 min-w-0', attrs: { 'data-rag-pipeline-provider': provider.id } }, [
      this.el('h5', { className: 'text-sm font-semibold' + (name ? '' : ' font-mono'), text: name || provider.id, attrs: { translate: 'no' } }),
    ]);
    for (const entry of provider.rows) block.appendChild(this.buildRow(entry));
    const probes = ragPipelineProbes(provider.id);
    if (probes.length === 0) {
      block.appendChild(this.el('p', { className: 'text-xs text-base-content/70 mt-4', text: this.t('test.none') }));
    } else {
      const label = name || provider.id;
      const result = this.el('div', { className: 'text-sm min-w-0', attrs: { 'data-rag-pipeline-test-result': '' } });
      const button = this.el('button', {
        className: 'btn btn-outline md:btn-sm',
        text: this.t('test.action'),
        attrs: { type: 'button', 'aria-label': this.t('test.actionAria', { provider: label }), 'data-rag-pipeline-test': provider.id },
      });
      button.addEventListener('click', () => this.runTest(provider.id, label, probes, button, result));
      block.appendChild(this.el('div', { className: 'flex flex-wrap items-center gap-2 mt-4' }, [button, result]));
    }
    if (first) block.appendChild(this.el('p', { className: 'text-xs text-base-content/70 mt-2', text: this.t('loaded.note') }));
    this.providerBlocks.push(block);
    return block;
  }

  buildRow(entry) {
    const name = entry.name;
    const hosted = ragPipelineHostedControl(this.doc, name);
    const labelEl = hosted
      ? this.el('p', { className: 'text-sm', text: entry.label, attrs: { lang: this.locale === 'en' ? null : 'en' } })
      : this.el('label', { className: 'text-sm', text: entry.label, attrs: { for: name, lang: this.locale === 'en' ? null : 'en' } });
    const left = this.el('div', { className: 'min-w-0 md:col-span-2' }, [
      labelEl,
      this.el('code', { className: 'block font-mono text-xs text-base-content/70 break-all', text: name, attrs: { translate: 'no' } }),
    ]);
    const right = this.el('div', { className: 'min-w-0 md:col-span-3' });
    const row = this.el('div', {
      className: 'grid gap-x-6 gap-y-1 py-4 border-t border-base-300 first:border-t-0 md:grid-cols-5',
      attrs: { 'data-rag-pipeline-row': name },
    }, [left, right]);
    const state = { entry, row, right, control: null, kind: 'control', dirty: false, typed: false, hosted: null };
    this.rows.set(name, state);
    if (hosted) {
      state.kind = 'hosted';
      state.hosted = hosted;
      this.buildHosted(state);
      return row;
    }
    if (!RAG_PIPELINE_KNOWN_TYPES.has(entry.type)) {
      state.kind = 'unknown';
      right.appendChild(this.el('p', { className: 'text-sm flex items-start gap-1' }, [ragUiIcon(this.doc, 'exclamation-triangle'), ...ragUiTemplateNodes(this.doc, this.t('row.unknownType'), { type: entry.type || '?' }, ['type'])]));
      return row;
    }
    right.appendChild(this.buildControl(state));
    if (entry.help) right.appendChild(this.el('p', { id: 'rag-pipeline-help-' + name, className: 'text-xs text-base-content/70 mt-1', text: entry.help, attrs: { lang: this.locale === 'en' ? null : 'en' } }));
    if (entry.requires.length) {
      state.requiresEl = this.el('p', { id: 'rag-pipeline-requires-' + name, className: 'text-xs text-base-content/70 mt-1', attrs: { hidden: true } });
      state.requiresEl.hidden = true;
      right.appendChild(state.requiresEl);
    }
    state.metaEl = this.el('p', { id: 'rag-pipeline-meta-' + name, className: 'text-xs text-base-content/70 mt-1 flex flex-wrap items-center gap-2' });
    right.appendChild(state.metaEl);
    this.appendRelated(state);
    this.updateMeta(state);
    this.updateDescribedBy(state);
    return row;
  }

  buildControl(state) {
    const { entry } = state;
    const name = entry.name;
    const stored = entry.value === null ? '' : entry.value;
    let control;
    let wrapper;
    if (entry.type === 'bool') {
      control = this.el('input', { id: name, className: 'toggle toggle-primary', attrs: { type: 'checkbox', name } });
      control.type = 'checkbox';
      const effective = stored !== '' ? stored : entry.default;
      control.checked = effective.trim().toLowerCase() === 'true';
      const word = this.el('span', { className: 'text-sm', attrs: { 'aria-hidden': 'true' }, text: control.checked ? this.t('value.on') : this.t('value.off') });
      state.word = word;
      wrapper = this.el('div', { className: 'flex items-center gap-2' }, [control, word]);
    } else if (entry.type === 'enum') {
      control = this.el('select', { id: name, className: 'select select-bordered w-full md:select-sm', attrs: { name, translate: 'no' } });
      const options = entry.options.slice();
      const selected = stored !== '' ? stored : entry.default;
      if (selected === '' && !options.includes('')) control.appendChild(this.el('option', { text: this.t('enum.unset'), attrs: { value: '' } }));
      if (selected !== '' && !options.includes(selected)) options.push(selected);
      for (const option of options) control.appendChild(this.el('option', { text: option, attrs: { value: option } }));
      control.value = selected;
      wrapper = control;
    } else if (entry.type === 'secret') {
      control = this.el('input', {
        id: name,
        className: 'input input-bordered flex-1 w-full min-w-0 md:input-sm',
        attrs: { type: 'password', name, autocomplete: 'off', spellcheck: 'false', translate: 'no' },
      });
      control.type = 'password';
      control.value = '';
      control.placeholder = entry.secret && entry.secret.state === 'set' ? this.t('secret.placeholderSet') : this.t('secret.placeholderUnset');
      const reveal = this.el('button', {
        className: 'btn btn-square btn-outline md:btn-sm',
        attrs: { type: 'button', 'aria-pressed': 'false', 'aria-label': this.t('secret.show', { setting: entry.label }), 'data-rag-pipeline-reveal': name },
      }, [ragUiIcon(this.doc, 'eye')]);
      reveal.addEventListener('click', () => {
        const show = control.type === 'password';
        control.type = show ? 'text' : 'password';
        reveal.setAttribute('aria-pressed', show ? 'true' : 'false');
        reveal.setAttribute('aria-label', this.t(show ? 'secret.hide' : 'secret.show', { setting: entry.label }));
        reveal.replaceChildren(ragUiIcon(this.doc, show ? 'eye-slash' : 'eye'));
      });
      state.reveal = reveal;
      wrapper = this.el('div', { className: 'flex gap-2' }, [control, reveal]);
    } else {
      const inputType = entry.type === 'number' ? 'number' : entry.type === 'url' ? 'url' : 'text';
      const attrs = { type: inputType, name, autocomplete: 'off' };
      if (entry.type === 'number') Object.assign(attrs, { inputmode: 'decimal', step: 'any' });
      else Object.assign(attrs, { spellcheck: 'false' });
      if (entry.type === 'url') attrs.translate = 'no';
      control = this.el('input', { id: name, className: 'input input-bordered w-full md:input-sm', attrs });
      control.type = inputType;
      control.value = stored;
      control.placeholder = entry.default;
      wrapper = control;
    }
    state.control = control;
    const onEdit = () => {
      state.dirty = true;
      if (entry.type === 'secret') state.typed = ragPipelineText(control.value) !== '';
      if (state.word) state.word.textContent = control.checked ? this.t('value.on') : this.t('value.off');
      this.updateMeta(state);
      this.updateRequirements();
      this.updateNav();
    };
    control.addEventListener('change', onEdit);
    control.addEventListener('input', onEdit);
    return wrapper;
  }

  buildHosted(state) {
    const { entry, right } = state;
    const value = this.hostedValueNodes(entry);
    state.hostedValueEl = this.el('p', { className: 'text-sm' }, value);
    right.appendChild(state.hostedValueEl);
    const tabEl = typeof state.hosted.closest === 'function' ? state.hosted.closest('.tab-content') : null;
    const tabId = tabEl ? tabEl.id : '';
    let tabName = tabId;
    if (tabId) {
      const link = this.doc.querySelector('[data-tab="' + tabId + '"]');
      if (link && ragPipelineText(link.textContent).trim()) tabName = ragPipelineText(link.textContent).trim();
    }
    const line = this.el('p', { className: 'text-xs text-base-content/70 mt-1' }, [this.doc.createTextNode(this.t('row.hosted', { tab: tabName }))]);
    right.appendChild(line);
    const button = this.el('button', { className: 'btn btn-link btn-sm px-0', text: this.t('action.showSetting'), attrs: { type: 'button', 'data-rag-pipeline-show': entry.name } });
    button.addEventListener('click', () => this.showHosted(state, tabId, button));
    right.appendChild(button);
    this.appendRelated(state);
  }

  hostedValueNodes(entry) {
    if (entry.type === 'secret') {
      if (!entry.secret || entry.secret.state !== 'set') return [this.doc.createTextNode(this.t('row.hostedUnset'))];
      return [this.doc.createTextNode(this.t('row.hostedValue', { value: this.t('secret.set') }))];
    }
    if (entry.value === null || entry.value === '') return [this.doc.createTextNode(this.t('row.hostedUnset'))];
    return ragUiTemplateNodes(this.doc, this.t('row.hostedValue'), { value: entry.value }, ['value']);
  }

  showHosted(state, tabId, button) {
    const previous = this.doc.querySelector('.tab-content.active');
    const link = tabId ? this.doc.querySelector('[data-tab="' + tabId + '"]') : null;
    if (link && typeof link.click === 'function') link.click();
    const control = this.doc.getElementById(state.entry.name);
    const staging = control && typeof control.closest === 'function' ? this.stagingAncestor(control) : null;
    if (!control || staging) {
      if (previous && previous.id) {
        const back = this.doc.querySelector('[data-tab="' + previous.id + '"]');
        if (back && typeof back.click === 'function') back.click();
      }
      const note = this.el('p', { className: 'text-xs text-base-content/70 mt-1', text: this.t('row.hostedNoEditor') });
      button.replaceWith ? button.replaceWith(note) : (button.parentNode.replaceChild(note, button));
      return;
    }
    if (typeof control.scrollIntoView === 'function') control.scrollIntoView({ block: 'center' });
    control.focus();
  }

  stagingAncestor(control) {
    let current = control.parentNode;
    while (current && current !== this.doc) {
      if (current.classList && current.classList.contains('hidden') && /-settings$/.test(current.id || '')) return current;
      current = current.parentNode;
    }
    return null;
  }

  appendRelated(state) {
    const target = RAG_PIPELINE_RELATED_PANELS[state.entry.name];
    if (!target) return;
    const section = this.doc.getElementById(target);
    if (!section) return;
    const heading = section.querySelector('h3');
    const panel = heading ? ragPipelineText(heading.textContent).trim() : target;
    const button = this.el('button', { className: 'btn btn-link btn-sm px-0', text: this.t('action.openPanel', { panel }), attrs: { type: 'button', 'data-rag-pipeline-related': target } });
    button.addEventListener('click', () => {
      const link = this.doc.querySelector('[data-tab="rag-administration"]');
      if (link && typeof link.click === 'function') link.click();
      if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'start' });
      const focusTarget = heading || section;
      if (!focusTarget.hasAttribute('tabindex')) focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus();
    });
    state.right.appendChild(button);
  }

  storedValue(state) {
    if (state.control && state.dirty) return ragPipelineReadControl(state.control);
    return state.entry.value === null ? '' : state.entry.value;
  }

  updateMeta(state) {
    if (!state.metaEl) return;
    const { entry } = state;
    const nodes = [];
    if (entry.type === 'secret') {
      let line;
      if (state.typed) line = [this.doc.createTextNode(this.t('secret.pending'))];
      else if (entry.secret && entry.secret.state === 'set' && entry.secret.last4) line = ragUiTemplateNodes(this.doc, this.t('secret.setLast4'), { last4: entry.secret.last4 }, ['last4']);
      else line = [this.doc.createTextNode(this.t(entry.secret && entry.secret.state === 'set' ? 'secret.set' : 'secret.unset'))];
      nodes.push(this.el('span', {}, line));
    } else {
      if (ragPipelineIsChanged(entry, this.storedValue(state))) nodes.push(this.el('span', { className: 'badge badge-sm badge-outline', text: this.t('row.changed'), attrs: { 'data-rag-pipeline-changed': '' } }));
      let text;
      if (entry.default === '') text = this.t('row.defaultEmpty');
      else if (entry.type === 'bool') text = this.t('row.default', { value: this.t(entry.default.trim().toLowerCase() === 'true' ? 'value.on' : 'value.off') });
      else text = null;
      nodes.push(text !== null ? this.el('span', { text }) : this.el('span', {}, ragUiTemplateNodes(this.doc, this.t('row.default'), { value: entry.default }, ['value'])));
    }
    state.metaEl.replaceChildren(...nodes);
  }

  updateDescribedBy(state) {
    if (!state.control) return;
    const ids = [];
    if (state.entry.help) ids.push('rag-pipeline-help-' + state.entry.name);
    if (state.requiresEl && !state.requiresEl.hidden) ids.push(state.requiresEl.id);
    if (state.metaEl) ids.push(state.metaEl.id);
    state.control.setAttribute('aria-describedby', ids.join(' '));
  }

  /** The current value of any managed setting as the page shows it now: an unsaved change counts. */
  currentValue(name) {
    const state = this.rows.get(name);
    if (state && state.control) {
      const value = ragPipelineReadControl(state.control);
      if (state.entry.type === 'secret') return value !== '' ? value : state.entry.secret && state.entry.secret.state === 'set' ? 'set' : '';
      return value !== '' ? value : state.entry.default;
    }
    const hosted = ragPipelineHostedControl(this.doc, name);
    if (hosted) return ragPipelineReadControl(hosted);
    if (state) return state.entry.value !== null && state.entry.value !== '' ? state.entry.value : state.entry.default;
    return '';
  }

  updateRequirements() {
    for (const state of this.rows.values()) {
      if (!state.requiresEl || !state.control) continue;
      const unmet = state.entry.requires.map(ragPipelineParseRequirement).filter((req) => !ragPipelineRequirementMet(req, this.currentValue(req.name)));
      const nodes = [];
      for (const req of unmet) {
        const other = this.rows.get(req.name);
        const setting = other ? other.entry.label : req.name;
        const isOn = req.value === null || req.value.toLowerCase() === 'true';
        if (nodes.length) nodes.push(this.doc.createTextNode(' '));
        nodes.push(...(isOn ? [this.doc.createTextNode(this.t('row.requiresOn', { setting }))] : ragUiTemplateNodes(this.doc, this.t('row.requires'), { setting, value: req.value }, ['value'])));
      }
      state.requiresEl.replaceChildren(...(nodes.length ? [ragUiIcon(this.doc, 'info-circle', 'mr-1'), ...nodes] : []));
      state.requiresEl.hidden = unmet.length === 0;
      if (unmet.length) state.requiresEl.removeAttribute('hidden');
      else state.requiresEl.setAttribute('hidden', '');
      if (RAG_PIPELINE_REQUIRE_DISABLES.has(state.entry.type)) state.control.disabled = unmet.length > 0;
      this.updateDescribedBy(state);
    }
  }

  updateNav() {
    for (const [groupId, nav] of this.groupNav) {
      const changed = nav.names.filter((name) => {
        const state = this.rows.get(name);
        return state && state.kind === 'control' && ragPipelineIsChanged(state.entry, this.storedValue(state));
      }).length;
      const parts = [this.el('span', { text: nav.title, className: groupId === nav.title ? 'font-mono' : '' })];
      if (changed > 0) parts.push(this.el('span', { className: 'text-xs', text: this.t('nav.changed', { count: ragUiFormatNumber(changed, this.locale) }) }));
      if (groupId === 'backends' && this.warnings.length > 0) parts.push(this.el('span', { className: 'text-xs', text: this.t('nav.warnings', { count: ragUiFormatNumber(this.warnings.length, this.locale) }) }));
      nav.button.replaceChildren(...parts);
    }
  }

  async refresh() {
    const manifest = await this.fetchManifest();
    if (!manifest.failed) {
      const byName = new Map(manifest.entries.map((e) => [e.name, e]));
      for (const state of this.rows.values()) {
        const fresh = byName.get(state.entry.name);
        if (!fresh) continue;
        state.entry.value = fresh.value;
        state.entry.secret = fresh.secret;
        if (state.kind === 'hosted' && state.hostedValueEl) state.hostedValueEl.replaceChildren(...this.hostedValueNodes(state.entry));
        if (state.control && !state.dirty && state.entry.type === 'secret') {
          state.control.placeholder = state.entry.secret && state.entry.secret.state === 'set' ? this.t('secret.placeholderSet') : this.t('secret.placeholderUnset');
        }
        this.updateMeta(state);
      }
      this.envModifiedAt = manifest.envModifiedAt;
    }
    this.updateRequirements();
    this.updateNav();
    this.renderLoadedNote();
  }

  /** After a successful save: typed secrets leave the DOM and the page's config object, then values and hints reload. */
  async afterSave() {
    const replaced = [];
    const config = typeof window !== 'undefined' && window.configManager && window.configManager.config ? window.configManager.config : null;
    for (const state of this.rows.values()) {
      if (state.entry.type !== 'secret' || !state.control) continue;
      if (ragPipelineText(state.control.value) !== '') replaced.push(state.entry.label);
      state.control.value = '';
      state.control.type = 'password';
      if (state.reveal) {
        state.reveal.setAttribute('aria-pressed', 'false');
        state.reveal.setAttribute('aria-label', this.t('secret.show', { setting: state.entry.label }));
        state.reveal.replaceChildren(ragUiIcon(this.doc, 'eye'));
      }
      if (config && Object.prototype.hasOwnProperty.call(config, state.entry.name)) delete config[state.entry.name];
      state.typed = false;
    }
    for (const state of this.rows.values()) state.dirty = false;
    await this.refresh();
    if (replaced.length) this.announce(replaced.map((setting) => this.t('secret.replaced', { setting })).join(' '));
  }

  async loadAdmin() {
    if (this.syncHost) {
      ragUiListBusy(this.syncHost, Boolean(this.syncHost.firstChild));
      if (!this.syncHost.firstChild) this.syncHost.replaceChildren(ragUiSpinner(this.doc, this.t('sync.loading')));
    }
    const [compat, targets] = await Promise.all([
      ragUiRagRequest('/api/rag/admin/index-compat', { method: 'GET' }, RAG_PIPELINE_REQUEST_TIMEOUT_MS),
      ragUiRagRequest('/api/rag/admin/vector-sync/targets', { method: 'GET' }, RAG_PIPELINE_REQUEST_TIMEOUT_MS),
    ]);
    const signIn = [compat, targets].some((r) => r && (r.status === 401 || r.status === 403));
    if (signIn) this.adminState = 'signIn';
    else if (!compat || !compat.ok || !compat.body) this.adminState = 'unavailable';
    else this.adminState = 'ready';
    if (this.adminState === 'ready') {
      const body = compat.body;
      this.warnings = Array.isArray(body.warnings) ? body.warnings.filter((w) => w && typeof w === 'object') : [];
      this.backends = Array.isArray(body.backends) ? body.backends.filter((b) => b && typeof b.target === 'string') : [];
      this.envLoadedAt = typeof body.envLoadedAt === 'string' ? body.envLoadedAt : null;
      const enabled = new Map();
      if (targets && targets.ok && targets.body && Array.isArray(targets.body.targets)) {
        for (const t of targets.body.targets) if (t && typeof t.target === 'string') enabled.set(t.target, t.enabled === true);
      }
      this.targetEnabled = enabled;
    } else {
      this.warnings = [];
      this.envLoadedAt = null;
    }
    this.renderAlertHost();
    this.renderCompat();
    this.renderSync();
    this.updateNav();
  }

  reloadStatusButton() {
    const button = this.el('button', { className: 'btn btn-outline md:btn-sm', text: this.t('action.reloadStatus'), attrs: { type: 'button', 'data-rag-pipeline-reload-status': '' } });
    button.addEventListener('click', async () => {
      const restore = ragUiButtonBusy(this.doc, button, this.t('action.reloadStatus'));
      try {
        await this.refresh();
        await this.loadAdmin();
      } finally {
        if (button.isConnected !== false) restore();
      }
      if (this.adminState === 'ready') this.announce(this.t('compat.count', { count: ragUiFormatNumber(this.warnings.length, this.locale) }));
    });
    return button;
  }

  renderAlertHost() {
    if (!this.host.alert) return;
    const parts = [];
    if (this.adminState === 'signIn') {
      parts.push(ragUiAlert(this.doc, {
        tone: 'warning',
        icon: 'person-lock',
        body: [ragUiSharedLabel('error.signIn', this.locale), this.t('admin.note')],
        actions: [this.reloadStatusButton()],
      }));
    }
    if (this.adminState === 'ready' && ragPipelineEnvChanged(this.envModifiedAt, this.envLoadedAt)) {
      parts.push(ragUiAlert(this.doc, { tone: 'info', icon: 'arrow-repeat', body: [this.t('loaded.changed')], className: 'mt-2', attrs: null }));
    }
    for (const part of parts) part.setAttribute('data-rag-pipeline-alert-item', '');
    this.host.alert.replaceChildren(...parts);
  }

  renderLoadedNote() {
    this.renderAlertHost();
  }

  renderCompat() {
    if (!this.compatHost) return;
    if (this.adminState !== 'ready') {
      this.compatHost.replaceChildren();
      return;
    }
    if (this.warnings.length === 0) {
      this.compatHost.replaceChildren(this.el('p', { className: 'text-xs text-base-content/70 mb-4', text: this.t('compat.ok'), attrs: { 'data-rag-pipeline-compat-ok': '' } }));
      return;
    }
    const list = this.el('ul', { className: 'list-disc pl-4 text-sm' });
    for (const warning of this.warnings) {
      const { template, vars } = ragPipelineCompatSentence(warning, this.locale);
      const item = this.el('li', { attrs: { 'data-rag-pipeline-warning': ragPipelineText(warning.code) } }, ragUiTemplateNodes(this.doc, template, vars, ['command', 'variable']));
      item.appendChild(this.doc.createTextNode(' '));
      item.appendChild(this.el('code', { className: 'font-mono text-xs', text: ragPipelineText(warning.code), attrs: { translate: 'no' } }));
      list.appendChild(item);
    }
    const alert = this.el('div', { className: 'alert alert-warning items-start mb-4', attrs: { 'data-rag-pipeline-compat-alert': '' } }, [
      ragUiIcon(this.doc, 'exclamation-triangle', 'text-lg'),
      this.el('div', { className: 'min-w-0 max-w-prose' }, [this.el('p', { className: 'text-sm font-semibold', text: this.t('compat.title') }), list]),
    ]);
    this.compatHost.replaceChildren(alert);
  }

  formatAge(seconds) {
    const n = Number(seconds);
    let unit = 'second';
    let value = n;
    if (n >= 120) {
      unit = 'minute';
      value = Math.round(n / 60);
    }
    if (value >= 120 && unit === 'minute') {
      unit = 'hour';
      value = Math.round(n / 3600);
    }
    try {
      return new Intl.NumberFormat(this.locale, { style: 'unit', unit, unitDisplay: 'short' }).format(value);
    } catch {
      return String(value) + ' ' + unit;
    }
  }

  renderSync() {
    if (!this.syncHost) return;
    ragUiListBusy(this.syncHost, false);
    const head = this.el('div', { className: 'flex flex-wrap items-center justify-between gap-2' }, [
      this.el('h5', { className: 'text-sm font-semibold', text: this.t('sync.title') }),
      this.reloadStatusButton(),
    ]);
    const parts = [head, this.el('p', { className: 'text-sm text-base-content/70 mt-2 max-w-prose', text: this.t('sync.description') })];
    if (this.adminState === 'signIn') {
      parts.push(this.el('p', { className: 'text-sm mt-2', text: this.t('admin.note') }));
    } else if (this.adminState === 'unavailable') {
      parts.push(this.el('p', { className: 'text-sm text-error mt-2', text: this.t('admin.unavailable'), attrs: { 'data-rag-pipeline-admin-unavailable': '' } }));
    } else if (this.adminState === 'ready') {
      for (const target of ['qdrant', 'weaviate']) parts.push(this.buildSyncTarget(target));
    }
    this.syncHost.replaceChildren(...parts);
  }

  buildSyncTarget(target) {
    const backend = (this.backends || []).find((b) => b.target === target) || { target, pending: 0, leased: 0, dead: 0, oldestPendingSeconds: null, profiles: [] };
    const name = ragPipelineBackendName(target);
    const enabled = this.targetEnabled && this.targetEnabled.has(target) ? this.targetEnabled.get(target) : backend.enabled === true;
    const id = 'rag-pipeline-sync-' + target;
    const toggle = this.el('input', { id, className: 'toggle toggle-primary', attrs: { type: 'checkbox', role: 'switch' } });
    toggle.type = 'checkbox';
    toggle.checked = enabled;
    const word = this.el('span', { className: 'text-sm', attrs: { 'aria-hidden': 'true' }, text: enabled ? this.t('value.on') : this.t('value.off') });
    toggle.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.confirmSync(target, !enabled, toggle, word);
    });
    toggle.addEventListener('change', (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    });
    const failed = Number(backend.dead) || 0;
    const outbox = this.el('p', { className: 'text-sm mt-2 flex flex-wrap gap-x-4 gap-y-1 tabular-nums' }, [
      this.el('span', { text: this.t('sync.waiting', { count: ragUiFormatNumber(backend.pending || 0, this.locale) }) }),
      this.el('span', { text: this.t('sync.inProgress', { count: ragUiFormatNumber(backend.leased || 0, this.locale) }) }),
      this.el('span', { className: failed > 0 ? 'font-semibold' : '' }, [
        failed > 0 ? ragUiIcon(this.doc, 'exclamation-triangle', 'mr-1') : null,
        this.doc.createTextNode(this.t('sync.failed', { count: ragUiFormatNumber(failed, this.locale) })),
      ]),
      this.el('span', {
        text: Number.isFinite(Number(backend.oldestPendingSeconds)) && backend.oldestPendingSeconds !== null ? this.t('sync.oldest', { age: this.formatAge(backend.oldestPendingSeconds) }) : this.t('sync.oldestNone'),
      }),
    ]);
    const profiles = Array.isArray(backend.profiles) ? backend.profiles.filter((p) => p && typeof p.profileId === 'string') : [];
    let state;
    if (profiles.length === 0) {
      state = this.el('p', { className: 'text-sm text-base-content/70 mt-2', text: this.t('sync.noState') });
    } else {
      const caption = this.t('sync.caption', { backend: name });
      const cols = ['col.ready', 'col.building', 'col.stale', 'col.failed'];
      const keys = ['ready', 'building', 'stale', 'failed'];
      state = this.el('div', { className: 'overflow-x-auto mt-2', attrs: { tabindex: '0', role: 'region', 'aria-label': caption } }, [
        this.el('table', { className: 'table table-sm' }, [
          this.el('caption', { className: 'sr-only', text: caption }),
          this.el('thead', {}, [this.el('tr', {}, [this.el('th', { text: this.t('col.profile'), attrs: { scope: 'col' } }), ...cols.map((c) => this.el('th', { className: 'text-right', text: this.t(c), attrs: { scope: 'col' } }))])]),
          this.el('tbody', {}, profiles.map((p) => this.el('tr', {}, [
            this.el('th', { className: 'font-mono text-xs', text: p.profileId, attrs: { scope: 'row', translate: 'no' } }),
            ...keys.map((k) => this.el('td', { className: 'text-right tabular-nums', text: ragUiFormatNumber(Number(p[k]) || 0, this.locale) })),
          ]))),
        ]),
      ]);
    }
    const line = this.el('span', { className: 'text-sm', attrs: { 'data-rag-pipeline-sync-line': target } });
    return this.el('div', { className: 'mt-4', attrs: { 'data-rag-pipeline-sync-target': target } }, [
      this.el('h6', { className: 'text-sm font-semibold', text: name, attrs: { translate: 'no' } }),
      this.el('div', { className: 'flex flex-wrap items-center gap-2 mt-2' }, [this.el('label', { className: 'text-sm', text: this.t('sync.toggle', { backend: name }), attrs: { for: id } }), toggle, word, line]),
      outbox,
      state,
    ]);
  }

  async confirmSync(target, turnOn, toggle, word) {
    const name = ragPipelineBackendName(target);
    const prefix = turnOn ? 'confirm.syncOn' : 'confirm.syncOff';
    await ragUiConfirmDialog(this.doc, {
      title: this.t(prefix + '.title', { backend: name }),
      body: [this.t(prefix + '.body', { backend: name })],
      keepLabel: this.t(prefix + '.keep'),
      confirmLabel: this.t(prefix + '.confirm'),
      runningLabel: this.t(turnOn ? 'sync.turningOn' : 'sync.turningOff'),
      opener: toggle,
      fallbackFocus: this.host.status,
      onConfirm: async () => {
        toggle.disabled = true;
        const line = this.syncHost ? this.syncHost.querySelector('[data-rag-pipeline-sync-line="' + target + '"]') : null;
        if (line) line.textContent = this.t(turnOn ? 'sync.turningOn' : 'sync.turningOff');
        const result = await ragUiRagRequest('/api/rag/admin/vector-sync/targets', { method: 'PUT', body: JSON.stringify({ target, enabled: turnOn }) }, RAG_PIPELINE_SYNC_TIMEOUT_MS);
        if (result && result.ok && result.body) {
          const count = ragUiFormatNumber(Number(result.body.tenantsEnqueued) || 0, this.locale);
          this.announce(turnOn ? this.t('sync.on.done', { backend: name, count }) : this.t('sync.off.done', { backend: name }));
        } else if (result && (result.status === 401 || result.status === 403)) {
          this.announce(ragUiSharedLabel('error.signIn', this.locale), true);
        } else if (!result || result.thrown) {
          this.announce(this.t('sync.unknown'), true);
        } else {
          const code = result.body && result.body.error ? ragPipelineText(result.body.error) : String(result.status);
          this.announce(this.t('sync.refused', { code }), true);
        }
        await this.loadAdmin();
        return undefined;
      },
    });
  }

  async runTest(providerId, label, probes, button, resultHost) {
    const restore = ragUiButtonBusy(this.doc, button, this.t('test.running'));
    const lines = [];
    let signIn = false;
    try {
      for (const probe of probes) {
        const result = await ragUiRagRequest('/api/rag/admin/providers/test', { method: 'POST', body: JSON.stringify({ provider: probe }) }, RAG_PIPELINE_REQUEST_TIMEOUT_MS);
        const sentence = ragPipelineTestSentence(result, this.locale);
        if (sentence.signIn) signIn = true;
        const text = sentence.signIn ? ragUiSharedLabel('error.signIn', this.locale) : sentence.text;
        const role = probes.length > 1 ? (probe.startsWith('rerank:') ? 'test.role.rerank' : 'test.role.embedding') : null;
        lines.push({ ok: sentence.ok, text: role ? this.t(role, { result: text }) : text, probe });
      }
    } finally {
      restore();
    }
    let time = '';
    try {
      time = new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
    } catch {
      time = new Date().toISOString();
    }
    resultHost.replaceChildren(
      ...lines.map((line) => this.el('p', { className: 'flex items-start gap-1', attrs: { 'data-rag-pipeline-test-line': line.probe } }, [ragUiIcon(this.doc, line.ok ? 'check-circle' : 'x-circle', 'mt-1'), this.el('span', { text: line.text })])),
      this.el('p', { className: 'text-xs text-base-content/70', text: this.t('test.time', { time }) }),
    );
    this.announce(lines.map((line) => this.t('test.announce', { provider: label, result: line.text })).join(' '));
    if (signIn) {
      this.adminState = 'signIn';
      this.renderAlertHost();
    }
  }
}

let ragPipelineInstance = null;

function initRagPipelineSettings() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById(RAG_PIPELINE_SECTION_ID);
  if (!root) return null;
  if (!ragPipelineInstance) ragPipelineInstance = new RagPipelineSettings(document, root);
  if (typeof window !== 'undefined') window.ragPipelineSettings = ragPipelineInstance;
  ragPipelineInstance.mount();
  return ragPipelineInstance;
}

if (typeof window !== 'undefined') {
  window.initRagPipelineSettings = initRagPipelineSettings;
  window.RAG_PIPELINE_PROVIDER_PROBES = RAG_PIPELINE_PROVIDER_PROBES;
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initRagPipelineSettings);
  else initRagPipelineSettings();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RAG_PIPELINE_LABELS,
    RAG_PIPELINE_GROUP_ORDER,
    RAG_PIPELINE_PROVIDER_PROBES,
    RAG_PIPELINE_PROVIDER_NAMES,
    RAG_PIPELINE_RELATED_PANELS,
    RagPipelineSettings,
    initRagPipelineSettings,
    ragPipelineEntries,
    ragPipelineGroups,
    ragPipelineIsChanged,
    ragPipelineLabel,
    ragPipelineParseRequirement,
    ragPipelineRequirementMet,
    ragPipelineCompatSentence,
    ragPipelineTestSentence,
    ragPipelineEnvChanged,
    ragPipelineProbes,
  };
}
