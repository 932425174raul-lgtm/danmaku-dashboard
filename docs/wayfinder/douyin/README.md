# 抖音扩展任务索引

`map.md`是抖音扩展的主入口。`tickets/`中的文件是它的子任务；frontmatter中的`blocked_by`表示依赖关系。

## 推进顺序

1. 先完成匿名网页协议验证，区分已实测能力、源码核对能力和不可保证的数据。
2. 根据协议能力确定第一版事件范围，再固定平台适配器和脱敏边界。
3. 使用人工构造的Protobuf样本实现解码器，随后完成匿名在线采集闭环。
4. 接入现有会话、SQLite、看板和平台选择界面，最后执行持续采集、性能与打包验证。

## 当前前沿

- [确定多平台适配器与隐私边界](./tickets/03-platform-adapter-boundary.md)
- [建立Protobuf与签名脱敏样本](./tickets/04-protobuf-and-signature-fixtures.md)

## 已阻塞任务

- [确定多平台适配器与隐私边界](./tickets/03-platform-adapter-boundary.md)
- [建立Protobuf与签名脱敏样本](./tickets/04-protobuf-and-signature-fixtures.md)
- [验证匿名在线采集闭环](./tickets/05-anonymous-live-poc.md)
- [接入采集会话与本地存储](./tickets/06-integrate-collector-and-storage.md)
- [增加平台选择与抖音看板语义](./tickets/07-platform-ui.md)
- [完成持续采集、性能与安装包验证](./tickets/08-verification-and-packaging.md)
- [汇总抖音扩展实施规格](./tickets/09-final-douyin-spec.md)

## 已关闭任务

- [明确抖音网页直播协议与官方能力边界](./tickets/01-douyin-protocol-contract.md)
- [确定抖音第一版事件范围与缺失语义](./tickets/02-douyin-event-scope.md)
