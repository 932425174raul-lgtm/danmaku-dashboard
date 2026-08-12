# 测试、诊断与脱敏日志规格

## 1. 目标

本规格把协议、状态机、SQLite、IPC、实时聚合、界面、后台生命周期和macOS产物放入同一套验证体系。它需要同时证明：

- 固定输入得到固定结果，协议变化不会悄悄污染内部事件。
- 只有已经提交的数据进入实时界面，故障期间不会伪造连续采集。
- 窗口、renderer或只读worker故障不会停止主进程采集。
- writer或存储故障会停止接收并形成可解释的数据缺口。
- 长时间高负载下队列、内存、监听器和界面节点保持有界。
- 诊断信息足以定位匿名访问受限和数据缺口，但不包含临时令牌、Cookie、原始用户ID、消息正文、搜索词或本地密钥。
- Apple Silicon产物在真实macOS安装、升级、异常恢复和卸载场景下符合已经确定的边界。

## 2. 固定测试栈

第一版使用以下工具职责：

| 工具 | 职责 |
| --- | --- |
| Vitest | TypeScript单元测试、状态机时钟测试、组件测试、覆盖率和Node侧集成测试 |
| `@vitest/coverage-v8` | 以V8覆盖率执行发布门槛 |
| React Testing Library | 以用户可见语义验证renderer组件 |
| `@testing-library/user-event` | 键盘、焦点、页签、确认框和表单交互 |
| Playwright的Electron能力 | 启动测试版Electron主进程，验证窗口、preload、IPC、renderer崩溃恢复和后台生命周期 |
| macOS系统命令 | 验证架构、Info.plist、ad-hoc签名、DMG、安装路径和Gatekeeper边界 |

Spectron不进入依赖。Playwright的Electron能力属于实验接口，因此：

- 在`package-lock.json`中锁定精确版本，升级必须运行全部桌面集成测试。
- 封装一个很薄的`ElectronTestDriver`，业务测试不能直接散布实验API。
- 测试入口与正式入口分离，测试IPC、测试数据目录覆盖和故障控制器不得进入正式打包入口。

正式产物关闭Electron的Node命令行调试Fuse，因此Playwright不通过`_electron`接管最终`.app`主进程。产物自动验证使用系统命令、黑盒启动和两个固定验证参数：

- `--verify-runtime`：在系统临时目录验证SQLite、FTS5、backup、worker和`safeStorage`能力。
- `--benchmark-profile=smoke|million|sustained|soak`：使用固定合成数据和临时数据库运行生产worker、事务和投影代码。

这两个参数属于公开、有限、无网络的产物自检能力，不提供任意路径、任意SQL、故障注入或IPC。它们只输出脱敏JSON并在结束时删除临时数据库。Playwright仍负责未打包测试入口的主进程、preload和窗口自动化。

正式SQLite行为必须在项目锁定的Electron运行时中至少验证一次。普通Node进程中的快速测试只能验证纯逻辑，不能替代Electron内置SQLite版本、worker和打包后原生能力探测。

## 3. 测试分层

### 3.1 快速层

每次改动都运行：

- 静态格式、类型和lint检查。
- 纯函数与状态机单元测试。
- renderer组件测试。
- 人工合成样本隐私扫描。
- 临时数据库中的DDL、迁移和查询契约测试。

快速层不访问B站、不读取真实应用目录，也不启动打包产物。所有时钟、随机数和网络结果固定。

### 3.2 Electron集成层

在未打包的测试专用Electron入口中运行：

- 真实主进程、preload、renderer和worker线程。
- 真实临时SQLite文件。
- 可编排的合成HTTP与WebSocket传输。
- 窗口隐藏、恢复、renderer终止、worker退出、退出协调和首次快照竞态。

每个用例创建独立临时数据目录并在结束后关闭全部进程。不同用例不能共享数据库、端口、时钟或订阅。

### 3.3 产物层

在`.app`和DMG上运行：

- 静态产物检查。
- 无测试IPC的公开界面烟测。
- 真实目录、单实例、窗口与菜单栏生命周期。
- 版本A到版本B的数据库与`safeStorage`连续性。
- 强制终止后的异常会话恢复。

产物层使用专用macOS测试账户。它不能把测试数据写入开发者的真实应用目录，也不能靠生产构建中的隐藏环境变量改写目录。

### 3.4 容量与持续运行层

使用[高吞吐与实时聚合规格](./throughput-and-realtime-aggregation.md)中的固定种子负载：

- `smoke`：20,000条。
- `million`：1,000,000条。
- `sustained`：每秒200条，至少10分钟。
- `soak`：12小时，共1,382,400条。

