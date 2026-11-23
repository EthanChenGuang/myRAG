import os
import tempfile


def disable_telemetry() -> None:
    os.environ["DEEPEVAL_TELEMETRY_OPT_OUT"] = "1"
    os.environ["DEEPEVAL_UPDATE_WARNING_OPT_IN"] = "0"
    os.environ["RAGAS_DO_NOT_TRACK"] = "true"
    home = os.environ.get("DEEPEVAL_HOME")
    if not home or not os.path.isdir(home):
        os.environ["DEEPEVAL_HOME"] = tempfile.mkdtemp(prefix="deepeval-home-")


def check_no_results_upload() -> None:
    if os.environ.get("CONFIDENT_API_KEY"):
        raise RuntimeError(
            "CONFIDENT_API_KEY is set: refusing to run the judge tier because it would enable "
            "results upload to a hosted service; unset it"
        )
