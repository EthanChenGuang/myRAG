# Model roles for GSD work in this project (user decision, 2026-11-23)

- Planning and research run on Opus: discuss-phase analysis, phase and project research, pattern mapping, roadmapping, planning and plan checking. Spawn these agents with `model: "opus"`.
- Fable is not the default. Use it only when the user asks, or as an extra review of a plan where a cross-tenant leak is at stake.
- The per-agent mapping lives in `.planning/config.json` under `model_overrides`; keep both in sync.
- Execution (`gsd-executor`) runs on Sonnet; verification and code review run on Opus, unless the user says otherwise.
