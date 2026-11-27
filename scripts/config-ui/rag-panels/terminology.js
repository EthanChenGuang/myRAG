/**
 * Terminology panel (04.1.1-UI-SPEC, TERM-11, D-32, D-35). Domain experts browse, edit, import, export and preview the
 * terminology dictionary and review mined candidates. Every value from the server is set as text through rag-ui.js helpers;
 * the language options come only from the enabled_languages the routes return.
 */

const TERMINOLOGY_LABELS = {
  en: {
    'panel.title': 'Terminology',
    'panel.description':
      'Maintains the dictionary that expands search queries with synonyms, abbreviations and other spellings. Translation pairs are stored for translation features and never expand a query. Follows the workspace chosen under Document Processing.',
    'panel.workspaceDefault': 'Default workspace',
    'panel.loading': 'Loading the dictionary…',
    'panel.unavailable': 'The dictionary is unavailable right now. Select Reload panel in a moment.',
    'panel.loaded': 'Dictionary loaded.',
    'layer.legend': 'Dictionary layer',
    'layer.shared': 'Shared (all workspaces)',
    'layer.workspace': 'Workspace (this workspace only)',
    'tabs.label': 'Terminology views',
    'tab.entries': 'Entries',
    'tab.import': 'Import and export',
    'tab.preview': 'Preview',
    'tab.candidates': 'Candidates',
    'tab.history': 'History',
    'list.search': 'Search terms',
    'list.searchPlaceholder': 'termalpha',
    'list.count': 'Entries',
    'list.range': 'Showing {from}–{to} of {total}',
    'list.label': 'Dictionary entries',
    'list.empty': 'No entries in this layer yet.',
    'list.emptyBody': 'Create the first one with New entry, or import a CSV file.',
    'list.noMatch': 'No entries match this search.',
    'col.term': 'Term',
    'col.variants': 'Variants',
    'col.kind': 'Kind',
    'col.language': 'Language',
    'col.mode': 'Mode',
    'col.status': 'Status',
    'col.actions': 'Actions',
    'status.enabled': 'Enabled',
    'status.disabled': 'Disabled',
    'status.hidden': 'Hidden shared entry',
    'kind.synonym': 'Synonym',
    'kind.abbreviation': 'Abbreviation',
    'kind.alias': 'Alias',
    'kind.identifier': 'Identifier',
    'kind.misspelling': 'Misspelling',
    'kind.translation': 'Translation pair',
    'mode.one_way': 'One way',
    'mode.equivalent': 'Equivalent',
    'mode.one_wayHelp': 'A variant in the query also finds the term.',
    'mode.equivalentHelp': 'Each member finds all the others.',
    'language.any': 'Any language',
    'language.choose': 'Choose a language',
    'action.new': 'New entry',
    'action.edit': 'Edit',
    'action.editAria': 'Edit {term}',
    'action.delete': 'Delete',
    'action.deleteAria': 'Delete {term}',
    'action.hide': 'Hide in workspace',
    'action.hideAria': 'Hide {term} in this workspace',
    'action.show': 'Show again',
    'action.showAria': 'Show {term} again in this workspace',
    'action.save': 'Save entry',
    'action.saving': 'Saving entry…',
    'action.cancel': 'Cancel',
    'action.previous': 'Previous',
    'action.next': 'Next',
    'action.more': 'More',
    'action.reloadList': 'Reload',
    'form.new': 'New entry',
    'form.edit': 'Edit entry',
    'form.candidate': 'New entry from a candidate',
    'form.canonical': 'Term',
    'form.canonicalHelp': 'The term the documents use.',
    'form.canonicalPair': 'Target-language term',
    'form.canonicalPairHelp': 'The term in the target language.',
    'form.variants': 'Variants',
    'form.variantsHelp': 'Other ways people write it. One per line, at most 16. A variant cannot contain the character |.',
    'form.variantsPair': 'Source-language terms',
    'form.variantsPairHelp': 'The terms in the source language, one per line. A translation pair never expands a query.',
    'form.variantsPlaceholder': 'termalpha',
    'form.canonicalPlaceholder': 'term alpha beta',
    'form.kind': 'Kind',
    'form.language': 'Language',
    'form.sourceLanguage': 'Source language',
    'form.targetLanguage': 'Target language',
    'form.mode': 'Mode',
    'form.modeFixed': 'One way (always, for a translation pair)',
    'form.enabled': 'Enabled',
    'form.note': 'Note',
    'form.noteHelp': 'Optional, at most 500 characters.',
    'form.notSaved': 'Not saved. Fix the issues below.',
    'form.saved': 'Entry saved.',
    'form.warning': 'Saved with a warning: {message}',
    'form.conflict': 'This dictionary changed since you loaded it.',
    'form.conflictBody': 'Reload to see the current entries. Your draft stays in the form.',
    'issue.conflict': 'Conflict',
    'issue.chain': 'Chain',
    'issue.cycle': 'Cycle',
    'issue.invalid_variant': 'Invalid variant',
    'issue.invalid_language': 'Invalid language',
    'issue.invalid_translation': 'Invalid translation pair',
    'issue.limit': 'Limit reached',
    'issue.duplicate': 'Duplicate',
    'issue.override': 'Overrides a shared entry',
    'issue.required': 'Required',
    'issue.too_long': 'Too long',
    'issue.too_many': 'Too many',
    'issue.pipe': 'Not allowed',
    'client.canonicalRequired': 'Enter the term.',
    'client.canonicalLong': 'The term has at most 64 characters.',
    'client.variantsRequired': 'Enter at least one variant.',
    'client.variantsMany': 'At most 16 variants.',
    'client.variantLong': 'Each variant has at most 64 characters.',
    'client.variantPipe': 'A variant cannot contain the character |.',
    'client.pairLanguages': 'Choose a source and a target language.',
    'client.pairSame': 'The source and target languages must differ.',
    'client.noteLong': 'The note has at most 500 characters.',
    'severity.error': 'Error',
    'severity.warning': 'Warning',
    'delete.title': 'Delete this entry?',
    'delete.body': 'Searches stop using “{term}” within a minute.',
    'delete.keep': 'Keep entry',
    'delete.confirm': 'Delete entry',
    'delete.running': 'Deleting…',
    'delete.done': 'Entry deleted.',
    'hide.title': 'Hide this shared entry in this workspace?',
    'hide.body': 'This workspace stops using “{term}”. Other workspaces keep it.',
    'hide.keep': 'Keep using it',
    'hide.confirm': 'Hide entry',
    'hide.running': 'Hiding…',
    'hide.done': 'Shared entry hidden in this workspace.',
    'show.done': 'Shared entry used again in this workspace.',
    'import.columns': 'CSV columns',
    'import.col.canonical': 'The term the documents use (for a translation pair, the target-language term).',
    'import.col.variants': 'Other spellings, separated by |.',
    'import.col.language': 'A supported language, or any.',
    'import.col.kind': 'synonym, abbreviation, alias, identifier, misspelling or translation.',
    'import.col.mode': 'one_way or equivalent; translation pairs are one_way.',
    'import.col.enabled': 'true or false.',
    'import.col.note': 'Optional text, at most 500 characters.',
    'import.col.source_language': 'Translation pairs only: the source language.',
    'import.col.target_language': 'Translation pairs only: the target language.',
    'import.limits': 'UTF-8, at most 1 MB and 5,000 rows. A DictionaryCandidate .jsonl export is accepted too.',
    'import.file': 'File',
    'import.mode': 'Import mode',
    'import.merge': 'Merge (add and update)',
    'import.replace': 'Replace (the layer becomes exactly the file)',
    'import.check': 'Check file',
    'import.checking': 'Checking…',
    'import.apply': 'Apply import',
    'import.applying': 'Importing…',
    'import.needFile': 'Choose a file first.',
    'import.needCheck': 'Check the file before applying it.',
    'import.blocked': 'Fix the errors in the file, then check it again.',
    'import.tooLarge': 'The file is too large (1 MB or 5,000 rows at most).',
    'import.invalidFile': 'The file could not be read.',
    'import.report': 'Check result',
    'import.create': 'To create',
    'import.update': 'To update',
    'import.unchanged': 'Unchanged',
    'import.delete': 'To delete',
    'import.noIssues': 'No issues found.',
    'import.issues': 'Issues',
    'import.colRow': 'Row',
    'import.colSeverity': 'Severity',
    'import.colIssue': 'Issue',
    'import.colDetail': 'Detail',
    'import.applied': 'Import applied.',
    'import.checkAgain': 'Check the file again.',
    'import.replaceTitle': 'Replace the layer?',
    'import.replaceBody': 'Entries not in the file will be deleted. To delete: {count}',
    'import.replaceKeep': 'Keep current entries',
    'import.replaceConfirm': 'Replace layer',
    'export.title': 'Export',
    'export.help': 'Downloads this layer as CSV. Cells that a spreadsheet would read as a formula are made safe.',
    'export.button': 'Export CSV',
    'export.running': 'Exporting…',
    'export.done': 'Export downloaded.',
    'preview.query': 'Query',
    'preview.queryPlaceholder': 'termalpha',
    'preview.help': 'Shows what a search would add for this query. Nothing is saved. Translation pairs never match.',
    'preview.run': 'Preview',
    'preview.running': 'Previewing…',
    'preview.includeDraft': 'Include the entry being edited',
    'preview.needQuery': 'Enter a query.',
    'preview.version': 'Dictionary version',
    'preview.matches': 'Matches',
    'preview.found': 'Found text',
    'preview.layer': 'Layer',
    'preview.added': 'Added to the search',
    'preview.original': 'Original tokens',
    'preview.overrides': 'Overrides',
    'preview.none': 'No dictionary term was found in this query.',
    'preview.capped': 'Some expansions were left out because the limit was reached.',
    'candidates.help': 'Terms from searches that found nothing in this workspace. Add one to the dictionary or dismiss it.',
    'candidates.empty': 'No candidates to review.',
    'candidates.emptyBody': 'Candidates come from searches that found nothing; the operator runs the miner.',
    'candidates.support': 'Queries',
    'candidates.documents': 'Documents',
    'candidates.lastSeen': 'Last seen {date}',
    'candidates.examples': 'Example queries (masked)',
    'candidates.accept': 'Add to dictionary',
    'candidates.acceptAria': 'Add {term} to the dictionary',
    'candidates.dismiss': 'Dismiss',
    'candidates.dismissAria': 'Dismiss {term}',
    'candidates.dismissTitle': 'Dismiss this candidate?',
    'candidates.dismissBody': '“{term}” will not be suggested again.',
    'candidates.dismissKeep': 'Keep candidate',
    'candidates.dismissConfirm': 'Dismiss candidate',
    'candidates.dismissed': 'Candidate dismissed.',
    'candidates.accepted': 'Entry saved and candidate accepted.',
    'candidates.decided': 'This candidate was already decided.',
    'candidates.acceptFailed': 'The entry was saved, but the candidate could not be marked as accepted.',
    'history.versions': 'Versions',
    'history.shared': 'Shared layer: version {version}',
    'history.workspace': 'Workspace layer: version {version}',
    'history.recent': 'Recent changes',
    'history.empty': 'No changes recorded yet.',
    'history.when': 'When',
    'history.action': 'Action',
    'history.term': 'Term',
    'history.version': 'Version',
    'history.by': 'By',
    'audit.create': 'Created',
    'audit.update': 'Updated',
    'audit.delete': 'Deleted',
    'audit.suppress': 'Hidden in workspace',
    'audit.unsuppress': 'Shown again',
    'audit.import': 'Imported',
    'audit.candidate_accept': 'Candidate accepted',
    'audit.candidate_dismiss': 'Candidate dismissed',
  },
  zh: {
    'panel.title': '术语词典',
    'panel.description': '维护用于扩展检索查询的词典：同义词、缩写和其他写法。翻译对仅为翻译功能保存，从不扩展查询。跟随“文档处理”中选择的工作区。',
    'panel.workspaceDefault': '默认工作区',
    'panel.loading': '正在加载词典…',
    'panel.unavailable': '暂时无法获取词典。请稍后选择“重新加载面板”。',
    'panel.loaded': '词典已加载。',
    'layer.legend': '词典层',
    'layer.shared': '共享（所有工作区）',
    'layer.workspace': '工作区（仅此工作区）',
    'tabs.label': '术语词典视图',
    'tab.entries': '词条',
    'tab.import': '导入和导出',
    'tab.preview': '预览',
    'tab.candidates': '候选词',
    'tab.history': '历史',
    'list.search': '搜索词条',
    'list.searchPlaceholder': 'termalpha',
    'list.count': '词条',
    'list.range': '第 {from}–{to} 条，共 {total} 条',
    'list.label': '词典词条',
    'list.empty': '此层还没有词条。',
    'list.emptyBody': '选择“新建词条”创建第一条，或导入 CSV 文件。',
    'list.noMatch': '没有与搜索匹配的词条。',
    'col.term': '术语',
    'col.variants': '变体',
    'col.kind': '类型',
    'col.language': '语言',
    'col.mode': '方式',
    'col.status': '状态',
    'col.actions': '操作',
    'status.enabled': '已启用',
    'status.disabled': '已停用',
    'status.hidden': '已隐藏的共享词条',
    'kind.synonym': '同义词',
    'kind.abbreviation': '缩写',
    'kind.alias': '别名',
    'kind.identifier': '标识符',
    'kind.misspelling': '常见错拼',
    'kind.translation': '翻译对',
    'mode.one_way': '单向',
    'mode.equivalent': '等价',
    'mode.one_wayHelp': '查询中出现变体时，也会检索该术语。',
    'mode.equivalentHelp': '每个成员都会检索其他所有成员。',
    'language.any': '任意语言',
    'language.choose': '选择语言',
    'action.new': '新建词条',
    'action.edit': '编辑',
    'action.editAria': '编辑 {term}',
    'action.delete': '删除',
    'action.deleteAria': '删除 {term}',
    'action.hide': '在工作区中隐藏',
    'action.hideAria': '在此工作区中隐藏 {term}',
    'action.show': '重新使用',
    'action.showAria': '在此工作区中重新使用 {term}',
    'action.save': '保存词条',
    'action.saving': '正在保存词条…',
    'action.cancel': '取消',
    'action.previous': '上一页',
    'action.next': '下一页',
    'action.more': '更多',
    'action.reloadList': '重新加载',
    'form.new': '新建词条',
    'form.edit': '编辑词条',
    'form.candidate': '根据候选词新建词条',
    'form.canonical': '术语',
    'form.canonicalHelp': '文档中使用的术语。',
    'form.canonicalPair': '目标语言术语',
    'form.canonicalPairHelp': '目标语言中的术语。',
    'form.variants': '变体',
    'form.variantsHelp': '人们的其他写法。每行一个，最多 16 个。变体不能包含字符 |。',
    'form.variantsPair': '源语言术语',
    'form.variantsPairHelp': '源语言中的术语，每行一个。翻译对从不扩展查询。',
    'form.variantsPlaceholder': 'termalpha',
    'form.canonicalPlaceholder': 'term alpha beta',
    'form.kind': '类型',
    'form.language': '语言',
    'form.sourceLanguage': '源语言',
    'form.targetLanguage': '目标语言',
    'form.mode': '方式',
    'form.modeFixed': '单向（翻译对始终为单向）',
    'form.enabled': '启用',
    'form.note': '备注',
    'form.noteHelp': '可选，最多 500 个字符。',
    'form.notSaved': '未保存。请修正下面的问题。',
    'form.saved': '词条已保存。',
    'form.warning': '已保存，但有警告：{message}',
    'form.conflict': '自你加载以来，此词典已被更改。',
    'form.conflictBody': '重新加载以查看当前词条。你的草稿会保留在表单中。',
    'issue.conflict': '冲突',
    'issue.chain': '链式映射',
    'issue.cycle': '循环',
    'issue.invalid_variant': '变体无效',
    'issue.invalid_language': '语言无效',
    'issue.invalid_translation': '翻译对无效',
    'issue.limit': '已达上限',
    'issue.duplicate': '重复',
    'issue.override': '覆盖了共享词条',
    'issue.required': '必填',
    'issue.too_long': '过长',
    'issue.too_many': '过多',
    'issue.pipe': '不允许',
    'client.canonicalRequired': '请输入术语。',
    'client.canonicalLong': '术语最多 64 个字符。',
    'client.variantsRequired': '请至少输入一个变体。',
    'client.variantsMany': '最多 16 个变体。',
    'client.variantLong': '每个变体最多 64 个字符。',
    'client.variantPipe': '变体不能包含字符 |。',
    'client.pairLanguages': '请选择源语言和目标语言。',
    'client.pairSame': '源语言和目标语言必须不同。',
    'client.noteLong': '备注最多 500 个字符。',
    'severity.error': '错误',
    'severity.warning': '警告',
    'delete.title': '删除此词条？',
    'delete.body': '一分钟内，检索将不再使用“{term}”。',
    'delete.keep': '保留词条',
    'delete.confirm': '删除词条',
    'delete.running': '正在删除…',
    'delete.done': '词条已删除。',
    'hide.title': '在此工作区中隐藏此共享词条？',
    'hide.body': '此工作区将不再使用“{term}”，其他工作区不受影响。',
    'hide.keep': '继续使用',
    'hide.confirm': '隐藏词条',
    'hide.running': '正在隐藏…',
    'hide.done': '共享词条已在此工作区中隐藏。',
    'show.done': '此工作区已重新使用该共享词条。',
    'import.columns': 'CSV 列',
    'import.col.canonical': '文档中使用的术语（翻译对为目标语言术语）。',
    'import.col.variants': '其他写法，用 | 分隔。',
    'import.col.language': '支持的语言之一，或 any。',
    'import.col.kind': 'synonym、abbreviation、alias、identifier、misspelling 或 translation。',
    'import.col.mode': 'one_way 或 equivalent；翻译对为 one_way。',
    'import.col.enabled': 'true 或 false。',
    'import.col.note': '可选文本，最多 500 个字符。',
    'import.col.source_language': '仅限翻译对：源语言。',
    'import.col.target_language': '仅限翻译对：目标语言。',
    'import.limits': 'UTF-8，最多 1 MB、5,000 行。也接受 DictionaryCandidate 导出的 .jsonl 文件。',
    'import.file': '文件',
    'import.mode': '导入方式',
    'import.merge': '合并（新增和更新）',
    'import.replace': '替换（此层与文件完全一致）',
    'import.check': '检查文件',
    'import.checking': '正在检查…',
    'import.apply': '执行导入',
    'import.applying': '正在导入…',
    'import.needFile': '请先选择文件。',
    'import.needCheck': '执行前请先检查文件。',
    'import.blocked': '请修正文件中的错误，然后重新检查。',
    'import.tooLarge': '文件过大（最多 1 MB 或 5,000 行）。',
    'import.invalidFile': '无法读取该文件。',
    'import.report': '检查结果',
    'import.create': '将新增',
    'import.update': '将更新',
    'import.unchanged': '不变',
    'import.delete': '将删除',
    'import.noIssues': '未发现问题。',
    'import.issues': '问题',
    'import.colRow': '行',
    'import.colSeverity': '级别',
    'import.colIssue': '问题',
    'import.colDetail': '详情',
    'import.applied': '导入已执行。',
    'import.checkAgain': '请重新检查文件。',
    'import.replaceTitle': '替换此层？',
    'import.replaceBody': '不在文件中的词条将被删除。将删除：{count}',
    'import.replaceKeep': '保留当前词条',
    'import.replaceConfirm': '替换此层',
    'export.title': '导出',
    'export.help': '将此层下载为 CSV。可能被电子表格当作公式的单元格会被处理为安全内容。',
    'export.button': '导出 CSV',
    'export.running': '正在导出…',
    'export.done': '导出文件已下载。',
    'preview.query': '查询',
    'preview.queryPlaceholder': 'termalpha',
    'preview.help': '显示检索会为此查询添加的内容。不会保存任何内容。翻译对从不匹配。',
    'preview.run': '预览',
    'preview.running': '正在预览…',
    'preview.includeDraft': '包含正在编辑的词条',
    'preview.needQuery': '请输入查询。',
    'preview.version': '词典版本',
    'preview.matches': '匹配',
    'preview.found': '找到的文本',
    'preview.layer': '层',
    'preview.added': '添加到检索',
    'preview.original': '原始词元',
    'preview.overrides': '覆盖',
    'preview.none': '此查询中未找到词典术语。',
    'preview.capped': '已达上限，部分扩展未加入。',
    'candidates.help': '来自此工作区中未找到结果的检索的词。可将其加入词典或忽略。',
    'candidates.empty': '没有待审核的候选词。',
    'candidates.emptyBody': '候选词来自未找到结果的检索；由运维人员运行挖掘程序。',
    'candidates.support': '查询',
    'candidates.documents': '文档',
    'candidates.lastSeen': '最近出现：{date}',
    'candidates.examples': '示例查询（已脱敏）',
    'candidates.accept': '加入词典',
    'candidates.acceptAria': '将 {term} 加入词典',
    'candidates.dismiss': '忽略',
    'candidates.dismissAria': '忽略 {term}',
    'candidates.dismissTitle': '忽略此候选词？',
    'candidates.dismissBody': '“{term}”将不会再被推荐。',
    'candidates.dismissKeep': '保留候选词',
    'candidates.dismissConfirm': '忽略候选词',
    'candidates.dismissed': '候选词已忽略。',
    'candidates.accepted': '词条已保存，候选词已接受。',
    'candidates.decided': '此候选词已被处理。',
    'candidates.acceptFailed': '词条已保存，但无法将候选词标记为已接受。',
    'history.versions': '版本',
    'history.shared': '共享层：版本 {version}',
    'history.workspace': '工作区层：版本 {version}',
    'history.recent': '最近更改',
    'history.empty': '尚无更改记录。',
    'history.when': '时间',
    'history.action': '操作',
    'history.term': '术语',
    'history.version': '版本',
    'history.by': '操作人',
    'audit.create': '已创建',
    'audit.update': '已更新',
    'audit.delete': '已删除',
    'audit.suppress': '已在工作区中隐藏',
    'audit.unsuppress': '已重新使用',
    'audit.import': '已导入',
    'audit.candidate_accept': '已接受候选词',
    'audit.candidate_dismiss': '已忽略候选词',
  },
  it: {
    'panel.title': 'Terminologia',
    'panel.description':
      'Gestisce il dizionario che amplia le query di ricerca con sinonimi, abbreviazioni e altre grafie. Le coppie di traduzione sono salvate per le funzioni di traduzione e non ampliano mai una query. Segue lo spazio di lavoro scelto in Document Processing.',
    'panel.workspaceDefault': 'Spazio di lavoro predefinito',
    'panel.loading': 'Caricamento del dizionario…',
    'panel.unavailable': 'Il dizionario non è disponibile. Seleziona Ricarica pannello tra poco.',
    'panel.loaded': 'Dizionario caricato.',
    'layer.legend': 'Livello del dizionario',
    'layer.shared': 'Condiviso (tutti gli spazi di lavoro)',
    'layer.workspace': 'Spazio di lavoro (solo questo)',
    'tabs.label': 'Viste della terminologia',
    'tab.entries': 'Voci',
    'tab.import': 'Importa ed esporta',
    'tab.preview': 'Anteprima',
    'tab.candidates': 'Candidati',
    'tab.history': 'Cronologia',
    'list.search': 'Cerca termini',
    'list.searchPlaceholder': 'termalpha',
    'list.count': 'Voci',
    'list.range': '{from}–{to} di {total}',
    'list.label': 'Voci del dizionario',
    'list.empty': 'Questo livello non ha ancora voci.',
    'list.emptyBody': 'Crea la prima con Nuova voce, oppure importa un file CSV.',
    'list.noMatch': 'Nessuna voce corrisponde alla ricerca.',
    'col.term': 'Termine',
    'col.variants': 'Varianti',
    'col.kind': 'Tipo',
    'col.language': 'Lingua',
    'col.mode': 'Modalità',
    'col.status': 'Stato',
    'col.actions': 'Azioni',
    'status.enabled': 'Attiva',
    'status.disabled': 'Disattivata',
    'status.hidden': 'Voce condivisa nascosta',
    'kind.synonym': 'Sinonimo',
    'kind.abbreviation': 'Abbreviazione',
    'kind.alias': 'Alias',
    'kind.identifier': 'Identificativo',
    'kind.misspelling': 'Errore di grafia',
    'kind.translation': 'Coppia di traduzione',
    'mode.one_way': 'Unidirezionale',
    'mode.equivalent': 'Equivalente',
    'mode.one_wayHelp': 'Una variante nella query trova anche il termine.',
    'mode.equivalentHelp': 'Ogni membro trova tutti gli altri.',
    'language.any': 'Qualsiasi lingua',
    'language.choose': 'Scegli una lingua',
    'action.new': 'Nuova voce',
    'action.edit': 'Modifica',
    'action.editAria': 'Modifica {term}',
    'action.delete': 'Elimina',
    'action.deleteAria': 'Elimina {term}',
    'action.hide': 'Nascondi nello spazio di lavoro',
    'action.hideAria': 'Nascondi {term} in questo spazio di lavoro',
    'action.show': 'Mostra di nuovo',
    'action.showAria': 'Usa di nuovo {term} in questo spazio di lavoro',
    'action.save': 'Salva la voce',
    'action.saving': 'Salvataggio della voce…',
    'action.cancel': 'Annulla',
    'action.previous': 'Precedenti',
    'action.next': 'Successive',
    'action.more': 'Altro',
    'action.reloadList': 'Ricarica',
    'form.new': 'Nuova voce',
    'form.edit': 'Modifica voce',
    'form.candidate': 'Nuova voce da un candidato',
    'form.canonical': 'Termine',
    'form.canonicalHelp': 'Il termine usato nei documenti.',
    'form.canonicalPair': 'Termine nella lingua di destinazione',
    'form.canonicalPairHelp': 'Il termine nella lingua di destinazione.',
    'form.variants': 'Varianti',
    'form.variantsHelp': 'Altri modi in cui viene scritto. Una per riga, al massimo 16. Una variante non può contenere il carattere |.',
    'form.variantsPair': 'Termini nella lingua di origine',
    'form.variantsPairHelp': 'I termini nella lingua di origine, uno per riga. Una coppia di traduzione non amplia mai una query.',
    'form.variantsPlaceholder': 'termalpha',
    'form.canonicalPlaceholder': 'term alpha beta',
    'form.kind': 'Tipo',
    'form.language': 'Lingua',
    'form.sourceLanguage': 'Lingua di origine',
    'form.targetLanguage': 'Lingua di destinazione',
    'form.mode': 'Modalità',
    'form.modeFixed': 'Unidirezionale (sempre, per una coppia di traduzione)',
    'form.enabled': 'Attiva',
    'form.note': 'Nota',
    'form.noteHelp': 'Facoltativa, al massimo 500 caratteri.',
    'form.notSaved': 'Non salvata. Correggi i problemi qui sotto.',
    'form.saved': 'Voce salvata.',
    'form.warning': 'Salvata con un avviso: {message}',
    'form.conflict': 'Questo dizionario è cambiato dopo il caricamento.',
    'form.conflictBody': 'Ricarica per vedere le voci attuali. La bozza resta nel modulo.',
    'issue.conflict': 'Conflitto',
    'issue.chain': 'Catena',
    'issue.cycle': 'Ciclo',
    'issue.invalid_variant': 'Variante non valida',
    'issue.invalid_language': 'Lingua non valida',
    'issue.invalid_translation': 'Coppia di traduzione non valida',
    'issue.limit': 'Limite raggiunto',
    'issue.duplicate': 'Duplicato',
    'issue.override': 'Sostituisce una voce condivisa',
    'issue.required': 'Obbligatorio',
    'issue.too_long': 'Troppo lungo',
    'issue.too_many': 'Troppi',
    'issue.pipe': 'Non consentito',
    'client.canonicalRequired': 'Inserisci il termine.',
    'client.canonicalLong': 'Il termine ha al massimo 64 caratteri.',
    'client.variantsRequired': 'Inserisci almeno una variante.',
    'client.variantsMany': 'Al massimo 16 varianti.',
    'client.variantLong': 'Ogni variante ha al massimo 64 caratteri.',
    'client.variantPipe': 'Una variante non può contenere il carattere |.',
    'client.pairLanguages': 'Scegli una lingua di origine e una di destinazione.',
    'client.pairSame': 'La lingua di origine e quella di destinazione devono essere diverse.',
    'client.noteLong': 'La nota ha al massimo 500 caratteri.',
    'severity.error': 'Errore',
    'severity.warning': 'Avviso',
    'delete.title': 'Eliminare questa voce?',
    'delete.body': 'Entro un minuto le ricerche smettono di usare «{term}».',
    'delete.keep': 'Mantieni la voce',
    'delete.confirm': 'Elimina la voce',
    'delete.running': 'Eliminazione…',
    'delete.done': 'Voce eliminata.',
    'hide.title': 'Nascondere questa voce condivisa in questo spazio di lavoro?',
    'hide.body': 'Questo spazio di lavoro smette di usare «{term}». Gli altri la mantengono.',
    'hide.keep': 'Continua a usarla',
    'hide.confirm': 'Nascondi la voce',
    'hide.running': 'Occultamento…',
    'hide.done': 'Voce condivisa nascosta in questo spazio di lavoro.',
    'show.done': 'Voce condivisa di nuovo in uso in questo spazio di lavoro.',
    'import.columns': 'Colonne CSV',
    'import.col.canonical': 'Il termine usato nei documenti (per una coppia di traduzione, il termine nella lingua di destinazione).',
    'import.col.variants': 'Altre grafie, separate da |.',
    'import.col.language': 'Una lingua supportata, oppure any.',
    'import.col.kind': 'synonym, abbreviation, alias, identifier, misspelling o translation.',
    'import.col.mode': 'one_way o equivalent; le coppie di traduzione sono one_way.',
    'import.col.enabled': 'true o false.',
    'import.col.note': 'Testo facoltativo, al massimo 500 caratteri.',
    'import.col.source_language': 'Solo coppie di traduzione: la lingua di origine.',
    'import.col.target_language': 'Solo coppie di traduzione: la lingua di destinazione.',
    'import.limits': 'UTF-8, al massimo 1 MB e 5.000 righe. È accettata anche un’esportazione DictionaryCandidate .jsonl.',
    'import.file': 'File',
    'import.mode': 'Modalità di importazione',
    'import.merge': 'Unisci (aggiungi e aggiorna)',
    'import.replace': 'Sostituisci (il livello diventa esattamente il file)',
    'import.check': 'Controlla il file',
    'import.checking': 'Controllo…',
    'import.apply': 'Applica l’importazione',
    'import.applying': 'Importazione…',
    'import.needFile': 'Scegli prima un file.',
    'import.needCheck': 'Controlla il file prima di applicarlo.',
    'import.blocked': 'Correggi gli errori nel file, poi controllalo di nuovo.',
    'import.tooLarge': 'Il file è troppo grande (al massimo 1 MB o 5.000 righe).',
    'import.invalidFile': 'Non è stato possibile leggere il file.',
    'import.report': 'Risultato del controllo',
    'import.create': 'Da creare',
    'import.update': 'Da aggiornare',
    'import.unchanged': 'Invariate',
    'import.delete': 'Da eliminare',
    'import.noIssues': 'Nessun problema trovato.',
    'import.issues': 'Problemi',
    'import.colRow': 'Riga',
    'import.colSeverity': 'Gravità',
    'import.colIssue': 'Problema',
    'import.colDetail': 'Dettaglio',
    'import.applied': 'Importazione applicata.',
    'import.checkAgain': 'Controlla di nuovo il file.',
    'import.replaceTitle': 'Sostituire il livello?',
    'import.replaceBody': 'Le voci che non sono nel file verranno eliminate. Da eliminare: {count}',
    'import.replaceKeep': 'Mantieni le voci attuali',
    'import.replaceConfirm': 'Sostituisci il livello',
    'export.title': 'Esporta',
    'export.help': 'Scarica questo livello in CSV. Le celle che un foglio di calcolo leggerebbe come formula vengono rese sicure.',
    'export.button': 'Esporta CSV',
    'export.running': 'Esportazione…',
    'export.done': 'Esportazione scaricata.',
    'preview.query': 'Query',
    'preview.queryPlaceholder': 'termalpha',
    'preview.help': 'Mostra cosa aggiungerebbe una ricerca per questa query. Non viene salvato nulla. Le coppie di traduzione non corrispondono mai.',
    'preview.run': 'Anteprima',
    'preview.running': 'Anteprima in corso…',
    'preview.includeDraft': 'Includi la voce in modifica',
    'preview.needQuery': 'Inserisci una query.',
    'preview.version': 'Versione del dizionario',
    'preview.matches': 'Corrispondenze',
    'preview.found': 'Testo trovato',
    'preview.layer': 'Livello',
    'preview.added': 'Aggiunti alla ricerca',
    'preview.original': 'Token originali',
    'preview.overrides': 'Sostituzioni',
    'preview.none': 'Nessun termine del dizionario trovato in questa query.',
    'preview.capped': 'Alcune espansioni sono state escluse perché è stato raggiunto il limite.',
    'candidates.help': 'Termini da ricerche senza risultati in questo spazio di lavoro. Aggiungine uno al dizionario o ignoralo.',
    'candidates.empty': 'Nessun candidato da esaminare.',
    'candidates.emptyBody': 'I candidati provengono da ricerche senza risultati; l’operatore esegue l’estrazione.',
    'candidates.support': 'Query',
    'candidates.documents': 'Documenti',
    'candidates.lastSeen': 'Visto l’ultima volta {date}',
    'candidates.examples': 'Query di esempio (mascherate)',
    'candidates.accept': 'Aggiungi al dizionario',
    'candidates.acceptAria': 'Aggiungi {term} al dizionario',
    'candidates.dismiss': 'Ignora',
    'candidates.dismissAria': 'Ignora {term}',
    'candidates.dismissTitle': 'Ignorare questo candidato?',
    'candidates.dismissBody': '«{term}» non verrà più proposto.',
    'candidates.dismissKeep': 'Mantieni il candidato',
    'candidates.dismissConfirm': 'Ignora il candidato',
    'candidates.dismissed': 'Candidato ignorato.',
    'candidates.accepted': 'Voce salvata e candidato accettato.',
    'candidates.decided': 'Questo candidato è già stato deciso.',
    'candidates.acceptFailed': 'La voce è stata salvata, ma non è stato possibile segnare il candidato come accettato.',
    'history.versions': 'Versioni',
    'history.shared': 'Livello condiviso: versione {version}',
    'history.workspace': 'Livello dello spazio di lavoro: versione {version}',
    'history.recent': 'Modifiche recenti',
    'history.empty': 'Nessuna modifica registrata.',
    'history.when': 'Quando',
    'history.action': 'Azione',
    'history.term': 'Termine',
    'history.version': 'Versione',
    'history.by': 'Da',
    'audit.create': 'Creata',
    'audit.update': 'Aggiornata',
    'audit.delete': 'Eliminata',
    'audit.suppress': 'Nascosta nello spazio di lavoro',
    'audit.unsuppress': 'Mostrata di nuovo',
    'audit.import': 'Importata',
    'audit.candidate_accept': 'Candidato accettato',
    'audit.candidate_dismiss': 'Candidato ignorato',
  },
};

