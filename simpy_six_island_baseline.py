"""Synthetic SimPy demo with three component routes and an optional batch island.

All routes, times, capacities and identifiers in this public demo are fabricated.

Install SimPy with `python -m pip install simpy==4.1.1`.
Run the 36-order synthetic scenario with:
    python simpy_six_island_baseline.py --orders 36 --reserve-return --shared-kit-slot
Add --order-csv order_times.csv or --trace-json trace.json to export results.
Add --batching-config settings.json to simulate the complete seven-island line.
"""

import argparse
import csv
import json
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from itertools import chain
from math import inf
from pathlib import Path
from statistics import fmean

import simpy


CELL_A, CELL_B, CELL_C, ASSEMBLY, CELL_E, CELL_F = ISLANDS = (
    "S02", "S03", "S04", "S05", "S06", "S07"
)
BATCHING = "S01"
KINDS = ("L", "R", "F")
KIND_PRIORITY = {kind: index for index, kind in enumerate((*KINDS, "M"))}
PUBLIC_KINDS = {"L": "A", "R": "B", "F": "C", "M": "P"}
# Arbitrary synthetic travel times; these are not measured layout distances.
TRANSPORT = (
    (0, 11, 19, 17, 23, 29),
    (11, 0, 22, 26, 13, 21),
    (19, 22, 0, 15, 18, 24),
    (17, 26, 15, 0, 12, 16),
    (23, 13, 18, 12, 0, 10),
    (29, 21, 24, 16, 10, 0),
)
TRAVEL_TIME = {
    (source, target): seconds
    for source, row in zip(ISLANDS, TRANSPORT)
    for target, seconds in zip(ISLANDS, row)
}


@dataclass(frozen=True)
class Visit:
    island: str
    seconds: int
    operations: str


# Fabricated routes preserve re-entry and assembly behavior for demonstrations.
ROUTES = {
    "L": (
        Visit(CELL_A, 52, "A-1"),
        Visit(CELL_B, 76, "A-2"),
        Visit(CELL_E, 41, "A-3"),
        Visit(CELL_A, 68, "A-4"),
        Visit(CELL_C, 125, "A-5"),
    ),
    "R": (
        Visit(CELL_A, 47, "B-1"),
        Visit(CELL_F, 83, "B-2"),
        Visit(CELL_C, 96, "B-3"),
        Visit(CELL_E, 58, "B-4"),
    ),
    "F": (
        Visit(CELL_A, 63, "C-1"),
        Visit(CELL_E, 49, "C-2"),
        Visit(CELL_B, 72, "C-3"),
        Visit(CELL_A, 39, "C-4"),
    ),
    "M": (
        Visit(ASSEMBLY, 88, "P-1"),
        Visit(CELL_A, 57, "P-2"),
        Visit(ASSEMBLY, 64, "P-3"),
        Visit(CELL_A, 46, "P-4"),
    ),
}


@dataclass(eq=False)
class Part:
    order: int
    kind: str
    step: int = 0
    entered_buffer: int = 0

    @property
    def label(self):
        return f"{self.order:02d}-{PUBLIC_KINDS[self.kind]}"

    @property
    def visit(self):
        route = ROUTES[self.kind]
        return route[self.step] if self.step < len(route) else None

    @property
    def target(self):
        return self.visit.island if self.visit is not None else ASSEMBLY

    @property
    def ready_for_kit(self):
        return self.kind in KINDS and self.visit is None

    @property
    def priority(self):
        return self.order, self.entered_buffer, KIND_PRIORITY[self.kind]


@dataclass(eq=False)
class Work:
    part: Part
    visit: Visit
    machine: int
    finished_at: int | None = None
    return_slot: bool = False


