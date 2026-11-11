import json
from html import escape
from pathlib import Path

BROWSER_ASSETS = Path(__file__).with_name("browser")


def render_arrival_report(settings):
    """Build a self-contained page whose results are computed in the browser."""
    config = escape(json.dumps({
        "prepMinutes": settings["prep_minutes"],
        "postMinutes": settings["post_minutes"],
        "switchMinutes": settings["switch_minutes"],
        "durations": settings["browser_durations"],
        "replicates": settings["replicates"],
        "seed": settings["seed"] & 0xFFFFFFFF,
    }, separators=(",", ":")), quote=True)
    lab_style = (BROWSER_ASSETS / "arrival-lab.css").read_text(encoding="utf-8")
    engine = (BROWSER_ASSETS / "arrival-engine.js").read_text(encoding="utf-8")
    lab = (BROWSER_ASSETS / "arrival-lab.js").read_text(encoding="utf-8")
    return f'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#143c30">
<link rel="icon" href="data:,">
<title>S01 批处理合成演示</title>
<style>{lab_style}</style>
</head>
<body class="arrival-page">
<header class="arrival-hero">
  <div class="arrival-shell">
    <p class="arrival-eyebrow">S01 · 合成数据演示</p>
    <h1>S01 批处理合成演示</h1>
    <p class="arrival-hero-note">使用虚构订单和工时，比较立即启动与限时等单的结果。</p>
  </div>
</header>
<main class="arrival-shell">
  <div id="arrival-lab" data-config="{config}">
    <noscript><p>启用 JavaScript 即可在网页上计算。</p></noscript>
  </div>
</main>
<script>{engine}</script>
<script>{lab}</script>
</body>
</html>'''
