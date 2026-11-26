"""Session rules for the fine-tune tests, shared by conftest.py and the test that checks them.

Hugging Face hub, datasets and transformers run offline for the whole session (set before any of them is imported), so a
hidden download fails instead of fetching. With FINETUNE_TRAIN_REQUIRED=1 a finetune_train test that would skip (for
example because the finetune extra is missing) fails instead.
"""

import os

import pytest

OFFLINE_VARIABLES = ("HF_HUB_OFFLINE", "HF_DATASETS_OFFLINE", "TRANSFORMERS_OFFLINE")


def set_offline() -> None:
    for name in OFFLINE_VARIABLES:
        os.environ[name] = "1"


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if (
        report.skipped
        and os.environ.get("FINETUNE_TRAIN_REQUIRED") == "1"
        and item.get_closest_marker("finetune_train") is not None
    ):
        report.outcome = "failed"
        report.longrepr = f"finetune_train test {item.nodeid} skipped while FINETUNE_TRAIN_REQUIRED=1"
