/**
 * Access groups panel (UI-SPEC 6.1, 6.6; D-03, D-07, D-09, D-28, A-03, A-08). This plan builds the panel shell, the labels of
 * every Config UI string of the phase and the Enforcement sub-view; later plans add Groups, Documents and Connector mapping
 * as further sub-views. Every server string is set as text through the rag-ui.js element builder.
 */

const ACCESS_GROUPS_LABELS = {
  en: {
    'settings.title': "Settings",
    'enforce.title': "Enforcement",
    'enforce.checking': "Checking enforcement…",
    'enforce.checked': "Enforcement checked: {state}.",
    'enforce.unavailable': "The enforcement status is unavailable right now. Select Reload panel in a moment.",
    'enforce.reasons': "What blocks access groups",
    'enforce.dlLabel': "Enforcement values",
    'value.none': "Not known",
    'blocked.reason.flag_readback_mismatch': "The database setting was written, but reading it back gave a different value.",
    'blocked.reason.backend_without_access_filter': "The vector backend in use cannot filter by access group.",
    'drift.caption': "Rows that differ from their document, per store",
    'term.everyone': "Everyone",
    'audience.label': "Visible to",
    'audience.everyone': "Visible to: Everyone",
    'audience.groups': "Visible to: {groups}",
    'audience.people': "people at the source: {count}",
    'audience.uploaderOnly': "Uploader and admins only",
    'badge.restricted': "Restricted",
    'badge.restrictedHint': "Only some members can see this document.",
    'reason.group_deleted': "Its access group was deleted.",
    'reason.unmapped_source': "Its sharing at the source is not mapped to an access group.",
    'reason.source_error': "Its sharing at the source could not be read at the last sync.",
    'reason.other': "Restricted by the system with the code {code}.",
    'field.everyoneHelp.org': "Every member of this workspace.",
    'field.everyoneHelp.single': "Every user of this deployment, including embedded chat and WhatsApp.",
    'field.onlyGroups': "Only these groups",
    'field.onlyGroupsHelp': "Members of any chosen group, and admins.",
    'action.addGroup': "Add group",
    'action.removeGroupChip': "Remove group: {group}",
    'chip.added': "{group} added",
    'chip.removed': "{group} removed",
    'field.needGroup': "Add at least one group, or choose Everyone.",
    'field.noGroups': "No access groups yet. Create one first.",
    'field.widen': "Everyone will be able to get answers from this document.",
    'field.widenMany': "Everyone will be able to get answers from the selected documents.",
    'field.mixed': "The selected documents have different access now. Your choice replaces it for all of them.",
    'field.effect': "Applies from the next question. Nothing is rebuilt.",
    'action.editAccess': "Edit access",
    'action.editAccessAria': "Edit access: {file}",
    'action.changeAccess': "Change access",
    'action.saveAccess': "Save access",
    'action.keepAccess': "Keep current access",
    'action.cancelEditing': "Cancel editing",
    'save.running': "Saving…",
    'save.done': "Access saved for {file}. {audience}",
    'save.doneMany': "Access saved. Documents changed: {count}.",
    'save.skipped': "Not changed, because their access follows a connector: {count}.",
    'edit.title': "Who can see {file}?",
    'bulk.title': "Who can see the selected documents?",
    'bulk.selected': "Selected: {count}",
    'action.clearSelection': "Clear selection",
    'select.aria': "Select {file}",
    'select.allAria': "Select all documents shown",
    'docs.connectorManaged': "Access follows the sharing at the source. Change it there, or change the connector mapping.",
    'error.groupGone': "Not saved. One of the chosen groups no longer exists. The groups have been reloaded.",
    'picker.trigger': "Access",
    'picker.everyone': "Everyone",
    'picker.groups': "Groups: {n}",
    'picker.aria': "Choose who can see {file}",
    'picker.note': "If you choose nothing, a new document is visible to everyone and a new version keeps the access of the document it replaces.",
    'picker.clear': "Clear choice",
    'error.groupNotAllowed': "Not uploaded. Choose Everyone or one of your own groups.",
    'groups.title': "Access groups",
    'action.newGroup': "New group",
    'form.name': "Name",
    'form.key': "Key",
    'form.keyHelp': "Lower-case letters, digits and hyphens. The key cannot be changed later; the name can.",
    'form.needName': "Enter a name.",
    'form.badKey': "Use lower-case letters, digits and hyphens, starting with a letter or a digit.",
    'form.reservedKey': "The key \"all\" is reserved. Enter another key.",
    'action.createGroup': "Create group",
    'action.closeForm': "Close form",
    'create.running': "Creating…",
    'create.done': "Group {group} created. Add members, then restrict documents to it.",
    'error.groupExists': "A group with this key already exists. Change the key.",
    'col.group': "Group",
    'col.members': "Members",
    'col.documents': "Documents",
    'col.actions': "Actions",
    'group.members': "Members: {count}",
    'group.documents': "Documents: {count}",
    'group.sourceConnector': "From a connector",
    'action.manageMembers': "Manage members",
    'action.manageMembersAria': "Manage members: {group}",
    'action.closeMembers': "Close members",
    'action.renameGroup': "Rename group",
    'action.renameGroupAria': "Rename group: {group}",
    'action.saveName': "Save name",
    'rename.done': "Group renamed to {group}. Its documents and members are unchanged.",
    'action.deleteGroup': "Delete group",
    'action.deleteGroupAria': "Delete group: {group}",
    'action.keepGroup': "Keep group",
    'delete.title': "Delete {group}?",
    'delete.counting': "Counting affected documents…",
    'delete.docsClosed': "Documents restricted to this group alone: {count}",
    'delete.docsOther': "Documents that stay visible to their other groups: {count}",
    'delete.members': "Members who lose access through this group: {count}",
    'delete.mappings': "Connector mappings removed with it: {count}",
    'delete.body': "Documents restricted to this group alone become visible to their uploader and admins only, never to everyone. This can't be undone.",
    'delete.countUnavailable': "The affected documents could not be counted, so the group cannot be deleted now. Select Count again.",
    'action.countAgain': "Count again",
    'delete.running': "Deleting…",
    'delete.done': "Group {group} deleted. Documents now visible to their uploader and admins only: {count}.",
    'groups.empty.title': "No access groups yet",
    'groups.empty.body': "Every document is visible to everyone in this workspace. Create a group, add members, then restrict documents to it. Select New group.",
    'groups.adminNote': "Owners and admins see every document and do not need to be in a group.",
    'groups.loading': "Loading access groups…",
    'groups.loaded': "Access groups loaded: {count}.",
    'groups.unavailable': "Access groups are unavailable right now. Select {reload} in a moment.",
    'action.refreshGroups': "Refresh groups",
    'action.loadMoreGroups': "Load more groups",
    'members.title': "Members of {group}",
    'members.search': "Search members by name or e-mail",
    'members.searchHint': "Type at least 2 characters.",
    'members.noMatch': "No member of this workspace matches \"{query}\".",
    'members.already': "In this group",
    'members.col.name': "Name",
    'members.col.added': "Added",
    'action.addMember': "Add member",
    'action.addMemberAria': "Add member: {name}",
    'member.added': "{name} added to {group}. They can see its documents from their next question.",
    'action.removeMember': "Remove member",
    'action.removeMemberAria': "Remove member: {name}",
    'member.removed': "{name} removed from {group}. They lose access through this group from their next question.",
    'members.empty': "No members yet. Until someone is added, only admins see documents restricted to this group.",
    'error.memberExists': "This person is already in the group. The list has been reloaded.",
    'error.notWorkspaceMember': "This person is no longer a member of the workspace. The list has been reloaded.",
    'mapping.title': "Connector mapping",
    'mapping.description': "Match groups and teams at the source to access groups. At every sync, a document shared with a mapped group becomes visible to that access group. Sharing that is not mapped leaves the document visible to its uploader and admins only.",
    'mapping.personalNote': "In this deployment, connector documents stay in the personal workspace of the person who connected the source. Mappings are saved, but they do not change who can see those documents.",
    'mapping.groups.title': "Groups and teams at the source",
    'mapping.col.source': "Source",
    'mapping.col.principal': "Group or team at the source",
    'mapping.col.accessGroup': "Access group",
    'mapping.notMapped': "Not mapped",
    'mapping.kind.group': "Group",
    'mapping.kind.team': "Team",
    'mapping.kind.workspace': "Whole workspace",
    'action.saveMapping': "Save mapping",
    'action.saveMappingAria': "Save mapping: {principal}",
    'mapping.saved': "{principal} is mapped to {group}. Applies at the next sync.",
    'action.removeMapping': "Remove mapping",
    'action.removeMappingAria': "Remove mapping: {principal}",
    'mapping.removed': "Mapping removed: {principal}. From the next sync its documents are visible to their uploader and admins only.",
    'action.newMapping': "New mapping",
    'mapping.form.principal': "Group or team ID at the source",
    'mapping.form.principalHelp': "Enter it exactly as the source shows it. For Google Drive this is the group's address.",
    'action.createMapping': "Create mapping",
    'error.mappingExists': "This group or team is already mapped. Change its access group in the table.",
    'mapping.empty.title': "No source groups seen yet",
    'mapping.empty.body': "After a connector sync, the groups and teams its documents are shared with appear here. Select New mapping to add one in advance.",
    'mapping.loading': "Loading connector mapping…",
    'mapping.unavailable': "Connector mapping is unavailable right now. Select {reload} in a moment.",
    'action.refreshMapping': "Refresh mapping",
    'rules.title': "Sharing with a whole domain or by link",
    'rules.description': "Off unless you turn a rule on: such documents stay visible to their uploader and admins only. A rule that is on counts that sharing as Everyone.",
    'rules.col.sharedWith': "Shared with",
    'rules.col.counts': "Counts as Everyone",
    'rules.kind.domain': "Everyone at {domain}",
    'rules.kind.anyone': "Anyone with the link",
    'rules.kind.public': "Published to the web",
    'rules.toggleAria': "Count as Everyone: {rule}, {source}",
    'value.on': "On",
    'value.off': "Off",
    'rules.confirm.title': "Count this sharing as Everyone?",
    'rules.confirm.body': "{source}, {rule}. Documents: {count}. From the next sync they are visible to everyone who can use this workspace. You can turn the rule off again.",
    'action.keepRuleOff': "Keep rule off",
    'action.turnRuleOn': "Turn rule on",
    'rules.turnedOn': "Rule on: {rule}, {source}. Applies at the next sync.",
    'rules.turnedOff': "Rule off: {rule}, {source}. From the next sync those documents are visible to their uploader and admins only.",
    'action.addDomain': "Add domain rule",
    'rules.form.domain': "Domain",
    'rules.badDomain': "Enter a domain such as example.org, without a scheme, path or port.",
    'action.createRule': "Create rule",
    'rules.empty': "No sharing with a whole domain or by link seen yet. Rules appear after the next connector sync.",
    'mapping.caption': "Source groups and their access groups",
    'mapping.loaded': "Source groups shown: {count}.",
    'mapping.need': "To create the mapping, fill in: {fields}.",
    'mapping.form.choose': "Choose…",
    'mapping.selectAria': "Access group: {principal}",
    'action.loadMoreMapping': "Load more source groups",
    'rules.caption': "Sharing with a whole domain or by link, per source",
    'rules.need': "To create the rule, fill in: {fields}.",
    'rules.created': "Rule created and off: {rule}, {source}. Turn it on to count this sharing as Everyone from the next sync.",
    'action.loadMoreRules': "Load more rules",
    'error.ruleExists': "This rule already exists. Find it in the table.",
    'panel.title': "Access groups",
    'panel.description': "Limit documents to groups of members. A restricted document is found, quoted and cited only for members of its groups and for admins. Groups, Documents and Connector mapping follow the workspace chosen under Document Processing.",
    'panel.tabsLabel': "Access group views",
    'tab.groups': "Groups: {count}",
    'tab.documents': "Documents",
    'tab.mapping': "Connector mapping",
    'tab.mappingUnmapped': "Connector mapping, not mapped: {count}",
    'tab.enforcement': "Enforcement",
    'alert.off': "Access groups are off. Groups, members and document access set here are saved but not applied: every member still sees every document.",
    'alert.blocked': "Access groups are on, but the app cannot apply them. The knowledge base is unavailable to users until this is fixed.",
    'alert.unmapped': "Source groups not mapped: {count}. Their documents are visible to their uploader and admins only.",
    'action.openEnforcement': "Open enforcement",
    'action.openMapping': "Open connector mapping",
    'groups.personal': "A personal workspace has one user, so it has no access groups. Choose a team workspace under Document Processing, Upload Destination.",
    'tab.groupsPlain': "Groups",
    'panel.workspaceDefault': "Default workspace",
    'groups.caption': "Access groups of this workspace",
    'rename.running': "Saving…",
    'members.adding': "Adding…",
    'members.removing': "Removing…",
    'members.searching': "Searching members…",
    'members.loading': "Loading members…",
    'members.unavailable': "Members are unavailable right now. Select Reload panel in a moment.",
    'members.results': "Search results",
    'delete.countsLabel': "Affected documents and members",
    'filter.restricted': "Restricted",
    'filter.uploaderOnly': "Uploader and admins only",
    'filter.everyone': "Everyone",
    'filter.all': "All",
    'docs.search': "Search by file name",
    'col.file': "File",
    'col.docType': "Document type",
    'col.source': "Source",
    'docs.empty.restricted.title': "No restricted documents",
    'docs.empty.restricted.body': "Every document in this workspace is visible to everyone. Choose All, then Edit access, to restrict one.",
    'docs.empty.filter': "No document matches this filter. Choose All or clear the search.",
    'docs.loading': "Loading documents…",
    'docs.unavailable': "The document list is unavailable right now. Select Reload panel in a moment.",
    'action.refreshDocuments': "Refresh documents",
    'action.loadMoreDocuments': "Load more documents",
    'docs.manageHint': "To change who can see a document, open RAG administration, Access groups, Documents.",
    'docs.filterLabel': "Show documents",
    'docs.caption': "Documents and who can see them",
    'docs.loaded': "Documents shown: {count}.",
    'field.choose': "Choose Everyone or Only these groups.",
    'field.current': "Now",
    'enforce.scope': "Applies to every workspace in this deployment.",
    'enforce.state.off': "Off",
    'enforce.state.enforced': "Enforced",
    'enforce.state.restart': "Restart needed",
    'enforce.state.unsynced': "Not in sync",
    'enforce.state.blocked': "Blocked",
    'enforce.state.unknown': "Not checked",
    'enforce.sentence.off': "Access groups are off. Every member sees every document of their workspace.",
    'enforce.sentence.enforced': "Access groups are applied in search, answers, citations, the answer cache, logs and direct database reads.",
    'enforce.sentence.restart': "The saved setting is {saved}, but the running app still uses {running}. Restart the app to apply the saved setting.",
    'enforce.sentence.unsynced': "The app and the database disagree: the app is {running}, the database is {database}. Select Sync enforcement.",
    'enforce.sentence.blocked': "Access groups are on, but a part of the system cannot apply them. The knowledge base is unavailable to users until every item below is fixed.",
    'enforce.sentence.unknown': "The status could not be read. Sign in to the main app as an admin, then select Check again.",
    'enforce.dl.saved': "Saved setting",
    'enforce.dl.running': "Running app",
    'enforce.dl.database': "Database",
    'enforce.dl.checked': "Checked",
    'value.enforced': "Enforced",
    'value.notEnforced': "Not enforced",
    'action.sync': "Sync enforcement",
    'sync.running': "Syncing…",
    'sync.done': "The database now matches the app: {database}.",
    'sync.failed': "The database setting could not be written. While access groups are on, the knowledge base stays unavailable to users. Check the database connection and the service-role key, then select Sync enforcement.",
    'action.check': "Check again",
    'blocked.reason.function_missing_filter': "A search function has no access filter: {name}. Apply the database migrations 0920 to 0939.",
    'blocked.reason.column_missing': "A table has no access column: {name}. Apply the database migrations 0920 to 0939.",
    'blocked.reason.backend_unfiltered': "The vector backend {name} cannot filter by access group.",
    'blocked.reason.flag_write_failed': "The database setting could not be written at startup.",
    'blocked.reason.other': "Reported with the code {code}. Check the app log for [RAG Access].",
    'RAG_DOC_ACCESS_GROUPS.label': "Access groups",
    'RAG_DOC_ACCESS_GROUPS.opt.off': "Off, as today",
    'RAG_DOC_ACCESS_GROUPS.opt.on': "On",
    'RAG_DOC_ACCESS_GROUPS.now.off': "Every member sees every document. Groups and document access are saved but not applied.",
    'RAG_DOC_ACCESS_GROUPS.now.on': "A restricted document is visible only to members of its groups and to admins. Documents that are not restricted stay visible to everyone. Takes effect after an app restart.",
    'RAG_EMBED_ACCESS_GROUP.label': "Embedded chat group",
    'RAG_EMBED_ACCESS_GROUP.help': "The key of one access group in the embedded chat's workspace. Embedded chat and WhatsApp then also answer from documents restricted to that group. Empty: they answer only from documents visible to everyone.",
    'RAG_EMBED_ACCESS_GROUP.found': "Group found: {group}.",
    'RAG_EMBED_ACCESS_GROUP.notFound': "No group with this key exists in the embedded chat's workspace. Until it does, embedded chat answers only from documents visible to everyone.",
    'warn.embedNeedsSwitch': "The embedded chat group has no effect while access groups are off.",
    'settings.restart': "Saved. Restart the app to apply.",
    'drift.title': "Label check",
    'drift.body': "Every chunk, parent passage, translation and table row carries a copy of its document's access. This check finds copies that differ from their document. A differing row is left out of answers until it matches.",
    'action.runDrift': "Run label check",
    'drift.running': "Checking…",
    'drift.none': "No differences found. Checked {time}.",
    'drift.found': "Rows that differ from their document: {count}. They are left out of answers. Check the app log for [RAG Access] drift.",
    'drift.col.store': "Store",
    'drift.col.rows': "Rows that differ",
    'drift.store.chunks': "Chunks",
    'drift.store.parents': "Parent passages",
    'drift.store.translations': "Translations",
    'drift.store.table_rows': "Table rows",
    'drift.store.clusters': "Duplicate groups",
    'drift.unavailable': "The label check could not run. Select Run label check in a moment.",
    'connector.failClosed': "Documents visible to their uploader and admins only: {count}. Their sharing at the source is not mapped to an access group.",
    'connector.failClosedOff': "Documents whose sharing at the source is not mapped to an access group: {count}. When access groups are turned on, they will be visible to their uploader and admins only.",
  },
  zh: {
    'settings.title': "设置",
    'enforce.title': "生效状态",
    'enforce.checking': "正在检查生效状态…",
    'enforce.checked': "已检查生效状态：{state}。",
    'enforce.unavailable': "暂时无法获取生效状态。请稍后选择“重新加载面板”。",
    'enforce.reasons': "阻止访问组生效的原因",
    'enforce.dlLabel': "生效状态的取值",
    'value.none': "未知",
    'blocked.reason.flag_readback_mismatch': "数据库设置已写入，但读回的值不一致。",
    'blocked.reason.backend_without_access_filter': "当前使用的向量后端无法按访问组过滤。",
    'drift.caption': "各存储中与其文档不一致的行",
    'term.everyone': "所有人",
    'audience.label': "可见范围",
    'audience.everyone': "可见范围：所有人",
    'audience.groups': "可见范围：{groups}",
    'audience.people': "来源处共享的人数：{count}",
    'audience.uploaderOnly': "仅上传者和管理员",
    'badge.restricted': "受限",
    'badge.restrictedHint': "只有部分成员可以看到此文档。",
    'reason.group_deleted': "它所属的访问组已被删除。",
    'reason.unmapped_source': "它在来源处的共享对象尚未映射到访问组。",
    'reason.source_error': "上次同步时无法读取它在来源处的共享设置。",
    'reason.other': "系统以代码 {code} 限制了它。",
    'field.everyoneHelp.org': "此工作区的每位成员。",
    'field.everyoneHelp.single': "此部署的所有用户，包括嵌入式聊天和 WhatsApp。",
    'field.onlyGroups': "仅这些访问组",
    'field.onlyGroupsHelp': "所选任一访问组的成员，以及管理员。",
    'action.addGroup': "添加访问组",
    'action.removeGroupChip': "移除访问组：{group}",
    'chip.added': "已添加 {group}",
    'chip.removed': "已移除 {group}",
    'field.needGroup': "请至少添加一个访问组，或选择“所有人”。",
    'field.noGroups': "还没有访问组。请先创建。",
    'field.widen': "所有人都将能够从此文档获得回答。",
    'field.widenMany': "所有人都将能够从所选文档获得回答。",
    'field.mixed': "所选文档当前的可见范围各不相同。你的选择将替换它们全部的设置。",
    'field.effect': "从下一个问题起生效，无需重建。",
    'action.editAccess': "编辑可见范围",
    'action.editAccessAria': "编辑可见范围：{file}",
    'action.changeAccess': "更改可见范围",
    'action.saveAccess': "保存可见范围",
    'action.keepAccess': "保留当前可见范围",
    'action.cancelEditing': "取消编辑",
    'save.running': "正在保存…",
    'save.done': "已保存 {file} 的可见范围。{audience}",
    'save.doneMany': "已保存可见范围。已更改的文档：{count}。",
    'save.skipped': "未更改（其可见范围跟随连接器）：{count}。",
    'edit.title': "谁可以看到 {file}？",
    'bulk.title': "谁可以看到所选文档？",
    'bulk.selected': "已选择：{count}",
    'action.clearSelection': "清除选择",
    'select.aria': "选择 {file}",
    'select.allAria': "选择当前显示的全部文档",
    'docs.connectorManaged': "可见范围跟随来源处的共享设置。请在来源处修改，或修改连接器映射。",
    'error.groupGone': "未保存。所选的某个访问组已不存在。访问组已重新加载。",
    'picker.trigger': "可见范围",
    'picker.everyone': "所有人",
    'picker.groups': "访问组：{n}",
    'picker.aria': "选择谁可以看到 {file}",
    'picker.note': "如果不作选择，新文档对所有人可见，新版本则沿用被替换文档的可见范围。",
    'picker.clear': "清除设置",
    'error.groupNotAllowed': "未上传。请选择“所有人”或你所属的某个访问组。",
    'groups.title': "访问组",
    'action.newGroup': "新建访问组",
    'form.name': "名称",
    'form.key': "标识",
    'form.keyHelp': "小写字母、数字和连字符。标识创建后不可更改；名称可以更改。",
    'form.needName': "请输入名称。",
    'form.badKey': "请使用小写字母、数字和连字符，并以字母或数字开头。",
    'form.reservedKey': "标识“all”为保留字。请输入其他标识。",
    'action.createGroup': "创建访问组",
    'action.closeForm': "关闭表单",
    'create.running': "正在创建…",
    'create.done': "已创建访问组 {group}。请添加成员，然后把文档限定给它。",
    'error.groupExists': "已存在使用此标识的访问组。请更改标识。",
    'col.group': "访问组",
    'col.members': "成员",
    'col.documents': "文档",
    'col.actions': "操作",
    'group.members': "成员：{count}",
    'group.documents': "文档：{count}",
    'group.sourceConnector': "来自连接器",
    'action.manageMembers': "管理成员",
    'action.manageMembersAria': "管理成员：{group}",
    'action.closeMembers': "收起成员",
    'action.renameGroup': "重命名访问组",
    'action.renameGroupAria': "重命名访问组：{group}",
    'action.saveName': "保存名称",
    'rename.done': "访问组已重命名为 {group}。其文档和成员不变。",
    'action.deleteGroup': "删除访问组",
    'action.deleteGroupAria': "删除访问组：{group}",
    'action.keepGroup': "保留访问组",
    'delete.title': "要删除 {group} 吗？",
    'delete.counting': "正在统计受影响的文档…",
    'delete.docsClosed': "仅限此访问组的文档：{count}",
    'delete.docsOther': "仍对其他访问组可见的文档：{count}",
    'delete.members': "将失去通过此访问组获得的访问权限的成员：{count}",
    'delete.mappings': "随之移除的连接器映射：{count}",
    'delete.body': "仅限此访问组的文档将只对其上传者和管理员可见，绝不会对所有人开放。此操作无法撤销。",
    'delete.countUnavailable': "无法统计受影响的文档，因此现在不能删除此访问组。请选择“重新统计”。",
    'action.countAgain': "重新统计",
    'delete.running': "正在删除…",
    'delete.done': "已删除访问组 {group}。现在仅对上传者和管理员可见的文档：{count}。",
    'groups.empty.title': "还没有访问组",
    'groups.empty.body': "此工作区的每份文档都对所有人可见。创建访问组、添加成员，然后把文档限定给它。请选择“新建访问组”。",
    'groups.adminNote': "所有者和管理员可以看到所有文档，无需加入访问组。",
    'groups.loading': "正在加载访问组…",
    'groups.loaded': "已加载访问组：{count}。",
    'groups.unavailable': "暂时无法获取访问组。请稍后选择“{reload}”。",
    'action.refreshGroups': "刷新访问组",
    'action.loadMoreGroups': "加载更多访问组",
    'members.title': "{group} 的成员",
    'members.search': "按姓名或邮箱搜索成员",
    'members.searchHint': "请至少输入 2 个字符。",
    'members.noMatch': "此工作区没有与“{query}”匹配的成员。",
    'members.already': "已在此访问组",
    'members.col.name': "姓名",
    'members.col.added': "加入时间",
    'action.addMember': "添加成员",
    'action.addMemberAria': "添加成员：{name}",
    'member.added': "已将 {name} 加入 {group}。从其下一个问题起即可看到该组的文档。",
    'action.removeMember': "移除成员",
    'action.removeMemberAria': "移除成员：{name}",
    'member.removed': "已将 {name} 移出 {group}。从其下一个问题起，将失去通过此组获得的访问权限。",
    'members.empty': "还没有成员。在添加成员之前，只有管理员能看到限定给此访问组的文档。",
    'error.memberExists': "此人已在该访问组中。列表已重新加载。",
    'error.notWorkspaceMember': "此人已不再是该工作区的成员。列表已重新加载。",
    'mapping.title': "连接器映射",
    'mapping.description': "把来源处的群组和团队对应到访问组。每次同步时，共享给已映射群组的文档会对相应的访问组可见。未映射的共享会使文档仅对其上传者和管理员可见。",
    'mapping.personalNote': "在此部署中，连接器文档保存在连接该来源的用户的个人工作区内。映射会被保存，但不会改变谁能看到这些文档。",
    'mapping.groups.title': "来源处的群组和团队",
    'mapping.col.source': "来源",
    'mapping.col.principal': "来源处的群组或团队",
    'mapping.col.accessGroup': "访问组",
    'mapping.notMapped': "未映射",
    'mapping.kind.group': "群组",
    'mapping.kind.team': "团队",
    'mapping.kind.workspace': "整个工作区",
    'action.saveMapping': "保存映射",
    'action.saveMappingAria': "保存映射：{principal}",
    'mapping.saved': "{principal} 已映射到 {group}。下次同步时生效。",
    'action.removeMapping': "移除映射",
    'action.removeMappingAria': "移除映射：{principal}",
    'mapping.removed': "已移除映射：{principal}。下次同步起，其文档仅对上传者和管理员可见。",
    'action.newMapping': "新建映射",
    'mapping.form.principal': "来源处的群组或团队 ID",
    'mapping.form.principalHelp': "请按来源处显示的内容原样填写。对于 Google Drive，即群组的地址。",
    'action.createMapping': "创建映射",
    'error.mappingExists': "该群组或团队已有映射。请在表格中更改其访问组。",
    'mapping.empty.title': "尚未发现来源群组",
    'mapping.empty.body': "连接器同步后，其文档所共享的群组和团队会显示在这里。也可选择“新建映射”提前添加。",
    'mapping.loading': "正在加载连接器映射…",
    'mapping.unavailable': "暂时无法获取连接器映射。请稍后选择“{reload}”。",
    'action.refreshMapping': "刷新映射",
    'rules.title': "与整个域或通过链接共享",
    'rules.description': "除非开启规则，否则默认关闭：此类文档仅对其上传者和管理员可见。开启后，该共享方式将视为“所有人”。",
    'rules.col.sharedWith': "共享对象",
    'rules.col.counts': "视为“所有人”",
    'rules.kind.domain': "{domain} 的所有人",
    'rules.kind.anyone': "知道链接的任何人",
    'rules.kind.public': "已发布到网络",
    'rules.toggleAria': "视为“所有人”：{rule}，{source}",
    'value.on': "开启",
    'value.off': "关闭",
    'rules.confirm.title': "要将此共享方式视为“所有人”吗？",
    'rules.confirm.body': "{source}，{rule}。文档：{count}。下次同步起，可使用此工作区的所有人都能看到它们。此规则可随时关闭。",
    'action.keepRuleOff': "保持规则关闭",
    'action.turnRuleOn': "开启规则",
    'rules.turnedOn': "规则已开启：{rule}，{source}。下次同步时生效。",
    'rules.turnedOff': "规则已关闭：{rule}，{source}。下次同步起，这些文档仅对上传者和管理员可见。",
    'action.addDomain': "添加域规则",
    'rules.form.domain': "域名",
    'rules.badDomain': "请输入域名，例如 example.org，不要包含协议、路径或端口。",
    'action.createRule': "创建规则",
    'rules.empty': "尚未发现与整个域或通过链接的共享。下次连接器同步后会显示规则。",
    'mapping.caption': "来源群组及其访问组",
    'mapping.loaded': "已显示的来源群组：{count}。",
    'mapping.need': "要创建映射，请填写：{fields}。",
    'mapping.form.choose': "请选择…",
    'mapping.selectAria': "访问组：{principal}",
    'action.loadMoreMapping': "加载更多来源群组",
    'rules.caption': "按来源列出的与整个域或通过链接的共享",
    'rules.need': "要创建规则，请填写：{fields}。",
    'rules.created': "规则已创建，处于关闭状态：{rule}，{source}。开启后，下次同步起此共享方式视为“所有人”。",
    'action.loadMoreRules': "加载更多规则",
    'error.ruleExists': "该规则已存在。请在表格中查找。",
    'panel.title': "访问组",
    'panel.description': "把文档限定给特定的成员组。受限文档只会被其访问组的成员和管理员检索、引用和标注来源。“访问组”“文档”和“连接器映射”跟随“文档处理”中选择的工作区。",
    'panel.tabsLabel': "访问组视图",
    'tab.groups': "访问组：{count}",
    'tab.documents': "文档",
    'tab.mapping': "连接器映射",
    'tab.mappingUnmapped': "连接器映射，未映射：{count}",
    'tab.enforcement': "生效状态",
    'alert.off': "访问组功能已关闭。此处设置的访问组、成员和文档可见范围会被保存，但不会生效：每位成员仍可看到所有文档。",
    'alert.blocked': "访问组功能已开启，但应用无法执行限制。在修复之前，用户无法使用知识库。",
    'alert.unmapped': "未映射的来源群组：{count}。其文档仅对上传者和管理员可见。",
    'action.openEnforcement': "打开生效状态",
    'action.openMapping': "打开连接器映射",
    'groups.personal': "个人工作区只有一位用户，因此没有访问组。请在“文档处理 → 上传目标”中选择团队工作区。",
    'tab.groupsPlain': "访问组",
    'panel.workspaceDefault': "默认工作区",
    'groups.caption': "此工作区的访问组",
    'rename.running': "正在保存…",
    'members.adding': "正在添加…",
    'members.removing': "正在移除…",
    'members.searching': "正在搜索成员…",
    'members.loading': "正在加载成员…",
    'members.unavailable': "暂时无法获取成员。请稍后选择“重新加载面板”。",
    'members.results': "搜索结果",
    'delete.countsLabel': "受影响的文档和成员",
    'filter.restricted': "受限",
    'filter.uploaderOnly': "仅上传者和管理员",
    'filter.everyone': "所有人",
    'filter.all': "全部",
    'docs.search': "按文件名搜索",
    'col.file': "文件",
    'col.docType': "文档类型",
    'col.source': "来源",
    'docs.empty.restricted.title': "没有受限文档",
    'docs.empty.restricted.body': "此工作区的每份文档都对所有人可见。选择“全部”，再选择“编辑可见范围”，即可限制某份文档。",
    'docs.empty.filter': "没有符合此筛选条件的文档。请选择“全部”或清除搜索。",
    'docs.loading': "正在加载文档…",
    'docs.unavailable': "暂时无法获取文档列表。请稍后选择“重新加载面板”。",
    'action.refreshDocuments': "刷新文档",
    'action.loadMoreDocuments': "加载更多文档",
    'docs.manageHint': "要更改文档的可见范围，请打开“RAG 管理 → 访问组 → 文档”。",
    'docs.filterLabel': "显示文档",
    'docs.caption': "文档及其可见范围",
    'docs.loaded': "显示的文档：{count}。",
    'field.choose': "请选择“所有人”或“仅这些访问组”。",
    'field.current': "当前",
    'enforce.scope': "适用于此部署中的所有工作区。",
    'enforce.state.off': "已关闭",
    'enforce.state.enforced': "已生效",
    'enforce.state.restart': "需要重启",
    'enforce.state.unsynced': "不一致",
    'enforce.state.blocked': "已阻断",
    'enforce.state.unknown': "未检查",
    'enforce.sentence.off': "访问组功能已关闭。每位成员都能看到其工作区的所有文档。",
    'enforce.sentence.enforced': "访问组限制已应用于检索、回答、引用、回答缓存、日志和数据库直接读取。",
    'enforce.sentence.restart': "已保存的设置为{saved}，但运行中的应用仍在使用{running}。请重启应用以应用已保存的设置。",
    'enforce.sentence.unsynced': "应用与数据库不一致：应用为{running}，数据库为{database}。请选择“同步生效状态”。",
    'enforce.sentence.blocked': "访问组功能已开启，但系统的某一部分无法执行限制。在以下各项全部修复之前，用户无法使用知识库。",
    'enforce.sentence.unknown': "无法读取状态。请以管理员身份登录主应用，然后选择“重新检查”。",
    'enforce.dl.saved': "已保存的设置",
    'enforce.dl.running': "运行中的应用",
    'enforce.dl.database': "数据库",
    'enforce.dl.checked': "检查时间",
    'value.enforced': "已生效",
    'value.notEnforced': "未生效",
    'action.sync': "同步生效状态",
    'sync.running': "正在同步…",
    'sync.done': "数据库现已与应用一致：{database}。",
    'sync.failed': "无法写入数据库设置。访问组功能开启期间，用户将无法使用知识库。请检查数据库连接和 service-role 密钥，然后选择“同步生效状态”。",
    'action.check': "重新检查",
    'blocked.reason.function_missing_filter': "某个检索函数缺少访问过滤：{name}。请应用数据库迁移 0920 至 0939。",
    'blocked.reason.column_missing': "某张表缺少访问列：{name}。请应用数据库迁移 0920 至 0939。",
    'blocked.reason.backend_unfiltered': "向量后端 {name} 无法按访问组过滤。",
    'blocked.reason.flag_write_failed': "启动时无法写入数据库设置。",
    'blocked.reason.other': "报告的代码为 {code}。请在应用日志中查找 [RAG Access]。",
    'RAG_DOC_ACCESS_GROUPS.label': "访问组",
    'RAG_DOC_ACCESS_GROUPS.opt.off': "关闭（与现在相同）",
    'RAG_DOC_ACCESS_GROUPS.opt.on': "开启",
    'RAG_DOC_ACCESS_GROUPS.now.off': "每位成员都能看到所有文档。访问组和文档可见范围会被保存，但不会生效。",
    'RAG_DOC_ACCESS_GROUPS.now.on': "受限文档仅对其访问组的成员和管理员可见。未受限的文档仍对所有人可见。重启应用后生效。",
    'RAG_EMBED_ACCESS_GROUP.label': "嵌入式聊天的访问组",
    'RAG_EMBED_ACCESS_GROUP.help': "嵌入式聊天所在工作区中某个访问组的标识。填写后，嵌入式聊天和 WhatsApp 也会使用限定给该组的文档作答。留空：它们只使用对所有人可见的文档作答。",
    'RAG_EMBED_ACCESS_GROUP.found': "已找到访问组：{group}。",
    'RAG_EMBED_ACCESS_GROUP.notFound': "嵌入式聊天所在的工作区中没有使用此标识的访问组。在创建之前，嵌入式聊天只使用对所有人可见的文档作答。",
    'warn.embedNeedsSwitch': "访问组功能关闭时，嵌入式聊天的访问组不会生效。",
    'settings.restart': "已保存。请重启应用以生效。",
    'drift.title': "一致性检查",
    'drift.body': "每个切块、父段落、译文和表格行都带有其文档可见范围的副本。此检查会找出与文档不一致的副本。不一致的行在恢复一致之前不会进入回答。",
    'action.runDrift': "运行一致性检查",
    'drift.running': "正在检查…",
    'drift.none': "未发现不一致。检查时间：{time}。",
    'drift.found': "与其文档不一致的行：{count}。这些行不会进入回答。请在应用日志中查找 [RAG Access] drift。",
    'drift.col.store': "存储",
    'drift.col.rows': "不一致的行",
    'drift.store.chunks': "切块",
    'drift.store.parents': "父段落",
    'drift.store.translations': "译文",
    'drift.store.table_rows': "表格行",
    'drift.store.clusters': "重复内容组",
    'drift.unavailable': "无法运行一致性检查。请稍后选择“运行一致性检查”。",
    'connector.failClosed': "仅对上传者和管理员可见的文档：{count}。它们在来源处的共享对象尚未映射到访问组。",
    'connector.failClosedOff': "在来源处的共享对象尚未映射到访问组的文档：{count}。开启访问组功能后，它们将仅对上传者和管理员可见。",
  },
  it: {
    'settings.title': "Impostazioni",
    'enforce.title': "Applicazione",
    'enforce.checking': "Verifica dell’applicazione…",
    'enforce.checked': "Applicazione verificata: {state}.",
    'enforce.unavailable': "Lo stato dell’applicazione non è disponibile. Seleziona Ricarica pannello tra poco.",
    'enforce.reasons': "Cosa blocca i gruppi di accesso",
    'enforce.dlLabel': "Valori dell’applicazione",
    'value.none': "Non noto",
    'blocked.reason.flag_readback_mismatch': "L’impostazione è stata scritta nel database, ma rileggendola si ottiene un valore diverso.",
    'blocked.reason.backend_without_access_filter': "Il backend vettoriale in uso non può filtrare per gruppo di accesso.",
    'drift.caption': "Righe diverse dal loro documento, per archivio",
    'term.everyone': "Tutti",
    'audience.label': "Visibile a",
    'audience.everyone': "Visibile a: Tutti",
    'audience.groups': "Visibile a: {groups}",
    'audience.people': "persone alla fonte: {count}",
    'audience.uploaderOnly': "Solo chi ha caricato e amministratori",
    'badge.restricted': "Riservato",
    'badge.restrictedHint': "Solo alcuni membri possono vedere questo documento.",
    'reason.group_deleted': "Il suo gruppo di accesso è stato eliminato.",
    'reason.unmapped_source': "La sua condivisione alla fonte non è associata a un gruppo di accesso.",
    'reason.source_error': "All'ultima sincronizzazione non è stato possibile leggere la sua condivisione alla fonte.",
    'reason.other': "Riservato dal sistema con il codice {code}.",
    'field.everyoneHelp.org': "Ogni membro di questo spazio di lavoro.",
    'field.everyoneHelp.single': "Ogni utente di questa installazione, comprese la chat incorporata e WhatsApp.",
    'field.onlyGroups': "Solo questi gruppi",
    'field.onlyGroupsHelp': "I membri di uno qualsiasi dei gruppi scelti e gli amministratori.",
    'action.addGroup': "Aggiungi gruppo",
    'action.removeGroupChip': "Rimuovi gruppo: {group}",
    'chip.added': "{group} aggiunto",
    'chip.removed': "{group} rimosso",
    'field.needGroup': "Aggiungi almeno un gruppo, oppure scegli Tutti.",
    'field.noGroups': "Nessun gruppo di accesso. Creane uno prima.",
    'field.widen': "Tutti potranno ottenere risposte da questo documento.",
    'field.widenMany': "Tutti potranno ottenere risposte dai documenti selezionati.",
    'field.mixed': "I documenti selezionati hanno ora accessi diversi. La tua scelta li sostituisce per tutti.",
    'field.effect': "Vale dalla prossima domanda. Non viene ricostruito nulla.",
    'action.editAccess': "Modifica accesso",
    'action.editAccessAria': "Modifica accesso: {file}",
    'action.changeAccess': "Cambia accesso",
    'action.saveAccess': "Salva accesso",
    'action.keepAccess': "Mantieni l'accesso attuale",
    'action.cancelEditing': "Annulla modifica",
    'save.running': "Salvataggio…",
    'save.done': "Accesso salvato per {file}. {audience}",
    'save.doneMany': "Accesso salvato. Documenti modificati: {count}.",
    'save.skipped': "Non modificati, perché il loro accesso segue un connettore: {count}.",
    'edit.title': "Chi può vedere {file}?",
    'bulk.title': "Chi può vedere i documenti selezionati?",
    'bulk.selected': "Selezionati: {count}",
    'action.clearSelection': "Annulla selezione",
    'select.aria': "Seleziona {file}",
    'select.allAria': "Seleziona tutti i documenti mostrati",
    'docs.connectorManaged': "L'accesso segue la condivisione alla fonte. Modificala lì, oppure cambia la mappatura dei connettori.",
    'error.groupGone': "Non salvato. Uno dei gruppi scelti non esiste più. I gruppi sono stati ricaricati.",
    'picker.trigger': "Accesso",
    'picker.everyone': "Tutti",
    'picker.groups': "Gruppi: {n}",
    'picker.aria': "Scegli chi può vedere {file}",
    'picker.note': "Se non scegli nulla, un nuovo documento è visibile a tutti e una nuova versione mantiene l'accesso del documento che sostituisce.",
    'picker.clear': "Rimuovi scelta",
    'error.groupNotAllowed': "Non caricato. Scegli Tutti oppure uno dei tuoi gruppi.",
    'groups.title': "Gruppi di accesso",
    'action.newGroup': "Nuovo gruppo",
    'form.name': "Nome",
    'form.key': "Chiave",
    'form.keyHelp': "Lettere minuscole, cifre e trattini. La chiave non si può cambiare in seguito; il nome sì.",
    'form.needName': "Inserisci un nome.",
    'form.badKey': "Usa lettere minuscole, cifre e trattini, iniziando con una lettera o una cifra.",
    'form.reservedKey': "La chiave «all» è riservata. Inserisci un'altra chiave.",
    'action.createGroup': "Crea gruppo",
    'action.closeForm': "Chiudi modulo",
    'create.running': "Creazione…",
    'create.done': "Gruppo {group} creato. Aggiungi i membri, poi riserva i documenti al gruppo.",
    'error.groupExists': "Esiste già un gruppo con questa chiave. Cambia la chiave.",
    'col.group': "Gruppo",
    'col.members': "Membri",
    'col.documents': "Documenti",
    'col.actions': "Azioni",
    'group.members': "Membri: {count}",
    'group.documents': "Documenti: {count}",
    'group.sourceConnector': "Da un connettore",
    'action.manageMembers': "Gestisci membri",
    'action.manageMembersAria': "Gestisci membri: {group}",
    'action.closeMembers': "Chiudi membri",
    'action.renameGroup': "Rinomina gruppo",
    'action.renameGroupAria': "Rinomina gruppo: {group}",
    'action.saveName': "Salva nome",
    'rename.done': "Gruppo rinominato in {group}. Documenti e membri restano invariati.",
    'action.deleteGroup': "Elimina gruppo",
    'action.deleteGroupAria': "Elimina gruppo: {group}",
    'action.keepGroup': "Mantieni gruppo",
    'delete.title': "Eliminare {group}?",
    'delete.counting': "Conteggio dei documenti interessati…",
    'delete.docsClosed': "Documenti riservati solo a questo gruppo: {count}",
    'delete.docsOther': "Documenti che restano visibili agli altri loro gruppi: {count}",
    'delete.members': "Membri che perdono l'accesso tramite questo gruppo: {count}",
    'delete.mappings': "Mappature dei connettori rimosse insieme: {count}",
    'delete.body': "I documenti riservati solo a questo gruppo diventano visibili solo a chi li ha caricati e agli amministratori, mai a tutti. L'operazione non può essere annullata.",
    'delete.countUnavailable': "Non è stato possibile contare i documenti interessati, quindi ora il gruppo non può essere eliminato. Seleziona Conta di nuovo.",
    'action.countAgain': "Conta di nuovo",
    'delete.running': "Eliminazione…",
    'delete.done': "Gruppo {group} eliminato. Documenti ora visibili solo a chi li ha caricati e agli amministratori: {count}.",
    'groups.empty.title': "Nessun gruppo di accesso",
    'groups.empty.body': "Ogni documento è visibile a tutti in questo spazio di lavoro. Crea un gruppo, aggiungi i membri, poi riserva i documenti al gruppo. Seleziona Nuovo gruppo.",
    'groups.adminNote': "Proprietari e amministratori vedono ogni documento e non devono far parte di un gruppo.",
    'groups.loading': "Caricamento dei gruppi di accesso…",
    'groups.loaded': "Gruppi di accesso caricati: {count}.",
    'groups.unavailable': "I gruppi di accesso non sono disponibili. Seleziona {reload} tra poco.",
    'action.refreshGroups': "Aggiorna i gruppi",
    'action.loadMoreGroups': "Carica altri gruppi",
    'members.title': "Membri di {group}",
    'members.search': "Cerca membri per nome o e-mail",
    'members.searchHint': "Digita almeno 2 caratteri.",
    'members.noMatch': "Nessun membro di questo spazio di lavoro corrisponde a «{query}».",
    'members.already': "Già nel gruppo",
    'members.col.name': "Nome",
    'members.col.added': "Aggiunto il",
    'action.addMember': "Aggiungi membro",
    'action.addMemberAria': "Aggiungi membro: {name}",
    'member.added': "{name} aggiunto a {group}. Vede i documenti del gruppo dalla prossima domanda.",
    'action.removeMember': "Rimuovi membro",
    'action.removeMemberAria': "Rimuovi membro: {name}",
    'member.removed': "{name} rimosso da {group}. Perde l'accesso tramite questo gruppo dalla prossima domanda.",
    'members.empty': "Nessun membro. Finché non aggiungi qualcuno, solo gli amministratori vedono i documenti riservati a questo gruppo.",
    'error.memberExists': "Questa persona è già nel gruppo. L'elenco è stato ricaricato.",
    'error.notWorkspaceMember': "Questa persona non è più membro dello spazio di lavoro. L'elenco è stato ricaricato.",
    'mapping.title': "Mappatura dei connettori",
    'mapping.description': "Associa i gruppi e i team della fonte ai gruppi di accesso. A ogni sincronizzazione, un documento condiviso con un gruppo associato diventa visibile a quel gruppo di accesso. Una condivisione non associata lascia il documento visibile solo a chi lo ha caricato e agli amministratori.",
    'mapping.personalNote': "In questa installazione i documenti dei connettori restano nello spazio personale di chi ha collegato la fonte. Le mappature vengono salvate, ma non cambiano chi può vedere quei documenti.",
    'mapping.groups.title': "Gruppi e team alla fonte",
    'mapping.col.source': "Fonte",
    'mapping.col.principal': "Gruppo o team alla fonte",
    'mapping.col.accessGroup': "Gruppo di accesso",
    'mapping.notMapped': "Non associato",
    'mapping.kind.group': "Gruppo",
    'mapping.kind.team': "Team",
    'mapping.kind.workspace': "Intero spazio di lavoro",
    'action.saveMapping': "Salva mappatura",
    'action.saveMappingAria': "Salva mappatura: {principal}",
    'mapping.saved': "{principal} è associato a {group}. Vale dalla prossima sincronizzazione.",
    'action.removeMapping': "Rimuovi mappatura",
    'action.removeMappingAria': "Rimuovi mappatura: {principal}",
    'mapping.removed': "Mappatura rimossa: {principal}. Dalla prossima sincronizzazione i suoi documenti sono visibili solo a chi li ha caricati e agli amministratori.",
    'action.newMapping': "Nuova mappatura",
    'mapping.form.principal': "ID del gruppo o team alla fonte",
    'mapping.form.principalHelp': "Inseriscilo esattamente come lo mostra la fonte. Per Google Drive è l'indirizzo del gruppo.",
    'action.createMapping': "Crea mappatura",
    'error.mappingExists': "Questo gruppo o team è già associato. Cambia il suo gruppo di accesso nella tabella.",
    'mapping.empty.title': "Nessun gruppo della fonte rilevato",
    'mapping.empty.body': "Dopo una sincronizzazione, qui appaiono i gruppi e i team con cui sono condivisi i documenti. Seleziona Nuova mappatura per aggiungerne uno in anticipo.",
    'mapping.loading': "Caricamento della mappatura…",
    'mapping.unavailable': "La mappatura dei connettori non è disponibile. Seleziona {reload} tra poco.",
    'action.refreshMapping': "Aggiorna la mappatura",
    'rules.title': "Condivisione con un intero dominio o tramite link",
    'rules.description': "Disattivate finché non attivi una regola: questi documenti restano visibili solo a chi li ha caricati e agli amministratori. Una regola attiva considera quella condivisione come Tutti.",
    'rules.col.sharedWith': "Condiviso con",
    'rules.col.counts': "Vale come Tutti",
    'rules.kind.domain': "Tutti in {domain}",
    'rules.kind.anyone': "Chiunque abbia il link",
    'rules.kind.public': "Pubblicato sul web",
    'rules.toggleAria': "Vale come Tutti: {rule}, {source}",
    'value.on': "Attivo",
    'value.off': "Disattivato",
    'rules.confirm.title': "Considerare questa condivisione come Tutti?",
    'rules.confirm.body': "{source}, {rule}. Documenti: {count}. Dalla prossima sincronizzazione sono visibili a chiunque possa usare questo spazio di lavoro. Puoi disattivare di nuovo la regola.",
    'action.keepRuleOff': "Lascia la regola disattivata",
    'action.turnRuleOn': "Attiva regola",
    'rules.turnedOn': "Regola attiva: {rule}, {source}. Vale dalla prossima sincronizzazione.",
    'rules.turnedOff': "Regola disattivata: {rule}, {source}. Dalla prossima sincronizzazione quei documenti sono visibili solo a chi li ha caricati e agli amministratori.",
    'action.addDomain': "Aggiungi regola di dominio",
    'rules.form.domain': "Dominio",
    'rules.badDomain': "Inserisci un dominio come example.org, senza schema, percorso o porta.",
    'action.createRule': "Crea regola",
    'rules.empty': "Nessuna condivisione con un intero dominio o tramite link rilevata. Le regole compaiono dopo la prossima sincronizzazione del connettore.",
    'mapping.caption': "Gruppi della fonte e i loro gruppi di accesso",
    'mapping.loaded': "Gruppi della fonte mostrati: {count}.",
    'mapping.need': "Per creare la mappatura, compila: {fields}.",
    'mapping.form.choose': "Scegli…",
    'mapping.selectAria': "Gruppo di accesso: {principal}",
    'action.loadMoreMapping': "Carica altri gruppi della fonte",
    'rules.caption': "Condivisione con un intero dominio o tramite link, per fonte",
    'rules.need': "Per creare la regola, compila: {fields}.",
    'rules.created': "Regola creata e disattivata: {rule}, {source}. Attivala per considerare questa condivisione come Tutti dalla prossima sincronizzazione.",
    'action.loadMoreRules': "Carica altre regole",
    'error.ruleExists': "Questa regola esiste già. Cercala nella tabella.",
    'panel.title': "Gruppi di accesso",
    'panel.description': "Riserva i documenti a gruppi di membri. Un documento riservato viene trovato, citato e indicato come fonte solo per i membri dei suoi gruppi e per gli amministratori. Gruppi, Documenti e Mappatura dei connettori seguono lo spazio di lavoro scelto in Document Processing.",
    'panel.tabsLabel': "Viste dei gruppi di accesso",
    'tab.groups': "Gruppi: {count}",
    'tab.documents': "Documenti",
    'tab.mapping': "Mappatura dei connettori",
    'tab.mappingUnmapped': "Mappatura dei connettori, non associati: {count}",
    'tab.enforcement': "Applicazione",
    'alert.off': "I gruppi di accesso sono disattivati. Gruppi, membri e accessi impostati qui vengono salvati ma non applicati: ogni membro vede ancora ogni documento.",
    'alert.blocked': "I gruppi di accesso sono attivi, ma l'app non riesce ad applicarli. La knowledge base non è disponibile per gli utenti finché il problema non è risolto.",
    'alert.unmapped': "Gruppi della fonte non associati: {count}. I loro documenti sono visibili solo a chi li ha caricati e agli amministratori.",
    'action.openEnforcement': "Apri applicazione",
    'action.openMapping': "Apri mappatura dei connettori",
    'groups.personal': "Uno spazio personale ha un solo utente, quindi non ha gruppi di accesso. Scegli uno spazio di team in Document Processing, Upload Destination.",
    'tab.groupsPlain': "Gruppi",
    'panel.workspaceDefault': "Spazio di lavoro predefinito",
    'groups.caption': "Gruppi di accesso di questo spazio di lavoro",
    'rename.running': "Salvataggio…",
    'members.adding': "Aggiunta…",
    'members.removing': "Rimozione…",
    'members.searching': "Ricerca dei membri…",
    'members.loading': "Caricamento dei membri…",
    'members.unavailable': "I membri non sono disponibili. Seleziona Ricarica pannello tra poco.",
    'members.results': "Risultati della ricerca",
    'delete.countsLabel': "Documenti e membri interessati",
    'filter.restricted': "Riservati",
    'filter.uploaderOnly': "Solo chi ha caricato e amministratori",
    'filter.everyone': "Tutti",
    'filter.all': "Tutti i documenti",
    'docs.search': "Cerca per nome del file",
    'col.file': "File",
    'col.docType': "Tipo di documento",
    'col.source': "Origine",
    'docs.empty.restricted.title': "Nessun documento riservato",
    'docs.empty.restricted.body': "Ogni documento di questo spazio di lavoro è visibile a tutti. Scegli Tutti i documenti, poi Modifica accesso, per riservarne uno.",
    'docs.empty.filter': "Nessun documento corrisponde a questo filtro. Scegli Tutti o cancella la ricerca.",
    'docs.loading': "Caricamento dei documenti…",
    'docs.unavailable': "L'elenco dei documenti non è disponibile. Seleziona Ricarica pannello tra poco.",
    'action.refreshDocuments': "Aggiorna i documenti",
    'action.loadMoreDocuments': "Carica altri documenti",
    'docs.manageHint': "Per cambiare chi può vedere un documento, apri RAG administration, Gruppi di accesso, Documenti.",
    'docs.filterLabel': "Mostra documenti",
    'docs.caption': "Documenti e chi può vederli",
    'docs.loaded': "Documenti mostrati: {count}.",
    'field.choose': "Scegli Tutti oppure Solo questi gruppi.",
    'field.current': "Ora",
    'enforce.scope': "Vale per ogni spazio di lavoro di questa installazione.",
    'enforce.state.off': "Disattivato",
    'enforce.state.enforced': "Applicato",
    'enforce.state.restart': "Riavvio necessario",
    'enforce.state.unsynced': "Non allineato",
    'enforce.state.blocked': "Bloccato",
    'enforce.state.unknown': "Non verificato",
    'enforce.sentence.off': "I gruppi di accesso sono disattivati. Ogni membro vede ogni documento del proprio spazio di lavoro.",
    'enforce.sentence.enforced': "I gruppi di accesso sono applicati a ricerca, risposte, citazioni, cache delle risposte, log e letture dirette del database.",
    'enforce.sentence.restart': "L'impostazione salvata è {saved}, ma l'app in esecuzione usa ancora {running}. Riavvia l'app per applicare l'impostazione salvata.",
    'enforce.sentence.unsynced': "App e database non coincidono: l'app è {running}, il database è {database}. Seleziona Sincronizza applicazione.",
    'enforce.sentence.blocked': "I gruppi di accesso sono attivi, ma una parte del sistema non riesce ad applicarli. La knowledge base non è disponibile per gli utenti finché ogni punto qui sotto non è risolto.",
    'enforce.sentence.unknown': "Non è stato possibile leggere lo stato. Accedi all'app principale come amministratore, poi seleziona Controlla di nuovo.",
    'enforce.dl.saved': "Impostazione salvata",
    'enforce.dl.running': "App in esecuzione",
    'enforce.dl.database': "Database",
    'enforce.dl.checked': "Verificato",
    'value.enforced': "Applicato",
    'value.notEnforced': "Non applicato",
    'action.sync': "Sincronizza applicazione",
    'sync.running': "Sincronizzazione…",
    'sync.done': "Ora il database coincide con l'app: {database}.",
    'sync.failed': "Non è stato possibile scrivere l'impostazione nel database. Finché i gruppi di accesso sono attivi, la knowledge base resta non disponibile per gli utenti. Controlla la connessione al database e la chiave service-role, poi seleziona Sincronizza applicazione.",
    'action.check': "Controlla di nuovo",
    'blocked.reason.function_missing_filter': "Una funzione di ricerca non ha il filtro di accesso: {name}. Applica le migrazioni del database da 0920 a 0939.",
    'blocked.reason.column_missing': "Una tabella non ha la colonna di accesso: {name}. Applica le migrazioni del database da 0920 a 0939.",
    'blocked.reason.backend_unfiltered': "Il backend vettoriale {name} non può filtrare per gruppo di accesso.",
    'blocked.reason.flag_write_failed': "All'avvio non è stato possibile scrivere l'impostazione nel database.",
    'blocked.reason.other': "Segnalato con il codice {code}. Cerca [RAG Access] nel log dell'app.",
    'RAG_DOC_ACCESS_GROUPS.label': "Gruppi di accesso",
    'RAG_DOC_ACCESS_GROUPS.opt.off': "Disattivati, come oggi",
    'RAG_DOC_ACCESS_GROUPS.opt.on': "Attivi",
    'RAG_DOC_ACCESS_GROUPS.now.off': "Ogni membro vede ogni documento. Gruppi e accessi vengono salvati ma non applicati.",
    'RAG_DOC_ACCESS_GROUPS.now.on': "Un documento riservato è visibile solo ai membri dei suoi gruppi e agli amministratori. I documenti non riservati restano visibili a tutti. Vale dopo il riavvio dell'app.",
    'RAG_EMBED_ACCESS_GROUP.label': "Gruppo della chat incorporata",
    'RAG_EMBED_ACCESS_GROUP.help': "La chiave di un gruppo di accesso nello spazio di lavoro della chat incorporata. La chat incorporata e WhatsApp rispondono allora anche dai documenti riservati a quel gruppo. Vuoto: rispondono solo dai documenti visibili a tutti.",
    'RAG_EMBED_ACCESS_GROUP.found': "Gruppo trovato: {group}.",
    'RAG_EMBED_ACCESS_GROUP.notFound': "Nello spazio di lavoro della chat incorporata non esiste un gruppo con questa chiave. Finché non esiste, la chat incorporata risponde solo dai documenti visibili a tutti.",
    'warn.embedNeedsSwitch': "Il gruppo della chat incorporata non ha effetto finché i gruppi di accesso sono disattivati.",
    'settings.restart': "Salvato. Riavvia l'app per applicare.",
    'drift.title': "Controllo delle etichette",
    'drift.body': "Ogni chunk, passaggio padre, traduzione e riga di tabella porta una copia dell'accesso del suo documento. Questo controllo trova le copie che differiscono dal documento. Una riga diversa resta esclusa dalle risposte finché non coincide.",
    'action.runDrift': "Esegui controllo",
    'drift.running': "Controllo in corso…",
    'drift.none': "Nessuna differenza trovata. Verificato {time}.",
    'drift.found': "Righe che differiscono dal loro documento: {count}. Restano escluse dalle risposte. Cerca [RAG Access] drift nel log dell'app.",
    'drift.col.store': "Archivio",
    'drift.col.rows': "Righe diverse",
    'drift.store.chunks': "Chunk",
    'drift.store.parents': "Passaggi padre",
    'drift.store.translations': "Traduzioni",
    'drift.store.table_rows': "Righe di tabella",
    'drift.store.clusters': "Gruppi di duplicati",
    'drift.unavailable': "Non è stato possibile eseguire il controllo. Seleziona Esegui controllo tra poco.",
    'connector.failClosed': "Documenti visibili solo a chi li ha caricati e agli amministratori: {count}. La loro condivisione alla fonte non è associata a un gruppo di accesso.",
    'connector.failClosedOff': "Documenti la cui condivisione alla fonte non è associata a un gruppo di accesso: {count}. Quando i gruppi di accesso saranno attivi, saranno visibili solo a chi li ha caricati e agli amministratori.",
  },
};

