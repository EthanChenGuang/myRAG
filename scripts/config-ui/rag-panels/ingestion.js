/**
 * Ingestion admin panel — plain-text DOM only.
 */

let sharedIngestLabel;
if (typeof require !== 'undefined') {
  try {
    sharedIngestLabel = require('../document-processing/status-monitor.js').ingestLabel;
  } catch {
    sharedIngestLabel = null;
  }
}

const INGESTION_LABELS = {
  en: {
    "attempt.cost": "Est. cost",
    "attempt.no": "#",
    "attempt.pages": "Pages",
    "attempt.parser": "Parser",
    "attempt.preset": "Preset",
    "attempt.reason": "Reason",
    "attempt.result": "Result",
    "attempt.seconds": "{s} s",
    "attempt.tier": "Tier",
    "attempt.time": "Time",
    "attemptReason.escalation": "Escalated after a failed check",
    "attemptReason.fixed_chain": "Fixed parser chain",
    "attemptReason.initial": "First attempt",
    "attemptReason.native": "Native text layer",
    "attemptReason.progressive_fast": "Progressive fast pass",
    "attemptReason.table_boundary": "Table crosses a range boundary",
    "budget.cap": "Per-document cap: {cap} premium pages.",
    "budget.colKey": "Workspace key",
    "budget.fixed": "Routing is fixed, so LlamaParse pages are not counted here. The budget applies to queued jobs under tiered routing.",
    "budget.l3": "L3 vision pages",
    "budget.loading": "Loading budget…",
    "budget.meterText": "{used} parse pages and {l3} L3 pages used, {reserved} reserved, of {budget}",
    "budget.over": "Use is above the budget: {total} of {budget} pages. New premium parses are refused until next month or until the budget is raised.",
    "budget.parse": "Parse pages",
    "budget.pending": "Settings show a budget of {draft} pages; the app uses {live} until it restarts with the saved value.",
    "budget.refresh": "Refresh budget",
    "budget.remaining": "{remaining} of {budget} left.",
    "budget.reserved": "Reserved",
    "budget.title": "Premium pages, {month} (UTC)",
    "budget.unavailable": "Budget use is unavailable right now. Use Reload panel in a moment.",
    "budget.zero": "No premium budget is set. Under tiered routing, premium parsing and L3 detection do not run.",
    "check.empty_text": "no text",
    "check.garbled": "garbled text",
    "check.language_mismatch": "unexpected language",
    "check.low_chars": "too little text",
    "check.missing_table": "missing table",
    "check.partial_conversion": "partly converted",
    "check.table_boundary": "table split across ranges",
    "confirm.body": "The job for “{file}” and its unpublished version will be removed. Published documents are not affected. This can't be undone.",
    "confirm.cancel": "Keep job",
    "confirm.confirm": "Delete job",
    "confirm.title": "Delete this ingestion job?",
    "detail.attempts": "Parse attempts",
    "detail.attemptsEmpty": "No parse attempts yet.",
    "detail.batch": "Backfill batch",
    "detail.close": "Close details",
    "detail.cost": "Estimated cost",
    "detail.created": "Created",
    "detail.docType": "Document type",
    "detail.documentId": "Document ID",
    "detail.error": "Error",
    "detail.hide": "Hide details for {file}",
    "detail.jobId": "Job ID",
    "detail.loading": "Loading job details…",
    "detail.mime": "File type",
    "detail.noDocumentDryRun": "None, dry runs do not create documents",
    "detail.ranges": "Page ranges",
    "detail.rangesCaption": "Page ranges with their tiers",
    "detail.rangesEmpty": "No page ranges yet. They appear after the page check.",
    "detail.reviewReason": "Review reason",
    "detail.show": "Show details for {file}",
    "detail.source": "Source",
    "detail.updated": "Updated",
    "error.cursorReset": "The list changed, so it was reloaded from the top.",
    "error.cursorTooFar": "The list is too long to page further. Narrow it with a status or kind filter.",
    "error.invalid": "The request was not accepted: {detail}",
    "error.notDeletable": "This job can't be deleted. Its document is live, or you are not an owner or admin of this workspace. To remove a live document, delete it under Document Processing, Document Management.",
    "error.reload": "Reload panel",
    "error.workspace": "Your admin account is not a member of this workspace. Choose another workspace under Document Processing, Upload Destination.",
    "filter.active": "In progress",
    "filter.all": "All",
    "filter.failed": "Failed",
    "filter.legend": "Status",
    "filter.needs_review": "Needs review",
    "filter.other": "Quarantined or skipped",
    "filter.ready": "Ready",
    "jobs.caption": "Ingestion jobs, newest first",
    "jobs.col.actions": "Actions",
    "jobs.col.file": "File",
    "jobs.col.kind": "Kind",
    "jobs.col.pages": "Pages",
    "jobs.col.stage": "Stage",
    "jobs.col.status": "Status",
    "jobs.col.tier": "Tier",
    "jobs.col.updated": "Updated",
    "jobs.empty.asyncOff": "The async ingest queue is off, so uploads are processed at once and create no jobs.",
    "jobs.empty.body": "Jobs appear here when uploads go through the async queue or a backfill runs.",
    "jobs.empty.openSettings": "Open settings",
    "jobs.empty.title": "No ingestion jobs yet",
    "jobs.end": "End of list.",
    "jobs.filtered.empty": "No jobs match this filter.",
    "jobs.filtered.showAll": "Show all jobs",
    "jobs.loadMore": "Load more jobs",
    "jobs.loading": "Loading ingestion jobs…",
    "jobs.loadingMore": "Loading…",
    "jobs.refresh": "Refresh jobs",
    "jobs.retries": "{retries} of {max} retries",
    "jobs.runningHint": "Some jobs are still running. Use Refresh jobs to see their progress.",
    "jobs.untitled": "Untitled file",
    "jobs.updatedAt": "Updated {time}",
    "kind.all": "All kinds",
    "kind.delete": "Removal",
    "kind.dry_run": "Dry run",
    "kind.ingest": "Ingest",
    "kind.legend": "Kind",
    "panel.description": "Queued ingestion jobs, this month's premium pages and parse tier bounds. Jobs and budget follow the workspace chosen under Document Processing.",
    "panel.tabsLabel": "Ingestion views",
    "panel.title": "Ingestion",
    "panel.workspace": "Workspace: {name}",
    "panel.workspaceDefault": "Default workspace",
    "preset.fast": "Fast",
    "preset.native": "Native text layer",
    "preset.premium": "Premium, cloud",
    "preset.structured_full": "Structured, full",
    "preset.structured_layout": "Structured, layout",
    "preset.structured_ocr": "Structured, OCR",
    "range.layer": "Layer",
    "range.pages": "Pages",
    "range.preset": "Preset",
    "range.signals": "Signals",
    "range.single": "Page {n}",
    "range.span": "Pages {start}–{end}",
    "range.status": "Status",
    "range.tier": "Tier",
    "rangeStatus.escalated": "Escalated",
    "rangeStatus.needs_review": "Needs review",
    "rangeStatus.ok": "OK",
    "rangeStatus.pending": "Pending",
    "result.cacheHit": "from cache",
    "result.failed": "Failed (score {score})",
    "result.noCheck": "Not checked",
    "result.onPage": "{check} on page {page}",
    "result.partial": "partly converted",
    "result.passed": "Passed (score {score})",
    "result.refused": "Refused before parsing",
    "ribbon.item": "{tier}, {range}",
    "ribbon.label": "Pages by tier: {list}",
    "ribbon.needsReview": "Needs review",
    "ribbon.segmentTitle": "{range}, {tier}, {status}",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.help": "Affects the chat app only. The Config UI always polls.",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.label": "Live upload status in the chat app",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.opt.false": "Off, poll for status",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.opt.true": "On, Supabase Realtime with polling as fallback",
    "settings.RAG_EMBED_BATCH_MODE.help": "The Batch API halves the embedding cost of a backfill and can take up to 24 hours. Uploads always embed immediately.",
    "settings.RAG_EMBED_BATCH_MODE.label": "Embedding batch mode (backfill only)",
    "settings.RAG_EMBED_BATCH_MODE.opt.batch_api": "OpenAI Batch API",
    "settings.RAG_EMBED_BATCH_MODE.opt.sync": "Immediate",
    "settings.RAG_INGEST_ASYNC.help": "Needs the unified pipeline.",
    "settings.RAG_INGEST_ASYNC.label": "Async ingest queue",
    "settings.RAG_INGEST_ASYNC.opt.off": "Off, process uploads at once",
    "settings.RAG_INGEST_ASYNC.opt.on": "On, queue uploads",
    "settings.RAG_INGEST_WORKER_CONCURRENCY.help": "Jobs each sidecar worker runs at once.",
    "settings.RAG_INGEST_WORKER_CONCURRENCY.label": "Worker concurrency",
    "settings.RAG_PARSER_ALLOW_CLOUD.help": "Applies in every routing mode. Not allowed skips LlamaParse and uses Docling.",
    "settings.RAG_PARSER_ALLOW_CLOUD.label": "Cloud parsing",
    "settings.RAG_PARSER_ALLOW_CLOUD.opt.false": "Not allowed, local parsers only",
    "settings.RAG_PARSER_ALLOW_CLOUD.opt.true": "Allowed",
    "settings.RAG_PARSE_ESCALATION.help": "Re-parses a range one tier higher when its quality check fails, at most twice.",
    "settings.RAG_PARSE_ESCALATION.label": "Escalation",
    "settings.RAG_PARSE_ESCALATION.opt.off": "Off",
    "settings.RAG_PARSE_ESCALATION.opt.on": "On",
    "settings.RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC.help": "When a document needs more premium pages than this, none of them go to premium.",
    "settings.RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC.label": "Premium pages per document",
    "settings.RAG_PARSE_PREMIUM_PAGE_BUDGET.help": "Pages per workspace per UTC month, LlamaParse and L3 together. 0 turns premium parsing off under tiered routing.",
    "settings.RAG_PARSE_PREMIUM_PAGE_BUDGET.label": "Monthly premium page budget",
    "settings.RAG_PARSE_PROGRESSIVE.help": "Publishes a fast version first, shown as {provisional}, then replaces it. Embedding cost doubles for these documents. Uploads only.",
    "settings.RAG_PARSE_PROGRESSIVE.label": "Progressive publish",
    "settings.RAG_PARSE_PROGRESSIVE.opt.false": "Off",
    "settings.RAG_PARSE_PROGRESSIVE.opt.true": "On",
    "settings.RAG_PARSE_ROUTING.help": "Tiered routing needs the unified pipeline and the async queue.",
    "settings.RAG_PARSE_ROUTING.label": "Parse routing",
    "settings.RAG_PARSE_ROUTING.opt.fixed": "Fixed parser chain",
    "settings.RAG_PARSE_ROUTING.opt.tiered": "Tiered, per page",
    "settings.RAG_PARSE_VLM_DETECT.help": "Asks a vision model about pages the rules can't classify. Tiered routing only. Each page counts against the premium budget.",
    "settings.RAG_PARSE_VLM_DETECT.label": "L3 vision detection",
    "settings.RAG_PARSE_VLM_DETECT.opt.false": "Off",
    "settings.RAG_PARSE_VLM_DETECT.opt.true": "On",
    "settings.RAG_PARSE_VLM_MODEL.help": "Leave empty to use the image captioning model.",
    "settings.RAG_PARSE_VLM_MODEL.label": "L3 vision model",
    "settings.group.budget": "Premium budget",
    "settings.group.chat": "Chat app",
    "settings.group.l3": "Vision page detection (L3)",
    "settings.group.routing": "Routing",
    "settings.group.workers": "Workers and backfill",
    "settings.movedOpen": "Open Ingestion settings",
    "settings.movedPointer": "Queue and tiered parsing settings are under RAG administration, Ingestion.",
    "settings.note": "These settings are saved to .env.local with Save All Changes at the top of the page. The app reads them when it restarts.",
    "settings.warnAsync": "The async queue needs the unified pipeline (Ingest pipeline, under RAG Modes).",
    "settings.warnTiered": "Tiered routing needs the unified pipeline and the async queue. With the current values the app falls back to fixed routing.",
    "signal.garbled": "Garbled",
    "signal.has_figure": "Figures",
    "signal.multi_col": "Multiple columns",
    "signal.scanned": "Scanned",
    "signal.table_continues": "Table continues",
    "signal.tables": "Tables",
    "signal.uncertain": "Uncertain",
    "source.chat_upload": "Chat upload",
    "source.config_upload": "Config UI upload",
    "source.image_upload": "Image upload",
    "source.nango": "Cloud connector",
    "source.scraper": "Web scraper",
    "tab.jobs": "Jobs",
    "tab.settings": "Settings",
    "tab.tiers": "Tier bounds",
    "tier.fast": "Fast",
    "tier.native": "Native text",
    "tier.premium": "Premium",
    "tier.structured": "Structured",
    "tiers.bounds": "{min} to {max}",
    "tiers.caption": "Parse tier bounds per document type",
    "tiers.clear": "Use profile default",
    "tiers.clearAria": "Use profile default for {type}",
    "tiers.cleared": "{type} uses the profile default again.",
    "tiers.col.actions": "Actions",
    "tiers.col.effective": "In effect",
    "tiers.col.max": "Maximum",
    "tiers.col.min": "Minimum",
    "tiers.col.profile": "Profile default",
    "tiers.col.type": "Document type",
    "tiers.errorOrder": "The minimum tier can't be above the maximum tier.",
    "tiers.errorPair": "Choose both tiers, or set both to Profile default to clear the override.",
    "tiers.loading": "Loading tier bounds…",
    "tiers.maxAria": "Maximum tier for {type}",
    "tiers.minAria": "Minimum tier for {type}",
    "tiers.notSet": "Not set",
    "tiers.note": "Tier bounds apply to every workspace in this deployment. A document type's minimum raises every page to at least that tier; its maximum caps every page.",
    "tiers.overrideSince": "Override since {date}",
    "tiers.save": "Save bounds",
    "tiers.saveAria": "Save tier bounds for {type}",
    "tiers.saved": "Tier bounds saved for {type}.",
    "tiers.saving": "Saving…",
    "tiers.unavailable": "Tier bounds are unavailable right now. Use Reload panel in a moment.",
    "tiers.useProfile": "Profile default"
  },
  zh: {
    "attempt.cost": "预估成本",
    "attempt.no": "#",
    "attempt.pages": "页码",
    "attempt.parser": "解析器",
    "attempt.preset": "预设",
    "attempt.reason": "原因",
    "attempt.result": "结果",
    "attempt.seconds": "{s} 秒",
    "attempt.tier": "层级",
    "attempt.time": "耗时",
    "attemptReason.escalation": "检查未通过后升级",
    "attemptReason.fixed_chain": "固定解析链",
    "attemptReason.initial": "首次尝试",
    "attemptReason.native": "原生文本层",
    "attemptReason.progressive_fast": "渐进式快速解析",
    "attemptReason.table_boundary": "表格跨越范围边界",
    "budget.cap": "单文档上限：{cap} 个高级页。",
    "budget.colKey": "工作区标识",
    "budget.fixed": "当前为固定路由，LlamaParse 页数不计入此处。预算仅适用于分层路由下的排队任务。",
    "budget.l3": "L3 视觉页",
    "budget.loading": "正在加载预算…",
    "budget.meterText": "已用解析页 {used}、L3 页 {l3}，预留 {reserved}，共 {budget}",
    "budget.over": "用量已超出预算：{total} / {budget} 页。在下个月或提高预算之前，新的高级解析会被拒绝。",
    "budget.parse": "解析页",
    "budget.pending": "设置中的预算为 {draft} 页；在应用以保存的值重启之前，仍使用 {live} 页。",
    "budget.refresh": "刷新预算",
    "budget.remaining": "剩余 {remaining} / {budget}。",
    "budget.reserved": "已预留",
    "budget.title": "高级解析页数，{month}（UTC）",
    "budget.unavailable": "暂时无法读取预算用量，请稍后点击“重新加载面板”。",
    "budget.zero": "未设置高级解析预算。在分层路由下，高级解析和 L3 检测不会运行。",
    "check.empty_text": "无文本",
    "check.garbled": "文本乱码",
    "check.language_mismatch": "语言不符",
    "check.low_chars": "文本过少",
    "check.missing_table": "缺少表格",
    "check.partial_conversion": "部分转换",
    "check.table_boundary": "表格被拆分",
    "confirm.body": "将删除“{file}”的任务及其未发布版本。已发布的文档不受影响。此操作无法撤销。",
    "confirm.cancel": "保留任务",
    "confirm.confirm": "删除任务",
    "confirm.title": "删除此入库任务？",
    "detail.attempts": "解析尝试",
    "detail.attemptsEmpty": "尚无解析尝试。",
    "detail.batch": "回填批次",
    "detail.close": "关闭详情",
    "detail.cost": "预估成本",
    "detail.created": "创建时间",
    "detail.docType": "文档类型",
    "detail.documentId": "文档 ID",
    "detail.error": "错误",
    "detail.hide": "隐藏 {file} 的详情",
    "detail.jobId": "任务 ID",
    "detail.loading": "正在加载任务详情…",
    "detail.mime": "文件类型",
    "detail.noDocumentDryRun": "无（试运行不会创建文档）",
    "detail.ranges": "页面范围",
    "detail.rangesCaption": "页面范围及其层级",
    "detail.rangesEmpty": "尚无页面范围，页面预检后显示。",
    "detail.reviewReason": "审核原因",
    "detail.show": "显示 {file} 的详情",
    "detail.source": "来源",
    "detail.updated": "更新时间",
    "error.cursorReset": "列表已变化，已从头重新加载。",
    "error.cursorTooFar": "列表过长，无法继续翻页。请用状态或类型筛选缩小范围。",
    "error.invalid": "请求未被接受：{detail}",
    "error.notDeletable": "无法删除此任务。其文档已上线，或你不是此工作区的所有者或管理员。要移除已上线的文档，请在“文档处理 → 文档管理”中删除。",
    "error.reload": "重新加载面板",
    "error.workspace": "你的管理员账户不是此工作区的成员。请在“文档处理 → 上传目标”中选择其他工作区。",
    "filter.active": "进行中",
    "filter.all": "全部",
    "filter.failed": "失败",
    "filter.legend": "状态",
    "filter.needs_review": "待审核",
    "filter.other": "已隔离或已跳过",
    "filter.ready": "已就绪",
    "jobs.caption": "入库任务（最新在前）",
    "jobs.col.actions": "操作",
    "jobs.col.file": "文件",
    "jobs.col.kind": "类型",
    "jobs.col.pages": "页数",
    "jobs.col.stage": "阶段",
    "jobs.col.status": "状态",
    "jobs.col.tier": "层级",
    "jobs.col.updated": "更新时间",
    "jobs.empty.asyncOff": "异步入库队列已关闭，上传会立即处理，不会创建任务。",
    "jobs.empty.body": "当上传走异步队列或运行回填时，任务会显示在这里。",
    "jobs.empty.openSettings": "打开设置",
    "jobs.empty.title": "暂无入库任务",
    "jobs.end": "已到列表末尾。",
    "jobs.filtered.empty": "没有符合此筛选条件的任务。",
    "jobs.filtered.showAll": "显示全部任务",
    "jobs.loadMore": "加载更多任务",
    "jobs.loading": "正在加载入库任务…",
    "jobs.loadingMore": "正在加载…",
    "jobs.refresh": "刷新任务",
    "jobs.retries": "已重试 {retries} / {max} 次",
    "jobs.runningHint": "部分任务仍在运行，点击“刷新任务”可查看进度。",
    "jobs.untitled": "未命名文件",
    "jobs.updatedAt": "更新于 {time}",
    "kind.all": "全部类型",
    "kind.delete": "移除",
    "kind.dry_run": "试运行",
    "kind.ingest": "入库",
    "kind.legend": "类型",
    "panel.description": "排队中的入库任务、本月高级解析页数和解析层级范围。任务和预算跟随“文档处理”中所选的工作区。",
    "panel.tabsLabel": "入库视图",
    "panel.title": "文档入库",
    "panel.workspace": "工作区：{name}",
    "panel.workspaceDefault": "默认工作区",
    "preset.fast": "快速",
    "preset.native": "原生文本层",
    "preset.premium": "高级（云端）",
    "preset.structured_full": "结构化（完整）",
    "preset.structured_layout": "结构化（版面）",
    "preset.structured_ocr": "结构化（OCR）",
    "range.layer": "检测层",
    "range.pages": "页码",
    "range.preset": "预设",
    "range.signals": "信号",
    "range.single": "第 {n} 页",
    "range.span": "第 {start}–{end} 页",
    "range.status": "状态",
    "range.tier": "层级",
    "rangeStatus.escalated": "已升级",
    "rangeStatus.needs_review": "待审核",
    "rangeStatus.ok": "正常",
    "rangeStatus.pending": "待处理",
    "result.cacheHit": "来自缓存",
    "result.failed": "未通过（得分 {score}）",
    "result.noCheck": "未检查",
    "result.onPage": "第 {page} 页{check}",
    "result.partial": "部分转换",
    "result.passed": "通过（得分 {score}）",
    "result.refused": "解析前被拒绝",
    "ribbon.item": "{tier}，{range}",
    "ribbon.label": "按层级划分的页面：{list}",
    "ribbon.needsReview": "待审核",
    "ribbon.segmentTitle": "{range}，{tier}，{status}",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.help": "仅影响聊天应用。Config UI 始终轮询。",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.label": "聊天应用中的实时上传状态",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.opt.false": "关闭（轮询状态）",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.opt.true": "开启（Supabase Realtime，轮询兜底）",
    "settings.RAG_EMBED_BATCH_MODE.help": "Batch API 可将回填的向量化成本减半，最长可能需要 24 小时。上传始终立即向量化。",
    "settings.RAG_EMBED_BATCH_MODE.label": "向量化批处理模式（仅回填）",
    "settings.RAG_EMBED_BATCH_MODE.opt.batch_api": "OpenAI Batch API",
    "settings.RAG_EMBED_BATCH_MODE.opt.sync": "即时",
    "settings.RAG_INGEST_ASYNC.help": "需要统一管线。",
    "settings.RAG_INGEST_ASYNC.label": "异步入库队列",
    "settings.RAG_INGEST_ASYNC.opt.off": "关闭（立即处理上传）",
    "settings.RAG_INGEST_ASYNC.opt.on": "开启（上传排队）",
    "settings.RAG_INGEST_WORKER_CONCURRENCY.help": "每个侧车工作进程同时运行的任务数。",
    "settings.RAG_INGEST_WORKER_CONCURRENCY.label": "工作进程并发数",
    "settings.RAG_PARSER_ALLOW_CLOUD.help": "在所有路由模式下生效。不允许时跳过 LlamaParse，改用 Docling。",
    "settings.RAG_PARSER_ALLOW_CLOUD.label": "云端解析",
    "settings.RAG_PARSER_ALLOW_CLOUD.opt.false": "不允许（仅本地解析器）",
    "settings.RAG_PARSER_ALLOW_CLOUD.opt.true": "允许",
    "settings.RAG_PARSE_ESCALATION.help": "质量检查未通过时，将该范围提升一个层级重新解析，最多两次。",
    "settings.RAG_PARSE_ESCALATION.label": "自动升级",
    "settings.RAG_PARSE_ESCALATION.opt.off": "关闭",
    "settings.RAG_PARSE_ESCALATION.opt.on": "开启",
    "settings.RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC.help": "当文档需要的高级页数超过此值时，所有页面都不走高级解析。",
    "settings.RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC.label": "单文档高级页数上限",
    "settings.RAG_PARSE_PREMIUM_PAGE_BUDGET.help": "每个工作区每个 UTC 月的页数，LlamaParse 与 L3 合计。设为 0 时，分层路由下不进行高级解析。",
    "settings.RAG_PARSE_PREMIUM_PAGE_BUDGET.label": "每月高级解析页数预算",
    "settings.RAG_PARSE_PROGRESSIVE.help": "先发布快速版本（显示为“{provisional}”），之后替换。这些文档的向量化成本会翻倍。仅适用于上传。",
    "settings.RAG_PARSE_PROGRESSIVE.label": "渐进式发布",
    "settings.RAG_PARSE_PROGRESSIVE.opt.false": "关闭",
    "settings.RAG_PARSE_PROGRESSIVE.opt.true": "开启",
    "settings.RAG_PARSE_ROUTING.help": "分层路由需要统一管线和异步队列。",
    "settings.RAG_PARSE_ROUTING.label": "解析路由",
    "settings.RAG_PARSE_ROUTING.opt.fixed": "固定解析链",
    "settings.RAG_PARSE_ROUTING.opt.tiered": "分层（按页）",
    "settings.RAG_PARSE_VLM_DETECT.help": "对规则无法判断的页面调用视觉模型。仅限分层路由。每页计入高级解析预算。",
    "settings.RAG_PARSE_VLM_DETECT.label": "L3 视觉检测",
    "settings.RAG_PARSE_VLM_DETECT.opt.false": "关闭",
    "settings.RAG_PARSE_VLM_DETECT.opt.true": "开启",
    "settings.RAG_PARSE_VLM_MODEL.help": "留空则使用图片描述模型。",
    "settings.RAG_PARSE_VLM_MODEL.label": "L3 视觉模型",
    "settings.group.budget": "高级解析预算",
    "settings.group.chat": "聊天应用",
    "settings.group.l3": "视觉页面检测（L3）",
    "settings.group.routing": "路由",
    "settings.group.workers": "工作进程与回填",
    "settings.movedOpen": "打开入库设置",
    "settings.movedPointer": "队列与分层解析设置位于“RAG 管理 → 文档入库”。",
    "settings.note": "这些设置通过页面顶部的 Save All Changes 保存到 .env.local，应用重启后生效。",
    "settings.warnAsync": "异步队列需要统一管线（见“RAG Modes”中的 Ingest pipeline）。",
    "settings.warnTiered": "分层路由需要统一管线和异步队列。按当前设置，应用会回退为固定路由。",
    "signal.garbled": "乱码",
    "signal.has_figure": "图片",
    "signal.multi_col": "多栏",
    "signal.scanned": "扫描件",
    "signal.table_continues": "表格续页",
    "signal.tables": "表格",
    "signal.uncertain": "不确定",
    "source.chat_upload": "聊天上传",
    "source.config_upload": "Config UI 上传",
    "source.image_upload": "图片上传",
    "source.nango": "云盘连接器",
    "source.scraper": "网页抓取",
    "tab.jobs": "任务",
    "tab.settings": "设置",
    "tab.tiers": "解析层级",
    "tier.fast": "快速",
    "tier.native": "原生文本",
    "tier.premium": "高级",
    "tier.structured": "结构化",
    "tiers.bounds": "{min} 至 {max}",
    "tiers.caption": "各文档类型的解析层级范围",
    "tiers.clear": "恢复配置默认值",
    "tiers.clearAria": "为 {type} 恢复配置默认值",
    "tiers.cleared": "{type} 已恢复为配置默认值。",
    "tiers.col.actions": "操作",
    "tiers.col.effective": "生效值",
    "tiers.col.max": "最高",
    "tiers.col.min": "最低",
    "tiers.col.profile": "配置默认值",
    "tiers.col.type": "文档类型",
    "tiers.errorOrder": "最低层级不能高于最高层级。",
    "tiers.errorPair": "请同时选择两个层级，或都设为“配置默认值”以清除覆盖。",
    "tiers.loading": "正在加载解析层级…",
    "tiers.maxAria": "{type} 的最高层级",
    "tiers.minAria": "{type} 的最低层级",
    "tiers.notSet": "未设置",
    "tiers.note": "解析层级范围适用于此部署中的所有工作区。文档类型的最低层级会把每一页提升到至少该层级；最高层级限制每一页的上限。",
    "tiers.overrideSince": "自 {date} 起覆盖",
    "tiers.save": "保存范围",
    "tiers.saveAria": "保存 {type} 的层级范围",
    "tiers.saved": "已保存 {type} 的层级范围。",
    "tiers.saving": "正在保存…",
    "tiers.unavailable": "暂时无法读取解析层级，请稍后点击“重新加载面板”。",
    "tiers.useProfile": "配置默认值"
  },
  it: {
    "attempt.cost": "Costo stim.",
    "attempt.no": "N.",
    "attempt.pages": "Pagine",
    "attempt.parser": "Parser",
    "attempt.preset": "Preset",
    "attempt.reason": "Motivo",
    "attempt.result": "Esito",
    "attempt.seconds": "{s} s",
    "attempt.tier": "Livello",
    "attempt.time": "Durata",
    "attemptReason.escalation": "Scalato dopo un controllo non superato",
    "attemptReason.fixed_chain": "Catena di parser fissa",
    "attemptReason.initial": "Primo tentativo",
    "attemptReason.native": "Livello di testo nativo",
    "attemptReason.progressive_fast": "Passaggio rapido progressivo",
    "attemptReason.table_boundary": "Tabella a cavallo di due intervalli",
    "budget.cap": "Limite per documento: {cap} pagine premium.",
    "budget.colKey": "Chiave dello spazio di lavoro",
    "budget.fixed": "Il routing è fisso, quindi le pagine LlamaParse non vengono conteggiate qui. Il budget si applica ai job in coda con routing a livelli.",
    "budget.l3": "Pagine visione L3",
    "budget.loading": "Caricamento del budget…",
    "budget.meterText": "{used} pagine di parsing e {l3} pagine L3 usate, {reserved} riservate, su {budget}",
    "budget.over": "L'uso supera il budget: {total} di {budget} pagine. I nuovi parsing premium vengono rifiutati fino al mese prossimo o a un aumento del budget.",
    "budget.parse": "Pagine di parsing",
    "budget.pending": "Le impostazioni indicano {draft} pagine; l'app usa {live} finché non si riavvia con il valore salvato.",
    "budget.refresh": "Aggiorna budget",
    "budget.remaining": "{remaining} di {budget} rimaste.",
    "budget.reserved": "Riservate",
    "budget.title": "Pagine premium, {month} (UTC)",
    "budget.unavailable": "L'uso del budget non è disponibile al momento. Usa Ricarica pannello tra poco.",
    "budget.zero": "Nessun budget premium impostato. Con il routing a livelli, il parsing premium e il rilevamento L3 non vengono eseguiti.",
    "check.empty_text": "nessun testo",
    "check.garbled": "testo illeggibile",
    "check.language_mismatch": "lingua inattesa",
    "check.low_chars": "testo insufficiente",
    "check.missing_table": "tabella mancante",
    "check.partial_conversion": "conversione parziale",
    "check.table_boundary": "tabella divisa tra intervalli",
    "confirm.body": "Il job per «{file}» e la sua versione non pubblicata verranno rimossi. I documenti pubblicati non vengono modificati. L'operazione non può essere annullata.",
    "confirm.cancel": "Mantieni job",
    "confirm.confirm": "Elimina job",
    "confirm.title": "Eliminare questo job di acquisizione?",
    "detail.attempts": "Tentativi di parsing",
    "detail.attemptsEmpty": "Nessun tentativo di parsing.",
    "detail.batch": "Batch di backfill",
    "detail.close": "Chiudi dettagli",
    "detail.cost": "Costo stimato",
    "detail.created": "Creato",
    "detail.docType": "Tipo di documento",
    "detail.documentId": "ID documento",
    "detail.error": "Errore",
    "detail.hide": "Nascondi i dettagli di {file}",
    "detail.jobId": "ID job",
    "detail.loading": "Caricamento dei dettagli del job…",
    "detail.mime": "Tipo di file",
    "detail.noDocumentDryRun": "Nessuno, le prove non creano documenti",
    "detail.ranges": "Intervalli di pagine",
    "detail.rangesCaption": "Intervalli di pagine con i loro livelli",
    "detail.rangesEmpty": "Nessun intervallo di pagine. Compaiono dopo la verifica delle pagine.",
    "detail.reviewReason": "Motivo della revisione",
    "detail.show": "Mostra i dettagli di {file}",
    "detail.source": "Origine",
    "detail.updated": "Aggiornato",
    "error.cursorReset": "L'elenco è cambiato ed è stato ricaricato dall'inizio.",
    "error.cursorTooFar": "L'elenco è troppo lungo per continuare. Restringilo con un filtro di stato o tipo.",
    "error.invalid": "Richiesta non accettata: {detail}",
    "error.notDeletable": "Impossibile eliminare questo job. Il documento è già pubblicato, oppure non sei proprietario o amministratore di questo spazio di lavoro. Per rimuovere un documento pubblicato, eliminalo in Elaborazione documenti, Gestione documenti.",
    "error.reload": "Ricarica pannello",
    "error.workspace": "Il tuo account amministratore non è membro di questo spazio di lavoro. Scegline un altro in Elaborazione documenti, Destinazione del caricamento.",
    "filter.active": "In corso",
    "filter.all": "Tutti",
    "filter.failed": "Non riusciti",
    "filter.legend": "Stato",
    "filter.needs_review": "Da rivedere",
    "filter.other": "In quarantena o saltati",
    "filter.ready": "Pronti",
    "jobs.caption": "Job di acquisizione, dal più recente",
    "jobs.col.actions": "Azioni",
    "jobs.col.file": "File",
    "jobs.col.kind": "Tipo",
    "jobs.col.pages": "Pagine",
    "jobs.col.stage": "Fase",
    "jobs.col.status": "Stato",
    "jobs.col.tier": "Livello",
    "jobs.col.updated": "Aggiornato",
    "jobs.empty.asyncOff": "La coda di acquisizione asincrona è disattivata: i caricamenti vengono elaborati subito e non creano job.",
    "jobs.empty.body": "I job compaiono qui quando i caricamenti passano dalla coda asincrona o quando si esegue un backfill.",
    "jobs.empty.openSettings": "Apri impostazioni",
    "jobs.empty.title": "Nessun job di acquisizione",
    "jobs.end": "Fine dell'elenco.",
    "jobs.filtered.empty": "Nessun job corrisponde a questo filtro.",
    "jobs.filtered.showAll": "Mostra tutti i job",
    "jobs.loadMore": "Carica altri job",
    "jobs.loading": "Caricamento dei job di acquisizione…",
    "jobs.loadingMore": "Caricamento…",
    "jobs.refresh": "Aggiorna job",
    "jobs.retries": "{retries} di {max} tentativi",
    "jobs.runningHint": "Alcuni job sono ancora in esecuzione. Usa Aggiorna job per vederne l'avanzamento.",
    "jobs.untitled": "File senza nome",
    "jobs.updatedAt": "Aggiornato alle {time}",
    "kind.all": "Tutti i tipi",
    "kind.delete": "Rimozione",
    "kind.dry_run": "Prova",
    "kind.ingest": "Acquisizione",
    "kind.legend": "Tipo",
    "panel.description": "Job di acquisizione in coda, pagine premium di questo mese e limiti dei livelli di parsing. Job e budget seguono lo spazio di lavoro scelto in Elaborazione documenti.",
    "panel.tabsLabel": "Viste di acquisizione",
    "panel.title": "Acquisizione",
    "panel.workspace": "Spazio di lavoro: {name}",
    "panel.workspaceDefault": "Spazio di lavoro predefinito",
    "preset.fast": "Veloce",
    "preset.native": "Livello di testo nativo",
    "preset.premium": "Premium, cloud",
    "preset.structured_full": "Strutturato, completo",
    "preset.structured_layout": "Strutturato, layout",
    "preset.structured_ocr": "Strutturato, OCR",
    "range.layer": "Livello di rilevamento",
    "range.pages": "Pagine",
    "range.preset": "Preset",
    "range.signals": "Segnali",
    "range.single": "Pagina {n}",
    "range.span": "Pagine {start}–{end}",
    "range.status": "Stato",
    "range.tier": "Livello",
    "rangeStatus.escalated": "Scalato",
    "rangeStatus.needs_review": "Da rivedere",
    "rangeStatus.ok": "OK",
    "rangeStatus.pending": "In attesa",
    "result.cacheHit": "dalla cache",
    "result.failed": "Non superato (punteggio {score})",
    "result.noCheck": "Non controllato",
    "result.onPage": "{check} a pagina {page}",
    "result.partial": "conversione parziale",
    "result.passed": "Superato (punteggio {score})",
    "result.refused": "Rifiutato prima del parsing",
    "ribbon.item": "{tier}, {range}",
    "ribbon.label": "Pagine per livello: {list}",
    "ribbon.needsReview": "Da rivedere",
    "ribbon.segmentTitle": "{range}, {tier}, {status}",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.help": "Riguarda solo l'app di chat. La Config UI interroga sempre lo stato.",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.label": "Stato dei caricamenti in tempo reale nell'app di chat",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.opt.false": "Disattivato, interroga lo stato",
    "settings.NEXT_PUBLIC_RAG_INGEST_REALTIME.opt.true": "Attivato, Supabase Realtime con polling di riserva",
    "settings.RAG_EMBED_BATCH_MODE.help": "La Batch API dimezza il costo di embedding di un backfill e può richiedere fino a 24 ore. I caricamenti eseguono sempre l'embedding subito.",
    "settings.RAG_EMBED_BATCH_MODE.label": "Modalità batch degli embedding (solo backfill)",
    "settings.RAG_EMBED_BATCH_MODE.opt.batch_api": "OpenAI Batch API",
    "settings.RAG_EMBED_BATCH_MODE.opt.sync": "Immediata",
    "settings.RAG_INGEST_ASYNC.help": "Richiede la pipeline unificata.",
    "settings.RAG_INGEST_ASYNC.label": "Coda di acquisizione asincrona",
    "settings.RAG_INGEST_ASYNC.opt.off": "Disattivata, elabora subito",
    "settings.RAG_INGEST_ASYNC.opt.on": "Attivata, metti in coda",
    "settings.RAG_INGEST_WORKER_CONCURRENCY.help": "Job eseguiti contemporaneamente da ogni worker del sidecar.",
    "settings.RAG_INGEST_WORKER_CONCURRENCY.label": "Concorrenza dei worker",
    "settings.RAG_PARSER_ALLOW_CLOUD.help": "Vale in ogni modalità di routing. Se non consentito, salta LlamaParse e usa Docling.",
    "settings.RAG_PARSER_ALLOW_CLOUD.label": "Parsing cloud",
    "settings.RAG_PARSER_ALLOW_CLOUD.opt.false": "Non consentito, solo parser locali",
    "settings.RAG_PARSER_ALLOW_CLOUD.opt.true": "Consentito",
    "settings.RAG_PARSE_ESCALATION.help": "Se il controllo qualità fallisce, rielabora l'intervallo un livello più in alto, al massimo due volte.",
    "settings.RAG_PARSE_ESCALATION.label": "Escalation",
    "settings.RAG_PARSE_ESCALATION.opt.off": "Disattiva",
    "settings.RAG_PARSE_ESCALATION.opt.on": "Attiva",
    "settings.RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC.help": "Se un documento richiede più pagine premium di questo valore, nessuna passa al premium.",
    "settings.RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC.label": "Pagine premium per documento",
    "settings.RAG_PARSE_PREMIUM_PAGE_BUDGET.help": "Pagine per spazio di lavoro per mese UTC, LlamaParse e L3 insieme. 0 disattiva il parsing premium con il routing a livelli.",
    "settings.RAG_PARSE_PREMIUM_PAGE_BUDGET.label": "Budget mensile di pagine premium",
    "settings.RAG_PARSE_PROGRESSIVE.help": "Pubblica prima una versione rapida, indicata come {provisional}, poi la sostituisce. Il costo di embedding raddoppia per questi documenti. Solo caricamenti.",
    "settings.RAG_PARSE_PROGRESSIVE.label": "Pubblicazione progressiva",
    "settings.RAG_PARSE_PROGRESSIVE.opt.false": "Disattiva",
    "settings.RAG_PARSE_PROGRESSIVE.opt.true": "Attiva",
    "settings.RAG_PARSE_ROUTING.help": "Il routing a livelli richiede la pipeline unificata e la coda asincrona.",
    "settings.RAG_PARSE_ROUTING.label": "Routing del parsing",
    "settings.RAG_PARSE_ROUTING.opt.fixed": "Catena di parser fissa",
    "settings.RAG_PARSE_ROUTING.opt.tiered": "A livelli, per pagina",
    "settings.RAG_PARSE_VLM_DETECT.help": "Interroga un modello visivo sulle pagine che le regole non sanno classificare. Solo routing a livelli. Ogni pagina conta nel budget premium.",
    "settings.RAG_PARSE_VLM_DETECT.label": "Rilevamento visivo L3",
    "settings.RAG_PARSE_VLM_DETECT.opt.false": "Disattiva",
    "settings.RAG_PARSE_VLM_DETECT.opt.true": "Attiva",
    "settings.RAG_PARSE_VLM_MODEL.help": "Lascia vuoto per usare il modello di didascalie delle immagini.",
    "settings.RAG_PARSE_VLM_MODEL.label": "Modello visivo L3",
    "settings.group.budget": "Budget premium",
    "settings.group.chat": "App di chat",
    "settings.group.l3": "Rilevamento visivo delle pagine (L3)",
    "settings.group.routing": "Routing",
    "settings.group.workers": "Worker e backfill",
    "settings.movedOpen": "Apri impostazioni di acquisizione",
    "settings.movedPointer": "Le impostazioni di coda e parsing a livelli sono in Amministrazione RAG, Acquisizione.",
    "settings.note": "Queste impostazioni vengono salvate in .env.local con Save All Changes in cima alla pagina. L'app le legge al riavvio.",
    "settings.warnAsync": "La coda asincrona richiede la pipeline unificata (Ingest pipeline, in RAG Modes).",
    "settings.warnTiered": "Il routing a livelli richiede la pipeline unificata e la coda asincrona. Con i valori attuali l'app torna al routing fisso.",
    "signal.garbled": "Illeggibile",
    "signal.has_figure": "Figure",
    "signal.multi_col": "Più colonne",
    "signal.scanned": "Scansione",
    "signal.table_continues": "Tabella continua",
    "signal.tables": "Tabelle",
    "signal.uncertain": "Incerto",
    "source.chat_upload": "Caricamento chat",
    "source.config_upload": "Caricamento Config UI",
    "source.image_upload": "Caricamento immagine",
    "source.nango": "Connettore cloud",
    "source.scraper": "Web scraper",
    "tab.jobs": "Job",
    "tab.settings": "Impostazioni",
    "tab.tiers": "Livelli di parsing",
    "tier.fast": "Veloce",
    "tier.native": "Testo nativo",
    "tier.premium": "Premium",
    "tier.structured": "Strutturato",
    "tiers.bounds": "da {min} a {max}",
    "tiers.caption": "Limiti dei livelli di parsing per tipo di documento",
    "tiers.clear": "Usa predefinito del profilo",
    "tiers.clearAria": "Usa predefinito del profilo per {type}",
    "tiers.cleared": "{type} usa di nuovo il predefinito del profilo.",
    "tiers.col.actions": "Azioni",
    "tiers.col.effective": "In vigore",
    "tiers.col.max": "Massimo",
    "tiers.col.min": "Minimo",
    "tiers.col.profile": "Predefinito del profilo",
    "tiers.col.type": "Tipo di documento",
    "tiers.errorOrder": "Il livello minimo non può superare il massimo.",
    "tiers.errorPair": "Scegli entrambi i livelli, oppure impostali entrambi su Predefinito del profilo per rimuovere la personalizzazione.",
    "tiers.loading": "Caricamento dei livelli di parsing…",
    "tiers.maxAria": "Livello massimo per {type}",
    "tiers.minAria": "Livello minimo per {type}",
    "tiers.notSet": "Non impostato",
    "tiers.note": "I limiti dei livelli valgono per tutti gli spazi di lavoro di questa installazione. Il minimo di un tipo di documento porta ogni pagina almeno a quel livello; il massimo limita ogni pagina.",
    "tiers.overrideSince": "Personalizzato dal {date}",
    "tiers.save": "Salva limiti",
    "tiers.saveAria": "Salva i livelli per {type}",
    "tiers.saved": "Livelli salvati per {type}.",
    "tiers.saving": "Salvataggio…",
    "tiers.unavailable": "I livelli di parsing non sono disponibili al momento. Usa Ricarica pannello tra poco.",
    "tiers.useProfile": "Predefinito del profilo"
  },
};

