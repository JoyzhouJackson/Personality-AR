"""Build the hosted and offline seven-island demo from the SimPy reference trace."""

import argparse
import base64
from html import unescape
import json
from pathlib import Path
import re

from simpy_six_island_baseline import Baseline


ROOT = Path(__file__).resolve().parent


def batching_defaults():
    report = (ROOT / "docs/scheduling/arrival-comparison.html").read_text(encoding="utf-8")
    match = re.search(r'id="arrival-lab" data-config="([^"]+)"', report)
    if match is None:
        raise ValueError("找不到 S01 批处理工时表，请先生成 S01 批处理报告。")
    config = json.loads(unescape(match.group(1)))
    return {
        **{key: config[key] for key in ("prepMinutes", "postMinutes", "switchMinutes", "durations")},
        "machineCount": 3,
        "waitMinutes": 0,
        "capacity": None,
        "transportSeconds": 14,
    }


def build(hosted, offline=None):
    model = Baseline(
        36, 300, reserve_return=True, shared_kit_slot=True,
        capture_trace=True, batching=batching_defaults(),
    )
    model.run()
    trace = json.dumps(model.trace_data(), ensure_ascii=False, separators=(",", ":"))

    layout = (ROOT / "assets/synthetic-layout.webp").read_bytes()
    template = (ROOT / "seven_island_demo.template.html").read_text(encoding="utf-8")
    fields = {
        "__SIMULATION_JSON__": trace,
        "__SIX_ISLAND_ENGINE__": (ROOT / "six_island_engine.js").read_text(encoding="utf-8"),
        "__ARRIVAL_ENGINE__": (ROOT / "scheduling/browser/arrival-engine.js").read_text(encoding="utf-8"),
        "__BATCHING_VIEW__": (ROOT / "batching_island_view.js").read_text(encoding="utf-8"),
        "__LAYOUT_DATA_URI__": "data:image/webp;base64," + base64.b64encode(layout).decode("ascii"),
    }
    for marker, value in fields.items():
        if template.count(marker) != 1:
            raise ValueError(f"模板标记 {marker} 须出现一次。")
        template = template.replace(marker, value)
    hosted_link = '<a href="./scheduling/" class="subtle">S01 批处理策略对照实验</a>'
    hosted.write_text(template.replace("__HOSTED_LINK__", hosted_link), encoding="utf-8", newline="\n")
    if offline is not None:
        offline.write_text(template.replace("__HOSTED_LINK__", ""), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/index.html")
    parser.add_argument("--offline", type=Path)
    args = parser.parse_args()
    build(args.output, args.offline)
