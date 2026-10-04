import base64
import json
import logging
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import SecretStr
from starlette._utils import get_route_path

log = logging.getLogger(__name__)

PIPELINE_ORIGIN = "https://track.fabryka.ai"
PRIVATE_ROOT = Path(__file__).parent / "pipeline_web"
CHALLENGE = 'Basic realm="Pipeline Upload", charset="UTF-8"'
PRIVATE_HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY"}
PROTOCOL = "upload-control-v1"
MAX_REQUEST_BODY = 65536
# JobReport bodies may reach the 1 MiB report limit; the margin covers the JSON envelope.
MAX_RESPONSE_BODY = 1048576 + 65536
API_PREFIX = "/pipeline/api/"
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
ROUTES = [(verb, re.compile(pattern)) for verb, pattern in [
    ("GET", r"jobs"), ("POST", r"jobs"),
    ("GET", rf"jobs/{UUID}"),
    ("POST", rf"jobs/{UUID}/parts"),
    ("POST", rf"jobs/{UUID}/confirm"),
    ("POST", rf"jobs/{UUID}/cancel"),
    ("GET", rf"jobs/{UUID}/report"),
    ("GET", rf"jobs/{UUID}/result"), ("HEAD", rf"jobs/{UUID}/result"),
]]
ROUTED_METHODS = ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE")
LIMIT = re.compile(r"[0-9]{1,3}")
CURSOR = re.compile(r"[A-Za-z0-9_-]{1,256}")
DIGITS = re.compile(r"[0-9]{1,12}")
# Only a POST has had its browser metadata checked exactly, so only a POST forwards it.
FORWARDED_REQUEST_HEADERS = {
    "GET": ("authorization", "idempotency-key", "x-pipeline-request"),
    "HEAD": ("authorization", "idempotency-key", "x-pipeline-request"),
    "POST": ("authorization", "content-type", "idempotency-key", "x-pipeline-request", "origin", "sec-fetch-site"),
}
HEADER_VALUE = re.compile(r"[\x20-\x7e]{1,1024}")
FORWARDED_RESPONSE_HEADERS = ("content-type", "www-authenticate", "retry-after", "allow")
MESSAGES = {
    "invalid_request": "The request does not match the contract.",
    "unsupported_version": "The protocol version is not supported.",
    "idempotency_key_required": "An Idempotency-Key header is required.",
    "idempotency_conflict": "The Idempotency-Key was used with a different body.",
    "not_found": "Not found.",
    "method_not_allowed": "Method not allowed.",
    "unauthorized": "Authentication is required.",
    "forbidden_origin": "The request origin is not allowed.",
    "quota_exceeded": "Upload capacity is exhausted.",
    "transfer_not_ready": "The transfer is not ready yet.",
    "expired": "The resource has expired.",
    "stale_attempt": "The attempt is no longer current.",
    "lease_expired": "The attempt lease has expired.",
    "integrity_mismatch": "The content does not match its declared integrity.",
    "report_pending": "The report is not available yet.",
    "result_pending": "The result is not available yet.",
    "diagnostic_required": "This result is diagnostic; request it with diagnostic=true.",
    "no_result": "This job has no result.",
    "provider_unavailable": "A dependency is temporarily unavailable.",
    "invalid_state": "The operation is not valid in the current state.",
    "body_too_large": "The request body is too large.",
}
STATUS = {"invalid_request": 422, "not_found": 404, "method_not_allowed": 405, "forbidden_origin": 403,
          "body_too_large": 413}


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


def slash_redirect() -> Response:
    return Response(status_code=308, headers={"Location": "/pipeline/", **PRIVATE_HEADERS})


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


class RouteError(ValueError):
    def __init__(self, code: str, allow: tuple[str, ...] = ()):
        super().__init__(code)
        self.code = code
        self.allow = allow


def control_error(status: int, code: str, retryable: bool = False, headers: dict | None = None) -> JSONResponse:
    extra = dict(headers or {})
    if status in (429, 503):
        extra["Retry-After"] = "5"
    body = {"protocol": PROTOCOL, "request_id": str(uuid4()), "code": code, "message": MESSAGES[code],
            "retryable": retryable or status in (429, 503)}
    return JSONResponse(body, status_code=status, headers={**extra, **PRIVATE_HEADERS})


def _denial(path: str, status: int, code: str, message: str, retryable: bool, headers: dict) -> JSONResponse:
    if path.startswith(API_PREFIX):
        return control_error(status, code, retryable, headers)
    return JSONResponse({"detail": message}, status_code=status, headers={**headers, **PRIVATE_HEADERS})


