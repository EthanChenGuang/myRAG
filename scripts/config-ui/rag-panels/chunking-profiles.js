/**
 * Chunking profiles admin panel (CHK-04, CHK-05, D-21): list, create, build, compare, activate and roll back chunking profiles per
 * document type. Plain DOM built with createElement and textContent only; every request goes through ragFetch to
 * /api/rag/admin/chunking-profiles over the forwarded admin_session cookie.
 */

const CHUNKING_LABELS = {
  en: {
    'panel.title': 'Chunking profiles',
    'panel.description':
      'Chunk sizes per document type. Build a new profile next to the current one, compare it in the sweep report, then activate it. Applies to every workspace in this deployment.',
    'panel.tabsLabel': 'Chunking profile views',
    'tab.profiles': 'Profiles',
    'tab.report': 'Sweep report',
    'action.new': 'New profile',
    'action.refresh': 'Refresh profiles',
    'action.create': 'Create profile',
    'action.closeForm': 'Close form',
    'action.build': 'Build profile',
    'action.buildAria': 'Build profile {id}',
    'action.continue': 'Continue build',
    'action.continueAria': 'Continue build of {id}',
    'action.buildMissing': 'Build missing documents',
    'action.buildMissingAria': 'Build missing documents of {id}',
    'action.pause': 'Pause build',
    'action.activate': 'Activate profile',
    'action.activateAria': 'Activate profile {id} for {type}',
    'action.rollback': 'Roll back profile',
    'action.rollbackAria': 'Roll back {type} to the previous profile',
    'action.keep': 'Keep current profile',
    'action.reload': 'Reload panel',
    'list.loading': 'Loading chunking profiles…',
    'list.loaded': 'Profiles loaded: {count}.',
    'list.updatedAt': 'Updated {time}',
    'list.empty.title': 'No chunking profiles found',
    'list.empty.body':
      'The profile table is empty, which means the Phase 4 database migrations have not been applied. Apply the files under supabase/migrations (0406 and later), then select Reload panel.',
    'group.active': 'Active: {profile}',
    'group.since': 'since {date}',
    'group.onlyLegacy': 'Legacy chunks are active. No other profiles for this document type yet.',
    'table.caption': 'Chunking profiles for {type}',
    'col.profile': 'Profile',
    'col.sizes': 'Sizes',
    'col.status': 'Status',
    'col.documents': 'Documents built',
    'col.actions': 'Actions',
    'legacy.name': 'Legacy chunks',
    'legacy.sizes': 'As first ingested',
    'sizes.pair': '{child} / {parent} tokens',
    'mode.structure': 'Parents follow the document structure',
    'mode.fixed': 'Fixed-size parents',
    'preset.label': 'Preset {name}',
    'preset.custom': 'Custom',
    'preset.default': 'default',
    'status.building': 'Building',
    'status.ready': 'Ready',
    'status.active': 'Active',
    'status.retired': 'Retired',
    'docs.built': '{built} of {total}',
    'docs.missing': 'Missing: {missing}',
    'docs.notMeasured': 'Not measured',
    'docs.notApplicable': 'Not applicable',
    'badge.decision': 'Sweep decision',
    'coverage.warning':
      'Documents missing from the active profile {id}: {count}. Until the profile is rebuilt, questions about them are answered from legacy chunks. Select Build missing documents to add them.',
    'coverage.unknown': 'The documents missing from the active profile {id} could not be counted. Select Refresh profiles.',
    'help.decision':
      "Activation needs a passing sweep decision recorded in the database. The decision shown here is the one in this deployment’s files, and the two can differ. After a sweep, record the decision with {command}.",
    'decision.line': 'Sweep decision: {profile}, {gate}, {source}, {date}',
    'decision.none': 'No decision recorded',
    'decision.unavailable': 'Sweep decisions are unavailable right now. Open Sweep report for details.',
    'form.title': 'New chunking profile',
    'form.docType': 'Document type',
    'form.preset': 'Sizes',
    'form.child': 'Child size (tokens)',
    'form.childHelp': 'The small pieces that are searched.',
    'form.parent': 'Parent size (tokens)',
    'form.parentHelp': 'The larger passage sent to the model around a matching child.',
    'form.mode': 'Parent boundaries',
    'form.mode.structure': 'Follow the document structure, up to the parent size',
    'form.mode.fixed': 'Fixed size',
    'form.id': 'Profile ID',
    'form.idHelp':
      'Lower-case letters, digits, dots, hyphens and underscores, up to 64 characters. The suggested ID matches the sweep report, so a recorded decision finds this profile.',
    'form.presetLocked': 'Set by the preset. Choose Custom to change it.',
    'form.number': 'Enter a whole number of 1 or more.',
    'form.idInvalid': 'Use lower-case letters, digits, dots, hyphens and underscores, starting with a letter or a digit.',
    'form.idReserved': 'The ID “legacy” is reserved. Enter another ID.',
    'form.checking': 'Checking with the server…',
    'form.serverUnchecked':
      'These values could not be checked with the server. You can still create the profile; the server checks them again.',
    'form.creating': 'Creating…',
    'form.created': 'Profile {id} created for {type}. Select Build profile to fill it with documents.',
    'finding.child_exceeds_embedding_input': 'The child size is larger than the embedding model accepts. Enter a smaller child size.',
    'finding.parent_below_twice_child': 'The parent size must be at least twice the child size: {min} or more.',
    'finding.parent_tokens_required': 'Enter a parent size.',
    'finding.ratio_outside_4_8': 'The parent is {ratio} times the child. The tested range is 4 to 8 times. You can still create the profile.',
    'finding.top_k_parent_over_budget':
      'With this parent size, the retrieved parents can be larger than the context token budget, so the context is cut to fit. You can still create the profile; the sweep report shows the context tokens it measured.',
    'finding.invalid_shape': 'Some values are missing or are not whole numbers. Check each field.',
    'error.listUnavailable': 'Chunking profiles are unavailable right now. Select Reload panel in a moment.',
    'error.createUnavailable':
      'The profile was not created because the service is unavailable. Your values are still in the form. Select Create profile again in a moment.',
    'error.profileExists': 'A profile with this ID already exists for this document type. Change the profile ID.',
    'error.rejected': 'The database did not accept these values. Check the sizes and the profile ID, then select Create profile again.',
    'error.invalidField': 'Check {field}: the server did not accept its value.',
    'error.invalid': 'The request was not accepted. Select Reload panel, then try again.',
    'error.profileGone': 'This profile no longer exists. The list has been refreshed.',
    'error.changeUnknown':
      'The server did not confirm the change, so it may or may not have been applied. The list has been refreshed and shows which profile is active now.',
    'build.barLabel': 'Build progress for {id}',
    'build.region': 'Build of {id}',
    'build.starting': 'Starting the build…',
    'build.progress': '{done} of {total} documents built',
    'build.note': 'Each step runs for up to 45 seconds. Keep this page open; if you leave, the build pauses and Continue build picks it up.',
    'build.gaps': 'Documents that could not be built so far: {count}',
    'build.busy': 'A build is running. Pause it or wait for it to finish.',
    'build.pausing': 'Pausing after this step…',
    'build.paused': 'Build paused at {done} of {total} documents. Select Continue build to resume.',
    'build.completed': 'Build finished. Documents built: {total}. {id} is now ready.',
    'build.repaired': 'Build finished. No documents are missing from {id} now.',
    'build.none': 'Nothing to build. Every {type} document already has chunks in {id}.',
    'build.incomplete': 'Build finished, but some documents were left out: {count}. {id} cannot be activated until they are built.',
    'gap.no_parse_output':
      'No stored parse output: {count}. These documents were ingested before parse output was kept. On the server, run {command} to list them, upload them again, then select Continue build.',
    'gap.failed': 'Could not be chunked: {count}. Check the app log for [RAG Rechunk], fix the cause, then select Continue build.',
    'gap.other': 'Left out with the code {code}: {count}. Check the app log for [RAG Rechunk].',
    'build.failed':
      'The build stopped at {done} of {total} documents. Progress so far is saved. Select Continue build. If it stops again, check the app log for [RAG Rechunk].',
    'build.stalled': 'The build is not moving forward. Progress so far is saved. Wait a minute, then select Continue build.',
    'build.unavailable': 'The build service is unavailable right now. Progress so far is saved. Select Continue build in a moment.',
    'build.network':
      'The connection dropped during the build. Progress so far is saved. Check that the Config UI server is running, then select Continue build.',
    'build.saved': 'Progress so far is saved.',
    'build.refused.profile_retired': 'This profile is retired and cannot be built. Create a new profile instead.',
    'build.refused.other': 'The build was refused with the code {code}. Select Reload panel, then try again.',
    'confirm.activate.title': 'Activate {id} for {type}?',
    'confirm.activate.body':
      'Questions about {type} documents will be answered from this profile ({sizes}) in every workspace, starting at once. The current profile, {current}, stays built, and Roll back profile returns to it.',
    'confirm.activate.bodyLegacy':
      'Questions about {type} documents will be answered from legacy chunks in every workspace, starting at once. The current profile, {current}, stays built and can be activated again.',
    'confirm.rollback.title': 'Roll back {type} to the previous profile?',
    'confirm.rollback.body':
      '{type} documents go back to {previous} in every workspace, starting at once. {current} stays built and can be activated again.',
    'confirm.activating': 'Activating…',
    'confirm.rollingBack': 'Rolling back…',
    'activate.done': '{id} is now active for {type}. {previous} stays built.',
    'activate.already': '{id} was already active for {type}. Nothing changed.',
    'rollback.done': '{type} now uses {restored}. {rolledBack} is ready and can be activated again.',
    'gate.incomplete':
      'Not activated. Some {type} documents have no chunks in {id} yet. Select Build missing documents on that profile, then activate again.',
    'gate.open_gaps':
      'Not activated. The last build of {id} left out documents it could not build. Build the profile again and fix what the build reports, then activate again.',
    'gate.no_evidence':
      'Not activated. No sweep decision is recorded in the database for {id}. Run the chunking sweep, record its decision with {command}, then activate again.',
    'gate.eval_failed':
      'Not activated. The recorded sweep decision for {id} did not pass the check against legacy chunks. Open Sweep report, compare the profiles, and activate one that passed.',
    'gate.stale_evidence':
      'Not activated. The recorded sweep decision is older than the latest build of {id}. Run the chunking sweep again and record the new decision with {command}.',
    'gate.not_ready': 'Not activated. {id} is still building. Finish its build, then activate again.',
    'gate.ambiguous_profile':
      "Not activated. More than one document type has a profile with this ID. Select Reload panel, then activate it from its own document type’s table.",
    'gate.no_previous': 'Nothing to roll back. {type} already uses legacy chunks.',
    'gate.other':
      'Not changed. The server refused with the code {code}. Select Reload panel and try again. If it repeats, check the app log for [RAG Admin].',
    'report.loading': 'Loading the sweep report…',
    'report.fixture':
      'This report comes from the built-in test fixture. It shows that the sweep works; it does not measure your documents. Run the live sweep before choosing a profile.',
    'report.empty.title': 'No sweep report yet',
    'report.empty.body': 'Run {command} to compare the profiles with legacy chunks, commit the report and redeploy. The comparison then appears here.',
    'report.baselineOnly': 'Only legacy chunks were measured. Add candidate profiles to the sweep to compare them.',
    'report.unreadable':
      'The sweep report or the decision file in this deployment is not valid, so it cannot be shown. Run {command} again, commit the result and redeploy.',
    'report.unavailable': 'The sweep report is unavailable right now. Select Reload panel in a moment.',
    'report.decisions': 'Sweep decisions',
    'report.decisionsCaption': 'Sweep decision per document type',
    'report.col.type': 'Document type',
    'report.col.chosen': 'Chosen profile',
    'report.col.gate': 'Check against legacy',
    'report.col.source': 'From',
    'report.col.recorded': 'Recorded',
    'source.live': 'Live sweep',
    'source.fixture': 'Test fixture',
    'gate.passed': 'Passed',
    'gate.failed': 'Failed',
    'gate.baseline': 'Baseline',
    'gate.showRegressions': 'Show what got worse ({count})',
    'gate.regression': '{metric}, {slice}: {diff} (allowed: {band})',
    'report.compareOn': 'Compare on',
    'report.comparison': 'Profiles compared',
    'slice.overall': 'Overall',
    'slice.group.docType': 'Document type',
    'slice.group.language': 'Question language',
    'slice.group.kind': 'Question kind',
    'kind.fact_lookup': 'Fact lookup',
    'kind.context_heavy': 'Needs wider context',
    'kind.clause': 'Contract clause',
    'kind.other': 'Other',
    'lang.zh': 'Chinese',
    'lang.en': 'English',
    'lang.it': 'Italian',
    'report.caption': 'Chunking profiles compared on: {slice}',
    'report.col.profile': 'Profile',
    'report.col.recall': 'Recall@k',
    'report.col.mrr': 'MRR',
    'report.col.falseRefusal': 'False refusals',
    'report.col.correctRefusal': 'Correct refusals',
    'report.col.judge': 'Answer correctness',
    'report.col.context': 'Context tokens (mean)',
    'report.col.latency': 'Latency p50 / p95',
    'report.rateSub': 'point estimate, 95% upper bound',
    'cell.point': 'point estimate',
    'cell.upper': '95% upper bound {value}',
    'cell.n': 'n = {n}',
    'cell.noItems': 'No items',
    'report.registeredAs': 'Registered as {id} ({status})',
    'report.judgeSkipped': 'Skipped (see notes)',
    'report.noData': 'No data',
    'report.latency': '{p50} / {p95} ms',
    'report.notes': 'Notes from the sweep (in English)',
  },
  zh: {
    'panel.title': '分块配置',
    'panel.description': '按文档类型设置分块大小。先在当前配置旁边构建新配置，在对比报告中比较，再激活。对本部署的所有工作区生效。',
    'panel.tabsLabel': '分块配置视图',
    'tab.profiles': '配置',
    'tab.report': '对比报告',
    'action.new': '新建配置',
    'action.refresh': '刷新配置',
    'action.create': '创建配置',
    'action.closeForm': '关闭表单',
    'action.build': '构建配置',
    'action.buildAria': '构建配置 {id}',
    'action.continue': '继续构建',
    'action.continueAria': '继续构建 {id}',
    'action.buildMissing': '构建缺失文档',
    'action.buildMissingAria': '构建 {id} 缺失的文档',
    'action.pause': '暂停构建',
    'action.activate': '激活配置',
    'action.activateAria': '为{type}激活配置 {id}',
    'action.rollback': '回滚配置',
    'action.rollbackAria': '将{type}回滚到上一个配置',
    'action.keep': '保留当前配置',
    'action.reload': '重新加载面板',
    'list.loading': '正在加载分块配置…',
    'list.loaded': '已加载配置：{count} 个。',
    'list.updatedAt': '更新于 {time}',
    'list.empty.title': '未找到分块配置',
    'list.empty.body': '配置表为空，说明尚未应用第 4 阶段的数据库迁移。请应用 supabase/migrations 下的文件（0406 及之后），然后点击“重新加载面板”。',
    'group.active': '当前使用：{profile}',
    'group.since': '自 {date} 起',
    'group.onlyLegacy': '当前使用原有分块。此文档类型还没有其他配置。',
    'table.caption': '{type}的分块配置',
    'col.profile': '配置',
    'col.sizes': '大小',
    'col.status': '状态',
    'col.documents': '已构建文档',
    'col.actions': '操作',
    'legacy.name': '原有分块',
    'legacy.sizes': '按最初入库时的方式',
    'sizes.pair': '{child} / {parent} 个 token',
    'mode.structure': '父块按文档结构划分',
    'mode.fixed': '父块大小固定',
    'preset.label': '预设 {name}',
    'preset.custom': '自定义',
    'preset.default': '默认',
    'status.building': '构建中',
    'status.ready': '就绪',
    'status.active': '使用中',
    'status.retired': '已停用',
    'docs.built': '{built} / {total}',
    'docs.missing': '缺失：{missing}',
    'docs.notMeasured': '未统计',
    'docs.notApplicable': '不适用',
    'badge.decision': '评估选定',
    'coverage.warning':
      '当前使用的配置 {id} 缺少文档：{count} 个。在重新构建该配置之前，关于这些文档的问题仍由原有分块回答。点击“构建缺失文档”补齐。',
    'coverage.unknown': '无法统计当前配置 {id} 缺少的文档数量。请点击“刷新配置”。',
    'help.decision': '激活需要数据库中记录有通过的评估决定。这里显示的是本部署文件中的决定，两者可能不同。评估完成后，用 {command} 记录决定。',
    'decision.line': '评估决定：{profile}，{gate}，{source}，{date}',
    'decision.none': '没有记录决定',
    'decision.unavailable': '暂时无法读取评估决定。详情见“对比报告”。',
    'form.title': '新建分块配置',
    'form.docType': '文档类型',
    'form.preset': '大小',
    'form.child': '子块大小（token）',
    'form.childHelp': '用于检索的小块。',
    'form.parent': '父块大小（token）',
    'form.parentHelp': '命中子块后发送给模型的较大段落。',
    'form.mode': '父块边界',
    'form.mode.structure': '按文档结构划分，不超过父块大小',
    'form.mode.fixed': '固定大小',
    'form.id': '配置 ID',
    'form.idHelp': '小写字母、数字、点、连字符和下划线，最多 64 个字符。建议的 ID 与对比报告一致，这样记录的决定才能对应到此配置。',
    'form.presetLocked': '由预设决定。选择“自定义”可修改。',
    'form.number': '请输入不小于 1 的整数。',
    'form.idInvalid': '请使用小写字母、数字、点、连字符和下划线，并以字母或数字开头。',
    'form.idReserved': 'ID“legacy”已被保留，请换一个。',
    'form.checking': '正在向服务器核对…',
    'form.serverUnchecked': '无法向服务器核对这些值。仍可创建配置，服务器会再次检查。',
    'form.creating': '正在创建…',
    'form.created': '已为{type}创建配置 {id}。点击“构建配置”为其写入文档。',
    'finding.child_exceeds_embedding_input': '子块大小超过了 Embedding 模型可接受的上限。请填写更小的子块大小。',
    'finding.parent_below_twice_child': '父块大小至少应为子块的两倍：不小于 {min}。',
    'finding.parent_tokens_required': '请填写父块大小。',
    'finding.ratio_outside_4_8': '父块是子块的 {ratio} 倍。经过验证的范围是 4 到 8 倍。仍可创建配置。',
    'finding.top_k_parent_over_budget':
      '按此父块大小，检索到的父块可能超出上下文 token 预算，上下文会被截断以适应预算。仍可创建配置；对比报告会显示实测的上下文 token 数。',
    'finding.invalid_shape': '有些值缺失或不是整数。请检查每个字段。',
    'error.listUnavailable': '暂时无法读取分块配置。请稍后点击“重新加载面板”。',
    'error.createUnavailable': '服务暂时不可用，配置未创建。表单中的值已保留。请稍后再次点击“创建配置”。',
    'error.profileExists': '此文档类型已有相同 ID 的配置。请修改配置 ID。',
    'error.rejected': '数据库未接受这些值。请检查大小和配置 ID，然后再次点击“创建配置”。',
    'error.invalidField': '请检查“{field}”：服务器未接受该值。',
    'error.invalid': '请求未被接受。请点击“重新加载面板”后重试。',
    'error.profileGone': '此配置已不存在，列表已刷新。',
    'error.changeUnknown': '服务器未确认此更改，可能已生效，也可能没有。列表已刷新，显示当前使用的配置。',
    'build.barLabel': '{id} 的构建进度',
    'build.region': '{id} 的构建',
    'build.starting': '正在开始构建…',
    'build.progress': '已构建 {done} / {total} 个文档',
    'build.note': '每一步最多运行 45 秒。请保持此页面打开；离开后构建会暂停，点击“继续构建”即可接着进行。',
    'build.gaps': '目前无法构建的文档：{count} 个',
    'build.busy': '正在构建。请先暂停或等待完成。',
    'build.pausing': '完成当前步骤后暂停…',
    'build.paused': '构建已暂停，进度 {done} / {total} 个文档。点击“继续构建”恢复。',
    'build.completed': '构建完成。已构建文档：{total} 个。{id} 已就绪。',
    'build.repaired': '构建完成。{id} 不再缺少文档。',
    'build.none': '无需构建。所有{type}文档在 {id} 中都已有分块。',
    'build.incomplete': '构建已结束，但有文档未能写入：{count} 个。在补齐之前，{id} 无法激活。',
    'gap.no_parse_output':
      '没有保存的解析结果：{count} 个。这些文档是在保存解析结果之前入库的。请在服务器上运行 {command} 列出它们，重新上传后点击“继续构建”。',
    'gap.failed': '无法分块：{count} 个。请在应用日志中查找 [RAG Rechunk]，排除原因后点击“继续构建”。',
    'gap.other': '因代码 {code} 未写入：{count} 个。请在应用日志中查找 [RAG Rechunk]。',
    'build.failed': '构建在 {done} / {total} 个文档处停止。已完成的进度已保存。请点击“继续构建”。如果再次停止，请在应用日志中查找 [RAG Rechunk]。',
    'build.stalled': '构建没有进展。已完成的进度已保存。请等待一分钟后点击“继续构建”。',
    'build.unavailable': '构建服务暂时不可用。已完成的进度已保存。请稍后点击“继续构建”。',
    'build.network': '构建过程中连接中断。已完成的进度已保存。请确认 Config UI 服务器正在运行，然后点击“继续构建”。',
    'build.saved': '已完成的进度已保存。',
    'build.refused.profile_retired': '此配置已停用，无法构建。请新建一个配置。',
    'build.refused.other': '构建被拒绝，代码 {code}。请点击“重新加载面板”后重试。',
    'confirm.activate.title': '为{type}激活 {id}？',
    'confirm.activate.body': '所有工作区中关于{type}文档的问题将立即改由此配置（{sizes}）回答。当前配置 {current} 会保留，点击“回滚配置”即可恢复。',
    'confirm.activate.bodyLegacy': '所有工作区中关于{type}文档的问题将立即改由原有分块回答。当前配置 {current} 会保留，可以再次激活。',
    'confirm.rollback.title': '将{type}回滚到上一个配置？',
    'confirm.rollback.body': '所有工作区中的{type}文档将立即恢复使用 {previous}。{current} 会保留，可以再次激活。',
    'confirm.activating': '正在激活…',
    'confirm.rollingBack': '正在回滚…',
    'activate.done': '{id} 已成为{type}的当前配置。{previous} 已保留。',
    'activate.already': '{id} 已经是{type}的当前配置，未作更改。',
    'rollback.done': '{type}现在使用 {restored}。{rolledBack} 已就绪，可以再次激活。',
    'gate.incomplete': '未激活。部分{type}文档在 {id} 中还没有分块。请在该配置上点击“构建缺失文档”，然后再次激活。',
    'gate.open_gaps': '未激活。{id} 最近一次构建有文档未能写入。请重新构建该配置并处理构建报告的问题，然后再次激活。',
    'gate.no_evidence': '未激活。数据库中没有 {id} 的评估决定。请运行分块评估，用 {command} 记录决定，然后再次激活。',
    'gate.eval_failed': '未激活。{id} 的评估决定未通过与原有分块的对比。请打开“对比报告”比较各配置，激活一个通过的配置。',
    'gate.stale_evidence': '未激活。记录的评估决定早于 {id} 最近一次构建。请重新运行分块评估，并用 {command} 记录新的决定。',
    'gate.not_ready': '未激活。{id} 仍在构建中。请先完成构建，然后再次激活。',
    'gate.ambiguous_profile': '未激活。有多个文档类型存在相同 ID 的配置。请点击“重新加载面板”，然后在对应文档类型的表格中激活。',
    'gate.no_previous': '没有可回滚的内容。{type}已在使用原有分块。',
    'gate.other': '未更改。服务器拒绝了请求，代码 {code}。请点击“重新加载面板”后重试。如果再次出现，请在应用日志中查找 [RAG Admin]。',
    'report.loading': '正在加载对比报告…',
    'report.fixture': '此报告来自内置的测试数据。它只说明评估流程可用，并不反映你的文档。选择配置之前，请先运行实际评估。',
    'report.empty.title': '还没有对比报告',
    'report.empty.body': '运行 {command}，将各配置与原有分块进行对比，提交报告并重新部署。对比结果随后会显示在这里。',
    'report.baselineOnly': '只评估了原有分块。请在评估中加入候选配置以进行对比。',
    'report.unreadable': '本部署中的对比报告或决定文件无效，无法显示。请重新运行 {command}，提交结果并重新部署。',
    'report.unavailable': '暂时无法读取对比报告。请稍后点击“重新加载面板”。',
    'report.decisions': '评估决定',
    'report.decisionsCaption': '每种文档类型的评估决定',
    'report.col.type': '文档类型',
    'report.col.chosen': '选定的配置',
    'report.col.gate': '与原有分块对比',
    'report.col.source': '来源',
    'report.col.recorded': '记录日期',
    'source.live': '实际评估',
    'source.fixture': '测试数据',
    'gate.passed': '通过',
    'gate.failed': '未通过',
    'gate.baseline': '基准',
    'gate.showRegressions': '查看变差的指标（{count}）',
    'gate.regression': '{metric}，{slice}：{diff}（允许：{band}）',
    'report.compareOn': '对比范围',
    'report.comparison': '配置对比',
    'slice.overall': '全部',
    'slice.group.docType': '文档类型',
    'slice.group.language': '提问语言',
    'slice.group.kind': '问题类型',
    'kind.fact_lookup': '事实查找',
    'kind.context_heavy': '需要较多上下文',
    'kind.clause': '合同条款',
    'kind.other': '其他',
    'lang.zh': '中文',
    'lang.en': '英语',
    'lang.it': '意大利语',
    'report.caption': '分块配置对比：{slice}',
    'report.col.profile': '配置',
    'report.col.recall': 'Recall@k',
    'report.col.mrr': 'MRR',
    'report.col.falseRefusal': '误拒答',
    'report.col.correctRefusal': '正确拒答',
    'report.col.judge': '回答正确率',
    'report.col.context': '上下文 token（平均）',
    'report.col.latency': '延迟 p50 / p95',
    'report.rateSub': '点估计，95% 上界',
    'cell.point': '点估计',
    'cell.upper': '95% 上界 {value}',
    'cell.n': 'n = {n}',
    'cell.noItems': '没有条目',
    'report.registeredAs': '已登记为 {id}（{status}）',
    'report.judgeSkipped': '已跳过（见备注）',
    'report.noData': '无数据',
    'report.latency': '{p50} / {p95} 毫秒',
    'report.notes': '评估备注（英文）',
  },
  it: {
    'panel.title': 'Profili di chunking',
    'panel.description':
      'Dimensioni dei chunk per tipo di documento. Costruisci un nuovo profilo accanto a quello attuale, confrontalo nel report, poi attivalo. Vale per tutti gli spazi di lavoro di questa installazione.',
    'panel.tabsLabel': 'Viste dei profili di chunking',
    'tab.profiles': 'Profili',
    'tab.report': 'Report di confronto',
    'action.new': 'Nuovo profilo',
    'action.refresh': 'Aggiorna profili',
    'action.create': 'Crea profilo',
    'action.closeForm': 'Chiudi modulo',
    'action.build': 'Costruisci profilo',
    'action.buildAria': 'Costruisci il profilo {id}',
    'action.continue': 'Continua costruzione',
    'action.continueAria': 'Continua la costruzione di {id}',
    'action.buildMissing': 'Costruisci documenti mancanti',
    'action.buildMissingAria': 'Costruisci i documenti mancanti di {id}',
    'action.pause': 'Sospendi costruzione',
    'action.activate': 'Attiva profilo',
    'action.activateAria': 'Attiva il profilo {id} per {type}',
    'action.rollback': 'Ripristina profilo',
    'action.rollbackAria': 'Ripristina il profilo precedente per {type}',
    'action.keep': 'Mantieni profilo attuale',
    'action.reload': 'Ricarica pannello',
    'list.loading': 'Caricamento dei profili di chunking…',
    'list.loaded': 'Profili caricati: {count}.',
    'list.updatedAt': 'Aggiornato alle {time}',
    'list.empty.title': 'Nessun profilo di chunking trovato',
    'list.empty.body':
      'La tabella dei profili è vuota: le migrazioni del database della fase 4 non sono state applicate. Applica i file in supabase/migrations (0406 e successivi), poi seleziona «Ricarica pannello».',
    'group.active': 'Attivo: {profile}',
    'group.since': 'dal {date}',
    'group.onlyLegacy': 'Sono attivi i chunk originali. Nessun altro profilo per questo tipo di documento.',
    'table.caption': 'Profili di chunking per {type}',
    'col.profile': 'Profilo',
    'col.sizes': 'Dimensioni',
    'col.status': 'Stato',
    'col.documents': 'Documenti costruiti',
    'col.actions': 'Azioni',
    'legacy.name': 'Chunk originali',
    'legacy.sizes': 'Come al primo caricamento',
    'sizes.pair': '{child} / {parent} token',
    'mode.structure': 'I chunk padre seguono la struttura del documento',
    'mode.fixed': 'Chunk padre a dimensione fissa',
    'preset.label': 'Preset {name}',
    'preset.custom': 'Personalizzato',
    'preset.default': 'predefinito',
    'status.building': 'In costruzione',
    'status.ready': 'Pronto',
    'status.active': 'Attivo',
    'status.retired': 'Ritirato',
    'docs.built': '{built} di {total}',
    'docs.missing': 'Mancanti: {missing}',
    'docs.notMeasured': 'Non misurato',
    'docs.notApplicable': 'Non applicabile',
    'badge.decision': 'Scelta del confronto',
    'coverage.warning':
      'Documenti mancanti dal profilo attivo {id}: {count}. Finché il profilo non viene ricostruito, le domande su questi documenti ricevono risposta dai chunk originali. Seleziona «Costruisci documenti mancanti» per aggiungerli.',
    'coverage.unknown': 'Non è stato possibile contare i documenti mancanti dal profilo attivo {id}. Seleziona «Aggiorna profili».',
    'help.decision':
      "L’attivazione richiede una decisione di confronto superata e registrata nel database. Quella mostrata qui è nei file di questa installazione e può essere diversa. Dopo un confronto, registra la decisione con {command}.",
    'decision.line': 'Decisione del confronto: {profile}, {gate}, {source}, {date}',
    'decision.none': 'Nessuna decisione registrata',
    'decision.unavailable': 'Le decisioni del confronto non sono disponibili al momento. Apri «Report di confronto» per i dettagli.',
    'form.title': 'Nuovo profilo di chunking',
    'form.docType': 'Tipo di documento',
    'form.preset': 'Dimensioni',
    'form.child': 'Dimensione del chunk figlio (token)',
    'form.childHelp': 'I pezzi piccoli in cui si cerca.',
    'form.parent': 'Dimensione del chunk padre (token)',
    'form.parentHelp': 'Il passaggio più ampio inviato al modello attorno a un chunk figlio trovato.',
    'form.mode': 'Confini dei chunk padre',
    'form.mode.structure': 'Segui la struttura del documento, fino alla dimensione del padre',
    'form.mode.fixed': 'Dimensione fissa',
    'form.id': 'ID profilo',
    'form.idHelp':
      "Lettere minuscole, cifre, punti, trattini e trattini bassi, fino a 64 caratteri. L’ID suggerito corrisponde al report di confronto, così una decisione registrata trova questo profilo.",
    'form.presetLocked': 'Impostato dal preset. Scegli «Personalizzato» per modificarlo.',
    'form.number': 'Inserisci un numero intero pari o superiore a 1.',
    'form.idInvalid': 'Usa lettere minuscole, cifre, punti, trattini e trattini bassi, iniziando con una lettera o una cifra.',
    'form.idReserved': "L’ID «legacy» è riservato. Inseriscine un altro.",
    'form.checking': 'Verifica con il server…',
    'form.serverUnchecked':
      'Non è stato possibile verificare questi valori con il server. Puoi comunque creare il profilo: il server li controlla di nuovo.',
    'form.creating': 'Creazione…',
    'form.created': 'Profilo {id} creato per {type}. Seleziona «Costruisci profilo» per riempirlo di documenti.',
    'finding.child_exceeds_embedding_input':
      'La dimensione del chunk figlio supera il limite del modello di embedding. Inserisci un valore più piccolo.',
    'finding.parent_below_twice_child': 'La dimensione del padre deve essere almeno il doppio del figlio: {min} o più.',
    'finding.parent_tokens_required': 'Inserisci la dimensione del padre.',
    'finding.ratio_outside_4_8': "Il padre è {ratio} volte il figlio. L’intervallo provato va da 4 a 8 volte. Puoi comunque creare il profilo.",
    'finding.top_k_parent_over_budget':
      'Con questa dimensione, i chunk padre recuperati possono superare il budget di token del contesto, che viene tagliato per rientrarvi. Puoi comunque creare il profilo: il report di confronto mostra i token di contesto misurati.',
    'finding.invalid_shape': 'Alcuni valori mancano o non sono numeri interi. Controlla ogni campo.',
    'error.listUnavailable': 'I profili di chunking non sono disponibili al momento. Seleziona «Ricarica pannello» tra poco.',
    'error.createUnavailable':
      'Il profilo non è stato creato perché il servizio non è disponibile. I valori sono ancora nel modulo. Seleziona di nuovo «Crea profilo» tra poco.',
    'error.profileExists': "Esiste già un profilo con questo ID per questo tipo di documento. Cambia l’ID del profilo.",
    'error.rejected': "Il database non ha accettato questi valori. Controlla le dimensioni e l’ID del profilo, poi seleziona di nuovo «Crea profilo».",
    'error.invalidField': 'Controlla {field}: il server non ha accettato il valore.',
    'error.invalid': 'La richiesta non è stata accettata. Seleziona «Ricarica pannello» e riprova.',
    'error.profileGone': "Questo profilo non esiste più. L’elenco è stato aggiornato.",
    'error.changeUnknown':
      "Il server non ha confermato la modifica: potrebbe essere stata applicata oppure no. L’elenco è stato aggiornato e mostra il profilo attivo ora.",
    'build.barLabel': 'Avanzamento della costruzione di {id}',
    'build.region': 'Costruzione di {id}',
    'build.starting': 'Avvio della costruzione…',
    'build.progress': '{done} di {total} documenti costruiti',
    'build.note':
      'Ogni passo dura fino a 45 secondi. Tieni aperta questa pagina: se esci, la costruzione si sospende e «Continua costruzione» la riprende.',
    'build.gaps': 'Documenti non costruiti finora: {count}',
    'build.busy': 'È in corso una costruzione. Sospendila o attendi che finisca.',
    'build.pausing': 'Sospensione dopo questo passo…',
    'build.paused': 'Costruzione sospesa a {done} di {total} documenti. Seleziona «Continua costruzione» per riprendere.',
    'build.completed': 'Costruzione completata. Documenti costruiti: {total}. {id} è ora pronto.',
    'build.repaired': 'Costruzione completata. Ora a {id} non manca alcun documento.',
    'build.none': 'Niente da costruire. Tutti i documenti di tipo {type} hanno già chunk in {id}.',
    'build.incomplete':
      'Costruzione terminata, ma alcuni documenti sono rimasti fuori: {count}. {id} non può essere attivato finché non vengono costruiti.',
    'gap.no_parse_output':
      "Senza output di parsing salvato: {count}. Questi documenti sono stati caricati prima che l’output di parsing venisse conservato. Sul server esegui {command} per elencarli, caricali di nuovo, poi seleziona «Continua costruzione».",
    'gap.failed': "Chunking non riuscito: {count}. Cerca [RAG Rechunk] nel log dell’app, risolvi la causa, poi seleziona «Continua costruzione».",
    'gap.other': "Esclusi con il codice {code}: {count}. Cerca [RAG Rechunk] nel log dell’app.",
    'build.failed':
      "La costruzione si è fermata a {done} di {total} documenti. L’avanzamento è salvato. Seleziona «Continua costruzione». Se si ferma di nuovo, cerca [RAG Rechunk] nel log dell’app.",
    'build.stalled': "La costruzione non avanza. L’avanzamento è salvato. Attendi un minuto, poi seleziona «Continua costruzione».",
    'build.unavailable':
      "Il servizio di costruzione non è disponibile al momento. L’avanzamento è salvato. Seleziona «Continua costruzione» tra poco.",
    'build.network':
      "La connessione è caduta durante la costruzione. L’avanzamento è salvato. Verifica che il server della Config UI sia in esecuzione, poi seleziona «Continua costruzione».",
    'build.saved': "L’avanzamento è salvato.",
    'build.refused.profile_retired': 'Questo profilo è ritirato e non può essere costruito. Crea un nuovo profilo.',
    'build.refused.other': 'La costruzione è stata rifiutata con il codice {code}. Seleziona «Ricarica pannello» e riprova.',
    'confirm.activate.title': 'Attivare {id} per {type}?',
    'confirm.activate.body':
      'Le domande sui documenti di tipo {type} riceveranno subito risposta da questo profilo ({sizes}) in tutti gli spazi di lavoro. Il profilo attuale, {current}, resta costruito e «Ripristina profilo» vi fa ritorno.',
    'confirm.activate.bodyLegacy':
      'Le domande sui documenti di tipo {type} riceveranno subito risposta dai chunk originali in tutti gli spazi di lavoro. Il profilo attuale, {current}, resta costruito e può essere riattivato.',
    'confirm.rollback.title': 'Ripristinare il profilo precedente per {type}?',
    'confirm.rollback.body':
      'I documenti di tipo {type} tornano subito a {previous} in tutti gli spazi di lavoro. {current} resta costruito e può essere riattivato.',
    'confirm.activating': 'Attivazione…',
    'confirm.rollingBack': 'Ripristino…',
    'activate.done': '{id} è ora attivo per {type}. {previous} resta costruito.',
    'activate.already': '{id} era già attivo per {type}. Nessuna modifica.',
    'rollback.done': '{type} ora usa {restored}. {rolledBack} è pronto e può essere riattivato.',
    'gate.incomplete':
      'Non attivato. Alcuni documenti di tipo {type} non hanno ancora chunk in {id}. Seleziona «Costruisci documenti mancanti» su quel profilo, poi attiva di nuovo.',
    'gate.open_gaps':
      "Non attivato. L’ultima costruzione di {id} ha lasciato fuori documenti che non è riuscita a costruire. Costruisci di nuovo il profilo e risolvi ciò che segnala, poi attiva di nuovo.",
    'gate.no_evidence':
      'Non attivato. Nel database non è registrata alcuna decisione di confronto per {id}. Esegui il confronto dei profili, registra la decisione con {command}, poi attiva di nuovo.',
    'gate.eval_failed':
      'Non attivato. La decisione registrata per {id} non ha superato il confronto con i chunk originali. Apri «Report di confronto», confronta i profili e attivane uno che l\'ha superato.',
    'gate.stale_evidence':
      "Non attivato. La decisione registrata è precedente all’ultima costruzione di {id}. Esegui di nuovo il confronto e registra la nuova decisione con {command}.",
    'gate.not_ready': 'Non attivato. {id} è ancora in costruzione. Completa la costruzione, poi attiva di nuovo.',
    'gate.ambiguous_profile':
      'Non attivato. Più tipi di documento hanno un profilo con questo ID. Seleziona «Ricarica pannello», poi attivalo dalla tabella del suo tipo di documento.',
    'gate.no_previous': 'Niente da ripristinare. {type} usa già i chunk originali.',
    'gate.other':
      "Nessuna modifica. Il server ha rifiutato con il codice {code}. Seleziona «Ricarica pannello» e riprova. Se si ripete, cerca [RAG Admin] nel log dell’app.",
    'report.loading': 'Caricamento del report di confronto…',
    'report.fixture':
      'Questo report proviene dai dati di prova integrati. Dimostra che il confronto funziona, non misura i tuoi documenti. Esegui il confronto reale prima di scegliere un profilo.',
    'report.empty.title': 'Nessun report di confronto',
    'report.empty.body':
      'Esegui {command} per confrontare i profili con i chunk originali, salva il report nel repository e ridistribuisci. Il confronto apparirà qui.',
    'report.baselineOnly': 'Sono stati misurati solo i chunk originali. Aggiungi profili candidati al confronto.',
    'report.unreadable':
      'Il report di confronto o il file delle decisioni di questa installazione non è valido e non può essere mostrato. Esegui di nuovo {command}, salva il risultato nel repository e ridistribuisci.',
    'report.unavailable': 'Il report di confronto non è disponibile al momento. Seleziona «Ricarica pannello» tra poco.',
    'report.decisions': 'Decisioni del confronto',
    'report.decisionsCaption': 'Decisione del confronto per tipo di documento',
    'report.col.type': 'Tipo di documento',
    'report.col.chosen': 'Profilo scelto',
    'report.col.gate': 'Confronto con i chunk originali',
    'report.col.source': 'Origine',
    'report.col.recorded': 'Registrata il',
    'source.live': 'Confronto reale',
    'source.fixture': 'Dati di prova',
    'gate.passed': 'Superato',
    'gate.failed': 'Non superato',
    'gate.baseline': 'Riferimento',
    'gate.showRegressions': 'Mostra cosa è peggiorato ({count})',
    'gate.regression': '{metric}, {slice}: {diff} (consentito: {band})',
    'report.compareOn': 'Confronta su',
    'report.comparison': 'Profili a confronto',
    'slice.overall': 'Complessivo',
    'slice.group.docType': 'Tipo di documento',
    'slice.group.language': 'Lingua della domanda',
    'slice.group.kind': 'Tipo di domanda',
    'kind.fact_lookup': 'Ricerca di un dato',
    'kind.context_heavy': 'Richiede più contesto',
    'kind.clause': 'Clausola contrattuale',
    'kind.other': 'Altro',
    'lang.zh': 'Cinese',
    'lang.en': 'Inglese',
    'lang.it': 'Italiano',
    'report.caption': 'Profili di chunking a confronto su: {slice}',
    'report.col.profile': 'Profilo',
    'report.col.recall': 'Recall@k',
    'report.col.mrr': 'MRR',
    'report.col.falseRefusal': 'Rifiuti errati',
    'report.col.correctRefusal': 'Rifiuti corretti',
    'report.col.judge': 'Correttezza delle risposte',
    'report.col.context': 'Token di contesto (media)',
    'report.col.latency': 'Latenza p50 / p95',
    'report.rateSub': 'stima puntuale, limite superiore al 95%',
    'cell.point': 'stima puntuale',
    'cell.upper': 'limite superiore al 95% {value}',
    'cell.n': 'n = {n}',
    'cell.noItems': 'Nessun elemento',
    'report.registeredAs': 'Registrato come {id} ({status})',
    'report.judgeSkipped': 'Saltata (vedi note)',
    'report.noData': 'Nessun dato',
    'report.latency': '{p50} / {p95} ms',
    'report.notes': 'Note del confronto (in inglese)',
  },
};

