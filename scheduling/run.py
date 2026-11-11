from argparse import ArgumentParser
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from openpyxl import load_workbook

from report import render_report
from solver import PART_C_SPACE, TRAY_CAPACITY, solve


PROJECT_DIR = Path(__file__).resolve().parent
PAGES_DIR = PROJECT_DIR.parent / "docs" / "scheduling"
DEFAULT_INPUT = PROJECT_DIR / "inputs" / "synthetic-orders.xlsx"
DEFAULT_OUTPUT = PROJECT_DIR / "outputs" / "static-schedule.html"


def rows(workbook, sheet, headers):
    if sheet not in workbook:
        raise ValueError(f"缺少工作表 {sheet}")
    source = workbook[sheet].iter_rows(values_only=True)
    header = next(source, ())
    if tuple(header[:len(headers)]) != headers:
        raise ValueError(f"工作表 {sheet} 的前 {len(headers)} 列应为 {'、'.join(headers)}")
    for row_number, row in enumerate(source, 2):
        cells = row[:len(headers)]
        if any(cell is not None and cell != "" for cell in cells):
            yield f"{sheet} 第 {row_number} 行", cells


def integer(value, label, minimum=0):
    if (not isinstance(value, (int, float)) or isinstance(value, bool)
            or not minimum <= value < float("inf") or value != int(value)):
        raise ValueError(f"{label}应为大于等于 {minimum} 的整数，读到 {value!r}")
    return int(value)


def load_inputs(path, selected_scenario):
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        parameters = {}
        for label, (key, value) in rows(workbook, "参数", ("参数", "值")):
            if key in parameters:
                raise ValueError(f"{label}的参数 {key!r} 重复")
            parameters[key] = value
        start = parameters.get("排产起点")
        if isinstance(start, str):
            start = datetime.fromisoformat(start.strip())
        if not isinstance(start, datetime) or start.tzinfo is not None:
            raise ValueError("排产起点应为 Excel 日期时间或 ISO 格式的本地时间")
        settings = {"start_datetime": start}
        for key, label in (("prep_minutes", "批处理前准备分钟"),
                           ("post_minutes", "批处理后处理分钟"),
                           ("switch_minutes", "批间切换分钟")):
            settings[key] = integer(parameters.get(label), label)

        patterns = {}
        seen_patterns = set()
        headers = ("部件A/B合计数", "部件C数", "整盘批处理分钟", "启用")
        for label, (part_ab, part_c, minutes, enabled) in rows(workbook, "装盘组合", headers):
            pair = integer(part_ab, label + "部件A/B合计数"), integer(part_c, label + "部件C数")
            if pair in seen_patterns:
                raise ValueError(f"{label}的装盘组合 {pair} 重复")
            if pair == (0, 0) or pair[0] > TRAY_CAPACITY or pair[1] > TRAY_CAPACITY // PART_C_SPACE:
                raise ValueError(f"{label}的装盘组合 {pair} 超出范围或为空盘")
            seen_patterns.add(pair)
            flag = integer(enabled, label + "启用")
            if flag == 1:
                if pair[0] + PART_C_SPACE * pair[1] > TRAY_CAPACITY:
                    raise ValueError(f"{label}的启用组合 {pair} 超过共享盘面容量")
                patterns[pair] = integer(minutes, label + "整盘批处理分钟", 1)
            elif flag != 0:
                raise ValueError(f"{label}的启用值应为 0 或 1")
        if not patterns:
            raise ValueError("装盘组合表至少需要一个已启用的非空组合")

        scenarios = {}
        for label, (name, machine_count, order_sheet) in rows(workbook, "场景", ("场景", "批处理设备数量", "订单表")):
            if not isinstance(name, str) or not name.strip():
                raise ValueError(f"{label}缺少场景名称")
            name = name.strip()
            if selected_scenario and name != selected_scenario:
                continue
            if name in scenarios:
                raise ValueError(f"场景 {name} 重复")
            if not isinstance(order_sheet, str) or not order_sheet.strip():
                raise ValueError(f"{label}缺少订单表名称")
            orders = []
            seen_orders = set()
            for order_label, (order_id, part_ab, part_c) in rows(workbook, order_sheet.strip(), ("订单号", "部件A/B合计数", "部件C数")):
                order_id = "" if order_id is None else str(order_id).strip()
                if not order_id or order_id in seen_orders:
                    raise ValueError(f"{order_label}的订单号为空或重复")
                part_ab = integer(part_ab, order_label + "部件A/B合计数")
                part_c = integer(part_c, order_label + "部件C数")
                if (part_ab, part_c) != (2, 1):
                    raise ValueError(f"{order_label}必须是一套总成，填写 2 个A/B部件和 1 个C部件")
                seen_orders.add(order_id)
                orders.append({"order_id": order_id, "part_ab": part_ab, "part_c": part_c})
            if not orders:
                raise ValueError(f"场景 {name} 没有订单")
            scenarios[name] = (integer(machine_count, label + "批处理设备数量", 1), orders)
        if not scenarios:
            raise ValueError(f"找不到场景 {selected_scenario}" if selected_scenario else "场景表没有数据")
        settings["source_name"] = path.name
        return settings, patterns, scenarios
    finally:
        workbook.close()


