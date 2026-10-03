import base64
import logging
import re
from pathlib import Path

import httpx
import pytest
from conftest import PIPELINE_TEST_PAIR
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
    "/pipeline/assets/.hidden", "/pipeline/unknown", "/pipeline/api/jobs",
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