正式发布的12小时门槛必须运行打包后的生产代码、正式SQLite驱动和正式worker，不能用原型结果代替。

### 3.5 线上协议兼容性层

线上协议冒烟是人工触发的兼容性检查，不进入默认测试：

- 操作者在命令行传入一个当时公开且正在直播的房间号。
- 只运行60秒，验证房间发现、WBI、节点发现、匿名鉴权、心跳和至少一种已知业务命令。
- 不落库，不开启Playwright截图、录屏、trace或网络正文保存。
- 标准输出只包含阶段、状态码、协议版本、已知命令计数和耗时。
- 房间输入、临时令牌、指纹、WBI材料、原始UID、昵称和消息正文不进入输出或测试产物。
- 没有业务消息时结果为`inconclusive`，不能伪装成通过；匿名访问受限时结果为`blocked_by_upstream_risk`，不能通过加入Cookie规避。

发布候选必须在发布当天执行一次。它用于确认网页内部协议仍兼容，不替代脱敏固定样本。

## 4. 测试目录与构建边界

目标结构：

```text
tests/
  fixtures/
    bilibili-web-v1/
    ipc-v1/
    migrations/
    ui/
  helpers/
  unit/
  component/
  integration/
  electron/
  performance/
  privacy/
  package/
```

约束：

- `tests/fixtures/`只允许显然虚构的JSON、文本和由虚构内容生成的二进制帧。
- 压缩包优先在测试初始化时由合成对象生成；若提交二进制文件，必须同时提交可审查的生成器和SHA-256。
- 不允许录制线上HTTP响应、WebSocket帧、Playwright网络归档或真实数据库作为fixture。
- 测试数据中的用户、昵称、房间、令牌、WBI键和消息标识使用固定前缀，例如`synthetic_`和`fixture_`。
- 性能数据由固定种子生成，不能从历史数据库抽样。
- Electron测试专用入口只能由测试构建引用。正式打包的模块图和asar扫描必须确认它不存在。

核心模块接受窄依赖接口：

```text
Clock
RandomSource
HttpTransport
WebSocketTransport
StoragePort
WorkerFactory
NetworkMonitor
PowerMonitor
LogSink
```

单元和集成测试通过这些边界注入固定时钟、随机抖动、网络故障和worker退出。禁止在正式renderer中增加任意故障触发通道。

## 5. 覆盖率与稳定性门槛

快速层覆盖率最低要求：

| 范围 | 行 | 语句 | 函数 | 分支 |
| --- | ---: | ---: | ---: | ---: |
| 全部可测TypeScript | 85% | 85% | 85% | 80% |
| 协议包头、递归解码和运行时schema | 95% | 95% | 95% | 95% |
| 状态转换reducer和退避计算 | 95% | 95% | 95% | 95% |
| 事件规范化与本地用户键映射 | 95% | 95% | 95% | 95% |
| IPC输入输出schema与发送者校验 | 95% | 95% | 95% | 95% |
| 日志序列化、诊断导出与隐私扫描 | 95% | 95% | 95% | 95% |

生成代码、类型声明、测试入口和纯视图样式可以排除，但必须在配置中逐项列出。不能通过无意义断言或删除错误分支提高覆盖率。

稳定性规则：

- 单元、组件和数据库契约测试不重试。
- Electron测试默认不重试；若确认是系统启动抖动，最多允许一次重试，并在结果中保留首次失败。
- 测试不能依赖真实时间等待。纯状态测试使用假时钟，集成测试使用可推进时钟或明确的短超时。
- SQLite与worker集成测试逐用例使用独立临时目录。
- 出现未处理Promise、进程残留、监听器残留、控制台错误或隐私扫描命中即失败。
- 失败产物只允许包含合成数据；线上协议冒烟不产生trace、截图或录屏。

## 6. 脱敏fixture清单

### 6.1 协议包

`bilibili-web-v1`固定样本必须覆盖：

1. 固定假图键、固定`wts`和固定参数的WBI签名向量。
2. 纯数字房间、B站直播链接、短号转真实号、未开播、轮播、无效房间和字段缺失。
3. `getDanmuInfo`成功、`-352`、其他非零状态、空令牌、空节点和非法节点。
4. 操作码`8`鉴权成功、失败、超时前状态和格式错误。
5. 操作码`3`的正常热度、短正文和越界数值。
6. 版本`0`和`1`的单业务包。
7. 同一网络帧中的多个完整包和尾部截断包。
8. 版本`2`的zlib嵌套包。
9. 版本`3`的Brotli嵌套包。
10. `DANMU_MSG`、带冒号后缀的`DANMU_MSG`、`SEND_GIFT`、`SUPER_CHAT_MESSAGE`、`LIVE`和`PREPARING`。
11. 合法格式的未知命令，以及含控制字符或超长内容的恶意命令名。
12. 包长小于包头、包长越界、异常包头长度、未知版本、截断压缩数据、解压失败、无效UTF-8和无效JSON。
13. 超过4层递归、超过10,000个内层包、网络帧超过16 MiB和解压结果超过64 MiB的边界生成器。
14. 包含脚本标签、双向文本控制符、组合字符、emoji和超长Unicode的合成正文。

