import base64
import json

import httpx
import pytest
from sqlalchemy import delete, select

from fabryka_track import data_uploads
from fabryka_track.database import SessionLocal
from fabryka_track.models import DataUploadDeclaration, HuggingFaceIdentity

REQUEST_ID = "0f0e0d0c-0b0a-4999-8888-777766665555"
JOB_ID = "6f1c1f3e-2b7a-4d5e-9c3b-1a2b3c4d5e6f"
ACTION_KEY = "0b0c7d9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"


def create_body(**overrides):
    body = {
        "action_key": ACTION_KEY,
        "input": {"format": "jsonl", "encoded_bytes": 1024, "sha256": "a" * 64, "filename": "data.jsonl"},
        "parameters": {"source": "my_source", "added": "2026-10-08", "license": "cc-by-4.0", "mask_names": False},
        "declaration": {"accepted": True, "version": data_uploads.DECLARATION_VERSION},
    }
    body.update(overrides)
    return body


def job_status(**overrides):
    return {"protocol": "job-v1", "job_id": JOB_ID, "pipeline": "dynaword-upload", "admitted": False,
            "processing_state": "uploading", "client_phase": "uploading", "transfer_state": "pending",
            "failure_code": None, "artifacts": [], **overrides}


class FakeController:
    def __init__(self):
        self.requests = []
        self.jobs_by_key = {}
        self.reply = None

    def __call__(self, request):
        self.requests.append(request)
        if self.reply:
            return self.reply(request)
        if request.method == "POST" and request.url.path == "/jobs/v1/jobs":
            key = request.headers["idempotency-key"]
            job_id = self.jobs_by_key.setdefault(key, JOB_ID if not self.jobs_by_key else f"{len(self.jobs_by_key):08d}-0000-4000-8000-000000000000")
            return httpx.Response(201, json={"protocol": "job-v1", "job_id": job_id, "admitted": False,
                                             "processing_state": "uploading", "transfer_state": "pending",
                                             "encoded_bytes": 1024, "input_sha256": "a" * 64,
                                             "part_size_bytes": 8388608})
        return httpx.Response(200, json=job_status())


@pytest.fixture()
def controller(monkeypatch):
    fake = FakeController()
    fake.clients = 0
    real_client = httpx.Client

    def build(**kw):
        fake.clients += 1
        return real_client(transport=httpx.MockTransport(fake), **kw)
    monkeypatch.setattr(data_uploads.httpx, "Client", build)
    monkeypatch.setattr(data_uploads, "_client", None)
    monkeypatch.setattr(data_uploads.settings, "pipeline_url", "https://pipeline.test")
    monkeypatch.setattr(data_uploads.settings, "pipeline_username", "track")
    monkeypatch.setattr(data_uploads.settings, "pipeline_password", "track-secret")
    return fake


def drop_hf_identity():
    with SessionLocal() as session:
        session.execute(delete(HuggingFaceIdentity))
        session.commit()


def test_account_without_hugging_face_identity_is_refused(client, controller):
    drop_hf_identity()
    response = client.post("/api/uploads", json=create_body())
    assert response.status_code == 403
    assert client.get("/api/uploads").status_code == 403
    assert controller.requests == []


def test_unconfigured_controller_answers_503(client, controller, monkeypatch):
    monkeypatch.setattr(data_uploads.settings, "pipeline_password", None)
    response = client.get("/api/uploads")
    assert response.status_code == 503
    assert response.json()["detail"] == "Data uploads are not configured."
    assert controller.requests == []


def test_create_forwards_track_pair_and_hugging_face_identity(client, controller):
    response = client.post("/api/uploads", json=create_body())
    assert response.status_code == 201
    assert response.json()["job_id"] == JOB_ID
    sent = controller.requests[0]
    assert sent.url.path == "/jobs/v1/jobs"
    assert sent.headers["authorization"] == "Basic " + base64.b64encode(b"track:track-secret").decode()
    assert sent.headers["x-pipeline-request"] == "1"
    assert sent.headers["x-pipeline-user"] == "fixture-tester"
    assert sent.headers["x-pipeline-user-name"] == "tester"
    assert sent.headers["idempotency-key"] == ACTION_KEY
    assert json.loads(sent.content) == {
        "protocol": "job-v1", "pipeline": "dynaword-upload",
        "input": {"format": "jsonl", "encoded_bytes": 1024, "sha256": "a" * 64, "filename": "data.jsonl"},
        "parameters": {"source": "my_source", "added": "2026-10-08", "license": "cc-by-4.0", "mask_names": False},
    }


