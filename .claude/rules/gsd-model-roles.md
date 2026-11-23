# Model roles for GSD work in this project (user decision, 2026-11-23)

- Planning and research run on Fable: discuss-phase analysis, phase and project research, pattern mapping, roadmapping, planning and plan checking. Spawn these agents with `model: "fable"`.
- The per-agent mapping lives in `.planning/config.json` under `model_overrides`; keep both in sync.
- Execution (`gsd-executor`), verification and code review keep the profile in `.planning/config.json` unless the user says otherwise.