错误样本只断言错误类别和计数，测试输出不能打印正文或二进制内容。

### 6.2 状态时间线

每条时间线由事件、固定时间和期望副作用组成，至少覆盖[采集会话状态机](./session-state-machine.md)中的12个验收场景，并补充：

- 所有允许转换和所有禁止转换。
- 连续开始、停止、立即重试和过期回调的幂等性。
- 节点轮换耗尽后完整刷新引导材料。
- 固定随机源下的退避、上限和抖动边界。
- 心跳临界点前后1毫秒。
- 同一缺口中的多次网络、节点和worker故障不拆分缺口。
- 鉴权成功事务失败时不创建半成品会话。
- 正常结束批次失败时不能标记正常结束。
- 重启恢复只结束残留活动会话，不自动重连。

### 6.3 数据库与迁移

固定数据库样本只由DDL和合成生成器创建：

- 空数据库。
- 每个历史schema版本。
- 已结束小会话。
- 残留活动会话。
- 标记逻辑删除但物理清理未完成的会话。
- 校验值不匹配的迁移记录。
- `user_version`与迁移表不一致。
- 高于应用支持版本的数据库。
- 无效SQLite文件和通过字节破坏生成的损坏副本。

fixture不能包含任何真实历史数据。

### 6.4 IPC与界面

固定视图模型覆盖：

- 未开始、等待开播、正在采集、连接恢复、匿名访问受限和已结束。
- 有缺口和无缺口。
- 空历史、历史列表、详情、搜索和两阶段删除。
- 最近500条边界、趋势180桶边界、关键词128候选和256 KiB载荷边界。
- 合成HTML、脚本、外链、超长昵称、超长正文和Unicode边界。
- 旧`runId`、旧revision、乱序revision和订阅后快照竞态。

## 7. 分系统测试矩阵

### 7.1 协议与规范化

单元测试：

- 房间输入只能提取合法十进制房间号，请求主机和路径固定。
- WBI排序、字符过滤、URL编码、混排键和MD5向量精确匹配。
- HTTP响应schema对必需字段严格、对额外字段宽容。
- 包头使用大端序，单帧多包循环和版本`2`、`3`递归解压正确。
- 所有长度、数量和递归上限在边界值前后各有用例。
- 已知命令映射为规范化事件，未知命令只增加受限计数。
- 原始UID只进入HMAC计算，输出只有固定长度`localUserKey`。
- 无平台消息标识时不伪造严格去重键。
- 金额、时间和文本长度边界符合事件模型。

集成测试：

- 合成HTTP与WebSocket服务完成房间发现、匿名鉴权、立即心跳和业务包接收。
- 节点按顺序轮换，耗尽后丢弃旧令牌并重新引导。
- 两个心跳周期无有效服务端数据会关闭旧连接。
- 协议事件进入writer前完成schema校验和规范化。

故障注入：

- DNS、TLS、HTTP超时、HTTP非JSON、`-352`、空令牌、空节点、鉴权非零、鉴权提前关闭、心跳失活和连续解码错误。
- 断言令牌和WBI材料在每次完整刷新时被丢弃。
- 断言连续解码错误达到阈值后重连，单个异常单元不会杀死主进程。

发布验收：

- 脱敏fixture全量通过。
- 人工触发线上协议兼容性冒烟。
- 日志、IPC、SQLite和测试产物的隐私canary扫描通过。

### 7.2 采集状态机

单元测试：

- 以表驱动形式覆盖每个状态、事件、守卫、副作用和拒绝原因。
- 连续触发同一事件不会产生双连接、双会话、双缺口或重复终态。
- 假时钟验证等待轮询、30秒心跳、退避、下播二次确认和10秒退出上限。
- 旧代次连接、worker和定时器回调全部被忽略。
- `runId`改变后旧事件不能写入新会话。

集成测试：

- 12个既定验收场景逐项运行真实writer和合成网络。
- 状态转换、会话终态、缺口和检查点在同一事务边界内一致。
- 窗口隐藏不改变采集状态。
- 强制终止后重启把残留活动会话标记为`process_interrupted`。

故障注入：

