/**
 * Rollouts panel (LANG-11 with LANG-10; 07-UI-SPEC 6.4, 7.4, 8.4, 12.4). Operator admins start a rollout of an embedding profile, a
 * chunking profile or a rebuild for a few workspaces, compare each language with the same workspaces before the rollout, include or
 * exclude workspaces, roll back or promote. Renders kinds, candidate ids, workspace keys, counts, rates and codes only: never a salt,
 * an actor id, a rollout id as text or any question or answer. DOM through the rag-ui helpers (createElement, textContent).
 */

const ROLLOUTS_UI =
  typeof ragUiEl === 'function'
    ? {
        ragUiEl,
        ragUiIcon,
        ragUiSpinner,
        ragUiAlert,
        ragUiLookup,
        ragUiSharedLabel,
        ragUiFormatNumber,
        ragUiCount,
        ragUiRagRequest,
        ragUiTemplateNodes,
        ragUiConfirmDialog,
        ragUiListLoading,
        ragUiListBusy,
        ragUiButtonBusy,
        ragUiBrowserLocale,
        ragUiNextId,
      }
    : require('./rag-ui.js');

const ROLLOUTS_PATH = '/api/rag/admin/rollouts';
const ROLLOUTS_LIST_TIMEOUT_MS = 15000;
const ROLLOUTS_CHANGE_TIMEOUT_MS = 60000;
const ROLLOUTS_START_TIMEOUT_MS = 30000;
const ROLLOUTS_DAY_MS = 86400000;
const ROLLOUTS_LIST_CAP = 20;
const ROLLOUTS_KINDS = ['embedding_profile', 'chunking_profile', 'rebuild_run'];
const ROLLOUTS_MEASURES = ['refusal_rate', 'not_helpful_rate', 'judge_score'];
const ROLLOUTS_TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ROLLOUTS_CANDIDATE = /^[A-Za-z0-9][A-Za-z0-9._:,-]{0,127}$/;
const ROLLOUTS_BACKENDS = { qdrant: 'Qdrant', weaviate: 'Weaviate' };