const CHUNKING_DOC_TYPE_ORDER = Object.freeze(['general', 'financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image']);
const CHUNKING_API = '/api/rag/admin/chunking-profiles';
const CHUNKING_LANGUAGES_ENDPOINT = '/api/config/languages';
const CHUNKING_LANGUAGE_CODE = /^[a-z]{2,3}$/;

// D-06: the language codes come from the config server's languages answer, fetched once per page and cached here.
let chunkingLanguageCodes = null;
let chunkingLanguagesRequest = null;

/** The pack codes of a GET /api/config/languages answer, in its order; null when the answer has none. */
function chunkingLanguageCodesFrom(body) {
  const packs = body && Array.isArray(body.packs) ? body.packs : null;
  if (!packs) return null;
  const codes = [];
  for (const pack of packs) {
    const code = pack && pack.code;
    if (typeof code === 'string' && CHUNKING_LANGUAGE_CODE.test(code) && !codes.includes(code)) codes.push(code);
  }
  return codes.length > 0 ? codes : null;
}

/** Loads the language codes once; a failed request leaves them unset and lets the next call try again. */
function loadChunkingLanguages(fetchImpl) {
  if (chunkingLanguageCodes) return Promise.resolve(chunkingLanguageCodes);
  if (chunkingLanguagesRequest) return chunkingLanguagesRequest;
  chunkingLanguagesRequest = (async () => {
    try {
      const response = await fetchImpl(CHUNKING_LANGUAGES_ENDPOINT, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (response && response.ok) chunkingLanguageCodes = chunkingLanguageCodesFrom(await response.json());
    } catch {
      chunkingLanguageCodes = null;
    }
    chunkingLanguagesRequest = null;
    return chunkingLanguageCodes;
  })();
  return chunkingLanguagesRequest;
}

function resetChunkingLanguagesForTests() {
  chunkingLanguageCodes = null;
  chunkingLanguagesRequest = null;
}
const CHUNKING_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CHUNKING_RECORD_COMMAND = 'npm run rag:chunking -- record-decision <decision.json>';
const CHUNKING_SWEEP_COMMAND = 'python -m rag_eval.sweep chunking';
const CHUNKING_GATE_REASONS = Object.freeze(['incomplete', 'open_gaps', 'no_evidence', 'eval_failed', 'stale_evidence', 'not_ready', 'ambiguous_profile', 'no_previous']);
const CHUNKING_FORM_FIELDS = Object.freeze({
  id: 'form.id',
  doc_type: 'form.docType',
  child_tokens: 'form.child',
  parent_tokens: 'form.parent',
  parent_mode: 'form.mode',
  preset: 'form.preset',
});
const CHUNKING_METRIC_LABELS = Object.freeze({
  recall_at_k: 'report.col.recall',
  mrr: 'report.col.mrr',
  false_refusal_rate: 'report.col.falseRefusal',
  correct_refusal_rate: 'report.col.correctRefusal',
  judge_correctness: 'report.col.judge',
  context_tokens: 'report.col.context',
  latency_p50_ms: 'report.col.latency',
  latency_p95_ms: 'report.col.latency',
});
const CHUNKING_BUILD_TIMEOUT_MS = 70000;
const CHUNKING_ANNOUNCE_MS = 30000;

function chunkingLocale(locale) {
  return locale === 'zh' || locale === 'it' ? locale : 'en';
}

function chunkingDetectLocale() {
  const lang = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').slice(0, 2);
  return chunkingLocale(lang);
}

function chunkingTemplate(key, locale) {
  const loc = chunkingLocale(locale);
  const table = CHUNKING_LABELS[loc] || CHUNKING_LABELS.en;
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  if (Object.prototype.hasOwnProperty.call(CHUNKING_LABELS.en, key)) return CHUNKING_LABELS.en[key];
  return null;
}

/**
 * Splits a template into text and code segments. A var given as { code } becomes a code segment, { time } a time segment; anything
 * else is inserted as text.
 */
function chunkingFill(template, vars) {
  const segments = [];
  const source = String(template);
  const re = /\{(\w+)\}/g;
  let last = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (match.index > last) segments.push({ text: source.slice(last, match.index) });
    const name = match[1];
    const value = vars && Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
    if (value && typeof value === 'object' && typeof value.code === 'string') segments.push({ code: value.code });
    else if (value && typeof value === 'object' && typeof value.mono === 'string') segments.push({ mono: value.mono });
    else if (value && typeof value === 'object' && value.time) segments.push({ time: value.time });
    else if (value === undefined || value === null) segments.push({ text: match[0] });
    else segments.push({ text: String(value) });
    last = re.lastIndex;
  }
  if (last < source.length) segments.push({ text: source.slice(last) });
  const merged = [];
  for (const segment of segments) {
    const prev = merged[merged.length - 1];
    if (segment.text !== undefined && prev && prev.text !== undefined) prev.text += segment.text;
    else merged.push(segment);
  }
  return merged;
}