- 在每个有副作用的转换前、事务中和提交后终止worker或主进程。
- 在网络恢复和用户停止同时发生时验证单一终态。
- 在`PREPARING`、断网和手动停止竞争时验证既定优先级。

### 7.3 SQLite、迁移与删除

单元测试：

- 所有SQL只接受参数，不拼接房间输入、搜索词或路径。
- 1至2字符搜索走参数化`instr`，3至200字符走FTS5三元组。
- FTS查询计划包含物化匹配ID，不回退为整场逐行探测FTS。
- 键集分页在相同毫秒时间戳下仍无重复、无遗漏。
- 重建摘要与增量投影逐字段一致。

真实数据库集成测试：

- 新库启用外键、WAL、`busy_timeout`、`auto_vacuum`和目标schema版本。
- 500条或100毫秒任一条件触发事务。
- 重复`source_event_key`不重复增加事实、摘要或投影。
- reader只能看到已提交高水位，回滚批次不可见。
- 每个迁移版本均可从上一个版本升级，校验值、`user_version`、外键、`quick_check`和FTS行数一致。
- 迁移前备份可打开且保留最近两份。
- 高版本数据库拒绝写入，迁移失败回滚并进入只读恢复。
- 逻辑删除500毫秒内隐藏会话，物理清理可中断、重启和继续。
- 删除完成后事实表、FTS和投影均不返回目标会话。

故障注入：

- 第二连接持有写锁，制造`SQLITE_BUSY`并验证5秒探测恢复。
- 使用`PRAGMA max_page_count`制造`SQLITE_FULL`。
- 存储适配器注入`SQLITE_IOERR`、备份失败、检查点失败和事务提交失败。
- 批次事务中止、writer中途退出、reader退出和迁移进程终止。
- 打开无效SQLite文件、校验值冲突和更高schema版本。

所有存储故障必须满足：

- 未提交批次不进入实时投影。
- WebSocket停止接收并关闭。
- 有界队列不被静默丢弃。
- 只打开一个连续的`storage`缺口。
- 探测成功后先刷积压，再重连。

### 7.4 IPC与进程边界

单元测试：

- 每个请求、响应和推送都有版本化运行时schema。
- 未知字段按契约处理，越界字符串、页大小和载荷被拒绝。
- sender必须来自当前主窗口顶层frame和允许的`app://`来源。
- 错误只映射为公开错误码，不透出堆栈、SQL、路径或上游正文。
- 删除确认绑定`webContents`、会话和30秒有效期，只能使用一次。
- revision和高水位比较规则能丢弃旧快照与乱序推送。

Electron集成测试：

- renderer中`window.require`、`fs`、`electron`、原生SQLite和原始`ipcRenderer`均不可用。
- 子frame、旧窗口、未知通道、超大分页和高频调用被拒绝。
- preload只公开固定接口，renderer构建产物不含Node内置模块引用。
- 订阅后、`app.ready`前发生的提交不会丢失，快照和缓冲事件按revision合并。
- 每秒200条时弹幕推送不超过每秒4次，分析推送不超过每秒1次，单包不超过256 KiB。
- renderer终止后主进程继续采集，重建窗口取得最近500条和当前投影。
- reader退出时采集继续，历史查询返回可重试错误，重启后恢复。
- writer退出时关闭WebSocket并进入存储恢复。

安全测试：

- HTML、脚本、`javascript:`链接和导航尝试只显示纯文本或被拦截。
- CSP禁止远程脚本、内联执行和非白名单连接。
- 新窗口、下载、权限请求和任意外链导航被拒绝。
- 正式asar扫描不存在通用测试入口、任意IPC桥和故障控制器；只允许固定产物验证入口。

### 7.5 实时聚合与性能

单元测试：

- 同一固定事件流的增量结果与离线事实重建完全一致。
- 最近弹幕最多500条、趋势最多180桶、关键词候选最多128项。
- 10秒桶在边界毫秒正确归属，最近30分钟窗口正确淘汰。
- 活跃人数和排行排除无本地用户标识的弹幕。
- Space-Saving候选计数、误差上界和确定性排序符合规格。
- 礼物与醒目留言金额只累计已知、合法的最小货币单位。

容量测试：

- `smoke`用于每次SQLite或聚合代码改动。
- `million`验证100万条吞吐、查询、WAL和投影。
- `sustained`验证每秒200条、批次、事件循环和IPC节流。
- `soak`验证12小时内存斜率、突发流量和资源上界。

发布判定完全采用[高吞吐与实时聚合规格](./throughput-and-realtime-aggregation.md)第9节，不在本文件另设较宽阈值。

### 7.6 renderer界面

组件测试：