@dataclass
class Island:
    name: str
    capacity: int
    machines: int
    buffer: list[Part] = field(default_factory=list)
    work: list[Work] = field(default_factory=list)
    reserved: int = 0
    shared_kit_slot: bool = False
    kit_inbound: Counter[int] = field(default_factory=Counter)
    reentry_holds: set[int] = field(default_factory=set)

    def shares_kit_slot(self, part):
        return self.shared_kit_slot and part.ready_for_kit

    @property
    def buffered_kit_orders(self):
        return [part.order for part in self.buffer if self.shares_kit_slot(part)]

    @property
    def occupied_slots(self):
        kits = self.buffered_kit_orders
        return len(self.buffer) - len(kits) + len(set(kits))

    @property
    def inbound_reserved(self):
        # A kit needs one reservation until its first physical arrival.
        return self.reserved + len(self.kit_inbound.keys() - set(self.buffered_kit_orders))

    @property
    def return_reserved(self):
        return sum(work.return_slot for work in self.work)

    @property
    def available(self):
        return (
            self.capacity - self.occupied_slots - self.inbound_reserved
            - self.return_reserved - len(self.reentry_holds)
        )

    def has_reentry_hold(self, part):
        return part.kind == "M" and part.step == 2 and part.order in self.reentry_holds

    def can_receive(self, part):
        return self.available > 0 or self.has_reentry_hold(part) or (
            self.shares_kit_slot(part)
            and (part.order in self.kit_inbound or part.order in self.buffered_kit_orders)
        )

    def reserve_delivery(self, part):
        if self.has_reentry_hold(part):
            self.reentry_holds.remove(part.order)
        if self.shares_kit_slot(part):
            self.kit_inbound[part.order] += 1
        else:
            self.reserved += 1

    def finish_delivery(self, part):
        if self.shares_kit_slot(part):
            self.kit_inbound[part.order] -= 1
            if self.kit_inbound[part.order] == 0:
                del self.kit_inbound[part.order]
        else:
            self.reserved -= 1


@dataclass(eq=False)
class Shipment:
    part: Part
    target: Island
    from_batching: bool = False


