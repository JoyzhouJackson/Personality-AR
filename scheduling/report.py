from collections import defaultdict
from datetime import timedelta
from html import escape


STYLE = """
:root {
  color-scheme: light;
  font-family: system-ui, 'Microsoft YaHei', sans-serif;
  color: #163042;
  background: #f4f7f9;
}
* { box-sizing: border-box; }
body { max-width: 1300px; margin: auto; padding: 26px clamp(14px, 4vw, 46px) 50px; }
h1 { margin: 0; font-size: clamp(24px, 4vw, 38px); letter-spacing: -.03em; }
h2 { margin: 0 0 12px; font-size: 20px; }
p { margin: 8px 0; line-height: 1.65; }
.muted { color: #496476; font-size: 14px; }
.note { border-left: 3px solid #b88336; padding: 7px 13px; background: #fff6e8; }
nav { display: flex; gap: 8px; margin: 23px 0 14px; flex-wrap: wrap; }
nav label { padding: 8px 15px; cursor: pointer; background: white; border: 1px solid #c9d8e3; border-radius: 7px; text-align: center; overflow-wrap: anywhere; }
.case-control { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
.panel { display: none; }
.block { background: #fff; border: 1px solid #d9e3ea; padding: 16px; border-radius: 9px; margin: 15px 0; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(134px, 1fr)); gap: 10px; margin: 0; }
.metrics div { padding: 9px 11px; background: #ecf4f8; border-radius: 5px; }
.metrics dt { font-size: 13px; color: #496476; }
.metrics dd { margin: 4px 0 0; font-weight: 650; }
.scroll { overflow: auto; }
.chart { min-width: 680px; padding: 0 22px 0 0; }
.axis, .machine { display: grid; grid-template-columns: 94px minmax(0, 1fr); }
.axis { min-height: 35px; font-size: 12px; color: #496476; }
.axis-track, .track { position: relative; }
.tick { position: absolute; bottom: 3px; white-space: nowrap; transform: translateX(-50%); }
.tick:first-child { transform: none; }
.axis-unit { align-self: end; padding-bottom: 3px; }
.lane-title { align-self: center; font-size: 14px; padding-right: 10px; }
.track { min-height: 40px; border-bottom: 1px solid #d9e3ea; background: #f5f8fa; }
.machine:first-of-type .track { border-top: 1px solid #d9e3ea; }
.grid-line { position: absolute; height: 100%; width: 1px; background: #d9e3ea; }
.bar { position: absolute; top: 7px; height: 26px; white-space: nowrap; overflow: hidden; border-radius: 3px; }
.batching { background: #146a8b; color: #fff; }
.batching span { display: inline-block; padding: 4px 6px; font-size: 12px; }
.switching { background: #c38734; }
.legend { display: flex; gap: 15px; flex-wrap: wrap; margin: 8px 0 11px; font-size: 13px; }
.swatch { display: inline-block; width: 13px; height: 9px; border-radius: 2px; margin-right: 5px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 7px 9px; text-align: left; border-bottom: 1px solid #e3ebf0; vertical-align: top; }
th { background: #ecf4f8; white-space: nowrap; }
td.time, td.number { white-space: nowrap; font-variant-numeric: tabular-nums; }
tbody tr:nth-child(even) { background: #f8fafb; }
.items { min-width: 180px; overflow-wrap: anywhere; }
@media (max-width: 480px) { nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media print { .panel { display: block; } nav { display: none; } }
"""


def _stamp(start, minutes):
    return (start + timedelta(minutes=minutes)).strftime("%m-%d %H:%M")


