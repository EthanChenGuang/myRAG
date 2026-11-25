# Hugging Face Space build of the sidecar's `runtime` stage (rag-sidecar/Dockerfile): same base image, uv and
# dependencies, no Docling, HHEM or Prompt Guard. Spaces build one Dockerfile from the Space root and run the
# container as UID 1000, so the user here is 1000 and the build uses plain COPY instead of cache mounts.
# scripts/ci/check-workflows.py fails when the base image or uv pin drifts from rag-sidecar/Dockerfile.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_NO_DEV=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/sidecar \
    TMPDIR=/tmp \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project --no-dev

COPY src ./src
COPY config ./config
RUN uv sync --locked --no-dev

RUN useradd --uid 1000 --create-home --home-dir /home/sidecar --shell /usr/sbin/nologin sidecar \
    && chown -R 1000:1000 /app /home/sidecar \
    && chmod 1777 /tmp \
    && test -f /app/config/rag/parse-routing.json \
    && test -f /app/config/rag/processing-profiles.json

USER 1000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"]

CMD ["/app/.venv/bin/uvicorn", "rag_sidecar.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
