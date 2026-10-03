import base64
import json
import logging
import re
from pathlib import Path

import httpx
import pytest
from conftest import PIPELINE_TEST_PAIR
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import SecretStr

from fabryka_track.pipeline import (
    CHALLENGE,
    PIPELINE_ORIGIN,
    PRIVATE_ROOT,
    PipelineConfig,
    _servable,
    config_from_settings,
    pipeline_app,
)
from fabryka_track.settings import Settings

TITLE = "Data Pipeline Upload"
PRIVATE_HEADERS = {"cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY"}


def basic(username, password):
    return {"Authorization": "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()}


AUTH = basic(*PIPELINE_TEST_PAIR)


def config(**overrides):
    values = {"username": PIPELINE_TEST_PAIR[0], "password": SecretStr(PIPELINE_TEST_PAIR[1]),
              "controller_url": "https://data-pipeline.fabryka.ai", "origin": PIPELINE_ORIGIN,
              "private_root": PRIVATE_ROOT}
    return PipelineConfig(**{**values, **overrides})


def no_network():
    return httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(599)))


@pytest.fixture()
def private(private_app):
    return TestClient(private_app, base_url="https://track.fabryka.ai")


def built_assets():
    html = (PRIVATE_ROOT / "index.html").read_text()
    return re.findall(r'(?:src|href)="(/pipeline/assets/[^"]+)"', html)


def assert_denied(response, status=401):
    assert response.status_code == status
    for name, value in PRIVATE_HEADERS.items():
        assert response.headers[name] == value
    assert TITLE not in response.text
    assert "location" not in response.headers
    assert "etag" not in response.headers and "last-modified" not in response.headers
    if status == 401:
        assert response.headers["www-authenticate"] == CHALLENGE


@pytest.mark.parametrize("headers", [
    {}, basic(PIPELINE_TEST_PAIR[0], "wrong"), basic("intruder", PIPELINE_TEST_PAIR[1]), basic("", ""),
    {"Authorization": "Bearer " + base64.b64encode(b"operator:local-test-password").decode()},
    {"Authorization": "Basic not-base64!"}, {"Authorization": "Basic"},
    {"Authorization": "Basic " + base64.b64encode(b"no-colon").decode()},
    {"Authorization": "Basic " + base64.b64encode(b"\xff\xfe:x").decode()},
])
def test_wrong_or_missing_basic_gets_exact_challenge_without_bytes(private, headers):
    for path in ["/pipeline", "/pipeline/", "/pipeline/index.html", "/pipeline/unknown",
                 "/pipeline/.vite/manifest.json", "/pipeline/src/pipeline/main.tsx", *built_assets()]:
        for method in ("GET", "HEAD", "POST", "OPTIONS"):
            assert_denied(private.request(method, path, headers=headers))


def test_conditional_and_range_requests_never_bypass_auth(private):
    for path in ["/pipeline/", *built_assets()]:
        for extra in ({"If-None-Match": "*"}, {"If-Modified-Since": "Thu, 01 Jan 2099 00:00:00 GMT"},
                      {"Range": "bytes=0-10"}, {"If-Range": "x", "Range": "bytes=0-1"}):
            assert_denied(private.get(path, headers=extra))
            assert_denied(private.head(path, headers=extra))


def test_authenticated_operator_gets_private_index_and_actual_assets(private):
    page = private.get("/pipeline/", headers=AUTH)
    assert page.status_code == 200 and TITLE in page.text
    assert page.headers["content-type"].startswith("text/html")
    assert {k: page.headers[k] for k in PRIVATE_HEADERS} == PRIVATE_HEADERS
    assets = built_assets()
    assert any(a.endswith(".js") for a in assets) and any(a.endswith(".css") for a in assets)
    for path in assets:
        for method in ("GET", "HEAD"):
            response = private.request(method, path, headers={**AUTH, "If-None-Match": "*"})
            assert response.status_code == 200, (method, path)
            assert {k: response.headers[k] for k in PRIVATE_HEADERS} == PRIVATE_HEADERS
        assert private.get(path, headers=AUTH).content == (PRIVATE_ROOT / path.removeprefix("/pipeline/")).read_bytes()
    head = private.head("/pipeline/", headers=AUTH)
    assert head.status_code == 200 and head.content == b""


def test_redirect_to_slash_happens_only_after_auth(private):
    assert_denied(private.get("/pipeline", follow_redirects=False))
    response = private.get("/pipeline", headers=AUTH, follow_redirects=False)
    assert response.status_code == 308 and response.headers["location"] == "/pipeline/"


@pytest.mark.parametrize("path", [
    "/pipeline/index.html", "/pipeline/.vite/manifest.json", "/pipeline/src/pipeline/main.tsx",
    "/pipeline/pipeline/index.html", "/pipeline/assets/", "/pipeline/assets/missing.js",
    "/pipeline/assets/.hidden", "/pipeline/unknown", "/pipeline/apix",
    "/pipeline/assets%2F..%2Findex.html", "/pipeline/assets/..%2Findex.html",
])
def test_authenticated_unknown_source_and_alternate_paths_are_404(private, path):
    response = private.get(path, headers=AUTH)
    assert response.status_code == 404
    assert TITLE not in response.text


