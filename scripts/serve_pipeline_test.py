from pathlib import Path

import httpx
import uvicorn
from pydantic import SecretStr

from fabryka_track.pipeline import (
    PIPELINE_ORIGIN,
    PRIVATE_ROOT,
    PipelineConfig,
    pipeline_app,
)

HOST, PORT = "127.0.0.1", 4174
TEST_PAIR = ("operator", "local-test-password")
UNAVAILABLE = {"protocol": "upload-control-v1", "request_id": "90000000-0000-4000-8000-000000000001",
               "code": "provider_unavailable", "message": "Temporarily unavailable", "retryable": True}


def build_app(private_root: Path = PRIVATE_ROOT):
    config = PipelineConfig(username=TEST_PAIR[0], password=SecretStr(TEST_PAIR[1]),
                            controller_url="https://data-pipeline.fabryka.ai", origin=PIPELINE_ORIGIN,
                            private_root=private_root)
    # Requests the browser fixtures did not intercept must never reach a real controller.
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(503, json=UNAVAILABLE)))
    app = pipeline_app(config, client)

    @app.get("/health")
    def health():
        return {"status": "ok", "evidence": "local_fixture"}

    return app


if __name__ == "__main__":
    uvicorn.run(build_app(), host=HOST, port=PORT, log_level="warning")
