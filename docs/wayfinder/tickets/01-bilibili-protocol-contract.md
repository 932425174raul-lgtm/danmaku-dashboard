---
title: 明确B站网页弹幕协议契约与失败边界
status: closed
label: wayfinder:research
parent: ../map.md
assignee: codex
blocked_by: []
closed_at: 2026-07-29
---

## Question

截至实施时，匿名连接任意公开B站直播间需要哪些HTTP请求、WBI签名字段、WebSocket鉴权字段、数据包版本、心跳、节点轮换和令牌刷新规则；哪些响应与错误必须进入内部协议契约和可重复测试，才能在不保存Cookie或临时令牌的前提下抵抗常见协议变化与风控？

## Resolution

已确认匿名网页协议在2026-07-29可行，并确定`bilibili-web-v1`适配器契约：

- 使用`room_init`规范化真实房间号，再以WBI签名请求`getDanmuInfo`。
- 通过`host_list`建立WSS连接，使用`uid=0`、`protover=3`、`platform=web`、`type=2`和临时令牌鉴权。
- 支持版本`0`、`1`、`2`和`3`，其中版本`2`使用zlib，版本`3`使用Brotli，解压后递归解析完整包序列。
- 鉴权成功后立即心跳，此后每30秒一次；单轮节点耗尽或鉴权失败时重新获取WBI材料和临时令牌。
- HTTP、鉴权、心跳、解码、未知命令和停播均有明确失败边界。
- 测试只使用人工构造的脱敏样本，源码、日志、IPC、数据库和Git都不得保存Cookie、临时令牌、原始用户ID或完整原始消息。

完整结论见[B站网页直播弹幕协议契约](../../research/bilibili-web-protocol-contract-2026-07-29.md)。