def _ticks(horizon):
    options = [60, 120, 240, 360, 480, 720, 1440, 2880, 4320, 10080]
    step = next((item for item in options if horizon <= 8 * item), 1440 * ((horizon + 11519) // 11520))
    return range(0, horizon + 1, step)


def _timeline(result, settings):
    horizon = max(result["makespan"], 1)
    ticks = _ticks(horizon)
    start = settings["start_datetime"]
    batches_by_machine = defaultdict(list)
    for batch in result["batches"]:
        batches_by_machine[batch["machine"]].append(batch)

    axis = "".join(f'<span class="tick" style="left:{100 * tick / horizon:.5f}%">{tick // 60}</span>' for tick in ticks)
    grid = "".join(f'<span class="grid-line" style="left:{100 * tick / horizon:.5f}%"></span>' for tick in ticks)
    lanes = []
    for machine in range(1, result["machine_count"] + 1):
        bars = []
        for batch in sorted(batches_by_machine[machine], key=lambda item: item["process_start"]):
            begin = batch["process_start"]
            end = batch["process_end"]
            switch = batch["switch_start"]
            if switch is not None and settings["switch_minutes"]:
                switch_end = min(begin, switch + settings["switch_minutes"])
                bars.append(f'<span class="bar switching" style="left:{100 * switch / horizon:.5f}%;width:{100 * (switch_end - switch) / horizon:.5f}%" title="切换 {_stamp(start, switch)} 至 {_stamp(start, switch_end)}"></span>')
            name = escape(str(batch["batch_id"]))
            title = f'{name} · 批处理 {_stamp(start, begin)} 至 {_stamp(start, end)} · 后处理完成 {_stamp(start, batch["finish"])}'
            bars.append(f'<span class="bar batching" style="left:{100 * begin / horizon:.5f}%;width:{100 * (end - begin) / horizon:.5f}%" title="{title}"><span>{name}</span></span>')
        lanes.append(f'<div class="machine"><div class="lane-title">批处理设备 {machine}</div><div class="track">{grid}{"".join(bars)}</div></div>')
    return f'''<div class="scroll"><div class="chart">
      <div class="axis"><div class="axis-unit">累计小时</div><div class="axis-track">{axis}</div></div>
      {''.join(lanes)}</div></div>'''


def _batch_rows(batches, start):
    rows = []
    for batch in batches:
        allocation = "、".join(escape(str(item["order_id"])) for item in batch["allocations"])
        stamps = "".join(f'<td class="time">{_stamp(start, batch[key])}</td>' for key in ("prep_start", "process_start", "process_end", "finish"))
        rows.append(f'''<tr><td>{escape(str(batch["batch_id"]))}</td><td class="number">{batch["machine"]}</td>
          <td class="number">{len(batch["allocations"])}</td><td class="number">{batch["part_ab"]}</td><td class="number">{batch["part_c"]}</td>
          <td class="items">{allocation}</td>{stamps}</tr>''')
    return "".join(rows)


def _order_rows(orders, start):
    rows = []
    for order in orders:
        batches = "、".join(escape(str(batch_id)) for batch_id in order["batch_ids"])
        rows.append(f'''<tr><td>{escape(str(order["order_id"]))}</td><td class="number">{order["part_ab"]}</td>
          <td class="number">{order["part_c"]}</td><td>{batches}</td>
          <td class="time">{_stamp(start, order["finish"])}</td><td class="number">{order["flow_time"]}</td></tr>''')
    return "".join(rows)


def _panel(index, name, result, settings):
    start = settings["start_datetime"]
    stats = [
        ("订单数", len(result["orders"])),
        ("批处理设备数", result["machine_count"]),
        ("批处理批次数", len(result["batches"])),
        ("平均订单用时", f'{result["mean_flow_time"]:,.1f} 分钟/单'),
        ("最后一单齐套", _stamp(start, result["makespan"])),
    ]
    metrics = "".join(f"<div><dt>{label}</dt><dd>{value}</dd></div>" for label, value in stats)
    return f'''<section id="panel-{index}" class="panel" aria-labelledby="label-{index}">
      <dl class="metrics">{metrics}</dl>
      <section class="block">
        <h2>{escape(str(name))}批处理设备甘特图</h2>
        <div class="legend"><span><i class="swatch batching"></i>批处理占机</span><span><i class="swatch switching"></i>批间切换</span></div>
        {_timeline(result, settings)}
        <p class="muted">横轴从排产起点开始。批处理前准备和后处理均在机外进行，各盘的起止时间列在下表。</p>
      </section>
      <section class="block">
        <h2>整套合批方案</h2>
        <div class="scroll"><table><thead><tr><th>批次</th><th>批处理设备</th><th>套数</th><th>部件A/B</th><th>部件C</th><th>同盘订单</th><th>准备开始</th><th>批处理开始</th><th>批处理结束</th><th>后处理完成</th></tr></thead>
        <tbody>{_batch_rows(result['batches'], start)}</tbody></table></div>
      </section>
      <section class="block">
        <h2>逐单预计完工</h2>
        <div class="scroll"><table><thead><tr><th>订单</th><th>部件A/B</th><th>部件C</th><th>所在批次</th><th>齐套时间</th><th>订单用时（分钟）</th></tr></thead>
        <tbody>{_order_rows(result['orders'], start)}</tbody></table></div>
      </section></section>'''


def render_report(results, settings):
    """Render static schedules, without loading external scripts or assets."""
    controls = []
    labels = []
    panels = []
    styles = []
    for index, (name, result) in enumerate(results.items()):
        checked = ' checked' if index == 0 else ''
        controls.append(f'<input class="case-control" type="radio" name="scenario" id="case-{index}" aria-labelledby="label-{index}"{checked}>')
        labels.append(f'<label id="label-{index}" for="case-{index}">{escape(str(name))}</label>')
        panels.append(_panel(index, name, result, settings))
        styles.append(f'''#case-{index}:checked ~ main #panel-{index} {{ display: block; }}
          #case-{index}:checked ~ nav #label-{index} {{ background: #146a8b; color: #fff; border-color: #146a8b; }}
          #case-{index}:focus-visible ~ nav #label-{index} {{ outline: 2px solid #163042; outline-offset: 2px; }}''')
    start = settings["start_datetime"].strftime("%Y-%m-%d %H:%M")
    return f'''<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>S01 批处理整套合批与排产</title>
<style>{STYLE}{''.join(styles)}</style>
<body>
{''.join(controls)}
<header>
  <a href="./index.html">返回报告首页</a>
  <h1>S01 批处理整套合批与排产</h1>
  <p class="muted">排产起点 {start} · 机外准备 {settings['prep_minutes']} 分钟 · 机外后处理 {settings['post_minutes']} 分钟 · 同机批间切换 {settings['switch_minutes']} 分钟</p>
  <p>此页采用虚构的合成样例。A、B、C 三种部件同盘处理，容量按 <strong>A/B 合计数 + 2 × C 数 ≤ 32</strong> 计算，每盘最多 <strong>8 套</strong>。</p>
  <p>每张订单的用时从该单到达算到所在批次后处理完成，再对各单取平均。静态场景中所有订单同时在排产起点到达。</p>
  <p class="note">动态规划在启用的合成组合及工时下，求得平均订单用时最短的排程。示例只用于演示算法。</p>
</header>
<nav aria-label="场景">{''.join(labels)}</nav>
<main>{''.join(panels)}</main>
</body>
</html>'''