const ACCESS_GROUPS_PATH = '/api/rag/access-groups';
const ACCESS_GROUPS_KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCESS_GROUPS_RESERVED_KEYS = new Set(['all']);
const ACCESS_GROUPS_SWITCH_ID = 'RAG_DOC_ACCESS_GROUPS';
const ACCESS_GROUPS_EMBED_ID = 'RAG_EMBED_ACCESS_GROUP';
/** Reasons whose remedy is the flag write that Sync enforcement reruns (04.3-24). */
const ACCESS_GROUPS_FLAG_REASONS = new Set(['flag_write_failed', 'flag_readback_mismatch']);
/** Reasons with their own sentence; readiness_not_ready only introduces the codes that follow it. */
const ACCESS_GROUPS_REASON_KEYS = {
  function_missing_filter: 'blocked.reason.function_missing_filter',
  column_missing: 'blocked.reason.column_missing',
  backend_unfiltered: 'blocked.reason.backend_unfiltered',
  backend_without_access_filter: 'blocked.reason.backend_without_access_filter',
  flag_write_failed: 'blocked.reason.flag_write_failed',
  flag_readback_mismatch: 'blocked.reason.flag_readback_mismatch',
};
const ACCESS_GROUPS_NAMED_REASONS = new Set(['function_missing_filter', 'column_missing', 'backend_unfiltered']);
/** Store names of rag_access_groups_drift and their labels; any other name is shown as a code. */
const ACCESS_GROUPS_DRIFT_STORES = {
  document_chunks: 'drift.store.chunks',
  chunks: 'drift.store.chunks',
  document_parents: 'drift.store.parents',
  parents: 'drift.store.parents',
  chunk_translations: 'drift.store.translations',
  translations: 'drift.store.translations',
  rag_table_rows: 'drift.store.table_rows',
  table_rows: 'drift.store.table_rows',
  rag_duplicate_clusters: 'drift.store.clusters',
  clusters: 'drift.store.clusters',
};

/** UI-SPEC 6.6: badge, icon, word and sentence of each state. */
const ACCESS_GROUPS_STATES = {
  off: { badge: 'badge-ghost', icon: 'dash-circle' },
  enforced: { badge: 'badge-success', icon: 'shield-check' },
  restart: { badge: 'badge-info badge-outline', icon: 'arrow-repeat' },
  unsynced: { badge: 'badge-warning', icon: 'exclamation-triangle' },
  blocked: { badge: 'badge-error', icon: 'x-octagon' },
  unknown: { badge: 'badge-ghost', icon: 'question-circle' },
};

let accessGroupsUi = null;
if (typeof require !== 'undefined') {
  try {
    accessGroupsUi = require('./rag-ui.js');
  } catch {
    accessGroupsUi = null;
  }
}

/** The rag-ui.js helpers: the page's globals in the browser, the module under vitest. */
function accessGroupsUiLib() {
  if (accessGroupsUi) return accessGroupsUi;
  return typeof window !== 'undefined' ? window : globalThis;
}

/** One label function: placeholders filled, English fallback, then the shared rag-ui.js table. */
function accessGroupsLabel(key, locale, vars) {
  const ui = accessGroupsUiLib();
  const text = ui.ragUiLookup(ACCESS_GROUPS_LABELS, key, locale, vars);
  return text === undefined ? ui.ragUiLabel(key, locale, vars) : text;
}

function accessGroupsLocale(language) {
  const ui = accessGroupsUiLib();
  return language === undefined ? ui.ragUiBrowserLocale() : ui.ragUiResolveLocale(language);
}

function accessGroupsText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function accessGroupsSwitchValue(value) {
  const text = accessGroupsText(value).trim().toLowerCase();
  return text === 'on' ? 'on' : text === 'off' || text === '' ? 'off' : 'unknown';
}

function accessGroupsCodes(list) {
  return Array.isArray(list) ? list.filter((v) => typeof v === 'string' && v.length > 0) : [];
}

/**
 * A-03, UI-SPEC 6.6: the state from the saved setting, the running app's setting, the database flag and readiness.
 * status is the GET /status answer's `status` object, or null when the call failed. blocked wins over unsynced, which
 * wins over restart.
 */
function buildAccessGroupsEnforcementView(saved, status) {
  const savedValue = accessGroupsSwitchValue(saved);
  const base = { saved: savedValue, running: null, database: null, checkedAt: null, reasons: [], objects: [], embedGroup: null };
  if (!status || typeof status !== 'object') {
    return { ...base, state: 'unknown', actions: ['check'], canSync: false };
  }
  const running = accessGroupsSwitchValue(status.runningSwitch);
  const database = typeof status.databaseFlag === 'boolean' ? status.databaseFlag : null;
  const ready = status.ready === true && status.status === 'ready';
  const reasons = accessGroupsCodes(status.reasons);
  const objects = accessGroupsCodes(status.objects);
  const view = {
    ...base,
    running,
    database,
    checkedAt: typeof status.checkedAt === 'string' ? status.checkedAt : null,
    reasons,
    objects,
    embedGroup: accessGroupsEmbedGroup(status.embedGroup),
  };
  const runningOn = running === 'on';
  let state;
  if (running === 'unknown') state = 'unknown';
  else if (runningOn && !ready) state = 'blocked';
  else if (database !== runningOn) state = 'unsynced';
  else if (savedValue !== running) state = 'restart';
  else state = runningOn ? 'enforced' : 'off';
  const flagReason = reasons.some((r) => ACCESS_GROUPS_FLAG_REASONS.has(r));
  const canSync = state === 'unsynced' || (state === 'blocked' && flagReason);
  return { ...view, state, canSync, actions: canSync ? ['sync', 'check'] : ['check'] };
}

function accessGroupsEmbedGroup(value) {
  if (!value || typeof value !== 'object') return null;
  const key = accessGroupsText(value.key);
  if (!key) return null;
  return { key, valid: value.valid === true, exists: value.exists === true, name: typeof value.name === 'string' && value.name ? value.name : null };
}

/** The reason sentences of the Blocked state: named fields only, an unknown code inside reason.other. */
function accessGroupsReasonItems(view) {
  const items = [];
  const named = view.objects.length ? view.objects.join(', ') : '';
  const codes = view.reasons.filter((code, index, all) => all.indexOf(code) === index);
  const onlyHeader = codes.length === 1 && codes[0] === 'readiness_not_ready';
  for (const code of codes) {
    if (code === 'readiness_not_ready' && !onlyHeader) continue;
    const key = ACCESS_GROUPS_REASON_KEYS[code];
    if (key) items.push({ code, key, name: ACCESS_GROUPS_NAMED_REASONS.has(code) ? named : null });
    else items.push({ code, key: 'blocked.reason.other', name: null });
  }
  if (view.state === 'blocked' && items.length === 0) items.push({ code: 'not_ready', key: 'blocked.reason.other', name: null });
  return items;
}

/** POST /drift: only the stores the server reports; a store that is absent is never shown as zero. */
function accessGroupsDriftView(body) {
  const list = body && Array.isArray(body.stores) ? body.stores : [];
  const stores = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const store = accessGroupsText(item.store);
    const rows = Number(item.rows);
    if (!store || !Number.isFinite(rows) || rows < 0) continue;
    stores.push({ store, key: ACCESS_GROUPS_DRIFT_STORES[store] || null, rows });
  }
  const differing = stores.filter((s) => s.rows > 0);
  const total = differing.reduce((sum, s) => sum + s.rows, 0);
  return { stores, differing, total, checkedAt: body && typeof body.checkedAt === 'string' ? body.checkedAt : null };
}

/**
 * D-07, UI-SPEC 6.6: the Embedded chat group field. value is the field's text; switchValue the select's; embedGroup the
 * status answer's check of the key the running app uses. Returns { finding, warn }.
 */