function chunkingSegmentsText(segments) {
  return segments.map((s) => (s.text !== undefined ? s.text : s.code !== undefined ? s.code : s.mono !== undefined ? s.mono : s.time.text)).join('');
}

function chunkingAppUrl(fallback) {
  if (fallback) return fallback;
  if (typeof window !== 'undefined' && typeof window.getConfiguredMyRAGAppUrl === 'function') return window.getConfiguredMyRAGAppUrl();
  if (typeof window !== 'undefined' && window.location && window.location.origin) return window.location.origin;
  return 'http://localhost:3000';
}

function chunkingSharedTemplate(key, locale) {
  const placeholderVars = {};
  let text = null;
  if (typeof window !== 'undefined' && typeof window.ingestLabel === 'function') {
    text = window.ingestLabel(key, locale, placeholderVars);
  } else if (typeof require === 'function') {
    try {
      text = require('../document-processing/status-monitor.js').ingestLabel(key, locale, placeholderVars);
    } catch {
      text = null;
    }
  }
  if (text && text !== key) return text;
  if (key === 'error.signIn' && typeof window !== 'undefined' && typeof window.authMessage === 'function') return window.authMessage(401, '{appUrl}');
  if (key === 'error.network') return "Can't reach the Config UI server. Check that it is running, then reload.";
  if (key === 'error.signIn') return 'Admin sign-in required. Sign in to the main myRAG app at {appUrl} (Settings → Admin tab), then reload the Config UI.';
  return 'Request failed ({status}).';
}

/** A localized message as segments and plain text. Shared keys (sign-in, network, generic) come from the ingestLabel table. */
function chunkingMessage(key, locale, vars) {
  const shared = key === 'error.signIn' || key === 'error.network' || key === 'error.generic';
  const template = shared ? chunkingSharedTemplate(key, chunkingLocale(locale)) : chunkingTemplate(key, locale);
  const segments = chunkingFill(template === null ? key : template, vars || {});
  return { key, segments, text: chunkingSegmentsText(segments) };
}

function chunkingLabel(key, locale, vars) {
  return chunkingMessage(key, locale, vars).text;
}

function chunkingDocTypeName(id, locale) {
  if (typeof window !== 'undefined' && typeof window.docTypeLabelForLocale === 'function') return window.docTypeLabelForLocale(id, locale);
  if (typeof require === 'function') {
    try {
      return require('./doc-types.js').docTypeLabelForLocale(id, chunkingLocale(locale));
    } catch {
      return id;
    }
  }
  return id;
}

function chunkingNumber(value, locale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Intl.NumberFormat(chunkingLocale(locale)).format(value);
}

