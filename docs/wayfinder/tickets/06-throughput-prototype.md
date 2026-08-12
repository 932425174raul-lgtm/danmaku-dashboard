---
title: 验证高吞吐采集与实时聚合方案
status: closed
label: wayfinder:prototype
parent: ../map.md
assignee: codex
blocked_by:
  - 01-bilibili-protocol-contract.md
  - 03-event-model-and-storage.md
  - 05-process-and-ipc-boundaries.md
closed_at: 2026-07-29
---

## Question

怎样用脱敏合成事件验证每秒200条、单场100万条和连续12小时目标；批量写库、增量聚合、30分钟时间桶、关键词统计、最近500条弹幕和渲染进程推送分别采用什么策略，才能证明WebSocket接收不被阻塞且内存不会持续增长？

## Resolution

采用单写worker、批量事务和固定容量投影：

- WebSocket路径只校验、规范化并进入主进程有界队列，不执行SQL和全场聚合。
- writer worker按最多500条或100毫秒提交，同一事务更新事实、摘要、活跃用户和10秒桶。
- 事务提交后才发布高水位和实时增量，去重冲突不进入任何投影。
- 主进程固定保留最近500条弹幕和180个趋势桶；renderer待推送弹幕最多200条，单包不超过256 KiB。
- 高频词用128项Space-Saving候选和每秒一次持久化快照，数据库保存估算次数和误差上界。
- 1至2字符搜索使用会话内参数化子串扫描，3字符以上使用FTS5三元组索引和物化匹配ID。
- 当前速率按最近60秒有效采集时间计算，数据缺口不补零。

脱敏原型在当前Apple Silicon Mac上取得以下结果：

- 100万条在37.92秒内完成，约26,372条/秒，writer提交P99为55.91毫秒。
- 数据库约202.43 MiB，WAL峰值约21.15 MiB，停止后WAL为0。
- 100万条下3字符FTS热查询P95为9.07毫秒，2字符无结果扫描P95为227.64毫秒。
- 定速120秒精确生成并提交24,000条，队列峰值24，提交P99为9.71毫秒，主线程事件循环P99为15.57毫秒。
- 最近弹幕、趋势、高频词、renderer载荷、事实计数、摘要、FTS行数和数据库健康检查全部满足门槛。

12小时测试命令和精确1,382,400条负载已经定义，但规划阶段没有把短时原型冒充完整长跑。正式实现必须用打包应用、最终SQLite驱动和生产worker执行12小时发布门槛。

完整策略与门槛见[高吞吐与实时聚合规格](../../spec/throughput-and-realtime-aggregation.md)，可运行原型见[高吞吐与实时聚合原型](../../prototypes/throughput/README.md)，实测过程见[高吞吐原型验证记录](../../research/throughput-prototype-2026-07-29.md)。
