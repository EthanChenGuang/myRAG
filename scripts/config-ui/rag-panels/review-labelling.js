/**
 * Review queue panel (Phase 5.1.1, UI-SPEC 6.6): domain experts work the cases the weekly mining found. Reads and writes go
 * through ragFetch with the expert's own session; the routes and RLS decide what is visible, so the panel sends no workspace.
 * Every server and document string is inserted with textContent, never as markup. The helpers here are shared with
 * review-admin.js.
 */

let reviewLabellingSharedIngestLabel = null;
if (typeof require !== 'undefined') {
  try {
    reviewLabellingSharedIngestLabel = require('../document-processing/status-monitor.js').ingestLabel;
  } catch {
    reviewLabellingSharedIngestLabel = null;
  }
}

const REVIEW_LABELLING_LABELS = {
  en: {
    'panel.title': "Review queue",
    'panel.description': "Questions the knowledge base answered badly or refused, found by weekly mining. Open a case, quote the passage that answers it, write the expected answer and choose what the case is used for. You see only the workspaces you were granted.",
    'list.loading': "Loading cases…",
    'list.loaded': "Cases shown: {count}",
    'list.caption': "Review cases",
    'list.unavailable': "The review queue is unavailable right now. Select Reload panel in a moment.",
    'action.refresh': "Refresh queue",
    'action.loadMore': "Load more cases",
    'action.reload': "Reload panel",
    'action.resetFilters': "Reset filters",
    'action.open': "Open case: {question}",
    'filter.status': "Status",
    'filter.reason': "Reason",
    'filter.language': "Question language",
    'filter.all': "All",
    'col.question': "Question",
    'col.reasons': "Why it is here",
    'col.language': "Language",
    'col.outcome': "What the user got",
    'col.status': "Status",
    'col.mined': "Found",
    occurrences: "Asked: {count}",
    'status.open': "Open",
    'status.labelled': "Labelled",
    'status.skipped': "Skipped",
    'status.exported': "Exported",
    'status.unknown': "Status {code}",
    'reason.feedback_negative': "Marked not helpful",
    'reason.refusal_disputed': "Refusal disputed",
    'reason.groundedness_flagged': "Possibly unreliable answer",
    'reason.refused_high_score': "Refused despite a close match",
    'reason.zero_results': "Nothing retrieved",
    'reason.low_score': "Weak matches only",
    'reason.no_source_opened': "No source opened",
    'reason.none': "No reason recorded",
    'reason.unknown': "Reason code {code}",
    'outcome.answered': "Answered",
    'outcome.refused_no_context': "Refused: not in the documents",
    'outcome.kb_unavailable': "Knowledge base unavailable",
    'outcome.degraded_answer': "Answered without the knowledge base",
    'outcome.unknown': "Not recorded",
    'channel.chat': "Web chat",
    'channel.embed': "Embedded widget",
    'channel.voice': "Voice",
    'lang.zh': "Chinese",
    'lang.en': "English",
    'lang.it': "Italian",
    'lang.und': "Not determined",
    'empty.title': "No cases to review",
    'empty.body': "New cases arrive after the weekly mining run. If you expected some, ask an operator whether mining has run and whether you were granted this workspace.",
    'empty.filtered': "No case matches these filters.",
    'off.title': "Expert review is switched off",
    'off.body': "An operator switches it on under {tab}, {card}.",
    'signin.expert': "Domain experts sign in to the main app with their own account. No admin role is needed for this panel.",
    'error.gone': "This case is no longer in your queue. The list has been refreshed.",
    'error.invalid': "The server did not accept this: {detail}",
    'error.outcomeUnknown': "No answer from the server. The label may or may not be saved; the case has been reloaded.",
    'action.back': "Back to queue",
    'item.loading': "Loading case…",
    'item.question': "Question (personal data masked)",
    'item.answer': "Answer the user received (masked)",
    'item.noAnswer': "No answer text is kept for this case.",
    'meta.channel': "Asked in",
    'meta.mined': "Found",
    'meta.queryLanguage': "Question language",
    'meta.answerLanguage': "Answer language",
    'meta.chunkLanguages': "Passage languages",
    'meta.workspace': "Workspace",
    'meta.tags': "Tags",
    'passages.heading': "Retrieved passages",
    'passages.loading': "Loading passages…",
    'passages.none': "Nothing was retrieved for this question. Search the documents below to find the passage that answers it.",
    'passages.unavailable': "The passages could not be loaded.",
    'action.reloadPassages': "Reload passages",
    'action.showMorePassages': "Show more passages: {count}",
    'passage.title': "Passage {rank}: {document}",
    'passage.section': "Section: {section}",
    'passage.similarity': "Similarity: {score}",
    'passage.rerank': "Rerank score: {score}",
    'passage.kept': "Used for the answer",
    'passage.notKept': "Retrieved, not used",
    'passage.gone': "This passage is no longer available. Its document was updated, removed or quarantined.",
    'passage.textAria': "Text of passage {rank}",
    'passage.selectHint': "Select the words that answer the question, then select Add evidence quote.",
    'passage.notRelevant': "Not relevant to the question",
    'passage.notRelevantAria': "Passage {rank} is not relevant to the question",
    'passage.notRelevantLocked': "A passage you quote can’t be marked not relevant.",
    'action.addQuote': "Add evidence quote",
    'action.addQuoteAria': "Add evidence quote from {source}",
    'search.heading': "Search the documents",
    'search.label': "Words to look for in this workspace’s documents",
    'search.placeholder': "For example, a term from the question…",
    'action.search': "Search documents",
    'search.running': "Searching…",
    'search.results': "Search results: {count}",
    'search.resultTitle': "Result {rank}: {document}",
    'search.empty': "No passage matched. Try other words, or tick Knowledge-base gap if the documents don’t cover this.",
    'search.unavailable': "Search is unavailable for this workspace right now. Try again in a moment.",
    'search.tooLong': "Use 500 characters or fewer.",
    'search.note': "Searches are not recorded.",
    'answerable.heading': "Answer",
    'answerable.legend': "Can the documents answer this question?",
    'answerable.yes': "Yes",
    'answerable.no': "No",
    'answerable.required': "Choose Yes or No.",
    'expected.label': "Expected answer",
    'expected.help': "The answer a correct system should give, in the question’s language, using only what the quoted passages say.",
    'expected.required': "Write the expected answer.",
    'evidence.heading': "Evidence quotes",
    'evidence.empty': "No quote yet. Select text in a passage, then select Add evidence quote.",
    'evidence.required': "Add at least one evidence quote.",
    'evidence.notSent': "Quotes are not saved for a question the documents can’t answer.",
    'evidence.max': "A label holds at most 20 quotes.",
    'quote.caption': "Quote {n} from {source}: {document}",
    'quote.textLabel': "Text of quote {n}",
    'quote.ok': "Found word for word in the passage.",
    'quote.notFound': "This text is not in the passage word for word. Select it again or correct it.",
    'quote.tooShort': "A quote needs at least 2 characters.",
    'quote.server.quote_not_found': "The server did not find this text in the passage. The passage may have changed; reload the passages and select it again.",
    'quote.server.gone': "This passage can no longer be quoted. Remove the quote and choose another passage.",
    'quote.server.other': "The server rejected this quote ({code}).",
    'action.showPassage': "Show passage",
    'action.removeQuote': "Remove quote",
    'action.removeQuoteAria': "Remove quote {n}",
    'type.heading': "Question type",
    'category.label': "Category",
    'language.label': "Language of the question",
    'language.choose': "Choose a language",
    'language.required': "Choose the language of the question.",
    'outputs.heading': "Use this case for",
    'triage.dictionary': "Dictionary terms",
    'triage.dictionary.help': "The user’s word and the documents’ word differ.",
    'triage.training': "Training pair",
    'triage.training.help': "The quoted passage should rank first for this question.",
    'triage.golden': "Test set",
    'triage.golden.help': "Keep this question as a permanent test of the system.",
    'triage.kb_gap': "Knowledge-base gap",
    'triage.kb_gap.help': "The documents don’t cover this.",
    'triage.not_a_failure': "Not a failure",
    'triage.not_a_failure.help': "The system behaved correctly.",
    'triage.noneHint': "Nothing is ticked: the label is saved, and the case produces no output.",
    'triage.trainingNeedsQuote': "A training pair needs at least one evidence quote.",
    'dict.heading': "Term pairs",
    'dict.observed': "Word the user used",
    'dict.canonical': "Word the documents use",
    'dict.relation': "Relation",
    'dict.required': "Fill both words of each term pair, or remove the pair.",
    'relation.synonym': "Synonym",
    'relation.abbreviation': "Abbreviation",
    'relation.translation': "Translation",
    'relation.misspelling': "Misspelling",
    'action.addTerm': "Add term pair",
    'action.removeTerm': "Remove term pair",
    'action.removeTermAria': "Remove term pair {n}",
    'pii.heading': "Personal data check",
    'pii.intro': "Test-set questions are kept permanently. Read the question once more and look for:",
    'pii.item.names': "Names of people",
    'pii.item.addresses': "Addresses",
    'pii.item.accounts': "Account, card or ID numbers",
    'pii.item.health': "Health details",
    'pii.confirm': "The question contains none of these",
    'pii.rewrite.label': "Rewritten question (when it contains one of these, or you are not sure)",
    'pii.rewrite.help': "Ask the same thing in your own words, without the personal details. Saving a rewritten question confirms that you checked it.",
    'pii.rewrite.left': "Characters left: {count}",
    'pii.required': "Tick the personal data check or write a rewritten question before saving a test-set case.",
    'dup.summary': "Near-duplicate confirmation",
    'dup.label': "Confirmed near-duplicate of (item ID)",
    'dup.help': "Fill this only when the promotion command reported a near-duplicate and both questions should stay in the test set. Paste the ID it named.",
    'action.save': "Save label",
    'action.saving': "Saving…",
    'action.skip': "Skip case",
    'action.skipping': "Skipping…",
    'save.blocked': "Fix the marked fields before saving.",
    'saved.next': "Label saved. Next case opened.",
    'saved.last': "Label saved. No more cases in this view.",
    'skipped.next': "Case skipped. Next case opened.",
    'skipped.last': "Case skipped. No more cases in this view.",
    'exported.notice': "This case was exported to the test set. Its label can no longer be changed.",
    'discard.title': "Discard changes to this label?",
    'discard.body': "Your changes to this case have not been saved.",
    'discard.keep': "Keep editing",
    'discard.confirm': "Discard changes",
    'category.general': "General question",
    'category.multi_turn': "Follow-up in a conversation",
    'category.compound': "Several questions in one",
    'category.exact_term': "Exact term, code or number",
    'category.table': "Answer in a table",
    'category.scanned': "Answer in a scanned page",
    'category.no_answer': "No answer in the documents",
    'category.colloquial': "Colloquial wording",
    'category.ambiguous': "Ambiguous question",
    'category.typo': "Typing mistakes",
    'category.cross_lingual': "Question and documents in different languages",
    'category.selective_filter': "Limited to certain documents",
    'category.injection': "Instruction hidden in the question or a document",
    'category.injection_evasive': "Hidden instruction, disguised",
    'category.cache_paraphrase': "Same question, reworded",
    'category.cache_near_miss': "Looks alike, asks something else",
    'category.small_talk': "Small talk",
    'triage.required': "Choose at least one use for this case.",
    'category.mismatch': "Choose “No answer in the documents” or “Small talk” only when the documents can’t answer the question, and another category otherwise.",
    'dict.canonicalLanguage': "Language of the documents’ word",
    'dict.languageRequired': "Choose the language of the documents’ word for a translation.",
    'dup.invalid': "Paste the item ID exactly as the promotion command printed it.",
    'quote.duplicate': "This quote is already in the label.",
    'search.hint': "Search when the retrieved passages don’t hold the answer.",
    'error.notRelevant': "A passage marked not relevant is not part of this case any more. Reload the case and mark it again.",
    'quote.unchecked': "Saved earlier. The server checks this quote again when you save.",
    'item.noQuestion': "No question text is kept for this case.",
  },
  zh: {
    'panel.title': "复核队列",
    'panel.description': "每周挖掘找出的、知识库答得不好或拒答的问题。打开一个案例，摘录能回答它的原文，写出期望答案，并选择这个案例的用途。你只能看到已授权给你的工作区。",
    'list.loading': "正在加载案例…",
    'list.loaded': "已显示案例：{count}",
    'list.caption': "复核案例",
    'list.unavailable': "复核队列暂时不可用。请稍后选择“重新加载面板”。",
    'action.refresh': "刷新队列",
    'action.loadMore': "加载更多案例",
    'action.reload': "重新加载面板",
    'action.resetFilters': "重置筛选",
    'action.open': "打开案例：{question}",
    'filter.status': "状态",
    'filter.reason': "原因",
    'filter.language': "提问语言",
    'filter.all': "全部",
    'col.question': "问题",
    'col.reasons': "入选原因",
    'col.language': "语言",
    'col.outcome': "用户得到的结果",
    'col.status': "状态",
    'col.mined': "发现时间",
    occurrences: "提问次数：{count}",
    'status.open': "待处理",
    'status.labelled': "已标注",
    'status.skipped': "已跳过",
    'status.exported': "已导出",
    'status.unknown': "状态 {code}",
    'reason.feedback_negative': "被标记为没有帮助",
    'reason.refusal_disputed': "拒答被质疑",
    'reason.groundedness_flagged': "回答可能不可靠",
    'reason.refused_high_score': "有接近的匹配却拒答",
    'reason.zero_results': "未检索到内容",
    'reason.low_score': "只有弱匹配",
    'reason.no_source_opened': "未打开任何来源",
    'reason.none': "未记录原因",
    'reason.unknown': "原因代码 {code}",
    'outcome.answered': "已回答",
    'outcome.refused_no_context': "拒答：文档中没有",
    'outcome.kb_unavailable': "知识库不可用",
    'outcome.degraded_answer': "未使用知识库作答",
    'outcome.unknown': "未记录",
    'channel.chat': "网页聊天",
    'channel.embed': "嵌入式窗口",
    'channel.voice': "语音",
    'lang.zh': "中文",
    'lang.en': "英文",
    'lang.it': "意大利文",
    'lang.und': "未确定",
    'empty.title': "没有待复核的案例",
    'empty.body': "每周挖掘运行后会出现新案例。如果你认为应该有案例，请向运维人员确认挖掘是否已运行，以及是否已为你授权该工作区。",
    'empty.filtered': "没有符合这些筛选条件的案例。",
    'off.title': "专家复核已关闭",
    'off.body': "由运维人员在 {tab} 的 {card} 中开启。",
    'signin.expert': "领域专家用自己的账号登录主应用即可，此面板不需要管理员身份。",
    'error.gone': "此案例已不在你的队列中，列表已刷新。",
    'error.invalid': "服务器未接受此内容：{detail}",
    'error.outcomeUnknown': "服务器没有响应。标注可能已保存，也可能没有；案例已重新加载。",
    'action.back': "返回队列",
    'item.loading': "正在加载案例…",
    'item.question': "问题（个人信息已遮盖）",
    'item.answer': "用户收到的回答（已遮盖）",
    'item.noAnswer': "此案例未保留回答文本。",
    'meta.channel': "来源渠道",
    'meta.mined': "发现时间",
    'meta.queryLanguage': "提问语言",
    'meta.answerLanguage': "回答语言",
    'meta.chunkLanguages': "片段语言",
    'meta.workspace': "工作区",
    'meta.tags': "标签",
    'passages.heading': "检索到的片段",
    'passages.loading': "正在加载片段…",
    'passages.none': "这个问题没有检索到任何内容。请在下方搜索文档，找出能回答它的片段。",
    'passages.unavailable': "片段未能加载。",
    'action.reloadPassages': "重新加载片段",
    'action.showMorePassages': "显示更多片段：{count}",
    'passage.title': "片段 {rank}：{document}",
    'passage.section': "章节：{section}",
    'passage.similarity': "相似度：{score}",
    'passage.rerank': "重排得分：{score}",
    'passage.kept': "已用于回答",
    'passage.notKept': "已检索，未使用",
    'passage.gone': "此片段已不可用：所属文档已更新、删除或被隔离。",
    'passage.textAria': "片段 {rank} 的文本",
    'passage.selectHint': "选中能回答问题的文字，然后选择“添加证据摘录”。",
    'passage.notRelevant': "与问题无关",
    'passage.notRelevantAria': "片段 {rank} 与问题无关",
    'passage.notRelevantLocked': "已摘录的片段不能标为无关。",
    'action.addQuote': "添加证据摘录",
    'action.addQuoteAria': "从{source}添加证据摘录",
    'search.heading': "搜索文档",
    'search.label': "要在此工作区文档中查找的内容",
    'search.placeholder': "例如：问题里的某个词…",
    'action.search': "搜索文档",
    'search.running': "正在搜索…",
    'search.results': "搜索结果：{count}",
    'search.resultTitle': "结果 {rank}：{document}",
    'search.empty': "没有匹配的片段。换些词再试；如果文档确实没有涵盖，请勾选“知识库缺口”。",
    'search.unavailable': "此工作区的搜索暂时不可用，请稍后再试。",
    'search.tooLong': "请不要超过 500 个字符。",
    'search.note': "搜索不会被记录。",
    'answerable.heading': "答案",
    'answerable.legend': "文档能回答这个问题吗？",
    'answerable.yes': "能",
    'answerable.no': "不能",
    'answerable.required': "请选择“能”或“不能”。",
    'expected.label': "期望答案",
    'expected.help': "正确的系统应给出的答案：用提问的语言，只依据摘录片段的内容。",
    'expected.required': "请填写期望答案。",
    'evidence.heading': "证据摘录",
    'evidence.empty': "还没有摘录。在片段中选中文字，然后选择“添加证据摘录”。",
    'evidence.required': "请至少添加一条证据摘录。",
    'evidence.notSent': "文档无法回答的问题不会保存摘录。",
    'evidence.max': "一条标注最多 20 条摘录。",
    'quote.caption': "摘录 {n}，来自{source}：{document}",
    'quote.textLabel': "摘录 {n} 的文字",
    'quote.ok': "与片段原文逐字一致。",
    'quote.notFound': "这段文字与片段原文不完全一致。请重新选取或更正。",
    'quote.tooShort': "摘录至少需要 2 个字符。",
    'quote.server.quote_not_found': "服务器在片段中没有找到这段文字。片段可能已变更，请重新加载片段后再选取。",
    'quote.server.gone': "此片段已不能摘录。请移除这条摘录并选择其他片段。",
    'quote.server.other': "服务器拒绝了这条摘录（{code}）。",
    'action.showPassage': "查看片段",
    'action.removeQuote': "移除摘录",
    'action.removeQuoteAria': "移除摘录 {n}",
    'type.heading': "问题类型",
    'category.label': "类别",
    'language.label': "问题的语言",
    'language.choose': "选择语言",
    'language.required': "请选择问题的语言。",
    'outputs.heading': "此案例用于",
    'triage.dictionary': "术语词典",
    'triage.dictionary.help': "用户的用词与文档的用词不同。",
    'triage.training': "训练样本",
    'triage.training.help': "对这个问题，摘录所在片段应排在最前。",
    'triage.golden': "测试集",
    'triage.golden.help': "把这个问题作为系统的长期测试题。",
    'triage.kb_gap': "知识库缺口",
    'triage.kb_gap.help': "文档没有涵盖这个内容。",
    'triage.not_a_failure': "并非失败",
    'triage.not_a_failure.help': "系统的表现是正确的。",
    'triage.noneHint': "未勾选任何用途：标注会保存，但此案例不产生任何输出。",
    'triage.trainingNeedsQuote': "训练样本至少需要一条证据摘录。",
    'dict.heading': "术语对",
    'dict.observed': "用户的用词",
    'dict.canonical': "文档的用词",
    'dict.relation': "关系",
    'dict.required': "请填写每个术语对的两个词，或移除该术语对。",
    'relation.synonym': "同义词",
    'relation.abbreviation': "缩写",
    'relation.translation': "翻译",
    'relation.misspelling': "拼写错误",
    'action.addTerm': "添加术语对",
    'action.removeTerm': "移除术语对",
    'action.removeTermAria': "移除术语对 {n}",
    'pii.heading': "个人信息检查",
    'pii.intro': "测试集中的问题会被长期保留。请再读一遍问题，留意是否含有：",
    'pii.item.names': "人名",
    'pii.item.addresses': "地址",
    'pii.item.accounts': "账号、卡号或证件号",
    'pii.item.health': "健康信息",
    'pii.confirm': "问题不含以上任何信息",
    'pii.rewrite.label': "改写后的问题（如果含有以上信息，或你不确定）",
    'pii.rewrite.help': "用你自己的话问同一件事，去掉个人信息。保存改写后的问题即表示你已检查过它。",
    'pii.rewrite.left': "剩余字符：{count}",
    'pii.required': "保存测试集案例前，请勾选个人信息检查，或填写改写后的问题。",
    'dup.summary': "近似重复确认",
    'dup.label': "确认为以下条目的近似重复（条目 ID）",
    'dup.help': "仅当晋升命令报告了近似重复、且两个问题都应保留在测试集中时填写。粘贴它给出的 ID。",
    'action.save': "保存标注",
    'action.saving': "正在保存…",
    'action.skip': "跳过案例",
    'action.skipping': "正在跳过…",
    'save.blocked': "保存前请先修正标出的字段。",
    'saved.next': "标注已保存，已打开下一个案例。",
    'saved.last': "标注已保存。此视图中没有更多案例。",
    'skipped.next': "已跳过，已打开下一个案例。",
    'skipped.last': "已跳过。此视图中没有更多案例。",
    'exported.notice': "此案例已导出到测试集，标注不能再修改。",
    'discard.title': "放弃对这条标注的更改？",
    'discard.body': "你对此案例的更改尚未保存。",
    'discard.keep': "继续编辑",
    'discard.confirm': "放弃更改",
    'category.general': "一般问题",
    'category.multi_turn': "多轮对话中的追问",
    'category.compound': "一次问多件事",
    'category.exact_term': "精确术语、编号或数字",
    'category.table': "答案在表格中",
    'category.scanned': "答案在扫描页中",
    'category.no_answer': "文档中没有答案",
    'category.colloquial': "口语化表达",
    'category.ambiguous': "有歧义的问题",
    'category.typo': "有错别字",
    'category.cross_lingual': "提问语言与文档语言不同",
    'category.selective_filter': "限定在部分文档内",
    'category.injection': "问题或文档中夹带指令",
    'category.injection_evasive': "经过伪装的夹带指令",
    'category.cache_paraphrase': "同一问题的不同说法",
    'category.cache_near_miss': "看似相同、实则不同的问题",
    'category.small_talk': "闲聊",
    'triage.required': "请至少为此案例选择一种用途。",
    'category.mismatch': "仅当文档无法回答该问题时，才选择“文档中没有答案”或“闲聊”；否则请选择其他类别。",
    'dict.canonicalLanguage': "文档用词的语言",
    'dict.languageRequired': "翻译关系需要选择文档用词的语言。",
    'dup.invalid': "请按晋升命令输出的原样粘贴条目 ID。",
    'quote.duplicate': "这条摘录已在标注中。",
    'search.hint': "当检索到的片段中没有答案时，请搜索文档。",
    'error.notRelevant': "标为无关的片段已不属于此案例。请重新加载案例后再标记。",
    'quote.unchecked': "此前已保存。保存时服务器会再次核对这条摘录。",
    'item.noQuestion': "此案例未保留问题文本。",
  },
  it: {
    'panel.title': "Coda di revisione",
    'panel.description': "Domande a cui la knowledge base ha risposto male o che ha rifiutato, trovate dall’estrazione settimanale. Apri un caso, cita il passaggio che risponde, scrivi la risposta attesa e scegli a cosa serve il caso. Vedi solo gli spazi di lavoro per cui hai l’accesso.",
    'list.loading': "Caricamento dei casi…",
    'list.loaded': "Casi mostrati: {count}",
    'list.caption': "Casi da rivedere",
    'list.unavailable': "La coda di revisione non è disponibile in questo momento. Seleziona Ricarica pannello tra poco.",
    'action.refresh': "Aggiorna coda",
    'action.loadMore': "Carica altri casi",
    'action.reload': "Ricarica pannello",
    'action.resetFilters': "Reimposta filtri",
    'action.open': "Apri caso: {question}",
    'filter.status': "Stato",
    'filter.reason': "Motivo",
    'filter.language': "Lingua della domanda",
    'filter.all': "Tutti",
    'col.question': "Domanda",
    'col.reasons': "Perché è qui",
    'col.language': "Lingua",
    'col.outcome': "Cosa ha ricevuto l’utente",
    'col.status': "Stato",
    'col.mined': "Trovato",
    occurrences: "Volte chiesta: {count}",
    'status.open': "Aperto",
    'status.labelled': "Etichettato",
    'status.skipped': "Saltato",
    'status.exported': "Esportato",
    'status.unknown': "Stato {code}",
    'reason.feedback_negative': "Segnata come non utile",
    'reason.refusal_disputed': "Rifiuto contestato",
    'reason.groundedness_flagged': "Risposta forse inaffidabile",
    'reason.refused_high_score': "Rifiutata nonostante una corrispondenza vicina",
    'reason.zero_results': "Nessun risultato recuperato",
    'reason.low_score': "Solo corrispondenze deboli",
    'reason.no_source_opened': "Nessuna fonte aperta",
    'reason.none': "Nessun motivo registrato",
    'reason.unknown': "Codice motivo {code}",
    'outcome.answered': "Risposta data",
    'outcome.refused_no_context': "Rifiutata: non nei documenti",
    'outcome.kb_unavailable': "Knowledge base non disponibile",
    'outcome.degraded_answer': "Risposta senza knowledge base",
    'outcome.unknown': "Non registrato",
    'channel.chat': "Chat web",
    'channel.embed': "Widget incorporato",
    'channel.voice': "Voce",
    'lang.zh': "Cinese",
    'lang.en': "Inglese",
    'lang.it': "Italiano",
    'lang.und': "Non determinata",
    'empty.title': "Nessun caso da rivedere",
    'empty.body': "I nuovi casi arrivano dopo l’estrazione settimanale. Se ne aspettavi, chiedi a un operatore se l’estrazione è stata eseguita e se hai l’accesso a questo spazio di lavoro.",
    'empty.filtered': "Nessun caso corrisponde a questi filtri.",
    'off.title': "La revisione degli esperti è disattivata",
    'off.body': "Un operatore la attiva in {tab}, {card}.",
    'signin.expert': "Gli esperti di dominio accedono all’app principale con il proprio account. Per questo pannello non serve il ruolo di amministratore.",
    'error.gone': "Questo caso non è più nella tua coda. L’elenco è stato aggiornato.",
    'error.invalid': "Il server non ha accettato questi dati: {detail}",
    'error.outcomeUnknown': "Nessuna risposta dal server. L’etichetta potrebbe essere stata salvata oppure no; il caso è stato ricaricato.",
    'action.back': "Torna alla coda",
    'item.loading': "Caricamento del caso…",
    'item.question': "Domanda (dati personali mascherati)",
    'item.answer': "Risposta ricevuta dall’utente (mascherata)",
    'item.noAnswer': "Per questo caso non è conservato il testo della risposta.",
    'meta.channel': "Canale",
    'meta.mined': "Trovato",
    'meta.queryLanguage': "Lingua della domanda",
    'meta.answerLanguage': "Lingua della risposta",
    'meta.chunkLanguages': "Lingue dei passaggi",
    'meta.workspace': "Spazio di lavoro",
    'meta.tags': "Tag",
    'passages.heading': "Passaggi recuperati",
    'passages.loading': "Caricamento dei passaggi…",
    'passages.none': "Per questa domanda non è stato recuperato nulla. Cerca nei documenti qui sotto il passaggio che risponde.",
    'passages.unavailable': "Non è stato possibile caricare i passaggi.",
    'action.reloadPassages': "Ricarica passaggi",
    'action.showMorePassages': "Mostra altri passaggi: {count}",
    'passage.title': "Passaggio {rank}: {document}",
    'passage.section': "Sezione: {section}",
    'passage.similarity': "Somiglianza: {score}",
    'passage.rerank': "Punteggio di riordino: {score}",
    'passage.kept': "Usato per la risposta",
    'passage.notKept': "Recuperato, non usato",
    'passage.gone': "Questo passaggio non è più disponibile. Il documento è stato aggiornato, rimosso o messo in quarantena.",
    'passage.textAria': "Testo del passaggio {rank}",
    'passage.selectHint': "Seleziona le parole che rispondono alla domanda, poi Aggiungi citazione di prova.",
    'passage.notRelevant': "Non pertinente alla domanda",
    'passage.notRelevantAria': "Il passaggio {rank} non è pertinente alla domanda",
    'passage.notRelevantLocked': "Un passaggio citato non può essere segnato come non pertinente.",
    'action.addQuote': "Aggiungi citazione di prova",
    'action.addQuoteAria': "Aggiungi citazione di prova da {source}",
    'search.heading': "Cerca nei documenti",
    'search.label': "Parole da cercare nei documenti di questo spazio di lavoro",
    'search.placeholder': "Ad esempio, un termine della domanda…",
    'action.search': "Cerca nei documenti",
    'search.running': "Ricerca…",
    'search.results': "Risultati: {count}",
    'search.resultTitle': "Risultato {rank}: {document}",
    'search.empty': "Nessun passaggio trovato. Prova altre parole, oppure spunta Lacuna nella knowledge base se i documenti non coprono l’argomento.",
    'search.unavailable': "La ricerca non è disponibile per questo spazio di lavoro in questo momento. Riprova tra poco.",
    'search.tooLong': "Usa al massimo 500 caratteri.",
    'search.note': "Le ricerche non vengono registrate.",
    'answerable.heading': "Risposta",
    'answerable.legend': "I documenti possono rispondere a questa domanda?",
    'answerable.yes': "Sì",
    'answerable.no': "No",
    'answerable.required': "Scegli Sì o No.",
    'expected.label': "Risposta attesa",
    'expected.help': "La risposta che un sistema corretto dovrebbe dare, nella lingua della domanda, usando solo ciò che dicono i passaggi citati.",
    'expected.required': "Scrivi la risposta attesa.",
    'evidence.heading': "Citazioni di prova",
    'evidence.empty': "Ancora nessuna citazione. Seleziona del testo in un passaggio, poi Aggiungi citazione di prova.",
    'evidence.required': "Aggiungi almeno una citazione di prova.",
    'evidence.notSent': "Le citazioni non vengono salvate per una domanda a cui i documenti non possono rispondere.",
    'evidence.max': "Un’etichetta contiene al massimo 20 citazioni.",
    'quote.caption': "Citazione {n} da {source}: {document}",
    'quote.textLabel': "Testo della citazione {n}",
    'quote.ok': "Presente parola per parola nel passaggio.",
    'quote.notFound': "Questo testo non è nel passaggio parola per parola. Selezionalo di nuovo o correggilo.",
    'quote.tooShort': "Una citazione richiede almeno 2 caratteri.",
    'quote.server.quote_not_found': "Il server non ha trovato questo testo nel passaggio. Il passaggio può essere cambiato: ricarica i passaggi e selezionalo di nuovo.",
    'quote.server.gone': "Questo passaggio non può più essere citato. Rimuovi la citazione e scegli un altro passaggio.",
    'quote.server.other': "Il server ha rifiutato questa citazione ({code}).",
    'action.showPassage': "Mostra passaggio",
    'action.removeQuote': "Rimuovi citazione",
    'action.removeQuoteAria': "Rimuovi citazione {n}",
    'type.heading': "Tipo di domanda",
    'category.label': "Categoria",
    'language.label': "Lingua della domanda",
    'language.choose': "Scegli una lingua",
    'language.required': "Scegli la lingua della domanda.",
    'outputs.heading': "Usa questo caso per",
    'triage.dictionary': "Termini del dizionario",
    'triage.dictionary.help': "La parola dell’utente e quella dei documenti sono diverse.",
    'triage.training': "Coppia di addestramento",
    'triage.training.help': "Il passaggio citato dovrebbe essere il primo per questa domanda.",
    'triage.golden': "Set di test",
    'triage.golden.help': "Conserva questa domanda come test permanente del sistema.",
    'triage.kb_gap': "Lacuna nella knowledge base",
    'triage.kb_gap.help': "I documenti non coprono questo argomento.",
    'triage.not_a_failure': "Non è un errore",
    'triage.not_a_failure.help': "Il sistema si è comportato correttamente.",
    'triage.noneHint': "Nessuna voce spuntata: l’etichetta viene salvata, ma il caso non produce alcun risultato.",
    'triage.trainingNeedsQuote': "Una coppia di addestramento richiede almeno una citazione di prova.",
    'dict.heading': "Coppie di termini",
    'dict.observed': "Parola usata dall’utente",
    'dict.canonical': "Parola usata nei documenti",
    'dict.relation': "Relazione",
    'dict.required': "Compila entrambe le parole di ogni coppia, oppure rimuovi la coppia.",
    'relation.synonym': "Sinonimo",
    'relation.abbreviation': "Abbreviazione",
    'relation.translation': "Traduzione",
    'relation.misspelling': "Errore di ortografia",
    'action.addTerm': "Aggiungi coppia di termini",
    'action.removeTerm': "Rimuovi coppia di termini",
    'action.removeTermAria': "Rimuovi coppia di termini {n}",
    'pii.heading': "Controllo dei dati personali",
    'pii.intro': "Le domande del set di test vengono conservate in modo permanente. Rileggi la domanda e cerca:",
    'pii.item.names': "Nomi di persone",
    'pii.item.addresses': "Indirizzi",
    'pii.item.accounts': "Numeri di conto, di carta o di documento",
    'pii.item.health': "Dati sulla salute",
    'pii.confirm': "La domanda non contiene nulla di tutto questo",
    'pii.rewrite.label': "Domanda riscritta (se contiene uno di questi dati, o se non ne hai la certezza)",
    'pii.rewrite.help': "Chiedi la stessa cosa con parole tue, senza i dati personali. Salvando una domanda riscritta confermi di averla controllata.",
    'pii.rewrite.left': "Caratteri rimasti: {count}",
    'pii.required': "Prima di salvare un caso per il set di test, spunta il controllo dei dati personali o scrivi una domanda riscritta.",
    'dup.summary': "Conferma di quasi duplicato",
    'dup.label': "Quasi duplicato confermato di (ID dell’elemento)",
    'dup.help': "Compila solo se il comando di promozione ha segnalato un quasi duplicato e le due domande devono restare nel set di test. Incolla l’ID indicato.",
    'action.save': "Salva etichetta",
    'action.saving': "Salvataggio…",
    'action.skip': "Salta caso",
    'action.skipping': "Salto…",
    'save.blocked': "Correggi i campi segnalati prima di salvare.",
    'saved.next': "Etichetta salvata. Aperto il caso successivo.",
    'saved.last': "Etichetta salvata. Nessun altro caso in questa vista.",
    'skipped.next': "Caso saltato. Aperto il caso successivo.",
    'skipped.last': "Caso saltato. Nessun altro caso in questa vista.",
    'exported.notice': "Questo caso è stato esportato nel set di test. L’etichetta non può più essere modificata.",
    'discard.title': "Scartare le modifiche a questa etichetta?",
    'discard.body': "Le modifiche a questo caso non sono state salvate.",
    'discard.keep': "Continua a modificare",
    'discard.confirm': "Scarta modifiche",
    'category.general': "Domanda generale",
    'category.multi_turn': "Domanda di seguito in una conversazione",
    'category.compound': "Più domande in una",
    'category.exact_term': "Termine, codice o numero esatto",
    'category.table': "Risposta in una tabella",
    'category.scanned': "Risposta in una pagina scansionata",
    'category.no_answer': "Nessuna risposta nei documenti",
    'category.colloquial': "Formulazione colloquiale",
    'category.ambiguous': "Domanda ambigua",
    'category.typo': "Errori di battitura",
    'category.cross_lingual': "Domanda e documenti in lingue diverse",
    'category.selective_filter': "Limitata ad alcuni documenti",
    'category.injection': "Istruzione nascosta nella domanda o in un documento",
    'category.injection_evasive': "Istruzione nascosta, camuffata",
    'category.cache_paraphrase': "Stessa domanda, riformulata",
    'category.cache_near_miss': "Simile, ma chiede altro",
    'category.small_talk': "Conversazione generica",
    'triage.required': "Scegli almeno un uso per questo caso.",
    'category.mismatch': "Scegli “Nessuna risposta nei documenti” o “Conversazione generica” solo quando i documenti non possono rispondere, altrimenti un’altra categoria.",
    'dict.canonicalLanguage': "Lingua della parola dei documenti",
    'dict.languageRequired': "Per una traduzione scegli la lingua della parola dei documenti.",
    'dup.invalid': "Incolla l’ID dell’elemento esattamente come lo ha stampato il comando di promozione.",
    'quote.duplicate': "Questa citazione è già nell’etichetta.",
    'search.hint': "Cerca quando i passaggi recuperati non contengono la risposta.",
    'error.notRelevant': "Un passaggio segnato come non pertinente non fa più parte di questo caso. Ricarica il caso e segnalo di nuovo.",
    'quote.unchecked': "Salvata in precedenza. Il server controlla di nuovo questa citazione al salvataggio.",
    'item.noQuestion': "Per questo caso non è conservato il testo della domanda.",
  },
};

