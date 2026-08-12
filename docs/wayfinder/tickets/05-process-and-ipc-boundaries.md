---
title: 确定Electron进程边界与IPC契约
status: closed
label: wayfinder:grilling
parent: ../map.md
assignee: codex
blocked_by:
  - 02-session-state-machine.md
  - 03-event-model-and-storage.md
closed_at: 2026-07-29
---

## Question

Electron主进程、预加载脚本和React渲染进程分别拥有采集器、数据库、聚合状态和窗口生命周期中的哪些能力；如何定义最小IPC接口、推送节流、上下文隔离、输入校验和退出流程，才能让关闭窗口后持续采集，同时不向渲染进程暴露Node、数据库或B站临时令牌？

## Resolution

采用主进程持有生命周期、SQLite worker隔离同步工作、renderer只读展示的边界：

- 主进程拥有协议适配器、WebSocket、采集状态机、实时投影、窗口、托盘和退出协调。
- 主进程监管一个唯一写连接worker和一个白名单只读查询worker，renderer不接触SQLite。
- 上游原始UID在主进程完成HMAC后丢弃，临时凭据和完整原始消息不进入worker、IPC、数据库或日志。
- writer事务提交后才更新实时投影，renderer不会显示未持久化事件。
- preload只暴露版本化固定方法和订阅，不暴露Node、`ipcRenderer`、SQL、文件路径或任意通道。
- renderer使用sandbox、上下文隔离、生产CSP、导航拦截、运行时输入校验和调用限流。
- 实时弹幕与核心数字每250毫秒最多推送一次，分析投影每秒最多一次，单包不超过256 KiB。
- 窗口关闭只隐藏，renderer崩溃不停止采集，重新显示后通过完整快照和revision恢复。
- 所有退出入口进入统一退出协调器，活动采集需要确认，确认后在10秒软上限内关闭连接、刷新存储并结束会话。

完整所有权、worker协议、preload API、IPC通道、背压、安全边界和验收场景见[Electron进程边界与IPC契约](../../spec/electron-process-and-ipc.md)。架构取舍见[隔离renderer并在主进程监管的worker中运行SQLite](../../adr/0003-isolate-renderer-and-sqlite-workers.md)。
