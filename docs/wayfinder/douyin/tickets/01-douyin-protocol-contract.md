---
title: 明确抖音网页直播协议与官方能力边界
status: closed
label: wayfinder:research
blocked_by: []
---

## Question

截至实施时，不使用账号Cookie连接任意公开抖音直播间，需要哪些房间发现、匿名设备标识、动态签名、WebSocket、Protobuf、gzip、心跳、ACK与重连步骤；哪些事件已经匿名实测，哪些只得到网页源码或开源实现交叉核对，哪些只能通过需要主播挂载的官方直播玩法能力取得？

## Evidence

- [抖音公开直播间实时事件可行性验证](../../../research/douyin-live-protocol-feasibility-2026-07-31.md)
- [脱敏在线探针](../../../../scripts/probe-douyin-protocol.ts)
- [PushFrame解码边界](../../../../src/main/protocol/douyin-web-v1/push-frame.ts)
- [人工构造的协议测试](../../../../tests/unit/douyin-push-frame.test.ts)

## Resolution

匿名页面链路已经完成本机在线验证。30秒内69个入站帧全部解码，识别出66个ACK和3个应用层心跳出站帧，并收到评论、点赞、进场、关注与房间统计消息。当前压缩声明位于`headersList`中的`compress_type`，未使用的大`uint64`必须按字节跳过。

本票只确认网页私有协议的当前边界，不授权接入正式采集器。页面解析、独立动态签名、业务消息体固定样本、重连游标、礼物和下播仍由后续任务处理。
