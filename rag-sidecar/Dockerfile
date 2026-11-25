# Production deploys build `--target docling` once Docling parsing is wanted, or `--target hhem` for local
# English groundedness scoring; the default target (the last stage, `runtime`) stays slim so
# `docker build -t rag-sidecar:ci rag-sidecar` is small.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS docling

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_NO_DEV=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH" \
    HF_HOME=/opt/hf \
    TIKTOKEN_CACHE_DIR=/opt/tiktoken \
    RAG_SIDECAR_DOCLING_ARTIFACTS=/opt/docling-models

WORKDIR /app

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev --extra docling

COPY pyproject.toml uv.lock ./
COPY src ./src

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --extra docling

RUN mkdir -p "$HF_HOME" "$TIKTOKEN_CACHE_DIR" "$RAG_SIDECAR_DOCLING_ARTIFACTS" \
    && docling-tools models download -o "$RAG_SIDECAR_DOCLING_ARTIFACTS" \
    && python -c "import tiktoken; tiktoken.get_encoding('cl100k_base')" \
    && chmod -R a+rX /opt/hf /opt/tiktoken /opt/docling-models

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin sidecar \
    && chown -R sidecar /app

USER 10001

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"]

CMD ["/app/.venv/bin/uvicorn", "rag_sidecar.main:app", "--host", "0.0.0.0", "--port", "8000"]

FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS hhem

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_NO_DEV=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH" \
    HF_HOME=/opt/hf

WORKDIR /app

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev --extra hhem

COPY pyproject.toml uv.lock ./
COPY src ./src

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --extra hhem

# The only networked step: pinned downloads, sha256 checks, then one offline load (fails the build on any mismatch).
RUN mkdir -p "$HF_HOME" && python -m rag_sidecar.groundedness.bake

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin sidecar \
    && chown -R sidecar /app \
    && chown -R 10001 "$HF_HOME"

USER 10001

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"]

CMD ["/app/.venv/bin/uvicorn", "rag_sidecar.main:app", "--host", "0.0.0.0", "--port", "8000"]

FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS runtime

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_NO_DEV=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

COPY pyproject.toml uv.lock ./
COPY src ./src

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin sidecar \
    && chown -R sidecar /app

USER 10001

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"]

CMD ["/app/.venv/bin/uvicorn", "rag_sidecar.main:app", "--host", "0.0.0.0", "--port", "8000"]
