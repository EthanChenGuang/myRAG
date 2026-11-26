/**
 * Document tags panel (UI-SPEC 6.7; D-38, D-40, D-50) and the tag and "Replaces…" controls of the Config UI upload queue
 * (UI-SPEC 6.11; D-40, D-41). Tags narrow which documents a question is answered from inside one workspace; they are not
 * permissions. Every server string is set as text through the rag-ui.js element builder.
 */

const SCOPE_TAGS_LABELS = {
  en: {
    'panel.title': 'Document tags',
    'panel.description':
      'Tags say which region, legal entity or department a document applies to, so a question can be limited to them. Follows the workspace chosen under Document Processing.',
    'panel.workspaceDefault': 'Default workspace',
    'tabs.label': 'Document tag views',
    'tab.vocabulary': 'Vocabulary',
    'tab.documents': 'Documents with suggestions: {count}',
    'tab.settings': 'Settings',
    'dimension.region': 'Region',
    'dimension.legal_entity': 'Legal entity',
    'dimension.department': 'Department',
    'vocab.col.label': 'Label',
    'vocab.col.value': 'Value',
    'vocab.col.aliases': 'Other names',
    'vocab.col.state': 'State',
    'col.actions': 'Actions',
    'vocab.caption': 'Tags in {dimension}',
    'vocab.active': 'In use',
    'vocab.retired': 'Retired',
    'vocab.valueHelp': 'Lower-case letters, digits and hyphens. It is stored on every tagged document and cannot be changed later.',
    'vocab.aliasHelp': 'Separate names with commas. They help suggest this tag for new documents.',
    'vocab.emptyDimension': 'No tag in this group yet.',
    'vocab.needLabel': 'Enter a label for the tag.',
    'vocab.badValue': 'The value may contain lower-case letters, digits and hyphens only, and must start with a letter or digit.',
    'vocab.empty.title': 'No tags yet',
    'vocab.empty.body':
      'Create tags for regions, legal entities and departments, then tag documents so questions can be limited to them. Select New tag.',
    'vocab.formLabel': 'New tag',
    'vocab.dimensionLabel': 'Dimension',
    'vocab.loaded': 'Tags: {count}',
    'action.newTag': 'New tag',
    'action.createTag': 'Create tag',
    'action.closeForm': 'Close form',
    'action.editTag': 'Edit tag',
    'action.editTagAria': 'Edit tag: {label}',
    'action.saveTag': 'Save tag',
    'action.cancelEdit': 'Cancel editing',
    'action.retireTag': 'Retire tag',
    'action.retireTagAria': 'Retire tag: {label}',
    'action.restoreTag': 'Restore tag',
    'action.restoreTagAria': 'Restore tag: {label}',
    'action.keepTag': 'Keep tag in use',
    'retire.title': 'Retire the tag {label}?',
    'retire.body':
      'Documents that carry this tag keep it, and it still limits questions. It is no longer offered for new documents. Restore tag brings it back.',
    'create.running': 'Creating…',
    'save.running': 'Saving…',
    'retire.running': 'Retiring…',
    'restore.running': 'Restoring…',
    'tag.created': 'Tag created: {label}.',
    'tag.saved': 'Tag saved: {label}.',
    'tag.retired': 'Tag retired: {label}.',
    'tag.restored': 'Tag restored: {label}.',
    'error.tagExists': 'This value already exists in {dimension}. Choose another value.',
    'error.unknownTag': 'A chosen tag no longer exists. The tag list was reloaded; choose again.',
    'error.tooManyTags': 'Too many tags are chosen. A document can carry at most 20.',
    'filter.label': 'Show',
    'filter.suggested': 'With suggestions',
    'filter.untagged': 'Untagged',
    'filter.all': 'All',
    'docs.tagFilter': 'Tag',
    'docs.anyTag': 'Any tag',
    'docs.retiredOption': '{label} (retired)',
    'docs.col.file': 'File',
    'docs.col.docType': 'Document type',
    'docs.col.tags': 'Tags',
    'docs.col.suggested': 'Suggested',
    'docs.caption': 'Documents and their tags',
    'docs.search': 'Search by file name',
    'tags.none': 'No tags',
    'docs.empty': 'No documents match this filter.',
    'docs.loading': 'Loading documents…',
    'docs.loaded': 'Documents: {count}',
    'action.loadMoreDocuments': 'Load more documents',
    'tags.pair': '{dimension}: {label}',
    'suggest.badge': 'Suggested',
    'suggest.source.rule': 'Found by a rule',
    'suggest.source.model': 'Found by a model',
    'suggest.source.unknown': 'Found by {code}',
    'suggest.added': 'Suggested tag added: {label}. It is saved with Save tags.',
    'suggest.dismissed': 'Suggestion dismissed for this edit: {label}. It stays stored and shows again after a reload.',
    'action.editTags': 'Edit tags',
    'action.editTagsAria': 'Edit tags: {file}',
    'action.addSuggested': 'Add suggested tag',
    'action.addSuggestedAria': 'Add suggested tag: {label}',
    'action.dismissSuggestion': 'Dismiss suggestion',
    'action.dismissSuggestionAria': 'Dismiss suggestion: {label}',
    'action.saveTags': 'Save tags',
    'editor.label': 'Tags of {file}',
    'editor.note': 'Tags limit retrieval as soon as they are saved. No rebuild is needed.',
    'tags.saved': 'Tags saved: {file}.',
    'tags.off': 'Document tags are off. Turn them on under Settings to tag documents and limit questions to them.',
    'tags.openSettings': 'Open tag settings',
    'tags.loading': 'Loading tags…',
    'action.refreshTags': 'Refresh tags',
    'action.refreshDocuments': 'Refresh documents',
    'tags.unavailable': 'Document tags are unavailable right now. Select Reload panel in a moment.',
    'RAG_SCOPE_TAGS.label': 'Document tags',
    'RAG_SCOPE_TAGS.help': 'Shows the tag pickers at upload and lets retrieval be limited to tagged documents.',
    'RAG_SCOPE_TAG_SUGGEST.label': 'Tag suggestions',
    'RAG_SCOPE_TAG_SUGGEST.help':
      'Suggests tags from the title and first page of new documents. A suggestion is applied only when an admin adds it.',
    'onOff.opt.off': 'Off',
    'onOff.opt.on': 'On',
    'warn.needsUnified':
      'This setting works in the unified ingest pipeline only. The ingest pipeline is set to legacy under RAG Modes.',
    'warn.datesNeedV2': 'This filter applies in the v2 retrieval pipeline only. The pipeline is set to legacy under RAG Modes.',
    'warn.suggestNeedsTags': 'Tag suggestions need document tags to be on.',
    'queue.tags': 'Tags: {count}',
    'queue.tagsFor': '(for {file})',
    'queue.tagsGroup': 'Tags for {file}',
    'queue.noTags': 'No tags are offered in this workspace yet.',
    'queue.replaces': 'Replaces…',
    'queue.replacesLine': 'Replaces: {name}',
    'action.chooseDocument': 'Choose document',
    'action.closeChooser': 'Close chooser',
    'action.clearReplacement': 'Clear replacement',
    'action.clearReplacementAria': 'Clear replacement: {name}',
    'replaces.admin': 'The chosen document stops being used for answers when this upload is ready.',
    'replaces.member': 'An admin confirms the replacement. Until then both documents are used for answers.',
    'replaces.title': 'Which document does {file} replace?',
    'replaces.search': 'Search documents',
    'replaces.empty': 'No documents in this workspace yet.',
    'replaces.noMatch': 'No document matches “{query}”.',
    'replaces.loading': 'Loading documents…',
    'replaces.unavailable': 'The document list is unavailable right now. Close the chooser and try again in a moment.',
    'replaces.searchFirst': 'Type part of a file name to find the document.',
    'upload.replacesNotFound':
      'Not uploaded. The document chosen under Replaces… is no longer in use. Clear the replacement or choose another document.',
    'upload.replacesSameLineage': 'Not uploaded. This file is already a version of the document chosen under Replaces…. Clear the replacement.',
  },
  zh: {
    'panel.title': '文档标签',
    'panel.description': '标签说明文档适用于哪个地区、法人实体或部门，从而可以把提问限定在这些范围内。跟随“文档处理”中选择的工作区。',
    'panel.workspaceDefault': '默认工作区',
    'tabs.label': '文档标签视图',
    'tab.vocabulary': '标签词表',
    'tab.documents': '有建议的文档：{count}',
    'tab.settings': '设置',
    'dimension.region': '地区',
    'dimension.legal_entity': '法人实体',
    'dimension.department': '部门',
    'vocab.col.label': '名称',
    'vocab.col.value': '取值',
    'vocab.col.aliases': '别名',
    'vocab.col.state': '状态',
    'col.actions': '操作',
    'vocab.caption': '{dimension}中的标签',
    'vocab.active': '使用中',
    'vocab.retired': '已停用',
    'vocab.valueHelp': '小写字母、数字和连字符。它会写入每个带此标签的文档，之后无法更改。',
    'vocab.aliasHelp': '用逗号分隔。别名用于为新文档建议此标签。',
    'vocab.emptyDimension': '此分组还没有标签。',
    'vocab.needLabel': '请输入标签名称。',
    'vocab.badValue': '取值只能包含小写字母、数字和连字符，且必须以字母或数字开头。',
    'vocab.empty.title': '还没有标签',
    'vocab.empty.body': '为地区、法人实体和部门创建标签，再给文档打标签，就可以把提问限定在这些范围内。请选择“新建标签”。',
    'vocab.formLabel': '新建标签',
    'vocab.dimensionLabel': '分组',
    'vocab.loaded': '标签：{count}',
    'action.newTag': '新建标签',
    'action.createTag': '创建标签',
    'action.closeForm': '关闭表单',
    'action.editTag': '编辑标签',
    'action.editTagAria': '编辑标签：{label}',
    'action.saveTag': '保存标签',
    'action.cancelEdit': '取消编辑',
    'action.retireTag': '停用标签',
    'action.retireTagAria': '停用标签：{label}',
    'action.restoreTag': '恢复标签',
    'action.restoreTagAria': '恢复标签：{label}',
    'action.keepTag': '继续使用标签',
    'retire.title': '要停用标签“{label}”吗？',
    'retire.body': '已带此标签的文档会保留它，它仍可用于限定提问，但不再提供给新文档。“恢复标签”可重新启用。',
    'create.running': '正在创建…',
    'save.running': '正在保存…',
    'retire.running': '正在停用…',
    'restore.running': '正在恢复…',
    'tag.created': '标签已创建：{label}。',
    'tag.saved': '标签已保存：{label}。',
    'tag.retired': '标签已停用：{label}。',
    'tag.restored': '标签已恢复：{label}。',
    'error.tagExists': '{dimension}中已存在此取值。请换一个。',
    'error.unknownTag': '所选标签已不存在。标签列表已重新加载，请重新选择。',
    'error.tooManyTags': '选择的标签太多。一份文档最多可带 20 个标签。',
    'filter.label': '显示',
    'filter.suggested': '有建议',
    'filter.untagged': '未打标签',
    'filter.all': '全部',
    'docs.tagFilter': '标签',
    'docs.anyTag': '任意标签',
    'docs.retiredOption': '{label}（已停用）',
    'docs.col.file': '文件',
    'docs.col.docType': '文档类型',
    'docs.col.tags': '标签',
    'docs.col.suggested': '建议',
    'docs.caption': '文档及其标签',
    'docs.search': '按文件名搜索',
    'tags.none': '无标签',
    'docs.empty': '没有符合此筛选条件的文档。',
    'docs.loading': '正在加载文档…',
    'docs.loaded': '文档：{count}',
    'action.loadMoreDocuments': '加载更多文档',
    'tags.pair': '{dimension}：{label}',
    'suggest.badge': '建议',
    'suggest.source.rule': '由规则发现',
    'suggest.source.model': '由模型发现',
    'suggest.source.unknown': '由 {code} 发现',
    'suggest.added': '已加入建议的标签：{label}。点击“保存标签”后保存。',
    'suggest.dismissed': '本次编辑已忽略建议：{label}。建议仍会保留，重新加载后会再次显示。',
    'action.editTags': '编辑标签',
    'action.editTagsAria': '编辑标签：{file}',
    'action.addSuggested': '采用建议的标签',
    'action.addSuggestedAria': '采用建议的标签：{label}',
    'action.dismissSuggestion': '忽略建议',
    'action.dismissSuggestionAria': '忽略建议：{label}',
    'action.saveTags': '保存标签',
    'editor.label': '{file} 的标签',
    'editor.note': '标签保存后立即对检索生效，无需重建。',
    'tags.saved': '标签已保存：{file}。',
    'tags.off': '文档标签已关闭。请在“设置”中开启，以便给文档打标签并限定提问范围。',
    'tags.openSettings': '打开标签设置',
    'tags.loading': '正在加载标签…',
    'action.refreshTags': '刷新标签',
    'action.refreshDocuments': '刷新文档列表',
    'tags.unavailable': '暂时无法获取文档标签。请稍后选择“重新加载面板”。',
    'RAG_SCOPE_TAGS.label': '文档标签',
    'RAG_SCOPE_TAGS.help': '上传时显示标签选择，并允许把检索限定在带标签的文档内。',
    'RAG_SCOPE_TAG_SUGGEST.label': '标签建议',
    'RAG_SCOPE_TAG_SUGGEST.help': '根据新文档的标题和首页建议标签。只有管理员采用后，建议才会生效。',
    'onOff.opt.off': '关闭',
    'onOff.opt.on': '开启',
    'warn.needsUnified': '此设置仅在统一入库流程中生效。“RAG 模式”中的入库流程目前为 legacy。',
    'warn.datesNeedV2': '此过滤仅在 v2 检索流程中生效。“RAG 模式”中的流程目前为 legacy。',
    'warn.suggestNeedsTags': '标签建议需要先开启文档标签。',
    'queue.tags': '标签：{count}',
    'queue.tagsFor': '（{file}）',
    'queue.tagsGroup': '{file} 的标签',
    'queue.noTags': '此工作区还没有可用的标签。',
    'queue.replaces': '替换…',
    'queue.replacesLine': '替换：{name}',
    'action.chooseDocument': '选择文档',
    'action.closeChooser': '关闭选择',
    'action.clearReplacement': '清除替换',
    'action.clearReplacementAria': '清除替换：{name}',
    'replaces.admin': '此上传就绪后，所选文档会停止用于回答。',
    'replaces.member': '替换需由管理员确认。在此之前，两份文档都会用于回答。',
    'replaces.title': '{file} 要替换哪份文档？',
    'replaces.search': '搜索文档',
    'replaces.empty': '此工作区还没有文档。',
    'replaces.noMatch': '没有与“{query}”匹配的文档。',
    'replaces.loading': '正在加载文档…',
    'replaces.unavailable': '暂时无法获取文档列表。请关闭选择，稍后再试。',
    'replaces.searchFirst': '输入文件名的一部分来查找文档。',
    'upload.replacesNotFound': '未上传。“替换…”中所选的文档已不再使用。请清除替换或选择其他文档。',
    'upload.replacesSameLineage': '未上传。此文件已经是“替换…”中所选文档的一个版本。请清除替换。',
  },
  it: {
    'panel.title': 'Tag dei documenti',
    'panel.description':
      'I tag indicano a quale regione, entità legale o reparto si applica un documento, così una domanda può essere limitata a quelli. Segue lo spazio di lavoro scelto in Document Processing.',
    'panel.workspaceDefault': 'Spazio di lavoro predefinito',
    'tabs.label': 'Viste dei tag dei documenti',
    'tab.vocabulary': 'Vocabolario',
    'tab.documents': 'Documenti con suggerimenti: {count}',
    'tab.settings': 'Impostazioni',
    'dimension.region': 'Regione',
    'dimension.legal_entity': 'Entità legale',
    'dimension.department': 'Reparto',
    'vocab.col.label': 'Etichetta',
    'vocab.col.value': 'Valore',
    'vocab.col.aliases': 'Altri nomi',
    'vocab.col.state': 'Stato',
    'col.actions': 'Azioni',
    'vocab.caption': 'Tag in {dimension}',
    'vocab.active': 'In uso',
    'vocab.retired': 'Ritirato',
    'vocab.valueHelp':
      'Lettere minuscole, cifre e trattini. Viene salvato su ogni documento con questo tag e non può essere cambiato in seguito.',
    'vocab.aliasHelp': 'Separa i nomi con virgole. Servono a suggerire questo tag per i nuovi documenti.',
    'vocab.emptyDimension': 'Nessun tag in questo gruppo.',
    'vocab.needLabel': "Inserisci un'etichetta per il tag.",
    'vocab.badValue': 'Il valore può contenere solo lettere minuscole, cifre e trattini e deve iniziare con una lettera o una cifra.',
    'vocab.empty.title': 'Nessun tag',
    'vocab.empty.body':
      'Crea tag per regioni, entità legali e reparti, poi assegnali ai documenti per limitare le domande. Seleziona Nuovo tag.',
    'vocab.formLabel': 'Nuovo tag',
    'vocab.dimensionLabel': 'Gruppo',
    'vocab.loaded': 'Tag: {count}',
    'action.newTag': 'Nuovo tag',
    'action.createTag': 'Crea tag',
    'action.closeForm': 'Chiudi il modulo',
    'action.editTag': 'Modifica tag',
    'action.editTagAria': 'Modifica tag: {label}',
    'action.saveTag': 'Salva tag',
    'action.cancelEdit': 'Annulla modifica',
    'action.retireTag': 'Ritira tag',
    'action.retireTagAria': 'Ritira tag: {label}',
    'action.restoreTag': 'Ripristina tag',
    'action.restoreTagAria': 'Ripristina tag: {label}',
    'action.keepTag': 'Mantieni il tag in uso',
    'retire.title': 'Ritirare il tag {label}?',
    'retire.body':
      'I documenti che hanno questo tag lo mantengono e continua a limitare le domande. Non viene più proposto per i nuovi documenti. Ripristina tag lo riattiva.',
    'create.running': 'Creazione…',
    'save.running': 'Salvataggio…',
    'retire.running': 'Ritiro…',
    'restore.running': 'Ripristino…',
    'tag.created': 'Tag creato: {label}.',
    'tag.saved': 'Tag salvato: {label}.',
    'tag.retired': 'Tag ritirato: {label}.',
    'tag.restored': 'Tag ripristinato: {label}.',
    'error.tagExists': 'Questo valore esiste già in {dimension}. Scegline un altro.',
    'error.unknownTag': "Un tag scelto non esiste più. L'elenco è stato ricaricato: scegli di nuovo.",
    'error.tooManyTags': 'Sono scelti troppi tag. Un documento può averne al massimo 20.',
    'filter.label': 'Mostra',
    'filter.suggested': 'Con suggerimenti',
    'filter.untagged': 'Senza tag',
    'filter.all': 'Tutti',
    'docs.tagFilter': 'Tag',
    'docs.anyTag': 'Qualsiasi tag',
    'docs.retiredOption': '{label} (ritirato)',
    'docs.col.file': 'File',
    'docs.col.docType': 'Tipo di documento',
    'docs.col.tags': 'Tag',
    'docs.col.suggested': 'Suggeriti',
    'docs.caption': 'Documenti e i loro tag',
    'docs.search': 'Cerca per nome del file',
    'tags.none': 'Nessun tag',
    'docs.empty': 'Nessun documento corrisponde a questo filtro.',
    'docs.loading': 'Caricamento dei documenti…',
    'docs.loaded': 'Documenti: {count}',
    'action.loadMoreDocuments': 'Carica altri documenti',
    'tags.pair': '{dimension}: {label}',
    'suggest.badge': 'Suggerito',
    'suggest.source.rule': 'Trovato da una regola',
    'suggest.source.model': 'Trovato da un modello',
    'suggest.source.unknown': 'Trovato da {code}',
    'suggest.added': 'Tag suggerito aggiunto: {label}. Viene salvato con Salva i tag.',
    'suggest.dismissed': 'Suggerimento ignorato per questa modifica: {label}. Resta salvato e ricompare dopo un nuovo caricamento.',
    'action.editTags': 'Modifica i tag',
    'action.editTagsAria': 'Modifica i tag: {file}',
    'action.addSuggested': 'Aggiungi il tag suggerito',
    'action.addSuggestedAria': 'Aggiungi il tag suggerito: {label}',
    'action.dismissSuggestion': 'Ignora il suggerimento',
    'action.dismissSuggestionAria': 'Ignora il suggerimento: {label}',
    'action.saveTags': 'Salva i tag',
    'editor.label': 'Tag di {file}',
    'editor.note': 'I tag limitano il recupero appena salvati. Non serve alcuna ricostruzione.',
    'tags.saved': 'Tag salvati: {file}.',
    'tags.off': 'I tag dei documenti sono disattivati. Attivali in Impostazioni per assegnarli e limitare le domande.',
    'tags.openSettings': 'Apri le impostazioni dei tag',
    'tags.loading': 'Caricamento dei tag…',
    'action.refreshTags': 'Aggiorna i tag',
    'action.refreshDocuments': 'Aggiorna i documenti',
    'tags.unavailable': 'I tag dei documenti non sono disponibili. Seleziona Ricarica pannello tra poco.',
    'RAG_SCOPE_TAGS.label': 'Tag dei documenti',
    'RAG_SCOPE_TAGS.help': 'Mostra la scelta dei tag al caricamento e permette di limitare il recupero ai documenti con tag.',
    'RAG_SCOPE_TAG_SUGGEST.label': 'Suggerimenti di tag',
    'RAG_SCOPE_TAG_SUGGEST.help':
      'Suggerisce tag dal titolo e dalla prima pagina dei nuovi documenti. Un suggerimento vale solo quando un amministratore lo aggiunge.',
    'onOff.opt.off': 'Disattivato',
    'onOff.opt.on': 'Attivo',
    'warn.needsUnified':
      'Questa impostazione funziona solo nella pipeline di ingestione unificata. In RAG Modes la pipeline è impostata su legacy.',
    'warn.datesNeedV2': 'Questo filtro si applica solo nella pipeline di recupero v2. In RAG Modes la pipeline è impostata su legacy.',
    'warn.suggestNeedsTags': 'I suggerimenti richiedono che i tag dei documenti siano attivi.',
    'queue.tags': 'Tag: {count}',
    'queue.tagsFor': '(per {file})',
    'queue.tagsGroup': 'Tag per {file}',
    'queue.noTags': 'Nessun tag è ancora disponibile in questo spazio di lavoro.',
    'queue.replaces': 'Sostituisce…',
    'queue.replacesLine': 'Sostituisce: {name}',
    'action.chooseDocument': 'Scegli documento',
    'action.closeChooser': 'Chiudi selezione',
    'action.clearReplacement': 'Rimuovi sostituzione',
    'action.clearReplacementAria': 'Rimuovi sostituzione: {name}',
    'replaces.admin': 'Il documento scelto smette di essere usato nelle risposte quando questo caricamento è pronto.',
    'replaces.member': 'Un amministratore conferma la sostituzione. Fino ad allora entrambi i documenti sono usati nelle risposte.',
    'replaces.title': 'Quale documento sostituisce {file}?',
    'replaces.search': 'Cerca documenti',
    'replaces.empty': 'Nessun documento in questo spazio di lavoro.',
    'replaces.noMatch': 'Nessun documento corrisponde a «{query}».',
    'replaces.loading': 'Caricamento dei documenti…',
    'replaces.unavailable': "L'elenco dei documenti non è disponibile. Chiudi la selezione e riprova tra poco.",
    'replaces.searchFirst': 'Scrivi una parte del nome del file per trovare il documento.',
    'upload.replacesNotFound':
      'Non caricato. Il documento scelto in Sostituisce… non è più in uso. Rimuovi la sostituzione o scegli un altro documento.',
    'upload.replacesSameLineage': 'Non caricato. Questo file è già una versione del documento scelto in Sostituisce…. Rimuovi la sostituzione.',
  },
};