def test_source_maps_and_dotfiles_are_never_servable(tmp_path):
    (tmp_path / "assets").mkdir()
    for name in ("app.js", "app.js.map", ".secret"):
        (tmp_path / "assets" / name).write_text("x")
    (tmp_path / "index.html").write_text("x")
    (tmp_path / ".vite").mkdir()
    (tmp_path / ".vite" / "manifest.json").write_text("{}")
    assert _servable(tmp_path, "assets/app.js") == (tmp_path / "assets" / "app.js").resolve()
    for relative in ("assets/app.js.map", "assets/.secret", "index.html", ".vite/manifest.json",
                     "assets/../index.html", "assets//app.js", "assets\\app.js", "assets/./app.js"):
        assert _servable(tmp_path, relative) is None, relative


def test_symlink_escaping_private_root_is_not_served(tmp_path):
    outside = tmp_path / "outside.js"
    outside.write_text("leak")
    root = tmp_path / "root"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(f"<title>{TITLE}</title>")
    (root / "assets" / "escape.js").symlink_to(outside)
    (root / "assets" / "dir").symlink_to(tmp_path)
    client = TestClient(pipeline_app(config(private_root=root), no_network()), base_url="https://track.fabryka.ai")
    assert client.get("/pipeline/assets/escape.js", headers=AUTH).status_code == 404
    assert client.get("/pipeline/assets/dir/outside.js", headers=AUTH).status_code == 404
    assert_denied(client.get("/pipeline/assets/escape.js"))


def test_private_api_prefix_denial_uses_error_schema(private):
    response = private.post("/pipeline/api/jobs", json={})
    assert_denied(response)
    body = response.json()
    assert set(body) == {"protocol", "request_id", "code", "message", "retryable"}
    assert body["protocol"] == "upload-control-v1" and body["code"] == "unauthorized"
    assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", body["request_id"])


@pytest.mark.parametrize("overrides", [
    {"username": ""}, {"password": SecretStr("")}, {"username": "a:b"},
    {"controller_url": "http://data-pipeline.fabryka.ai"},
    {"controller_url": "https://user:pw@data-pipeline.fabryka.ai"},
    {"controller_url": "https://data-pipeline.fabryka.ai/?upstream=x"}, {"controller_url": "not a url"},
])
def test_missing_or_invalid_config_fails_closed_with_503(overrides):
    cfg = config(**overrides)
    client = TestClient(pipeline_app(cfg, no_network()), base_url="https://track.fabryka.ai")
    empty = basic(cfg.username, "")
    for headers in ({}, AUTH, empty, basic("", "")):
        for path in ["/pipeline", "/pipeline/", "/pipeline/api/jobs", *built_assets()]:
            assert_denied(client.get(path, headers=headers, follow_redirects=False), status=503)


def test_settings_build_config_with_literal_origin_and_hidden_password(monkeypatch):
    for name in ("FABRYKA_PIPELINE_USERNAME", "FABRYKA_PIPELINE_PASSWORD", "FABRYKA_PIPELINE_CONTROLLER_URL"):
        monkeypatch.delenv(name, raising=False)
    assert not config_from_settings(Settings(_env_file=None)).enabled
    monkeypatch.setenv("FABRYKA_PIPELINE_USERNAME", "operator")
    monkeypatch.setenv("FABRYKA_PIPELINE_PASSWORD", "s3cret-value")
    monkeypatch.setenv("FABRYKA_PUBLIC_URL", "https://evil.invalid")
    loaded = config_from_settings(Settings(_env_file=None))
    assert loaded.enabled and loaded.origin == "https://track.fabryka.ai"
    assert loaded.controller_url == "https://data-pipeline.fabryka.ai"
    assert loaded.private_root == PRIVATE_ROOT
    assert "s3cret-value" not in repr(loaded) and "s3cret-value" not in repr(Settings(_env_file=None))


def test_credentials_never_reach_logs(private, caplog):
    caplog.set_level(logging.DEBUG)
    private.get("/pipeline/", headers=basic("operator", "guess-password-value"))
    private.get("/pipeline/", headers=AUTH)
    config_from_settings(Settings(_env_file=None, pipeline_username="operator", pipeline_password="x"))
    assert "guess-password-value" not in caplog.text and PIPELINE_TEST_PAIR[1] not in caplog.text


@pytest.fixture()
def track_pipeline(monkeypatch):
    from fabryka_track import api
    monkeypatch.setattr(api.pipeline_config, "username", PIPELINE_TEST_PAIR[0])
    monkeypatch.setattr(api.pipeline_config, "password", SecretStr(PIPELINE_TEST_PAIR[1]))
    return api


def test_actual_track_app_hf_session_does_not_grant_pipeline(client, track_pipeline):
    assert client.get("/api/projects").status_code == 200
    assert_denied(client.get("/pipeline/"))
    for path in built_assets():
        assert_denied(client.get(path))
    assert client.get("/pipeline/", headers=AUTH).status_code == 200


def test_actual_track_app_basic_without_hf_session(track_pipeline):
    client = TestClient(track_pipeline.app, base_url="https://track.fabryka.ai")
    assert client.get("/api/projects").status_code == 401
    page = client.get("/pipeline/", headers=AUTH)
    assert page.status_code == 200 and TITLE in page.text
    assert {k: page.headers[k] for k in PRIVATE_HEADERS} == PRIVATE_HEADERS
    for path in built_assets():
        assert client.get(path, headers=AUTH).status_code == 200
        assert_denied(client.get(path))
        assert_denied(client.head(path, headers={"If-None-Match": "*"}))
    assert client.get("/pipeline/.vite/manifest.json", headers=AUTH).status_code == 404


