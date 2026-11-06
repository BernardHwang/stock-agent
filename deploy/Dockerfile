# Multi-arch (works on Oracle's free ARM VM). Build from the repo root:
#   docker build -f deploy/Dockerfile -t stockagent .
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev
COPY config ./config

RUN useradd --create-home app && mkdir -p /app/data /home/app/.tradingagents \
    && chown -R app /app/data /home/app/.tradingagents
USER app
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1

CMD ["python", "-m", "stockagent"]
