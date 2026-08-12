# 本地任务索引

`map.md`是开发地图的唯一主入口。`tickets/`中的文件是它的子任务；frontmatter中的`blocked_by`表示依赖关系。

## 扩展地图

- [增加抖音直播采集能力](./douyin/map.md)：复用现有桌面、会话、存储、看板和打包架构，只重新解决抖音网页协议、事件可见性、平台适配器与跨平台验证。

## 推进顺序

1. 先解决协议契约、采集状态机、实时界面原型和macOS打包路径。
2. 在协议与状态机明确后确定事件模型、SQLite结构和Electron进程边界。
3. 用已经确定的架构验证高吞吐、长时间运行、测试与脱敏诊断方案。
4. 汇总所有已关闭任务，形成可以直接编码的实施规格、里程碑和验收命令。

## 当前前沿

- 无

## 进行中

- 无

## 已阻塞任务

- 无

## 已关闭任务

- [明确B站网页弹幕协议契约与失败边界](./tickets/01-bilibili-protocol-contract.md)
- [确定采集会话状态机](./tickets/02-session-state-machine.md)
- [确定直播事件模型与SQLite结构](./tickets/03-event-model-and-storage.md)
- [制作实时监控界面原型](./tickets/04-realtime-ui-prototype.md)
- [确定Electron进程边界与IPC契约](./tickets/05-process-and-ipc-boundaries.md)
- [验证高吞吐采集与实时聚合方案](./tickets/06-throughput-prototype.md)
- [核实Apple Silicon打包与本地数据路径](./tickets/07-macos-packaging.md)
- [确定测试、诊断与脱敏日志方案](./tickets/08-testing-and-observability.md)
- [汇总第一版实施规格与交付顺序](./tickets/09-final-implementation-spec.md)