const REVIEW_LABELLING_TIMEOUT_MS = 15000;
const REVIEW_LABELLING_SEARCH_TIMEOUT_MS = 30000;
const REVIEW_LABELLING_PAGE = 10;
const REVIEW_LABELLING_MAX_QUOTES = 20;
const REVIEW_LABELLING_SEARCH_MAX = 500;
const REVIEW_LABELLING_BASE = '/api/rag/review/items';
const REVIEW_LABELLING_STATUSES = ['open', 'labelled', 'skipped', 'exported'];
const REVIEW_LABELLING_REASONS = [
  'feedback_negative',
  'refusal_disputed',
  'groundedness_flagged',
  'refused_high_score',
  'zero_results',
  'low_score',
  'no_source_opened',
];
const REVIEW_LABELLING_LANGUAGES = ['zh', 'en', 'it'];
const REVIEW_LABELLING_OUTCOMES = ['answered', 'refused_no_context', 'kb_unavailable', 'degraded_answer', 'unknown'];
const REVIEW_LABELLING_CHANNELS = ['chat', 'embed', 'voice'];
const REVIEW_LABELLING_CATEGORIES = [
  'general',
  'multi_turn',
  'compound',
  'exact_term',
  'table',
  'table_split',
  'scanned',
  'no_answer',
  'colloquial',
  'ambiguous',
  'typo',
  'cross_lingual',
  'selective_filter',
  'injection',
  'injection_evasive',
  'cache_paraphrase',
  'cache_near_miss',
  'small_talk',
];
const REVIEW_LABELLING_UNANSWERABLE = new Set(['no_answer', 'small_talk']);
const REVIEW_LABELLING_TRIAGE = ['dictionary', 'training', 'golden', 'kb_gap', 'not_a_failure'];
const REVIEW_LABELLING_RELATIONS = ['synonym', 'abbreviation', 'translation', 'misspelling'];
const REVIEW_LABELLING_ITEM_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const REVIEW_LABELLING_STATUS_LOOK = {
  open: { className: 'badge-outline', icon: 'bi-inbox' },
  labelled: { className: 'badge-success badge-outline', icon: 'bi-check2' },
  skipped: { className: 'badge-ghost', icon: 'bi-skip-forward' },
  exported: { className: 'badge-info badge-outline', icon: 'bi-lock' },
};