const ROLLOUTS_LABELS = {
  en: {
    "card.observation": "Observation period: {count} days",
    "panel.title": "Rollouts",
    "panel.description": "Give a new embedding profile, chunking profile or rebuild to a few workspaces first, compare each language with how the same workspaces did before, then promote it to everyone or roll it back. A rollback deletes nothing. Applies to every workspace.",
    "list.loading": "Loading rollouts…",
    "list.unavailable": "Rollouts are unavailable right now. Select Reload panel in a moment.",
    "action.reload": "Reload panel",
    "off.title": "Rollouts are switched off",
    "off.body": "An operator switches them on under RAG Modes, RAG pipeline settings ({variable}). While off, every workspace uses the active profiles.",
    "warn.legacy": "The pipeline is set to legacy, so rollouts are ignored and every workspace uses the active profiles. Rollouts need {variable} set to v2.",
    "empty.title": "No rollout in progress",
    "empty.body": "Start one to try a new profile or rebuild on a few workspaces before everyone gets it. The candidate must already be built.",
    "action.new": "New rollout",
    "action.closeForm": "Close form",
    "form.title": "Start a rollout",
    "form.kind": "What to roll out",
    "form.kindBusy": "A rollout of this kind is already in progress.",
    "kind.embedding_profile": "Embedding profile",
    "kind.chunking_profile": "Chunking profile",
    "kind.rebuild_run": "Rebuild",
    "form.candidate": "Candidate ID",
    "form.candidateHelp.embedding_profile": "The ID of a profile that is being backfilled, as listed under Embedding profiles.",
    "form.candidateHelp.chunking_profile": "The ID of a built profile, as listed under Chunking profiles.",
    "form.candidateHelp.rebuild_run": "The ID of a finished rebuild, as listed under Ingestion changes.",
    "form.mode": "Who gets it first",
    "mode.tenants": "Chosen workspaces",
    "mode.share": "A share of workspaces",
    "form.tenants": "Workspace keys",
    "form.tenantsHelp": "One key per line, in lower case: o: or u: followed by the ID, or s:default.",
    "form.share": "Share of workspaces (%)",
    "form.shareHelp": "A whole number from 1 to 100. Workspaces are picked by a fixed hash of their key, so a workspace stays on the same side for the whole rollout.",
    "form.candidateRequired": "Enter the candidate ID.",
    "form.tenantsRequired": "Enter at least one workspace key.",
    "form.tenantInvalid": "Line {line} is not a workspace key. Use lower case: o: or u: followed by the ID, or s:default.",
    "form.shareInvalid": "Enter a whole number from 1 to 100.",
    "action.start": "Start rollout",
    "start.running": "Starting…",
    "confirm.start.title": "Start this rollout?",
    "confirm.start.bodyTenants": "{candidate} starts answering for the workspaces you listed ({count}) within about 30 seconds. Every other workspace keeps the current one. You can roll it back at any time; nothing is deleted.",
    "confirm.start.bodyShare": "{candidate} starts answering for about {percent}% of workspaces within about 30 seconds. Every other workspace keeps the current one. You can roll it back at any time; nothing is deleted.",
    "confirm.start.keep": "Close without starting",
    "start.done": "Rollout started.",
    "start.exists": "Not started. A rollout of this kind is already in progress. Promote it or roll it back first.",
    "start.invalid": "Not started. The server did not accept this value: {detail}",
    "start.refused": "Not started. The server gave the reason {code}.",
    "card.heading": "{kind}: {candidate}",
    "card.mode.tenants": "Chosen workspaces",
    "card.mode.share": "Share of workspaces: {percent}%",
    "card.started": "Started: {date}",
    "card.days": "Days running: {count}",
    "card.incumbent": "Current for everyone else: {id}",
    "arm.candidate": "Workspaces on the candidate: {count}",
    "arm.incumbent": "Workspaces on the current one: {count}",
    "note.chunkingExternal": "While this rollout runs, candidate workspaces are searched in pgvector even when an external backend is selected.",
    "state.active": "Active",
    "state.promoted": "Promoted",
    "state.rolled_back": "Rolled back",
    "state.cancelled": "Cancelled",
    "compare.title": "Quality per language",
    "table.caption": "Quality per language: {candidate}",
    "table.help": "Each language is compared with the same workspaces over an equally long period before the rollout started. Other workspaces are shown so that a change affecting everyone is visible.",
    "col.language": "Language",
    "col.measure": "Measure",
    "col.candidate": "Candidate now",
    "col.before": "Same workspaces before",
    "col.others": "Other workspaces now",
    "col.result": "Result",
    "measure.refusal_rate": "“Information not available” answers",
    "measure.not_helpful_rate": "Not-helpful votes",
    "measure.judge_score": "Judge score",
    "cell.n": "n = {n}",
    "cell.none": "No data",
    "result.holds": "Holds",
    "result.worse": "Got worse",
    "result.insufficient": "Not enough data",
    "result.unmeasured": "Not measured",
    "ready.all": "Every language holds. Promotion also needs the observation period to be over.",
    "ready.blocked": "Not ready to promote: at least one language got worse or has too little data.",
    "ready.noData": "No per-language data yet. It appears once candidate workspaces have answered questions.",
    "lang.und": "Undetermined",
    "tenants.title": "Workspaces",
    "tenants.included": "Included: {count}",
    "tenants.excluded": "Excluded: {count}",
    "tenants.showAll": "Show all workspaces",
    "tenant.key": "Workspace key",
    "tenant.keyHelp": "Lower case: o: or u: followed by the ID, or s:default. Workspaces picked by the share are not listed; exclude one by its key.",
    "tenant.keyInvalid": "That is not a workspace key. Use lower case: o: or u: followed by the ID, or s:default.",
    "action.include": "Include workspace",
    "action.includeAria": "Include workspace: {tenant}",
    "action.exclude": "Exclude workspace",
    "action.excludeAria": "Exclude workspace: {tenant}",
    "confirm.include.title": "Include {tenant} in this rollout?",
    "confirm.include.body": "This workspace is answered by the candidate within about 30 seconds. You can exclude it again; nothing is deleted.",
    "confirm.exclude.title": "Exclude {tenant} from this rollout?",
    "confirm.exclude.body": "This workspace goes back to the current one within about 30 seconds and stays out of the rollout, even under a share. Nothing is deleted; you can include it again.",
    "confirm.tenant.keep": "Keep workspace as it is",
    "tenant.running": "Saving…",
    "include.done": "{tenant} is included.",
    "exclude.done": "{tenant} is excluded and back on the current one.",
    "action.rollback": "Roll back rollout",
    "confirm.rollback.title": "Roll back this rollout?",
    "confirm.rollback.body": "Every workspace on the candidate goes back to the current one within about 30 seconds, and the rollout ends. The candidate stays built and nothing is deleted. You can start a new rollout later.",
    "confirm.keepRunning": "Keep rollout running",
    "rollback.running": "Rolling back…",
    "rollback.done": "Rollout rolled back. Every workspace is on the current one.",
    "action.promote": "Promote rollout",
    "confirm.promote.title": "Promote {candidate} to every workspace?",
    "confirm.promote.body": "{candidate} becomes active for every workspace and the rollout ends. Four things are checked first: the observation period, enough data in every enabled language, no language worse than before, and the usual activation checks. If one fails, nothing changes.",
    "promote.running": "Promoting…",
    "promote.done": "Promoted. {candidate} is now active for every workspace.",
    "promote.refused.observation": "Not promoted. The rollout has not run long enough yet. Wait for the observation period to end, then promote again.",
    "promote.refused.insufficient": "Not promoted. {language} has too few questions on the candidate to judge. Include more workspaces, wait, then promote again.",
    "promote.refused.drop": "Not promoted. {language} got worse on this measure since the rollout started: {measure}. Roll back, or exclude the affected workspaces and look into the cause.",
    "promote.refused.external": "Not promoted. {backend} is not ready for the candidate on every workspace. Wait for sync to finish (RAG Modes, Vector backends), then promote again.",
    "promote.refused.other": "Not promoted. Activation was refused with the reason {code}. Nothing changed.",
    "recent.title": "Recent rollouts",
    "recent.col.kind": "What",
    "recent.col.candidate": "Candidate",
    "recent.col.state": "State",
    "recent.col.ended": "Ended",
    "error.changed": "This rollout has changed or ended. The list has been reloaded.",
    "error.outcomeUnknown": "No answer from the server. The rollout may or may not have changed; the list has been reloaded.",
  },
  zh: {
    "card.observation": "观察期：{count} 天",
    "panel.title": "灰度发布",
    "panel.description": "先让少数工作区使用新的 Embedding 配置、分块配置或重建结果，按语言与这些工作区之前的表现对比，然后全量启用或回滚。回滚不会删除任何内容。适用于所有工作区。",
    "list.loading": "正在加载灰度发布…",
    "list.unavailable": "灰度发布暂时不可用。请稍后选择“重新加载面板”。",
    "action.reload": "重新加载面板",
    "off.title": "灰度发布已关闭",
    "off.body": "由运维人员在 RAG Modes 的“RAG 流程设置”中开启（{variable}）。关闭时，所有工作区都使用当前生效的配置。",
    "warn.legacy": "流程设置为 legacy，因此灰度发布不生效，所有工作区都使用当前生效的配置。灰度发布需要把 {variable} 设为 v2。",
    "empty.title": "没有进行中的灰度发布",
    "empty.body": "开始一次灰度发布，先在少数工作区试用新的配置或重建结果，再推广到所有工作区。候选对象必须已经构建完成。",
    "action.new": "新建灰度发布",
    "action.closeForm": "关闭表单",
    "form.title": "开始灰度发布",
    "form.kind": "发布对象",
    "form.kindBusy": "这一类已有进行中的灰度发布。",
    "kind.embedding_profile": "Embedding 配置",
    "kind.chunking_profile": "分块配置",
    "kind.rebuild_run": "重建",
    "form.candidate": "候选 ID",
    "form.candidateHelp.embedding_profile": "正在回填的配置的 ID，见“Embedding 配置”面板中的列表。",
    "form.candidateHelp.chunking_profile": "已构建完成的配置的 ID，见“分块配置”面板中的列表。",
    "form.candidateHelp.rebuild_run": "已完成的重建的 ID，见“入库设置变更”面板中的列表。",
    "form.mode": "先让谁使用",
    "mode.tenants": "指定的工作区",
    "mode.share": "一定比例的工作区",
    "form.tenants": "工作区标识",
    "form.tenantsHelp": "每行一个标识，使用小写：o: 或 u: 后接 ID，或 s:default。",
    "form.share": "工作区比例（%）",
    "form.shareHelp": "1 到 100 的整数。工作区按其标识的固定哈希选出，因此在整个发布期间，同一个工作区始终在同一侧。",
    "form.candidateRequired": "请填写候选 ID。",
    "form.tenantsRequired": "请至少填写一个工作区标识。",
    "form.tenantInvalid": "第 {line} 行不是工作区标识。请使用小写：o: 或 u: 后接 ID，或 s:default。",
    "form.shareInvalid": "请填写 1 到 100 的整数。",
    "action.start": "开始灰度发布",
    "start.running": "正在开始…",
    "confirm.start.title": "要开始这次灰度发布吗？",
    "confirm.start.bodyTenants": "大约 30 秒内，{candidate} 会开始为你列出的工作区（{count} 个）提供回答。其他工作区保持现状。可以随时回滚，不会删除任何内容。",
    "confirm.start.bodyShare": "大约 30 秒内，{candidate} 会开始为约 {percent}% 的工作区提供回答。其他工作区保持现状。可以随时回滚，不会删除任何内容。",
    "confirm.start.keep": "不开始并关闭",
    "start.done": "灰度发布已开始。",
    "start.exists": "未开始。这一类已有进行中的灰度发布，请先全量启用或回滚。",
    "start.invalid": "未开始。服务器不接受这个值：{detail}",
    "start.refused": "未开始。服务器给出的原因是 {code}。",
    "card.heading": "{kind}：{candidate}",
    "card.mode.tenants": "指定的工作区",
    "card.mode.share": "工作区比例：{percent}%",
    "card.started": "开始日期：{date}",
    "card.days": "已运行天数：{count}",
    "card.incumbent": "其他工作区当前使用：{id}",
    "arm.candidate": "使用候选的工作区：{count}",
    "arm.incumbent": "保持现状的工作区：{count}",
    "note.chunkingExternal": "这次发布期间，即使选择了外部后端，使用候选的工作区也在 pgvector 中检索。",
    "state.active": "进行中",
    "state.promoted": "已全量启用",
    "state.rolled_back": "已回滚",
    "state.cancelled": "已取消",
    "compare.title": "各语言的质量",
    "table.caption": "各语言的质量：{candidate}",
    "table.help": "每种语言都与同一批工作区在发布开始之前等长时间段内的表现对比。同时列出其他工作区，便于看出影响所有工作区的变化。",
    "col.language": "语言",
    "col.measure": "指标",
    "col.candidate": "候选（当前）",
    "col.before": "同一批工作区（之前）",
    "col.others": "其他工作区（当前）",
    "col.result": "结论",
    "measure.refusal_rate": "“信息不可用”的回答",
    "measure.not_helpful_rate": "“没有帮助”的投票",
    "measure.judge_score": "评审得分",
    "cell.n": "n = {n}",
    "cell.none": "无数据",
    "result.holds": "保持",
    "result.worse": "变差",
    "result.insufficient": "数据不足",
    "result.unmeasured": "未测量",
    "ready.all": "所有语言都保持稳定。全量启用还需要观察期结束。",
    "ready.blocked": "尚不能全量启用：至少有一种语言变差或数据不足。",
    "ready.noData": "还没有按语言统计的数据。使用候选的工作区回答过问题后会显示。",
    "lang.und": "未确定",
    "tenants.title": "工作区",
    "tenants.included": "已加入：{count}",
    "tenants.excluded": "已排除：{count}",
    "tenants.showAll": "显示全部工作区",
    "tenant.key": "工作区标识",
    "tenant.keyHelp": "使用小写：o: 或 u: 后接 ID，或 s:default。按比例选中的工作区不会列出，可通过标识排除。",
    "tenant.keyInvalid": "这不是工作区标识。请使用小写：o: 或 u: 后接 ID，或 s:default。",
    "action.include": "加入工作区",
    "action.includeAria": "加入工作区：{tenant}",
    "action.exclude": "排除工作区",
    "action.excludeAria": "排除工作区：{tenant}",
    "confirm.include.title": "要把 {tenant} 加入这次灰度发布吗？",
    "confirm.include.body": "大约 30 秒内，这个工作区将由候选提供回答。之后可以再排除，不会删除任何内容。",
    "confirm.exclude.title": "要把 {tenant} 从这次灰度发布中排除吗？",
    "confirm.exclude.body": "大约 30 秒内，这个工作区会回到当前配置，并且不再参与这次发布（按比例发布时也是如此）。不会删除任何内容，之后可以重新加入。",
    "confirm.tenant.keep": "保持工作区现状",
    "tenant.running": "正在保存…",
    "include.done": "{tenant} 已加入。",
    "exclude.done": "{tenant} 已排除，并回到当前配置。",
    "action.rollback": "回滚灰度发布",
    "confirm.rollback.title": "要回滚这次灰度发布吗？",
    "confirm.rollback.body": "大约 30 秒内，所有使用候选的工作区都会回到当前配置，这次发布随之结束。候选仍然保留，不会删除任何内容。之后可以重新开始发布。",
    "confirm.keepRunning": "继续灰度发布",
    "rollback.running": "正在回滚…",
    "rollback.done": "灰度发布已回滚，所有工作区都在使用当前配置。",
    "action.promote": "全量启用",
    "confirm.promote.title": "要为所有工作区启用 {candidate} 吗？",
    "confirm.promote.body": "{candidate} 将对所有工作区生效，这次发布随之结束。启用前会检查四项：观察期、每种已启用语言的数据量、没有语言比之前变差，以及常规的启用检查。任何一项未通过，都不会有任何更改。",
    "promote.running": "正在全量启用…",
    "promote.done": "已全量启用。{candidate} 现在对所有工作区生效。",
    "promote.refused.observation": "未全量启用。这次发布运行的时间还不够。请等观察期结束后再启用。",
    "promote.refused.insufficient": "未全量启用。{language}在候选上的提问太少，无法判断。请加入更多工作区，等待一段时间后再启用。",
    "promote.refused.drop": "未全量启用。发布开始以来，{language}在这项指标上变差了：{measure}。请回滚，或排除受影响的工作区并查明原因。",
    "promote.refused.external": "未全量启用。{backend} 尚未在所有工作区为候选准备就绪。请等待同步完成（RAG Modes，向量后端），然后再启用。",
    "promote.refused.other": "未全量启用。启用被拒绝，原因是 {code}。没有任何更改。",
    "recent.title": "最近的灰度发布",
    "recent.col.kind": "发布对象",
    "recent.col.candidate": "候选",
    "recent.col.state": "状态",
    "recent.col.ended": "结束日期",
    "error.changed": "这次灰度发布已发生变化或已结束，列表已重新加载。",
    "error.outcomeUnknown": "服务器没有响应。灰度发布可能已更改，也可能没有；列表已重新加载。",
  },
  it: {
    "card.observation": "Periodo di osservazione: {count} giorni",
    "panel.title": "Rilasci graduali",
    "panel.description": "Dai prima a pochi spazi di lavoro un nuovo profilo di embedding, un profilo di chunking o una ricostruzione, confronta ogni lingua con l’andamento precedente degli stessi spazi, poi promuovilo per tutti o annullalo. L’annullamento non elimina nulla. Vale per tutti gli spazi di lavoro.",
    "list.loading": "Caricamento dei rilasci…",
    "list.unavailable": "I rilasci graduali non sono disponibili. Seleziona Ricarica pannello tra poco.",
    "action.reload": "Ricarica pannello",
    "off.title": "I rilasci graduali sono disattivati",
    "off.body": "Un operatore li attiva in RAG Modes, Impostazioni della pipeline RAG ({variable}). Finché sono disattivati, ogni spazio di lavoro usa i profili attivi.",
    "warn.legacy": "La pipeline è impostata su legacy, quindi i rilasci graduali vengono ignorati e ogni spazio di lavoro usa i profili attivi. I rilasci richiedono {variable} impostata su v2.",
    "empty.title": "Nessun rilascio in corso",
    "empty.body": "Avviane uno per provare un nuovo profilo o una ricostruzione su pochi spazi di lavoro prima che arrivi a tutti. Il candidato deve essere già costruito.",
    "action.new": "Nuovo rilascio",
    "action.closeForm": "Chiudi modulo",
    "form.title": "Avvia un rilascio",
    "form.kind": "Che cosa rilasciare",
    "form.kindBusy": "Un rilascio di questo tipo è già in corso.",
    "kind.embedding_profile": "Profilo di embedding",
    "kind.chunking_profile": "Profilo di chunking",
    "kind.rebuild_run": "Ricostruzione",
    "form.candidate": "ID del candidato",
    "form.candidateHelp.embedding_profile": "L’ID di un profilo in fase di riempimento, come elencato in Profili di embedding.",
    "form.candidateHelp.chunking_profile": "L’ID di un profilo costruito, come elencato in Profili di chunking.",
    "form.candidateHelp.rebuild_run": "L’ID di una ricostruzione terminata, come elencata in Modifiche all’ingestione.",
    "form.mode": "Chi lo riceve per primo",
    "mode.tenants": "Spazi di lavoro scelti",
    "mode.share": "Una quota di spazi di lavoro",
    "form.tenants": "Chiavi degli spazi di lavoro",
    "form.tenantsHelp": "Una chiave per riga, in minuscolo: o: oppure u: seguito dall’ID, oppure s:default.",
    "form.share": "Quota di spazi di lavoro (%)",
    "form.shareHelp": "Un numero intero da 1 a 100. Gli spazi di lavoro vengono scelti con un hash fisso della loro chiave, quindi uno spazio resta sullo stesso lato per tutto il rilascio.",
    "form.candidateRequired": "Inserisci l’ID del candidato.",
    "form.tenantsRequired": "Inserisci almeno una chiave di spazio di lavoro.",
    "form.tenantInvalid": "La riga {line} non è una chiave di spazio di lavoro. Usa il minuscolo: o: oppure u: seguito dall’ID, oppure s:default.",
    "form.shareInvalid": "Inserisci un numero intero da 1 a 100.",
    "action.start": "Avvia rilascio",
    "start.running": "Avvio…",
    "confirm.start.title": "Avviare questo rilascio?",
    "confirm.start.bodyTenants": "Entro circa 30 secondi {candidate} inizia a rispondere per gli spazi di lavoro che hai elencato ({count}). Tutti gli altri mantengono quello attuale. Puoi annullare in qualsiasi momento; non viene eliminato nulla.",
    "confirm.start.bodyShare": "Entro circa 30 secondi {candidate} inizia a rispondere per circa il {percent}% degli spazi di lavoro. Tutti gli altri mantengono quello attuale. Puoi annullare in qualsiasi momento; non viene eliminato nulla.",
    "confirm.start.keep": "Chiudi senza avviare",
    "start.done": "Rilascio avviato.",
    "start.exists": "Non avviato. Un rilascio di questo tipo è già in corso. Prima promuovilo o annullalo.",
    "start.invalid": "Non avviato. Il server non ha accettato questo valore: {detail}",
    "start.refused": "Non avviato. Il server ha indicato il motivo {code}.",
    "card.heading": "{kind}: {candidate}",
    "card.mode.tenants": "Spazi di lavoro scelti",
    "card.mode.share": "Quota di spazi di lavoro: {percent}%",
    "card.started": "Avviato: {date}",
    "card.days": "Giorni di attività: {count}",
    "card.incumbent": "Attuale per tutti gli altri: {id}",
    "arm.candidate": "Spazi di lavoro sul candidato: {count}",
    "arm.incumbent": "Spazi di lavoro su quello attuale: {count}",
    "note.chunkingExternal": "Durante questo rilascio, gli spazi di lavoro sul candidato vengono cercati in pgvector anche se è selezionato un backend esterno.",
    "state.active": "Attivo",
    "state.promoted": "Promosso",
    "state.rolled_back": "Annullato",
    "state.cancelled": "Cancellato",
    "compare.title": "Qualità per lingua",
    "table.caption": "Qualità per lingua: {candidate}",
    "table.help": "Ogni lingua viene confrontata con gli stessi spazi di lavoro in un periodo di pari durata prima dell’inizio del rilascio. Gli altri spazi sono mostrati per rendere visibile un cambiamento che riguarda tutti.",
    "col.language": "Lingua",
    "col.measure": "Misura",
    "col.candidate": "Candidato ora",
    "col.before": "Stessi spazi prima",
    "col.others": "Altri spazi ora",
    "col.result": "Esito",
    "measure.refusal_rate": "Risposte «informazione non disponibile»",
    "measure.not_helpful_rate": "Voti «non utile»",
    "measure.judge_score": "Punteggio del giudice",
    "cell.n": "n = {n}",
    "cell.none": "Nessun dato",
    "result.holds": "Stabile",
    "result.worse": "Peggiorata",
    "result.insufficient": "Dati insufficienti",
    "result.unmeasured": "Non misurata",
    "ready.all": "Ogni lingua è stabile. Per la promozione deve anche essere terminato il periodo di osservazione.",
    "ready.blocked": "Non pronto per la promozione: almeno una lingua è peggiorata o ha troppi pochi dati.",
    "ready.noData": "Nessun dato per lingua per ora. Compare dopo che gli spazi sul candidato hanno risposto a delle domande.",
    "lang.und": "Non determinata",
    "tenants.title": "Spazi di lavoro",
    "tenants.included": "Inclusi: {count}",
    "tenants.excluded": "Esclusi: {count}",
    "tenants.showAll": "Mostra tutti gli spazi di lavoro",
    "tenant.key": "Chiave dello spazio di lavoro",
    "tenant.keyHelp": "In minuscolo: o: oppure u: seguito dall’ID, oppure s:default. Gli spazi scelti dalla quota non sono elencati; escludine uno con la sua chiave.",
    "tenant.keyInvalid": "Non è una chiave di spazio di lavoro. Usa il minuscolo: o: oppure u: seguito dall’ID, oppure s:default.",
    "action.include": "Includi spazio di lavoro",
    "action.includeAria": "Includi spazio di lavoro: {tenant}",
    "action.exclude": "Escludi spazio di lavoro",
    "action.excludeAria": "Escludi spazio di lavoro: {tenant}",
    "confirm.include.title": "Includere {tenant} in questo rilascio?",
    "confirm.include.body": "Entro circa 30 secondi a questo spazio di lavoro risponde il candidato. Puoi escluderlo di nuovo; non viene eliminato nulla.",
    "confirm.exclude.title": "Escludere {tenant} da questo rilascio?",
    "confirm.exclude.body": "Entro circa 30 secondi questo spazio di lavoro torna a quello attuale e resta fuori dal rilascio, anche con una quota. Non viene eliminato nulla; puoi includerlo di nuovo.",
    "confirm.tenant.keep": "Lascia lo spazio di lavoro com’è",
    "tenant.running": "Salvataggio…",
    "include.done": "{tenant} è incluso.",
    "exclude.done": "{tenant} è escluso ed è tornato a quello attuale.",
    "action.rollback": "Annulla rilascio",
    "confirm.rollback.title": "Annullare questo rilascio?",
    "confirm.rollback.body": "Entro circa 30 secondi ogni spazio di lavoro sul candidato torna a quello attuale e il rilascio termina. Il candidato resta costruito e non viene eliminato nulla. Potrai avviare un nuovo rilascio in seguito.",
    "confirm.keepRunning": "Lascia il rilascio in corso",
    "rollback.running": "Annullamento…",
    "rollback.done": "Rilascio annullato. Ogni spazio di lavoro usa quello attuale.",
    "action.promote": "Promuovi rilascio",
    "confirm.promote.title": "Promuovere {candidate} per tutti gli spazi di lavoro?",
    "confirm.promote.body": "{candidate} diventa attivo per ogni spazio di lavoro e il rilascio termina. Prima vengono controllate quattro cose: il periodo di osservazione, dati sufficienti in ogni lingua abilitata, nessuna lingua peggiorata rispetto a prima e i consueti controlli di attivazione. Se uno fallisce, non cambia nulla.",
    "promote.running": "Promozione…",
    "promote.done": "Promosso. {candidate} è ora attivo per ogni spazio di lavoro.",
    "promote.refused.observation": "Non promosso. Il rilascio non è attivo da abbastanza tempo. Attendi la fine del periodo di osservazione, poi promuovi di nuovo.",
    "promote.refused.insufficient": "Non promosso. {language} ha troppe poche domande sul candidato per essere valutata. Includi altri spazi di lavoro, attendi, poi promuovi di nuovo.",
    "promote.refused.drop": "Non promosso. Dall’inizio del rilascio {language} è peggiorata su questa misura: {measure}. Annulla, oppure escludi gli spazi interessati e cerca la causa.",
    "promote.refused.external": "Non promosso. {backend} non è pronto per il candidato su ogni spazio di lavoro. Attendi la fine della sincronizzazione (RAG Modes, Backend vettoriali), poi promuovi di nuovo.",
    "promote.refused.other": "Non promosso. L’attivazione è stata rifiutata con il motivo {code}. Non è cambiato nulla.",
    "recent.title": "Rilasci recenti",
    "recent.col.kind": "Che cosa",
    "recent.col.candidate": "Candidato",
    "recent.col.state": "Stato",
    "recent.col.ended": "Terminato",
    "error.changed": "Questo rilascio è cambiato o è terminato. L’elenco è stato ricaricato.",
    "error.outcomeUnknown": "Nessuna risposta dal server. Il rilascio potrebbe essere cambiato oppure no; l’elenco è stato ricaricato.",
  },
};

