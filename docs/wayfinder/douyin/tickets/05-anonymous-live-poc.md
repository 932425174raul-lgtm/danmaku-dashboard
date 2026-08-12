---
title: 验证匿名在线采集闭环
status: open
label: wayfinder:task
blocked_by:
  - 04-protobuf-and-signature-fixtures
---

## Question

最小主进程验证入口能否在不读取Cookie的前提下从公开`web_rid`或直播链接解析长`room_id`，生成当前有效签名，取得动态推送地址，建立WSS连接，发送心跳与ACK，并只输出消息类型计数、连接阶段和脱敏错误码？