function reviewLabellingResolveLocale(language) {
  const two = String(language || '').slice(0, 2).toLowerCase();
  return two === 'zh' || two === 'it' ? two : 'en';
}

function reviewLabellingBrowserLocale() {
  return reviewLabellingResolveLocale(typeof navigator !== 'undefined' && navigator ? navigator.language : 'en');
}

function reviewLabellingFill(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined || vars[name] === null ? match : String(vars[name])));
}

function reviewLabellingLookup(table, key, locale, vars) {
  const row = table[locale] || table.en;
  const text = row[key] !== undefined ? row[key] : table.en[key] !== undefined ? table.en[key] : key;
  return reviewLabellingFill(text, vars);
}

function reviewLabellingLabel(key, locale, vars) {
  return reviewLabellingLookup(REVIEW_LABELLING_LABELS, key, locale, vars);
}

function reviewLabellingAppUrl() {
  if (typeof window !== 'undefined' && typeof window.getConfiguredMyRAGAppUrl === 'function') {
    const url = window.getConfiguredMyRAGAppUrl();
    if (url) return url;
  }
  if (typeof window !== 'undefined' && window.location && window.location.origin) return window.location.origin;
  return 'http://localhost:3000';
}

/** error.signIn, error.network and error.generic come from the shared Config UI table, with rag-fetch.js as the fallback. */
function reviewLabellingShared(key, locale, vars) {
  const merged = { appUrl: reviewLabellingAppUrl(), ...(vars || {}) };
  let fn = null;
  if (typeof window !== 'undefined' && typeof window.ingestLabel === 'function') fn = window.ingestLabel;
  else if (typeof reviewLabellingSharedIngestLabel === 'function') fn = reviewLabellingSharedIngestLabel;
  if (fn) {
    const text = fn(key, locale, merged);
    if (text && text !== key) return text;
  }
  if (typeof window !== 'undefined' && typeof window.authMessage === 'function') {
    if (key === 'error.signIn') return window.authMessage(401, merged.appUrl);
    if (key === 'error.generic') return window.authMessage(merged.status || 0);
  }
  if (key === 'error.network') return "Can't reach the Config UI server. Check that it is running, then reload.";
  if (key === 'error.signIn') return `Admin sign-in required. Sign in to the main myRAG app at ${merged.appUrl}, then reload the Config UI.`;
  return `Request failed (${merged.status === undefined ? '' : merged.status}).`;
}

