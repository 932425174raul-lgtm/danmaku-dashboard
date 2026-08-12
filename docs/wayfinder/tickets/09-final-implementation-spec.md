---
title: 汇总第一版实施规格与交付顺序
status: closed
label: wayfinder:task
assignee: codex
parent: ../map.md
blocked_by:
  - 03-event-model-and-storage.md
  - 04-realtime-ui-prototype.md
  - 05-process-and-ipc-boundaries.md
  - 06-throughput-prototype.md
  - 07-macos-packaging.md
  - 08-testing-and-observability.md
closed_at: 2026-07-29
---

## Question

如何把已经关闭任务中的协议、状态机、数据模型、进程边界、界面、性能、测试与打包结论汇总成分阶段实施规格，明确每个里程碑的文件边界、验收命令、完成条件和可安全交付点，使编码阶段不再需要补做关键产品或架构决策？

## Resolution

已形成[第一版实施规格](../../spec/implementation-plan.md)，编码阶段按M0至M9推进：

- 固定Node.js、npm、Electron、Forge、Vite、React、TypeScript、SQLite接口和测试工具的精确版本，直接依赖不使用浮动范围。
- 固定`contracts`、`domain`、`main`、`preload`、`renderer`、`testing`和测试目录的依赖方向，并由ESLint与隐私扫描执行禁止导入规则。
- 数据库拆为`001_core.sql`与`002_projections_and_search.sql`，规定迁移账本、校验值、备份、schema 1兼容构建和版本A到B连续性验证。
- 正常应用、未打包Playwright入口和正式产物验证模式互相隔离；正式产物关闭Node调试Fuse，只保留固定、无网络、临时数据库的运行时和性能参数。
- M0至M8分别交付脚手架、契约、存储、状态机、Electron边界、界面、真实匿名协议、容量诊断和macOS候选产物；M9执行12小时与最终发布验收。
- 每个里程碑都有文件范围、完成条件、验收命令和安全交付点，`verify:fast`与`verify:release`有唯一执行语义。
- 发布证据固定为脱敏JSON摘要与校验值，不保存房间、用户、消息、凭据、数据库、日志原件或绝对用户路径。

实施规格已与7份专题规格和网页协议契约做一致性校准。第一版规划没有待定产品或架构项，下一步从M0开始编码。
