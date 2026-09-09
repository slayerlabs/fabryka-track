FROM ghcr.io/astral-sh/uv:0.12.3 AS uv

FROM python:3.12-slim-bookworm AS build
COPY --from=uv /uv /uvx /bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --locked --no-dev --no-editable --extra postgres --extra r2 --extra eval

FROM python:3.12-slim-bookworm AS final
WORKDIR /app
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY --from=build /app/.venv /app/.venv

EXPOSE 8130
CMD ["uvicorn", "fabryka_track.api:app", "--host", "0.0.0.0", "--port", "8130", "--workers", "1"]
