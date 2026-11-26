# Cloud executor sessions (2026-11-25 00:10Z, base trunk 21f611b6, model opus)
05-01   session_01SEn5g91ymhdNSicmNHKqbV  exec/05-01
05-03   session_01SEn5g7oZ8U61s1YyakRrFH  exec/05-03
05-04   session_01SEn5g6NwWcZdvd8UMDjPpU  exec/05-04
05.1-01 session_01SEn5g6rUELYyZGRhV6JbM8  exec/05.1-01
06-03   session_01SEn5g9KN3PGTYkShtFBhMn  exec/06-03
06-04   session_01SEn5g8cTfdeVK8tjBYHQ1L  exec/06-04
07-03   session_01SEn5g5PjNFdWmgDk9VbSbK  exec/07-03
Local: 03.1-45, 03.1-46, 03.1-47, 04-39(cont)
# Round 1 all COMPLETED + pushed (checked 01:13Z): 05-01 05-03 05-04 05.1-01 06-03 06-04 07-03
# Round 2 (01:14Z, base = dependency exec branch)
05-07   session_01SEn5g6okGRYcyibAufLXSH  base exec/05-01
05.1-05 session_01SEn5g6qYvDdC6fGgbtpHWm  base exec/05-01
06-06   session_01SEn5g74MbhceJTKCjmmEWm  base exec/06-03
06-07   session_01SEn5g6gg7aUD47xa7KWUwY  base exec/06-03
06-08   session_01SEn5g9P4JFZzBeMaYVaFmf  base exec/06-04
Local: 03.1-48, 04-34, 04-40 (resumed after container restart), typecheck:new fixer on fix-train
# Round 2 all COMPLETED + archived (02:01Z). 05.1-05 left its Task 2 (ROADMAP backlog entry 999.x) to the orchestrator.
# Round 3 (02:03Z)
05-12   session_01SEn5g7tnAfrEJsfdBZ9kdk  base exec/p5-base-1 (train2+05-07)
05.1-03 session_01SEn5g7LxjKD6VzJSy6o6t6  base exec/p5-base-1
06-12   session_01SEn5g8xywmbiJttNNBNMZC  base exec/06-08
# Round 3 COMPLETED + archived (03:20Z): 05-12, 05.1-03, 06-12 (06-12: migration 0603; re-run 0410 on upgraded projects)
# Round 4 (03:21Z)
05-02   session_01SEn5g9AgAPcbpGtR1TmQGJ  base exec/03.1-52
05-06   session_01SEn5g9BBAhxMdrUMsjwXME  base exec/03.1-52
07-02   session_01SEn5g9XmfPZ4NeaEE8J8JA  base exec/03.1-52
05-19   session_01SEn5g9Kr4cFTZ7o2DPfHBA  base exec/05-12
05.1-24 session_01SEn5g78TQnMZmogsikwnNy  base exec/05.1-03
Human checkpoints ready: 03.1-53, 04-43, 05-05
# Round 4 COMPLETED + archived (04:04Z): 05-02 (UI: check Design skills), 05-06 (0501/0502), 07-02 (0701-0703), 05-19, 05.1-24
# NOTE: 0501/0502/0701-0703 built on bases WITHOUT the 0425 search-path-empty test: verify in train 5.
# Round 5 (04:06Z)
05-08   session_01SEn5g6SGSrLSP2XTZddoPQ  base exec/05-02
05-09   session_01SEn5g7EMMthyserFxhdVfv  base exec/05-06
06-01   session_01SEn5g8aDV5HMbwUsUxdi5L  base exec/p6-base-1 (train4 + 05.1-24)
# Round 5 COMPLETED + archived (04:54Z): 05-08, 05-09 (check-config clears after 05-02), 06-01
# Round 6 (04:55Z)
05-14   session_01SEn5g7iazmBP9iJKkuaD8z  base exec/05-08
05.1-02 session_01SEn5g6cwsok91oVo3ts9du  base exec/05-08
06-05   session_01SEn5g58Xpa6ajDd9XecK9L  base exec/06-01
06-09   session_01SEn5g8EECZcinBd1jK4yNr  base exec/06-01
Pending: 05-13 (needs 05-08+05-09 -> base on ci/merge-train-5 once built)
Local: merge train 5 builder
05-13   (05:00Z) base ci/merge-train-5
# Round 6 COMPLETED + archived (05:37Z): 05-14, 05.1-02, 06-05, 06-09 (4 env rag-db fails = tiktoken/proxy)
06-11   (05:40Z) base exec/p6-base-2 (train5 + 06-05 + 06-09)
05-13   still running (base ci/merge-train-5)
Train 6 candidates: 05-13, 05-14, 05.1-02, 06-05, 06-09, 06-11
# 06:15Z: 05-13, 06-11 COMPLETED + archived. Train 5 merged (PR #27). Train 6 builder running locally.
05-15   session_01SEn5g9JzxgxntckQkHACgb  base exec/05-13
06-17   session_01SEn5g6QS4bWBekzSryjpmR  base exec/06-11
Pending: 05-18 (needs 05-13 + 05-14 -> base on ci/merge-train-6)
# 06:54Z: train 6 merged (PR #28). 05-15, 06-17 COMPLETED + archived. 05-18 running (base train6).
05-20   (06:55Z) base exec/05-15
Train 7 candidates: 05-15, 06-17, 05-18, 05-20
# 08:39Z: train 7 merged (PR #29). 05-21 done + archived. 05-10 pushed (local).
05-23     session_01SEn5g9tCjwZG7baHb6TFFC base exec/05-21
05.1-04   session_01SEn5g8YeieRdSrjGPUjpMx base exec/05-10
fix-whatsapp-link-preview session_01SEn5g59Wr7izZ8j1bPNcS7 (trunk)
fix-config-ui-bugs        session_01SEn5g8A5uf7osryvVwHvcL (trunk)
fix-ingest-batch-2        session_01SEn5g8qxXCfvgYvfMU536B (trunk; migration ~0426)
Local: live Supabase migration agent (project ppvywaxrycaxrtrrditl)
Train 8 candidates: 05-10, 05-21, 05-23, 05.1-04, 3 fix branches
# 09:22Z: round 8 (05-23, 05.1-04, 3 fixes) COMPLETED + archived. Train 8 building locally.
05.1-07 session_01SEn5g6gE5WUQtHUn5MJiyB base exec/05.1-04
05.1-08 session_01SEn5g6JPRNuCSVKpNv4M7P base exec/05.1-04
05.1-12 session_01SEn5g7wY7VoZtSoQ2GvJFJ base exec/05.1-04
Pending: 05.1-11 (needs 05-23 + 05.1-04 -> base ci/merge-train-8)
Live DB: stopped before 0425 (26 drifted legacy functions); diff agent running. 0426 to apply after 0425.
# 09:37Z (user: 加快)
05.1-11 session_01SEn5g9oB8CGmkPsvCJsN8A base exec/p51-base-1 (05-23 + 05.1-04)
06-02   session_01SEn5g8BpqZHMukoLJBm8ho base exec/05.1-12
Local: live-migration continuation agent (patch -> 0425 -> batches -> 0410 r2), train 8 builder, Phase 3.1 verifier
# 10:10Z: round 9 (05.1-07/08/12/11, 06-02) COMPLETED + archived. Train 8 merged (PR #30, 0ccfc2ac). 0426 applied live. Local: fix-31-gaps fixer.
05-05   session_01SEn5g67Ak7eHhNLCFg32qe base trunk (precondition 03.1-54/04-43 waived: those plans modify no files)
Local: train 9 builder (05.1-07, 05.1-08, 05.1-12, 05.1-11, 06-02), fix-31-gaps fixer
# 10:57Z: train 9 merged (PR #34, 63a6bcb2). 05-05 COMPLETED (deps audited: matches approval) + archived.
05-11   session_01SEn5g65jREWUxZ8yiBeELB base exec/05-05
05-17   session_01SEn5g89pXoKoiEY9pGcTFB base exec/05-05
Local: fix-31-gaps fixer. Train 10 candidates: 05-05, fix-31-gaps, 05-11, 05-17
# 11:10Z: main synced with trunk at 460cedef (EMB-05 clash: main's BGE-M3 -> EMB-11). Rule from now: after each train merge, also fast-forward main to trunk.
Local: train 10 builder (05-05 + fix-31-gaps; 0427 live after merge). Train 11: 05-11, 05-17 when done.
# 11:50Z: train 10 merged (PR #36); trunk=main 70e213f6; 0427 applied live. 05-11, 05-17 COMPLETED + archived.
05-16   session_01SEn5g8Wk8egtndbxMuRMhW base exec/05-11
05.1-18 BLOCKED on user: Llama Prompt Guard 2 license + HF gated access (asked 11:50Z)
Train 11 candidates: 05-11, 05-17, 05-16
# 12:10Z: main ff to trunk 119403ac (planning PRs #37-#40). HOLD from planning session: no executors for 03.1.1, 04.1, 04.1.1, 05.1.1, 06.1 (+ unplanned 3.2/4.2/5.2/6.2); ready2.py filters them. Train 11 builder running (05-11, 05-17). 05.1-18 question to user still open.
# 12:15Z: user confirmed the hold + query.ts terminology slot + ask before REQUIREMENTS/ROADMAP edits (see standing-rules.md). 05.1-18/25 recorded SKIPPED (user: 先跳过), trunk=main 5e9f39f1.
# 12:45Z: train 11 merged (PR #42). trunk=main 20b496ba (incl. planning PR #44: new Phase 4.3, added to hold list).
# 13:13Z: 05-16 COMPLETED + archived (clean).
05-22   session_01SEn5g65kezvzBeFSHXaYoH base exec/05-16
05.1-06 session_01SEn5g5ApUiSGcsxutQZupe base exec/05-16
Train 12 candidates: 05-16, 05-22, 05.1-06
# 13:20Z: NEW merge policy: train PRs into main, auto-merge via GitHub when 8 checks green, then sync trunk.
# 13:21Z: planning PR #45 merged to trunk: new Phase 5.3 (held). Phase 7 depends on 5.3 in ROADMAP.
# 13:50Z: sidecar host = option A (defer 03.1-53/54 to pre-production). HF Docker Spaces need PRO. Draft on exec/sidecar-hf-deploy.
# 14:02Z: 05-22, 05.1-06 COMPLETED + archived (clean). Train 12 builder (05-16, 05-22, 05.1-06; PR base main).
05-24   session_01SEn5g5P2SdPHCqpvfNsSxa base exec/05-22
05.1-09 session_01SEn5g5YG57Zcr8AJmQAcWt base exec/05.1-06
05.1-13 session_01SEn5g6oGEnje9A5iLeATh4 base exec/05.1-06
05.1-15 session_01SEn5g7NktNYWm5FCF4viL4 base exec/05.1-06
Pending: 05.1-16 (needs 05-22 + 05.1-06) -> start on ci/merge-train-12 once pushed. Rate limit: seven_day allowed_warning.
# 14:24Z: train 12 PR #49 (base main) open, waiting CI. check-workflows OK (ran locally).
05.1-16 session_01SEn5g7LLHTPPRhwFP1NPko base ci/merge-train-12
# 14:30Z: planning PRs #48, #50 merged to trunk; Phase 6.3 held.
# 14:50Z: round 13 (05-24, 05.1-09, 05.1-13, 05.1-15, 05.1-16) COMPLETED + archived. Train 12 merged to main (PR #49).
Found: 05.1-09 built without 05.1-07/08 (branch base gap). ready2.py now flags NEEDS-TRUNK-MERGE; brief requires transitive-dep check.
Train 13 builder running (05-24, 05.1-09, 05.1-13, 05.1-15, 05.1-16).
05.1-10 session_01SEn5g9KdRCVE8TEoaCvyBd base exec/05-24
Waiting for ci/merge-train-13: 05-25, 05.1-14, 05.1-17, 05.1-20
# 15:04Z: ci/merge-train-13 pushed early (c324af15), all deps verified in it.
05-25   session_01SEn5g68Zq3AGPeRAG1MUgN base ci/merge-train-13
05.1-14 session_01SEn5g63AP279eiYqseg69G base ci/merge-train-13
05.1-17 session_01SEn5g7J65z8jecG5TTWyeZ base ci/merge-train-13
05.1-20 session_01SEn5g6MUDKVQhcUyv14PMW base ci/merge-train-13
Running now: 05.1-10 + the 4 above + train 13 builder (+ planning session).
# 15:07Z: Phase 3.2 RELEASED by planning session (PR #54). 3.2.1 still held.
03.2-01 session_01SEn5g7cswepvT2Pxuxzj59 base trunk
03.2-03 session_01SEn5g8xHmfHuSqUvRHcMDi base trunk
03.2-04 session_01SEn5g9FXrYcK6XEWvWxxRG base trunk
03.2-26 session_01SEn5g8PYYAM8w5ccRvCGUP base trunk
Running (9): 05.1-10, 05-25, 05.1-14, 05.1-17, 05.1-20, 03.2-01, 03.2-03, 03.2-04, 03.2-26. Train 13 PR #53 waiting CI.
3.2 human checkpoints: 36 (packages python-docx/lxml/defusedxml), 53 (live + native-speaker review), 65 (push 0801-0810 live).
# 15:18Z: Phase 3.1.1 RELEASED (PR #55). ready2 regex fixed (two-dot phases).
03.1.1-01 session_01SEn5g8Vmqm5zr4shP1M2vZ base trunk
03.1.1-02 session_01SEn5g7kxrpWSfHcwLEEbo7 base trunk
03.1.1-03 session_01SEn5g9E5JCBne1CHvUU6Kr base trunk
03.1.1-04 session_01SEn5g6LszJozcjNoMmKEH7 base trunk
03.1.1-11 session_01SEn5g5T5H9HcMZxcvcFZ2u base trunk
Running (14): 05.1-10, 05-25, 05.1-14, 05.1-17, 05.1-20, 03.2-01/03/04/26, 03.1.1-01/02/03/04/11. PR #53 waiting CI.
# 16:05Z: all 14 of round 15 COMPLETED + archived. Train 14 builder running (14 branches). Vercel deploy question pending to user (session restart interrupted the question).
# 16:25Z: Vercel token saved (api.vercel.com). Deploy agent: new project 'chatbot' (owner asked 'ChatBot'), copy envs from myrag, deploy main --prod. Old myrag untouched.
Round 16 sessions (base ci/merge-train-14): 03.1.1-05 session_01SEn5g8u1aoMzsyDHzAX1fi, 03.1.1-16 session_01SEn5g9W9CFBcjcpT4rUBDc, 03.2-02 session_01SEn5g7p4tkR6omTowcTv9Q, 03.2-07 session_01SEn5g5s2C7Dr98MZ97Vprz, 03.2-12 session_01SEn5g87rTsSyxtF569SFEN, 03.2-13 session_01SEn5g98PjYcAqkFTsYt1d3, 05.1-19 session_01SEn5g97MjGDNZKdTCX2J54, 05.1-21 session_01SEn5g6rM3Tv4LreKGP5nSK