def route_error(exc: RouteError) -> JSONResponse:
    headers = {"Allow": ", ".join(exc.allow)} if exc.allow else {}
    return control_error(STATUS[exc.code], exc.code, headers=headers)


def normalize_route(raw_path: bytes, method: str) -> str:
    try:
        path = raw_path.decode("ascii")
    except UnicodeDecodeError:
        raise RouteError("invalid_request") from None
    if not path.startswith(API_PREFIX):
        raise RouteError("not_found")
    # Never decode a second time: any escape, separator run or dot segment is refused outright.
    if "%" in path or "//" in path or "\\" in path or any(p in {".", ".."} for p in path.split("/")):
        raise RouteError("invalid_request")
    relative = path[len(API_PREFIX):]
    allowed = tuple(verb for verb, pattern in ROUTES if pattern.fullmatch(relative))
    if not allowed:
        raise RouteError("not_found")
    if method not in allowed:
        raise RouteError("method_not_allowed", allowed)
    return "/uploads/v1/" + relative


def _query(route: str, method: str, raw: bytes) -> str:
    if not raw:
        return ""
    try:
        pairs = [item.split("=", 1) for item in raw.decode("ascii").split("&")]
    except UnicodeDecodeError:
        raise RouteError("invalid_request") from None
    if any(len(pair) != 2 for pair in pairs) or len({k for k, _ in pairs}) != len(pairs):
        raise RouteError("invalid_request")
    params = dict(pairs)
    if route == "/uploads/v1/jobs" and method == "GET":
        limit, cursor = params.pop("limit", None), params.pop("cursor", None)
        if limit is not None and not (LIMIT.fullmatch(limit) and 1 <= int(limit) <= 100):
            raise RouteError("invalid_request")
        if cursor is not None and not CURSOR.fullmatch(cursor):
            raise RouteError("invalid_request")
        kept = [("limit", limit), ("cursor", cursor)]
    elif route.endswith("/result"):
        diagnostic = params.pop("diagnostic", None)
        if diagnostic not in (None, "true", "false"):
            raise RouteError("invalid_request")
        kept = [("diagnostic", diagnostic)]
    else:
        kept = []
    if params:
        raise RouteError("invalid_request")
    return "&".join(f"{k}={v}" for k, v in kept if v is not None)


def check_browser_mutation(request: Request, config: PipelineConfig) -> None:
    # Browsers replay cached Basic credentials cross-site, so Basic alone never authorizes a mutation.
    if (request.headers.getlist("x-pipeline-request") != ["1"]
            or request.headers.getlist("origin") != [config.origin]
            or request.headers.getlist("sec-fetch-site") not in ([], ["same-origin"])):
        raise RouteError("forbidden_origin")


def _json_media(value: str | None) -> bool:
    media = (value or "").split(";")
    return media[0].strip().lower() == "application/json" and all(
        part.strip().lower() in ("charset=utf-8", "") for part in media[1:])


async def _read_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and (not DIGITS.fullmatch(declared) or int(declared) > MAX_REQUEST_BODY):
        raise RouteError("body_too_large")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_REQUEST_BODY:
            raise RouteError("body_too_large")
    return bytes(data)


def _valid_error(body) -> bool:
    return (isinstance(body, dict) and set(body) == {"protocol", "request_id", "code", "message", "retryable"}
            and body["protocol"] == PROTOCOL and isinstance(body["request_id"], str)
            and re.fullmatch(UUID, body["request_id"]) is not None and body["code"] in MESSAGES
            and isinstance(body["message"], str) and len(body["message"]) <= 256
            and isinstance(body["retryable"], bool))


def _bad_gateway() -> JSONResponse:
    return control_error(502, "provider_unavailable", True)