class BatchingIsland:
    """Replay the batching plan on the line clock with a shared kit buffer."""

    def __init__(self, orders, interval, config):
        def integer(value, label, minimum, maximum=2**53 - 1):
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError(f"{label}须为 {minimum} 至 {maximum} 之间的整数")
            return value

        integer(orders, "七岛订单数", 1, 200)
        integer(interval, "到单间隔（秒）", 1)
        integer((orders - 1) * interval, "最后一单到达时刻", 0)
        if not isinstance(config, dict) or not isinstance(config.get("durations"), list):
            raise ValueError("批处理设置须包含按整盘订单数填写的 durations 工时表")
        durations = config["durations"]
        patterns = {}
        for size, minutes in enumerate(durations):
            if minutes is not None:
                integer(size, "装盘订单数", 1, 8)
                patterns[2 * size, size] = 60 * integer(minutes, "整盘批处理分钟数", 1, (2**53 - 1) // 60)
        capacity = config.get("capacity")
        transport_seconds = config.get("transportSeconds")
        self.config = {
            "machineCount": integer(config.get("machineCount"), "S01设备数", 1, 30),
            "prepMinutes": integer(config.get("prepMinutes"), "准备分钟数", 0),
            "postMinutes": integer(config.get("postMinutes"), "后处理分钟数", 0),
            "switchMinutes": integer(config.get("switchMinutes"), "换盘分钟数", 0),
            "waitMinutes": integer(config.get("waitMinutes", 0), "等单分钟数", 0, 1440),
            "durations": durations[:],
            "capacity": integer(max(400, orders) if capacity is None else capacity, "批处理缓冲格数", 1),
            "transportSeconds": integer(14 if transport_seconds is None else transport_seconds,
                                        "批处理到S02搬运秒数", 0),
        }
        self.capacity = self.config["capacity"]
        self.machines = self.config["machineCount"]
        self.stages = {}
        self.pending_orders = set()
        self.ready_parts = Counter()
        self.active_batches = {}

        # The standalone scheduling CLI imports its sibling solver by name.
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scheduling"))
        try:
            from arrival_sim import simulate
        finally:
            sys.path.pop(0)
        arrivals = tuple(index * interval for index in range(orders))
        prep, post, switch, wait = (
            60 * self.config[name]
            for name in ("prepMinutes", "postMinutes", "switchMinutes", "waitMinutes")
        )
        schedule = simulate(arrivals, patterns, self.machines, prep, post, switch, wait)
        integer(schedule["makespan"], "批处理结束时刻", 0)
        self.trace = {"config": self.config, **{key: schedule[key] for key in ("orders", "batches", "makespan")}}
        self.verify_schedule(arrivals, patterns, prep, post, switch)

    def verify_schedule(self, arrivals, patterns, prep, post, switch):
        covered = set()
        previous = {}
        for batch in sorted(self.trace["batches"], key=lambda batch: batch["process_start"]):
            machine = batch["machine"]
            start, end = batch["process_start"], batch["process_end"]
            orders = [int(order_id[1:]) for order_id in batch["order_ids"]]
            count = len(orders)
            if not 1 <= machine <= self.machines or batch["switch_start"] != previous.get(machine) or (
                machine in previous and start < previous[machine] + switch
            ):
                raise RuntimeError(f"S01设备 {machine} 的批次占用重叠或切换间隔不足")
            if (
                not orders or len(set(orders)) != count or covered.intersection(orders)
                or any(not 1 <= order <= len(arrivals) or arrivals[order - 1] > batch["prep_start"]
                       for order in orders)
                or start - batch["prep_start"] != prep or end - start != patterns.get((2 * count, count))
                or batch["finish"] - end != post
            ):
                raise RuntimeError(f"批处理批次 {batch['batch_id']} 的订单分配或工时不一致")
            previous[machine] = end
            covered.update(orders)
        if covered != set(range(1, len(arrivals) + 1)):
            raise RuntimeError("批处理排程缺少订单")

    def run_batch(self, env, batch, raw):
        orders = [int(order_id[1:]) for order_id in batch["order_ids"]]
        yield env.timeout(batch["prep_start"])
        self.stages.update(dict.fromkeys(orders, "prep"))
        yield env.timeout(batch["process_start"] - batch["prep_start"])
        self.stages.update(dict.fromkeys(orders, "batching"))
        self.active_batches[batch["batch_id"]] = batch["machine"]
        yield env.timeout(batch["process_end"] - batch["process_start"])
        del self.active_batches[batch["batch_id"]]
        self.stages.update(dict.fromkeys(orders, "post"))
        yield env.timeout(batch["finish"] - batch["process_end"])
        for order in orders:
            self.pending_orders.remove(order)
            self.stages[order] = "waiting"
            self.ready_parts[order] = len(KINDS)
            raw.extend(Part(order, kind, entered_buffer=env.now) for kind in KINDS)

    def pickup(self, part):
        self.ready_parts[part.order] -= 1
        if self.ready_parts[part.order] == 0:
            del self.ready_parts[part.order]
            del self.stages[part.order]

    @property
    def buffer_counts(self):
        counts = Counter(self.stages.values())
        return [counts[stage] for stage in ("prep", "post", "waiting")]

    def verify_resources(self, time):
        used = sum(self.buffer_counts)
        if used > self.capacity:
            raise ValueError(f"S01批处理共享缓冲容量不足，t={time} 秒需要 {used} 格，容量 {self.capacity} 格")
        busy_machines = self.active_batches.values()
        if len(set(busy_machines)) != len(busy_machines):
            raise RuntimeError(f"t={time} 秒存在多盘占用同一S01设备")
        return used


class Baseline:
    def __init__(
        self, orders=36, interval=300, *, reserve_return=False, shared_kit_slot=False,
        reserve_stage05_reentry=False, paired_exchange=False, capture_trace=False, batching=None,
    ):
        self.env = simpy.Environment()
        self.orders = orders
        self.interval = interval
        self.reserve_return = reserve_return
        self.reserve_stage05_reentry = reserve_stage05_reentry
        self.paired_exchange = paired_exchange
        self.islands = {name: Island(name, 12, 2) for name in ISLANDS}
        self.islands[CELL_A] = Island(CELL_A, 24, 3)
        self.islands[ASSEMBLY].shared_kit_slot = shared_kit_slot
        self.arrived = 0
        self.raw = []
        self.in_transit = []
        self.completed = {}
        self.arrivals = {}
        self.admissions = defaultdict(list)
        self.frames = [] if capture_trace else None
        self.trips = [] if capture_trace else None
        self.transport_count = 0
        self.transport_seconds = 0
        self.paired_exchanges = 0
        self.stall = None
        self.batching = BatchingIsland(orders, interval, batching) if batching is not None else None
        self.events_checked = 0
        self.last_checked_at = None
        self.peak_slots = [0] * (len(ISLANDS) + 1)
        self.peak_workstations = [0] * (len(ISLANDS) + 1)

    def enqueue(self, island, part):
        part.entered_buffer = self.env.now
        island.buffer.append(part)

    def order_arrival(self, order):
        yield self.env.timeout((order - 1) * self.interval)
        self.arrived += 1
        self.arrivals[order] = self.env.now
        if self.batching is None:
            self.raw.extend(Part(order, kind) for kind in KINDS)
        else:
            self.batching.pending_orders.add(order)

    def process(self, island, work):
        yield self.env.timeout(work.visit.seconds)
        part = work.part
        part.step += 1
        if part.kind == "M" and part.visit is None:
            island.work.remove(work)
            self.completed[part.order] = self.env.now
        else:
            work.finished_at = self.env.now

    def deliver(self, shipment, seconds):
        yield self.env.timeout(seconds)
        self.in_transit.remove(shipment)
        shipment.target.finish_delivery(shipment.part)
        self.enqueue(shipment.target, shipment.part)
        if shipment.from_batching:
            self.admissions[shipment.part.order].append(self.env.now)

    def try_return(self):
        candidates = (
            (island, work)
            for island in self.islands.values()
            for work in island.work
            if work.finished_at is not None and (work.return_slot or island.can_receive(work.part))
        )
        selected = min(
            candidates,
            key=lambda item: (item[1].part.order, item[1].finished_at,
                              KIND_PRIORITY[item[1].part.kind]),
            default=None,
        )
        if selected is None:
            return False
        island, work = selected
        island.work.remove(work)
        self.enqueue(island, work.part)
        return True

    def eligible(self, island):
        kits = defaultdict(list)
        for part in island.buffer:
            if part.visit is not None and part.target == island.name:
                yield part.priority, (part,)
            elif island.name == ASSEMBLY and part.ready_for_kit:
                kits[part.order].append(part)
        for order, parts in kits.items():
            if {part.kind for part in parts} == set(KINDS):
                ready_at = max(part.entered_buffer for part in parts)
                yield (order, ready_at, KIND_PRIORITY["M"]), tuple(parts)

    def try_start(self):
        for island in self.islands.values():
            if len(island.work) >= island.machines:
                continue
            choice = min(self.eligible(island), key=lambda candidate: candidate[0], default=None)
            if choice is None:
                continue
            _, parts = choice
            for part in parts:
                island.buffer.remove(part)
            part = parts[0] if len(parts) == 1 else Part(parts[0].order, "M")
            # Convert one of the vacated slots into this job's exclusive return slot.
            # The final M visit leaves the system directly after IN03.
            needs_return = part.kind != "M" or part.step + 1 < len(ROUTES["M"])
            occupied = {work.machine for work in island.work}
            machine = next(index for index in range(1, island.machines + 1) if index not in occupied)
            work = Work(part, part.visit, machine, return_slot=self.reserve_return and needs_return)
            island.work.append(work)
            self.env.process(self.process(island, work))
            return True
        return False

    def try_transport(self):
        candidates = (
            (source, part)
            for source in self.islands.values()
            for part in source.buffer
            if part.target != source.name and self.islands[part.target].can_receive(part)
        )
        choice = min(candidates, key=lambda item: item[1].priority, default=None)
        if choice is None:
            return False
        source, part = choice
        target = self.islands[part.target]
        target.reserve_delivery(part)
        source.buffer.remove(part)
        if self.needs_lock_hold(source, part):
            source.reentry_holds.add(part.order)
        self.schedule_delivery(source.name, part, target)
        return True

    def needs_lock_hold(self, source, part):
        return (
            self.reserve_stage05_reentry and source.name == ASSEMBLY
            and part.kind == "M" and part.step == 1
        )

    def schedule_delivery(self, source_name, part, target):
        from_batching = source_name == BATCHING
        shipment = Shipment(part, target, from_batching)
        self.in_transit.append(shipment)
        if from_batching:
            seconds = self.batching.config["transportSeconds"]
            source_index = len(ISLANDS)
        else:
            seconds = TRAVEL_TIME[source_name, target.name]
            source_index = ISLANDS.index(source_name)
        self.transport_count += 1
        self.transport_seconds += seconds
        if self.trips is not None:
            self.trips.append([
                self.env.now, self.env.now + seconds, source_index,
                ISLANDS.index(target.name), part.label,
            ])
        self.env.process(self.deliver(shipment, seconds))

    def has_active_work(self):
        return self.in_transit or any(
            work.finished_at is None
            for island in self.islands.values()
            for work in island.work
        )

    def try_pair_exchange(self):
        if not self.paired_exchange or self.has_active_work():
            return False
        candidates = sorted(
            (
                (source, part, target)
                for source in self.islands.values() if source.available == 0
                for part in source.buffer
                if (target := self.islands[part.target]) is not source
                and target.available == 0 and not target.can_receive(part)
                and not source.shares_kit_slot(part) and not target.shares_kit_slot(part)
                and not self.needs_lock_hold(source, part)
            ),
            key=lambda move: move[1].priority,
        )
        first_by_route = {}
        for source, part, target in candidates:
            first_by_route.setdefault((source.name, target.name), part)
        for source, part, target in candidates:
            reciprocal = first_by_route.get((target.name, source.name))
            if reciprocal is None:
                continue
            # Take both parts before assigning either inbound slot.
            source.buffer.remove(part)
            target.buffer.remove(reciprocal)
            target.reserve_delivery(part)
            source.reserve_delivery(reciprocal)
            self.schedule_delivery(source.name, part, target)
            self.schedule_delivery(target.name, reciprocal, source)
            self.paired_exchanges += 1
            return True
        return False

    def try_admit(self):
        entry_island = self.islands[CELL_A]
        if not self.raw or entry_island.available <= 0:
            return False
        if self.batching is not None:
            part = min(self.raw, key=lambda part: part.priority)
            entry_island.reserve_delivery(part)
            self.raw.remove(part)
            self.batching.pickup(part)
            self.schedule_delivery(BATCHING, part, entry_island)
            return True
        part = self.raw.pop(0)
        self.enqueue(entry_island, part)
        self.admissions[part.order].append(self.env.now)
        return True

    def settle(self):
        # Recheck higher-priority moves after every action that can free a slot.
        while (
            self.try_return() or self.try_start() or self.try_transport()
            or self.try_admit() or self.try_pair_exchange()
        ):
            if self.batching is not None:
                self.verify_resource_limits()

    def verify_resource_limits(self):
        for island in self.islands.values():
            if island.available < 0:
                raise RuntimeError(f"t={self.env.now} 秒{island.name}缓冲区超容量")
            workstations = {work.machine for work in island.work}
            if len(workstations) != len(island.work) or any(
                not 1 <= machine <= island.machines for machine in workstations
            ):
                raise RuntimeError(f"t={self.env.now} 秒{island.name}加工位分配冲突")
        if self.batching is not None:
            used = self.batching.verify_resources(self.env.now)
            self.peak_slots[-1] = max(self.peak_slots[-1], used)

    def verify_state(self):
        contents = defaultdict(list)
        reservations = Counter()
        kit_reservations = Counter()
        for shipment in self.in_transit:
            if shipment.target.shares_kit_slot(shipment.part):
                kit_reservations[shipment.part.order] += 1
            else:
                reservations[shipment.target.name] += 1
        assert self.islands[ASSEMBLY].kit_inbound == kit_reservations
        self.verify_resource_limits()
        for island in self.islands.values():
            assert island.reserved == reservations[island.name]
            if self.reserve_return:
                assert all(work.finished_at is None for work in island.work)
        pieces = chain(
            self.raw, (shipment.part for shipment in self.in_transit),
            (part for island in self.islands.values() for part in island.buffer),
            (work.part for island in self.islands.values() for work in island.work),
        )
        held_orders = self.islands[ASSEMBLY].reentry_holds
        active_holds = set()
        for part in pieces:
            contents[part.order].append(part.kind)
            if part.kind == "M" and part.step in (1, 2) and part.order in held_orders:
                active_holds.add(part.order)
        assert active_holds == held_orders
        pending = self.batching.pending_orders if self.batching is not None else set()
        assert len(contents) + len(self.completed) + len(pending) == self.arrived
        assert not (pending & (contents.keys() | self.completed.keys()))
        assert not (contents.keys() & self.completed.keys())
        assert all(sorted(kinds) in (["F", "L", "R"], ["M"]) for kinds in contents.values())
        if self.batching is not None:
            assert self.batching.ready_parts == Counter(part.order for part in self.raw)
            assert {order for order, stage in self.batching.stages.items() if stage == "waiting"} == set(
                self.batching.ready_parts
            )
            if self.last_checked_at != self.env.now:
                self.events_checked += 1
                self.last_checked_at = self.env.now
            for i, island in enumerate(self.islands.values()):
                self.peak_slots[i] = max(self.peak_slots[i], island.capacity - island.available)
                self.peak_workstations[i] = max(self.peak_workstations[i], len(island.work))
            self.peak_workstations[-1] = max(self.peak_workstations[-1], len(self.batching.active_batches))

    def update_stall(self):
        if (self.has_active_work() or self.arrived == len(self.completed)
                or (self.batching is not None and self.batching.pending_orders)):
            self.stall = None
        elif self.stall is None:
            self.stall = (self.env.now, self.status_lines())

    def run(self):
        for order in range(1, self.orders + 1):
            self.env.process(self.order_arrival(order))
        if self.batching is not None:
            for batch in self.batching.trace["batches"]:
                self.env.process(self.batching.run_batch(self.env, batch, self.raw))
        while self.env.peek() < inf:
            time = self.env.peek()
            # Apply all completions, deliveries and arrivals at this time together.
            while self.env.peek() == time:
                self.env.step()
            if self.batching is not None:
                self.verify_resource_limits()
            self.settle()
            self.verify_state()
            self.update_stall()
            if self.frames is not None:
                self.record_frame()
        if self.frames is not None:
            self.record_frame()

    def record_frame(self):
        frame = [
            self.env.now, self.arrived, len(self.completed), len(self.raw), len(self.in_transit),
            [
                [island.occupied_slots, island.inbound_reserved, island.return_reserved,
                 len(island.work), len(island.buffer)]
                for island in self.islands.values()
            ],
        ]
        if self.reserve_stage05_reentry:
            for island, counts in zip(self.islands.values(), frame[5]):
                counts.append(len(island.reentry_holds))
        if self.batching is not None:
            buffer_counts = self.batching.buffer_counts
            occupied = sum(buffer_counts)
            process_state = [occupied, 0, 0, len(self.batching.active_batches), occupied]
            if self.reserve_stage05_reentry:
                process_state.append(0)
            frame[5].append(process_state)
            frame.append(buffer_counts)
        if self.frames and frame[0] == self.frames[-1][0]:
            self.frames[-1] = frame
        else:
            self.frames.append(frame)

    def order_rows(self):
        rows = []
        for order in range(1, self.orders + 1):
            arrived = self.arrivals.get(order)
            admission_times = self.admissions.get(order, ())
            first_admitted = admission_times[0] if admission_times else None
            completed = self.completed.get(order)
            rows.append({
                "order": order,
                "arrived_at": arrived,
                "first_admitted_at": first_admitted,
                "last_admitted_at": admission_times[-1] if len(admission_times) == len(KINDS) else None,
                "completed_at": completed,
                "elapsed": completed - first_admitted if completed is not None else None,
                "flow_time": completed - arrived if completed is not None else None,
            })
        return rows

    def average_elapsed(self):
        if not self.completed:
            return None
        return fmean(completed - self.admissions[order][0] for order, completed in self.completed.items())

    def average_flow_time(self):
        if not self.completed:
            return None
        return fmean(completed - self.arrivals[order] for order, completed in self.completed.items())

    def export_orders(self, path):
        fields = {
            "order": "订单",
            "arrived_at": "订单到达时刻（秒）",
            "first_admitted_at": "入库时刻（首件入S02，秒）",
            "last_admitted_at": "齐入时刻（三件均入S02，秒）",
            "completed_at": "出库时刻（秒）",
            "elapsed": "入库至出库耗时（秒）",
            "flow_time": "订单到达至完工耗时（秒）",
        }
        with path.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=fields)
            writer.writerow(fields)
            writer.writerows(self.order_rows())

    def trace_data(self):
        trace = {
            "parameters": {
                "orders": self.orders,
                "interval": self.interval,
                "reserve_return": self.reserve_return,
                "shared_kit_slot": self.islands[ASSEMBLY].shared_kit_slot,
            },
            "islands": [
                {"name": island.name, "capacity": island.capacity, "machines": island.machines}
                for island in self.islands.values()
            ],
            "transport": TRANSPORT,
            "routes": {kind: [asdict(visit) for visit in visits] for kind, visits in ROUTES.items()},
            "frames": self.frames,
            "trips": self.trips,
            "orders": self.order_rows(),
            "summary": {
                "finished": len(self.completed),
                "final_time": self.env.now,
                "average_elapsed": self.average_elapsed(),
                "average_flow_time": self.average_flow_time(),
                "deadlock": self.stall is not None,
            },
        }
        if self.reserve_stage05_reentry:
            trace["parameters"]["reserve_stage05_reentry"] = True
        if self.paired_exchange:
            trace["parameters"]["paired_exchange"] = True
            trace["summary"]["paired_exchanges"] = self.paired_exchanges
        if self.batching is not None:
            trace["batching"] = self.batching.trace
            trace["islands"].append({
                "name": BATCHING, "capacity": self.batching.capacity, "machines": self.batching.machines,
            })
            trace["audit"] = {
                "events_checked": self.events_checked,
                "peak_slots": self.peak_slots,
                "peak_workstations": self.peak_workstations,
                "violations": 0,
            }
        return trace

    def export_trace(self, path):
        with path.open("w", encoding="utf-8") as stream:
            json.dump(self.trace_data(), stream, ensure_ascii=False, separators=(",", ":"))

    def status_lines(self):
        raw_label = "批处理后待运" if self.batching is not None else "岛外待投料"
        lines = [
            f"已到达 {self.arrived} 单，已出库 {len(self.completed)} 件，"
            f"{raw_label} {len(self.raw)} 件，AGV 在途 {len(self.in_transit)} 件",
            "工艺岛 | 实占格/容量 | 缓冲件数 | 入站预留格 | 回存预留格 | 整机回流预留格 | 加工位占用/总数 | 待加工 | 待外运 | 等齐套",
        ]
        waits = []
        kit_waits = defaultdict(set)
        locations = {part.label: raw_label for part in self.raw}
        if self.batching is not None:
            prep, post, waiting = self.batching.buffer_counts
            lines.append(
                f"{BATCHING} | 共用缓冲 {prep + post + waiting}/{self.batching.capacity} 格"
                f"（准备 {prep}，后处理 {post}，待运 {waiting}）"
                f" | S01设备 {len(self.batching.active_batches)}/{self.batching.machines}"
            )
        for island in self.islands.values():
            ready = [p for p in island.buffer if p.visit is not None and p.target == island.name]
            outbound = defaultdict(list)
            kit_count = 0
            for part in island.buffer:
                locations[part.label] = f"{island.name}缓冲（下一站{part.target}）"
                if part.target != island.name:
                    outbound[part.target].append(part.label)
                elif part.ready_for_kit:
                    kit_waits[part.order].add(part.kind)
                    kit_count += 1
            lines.append(
                f"{island.name} | {island.occupied_slots}/{island.capacity} | {len(island.buffer)} | "
                f"{island.inbound_reserved} | "
                f"{island.return_reserved} | {len(island.reentry_holds)} | "
                f"{len(island.work)}/{island.machines} | {len(ready)} | "
                f"{sum(map(len, outbound.values()))} | {kit_count}"
            )
            for work in island.work:
                locations[work.part.label] = f"{island.name}加工位"
                if work.finished_at is not None:
                    waits.append(
                        f"{island.name}加工位 → 本岛缓冲：{work.part.label} "
                        f"于 t={work.finished_at} 秒完成 {work.visit.operations}，等待回存。"
                    )
            if ready:
                labels = ", ".join(part.label for part in ready)
                waits.append(f"{island.name}缓冲 → 本岛加工位：{len(ready)} 件待加工（{labels}）。")
            for target, labels in outbound.items():
                waits.append(
                    f"{island.name}缓冲 → {target}缓冲：{len(labels)} 件待运"
                    f"（{', '.join(labels)}），目的可用位 {self.islands[target].available}。"
                )
        for order, kinds in sorted(kit_waits.items()):
            missing = [
                f"{PUBLIC_KINDS[kind]} 在{locations.get(f'{order:02d}-{PUBLIC_KINDS[kind]}', '途中')}"
                for kind in KINDS if kind not in kinds
            ]
            if missing:
                waits.append(
                    f"S05齐套 → 订单 {order:02d} 缺件：{', '.join(missing)}"
                    f"；已到 {'/'.join(k for k in KINDS if k in kinds)}。"
                )
            else:
                waits.append(f"S05齐套 → 加工位：订单 {order:02d} 已齐套待开工。")
        if self.raw:
            waits.append(f"{raw_label} → S02缓冲：{len(self.raw)} 件，目的可用位 {self.islands[CELL_A].available}。")
        return lines + ["等待关系"] + waits

    def report(self):
        mode = "开工预留回存位" if self.reserve_return else "无回存预留"
        if self.islands[ASSEMBLY].shared_kit_slot:
            mode += " + 同订单共用齐套位"
        if self.reserve_stage05_reentry:
            mode += " + S05整机回流预留"
        if self.paired_exchange:
            mode += " + 成对换位"
        print(f"{mode}场景：每 {self.interval} 秒 1 单，共 {self.orders} 单。")
        print(f"最后订单到达：t={(self.orders - 1) * self.interval} 秒。")
        print(f"仿真结束：t={self.env.now} 秒；成品出库：{len(self.completed)}/{self.orders} 件。")
        print(f"AGV 共执行 {self.transport_count} 趟，累计搬运 {self.transport_seconds} 秒。")
        if self.batching is not None:
            print(f"逐事件检查 {self.events_checked} 个时间点，未发现工位占用冲突或缓冲溢出。")
            print(f"S01批处理共用缓冲峰值 {self.peak_slots[-1]}/{self.batching.capacity} 格；"
                  f"S01设备同时工作峰值 {self.peak_workstations[-1]}/{self.batching.machines} 台。")
        if self.paired_exchange:
            print(f"成对换位：{self.paired_exchanges} 次。")
        if self.completed:
            print(f"首件出库：t={min(self.completed.values())} 秒；"
                  f"末件出库：t={max(self.completed.values())} 秒。")
            print(f"平均订单到达至完工耗时：{self.average_flow_time():.2f} 秒"
                  f"（已完工 {len(self.completed)} 单）。")
            print(f"平均入库至出库耗时：{self.average_elapsed():.2f} 秒"
                  f"（已完工 {len(self.completed)} 单，入库取首件进入S02的时刻）。")
        else:
            print("暂无已完工订单，无法计算平均订单到达至完工耗时。")
        if self.stall is None:
            print("结果：全部订单出库，未出现终止性死锁。")
            return
        time, lines = self.stall
        print(f"结果：死锁。最终持续停滞自 t={time} 秒起。")
        print("\n".join(lines))
        final_lines = self.status_lines()
        if final_lines != lines:
            print(f"\n最后事件后的快照（t={self.env.now} 秒）")
            print("\n".join(final_lines))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--orders", type=int, default=36)
    parser.add_argument("--interval", type=int, default=300, help="seconds between orders")
    parser.add_argument("--reserve-return", action="store_true", help="hold a return slot at start")
    parser.add_argument("--shared-kit-slot", action="store_true", help="share one stage05 buffer slot per kit")
    parser.add_argument("--reserve-stage05-reentry", action="store_true", help="hold the P-3 return buffer slot")
    parser.add_argument("--paired-exchange", action="store_true", help="swap reciprocal outbound parts on a stall")
    parser.add_argument("--batching-config", type=Path, help="read synthetic batch settings JSON and run all seven islands")
    parser.add_argument("--trace-json", type=Path, help="write event frames and AGV trips as JSON")
    parser.add_argument("--order-csv", type=Path, help="write arrival, admission and completion times as CSV")
    args = parser.parse_args()
    if args.orders <= 0 or args.interval <= 0:
        parser.error("orders and interval must be positive")
    try:
        batching = json.loads(args.batching_config.read_text(encoding="utf-8-sig")) if args.batching_config else None
        if args.batching_config is not None and not isinstance(batching, dict):
            raise ValueError("批处理配置文件须包含一个设置对象")
        model = Baseline(
            args.orders, args.interval,
            reserve_return=args.reserve_return, shared_kit_slot=args.shared_kit_slot,
            reserve_stage05_reentry=args.reserve_stage05_reentry, paired_exchange=args.paired_exchange,
            capture_trace=args.trace_json is not None, batching=batching,
        )
        model.run()
    except (OSError, ValueError) as error:
        parser.error(str(error))
    model.report()
    if args.trace_json is not None:
        model.export_trace(args.trace_json)
    if args.order_csv is not None:
        model.export_orders(args.order_csv)


if __name__ == "__main__":
    main()
