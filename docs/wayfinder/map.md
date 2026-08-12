# 形成B站弹幕看板第一版实施规格

## Destination

形成一份可以直接进入编码阶段的第一版实施规格与交付顺序，覆盖B站实时采集、后台生命周期、本地存储、实时弹幕、实时看板、历史查询、异常恢复、性能验证和Apple Silicon打包，不留下必须由开发者临场猜测的产品或架构问题。

## Notes

- 产品语言和已确认边界见[项目词汇表](../../CONTEXT.md)。
- 桌面技术栈见[使用Electron、React、TypeScript与SQLite](../adr/0001-electron-react-typescript-sqlite.md)。
- 项目规范见[AGENTS.md](../../AGENTS.md)。
- 本地图以Markdown文件作为任务追踪器，任务索引见[本地任务索引](./README.md)。
- 每次只解决一个任务；任务完成后把结论写入任务的解决记录，关闭任务，并在本节的下一节增加一行索引。

## Decisions so far

- [明确B站网页弹幕协议契约与失败边界](./tickets/01-bilibili-protocol-contract.md)：匿名网页协议当前可行，第一版采用版本化适配器、WBI签名、`protover=3`鉴权、节点轮换、完整引导刷新和脱敏固定样本。
- [确定采集会话状态机](./tickets/02-session-state-machine.md)：首次鉴权成功后创建会话，窗口关闭不停止采集，断线形成连续缺口并自动恢复，有序结束与异常中断分别持久化。
- [确定直播事件模型与SQLite结构](./tickets/03-event-model-and-storage.md)：规范化事实表保存必要字段，本地HMAC键替代平台标识，可重建投影、FTS5搜索、批量事务和可恢复整场删除满足百万事件约束。
- [制作实时监控界面原型](./tickets/04-realtime-ui-prototype.md)：宽窗口采用左侧实时弹幕与右侧看板，窄窗口使用内容页签，缺口、历史、删除和菜单栏状态均有明确交互。
- [确定Electron进程边界与IPC契约](./tickets/05-process-and-ipc-boundaries.md)：主进程拥有采集和生命周期，SQLite读写位于受监管worker，renderer经沙箱化窄IPC接收已提交数据，关闭窗口继续采集，退出时统一安全收尾。
- [验证高吞吐采集与实时聚合方案](./tickets/06-throughput-prototype.md)：500条或100毫秒批量写入配合固定容量投影有充足余量，100万条与定速200条/秒原型通过，12小时精确负载和生产发布门槛已经确定。
- [核实Apple Silicon打包与本地数据路径](./tickets/07-macos-packaging.md)：固定Electron与Forge的arm64构建基线，以ad-hoc签名生成本地`.app`和DMG，明确系统数据目录、HMAC键、恢复、升级、卸载、退出和发布验收边界。
- [确定测试、诊断与脱敏日志方案](./tickets/08-testing-and-observability.md)：以Vitest、Testing Library和Playwright分层验证纯逻辑、renderer与Electron边界，使用合成fixture和故障注入覆盖全部高风险路径，并以类型白名单日志、诊断摘要和隐私canary解释风控与缺口而不保存敏感内容。
- [汇总第一版实施规格与交付顺序](./tickets/09-final-implementation-spec.md)：固定精确依赖、目录边界、两阶段迁移、正式与测试入口、M0至M9里程碑、验收命令和脱敏发布证据，第一版可以从M0直接进入编码。

## Not yet specified

- 无。第一版编码所需决策已经写入[第一版实施规格](../spec/implementation-plan.md)。

## Out of scope

- B站官方开放平台、主播身份码和Cookie接入。
- 多直播间并发采集。
- Intel Mac、Apple签名、公证、自动更新和Mac App Store发布。
- Excel导出、时间轴回放和多场对比。
- 云端同步、多人协作和远程控制。
