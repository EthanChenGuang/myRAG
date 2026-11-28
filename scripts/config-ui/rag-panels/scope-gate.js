/**
 * Scope gate panel (UI-SPEC 6.3, D-25 to D-27, D-33 item 2). Says first whether the gate can skip retrieval in the chosen
 * workspace, then manages its scope data and out-of-scope examples through /api/rag/admin/scope-gate. Plain-text DOM only
 * (rag-ui.js ragUiEl); no score, vector or tenant key is rendered.
 */

const SCOPE_GATE_LABELS = {
  en: {
    "panel.title": "Scope gate",
    "panel.description": "Skips retrieval for questions that are clearly outside what this knowledge base covers. What is in scope is learned only from the workspace’s own documents, document types and tags; no topic list is built in.",
    "switch.label": "Enable the scope gate ({variable})",
    "switch.help": "Off sends every question to retrieval, as today. Voice never uses the scope gate.",
    "warn.needsV2Layer": "The scope gate runs only in the v2 pipeline with the query layer on. One of them is off under RAG Modes.",
    "action.refresh": "Refresh status",
    "status.loading": "Loading the scope gate…",
    "status.loaded": "Status loaded. Reference points: {points}. Examples: {examples}.",
    "error.unavailable": "The scope gate status is unavailable right now. Select Reload panel in a moment.",
    "error.notAvailable": "The scope gate is not available on this deployment. Update the app, then reload.",
    "status.notLoaded": "Status not loaded.",
    "cell.recorded": "Recorded: {time}",
    "effect.heading": "In effect now",
    "effect.active": "The scope gate can skip retrieval in this workspace.",
    "effect.inactive": "Every question is still retrieved in this workspace.",
    "effect.explain": "The gate skips retrieval only when all four lines below are ready and a question is clearly out of scope. When it is unsure, the question is retrieved as usual.",
    "ready.switch": "Switch",
    "ready.pipeline": "Pipeline",
    "ready.calibration": "Thresholds",
    "ready.scopeData": "Scope data",
    "state.ready": "Ready",
    "state.on": "On",
    "state.off": "Off",
    "state.missing": "Missing",
    "state.notReady": "Not ready",
    "state.rebuilding": "Rebuilding",
    "state.notUsable": "Not usable",
    "state.evalOnly": "Fixture, eval only",
    "reason.switch.on": "The app runs with the scope gate on.",
    "reason.switch.off": "The scope gate is off, so nothing is skipped.",
    "reason.switch.pending": "Settings show the scope gate {draft}; the app uses {live} until it restarts with the saved value.",
    "reason.pipeline.ready": "The v2 pipeline and the query layer are on.",
    "reason.pipeline.legacy": "The legacy pipeline is selected. The scope gate runs only in the v2 pipeline (RAG Modes, Retrieval pipeline).",
    "reason.pipeline.layerOff": "The query layer is off. The scope gate runs only with it on (RAG Modes, Query layer).",
    "reason.pipeline.bypass": "Bypass RAG is selected, so nothing is retrieved and the scope gate does not run.",
    "action.openModes": "Open RAG Modes",
    "reason.calibration.ready": "A calibrated threshold exists for embedding profile {profile} in {mode} mode.",
    "reason.calibration.missing": "No calibrated threshold for embedding profile {profile} in {mode} mode. Run {command}, commit the result and redeploy.",
    "reason.calibration.evalOnly": "The only threshold for embedding profile {profile} in {mode} mode comes from the test fixture. It is used in evaluation only, never for live answers. Run {command} against the live app, commit the result and redeploy.",
    "reason.calibration.invalid": "The threshold file in this deployment (eval/config/scope-gate.json) is not valid, so no threshold is applied. Run {command} again, commit the result and redeploy.",
    "reason.scopeData.ready": "Reference points: {points}. Updated {time}.",
    "reason.scopeData.missing": "No scope data for embedding profile {profile} in this workspace. Select Rebuild scope data.",
    "reason.scopeData.missingCli": "No scope data for embedding profile {profile} in this workspace. Run {command}.",
    "reason.scopeData.rebuilding": "Scope data is being rebuilt. Until it finishes, every question is retrieved.",
    "reason.scopeData.unsupported": "This workspace uses different embedding profiles for some document types, so the scope gate stays unsure here and every question is retrieved.",
    "reason.unknown": "This line is not ready. State: {code}",
    "outcome.summary": "What happens to an out-of-scope question",
    "outcome.strict": "Strict mode: the answer says the information is not available, or web search is used when it is on.",
    "outcome.other": "Balanced and flexible modes: the question is answered without knowledge-base context, and the answer says so.",
    "outcome.voice": "Voice: the scope gate is never used.",
    "outcome.unsure": "When the gate is unsure: the question is retrieved as usual.",
    "data.heading": "Scope data",
    "data.description": "Built from the documents of this workspace that are current and ready: one reference point per document type, per tag and for the workspace as a whole. It is updated when documents are published. Rebuild it after the embedding profile changes.",
    "data.caption": "Scope data by what it was built from",
    "col.builtFrom": "Built from",
    "col.points": "Reference points",
    "col.chunks": "Chunks included",
    "col.updated": "Updated",
    "kind.doc_type": "Document types",
    "kind.scope_tag": "Tags",
    "kind.tenant": "Whole workspace",
    "data.never": "Never built",
    "action.rebuild": "Rebuild scope data",
    "rebuild.running": "Rebuilding…",
    "rebuild.done": "Scope data rebuilt. Reference points: {points}.",
    "rebuild.started": "Rebuild started. This panel refreshes every 15 seconds until it finishes.",
    "rebuild.stillRunning": "Still rebuilding. Select Refresh status to check again.",
    "rebuild.failed": "Scope data was not rebuilt. Select Rebuild scope data again in a moment.",
    "rebuild.cli": "Rebuild from a terminal: {command}",
    "action.copy": "Copy command",
    "copy.done": "Command copied.",
    "data.empty.title": "No scope data yet",
    "data.empty.body": "Nothing has been built for this workspace and embedding profile, so every question is retrieved. Select Rebuild scope data.",
    "examples.heading": "Out-of-scope examples",
    "examples.description": "Questions this workspace’s knowledge base should not answer. A question that is closer to one of these than to the documents skips retrieval.",
    "examples.count": "Examples: {count} of {max}",
    "examples.label": "New out-of-scope example",
    "examples.placeholder": "Type a question…",
    "examples.help": "Write the question as a user would ask it, one question per example. Up to {max} characters.",
    "action.add": "Add example",
    "add.running": "Adding…",
    "add.done": "Example added.",
    "examples.caption": "Out-of-scope examples of this workspace",
    "col.example": "Example",
    "col.added": "Added",
    "col.addedBy": "Added by",
    "col.actions": "Actions",
    "example.notInUse": "Not in use",
    "example.notInUseReason": "Prepared for another embedding profile. Rebuild scope data to include it.",
    "action.delete": "Delete example",
    "action.deleteAria": "Delete example: {text}",
    "examples.full": "The limit of {max} examples is reached. Delete one before adding another.",
    "examples.empty.title": "No out-of-scope examples",
    "examples.empty.body": "The gate works from your documents alone. Add a question here when users keep asking about something this knowledge base should not answer.",
    "error.exampleEmpty": "Enter a question.",
    "error.exampleTooLong": "Up to {max} characters. This has {count}.",
    "error.exampleExists": "This example is already in the list.",
    "error.embedUnavailable": "The example could not be prepared right now, so it was not saved. Select Add example again in a moment.",
    "delete.title": "Delete this out-of-scope example?",
    "delete.body": "Questions like it are no longer skipped because of this example. This can’t be undone.",
    "delete.keep": "Keep example",
    "delete.confirm": "Delete example",
    "delete.done": "Example deleted.",
    "cells.heading": "Thresholds",
    "cells.description": "Read-only. One threshold per embedding profile and RAG mode, written by the calibration tool. Applies to every workspace in this deployment.",
    "cells.explain": "False refusals are answerable questions the gate would have skipped. Correct refusals are questions with no answer in the knowledge base that it skipped.",
    "cells.caption": "Scope gate thresholds by embedding profile and RAG mode",
    "col.profile": "Embedding profile",
    "col.mode": "RAG mode",
    "col.status": "Status",
    "col.threshold": "Threshold",
    "col.margin": "Margin",
    "col.falseRefusal": "False refusals",
    "col.correctRefusal": "Correct refusals",
    "col.recorded": "Recorded",
    "badge.inUse": "In use",
    "status.calibrated": "Calibrated",
    "status.uncalibrated": "Not calibrated",
    "mode.strict": "Strict",
    "mode.balanced": "Balanced",
    "mode.flexible": "Flexible",
    "cell.none": "None",
    "cell.upper": "95% upper bound {value}",
    "cell.n": "n = {n}",
    "cells.empty.title": "No thresholds yet",
    "cells.empty.body": "No calibration result is in this deployment, so the scope gate skips nothing. Run {command}, commit the result and redeploy.",
    "pointer.text": "The scope gate switch, its thresholds and out-of-scope examples are under RAG administration, Scope gate.",
    "pointer.open": "Open scope gate",
    "delete.running": "Deleting…",
    "panel.workspaceDefault": "Default workspace",
  },
  zh: {
    "panel.title": "范围闸门",
    "panel.description": "对明显超出知识库范围的问题跳过检索。范围只从工作区自己的文档、文档类型和标签中得出，没有内置的主题清单。",
    "switch.label": "启用范围闸门（{variable}）",
    "switch.help": "关闭时，所有问题都照常进行检索。语音从不使用范围闸门。",
    "warn.needsV2Layer": "范围闸门只在 v2 流程且查询层开启时运行。RAG Modes 中有一项处于关闭状态。",
    "action.refresh": "刷新状态",
    "status.loading": "正在加载范围闸门…",
    "status.loaded": "状态已加载。参考点：{points}。示例：{examples}。",
    "error.unavailable": "范围闸门状态暂时不可用。请稍后选择“重新加载面板”。",
    "error.notAvailable": "此部署中没有范围闸门。请更新应用，然后重新加载。",
    "status.notLoaded": "状态未加载。",
    "cell.recorded": "记录时间：{time}",
    "effect.heading": "当前生效情况",
    "effect.active": "在此工作区，范围闸门可以跳过检索。",
    "effect.inactive": "在此工作区，所有问题仍会进行检索。",
    "effect.explain": "只有下面四项都就绪、且问题明显超出范围时，闸门才会跳过检索。拿不准时，问题照常检索。",
    "ready.switch": "开关",
    "ready.pipeline": "检索流程",
    "ready.calibration": "阈值",
    "ready.scopeData": "范围数据",
    "state.ready": "就绪",
    "state.on": "开",
    "state.off": "关",
    "state.missing": "缺失",
    "state.notReady": "未就绪",
    "state.rebuilding": "正在重建",
    "state.notUsable": "不可用",
    "state.evalOnly": "测试数据，仅用于评估",
    "reason.switch.on": "应用正在以开启范围闸门的状态运行。",
    "reason.switch.off": "范围闸门已关闭，因此不会跳过任何问题。",
    "reason.switch.pending": "设置中的范围闸门为“{draft}”；在应用以保存的值重启之前，仍为“{live}”。",
    "reason.pipeline.ready": "v2 流程和查询层均已开启。",
    "reason.pipeline.legacy": "当前选择的是旧版流程。范围闸门只在 v2 流程下运行（RAG Modes，Retrieval pipeline）。",
    "reason.pipeline.layerOff": "查询层已关闭。范围闸门只在查询层开启时运行（RAG Modes，Query layer）。",
    "reason.pipeline.bypass": "当前选择了 Bypass RAG，因此不进行检索，范围闸门也不会运行。",
    "action.openModes": "打开 RAG Modes",
    "reason.calibration.ready": "Embedding 配置 {profile} 在{mode}模式下有经过校准的阈值。",
    "reason.calibration.missing": "Embedding 配置 {profile} 在{mode}模式下没有经过校准的阈值。请运行 {command}，提交结果并重新部署。",
    "reason.calibration.evalOnly": "Embedding 配置 {profile} 在{mode}模式下唯一的阈值来自测试数据。它仅用于评估，不会用于实际回答。请在实际应用上运行 {command}，提交结果并重新部署。",
    "reason.calibration.invalid": "本部署中的阈值文件（eval/config/scope-gate.json）无效，因此不会应用任何阈值。请重新运行 {command}，提交结果并重新部署。",
    "reason.scopeData.ready": "参考点：{points}。更新于 {time}。",
    "reason.scopeData.missing": "此工作区没有 Embedding 配置 {profile} 的范围数据。请选择“重建范围数据”。",
    "reason.scopeData.missingCli": "此工作区没有 Embedding 配置 {profile} 的范围数据。请运行 {command}。",
    "reason.scopeData.rebuilding": "正在重建范围数据。完成之前，所有问题都会进行检索。",
    "reason.scopeData.unsupported": "此工作区对部分文档类型使用不同的 Embedding 配置，因此范围闸门在这里始终不作判断，所有问题都会进行检索。",
    "reason.unknown": "此项未就绪。状态：{code}",
    "outcome.summary": "超出范围的问题会怎样处理",
    "outcome.strict": "严格模式：回答说明没有相关信息；如果开启了网络搜索，则使用网络搜索。",
    "outcome.other": "平衡和灵活模式：不使用知识库内容作答，并在回答中说明这一点。",
    "outcome.voice": "语音：从不使用范围闸门。",
    "outcome.unsure": "闸门拿不准时：问题照常检索。",
    "data.heading": "范围数据",
    "data.description": "根据此工作区中当前有效且已就绪的文档生成：每种文档类型、每个标签以及整个工作区各有一个参考点。文档发布时会更新。更换 Embedding 配置后请重建。",
    "data.caption": "按来源列出的范围数据",
    "col.builtFrom": "来源",
    "col.points": "参考点",
    "col.chunks": "包含的切块",
    "col.updated": "更新时间",
    "kind.doc_type": "文档类型",
    "kind.scope_tag": "标签",
    "kind.tenant": "整个工作区",
    "data.never": "从未生成",
    "action.rebuild": "重建范围数据",
    "rebuild.running": "正在重建…",
    "rebuild.done": "范围数据已重建。参考点：{points}。",
    "rebuild.started": "重建已开始。完成之前，此面板每 15 秒刷新一次。",
    "rebuild.stillRunning": "仍在重建。请选择“刷新状态”再次查看。",
    "rebuild.failed": "范围数据未能重建。请稍后再次选择“重建范围数据”。",
    "rebuild.cli": "请在终端中重建：{command}",
    "action.copy": "复制命令",
    "copy.done": "命令已复制。",
    "data.empty.title": "还没有范围数据",
    "data.empty.body": "尚未为此工作区和 Embedding 配置生成数据，因此所有问题都会进行检索。请选择“重建范围数据”。",
    "examples.heading": "范围外示例",
    "examples.description": "此工作区的知识库不应回答的问题。如果某个问题与这些示例的接近程度高于与文档的接近程度，就会跳过检索。",
    "examples.count": "示例：{count} / {max}",
    "examples.label": "新的范围外示例",
    "examples.placeholder": "输入一个问题…",
    "examples.help": "按用户提问的方式填写，每个示例一个问题。不超过 {max} 个字符。",
    "action.add": "添加示例",
    "add.running": "正在添加…",
    "add.done": "示例已添加。",
    "examples.caption": "此工作区的范围外示例",
    "col.example": "示例",
    "col.added": "添加时间",
    "col.addedBy": "添加人",
    "col.actions": "操作",
    "example.notInUse": "未使用",
    "example.notInUseReason": "是为另一个 Embedding 配置准备的。重建范围数据后才会纳入。",
    "action.delete": "删除示例",
    "action.deleteAria": "删除示例：{text}",
    "examples.full": "已达到 {max} 个示例的上限。请先删除一个再添加。",
    "examples.empty.title": "还没有范围外示例",
    "examples.empty.body": "闸门仅凭你的文档即可工作。当用户反复询问此知识库不应回答的内容时，请在这里添加一个问题。",
    "error.exampleEmpty": "请输入一个问题。",
    "error.exampleTooLong": "不超过 {max} 个字符。当前为 {count} 个。",
    "error.exampleExists": "列表中已有此示例。",
    "error.embedUnavailable": "目前无法处理此示例，因此没有保存。请稍后再次选择“添加示例”。",
    "delete.title": "删除这个范围外示例？",
    "delete.body": "类似的问题将不再因这个示例而被跳过。此操作无法撤销。",
    "delete.keep": "保留示例",
    "delete.confirm": "删除示例",
    "delete.done": "示例已删除。",
    "cells.heading": "阈值",
    "cells.description": "只读。每个 Embedding 配置和 RAG 模式各有一个阈值，由校准工具写入。对本部署的所有工作区生效。",
    "cells.explain": "误拒是指本可回答、却会被闸门跳过的问题。正确拒答是指知识库中没有答案、且被闸门跳过的问题。",
    "cells.caption": "按 Embedding 配置和 RAG 模式列出的范围闸门阈值",
    "col.profile": "Embedding 配置",
    "col.mode": "RAG 模式",
    "col.status": "状态",
    "col.threshold": "阈值",
    "col.margin": "余量",
    "col.falseRefusal": "误拒",
    "col.correctRefusal": "正确拒答",
    "col.recorded": "记录时间",
    "badge.inUse": "使用中",
    "status.calibrated": "已校准",
    "status.uncalibrated": "未校准",
    "mode.strict": "严格",
    "mode.balanced": "平衡",
    "mode.flexible": "灵活",
    "cell.none": "无",
    "cell.upper": "95% 上限 {value}",
    "cell.n": "n = {n}",
    "cells.empty.title": "还没有阈值",
    "cells.empty.body": "本部署中没有校准结果，因此范围闸门不会跳过任何问题。请运行 {command}，提交结果并重新部署。",
    "pointer.text": "范围闸门的开关、阈值和范围外示例位于 RAG administration 的“范围闸门”中。",
    "pointer.open": "打开范围闸门",
    "delete.running": "正在删除…",
    "panel.workspaceDefault": "默认工作区",
  },
  it: {
    "panel.title": "Filtro di ambito",
    "panel.description": "Salta il recupero per le domande chiaramente fuori da ciò che questa knowledge base copre. L’ambito si ricava solo dai documenti, dai tipi di documento e dai tag dello spazio di lavoro; non esiste un elenco di argomenti predefinito.",
    "switch.label": "Attiva il filtro di ambito ({variable})",
    "switch.help": "Disattivato, ogni domanda va al recupero, come oggi. La voce non usa mai il filtro di ambito.",
    "warn.needsV2Layer": "Il filtro di ambito funziona solo nella pipeline v2 con il livello di query attivo. In RAG Modes uno dei due è disattivato.",
    "action.refresh": "Aggiorna stato",
    "status.loading": "Caricamento del filtro di ambito…",
    "status.loaded": "Stato caricato. Punti di riferimento: {points}. Esempi: {examples}.",
    "error.unavailable": "Lo stato del filtro di ambito non è disponibile in questo momento. Seleziona Ricarica pannello tra poco.",
    "error.notAvailable": "Il filtro di ambito non è disponibile in questa distribuzione. Aggiorna l’app, poi ricarica.",
    "status.notLoaded": "Stato non caricato.",
    "cell.recorded": "Registrato: {time}",
    "effect.heading": "In vigore ora",
    "effect.active": "In questo spazio di lavoro il filtro di ambito può saltare il recupero.",
    "effect.inactive": "In questo spazio di lavoro ogni domanda viene ancora recuperata.",
    "effect.explain": "Il filtro salta il recupero solo quando le quattro righe qui sotto sono pronte e la domanda è chiaramente fuori ambito. Nel dubbio, la domanda viene recuperata come sempre.",
    "ready.switch": "Interruttore",
    "ready.pipeline": "Pipeline",
    "ready.calibration": "Soglie",
    "ready.scopeData": "Dati di ambito",
    "state.ready": "Pronto",
    "state.on": "Attivo",
    "state.off": "Disattivato",
    "state.missing": "Mancante",
    "state.notReady": "Non pronto",
    "state.rebuilding": "Ricostruzione in corso",
    "state.notUsable": "Non utilizzabile",
    "state.evalOnly": "Fixture, solo valutazione",
    "reason.switch.on": "L’app è in esecuzione con il filtro di ambito attivo.",
    "reason.switch.off": "Il filtro di ambito è disattivato, quindi nulla viene saltato.",
    "reason.switch.pending": "Le impostazioni indicano il filtro di ambito {draft}; l’app usa {live} finché non viene riavviata con il valore salvato.",
    "reason.pipeline.ready": "La pipeline v2 e il livello di query sono attivi.",
    "reason.pipeline.legacy": "È selezionata la pipeline legacy. Il filtro di ambito funziona solo nella pipeline v2 (RAG Modes, Retrieval pipeline).",
    "reason.pipeline.layerOff": "Il livello di query è disattivato. Il filtro di ambito funziona solo quando è attivo (RAG Modes, Query layer).",
    "reason.pipeline.bypass": "È selezionato Bypass RAG, quindi non si recupera nulla e il filtro di ambito non viene eseguito.",
    "action.openModes": "Apri RAG Modes",
    "reason.calibration.ready": "Esiste una soglia calibrata per il profilo di embedding {profile} in modalità {mode}.",
    "reason.calibration.missing": "Nessuna soglia calibrata per il profilo di embedding {profile} in modalità {mode}. Esegui {command}, esegui il commit del risultato e ridistribuisci.",
    "reason.calibration.evalOnly": "L’unica soglia per il profilo di embedding {profile} in modalità {mode} proviene dai dati di test. Viene usata solo nella valutazione, mai per le risposte reali. Esegui {command} sull’app reale, esegui il commit del risultato e ridistribuisci.",
    "reason.calibration.invalid": "Il file delle soglie di questa distribuzione (eval/config/scope-gate.json) non è valido, quindi non viene applicata alcuna soglia. Esegui di nuovo {command}, esegui il commit del risultato e ridistribuisci.",
    "reason.scopeData.ready": "Punti di riferimento: {points}. Aggiornati il {time}.",
    "reason.scopeData.missing": "In questo spazio di lavoro non ci sono dati di ambito per il profilo di embedding {profile}. Seleziona Ricostruisci dati di ambito.",
    "reason.scopeData.missingCli": "In questo spazio di lavoro non ci sono dati di ambito per il profilo di embedding {profile}. Esegui {command}.",
    "reason.scopeData.rebuilding": "I dati di ambito sono in ricostruzione. Finché non termina, ogni domanda viene recuperata.",
    "reason.scopeData.unsupported": "Questo spazio di lavoro usa profili di embedding diversi per alcuni tipi di documento, quindi qui il filtro di ambito resta incerto e ogni domanda viene recuperata.",
    "reason.unknown": "Questa riga non è pronta. Stato: {code}",
    "outcome.summary": "Che cosa succede a una domanda fuori ambito",
    "outcome.strict": "Modalità Strict: la risposta dice che l’informazione non è disponibile, oppure si usa la ricerca web quando è attiva.",
    "outcome.other": "Modalità Balanced e Flexible: la domanda riceve risposta senza contesto della knowledge base, e la risposta lo dice.",
    "outcome.voice": "Voce: il filtro di ambito non viene mai usato.",
    "outcome.unsure": "Quando il filtro è incerto: la domanda viene recuperata come sempre.",
    "data.heading": "Dati di ambito",
    "data.description": "Costruiti dai documenti di questo spazio di lavoro che sono correnti e pronti: un punto di riferimento per ogni tipo di documento, per ogni tag e per l’intero spazio di lavoro. Si aggiornano quando i documenti vengono pubblicati. Ricostruiscili dopo un cambio del profilo di embedding.",
    "data.caption": "Dati di ambito per origine",
    "col.builtFrom": "Costruiti da",
    "col.points": "Punti di riferimento",
    "col.chunks": "Chunk inclusi",
    "col.updated": "Aggiornati",
    "kind.doc_type": "Tipi di documento",
    "kind.scope_tag": "Tag",
    "kind.tenant": "Intero spazio di lavoro",
    "data.never": "Mai costruiti",
    "action.rebuild": "Ricostruisci dati di ambito",
    "rebuild.running": "Ricostruzione…",
    "rebuild.done": "Dati di ambito ricostruiti. Punti di riferimento: {points}.",
    "rebuild.started": "Ricostruzione avviata. Questo pannello si aggiorna ogni 15 secondi finché non termina.",
    "rebuild.stillRunning": "Ricostruzione ancora in corso. Seleziona Aggiorna stato per controllare di nuovo.",
    "rebuild.failed": "I dati di ambito non sono stati ricostruiti. Seleziona di nuovo Ricostruisci dati di ambito tra poco.",
    "rebuild.cli": "Ricostruisci da un terminale: {command}",
    "action.copy": "Copia comando",
    "copy.done": "Comando copiato.",
    "data.empty.title": "Ancora nessun dato di ambito",
    "data.empty.body": "Non è stato costruito nulla per questo spazio di lavoro e profilo di embedding, quindi ogni domanda viene recuperata. Seleziona Ricostruisci dati di ambito.",
    "examples.heading": "Esempi fuori ambito",
    "examples.description": "Domande a cui la knowledge base di questo spazio di lavoro non deve rispondere. Una domanda più vicina a uno di questi esempi che ai documenti salta il recupero.",
    "examples.count": "Esempi: {count} di {max}",
    "examples.label": "Nuovo esempio fuori ambito",
    "examples.placeholder": "Scrivi una domanda…",
    "examples.help": "Scrivi la domanda come la farebbe un utente, una domanda per esempio. Fino a {max} caratteri.",
    "action.add": "Aggiungi esempio",
    "add.running": "Aggiunta…",
    "add.done": "Esempio aggiunto.",
    "examples.caption": "Esempi fuori ambito di questo spazio di lavoro",
    "col.example": "Esempio",
    "col.added": "Aggiunto",
    "col.addedBy": "Aggiunto da",
    "col.actions": "Azioni",
    "example.notInUse": "Non in uso",
    "example.notInUseReason": "Preparato per un altro profilo di embedding. Ricostruisci i dati di ambito per includerlo.",
    "action.delete": "Elimina esempio",
    "action.deleteAria": "Elimina esempio: {text}",
    "examples.full": "È stato raggiunto il limite di {max} esempi. Eliminane uno prima di aggiungerne un altro.",
    "examples.empty.title": "Nessun esempio fuori ambito",
    "examples.empty.body": "Il filtro funziona con i soli documenti. Aggiungi qui una domanda quando gli utenti continuano a chiedere qualcosa a cui questa knowledge base non deve rispondere.",
    "error.exampleEmpty": "Inserisci una domanda.",
    "error.exampleTooLong": "Fino a {max} caratteri. Questo ne ha {count}.",
    "error.exampleExists": "Questo esempio è già nell’elenco.",
    "error.embedUnavailable": "Non è stato possibile preparare l’esempio in questo momento, quindi non è stato salvato. Seleziona di nuovo Aggiungi esempio tra poco.",
    "delete.title": "Eliminare questo esempio fuori ambito?",
    "delete.body": "Le domande simili non vengono più saltate per via di questo esempio. L’operazione non può essere annullata.",
    "delete.keep": "Mantieni esempio",
    "delete.confirm": "Elimina esempio",
    "delete.done": "Esempio eliminato.",
    "cells.heading": "Soglie",
    "cells.description": "Sola lettura. Una soglia per ogni profilo di embedding e modalità RAG, scritta dallo strumento di calibrazione. Vale per tutti gli spazi di lavoro di questa distribuzione.",
    "cells.explain": "I falsi rifiuti sono domande con risposta che il filtro avrebbe saltato. I rifiuti corretti sono domande senza risposta nella knowledge base che ha saltato.",
    "cells.caption": "Soglie del filtro di ambito per profilo di embedding e modalità RAG",
    "col.profile": "Profilo di embedding",
    "col.mode": "Modalità RAG",
    "col.status": "Stato",
    "col.threshold": "Soglia",
    "col.margin": "Margine",
    "col.falseRefusal": "Falsi rifiuti",
    "col.correctRefusal": "Rifiuti corretti",
    "col.recorded": "Registrata",
    "badge.inUse": "In uso",
    "status.calibrated": "Calibrata",
    "status.uncalibrated": "Non calibrata",
    "mode.strict": "Strict",
    "mode.balanced": "Balanced",
    "mode.flexible": "Flexible",
    "cell.none": "Nessuna",
    "cell.upper": "Limite superiore al 95% {value}",
    "cell.n": "n = {n}",
    "cells.empty.title": "Ancora nessuna soglia",
    "cells.empty.body": "In questa distribuzione non c’è alcun risultato di calibrazione, quindi il filtro di ambito non salta nulla. Esegui {command}, esegui il commit del risultato e ridistribuisci.",
    "pointer.text": "L’interruttore del filtro di ambito, le sue soglie e gli esempi fuori ambito sono in RAG administration, Filtro di ambito.",
    "pointer.open": "Apri filtro di ambito",
    "delete.running": "Eliminazione…",
    "panel.workspaceDefault": "Spazio di lavoro predefinito",
  },
};