function fillTemplate(text, vars) {
  if (!text || !vars) return text;
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split('{' + key + '}').join(String(value ?? ''));
  }
  return out;
}

function detectUiLocale() {
  const lang = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').slice(0, 2);
  if (lang === 'zh' || lang === 'it') return lang;
  return 'en';
}

function resolveSharedLabel(key, locale, vars) {
  if (typeof window !== 'undefined' && typeof window.ingestLabel === 'function') {
    return window.ingestLabel(key, locale, vars);
  }
  if (sharedIngestLabel) return sharedIngestLabel(key, locale, vars);
  return key;
}

function ingestionLabel(key, locale, vars) {
  const loc = locale === 'zh' || locale === 'it' ? locale : 'en';
  let extra = vars;
  if (key === 'settings.RAG_PARSE_PROGRESSIVE.help') {
    extra = {
      ...vars,
      provisional: resolveSharedLabel('status.provisional', loc),
    };
  }
  const table = INGESTION_LABELS[loc] || INGESTION_LABELS.en;
  if (table[key]) return fillTemplate(table[key], extra);
  if (INGESTION_LABELS.en[key]) return fillTemplate(INGESTION_LABELS.en[key], extra);
  return resolveSharedLabel(key, loc, extra);
}

const TIER_ORDER = ['native', 'fast', 'structured', 'premium'];
const NON_TERMINAL = new Set(['queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding']);

