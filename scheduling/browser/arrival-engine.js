(function (root) {
  "use strict";

  const MAX_TRAY_SIZE = 8;
  const MAX_ORDERS = 200;
  const MAX_MACHINES = 30;

  function integer(value, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`${label}须为 ${minimum} 至 ${maximum} 之间的整数`);
    }
    return value;
  }

  function simulationConfig(config) {
    const machineCount = integer(config.machineCount, "批处理设备数量", 1, MAX_MACHINES);
    const prepMinutes = integer(config.prepMinutes, "批处理前准备时间", 0);
    const postMinutes = integer(config.postMinutes, "批处理后处理时间", 0);
    const switchMinutes = integer(config.switchMinutes, "批次切换时间", 0);
    if (!Array.isArray(config.durations)) {
      throw new TypeError("装盘工时须按每盘订单数提供");
    }
    const durations = [];
    const sizes = [];
    config.durations.forEach((duration, size) => {
      if (duration == null) return;
      integer(size, "装盘订单数", 1, MAX_TRAY_SIZE);
      durations[size] = integer(duration, "整盘批处理时间", 1);
      sizes.push(size);
    });
    if (sizes.length === 0) throw new RangeError("装盘表至少须启用一个整单组合");
    sizes.sort((left, right) => right - left);
    return { machineCount, prepMinutes, postMinutes, switchMinutes, durations, sizes };
  }

  function validateArrivals(arrivals) {
    if (!Array.isArray(arrivals) || arrivals.length > MAX_ORDERS) {
      throw new RangeError(`到单序列最多包含 ${MAX_ORDERS} 单`);
    }
    for (let index = 0; index < arrivals.length; index += 1) {
      integer(arrivals[index], "订单到达时间", 0);
      if (index === 0 ? arrivals[index] !== 0 : arrivals[index] < arrivals[index - 1]) {
        throw new RangeError("订单到达时间须从 0 开始，并按非递减顺序排列");
      }
    }
  }

  function better(sum, trays, current) {
    return current === null || sum < current[0] || (sum === current[0] && trays < current[1]);
  }

  function singleBatcherCosts(count, { durations, sizes, switchMinutes }) {
    const costs = Array(count + 1).fill(null);
    const firstBatch = Array(count + 1).fill(0);
    costs[0] = [0, 0];
    for (let total = 1; total <= count; total += 1) {
      for (const size of sizes) {
        const remaining = total - size;
        if (remaining < 0 || costs[remaining] === null) continue;
        const [tailSum, tailTrays] = costs[remaining];
        const sum = total * durations[size] + remaining * switchMinutes + tailSum;
        const trays = 1 + tailTrays;
        if (better(sum, trays, costs[total])) {
          costs[total] = [sum, trays];
          firstBatch[total] = size;
        }
      }
    }
    return { costs, firstBatch };
  }

  function closeoutPlan(count, now, lastBatchEnds, config) {
    const { prepMinutes, postMinutes, switchMinutes, durations } = config;
    const { costs, firstBatch } = singleBatcherCosts(count, config);
    if (costs[count] === null) {
      throw new RangeError(`收尾时剩余 ${count} 单，无法用已启用整单组合排齐`);
    }
    const ready = lastBatchEnds.map((end) => end === null
      ? now + prepMinutes
      : Math.max(now + prepMinutes, end + switchMinutes));
    const loads = costs.map((cost, load) => [load, cost]).filter((entry) => entry[1] !== null);
    const choices = [];
    let best = Array(count + 1).fill(null);
    best[0] = [0, 0];
    for (const readyAt of ready) {
      const nextBest = Array(count + 1).fill(null);
      const chosen = Array(count + 1).fill(0);
      for (let total = 0; total <= count; total += 1) {
        for (const [load, [completionSum, trays]] of loads) {
          if (load > total) break;
          const prefix = best[total - load];
          if (prefix === null) continue;
          // Release times are fixed, so minimizing completion sums also minimizes flow time.
          const sum = prefix[0] + completionSum + load * (readyAt + postMinutes);
          const trayCount = prefix[1] + trays;
          if (better(sum, trayCount, nextBest[total])) {
            nextBest[total] = [sum, trayCount];
            chosen[total] = load;
          }
        }
      }
      best = nextBest;
      choices.push(chosen);
    }

    const planned = [];
    let remaining = count;
    for (let machine = ready.length - 1; machine >= 0; machine -= 1) {
      let load = choices[machine][remaining];
      remaining -= load;
      let start = ready[machine];
      while (load > 0) {
        const size = firstBatch[load];
        planned.push([start - prepMinutes, machine, size]);
        start += durations[size] + switchMinutes;
        load -= size;
      }
    }
    return planned.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);
  }

  function label(prefix, index) {
    return `${prefix}${String(index).padStart(3, "0")}`;
  }

  function simulateValidated(arrivals, config, waitMinutes) {
    const { machineCount, prepMinutes, postMinutes, switchMinutes, durations, sizes } = config;
    const orders = arrivals.map((arrival, index) => ({
      order_id: label("O", index + 1), arrival, finish: null, batch_id: null,
    }));
    const batches = [];
    const lastBatchEnds = Array(machineCount).fill(null);
    const fullSize = sizes[0];
    let cursor = 0;
    let assigned = 0;
    let now = 0;
    let deadline = null;
    let waitEvents = 0;

    function prepReady(end) {
      return end === null ? 0 : Math.max(0, end + switchMinutes - prepMinutes);
    }

    function dispatch(prepStart, machine, size) {
      const processStart = prepStart + prepMinutes;
      const processEnd = processStart + durations[size];
      const finish = processEnd + postMinutes;
      const batchId = label("B", batches.length + 1);
      const orderIds = [];
      for (let index = 0; index < size; index += 1) {
        const order = orders[assigned];
        assigned += 1;
        order.batch_id = batchId;
        order.finish = finish;
        order.flow_time = finish - order.arrival;
        orderIds.push(order.order_id);
      }
      batches.push({
        batch_id: batchId,
        machine: machine + 1,
        order_ids: orderIds,
        prep_start: prepStart,
        process_start: processStart,
        process_end: processEnd,
        finish,
        switch_start: lastBatchEnds[machine],
      });
      lastBatchEnds[machine] = processEnd;
    }

    while (cursor < orders.length) {
      while (cursor < orders.length && arrivals[cursor] === now) cursor += 1;
      if (cursor === orders.length) {
        const planned = closeoutPlan(cursor - assigned, now, lastBatchEnds, config);
        for (const [prepStart, machine, size] of planned) dispatch(prepStart, machine, size);
        break;
      }

      while (assigned < cursor) {
        const machine = lastBatchEnds.findIndex((end) => prepReady(end) <= now);
        const size = sizes.find((option) => option <= cursor - assigned);
        if (machine === -1 || size === undefined) break;
        if (size === fullSize || waitMinutes === 0 || (deadline !== null && now >= deadline)) {
          dispatch(now, machine, size);
          deadline = null;
        } else {
          if (deadline === null) {
            deadline = now + waitMinutes;
            waitEvents += 1;
          }
          break;
        }
      }

      let next = arrivals[cursor];
      if (deadline !== null && deadline > now) next = Math.min(next, deadline);
      if (assigned < cursor) {
        for (const end of lastBatchEnds) {
          const readyAt = prepReady(end);
          if (readyAt > now) next = Math.min(next, readyAt);
        }
      }
      now = next;
    }

    const totalFlowTime = orders.reduce((sum, order) => sum + order.flow_time, 0);
    return {
      batches,
      orders,
      makespan: batches.reduce((last, batch) => Math.max(last, batch.finish), 0),
      wait_events: waitEvents,
      total_flow_time: totalFlowTime,
      mean_flow_time: orders.length === 0 ? 0 : totalFlowTime / orders.length,
    };
  }

  function simulate(arrivals, config, waitMinutes) {
    validateArrivals(arrivals);
    integer(waitMinutes, "等单时间", 0, 1440);
    return simulateValidated(arrivals, simulationConfig(config), waitMinutes);
  }

  function simulateSeconds(arrivals, config, waitMinutes) {
    validateArrivals(arrivals);
    integer(waitMinutes, "等单时间", 0, 1440);
    const settings = simulationConfig(config);
    const seconds = {
      ...settings,
      prepMinutes: settings.prepMinutes * 60,
      postMinutes: settings.postMinutes * 60,
      switchMinutes: settings.switchMinutes * 60,
      durations: settings.durations.map((duration) => duration * 60),
    };
    const longest = Math.max(...settings.sizes.map((size) => seconds.durations[size]));
    const latest = (arrivals[arrivals.length - 1] ?? 0) + seconds.prepMinutes + seconds.postMinutes
      + waitMinutes * 60 + arrivals.length * (longest + seconds.switchMinutes);
    integer(latest * Math.max(1, arrivals.length), "批处理排程累计用时（秒）", 0);
    return simulateValidated(arrivals, seconds, waitMinutes * 60);
  }

  function seededRandom(seed) {
    let state = seed;
    return function () {
      state = (state + 0x6D2B79F5) >>> 0;
      let value = Math.imul(state ^ (state >>> 15), state | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function arrivalTrace(count, interval, random) {
    const arrivals = [0];
    while (arrivals.length < count) {
      const gap = Math.max(1, Math.round(-interval * Math.log1p(-random())));
      arrivals.push(arrivals[arrivals.length - 1] + gap);
    }
    return arrivals;
  }

  function yieldToPage() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function pairingConfig(config) {
    return {
      wait: integer(config.waitMinutes, "等单时间", 0, 1440),
      replicates: integer(config.replicates ?? 200, "模拟次数", 2, 200),
      seed: integer(config.seed ?? 61723, "随机种子", 0, 0xFFFFFFFF),
    };
  }

  function simulatePair(arrivals, config, wait) {
    const immediate = simulateValidated(arrivals, config, 0);
    const waiting = wait === 0 ? immediate : simulateValidated(arrivals, config, wait);
    return { immediate, waiting };
  }

  function flowDifference(pairedTotals, orderCount) {
    const replicates = pairedTotals.length;
    const mean = pairedTotals.reduce((sum, total) => sum + total, 0) / replicates;
    const variance = pairedTotals.reduce((sum, total) => sum + (total - mean) ** 2, 0)
      / (replicates - 1);
    const delta = mean / orderCount;
    const halfWidth = 1.96 * Math.sqrt(variance / replicates) / orderCount;
    return { delta, lower: delta - halfWidth, upper: delta + halfWidth };
  }

  async function compare(config, onProgress, signal) {
    checkAborted(signal);
    const validated = simulationConfig(config);
    const orderCount = integer(config.orderCount, "订单数", 1, MAX_ORDERS);
    const interval = config.meanInterval;
    if (!Number.isFinite(interval) || interval < 1 || interval > 1440) {
      throw new RangeError("平均到单间隔须为 1 至 1440 分钟");
    }
    const { wait, replicates, seed } = pairingConfig(config);
    const random = seededRandom(seed);
    const samples = [];
    const pairedTotals = [];
    const immediateTotals = { flow: 0, makespan: 0 };
    const waitingTotals = { flow: 0, makespan: 0 };
    onProgress?.(0, replicates);
    await yieldToPage();
    let chunkStart = Date.now();
    for (let index = 0; index < replicates; index += 1) {
      checkAborted(signal);
      const arrivals = arrivalTrace(orderCount, interval, random);
      const { immediate, waiting } = simulatePair(arrivals, validated, wait);
      immediateTotals.flow += immediate.total_flow_time;
      immediateTotals.makespan += immediate.makespan;
      waitingTotals.flow += waiting.total_flow_time;
      waitingTotals.makespan += waiting.makespan;
      pairedTotals.push(waiting.total_flow_time - immediate.total_flow_time);
      samples.push({ arrivals, delta: waiting.makespan - immediate.makespan });

      const completed = index + 1;
      if (completed === replicates || completed % 8 === 0 || Date.now() - chunkStart >= 16) {
        onProgress?.(completed, replicates);
        if (completed < replicates) await yieldToPage();
        chunkStart = Date.now();
      }
    }

    checkAborted(signal);
    const deltas = samples.map((sample) => sample.delta).sort((left, right) => left - right);
    const middle = (deltas[Math.floor((replicates - 1) / 2)] + deltas[Math.floor(replicates / 2)]) / 2;
    let exampleIndex = 0;
    for (let index = 1; index < replicates; index += 1) {
      if (Math.abs(samples[index].delta - middle) < Math.abs(samples[exampleIndex].delta - middle)) {
        exampleIndex = index;
      }
    }
    const arrivals = samples[exampleIndex].arrivals;
    return {
      immediate: {
        mean_flow_time: immediateTotals.flow / (replicates * orderCount),
        mean_makespan: immediateTotals.makespan / replicates,
      },
      waiting: {
        mean_flow_time: waitingTotals.flow / (replicates * orderCount),
        mean_makespan: waitingTotals.makespan / replicates,
      },
      flow_difference: flowDifference(pairedTotals, orderCount),
      example: {
        arrivals,
        immediate: simulateValidated(arrivals, validated, 0),
        waiting: simulateValidated(arrivals, validated, wait),
        replicate: exampleIndex + 1,
      },
      replicates,
    };
  }

  function scanIntervals(start, end, step) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end > 1440 || start >= end) {
      throw new RangeError("平均到单间隔须在 1 至 1440 分钟之间，起点须小于终点");
    }
    if (!Number.isFinite(step) || step <= 0) {
      throw new RangeError("扫描步长须大于 0 分钟");
    }

    const intervals = [start];
    // Allow only the floating-point error of computing an intended grid endpoint.
    const tolerance = Number.EPSILON * Math.max(1, end) * 2;
    for (let index = 1; index < 60; index += 1) {
      const interval = start + index * step;
      if (interval >= end - tolerance) {
        intervals.push(end);
        return intervals;
      }
      if (interval <= intervals[intervals.length - 1]) {
        throw new RangeError("扫描步长过小，无法区分相邻取样点");
      }
      intervals.push(interval);
    }
    throw new RangeError("每次扫描最多包含 60 个取样点，请增大步长或缩小范围");
  }

  function scanBoundaries(points) {
    const crossings = [];
    const ties = [];
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (point.delta === 0) {
        while (index + 1 < points.length && points[index + 1].delta === 0) index += 1;
        ties.push({ start: point.interval, end: points[index].interval });
        continue;
      }
      const next = points[index + 1];
      if (next && next.delta !== 0 && Math.sign(point.delta) !== Math.sign(next.delta)) {
        const fraction = point.delta / (point.delta - next.delta);
        crossings.push({
          interval: point.interval + fraction * (next.interval - point.interval),
          lowerInterval: point.interval,
          upperInterval: next.interval,
        });
      }
    }
    return { crossings, ties };
  }

  function checkAborted(signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("模拟已取消", "AbortError");
  }

  async function scan(config, onProgress, signal) {
    checkAborted(signal);
    const validated = simulationConfig(config);
    const orderCount = integer(config.orderCount, "订单数", 1, MAX_ORDERS);
    const intervals = scanIntervals(config.intervalStart, config.intervalEnd, config.intervalStep);
    const { wait, replicates, seed } = pairingConfig(config);
    const totalPairs = intervals.length * replicates;
    const orderSamples = orderCount * replicates;
    const points = [];
    let completedPairs = 0;

    onProgress?.(0, totalPairs);
    await yieldToPage();
    let chunkStart = Date.now();
    for (const interval of intervals) {
      // Restart the same standardized draws so different scan points can be compared fairly.
      const random = seededRandom(seed);
      let immediateTotal = 0;
      let waitingTotal = 0;
      const pairedTotals = [];
      for (let sample = 0; sample < replicates; sample += 1) {
        checkAborted(signal);
        const arrivals = arrivalTrace(orderCount, interval, random);
        const { immediate, waiting } = simulatePair(arrivals, validated, wait);
        immediateTotal += immediate.total_flow_time;
        waitingTotal += waiting.total_flow_time;
        pairedTotals.push(waiting.total_flow_time - immediate.total_flow_time);
        completedPairs += 1;
        if (completedPairs === totalPairs || Date.now() - chunkStart >= 16) {
          onProgress?.(completedPairs, totalPairs);
          if (completedPairs < totalPairs) await yieldToPage();
          chunkStart = Date.now();
        }
      }

      points.push({
        interval,
        ...flowDifference(pairedTotals, orderCount),
        immediate_mean: immediateTotal / orderSamples,
        waiting_mean: waitingTotal / orderSamples,
      });
    }

    checkAborted(signal);
    return { points, ...scanBoundaries(points), replicates };
  }

  const engine = { simulate, simulateSeconds, compare, scan, maxMachines: MAX_MACHINES };
  root.ArrivalEngine = engine;
  if (typeof module !== "undefined" && module.exports) module.exports = engine;
})(globalThis);