const TERMINOLOGY_PATH = '/api/rag/admin/terminology';
const TERMINOLOGY_KINDS = ['synonym', 'abbreviation', 'alias', 'identifier', 'misspelling', 'translation'];
const TERMINOLOGY_MODES = ['one_way', 'equivalent'];
const TERMINOLOGY_ANY = 'any';
const TERMINOLOGY_PAGE = 25;
const TERMINOLOGY_AUDIT_PAGE = 20;
const TERMINOLOGY_MAX_TERM = 64;
const TERMINOLOGY_MAX_VARIANTS = 16;
const TERMINOLOGY_MAX_NOTE = 500;
const TERMINOLOGY_MAX_QUERY = 1000;
const TERMINOLOGY_MAX_FILE_BYTES = 1024 * 1024;
const TERMINOLOGY_CSV_COLUMNS = ['canonical', 'variants', 'language', 'kind', 'mode', 'enabled', 'note', 'source_language', 'target_language'];
const TERMINOLOGY_ISSUE_CODES = new Set(['conflict', 'chain', 'cycle', 'invalid_variant', 'invalid_language', 'invalid_translation', 'limit', 'duplicate', 'override', 'required', 'too_long', 'too_many', 'pipe']);
const TERMINOLOGY_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

let terminologyUi = null;
if (typeof require !== 'undefined') {
  try {
    terminologyUi = require('./rag-ui.js');
  } catch {
    terminologyUi = null;
  }
}