function accessGroupsEmbedCheck(value, switchValue, embedGroup) {
  const key = accessGroupsText(value).trim();
  const result = { finding: null, warn: false };
  if (!key) return result;
  result.warn = accessGroupsSwitchValue(switchValue) !== 'on';
  if (ACCESS_GROUPS_RESERVED_KEYS.has(key)) result.finding = { key: 'form.reservedKey', tone: 'error' };
  else if (!ACCESS_GROUPS_KEY_RE.test(key)) result.finding = { key: 'form.badKey', tone: 'error' };
  else if (embedGroup && embedGroup.key === key) {
    if (!embedGroup.valid) result.finding = { key: 'form.badKey', tone: 'error' };
    else if (embedGroup.exists) result.finding = { key: 'RAG_EMBED_ACCESS_GROUP.found', tone: 'success', group: embedGroup.name || key };
    else result.finding = { key: 'RAG_EMBED_ACCESS_GROUP.notFound', tone: 'warning' };
  }
  return result;
}

/**
 * UI-SPEC 7.1, 8.2: the one error mapper of the panel. ctx.write: a write action (a timeout means the outcome is unknown);
 * ctx.unavailable: the view's unavailable sentence. 403 is split by body.error (Forbidden is the workspace sentence).
 */
function mapAccessGroupsError(result, locale, ctx) {
  const ui = accessGroupsUiLib();
  const opts = ctx || {};
  const body = result && result.body && typeof result.body === 'object' ? result.body : {};
  const err = typeof body.error === 'string' ? body.error : '';
  if (!result || result.thrown) {
    if (opts.write) return { key: 'error.outcomeUnknown', kind: 'outcomeUnknown', message: accessGroupsLabel('error.outcomeUnknown', locale), reload: true };
    return { key: 'error.network', kind: 'network', message: ui.ragUiSharedLabel('error.network', locale) };
  }
  const status = result.status;
  if (status === 409 && err === 'group_exists') {
    return { key: 'error.groupExists', kind: 'field', field: 'key', message: accessGroupsLabel('error.groupExists', locale) };
  }
  if (status === 409 && err === 'member_exists') {
    return { key: 'error.memberExists', kind: 'member', message: accessGroupsLabel('error.memberExists', locale), reload: true };
  }
  if (status === 400 && err === 'not_a_workspace_member') {
    return { key: 'error.notWorkspaceMember', kind: 'member', message: accessGroupsLabel('error.notWorkspaceMember', locale), reload: true };
  }
  if (status === 409 && err === 'count_required') {
    const count = Number(body.count);
    return { key: 'count_required', kind: 'recount', count: Number.isInteger(count) && count >= 0 ? count : null, message: accessGroupsLabel('delete.counting', locale) };
  }
  if (status === 400 && (err === 'invalid_key' || err === 'reserved_key')) {
    const key = err === 'invalid_key' ? 'form.badKey' : 'form.reservedKey';
    return { key, kind: 'field', field: 'key', message: accessGroupsLabel(key, locale) };
  }
  if (status === 409 && err === 'mapping_exists') {
    return { key: 'error.mappingExists', kind: 'field', field: 'principal', message: accessGroupsLabel('error.mappingExists', locale) };
  }
  if (status === 409 && err === 'rule_exists') {
    return { key: 'error.ruleExists', kind: 'field', field: 'domain', message: accessGroupsLabel('error.ruleExists', locale) };
  }
  if (status === 400 && err === 'bad_domain') {
    return { key: 'rules.badDomain', kind: 'field', field: 'domain', message: accessGroupsLabel('rules.badDomain', locale) };
  }
  if (status === 400 && err === 'personal_tenant') {
    return { key: 'groups.personal', kind: 'changed', message: accessGroupsLabel('groups.personal', locale), reload: true };
  }
  if (status === 400 && err === 'unknown_group') {
    return { key: 'error.groupGone', kind: 'groupGone', message: accessGroupsLabel('error.groupGone', locale), reload: true };
  }
  if (status === 409 && err === 'access_managed_by_connector') {
    return { key: 'docs.connectorManaged', kind: 'connector', message: accessGroupsLabel('docs.connectorManaged', locale), reload: true };
  }
  if (status === 404 || (status === 409 && opts.write)) {
    return { key: 'error.changed', kind: 'changed', message: accessGroupsLabel('error.changed', locale), reload: true };
  }
  return ui.ragUiMapError(result, locale, { unavailable: opts.unavailable });
}

const ACCESS_GROUPS_PAGE = 50;
const ACCESS_GROUPS_SEARCH_MIN = 2;
const ACCESS_GROUPS_SEARCH_WAIT_MS = 400;
const ACCESS_GROUPS_SEARCH_MAX = 20;

/** D-01, UI-SPEC 6.3: a key suggested from the name; nothing for a name without an ASCII letter or for a reserved key. */
function accessGroupsSuggestKey(name) {
  const slug = accessGroupsText(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  if (!/[a-z]/.test(slug) || ACCESS_GROUPS_RESERVED_KEYS.has(slug) || !ACCESS_GROUPS_KEY_RE.test(slug)) return '';
  return slug;
}

/** The new-group form's findings, in field order; the form can be sent only when there is none (UI-SPEC 6.3, 9.6). */
function accessGroupsFormFindings(name, key) {
  const findings = [];
  if (!accessGroupsText(name).trim()) findings.push({ field: 'name', key: 'form.needName' });
  const k = accessGroupsText(key).trim();
  if (ACCESS_GROUPS_RESERVED_KEYS.has(k)) findings.push({ field: 'key', key: 'form.reservedKey' });
  else if (!ACCESS_GROUPS_KEY_RE.test(k)) findings.push({ field: 'key', key: 'form.badKey' });
  return { findings, valid: findings.length === 0 };
}

function accessGroupsCount(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** One row of GET /: id, key, name, source, counts; a row without id or key is dropped. */
function buildAccessGroupsGroupRow(group) {
  if (!group || typeof group !== 'object') return null;
  const id = accessGroupsText(group.id);
  const key = accessGroupsText(group.key);
  if (!id || !key) return null;
  const source = accessGroupsText(group.source) || 'manual';
  return {
    id,
    key,
    name: accessGroupsText(group.name) || key,
    source,
    connector: source === 'connector',
    memberCount: accessGroupsCount(group.memberCount),
    documentCount: accessGroupsCount(group.documentCount),
  };
}

/** The GET / answer: rows, cursor, personal workspace. */
function buildAccessGroupsList(body) {
  const b = body && typeof body === 'object' ? body : {};
  const rows = (Array.isArray(b.groups) ? b.groups : []).map(buildAccessGroupsGroupRow).filter(Boolean);
  return { personal: b.personal === true, rows, nextCursor: typeof b.nextCursor === 'string' && b.nextCursor ? b.nextCursor : null };
}

/** UI-SPEC 6.3: a member's name as the route returns it; the e-mail without a name; a bare id in font-mono. */
function accessGroupsMemberName(member) {
  const m = member && typeof member === 'object' ? member : {};
  const display = accessGroupsText(m.displayName).trim();
  if (display) return { text: display, mono: false };
  const email = accessGroupsText(m.email).trim();
  if (email) return { text: email, mono: false };
  return { text: accessGroupsText(m.userId), mono: true };
}

/** GET /{id}/impact: the three counts and the mapping count; null when one of the three is missing (D-18). */
function buildAccessGroupsImpactView(body) {
  const impact = body && typeof body === 'object' && body.impact && typeof body.impact === 'object' ? body.impact : null;
  if (!impact) return null;
  const pick = (v) => {
    const n = Number(v);
    return v !== null && v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 ? n : null;
  };
  const onlyCount = pick(impact.onlyCount);
  const sharedCount = pick(impact.sharedCount);
  const memberCount = pick(impact.memberCount);
  if (onlyCount === null || sharedCount === null || memberCount === null) return null;
  return { onlyCount, sharedCount, memberCount, mappingCount: pick(impact.mappingCount) || 0 };
}

/** "label: {count}" templates split into the label for a dt; the number goes in the dd. */
function accessGroupsCountLabel(template) {
  return accessGroupsText(template).replace(/\s*[:：]\s?\{count\}\s*$/, '');
}

const ACCESS_GROUPS_DOC_FILTERS = ['restricted', 'uploader_only', 'everyone', 'all'];
const ACCESS_GROUPS_FILTER_KEYS = { restricted: 'filter.restricted', uploader_only: 'filter.uploaderOnly', everyone: 'filter.everyone', all: 'filter.all' };
const ACCESS_GROUPS_KNOWN_REASONS = new Set(['group_deleted', 'unmapped_source', 'source_error']);
/** Reasons whose remedy is a connector mapping, so the action is Open connector mapping (UI-SPEC 6.2.1). */
const ACCESS_GROUPS_SOURCE_REASONS = new Set(['unmapped_source', 'source_error']);
const ACCESS_GROUPS_DOC_COLUMNS = 6;

/**
 * One document of GET /documents (04.3-24 Audience), normalised. A kind the UI does not know is read as the fallback audience
 * with the kind as its reason code, so an unknown value is never shown as Everyone.
 */
function buildAccessGroupsDocumentRow(audience) {
  if (!audience || typeof audience !== 'object') return null;
  const id = accessGroupsText(audience.documentId);
  if (!id) return null;
  const rawKind = accessGroupsText(audience.kind);
  const known = rawKind === 'everyone' || rawKind === 'groups' || rawKind === 'uploader_only';
  const groups = (Array.isArray(audience.groups) ? audience.groups : [])
    .filter((g) => g && typeof g === 'object' && accessGroupsText(g.id))
    .map((g) => ({ id: accessGroupsText(g.id), name: accessGroupsText(g.name) || accessGroupsText(g.id) }));
  let kind = known ? rawKind : 'uploader_only';
  if (kind === 'groups' && groups.length === 0) kind = 'uploader_only';
  const reason = known ? accessGroupsText(audience.fallbackReason) : rawKind || 'unknown_kind';
  return {
    id,
    filename: accessGroupsText(audience.filename) || id,
    docType: accessGroupsText(audience.docType),
    source: accessGroupsText(audience.source),
    kind,
    groups: kind === 'groups' ? groups : [],
    peopleCount: accessGroupsCount(audience.peopleCount),
    fallbackReason: kind === 'uploader_only' ? reason || null : null,
    connectorManaged: audience.connectorManaged === true,
  };
}

/** The GET /documents answer: rows, cursor, personal workspace and the per-filter counts. */
function buildAccessGroupsDocumentsList(body) {
  const b = body && typeof body === 'object' ? body : {};
  const rows = (Array.isArray(b.documents) ? b.documents : []).map(buildAccessGroupsDocumentRow).filter(Boolean);
  const c = b.counts && typeof b.counts === 'object' ? b.counts : {};
  return {
    personal: b.personal === true,
    rows,
    nextCursor: typeof b.nextCursor === 'string' && b.nextCursor ? b.nextCursor : null,
    counts: { restricted: accessGroupsCount(c.restricted), uploader_only: accessGroupsCount(c.uploaderOnly), everyone: accessGroupsCount(c.everyone), all: accessGroupsCount(c.all) },
  };
}

function accessGroupsJoinNames(names, locale) {
  return names.join(locale === 'zh' ? '、' : ', ');
}

/**
 * D-02, D-18, D-20, UI-SPEC 6.2.1: the one function that turns a document's audience into words. Accepts a GET /documents
 * Audience or a normalised row. Exactly three readings: everyone, groups (with the people count only), uploader_only (with
 * its reason and one action). Names and words only: no key is ever part of the view.
 */
function buildAccessGroupsAudienceView(audience, locale) {
  const row = audience && typeof audience === 'object' && 'documentId' in audience ? buildAccessGroupsDocumentRow(audience) : audience;
  if (!row || typeof row !== 'object' || !row.kind) return null;
  const loc = accessGroupsLocale(locale);
  const t = (key, vars) => accessGroupsLabel(key, loc, vars);
  const view = { kind: row.kind, restricted: row.kind !== 'everyone', badge: null, text: '', groups: [], peopleCount: 0, peopleText: null, reason: null, action: null, summary: '' };
  if (row.kind === 'everyone') {
    view.text = t('audience.everyone');
    view.action = row.connectorManaged ? null : 'editAccess';
  } else if (row.kind === 'groups') {
    view.groups = row.groups.map((g) => g.name);
    view.badge = t('badge.restricted');
    view.text = t('audience.groups', { groups: accessGroupsJoinNames(view.groups, loc) });
    view.peopleCount = row.peopleCount > 0 ? row.peopleCount : 0;
    if (view.peopleCount) view.peopleText = t('audience.people', { count: accessGroupsUiLib().ragUiFormatNumber(view.peopleCount, loc) });
    view.action = row.connectorManaged ? null : 'editAccess';
  } else {
    view.badge = t('audience.uploaderOnly');
    view.text = t('audience.uploaderOnly');
    const code = accessGroupsText(row.fallbackReason);
    if (code && ACCESS_GROUPS_KNOWN_REASONS.has(code)) view.reason = { code, known: true, template: t('reason.' + code), text: t('reason.' + code) };
    else if (code) view.reason = { code, known: false, template: t('reason.other'), text: t('reason.other', { code }) };
    view.action = row.connectorManaged || ACCESS_GROUPS_SOURCE_REASONS.has(code) ? 'openMapping' : 'editAccess';
  }
  const parts = [view.text];
  if (view.peopleText) parts.push(view.peopleText);
  view.summary = parts.join(loc === 'zh' ? '；' : '; ');
  if (view.reason) view.summary += ' ' + view.reason.text;
  return view;
}

/** UI-SPEC 6.2.1: the only Config UI renderer of an audience view. Every string is text; an unknown reason code is a code element. */
function AccessGroupsAudienceLine(doc, view, extraClass) {
  const ui = accessGroupsUiLib();
  const el = (tag, options, children) => ui.ragUiEl(doc, tag, options, children);
  const root = el('span', { className: 'block min-w-0 text-sm' + (extraClass ? ' ' + extraClass : ''), attrs: { 'data-access-groups-audience': view.kind } });
  if (view.kind === 'everyone') {
    root.appendChild(el('span', { className: 'break-words', text: view.text }));
    return root;
  }
  if (view.kind === 'groups') {
    root.appendChild(el('span', { className: 'badge badge-outline badge-sm gap-1 h-auto whitespace-normal mr-1 align-middle' }, [ui.ragUiIcon(doc, 'lock'), el('span', { text: view.badge })]));
    root.appendChild(el('span', { className: 'break-words', text: view.text }));
    if (view.peopleText) root.appendChild(el('span', { className: 'block text-xs text-base-content/70 break-words', text: view.peopleText }));
    return root;
  }
  root.appendChild(el('span', { className: 'badge badge-warning badge-outline badge-sm gap-1 h-auto whitespace-normal align-middle text-base-content' }, [ui.ragUiIcon(doc, 'shield-exclamation', 'text-warning'), el('span', { text: view.badge })]));
  if (view.reason) {
    const nodes = view.reason.known ? [doc.createTextNode(view.reason.text)] : ui.ragUiTemplateNodes(doc, view.reason.template, { code: view.reason.code }, ['code']);
    root.appendChild(el('span', { className: 'block text-xs mt-1 break-words', attrs: { 'data-access-groups-reason': view.reason.known ? view.reason.code : 'other' } }, nodes));
  }
  return root;
}

/** One key per distinct audience, so a bulk selection knows whether its documents share one (UI-SPEC 6.2.2 Bulk). */
function accessGroupsAudienceKey(row) {
  if (!row) return '';
  if (row.kind === 'groups') return 'groups:' + row.groups.map((g) => g.id).sort().join(',');
  return row.kind;
}

/**
 * UI-SPEC 6.2.2: the field's starting value. One shared audience pre-chooses its radio (uploader_only chooses none); documents with
 * different audiences choose none and are mixed.
 */
function accessGroupsInitialChoice(rows) {
  const list = (rows || []).filter(Boolean);
  const keys = new Set(list.map(accessGroupsAudienceKey));
  if (list.length === 0) return { choice: null, chips: [], mixed: false };
  if (keys.size > 1) return { choice: null, chips: [], mixed: true };
  const first = list[0];
  if (first.kind === 'everyone') return { choice: 'everyone', chips: [], mixed: false };
  if (first.kind === 'groups') return { choice: 'groups', chips: first.groups.map((g) => g.id), mixed: false };
  return { choice: null, chips: [], mixed: false };
}

/** D-02, UI-SPEC 6.2.2, 7.2: the field's rules. It can be saved only with Everyone or at least one chip. */
function accessGroupsFieldFindings(state) {
  const s = state || {};
  const chips = Array.isArray(s.chips) ? s.chips : [];
  const groupCount = Number(s.groupCount) || 0;
  const choice = s.choice === 'everyone' || (s.choice === 'groups' && groupCount + chips.length > 0) ? s.choice : null;
  const needGroup = choice === 'groups' && chips.length === 0;
  return {
    choice,
    canSave: choice === 'everyone' || (choice === 'groups' && chips.length > 0),
    needGroup,
    noGroups: groupCount === 0,
    widen: choice === 'everyone' && s.restrictedNow === true,
    widenKey: s.many ? 'field.widenMany' : 'field.widen',
    reasonKey: needGroup ? 'field.needGroup' : choice ? null : s.mixed ? 'field.mixed' : 'field.choose',
  };
}

/** D-06, D-17: the PUT documents/access body. Document ids and either everyone or group ids; nothing else, never a key. */
function accessGroupsAccessBody(documentIds, choice, chips) {
  const ids = (documentIds || []).map(accessGroupsText).filter(Boolean);
  if (ids.length === 0) return null;
  if (choice === 'everyone') return { documentIds: ids, everyone: true };
  const groupIds = [...new Set((chips || []).map(accessGroupsText).filter(Boolean))];
  if (choice === 'groups' && groupIds.length > 0) return { documentIds: ids, groupIds };
  return null;
}

/** The Source column: the Ingestion panel's source labels when that panel is loaded, else the stored value. */
function accessGroupsSourceLabel(source, locale) {
  const text = accessGroupsText(source);
  if (!text) return '';
  const lookup = typeof window !== 'undefined' && typeof window.ingestionLabel === 'function' ? window.ingestionLabel : null;
  const label = lookup ? lookup('source.' + text, locale) : '';
  return label && label !== 'source.' + text ? String(label) : text;
}

// Connector mapping and sharing rules (D-20, D-21, UI-SPEC 6.5)

const ACCESS_GROUPS_PROVIDERS = ['google-drive', 'dropbox', 'notion'];
/** Fallback product names, as in the provider configuration (src/lib/nango/types.ts); never translated. */
const ACCESS_GROUPS_PROVIDER_NAMES = { 'google-drive': 'Google Drive', dropbox: 'Dropbox', notion: 'Notion' };
/** The kind a mapping created by hand gets: Notion maps through the whole workspace (D-21). */
const ACCESS_GROUPS_PROVIDER_KIND = { 'google-drive': 'group', dropbox: 'team', notion: 'workspace' };
const ACCESS_GROUPS_MAP_KINDS = new Set(['group', 'team', 'workspace']);
const ACCESS_GROUPS_RULE_KINDS = new Set(['domain', 'anyone', 'public']);
const ACCESS_GROUPS_DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The product name from the Connectors tab's provider configuration, else the known name, else the stored value. */
function accessGroupsProviderName(provider) {
  const id = accessGroupsText(provider);
  const config = typeof window !== 'undefined' && window.connectorsConfig && window.connectorsConfig.config ? window.connectorsConfig.config : null;
  const list = config && Array.isArray(config.providers) ? config.providers : [];
  const found = list.find((p) => p && p.provider === id);
  const label = found && typeof found.button_label === 'string' ? found.button_label.trim() : '';
  return label || ACCESS_GROUPS_PROVIDER_NAMES[id] || id;
}

/** One row of GET connector-map: the source id exactly as given (trimmed by the server only), never a name. */
function buildAccessGroupsMappingRow(row) {
  if (!row || typeof row !== 'object') return null;
  const provider = typeof row.provider === 'string' ? row.provider : '';
  const principal = typeof row.externalPrincipalId === 'string' ? row.externalPrincipalId : '';
  if (!provider || !principal) return null;
  const id = typeof row.id === 'string' && row.id ? row.id : null;
  const kind = accessGroupsText(row.kind);
  const groupId = typeof row.groupId === 'string' && row.groupId ? row.groupId : null;
  return {
    key: id ? 'm:' + id : 's:' + provider + ':' + kind + ':' + principal,
    id,
    provider,
    kind,
    principal,
    groupId,
    documents: accessGroupsCount(row.documents),
    mapped: Boolean(id && groupId),
  };
}

/** The GET connector-map answer: unmapped rows first (stable), the paging offset and whether mapping changes visibility. */
function buildAccessGroupsMappingList(body) {
  const b = body && typeof body === 'object' ? body : {};
  const rows = (Array.isArray(b.rows) ? b.rows : []).map(buildAccessGroupsMappingRow).filter(Boolean);
  const ordered = [...rows.filter((r) => !r.mapped), ...rows.filter((r) => r.mapped)];
  const next = Number(b.nextOffset);
  return {
    personal: b.personal === true,
    visibilityApplies: b.visibilityApplies !== false,
    rows: ordered,
    total: accessGroupsCount(b.total),
    nextOffset: b.nextOffset !== null && b.nextOffset !== undefined && Number.isInteger(next) && next >= 0 ? next : null,
  };
}

function accessGroupsMappingKindLabel(row, locale) {
  const kind = accessGroupsText(row && row.kind);
  return ACCESS_GROUPS_MAP_KINDS.has(kind) ? accessGroupsLabel('mapping.kind.' + kind, locale) : kind;
}

/** What Save mapping does for the select's value: create, change, remove or nothing. */
function accessGroupsMappingAction(row, selected) {
  const value = accessGroupsText(selected);
  if (!row) return 'none';
  if (!row.mapped) return value ? 'create' : 'none';
  if (!value) return 'remove';
  return value === row.groupId ? 'none' : 'change';
}

function buildAccessGroupsRuleRow(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const id = typeof rule.id === 'string' ? rule.id : '';
  const provider = typeof rule.provider === 'string' ? rule.provider : '';
  const kind = accessGroupsText(rule.kind);
  if (!id || !provider || !ACCESS_GROUPS_RULE_KINDS.has(kind)) return null;
  const domain = typeof rule.domain === 'string' && rule.domain ? rule.domain : null;
  if (kind === 'domain' && !domain) return null;
  return { id, provider, kind, domain, enabled: rule.enabled === true, documents: accessGroupsCount(rule.documents) };
}

function buildAccessGroupsRulesList(body) {
  const b = body && typeof body === 'object' ? body : {};
  return { personal: b.personal === true, rows: (Array.isArray(b.rules) ? b.rules : []).map(buildAccessGroupsRuleRow).filter(Boolean) };
}

/** The rule as text (accessible names and messages); the table cell renders {domain} as a code element. */
function accessGroupsRuleText(rule, locale) {
  const kind = accessGroupsText(rule && rule.kind);
  if (kind === 'domain') return accessGroupsLabel('rules.kind.domain', locale, { domain: accessGroupsText(rule.domain) });
  return ACCESS_GROUPS_RULE_KINDS.has(kind) ? accessGroupsLabel('rules.kind.' + kind, locale) : kind;
}

/** A host name with at least one dot and no scheme, path, port, wildcard or space (the server's own rule); else null. */
function accessGroupsNormalizeDomain(value) {
  const text = accessGroupsText(value).trim().toLowerCase();
  if (!text || text.length > 253 || !ACCESS_GROUPS_DOMAIN_RE.test(text)) return null;
  return text;
}

/** The New mapping form: the fields still missing, in screen order. */
function accessGroupsMappingFindings(form) {
  const f = form || {};
  const missing = [];
  if (!ACCESS_GROUPS_PROVIDERS.includes(accessGroupsText(f.provider))) missing.push('provider');
  if (!accessGroupsText(f.principal).trim()) missing.push('principal');
  if (!accessGroupsText(f.groupId)) missing.push('groupId');
  return { missing, valid: missing.length === 0 };
}

/**
 * UI-SPEC 6.2.2, 9.3: the audience field (the signature element). Two radios in a fieldset, a chip row with Add group under the
 * second, the findings line wired to every bound save button, field.widen, field.mixed and a polite live region for chips.
 */
class AccessGroupsAudienceField {
  constructor(panel, options) {
    const o = options || {};
    this.panel = panel;
    this.doc = panel.doc;
    this.groups = Array.isArray(o.groups) ? o.groups : [];
    this.names = new Map();
    for (const g of o.known || []) this.names.set(g.id, g.name);
    this.choice = o.choice || null;
    this.chips = [...(o.chips || [])];
    this.mixed = Boolean(o.mixed);
    this.restrictedNow = Boolean(o.restrictedNow);
    this.many = Boolean(o.many);
    this.mode = o.mode === 'org' ? 'org' : 'single';
    this.saveButtons = [];
    this.menuOpen = false;
    this.build();
    this.update();
  }

  t(key, vars) {
    return this.panel.t(key, vars);
  }

  el(tag, options, children) {
    return this.panel.el(tag, options, children);
  }

  nameOf(id) {
    const g = this.groups.find((x) => x.id === id);
    return g ? g.name : this.names.get(id) || id;
  }

  orderedChips() {
    const chosen = new Set(this.chips);
    const ordered = this.groups.filter((g) => chosen.has(g.id)).map((g) => g.id);
    for (const id of this.chips) if (!ordered.includes(id)) ordered.push(id);
    return ordered;
  }

  build() {
    const ui = accessGroupsUiLib();
    const id = (p) => ui.ragUiNextId('rag-access-groups-field-' + p);
    const name = id('choice');
    this.ids = { everyoneHelp: id('everyone-help'), groupsHelp: id('groups-help'), groupsLabel: id('groups-label'), findings: id('findings'), mixed: id('mixed'), choose: id('choose') };
    const radio = (value, helpId) => {
      const input = this.el('input', { className: 'radio radio-sm mt-0.5', id: id(value), attrs: { type: 'radio', name, value, 'aria-describedby': helpId, 'data-access-groups-choice': value } });
      input.addEventListener('change', () => {
        if (input.checked) this.choose(value);
      });
      return input;
    };
    this.everyoneRadio = radio('everyone', this.ids.everyoneHelp);
    this.groupsRadio = radio('groups', this.ids.groupsHelp);
    const option = (input, labelId, label, helpNode) =>
      this.el('label', { className: 'flex items-start gap-3 min-w-0 cursor-pointer has-[:disabled]:cursor-not-allowed', attrs: { for: input.id } }, [
        input,
        this.el('span', { className: 'min-w-0' }, [this.el('span', { className: 'block text-sm font-medium', id: labelId, text: label }), helpNode]),
      ]);
    this.everyoneHelp = this.el('span', { className: 'block text-xs text-base-content/70 break-words', id: this.ids.everyoneHelp, text: this.t('field.everyoneHelp.' + this.mode) });
    this.groupsHelp = this.el('span', { className: 'block text-xs text-base-content/70 break-words', id: this.ids.groupsHelp });
    this.chipList = this.el('ul', { className: 'flex flex-wrap gap-2 min-w-0', attrs: { role: 'list', 'aria-labelledby': this.ids.groupsLabel, 'data-access-groups-chips': '' } });
    this.addHost = this.el('div', { className: 'min-w-0' });
    this.findings = this.el('p', { className: 'text-xs text-base-content/70 mt-2 break-words', id: this.ids.findings, text: this.t('field.needGroup'), attrs: { 'data-access-groups-findings': '' } });
    this.chipArea = this.el('div', { className: 'ml-7 mt-2 min-w-0', attrs: { 'data-access-groups-chip-area': '' } }, [
      this.el('div', { className: 'flex flex-wrap items-start gap-2 min-w-0' }, [this.chipList, this.addHost]),
      this.findings,
    ]);
    this.mixedLine = this.el('p', { className: 'text-sm mb-2 break-words max-w-prose', id: this.ids.mixed, text: this.t('field.mixed'), attrs: { 'data-access-groups-mixed': '' } });
    this.chooseLine = this.el('p', { className: 'sr-only', id: this.ids.choose, text: this.t('field.choose') });
    this.widenLine = this.el('p', { className: 'text-sm flex items-start gap-2 mt-2 break-words max-w-prose', attrs: { 'data-access-groups-widen': '' } }, [
      accessGroupsUiLib().ragUiIcon(this.doc, 'exclamation-triangle', 'mt-0.5 text-warning'),
      this.el('span', { className: 'min-w-0', text: this.t(this.many ? 'field.widenMany' : 'field.widen') }),
    ]);
    this.live = this.el('span', { className: 'sr-only', attrs: { 'aria-live': 'polite', 'data-access-groups-chip-live': '' } });
    this.element = this.el('fieldset', { className: 'min-w-0 grid gap-3', attrs: { 'data-access-groups-field': '' } }, [
      this.el('legend', { className: 'text-sm font-semibold mb-2', text: this.t('audience.label') }),
      this.mixedLine,
      this.chooseLine,
      option(this.everyoneRadio, null, this.t('term.everyone'), this.everyoneHelp),
      this.el('div', { className: 'min-w-0' }, [option(this.groupsRadio, this.ids.groupsLabel, this.t('field.onlyGroups'), this.groupsHelp), this.chipArea]),
      this.widenLine,
      this.el('p', { className: 'text-xs text-base-content/70', text: this.t('field.effect') }),
      this.live,
    ]);
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.menu && this.menu.open) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        this.menuOpen = false;
        this.menu.open = false;
        if (this.menuSummary) this.menuSummary.focus();
      }
    });
  }

  choose(value) {
    this.choice = value === 'groups' ? 'groups' : 'everyone';
    this.update();
  }

  state() {
    return accessGroupsFieldFindings({ choice: this.choice, chips: this.chips, groupCount: this.groups.length, restrictedNow: this.restrictedNow, many: this.many, mixed: this.mixed });
  }

  value() {
    const s = this.state();
    return { choice: s.choice, chips: s.choice === 'groups' ? this.orderedChips() : [] };
  }

  bindSave(button) {
    this.saveButtons.push(button);
    this.update();
  }

  setGroups(groups) {
    this.groups = Array.isArray(groups) ? groups : [];
    const present = new Set(this.groups.map((g) => g.id));
    this.chips = this.chips.filter((id) => present.has(id));
    this.update();
  }

  addChip(id) {
    if (this.chips.includes(id)) return;
    this.chips.push(id);
    this.menuOpen = true;
    this.update();
    this.live.textContent = this.t('chip.added', { group: this.nameOf(id) });
    const next = this.menuButtons && this.menuButtons[0];
    if (next) next.focus();
    else if (this.removeButtons.length) this.removeButtons[this.removeButtons.length - 1].focus();
  }

  removeChip(id) {
    const ordered = this.orderedChips();
    const index = ordered.indexOf(id);
    if (index < 0) return;
    this.chips = this.chips.filter((c) => c !== id);
    this.update();
    this.live.textContent = this.t('chip.removed', { group: this.nameOf(id) });
    const next = this.removeButtons[index] || null;
    if (next) next.focus();
    else if (this.addControl) this.addControl.focus();
  }

  renderChips() {
    const ui = accessGroupsUiLib();
    this.removeButtons = [];
    const items = this.orderedChips().map((id) => {
      const name = this.nameOf(id);
      const remove = this.el('button', {
        className: 'btn btn-ghost btn-xs btn-circle h-6 w-6 min-h-6 shrink-0',
        attrs: { type: 'button', 'aria-label': this.t('action.removeGroupChip', { group: name }), 'data-access-groups-chip-remove': id },
      }, [ui.ragUiIcon(this.doc, 'x-lg')]);
      remove.addEventListener('click', () => this.removeChip(id));
      this.removeButtons.push(remove);
      return this.el('li', { className: 'inline-flex items-center gap-1 max-w-full min-w-0 rounded-full border border-base-content/30 pl-3 pr-1 py-0.5 text-sm', attrs: { 'data-access-groups-chip': id } }, [
        this.el('span', { className: 'min-w-0 break-words', text: name }),
        remove,
      ]);
    });
    this.chipList.replaceChildren(...items);
    this.chipList.hidden = items.length === 0;
    const remaining = this.groups.filter((g) => !this.chips.includes(g.id));
    this.menuButtons = [];
    this.menu = null;
    this.menuSummary = null;
    if (remaining.length === 0) {
      this.addControl = this.el('button', { className: 'btn btn-outline btn-sm min-h-8 h-auto py-1', text: this.t('action.addGroup'), attrs: { type: 'button', 'aria-describedby': this.groups.length ? null : this.ids.groupsHelp, 'data-access-groups-add-group': '' } });
      this.addControl.disabled = true;
      this.addHost.replaceChildren(this.addControl);
      return;
    }
    const list = this.el('ul', { className: 'menu dropdown-content z-10 mt-1 w-64 max-w-[calc(100vw-2rem)] max-h-72 overflow-y-auto flex-nowrap rounded-box bg-base-100 p-1 shadow', attrs: { 'data-access-groups-add-menu': '' } });
    for (const g of remaining) {
      const b = this.el('button', { className: 'text-left break-words whitespace-normal', text: g.name, attrs: { type: 'button', 'data-access-groups-add-option': g.id } });
      b.addEventListener('click', () => this.addChip(g.id));
      this.menuButtons.push(b);
      list.appendChild(this.el('li', { className: 'min-w-0' }, [b]));
    }
    this.menuSummary = this.el('summary', {
      className: 'btn btn-outline btn-sm min-h-8 h-auto py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
      attrs: { 'data-access-groups-add-group': '' },
    }, [this.el('span', { text: this.t('action.addGroup') }), ui.ragUiIcon(this.doc, 'chevron-down')]);
    this.menu = this.el('details', { className: 'dropdown' }, [this.menuSummary, list]);
    this.menu.open = this.menuOpen;
    this.menu.addEventListener('toggle', () => {
      this.menuOpen = Boolean(this.menu && this.menu.open);
    });
    this.addControl = this.menuSummary;
    this.addHost.replaceChildren(this.menu);
  }

  update() {
    const s = this.state();
    const noGroups = s.noGroups && this.chips.length === 0;
    this.groupsRadio.disabled = noGroups;
    this.groupsHelp.textContent = noGroups ? this.t('field.noGroups') : this.t('field.onlyGroupsHelp');
    this.everyoneRadio.checked = s.choice === 'everyone';
    this.groupsRadio.checked = s.choice === 'groups';
    this.mixedLine.hidden = !(this.mixed && !s.choice);
    this.chooseLine.hidden = Boolean(s.choice) || this.mixed;
    this.chipArea.hidden = s.choice !== 'groups';
    this.findings.hidden = !s.needGroup;
    this.widenLine.hidden = !s.widen;
    this.renderChips();
    const reasonId = s.reasonKey === 'field.needGroup' ? this.ids.findings : s.reasonKey === 'field.mixed' ? this.ids.mixed : s.reasonKey === 'field.choose' ? this.ids.choose : null;
    for (const button of this.saveButtons) {
      if (button.getAttribute('aria-disabled') === 'true') continue;
      button.disabled = !s.canSave;
      if (reasonId) button.setAttribute('aria-describedby', reasonId);
      else button.removeAttribute('aria-describedby');
    }
  }

  focusFirst() {
    const target = this.groupsRadio.checked ? this.groupsRadio : this.everyoneRadio;
    target.focus();
  }
}

