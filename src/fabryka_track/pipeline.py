import base64
import logging
import secrets
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import SecretStr

log = logging.getLogger(__name__)

PIPELINE_ORIGIN = "https://track.fabryka.ai"
PRIVATE_ROOT = Path(__file__).parent / "pipeline_web"
CHALLENGE = 'Basic realm="Pipeline Upload", charset="UTF-8"'
PRIVATE_HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY"}


@dataclass
class PipelineConfig:
    username: str
    password: SecretStr
    controller_url: str
    origin: str
    private_root: Path

    @property
    def enabled(self) -> bool:
        controller = urlsplit(self.controller_url)
        return bool(self.username and ":" not in self.username and self.password.get_secret_value()
                    and controller.scheme == "https" and controller.hostname and not controller.username
                    and not controller.password and not controller.query and not controller.fragment)


def config_from_settings(settings) -> PipelineConfig:
    config = PipelineConfig(username=settings.pipeline_username or "",
                            password=settings.pipeline_password or SecretStr(""),
                            controller_url=settings.pipeline_controller_url,
                            origin=PIPELINE_ORIGIN, private_root=PRIVATE_ROOT)
    if not config.enabled:
        log.warning("Private pipeline upload is disabled: Basic pair or HTTPS controller URL is not configured.")
    return config


def controller_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=10)


def _is_private(path: str) -> bool:
    return path == "/pipeline" or path.startswith("/pipeline/")


def check_private_basic(request: Request, config: PipelineConfig) -> None:
    try:
        scheme, encoded = request.headers.get("authorization", "").split(" ", 1)
        username, password = base64.b64decode(encoded.strip(), validate=True).decode("utf-8").split(":", 1)
    except (ValueError, UnicodeError):
        raise PermissionError("unauthorized") from None
    # Evaluate both digests so a wrong username takes as long as a wrong password.
    username_ok = secrets.compare_digest(username.encode(), config.username.encode())
    password_ok = secrets.compare_digest(password.encode(), config.password.get_secret_value().encode())
    if not (scheme.lower() == "basic" and config.enabled and username_ok and password_ok):
        raise PermissionError("unauthorized")


def _denial(path: str, status: int, code: str, message: str, retryable: bool, headers: dict) -> JSONResponse:
    body = ({"protocol": "upload-control-v1", "request_id": str(uuid4()), "code": code,
             "message": message, "retryable": retryable}
            if path.startswith("/pipeline/api/") else {"detail": message})
    return JSONResponse(body, status_code=status, headers={**headers, **PRIVATE_HEADERS})


def install_private_boundary(app: FastAPI, config: PipelineConfig) -> None:
    @app.middleware("http")
    async def private_boundary(request: Request, call_next):
        path = request.url.path
        if not _is_private(path):
            return await call_next(request)
        if not config.enabled:
            return _denial(path, 503, "provider_unavailable", "Pipeline upload is not configured", False, {})
        try:
            check_private_basic(request, config)
        except PermissionError:
            return _denial(path, 401, "unauthorized", "Authentication required", False,
                           {"WWW-Authenticate": CHALLENGE})
        response = await call_next(request)
        response.headers.update(PRIVATE_HEADERS)
        return response


def _servable(root: Path, relative: str) -> Path | None:
    parts = relative.split("/")
    if (len(parts) < 2 or parts[0] != "assets" or any(not p or p.startswith(".") for p in parts)
            or relative.endswith(".map") or "\\" in relative):
        return None
    base = root.resolve()
    target = (root / relative).resolve()
    if not target.is_relative_to(base) or not target.is_file():
        return None
    return target


def make_pipeline_router(config: PipelineConfig, client: httpx.AsyncClient) -> APIRouter:
    router = APIRouter(include_in_schema=False)

    @router.api_route("/pipeline", methods=["GET", "HEAD"])
    def pipeline_slash():
        return RedirectResponse("/pipeline/", status_code=308)

    @router.api_route("/pipeline/", methods=["GET", "HEAD"])
    def pipeline_index():
        entry = config.private_root / "index.html"
        if not entry.is_file():
            return JSONResponse({"detail": "Private build missing."}, status_code=503)
        return FileResponse(entry, media_type="text/html; charset=utf-8")

    @router.api_route("/pipeline/{relative:path}", methods=["GET", "HEAD"])
    def pipeline_asset(relative: str):
        target = _servable(config.private_root, relative)
        if target is None:
            return JSONResponse({"detail": "Not found"}, status_code=404)
        return FileResponse(target)

    return router


def pipeline_app(config: PipelineConfig, client: httpx.AsyncClient) -> FastAPI:
    app = FastAPI()
    install_private_boundary(app, config)
    app.include_router(make_pipeline_router(config, client))
    return app