- 未开始、等待、采集、恢复、匿名访问受限、结束和错误状态显示正确文案与操作。
- 宽窗口同时显示弹幕和看板；窄窗口页签切换不丢数据。
- 连接恢复和数据缺口不能显示成正常采集或零互动。
- 历史列表、详情、搜索、分页和逻辑删除后的返回路径正确。
- 停止等待、停止采集、删除整场和退出应用的确认框包含目标、后果和取消操作。
- 纯文本渲染合成脚本内容，不生成可执行节点或外链。
- 新弹幕不抢焦点，键盘焦点环、`aria-live`、图表摘要和减少动态效果有效。
- 最小窗口`620 × 640`、窄窗口`720 × 800`和宽窗口`1280 × 820`无横向滚动，点击目标不小于`44 × 44px`。

Electron人工视觉验收：

- 菜单栏状态图标和文字同步。
- 真实窗口缩放、系统字体、深浅背景下内容可读。
- 大量合成弹幕下列表DOM保持有界，滚动和输入无明显停顿。
- 颜色对比度、键盘全流程和VoiceOver关键流程通过。

自动截图只允许使用合成数据。真实直播界面不保存截图、录屏或trace。

### 7.7 后台生命周期

Electron集成测试：

- 关闭主窗口只隐藏，事件数和检查点继续增长。
- Dock激活、第二实例和菜单栏操作复用原窗口。
- `window-all-closed`不退出主进程。
- renderer崩溃、重建和重新订阅不打断采集。
- 活动采集时退出，取消后继续；确认后10秒内关闭连接、刷队列、结束会话和关闭worker。
- 退出超时调用异常退出，保留活动会话供下次恢复，不能写正常终态。
- 模拟休眠事件会打开一个缺口；模拟唤醒会自动重连并关闭同一缺口。
- 网络离线、在线和立即重试竞争不会建立重叠连接。

真实macOS人工验收：

- 关闭窗口后至少保持采集5分钟，重新打开时计数连续。
- 让Mac实际休眠至少1分钟，唤醒后缺口和重连状态正确。
- 使用活动监视器强制终止，重启后标记`process_interrupted`且不自动重连。
- `Cmd+Q`、Dock退出和菜单栏退出都经过同一确认与收尾流程。

### 7.8 macOS打包与本地数据

自动产物测试：

- 主可执行文件只有`arm64`。
- Bundle ID、版本、最低macOS版本和应用名称正确。
- `codesign --verify --deep --strict`成功，签名为ad-hoc且没有TeamIdentifier。
- DMG通过`hdiutil verify`并可只读挂载。
- 生产入口不包含测试IPC、测试数据目录覆盖、开发服务器地址或源映射中的密钥。
- 打包后的Electron运行时能创建WAL数据库、FTS5三元组表、worker读写连接并调用`safeStorage`异步API。
- `--verify-runtime`和4个固定性能档位只使用系统临时目录、合成数据和生产模块，不访问用户数据库或网络。
- 生产配置未启动`crashReporter`。

人工发布验收：

- 从DMG拖入`/Applications`并按系统标准流程首次打开。
- 应用数据、缓存和日志只写入固定系统目录。
- 单实例、Dock、菜单栏、窗口隐藏和后台采集正确。
- 版本A创建历史，版本B解密同一HMAC键、迁移数据库并保持固定测试UID的本地键不变。
- 删除应用后重装仍可读取保留数据。
- 完全删除固定目录后历史不可恢复。
- `spctl`失败被记录为第一版未签名、未公证的预期边界，不能通过关闭Gatekeeper规避。

## 8. 故障注入实现规则

故障注入只能位于以下位置：

- 纯模块构造参数中的依赖接口。
- worker测试启动参数。
- 测试专用Electron主入口。
- 由合成服务器控制的HTTP和WebSocket行为。
- 临时SQLite数据库上的真实锁、容量与损坏场景。

禁止：

- 正式preload公开`fault`、`debug`、`eval`、任意文件或任意IPC能力。
- 正式应用读取`DANMAKU_TEST_MODE`后打开隐藏能力。
- 测试直接修改用户真实Application Support、Logs、Caches或钥匙串数据。
- 依赖线上B站错误来制造风控、断网或畸形帧。

测试构建与正式构建必须有不同入口和不同模块图。产物测试以asar文件清单和字符串扫描证明正式包未包含测试IPC、故障控制器或任意测试入口。固定产物验证入口必须单独列入允许清单，并证明参数、数据目录和输出schema都不能由外部扩展。

## 9. 结构化日志

### 9.1 原则

日志采用白名单构造，不采用先记录再正则删除：