def verify_schedule(result, orders, patterns, machine_count, settings):
    def check(condition, message):
        if not condition:
            raise RuntimeError(message)

    expected = {order["order_id"] for order in orders}
    by_machine = defaultdict(list)
    batch_by_order = {}
    seen_batches = set()
    for batch in result["batches"]:
        batch_id = batch["batch_id"]
        machine = batch["machine"]
        check(batch_id not in seen_batches, f"批次 {batch_id} 重复")
        check(isinstance(machine, int) and 1 <= machine <= machine_count, f"批次 {batch_id} 的机号无效")
        seen_batches.add(batch_id)
        by_machine[machine].append(batch)
        pattern = batch["part_ab"], batch["part_c"]
        check(pattern in patterns, f"批次 {batch_id} 使用了未启用的装盘组合 {pattern}")
        check(pattern[0] + PART_C_SPACE * pattern[1] <= TRAY_CAPACITY, f"批次 {batch_id} 超过共享盘面容量")
        check(batch["process_end"] - batch["process_start"] == patterns[pattern], f"批次 {batch_id} 的批处理时长不匹配")
        check(batch["prep_start"] >= 0 and batch["process_start"] - batch["prep_start"] == settings["prep_minutes"],
              f"批次 {batch_id} 的准备时刻不匹配")
        check(batch["finish"] - batch["process_end"] == settings["post_minutes"], f"批次 {batch_id} 的后处理时长不匹配")
        allocations = batch["allocations"]
        check(pattern == (2 * len(allocations), len(allocations)), f"批次 {batch_id} 的件数与整套订单数不一致")
        for item in allocations:
            order_id = item["order_id"]
            check(order_id in expected and order_id not in batch_by_order, f"批次 {batch_id} 的订单号无效或重复")
            check((item["part_ab"], item["part_c"]) == (2, 1), f"订单 {order_id} 未按整套分配")
            batch_by_order[order_id] = batch

    for machine, batches in by_machine.items():
        previous_end = None
        for batch in sorted(batches, key=lambda item: item["process_start"]):
            if previous_end is None:
                check(batch["switch_start"] is None, f"批处理设备 {machine} 的首盘被计入切换")
            else:
                switch_start = batch["switch_start"]
                check(switch_start is not None and switch_start >= previous_end
                      and batch["process_start"] >= switch_start + settings["switch_minutes"],
                      f"批处理设备 {machine} 上批次重叠或切换间隔不足")
            previous_end = batch["process_end"]

    check(batch_by_order.keys() == expected, "批次分配缺单")
    check({order["order_id"] for order in result["orders"]} == expected
          and len(result["orders"]) == len(orders), "订单汇总缺单或重复")
    for order in result["orders"]:
        order_id = order["order_id"]
        batch = batch_by_order[order_id]
        check((order["part_ab"], order["part_c"]) == (2, 1), f"订单 {order_id} 的汇总数量不一致")
        check(order["batch_ids"] == [batch["batch_id"]], f"订单 {order_id} 的关联批次不一致")
        check(order["finish"] == batch["finish"], f"订单 {order_id} 的齐套时刻不正确")
        check(order["arrival"] == 0 and order["flow_time"] == order["finish"], f"订单 {order_id} 的用时不正确")
    total = sum(order["flow_time"] for order in result["orders"])
    check(result["objective"] == result["total_flow_time"] == total
          and result["mean_flow_time"] == total / len(orders), "平均订单用时与逐单用时不一致")
    check(result["makespan"] == max(order["finish"] for order in result["orders"]), "甘特图终点与最后一单不一致")


def main():
    parser = ArgumentParser(description="静态 S01 批处理整套合批与排产")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--scenario", help="只运行指定场景，省略时运行场景表中的全部场景")
    args = parser.parse_args()
    try:
        if args.output.suffix.lower() != ".html":
            raise ValueError("输出路径应以 .html 结尾")
        settings, patterns, scenarios = load_inputs(args.input, args.scenario)
        results = {}
        for name, (machine_count, orders) in scenarios.items():
            try:
                result = solve(orders, patterns, machine_count, settings["prep_minutes"],
                               settings["post_minutes"], settings["switch_minutes"])
                verify_schedule(result, orders, patterns, machine_count, settings)
            except (ValueError, RuntimeError) as error:
                raise ValueError(f"场景 {name}：{error}") from error
            result["machine_count"] = machine_count
            results[name] = result
            print(f"{name}：{machine_count} 台机，{len(orders)} 个订单，{len(result['batches'])} 盘，"
                  f"平均订单用时 {result['mean_flow_time']:.1f} 分钟/单，校验通过")
        report = render_report(results, settings)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
        print(f"结果：{args.output.resolve()}")
    except (OSError, ValueError) as error:
        parser.exit(1, f"排产失败：{error}\n")


if __name__ == "__main__":
    main()
