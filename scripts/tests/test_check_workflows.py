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


if __name__ == "__main__":
    unittest.main()
