/**
 * Identifier patterns panel (Phase 4.2 UI-SPEC 6.3 to 6.7, RET-15). Classic script in the page's global scope: every
 * top-level name starts with IdentifierPatterns, IDENTIFIER_PATTERNS_ or identifierPatterns. DOM is built with the
 * rag-ui.js helpers (createElement and textContent only). The browser never runs an admin pattern on the sample: it
 * compiles a draft and tests it against the empty string; matches and offsets come from the test route.
 */

let identifierPatternsUi = null;
if (typeof require !== 'undefined') {
  try {
    identifierPatternsUi = require('./rag-ui.js');
  } catch {
    identifierPatternsUi = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function identifierPatternsUiLib() {
  if (identifierPatternsUi) return identifierPatternsUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

const IDENTIFIER_PATTERNS_TIMEOUT_MS = 15000;

const IDENTIFIER_PATTERNS_DEFAULT_LIMITS = { max_patterns: 20, max_pattern_length: 200, max_name_length: 80, max_sample_length: 10000 };

/** UI-SPEC 12: one constant per command; <key> is typed literally. */
const IDENTIFIER_PATTERNS_COMMANDS = {
  identifiers: 'npm run rag:identifiers -- --tenant <key>',
  relex: 'npm run rag:relex -- --tenant <key>',
};

const IDENTIFIER_PATTERNS_EXAMPLES = ['[A-Z]{2}[ -]?\\d{4}', '[A-Z]{4}-[A-Z]{4}', '\\d{3} \\d{3} \\d{3}'];

/** Server finding codes (plan 04.2-17) to copy keys. matches_empty is the "or nothing at all" half of no_alphanumeric. */
const IDENTIFIER_PATTERNS_FINDING_KEYS = {
  too_long: 'finding.too_long',
  invalid_regex: 'finding.invalid_regex',
  nested_unbounded_quantifier: 'finding.nested_quantifier',
  probe_too_slow: 'finding.too_slow',
  no_alphanumeric: 'finding.no_alphanumeric',
  matches_empty: 'finding.no_alphanumeric',
};

const IDENTIFIER_PATTERNS_FIELD_KEYS = { name: 'form.name', pattern: 'form.pattern', flags: 'form.ignoreCase', sample: 'test.sample' };

const IDENTIFIER_PATTERNS_SHARED_KEYS = new Set(['error.signIn', 'error.network', 'error.generic']);

const IDENTIFIER_PATTERNS_LABELS = {
  en: {
    'panel.title': 'Identifier patterns',
    'panel.description':
      'Formats of your own identifiers, written as patterns. Text that matches a pattern is kept whole in keyword search and stored in one form, so different spellings of one identifier match each other.',
    'panel.scope.single': 'Applies to this deployment.',
    'panel.scope.multi': 'Applies to the workspace chosen under Document Processing.',
    'panel.workspace': 'Workspace: {name}',
    'panel.workspaceDefault': 'Default workspace',
    'builtin.line':
      'Built-in rule, always on: any run of letters, digits and - _ . / that contains at least one digit. Add a pattern only for identifiers this rule misses, such as ones with no digit or ones written with spaces.',
    'note.indexOff':
      'The identifier index switch is off on this page. Patterns can be saved and tested, and are used once the index is on (RAG Modes, Retrieval pipeline) and the app has restarted.',
    'note.rebuild':
      'Patterns changed. New uploads use the current patterns. Stored documents keep the earlier result until you run {identifiers} for the identifier index and {relex} for keyword search.',
    'action.add': 'Add pattern',
    'action.refresh': 'Refresh patterns',
    'action.reload': 'Reload panel',
    'action.openSwitches': 'Open retrieval switches',
    'action.edit': 'Edit pattern',
    'action.editAria': 'Edit pattern {name}',
    'action.enable': 'Enable pattern',
    'action.enableAria': 'Enable pattern {name}',
    'action.disable': 'Disable pattern',
    'action.disableAria': 'Disable pattern {name}',
    'action.delete': 'Delete pattern',
    'action.deleteAria': 'Delete pattern {name}',
    'action.save': 'Save pattern',
    'action.closeForm': 'Close form',
    'action.keep': 'Keep pattern',
    'action.keepEditing': 'Keep editing',
    'action.discard': 'Discard changes',
    'list.loading': 'Loading identifier patterns…',
    'list.loaded': 'Patterns loaded: {count}.',
    'list.updatedAt': 'Updated {time}',
    'list.count': 'Patterns: {count} of {max}',
    'list.limit': 'The limit of {max} patterns is reached. Delete a pattern to add another.',
    'list.noDate': 'No date',
    'list.empty.title': 'No patterns yet',
    'list.empty.body':
      'The built-in rule already finds identifiers that contain a digit. Add a pattern when your identifiers have a format it misses. To see what is found today, paste a sample under Test patterns.',
    'table.caption': 'Identifier patterns of this workspace',
    'col.name': 'Name',
    'col.pattern': 'Pattern',
    'col.status': 'Status',
    'col.updated': 'Updated',
    'col.actions': 'Actions',
    'status.enabled': 'Enabled',
    'status.disabled': 'Disabled',
    'flag.ignoreCase': 'Ignores letter case',
    'flag.matchCase': 'Matches letter case exactly',
    'flag.other': 'Options: {code}',
    'form.title.add': 'New identifier pattern',
    'form.title.edit': 'Edit pattern {name}',
    'form.name': 'Name',
    'form.nameHelp': 'A label for this list, for example the shape in words. It is not used for matching.',
    'form.namePlaceholder': 'Two letters, hyphen, four digits…',
    'form.pattern': 'Pattern',
    'form.patternHelp':
      'A regular expression that matches one whole identifier and nothing around it. It reads Unicode text, so \\d, \\p{L} and \\p{N} work.',
    'form.patternPlaceholder': '[A-Z]{2}-\\d{4}…',
    'form.count': '{count} of {max} characters',
    'form.ignoreCase': 'Ignore letter case',
    'form.ignoreCaseHelp': 'Finds the identifier in upper and lower case. The stored form ignores case either way.',
    'form.examples.summary': 'Pattern examples',
    'example.1': 'Two letters, an optional space or hyphen, four digits',
    'example.2': 'Two groups of four letters joined by a hyphen',
    'example.3': 'Three groups of three digits separated by spaces',
    'form.testHint': 'To try the pattern before saving, select Run test below. The test includes the pattern in this form.',
    'form.nameRequired': 'Enter a name.',
    'form.nameTooLong': 'The name has {count} characters. The limit is {max}. Shorten it.',
    'form.patternRequired': 'Enter a pattern.',
    'form.patternLineBreak': 'A pattern is one line. Remove the line break.',
    'finding.too_long': 'The pattern has {count} characters. The limit is {max}. Shorten it.',
    'finding.invalid_regex':
      'This is not a valid pattern. Check that every bracket and brace is closed and every backslash is followed by a character.',
    'finding.invalid_regexDetail': 'Browser message: {code}',
    'finding.nested_quantifier':
      'The pattern repeats a group that already repeats without a limit, for example (a+)+. On some text that takes very long. Give one of the two repeats an upper limit, for example {1,20}.',
    'finding.too_slow':
      'The pattern took too long on a 10 KB test text (the limit is 50 ms). Simplify it: give repeats an upper limit, or remove optional parts that overlap.',
    'finding.no_alphanumeric':
      'The pattern can match text with no letter or digit, or nothing at all. An identifier needs at least one letter or digit. Make one letter or digit required.',
    'finding.limit_reached': 'This workspace already has {max} patterns, which is the limit. Close the form, delete a pattern, then add this one.',
    'finding.name_exists': 'Another pattern already has this name. Enter a different name.',
    'finding.other': 'The server did not accept the pattern (code {code}). Change the pattern, then select Save pattern again.',
    'form.saving': 'Saving…',
    'form.saved.add': 'Pattern {name} added.',
    'form.saved.edit': 'Pattern {name} saved.',
    'form.workspaceChanged': 'The workspace changed to {name}. Save pattern now adds this pattern to {name}.',
    'form.closedWorkspace':
      'The workspace changed, so the form was closed. The pattern you were editing belongs to the other workspace and was not changed.',
    'toggle.enabling': 'Enabling…',
    'toggle.disabling': 'Disabling…',
    'toggle.enabled': 'Pattern {name} enabled.',
    'toggle.disabled': 'Pattern {name} disabled.',
    'confirm.delete.title': 'Delete pattern {name}?',
    'confirm.delete.body':
      'New uploads are no longer checked with this pattern. Identifiers already stored stay until the stored documents are rebuilt. A deleted pattern cannot be restored. To pause it, select Disable pattern instead.',
    'confirm.deleting': 'Deleting…',
    'delete.done': 'Pattern {name} deleted.',
    'confirm.discard.title': 'Discard unsaved changes?',
    'confirm.discard.body': 'The pattern in the form has not been saved.',
    'test.title': 'Test patterns',
    'test.help':
      'Paste text from one of your documents to see which identifiers are found and how they are stored. The sample is sent to the server for this test only and is not saved.',
    'test.sample': 'Sample text',
    'test.samplePlaceholder': 'Paste a paragraph that contains identifiers…',
    'test.sampleCount': '{count} of {max} characters',
    'test.sampleRequired': 'Paste some text first.',
    'test.sampleTooLong': 'The sample has {count} characters. The limit is {max}. Shorten it.',
    'action.runTest': 'Run test',
    'action.clearSample': 'Clear sample',
    'test.running': 'Testing…',
    'test.scope.saved': 'Tested with the built-in rule and the enabled patterns: {count}.',
    'test.scope.draft': 'Tested with the built-in rule, the enabled patterns: {count}, and the pattern in the form, which is not saved yet.',
    'test.scope.draftEdit':
      'Tested with the built-in rule, the enabled patterns: {count}, and the pattern in the form in place of the saved version of {name}.',
    'test.scope.draftSkipped': 'Tested with the built-in rule and the enabled patterns: {count}. The pattern in the form has an error and was left out.',
    'test.summary': 'Identifiers found: {found}. Stored forms: {forms}.',
    'test.marked.caption': 'Your sample with the identifiers found marked. Text that is not marked was not found.',
    'test.marked.label': 'Sample with marked identifiers',
    'test.marked.unavailable':
      'The positions of the identifiers in the sample are not available, so the sample is not shown with marks. The table lists everything that was found.',
    'test.table.caption': 'Identifiers found in the sample, one row per stored form',
    'col.stored': 'Stored form',
    'col.spellings': 'Spellings found',
    'col.foundBy': 'Found by',
    'source.builtin': 'Built-in rule',
    'source.draft': 'Pattern in the form (not saved)',
    'source.unknown': 'A pattern that is no longer in the list',
    'test.legend':
      'Spellings that differ only in letter case, character width or separators (space - _ . /) get the same stored form, so a question finds the identifier however it is written.',
    'test.truncated': 'Showing the first {shown} of {total} identifiers. Shorten the sample to see the rest.',
    'test.none.title': 'No identifiers found',
    'test.none.body':
      'Nothing in this sample matches the built-in rule or an enabled pattern. If you expected an identifier, add a pattern for its format, or check that its pattern is enabled.',
    'test.draftRefused': 'The test did not run because the pattern in the form has an error. Fix the error shown in the form, then select Run test again.',
    'test.stale': 'The patterns or the sample changed after this test. Select Run test again.',
    'test.unavailable': 'The test is unavailable right now. Your sample is still here. Select Run test again in a moment.',
    'error.listUnavailable': 'Identifier patterns are unavailable right now. Select Reload panel in a moment.',
    'error.workspace': 'Your admin account is not a member of this workspace. Choose another workspace under Document Processing, Upload Destination.',
    'error.saveUnavailable':
      'The pattern was not saved because the service is unavailable. Your values are still in the form. Select Save pattern again in a moment.',
    'error.changeUnknown':
      'The server did not confirm the change, so it may or may not have been applied. The list has been refreshed and shows the patterns as they are now.',
    'error.patternGone': 'This pattern no longer exists. The list has been refreshed.',
    'error.invalidField': 'Check {field}: the server did not accept its value.',
    'error.invalid': 'The request was not accepted. Select Reload panel, then try again.',
  },
  zh: {
    'panel.title': '标识符模式',
    'panel.description': '以模式的形式描述你自己的标识符格式。与模式匹配的文本在关键词检索中保持完整，并以一种形式存储，使同一标识符的不同写法可以互相匹配。',
    'panel.scope.single': '对本部署生效。',
    'panel.scope.multi': '对“文档处理”中所选的工作区生效。',
    'panel.workspace': '工作区：{name}',
    'panel.workspaceDefault': '默认工作区',
    'builtin.line': '内置规则（始终开启）：由字母、数字和 - _ . / 组成、且至少包含一个数字的连续字符。只需为该规则漏掉的标识符添加模式，例如不含数字的，或中间带空格的。',
    'note.indexOff': '本页上的标识符索引开关处于关闭状态。模式可以保存和测试，在开启索引（RAG 模式 → 检索流程）并重启应用后才会生效。',
    'note.rebuild': '模式已更改。新上传的文档使用当前模式。已入库文档保留之前的结果，直到你运行 {identifiers}（标识符索引）和 {relex}（关键词检索）。',
    'action.add': '添加模式',
    'action.refresh': '刷新模式',
    'action.reload': '重新加载面板',
    'action.openSwitches': '打开检索开关',
    'action.edit': '编辑模式',
    'action.editAria': '编辑模式 {name}',
    'action.enable': '启用模式',
    'action.enableAria': '启用模式 {name}',
    'action.disable': '停用模式',
    'action.disableAria': '停用模式 {name}',
    'action.delete': '删除模式',
    'action.deleteAria': '删除模式 {name}',
    'action.save': '保存模式',
    'action.closeForm': '关闭表单',
    'action.keep': '保留模式',
    'action.keepEditing': '继续编辑',
    'action.discard': '放弃更改',
    'list.loading': '正在加载标识符模式…',
    'list.loaded': '已加载模式：{count} 个。',
    'list.updatedAt': '更新于 {time}',
    'list.count': '模式：{count} / {max}',
    'list.limit': '已达到 {max} 个模式的上限。删除一个模式后才能再添加。',
    'list.noDate': '无日期',
    'list.empty.title': '还没有模式',
    'list.empty.body': '内置规则已经能找到包含数字的标识符。当你的标识符格式被它漏掉时，再添加模式。想知道现在能找到什么，可在“测试模式”中粘贴一段示例文本。',
    'table.caption': '此工作区的标识符模式',
    'col.name': '名称',
    'col.pattern': '模式',
    'col.status': '状态',
    'col.updated': '更新时间',
    'col.actions': '操作',
    'status.enabled': '已启用',
    'status.disabled': '已停用',
    'flag.ignoreCase': '不区分大小写',
    'flag.matchCase': '区分大小写',
    'flag.other': '选项：{code}',
    'form.title.add': '新建标识符模式',
    'form.title.edit': '编辑模式 {name}',
    'form.name': '名称',
    'form.nameHelp': '仅用于在此列表中标识，例如用文字描述其形状。不参与匹配。',
    'form.namePlaceholder': '两个字母、连字符、四位数字…',
    'form.pattern': '模式',
    'form.patternHelp': '一个正则表达式，匹配一个完整的标识符，不包含其前后的内容。它按 Unicode 文本读取，因此可以使用 \\d、\\p{L} 和 \\p{N}。',
    'form.patternPlaceholder': '[A-Z]{2}-\\d{4}…',
    'form.count': '{count} / {max} 个字符',
    'form.ignoreCase': '不区分大小写',
    'form.ignoreCaseHelp': '大写和小写的写法都能找到。无论是否勾选，存储形式都不区分大小写。',
    'form.examples.summary': '模式示例',
    'example.1': '两个字母，可选的空格或连字符，四位数字',
    'example.2': '两组各四个字母，以连字符相连',
    'example.3': '三组各三位数字，以空格分隔',
    'form.testHint': '保存前想试用此模式，请点击下方的“运行测试”。测试会包含此表单中的模式。',
    'form.nameRequired': '请填写名称。',
    'form.nameTooLong': '名称有 {count} 个字符，上限为 {max}。请缩短。',
    'form.patternRequired': '请填写模式。',
    'form.patternLineBreak': '模式只能有一行。请删除换行。',
    'finding.too_long': '模式有 {count} 个字符，上限为 {max}。请缩短。',
    'finding.invalid_regex': '这不是有效的模式。请检查每个括号和花括号是否闭合，每个反斜杠后面是否跟有字符。',
    'finding.invalid_regexDetail': '浏览器提示：{code}',
    'finding.nested_quantifier': '模式对一个本身已无限重复的分组再次重复，例如 (a+)+。对某些文本，这会耗时极长。请为其中一处重复设置上限，例如 {1,20}。',
    'finding.too_slow': '模式在 10 KB 测试文本上耗时过长（上限为 50 毫秒）。请简化：为重复设置上限，或删除相互重叠的可选部分。',
    'finding.no_alphanumeric': '模式可能匹配不含字母或数字的文本，甚至匹配空内容。标识符至少需要一个字母或数字。请让其中一个字母或数字成为必需。',
    'finding.limit_reached': '此工作区已有 {max} 个模式，已达上限。请关闭表单，删除一个模式后再添加。',
    'finding.name_exists': '已有其他模式使用此名称。请换一个名称。',
    'finding.other': '服务器未接受此模式（代码 {code}）。请修改模式后再次点击“保存模式”。',
    'form.saving': '正在保存…',
    'form.saved.add': '已添加模式 {name}。',
    'form.saved.edit': '已保存模式 {name}。',
    'form.workspaceChanged': '工作区已切换为 {name}。现在点击“保存模式”会把此模式添加到 {name}。',
    'form.closedWorkspace': '工作区已切换，表单已关闭。你正在编辑的模式属于另一个工作区，未被更改。',
    'toggle.enabling': '正在启用…',
    'toggle.disabling': '正在停用…',
    'toggle.enabled': '已启用模式 {name}。',
    'toggle.disabled': '已停用模式 {name}。',
    'confirm.delete.title': '删除模式 {name}？',
    'confirm.delete.body': '新上传的文档将不再用此模式检查。已存储的标识符会保留，直到重建已入库文档。删除的模式无法恢复。如只想暂停使用，请改为点击“停用模式”。',
    'confirm.deleting': '正在删除…',
    'delete.done': '已删除模式 {name}。',
    'confirm.discard.title': '放弃未保存的更改？',
    'confirm.discard.body': '表单中的模式尚未保存。',
    'test.title': '测试模式',
    'test.help': '粘贴你某份文档中的一段文本，查看能找到哪些标识符以及它们如何存储。示例文本仅为本次测试发送到服务器，不会被保存。',
    'test.sample': '示例文本',
    'test.samplePlaceholder': '粘贴一段包含标识符的文字…',
    'test.sampleCount': '{count} / {max} 个字符',
    'test.sampleRequired': '请先粘贴一些文本。',
    'test.sampleTooLong': '示例文本有 {count} 个字符，上限为 {max}。请缩短。',
    'action.runTest': '运行测试',
    'action.clearSample': '清空示例',
    'test.running': '正在测试…',
    'test.scope.saved': '测试使用了内置规则和已启用的模式：{count} 个。',
    'test.scope.draft': '测试使用了内置规则、已启用的模式（{count} 个），以及表单中尚未保存的模式。',
    'test.scope.draftEdit': '测试使用了内置规则、已启用的模式（{count} 个），并以表单中的模式代替 {name} 的已保存版本。',
    'test.scope.draftSkipped': '测试使用了内置规则和已启用的模式：{count} 个。表单中的模式有错误，未参与测试。',
    'test.summary': '找到的标识符：{found} 个。存储形式：{forms} 种。',
    'test.marked.caption': '你的示例文本，已标出找到的标识符。未标出的文本即未被找到。',
    'test.marked.label': '已标出标识符的示例文本',
    'test.marked.unavailable': '无法取得标识符在示例文本中的位置，因此不显示带标记的示例。下表列出了找到的全部内容。',
    'test.table.caption': '示例文本中找到的标识符，每种存储形式一行',
    'col.stored': '存储形式',
    'col.spellings': '找到的写法',
    'col.foundBy': '匹配来源',
    'source.builtin': '内置规则',
    'source.draft': '表单中的模式（未保存）',
    'source.unknown': '已不在列表中的模式',
    'test.legend': '仅在大小写、全角半角或分隔符（空格 - _ . /）上不同的写法会得到相同的存储形式，因此无论怎样书写，提问时都能找到该标识符。',
    'test.truncated': '仅显示 {total} 个标识符中的前 {shown} 个。缩短示例文本可查看其余部分。',
    'test.none.title': '未找到标识符',
    'test.none.body': '此示例文本中没有内容与内置规则或已启用的模式匹配。如果你预期能找到某个标识符，请为其格式添加模式，或检查对应的模式是否已启用。',
    'test.draftRefused': '由于表单中的模式有错误，测试未运行。请修正表单中显示的错误，然后再次点击“运行测试”。',
    'test.stale': '此次测试之后，模式或示例文本已更改。请再次点击“运行测试”。',
    'test.unavailable': '暂时无法测试。你的示例文本仍在。请稍后再次点击“运行测试”。',
    'error.listUnavailable': '暂时无法读取标识符模式。请稍后点击“重新加载面板”。',
    'error.workspace': '你的管理员账户不是此工作区的成员。请在“文档处理 → 上传目标”中选择其他工作区。',
    'error.saveUnavailable': '服务暂时不可用，模式未保存。表单中的值已保留。请稍后再次点击“保存模式”。',
    'error.changeUnknown': '服务器未确认此更改，可能已生效，也可能没有。列表已刷新，显示模式的当前状态。',
    'error.patternGone': '此模式已不存在，列表已刷新。',
    'error.invalidField': '请检查“{field}”：服务器未接受该值。',
    'error.invalid': '请求未被接受。请点击“重新加载面板”后重试。',
  },
  it: {
    'panel.title': 'Modelli di identificatori',
    'panel.description':
      "I formati dei tuoi identificatori, scritti come modelli. Il testo che corrisponde a un modello resta intero nella ricerca per parole chiave e viene memorizzato in un’unica forma, così le diverse grafie di uno stesso identificatore corrispondono tra loro.",
    'panel.scope.single': 'Vale per questa installazione.',
    'panel.scope.multi': 'Vale per lo spazio di lavoro scelto in Elaborazione documenti.',
    'panel.workspace': 'Spazio di lavoro: {name}',
    'panel.workspaceDefault': 'Spazio di lavoro predefinito',
    'builtin.line':
      'Regola integrata, sempre attiva: ogni sequenza di lettere, cifre e - _ . / che contiene almeno una cifra. Aggiungi un modello solo per gli identificatori che questa regola non trova, ad esempio quelli senza cifre o scritti con spazi.',
    'note.indexOff':
      "In questa pagina l’indice degli identificatori è disattivato. I modelli si possono salvare e provare; vengono usati quando l’indice è attivo (RAG Modes, Retrieval pipeline) e l’app è stata riavviata.",
    'note.rebuild':
      "I modelli sono cambiati. I nuovi caricamenti usano i modelli attuali. I documenti archiviati mantengono il risultato precedente finché non esegui {identifiers} per l’indice degli identificatori e {relex} per la ricerca per parole chiave.",
    'action.add': 'Aggiungi modello',
    'action.refresh': 'Aggiorna modelli',
    'action.reload': 'Ricarica pannello',
    'action.openSwitches': 'Apri opzioni di recupero',
    'action.edit': 'Modifica modello',
    'action.editAria': 'Modifica il modello {name}',
    'action.enable': 'Attiva modello',
    'action.enableAria': 'Attiva il modello {name}',
    'action.disable': 'Disattiva modello',
    'action.disableAria': 'Disattiva il modello {name}',
    'action.delete': 'Elimina modello',
    'action.deleteAria': 'Elimina il modello {name}',
    'action.save': 'Salva modello',
    'action.closeForm': 'Chiudi modulo',
    'action.keep': 'Mantieni modello',
    'action.keepEditing': 'Continua a modificare',
    'action.discard': 'Scarta modifiche',
    'list.loading': 'Caricamento dei modelli di identificatori…',
    'list.loaded': 'Modelli caricati: {count}.',
    'list.updatedAt': 'Aggiornato alle {time}',
    'list.count': 'Modelli: {count} di {max}',
    'list.limit': 'È stato raggiunto il limite di {max} modelli. Elimina un modello per aggiungerne un altro.',
    'list.noDate': 'Nessuna data',
    'list.empty.title': 'Ancora nessun modello',
    'list.empty.body':
      'La regola integrata trova già gli identificatori che contengono una cifra. Aggiungi un modello quando i tuoi identificatori hanno un formato che le sfugge. Per vedere che cosa viene trovato oggi, incolla un esempio in Prova modelli.',
    'table.caption': 'Modelli di identificatori di questo spazio di lavoro',
    'col.name': 'Nome',
    'col.pattern': 'Modello',
    'col.status': 'Stato',
    'col.updated': 'Aggiornato',
    'col.actions': 'Azioni',
    'status.enabled': 'Attivo',
    'status.disabled': 'Disattivato',
    'flag.ignoreCase': 'Ignora maiuscole e minuscole',
    'flag.matchCase': 'Distingue maiuscole e minuscole',
    'flag.other': 'Opzioni: {code}',
    'form.title.add': 'Nuovo modello di identificatore',
    'form.title.edit': 'Modifica il modello {name}',
    'form.name': 'Nome',
    'form.nameHelp': "Un’etichetta per questo elenco, ad esempio la forma descritta a parole. Non viene usata per la corrispondenza.",
    'form.namePlaceholder': 'Due lettere, trattino, quattro cifre…',
    'form.pattern': 'Modello',
    'form.patternHelp':
      "Un’espressione regolare che corrisponde a un identificatore intero e a nient’altro intorno. Legge testo Unicode, quindi \\d, \\p{L} e \\p{N} funzionano.",
    'form.patternPlaceholder': '[A-Z]{2}-\\d{4}…',
    'form.count': '{count} di {max} caratteri',
    'form.ignoreCase': 'Ignora maiuscole e minuscole',
    'form.ignoreCaseHelp': "Trova l’identificatore sia in maiuscolo sia in minuscolo. La forma memorizzata ignora comunque la differenza.",
    'form.examples.summary': 'Esempi di modelli',
    'example.1': 'Due lettere, uno spazio o un trattino facoltativo, quattro cifre',
    'example.2': 'Due gruppi di quattro lettere uniti da un trattino',
    'example.3': 'Tre gruppi di tre cifre separati da spazi',
    'form.testHint': 'Per provare il modello prima di salvarlo, seleziona «Esegui prova» qui sotto. La prova include il modello di questo modulo.',
    'form.nameRequired': 'Inserisci un nome.',
    'form.nameTooLong': 'Il nome ha {count} caratteri. Il limite è {max}. Accorcialo.',
    'form.patternRequired': 'Inserisci un modello.',
    'form.patternLineBreak': "Un modello è una sola riga. Rimuovi l’interruzione di riga.",
    'finding.too_long': 'Il modello ha {count} caratteri. Il limite è {max}. Accorcialo.',
    'finding.invalid_regex': 'Non è un modello valido. Controlla che ogni parentesi sia chiusa e che ogni barra rovesciata sia seguita da un carattere.',
    'finding.invalid_regexDetail': 'Messaggio del browser: {code}',
    'finding.nested_quantifier':
      'Il modello ripete un gruppo che si ripete già senza limite, ad esempio (a+)+. Su alcuni testi richiede moltissimo tempo. Dai a una delle due ripetizioni un limite massimo, ad esempio {1,20}.',
    'finding.too_slow':
      'Il modello ha impiegato troppo tempo su un testo di prova di 10 KB (il limite è 50 ms). Semplificalo: dai un limite alle ripetizioni o rimuovi le parti facoltative che si sovrappongono.',
    'finding.no_alphanumeric':
      'Il modello può corrispondere a un testo senza lettere né cifre, o a nulla. Un identificatore richiede almeno una lettera o una cifra. Rendi obbligatoria una lettera o una cifra.',
    'finding.limit_reached': 'Questo spazio di lavoro ha già {max} modelli, cioè il limite. Chiudi il modulo, elimina un modello, poi aggiungi questo.',
    'finding.name_exists': 'Un altro modello ha già questo nome. Inserisci un nome diverso.',
    'finding.other': 'Il server non ha accettato il modello (codice {code}). Modificalo, poi seleziona di nuovo «Salva modello».',
    'form.saving': 'Salvataggio…',
    'form.saved.add': 'Modello {name} aggiunto.',
    'form.saved.edit': 'Modello {name} salvato.',
    'form.workspaceChanged': 'Lo spazio di lavoro è ora {name}. «Salva modello» aggiunge ora questo modello a {name}.',
    'form.closedWorkspace':
      "Lo spazio di lavoro è cambiato, quindi il modulo è stato chiuso. Il modello che stavi modificando appartiene all’altro spazio di lavoro e non è stato modificato.",
    'toggle.enabling': 'Attivazione…',
    'toggle.disabling': 'Disattivazione…',
    'toggle.enabled': 'Modello {name} attivato.',
    'toggle.disabled': 'Modello {name} disattivato.',
    'confirm.delete.title': 'Eliminare il modello {name}?',
    'confirm.delete.body':
      'I nuovi caricamenti non vengono più controllati con questo modello. Gli identificatori già memorizzati restano finché i documenti archiviati non vengono ricostruiti. Un modello eliminato non si può ripristinare. Per sospenderlo, seleziona invece «Disattiva modello».',
    'confirm.deleting': 'Eliminazione…',
    'delete.done': 'Modello {name} eliminato.',
    'confirm.discard.title': 'Scartare le modifiche non salvate?',
    'confirm.discard.body': 'Il modello nel modulo non è stato salvato.',
    'test.title': 'Prova modelli',
    'test.help':
      "Incolla del testo da uno dei tuoi documenti per vedere quali identificatori vengono trovati e come vengono memorizzati. L’esempio viene inviato al server solo per questa prova e non viene salvato.",
    'test.sample': 'Testo di esempio',
    'test.samplePlaceholder': 'Incolla un paragrafo che contiene identificatori…',
    'test.sampleCount': '{count} di {max} caratteri',
    'test.sampleRequired': 'Incolla prima del testo.',
    'test.sampleTooLong': "L’esempio ha {count} caratteri. Il limite è {max}. Accorcialo.",
    'action.runTest': 'Esegui prova',
    'action.clearSample': 'Cancella esempio',
    'test.running': 'Prova in corso…',
    'test.scope.saved': 'Prova eseguita con la regola integrata e i modelli attivi: {count}.',
    'test.scope.draft': 'Prova eseguita con la regola integrata, i modelli attivi: {count}, e il modello nel modulo, non ancora salvato.',
    'test.scope.draftEdit': 'Prova eseguita con la regola integrata, i modelli attivi: {count}, e il modello nel modulo al posto della versione salvata di {name}.',
    'test.scope.draftSkipped': 'Prova eseguita con la regola integrata e i modelli attivi: {count}. Il modello nel modulo contiene un errore ed è stato escluso.',
    'test.summary': 'Identificatori trovati: {found}. Forme memorizzate: {forms}.',
    'test.marked.caption': 'Il tuo esempio con gli identificatori trovati evidenziati. Il testo non evidenziato non è stato trovato.',
    'test.marked.label': 'Esempio con gli identificatori evidenziati',
    'test.marked.unavailable':
      "Le posizioni degli identificatori nell’esempio non sono disponibili, quindi l’esempio non viene mostrato con le evidenziazioni. La tabella elenca tutto ciò che è stato trovato.",
    'test.table.caption': "Identificatori trovati nell’esempio, una riga per forma memorizzata",
    'col.stored': 'Forma memorizzata',
    'col.spellings': 'Grafie trovate',
    'col.foundBy': 'Trovato da',
    'source.builtin': 'Regola integrata',
    'source.draft': 'Modello nel modulo (non salvato)',
    'source.unknown': "Un modello non più presente nell’elenco",
    'test.legend':
      "Le grafie che differiscono solo per maiuscole e minuscole, larghezza dei caratteri o separatori (spazio - _ . /) ottengono la stessa forma memorizzata, così una domanda trova l’identificatore comunque sia scritto.",
    'test.truncated': "Sono mostrati i primi {shown} di {total} identificatori. Accorcia l’esempio per vedere gli altri.",
    'test.none.title': 'Nessun identificatore trovato',
    'test.none.body':
      'Nulla in questo esempio corrisponde alla regola integrata o a un modello attivo. Se ti aspettavi un identificatore, aggiungi un modello per il suo formato o verifica che il suo modello sia attivo.',
    'test.draftRefused':
      "La prova non è stata eseguita perché il modello nel modulo contiene un errore. Correggi l’errore indicato nel modulo, poi seleziona di nuovo «Esegui prova».",
    'test.stale': "I modelli o l’esempio sono cambiati dopo questa prova. Seleziona di nuovo «Esegui prova».",
    'test.unavailable': 'La prova non è disponibile al momento. Il tuo esempio è ancora qui. Seleziona di nuovo «Esegui prova» tra poco.',
    'error.listUnavailable': 'I modelli di identificatori non sono disponibili al momento. Seleziona «Ricarica pannello» tra poco.',
    'error.workspace':
      'Il tuo account amministratore non è membro di questo spazio di lavoro. Scegline un altro in Elaborazione documenti, Destinazione del caricamento.',
    'error.saveUnavailable':
      'Il modello non è stato salvato perché il servizio non è disponibile. I valori sono ancora nel modulo. Seleziona di nuovo «Salva modello» tra poco.',
    'error.changeUnknown':
      "Il server non ha confermato la modifica: potrebbe essere stata applicata oppure no. L’elenco è stato aggiornato e mostra i modelli come sono ora.",
    'error.patternGone': "Questo modello non esiste più. L’elenco è stato aggiornato.",
    'error.invalidField': 'Controlla {field}: il server non ha accettato il valore.',
    'error.invalid': 'La richiesta non è stata accettata. Seleziona «Ricarica pannello» e riprova.',
  },
};

function identifierPatternsLocale(locale) {
  return locale === 'zh' || locale === 'it' ? locale : 'en';
}

/** One label function: fills {placeholders} and falls back to English, then to the shared ingestLabel table. */
function identifierPatternsLabel(key, locale, vars) {
  const ui = identifierPatternsUiLib();
  const text = ui.ragUiLookup(IDENTIFIER_PATTERNS_LABELS, key, identifierPatternsLocale(locale), vars);
  return text === undefined ? ui.ragUiLabel(key, identifierPatternsLocale(locale), vars) : text;
}

/** The raw template, placeholders left in, for strings whose placeholders become code elements. */
function identifierPatternsTemplate(key, locale) {
  const table = IDENTIFIER_PATTERNS_LABELS[identifierPatternsLocale(locale)] || {};
  return table[key] !== undefined ? table[key] : IDENTIFIER_PATTERNS_LABELS.en[key];
}

function identifierPatternsText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function identifierPatternsPositiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** UI-SPEC 6.4 and 11.1: only the named fields, never by iterating the server's keys. */
function identifierPatternsListView(body) {
  const b = body && typeof body === 'object' ? body : {};
  const rawLimits = b.limits && typeof b.limits === 'object' ? b.limits : {};
  const limits = {};
  for (const key of Object.keys(IDENTIFIER_PATTERNS_DEFAULT_LIMITS)) {
    limits[key] = identifierPatternsPositiveInt(rawLimits[key], IDENTIFIER_PATTERNS_DEFAULT_LIMITS[key]);
  }
  const items = [];
  for (const raw of Array.isArray(b.items) ? b.items : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) continue;
    const flags = identifierPatternsText(raw.flags);
    const sorted = flags.split('').sort().join('');
    items.push({
      id: raw.id,
      name: identifierPatternsText(raw.name),
      pattern: identifierPatternsText(raw.pattern),
      flags,
      flagKey: sorted === 'iu' ? 'flag.ignoreCase' : flags === 'u' ? 'flag.matchCase' : 'flag.other',
      enabled: raw.enabled === true,
      updatedAt: typeof raw.updated_at === 'string' && raw.updated_at ? raw.updated_at : null,
    });
  }
  return { items, limits };
}

/**
 * UI-SPEC 6.5 local layer: required fields, lengths, one line, compiles with u, does not match the empty string.
 * Compiling does not run the pattern, and the only string it is ever run on is the empty string.
 */
function identifierPatternsLocalFindings(draft, limits) {
  const lim = { ...IDENTIFIER_PATTERNS_DEFAULT_LIMITS, ...(limits || {}) };
  const d = draft || {};
  const out = [];
  const name = identifierPatternsText(d.name).trim();
  if (!name) out.push({ field: 'name', key: 'form.nameRequired' });
  else if (name.length > lim.max_name_length) out.push({ field: 'name', key: 'form.nameTooLong', vars: { count: name.length, max: lim.max_name_length } });
  const pattern = identifierPatternsText(d.pattern);
  if (!pattern) {
    out.push({ field: 'pattern', key: 'form.patternRequired' });
  } else if (pattern.includes('\n') || pattern.includes('\r')) {
    out.push({ field: 'pattern', key: 'form.patternLineBreak' });
  } else if (pattern.length > lim.max_pattern_length) {
    out.push({ field: 'pattern', key: 'finding.too_long', vars: { count: pattern.length, max: lim.max_pattern_length } });
  } else {
    let compiled = null;
    try {
      compiled = new RegExp(pattern, d.ignoreCase === false ? 'u' : 'iu');
    } catch (error) {
      out.push({ field: 'pattern', key: 'finding.invalid_regex', detail: error && error.message ? String(error.message) : '' });
    }
    if (compiled && compiled.test('')) out.push({ field: 'pattern', key: 'finding.no_alphanumeric' });
  }
  return out;
}

function identifierPatternsValidOffsets(match, length) {
  return (
    match &&
    Number.isInteger(match.start) &&
    Number.isInteger(match.end) &&
    match.start >= 0 &&
    match.start < match.end &&
    match.end <= length
  );
}

/** UI-SPEC 6.7 marked sample: text and mark segments from the server's offsets only; overlaps merge. Null when unusable. */
function identifierPatternsSegments(sample, matches) {
  const text = identifierPatternsText(sample);
  const list = Array.isArray(matches) ? matches : [];
  if (!list.every((m) => identifierPatternsValidOffsets(m, text.length))) return null;
  const ranges = list.map((m) => [m.start, m.end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  const out = [];
  let at = 0;
  for (const [start, end] of merged) {
    if (start > at) out.push({ text: text.slice(at, start), mark: false });
    out.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

/** UI-SPEC 6.7 ledger: one row per stored form in order of first appearance, distinct spellings and sources. */
function identifierPatternsLedger(matches, items) {
  const list = (Array.isArray(matches) ? matches : []).filter((m) => m && typeof m === 'object');
  const ordered = list.every((m) => Number.isInteger(m.start))
    ? list.map((m, i) => [m, i]).sort((a, b) => a[0].start - b[0].start || a[1] - b[1]).map((pair) => pair[0])
    : list;
  const names = new Map((items || []).map((i) => [i.id, i.name]));
  const rows = [];
  const byForm = new Map();
  for (const match of ordered) {
    const stored = identifierPatternsText(match.normalized);
    let row = byForm.get(stored);
    if (!row) {
      row = { stored, spellings: [], sources: [] };
      byForm.set(stored, row);
      rows.push(row);
    }
    const raw = identifierPatternsText(match.raw);
    if (!row.spellings.includes(raw)) row.spellings.push(raw);
    const source = identifierPatternsText(match.source);
    let entry;
    if (source === 'built_in') entry = { kind: 'builtin' };
    else if (source === 'draft') entry = { kind: 'draft' };
    else if (names.has(source)) entry = { kind: 'saved', name: names.get(source) };
    else entry = { kind: 'unknown' };
    if (!row.sources.some((s) => s.kind === entry.kind && s.name === entry.name)) row.sources.push(entry);
  }
  return rows;
}

function identifierPatternsCallKind(call) {
  return call === 'add' || call === 'edit' ? 'save' : call;
}

function identifierPatternsUnavailable(call) {
  if (call === 'list') return { key: 'error.listUnavailable', kind: 'alert' };
  if (call === 'save') return { key: 'error.saveUnavailable', kind: 'formError' };
  if (call === 'toggle' || call === 'delete') return { key: 'error.changeUnknown', kind: 'status', reload: true };
  return { key: 'test.unavailable', kind: 'testError' };
}

/**
 * UI-SPEC 8.2, exactly. call: list | save (add, edit) | toggle | delete | test. Returns
 * { key, kind, field?, code?, reload?, closeForm?, vars?, findings? }. kind: signIn | workspace | alert | formError |
 * status | testError | finding | done.
 */
function mapIdentifierPatternsError(result, call) {
  const c = identifierPatternsCallKind(call);
  if (!result || result.thrown) {
    if (c === 'list') return { key: 'error.network', kind: 'alert' };
    return identifierPatternsUnavailable(c);
  }
  const status = result.status;
  const body = result.body && typeof result.body === 'object' ? result.body : {};
  const err = typeof body.error === 'string' ? body.error : '';
  const details = Array.isArray(body.details) ? body.details.filter((d) => d && typeof d === 'object') : [];
  if (status === 401 || (status === 403 && err !== 'Forbidden')) return { key: 'error.signIn', kind: 'signIn' };
  if (status === 403) return { key: 'error.workspace', kind: 'workspace' };
  if (status === 503) return identifierPatternsUnavailable(c);
  if (status === 404 && (c === 'save' || c === 'toggle' || c === 'delete')) {
    if (c === 'delete') return { key: 'delete.done', kind: 'done', reload: true };
    return { key: 'error.patternGone', kind: 'status', reload: true, closeForm: true };
  }
  if (status === 409 && err === 'limit_reached') return { key: 'finding.limit_reached', kind: 'finding', field: 'form', reload: true };
  if (status === 409 && err === 'name_exists') return { key: 'finding.name_exists', kind: 'finding', field: 'name' };
  if (status === 400 && err === 'invalid_identifier_pattern') {
    const entries = details.length ? details : [{ path: 'pattern', message: err }];
    const findings = entries.map((d) => {
      const code = identifierPatternsText(d.message);
      const key = IDENTIFIER_PATTERNS_FINDING_KEYS[code];
      return key ? { key, field: 'pattern' } : { key: 'finding.other', field: 'pattern', code };
    });
    return { ...findings[0], kind: 'finding', findings };
  }
  if (status === 400) {
    const path = details[0] && typeof details[0].path === 'string' ? details[0].path : '';
    if (Object.prototype.hasOwnProperty.call(IDENTIFIER_PATTERNS_FIELD_KEYS, path)) {
      return { key: 'error.invalidField', kind: 'finding', field: path, vars: { fieldKey: IDENTIFIER_PATTERNS_FIELD_KEYS[path] } };
    }
    return { key: 'error.invalid', kind: c === 'list' ? 'alert' : c === 'test' ? 'testError' : 'status' };
  }
  return { key: 'error.generic', kind: c === 'list' ? 'alert' : c === 'test' ? 'testError' : 'status', vars: { status: status || '?' } };
}

/** A confirmation dialog whose confirm button is outline: the Discard changes dialog (UI-SPEC 6.6). */
function identifierPatternsDiscardDialog(doc, locale, opener) {
  const ui = identifierPatternsUiLib();
  const t = (key) => identifierPatternsLabel(key, locale);
  const titleId = ui.ragUiNextId('identifier-patterns-discard-title');
  const bodyId = ui.ragUiNextId('identifier-patterns-discard-body');
  const keep = ui.ragUiEl(doc, 'button', { className: 'btn btn-sm', text: t('action.keepEditing'), attrs: { type: 'button' } });
  const discard = ui.ragUiEl(doc, 'button', { className: 'btn btn-sm btn-outline', text: t('action.discard'), attrs: { type: 'button' } });
  const backdrop = ui.ragUiEl(doc, 'form', { className: 'modal-backdrop', attrs: { method: 'dialog' } }, [
    ui.ragUiEl(doc, 'button', { className: 'cursor-default', text: t('action.keepEditing'), attrs: { type: 'submit', tabindex: '-1' } }),
  ]);
  const dialog = ui.ragUiEl(doc, 'dialog', { className: 'modal', attrs: { 'aria-labelledby': titleId, 'aria-describedby': bodyId } }, [
    ui.ragUiEl(doc, 'div', { className: 'modal-box min-w-0 overscroll-contain' }, [
      ui.ragUiEl(doc, 'h3', { className: 'text-base font-semibold mb-2 text-balance', id: titleId, text: t('confirm.discard.title') }),
      ui.ragUiEl(doc, 'p', { className: 'text-sm max-w-prose', id: bodyId, text: t('confirm.discard.body') }),
      ui.ragUiEl(doc, 'div', { className: 'modal-action flex-wrap gap-2' }, [keep, discard]),
    ]),
    backdrop,
  ]);
  doc.body.appendChild(dialog);
  return new Promise((resolve) => {
    let discarded = false;
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (!discarded && opener && typeof opener.focus === 'function' && opener.isConnected !== false) opener.focus();
      resolve(discarded);
    });
    keep.addEventListener('click', () => dialog.close('keep'));
    discard.addEventListener('click', () => {
      discarded = true;
      dialog.close('discard');
    });
    dialog.showModal();
    keep.focus();
  });
}

class IdentifierPatternsPanel {
  constructor(root, deps) {
    const d = deps || {};
    const ui = identifierPatternsUiLib();
    this.root = root;
    this.doc = d.doc || (typeof document !== 'undefined' ? document : null);
    this.locale = identifierPatternsLocale(ui.ragUiResolveLocale(d.locale || (typeof navigator !== 'undefined' && navigator ? navigator.language : 'en')));
    this.fetcher = d.fetcher || ((apiPath, init) => window.ragFetch(apiPath, init));
    this.multiTenantOverride = typeof d.multiTenant === 'boolean' ? d.multiTenant : null;
    this.mounted = false;
    this.items = null;
    this.limits = { ...IDENTIFIER_PATTERNS_DEFAULT_LIMITS };
    this.listError = false;
    this.updatedAt = null;
    this.organizationId = null;
    this.form = null;
    this.sample = '';
    this.sampleFinding = null;
    this.result = null;
    this.resultStale = false;
    this.rebuildShown = false;
    this.blocked = null;
    this.alertNode = null;
    this.listSeq = 0;
    this.testSeq = 0;
    this.testRunning = false;
    this.unloadHandler = (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (event) event.returnValue = '';
    };
    this.unloadBound = false;
  }

  t(key, vars) {
    return identifierPatternsLabel(key, this.locale, vars);
  }

  ui() {
    return identifierPatternsUiLib();
  }

  el(tag, options, children) {
    return this.ui().ragUiEl(this.doc, tag, options, children);
  }

  icon(name, extra) {
    return this.ui().ragUiIcon(this.doc, name, extra);
  }

  /** A template whose {placeholders} named in codeVars become code elements (UI-SPEC 12). */
  nodes(key, vars, codeVars) {
    const ui = this.ui();
    const filled = {};
    for (const [name, value] of Object.entries(vars || {})) filled[name] = codeVars && codeVars.includes(name) ? value : this.format(value);
    return ui.ragUiTemplateNodes(this.doc, identifierPatternsTemplate(key, this.locale), filled, codeVars || []);
  }

  format(value) {
    return typeof value === 'number' ? this.ui().ragUiFormatNumber(value, this.locale) : value;
  }

  message(mapped) {
    const vars = { ...(mapped.vars || {}) };
    if (vars.fieldKey) vars.field = this.t(vars.fieldKey);
    if (mapped.key === 'finding.limit_reached') vars.max = this.format(this.limits.max_patterns);
    if (IDENTIFIER_PATTERNS_SHARED_KEYS.has(mapped.key)) return this.ui().ragUiSharedLabel(mapped.key, this.locale, vars);
    return this.t(mapped.key, vars);
  }

  host(name) {
    let node = this.root.querySelector('[data-identifier-patterns-' + name + ']');
    if (!node) {
      const tag = name === 'title' ? 'h3' : name === 'description' ? 'p' : 'div';
      node = this.el(tag, { attrs: { ['data-identifier-patterns-' + name]: true } });
      if (name === 'status') {
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
      }
      this.root.appendChild(node);
    }
    return node;
  }

  isMultiTenant() {
    if (this.multiTenantOverride !== null) return this.multiTenantOverride;
    const config = typeof window !== 'undefined' && window.currentConfig && typeof window.currentConfig === 'object' ? window.currentConfig : {};
    return (config.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE || config.MYRAG_DEPLOYMENT_MODE) === 'multi-tenant';
  }

  selector() {
    return this.doc.getElementById('workspace-selector');
  }

  readWorkspace() {
    const selector = this.selector();
    this.organizationId = this.isMultiTenant() && selector && selector.value ? String(selector.value) : null;
  }

  workspaceName() {
    const selector = this.selector();
    if (!selector || !selector.value) return this.t('panel.workspaceDefault');
    const option = Array.from(selector.querySelectorAll('option')).find((o) => o.getAttribute('value') === selector.value);
    const name = option ? option.textContent.trim() : '';
    return name || this.t('panel.workspaceDefault');
  }

  query() {
    return this.organizationId ? '?organizationId=' + encodeURIComponent(this.organizationId) : '';
  }

  body(fields) {
    return JSON.stringify(this.organizationId ? { organizationId: this.organizationId, ...fields } : fields);
  }

  /** Every call: ragFetch, a 15-second client timeout, network failures caught. Resolves { ok, status, body } or { thrown }. */
  async request(apiPath, init) {
    const options = { ...(init || {}) };
    let controller = null;
    let timer = null;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      options.signal = controller.signal;
    }
    const thrown = { ok: false, thrown: true, status: 0, body: null };
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          if (controller) controller.abort();
          resolve(thrown);
        }, IDENTIFIER_PATTERNS_TIMEOUT_MS);
      });
      const answer = await Promise.race([Promise.resolve(this.fetcher(apiPath, options)), timeout]);
      return answer || thrown;
    } catch {
      return thrown;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  setStatus(text, isError) {
    const status = this.host('status');
    const children = [];
    if (isError) children.push(this.icon('exclamation-circle', 'text-error mr-2'));
    children.push(this.el('span', { text }));
    status.replaceChildren(...children);
  }

  async mount() {
    if (!this.mounted) {
      this.mounted = true;
      this.root.setAttribute('lang', this.locale);
      this.host('title').textContent = this.t('panel.title');
      this.bindWorkspace();
      this.buildContent();
    }
    this.readWorkspace();
    this.renderHeader();
    if (this.blocked) {
      this.blocked = null;
      this.buildContent();
    }
    this.renderNotes();
    await this.loadList({ announce: true });
  }

  async reload() {
    this.alertNode = null;
    this.renderAlert();
    if (this.blocked) {
      this.blocked = null;
      this.buildContent();
    }
    await this.loadList({ announce: true });
  }

  renderHeader() {
    const multi = this.isMultiTenant();
    this.host('description').textContent = this.t('panel.description') + (this.locale === 'zh' ? '' : ' ') + this.t(multi ? 'panel.scope.multi' : 'panel.scope.single');
    let line = this.root.querySelector('[data-identifier-patterns-workspace]');
    if (!line) {
      line = this.el('p', { className: 'text-xs text-base-content/70 mb-4 break-words', attrs: { 'data-identifier-patterns-workspace': true } });
      const alert = this.host('alert');
      if (alert.parentNode) alert.parentNode.insertBefore(line, alert);
      else this.root.appendChild(line);
    }
    line.hidden = !multi;
    line.textContent = multi ? this.t('panel.workspace', { name: this.workspaceName() }) : '';
  }

  bindWorkspace() {
    const selector = this.selector();
    if (!selector || !this.isMultiTenant()) return;
    selector.addEventListener('change', () => this.onWorkspaceChange());
  }

  async onWorkspaceChange() {
    this.readWorkspace();
    this.renderHeader();
    this.result = null;
    this.resultStale = false;
    this.renderResult();
    if (this.form && this.form.mode === 'edit') {
      this.closeForm({ silent: true, focus: false });
      this.setStatus(this.t('form.closedWorkspace'));
    } else if (this.form) {
      this.form.workspaceNote = this.workspaceName();
      this.renderFindings();
    }
    this.items = null;
    if (this.blocked) {
      this.blocked = null;
      this.alertNode = null;
      this.renderAlert();
      this.buildContent();
    }
    await this.loadList({ announce: !this.form || this.form.mode !== 'edit' });
  }

  renderAlert() {
    const alert = this.host('alert');
    alert.replaceChildren(...(this.alertNode ? [this.alertNode] : []));
  }

  buildContent() {
    const content = this.host('content');
    this.hosts = {
      builtin: this.el('p', { className: 'flex items-start gap-2 text-sm max-w-prose mb-4' }, [
        this.icon('info-circle', 'shrink-0'),
        this.el('span', { text: this.t('builtin.line') }),
      ]),
      notes: this.el('div', { className: 'flex flex-col gap-2 mb-4 empty:mb-0' }),
      toolbar: this.el('div', { className: 'flex flex-wrap items-center gap-2 mb-4' }),
      limit: this.el('p', { className: 'text-xs text-base-content/70 mb-4', id: this.ui().ragUiNextId('identifier-patterns-limit') }),
      list: this.el('div'),
      form: this.el('div'),
      test: this.buildTest(),
    };
    content.replaceChildren(this.hosts.builtin, this.hosts.notes, this.hosts.toolbar, this.hosts.limit, this.hosts.list, this.hosts.form, this.hosts.test);
    this.renderNotes();
    this.renderToolbar();
    this.renderList();
    this.renderForm();
    this.renderSampleFinding();
    this.renderResult();
  }

  /** Blocks the panel: the sign-in alert replaces the content, or the workspace alert empties it (UI-SPEC 7). */
  block(kind) {
    this.blocked = kind;
    this.setBeforeUnload(false);
    const content = this.host('content');
    if (kind === 'signIn') {
      this.alertNode = null;
      this.renderAlert();
      content.replaceChildren(this.ui().ragUiSignInAlert(this.doc, this.locale, () => this.reload()));
      this.setStatus(this.message({ key: 'error.signIn' }), true);
    } else {
      this.alertNode = this.ui().ragUiAlert(this.doc, {
        tone: 'warning',
        icon: 'exclamation-triangle',
        body: [this.t('error.workspace')],
        actions: [this.ui().ragUiReloadButton(this.doc, this.locale, () => this.reload())],
      });
      this.renderAlert();
      content.replaceChildren();
      this.setStatus(this.t('error.workspace'), true);
    }
  }

  renderNotes() {
    const host = this.hosts && this.hosts.notes;
    if (!host) return;
    const notes = [];
    const index = this.doc.getElementById('RAG_IDENTIFIER_INDEX');
    if (index && !index.checked) {
      const open = this.el('button', { className: 'btn btn-link btn-sm px-0', text: this.t('action.openSwitches'), attrs: { type: 'button' } });
      open.addEventListener('click', () => this.openSwitches());
      notes.push(
        this.el('div', { className: 'alert alert-info text-sm items-start' }, [
          this.icon('info-circle', 'shrink-0'),
          this.el('div', { className: 'min-w-0 max-w-prose' }, [this.el('p', { text: this.t('note.indexOff') }), open]),
        ]),
      );
    }
    if (this.rebuildShown) {
      notes.push(
        this.el('div', { className: 'alert alert-info text-sm items-start', attrs: { 'data-identifier-patterns-rebuild': true } }, [
          this.icon('arrow-repeat', 'shrink-0'),
          this.el('p', { className: 'min-w-0 max-w-prose' }, this.nodes('note.rebuild', IDENTIFIER_PATTERNS_COMMANDS, ['identifiers', 'relex'])),
        ]),
      );
    }
    host.replaceChildren(...notes);
  }

  openSwitches() {
    const link = this.doc.querySelector('.menu-item[data-tab="rag-modes"]') || this.doc.querySelector('[data-tab="rag-modes"]');
    if (link) link.click();
    const target = this.doc.getElementById('RAG_IDENTIFIER_INDEX');
    if (!target) return;
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: this.scrollBehavior(), block: 'center' });
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  scrollBehavior() {
    const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return reduce ? 'auto' : 'smooth';
  }

  atLimit() {
    return Array.isArray(this.items) && this.items.length >= this.limits.max_patterns;
  }

  writesBlocked() {
    return this.listError || !Array.isArray(this.items);
  }

  renderToolbar() {
    const host = this.hosts && this.hosts.toolbar;
    if (!host) return;
    const limitLine = this.hosts.limit;
    const atLimit = this.atLimit();
    const add = this.el('button', {
      className: 'btn btn-outline btn-sm',
      attrs: {
        type: 'button',
        'data-identifier-patterns-add': true,
        'aria-expanded': this.form && this.form.mode === 'add' ? 'true' : 'false',
        'aria-disabled': atLimit ? 'true' : null,
        'aria-describedby': atLimit ? limitLine.id : null,
      },
    }, [this.icon('plus-lg'), this.el('span', { text: this.t('action.add') })]);
    add.disabled = this.writesBlocked();
    add.addEventListener('click', () => {
      if (this.atLimit()) return;
      this.requestForm('add', null, add);
    });
    this.addButton = add;
    const children = [add];
    if (Array.isArray(this.items)) {
      children.push(
        this.el('span', {
          className: 'text-sm tabular-nums',
          text: this.t('list.count', { count: this.format(this.items.length), max: this.format(this.limits.max_patterns) }),
        }),
      );
    }
    const right = this.el('div', { className: 'ml-auto flex flex-wrap items-center gap-2' });
    if (this.updatedAt) {
      right.appendChild(
        this.el('time', {
          className: 'text-xs text-base-content/70',
          text: this.t('list.updatedAt', { time: this.formatTime(this.updatedAt) }),
          attrs: { datetime: this.updatedAt.toISOString() },
        }),
      );
    }
    const refresh = this.el('button', { className: 'btn btn-outline btn-sm', attrs: { type: 'button' } }, [
      this.icon('arrow-clockwise'),
      this.el('span', { text: this.t('action.refresh') }),
    ]);
    refresh.addEventListener('click', () => this.loadList({ announce: true }));
    this.refreshButton = refresh;
    right.appendChild(refresh);
    children.push(right);
    host.replaceChildren(...children);
    limitLine.textContent = atLimit ? this.t('list.limit', { max: this.format(this.limits.max_patterns) }) : '';
    limitLine.hidden = !atLimit;
  }

  formatTime(date) {
    try {
      return new Intl.DateTimeFormat(this.locale, { timeStyle: 'short' }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    try {
      return new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium' }).format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  async loadList(options) {
    const opts = options || {};
    if (this.blocked || !this.hosts) return;
    const seq = ++this.listSeq;
    const ui = this.ui();
    let restoreRefresh = null;
    if (!Array.isArray(this.items)) {
      ui.ragUiListLoading(this.doc, this.hosts.list, this.t('list.loading'));
      if (opts.announce) this.setStatus(this.t('list.loading'));
    } else {
      ui.ragUiListBusy(this.hosts.list, true);
      if (this.refreshButton && this.refreshButton.isConnected) restoreRefresh = ui.ragUiButtonBusy(this.doc, this.refreshButton, this.t('action.refresh'), []);
    }
    const result = await this.request('admin/identifier-patterns' + this.query(), { method: 'GET' });
    if (seq !== this.listSeq) return;
    if (restoreRefresh) restoreRefresh();
    if (result && result.ok) {
      const view = identifierPatternsListView(result.body);
      this.items = view.items;
      this.limits = view.limits;
      this.listError = false;
      this.updatedAt = new Date();
      this.alertNode = null;
      this.renderAlert();
      ui.ragUiListBusy(this.hosts.list, false);
      this.renderToolbar();
      this.renderList();
      this.renderForm({ keep: true });
      this.renderSampleCount();
      if (opts.announce) this.setStatus(this.t('list.loaded', { count: this.format(this.items.length) }));
      return;
    }
    const mapped = mapIdentifierPatternsError(result, 'list');
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.block(mapped.kind);
      return;
    }
    this.listError = true;
    this.alertNode = ui.ragUiUnavailableAlert(this.doc, this.locale, this.message(mapped), () => this.reload());
    this.renderAlert();
    if (Array.isArray(this.items)) {
      ui.ragUiListBusy(this.hosts.list, true, true);
      this.renderList();
    } else {
      this.hosts.list.replaceChildren();
    }
    this.renderToolbar();
    this.renderForm({ keep: true });
    this.setStatus(this.message(mapped), true);
  }

  renderList() {
    const host = this.hosts && this.hosts.list;
    if (!host || !Array.isArray(this.items)) return;
    if (!this.items.length) {
      host.replaceChildren(
        this.el('div', { className: 'py-8 text-center' }, [
          this.el('p', { className: 'text-base font-semibold text-balance', text: this.t('list.empty.title') }),
          this.el('p', { className: 'text-sm max-w-prose mx-auto mt-2', text: this.t('list.empty.body') }),
        ]),
      );
      return;
    }
    const head = this.el('thead', {}, [
      this.el('tr', {}, [
        this.el('th', { className: 'font-semibold', text: this.t('col.name'), attrs: { scope: 'col' } }),
        this.el('th', { className: 'font-semibold max-md:hidden', text: this.t('col.pattern'), attrs: { scope: 'col' } }),
        this.el('th', { className: 'font-semibold', text: this.t('col.status'), attrs: { scope: 'col' } }),
        this.el('th', { className: 'font-semibold max-lg:hidden', text: this.t('col.updated'), attrs: { scope: 'col' } }),
        this.el('th', { className: 'font-semibold text-right', text: this.t('col.actions'), attrs: { scope: 'col' } }),
      ]),
    ]);
    const body = this.el('tbody', {}, this.items.map((item) => this.row(item)));
    host.replaceChildren(
      this.el('div', { className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('table.caption') } }, [
        this.el('table', { className: 'table table-sm' }, [this.el('caption', { className: 'sr-only', text: this.t('table.caption') }), head, body]),
      ]),
    );
  }

  patternCell(item) {
    const flag =
      item.flagKey === 'flag.other'
        ? this.el('div', { className: 'text-xs text-base-content/70 mt-1' }, this.nodes('flag.other', { code: item.flags }, ['code']))
        : this.el('div', { className: 'text-xs text-base-content/70 mt-1', text: this.t(item.flagKey) });
    return [this.el('code', { className: 'font-mono text-xs break-all', text: item.pattern, attrs: { translate: 'no' } }), flag];
  }

  row(item) {
    const editing = this.form && this.form.mode === 'edit' && this.form.id === item.id;
    const blocked = this.writesBlocked();
    const btn = (action, label, aria, extra) => {
      const b = this.el('button', {
        className: 'btn btn-outline md:btn-sm' + (extra ? ' ' + extra : ''),
        text: label,
        attrs: { type: 'button', 'aria-label': aria, 'data-identifier-patterns-action': action, 'data-identifier-patterns-id': item.id },
      });
      b.disabled = blocked;
      return b;
    };
    const edit = btn('edit', this.t('action.edit'), this.t('action.editAria', { name: item.name }));
    const toggle = item.enabled
      ? btn('toggle', this.t('action.disable'), this.t('action.disableAria', { name: item.name }))
      : btn('toggle', this.t('action.enable'), this.t('action.enableAria', { name: item.name }));
    const del = btn('delete', this.t('action.delete'), this.t('action.deleteAria', { name: item.name }), 'btn-error');
    edit.addEventListener('click', () => this.requestForm('edit', item, edit));
    toggle.addEventListener('click', () => this.toggle(item, toggle, [edit, del]));
    del.addEventListener('click', () => this.confirmDelete(item, del));
    const badge = item.enabled
      ? this.el('span', { className: 'badge badge-success badge-outline badge-sm gap-1 whitespace-nowrap' }, [this.icon('check-circle'), this.el('span', { text: this.t('status.enabled') })])
      : this.el('span', { className: 'badge badge-ghost badge-sm gap-1 whitespace-nowrap' }, [this.icon('circle'), this.el('span', { text: this.t('status.disabled') })]);
    const date = item.updatedAt ? this.formatDate(item.updatedAt) : null;
    const updated = date
      ? this.el('time', { text: date, attrs: { datetime: item.updatedAt } })
      : this.el('span', {}, [this.el('span', { text: '—', attrs: { 'aria-hidden': 'true' } }), this.el('span', { className: 'sr-only', text: this.t('list.noDate') })]);
    return this.el('tr', { className: editing ? 'bg-base-100' : '', attrs: { 'aria-current': editing ? 'true' : null } }, [
      this.el('th', { className: 'text-sm font-normal break-words min-w-0', attrs: { scope: 'row' } }, [
        this.el('span', { text: item.name }),
        this.el('div', { className: 'md:hidden mt-1' }, this.patternCell(item)),
      ]),
      this.el('td', { className: 'max-md:hidden min-w-0' }, this.patternCell(item)),
      this.el('td', {}, [badge]),
      this.el('td', { className: 'max-lg:hidden text-sm whitespace-nowrap' }, [updated]),
      this.el('td', {}, [this.el('div', { className: 'flex flex-wrap gap-2 justify-end whitespace-nowrap max-md:flex-col max-md:items-stretch' }, [edit, toggle, del])]),
    ]);
  }

  rowButton(id, action) {
    return (
      Array.from(this.hosts.list.querySelectorAll('button')).find((b) => b.getAttribute('data-identifier-patterns-id') === id && b.getAttribute('data-identifier-patterns-action') === action) || null
    );
  }

  patternsChanged() {
    this.rebuildShown = true;
    this.renderNotes();
    this.markStale();
  }

  markStale() {
    if (!this.result || this.resultStale) return;
    this.resultStale = true;
    this.renderResult();
  }

  async toggle(item, button, siblings) {
    if (this.writesBlocked()) return;
    const enabled = !item.enabled;
    const restore = this.ui().ragUiButtonBusy(this.doc, button, this.t(enabled ? 'toggle.enabling' : 'toggle.disabling'), siblings);
    const result = await this.request('admin/identifier-patterns/' + encodeURIComponent(item.id), { method: 'PATCH', body: this.body({ enabled }) });
    if (result && result.ok) {
      const updated = identifierPatternsListView({ items: [result.body && result.body.item ? result.body.item : null] }).items[0];
      this.items = this.items.map((i) => (i.id === item.id ? updated || { ...i, enabled } : i));
      this.renderList();
      this.patternsChanged();
      this.setStatus(this.t(enabled ? 'toggle.enabled' : 'toggle.disabled', { name: item.name }));
      const again = this.rowButton(item.id, 'toggle');
      if (again) again.focus();
      return;
    }
    if (button.isConnected) restore();
    await this.handleWriteError(mapIdentifierPatternsError(result, 'toggle'), item.id);
  }

  async handleWriteError(mapped, id) {
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.block(mapped.kind);
      return;
    }
    if (mapped.closeForm && this.form && this.form.mode === 'edit' && this.form.id === id) this.closeForm({ silent: true, focus: false });
    if (mapped.reload) await this.loadList({ announce: false });
    this.setStatus(this.message(mapped), mapped.kind !== 'done');
  }

  async confirmDelete(item, button) {
    if (this.writesBlocked()) return;
    const index = this.items.findIndex((i) => i.id === item.id);
    await this.ui().ragUiConfirmDialog(this.doc, {
      title: this.t('confirm.delete.title', { name: item.name }),
      body: this.t('confirm.delete.body'),
      keepLabel: this.t('action.keep'),
      confirmLabel: this.t('action.delete'),
      runningLabel: this.t('confirm.deleting'),
      tone: 'error',
      opener: button,
      fallbackFocus: { focus: () => this.focusAfterDelete(index) },
      onConfirm: async () => {
        const result = await this.request('admin/identifier-patterns/' + encodeURIComponent(item.id) + this.query(), { method: 'DELETE' });
        const mapped = result && result.ok ? { key: 'delete.done', kind: 'done', reload: true } : mapIdentifierPatternsError(result, 'delete');
        if (mapped.kind === 'done') {
          if (this.form && this.form.mode === 'edit' && this.form.id === item.id) this.closeForm({ silent: true, focus: false });
          this.patternsChanged();
          await this.loadList({ announce: false });
          this.setStatus(this.t('delete.done', { name: item.name }));
          return;
        }
        await this.handleWriteError(mapped, item.id);
      },
    });
  }

  focusAfterDelete(index) {
    const edits = this.hosts ? Array.from(this.hosts.list.querySelectorAll('button')).filter((b) => b.getAttribute('data-identifier-patterns-action') === 'edit') : [];
    const target = edits.length ? edits[Math.min(Math.max(index, 0), edits.length - 1)] : this.addButton;
    if (target && typeof target.focus === 'function') target.focus();
  }

  formDirty() {
    const f = this.form;
    if (!f) return false;
    return f.name !== f.initial.name || f.pattern !== f.initial.pattern || f.ignoreCase !== f.initial.ignoreCase;
  }

  async requestForm(mode, item, opener) {
    if (this.writesBlocked() && mode === 'add') return;
    if (this.form && this.form.saving) return;
    if (this.form && this.formDirty()) {
      const discard = await identifierPatternsDiscardDialog(this.doc, this.locale, opener);
      if (!discard) return;
    }
    this.openForm(mode, item, opener);
  }

  openForm(mode, item, opener) {
    const name = item ? item.name : '';
    const pattern = item ? item.pattern : '';
    const ignoreCase = item ? item.flagKey !== 'flag.matchCase' : true;
    this.form = {
      mode,
      id: item ? item.id : null,
      originalName: name,
      name,
      pattern,
      ignoreCase,
      initial: { name, pattern, ignoreCase },
      touched: new Set(),
      server: [],
      saving: false,
      opener,
      workspaceNote: null,
    };
    this.renderToolbar();
    this.renderList();
    this.renderForm();
    const region = this.hosts.form.firstElementChild;
    if (region && typeof region.scrollIntoView === 'function') region.scrollIntoView({ behavior: this.scrollBehavior(), block: 'nearest' });
    if (this.formEls) this.formEls.name.focus();
  }

  closeForm(options) {
    const opts = options || {};
    const opener = this.form ? this.form.opener : null;
    this.form = null;
    this.formEls = null;
    this.setBeforeUnload(false);
    this.renderForm();
    this.renderToolbar();
    this.renderList();
    if (opts.focus !== false) {
      const target = opener && opener.isConnected ? opener : opener && opener.getAttribute && opener.getAttribute('data-identifier-patterns-add') !== null ? this.addButton : null;
      const fallback = opener ? this.rowButton(opener.getAttribute('data-identifier-patterns-id'), 'edit') : null;
      const focus = target || fallback || this.addButton;
      if (focus && typeof focus.focus === 'function') focus.focus();
    }
  }

  async tryCloseForm(opener) {
    if (!this.form || this.form.saving) return;
    if (this.formDirty()) {
      const discard = await identifierPatternsDiscardDialog(this.doc, this.locale, opener);
      if (!discard) return;
    }
    this.closeForm({});
  }

  setBeforeUnload(on) {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    if (on && !this.unloadBound) {
      window.addEventListener('beforeunload', this.unloadHandler);
      this.unloadBound = true;
    } else if (!on && this.unloadBound) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadBound = false;
    }
  }

  /** Builds the form region from this.form. keep: only refresh enabled state when the region exists. */
  renderForm(options) {
    const host = this.hosts && this.hosts.form;
    if (!host) return;
    if (!this.form) {
      host.replaceChildren();
      this.formEls = null;
      return;
    }
    if (options && options.keep && this.formEls && host.firstElementChild) {
      this.formEls.save.disabled = this.form.saving || this.writesBlocked();
      return;
    }
    const f = this.form;
    const ui = this.ui();
    const ids = {
      title: ui.ragUiNextId('identifier-patterns-form-title'),
      name: ui.ragUiNextId('identifier-patterns-name'),
      nameHelp: ui.ragUiNextId('identifier-patterns-name-help'),
      pattern: ui.ragUiNextId('identifier-patterns-pattern'),
      patternHelp: ui.ragUiNextId('identifier-patterns-pattern-help'),
      count: ui.ragUiNextId('identifier-patterns-pattern-count'),
      ignore: ui.ragUiNextId('identifier-patterns-ignore-case'),
      ignoreHelp: ui.ragUiNextId('identifier-patterns-ignore-case-help'),
    };
    const name = this.el('input', {
      className: 'input input-bordered input-sm w-full',
      id: ids.name,
      attrs: { type: 'text', name: 'identifier-pattern-name', autocomplete: 'off', placeholder: this.t('form.namePlaceholder') },
    });
    name.value = f.name;
    const pattern = this.el('textarea', {
      className: 'textarea textarea-bordered textarea-sm w-full font-mono text-sm resize-y',
      id: ids.pattern,
      attrs: {
        rows: '2',
        name: 'identifier-pattern',
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        translate: 'no',
        placeholder: this.t('form.patternPlaceholder'),
      },
    });
    pattern.value = f.pattern;
    const ignore = this.el('input', { className: 'checkbox checkbox-sm', id: ids.ignore, attrs: { type: 'checkbox', 'aria-describedby': ids.ignoreHelp } });
    ignore.checked = f.ignoreCase;
    const count = this.el('span', { className: 'label-text-alt text-xs tabular-nums', id: ids.count, attrs: { 'aria-live': 'off' } });
    const findings = this.el('div', { className: 'flex flex-col gap-2 empty:hidden', attrs: { 'aria-live': 'polite', 'data-identifier-patterns-findings': true } });
    const save = this.el('button', { className: 'btn btn-primary btn-sm', text: this.t('action.save'), attrs: { type: 'button' } });
    const close = this.el('button', { className: 'btn btn-ghost btn-sm', text: this.t('action.closeForm'), attrs: { type: 'button' } });
    save.disabled = this.writesBlocked();
    const examples = this.el('details', { className: 'text-sm' }, [
      this.el('summary', {
        className: 'cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        text: this.t('form.examples.summary'),
      }),
      this.el(
        'dl',
        { className: 'mt-2 flex flex-col gap-2' },
        IDENTIFIER_PATTERNS_EXAMPLES.flatMap((example, i) => [
          this.el('dt', { className: 'text-sm', text: this.t('example.' + (i + 1)) }),
          this.el('dd', {}, [this.el('code', { className: 'font-mono text-xs break-all select-all', text: example, attrs: { translate: 'no' } })]),
        ]),
      ),
    ]);
    const region = this.el(
      'div',
      { className: 'bg-base-100 rounded-lg p-4 mt-6', attrs: { role: 'region', 'aria-labelledby': ids.title, 'data-identifier-patterns-form': true } },
      [
        this.el('h4', {
          className: 'text-base font-semibold mb-4 break-words text-balance',
          id: ids.title,
          text: f.mode === 'edit' ? this.t('form.title.edit', { name: f.originalName }) : this.t('form.title.add'),
        }),
        this.el('div', { className: 'flex flex-col gap-4' }, [
          this.el('div', { className: 'form-control' }, [
            this.el('label', { className: 'label', attrs: { for: ids.name } }, [this.el('span', { className: 'label-text', text: this.t('form.name') })]),
            name,
            this.el('p', { className: 'label-text-alt text-base-content/70 max-w-prose mt-1', id: ids.nameHelp, text: this.t('form.nameHelp') }),
          ]),
          this.el('div', { className: 'form-control' }, [
            this.el('div', { className: 'label flex-wrap gap-2' }, [
              this.el('label', { className: 'label-text', text: this.t('form.pattern'), attrs: { for: ids.pattern } }),
              count,
            ]),
            pattern,
            this.el('p', { className: 'label-text-alt text-base-content/70 max-w-prose mt-1', id: ids.patternHelp, text: this.t('form.patternHelp') }),
          ]),
          this.el('div', { className: 'form-control' }, [
            this.el('label', { className: 'flex items-center gap-2 cursor-pointer', attrs: { for: ids.ignore } }, [
              ignore,
              this.el('span', { className: 'label-text', text: this.t('form.ignoreCase') }),
            ]),
            this.el('p', { className: 'label-text-alt text-base-content/70 max-w-prose mt-1 pl-8', id: ids.ignoreHelp, text: this.t('form.ignoreCaseHelp') }),
          ]),
          examples,
          findings,
        ]),
        this.el('div', { className: 'flex flex-wrap gap-2 mt-4' }, [save, close]),
        this.el('p', { className: 'text-xs text-base-content/70 max-w-prose mt-2', text: this.t('form.testHint') }),
      ],
    );
    this.formEls = { region, name, pattern, ignore, count, findings, save, close, ids };
    name.addEventListener('input', () => {
      if (!this.form) return;
      this.form.name = name.value;
      this.form.touched.add('name');
      this.form.server = this.form.server.filter((s) => s.field !== 'name' && s.field !== 'form');
      this.afterFormChange(false);
    });
    pattern.addEventListener('input', () => {
      if (!this.form) return;
      this.form.pattern = pattern.value;
      this.form.touched.add('pattern');
      this.form.server = this.form.server.filter((s) => s.field !== 'pattern' && s.field !== 'form');
      this.afterFormChange(true);
    });
    pattern.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && typeof event.preventDefault === 'function') event.preventDefault();
    });
    ignore.addEventListener('change', () => {
      if (!this.form) return;
      this.form.ignoreCase = Boolean(ignore.checked);
      this.form.touched.add('pattern');
      this.afterFormChange(true);
    });
    region.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      this.tryCloseForm(close);
    });
    save.addEventListener('click', () => this.save());
    close.addEventListener('click', () => this.tryCloseForm(close));
    host.replaceChildren(region);
    this.renderCount();
    this.renderFindings();
  }

  afterFormChange(patternChanged) {
    this.setBeforeUnload(this.formDirty());
    this.renderCount();
    this.renderFindings();
    if (patternChanged) this.markStale();
  }

  renderCount() {
    if (!this.form || !this.formEls) return;
    this.formEls.count.textContent = this.t('form.count', {
      count: this.format(this.form.pattern.length),
      max: this.format(this.limits.max_pattern_length),
    });
  }

  localFindings(all) {
    if (!this.form) return [];
    const findings = identifierPatternsLocalFindings(this.form, this.limits);
    return all ? findings : findings.filter((f) => this.form.touched.has(f.field));
  }

  findingLine(id, finding, tone) {
    let text;
    if (finding.key === 'finding.other') text = this.nodes('finding.other', { code: finding.code || '' }, ['code']);
    else {
      const vars = { ...(finding.vars || {}) };
      if (finding.key === 'finding.too_long' && vars.count === undefined && this.form) {
        vars.count = this.form.pattern.length;
        vars.max = this.limits.max_pattern_length;
      }
      for (const k of Object.keys(vars)) vars[k] = this.format(vars[k]);
      text = [this.el('span', { text: this.message({ key: finding.key, vars }) })];
    }
    const extra = [];
    if (finding.detail) {
      extra.push(this.el('span', { className: 'block text-xs text-base-content/70 mt-1', attrs: { lang: 'en' } }, this.nodes('finding.invalid_regexDetail', { code: finding.detail }, ['code'])));
    }
    return this.el('p', { className: 'flex items-start gap-2 text-sm', id }, [
      this.icon(tone === 'warning' ? 'exclamation-triangle' : 'exclamation-circle', (tone === 'warning' ? 'text-warning' : 'text-error') + ' shrink-0'),
      this.el('span', { className: 'min-w-0 break-words' }, [...text, ...extra]),
    ]);
  }

  /** Server findings replace the local ones for the same draft (UI-SPEC 6.5). */
  currentFindings(all) {
    const server = this.form ? this.form.server : [];
    const local = this.localFindings(all).filter((l) => !server.some((s) => s.field === l.field));
    return [...local, ...server];
  }

  renderFindings(all) {
    if (!this.form || !this.formEls) return [];
    const els = this.formEls;
    const ui = this.ui();
    const findings = this.currentFindings(all);
    const byField = { name: [], pattern: [] };
    const lines = [];
    if (this.form.workspaceNote) lines.push(this.findingLine(ui.ragUiNextId('identifier-patterns-finding'), { key: 'form.workspaceChanged', vars: { name: this.form.workspaceNote } }, 'warning'));
    for (const finding of findings) {
      const id = ui.ragUiNextId('identifier-patterns-finding');
      lines.push(this.findingLine(id, finding));
      if (byField[finding.field]) byField[finding.field].push(id);
    }
    els.findings.replaceChildren(...lines);
    const wire = (control, base, field, cls) => {
      const invalid = byField[field].length > 0;
      control.setAttribute('aria-describedby', [...base, ...byField[field]].join(' '));
      if (invalid) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
      control.classList.toggle(cls, invalid);
    };
    wire(els.name, [els.ids.nameHelp], 'name', 'input-error');
    wire(els.pattern, [els.ids.patternHelp, els.ids.count], 'pattern', 'textarea-error');
    return findings;
  }

  focusFirstFinding(findings) {
    if (!this.formEls) return;
    const first = findings.find((f) => f.field === 'name' || f.field === 'pattern');
    if (first) this.formEls[first.field].focus();
  }

  async save() {
    const f = this.form;
    if (!f || f.saving || this.writesBlocked()) return;
    f.touched.add('name');
    f.touched.add('pattern');
    const local = identifierPatternsLocalFindings(f, this.limits);
    if (local.length) {
      f.server = [];
      this.focusFirstFinding(this.renderFindings(true));
      return;
    }
    const els = this.formEls;
    const fields = { name: f.name.trim(), pattern: f.pattern, flags: f.ignoreCase ? 'iu' : 'u' };
    f.saving = true;
    const restore = this.ui().ragUiButtonBusy(this.doc, els.save, this.t('form.saving'), [els.close]);
    for (const control of [els.name, els.pattern, els.ignore]) control.disabled = true;
    const add = f.mode === 'add';
    const result = await this.request(add ? 'admin/identifier-patterns' : 'admin/identifier-patterns/' + encodeURIComponent(f.id), {
      method: add ? 'POST' : 'PATCH',
      body: this.body(add ? { ...fields, enabled: true } : fields),
    });
    if (this.form !== f) return;
    f.saving = false;
    restore();
    for (const control of [els.name, els.pattern, els.ignore]) control.disabled = false;
    if (result && result.ok) {
      const saved = identifierPatternsListView({ items: [result.body && result.body.item ? result.body.item : null] }).items[0];
      const id = saved ? saved.id : f.id;
      const name = saved ? saved.name : fields.name;
      this.closeForm({ silent: true, focus: false });
      this.patternsChanged();
      await this.loadList({ announce: false });
      this.setStatus(this.t(add ? 'form.saved.add' : 'form.saved.edit', { name }));
      const target = (id && this.rowButton(id, 'edit')) || this.addButton;
      if (target) target.focus();
      return;
    }
    const mapped = mapIdentifierPatternsError(result, add ? 'add' : 'edit');
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.block(mapped.kind);
      return;
    }
    if (mapped.kind === 'status') {
      await this.handleWriteError(mapped, f.id);
      if (this.form === f) {
        f.server = [{ field: 'form', key: mapped.key, vars: mapped.vars }];
        this.renderFindings();
      }
      return;
    }
    f.server = mapped.findings ? mapped.findings : [{ field: mapped.field || 'form', key: mapped.key, vars: mapped.vars, code: mapped.code }];
    if (mapped.kind === 'formError') f.server = [{ field: 'form', key: mapped.key }];
    this.focusFirstFinding(this.renderFindings());
    if (mapped.reload) await this.loadList({ announce: false });
  }

  /** The test region is built once per content build and keeps the sample in memory only (UI-SPEC 6.7). */
  buildTest() {
    const ui = this.ui();
    const ids = {
      title: ui.ragUiNextId('identifier-patterns-test-title'),
      sample: ui.ragUiNextId('identifier-patterns-sample'),
      help: ui.ragUiNextId('identifier-patterns-sample-help'),
      count: ui.ragUiNextId('identifier-patterns-sample-count'),
      finding: ui.ragUiNextId('identifier-patterns-sample-finding'),
    };
    const sample = this.el('textarea', {
      className: 'textarea textarea-bordered textarea-sm w-full text-sm resize-y',
      id: ids.sample,
      attrs: {
        rows: '5',
        name: 'identifier-pattern-sample',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: this.t('test.samplePlaceholder'),
        'aria-describedby': ids.help + ' ' + ids.count,
      },
    });
    sample.value = this.sample;
    const count = this.el('span', { className: 'label-text-alt text-xs tabular-nums', id: ids.count });
    const finding = this.el('div', { className: 'mt-2 empty:hidden', attrs: { 'aria-live': 'polite' } });
    const run = this.el('button', { className: 'btn btn-primary btn-sm', text: this.t('action.runTest'), attrs: { type: 'button' } });
    const clear = this.el('button', { className: 'btn btn-ghost btn-sm', text: this.t('action.clearSample'), attrs: { type: 'button' } });
    const result = this.el('div', { className: 'mt-4 empty:hidden' });
    this.testEls = { sample, count, finding, run, clear, result, ids };
    sample.addEventListener('input', () => {
      this.sample = sample.value;
      this.sampleFinding = null;
      this.renderSampleFinding();
      this.renderSampleCount();
      this.markStale();
    });
    run.addEventListener('click', () => this.runTest());
    clear.addEventListener('click', () => {
      this.sample = '';
      sample.value = '';
      this.sampleFinding = null;
      this.result = null;
      this.resultStale = false;
      this.renderSampleFinding();
      this.renderSampleCount();
      this.renderResult();
      sample.focus();
    });
    const section = this.el('section', { className: 'bg-base-100 rounded-lg p-4 mt-6', attrs: { 'aria-labelledby': ids.title } }, [
      this.el('h4', { className: 'text-base font-semibold mb-2 text-balance', id: ids.title, text: this.t('test.title') }),
      this.el('p', { className: 'text-sm max-w-prose mb-4', id: ids.help, text: this.t('test.help') }),
      this.el('div', { className: 'form-control' }, [
        this.el('div', { className: 'label flex-wrap gap-2' }, [
          this.el('label', { className: 'label-text', text: this.t('test.sample'), attrs: { for: ids.sample } }),
          count,
        ]),
        sample,
        finding,
      ]),
      this.el('div', { className: 'flex flex-wrap gap-2 mt-4' }, [run, clear]),
      result,
    ]);
    this.renderSampleCount();
    return section;
  }

  renderSampleCount() {
    if (!this.testEls) return;
    this.testEls.count.textContent = this.t('test.sampleCount', {
      count: this.format(this.sample.length),
      max: this.format(this.limits.max_sample_length),
    });
  }

  renderSampleFinding() {
    if (!this.testEls) return;
    const els = this.testEls;
    const base = els.ids.help + ' ' + els.ids.count;
    if (!this.sampleFinding) {
      els.finding.replaceChildren();
      els.sample.setAttribute('aria-describedby', base);
      els.sample.removeAttribute('aria-invalid');
      els.sample.classList.toggle('textarea-error', false);
      return;
    }
    els.finding.replaceChildren(this.findingLine(els.ids.finding, this.sampleFinding));
    els.sample.setAttribute('aria-describedby', base + ' ' + els.ids.finding);
    els.sample.setAttribute('aria-invalid', 'true');
    els.sample.classList.toggle('textarea-error', true);
  }

  enabledCount() {
    return Array.isArray(this.items) ? this.items.filter((i) => i.enabled).length : 0;
  }

  async runTest() {
    if (this.testRunning || !this.testEls) return;
    const els = this.testEls;
    const sample = this.sample;
    if (!sample.trim()) {
      this.sampleFinding = { field: 'sample', key: 'test.sampleRequired' };
      this.renderSampleFinding();
      els.sample.focus();
      return;
    }
    if (sample.length > this.limits.max_sample_length) {
      this.sampleFinding = { field: 'sample', key: 'test.sampleTooLong', vars: { count: sample.length, max: this.limits.max_sample_length } };
      this.renderSampleFinding();
      els.sample.focus();
      return;
    }
    const fields = { sample };
    let scope = 'test.scope.saved';
    let draftName = null;
    if (this.form) {
      const patternFindings = identifierPatternsLocalFindings(this.form, this.limits).filter((f) => f.field === 'pattern');
      if (patternFindings.length) scope = 'test.scope.draftSkipped';
      else {
        fields.draft = { pattern: this.form.pattern, flags: this.form.ignoreCase ? 'iu' : 'u' };
        if (this.form.mode === 'edit' && this.form.id) {
          fields.draft = { id: this.form.id, ...fields.draft };
          scope = 'test.scope.draftEdit';
          draftName = this.form.originalName;
        } else scope = 'test.scope.draft';
      }
    }
    const seq = ++this.testSeq;
    this.testRunning = true;
    const restore = this.ui().ragUiButtonBusy(this.doc, els.run, this.t('test.running'), []);
    els.result.classList.toggle('opacity-60', true);
    els.result.setAttribute('aria-busy', 'true');
    const result = await this.request('admin/identifier-patterns/test', { method: 'POST', body: this.body(fields) });
    if (seq !== this.testSeq) return;
    this.testRunning = false;
    restore();
    els.result.classList.toggle('opacity-60', false);
    els.result.removeAttribute('aria-busy');
    if (result && result.ok) {
      const body = result.body && typeof result.body === 'object' ? result.body : {};
      const matches = Array.isArray(body.matches) ? body.matches.filter((m) => m && typeof m === 'object') : [];
      const tested = body.tested && Array.isArray(body.tested.pattern_ids) ? body.tested.pattern_ids.length : null;
      const count = tested === null ? this.enabledCount() : tested;
      const ledger = identifierPatternsLedger(matches, this.items || []);
      this.result = {
        kind: 'ok',
        scope,
        scopeVars: { count, name: draftName },
        matches,
        ledger,
        segments: identifierPatternsSegments(sample, matches),
        found: Number.isInteger(body.total) ? body.total : matches.length,
        truncated: body.truncated === true,
      };
      this.resultStale = false;
      this.renderResult();
      this.setStatus(this.t('test.summary', { found: this.format(this.result.found), forms: this.format(ledger.length) }));
      return;
    }
    const mapped = mapIdentifierPatternsError(result, 'test');
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.block(mapped.kind);
      return;
    }
    if (mapped.kind === 'finding' && mapped.field === 'sample') {
      this.sampleFinding = { field: 'sample', key: mapped.key, vars: mapped.vars };
      this.renderSampleFinding();
      els.sample.focus();
      return;
    }
    if (mapped.kind === 'finding' && this.form) {
      this.form.server = mapped.findings ? mapped.findings : [{ field: mapped.field || 'pattern', key: mapped.key, vars: mapped.vars, code: mapped.code }];
      this.form.touched.add('pattern');
      this.renderFindings();
      this.result = { kind: 'refused' };
      this.resultStale = false;
      this.renderResult();
      this.setStatus(this.t('test.draftRefused'), true);
      if (this.formEls) this.formEls.pattern.focus();
      return;
    }
    this.result = { kind: 'error', message: mapped.kind === 'testError' && mapped.key !== 'test.unavailable' ? this.message(mapped) : this.t('test.unavailable') };
    this.resultStale = false;
    this.renderResult();
    this.setStatus(this.result.message, true);
  }

  foundBy(sources) {
    const names = sources.map((s) =>
      s.kind === 'builtin' ? this.t('source.builtin') : s.kind === 'draft' ? this.t('source.draft') : s.kind === 'saved' ? s.name : this.t('source.unknown'),
    );
    try {
      return new Intl.ListFormat(this.locale, { type: 'conjunction' }).format(names);
    } catch {
      return names.join(', ');
    }
  }

  renderResult() {
    if (!this.testEls) return;
    const host = this.testEls.result;
    const r = this.result;
    if (!r) {
      host.replaceChildren();
      return;
    }
    const regionChildren = [];
    if (this.resultStale) regionChildren.push(this.el('p', { className: 'text-xs', text: this.t('test.stale') }));
    const body = this.el('div', { className: 'flex flex-col gap-2' + (this.resultStale ? ' opacity-60' : '') });
    regionChildren.push(body);
    if (r.kind === 'refused' || r.kind === 'error') {
      body.appendChild(
        this.el('p', { className: 'flex items-start gap-2 text-sm max-w-prose' }, [
          this.icon('exclamation-circle', 'text-error shrink-0'),
          this.el('span', { text: r.kind === 'refused' ? this.t('test.draftRefused') : r.message }),
        ]),
      );
    } else {
      body.appendChild(this.el('p', { className: 'text-xs text-base-content/70 max-w-prose', text: this.t(r.scope, { count: this.format(r.scopeVars.count), name: r.scopeVars.name }) }));
      if (!r.matches.length) {
        body.appendChild(
          this.el('div', { className: 'py-8 text-center' }, [
            this.el('p', { className: 'text-base font-semibold text-balance', text: this.t('test.none.title') }),
            this.el('p', { className: 'text-sm max-w-prose mx-auto mt-2', text: this.t('test.none.body') }),
          ]),
        );
      } else {
        body.appendChild(this.el('p', { className: 'text-sm tabular-nums', text: this.t('test.summary', { found: this.format(r.found), forms: this.format(r.ledger.length) }) }));
        if (r.segments) {
          const pre = this.el('pre', {
            className:
              'font-mono text-xs whitespace-pre-wrap break-words max-h-40 overflow-auto border border-base-300 rounded-lg p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
            attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('test.marked.label') },
          });
          for (const segment of r.segments) {
            pre.appendChild(
              segment.mark
                ? this.el('mark', { className: 'bg-base-300 text-base-content font-semibold underline decoration-2 underline-offset-2 rounded-sm', text: segment.text })
                : this.doc.createTextNode(segment.text),
            );
          }
          body.appendChild(this.el('figure', { className: '!block min-w-0' }, [this.el('figcaption', { className: 'text-xs text-base-content/70 mb-2', text: this.t('test.marked.caption') }), pre]));
        } else {
          body.appendChild(this.el('p', { className: 'text-xs max-w-prose', text: this.t('test.marked.unavailable') }));
        }
        body.appendChild(this.ledgerTable(r.ledger));
        body.appendChild(this.el('p', { className: 'text-xs text-base-content/70 max-w-prose', text: this.t('test.legend') }));
        if (r.truncated) body.appendChild(this.el('p', { className: 'text-xs', text: this.t('test.truncated', { shown: this.format(r.matches.length), total: this.format(r.found) }) }));
      }
    }
    host.replaceChildren(this.el('div', { attrs: { role: 'region', 'aria-labelledby': this.testEls.ids.title } }, regionChildren));
  }

  ledgerTable(rows) {
    const ui = this.ui();
    const code = (value) => this.el('code', { className: 'font-mono text-sm break-all bg-base-200 rounded px-1', text: ui.ragUiVisibleControls(value), attrs: { translate: 'no' } });
    return this.el(
      'div',
      { className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('test.table.caption') } },
      [
        this.el('table', { className: 'table table-sm' }, [
          this.el('caption', { className: 'sr-only', text: this.t('test.table.caption') }),
          this.el('thead', {}, [
            this.el('tr', {}, [
              this.el('th', { className: 'font-semibold', text: this.t('col.stored'), attrs: { scope: 'col' } }),
              this.el('th', { className: 'font-semibold', text: this.t('col.spellings'), attrs: { scope: 'col' } }),
              this.el('th', { className: 'font-semibold max-md:hidden', text: this.t('col.foundBy'), attrs: { scope: 'col' } }),
            ]),
          ]),
          this.el(
            'tbody',
            {},
            rows.map((row) => {
              const foundBy = this.foundBy(row.sources);
              return this.el('tr', {}, [
                this.el('th', { className: 'font-normal min-w-0', attrs: { scope: 'row' } }, [code(row.stored)]),
                this.el('td', { className: 'min-w-0' }, [
                  this.el('div', { className: 'flex flex-wrap gap-2' }, row.spellings.map((s) => code(s))),
                  this.el('div', { className: 'md:hidden text-xs text-base-content/70 mt-1', text: foundBy }),
                ]),
                this.el('td', { className: 'max-md:hidden text-sm', text: foundBy }),
              ]);
            }),
          ),
        ]),
      ],
    );
  }
}