@pytest.mark.parametrize("declaration", [None, {"accepted": False, "version": data_uploads.DECLARATION_VERSION},
                                         {"accepted": True, "version": "some-other-text"}])
def test_create_without_accepted_declaration_never_reaches_controller(client, controller, declaration):
    body = create_body(declaration=declaration)
    if declaration is None:
        del body["declaration"]
    assert client.post("/api/uploads", json=body).status_code == 422
    assert controller.requests == []
    with SessionLocal() as session:
        assert session.scalars(select(DataUploadDeclaration)).all() == []


@pytest.mark.parametrize("mask_names", [None, "yes"])
def test_mask_names_is_an_explicit_yes_or_no(client, controller, mask_names):
    body = create_body()
    body["parameters"] = {**body["parameters"], "mask_names": mask_names}
    if mask_names is None:
        del body["parameters"]["mask_names"]
    assert client.post("/api/uploads", json=body).status_code == 422
    assert controller.requests == []


def test_repeated_create_returns_same_job_and_records_one_declaration(client, controller):
    first = client.post("/api/uploads", json=create_body()).json()
    second = client.post("/api/uploads", json=create_body()).json()
    assert first["job_id"] == second["job_id"] == JOB_ID
    with SessionLocal() as session:
        rows = session.scalars(select(DataUploadDeclaration)).all()
        assert [(row.job_id, row.version) for row in rows] == [(JOB_ID, data_uploads.DECLARATION_VERSION)]
        assert rows[0].accepted_at is not None


def controller_error(status, code):
    return lambda request: httpx.Response(status, json={"protocol": "job-v1", "request_id": REQUEST_ID, "code": code,
                                                        "message": "internal controller wording", "retryable": True})


@pytest.mark.parametrize("code,message", [
    ("user_limit_reached", "You already have an upload in progress. Wait for it to finish or cancel it."),
    ("guest_capacity_full", "Guest upload capacity is full right now. Try again later."),
    ("quota_exceeded", "The data pipeline is at capacity. Try again later."),
])
def test_limit_errors_map_to_stable_messages(client, controller, code, message):
    controller.reply = controller_error(429, code)
    response = client.post("/api/uploads", json=create_body())
    assert response.status_code == 429
    assert response.json() == {"detail": message, "code": code, "request_id": REQUEST_ID}
    with SessionLocal() as session:
        assert session.scalars(select(DataUploadDeclaration)).all() == []


def test_rejected_track_credentials_are_not_reported_as_a_browser_sign_in_problem(client, controller):
    controller.reply = controller_error(401, "unauthorized")
    response = client.get("/api/uploads")
    assert response.status_code == 502
    assert response.json() == {"detail": data_uploads.UNAVAILABLE, "code": "unauthorized", "request_id": REQUEST_ID}


def test_unreachable_controller_is_a_502(client, controller):
    def fail(request):
        raise httpx.ConnectError("down")
    controller.reply = fail
    assert client.get("/api/uploads").status_code == 502


CONFIRM = {"parts": [{"part_number": 1, "etag": '"abc"'}, {"part_number": 2, "etag": '"def"'}],
           "encoded_bytes": 1024, "input_sha256": "a" * 64}