function rolloutsLabel(key, locale, vars) {
  const own = ROLLOUTS_UI.ragUiLookup(ROLLOUTS_LABELS, key, locale, vars);
  return own === undefined ? ROLLOUTS_UI.ragUiSharedLabel(key, locale, vars) : own;
}

function rolloutsFill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match));
}

function rolloutsTenantKeyValid(value) {
  return typeof value === 'string' && ROLLOUTS_TENANT_KEY.test(value);
}

function rolloutsLanguageName(code, locale) {
  if (code === 'und') return rolloutsLabel('lang.und', locale);
  try {
    if (typeof Intl.DisplayNames === 'function') {
      const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code);
      if (name && name !== code) return name;
    }
  } catch {
    // unknown code: shown as the code
  }
  return code;
}

function rolloutsMeasureLabel(measure, locale) {
  return ROLLOUTS_MEASURES.includes(measure) ? rolloutsLabel('measure.' + measure, locale) : null;
}

function rolloutsDate(value, locale) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** A rate as a percentage with one decimal, a judge score with two decimals; null for a cell without data. */
function rolloutsFormatValue(measure, value, locale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  try {
    if (measure === 'judge_score') return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    return new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
  } catch {
    return measure === 'judge_score' ? value.toFixed(2) : (value * 100).toFixed(1) + '%';
  }
}