def test_actual_track_app_public_routes_never_read_private_build(track_pipeline):
    client = TestClient(track_pipeline.app, base_url="https://track.fabryka.ai")
    for path in built_assets():
        name = Path(path).name
        assert client.get(f"/assets/{name}").status_code == 404
        assert client.get(f"/assets/pipeline/{name}").status_code == 404
    for path in ("/assets/pipeline/index.html", "/pipeline-upload", "/pipelines/", "/PIPELINE/", "/run/pipeline"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert TITLE not in response.text


def test_actual_track_app_without_pair_disables_only_private_feature(client, monkeypatch):
    from fabryka_track import api
    monkeypatch.setattr(api.pipeline_config, "username", "")
    monkeypatch.setattr(api.pipeline_config, "password", SecretStr(""))
    for headers in ({}, AUTH, basic("", "")):
        assert_denied(client.get("/pipeline/", headers=headers), status=503)
    landing = client.get("/")
    assert landing.status_code == 200 and TITLE not in landing.text
    assert client.get("/api/public/runs").status_code == 200
    assert client.get("/models").status_code == 200


async def raw_asgi(app, path, root_path="", headers=()):
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET",
             "scheme": "https", "server": ("track.fabryka.ai", 443), "client": ("127.0.0.1", 1),
             "path": path, "raw_path": path.encode(), "root_path": root_path, "query_string": b"",
             "headers": [(b"host", b"track.fabryka.ai"), *headers]}
    await app(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], body


@pytest.mark.parametrize("app_factory", ["private", "track"])
@pytest.mark.anyio
async def test_root_path_prefix_cannot_bypass_private_boundary(app_factory, private_app, track_pipeline):
    app = private_app if app_factory == "private" else track_pipeline.app
    for path in ["/pipeline/", *built_assets()]:
        status, body = await raw_asgi(app, "/pfx" + path, root_path="/pfx")
        assert status == 401, path
        assert TITLE.encode() not in body
        auth = [(b"authorization", AUTH["Authorization"].encode())]
        assert (await raw_asgi(app, "/pfx" + path, root_path="/pfx", headers=auth))[0] == 200


def test_router_enforces_basic_even_without_boundary_middleware():
    from fastapi import FastAPI

    from fabryka_track.pipeline import make_pipeline_router
    bare = FastAPI()
    bare.include_router(make_pipeline_router(config(), no_network()))
    client = TestClient(bare, base_url="https://track.fabryka.ai")
    for path in ["/pipeline", "/pipeline/", *built_assets()]:
        response = client.get(path, follow_redirects=False)
        assert response.status_code == 401 and TITLE not in response.text, path
        assert response.headers["www-authenticate"] == CHALLENGE
    assert client.get("/pipeline/", headers=AUTH).status_code == 200


def test_null_byte_asset_path_is_404_not_500(private):
    assert private.get("/pipeline/assets/a%00.js", headers=AUTH).status_code == 404
    assert _servable(PRIVATE_ROOT, "assets/a\x00.js") is None


JOB = "0b9c3c4e-6f1a-4d8e-9a77-2f6c1d1e5a10"
CONTROLLER = "https://data-pipeline.fabryka.ai"
MUTATION = {**AUTH, "X-Pipeline-Request": "1", "Origin": PIPELINE_ORIGIN, "Sec-Fetch-Site": "same-origin"}
SCHEMA = json.loads((Path(__file__).parents[1] / "frontend/src/pipeline/contracts/upload-v1.schema.json").read_text())
ERROR_CODES = SCHEMA["$defs"]["Error"]["properties"]["code"]["enum"]
CLIENT_ROUTES = [("GET", "jobs"), ("POST", "jobs"), ("GET", f"jobs/{JOB}"), ("POST", f"jobs/{JOB}/parts"),
                 ("POST", f"jobs/{JOB}/confirm"), ("POST", f"jobs/{JOB}/cancel"), ("GET", f"jobs/{JOB}/report"),
                 ("GET", f"jobs/{JOB}/result"), ("HEAD", f"jobs/{JOB}/result")]


def error_body(code="invalid_state", retryable=False):
    return {"protocol": "upload-control-v1", "request_id": "1b9c3c4e-6f1a-4d8e-9a77-2f6c1d1e5a10",
            "code": code, "message": "Upstream message.", "retryable": retryable}


class Upstream:
    def __init__(self, respond=None):
        self.requests = []
        self.respond = respond or (lambda request: httpx.Response(200, json={"ok": True}))

    def __call__(self, request):
        self.requests.append(request)
        return self.respond(request)

    def client(self):
        return httpx.AsyncClient(transport=httpx.MockTransport(self), follow_redirects=False)


def proxied(upstream, **overrides):
    return TestClient(pipeline_app(config(**overrides), upstream.client()), base_url="https://track.fabryka.ai")


def assert_error(response, status, code):
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"protocol", "request_id", "code", "message", "retryable"}
    assert body["protocol"] == "upload-control-v1" and body["code"] == code and body["code"] in ERROR_CODES
    assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", body["request_id"])
    assert isinstance(body["retryable"], bool) and len(body["message"]) <= 256
    for name, value in PRIVATE_HEADERS.items():
        assert response.headers[name] == value
    assert "location" not in response.headers
    return body


