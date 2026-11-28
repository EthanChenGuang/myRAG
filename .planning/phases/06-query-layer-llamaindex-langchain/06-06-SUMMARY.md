---
phase: 06-query-layer-llamaindex-langchain
plan: 06
subsystem: rag-query
tags: [relative-dates, time-zone, rewrite-gate, R2, normalize_dates]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "plan 06-03 matchRelativeTime and the relative_time lexicon entries"
provides:
  - "normalizeRelativeDates(q, { now, timeZone }) → { range: { from, to, includeUndated: true, timeZone } | null, denseSuffix, matched, timeZone }"
  - "resolveTimeZone(tz) — Intl-validated IANA zone, otherwise UTC"
  - "RECENT_DAYS = 90 (最近 / recently / lately / di recente / recentemente)"
  - "matchRelativeTime drops a span overlapped by a longer one"
affects: [06-24]

actuals:
  tokens: 30000
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Local Y/M/D from Intl.DateTimeFormat parts, then integer civil-day arithmetic (days-from-civil), no millisecond offset math"

key-files:
  created:
    - src/lib/rag/query/dates.ts
    - tests/rag/query/dates.test.ts
  modified:
    - src/lib/rag/query/rewrite-gate.ts
    - tests/rag/query/rewrite-gate.test.ts

key-decisions:
  - "Current periods (this week/month/quarter/year, 今年, questo mese …) cover the whole calendar period, not period-start to today"
  - "Trailing N units end today and include it: N days = today−(N−1)…today; N weeks = today−(7N−1)…today; N months/years = (today shifted back N months/years, day clamped to month end) + 1 day … today"
  - "Weeks start on Monday"
  - "Several R2 expressions give one union range (earliest start to latest end)"
  - "A count of 0 is ignored; dates are clamped to 0001-01-01…9999-12-31; an invalid now returns no range"
  - "resolveTimeZone accepts only IANA-shaped names (≤ 64 chars) that Intl accepts; UTC offsets like +01:00 fall back to UTC; zone returned top-level and in the range for the trace"
  - "matched lists the lexicon terms with N substituted (近30天, past 30 days), deduplicated, in query order"

requirements-completed: [LAT-03]

coverage:
  - id: D1
    description: "Time-zone resolution with UTC fallback; month end, leap year, quarter, Monday weeks, DST and negative-offset zones"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "tests/rag/query/dates.test.ts#calendar arithmetic in the request time zone"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every R2 phrase class in zh, en and it maps to the right absolute range with includeUndated and an ISO dense suffix; no R2 → null"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "tests/rag/query/dates.test.ts#R2 expressions in zh, en and it"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-11-25
status: complete
---

# Phase 6 Plan 06: Relative Date Normalization Summary

**Gate rule R2 made concrete: zh/en/it relative time becomes an absolute inclusive date range in the request's IANA time zone (UTC fallback), with `includeUndated: true` and an ISO suffix for the dense query. Deterministic, no LLM.**

## Accomplishments
- `resolveTimeZone` validates the client zone with `Intl.supportedValuesOf('timeZone')` / `Intl.DateTimeFormat`; anything else, including offsets, empty and non-strings, becomes UTC.
- `normalizeRelativeDates` reads the local calendar date of `now` from Intl parts, then computes ranges by integer civil-day arithmetic: day, Monday-start week, month, quarter, year, trailing N units and the 90-day "recent" window.
- Tested edge cases: 2026-03-31T23:30Z is still March in UTC but April 1 in Asia/Shanghai, a leap day, Q1 → previous Q4, Sunday weeks, "yesterday" just after the Europe/Rome DST jump (a 24-hour shift would give the wrong day), and New York on New Year's Eve.
- 28 tests in `dates.test.ts` (plan bar: ≥ 12).

## Task Commits
1. **Task 1: time-zone resolution and calendar arithmetic**: `0959061` (test, RED), `5a19f0c` (feat)
2. **Task 2: R2 expressions to ranges and the dense suffix**: `a8a7982` (test, RED), `9898f32` (feat)

## Tests that failed before the fix
- `tests/rag/query/rewrite-gate.test.ts` › "overlapping relative-time spans keep only the longest match" and `dates.test.ts` › "最近30天 is the 30-day window": before `9898f32`, `matchRelativeTime('最近30天')` returned both 最近 (recent) and 近30天, so the union widened the range to 90 days.

## Deviations from Plan

**1. [Rule 1 - Bug] `matchRelativeTime` returned overlapping spans** (in `src/lib/rag/query/rewrite-gate.ts`, which is not in `files_modified`)
- **Found during:** Task 2. 最近30天 contains both 最近 and 近30天.
- **Fix:** a span overlapped by a longer span is dropped. Gate firing (R2 → `normalize_dates`) is unchanged, and so is the masking, which already skipped overlaps. A regression test was added to `rewrite-gate.test.ts`.

**2. Task 1 GREEN shipped only fixed periods.** Trailing N and "recent" came with Task 2 so its RED commit failed on assertions.

## Gate results
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 226 files, 3476 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 163 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 794 pass, 0 fail, 2 cancelled. These are the known pre-existing `ingestion-ledger-pg.test.mts` failures (`pg_ctl initdb` refuses to run as root), and this plan does not touch that file.
- `check-rag-boundary` and its node tests (38 pass), `check-config` (122 variables ok), `check-workflows`: OK
- Not run: Python suites (no Python touched), `gen:schemas` (no contracts touched), and `npm run test-rag`. The module is not yet wired into retrieval or ingest; plan 06-24 wires it.

## User Setup Required
None. No env vars, SQL, packages or migrations.

## Next Phase Readiness
- Plan 06-24 can turn `range` into the DATA-08 date filter. `includeUndated` is already true, and filters only narrow the tenant scope. It can also append `denseSuffix` to the dense-leg query text and trace `timeZone`.
- The time zone comes from the client and must reach this function untrusted. Only zones that Intl accepts are used (T-06-10).
