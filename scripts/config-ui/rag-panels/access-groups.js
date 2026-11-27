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
  if (status === 400 && (err === 'invalid_key' || err === 'reserved_key')) {
    const key = err === 'invalid_key' ? 'form.badKey' : 'form.reservedKey';
    return { key, kind: 'field', field: 'key', message: accessGroupsLabel(key, locale) };
  }
  if (status === 404 || (status === 409 && opts.write)) {
    return { key: 'error.changed', kind: 'changed', message: accessGroupsLabel('error.changed', locale), reload: true };
  }
  return ui.ragUiMapError(result, locale, { unavailable: opts.unavailable });
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
      tabs: [{ id: 'enforcement', label: this.t('tab.enforcement') }],
      selected: 'enforcement',
    });
    this.buildEnforcement(this.tabs.panels.enforcement);
    const content = this.root.querySelector('[data-access-groups-content]');
    if (content) content.replaceChildren(this.tabs.tablist, ...Object.values(this.tabs.panels));
    this.lastSaved = this.savedSnapshot();
    if (this.doc && typeof this.doc.addEventListener === 'function') {
      this.doc.addEventListener('rag:config-saved', (event) => this.onConfigSaved(event && event.detail));
    }
    this.renderAll();
    await this.loadStatus('first');
  }

  async refresh() {
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
}

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
    AccessGroupsPanel,
    initAccessGroupsPanel,
  };
}