function tierLabel(tier, locale) {
  return tier ? ingestionLabel('tier.' + tier, locale) : '—';
}

function statusBadgeKey(job) {
  const status = String(job.status || '');
  const terminal = !NON_TERMINAL.has(status);
  if (job.provisional === true && !terminal && NON_TERMINAL.has(status)) return 'status.provisional';
  if (job.kind === 'dry_run' && status === 'ready') return 'status.dryRunReady';
  if (job.kind === 'delete' && status === 'ready') return 'status.deleteReady';
  if (status) return 'status.' + status;
  return status;
}

function buildJobRowView(job, locale, docTypeLabel) {
  const filename = job.filename != null ? String(job.filename) : ingestionLabel('jobs.untitled', locale);
  const statusKey = statusBadgeKey(job);
  const statusLabel = resolveSharedLabel(statusKey, locale);
  const kind = String(job.kind || 'ingest');
  let kindLabel = ingestionLabel('kind.' + kind, locale);
  let kindBadge = '';
  if (kind === 'dry_run') kindBadge = kindLabel;

  return {
    id: String(job.id || ''),
    filename,
    docType: docTypeLabel ? String(docTypeLabel) : '',
    kind,
    kindLabel,
    kindBadge,
    status: String(job.status || ''),
    statusLabel,
    statusKey,
    stage: job.stage != null ? String(job.stage) : '—',
    tier: job.tier != null ? tierLabel(String(job.tier), locale) : '—',
    pages: job.pages != null ? String(job.pages) : '—',
    updatedAt: String(job.updated_at || ''),
    retriesLine:
      job.retries > 0
        ? ingestionLabel('jobs.retries', locale, { retries: job.retries, max: job.max_retries ?? 3 })
        : '',
    showRetry: job.status === 'failed' || job.status === 'needs_review',
    showDelete: job.status === 'failed' || job.status === 'needs_review',
    provisionalBadge: job.provisional === true && NON_TERMINAL.has(String(job.status || '')),
  };
}