class AccessGroupsPanel {
  constructor(root) {
    this.root = root;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.locale = accessGroupsLocale();
    this.tabs = null;
    this.status = null;
    this.statusFailure = null;
    this.statusLoaded = false;
    this.statusSeq = 0;
    this.drift = null;
    this.driftFailure = null;
    this.driftRunning = false;
    this.syncFailed = false;
    this.restartNeeded = false;
    this.lastSaved = null;
    this.hosts = {};
    this.organizationId = null;
    this.workspaceBound = false;
    this.groups = null;
    this.groupsFailure = null;
    this.groupsSeq = 0;
    this.groupsUpdatedAt = null;
    this.groupHosts = {};
    this.form = this.emptyForm();
    this.formHosts = null;
    this.renaming = null;
    this.members = null;
    this.membersRegion = null;
    this.memberHosts = null;
    this.deleting = null;
    this.moreButton = null;
    this.docs = null;
    this.docsFailure = null;
    this.docsSeq = 0;
    this.docsRequested = false;
    this.docsUpdatedAt = null;
    this.docFilter = 'restricted';
    this.docQuery = '';
    this.docSearchTimer = null;
    this.docHosts = {};
    this.docSelected = new Map();
    this.docEditor = null;
    this.bulk = null;
    this.docsMoreButton = null;
    this.mapping = null;
    this.mappingFailure = null;
    this.mappingSeq = 0;
    this.mappingRequested = false;
    this.mappingUpdatedAt = null;
    this.mappingHosts = {};
    this.mappingDraft = new Map();
    this.mappingBusy = null;
    this.mappingMoreButton = null;
    this.mapForm = this.emptyMapForm();
    this.mapFormHosts = null;
    this.rules = null;
    this.rulesFailure = null;
    this.rulesSeq = 0;
    this.rulesShown = ACCESS_GROUPS_PAGE;
    this.ruleBusy = null;
    this.ruleForm = this.emptyRuleForm();
    this.ruleFormHosts = null;
    this.unmappedFromList = 0;
  }

  t(key, vars) {
    return accessGroupsLabel(key, this.locale, vars);
  }

  el(tag, options, children) {
    return accessGroupsUiLib().ragUiEl(this.doc, tag, options, children);
  }

  statusEl() {
    return this.root.querySelector('[data-access-groups-status]');
  }

  announce(text, isError) {
    const host = this.statusEl();
    if (!host) return;
    host.classList.toggle('text-error', Boolean(isError));
    if (isError) host.replaceChildren(accessGroupsUiLib().ragUiIcon(this.doc, 'exclamation-circle', 'mr-1'), this.el('span', { text }));
    else host.textContent = text;
  }

  controlValue(id) {
    const control = this.doc.getElementById(id);
    return control ? accessGroupsText(control.value) : '';
  }

  /** The saved setting: the page's last loaded or saved config, else the select's value (A-03). */
  savedValue() {
    const manager = typeof window !== 'undefined' ? window.configManager : null;
    const saved = manager && manager.savedConfig && typeof manager.savedConfig === 'object' ? manager.savedConfig : null;
    if (saved && Object.prototype.hasOwnProperty.call(saved, ACCESS_GROUPS_SWITCH_ID)) return accessGroupsText(saved[ACCESS_GROUPS_SWITCH_ID]) || 'off';
    return this.controlValue(ACCESS_GROUPS_SWITCH_ID) || 'off';
  }

  view() {
    return buildAccessGroupsEnforcementView(this.savedValue(), this.statusLoaded ? this.status : null);
  }

  async mount() {
    const ui = accessGroupsUiLib();
    this.root.setAttribute('lang', this.locale);
    const title = this.root.querySelector('[data-access-groups-title]');
    if (title) title.textContent = this.t('panel.title');
    const description = this.root.querySelector('[data-access-groups-description]');
    if (description) description.textContent = this.t('panel.description');
    this.tabs = ui.ragUiSubTabs(this.doc, {
      label: this.t('panel.tabsLabel'),
      idPrefix: 'rag-access-groups',
      tabs: [
        { id: 'groups', label: this.t('tab.groupsPlain') },
        { id: 'documents', label: this.t('tab.documents') },
        { id: 'mapping', label: this.t('tab.mapping') },
        { id: 'enforcement', label: this.t('tab.enforcement') },
      ],
      selected: 'groups',
      onSelect: (id) => this.onTabSelect(id),
    });
    this.buildGroups(this.tabs.panels.groups);
    this.buildDocuments(this.tabs.panels.documents);
    this.buildMapping(this.tabs.panels.mapping);
    this.buildEnforcement(this.tabs.panels.enforcement);
    const content = this.root.querySelector('[data-access-groups-content]');
    if (content) content.replaceChildren(this.tabs.tablist, ...Object.values(this.tabs.panels));
    this.lastSaved = this.savedSnapshot();
    if (this.doc && typeof this.doc.addEventListener === 'function') {
      this.doc.addEventListener('rag:config-saved', (event) => this.onConfigSaved(event && event.detail));
    }
    this.readWorkspace();
    this.bindWorkspace();
    this.renderAll();
    await this.loadGroups('first');
    await this.loadStatus('first');
  }

  async refresh() {
    this.readWorkspace();
    this.bindWorkspace();
    await this.loadGroups('refresh');
    if (this.docsRequested) await this.loadDocuments('refresh');
    if (this.mappingRequested) await Promise.all([this.loadMapping('refresh'), this.loadRules('quiet')]);
    await this.loadStatus('refresh');
  }

  selectEnforcement() {
    if (!this.tabs) return;
    this.tabs.select('enforcement');
    const tab = this.doc.getElementById('rag-access-groups-tab-enforcement');
    if (tab && typeof tab.focus === 'function') tab.focus();
  }

  buildEnforcement(panel) {
    const h4 = (text) => this.el('h4', { className: 'text-base font-semibold mb-2 text-balance', text });
    this.hosts.state = this.el('div', { className: 'min-w-0', attrs: { 'data-access-groups-state': '' } });
    this.hosts.syncAlert = this.el('div', { className: 'empty:hidden mt-4', attrs: { 'data-access-groups-sync-alert': '' } });
    const stateBlock = this.el('div', { className: 'min-w-0' }, [
      h4(this.t('enforce.title')),
      this.el('p', { className: 'text-sm text-base-content/70 mb-4 max-w-prose', text: this.t('enforce.scope') }),
      this.hosts.state,
      this.hosts.syncAlert,
    ]);

    this.hosts.settings = this.el('div', { className: 'min-w-0', attrs: { 'data-access-groups-settings': '' } });
    const group = this.doc.querySelector('[data-rag-settings-group="access"]');
    const embedInput = this.doc.getElementById(ACCESS_GROUPS_EMBED_ID);
    const switchControl = this.doc.getElementById(ACCESS_GROUPS_SWITCH_ID);
    if (group) {
      this.hosts.settings.appendChild(group);
      this.localizeSettings(group);
    }
    this.hosts.embedCheck = this.el('p', { className: 'text-xs break-words max-w-prose empty:hidden', id: 'rag-access-groups-embed-check', attrs: { 'aria-live': 'polite' } });
    this.hosts.embedWarn = this.el('div', { className: 'empty:hidden mt-2', id: 'rag-access-groups-embed-warn' });
    this.hosts.restart = this.el('p', { className: 'text-xs text-base-content/70 mt-2 empty:hidden', attrs: { 'data-access-groups-restart': '' } });
    const embedField = embedInput && embedInput.parentNode ? embedInput.parentNode : null;
    if (embedField && typeof embedField.appendChild === 'function') embedField.appendChild(this.hosts.embedCheck);
    else this.hosts.settings.appendChild(this.hosts.embedCheck);
    this.hosts.settings.appendChild(this.hosts.embedWarn);
    this.hosts.settings.appendChild(this.hosts.restart);
    if (embedInput) {
      const described = accessGroupsText(embedInput.getAttribute('aria-describedby')).split(/\s+/).filter(Boolean);
      for (const id of ['rag-access-groups-embed-check', 'rag-access-groups-embed-warn']) if (!described.includes(id)) described.push(id);
      embedInput.setAttribute('aria-describedby', described.join(' '));
      embedInput.addEventListener('input', () => this.renderSettings());
      embedInput.addEventListener('change', () => this.renderSettings());
    }
    if (switchControl) switchControl.addEventListener('change', () => this.renderSettings());
    const settingsBlock = this.el('div', { className: 'min-w-0 mt-6' }, [h4(this.t('settings.title')), this.hosts.settings]);

    this.hosts.drift = this.el('div', { className: 'min-w-0 mt-4', attrs: { 'data-access-groups-drift': '' } });
    this.driftButton = this.el('button', {
      className: 'btn btn-outline btn-sm h-auto min-h-8 py-1 whitespace-normal',
      text: this.t('action.runDrift'),
      attrs: { type: 'button', 'data-access-groups-run-drift': '' },
    });
    this.driftButton.addEventListener('click', () => this.runDrift());
    const driftBlock = this.el('div', { className: 'min-w-0 mt-6' }, [
      h4(this.t('drift.title')),
      this.el('div', { className: 'flex flex-wrap items-start gap-2' }, [
        this.el('p', { className: 'text-sm max-w-prose flex-1 basis-64', text: this.t('drift.body') }),
        this.driftButton,
      ]),
      this.hosts.drift,
    ]);
    panel.replaceChildren(stateBlock, settingsBlock, driftBlock);
  }

  /** zh and it through data-rag-i18n; English is the static markup (UI-SPEC 12.5). */
  localizeSettings(group) {
    if (this.locale === 'en') return;
    const table = ACCESS_GROUPS_LABELS[this.locale] || {};
    for (const node of Array.from(group.querySelectorAll('[data-rag-i18n]'))) {
      const text = table[node.getAttribute('data-rag-i18n')];
      if (text !== undefined) node.textContent = text;
    }
  }

  savedSnapshot() {
    const manager = typeof window !== 'undefined' ? window.configManager : null;
    const saved = manager && manager.savedConfig && typeof manager.savedConfig === 'object' ? manager.savedConfig : null;
    const pick = (id) => (saved && Object.prototype.hasOwnProperty.call(saved, id) ? accessGroupsText(saved[id]) : this.controlValue(id));
    return { [ACCESS_GROUPS_SWITCH_ID]: pick(ACCESS_GROUPS_SWITCH_ID), [ACCESS_GROUPS_EMBED_ID]: pick(ACCESS_GROUPS_EMBED_ID) };
  }

  /** After Save All Changes: settings.restart when either value changed, and the state uses the new saved setting. */
  onConfigSaved(detail) {
    const config = detail && detail.config && typeof detail.config === 'object' ? detail.config : null;
    const next = config
      ? {
          [ACCESS_GROUPS_SWITCH_ID]: accessGroupsText(config[ACCESS_GROUPS_SWITCH_ID]),
          [ACCESS_GROUPS_EMBED_ID]: accessGroupsText(config[ACCESS_GROUPS_EMBED_ID]),
        }
      : this.savedSnapshot();
    const before = this.lastSaved || {};
    if (before[ACCESS_GROUPS_SWITCH_ID] !== next[ACCESS_GROUPS_SWITCH_ID] || before[ACCESS_GROUPS_EMBED_ID] !== next[ACCESS_GROUPS_EMBED_ID]) {
      this.restartNeeded = true;
    }
    this.lastSaved = next;
    this.renderAll();
  }

  renderAll() {
    this.renderState();
    this.renderSettings();
    this.renderAlerts();
  }

  formatTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return accessGroupsText(value);
    try {
      return new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  timeEl(value) {
    const date = new Date(value);
    const valid = !Number.isNaN(date.getTime());
    return this.el('time', { text: this.formatTime(value), attrs: { datetime: valid ? date.toISOString() : null } });
  }

  switchWord(value) {
    if (value === 'on') return this.t('value.on');
    if (value === 'off') return this.t('value.off');
    return this.t('value.none');
  }

  databaseWord(value) {
    if (value === true) return this.t('value.enforced');
    if (value === false) return this.t('value.notEnforced');
    return this.t('value.none');
  }

  badge(state, busy) {
    const ui = accessGroupsUiLib();
    const spec = ACCESS_GROUPS_STATES[state] || ACCESS_GROUPS_STATES.unknown;
    const word = this.t('enforce.state.' + state);
    const lead = busy
      ? this.el('span', { className: 'loading loading-spinner loading-xs motion-reduce:hidden', attrs: { 'aria-hidden': 'true' } })
      : ui.ragUiIcon(this.doc, spec.icon);
    return this.el(
      'span',
      { className: 'badge badge-sm ' + spec.badge + ' gap-1 h-auto min-h-5 py-0.5 shrink-0 whitespace-normal text-left', attrs: { 'data-access-groups-badge': state } },
      [lead, this.el('span', { text: word })],
    );
  }

  stateSentence(view) {
    const vars = {
      saved: this.switchWord(view.saved),
      running: this.switchWord(view.running),
      database: this.databaseWord(view.database),
    };
    return this.el('p', { className: 'text-sm max-w-prose min-w-0 break-words', text: this.t('enforce.sentence.' + view.state, vars) });
  }

  valuesList(view) {
    const item = (label, value) =>
      this.el('div', { className: 'min-w-0' }, [
        this.el('dt', { className: 'text-xs text-base-content/70', text: label }),
        this.el('dd', { className: 'text-sm break-words' }, [typeof value === 'string' ? this.el('span', { text: value }) : value]),
      ]);
    return this.el('dl', { className: 'flex flex-wrap gap-x-6 gap-y-2 mt-4', attrs: { 'aria-label': this.t('enforce.dlLabel') } }, [
      item(this.t('enforce.dl.saved'), this.switchWord(view.saved)),
      item(this.t('enforce.dl.running'), this.switchWord(view.running)),
      item(this.t('enforce.dl.database'), this.databaseWord(view.database)),
      item(this.t('enforce.dl.checked'), view.checkedAt ? this.timeEl(view.checkedAt) : this.t('value.none')),
    ]);
  }

  reasonsList(view) {
    const ui = accessGroupsUiLib();
    const items = accessGroupsReasonItems(view);
    if (!items.length) return null;
    const list = this.el('ul', { className: 'list-disc pl-5 mt-4 space-y-1 text-sm max-w-prose', attrs: { 'aria-label': this.t('enforce.reasons') } });
    for (const item of items) {
      const li = this.el('li', { className: 'break-words', attrs: { 'data-access-groups-reason': item.code } });
      const template = this.t(item.key);
      if (item.key === 'blocked.reason.other') li.appendChild(ui.ragUiCodeSentence(this.doc, this.locale, item.code, template));
      else li.append(...ui.ragUiTemplateNodes(this.doc, template, { name: item.name || '—' }, item.name ? ['name'] : []));
      list.appendChild(li);
    }
    return list;
  }

  actionButtons(view) {
    const buttons = [];
    if (view.canSync) {
      const sync = this.el('button', {
        className: 'btn btn-primary btn-sm h-auto min-h-8 py-1 whitespace-normal',
        text: this.t('action.sync'),
        attrs: { type: 'button', 'data-access-groups-sync': '' },
      });
      sync.addEventListener('click', () => this.runSync());
      buttons.push(sync);
    }
    const check = this.el('button', {
      className: 'btn btn-outline btn-sm h-auto min-h-8 py-1 whitespace-normal',
      text: this.t('action.check'),
      attrs: { type: 'button', 'data-access-groups-check': '' },
    });
    check.addEventListener('click', () => this.loadStatus('refresh'));
    buttons.push(check);
    this.actionRow = buttons;
    return this.el('div', { className: 'flex flex-wrap gap-2 mt-4' }, buttons);
  }

  renderState() {
    const host = this.hosts.state;
    if (!host) return;
    const ui = accessGroupsUiLib();
    if (!this.statusLoaded && !this.statusFailure) {
      host.replaceChildren(
        this.el('div', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [this.badge('unknown', true), ui.ragUiSpinner(this.doc, this.t('enforce.checking'))]),
      );
      return;
    }
    const nodes = [];
    if (this.statusFailure && (this.statusFailure.kind === 'signIn' || this.statusFailure.kind === 'workspace')) {
      const view = this.view();
      nodes.push(this.el('div', { className: 'flex flex-wrap items-center gap-2 min-w-0 mb-4' }, [this.badge('unknown'), this.stateSentence(view)]));
      nodes.push(
        this.statusFailure.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, () => this.loadStatus('refresh'))
          : ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [this.statusFailure.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, () => this.loadStatus('refresh'))] }),
      );
      this.actionRow = [];
      host.replaceChildren(...nodes);
      ui.ragUiListBusy(host, false);
      return;
    }
    if (this.statusFailure) {
      nodes.push(ui.ragUiUnavailableAlert(this.doc, this.locale, this.statusFailure.message, () => this.loadStatus('refresh')));
    }
    const view = this.view();
    const shown = this.statusFailure && !this.statusLoaded ? { ...view, state: 'unknown' } : view;
    const body = this.el('div', { className: 'min-w-0', attrs: { 'data-access-groups-state-body': '' } }, [
      this.el('div', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [this.badge(shown.state), this.stateSentence(shown)]),
      this.valuesList(shown),
      shown.state === 'blocked' ? this.reasonsList(shown) : null,
      this.statusFailure && !this.statusLoaded ? null : this.actionButtons(shown),
    ]);
    if (this.statusFailure && this.statusLoaded) body.classList.add('opacity-60');
    nodes.push(body);
    host.replaceChildren(...nodes);
  }

  renderSettings() {
    const ui = accessGroupsUiLib();
    const switchValue = this.controlValue(ACCESS_GROUPS_SWITCH_ID);
    const help = this.doc.getElementById('rag-doc-access-groups-help');
    if (help) {
      const key = 'RAG_DOC_ACCESS_GROUPS.now.' + (accessGroupsSwitchValue(switchValue) === 'on' ? 'on' : 'off');
      help.setAttribute('data-rag-i18n', key);
      help.textContent = this.t(key);
    }
    const embedInput = this.doc.getElementById(ACCESS_GROUPS_EMBED_ID);
    const check = accessGroupsEmbedCheck(this.controlValue(ACCESS_GROUPS_EMBED_ID), switchValue, this.status ? accessGroupsEmbedGroup(this.status.embedGroup) : null);
    if (this.hosts.embedCheck) {
      if (!check.finding) this.hosts.embedCheck.replaceChildren();
      else {
        const tone = check.finding.tone === 'error' ? 'text-error' : check.finding.tone === 'warning' ? 'text-warning' : 'text-success';
        const icon = check.finding.tone === 'success' ? 'check-circle' : 'exclamation-circle';
        this.hosts.embedCheck.className = 'text-xs break-words max-w-prose mt-1 flex items-start gap-1 ' + tone;
        this.hosts.embedCheck.replaceChildren(
          ui.ragUiIcon(this.doc, icon, 'mt-0.5'),
          this.el('span', { className: 'text-base-content', text: this.t(check.finding.key, { group: check.finding.group || '' }) }),
        );
      }
    }
    if (embedInput) {
      if (check.finding && check.finding.tone === 'error') embedInput.setAttribute('aria-invalid', 'true');
      else embedInput.removeAttribute('aria-invalid');
      embedInput.classList.toggle('input-error', Boolean(check.finding && check.finding.tone === 'error'));
    }
    if (this.hosts.embedWarn) {
      this.hosts.embedWarn.replaceChildren(
        ...(check.warn ? [ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'exclamation-triangle', body: [this.t('warn.embedNeedsSwitch')], className: 'py-2' })] : []),
      );
    }
    if (this.hosts.restart) this.hosts.restart.textContent = this.restartNeeded ? this.t('settings.restart') : '';
  }

  renderAlerts() {
    const host = this.root.querySelector('[data-access-groups-alert]');
    if (!host) return;
    const ui = accessGroupsUiLib();
    const view = this.view();
    const open = () => {
      const button = this.el('button', { className: 'btn btn-sm h-auto min-h-8 py-1 whitespace-normal', text: this.t('action.openEnforcement'), attrs: { type: 'button' } });
      button.addEventListener('click', () => this.selectEnforcement());
      return button;
    };
    const nodes = [];
    if (view.state === 'blocked') nodes.push(ui.ragUiAlert(this.doc, { tone: 'error', icon: 'x-octagon', body: [this.t('alert.blocked')], actions: [open()] }));
    else if (this.statusLoaded && view.running === 'off') nodes.push(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('alert.off')], actions: [open()] }));
    const unmapped = this.unmappedCount();
    if (unmapped > 0) {
      const mapping = this.el('button', { className: 'btn btn-sm h-auto min-h-8 py-1 whitespace-normal', text: this.t('action.openMapping'), attrs: { type: 'button', 'data-access-groups-alert-mapping': '' } });
      mapping.addEventListener('click', () => this.selectMapping());
      nodes.push(
        ui.ragUiAlert(this.doc, {
          tone: 'warning',
          icon: 'exclamation-triangle',
          body: [this.t('alert.unmapped', { count: ui.ragUiFormatNumber(unmapped, this.locale) })],
          actions: [mapping],
        }),
      );
    }
    host.replaceChildren(...nodes);
  }

  async loadStatus(source) {
    const ui = accessGroupsUiLib();
    const seq = ++this.statusSeq;
    const host = this.hosts.state;
    const hadContent = this.statusLoaded || Boolean(this.statusFailure);
    let restore = null;
    if (source === 'first' && !hadContent) this.renderState();
    else if (host) {
      ui.ragUiListBusy(host, true);
      const check = host.querySelector('[data-access-groups-check]');
      if (check) restore = ui.ragUiButtonBusy(this.doc, check, this.t('enforce.checking'), this.actionRow);
    }
    let result;
    try {
      result = await ui.ragUiRagRequest(ACCESS_GROUPS_PATH + '/status', { method: 'GET' });
    } finally {
      if (restore && seq === this.statusSeq) restore();
    }
    if (seq !== this.statusSeq) return;
    if (host) ui.ragUiListBusy(host, false);
    this.applyStatusResult(result, false);
  }

  applyStatusResult(result, fromSync) {
    if (result && result.ok && result.body && typeof result.body === 'object' && result.body.status && typeof result.body.status === 'object') {
      this.status = result.body.status;
      this.statusLoaded = true;
      this.statusFailure = null;
      this.syncFailed = false;
      if (this.hosts.syncAlert) this.hosts.syncAlert.replaceChildren();
      this.renderAll();
      if (!fromSync) this.announce(this.t('enforce.checked', { state: this.t('enforce.state.' + this.view().state) }));
      return true;
    }
    const mapped = result && result.ok ? { kind: 'unavailable', message: this.t('enforce.unavailable') } : mapAccessGroupsError(result, this.locale, { unavailable: this.t('enforce.unavailable') });
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.status = null;
      this.statusLoaded = false;
    }
    this.statusFailure = mapped.kind === 'unavailable' || mapped.kind === 'network' ? { ...mapped, message: this.t('enforce.unavailable') } : mapped;
    this.renderAll();
    this.announce(this.statusFailure.message, true);
    return false;
  }

  async runSync() {
    const ui = accessGroupsUiLib();
    const button = this.hosts.state ? this.hosts.state.querySelector('[data-access-groups-sync]') : null;
    const restore = button ? ui.ragUiButtonBusy(this.doc, button, this.t('sync.running'), this.actionRow) : null;
    let result;
    try {
      result = await ui.ragUiRagRequest(ACCESS_GROUPS_PATH + '/status/sync', { method: 'POST' });
    } finally {
      if (restore) restore();
    }
    if (result && result.ok && result.body && typeof result.body === 'object' && result.body.status && typeof result.body.status === 'object') {
      this.applyStatusResult(result, true);
      const view = this.view();
      if (view.reasons.some((r) => ACCESS_GROUPS_FLAG_REASONS.has(r)) || view.state === 'unsynced') {
        this.showSyncFailed();
        return;
      }
      this.announce(this.t('sync.done', { database: this.databaseWord(view.database) }));
      return;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.t('enforce.unavailable') });
    if (mapped.kind === 'signIn' || mapped.kind === 'workspace') {
      this.applyStatusResult(result, true);
      return;
    }
    if (mapped.kind === 'outcomeUnknown' || mapped.kind === 'changed') {
      this.announce(mapped.message, true);
      await this.loadStatus('refresh');
      this.announce(mapped.message, true);
      return;
    }
    this.showSyncFailed();
  }

  showSyncFailed() {
    const ui = accessGroupsUiLib();
    this.syncFailed = true;
    if (this.hosts.syncAlert) {
      this.hosts.syncAlert.replaceChildren(ui.ragUiAlert(this.doc, { tone: 'error', icon: 'x-octagon', body: [this.t('sync.failed')], role: 'alert' }));
    }
  }

  async runDrift() {
    if (this.driftRunning) return;
    const ui = accessGroupsUiLib();
    const host = this.hosts.drift;
    this.driftRunning = true;
    const restore = ui.ragUiButtonBusy(this.doc, this.driftButton, this.t('drift.running'));
    if (host) {
      if (this.drift) ui.ragUiListBusy(host, true);
      else host.replaceChildren(ui.ragUiSpinner(this.doc, this.t('drift.running')));
    }
    let result;
    try {
      result = await ui.ragUiRagRequest(ACCESS_GROUPS_PATH + '/drift', { method: 'POST' });
    } finally {
      this.driftRunning = false;
      restore();
      if (host) ui.ragUiListBusy(host, false);
    }
    if (result && result.ok && result.body && typeof result.body === 'object') {
      this.drift = accessGroupsDriftView(result.body);
      this.driftFailure = null;
      this.renderDrift();
      const text = this.drift.total > 0 ? this.t('drift.found', { count: ui.ragUiFormatNumber(this.drift.total, this.locale) }) : this.driftNoneText();
      this.announce(text);
      return;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { unavailable: this.t('drift.unavailable') });
    this.driftFailure = mapped.kind === 'signIn' ? mapped : { ...mapped, message: this.t('drift.unavailable') };
    this.renderDrift();
    this.announce(this.driftFailure.message, true);
  }

  driftNoneText() {
    return this.t('drift.none', { time: this.drift && this.drift.checkedAt ? this.formatTime(this.drift.checkedAt) : '' });
  }

  renderDrift() {
    const host = this.hosts.drift;
    if (!host) return;
    const ui = accessGroupsUiLib();
    if (this.driftFailure) {
      host.replaceChildren(
        this.driftFailure.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, () => this.runDrift())
          : ui.ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', body: [this.driftFailure.message] }),
      );
      return;
    }
    if (!this.drift) {
      host.replaceChildren();
      return;
    }
    if (this.drift.total === 0) {
      host.replaceChildren(
        this.el('p', { className: 'text-sm flex items-start gap-1 max-w-prose' }, [ui.ragUiIcon(this.doc, 'check-circle', 'mt-0.5 text-success'), this.el('span', { text: this.driftNoneText() })]),
      );
      return;
    }
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('drift.caption') }),
      this.el('thead', {}, [
        this.el('tr', {}, [
          this.el('th', { className: 'font-semibold', text: this.t('drift.col.store'), attrs: { scope: 'col' } }),
          this.el('th', { className: 'font-semibold text-right', text: this.t('drift.col.rows'), attrs: { scope: 'col' } }),
        ]),
      ]),
      this.el(
        'tbody',
        {},
        this.drift.differing.map((row) =>
          this.el('tr', { attrs: { 'data-access-groups-drift-row': '' } }, [
            this.el('th', { className: 'font-normal break-words', attrs: { scope: 'row' } }, [
              row.key ? this.el('span', { text: this.t(row.key) }) : ui.ragUiCodeSentence(this.doc, this.locale, row.store),
            ]),
            this.el('td', { className: 'text-right tabular-nums', text: ui.ragUiFormatNumber(row.rows, this.locale) }),
          ]),
        ),
      ),
    ]);
    host.replaceChildren(
      this.el('p', { className: 'text-sm max-w-prose mb-2 flex items-start gap-1' }, [
        ui.ragUiIcon(this.doc, 'exclamation-triangle', 'mt-0.5 text-warning'),
        this.el('span', { text: this.t('drift.found', { count: ui.ragUiFormatNumber(this.drift.total, this.locale) }) }),
      ]),
      this.el(
        'div',
        {
          className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
          attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('drift.caption') },
        },
        [table],
      ),
    );
  }

  // --- Groups sub-view (UI-SPEC 6.3; D-01, D-04, D-18, D-28) ---

  orgQuery(extra) {
    const params = new URLSearchParams();
    if (this.organizationId) params.set('organizationId', this.organizationId);
    for (const [name, value] of Object.entries(extra || {})) {
      if (value !== null && value !== undefined && value !== '') params.set(name, String(value));
    }
    const text = params.toString();
    return text ? '?' + text : '';
  }

  request(path, init) {
    return accessGroupsUiLib().ragUiRagRequest(path, init);
  }

  workspaceSelector() {
    return this.doc.getElementById('workspace-selector');
  }

  multiTenant() {
    const container = this.doc.getElementById('workspace-selector-container');
    return Boolean(container && this.workspaceSelector() && !container.classList.contains('hidden'));
  }

  readWorkspace() {
    const selector = this.workspaceSelector();
    this.organizationId = selector && selector.value ? String(selector.value) : null;
    this.renderWorkspace();
  }

  workspaceName() {
    const selector = this.workspaceSelector();
    if (!selector || !selector.value) return this.t('panel.workspaceDefault');
    const option = Array.from(selector.querySelectorAll('option')).find((o) => o.getAttribute('value') === selector.value);
    const name = option ? accessGroupsText(option.textContent).trim().replace(/^[^\p{L}\p{N}]+/u, '') : '';
    return name || this.t('panel.workspaceDefault');
  }

  renderWorkspace() {
    let line = this.root.querySelector('[data-access-groups-workspace]');
    const alertHost = this.root.querySelector('[data-access-groups-alert]');
    if (!line && alertHost && alertHost.parentNode) {
      line = this.el('p', { className: 'text-xs text-base-content/70 -mt-2 mb-4 break-words', attrs: { 'data-access-groups-workspace': '' } });
      alertHost.parentNode.insertBefore(line, alertHost);
    }
    if (!line) return;
    const shown = this.multiTenant();
    line.hidden = !shown;
    line.textContent = shown ? this.t('panel.workspace', { name: this.workspaceName() }) : '';
  }

  bindWorkspace() {
    const selector = this.workspaceSelector();
    if (!selector || this.workspaceBound) return;
    this.workspaceBound = true;
    selector.addEventListener('change', () => {
      this.readWorkspace();
      this.groups = null;
      this.groupsFailure = null;
      this.groupsUpdatedAt = null;
      this.renaming = null;
      this.closeMembers({ render: false });
      this.form = this.emptyForm();
      this.renderForm();
      this.resetDocuments();
      this.resetMapping();
      this.loadGroups('first').then(() => {
        if (this.docsRequested) this.loadDocuments('first');
        if (this.mappingRequested) {
          this.loadMapping('first');
          this.loadRules('first');
        }
      });
    });
  }

  emptyForm() {
    return { open: false, name: '', key: '', keyEdited: false, error: null, busy: false };
  }

  groupsUnavailable() {
    return this.t('groups.unavailable', { reload: this.t('action.reload') });
  }

  findRow(id) {
    return this.groups ? this.groups.rows.find((r) => r.id === id) || null : null;
  }

  byData(name, value) {
    return Array.from(this.root.querySelectorAll('[' + name + ']')).filter((node) => node.getAttribute(name) === value);
  }

  focusManage(id) {
    const button = this.byData('data-access-groups-manage', id)[0];
    if (button && typeof button.focus === 'function') button.focus();
  }

  focusStatus() {
    const host = this.statusEl();
    if (host && typeof host.focus === 'function') host.focus();
  }

  btn(text, className, attrs, onClick) {
    const button = this.el('button', { className: 'btn h-auto whitespace-normal ' + className, text, attrs: { type: 'button', ...(attrs || {}) } });
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  /** A template whose {name} placeholder is the given node (a time element), the rest as text. */
  withNode(template, name, node) {
    const parts = accessGroupsText(template).split('{' + name + '}');
    const nodes = [];
    parts.forEach((part, index) => {
      if (part) nodes.push(this.doc.createTextNode(part));
      if (index < parts.length - 1) nodes.push(node);
    });
    return nodes;
  }

  buildGroups(panel) {
    this.newGroupButton = this.btn(
      this.t('action.newGroup'),
      'btn-outline btn-sm min-h-8 py-1',
      { 'aria-expanded': 'false', 'aria-controls': 'rag-access-groups-form', 'data-access-groups-new': '' },
      () => this.openForm(),
    );
    this.groupsUpdated = this.el('span', { className: 'text-xs text-base-content/70', attrs: { 'data-access-groups-updated': '' } });
    this.refreshGroupsButton = this.btn(this.t('action.refreshGroups'), 'btn-outline btn-sm min-h-8 py-1', { 'data-access-groups-refresh': '' }, () => this.loadGroups('refresh'));
    const toolbar = this.el('div', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [
      this.newGroupButton,
      this.el('div', { className: 'flex flex-wrap items-center gap-2 ml-auto' }, [this.groupsUpdated, this.refreshGroupsButton]),
    ]);
    this.groupHosts.form = this.el('div', { className: 'min-w-0', id: 'rag-access-groups-form' });
    this.groupHosts.list = this.el('div', { className: 'min-w-0 mt-4', attrs: { 'data-access-groups-list': '' } });
    this.groupHosts.more = this.el('div', { className: 'mt-4 empty:hidden', attrs: { 'data-access-groups-more': '' } });
    this.groupHosts.toolbar = toolbar;
    panel.replaceChildren(toolbar, this.groupHosts.form, this.groupHosts.list, this.groupHosts.more);
  }

  renderGroupsTab() {
    const tab = this.doc.getElementById('rag-access-groups-tab-groups');
    if (!tab) return;
    const ui = accessGroupsUiLib();
    const known = this.groups && !this.groups.personal && !this.groups.nextCursor;
    tab.textContent = known ? this.t('tab.groups', { count: ui.ragUiFormatNumber(this.groups.rows.length, this.locale) }) : this.t('tab.groupsPlain');
  }

  async loadGroups(source) {
    const ui = accessGroupsUiLib();
    const host = this.groupHosts.list;
    if (!host) return false;
    const seq = ++this.groupsSeq;
    const append = source === 'more' && this.groups && this.groups.nextCursor;
    let restore = null;
    if (append) {
      restore = this.moreButton ? ui.ragUiButtonBusy(this.doc, this.moreButton, this.t('groups.loading')) : null;
    } else if (!this.groups && !this.groupsFailure) {
      ui.ragUiListLoading(this.doc, host, this.t('groups.loading'));
      if (source !== 'quiet') this.announce(this.t('groups.loading'));
    } else {
      ui.ragUiListBusy(host, true);
      if (this.refreshGroupsButton && source !== 'quiet') restore = ui.ragUiButtonBusy(this.doc, this.refreshGroupsButton, this.t('groups.loading'));
    }
    let result;
    try {
      result = await this.request(ACCESS_GROUPS_PATH + this.orgQuery({ limit: ACCESS_GROUPS_PAGE, cursor: append ? this.groups.nextCursor : null }), { method: 'GET' });
    } finally {
      if (restore) restore();
    }
    if (seq !== this.groupsSeq) return false;
    ui.ragUiListBusy(host, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      const list = buildAccessGroupsList(result.body);
      let firstNew = null;
      if (append) {
        const seen = new Set(this.groups.rows.map((r) => r.id));
        const fresh = list.rows.filter((r) => !seen.has(r.id));
        firstNew = fresh[0] || null;
        this.groups = { personal: list.personal, rows: [...this.groups.rows, ...fresh], nextCursor: list.nextCursor };
      } else {
        this.groups = list;
        const alerts = result.body.alerts && typeof result.body.alerts === 'object' ? result.body.alerts : {};
        this.unmappedFromList = list.personal ? 0 : accessGroupsCount(alerts.unmappedSourceGroups);
      }
      this.groupsFailure = null;
      this.groupsUpdatedAt = new Date();
      this.updateUnmappedUi();
      if (this.mappingRequested) this.renderMapping();
      if (this.members && !this.findRow(this.members.groupId)) this.closeMembers({ render: false });
      if (this.renaming && !this.findRow(this.renaming.id)) this.renaming = null;
      if (this.groups.personal) this.form = this.emptyForm();
      this.renderForm();
      this.renderGroups();
      if (source !== 'quiet') this.announce(this.t('groups.loaded', { count: ui.ragUiFormatNumber(this.groups.rows.length, this.locale) }));
      if (firstNew) this.focusManage(firstNew.id);
      else if (append) this.focusStatus();
      return true;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { unavailable: this.groupsUnavailable() });
    this.groupsFailure = mapped.kind === 'unavailable' || mapped.kind === 'network' ? { ...mapped, kind: 'unavailable', message: this.groupsUnavailable() } : mapped;
    this.renderGroups();
    this.announce(this.groupsFailure.message, true);
    return false;
  }

  renderGroups() {
    const ui = accessGroupsUiLib();
    const host = this.groupHosts.list;
    if (!host) return;
    this.renderGroupsTab();
    const failure = this.groupsFailure;
    const replaced = Boolean(failure && (failure.kind === 'signIn' || failure.kind === 'workspace'));
    const personal = Boolean(this.groups && this.groups.personal);
    this.newGroupButton.hidden = personal || replaced;
    this.refreshGroupsButton.hidden = replaced;
    if (this.groupsUpdatedAt && !replaced) {
      this.groupsUpdated.replaceChildren(...this.withNode(this.t('panel.updated'), 'time', this.timeEl(this.groupsUpdatedAt)));
    } else this.groupsUpdated.replaceChildren();
    this.moreButton = null;
    this.groupHosts.more.replaceChildren();
    if (replaced) {
      host.replaceChildren(
        failure.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, () => this.loadGroups('refresh'))
          : ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [failure.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, () => this.loadGroups('refresh'))] }),
      );
      this.groupHosts.form.replaceChildren();
      return;
    }
    const nodes = [];
    if (failure) nodes.push(ui.ragUiUnavailableAlert(this.doc, this.locale, failure.message, () => this.loadGroups('refresh')));
    if (!this.groups) {
      host.replaceChildren(...nodes);
      return;
    }
    if (personal) {
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'person', body: [this.t('groups.personal')] }));
      host.replaceChildren(...nodes);
      return;
    }
    const content = this.groups.rows.length ? this.groupsTable() : this.groupsEmpty();
    if (failure) content.classList.add('opacity-60');
    nodes.push(content);
    host.replaceChildren(...nodes);
    if (this.groups.nextCursor) {
      this.moreButton = this.btn(this.t('action.loadMoreGroups'), 'btn-outline btn-sm min-h-8 py-1', { 'data-access-groups-load-more': '' }, () => this.loadGroups('more'));
      this.groupHosts.more.replaceChildren(this.moreButton);
    }
  }

  groupsEmpty() {
    return this.el('div', { className: 'py-8 text-center', attrs: { 'data-access-groups-empty': '' } }, [
      this.el('p', { className: 'text-base font-semibold text-balance', text: this.t('groups.empty.title') }),
      this.el('p', { className: 'text-sm max-w-prose mx-auto mt-1', text: this.t('groups.empty.body') }),
    ]);
  }

  groupsTable() {
    const th = (text, extra) => this.el('th', { className: 'font-semibold ' + (extra || ''), text, attrs: { scope: 'col' } });
    const body = this.el('tbody');
    for (const row of this.groups.rows) {
      body.appendChild(this.groupRow(row));
      if (this.members && this.members.groupId === row.id && this.membersRegion) {
        body.appendChild(
          this.el('tr', { attrs: { 'data-access-groups-members-row': row.id } }, [
            this.el('td', { className: 'p-2 md:p-3', attrs: { colspan: '4' } }, [this.membersRegion]),
          ]),
        );
      }
    }
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('groups.caption') }),
      this.el('thead', {}, [
        this.el('tr', {}, [
          th(this.t('col.group')),
          th(this.t('col.members'), 'hidden md:table-cell text-right'),
          th(this.t('col.documents'), 'hidden md:table-cell text-right'),
          th(this.t('col.actions')),
        ]),
      ]),
      body,
    ]);
    return this.el(
      'div',
      {
        className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('groups.caption'), 'data-access-groups-table': '' },
      },
      [table],
    );
  }

  countText(key, value) {
    return this.t(key, { count: accessGroupsUiLib().ragUiFormatNumber(value, this.locale) });
  }

  groupRow(row) {
    const ui = accessGroupsUiLib();
    const editing = Boolean(this.renaming && this.renaming.id === row.id);
    const open = Boolean(this.members && this.members.groupId === row.id);
    const nameCell = this.el('th', { className: 'font-normal align-top min-w-0 max-w-[16rem] sm:max-w-sm md:max-w-md', attrs: { scope: 'row' } });
    if (editing) nameCell.appendChild(this.renameEditor(row));
    else nameCell.appendChild(this.el('span', { className: 'block text-sm font-medium break-words', text: row.name, attrs: { 'data-access-groups-name': '' } }));
    if (!editing) {
      nameCell.appendChild(this.el('code', { className: 'block font-mono text-xs text-base-content/70 break-all', text: row.key, attrs: { translate: 'no' } }));
    }
    if (row.connector) {
      nameCell.appendChild(this.el('span', { className: 'badge badge-ghost badge-sm mt-1 h-auto whitespace-normal', text: this.t('group.sourceConnector') }));
    }
    nameCell.appendChild(
      this.el('span', { className: 'flex flex-wrap gap-x-3 text-xs text-base-content/70 mt-1 md:hidden tabular-nums' }, [
        this.el('span', { text: this.countText('group.members', row.memberCount), attrs: { 'data-access-groups-members-count': row.id } }),
        this.el('span', { text: this.countText('group.documents', row.documentCount) }),
      ]),
    );
    const manage = this.btn(
      open ? this.t('action.closeMembers') : this.t('action.manageMembers'),
      'btn-outline md:btn-sm md:min-h-8 py-1',
      {
        'aria-expanded': open ? 'true' : 'false',
        'aria-controls': 'rag-access-groups-members-' + row.id,
        'aria-label': open ? null : this.t('action.manageMembersAria', { group: row.name }),
        'data-access-groups-manage': row.id,
      },
    );
    manage.addEventListener('click', () => this.toggleMembers(row.id));
    const rename = this.btn(this.t('action.renameGroup'), 'btn-outline md:btn-sm md:min-h-8 py-1', {
      'aria-label': this.t('action.renameGroupAria', { group: row.name }),
      'data-access-groups-rename': row.id,
    });
    rename.disabled = editing;
    rename.addEventListener('click', () => this.startRename(row.id));
    const remove = this.btn(this.t('action.deleteGroup'), 'btn-outline btn-error md:btn-sm md:min-h-8 py-1', {
      'aria-label': this.t('action.deleteGroupAria', { group: row.name }),
      'data-access-groups-delete': row.id,
    });
    remove.addEventListener('click', () => this.openDelete(row.id, remove));
    return this.el('tr', { className: 'align-top', attrs: { 'data-access-groups-row': row.id } }, [
      nameCell,
      this.el('td', { className: 'hidden md:table-cell text-right tabular-nums', text: ui.ragUiFormatNumber(row.memberCount, this.locale), attrs: { 'data-access-groups-members-count': row.id } }),
      this.el('td', { className: 'hidden md:table-cell text-right tabular-nums', text: ui.ragUiFormatNumber(row.documentCount, this.locale) }),
      this.el('td', { className: 'min-w-0' }, [this.el('div', { className: 'flex flex-col md:flex-row flex-wrap gap-2' }, [manage, rename, remove])]),
    ]);
  }

  updateMemberCount(groupId, delta) {
    const row = this.findRow(groupId);
    if (!row) return;
    row.memberCount = Math.max(0, row.memberCount + delta);
    const ui = accessGroupsUiLib();
    for (const node of this.byData('data-access-groups-members-count', groupId)) {
      node.textContent = node.tagName === 'td' || node.tagName === 'TD' ? ui.ragUiFormatNumber(row.memberCount, this.locale) : this.countText('group.members', row.memberCount);
    }
  }

  // New group form (D-01)

  openForm() {
    if (!this.form.open) {
      this.form = { ...this.emptyForm(), open: true };
      this.renderForm();
    }
    const name = this.doc.getElementById('rag-access-groups-name');
    if (name) name.focus();
  }

  closeForm(focusBack) {
    this.form = this.emptyForm();
    this.renderForm();
    if (focusBack && this.newGroupButton) this.newGroupButton.focus();
  }

  formField(id, label, input, extra) {
    return this.el('div', { className: 'form-control min-w-0' }, [
      this.el('label', { className: 'label py-1', attrs: { for: id } }, [this.el('span', { className: 'label-text text-sm', text: label })]),
      input,
      ...(extra || []),
    ]);
  }

  renderForm() {
    const host = this.groupHosts.form;
    if (!host) return;
    const personal = Boolean(this.groups && this.groups.personal);
    if (!this.form.open || personal) {
      host.replaceChildren();
      this.formHosts = null;
      if (this.newGroupButton) this.newGroupButton.setAttribute('aria-expanded', 'false');
      return;
    }
    this.newGroupButton.setAttribute('aria-expanded', 'true');
    const name = this.el('input', {
      className: 'input input-bordered input-sm w-full',
      id: 'rag-access-groups-name',
      attrs: { type: 'text', name: 'access-group-name', autocomplete: 'off', maxlength: '200', 'aria-describedby': 'rag-access-groups-name-error' },
    });
    name.value = this.form.name;
    const key = this.el('input', {
      className: 'input input-bordered input-sm w-full font-mono',
      id: 'rag-access-groups-key',
      attrs: {
        type: 'text',
        name: 'access-group-key',
        autocomplete: 'off',
        spellcheck: 'false',
        translate: 'no',
        maxlength: '63',
        'aria-describedby': 'rag-access-groups-key-help rag-access-groups-key-error',
      },
    });
    key.value = this.form.key;
    const nameError = this.el('p', { className: 'text-xs text-error mt-1 empty:hidden break-words', id: 'rag-access-groups-name-error' });
    const keyHelp = this.el('p', { className: 'text-xs text-base-content/70 mt-1 max-w-prose', id: 'rag-access-groups-key-help', text: this.t('form.keyHelp') });
    const keyError = this.el('p', { className: 'text-xs text-error mt-1 empty:hidden break-words', id: 'rag-access-groups-key-error' });
    const findings = this.el('p', { className: 'text-xs text-base-content/70 lg:col-span-2 break-words empty:hidden', id: 'rag-access-groups-findings' });
    const create = this.btn(this.t('action.createGroup'), 'btn-primary btn-sm min-h-8 py-1', { 'aria-describedby': 'rag-access-groups-findings rag-access-groups-key-error', 'data-access-groups-create': '' }, () =>
      this.createGroup(),
    );
    const close = this.btn(this.t('action.closeForm'), 'btn-ghost btn-sm min-h-8 py-1', { 'data-access-groups-close-form': '' }, () => this.closeForm(true));
    this.formHosts = { name, key, nameError, keyError, findings, create, close };
    name.addEventListener('input', () => {
      this.form.name = accessGroupsText(name.value);
      if (!this.form.keyEdited) {
        this.form.key = accessGroupsSuggestKey(this.form.name);
        key.value = this.form.key;
      }
      if (this.form.error && this.form.error.field === 'name') this.form.error = null;
      this.updateFormFindings();
    });
    key.addEventListener('input', () => {
      this.form.key = accessGroupsText(key.value);
      this.form.keyEdited = this.form.key !== '';
      if (this.form.error && this.form.error.field === 'key') this.form.error = null;
      this.updateFormFindings();
    });
    for (const input of [name, key]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && typeof event.preventDefault === 'function') event.preventDefault();
        if (event.key === 'Escape') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          this.closeForm(true);
        }
      });
    }
    host.replaceChildren(
      this.el('div', { className: 'bg-base-100 rounded-lg p-4 mt-4 grid gap-x-6 gap-y-3 lg:grid-cols-2 min-w-0', attrs: { 'data-access-groups-form': '' } }, [
        this.formField('rag-access-groups-name', this.t('form.name'), name, [nameError]),
        this.formField('rag-access-groups-key', this.t('form.key'), key, [keyHelp, keyError]),
        findings,
        this.el('div', { className: 'lg:col-span-2 flex flex-wrap gap-2' }, [create, close]),
      ]),
    );
    this.updateFormFindings();
  }

  updateFormFindings() {
    const h = this.formHosts;
    if (!h) return;
    const { findings, valid } = accessGroupsFormFindings(this.form.name, this.form.key);
    const error = this.form.error;
    const keyFinding = findings.find((f) => f.field === 'key');
    const keyInvalid = Boolean((error && error.field === 'key') || (this.form.key && keyFinding));
    h.findings.textContent = findings
      .filter((f) => !(f.field === 'key' && keyInvalid))
      .map((f) => this.t(f.key))
      .join(' ');
    h.create.disabled = !valid || this.form.busy;
    h.keyError.textContent = error && error.field === 'key' ? error.message : this.form.key && keyFinding ? this.t(keyFinding.key) : '';
    h.nameError.textContent = error && error.field === 'name' ? error.message : '';
    for (const [input, invalid] of [
      [h.key, keyInvalid],
      [h.name, Boolean(error && error.field === 'name')],
    ]) {
      if (invalid) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      input.classList.toggle('input-error', invalid);
    }
  }

  async createGroup() {
    const h = this.formHosts;
    if (!h || this.form.busy || !accessGroupsFormFindings(this.form.name, this.form.key).valid) return;
    const ui = accessGroupsUiLib();
    const form = this.form;
    form.busy = true;
    const restore = ui.ragUiButtonBusy(this.doc, h.create, this.t('create.running'), [h.close]);
    let result;
    try {
      result = await this.request(ACCESS_GROUPS_PATH + this.orgQuery(), {
        method: 'POST',
        body: JSON.stringify({ key: form.key.trim(), name: form.name.trim() }),
      });
    } finally {
      form.busy = false;
      restore();
    }
    if (this.form !== form) return;
    if (result && result.ok && result.body && result.body.group) {
      const row = buildAccessGroupsGroupRow({ ...result.body.group, memberCount: 0, documentCount: 0 });
      this.closeForm(false);
      await this.loadGroups('quiet');
      if (row && this.groups && !this.findRow(row.id)) {
        this.groups.rows.push(row);
        this.renderGroups();
      }
      this.announce(this.t('create.done', { group: row ? row.name : form.name.trim() }));
      if (row) this.focusManage(row.id);
      return;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.groupsUnavailable() });
    const field = mapped.kind === 'field' ? mapped.field : mapped.kind === 'invalid' && (mapped.field === 'key' || mapped.field === 'name') ? mapped.field : null;
    if (field) {
      form.error = { field, message: mapped.message };
      this.updateFormFindings();
      this.announce(mapped.message, true);
      const input = field === 'key' ? h.key : h.name;
      input.focus();
      return;
    }
    this.updateFormFindings();
    this.announce(mapped.message, true);
    if (mapped.reload) {
      await this.loadGroups('quiet');
      this.announce(mapped.message, true);
    }
  }

  // Rename (D-01: the key never changes)

  startRename(id) {
    const row = this.findRow(id);
    if (!row) return;
    this.renaming = { id, value: row.name, busy: false };
    this.renderGroups();
    const input = this.doc.getElementById('rag-access-groups-rename-input');
    if (input) input.focus();
  }

  cancelRename(focusBack) {
    if (!this.renaming || this.renaming.busy) return;
    const id = this.renaming.id;
    this.renaming = null;
    this.renderGroups();
    if (focusBack) {
      const button = this.byData('data-access-groups-rename', id)[0];
      if (button) button.focus();
    }
  }

  renameEditor(row) {
    const state = this.renaming;
    const input = this.el('input', {
      className: 'input input-bordered input-sm w-full',
      id: 'rag-access-groups-rename-input',
      attrs: { type: 'text', name: 'access-group-name', autocomplete: 'off', maxlength: '200', 'aria-describedby': 'rag-access-groups-rename-findings' },
    });
    input.value = state.value;
    const findings = this.el('p', { className: 'text-xs text-base-content/70 break-words empty:hidden', id: 'rag-access-groups-rename-findings' });
    const save = this.btn(this.t('action.saveName'), 'btn-primary btn-sm min-h-8 py-1', { 'aria-describedby': 'rag-access-groups-rename-findings', 'data-access-groups-save-name': '' }, () =>
      this.saveName(row.id),
    );
    const cancel = this.btn(this.t('action.cancelEditing'), 'btn-ghost btn-sm min-h-8 py-1', { 'data-access-groups-cancel-rename': '' }, () => this.cancelRename(true));
    const update = () => {
      const empty = !accessGroupsText(state.value).trim();
      findings.textContent = empty ? this.t('form.needName') : '';
      save.disabled = empty || state.busy;
    };
    input.addEventListener('input', () => {
      state.value = accessGroupsText(input.value);
      update();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && typeof event.preventDefault === 'function') event.preventDefault();
      if (event.key === 'Escape') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        this.cancelRename(true);
      }
    });
    state.hosts = { input, save, cancel };
    update();
    return this.el('div', { className: 'flex flex-col gap-2 min-w-0', attrs: { 'data-access-groups-rename-editor': '' } }, [
      this.el('label', { className: 'text-xs text-base-content/70', text: this.t('form.name'), attrs: { for: 'rag-access-groups-rename-input' } }),
      input,
      this.el('code', { className: 'block font-mono text-xs text-base-content/70 break-all', text: row.key, attrs: { translate: 'no' } }),
      findings,
      this.el('div', { className: 'flex flex-wrap gap-2' }, [save, cancel]),
    ]);
  }

  async saveName(id) {
    const state = this.renaming;
    if (!state || state.id !== id || state.busy) return;
    const name = accessGroupsText(state.value).trim();
    if (!name) return;
    const ui = accessGroupsUiLib();
    state.busy = true;
    const restore = state.hosts ? ui.ragUiButtonBusy(this.doc, state.hosts.save, this.t('rename.running'), [state.hosts.cancel]) : null;
    let result;
    try {
      result = await this.request(ACCESS_GROUPS_PATH + '/' + encodeURIComponent(id) + this.orgQuery(), { method: 'PATCH', body: JSON.stringify({ name }) });
    } finally {
      state.busy = false;
      if (restore) restore();
    }
    if (this.renaming !== state) return;
    if (result && result.ok && result.body && result.body.group) {
      const row = this.findRow(id);
      const fresh = buildAccessGroupsGroupRow({ ...result.body.group, memberCount: row ? row.memberCount : 0, documentCount: row ? row.documentCount : 0 });
      if (row && fresh) row.name = fresh.name;
      this.renaming = null;
      this.renderGroups();
      this.announce(this.t('rename.done', { group: row ? row.name : name }));
      const button = this.byData('data-access-groups-rename', id)[0];
      if (button) button.focus();
      return;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.groupsUnavailable() });
    this.announce(mapped.message, true);
    if (mapped.reload) {
      this.renaming = null;
      await this.loadGroups('quiet');
      this.announce(mapped.message, true);
    }
  }

  // Members region (D-01, D-04, UI-SPEC decision 21)

  toggleMembers(id) {
    if (this.members && this.members.groupId === id) {
      this.closeMembers({ render: true, focus: true });
      return;
    }
    const row = this.findRow(id);
    if (!row) return;
    this.closeMembers({ render: false });
    this.members = { groupId: id, rows: null, failure: null, query: '', results: null, searchState: 'hint', searchError: null, searchedQuery: '', searchSeq: 0, loadSeq: 0, timer: null };
    this.membersRegion = this.buildMembersRegion(row);
    this.renderGroups();
    this.renderSearch();
    if (this.memberHosts && this.memberHosts.search) this.memberHosts.search.focus();
    this.loadMembers();
  }

  closeMembers(options) {
    const opts = options || {};
    const m = this.members;
    if (!m) return;
    if (m.timer) clearTimeout(m.timer);
    this.members = null;
    this.membersRegion = null;
    this.memberHosts = null;
    if (opts.render) this.renderGroups();
    if (opts.focus) this.focusManage(m.groupId);
  }

  buildMembersRegion(row) {
    const id = 'rag-access-groups-members-' + row.id;
    const titleId = id + '-title';
    const search = this.el('input', {
      className: 'input input-bordered input-sm w-full max-w-md',
      id: id + '-search',
      attrs: { type: 'search', name: 'access-group-member-search', autocomplete: 'off', spellcheck: 'false', maxlength: '200', 'aria-describedby': id + '-search-status', 'data-access-groups-member-search': '' },
    });
    const searchStatus = this.el('p', { className: 'text-xs text-base-content/70 mt-1 break-words min-h-4', id: id + '-search-status', attrs: { 'aria-live': 'polite' } });
    const results = this.el('ul', {
      className: 'mt-2 max-h-72 overflow-y-auto divide-y divide-base-200 rounded empty:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
      attrs: { tabindex: '0', 'aria-label': this.t('members.results'), 'data-access-groups-results': '' },
    });
    const table = this.el('div', { className: 'mt-4 min-w-0', attrs: { 'data-access-groups-members': '' } });
    const close = this.btn(this.t('action.closeMembers'), 'btn-ghost btn-sm min-h-8 py-1', { 'data-access-groups-close-members': '' }, () => this.closeMembers({ render: true, focus: true }));
    search.addEventListener('input', () => this.onSearchInput(accessGroupsText(search.value)));
    const onKey = (event) => {
      if (event.key === 'Escape') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        this.closeMembers({ render: true, focus: true });
      }
    };
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        this.searchNow();
        return;
      }
      onKey(event);
    });
    const region = this.el('div', { className: 'bg-base-100 rounded-lg p-4 min-w-0', id, attrs: { role: 'region', 'aria-labelledby': titleId } }, [
      this.el('h4', { className: 'text-base font-semibold mb-2 break-words text-balance', id: titleId, text: this.t('members.title', { group: row.name }) }),
      this.el('label', { className: 'label py-1', attrs: { for: id + '-search' } }, [this.el('span', { className: 'label-text text-sm', text: this.t('members.search') })]),
      search,
      searchStatus,
      results,
      table,
      this.el('div', { className: 'flex flex-wrap items-start justify-between gap-2 mt-4' }, [
        this.el('p', { className: 'text-xs text-base-content/70 max-w-prose', text: this.t('groups.adminNote') }),
        close,
      ]),
    ]);
    region.addEventListener('keydown', (event) => {
      if (event.target !== search) onKey(event);
    });
    this.memberHosts = { region, search, searchStatus, results, table, close };
    return region;
  }

  onSearchInput(value) {
    const m = this.members;
    if (!m) return;
    m.query = value;
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    if (value.trim().length < ACCESS_GROUPS_SEARCH_MIN) {
      m.searchSeq += 1;
      m.results = null;
      m.searchState = 'hint';
      this.renderSearch();
      return;
    }
    m.timer = setTimeout(() => {
      m.timer = null;
      this.runSearch();
    }, ACCESS_GROUPS_SEARCH_WAIT_MS);
  }

  searchNow() {
    const m = this.members;
    if (!m) return;
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    if (m.query.trim().length < ACCESS_GROUPS_SEARCH_MIN) {
      m.searchState = 'hint';
      this.renderSearch();
      return;
    }
    this.runSearch();
  }

  async runSearch() {
    const m = this.members;
    if (!m) return;
    const q = m.query.trim();
    if (q.length < ACCESS_GROUPS_SEARCH_MIN) return;
    const seq = ++m.searchSeq;
    m.searchState = 'searching';
    this.renderSearch();
    const result = await this.request(ACCESS_GROUPS_PATH + '/members/candidates' + this.orgQuery({ groupId: m.groupId, q }), { method: 'GET' });
    if (this.members !== m || seq !== m.searchSeq) return;
    if (result && result.ok && result.body && typeof result.body === 'object') {
      const list = Array.isArray(result.body.candidates) ? result.body.candidates : [];
      m.results = list
        .filter((c) => c && typeof c === 'object' && accessGroupsText(c.userId))
        .slice(0, ACCESS_GROUPS_SEARCH_MAX)
        .map((c) => ({ userId: accessGroupsText(c.userId), name: accessGroupsMemberName(c), already: c.already === true }));
      m.searchedQuery = q;
      m.searchState = m.results.length ? 'results' : 'none';
    } else {
      const mapped = mapAccessGroupsError(result, this.locale, { unavailable: this.t('members.unavailable') });
      m.searchState = 'failed';
      m.searchError = mapped.kind === 'unavailable' || mapped.kind === 'network' ? this.t('members.unavailable') : mapped.message;
    }
    this.renderSearch();
  }

  nameNode(name, extra) {
    return this.el(name.mono ? 'code' : 'span', {
      className: (name.mono ? 'font-mono text-xs break-all' : 'break-words') + (extra ? ' ' + extra : ''),
      text: name.text,
      attrs: name.mono ? { translate: 'no' } : null,
    });
  }

  renderSearch() {
    const m = this.members;
    const h = this.memberHosts;
    if (!m || !h) return;
    const ui = accessGroupsUiLib();
    const status = h.searchStatus;
    status.classList.toggle('text-error', m.searchState === 'failed');
    if (m.searchState === 'hint') status.textContent = this.t('members.searchHint');
    else if (m.searchState === 'searching') status.replaceChildren(ui.ragUiSpinner(this.doc, this.t('members.searching')));
    else if (m.searchState === 'none') status.textContent = this.t('members.noMatch', { query: m.searchedQuery });
    else if (m.searchState === 'failed') status.textContent = m.searchError || '';
    else status.textContent = '';
    if (m.searchState === 'hint') {
      h.results.replaceChildren();
      return;
    }
    if (m.searchState === 'searching' || m.searchState === 'failed') return;
    const items = (m.results || []).map((candidate) => {
      const action = candidate.already
        ? this.el('span', { className: 'text-xs text-base-content/70', text: this.t('members.already') })
        : this.btn(this.t('action.addMember'), 'btn-outline btn-sm min-h-8 py-1', {
            'aria-label': this.t('action.addMemberAria', { name: candidate.name.text }),
            'data-access-groups-add-member': candidate.userId,
          });
      if (!candidate.already) action.addEventListener('click', () => this.addMember(candidate, action));
      return this.el('li', { className: 'flex flex-wrap items-center justify-between gap-2 py-2 min-w-0', attrs: { 'data-access-groups-candidate': candidate.userId } }, [
        this.nameNode(candidate.name, 'text-sm min-w-0'),
        action,
      ]);
    });
    h.results.replaceChildren(...items);
  }

  async loadMembers() {
    const m = this.members;
    const h = this.memberHosts;
    if (!m || !h) return;
    const ui = accessGroupsUiLib();
    const seq = ++m.loadSeq;
    if (!m.rows) ui.ragUiListLoading(this.doc, h.table, this.t('members.loading'));
    else ui.ragUiListBusy(h.table, true);
    const result = await this.request(ACCESS_GROUPS_PATH + '/' + encodeURIComponent(m.groupId) + '/members' + this.orgQuery(), { method: 'GET' });
    if (this.members !== m || seq !== m.loadSeq) return;
    ui.ragUiListBusy(h.table, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      const list = Array.isArray(result.body.members) ? result.body.members : [];
      m.rows = list
        .filter((r) => r && typeof r === 'object' && accessGroupsText(r.userId))
        .map((r) => ({ userId: accessGroupsText(r.userId), name: accessGroupsMemberName(r), addedAt: accessGroupsText(r.addedAt) || null }));
      m.failure = null;
    } else {
      const mapped = mapAccessGroupsError(result, this.locale, { unavailable: this.t('members.unavailable') });
      if (mapped.kind === 'changed') {
        this.announce(mapped.message, true);
        this.closeMembers({ render: false });
        await this.loadGroups('quiet');
        this.announce(mapped.message, true);
        return;
      }
      m.failure = mapped.kind === 'unavailable' || mapped.kind === 'network' ? { ...mapped, message: this.t('members.unavailable') } : mapped;
    }
    this.renderMembersTable();
  }

  renderMembersTable() {
    const m = this.members;
    const h = this.memberHosts;
    if (!m || !h) return;
    const ui = accessGroupsUiLib();
    const nodes = [];
    if (m.failure) {
      nodes.push(
        m.failure.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, () => this.loadMembers())
          : ui.ragUiAlert(this.doc, { tone: 'error', icon: 'exclamation-circle', body: [m.failure.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, () => this.loadMembers())] }),
      );
    }
    if (m.rows && !m.rows.length) {
      nodes.push(this.el('p', { className: 'text-sm max-w-prose', text: this.t('members.empty'), attrs: { 'data-access-groups-members-empty': '' } }));
    } else if (m.rows) {
      const row = this.findRow(m.groupId);
      const caption = this.t('members.title', { group: row ? row.name : '' });
      const body = this.el(
        'tbody',
        {},
        m.rows.map((member) => {
          const remove = this.btn(this.t('action.removeMember'), 'btn-outline md:btn-sm md:min-h-8 py-1', {
            'aria-label': this.t('action.removeMemberAria', { name: member.name.text }),
            'data-access-groups-remove-member': member.userId,
          });
          remove.addEventListener('click', () => this.removeMember(member, remove));
          return this.el('tr', { className: 'align-top', attrs: { 'data-access-groups-member': member.userId } }, [
            this.el('th', { className: 'font-normal min-w-0 max-w-[16rem] sm:max-w-sm', attrs: { scope: 'row' } }, [this.nameNode(member.name, 'text-sm')]),
            this.el('td', { className: 'text-sm whitespace-nowrap' }, [member.addedAt ? this.timeEl(member.addedAt) : this.el('span', { text: this.t('value.none') })]),
            this.el('td', {}, [remove]),
          ]);
        }),
      );
      const table = this.el('table', { className: 'table table-sm' }, [
        this.el('caption', { className: 'sr-only', text: caption }),
        this.el('thead', {}, [
          this.el('tr', {}, [
            this.el('th', { className: 'font-semibold', text: this.t('members.col.name'), attrs: { scope: 'col' } }),
            this.el('th', { className: 'font-semibold', text: this.t('members.col.added'), attrs: { scope: 'col' } }),
            this.el('th', { className: 'font-semibold', text: this.t('col.actions'), attrs: { scope: 'col' } }),
          ]),
        ]),
        body,
      ]);
      const wrap = this.el(
        'div',
        {
          className: 'overflow-x-auto max-h-96 overflow-y-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
          attrs: { tabindex: '0', role: 'region', 'aria-label': caption },
        },
        [table],
      );
      if (m.failure) wrap.classList.add('opacity-60');
      nodes.push(wrap);
    }
    h.table.replaceChildren(...nodes);
  }

  /** member_exists, not_a_workspace_member, 404 and timeouts: the message, then the members (and the search) reload. */
  async memberActionFailed(m, result) {
    const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.t('members.unavailable') });
    this.announce(mapped.message, true);
    if (!mapped.reload) return;
    await this.loadMembers();
    if (this.members === m && m.results) await this.runSearch();
    this.announce(mapped.message, true);
  }

  async addMember(candidate, button) {
    const m = this.members;
    if (!m || candidate.busy) return;
    const ui = accessGroupsUiLib();
    candidate.busy = true;
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('members.adding'));
    let result;
    try {
      result = await this.request(ACCESS_GROUPS_PATH + '/' + encodeURIComponent(m.groupId) + '/members' + this.orgQuery(), {
        method: 'POST',
        body: JSON.stringify({ userId: candidate.userId }),
      });
    } finally {
      candidate.busy = false;
      restore();
    }
    if (this.members !== m) return;
    if (result && result.ok) {
      const row = this.findRow(m.groupId);
      candidate.already = true;
      this.renderSearch();
      this.updateMemberCount(m.groupId, 1);
      await this.loadMembers();
      this.announce(this.t('member.added', { name: candidate.name.text, group: row ? row.name : '' }));
      if (this.memberHosts) this.memberHosts.search.focus();
      return;
    }
    await this.memberActionFailed(m, result);
  }

  async removeMember(member, button) {
    const m = this.members;
    if (!m || member.busy) return;
    const ui = accessGroupsUiLib();
    member.busy = true;
    const restore = ui.ragUiButtonBusy(this.doc, button, this.t('members.removing'));
    let result;
    try {
      result = await this.request(
        ACCESS_GROUPS_PATH + '/' + encodeURIComponent(m.groupId) + '/members/' + encodeURIComponent(member.userId) + this.orgQuery(),
        { method: 'DELETE' },
      );
    } finally {
      member.busy = false;
      restore();
    }
    if (this.members !== m) return;
    if (result && result.ok) {
      const row = this.findRow(m.groupId);
      const index = m.rows ? m.rows.indexOf(member) : -1;
      if (index >= 0) m.rows.splice(index, 1);
      for (const candidate of m.results || []) if (candidate.userId === member.userId) candidate.already = false;
      this.renderSearch();
      this.updateMemberCount(m.groupId, -1);
      this.renderMembersTable();
      this.announce(this.t('member.removed', { name: member.name.text, group: row ? row.name : '' }));
      const next = m.rows && m.rows.length ? m.rows[Math.min(index, m.rows.length - 1)] : null;
      const target = next && this.memberHosts ? Array.from(this.memberHosts.table.querySelectorAll('[data-access-groups-remove-member]')).find((b) => b.getAttribute('data-access-groups-remove-member') === next.userId) : null;
      if (target) target.focus();
      else if (this.memberHosts) this.memberHosts.search.focus();
      return;
    }
    await this.memberActionFailed(m, result);
  }

  // Counted delete dialog (D-18, UI-SPEC decision 10)

  openDelete(id, opener) {
    const row = this.findRow(id);
    if (!row || this.deleting) return;
    const ui = accessGroupsUiLib();
    const titleId = ui.ragUiNextId('rag-access-groups-delete-title');
    const bodyId = ui.ragUiNextId('rag-access-groups-delete-body');
    const countsId = ui.ragUiNextId('rag-access-groups-delete-counts');
    const dialog = this.el('dialog', { className: 'modal', attrs: { 'aria-labelledby': titleId, 'aria-describedby': countsId + ' ' + bodyId, 'data-access-groups-delete-dialog': '' } });
    const keep = this.btn(this.t('action.keepGroup'), 'btn-sm min-h-8 py-1', { 'data-access-groups-keep': '' });
    const confirm = this.btn(this.t('action.deleteGroup'), 'btn-error btn-sm min-h-8 py-1', { 'aria-describedby': countsId, 'data-access-groups-confirm-delete': '' });
    confirm.disabled = true;
    const counts = this.el('div', { className: 'my-3 min-w-0', id: countsId, attrs: { 'aria-live': 'polite', 'data-access-groups-impact': '' } });
    const errorHost = this.el('div', { className: 'empty:hidden mt-3' });
    const box = this.el('div', { className: 'modal-box min-w-0 overscroll-contain' }, [
      this.el('h3', { className: 'text-base font-semibold mb-2 break-words text-balance', id: titleId, text: this.t('delete.title', { group: row.name }) }),
      counts,
      this.el('p', { className: 'text-sm max-w-prose flex items-start gap-2', id: bodyId }, [
        ui.ragUiIcon(this.doc, 'exclamation-triangle', 'mt-0.5 text-warning'),
        this.el('span', { className: 'break-words min-w-0', text: this.t('delete.body') }),
      ]),
      errorHost,
      this.el('div', { className: 'modal-action flex-wrap gap-2' }, [keep, confirm]),
    ]);
    const backdropButton = this.el('button', { className: 'cursor-default', text: this.t('action.keepGroup'), attrs: { type: 'submit', tabindex: '-1' } });
    const backdrop = this.el('form', { className: 'modal-backdrop', attrs: { method: 'dialog' } }, [backdropButton]);
    dialog.appendChild(box);
    dialog.appendChild(backdrop);
    const state = { id, row, dialog, keep, confirm, counts, errorHost, backdropButton, opener, impact: null, running: false, countSeq: 0, done: null, followUp: null };
    this.deleting = state;
    dialog.addEventListener('cancel', (event) => {
      if (state.running && typeof event.preventDefault === 'function') event.preventDefault();
    });
    backdrop.addEventListener('submit', (event) => {
      if (state.running && typeof event.preventDefault === 'function') event.preventDefault();
    });
    dialog.addEventListener('close', () => this.finishDelete(state));
    keep.addEventListener('click', () => {
      if (!state.running) dialog.close('keep');
    });
    confirm.addEventListener('click', () => this.confirmDelete(state));
    this.doc.body.appendChild(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    keep.focus();
    this.countImpact(state);
  }

  async countImpact(state) {
    const ui = accessGroupsUiLib();
    const seq = ++state.countSeq;
    state.impact = null;
    state.confirm.disabled = true;
    state.counts.replaceChildren(ui.ragUiSpinner(this.doc, this.t('delete.counting')));
    const result = await this.request(ACCESS_GROUPS_PATH + '/' + encodeURIComponent(state.id) + '/impact' + this.orgQuery(), { method: 'GET' });
    if (this.deleting !== state || seq !== state.countSeq) return;
    const impact = result && result.ok ? buildAccessGroupsImpactView(result.body) : null;
    if (impact) {
      state.impact = impact;
      state.counts.replaceChildren(this.impactList(impact));
      state.confirm.disabled = state.running;
      return;
    }
    if (result && !result.thrown && result.status === 404) {
      state.followUp = mapAccessGroupsError(result, this.locale, {});
      state.dialog.close('keep');
      return;
    }
    const again = this.btn(this.t('action.countAgain'), 'btn-outline btn-sm min-h-8 py-1', { 'data-access-groups-count-again': '' }, () => this.countImpact(state));
    state.counts.replaceChildren(
      this.el('div', { className: 'flex flex-wrap items-start gap-2 text-sm', attrs: { 'data-access-groups-count-unavailable': '' } }, [
        this.el('p', { className: 'flex items-start gap-1 max-w-prose min-w-0 flex-1 basis-56' }, [
          ui.ragUiIcon(this.doc, 'exclamation-circle', 'mt-0.5 text-error'),
          this.el('span', { text: this.t('delete.countUnavailable') }),
        ]),
        again,
      ]),
    );
  }

  impactList(impact) {
    const ui = accessGroupsUiLib();
    const item = (key, value, first) =>
      this.el('div', { className: 'flex items-baseline justify-between gap-4 py-1 min-w-0' + (first ? ' font-semibold' : '') }, [
        this.el('dt', { className: 'text-sm min-w-0 break-words', text: accessGroupsCountLabel(this.t(key)) }),
        this.el('dd', { className: 'text-sm text-right tabular-nums shrink-0', text: ui.ragUiFormatNumber(value, this.locale) }),
      ]);
    const nodes = [
      this.el('dl', { className: 'divide-y divide-base-200', attrs: { 'aria-label': this.t('delete.countsLabel') } }, [
        item('delete.docsClosed', impact.onlyCount, true),
        item('delete.docsOther', impact.sharedCount),
        item('delete.members', impact.memberCount),
      ]),
    ];
    if (impact.mappingCount > 0) nodes.push(this.el('p', { className: 'text-sm mt-2 break-words', text: this.countText('delete.mappings', impact.mappingCount) }));
    return this.el('div', { className: 'min-w-0' }, nodes);
  }

  async confirmDelete(state) {
    if (!state.impact || state.running || this.deleting !== state) return;
    const ui = accessGroupsUiLib();
    state.running = true;
    state.errorHost.replaceChildren();
    const restore = ui.ragUiButtonBusy(this.doc, state.confirm, this.t('delete.running'), [state.keep, state.backdropButton]);
    let result;
    try {
      result = await this.request(ACCESS_GROUPS_PATH + '/' + encodeURIComponent(state.id) + this.orgQuery(), {
        method: 'DELETE',
        body: JSON.stringify({ expectedCount: state.impact.onlyCount }),
      });
    } finally {
      state.running = false;
      restore();
    }
    if (result && result.ok) {
      state.done = { fellBack: accessGroupsCount(result.body && result.body.fellBack) };
      state.dialog.close('confirm');
      return;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.groupsUnavailable() });
    if (mapped.kind === 'recount') {
      await this.countImpact(state);
      return;
    }
    if (mapped.reload) {
      state.followUp = mapped;
      state.dialog.close('keep');
      return;
    }
    state.errorHost.replaceChildren(
      this.el('p', { className: 'text-sm text-error flex items-start gap-1 break-words', attrs: { role: 'alert' } }, [
        ui.ragUiIcon(this.doc, 'exclamation-circle', 'mt-0.5'),
        this.el('span', { text: mapped.message }),
      ]),
    );
  }

  async finishDelete(state) {
    if (state.finished) return;
    state.finished = true;
    state.dialog.remove();
    if (this.deleting === state) this.deleting = null;
    if (state.done) {
      if (this.groups) this.groups.rows = this.groups.rows.filter((r) => r.id !== state.id);
      if (this.members && this.members.groupId === state.id) this.closeMembers({ render: false });
      if (this.renaming && this.renaming.id === state.id) this.renaming = null;
      this.renderGroups();
      this.announce(this.t('delete.done', { group: state.row.name, count: accessGroupsUiLib().ragUiFormatNumber(state.done.fellBack, this.locale) }));
      this.focusStatus();
      return;
    }
    if (state.followUp) {
      this.focusStatus();
      this.announce(state.followUp.message, true);
      await this.loadGroups('quiet');
      this.announce(state.followUp.message, true);
      return;
    }
    const target = state.opener && state.opener.isConnected !== false ? state.opener : this.statusEl();
    if (target && typeof target.focus === 'function') target.focus();
  }
  // Documents sub-view (D-17, D-28, UI-SPEC 6.4)

  onTabSelect(id) {
    if (id === 'documents' && !this.docsRequested) {
      this.docsRequested = true;
      this.loadDocuments('first');
    }
    if (id === 'mapping' && !this.mappingRequested) {
      this.mappingRequested = true;
      this.loadMapping('first');
      this.loadRules('first');
    }
  }

  // Connector mapping sub-view (D-20, D-21, A-10, UI-SPEC 6.5)

  emptyMapForm() {
    return { open: false, provider: '', principal: '', groupId: '', error: null, busy: false };
  }

  emptyRuleForm() {
    return { open: false, provider: '', domain: '', error: null, busy: false };
  }

  mappingUnavailable() {
    return this.t('mapping.unavailable', { reload: this.t('action.reload') });
  }

  mappingComplete() {
    return Boolean(this.mapping && !this.mapping.personal && this.mapping.nextOffset === null);
  }

  /** Source groups not mapped: counted on screen once every page is loaded, else the count from GET / (UI-SPEC 8.1). */
  unmappedCount() {
    if (this.mappingComplete()) return this.mapping.rows.filter((r) => !r.mapped).length;
    if (this.mapping && this.mapping.personal) return 0;
    return this.unmappedFromList;
  }

  updateUnmappedUi() {
    const tab = this.doc.getElementById('rag-access-groups-tab-mapping');
    const count = this.unmappedCount();
    if (tab) tab.textContent = count > 0 ? this.t('tab.mappingUnmapped', { count: accessGroupsUiLib().ragUiFormatNumber(count, this.locale) }) : this.t('tab.mapping');
    this.renderAlerts();
  }

  resetMapping() {
    this.mapping = null;
    this.mappingFailure = null;
    this.mappingUpdatedAt = null;
    this.mappingDraft.clear();
    this.mappingBusy = null;
    this.mapForm = this.emptyMapForm();
    this.rules = null;
    this.rulesFailure = null;
    this.rulesShown = ACCESS_GROUPS_PAGE;
    this.ruleForm = this.emptyRuleForm();
    this.renderMapping();
  }

  groupName(id) {
    const row = this.findRow(id);
    return row ? row.name : accessGroupsText(id);
  }

  joinFields(names) {
    return names.join(this.locale === 'zh' ? '、' : ', ');
  }

  providerOptions(select, chosen) {
    select.appendChild(this.el('option', { text: this.t('mapping.form.choose'), attrs: { value: '' } }));
    for (const provider of ACCESS_GROUPS_PROVIDERS) {
      select.appendChild(this.el('option', { text: accessGroupsProviderName(provider), attrs: { value: provider } }));
    }
    select.value = chosen || '';
  }

  buildMapping(panel) {
    const h = this.mappingHosts;
    h.heading = this.el('h4', {
      className: 'text-base font-semibold text-balance rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
      text: this.t('mapping.groups.title'),
      attrs: { tabindex: '-1', 'data-access-groups-mapping-heading': '' },
    });
    h.description = this.el('p', { className: 'text-sm text-base-content/70 max-w-prose mb-4', text: this.t('mapping.description'), attrs: { 'data-access-groups-mapping-description': '' } });
    h.note = this.el('div', { className: 'mb-4 empty:hidden' });
    h.top = this.el('div', { className: 'min-w-0 empty:hidden' });
    this.newMappingButton = this.btn(
      this.t('action.newMapping'),
      'btn-outline btn-sm min-h-8 py-1',
      { 'aria-expanded': 'false', 'aria-controls': 'rag-access-groups-map-form', 'data-access-groups-mapping-new': '' },
      () => this.openMapForm(),
    );
    this.mappingUpdated = this.el('span', { className: 'text-xs text-base-content/70', attrs: { 'data-access-groups-mapping-updated': '' } });
    this.refreshMappingButton = this.btn(this.t('action.refreshMapping'), 'btn-outline btn-sm min-h-8 py-1', { 'data-access-groups-mapping-refresh': '' }, () => {
      this.loadMapping('refresh');
      this.loadRules('quiet');
    });
    h.groupsHeader = this.el('div', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [
      h.heading,
      this.newMappingButton,
      this.el('div', { className: 'flex flex-wrap items-center gap-2 ml-auto' }, [this.mappingUpdated, this.refreshMappingButton]),
    ]);
    h.form = this.el('div', { className: 'min-w-0', id: 'rag-access-groups-map-form' });
    h.list = this.el('div', { className: 'min-w-0 mt-4', attrs: { 'data-access-groups-mapping-list': '' } });
    h.more = this.el('div', { className: 'mt-4 empty:hidden' });
    h.groups = this.el('section', { className: 'min-w-0', attrs: { 'aria-labelledby': 'rag-access-groups-mapping-title' } }, [h.groupsHeader, h.form, h.list, h.more]);
    h.heading.id = 'rag-access-groups-mapping-title';

    this.addRuleButton = this.btn(
      this.t('action.addDomain'),
      'btn-outline btn-sm min-h-8 py-1',
      { 'aria-expanded': 'false', 'aria-controls': 'rag-access-groups-rule-form', 'data-access-groups-rule-new': '' },
      () => this.openRuleForm(),
    );
    h.rulesHeader = this.el('div', { className: 'flex flex-wrap items-center gap-2 min-w-0' }, [
      this.el('h4', { className: 'text-base font-semibold text-balance', id: 'rag-access-groups-rules-title', text: this.t('rules.title') }),
      this.addRuleButton,
    ]);
    h.rulesDescription = this.el('p', { className: 'text-sm text-base-content/70 max-w-prose mt-1', text: this.t('rules.description') });
    h.ruleForm = this.el('div', { className: 'min-w-0', id: 'rag-access-groups-rule-form' });
    h.rulesList = this.el('div', { className: 'min-w-0 mt-4', attrs: { 'data-access-groups-rules-list': '' } });
    h.rulesMore = this.el('div', { className: 'mt-4 empty:hidden' });
    h.rules = this.el('section', { className: 'min-w-0 mt-8', attrs: { 'aria-labelledby': 'rag-access-groups-rules-title' } }, [
      h.rulesHeader,
      h.rulesDescription,
      h.ruleForm,
      h.rulesList,
      h.rulesMore,
    ]);
    panel.replaceChildren(h.description, h.note, h.top, h.groups, h.rules);
  }

  async loadMapping(source) {
    const ui = accessGroupsUiLib();
    const host = this.mappingHosts.list;
    if (!host) return false;
    this.mappingRequested = true;
    const seq = ++this.mappingSeq;
    const append = source === 'more' && this.mapping && this.mapping.nextOffset !== null;
    let restore = null;
    if (append) {
      restore = this.mappingMoreButton ? ui.ragUiButtonBusy(this.doc, this.mappingMoreButton, this.t('mapping.loading')) : null;
    } else if (!this.mapping && !this.mappingFailure) {
      ui.ragUiListLoading(this.doc, host, this.t('mapping.loading'));
      if (source !== 'quiet') this.announce(this.t('mapping.loading'));
    } else {
      ui.ragUiListBusy(host, true);
      if (this.refreshMappingButton && source !== 'quiet') restore = ui.ragUiButtonBusy(this.doc, this.refreshMappingButton, this.t('mapping.loading'));
    }
    let result;
    try {
      result = await this.request(ACCESS_GROUPS_PATH + '/connector-map' + this.orgQuery({ offset: append ? this.mapping.nextOffset : null }), { method: 'GET' });
    } finally {
      if (restore) restore();
    }
    if (seq !== this.mappingSeq) return false;
    ui.ragUiListBusy(host, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      const list = buildAccessGroupsMappingList(result.body);
      let firstNew = null;
      if (append) {
        const seen = new Set(this.mapping.rows.map((r) => r.key));
        const fresh = list.rows.filter((r) => !seen.has(r.key));
        firstNew = fresh[0] || null;
        this.mapping = { ...list, rows: [...this.mapping.rows, ...fresh] };
      } else {
        this.mapping = list;
      }
      this.mappingFailure = null;
      this.mappingUpdatedAt = new Date();
      for (const key of [...this.mappingDraft.keys()]) {
        if (!this.mapping.rows.some((r) => r.key === key)) this.mappingDraft.delete(key);
      }
      if (this.mapping.personal) this.mapForm = this.emptyMapForm();
      this.renderMapping();
      this.updateUnmappedUi();
      if (source !== 'quiet' && !append) this.announce(this.t('mapping.loaded', { count: ui.ragUiFormatNumber(this.mapping.rows.length, this.locale) }));
      if (firstNew) this.focusMappingRow(firstNew.key);
      else if (append) this.focusStatus();
      return true;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { unavailable: this.mappingUnavailable() });
    this.mappingFailure = mapped.kind === 'unavailable' || mapped.kind === 'network' ? { ...mapped, kind: 'unavailable', message: this.mappingUnavailable() } : mapped;
    this.renderMapping();
    this.announce(this.mappingFailure.message, true);
    return false;
  }

  async loadRules(source) {
    if (!this.mappingHosts.rulesList) return false;
    const ui = accessGroupsUiLib();
    const seq = ++this.rulesSeq;
    if (!this.rules && !this.rulesFailure) ui.ragUiListLoading(this.doc, this.mappingHosts.rulesList, this.t('mapping.loading'));
    else ui.ragUiListBusy(this.mappingHosts.rulesList, true);
    const result = await this.request(ACCESS_GROUPS_PATH + '/sharing-rules' + this.orgQuery(), { method: 'GET' });
    if (seq !== this.rulesSeq) return false;
    ui.ragUiListBusy(this.mappingHosts.rulesList, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      this.rules = buildAccessGroupsRulesList(result.body);
      this.rulesFailure = null;
      if (this.rules.personal) this.ruleForm = this.emptyRuleForm();
      this.renderMapping();
      return true;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { unavailable: this.mappingUnavailable() });
    this.rulesFailure = mapped.kind === 'unavailable' || mapped.kind === 'network' ? { ...mapped, kind: 'unavailable', message: this.mappingUnavailable() } : mapped;
    this.renderMapping();
    if (source !== 'quiet' && !this.mappingFailure) this.announce(this.rulesFailure.message, true);
    return false;
  }

  reloadMappingView() {
    this.loadMapping('refresh');
    this.loadRules('refresh');
  }

  renderMapping() {
    const h = this.mappingHosts;
    if (!h.list) return;
    const ui = accessGroupsUiLib();
    const failures = [this.mappingFailure, this.rulesFailure].filter(Boolean);
    const replaced = failures.find((f) => f.kind === 'signIn' || f.kind === 'workspace') || null;
    const personal = Boolean((this.mapping && this.mapping.personal) || (this.rules && this.rules.personal));
    const shown = !replaced && !personal;
    h.groups.hidden = !shown;
    h.rules.hidden = !shown;
    h.note.replaceChildren();
    if (this.mapping && !this.mapping.visibilityApplies && shown) {
      const note = ui.ragUiAlert(this.doc, { tone: 'info', icon: 'info-circle', body: [this.t('mapping.personalNote')] });
      note.setAttribute('data-access-groups-mapping-note', '');
      h.note.appendChild(note);
    }
    if (replaced) {
      h.top.replaceChildren(
        replaced.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, () => this.reloadMappingView())
          : ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [replaced.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, () => this.reloadMappingView())] }),
      );
    } else if (personal) {
      h.top.replaceChildren(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'person', body: [this.t('groups.personal')] }));
    } else {
      h.top.replaceChildren();
    }
    if (!shown) {
      this.mapForm = this.emptyMapForm();
      this.ruleForm = this.emptyRuleForm();
      h.list.replaceChildren();
      h.more.replaceChildren();
      h.rulesList.replaceChildren();
      h.rulesMore.replaceChildren();
      this.renderMapForm();
      this.renderRuleForm();
      return;
    }
    this.renderMapForm();
    this.renderRuleForm();
    this.renderMappingList();
    this.renderRules();
  }

  renderMappingList() {
    const h = this.mappingHosts;
    const ui = accessGroupsUiLib();
    if (this.mappingUpdatedAt) this.mappingUpdated.replaceChildren(...this.withNode(this.t('panel.updated'), 'time', this.timeEl(this.mappingUpdatedAt)));
    else this.mappingUpdated.replaceChildren();
    this.mappingMoreButton = null;
    h.more.replaceChildren();
    const nodes = [];
    if (this.mappingFailure) nodes.push(ui.ragUiUnavailableAlert(this.doc, this.locale, this.mappingFailure.message, () => this.loadMapping('refresh')));
    if (!this.mapping) {
      if (nodes.length) h.list.replaceChildren(...nodes);
      return;
    }
    const content = this.mapping.rows.length ? this.mappingTable() : this.mappingEmpty();
    if (this.mappingFailure) content.classList.add('opacity-60');
    nodes.push(content);
    h.list.replaceChildren(...nodes);
    if (this.mapping.nextOffset !== null) {
      this.mappingMoreButton = this.btn(this.t('action.loadMoreMapping'), 'btn-outline btn-sm min-h-8 py-1', { 'data-access-groups-mapping-load-more': '' }, () => this.loadMapping('more'));
      h.more.replaceChildren(this.mappingMoreButton);
    }
  }

  mappingEmpty() {
    return this.el('div', { className: 'py-8 text-center', attrs: { 'data-access-groups-mapping-empty': '' } }, [
      this.el('p', { className: 'text-base font-semibold text-balance', text: this.t('mapping.empty.title') }),
      this.el('p', { className: 'text-sm max-w-prose mx-auto mt-1', text: this.t('mapping.empty.body') }),
    ]);
  }

  scrollRegion(label, data, table) {
    return this.el(
      'div',
      {
        className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': label, [data]: '' },
      },
      [table],
    );
  }

  mappingTable() {
    const th = (text, extra) => this.el('th', { className: 'font-semibold ' + (extra || ''), text, attrs: { scope: 'col' } });
    const body = this.el('tbody');
    for (const row of this.mapping.rows) body.appendChild(this.mappingRow(row));
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('mapping.caption') }),
      this.el('thead', {}, [
        this.el('tr', {}, [
          th(this.t('mapping.col.source')),
          th(this.t('mapping.col.principal')),
          th(this.t('col.documents'), 'hidden md:table-cell text-right'),
          th(this.t('mapping.col.accessGroup')),
          th(this.t('col.actions')),
        ]),
      ]),
      body,
    ]);
    return this.scrollRegion(this.t('mapping.caption'), 'data-access-groups-mapping-table', table);
  }

  mappingValue(row) {
    return this.mappingDraft.has(row.key) ? this.mappingDraft.get(row.key) : row.groupId || '';
  }

  mappingRow(row) {
    const ui = accessGroupsUiLib();
    const busy = this.mappingBusy === row.key;
    const principalCell = this.el('th', { className: 'font-normal align-top min-w-0 max-w-[14rem] sm:max-w-xs md:max-w-sm', attrs: { scope: 'row' } }, [
      this.el('code', { className: 'block font-mono text-xs break-all', text: row.principal, attrs: { translate: 'no' } }),
      this.el('span', { className: 'block text-xs text-base-content/70 mt-0.5', text: accessGroupsMappingKindLabel(row, this.locale) }),
    ]);
    if (!row.mapped) {
      principalCell.appendChild(
        this.el('span', { className: 'badge badge-warning badge-outline badge-sm gap-1 mt-1 h-auto whitespace-normal text-base-content', attrs: { 'data-access-groups-not-mapped': '' } }, [
          ui.ragUiIcon(this.doc, 'exclamation-triangle', 'text-warning'),
          this.el('span', { text: this.t('mapping.notMapped') }),
        ]),
      );
    }
    principalCell.appendChild(
      this.el('span', {
        className: 'block text-xs text-base-content/70 mt-1 md:hidden tabular-nums',
        text: this.countText('group.documents', row.documents),
        attrs: { 'data-access-groups-mapping-documents-under': '' },
      }),
    );
    const selectId = ui.ragUiNextId('rag-access-groups-map-select');
    const select = this.el('select', {
      className: 'select select-bordered select-sm w-full max-w-xs',
      id: selectId,
      attrs: { 'aria-label': this.t('mapping.selectAria', { principal: row.principal }), name: 'access-group-mapping', 'data-access-groups-mapping-select': row.key },
    });
    select.appendChild(this.el('option', { text: this.t('mapping.notMapped'), attrs: { value: '' } }));
    const options = this.groupOptions();
    for (const option of options) select.appendChild(this.el('option', { text: option.name, attrs: { value: option.id } }));
    if (row.groupId && !options.some((o) => o.id === row.groupId)) select.appendChild(this.el('option', { text: row.groupId, attrs: { value: row.groupId } }));
    select.value = this.mappingValue(row);
    select.disabled = busy;
    const save = this.btn(this.t('action.saveMapping'), 'btn-outline md:btn-sm md:min-h-8 py-1', {
      'aria-label': this.t('action.saveMappingAria', { principal: row.principal }),
      'data-access-groups-mapping-save': row.key,
    });
    save.disabled = busy || accessGroupsMappingAction(row, select.value) === 'none';
    select.addEventListener('change', () => {
      const value = accessGroupsText(select.value);
      if (value === (row.groupId || '')) this.mappingDraft.delete(row.key);
      else this.mappingDraft.set(row.key, value);
      save.disabled = this.mappingBusy !== null || accessGroupsMappingAction(row, value) === 'none';
    });
    const actions = [save];
    let remove = null;
    if (row.mapped) {
      remove = this.btn(this.t('action.removeMapping'), 'btn-outline md:btn-sm md:min-h-8 py-1', {
        'aria-label': this.t('action.removeMappingAria', { principal: row.principal }),
        'data-access-groups-mapping-remove': row.key,
      });
      remove.disabled = busy;
      remove.addEventListener('click', () => this.saveMapping(row, 'remove', remove, [save, select]));
      actions.push(remove);
    }
    save.addEventListener('click', () => this.saveMapping(row, accessGroupsMappingAction(row, select.value), save, [remove, select]));
    return this.el('tr', { className: 'align-top', attrs: { 'data-access-groups-mapping-row': row.key } }, [
      this.el('td', { className: 'align-top break-words', text: accessGroupsProviderName(row.provider) }),
      principalCell,
      this.el('td', { className: 'hidden md:table-cell text-right tabular-nums align-top', text: ui.ragUiFormatNumber(row.documents, this.locale), attrs: { 'data-access-groups-mapping-documents': '' } }),
      this.el('td', { className: 'align-top min-w-[10rem]' }, [select]),
      this.el('td', { className: 'align-top' }, [this.el('div', { className: 'flex flex-col md:flex-row flex-wrap gap-2' }, actions)]),
    ]);
  }

  focusMappingRow(key) {
    const select = this.byData('data-access-groups-mapping-select', key)[0];
    if (select && typeof select.focus === 'function') select.focus();
  }

  async saveMapping(row, action, button, siblings) {
    if (action === 'none' || this.mappingBusy !== null) return;
    const ui = accessGroupsUiLib();
    const groupId = action === 'remove' ? null : accessGroupsText(this.mappingValue(row));
    this.mappingBusy = row.key;
    const restore = ui.ragUiButtonBusy(this.doc, button, action === 'remove' ? this.t('members.removing') : this.t('save.running'), siblings);
    let result;
    try {
      if (action === 'create') {
        result = await this.request(ACCESS_GROUPS_PATH + '/connector-map' + this.orgQuery(), {
          method: 'POST',
          body: JSON.stringify({ provider: row.provider, kind: row.kind, externalPrincipalId: row.principal, groupId }),
        });
      } else if (action === 'change') {
        result = await this.request(ACCESS_GROUPS_PATH + '/connector-map/' + encodeURIComponent(row.id) + this.orgQuery(), {
          method: 'PUT',
          body: JSON.stringify({ groupId }),
        });
      } else {
        result = await this.request(ACCESS_GROUPS_PATH + '/connector-map/' + encodeURIComponent(row.id) + this.orgQuery(), { method: 'DELETE' });
      }
    } finally {
      this.mappingBusy = null;
      restore();
    }
    if (result && result.ok) {
      this.mappingDraft.delete(row.key);
      const message =
        action === 'remove'
          ? this.t('mapping.removed', { principal: row.principal })
          : this.t('mapping.saved', { principal: row.principal, group: this.groupName(groupId) });
      await this.afterMappingWrite();
      this.announce(message);
      this.focusStatus();
      return;
    }
    await this.mappingWriteFailed(result);
  }

  async afterMappingWrite() {
    await this.loadMapping('quiet');
    if (!this.mappingComplete()) await this.loadGroups('quiet');
  }

  async mappingWriteFailed(result) {
    const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.mappingUnavailable() });
    const reload = mapped.reload || mapped.kind === 'field';
    const message = mapped.kind === 'field' ? this.t('error.changed') : mapped.message;
    this.announce(message, true);
    if (mapped.kind === 'groupGone') await this.loadGroups('quiet');
    if (reload) await this.loadMapping('quiet');
    this.renderMapping();
    this.announce(message, true);
    this.focusStatus();
  }

  // New mapping form (UI-SPEC 6.5, 9.5, 9.6)

  openMapForm() {
    if (!this.mapForm.open) {
      this.mapForm = { ...this.emptyMapForm(), open: true };
      this.renderMapForm();
    }
    const provider = this.mapFormHosts && this.mapFormHosts.provider;
    if (provider) provider.focus();
  }

  closeMapForm(focusBack) {
    this.mapForm = this.emptyMapForm();
    this.renderMapForm();
    if (focusBack && this.newMappingButton) this.newMappingButton.focus();
  }

  formKeys(inputs, close) {
    for (const input of inputs) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && input.tagName && String(input.tagName).toLowerCase() === 'input' && typeof event.preventDefault === 'function') event.preventDefault();
        if (event.key === 'Escape') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          close();
        }
      });
    }
  }

  renderMapForm() {
    const host = this.mappingHosts.form;
    if (!host) return;
    if (!this.mapForm.open) {
      host.replaceChildren();
      this.mapFormHosts = null;
      if (this.newMappingButton) this.newMappingButton.setAttribute('aria-expanded', 'false');
      return;
    }
    this.newMappingButton.setAttribute('aria-expanded', 'true');
    const form = this.mapForm;
    const provider = this.el('select', { className: 'select select-bordered select-sm w-full', id: 'rag-access-groups-map-provider', attrs: { name: 'access-group-mapping-source', 'data-access-groups-mapping-provider': '' } });
    this.providerOptions(provider, form.provider);
    const principal = this.el('input', {
      className: 'input input-bordered input-sm w-full font-mono',
      id: 'rag-access-groups-map-principal',
      attrs: {
        type: 'text',
        name: 'access-group-mapping-principal',
        autocomplete: 'off',
        spellcheck: 'false',
        translate: 'no',
        maxlength: '512',
        'aria-describedby': 'rag-access-groups-map-principal-help rag-access-groups-map-principal-error',
        'data-access-groups-mapping-principal': '',
      },
    });
    principal.value = form.principal;
    const group = this.el('select', { className: 'select select-bordered select-sm w-full', id: 'rag-access-groups-map-group', attrs: { name: 'access-group-mapping-group', 'data-access-groups-mapping-group': '' } });
    group.appendChild(this.el('option', { text: this.t('mapping.form.choose'), attrs: { value: '' } }));
    for (const option of this.groupOptions()) group.appendChild(this.el('option', { text: option.name, attrs: { value: option.id } }));
    group.value = form.groupId;
    const help = this.el('p', { className: 'text-xs text-base-content/70 mt-1 max-w-prose', id: 'rag-access-groups-map-principal-help', text: this.t('mapping.form.principalHelp') });
    const error = this.el('p', { className: 'text-xs text-error mt-1 empty:hidden break-words', id: 'rag-access-groups-map-principal-error' });
    const findings = this.el('p', { className: 'text-xs text-base-content/70 md:col-span-2 break-words empty:hidden', id: 'rag-access-groups-map-findings', attrs: { 'data-access-groups-mapping-findings': '' } });
    const create = this.btn(this.t('action.createMapping'), 'btn-primary btn-sm min-h-8 py-1', { 'aria-describedby': 'rag-access-groups-map-findings rag-access-groups-map-principal-error', 'data-access-groups-mapping-create': '' }, () =>
      this.createMapping(),
    );
    const close = this.btn(this.t('action.closeForm'), 'btn-ghost btn-sm min-h-8 py-1', { 'data-access-groups-mapping-close': '' }, () => this.closeMapForm(true));
    this.mapFormHosts = { provider, principal, group, error, findings, create, close };
    provider.addEventListener('change', () => {
      form.provider = accessGroupsText(provider.value);
      this.updateMapFindings();
    });
    principal.addEventListener('input', () => {
      form.principal = accessGroupsText(principal.value);
      form.error = null;
      this.updateMapFindings();
    });
    group.addEventListener('change', () => {
      form.groupId = accessGroupsText(group.value);
      this.updateMapFindings();
    });
    this.formKeys([provider, principal, group], () => this.closeMapForm(true));
    host.replaceChildren(
      this.el('div', { className: 'bg-base-100 rounded-lg p-4 mt-4 grid gap-x-6 gap-y-3 md:grid-cols-2 min-w-0', attrs: { 'data-access-groups-mapping-form': '' } }, [
        this.formField('rag-access-groups-map-provider', this.t('mapping.col.source'), provider),
        this.formField('rag-access-groups-map-principal', this.t('mapping.form.principal'), principal, [help, error]),
        this.formField('rag-access-groups-map-group', this.t('mapping.col.accessGroup'), group),
        findings,
        this.el('div', { className: 'md:col-span-2 flex flex-wrap gap-2' }, [create, close]),
      ]),
    );
    this.updateMapFindings();
  }

  updateMapFindings() {
    const h = this.mapFormHosts;
    if (!h) return;
    const form = this.mapForm;
    const { missing, valid } = accessGroupsMappingFindings(form);
    const names = { provider: this.t('mapping.col.source'), principal: this.t('mapping.form.principal'), groupId: this.t('mapping.col.accessGroup') };
    h.findings.textContent = valid ? '' : this.t('mapping.need', { fields: this.joinFields(missing.map((m) => names[m])) });
    h.create.disabled = !valid || form.busy;
    h.error.textContent = form.error ? form.error : '';
    if (form.error) h.principal.setAttribute('aria-invalid', 'true');
    else h.principal.removeAttribute('aria-invalid');
    h.principal.classList.toggle('input-error', Boolean(form.error));
  }

  async createMapping() {
    const h = this.mapFormHosts;
    const form = this.mapForm;
    if (!h || form.busy || !accessGroupsMappingFindings(form).valid) return;
    const ui = accessGroupsUiLib();
    form.busy = true;
    const principal = form.principal.trim();
    const restore = ui.ragUiButtonBusy(this.doc, h.create, this.t('create.running'), [h.close]);
    let result;
    try {
      result = await this.request(ACCESS_GROUPS_PATH + '/connector-map' + this.orgQuery(), {
        method: 'POST',
        body: JSON.stringify({ provider: form.provider, kind: ACCESS_GROUPS_PROVIDER_KIND[form.provider], externalPrincipalId: principal, groupId: form.groupId }),
      });
    } finally {
      form.busy = false;
      restore();
    }
    if (this.mapForm !== form) return;
    if (result && result.ok) {
      const message = this.t('mapping.saved', { principal, group: this.groupName(form.groupId) });
      this.closeMapForm(false);
      await this.afterMappingWrite();
      this.announce(message);
      this.focusStatus();
      return;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.mappingUnavailable() });
    if (mapped.kind === 'field' && mapped.field === 'principal') {
      form.error = mapped.message;
      this.updateMapFindings();
      this.announce(mapped.message, true);
      h.principal.focus();
      return;
    }
    this.updateMapFindings();
    this.announce(mapped.message, true);
    if (mapped.kind === 'groupGone') {
      await this.loadGroups('quiet');
      this.renderMapForm();
      this.announce(mapped.message, true);
    } else if (mapped.reload) {
      await this.loadMapping('quiet');
      this.announce(mapped.message, true);
    }
  }

  // Sharing rules (D-20, UI-SPEC 6.5, 9.7, 9.11, 12.1 decisions 11 and 17)

  renderRules() {
    const h = this.mappingHosts;
    const ui = accessGroupsUiLib();
    h.rulesMore.replaceChildren();
    const nodes = [];
    if (this.rulesFailure) nodes.push(ui.ragUiUnavailableAlert(this.doc, this.locale, this.rulesFailure.message, () => this.loadRules('refresh')));
    if (!this.rules) {
      if (nodes.length) h.rulesList.replaceChildren(...nodes);
      return;
    }
    const content = this.rules.rows.length
      ? this.rulesTable()
      : this.el('p', { className: 'text-sm py-4 max-w-prose', text: this.t('rules.empty'), attrs: { 'data-access-groups-rules-empty': '' } });
    if (this.rulesFailure) content.classList.add('opacity-60');
    nodes.push(content);
    h.rulesList.replaceChildren(...nodes);
    if (this.rules.rows.length > this.rulesShown) {
      const more = this.btn(this.t('action.loadMoreRules'), 'btn-outline btn-sm min-h-8 py-1', { 'data-access-groups-rules-load-more': '' }, () => {
        const first = this.rules.rows[this.rulesShown];
        this.rulesShown += ACCESS_GROUPS_PAGE;
        this.renderRules();
        if (first) this.focusRule(first.id);
      });
      h.rulesMore.replaceChildren(more);
    }
  }

  rulesTable() {
    const th = (text, extra) => this.el('th', { className: 'font-semibold ' + (extra || ''), text, attrs: { scope: 'col' } });
    const body = this.el('tbody');
    for (const rule of this.rules.rows.slice(0, this.rulesShown)) body.appendChild(this.ruleRow(rule));
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('rules.caption') }),
      this.el('thead', {}, [
        this.el('tr', {}, [th(this.t('mapping.col.source')), th(this.t('rules.col.sharedWith')), th(this.t('col.documents'), 'text-right'), th(this.t('rules.col.counts'))]),
      ]),
      body,
    ]);
    return this.scrollRegion(this.t('rules.caption'), 'data-access-groups-rules-table', table);
  }

  ruleSharedWith(rule) {
    if (rule.kind !== 'domain') return [this.doc.createTextNode(accessGroupsRuleText(rule, this.locale))];
    return accessGroupsUiLib().ragUiTemplateNodes(this.doc, this.t('rules.kind.domain'), { domain: rule.domain }, ['domain']);
  }

  ruleRow(rule) {
    const ui = accessGroupsUiLib();
    const text = accessGroupsRuleText(rule, this.locale);
    const source = accessGroupsProviderName(rule.provider);
    const toggle = this.el('input', {
      className: 'toggle toggle-sm',
      attrs: { type: 'checkbox', 'aria-label': this.t('rules.toggleAria', { rule: text, source }), 'data-access-groups-rule-toggle': rule.id },
    });
    toggle.checked = rule.enabled;
    toggle.disabled = this.ruleBusy !== null;
    toggle.addEventListener('change', () => {
      if (toggle.checked) {
        toggle.checked = false;
        this.confirmRuleOn(rule, toggle);
      } else {
        this.setRule(rule, false, toggle);
      }
    });
    return this.el('tr', { className: 'align-top', attrs: { 'data-access-groups-rule-row': rule.id } }, [
      this.el('td', { className: 'align-top break-words', text: source }),
      this.el('th', { className: 'font-normal align-top min-w-0 max-w-[14rem] sm:max-w-xs md:max-w-sm break-words', attrs: { scope: 'row' } }, this.ruleSharedWith(rule)),
      this.el('td', { className: 'text-right tabular-nums align-top', text: ui.ragUiFormatNumber(rule.documents, this.locale) }),
      this.el('td', { className: 'align-top' }, [
        this.el('label', { className: 'inline-flex items-center gap-2 cursor-pointer min-h-8' }, [
          toggle,
          this.el('span', { className: 'text-sm', text: rule.enabled ? this.t('value.on') : this.t('value.off'), attrs: { 'data-access-groups-rule-word': '' } }),
        ]),
      ]),
    ]);
  }

  focusRule(id) {
    const toggle = this.byData('data-access-groups-rule-toggle', id)[0];
    if (toggle && typeof toggle.focus === 'function') toggle.focus();
    else this.focusStatus();
  }

  async putRule(rule, enabled) {
    return this.request(ACCESS_GROUPS_PATH + '/sharing-rules/' + encodeURIComponent(rule.id) + this.orgQuery(), { method: 'PUT', body: JSON.stringify({ enabled }) });
  }

  ruleMessage(rule, enabled) {
    return this.t(enabled ? 'rules.turnedOn' : 'rules.turnedOff', { rule: accessGroupsRuleText(rule, this.locale), source: accessGroupsProviderName(rule.provider) });
  }

  applyRule(rule, result, enabled) {
    const answer = result && result.body && result.body.rule;
    rule.enabled = answer && typeof answer.enabled === 'boolean' ? answer.enabled : enabled;
  }

  async confirmRuleOn(rule, opener) {
    if (this.ruleBusy !== null) return;
    const ui = accessGroupsUiLib();
    const source = accessGroupsProviderName(rule.provider);
    const text = accessGroupsRuleText(rule, this.locale);
    let done = false;
    let followUp = null;
    const confirmed = await ui.ragUiConfirmDialog(this.doc, {
      title: this.t('rules.confirm.title'),
      body: [this.t('rules.confirm.body', { source, rule: text, count: ui.ragUiFormatNumber(rule.documents, this.locale) })],
      keepLabel: this.t('action.keepRuleOff'),
      confirmLabel: this.t('action.turnRuleOn'),
      runningLabel: this.t('save.running'),
      tone: 'primary',
      opener,
      fallbackFocus: this.statusEl(),
      onConfirm: async () => {
        this.ruleBusy = rule.id;
        let result;
        try {
          result = await this.putRule(rule, true);
        } finally {
          this.ruleBusy = null;
        }
        if (result && result.ok) {
          this.applyRule(rule, result, true);
          done = true;
          return undefined;
        }
        const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.mappingUnavailable() });
        if (mapped.reload) {
          followUp = mapped;
          return undefined;
        }
        return { keepOpen: true, message: mapped.message };
      },
    });
    if (done) {
      this.renderRules();
      this.announce(this.ruleMessage(rule, true));
      this.focusRule(rule.id);
      return;
    }
    if (followUp) {
      this.announce(followUp.message, true);
      await this.loadRules('quiet');
      this.announce(followUp.message, true);
      this.focusStatus();
      return;
    }
    if (!confirmed) this.renderRules();
  }

  async setRule(rule, enabled, toggle) {
    if (this.ruleBusy !== null) return;
    this.ruleBusy = rule.id;
    toggle.disabled = true;
    let result;
    try {
      result = await this.putRule(rule, enabled);
    } finally {
      this.ruleBusy = null;
    }
    if (result && result.ok) {
      this.applyRule(rule, result, enabled);
      this.renderRules();
      this.announce(this.ruleMessage(rule, enabled));
      this.focusRule(rule.id);
      return;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.mappingUnavailable() });
    this.renderRules();
    this.announce(mapped.message, true);
    if (mapped.reload) {
      await this.loadRules('quiet');
      this.announce(mapped.message, true);
    }
    this.focusRule(rule.id);
  }

  openRuleForm() {
    if (!this.ruleForm.open) {
      this.ruleForm = { ...this.emptyRuleForm(), open: true };
      this.renderRuleForm();
    }
    const provider = this.ruleFormHosts && this.ruleFormHosts.provider;
    if (provider) provider.focus();
  }

  closeRuleForm(focusBack) {
    this.ruleForm = this.emptyRuleForm();
    this.renderRuleForm();
    if (focusBack && this.addRuleButton) this.addRuleButton.focus();
  }

  renderRuleForm() {
    const host = this.mappingHosts.ruleForm;
    if (!host) return;
    if (!this.ruleForm.open) {
      host.replaceChildren();
      this.ruleFormHosts = null;
      if (this.addRuleButton) this.addRuleButton.setAttribute('aria-expanded', 'false');
      return;
    }
    this.addRuleButton.setAttribute('aria-expanded', 'true');
    const form = this.ruleForm;
    const provider = this.el('select', { className: 'select select-bordered select-sm w-full', id: 'rag-access-groups-rule-provider', attrs: { name: 'access-group-rule-source', 'data-access-groups-rule-provider': '' } });
    this.providerOptions(provider, form.provider);
    const domain = this.el('input', {
      className: 'input input-bordered input-sm w-full font-mono',
      id: 'rag-access-groups-rule-domain',
      attrs: {
        type: 'text',
        name: 'access-group-rule-domain',
        inputmode: 'url',
        autocomplete: 'off',
        spellcheck: 'false',
        translate: 'no',
        maxlength: '253',
        placeholder: 'example.org…',
        'aria-describedby': 'rag-access-groups-rule-domain-error',
        'data-access-groups-rule-domain': '',
      },
    });
    domain.value = form.domain;
    const error = this.el('p', { className: 'text-xs text-error mt-1 empty:hidden break-words', id: 'rag-access-groups-rule-domain-error' });
    const findings = this.el('p', { className: 'text-xs text-base-content/70 md:col-span-2 break-words empty:hidden', id: 'rag-access-groups-rule-findings' });
    const create = this.btn(this.t('action.createRule'), 'btn-primary btn-sm min-h-8 py-1', { 'aria-describedby': 'rag-access-groups-rule-findings rag-access-groups-rule-domain-error', 'data-access-groups-rule-create': '' }, () =>
      this.createRule(),
    );
    const close = this.btn(this.t('action.closeForm'), 'btn-ghost btn-sm min-h-8 py-1', { 'data-access-groups-rule-close': '' }, () => this.closeRuleForm(true));
    this.ruleFormHosts = { provider, domain, error, findings, create, close };
    provider.addEventListener('change', () => {
      form.provider = accessGroupsText(provider.value);
      this.updateRuleFindings();
    });
    domain.addEventListener('input', () => {
      form.domain = accessGroupsText(domain.value);
      form.error = null;
      this.updateRuleFindings();
    });
    this.formKeys([provider, domain], () => this.closeRuleForm(true));
    host.replaceChildren(
      this.el('div', { className: 'bg-base-100 rounded-lg p-4 mt-4 grid gap-x-6 gap-y-3 md:grid-cols-2 min-w-0', attrs: { 'data-access-groups-rule-form': '' } }, [
        this.formField('rag-access-groups-rule-provider', this.t('mapping.col.source'), provider),
        this.formField('rag-access-groups-rule-domain', this.t('rules.form.domain'), domain, [error]),
        findings,
        this.el('div', { className: 'md:col-span-2 flex flex-wrap gap-2' }, [create, close]),
      ]),
    );
    this.updateRuleFindings();
  }

  ruleFormState() {
    const form = this.ruleForm;
    const missing = [];
    if (!ACCESS_GROUPS_PROVIDERS.includes(form.provider)) missing.push(this.t('mapping.col.source'));
    if (!form.domain.trim()) missing.push(this.t('rules.form.domain'));
    const normalized = accessGroupsNormalizeDomain(form.domain);
    const bad = Boolean(form.domain.trim()) && !normalized;
    return { missing, normalized, bad, valid: missing.length === 0 && !bad };
  }

  updateRuleFindings() {
    const h = this.ruleFormHosts;
    if (!h) return;
    const form = this.ruleForm;
    const state = this.ruleFormState();
    h.findings.textContent = state.missing.length ? this.t('rules.need', { fields: this.joinFields(state.missing) }) : '';
    const message = form.error || (state.bad ? this.t('rules.badDomain') : '');
    h.error.textContent = message;
    if (message) h.domain.setAttribute('aria-invalid', 'true');
    else h.domain.removeAttribute('aria-invalid');
    h.domain.classList.toggle('input-error', Boolean(message));
    h.create.disabled = !state.valid || form.busy;
  }

  async createRule() {
    const h = this.ruleFormHosts;
    const form = this.ruleForm;
    const state = this.ruleFormState();
    if (!h || form.busy || !state.valid) return;
    const ui = accessGroupsUiLib();
    form.busy = true;
    const restore = ui.ragUiButtonBusy(this.doc, h.create, this.t('create.running'), [h.close]);
    let result;
    try {
      result = await this.request(ACCESS_GROUPS_PATH + '/sharing-rules' + this.orgQuery(), {
        method: 'POST',
        body: JSON.stringify({ provider: form.provider, kind: 'domain', domain: state.normalized }),
      });
    } finally {
      form.busy = false;
      restore();
    }
    if (this.ruleForm !== form) return;
    if (result && result.ok) {
      const rule = { kind: 'domain', domain: state.normalized, provider: form.provider };
      const message = this.t('rules.created', { rule: accessGroupsRuleText(rule, this.locale), source: accessGroupsProviderName(form.provider) });
      this.closeRuleForm(false);
      await this.loadRules('quiet');
      this.announce(message);
      this.focusStatus();
      return;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.mappingUnavailable() });
    if (mapped.kind === 'field' && mapped.field === 'domain') {
      form.error = mapped.message;
      this.updateRuleFindings();
      this.announce(mapped.message, true);
      h.domain.focus();
      return;
    }
    this.updateRuleFindings();
    this.announce(mapped.message, true);
    if (mapped.reload) {
      await this.loadRules('quiet');
      this.announce(mapped.message, true);
    }
  }

  selectMapping() {
    if (!this.tabs || !this.tabs.panels.mapping) return false;
    this.tabs.select('mapping');
    const heading = this.tabs.panels.mapping.querySelector('[data-access-groups-mapping-heading]') || this.doc.getElementById('rag-access-groups-tab-mapping');
    if (heading && typeof heading.focus === 'function') heading.focus();
    return true;
  }

  fieldMode() {
    return this.multiTenant() ? 'org' : 'single';
  }

  groupOptions() {
    return this.groups && !this.groups.personal ? this.groups.rows.map((r) => ({ id: r.id, name: r.name })) : [];
  }

  docsUnavailable() {
    return this.t('docs.unavailable', { reload: this.t('action.reload') });
  }

  findDoc(id) {
    return this.docs ? this.docs.rows.find((r) => r.id === id) || null : null;
  }

  resetDocuments() {
    this.docs = null;
    this.docsFailure = null;
    this.docsUpdatedAt = null;
    this.docEditor = null;
    this.docSelected.clear();
    if (this.bulk) this.bulk.dialog.close('keep');
    this.renderDocuments();
  }

  buildDocuments(panel) {
    const ui = accessGroupsUiLib();
    const filterName = ui.ragUiNextId('rag-access-groups-doc-filter');
    this.docFilterInputs = {};
    const filters = this.el('fieldset', { className: 'flex flex-wrap gap-2 min-w-0', attrs: { 'data-access-groups-doc-filters': '' } }, [
      this.el('legend', { className: 'sr-only', text: this.t('docs.filterLabel') }),
    ]);
    for (const value of ACCESS_GROUPS_DOC_FILTERS) {
      const input = this.el('input', {
        className: 'btn btn-sm h-auto min-h-8 py-1',
        attrs: { type: 'radio', name: filterName, value, 'aria-label': this.t(ACCESS_GROUPS_FILTER_KEYS[value]), 'data-access-groups-doc-filter': value },
      });
      input.checked = value === this.docFilter;
      input.addEventListener('change', () => {
        if (input.checked) this.setDocFilter(value);
      });
      this.docFilterInputs[value] = input;
      filters.appendChild(input);
    }
    const searchId = 'rag-access-groups-doc-search';
    this.docSearch = this.el('input', {
      className: 'input input-bordered input-sm w-full sm:w-64',
      id: searchId,
      attrs: { type: 'search', maxlength: '200', autocomplete: 'off', spellcheck: 'false', name: 'access-groups-document-search', 'data-access-groups-doc-search': '' },
    });
    this.docSearch.addEventListener('input', () => this.onDocSearchInput());
    this.docSearch.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      this.runDocSearch();
    });
    const search = this.el('div', { className: 'form-control min-w-0' }, [
      this.el('label', { className: 'label py-1', attrs: { for: searchId } }, [this.el('span', { className: 'label-text text-sm', text: this.t('docs.search') })]),
      this.docSearch,
    ]);
    this.docsUpdated = this.el('span', { className: 'text-xs text-base-content/70', attrs: { 'data-access-groups-docs-updated': '' } });
    this.refreshDocsButton = this.btn(this.t('action.refreshDocuments'), 'btn-outline btn-sm min-h-8 py-1', { 'data-access-groups-docs-refresh': '' }, () => this.loadDocuments('refresh'));
    this.docHosts.toolbar = this.el('div', { className: 'flex flex-wrap items-end gap-3 min-w-0' }, [
      filters,
      search,
      this.el('div', { className: 'flex flex-wrap items-center gap-2 ml-auto' }, [this.docsUpdated, this.refreshDocsButton]),
    ]);
    this.selectionCount = this.el('span', { className: 'text-sm font-medium tabular-nums', attrs: { 'data-access-groups-selected-count': '' } });
    this.changeAccessButton = this.btn(this.t('action.changeAccess'), 'btn-outline btn-sm min-h-8 py-1', { 'data-access-groups-change-access': '' }, () => this.openBulk());
    this.clearSelectionButton = this.btn(this.t('action.clearSelection'), 'btn-ghost btn-sm min-h-8 py-1', { 'data-access-groups-clear-selection': '' }, () => this.clearSelection(true));
    this.docHosts.selection = this.el('div', { className: 'flex flex-wrap items-center gap-2 mt-4 rounded bg-base-200 px-3 py-2 min-w-0', attrs: { 'data-access-groups-selection': '' } }, [
      this.selectionCount,
      this.el('div', { className: 'flex flex-wrap gap-2' }, [this.changeAccessButton, this.clearSelectionButton]),
    ]);
    this.docHosts.selection.hidden = true;
    this.docHosts.list = this.el('div', { className: 'min-w-0 mt-4', attrs: { 'data-access-groups-docs': '' } });
    this.docHosts.more = this.el('div', { className: 'mt-4 empty:hidden', attrs: { 'data-access-groups-docs-more': '' } });
    panel.replaceChildren(this.docHosts.toolbar, this.docHosts.selection, this.docHosts.list, this.docHosts.more);
  }

  setDocFilter(value) {
    if (!ACCESS_GROUPS_DOC_FILTERS.includes(value) || value === this.docFilter) return;
    this.docFilter = value;
    this.loadDocuments('filter');
  }

  onDocSearchInput() {
    if (this.docSearchTimer !== null) clearTimeout(this.docSearchTimer);
    this.docSearchTimer = setTimeout(() => {
      this.docSearchTimer = null;
      this.runDocSearch();
    }, ACCESS_GROUPS_SEARCH_WAIT_MS);
  }

  runDocSearch() {
    if (this.docSearchTimer !== null) {
      clearTimeout(this.docSearchTimer);
      this.docSearchTimer = null;
    }
    const q = accessGroupsText(this.docSearch.value).trim().slice(0, 200);
    if (q === this.docQuery && this.docs) return;
    this.docQuery = q;
    this.loadDocuments('filter');
  }

  async loadDocuments(source) {
    const ui = accessGroupsUiLib();
    const host = this.docHosts.list;
    if (!host) return false;
    this.docsRequested = true;
    const seq = ++this.docsSeq;
    const append = source === 'more' && this.docs && this.docs.nextCursor;
    if (source === 'filter') {
      this.docEditor = null;
      this.docSelected.clear();
    }
    let restore = null;
    if (append) {
      restore = this.docsMoreButton ? ui.ragUiButtonBusy(this.doc, this.docsMoreButton, this.t('docs.loading')) : null;
    } else if (!this.docs && !this.docsFailure) {
      ui.ragUiListLoading(this.doc, host, this.t('docs.loading'));
      if (source !== 'quiet') this.announce(this.t('docs.loading'));
    } else {
      ui.ragUiListBusy(host, true);
      if (this.refreshDocsButton && source !== 'quiet') restore = ui.ragUiButtonBusy(this.doc, this.refreshDocsButton, this.t('docs.loading'));
    }
    let result;
    try {
      const query = { filter: this.docFilter, q: this.docQuery || null, cursor: append ? this.docs.nextCursor : null };
      result = await this.request(ACCESS_GROUPS_PATH + '/documents' + this.orgQuery(query), { method: 'GET' });
    } finally {
      if (restore) restore();
    }
    if (seq !== this.docsSeq) return false;
    ui.ragUiListBusy(host, false);
    if (result && result.ok && result.body && typeof result.body === 'object') {
      const list = buildAccessGroupsDocumentsList(result.body);
      let firstNew = null;
      if (append) {
        const seen = new Set(this.docs.rows.map((r) => r.id));
        const fresh = list.rows.filter((r) => !seen.has(r.id));
        firstNew = fresh[0] || null;
        this.docs = { ...list, rows: [...this.docs.rows, ...fresh] };
      } else {
        this.docs = list;
      }
      this.docsFailure = null;
      this.docsUpdatedAt = new Date();
      for (const id of [...this.docSelected.keys()]) {
        const row = this.findDoc(id);
        if (!row || row.connectorManaged) this.docSelected.delete(id);
        else this.docSelected.set(id, row);
      }
      if (this.docEditor && !this.findDoc(this.docEditor.id)) this.docEditor = null;
      this.renderDocuments();
      if (source !== 'quiet') this.announce(this.t('docs.loaded', { count: ui.ragUiFormatNumber(this.docs.rows.length, this.locale) }));
      if (firstNew) this.focusDocRow(firstNew.id);
      else if (append) this.focusStatus();
      return true;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { unavailable: this.docsUnavailable() });
    this.docsFailure = mapped.kind === 'unavailable' || mapped.kind === 'network' ? { ...mapped, kind: 'unavailable', message: this.docsUnavailable() } : mapped;
    this.renderDocuments();
    this.announce(this.docsFailure.message, true);
    return false;
  }

  focusDocRow(id) {
    const row = this.byData('data-access-groups-doc-row', id)[0];
    if (!row) return;
    const target = Array.from(row.querySelectorAll('input, button')).find((n) => !n.disabled);
    if (target) target.focus();
  }

  focusEditAccess(id) {
    const button = this.byData('data-access-groups-edit-access', id)[0];
    if (button && !button.disabled) button.focus();
    else this.focusStatus();
  }

  renderDocuments() {
    const ui = accessGroupsUiLib();
    const host = this.docHosts.list;
    if (!host) return;
    const failure = this.docsFailure;
    const replaced = Boolean(failure && (failure.kind === 'signIn' || failure.kind === 'workspace'));
    const personal = Boolean(this.docs && this.docs.personal);
    this.docHosts.toolbar.hidden = replaced || personal;
    if (this.docsUpdatedAt && !replaced) {
      this.docsUpdated.replaceChildren(...this.withNode(this.t('panel.updated'), 'time', this.timeEl(this.docsUpdatedAt)));
    } else this.docsUpdated.replaceChildren();
    this.docsMoreButton = null;
    this.docHosts.more.replaceChildren();
    this.updateSelectionUi(false);
    if (replaced) {
      host.replaceChildren(
        failure.kind === 'signIn'
          ? ui.ragUiSignInAlert(this.doc, this.locale, () => this.loadDocuments('refresh'))
          : ui.ragUiAlert(this.doc, { tone: 'warning', icon: 'person-lock', body: [failure.message], actions: [ui.ragUiReloadButton(this.doc, this.locale, () => this.loadDocuments('refresh'))] }),
      );
      return;
    }
    const nodes = [];
    if (failure) nodes.push(ui.ragUiUnavailableAlert(this.doc, this.locale, failure.message, () => this.loadDocuments('refresh')));
    if (!this.docs) {
      host.replaceChildren(...nodes);
      return;
    }
    if (personal) {
      nodes.push(ui.ragUiAlert(this.doc, { tone: 'info', icon: 'person', body: [this.t('groups.personal')] }));
      host.replaceChildren(...nodes);
      return;
    }
    const content = this.docs.rows.length ? this.docsTable() : this.docsEmpty();
    if (failure) content.classList.add('opacity-60');
    nodes.push(content);
    host.replaceChildren(...nodes);
    this.updateSelectionUi(false);
    if (this.docs.nextCursor) {
      this.docsMoreButton = this.btn(this.t('action.loadMoreDocuments'), 'btn-outline btn-sm min-h-8 py-1', { 'data-access-groups-docs-load-more': '' }, () => this.loadDocuments('more'));
      this.docHosts.more.replaceChildren(this.docsMoreButton);
    }
  }

  docsEmpty() {
    const restricted = this.docFilter === 'restricted' && !this.docQuery;
    return this.el('div', { className: 'py-8 text-center', attrs: { 'data-access-groups-docs-empty': restricted ? 'restricted' : 'filter' } }, restricted
      ? [
          this.el('p', { className: 'text-base font-semibold text-balance', text: this.t('docs.empty.restricted.title') }),
          this.el('p', { className: 'text-sm max-w-prose mx-auto mt-1', text: this.t('docs.empty.restricted.body') }),
        ]
      : [this.el('p', { className: 'text-sm max-w-prose mx-auto', text: this.t('docs.empty.filter') })]);
  }

  docsTable() {
    const th = (text, extra) => this.el('th', { className: 'font-semibold ' + (extra || ''), text, attrs: { scope: 'col' } });
    this.docHeaderCheckbox = this.el('input', { className: 'checkbox checkbox-sm', attrs: { type: 'checkbox', 'aria-label': this.t('select.allAria'), 'data-access-groups-select-all': '' } });
    this.docHeaderCheckbox.addEventListener('change', () => this.toggleAll(this.docHeaderCheckbox.checked));
    const body = this.el('tbody');
    for (const row of this.docs.rows) {
      body.appendChild(this.docRow(row));
      if (this.docEditor && this.docEditor.id === row.id) {
        body.appendChild(
          this.el('tr', { attrs: { 'data-access-groups-doc-editor': row.id } }, [
            this.el('td', { className: 'p-2 md:p-3', attrs: { colspan: String(ACCESS_GROUPS_DOC_COLUMNS) } }, [this.docEditor.container]),
          ]),
        );
      }
    }
    const table = this.el('table', { className: 'table table-sm' }, [
      this.el('caption', { className: 'sr-only', text: this.t('docs.caption') }),
      this.el('thead', {}, [
        this.el('tr', {}, [
          this.el('th', { className: 'w-10', attrs: { scope: 'col' } }, [this.docHeaderCheckbox]),
          th(this.t('col.file')),
          th(this.t('col.docType'), 'hidden lg:table-cell'),
          th(this.t('audience.label'), 'hidden md:table-cell'),
          th(this.t('col.source'), 'hidden lg:table-cell'),
          th(this.t('col.actions')),
        ]),
      ]),
      body,
    ]);
    return this.el(
      'div',
      {
        className: 'overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        attrs: { tabindex: '0', role: 'region', 'aria-label': this.t('docs.caption'), 'data-access-groups-docs-table': '' },
      },
      [table],
    );
  }

  docRow(row) {
    const ui = accessGroupsUiLib();
    const view = buildAccessGroupsAudienceView(row, this.locale);
    const source = accessGroupsSourceLabel(row.source, this.locale);
    const check = this.el('input', { className: 'checkbox checkbox-sm', attrs: { type: 'checkbox', 'aria-label': this.t('select.aria', { file: row.filename }), 'data-access-groups-select': row.id } });
    check.checked = this.docSelected.has(row.id);
    check.disabled = row.connectorManaged;
    check.addEventListener('change', () => this.toggleRow(row.id, check.checked));
    const fileCell = this.el('th', { className: 'font-normal align-top min-w-0 max-w-[16rem] sm:max-w-sm md:max-w-md', attrs: { scope: 'row' } }, [
      this.el('span', { className: 'block text-sm break-words', text: row.filename, attrs: { translate: 'no', 'data-access-groups-doc-name': '' } }),
    ]);
    if (source) fileCell.appendChild(this.el('span', { className: 'block text-xs text-base-content/70 break-words lg:hidden', text: source }));
    fileCell.appendChild(AccessGroupsAudienceLine(this.doc, view, 'mt-1 md:hidden'));
    const actions = [];
    const notes = [];
    const managedId = row.connectorManaged ? ui.ragUiNextId('rag-access-groups-managed') : null;
    if (view.action === 'openMapping') {
      const mapping = this.btn(this.t('action.openMapping'), 'btn-outline md:btn-sm md:min-h-8 py-1', { 'data-access-groups-open-mapping': row.id, 'aria-describedby': managedId });
      mapping.disabled = !(this.tabs && this.tabs.panels.mapping);
      mapping.addEventListener('click', () => this.selectMapping());
      actions.push(mapping);
    }
    if (view.action !== 'openMapping' || row.connectorManaged) {
      const editing = Boolean(this.docEditor && this.docEditor.id === row.id);
      const edit = this.btn(this.t('action.editAccess'), 'btn-outline md:btn-sm md:min-h-8 py-1', {
        'aria-label': this.t('action.editAccessAria', { file: row.filename }),
        'aria-describedby': managedId,
        'data-access-groups-edit-access': row.id,
      });
      edit.disabled = row.connectorManaged || editing;
      edit.addEventListener('click', () => this.openEditor(row.id));
      actions.push(edit);
    }
    if (row.connectorManaged) notes.push(this.el('p', { className: 'text-xs text-base-content/70 break-words max-w-xs', id: managedId, text: this.t('docs.connectorManaged'), attrs: { 'data-access-groups-managed': '' } }));
    return this.el('tr', { className: 'align-top', attrs: { 'data-access-groups-doc-row': row.id } }, [
      this.el('td', { className: 'align-top' }, [check]),
      fileCell,
      this.el('td', { className: 'hidden lg:table-cell break-words', text: row.docType }),
      this.el('td', { className: 'hidden md:table-cell min-w-0 max-w-md', attrs: { 'data-access-groups-visible-to': row.id } }, [AccessGroupsAudienceLine(this.doc, view)]),
      this.el('td', { className: 'hidden lg:table-cell break-words', text: source }),
      this.el('td', { className: 'min-w-0' }, [this.el('div', { className: 'flex flex-col md:flex-row flex-wrap gap-2' }, actions), ...notes]),
    ]);
  }

  // Selection (UI-SPEC 6.4 Selection, 9.10)

  selectableRows() {
    return this.docs ? this.docs.rows.filter((r) => !r.connectorManaged) : [];
  }

  toggleRow(id, checked) {
    const row = this.findDoc(id);
    if (!row || row.connectorManaged) return;
    const before = this.docSelected.size;
    if (checked) this.docSelected.set(id, row);
    else this.docSelected.delete(id);
    if (this.docEditor) {
      this.docEditor = null;
      this.renderDocuments();
      const box = this.byData('data-access-groups-select', id)[0];
      if (box) box.focus();
    }
    this.updateSelectionUi(before === 0 && this.docSelected.size > 0);
  }

  toggleAll(checked) {
    const before = this.docSelected.size;
    for (const row of this.selectableRows()) {
      if (checked) this.docSelected.set(row.id, row);
      else this.docSelected.delete(row.id);
    }
    if (this.docEditor) {
      this.docEditor = null;
      this.renderDocuments();
      if (this.docHeaderCheckbox) this.docHeaderCheckbox.focus();
    }
    for (const box of Array.from(this.root.querySelectorAll('[data-access-groups-select]'))) box.checked = this.docSelected.has(box.getAttribute('data-access-groups-select'));
    this.updateSelectionUi(before === 0 && this.docSelected.size > 0);
  }

  clearSelection(focusBack) {
    this.docSelected.clear();
    for (const box of Array.from(this.root.querySelectorAll('[data-access-groups-select]'))) box.checked = false;
    this.updateSelectionUi(false);
    if (focusBack) {
      const first = Array.from(this.root.querySelectorAll('[data-access-groups-select]')).find((b) => !b.disabled);
      if (first) first.focus();
      else this.focusStatus();
    }
  }

  updateSelectionUi(announce) {
    const count = this.docSelected.size;
    if (this.docHosts.selection) this.docHosts.selection.hidden = count === 0;
    if (this.selectionCount) this.selectionCount.textContent = this.countText('bulk.selected', count);
    if (this.docHeaderCheckbox) {
      const shown = this.selectableRows();
      const ticked = shown.filter((r) => this.docSelected.has(r.id)).length;
      this.docHeaderCheckbox.checked = shown.length > 0 && ticked === shown.length;
      this.docHeaderCheckbox.indeterminate = ticked > 0 && ticked < shown.length;
      this.docHeaderCheckbox.disabled = shown.length === 0;
    }
    if (announce) this.announce(this.countText('bulk.selected', count));
  }

  // Editor row (UI-SPEC 6.4, 6.2.2)

  newField(rows, many) {
    const init = accessGroupsInitialChoice(rows);
    const known = [];
    for (const r of rows) for (const g of r.groups) known.push(g);
    return new AccessGroupsAudienceField(this, {
      groups: this.groupOptions(),
      known,
      choice: init.choice,
      chips: init.chips,
      mixed: init.mixed,
      restrictedNow: rows.some((r) => r.kind !== 'everyone'),
      many,
      mode: this.fieldMode(),
    });
  }

  openEditor(id) {
    const row = this.findDoc(id);
    if (!row || row.connectorManaged) return;
    if (this.docSelected.size) this.clearSelection(false);
    const ui = accessGroupsUiLib();
    const field = this.newField([row], false);
    const titleId = ui.ragUiNextId('rag-access-groups-edit-title');
    const save = this.btn(this.t('action.saveAccess'), 'btn-primary btn-sm min-h-8 py-1', { 'data-access-groups-save-access': id });
    const cancel = this.btn(this.t('action.cancelEditing'), 'btn-ghost btn-sm min-h-8 py-1', { 'data-access-groups-cancel-access': id });
    const errorHost = this.el('div', { className: 'empty:hidden mt-3', attrs: { role: 'alert' } });
    const current = row.kind === 'uploader_only'
      ? this.el('div', { className: 'mb-3 min-w-0' }, [this.el('p', { className: 'text-xs text-base-content/70', text: this.t('field.current') }), AccessGroupsAudienceLine(this.doc, buildAccessGroupsAudienceView(row, this.locale))])
      : null;
    const container = this.el('div', { className: 'bg-base-100 p-4 rounded min-w-0', attrs: { role: 'group', 'aria-labelledby': titleId, 'data-access-groups-editor': id } }, [
      this.el('h4', { className: 'text-base font-semibold mb-3 break-words text-balance', id: titleId, text: this.t('edit.title', { file: row.filename }) }),
      current,
      field.element,
      errorHost,
      this.el('div', { className: 'flex flex-wrap gap-2 mt-4' }, [save, cancel]),
    ]);
    container.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || (this.docEditor && this.docEditor.busy)) return;
      if (event.defaultPrevented) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      this.closeEditor(true);
    });
    field.bindSave(save);
    save.addEventListener('click', () => this.saveEditor());
    cancel.addEventListener('click', () => this.closeEditor(true));
    this.docEditor = { id, row, field, save, cancel, errorHost, container, busy: false };
    this.renderDocuments();
    field.focusFirst();
  }

  closeEditor(focusBack) {
    const id = this.docEditor ? this.docEditor.id : null;
    this.docEditor = null;
    this.renderDocuments();
    if (focusBack && id) this.focusEditAccess(id);
  }

  async putAccess(body) {
    return this.request(ACCESS_GROUPS_PATH + '/documents/access' + this.orgQuery(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async groupsGone(field, errorHost, message) {
    errorHost.replaceChildren(this.el('p', { className: 'text-sm text-error break-words', text: message }));
    this.announce(message, true);
    await this.loadGroups('quiet');
    field.setGroups(this.groupOptions());
    this.announce(message, true);
  }

  async saveEditor() {
    const ed = this.docEditor;
    if (!ed || ed.busy) return;
    const value = ed.field.value();
    const body = accessGroupsAccessBody([ed.id], value.choice, value.chips);
    if (!body) return;
    ed.busy = true;
    ed.errorHost.replaceChildren();
    const restore = accessGroupsUiLib().ragUiButtonBusy(this.doc, ed.save, this.t('save.running'), [ed.cancel]);
    const result = await this.putAccess(body);
    restore();
    ed.busy = false;
    ed.field.update();
    if (this.docEditor !== ed) return;
    if (result && result.ok && result.body && typeof result.body === 'object') {
      const audiences = (Array.isArray(result.body.audiences) ? result.body.audiences : []).map(buildAccessGroupsDocumentRow).filter(Boolean);
      const fresh = audiences.find((a) => a.id === ed.id);
      if (!fresh) {
        this.docEditor = null;
        const skipped = accessGroupsCount(result.body.skipped) > 0;
        this.announce(this.t(skipped ? 'docs.connectorManaged' : 'error.changed'), true);
        await this.loadDocuments('quiet');
        return;
      }
      const index = this.docs.rows.findIndex((r) => r.id === ed.id);
      if (index >= 0) this.docs.rows[index] = fresh;
      this.docEditor = null;
      this.renderDocuments();
      const view = buildAccessGroupsAudienceView(fresh, this.locale);
      this.announce(this.t('save.done', { file: fresh.filename, audience: view.summary }));
      this.focusEditAccess(ed.id);
      return;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.docsUnavailable() });
    if (mapped.kind === 'groupGone') {
      await this.groupsGone(ed.field, ed.errorHost, mapped.message);
      return;
    }
    if (mapped.reload) {
      this.docEditor = null;
      this.focusStatus();
      this.announce(mapped.message, true);
      await this.loadDocuments('quiet');
      this.announce(mapped.message, true);
      return;
    }
    ed.errorHost.replaceChildren(this.el('p', { className: 'text-sm text-error break-words', text: mapped.message }));
    this.announce(mapped.message, true);
  }

  // Bulk dialog (D-17, UI-SPEC decision 7)

  openBulk() {
    if (this.bulk || this.docSelected.size === 0) return;
    const ui = accessGroupsUiLib();
    const rows = [...this.docSelected.values()];
    const field = this.newField(rows, true);
    const titleId = ui.ragUiNextId('rag-access-groups-bulk-title');
    const countId = ui.ragUiNextId('rag-access-groups-bulk-count');
    const dialog = this.el('dialog', { className: 'modal', attrs: { 'aria-labelledby': titleId, 'aria-describedby': countId, 'data-access-groups-bulk-dialog': '' } });
    const keep = this.btn(this.t('action.keepAccess'), 'btn-sm min-h-8 py-1', { 'data-access-groups-keep-access': '' });
    const save = this.btn(this.t('action.saveAccess'), 'btn-primary btn-sm min-h-8 py-1', { 'data-access-groups-bulk-save': '' });
    const errorHost = this.el('div', { className: 'empty:hidden mt-3', attrs: { role: 'alert' } });
    const backdropButton = this.el('button', { className: 'cursor-default', text: this.t('action.keepAccess'), attrs: { type: 'submit', tabindex: '-1' } });
    const backdrop = this.el('form', { className: 'modal-backdrop', attrs: { method: 'dialog' } }, [backdropButton]);
    const box = this.el('div', { className: 'modal-box min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain' }, [
      this.el('h3', { className: 'text-base font-semibold mb-1 break-words text-balance', id: titleId, text: this.t('bulk.title') }),
      this.el('p', { className: 'text-sm mb-4 tabular-nums', id: countId, text: this.countText('bulk.selected', rows.length) }),
      field.element,
      errorHost,
      this.el('div', { className: 'modal-action flex-wrap gap-2' }, [keep, save]),
    ]);
    dialog.appendChild(box);
    dialog.appendChild(backdrop);
    const state = { dialog, field, keep, save, errorHost, rows, running: false, done: null, followUp: null, finished: false, opener: this.changeAccessButton };
    this.bulk = state;
    field.bindSave(save);
    dialog.addEventListener('cancel', (event) => {
      if (state.running && typeof event.preventDefault === 'function') event.preventDefault();
    });
    backdrop.addEventListener('submit', (event) => {
      if (state.running && typeof event.preventDefault === 'function') event.preventDefault();
    });
    dialog.addEventListener('close', () => this.finishBulk(state));
    keep.addEventListener('click', () => {
      if (!state.running) dialog.close('keep');
    });
    save.addEventListener('click', () => this.saveBulk(state));
    this.doc.body.appendChild(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    keep.focus();
  }

  async saveBulk(state) {
    if (state.running) return;
    const value = state.field.value();
    const body = accessGroupsAccessBody(state.rows.map((r) => r.id), value.choice, value.chips);
    if (!body) return;
    state.running = true;
    state.errorHost.replaceChildren();
    const restore = accessGroupsUiLib().ragUiButtonBusy(this.doc, state.save, this.t('save.running'), [state.keep]);
    const result = await this.putAccess(body);
    restore();
    state.running = false;
    state.field.update();
    if (result && result.ok && result.body && typeof result.body === 'object') {
      state.done = { changed: accessGroupsCount(result.body.changed), skipped: accessGroupsCount(result.body.skipped) };
      state.dialog.close('save');
      return;
    }
    const mapped = mapAccessGroupsError(result, this.locale, { write: true, unavailable: this.docsUnavailable() });
    if (mapped.kind === 'groupGone') {
      await this.groupsGone(state.field, state.errorHost, mapped.message);
      return;
    }
    if (mapped.reload) {
      state.followUp = mapped;
      state.dialog.close('keep');
      return;
    }
    state.errorHost.replaceChildren(this.el('p', { className: 'text-sm text-error break-words', text: mapped.message }));
  }

  async finishBulk(state) {
    if (state.finished) return;
    state.finished = true;
    state.dialog.remove();
    if (this.bulk === state) this.bulk = null;
    if (state.done) {
      const ui = accessGroupsUiLib();
      let message = this.t('save.doneMany', { count: ui.ragUiFormatNumber(state.done.changed, this.locale) });
      if (state.done.skipped > 0) message += ' ' + this.t('save.skipped', { count: ui.ragUiFormatNumber(state.done.skipped, this.locale) });
      this.clearSelection(false);
      this.focusStatus();
      this.announce(message);
      await this.loadDocuments('quiet');
      this.announce(message);
      return;
    }
    if (state.followUp) {
      this.clearSelection(false);
      this.focusStatus();
      this.announce(state.followUp.message, true);
      await this.loadDocuments('quiet');
      this.announce(state.followUp.message, true);
      return;
    }
    const target = state.opener && state.opener.isConnected !== false && this.docSelected.size > 0 ? state.opener : this.statusEl();
    if (target && typeof target.focus === 'function') target.focus();
  }
}

/*
 * Upload queue control, stored-documents badge and Connectors notice (UI-SPEC 6.7, 6.8; D-16, D-20, D-22). Everything here is
 * built with the rag-ui.js element builder and appended after the host's own markup is set; no value goes through a template string.
 */

const ACCESS_GROUPS_QUEUE_PAGES = 20;
const ACCESS_GROUPS_QUEUE_PAGE_SIZE = 50;
const ACCESS_GROUPS_UPLOAD_MAX_GROUPS = 50;
const ACCESS_GROUPS_BADGE_IDS_MAX = 200;
const ACCESS_GROUPS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function accessGroupsDocOf(node) {
  return (node && (node.ownerDocument || node.doc)) || (typeof document !== 'undefined' ? document : null);
}

/** The options the queue control needs from the groups answer: shown only with the switch on and at least one group (D-16). */
function accessGroupsQueueOptions(body) {
  const b = body && typeof body === 'object' ? body : {};
  const enabled = b.enabled === true;
  const groups = [];
  const seen = new Set();
  for (const group of Array.isArray(b.groups) ? b.groups : []) {
    const id = group && accessGroupsText(group.id);
    if (!id || !ACCESS_GROUPS_UUID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    groups.push({ id, name: accessGroupsText(group.name) || accessGroupsText(group.key) || id });
  }
  const personal = b.personal === true;
  return { enabled, personal, groups, shown: enabled && !personal && groups.length > 0 };
}

/** Every group of the workspace, page by page (the Config UI operator is an admin). Any failure hides the control. */
async function accessGroupsLoadQueueOptions(organizationId) {
  const ui = accessGroupsUiLib();
  const hidden = { enabled: false, personal: false, groups: [], shown: false };
  const all = [];
  let first = null;
  let cursor = null;
  for (let page = 0; page < ACCESS_GROUPS_QUEUE_PAGES; page += 1) {
    const params = new URLSearchParams();
    if (organizationId) params.set('organizationId', String(organizationId));
    params.set('limit', String(ACCESS_GROUPS_QUEUE_PAGE_SIZE));
    if (cursor) params.set('cursor', cursor);
    const result = await ui.ragUiRagRequest(ACCESS_GROUPS_PATH + '?' + params.toString(), { method: 'GET' });
    if (!result || !result.ok || !result.body) return hidden;
    if (!first) first = result.body;
    if (Array.isArray(result.body.groups)) all.push(...result.body.groups);
    cursor = accessGroupsText(result.body.nextCursor);
    if (!cursor || first.enabled !== true || first.personal === true) break;
  }
  return accessGroupsQueueOptions({ ...first, groups: all });
}

/** The item's choice: untouched (nothing sent), everyone, or groups (ids of offered groups only). */
function accessGroupsQueueValue(item, groups) {
  const raw = item && item.accessChoice && typeof item.accessChoice === 'object' ? item.accessChoice : null;
  if (!raw) return { mode: 'untouched', groupIds: [] };
  if (raw.mode === 'everyone') return { mode: 'everyone', groupIds: [] };
  if (raw.mode !== 'groups') return { mode: 'untouched', groupIds: [] };
  const known = Array.isArray(groups) ? new Set(groups.map((g) => g.id)) : null;
  const ids = [];
  for (const id of Array.isArray(raw.groupIds) ? raw.groupIds : []) {
    const value = accessGroupsText(id);
    if (!value || ids.includes(value) || (known && !known.has(value))) continue;
    ids.push(value);
  }
  return ids.length ? { mode: 'groups', groupIds: ids.slice(0, ACCESS_GROUPS_UPLOAD_MAX_GROUPS) } : { mode: 'untouched', groupIds: [] };
}

/**
 * UI-SPEC 6.2.3: ticking Everyone unticks every group; ticking a group unticks Everyone; unticking the last group (or Everyone)
 * returns to untouched; target 'clear' is Clear choice.
 */
function accessGroupsQueueToggle(value, target, checked) {
  const current = value && typeof value === 'object' ? value : { mode: 'untouched', groupIds: [] };
  if (target === 'clear') return { mode: 'untouched', groupIds: [] };
  if (target === 'everyone') return checked ? { mode: 'everyone', groupIds: [] } : { mode: 'untouched', groupIds: [] };
  const id = accessGroupsText(target);
  if (!id) return current;
  const ids = current.mode === 'groups' ? current.groupIds.filter((g) => g !== id) : [];
  if (checked && ids.length < ACCESS_GROUPS_UPLOAD_MAX_GROUPS) ids.push(id);
  return ids.length ? { mode: 'groups', groupIds: ids } : { mode: 'untouched', groupIds: [] };
}

/** The `access` form field (04.3-23): null while the control is hidden or the item is untouched, else the JSON of the choice. */
function accessGroupsQueueUploadField(item, picker) {
  const options = picker && picker.access;
  if (!options || options.shown !== true) return null;
  const value = accessGroupsQueueValue(item, options.groups);
  if (value.mode === 'everyone') return JSON.stringify({ everyone: true });
  if (value.mode === 'groups') return JSON.stringify({ groupIds: value.groupIds });
  return null;
}

/** The upload refusal of a group the operator may not assign (UI-SPEC 8.2); null for every other answer. */
function accessGroupsQueueErrorText(code, locale) {
  return code === 'group_not_allowed' ? accessGroupsLabel('error.groupNotAllowed', accessGroupsLocale(locale)) : null;
}

function accessGroupsQueueTrigger(value, locale) {
  if (value.mode === 'everyone') return { icon: 'people', text: accessGroupsLabel('picker.everyone', locale) };
  if (value.mode === 'groups') return { icon: 'lock', text: accessGroupsLabel('picker.groups', locale, { n: accessGroupsUiLib().ragUiFormatNumber(value.groupIds.length, locale) }) };
  return { icon: 'people', text: accessGroupsLabel('picker.trigger', locale) };
}

function accessGroupsQueueRender(doc, wrap, item, options, locale, focusKey) {
  const ui = accessGroupsUiLib();
  const el = (tag, opts, children) => ui.ragUiEl(doc, tag, opts, children);
  const t = (key, vars) => accessGroupsLabel(key, locale, vars);
  const file = accessGroupsText(item.name) || '';
  const value = accessGroupsQueueValue(item, options.groups);
  item.accessChoice = value.mode === 'untouched' ? null : value;
  const wasOpen = Boolean(wrap.querySelector('details') && wrap.querySelector('details').open);
  const rerender = (key) => accessGroupsQueueRender(doc, wrap, item, options, locale, key);
  const change = (target, checked, key) => {
    item.accessChoice = accessGroupsQueueToggle(accessGroupsQueueValue(item, options.groups), target, checked);
    rerender(key);
  };

  const trigger = accessGroupsQueueTrigger(value, locale);
  const summary = el('summary', { className: 'btn btn-outline btn-sm gap-1 font-normal', attrs: { 'data-access-groups-queue-trigger': value.mode } }, [
    ui.ragUiIcon(doc, trigger.icon),
    el('span', { text: trigger.text }),
    el('span', { className: 'sr-only', text: ' ' + t('picker.aria', { file }) }),
  ]);
  const name = 'access-groups-queue-' + String(item.id);
  const everyone = el('input', { className: 'checkbox checkbox-sm', attrs: { type: 'checkbox', name, value: 'everyone', autocomplete: 'off', 'data-access-groups-queue-option': 'everyone' } });
  everyone.checked = value.mode === 'everyone';
  everyone.addEventListener('change', () => change('everyone', everyone.checked, 'everyone'));
  const full = value.mode === 'groups' && value.groupIds.length >= ACCESS_GROUPS_UPLOAD_MAX_GROUPS;
  const groupItems = options.groups.map((group) => {
    const box = el('input', { className: 'checkbox checkbox-sm', attrs: { type: 'checkbox', name, value: group.id, autocomplete: 'off', 'data-access-groups-queue-option': group.id } });
    box.checked = value.mode === 'groups' && value.groupIds.includes(group.id);
    if (full && !box.checked) box.disabled = true;
    box.addEventListener('change', () => change(group.id, box.checked, group.id));
    return el('label', { className: 'label cursor-pointer justify-start items-start gap-2 py-1 [content-visibility:auto] [contain-intrinsic-size:auto_2rem]' }, [
      box,
      el('span', { className: 'label-text break-words [overflow-wrap:anywhere] min-w-0', text: group.name, attrs: { translate: 'no' } }),
    ]);
  });
  const menu = el('div', { className: 'dropdown-content z-[1] bg-base-100 rounded-box shadow p-4 w-72 max-h-72 overflow-y-auto' }, [
    el('label', { className: 'label cursor-pointer justify-start gap-2 py-1' }, [everyone, el('span', { className: 'label-text', text: t('term.everyone') })]),
    el('fieldset', { className: 'mt-2' }, [el('legend', { className: 'text-xs font-semibold', text: t('field.onlyGroups') }), ...groupItems]),
    el('p', { className: 'text-xs text-base-content/70 mt-2', text: t('picker.note') }),
  ]);
  if (value.mode !== 'untouched') {
    const clear = el('button', { className: 'btn btn-ghost btn-sm mt-2', text: t('picker.clear'), attrs: { type: 'button', 'data-access-groups-queue-option': 'clear' } });
    clear.addEventListener('click', () => change('clear', false, 'trigger'));
    menu.appendChild(clear);
  }
  const details = el('details', { className: 'dropdown', attrs: { 'data-access-groups-queue-menu': '' } }, [summary, menu]);
  details.open = wasOpen && focusKey !== 'trigger';
  details.addEventListener('keydown', (event) => {
    if (event && event.key === 'Escape' && details.open) {
      details.open = false;
      summary.focus();
    }
  });

  const nodes = [details];
  if (value.mode === 'groups') {
    const byId = new Map(options.groups.map((g) => [g.id, g.name]));
    const chips = value.groupIds.map((id) => {
      const name = byId.get(id) || id;
      const remove = el('button', { className: 'btn btn-ghost btn-xs btn-circle min-h-0 h-5 w-5', attrs: { type: 'button', 'aria-label': t('action.removeGroupChip', { group: name }), 'data-access-groups-queue-chip-remove': id } }, [ui.ragUiIcon(doc, 'x')]);
      remove.addEventListener('click', () => change(id, false, 'trigger'));
      return el('span', { className: 'badge badge-outline badge-sm gap-1 h-auto max-w-full whitespace-normal', attrs: { 'data-access-groups-queue-chip': id } }, [el('span', { className: 'break-words [overflow-wrap:anywhere] min-w-0', text: name, attrs: { translate: 'no' } }), remove]);
    });
    nodes.push(el('div', { className: 'flex flex-wrap items-center gap-1 w-full min-w-0' }, [el('span', { className: 'text-xs', text: t('audience.label') }), ...chips]));
  } else if (value.mode === 'everyone') {
    nodes.push(el('p', { className: 'text-xs w-full', text: t('audience.everyone') }));
  }
  wrap.replaceChildren(...nodes);
  if (focusKey === 'trigger') summary.focus();
  else if (focusKey) {
    const next = Array.from(wrap.querySelectorAll('[data-access-groups-queue-option]')).find((n) => n.getAttribute('data-access-groups-queue-option') === focusKey);
    if (next) next.focus();
  }
}

/** UI-SPEC 6.7: fills the Access control into each `[data-queue-extras]` host, after Replaces… (the host's scope-tag controls). */
function accessGroupsMountQueueControls(container, queue, picker) {
  if (!container || typeof container.querySelectorAll !== 'function') return;
  const options = picker && picker.access;
  if (!options || options.shown !== true) return;
  const doc = accessGroupsDocOf(container);
  const locale = accessGroupsUiLib().ragUiBrowserLocale();
  for (const host of container.querySelectorAll('[data-queue-extras]')) {
    const id = host.getAttribute('data-queue-extras');
    const item = (Array.isArray(queue) ? queue : []).find((q) => q && String(q.id) === String(id));
    if (!item) continue;
    let wrap = Array.from(host.children || []).find((c) => c.hasAttribute && c.hasAttribute('data-access-groups-queue'));
    if (!wrap) {
      wrap = accessGroupsUiLib().ragUiEl(doc, 'div', { className: 'flex flex-wrap items-center gap-2 w-full min-w-0', attrs: { 'data-access-groups-queue': '', 'data-queue-extras-tail': '' } });
      host.appendChild(wrap);
    }
    accessGroupsQueueRender(doc, wrap, item, options, locale, null);
  }
}

const AccessGroupsQueueControls = {
  load: accessGroupsLoadQueueOptions,
  mount: accessGroupsMountQueueControls,
  uploadField: accessGroupsQueueUploadField,
  uploadErrorText: accessGroupsQueueErrorText,
};

/** UI-SPEC 6.8: the badge under a stored document's name; null for Everyone (and for anything unreadable). */
function buildAccessGroupsTableBadgeView(audience, locale) {
  const kind = audience && audience.kind;
  if (kind === 'groups' && Array.isArray(audience.groups) && audience.groups.length > 0) {
    return { kind: 'groups', icon: 'lock', text: accessGroupsLabel('badge.restricted', locale), hint: accessGroupsLabel('badge.restrictedHint', locale) };
  }
  if (kind === 'uploader_only' || kind === 'groups') {
    return { kind: 'uploader_only', icon: 'shield-exclamation', text: accessGroupsLabel('audience.uploaderOnly', locale), hint: null };
  }
  return null;
}

function accessGroupsWorkspaceId(doc) {
  const container = doc && doc.getElementById('workspace-selector-container');
  const selector = doc && doc.getElementById('workspace-selector');
  if (!container || !selector || container.classList.contains('hidden')) return null;
  return accessGroupsText(selector.value);
}

/**
 * Appends the badge to the name cell of each restricted row of the stored-documents table, and docs.manageHint under the table,
 * while the switch is on. Rows are matched by their data-access-groups-doc id; a request that fails leaves the table as it is.
 */
async function accessGroupsApplyTableBadges(tableBody, organizationId) {
  if (!tableBody || typeof tableBody.querySelectorAll !== 'function') return;
  const ui = accessGroupsUiLib();
  const doc = accessGroupsDocOf(tableBody);
  const token = {};
  tableBody.accessGroupsBadgeToken = token;
  const rows = Array.from(tableBody.querySelectorAll('[data-access-groups-doc]'));
  const ids = [...new Set(rows.map((r) => r.getAttribute('data-access-groups-doc')).filter((id) => id && ACCESS_GROUPS_UUID_RE.test(id)))];
  const container = doc && doc.getElementById('documents-table-container');
  const oldHint = container && container.querySelector('[data-access-groups-manage-hint]');
  if (oldHint) oldHint.remove();
  if (ids.length === 0) return;
  const orgQuery = organizationId ? '&organizationId=' + encodeURIComponent(String(organizationId)) : '';
  const status = await ui.ragUiRagRequest(ACCESS_GROUPS_PATH + '?limit=1' + orgQuery, { method: 'GET' });
  if (tableBody.accessGroupsBadgeToken !== token) return;
  if (!status || !status.ok || !status.body || status.body.enabled !== true || status.body.personal === true) return;
  const audiences = new Map();
  for (let i = 0; i < ids.length; i += ACCESS_GROUPS_BADGE_IDS_MAX) {
    const chunk = ids.slice(i, i + ACCESS_GROUPS_BADGE_IDS_MAX);
    const result = await ui.ragUiRagRequest(ACCESS_GROUPS_PATH + '/documents?ids=' + chunk.join(',') + orgQuery, { method: 'GET' });
    if (tableBody.accessGroupsBadgeToken !== token) return;
    if (!result || !result.ok || !result.body || !Array.isArray(result.body.audiences)) return;
    for (const audience of result.body.audiences) {
      const id = audience && accessGroupsText(audience.documentId);
      if (id) audiences.set(id.toLowerCase(), audience);
    }
  }
  const locale = ui.ragUiBrowserLocale();
  const el = (tag, opts, children) => ui.ragUiEl(doc, tag, opts, children);
  for (const row of rows) {
    const id = (row.getAttribute('data-access-groups-doc') || '').toLowerCase();
    const cell = row.children && row.children[0];
    if (!cell) continue;
    const previous = cell.querySelector('[data-access-groups-table-badge]');
    if (previous) previous.remove();
    const view = buildAccessGroupsTableBadgeView(audiences.get(id), locale);
    if (!view) continue;
    const tone = view.kind === 'groups' ? 'badge badge-outline badge-sm' : 'badge badge-warning badge-outline badge-sm text-base-content';
    const badge = el('span', { className: tone + ' gap-1 h-auto max-w-full whitespace-normal text-left mt-1', attrs: { 'data-access-groups-table-badge': view.kind, title: view.hint } }, [
      ui.ragUiIcon(doc, view.icon, view.kind === 'groups' ? null : 'text-warning'),
      el('span', { className: 'break-words [overflow-wrap:anywhere] min-w-0' + (view.kind === 'groups' ? '' : ' text-base-content'), text: view.text }),
    ]);
    cell.appendChild(el('div', {}, [badge]));
  }
  if (container) container.appendChild(el('p', { className: 'text-xs text-base-content/70 mt-2', text: accessGroupsLabel('docs.manageHint', locale), attrs: { 'data-access-groups-manage-hint': '' } }));
}

/** The Connectors-card notice (UI-SPEC 6.8): null without fallen-back documents; the wording follows the switch (D-22). */
function buildAccessGroupsConnectorNoticeView(count, enabled, locale) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  if (n === 0) return null;
  const key = enabled ? 'connector.failClosed' : 'connector.failClosedOff';
  return { key, text: accessGroupsLabel(key, locale, { count: accessGroupsUiLib().ragUiFormatNumber(n, locale) }), action: accessGroupsLabel('action.openMapping', locale) };
}

/** Activates RAG administration through its menu link, selects Connector mapping, scrolls the panel into view and focuses its heading. */
async function accessGroupsOpenConnectorMapping(doc) {
  const link = doc.querySelector('[data-tab="rag-administration"]');
  if (link && typeof link.click === 'function') link.click();
  await Promise.resolve(initAccessGroupsPanel());
  const section = doc.getElementById('rag-administration-access');
  if (section && typeof section.scrollIntoView === 'function') {
    const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
  if (accessGroupsPanelInstance) accessGroupsPanelInstance.selectMapping();
}

/**
 * Appends the notice to each connected provider card whose connection has fallen-back documents. cards: [{ host, connectionId }],
 * host being the card's `[data-connector-extras]` element. A request that fails leaves the cards as they are.
 */
async function accessGroupsApplyConnectorNotices(cards, organizationId) {
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && c.host && accessGroupsText(c.connectionId));
  for (const card of list) card.host.replaceChildren();
  if (list.length === 0) return;
  const ui = accessGroupsUiLib();
  const doc = accessGroupsDocOf(list[0].host);
  const orgQuery = organizationId ? '?organizationId=' + encodeURIComponent(String(organizationId)) : '';
  const [status, counts] = await Promise.all([
    ui.ragUiRagRequest(ACCESS_GROUPS_PATH + (orgQuery ? orgQuery + '&' : '?') + 'limit=1', { method: 'GET' }),
    ui.ragUiRagRequest(ACCESS_GROUPS_PATH + '/connector-map/fail-closed' + orgQuery, { method: 'GET' }),
  ]);
  if (!counts || !counts.ok || !counts.body || !Array.isArray(counts.body.connections)) return;
  const enabled = Boolean(status && status.ok && status.body && status.body.enabled === true);
  const byConnection = new Map();
  for (const row of counts.body.connections) {
    const id = row && accessGroupsText(row.connectionId);
    if (id) byConnection.set(id, Number(row.documents));
  }
  const locale = ui.ragUiBrowserLocale();
  const el = (tag, opts, children) => ui.ragUiEl(doc, tag, opts, children);
  for (const card of list) {
    const view = buildAccessGroupsConnectorNoticeView(byConnection.get(accessGroupsText(card.connectionId)), enabled, locale);
    if (!view) continue;
    const open = el('button', { className: 'btn btn-sm', text: view.action, attrs: { type: 'button', 'data-access-groups-open-mapping': '' } });
    open.addEventListener('click', () => accessGroupsOpenConnectorMapping(doc));
    card.host.replaceChildren(
      el('div', { className: 'alert alert-warning text-sm items-start mt-2', attrs: { 'data-access-groups-connector-notice': view.key } }, [
        ui.ragUiIcon(doc, 'shield-exclamation'),
        el('div', { className: 'flex flex-col items-start gap-2 min-w-0' }, [el('p', { className: 'break-words [overflow-wrap:anywhere]', text: view.text }), open]),
      ]),
    );
  }
}

const AccessGroupsDocumentBadges = { apply: accessGroupsApplyTableBadges, workspaceId: accessGroupsWorkspaceId };
const AccessGroupsConnectorNotices = { apply: accessGroupsApplyConnectorNotices, workspaceId: accessGroupsWorkspaceId };

let accessGroupsPanelInstance = null;

function initAccessGroupsPanel() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('rag-administration-access');
  if (!root) return null;
  if (!accessGroupsPanelInstance) {
    accessGroupsPanelInstance = new AccessGroupsPanel(root);
    if (typeof window !== 'undefined') window.accessGroupsPanel = accessGroupsPanelInstance;
    return accessGroupsPanelInstance.mount();
  }
  return accessGroupsPanelInstance.refresh();
}

function accessGroupsBindPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-access-groups-bound')) return;
    link.setAttribute('data-access-groups-bound', '1');
    link.addEventListener('click', () => initAccessGroupsPanel());
  });
}

