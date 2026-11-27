import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "ci" / "check-workflows.py"
spec = importlib.util.spec_from_file_location("check_workflows", MODULE_PATH)
check_workflows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_workflows)


def workflow(run: str) -> dict:
    return {"jobs": {"ts-tsx": {"steps": [{"run": run}]}}}


class TsxCoverageTest(unittest.TestCase):
    def run_check(self, files: list[str], runs: list[str]) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            for name in files:
                (Path(tmp) / name).write_text("")
            errors: list[str] = []
            check_workflows.check_tsx_tests_covered([workflow(run) for run in runs], Path(tmp), errors)
            return errors

    def test_glob_covers_every_file(self):
        errors = self.run_check(["a.test.mts", "b.test.mts"], ["node --import tsx --test tests/*.test.mts"])
        self.assertEqual(errors, [])

    def test_hand_list_missing_a_file_fails(self):
        errors = self.run_check(
            ["a.test.mts", "b.test.mts"],
            ["node --import tsx --test tests/a.test.mts"],
        )
        self.assertEqual(len(errors), 1)
        self.assertIn("tests/b.test.mts", errors[0])

    def test_complete_hand_list_passes(self):
        errors = self.run_check(
            ["a.test.mts", "b.test.mts"],
            ["node --import tsx --test tests/a.test.mts tests/b.test.mts"],
        )
        self.assertEqual(errors, [])

    def test_no_tsx_step_fails(self):
        errors = self.run_check(["a.test.mts"], ["npx vitest run"])
        self.assertEqual(len(errors), 1)

    def test_glob_in_another_command_does_not_count(self):
        errors = self.run_check(["a.test.mts"], ["echo tests/*.test.mts"])
        self.assertEqual(len(errors), 1)

    def test_repository_workflows_cover_every_test(self):
        workflows = [
            check_workflows.load(path)[0]
            for path in (check_workflows.PR, check_workflows.NIGHTLY)
            if path.exists()
        ]
        errors: list[str] = []
        check_workflows.check_tsx_tests_covered(workflows, check_workflows.TESTS_DIR, errors)
        self.assertEqual(errors, [])


class DbTestsStepTest(unittest.TestCase):
    def pr_errors(self, text: str) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pr-smoke.yml"
            path.write_text(text, encoding="utf-8")
            original = check_workflows.PR
            check_workflows.PR = path
            try:
                errors: list[str] = []
                check_workflows.check_pr(errors)
                return errors
            finally:
                check_workflows.PR = original

    def test_repository_workflow_runs_the_database_tests(self):
        text = check_workflows.PR.read_text(encoding="utf-8")
        self.assertTrue("tests/rag-db/*.test.mts" in text, "pr-smoke.yml does not run tests/rag-db")
        self.assertEqual([e for e in self.pr_errors(text) if "rag-db" in e], [])

    def test_missing_database_tests_step_is_reported(self):
        text = check_workflows.PR.read_text(encoding="utf-8").replace("tests/rag-db/*.test.mts", "tests/other/*.test.mts")
        errors = self.pr_errors(text)
        self.assertTrue(any("tests/rag-db/" in e for e in errors), errors)


class EvalSmokeJobTest(unittest.TestCase):
    def job(self) -> dict:
        return check_workflows.load(check_workflows.PR)[0]["jobs"]["eval-smoke"]

    def errors_for(self, job: dict | None) -> list[str]:
        errors: list[str] = []
        check_workflows.check_eval_smoke(job, errors)
        return errors

    def ingest_step(self, job: dict) -> dict:
        return next(step for step in job["steps"] if "--fixture-mode ingest" in str(step.get("run", "")))

    def test_repository_workflow_gates_the_ingest_mode(self):
        self.assertEqual(self.errors_for(self.job()), [])

    def test_missing_ingest_step_is_reported(self):
        job = self.job()
        job["steps"] = [step for step in job["steps"] if "--fixture-mode ingest" not in str(step.get("run", ""))]
        self.assertTrue(any("must run" in e and "--fixture-mode ingest" in e for e in self.errors_for(job)))

    def test_an_ungated_ingest_step_is_reported(self):
        job = self.job()
        step = self.ingest_step(job)
        step["run"] += " --no-gate"
        self.assertTrue(any("--no-gate" in e for e in self.errors_for(job)))

    def test_a_foreign_baseline_is_reported(self):
        job = self.job()
        step = self.ingest_step(job)
        step["run"] += " --baseline eval/baselines/fixture-baseline.json"
        self.assertTrue(any("--baseline" in e for e in self.errors_for(job)))

    def test_ingest_step_before_the_prechunked_step_is_reported(self):
        job = self.job()
        steps = job["steps"]
        ingest = self.ingest_step(job)
        steps.remove(ingest)
        steps.insert(0, ingest)
        self.assertTrue(any("after the prechunked" in e for e in self.errors_for(job)))

    def test_the_ingest_output_must_be_uploaded(self):
        job = self.job()
        for step in job["steps"]:
            if str(step.get("uses", "")).startswith("actions/upload-artifact@"):
                step["with"]["path"] = "eval/out/smoke"
        self.assertTrue(any("must upload eval/out/smoke-ingest" in e for e in self.errors_for(job)))

    def test_a_workflow_without_the_job_has_nothing_to_check(self):
        self.assertEqual(self.errors_for(None), [])


class SecSmokeStepTest(unittest.TestCase):
    """D-14, T-05.1-59: the recommended SEC configuration is gated at absolute zero on every pull request."""

    def job(self) -> dict:
        return check_workflows.load(check_workflows.PR)[0]["jobs"]["eval-smoke"]

    def errors_for(self, job: dict) -> list[str]:
        errors: list[str] = []
        check_workflows.check_eval_smoke(job, errors)
        return errors

    def sec_step(self, job: dict) -> dict:
        return next(step for step in job["steps"] if "sec-recommended.json" in str(step.get("run", "")))

    def test_missing_sec_step_is_reported(self):
        job = self.job()
        job["steps"] = [step for step in job["steps"] if "sec-recommended.json" not in str(step.get("run", ""))]
        self.assertTrue(any("sec-recommended.json" in e for e in self.errors_for(job)))

    def test_an_ungated_sec_step_is_reported(self):
        for suffix in (" --no-gate", " || true"):
            job = self.job()
            self.sec_step(job)["run"] += suffix
            self.assertTrue(any("fail the job" in e for e in self.errors_for(job)), suffix)

    def test_continue_on_error_is_reported(self):
        job = self.job()
        self.sec_step(job)["continue-on-error"] = True
        self.assertTrue(any("fail the job" in e for e in self.errors_for(job)))

    def test_the_sec_output_must_be_uploaded(self):
        job = self.job()
        for step in job["steps"]:
            if str(step.get("uses", "")).startswith("actions/upload-artifact@"):
                step["with"]["path"] = "eval/out/smoke\neval/out/smoke-ingest"
        self.assertTrue(any("must upload eval/out/smoke-sec" in e for e in self.errors_for(job)))

    def test_the_all_off_smoke_step_stays(self):
        job = self.job()
        job["steps"] = [step for step in job["steps"] if "npm run test-rag -- --out eval/out/smoke" not in str(step.get("run", ""))]
        self.assertTrue(any("after the all-off smoke step" in e for e in self.errors_for(job)))