const SCOPE_TAGS_DIMENSIONS = ['region', 'legal_entity', 'department'];
const SCOPE_TAGS_VALUE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCOPE_TAGS_VALUE_MAX = 64;
const SCOPE_TAGS_ALIAS_MAX = 50;
const SCOPE_TAGS_ALIAS_LENGTH = 200;
const SCOPE_TAGS_MAX_PER_DOCUMENT = 20;
const SCOPE_TAGS_VOCAB_PATH = '/api/rag/admin/scope-vocabulary';
const SCOPE_TAGS_DOCS_PATH = '/api/rag/admin/documents';
const SCOPE_TAGS_DATES_PATH = '/api/rag/admin/effective-dates';
const SCOPE_TAGS_PAGE = 50;
const SCOPE_TAGS_FILTERS = ['suggested', 'untagged', 'all'];
const SCOPE_TAGS_SOURCES = ['rule', 'model'];
const SCOPE_TAGS_SEARCH_DELAY_MS = 400;
const SCOPE_TAGS_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

let scopeTagsUi = null;
if (typeof require !== 'undefined') {
  try {
    scopeTagsUi = require('./rag-ui.js');
  } catch {
    scopeTagsUi = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function scopeTagsUiLib() {
  if (scopeTagsUi) return scopeTagsUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

function scopeTagsLabel(key, locale, vars) {
  const ui = scopeTagsUiLib();
  const text = ui.ragUiLookup(SCOPE_TAGS_LABELS, key, locale, vars);
  return text === undefined ? ui.ragUiLabel(key, locale, vars) : text;
}

function scopeTagsText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function scopeTagsDimensionName(dimension, locale) {
  return SCOPE_TAGS_DIMENSIONS.includes(dimension) ? scopeTagsLabel('dimension.' + dimension, locale) : scopeTagsText(dimension);
}

/** A value suggested from a label: lower case ASCII letters, digits and hyphens; a label without an ASCII letter suggests nothing. */
function scopeTagsSlugFromLabel(label) {
  const base = scopeTagsText(label).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (!/[a-z]/.test(base)) return '';
  let slug = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > SCOPE_TAGS_VALUE_MAX) slug = slug.slice(0, SCOPE_TAGS_VALUE_MAX).replace(/-+$/, '');
  return slug;
}

/** The contract's slug rule (ScopeVocabularyEntry.value). */
function scopeTagsValueValid(value) {
  const text = scopeTagsText(value);
  return text.length >= 1 && text.length <= SCOPE_TAGS_VALUE_MAX && SCOPE_TAGS_VALUE_RE.test(text);
}

/** Other names typed comma-separated (ASCII or full-width comma, or 、): trimmed, de-duplicated, capped like the contract. */
function scopeTagsAliases(text) {
  const out = [];
  for (const part of scopeTagsText(text).split(/[,，、]/)) {
    const name = part.trim().slice(0, SCOPE_TAGS_ALIAS_LENGTH);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= SCOPE_TAGS_ALIAS_MAX) break;
  }
  return out;
}

function scopeTagsEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const id = scopeTagsText(item.id);
  const dimension = scopeTagsText(item.dimension);
  const value = scopeTagsText(item.value);
  if (!id || !SCOPE_TAGS_DIMENSIONS.includes(dimension) || !value) return null;
  const aliases = Array.isArray(item.aliases) ? item.aliases.filter((a) => typeof a === 'string' && a !== '') : [];
  return { id, dimension, value, key: dimension + ':' + value, label: scopeTagsText(item.label) || value, aliases, active: item.active !== false };
}

