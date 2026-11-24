# Executor ledger (one executor per plan)

**Rule (Guang):** At most one `gsd-executor` / plan executor subagent per plan id. Check this file before every `Task` spawn. Parallelism is across **different** plans only.

| Plan | Subagent (bcId) | Status | Branch | Notes |
|------|-----------------|--------|--------|-------|
| 03-43 | bc-2d2764a8-bcec-5b76-a320-0a63eb1db257 | **merged** | exec/03-43 | Canonical; merged to trunk |
| 03-44 | bc-645e437f-c0b8-5e86-a96d-f80cec58aab7 | **merged** | exec/03-44 | **Canonical** winner |
| 03-44 | bc-cdb95a3d-1ebc-5b58-a6a1-46d7c48b8221 | duplicate | exec/03-44 | Same SHAs; do not spawn |
| 03-44 | bc-9cd7df41-c92d-5032-a8a1-d1547071d01f | duplicate | exec/03-44 | Same SHAs; do not spawn |
| 03-45 | (orchestrator) | **merged** | trunk | No subagent |
| 03-46 | bc-88f166a9-cbf1-5906-851a-88b7b561593a | **stale** (no commits; orchestrator takeover) | exec/03-46 | Do not resume; orchestrator executes in wt/03-46 |
| 03-47 | — | pending | — | Spawn only after 03-46 merged + ledger row |

## DUPLICATE EXECUTION (2026-11-24)

**03-44:** Three executors ([bc-cdb95a3d](bc-cdb95a3d-1ebc-5b58-a6a1-46d7c48b8221), [bc-9cd7df41](bc-9cd7df41-c92d-5032-a8a1-d1547071d01f), [bc-645e437f](bc-645e437f-c0b8-5e86-a96d-f80cec58aab7)). Outcome: identical `exec/03-44` tip; trunk merge from bc-645e437f only.

## Spawn checklist

1. Read ledger — if plan row is `running`, `merged`, or `finished` (unmerged), do **not** spawn unless `dead` + logged retry.
2. Update row to `running` with bcId before `Task`.
3. On merge to trunk, set `merged` and clear `running`.