class FrameworkAndCacheGateTest(unittest.TestCase):
    """D-40, D-42 e, T-06-92: every PR compares both query-layer frameworks and gates cache near-miss wrong hits at zero."""

    def job(self) -> dict:
        return check_workflows.load(check_workflows.PR)[0]["jobs"]["eval-smoke"]

    def errors_for(self, job: dict) -> list[str]:
        errors: list[str] = []
        check_workflows.check_eval_smoke(job, errors)
        return errors

    def without(self, job: dict, needle: str) -> dict:
        job["steps"] = [step for step in job["steps"] if needle not in str(step.get("run", ""))]
        return job

    def step_with(self, job: dict, needle: str) -> dict:
        return next(step for step in job["steps"] if needle in str(step.get("run", "")))

    def test_repository_workflow_runs_both_gates(self):
        self.assertEqual(self.errors_for(self.job()), [])

    def test_missing_framework_comparison_is_reported(self):
        job = self.without(self.job(), "rag_eval.compare frameworks")
        self.assertTrue(any(check_workflows.FRAMEWORKS_STEP in e for e in self.errors_for(job)))

    def test_a_soft_framework_comparison_is_reported(self):
        job = self.job()
        self.step_with(job, "rag_eval.compare frameworks")["run"] += " || true"
        self.assertTrue(any("framework comparison" in e and "fail the job" in e for e in self.errors_for(job)))
        job = self.job()
        self.step_with(job, "rag_eval.compare frameworks")["continue-on-error"] = True
        self.assertTrue(any("framework comparison" in e and "fail the job" in e for e in self.errors_for(job)))

    def test_missing_cache_check_is_reported(self):
        job = self.job()
        step = self.step_with(job, check_workflows.CACHE_CHECK_STEP)
        step["run"] = "\n".join(line for line in step["run"].splitlines() if check_workflows.CACHE_CHECK_STEP not in line)
        self.assertTrue(any(check_workflows.CACHE_CHECK_STEP in e for e in self.errors_for(job)))

    def test_missing_cache_pair_run_is_reported(self):
        job = self.job()
        step = self.step_with(job, check_workflows.CACHE_CHECK_STEP)
        step["run"] = "\n".join(line for line in step["run"].splitlines() if "--cache-pairs" not in line)
        self.assertTrue(any("--cache-pairs" in e for e in self.errors_for(job)))

    def test_a_check_before_the_fresh_pair_run_is_reported(self):
        job = self.job()
        step = self.step_with(job, check_workflows.CACHE_CHECK_STEP)
        step["run"] = "\n".join(reversed(step["run"].splitlines()))
        self.assertTrue(any("fresh pair run" in e for e in self.errors_for(job)))

    def test_a_soft_cache_check_is_reported(self):
        job = self.job()
        self.step_with(job, check_workflows.CACHE_CHECK_STEP)["run"] += " || true"
        self.assertTrue(any("cache" in e and "fail the job" in e for e in self.errors_for(job)))

    def test_both_gates_run_after_the_installs(self):
        job = self.job()
        steps = job["steps"]
        for needle in ("rag_eval.compare frameworks", check_workflows.CACHE_CHECK_STEP):
            step = self.step_with(job, needle)
            steps.remove(step)
            steps.insert(1, step)
        errors = self.errors_for(job)
        self.assertTrue(any("after npm ci and uv sync" in e for e in errors), errors)


class InjectionSecJobTest(unittest.TestCase):
    """D-14, A-13, T-05.1-60: the live SEC matrix runs nightly; the Lakera key is reachable from nightly.yml only."""

    def nightly(self) -> dict:
        return check_workflows.load(check_workflows.NIGHTLY)[0]

    def errors_for(self, data: dict) -> list[str]:
        errors: list[str] = []
        check_workflows.check_injection_sec(data, errors)
        return errors

    def runner(self, data: dict) -> dict:
        steps = data["jobs"]["injection-sec"]["steps"]
        return next(step for step in steps if check_workflows.SEC_NIGHTLY_STEP in str(step.get("run", "")))

    def test_repository_nightly_has_a_valid_injection_job(self):
        self.assertEqual(self.errors_for(self.nightly()), [])

    def test_missing_job_is_reported(self):
        data = self.nightly()
        del data["jobs"]["injection-sec"]
        self.assertTrue(any("'injection-sec' missing" in e for e in self.errors_for(data)))

    def test_the_lakera_key_must_come_from_secrets_by_name(self):
        data = self.nightly()
        del self.runner(data)["env"]["LAKERA_GUARD_API_KEY"]
        self.assertTrue(any("LAKERA_GUARD_API_KEY" in e for e in self.errors_for(data)))

    def test_a_secret_inside_run_is_reported(self):
        data = self.nightly()
        self.runner(data)["run"] += " ${{ secrets.LAKERA_GUARD_API_KEY }}"
        self.assertTrue(any("not interpolated into run" in e for e in self.errors_for(data)))

    def test_an_ungated_step_is_reported(self):
        data = self.nightly()
        del self.runner(data)["if"]
        self.assertTrue(any("skip-notice step of injection-sec" in e for e in self.errors_for(data)))

    def test_the_repository_keeps_the_lakera_key_out_of_other_workflows(self):
        errors: list[str] = []
        check_workflows.check_lakera_secret_scope(errors)
        self.assertEqual(errors, [])
        self.assertNotIn("LAKERA_GUARD_API_KEY", check_workflows.PR.read_text(encoding="utf-8"))


class RealDoclingJobTest(unittest.TestCase):
    def nightly(self) -> dict:
        return check_workflows.load(check_workflows.NIGHTLY)[0]

    def errors_for(self, data: dict) -> list[str]:
        errors: list[str] = []
        check_workflows.check_real_docling(data, errors)
        return errors

    def test_repository_nightly_has_a_valid_real_docling_job(self):
        self.assertEqual(self.errors_for(self.nightly()), [])

    def test_missing_job_is_reported(self):
        data = self.nightly()
        del data["jobs"]["real-docling"]
        self.assertTrue(any("'real-docling' missing" in e for e in self.errors_for(data)))

    def test_install_failure_must_skip_with_a_notice(self):
        data = self.nightly()
        for step in data["jobs"]["real-docling"]["steps"]:
            if step.get("id") == "docling":
                step["run"] = step["run"].replace(check_workflows.DOCLING_SKIP_NOTICE, "echo skipping")
        self.assertTrue(any("skips with a notice" in e for e in self.errors_for(data)))

    def test_a_step_after_the_install_without_the_ready_condition_is_reported(self):
        data = self.nightly()
        steps = data["jobs"]["real-docling"]["steps"]
        steps[-2].pop("if")
        self.assertTrue(any("must be conditioned" in e for e in self.errors_for(data)))

    def test_the_real_docling_pytest_run_is_required(self):
        data = self.nightly()
        for step in data["jobs"]["real-docling"]["steps"]:
            step["run"] = str(step.get("run", "")).replace("-m real_docling", "")
        self.assertTrue(any("-m real_docling" in e for e in self.errors_for(data)))

    def test_the_docling_image_must_load_a_processing_profile(self):
        data = self.nightly()
        for step in data["jobs"]["real-docling"]["steps"]:
            step["run"] = str(step.get("run", "")).replace('load_profile("general@1")', "")
        self.assertTrue(any('load_profile("general@1")' in e for e in self.errors_for(data)))


