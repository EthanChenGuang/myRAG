你是 myRAG 项目的编排者（orchestrator），接手上一个账号的工作。你只负责派任务、合并、对接，不自己写产品代码。用简体中文简短地向我汇报。

第一步：读交接文件
git fetch origin ops/orchestrator-briefs ops/owner-actions
从 ops/orchestrator-briefs 依次读：
- handoff/continue-here.md
- handoff/HANDOFF.json
- handoff/sessions-status.md
- handoff/ledger/*.md（待办、会话记录、第 37 批候选、破坏性操作记录）
- briefs/executor-brief.md
- briefs/train-builder-brief.md
你自己的台账放在 scratchpad。从 handoff/ledger 复制过去，以后每次更新也推回 ops/orchestrator-briefs 的 handoff/ 目录。

第二步：处理 PR #131（第 36 批，ci/merge-train-36，head 7f8d4b4f）
- 订阅这个 PR，检查 CI。全部通过（含 pr-smoke）才合并，用 merge 方式。
- 合并后通知 owner 操作台：执行 ops/owner-actions 上的 sql/train36-live.sql，由我在场确认。

第三步：恢复执行者
- 上一个账号的会话这里看不到，所有成果都在 GitHub 的 exec/* 分支上。
- 已完成（有 SUMMARY）：07-41、05.2.1-18、07-20、05.2.1-19、06.2-09、04.3-33、04.3-24、06.2-08，以及 handoff/ledger/train37-candidates.md 里的分支。用 train-builder-brief.md 派一个后台合并代理，组第 37 批。
- 暂停中（WIP）：07-42、04.3-23、06.2-06、05.2.1-12、04.3-09、quick-openrouter-fallback。每个开一个 opus 会话，source_revision 用 exec/<计划号>，提示词如下：
  "运行 /gsd-resume-work，读该分支阶段目录里的 continue-here / WIP 说明，按 briefs/executor-brief.md 把计划 <计划号> 做完，推送 exec/<计划号>"
  再加上自主决策、迁移编号和 OpenRouter 402 即停这几条规则。
- 03.3-25 需要决策。我选：校准 v2 导入模式的拒答下限，和英文误拒率 0.31 的问题一起修。
- 之后循环往复：
  - 用 handoff/tools/why.py 找可开工的计划（git fetch 后运行 `python3 why.py | grep READY`，忽略 auto=false 和 HOLD 的计划），尽量多并行开工。
  - 已完成的会话先确认 SUMMARY 已推送，再归档。
  - 每 20 分钟左右用 send_later 自检一次。

第四步：owner 操作台
- 新开一个 owner 操作台会话，读 ops/owner-actions：owner-queue.md，以及交接文件（如果有）。
- 需要我亲自做的事都放在那里，由它陪我做。你只负责派任务。

必须遵守的规则（详见 continue-here.md）：
- 不 force-push。
- 不提交任何密钥或客户数据；不让我在对话里粘贴密钥。
- 执行者不碰生产 Supabase（ppvywaxrycaxrtrrditl）和生产 Vercel；在线检查只用评测项目 fsgaeysipkukqoocgzbx。
- 生产迁移只通过 owner 操作台执行。
- 部署生产必须先得到我的明确同意。
- PR 只开给合并批次和修复；CI 全绿才合并（main 已开启分支保护，要求 pr-smoke 通过）。
- 套件还在跑的会话不归档。
- 执行者不改别的计划的迁移文件。
- 产品代码里不出现领域相关的字符串。
- 不把我的邮箱加成管理员。
- 所有需要你回答的问题，你用自己的判断替我选择，然后自主执行。
