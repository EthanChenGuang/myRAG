# Prompt templates

Replace `<...>`. Keep prompts in the owner's language when the team works in it. Every prompt ends with the same rules block.

## Common rules block (append to every executor or planner prompt)

```
开始前先 `git fetch origin <ops-branch>` 并读 `git show origin/<ops-branch>:briefs/executor-brief.md`，照它执行（主干是 <trunk>；除本提示点名的分支外不要合并其他分支）。
所有决定按推荐方案自主做，不问用户。不碰生产环境，不 force-push，不提交密钥，不开 PR。
完成后用 send_message 把最终报告发给 <orchestrator-session-id>。
```

The block tells the session to read the executor brief and follow it, to merge nothing except the branches this prompt names, to make every decision itself by its recommended option, to stay off production, never force-push, never commit secrets and never open a PR, and to send its final report to the orchestrator session.

## Execute a plan

```
用 /gsd-execute-phase 执行计划 <plan>，只做这一个计划。
分支：从 origin/<base> 新建 exec/<plan>，用普通提交推送。
[可选] 先 `git merge --no-ff origin/<dep-branch>`：这是编排者授权的依赖合并，有冲突时两边都保留，并记进 SUMMARY。
完成标志：<plan>-SUMMARY.md 已提交并推送。
要点：<stop points / decisions already made for the owner / known traps>
门禁：计划里规定的门禁，再加 tsc、相关测试、项目的 check 脚本。
<common rules block>
```

## Execute up to a human checkpoint

Add: `碰到 checkpoint:human-action 或 human-verify 时停下，写 <plan>-CHECKPOINT.md（写清 owner 要运行的命令和需要的凭据名称，不写凭据值），推送，不写 SUMMARY。`

## Quick fix from a verification report

```
用 /gsd-quick 修复 Phase <P> 验证报告里的 <gap ids>，只做这几项。报告在 origin/verify/<P>（<sha>）。
分支：从 origin/<base> 新建 exec/quick-<slug>。完成标志：.planning/quick/ 下的 SUMMARY.md 已提交并推送。
- <gap>：<修什么>，先写会失败的测试。
不要做：<items owned elsewhere>
开关关闭时行为必须逐字节不变。
<common rules block>
```

## Phase verification (read-only)

```
对 Phase <P> 做阶段验证，只读审计，不改产品代码。分支：从 origin/<trunk> 新建 verify/<P>，用普通提交推送报告，不开 PR。
1. gsd-verifier → <P>-VERIFICATION.md（逐条核对成功标准和需求 ID；SUMMARY 不在 trunk 上的，去 exec/* 和 ci/* 找）。
2. /gsd-secure-phase <P> → <P>-SECURITY.md（只列出需要签字的项，不替 owner 签）。
3. gsd-integration-checker。
本地测试分片跑，在前台跑。
报告里写：结论、需求和成功标准的状态、安全结论、缺口清单（每条附修复建议）。
```

## Planner revision (planning model)

```
你是 GSD 规划者，只改 .planning/。分支：从 origin/<base> 新建 exec/plan-<slug>。
背景：<what stopped / what the verifier found>。
编排者已依据 owner 的长期授权做出设计决定：<decision>（不是签字，owner 可以推翻）。
要做：在 CONTEXT 里补决策记录；改写或新增 PLAN（depends_on / wave / must-haves / 任务 / 验证）；更新 PLAN-INDEX 和 ROADMAP；validate health 不能新增 error；verify plan-structure 要通过。
```

## Merge-train builder

```
组建 merge train <N>：从 origin/<prev-train or trunk> 新建 ci/merge-train-<N>。
逐个 `--no-ff` 合并这些分支：<list>，每个分支先确认有 SUMMARY。
冲突两边都保留；需要重录的固定基线，用对应工具重新录制；迁移编号冲突就改号（改文件名、文件头和测试）。
跑完整门禁。写 trainN-live.sql，按顺序列出迁移并附检查查询，推到 <owner-ops-branch>。
<prev> 合并之后再开 PR。
```

## Nudge an idle session

```
编排者提醒：你已经空闲 <n> 分钟，还在等后台测试。这里的后台任务大约 30 分钟就会悄悄退出、不报告。先看它还在不在跑；不在的话改成前台分片重跑，然后写 SUMMARY 并发最终报告。
```