function buildJobDetailView(job, locale, docTypeLabel) {
  const errorClass = job.error_class ? resolveSharedLabel('reason.' + job.error_class, locale) : '';
  const reviewReason = job.needs_review_reason
    ? resolveSharedLabel('reason.' + job.needs_review_reason, locale) || String(job.needs_review_reason)
    : '';
  const pageRanges = (Array.isArray(job.page_ranges) ? job.page_ranges : []).map((r) => ({
    span: r.start === r.end ? ingestionLabel('range.single', locale, { n: r.start }) : ingestionLabel('range.span', locale, { start: r.start, end: r.end }),
    tier: tierLabel(r.tier, locale),
    preset: ingestionLabel('preset.' + r.preset, locale) || String(r.preset || '—'),
    layer: r.layer ? 'L' + r.layer : '—',
    status: ingestionLabel('rangeStatus.' + r.status, locale) || String(r.status || ''),
    signals: (Array.isArray(r.signals) ? r.signals : []).map((s) => ingestionLabel('signal.' + s, locale) || s).join(', ') || '—',
  }));
  const attempts = (Array.isArray(job.attempts) ? job.attempts : []).map((a) => ({
    no: String(a.attempt_no ?? ''),
    pages: a.pages != null ? String(a.pages) : '—',
    tier: tierLabel(a.tier, locale),
    preset: ingestionLabel('preset.' + a.preset, locale) || String(a.preset || '—'),
    reason: ingestionLabel('attemptReason.' + a.reason, locale) || String(a.reason || ''),
    parser: [a.parser, a.parser_version].filter(Boolean).join(' '),
    result: String(a.result || ''),
  }));
  return {
    jobId: String(job.id || ''),
    documentId: job.kind === 'dry_run' ? ingestionLabel('detail.noDocumentDryRun', locale) : job.document_id ? String(job.document_id) : '—',
    docType: docTypeLabel ? String(docTypeLabel) : String(job.doc_class || '—'),
    source: job.source ? ingestionLabel('source.' + job.source, locale) || String(job.source) : '—',
    mime: job.mime_type ? String(job.mime_type) : '—',
    batch: job.batch_id ? String(job.batch_id) : '—',
    cost: job.est_cost_usd != null ? String(job.est_cost_usd) : '—',
    error: errorClass || (job.error_class ? String(job.error_class) : ''),
    reviewReason,
    pageRanges,
    attempts,
    showRetry: job.status === 'failed' || job.status === 'needs_review',
    showDelete: job.status === 'failed' || job.status === 'needs_review',
  };
}