/** The GET scope-vocabulary answer grouped by dimension in the fixed order Region, Legal entity, Department (UI-SPEC 6.7). */
function scopeTagsVocabularyView(body) {
  const data = body && typeof body === 'object' ? body : {};
  const entries = (Array.isArray(data.items) ? data.items : []).map(scopeTagsEntry).filter(Boolean);
  const byKey = {};
  for (const e of entries) byKey[e.key] = e;
  return {
    total: entries.length,
    dimensions: SCOPE_TAGS_DIMENSIONS.map((id) => ({ id, entries: entries.filter((e) => e.dimension === id) })),
    byKey,
  };
}

function scopeTagsSplitKey(key) {
  const text = scopeTagsText(key);
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const dimension = text.slice(0, at);
  const value = text.slice(at + 1);
  if (!SCOPE_TAGS_DIMENSIONS.includes(dimension) || !value) return null;
  return { dimension, value, key: dimension + ':' + value };
}

function scopeTagsPair(parts, vocab) {
  const known = vocab && vocab.byKey ? vocab.byKey[parts.key] : null;
  return { key: parts.key, dimension: parts.dimension, value: parts.value, label: known ? known.label : parts.value, known: Boolean(known), active: known ? known.active : false };
}

function scopeTagsDocTypeLabel(docType, locale) {
  if (!docType) return '';
  if (typeof window !== 'undefined' && typeof window.docTypeLabelForLocale === 'function') return window.docTypeLabelForLocale(docType, locale);
  return docType;
}

/**
 * The GET documents answer for the Documents view: named fields only, tags and suggestions with their labels from the vocabulary.
 * A suggestion the document already carries is not listed again.
 */
function scopeTagsDocumentsView(body, vocab, locale) {
  const data = body && typeof body === 'object' ? body : {};
  const rows = [];
  for (const item of Array.isArray(data.items) ? data.items : []) {
    if (!item || typeof item !== 'object') continue;
    const id = scopeTagsText(item.id);
    if (!id) continue;
    const tags = (Array.isArray(item.tags) ? item.tags : []).map(scopeTagsSplitKey).filter(Boolean).map((p) => scopeTagsPair(p, vocab));
    const keys = new Set(tags.map((t) => t.key));
    const suggestions = [];
    for (const s of Array.isArray(item.suggestions) ? item.suggestions : []) {
      if (!s || typeof s !== 'object') continue;
      const parts = scopeTagsSplitKey(scopeTagsText(s.dimension) + ':' + scopeTagsText(s.value));
      if (!parts || keys.has(parts.key) || suggestions.some((x) => x.key === parts.key)) continue;
      suggestions.push({ ...scopeTagsPair(parts, vocab), source: scopeTagsText(s.source) });
    }
    const docType = scopeTagsText(item.doc_type);
    rows.push({ id, file: scopeTagsText(item.file_name), docType, docTypeLabel: scopeTagsDocTypeLabel(docType, locale), uploadedAt: scopeTagsText(item.uploaded_at), tags, suggestions });
  }
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return { total: Math.max(number(data.total, rows.length), rows.length), suggestedTotal: number(data.suggested_total, 0), rows };
}

/** Combination warnings of the scopes group, read from the page's own inputs (UI-SPEC 6.3). */
function scopeTagsSettingsWarnings(values) {
  const v = values || {};
  const on = scopeTagsText(v.RAG_SCOPE_TAGS).trim() === 'true';
  const out = [];
  if (on && scopeTagsText(v.RAG_INGEST_PIPELINE).trim() !== 'unified') out.push('warn.needsUnified');
  if (on && scopeTagsText(v.RAG_PIPELINE).trim() !== 'v2') out.push('warn.datesNeedV2');
  if (scopeTagsText(v.RAG_SCOPE_TAG_SUGGEST).trim() === 'true' && !on) out.push('warn.suggestNeedsTags');
  return out;
}

/** The tags and replaces blocks of GET /api/rag/doc-type-defaults (plans 43 and 45), as the queue controls need them. */
function scopeTagsUploadOptions(picker) {
  const tags = picker && typeof picker === 'object' && picker.tags && typeof picker.tags === 'object' ? picker.tags : null;
  const replaces = picker && typeof picker === 'object' && picker.replaces && typeof picker.replaces === 'object' ? picker.replaces : null;
  const entries = [];
  const keys = new Set();
  for (const item of tags && Array.isArray(tags.vocabulary) ? tags.vocabulary : []) {
    if (!item || typeof item !== 'object') continue;
    const dimension = scopeTagsText(item.dimension);
    const value = scopeTagsText(item.value);
    if (!SCOPE_TAGS_DIMENSIONS.includes(dimension) || !scopeTagsValueValid(value)) continue;
    const key = dimension + ':' + value;
    if (keys.has(key)) continue;
    keys.add(key);
    entries.push({ dimension, value, key, label: scopeTagsText(item.label) || value });
  }
  return {
    tags: { enabled: Boolean(tags && tags.enabled === true), dimensions: SCOPE_TAGS_DIMENSIONS.map((id) => ({ id, entries: entries.filter((e) => e.dimension === id) })), keys },
    replaces: { enabled: Boolean(replaces && replaces.enabled === true), confirmedAtOnce: Boolean(replaces && replaces.confirmedAtOnce === true) },
  };
}

/** Whether a queue item gets the host at all; with both controls off the queue item is today's markup. */
function scopeTagsQueueHostWanted(picker) {
  const options = scopeTagsUploadOptions(picker);
  return options.tags.enabled || options.replaces.enabled;
}

/**
 * Appends `scopes` (one field per tag) and `replaces_document_id` to an upload form, only when the control is enabled and a value
 * is chosen; otherwise the form is untouched (UI-SPEC 6.11).
 */
function scopeTagsAppendUploadFields(form, item, picker) {
  if (!form || typeof form.append !== 'function' || !item || typeof item !== 'object') return;
  const options = scopeTagsUploadOptions(picker);
  if (options.tags.enabled && Array.isArray(item.scopes)) {
    const chosen = Array.from(new Set(item.scopes.filter((key) => options.tags.keys.has(key)))).sort().slice(0, SCOPE_TAGS_MAX_PER_DOCUMENT);
    for (const key of chosen) form.append('scopes', key);
  }
  const replaced = item.replaces && typeof item.replaces === 'object' ? scopeTagsText(item.replaces.id) : '';
  if (options.replaces.enabled && SCOPE_TAGS_ID_RE.test(replaced)) form.append('replaces_document_id', replaced);
}

const SCOPE_TAGS_UPLOAD_ERRORS = {
  unknown_scope_value: 'error.unknownTag',
  too_many_scopes: 'error.tooManyTags',
  replaces_not_found: 'upload.replacesNotFound',
  replaces_same_lineage: 'upload.replacesSameLineage',
};

/** The sentence for an upload refusal caused by the queue controls, or null for any other answer. */
function scopeTagsUploadErrorText(code, locale) {
  const key = Object.prototype.hasOwnProperty.call(SCOPE_TAGS_UPLOAD_ERRORS, code) ? SCOPE_TAGS_UPLOAD_ERRORS[code] : null;
  return key ? scopeTagsLabel(key, locale) : null;
}

function scopeTagsStop(event) {
  if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
}

/**
 * Bootstrap badge with base-content text and a coloured border and icon: outline success or info text on the light theme's base
 * colours is below 4.5:1 (the call plans 56, 57 and 59 made).
 */
function scopeTagsBadge(doc, tone, icon, word) {
  const ui = scopeTagsUiLib();
  const classes =
    tone === 'ghost'
      ? 'badge badge-sm badge-ghost gap-1 shrink-0 whitespace-nowrap'
      : 'badge badge-sm badge-outline border-' + tone + ' text-base-content gap-1 shrink-0 whitespace-nowrap';
  return ui.ragUiEl(doc, 'span', { className: classes }, [
    icon ? ui.ragUiIcon(doc, icon, tone === 'ghost' ? null : 'text-' + tone) : null,
    ui.ragUiEl(doc, 'span', { text: word }),
  ]);
}

class ScopeTagsPanel {
  constructor(root) {
    this.root = root;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.locale = scopeTagsUiLib().ragUiBrowserLocale();
    this.organizationId = null;
    this.tabs = null;
    this.vocabHost = null;
    this.docsHost = null;
    this.vocab = null;
    this.off = false;
    this.vocabSeq = 0;
    this.vocabLoading = false;
    this.vocabAlert = null;
    this.vocabUpdatedAt = null;
    this.refreshTagsButton = null;
    this.form = this.emptyForm(false);
    this.editing = null;
    this.docs = null;
    this.docsSeq = 0;
    this.docsUpdatedAt = null;
    this.docsToolbar = null;
    this.docsList = null;
    this.docsNote = null;
    this.docsFilter = 'suggested';
    this.docsQuery = '';
    this.docsScope = '';
    this.searchTimer = null;
    this.editor = null;
  }

  emptyForm(open) {
    return { open, dimension: 'region', label: '', value: '', valueEdited: false, aliases: '', error: null };
  }

  t(key, vars) {
    return scopeTagsLabel(key, this.locale, vars);
  }

  el(tag, options, children) {
    return scopeTagsUiLib().ragUiEl(this.doc, tag, options, children);
  }

  statusEl() {
    return this.root.querySelector('[data-scope-tags-status]');
  }

