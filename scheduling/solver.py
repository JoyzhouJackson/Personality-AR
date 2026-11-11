"""Exact static scheduling for identical batchers and indivisible orders."""

TRAY_CAPACITY = 32
PART_C_SPACE = 2

def _check_integer(value, name, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(f"{name}须为不小于 {minimum} 的整数")


def _whole_order_durations(patterns):
    durations = {}
    for (part_ab, part_c), duration in patterns.items():
        _check_integer(part_ab, "装盘组合部件A/B合计数")
        _check_integer(part_c, "装盘组合部件C数")
        _check_integer(duration, "装盘组合批处理时间", 1)
        if part_ab == 0 and part_c == 0:
            raise ValueError("空盘不能作为启用的装盘组合")
        if part_ab + PART_C_SPACE * part_c > TRAY_CAPACITY:
            raise ValueError(f"启用的组合（{part_ab} 个A/B部件、{part_c} 个C部件）超过共享盘面容量")
        if part_c > 0 and part_ab == 2 * part_c:
            durations[part_c] = duration
    return durations


def _single_batcher_cost(order_count, durations, switch):
    """Minimize summed completion times from first print start for each load."""
    costs = [(0, 0)] + [None] * order_count
    first_batch = [0] * (order_count + 1)
    sizes = sorted(durations, reverse=True)
    for total in range(1, order_count + 1):
        for size in sizes:
            if size > total:
                continue
            remaining = total - size
            tail_cost = costs[remaining]
            if tail_cost is None:
                continue
            tail_completion_sum, tail_trays = tail_cost
            # This print delays every order, while the next switch delays only later trays.
            completion_sum = total * durations[size] + remaining * switch + tail_completion_sum
            cost = (completion_sum, 1 + tail_trays)
            if costs[total] is None or cost < costs[total]:
                costs[total] = cost
                first_batch[total] = size
    return costs, first_batch


def _orders_per_batcher(order_count, machine_count, single_cost):
    """Minimize summed order completion times across identical batchers."""
    if single_cost[order_count] is None:
        raise ValueError(f"启用的整单装盘组合无法恰好凑齐 {order_count} 个订单")
    feasible_loads = [(count, cost) for count, cost in enumerate(single_cost) if cost is not None]
    costs = [(0, 0)] + [None] * order_count
    choices = []
    for _ in range(min(machine_count, order_count)):
        next_costs = [None] * (order_count + 1)
        load_choice = [0] * (order_count + 1)
        for total in range(order_count + 1):
            for load, batcher_cost in feasible_loads:
                if load > total:
                    break
                other_cost = costs[total - load]
                if other_cost is None:
                    continue
                batcher_completion_sum, batcher_trays = batcher_cost
                other_completion_sum, other_trays = other_cost
                cost = (other_completion_sum + batcher_completion_sum, other_trays + batcher_trays)
                if next_costs[total] is None or cost < next_costs[total]:
                    next_costs[total] = cost
                    load_choice[total] = load
        costs = next_costs
        choices.append(load_choice)

    total = order_count
    loads = []
    for load_choice in reversed(choices):
        load = load_choice[total]
        if load:
            loads.append(load)
        total -= load
    return sorted(loads, reverse=True)


def _build_timeline(loads, first_batch, durations, prep, post, switch):
    timeline = []
    for machine, load in enumerate(loads, 1):
        previous_end = None
        while load:
            size = first_batch[load]
            start = prep if previous_end is None else previous_end + switch
            end = start + durations[size]
            timeline.append({
                "machine": machine,
                "part_ab": 2 * size,
                "part_c": size,
                "prep_start": start - prep,
                "process_start": start,
                "process_end": end,
                "finish": end + post,
                "switch_start": previous_end,
            })
            previous_end = end
            load -= size
    return sorted(timeline, key=lambda batch: (batch["process_start"], batch["machine"]))


def solve(orders, patterns, machine_count, prep_minutes, post_minutes, switch_minutes):
    """Exactly minimize mean flow time for orders that all arrive at minute zero."""
    _check_integer(machine_count, "批处理设备数量", 1)
    _check_integer(prep_minutes, "批处理前准备时间")
    _check_integer(post_minutes, "批处理后处理时间")
    _check_integer(switch_minutes, "批次切换时间")

    order_ids = set()
    for order in orders:
        order_id = order["order_id"]
        if order_id in order_ids or order_id is None or not str(order_id).strip():
            raise ValueError(f"订单号为空或重复：{order_id!r}")
        order_ids.add(order_id)
        _check_integer(order["part_ab"], f"{order_id} 的部件A/B合计数")
        _check_integer(order["part_c"], f"{order_id} 的部件C数")
        if order["part_ab"] != 2 or order["part_c"] != 1:
            raise ValueError(f"订单 {order_id} 须为一副总成（2 个部件A/B、1 个C部件）")

    durations = _whole_order_durations(patterns)
    single_cost, first_batch = _single_batcher_cost(len(orders), durations, switch_minutes)
    loads = _orders_per_batcher(len(orders), machine_count, single_cost)
    timeline = _build_timeline(loads, first_batch, durations, prep_minutes, post_minutes, switch_minutes)
    order_results = []
    assigned = 0
    for index, batch in enumerate(timeline, 1):
        batch_id = f"B{index:03d}"
        batch["batch_id"] = batch_id
        batch["allocations"] = []
        batch_end = assigned + batch["part_c"]
        for order in orders[assigned:batch_end]:
            batch["allocations"].append({"order_id": order["order_id"], "part_ab": 2, "part_c": 1})
            order_results.append({
                **order,
                "batch_ids": [batch_id],
                "arrival": 0,
                "finish": batch["finish"],
                "flow_time": batch["finish"],
            })
        assigned = batch_end

    makespan = max((order["finish"] for order in order_results), default=0)
    total_flow_time = sum(order["flow_time"] for order in order_results)
    return {
        "batches": timeline,
        "orders": order_results,
        "objective": total_flow_time,
        "makespan": makespan,
        "total_flow_time": total_flow_time,
        "mean_flow_time": total_flow_time / len(order_results) if order_results else 0.0,
    }