function chunkingDecimal(value, locale, digits) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Intl.NumberFormat(chunkingLocale(locale), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function chunkingPercent(value, locale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Intl.NumberFormat(chunkingLocale(locale), { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

/** A date as { iso, text } for a time element; date-only strings are read as calendar dates, not shifted by the time zone. */
function chunkingDate(value, locale, style) {
  if (typeof value !== 'string' || value === '') return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? value + 'T00:00:00Z' : value);
  if (Number.isNaN(parsed.getTime())) return null;
  const options = style === 'time' ? { timeStyle: 'short' } : { dateStyle: 'medium' };
  if (dateOnly) options.timeZone = 'UTC';
  return { iso: value, text: new Intl.DateTimeFormat(chunkingLocale(locale), options).format(parsed) };
}

function chunkingWhole(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function chunkingCompleteness(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const total = chunkingWhole(raw.current_ready_documents);
  const built = chunkingWhole(raw.documents_with_children);
  const missing = chunkingWhole(raw.missing_documents);
  if (total === null || built === null || missing === null) return null;
  return { total, built, missing };
}

/** The view of one list row: only the fields the panel renders (UI-SPEC section 11). Legacy rows never carry sizes. */
function chunkingRowView(raw, activeId) {
  const id = String(raw.id);
  const isLegacy = id === 'legacy';
  const status = id === activeId ? 'active' : raw.status === 'building' || raw.status === 'retired' ? raw.status : 'ready';
  const completeness = isLegacy ? null : chunkingCompleteness(raw.completeness);
  const view = {
    id,
    docType: String(raw.doc_type),
    isLegacy,
    status,
    active: status === 'active',
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
    activatedAt: typeof raw.activated_at === 'string' ? raw.activated_at : null,
    completeness,
    action: null,
  };
  if (!isLegacy) {
    view.childTokens = chunkingWhole(raw.child_tokens);
    view.parentTokens = chunkingWhole(raw.parent_tokens);
    view.parentMode = raw.parent_mode === 'fixed' ? 'fixed' : raw.parent_mode === 'structure' ? 'structure' : 'none';
    view.preset = typeof raw.preset === 'string' ? raw.preset : 'custom';
  }
  if (view.active) view.previousActiveId = typeof raw.previous_active_id === 'string' ? raw.previous_active_id : null;
  const missing = completeness ? completeness.missing : 0;
  if (status === 'building') view.action = completeness && completeness.built > 0 ? 'continue' : 'build';
  else if (status === 'ready') view.action = !isLegacy && missing > 0 ? 'buildMissing' : 'activate';
  return view;
}

const CHUNKING_ROW_RANK = { active: 0, ready: 1, building: 2, legacy: 3, retired: 4 };

function chunkingRowRank(row) {
  if (row.status === 'active') return 0;
  if (row.status === 'retired') return 4;
  if (row.isLegacy) return 3;
  return CHUNKING_ROW_RANK[row.status] === undefined ? 1 : CHUNKING_ROW_RANK[row.status];
}

/** Groups the list answer per document type in the fixed order and marks the active pointer. */
function profilesByDocType(list) {
  const body = list && typeof list === 'object' ? list : {};
  const active = body.active && typeof body.active === 'object' ? body.active : {};
  const missing = body.missing_from_active && typeof body.missing_from_active === 'object' ? body.missing_from_active : {};
  const profiles = Array.isArray(body.profiles) ? body.profiles : [];
  return CHUNKING_DOC_TYPE_ORDER.map((docType) => {
    const activeId = typeof active[docType] === 'string' ? active[docType] : 'legacy';
    const rows = profiles
      .filter((raw) => raw && typeof raw === 'object' && raw.doc_type === docType && typeof raw.id === 'string')
      .map((raw) => chunkingRowView(raw, activeId))
      .sort((a, b) => chunkingRowRank(a) - chunkingRowRank(b) || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const rawMissing = missing[docType];
    const missingFromActive = activeId === 'legacy' ? 0 : typeof rawMissing === 'number' && Number.isFinite(rawMissing) ? rawMissing : null;
    const onlyLegacy = rows.filter((r) => r.status !== 'retired').every((r) => r.isLegacy);
    return { docType, activeId, missingFromActive, onlyLegacy, rows, activeRow: rows.find((r) => r.active) || null };
  });
}

/** Null when nothing is missing; otherwise the count, the profile and the rebuild hint (or the could-not-count notice). */
function coverageWarning(group, locale) {
  if (!group || group.activeId === 'legacy' || group.missingFromActive === 0) return null;
  if (group.missingFromActive === null || group.missingFromActive === undefined) {
    return { ...chunkingMessage('coverage.unknown', locale, { id: group.activeId }), count: null, profileId: group.activeId, showBuild: false };
  }
  const count = group.missingFromActive;
  return {
    ...chunkingMessage('coverage.warning', locale, { id: group.activeId, count: chunkingNumber(count, locale) }),
    count,
    profileId: group.activeId,
    showBuild: true,
  };
}

/** The activation and rollback gate's named refusal as a sentence; an unknown reason is shown as code within gate.other. */
function chunkingRefusalMessage(reason, locale, vars) {
  const known = CHUNKING_GATE_REASONS.includes(reason);
  const key = known ? 'gate.' + reason : 'gate.other';
  return chunkingMessage(key, locale, { ...(vars || {}), command: { code: CHUNKING_RECORD_COMMAND }, code: { code: String(reason) } });
}

function chunkingMetric(metric) {
  if (!metric || typeof metric !== 'object') return { value: null, upper95: null, n: 0 };
  const value = typeof metric.value === 'number' && Number.isFinite(metric.value) ? metric.value : null;
  const upper95 = typeof metric.upper_95 === 'number' && Number.isFinite(metric.upper_95) ? metric.upper_95 : null;
  const n = typeof metric.n === 'number' && Number.isFinite(metric.n) ? metric.n : 0;
  return { value, upper95, n };
}

function chunkingSliceMetrics(metrics, slice) {
  if (!metrics || typeof metrics !== 'object') return null;
  const value = typeof slice === 'string' && slice !== '' ? slice : 'overall';
  if (value === 'overall') return metrics.overall || null;
  if (CHUNKING_DOC_TYPE_ORDER.includes(value)) return (metrics.by_doc_type || {})[value] || null;
  const [group, key] = value.split(':');
  const table = group === 'doc_type' ? metrics.by_doc_type : group === 'language' ? metrics.by_language : group === 'kind' ? metrics.by_question_kind : null;
  return table && key && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

/** One row per report profile for a slice ('overall', a doc type id, 'doc_type:x', 'language:x' or 'kind:x'). */
function reportRows(report, slice) {
  const profiles = report && Array.isArray(report.profiles) ? report.profiles : [];
  return profiles.map((profile) => {
    const metrics = chunkingSliceMetrics(profile && profile.metrics, slice) || {};
    const gate = profile && profile.gate;
    let gateView;
    if (!gate) gateView = { kind: 'baseline', regressions: [] };
    else {
      const regressions = Array.isArray(gate.regressions)
        ? gate.regressions.map((r) => ({ metric: String(r.metric), slice: String(r.slice), diff: Number(r.diff), band: Number(r.band) }))
        : [];
      gateView = { kind: gate.passed === true ? 'passed' : 'failed', regressions };
    }
    const judge = chunkingMetric(metrics.judge_correctness);
    return {
      profileId: String(profile && profile.profile_id),
      isLegacy: profile && profile.profile_id === 'legacy',
      gate: gateView,
      recall: chunkingMetric(metrics.recall_at_k).value,
      mrr: chunkingMetric(metrics.mrr).value,
      falseRefusal: chunkingMetric(metrics.false_refusal_rate),
      correctRefusal: chunkingMetric(metrics.correct_refusal_rate),
      judge: { skipped: metrics.judge_skipped === true, value: judge.value, n: judge.n },
      contextTokens: chunkingMetric(metrics.context_tokens).value,
      latencyP50: chunkingMetric(metrics.latency_p50_ms).value,
      latencyP95: chunkingMetric(metrics.latency_p95_ms).value,
    };
  });
}

/** The slices the comparison can show: overall, the six doc types, the configured languages (none until they arrive) and the question kinds in the report. */
function chunkingReportSlices(report, languages) {
  const slices = [{ value: 'overall', group: null, key: null }];
  for (const docType of CHUNKING_DOC_TYPE_ORDER) slices.push({ value: 'doc_type:' + docType, group: 'docType', key: docType });
  const codes = Array.isArray(languages) ? languages : chunkingLanguageCodes || [];
  for (const lang of codes) slices.push({ value: 'language:' + lang, group: 'language', key: lang });
  const kinds = new Set();
  const profiles = report && Array.isArray(report.profiles) ? report.profiles : [];
  for (const profile of profiles) {
    const byKind = profile && profile.metrics && profile.metrics.by_question_kind;
    if (byKind && typeof byKind === 'object') Object.keys(byKind).forEach((k) => kinds.add(k));
  }
  const known = ['fact_lookup', 'context_heavy', 'clause', 'other'];
  const ordered = [...known.filter((k) => kinds.has(k)), ...[...kinds].filter((k) => !known.includes(k)).sort()];
  for (const kind of ordered) slices.push({ value: 'kind:' + kind, group: 'kind', key: kind });
  return slices;
}

/** One row per doc type with the latest recorded decision (allow-listed fields only), or null. */
function chunkingDecisionRows(decisions) {
  const list = Array.isArray(decisions) ? decisions : [];
  return CHUNKING_DOC_TYPE_ORDER.map((docType) => {
    const matches = list.filter((d) => d && d.doc_type === docType);
    matches.sort((a, b) => (String(a.recorded_at) < String(b.recorded_at) ? 1 : String(a.recorded_at) > String(b.recorded_at) ? -1 : 0));
    const latest = matches[0];
    if (!latest) return { docType, decision: null };
    return {
      docType,
      decision: {
        profile_id: String(latest.profile_id),
        gate_passed: latest.gate_passed === true,
        source: latest.source === 'live' ? 'live' : 'fixture',
        recorded_at: typeof latest.recorded_at === 'string' ? latest.recorded_at : '',
      },
    };
  });
}

function chunkingSuggestedId(child, parent, docType) {
  return 'p' + String(child === null || child === undefined ? '' : child) + '-' + String(parent === null || parent === undefined ? '' : parent) + '-' + docType;
}

function chunkingParseWhole(text) {
  const value = String(text === null || text === undefined ? '' : text).trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function chunkingValidatorFn() {
  if (typeof window !== 'undefined' && typeof window.validateChunking === 'function') return window.validateChunking;
  if (typeof require === 'function') {
    try {
      return require('./chunking-validate.js').validateChunking;
    } catch {
      return null;
    }
  }
  return null;
}

function chunkingPresetFn() {
  if (typeof window !== 'undefined' && typeof window.chunkingPresetSizes === 'function') return window.chunkingPresetSizes;
  if (typeof require === 'function') {
    try {
      return require('./chunking-validate.js').chunkingPresetSizes;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Field checks and the local rules for the form. The parent size is required in both modes (the database requires it); an empty parent
 * in fixed mode is left to the validator's parent_tokens_required. No context is passed, so the two context rules come from the server.
 */
function chunkingFormFindings(fields) {
  const f = fields || {};
  const docType = CHUNKING_DOC_TYPE_ORDER.includes(f.docType) ? f.docType : 'general';
  const preset = ['128/512', '256/1024', '256/2048'].includes(f.preset) ? f.preset : 'custom';
  const presetSizes = chunkingPresetFn();
  const fieldErrors = {};
  let child;
  let parent;
  let mode;
  if (preset !== 'custom' && presetSizes) {
    const sizes = presetSizes(preset);
    child = sizes.child_tokens;
    parent = sizes.parent_tokens;
    mode = sizes.parent_mode;
  } else {
    mode = f.mode === 'fixed' ? 'fixed' : 'structure';
    child = chunkingParseWhole(f.child);
    if (child === null) fieldErrors.child = 'form.number';
    const parentText = String(f.parent === null || f.parent === undefined ? '' : f.parent).trim();
    if (parentText === '') {
      parent = null;
      if (mode !== 'fixed') fieldErrors.parent = 'finding.parent_tokens_required';
    } else {
      parent = chunkingParseWhole(parentText);
      if (parent === null) fieldErrors.parent = 'form.number';
    }
  }
  const id = String(f.id === null || f.id === undefined ? '' : f.id).trim();
  if (id === 'legacy') fieldErrors.id = 'form.idReserved';
  else if (!CHUNKING_ID_PATTERN.test(id)) fieldErrors.id = 'form.idInvalid';

  if (fieldErrors.child || fieldErrors.parent === 'form.number') return { body: null, fieldErrors, errors: [], warnings: [], blocking: true };
  const body = { id, doc_type: docType, child_tokens: child, parent_mode: mode, parent_tokens: parent, preset };
  const validate = chunkingValidatorFn();
  const found = validate ? validate(body, {}) : { errors: [], warnings: [] };
  const fieldError = Object.keys(fieldErrors).length > 0;
  return { body: fieldError ? null : body, fieldErrors, errors: found.errors, warnings: found.warnings, blocking: fieldError || found.errors.length > 0 };
}

function chunkingFindingMessage(code, locale, body) {
  const vars = {};
  if (body && typeof body.child_tokens === 'number') vars.min = chunkingNumber(body.child_tokens * 2, locale);
  if (body && typeof body.child_tokens === 'number' && typeof body.parent_tokens === 'number') {
    vars.ratio = chunkingDecimal(Math.round((body.parent_tokens / body.child_tokens) * 10) / 10, locale, 1);
  }
  const key = 'finding.' + code;
  if (chunkingTemplate(key, locale) === null) return chunkingMessage('gate.other', locale, { code: { code: String(code) } });
  return chunkingMessage(key, locale, vars);
}

function chunkingBody(result) {
  return result && result.body && typeof result.body === 'object' ? result.body : {};
}

/**
 * Maps a ragFetch result (or { thrown: true }) of a route to the UI-SPEC section 8 message. ctx: { id, type, appUrl, done, total }.
 * Flags: signIn (replace the panel), reload (reload the list), field (the form field to mark), findings (finding codes), paused.
 */
function mapChunkingError(result, route, locale, ctx) {
  const c = ctx || {};
  const status = result && typeof result.status === 'number' ? result.status : 0;
  const body = chunkingBody(result);
  const err = typeof body.error === 'string' ? body.error : '';
  const reason = typeof body.reason === 'string' ? body.reason : '';
  const msg = (key, vars, extra) => ({ ...chunkingMessage(key, locale, vars), ...(extra || {}) });

  if (!result || result.thrown) {
    if (route === 'build') return msg('build.network');
    if (route === 'activate' || route === 'rollback') return msg('error.changeUnknown', null, { reload: true });
    if (route === 'validate') return msg('form.serverUnchecked', null, { unchecked: true });
    if (route === 'create') return msg('error.createUnavailable');
    if (route === 'report') return msg('report.unavailable');
    return msg('error.network');
  }
  if (status === 401 || status === 403) return msg('error.signIn', { appUrl: chunkingAppUrl(c.appUrl) }, { signIn: true });
  if (status === 503) {
    if (route === 'validate') return msg('form.serverUnchecked', null, { unchecked: true });
    if (route === 'create') return msg('error.createUnavailable');
    if (route === 'build') return msg('build.unavailable');
    if (route === 'activate' || route === 'rollback') return msg('error.changeUnknown', null, { reload: true });
    if (route === 'report') return msg('report.unavailable');
    return msg('error.listUnavailable');
  }
  if (status === 500 && route === 'report') {
    if (err === 'chunking_report_invalid' || err === 'chunking_decisions_invalid') {
      return msg('report.unreadable', { command: { code: CHUNKING_SWEEP_COMMAND } });
    }
    return msg('report.unavailable');
  }
  if (status === 404 && err === 'profile_not_found') return msg('error.profileGone', null, { reload: true });
  if (status === 409) {
    if (err === 'profile_exists') return msg('error.profileExists', null, { field: 'id' });
    if (err === 'activation_refused' || err === 'rollback_refused') {
      return { ...chunkingRefusalMessage(reason || 'unknown', locale, { id: c.id, type: c.type }), reload: true, gate: true };
    }
    if (err === 'build_refused') {
      if (reason === 'profile_retired') return msg('build.refused.profile_retired', null, { reload: true });
      return msg('build.refused.other', { code: { code: reason || err } }, { reload: true });
    }
  }
  if (status === 499 && err === 'build_aborted') return msg('build.paused', { done: c.done, total: c.total }, { paused: true });
  if (status === 400) {
    const details = Array.isArray(body.details) ? body.details : [];
    if (err === 'invalid_chunking_profile') {
      if (details[0] && details[0].message === 'rejected_by_database') return msg('error.rejected');
      const codes = details.map((d) => String(d && d.message)).filter((code) => code && code !== 'undefined');
      if (codes.length > 0) return { ...chunkingFindingMessage(codes[0], locale, c.body), findings: codes };
    }
    if (err === 'Invalid request data' && details[0] && Object.prototype.hasOwnProperty.call(CHUNKING_FORM_FIELDS, details[0].path)) {
      const field = details[0].path;
      return msg('error.invalidField', { field: chunkingLabel(CHUNKING_FORM_FIELDS[field], locale) }, { field });
    }
    return msg('error.invalid');
  }
  return msg('error.generic', { status: status || '?' });
}

function chunkingBuildAnswer(body) {
  const b = body && typeof body === 'object' ? body : {};
  const reasons = {};
  if (b.gap_reasons && typeof b.gap_reasons === 'object') {
    for (const [key, value] of Object.entries(b.gap_reasons)) if (typeof value === 'number' && value > 0) reasons[key] = value;
  }
  return {
    status: typeof b.status === 'string' ? b.status : 'failed',
    docsDone: chunkingWhole(b.docsDone) === null ? 0 : b.docsDone,
    docsTotal: chunkingWhole(b.docsTotal) === null ? 0 : b.docsTotal,
    gaps: chunkingWhole(b.gaps) === null ? 0 : b.gaps,
    gapReasons: reasons,
    more: b.more === true,
  };
}

/**
 * Posts build steps while the answer says more === true (UI-SPEC section 14 row 2: a gap does not stop the build). Stops when more is
 * false, when shouldPause() turns true after a step, on a non-OK answer (499 build_aborted is a pause), on a throw, or after three steps
 * in a row with more true and the same docsDone (stalled).
 */
async function runChunkingBuild(opts) {
  const post = opts.post;
  const shouldPause = typeof opts.shouldPause === 'function' ? opts.shouldPause : () => false;
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  const stallLimit = typeof opts.stallLimit === 'number' ? opts.stallLimit : 3;
  let last = null;
  let same = 0;
  for (;;) {
    let result;
    try {
      result = await post();
    } catch {
      return { outcome: 'error', last, result: { thrown: true } };
    }
    if (!result || !result.ok) {
      const body = chunkingBody(result);
      if (result && result.status === 499 && body.error === 'build_aborted') return { outcome: 'paused', last, result };
      return { outcome: 'error', last, result: result || { thrown: true } };
    }
    const answer = chunkingBuildAnswer(result.body);
    same = last && answer.more && last.more && answer.docsDone === last.docsDone ? same + 1 : 1;
    last = answer;
    onStep(answer);
    if (!answer.more) {
      const outcome = answer.status === 'completed' ? 'completed' : answer.status === 'incomplete' ? 'incomplete' : 'failed';
      return { outcome, last };
    }
    if (same >= stallLimit) return { outcome: 'stalled', last };
    if (shouldPause()) return { outcome: 'paused', last };
  }
}

/** The rate cell model: point estimate, 95% upper bound and n, or empty when there are no items. */
function chunkingRateView(rate, locale) {
  const r = rate || {};
  if (r.value === null || r.value === undefined || !r.n) return { empty: true };
  const clamp = (v) => Math.max(0, Math.min(100, v * 100));
  return {
    empty: false,
    point: chunkingPercent(r.value, locale),
    upper: r.upper95 === null || r.upper95 === undefined ? null : chunkingPercent(r.upper95, locale),
    n: chunkingNumber(r.n, locale),
    pointPct: clamp(r.value),
    upperPct: r.upper95 === null || r.upper95 === undefined ? null : clamp(r.upper95),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// DOM helpers (createElement and textContent only)

function chunkingEl(tag, opts, children) {
  const el = document.createElement(tag);
  const o = opts || {};
  if (o.cls) el.className = o.cls;
  if (o.text !== undefined && o.text !== null) el.textContent = String(o.text);
  if (o.attrs) {
    for (const [name, value] of Object.entries(o.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (o.on) for (const [type, fn] of Object.entries(o.on)) el.addEventListener(type, fn);
  if (children) for (const child of children) if (child) el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  return el;
}

function chunkingIcon(name, extra) {
  return chunkingEl('i', { cls: 'bi ' + name + (extra ? ' ' + extra : ''), attrs: { 'aria-hidden': 'true' } });
}

function chunkingSpinner() {
  return chunkingEl('span', { cls: 'loading loading-spinner loading-sm motion-reduce:hidden', attrs: { 'aria-hidden': 'true' } });
}

function chunkingAppendMessage(el, message) {
  for (const segment of message.segments) {
    if (segment.text !== undefined) el.appendChild(document.createTextNode(segment.text));
    else if (segment.code !== undefined) el.appendChild(chunkingEl('code', { cls: 'font-mono text-xs break-words', text: segment.code, attrs: { translate: 'no' } }));
    else if (segment.mono !== undefined) el.appendChild(chunkingEl('span', { cls: 'font-mono break-all', text: segment.mono, attrs: { translate: 'no' } }));
    else if (segment.time) el.appendChild(chunkingEl('time', { text: segment.time.text, attrs: { datetime: segment.time.iso } }));
  }
  return el;
}

function chunkingMessageEl(tag, cls, message) {
  return chunkingAppendMessage(chunkingEl(tag, { cls }), message);
}

/** An alert with a leading icon and a message; extra nodes go under the message. */
function chunkingAlert(tone, icon, message, opts) {
  const o = opts || {};
  const body = chunkingEl('div', { cls: 'flex flex-col gap-2 items-start min-w-0 max-w-prose' }, [chunkingMessageEl('p', 'text-sm', message)]);
  for (const node of o.extra || []) if (node) body.appendChild(node);
  return chunkingEl('div', { cls: 'alert alert-' + tone + ' items-start text-left', attrs: { role: o.role || null } }, [chunkingIcon(icon, 'mt-0.5'), body]);
}

function chunkingDash(srText) {
  return chunkingEl('span', null, [chunkingEl('span', { text: '—', attrs: { 'aria-hidden': 'true' } }), chunkingEl('span', { cls: 'sr-only', text: srText })]);
}

/** The rate cell (UI-SPEC section 6.9): point estimate, 95% upper bound, n, and a neutral mark. */
function chunkingRateCell(view, labels, emptyText) {
  if (view.empty) return chunkingEl('span', { cls: 'text-sm text-base-content/70', text: emptyText });
  const mark = chunkingEl('div', { cls: 'relative w-24 h-1 rounded-full bg-base-300 hidden md:block shrink-0', attrs: { 'aria-hidden': 'true' } });
  if (view.upperPct !== null) {
    const range = chunkingEl('div', { cls: 'absolute inset-y-0 left-0 rounded-full bg-base-content/30' });
    range.style.width = view.upperPct + '%';
    mark.appendChild(range);
  }
  const dot = chunkingEl('div', { cls: 'absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-base-content' });
  dot.style.left = 'calc((100% - 0.5rem) * ' + (view.pointPct / 100).toFixed(4) + ')';
  mark.appendChild(dot);
  const line1 = chunkingEl('div', { cls: 'flex items-center gap-2' }, [
    chunkingEl('span', { cls: 'text-sm tabular-nums' }, [chunkingEl('span', { cls: 'sr-only', text: labels.point + ' ' }), view.point]),
    mark,
  ]);
  const out = chunkingEl('div', { cls: 'flex flex-col gap-1' }, [line1]);
  if (view.upper !== null) out.appendChild(chunkingEl('div', { cls: 'text-xs text-base-content/70 tabular-nums', text: labels.upper(view.upper) }));
  out.appendChild(chunkingEl('div', { cls: 'text-xs text-base-content/70 tabular-nums', text: labels.n(view.n) }));
  return out;
}

function chunkingRowKey(docType, id) {
  return docType + ':' + id;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Panel

class ChunkingProfilesPanel {
  constructor(root, deps) {
    const d = deps || {};
    this.root = root;
    this.locale = chunkingLocale(d.locale || chunkingDetectLocale());
    this.fetcher = d.fetcher || ((apiPath, init) => window.ragFetch(apiPath, init));
    this.languagesFetcher = d.languagesFetcher || ((apiPath, init) => fetch(apiPath, init));
    this.appUrl = d.appUrl || null;
    this.mounted = false;
    this.tab = 'profiles';
    this.slice = 'overall';
    this.list = null;
    this.updatedAt = null;
    this.report = null;
    this.reportError = null;
    this.reportLoading = false;
    this.signedOut = false;
    this.form = null;
    this.build = null;
    this.sessionBuilt = new Set();
    this.rowNotes = new Map();
    this.typeAlerts = new Map();
    this.pendingFocus = null;
    this.hosts = {
      title: root.querySelector('[data-chunking-title]'),
      description: root.querySelector('[data-chunking-description]'),
      alert: root.querySelector('[data-chunking-alert]'),
      content: root.querySelector('[data-chunking-content]'),
      status: root.querySelector('[data-chunking-status]'),
    };
  }

  t(key, vars) {
    return chunkingLabel(key, this.locale, vars);
  }

  m(key, vars) {
    return chunkingMessage(key, this.locale, vars);
  }

  typeName(docType) {
    return chunkingDocTypeName(docType, this.locale);
  }

  profileName(id) {
    return id === 'legacy' || id === null || id === undefined ? this.t('legacy.name') : String(id);
  }

  async request(apiPath, init, timeoutMs) {
    const options = { ...(init || {}) };
    let timer = null;
    if (timeoutMs && typeof AbortController === 'function') {
      const controller = new AbortController();
      options.signal = controller.signal;
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    try {
      const result = await this.fetcher(apiPath, options);
      return result || { thrown: true };
    } catch {
      return { thrown: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async mount() {
    if (this.mounted) return this.refresh(false);
    this.mounted = true;
    this.root.setAttribute('lang', this.locale);
    if (this.hosts.title) this.hosts.title.textContent = this.t('panel.title');
    if (this.hosts.description) this.hosts.description.textContent = this.t('panel.description');
    if (this.hosts.status) this.hosts.status.setAttribute('tabindex', '-1');
    this.buildChrome();
    return this.refresh(true);
  }

  async refresh(announce) {
    await Promise.all([this.loadList(announce), this.loadReport(), this.loadLanguages()]);
  }

  async loadLanguages() {
    const before = chunkingLanguageCodes;
    const codes = await loadChunkingLanguages(this.languagesFetcher);
    if (codes && codes !== before && this.report && this.tab === 'report') this.renderReport();
  }

  async reload() {
    this.signedOut = false;
    if (this.hosts.content) this.hosts.content.hidden = false;
    this.clearAlert();
    await this.refresh(true);
  }

  // -- chrome ---------------------------------------------------------------------------------------------------------------------------

  buildChrome() {
    const content = this.hosts.content;
    if (!content) return;
    const tablist = chunkingEl('div', { cls: 'tabs tabs-bordered mb-4', attrs: { role: 'tablist', 'aria-label': this.t('panel.tabsLabel') } });
    const makeTab = (name, labelKey) =>
      chunkingEl('button', {
        cls: 'tab',
        text: this.t(labelKey),
        attrs: { type: 'button', role: 'tab', id: 'chunking-tab-' + name, 'aria-controls': 'chunking-tabpanel-' + name },
        on: { click: () => this.selectTab(name) },
      });
    this.tabButtons = { profiles: makeTab('profiles', 'tab.profiles'), report: makeTab('report', 'tab.report') };
    tablist.appendChild(this.tabButtons.profiles);
    tablist.appendChild(this.tabButtons.report);
    tablist.addEventListener('keydown', (event) => {
      const order = ['profiles', 'report'];
      const index = order.indexOf(this.tab);
      let next = null;
      if (event.key === 'ArrowRight') next = order[(index + 1) % order.length];
      else if (event.key === 'ArrowLeft') next = order[(index + order.length - 1) % order.length];
      else if (event.key === 'Home') next = order[0];
      else if (event.key === 'End') next = order[order.length - 1];
      if (next) {
        event.preventDefault();
        this.selectTab(next, true);
      }
    });

    const panelCls = 'rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
    this.profilesPanel = chunkingEl('div', {
      cls: panelCls,
      attrs: { role: 'tabpanel', id: 'chunking-tabpanel-profiles', 'aria-labelledby': 'chunking-tab-profiles', tabindex: '0' },
    });
    this.reportPanel = chunkingEl('div', {
      cls: panelCls,
      attrs: { role: 'tabpanel', id: 'chunking-tabpanel-report', 'aria-labelledby': 'chunking-tab-report', tabindex: '0' },
    });

    this.newButton = chunkingEl(
      'button',
      {
        cls: 'btn btn-outline btn-sm',
        attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'chunking-form' },
        on: { click: () => this.openForm() },
      },
      [chunkingIcon('bi-plus-lg'), this.t('action.new')],
    );
    this.updatedEl = chunkingEl('span', { cls: 'text-xs text-base-content/70' });
    this.refreshButton = chunkingEl(
      'button',
      {
        cls: 'btn btn-outline btn-sm',
        attrs: { type: 'button' },
        on: {
          click: () => {
            this.rowNotes.clear();
            this.typeAlerts.clear();
            this.refresh(true);
          },
        },
      },
      [chunkingIcon('bi-arrow-clockwise'), this.t('action.refresh')],
    );
    const toolbar = chunkingEl('div', { cls: 'flex flex-wrap items-center gap-2 mb-2' }, [
      this.newButton,
      chunkingEl('div', { cls: 'ml-auto flex flex-wrap items-center gap-2' }, [this.updatedEl, this.refreshButton]),
    ]);
    const help = chunkingMessageEl('p', 'text-xs text-base-content/70 max-w-prose mb-4', this.m('help.decision', { command: { code: CHUNKING_RECORD_COMMAND } }));
    this.decisionNotice = chunkingEl('p', { cls: 'text-xs text-base-content/70 max-w-prose mb-4', text: this.t('decision.unavailable') });
    this.decisionNotice.hidden = true;
    this.formHost = chunkingEl('div');
    this.blocksHost = chunkingEl('div');
    this.profilesPanel.appendChild(toolbar);
    this.profilesPanel.appendChild(help);
    this.profilesPanel.appendChild(this.decisionNotice);
    this.profilesPanel.appendChild(this.formHost);
    this.profilesPanel.appendChild(this.blocksHost);

    content.replaceChildren(tablist, this.profilesPanel, this.reportPanel);
    this.selectTab(this.tab);
  }

  selectTab(name, moveFocus) {
    this.tab = name === 'report' ? 'report' : 'profiles';
    if (!this.tabButtons) return;
    for (const [tabName, button] of Object.entries(this.tabButtons)) {
      const active = tabName === this.tab;
      button.classList.toggle('tab-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.setAttribute('tabindex', active ? '0' : '-1');
    }
    this.profilesPanel.hidden = this.tab !== 'profiles';
    this.reportPanel.hidden = this.tab !== 'report';
    if (moveFocus) this.tabButtons[this.tab].focus();
    if (this.tab === 'report') this.renderReport();
  }

  clearAlert() {
    if (this.hosts.alert) this.hosts.alert.replaceChildren();
  }

  reloadButton() {
    return chunkingEl('button', {
      cls: 'btn btn-sm',
      text: this.t('action.reload'),
      attrs: { type: 'button' },
      on: { click: () => this.reload() },
    });
  }

  showSignIn(mapped) {
    this.signedOut = true;
    if (this.form) this.closeForm(false);
    if (this.hosts.content) this.hosts.content.hidden = true;
    if (this.hosts.alert) this.hosts.alert.replaceChildren(chunkingAlert('warning', 'bi-person-lock', mapped, { extra: [this.reloadButton()] }));
    this.setStatus(mapped, true);
  }

  setStatus(message, isError) {
    const host = this.hosts.status;
    if (!host) return;
    host.replaceChildren();
    host.classList.toggle('text-error', Boolean(isError));
    if (isError) host.appendChild(chunkingIcon('bi-exclamation-circle', 'mr-1'));
    if (typeof message === 'string') host.appendChild(document.createTextNode(message));
    else chunkingAppendMessage(host, message);
  }

  focusStatus() {
    if (this.hosts.status) this.hosts.status.focus();
  }

  focusKey(focusKey) {
    if (!focusKey) return false;
    const match = Array.from(this.root.querySelectorAll('[data-chunking-focus]')).find((el) => el.getAttribute('data-chunking-focus') === focusKey);
    if (match && !match.disabled) {
      match.focus();
      return true;
    }
    return false;
  }

  // -- loading --------------------------------------------------------------------------------------------------------------------------

  setListBusy(busy) {
    if (!this.blocksHost) return;
    const hasContent = Boolean(this.list);
    this.blocksHost.classList.toggle('opacity-60', busy && hasContent);
    if (busy && hasContent) this.blocksHost.setAttribute('aria-busy', 'true');
    else this.blocksHost.removeAttribute('aria-busy');
    this.refreshButton.disabled = busy;
    this.refreshButton.replaceChildren(busy ? chunkingSpinner() : chunkingIcon('bi-arrow-clockwise'), this.t('action.refresh'));
    if (busy && !hasContent) {
      this.blocksHost.replaceChildren(
        chunkingEl('p', { cls: 'flex items-center gap-2 text-sm text-base-content/70 py-4' }, [chunkingSpinner(), this.t('list.loading')]),
      );
    }
  }

  async loadList(announce) {
    if (!this.list && announce) this.setStatus(this.t('list.loading'));
    this.setListBusy(true);
    const result = await this.request(CHUNKING_API, { method: 'GET' });
    this.setListBusy(false);
    if (!result.ok) {
      const mapped = mapChunkingError(result, 'list', this.locale, { appUrl: this.appUrl });
      if (mapped.signIn) {
        this.showSignIn(mapped);
        return false;
      }
      if (this.hosts.alert) this.hosts.alert.replaceChildren(chunkingAlert('error', 'bi-exclamation-octagon', mapped, { extra: [this.reloadButton()] }));
      if (this.list && this.blocksHost) this.blocksHost.classList.add('opacity-60');
      else if (this.blocksHost) this.blocksHost.replaceChildren();
      this.setStatus(mapped, true);
      return false;
    }
    this.clearAlert();
    this.list = result.body && typeof result.body === 'object' ? result.body : {};
    this.updatedAt = new Date();
    this.renderProfiles();
    if (announce) {
      const count = Array.isArray(this.list.profiles) ? this.list.profiles.length : 0;
      this.setStatus(this.m('list.loaded', { count: chunkingNumber(count, this.locale) }));
    }
    return true;
  }

  async loadReport() {
    this.reportLoading = true;
    if (this.tab === 'report') this.renderReport();
    const result = await this.request(CHUNKING_API + '/report', { method: 'GET' });
    this.reportLoading = false;
    if (!result.ok) {
      const mapped = mapChunkingError(result, 'report', this.locale, { appUrl: this.appUrl });
      if (mapped.signIn) {
        this.showSignIn(mapped);
        return;
      }
      this.report = null;
      this.reportError = mapped;
    } else {
      const body = result.body && typeof result.body === 'object' ? result.body : {};
      this.report = { report: body.report && typeof body.report === 'object' ? body.report : {}, decisions: chunkingDecisionRows(body.decisions) };
      this.reportError = null;
    }
    this.renderReport();
    if (this.list) this.renderProfiles();
  }

  // -- profiles view --------------------------------------------------------------------------------------------------------------------

  decisionFor(docType) {
    if (!this.report) return null;
    const row = this.report.decisions.find((d) => d.docType === docType);
    return row ? row.decision : null;
  }

  busyAttrs(button) {
    if (!this.build) return button;
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('title', this.t('build.busy'));
    return button;
  }

  renderProfiles() {
    if (!this.blocksHost || !this.list) return;
    this.updatedEl.replaceChildren();
    if (this.updatedAt) {
      const time = chunkingDate(this.updatedAt.toISOString(), this.locale, 'time');
      if (time) chunkingAppendMessage(this.updatedEl, this.m('list.updatedAt', { time: { time } }));
    }
    this.decisionNotice.hidden = !this.reportError;
    if (this.form) this.renderForm();

    const profiles = Array.isArray(this.list.profiles) ? this.list.profiles : [];
    if (profiles.length === 0) {
      this.blocksHost.replaceChildren(
        chunkingEl('div', { cls: 'py-8 flex flex-col items-center text-center gap-2' }, [
          chunkingEl('h4', { cls: 'text-base font-semibold', text: this.t('list.empty.title') }),
          chunkingEl('p', { cls: 'text-sm text-base-content/70 max-w-prose', text: this.t('list.empty.body') }),
          this.reloadButton(),
        ]),
      );
      return;
    }
    const wrap = chunkingEl('div', { cls: 'divide-y divide-base-300' });
    for (const group of profilesByDocType(this.list)) wrap.appendChild(this.renderBlock(group));
    this.blocksHost.replaceChildren(wrap);
    if (this.pendingFocus && this.focusKey(this.pendingFocus)) this.pendingFocus = null;
  }

  renderBlock(group) {
    const type = this.typeName(group.docType);
    const headingId = 'chunking-type-' + group.docType;
    const block = chunkingEl('div', { cls: 'py-4', attrs: { role: 'group', 'aria-labelledby': headingId } });

    const left = chunkingEl('div', { cls: 'flex flex-col gap-1 min-w-0' }, [chunkingEl('h4', { cls: 'text-base font-semibold text-balance', text: type, attrs: { id: headingId } })]);
    const activeLine = chunkingEl('p', { cls: 'text-sm' });
    const activeProfile = group.activeId === 'legacy' ? this.t('legacy.name') : { mono: group.activeId };
    chunkingAppendMessage(activeLine, this.m('group.active', { profile: activeProfile }));
    const since = group.activeRow && group.activeRow.activatedAt ? chunkingDate(group.activeRow.activatedAt, this.locale, 'date') : null;
    if (since) {
      activeLine.appendChild(document.createTextNode(this.locale === 'zh' ? '，' : ', '));
      chunkingAppendMessage(activeLine, this.m('group.since', { date: { time: since } }));
    }
    left.appendChild(activeLine);
    const decision = this.decisionFor(group.docType);
    if (this.report) {
      if (decision) {
        const date = chunkingDate(decision.recorded_at, this.locale, 'date');
        left.appendChild(
          chunkingMessageEl(
            'p',
            'text-xs text-base-content/70',
            this.m('decision.line', {
              profile: decision.profile_id === 'legacy' ? this.t('legacy.name') : { mono: decision.profile_id },
              gate: this.t(decision.gate_passed ? 'gate.passed' : 'gate.failed'),
              source: this.t(decision.source === 'live' ? 'source.live' : 'source.fixture'),
              date: date ? { time: date } : decision.recorded_at,
            }),
          ),
        );
      } else {
        left.appendChild(chunkingEl('p', { cls: 'text-xs text-base-content/70', text: this.t('decision.none') }));
      }
    }
    const header = chunkingEl('div', { cls: 'flex flex-wrap items-start justify-between gap-2' }, [left]);
    if (group.activeId !== 'legacy' && group.activeRow) {
      const rollback = chunkingEl(
        'button',
        {
          cls: 'btn btn-outline btn-sm',
          attrs: { type: 'button', 'aria-label': this.t('action.rollbackAria', { type }), 'data-chunking-focus': 'rollback:' + group.docType },
        },
        [chunkingIcon('bi-arrow-counterclockwise'), this.t('action.rollback')],
      );
      rollback.addEventListener('click', () => this.confirmChange('rollback', group, group.activeRow, rollback));
      header.appendChild(this.busyAttrs(rollback));
    }
    block.appendChild(header);

    const typeAlert = this.typeAlerts.get(group.docType);
    if (typeAlert) block.appendChild(chunkingEl('div', { cls: 'mt-4' }, [chunkingAlert('warning', 'bi-exclamation-triangle', typeAlert, { role: 'alert' })]));

    const coverage = coverageWarning(group, this.locale);
    if (coverage && coverage.showBuild) {
      const buildMissing = chunkingEl('button', {
        cls: 'btn btn-primary btn-sm',
        text: this.t('action.buildMissing'),
        attrs: { type: 'button', 'aria-label': this.t('action.buildMissingAria', { id: group.activeId }), 'data-chunking-focus': 'coverage:' + group.docType },
      });
      buildMissing.addEventListener('click', () => this.startBuild(group, group.activeRow));
      block.appendChild(chunkingEl('div', { cls: 'mt-4' }, [chunkingAlert('warning', 'bi-exclamation-triangle', coverage, { extra: [this.busyAttrs(buildMissing)] })]));
    } else if (coverage) {
      block.appendChild(chunkingMessageEl('p', 'text-xs text-base-content/70 mt-2', coverage));
    }

    if (group.onlyLegacy) {
      block.appendChild(chunkingEl('p', { cls: 'text-sm text-base-content/70 mt-2', text: this.t('group.onlyLegacy') }));
      return block;
    }
    block.appendChild(this.renderTable(group, type, decision));
    return block;
  }

  renderTable(group, type, decision) {
    const th = (key, cls) => chunkingEl('th', { cls: 'text-xs font-semibold ' + (cls || ''), text: this.t(key), attrs: { scope: 'col' } });
    const thead = chunkingEl('thead', null, [
      chunkingEl('tr', null, [
        th('col.profile'),
        th('col.sizes', 'hidden md:table-cell'),
        th('col.status'),
        th('col.documents', 'text-right'),
        chunkingEl('th', { attrs: { scope: 'col' } }, [chunkingEl('span', { cls: 'sr-only', text: this.t('col.actions') })]),
      ]),
    ]);
    const tbody = chunkingEl('tbody');
    for (const row of group.rows) {
      tbody.appendChild(this.renderRow(group, row, type, decision));
      const key = chunkingRowKey(group.docType, row.id);
      if (this.build && this.build.key === key) {
        tbody.appendChild(chunkingEl('tr', null, [chunkingEl('td', { attrs: { colspan: '5' } }, [this.build.els.region])]));
      }
      const note = this.rowNotes.get(key);
      if (note) tbody.appendChild(chunkingEl('tr', null, [chunkingEl('td', { attrs: { colspan: '5' } }, [note()])]));
    }
    const table = chunkingEl('table', { cls: 'table table-sm' }, [chunkingEl('caption', { cls: 'sr-only', text: this.t('table.caption', { type }) }), thead, tbody]);
    return chunkingEl('div', { cls: 'overflow-x-auto mt-4' }, [table]);
  }

  sizesText(row) {
    if (row.isLegacy) return { pair: this.t('legacy.sizes'), lines: [] };
    const pair = this.t('sizes.pair', {
      child: chunkingNumber(row.childTokens, this.locale),
      parent: row.parentTokens === null ? '—' : chunkingNumber(row.parentTokens, this.locale),
    });
    const lines = [];
    if (row.preset && row.preset !== 'custom') lines.push(this.t('preset.label', { name: row.preset }));
    if (row.parentMode === 'structure' || row.parentMode === 'fixed') lines.push(this.t(row.parentMode === 'fixed' ? 'mode.fixed' : 'mode.structure'));
    return { pair, lines };
  }

  statusBadge(status) {
    if (status === 'active') {
      return chunkingEl('span', { cls: 'badge badge-success badge-sm gap-1 h-auto whitespace-nowrap' }, [chunkingIcon('bi-check-circle-fill'), this.t('status.active')]);
    }
    const cls = status === 'building' ? 'badge badge-info badge-outline badge-sm' : status === 'retired' ? 'badge badge-ghost badge-sm' : 'badge badge-outline badge-sm';
    return chunkingEl('span', { cls: cls + ' h-auto whitespace-nowrap', text: this.t('status.' + status) });
  }

  renderRow(group, row, type, decision) {
    const key = chunkingRowKey(group.docType, row.id);
    const sizes = this.sizesText(row);
    const head = chunkingEl('th', { cls: 'font-normal align-top min-w-40', attrs: { scope: 'row' } });
    if (row.isLegacy) {
      head.appendChild(chunkingEl('div', { cls: 'text-sm', text: this.t('legacy.name') }));
      head.appendChild(chunkingEl('div', { cls: 'text-xs text-base-content/70 font-mono', text: 'legacy', attrs: { translate: 'no' } }));
    } else {
      head.appendChild(chunkingEl('div', { cls: 'font-mono text-sm break-all', text: row.id, attrs: { translate: 'no' } }));
    }
    if (decision && decision.profile_id === row.id) {
      head.appendChild(chunkingEl('span', { cls: 'badge badge-outline badge-sm mt-1 h-auto whitespace-nowrap', text: this.t('badge.decision') }));
    }
    head.appendChild(chunkingEl('div', { cls: 'text-xs text-base-content/70 md:hidden mt-1', text: sizes.pair }));

    const sizeCell = chunkingEl('td', { cls: 'hidden md:table-cell align-top' }, [chunkingEl('div', { cls: 'text-sm tabular-nums', text: sizes.pair })]);
    for (const line of sizes.lines) sizeCell.appendChild(chunkingEl('div', { cls: 'text-xs text-base-content/70', text: line }));

    const docs = chunkingEl('td', { cls: 'text-right tabular-nums align-top' });
    if (row.isLegacy) docs.appendChild(chunkingDash(this.t('docs.notApplicable')));
    else if (!row.completeness) docs.appendChild(chunkingEl('span', { cls: 'text-sm text-base-content/70', text: this.t('docs.notMeasured') }));
    else {
      docs.appendChild(
        chunkingEl('div', {
          cls: 'text-sm',
          text: this.t('docs.built', { built: chunkingNumber(row.completeness.built, this.locale), total: chunkingNumber(row.completeness.total, this.locale) }),
        }),
      );
      if (row.completeness.missing > 0) {
        docs.appendChild(
          chunkingEl('div', { cls: 'flex items-center justify-end gap-1 text-xs' }, [
            chunkingIcon('bi-exclamation-triangle-fill', 'text-warning'),
            this.t('docs.missing', { missing: chunkingNumber(row.completeness.missing, this.locale) }),
          ]),
        );
      }
    }

    const actionCell = chunkingEl('td', { cls: 'align-top text-right' });
    let action = row.action;
    if (action === 'build' && this.sessionBuilt.has(key)) action = 'continue';
    if (action) {
      const labelKey = { build: 'action.build', continue: 'action.continue', buildMissing: 'action.buildMissing', activate: 'action.activate' }[action];
      const ariaKey = { build: 'action.buildAria', continue: 'action.continueAria', buildMissing: 'action.buildMissingAria', activate: 'action.activateAria' }[action];
      const button = chunkingEl('button', {
        cls: 'btn btn-primary md:btn-sm',
        text: this.t(labelKey),
        attrs: { type: 'button', 'aria-label': this.t(ariaKey, { id: this.profileName(row.id), type }), 'data-chunking-focus': 'row:' + key },
      });
      button.addEventListener('click', () => {
        if (action === 'activate') this.confirmChange('activate', group, row, button);
        else this.startBuild(group, row);
      });
      actionCell.appendChild(this.busyAttrs(button));
    }

    return chunkingEl('tr', null, [head, sizeCell, chunkingEl('td', { cls: 'align-top' }, [this.statusBadge(row.status)]), docs, actionCell]);
  }

  // -- new profile form -----------------------------------------------------------------------------------------------------------------

  openForm() {
    if (this.form) {
      this.form.els.docType.focus();
      return;
    }
    const fields = { docType: 'general', preset: '256/1024', child: '256', parent: '1024', mode: 'structure', id: '', idEdited: false };
    fields.id = chunkingSuggestedId(fields.child, fields.parent, fields.docType);
    this.form = { fields, server: null, seq: 0, timer: null, busy: false, notice: null, fieldServer: null, els: null };
    this.form.els = this.buildFormElements();
    this.formHost.replaceChildren(this.form.els.region);
    this.newButton.setAttribute('aria-expanded', 'true');
    this.renderForm();
    this.form.els.docType.focus();
    this.scheduleServerCheck();
  }

  closeForm(returnFocus) {
    if (!this.form) return;
    if (this.form.timer) clearTimeout(this.form.timer);
    this.form = null;
    this.formHost.replaceChildren();
    this.newButton.setAttribute('aria-expanded', 'false');
    if (returnFocus) this.newButton.focus();
  }

  buildFormElements() {
    const els = {};
    const label = (forId, key) => chunkingEl('label', { cls: 'label', attrs: { for: forId } }, [chunkingEl('span', { cls: 'label-text', text: this.t(key) })]);
    const help = (id) => chunkingEl('span', { cls: 'label-text-alt text-base-content/70 mt-1', attrs: { id } });

    els.docType = chunkingEl('select', { cls: 'select select-bordered select-sm w-full', attrs: { id: 'chunking-form-doctype', name: 'chunking-doc-type' } });
    for (const docType of CHUNKING_DOC_TYPE_ORDER) els.docType.appendChild(chunkingEl('option', { text: this.typeName(docType), attrs: { value: docType } }));
    els.docType.addEventListener('change', () => this.formChanged('docType'));

    els.presets = [];
    const presetGroup = chunkingEl('div', { cls: 'flex flex-wrap gap-2' });
    for (const preset of ['128/512', '256/1024', '256/2048', 'custom']) {
      let text = preset === 'custom' ? this.t('preset.custom') : preset;
      if (preset === '256/1024') text = preset + ' (' + this.t('preset.default') + ')';
      const radio = chunkingEl('input', {
        cls: 'btn btn-sm',
        attrs: { type: 'radio', name: 'chunking-form-preset', value: preset, 'aria-label': text, id: 'chunking-form-preset-' + preset.replace('/', '-') },
      });
      radio.addEventListener('change', () => this.formChanged('preset', preset));
      els.presets.push(radio);
      presetGroup.appendChild(radio);
    }

    const numberInput = (id, field) => {
      const input = chunkingEl('input', { cls: 'input input-bordered input-sm w-full tabular-nums', attrs: { id, name: id, type: 'number', inputmode: 'numeric', min: '1', step: '1', autocomplete: 'off' } });
      input.addEventListener('input', () => this.formChanged(field));
      return input;
    };
    els.child = numberInput('chunking-form-child', 'child_tokens');
    els.parent = numberInput('chunking-form-parent', 'parent_tokens');
    els.childHelp = help('chunking-form-child-help');
    els.parentHelp = help('chunking-form-parent-help');

    els.modes = {};
    const modeGroup = chunkingEl('div', { cls: 'flex flex-col gap-2' });
    for (const mode of ['structure', 'fixed']) {
      const radio = chunkingEl('input', { cls: 'radio radio-sm', attrs: { type: 'radio', name: 'chunking-form-mode', value: mode, id: 'chunking-form-mode-' + mode } });
      radio.addEventListener('change', () => this.formChanged('mode', mode));
      els.modes[mode] = radio;
      modeGroup.appendChild(
        chunkingEl('label', { cls: 'flex items-center gap-2 cursor-pointer', attrs: { for: 'chunking-form-mode-' + mode } }, [
          radio,
          chunkingEl('span', { cls: 'label-text', text: this.t('form.mode.' + mode) }),
        ]),
      );
    }
    els.modeHelp = help('chunking-form-mode-help');

    els.id = chunkingEl('input', {
      cls: 'input input-bordered input-sm w-full font-mono',
      attrs: { id: 'chunking-form-id', name: 'chunking-profile-id', type: 'text', maxlength: '64', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', translate: 'no' },
    });
    els.id.addEventListener('input', () => this.formChanged('id'));
    els.idHelp = help('chunking-form-id-help');

    els.findings = chunkingEl('div', { cls: 'flex flex-col gap-1 mt-4', attrs: { id: 'chunking-form-findings', 'aria-live': 'polite' } });
    els.create = chunkingEl('button', {
      cls: 'btn btn-primary btn-sm',
      attrs: { type: 'button', 'aria-describedby': 'chunking-form-findings' },
      on: { click: () => this.createProfile() },
    });
    els.close = chunkingEl('button', { cls: 'btn btn-ghost btn-sm', text: this.t('action.closeForm'), attrs: { type: 'button' }, on: { click: () => this.closeForm(true) } });

    const grid = chunkingEl('div', { cls: 'grid grid-cols-1 md:grid-cols-2 gap-4' }, [
      chunkingEl('div', { cls: 'form-control' }, [label('chunking-form-doctype', 'form.docType'), els.docType]),
      chunkingEl('fieldset', { cls: 'form-control' }, [chunkingEl('legend', { cls: 'label label-text', text: this.t('form.preset') }), presetGroup]),
      chunkingEl('div', { cls: 'form-control' }, [label('chunking-form-child', 'form.child'), els.child, els.childHelp]),
      chunkingEl('div', { cls: 'form-control' }, [label('chunking-form-parent', 'form.parent'), els.parent, els.parentHelp]),
      chunkingEl('fieldset', { cls: 'form-control', attrs: { 'aria-describedby': 'chunking-form-mode-help' } }, [
        chunkingEl('legend', { cls: 'label label-text', text: this.t('form.mode') }),
        modeGroup,
        els.modeHelp,
      ]),
      chunkingEl('div', { cls: 'form-control' }, [label('chunking-form-id', 'form.id'), els.id, els.idHelp]),
    ]);
    els.region = chunkingEl(
      'div',
      {
        cls: 'bg-base-100 rounded-lg p-4 mb-4',
        attrs: { id: 'chunking-form', role: 'region', 'aria-labelledby': 'chunking-form-title' },
        on: {
          keydown: (event) => {
            const tag = event.target && event.target.tagName ? String(event.target.tagName).toLowerCase() : '';
            if (event.key === 'Escape' && this.form && !this.form.busy) {
              event.preventDefault();
              this.closeForm(true);
            } else if (event.key === 'Enter' && tag === 'input') {
              event.preventDefault();
            }
          },
        },
      },
      [
        chunkingEl('h4', { cls: 'text-base font-semibold mb-4', text: this.t('form.title'), attrs: { id: 'chunking-form-title' } }),
        grid,
        els.findings,
        chunkingEl('div', { cls: 'flex flex-wrap gap-2 mt-4' }, [els.create, els.close]),
      ],
    );
    return els;
  }

  readFormFields() {
    const f = this.form.fields;
    const els = this.form.els;
    if (els.docType.value) f.docType = els.docType.value;
    f.child = String(els.child.value);
    f.parent = String(els.parent.value);
    f.id = String(els.id.value);
  }

  formChanged(source, value) {
    if (!this.form || this.form.busy) return;
    const f = this.form.fields;
    this.readFormFields();
    if (source === 'preset' && value) f.preset = value;
    if (source === 'mode' && value) f.mode = value === 'fixed' ? 'fixed' : 'structure';
    if (source === 'preset' && f.preset !== 'custom') {
      const presetSizes = chunkingPresetFn();
      const sizes = presetSizes ? presetSizes(f.preset) : null;
      if (sizes) {
        f.child = String(sizes.child_tokens);
        f.parent = String(sizes.parent_tokens);
        f.mode = sizes.parent_mode;
      }
    }
    if (source === 'id') f.idEdited = f.id.trim() !== '';
    if (!f.idEdited) f.id = chunkingSuggestedId(f.child.trim(), f.parent.trim(), f.docType);
    const fieldServer = this.form.fieldServer;
    if (fieldServer && (fieldServer.field === source || source === 'preset' || source === 'docType')) this.form.fieldServer = null;
    this.form.notice = null;
    this.renderForm();
    this.scheduleServerCheck();
  }

  formFindings() {
    const local = chunkingFormFindings(this.form.fields);
    let errors = local.errors;
    let warnings = local.warnings;
    const server = this.form.server;
    if (local.body && server && server.state === 'done' && server.draftKey === JSON.stringify(local.body)) {
      errors = server.errors;
      warnings = server.warnings;
    }
    return { local, errors, warnings };
  }

  renderForm() {
    if (!this.form) return;
    const { fields } = this.form;
    const els = this.form.els;
    const locked = fields.preset !== 'custom';
    const busy = this.form.busy;
    els.docType.value = fields.docType;
    els.docType.disabled = busy;
    for (const radio of els.presets) {
      radio.checked = radio.value === fields.preset;
      radio.disabled = busy;
    }
    els.child.value = fields.child;
    els.parent.value = fields.parent;
    els.child.readOnly = locked;
    els.parent.readOnly = locked;
    els.child.disabled = busy;
    els.parent.disabled = busy;
    els.modes.structure.checked = fields.mode !== 'fixed';
    els.modes.fixed.checked = fields.mode === 'fixed';
    els.modes.structure.disabled = locked || busy;
    els.modes.fixed.disabled = locked || busy;
    els.id.disabled = busy;
    if (els.id.value !== fields.id) els.id.value = fields.id;

    const { local, errors, warnings } = this.formFindings();
    const serverField = this.form.fieldServer;
    const localKey = { child_tokens: 'child', parent_tokens: 'parent', id: 'id' };
    const setHelp = (el, input, field, normalKey) => {
      let error = null;
      if (serverField && serverField.field === field) error = serverField.message;
      else if (local.fieldErrors[localKey[field]]) error = this.m(local.fieldErrors[localKey[field]]);
      el.replaceChildren();
      el.classList.toggle('text-error', Boolean(error));
      el.classList.toggle('text-base-content/70', !error);
      chunkingAppendMessage(el, error || this.m(locked && field !== 'id' ? 'form.presetLocked' : normalKey));
      input.classList.toggle('input-error', Boolean(error));
      if (error) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    };
    setHelp(els.childHelp, els.child, 'child_tokens', 'form.childHelp');
    setHelp(els.parentHelp, els.parent, 'parent_tokens', 'form.parentHelp');
    setHelp(els.idHelp, els.id, 'id', 'form.idHelp');
    els.modeHelp.textContent = locked ? this.t('form.presetLocked') : '';
    els.modeHelp.hidden = !locked;

    const childIds = ['chunking-form-child-help'];
    const parentIds = ['chunking-form-parent-help'];
    els.findings.replaceChildren();
    const sizes = local.body || chunkingFormFindings({ ...fields, id: 'draft' }).body;
    const addLine = (code, tone) => {
      const id = 'chunking-finding-' + code;
      els.findings.appendChild(
        chunkingEl('p', { cls: 'flex items-start gap-1 text-sm ' + (tone === 'error' ? 'text-error' : ''), attrs: { id } }, [
          chunkingIcon(tone === 'error' ? 'bi-exclamation-circle' : 'bi-exclamation-triangle-fill text-warning', 'mt-0.5'),
          chunkingMessageEl('span', '', chunkingFindingMessage(code, this.locale, sizes)),
        ]),
      );
      (code === 'child_exceeds_embedding_input' ? childIds : parentIds).push(id);
      if (tone === 'error') {
        const input = code === 'child_exceeds_embedding_input' ? els.child : els.parent;
        input.setAttribute('aria-invalid', 'true');
        input.classList.add('input-error');
      }
    };
    for (const code of errors) addLine(code, 'error');
    for (const code of warnings) addLine(code, 'warning');
    els.child.setAttribute('aria-describedby', childIds.join(' '));
    els.parent.setAttribute('aria-describedby', parentIds.join(' '));
    els.id.setAttribute('aria-describedby', 'chunking-form-id-help');

    const server = this.form.server;
    if (server && server.state === 'checking') {
      els.findings.appendChild(chunkingEl('p', { cls: 'flex items-center gap-2 text-xs text-base-content/70' }, [chunkingSpinner(), this.t('form.checking')]));
    } else if (server && server.state === 'failed') {
      els.findings.appendChild(chunkingEl('p', { cls: 'text-xs text-base-content/70', text: this.t('form.serverUnchecked') }));
    }
    if (this.form.notice) {
      els.findings.appendChild(
        chunkingEl('p', { cls: 'flex items-start gap-1 text-sm text-error' }, [chunkingIcon('bi-exclamation-circle', 'mt-0.5'), chunkingMessageEl('span', '', this.form.notice)]),
      );
    }

    els.create.disabled = busy || Boolean(this.build) || local.blocking || errors.length > 0 || Boolean(serverField);
    if (this.build) {
      els.create.setAttribute('aria-disabled', 'true');
      els.create.setAttribute('title', this.t('build.busy'));
    } else {
      els.create.removeAttribute('aria-disabled');
      els.create.removeAttribute('title');
    }
    els.create.replaceChildren(...(busy ? [chunkingSpinner(), this.t('form.creating')] : [this.t('action.create')]));
    els.close.disabled = busy;
  }

  scheduleServerCheck() {
    if (!this.form) return;
    if (this.form.timer) clearTimeout(this.form.timer);
    const local = chunkingFormFindings(this.form.fields);
    if (local.blocking || !local.body) {
      this.form.server = null;
      return;
    }
    const body = local.body;
    this.form.timer = setTimeout(() => this.serverCheck(body), 400);
  }

  async serverCheck(body) {
    if (!this.form) return null;
    const form = this.form;
    form.seq += 1;
    const seq = form.seq;
    const draftKey = JSON.stringify(body);
    form.server = { draftKey, state: 'checking' };
    this.renderForm();
    const result = await this.request(CHUNKING_API + '/validate', { method: 'POST', body: JSON.stringify(body) });
    if (this.form !== form || seq !== form.seq) return null;
    if (result.ok) {
      const answer = result.body && typeof result.body === 'object' ? result.body : {};
      form.server = {
        draftKey,
        state: 'done',
        valid: answer.valid === true,
        errors: Array.isArray(answer.errors) ? answer.errors.map(String) : [],
        warnings: Array.isArray(answer.warnings) ? answer.warnings.map(String) : [],
      };
    } else {
      const mapped = mapChunkingError(result, 'validate', this.locale, { appUrl: this.appUrl, body });
      if (mapped.signIn) {
        this.showSignIn(mapped);
        return null;
      }
      if (mapped.findings) form.server = { draftKey, state: 'done', valid: false, errors: mapped.findings, warnings: [] };
      else if (mapped.field) {
        form.fieldServer = { field: mapped.field, message: mapped };
        form.server = null;
      } else form.server = { draftKey, state: 'failed' };
    }
    this.renderForm();
    return form.server;
  }

  async createProfile() {
    if (!this.form || this.form.busy || this.build) return;
    const form = this.form;
    if (form.timer) clearTimeout(form.timer);
    const local = chunkingFormFindings(form.fields);
    if (local.blocking || !local.body) return;
    const body = local.body;
    form.busy = true;
    form.notice = null;
    const checked = await this.serverCheck(body);
    if (this.form !== form) return;
    if ((checked && checked.state === 'done' && checked.valid === false) || form.fieldServer) {
      form.busy = false;
      this.renderForm();
      return;
    }
    const created = await this.request(CHUNKING_API, { method: 'POST', body: JSON.stringify(body) });
    if (this.form !== form) return;
    const type = this.typeName(body.doc_type);
    if (created.ok) {
      const answer = created.body && typeof created.body === 'object' ? created.body : {};
      const warnings = Array.isArray(answer.warnings) ? answer.warnings.map(String) : [];
      this.closeForm(false);
      this.pendingFocus = 'row:' + chunkingRowKey(body.doc_type, body.id);
      await this.loadList(false);
      const message = this.m('form.created', { id: body.id, type });
      for (const code of warnings) {
        const finding = chunkingFindingMessage(code, this.locale, body);
        message.segments.push({ text: ' ' }, ...finding.segments);
        message.text += ' ' + finding.text;
      }
      this.setStatus(message);
      if (this.pendingFocus && !this.focusKey(this.pendingFocus)) this.focusStatus();
      this.pendingFocus = null;
      return;
    }
    const mapped = mapChunkingError(created, 'create', this.locale, { appUrl: this.appUrl, body });
    form.busy = false;
    if (mapped.signIn) {
      this.showSignIn(mapped);
      return;
    }
    if (mapped.field) {
      form.fieldServer = { field: mapped.field, message: mapped };
      this.renderForm();
      const input = { id: form.els.id, child_tokens: form.els.child, parent_tokens: form.els.parent }[mapped.field];
      if (input) input.focus();
      return;
    }
    if (mapped.findings) {
      const answer = created.body && typeof created.body === 'object' ? created.body : {};
      form.server = {
        draftKey: JSON.stringify(body),
        state: 'done',
        valid: false,
        errors: mapped.findings,
        warnings: Array.isArray(answer.warnings) ? answer.warnings.map(String) : [],
      };
    } else {
      form.notice = mapped;
    }
    this.renderForm();
  }

  // -- build ----------------------------------------------------------------------------------------------------------------------------

  buildElements(profileId) {
    const bar = chunkingEl('progress', { cls: 'progress progress-primary w-full', attrs: { 'aria-label': this.t('build.barLabel', { id: profileId }) } });
    const count = chunkingEl('p', { cls: 'text-sm tabular-nums', text: this.t('build.starting') });
    const pause = chunkingEl('button', { cls: 'btn btn-outline btn-sm', text: this.t('action.pause'), attrs: { type: 'button' } });
    const gaps = chunkingEl('p', { cls: 'text-xs' });
    gaps.hidden = true;
    pause.addEventListener('click', () => {
      if (!this.build) return;
      this.build.pausing = true;
      pause.disabled = true;
      pause.textContent = this.t('build.pausing');
    });
    const region = chunkingEl('div', { cls: 'bg-base-100 rounded-lg p-4 flex flex-col gap-2', attrs: { role: 'group', 'aria-label': this.t('build.region', { id: profileId }) } }, [
      bar,
      chunkingEl('div', { cls: 'flex flex-wrap items-center justify-between gap-2' }, [count, pause]),
      chunkingEl('p', { cls: 'text-xs text-base-content/70 max-w-prose', text: this.t('build.note') }),
      gaps,
    ]);
    return { region, bar, count, pause, gaps };
  }

  updateBuild(answer) {
    const b = this.build;
    if (!b) return;
    b.done = answer.docsDone;
    b.total = answer.docsTotal;
    b.gaps = answer.gaps;
    const vars = { done: chunkingNumber(answer.docsDone, this.locale), total: chunkingNumber(answer.docsTotal, this.locale) };
    if (answer.docsTotal === 0) b.els.bar.remove();
    else {
      b.els.bar.setAttribute('max', String(answer.docsTotal));
      b.els.bar.setAttribute('value', String(Math.min(answer.docsDone, answer.docsTotal)));
    }
    b.els.count.textContent = this.t('build.progress', vars);
    b.els.gaps.hidden = !(answer.gaps > 0);
    b.els.gaps.textContent = answer.gaps > 0 ? this.t('build.gaps', { count: chunkingNumber(answer.gaps, this.locale) }) : '';
    const now = Date.now();
    if (now - b.lastAnnounce >= CHUNKING_ANNOUNCE_MS) {
      b.lastAnnounce = now;
      this.setStatus(this.t('build.progress', vars));
    }
  }

  gapLines(profileId, reasons) {
    const lines = [];
    for (const [reason, count] of Object.entries(reasons || {})) {
      const n = chunkingNumber(count, this.locale);
      let message;
      if (reason === 'no_parse_output') {
        message = this.m('gap.no_parse_output', { count: n, command: { code: 'npm run rag:rechunk -- --profile ' + profileId + ' --dry-run' } });
      } else if (reason === 'failed') message = this.m('gap.failed', { count: n });
      else message = this.m('gap.other', { count: n, code: { code: reason } });
      lines.push(chunkingMessageEl('p', 'text-sm', message));
    }
    return lines;
  }

  async startBuild(group, row) {
    if (this.build || !row || this.signedOut) return;
    const key = chunkingRowKey(group.docType, row.id);
    this.rowNotes.delete(key);
    this.typeAlerts.delete(group.docType);
    this.sessionBuilt.add(key);
    this.build = {
      key,
      profileId: row.id,
      docType: group.docType,
      wasActive: row.active,
      pausing: false,
      done: null,
      total: null,
      gaps: 0,
      lastAnnounce: Date.now(),
      els: this.buildElements(row.id),
    };
    this.renderProfiles();
    this.setStatus(this.t('build.starting'));
    const apiPath = CHUNKING_API + '/' + encodeURIComponent(row.id) + '/build';
    const outcome = await runChunkingBuild({
      post: () => this.request(apiPath, { method: 'POST', body: JSON.stringify({ doc_type: group.docType }) }, CHUNKING_BUILD_TIMEOUT_MS),
      shouldPause: () => Boolean(this.build && this.build.pausing),
      onStep: (answer) => this.updateBuild(answer),
    });
    await this.finishBuild(group, row, outcome);
  }

  async finishBuild(group, row, outcome) {
    const b = this.build;
    this.build = null;
    const type = this.typeName(group.docType);
    const last = outcome.last || { docsDone: b.done || 0, docsTotal: b.total || 0, gaps: b.gaps || 0, gapReasons: {} };
    const vars = {
      id: row.id,
      type,
      done: chunkingNumber(last.docsDone, this.locale),
      total: chunkingNumber(last.docsTotal, this.locale),
      count: chunkingNumber(last.gaps, this.locale),
    };
    let message;
    let note = null;
    let isError = false;
    if (outcome.outcome === 'completed') {
      message = last.docsTotal === 0 ? this.m('build.none', vars) : this.m(b.wasActive ? 'build.repaired' : 'build.completed', vars);
    } else if (outcome.outcome === 'incomplete') {
      message = this.m('build.incomplete', vars);
      const reasons = last.gapReasons;
      note = () => chunkingAlert('warning', 'bi-exclamation-triangle', message, { extra: this.gapLines(row.id, reasons) });
    } else if (outcome.outcome === 'failed') {
      message = this.m('build.failed', vars);
      isError = true;
      note = () => chunkingAlert('error', 'bi-x-octagon', message, { role: 'alert' });
    } else if (outcome.outcome === 'stalled') {
      message = this.m('build.stalled', vars);
      note = () => chunkingAlert('warning', 'bi-exclamation-triangle', message);
    } else if (outcome.outcome === 'paused') {
      message = this.m('build.paused', vars);
      note = () => chunkingMessageEl('p', 'text-sm', message);
    } else {
      const mapped = mapChunkingError(outcome.result, 'build', this.locale, { appUrl: this.appUrl, id: row.id, type, done: vars.done, total: vars.total });
      if (mapped.signIn) {
        this.renderProfiles();
        this.showSignIn(mapped);
        return;
      }
      message = mapped;
      if (mapped.paused) note = () => chunkingMessageEl('p', 'text-sm', mapped);
      else {
        if (mapped.key === 'error.generic' || mapped.key === 'error.profileGone') {
          const saved = this.m('build.saved');
          message = { key: mapped.key, segments: [...mapped.segments, { text: ' ' }, ...saved.segments], text: mapped.text + ' ' + saved.text };
        }
        isError = true;
        const shown = message;
        note = () => chunkingAlert('error', 'bi-x-octagon', shown, { role: 'alert' });
      }
    }
    if (note) this.rowNotes.set(b.key, note);
    await this.loadList(false);
    this.setStatus(message, isError);
    this.focusStatus();
  }

  // -- activate and roll back -----------------------------------------------------------------------------------------------------------

  confirmChange(kind, group, row, opener) {
    if (this.build || this.signedOut || !row) return;
    const type = this.typeName(group.docType);
    const current = this.profileName(group.activeId);
    let title;
    let body;
    if (kind === 'activate') {
      title = this.t('confirm.activate.title', { id: this.profileName(row.id), type });
      body = row.isLegacy
        ? this.t('confirm.activate.bodyLegacy', { type, current })
        : this.t('confirm.activate.body', { type, sizes: this.sizesText(row).pair, current });
    } else {
      title = this.t('confirm.rollback.title', { type });
      const previous = row.previousActiveId && row.previousActiveId !== 'legacy' ? row.previousActiveId : this.t('legacy.name');
      body = this.t('confirm.rollback.body', { type, previous, current });
    }
    const dialog = chunkingEl('dialog', { cls: 'modal', attrs: { 'aria-labelledby': 'chunking-dialog-title', 'aria-describedby': 'chunking-dialog-body' } });
    const keep = chunkingEl('button', { cls: 'btn', text: this.t('action.keep'), attrs: { type: 'button', autofocus: true } });
    const confirm = chunkingEl('button', { cls: 'btn btn-primary', text: this.t(kind === 'activate' ? 'action.activate' : 'action.rollback'), attrs: { type: 'button' } });
    const backdropButton = chunkingEl('button', { text: this.t('action.keep'), attrs: { type: 'submit', 'aria-label': this.t('action.keep'), tabindex: '-1' } });
    dialog.appendChild(
      chunkingEl('div', { cls: 'modal-box overscroll-contain' }, [
        chunkingEl('h4', { cls: 'text-base font-semibold break-words text-balance', text: title, attrs: { id: 'chunking-dialog-title' } }),
        chunkingEl('p', { cls: 'text-sm mt-2 break-words', text: body, attrs: { id: 'chunking-dialog-body' } }),
        chunkingEl('div', { cls: 'modal-action flex-wrap' }, [keep, confirm]),
      ]),
    );
    dialog.appendChild(chunkingEl('form', { cls: 'modal-backdrop', attrs: { method: 'dialog' } }, [backdropButton]));
    let running = false;
    dialog.addEventListener('cancel', (event) => {
      if (running) event.preventDefault();
    });
    keep.addEventListener('click', () => dialog.close('cancel'));
    confirm.addEventListener('click', async () => {
      if (running) return;
      running = true;
      keep.disabled = true;
      confirm.disabled = true;
      backdropButton.disabled = true;
      confirm.replaceChildren(chunkingSpinner(), this.t(kind === 'activate' ? 'confirm.activating' : 'confirm.rollingBack'));
      const apiPath = kind === 'activate' ? CHUNKING_API + '/' + encodeURIComponent(row.id) + '/activate' : CHUNKING_API + '/rollback';
      const result = await this.request(apiPath, { method: 'POST', body: JSON.stringify({ doc_type: group.docType }) });
      dialog.close('done');
      await this.finishChange(kind, group, row, result, opener);
    });
    dialog.addEventListener(
      'close',
      () => {
        dialog.remove();
        if (dialog.returnValue !== 'done' && opener && typeof opener.focus === 'function') opener.focus();
      },
      { once: true },
    );
    document.body.appendChild(dialog);
    dialog.showModal();
    keep.focus();
  }

  async finishChange(kind, group, row, result, opener) {
    const type = this.typeName(group.docType);
    const focusKey = opener && opener.getAttribute ? opener.getAttribute('data-chunking-focus') : null;
    this.typeAlerts.delete(group.docType);
    let message;
    let isError = false;
    if (result.ok) {
      const answer = result.body && typeof result.body === 'object' ? result.body : {};
      if (kind === 'activate') {
        message =
          answer.changed === false
            ? this.m('activate.already', { id: this.profileName(row.id), type })
            : this.m('activate.done', { id: this.profileName(answer.activated || row.id), type, previous: this.profileName(answer.previous) });
      } else {
        message = this.m('rollback.done', { type, restored: this.profileName(answer.restored), rolledBack: this.profileName(answer.rolled_back) });
      }
    } else {
      const mapped = mapChunkingError(result, kind, this.locale, { appUrl: this.appUrl, id: this.profileName(row.id), type });
      if (mapped.signIn) {
        this.showSignIn(mapped);
        return;
      }
      if (mapped.gate) this.typeAlerts.set(group.docType, mapped);
      else isError = true;
      message = mapped;
    }
    await this.loadList(false);
    this.setStatus(message, isError);
    if (!this.focusKey(focusKey)) this.focusStatus();
  }

  // -- report view ----------------------------------------------------------------------------------------------------------------------

  renderReport() {
    const host = this.reportPanel;
    if (!host) return;
    if (this.reportLoading && !this.report && !this.reportError) {
      host.replaceChildren(chunkingEl('p', { cls: 'flex items-center gap-2 text-sm text-base-content/70 py-4' }, [chunkingSpinner(), this.t('report.loading')]));
      return;
    }
    if (this.reportError) {
      host.replaceChildren(chunkingAlert('error', 'bi-exclamation-octagon', this.reportError, { extra: [this.reloadButton()] }));
      return;
    }
    if (!this.report) {
      host.replaceChildren();
      return;
    }
    const report = this.report.report;
    const nodes = [];
    if (report.provenance && report.provenance.source === 'fixture') nodes.push(chunkingAlert('info', 'bi-info-circle', this.m('report.fixture')));
    const profiles = Array.isArray(report.profiles) ? report.profiles : [];
    if (profiles.length === 0) {
      nodes.push(
        chunkingEl('div', { cls: 'py-8 flex flex-col items-center text-center gap-2' }, [
          chunkingEl('h4', { cls: 'text-base font-semibold', text: this.t('report.empty.title') }),
          chunkingMessageEl('p', 'text-sm text-base-content/70 max-w-prose', this.m('report.empty.body', { command: { code: CHUNKING_SWEEP_COMMAND } })),
        ]),
      );
    }
    nodes.push(this.renderDecisions());
    if (profiles.length > 0) {
      nodes.push(this.renderSliceSelect(report));
      this.comparisonHost = chunkingEl('div');
      this.renderComparison(report);
      nodes.push(this.comparisonHost);
      if (profiles.length === 1 && profiles[0].profile_id === 'legacy') {
        nodes.push(chunkingEl('p', { cls: 'text-sm text-base-content/70', text: this.t('report.baselineOnly') }));
      }
    }
    const notes = Array.isArray(report.notes) ? report.notes : [];
    if (notes.length > 0) {
      const list = chunkingEl('ul', { cls: 'list-disc pl-5 text-xs flex flex-col gap-1 max-w-prose', attrs: { lang: 'en' } });
      for (const note of notes) list.appendChild(chunkingEl('li', { text: String(note) }));
      nodes.push(chunkingEl('div', { cls: 'mt-2' }, [chunkingEl('h4', { cls: 'text-base font-semibold mb-2', text: this.t('report.notes') }), list]));
    }
    host.replaceChildren(chunkingEl('div', { cls: 'flex flex-col gap-6' }, nodes));
  }

  renderDecisions() {
    const th = (key) => chunkingEl('th', { cls: 'text-xs font-semibold', text: this.t(key), attrs: { scope: 'col' } });
    const tbody = chunkingEl('tbody');
    for (const row of this.report.decisions) {
      const cells = [chunkingEl('th', { cls: 'font-normal text-sm', text: this.typeName(row.docType), attrs: { scope: 'row' } })];
      const d = row.decision;
      if (!d) {
        cells.push(chunkingEl('td', { cls: 'text-sm text-base-content/70', text: this.t('decision.none'), attrs: { colspan: '4' } }));
      } else {
        cells.push(
          chunkingEl('td', null, [
            d.profile_id === 'legacy'
              ? chunkingEl('span', { cls: 'text-sm', text: this.t('legacy.name') })
              : chunkingEl('span', { cls: 'font-mono text-sm break-all', text: d.profile_id, attrs: { translate: 'no' } }),
          ]),
        );
        cells.push(
          chunkingEl('td', null, [
            chunkingEl('span', {
              cls: d.gate_passed ? 'badge badge-success badge-outline badge-sm' : 'badge badge-warning badge-sm',
              text: this.t(d.gate_passed ? 'gate.passed' : 'gate.failed'),
            }),
          ]),
        );
        cells.push(chunkingEl('td', { cls: 'text-sm', text: this.t(d.source === 'live' ? 'source.live' : 'source.fixture') }));
        const date = chunkingDate(d.recorded_at, this.locale, 'date');
        cells.push(
          chunkingEl('td', { cls: 'text-sm tabular-nums' }, [
            date ? chunkingEl('time', { text: date.text, attrs: { datetime: date.iso } }) : document.createTextNode(d.recorded_at),
          ]),
        );
      }
      tbody.appendChild(chunkingEl('tr', null, cells));
    }
    const table = chunkingEl('table', { cls: 'table table-sm' }, [
      chunkingEl('caption', { cls: 'sr-only', text: this.t('report.decisionsCaption') }),
      chunkingEl('thead', null, [
        chunkingEl('tr', null, [th('report.col.type'), th('report.col.chosen'), th('report.col.gate'), th('report.col.source'), th('report.col.recorded')]),
      ]),
      tbody,
    ]);
    return chunkingEl('div', null, [
      chunkingEl('h4', { cls: 'text-base font-semibold mb-2', text: this.t('report.decisions') }),
      chunkingEl('div', { cls: 'overflow-x-auto' }, [table]),
      chunkingMessageEl('p', 'text-xs text-base-content/70 max-w-prose mt-2', this.m('help.decision', { command: { code: CHUNKING_RECORD_COMMAND } })),
    ]);
  }

  /** A slice's display name, or { code } for a slice the panel does not know. */
  sliceDisplay(value) {
    if (!value || value === 'overall') return this.t('slice.overall');
    const [group, key] = String(value).split(':');
    if (group === 'doc_type' && CHUNKING_DOC_TYPE_ORDER.includes(key)) return this.typeName(key);
    if (group === 'language' && chunkingTemplate('lang.' + key, 'en') !== null) return this.t('lang.' + key);
    if (group === 'kind' && chunkingTemplate('kind.' + key, 'en') !== null) return this.t('kind.' + key);
    if (group === 'kind' && key) return key;
    return { code: String(value) };
  }

  sliceName(value) {
    const display = this.sliceDisplay(value);
    return typeof display === 'string' ? display : display.code;
  }

  renderSliceSelect(report) {
    const slices = chunkingReportSlices(report);
    if (!slices.some((s) => s.value === this.slice)) this.slice = 'overall';
    const select = chunkingEl('select', { cls: 'select select-bordered select-sm', attrs: { id: 'chunking-report-slice', name: 'chunking-report-slice' } });
    select.appendChild(chunkingEl('option', { text: this.t('slice.overall'), attrs: { value: 'overall' } }));
    const groups = { docType: 'slice.group.docType', language: 'slice.group.language', kind: 'slice.group.kind' };
    for (const [group, labelKey] of Object.entries(groups)) {
      const members = slices.filter((s) => s.group === group);
      if (members.length === 0) continue;
      const optgroup = chunkingEl('optgroup', { attrs: { label: this.t(labelKey) } });
      for (const slice of members) optgroup.appendChild(chunkingEl('option', { text: this.sliceName(slice.value), attrs: { value: slice.value } }));
      select.appendChild(optgroup);
    }
    select.value = this.slice;
    select.addEventListener('change', () => {
      this.slice = select.value || 'overall';
      this.renderComparison(this.report.report);
    });
    return chunkingEl('div', { cls: 'flex flex-wrap items-center gap-2' }, [
      chunkingEl('label', { cls: 'text-sm', text: this.t('report.compareOn'), attrs: { for: 'chunking-report-slice' } }),
      select,
    ]);
  }

  regressionText(regression) {
    const metricKey = CHUNKING_METRIC_LABELS[regression.metric];
    const sign = regression.diff > 0 ? '+' : '';
    return this.m('gate.regression', {
      metric: metricKey ? this.t(metricKey) : { code: regression.metric },
      slice: this.sliceDisplay(regression.slice),
      diff: sign + chunkingDecimal(regression.diff, this.locale, 3),
      band: chunkingDecimal(regression.band, this.locale, 3),
    });
  }

  renderComparison(report) {
    if (!this.comparisonHost) return;
    const rows = reportRows(report, this.slice);
    const docTypeSlice = this.slice.startsWith('doc_type:') ? this.slice.split(':')[1] : null;
    const decision = docTypeSlice ? this.decisionFor(docTypeSlice) : null;
    const registry = docTypeSlice && this.list ? profilesByDocType(this.list).find((g) => g.docType === docTypeSlice) : null;
    const rateLabels = { point: this.t('cell.point'), upper: (value) => this.t('cell.upper', { value }), n: (n) => this.t('cell.n', { n }) };
    const number = (value, digits) => (value === null ? chunkingDash(this.t('report.noData')) : document.createTextNode(chunkingDecimal(value, this.locale, digits)));
    const th = (key, cls, sub) =>
      chunkingEl('th', { cls: 'text-xs font-semibold align-bottom ' + (cls || ''), attrs: { scope: 'col' } }, [
        chunkingEl('div', { text: this.t(key) }),
        sub ? chunkingEl('div', { cls: 'font-normal text-base-content/70', text: this.t(sub) }) : null,
      ]);
    const tbody = chunkingEl('tbody');
    for (const row of rows) {
      const registeredId = docTypeSlice ? (row.isLegacy ? 'legacy' : row.profileId + '-' + docTypeSlice) : null;
      const registered = registry ? registry.rows.find((r) => r.id === registeredId) : null;
      const chosen = Boolean(decision && registeredId && decision.profile_id === registeredId);
      const head = chunkingEl('th', { cls: 'font-normal align-top min-w-32', attrs: { scope: 'row' } }, [
        row.isLegacy ? chunkingEl('div', { cls: 'text-sm', text: this.t('legacy.name') }) : chunkingEl('div', { cls: 'font-mono text-sm break-all', text: row.profileId, attrs: { translate: 'no' } }),
      ]);
      if (registered && !row.isLegacy) {
        head.appendChild(
          chunkingEl('div', {
            cls: 'text-xs text-base-content/70 break-all',
            text: this.t('report.registeredAs', { id: registered.id, status: this.t('status.' + registered.status) }),
          }),
        );
      }
      if (chosen) head.appendChild(chunkingEl('span', { cls: 'badge badge-outline badge-sm mt-1 h-auto whitespace-nowrap', text: this.t('badge.decision') }));

      const gateCell = chunkingEl('td', { cls: 'align-top' });
      if (row.gate.kind === 'baseline') gateCell.appendChild(chunkingEl('span', { cls: 'text-sm', text: this.t('gate.baseline') }));
      else if (row.gate.kind === 'passed') gateCell.appendChild(chunkingEl('span', { cls: 'badge badge-success badge-outline badge-sm', text: this.t('gate.passed') }));
      else {
        gateCell.appendChild(chunkingEl('span', { cls: 'badge badge-warning badge-sm', text: this.t('gate.failed') }));
        if (row.gate.regressions.length > 0) {
          const list = chunkingEl('ul', { cls: 'flex flex-col gap-1 mt-1 text-xs' });
          for (const regression of row.gate.regressions) list.appendChild(chunkingMessageEl('li', 'tabular-nums', this.regressionText(regression)));
          gateCell.appendChild(
            chunkingEl('details', { cls: 'mt-1' }, [
              chunkingEl('summary', {
                cls: 'text-xs cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
                text: this.t('gate.showRegressions', { count: chunkingNumber(row.gate.regressions.length, this.locale) }),
              }),
              list,
            ]),
          );
        }
      }

      const judge = chunkingEl('td', { cls: 'align-top text-right tabular-nums' });
      if (row.judge.skipped) judge.appendChild(chunkingEl('span', { cls: 'text-sm text-base-content/70', text: this.t('report.judgeSkipped') }));
      else if (row.judge.value === null) judge.appendChild(chunkingDash(this.t('report.noData')));
      else {
        judge.appendChild(chunkingEl('div', { cls: 'text-sm', text: chunkingPercent(row.judge.value, this.locale) }));
        judge.appendChild(chunkingEl('div', { cls: 'text-xs text-base-content/70', text: this.t('cell.n', { n: chunkingNumber(row.judge.n, this.locale) }) }));
      }
      const context = chunkingEl('td', { cls: 'align-top text-right tabular-nums text-sm' }, [
        row.contextTokens === null ? chunkingDash(this.t('report.noData')) : document.createTextNode(chunkingNumber(Math.round(row.contextTokens), this.locale)),
      ]);
      const latency = chunkingEl('td', { cls: 'align-top text-right tabular-nums text-sm' }, [
        row.latencyP50 === null && row.latencyP95 === null
          ? chunkingDash(this.t('report.noData'))
          : document.createTextNode(
              this.t('report.latency', {
                p50: row.latencyP50 === null ? '—' : chunkingNumber(Math.round(row.latencyP50), this.locale),
                p95: row.latencyP95 === null ? '—' : chunkingNumber(Math.round(row.latencyP95), this.locale),
              }),
            ),
      ]);
      tbody.appendChild(
        chunkingEl('tr', { cls: chosen ? 'bg-base-100' : '' }, [
          head,
          gateCell,
          chunkingEl('td', { cls: 'align-top text-right tabular-nums text-sm' }, [number(row.recall, 3)]),
          chunkingEl('td', { cls: 'align-top text-right tabular-nums text-sm' }, [number(row.mrr, 3)]),
          chunkingEl('td', { cls: 'align-top' }, [chunkingRateCell(chunkingRateView(row.falseRefusal, this.locale), rateLabels, this.t('cell.noItems'))]),
          chunkingEl('td', { cls: 'align-top' }, [chunkingRateCell(chunkingRateView(row.correctRefusal, this.locale), rateLabels, this.t('cell.noItems'))]),
          judge,
          context,
          latency,
        ]),
      );
    }
    const caption = this.t('report.caption', { slice: this.sliceName(this.slice) });
    const table = chunkingEl('table', { cls: 'table table-sm' }, [
      chunkingEl('caption', { cls: 'sr-only', text: caption }),
      chunkingEl('thead', null, [
        chunkingEl('tr', null, [
          th('report.col.profile'),
          th('report.col.gate'),
          th('report.col.recall', 'text-right'),
          th('report.col.mrr', 'text-right'),
          th('report.col.falseRefusal', '', 'report.rateSub'),
          th('report.col.correctRefusal', '', 'report.rateSub'),
          th('report.col.judge', 'text-right'),
          th('report.col.context', 'text-right'),
          th('report.col.latency', 'text-right'),
        ]),
      ]),
      tbody,
    ]);
    this.comparisonHost.replaceChildren(
      chunkingEl(
        'div',
        {
          cls: 'overflow-x-auto rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
          attrs: { tabindex: '0', role: 'region', 'aria-label': caption },
        },
        [table],
      ),
    );
  }
}

let CHUNKING_PANEL_INSTANCE = null;

function initChunkingProfilesPanel() {
  const root = document.getElementById('rag-administration-chunking');
  if (!root) return;
  if (!CHUNKING_PANEL_INSTANCE) {
    CHUNKING_PANEL_INSTANCE = new ChunkingProfilesPanel(root);
    window.chunkingProfilesPanel = CHUNKING_PANEL_INSTANCE;
  }
  CHUNKING_PANEL_INSTANCE.mount();
}

function bindChunkingProfilesPanel() {
  document.querySelectorAll('[data-tab="rag-administration"]').forEach((link) => {
    if (link.getAttribute('data-chunking-bound')) return;
    link.setAttribute('data-chunking-bound', '1');
    link.addEventListener('click', () => initChunkingProfilesPanel());
  });
}

if (typeof window !== 'undefined') {
  window.initChunkingProfilesPanel = initChunkingProfilesPanel;
  window.chunkingLabel = chunkingLabel;
  window.profilesByDocType = profilesByDocType;
  window.coverageWarning = coverageWarning;
  window.chunkingRefusalMessage = chunkingRefusalMessage;
  window.reportRows = reportRows;
  window.mapChunkingError = mapChunkingError;
  bindChunkingProfilesPanel();
  document.addEventListener('DOMContentLoaded', () => {
    bindChunkingProfilesPanel();
    const tab = document.getElementById('rag-administration');
    if (tab && tab.classList.contains('active')) initChunkingProfilesPanel();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CHUNKING_LABELS,
    CHUNKING_DOC_TYPE_ORDER,
    chunkingLabel,
    chunkingMessage,
    profilesByDocType,
    coverageWarning,
    refusalMessage: chunkingRefusalMessage,
    chunkingRefusalMessage,
    reportRows,
    chunkingReportSlices,
    chunkingLanguageCodesFrom,
    loadChunkingLanguages,
    resetChunkingLanguagesForTests,
    chunkingDecisionRows,
    chunkingFormFindings,
    chunkingSuggestedId,
    mapChunkingError,
    runChunkingBuild,
    chunkingRateView,
    ChunkingProfilesPanel,
    initChunkingProfilesPanel,
  };
}
