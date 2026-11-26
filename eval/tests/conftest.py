from _finetune_guard import pytest_runtest_makereport, set_offline

set_offline()

import pytest  # noqa: E402
from _private_runs import make_private_root  # noqa: E402


@pytest.fixture
def private_runs_root(tmp_path, monkeypatch):
    return make_private_root(tmp_path, monkeypatch)


__all__ = ["pytest_runtest_makereport"]