  announce(text, isError) {
    const host = this.statusEl();
    if (!host) return;
    host.classList.toggle('text-error', Boolean(isError));
    if (isError) host.replaceChildren(scopeTagsUiLib().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text }));
    else host.textContent = text;
  }

  focus(target) {
    if (target && typeof target.focus === 'function') target.focus();
  }

  query(extra) {
    const params = new URLSearchParams();
    if (this.organizationId) params.set('organizationId', this.organizationId);
    for (const [key, value] of Object.entries(extra || {})) {
      if (value === null || value === undefined || value === '') continue;
      params.set(key, String(value));
    }
    const text = params.toString();
    return text ? '?' + text : '';
  }

  dimensionName(dimension) {
    return scopeTagsDimensionName(dimension, this.locale);
  }

  pairText(pair) {
    return this.t('tags.pair', { dimension: this.dimensionName(pair.dimension), label: pair.label });
  }

  async mount() {
    const ui = scopeTagsUiLib();
    this.root.setAttribute('lang', this.locale);
    const title = this.root.querySelector('[data-scope-tags-title]');
    if (title) title.textContent = this.t('panel.title');
    const description = this.root.querySelector('[data-scope-tags-description]');
    if (description) description.textContent = this.t('panel.description');
    this.tabs = ui.ragUiSubTabs(this.doc, {
      label: this.t('tabs.label'),
      idPrefix: 'rag-scope-tags',
      tabs: [
        { id: 'vocabulary', label: this.t('tab.vocabulary') },
        { id: 'documents', label: this.t('tab.documents', { count: '…' }) },
        { id: 'settings', label: this.t('tab.settings') },
      ],
      selected: 'vocabulary',
    });
    this.vocabHost = this.el('div', { className: 'min-w-0' });
    this.docsHost = this.el('div', { className: 'min-w-0' });
    this.tabs.panels.vocabulary.appendChild(this.vocabHost);
    this.tabs.panels.documents.appendChild(this.docsHost);
    const group = this.doc.querySelector('[data-rag-settings-group="scopes"]');
    if (group) {
      this.tabs.panels.settings.appendChild(group);
      this.localizeSettings(group);
    }
    const content = this.root.querySelector('[data-scope-tags-content]');
    if (content) content.replaceChildren(this.tabs.tablist, this.tabs.panels.vocabulary, this.tabs.panels.documents, this.tabs.panels.settings);
    for (const id of ['RAG_SCOPE_TAGS', 'RAG_SCOPE_TAG_SUGGEST', 'RAG_PIPELINE', 'RAG_INGEST_PIPELINE']) {
      const control = this.doc.getElementById(id);
      if (control) control.addEventListener('change', () => this.renderAlerts());
    }
    this.bindWorkspace();
    this.renderAlerts();
    await this.loadVocabulary('first');
    await this.loadDocuments('first');
  }

  async refresh() {
    this.readWorkspace();
    this.renderAlerts();
    await this.loadVocabulary('refresh');
    await this.loadDocuments('refresh');
  }

  /** zh and it through data-rag-i18n; English is the static markup (UI-SPEC 6.3). */
  localizeSettings(group) {
    if (this.locale === 'en') return;
    const table = SCOPE_TAGS_LABELS[this.locale] || {};
    for (const node of Array.from(group.querySelectorAll('[data-rag-i18n]'))) {
      const text = table[node.getAttribute('data-rag-i18n')];
      if (text !== undefined) node.textContent = text;
    }
  }

  selector() {
    return this.doc.getElementById('workspace-selector');
  }

  readWorkspace() {
    const selector = this.selector();
    this.organizationId = selector && selector.value ? String(selector.value) : null;
    this.renderWorkspace();
  }

  workspaceName() {
    const selector = this.selector();
    if (!selector || !selector.value) return this.t('panel.workspaceDefault');
    const option = Array.from(selector.querySelectorAll('option')).find((o) => o.getAttribute('value') === selector.value);
    const name = option ? option.textContent.trim() : '';
    return name || this.t('panel.workspaceDefault');
  }

  renderWorkspace() {
    const line = this.root.querySelector('[data-scope-tags-workspace]');
    if (line) line.textContent = this.t('panel.workspace', { name: this.workspaceName() });
  }

  bindWorkspace() {
    const selector = this.selector();
    this.readWorkspace();
    if (!selector) return;
    selector.addEventListener('change', async () => {
      this.readWorkspace();
      this.vocab = null;
      this.docs = null;
      this.editing = null;
      this.editor = null;
      this.docsScope = '';
      this.form = this.emptyForm(false);
      await this.loadVocabulary('first');
      await this.loadDocuments('first');
    });
  }

  controlValue(id) {
    const control = this.doc.getElementById(id);
    return control ? scopeTagsText(control.value) : '';
  }

  renderAlerts() {
    const host = this.root.querySelector('[data-scope-tags-alert]');
    if (!host) return;
    const ui = scopeTagsUiLib();
    const values = {};
    for (const id of ['RAG_SCOPE_TAGS', 'RAG_SCOPE_TAG_SUGGEST', 'RAG_PIPELINE', 'RAG_INGEST_PIPELINE']) values[id] = this.controlValue(id);
    const nodes = scopeTagsSettingsWarnings(values).map((key) => ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', body: [this.t(key)] }));
    if (this.vocabAlert) nodes.push(this.vocabAlert);
    host.replaceChildren(...nodes);
  }

  setDocumentsCount(count) {
    const tab = this.doc.getElementById('rag-scope-tags-tab-documents');
    if (tab) tab.textContent = this.t('tab.documents', { count: scopeTagsUiLib().ragUiFormatNumber(count, this.locale) });
  }

  formatTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return scopeTagsText(value);
    try {
      return new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  updatedLine(at) {
    return this.el('p', { className: 'text-xs text-base-content/70', text: at ? scopeTagsUiLib().ragUiLabel('panel.updated', this.locale, { time: this.formatTime(at) }) : '' });
  }

  emptyBlock(title, body) {
    return this.el('div', { className: 'py-8 text-center' }, [
      this.el('p', { className: 'text-base font-semibold text-balance', text: title }),
      this.el('p', { className: 'text-sm text-base-content/70 mt-2 max-w-prose mx-auto', text: body }),
    ]);
  }

  offBlock() {
    const open = this.el('button', { className: 'btn btn-link btn-sm px-0', text: this.t('tags.openSettings'), attrs: { type: 'button' } });
    open.addEventListener('click', () => this.openSettings());
    return this.el('div', { className: 'py-8 text-center' }, [
      this.el('p', { className: 'text-sm max-w-prose mx-auto', text: this.t('tags.off') }),
      this.el('div', { className: 'mt-2' }, [open]),
    ]);
  }

  openSettings() {
    if (!this.tabs) return;
    this.tabs.select('settings');
    this.focus(this.doc.getElementById('rag-scope-tags-tab-settings'));
  }

  tableRegion(label, table) {
    return this.el(
      'div',
      {
        className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': label },
      },
      [table],
    );
  }

  th(text, extra) {
    return this.el('th', { className: 'font-semibold' + (extra ? ' ' + extra : ''), text, attrs: { scope: 'col' } });
  }

  /** A failed load: switch off (404 Not found), sign-in, workspace, or the unavailable alert. Returns the mapped error. */
  loadFailure(result, host, hadContent, reload) {
    const ui = scopeTagsUiLib();
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('tags.unavailable') });
    if (mapped.kind === 'signIn') host.replaceChildren(ui.ragUiSignInAlert(this.doc, this.locale, () => this.refresh()));
    else if (mapped.kind === 'workspace') {
      host.replaceChildren(
        ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [mapped.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, () => this.refresh())] }),
      );
    }
    return { mapped, replaced: mapped.kind === 'signIn' || mapped.kind === 'workspace', reload, hadContent };
  }

  isSwitchedOff(result) {
    return Boolean(result && !result.thrown && result.status === 404 && result.body && result.body.error === 'Not found');
  }

  // ---- Vocabulary

  async loadVocabulary(source) {
    if (!this.vocabHost) return;
    const ui = scopeTagsUiLib();
    const seq = ++this.vocabSeq;
    const hadContent = Boolean(this.vocab);
    if (hadContent) ui.ragUiListBusy(this.vocabHost, true);
    else if (source !== 'action') ui.ragUiListLoading(this.doc, this.vocabHost, this.t('tags.loading'));
    let restore = null;
    if (source === 'refresh' && this.refreshTagsButton && this.refreshTagsButton.isConnected !== false) {
      restore = ui.ragUiButtonBusy(this.doc, this.refreshTagsButton, this.t('tags.loading'));
    }
    this.vocabLoading = true;
    let result;
    try {
      result = await ui.ragUiRagRequest(SCOPE_TAGS_VOCAB_PATH + this.query(), { method: 'GET' });
    } finally {
      if (seq === this.vocabSeq) this.vocabLoading = false;
      if (restore) restore();
    }
    if (seq !== this.vocabSeq) return;
    ui.ragUiListBusy(this.vocabHost, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      this.vocab = scopeTagsVocabularyView(result.body);
      this.off = false;
      this.vocabUpdatedAt = new Date();
      this.vocabAlert = null;
      this.renderAlerts();
      this.renderVocabulary();
      this.refreshTagFilter();
      if (this.docs) this.renderDocumentRows();
      if (source === 'first' || source === 'refresh') this.announce(this.t('vocab.loaded', { count: ui.ragUiFormatNumber(this.vocab.total, this.locale) }));
      return;
    }
    if (this.isSwitchedOff(result)) {
      this.off = true;
      this.vocab = null;
      this.vocabAlert = null;
      this.renderAlerts();
      this.vocabHost.replaceChildren(this.offBlock());
      return;
    }
    const failure = this.loadFailure(result, this.vocabHost, hadContent);
    if (failure.replaced) {
      this.vocab = null;
      this.vocabAlert = null;
    } else {
      this.vocabAlert = ui.ragUiUnavailableAlert(this.doc, this.locale, failure.mapped.message, () => this.refresh());
      if (this.vocab) ui.ragUiListBusy(this.vocabHost, true, true);
      else this.vocabHost.replaceChildren();
    }
    this.renderAlerts();
    this.announce(failure.mapped.message, true);
  }

  renderVocabulary() {
    const view = this.vocab;
    if (!view || !this.vocabHost) return;
    const newTag = this.el('button', { className: 'btn btn-primary btn-sm', text: this.t('action.newTag'), attrs: { type: 'button', 'data-scope-tags-new': '' } });
    newTag.addEventListener('click', () => {
      this.form = this.emptyForm(true);
      this.renderVocabulary();
      this.focus(this.doc.getElementById('rag-scope-tags-form-label'));
    });
    this.refreshTagsButton = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.refreshTags'), attrs: { type: 'button' } });
    this.refreshTagsButton.addEventListener('click', () => this.loadVocabulary('refresh'));
    const nodes = [
      this.el('div', { className: 'flex flex-wrap items-center justify-between gap-2 mb-4' }, [
        newTag,
        this.el('div', { className: 'flex flex-wrap items-center gap-2' }, [this.updatedLine(this.vocabUpdatedAt), this.refreshTagsButton]),
      ]),
    ];
    if (this.form.open) nodes.push(this.renderCreateForm());
    if (!view.total) {
      nodes.push(this.emptyBlock(this.t('vocab.empty.title'), this.t('vocab.empty.body')));
    } else {
      for (const dimension of view.dimensions) {
        const name = this.dimensionName(dimension.id);
        nodes.push(this.el('h4', { className: 'text-base font-semibold mt-6 mb-2', text: name }));
        if (!dimension.entries.length) nodes.push(this.el('p', { className: 'text-sm text-base-content/70', text: this.t('vocab.emptyDimension') }));
        else nodes.push(this.tableRegion(this.t('vocab.caption', { dimension: name }), this.renderVocabTable(dimension, name)));
      }
    }
    this.vocabHost.replaceChildren(...nodes);
  }

  /** The create form. Panel state, not settings: input and change events stop here so the page's auto-save ignores them. */
  renderCreateForm() {
    const ids = {
      dimension: 'rag-scope-tags-form-dimension',
      label: 'rag-scope-tags-form-label',
      value: 'rag-scope-tags-form-value',
      aliases: 'rag-scope-tags-form-aliases',
      findings: 'rag-scope-tags-form-findings',
      valueHelp: 'rag-scope-tags-form-value-help',
      aliasHelp: 'rag-scope-tags-form-alias-help',
      error: 'rag-scope-tags-form-error',
    };
    const form = this.form;
    const field = (id, labelText, control, extra) =>
      this.el('div', { className: 'form-control min-w-0' }, [
        this.el('label', { className: 'label', attrs: { for: id } }, [this.el('span', { className: 'label-text', text: labelText })]),
        control,
        ...(extra || []),
      ]);
    const dimension = this.el(
      'select',
      { className: 'select select-bordered select-sm w-full', id: ids.dimension, attrs: { name: 'scope-tag-dimension', autocomplete: 'off' } },
      SCOPE_TAGS_DIMENSIONS.map((d) => this.el('option', { text: this.dimensionName(d), attrs: { value: d } })),
    );
    dimension.value = form.dimension;
    const label = this.el('input', {
      className: 'input input-bordered input-sm w-full' + (form.error && form.error.field === 'label' ? ' input-error' : ''),
      id: ids.label,
      attrs: { type: 'text', name: 'scope-tag-label', autocomplete: 'off', maxlength: '200', 'aria-invalid': form.error && form.error.field === 'label' ? 'true' : null },
    });
    label.value = form.label;
    const valueError = form.error && form.error.field === 'value';
    const value = this.el('input', {
      className: 'input input-bordered input-sm w-full font-mono' + (valueError ? ' input-error' : ''),
      id: ids.value,
      attrs: {
        type: 'text',
        name: 'scope-tag-value',
        autocomplete: 'off',
        spellcheck: 'false',
        translate: 'no',
        maxlength: String(SCOPE_TAGS_VALUE_MAX),
        'aria-describedby': ids.valueHelp + (valueError ? ' ' + ids.error : ''),
        'aria-invalid': valueError ? 'true' : null,
      },
    });
    value.value = form.value;
    const aliases = this.el('input', {
      className: 'input input-bordered input-sm w-full',
      id: ids.aliases,
      attrs: { type: 'text', name: 'scope-tag-aliases', autocomplete: 'off', 'aria-describedby': ids.aliasHelp },
    });
    aliases.value = form.aliases;
    const findings = this.el('p', { className: 'text-xs text-base-content/70 mt-2', id: ids.findings });
    const create = this.el('button', { className: 'btn btn-primary btn-sm', text: this.t('action.createTag'), attrs: { type: 'button' } });
    const close = this.el('button', { className: 'btn btn-sm', text: this.t('action.closeForm'), attrs: { type: 'button' } });
    const errorLine = form.error
      ? this.el('p', { className: 'text-xs text-error mt-1', id: ids.error }, [scopeTagsUiLib().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text: form.error.message })])
      : null;
    const update = () => {
      const missing = !form.label.trim() ? 'vocab.needLabel' : !scopeTagsValueValid(form.value) ? 'vocab.badValue' : null;
      create.disabled = Boolean(missing);
      if (missing) create.setAttribute('aria-describedby', ids.findings);
      else create.removeAttribute('aria-describedby');
      findings.textContent = missing ? this.t(missing) : '';
      findings.hidden = !missing;
    };
    const closeForm = () => {
      this.form = this.emptyForm(false);
      this.renderVocabulary();
      this.focus(this.root.querySelector('[data-scope-tags-new]'));
    };
    dimension.addEventListener('change', (event) => {
      scopeTagsStop(event);
      form.dimension = SCOPE_TAGS_DIMENSIONS.includes(dimension.value) ? dimension.value : 'region';
    });
    label.addEventListener('input', (event) => {
      scopeTagsStop(event);
      form.label = scopeTagsText(label.value);
      if (!form.valueEdited) {
        form.value = scopeTagsSlugFromLabel(form.label);
        value.value = form.value;
      }
      update();
    });
    value.addEventListener('input', (event) => {
      scopeTagsStop(event);
      form.value = scopeTagsText(value.value).trim();
      form.valueEdited = form.value !== '';
      update();
    });
    aliases.addEventListener('input', (event) => {
      scopeTagsStop(event);
      form.aliases = scopeTagsText(aliases.value);
    });
    for (const control of [label, value, aliases]) control.addEventListener('change', scopeTagsStop);
    create.addEventListener('click', () => this.createTag(create, close));
    close.addEventListener('click', closeForm);
    const region = this.el('fieldset', { className: 'bg-base-100 rounded-lg p-4 mb-4 min-w-0' }, [
      this.el('legend', { className: 'text-base font-semibold px-1', text: this.t('vocab.formLabel') }),
      this.el('div', { className: 'grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4' }, [
        field(ids.dimension, this.t('vocab.dimensionLabel'), dimension),
        field(ids.label, this.t('vocab.col.label'), label),
        field(ids.value, this.t('vocab.col.value'), value, [
          this.el('p', { className: 'text-xs text-base-content/70 mt-1', id: ids.valueHelp, text: this.t('vocab.valueHelp') }),
          errorLine,
        ]),
        field(ids.aliases, this.t('vocab.col.aliases'), aliases, [this.el('p', { className: 'text-xs text-base-content/70 mt-1', id: ids.aliasHelp, text: this.t('vocab.aliasHelp') })]),
      ]),
      findings,
      this.el('div', { className: 'flex flex-wrap gap-2 mt-4' }, [create, close]),
    ]);
    region.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        closeForm();
      } else if (event.key === 'Enter' && event.target && event.target.tagName && String(event.target.tagName).toLowerCase() === 'input') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
      }
    });
    update();
    return region;
  }

  async createTag(button, sibling) {
    const ui = scopeTagsUiLib();
    const form = this.form;
    if (!form.label.trim() || !scopeTagsValueValid(form.value)) return;
    const body = { dimension: form.dimension, value: form.value, label: form.label.trim(), aliases: scopeTagsAliases(form.aliases) };
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('create.running'), [sibling]);
    const result = await ui.ragUiRagRequest(SCOPE_TAGS_VOCAB_PATH + this.query(), { method: 'POST', body: JSON.stringify(body) });
    if (result && result.ok) {
      const item = result.body ? scopeTagsEntry(result.body.item) : null;
      this.form = this.emptyForm(false);
      await this.loadVocabulary('action');
      this.announce(this.t('tag.created', { label: item ? item.label : body.label }));
      this.focus(this.root.querySelector('[data-scope-tags-new]'));
      return;
    }
    restore();
    const word = result && result.body && typeof result.body.error === 'string' ? result.body.error : '';
    if (result && result.status === 409 && word === 'tag_exists') {
      const message = this.t('error.tagExists', { dimension: this.dimensionName(body.dimension) });
      this.form.error = { field: 'value', message };
      this.renderVocabulary();
      this.announce(message, true);
      this.focus(this.doc.getElementById('rag-scope-tags-form-value'));
      return;
    }
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('tags.unavailable') });
    if (mapped.kind === 'signIn') {
      await this.loadVocabulary('first');
      return;
    }
    if (mapped.kind === 'invalid') {
      const field = word === 'invalid_value' ? 'value' : word === 'invalid_label' ? 'label' : word === 'invalid_aliases' ? 'aliases' : mapped.field;
      if (field === 'value' || field === 'label') {
        this.form.error = { field, message: mapped.message };
        this.renderVocabulary();
        this.focus(this.doc.getElementById('rag-scope-tags-form-' + field));
      }
    }
    this.announce(mapped.message, true);
  }

  renderVocabTable(dimension, name) {
    const table = this.el('table', { className: 'table table-sm' });
    table.appendChild(this.el('caption', { className: 'sr-only', text: this.t('vocab.caption', { dimension: name }) }));
    table.appendChild(
      this.el('thead', {}, [
        this.el('tr', {}, [
          this.th(this.t('vocab.col.label')),
          this.th(this.t('vocab.col.value')),
          this.th(this.t('vocab.col.aliases'), 'hidden md:table-cell'),
          this.th(this.t('vocab.col.state')),
          this.th(this.t('col.actions')),
        ]),
      ]),
    );
    const body = this.el('tbody', {});
    for (const entry of dimension.entries) body.appendChild(this.editing && this.editing.id === entry.id ? this.renderEditRow(entry) : this.renderVocabRow(entry));
    table.appendChild(body);
    return table;
  }

  valueCell(entry) {
    return this.el('td', { className: 'align-top' }, [this.el('code', { className: 'font-mono text-xs break-all lg:break-normal lg:whitespace-nowrap', text: entry.value, attrs: { translate: 'no' } })]);
  }

  stateCell(entry) {
    return this.el('td', { className: 'align-top' }, [
      entry.active ? scopeTagsBadge(this.doc, 'success', 'check-circle', this.t('vocab.active')) : scopeTagsBadge(this.doc, 'ghost', 'archive', this.t('vocab.retired')),
    ]);
  }

  renderVocabRow(entry) {
    const edit = this.el('button', {
      className: 'btn btn-outline md:btn-sm',
      text: this.t('action.editTag'),
      attrs: { type: 'button', 'aria-label': this.t('action.editTagAria', { label: entry.label }), 'data-scope-tags-edit': entry.id },
    });
    edit.addEventListener('click', () => {
      this.editing = { id: entry.id, label: entry.label, aliases: entry.aliases.join(', ') };
      this.renderVocabulary();
      this.focus(this.doc.getElementById('rag-scope-tags-edit-label'));
    });
    const toggle = this.el('button', {
      className: 'btn btn-outline md:btn-sm',
      text: this.t(entry.active ? 'action.retireTag' : 'action.restoreTag'),
      attrs: { type: 'button', 'aria-label': this.t(entry.active ? 'action.retireTagAria' : 'action.restoreTagAria', { label: entry.label }) },
    });
    toggle.addEventListener('click', () => (entry.active ? this.retireTag(entry, toggle, edit) : this.restoreTag(entry, toggle, edit)));
    return this.el('tr', { attrs: { 'data-scope-tags-entry': entry.id } }, [
      this.el('th', { className: 'align-top font-normal text-sm break-words [overflow-wrap:anywhere] min-w-32', attrs: { scope: 'row' } }, [
        this.el('span', { className: 'block', text: entry.label }),
        entry.aliases.length ? this.el('span', { className: 'md:hidden block text-xs text-base-content/70 mt-1', text: entry.aliases.join(', ') }) : null,
      ]),
      this.valueCell(entry),
      this.el('td', { className: 'align-top hidden md:table-cell text-sm break-words [overflow-wrap:anywhere] min-w-40', text: entry.aliases.join(', ') }),
      this.stateCell(entry),
      this.el('td', { className: 'align-top' }, [this.el('div', { className: 'flex flex-wrap gap-2 md:min-w-max' }, [edit, toggle])]),
    ]);
  }

  renderEditRow(entry) {
    const editing = this.editing;
    const labelId = 'rag-scope-tags-edit-label';
    const aliasId = 'rag-scope-tags-edit-aliases';
    const findingsId = 'rag-scope-tags-edit-findings';
    const label = this.el('input', { className: 'input input-bordered input-sm w-full', id: labelId, attrs: { type: 'text', name: 'scope-tag-label-edit', autocomplete: 'off', maxlength: '200' } });
    label.value = editing.label;
    const aliases = this.el('input', {
      className: 'input input-bordered input-sm w-full',
      id: aliasId,
      attrs: { type: 'text', name: 'scope-tag-aliases-edit', autocomplete: 'off', 'aria-describedby': 'rag-scope-tags-edit-alias-help' },
    });
    aliases.value = editing.aliases;
    const save = this.el('button', { className: 'btn btn-primary md:btn-sm', text: this.t('action.saveTag'), attrs: { type: 'button' } });
    const cancel = this.el('button', { className: 'btn md:btn-sm', text: this.t('action.cancelEdit'), attrs: { type: 'button' } });
    const findings = this.el('p', { className: 'text-xs text-base-content/70 mt-1', id: findingsId, text: this.t('vocab.needLabel') });
    const update = () => {
      const ready = Boolean(editing.label.trim());
      save.disabled = !ready;
      findings.hidden = ready;
      if (ready) save.removeAttribute('aria-describedby');
      else save.setAttribute('aria-describedby', findingsId);
    };
    label.addEventListener('input', (event) => {
      scopeTagsStop(event);
      editing.label = scopeTagsText(label.value);
      update();
    });
    aliases.addEventListener('input', (event) => {
      scopeTagsStop(event);
      editing.aliases = scopeTagsText(aliases.value);
    });
    for (const control of [label, aliases]) control.addEventListener('change', scopeTagsStop);
    const cancelEdit = () => {
      this.editing = null;
      this.renderVocabulary();
      this.focus(this.root.querySelector('[data-scope-tags-edit="' + entry.id + '"]'));
    };
    save.addEventListener('click', () => this.saveTag(entry, save, cancel));
    cancel.addEventListener('click', cancelEdit);
    const row = this.el('tr', { attrs: { 'data-scope-tags-entry': entry.id } }, [
      this.el('th', { className: 'align-top font-normal min-w-40', attrs: { scope: 'row' } }, [
        this.el('label', { className: 'label py-1', attrs: { for: labelId } }, [this.el('span', { className: 'label-text text-xs', text: this.t('vocab.col.label') })]),
        label,
        findings,
      ]),
      this.valueCell(entry),
      this.el('td', { className: 'align-top min-w-40' }, [
        this.el('label', { className: 'label py-1', attrs: { for: aliasId } }, [this.el('span', { className: 'label-text text-xs', text: this.t('vocab.col.aliases') })]),
        aliases,
        this.el('p', { className: 'text-xs text-base-content/70 mt-1', id: 'rag-scope-tags-edit-alias-help', text: this.t('vocab.aliasHelp') }),
      ]),
      this.stateCell(entry),
      this.el('td', { className: 'align-top' }, [this.el('div', { className: 'flex flex-wrap gap-2 md:min-w-max' }, [save, cancel])]),
    ]);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        cancelEdit();
      }
    });
    update();
    return row;
  }

  async patchEntry(body) {
    return scopeTagsUiLib().ragUiRagRequest(SCOPE_TAGS_VOCAB_PATH + this.query(), { method: 'PATCH', body: JSON.stringify(body) });
  }

  async entryActionFailed(result) {
    const ui = scopeTagsUiLib();
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('tags.unavailable') });
    if (mapped.kind === 'changed' || mapped.kind === 'signIn' || mapped.kind === 'outcomeUnknown') {
      this.editing = null;
      await this.loadVocabulary(mapped.kind === 'signIn' ? 'first' : 'action');
    }
    if (mapped.kind !== 'signIn') this.announce(mapped.message, true);
  }

  async saveTag(entry, button, sibling) {
    const ui = scopeTagsUiLib();
    const label = this.editing.label.trim();
    if (!label) return;
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('save.running'), [sibling]);
    const result = await this.patchEntry({ id: entry.id, label, aliases: scopeTagsAliases(this.editing.aliases) });
    if (result && result.ok) {
      const item = result.body ? scopeTagsEntry(result.body.item) : null;
      this.editing = null;
      await this.loadVocabulary('action');
      this.announce(this.t('tag.saved', { label: item ? item.label : label }));
      this.focus(this.root.querySelector('[data-scope-tags-edit="' + entry.id + '"]'));
      return;
    }
    restore();
    await this.entryActionFailed(result);
  }

  async retireTag(entry, button, sibling) {
    const ui = scopeTagsUiLib();
    let result = null;
    const confirmed = await ui.ragUiConfirmDialog(this.doc, {
      title: this.t('retire.title', { label: entry.label }),
      body: [this.t('retire.body')],
      keepLabel: this.t('action.keepTag'),
      confirmLabel: this.t('action.retireTag'),
      runningLabel: this.t('retire.running'),
      tone: 'primary',
      opener: button,
      fallbackFocus: this.statusEl(),
      onConfirm: async () => {
        result = await this.patchEntry({ id: entry.id, active: false });
      },
    });
    if (!confirmed || !result) return;
    if (result.ok) {
      await this.loadVocabulary('action');
      this.announce(this.t('tag.retired', { label: entry.label }));
      this.focus(this.root.querySelector('[data-scope-tags-edit="' + entry.id + '"]') || this.statusEl());
      return;
    }
    if (sibling) sibling.disabled = false;
    await this.entryActionFailed(result);
  }

  async restoreTag(entry, button, sibling) {
    const ui = scopeTagsUiLib();
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('restore.running'), [sibling]);
    const result = await this.patchEntry({ id: entry.id, active: true });
    if (result && result.ok) {
      await this.loadVocabulary('action');
      this.announce(this.t('tag.restored', { label: entry.label }));
      this.focus(this.root.querySelector('[data-scope-tags-edit="' + entry.id + '"]') || this.statusEl());
      return;
    }
    restore();
    await this.entryActionFailed(result);
  }

  // ---- Documents

  async loadDocuments(source, offset) {
    if (!this.docsHost) return;
    const ui = scopeTagsUiLib();
    const append = source === 'more';
    const seq = ++this.docsSeq;
    const hadContent = Boolean(this.docs);
    this.ensureDocsLayout();
    let restore = null;
    if (append) {
      const more = this.root.querySelector('[data-scope-tags-more]');
      if (more) restore = ui.ragUiButtonBusy(this.doc, more, this.t('docs.loading'));
    } else if (hadContent) ui.ragUiListBusy(this.docsList, true);
    else ui.ragUiListLoading(this.doc, this.docsList, this.t('docs.loading'));
    const refresh = this.root.querySelector('[data-scope-tags-refresh-docs]');
    if (source === 'refresh' && hadContent && refresh) restore = ui.ragUiButtonBusy(this.doc, refresh, this.t('docs.loading'));
    let result;
    try {
      result = await ui.ragUiRagRequest(
        SCOPE_TAGS_DOCS_PATH +
          this.query({ filter: this.docsFilter, q: this.docsQuery.trim(), scopes: this.docsScope, limit: SCOPE_TAGS_PAGE, offset: append ? offset || 0 : 0 }),
        { method: 'GET' },
      );
    } finally {
      if (restore) restore();
    }
    if (seq !== this.docsSeq) return;
    if (this.docsList) ui.ragUiListBusy(this.docsList, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      const next = scopeTagsDocumentsView(result.body, this.vocab, this.locale);
      let firstNew = null;
      if (append && this.docs) {
        const known = new Set(this.docs.rows.map((row) => row.id));
        const added = next.rows.filter((row) => !known.has(row.id));
        firstNew = added[0] ? added[0].id : null;
        this.docs = { total: next.total, suggestedTotal: next.suggestedTotal, rows: [...this.docs.rows, ...added] };
      } else {
        this.docs = next;
      }
      this.docsUpdatedAt = new Date();
      this.docsNote.replaceChildren();
      this.setDocumentsCount(this.docs.suggestedTotal);
      this.renderDocumentRows();
      const updated = this.root.querySelector('[data-scope-tags-docs-updated]');
      if (updated) updated.textContent = this.updatedLine(this.docsUpdatedAt).textContent;
      if (firstNew) this.focus(this.root.querySelector('[data-scope-tags-edit-doc="' + firstNew + '"]'));
      if (source === 'refresh' || source === 'filter') this.announce(this.t('docs.loaded', { count: ui.ragUiFormatNumber(this.docs.total, this.locale) }));
      return;
    }
    if (this.isSwitchedOff(result)) {
      this.docs = null;
      this.docsToolbar = null;
      this.docsHost.replaceChildren(this.offBlock());
      this.setDocumentsCount('—');
      return;
    }
    const failure = this.loadFailure(result, this.docsHost, hadContent);
    if (failure.replaced) {
      this.docs = null;
      this.docsToolbar = null;
      this.setDocumentsCount('—');
    } else {
      this.docsNote.replaceChildren(ui.ragUiUnavailableAlert(this.doc, this.locale, failure.mapped.message, () => this.loadDocuments('refresh')));
      if (this.docs) ui.ragUiListBusy(this.docsList, true, true);
      else this.docsList.replaceChildren();
    }
    this.announce(failure.mapped.message, true);
  }

  /** Toolbar, note and list hosts, built once so the search field keeps focus while the list reloads. */
  ensureDocsLayout() {
    if (this.docsToolbar && this.docsToolbar.parentNode === this.docsHost) return;
    this.docsToolbar = this.renderDocsToolbar();
    this.docsNote = this.el('div', { className: 'mb-4 empty:mb-0' });
    this.docsList = this.el('div', { className: 'min-w-0' });
    this.docsHost.replaceChildren(this.docsToolbar, this.docsNote, this.docsList);
    this.refreshTagFilter();
  }

  renderDocsToolbar() {
    const filters = this.el('fieldset', { className: 'min-w-0' }, [
      this.el('legend', { className: 'text-xs font-semibold mb-1', text: this.t('filter.label') }),
      this.el(
        'div',
        { className: 'join flex-wrap' },
        SCOPE_TAGS_FILTERS.map((id) => {
          const radio = this.el('input', {
            className: 'join-item btn btn-sm',
            attrs: { type: 'radio', name: 'rag-scope-tags-filter', value: id, 'aria-label': this.t('filter.' + id) },
          });
          radio.checked = id === this.docsFilter;
          radio.addEventListener('change', (event) => {
            scopeTagsStop(event);
            if (!radio.checked) return;
            this.docsFilter = id;
            this.editor = null;
            this.loadDocuments('filter');
          });
          return radio;
        }),
      ),
    ]);
    const tagId = 'rag-scope-tags-docs-tag';
    const tag = this.el('select', { className: 'select select-bordered select-sm w-full', id: tagId, attrs: { name: 'scope-tag-filter', autocomplete: 'off', 'data-scope-tags-tag-filter': '' } });
    tag.addEventListener('change', (event) => {
      scopeTagsStop(event);
      this.docsScope = scopeTagsSplitKey(tag.value) ? scopeTagsText(tag.value) : '';
      this.editor = null;
      this.loadDocuments('filter');
    });
    const searchId = 'rag-scope-tags-docs-search';
    const search = this.el('input', {
      className: 'input input-bordered input-sm w-full',
      id: searchId,
      attrs: { type: 'search', name: 'scope-tag-document-search', autocomplete: 'off', spellcheck: 'false', maxlength: '200' },
    });
    search.value = this.docsQuery;
    const run = () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = null;
      const next = scopeTagsText(search.value);
      if (next === this.docsQuery && this.docs) return;
      this.docsQuery = next;
      this.editor = null;
      this.loadDocuments('filter');
    };
    search.addEventListener('input', (event) => {
      scopeTagsStop(event);
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(run, SCOPE_TAGS_SEARCH_DELAY_MS);
    });
    search.addEventListener('change', scopeTagsStop);
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      run();
    });
    const refresh = this.el('button', { className: 'btn btn-outline btn-sm', text: this.t('action.refreshDocuments'), attrs: { type: 'button', 'data-scope-tags-refresh-docs': '' } });
    refresh.addEventListener('click', () => this.loadDocuments('refresh'));
    const control = (id, text, input) =>
      this.el('div', { className: 'form-control min-w-0' }, [
        this.el('label', { className: 'label py-1', attrs: { for: id } }, [this.el('span', { className: 'label-text text-xs font-semibold', text })]),
        input,
      ]);
    return this.el('div', { className: 'flex flex-col gap-4 mb-4' }, [
      this.el('div', { className: 'grid grid-cols-1 md:grid-cols-3 gap-4 items-end' }, [
        filters,
        control(tagId, this.t('docs.tagFilter'), tag),
        control(searchId, this.t('docs.search'), search),
      ]),
      this.el('div', { className: 'flex flex-wrap items-center justify-between gap-2' }, [
        this.el('p', { className: 'text-xs text-base-content/70', attrs: { 'data-scope-tags-docs-updated': '' } }),
        refresh,
      ]),
    ]);
  }

  /** The tag filter lists every value of the vocabulary, retired ones marked, grouped by dimension. */
  refreshTagFilter() {
    const select = this.root.querySelector('[data-scope-tags-tag-filter]');
    if (!select) return;
    const options = [this.el('option', { text: this.t('docs.anyTag'), attrs: { value: '' } })];
    for (const dimension of this.vocab ? this.vocab.dimensions : []) {
      if (!dimension.entries.length) continue;
      options.push(
        this.el(
          'optgroup',
          { attrs: { label: this.dimensionName(dimension.id) } },
          dimension.entries.map((e) => this.el('option', { text: e.active ? e.label : this.t('docs.retiredOption', { label: e.label }), attrs: { value: e.key } })),
        ),
      );
    }
    select.replaceChildren(...options);
    if (this.docsScope && this.vocab && !this.vocab.byKey[this.docsScope]) this.docsScope = '';
    select.value = this.docsScope;
  }

  renderDocumentRows() {
    if (!this.docs || !this.docsList) return;
    if (this.docs.rows.length && this.vocab) {
      for (const row of this.docs.rows) {
        for (const pair of [...row.tags, ...row.suggestions]) Object.assign(pair, scopeTagsPair(pair, this.vocab));
      }
    }
    const nodes = [];
    if (!this.docs.rows.length) {
      nodes.push(this.el('p', { className: 'text-sm text-base-content/70 py-8 text-center', text: this.t('docs.empty') }));
    } else {
      nodes.push(this.tableRegion(this.t('docs.caption'), this.renderDocsTable(this.docs.rows)));
      if (this.docs.rows.length < this.docs.total) {
        const more = this.el('button', { className: 'btn btn-outline btn-sm mt-4', text: this.t('action.loadMoreDocuments'), attrs: { type: 'button', 'data-scope-tags-more': '' } });
        more.addEventListener('click', () => this.loadDocuments('more', this.docs ? this.docs.rows.length : 0));
        nodes.push(more);
      }
    }
    this.docsList.replaceChildren(...nodes);
  }

  renderDocsTable(rows) {
    const table = this.el('table', { className: 'table table-sm' });
    table.appendChild(this.el('caption', { className: 'sr-only', text: this.t('docs.caption') }));
    table.appendChild(
      this.el('thead', {}, [
        this.el('tr', {}, [
          this.th(this.t('docs.col.file')),
          this.th(this.t('docs.col.docType'), 'hidden lg:table-cell'),
          this.th(this.t('docs.col.tags')),
          this.th(this.t('docs.col.suggested')),
          this.th(this.t('col.actions')),
        ]),
      ]),
    );
    const body = this.el('tbody', {});
    for (const row of rows) {
      body.appendChild(this.renderDocRow(row));
      if (this.editor && this.editor.docId === row.id) body.appendChild(this.renderEditor(row));
    }
    table.appendChild(body);
    return table;
  }

  pairNode(pair) {
    if (pair.known) {
      return this.el('span', { className: 'break-words [overflow-wrap:anywhere]' }, [
        this.pairText(pair),
        pair.active ? null : this.el('span', { className: 'text-xs text-base-content/70 ml-1', text: '(' + this.t('vocab.retired') + ')' }),
      ]);
    }
    return this.el('span', { className: 'break-words' }, [
      this.dimensionName(pair.dimension) + (this.locale === 'zh' ? '：' : ': '),
      this.el('code', { className: 'font-mono text-xs break-all', text: pair.value, attrs: { translate: 'no' } }),
    ]);
  }

  sourceNode(source) {
    if (SCOPE_TAGS_SOURCES.includes(source)) return this.el('span', { text: this.t('suggest.source.' + source) });
    return scopeTagsUiLib().ragUiCodeSentence(this.doc, this.locale, source, this.t('suggest.source.unknown'));
  }

  suggestionLine(pair) {
    return this.el('div', { className: 'flex flex-wrap items-center gap-1 min-w-0' }, [
      scopeTagsBadge(this.doc, 'info', 'lightbulb', this.t('suggest.badge')),
      this.pairNode(pair),
      this.el('span', { className: 'block w-full text-xs text-base-content/70' }, [this.sourceNode(pair.source)]),
    ]);
  }

  renderDocRow(row) {
    const tags = row.tags.length
      ? this.el('ul', { className: 'flex flex-col gap-1' }, row.tags.map((pair) => this.el('li', {}, [this.pairNode(pair)])))
      : this.el('span', { className: 'text-base-content/70', text: this.t('tags.none') });
    const suggested = this.el('div', { className: 'flex flex-col gap-2' }, row.suggestions.map((pair) => this.suggestionLine(pair)));
    const edit = this.el('button', {
      className: 'btn btn-outline md:btn-sm whitespace-nowrap',
      text: this.t('action.editTags'),
      attrs: { type: 'button', 'aria-label': this.t('action.editTagsAria', { file: row.file }), 'aria-expanded': this.editor && this.editor.docId === row.id ? 'true' : 'false', 'data-scope-tags-edit-doc': row.id },
    });
    edit.addEventListener('click', () => this.openEditor(row));
    return this.el('tr', { attrs: { 'data-scope-tags-doc': row.id } }, [
      this.el('th', { className: 'align-top font-normal min-w-40', attrs: { scope: 'row' } }, [
        this.el('span', { className: 'block text-sm font-semibold [overflow-wrap:anywhere]', text: row.file }),
      ]),
      this.el('td', { className: 'align-top hidden lg:table-cell break-words', text: row.docTypeLabel || '—' }),
      this.el('td', { className: 'align-top text-sm min-w-40' }, [tags]),
      this.el('td', { className: 'align-top text-sm min-w-40' }, [suggested]),
      this.el('td', { className: 'align-top' }, [edit]),
    ]);
  }

  openEditor(row) {
    this.editor = { docId: row.id, checked: new Set(row.tags.map((t) => t.key)), dismissed: new Set(), error: null };
    this.renderDocumentRows();
    const first = this.root.querySelector('[data-scope-tags-editor] input');
    this.focus(first || this.root.querySelector('[data-scope-tags-editor] button'));
  }

  closeEditor(row) {
    this.editor = null;
    this.renderDocumentRows();
    this.focus(this.root.querySelector('[data-scope-tags-edit-doc="' + row.id + '"]'));
  }

  /** Options of one dimension: its active values, plus any value the document carries now (retired or unknown) so saving keeps it. */
  editorOptions(dimensionId, row) {
    const options = [];
    const seen = new Set();
    const entries = this.vocab ? this.vocab.dimensions.find((d) => d.id === dimensionId).entries : [];
    for (const e of entries) {
      if (!e.active && !this.editor.checked.has(e.key)) continue;
      options.push({ key: e.key, label: e.label, active: e.active, known: true });
      seen.add(e.key);
    }
    for (const pair of row.tags) {
      if (pair.dimension !== dimensionId || seen.has(pair.key) || !this.editor.checked.has(pair.key)) continue;
      options.push({ key: pair.key, label: pair.label, value: pair.value, active: pair.active, known: pair.known });
      seen.add(pair.key);
    }
    return options;
  }

  renderEditor(row) {
    const editor = this.editor;
    const boxes = new Map();
    const fieldsets = [];
    for (const dimensionId of SCOPE_TAGS_DIMENSIONS) {
      const options = this.editorOptions(dimensionId, row);
      const suggestions = row.suggestions.filter((s) => s.dimension === dimensionId && !editor.dismissed.has(s.key) && !editor.checked.has(s.key));
      if (!options.length && !suggestions.length) continue;
      const name = this.dimensionName(dimensionId);
      const children = [this.el('legend', { className: 'text-sm font-semibold px-1', text: name })];
      if (editor.error && editor.error.dimensions.has(dimensionId)) {
        children.push(this.el('p', { className: 'text-xs text-error mb-2', attrs: { 'data-scope-tags-editor-error': dimensionId } }, [scopeTagsUiLib().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text: editor.error.message })]));
      }
      if (options.length) {
        const list = this.el('div', { className: 'flex flex-col gap-1' });
        for (const option of options) {
          const box = this.el('input', { className: 'checkbox checkbox-sm', attrs: { type: 'checkbox', value: option.key, name: 'scope-tag-' + dimensionId } });
          box.checked = editor.checked.has(option.key);
          box.addEventListener('change', (event) => {
            scopeTagsStop(event);
            if (box.checked) editor.checked.add(option.key);
            else editor.checked.delete(option.key);
          });
          boxes.set(option.key, box);
          list.appendChild(
            this.el('label', { className: 'label cursor-pointer justify-start gap-2 py-1 min-w-0' }, [
              box,
              option.known
                ? this.el('span', { className: 'label-text break-words [overflow-wrap:anywhere] min-w-0', text: option.label })
                : this.el('code', { className: 'font-mono text-xs break-all', text: option.value || option.label, attrs: { translate: 'no' } }),
              option.active ? null : this.el('span', { className: 'text-xs text-base-content/70', text: '(' + this.t('vocab.retired') + ')' }),
            ]),
          );
        }
        children.push(
          this.el(
            'div',
            {
              className: 'max-h-72 overflow-y-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
              attrs: { role: 'region', tabindex: '0', 'aria-label': name },
            },
            [list],
          ),
        );
      }
      for (const pair of suggestions) {
        const line = this.el('div', { className: 'flex flex-col gap-1 mt-4 min-w-0' });
        const add = this.el('button', {
          className: 'btn btn-outline btn-sm',
          text: this.t('action.addSuggested'),
          attrs: { type: 'button', 'aria-label': this.t('action.addSuggestedAria', { label: pair.label }) },
        });
        add.disabled = !(pair.known && pair.active && boxes.has(pair.key));
        const dismiss = this.el('button', {
          className: 'btn btn-ghost btn-sm',
          text: this.t('action.dismissSuggestion'),
          attrs: { type: 'button', 'aria-label': this.t('action.dismissSuggestionAria', { label: pair.label }) },
        });
        add.addEventListener('click', () => {
          const box = boxes.get(pair.key);
          if (!box) return;
          box.checked = true;
          editor.checked.add(pair.key);
          line.hidden = true;
          this.announce(this.t('suggest.added', { label: pair.label }));
          this.focus(box);
        });
        dismiss.addEventListener('click', () => {
          editor.dismissed.add(pair.key);
          line.hidden = true;
          this.announce(this.t('suggest.dismissed', { label: pair.label }));
          this.focus(this.root.querySelector('[data-scope-tags-save]'));
        });
        line.append(
          this.el('div', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [scopeTagsBadge(this.doc, 'info', 'lightbulb', this.t('suggest.badge')), this.pairNode(pair)]),
          this.el('span', { className: 'text-xs text-base-content/70' }, [this.sourceNode(pair.source)]),
          this.el('div', { className: 'flex flex-wrap gap-2' }, [add, dismiss]),
        );
        children.push(line);
      }
      fieldsets.push(this.el('fieldset', { className: 'min-w-0 mb-4' }, children));
    }
    const save = this.el('button', { className: 'btn btn-primary btn-sm', text: this.t('action.saveTags'), attrs: { type: 'button', 'data-scope-tags-save': '' } });
    const cancel = this.el('button', { className: 'btn btn-sm', text: this.t('action.cancelEdit'), attrs: { type: 'button' } });
    save.addEventListener('click', () => this.saveTags(row, save, cancel));
    cancel.addEventListener('click', () => this.closeEditor(row));
    const box = this.el('div', { className: 'bg-base-100 rounded-lg p-4 min-w-0', attrs: { role: 'group', 'aria-label': this.t('editor.label', { file: row.file }) } }, [
      this.el('div', { className: 'grid grid-cols-1 lg:grid-cols-3 gap-x-6' }, fieldsets),
      this.el('div', { className: 'flex flex-wrap items-center justify-between gap-2 mt-2' }, [
        this.el('p', { className: 'text-xs text-base-content/70 max-w-prose', text: this.t('editor.note') }),
        this.el('div', { className: 'flex flex-wrap gap-2' }, [save, cancel]),
      ]),
    ]);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        this.closeEditor(row);
      }
    });
    return this.el('tr', { attrs: { 'data-scope-tags-editor': row.id } }, [this.el('td', { className: 'p-2', attrs: { colspan: '5' } }, [box])]);
  }

  async saveTags(row, button, sibling) {
    const ui = scopeTagsUiLib();
    const editor = this.editor;
    if (!editor) return;
    const scopes = Array.from(editor.checked).sort();
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('save.running'), [sibling]);
    const result = await ui.ragUiRagRequest(SCOPE_TAGS_DOCS_PATH + '/' + encodeURIComponent(row.id) + '/scopes' + this.query(), {
      method: 'PUT',
      body: JSON.stringify({ scopes }),
    });
    if (result && result.ok) {
      this.editor = null;
      await this.loadDocuments('action');
      this.announce(this.t('tags.saved', { file: row.file }));
      this.focus(this.root.querySelector('[data-scope-tags-edit-doc="' + row.id + '"]') || this.statusEl());
      return;
    }
    restore();
    const word = result && result.body && typeof result.body.error === 'string' ? result.body.error : '';
    if (result && result.status === 400 && (word === 'unknown_scope_value' || word === 'too_many_scopes')) {
      let message = this.t('error.tooManyTags');
      let dimensions = new Set(scopes.map((key) => key.split(':')[0]));
      if (word === 'unknown_scope_value') {
        message = this.t('error.unknownTag');
        await this.loadVocabulary('action');
        const vanished = scopes.filter((key) => !(this.vocab && this.vocab.byKey[key]));
        for (const key of vanished) editor.checked.delete(key);
        dimensions = new Set(vanished.map((key) => key.split(':')[0]));
        if (!dimensions.size) dimensions = new Set([scopes.length ? scopes[0].split(':')[0] : SCOPE_TAGS_DIMENSIONS[0]]);
      }
      if (this.editor === editor) {
        editor.error = { dimensions, message };
        this.renderDocumentRows();
      }
      this.announce(message, true);
      this.focus(this.root.querySelector('[data-scope-tags-editor-error]'));
      return;
    }
    const mapped = ui.ragUiMapError(result, this.locale, { unavailable: this.t('tags.unavailable') });
    if (mapped.kind === 'changed' || mapped.kind === 'signIn') {
      this.editor = null;
      await this.loadDocuments(mapped.kind === 'signIn' ? 'first' : 'action');
    }
    if (mapped.kind !== 'signIn') this.announce(mapped.message, true);
  }
}