- 每个事件是一个有固定schema的JSON对象。
- logger只接受受控事件联合类型，不接受任意`message`、`details`、对象展开或原始`Error`。
- 未在事件schema中声明的字段使开发测试失败，生产运行时直接拒绝。
- 捕获异常的位置把错误映射为项目错误码、允许的底层类别和堆栈指纹。
- 不能序列化`Error.message`、`Error.stack`、HTTP正文、WebSocket正文、SQL、路径或请求配置。
- renderer不写持久日志，所有持久日志由主进程统一输出。

### 9.2 通用字段白名单

每条记录最多包含：

| 字段 | 规则 |
| --- | --- |
| `timestamp` | UTC ISO 8601 |
| `level` | `debug`、`info`、`warn`或`error` |
| `event` | 固定事件名枚举 |
| `logSchemaVersion` | 固定整数 |
| `appVersion` | 应用版本 |
| `electronVersion` | Electron版本 |
| `process` | `main`、`writer`或`reader` |
| `runId` | 当前采集运行UUID，可选 |
| `sessionId` | 本地SQLite会话整数，可选 |
| `correlationId` | 单次命令或恢复流程的随机UUID，可选 |
| `protocolAdapter` | 固定适配器版本，可选 |

事件专用字段只能从以下集合选择：

```text
stage
fromState
toState
reasonCategory
publicErrorCode
upstreamCode
httpStatus
wsCloseCode
sqliteCode
workerName
exitCode
signal
attempt
nodeIndex
nextRetryMs
durationMs
count
batchSize
queueDepth
commitDurationMs
ipcChannel
resultCategory
payloadBytes
revision
dbSchemaVersion
osVersion
architecture
stackFingerprint
```

值约束：

- 状态、阶段、原因、错误码、worker、IPC通道和结果都是枚举。
- `httpStatus`、`wsCloseCode`、`upstreamCode`、`exitCode`和SQLite扩展码是有限范围整数或枚举。
- `stackFingerprint`是规范化内部调用点生成的SHA-256，不包含原始堆栈。
- 未知业务命令只有匹配`^[A-Z0-9_]{1,64}$`的归一名称可以进入计数事件；其他值统一记为`OTHER`。
- WebSocket关闭原因字符串、SQLite错误文本、进程路径和信号附带文本永不记录。
- 房间号、房间标题和用户输入不记录。诊断关联使用`runId`和`sessionId`。

### 9.3 固定事件目录

第一版至少定义：

```text
app.started
app.ready
app.second_instance
app.quit_requested
app.quit_cancelled
app.quit_completed
app.quit_timed_out
storage.opened
storage.migration_started
storage.migration_completed
storage.migration_failed
storage.batch_committed
storage.fault
storage.probe_result
storage.checkpoint
worker.started
worker.exited
worker.restarted
collector.transition
collector.retry_scheduled
protocol.http_result
protocol.auth_result
protocol.decode_rejected
protocol.unknown_command
protocol.risk_blocked
gap.opened
gap.closed
ipc.request_completed
ipc.request_rejected
renderer.gone
renderer.recreated
diagnostics.exported
log.records_dropped
```

每个事件在代码中拥有独立schema。例如`storage.batch_committed`只能带`batchSize`、`queueDepth`、`commitDurationMs`、`revision`和关联标识，不能附加SQL或任意详情。

### 9.4 错误描述

捕获边界创建：

```ts
type SafeErrorDescriptor = {
  publicErrorCode: PublicErrorCode
  reasonCategory: ReasonCategory
  sqliteCode?: AllowedSqliteCode
  stackFingerprint?: string
}
```

`stackFingerprint`先把堆栈映射为已知模块和捕获点，再计算摘要。无法安全规范化时省略。原始异常只留在当前调用栈中，不进入持久日志、IPC、诊断导出或测试快照。

## 10. 日志文件、轮转与失败边界

路径：

```text
~/Library/Logs/弹幕看板/runtime.ndjson
```

规则：

- 目录权限`0700`，文件权限`0600`。
- 当前文件达到5 MiB时轮转。
- 保留当前文件和4个历史文件，总上限25 MiB。
- 启动和轮转时删除超过7天的历史日志。
- 默认记录`info`及以上；`debug`只允许未打包开发构建使用。
- 使用最多1,000条的异步有界日志队列，日志写入不能阻塞采集热路径。
- 队列满时先丢弃`debug`和重复`info`，在恢复后写一条带计数的`log.records_dropped`。
- `warn`和`error`尽力立即刷新，但磁盘故障不能导致采集进程再次崩溃。
- 日志目录不可写或磁盘满时，在界面显示一次脱敏诊断不可用提示，并停止重复写入；不能把错误正文转写到其他文件。
- 正常退出时在10秒总预算内刷新日志，日志刷新不能延长数据库安全收尾上限。
- 第一版不启动`crashReporter`，不保存或上传minidump。

