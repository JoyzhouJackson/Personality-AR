from argparse import ArgumentParser
from pathlib import Path

from arrival_report import render_arrival_report
from run import DEFAULT_INPUT, PAGES_DIR, load_inputs


DEFAULT_OUTPUT = PAGES_DIR / "arrival-comparison.html"


def main():
    parser = ArgumentParser(description="生成浏览器内计算的随机到单比较页面")
    parser.add_argument("--replicates", type=int, default=200, help="每个输入或采样点的配对次数")
    parser.add_argument("--seed", type=int, default=61723)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    if not 2 <= args.replicates <= 200 or args.output.suffix.lower() != ".html":
        parser.error("配对次数应为 2 至 200，输出文件应以 .html 结尾")

    settings, patterns, _ = load_inputs(args.input, None)
    capacity = max((part_c for part_ab, part_c in patterns if part_ab == 2 * part_c), default=0)
    if not capacity:
        parser.error("装盘表至少须启用一个整单组合")
    settings.update({
        "replicates": args.replicates,
        "seed": args.seed,
        "browser_durations": [patterns.get((2 * size, size)) for size in range(capacity + 1)],
    })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_arrival_report(settings), encoding="utf-8")
    print(f"页面：{args.output.resolve()}")


if __name__ == "__main__":
    main()
