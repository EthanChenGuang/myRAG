import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "ci" / "check-workflows.py"
spec = importlib.util.spec_from_file_location("check_workflows", MODULE_PATH)
check_workflows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_workflows)


def workflow(run: str) -> dict:
    return {"jobs": {"ts": {"steps": [{"run": run}]}}}


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


if __name__ == "__main__":
    unittest.main()