## 11. 匿名访问受限与数据缺口诊断

### 11.1 匿名访问受限

一次匿名风险流程通过同一`correlationId`关联：

1. `protocol.http_result`记录`stage`、HTTP状态、上游状态码、耗时和尝试次数。
2. 收到`-352`时记录`protocol.risk_blocked`、适配器版本、尝试次数和下次退避。
3. `collector.transition`记录进入用户可见的匿名访问受限状态。
4. 后续重试只记录结果类别和累计次数。

不得记录请求URL查询、WBI图键、签名、指纹、临时令牌、请求头、响应正文、房间号或房间标题。这样可以判断失败位于房间发现、WBI、节点发现还是鉴权，也可以判断是HTTP失败、`-352`还是字段不兼容，但无法从日志恢复任何临时凭据。

### 11.2 数据缺口

一次缺口通过`runId`、`sessionId`和SQLite中的缺口记录关联：

1. `gap.opened`记录开始时间、`reasonCategory`和当时状态。
2. 每次恢复只记录节点序号、尝试次数、关闭码、worker状态、存储探测结果和退避。
3. 原因从网络变成节点或存储时更新内部诊断计数，但不新开缺口。
4. `gap.closed`记录是否恢复和持续时间。
5. 应用重启后，以SQLite缺口和会话转换作为事实，不靠日志推断业务终态。

允许的缺口原因只有：

```text
network
heartbeat
upstream_node
auth
anonymous_risk
protocol
storage
sleep
process_interrupted
```

日志用于解释恢复过程，SQLite用于展示缺口事实。两者都不能把缺口期间解释为零事件。

## 12. 诊断摘要导出

用户主动选择导出时生成单个JSON文件：

```text
danmaku-dashboard-diagnostics-YYYYMMDD-HHMMSS.json
```

内容白名单：

- 诊断schema版本。
- 应用、Electron、SQLite、协议适配器、macOS和架构版本。
- 数据库schema版本、`quick_check`结果和迁移状态。
- 会话总数、活动会话数、逻辑删除待清理数。
- 按脱敏原因分类的缺口数量和累计时长。
- 最近24小时、最多5 MiB的结构化日志记录。
- 日志丢弃计数和日志系统可用状态。

明确排除：

- SQLite数据库、WAL、备份和minidump。
- 房间号、房间标题、用户输入和搜索词。
- 昵称、消息正文、礼物正文和原始UID。
- `localUserKey`、HMAC明文、HMAC密文和钥匙串信息。
- Cookie、请求头、WBI键、指纹、签名和临时令牌。
- 文件绝对路径、设备名、macOS用户名、序列号和网络地址。
- renderer截图、录屏、HTML和Playwright trace。

导出流程：

1. 在主进程中读取已经过schema验证的日志，不遍历任意目录。
2. reader worker只返回固定聚合查询，不返回事实行。
3. 使用诊断导出schema重新构造对象，不复制任意输入对象。
4. 对序列化结果执行隐私canary和禁止键扫描。
5. 命中禁止项则中止导出并显示公开错误。
6. 通过后以临时文件、同步和原子改名写入用户选择的位置，权限`0600`。
7. 不自动上传，不自动打开外部网络。

## 13. 隐私与敏感信息测试

### 13.1 canary测试

每个边界注入唯一的合成canary：

```text
fixture_cookie_secret
fixture_temp_token_secret
fixture_wbi_secret
fixture_raw_uid_987654321
fixture_raw_envelope_secret
fixture_message_text_secret
fixture_search_secret
fixture_local_user_key_secret
```

运行完整协议、规范化、writer、IPC、日志和诊断导出流程后，扫描：

- SQLite全部文本列和schema。
- runtime日志。
- IPC响应和推送。
- renderer可见视图模型。
- 测试stdout、stderr、快照、截图、trace和覆盖率目录。
- 诊断摘要。

命中规则按字段用途区分：

- Cookie、临时令牌、WBI材料、原始UID和上游原始包附加字段在所有落地点都必须为零命中。
- 规范化合成消息正文只允许出现在SQLite事实表、业务IPC和renderer视图模型，不得进入日志、诊断摘要或测试失败输出。
- 搜索词只允许短暂出现在搜索请求IPC，不得进入SQLite、日志、诊断摘要或响应。
- `localUserKey`只允许出现在SQLite事实与投影，不得进入日志、业务IPC、renderer或诊断摘要。
- HMAC明文键和受保护密文在上述扫描目标中都必须为零命中。密文文件另用权限、原子写入和连续性测试验证，不读取内容作为测试产物。