@pytest.mark.parametrize("method,path,body,expected", [
    ("post", f"/api/uploads/{JOB_ID}/parts", {"part_number": 3},
     ("POST", f"/jobs/v1/jobs/{JOB_ID}/parts", "", {"protocol": "job-v1", "part_number": 3}, None)),
    ("post", f"/api/uploads/{JOB_ID}/confirm", {"action_key": ACTION_KEY, **CONFIRM},
     ("POST", f"/jobs/v1/jobs/{JOB_ID}/confirm", "", {"protocol": "job-v1", **CONFIRM}, ACTION_KEY)),
    ("post", f"/api/uploads/{JOB_ID}/cancel", {"action_key": ACTION_KEY},
     ("POST", f"/jobs/v1/jobs/{JOB_ID}/cancel", "", {"protocol": "job-v1"}, ACTION_KEY)),
    ("get", f"/api/uploads/{JOB_ID}", None, ("GET", f"/jobs/v1/jobs/{JOB_ID}", "", None, None)),
    ("get", f"/api/uploads/{JOB_ID}/report", None, ("GET", f"/jobs/v1/jobs/{JOB_ID}/report", "", None, None)),
    ("get", f"/api/uploads/{JOB_ID}/result", None, ("GET", f"/jobs/v1/jobs/{JOB_ID}/result", "", None, None)),
    ("get", f"/api/uploads/{JOB_ID}/result?diagnostic=true", None,
     ("GET", f"/jobs/v1/jobs/{JOB_ID}/result", "diagnostic=true", None, None)),
    ("get", "/api/uploads?cursor=abc", None, ("GET", "/jobs/v1/jobs", "limit=20&cursor=abc", None, None)),
])
def test_routes_forward_to_matching_controller_calls(client, controller, method, path, body, expected):
    response = getattr(client, method)(path, **({"json": body} if body is not None else {}))
    assert response.status_code == 200
    sent = controller.requests[0]
    sent_body = json.loads(sent.content) if sent.content else None
    assert (sent.method, sent.url.path, sent.url.query.decode(), sent_body, sent.headers.get("idempotency-key")) == expected
    assert ("x-pipeline-request" in sent.headers) == (sent.method == "POST")


def test_job_id_must_be_a_uuid(client, controller):
    assert client.get("/api/uploads/..%2F..%2Fadmin").status_code in (404, 422)
    assert client.get("/api/uploads/not-a-job/report").status_code == 422
    assert controller.requests == []


def test_anonymous_visitor_must_sign_in(client, controller):
    client.cookies.clear()
    assert client.get("/api/uploads").status_code == 401
    assert controller.requests == []


def test_client_supplied_identity_headers_are_never_forwarded(client, controller):
    spoofed = {"X-Pipeline-User": "someone-else", "X-Pipeline-User-Name": "admin", "Idempotency-Key": "x" * 20}
    client.post("/api/uploads", json=create_body(), headers=spoofed)
    client.get("/api/uploads", headers=spoofed)
    for sent in controller.requests:
        assert sent.headers.get_list("x-pipeline-user") == ["fixture-tester"]
        assert sent.headers.get_list("x-pipeline-user-name") == ["tester"]
    assert controller.requests[0].headers["idempotency-key"] == ACTION_KEY
    assert "idempotency-key" not in controller.requests[1].headers


def test_unconfigured_is_reported_before_the_identity_check(client, controller, monkeypatch):
    drop_hf_identity()
    monkeypatch.setattr(data_uploads.settings, "pipeline_username", None)
    assert client.get("/api/uploads").status_code == 503


def test_pipeline_url_must_use_https():
    from pydantic import ValidationError
    from fabryka_track.settings import Settings
    with pytest.raises(ValidationError):
        Settings(pipeline_url="http://data-pipeline.fabryka.ai")
    assert Settings(pipeline_url="https://data-pipeline.fabryka.ai").pipeline_url == "https://data-pipeline.fabryka.ai"


@pytest.mark.parametrize("field", ["license", "author", "source_ref"])
def test_optional_metadata_accepts_the_controller_maximum(client, controller, field):
    body = create_body()
    body["parameters"] = {**body["parameters"], field: "x" * 4096}
    assert client.post("/api/uploads", json=body).status_code == 201
    body["parameters"][field] = "x" * 4097
    assert client.post("/api/uploads", json=body).status_code == 422