## 2026-11-25 ~17:00 — Phases 4.1 and 4.1.1 released by the planning session (PRs #62, #64, #65); 05.1.1-24 released
- HOLD: 04.1-09 (waits for Phase 3.2 to complete) and 04.1-13 (waits for LANG-01 on trunk)
- 04.1-01 session_01SEn5g6VmneEm1a29ejWpWm (base: trunk 49e9ccc4)
- 04.1-02 session_01SEn5g8dgqaqFarf8JQgrJC
- 04.1-06 session_01SEn5g9g8iCZhFWw396r5Cp
- Fix PR #63 (tiktoken externalized + next-build CI job → 9 checks) is in CI
## 2026-11-25 17:36 — train 15 = PR #74 (head c6f11d67); dependent executors started
- 03.1.1-06 session_01SEn5g6aRKhqkmv57sQgiZQ (base ci/merge-train-15)
- 03.1.1-07 session_01SEn5g5W1Q2QYpcV7NWTwHf
- 03.2-05 session_01SEn5g7MtJ5dtGfRMs5Qi1s
- 03.2-08 session_01SEn5g8pnaraJNAy5o2q9SE
- 03.2-09 session_01SEn5g7DLr5jf48LuUqLUEH
- 03.2-10 session_01SEn5g7nVdcGGhtiSpWPVxa
- 03.2-44 session_01SEn5g8uhWGvRpjtSzAAEYx
- 03.2-48 session_01SEn5g5yFVUdk2HGouPEZ1Y
- 05.1-22 session_01SEn5g72dft3j7phnHASMLy
- 06-10 session_01SEn5g8hU3Z5xnq7BueUKWv
- 04.1-03 session_01SEn5g6Dit2y3T885Gb6zfk (base exec/04.1-01)
- running earlier: 04.1-01/02/06

