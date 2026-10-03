import re
from pathlib import Path

from fastapi.testclient import TestClient


def test_private_build_requires_basic_before_bytes(private_app):
    client = TestClient(private_app, base_url="https://track.fabryka.ai")
    root = Path("src/fabryka_track/pipeline_web")
    assert (root / "index.html").is_file()
    paths = ["/pipeline/", "/pipeline"] + [
        "/pipeline/" + p.relative_to(root).as_posix()
        for p in root.rglob("*") if p.is_file()]
    for path in paths:
        for method in ("GET", "HEAD"):
            response = client.request(method, path, headers={"If-None-Match": "*"})
            assert response.status_code == 401, (method, path)
            assert "Basic" in response.headers["www-authenticate"]
            assert "Data Pipeline Upload" not in response.text
    assert client.get("/assets/pipeline/index.html").status_code == 404


PRIVATE = Path("src/fabryka_track/pipeline_web")
PUBLIC = Path("src/fabryka_track/web")


def files(root):
    return [p for p in root.rglob("*") if p.is_file()]


def test_private_build_is_separate_with_hashed_entry_and_no_source_maps():
    html = (PRIVATE / "index.html").read_text()
    references = re.findall(r'(?:src|href)="([^"]+)"', html)
    assert references and all(re.fullmatch(r"/pipeline/assets/[\w-]+\.(js|css)", r) for r in references)
    assert "main.tsx" not in html and "/src/" not in html
    for path in files(PRIVATE):
        assert path.suffix != ".map", path
        assert path.suffix in {".html", ".js", ".css", ".json"} or path.parent.name == "assets", path
        if path.suffix in {".js", ".css"}:
            assert "sourceMappingURL" not in path.read_text()
    assert (PRIVATE / ".vite" / "manifest.json").is_file()


def test_public_build_never_contains_private_entry_and_private_never_imports_public_app():
    assert (PUBLIC / "index.html").is_file()
    public_names = {p.name for p in files(PUBLIC)}
    for path in files(PRIVATE / "assets"):
        assert path.name not in public_names
    for path in files(PUBLIC):
        if path.suffix in {".html", ".js", ".css"}:
            text = path.read_text(errors="ignore")
            assert "Data Pipeline Upload" not in text and "/pipeline/assets/" not in text, path
    private_js = "".join(p.read_text() for p in files(PRIVATE / "assets") if p.suffix == ".js")
    assert "/pipeline/api/" in private_js
    private_js = private_js.replace("/pipeline/api/", "")
    for public_marker in ("Fabryka Track", "Sign in", "huggingface", "/api/"):
        assert public_marker not in private_js, public_marker