function buildBudgetView(body, locale) {
  const tenants = Array.isArray(body.tenants) ? body.tenants : [];
  const sum = tenants.reduce(
    (acc, t) => {
      acc.used += Number(t.used) || 0;
      acc.vlmUsed += Number(t.vlmUsed) || 0;
      acc.reserved += Number(t.reserved) || 0;
      return acc;
    },
    { used: 0, vlmUsed: 0, reserved: 0 },
  );
  const budget = Number(body.budgetPages) || 0;
  const remaining = Math.max(0, budget - sum.used - sum.vlmUsed - sum.reserved);
  return {
    month: String(body.month || ''),
    budgetPages: String(budget),
    maxPagesPerDoc: String(body.maxPagesPerDoc ?? ''),
    used: String(sum.used),
    vlmUsed: String(sum.vlmUsed),
    reserved: String(sum.reserved),
    remaining: String(remaining),
    tenants: tenants.map((t) => ({
      tenantKey: String(t.tenantKey || ''),
      used: String(t.used ?? 0),
      vlmUsed: String(t.vlmUsed ?? 0),
      reserved: String(t.reserved ?? 0),
    })),
    title: ingestionLabel('budget.title', locale, { month: body.month || '' }),
  };
}

function buildTierPutBody(docType, minTier, maxTier) {
  return {
    docType: String(docType),
    minTier: minTier === '' || minTier == null ? null : String(minTier),
    maxTier: maxTier === '' || maxTier == null ? null : String(maxTier),
  };
}

