---
title: 确定多平台适配器与隐私边界
status: open
label: wayfinder:research
blocked_by:
  - 01-douyin-protocol-contract
  - 02-douyin-event-scope
---

## Question

怎样让B站与抖音适配器分别拥有房间发现、签名、长连接和边界校验，同时只向会话状态机输出同一套规范化事件；动态签名材料、匿名标识、平台原始用户标识和完整Protobuf消息在哪些边界必须删除或转换？
