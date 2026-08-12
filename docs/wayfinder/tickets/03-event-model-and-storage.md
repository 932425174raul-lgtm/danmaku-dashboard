---
title: 确定直播事件模型与SQLite结构
status: closed
label: wayfinder:grilling
parent: ../map.md
assignee: codex
blocked_by:
  - 01-bilibili-protocol-contract.md
  - 02-session-state-machine.md
closed_at: 2026-07-29
---

## Question

采集会话、状态转换、数据缺口、弹幕、礼物、醒目留言和热度采样应如何规范化、关联、索引与删除；本地用户标识、批量写入、事务边界、数据库迁移和100万条事件查询需要哪些约束，才能同时满足实时统计、历史搜索和数据最小化？

## Resolution

本地资料库采用规范化事实表与可重建读取投影：

- 分别保存会话、状态转换、数据缺口、弹幕、礼物、醒目留言和热度采样，不保存上游原始JSON。
- 原始平台用户ID和平台事件ID在内存中通过本机随机盐生成16字节HMAC本地键，数据库不接收原值。
- 金额统一使用人民币千分之一整数，无法可靠换算的礼物金额保持未知，不使用浮点数。
- 会话摘要、10秒统计桶、会话用户和高频词属于可从事实表重建的读取投影。
- 中文会话内搜索使用FTS5三元组索引，所有列表使用键集分页。
- 单写入者按500条或100毫秒批量提交。存储故障会关闭WebSocket、保留有界积压并形成数据缺口。
- 迁移使用不可变版本、校验值、在线备份和事务回滚。
- 整场删除先隐藏会话，再以可恢复小批次清理最多100万条子记录，避免阻塞活动采集。

完整事件类型、DDL、索引、事务、迁移、删除和查询契约见[直播事件模型与SQLite结构](../../spec/event-model-and-sqlite.md)。架构取舍见[使用规范化SQLite事件表与可重建投影](../../adr/0002-use-normalized-sqlite-events-and-projections.md)。