function mapIngestionError(result, locale, context) {
  const status = result && result.status;
  const body = (result && result.body) || {};
  const err = body && body.error;
  if (result && result.thrown) {
    return { key: 'error.network', message: resolveSharedLabel('error.network', locale) };
  }
  if (status === 401 || (status === 403 && err === 'Admin access required')) {
    return { key: 'error.signIn', message: resolveSharedLabel('error.signIn', locale, { appUrl: '{appUrl}' }) };
  }
  if (status === 403 && err === 'Forbidden') {
    return { key: 'error.workspace', message: ingestionLabel('error.workspace', locale) };
  }
  if (status === 503) {
    const key = context === 'budget' ? 'budget.unavailable' : context === 'tiers' ? 'tiers.unavailable' : 'error.unavailable';
    return { key, message: ingestionLabel(key, locale) || resolveSharedLabel('error.unavailable', locale) };
  }
  if (status === 404 && err === 'Job not found') {
    return { key: 'error.notFound', message: resolveSharedLabel('error.notFound', locale) };
  }
  if (status === 409 && err === 'not_retryable') {
    return { key: 'error.notRetryable', message: resolveSharedLabel('error.notRetryable', locale) };
  }
  if (status === 409 && err === 'not_deletable') {
    return { key: 'error.notDeletable', message: ingestionLabel('error.notDeletable', locale) };
  }
  if (status === 400 && body.details && body.details[0]) {
    const msg = body.details[0].message || '';
    if (msg === 'Cursor is too far back') {
      return { key: 'error.cursorTooFar', message: ingestionLabel('error.cursorTooFar', locale) };
    }
    if (msg === 'Cursor is not valid') {
      return { key: 'error.cursorReset', message: ingestionLabel('error.cursorReset', locale), reloadList: true };
    }
    if (body.details[0].path === 'minTier') {
      return { key: 'tiers.server', message: msg, rowLevel: true };
    }
    return { key: 'error.invalid', message: ingestionLabel('error.invalid', locale, { detail: msg }) };
  }
  if (status === 400) {
    const detail = body.details && body.details[0] && body.details[0].message;
    return { key: 'error.invalid', message: ingestionLabel('error.invalid', locale, { detail: detail || err || '' }) };
  }
  return { key: 'error.generic', message: resolveSharedLabel('error.generic', locale, { status: status || '?' }) };
}

