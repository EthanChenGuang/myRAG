# Model roles for GSD work in this project (user decision, 2026-11-25; replaces 2026-11-23)

- Development runs on Opus: `gsd-executor`, `gsd-code-fixer`, `gsd-debugger`, `gsd-nyquist-auditor` and any agent that writes or fixes code. Spawn with `model: "opus"`.
- Design and research run on Fable: discuss-phase analysis, phase and project research, pattern mapping, roadmapping, planning, UI design contracts (`gsd-planner`, `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-advisor-researcher`, `gsd-ai-researcher`, `gsd-domain-researcher`, `gsd-ui-researcher`, `gsd-pattern-mapper`, `gsd-roadmapper`, `gsd-assumptions-analyzer`, `gsd-framework-selector`, `gsd-eval-planner`). Spawn with `model: "fable"`.
- Review runs on Opus: plan checking, code review, verification, security and integration checks, UI and eval audits (`gsd-plan-checker`, `gsd-code-reviewer`, `gsd-verifier`, `gsd-integration-checker`, `gsd-security-auditor`, `gsd-ui-checker`, `gsd-ui-auditor`, `gsd-eval-auditor`, `gsd-doc-verifier`).
- General operations run on Sonnet: summaries, docs, codebase mapping, intel, classification and similar housekeeping (`gsd-research-synthesizer`, `gsd-doc-writer`, `gsd-codebase-mapper`, `gsd-intel-updater`, `gsd-doc-classifier`, `gsd-doc-synthesizer`, Explore and other lookup agents).
- The per-agent mapping lives in `.planning/config.json` under `model_overrides`; keep both in sync.
- Agents already running when a rule changes finish on the model they started with.