const SCOPE_GATE_API = '/api/rag/admin/scope-gate';
const SCOPE_GATE_POLL_MS = 15000;
const SCOPE_GATE_POLL_MAX = 20;
const SCOPE_GATE_KINDS = Object.freeze(['doc_type', 'scope_tag', 'tenant']);
const SCOPE_GATE_ROWS = Object.freeze([
  ['switch', 'ready.switch'],
  ['pipeline', 'ready.pipeline'],
  ['thresholds', 'ready.calibration'],
  ['scope_data', 'ready.scopeData'],
]);
const SCOPE_GATE_MODES = Object.freeze(['strict', 'balanced', 'flexible']);
const SCOPE_GATE_DELETE_ARIA_CHARS = 60;
const SCOPE_GATE_BADGES = Object.freeze({
  ready: { tone: 'success', icon: 'check-circle', word: 'state.ready' },
  on: { tone: 'success', icon: 'check-circle', word: 'state.on' },
  off: { tone: 'ghost', icon: 'dash-circle', word: 'state.off' },
  notReady: { tone: 'warning', icon: 'exclamation-triangle', word: 'state.notReady' },
  missing: { tone: 'warning', icon: 'exclamation-triangle', word: 'state.missing' },
  evalOnly: { tone: 'info', icon: 'info-circle', word: 'state.evalOnly' },
  invalid: { tone: 'error', icon: 'x-octagon', word: 'state.notUsable' },
  rebuilding: { tone: 'info', icon: 'hourglass-split', word: 'state.rebuilding' },
  unsupported: { tone: 'warning', icon: 'exclamation-triangle', word: 'state.notUsable' },
});
const SCOPE_GATE_BADGE_CLASS = Object.freeze({
  success: 'badge-success badge-outline',
  ghost: 'badge-ghost',
  warning: 'badge-warning badge-outline',
  info: 'badge-info badge-outline',
  error: 'badge-error badge-outline',
});