class IngestionPanel {
  constructor(root) {
    this.root = root;
    this.locale = detectUiLocale();
    this.mounted = false;
    this.organizationId = null;
    this.jobs = [];
    this.openJobId = null;
    this.listController = null;
    this.filters = { status: 'all', kind: 'all' };
  }

  refresh() {
    this.loadJobs();
    this.loadBudget();
  }

  mount() {
    if (this.mounted) {
      this.refresh();
      return;
    }
    this.mounted = true;
    this.root.setAttribute('lang', this.locale);
    this.ensureChrome();
    this.bindWorkspace();
    this.bindTabs();
    this.bindFilters();
    const settingsHost = this.root.querySelector('[data-ingestion-settings-host]');
    const settingsBlock = document.getElementById('rag-ingestion-settings');
    if (settingsHost && settingsBlock) settingsHost.appendChild(settingsBlock);
    this.applySettingsI18n();
    this.refresh();
  }

  ensureChrome() {
    if (this.root.querySelector('[data-ingestion-mounted]')) return;
    const title = this.root.querySelector('[data-ingestion-title]');
    if (title) title.textContent = ingestionLabel('panel.title', this.locale);
    const desc = this.root.querySelector('[data-ingestion-description]');
    if (desc) desc.textContent = ingestionLabel('panel.description', this.locale);
    this.root.setAttribute('data-ingestion-mounted', '1');
  }

  bindWorkspace() {
    const selector = document.getElementById('workspace-selector');
    if (!selector) return;
    this.organizationId = selector.value || null;
    selector.addEventListener('change', () => {
      this.organizationId = selector.value || null;
      this.openJobId = null;
      this.refresh();
    });
  }

  bindTabs() {
    this.root.querySelectorAll('[data-ingestion-tab]').forEach((btn) => {
      btn.addEventListener('click', () => this.selectTab(btn.getAttribute('data-ingestion-tab')));
    });
  }