if (typeof window !== 'undefined') {
  window.ACCESS_GROUPS_LABELS = ACCESS_GROUPS_LABELS;
  window.AccessGroupsQueueControls = AccessGroupsQueueControls;
  window.AccessGroupsDocumentBadges = AccessGroupsDocumentBadges;
  window.AccessGroupsConnectorNotices = AccessGroupsConnectorNotices;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.initAccessGroupsPanel = initAccessGroupsPanel;
  accessGroupsBindPanel();
  document.addEventListener('DOMContentLoaded', () => {
    accessGroupsBindPanel();
    const active = document.getElementById('rag-administration');
    if (active && active.classList.contains('active')) initAccessGroupsPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ACCESS_GROUPS_LABELS,
    ACCESS_GROUPS_STATES,
    accessGroupsLabel,
    accessGroupsLocale,
    buildAccessGroupsEnforcementView,
    accessGroupsReasonItems,
    accessGroupsDriftView,
    accessGroupsEmbedCheck,
    mapAccessGroupsError,
    accessGroupsSuggestKey,
    accessGroupsFormFindings,
    buildAccessGroupsGroupRow,
    buildAccessGroupsList,
    accessGroupsMemberName,
    buildAccessGroupsImpactView,
    accessGroupsCountLabel,
    buildAccessGroupsDocumentRow,
    buildAccessGroupsDocumentsList,
    buildAccessGroupsAudienceView,
    AccessGroupsAudienceLine,
    accessGroupsAudienceKey,
    accessGroupsInitialChoice,
    accessGroupsFieldFindings,
    accessGroupsAccessBody,
    accessGroupsSourceLabel,
    accessGroupsProviderName,
    buildAccessGroupsMappingRow,
    buildAccessGroupsMappingList,
    accessGroupsMappingKindLabel,
    accessGroupsMappingAction,
    buildAccessGroupsRuleRow,
    buildAccessGroupsRulesList,
    accessGroupsRuleText,
    accessGroupsNormalizeDomain,
    accessGroupsMappingFindings,
    AccessGroupsAudienceField,
    AccessGroupsPanel,
    initAccessGroupsPanel,
    accessGroupsQueueOptions,
    accessGroupsLoadQueueOptions,
    accessGroupsQueueValue,
    accessGroupsQueueToggle,
    accessGroupsQueueUploadField,
    accessGroupsQueueErrorText,
    accessGroupsMountQueueControls,
    AccessGroupsQueueControls,
    buildAccessGroupsTableBadgeView,
    accessGroupsApplyTableBadges,
    buildAccessGroupsConnectorNoticeView,
    accessGroupsApplyConnectorNotices,
    AccessGroupsDocumentBadges,
    AccessGroupsConnectorNotices,
  };
}
