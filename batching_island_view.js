(function (root) {
  "use strict";

  const SETTINGS_KEY = "public-demo.s01.settings.v1";
  const MAX_MINUTES = 1_000_000_000;
  const phases = [
    ["prep", "机外准备", "#416f9b"],
    ["switch", "同机切换", "#b27628"],
    ["process", "批处理占机", "#117667"],
    ["post", "机外后处理", "#8065a6"],
  ];

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function action(text) {
    const button = element("button", text);
    button.type = "button";
    return button;
  }

  function integerField(parent, name, label, value, min, max, optional = false) {
    const group = element("label", undefined, "batching-field");
    const input = element("input");
    input.type = "number";
    input.name = name;
    input.min = min;
    input.max = max;
    input.step = 1;
    input.required = !optional;
    input.value = value ?? "";
    group.append(element("span", label), input);
    parent.append(group);
    return input;
  }

  function localRead(key) {
    try {
      return JSON.parse(root.localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  function inRange(value, min, max) {
    return Number.isSafeInteger(value) && value >= min && value <= max;
  }

  function readInteger(input, label) {
    const value = input.valueAsNumber;
    if (!inRange(value, Number(input.min), Number(input.max))) {
      throw new RangeError(`${label}须为 ${input.min} 至 ${input.max} 之间的整数。`);
    }
    return value;
  }

  function clock(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const remainder = Math.floor(seconds) % 60;
    return [hours, minutes, remainder].map(value => String(value).padStart(2, "0")).join(":");
  }

  function tableRow(values, header = false) {
    const row = element("tr");
    values.forEach((value, index) => {
      const isHeading = header || index === 0;
      const cell = element(isHeading ? "th" : "td");
      if (isHeading) cell.scope = header ? "col" : "row";
      cell.append(value);
      row.append(cell);
    });
    return row;
  }

  function phaseTrack(batch, horizon, switchSeconds) {
    const timeline = element("div", undefined, "batching-timeline");
    const intervals = [
      [batch.prep_start, batch.process_start],
      [batch.switch_start, Math.min(batch.process_start, (batch.switch_start ?? 0) + switchSeconds)],
      [batch.process_start, batch.process_end],
      [batch.process_end, batch.finish],
    ];
    intervals.forEach(([start, end], index) => {
      if (start == null || start >= end) return;
      const [, label, color] = phases[index];
      const bar = element("span");
      bar.style.left = `${start / horizon * 100}%`;
      bar.style.width = `${(end - start) / horizon * 100}%`;
      bar.style.top = `${index * 5 + 1}px`;
      bar.style.background = color;
      bar.title = `${label} ${clock(start)} → ${clock(end)}`;
      timeline.append(bar);
    });
    return timeline;
  }

  function standaloneBufferPeak(batches, capacity) {
    const changes = new Map();
    const add = (time, count) => changes.set(time, (changes.get(time) ?? 0) + count);
    for (const batch of batches) {
      const count = batch.order_ids.length;
      add(batch.prep_start, count);
      add(batch.process_start, -count);
      add(batch.process_end, count);
      add(batch.finish, -count);
    }
    let used = 0;
    let peak = 0;
    for (const time of [...changes.keys()].sort((left, right) => left - right)) {
      used += changes.get(time);
      if (used > capacity) {
        throw new RangeError(`批处理缓冲在 ${clock(time)} 需要 ${used} 格，当前只有 ${capacity} 格。请增大批处理缓冲。`);
      }
      peak = Math.max(peak, used);
    }
    return peak;
  }

  function renderResult(container, result, integrated) {
    const { config, batches, orders, makespan } = result;
    const mean = orders.length ? orders.reduce((sum, order) => sum + order.finish - order.arrival, 0) / orders.length : 0;
    const title = element("h3", integrated ? "本轮整线仿真的 S01 批处理结果" : "单独批处理仿真结果");
    const summary = element("p", `${orders.length} 单 · ${batches.length} 盘 · ${config.machineCount} 台批处理设备 · ${config.waitMinutes > 0 ? `限时等单 ${config.waitMinutes} 分钟` : "立即启动"}`, "batching-summary");
    const timing = element("p", `最后一盘后处理完成 ${clock(makespan)} · 平均订单到达至后处理完成 ${(mean / 60).toLocaleString("zh-CN", {maximumFractionDigits: 2})} 分钟`, "batching-note");
    const legend = element("div", undefined, "batching-legend");
    for (const [, label, color] of phases) {
      const item = element("span");
      const swatch = element("i");
      swatch.style.background = color;
      item.append(swatch, label);
      legend.append(item);
    }
    const table = element("table");
    table.setAttribute("aria-label", "批处理批次与阶段时间");
    const head = element("thead");
    head.append(tableRow(["批次", "批处理设备", "订单", "开始准备", "开始批处理", "批处理结束", "后处理完成", "本轮时间轴"], true));
    const body = element("tbody");
    for (const batch of batches) {
      body.append(tableRow([
        batch.batch_id, `#${batch.machine}`, batch.order_ids.join("、"), clock(batch.prep_start),
        clock(batch.process_start), clock(batch.process_end), clock(batch.finish),
        phaseTrack(batch, Math.max(1, makespan), config.switchMinutes * 60),
      ]));
    }
    table.append(head, body);
    const scroll = element("div", undefined, "batching-table-scroll");
    scroll.append(table);
    container.replaceChildren(title, summary, timing);
    if (result.bufferPeak !== undefined) {
      container.append(element("p", `准备与后处理合计峰值 ${result.bufferPeak} / ${config.capacity} 格`, "batching-note"));
    }
    container.append(legend, scroll);
  }

  function mount({ dialog, defaults, onChange = () => {} }) {
    const engine = root.ArrivalEngine;
    const saved = localRead(SETTINGS_KEY);
    const savedDuration = saved?.durations;
    const style = element("style", `
      #batching-dialog{width:min(calc(100% - 24px),1020px);max-height:90vh;padding:0;color:#173744;background:#fff;border:1px solid #bed0d4;border-radius:15px;box-shadow:0 22px 70px #17374444}
      #batching-dialog::backdrop{background:#152e3a91}
      #batching-dialog [hidden]{display:none!important}
      #batching-dialog .batching-panel{padding:18px;display:grid;gap:14px;min-width:0}
      #batching-dialog .batching-header,#batching-dialog .batching-nav,#batching-dialog .batching-legend{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
      #batching-dialog .batching-header{justify-content:space-between}
      #batching-dialog .batching-nav{padding-bottom:10px;border-bottom:1px solid #dce7e9}
      #batching-dialog button[aria-pressed="true"],#batching-dialog button[type="submit"]{background:#096e66;color:#fff;border-color:#096e66;font-weight:700}
      #batching-dialog .batching-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
      #batching-dialog .batching-field{display:grid;gap:5px;font-size:12px;font-weight:700}
      #batching-dialog .batching-field input{font:inherit;font-weight:400;width:100%;min-width:0;border:1px solid #bed0d4;border-radius:7px;padding:6px 8px;color:inherit}
      #batching-dialog .batching-field input:focus-visible{outline:3px solid #57a7a1;outline-offset:2px}
      #batching-dialog .batching-section{display:grid;gap:12px}
      #batching-dialog .batching-note,#batching-dialog .batching-legend{font-size:12px;line-height:1.55;color:#526672}
      #batching-dialog .batching-summary{font-size:14px;font-weight:700}
      #batching-dialog .batching-legend i{display:inline-block;width:9px;height:9px;margin-right:4px;border-radius:2px}
      #batching-dialog .batching-table-scroll{overflow:auto;max-height:58vh}
      #batching-dialog .batching-table-scroll thead th{position:sticky;top:0;z-index:1}
      #batching-dialog .batching-timeline{width:200px;position:relative;height:22px;background:#edf3f4;border-radius:4px}
      #batching-dialog .batching-timeline span{position:absolute;height:4px;border-radius:2px}
      #batching-dialog .batching-error{color:#9b1c21}
    `);
    const panel = element("div", undefined, "batching-panel");
    const header = element("header", undefined, "batching-header");
    const heading = element("h2", "S01 批处理");
    heading.id = "batching-dialog-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const close = action("关闭");
    close.addEventListener("click", () => dialog.close());
    header.append(heading, close);

    const nav = element("div", undefined, "batching-nav");
    const tabs = ["批处理设置", "单独仿真", "本轮批处理结果"].map(action);
    const views = tabs.map(() => element("section", undefined, "batching-section"));
    function showView(index) {
      views.forEach((view, position) => {
        view.hidden = position !== index;
        tabs[position].setAttribute("aria-pressed", String(position === index));
      });
    }
    tabs.forEach((tab, index) => tab.addEventListener("click", () => showView(index)));
    nav.append(...tabs);
    panel.append(header, nav, ...views);
    dialog.replaceChildren(style, panel);

    const [editor, standalone, integrated] = views;
    integrated.append(element("p", "运行整线仿真后，这里会显示同一次运行的批处理批次。", "batching-note"));
    const grid = element("div", undefined, "batching-fields");
    const labels = {
      machineCount: ["批处理设备数量（台）", 1, engine.maxMachines],
      prepMinutes: ["每盘机外准备（分钟）", 0, MAX_MINUTES],
      switchMinutes: ["每盘同机切换（分钟）", 0, MAX_MINUTES],
      postMinutes: ["每盘机外后处理（分钟）", 0, MAX_MINUTES],
      waitMinutes: ["最多等单（分钟，0 为立即）", 0, 1440],
      capacity: ["批处理共享缓冲（套，留空为自动）", 1, Number.MAX_SAFE_INTEGER],
    };
    const fields = Object.fromEntries(Object.entries(labels).map(([name, [label, min, max]]) => {
      const hasSaved = inRange(saved?.[name], min, max) || (name === "capacity" && saved?.capacity === null);
      const restored = hasSaved ? saved[name] : defaults[name];
      const value = name === "capacity" && !restored ? null : restored;
      return [name, integerField(grid, name, label, value, min, max, name === "capacity")];
    }));
    fields.capacity.placeholder = "自动（至少 400 套）";
    const durationsGrid = element("div", undefined, "batching-fields");
    const durations = defaults.durations.map((minutes, size) => minutes == null ? null : integerField(
      durationsGrid, `batching-duration-${size}`, `${size} 单同盘（分钟）`,
      inRange(savedDuration?.[size], 1, MAX_MINUTES) ? savedDuration[size] : minutes, 1, MAX_MINUTES,
    ));
    const saveState = element("p", "批处理设置自动保存在当前浏览器。", "batching-note");
    saveState.setAttribute("role", "status");
    editor.append(
      element("p", "准备、后处理和等待 AGV 共用缓冲。同一订单占一格，最后一件取走时释放。批处理占机期间不占缓冲格。", "batching-note"),
      grid, element("h3", "每盘批处理时间"), durationsGrid, saveState,
    );

    function settings() {
      const config = Object.fromEntries(Object.entries(fields).map(([name, input]) => [
        name, name === "capacity" && input.value === "" && !input.validity.badInput ? null : readInteger(input, labels[name][0]),
      ]));
      return {
        ...config,
        durations: durations.map((input, size) => input ? readInteger(input, `${size} 单同盘批处理时间`) : null),
        transportSeconds: defaults.transportSeconds ?? 30,
      };
    }

    editor.addEventListener("input", () => {
      let config;
      try {
        config = settings();
      } catch (error) {
        saveState.textContent = error.message;
        saveState.classList.add("batching-error");
        return;
      }
      try {
        root.localStorage.setItem(SETTINGS_KEY, JSON.stringify(config));
        saveState.textContent = "已保存。下次运行整线时使用这组批处理参数。";
        saveState.classList.remove("batching-error");
      } catch {
        saveState.textContent = "浏览器暂时无法保存，当前打开的页面仍可使用这组设置。";
        saveState.classList.add("batching-error");
      }
      onChange();
    });

    const form = element("form", undefined, "batching-section");
    const sampleGrid = element("div", undefined, "batching-fields");
    const orderCount = integerField(sampleGrid, "batching-standalone-orders", "订单数量（单）", 24, 1, engine.maxOrders ?? 200);
    const interval = integerField(sampleGrid, "batching-standalone-interval", "固定到单间隔（秒）", 300, 1, Number.MAX_SAFE_INTEGER);
    const run = element("button", "运行单独批处理仿真");
    run.type = "submit";
    const runState = element("p", undefined, "batching-note");
    runState.setAttribute("role", "status");
    const singleResult = element("section", undefined, "batching-section");
    form.append(sampleGrid, run, runState);
    standalone.append(element("p", "沿用批处理设置，使用这里独立填写的订单数和到达间隔。单独仿真以一套完成后处理为交接时点，等待 AGV 的时间计入整线仿真。", "batching-note"), form, singleResult);
    form.addEventListener("submit", event => {
      event.preventDefault();
      try {
        const config = settings();
        const count = readInteger(orderCount, "订单数量");
        const gap = readInteger(interval, "固定到单间隔");
        if (!Number.isSafeInteger((count - 1) * gap)) throw new RangeError("最后一单到达时刻超出可计算范围。");
        const arrivals = Array.from({ length: count }, (_, index) => index * gap);
        const simulation = engine.simulateSeconds(arrivals, config, config.waitMinutes);
        const capacity = config.capacity ?? Math.max(400, count);
        const bufferPeak = standaloneBufferPeak(simulation.batches, capacity);
        renderResult(singleResult, { ...simulation, config: { ...config, capacity }, bufferPeak }, false);
        runState.textContent = "单独批处理仿真完成。";
        runState.classList.remove("batching-error");
      } catch (error) {
        singleResult.replaceChildren();
        runState.textContent = error.message;
        runState.classList.add("batching-error");
      }
    });

    showView(0);
    function open(index) {
      showView(index);
      if (!dialog.open) dialog.showModal();
    }
    const setResult = result => renderResult(integrated, result, true);
    return {
      settings,
      openSettings: () => open(0),
      setResult,
      openResult(result) {
        if (result) setResult(result);
        open(2);
      },
    };
  }

  root.BatchingIslandView = { mount };
})(globalThis);