  selectTab(name) {
    this.root.querySelectorAll('[data-ingestion-tab]').forEach((btn) => {
      const active = btn.getAttribute('data-ingestion-tab') === name;
      btn.classList.toggle('tab-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    this.root.querySelectorAll('[data-ingestion-panel]').forEach((panel) => {
      const show = panel.getAttribute('data-ingestion-panel') === name;
      panel.hidden = !show;
    });
  }

  bindFilters() {
    this.root.querySelectorAll('input[name="ingestion-status"]').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.checked) {
          this.filters.status = input.value;
          this.loadJobs();
        }
      });
    });
    const kind = this.root.querySelector('[data-ingestion-kind]');
    if (kind) {
      kind.addEventListener('change', () => {
        this.filters.kind = kind.value;
        this.loadJobs();
      });
    }
    this.root.querySelector('[data-ingestion-refresh-jobs]')?.addEventListener('click', () => this.loadJobs());
    this.root.querySelector('[data-ingestion-refresh-budget]')?.addEventListener('click', () => this.loadBudget());
  }

  orgQuery() {
    return this.organizationId ? '?organizationId=' + encodeURIComponent(this.organizationId) : '';
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

  async loadJobs() {
    if (this.listController) this.listController.abort();
    this.listController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const params = new URLSearchParams({ limit: '50' });
    if (this.organizationId) params.set('organizationId', this.organizationId);
    const statusMap = {
      failed: ['failed'],
      needs_review: ['needs_review'],
      active: ['queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding'],
      ready: ['ready'],
      other: ['quarantined', 'skipped_duplicate'],
    };
    if (this.filters.status !== 'all' && statusMap[this.filters.status]) {
      for (const s of statusMap[this.filters.status]) params.append('status', s);
    }
    if (this.filters.kind !== 'all') params.set('kind', this.filters.kind);
    const result = await this.rag('admin/ingest-jobs?' + params.toString(), {
      method: 'GET',
      signal: this.listController ? this.listController.signal : undefined,
    });
    const statusEl = this.root.querySelector('[data-ingestion-jobs-status]');
    const tbody = this.root.querySelector('[data-ingestion-jobs-tbody]');
    if (!result.ok) {
      const mapped = mapIngestionError(result, this.locale, 'jobs');
      if (mapped.key === 'error.signIn' || mapped.key === 'error.workspace') {
        this.showAuthAlert(mapped.message);
        return;
      }
      if (statusEl) statusEl.textContent = mapped.message;
      return;
    }
    this.jobs = (result.body && result.body.items) || [];
    if (tbody) {
      tbody.replaceChildren();
      const docLabel = typeof window !== 'undefined' && window.docTypeLabelForLocale ? window.docTypeLabelForLocale : () => '';
      for (const job of this.jobs) {
        const view = buildJobRowView(job, this.locale, job.doc_class ? docLabel(job.doc_class, this.locale) : '');
        const tr = document.createElement('tr');
        const fileTd = document.createElement('td');
        const fileBtn = document.createElement('button');
        fileBtn.type = 'button';
        fileBtn.className = 'btn btn-ghost btn-xs justify-start';
        fileBtn.textContent = view.filename;
        fileTd.appendChild(fileBtn);
        tr.appendChild(fileTd);
        const statusTd = document.createElement('td');
        statusTd.textContent = view.statusLabel;
        tr.appendChild(statusTd);
        const actionsTd = document.createElement('td');
        if (view.showRetry) {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'btn btn-primary btn-sm';
          retry.textContent = resolveSharedLabel('action.retry', this.locale);
          retry.addEventListener('click', () => this.retryJob(job.id, view.filename));
          actionsTd.appendChild(retry);
        }
        if (view.showDelete) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'btn btn-outline btn-error btn-sm';
          del.textContent = ingestionLabel('action.delete', this.locale);
          del.addEventListener('click', () => this.confirmDelete(job.id, view.filename));
          actionsTd.appendChild(del);
        }
        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
      }
    }
    if (statusEl) {
      const count = this.jobs.length;
      const loadedKey = count === 1 ? 'jobs.loaded' : 'jobs.loaded';
      statusEl.textContent = ingestionLabel(loadedKey, this.locale, { count });
    }
  }

  showAuthAlert(message) {
    const host = this.root.querySelector('[data-ingestion-auth]');
    if (!host) return;
    host.replaceChildren();
    const alert = document.createElement('div');
    alert.className = 'alert alert-warning text-sm';
    const p = document.createElement('p');
    p.textContent = message;
    alert.appendChild(p);
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'btn btn-sm';
    reload.textContent = ingestionLabel('error.reload', this.locale);
    reload.addEventListener('click', () => this.refresh());
    alert.appendChild(reload);
    host.appendChild(alert);
  }

  async loadBudget() {
    const result = await this.rag('admin/parse-budget' + this.orgQuery(), { method: 'GET' });
    const host = this.root.querySelector('[data-ingestion-budget]');
    if (!host) return;
    host.replaceChildren();
    if (!result.ok) {
      const mapped = mapIngestionError(result, this.locale, 'budget');
      const p = document.createElement('p');
      p.className = 'text-error text-sm';
      p.textContent = mapped.message;
      host.appendChild(p);
      return;
    }
    const view = buildBudgetView(result.body || {}, this.locale);
    const title = document.createElement('h4');
    title.className = 'text-base font-semibold';
    title.textContent = view.title;
    host.appendChild(title);
    const summary = document.createElement('p');
    summary.className = 'text-xs text-base-content/70';
    summary.textContent = ingestionLabel('budget.remaining', this.locale, { remaining: view.remaining, budget: view.budgetPages });
    host.appendChild(summary);
  }

  async retryJob(jobId, file) {
    const result = await this.rag('admin/ingest-jobs/' + encodeURIComponent(jobId) + '/retry' + this.orgQuery(), {
      method: 'POST',
      body: '{}',
    });
  const statusEl = this.root.querySelector('[data-ingestion-jobs-status]');
    if (!result.ok) {
      const mapped = mapIngestionError(result, this.locale, 'jobs');
      if (statusEl) statusEl.textContent = mapped.message;
      if (mapped.key === 'error.notFound' || mapped.key === 'error.notRetryable') this.loadJobs();
      return;
    }
    if (statusEl) statusEl.textContent = resolveSharedLabel('action.retried', this.locale, { file });
    this.loadJobs();
  }

  confirmDelete(jobId, file) {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    const box = document.createElement('div');
    box.className = 'modal-box';
    const title = document.createElement('h3');
    title.className = 'text-base font-semibold';
    title.textContent = ingestionLabel('confirm.title', this.locale);
    const body = document.createElement('p');
    body.className = 'text-sm';
    body.textContent = ingestionLabel('confirm.body', this.locale, { file });
    const actions = document.createElement('div');
    actions.className = 'modal-action';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = ingestionLabel('confirm.cancel', this.locale);
    cancel.addEventListener('click', () => dialog.close('cancel'));
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-error';
    confirm.textContent = ingestionLabel('confirm.confirm', this.locale);
    confirm.addEventListener('click', () => dialog.close('confirm'));
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(actions);
    dialog.appendChild(box);
    const backdrop = document.createElement('form');
    backdrop.method = 'dialog';
    backdrop.className = 'modal-backdrop';
    const b = document.createElement('button');
    b.type = 'submit';
    b.textContent = 'close';
    backdrop.appendChild(b);
    dialog.appendChild(backdrop);
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.addEventListener('close', async () => {
      dialog.remove();
      if (dialog.returnValue !== 'confirm') return;
      await this.deleteJob(jobId, file);
    }, { once: true });
  }

  async deleteJob(jobId, file) {
    const result = await this.rag('admin/ingest-jobs/' + encodeURIComponent(jobId) + this.orgQuery(), { method: 'DELETE' });
    const statusEl = this.root.querySelector('[data-ingestion-jobs-status]');
    if (!result.ok) {
      const mapped = mapIngestionError(result, this.locale, 'jobs');
      if (statusEl) statusEl.textContent = mapped.message;
      if (mapped.key === 'error.notDeletable' || mapped.key === 'error.notFound') this.loadJobs();
      return;
    }
    if (statusEl) statusEl.textContent = ingestionLabel('action.deleted', this.locale, { file });
    this.loadJobs();
  }

  applySettingsI18n() {
    this.root.querySelectorAll('[data-ingestion-i18n]').forEach((el) => {
      const key = el.getAttribute('data-ingestion-i18n');
      if (key) el.textContent = ingestionLabel(key, this.locale);
    });
  }
}

let ingestionPanelInstance = null;

function initIngestionPanel() {
  const root = document.getElementById('rag-administration-ingestion');
  if (!root) return;
  if (!ingestionPanelInstance) {
    ingestionPanelInstance = new IngestionPanel(root);
    ingestionPanelInstance.mount();
    window.ingestionPanel = ingestionPanelInstance;
  } else {
    ingestionPanelInstance.refresh();
  }
}

if (typeof window !== 'undefined') {
  window.initIngestionPanel = initIngestionPanel;
  window.ingestionLabel = ingestionLabel;
  window.buildJobRowView = buildJobRowView;
  window.buildJobDetailView = buildJobDetailView;
  window.buildBudgetView = buildBudgetView;
  window.buildTierPutBody = buildTierPutBody;
  window.mapIngestionError = mapIngestionError;
  document.addEventListener('DOMContentLoaded', () => {
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initIngestionPanel();
  });
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((tab) => {
    tab.addEventListener('click', () => initIngestionPanel());
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    INGESTION_LABELS,
    ingestionLabel,
    buildJobRowView,
    buildJobDetailView,
    buildBudgetView,
    buildTierPutBody,
    mapIngestionError,
    initIngestionPanel,
    IngestionPanel,
  };
}