## Batch on ci/merge-train-16 (2026-11-25 ~18:45)
03.1.1-08 session_01SEn5g97qVvrNMVBemorqFy
03.1.1-09 session_01SEn5g7P7xZep5mYk7q76XJ
03.1.1-13 session_01SEn5g9hmgDTSHtWxGc6aBT
03.2-06 session_01SEn5g67oSLmBiR26HpQswG
03.2-11 session_01SEn5g6j2G4SA5ynp7jZrRU
03.2-14 session_01SEn5g9j1bUXy9CesyiwUTj
03.2-20 session_01SEn5g7UuiwgaK8yz1h4Cyr
03.2-22 session_01SEn5g7XkNkZ7nT2tz4Drem
03.2-33 session_01SEn5g5AQB9BBHiCbXkTX46
03.2-35 session_01SEn5g64bTLyzwUpNyczZP8
04.1-04 session_01SEn5g63zViFS573z8ioAeS
04.1-05 session_01SEn5g8F15W88Vq5Dtkrmf1
04.1-08 session_01SEn5g7pXvYbJeCESadWcdD
05.1.1-01 session_01SEn5g8UatmJfnL6jprK8kL
05.1.1-02 session_01SEn5g5Sa2D9oocNkWCM55r
05.1.1-03 session_01SEn5g8a4ZA5bEsJfTQvkbC
06-13 session_01SEn5g5Ru5segt4hhwy9iWc
06-14 session_01SEn5g88bsJUH36NDvD6tXH
06-15 session_01SEn5g9BcE4FxVeyBts85W1
06-16 session_01SEn5g9BDQjh2viSYHVu7Rr
06-18 session_01SEn5g8fwmUSHysNpGvvApB
06-21 session_01SEn5g8wnmdDciZL2SMoTPH
(train-16 members done: 04.1-01/02/03/06, 03.1.1-06/07, 03.2-05/08/09/10/44/48, 05.1-22, 06-10 — archive after PR #88 merges)

## Batch on ci/merge-train-17 (2026-11-25 ~20:10)
03.1.1-10 session_01SEn5g8tByW5JeQsw4BL6EY
03.2-15 session_01SEn5g5g4PA12R57xMVCpZh
03.2-16 session_01SEn5g9HYAGYHyfFe1hFk8d
03.2-17 session_01SEn5g8nQxGMRBkrxuvXFRV
03.2-21 session_01SEn5g7njXGHcVUWWEaqGZh
03.2-23 session_01SEn5g6n5oRBFjEhEEi6tMY
03.2-30 session_01SEn5g8VRzdU2ENJZYQeZSi
03.2-31 session_01SEn5g5dRPHAP1EduHrJ2Ls
03.2-34 session_01SEn5g8y8dQns1oSdZP6Nd2
04.1-07 session_01SEn5g7tM7fbP1krhgpS17w
05.1.1-04 session_01SEn5g5YkqjHcPLh8p78hXU
05.1.1-05 session_01SEn5g9uVPPo7jEAxk9N4mU
05.1.1-06 session_01SEn5g95YbSWoR6mZBFDNSz
06-19 session_01SEn5g7HUdH4tKTh3MLafn4
06-20 session_01SEn5g81DrNnvGWS9t9p7CH
(train-16 batch of 22 archived 2026-11-25 ~20:00)
- archived 2026-11-25 ~21:00: 13 of train-17 batch (all except 03.2-15, 03.2-34)
plan-04.1-gaps session_01SEn5g8EMdjRjucm4PH8pUx (planning)
- archived 03.2-15, 03.2-34 (~21:12). exec/03.2-34 has SUMMARY + 0804 pushed (unpushed flag = local scratch). Train-18 live migrations include 0804 (closes rag_release_quarantine gap) and 0814 (03.2-16).

## Batch on ci/merge-train-18 (2026-11-25 ~21:45)
03.1.1-12 session_01SEn5g7JqEizpmdvqCaT6bN
03.2-18 session_01SEn5g8rUHDyyemNzWyCjAN
03.2-24 session_01SEn5g85bHZN4kRE6PmsEYv
03.2-25 session_01SEn5g5V6pnsSTbYwfvesJk
03.2-27 session_01SEn5g5Qgv8taxxRVLzkhY1
03.2-29 session_01SEn5g5qNicAeXQguuMK5eK
03.2-37 session_01SEn5g6wJBnokAxq2ugyHAn
03.2-41 session_01SEn5g97kYV7gBenm7UsT59
03.2-46 session_01SEn5g6K3cheyH7WRoT49j5
03.2-52 session_01SEn5g8ZEx614XwxQZafz5Q
04.1-14 session_01SEn5g8qvo8CZFtqSGTV5XN
04.1-16 session_01SEn5g7rzkoBJCHLPzr5UqD
05.1.1-07 session_01SEn5g5KfnGzyZAn8KgwCHA
05.1.1-08 session_01SEn5g6T4okx2MBEBpXGi5Q
05.1.1-12 session_01SEn5g9hKPpX5y1xEEvaoaP
05.1.1-25 session_01SEn5g5Dop5cJkErGGvZXoa
06-23 session_01SEn5g8ktvwxfsYEratjrtn
06-24 session_01SEn5g5dX5nEyip9GnsNCPt
06-25 session_01SEn5g9YMtGErVVKcebxqK2
06-26 session_01SEn5g99E6sz8qZjRkHACvq
06-27 session_01SEn5g759iufamubB5wRqBk
06-28 session_01SEn5g8uzrkbwh4Gcv5qeBr
06-29 session_01SEn5g5ox8zniXJskZSGXFd
- archived ~22:17: 03.2-24, 03.2-25, 03.2-52, 05.1.1-07, 05.1.1-08, 06-24. Held: 05.1.1-25 (unpushed flag, asked to push), 06-25, 06-29 working.
- archived 05.1.1-25 (nothing to push, confirmed)
- archived ~22:40: 03.2-27,29,37,41,46, 04.1-14, 04.1-16, 05.1.1-12, 06-23,26,27,28,29. Held: 03.1.1-12, 03.2-18 (unpushed flag, asked), 06-25 working.

## Batch on ci/merge-train-19 (2026-11-25 ~23:45)
03.1.1-14 session_01SEn5g71LXwM7jYi2TWk8wN
03.2-19 session_01SEn5g93eV1XakwYjDzGmGC
03.2-28 session_01SEn5g5VMwiCvYKaJc2FQ5L
03.2-38 session_01SEn5g6DbwUuJhniPyfn4q3
03.2-39 session_01SEn5g9bvhR2XeNSakCfRBb
03.2-42 session_01SEn5g62deDXgKHvwN2Wv7e
03.2-43 session_01SEn5g6MVSsDDYh817pEQrF
03.2-47 session_01SEn5g6UNSvCHtCRkkzCnMe
03.2-56 session_01SEn5g7tYGf4ANnUqtjnJaA
04.1-15 session_01SEn5g5wdkix95hgickyuB5
05.1.1-09 session_01SEn5g78Lxk23X9JtSgFCQF
05.1.1-10 session_01SEn5g6TDk5Qmzbto4ZaZhk
05.1.1-11 session_01SEn5g75BhoZG9DVD7wse8A
05.1.1-13 session_01SEn5g5R5yizDtYgCbY3Li7
06-31 session_01SEn5g84kCTPRrt8iNHX7La
06-32 session_01SEn5g72k74Dy9BrfXbeJo3
06-33 session_01SEn5g76fVsDi1xXeqAc656
06-34 session_01SEn5g5HK9vUm3XsxBR5WZU
06-38 session_01SEn5g7vxtAHdfHDZeS75AT

### 2026-11-26 00:45Z: all 19 train-19-batch sessions archived. Merge train 20 builder started (19 exec branches + docs/live-migrations-train19).
- Live-migration notes from SUMMARYs: 03.2-19 needs 0809 (+ RAG_INGEST_ASYNC=on before use); 03.2-43 needs 0817_upload_scopes after 0805. Apply after train 20 merges.
- Next: when ci/merge-train-20 is pushed, run ready2.py and launch next ready plans with brief-train19.md adapted to train 20.

## Batch on ci/merge-train-20 (2026-11-26 ~01:45)
03.2-32 session_01SEn5g7vpwGozkq2Z64QzK3
03.2-45 session_01SEn5g8bZboqwcngsFBtMwv
03.2-57 session_01SEn5g8dujJN5sHdSu13bSH
04.1-17 session_01SEn5g6hduo9zQY5qbg1Lxp
05.1.1-14 session_01SEn5g6zpmcWf2jrMsTDALC
05.1.1-15 session_01SEn5g6c1LAMfkM1BtQxXM1
05.1.1-16 session_01SEn5g9YseW6ghEYMBSKEcE
05.1.1-17 session_01SEn5g83kuiJGSxk2FYiAJE
06-36 session_01SEn5g6iaTo9iaeK89KYzj5
06-39 session_01SEn5g8nuyK3QovgooUwfXw
05.1.1-20 session_01SEn5g5xZ4vsGBuu5G6xBbJ
07-05 session_01SEn5g8pEqJgzSzuDGz6uP8

### 2026-11-26 ~02:20Z train 20 merged (PR #100 incl. #99). Live migrations applied from main session: train20_0536, 0537, 0809, 0817, 0818 (0410 unchanged, no r9). Verified: 15 new fns search_path="" and no anon/authenticated EXECUTE; 3 new tables RLS on. documents=2, chunks=34 (was 1/15 — owner activity since). Log section still to add to LIVE-MIGRATION-LOG (fold into train 21).
- Pending for train 21: fix/ingest-auto-resume (10320f19).

## Batch on stacked exec bases (2026-11-26 ~04:45, for train 22)
03.2-49 session_01SEn5g8Njg2hnHdQ4rTi3cD
03.2-59 session_01SEn5g7rRmwqDcCHfm5vJWF
03.2-64 session_01SEn5g7VAMWdwKFxxCxqQ44
05.1.1-18 session_01SEn5g9inhH3mSdoQUvfJo5
05.1.1-19 session_01SEn5g9YybWEGwmS9SAGiMQ
05.1.1-21 session_01SEn5g6sz1g4YJ6mtUNFFAw
06-40 session_01SEn5g8A3C4BeDRrFRAY8dc
07-06 session_01SEn5g5tCsTjkk5991u7Xuc
train-20 batch: 12 archived (all already SESSION_STATUS_ARCHIVED; none working)
07-04 session_01SEn5g9MACeshD59sYAMBCG (base exec/06-40)
archived: 03.2-59, 03.2-64, 05.1.1-18, 05.1.1-19, 05.1.1-21, 06-40
### 2026-11-26 ~05:25Z train 21 = PR #103. CI fixes pushed: 1a1c7ef4 (language-literal allow-list for 05.1.1-16/-17), a4be37bf (stage-idempotency test vs embed yielding from ingest-auto-resume). Builder prompt for train 22 must also run `node --import tsx --test tests/rag-e2e/*.test.mts` and `node scripts/ci/check-language-literals.mjs` (CI ts-tsx / ts-checks). PR #102 (UI fixes) merged + deployed (99736b3c).

## Batch 2026-11-26 ~07:00 (for train 23)
- 03.2-50 session_id: session_01SEn5g9iGCqFvZoS2Fh7157 (base exec/03.2-49)
- 03.2-51 session_id: session_01SEn5g9ovGefPgaXX9BajjP (base exec/03.2-49)
- 07-09 session_id: session_01SEn5g5setESHLrwcFNrpfT (base exec/07-06)
- archived: session_01SEn5g8Njg2hnHdQ4rTi3cD (03.2-49), session_01SEn5g5tCsTjkk5991u7Xuc (07-06), session_01SEn5g9MACeshD59sYAMBCG (07-04)
- chore/rederive-ingest-floor (72adfe8a): include in train 23.

## 2026-11-26 08:40Z
- Archived done: 07-09 (exec/07-09, base exec/07-06), 03.2-50 (exec/03.2-50, base exec/03.2-49), 03.2-51 (exec/03.2-51, base 03.2-49; new migration 0821_translation_query_state.sql). -> train 23 with chore/rederive-ingest-floor.
- Prod deploy myrag-3pdctnyrc READY (voice button hidden, NEXT_PUBLIC_VOICE_MODE_ENABLED=false).
- PR #104 CI: 10/16 green, 6 running.
## 2026-11-26 08:50Z
- Train 22 merged e04fd89c; 0704/0705/0820 live (train22_*), verified invoker/search_path/grants; trunk synced; deploy READY.
- Running: 07-11 session_01SEn5g5FjerJ56FR56Wmr7g (base exec/07-09), 03.2-60 session_01SEn5g9fCeL4RHuCbXCeW5J (trunk), 04.1-13 session_01SEn5g6NfPot7bz2thsyoZR (trunk; hold released, LANG-01 on trunk), 03.2-65 session_01SEn5g6SV5keFxDcBqhF8yS (trunk; live push checkpoint signed off by orchestrator, verified query).
- Counts: 792 plans, 396 merged + 3 unmerged done, 4 running, ~388 left, depth 31. Bottlenecks asked of owner: 04.1 not_flipped chain (04.1-09..12 gate ~250 plans), 03.2-36 python-docx check, 06-22 package-age date 2026-12-04.
- 09:00Z owner: max parallel. Released holds 04.1-09..12 (not_flipped path: close 09 as no-op, 10/11 doc+baseline for legacy default, 12 proves legacy default). Launch as one stacked session on exec/04.1-13 once 04.1-13 lands. 03.2-36 still waits owner python-docx ok.
- 09:15Z owner approved python-docx -> 03.2-36 session_01SEn5g9SRhoBF1djfq894gM (trunk). Owner: accuracy test (live golden set) NOT now — no documents chosen yet. PR #105 open (send tap + thinking anim).
- 09:25Z PR #105 merged d2a3dd6e, trunk synced, deployed READY.
- 09:35Z owner: eval plan medical->legal->finance. Paused by-luggage (bwvhzitzeqgafibczldw). Created eval DB myrag-eval fsgaeysipkukqoocgzbx (free, eu-west-1). Agents: schema setup on eval DB; AIFA corpus download to scratchpad/eval-medical (not ingested). Corpus/golden never in repo.
## 09:45Z
- Archived done: 03.2-36, 03.2-65, 03.2-60, 07-11.
- Launched: 03.2-40 session_01SEn5g9JSVLzDWSo4S8oJNP (base exec/03.2-36), 03.2-61 session_01SEn5g9fmd8YHU9XhDPdoaq (base exec/03.2-60), 04.1-09..12 chain session_01SEn5g7sxoQqsN5BwjLDLad (base exec/04.1-13, branch exec/04.1-12, not_flipped path). 04.1-13 session_01SEn5g6NfPot7bz2thsyoZR still running.
- Train 23 builder (subagent) on ci/merge-train-23: 03.2-50, 03.2-51, 07-11(+07-09), 03.2-60, 03.2-65, 03.2-36, chore/rederive-ingest-floor.
## 10:15Z
- Owner: one Supabase project per domain (medical/legal/finance), kept, switchable via per-domain site URL; needs Pro before legal (owner upgrades). myrag-eval = medical DB.
- Done+archived: 04.1-13, 04.1-09..12 (exec/04.1-12, legacy default kept), 03.2-61, 03.2-40 (migration 0822; operator: apply + run rescan).
- Launched 9 on exec/04.1-12 or 3.2 bases: 04.2-01 ..01SEn5g9MmA5vSjfjB6kFDUj, 04.2-02 ..7CwXZx7HmyffXjhhd, 04.2-03 ..8GGEwevGuTJjJuVpY, 04.2-04 ..7HwumAHqXfQ292Uqm, 04.1.1-01 ..9Dse9qAFetckeSoio, 04.1.1-02 ..9R6LbtQSDnTTScejt, 04.1.1-03 ..7iDfSXgy19yg61oAx, 03.2-58 ..846FTGNNPDrfV4ocW (base exec/03.2-40), 03.2-62 ..8APGJzXBDKx6isQEV (base exec/03.2-61).
- Held: 03.2-66 (needs exec/03.2-40 + exec/03.2-51 merged; after train 23/24).
- Train 24 candidates: 04.1-13, 04.1-09..12 (exec/04.1-12), 03.2-40, 03.2-61 + the 9 above.
- 10:25Z owner: name eval DB myrag-medical (fsgaeysipkukqoocgzbx). No rename tool in Supabase MCP; owner renames in dashboard. Refer to it as myrag-medical from now.
- 10:35Z owner: vector model per recommendation (Qwen3-8B-1024 main + OpenAI 3-small comparison). Rename: owner declined PAT; rename in dashboard. Train 23 PR #106 head da49fcb2 (migrations 0707, 0821). Flaky: sidecar test_preflight_hidden_text off-path compares wall-clock ms (follow-up for 03.2-36).
- 10:45Z Supabase PAT saved as network secret for api.supabase.com (proxy-injected). Renamed fsgaeysipkukqoocgzbx -> myrag-medical via Management API PATCH /v1/projects/{ref}.
- 10:50Z train 23 merged 4b05dade; 0707+0821 applied live as train23_0707_..._0821 (one migration); trunk synced; deployed. myrag-medical still lacks 0707/0821 (built at d2a3dd6e).
