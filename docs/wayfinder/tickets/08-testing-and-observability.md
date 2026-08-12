---
title: 确定测试、诊断与脱敏日志方案
status: closed
label: wayfinder:research
assignee: codex
parent: ../map.md
blocked_by: []
closed_at: 2026-07-29
---

## Question

协议解码、状态机、数据库、IPC、实时聚合、界面、后台生命周期和打包分别需要哪些单元测试、集成测试、脱敏数据包、故障注入和人工验收；日志允许记录哪些字段，如何定位匿名风控与数据缺口而不泄露临时令牌或原始用户标识？

## Resolution

第一版采用分层、无真实数据的验证体系：

- Vitest负责协议、状态机、事件规范化、SQLite契约、IPC schema和实时聚合；React Testing Library与`user-event`负责renderer组件。
- Playwright的实验性Electron能力只通过薄测试驱动验证测试版主进程、preload、窗口、IPC和崩溃恢复；正式入口不包含测试IPC或故障控制器。
- 脱敏fixture覆盖WBI签名、房间发现、匿名风控、鉴权、心跳、多包、zlib、Brotli、已知命令和全部长度、解压、递归边界。
- 状态机12个验收场景、SQLite事务与迁移、reader与writer故障、renderer崩溃、后台采集、休眠唤醒和10秒退出都有明确自动或人工证据。
- 容量验证固定为20,000条烟测、100万条、每秒200条和12小时1,382,400条；正式发布只接受最终Electron、SQLite与worker代码的结果。
- 线上协议冒烟由操作者传入公开活跃房间，关闭截图、trace、HAR和持久化，只输出阶段、状态码、命令计数与耗时。
- runtime日志使用固定事件联合类型和运行时schema白名单，不接受任意`message`、对象展开或原始`Error`。
- 日志不记录房间、昵称、消息、搜索词、原始UID、`localUserKey`、Cookie、临时令牌、WBI材料、请求正文、SQL、路径或原始堆栈。
- 日志文件为5 MiB轮转，总上限25 MiB，最长保留7天；第一版不启用Crashpad、Node诊断报告、heap snapshot、net log或线上trace。
- 匿名风控通过阶段、`-352`、尝试次数和退避关联；数据缺口通过`runId`、内部会话ID、原因枚举、worker与存储探测关联，SQLite仍是业务事实来源。
- 用户可主动导出最多24小时的脱敏JSON诊断摘要，不包含数据库事实行、minidump、房间或用户内容，也不自动上传。
- 隐私canary端到端扫描SQLite、IPC、日志、renderer、诊断摘要、测试产物和正式asar，任何越界命中阻止发布。

规范见[测试、诊断与脱敏日志规格](../../spec/testing-and-observability.md)，工具证据和限制见[Electron 43测试、诊断与脱敏边界调研](../../research/testing-and-observability-2026-07-29.md)。