async def proxy(request: Request, target: str, client: httpx.AsyncClient) -> Response:
    if not target.startswith("https://"):
        return control_error(503, "provider_unavailable")
    body = await _read_body(request)
    if request.method == "POST":
        if not _json_media(request.headers.get("content-type")):
            raise RouteError("invalid_request")
        try:
            json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise RouteError("invalid_request") from None
    elif body:
        raise RouteError("invalid_request")
    headers = {name: request.headers[name] for name in FORWARDED_REQUEST_HEADERS.get(request.method, ())
               if name in request.headers}
    if not all(HEADER_VALUE.fullmatch(value) for value in headers.values()):
        raise RouteError("invalid_request")
    headers.update({"Accept": "application/json", "Accept-Encoding": "identity"})
    try:
        outbound = client.build_request(request.method, target, headers=headers,
                                        content=body if request.method == "POST" else None)
        upstream = await client.send(outbound, stream=True, follow_redirects=False)
        try:
            if 300 <= upstream.status_code < 400:
                return _bad_gateway()
            data = bytearray()
            async for chunk in upstream.aiter_bytes():
                data.extend(chunk)
                if len(data) > MAX_RESPONSE_BODY:
                    return _bad_gateway()
        finally:
            await upstream.aclose()
    except httpx.HTTPError as exc:
        log.warning("Pipeline controller request failed: %s", type(exc).__name__)
        return control_error(503, "provider_unavailable", True)
    kept = {name: upstream.headers[name] for name in FORWARDED_RESPONSE_HEADERS if name in upstream.headers}
    if request.method == "HEAD":
        return Response(status_code=upstream.status_code, headers={**kept, **PRIVATE_HEADERS})
    if not _json_media(upstream.headers.get("content-type")):
        return _bad_gateway()
    try:
        parsed = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return _bad_gateway()
    if upstream.status_code >= 400 and not _valid_error(parsed):
        return _bad_gateway()
    return Response(bytes(data), status_code=upstream.status_code, headers={**kept, **PRIVATE_HEADERS})


def _upstream_url(config: PipelineConfig, route: str, query: str) -> str:
    controller = urlsplit(config.controller_url)
    base = f"{controller.scheme}://{controller.netloc}{controller.path.rstrip('/')}"
    return base + route + (f"?{query}" if query else "")


def install_private_boundary(app: FastAPI, config: PipelineConfig) -> None:
    @app.middleware("http")
    async def private_boundary(request: Request, call_next):
        # Same root_path-stripped value the router matches on, so a prefixed scope cannot skip the guard.
        path = get_route_path(request.scope)
        if not _is_private(path):
            return await call_next(request)
        if not config.enabled:
            return _denial(path, 503, "provider_unavailable", "Pipeline upload is not configured", False, {})
        if path == "/pipeline":
            # A challenge here would scope the browser's Basic cache to "/", leaking it onto public Track.
            return slash_redirect()
        try:
            check_private_basic(request, config)
        except PermissionError:
            return _denial(path, 401, "unauthorized", "Authentication required", False,
                           {"WWW-Authenticate": CHALLENGE})
        if (path == API_PREFIX.rstrip("/") or path.startswith(API_PREFIX)) and request.method not in ROUTED_METHODS:
            # Methods outside the router's list would otherwise get Starlette's plain 405 with a wrong Allow.
            try:
                normalize_route(request.scope.get("raw_path") or b"", request.method)
            except RouteError as exc:
                return route_error(exc)
        response = await call_next(request)
        response.headers.update(PRIVATE_HEADERS)
        return response


def _servable(root: Path, relative: str) -> Path | None:
    parts = relative.split("/")
    if (len(parts) < 2 or parts[0] != "assets" or any(not p or p.startswith(".") for p in parts)
            or relative.endswith(".map") or "\\" in relative or "\x00" in relative):
        return None
    base = root.resolve()
    target = (root / relative).resolve()
    if not target.is_relative_to(base) or not target.is_file():
        return None
    return target


def make_pipeline_router(config: PipelineConfig,
                         client: httpx.AsyncClient | Callable[[], httpx.AsyncClient]) -> APIRouter:
    def require_basic(request: Request) -> None:
        if not config.enabled:
            raise HTTPException(503, "Pipeline upload is not configured", headers=PRIVATE_HEADERS)
        try:
            check_private_basic(request, config)
        except PermissionError:
            raise HTTPException(401, "Authentication required",
                                headers={"WWW-Authenticate": CHALLENGE, **PRIVATE_HEADERS}) from None

    router = APIRouter(include_in_schema=False, dependencies=[Depends(require_basic)])

    async def pipeline_api(request: Request) -> Response:
        try:
            raw_path = request.scope.get("raw_path")
            if not isinstance(raw_path, bytes):
                raise RouteError("invalid_request")
            route = normalize_route(raw_path, request.method)
            query = _query(route, request.method, request.scope.get("query_string", b""))
            if request.method == "POST":
                check_browser_mutation(request, config)
            active = client() if callable(client) else client
            return await proxy(request, _upstream_url(config, route, query), active)
        except RouteError as exc:
            return route_error(exc)

    router.add_api_route("/pipeline/api", pipeline_api, methods=list(ROUTED_METHODS))
    router.add_api_route("/pipeline/api/{rest:path}", pipeline_api, methods=list(ROUTED_METHODS))

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
