"""Gates section of the weekly report (Phase 5.3 D-17, D-36, D-50). Stub; implemented in the next commit."""

from dataclasses import dataclass, field

from rag_sidecar.contracts.config_change import WeeklyGatesSection

EXIT_OK, EXIT_INPUT, EXIT_PRIVATE = 0, 2, 6
GITHUB_NOT_READ = "GitHub was not read"
SET_MANIFEST_NAME = "golden.manifest.json"


@dataclass(frozen=True)
class GithubSource:
    repository: str
    token: str


@dataclass(frozen=True)
class GatesCollection:
    section: WeeklyGatesSection
    not_read: dict[str, str] = field(default_factory=dict)
    release_sources: tuple[str, ...] = ()
    overdue_by_set: dict[str, int] = field(default_factory=dict)


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def collect_gates_section(since, base_url, token, github, set_dirs, **_kwargs) -> GatesCollection:
    return GatesCollection(section=WeeklyGatesSection())


def collection_payload(result: GatesCollection) -> dict:
    return {}


def render_gates_markdown(result: GatesCollection) -> str:
    return ""


def main(argv=None) -> int:
    return EXIT_INPUT
