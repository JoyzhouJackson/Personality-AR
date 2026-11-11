(function (root) {
  "use strict";

  const ISLAND_NAMES = ["S02", "S03", "S04", "S05", "S06", "S07"];
  const [CELL_A, , , ASSEMBLY] = ISLAND_NAMES;
  const BATCH = "S01";
  const BATCH_INDEX = ISLAND_NAMES.length;
  const COMPONENTS = ["L", "R", "F"];
  const KINDS = [...COMPONENTS, "M"];
  const PUBLIC_KINDS = { L: "A", R: "B", F: "C", M: "P" };

  function integer(value, label, minimum) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new RangeError(`${label}须为不小于 ${minimum} 的整数`);
    }
    return value;
  }

  function normalize(config) {
    const { parameters, islands, transport, routes } = config ?? {};
    if (!parameters || !routes || !Array.isArray(islands) || !Array.isArray(transport)
        || islands.length !== ISLAND_NAMES.length || transport.length !== ISLAND_NAMES.length) {
      throw new TypeError("仿真参数须包含六个工艺岛、AGV 时间矩阵和 A/B/C/P 示例路线");
    }
    const orders = integer(parameters.orders, "订单数", 1);
    const interval = integer(parameters.interval, "到单间隔（秒）", 1);
    const reserveReturn = parameters.reserve_return;
    const sharedKit = parameters.shared_kit_slot;
    if (typeof reserveReturn !== "boolean" || typeof sharedKit !== "boolean") {
      throw new TypeError("回存位预留和齐套共用位须为开关值");
    }
    const normalizedParameters = { orders, interval, reserve_return: reserveReturn, shared_kit_slot: sharedKit };
    for (const key of ["reserve_stage05_reentry", "paired_exchange"]) {
      if (!(key in parameters)) continue;
      if (typeof parameters[key] !== "boolean") throw new TypeError(`${key} 须为开关值`);
      normalizedParameters[key] = parameters[key];
    }
    if (normalizedParameters.reserve_stage05_reentry
        && (routes.M?.[1]?.island !== CELL_A || routes.M?.[2]?.island !== ASSEMBLY)) {
      throw new TypeError("S05回流预留要求 P 的前三段依次为 S05、S02、S05");
    }
    integer((orders - 1) * interval, "最后一单到达时刻", 0);

    return {
      parameters: normalizedParameters,
      islands: ISLAND_NAMES.map((name, index) => {
        if (islands[index]?.name !== name) throw new TypeError(`第 ${index + 1} 个工艺岛须为${name}`);
        return {
          name,
          capacity: integer(islands[index].capacity, `${name}缓冲格数`, 1),
          machines: integer(islands[index].machines, `${name}加工位数`, 1),
        };
      }),
      transport: ISLAND_NAMES.map((source, i) => {
        const row = transport[i];
        if (!Array.isArray(row) || row.length !== ISLAND_NAMES.length) {
          throw new TypeError("AGV 时间矩阵须有六行六列");
        }
        return ISLAND_NAMES.map((target, j) => {
          const seconds = integer(row[j], `${source}至${target}搬运时间（秒）`, 0);
          if (i === j && seconds !== 0) throw new RangeError("AGV 时间矩阵的同岛时间须为 0");
          return seconds;
        });
      }),
      routes: Object.fromEntries(KINDS.map((kind) => {
        const route = routes[kind];
        const firstIsland = kind === "M" ? ASSEMBLY : CELL_A;
        if (!Array.isArray(route) || route[0]?.island !== firstIsland) {
          throw new TypeError(`${PUBLIC_KINDS[kind]} 路线须从${firstIsland}开始`);
        }
        return [kind, Array.from(route, (visit, index) => {
          if (!ISLAND_NAMES.includes(visit?.island) || typeof visit.operations !== "string") {
            throw new TypeError(`${PUBLIC_KINDS[kind]} 第 ${index + 1} 道工序缺少工艺岛或工序说明`);
          }
          return {
            island: visit.island,
            seconds: integer(visit.seconds, `${PUBLIC_KINDS[kind]} 第 ${index + 1} 道工序用时（秒）`, 1),
            operations: visit.operations,
          };
        })];
      })),
    };
  }

  function planBatching(parameters, input) {
    const engine = root.ArrivalEngine ?? (typeof require === "function"
      ? require("./scheduling/browser/arrival-engine.js") : null);
    if (!engine?.simulateSeconds) throw new Error("无法加载 S01 批处理排程引擎");
    if (!Array.isArray(input.durations)) throw new TypeError("装盘工时须按每盘订单数提供");
    const config = {
      machineCount: integer(input.machineCount, "S01设备数量", 1),
      prepMinutes: integer(input.prepMinutes, "批处理前准备时间", 0),
      postMinutes: integer(input.postMinutes, "批处理后处理时间", 0),
      switchMinutes: integer(input.switchMinutes, "批次切换时间", 0),
      waitMinutes: integer(input.waitMinutes, "等单时间", 0),
      durations: Array.from(input.durations, (duration) => duration == null ? null : duration),
      capacity: integer(input.capacity ?? Math.max(400, parameters.orders), "S01 批处理缓冲格数", 1),
      transportSeconds: integer(input.transportSeconds ?? 14, "S01 批处理至S02搬运时间（秒）", 0),
    };
    if (parameters.orders > 200) throw new RangeError("当前 S01 批处理排程支持最多 200 单");
    const arrivals = Array.from({ length: parameters.orders }, (_, i) => i * parameters.interval);
    const { orders, batches, makespan } = engine.simulateSeconds(arrivals, config, config.waitMinutes);
    const machineEnds = new Map();
    const assigned = new Set();
    for (const batch of batches) {
      const { machine, prep_start, process_start, process_end, finish, switch_start, order_ids } = batch;
      const priorEnd = machineEnds.get(machine) ?? null;
      if (!Number.isSafeInteger(machine) || machine < 1 || machine > config.machineCount || switch_start !== priorEnd
          || (priorEnd !== null && process_start < priorEnd + config.switchMinutes * 60)
          || process_start !== prep_start + config.prepMinutes * 60
          || process_end !== process_start + config.durations[order_ids.length] * 60
          || finish !== process_end + config.postMinutes * 60) {
        throw new Error(`S01设备 ${machine} 的批次 ${batch.batch_id} 工位时间冲突或工时不符`);
      }
      machineEnds.set(machine, process_end);
      for (const id of order_ids) {
        const order = orders[Number(id.slice(1)) - 1];
        if (order?.order_id !== id || assigned.has(id) || order.arrival > prep_start
            || order.batch_id !== batch.batch_id || order.finish !== finish) {
          throw new Error(`批处理批次 ${batch.batch_id} 的订单 ${id} 齐套或时间不符`);
        }
        assigned.add(id);
      }
    }
    if (assigned.size !== arrivals.length) throw new Error("批处理排程有订单未分配批次");
    return { config, orders, batches, makespan };
  }

  function makePart(order, kind) {
    return { order, kind, step: 0, entered: 0 };
  }

  function priority(part, time = part.entered) {
    return [part.order, time, KINDS.indexOf(part.kind)];
  }

  function earlier(left, right) {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] < right[index];
    }
    return false;
  }

  function take(items, item) {
    const index = items.indexOf(item);
    if (index < 0) throw new Error("工件或工位占用记录不存在");
    items.splice(index, 1);
  }

  function sameCounts(left, right) {
    if (left.size !== right.size) return false;
    for (const [key, count] of left) if (right.get(key) !== count) return false;
    return true;
  }

  class Island {
    constructor(config, index, sharedKit) {
      Object.assign(this, config);
      this.index = index;
      this.sharedKit = this.name === ASSEMBLY && sharedKit;
      this.buffer = [];
      this.work = [];
      this.kitBuffer = new Map();
      this.kitInbound = new Map();
      this.reentryHolds = new Set();
      this.ordinaryOccupied = 0;
      this.ordinaryInbound = 0;
    }

    get occupied() {
      return this.ordinaryOccupied + this.kitBuffer.size;
    }

    get inbound() {
      let reserved = this.ordinaryInbound;
      for (const order of this.kitInbound.keys()) {
        if (!this.kitBuffer.has(order)) reserved += 1;
      }
      return reserved;
    }

    get returnReserved() {
      return this.work.reduce((count, work) => count + Number(work.returnSlot), 0);
    }

    get available() {
      return this.capacity - this.occupied - this.inbound - this.returnReserved - this.reentryHolds.size;
    }

    canReceive(part, kitReady) {
      return this.available > 0 || (this.sharedKit && kitReady
        && (this.kitBuffer.has(part.order) || this.kitInbound.has(part.order)));
    }

    adjustKitCount(counts, order, increment) {
      const count = (counts.get(order) ?? 0) + increment;
      if (count === 0) counts.delete(order);
      else counts.set(order, count);
    }

    adjustBuffer(part, kitReady, increment) {
      if (this.sharedKit && kitReady) this.adjustKitCount(this.kitBuffer, part.order, increment);
      else this.ordinaryOccupied += increment;
    }

    adjustInbound(part, kitReady, increment) {
      if (this.sharedKit && kitReady) this.adjustKitCount(this.kitInbound, part.order, increment);
      else this.ordinaryInbound += increment;
    }
  }

  function simulate(config) {
    const settings = normalize(config);
    const { parameters, islands: islandSettings, transport, routes } = settings;
    const batching = config.batching == null ? null : planBatching(parameters, config.batching);
    const batchingIsland = batching && {
      index: BATCH_INDEX, name: BATCH, capacity: batching.config.capacity, machines: batching.config.machineCount,
    };
    const batchers = new Map();
    const readyKits = new Map();
    const released = new Set();
    const shipments = new Map();
    const audit = batching && {
      events_checked: 0, peak_slots: Array(BATCH_INDEX + 1).fill(0),
      peak_workstations: Array(BATCH_INDEX + 1).fill(0), violations: 0,
    };
    let preparing = 0;
    let postProcessing = 0;
    let lastAuditedTime = -1;
    const islands = islandSettings.map((island, index) => new Island(island, index, parameters.shared_kit_slot));
    const byName = new Map(islands.map((island) => [island.name, island]));
    const entryIsland = byName.get(CELL_A);
    const events = new Map();
    const raw = [];
    const admission = new Map();
    const completed = new Map();
    const frames = [];
    const trips = [];
    let now = 0;
    let arrived = 0;
    let inTransit = 0;
    let rawHead = 0;
    let pairedExchanges = 0;

    const visit = (part) => routes[part.kind][part.step];
    const kitReady = (part) => part.kind !== "M" && !visit(part);
    const target = (part) => byName.get(visit(part)?.island ?? ASSEMBLY);
    const opensReentry = ({ source, part, destination }) => parameters.reserve_stage05_reentry
      && source.name === ASSEMBLY && destination.name === CELL_A && part.kind === "M" && part.step === 1;
    const usesReentry = ({ part, destination }) => destination.name === ASSEMBLY && part.kind === "M"
      && part.step === 2 && destination.reentryHolds.has(part.order);

    function schedule(time, action) {
      if (!Number.isSafeInteger(time)) throw new RangeError("仿真时刻超出可精确表示的秒数");
      if (!events.has(time)) events.set(time, []);
      events.get(time).push(action);
    }

    function arrival() {
      arrived += 1;
      if (!batching) for (const kind of COMPONENTS) raw.push(makePart(arrived, kind));
      if (arrived < parameters.orders) schedule(arrived * parameters.interval, arrival);
    }

    function scheduleBatching() {
      for (const batch of batching.batches) {
        const orderNumbers = batch.order_ids.map((id) => Number(id.slice(1)));
        schedule(batch.prep_start, () => { preparing += orderNumbers.length; });
        schedule(batch.process_start, () => {
          if (batchers.has(batch.machine)) throw new Error(`S01设备 ${batch.machine} 工位重叠`);
          preparing -= orderNumbers.length;
          batchers.set(batch.machine, batch.batch_id);
        });
        schedule(batch.process_end, () => {
          if (batchers.get(batch.machine) !== batch.batch_id) throw new Error("S01设备占用记录不符");
          batchers.delete(batch.machine);
          postProcessing += orderNumbers.length;
        });
        schedule(batch.finish, () => {
          postProcessing -= orderNumbers.length;
          for (const order of orderNumbers) {
            released.add(order);
            readyKits.set(order, COMPONENTS.length);
            for (const kind of COMPONENTS) raw.push({ ...makePart(order, kind), entered: now });
          }
        });
      }
    }

    function enqueue(island, part) {
      part.entered = now;
      island.buffer.push(part);
      island.adjustBuffer(part, kitReady(part), 1);
    }

    function remove(island, part) {
      take(island.buffer, part);
      island.adjustBuffer(part, kitReady(part), -1);
    }

    function tryReturn() {
      let selected;
      for (const island of islands) {
        for (const work of island.work) {
          if (work.finishedAt === null) continue;
          if (!work.returnSlot && !island.canReceive(work.part, kitReady(work.part))) continue;
          const key = priority(work.part, work.finishedAt);
          if (!selected || earlier(key, selected.key)) selected = { island, work, key };
        }
      }
      if (!selected) return false;
      take(selected.island.work, selected.work);
      enqueue(selected.island, selected.work.part);
      return true;
    }

    function readyWork(island) {
      const kits = new Map();
      let choice;
      for (const part of island.buffer) {
        if (kitReady(part) && island.name === ASSEMBLY) {
          if (!kits.has(part.order)) kits.set(part.order, []);
          kits.get(part.order).push(part);
        } else if (visit(part) && target(part) === island) {
          const key = priority(part);
          if (!choice || earlier(key, choice.key)) choice = { parts: [part], key };
        }
      }
      for (const [order, parts] of kits) {
        if (parts.length !== COMPONENTS.length) continue;
        const key = [order, Math.max(...parts.map((part) => part.entered)), KINDS.indexOf("M")];
        if (!choice || earlier(key, choice.key)) choice = { parts, key };
      }
      return choice?.parts;
    }

    function tryStart() {
      for (const island of islands) {
        if (island.work.length >= island.machines) continue;
        const parts = readyWork(island);
        if (!parts) continue;
        for (const part of parts) remove(island, part);
        const part = parts.length === 1 ? parts[0] : makePart(parts[0].order, "M");
        const needsReturn = part.kind !== "M" || part.step + 1 < routes.M.length;
        const work = { part, finishedAt: null, returnSlot: parameters.reserve_return && needsReturn };
        if (batching) {
          const occupied = new Set(island.work.map((entry) => entry.machine));
          work.machine = 1;
          while (occupied.has(work.machine)) work.machine += 1;
        }
        island.work.push(work);
        schedule(now + visit(part).seconds, () => {
          part.step += 1;
          if (part.kind === "M" && !visit(part)) {
            take(island.work, work);
            completed.set(part.order, now);
          } else {
            work.finishedAt = now;
          }
        });
        return true;
      }
      return false;
    }

    function tryTransport() {
      let selected;
      for (const source of islands) {
        for (const part of source.buffer) {
          const destination = target(part);
          if (destination === source) continue;
          if (!destination.canReceive(part, kitReady(part)) && !usesReentry({ part, destination })) continue;
          const key = priority(part);
          if (!selected || earlier(key, selected.key)) selected = { source, part, destination, key };
        }
      }
      if (!selected) return false;
      withdraw(selected);
      send(selected);
      return true;
    }

    function withdraw(move) {
      const { source, part } = move;
      remove(source, part);
      if (opensReentry(move)) source.reentryHolds.add(part.order);
    }

    function send(move) {
      const { source, part, destination } = move;
      const ready = kitReady(part);
      const fromBatching = source === batchingIsland;
      if (usesReentry(move)) destination.reentryHolds.delete(part.order);
      destination.adjustInbound(part, ready, 1);
      inTransit += 1;
      if (batching) {
        if (shipments.has(part)) throw new Error("同一工件已在 AGV 上");
        shipments.set(part, { destination, ready });
      }
      const seconds = fromBatching ? batching.config.transportSeconds : transport[source.index][destination.index];
      const end = now + seconds;
      trips.push([now, end, source.index, destination.index, `${String(part.order).padStart(2, "0")}-${PUBLIC_KINDS[part.kind]}`]);
      schedule(end, () => {
        inTransit -= 1;
        if (batching) shipments.delete(part);
        destination.adjustInbound(part, ready, -1);
        enqueue(destination, part);
        if (fromBatching) recordAdmission(part);
      });
    }

    function tryExchange() {
      if (!parameters.paired_exchange || inTransit
          || islands.some((island) => island.work.some((work) => work.finishedAt === null))) return false;

      const directions = new Map();
      const direction = (source, destination) => source.index * islands.length + destination.index;
      for (const source of islands) {
        if (source.available !== 0) continue;
        for (const part of source.buffer) {
          const destination = target(part);
          const sharedKit = kitReady(part) && (!batching || source.sharedKit || destination.sharedKit);
          if (destination === source || destination.available !== 0 || sharedKit) continue;
          const move = { source, part, destination, key: priority(part) };
          if (opensReentry(move) || usesReentry(move)) continue;
          const index = direction(source, destination);
          const previous = directions.get(index);
          if (!previous || earlier(move.key, previous.key)) directions.set(index, move);
        }
      }

      let pair;
      for (const first of directions.values()) {
        const second = directions.get(direction(first.destination, first.source));
        if (second && (!pair || earlier(first.key, pair[0].key))) pair = [first, second];
      }
      if (!pair) return false;
      // Both sources relinquish their slot before either trip reserves its destination.
      for (const move of pair) withdraw(move);
      for (const move of pair) send(move);
      pairedExchanges += 1;
      return true;
    }

    function tryAdmit() {
      if (rawHead >= raw.length || entryIsland.available <= 0) return false;
      if (batching) {
        let index = 0;
        for (let candidate = 1; candidate < raw.length; candidate += 1) {
          if (raw[candidate].order < raw[index].order) index = candidate;
        }
        const part = raw[index];
        send({ source: batchingIsland, part, destination: entryIsland });
        raw.splice(index, 1);
        const remaining = readyKits.get(part.order);
        if (remaining === 1) readyKits.delete(part.order);
        else readyKits.set(part.order, remaining - 1);
        return true;
      }
      const part = raw[rawHead];
      rawHead += 1;
      enqueue(entryIsland, part);
      recordAdmission(part);
      return true;
    }

    function recordAdmission(part) {
      if (!admission.has(part.order)) admission.set(part.order, []);
      admission.get(part.order).push(now);
    }

    function verifyLimits() {
      const processSlots = preparing + postProcessing + readyKits.size;
      if (processSlots > batchingIsland.capacity) {
        throw new RangeError(`S01 批处理缓冲在 ${now} 秒需要 ${processSlots} 格，当前容量 ${batchingIsland.capacity} 格`);
      }
      if (preparing < 0 || postProcessing < 0 || batchers.size > batchingIsland.machines) {
        throw new Error(`S01 批处理工位或缓冲计数在 ${now} 秒异常`);
      }
      audit.peak_slots[BATCH_INDEX] = Math.max(audit.peak_slots[BATCH_INDEX], processSlots);
      audit.peak_workstations[BATCH_INDEX] = Math.max(audit.peak_workstations[BATCH_INDEX], batchers.size);
      for (const island of islands) {
        if (island.available < 0 || island.ordinaryOccupied < 0 || island.ordinaryInbound < 0) {
          throw new Error(`${island.name}缓冲在 ${now} 秒超限或计数为负`);
        }
        const occupied = new Set(island.work.map((work) => work.machine));
        const invalidMachine = (work) => !Number.isSafeInteger(work.machine) || work.machine < 1 || work.machine > island.machines;
        if (occupied.size !== island.work.length || island.work.some(invalidMachine)) {
          throw new Error(`${island.name}加工位在 ${now} 秒重复占用或超限`);
        }
      }
    }

    function verifyState() {
      const contents = new Map();
      const holds = new Set();
      const observe = (part) => {
        if (!released.has(part.order) || part.order > arrived || completed.has(part.order)) {
          throw new Error(`订单 ${part.order} 的工件 ${PUBLIC_KINDS[part.kind]} 在 ${now} 秒位置异常`);
        }
        const kinds = contents.get(part.order) ?? new Set();
        if (kinds.has(part.kind)) throw new Error(`订单 ${part.order} 的工件 ${PUBLIC_KINDS[part.kind]} 重复占用`);
        kinds.add(part.kind);
        contents.set(part.order, kinds);
        if (part.kind === "M" && (part.step === 1 || part.step === 2)
            && byName.get(ASSEMBLY).reentryHolds.has(part.order)) holds.add(part.order);
      };
      const waiting = new Map();
      for (const part of raw) {
        waiting.set(part.order, (waiting.get(part.order) ?? 0) + 1);
        observe(part);
      }
      if (!sameCounts(waiting, readyKits)) throw new Error("S01 批处理待转运格与订单不符");

      const ordinaryInbound = Array(BATCH_INDEX).fill(0);
      const kitInbound = new Map();
      for (const [part, shipment] of shipments) {
        const { destination, ready } = shipment;
        if (destination.sharedKit && ready) kitInbound.set(part.order, (kitInbound.get(part.order) ?? 0) + 1);
        else ordinaryInbound[destination.index] += 1;
        observe(part);
      }
      if (inTransit !== shipments.size || !sameCounts(kitInbound, byName.get(ASSEMBLY).kitInbound)) {
        throw new Error("AGV 占用与齐套预留不符");
      }
      for (const island of islands) {
        const kitBuffer = new Map();
        let ordinary = 0;
        for (const part of island.buffer) {
          if (island.sharedKit && kitReady(part)) kitBuffer.set(part.order, (kitBuffer.get(part.order) ?? 0) + 1);
          else ordinary += 1;
          observe(part);
        }
        for (const work of island.work) observe(work.part);
        if (ordinary !== island.ordinaryOccupied || !sameCounts(kitBuffer, island.kitBuffer)
            || ordinaryInbound[island.index] !== island.ordinaryInbound) {
          throw new Error(`${island.name}库位与实物、在途预留不符`);
        }
        const kits = new Set([...kitBuffer.keys(), ...(island.sharedKit ? kitInbound.keys() : [])]);
        const used = ordinary + ordinaryInbound[island.index] + kits.size
          + island.work.filter((work) => work.returnSlot).length + island.reentryHolds.size;
        if (used > island.capacity || used !== island.capacity - island.available) {
          throw new Error(`${island.name}库位在 ${now} 秒超限或预留总数不符`);
        }
        audit.peak_slots[island.index] = Math.max(audit.peak_slots[island.index], used);
        audit.peak_workstations[island.index] = Math.max(audit.peak_workstations[island.index], island.work.length);
      }
      if (holds.size !== byName.get(ASSEMBLY).reentryHolds.size || contents.size + completed.size !== released.size) {
        throw new Error(`订单数量或S05整机回流预留在 ${now} 秒不符`);
      }
      for (const kinds of contents.values()) {
        const merged = kinds.size === 1 && kinds.has("M");
        const completeKit = kinds.size === COMPONENTS.length && COMPONENTS.every((kind) => kinds.has(kind));
        if (!merged && !completeKit) {
          throw new Error(`同一订单在 ${now} 秒的齐套或整机数量异常`);
        }
      }
      if (lastAuditedTime !== now) audit.events_checked += 1;
      lastAuditedTime = now;
    }

    function recordFrame() {
      const counts = islands.map((island) => [
        island.occupied, island.inbound, island.returnReserved, island.work.length, island.buffer.length,
        ...(parameters.reserve_stage05_reentry ? [island.reentryHolds.size] : []),
      ]);
      const frame = [now, arrived, completed.size, raw.length - rawHead, inTransit, counts];
      if (batching) {
        const used = preparing + postProcessing + readyKits.size;
        counts.push([used, 0, 0, batchers.size, used, ...(parameters.reserve_stage05_reentry ? [0] : [])]);
        frame.push([preparing, postProcessing, readyKits.size]);
      }
      if (frames.length && frames[frames.length - 1][0] === now) frames[frames.length - 1] = frame;
      else frames.push(frame);
    }

    schedule(0, arrival);
    if (batching) scheduleBatching();
    while (events.size) {
      now = Infinity;
      for (const time of events.keys()) now = Math.min(now, time);
      const batch = events.get(now);
      events.delete(now);
      for (const action of batch) action();
      if (batching) verifyLimits();
      // Python settles only after applying all events at a time; a zero-time move
      // creates another batch at the same time and replaces its trace frame.
      while (tryReturn() || tryStart() || tryTransport() || tryAdmit()) {
        // Each action restarts the same resource-priority order.
        if (batching) verifyLimits();
      }
      if (tryExchange() && batching) verifyLimits();
      if (batching) verifyState();
      recordFrame();
    }

    const orders = [];
    let totalElapsed = 0;
    let totalFlowTime = 0;
    for (let order = 1; order <= parameters.orders; order += 1) {
      const arrivedAt = (order - 1) * parameters.interval;
      const entered = admission.get(order) ?? [];
      const completedAt = completed.get(order) ?? null;
      const firstAdmitted = entered[0] ?? null;
      const elapsed = completedAt === null ? null : completedAt - firstAdmitted;
      const flowTime = completedAt === null ? null : completedAt - arrivedAt;
      totalElapsed += elapsed ?? 0;
      totalFlowTime += flowTime ?? 0;
      orders.push({
        order,
        arrived_at: arrivedAt,
        first_admitted_at: firstAdmitted,
        last_admitted_at: entered.length === COMPONENTS.length ? entered[entered.length - 1] : null,
        completed_at: completedAt,
        elapsed,
        flow_time: flowTime,
      });
    }

    return {
      ...settings, frames, trips, orders,
      ...(batching ? { islands: [...islandSettings, {
        name: BATCH, capacity: batchingIsland.capacity, machines: batchingIsland.machines,
      }], batching, audit } : {}),
      summary: {
        finished: completed.size,
        final_time: now,
        average_elapsed: completed.size ? totalElapsed / completed.size : null,
        average_flow_time: completed.size ? totalFlowTime / completed.size : null,
        deadlock: completed.size < parameters.orders,
        ...(parameters.paired_exchange ? { paired_exchanges: pairedExchanges } : {}),
      },
    };
  }

  const engine = { simulate };
  root.SixIslandEngine = engine;
  if (typeof module !== "undefined" && module.exports) module.exports = engine;
})(globalThis);