def send(client, method, relative, headers=None, body=b"{}", query=""):
    headers = dict(MUTATION if method == "POST" else AUTH) if headers is None else headers
    if method == "POST":
        headers.setdefault("Content-Type", "application/json")
    url = f"/pipeline/api/{relative}" + (f"?{query}" if query else "")
    return client.request(method, url, headers=headers, content=body if method == "POST" else None)


def test_proxy_error_codes_match_contract_enum():
    from fabryka_track.pipeline import MESSAGES
    assert sorted(MESSAGES) == sorted(ERROR_CODES)


@pytest.mark.parametrize("method,relative", CLIENT_ROUTES)
def test_proxy_normalizes_each_client_route_once(method, relative):
    from fabryka_track.pipeline import normalize_route
    assert normalize_route(f"/pipeline/api/{relative}".encode(), method) == f"/uploads/v1/{relative}"


@pytest.mark.parametrize("raw,code", [
    (b"/pipeline/api/jobs/", "not_found"), (b"/pipeline/api/jobs/" + JOB.upper().encode(), "not_found"),
    (b"/pipeline/api/jobs/not-a-uuid", "not_found"), (b"/pipeline/api/jobs/%s/parts/1" % JOB.encode(), "not_found"),
    (b"/pipeline/api/uploads/v1/jobs", "not_found"), (b"/pipeline/api/worker/v1/bootstrap", "not_found"),
    (b"/pipeline/api", "not_found"), (b"/pipeline/apijobs", "not_found"), (b"/uploads/v1/jobs", "not_found"),
    (b"/pipeline/api/%6aobs", "invalid_request"), (b"/pipeline/api/./jobs", "invalid_request"),
    (b"/pipeline/api/jobs\\x", "invalid_request"), (b"/pipeline/api/j\xc3\xb3bs", "invalid_request"),
])
def test_proxy_rejects_unlisted_and_encoded_routes(raw, code):
    from fabryka_track.pipeline import RouteError, normalize_route
    with pytest.raises(RouteError) as caught:
        normalize_route(raw, "GET")
    assert caught.value.code == code


def test_proxy_method_mismatch_names_allowed_methods():
    from fabryka_track.pipeline import RouteError, normalize_route
    for raw, method, allow in [(b"/pipeline/api/jobs", "PUT", ("GET", "POST")),
                               (b"/pipeline/api/jobs", "OPTIONS", ("GET", "POST")),
                               (f"/pipeline/api/jobs/{JOB}/result".encode(), "POST", ("GET", "HEAD")),
                               (f"/pipeline/api/jobs/{JOB}".encode(), "HEAD", ("GET",))]:
        with pytest.raises(RouteError) as caught:
            normalize_route(raw, method)
        assert caught.value.code == "method_not_allowed" and caught.value.allow == allow


@pytest.mark.parametrize("method,relative", CLIENT_ROUTES)
def test_proxy_forwards_only_to_fixed_controller_route(method, relative):
    upstream = Upstream(lambda request: httpx.Response(
        201 if request.method == "POST" else 200, json={"route": request.url.path}))
    response = send(proxied(upstream), method, relative)
    assert len(upstream.requests) == 1
    sent = upstream.requests[0]
    assert sent.method == method and str(sent.url) == f"{CONTROLLER}/uploads/v1/{relative}"
    assert response.status_code == (201 if method == "POST" else 200)
    assert {k: response.headers[k] for k in PRIVATE_HEADERS} == PRIVATE_HEADERS
    if method == "HEAD":
        assert response.content == b""
    else:
        assert response.json() == {"route": f"/uploads/v1/{relative}"}


@pytest.mark.parametrize("method,relative,allow", [
    ("OPTIONS", "jobs", "GET, POST"), ("PUT", "jobs", "GET, POST"), ("DELETE", f"jobs/{JOB}", "GET"),
    ("PATCH", f"jobs/{JOB}/confirm", "POST"), ("HEAD", "jobs", "GET, POST"), ("GET", f"jobs/{JOB}/cancel", "POST"),
    ("PROPFIND", "jobs", "GET, POST"), ("OPTIONS", f"jobs/{JOB}/result", "GET, HEAD"),
])
def test_proxy_unlisted_methods_get_405_with_allow(method, relative, allow):
    upstream = Upstream()
    response = proxied(upstream).request(method, f"/pipeline/api/{relative}", headers=MUTATION)
    assert response.status_code == 405 and response.headers["allow"] == allow
    if method != "HEAD":
        assert_error(response, 405, "method_not_allowed")
    assert upstream.requests == []


@pytest.mark.parametrize("path", [
    "/pipeline/api/worker/v1/outcome", "/pipeline/api/worker/v1/bootstrap", "/pipeline/api/uploads/v1/jobs",
    "/pipeline/api", "/pipeline/api/", "/pipeline/api/jobs/x", f"/pipeline/api/jobs/{JOB}/../../worker/v1/outcome",
    "/pipeline/api/https://evil.invalid/uploads/v1/jobs",
])
def test_proxy_never_reaches_worker_or_arbitrary_routes(path):
    upstream = Upstream()
    client = proxied(upstream)
    for method in ("GET", "POST"):
        response = client.request(method, path, headers={**MUTATION, "Content-Type": "application/json"}, content=b"{}")
        assert response.status_code in (404, 405, 422), path
        assert_error(response, response.status_code, response.json()["code"])
    assert upstream.requests == []