/** Whole days since the start, computed in the browser. */
function rolloutsDaysRunning(createdAt, now) {
  const ms = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((now - ms) / ROLLOUTS_DAY_MS));
}

/** The ready line of a card: all (every listed language holds), blocked (worse or too little data) or noData (no row). */
function rolloutsReadiness(languages) {
  const rows = (Array.isArray(languages) ? languages : []).flatMap((entry) => (entry && Array.isArray(entry.measures) ? entry.measures : []));
  if (rows.length === 0) return 'noData';
  return rows.some((row) => row && (row.verdict === 'worse' || row.verdict === 'insufficient')) ? 'blocked' : 'all';
}

/**
 * Validates the New rollout form. Returns { ok, errors: { field: message }, payload } with the workspace keys lower-cased; the first
 * invalid field comes first in errors.
 */
function rolloutsValidateForm(form, locale, activeKinds) {
  const errors = {};
  const kind = ROLLOUTS_KINDS.includes(form.kind) ? form.kind : null;
  if (!kind || (activeKinds && activeKinds.includes(kind))) errors.kind = rolloutsLabel('form.kindBusy', locale);
  const candidate = String(form.candidate || '').trim();
  if (!candidate) errors.candidate = rolloutsLabel('form.candidateRequired', locale);
  else if (!ROLLOUTS_CANDIDATE.test(candidate)) errors.candidate = rolloutsLabel('start.invalid', locale, { detail: candidate.slice(0, 40) });
  const mode = form.mode === 'share' ? 'share' : 'tenants';
  let tenants = null;
  let share = null;
  if (mode === 'tenants') {
    const lines = String(form.tenants || '')
      .split('\n')
      .map((line) => line.trim().toLowerCase());
    const filled = lines.map((line, index) => ({ line, index })).filter((entry) => entry.line);
    if (filled.length === 0) errors.tenants = rolloutsLabel('form.tenantsRequired', locale);
    else {
      const bad = filled.find((entry) => !rolloutsTenantKeyValid(entry.line));
      if (bad) errors.tenants = rolloutsLabel('form.tenantInvalid', locale, { line: bad.index + 1 });
      else tenants = [...new Set(filled.map((entry) => entry.line))];
    }
  } else {
    const raw = String(form.share ?? '').trim();
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1 || n > 100) errors.share = rolloutsLabel('form.shareInvalid', locale);
    else share = n;
  }
  const ok = Object.keys(errors).length === 0;
  const payload = ok
    ? {
        action: 'start',
        kind,
        candidate: kind === 'chunking_profile' ? candidate.split(',').map((id) => id.trim()).filter(Boolean) : candidate,
        mode,
        ...(mode === 'tenants' ? { tenants } : { share }),
      }
    : null;
  return { ok, errors, payload };
}

