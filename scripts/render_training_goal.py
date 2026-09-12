"""Rebuild with: uv run --with 'markdown==3.8.2' python scripts/render_training_goal.py."""
from pathlib import Path
import markdown

root = Path(__file__).resolve().parents[1]
static = root / 'src/fabryka_track/static'
source = (static / 'goal-250m.md').read_text().split('# Full specification\n\n', 1)[1]
renderer = markdown.Markdown(extensions=['tables', 'fenced_code', 'toc'], extension_configs={'toc': {'toc_depth': '2-3'}})
body = renderer.convert(source)
scratchpad = (static / "research-scratchpad.html").read_text()
html = '''<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Train a 250M English base model | Fabryka Track</title>
<link rel="stylesheet" href="/assets/ascii.css">
<style>
*{box-sizing:border-box}body{margin:0}a{color:var(--accent)}main{max-width:1060px;margin:0 auto;padding:36px 28px 70px}nav{display:flex;flex-wrap:wrap;gap:12px 22px;margin:20px 0 32px}header{padding-bottom:22px;border-bottom:1px dashed var(--line);margin-bottom:28px}.label{font-size:12px;color:var(--muted)}h1{margin:12px 0 18px}.intro{max-width:78ch}.actions{display:flex;gap:12px 24px;flex-wrap:wrap}.toc-panel{border:1px dashed var(--line);padding:16px 20px;margin:28px 0}.toc-panel summary{cursor:pointer;font-weight:bold}.toc ul{padding-left:20px}.toc li{margin:6px 0}article{line-height:1.85;overflow-wrap:anywhere}article>h1{font-size:20px;line-height:1.5}article h2{margin:44px 0 16px;padding-top:20px;border-top:1px dashed var(--line);font-size:20px;scroll-margin-top:20px}article h3{margin-top:30px;font-size:16px;scroll-margin-top:20px}article p,article li{max-width:90ch}article a{color:var(--accent)}article table{display:block;overflow-x:auto;max-width:100%;border-collapse:collapse;font-size:12px;margin:24px 0}article td,article th{padding:12px 14px;border:1px dashed var(--line);text-align:left;min-width:130px;vertical-align:top}article th{background:#eaf0e6;color:var(--ink)}article pre{overflow-x:auto;padding:18px;border:1px dashed var(--line);background:#eef2e9;font-size:12px}article code{font-size:.95em;background:#eef2e9}article blockquote{margin:20px 0;padding:0 20px;border-left:2px solid var(--line)}footer{margin-top:42px;font-size:12px}.meta{color:var(--muted);font-size:12px}@media(max-width:650px){main{padding:22px 18px 40px}article{font-size:13px}article h2{font-size:18px}article td,article th{min-width:125px;padding:9px}}
</style></head><body><main>
<header>
<div class="label">FABRYKA / TRACK / GOALS / RFC-005</div>
<nav aria-label="Goal navigation"><a href="/">[all goals]</a><a href="/runs">[runs]</a><a href="/new">[training studio]</a></nav>
<div class="label">[DRAFT PROPOSAL]</div>
<h1>Train a 250M English base model</h1>
<p class="intro">The full research specification: controlled proxy experiments, data and architecture decisions, training budgets, evaluation and delivery criteria.</p>
<div class="actions"><a href="#scratchpad">[research scratchpad]</a><a href="/goals/250m-english-base-model.md">[agent-readable goal]</a><a href="https://github.com/slayerlabs/rfcs/pull/5">[GitHub discussion]</a></div>
<p class="meta">RFC v0.4 | source revision c0634b8 | snapshot 2026-09-12</p>
</header>
'''+scratchpad+'''<details class="toc-panel"><summary>[+] Contents / jump to section</summary>'''+renderer.toc+'''</details>
<article aria-label="Full RFC-005 specification">'''+body+'''</article>
<footer><a href="/">[back to goals]</a> | <a href="https://github.com/slayerlabs/rfcs/pull/5">[discuss on GitHub]</a><p>This is the pinned RFC snapshot supplied to agents. Check GitHub for newer revisions before execution.</p></footer>
</main></body></html>
'''
(static / 'goal-250m.html').write_text(html)