// ---- Upload queue controls (UI-SPEC 6.11). DOM calls only; nothing here goes through the queue's template string.

function scopeTagsQueueEl(tag, options, children) {
  return scopeTagsUiLib().ragUiEl(null, tag, options, children);
}

function scopeTagsQueueTagControl(item, options, locale) {
  const ui = scopeTagsUiLib();
  const t = (key, vars) => scopeTagsLabel(key, locale, vars);
  const file = scopeTagsText(item.name);
  const selected = new Set((Array.isArray(item.scopes) ? item.scopes : []).filter((key) => options.tags.keys.has(key)));
  item.scopes = Array.from(selected).sort();
  const count = scopeTagsQueueEl('span', { text: t('queue.tags', { count: ui.ragUiFormatNumber(selected.size, locale) }) });
  const summary = scopeTagsQueueEl('summary', { className: 'btn btn-outline btn-sm gap-1 font-normal' }, [
    ui.ragUiIcon(null, 'tags'),
    count,
    scopeTagsQueueEl('span', { className: 'sr-only', text: ' ' + t('queue.tagsFor', { file }) }),
  ]);
  const groups = [];
  for (const dimension of options.tags.dimensions) {
    if (!dimension.entries.length) continue;
    groups.push(
      scopeTagsQueueEl('fieldset', { className: 'mb-2 min-w-0' }, [
        scopeTagsQueueEl('legend', { className: 'text-xs font-semibold', text: scopeTagsDimensionName(dimension.id, locale) }),
        ...dimension.entries.map((entry) => {
          const box = scopeTagsQueueEl('input', { className: 'checkbox checkbox-sm', attrs: { type: 'checkbox', name: 'queue-scope-tag', value: entry.key } });
          box.checked = selected.has(entry.key);
          box.addEventListener('change', (event) => {
            scopeTagsStop(event);
            if (box.checked) selected.add(entry.key);
            else selected.delete(entry.key);
            item.scopes = Array.from(selected).sort();
            count.textContent = t('queue.tags', { count: ui.ragUiFormatNumber(selected.size, locale) });
          });
          return scopeTagsQueueEl('label', { className: 'label cursor-pointer justify-start gap-2 py-1 min-w-0' }, [
            box,
            scopeTagsQueueEl('span', { className: 'label-text break-words [overflow-wrap:anywhere] min-w-0', text: entry.label }),
          ]);
        }),
      ]),
    );
  }
  if (!groups.length) groups.push(scopeTagsQueueEl('p', { className: 'text-xs text-base-content/70', text: t('queue.noTags') }));
  const content = scopeTagsQueueEl(
    'div',
    {
      className: 'dropdown-content z-10 bg-base-100 rounded-box shadow p-4 w-72 max-h-72 overflow-y-auto overscroll-contain',
      attrs: { role: 'group', 'aria-label': t('queue.tagsGroup', { file }) },
    },
    groups,
  );
  const details = scopeTagsQueueEl('details', { className: 'dropdown' }, [summary, content]);
  const outside = (event) => {
    if (!details.isConnected || !details.open) {
      if (typeof document !== 'undefined') document.removeEventListener('click', outside);
      return;
    }
    if (event && event.target && typeof details.contains === 'function' && !details.contains(event.target)) details.open = false;
  };
  details.addEventListener('toggle', () => {
    if (typeof document === 'undefined') return;
    if (details.open) document.addEventListener('click', outside);
    else document.removeEventListener('click', outside);
  });
  details.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !details.open) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    details.open = false;
    if (typeof summary.focus === 'function') summary.focus();
  });
  return details;
}