@pytest.mark.parametrize("raw", [
    b"/pipeline/api/jobs%2fworker", b"/pipeline/api/jobs//x", b"/pipeline/api//jobs",
    b"/pipeline/api/../worker/v1/outcome", b"/pipeline/api/%2e%2e/worker/v1/outcome",
    b"/pipeline/api/jobs/%2e", b"/pipeline/%61pi/jobs", b"/pipeline/api/jobs%3Flimit=1",
])
@pytest.mark.anyio
async def test_proxy_raw_encoded_and_duplicate_separators_never_forward(raw):
    from urllib.parse import unquote
    upstream = Upstream()
    app = pipeline_app(config(), upstream.client())
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"{}", "more_body": False}

    async def capture(message):
        sent.append(message)

    headers = [(k.lower().encode(), v.encode()) for k, v in {**MUTATION, "Content-Type": "application/json"}.items()]
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "https",
             "server": ("track.fabryka.ai", 443), "client": ("127.0.0.1", 1), "root_path": "",
             "path": unquote(raw.decode()), "raw_path": raw, "query_string": b"", "headers": headers}
    await app(scope, receive, capture)
    status = next(m for m in sent if m["type"] == "http.response.start")["status"]
    assert status in (404, 422), raw
    assert upstream.requests == []


@pytest.mark.parametrize("headers", [
    {k: v for k, v in MUTATION.items() if k != "X-Pipeline-Request"},
    {**MUTATION, "X-Pipeline-Request": "0"}, {**MUTATION, "X-Pipeline-Request": "true"},
    {k: v for k, v in MUTATION.items() if k != "Origin"},
    {k: v for k, v in MUTATION.items() if k not in ("Origin", "Sec-Fetch-Site")},
    {**MUTATION, "Origin": "null"}, {**MUTATION, "Origin": "https://evil.invalid"},
    {**MUTATION, "Origin": "http://track.fabryka.ai"}, {**MUTATION, "Origin": "https://track.fabryka.ai/"},
    {**MUTATION, "Origin": "https://track.fabryka.ai:443"}, {**MUTATION, "Origin": "https://TRACK.fabryka.ai"},
    {**MUTATION, "Sec-Fetch-Site": "cross-site"}, {**MUTATION, "Sec-Fetch-Site": "same-site"},
    {**MUTATION, "Sec-Fetch-Site": "none"},
])
def test_proxy_mutations_require_header_exact_origin_and_same_origin_fetch(headers):
    upstream = Upstream()
    client = proxied(upstream)
    for relative in ("jobs", f"jobs/{JOB}/parts", f"jobs/{JOB}/confirm", f"jobs/{JOB}/cancel"):
        assert_error(send(client, "POST", relative, headers=dict(headers)), 403, "forbidden_origin")
    assert upstream.requests == []


def test_proxy_mutation_without_fetch_metadata_but_exact_origin_is_forwarded():
    upstream = Upstream()
    headers = {k: v for k, v in MUTATION.items() if k != "Sec-Fetch-Site"}
    assert send(proxied(upstream), "POST", "jobs", headers=headers).status_code == 200
    assert "sec-fetch-site" not in upstream.requests[0].headers


@pytest.mark.parametrize("headers", [{}, basic(PIPELINE_TEST_PAIR[0], "wrong"), {"Authorization": "Bearer x"}])
def test_proxy_requires_pipeline_basic_before_any_forwarding(headers):
    upstream = Upstream()
    client = proxied(upstream)
    for method, relative in CLIENT_ROUTES:
        merged = {**{k: v for k, v in MUTATION.items() if k != "Authorization"}, **headers}
        response = send(client, method, relative, headers=merged)
        assert response.status_code == 401 and response.headers["www-authenticate"] == CHALLENGE
    assert upstream.requests == []


def test_proxy_forwards_whitelisted_request_headers_and_exact_body():
    upstream = Upstream()
    body = b'{ "protocol" : "upload-control-v1",\n  "z": [1, 2.50, "\\u00f3"] }'
    hostile = {"Cookie": "fabryka_session=secret-cookie", "X-Forwarded-For": "10.0.0.1", "Forwarded": "for=x",
               "X-Real-IP": "10.0.0.2", "X-Forwarded-Host": "evil.invalid", "Proxy-Authorization": "Basic eDp5",
               "X-Api-Key": "provider-secret", "X-Upstream": "https://evil.invalid", "Te": "trailers",
               "Upgrade": "h2c", "Referer": "https://track.fabryka.ai/pipeline/", "X-Track-Request": "1"}
    headers = {**MUTATION, **hostile, "Idempotency-Key": "op-0123456789abcdef", "Content-Type": "application/json; charset=utf-8"}
    response = send(proxied(upstream), "POST", "jobs", headers=headers, body=body)
    assert response.status_code == 200
    sent = upstream.requests[0]
    assert sent.content == body
    assert sent.headers["authorization"] == AUTH["Authorization"]
    assert sent.headers["idempotency-key"] == "op-0123456789abcdef"
    assert sent.headers["x-pipeline-request"] == "1" and sent.headers["origin"] == PIPELINE_ORIGIN
    assert sent.headers["sec-fetch-site"] == "same-origin"
    assert sent.headers["content-type"] == "application/json; charset=utf-8"
    assert sent.headers["host"] == "data-pipeline.fabryka.ai"
    allowed = {"authorization", "content-type", "idempotency-key", "x-pipeline-request", "origin", "sec-fetch-site",
               "host", "content-length", "accept", "accept-encoding", "connection", "user-agent"}
    assert set(sent.headers.keys()) <= allowed, set(sent.headers.keys()) - allowed
    assert "secret-cookie" not in str(sent.headers.raw) and "provider-secret" not in str(sent.headers.raw)