class RayOptionalJobTest(unittest.TestCase):
    def text(self) -> str:
        return check_workflows.RAY_OPTIONAL.read_text(encoding="utf-8")

    def errors_for(self, text: str) -> list[str]:
        import yaml

        errors: list[str] = []
        check_workflows.check_ray_optional(yaml.safe_load(text), text, errors)
        return errors

    def test_repository_workflow_is_valid(self):
        self.assertEqual(self.errors_for(self.text()), [])

    def test_a_pull_request_trigger_is_reported(self):
        text = self.text().replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  pull_request:\n")
        self.assertTrue(any("'pull_request' must not be used" in e for e in self.errors_for(text)))

    def test_a_secret_is_reported(self):
        text = self.text().replace("UV_FROZEN: '1'", "UV_FROZEN: '1'\n          TOKEN: ${{ secrets.GITHUB_TOKEN }}")
        self.assertTrue(any("must not reference secrets" in e for e in self.errors_for(text)))

    def test_the_equality_step_must_opt_in(self):
        text = self.text().replace("RAG_TEST_RAY: '1'", "RAG_TEST_RAY: '0'")
        self.assertTrue(any("RAG_TEST_RAY" in e for e in self.errors_for(text)))

    def test_the_ray_extra_must_be_synced_from_the_lock(self):
        text = self.text().replace(check_workflows.RAY_SYNC, "uv sync --directory rag-sidecar --extra ray")
        self.assertTrue(any(check_workflows.RAY_SYNC in e for e in self.errors_for(text)))

    def test_an_unpinned_action_is_reported(self):
        text = self.text().replace("actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "actions/checkout@v4")
        self.assertTrue(any("40-hex commit sha" in e for e in self.errors_for(text)))

    def test_the_default_workflows_never_install_the_ray_extra(self):
        for path in (check_workflows.PR, check_workflows.NIGHTLY):
            errors: list[str] = []
            check_workflows.check_no_ray_extra(path.stem, path.read_text(encoding="utf-8"), errors)
            self.assertEqual(errors, [], path.name)
        errors = []
        check_workflows.check_no_ray_extra("pr-smoke", "run: uv sync --directory rag-sidecar --locked --extra ray", errors)
        self.assertEqual(len(errors), 1)


class NextBuildJobTest(unittest.TestCase):
    def job(self) -> dict:
        return check_workflows.load(check_workflows.PR)[0]["jobs"]["next-build"]

    def errors_for(self, job: dict | None) -> list[str]:
        errors: list[str] = []
        check_workflows.check_next_build(job, errors)
        return errors

    def test_repository_workflow_runs_next_build(self):
        self.assertIn("next-build", check_workflows.PR_JOBS)
        self.assertEqual(self.errors_for(self.job()), [])

    def test_missing_build_step_is_reported(self):
        job = self.job()
        job["steps"] = [step for step in job["steps"] if "next build" not in str(step.get("run", ""))]
        self.assertTrue(any("must run 'npx next build'" in e for e in self.errors_for(job)))

    def test_missing_install_is_reported(self):
        job = self.job()
        job["steps"] = [step for step in job["steps"] if "npm ci" not in str(step.get("run", ""))]
        self.assertTrue(any("npm ci" in e for e in self.errors_for(job)))

    def test_missing_placeholder_env_is_reported(self):
        job = self.job()
        del job["env"]["SUPABASE_SERVICE_ROLE_KEY"]
        self.assertTrue(any("SUPABASE_SERVICE_ROLE_KEY" in e for e in self.errors_for(job)))

    def test_a_secret_is_reported(self):
        job = self.job()
        job["env"]["SUPABASE_SERVICE_ROLE_KEY"] = "${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}"
        errors = self.errors_for(job)
        self.assertTrue(any("must not reference secrets" in e for e in errors), errors)

    def test_a_workflow_without_the_job_has_nothing_to_check(self):
        self.assertEqual(self.errors_for(None), [])


class TsJobsTest(unittest.TestCase):
    def jobs(self) -> dict:
        return check_workflows.load(check_workflows.PR)[0]["jobs"]

    def errors_for(self, jobs: dict) -> list[str]:
        errors: list[str] = []
        check_workflows.check_ts_jobs(jobs, errors)
        return errors

    def test_repository_workflow_passes(self):
        jobs = self.jobs()
        self.assertNotIn("ts", jobs)
        for name in check_workflows.TS_JOB_NEEDLES:
            self.assertIn(name, check_workflows.PR_JOBS)
            self.assertIn(name, jobs)
        self.assertEqual(self.errors_for(jobs), [])

    def test_a_dropped_check_is_reported(self):
        jobs = self.jobs()
        jobs["ts-checks"]["steps"] = [s for s in jobs["ts-checks"]["steps"] if "next typegen" not in str(s.get("run", ""))]
        self.assertTrue(any("ts-checks is missing 'next typegen'" in e for e in self.errors_for(jobs)))

    def test_a_check_moved_to_another_job_is_reported(self):
        jobs = self.jobs()
        jobs["ts-db"]["steps"] = [s for s in jobs["ts-db"]["steps"] if "tests/rag-db/" not in str(s.get("run", ""))]
        jobs["ts-tsx"]["steps"].append({"run": "node --import tsx --test tests/rag-db/*.test.mts"})
        self.assertTrue(any("ts-db is missing" in e for e in self.errors_for(jobs)))

    def test_a_missing_shard_is_reported(self):
        jobs = self.jobs()
        jobs["ts-db"]["strategy"]["matrix"]["shard"] = ["1/4", "2/4", "3/4"]
        self.assertTrue(any("ts-db matrix.shard" in e for e in self.errors_for(jobs)))

    def test_a_shard_flag_not_from_the_matrix_is_reported(self):
        jobs = self.jobs()
        for step in jobs["ts-vitest"]["steps"]:
            if "vitest run" in str(step.get("run", "")):
                step["run"] = "npx vitest run --shard=1/2"
        self.assertTrue(any("ts-vitest must pass --shard=" in e for e in self.errors_for(jobs)))

    def test_a_long_timeout_is_reported(self):
        jobs = self.jobs()
        jobs["ts-tsx"]["timeout-minutes"] = 60
        self.assertTrue(any("ts-tsx must set timeout-minutes" in e for e in self.errors_for(jobs)))

    def test_the_root_ratchet_is_reported(self):
        jobs = self.jobs()
        jobs["ts-checks"]["steps"].append({"run": "node scripts/ci/tsc-ratchet.mjs --baseline scripts/ci/tsc-baseline.json"})
        self.assertTrue(any("must run plain tsc" in e for e in self.errors_for(jobs)))

    def test_continue_on_error_is_reported(self):
        jobs = self.jobs()
        jobs["ts-db"]["continue-on-error"] = True
        self.assertTrue(any("continue-on-error" in e for e in self.errors_for(jobs)))


if __name__ == "__main__":
    unittest.main()


WEEKLY_CRON = "23 4 * * 1"


def weekly_fixture() -> dict:
    gate = "env.HAS_PRIVATE_EVAL == 'true'"
    return {
        "on": {"schedule": [{"cron": "0 3 * * *"}, {"cron": WEEKLY_CRON}], "workflow_dispatch": None},
        "jobs": {
            "weekly-report": {
                "if": f"github.event_name == 'workflow_dispatch' || github.event.schedule == '{WEEKLY_CRON}'",
                "runs-on": "ubuntu-latest",
                "steps": [
                    {
                        "name": "Detect private eval data",
                        "run": (
                            'if [ -d eval/golden/private ] && [ -n "$(ls -A eval/golden/private)" ]; then\n'
                            '  echo "HAS_PRIVATE_EVAL=true" >> "$GITHUB_ENV"\n'
                            "else\n"
                            '  echo "HAS_PRIVATE_EVAL=false" >> "$GITHUB_ENV"\n'
                            '  echo "::notice::no private eval data on this runner, skipping weekly report"\n'
                            "fi\n"
                        ),
                    },
                    {"uses": "actions/checkout@" + "a" * 40, "if": gate, "with": {"clean": False}},
                    {"name": "Sync eval project", "if": gate, "run": "uv sync --directory eval --locked --all-extras"},
                    {"name": "Failure report", "if": gate, "run": "uv run --directory eval python -m rag_eval.failure_report --since x"},
                    {"name": "Drift", "if": gate, "run": "uv run --directory eval python -m rag_eval.drift --tenant t --set s"},
                    {"name": "Stale scan", "if": gate, "run": "uv run --directory eval python -m rag_eval.golden_set stale-scan --golden g"},
                    {"name": "Re-review", "if": gate, "run": "uv run --directory eval python -m rag_eval.golden_set re-review --golden g"},
                    {
                        "name": "Weekly report",
                        "if": gate,
                        "env": {"RAG_ADMIN_BEARER": "${{ secrets.RAG_ADMIN_BEARER }}"},
                        "run": "uv run --directory eval python -m rag_eval.weekly_report --since x",
                    },
                ],
            }
        },
    }


class WeeklyReportJobTest(unittest.TestCase):
    def errors_for(self, data: dict) -> list[str]:
        errors: list[str] = []
        check_workflows.check_weekly_report(data, errors)
        return errors

    def steps(self, data: dict) -> list[dict]:
        return data["jobs"]["weekly-report"]["steps"]

    def test_the_fixture_is_valid(self):
        self.assertEqual(self.errors_for(weekly_fixture()), [])

    def test_repository_nightly_has_a_valid_weekly_job(self):
        self.assertEqual(self.errors_for(check_workflows.load(check_workflows.NIGHTLY)[0]), [])

    def test_missing_job_is_reported(self):
        data = weekly_fixture()
        del data["jobs"]["weekly-report"]
        self.assertTrue(any("'weekly-report' missing" in e for e in self.errors_for(data)))

    def test_missing_notice_step_is_reported(self):
        data = weekly_fixture()
        del self.steps(data)[0]
        self.assertTrue(any("first step" in e for e in self.errors_for(data)))

    def test_a_first_step_without_the_notice_is_reported(self):
        data = weekly_fixture()
        self.steps(data)[0]["run"] = self.steps(data)[0]["run"].replace("::notice::", "")
        self.assertTrue(any("first step" in e for e in self.errors_for(data)))

    def test_an_ungated_step_is_reported(self):
        data = weekly_fixture()
        del self.steps(data)[3]["if"]
        self.assertTrue(any("HAS_PRIVATE_EVAL == 'true'" in e for e in self.errors_for(data)))

    def test_an_upload_artifact_step_is_reported(self):
        data = weekly_fixture()
        self.steps(data).append(
            {"uses": "actions/upload-artifact@" + "b" * 40, "if": "env.HAS_PRIVATE_EVAL == 'true'", "with": {"path": "eval/golden/private"}}
        )
        self.assertTrue(any("upload" in e for e in self.errors_for(data)))

    def test_a_secret_interpolated_in_a_run_script_is_reported(self):
        data = weekly_fixture()
        self.steps(data)[4]["run"] += ' --base-url "${{ secrets.RAG_APP_BASE_URL }}"'
        self.assertTrue(any("not interpolated into run" in e for e in self.errors_for(data)))

    def test_both_reports_must_run(self):
        data = weekly_fixture()
        del self.steps(data)[3]
        self.assertTrue(any("rag_eval.failure_report" in e for e in self.errors_for(data)))

    def test_the_job_runs_only_on_the_weekly_schedule_or_dispatch(self):
        data = weekly_fixture()
        del data["jobs"]["weekly-report"]["if"]
        self.assertTrue(any("weekly schedule" in e for e in self.errors_for(data)))

    def test_the_weekly_cron_must_be_scheduled(self):
        data = weekly_fixture()
        data["on"]["schedule"] = [{"cron": "0 3 * * *"}]
        self.assertTrue(any("weekly schedule" in e for e in self.errors_for(data)))

    def test_checkout_must_keep_the_private_data(self):
        data = weekly_fixture()
        del self.steps(data)[1]["with"]
        self.assertTrue(any("clean: false" in e for e in self.errors_for(data)))


    def test_the_weekly_lifecycle_steps_must_run(self):
        for needle in ("rag_eval.drift", "golden_set stale-scan", "golden_set re-review"):
            data = weekly_fixture()
            data["jobs"]["weekly-report"]["steps"] = [s for s in self.steps(data) if needle not in str(s.get("run", ""))]
            self.assertTrue(any(needle in e for e in self.errors_for(data)), needle)

    def test_the_lifecycle_steps_run_before_the_weekly_report(self):
        data = weekly_fixture()
        steps = self.steps(data)
        steps.append(steps.pop(4))
        self.assertTrue(any("before the weekly report" in e for e in self.errors_for(data)))


TENANT_GATE = "env.HAS_PRIVATE_EVAL == 'true'"


def tenant_nightly_fixture() -> dict:
    return {
        "on": {"schedule": [{"cron": "0 3 * * *"}, {"cron": WEEKLY_CRON}], "workflow_dispatch": None},
        "jobs": {
            "tenant-nightly": {
                "if": f"github.event.schedule != '{WEEKLY_CRON}'",
                "runs-on": "ubuntu-latest",
                "env": {"HAS_ADMIN_BEARER": "${{ secrets.RAG_ADMIN_BEARER != '' }}"},
                "steps": [
                    {
                        "name": "Detect private eval data and the admin token",
                        "run": (
                            'if [ "$HAS_ADMIN_BEARER" = "true" ] && [ -d eval/golden/private ] && [ -n "$(ls -A eval/golden/private)" ]; then\n'
                            '  echo "HAS_PRIVATE_EVAL=true" >> "$GITHUB_ENV"\n'
                            "else\n"
                            '  echo "HAS_PRIVATE_EVAL=false" >> "$GITHUB_ENV"\n'
                            f'  echo "{check_workflows.TENANT_NIGHTLY_SKIP_NOTICE}"\n'
                            "fi\n"
                        ),
                    },
                    {"uses": "actions/checkout@" + "a" * 40, "if": TENANT_GATE, "with": {"clean": False}},
                    {"name": "Sync eval project", "if": TENANT_GATE, "run": "uv sync --directory eval --locked --all-extras"},
                    {
                        "name": "Drain",
                        "if": TENANT_GATE,
                        "env": {"RAG_ADMIN_BEARER": "${{ secrets.RAG_ADMIN_BEARER }}", "RAG_APP_URL": "${{ secrets.RAG_APP_URL }}"},
                        "run": 'uv run --directory eval python -m rag_eval.tenant_nightly --drain --base-url "$RAG_APP_URL"',
                    },
                ],
            }
        },
    }


class TenantNightlyJobTest(unittest.TestCase):
    def errors_for(self, data: dict) -> list[str]:
        errors: list[str] = []
        check_workflows.check_tenant_nightly(data, errors)
        return errors

    def steps(self, data: dict) -> list[dict]:
        return data["jobs"]["tenant-nightly"]["steps"]

    def test_the_fixture_is_valid(self):
        self.assertEqual(self.errors_for(tenant_nightly_fixture()), [])

    def test_repository_nightly_has_a_valid_tenant_nightly_job(self):
        self.assertEqual(self.errors_for(check_workflows.load(check_workflows.NIGHTLY)[0]), [])

    def test_missing_job_is_reported(self):
        data = tenant_nightly_fixture()
        del data["jobs"]["tenant-nightly"]
        self.assertTrue(any("'tenant-nightly' missing" in e for e in self.errors_for(data)))

    def test_an_ungated_step_is_reported(self):
        data = tenant_nightly_fixture()
        del self.steps(data)[3]["if"]
        self.assertTrue(any("HAS_PRIVATE_EVAL == 'true'" in e for e in self.errors_for(data)))

    def test_a_missing_skip_notice_is_reported(self):
        data = tenant_nightly_fixture()
        self.steps(data)[0]["run"] = self.steps(data)[0]["run"].replace("::notice::", "")
        self.assertTrue(any("first step" in e for e in self.errors_for(data)))

    def test_the_guard_must_require_the_admin_bearer(self):
        data = tenant_nightly_fixture()
        data["jobs"]["tenant-nightly"]["env"] = {}
        self.assertTrue(any("secrets.RAG_ADMIN_BEARER" in e for e in self.errors_for(data)))
        data = tenant_nightly_fixture()
        self.steps(data)[0]["run"] = self.steps(data)[0]["run"].replace('[ "$HAS_ADMIN_BEARER" = "true" ] && ', "")
        self.assertTrue(any("HAS_ADMIN_BEARER" in e for e in self.errors_for(data)))

    def test_a_secret_interpolated_in_a_run_script_is_reported(self):
        data = tenant_nightly_fixture()
        self.steps(data)[3]["run"] += ' --token "${{ secrets.RAG_ADMIN_BEARER }}"'
        self.assertTrue(any("not interpolated into run" in e for e in self.errors_for(data)))

    def test_an_upload_artifact_step_is_reported(self):
        data = tenant_nightly_fixture()
        self.steps(data).append({"uses": "actions/upload-artifact@" + "b" * 40, "if": TENANT_GATE, "with": {"path": "eval/golden/private"}})
        self.assertTrue(any("upload" in e for e in self.errors_for(data)))

    def test_the_drain_must_run(self):
        data = tenant_nightly_fixture()
        self.steps(data)[3]["run"] = "uv run --directory eval python -m rag_eval.tenant_nightly"
        self.assertTrue(any("--drain" in e for e in self.errors_for(data)))

    def test_the_bearer_reaches_the_drain_through_step_env(self):
        data = tenant_nightly_fixture()
        del self.steps(data)[3]["env"]
        self.assertTrue(any("step env" in e for e in self.errors_for(data)))

    def test_the_job_does_not_run_on_the_weekly_schedule(self):
        data = tenant_nightly_fixture()
        del data["jobs"]["tenant-nightly"]["if"]
        self.assertTrue(any("daily schedule" in e for e in self.errors_for(data)))


MONITOR_GATE = "env.HAS_MONITOR_SECRETS == 'true'"


def monitor_fixture() -> dict:
    return {
        "on": {"schedule": [{"cron": "0 3 * * *"}, {"cron": WEEKLY_CRON}], "workflow_dispatch": None},
        "jobs": {
            "monitor": {
                "if": f"github.event.schedule != '{WEEKLY_CRON}'",
                "runs-on": "ubuntu-latest",
                "env": {
                    "HAS_MONITOR_SECRETS": "${{ secrets.NEXT_PUBLIC_SUPABASE_URL != '' && secrets.SUPABASE_SERVICE_ROLE_KEY != '' }}"
                },
                "steps": [
                    {
                        "name": "Skip notice",
                        "if": "env.HAS_MONITOR_SECRETS != 'true'",
                        "run": f'echo "{check_workflows.MONITOR_SKIP_NOTICE}"',
                    },
                    {"uses": "actions/checkout@" + "a" * 40, "if": MONITOR_GATE},
                    {"name": "Install Node dependencies", "if": MONITOR_GATE, "run": "npm ci --ignore-scripts"},
                    {
                        "name": "Daily monitor",
                        "if": MONITOR_GATE,
                        "env": {
                            "NEXT_PUBLIC_SUPABASE_URL": "${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}",
                            "SUPABASE_SERVICE_ROLE_KEY": "${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}",
                        },
                        "run": "npm run rag:monitor",
                    },
                ],
            }
        },
    }


class MonitorJobTest(unittest.TestCase):
    def errors_for(self, data: dict) -> list[str]:
        errors: list[str] = []
        check_workflows.check_monitor_job(data, errors)
        return errors

    def steps(self, data: dict) -> list[dict]:
        return data["jobs"]["monitor"]["steps"]

    def test_the_fixture_is_valid(self):
        self.assertEqual(self.errors_for(monitor_fixture()), [])

    def test_repository_nightly_has_a_valid_monitor_job(self):
        self.assertEqual(self.errors_for(check_workflows.load(check_workflows.NIGHTLY)[0]), [])

    def test_missing_job_is_reported(self):
        data = monitor_fixture()
        del data["jobs"]["monitor"]
        self.assertTrue(any("'monitor' missing" in e for e in self.errors_for(data)))

    def test_an_ungated_step_is_reported(self):
        data = monitor_fixture()
        del self.steps(data)[3]["if"]
        self.assertTrue(any("HAS_MONITOR_SECRETS == 'true'" in e for e in self.errors_for(data)))

    def test_a_missing_skip_notice_is_reported(self):
        data = monitor_fixture()
        del self.steps(data)[0]
        self.assertTrue(any("skip-notice" in e for e in self.errors_for(data)))

    def test_the_guard_needs_both_supabase_secrets(self):
        for secret in ("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
            data = monitor_fixture()
            job = data["jobs"]["monitor"]
            job["env"]["HAS_MONITOR_SECRETS"] = job["env"]["HAS_MONITOR_SECRETS"].replace(f"secrets.{secret} != ''", "true")
            self.assertTrue(any(f"secrets.{secret}" in e for e in self.errors_for(data)), secret)

    def test_a_secret_interpolated_in_a_run_script_is_reported(self):
        data = monitor_fixture()
        self.steps(data)[3]["run"] = 'SUPABASE_SERVICE_ROLE_KEY="${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}" npm run rag:monitor'
        self.assertTrue(any("not interpolated into run" in e for e in self.errors_for(data)))

    def test_the_secrets_reach_the_monitor_through_step_env(self):
        data = monitor_fixture()
        del self.steps(data)[3]["env"]["SUPABASE_SERVICE_ROLE_KEY"]
        self.assertTrue(any("SUPABASE_SERVICE_ROLE_KEY through step env" in e for e in self.errors_for(data)))

    def test_the_monitor_must_run(self):
        data = monitor_fixture()
        self.steps(data)[3]["run"] = "npm run lint"
        self.assertTrue(any("rag:monitor" in e for e in self.errors_for(data)))

    def test_an_upload_artifact_step_is_reported(self):
        data = monitor_fixture()
        self.steps(data).append({"uses": "actions/upload-artifact@" + "b" * 40, "if": MONITOR_GATE, "with": {"path": "out"}})
        self.assertTrue(any("upload" in e for e in self.errors_for(data)))


class NightlyTriggersTest(unittest.TestCase):
    def test_a_push_trigger_on_nightly_is_reported(self):
        data = check_workflows.load(check_workflows.NIGHTLY)[0]
        data = dict(data)
        data["on"] = {**check_workflows.triggers(data), "push": {"branches": ["main"]}}
        errors: list[str] = []
        check_workflows.check_nightly_triggers(data, errors)
        self.assertTrue(any("'push' must not be used" in e for e in errors))

    def test_the_repository_nightly_triggers_are_valid(self):
        errors: list[str] = []
        check_workflows.check_nightly_triggers(check_workflows.load(check_workflows.NIGHTLY)[0], errors)
        self.assertEqual(errors, [])


class OnlineJudgeMirrorTest(unittest.TestCase):
    def runner(self, data: dict) -> dict:
        return next(s for s in data["jobs"]["online-judge"]["steps"] if "rag_eval.online_judge" in str(s.get("run", "")))

    def errors_for(self, data: dict) -> list[str]:
        errors: list[str] = []
        check_workflows.check_online_judge(data, errors)
        return errors

    def test_the_repository_online_judge_passes_the_mirror_inputs(self):
        self.assertEqual(self.errors_for(check_workflows.load(check_workflows.NIGHTLY)[0]), [])

    def test_the_mirror_inputs_must_reach_the_step_env(self):
        for name in ("RAG_APP_URL", "RAG_ADMIN_BEARER"):
            data = check_workflows.load(check_workflows.NIGHTLY)[0]
            self.runner(data).get("env", {}).pop(name, None)
            self.assertTrue(any(name in e for e in self.errors_for(data)), name)

    def test_the_base_url_flag_must_be_passed(self):
        data = check_workflows.load(check_workflows.NIGHTLY)[0]
        self.runner(data)["run"] = "uv run --directory eval python -m rag_eval.online_judge"
        self.assertTrue(any("--base-url" in e for e in self.errors_for(data)))


JUDGE_GATE = "env.HAS_JUDGE_KEYS == 'true'"


def judge_calibration_fixture() -> dict:
    return {
        "on": {"schedule": [{"cron": "41 5 1 * *"}], "workflow_dispatch": None},
        "permissions": {"contents": "read"},
        "env": dict(check_workflows.TELEMETRY),
        "jobs": {
            "calibrate": {
                "runs-on": "ubuntu-latest",
                "env": {
                    "HAS_JUDGE_KEYS": (
                        "${{ secrets.OPENROUTER_API_KEY != '' && secrets.OPENAI_API_KEY != '' && vars.RAG_JUDGE_GENERATOR_MODEL != '' }}"
                    )
                },
                "steps": [
                    {"name": "Skip notice", "if": "env.HAS_JUDGE_KEYS != 'true'", "run": f'echo "{check_workflows.JUDGE_CALIBRATION_SKIP_NOTICE}"'},
                    {"uses": "actions/checkout@" + "a" * 40, "if": JUDGE_GATE},
                    {"name": "Sync eval project", "if": JUDGE_GATE, "run": "uv sync --directory eval --locked --all-extras"},
                    {
                        "name": "Seed calibration",
                        "if": JUDGE_GATE,
                        "env": {"OPENROUTER_API_KEY": "${{ secrets.OPENROUTER_API_KEY }}", "OPENAI_API_KEY": "${{ secrets.OPENAI_API_KEY }}"},
                        "run": (
                            'uv run --directory eval python -m rag_eval.judge_calibration run --seed-only --generator-model "$M" '
                            "--write --out eval/out/judge-calibration"
                        ),
                    },
                    {
                        "uses": "actions/upload-artifact@" + "b" * 40,
                        "if": f"always() && {JUDGE_GATE}",
                        "with": {"name": "judge-calibration", "path": "eval/config/judge-calibration.json\neval/out/judge-calibration\n"},
                    },
                ],
            }
        },
    }


class JudgeCalibrationWorkflowTest(unittest.TestCase):
    def errors_for(self, data: dict) -> list[str]:
        errors: list[str] = []
        check_workflows.check_judge_calibration(data, errors)
        return errors

    def steps(self, data: dict) -> list[dict]:
        return data["jobs"]["calibrate"]["steps"]

    def test_the_fixture_is_valid(self):
        self.assertEqual(self.errors_for(judge_calibration_fixture()), [])

    def test_the_repository_workflow_exists_and_is_valid(self):
        self.assertTrue(check_workflows.JUDGE_CALIBRATION_WORKFLOW.exists())
        self.assertEqual(self.errors_for(check_workflows.load(check_workflows.JUDGE_CALIBRATION_WORKFLOW)[0]), [])

    def test_a_missing_schedule_is_reported(self):
        data = judge_calibration_fixture()
        del data["on"]["schedule"]
        self.assertTrue(any("schedule" in e for e in self.errors_for(data)))

    def test_a_missing_dispatch_is_reported(self):
        data = judge_calibration_fixture()
        del data["on"]["workflow_dispatch"]
        self.assertTrue(any("workflow_dispatch" in e for e in self.errors_for(data)))

    def test_write_permissions_are_reported(self):
        for scope in ("contents", "pull-requests"):
            data = judge_calibration_fixture()
            data["permissions"] = {"contents": "read", scope: "write"}
            self.assertTrue(any("write" in e for e in self.errors_for(data)), scope)
            data = judge_calibration_fixture()
            data["jobs"]["calibrate"]["permissions"] = {scope: "write"}
            self.assertTrue(any("write" in e for e in self.errors_for(data)), scope)

    def test_an_ungated_step_is_reported(self):
        data = judge_calibration_fixture()
        del self.steps(data)[3]["if"]
        self.assertTrue(any("HAS_JUDGE_KEYS == 'true'" in e for e in self.errors_for(data)))

    def test_a_missing_skip_notice_is_reported(self):
        data = judge_calibration_fixture()
        del self.steps(data)[0]
        self.assertTrue(any("skip-notice" in e for e in self.errors_for(data)))

    def test_the_guard_needs_the_judge_keys(self):
        for secret in ("OPENROUTER_API_KEY", "OPENAI_API_KEY"):
            data = judge_calibration_fixture()
            job = data["jobs"]["calibrate"]
            job["env"]["HAS_JUDGE_KEYS"] = job["env"]["HAS_JUDGE_KEYS"].replace(f"secrets.{secret} != ''", "true")
            self.assertTrue(any(f"secrets.{secret}" in e for e in self.errors_for(data)), secret)

    def test_a_secret_interpolated_in_a_run_script_is_reported(self):
        data = judge_calibration_fixture()
        self.steps(data)[3]["run"] += ' --key "${{ secrets.OPENAI_API_KEY }}"'
        self.assertTrue(any("not interpolated into run" in e for e in self.errors_for(data)))

    def test_the_seed_calibration_must_run(self):
        data = judge_calibration_fixture()
        self.steps(data)[3]["run"] = "uv run --directory eval python -m rag_eval.judge_calibration run --generator-model x"
        self.assertTrue(any("--seed-only" in e for e in self.errors_for(data)))

    def test_the_result_must_be_uploaded(self):
        data = judge_calibration_fixture()
        del self.steps(data)[4]
        self.assertTrue(any("artifact" in e for e in self.errors_for(data)))

    def test_private_files_must_not_be_uploaded(self):
        data = judge_calibration_fixture()
        self.steps(data)[4]["with"]["path"] += "eval/golden/private/judge-calibration\n"
        self.assertTrue(any("eval/golden/private" in e for e in self.errors_for(data)))

    def test_pushing_or_opening_a_pull_request_is_reported(self):
        for command in ("git push origin HEAD", "gh pr create --fill"):
            data = judge_calibration_fixture()
            self.steps(data)[3]["run"] += f" && {command}"
            self.assertTrue(any("pull request" in e for e in self.errors_for(data)), command)


class SidecarPythonJobTest(unittest.TestCase):
    """The sidecar tests need chunking, preflight and hidden-text together; a sync or run that names fewer removes the others."""

    def job(self) -> dict:
        return check_workflows.load(check_workflows.PR)[0]["jobs"]["python"]

    def errors_for(self, job: dict | None) -> list[str]:
        errors: list[str] = []
        check_workflows.check_python_job(job, errors)
        return errors

    def with_runs(self, *runs: str) -> dict:
        return {"steps": [{"run": run} for run in runs]}

    def test_repository_job_syncs_and_runs_every_test_extra(self):
        self.assertEqual(self.errors_for(self.job()), [])

    def test_a_later_sync_with_fewer_extras_is_reported(self):
        job = self.with_runs(
            "uv sync --directory rag-sidecar --locked --extra chunking --extra preflight --extra hidden-text",
            "uv sync --directory rag-sidecar --locked --extra preflight --extra hidden-text",
            "uv run --directory rag-sidecar --locked --extra chunking --extra preflight --extra hidden-text pytest -q",
        )
        self.assertTrue(any("sync must name every test extra (missing chunking)" in e for e in self.errors_for(job)))

    def test_a_pytest_run_with_one_extra_is_reported(self):
        job = self.with_runs(
            "uv sync --directory rag-sidecar --locked --extra chunking --extra preflight --extra hidden-text",
            "uv run --directory rag-sidecar --extra chunking pytest -q",
        )
        errors = self.errors_for(job)
        self.assertTrue(any("pytest run must name every test extra (missing preflight, hidden-text)" in e for e in errors))
        self.assertTrue(any("pytest run must use --locked" in e for e in errors))

    def test_the_docling_extra_is_reported(self):
        job = self.job()
        job["steps"].append({"run": "uv sync --directory rag-sidecar --locked --extra docling"})
        self.assertTrue(any("heavy docling extra" in e for e in self.errors_for(job)))


class DockerConfigCopiesTest(unittest.TestCase):
    def job(self) -> dict:
        return check_workflows.load(check_workflows.PR)[0]["jobs"]["docker-build"]

    def errors_for(self, job: dict) -> list[str]:
        errors: list[str] = []
        check_workflows.check_docker_build(job, errors)
        return errors

    def test_repository_job_compares_every_sidecar_config_copy(self):
        self.assertIn("language-packs.json", check_workflows.sidecar_config_copies())
        self.assertEqual(self.errors_for(self.job()), [])

    def test_a_copy_left_out_of_the_comparison_is_reported(self):
        job = self.job()
        for step in job["steps"]:
            if "run" in step:
                step["run"] = str(step["run"]).replace(" hidden-text-rules.json", "")
        self.assertTrue(any("config/rag/hidden-text-rules.json" in e for e in self.errors_for(job)))


class AbsoluteGatesTest(unittest.TestCase):
    """D-06, O-1, O-2 (05.3-16): every CI tier carries the absolute gates; report mode only where the measurement says so."""

    def workflows(self) -> tuple[dict, dict]:
        return check_workflows.load(check_workflows.PR)[0], check_workflows.load(check_workflows.NIGHTLY)[0]

    def errors_for(self, pr: dict, nightly: dict, measurement: Path | None = None) -> list[str]:
        errors: list[str] = []
        if measurement is None:
            check_workflows.check_absolute_gates(pr, nightly, errors)
        else:
            check_workflows.check_absolute_gates(pr, nightly, errors, measurement_path=measurement)
        return errors

    def step(self, pr: dict, job: str, needle: str) -> dict:
        return next(step for step in pr["jobs"][job]["steps"] if needle in str(step.get("run", "")))

    def test_repository_workflows_carry_the_absolute_gates(self):
        self.assertEqual(self.errors_for(*self.workflows()), [])

    def test_report_only_tiers_come_from_the_measurement_record(self):
        tiers = check_workflows.report_only_outs(check_workflows.MEASUREMENT)
        self.assertIn("eval/out/smoke", tiers)
        self.assertNotIn("eval/out/smoke-ingest", tiers)

    def test_an_ungated_smoke_step_is_reported(self):
        pr, nightly = self.workflows()
        self.step(pr, "eval-smoke", "--fixture-mode ingest --out eval/out/smoke-ingest")["run"] += " --no-gate"
        self.assertTrue(any("--no-gate" in e for e in self.errors_for(pr, nightly)))

    def test_report_mode_on_an_enforced_tier_is_reported(self):
        pr, nightly = self.workflows()
        self.step(pr, "eval-smoke", "--fixture-mode ingest --out eval/out/smoke-ingest")["run"] += " --gates-mode report"
        errors = self.errors_for(pr, nightly)
        self.assertTrue(any("eval/out/smoke-ingest" in e and "report" in e for e in errors), errors)

    def test_report_mode_on_the_prompt_control_is_reported(self):
        pr, nightly = self.workflows()
        step = self.step(pr, "gate-negative-control", "no-refusal-directive.overlay.json")
        step["run"] = step["run"].replace("--out eval/out/negative-prompt", "--out eval/out/negative-prompt --gates-mode report")
        self.assertTrue(any("eval/out/negative-prompt" in e for e in self.errors_for(pr, nightly)))

    def test_another_gates_file_is_reported(self):
        pr, nightly = self.workflows()
        self.step(pr, "eval-smoke", "npm run test-rag -- --out eval/out/smoke")["run"] += " --gates eval/out/lax-gates.json"
        self.assertTrue(any("quality-gates.json" in e for e in self.errors_for(pr, nightly)))

    def test_a_missing_prompt_control_is_reported(self):
        pr, nightly = self.workflows()
        job = pr["jobs"]["gate-negative-control"]
        job["steps"] = [step for step in job["steps"] if "no-refusal-directive.overlay.json" not in str(step.get("run", ""))]
        self.assertTrue(any("-eq 11" in e for e in self.errors_for(pr, nightly)))

    def test_a_prompt_control_without_exit_11_is_reported(self):
        pr, nightly = self.workflows()
        step = self.step(pr, "gate-negative-control", "no-refusal-directive.overlay.json")
        step["run"] = step["run"].replace('-eq 11', '-eq 10')
        self.assertTrue(any("-eq 11" in e for e in self.errors_for(pr, nightly)))

    def test_a_prompt_control_without_the_false_answer_check_is_reported(self):
        pr, nightly = self.workflows()
        step = self.step(pr, "gate-negative-control", "no-refusal-directive.overlay.json")
        step["run"] = "\n".join(line for line in step["run"].splitlines() if "false_answer_rate" not in line)
        self.assertTrue(any("false_answer_rate" in e for e in self.errors_for(pr, nightly)))

    def test_the_two_regression_controls_stay_required(self):
        pr, nightly = self.workflows()
        step = self.step(pr, "gate-negative-control", "--max-results 1")
        step["run"] = step["run"].replace('test "$code" -eq 10', 'test "$code" -ne 0')
        self.assertTrue(any("-eq 10" in e for e in self.errors_for(pr, nightly)))

    def test_a_python_job_without_the_manifest_verify_is_reported(self):
        for manifest in ("eval/fixtures/golden.manifest.json", "eval/fixtures/ingest/golden-ingest.manifest.json"):
            pr, nightly = self.workflows()
            job = pr["jobs"]["python"]
            for step in job["steps"]:
                if "golden_set verify" in str(step.get("run", "")):
                    step["run"] = "\n".join(line for line in step["run"].splitlines() if manifest not in line)
            self.assertTrue(any(manifest in e for e in self.errors_for(pr, nightly)), manifest)

    def test_a_judge_job_without_the_absolute_gate_is_reported(self):
        pr, nightly = self.workflows()
        job = nightly["jobs"]["judge"]
        job["steps"] = [step for step in job["steps"] if "rag_eval.absolute_gate" not in str(step.get("run", ""))]
        self.assertTrue(any("absolute_gate" in e for e in self.errors_for(pr, nightly)))

    def test_an_absolute_gate_step_without_the_keys_condition_is_reported(self):
        pr, nightly = self.workflows()
        step = self.step(nightly, "judge", "rag_eval.absolute_gate")
        step.pop("if", None)
        self.assertTrue(any("HAS_JUDGE_KEYS" in e for e in self.errors_for(pr, nightly)))

    def test_an_enforced_nightly_absolute_gate_is_reported(self):
        pr, nightly = self.workflows()
        step = self.step(nightly, "judge", "rag_eval.absolute_gate")
        step["run"] = step["run"].replace("--mode report", "--mode enforce")
        self.assertTrue(any("--mode report" in e for e in self.errors_for(pr, nightly)))

    def test_a_judge_job_without_the_stale_scan_is_reported(self):
        pr, nightly = self.workflows()
        job = nightly["jobs"]["judge"]
        job["steps"] = [step for step in job["steps"] if "stale-scan" not in str(step.get("run", ""))]
        self.assertTrue(any("stale-scan" in e for e in self.errors_for(pr, nightly)))

    def test_the_nightly_absolute_result_must_be_uploaded(self):
        pr, nightly = self.workflows()
        for step in nightly["jobs"]["judge"]["steps"]:
            if str(step.get("uses", "")).startswith("actions/upload-artifact@"):
                step["with"]["path"] = "eval/out/nightly/judge.json"
        self.assertTrue(any("absolute.json" in e for e in self.errors_for(pr, nightly)))

    def test_a_missing_or_unreadable_measurement_is_an_error(self):
        pr, nightly = self.workflows()
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "absent.json"
            self.assertTrue(any("absolute-gate-measurement" in e or "absent.json" in e for e in self.errors_for(pr, nightly, missing)))
            broken = Path(tmp) / "broken.json"
            broken.write_text("{not json", encoding="utf-8")
            self.assertTrue(any("broken.json" in e for e in self.errors_for(pr, nightly, broken)))


class ReleaseGateWorkflowTest(unittest.TestCase):
    """D-33, D-36, research F-3: one failing example per rule of check_release_gate."""

    def workflow(self) -> dict:
        import copy

        import yaml

        data = yaml.safe_load(check_workflows.RELEASE_GATE.read_text(encoding="utf-8"))
        return copy.deepcopy(data)

    def known_refs(self) -> set[str]:
        refs: set[str] = set()
        for path in (check_workflows.PR, check_workflows.NIGHTLY):
            refs.update(check_workflows.uses_refs(check_workflows.load(path)[0]))
        return refs

    def errors_for(self, data: dict, text: str | None = None) -> list[str]:
        import yaml

        errors: list[str] = []
        check_workflows.check_release_gate(data, text if text is not None else yaml.safe_dump(data), errors, self.known_refs())
        return errors

    def on(self, data: dict) -> dict:
        return data["on"] if "on" in data else data[True]

    def steps(self, data: dict) -> list[dict]:
        return data["jobs"]["gate"]["steps"]

    def step(self, data: dict, needle: str) -> dict:
        return next(s for s in self.steps(data) if needle in str(s.get("run", "")))

    def assert_error(self, data: dict, fragment: str, text: str | None = None) -> None:
        errors = self.errors_for(data, text)
        self.assertTrue(any(fragment in e for e in errors), f"no error containing {fragment!r} in {errors}")

    def test_repository_workflow_passes(self):
        text = check_workflows.RELEASE_GATE.read_text(encoding="utf-8")
        errors: list[str] = []
        check_workflows.check_release_gate(self.workflow(), text, errors, self.known_refs())
        self.assertEqual(errors, [])

    def test_top_level_statuses_write_fails(self):
        data = self.workflow()
        data["permissions"] = {"contents": "read", "statuses": "write"}
        self.assert_error(data, "top-level permissions")

    def test_job_named_like_the_status_fails(self):
        data = self.workflow()
        data["jobs"]["rag-release-gate"] = data["jobs"].pop("gate")
        self.assert_error(data, "no job may be named rag-release-gate")
        data = self.workflow()
        data["jobs"]["gate"]["name"] = "rag-release-gate"
        self.assert_error(data, "no job may be named rag-release-gate")

    def test_job_permissions_beyond_the_gate_set_fail(self):
        data = self.workflow()
        data["jobs"]["gate"]["permissions"]["contents"] = "write"
        self.assert_error(data, "permissions must be exactly")

    def test_pull_request_triggers_fail(self):
        for trigger in ("pull_request", "pull_request_target"):
            data = self.workflow()
            self.on(data)[trigger] = {"branches": ["main"]}
            self.assert_error(data, f"trigger '{trigger}' must not be used")

    def test_push_to_another_branch_fails(self):
        data = self.workflow()
        self.on(data)["push"] = {"branches": ["main", "feature"]}
        self.assert_error(data, "push must trigger on branches [main] only")
        data = self.workflow()
        self.on(data)["push"] = {"branches": ["main"], "tags": ["v*"]}
        self.assert_error(data, "push must trigger on branches [main] only")

    def test_dispatch_inputs_are_required(self):
        data = self.workflow()
        self.on(data)["workflow_dispatch"]["inputs"]["sha"]["required"] = False
        self.assert_error(data, "required 'sha' input")
        data = self.workflow()
        del self.on(data)["workflow_dispatch"]["inputs"]["override_reason"]
        self.assert_error(data, "optional 'override_reason' input")

    def test_inputs_inside_run_fail(self):
        for expr in ("${{ inputs.sha }}", "${{ inputs.override_reason }}", "${{ github.event.inputs.sha }}"):
            data = self.workflow()
            self.step(data, "rag_eval.release_gate run")["run"] = f"uv run --directory eval python -m rag_eval.release_gate run --sha {expr}"
            self.assert_error(data, "only through env")

    def test_secret_inside_run_fails(self):
        data = self.workflow()
        self.step(data, "rag_eval.release_gate run")["run"] += " --key ${{ secrets.OPENAI_API_KEY }}"
        self.assert_error(data, "not interpolated into run")

    def test_missing_sha_validation_fails(self):
        data = self.workflow()
        self.steps(data).pop(0)
        self.assert_error(data, "must check GATE_SHA")

    def test_no_pending_post_before_the_gate_fails(self):
        data = self.workflow()
        steps = self.steps(data)
        pending = next(s for s in steps if "state=pending" in str(s.get("run", "")))
        steps.remove(pending)
        self.assert_error(data, "pending rag-release-gate status must be posted before")
        data = self.workflow()
        steps = self.steps(data)
        pending = next(s for s in steps if "state=pending" in str(s.get("run", "")))
        steps.remove(pending)
        steps.insert(len(steps) - 1, pending)
        self.assert_error(data, "pending rag-release-gate status must be posted before")

    def test_posting_step_without_always_fails(self):
        data = self.workflow()
        del self.step(data, "post-release-status.mjs")["if"]
        self.assert_error(data, "if: always()")
        data = self.workflow()
        self.step(data, "post-release-status.mjs")["if"] = "success()"
        self.assert_error(data, "if: always()")

    def test_unpinned_or_unknown_action_fails(self):
        data = self.workflow()
        checkout = next(s for s in self.steps(data) if str(s.get("uses", "")).startswith("actions/checkout@"))
        checkout["uses"] = "actions/checkout@v4"
        self.assert_error(data, "pinned to a 40-hex commit sha")
        data = self.workflow()
        self.steps(data).append({"uses": "someone/new-action@" + "c" * 40})
        self.assert_error(data, "not a pinned action already used")
        text = check_workflows.RELEASE_GATE.read_text(encoding="utf-8").replace(" # v4.4.0", "", 1)
        import yaml

        self.assert_error(yaml.safe_load(text), "needs a '# vX.Y.Z' comment", text)

    def test_checkout_must_use_the_gate_sha(self):
        data = self.workflow()
        checkout = next(s for s in self.steps(data) if str(s.get("uses", "")).startswith("actions/checkout@"))
        del checkout["with"]
        self.assert_error(data, "checkout must check out ref")

    def test_override_takes_the_triggering_actor_through_env(self):
        data = self.workflow()
        del self.step(data, "rag_eval.release_gate override")["env"]["TRIGGERING_ACTOR"]
        self.assert_error(data, "github.triggering_actor")
        data = self.workflow()
        self.step(data, "rag_eval.release_gate override")["env"]["TRIGGERING_ACTOR"] = "${{ github.actor }}"
        self.assert_error(data, "github.triggering_actor")

    def test_judge_keys_reach_the_gate_through_step_env(self):
        data = self.workflow()
        del self.step(data, "rag_eval.release_gate run")["env"]["OPENAI_API_KEY"]
        self.assert_error(data, "receive OPENAI_API_KEY through step env")

    def test_concurrency_must_not_cancel(self):
        data = self.workflow()
        data["concurrency"]["cancel-in-progress"] = True
        self.assert_error(data, "cancel-in-progress false")


class PrSmokeAggregateTest(unittest.TestCase):
    """D-37: one aggregate pr-smoke job that only real success satisfies, run on trunk and main pushes."""

    def workflow(self) -> dict:
        import yaml

        return yaml.safe_load(check_workflows.PR.read_text(encoding="utf-8"))

    def errors_for(self, data: dict) -> list[str]:
        import yaml

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pr-smoke.yml"
            path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
            original = check_workflows.PR
            check_workflows.PR = path
            try:
                errors: list[str] = []
                check_workflows.check_pr_aggregate(check_workflows.load(path)[0], errors)
                return errors
            finally:
                check_workflows.PR = original

    def on(self, data: dict) -> dict:
        return data["on"] if "on" in data else data[True]

    def aggregate(self, data: dict) -> dict:
        return data["jobs"][check_workflows.AGGREGATE_JOB]

    def assert_error(self, data: dict, fragment: str) -> None:
        errors = self.errors_for(data)
        self.assertTrue(any(fragment in e for e in errors), f"no error containing {fragment!r} in {errors}")

    def test_repository_workflow_passes(self):
        self.assertEqual(self.errors_for(self.workflow()), [])

    def test_the_aggregate_is_a_checked_pr_job(self):
        self.assertIn(check_workflows.AGGREGATE_JOB, check_workflows.PR_JOBS)

    def test_missing_aggregate_fails(self):
        data = self.workflow()
        del data["jobs"][check_workflows.AGGREGATE_JOB]
        self.assert_error(data, "job 'pr-smoke' missing")

    def test_needs_missing_a_job_fails(self):
        data = self.workflow()
        self.aggregate(data)["needs"] = [n for n in self.aggregate(data)["needs"] if n != "docker-build"]
        self.assert_error(data, "needs must list every other job")

    def test_needs_missing_a_newly_added_job_fails(self):
        data = self.workflow()
        data["jobs"]["extra-job"] = {"runs-on": "ubuntu-latest", "steps": [{"run": "true"}]}
        self.assert_error(data, "extra-job")

    def test_without_always_fails(self):
        data = self.workflow()
        del self.aggregate(data)["if"]
        self.assert_error(data, "if: always()")
        data = self.workflow()
        self.aggregate(data)["if"] = "success()"
        self.assert_error(data, "if: always()")

    def test_a_step_accepting_skipped_fails(self):
        data = self.workflow()
        step = self.aggregate(data)["steps"][0]
        step["run"] = 'for r in $RESULTS; do case "$r" in success|skipped) ;; *) exit 1;; esac; done'
        self.assert_error(data, "skipped")

    def test_results_must_come_from_needs_through_env(self):
        data = self.workflow()
        self.aggregate(data)["steps"][0]["env"] = {"RESULTS": "success"}
        self.assert_error(data, "join(needs.*.result")

    def test_push_without_the_trunk_branch_fails(self):
        data = self.workflow()
        self.on(data)["push"] = {"branches": ["main"]}
        self.assert_error(data, "claude/ecstatic-hamilton-86gtwv")
        data = self.workflow()
        self.on(data)["push"] = {"branches": [check_workflows.TRUNK_BRANCH]}
        self.assert_error(data, "'main'")

    def test_a_secret_in_the_aggregate_fails(self):
        data = self.workflow()
        self.aggregate(data)["steps"][0]["env"]["TOKEN"] = "${{ secrets.GITHUB_TOKEN }}"
        self.assert_error(data, "secrets.")

    def run_loop(self, results: str) -> int:
        import subprocess

        step = self.aggregate(self.workflow())["steps"][0]
        proc = subprocess.run(["bash", "-c", step["run"]], env={"RESULTS": results, "PATH": "/usr/bin:/bin"}, capture_output=True, text=True)
        return proc.returncode

    def test_the_loop_rejects_a_skipped_job(self):
        self.assertNotEqual(self.run_loop("success success skipped"), 0)

    def test_the_loop_rejects_failure_and_cancelled(self):
        self.assertNotEqual(self.run_loop("success failure"), 0)
        self.assertNotEqual(self.run_loop("cancelled success"), 0)

    def test_the_loop_rejects_no_results(self):
        self.assertNotEqual(self.run_loop(""), 0)

    def test_the_loop_accepts_only_success(self):
        self.assertEqual(self.run_loop("success"), 0)
        self.assertEqual(self.run_loop("success success success"), 0)


class PromoteProductionWorkflowTest(unittest.TestCase):
    """D-35, O-5: one failing example per rule of check_promote_production."""

    def workflow(self) -> dict:
        import yaml

        return yaml.safe_load(check_workflows.PROMOTE.read_text(encoding="utf-8"))

    def known_refs(self) -> set[str]:
        refs: set[str] = set()
        for path in (check_workflows.PR, check_workflows.NIGHTLY):
            refs.update(check_workflows.uses_refs(check_workflows.load(path)[0]))
        return refs

    def errors_for(self, data: dict, text: str | None = None) -> list[str]:
        import yaml

        errors: list[str] = []
        check_workflows.check_promote_production(data, text if text is not None else yaml.safe_dump(data), errors, self.known_refs())
        return errors

    def on(self, data: dict) -> dict:
        return data["on"] if "on" in data else data[True]

    def job(self, data: dict) -> dict:
        return data["jobs"]["promote"]

    def step(self, data: dict) -> dict:
        return next(s for s in self.job(data)["steps"] if "promote-production.mjs" in str(s.get("run", "")))

    def assert_error(self, data: dict, fragment: str) -> None:
        errors = self.errors_for(data)
        self.assertTrue(any(fragment in e for e in errors), f"no error containing {fragment!r} in {errors}")

    def test_repository_workflow_passes(self):
        text = check_workflows.PROMOTE.read_text(encoding="utf-8")
        errors: list[str] = []
        check_workflows.check_promote_production(self.workflow(), text, errors, self.known_refs())
        self.assertEqual(errors, [])

    def test_a_push_trigger_fails(self):
        data = self.workflow()
        self.on(data)["push"] = {"branches": ["main"]}
        self.assert_error(data, "workflow_dispatch only")

    def test_other_triggers_fail(self):
        for trigger in ("pull_request", "schedule", "workflow_run"):
            data = self.workflow()
            self.on(data)[trigger] = {}
            self.assert_error(data, "workflow_dispatch only")

    def test_sha_input_is_required_and_alone(self):
        data = self.workflow()
        self.on(data)["workflow_dispatch"]["inputs"]["sha"]["required"] = False
        self.assert_error(data, "required 'sha' input")
        data = self.workflow()
        self.on(data)["workflow_dispatch"]["inputs"]["force"] = {"type": "boolean"}
        self.assert_error(data, "unexpected workflow_dispatch inputs")

    def test_inputs_sha_inside_run_fails(self):
        data = self.workflow()
        self.step(data)["run"] = "node scripts/ci/promote-production.mjs --sha ${{ inputs.sha }}"
        self.assert_error(data, "only through env")

    def test_a_secret_inside_run_fails(self):
        data = self.workflow()
        self.step(data)["run"] += " && echo ${{ secrets.VERCEL_TOKEN }}"
        self.assert_error(data, "not interpolated into run")

    def test_a_write_permission_fails(self):
        data = self.workflow()
        self.job(data)["permissions"]["statuses"] = "write"
        self.assert_error(data, "permissions must be exactly")
        data = self.workflow()
        self.job(data)["permissions"]["contents"] = "write"
        self.assert_error(data, "permissions must be exactly")
        data = self.workflow()
        data["permissions"] = {"contents": "write"}
        self.assert_error(data, "top-level permissions")

    def test_env_must_carry_the_sha_and_the_vercel_settings(self):
        for key in ("PROMOTE_SHA", "GH_TOKEN", "VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"):
            data = self.workflow()
            del self.step(data)["env"][key]
            self.assert_error(data, key)
        data = self.workflow()
        self.step(data)["env"]["PROMOTE_SHA"] = "${{ github.sha }}"
        self.assert_error(data, "PROMOTE_SHA")

    def test_the_promote_command_is_required(self):
        data = self.workflow()
        self.step(data)["run"] = "echo nothing"
        self.assert_error(data, "no step runs")

    def test_checkout_of_the_promoted_sha_fails(self):
        data = self.workflow()
        checkout = next(s for s in self.job(data)["steps"] if str(s.get("uses", "")).startswith("actions/checkout@"))
        checkout.setdefault("with", {})["ref"] = "${{ inputs.sha }}"
        self.assert_error(data, "must not check out")

    def test_an_unknown_action_fails(self):
        data = self.workflow()
        self.job(data)["steps"].append({"uses": "someone/new-action@" + "d" * 40})
        self.assert_error(data, "not a pinned action already used")

    def test_concurrency_must_not_cancel(self):
        data = self.workflow()
        data["concurrency"]["cancel-in-progress"] = True
        self.assert_error(data, "cancel-in-progress false")
