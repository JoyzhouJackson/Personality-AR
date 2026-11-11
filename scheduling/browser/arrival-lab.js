(() => {
  "use strict";

  const fields = [
    ["orderCount", "订单数", 24, 1, 200, 1, "单", "这次要模拟的订单总数，1–200 单。"],
    ["machineCount", "批处理设备数", 3, 1, globalThis.ArrivalEngine.maxMachines, 1, "台", `同时可用的同型号批处理设备，最多 ${globalThis.ArrivalEngine.maxMachines} 台。`],
    ["meanInterval", "平均到单间隔", 5, 1, 1440, "any", "分钟", "平均隔多久来一单。数值越大，到单越慢。"],
    ["waitMinutes", "最长等单时间", 2, 0, 1440, 1, "分钟", "可启动但还没满盘时，最多等多久。填 0 表示立即启动。"],
  ];
  const scanFields = [
    ["intervalStart", "到单间隔起点", 2, 1, 1440, "any", "分钟"],
    ["intervalEnd", "到单间隔终点", 45, 1, 1440, "any", "分钟"],
    ["intervalStep", "扫描步长", 1, null, 1440, "any", "分钟"],
  ];
  const numberFormat = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function displayMinutes(value) {
    return numberFormat.format(value);
  }

  function buildField([name, label, value, min, max, step, unit, hint]) {
    const group = element("label", "arrival-lab-field");
    const input = element("input");
    input.name = name;
    input.type = "number";
    input.value = value;
    if (min !== null) input.min = min;
    if (max !== null) input.max = max;
    input.step = step;
    input.required = true;
    input.inputMode = step === "any" ? "decimal" : "numeric";
    group.append(element("span", "", unit ? `${label}（${unit}）` : label), input);
    if (hint) {
      const help = element("small", "muted", hint);
      help.id = `${name}-help`;
      group.append(help);
      input.setAttribute("aria-describedby", help.id);
    }
    return group;
  }

  function stepHeading(number, title, description) {
    const header = element("div", "arrival-step-heading");
    const content = element("div");
    const badge = element("span", "arrival-step-number", number);
    badge.setAttribute("aria-hidden", "true");
    content.append(element("h2", "", title), element("p", "muted", description));
    header.append(badge, content);
    return header;
  }

  function expandable(title, ...children) {
    const details = element("details", "arrival-lab-option");
    const content = element("div", "arrival-option-content");
    content.append(...children);
    details.append(element("summary", "", title), content);
    return details;
  }

  function processEditor(defaults) {
    const storageKey = "public-demo.s01.batch-times.v1";
    const maxMinutes = 1_000_000_000;
    let saved = null;
    try {
      const candidate = JSON.parse(localStorage.getItem(storageKey));
      if (Array.isArray(candidate) && candidate.length === defaults.length && defaults.every((minutes, size) => {
        const value = candidate[size];
        return minutes === null ? value === null : Number.isInteger(value) && value >= 1 && value <= maxMinutes;
      })) saved = candidate;
    } catch {
      // A missing or unreadable saved set leaves the built-in defaults available.
    }

    const processInputs = element("div", "arrival-print-inputs");
    const controls = (saved ?? defaults).map((minutes, size) => {
      if (minutes === null) return null;
      const field = buildField([`print-${size}`, `${size} 单同盘`, minutes, 1, maxMinutes, 1]);
      const input = field.querySelector("input");
      input.setAttribute("aria-label", `${size} 单同盘批处理时间（分钟）`);
      input.autocomplete = "off";
      processInputs.append(field);
      return input;
    });
    const durations = () => controls.map(input => input?.valueAsNumber ?? null);

    const save = element("button", "arrival-primary", "保存工时");
    save.type = "button";
    const reset = element("button", "arrival-secondary", "恢复默认值");
    reset.type = "button";
    const state = element("p", "muted arrival-print-state");
    state.setAttribute("role", "status");
    function updateState() {
      const lastValues = saved ?? defaults;
      const dirty = durations().some((minutes, size) => minutes !== lastValues[size]);
      state.textContent = dirty ? "有未保存的工时修改" : saved ? "工时已保存到当前浏览器" : "使用默认工时";
    }
    updateState();
    processInputs.addEventListener("input", updateState);
    save.addEventListener("click", () => {
      const invalid = processInputs.querySelector("input:invalid");
      if (invalid) {
        state.textContent = "请填写有效的整盘批处理分钟数后再保存。";
        invalid.reportValidity();
        return;
      }
      const minutes = durations();
      try {
        localStorage.setItem(storageKey, JSON.stringify(minutes));
        saved = minutes;
        updateState();
      } catch {
        state.textContent = "当前浏览器无法保存工时。本页仍可使用这些值进行模拟。";
      }
    });
    reset.addEventListener("click", () => {
      const changed = durations().some((minutes, size) => minutes !== defaults[size]);
      controls.forEach((input, size) => {
        if (input) input.value = defaults[size];
      });
      if (changed) processInputs.dispatchEvent(new Event("input", { bubbles: true }));
      try {
        localStorage.removeItem(storageKey);
        saved = null;
        state.textContent = "已恢复默认工时";
      } catch {
        state.textContent = "当前页面已恢复默认工时。浏览器无法清除先前保存的工时。";
      }
    });

    const tools = element("div", "arrival-print-tools");
    const actions = element("div", "arrival-print-actions");
    actions.append(save, reset);
    tools.append(actions, state);
    const editor = element("div", "arrival-print-editor");
    editor.append(processInputs, tools, element("p", "muted", "填写整盘批处理时间，准备、切换和后处理另计。保存后，下次在此浏览器打开会沿用。未保存的修改也可用于本次模拟。"));
    return { editor, durations };
  }

  function appendRow(section, labels, header = false) {
    const row = element("tr");
    labels.forEach((label, index) => {
      const isHeading = header || index === 0;
      const cell = element(isHeading ? "th" : "td", "", label);
      if (isHeading) cell.scope = header ? "col" : "row";
      row.append(cell);
    });
    section.append(row);
  }

  function summaryMetrics({ immediate, waiting }, params) {
    const metrics = element("div", "arrival-metrics");
    for (const [title, description, key, unit] of [
      ["平均订单用时", "每单从到达到后处理完成的平均时间，作为策略比较依据。", "mean_flow_time", "分钟/单"],
      ["整批完工用时", "从首单到达到最后一单完成的平均时间。", "mean_makespan", "分钟"],
    ]) {
      const metric = element("section", "arrival-metric");
      const values = element("dl", "arrival-metric-values");
      for (const [label, value] of [["立即启动", immediate[key]], [`限时等单 ${params.waitMinutes} 分钟`, waiting[key]]]) {
        const valueGroup = element("div");
        const displayed = element("dd", "", displayMinutes(value));
        displayed.append(element("small", "", ` ${unit}`));
        valueGroup.append(element("dt", "", label), displayed);
        values.append(valueGroup);
      }
      metric.append(element("h3", "", title), element("p", "muted", description), values);
      metrics.append(metric);
    }
    return metrics;
  }

  function timeTicks(horizon) {
    const steps = [15, 30, 60, 120, 240, 480, 720, 1440, 2880, 4320, 7200, 10080];
    const step = steps.find(candidate => horizon <= candidate * 8)
      ?? Math.ceil(horizon / (8 * 1440)) * 1440;
    return Array.from({ length: Math.floor(horizon / step) + 1 }, (_, index) => index * step);
  }

  function trackRow(title, trackClass = "arrival-lab-track") {
    const row = element("div", "arrival-lab-track-row");
    const lane = element("div", trackClass);
    row.append(element("span", "arrival-lab-lane-label", title), lane);
    return { row, lane };
  }

  function marker(className, percent, title, width) {
    const mark = element("span", className);
    mark.style.left = percent;
    if (width !== undefined) mark.style.width = width;
    if (title) mark.title = title;
    return mark;
  }

  function strategyChart(title, result, arrivals, horizon, params) {
    const arm = element("section", "arrival-lab-arm");
    arm.append(element("h4", "", `${title} · 平均订单用时 ${displayMinutes(result.mean_flow_time)} 分钟/单 · 最后一单第 ${result.makespan} 分钟齐套`));
    const firstOrder = result.orders[0];
    const firstBatch = result.batches.find(batch => batch.batch_id === firstOrder?.batch_id);
    if (firstBatch) {
      arm.append(element("p", "arrival-lab-first-order", `首单第 ${firstBatch.prep_start} 分钟开始准备，第 ${firstBatch.process_start} 分钟上机批处理`));
    }
    const at = minute => `${100 * minute / horizon}%`;
    const ticks = timeTicks(horizon);
    const axis = trackRow("累计小时");
    axis.row.classList.add("arrival-lab-axis");
    for (const tick of ticks) {
      const label = marker("arrival-lab-tick", at(tick));
      label.textContent = tick / 60;
      axis.lane.append(label);
    }
    arm.append(axis.row);

    function addGrid(lane) {
      for (const tick of ticks) lane.append(marker("arrival-lab-gridline", at(tick)));
      lane.append(marker("arrival-lab-end", at(result.makespan), `最后一单后处理完成 · 第 ${result.makespan} 分钟`));
    }

    function offlineTracks(batches, startKey, endKey, phase, label) {
      const tracks = [];
      for (const batch of batches) {
        const start = batch[startKey];
        const end = batch[endKey];
        if (end <= start) continue;
        let track = tracks.find(candidate => candidate.end <= start);
        if (!track) {
          const lane = element("div", "arrival-lab-track arrival-lab-offline-track");
          addGrid(lane);
          track = { lane, end };
          tracks.push(track);
        }
        track.end = end;
        track.lane.append(marker(`arrival-lab-bar arrival-lab-${phase}`, at(start),
          `${batch.batch_id} · ${label} · 第 ${start} 至 ${end} 分钟`, at(end - start)));
      }
      return tracks.map(track => track.lane);
    }

    const arrivalRow = trackRow("订单到达");
    arrivalRow.row.classList.add("arrival-lab-arrivals");
    addGrid(arrivalRow.lane);
    arrivals.forEach((minute, index) => {
      arrivalRow.lane.append(marker("arrival-lab-arrival", at(minute), `订单 ${index + 1} · 第 ${minute} 分钟到达`));
    });
    arm.append(arrivalRow.row);

    for (let machine = 1; machine <= params.machineCount; machine++) {
      const { row, lane } = trackRow(`批处理设备 ${machine}`, "arrival-lab-machine-lanes");
      const batches = result.batches.filter(candidate => candidate.machine === machine);
      const machineTrack = element("div", "arrival-lab-track");
      addGrid(machineTrack);
      for (const batch of batches) {
        if (batch.switch_start != null && params.switchMinutes > 0) {
          const end = Math.min(batch.process_start, batch.switch_start + params.switchMinutes);
          const width = end - batch.switch_start;
          if (width > 0) machineTrack.append(marker("arrival-lab-bar arrival-lab-switch", at(batch.switch_start), `批间切换 · 第 ${batch.switch_start} 至 ${end} 分钟`, at(width)));
        }
        const label = `${batch.batch_id} · ${batch.order_ids.length} 套`;
        const tooltip = `${label} · 第 ${batch.process_start} 至 ${batch.process_end} 分钟批处理 · 第 ${batch.finish} 分钟后处理完成 · 订单 ${batch.order_ids.join("、")}`;
        const print = marker("arrival-lab-bar arrival-lab-print", at(batch.process_start), tooltip, at(batch.process_end - batch.process_start));
        print.textContent = label;
        machineTrack.append(print);
      }
      lane.append(...offlineTracks(batches, "prep_start", "process_start", "prep", "批处理前准备"), machineTrack,
        ...offlineTracks(batches, "process_end", "finish", "post", "批处理后处理"));
      arm.append(row);
    }
    return arm;
  }

  function representativeChart(example, params) {
    const { arrivals, immediate, waiting, replicate } = example;
    const section = element("section", "arrival-lab-results");
    section.append(element("h3", "", "代表性到单序列与排程"));
    section.append(element("p", "muted", `第 ${replicate} 次模拟，按两种策略的整批用时差接近中位数选取。两图共用时间轴。准备和后处理在机外进行，按关联批处理设备分行展示。`));
    const legend = element("div", "arrival-lab-legend");
    for (const [className, label] of [["arrive", "订单到达"], ["prep", "机外准备"], ["process", "批处理占机"], ["post", "机外后处理"], ["switch", "批间切换"], ["end", "最后一单齐套"]]) {
      const item = element("span");
      item.append(element("i", `arrival-lab-key arrival-lab-${className}-key`), document.createTextNode(label));
      legend.append(item);
    }
    section.append(legend);
    const maxFinish = Math.max(immediate.makespan, waiting.makespan, ...arrivals);
    const horizon = maxFinish + Math.max(30, Math.ceil(maxFinish * 0.04));
    const scroll = element("div", "arrival-lab-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "代表性排程甘特图，可横向滚动");
    const chart = element("div", "arrival-lab-chart");
    chart.append(strategyChart("立即启动", immediate, arrivals, horizon, params));
    chart.append(strategyChart(`限时等单 ${params.waitMinutes} 分钟`, waiting, arrivals, horizon, params));
    scroll.append(chart);
    section.append(scroll);
    return section;
  }

  function svgElement(tag, attributes, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scanNumber(value, maximumFractionDigits = 6) {
    return value.toLocaleString("zh-CN", { maximumFractionDigits });
  }

  function scanDifference(value) {
    if (value === 0) return "0";
    return `${value < 0 ? "−" : "+"}${scanNumber(Math.abs(value))}`;
  }

  function signClass(delta) {
    if (delta < 0) return "arrival-scan-faster";
    if (delta > 0) return "arrival-scan-slower";
    return "arrival-scan-tie";
  }

  function currentAdvice({ delta, lower, upper }, params) {
    const waiting = upper < 0;
    const card = element("section", `arrival-lab-advice${waiting ? " arrival-lab-advice-wait" : ""}`);
    const heading = waiting ? `建议限时等单 ${params.waitMinutes} 分钟` : "建议立即启动";
    const reason = waiting || lower > 0
      ? `在当前设置下，${waiting ? "限时等单" : "立即启动"}平均每单少用 ${scanNumber(Math.abs(delta), 2)} 分钟。`
      : delta === 0 && lower === 0 && upper === 0
        ? "本次模拟中两种策略用时相同，可直接启动。"
        : "两种策略的用时差异尚不明确，优先立即启动。";
    card.append(element("h3", "", heading), element("p", "", reason));
    return card;
  }

  function scanRanges(points, qualifies) {
    const ranges = [];
    let current;
    for (const point of points) {
      if (!qualifies(point)) {
        current = undefined;
      } else if (current) {
        current.end = point.interval;
      } else {
        current = { start: point.interval, end: point.interval };
        ranges.push(current);
      }
    }
    return ranges.map(({ start, end }) => start === end ? scanNumber(start) : `${scanNumber(start)}–${scanNumber(end)}`).join("、");
  }

  function scanAdvice(points, params) {
    const card = element("section", "arrival-lab-advice arrival-lab-advice-ranges");
    card.append(element("h3", "", "到单速度变了，什么时候适合等单？"));
    if (params.waitMinutes === 0) {
      card.append(element("p", "", "等单上限为 0 分钟时，两种策略相同。可设置正的等单上限，再比较不同到单间隔。"));
      return card;
    }
    if (params.orderCount === 1) {
      card.append(element("p", "", "当前只有 1 单。比较等单合批的效果至少需要 2 单。"));
      return card;
    }
    const waitingWins = point => point.upper < 0;
    const immediate = scanRanges(points, point => point.lower > 0);
    const waiting = scanRanges(points, waitingWins);
    card.append(element("p", "", immediate ? `立即启动更快的采样间隔为 ${immediate} 分钟。` : "本次扫描未发现立即启动有明确优势的采样点。"),
      element("p", "", waiting ? `限时等单更快的采样间隔为 ${waiting} 分钟。` : "本次扫描未发现等单有明确优势的采样点。"));
    let nearest;
    for (const point of points) {
      if (waitingWins(point) && (!nearest || Math.abs(point.interval - params.meanInterval) < Math.abs(nearest.interval - params.meanInterval))) {
        nearest = point;
      }
    }
    if (nearest) {
      const change = nearest.interval - params.meanInterval;
      const changeText = Math.abs(change) < 1e-9 ? "与当前设定相同" : `比当前${change < 0 ? "缩短" : "延长"} ${scanNumber(Math.abs(change))} 分钟`;
      card.append(element("p", "", `离当前最近的等单优势点是平均每 ${scanNumber(nearest.interval)} 分钟来一单（${changeText}），平均每单少用 ${scanNumber(-nearest.delta, 2)} 分钟。`));
    }
    if (points.some(point => point.lower <= 0 && point.upper >= 0)) {
      card.append(element("p", "muted", "差异不明确或持平的采样点，优先立即启动。"));
    }
    return card;
  }

  function scanPlot({ points, crossings, ties }) {
    const width = 760, height = 310;
    const left = 94, right = 731, top = 32, bottom = 252;
    const minInterval = points[0].interval;
    const maxInterval = points[points.length - 1].interval;
    const times = points.flatMap(point => [point.immediate_mean, point.waiting_mean]);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const padding = Math.max(1, (maxTime - minTime) * 0.06, maxTime * 0.005);
    const rawStep = (maxTime - minTime + 2 * padding) / 5;
    const scale = 10 ** Math.floor(Math.log10(rawStep));
    const tickStep = [1, 2, 2.5, 5, 10].find(step => step * scale >= rawStep) * scale;
    const firstTick = Math.max(0, Math.floor((minTime - padding) / tickStep));
    const lastTick = Math.ceil((maxTime + padding) / tickStep);
    const x = interval => left + (right - left) * (interval - minInterval) / (maxInterval - minInterval);
    const y = minutes => top + (bottom - top) * (lastTick - minutes / tickStep) / (lastTick - firstTick);
    const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": "arrival-scan-chart-title arrival-scan-chart-desc" });
    svg.append(svgElement("title", { id: "arrival-scan-chart-title" }, "立即启动与限时等单的平均订单用时"),
      svgElement("desc", { id: "arrival-scan-chart-desc" }, "横轴为平均到单间隔，纵轴为平均订单用时。同一到单间隔下，位置更低的曲线用时更短，菱形标出估计交叉点。"));

    for (let tick = firstTick; tick <= lastTick; tick++) {
      const minutes = tick * tickStep;
      const gridY = y(minutes);
      svg.append(svgElement("line", { x1: left, x2: right, y1: gridY, y2: gridY, class: "arrival-scan-grid" }),
        svgElement("text", { x: left - 8, y: gridY + 4, "text-anchor": "end" }, scanNumber(minutes)));
    }
    const tickCount = Math.min(points.length, 7);
    for (let index = 0; index < tickCount; index++) {
      const point = points[Math.round(index * (points.length - 1) / (tickCount - 1))];
      const tickX = x(point.interval);
      svg.append(svgElement("line", { x1: tickX, x2: tickX, y1: top, y2: bottom + 4, class: "arrival-scan-grid" }),
        svgElement("text", { x: tickX, y: bottom + 21, "text-anchor": "middle" }, scanNumber(point.interval)));
    }
    svg.append(svgElement("path", { d: `M${left} ${top}V${bottom}H${right}`, class: "arrival-scan-axis" }),
      svgElement("text", { x: (left + right) / 2, y: bottom + 45, "text-anchor": "middle" }, "平均到单间隔（分钟）"),
      svgElement("text", { x: left, y: top - 11 }, "平均订单用时（分钟/单）"));

    const plotPoints = (series, key) => series.map(point => `${x(point.interval)},${y(point[key])}`).join(" ");
    for (const tie of ties) {
      const samples = points.filter(point => point.interval >= tie.start && point.interval <= tie.end);
      const band = samples.length === 1
        ? svgElement("circle", { cx: x(tie.start), cy: y(samples[0].immediate_mean), r: 6, class: "arrival-scan-tie-point" })
        : svgElement("polyline", { points: plotPoints(samples, "immediate_mean"), class: "arrival-scan-tie-mark" });
      const range = tie.start === tie.end ? scanNumber(tie.start) : `${scanNumber(tie.start)}–${scanNumber(tie.end)}`;
      band.append(svgElement("title", {}, `持平采样间隔 ${range} 分钟`));
      svg.append(band);
    }

    for (const [className, key, label] of [
      ["arrival-scan-immediate", "immediate_mean", "立即启动"],
      ["arrival-scan-waiting", "waiting_mean", "限时等单"],
    ]) {
      const series = svgElement("g", { class: className });
      series.append(svgElement("polyline", { points: plotPoints(points, key), class: "arrival-scan-curve" }));
      for (const point of points) {
        const dot = svgElement("circle", { cx: x(point.interval), cy: y(point[key]), r: 2.5, class: "arrival-scan-dot" });
        dot.append(svgElement("title", {}, `间隔 ${scanNumber(point.interval)} 分钟，${label} ${displayMinutes(point[key])} 分钟/单`));
        series.append(dot);
      }
      svg.append(series);
    }

    const samplesByInterval = new Map(points.map(point => [point.interval, point]));
    for (const crossing of crossings) {
      const start = samplesByInterval.get(crossing.lowerInterval);
      const end = samplesByInterval.get(crossing.upperInterval);
      const fraction = (crossing.interval - start.interval) / (end.interval - start.interval);
      const minutes = start.immediate_mean + fraction * (end.immediate_mean - start.immediate_mean);
      const crossX = x(crossing.interval);
      const crossY = y(minutes);
      const cross = svgElement("path", { d: `M${crossX} ${crossY - 6} L${crossX + 6} ${crossY} L${crossX} ${crossY + 6} L${crossX - 6} ${crossY} Z`, class: "arrival-scan-crossing" });
      cross.append(svgElement("title", {}, `估计交叉点：到单间隔 ${scanNumber(crossing.interval, 2)} 分钟，两种策略约 ${displayMinutes(minutes)} 分钟/单`));
      svg.append(svgElement("line", { x1: crossX, x2: crossX, y1: crossY, y2: bottom, class: "arrival-scan-crossing-guide" }), cross);
    }
    return svg;
  }

  function scanResults(result, params) {
    const { points, crossings, ties, replicates } = result;
    const section = element("section", "arrival-lab-results");
    section.append(element("h3", "", "两种策略的平均订单用时"), element("p", "muted",
      `${params.orderCount} 单 · ${params.machineCount} 台 · 等单上限 ${params.waitMinutes} 分钟 · 扫描 ${scanNumber(params.intervalStart)}–${scanNumber(params.intervalEnd)} 分钟，步长 ${scanNumber(params.intervalStep)} 分钟 · ${points.length} 个到单间隔 · 每点 ${replicates} 次配对模拟`));
    const legend = element("p", "arrival-scan-legend");
    for (const [className, label] of [["arrival-scan-immediate", "立即启动"], ["arrival-scan-waiting", "限时等单"], ["arrival-scan-crossing-text", "◆ 估计交叉点"], ["arrival-scan-tie-text", "重合处持平"]]) {
      legend.append(element("span", className, label));
    }

    const plotScroll = element("div", "arrival-lab-scroll arrival-scan-plot");
    plotScroll.tabIndex = 0;
    plotScroll.setAttribute("role", "region");
    plotScroll.setAttribute("aria-label", "两种策略的平均订单用时对比，可横向滚动");
    plotScroll.append(scanPlot(result));
    section.append(element("p", "arrival-scan-findings", crossings.length
      ? `估计临界点为 ${crossings.map(point => scanNumber(point.interval, 2)).join("、")} 分钟。`
      : ties.length ? "图中标出了两种策略用时持平的采样点或区间。" : "本次扫描未找到两条曲线的交叉点。"));
    if (crossings.length || ties.length) {
      const findings = element("ul");
      const pointsByInterval = new Map(points.map(point => [point.interval, point]));
      for (const crossing of crossings) {
        const endpoints = [pointsByInterval.get(crossing.lowerInterval), pointsByInterval.get(crossing.upperInterval)];
        const uncertainty = endpoints.some(point => point && point.lower <= 0 && point.upper >= 0)
          ? "至少一端的 95% 配对置信区间包含零。" : "两端的 95% 配对置信区间均排除零。";
        findings.append(element("li", "", `临界点约 ${scanNumber(crossing.interval, 2)} 分钟，所在采样区间 ${scanNumber(crossing.lowerInterval)}–${scanNumber(crossing.upperInterval)} 分钟。${uncertainty}`));
      }
      for (const tie of ties) {
        const range = tie.start === tie.end ? scanNumber(tie.start) : `${scanNumber(tie.start)}–${scanNumber(tie.end)}`;
        findings.append(element("li", "", `到单间隔 ${range} 分钟的采样点持平。`));
      }
      section.append(expandable("查看临界点与持平区间明细", findings));
    }
    section.append(legend, plotScroll,
      element("p", "muted", "同一到单间隔下，位置更低的曲线用时更短。交叉点由相邻采样均值估算，策略建议依据逐点数据中的 95% 配对置信区间。"));

    const scroll = element("div", "arrival-lab-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "到单间隔逐点结果，可横向滚动");
    const table = element("table", "arrival-lab-table arrival-scan-table");
    const head = element("thead");
    const body = element("tbody");
    appendRow(head, ["到单间隔（分钟）", "立即启动", "限时等单", "差值 Δ", "配对差 95% 置信区间", "样本均值比较"], true);
    for (const point of points) {
      appendRow(body, [scanNumber(point.interval), displayMinutes(point.immediate_mean), displayMinutes(point.waiting_mean), scanDifference(point.delta),
        `[${scanDifference(point.lower)}, ${scanDifference(point.upper)}]`, point.delta < 0 ? "等单更快" : point.delta > 0 ? "立即更快" : "持平"]);
      body.lastElementChild.lastElementChild.className = signClass(point.delta);
    }
    table.append(head, body);
    scroll.append(table);
    section.append(expandable("查看逐点数据", scroll));
    return section;
  }

  function operationControls(label, cancelLabel) {
    const button = element("button", "arrival-lab-submit", label);
    button.type = "submit";
    const cancel = element("button", "arrival-scan-cancel", cancelLabel);
    cancel.type = "button";
    cancel.hidden = true;
    const buttons = element("div", "arrival-scan-buttons");
    buttons.append(button, cancel);
    const status = element("p", "muted arrival-lab-status");
    status.setAttribute("role", "status");
    const progress = element("progress", "arrival-lab-progress");
    progress.setAttribute("aria-label", `${label}进度`);
    progress.hidden = true;
    const error = element("p", "arrival-lab-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    return { button, cancel, buttons, status, progress, error };
  }

  function inputValues(form, definitions) {
    return Object.fromEntries(definitions.map(([name]) => [name, form.elements.namedItem(name).valueAsNumber]));
  }

  function validateInputs(form, error) {
    const invalid = form.querySelector("input:invalid");
    if (!invalid) return true;
    error.textContent = `请检查「${invalid.labels[0].firstElementChild.textContent}」的填写。`;
    error.hidden = false;
    form.reportValidity();
    return false;
  }

  function install() {
    const root = document.querySelector("#arrival-lab");
    if (!root) return;
    const defaults = JSON.parse(root.dataset.config);
    const form = element("form", "arrival-lab-form");
    form.noValidate = true;
    const batching = element("section", "arrival-panel");
    const batchingFields = element("fieldset", "arrival-settings-fields");
    batchingFields.setAttribute("aria-label", "批处理组合时间表");
    const { editor, durations } = processEditor(defaults.durations);
    batchingFields.append(editor);
    batching.append(stepHeading("1", "设置合成批次时间表", "每单由 A、B、C 三个虚构部件组成，默认工时为合成示例。"), batchingFields);

    const setup = element("section", "arrival-panel");
    const setupFields = element("fieldset", "arrival-settings-fields");
    setupFields.setAttribute("aria-label", "模拟参数");
    const inputs = element("div", "arrival-lab-inputs");
    inputs.append(...fields.map(buildField));
    setupFields.append(inputs);
    setup.append(stepHeading("2", "设置模拟参数", "填写这次要模拟的订单数量、批处理设备数量和到单条件。"), setupFields);

    const run = element("section", "arrival-panel arrival-run-panel");
    const compareUI = operationControls("运行模拟", "取消模拟");
    const viewResults = element("a", "arrival-secondary arrival-result-link", "查看结果");
    viewResults.href = "#arrival-results";
    viewResults.hidden = true;
    compareUI.buttons.append(viewResults);
    run.append(stepHeading("3", "运行模拟", "比较有单就开与限时等单。两种策略共用同一批随机到达的订单。"),
      compareUI.buttons, compareUI.status, compareUI.progress, compareUI.error);
    form.append(batching, setup, run);

    const results = element("section", "arrival-panel arrival-result-panel");
    results.id = "arrival-results";
    const empty = element("p", "arrival-empty", "点击「运行模拟」后，这里会显示推荐策略、用时对比和甘特图。");
    const stale = element("p", "arrival-stale", "工时或模拟参数已修改。以下为上次结果，请重新运行。");
    stale.hidden = true;
    const output = element("div", "arrival-lab-output");
    results.append(stepHeading("4", "查看模拟结果与甘特图", "先看当前条件下的推荐策略和用时，再展开甘特图查看实际排程示例。"), empty, stale, output);

    const scanPanel = element("section", "arrival-panel arrival-scan-panel");
    const scanForm = element("form", "arrival-scan-form");
    scanForm.noValidate = true;
    const scanSettings = element("fieldset", "arrival-settings-fields");
    scanSettings.setAttribute("aria-label", "到单间隔扫描范围");
    const scanInputs = element("div", "arrival-lab-inputs");
    scanInputs.append(...scanFields.map(buildField));
    const scanUI = operationControls("扫描临界点", "取消扫描");
    const scanContext = element("p", "arrival-scan-context arrival-empty", "先完成上方模拟，再调整要测试的到单间隔范围。");
    const scanStale = element("p", "arrival-stale", "下方为上次扫描结果，请按当前设置重新扫描。");
    scanStale.hidden = true;
    const scanOutput = element("div", "arrival-lab-output");
    scanSettings.append(scanInputs);
    scanForm.append(scanSettings, scanUI.buttons, scanUI.status, scanUI.progress, scanUI.error);
    scanPanel.append(stepHeading("5", "改变到单速度，查看临界点", "保持工时和其他参数不变，只改变平均隔多久来一单，判断何时立即启动、何时限时等单。"),
      scanContext, scanForm, scanStale, scanOutput);
    root.append(form, results, scanPanel);

    let controller;
    let scenario;
    const initialRange = inputValues(scanForm, scanFields);
    let scanDefaults = initialRange;

    function updateControls() {
      const busy = Boolean(controller);
      batchingFields.disabled = busy;
      setupFields.disabled = busy;
      compareUI.button.disabled = busy;
      scanSettings.disabled = busy || !scenario;
      scanUI.button.disabled = scanSettings.disabled;
    }

    function updateScanDefaults(meanInterval) {
      if (!scanFields.every(([name]) => scanForm.elements.namedItem(name).valueAsNumber === scanDefaults[name])) return;
      const intervalStart = Math.min(initialRange.intervalStart, meanInterval);
      const intervalEnd = Math.max(initialRange.intervalEnd, meanInterval);
      scanDefaults = {
        intervalStart,
        intervalEnd,
        intervalStep: Math.max(initialRange.intervalStep, Math.ceil((intervalEnd - intervalStart) / 59)),
      };
      for (const [name, value] of Object.entries(scanDefaults)) scanForm.elements.namedItem(name).value = value;
    }

    async function runOperation(label, controls, task) {
      controller = new AbortController();
      const { signal } = controller;
      const { cancel, status, progress, error } = controls;
      cancel.disabled = false;
      cancel.hidden = false;
      status.textContent = `正在${label}…`;
      progress.removeAttribute("value");
      progress.hidden = false;
      error.hidden = true;
      updateControls();
      function reportProgress(completed, total) {
        if (signal.aborted) return;
        progress.max = total;
        progress.value = completed;
        status.textContent = `正在${label} ${completed} / ${total} 次配对模拟`;
      }
      try {
        status.textContent = await task(signal, reportProgress);
      } catch (failure) {
        status.textContent = signal.aborted ? `已取消${label}。` : "";
        if (!signal.aborted) {
          error.textContent = `${label}失败。${failure instanceof Error ? failure.message : String(failure)}`;
          error.hidden = false;
        }
      } finally {
        controller = undefined;
        cancel.hidden = true;
        progress.hidden = true;
        updateControls();
      }
    }

    function connectCancel({ cancel, status }) {
      cancel.addEventListener("click", () => {
        controller?.abort();
        cancel.disabled = true;
        status.textContent = "正在取消…";
      });
    }

    connectCancel(compareUI);
    connectCancel(scanUI);
    updateControls();

    form.addEventListener("input", () => {
      compareUI.error.hidden = true;
      scanUI.error.hidden = true;
      if (!output.hasChildNodes()) return;
      scenario = undefined;
      stale.hidden = false;
      scanStale.hidden = !scanOutput.hasChildNodes();
      scanContext.textContent = "工时或模拟参数已修改。请先重新运行模拟，再扫描临界点。";
      compareUI.status.textContent = "设置已修改，可以重新运行。";
      scanUI.status.textContent = "";
      updateControls();
    });

    scanForm.addEventListener("input", () => {
      scanUI.error.hidden = true;
      scanUI.status.textContent = "";
      scanStale.hidden = !scanOutput.hasChildNodes();
    });

    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (controller || !validateInputs(form, compareUI.error)) return;
      const params = { ...defaults, ...inputValues(form, fields), durations: durations() };
      await runOperation("模拟", compareUI, async (signal, onProgress) => {
        const result = await globalThis.ArrivalEngine.compare(params, onProgress, signal);
        if (signal.aborted) throw signal.reason;
        const changedTimes = params.durations.some((minutes, size) => minutes !== defaults.durations[size]);
        const timing = changedTimes ? "自定义工时" : "默认工时";
        const common = `${params.orderCount} 单 · ${params.machineCount} 台 · 等单上限 ${params.waitMinutes} 分钟 · ${timing}`;
        const caption = element("p", "muted", `${common} · 平均每 ${params.meanInterval} 分钟来一单`);
        const { delta, lower, upper } = result.flow_difference;
        const method = expandable("查看当前比较的计算依据", element("p", "muted",
          `${result.replicates} 次配对模拟。每次两种策略处理相同的随机到单序列，后续到单间隔按指数分布抽样。随机种子 ${params.seed}。限时等单减立即启动的平均差为 ${scanDifference(delta)} 分钟/单，95% 配对置信区间为 [${scanDifference(lower)}, ${scanDifference(upper)}]。`));
        const gantt = expandable("查看排程甘特图", representativeChart(result.example, params));
        output.replaceChildren(caption, currentAdvice(result.flow_difference, params), summaryMetrics(result, params), gantt, method);
        empty.hidden = true;
        stale.hidden = true;
        viewResults.hidden = false;
        scenario = params;
        scanContext.textContent = `扫描固定条件为 ${common}。可修改下方的到单间隔范围与步长。`;
        updateScanDefaults(params.meanInterval);
        scanOutput.replaceChildren();
        scanStale.hidden = true;
        scanUI.status.textContent = "";
        scanUI.error.hidden = true;
        return "模拟已完成，可查看结果和甘特图。";
      });
    });

    scanForm.addEventListener("submit", async event => {
      event.preventDefault();
      if (controller || !scenario || !validateInputs(scanForm, scanUI.error)) return;
      const params = { ...scenario, ...inputValues(scanForm, scanFields) };
      await runOperation("扫描临界点", scanUI, async (signal, onProgress) => {
        const scan = await globalThis.ArrivalEngine.scan(params, onProgress, signal);
        if (signal.aborted) throw signal.reason;
        scanOutput.replaceChildren(scanAdvice(scan.points, params), scanResults(scan, params));
        scanStale.hidden = true;
        return `已完成 ${scan.points.length} 个到单间隔的扫描。`;
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