function terminologyUiLib() {
  if (terminologyUi) return terminologyUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

function terminologyLabel(key, locale, vars) {
  const ui = terminologyUiLib();
  const text = ui.ragUiLookup(TERMINOLOGY_LABELS, key, locale, vars);
  return text === undefined ? ui.ragUiLabel(key, locale, vars) : text;
}

function terminologyText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function terminologyIsCode(value) {
  return typeof value === 'string' && value.length <= 32 && TERMINOLOGY_CODE.test(value);
}

/** The enabled languages of a route answer: registry codes only, in the server's order (D-35). */
function terminologyEnabled(list) {
  return Array.isArray(list) ? list.filter(terminologyIsCode) : [];
}

/** A language's name in its own language (Intl), first letter upper-cased; 'any' localized; the code when unknown. */
function terminologyLanguageName(code, locale) {
  if (code === TERMINOLOGY_ANY) return terminologyLabel('language.any', locale);
  if (!terminologyIsCode(code)) return terminologyText(code);
  try {
    const display = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames([code], { type: 'language' }) : null;
    const name = display ? display.of(code) : null;
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
  return code;
}

function terminologyDate(value, locale) {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale || 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

function terminologyKindLabel(kind, locale) {
  return TERMINOLOGY_KINDS.includes(kind) ? terminologyLabel('kind.' + kind, locale) : terminologyText(kind);
}

/** One list row as plain strings (UI-SPEC 4.2). */
function buildEntryView(item, locale) {
  const e = item && typeof item === 'object' ? item : {};
  const variants = Array.isArray(e.variants) ? e.variants.map(terminologyText) : [];
  const suppression = typeof e.suppresses_entry_id === 'string' && e.suppresses_entry_id !== '';
  const pair = e.kind === 'translation';
  const language = pair
    ? terminologyLanguageName(e.source_language, locale) + ' → ' + terminologyLanguageName(e.target_language, locale)
    : terminologyLanguageName(e.language, locale);
  const status = suppression ? 'status.hidden' : e.enabled === false ? 'status.disabled' : 'status.enabled';
  return {
    id: terminologyText(e.id),
    canonical: terminologyText(e.canonical),
    variants: variants.join(', '),
    kind: terminologyKindLabel(e.kind, locale),
    language,
    mode: TERMINOLOGY_MODES.includes(e.mode) ? terminologyLabel('mode.' + e.mode, locale) : terminologyText(e.mode),
    status: terminologyLabel(status, locale),
    note: terminologyText(e.note),
    enabled: e.enabled !== false,
    suppression,
    suppressesEntryId: suppression ? e.suppresses_entry_id : null,
  };
}

function terminologyEmptyDraft() {
  return { canonical: '', variantsText: '', kind: 'synonym', language: TERMINOLOGY_ANY, source_language: '', target_language: '', mode: 'one_way', enabled: true, note: '' };
}

function terminologyDraftFromEntry(item) {
  const e = item && typeof item === 'object' ? item : {};
  return {
    canonical: terminologyText(e.canonical),
    variantsText: Array.isArray(e.variants) ? e.variants.map(terminologyText).join('\n') : '',
    kind: TERMINOLOGY_KINDS.includes(e.kind) ? e.kind : 'synonym',
    language: terminologyText(e.language) || TERMINOLOGY_ANY,
    source_language: terminologyText(e.source_language),
    target_language: terminologyText(e.target_language),
    mode: TERMINOLOGY_MODES.includes(e.mode) ? e.mode : 'one_way',
    enabled: e.enabled !== false,
    note: terminologyText(e.note),
  };
}

/**
 * The form descriptor (UI-SPEC 4.3): field name, label, control, options and value. A translation pair has a source and a
 * target select of exactly the enabled languages and a fixed one_way mode; every other kind has one language select of
 * any plus the enabled languages.
 */
function buildEntryForm(draft, enabledLanguages, locale) {
  const d = { ...terminologyEmptyDraft(), ...(draft || {}) };
  const enabled = terminologyEnabled(enabledLanguages);
  const t = (key) => terminologyLabel(key, locale);
  const pair = d.kind === 'translation';
  const languageOptions = (codes) => codes.map((code) => ({ value: code, label: terminologyLanguageName(code, locale), lang: code === TERMINOLOGY_ANY ? null : code }));
  const fields = [
    {
      name: 'canonical',
      label: t(pair ? 'form.canonicalPair' : 'form.canonical'),
      help: t(pair ? 'form.canonicalPairHelp' : 'form.canonicalHelp'),
      control: 'text',
      value: d.canonical,
      maxLength: TERMINOLOGY_MAX_TERM,
      required: true,
      placeholder: t('form.canonicalPlaceholder'),
    },
    {
      name: 'variants',
      label: t(pair ? 'form.variantsPair' : 'form.variants'),
      help: t(pair ? 'form.variantsPairHelp' : 'form.variantsHelp'),
      control: 'textarea',
      value: d.variantsText,
      required: true,
      placeholder: t('form.variantsPlaceholder'),
    },
    { name: 'kind', label: t('form.kind'), control: 'select', value: d.kind, options: TERMINOLOGY_KINDS.map((kind) => ({ value: kind, label: terminologyKindLabel(kind, locale) })) },
  ];
  if (pair) {
    fields.push(
      { name: 'source_language', label: t('form.sourceLanguage'), control: 'select', value: d.source_language, placeholder: t('language.choose'), options: languageOptions(enabled) },
      { name: 'target_language', label: t('form.targetLanguage'), control: 'select', value: d.target_language, placeholder: t('language.choose'), options: languageOptions(enabled) },
      { name: 'mode', label: t('form.mode'), control: 'fixed', value: 'one_way', text: t('form.modeFixed') },
    );
  } else {
    const language = d.language === TERMINOLOGY_ANY || enabled.includes(d.language) ? d.language : TERMINOLOGY_ANY;
    fields.push(
      { name: 'language', label: t('form.language'), control: 'select', value: language, options: languageOptions([TERMINOLOGY_ANY, ...enabled]) },
      {
        name: 'mode',
        label: t('form.mode'),
        control: 'select',
        value: TERMINOLOGY_MODES.includes(d.mode) ? d.mode : 'one_way',
        help: t(d.mode === 'equivalent' ? 'mode.equivalentHelp' : 'mode.one_wayHelp'),
        options: TERMINOLOGY_MODES.map((mode) => ({ value: mode, label: terminologyLabel('mode.' + mode, locale) })),
      },
    );
  }
  fields.push(
    { name: 'enabled', label: t('form.enabled'), control: 'checkbox', value: d.enabled !== false },
    { name: 'note', label: t('form.note'), help: t('form.noteHelp'), control: 'textarea', value: d.note, maxLength: TERMINOLOGY_MAX_NOTE },
  );
  return { pair, fields };
}

/** The field an issue belongs next to (UI-SPEC 6.3); client issues name their field. */
function terminologyIssueField(issue, kind) {
  if (issue && typeof issue.field === 'string') return issue.field;
  const pair = kind === 'translation';
  switch (issue && issue.code) {
    case 'conflict':
    case 'chain':
    case 'cycle':
    case 'duplicate':
    case 'invalid_variant':
      return 'variants';
    case 'invalid_language':
      return pair ? 'source_language' : 'language';
    case 'invalid_translation':
      return pair ? 'target_language' : 'kind';
    case 'override':
      return 'canonical';
    default:
      return 'summary';
  }
}

function buildIssueList(issues, kind, locale) {
  return (Array.isArray(issues) ? issues : [])
    .filter((issue) => issue && typeof issue === 'object')
    .map((issue) => {
      const code = terminologyText(issue.code);
      return {
        field: terminologyIssueField(issue, kind),
        severity: issue.severity === 'warning' ? 'warning' : 'error',
        code,
        label: TERMINOLOGY_ISSUE_CODES.has(code) ? terminologyLabel('issue.' + code, locale) : code,
        message: terminologyText(issue.message),
        row: Number.isInteger(issue.row) ? issue.row : null,
      };
    });
}

function terminologyCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** The dry-run or apply report (UI-SPEC 4.6): the four counts, the issues, and whether an error blocks apply. */
function buildImportReport(report, locale) {
  const r = report && typeof report === 'object' ? report : {};
  const counts = ['create', 'update', 'unchanged', 'delete'].map((key) => ({ key, label: terminologyLabel('import.' + key, locale), value: terminologyCount(r[key]) }));
  const issues = buildIssueList(r.issues, null, locale);
  return {
    counts,
    issues,
    blocking: issues.some((issue) => issue.severity === 'error'),
    applied: r.applied === true,
    versionSeen: Number.isInteger(r.layer_version_seen) ? r.layer_version_seen : null,
    deletes: terminologyCount(r.delete),
  };
}

/** One candidate as plain strings (UI-SPEC 4.8); examples are already masked and stay text. */
function buildCandidateView(candidate, locale) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const ui = terminologyUiLib();
  const date = terminologyDate(c.last_seen, locale);
  return {
    id: terminologyText(c.id),
    term: terminologyText(c.term),
    language: terminologyLanguageName(terminologyText(c.language) || TERMINOLOGY_ANY, locale),
    support: ui.ragUiCount(terminologyLabel('candidates.support', locale), terminologyCount(c.support), locale),
    documents: ui.ragUiCount(terminologyLabel('candidates.documents', locale), terminologyCount(c.corpus_df), locale),
    lastSeen: date ? terminologyLabel('candidates.lastSeen', locale, { date }) : '',
    examples: Array.isArray(c.examples) ? c.examples.slice(0, 3).map(terminologyText) : [],
  };
}

/** D-26: accepting a candidate opens the create form with the observed term as the first variant. */
function candidateDraft(candidate, enabledLanguages) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const enabled = terminologyEnabled(enabledLanguages);
  return { ...terminologyEmptyDraft(), variantsText: terminologyText(c.term), language: enabled.includes(c.language) ? c.language : TERMINOLOGY_ANY };
}

function terminologyVariants(text) {
  return terminologyText(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Client checks before a request (UI-SPEC 4.3); same issue shape as the server's, with the field named. */
function terminologyClientIssues(draft, locale) {
  const t = (key) => terminologyLabel(key, locale);
  const issues = [];
  const add = (field, code, key) => issues.push({ field, code, severity: 'error', message: t(key) });
  const canonical = terminologyText(draft.canonical).trim();
  if (!canonical) add('canonical', 'required', 'client.canonicalRequired');
  else if (canonical.length > TERMINOLOGY_MAX_TERM) add('canonical', 'too_long', 'client.canonicalLong');
  const variants = terminologyVariants(draft.variantsText);
  if (variants.length === 0) add('variants', 'required', 'client.variantsRequired');
  if (variants.length > TERMINOLOGY_MAX_VARIANTS) add('variants', 'too_many', 'client.variantsMany');
  if (variants.some((v) => v.length > TERMINOLOGY_MAX_TERM)) add('variants', 'too_long', 'client.variantLong');
  if (variants.some((v) => v.includes('|'))) add('variants', 'pipe', 'client.variantPipe');
  if (draft.kind === 'translation') {
    if (!draft.source_language || !draft.target_language) add(draft.source_language ? 'target_language' : 'source_language', 'required', 'client.pairLanguages');
    else if (draft.source_language === draft.target_language) add('target_language', 'invalid_translation', 'client.pairSame');
  }
  if (terminologyText(draft.note).length > TERMINOLOGY_MAX_NOTE) add('note', 'too_long', 'client.noteLong');
  return issues;
}

/** The entry fields of a create or patch body; a translation pair takes its source as its language and is one_way. */
function terminologyEntryFields(draft) {
  const pair = draft.kind === 'translation';
  const note = terminologyText(draft.note).trim();
  return {
    canonical: terminologyText(draft.canonical).trim(),
    variants: terminologyVariants(draft.variantsText),
    kind: draft.kind,
    language: pair ? draft.source_language : draft.language || TERMINOLOGY_ANY,
    mode: pair ? 'one_way' : draft.mode,
    source_language: pair ? draft.source_language : null,
    target_language: pair ? draft.target_language : null,
    enabled: draft.enabled !== false,
    note: note ? note : null,
  };
}

function terminologyBody(result) {
  return result && result.body && typeof result.body === 'object' ? result.body : {};
}

function terminologyIsVersionConflict(result) {
  return Boolean(result && !result.thrown && result.status === 409 && terminologyBody(result).error === 'version_conflict');
}

class TerminologyPanel {
  constructor(root) {
    this.root = root;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.locale = terminologyUiLib().ragUiBrowserLocale();
    this.organizationId = null;
    this.layer = 'shared';
    this.singleTenant = true;
    this.versions = null;
    this.enabled = [];
    this.list = null;
    this.search = '';
    this.offset = 0;
    this.layerVersion = null;
    this.editor = null;
    this.imports = { file: null, text: null, format: 'csv', mode: 'merge', report: null, checkedKey: null, errors: null, alert: null };
    this.preview = { query: '', includeDraft: true, result: null, alert: null };
    this.candidates = { items: [], nextOffset: null, loaded: false };
    this.audit = { items: [], total: 0, loaded: false };
    this.seq = 0;
    this.loadAlert = null;
    this.searchTimer = null;
    this.hosts = {};
    this.tabs = null;
  }

  t(key, vars) {
    return terminologyLabel(key, this.locale, vars);
  }

  ui() {
    return terminologyUiLib();
  }

  el(tag, options, children) {
    return this.ui().ragUiEl(this.doc, tag, options, children);
  }

  btn(text, options, onClick) {
    const opts = options || {};
    const button = this.el('button', { className: opts.className || 'btn md:btn-sm', text, attrs: { type: 'button', ...(opts.attrs || {}) } });
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  announce(text, isError) {
    const host = this.root.querySelector('[data-terminology-status]');
    if (!host) return;
    host.classList.toggle('text-error', Boolean(isError));
    if (isError) host.replaceChildren(this.ui().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text }));
    else host.textContent = text;
  }

  /** Query string with the layer (when asked) and the selected organization; never a tenant key. */
  query(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value === null || value === undefined || value === '') continue;
      search.set(key, String(value));
    }
    if (this.organizationId) search.set('organization_id', this.organizationId);
    const text = search.toString();
    return text ? '?' + text : '';
  }

  withOrganization(body) {
    if (this.organizationId) body.organization_id = this.organizationId;
    return body;
  }

  request(subPath, params, init) {
    return this.ui().ragUiRagRequest(TERMINOLOGY_PATH + (subPath || '') + this.query(params), init || { method: 'GET' });
  }

  async mount() {
    this.root.setAttribute('lang', this.locale);
    const title = this.root.querySelector('[data-terminology-title]');
    if (title) title.textContent = this.t('panel.title');
    const description = this.root.querySelector('[data-terminology-description]');
    if (description) description.textContent = this.t('panel.description');
    this.hosts.layer = this.el('div', { className: 'min-w-0 mb-4 empty:mb-0' });
    this.hosts.entries = this.el('div', { className: 'flex flex-col gap-4 min-w-0' });
    this.hosts.import = this.el('div', { className: 'flex flex-col gap-6 min-w-0' });
    this.hosts.preview = this.el('div', { className: 'flex flex-col gap-4 min-w-0' });
    this.hosts.candidates = this.el('div', { className: 'flex flex-col gap-4 min-w-0' });
    this.hosts.history = this.el('div', { className: 'flex flex-col gap-4 min-w-0' });
    this.tabs = this.ui().ragUiSubTabs(this.doc, {
      label: this.t('tabs.label'),
      idPrefix: 'rag-terminology',
      tabs: [
        { id: 'entries', label: this.t('tab.entries') },
        { id: 'import', label: this.t('tab.import') },
        { id: 'preview', label: this.t('tab.preview') },
        { id: 'candidates', label: this.t('tab.candidates') },
        { id: 'history', label: this.t('tab.history') },
      ],
      selected: 'entries',
      onSelect: (id) => this.onTab(id),
    });
    for (const id of Object.keys(this.tabs.panels)) this.tabs.panels[id].appendChild(this.hosts[id]);
    const content = this.root.querySelector('[data-terminology-content]');
    if (content) content.replaceChildren(this.hosts.layer, this.tabs.tablist, ...Object.values(this.tabs.panels));
    this.bindWorkspace();
    await this.load('first');
  }

  async refresh() {
    this.readWorkspace();
    await this.load('panel');
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
    const line = this.root.querySelector('[data-terminology-workspace]');
    if (line) line.textContent = this.singleTenant ? '' : this.ui().ragUiLabel('panel.workspace', this.locale, { name: this.workspaceName() });
  }

  bindWorkspace() {
    const selector = this.selector();
    this.readWorkspace();
    if (!selector) return;
    selector.addEventListener('change', async () => {
      this.readWorkspace();
      this.editor = null;
      this.offset = 0;
      this.candidates = { items: [], nextOffset: null, loaded: false };
      this.audit = { items: [], total: 0, loaded: false };
      this.imports.report = null;
      this.imports.checkedKey = null;
      this.preview.result = null;
      await this.load('first');
    });
  }

  setAlert(node) {
    this.loadAlert = node;
    this.renderAlerts();
  }

  renderAlerts() {
    const host = this.root.querySelector('[data-terminology-alert]');
    if (!host) return;
    const nodes = [];
    if (this.versions && this.enabled.length === 0) {
      nodes.push(this.ui().ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.ui().ragUiLabel('error.languagesNotConfigured', this.locale)] }));
    }
    if (this.loadAlert) nodes.push(this.loadAlert);
    host.replaceChildren(...nodes);
  }

  /** Sign-in, workspace and unavailable answers become the panel alert; returns the mapped message. */
  failed(result) {
    const ui = this.ui();
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('panel.unavailable') });
    const reload = () => this.refresh();
    if (mapped.kind === 'signIn') this.setAlert(ui.ragUiSignInAlert(this.doc, this.locale, reload));
    else if (mapped.kind === 'workspace') this.setAlert(ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [mapped.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, reload)] }));
    else if (mapped.kind === 'unavailable' || mapped.kind === 'network') this.setAlert(ui.ragUiUnavailableAlert(this.doc, this.locale, mapped.message, reload));
    return mapped;
  }

  conflictAlert(onReload, bodyKey) {
    const ui = this.ui();
    return ui.ragUiAlert(this.doc, {
      tone: 'warning',
      icon: 'arrow-repeat',
      title: this.t('form.conflict'),
      body: [this.t(bodyKey || 'form.conflictBody')],
      role: 'alert',
      actions: [this.btn(this.t('action.reloadList'), { className: 'btn btn-sm' }, onReload)],
    });
  }

  async load(source) {
    const ui = this.ui();
    const seq = ++this.seq;
    const hadContent = Boolean(this.list);
    if (hadContent) ui.ragUiListBusy(this.hosts.entries, true);
    else ui.ragUiListLoading(this.doc, this.hosts.entries, this.t('panel.loading'));
    const versions = await this.request('/versions', {});
    if (seq !== this.seq) return;
    if (!(versions && versions.ok)) {
      ui.ragUiListBusy(this.hosts.entries, false);
      if (!hadContent) this.hosts.entries.replaceChildren();
      const mapped = this.failed(versions);
      this.announce(mapped.message, true);
      return;
    }
    this.applyVersions(terminologyBody(versions));
    this.loadAlert = null;
    this.renderAlerts();
    this.readWorkspace();
    this.renderLayer();
    await this.loadEntries(seq);
    if (seq !== this.seq) return;
    if (this.tabs.current() === 'candidates') await this.loadCandidates(false);
    if (this.tabs.current() === 'history') await this.loadAudit(false);
    this.renderImport();
    this.renderPreview();
    if (source === 'panel') this.announce(this.t('panel.loaded'));
  }

  applyVersions(body) {
    const view = (v) => (v && typeof v === 'object' && Number.isInteger(v.version) ? { version: v.version, sha: terminologyText(v.entries_sha256) } : null);
    this.versions = { shared: view(body.shared), workspace: view(body.workspace) };
    this.singleTenant = this.versions.workspace === null;
    if (this.singleTenant) this.layer = 'shared';
    this.enabled = terminologyEnabled(body.enabled_languages);
  }

  async loadEntries(seq) {
    const ui = this.ui();
    const result = await this.request('', { layer: this.layer, search: this.search, limit: TERMINOLOGY_PAGE, offset: this.offset });
    if (seq !== undefined && seq !== this.seq) return;
    ui.ragUiListBusy(this.hosts.entries, false);
    if (!(result && result.ok)) {
      if (!this.list) this.hosts.entries.replaceChildren();
      const mapped = this.failed(result);
      this.announce(mapped.message, true);
      return;
    }
    const body = terminologyBody(result);
    this.list = { items: Array.isArray(body.items) ? body.items : [], total: terminologyCount(body.total) };
    this.layerVersion = Number.isInteger(body.layer_version) ? body.layer_version : null;
    const enabled = terminologyEnabled(body.enabled_languages);
    if (enabled.length) this.enabled = enabled;
    this.renderAlerts();
    this.renderEntries();
  }

  async reloadAll() {
    const versions = await this.request('/versions', {});
    if (versions && versions.ok) this.applyVersions(terminologyBody(versions));
    this.renderLayer();
    await this.loadEntries();
    if (this.audit.loaded) await this.loadAudit(false);
  }

  onTab(id) {
    if (id === 'candidates' && !this.candidates.loaded) this.loadCandidates(false);
    if (id === 'history') this.loadAudit(false);
    if (id === 'preview') this.renderPreview();
  }

  /** UI-SPEC 4.1: the layer switch, a radio group; hidden in single-tenant mode. */
  renderLayer() {
    if (this.singleTenant) {
      this.hosts.layer.replaceChildren();
      return;
    }
    const name = 'rag-terminology-layer';
    const option = (value, key) => {
      const id = name + '-' + value;
      const input = this.el('input', { className: 'radio radio-sm', id, attrs: { type: 'radio', name, value, autocomplete: 'off' } });
      input.checked = this.layer === value;
      input.addEventListener('change', async () => {
        if (!input.checked || this.layer === value) return;
        this.layer = value;
        this.offset = 0;
        this.editor = null;
        this.imports.report = null;
        this.imports.checkedKey = null;
        this.audit.loaded = false;
        await this.loadEntries();
        if (this.tabs.current() === 'history') await this.loadAudit(false);
        this.renderImport();
      });
      return this.el('label', { className: 'label cursor-pointer justify-start gap-2 min-h-11 md:min-h-8', attrs: { for: id } }, [input, this.el('span', { className: 'label-text', text: this.t(key) })]);
    };
    this.hosts.layer.replaceChildren(
      this.el('fieldset', { className: 'min-w-0', attrs: { 'data-terminology-layer': '' } }, [
        this.el('legend', { className: 'text-sm font-semibold mb-1', text: this.t('layer.legend') }),
        this.el('div', { className: 'flex flex-wrap gap-x-6 gap-y-1' }, [option('shared', 'layer.shared'), option('workspace', 'layer.workspace')]),
      ]),
    );
  }

  // --- Entries (UI-SPEC 4.2 to 4.4)

  renderEntries() {
    if (!this.list) return;
    const ui = this.ui();
    const searchId = 'rag-terminology-search';
    const search = this.el('input', {
      className: 'input input-bordered input-sm w-full max-w-xs',
      id: searchId,
      attrs: { type: 'search', name: searchId, maxlength: '64', autocomplete: 'off', spellcheck: 'false', placeholder: this.t('list.searchPlaceholder') },
    });
    search.value = this.search;
    search.addEventListener('input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.search = search.value.trim().slice(0, 64);
        this.offset = 0;
        this.loadEntries();
      }, 300);
    });
    const newButton = this.btn(this.t('action.new'), { className: 'btn btn-outline md:btn-sm', attrs: { 'aria-expanded': this.editor ? 'true' : 'false', 'aria-controls': 'rag-terminology-editor' } }, () =>
      this.openEditor({ mode: 'create', draft: terminologyEmptyDraft() }),
    );
    const toolbar = this.el('div', { className: 'flex flex-wrap items-end gap-3 min-w-0' }, [
      this.el('div', { className: 'form-control min-w-0' }, [
        this.el('label', { className: 'label py-1', attrs: { for: searchId } }, [this.el('span', { className: 'label-text', text: this.t('list.search') })]),
        search,
      ]),
      newButton,
      this.el('span', { className: 'text-xs text-base-content/70 ml-auto tabular-nums', text: ui.ragUiCount(this.t('list.count'), this.list.total, this.locale) }),
    ]);
    const nodes = [toolbar];
    if (this.editor) nodes.push(this.renderEditor());
    nodes.push(this.renderTable());
    this.hosts.entries.replaceChildren(...nodes);
  }

  renderTable() {
    const ui = this.ui();
    const items = this.list.items;
    if (items.length === 0) {
      if (this.search) return this.el('p', { className: 'text-sm text-base-content/70', text: this.t('list.noMatch') });
      return this.el('div', { className: 'bg-base-100 rounded-lg p-4 max-w-prose' }, [
        this.el('p', { className: 'text-sm font-semibold', text: this.t('list.empty') }),
        this.el('p', { className: 'text-sm text-base-content/70', text: this.t('list.emptyBody') }),
      ]);
    }
    const th = (key) => this.el('th', { className: 'font-semibold whitespace-normal align-bottom', text: this.t(key), attrs: { scope: 'col' } });
    const rows = items.map((item) => this.renderRow(item));
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('thead', {}, [this.el('tr', {}, ['col.term', 'col.variants', 'col.kind', 'col.language', 'col.mode', 'col.status', 'col.actions'].map(th))]),
      this.el('tbody', {}, rows),
    ]);
    const region = this.el(
      'div',
      { className: 'overflow-x-auto rounded bg-base-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('list.label') } },
      [table],
    );
    const from = this.offset + 1;
    const to = this.offset + items.length;
    const pager = this.el('div', { className: 'flex flex-wrap items-center gap-3' }, [
      this.el('span', { className: 'text-xs text-base-content/70 tabular-nums', text: this.t('list.range', { from: ui.ragUiFormatNumber(from, this.locale), to: ui.ragUiFormatNumber(to, this.locale), total: ui.ragUiFormatNumber(this.list.total, this.locale) }) }),
    ]);
    if (this.offset > 0 || to < this.list.total) {
      const prev = this.btn(this.t('action.previous'), { className: 'btn btn-ghost md:btn-sm' }, () => {
        this.offset = Math.max(0, this.offset - TERMINOLOGY_PAGE);
        this.loadEntries();
      });
      prev.disabled = this.offset === 0;
      const next = this.btn(this.t('action.next'), { className: 'btn btn-ghost md:btn-sm' }, () => {
        this.offset += TERMINOLOGY_PAGE;
        this.loadEntries();
      });
      next.disabled = to >= this.list.total;
      pager.appendChild(prev);
      pager.appendChild(next);
    }
    return this.el('div', { className: 'flex flex-col gap-2 min-w-0' }, [region, pager]);
  }

  renderRow(item) {
    const view = buildEntryView(item, this.locale);
    const term = view.canonical;
    const actions = [];
    if (view.suppression) {
      actions.push(this.btn(this.t('action.show'), { className: 'btn btn-ghost md:btn-sm', attrs: { 'aria-label': this.t('action.showAria', { term }) } }, (event) => this.setSuppression(view.suppressesEntryId, false, term, event)));
    } else {
      actions.push(this.btn(this.t('action.edit'), { className: 'btn btn-ghost md:btn-sm', attrs: { 'aria-label': this.t('action.editAria', { term }), 'data-terminology-edit': view.id } }, () => this.openEditor({ mode: 'edit', id: view.id, draft: terminologyDraftFromEntry(item) })));
      if (this.layer === 'shared' && !this.singleTenant) {
        actions.push(this.btn(this.t('action.hide'), { className: 'btn btn-ghost md:btn-sm', attrs: { 'aria-label': this.t('action.hideAria', { term }) } }, (event) => this.setSuppression(view.id, true, term, event)));
      }
      actions.push(this.btn(this.t('action.delete'), { className: 'btn btn-ghost md:btn-sm text-error', attrs: { 'aria-label': this.t('action.deleteAria', { term }) } }, (event) => this.confirmDelete(view, event)));
    }
    const mono = 'font-mono text-xs break-words';
    const termCell = this.el('td', { className: 'min-w-32' }, [
      this.el('span', { className: mono, text: term, attrs: { translate: 'no' } }),
      view.note ? this.el('p', { className: 'text-xs text-base-content/70 mt-1 break-words max-w-xs', text: view.note }) : null,
    ]);
    return this.el('tr', {}, [
      termCell,
      this.el('td', { className: mono + ' min-w-32 max-w-xs', text: view.variants, attrs: { translate: 'no' } }),
      this.el('td', { text: view.kind }),
      this.el('td', { text: view.language }),
      this.el('td', { text: view.suppression ? '' : view.mode }),
      this.el('td', {}, [
        this.el('span', { className: 'badge badge-sm badge-outline whitespace-nowrap' + (view.suppression ? ' border-warning' : view.enabled ? '' : ' opacity-70'), text: view.status }),
      ]),
      this.el('td', {}, [this.el('div', { className: 'flex flex-wrap gap-1' }, actions)]),
    ]);
  }

  openEditor({ mode, id, draft, candidateId }) {
    this.editor = { mode, id: id || null, draft: { ...terminologyEmptyDraft(), ...draft }, issues: [], alert: null, candidateId: candidateId || null, focus: 'heading' };
    if (this.tabs.current() !== 'entries') this.tabs.select('entries');
    this.renderEntries();
  }

  closeEditor() {
    const id = this.editor && this.editor.id;
    this.editor = null;
    this.renderEntries();
    const target = id ? this.hosts.entries.querySelector(`[data-terminology-edit="${id}"]`) : null;
    const fallback = Array.from(this.hosts.entries.querySelectorAll('button')).find((b) => b.textContent.trim() === this.t('action.new'));
    const focus = target || fallback;
    if (focus && typeof focus.focus === 'function') focus.focus();
  }

  renderEditor() {
    const editor = this.editor;
    const ui = this.ui();
    const form = buildEntryForm(editor.draft, this.enabled, this.locale);
    const issues = buildIssueList(editor.issues, editor.draft.kind, this.locale);
    const headingKey = editor.mode === 'edit' ? 'form.edit' : editor.candidateId ? 'form.candidate' : 'form.new';
    const heading = this.el('h4', { className: 'text-base font-semibold text-balance rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', text: this.t(headingKey), attrs: { tabindex: '-1' } });
    const nodes = [heading];
    if (editor.alert) nodes.push(editor.alert);
    const summary = issues.filter((i) => i.field === 'summary');
    if (issues.some((i) => i.severity === 'error')) {
      const alert = ui.ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', body: [this.t('form.notSaved')], role: 'alert' });
      alert.setAttribute('tabindex', '-1');
      alert.setAttribute('data-terminology-summary', '');
      nodes.push(alert);
    }
    if (summary.length) nodes.push(this.issueLines(summary, 'summary'));
    const grid = this.el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0' });
    for (const f of form.fields) grid.appendChild(this.renderField(f, issues.filter((i) => i.field === f.name)));
    nodes.push(grid);
    const save = this.btn(this.t('action.save'), { className: 'btn btn-primary md:btn-sm' }, () => this.saveEntry(save));
    const cancel = this.btn(this.t('action.cancel'), { className: 'btn btn-ghost md:btn-sm' }, () => this.closeEditor());
    nodes.push(this.el('div', { className: 'flex flex-wrap items-center gap-3' }, [save, cancel]));
    const block = this.el('div', { className: 'bg-base-100 rounded-lg p-4 flex flex-col gap-4 min-w-0', id: 'rag-terminology-editor', attrs: { role: 'group', 'aria-label': this.t(headingKey) } }, nodes);
    block.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeEditor();
    });
    const focus = editor.focus;
    editor.focus = null;
    if (focus) {
      setTimeout(() => {
        const target = focus === 'summary' ? block.querySelector('[data-terminology-summary]') : focus === 'alert' ? block.querySelector('[role="alert"]') : heading;
        if (target && typeof target.focus === 'function') target.focus();
      }, 0);
    }
    return block;
  }

  issueLines(issues, field) {
    const host = this.el('ul', { className: 'flex flex-col gap-1 mt-1', attrs: { 'data-terminology-issues': field } });
    for (const issue of issues) {
      host.appendChild(
        this.el('li', { className: 'text-sm flex items-start gap-1 ' + (issue.severity === 'warning' ? 'text-base-content' : 'text-error') }, [
          this.ui().ragUiIcon(this.doc, issue.severity === 'warning' ? 'exclamation-triangle' : 'exclamation-circle', 'mt-0.5 shrink-0' + (issue.severity === 'warning' ? ' text-warning' : '')),
          this.el('span', { className: 'min-w-0 break-words' }, [this.el('span', { className: 'font-semibold', text: issue.label + ': ' }), issue.message]),
        ]),
      );
    }
    return host;
  }

  renderField(f, issues) {
    const id = 'rag-terminology-field-' + f.name;
    const helpId = id + '-help';
    const issuesId = id + '-issues';
    const describedBy = [f.help ? helpId : null, issues.length ? issuesId : null].filter(Boolean).join(' ') || null;
    const wide = f.name === 'canonical' || f.name === 'variants' || f.name === 'note';
    const wrap = this.el('div', { className: 'form-control min-w-0' + (f.name === 'variants' || f.name === 'note' ? ' md:col-span-2' : '') });
    const invalid = issues.some((i) => i.severity === 'error') ? 'true' : null;
    let control = null;
    if (f.control === 'fixed') {
      wrap.appendChild(this.el('p', { className: 'label-text py-1', text: f.label }));
      wrap.appendChild(this.el('p', { className: 'text-sm', id, text: f.text }));
    } else if (f.control === 'checkbox') {
      control = this.el('input', { className: 'checkbox checkbox-sm', id, attrs: { type: 'checkbox', name: id, 'data-terminology-field': f.name, 'aria-describedby': describedBy } });
      control.checked = Boolean(f.value);
      control.addEventListener('change', () => {
        this.editor.draft.enabled = Boolean(control.checked);
      });
      wrap.appendChild(this.el('label', { className: 'label cursor-pointer justify-start gap-3 w-fit min-h-11 md:min-h-8', attrs: { for: id } }, [control, this.el('span', { className: 'label-text', text: f.label })]));
    } else {
      wrap.appendChild(this.el('label', { className: 'label py-1', attrs: { for: id } }, [this.el('span', { className: 'label-text', text: f.label })]));
      if (f.control === 'select') {
        control = this.el('select', { className: 'select select-bordered select-sm w-full max-w-xs', id, attrs: { name: id, 'data-terminology-field': f.name, 'aria-describedby': describedBy, 'aria-invalid': invalid } });
        if (f.placeholder) control.appendChild(this.el('option', { text: f.placeholder, attrs: { value: '' } }));
        for (const option of f.options) control.appendChild(this.el('option', { text: option.label, attrs: { value: option.value, lang: option.lang || null } }));
        control.value = f.value;
      } else {
        const textarea = f.control === 'textarea';
        control = this.el(textarea ? 'textarea' : 'input', {
          className: (textarea ? 'textarea textarea-bordered textarea-sm font-mono' : 'input input-bordered input-sm font-mono') + (wide ? ' w-full' : ' w-full max-w-xs'),
          id,
          attrs: {
            type: textarea ? null : 'text',
            name: id,
            rows: textarea ? (f.name === 'variants' ? '4' : '2') : null,
            maxlength: f.maxLength ? String(f.maxLength) : null,
            autocomplete: 'off',
            spellcheck: 'false',
            placeholder: f.placeholder || null,
            required: f.required ? true : null,
            translate: 'no',
            'data-terminology-field': f.name,
            'aria-describedby': describedBy,
            'aria-invalid': invalid,
          },
        });
        control.value = f.value;
      }
      const key = f.name === 'variants' ? 'variantsText' : f.name;
      const update = () => {
        this.editor.draft[key] = control.value;
      };
      control.addEventListener('input', update);
      control.addEventListener('change', () => {
        update();
        if (f.name === 'kind' || f.name === 'mode') {
          this.editor.issues = [];
          this.renderEntries();
          const again = this.hosts.entries.querySelector(`[data-terminology-field="${f.name}"]`);
          if (again && typeof again.focus === 'function') again.focus();
        }
      });
      wrap.appendChild(control);
    }
    if (f.help) wrap.appendChild(this.el('p', { className: 'text-xs text-base-content/70 mt-1 max-w-prose', id: helpId, text: f.help }));
    const lines = this.issueLines(issues, f.name);
    lines.id = issuesId;
    wrap.appendChild(lines);
    return wrap;
  }

  async saveEntry(button) {
    const editor = this.editor;
    if (!editor || editor.saving) return;
    const clientIssues = terminologyClientIssues(editor.draft, this.locale);
    editor.alert = null;
    if (clientIssues.length) {
      editor.issues = clientIssues;
      editor.focus = 'summary';
      this.renderEntries();
      this.announce(this.t('form.notSaved'), true);
      return;
    }
    const body = this.withOrganization({ ...terminologyEntryFields(editor.draft), layer: this.layer, expected_version: this.layerVersion ?? 0 });
    editor.saving = true;
    const restore = this.ui().ragUiButtonBusy(this.doc, button, this.t('action.saving'));
    let result;
    try {
      result = editor.mode === 'edit'
        ? await this.ui().ragUiRagRequest(TERMINOLOGY_PATH + '/' + encodeURIComponent(editor.id), { method: 'PATCH', body: JSON.stringify(body) })
        : await this.ui().ragUiRagRequest(TERMINOLOGY_PATH, { method: 'POST', body: JSON.stringify(body) });
    } finally {
      restore();
      editor.saving = false;
    }
    if (result && result.ok) {
      const answer = terminologyBody(result);
      const warnings = buildIssueList(answer.warnings, editor.draft.kind, this.locale);
      let message = this.t('form.saved');
      if (editor.candidateId && typeof answer.entry_id === 'string') {
        const decided = await this.ui().ragUiRagRequest(TERMINOLOGY_PATH + '/candidates/' + encodeURIComponent(editor.candidateId), { method: 'PATCH', body: JSON.stringify({ action: 'accept', entry_id: answer.entry_id }) });
        message = decided && decided.ok ? this.t('candidates.accepted') : this.t('candidates.acceptFailed');
        this.candidates.loaded = false;
      }
      this.editor = null;
      this.audit.loaded = false;
      await this.reloadAll();
      if (this.candidates.loaded === false && this.tabs.current() === 'candidates') await this.loadCandidates(false);
      const parts = [message, ...warnings.map((w) => this.t('form.warning', { message: w.message }))];
      this.announce(parts.join(' '));
      return;
    }
    if (terminologyIsVersionConflict(result)) {
      editor.issues = [];
      editor.alert = this.conflictAlert(() => this.reloadAll());
      editor.focus = 'alert';
      this.renderEntries();
      this.announce(this.t('form.conflict'), true);
      return;
    }
    if (result && result.status === 422) {
      editor.issues = Array.isArray(terminologyBody(result).issues) ? terminologyBody(result).issues : [];
      editor.focus = 'summary';
      this.renderEntries();
      this.announce(this.t('form.notSaved'), true);
      return;
    }
    const mapped = this.failed(result);
    if (mapped.kind === 'invalid' || mapped.kind === 'generic' || mapped.kind === 'changed' || mapped.kind === 'conflict') {
      editor.alert = this.ui().ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', body: [mapped.message], role: 'alert' });
      editor.focus = 'alert';
      this.renderEntries();
    }
    this.announce(mapped.message, true);
  }

  confirmDelete(view, event) {
    const opener = event && event.currentTarget ? event.currentTarget : null;
    return this.ui().ragUiConfirmDialog(this.doc, {
      title: this.t('delete.title'),
      body: [this.t('delete.body', { term: view.canonical })],
      keepLabel: this.t('delete.keep'),
      confirmLabel: this.t('delete.confirm'),
      runningLabel: this.t('delete.running'),
      tone: 'error',
      opener,
      fallbackFocus: this.root.querySelector('[data-terminology-status]'),
      onConfirm: async () => {
        const result = await this.request('/' + encodeURIComponent(view.id), { layer: this.layer, expected_version: this.layerVersion ?? 0 }, { method: 'DELETE' });
        await this.afterWrite(result, 'delete.done');
      },
    });
  }

  /** Hide a shared entry in the workspace, or show it again (UI-SPEC 4.4); the workspace layer's version is the expected one. */
  async setSuppression(sharedEntryId, suppressed, term, event) {
    const send = async () => {
      const expected = this.layer === 'workspace' ? this.layerVersion : this.versions && this.versions.workspace ? this.versions.workspace.version : 0;
      const body = this.withOrganization({ shared_entry_id: sharedEntryId, suppressed, expected_version: expected ?? 0 });
      const result = await this.ui().ragUiRagRequest(TERMINOLOGY_PATH + '/suppressions', { method: 'POST', body: JSON.stringify(body) });
      await this.afterWrite(result, suppressed ? 'hide.done' : 'show.done');
    };
    if (!suppressed) return send();
    const opener = event && event.currentTarget ? event.currentTarget : null;
    return this.ui().ragUiConfirmDialog(this.doc, {
      title: this.t('hide.title'),
      body: [this.t('hide.body', { term })],
      keepLabel: this.t('hide.keep'),
      confirmLabel: this.t('hide.confirm'),
      runningLabel: this.t('hide.running'),
      opener,
      fallbackFocus: this.root.querySelector('[data-terminology-status]'),
      onConfirm: send,
    });
  }

  async afterWrite(result, doneKey) {
    if (result && result.ok) {
      this.audit.loaded = false;
      await this.reloadAll();
      this.announce(this.t(doneKey));
      return;
    }
    if (terminologyIsVersionConflict(result)) {
      this.setAlert(this.conflictAlert(() => {
        this.loadAlert = null;
        this.renderAlerts();
        this.reloadAll();
      }));
      this.announce(this.t('form.conflict'), true);
      return;
    }
    const mapped = this.failed(result);
    if (mapped.kind === 'changed') await this.reloadAll();
    this.announce(mapped.message, true);
  }

  // --- Import and export (UI-SPEC 4.6)

  importKey() {
    const f = this.imports.file;
    return f ? [this.layer, this.organizationId || '', this.imports.mode, f.name, f.size].join('\u0000') : null;
  }

  renderImport() {
    const ui = this.ui();
    const imp = this.imports;
    const columns = this.el('dl', { className: 'grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm' });
    for (const column of TERMINOLOGY_CSV_COLUMNS) {
      columns.appendChild(this.el('dt', {}, [this.el('code', { className: 'font-mono text-xs', text: column, attrs: { translate: 'no' } })]));
      columns.appendChild(this.el('dd', { className: 'text-base-content/80 min-w-0', text: this.t('import.col.' + column) }));
    }
    const fileId = 'rag-terminology-import-file';
    const file = this.el('input', { className: 'file-input file-input-bordered file-input-sm w-full max-w-sm', id: fileId, attrs: { type: 'file', name: fileId, accept: '.csv,.jsonl,text/csv' } });
    file.addEventListener('change', async () => {
      const picked = file.files && file.files[0] ? file.files[0] : null;
      imp.report = null;
      imp.errors = null;
      imp.checkedKey = null;
      imp.alert = null;
      imp.file = null;
      imp.text = null;
      if (picked) {
        if (Number(picked.size) > TERMINOLOGY_MAX_FILE_BYTES) {
          imp.alert = ui.ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', body: [this.t('import.tooLarge')], role: 'alert' });
        } else {
          try {
            imp.text = await picked.text();
            imp.file = { name: terminologyText(picked.name), size: Number(picked.size) || 0 };
            imp.format = /\.jsonl$/i.test(imp.file.name) ? 'dictionary_candidates_jsonl' : 'csv';
          } catch {
            imp.alert = ui.ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', body: [this.t('import.invalidFile')], role: 'alert' });
          }
        }
      }
      this.renderImportResult();
    });
    const modeName = 'rag-terminology-import-mode';
    const modeOption = (value, key) => {
      const id = modeName + '-' + value;
      const input = this.el('input', { className: 'radio radio-sm', id, attrs: { type: 'radio', name: modeName, value, autocomplete: 'off' } });
      input.checked = imp.mode === value;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        imp.mode = value;
        imp.report = null;
        imp.checkedKey = null;
        this.renderImportResult();
      });
      return this.el('label', { className: 'label cursor-pointer justify-start gap-2 min-h-11 md:min-h-8', attrs: { for: id } }, [input, this.el('span', { className: 'label-text', text: this.t(key) })]);
    };
    const check = this.btn(this.t('import.check'), { className: 'btn btn-primary md:btn-sm' }, () => this.runImport(true, check));
    this.hosts.importResult = this.el('div', { className: 'flex flex-col gap-4 min-w-0' });
    const exportButton = this.btn(this.t('export.button'), { className: 'btn btn-outline md:btn-sm' }, () => this.runExport(exportButton));
    this.hosts.import.replaceChildren(
      this.el('div', { className: 'flex flex-col gap-4 min-w-0' }, [
        this.el('div', { className: 'form-control min-w-0' }, [
          this.el('label', { className: 'label py-1', attrs: { for: fileId } }, [this.el('span', { className: 'label-text', text: this.t('import.file') })]),
          file,
          this.el('p', { className: 'text-xs text-base-content/70 mt-1 max-w-prose', text: this.t('import.limits') }),
        ]),
        this.el('fieldset', { className: 'min-w-0' }, [
          this.el('legend', { className: 'text-sm font-semibold mb-1', text: this.t('import.mode') }),
          this.el('div', { className: 'flex flex-wrap gap-x-6 gap-y-1' }, [modeOption('merge', 'import.merge'), modeOption('replace', 'import.replace')]),
        ]),
        this.el('div', { className: 'flex flex-wrap items-center gap-3' }, [check]),
        this.hosts.importResult,
      ]),
      this.el('details', { className: 'bg-base-100 rounded-lg p-4 min-w-0' }, [
        this.el('summary', { className: 'text-sm font-semibold cursor-pointer', text: this.t('import.columns') }),
        this.el('div', { className: 'mt-3' }, [columns]),
      ]),
      this.el('div', { className: 'flex flex-col gap-2 min-w-0 border-t border-base-300 pt-6' }, [
        this.el('h4', { className: 'text-base font-semibold', text: this.t('export.title') }),
        this.el('p', { className: 'text-sm text-base-content/70 max-w-prose', text: this.t('export.help') }),
        this.el('div', {}, [exportButton]),
      ]),
    );
    this.renderImportResult();
  }

  renderImportResult() {
    const host = this.hosts.importResult;
    if (!host) return;
    const ui = this.ui();
    const imp = this.imports;
    const nodes = [];
    if (imp.alert) nodes.push(imp.alert);
    if (imp.errors) {
      const list = this.el('ul', { className: 'list-disc pl-5 text-sm' });
      for (const error of imp.errors.slice(0, 50)) {
        const row = Number.isInteger(error.row) && error.row > 0 ? ui.ragUiCount(this.t('import.colRow'), error.row, this.locale) + ' — ' : '';
        list.appendChild(this.el('li', { className: 'break-words', text: row + terminologyText(error.message) }));
      }
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', title: this.t('import.invalidFile'), body: [list], role: 'alert' }));
    }
    if (imp.report) {
      const report = buildImportReport(imp.report, this.locale);
      nodes.push(this.el('h4', { className: 'text-base font-semibold', text: this.t('import.report') }));
      nodes.push(
        this.el(
          'div',
          { className: 'flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums' },
          report.counts.map((c) => this.el('span', { text: ui.ragUiCount(c.label, c.value, this.locale) })),
        ),
      );
      nodes.push(this.reportIssues(report.issues));
      if (!report.applied) {
        const ready = imp.checkedKey === this.importKey();
        const apply = this.btn(this.t('import.apply'), { className: 'btn btn-primary md:btn-sm', attrs: { 'aria-describedby': 'rag-terminology-apply-reason' } }, () => this.applyImport(apply, report));
        const reason = report.blocking ? this.t('import.blocked') : ready ? '' : this.t('import.needCheck');
        apply.disabled = Boolean(reason);
        nodes.push(this.el('div', { className: 'flex flex-wrap items-center gap-3' }, [apply, this.el('p', { className: 'text-sm text-base-content/70', id: 'rag-terminology-apply-reason', text: reason })]));
      }
    }
    host.replaceChildren(...nodes);
  }

  reportIssues(issues) {
    if (!issues.length) return this.el('p', { className: 'text-sm text-base-content/70', text: this.t('import.noIssues') });
    const ui = this.ui();
    const th = (key) => this.el('th', { className: 'font-semibold', text: this.t(key), attrs: { scope: 'col' } });
    const rows = issues.slice(0, 200).map((issue) =>
      this.el('tr', {}, [
        this.el('td', { className: 'tabular-nums', text: issue.row === null ? '' : ui.ragUiFormatNumber(issue.row, this.locale) }),
        this.el('td', { className: issue.severity === 'error' ? 'text-error' : '', text: this.t('severity.' + issue.severity) }),
        this.el('td', { text: issue.label }),
        this.el('td', { className: 'break-words max-w-md', text: issue.message }),
      ]),
    );
    return this.el('div', { className: 'overflow-x-auto rounded bg-base-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('import.issues') } }, [
      this.el('table', { className: 'table table-sm' }, [
        this.el('thead', {}, [this.el('tr', {}, [th('import.colRow'), th('import.colSeverity'), th('import.colIssue'), th('import.colDetail')])]),
        this.el('tbody', {}, rows),
      ]),
    ]);
  }

  importBody(dryRun, expectedVersion) {
    const imp = this.imports;
    const body = { layer: this.layer, mode: imp.mode, format: imp.format, dry_run: dryRun };
    if (imp.format === 'csv') body.csv = imp.text;
    else body.jsonl = imp.text;
    if (!dryRun) body.expected_version = expectedVersion;
    return this.withOrganization(body);
  }

  async runImport(dryRun, button, expectedVersion) {
    const ui = this.ui();
    const imp = this.imports;
    if (!imp.file || typeof imp.text !== 'string') {
      imp.alert = ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', body: [this.t('import.needFile')], role: 'alert' });
      this.renderImportResult();
      return;
    }
    const key = this.importKey();
    imp.alert = null;
    imp.errors = null;
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t(dryRun ? 'import.checking' : 'import.applying'));
    let result;
    try {
      result = await ui.ragUiRagRequest(TERMINOLOGY_PATH + '/import', { method: 'POST', body: JSON.stringify(this.importBody(dryRun, expectedVersion)) }, 60000);
    } finally {
      restore();
    }
    const body = terminologyBody(result);
    if (result && result.ok) {
      imp.report = body.report || null;
      imp.checkedKey = dryRun ? key : null;
      if (!dryRun) {
        this.audit.loaded = false;
        await this.reloadAll();
        this.announce(this.t('import.applied'));
      } else this.announce(this.t('import.report'));
      this.renderImportResult();
      return;
    }
    imp.checkedKey = null;
    if (result && result.status === 400 && body.error === 'invalid_file') {
      imp.report = null;
      imp.errors = Array.isArray(body.errors) ? body.errors : [];
      this.announce(this.t('import.invalidFile'), true);
    } else if (result && result.status === 413) {
      imp.report = null;
      imp.alert = ui.ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', body: [this.t('import.tooLarge')], role: 'alert' });
      this.announce(this.t('import.tooLarge'), true);
    } else if (result && result.status === 422) {
      imp.report = body.report || { issues: body.issues || [] };
      this.announce(this.t('import.blocked'), true);
    } else if (terminologyIsVersionConflict(result)) {
      imp.report = null;
      imp.alert = this.conflictAlert(() => this.reloadAll(), 'import.checkAgain');
      this.announce(this.t('form.conflict'), true);
    } else {
      const mapped = this.failed(result);
      imp.alert = ui.ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', body: [mapped.message], role: 'alert' });
      this.announce(mapped.message, true);
    }
    this.renderImportResult();
  }

  applyImport(button, report) {
    if (report.blocking || report.versionSeen === null || this.imports.checkedKey !== this.importKey()) return null;
    const run = () => this.runImport(false, button, report.versionSeen);
    if (this.imports.mode !== 'replace' || report.deletes === 0) return run();
    return this.ui().ragUiConfirmDialog(this.doc, {
      title: this.t('import.replaceTitle'),
      body: [this.t('import.replaceBody', { count: this.ui().ragUiFormatNumber(report.deletes, this.locale) })],
      keepLabel: this.t('import.replaceKeep'),
      confirmLabel: this.t('import.replaceConfirm'),
      runningLabel: this.t('import.applying'),
      tone: 'error',
      opener: button,
      onConfirm: run,
    });
  }

  /** Export through the app route; the proxy passes the CSV attachment through unchanged. */
  async runExport(button) {
    const ui = this.ui();
    const w = typeof window !== 'undefined' ? window : null;
    const build = w && typeof w.buildRagFetchInit === 'function' ? w.buildRagFetchInit : null;
    const fetchFn = w && typeof w.fetch === 'function' ? w.fetch.bind(w) : null;
    if (!build || !fetchFn) return;
    const { url, init } = build(TERMINOLOGY_PATH + '/export' + this.query({ layer: this.layer }), { method: 'GET', headers: { Accept: 'text/csv' } });
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('export.running'));
    try {
      const response = await fetchFn(url, init);
      if (!response.ok) {
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        const mapped = this.failed({ ok: false, status: response.status, body });
        this.announce(mapped.message, true);
        return;
      }
      const disposition = terminologyText(response.headers && response.headers.get ? response.headers.get('content-disposition') : '');
      const match = /filename="([\w.-]{1,128})"/.exec(disposition);
      const name = match ? match[1] : 'terminology-' + this.layer + '.csv';
      const blob = await response.blob();
      const href = w.URL.createObjectURL(blob);
      const link = this.doc.createElement('a');
      link.href = href;
      link.download = name;
      link.hidden = true;
      this.doc.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => w.URL.revokeObjectURL(href), 0);
      this.announce(this.t('export.done'));
    } catch {
      this.announce(ui.ragUiSharedLabel('error.network', this.locale), true);
    } finally {
      restore();
    }
  }

  // --- Preview (UI-SPEC 4.7)

  draftEntry() {
    const editor = this.editor;
    if (!editor || terminologyClientIssues(editor.draft, this.locale).length) return null;
    return { ...terminologyEntryFields(editor.draft), id: editor.mode === 'edit' ? editor.id : null, layer: this.layer, suppresses_entry_id: null };
  }

  renderPreview() {
    const p = this.preview;
    const queryId = 'rag-terminology-preview-query';
    const query = this.el('textarea', {
      className: 'textarea textarea-bordered textarea-sm w-full font-mono',
      id: queryId,
      attrs: { name: queryId, rows: '2', maxlength: String(TERMINOLOGY_MAX_QUERY), autocomplete: 'off', spellcheck: 'false', placeholder: this.t('preview.queryPlaceholder'), 'data-terminology-field': 'preview_query', 'aria-describedby': queryId + '-help' },
    });
    query.value = p.query;
    query.addEventListener('input', () => {
      p.query = query.value;
    });
    const nodes = [
      this.el('div', { className: 'form-control min-w-0' }, [
        this.el('label', { className: 'label py-1', attrs: { for: queryId } }, [this.el('span', { className: 'label-text', text: this.t('preview.query') })]),
        query,
        this.el('p', { className: 'text-xs text-base-content/70 mt-1 max-w-prose', id: queryId + '-help', text: this.t('preview.help') }),
      ]),
    ];
    if (this.draftEntry()) {
      const id = 'rag-terminology-preview-draft';
      const box = this.el('input', { className: 'checkbox checkbox-sm', id, attrs: { type: 'checkbox', name: id } });
      box.checked = p.includeDraft;
      box.addEventListener('change', () => {
        p.includeDraft = Boolean(box.checked);
      });
      nodes.push(this.el('label', { className: 'label cursor-pointer justify-start gap-3 w-fit min-h-11 md:min-h-8', attrs: { for: id } }, [box, this.el('span', { className: 'label-text', text: this.t('preview.includeDraft') })]));
    }
    const run = this.btn(this.t('preview.run'), { className: 'btn btn-primary md:btn-sm' }, () => this.runPreview(run));
    nodes.push(this.el('div', {}, [run]));
    this.hosts.previewResult = this.el('div', { className: 'flex flex-col gap-4 min-w-0' });
    nodes.push(this.hosts.previewResult);
    this.hosts.preview.replaceChildren(...nodes);
    this.renderPreviewResult();
  }

  async runPreview(button) {
    const ui = this.ui();
    const p = this.preview;
    const text = terminologyText(p.query).trim();
    p.alert = null;
    if (!text) {
      p.result = null;
      p.alert = ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', body: [this.t('preview.needQuery')], role: 'alert' });
      this.renderPreviewResult();
      return;
    }
    const body = this.withOrganization({ layer: this.layer, query: text.slice(0, TERMINOLOGY_MAX_QUERY) });
    const draft = p.includeDraft ? this.draftEntry() : null;
    if (draft) body.draft_entries = [draft];
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('preview.running'));
    let result;
    try {
      result = await ui.ragUiRagRequest(TERMINOLOGY_PATH + '/preview', { method: 'POST', body: JSON.stringify(body) });
    } finally {
      restore();
    }
    if (result && result.ok) {
      p.result = terminologyBody(result);
    } else if (result && result.status === 422) {
      p.result = { issues: terminologyBody(result).issues || [], matches: [], expansion_tokens: [], original_tokens: [], overrides: [] };
    } else {
      p.result = null;
      const mapped = this.failed(result);
      p.alert = ui.ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', body: [mapped.message], role: 'alert' });
      this.announce(mapped.message, true);
    }
    this.renderPreviewResult();
  }

  chips(tokens) {
    return this.el(
      'ul',
      { className: 'flex flex-wrap gap-1' },
      tokens.map((token) => this.el('li', {}, [this.el('code', { className: 'font-mono text-xs bg-base-100 rounded px-2 py-1 break-all', text: terminologyText(token), attrs: { translate: 'no' } })])),
    );
  }

  renderPreviewResult() {
    const host = this.hosts.previewResult;
    if (!host) return;
    const p = this.preview;
    const nodes = [];
    if (p.alert) nodes.push(p.alert);
    const r = p.result;
    if (r) {
      const matches = Array.isArray(r.matches) ? r.matches : [];
      const added = Array.isArray(r.expansion_tokens) ? r.expansion_tokens : [];
      const original = Array.isArray(r.original_tokens) ? r.original_tokens : [];
      if (r.version) nodes.push(this.el('p', { className: 'text-xs text-base-content/70' }, [this.t('preview.version') + ': ', this.el('code', { className: 'font-mono', text: terminologyText(r.version), attrs: { translate: 'no' } })]));
      if (matches.length === 0) nodes.push(this.el('p', { className: 'text-sm text-base-content/70', text: this.t('preview.none') }));
      else {
        const th = (key) => this.el('th', { className: 'font-semibold', text: this.t(key), attrs: { scope: 'col' } });
        const rows = matches.map((m) =>
          this.el('tr', {}, [
            this.el('td', { className: 'font-mono text-xs break-words', text: terminologyText(m.surface), attrs: { translate: 'no' } }),
            this.el('td', { className: 'font-mono text-xs break-words', text: terminologyText(m.canonical), attrs: { translate: 'no' } }),
            this.el('td', { text: terminologyKindLabel(m.kind, this.locale) }),
            this.el('td', { text: this.t(m.layer === 'workspace' ? 'layer.workspace' : 'layer.shared') }),
          ]),
        );
        nodes.push(this.el('h4', { className: 'text-base font-semibold', text: this.t('preview.matches') }));
        nodes.push(
          this.el('div', { className: 'overflow-x-auto rounded bg-base-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('preview.matches') } }, [
            this.el('table', { className: 'table table-sm' }, [
              this.el('thead', {}, [this.el('tr', {}, [th('preview.found'), th('col.term'), th('col.kind'), th('preview.layer')])]),
              this.el('tbody', {}, rows),
            ]),
          ]),
        );
      }
      if (added.length) nodes.push(this.el('div', { className: 'flex flex-col gap-1' }, [this.el('p', { className: 'text-sm font-semibold', text: this.t('preview.added') }), this.chips(added)]));
      if (original.length) nodes.push(this.el('div', { className: 'flex flex-col gap-1' }, [this.el('p', { className: 'text-sm font-semibold', text: this.t('preview.original') }), this.chips(original)]));
      if (r.capped === true) nodes.push(this.el('p', { className: 'text-sm', text: this.t('preview.capped') }));
      const overrides = buildIssueList(r.overrides, null, this.locale);
      if (overrides.length) nodes.push(this.el('div', {}, [this.el('p', { className: 'text-sm font-semibold', text: this.t('preview.overrides') }), this.issueLines(overrides, 'preview_overrides')]));
      const issues = buildIssueList(r.issues, null, this.locale);
      if (issues.length) nodes.push(this.issueLines(issues, 'preview_issues'));
    }
    host.replaceChildren(...nodes);
  }

  // --- Candidates (UI-SPEC 4.8)

  async loadCandidates(more) {
    const ui = this.ui();
    const host = this.hosts.candidates;
    const offset = more ? this.candidates.nextOffset || 0 : 0;
    if (!more) ui.ragUiListLoading(this.doc, host, this.t('panel.loading'));
    const result = await this.request('/candidates', { limit: TERMINOLOGY_PAGE, offset });
    if (!(result && result.ok)) {
      host.replaceChildren();
      const mapped = this.failed(result);
      this.announce(mapped.message, true);
      return;
    }
    const body = terminologyBody(result);
    const items = Array.isArray(body.items) ? body.items : [];
    this.candidates = { items: more ? [...this.candidates.items, ...items] : items, nextOffset: Number.isInteger(body.next_offset) ? body.next_offset : null, loaded: true };
    this.renderCandidates();
  }

  renderCandidates() {
    const host = this.hosts.candidates;
    const c = this.candidates;
    const nodes = [this.el('p', { className: 'text-sm text-base-content/70 max-w-prose', text: this.t('candidates.help') })];
    if (c.items.length === 0) {
      nodes.push(
        this.el('div', { className: 'bg-base-100 rounded-lg p-4 max-w-prose' }, [
          this.el('p', { className: 'text-sm font-semibold', text: this.t('candidates.empty') }),
          this.el('p', { className: 'text-sm text-base-content/70', text: this.t('candidates.emptyBody') }),
        ]),
      );
    } else {
      const list = this.el('ul', { className: 'flex flex-col gap-2' });
      for (const item of c.items) list.appendChild(this.renderCandidate(item));
      nodes.push(list);
      if (c.nextOffset !== null) nodes.push(this.el('div', {}, [this.btn(this.t('action.more'), { className: 'btn btn-ghost md:btn-sm' }, () => this.loadCandidates(true))]));
    }
    host.replaceChildren(...nodes);
  }

  renderCandidate(item) {
    const view = buildCandidateView(item, this.locale);
    const facts = this.el('div', { className: 'flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/70 tabular-nums' }, [
      this.el('span', { text: view.language }),
      this.el('span', { text: view.support }),
      this.el('span', { text: view.documents }),
      view.lastSeen ? this.el('span', { text: view.lastSeen }) : null,
    ]);
    const examples = view.examples.length
      ? this.el('details', { className: 'text-sm' }, [
          this.el('summary', { className: 'cursor-pointer text-xs', text: this.t('candidates.examples') }),
          this.el('ul', { className: 'list-disc pl-5 mt-1' }, view.examples.map((text) => this.el('li', { className: 'font-mono text-xs break-words', text, attrs: { translate: 'no' } }))),
        ])
      : null;
    const accept = this.btn(this.t('candidates.accept'), { className: 'btn btn-outline md:btn-sm', attrs: { 'aria-label': this.t('candidates.acceptAria', { term: view.term }) } }, () =>
      this.openEditor({ mode: 'create', draft: candidateDraft(item, this.enabled), candidateId: view.id }),
    );
    const dismiss = this.btn(this.t('candidates.dismiss'), { className: 'btn btn-ghost md:btn-sm', attrs: { 'aria-label': this.t('candidates.dismissAria', { term: view.term }) } }, (event) => this.dismissCandidate(view, event));
    return this.el('li', { className: 'bg-base-100 rounded-lg p-4 flex flex-col gap-2 min-w-0' }, [
      this.el('div', { className: 'flex flex-wrap items-center gap-3 min-w-0' }, [
        this.el('span', { className: 'font-mono text-sm font-semibold break-words min-w-0', text: view.term, attrs: { translate: 'no' } }),
        this.el('div', { className: 'flex flex-wrap gap-1 ml-auto' }, [accept, dismiss]),
      ]),
      facts,
      examples,
    ]);
  }

  dismissCandidate(view, event) {
    const opener = event && event.currentTarget ? event.currentTarget : null;
    return this.ui().ragUiConfirmDialog(this.doc, {
      title: this.t('candidates.dismissTitle'),
      body: [this.t('candidates.dismissBody', { term: view.term })],
      keepLabel: this.t('candidates.dismissKeep'),
      confirmLabel: this.t('candidates.dismissConfirm'),
      runningLabel: this.t('candidates.dismissConfirm'),
      tone: 'error',
      opener,
      fallbackFocus: this.root.querySelector('[data-terminology-status]'),
      onConfirm: async () => {
        const result = await this.ui().ragUiRagRequest(TERMINOLOGY_PATH + '/candidates/' + encodeURIComponent(view.id), { method: 'PATCH', body: JSON.stringify({ action: 'dismiss' }) });
        if (result && result.ok) {
          await this.loadCandidates(false);
          this.announce(this.t('candidates.dismissed'));
          return;
        }
        if (result && (result.status === 409 || result.status === 404)) {
          await this.loadCandidates(false);
          this.announce(this.t('candidates.decided'), true);
          return;
        }
        const mapped = this.failed(result);
        this.announce(mapped.message, true);
      },
    });
  }

  // --- History (UI-SPEC 4.5)

  async loadAudit(more) {
    const offset = more ? this.audit.items.length : 0;
    if (!more) this.ui().ragUiListLoading(this.doc, this.hosts.history, this.t('panel.loading'));
    const result = await this.request('/audit', { layer: this.layer, limit: TERMINOLOGY_AUDIT_PAGE, offset });
    if (!(result && result.ok)) {
      this.hosts.history.replaceChildren();
      const mapped = this.failed(result);
      this.announce(mapped.message, true);
      return;
    }
    const body = terminologyBody(result);
    const items = Array.isArray(body.items) ? body.items : [];
    this.audit = { items: more ? [...this.audit.items, ...items] : items, total: terminologyCount(body.total), loaded: true };
    this.renderHistory();
  }

  auditTerm(item) {
    for (const side of [item.after, item.before]) {
      if (side && typeof side === 'object' && typeof side.canonical === 'string') return side.canonical;
    }
    return '';
  }

  renderHistory() {
    const v = this.versions || {};
    const versionLine = (key, entry) =>
      entry
        ? this.el('p', { className: 'text-sm flex flex-wrap items-center gap-2' }, [
            this.el('span', { text: this.t(key, { version: this.ui().ragUiFormatNumber(entry.version, this.locale) }) }),
            entry.sha ? this.el('code', { className: 'font-mono text-xs text-base-content/70', text: entry.sha.slice(0, 12), attrs: { translate: 'no' } }) : null,
          ])
        : null;
    const nodes = [
      this.el('h4', { className: 'text-base font-semibold', text: this.t('history.versions') }),
      versionLine('history.shared', v.shared),
      versionLine('history.workspace', v.workspace),
      this.el('h4', { className: 'text-base font-semibold mt-2', text: this.t('history.recent') }),
    ];
    const items = this.audit.items;
    if (items.length === 0) nodes.push(this.el('p', { className: 'text-sm text-base-content/70', text: this.t('history.empty') }));
    else {
      const th = (key) => this.el('th', { className: 'font-semibold', text: this.t(key), attrs: { scope: 'col' } });
      const knownActions = new Set(['create', 'update', 'delete', 'suppress', 'unsuppress', 'import', 'candidate_accept', 'candidate_dismiss']);
      const rows = items.map((item) => {
        const action = terminologyText(item.action);
        return this.el('tr', {}, [
          this.el('td', { className: 'whitespace-nowrap', text: terminologyDate(item.created_at, this.locale) }),
          this.el('td', { text: knownActions.has(action) ? this.t('audit.' + action) : action }),
          this.el('td', { className: 'font-mono text-xs break-words', text: this.auditTerm(item), attrs: { translate: 'no' } }),
          this.el('td', { className: 'tabular-nums', text: Number.isInteger(item.layer_version) ? this.ui().ragUiFormatNumber(item.layer_version, this.locale) : '' }),
          this.el('td', { className: 'font-mono text-xs', text: terminologyText(item.actor).slice(0, 8), attrs: { translate: 'no' } }),
        ]);
      });
      nodes.push(
        this.el('div', { className: 'overflow-x-auto rounded bg-base-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('history.recent') } }, [
          this.el('table', { className: 'table table-sm' }, [
            this.el('thead', {}, [this.el('tr', {}, [th('history.when'), th('history.action'), th('history.term'), th('history.version'), th('history.by')])]),
            this.el('tbody', {}, rows),
          ]),
        ]),
      );
      if (items.length < this.audit.total) nodes.push(this.el('div', {}, [this.btn(this.t('action.more'), { className: 'btn btn-ghost md:btn-sm' }, () => this.loadAudit(true))]));
    }
    this.hosts.history.replaceChildren(...nodes.filter(Boolean));
  }
}

let terminologyPanelInstance = null;

function initTerminologyPanel() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rag-administration-terminology');
  if (!root) return null;
  if (!terminologyPanelInstance) {
    terminologyPanelInstance = new TerminologyPanel(root);
    if (typeof window !== 'undefined') window.terminologyPanel = terminologyPanelInstance;
    return terminologyPanelInstance.mount();
  }
  return terminologyPanelInstance.refresh();
}

function terminologyBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-terminology-bound')) return;
    link.setAttribute('data-terminology-bound', '1');
    link.addEventListener('click', () => initTerminologyPanel());
  });
}

if (typeof window !== 'undefined') {
  window.TERMINOLOGY_LABELS = TERMINOLOGY_LABELS;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initTerminologyPanel = initTerminologyPanel;
  terminologyBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    terminologyBindPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initTerminologyPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TERMINOLOGY_LABELS,
    TERMINOLOGY_PATH,
    terminologyLabel,
    terminologyLanguageName,
    buildEntryView,
    buildEntryForm,
    buildIssueList,
    buildImportReport,
    buildCandidateView,
    candidateDraft,
    terminologyClientIssues,
    terminologyEntryFields,
    TerminologyPanel,
    initTerminologyPanel,
  };
}