function reviewLabellingDoc() {
  return typeof document !== 'undefined' ? document : null;
}

/** Builds an element; text is set with textContent and attributes with setAttribute, never as markup. */
function reviewLabellingEl(doc, tag, options, children) {
  const el = doc.createElement(tag);
  const opts = options || {};
  if (opts.className) el.className = opts.className;
  if (opts.text !== undefined && opts.text !== null) el.textContent = String(opts.text);
  if (opts.attrs) {
    for (const [name, value] of Object.entries(opts.attrs)) {
      if (value === undefined || value === null || value === false) continue;
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
  for (const child of children || []) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
  return el;
}

function reviewLabellingIcon(doc, name, extraClass) {
  return reviewLabellingEl(doc, 'i', { className: `bi ${name}${extraClass ? ` ${extraClass}` : ''}`, attrs: { 'aria-hidden': 'true' } });
}

function reviewLabellingSpinner(doc, text) {
  return reviewLabellingEl(doc, 'span', { className: 'inline-flex items-center gap-2' }, [
    reviewLabellingEl(doc, 'span', { className: 'loading loading-spinner loading-sm motion-reduce:hidden', attrs: { 'aria-hidden': 'true' } }),
    reviewLabellingEl(doc, 'span', { text }),
  ]);
}

/** Fills a template; {tab}, {card} and {command} become elements (English names in span[lang=en], commands in code). */
function reviewLabellingTemplateNodes(doc, template, vars) {
  const nodes = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let match;
  while ((match = re.exec(template))) {
    if (match.index > last) nodes.push(doc.createTextNode(template.slice(last, match.index)));
    const name = match[1];
    const value = vars && vars[name] !== undefined ? String(vars[name]) : match[0];
    if (name === 'tab' || name === 'card') nodes.push(reviewLabellingEl(doc, 'span', { text: value, attrs: { lang: 'en' } }));
    else if (name === 'command' || name === 'code') nodes.push(reviewLabellingEl(doc, 'code', { className: 'font-mono text-xs break-all', text: value, attrs: { translate: 'no' } }));
    else nodes.push(doc.createTextNode(value));
    last = re.lastIndex;
  }
  if (last < template.length) nodes.push(doc.createTextNode(template.slice(last)));
  return nodes;
}

function reviewLabellingAlert(doc, { tone, icon, title, body, lines, actions, role }) {
  const text = reviewLabellingEl(doc, 'div', { className: 'min-w-0 max-w-prose' });
  if (title) text.appendChild(reviewLabellingEl(doc, 'p', { className: 'font-semibold', text: title }));
  if (body) text.appendChild(Array.isArray(body) ? reviewLabellingEl(doc, 'p', {}, body) : reviewLabellingEl(doc, 'p', { text: body }));
  for (const line of lines || []) text.appendChild(reviewLabellingEl(doc, 'p', { className: 'mt-1', text: line }));
  const alert = reviewLabellingEl(doc, 'div', { className: `alert alert-${tone || 'info'} items-start`, attrs: { role: role || null } }, [
    icon ? reviewLabellingIcon(doc, icon) : null,
    text,
  ]);
  if (actions && actions.length) alert.appendChild(reviewLabellingEl(doc, 'div', { className: 'flex flex-wrap gap-2' }, actions));
  return alert;
}

function reviewLabellingFormatNumber(value, locale, digits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  try {
    const opts = digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits };
    return new Intl.NumberFormat(locale, opts).format(number);
  } catch {
    return digits === undefined ? String(number) : number.toFixed(digits);
  }
}

function reviewLabellingFormatDate(value, locale) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return String(value || '');
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function reviewLabellingReasonText(code, locale) {
  return REVIEW_LABELLING_REASONS.includes(code) ? reviewLabellingLabel(`reason.${code}`, locale) : reviewLabellingLabel('reason.unknown', locale, { code });
}

function reviewLabellingOutcomeText(code, locale) {
  return REVIEW_LABELLING_OUTCOMES.includes(code) ? reviewLabellingLabel(`outcome.${code}`, locale) : reviewLabellingLabel('outcome.unknown', locale);
}

/** Language name for zh, en and it; "Not determined" for und or nothing; any other code in monospace. */
function reviewLabellingLanguageNode(doc, code, locale) {
  if (REVIEW_LABELLING_LANGUAGES.includes(code)) return doc.createTextNode(reviewLabellingLabel(`lang.${code}`, locale));
  if (!code || code === 'und') return doc.createTextNode(reviewLabellingLabel('lang.und', locale));
  return reviewLabellingEl(doc, 'span', { className: 'font-mono text-xs', text: code, attrs: { translate: 'no' } });
}

function reviewLabellingCategoryNode(doc, code, locale) {
  if (REVIEW_LABELLING_LABELS.en[`category.${code}`]) return doc.createTextNode(reviewLabellingLabel(`category.${code}`, locale));
  return reviewLabellingEl(doc, 'span', { className: 'font-mono text-xs', text: code, attrs: { translate: 'no' } });
}

function reviewLabellingStatusBadge(doc, status, locale) {
  const look = REVIEW_LABELLING_STATUS_LOOK[status];
  const text = look ? reviewLabellingLabel(`status.${status}`, locale) : reviewLabellingLabel('status.unknown', locale, { code: status });
  return reviewLabellingEl(doc, 'span', { className: `badge badge-sm gap-1 whitespace-nowrap ${look ? look.className : 'badge-ghost'}` }, [
    reviewLabellingIcon(doc, look ? look.icon : 'bi-question-circle'),
    reviewLabellingEl(doc, 'span', { text }),
  ]);
}

/** GET path of the queue: filters in a fixed order; an empty filter ("All") is left out. */
function reviewLabellingQueuePath(filters, cursor) {
  const params = new URLSearchParams();
  for (const name of ['status', 'reason', 'language']) {
    const value = filters && filters[name];
    if (value) params.set(name, value);
  }
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `${REVIEW_LABELLING_BASE}?${query}` : REVIEW_LABELLING_BASE;
}

function reviewLabellingItemPath(id, suffix) {
  return `${REVIEW_LABELLING_BASE}/${encodeURIComponent(id)}${suffix || ''}`;
}

/** Python str.isspace() code points; the twin of normalizeQuoteText in src/lib/rag/feedback-loop/labels.ts. */
const REVIEW_LABELLING_SPACE = (() => {
  const set = new Set([0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
  for (let c = 0x09; c <= 0x0d; c += 1) set.add(c);
  for (let c = 0x1c; c <= 0x20; c += 1) set.add(c);
  for (let c = 0x2000; c <= 0x200a; c += 1) set.add(c);
  return set;
})();
const REVIEW_LABELLING_PUNCT = /\p{P}/u;

/** NFKC, case fold, then every whitespace and punctuation code point removed: the same rule the label route applies. */
function reviewLabellingNormalize(text) {
  const folded = String(text || '').normalize('NFKC').toUpperCase().toLowerCase();
  let out = '';
  for (const char of folded) {
    if (!REVIEW_LABELLING_SPACE.has(char.codePointAt(0) || 0) && !REVIEW_LABELLING_PUNCT.test(char)) out += char;
  }
  return out;
}

/** 'ok', 'tooShort', 'notFound', or 'unchecked' when the passage text is not on screen (a stored quote). */
function reviewLabellingQuoteState(quote, passageText) {
  if (String(quote || '').trim().length < 2) return 'tooShort';
  if (passageText === null || passageText === undefined) return 'unchecked';
  const normalized = reviewLabellingNormalize(quote);
  if (!normalized || !reviewLabellingNormalize(passageText).includes(normalized)) return 'notFound';
  return 'ok';
}

function reviewLabellingIsObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function reviewLabellingString(value) {
  return typeof value === 'string' ? value : null;
}

function reviewLabellingStrings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

/** The named fields a view may render; nothing else of a server row is kept. */
function reviewLabellingQueueRow(raw) {
  if (!reviewLabellingIsObject(raw) || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    tenantKey: reviewLabellingString(raw.tenant_key),
    question: reviewLabellingString(raw.query_masked),
    queryLanguage: reviewLabellingString(raw.query_language),
    reasons: reviewLabellingStrings(raw.reasons),
    occurrences: Number.isInteger(raw.occurrences) ? raw.occurrences : 1,
    outcome: reviewLabellingString(raw.outcome) || 'unknown',
    status: reviewLabellingString(raw.status) || 'open',
    minedAt: reviewLabellingString(raw.mined_at),
  };
}

function reviewLabellingCaseView(raw) {
  const row = reviewLabellingQueueRow(raw);
  if (!row) return null;
  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .filter((c) => reviewLabellingIsObject(c) && typeof c.chunk_id === 'string')
    .map((c) => ({
      chunkId: c.chunk_id,
      documentId: reviewLabellingString(c.document_id),
      rank: Number.isInteger(c.rank) ? c.rank : 0,
      similarity: typeof c.similarity === 'number' ? c.similarity : null,
      rerank: typeof c.rerank_score === 'number' ? c.rerank_score : null,
      kept: c.kept === true,
      language: reviewLabellingString(c.language),
    }))
    .sort((a, b) => a.rank - b.rank);
  return {
    ...row,
    channel: reviewLabellingString(raw.channel),
    answerLanguage: reviewLabellingString(raw.answer_language),
    chunkLanguages: reviewLabellingStrings(raw.chunk_languages),
    tags: reviewLabellingStrings(raw.tags),
    answer: reviewLabellingString(raw.answer_masked),
    candidates,
    label: reviewLabellingIsObject(raw.label) ? raw.label : null,
    triage: reviewLabellingStrings(raw.triage),
  };
}

function reviewLabellingChunkMap(body) {
  const map = new Map();
  const chunks = body && Array.isArray(body.chunks) ? body.chunks : [];
  for (const chunk of chunks) {
    if (!reviewLabellingIsObject(chunk) || typeof chunk.chunk_id !== 'string') continue;
    map.set(chunk.chunk_id, {
      chunkId: chunk.chunk_id,
      documentId: reviewLabellingString(chunk.document_id),
      available: chunk.available !== false && typeof chunk.text === 'string',
      documentName: reviewLabellingString(chunk.document_name) || '',
      section: reviewLabellingString(chunk.section) || '',
      text: typeof chunk.text === 'string' ? chunk.text : null,
    });
  }
  return map;
}

function reviewLabellingHits(body) {
  const hits = body && Array.isArray(body.hits) ? body.hits : [];
  return hits
    .filter((hit) => reviewLabellingIsObject(hit) && typeof hit.chunk_id === 'string' && typeof hit.text === 'string')
    .slice(0, 30)
    .map((hit, index) => ({
      rank: Number.isInteger(hit.rank) ? hit.rank : index + 1,
      chunkId: hit.chunk_id,
      documentId: reviewLabellingString(hit.document_id),
      documentName: reviewLabellingString(hit.document_name) || '',
      section: reviewLabellingString(hit.section) || '',
      text: hit.text,
    }));
}

let reviewLabellingIdCounter = 0;
function reviewLabellingNextId(prefix) {
  reviewLabellingIdCounter += 1;
  return `${prefix}-${reviewLabellingIdCounter}`;
}

class ReviewLabellingPanel {
  constructor(root) {
    this.root = root;
    this.doc = reviewLabellingDoc();
    this.locale = reviewLabellingBrowserLocale();
    this.filters = { status: 'open', reason: '', language: '' };
    this.items = [];
    this.cursor = null;
    this.loaded = false;
    this.view = 'queue';
    this.caseState = null;
    this.selection = null;
    this.titleEl = root.querySelector('[data-review-title]');
    this.descriptionEl = root.querySelector('[data-review-description]');
    this.alertHost = root.querySelector('[data-review-alert]');
    this.contentHost = root.querySelector('[data-review-content]');
    this.statusHost = root.querySelector('[data-review-status]');
  }

  t(key, vars) {
    return reviewLabellingLabel(key, this.locale, vars);
  }

  el(tag, options, children) {
    return reviewLabellingEl(this.doc, tag, options, children);
  }

  mount() {
    this.root.setAttribute('lang', this.locale);
    if (this.titleEl) this.titleEl.textContent = this.t('panel.title');
    if (this.descriptionEl) this.descriptionEl.textContent = this.t('panel.description');
    return this.loadQueue({ reset: true });
  }

  refresh() {
    if (this.view === 'queue') return this.loadQueue({ reset: true });
    return Promise.resolve(null);
  }

  announce(text, options) {
    if (!this.statusHost) return;
    const opts = options || {};
    if (!text) {
      this.statusHost.replaceChildren();
      this.statusHost.classList.remove('text-error');
      return;
    }
    this.statusHost.classList.toggle('text-error', Boolean(opts.error));
    const line = this.el('span', { className: 'inline-flex items-start gap-1', attrs: { role: opts.alert ? 'alert' : null } }, [
      opts.error ? reviewLabellingIcon(this.doc, 'bi-exclamation-circle') : null,
      this.el('span', { text }),
    ]);
    this.statusHost.replaceChildren(line);
  }

  setAlert(node) {
    if (this.alertHost) this.alertHost.replaceChildren(...(node ? [node] : []));
  }

  async request(path, init, timeoutMs) {
    const fetcher = typeof window !== 'undefined' && typeof window.ragFetch === 'function' ? window.ragFetch : null;
    if (!fetcher) return { thrown: true };
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || REVIEW_LABELLING_TIMEOUT_MS) : null;
    try {
      const result = await fetcher(path, { ...(init || {}), ...(controller ? { signal: controller.signal } : {}) });
      return result && typeof result === 'object' ? result : { thrown: true };
    } catch {
      return { thrown: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  reloadButton(onReload) {
    const button = this.el('button', { className: 'btn btn-sm', text: this.t('action.reload'), attrs: { type: 'button', 'data-review-reload': true } });
    button.addEventListener('click', () => onReload());
    return button;
  }

  showSignIn() {
    this.view = 'queue';
    this.caseState = null;
    this.items = [];
    this.cursor = null;
    this.contentHost.replaceChildren();
    this.setAlert(
      reviewLabellingAlert(this.doc, {
        tone: 'warning',
        icon: 'bi-person-lock',
        body: reviewLabellingShared('error.signIn', this.locale),
        lines: [this.t('signin.expert')],
        actions: [this.reloadButton(() => this.loadQueue({ reset: true }))],
      }),
    );
    this.announce(reviewLabellingShared('error.signIn', this.locale), { error: true });
  }

  showUnavailable(sentence) {
    this.setAlert(
      reviewLabellingAlert(this.doc, {
        tone: 'error',
        icon: 'bi-exclamation-triangle',
        body: sentence,
        actions: [this.reloadButton(() => (this.view === 'case' && this.caseState ? this.openCase(this.caseState.view.id) : this.loadQueue({ reset: true })))],
      }),
    );
    this.contentHost.classList.add('opacity-60');
    this.announce(sentence, { error: true });
  }

  showOff() {
    this.items = [];
    this.cursor = null;
    this.contentHost.replaceChildren();
    const card = this.t('off.body');
    this.setAlert(
      reviewLabellingAlert(this.doc, {
        tone: 'info',
        icon: 'bi-toggle-off',
        title: this.t('off.title'),
        body: reviewLabellingTemplateNodes(this.doc, card, { tab: 'RAG Modes', card: 'Retrieval log and feedback' }),
      }),
    );
    this.announce(this.t('off.title'));
  }

  /** Read failures of the queue and of a case (UI-SPEC 8.2). Returns true when the failure was handled as "gone". */
  readFailure(result, where) {
    if (result.thrown) {
      this.showUnavailable(reviewLabellingShared('error.network', this.locale));
      return false;
    }
    if (result.status === 401 || result.status === 403) {
      this.showSignIn();
      return false;
    }
    if (result.status === 404) {
      if (where === 'list') this.showOff();
      else this.caseGone();
      return where !== 'list';
    }
    if (result.status === 503) {
      this.showUnavailable(this.t('list.unavailable'));
      return false;
    }
    this.showUnavailable(reviewLabellingShared('error.generic', this.locale, { status: result.status }));
    return false;
  }

  caseGone() {
    this.view = 'queue';
    this.caseState = null;
    void this.loadQueue({ reset: true }).then(() => this.announce(this.t('error.gone'), { error: true }));
  }

  isDefaultFilters() {
    return this.filters.status === 'open' && !this.filters.reason && !this.filters.language;
  }

  async loadQueue({ reset, append } = {}) {
    if (reset) this.cursor = null;
    const hasContent = this.loaded && this.view === 'queue' && this.contentHost.childNodes.length > 0;
    if (hasContent) {
      this.contentHost.classList.add('opacity-60');
      this.contentHost.setAttribute('aria-busy', 'true');
      const refresh = this.contentHost.querySelector('[data-review-refresh]');
      if (refresh) {
        refresh.disabled = true;
        refresh.replaceChildren(reviewLabellingSpinner(this.doc, this.t('list.loading')));
      }
    } else {
      this.contentHost.replaceChildren(reviewLabellingSpinner(this.doc, this.t('list.loading')));
    }
    this.announce(this.t('list.loading'));
    const result = await this.request(reviewLabellingQueuePath(this.filters, append ? this.cursor : null), { method: 'GET' });
    this.contentHost.classList.remove('opacity-60');
    this.contentHost.removeAttribute('aria-busy');
    if (!result.ok) {
      this.readFailure(result, 'list');
      if (result.status !== 401 && result.status !== 403 && result.status !== 404 && this.view === 'queue' && this.loaded) this.renderQueue(true);
      else if (!this.loaded && result.status !== 401 && result.status !== 403 && result.status !== 404) this.contentHost.replaceChildren();
      return null;
    }
    const body = result.body || {};
    const rows = (Array.isArray(body.items) ? body.items : []).map(reviewLabellingQueueRow).filter(Boolean);
    this.items = append ? this.items.concat(rows) : rows;
    this.cursor = typeof body.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
    this.loaded = true;
    this.view = 'queue';
    this.setAlert(null);
    this.renderQueue(false);
    this.announce(this.t('list.loaded', { count: reviewLabellingFormatNumber(this.items.length, this.locale) }));
    return this.items;
  }

  multiWorkspace() {
    return new Set(this.items.map((row) => row.tenantKey).filter(Boolean)).size > 1;
  }

  filterSelect(name, labelKey, options) {
    const id = reviewLabellingNextId(`review-filter-${name}`);
    const select = this.el('select', { className: 'select select-bordered select-sm', attrs: { id, 'data-review-filter': name } });
    for (const option of options) {
      const el = this.el('option', { text: option.label, attrs: { value: option.value } });
      if (option.value === this.filters[name]) el.setAttribute('selected', '');
      select.appendChild(el);
    }
    select.value = this.filters[name];
    select.addEventListener('change', () => {
      this.filters[name] = select.value || '';
      void this.loadQueue({ reset: true });
    });
    return this.el('div', { className: 'form-control' }, [this.el('label', { className: 'label py-1', attrs: { for: id } }, [this.el('span', { className: 'label-text text-xs', text: this.t(labelKey) })]), select]);
  }

  renderQueue(keepDimmed) {
    const doc = this.doc;
    const all = this.t('filter.all');
    const toolbar = this.el('div', { className: 'flex flex-wrap items-end gap-4 mb-4' }, [
      this.filterSelect('status', 'filter.status', [
        ...REVIEW_LABELLING_STATUSES.map((s) => ({ value: s, label: this.t(`status.${s}`) })),
        { value: '', label: all },
      ]),
      this.filterSelect('reason', 'filter.reason', [{ value: '', label: all }, ...REVIEW_LABELLING_REASONS.map((r) => ({ value: r, label: this.t(`reason.${r}`) }))]),
      this.filterSelect('language', 'filter.language', [{ value: '', label: all }, ...REVIEW_LABELLING_LANGUAGES.map((l) => ({ value: l, label: this.t(`lang.${l}`) }))]),
    ]);
    const refresh = this.el('button', { className: 'btn btn-sm btn-outline md:ml-auto', attrs: { type: 'button', 'data-review-refresh': true } }, [
      reviewLabellingIcon(doc, 'bi-arrow-clockwise'),
      this.el('span', { text: this.t('action.refresh') }),
    ]);
    refresh.addEventListener('click', () => this.loadQueue({ reset: true }));
    toolbar.appendChild(refresh);

    const nodes = [toolbar];
    if (this.items.length === 0) {
      if (this.isDefaultFilters()) {
        nodes.push(
          this.el('div', { className: 'py-8 text-center', attrs: { 'data-review-empty': true } }, [
            this.el('p', { className: 'text-base font-semibold', text: this.t('empty.title') }),
            this.el('p', { className: 'text-sm text-base-content/70 mt-2 max-w-prose mx-auto', text: this.t('empty.body') }),
          ]),
        );
      } else {
        const reset = this.el('button', { className: 'btn btn-ghost btn-sm mt-2', text: this.t('action.resetFilters'), attrs: { type: 'button', 'data-review-reset-filters': true } });
        reset.addEventListener('click', () => {
          this.filters = { status: 'open', reason: '', language: '' };
          void this.loadQueue({ reset: true });
        });
        nodes.push(this.el('div', { className: 'py-8 text-center', attrs: { 'data-review-empty': true } }, [this.el('p', { className: 'text-sm', text: this.t('empty.filtered') }), reset]));
      }
    } else {
      nodes.push(this.queueTable());
      if (this.cursor) {
        const more = this.el('button', { className: 'btn btn md:btn-sm btn-outline mt-4', text: this.t('action.loadMore'), attrs: { type: 'button', 'data-review-load-more': true } });
        more.addEventListener('click', () => {
          more.disabled = true;
          more.replaceChildren(reviewLabellingSpinner(doc, this.t('list.loading')));
          void this.loadQueue({ append: true });
        });
        nodes.push(more);
      }
    }
    this.contentHost.replaceChildren(...nodes);
    if (keepDimmed) this.contentHost.classList.add('opacity-60');
  }

  queueTable() {
    const doc = this.doc;
    const showWorkspace = this.multiWorkspace();
    const head = this.el('tr', {}, [
      this.el('th', { attrs: { scope: 'col' }, text: this.t('col.question') }),
      this.el('th', { className: 'hidden md:table-cell', attrs: { scope: 'col' }, text: this.t('col.reasons') }),
      this.el('th', { className: 'hidden md:table-cell', attrs: { scope: 'col' }, text: this.t('col.language') }),
      this.el('th', { className: 'hidden lg:table-cell', attrs: { scope: 'col' }, text: this.t('col.outcome') }),
      this.el('th', { attrs: { scope: 'col' }, text: this.t('col.status') }),
      this.el('th', { className: 'hidden md:table-cell text-right', attrs: { scope: 'col' }, text: this.t('col.mined') }),
    ]);
    const body = this.el('tbody');
    for (const row of this.items) {
      const question = row.question || this.t('item.noQuestion');
      const open = this.el('button', {
        className: 'btn btn-link btn-sm h-auto min-h-0 p-0 font-normal normal-case text-base-content text-left justify-start line-clamp-2 break-words',
        text: question,
        attrs: { type: 'button', 'data-review-open': row.id, 'aria-label': this.t('action.open', { question }), dir: 'auto', translate: 'no' },
      });
      open.addEventListener('click', () => this.openCase(row.id));
      const reasons = this.reasonBadges(row);
      const small = this.el('div', { className: 'md:hidden mt-1 text-xs text-base-content/70 flex flex-wrap gap-x-2 gap-y-1' }, [
        this.el('span', { text: row.reasons.length ? row.reasons.map((r) => reviewLabellingReasonText(r, this.locale)).join(', ') : this.t('reason.none') }),
        this.el('span', {}, [reviewLabellingLanguageNode(doc, row.queryLanguage, this.locale)]),
        row.minedAt ? this.el('span', { text: reviewLabellingFormatDate(row.minedAt, this.locale) }) : null,
      ]);
      const first = this.el('th', { className: 'min-w-0 max-w-md align-top', attrs: { scope: 'row' } }, [open, small]);
      if (showWorkspace && row.tenantKey) {
        first.appendChild(
          this.el('p', { className: 'text-xs text-base-content/70 mt-1 break-all' }, [
            this.el('span', { text: `${this.t('meta.workspace')}: ` }),
            this.el('span', { className: 'font-mono', text: row.tenantKey, attrs: { translate: 'no' } }),
          ]),
        );
      }
      body.appendChild(
        this.el('tr', { attrs: { 'data-review-row': row.id } }, [
          first,
          this.el('td', { className: 'hidden md:table-cell align-top' }, [reasons]),
          this.el('td', { className: 'hidden md:table-cell align-top text-sm' }, [reviewLabellingLanguageNode(doc, row.queryLanguage, this.locale)]),
          this.el('td', { className: 'hidden lg:table-cell align-top text-sm', text: reviewLabellingOutcomeText(row.outcome, this.locale) }),
          this.el('td', { className: 'align-top' }, [reviewLabellingStatusBadge(doc, row.status, this.locale)]),
          this.el('td', { className: 'hidden md:table-cell align-top text-right tabular-nums text-sm whitespace-nowrap' }, [
            row.minedAt ? this.el('time', { text: reviewLabellingFormatDate(row.minedAt, this.locale), attrs: { datetime: row.minedAt } }) : null,
          ]),
        ]),
      );
    }
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('list.caption') }),
      this.el('thead', {}, [head]),
      body,
    ]);
    return this.el('div', { className: 'overflow-x-auto', attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('list.caption') } }, [table]);
  }

  reasonBadges(row) {
    const wrap = this.el('div', { className: 'flex flex-wrap items-center gap-2' });
    if (row.reasons.length === 0) wrap.appendChild(this.el('span', { className: 'text-xs text-base-content/70', text: this.t('reason.none') }));
    for (const reason of row.reasons) wrap.appendChild(this.el('span', { className: 'badge badge-sm badge-ghost h-auto', text: reviewLabellingReasonText(reason, this.locale) }));
    if (row.occurrences > 1) {
      wrap.appendChild(this.el('span', { className: 'text-xs text-base-content/70 tabular-nums', text: this.t('occurrences', { count: reviewLabellingFormatNumber(row.occurrences, this.locale) }) }));
    }
    return wrap;
  }

  backToQueue() {
    const id = this.caseState ? this.caseState.view.id : null;
    this.view = 'queue';
    this.caseState = null;
    this.selection = null;
    this.setAlert(null);
    this.renderQueue(false);
    const row = id ? this.contentHost.querySelector(`[data-review-open="${id}"]`) : null;
    if (row) row.focus();
    else if (this.titleEl) this.titleEl.focus();
  }

  /** Leaving a case with unsaved changes asks first (UI-SPEC 12.1, Discard changes). */
  leaveCase(opener, proceed) {
    if (!this.caseState || !this.caseState.dirty || this.caseState.readOnly) {
      proceed();
      return;
    }
    this.confirmDiscard(opener, proceed);
  }

  confirmDiscard(opener, proceed) {
    const doc = this.doc;
    const titleId = reviewLabellingNextId('review-discard-title');
    const bodyId = reviewLabellingNextId('review-discard-body');
    const keep = this.el('button', { className: 'btn btn-sm btn-primary', text: this.t('discard.keep'), attrs: { type: 'button', autofocus: true, 'data-review-discard-keep': true } });
    const confirm = this.el('button', { className: 'btn btn-sm btn-outline', text: this.t('discard.confirm'), attrs: { type: 'button', 'data-review-discard-confirm': true } });
    const backdropButton = this.el('button', { text: this.t('discard.keep'), attrs: { type: 'button', tabindex: '-1' } });
    const dialog = this.el('dialog', { className: 'modal', attrs: { 'aria-labelledby': titleId, 'aria-describedby': bodyId, 'data-review-discard': true } }, [
      this.el('div', { className: 'modal-box overscroll-contain' }, [
        this.el('h3', { className: 'text-base font-semibold break-words', text: this.t('discard.title'), attrs: { id: titleId } }),
        this.el('p', { className: 'text-sm mt-2', text: this.t('discard.body'), attrs: { id: bodyId } }),
        this.el('div', { className: 'modal-action flex-wrap' }, [keep, confirm]),
      ]),
      this.el('form', { className: 'modal-backdrop', attrs: { method: 'dialog' } }, [backdropButton]),
    ]);
    if (typeof dialog.showModal !== 'function') {
      proceed();
      return;
    }
    let decided = false;
    const close = (go) => {
      if (decided) return;
      decided = true;
      dialog.close();
      dialog.remove();
      if (go) proceed();
      else if (opener && opener.isConnected !== false) opener.focus();
    };
    keep.addEventListener('click', () => close(false));
    backdropButton.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    dialog.addEventListener('cancel', () => close(false));
    dialog.addEventListener('close', () => close(false));
    this.root.appendChild(dialog);
    dialog.showModal();
    keep.focus();
    void doc;
  }

  async openCase(id, options) {
    const opts = options || {};
    this.view = 'case';
    this.selection = null;
    this.setAlert(null);
    this.contentHost.classList.remove('opacity-60');
    this.contentHost.replaceChildren(reviewLabellingSpinner(this.doc, this.t('item.loading')));
    if (!opts.keepStatus) this.announce(this.t('item.loading'));
    const result = await this.request(reviewLabellingItemPath(id), { method: 'GET' });
    if (!result.ok) {
      this.readFailure(result, 'case');
      return null;
    }
    const view = reviewLabellingCaseView(result.body);
    if (!view) {
      this.showUnavailable(this.t('list.unavailable'));
      return null;
    }
    const index = this.items.findIndex((row) => row.id === view.id);
    if (index >= 0) this.items[index] = { ...this.items[index], status: view.status };
    this.caseState = this.newCaseState(view);
    this.renderCase();
    if (!opts.keepStatus) this.announce('');
    const back = this.contentHost.querySelector('[data-review-back]');
    if (back) back.focus();
    await this.loadChunks();
    return view;
  }

  newCaseState(view) {
    return {
      view,
      chunks: null,
      chunksState: 'loading',
      passagesShown: REVIEW_LABELLING_PAGE,
      search: { state: 'idle', hits: [], shown: REVIEW_LABELLING_PAGE, query: '', error: null },
      quotes: [],
      form: this.initialForm(view),
      errors: {},
      dirty: false,
      busy: false,
      readOnly: view.status === 'exported',
    };
  }

  initialForm(view) {
    const lang = REVIEW_LABELLING_LANGUAGES.includes(view.queryLanguage) ? view.queryLanguage : '';
    return { language: lang, notRelevant: new Set() };
  }

  async loadChunks() {
    const state = this.caseState;
    if (!state) return;
    state.chunksState = 'loading';
    this.renderEvidence();
    const result = await this.request(reviewLabellingItemPath(state.view.id, '/chunks'), { method: 'GET' });
    if (this.caseState !== state) return;
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) {
        this.showSignIn();
        return;
      }
      if (result.status === 404) {
        this.caseGone();
        return;
      }
      state.chunksState = 'failed';
      this.renderEvidence();
      return;
    }
    state.chunks = reviewLabellingChunkMap(result.body);
    state.chunksState = 'ready';
    this.renderEvidence();
    this.renderLabel();
  }

  renderCase() {
    const doc = this.doc;
    const state = this.caseState;
    const view = state.view;
    const back = this.el('button', { className: 'btn btn-ghost btn-sm', attrs: { type: 'button', 'data-review-back': true } }, [
      reviewLabellingIcon(doc, 'bi-arrow-left'),
      this.el('span', { text: this.t('action.back') }),
    ]);
    back.addEventListener('click', () => this.leaveCase(back, () => this.backToQueue()));
    const top = this.el('div', { className: 'flex flex-wrap items-center justify-between gap-2 mb-4' }, [back, reviewLabellingStatusBadge(doc, view.status, this.locale)]);

    const questionId = reviewLabellingNextId('review-question');
    const header = this.el('div', { className: 'mb-6 min-w-0' }, [
      this.el('p', { className: 'text-xs text-base-content/70', text: this.t('item.question'), attrs: { id: questionId } }),
      this.el('p', {
        className: 'text-base break-words mt-1',
        text: view.question || this.t('item.noQuestion'),
        attrs: { dir: 'auto', translate: 'no', 'aria-labelledby': questionId, 'data-review-question': true },
      }),
      this.caseMeta(),
      this.el('p', { className: 'text-sm mt-2' }, [
        this.el('span', { className: 'text-base-content/70', text: `${this.t('col.outcome')}: ` }),
        this.el('span', { text: reviewLabellingOutcomeText(view.outcome, this.locale) }),
      ]),
    ]);
    if (view.answer) {
      header.appendChild(this.el('p', { className: 'text-xs text-base-content/70 mt-4', text: this.t('item.answer') }));
      header.appendChild(
        this.el('div', {
          className: 'mt-1 max-h-64 overflow-y-auto text-sm leading-5 whitespace-pre-wrap break-words border border-base-300 rounded-lg p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
          text: view.answer,
          attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('item.answer'), dir: 'auto', translate: 'no', 'data-review-answer': true },
        }),
      );
    } else {
      header.appendChild(this.el('p', { className: 'text-xs text-base-content/70 mt-2', text: this.t('item.noAnswer') }));
    }

    this.evidenceHost = this.el('div', { className: 'min-w-0', attrs: { 'data-review-evidence': true } });
    this.labelHost = this.el('div', { className: 'min-w-0 lg:sticky lg:top-4 lg:self-start', attrs: { 'data-review-label': true } });
    const columns = this.el('div', { className: 'grid gap-6 lg:grid-cols-2' }, [this.evidenceHost, this.labelHost]);
    const nodes = [top];
    if (state.readOnly) {
      nodes.push(this.el('div', { className: 'mb-4' }, [reviewLabellingAlert(doc, { tone: 'info', icon: 'bi-lock', body: this.t('exported.notice') })]));
    }
    nodes.push(header, columns);
    this.contentHost.replaceChildren(...nodes);
    this.renderEvidence();
    this.renderLabel();
  }

  caseMeta() {
    const doc = this.doc;
    const view = this.caseState.view;
    const dl = this.el('dl', { className: 'flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/70 mt-2' });
    const entry = (labelKey, valueNodes) => {
      dl.appendChild(this.el('div', { className: 'flex gap-1 min-w-0' }, [this.el('dt', { text: `${this.t(labelKey)}:` }), this.el('dd', { className: 'min-w-0 break-words' }, valueNodes)]));
    };
    if (view.channel) entry('meta.channel', [doc.createTextNode(REVIEW_LABELLING_CHANNELS.includes(view.channel) ? this.t(`channel.${view.channel}`) : view.channel)]);
    if (view.minedAt) entry('meta.mined', [this.el('time', { text: reviewLabellingFormatDate(view.minedAt, this.locale), attrs: { datetime: view.minedAt } })]);
    entry('meta.queryLanguage', [reviewLabellingLanguageNode(doc, view.queryLanguage, this.locale)]);
    if (view.answerLanguage) entry('meta.answerLanguage', [reviewLabellingLanguageNode(doc, view.answerLanguage, this.locale)]);
    if (view.chunkLanguages.length) {
      const nodes = [];
      view.chunkLanguages.forEach((code, i) => {
        if (i) nodes.push(doc.createTextNode(', '));
        nodes.push(reviewLabellingLanguageNode(doc, code, this.locale));
      });
      entry('meta.chunkLanguages', nodes);
    }
    if (this.multiWorkspace() && view.tenantKey) entry('meta.workspace', [this.el('span', { className: 'font-mono break-all', text: view.tenantKey, attrs: { translate: 'no' } })]);
    const reasons = this.reasonBadges(view);
    for (const tag of view.tags) reasons.appendChild(this.el('span', { className: 'badge badge-sm badge-ghost font-mono', text: tag, attrs: { translate: 'no' } }));
    dl.appendChild(this.el('div', { className: 'w-full mt-1' }, [reasons]));
    return dl;
  }

  passageSources() {
    const state = this.caseState;
    return state.view.candidates.map((candidate) => {
      const chunk = state.chunks ? state.chunks.get(candidate.chunkId) : null;
      return {
        kind: 'passage',
        key: `p:${candidate.chunkId}`,
        chunkId: candidate.chunkId,
        documentId: (chunk && chunk.documentId) || candidate.documentId,
        documentName: chunk ? chunk.documentName : '',
        section: chunk ? chunk.section : '',
        text: chunk && chunk.available ? chunk.text : null,
        available: state.chunksState !== 'ready' ? state.chunksState === 'loading' : Boolean(chunk && chunk.available),
        rank: candidate.rank,
        candidate,
        sourceLabel: this.t('passage.title', { rank: candidate.rank, document: '' }).replace(/[:：]\s*$/, ''),
        title: this.t('passage.title', { rank: candidate.rank, document: (chunk && chunk.documentName) || '—' }),
      };
    });
  }

  resultSources() {
    return this.caseState.search.hits.map((hit) => ({
      kind: 'result',
      key: `r:${hit.rank}:${hit.chunkId}`,
      chunkId: hit.chunkId,
      documentId: hit.documentId,
      documentName: hit.documentName,
      section: hit.section,
      text: hit.text,
      available: true,
      rank: hit.rank,
      sourceLabel: this.t('search.resultTitle', { rank: hit.rank, document: '' }).replace(/[:：]\s*$/, ''),
      title: this.t('search.resultTitle', { rank: hit.rank, document: hit.documentName || '—' }),
    }));
  }

  renderEvidence() {
    if (!this.evidenceHost || !this.caseState) return;
    const doc = this.doc;
    const state = this.caseState;
    const nodes = [this.el('h4', { className: 'text-base font-semibold mb-2', text: this.t('passages.heading') })];
    if (state.chunksState === 'failed') {
      const reload = this.el('button', { className: 'btn btn-sm', text: this.t('action.reloadPassages'), attrs: { type: 'button', 'data-review-reload-passages': true } });
      reload.addEventListener('click', () => this.loadChunks());
      nodes.push(this.el('div', { className: 'mb-4' }, [reviewLabellingAlert(doc, { tone: 'error', icon: 'bi-exclamation-triangle', body: this.t('passages.unavailable'), actions: [reload] })]));
    }
    const sources = this.passageSources();
    if (sources.length === 0) {
      nodes.push(this.el('p', { className: 'text-sm mb-4', text: this.t('passages.none') }));
    } else {
      if (this.caseState.quotes.length === 0 && !state.readOnly) nodes.push(this.el('p', { className: 'text-xs text-base-content/70 mb-2', text: this.t('passage.selectHint') }));
      for (const source of sources.slice(0, state.passagesShown)) nodes.push(this.sourceBlock(source));
      const remaining = sources.length - state.passagesShown;
      if (remaining > 0) {
        const more = this.el('button', {
          className: 'btn btn-sm btn-outline mb-4',
          text: this.t('action.showMorePassages', { count: reviewLabellingFormatNumber(remaining, this.locale) }),
          attrs: { type: 'button', 'data-review-show-more': true },
        });
        more.addEventListener('click', () => {
          state.passagesShown += REVIEW_LABELLING_PAGE;
          this.renderEvidence();
        });
        nodes.push(more);
      }
    }
    nodes.push(this.searchBlock());
    this.evidenceHost.replaceChildren(...nodes);
  }

  quotedChunkIds() {
    return new Set(this.caseState.quotes.map((quote) => quote.chunkId));
  }

  sourceBlock(source) {
    const doc = this.doc;
    const state = this.caseState;
    const isPassage = source.kind === 'passage';
    const meta = this.el('p', { className: 'text-xs text-base-content/70 flex flex-wrap items-center gap-x-4 gap-y-1 mt-1' });
    if (source.section) meta.appendChild(this.el('span', { className: 'break-words', text: this.t('passage.section', { section: source.section }) }));
    if (isPassage) {
      const c = source.candidate;
      const score = c.rerank !== null ? this.t('passage.rerank', { score: reviewLabellingFormatNumber(c.rerank, this.locale, 3) }) : c.similarity !== null ? this.t('passage.similarity', { score: reviewLabellingFormatNumber(c.similarity, this.locale, 3) }) : null;
      if (score) meta.appendChild(this.el('span', { className: 'tabular-nums', text: score }));
      if (c.kept) {
        meta.appendChild(this.el('span', { className: 'badge badge-sm badge-outline gap-1' }, [reviewLabellingIcon(doc, 'bi-check2'), this.el('span', { text: this.t('passage.kept') })]));
      } else {
        meta.appendChild(this.el('span', { text: this.t('passage.notKept') }));
      }
      if (c.language) meta.appendChild(this.el('span', {}, [reviewLabellingLanguageNode(doc, c.language, this.locale)]));
    }
    const region = this.el('div', {
      className: 'mt-2 max-h-64 overflow-y-auto text-sm leading-5 whitespace-pre-wrap break-words rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
      attrs: {
        tabindex: '0',
        role: 'region',
        'aria-label': this.t('passage.textAria', { rank: source.rank }),
        dir: 'auto',
        translate: 'no',
        lang: isPassage && source.candidate.language ? source.candidate.language : null,
        'data-review-passage-text': true,
      },
    });
    if (isPassage && state.chunksState === 'loading') region.appendChild(reviewLabellingSpinner(doc, this.t('passages.loading')));
    else if (source.text !== null && source.text !== undefined) region.textContent = source.text;
    else if (isPassage && state.chunksState === 'ready') region.textContent = this.t('passage.gone');
    const capture = () => this.captureSelection(region, source);
    region.addEventListener('mouseup', capture);
    region.addEventListener('keyup', capture);

    const usable = source.text !== null && source.text !== undefined;
    const atMax = state.quotes.length >= REVIEW_LABELLING_MAX_QUOTES;
    const add = this.el('button', {
      className: 'btn btn md:btn-sm btn-outline',
      text: this.t('action.addQuote'),
      attrs: { type: 'button', 'data-review-add-quote': source.key, 'aria-label': this.t('action.addQuoteAria', { source: source.sourceLabel }) },
    });
    add.disabled = !usable || atMax || state.readOnly || state.busy;
    if (atMax) {
      const id = reviewLabellingNextId('review-quote-max');
      add.setAttribute('aria-describedby', id);
      region.appendChild(this.el('span', { className: 'sr-only', text: this.t('evidence.max'), attrs: { id } }));
    }
    add.addEventListener('click', () => this.addQuote(source));
    const actions = this.el('div', { className: 'mt-2 flex flex-wrap items-center gap-4' }, [add]);
    if (isPassage) {
      const quoted = this.quotedChunkIds().has(source.chunkId);
      const box = this.el('input', {
        className: 'checkbox checkbox-sm',
        attrs: { type: 'checkbox', 'data-review-not-relevant': source.chunkId, 'aria-label': this.t('passage.notRelevantAria', { rank: source.rank }) },
      });
      box.checked = !quoted && state.form.notRelevant.has(source.chunkId);
      box.disabled = !source.available || quoted || state.readOnly || state.busy;
      box.addEventListener('change', () => {
        if (box.checked) state.form.notRelevant.add(source.chunkId);
        else state.form.notRelevant.delete(source.chunkId);
        state.dirty = true;
      });
      const label = this.el('label', { className: 'label cursor-pointer justify-start gap-2 p-0' }, [box, this.el('span', { className: 'label-text text-sm', text: this.t('passage.notRelevant'), attrs: { 'aria-hidden': 'true' } })]);
      actions.appendChild(label);
      if (quoted) {
        const id = reviewLabellingNextId('review-not-relevant-locked');
        box.setAttribute('aria-describedby', id);
        actions.appendChild(this.el('span', { className: 'text-xs text-base-content/70', text: this.t('passage.notRelevantLocked'), attrs: { id } }));
      }
    }
    return this.el(
      'article',
      {
        className: 'border border-base-300 rounded-lg p-4 mb-4 min-w-0',
        attrs: isPassage ? { 'data-review-passage': source.chunkId, 'data-review-source': source.key } : { 'data-review-result': source.chunkId, 'data-review-source': source.key },
      },
      [this.el('h5', { className: 'text-sm font-semibold break-words', text: source.title }), meta, region, actions],
    );
  }

  captureSelection(region, source) {
    const selection = typeof window !== 'undefined' && typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (!selection) return;
    const text = typeof selection.toString === 'function' ? selection.toString() : '';
    if (!text || !text.trim()) return;
    if (!region.contains(selection.anchorNode) || !region.contains(selection.focusNode)) return;
    this.selection = { key: source.key, text };
  }

  searchBlock() {
    const doc = this.doc;
    const search = this.caseState.search;
    const inputId = reviewLabellingNextId('review-search');
    const errorId = `${inputId}-error`;
    const input = this.el('input', {
      className: 'input input-bordered input-sm w-full min-w-0',
      attrs: {
        id: inputId,
        type: 'search',
        maxlength: String(REVIEW_LABELLING_SEARCH_MAX),
        placeholder: this.t('search.placeholder'),
        autocomplete: 'off',
        'data-review-search-input': true,
        'aria-invalid': search.error === 'tooLong' ? 'true' : null,
        'aria-describedby': search.error === 'tooLong' ? errorId : null,
      },
    });
    input.value = search.query;
    input.addEventListener('input', () => {
      search.query = input.value;
    });
    input.addEventListener('change', () => {
      search.query = input.value;
    });
    const button = this.el('button', { className: 'btn btn md:btn-sm btn-outline', attrs: { type: 'submit', 'data-review-search-submit': true } }, [
      search.state === 'running' ? reviewLabellingSpinner(doc, this.t('search.running')) : this.el('span', { text: this.t('action.search') }),
    ]);
    button.disabled = search.state === 'running';
    const form = this.el('form', { className: 'mt-2', attrs: { 'data-review-search': true, role: 'search' } }, [
      this.el('label', { className: 'label pb-1', attrs: { for: inputId } }, [this.el('span', { className: 'label-text text-sm', text: this.t('search.label') })]),
      this.el('div', { className: 'flex flex-wrap gap-2' }, [this.el('div', { className: 'flex-1 min-w-0' }, [input]), button]),
      search.error === 'tooLong' ? this.el('p', { className: 'text-xs text-error mt-1', text: this.t('search.tooLong'), attrs: { id: errorId } }) : null,
      this.el('p', { className: 'text-xs text-base-content/70 mt-1', text: this.t('search.note') }),
    ]);
    form.addEventListener('submit', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      search.query = input.value;
      void this.runSearch();
    });
    const nodes = [this.el('h4', { className: 'text-base font-semibold mt-6', text: this.t('search.heading') }), form];
    const results = this.el('div', { className: 'mt-4', attrs: { 'data-review-search-results': true } });
    if (search.state === 'idle') results.appendChild(this.el('p', { className: 'text-xs text-base-content/70', text: this.t('search.hint') }));
    else if (search.state === 'empty') results.appendChild(this.el('p', { className: 'text-sm', text: this.t('search.empty') }));
    else if (search.state === 'failed') results.appendChild(this.el('p', { className: 'text-sm text-error', text: search.message || this.t('search.unavailable') }));
    if (search.hits.length) {
      results.appendChild(this.el('p', { className: 'text-sm mb-2', text: this.t('search.results', { count: reviewLabellingFormatNumber(search.hits.length, this.locale) }) }));
      const sources = this.resultSources();
      for (const source of sources.slice(0, search.shown)) results.appendChild(this.sourceBlock(source));
      if (sources.length > search.shown) {
        const more = this.el('button', {
          className: 'btn btn-sm btn-outline',
          text: this.t('action.showMorePassages', { count: reviewLabellingFormatNumber(sources.length - search.shown, this.locale) }),
          attrs: { type: 'button', 'data-review-show-more-results': true },
        });
        more.addEventListener('click', () => {
          search.shown += REVIEW_LABELLING_PAGE;
          this.renderEvidence();
        });
        results.appendChild(more);
      }
    }
    nodes.push(results);
    return this.el('div', { attrs: { 'data-review-search-block': true } }, nodes);
  }

  async runSearch() {
    const state = this.caseState;
    if (!state) return;
    const search = state.search;
    const query = String(search.query || '').trim();
    if (!query) return;
    if (query.length > REVIEW_LABELLING_SEARCH_MAX) {
      search.error = 'tooLong';
      this.renderEvidence();
      const input = this.evidenceHost.querySelector('[data-review-search-input]');
      if (input) input.focus();
      return;
    }
    search.error = null;
    search.state = 'running';
    this.renderEvidence();
    this.announce(this.t('search.running'));
    const result = await this.request(reviewLabellingItemPath(state.view.id, '/search'), { method: 'POST', body: JSON.stringify({ query }) }, REVIEW_LABELLING_SEARCH_TIMEOUT_MS);
    if (this.caseState !== state) return;
    if (result.ok) {
      search.hits = reviewLabellingHits(result.body);
      search.shown = REVIEW_LABELLING_PAGE;
      search.state = search.hits.length ? 'done' : 'empty';
      search.message = null;
      this.renderEvidence();
      this.announce(this.t('search.results', { count: reviewLabellingFormatNumber(search.hits.length, this.locale) }));
      return;
    }
    if (result.status === 401 || result.status === 403) {
      this.showSignIn();
      return;
    }
    if (result.status === 404) {
      this.caseGone();
      return;
    }
    search.state = 'failed';
    if (result.thrown) search.message = reviewLabellingShared('error.network', this.locale);
    else if (result.status === 503) search.message = this.t('search.unavailable');
    else if (result.status === 400) search.message = this.t('error.invalid', { detail: reviewLabellingDetail(result.body) });
    else search.message = reviewLabellingShared('error.generic', this.locale, { status: result.status });
    this.renderEvidence();
    this.announce(search.message, { error: true });
  }

  addQuote(source) {
    const state = this.caseState;
    if (!state || state.quotes.length >= REVIEW_LABELLING_MAX_QUOTES) return;
    const text = this.selection && this.selection.key === source.key ? this.selection.text : '';
    this.selection = null;
    state.quotes.push({
      key: reviewLabellingNextId('review-quote'),
      sourceKey: source.key,
      sourceLabel: source.sourceLabel,
      chunkId: source.chunkId,
      documentId: source.documentId,
      documentName: source.documentName,
      section: source.section,
      text: source.text,
      quote: text,
      serverError: null,
    });
    state.form.notRelevant.delete(source.chunkId);
    state.dirty = true;
    this.renderEvidence();
    this.renderLabel();
    const fields = this.labelHost.querySelectorAll('[data-review-quote-text]');
    const last = fields[fields.length - 1];
    if (last) last.focus();
  }
}