/** The sentence for a promote refusal code (8.4): the part after a colon is shown by its name. */
function rolloutsRefusal(code, locale) {
  const value = typeof code === 'string' ? code : '';
  if (value === 'rollout_observation_too_short') return { text: rolloutsLabel('promote.refused.observation', locale), codeVars: [] };
  let match = /^rollout_monitoring_insufficient:([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)$/.exec(value);
  if (match) return { text: rolloutsLabel('promote.refused.insufficient', locale, { language: rolloutsLanguageName(match[1], locale) }), codeVars: [] };
  match = /^rollout_language_drop:([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?):([a-z_]+)$/.exec(value);
  if (match) {
    const measure = rolloutsMeasureLabel(match[2], locale);
    return {
      template: rolloutsLabel('promote.refused.drop', locale),
      vars: { language: rolloutsLanguageName(match[1], locale), measure: measure || match[2] },
      codeVars: measure ? [] : ['measure'],
    };
  }
  match = /^external_not_ready:([a-z]+)$/.exec(value);
  if (match) {
    const brand = ROLLOUTS_BACKENDS[match[1]];
    return { template: rolloutsLabel('promote.refused.external', locale), vars: { backend: brand || match[1] }, codeVars: brand ? [] : ['backend'] };
  }
  return { template: rolloutsLabel('promote.refused.other', locale), vars: { code: value || '?' }, codeVars: ['code'] };
}

class RolloutsPanel {
  constructor(root, deps) {
    const options = deps || {};
    this.root = root;
    this.doc = options.doc || (typeof document !== 'undefined' ? document : null);
    this.locale = options.locale || ROLLOUTS_UI.ragUiBrowserLocale();
    this.request = options.request || ((path, init, timeoutMs) => ROLLOUTS_UI.ragUiRagRequest(path, init, timeoutMs));
    this.config = options.config || (() => (typeof window !== 'undefined' && window.currentConfig ? window.currentConfig : {}));
    this.now = options.now || (() => Date.now());
    this.data = null;
    this.notice = null;
    this.refusals = {};
    this.keyErrors = {};
    this.showAll = {};
    this.keyValues = {};
    this.formOpen = false;
    this.form = { kind: 'embedding_profile', candidate: '', mode: 'tenants', tenants: '', share: '' };
    this.formErrors = {};
    this.formRefusal = null;
    this.mounted = false;
  }

  el(tag, options, children) {
    return ROLLOUTS_UI.ragUiEl(this.doc, tag, options, children);
  }

  t(key, vars) {
    return rolloutsLabel(key, this.locale, vars);
  }

  nodes(template, vars, codeVars) {
    return ROLLOUTS_UI.ragUiTemplateNodes(this.doc, template, vars, codeVars);
  }

  part(name) {
    return this.root ? this.root.querySelector('[data-rollouts-' + name + ']') : null;
  }

  announce(text, tone) {
    const status = this.part('status');
    if (!status) return;
    status.className = 'text-sm mt-4' + (tone === 'error' ? ' text-error' : '');
    const children = tone === 'error' ? [ROLLOUTS_UI.ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text })] : [this.el('span', { text })];
    status.replaceChildren(...children);
  }

  async mount() {
    if (this.mounted) return this.load();
    this.mounted = true;
    if (this.root && typeof this.root.setAttribute === 'function') this.root.setAttribute('lang', this.locale);
    const title = this.part('title');
    if (title) title.textContent = this.t('panel.title');
    const description = this.part('description');
    if (description) description.textContent = this.t('panel.description');
    const content = this.part('content');
    if (content) {
      content.addEventListener('change', (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      });
    }
    ROLLOUTS_UI.ragUiListLoading(this.doc, content, this.t('list.loading'));
    return this.load();
  }

  refresh() {
    return this.load();
  }

  async load() {
    const content = this.part('content');
    if (this.data) ROLLOUTS_UI.ragUiListBusy(content, true);
    const result = await this.request(ROLLOUTS_PATH, { method: 'GET' }, ROLLOUTS_LIST_TIMEOUT_MS);
    ROLLOUTS_UI.ragUiListBusy(content, false);
    if (result && !result.thrown && result.status === 404) {
      this.data = null;
      this.notice = { kind: 'off' };
    } else if (result && !result.thrown && (result.status === 401 || result.status === 403)) {
      this.data = null;
      this.notice = { kind: 'signIn' };
    } else if (!result || result.thrown || !result.ok || !result.body || typeof result.body !== 'object') {
      this.notice = { kind: 'unavailable' };
    } else {
      this.data = {
        active: Array.isArray(result.body.active) ? result.body.active.filter((entry) => entry && typeof entry.id === 'string' && ROLLOUTS_KINDS.includes(entry.kind)) : [],
        ended: Array.isArray(result.body.ended) ? result.body.ended.filter((entry) => entry && typeof entry.id === 'string') : [],
        policy: result.body.policy && typeof result.body.policy === 'object' ? result.body.policy : {},
      };
      if (this.notice && (this.notice.kind === 'unavailable' || this.notice.kind === 'off' || this.notice.kind === 'signIn')) this.notice = null;
      const ids = new Set(this.data.active.map((entry) => entry.id));
      for (const id of Object.keys(this.refusals)) if (!ids.has(id)) delete this.refusals[id];
    }
    this.render();
  }

  reloadButton() {
    const button = this.el('button', { className: 'btn btn-outline md:btn-sm', text: this.t('action.reload'), attrs: { type: 'button' } });
    button.addEventListener('click', () => {
      this.notice = null;
      this.load();
    });
    return button;
  }

  renderAlerts() {
    const host = this.part('alert');
    if (!host) return;
    const nodes = [];
    const notice = this.notice;
    if (notice && notice.kind === 'off') {
      nodes.push(
        ROLLOUTS_UI.ragUiAlert(this.doc, {
          tone: 'info',
          icon: 'toggle-off',
          title: this.t('off.title'),
          body: [this.el('p', { className: 'text-sm' }, this.nodes(this.t('off.body'), { variable: 'RAG_ROLLOUTS' }, ['variable']))],
        }),
      );
    } else if (notice && notice.kind === 'signIn') {
      nodes.push(ROLLOUTS_UI.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [ROLLOUTS_UI.ragUiSharedLabel('error.signIn', this.locale)], actions: [this.reloadButton()] }));
    } else if (notice && notice.kind === 'unavailable') {
      nodes.push(ROLLOUTS_UI.ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', body: [this.t('list.unavailable')], actions: [this.reloadButton()] }));
    } else if (notice && notice.kind === 'message') {
      nodes.push(ROLLOUTS_UI.ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', body: [notice.text], role: 'alert' }));
    }
    if (this.data && String((this.config() || {}).RAG_PIPELINE ?? '').trim().toLowerCase() === 'legacy') {
      nodes.push(
        ROLLOUTS_UI.ragUiAlert(this.doc, {
          tone: 'warning',
          icon: 'exclamation-triangle',
          body: [this.el('p', { className: 'text-sm' }, this.nodes(this.t('warn.legacy'), { variable: 'RAG_PIPELINE' }, ['variable']))],
        }),
      );
    }
    host.className = 'mb-4 empty:mb-0 grid gap-2';
    host.replaceChildren(...nodes);
  }

  render() {
    this.renderAlerts();
    const content = this.part('content');
    if (!content) return;
    if (!this.data) {
      content.replaceChildren();
      return;
    }
    const children = [this.renderFormToggle()];
    if (this.formOpen) children.push(this.renderForm());
    const order = (entry) => ROLLOUTS_KINDS.indexOf(entry.kind);
    const active = [...this.data.active].sort((a, b) => order(a) - order(b));
    if (active.length === 0 && this.data.ended.length === 0) {
      children.push(
        this.el('div', { className: 'py-8 text-center', attrs: { 'data-rollouts-empty': '' } }, [
          this.el('h4', { className: 'text-base font-semibold', text: this.t('empty.title') }),
          this.el('p', { className: 'text-sm text-base-content/70 max-w-prose mx-auto mt-2', text: this.t('empty.body') }),
        ]),
      );
    }
    for (const entry of active) children.push(this.renderCard(entry));
    if (this.data.ended.length > 0) children.push(this.renderRecent());
    content.replaceChildren(this.el('div', { className: 'grid gap-6' }, children));
  }

  renderFormToggle() {
    const button = this.el('button', {
      className: 'btn btn-outline md:btn-sm',
      text: this.formOpen ? this.t('action.closeForm') : this.t('action.new'),
      id: 'rollouts-form-toggle',
      attrs: { type: 'button', 'aria-expanded': this.formOpen ? 'true' : 'false', 'aria-controls': 'rollouts-form', 'data-rollouts-new': '' },
    });
    button.addEventListener('click', () => {
      this.formOpen = !this.formOpen;
      const busy = this.activeKinds();
      if (this.formOpen && busy.includes(this.form.kind)) this.form.kind = ROLLOUTS_KINDS.find((kind) => !busy.includes(kind)) || this.form.kind;
      this.formErrors = {};
      this.formRefusal = null;
      this.render();
      const target = this.doc.getElementById(this.formOpen ? 'rollouts-form-kind' : 'rollouts-form-toggle');
      if (target && typeof target.focus === 'function') target.focus();
    });
    return this.el('div', { className: 'flex flex-wrap gap-2' }, [button]);
  }

  field(id, label, control, help, error) {
    const helpId = id + '-help';
    const errorId = id + '-error';
    const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ');
    if (describedBy) control.setAttribute('aria-describedby', describedBy);
    if (error) {
      control.setAttribute('aria-invalid', 'true');
      const cls = String(control.className || '');
      const tint = /\btextarea\b/.test(cls) ? 'textarea-error' : /\bselect\b/.test(cls) ? 'select-error' : /\binput\b/.test(cls) ? 'input-error' : '';
      if (tint && !cls.includes(tint)) control.className = cls + ' ' + tint;
    }
    return this.el('div', { className: 'grid gap-1 min-w-0' }, [
      this.el('label', { className: 'text-sm font-semibold', text: label, attrs: { for: id } }),
      control,
      help ? this.el('p', { className: 'text-xs text-base-content/70', id: helpId, text: help }) : null,
      error ? this.errorLine(errorId, error) : null,
    ]);
  }

  errorLine(id, text) {
    return this.el('p', { className: 'text-sm text-error font-semibold flex items-start gap-1', id }, [
      ROLLOUTS_UI.ragUiIcon(this.doc, 'exclamation-circle', 'mt-0.5 shrink-0'),
      this.el('span', { text }),
    ]);
  }

  activeKinds() {
    return this.data ? this.data.active.map((entry) => entry.kind) : [];
  }

  renderForm() {
    const busy = this.activeKinds();
    const errors = this.formErrors;
    const kind = this.el('select', { className: 'select select-bordered w-full md:select-sm', id: 'rollouts-form-kind', attrs: { name: 'rollouts-form-kind', autocomplete: 'off' } });
    for (const value of ROLLOUTS_KINDS) {
      kind.appendChild(this.el('option', { text: this.t('kind.' + value), attrs: { value, disabled: busy.includes(value) ? true : null, selected: value === this.form.kind ? true : null } }));
    }
    kind.value = this.form.kind;
    kind.addEventListener('change', () => {
      this.form.kind = kind.value;
      this.render();
      const again = this.doc.getElementById('rollouts-form-kind');
      if (again) again.focus();
    });
    const kindHelp = busy.includes(this.form.kind) ? this.t('form.kindBusy') : null;

    const candidate = this.el('input', {
      className: 'input input-bordered w-full md:input-sm font-mono',
      id: 'rollouts-form-candidate',
      attrs: { type: 'text', name: 'rollouts-form-candidate', maxlength: '128', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', translate: 'no', value: this.form.candidate },
    });
    candidate.value = this.form.candidate;
    candidate.addEventListener('input', () => {
      this.form.candidate = candidate.value;
    });

    const legendId = 'rollouts-form-mode-legend';
    const radio = (value) => {
      const input = this.el('input', {
        className: 'radio radio-sm',
        id: 'rollouts-form-mode-' + value,
        attrs: { type: 'radio', name: 'rollouts-form-mode', value, checked: this.form.mode === value ? true : null },
      });
      input.checked = this.form.mode === value;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.form.mode = value;
        this.render();
        const again = this.doc.getElementById('rollouts-form-mode-' + value);
        if (again) again.focus();
      });
      return this.el('label', { className: 'flex items-center gap-2 text-sm cursor-pointer', attrs: { for: 'rollouts-form-mode-' + value } }, [input, this.el('span', { text: this.t('mode.' + value) })]);
    };
    const mode = this.el('fieldset', { className: 'grid gap-2 min-w-0', attrs: { 'aria-labelledby': legendId } }, [
      this.el('legend', { className: 'text-sm font-semibold mb-1', id: legendId, text: this.t('form.mode') }),
      radio('tenants'),
      radio('share'),
    ]);

    let target;
    if (this.form.mode === 'tenants') {
      const tenants = this.el('textarea', {
        className: 'textarea textarea-bordered textarea-sm w-full font-mono',
        id: 'rollouts-form-tenants',
        attrs: { name: 'rollouts-form-tenants', rows: '3', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', translate: 'no' },
      });
      tenants.value = this.form.tenants;
      tenants.addEventListener('input', () => {
        this.form.tenants = tenants.value;
      });
      tenants.addEventListener('change', () => {
        tenants.value = tenants.value.toLowerCase();
        this.form.tenants = tenants.value;
      });
      target = this.field('rollouts-form-tenants', this.t('form.tenants'), tenants, this.t('form.tenantsHelp'), errors.tenants);
    } else {
      const share = this.el('input', {
        className: 'input input-bordered w-full md:input-sm tabular-nums',
        id: 'rollouts-form-share',
        attrs: { type: 'number', name: 'rollouts-form-share', min: '1', max: '100', step: '1', inputmode: 'numeric', autocomplete: 'off', value: this.form.share },
      });
      share.value = this.form.share;
      share.addEventListener('input', () => {
        this.form.share = share.value;
      });
      target = this.field('rollouts-form-share', this.t('form.share'), share, this.t('form.shareHelp'), errors.share);
    }

    const start = this.el('button', { className: 'btn btn-primary md:btn-sm', text: this.t('action.start'), attrs: { type: 'button', 'data-rollouts-start': '' } });
    start.addEventListener('click', () => this.submitForm(start));
    const refusal = this.formRefusal
      ? this.el('p', { className: 'text-sm text-error', attrs: { role: 'alert', 'data-rollouts-form-refusal': '' } }, this.formRefusal)
      : null;

    return this.el('section', { className: 'border-l-4 border-base-300 rounded-lg p-4 grid gap-4 max-w-md min-w-0', id: 'rollouts-form', attrs: { 'aria-labelledby': 'rollouts-form-title' } }, [
      this.el('h4', { className: 'text-base font-semibold', id: 'rollouts-form-title', text: this.t('form.title') }),
      this.field('rollouts-form-kind', this.t('form.kind'), kind, kindHelp, errors.kind),
      this.field('rollouts-form-candidate', this.t('form.candidate'), candidate, this.t('form.candidateHelp.' + this.form.kind), errors.candidate),
      mode,
      target,
      refusal,
      this.el('div', { className: 'flex flex-wrap gap-2' }, [start]),
    ]);
  }

  async submitForm(opener) {
    const checked = rolloutsValidateForm(this.form, this.locale, this.activeKinds());
    this.formErrors = checked.errors;
    this.formRefusal = null;
    if (!checked.ok) {
      this.render();
      const first = ['kind', 'candidate', 'tenants', 'share'].find((name) => checked.errors[name]);
      const target = first ? this.doc.getElementById('rollouts-form-' + first) : null;
      if (target && typeof target.focus === 'function') target.focus();
      return;
    }
    if (checked.payload.mode === 'tenants') this.form.tenants = checked.payload.tenants.join('\n');
    const candidateText = Array.isArray(checked.payload.candidate) ? checked.payload.candidate.join(', ') : checked.payload.candidate;
    const body =
      checked.payload.mode === 'tenants'
        ? this.t('confirm.start.bodyTenants', { count: ROLLOUTS_UI.ragUiFormatNumber(checked.payload.tenants.length, this.locale) })
        : this.t('confirm.start.bodyShare', { percent: ROLLOUTS_UI.ragUiFormatNumber(checked.payload.share, this.locale) });
    await ROLLOUTS_UI.ragUiConfirmDialog(this.doc, {
      title: this.t('confirm.start.title'),
      body: [this.el('p', {}, this.nodes(body, { candidate: candidateText }, ['candidate']))],
      keepLabel: this.t('confirm.start.keep'),
      confirmLabel: this.t('action.start'),
      runningLabel: this.t('start.running'),
      opener,
      fallbackFocus: this.part('status'),
      onConfirm: () => this.start(checked.payload),
    });
  }

  async start(payload) {
    const result = await this.request(ROLLOUTS_PATH, { method: 'POST', body: JSON.stringify(payload) }, ROLLOUTS_START_TIMEOUT_MS);
    if (!result || result.thrown) {
      this.notice = { kind: 'message', text: this.t('error.outcomeUnknown') };
      await this.load();
      return { keepOpen: false };
    }
    if (result.status === 201) {
      this.formOpen = false;
      this.form = { kind: 'embedding_profile', candidate: '', mode: 'tenants', tenants: '', share: '' };
      this.formErrors = {};
      await this.load();
      this.announce(this.t('start.done'));
      return { keepOpen: false };
    }
    const body = result.body && typeof result.body === 'object' ? result.body : {};
    if (result.status === 401 || result.status === 403) {
      this.notice = { kind: 'signIn' };
      this.data = null;
      this.render();
      return { keepOpen: false };
    }
    if (result.status === 400) {
      const detail = Array.isArray(body.details) && body.details[0] && typeof body.details[0] === 'object' ? body.details[0] : null;
      const path = detail && typeof detail.path === 'string' ? detail.path.split('.')[0] : '';
      if (path === 'tenants' || path === 'tenant') this.formErrors = { tenants: this.t('tenant.keyInvalid') };
      else if (['kind', 'candidate', 'share'].includes(path)) this.formErrors = { [path]: this.t('start.invalid', { detail: String(detail.message || '') }) };
      else this.formRefusal = [this.t('start.invalid', { detail: detail && detail.message ? String(detail.message) : '' })];
    } else if (result.status === 409 && body.code === 'active_exists') {
      this.formRefusal = [this.t('start.exists')];
    } else if (result.status === 409 || result.status === 400) {
      this.formRefusal = this.nodes(this.t('start.refused'), { code: String(body.code || body.error || '?') }, ['code']);
    } else if (result.status === 503) {
      this.formRefusal = [this.t('list.unavailable')];
    } else {
      this.formRefusal = [ROLLOUTS_UI.ragUiSharedLabel('error.generic', this.locale, { status: result.status || '?' })];
    }
    this.render();
    return { keepOpen: false };
  }

  badge(tone, icon, word, wrap) {
    const shape = wrap ? ' h-auto min-h-5 whitespace-normal text-left' : ' shrink-0 whitespace-nowrap';
    return this.el('span', { className: 'badge badge-sm badge-outline badge-' + tone + ' gap-1' + shape }, [ROLLOUTS_UI.ragUiIcon(this.doc, icon), this.el('span', { text: word })]);
  }

  stateBadge(state) {
    if (state === 'active') return this.badge('info', 'play-circle', this.t('state.active'));
    if (state === 'promoted') return this.badge('success', 'check-circle', this.t('state.promoted'));
    if (state === 'rolled_back') return this.badge('ghost', 'arrow-counterclockwise', this.t('state.rolled_back'));
    if (state === 'cancelled') return this.badge('ghost', 'x-circle', this.t('state.cancelled'));
    return this.el('span', { className: 'badge badge-sm badge-outline badge-ghost font-mono', text: String(state), attrs: { translate: 'no' } });
  }

  verdictBadge(verdict, wrap) {
    if (verdict === 'holds') return this.badge('success', 'check-circle', this.t('result.holds'), wrap);
    if (verdict === 'worse') return this.badge('error', 'arrow-down-circle', this.t('result.worse'), wrap);
    if (verdict === 'insufficient') return this.badge('warning', 'hourglass-split', this.t('result.insufficient'), wrap);
    if (verdict === 'unmeasured') return this.badge('ghost', 'dash-circle', this.t('result.unmeasured'), wrap);
    return this.el('span', { className: 'badge badge-sm badge-outline badge-ghost font-mono', text: String(verdict), attrs: { translate: 'no' } });
  }

  kindLabel(kind) {
    return ROLLOUTS_KINDS.includes(kind) ? this.t('kind.' + kind) : String(kind);
  }

  candidateText(entry) {
    return Array.isArray(entry.candidate) ? entry.candidate.filter((id) => typeof id === 'string').join(', ') : '';
  }

  valueCell(measure, value, className, extra) {
    const n = value && Number.isInteger(value.n) ? value.n : 0;
    const formatted = value ? rolloutsFormatValue(measure, value.value, this.locale) : null;
    if (formatted === null) return this.el('td', { className: 'text-right tabular-nums ' + (className || '') }, [this.el('span', { className: 'block', text: this.t('cell.none') }), extra || null]);
    return this.el('td', { className: 'text-right tabular-nums ' + (className || '') }, [
      this.el('span', { className: 'block', text: formatted }),
      this.el('span', { className: 'block text-xs text-base-content/70', text: this.t('cell.n', { n: ROLLOUTS_UI.ragUiFormatNumber(n, this.locale) }) }),
      extra || null,
    ]);
  }

  renderComparison(entry) {
    const readiness = rolloutsReadiness(entry.languages);
    const readyIcon = readiness === 'all' ? 'check-circle' : readiness === 'blocked' ? 'exclamation-triangle' : 'info-circle';
    const children = [
      this.el('h5', { className: 'text-sm font-semibold', text: this.t('compare.title') }),
      this.el('p', { className: 'text-sm flex items-start gap-2 max-w-prose', attrs: { 'data-rollouts-ready': readiness } }, [
        ROLLOUTS_UI.ragUiIcon(this.doc, readyIcon, 'mt-0.5'),
        this.el('span', { text: this.t('ready.' + readiness) }),
      ]),
    ];
    if (readiness === 'noData') return this.el('div', { className: 'grid gap-2 min-w-0' }, children);
    const caption = this.t('table.caption', { candidate: this.candidateText(entry) });
    const th = (text, className) => this.el('th', { className, text, attrs: { scope: 'col' } });
    const head = this.el('thead', {}, [
      this.el('tr', {}, [
        th(this.t('col.language'), ''),
        th(this.t('col.measure'), 'hidden md:table-cell'),
        th(this.t('col.candidate'), 'text-right'),
        th(this.t('col.before'), 'text-right hidden md:table-cell'),
        th(this.t('col.others'), 'text-right hidden lg:table-cell'),
        th(this.t('col.result'), 'hidden md:table-cell'),
      ]),
    ]);
    const body = this.el('tbody');
    for (const language of entry.languages || []) {
      if (!language || typeof language.language !== 'string') continue;
      for (const row of Array.isArray(language.measures) ? language.measures : []) {
        if (!row || typeof row.measure !== 'string') continue;
        const measureLabel = rolloutsMeasureLabel(row.measure, this.locale);
        const measureNode = (className) =>
          measureLabel
            ? this.el('span', { className: 'break-words ' + className, text: measureLabel })
            : this.el('span', { className: 'font-mono text-xs ' + className, text: row.measure, attrs: { translate: 'no' } });
        body.appendChild(
          this.el('tr', {}, [
            this.el('th', { className: 'font-normal min-w-0', attrs: { scope: 'row' } }, [
              this.el('span', { className: 'block', text: rolloutsLanguageName(language.language, this.locale) }),
              this.el('span', { className: 'block text-xs font-mono text-base-content/70', text: language.language, attrs: { translate: 'no' } }),
              this.el('span', { className: 'block md:hidden mt-1 text-sm', attrs: { 'data-rollouts-measure-stacked': '' } }, [measureNode('')]),
              this.el('span', { className: 'flex mt-1 md:hidden', attrs: { 'data-rollouts-verdict-stacked': '' } }, [this.verdictBadge(row.verdict, true)]),
            ]),
            this.el('td', { className: 'hidden md:table-cell' }, [measureNode('')]),
            this.valueCell(row.measure, row.candidate, 'align-top'),
            this.valueCell(row.measure, row.before, 'hidden md:table-cell'),
            this.valueCell(row.measure, row.others, 'hidden lg:table-cell'),
            this.el('td', { className: 'hidden md:table-cell' }, [this.verdictBadge(row.verdict)]),
          ]),
        );
      }
    }
    const table = this.el('table', { className: 'table table-sm max-md:[&_th]:px-1.5 max-md:[&_td]:px-1.5 max-md:[&_th]:whitespace-normal' }, [this.el('caption', { className: 'sr-only', text: caption }), head, body]);
    children.push(this.el('div', { className: 'overflow-x-auto', attrs: { tabindex: '0', role: 'region', 'aria-label': caption } }, [table]));
    children.push(this.el('p', { className: 'text-xs text-base-content/70 max-w-prose', text: this.t('table.help') }));
    return this.el('div', { className: 'grid gap-2 min-w-0' }, children);
  }

  workspaceName(key) {
    const selector = this.doc && typeof this.doc.getElementById === 'function' ? this.doc.getElementById('workspace-selector') : null;
    if (!selector || typeof selector.querySelectorAll !== 'function') return null;
    const id = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    const option = Array.from(selector.querySelectorAll('option')).find((o) => o.getAttribute('value') === id);
    return option ? option.textContent : null;
  }

  renderKeyList(entry, which) {
    const keys = (Array.isArray(entry[which]) ? entry[which] : []).filter(rolloutsTenantKeyValid);
    const showAll = this.showAll[entry.id + which];
    const shown = showAll ? keys : keys.slice(0, ROLLOUTS_LIST_CAP);
    const action = which === 'included' ? 'exclude' : 'include';
    const list = this.el('ul', { className: 'grid gap-2 min-w-0' });
    for (const key of shown) {
      const button = this.el('button', {
        className: 'btn btn-outline md:btn-sm',
        text: this.t('action.' + action),
        attrs: { type: 'button', 'aria-label': this.t('action.' + action + 'Aria', { tenant: key }) },
      });
      button.addEventListener('click', () => this.confirmMembership(entry, key, action, button));
      const name = this.workspaceName(key);
      list.appendChild(
        this.el('li', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [
          this.el('span', { className: 'font-mono text-xs break-all', text: key, attrs: { translate: 'no' } }),
          name ? this.el('span', { className: 'text-sm', text: name }) : null,
          button,
        ]),
      );
    }
    const nodes = [this.el('p', { className: 'text-sm tabular-nums', text: this.t('tenants.' + which, { count: ROLLOUTS_UI.ragUiFormatNumber(keys.length, this.locale) }) })];
    if (keys.length > 0) nodes.push(list);
    if (keys.length > ROLLOUTS_LIST_CAP && !showAll) {
      const more = this.el('button', { className: 'btn btn-ghost btn-sm', text: this.t('tenants.showAll'), attrs: { type: 'button' } });
      more.addEventListener('click', () => {
        this.showAll[entry.id + which] = true;
        this.render();
      });
      nodes.push(more);
    }
    return this.el('div', { className: 'grid gap-2 min-w-0' }, nodes);
  }

  renderWorkspaces(entry) {
    const inputId = 'rollouts-tenant-key-' + entry.kind;
    const helpId = inputId + '-help';
    const errorId = inputId + '-error';
    const error = this.keyErrors[entry.id];
    const input = this.el('input', {
      className: 'input input-bordered w-full md:input-sm font-mono md:max-w-md' + (error ? ' input-error' : ''),
      id: inputId,
      attrs: {
        type: 'text',
        name: inputId,
        autocomplete: 'off',
        spellcheck: 'false',
        autocapitalize: 'off',
        translate: 'no',
        'aria-describedby': error ? helpId + ' ' + errorId : helpId,
        'aria-invalid': error ? 'true' : null,
      },
    });
    input.value = this.keyValues[entry.id] || '';
    input.addEventListener('input', () => {
      this.keyValues[entry.id] = input.value;
    });
    input.addEventListener('change', () => {
      input.value = input.value.trim().toLowerCase();
      this.keyValues[entry.id] = input.value;
    });
    const byKey = (action) => {
      const button = this.el('button', { className: 'btn btn-outline md:btn-sm', text: this.t('action.' + action), attrs: { type: 'button', 'data-rollouts-key-action': action } });
      button.addEventListener('click', () => {
        const key = String(input.value || '').trim().toLowerCase();
        if (!rolloutsTenantKeyValid(key)) {
          this.keyErrors[entry.id] = this.t('tenant.keyInvalid');
          this.render();
          const again = this.doc.getElementById(inputId);
          if (again) again.focus();
          return;
        }
        delete this.keyErrors[entry.id];
        this.confirmMembership(entry, key, action, button);
      });
      return button;
    };
    return this.el('div', { className: 'grid gap-4 min-w-0' }, [
      this.el('h5', { className: 'text-sm font-semibold', text: this.t('tenants.title') }),
      this.renderKeyList(entry, 'included'),
      this.renderKeyList(entry, 'excluded'),
      this.el('div', { className: 'grid gap-1 min-w-0' }, [
        this.el('label', { className: 'text-sm font-semibold', text: this.t('tenant.key'), attrs: { for: inputId } }),
        input,
        this.el('p', { className: 'text-xs text-base-content/70 max-w-prose', id: helpId, text: this.t('tenant.keyHelp') }),
        error ? this.errorLine(errorId, error) : null,
        this.el('div', { className: 'flex flex-wrap gap-2 mt-1' }, [byKey('include'), byKey('exclude')]),
      ]),
    ]);
  }

  renderCard(entry) {
    const headingId = ROLLOUTS_UI.ragUiNextId('rollouts-card');
    const candidate = this.candidateText(entry);
    const heading = this.el('h4', { className: 'text-base font-semibold min-w-0 break-words', id: headingId }, this.nodes(this.t('card.heading'), { kind: this.kindLabel(entry.kind), candidate }, ['candidate']));
    const policy = this.data.policy || {};
    const meta = [
      entry.mode === 'share' ? this.t('card.mode.share', { percent: ROLLOUTS_UI.ragUiFormatNumber(entry.share, this.locale) }) : this.t('card.mode.tenants'),
      this.t('card.started', { date: rolloutsDate(entry.createdAt, this.locale) }),
      this.t('card.days', { count: ROLLOUTS_UI.ragUiFormatNumber(rolloutsDaysRunning(entry.createdAt, this.now()), this.locale) }),
      Number.isInteger(policy.observationDays) ? this.t('card.observation', { count: ROLLOUTS_UI.ragUiFormatNumber(policy.observationDays, this.locale) }) : null,
    ].filter(Boolean);
    const incumbent = Array.isArray(entry.incumbent) && entry.incumbent.length > 0 ? entry.incumbent.join(', ') : null;
    const arms = entry.arms && typeof entry.arms === 'object' ? entry.arms : {};
    const metaBlock = this.el('div', { className: 'grid gap-1 text-sm' }, [
      this.el('p', { className: 'flex flex-wrap gap-x-6 gap-y-1' }, meta.map((line) => this.el('span', { text: line }))),
      incumbent ? this.el('p', {}, this.nodes(this.t('card.incumbent'), { id: incumbent }, ['id'])) : null,
      this.el('p', { className: 'flex flex-wrap gap-x-6 gap-y-1 tabular-nums' }, [
        this.el('span', { text: this.t('arm.candidate', { count: ROLLOUTS_UI.ragUiFormatNumber(Number.isInteger(arms.candidate) ? arms.candidate : 0, this.locale) }) }),
        this.el('span', { text: this.t('arm.incumbent', { count: ROLLOUTS_UI.ragUiFormatNumber(Number.isInteger(arms.incumbent) ? arms.incumbent : 0, this.locale) }) }),
      ]),
    ]);
    const backend = String((this.config() || {}).RAG_RETRIEVAL_BACKEND ?? '').trim().toLowerCase();
    const note = entry.kind === 'chunking_profile' && (backend === 'weaviate' || backend === 'qdrant') ? this.el('p', { className: 'text-xs text-base-content/70 max-w-prose', text: this.t('note.chunkingExternal') }) : null;

    const promote = this.el('button', { className: 'btn btn-primary md:btn-sm', text: this.t('action.promote'), attrs: { type: 'button', 'data-rollouts-promote': '' } });
    const rollback = this.el('button', { className: 'btn btn-outline md:btn-sm', text: this.t('action.rollback'), attrs: { type: 'button', 'data-rollouts-rollback': '' } });
    promote.addEventListener('click', () => this.confirmPromote(entry, promote));
    rollback.addEventListener('click', () => this.confirmRollback(entry, rollback));
    const refusal = this.refusals[entry.id];
    const refusalAlert = refusal
      ? ROLLOUTS_UI.ragUiAlert(this.doc, {
          tone: 'warning',
          icon: 'exclamation-triangle',
          role: 'alert',
          body: [this.el('p', { className: 'text-sm', attrs: { 'data-rollouts-refusal': '' } }, refusal.template ? this.nodes(refusal.template, refusal.vars, refusal.codeVars) : [refusal.text])],
        })
      : null;

    return this.el('article', { className: 'border-l-4 border-base-300 rounded-lg p-4 grid gap-6 min-w-0', attrs: { 'aria-labelledby': headingId, 'data-rollouts-card': entry.kind } }, [
      this.el('div', { className: 'grid gap-2 min-w-0' }, [this.el('div', { className: 'flex flex-wrap items-start justify-between gap-2' }, [heading, this.stateBadge('active')]), metaBlock, note]),
      this.renderComparison(entry),
      this.renderWorkspaces(entry),
      refusalAlert,
      this.el('div', { className: 'flex flex-wrap gap-2' }, [promote, rollback]),
    ]);
  }

  renderRecent() {
    const caption = this.t('recent.title');
    const th = (text) => this.el('th', { text, attrs: { scope: 'col' } });
    const body = this.el('tbody');
    for (const entry of this.data.ended) {
      const ended = typeof entry.endedAt === 'string' ? entry.endedAt : '';
      body.appendChild(
        this.el('tr', {}, [
          this.el('th', { className: 'font-normal', text: this.kindLabel(entry.kind), attrs: { scope: 'row' } }),
          this.el('td', {}, [this.el('span', { className: 'font-mono text-xs break-all', text: this.candidateText(entry), attrs: { translate: 'no' } })]),
          this.el('td', {}, [this.stateBadge(entry.state)]),
          this.el('td', {}, [this.el('time', { className: 'tabular-nums', text: rolloutsDate(ended, this.locale), attrs: { datetime: ended || null } })]),
        ]),
      );
    }
    return this.el('section', { className: 'grid gap-2 min-w-0', attrs: { 'aria-labelledby': 'rollouts-recent-title' } }, [
      this.el('h4', { className: 'text-base font-semibold', id: 'rollouts-recent-title', text: caption }),
      this.el('div', { className: 'overflow-x-auto', attrs: { tabindex: '0', role: 'region', 'aria-label': caption } }, [
        this.el('table', { className: 'table table-sm' }, [
          this.el('caption', { className: 'sr-only', text: caption }),
          this.el('thead', {}, [this.el('tr', {}, [th(this.t('recent.col.kind')), th(this.t('recent.col.candidate')), th(this.t('recent.col.state')), th(this.t('recent.col.ended'))])]),
          body,
        ]),
      ]),
    ]);
  }

  /** Shared handling of a change answer: 401/403 sign-in, 404 changed, thrown outcome unknown. Returns true when handled. */
  async handleChangeFailure(result) {
    if (!result || result.thrown) {
      this.notice = { kind: 'message', text: this.t('error.outcomeUnknown') };
      this.announce(this.t('error.outcomeUnknown'), 'error');
      await this.load();
      return true;
    }
    if (result.status === 401 || result.status === 403) {
      this.notice = { kind: 'signIn' };
      this.data = null;
      this.render();
      return true;
    }
    if (result.status === 404) {
      this.notice = { kind: 'message', text: this.t('error.changed') };
      this.announce(this.t('error.changed'), 'error');
      await this.load();
      return true;
    }
    return false;
  }

  async confirmMembership(entry, key, action, opener) {
    await ROLLOUTS_UI.ragUiConfirmDialog(this.doc, {
      title: this.t('confirm.' + action + '.title', { tenant: key }),
      body: [this.t('confirm.' + action + '.body')],
      keepLabel: this.t('confirm.tenant.keep'),
      confirmLabel: this.t('action.' + action),
      runningLabel: this.t('tenant.running'),
      opener,
      fallbackFocus: this.part('status'),
      onConfirm: async () => {
        const result = await this.request(ROLLOUTS_PATH, { method: 'POST', body: JSON.stringify({ action, rolloutId: entry.id, tenant: key }) }, ROLLOUTS_CHANGE_TIMEOUT_MS);
        if (await this.handleChangeFailure(result)) return { keepOpen: false };
        if (result.ok) {
          this.keyValues[entry.id] = '';
          await this.load();
          this.announce(this.t(action + '.done', { tenant: key }));
          return { keepOpen: false };
        }
        if (result.status === 400) this.keyErrors[entry.id] = this.t('tenant.keyInvalid');
        else this.announce(this.codeText(result), 'error');
        this.render();
        return { keepOpen: false };
      },
    });
  }

  codeText(result) {
    const body = result && result.body && typeof result.body === 'object' ? result.body : {};
    if (result && result.status === 503) return this.t('list.unavailable');
    if (body.code) return this.t('promote.refused.other', { code: String(body.code) });
    return ROLLOUTS_UI.ragUiSharedLabel('error.generic', this.locale, { status: (result && result.status) || '?' });
  }

  async confirmRollback(entry, opener) {
    await ROLLOUTS_UI.ragUiConfirmDialog(this.doc, {
      title: this.t('confirm.rollback.title'),
      body: [this.t('confirm.rollback.body')],
      keepLabel: this.t('confirm.keepRunning'),
      confirmLabel: this.t('action.rollback'),
      runningLabel: this.t('rollback.running'),
      opener,
      fallbackFocus: this.part('status'),
      onConfirm: async () => {
        const result = await this.request(ROLLOUTS_PATH, { method: 'POST', body: JSON.stringify({ action: 'rollback', rolloutId: entry.id }) }, ROLLOUTS_CHANGE_TIMEOUT_MS);
        if (await this.handleChangeFailure(result)) return { keepOpen: false };
        if (result.ok) {
          await this.load();
          this.announce(this.t('rollback.done'));
        } else {
          this.announce(this.codeText(result), 'error');
          this.render();
        }
        return { keepOpen: false };
      },
    });
  }

  async confirmPromote(entry, opener) {
    const candidate = this.candidateText(entry);
    await ROLLOUTS_UI.ragUiConfirmDialog(this.doc, {
      title: this.t('confirm.promote.title', { candidate }),
      body: [this.el('p', {}, this.nodes(this.t('confirm.promote.body'), { candidate }, ['candidate']))],
      keepLabel: this.t('confirm.keepRunning'),
      confirmLabel: this.t('action.promote'),
      runningLabel: this.t('promote.running'),
      opener,
      fallbackFocus: this.part('status'),
      onConfirm: () => this.promote(entry),
    });
  }

  async promote(entry) {
    const result = await this.request(ROLLOUTS_PATH, { method: 'POST', body: JSON.stringify({ action: 'promote', rolloutId: entry.id }) }, ROLLOUTS_CHANGE_TIMEOUT_MS);
    if (await this.handleChangeFailure(result)) return { keepOpen: false };
    const body = result.body && typeof result.body === 'object' ? result.body : {};
    if (result.status === 409 || body.ok === false) {
      const refusal = rolloutsRefusal(body.code, this.locale);
      this.refusals[entry.id] = refusal;
      await this.load();
      const sentence = refusal.template ? rolloutsFill(refusal.template, refusal.vars) : refusal.text;
      this.announce(sentence, 'error');
      return { keepOpen: false };
    }
    if (result.ok) {
      delete this.refusals[entry.id];
      await this.load();
      this.announce(this.t('promote.done', { candidate: this.candidateText(entry) }));
      return { keepOpen: false };
    }
    this.announce(this.codeText(result), 'error');
    this.render();
    return { keepOpen: false };
  }
}