let scopeGateUiModule = null;
if (typeof require !== 'undefined') {
  try {
    scopeGateUiModule = require('./rag-ui.js');
  } catch {
    scopeGateUiModule = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function scopeGateUiLib() {
  if (scopeGateUiModule) return scopeGateUiModule;
  const g = typeof window !== 'undefined' ? window : globalThis;
  return g && typeof g.ragUiEl === 'function' ? g : null;
}

function scopeGateLocale(language) {
  const lang = typeof language === 'string' ? language.slice(0, 2).toLowerCase() : '';
  return lang === 'zh' || lang === 'it' ? lang : 'en';
}

/** Panel strings first, then the shared RAG_UI_LABELS and ingestLabel table; English when a locale lacks the key. */
function scopeGateLabel(key, locale, vars) {
  const loc = scopeGateLocale(locale);
  const own = (SCOPE_GATE_LABELS[loc] && SCOPE_GATE_LABELS[loc][key]) || SCOPE_GATE_LABELS.en[key];
  if (own !== undefined) {
    if (!vars) return own;
    return own.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? '') : match));
  }
  const ui = scopeGateUiLib();
  return ui ? ui.ragUiLabel(key, loc, vars) : key;
}

function scopeGateText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function scopeGateNum(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function scopeGateIso(value) {
  if (typeof value !== 'string' || value === '') return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

function scopeGateFormat(value, locale, options) {
  try {
    return new Intl.NumberFormat(locale, options).format(value);
  } catch {
    return String(value);
  }
}

function scopeGateDate(iso, locale, options) {
  try {
    return new Intl.DateTimeFormat(locale, options || { dateStyle: 'medium' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function scopeGateModeVar(mode) {
  return SCOPE_GATE_MODES.includes(mode) ? { label: 'mode.' + mode } : { code: scopeGateText(mode) };
}

/**
 * The four readiness rows (UI-SPEC 6.3.2). Pure: named fields of the GET answer only. page.draftSwitch is the checkbox on
 * the page (null when unknown). A reason is { key, vars } where each var is { text }, { code }, { label } or { time }.
 */
function scopeGateReadinessView(body, page) {
  const data = body && typeof body === 'object' ? body : {};
  const running = data.running && typeof data.running === 'object' ? data.running : {};
  const list = Array.isArray(data.readiness) ? data.readiness : [];
  const scopeData = scopeGateDataView(data);
  const rows = SCOPE_GATE_ROWS.map(([name, labelKey]) => {
    const entry = list.find((item) => item && item.row === name) || {};
    const state = scopeGateText(entry.state);
    const row = { row: name, labelKey, state, badge: null, reason: null, note: null, action: null };
    const unknown = () => {
      row.badge = SCOPE_GATE_BADGES.notReady;
      row.reason = { key: 'reason.unknown', vars: { code: { code: state || 'none' } } };
    };
    if (name === 'switch') {
      if (state === 'on' || state === 'off') {
        row.badge = SCOPE_GATE_BADGES[state];
        row.reason = { key: 'reason.switch.' + state, vars: {} };
        const draft = page && typeof page.draftSwitch === 'boolean' ? (page.draftSwitch ? 'on' : 'off') : null;
        if (draft && draft !== state) {
          row.note = { key: 'reason.switch.pending', vars: { draft: { label: 'state.' + draft }, live: { label: 'state.' + state } } };
        }
      } else unknown();
    } else if (name === 'pipeline') {
      const reasons = { ready: 'reason.pipeline.ready', legacy: 'reason.pipeline.legacy', layer_off: 'reason.pipeline.layerOff', bypass: 'reason.pipeline.bypass' };
      if (state === 'ready') {
        row.badge = SCOPE_GATE_BADGES.ready;
        row.reason = { key: reasons.ready, vars: {} };
      } else if (reasons[state]) {
        row.badge = SCOPE_GATE_BADGES.notReady;
        row.reason = { key: reasons[state], vars: {} };
        row.action = { kind: 'openModes' };
      } else {
        unknown();
        row.action = { kind: 'openModes' };
      }
    } else if (name === 'thresholds') {
      const command = scopeGateText(entry.command) || scopeGateText(data.thresholds && data.thresholds.command);
      const vars = {
        profile: { code: scopeGateText(entry.profileId || running.activeProfileId) },
        mode: scopeGateModeVar(entry.ragMode || running.ragMode),
        command: { code: command },
      };
      const map = {
        ready: ['ready', 'reason.calibration.ready'],
        missing: ['missing', 'reason.calibration.missing'],
        eval_only: ['evalOnly', 'reason.calibration.evalOnly'],
        invalid: ['invalid', 'reason.calibration.invalid'],
      };
      if (map[state]) {
        row.badge = SCOPE_GATE_BADGES[map[state][0]];
        row.reason = { key: map[state][1], vars };
        if (state !== 'ready' && command) row.action = { kind: 'copy', command };
      } else unknown();
    } else {
      const profile = { code: scopeGateText(running.activeProfileId) };
      if (state === 'ready') {
        row.badge = SCOPE_GATE_BADGES.ready;
        const vars = { points: { text: String(scopeData.totalPoints) } };
        row.reason = scopeData.updatedAt
          ? { key: 'reason.scopeData.ready', vars: { ...vars, time: { time: scopeData.updatedAt } } }
          : { key: 'reason.scopeData.ready', vars: { ...vars, time: { text: '—' } } };
      } else if (state === 'missing') {
        row.badge = SCOPE_GATE_BADGES.missing;
        row.reason =
          scopeData.rebuild.mode === 'cli'
            ? { key: 'reason.scopeData.missingCli', vars: { profile, command: { code: scopeData.rebuild.command } } }
            : { key: 'reason.scopeData.missing', vars: { profile } };
        if (scopeData.rebuild.mode === 'cli') row.action = { kind: 'copy', command: scopeData.rebuild.command };
      } else if (state === 'rebuilding') {
        row.badge = SCOPE_GATE_BADGES.rebuilding;
        row.reason = { key: 'reason.scopeData.rebuilding', vars: {} };
      } else if (state === 'unsupported') {
        row.badge = SCOPE_GATE_BADGES.unsupported;
        row.reason = { key: 'reason.scopeData.unsupported', vars: {} };
      } else unknown();
    }
    return row;
  });
  // The server is the authority: the headline follows its can-skip flag, never the rows.
  const canSkip = data.canSkip === true;
  return { canSkip, headlineKey: canSkip ? 'effect.active' : 'effect.inactive', rows };
}

/** Scope data per kind in the fixed order (UI-SPEC 6.3.3), counted over the D-34 group keys the route sends. */
function scopeGateDataView(body) {
  const data = body && typeof body === 'object' && body.scopeData && typeof body.scopeData === 'object' ? body.scopeData : {};
  const kinds = Array.isArray(data.kinds) ? data.kinds.filter((k) => k && typeof k === 'object') : [];
  const workspaceChunks = scopeGateNum(data.chunksIncluded);
  const workspaceUpdated = scopeGateIso(data.updatedAt);
  const toRow = (entry, kind) => {
    const points = scopeGateNum(entry && entry.referencePoints) || 0;
    let chunks = scopeGateNum(entry && entry.chunksIncluded);
    if (chunks === null && kind === 'tenant' && points > 0) chunks = workspaceChunks;
    const updatedAt = scopeGateIso(entry && entry.updatedAt) || (points > 0 ? workspaceUpdated : null);
    return { kind, known: SCOPE_GATE_KINDS.includes(kind), points, chunks: points > 0 ? chunks : 0, updatedAt, never: points === 0 };
  };
  const rows = SCOPE_GATE_KINDS.map((kind) => toRow(kinds.find((k) => k.kind === kind), kind));
  for (const entry of kinds) if (!SCOPE_GATE_KINDS.includes(entry.kind)) rows.push(toRow(entry, scopeGateText(entry.kind)));
  const totalPoints = rows.reduce((sum, row) => sum + row.points, 0);
  const state = scopeGateText(data.state);
  const rebuild = data.rebuild && typeof data.rebuild === 'object' ? data.rebuild : {};
  let mode = 'none';
  let command = '';
  if (state !== 'unsupported') {
    if (rebuild.browser === true) mode = 'button';
    else if (typeof rebuild.command === 'string' && rebuild.command !== '') {
      mode = 'cli';
      command = rebuild.command;
    }
  }
  return { state, rows, totalPoints, empty: totalPoints === 0, updatedAt: workspaceUpdated, rebuild: { mode, command } };
}

/** The out-of-scope examples with the limits the server sends (UI-SPEC 6.3.4). Display name first, the id otherwise. */
function scopeGateExamplesView(body) {
  const data = body && typeof body === 'object' && body.examples && typeof body.examples === 'object' ? body.examples : {};
  const rows = (Array.isArray(data.rows) ? data.rows : [])
    .filter((row) => row && typeof row === 'object' && typeof row.id === 'string')
    .map((row) => {
      const name = scopeGateText(row.createdByName).trim();
      const id = scopeGateText(row.createdBy);
      return {
        id: row.id,
        text: scopeGateText(row.text),
        createdAt: scopeGateIso(row.createdAt),
        addedBy: name ? { kind: 'name', value: name } : id ? { kind: 'id', value: id } : { kind: 'none', value: '' },
        inUse: row.inUse !== false,
      };
    });
  const total = scopeGateNum(data.total) ?? rows.length;
  const limit = scopeGateNum(data.limit) ?? 100;
  const maxChars = scopeGateNum(data.maxChars) ?? 500;
  return { rows, total, limit, maxChars, full: total >= limit };
}

/** The read-only threshold rows of eval/config/scope-gate.json (UI-SPEC 6.3.5), formatted for the locale. */
function scopeGateThresholdsView(body, locale) {
  const data = body && typeof body === 'object' && body.thresholds && typeof body.thresholds === 'object' ? body.thresholds : {};
  const command = scopeGateText(data.command);
  const decimals = (value) => (value === null ? null : scopeGateFormat(value, locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
  const percent = (value) => (value === null ? null : scopeGateFormat(value, locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  const rows = (Array.isArray(data.rows) ? data.rows : [])
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      const status = scopeGateText(row.status);
      return {
        profileId: scopeGateText(row.embeddingProfileId),
        active: row.activeProfile === true,
        mode: scopeGateModeVar(row.ragMode),
        status: status === 'calibrated' || status === 'uncalibrated' ? { key: 'status.' + status } : { code: status },
        fixture: row.source === 'fixture',
        threshold: decimals(scopeGateNum(row.threshold)),
        margin: decimals(scopeGateNum(row.margin)),
        falseRate: percent(scopeGateNum(row.falseRefusalRate)),
        falseUpper: percent(scopeGateNum(row.falseRefusalUpper95)),
        falseN: scopeGateNum(row.falseRefusalN),
        correctRate: percent(scopeGateNum(row.correctRefusalRate)),
        correctN: scopeGateNum(row.correctRefusalN),
        recordedAt: scopeGateIso(row.recordedAt),
      };
    });
  const usable = data.present === true && data.valid !== false && rows.length > 0;
  return { empty: !usable, command, rows };
}

/**
 * UI-SPEC 8.2 for this panel. action: load | add | delete | rebuild. Returns { kind, key, field?, vars? } where kind is
 * signIn | workspace | unavailable | network | outcomeUnknown | field | full | changed | started | unsupported | failed |
 * invalid | generic.
 */
function scopeGateMapError(result, action) {
  const status = result && result.status;
  const body = (result && result.body && typeof result.body === 'object' ? result.body : null) || {};
  const err = typeof body.error === 'string' ? body.error : '';
  if (!result || result.thrown) return action === 'load' ? { kind: 'network', key: 'error.network' } : { kind: 'outcomeUnknown', key: 'error.outcomeUnknown' };
  if (status === 401 || (status === 403 && err !== 'Forbidden')) return { kind: 'signIn', key: 'error.signIn' };
  if (status === 403) return { kind: 'workspace', key: 'error.workspace' };
  if (action === 'add') {
    if (status === 400 && err === 'text_empty') return { kind: 'field', key: 'error.exampleEmpty' };
    if (status === 400 && err === 'text_too_long') return { kind: 'field', key: 'error.exampleTooLong' };
    if (status === 409 && err === 'example_exists') return { kind: 'field', key: 'error.exampleExists' };
    if ((status === 409 || status === 413) && err === 'limit') return { kind: 'full', key: 'examples.full' };
    if (status === 503 && err === 'embedding_unavailable') return { kind: 'field', key: 'error.embedUnavailable' };
  }
  if (action === 'rebuild') {
    if (status === 409 && err === 'rebuild_running') return { kind: 'started', key: 'rebuild.started' };
    if (status === 409 && err === 'unsupported_binding') return { kind: 'unsupported', key: 'reason.scopeData.unsupported' };
    if (status === 503) return { kind: 'failed', key: 'rebuild.failed' };
  }
  if (status === 503) return { kind: 'unavailable', key: 'error.unavailable' };
  if (status === 404) return action === 'load' ? { kind: 'notAvailable', key: 'error.notAvailable' } : { kind: 'changed', key: 'error.changed' };
  if (status === 400) {
    const detail = Array.isArray(body.details) && body.details[0] && typeof body.details[0] === 'object' ? body.details[0] : null;
    return { kind: 'invalid', key: 'error.invalid', vars: { detail: detail && typeof detail.message === 'string' ? detail.message : err } };
  }
  return { kind: 'generic', key: 'error.generic', vars: { status: status || '?' } };
}

function scopeGateIsMultiTenant() {
  const config = typeof window !== 'undefined' && window.currentConfig && typeof window.currentConfig === 'object' ? window.currentConfig : {};
  return (config.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE || config.MYRAG_DEPLOYMENT_MODE) === 'multi-tenant';
}

function scopeGateReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

class ScopeGatePanel {
  constructor(root, deps) {
    const d = deps || {};
    this.root = root;
    this.doc = d.document || (typeof document !== 'undefined' ? document : null);
    this.locale = scopeGateLocale(d.locale || (typeof navigator !== 'undefined' && navigator ? navigator.language : undefined));
    this.request = d.request || ((apiPath, init) => this.ui().ragUiRagRequest(apiPath, init));
    this.schedule = d.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.cancel = d.cancel || ((id) => clearTimeout(id));
    this.mounted = false;
    this.body = null;
    this.seq = 0;
    this.organizationId = null;
    this.fieldErrorKey = null;
    this.fieldErrorVars = null;
    this.poll = null;
    this.busy = false;
  }

  ui() {
    return scopeGateUiLib();
  }

  t(key, vars) {
    return scopeGateLabel(key, this.locale, vars);
  }

  el(tag, options, children) {
    return this.ui().ragUiEl(this.doc, tag, options, children);
  }

  icon(name, extra) {
    return this.ui().ragUiIcon(this.doc, name, extra);
  }

  hook(name) {
    return this.root.querySelector('[data-scope-gate-' + name + ']');
  }

  /** A sentence whose {vars} become text, code, a localized word or a time element (UI-SPEC 12: code placeholders are code). */
  sentence(key, vars, className) {
    const nodes = [];
    const text = this.t(key);
    const re = /\{(\w+)\}/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) nodes.push(this.doc.createTextNode(text.slice(last, m.index)));
      const v = vars && vars[m[1]];
      if (!v) nodes.push(this.doc.createTextNode(m[0]));
      else if (v.code !== undefined) nodes.push(this.el('code', { className: 'font-mono text-xs break-all', text: v.code, attrs: { translate: 'no' } }));
      else if (v.label !== undefined) nodes.push(this.doc.createTextNode(this.t(v.label)));
      else if (v.time !== undefined) nodes.push(this.time(v.time, v.options));
      else nodes.push(this.doc.createTextNode(scopeGateText(v.text)));
      last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push(this.doc.createTextNode(text.slice(last)));
    return this.el('span', { className: className || '' }, nodes);
  }

  time(iso, options) {
    return this.el('time', { text: scopeGateDate(iso, this.locale, options), attrs: { datetime: iso } });
  }

  async mount() {
    if (!this.ui()) {
      console.error('[Scope Gate] rag-ui.js is not loaded; the panel is not mounted');
      return;
    }
    if (this.mounted) {
      await this.refresh();
      return;
    }
    this.mounted = true;
    this.root.setAttribute('lang', this.locale);
    this.localizeStatic();
    this.content = this.hook('content');
    this.alertHost = this.hook('alert');
    if (this.content) {
      // Change-event isolation (UI-SPEC 6.1): no panel-local field reaches the page-wide config writer.
      this.content.addEventListener('change', (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      });
    }
    this.buildSkeleton();
    this.bindSwitch();
    this.bindWorkspace();
    this.bindVisibility();
    await this.load('first');
  }

  localizeStatic() {
    if (this.locale === 'en') return;
    for (const node of this.root.querySelectorAll('[data-rag-i18n]')) {
      const key = node.getAttribute('data-rag-i18n');
      if (key === 'switch.label') {
        const parts = this.t(key).split('{variable}');
        node.replaceChildren(
          this.doc.createTextNode(parts[0] || ''),
          this.el('span', { text: 'RAG_SCOPE_GATE', attrs: { translate: 'no' } }),
          this.doc.createTextNode(parts[1] || ''),
        );
      } else if (SCOPE_GATE_LABELS[this.locale][key] !== undefined) node.textContent = this.t(key);
    }
  }

  buildSkeleton() {
    const ui = this.ui();
    this.updatedEl = this.el('span', { className: 'text-xs text-base-content/70 tabular-nums' });
    this.refreshButton = this.el('button', { className: 'btn btn-outline btn-sm', attrs: { type: 'button' } }, [this.icon('arrow-clockwise'), this.el('span', { text: this.t('action.refresh') })]);
    this.refreshButton.addEventListener('click', () => this.refresh());
    this.toolbar = this.el('div', { className: 'flex flex-wrap items-center justify-end gap-2' }, [this.updatedEl, this.refreshButton]);
    this.blocks = this.el('div', { className: 'min-w-0 [overflow-wrap:break-word]' });
    if (this.content) this.content.replaceChildren(this.toolbar, this.blocks);
    this.textarea = this.el('textarea', {
      className: 'textarea textarea-bordered textarea-sm w-full',
      id: ui.ragUiNextId('rag-scope-gate-example'),
      attrs: { name: 'scope-gate-example', rows: '2', autocomplete: 'off', dir: 'auto', translate: 'no', spellcheck: 'false', placeholder: this.t('examples.placeholder') },
    });
    this.helpId = ui.ragUiNextId('rag-scope-gate-example-help');
    this.errorId = ui.ragUiNextId('rag-scope-gate-example-error');
    this.textarea.setAttribute('aria-describedby', this.helpId);
    this.textarea.addEventListener('keydown', (event) => {
      if (event && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        this.addExample();
      }
    });
    this.textarea.addEventListener('input', () => {
      if (this.fieldErrorKey) this.setFieldError(null);
    });
    this.helpEl = this.el('p', { className: 'text-xs text-base-content/70 mt-1', id: this.helpId });
    this.errorEl = this.el('p', { className: 'text-sm text-error mt-1 break-words empty:hidden', id: this.errorId, attrs: { 'aria-live': 'polite' } });
    this.addButton = this.el('button', { className: 'btn btn-primary btn-sm shrink-0', attrs: { type: 'button' } }, [this.icon('plus-lg'), this.el('span', { text: this.t('action.add') })]);
    this.addButton.addEventListener('click', () => this.addExample());
    this.form = this.el('div', { className: 'bg-base-100 rounded-lg p-4 mb-4' }, [
      this.el('div', { className: 'flex flex-col md:flex-row md:items-end gap-2' }, [
        this.el('div', { className: 'form-control flex-1 min-w-0' }, [
          this.el('label', { className: 'label', attrs: { for: this.textarea.id } }, [this.el('span', { className: 'label-text', text: this.t('examples.label') })]),
          this.textarea,
        ]),
        this.addButton,
      ]),
      this.helpEl,
      this.errorEl,
    ]);
  }

  /** The derived note under the switch (UI-SPEC 6.3.1): works without an admin session. */
  bindSwitch() {
    const update = () => {
      this.renderNote();
      if (this.body) this.renderBlocks();
    };
    for (const id of ['RAG_SCOPE_GATE', 'RAG_PIPELINE', 'RAG_QUERY_LAYER']) {
      const control = this.doc.getElementById(id);
      if (control) control.addEventListener('change', update);
    }
    this.renderNote();
  }

  draftSwitch() {
    const box = this.doc.getElementById('RAG_SCOPE_GATE');
    return box ? Boolean(box.checked) : null;
  }

  renderNote() {
    const note = this.hook('note');
    if (!note) return;
    const box = this.doc.getElementById('RAG_SCOPE_GATE');
    const pipeline = this.doc.getElementById('RAG_PIPELINE');
    const layer = this.doc.getElementById('RAG_QUERY_LAYER');
    const needs = box && box.checked && ((pipeline && pipeline.value !== 'v2') || (layer && !layer.checked));
    note.replaceChildren(
      ...(needs ? [this.el('p', { className: 'text-warning flex items-start gap-1 mt-1' }, [this.icon('exclamation-triangle', 'mt-0.5'), this.el('span', { className: 'min-w-0', text: this.t('warn.needsV2Layer') })])] : []),
    );
  }

  selector() {
    return this.doc.getElementById('workspace-selector');
  }

  workspaceName() {
    const selector = this.selector();
    if (!selector || !selector.value) return this.t('panel.workspaceDefault');
    const option = Array.from(selector.querySelectorAll('option')).find((o) => o.getAttribute('value') === selector.value);
    const name = option ? option.textContent.trim() : '';
    return name || this.t('panel.workspaceDefault');
  }

  readWorkspace() {
    const selector = this.selector();
    this.organizationId = selector && selector.value ? String(selector.value) : null;
    let line = this.root.querySelector('[data-scope-gate-workspace]');
    if (!scopeGateIsMultiTenant()) {
      if (line) line.remove();
      return;
    }
    if (!line) {
      line = this.el('p', { className: 'text-xs text-base-content/70 -mt-2 mb-4 break-words', attrs: { 'data-scope-gate-workspace': '' } });
      const description = this.hook('description');
      const parent = description ? description.parentNode : null;
      if (parent) {
        const siblings = Array.from(parent.childNodes);
        parent.insertBefore(line, siblings[siblings.indexOf(description) + 1] || null);
      }
    }
    line.textContent = this.t('panel.workspace', { name: this.workspaceName() });
  }

  bindWorkspace() {
    this.readWorkspace();
    const selector = this.selector();
    if (!selector) return;
    selector.addEventListener('change', async () => {
      this.readWorkspace();
      this.stopPoll();
      this.body = null;
      this.textarea.value = '';
      this.setFieldError(null);
      await this.load('first');
    });
  }

  bindVisibility() {
    if (typeof this.doc.addEventListener !== 'function') return;
    this.doc.addEventListener('visibilitychange', () => {
      if (this.poll && this.poll.waiting && this.doc.visibilityState !== 'hidden') {
        this.poll.waiting = false;
        this.schedulePoll();
      }
    });
  }

  query() {
    return this.organizationId ? '?' + new URLSearchParams({ organizationId: this.organizationId }).toString() : '';
  }

  announce(text, isError) {
    const status = this.hook('status');
    if (!status) return;
    status.classList.toggle('text-error', Boolean(isError));
    status.replaceChildren(
      ...(isError ? [this.icon('exclamation-circle', 'mr-1')] : []),
      ...(typeof text === 'string' ? [this.doc.createTextNode(text)] : text ? [text] : []),
    );
  }

  async refresh() {
    this.readWorkspace();
    await this.load('panel');
  }

  async load(source) {
    if (!this.blocks) return;
    const ui = this.ui();
    const seq = ++this.seq;
    const hadContent = Boolean(this.body);
    let restore = null;
    if (hadContent) {
      ui.ragUiListBusy(this.blocks, true);
      if (source !== 'poll') restore = ui.ragUiButtonBusy(this.doc, this.refreshButton, this.t('action.refresh'), []);
    } else {
      this.alertHost.replaceChildren();
      ui.ragUiListLoading(this.doc, this.blocks, this.t('status.loading'));
      this.announce(this.t('status.loading'));
    }
    let result;
    try {
      result = await this.request(SCOPE_GATE_API + this.query(), { method: 'GET' });
    } catch {
      result = { ok: false, thrown: true, status: 0, body: null };
    }
    if (restore) restore();
    if (seq !== this.seq) return null;
    ui.ragUiListBusy(this.blocks, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      this.body = result.body;
      this.loadedAt = new Date().toISOString();
      this.alertHost.replaceChildren();
      this.renderBlocks();
      if (source !== 'poll') {
        const data = scopeGateDataView(this.body);
        const examples = scopeGateExamplesView(this.body);
        this.announce(this.t('status.loaded', { points: ui.ragUiFormatNumber(data.totalPoints, this.locale), examples: ui.ragUiFormatNumber(examples.total, this.locale) }));
      }
      return this.body;
    }
    this.loadFailed(result, hadContent);
    return null;
  }

  loadFailed(result, hadContent) {
    const ui = this.ui();
    const mapped = scopeGateMapError(result, 'load');
    const reload = () => this.refresh();
    this.stopPoll();
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.body = null;
      this.blocks.replaceChildren();
      this.updatedEl.textContent = '';
      const alert =
        mapped.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, reload)
          : ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [this.t('error.workspace')], actions: [ui.ragUiReloadButton(this.doc, this.locale, reload)] });
      this.alertHost.replaceChildren(alert);
      this.announce(this.t('status.notLoaded'));
      return;
    }
    if (mapped.kind === 'notAvailable') {
      this.body = null;
      this.blocks.replaceChildren();
      this.updatedEl.textContent = '';
      const alert = ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('error.notAvailable')], actions: [ui.ragUiReloadButton(this.doc, this.locale, reload)] });
      alert.setAttribute('data-scope-gate-not-available', '');
      this.alertHost.replaceChildren(alert);
      this.announce(this.t('status.notLoaded'));
      return;
    }
    const message = mapped.kind === 'network' ? ui.ragUiSharedLabel('error.network', this.locale) : mapped.kind === 'unavailable' ? this.t('error.unavailable') : this.message(mapped);
    if (hadContent) ui.ragUiListBusy(this.blocks, true, true);
    else this.blocks.replaceChildren();
    this.alertHost.replaceChildren(ui.ragUiUnavailableAlert(this.doc, this.locale, message, reload));
    this.announce(this.t('status.notLoaded'));
  }

  message(mapped) {
    const ui = this.ui();
    if (mapped.key === 'error.signIn' || mapped.key === 'error.network' || mapped.key === 'error.generic') return ui.ragUiSharedLabel(mapped.key, this.locale, mapped.vars);
    return this.t(mapped.key, mapped.vars);
  }

  renderBlocks() {
    const body = this.body;
    if (!body) return;
    this.updatedEl.replaceChildren(...(this.loadedAt ? [this.sentence('panel.updated', { time: { time: this.loadedAt, options: { timeStyle: 'short' } } })] : []));
    this.blocks.replaceChildren(this.renderEffect(body), this.renderData(body), this.renderExamples(body), this.renderThresholds(body));
  }

  heading(key) {
    return this.el('h4', { className: 'text-base font-semibold mb-2 text-balance', text: this.t(key) });
  }

  badge(spec) {
    return this.el('span', { className: 'badge badge-sm gap-1 shrink-0 whitespace-nowrap ' + SCOPE_GATE_BADGE_CLASS[spec.tone] }, [this.icon(spec.icon), this.el('span', { text: this.t(spec.word) })]);
  }

  copyButton(command) {
    const button = this.el('button', { className: 'btn btn-ghost btn-xs', attrs: { type: 'button' } }, [this.icon('clipboard'), this.el('span', { text: this.t('action.copy') })]);
    button.addEventListener('click', async () => {
      const clip = typeof navigator !== 'undefined' && navigator && navigator.clipboard;
      if (!clip || typeof clip.writeText !== 'function') return;
      try {
        await clip.writeText(command);
        this.announce(this.t('copy.done'));
      } catch {
        // The command stays selectable in its code element.
      }
    });
    return button;
  }

  openModesButton() {
    const button = this.el('button', { className: 'btn btn-link btn-xs px-0', text: this.t('action.openModes'), attrs: { type: 'button' } });
    button.addEventListener('click', () => {
      const link = this.doc.querySelector('.menu-item[data-tab="rag-modes"]') || this.doc.querySelector('[data-tab="rag-modes"]');
      if (link) link.click();
      const target = this.doc.getElementById('RAG_PIPELINE');
      if (target) {
        if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: scopeGateReducedMotion() ? 'auto' : 'smooth', block: 'center' });
        target.focus({ preventScroll: true });
      }
    });
    return button;
  }

  emptyBlock(titleKey, bodyNode) {
    return this.el('div', { className: 'py-8 text-center', attrs: { 'data-scope-gate-empty': titleKey } }, [
      this.el('p', { className: 'text-base font-semibold text-balance', text: this.t(titleKey) }),
      this.el('div', { className: 'text-sm text-base-content/70 mt-2 max-w-prose mx-auto' }, [bodyNode]),
    ]);
  }

  tableRegion(caption, table) {
    return this.el(
      'div',
      {
        className: 'overflow-x-auto min-w-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': caption },
      },
      [table],
    );
  }

  th(key, extra) {
    return this.el('th', { className: 'text-xs font-semibold ' + (extra || ''), text: this.t(key), attrs: { scope: 'col' } });
  }

  renderEffect(body) {
    const view = scopeGateReadinessView(body, { draftSwitch: this.draftSwitch() });
    const list = this.el('dl', { className: 'grid gap-y-2 mt-4', attrs: { 'data-scope-gate-readiness': '' } });
    for (const row of view.rows) {
      const reason = this.el('div', { className: 'min-w-0 flex-1 basis-60' }, [this.sentence(row.reason.key, row.reason.vars, 'text-sm break-words')]);
      if (row.note) reason.appendChild(this.el('p', { className: 'text-xs text-base-content/70 mt-1' }, [this.sentence(row.note.key, row.note.vars)]));
      const parts = [this.badge(row.badge), reason];
      if (row.action && row.action.kind === 'openModes') parts.push(this.openModesButton());
      if (row.action && row.action.kind === 'copy') parts.push(this.copyButton(row.action.command));
      list.appendChild(
        this.el('div', { className: 'grid grid-cols-1 md:grid-cols-12 gap-x-6 gap-y-1 items-start', attrs: { 'data-scope-gate-row': row.row, 'data-state': row.state } }, [
          this.el('dt', { className: 'md:col-span-2 text-sm', text: this.t(row.labelKey) }),
          this.el('dd', { className: 'md:col-span-10 min-w-0' }, [this.el('div', { className: 'flex flex-wrap items-start gap-2' }, parts)]),
        ]),
      );
    }
    const details = this.el('details', { className: 'mt-4' }, [
      this.el('summary', { className: 'text-sm cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', text: this.t('outcome.summary') }),
      this.el('ul', { className: 'list-disc pl-6 mt-2 space-y-1 text-sm max-w-prose' }, ['outcome.strict', 'outcome.other', 'outcome.voice', 'outcome.unsure'].map((key) => this.el('li', { text: this.t(key) }))),
    ]);
    return this.el('div', { className: 'mt-6', attrs: { 'data-scope-gate-block': 'effect' } }, [
      this.heading('effect.heading'),
      this.el('p', { className: 'text-base font-semibold text-balance', text: this.t(view.headlineKey), attrs: { 'data-scope-gate-headline': '' } }),
      this.el('p', { className: 'text-sm text-base-content/70 max-w-prose mt-1', text: this.t('effect.explain') }),
      list,
      details,
    ]);
  }

  renderData(body) {
    const view = scopeGateDataView(body);
    const ui = this.ui();
    let control = null;
    if (view.rebuild.mode === 'button') {
      control = this.el('button', { className: 'btn btn-outline btn-sm', attrs: { type: 'button', 'data-scope-gate-rebuild': '' } }, [this.icon('arrow-clockwise'), this.el('span', { text: this.t('action.rebuild') })]);
      if (view.state === 'rebuilding' || this.busy) control.disabled = true;
      control.addEventListener('click', () => this.rebuild(control));
    } else if (view.rebuild.mode === 'cli') {
      control = this.el('div', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [
        this.sentence('rebuild.cli', { command: { code: view.rebuild.command } }, 'text-sm min-w-0 break-words'),
        this.copyButton(view.rebuild.command),
      ]);
    }
    const head = this.el('div', { className: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
      this.el('h4', { className: 'text-base font-semibold text-balance', text: this.t('data.heading') }),
      control,
    ]);
    const nodes = [head, this.el('p', { className: 'text-sm text-base-content/70 max-w-prose mb-4', text: this.t('data.description') })];
    if (view.empty) {
      nodes.push(this.emptyBlock('data.empty.title', this.el('p', { text: this.t('data.empty.body') })));
    } else {
      const tbody = this.el('tbody');
      for (const row of view.rows) {
        const updated = row.updatedAt
          ? this.el('td', { className: 'whitespace-nowrap' }, [this.time(row.updatedAt)])
          : this.el('td', {}, [this.el('span', { text: '—', attrs: { 'aria-hidden': 'true' } }), this.el('span', { className: 'sr-only', text: this.t('data.never') })]);
        tbody.appendChild(
          this.el('tr', { attrs: { 'data-scope-gate-kind': row.kind } }, [
            this.el('th', { className: 'font-normal', attrs: { scope: 'row' } }, [
              row.known ? this.doc.createTextNode(this.t('kind.' + row.kind)) : this.el('span', { className: 'font-mono text-xs break-all', text: row.kind, attrs: { translate: 'no' } }),
            ]),
            this.el('td', { className: 'text-right tabular-nums', text: ui.ragUiFormatNumber(row.points, this.locale) }),
            this.el('td', { className: 'text-right tabular-nums', text: row.chunks === null ? '—' : ui.ragUiFormatNumber(row.chunks, this.locale) }),
            updated,
          ]),
        );
      }
      const table = this.el('table', { className: 'table table-sm' }, [
        this.el('caption', { className: 'sr-only', text: this.t('data.caption') }),
        this.el('thead', {}, [this.el('tr', {}, [this.th('col.builtFrom'), this.th('col.points', 'text-right'), this.th('col.chunks', 'text-right'), this.th('col.updated')])]),
        tbody,
      ]);
      nodes.push(this.tableRegion(this.t('data.caption'), table));
    }
    return this.el('div', { className: 'mt-6', attrs: { 'data-scope-gate-block': 'data' } }, nodes);
  }

  renderExamples(body) {
    const view = scopeGateExamplesView(body);
    const ui = this.ui();
    this.examplesView = view;
    this.helpEl.textContent = this.t('examples.help', { max: ui.ragUiFormatNumber(view.maxChars, this.locale) });
    const nodes = [
      this.heading('examples.heading'),
      this.el('p', { className: 'text-sm text-base-content/70 max-w-prose', text: this.t('examples.description') }),
      this.el('p', {
        className: 'text-xs text-base-content/70 tabular-nums mt-1 mb-4',
        text: this.t('examples.count', { count: ui.ragUiFormatNumber(view.total, this.locale), max: ui.ragUiFormatNumber(view.limit, this.locale) }),
        attrs: { 'data-scope-gate-count': '' },
      }),
    ];
    if (view.full) {
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('examples.full', { max: ui.ragUiFormatNumber(view.limit, this.locale) })], className: 'mb-4' }));
    } else nodes.push(this.form);
    if (view.rows.length === 0) {
      nodes.push(this.emptyBlock('examples.empty.title', this.el('p', { text: this.t('examples.empty.body') })));
    } else {
      const tbody = this.el('tbody');
      view.rows.forEach((row, index) => {
        const textCell = this.el('th', { className: 'font-normal align-top', attrs: { scope: 'row' } }, [
          this.el('p', { className: 'break-words whitespace-pre-wrap max-w-prose', text: row.text, attrs: { dir: 'auto', translate: 'no' } }),
        ]);
        if (row.createdAt) textCell.appendChild(this.el('p', { className: 'text-xs text-base-content/70 mt-1 md:hidden' }, [this.time(row.createdAt)]));
        if (!row.inUse) {
          textCell.appendChild(
            this.el('div', { className: 'flex flex-wrap items-center gap-2 mt-1' }, [
              this.badge({ tone: 'warning', icon: 'exclamation-triangle', word: 'example.notInUse' }),
              this.el('span', { className: 'text-xs text-base-content/70', text: this.t('example.notInUseReason') }),
            ]),
          );
        }
        const addedBy =
          row.addedBy.kind === 'name'
            ? this.el('span', { className: 'break-words', text: row.addedBy.value })
            : row.addedBy.kind === 'id'
              ? this.el('span', { className: 'font-mono text-xs break-all', text: row.addedBy.value, attrs: { translate: 'no' } })
              : this.el('span', { text: '—' });
        const del = this.el('button', {
          className: 'btn btn-outline btn-error md:btn-sm whitespace-nowrap',
          text: this.t('action.delete'),
          attrs: { type: 'button', 'data-scope-gate-delete': String(index), 'aria-label': this.t('action.deleteAria', { text: Array.from(row.text).slice(0, SCOPE_GATE_DELETE_ARIA_CHARS).join('') }) },
        });
        del.addEventListener('click', () => this.deleteExample(row, index, del));
        tbody.appendChild(
          this.el('tr', { attrs: { 'data-scope-gate-example': row.id } }, [
            textCell,
            this.el('td', { className: 'hidden md:table-cell align-top whitespace-nowrap' }, row.createdAt ? [this.time(row.createdAt)] : [this.el('span', { text: '—' })]),
            this.el('td', { className: 'hidden lg:table-cell align-top' }, [addedBy]),
            this.el('td', { className: 'align-top' }, [del]),
          ]),
        );
      });
      const table = this.el('table', { className: 'table table-sm' }, [
        this.el('caption', { className: 'sr-only', text: this.t('examples.caption') }),
        this.el('thead', {}, [this.el('tr', {}, [this.th('col.example'), this.th('col.added', 'hidden md:table-cell'), this.th('col.addedBy', 'hidden lg:table-cell'), this.th('col.actions')])]),
        tbody,
      ]);
      nodes.push(this.el('div', { className: 'min-w-0' }, [table]));
    }
    return this.el('div', { className: 'mt-6', attrs: { 'data-scope-gate-block': 'examples' } }, nodes);
  }

  renderThresholds(body) {
    const view = scopeGateThresholdsView(body, this.locale);
    const ui = this.ui();
    const nodes = [
      this.heading('cells.heading'),
      this.el('p', { className: 'text-sm text-base-content/70 max-w-prose', text: this.t('cells.description') }),
      this.el('p', { className: 'text-xs text-base-content/70 max-w-prose mt-1 mb-4', text: this.t('cells.explain') }),
    ];
    if (view.empty) {
      nodes.push(
        this.emptyBlock(
          'cells.empty.title',
          this.el('div', { className: 'flex flex-col items-center gap-2' }, [
            this.sentence('cells.empty.body', { command: { code: view.command } }),
            view.command ? this.copyButton(view.command) : null,
          ]),
        ),
      );
    } else {
      const tbody = this.el('tbody');
      const n = (value) => (value === null ? null : this.el('p', { className: 'text-xs text-base-content/70', text: this.t('cell.n', { n: ui.ragUiFormatNumber(value, this.locale) }) }));
      for (const row of view.rows) {
        const profile = this.el('th', { className: 'font-normal align-top min-w-0', attrs: { scope: 'row' } }, [this.el('span', { className: 'font-mono text-xs break-all md:break-words md:[overflow-wrap:anywhere]', text: row.profileId, attrs: { translate: 'no' } })]);
        if (row.active) profile.appendChild(this.el('div', { className: 'mt-1' }, [this.badge({ tone: 'success', icon: 'check-circle', word: 'badge.inUse' })]));
        if (row.recordedAt) {
          const stacked = this.el('p', { className: 'max-lg:hidden xl:hidden text-xs text-base-content/70 mt-1', attrs: { 'data-scope-gate-recorded-stacked': '' } });
          const [before, after] = this.t('cell.recorded').split('{time}');
          stacked.append(this.doc.createTextNode(before || ''), this.time(row.recordedAt), this.doc.createTextNode(after || ''));
          profile.appendChild(stacked);
        }
        const mode = row.mode.label ? this.doc.createTextNode(this.t(row.mode.label)) : this.el('span', { className: 'font-mono text-xs break-all', text: row.mode.code, attrs: { translate: 'no' } });
        const status = this.el('div', { className: 'flex flex-wrap gap-1' }, [
          row.status.key
            ? this.badge(row.status.key === 'status.calibrated' ? { tone: 'success', icon: 'check-circle', word: row.status.key } : { tone: 'ghost', icon: 'dash-circle', word: row.status.key })
            : this.el('span', { className: 'font-mono text-xs break-all', text: row.status.code, attrs: { translate: 'no' } }),
          row.fixture ? this.badge(SCOPE_GATE_BADGES.evalOnly) : null,
        ]);
        const falseCell = this.el('td', { className: 'text-right tabular-nums align-top whitespace-nowrap' }, [
          this.el('p', { text: row.falseRate === null ? '—' : row.falseRate }),
          row.falseUpper === null ? null : this.el('p', { className: 'text-xs text-base-content/70', text: this.t('cell.upper', { value: row.falseUpper }) }),
          n(row.falseN),
        ]);
        tbody.appendChild(
          this.el('tr', { attrs: { 'data-scope-gate-threshold': '' } }, [
            profile,
            this.el('td', { className: 'align-top' }, [mode]),
            this.el('td', { className: 'align-top' }, [status]),
            this.el('td', { className: 'text-right tabular-nums align-top', text: row.threshold === null ? this.t('cell.none') : row.threshold }),
            this.el('td', { className: 'hidden md:table-cell text-right tabular-nums align-top', text: row.margin === null ? '—' : row.margin }),
            falseCell,
            this.el('td', { className: 'hidden lg:table-cell text-right tabular-nums align-top' }, [this.el('p', { text: row.correctRate === null ? '—' : row.correctRate }), n(row.correctN)]),
            this.el('td', { className: 'max-xl:hidden align-top whitespace-nowrap' }, row.recordedAt ? [this.time(row.recordedAt)] : [this.el('span', { text: '—' })]),
          ]),
        );
      }
      const table = this.el('table', { className: 'table table-sm' }, [
        this.el('caption', { className: 'sr-only', text: this.t('cells.caption') }),
        this.el('thead', {}, [
          this.el('tr', {}, [
            this.th('col.profile'),
            this.th('col.mode'),
            this.th('col.status'),
            this.th('col.threshold', 'text-right'),
            this.th('col.margin', 'hidden md:table-cell text-right'),
            this.th('col.falseRefusal', 'text-right'),
            this.th('col.correctRefusal', 'hidden lg:table-cell text-right'),
            this.th('col.recorded', 'max-xl:hidden'),
          ]),
        ]),
        tbody,
      ]);
      nodes.push(this.tableRegion(this.t('cells.caption'), table));
    }
    return this.el('div', { className: 'mt-6', attrs: { 'data-scope-gate-block': 'thresholds' } }, nodes);
  }

  setFieldError(key, vars) {
    this.fieldErrorKey = key;
    this.fieldErrorVars = vars || null;
    if (key) {
      this.errorEl.textContent = this.t(key, vars);
      this.textarea.setAttribute('aria-invalid', 'true');
      this.textarea.setAttribute('aria-describedby', this.helpId + ' ' + this.errorId);
      this.textarea.classList.add('textarea-error');
    } else {
      this.errorEl.textContent = '';
      this.textarea.removeAttribute('aria-invalid');
      this.textarea.setAttribute('aria-describedby', this.helpId);
      this.textarea.classList.remove('textarea-error');
    }
  }

  async addExample() {
    if (this.busy || !this.examplesView) return;
    const ui = this.ui();
    const text = scopeGateText(this.textarea.value);
    const max = this.examplesView.maxChars;
    const length = Array.from(text.trim()).length;
    if (length === 0) {
      this.setFieldError('error.exampleEmpty');
      this.textarea.focus();
      return;
    }
    if (length > max) {
      this.setFieldError('error.exampleTooLong', { max: ui.ragUiFormatNumber(max, this.locale), count: ui.ragUiFormatNumber(length, this.locale) });
      this.textarea.focus();
      return;
    }
    this.setFieldError(null);
    this.busy = true;
    const restore = ui.ragUiButtonBusy(this.doc, this.addButton, this.t('add.running'), this.actionButtons(this.addButton));
    let result;
    try {
      result = await this.request(SCOPE_GATE_API + '/examples' + this.query(), { method: 'POST', body: JSON.stringify({ text }) });
    } catch {
      result = { ok: false, thrown: true, status: 0, body: null };
    }
    restore();
    this.busy = false;
    if (result && result.ok) {
      this.textarea.value = '';
      await this.load('action');
      this.announce(this.t('add.done'));
      this.textarea.focus();
      return;
    }
    const mapped = scopeGateMapError(result, 'add');
    if (mapped.kind === 'field') {
      const vars = mapped.key === 'error.exampleTooLong' ? { max: ui.ragUiFormatNumber(max, this.locale), count: ui.ragUiFormatNumber(length, this.locale) } : undefined;
      this.setFieldError(mapped.key, vars);
      this.textarea.focus();
      return;
    }
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.loadFailed(result, Boolean(this.body));
      return;
    }
    if (mapped.kind === 'full' || mapped.kind === 'outcomeUnknown' || mapped.kind === 'changed') {
      await this.load('action');
      this.announce(this.message({ ...mapped, vars: { max: ui.ragUiFormatNumber(max, this.locale) } }), mapped.kind !== 'full');
      return;
    }
    if (mapped.kind === 'invalid') {
      this.setFieldError(mapped.key, mapped.vars);
      this.textarea.focus();
      return;
    }
    this.announce(this.message(mapped), true);
  }

  actionButtons(except) {
    const buttons = Array.from(this.blocks.querySelectorAll('button')).filter((b) => b !== except && b.hasAttribute('data-scope-gate-delete'));
    const rebuild = this.blocks.querySelector('[data-scope-gate-rebuild]');
    if (rebuild && rebuild !== except) buttons.push(rebuild);
    if (this.addButton !== except) buttons.push(this.addButton);
    return buttons;
  }

  async deleteExample(row, index, opener) {
    if (this.busy) return;
    const ui = this.ui();
    let result = null;
    const confirmed = await ui.ragUiConfirmDialog(this.doc, {
      title: this.t('delete.title'),
      body: [this.t('delete.body')],
      keepLabel: this.t('delete.keep'),
      confirmLabel: this.t('delete.confirm'),
      runningLabel: this.t('delete.running'),
      tone: 'error',
      opener,
      fallbackFocus: this.textarea,
      onConfirm: async () => {
        this.busy = true;
        try {
          result = await this.request(SCOPE_GATE_API + '/examples/' + encodeURIComponent(row.id) + this.query(), { method: 'DELETE' });
        } catch {
          result = { ok: false, thrown: true, status: 0, body: null };
        } finally {
          this.busy = false;
        }
      },
    });
    if (!confirmed) return;
    if (result && result.ok) {
      await this.load('action');
      this.announce(this.t('delete.done'));
      const next = this.blocks.querySelectorAll('[data-scope-gate-delete]')[index] || this.blocks.querySelectorAll('[data-scope-gate-delete]')[index - 1];
      (next || this.textarea).focus();
      return;
    }
    const mapped = scopeGateMapError(result, 'delete');
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.loadFailed(result, Boolean(this.body));
      return;
    }
    if (mapped.kind === 'outcomeUnknown' || mapped.kind === 'changed') await this.load('action');
    this.announce(this.message(mapped), true);
  }

  async rebuild(button) {
    if (this.busy) return;
    const ui = this.ui();
    this.busy = true;
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('rebuild.running'), this.actionButtons(button));
    let result;
    try {
      result = await this.request(SCOPE_GATE_API + '/rebuild' + this.query(), { method: 'POST' });
    } catch {
      result = { ok: false, thrown: true, status: 0, body: null };
    }
    restore();
    this.busy = false;
    if (result && result.ok && result.status === 202) {
      this.announce(this.t('rebuild.started'));
      await this.load('poll');
      this.startPoll();
      return;
    }
    if (result && result.ok) {
      const kinds = Array.isArray(result.body && result.body.kinds) ? result.body.kinds : [];
      const points = kinds.reduce((sum, k) => sum + (scopeGateNum(k && k.referencePoints) || 0), 0);
      await this.load('action');
      this.announce(this.t('rebuild.done', { points: ui.ragUiFormatNumber(points, this.locale) }));
      return;
    }
    const mapped = scopeGateMapError(result, 'rebuild');
    if (mapped.kind === 'started') {
      this.announce(this.t('rebuild.started'));
      await this.load('poll');
      this.startPoll();
      return;
    }
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.loadFailed(result, Boolean(this.body));
      return;
    }
    if (mapped.kind === 'unsupported' || mapped.kind === 'outcomeUnknown' || mapped.kind === 'changed') {
      await this.load('action');
      this.announce(this.message(mapped), mapped.kind !== 'unsupported');
      return;
    }
    this.announce(this.message(mapped), true);
  }

  /** The panel's only polling (UI-SPEC 6.3.3): every 15 seconds while the rebuild runs and the tab is visible, at most 20 times. */
  startPoll() {
    this.stopPoll();
    if (!this.body || scopeGateDataView(this.body).state !== 'rebuilding') return;
    this.poll = { count: 0, timer: null, waiting: false };
    this.schedulePoll();
  }

  schedulePoll() {
    const poll = this.poll;
    if (!poll) return;
    poll.timer = this.schedule(() => this.pollTick(poll), SCOPE_GATE_POLL_MS);
  }

  async pollTick(poll) {
    if (this.poll !== poll) return;
    poll.timer = null;
    if (this.doc.visibilityState === 'hidden') {
      poll.waiting = true;
      return;
    }
    poll.count += 1;
    const body = await this.load('poll');
    if (this.poll !== poll) return;
    if (!body) return;
    const data = scopeGateDataView(body);
    if (data.state !== 'rebuilding') {
      this.stopPoll();
      this.announce(this.t('rebuild.done', { points: this.ui().ragUiFormatNumber(data.totalPoints, this.locale) }));
      return;
    }
    if (poll.count >= SCOPE_GATE_POLL_MAX) {
      this.stopPoll();
      this.announce(this.t('rebuild.stillRunning'));
      return;
    }
    this.schedulePoll();
  }

  stopPoll() {
    if (this.poll && this.poll.timer !== null) this.cancel(this.poll.timer);
    this.poll = null;
  }
}

