# myRAG orchestrator handoff (living file — updated at every check-in)

Branch `ops/orchestrator-briefs` (never merge into main). Current orchestrator: session_01SEn5g5F9BVw4WjuKoGXY7X (took over 2026-11-26 ~10:45Z from session_01SEn5g9gV3RHr18oaonxqof). If this session stops (quota), a successor reads, in order: this file, `standing-rules.md`, `cloud-sessions.md` (ledger — newest at the bottom), `tools/`, `research/`. Reply to the owner in Simplified Chinese, short and plain.

## How the pipeline works
- Repo github.com/EthanChenGuang/myRAG. `main` = production. Trunk `claude/ecstatic-hamilton-86gtwv` must equal main after every merge (`git push origin origin/main:refs/heads/claude/ecstatic-hamilton-86gtwv`).
- Executors: cloud sessions (create_session, model opus, tags `myrag-exec`,`phase-X`), one plan each, branch `exec/<plan>`. Prompt is one line pointing at `briefs/executor-brief.md` on THIS branch with {P} and {BASE}. Plans needing several unmerged deps get a combined base branch `base/<plan>` (merge --no-ff of the deps onto the latest ci/merge-train-N; never force-push).
- Find runnable plans: in a trunk worktree, `python3 <this branch>/handoff/tools/ready2.py <running plan ids>` (BLOCKED_PHASES is now empty — Phase 6.1 released 13:15Z). `missdeps.py`, `blockers.py`, `depth.py` explain blockers.
- Merge trains: subagent (opus) merges finished exec branches onto origin/main into `ci/merge-train-N`, pushes early, runs the FULL gate set, appends a section to `.planning/LIVE-MIGRATION-LOG-2026-11-25.md`. Orchestrator opens PR to main, merges at 16/16 green (expectedHeadSha), applies migrations live, syncs trunk, deploys (method below), then also applies the same migrations to the eval DB(s).
- Deploy: `git archive origin/main` into a temp dir; `npx --yes vercel@latest link --yes --project myrag --scope chenguangregis-gmailcoms-projects --token proxyinjected`; `rm -f .env.local`; `npx --yes vercel@latest deploy --prod --yes --token proxyinjected --scope chenguangregis-gmailcoms-projects`; check `"readyState": "READY"`.
- Supabase: production `ppvywaxrycaxrtrrditl` (multi-tenant) — migrations ONLY via the Supabase MCP connector (apply_migration), one combined migration per train. Eval DBs (myrag-medical `fsgaeysipkukqoocgzbx`, now in the owner's Pro org "ChenGuang's Org" of account ethan.chen.guang@gmail.com; later myrag-legal / myrag-finance in the same org) — owner-approved exception: operate via the Management API with the proxy-injected PAT (`POST https://api.supabase.com/v1/projects/<ref>/database/migrations` {name,query}; `/database/query`). The MCP connector can only be authorized for ONE org (old org, production).
- Rolling check-in via send_later every ~25 min; each check-in also pushes the ledger + this file here.

## State at last update (2026-11-26 13:20Z)
- main = cce43e1c (train 24, PR #107), deployed READY; prod migrations through train24 (0822, 0851-0854, 0410 r9, 0471). myrag-medical has the same.
- Train 25 (`ci/merge-train-25`, builder subagent running): 04.2-14(+34), 04.2-28, 04.2-39, 04.1.1-04, 04.1.1-05, 04.2-05..08, 03.2-66, fix/sidecar-preflight-flaky. Expected migrations 0858, 0472, 0473 (+ maybe 0410 delta). If the builder session is gone, rerun the gates yourself on that branch.
- Train 26 candidates (done, verified): 04.2-11, 04.2-12, 04.1.1-06, 04.1.1-16, 04.1.1-17, 04.2-31, 04.2-19, 04.1.1-09, 04.2-13 (0857), 04.2-10, 04.1.1-07, 04.2-09 (0855, 0856), 03.2-67.
- Running executors: see the newest ledger entries (03.2-68, 04.1.1-18, 04.1.1-10, 04.2-15..18, 04.1.1-08, 06-22, 06.1-01 (waits for owner package approval at Task 3), 06.1-03, 06.1-04, 05-26 task 1).
- Planning session for NEW Phase 3.3 (generic section rules / page boilerplate / doc attributes / quantity tokens; migrations 1001-1019): branch `plan/phase-03.3`. When done: PR to main, merge when green, then dispatch its plans.
- Progress: 787 plans (+ ~15-20 for 3.3), ~447 done, ~340 left, dependency depth 24.

## Owner decisions today (also in ledger)
- Medical + legal: Italian only. Finance + general docs: zh/it/en switchable. General docs = the existing production site. One codebase; one Vercel project + one Supabase project per domain; legal/finance projects go in the Pro org of ethan.chen.guang@gmail.com.
- Medical embeddings: evaluate arms in order (research/意大利语单语医疗RAG重新评估.md); online profile 1024-d halfvec; baseline ingest = repo as is (no cleaning; general@1 512/64; openai-3-small; Docling local; cloud parsing off); cleaning is its own arm later.
- Package-age rule: owner allows older versions that are ≥14 days old (or dropping the rule if newest is required). 06-22 uses @langchain/core 1.4.0, classic 1.0.61, openai 1.8.4, redisvl 0.32.0, redis 8.1.0, cutoff 2026-11-19.
- Anthropic key for live checks is env var MYRAG_ANTHROPIC_API_KEY (ANTHROPIC_API_KEY does not reach sessions); pass inline per process only.

## Eval artifacts NOT in git (domain-neutrality rule)
Corpus PDFs (re-download with handoff/eval-medical/dl.py + manifest.csv on this branch), the ~100-question dev set (exp1) and the ~460-question golden test set are built in the orchestrator scratchpad. Durable copies go to a private storage bucket `eval-artifacts` in myrag-medical (owner-approved eval DB) as soon as they exist — see ledger.