def test_proxy_get_forwards_no_body_or_content_type():
    upstream = Upstream()
    response = proxied(upstream).get(f"/pipeline/api/jobs/{JOB}", headers={**AUTH, "Cookie": "a=b",
                                                                         "Content-Type": "application/json"})
    assert response.status_code == 200
    sent = upstream.requests[0]
    assert sent.content == b"" and "content-type" not in sent.headers and "cookie" not in sent.headers


@pytest.mark.parametrize("relative,query,forwarded", [
    ("jobs", "limit=5", "limit=5"), ("jobs", "cursor=abc_-Z9", "cursor=abc_-Z9"),
    ("jobs", "cursor=abc&limit=100", "limit=100&cursor=abc"), ("jobs", "limit=1", "limit=1"),
    (f"jobs/{JOB}/result", "diagnostic=true", "diagnostic=true"),
    (f"jobs/{JOB}/result", "diagnostic=false", "diagnostic=false"),
])
def test_proxy_rebuilds_only_validated_query(relative, query, forwarded):
    upstream = Upstream()
    assert send(proxied(upstream), "GET", relative, query=query).status_code == 200
    assert upstream.requests[0].url.query.decode() == forwarded


@pytest.mark.parametrize("method,relative,query", [
    ("GET", "jobs", "limit=0"), ("GET", "jobs", "limit=101"), ("GET", "jobs", "limit=abc"),
    ("GET", "jobs", "limit=1&limit=2"), ("GET", "jobs", "cursor=" + "a" * 257), ("GET", "jobs", "cursor=a%2Fb"),
    ("GET", "jobs", "cursor="), ("GET", "jobs", "upstream=https://evil.invalid"), ("GET", "jobs", "url=x"),
    ("GET", "jobs", "limit"), ("GET", f"jobs/{JOB}", "redirect=1"), ("GET", f"jobs/{JOB}/report", "key=x"),
    ("GET", f"jobs/{JOB}/result", "diagnostic=yes"), ("GET", f"jobs/{JOB}/result", "diagnostic=true&url=x"),
    ("HEAD", f"jobs/{JOB}/result", "diagnostic=1"), ("POST", "jobs", "limit=1"),
    ("POST", f"jobs/{JOB}/confirm", "diagnostic=true"),
])
def test_proxy_rejects_unapproved_query_selectors(method, relative, query):
    upstream = Upstream()
    response = send(proxied(upstream), method, relative, query=query)
    assert response.status_code == 422
    if method != "HEAD":
        assert_error(response, 422, "invalid_request")
    assert upstream.requests == []


@pytest.mark.parametrize("content_type,body,status,code", [
    ("application/json", b"{" + b" " * 65536, 413, "body_too_large"),
    ("application/json", b'"' + b"a" * 65534 + b'"' + b" ", 413, "body_too_large"),
    ("text/plain", b"{}", 422, "invalid_request"), ("application/json; charset=latin-1", b"{}", 422, "invalid_request"),
    ("application/x-www-form-urlencoded", b"a=b", 422, "invalid_request"), (None, b"{}", 422, "invalid_request"),
    ("multipart/form-data; boundary=x", b"{}", 422, "invalid_request"),
    ("application/json", b"\xff\xfe{}", 422, "invalid_request"), ("application/json", b"{not json", 422, "invalid_request"),
    ("application/json", b"", 422, "invalid_request"),
])
def test_proxy_accepts_only_bounded_utf8_json_bodies(content_type, body, status, code):
    upstream = Upstream()
    headers = dict(MUTATION)
    if content_type:
        headers["Content-Type"] = content_type
    response = proxied(upstream).post("/pipeline/api/jobs", headers=headers, content=body)
    assert_error(response, status, code)
    assert upstream.requests == []


def test_proxy_accepts_body_at_exact_limit_and_rejects_lying_length():
    upstream = Upstream()
    client = proxied(upstream)
    exact = b'"' + b"a" * 65534 + b'"'
    assert len(exact) == 65536
    assert send(client, "POST", "jobs", body=exact).status_code == 200
    assert upstream.requests[0].content == exact
    for declared in ("65537", "-1", "1e3", "99999999999999"):
        response = client.post("/pipeline/api/jobs", headers={**MUTATION, "Content-Type": "application/json",
                                                              "Content-Length": declared}, content=b"{}")
        assert response.status_code in (400, 413), declared
    assert len(upstream.requests) == 1


def test_proxy_get_with_body_is_rejected():
    upstream = Upstream()
    response = proxied(upstream).request("GET", "/pipeline/api/jobs", headers=AUTH, content=b"{}")
    assert_error(response, 422, "invalid_request")
    assert upstream.requests == []