let ROLLOUTS_PANEL_INSTANCE = null;

/** Idempotent: the first call mounts, later calls reload the list. */
function initRolloutsPanel() {
  if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return;
  const root = document.getElementById('rag-administration-rollouts');
  if (!root) return;
  if (!ROLLOUTS_PANEL_INSTANCE) {
    ROLLOUTS_PANEL_INSTANCE = new RolloutsPanel(root);
    if (typeof window !== 'undefined') window.rolloutsPanel = ROLLOUTS_PANEL_INSTANCE;
    ROLLOUTS_PANEL_INSTANCE.mount();
    return;
  }
  ROLLOUTS_PANEL_INSTANCE.refresh();
}

function bindRolloutsPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-rollouts-bound')) return;
    link.setAttribute('data-rollouts-bound', '1');
    link.addEventListener('click', () => initRolloutsPanel());
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initRolloutsPanel = initRolloutsPanel;
  bindRolloutsPanel();
  document.addEventListener('DOMContentLoaded', () => {
    bindRolloutsPanel();
    const tab = document.getElementById('rag-administration');
    if (tab && tab.classList.contains('active')) initRolloutsPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ROLLOUTS_LABELS,
    rolloutsLabel,
    rolloutsReadiness,
    rolloutsRefusal,
    rolloutsTenantKeyValid,
    rolloutsValidateForm,
    rolloutsFormatValue,
    rolloutsDaysRunning,
    RolloutsPanel,
    initRolloutsPanel,
  };
}