function reviewLabellingDetail(body) {
  if (body && Array.isArray(body.details) && body.details[0] && typeof body.details[0].message === 'string') return body.details[0].message;
  if (body && typeof body.error === 'string') return body.error;
  return '';
}

ReviewLabellingPanel.prototype.renderLabel = function renderLabel() {
  if (!this.labelHost || !this.caseState) return;
  const nodes = [this.el('h4', { className: 'text-base font-semibold mb-2', text: this.t('answerable.heading') })];
  if (!this.caseState.readOnly) {
    nodes.push(
      this.el('div', { className: 'flex flex-wrap gap-2 mt-4' }, [
        this.el('button', { className: 'btn btn-primary btn-sm', text: this.t('action.save'), attrs: { type: 'button', 'data-review-save': true } }),
        this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.skip'), attrs: { type: 'button', 'data-review-skip': true } }),
      ]),
    );
  }
  this.labelHost.replaceChildren(...nodes);
};

let reviewLabellingPanelInstance = null;

function initReviewLabellingPanel() {
  if (typeof document === 'undefined') return Promise.resolve(null);
  const root = document.getElementById('rag-administration-review');
  if (!root) return Promise.resolve(null);
  if (!reviewLabellingPanelInstance) {
    reviewLabellingPanelInstance = new ReviewLabellingPanel(root);
    if (typeof window !== 'undefined') window.reviewLabellingPanel = reviewLabellingPanelInstance;
    return reviewLabellingPanelInstance.mount();
  }
  return reviewLabellingPanelInstance.refresh();
}

function reviewLabellingBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-review-labelling-bound')) return;
    link.setAttribute('data-review-labelling-bound', '1');
    link.addEventListener('click', () => {
      void initReviewLabellingPanel();
    });
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initReviewLabellingPanel = initReviewLabellingPanel;
  window.reviewLabellingLabel = reviewLabellingLabel;
  window.REVIEW_LABELLING_LABELS = REVIEW_LABELLING_LABELS;
  window.reviewLabellingEl = reviewLabellingEl;
  window.reviewLabellingIcon = reviewLabellingIcon;
  window.reviewLabellingSpinner = reviewLabellingSpinner;
  window.reviewLabellingAlert = reviewLabellingAlert;
  window.reviewLabellingShared = reviewLabellingShared;
  window.reviewLabellingResolveLocale = reviewLabellingResolveLocale;
  window.reviewLabellingBrowserLocale = reviewLabellingBrowserLocale;
  window.reviewLabellingTemplateNodes = reviewLabellingTemplateNodes;
  window.reviewLabellingReasonText = reviewLabellingReasonText;
  window.reviewLabellingFormatNumber = reviewLabellingFormatNumber;
  window.reviewLabellingFormatDate = reviewLabellingFormatDate;
  window.reviewLabellingNextId = reviewLabellingNextId;
  reviewLabellingBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    reviewLabellingBindPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) void initReviewLabellingPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REVIEW_LABELLING_LABELS,
    REVIEW_LABELLING_REASONS,
    REVIEW_LABELLING_CATEGORIES,
    ReviewLabellingPanel,
    initReviewLabellingPanel,
    reviewLabellingLabel,
    reviewLabellingShared,
    reviewLabellingResolveLocale,
    reviewLabellingEl,
    reviewLabellingIcon,
    reviewLabellingSpinner,
    reviewLabellingAlert,
    reviewLabellingTemplateNodes,
    reviewLabellingReasonText,
    reviewLabellingFormatNumber,
    reviewLabellingFormatDate,
    reviewLabellingNextId,
    reviewLabellingQueuePath,
    reviewLabellingNormalize,
    reviewLabellingQuoteState,
  };
}