def test_proxy_keeps_only_whitelisted_response_headers():
    def respond(request):
        return httpx.Response(429, headers={"Content-Type": "application/json", "Retry-After": "5",
                                            "Set-Cookie": "upstream=1", "Location": "https://internal.invalid/x",
                                            "Server": "uvicorn", "X-Internal-Url": "http://10.0.0.5:8140",
                                            "Access-Control-Allow-Origin": "*", "Allow": "GET, POST",
                                            "Cache-Control": "public, max-age=600"},
                              json=error_body("quota_exceeded", True))
    response = send(proxied(Upstream(respond)), "POST", "jobs")
    assert response.status_code == 429 and response.headers["retry-after"] == "5"
    assert response.headers["allow"] == "GET, POST" and response.headers["cache-control"] == "no-store"
    for name in ("set-cookie", "location", "server", "x-internal-url", "access-control-allow-origin"):
        assert name not in response.headers, name
    assert response.json() == error_body("quota_exceeded", True)


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_proxy_never_follows_or_exposes_upstream_redirects(status):
    upstream = Upstream(lambda request: httpx.Response(status, headers={"Location": "https://evil.invalid/steal"}))
    for method, relative in CLIENT_ROUTES:
        response = send(proxied(upstream), method, relative)
        assert response.status_code == 502 and "location" not in response.headers
        if method != "HEAD":
            body = assert_error(response, 502, "provider_unavailable")
            assert body["retryable"] is True and "evil.invalid" not in response.text
    assert len(upstream.requests) == len(CLIENT_ROUTES)
    assert all(r.url.host == "data-pipeline.fabryka.ai" for r in upstream.requests)


def test_proxy_preserves_upstream_401_challenge():
    upstream = Upstream(lambda request: httpx.Response(401, headers={"WWW-Authenticate": CHALLENGE},
                                                       json=error_body("unauthorized")))
    response = send(proxied(upstream), "GET", f"jobs/{JOB}")
    assert response.status_code == 401 and response.headers["www-authenticate"] == CHALLENGE
    assert response.json()["code"] == "unauthorized"


@pytest.mark.parametrize("status,code", [(404, "not_found"), (409, "transfer_not_ready"), (410, "expired"),
                                         (409, "diagnostic_required"), (422, "invalid_request"),
                                         (503, "provider_unavailable"), (400, "idempotency_key_required")])
def test_proxy_passes_schema_valid_upstream_errors(status, code):
    headers = {"Retry-After": "5"} if status == 503 else {}
    upstream = Upstream(lambda request: httpx.Response(status, headers=headers, json=error_body(code, status == 503)))
    response = send(proxied(upstream), "GET", f"jobs/{JOB}/result")
    assert response.status_code == status and response.json() == error_body(code, status == 503)
    if status == 503:
        assert response.headers["retry-after"] == "5"


@pytest.mark.parametrize("respond", [
    lambda r: httpx.Response(500, text="<html>Traceback: s3://bucket/key?X-Amz-Signature=abc</html>",
                             headers={"Content-Type": "text/html"}),
    lambda r: httpx.Response(404, json={"detail": "Not Found s3://bucket"}),
    lambda r: httpx.Response(409, json={**error_body(), "detail": "s3://bucket"}),
    lambda r: httpx.Response(409, json={**error_body(), "code": "provider_secret"}),
    lambda r: httpx.Response(409, json={**error_body(), "request_id": "not-a-uuid"}),
    lambda r: httpx.Response(409, json={**error_body(), "message": "x" * 257}),
    lambda r: httpx.Response(200, text="s3://bucket ok", headers={"Content-Type": "text/plain"}),
    lambda r: httpx.Response(200, content=b"{broken s3://bucket", headers={"Content-Type": "application/json"}),
    lambda r: httpx.Response(200, content=b'{"a": 1}', headers={"Content-Type": "application/json; charset=latin-1"}),
    lambda r: httpx.Response(200, content=b"[" + b"0," * 600000 + b"0]", headers={"Content-Type": "application/json"}),
])
def test_proxy_replaces_unsafe_upstream_bodies(respond):
    response = send(proxied(Upstream(respond)), "GET", f"jobs/{JOB}")
    assert_error(response, 502, "provider_unavailable")
    assert "s3://" not in response.text and "Traceback" not in response.text


def test_proxy_passes_report_up_to_contract_size():
    report = {"blob": "x" * 1048000}
    upstream = Upstream(lambda request: httpx.Response(200, json=report))
    response = send(proxied(upstream), "GET", f"jobs/{JOB}/report")
    assert response.status_code == 200 and response.json() == report


@pytest.mark.parametrize("exc", [httpx.ConnectError("https://10.0.0.5:8140 refused"),
                                 httpx.ReadTimeout("timed out reading https://internal.invalid"),
                                 httpx.RemoteProtocolError("bad"), httpx.ConnectTimeout("t")])
def test_proxy_transport_failures_are_safe_503(exc, caplog):
    def respond(request):
        raise exc
    caplog.set_level(logging.DEBUG)
    response = send(proxied(Upstream(respond)), "POST", "jobs", body=b'{"secret_metadata": "x"}')
    body = assert_error(response, 503, "provider_unavailable")
    assert body["retryable"] is True and response.headers["retry-after"] == "5"
    assert "10.0.0.5" not in response.text and "internal.invalid" not in response.text
    assert "secret_metadata" not in caplog.text and PIPELINE_TEST_PAIR[1] not in caplog.text
    assert AUTH["Authorization"].split()[1] not in caplog.text


def test_proxy_head_result_preserves_status_without_body():
    for status in (200, 410):
        upstream = Upstream(lambda request, status=status: httpx.Response(status, headers={"Content-Type": "application/json"}))
        response = send(proxied(upstream), "HEAD", f"jobs/{JOB}/result", query="diagnostic=true")
        assert response.status_code == status and response.content == b""
        assert upstream.requests[0].method == "HEAD"


@pytest.mark.parametrize("controller_url", ["http://data-pipeline.fabryka.ai", "https://u:p@data-pipeline.fabryka.ai",
                                            "https://data-pipeline.fabryka.ai/?upstream=x", "ftp://x"])
