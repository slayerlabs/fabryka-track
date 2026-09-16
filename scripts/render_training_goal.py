"""Rebuild with: uv run --with 'markdown==3.8.2' python scripts/render_training_goal.py."""
from pathlib import Path
import markdown

root = Path(__file__).resolve().parents[1]
source = (root / 'src/fabryka_track/static/goal-250m.md').read_text().split('# Full specification\n\n', 1)[1]
renderer = markdown.Markdown(extensions=['tables', 'fenced_code', 'toc'], extension_configs={'toc': {'toc_depth': '2-3'}})
body = renderer.convert(source)
document = (
    '<details class="toc-panel"><summary>[+] Contents / jump to section</summary>'
    + renderer.toc + '</details>\n'
    + '<article aria-label="Full RFC-005 specification">' + body + '</article>\n'
    + '<footer><a href="/">[back to goals]</a> | '
    + '<a href="https://github.com/slayerlabs/rfcs/pull/5">[discuss on GitHub]</a>'
    + '<p>This is the pinned RFC snapshot supplied to agents. Check GitHub for newer revisions before execution.</p></footer>\n'
)
(root / 'frontend/src/pages/PublicTrainingDocument.html').write_text(document)