def test_concurrent_creates_with_one_key_both_return_the_job(client, controller):
    import threading
    barrier = threading.Barrier(2, timeout=10)
    default = FakeController.__call__

    def together(request):
        barrier.wait()
        controller.reply = None
        return default(controller, request)
    controller.reply = together
    results = []
    threads = [threading.Thread(target=lambda: results.append(client.post("/api/uploads", json=create_body())))
               for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(r.status_code for r in results) == [201, 201]
    assert {r.json()["job_id"] for r in results} == {JOB_ID}
    with SessionLocal() as session:
        assert len(session.scalars(select(DataUploadDeclaration)).all()) == 1


def test_no_database_connection_is_held_during_the_controller_call(client, controller):
    from fabryka_track.database import engine
    held = []
    default = FakeController.__call__

    def observe(request):
        held.append(engine.pool.checkedout())
        controller.reply = None
        result = default(controller, request)
        controller.reply = observe
        return result
    controller.reply = observe
    assert client.post("/api/uploads", json=create_body()).status_code == 201
    assert client.get("/api/uploads").status_code == 200
    assert held == [0, 0]
    with SessionLocal() as session:
        assert session.get(DataUploadDeclaration, JOB_ID) is not None


def test_one_controller_client_is_reused_across_requests(client, controller):
    client.get("/api/uploads")
    client.get(f"/api/uploads/{JOB_ID}")
    assert controller.clients == 1
    assert len(controller.requests) == 2


def test_controller_failures_are_logged_without_secrets(client, controller, caplog):
    controller.reply = controller_error(409, "invalid_state")
    with caplog.at_level("WARNING", logger="fabryka_track.data_uploads"):
        response = client.post(f"/api/uploads/{JOB_ID}/cancel", json={"action_key": ACTION_KEY})
    assert response.json()["request_id"] == REQUEST_ID
    text = caplog.text
    for expected in ("POST", "/cancel", "409", "invalid_state", REQUEST_ID):
        assert expected in text
    assert "track-secret" not in text and "dHJhY2s6" not in text


@pytest.mark.parametrize("code", ["integrity_mismatch", "body_too_large", "unsupported_version",
                                  "idempotency_key_required", "method_not_allowed", "stale_attempt", "lease_expired"])
def test_every_job_v1_error_code_has_its_own_message(client, controller, code):
    controller.reply = controller_error(409, code)
    detail = client.get("/api/uploads").json()["detail"]
    assert detail not in (data_uploads.UNAVAILABLE, data_uploads.REFUSED)
    if code == "integrity_mismatch":
        assert detail == "The uploaded file does not match what was declared. Start a new upload."


def test_forbidden_origin_is_treated_as_tracks_own_fault(client, controller):
    controller.reply = controller_error(403, "forbidden_origin")
    response = client.get("/api/uploads")
    assert (response.status_code, response.json()["detail"]) == (502, data_uploads.UNAVAILABLE)


@pytest.mark.parametrize("reply,status,detail", [
    (lambda r: httpx.Response(418, json={"code": "something_new"}), 418, "The data pipeline refused this request."),
    (lambda r: httpx.Response(409, json={}), 409, "The data pipeline refused this request."),
    (lambda r: httpx.Response(500, json={"code": "something_new"}), 500, "Data uploads are temporarily unavailable. Try again shortly."),
    (lambda r: httpx.Response(503, text="<html>bad gateway</html>"), 502, "Data uploads are temporarily unavailable. Try again shortly."),
    (lambda r: httpx.Response(409, json=["not", "an", "object"]), 502, "Data uploads are temporarily unavailable. Try again shortly."),
    (lambda r: httpx.Response(200, text="not json"), 502, "Data uploads are temporarily unavailable. Try again shortly."),
    (lambda r: httpx.Response(200, json=[1, 2]), 502, "Data uploads are temporarily unavailable. Try again shortly."),
])
def test_unexpected_controller_replies_fall_back_by_status(client, controller, reply, status, detail):
    controller.reply = reply
    response = client.get(f"/api/uploads/{JOB_ID}")
    assert (response.status_code, response.json()["detail"]) == (status, detail)


def test_unusable_hugging_face_username_has_its_own_message(client, controller):
    with SessionLocal() as session:
        session.scalar(select(HuggingFaceIdentity)).username = "Display Name"
        session.commit()
    response = client.get("/api/uploads")
    assert response.status_code == 403
    assert response.json()["detail"] == ("Your Hugging Face account has no username Track can use. "
                                         "Sign out and sign in with Hugging Face again.")
    assert controller.requests == []


def test_action_key_rejects_a_trailing_newline(client, controller):
    assert client.post("/api/uploads", json=create_body(action_key=ACTION_KEY + "\n")).status_code == 422
    assert controller.requests == []