let IDENTIFIER_PATTERNS_INSTANCE = null;

function initIdentifierPatternsPanel() {
  const root = document.getElementById('rag-administration-identifiers');
  if (!root) return Promise.resolve();
  if (!IDENTIFIER_PATTERNS_INSTANCE) {
    IDENTIFIER_PATTERNS_INSTANCE = new IdentifierPatternsPanel(root);
    window.identifierPatternsPanel = IDENTIFIER_PATTERNS_INSTANCE;
  }
  return IDENTIFIER_PATTERNS_INSTANCE.mount();
}

function identifierPatternsBind() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-identifier-patterns-bound')) return;
    link.setAttribute('data-identifier-patterns-bound', '1');
    link.addEventListener('click', () => initIdentifierPatternsPanel());
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initIdentifierPatternsPanel = initIdentifierPatternsPanel;
  identifierPatternsBind();
  document.addEventListener('DOMContentLoaded', () => {
    identifierPatternsBind();
    const tab = document.getElementById('rag-administration');
    if (tab && tab.classList.contains('active')) initIdentifierPatternsPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IDENTIFIER_PATTERNS_LABELS,
    IDENTIFIER_PATTERNS_COMMANDS,
    identifierPatternsLabel,
    identifierPatternsListView,
    identifierPatternsLocalFindings,
    identifierPatternsSegments,
    identifierPatternsLedger,
    mapIdentifierPatternsError,
    IdentifierPatternsPanel,
    initIdentifierPatternsPanel,
  };
}
