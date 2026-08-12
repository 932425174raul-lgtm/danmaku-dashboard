---
title: 建立Protobuf与签名脱敏样本
status: open
label: wayfinder:task
blocked_by:
  - 01-douyin-protocol-contract
  - 03-platform-adapter-boundary
---

## Question

用哪些完全人工构造的签名向量、PushFrame、Response、评论、点赞、礼物、房间统计、控制消息、gzip、ACK与畸形数据样本，才能固定协议适配器行为而不把线上原始消息、用户标识、Cookie或临时签名材料写入Git？