/** The documents the chooser offers: the workspace's current documents, or a file-name search when the tag routes are off. */
async function scopeTagsChooserDocuments(context, query) {
  const ui = scopeTagsUiLib();
  const params = (extra) => {
    const p = new URLSearchParams();
    if (context.organizationId) p.set('organizationId', context.organizationId);
    for (const [key, value] of Object.entries(extra)) if (value) p.set(key, String(value));
    return '?' + p.toString();
  };
  const result = await ui.ragUiRagRequest(SCOPE_TAGS_DOCS_PATH + params({ filter: 'all', q: query, limit: SCOPE_TAGS_PAGE }), { method: 'GET' });
  if (result && result.ok && result.body && typeof result.body === 'object') {
    return { ok: true, rows: scopeTagsDocumentsView(result.body, null, context.locale).rows };
  }
  if (!(result && result.status === 404)) return { ok: false };
  if (!query) return { ok: true, rows: [], needsQuery: true };
  const dates = await ui.ragUiRagRequest(SCOPE_TAGS_DATES_PATH + params({ query, limit: SCOPE_TAGS_PAGE }), { method: 'GET' });
  if (!(dates && dates.ok && dates.body && Array.isArray(dates.body.items))) return { ok: false };
  const rows = dates.body.items
    .filter((item) => item && typeof item === 'object' && scopeTagsText(item.id) && (item.status === undefined || item.status === 'ready'))
    .map((item) => ({ id: scopeTagsText(item.id), file: scopeTagsText(item.file_name), docType: '', docTypeLabel: '', uploadedAt: '' }));
  return { ok: true, rows };
}

