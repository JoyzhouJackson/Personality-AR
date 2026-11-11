# Synthetic Workcell Simulation

这是使用虚构数据的离散事件仿真演示。路线、加工时间、容量和订单均为重新生成的示例；布局沿用原有的虚构示意图，仅将工艺名称替换为编号。演示用于展示资源调度、缓冲约束与仿真界面。

- [整体仿真](https://joyzhoujackson.github.io/workcell-simulation-demo/)展示 S01–S07 七个编号工艺岛，部件 A、B、C 与总成 P 的流转、库位和订单完成情况。
- [批处理策略实验](https://joyzhoujackson.github.io/workcell-simulation-demo/scheduling/)使用同一组合成订单比较立即派工与限时等单。
- `simpy_six_island_baseline.py` 和 `six_island_engine.js` 分别提供 Python 与浏览器计算模型。
- `verify_seven_island.py` 对照两套模型的事件、搬运、逐单记录与资源上限。

## 运行与生成

安装 `scheduling/requirements.txt` 中的依赖后，可运行下面的命令。

```bash
python scheduling/run_arrival_experiment.py
python build_seven_island_demo.py
python verify_seven_island.py
```

整体演示由 `seven_island_demo.template.html`、计算引擎和通用布局素材生成到 `docs/index.html`。生成时传入 `--offline demo.html` 可同时得到单文件演示。网页参数使用公开演示专用的浏览器存储空间。

## 示例数据

`scheduling/inputs/synthetic-orders.xlsx` 是从零生成的合成样例，包含示例订单和批处理时间表。数据输入目录只允许此文件纳入版本控制。私有数据可留在仓库外的本地目录。

S01 的共享缓冲按一套占一格。S05 合装前的同单部件可以按开关共用一格。其他阶段按单件或总成计格。所有资源容量都在仿真事件中校验。