### 13.2 仓库与产物扫描

`test:privacy`至少执行：

- 解析日志与诊断schema，拒绝未声明键。
- 扫描fixture清单，确认每个二进制包可由合成生成器重建。
- 扫描Git跟踪文件和测试产物中的已知凭据键、Cookie头、长令牌形态和canary。
- 扫描正式asar，确认不存在通用测试入口、故障IPC、临时令牌字段的持久化代码和`crashReporter.start()`；固定产物验证入口逐文件列入允许清单。
- 验证日志事件构造器无法接收任意对象或原始`Error`。

正则扫描是补充措施，不能替代类型白名单、运行时schema和canary端到端测试。

## 14. 验收命令

项目实现后必须提供以下稳定命令：

```bash
npm run format:check
npm run lint
npm run typecheck

npm run test:unit
npm run test:component
npm run test:integration
npm run test:electron
npm run test:privacy
npm run test:coverage

npm run test:performance:smoke
npm run test:performance:million
npm run test:performance:sustained
npm run test:performance:soak

npm run test:live-protocol -- --room <公开直播间>

npm run make:mac
npm run test:package
```

聚合命令：

```bash
npm test
npm run verify:fast
npm run verify:release
```

语义：

- `npm test`运行单元、组件、集成和隐私测试，不联网。
- `verify:fast`运行格式、lint、类型、`npm test`、覆盖率和性能`smoke`。
- `verify:release`要求`verify:fast`、Electron集成、`million`、`sustained`、12小时`soak`、macOS构建和产物测试全部通过。
- 线上协议冒烟和人工macOS验收由发布清单记录，不能在无房间输入时伪装成自动通过。

性能`smoke`用项目锁定的Electron运行正式主入口中的固定验证模式，便于在每个里程碑快速验证生产迁移、worker、队列和投影。`million`、`sustained`和`soak`只接受当前提交打出的最终`.app`；`test:package`必须在同一产物上重新执行一次`smoke`。所有性能模式都使用固定合成数据和系统临时目录，不能回退到系统Node或原型。

性能摘要、产物哈希和人工清单写入被Git忽略的`artifacts/verification/`。可以提交不含房间、用户和消息数据的模板，不能提交真实数据库、日志、截图或线上测试正文。

## 15. 发布人工清单

发布候选必须逐项记录通过、失败或不可判定：

1. 线上匿名协议冒烟在公开活跃房间完成，或明确记录上游风控阻断。
2. 窗口关闭后后台采集5分钟，重新显示时计数连续。
3. 真实休眠与唤醒形成一个缺口并恢复同一会话。
4. renderer强制终止后主进程继续采集并重建窗口。
5. 活动监视器强制终止应用后，重启标记`process_interrupted`且不自动重连。
6. reader故障不停止采集，writer故障停止接收并形成`storage`缺口。
7. `Cmd+Q`取消和确认路径正确，确认后10秒内有序结束。
8. 宽、窄和最小窗口无横向滚动，键盘和VoiceOver关键路径可用。
9. HTML、脚本和外链合成文本只显示为文字。
10. 100万条、每秒200条和12小时门槛全部通过。
11. DMG校验、arm64、Info.plist和ad-hoc签名通过。
12. 从DMG安装、首次打开、单实例、Dock和菜单栏通过。
13. 版本A到版本B的数据库迁移、HMAC键和本地用户键连续。
14. 默认卸载后数据保留，完全删除固定目录后历史消失。
15. runtime日志、诊断摘要、测试产物和正式asar隐私扫描零命中。

任何一项失败都阻止发布。线上冒烟因没有业务消息而不可判定时必须更换房间重试；因B站匿名风险被阻断时记录为外部阻断，不得用Cookie绕过，也不能宣称协议兼容已通过。

## 16. 完成判定

测试与诊断实现只有同时满足以下条件才算完成：

- 全部固定命令存在且退出码可信。
- 12个状态机场景、协议fixture、数据库故障、IPC安全、renderer恢复和后台生命周期都有自动证据。
- 正式产物没有通用测试入口和隐藏调试能力，只有公开、固定、无网络的产物验证参数。
- 性能测试使用最终Electron、SQLite和worker代码。
- 日志由类型与运行时schema双重白名单约束。
- 匿名访问受限和数据缺口可以通过脱敏事件链定位。
- 诊断摘要不包含数据库事实行或任何敏感字段。
- canary端到端扫描和Git、asar、测试产物扫描全部通过。
- 真实macOS发布清单由操作者逐项记录。

工具选择与Electron测试边界的一手资料见[测试与诊断工具调研](../research/testing-and-observability-2026-07-29.md)。