function scopeTagsFormatDate(value, locale) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** The "Replaces…" chooser (UI-SPEC 6.11): a native dialog with a search field and a radiogroup of documents. */
function scopeTagsOpenChooser(item, options, context, opener, onChosen) {
  const ui = scopeTagsUiLib();
  const doc = ui.ragUiDoc ? ui.ragUiDoc(null) : document;
  const locale = context.locale;
  const t = (key, vars) => scopeTagsLabel(key, locale, vars);
  const titleId = ui.ragUiNextId('rag-scope-tags-chooser-title');
  const descId = ui.ragUiNextId('rag-scope-tags-chooser-desc');
  const searchId = ui.ragUiNextId('rag-scope-tags-chooser-search');
  const search = scopeTagsQueueEl('input', {
    className: 'input input-bordered input-sm w-full',
    id: searchId,
    attrs: { type: 'search', name: 'replaces-document-search', autocomplete: 'off', spellcheck: 'false', maxlength: '200' },
  });
  const list = scopeTagsQueueEl('ul', { className: 'flex flex-col gap-1', attrs: { role: 'radiogroup', 'aria-labelledby': titleId } });
  const note = scopeTagsQueueEl('p', { className: 'text-sm text-base-content/70 py-2 break-words', attrs: { role: 'status', 'aria-live': 'polite' } });
  const close = scopeTagsQueueEl('button', { className: 'btn btn-sm', text: t('action.closeChooser'), attrs: { type: 'button' } });
  const choose = scopeTagsQueueEl('button', { className: 'btn btn-primary btn-sm', text: t('action.chooseDocument'), attrs: { type: 'button' } });
  choose.disabled = true;
  const dialog = scopeTagsQueueEl('dialog', { className: 'modal', attrs: { 'aria-labelledby': titleId, 'aria-describedby': descId } }, [
    scopeTagsQueueEl('div', { className: 'modal-box min-w-0 overscroll-contain' }, [
      scopeTagsQueueEl('h3', { className: 'text-base font-semibold mb-2 break-words text-balance', id: titleId, text: t('replaces.title', { file: scopeTagsText(item.name) }) }),
      scopeTagsQueueEl('p', { className: 'text-sm max-w-prose mb-4', id: descId, text: t(options.replaces.confirmedAtOnce ? 'replaces.admin' : 'replaces.member') }),
      scopeTagsQueueEl('div', { className: 'form-control' }, [
        scopeTagsQueueEl('label', { className: 'label', attrs: { for: searchId } }, [scopeTagsQueueEl('span', { className: 'label-text', text: t('replaces.search') })]),
        search,
      ]),
      scopeTagsQueueEl('div', { className: 'mt-4 max-h-72 overflow-y-auto overscroll-contain' }, [list, note]),
      scopeTagsQueueEl('div', { className: 'modal-action flex-wrap gap-2' }, [close, choose]),
    ]),
    scopeTagsQueueEl('form', { className: 'modal-backdrop', attrs: { method: 'dialog' } }, [
      scopeTagsQueueEl('button', { className: 'cursor-default', text: t('action.closeChooser'), attrs: { type: 'submit', tabindex: '-1' } }),
    ]),
  ]);
  let rows = [];
  let picked = null;
  let seq = 0;
  let timer = null;
  const radios = [];
  const pick = (index, focus) => {
    picked = rows[index] || null;
    radios.forEach((radio, i) => {
      radio.setAttribute('aria-checked', i === index ? 'true' : 'false');
      radio.setAttribute('tabindex', i === index ? '0' : '-1');
      radio.classList.toggle('bg-base-300', i === index);
    });
    choose.disabled = !picked;
    if (focus && radios[index] && typeof radios[index].focus === 'function') radios[index].focus();
  };
  const render = (answer, query) => {
    radios.length = 0;
    rows = answer.ok ? answer.rows : [];
    picked = null;
    choose.disabled = true;
    const current = item.replaces && typeof item.replaces === 'object' ? scopeTagsText(item.replaces.id) : '';
    list.replaceChildren(
      ...rows.map((row, index) => {
        const radio = scopeTagsQueueEl(
          'li',
          {
            className: 'rounded p-2 cursor-pointer hover:bg-base-200 min-w-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
            attrs: { role: 'radio', 'aria-checked': 'false', tabindex: index === 0 ? '0' : '-1' },
          },
          [
            scopeTagsQueueEl('span', { className: 'block text-sm break-words [overflow-wrap:anywhere]', text: row.file }),
            scopeTagsQueueEl('span', { className: 'flex flex-wrap gap-2 text-xs text-base-content/70' }, [
              row.docTypeLabel ? scopeTagsQueueEl('span', { text: row.docTypeLabel }) : null,
              row.uploadedAt ? scopeTagsQueueEl('time', { text: scopeTagsFormatDate(row.uploadedAt, locale), attrs: { datetime: row.uploadedAt } }) : null,
            ]),
          ],
        );
        radio.addEventListener('click', () => pick(index, false));
        radio.addEventListener('keydown', (event) => {
          let target = null;
          if (event.key === 'ArrowDown') target = Math.min(rows.length - 1, index + 1);
          else if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
          else if (event.key === ' ' || event.key === 'Enter') target = index;
          if (target === null) return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          pick(target, true);
        });
        radios.push(radio);
        return radio;
      }),
    );
    const at = rows.findIndex((row) => row.id === current);
    if (at >= 0) pick(at, false);
    if (!answer.ok) note.textContent = t('replaces.unavailable');
    else if (answer.needsQuery) note.textContent = t('replaces.searchFirst');
    else if (!rows.length) note.textContent = query ? t('replaces.noMatch', { query }) : t('replaces.empty');
    else note.textContent = '';
  };
  const load = async () => {
    const mine = ++seq;
    const query = scopeTagsText(search.value).trim();
    note.textContent = t('replaces.loading');
    let answer;
    try {
      answer = await scopeTagsChooserDocuments(context, query);
    } catch {
      answer = { ok: false };
    }
    if (mine === seq) render(answer, query);
  };
  search.addEventListener('input', (event) => {
    scopeTagsStop(event);
    if (timer) clearTimeout(timer);
    timer = setTimeout(load, SCOPE_TAGS_SEARCH_DELAY_MS);
  });
  search.addEventListener('change', scopeTagsStop);
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (timer) clearTimeout(timer);
    load();
  });
  let chosen = false;
  dialog.addEventListener('close', () => {
    if (timer) clearTimeout(timer);
    dialog.remove();
    if (chosen) onChosen();
    else if (opener && opener.isConnected !== false && typeof opener.focus === 'function') opener.focus();
  });
  close.addEventListener('click', () => dialog.close('keep'));
  choose.addEventListener('click', () => {
    if (!picked) return;
    item.replaces = { id: picked.id, name: picked.file };
    chosen = true;
    dialog.close('choose');
  });
  doc.body.appendChild(dialog);
  dialog.showModal();
  if (typeof search.focus === 'function') search.focus();
  load();
  return dialog;
}