let SCOPE_GATE_PANEL_INSTANCE = null;

/** Idempotent: the first call mounts, later calls refresh and keep a typed example and a running poll. */
async function initScopeGatePanel(deps) {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('rag-administration-scope-gate');
  if (!root) return;
  if (!SCOPE_GATE_PANEL_INSTANCE) {
    SCOPE_GATE_PANEL_INSTANCE = new ScopeGatePanel(root, deps);
    if (typeof window !== 'undefined') window.scopeGatePanel = SCOPE_GATE_PANEL_INSTANCE;
  }
  await SCOPE_GATE_PANEL_INSTANCE.mount();
}

/** Selects the RAG administration tab, scrolls the Scope gate panel into view and focuses its heading. No request of its own. */
function openScopeGatePanel() {
  const link = document.querySelector('.menu-item[data-tab="rag-administration"]');
  if (link) link.click();
  const section = document.getElementById('rag-administration-scope-gate');
  if (!section) return;
  if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ behavior: scopeGateReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  const heading = document.getElementById('rag-scope-gate-title');
  if (heading) heading.focus({ preventScroll: true });
}

function bindScopeGatePanel() {
  const locale = scopeGateLocale(typeof navigator !== 'undefined' && navigator ? navigator.language : undefined);
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-scope-gate-bound')) return;
    link.setAttribute('data-scope-gate-bound', '1');
    link.addEventListener('click', () => initScopeGatePanel());
  });
  document.querySelectorAll('[data-scope-gate-pointer]').forEach((button) => {
    if (button.getAttribute('data-scope-gate-bound')) return;
    button.setAttribute('data-scope-gate-bound', '1');
    button.textContent = scopeGateLabel('pointer.open', locale);
    button.addEventListener('click', () => openScopeGatePanel());
  });
  document.querySelectorAll('[data-scope-gate-pointer-text]').forEach((el) => {
    el.textContent = scopeGateLabel('pointer.text', locale);
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initScopeGatePanel = initScopeGatePanel;
  window.openScopeGatePanel = openScopeGatePanel;
  bindScopeGatePanel();
  document.addEventListener('DOMContentLoaded', () => {
    bindScopeGatePanel();
    const tab = document.getElementById('rag-administration');
    if (tab && tab.classList.contains('active')) initScopeGatePanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCOPE_GATE_LABELS,
    scopeGateLabel,
    scopeGateReadinessView,
    scopeGateDataView,
    scopeGateExamplesView,
    scopeGateThresholdsView,
    scopeGateMapError,
    ScopeGatePanel,
    initScopeGatePanel,
  };
}
