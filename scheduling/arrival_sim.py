"""Replay whole-order arrivals on identical batch processors without lookahead."""

from collections import deque

from solver import _check_integer, _single_batcher_cost, _whole_order_durations


def _closeout_plan(order_count, now, last_process_ends, durations, prep, post, switch):
    """Exactly minimize remaining order flow time with committed work fixed."""
    costs, first_batch = _single_batcher_cost(order_count, durations, switch)
    if costs[order_count] is None:
        raise ValueError(f"收尾时剩余 {order_count} 单，无法用已启用整单组合排齐")

    process_ready = [
        now + prep if end is None else max(now + prep, end + switch)
        for end in last_process_ends
    ]
    best = [(0, 0)] + [None] * order_count
    choices = []
    feasible_loads = [(count, cost) for count, cost in enumerate(costs) if cost is not None]
    for ready_at in process_ready:
        next_best = [None] * (order_count + 1)
        chosen = [0] * (order_count + 1)
        for total in range(order_count + 1):
            for count, (completion_sum, trays) in feasible_loads:
                if count > total:
                    break
                prefix = best[total - count]
                if prefix is None:
                    continue
                # Releases are fixed, so minimizing summed completion also minimizes flow time.
                batcher_completion_sum = completion_sum + count * (ready_at + post)
                candidate = (prefix[0] + batcher_completion_sum, prefix[1] + trays)
                if next_best[total] is None or candidate < next_best[total]:
                    next_best[total] = candidate
                    chosen[total] = count
        choices.append(chosen)
        best = next_best

    planned = []
    remaining = order_count
    for machine in reversed(range(len(process_ready))):
        load = choices[machine][remaining]
        remaining -= load
        start = process_ready[machine]
        while load:
            size = first_batch[load]
            planned.append((start - prep, machine, size))
            start += durations[size] + switch
            load -= size
    return sorted(planned)


def simulate(arrivals, patterns, machine_count, prep_minutes, post_minutes, switch_minutes, wait_minutes):
    """Use FIFO fill-first dispatch and a shared, non-extending partial-tray timer."""
    _check_integer(machine_count, "批处理设备数量", 1)
    _check_integer(prep_minutes, "批处理前准备时间")
    _check_integer(post_minutes, "批处理后处理时间")
    _check_integer(switch_minutes, "批次切换时间")
    _check_integer(wait_minutes, "等单时间")
    arrivals = tuple(arrivals)
    for minute in arrivals:
        _check_integer(minute, "订单到达时间")
    if arrivals and (arrivals[0] != 0 or any(a > b for a, b in zip(arrivals, arrivals[1:]))):
        raise ValueError("订单到达时间须从第 0 分钟开始，并按非递减顺序排列")
    if not arrivals:
        return {
            "batches": [], "orders": [], "makespan": 0, "wait_events": 0,
            "total_flow_time": 0, "mean_flow_time": 0.0,
        }

    durations = _whole_order_durations(patterns)
    if not durations:
        raise ValueError("装盘表至少须启用一个整单组合")

    sizes = sorted(durations, reverse=True)
    full_size = sizes[0]
    batches = []
    orders = [
        {"order_id": f"O{index:03d}", "arrival": minute, "finish": None, "batch_id": None}
        for index, minute in enumerate(arrivals, 1)
    ]
    queue = deque()
    last_process_ends = [None] * machine_count

    def prep_ready(machine):
        end = last_process_ends[machine]
        return 0 if end is None else max(0, end + switch_minutes - prep_minutes)

    def dispatch(prep_start, machine, size):
        previous_end = last_process_ends[machine]
        process_start = prep_start + prep_minutes
        process_end = process_start + durations[size]
        finish = process_end + post_minutes
        batch_id = f"B{len(batches) + 1:03d}"
        order_ids = []
        for _ in range(size):
            order = queue.popleft()
            order["batch_id"] = batch_id
            order["finish"] = finish
            order["flow_time"] = finish - order["arrival"]
            order_ids.append(order["order_id"])
        batches.append({
            "batch_id": batch_id,
            "machine": machine + 1,
            "order_ids": order_ids,
            "prep_start": prep_start,
            "process_start": process_start,
            "process_end": process_end,
            "finish": finish,
            "switch_start": previous_end,
        })
        last_process_ends[machine] = process_end

    cursor = 0
    now = 0
    deadline = None
    wait_events = 0
    while cursor < len(arrivals):
        while cursor < len(arrivals) and arrivals[cursor] == now:
            queue.append(orders[cursor])
            cursor += 1
        if cursor == len(arrivals):
            closeout = _closeout_plan(
                len(queue), now, last_process_ends, durations, prep_minutes, post_minutes, switch_minutes,
            )
            for prep_start, machine, size in closeout:
                dispatch(prep_start, machine, size)
            break

        while queue:
            machine = next((m for m in range(machine_count) if prep_ready(m) <= now), None)
            size = next((k for k in sizes if k <= len(queue)), None)
            if machine is None or size is None:
                break
            if size == full_size or wait_minutes == 0 or (deadline is not None and now >= deadline):
                dispatch(now, machine, size)
                deadline = None
            else:
                if deadline is None:
                    deadline = now + wait_minutes
                    wait_events += 1
                break

        future_events = [arrivals[cursor]]
        if deadline is not None and deadline > now:
            future_events.append(deadline)
        if queue:
            future_events.extend(
                ready_at for ready_at in (prep_ready(m) for m in range(machine_count)) if ready_at > now
            )
        now = min(future_events)

    total_flow_time = sum(order["flow_time"] for order in orders)
    return {
        "batches": batches,
        "orders": orders,
        "makespan": max(batch["finish"] for batch in batches),
        "wait_events": wait_events,
        "total_flow_time": total_flow_time,
        "mean_flow_time": total_flow_time / len(orders),
    }
