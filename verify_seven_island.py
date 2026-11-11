"""Check that the SimPy and browser engines agree, and verify resource limits."""

from collections import Counter
import json
import subprocess

from build_seven_island_demo import ROOT, batching_defaults
from simpy_six_island_baseline import Baseline, CELL_A, Part, CELL_C, Work


def simulate_browser(config):
    script = (
        "const fs = require('fs');"
        "const engine = require('./six_island_engine.js');"
        "process.stdout.write(JSON.stringify(engine.simulate(JSON.parse(fs.readFileSync(0, 'utf8')))));"
    )
    return subprocess.run(
        ["node", "-e", script], cwd=ROOT, input=json.dumps(config),
        capture_output=True, encoding="utf-8",
    )


def browser_config(trace, batching):
    return {
        **{key: trace[key] for key in ("parameters", "transport", "routes")},
        "islands": trace["islands"][:-1],
        "batching": batching,
    }


def verify_case(orders, interval, *, batching=None, shared_kit=True, pressure=False):
    batching = {**batching_defaults(), **(batching or {})}
    model = Baseline(
        orders, interval, reserve_return=True, shared_kit_slot=shared_kit,
        reserve_stage05_reentry=pressure, paired_exchange=pressure,
        capture_trace=True, batching=batching,
    )
    if pressure:
        model.islands[CELL_C].machines = 11
        model.islands[CELL_C].capacity = 72
    model.run()
    trace = json.loads(json.dumps(model.trace_data()))
    browser = simulate_browser(browser_config(trace, batching))
    if browser.returncode:
        raise RuntimeError(browser.stderr)
    actual = json.loads(browser.stdout)
    for key in trace:
        assert actual[key] == trace[key], f"{orders} × {interval} s: {key} differs"

    ready = {int(order["order_id"][1:]): order["finish"] for order in trace["batching"]["orders"]}
    process_trips = Counter()
    for start, end, source, destination, label in trace["trips"]:
        if source == 6:
            order = int(label.split("-")[0])
            assert destination == 0 and start >= ready[order]
            assert end - start == batching["transportSeconds"]
            process_trips[label] += 1
    for frame in trace["frames"]:
        assert frame[5][6][0] == sum(frame[6]), "Batching stages must share a kit buffer"
        for state, island in zip(frame[5], trace["islands"]):
            physical, inbound, returned, active, _ = state[:5]
            held = state[5] if len(state) > 5 else 0
            assert 0 <= active <= island["machines"]
            assert 0 <= physical + inbound + returned + held <= island["capacity"]
    audit = trace["audit"]
    assert audit["violations"] == 0 and audit["events_checked"] == len(trace["frames"])
    for i, island in enumerate(trace["islands"]):
        assert audit["peak_slots"][i] <= island["capacity"]
        assert audit["peak_workstations"][i] <= island["machines"]
    summary = trace["summary"]
    assert summary["finished"] == orders and not summary["deadlock"]
    assert len(process_trips) == 3 * orders and all(count == 1 for count in process_trips.values())
    assert all(row["flow_time"] == row["completed_at"] - row["arrived_at"] for row in trace["orders"])
    print(json.dumps({"orders": orders, "interval": interval, **summary, **audit}))
    return trace


def verify_overflow():
    batching = {**batching_defaults(), "capacity": 1}
    model = Baseline(2, 17, capture_trace=True, batching=batching)
    try:
        model.run()
    except ValueError as error:
        assert "17" in str(error) and "需要 2 格" in str(error), str(error)
    else:
        raise AssertionError("SimPy did not reject an overflowing print buffer")
    browser = simulate_browser(browser_config(model.trace_data(), batching))
    assert browser.returncode != 0 and "17" in browser.stderr and "需要 2 格" in browser.stderr, browser.stderr
    print("Batch buffer overflow correctly rejected by both engines.")


def verify_simpy_resource_guards():
    model = Baseline(1, batching=batching_defaults())
    entry_island = model.islands[CELL_A]
    parts = [Part(1, kind) for kind in ("L", "R")]
    entry_island.work.extend(Work(part, part.visit, machine=1) for part in parts)
    try:
        model.verify_resource_limits()
    except RuntimeError as error:
        assert "加工位分配冲突" in str(error), str(error)
    else:
        raise AssertionError("SimPy accepted two jobs on the same station")

    entry_island.work.clear()
    entry_island.buffer.extend(Part(i, "L") for i in range(1, entry_island.capacity + 2))
    try:
        model.verify_resource_limits()
    except RuntimeError as error:
        assert "缓冲区超容量" in str(error), str(error)
    else:
        raise AssertionError("SimPy accepted a downstream buffer overflow")
    print("SimPy rejects duplicate station ownership and downstream buffer overflow.")


if __name__ == "__main__":
    single = verify_case(1, 300)
    synthetic_defaults = batching_defaults()
    expected_batch_finish = (
        synthetic_defaults["prepMinutes"] + synthetic_defaults["postMinutes"]
        + synthetic_defaults["durations"][1]
    ) * 60
    assert single["batching"]["orders"][0]["finish"] == expected_batch_finish
    assert single["orders"][0]["first_admitted_at"] == expected_batch_finish + batching_defaults()["transportSeconds"]
    verify_case(36, 300)
    verify_case(72, 24)
    verify_case(72, 24, pressure=True)
    verify_case(9, 17, batching={"waitMinutes": 30}, shared_kit=False)
    verify_case(8, 17, batching={"prepMinutes": 0, "postMinutes": 0, "switchMinutes": 0, "transportSeconds": 0})
    verify_overflow()
    verify_simpy_resource_guards()