def test_proxy_refuses_non_https_or_selector_upstream(controller_url):
    upstream = Upstream()
    client = proxied(upstream, controller_url=controller_url)
    for method, relative in CLIENT_ROUTES:
        assert send(client, method, relative).status_code == 503
    assert upstream.requests == []


def test_proxy_function_refuses_plain_http_target():
    from fabryka_track.pipeline import proxy
    upstream = Upstream()
    app = FastAPI()

    @app.get("/x")
    async def x(request: Request):
        return await proxy(request, "http://data-pipeline.fabryka.ai/uploads/v1/jobs", upstream.client())
    assert TestClient(app).get("/x").status_code == 503
    assert upstream.requests == []


def test_proxy_controller_url_path_is_kept_without_double_slash():
    upstream = Upstream()
    client = proxied(upstream, controller_url="https://data-pipeline.fabryka.ai/control/")
    send(client, "GET", "jobs")
    assert str(upstream.requests[0].url) == "https://data-pipeline.fabryka.ai/control/uploads/v1/jobs"


def test_proxy_route_is_independent_of_public_api_guard(client, track_pipeline, monkeypatch):
    upstream = Upstream()
    monkeypatch.setattr(track_pipeline.pipeline_client, "_transport", httpx.MockTransport(upstream))
    track = TestClient(track_pipeline.app, base_url="https://track.fabryka.ai")
    track.cookies.update(client.cookies)
    no_track_header = send(track, "POST", "jobs")
    assert no_track_header.status_code == 200
    track_header_only = {**AUTH, "X-Track-Request": "1", "Origin": PIPELINE_ORIGIN, "Content-Type": "application/json"}
    assert_error(send(track, "POST", "jobs", headers=track_header_only), 403, "forbidden_origin")
    assert_error(send(track, "POST", "jobs", headers={**MUTATION, "Origin": "https://evil.invalid"}), 403,
                 "forbidden_origin")
    hf_only = {k: v for k, v in MUTATION.items() if k != "Authorization"}
    assert send(track, "POST", "jobs", headers=hf_only).status_code == 401
    assert send(track, "GET", "worker/v1/assignment").status_code == 404
    assert len(upstream.requests) == 1
    sent = upstream.requests[0]
    assert "cookie" not in sent.headers and "x-track-request" not in sent.headers
    assert str(sent.url) == "https://data-pipeline.fabryka.ai/uploads/v1/jobs"


def test_caddy_routes_private_prefix_to_same_track_app_and_keeps_public_headers():
    caddy = (Path(__file__).parents[1] / "deploy/track.fabryka.ai.caddy").read_text()
    assert re.search(r"@pipeline path /pipeline /pipeline/\*\n", caddy)
    blocks = re.findall(r"handle( @pipeline)? \{\s*reverse_proxy (\S+)\s*\}", caddy)
    assert blocks == [(" @pipeline", "127.0.0.1:8130"), ("", "127.0.0.1:8130")]
    for line in ('Strict-Transport-Security "max-age=31536000"', 'X-Content-Type-Options "nosniff"',
                 'X-Frame-Options "DENY"', 'Cache-Control "no-store"', "encode zstd gzip", "-Server"):
        assert line in caddy
    assert "basic_auth" not in caddy and "basicauth" not in caddy and "data-pipeline" not in caddy
    assert "/worker/" not in caddy and "uploads/v1" not in caddy


def test_env_example_names_pipeline_settings_without_values():
    lines = (Path(__file__).parents[1] / ".env.example").read_text().splitlines()
    for name in ("FABRYKA_PIPELINE_USERNAME", "FABRYKA_PIPELINE_PASSWORD"):
        assert f"{name}=" in lines
    assert "FABRYKA_PIPELINE_CONTROLLER_URL=https://data-pipeline.fabryka.ai" in lines


@pytest.mark.parametrize("raw", [
    b"/pipeline/api/jobs%2fworker", b"/pipeline/api/jobs//x",
    b"/pipeline/api/../worker/v1/outcome", b"/pipeline/api/worker/v1/outcome",
    b"/pipeline/api/jobs/https://evil.invalid"])
def test_proxy_rejects_unlisted_paths(raw):
    from fabryka_track.pipeline import normalize_route
    with pytest.raises(ValueError):
        normalize_route(raw, "POST")


def test_proxy_only_maps_approved_job_route():
    from fabryka_track.pipeline import normalize_route
    assert normalize_route(b"/pipeline/api/jobs", "POST") == "/uploads/v1/jobs"


def test_proxy_rejects_non_ascii_forwarded_header_values_safely():
    upstream = Upstream()
    client = proxied(upstream)
    headers = {**MUTATION, "Idempotency-Key": b"op-\xe9-0123456789", "Content-Type": "application/json"}
    assert_error(send(client, "POST", "jobs", headers=headers), 422, "invalid_request")
    assert upstream.requests == []


def test_proxy_get_does_not_forward_unchecked_browser_metadata():
    upstream = Upstream()
    response = proxied(upstream).get(f"/pipeline/api/jobs/{JOB}",
                                     headers={**AUTH, "Sec-Fetch-Site": b"s\xe9", "Origin": b"\xe9"})
    assert response.status_code == 200
    sent = upstream.requests[0]
    assert "sec-fetch-site" not in sent.headers and "origin" not in sent.headers