function scopeTagsRenderQueueHost(host, item, options, context) {
  const ui = scopeTagsUiLib();
  const locale = context.locale;
  const t = (key, vars) => scopeTagsLabel(key, locale, vars);
  const file = scopeTagsText(item.name);
  const nodes = [];
  if (options.tags.enabled) nodes.push(scopeTagsQueueTagControl(item, options, locale));
  if (options.replaces.enabled) {
    const open = scopeTagsQueueEl('button', { className: 'btn btn-outline btn-sm gap-1 font-normal', attrs: { type: 'button', 'data-scope-tags-replaces': '' } }, [
      ui.ragUiIcon(null, 'arrow-left-right'),
      scopeTagsQueueEl('span', { text: t('queue.replaces') }),
      scopeTagsQueueEl('span', { className: 'sr-only', text: ' ' + t('queue.tagsFor', { file }) }),
    ]);
    const rerender = () => {
      scopeTagsRenderQueueHost(host, item, options, context);
      const next = host.querySelector('[data-scope-tags-replaces]');
      if (next && typeof next.focus === 'function') next.focus();
    };
    open.addEventListener('click', () => scopeTagsOpenChooser(item, options, context, open, rerender));
    nodes.push(open);
    const chosen = item.replaces && typeof item.replaces === 'object' && scopeTagsText(item.replaces.id) ? item.replaces : null;
    if (chosen) {
      const name = scopeTagsText(chosen.name) || scopeTagsText(chosen.id);
      const clear = scopeTagsQueueEl('button', {
        className: 'btn btn-ghost btn-sm',
        text: t('action.clearReplacement'),
        attrs: { type: 'button', 'aria-label': t('action.clearReplacementAria', { name }) },
      });
      clear.addEventListener('click', () => {
        item.replaces = null;
        rerender();
      });
      nodes.push(
        scopeTagsQueueEl('div', { className: 'flex flex-wrap items-center gap-2 w-full min-w-0' }, [
          scopeTagsQueueEl('p', { className: 'text-xs break-words [overflow-wrap:anywhere] min-w-0', text: t('queue.replacesLine', { name }) }),
          clear,
        ]),
      );
    } else {
      item.replaces = null;
    }
  }
  host.replaceChildren(...nodes);
}

/**
 * Fills each `[data-queue-extras]` host of the rendered queue (ScopeTagsQueueControls). The host exists only when the picker-defaults
 * answer enables a control; with both off nothing is built and the queue item is today's markup.
 */
function scopeTagsMountQueueControls(container, queue, picker, context) {
  if (!container || typeof container.querySelectorAll !== 'function') return;
  const options = scopeTagsUploadOptions(picker);
  if (!options.tags.enabled && !options.replaces.enabled) return;
  const ctx = { organizationId: context && context.organizationId ? String(context.organizationId) : null, locale: scopeTagsUiLib().ragUiBrowserLocale() };
  for (const host of container.querySelectorAll('[data-queue-extras]')) {
    const id = host.getAttribute('data-queue-extras');
    const item = (Array.isArray(queue) ? queue : []).find((q) => q && String(q.id) === String(id));
    if (item) scopeTagsRenderQueueHost(host, item, options, ctx);
  }
}

const ScopeTagsQueueControls = { mount: scopeTagsMountQueueControls, appendUploadFields: scopeTagsAppendUploadFields, hostWanted: scopeTagsQueueHostWanted };

let scopeTagsPanelInstance = null;

function initScopeTagsPanel() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rag-administration-scopes');
  if (!root) return null;
  if (!scopeTagsPanelInstance) {
    scopeTagsPanelInstance = new ScopeTagsPanel(root);
    if (typeof window !== 'undefined') window.scopeTagsPanel = scopeTagsPanelInstance;
    return scopeTagsPanelInstance.mount();
  }
  return scopeTagsPanelInstance.refresh();
}

function scopeTagsBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-scope-tags-bound')) return;
    link.setAttribute('data-scope-tags-bound', '1');
    link.addEventListener('click', () => initScopeTagsPanel());
  });
}

if (typeof window !== 'undefined') {
  window.SCOPE_TAGS_LABELS = SCOPE_TAGS_LABELS;
  window.ScopeTagsQueueControls = ScopeTagsQueueControls;
  window.scopeTagsMountQueueControls = scopeTagsMountQueueControls;
  window.scopeTagsAppendUploadFields = scopeTagsAppendUploadFields;
  window.scopeTagsUploadErrorText = scopeTagsUploadErrorText;
  window.scopeTagsQueueHostWanted = scopeTagsQueueHostWanted;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initScopeTagsPanel = initScopeTagsPanel;
  scopeTagsBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    scopeTagsBindPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initScopeTagsPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCOPE_TAGS_LABELS,
    scopeTagsLabel,
    scopeTagsSlugFromLabel,
    scopeTagsValueValid,
    scopeTagsAliases,
    scopeTagsVocabularyView,
    scopeTagsDocumentsView,
    scopeTagsSettingsWarnings,
    scopeTagsUploadOptions,
    scopeTagsQueueHostWanted,
    scopeTagsAppendUploadFields,
    scopeTagsUploadErrorText,
    scopeTagsMountQueueControls,
    ScopeTagsQueueControls,
    ScopeTagsPanel,
    initScopeTagsPanel,
  };
}
