# Electron 43测试、诊断与脱敏边界调研

日期：2026-07-29

## 结论

第一版采用三层测试工具：

- 纯业务逻辑、协议、状态机、聚合、SQLite和IPC契约使用Vitest 4.1稳定版。
- React组件使用Vitest、jsdom、React Testing Library和`user-event`。
- Electron主进程、真实preload桥、BrowserWindow和完整用户流程使用Playwright Test 1.61的`_electron` API。

Spectron不能使用。Electron团队已在2022年停止维护并归档该项目，官方迁移方向是Playwright或WebdriverIO。

Playwright可以启动Electron 43开发应用，取得BrowserWindow对应的Page，并通过`electronApplication.evaluate()`在主进程执行受控检查。`electron.launch({ executablePath })`也可以把启动目标指向打包后的Electron可执行文件，但Electron官方教程只演示开发模式，Playwright仍把Electron自动化标为experimental。因此：

1. 开发应用E2E属于日常自动测试。
2. arm64打包应用E2E属于发布前必须运行的兼容性烟测。
3. 菜单栏图标、macOS原生菜单、原生对话框、Gatekeeper和DMG拖拽安装仍需真实产物人工验收。
4. 不能把Playwright成功启动开发应用当作打包应用已经通过。

Vitest适合此项目。它直接支持TypeScript和JSX、fake timers、V8或Istanbul覆盖率、文件隔离与并行控制。需要保留以下边界：

- Vite和Vitest可以转换TypeScript，但Vite不负责类型检查，发布门槛必须单独执行`tsc --noEmit`。
- fake timers只用于纯状态机、退避、心跳调度和窗口聚合测试。真实WebSocket、worker、SQLite和Electron生命周期测试使用真实时间。
- 默认保留测试文件隔离。只有纯函数测试允许并发，Electron应用、共享SQLite路径、Keychain和打包产物测试串行运行。
- Vitest覆盖率只证明被Vitest加载的代码。不能把它解释为Electron主进程、打包入口和Playwright流程的完整覆盖率。

第一版不启动`crashReporter`，不生成Node.js诊断报告、heap snapshot、Electron net log、Playwright HAR或线上会话trace。它们都可能保存进程内存、环境变量、请求头、请求正文、DOM快照、截图、控制台内容或网络正文。诊断依赖字段白名单的JSONL日志、聚合指标、SQLite会话恢复事实和脱敏故障码。

## 最终实施决策

后续实施规格选择关闭正式产物的`EnableNodeCliInspectArguments`Fuse。因此：

- Playwright的`_electron`只控制未打包测试入口。
- 最终`.app`不允许Playwright通过Node inspector访问主进程。
- 产物自动验收改用系统命令、黑盒启动，以及固定、无网络、只使用临时数据库的运行时与性能验证参数。
- 菜单栏、原生对话框、Gatekeeper和DMG安装继续人工验收。

本报告下文保留打包Playwright能力与Fuse取舍的调研过程，最终执行边界以[测试、诊断与脱敏日志规格](../spec/testing-and-observability.md)和最终实施规格为准。

## 调研限制

项目要求联网前运行`web-access`的依赖检查。当前安装中不存在：

```text
/Users/songjinzhao/.codex/skills/web-access/scripts/check-deps.mjs
```

执行结果为`MODULE_NOT_FOUND`。本次没有启动CDP，也没有使用任何浏览器登录态，只通过只读网页工具访问Electron、Playwright、Vitest、Vite、React Testing Library和Node.js的官方文档或官方源码。

## 版本与工具基线

### Electron 43

[Electron 43发布说明](https://www.electronjs.org/blog/electron-43-0)显示该主版本内置Chromium 150、V8 15和Node.js 24。[Electron 43.2.0发布页](https://releases.electronjs.org/release/v43.2.0)将`43.2.0`标为调研当日最新稳定版，并列出Node.js`24.18.0`。

本报告只针对已确定的Electron`43.2.0`。升级Electron、Playwright、Vitest或Vite任一主版本后，需要重跑开发E2E、打包E2E和故障注入套件。

### 建议固定的测试依赖

调研当日可采用：

```text
@playwright/test@1.61.0
vitest@4.1.7
@vitest/coverage-v8@4.1.7
vite@8.1.x
@testing-library/react@16.3.2
@testing-library/dom
@testing-library/user-event@14
jsdom
```

[Playwright 1.61发布页](https://github.com/microsoft/playwright/releases/tag/v1.61.0)、[Vitest官方发布页](https://github.com/vitest-dev/vitest/releases)、[Vite支持版本说明](https://v8.vite.dev/releases)和[React Testing Library发布页](https://github.com/testing-library/react-testing-library/releases)提供版本依据。

所有依赖在实现时使用精确版本并提交`package-lock.json`。Vitest 5目前仍是预发布版本，不进入第一版。

## Electron官方测试方向

### Spectron现状

[Electron的Spectron弃用公告](https://www.electronjs.org/blog/spectron-deprecation-notice)明确给出以下事实：

- 2022-02-01起正式弃用。
- 仓库归档后不再接受维护。
- Electron团队列出的迁移方向包括Playwright和WebdriverIO。

第一版不能安装Spectron，也不能从旧项目复制依赖Spectron或Electron`remote`模块的测试辅助代码。

### 推荐分层

Electron没有要求应用只能使用一种测试框架。结合进程模型，本项目按以下层次实施：

| 层次 | 工具 | 覆盖内容 | 明确不覆盖 |
|---|---|---|---|
| 单元测试 | Vitest，`node`环境 | 协议解码、运行时schema、状态机、退避、聚合、日志脱敏器、IPC输入输出schema | Electron进程和真实DOM |
| 存储集成 | Vitest，真实临时SQLite和worker | 迁移、WAL、FTS、事务、删除、备份、恢复、并发读写 | Electron打包运行时兼容性 |
| React组件 | Vitest、jsdom、React Testing Library、`user-event` | 界面状态、交互、可访问名称、列表上限、看板更新、错误和空状态 | Chromium布局细节、Electron IPC和原生窗口 |
| Electron E2E | Playwright Test的`_electron` | 主进程、preload、renderer、BrowserWindow、IPC、窗口隐藏与重建、异常恢复 | 菜单栏图标和系统原生界面的完整操作 |
| 产物验收 | Playwright打包烟测、系统命令、人工验收 | arm64`.app`、DMG、持久化、升级、安装、Gatekeeper、菜单栏退出 | 不适用 |
| 性能长跑 | 生产worker和合成负载工具 | 12小时、200条每秒、100万条、队列、延迟、内存和数据库大小 | 线上弹幕内容 |

主进程模块应把Electron API放在薄适配层，协议、状态机、存储命令、IPC schema和生命周期策略保持为可注入依赖的普通TypeScript模块。Vitest不应通过一个全局Electron mock模拟整个应用，这类测试容易在真实进程边界变化后继续误报成功。

## Playwright Electron自动化

### API稳定性

[Playwright Electron API](https://playwright.dev/docs/api/class-electron)当前仍明确标记为experimental。页面列出的支持范围为Electron`v14+`，所以Electron 43在声明范围内，但experimental意味着API或兼容性仍可能随Playwright版本变化。

[Electron官方自动化测试教程](https://www.electronjs.org/docs/latest/tutorial/automated-testing)使用`@playwright/test`和`_electron.launch()`启动开发应用。官方教程同时提醒其示例固定于Playwright 1.52，升级后应检查Playwright发布说明。

项目需要把以下组合写入锁文件和发布记录：

```text
Electron 43.2.0
Playwright Test 1.61.0
macOS版本
arm64
```

只要其中任一项变化，先跑最小启动探测，再跑全部E2E。

### 开发应用

开发模式使用官方教程给出的方式：

```ts
const electronApp = await electron.launch({
  args: ['.'],
})
```

测试可以：

- 用`firstWindow()`取得第一个BrowserWindow对应的Page。
- 用Page locator操作React界面。
- 用`electronApplication.evaluate()`读取主进程中的Electron状态。
- 用`electronApplication.process()`取得主进程ChildProcess，检查退出码和异常结束。
- 用`electronApplication.close()`请求应用退出。

[ElectronApplication API](https://playwright.dev/docs/api/class-electronapplication)确认`evaluate()`运行在Electron主进程，`firstWindow()`返回Page，`process()`返回主进程ChildProcess。

主进程检查必须通过专门的测试查询接口或只读表达式完成。测试不能直接改写数据库或生产状态后再声称用户流程通过。

### 打包前和打包后应用

`electron.launch()`提供`executablePath`选项。[Playwright官方源码](https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/electron/electron.ts)显示：

- 有`executablePath`时直接把该路径作为启动命令。
- 没有`executablePath`时使用项目安装的Electron可执行文件。
- Playwright只对非打包应用注入自己的loader。
- 启动时添加`--inspect=0`和`--remote-debugging-port=0`，分别连接Node主进程和Chromium。

因此第一版准备两个目标：

```text
test:e2e:dev
test:e2e:packaged
```

`test:e2e:packaged`把`executablePath`指向Forge生成的arm64应用内部可执行文件，不把`.app`目录本身当作可执行文件。它至少验证：

1. `app.isPackaged`为`true`。
2. `process.arch`为`arm64`。
3. 应用进入存储就绪状态。
4. 主窗口可以显示、隐藏和重新显示。
5. 合成事件可以经过主进程、writer、SQLite、IPC和React完整显示。
6. 退出后SQLite可重新打开且没有活动事务。

Electron官方教程没有给出打包应用范例，Playwright源码也不会为打包应用延迟`ready`事件。测试必须等待项目自己的只读就绪信号，不能把首个窗口出现当作数据库和恢复流程已经完成。

### 主进程访问能力

Playwright通过Node inspector访问主进程。[Playwright Electron API](https://playwright.dev/docs/api/class-electron)明确提示，如果Electron Fuse中的`EnableNodeCliInspectArguments`被设为`false`，Electron启动可能超时。

这形成发布设计约束：

- 若第一版需要让Playwright验证同一份最终`.app`，不能关闭该Fuse。
- 若后续安全加固关闭该Fuse，Playwright只能运行在单独的自动化构建上；最终发布产物只能通过黑盒烟测和人工验收，不能宣称它与自动化构建完全等价。
- 不允许为了测试在正式应用中暴露通用IPC、任意SQL或任意主进程执行接口。

第一版实施前应在Electron Fuse ADR中明确选项。测试规格不能悄悄改变发布Fuse。

### Playwright不能证明的内容

Playwright文档给出以下限制：

- Electron自动化仍是experimental。
- [原生对话框说明](https://playwright.dev/docs/api/class-electron)表明Playwright不会拦截`dialog.showOpenDialog`、`showSaveDialog`和`showMessageBox`，因为它们直接进入操作系统API。自动测试需要在主进程替换这些调用，真实对话框另做人工验收。
- BrowserWindow内容可以作为Page操作，macOS菜单栏图标、系统菜单、Gatekeeper、安全设置和DMG拖拽不是DOM，不能由Page locator覆盖。
- Electron窗口是headful进程，不把普通浏览器的headless能力套用到Electron。

因此以下场景保留人工验收：

1. 菜单栏图标可见，点击能显示看板。
2. macOS应用菜单中的退出项触发正确确认。
3. 活动采集时`Cmd+Q`出现确认，取消和确认都符合预期。
4. 原生错误对话框文字没有敏感字段。
5. DMG挂载、拖拽安装、首次打开和Gatekeeper流程。
6. 安装版升级后数据、HMAC键和历史保持。

测试可以通过主进程调用菜单处理函数验证其业务效果，但这只证明处理函数，不证明macOS菜单或菜单栏图标本身。

## Vitest能力与配置边界

### TypeScript和Vite

[Vitest功能页](https://vitest.dev/guide/features)列出开箱即用的TypeScript和JSX支持，并复用Vite的配置、转换器、resolver和插件。

[Vite TypeScript说明](https://main.vite.dev/guide/features)明确指出Vite只转译TypeScript，不做类型检查。项目发布命令必须把以下步骤分开：

```text
tsc --noEmit
vitest run
vite build
```

测试通过不能替代类型检查，Vite构建成功也不能替代类型检查。

### fake timers

[Vitest计时器文档](https://vitest.dev/guide/mocking/timers)和[`vi.useFakeTimers()` API](https://vitest.dev/api/vi)支持替换`setTimeout`、`setInterval`、`Date`、`performance.now`等时间API。

适用范围：

- 指数退避和抖动边界。
- 心跳发送和超时判定。
- 等待开播轮询。
- 10秒退出软上限。
- 250毫秒IPC批处理窗口。
- 一分钟聚合窗口和日志汇总周期。

不适用范围：

- 真实WebSocket和HTTP。
- SQLite事务和文件系统刷新。
- `worker_threads`消息和退出。
- Electron`before-quit`、BrowserWindow和Playwright。
- 12小时持续运行和吞吐门槛。

每个使用fake timers的测试都要在`afterEach`恢复真实计时器并清理mock。React组件同时使用`user-event`和fake timers时，[user-event选项文档](https://testing-library.com/docs/user-event/options)要求把测试运行器的推进函数传给`advanceTimers`，不能通过`delay:null`规避计时。

### 覆盖率

[Vitest覆盖率文档](https://vitest.dev/guide/coverage.html)支持V8和Istanbul。第一版使用`@vitest/coverage-v8`：

- Node和Electron都使用V8，运行开销较低。
- 配置`coverage.include`，把没有被任何测试导入的生产文件也纳入报告。
- 对协议边界、状态机、IPC校验、删除和日志脱敏器设置独立阈值。
- 覆盖率报告只使用合成样本。

覆盖率不纳入以下判断：

- Playwright是否真实经过某条Electron主进程路径。
- arm64打包产物是否加载了正确模块。
- 原生菜单、菜单栏图标、Gatekeeper和Keychain是否工作。
- 12小时负载是否稳定。

不为了提高行覆盖率执行真实网络请求、真实删除或生成敏感产物。

### 隔离和并发

[Vitest测试编写文档](https://vitest.dev/guide/learn/writing-tests.html)说明测试文件默认并行，每个文件在隔离上下文运行，单个文件内的测试默认顺序执行。[Vitest隔离说明](https://vitest.dev/guide/improving-performance)说明关闭隔离会复用模块和全局状态。[`fileParallelism`配置](https://vitest.dev/config/fileparallelism.html)可以把文件级并行关闭。

项目规则：

- 全局保持`isolate:true`。
- 纯函数协议、schema、状态机和聚合测试可以文件级并行。
- 每个SQLite测试使用独立的`mkdtemp`目录，禁止共享固定数据库文件。
- 数据迁移版本序列、文件锁、writer崩溃、Keychain和Electron应用测试串行。
- Playwright Electron项目固定`workers:1`，因为第一版只允许单实例和单直播间。
- 12小时和100万条性能测试使用独立命令，不混入普通单元测试。

若测试只能在`--no-isolate`下通过，应视为共享状态缺陷，不把关闭隔离作为修复。

## React组件测试

[React Testing Library说明](https://testing-library.com/docs/react-testing-library/intro)强调通过用户可见DOM和可访问查询验证组件，避免依赖React内部实例。[`user-event`说明](https://testing-library.com/docs/user-event/intro)表明它会模拟一次交互产生的多组DOM事件，并检查元素是否可见、可交互。

第一版组件测试使用：

```text
Vitest
jsdom
@testing-library/react
@testing-library/user-event
@testing-library/jest-dom/vitest
```

renderer只依赖一个类型明确的preload接口。组件测试注入假的preload实现，覆盖：

- 未连接、等待开播、连接中、采集中、重连、暂停和存储错误。
- 实时弹幕、礼物、醒目留言、直播状态、连接状态和热度。
- 实时列表只保留固定节点数，旧节点被移除。
- 看板按提交后的事件更新，不展示尚未写入SQLite的事件。
- 数据缺口、异常中断和恢复提示。
- 历史搜索、分页和整场删除确认。
- 键盘操作、按钮可访问名称、焦点顺序、空状态和错误状态。
- preload拒绝、超时和窗口重建后的重新订阅。

jsdom不提供Chromium布局、Canvas性能、Electron IPC、BrowserWindow、Tray或Menu。CSS尺寸、滚动性能、窗口隐藏和系统菜单必须交给Playwright或人工验收。

## 第一版测试责任表

### 协议与边界校验

只使用人工构造的脱敏数据包，覆盖：

- 普通JSON包、zlib、brotli、多个子包和分片拼接。
- 包长、头长、版本、操作码和递归层级边界。
- 解压上限、畸形JSON、未知命令和已知命令字段缺失。
- 弹幕、礼物、醒目留言、直播状态、连接状态和热度转换。
- 原始UID在HMAC后不可从内部事件、异常或日志取回。
- 临时凭据、Cookie、完整帧和完整HTTP响应不会进入固定样本。

线上抓到的数据不能直接保存为测试fixture。需要复现时，先手工重建只保留结构的合成样本，并替换文本、UID、房间号、消息ID、金额、图键和令牌。

### 会话状态机

使用注入时钟、固定随机源和fake timers覆盖：

- 房间解析、等待开播、节点引导、鉴权和采集。
- 连接失败、节点轮换、令牌刷新和指数退避。
- 主动停止、应用退出、直播结束和不可恢复错误。
- 重连开始和结束时形成一条明确数据缺口。
- 同一动作重复到达时保持幂等。
- 10秒退出软上限后保留活动会话，供下次启动识别异常。

### SQLite和worker

真实临时数据库覆盖：

- 新库迁移、旧版本逐级迁移、未来版本拒绝。
- WAL、外键、FTS5 trigram和所需compile option探测。
- 批量写入原子性、去重、乱序和重复事件。
- writer失败时本批次不进入实时投影。
- reader与writer并发、繁忙超时和检查点。
- 搜索词参数化、分页稳定排序和FTS删除同步。
- 整场逻辑删除、物理清理和重建摘要。
- 迁移前备份、`quick_check`和恢复。
- `status='active'`会话在重启后标为`process_interrupted`。
- HMAC密文缺失或解密失败时阻止打开历史，不生成替代键。

Vitest在系统Node下运行的SQLite测试不能证明Electron 43内置Node和打包ASAR中的运行情况。打包E2E必须再执行一次SQLite、FTS、backup和两个worker探测。

### IPC和进程边界

单元和Electron E2E共同覆盖：

- 未公开通道、错误sender、子frame和已销毁窗口被拒绝。
- 所有输入经过运行时schema，分页、搜索和消息大小有限制。
- renderer不能读取数据库路径、HMAC键、原始UID和临时凭据。
- 主进程到renderer批次不超过规格大小和频率。
- 删除确认ID过期、重复、跨窗口或目标变化时失效。
- reader崩溃不停止采集，writer崩溃进入存储错误而不继续假装采集。
- renderer崩溃后主进程继续收取和写入，重建窗口后读取最新快照。

### 实时聚合和界面

合成事件覆盖：

- 每个事件类型的计数、金额、每分钟速率、在线热度和趋势。
- 空窗口、跨分钟、时钟跳变和缺口期间的口径。
- 200条每秒输入时IPC最多每秒4批，单批不超过256KiB。
- renderer列表节点上限和不可见窗口期间不累积无界DOM。
- committed序号出现缺口或重复时触发快照重同步。

### 后台生命周期

Playwright可以自动验证：

- BrowserWindow关闭后隐藏而不是销毁应用。
- 隐藏期间SQLite事件数继续增长。
- 重新显示窗口后通过快照恢复。
- `forcefullyCrashRenderer()`后出现`render-process-gone`，采集继续。
- worker退出后产生对应诊断和状态变化。
- `app.quit()`走`before-quit`，完成队列刷新后退出。
- 强制结束主进程后，下次启动识别活动会话。

菜单栏图标、真实`Cmd+Q`、原生确认框和系统菜单需要人工验收。

### 打包和升级

发布前验证：

- `.app`和`.dmg`存在，主可执行文件为arm64。
- ad-hoc签名内部一致，DMG可校验和挂载。
- Playwright能启动打包应用并确认`app.isPackaged`。
- 安装后首次启动、关闭窗口后台采集、退出和重启。
- 版本A写入数据，版本B升级后历史、设置和本地用户标识不变。
- 删除`.app`后Application Support中的业务数据仍保留。
- Gatekeeper预期行为和安装说明与真实机器一致。

## 故障注入方法

故障注入只作用于合成会话和临时目录。

| 故障 | 注入位置 | 期望证据 |
|---|---|---|
| 房间接口超时、非2xx、非法JSON | HTTP适配器 | 公开错误码、退避、无响应正文日志 |
| WebSocket关闭和鉴权失败 | WebSocket适配器 | 节点轮换、令牌刷新、数据缺口 |
| 畸形包和解压超限 | 协议fixture | 丢弃计数、连接恢复、无原始字节日志 |
| writer事务失败 | writer命令边界 | 批次回滚、UI不提前显示、进入存储错误 |
| reader worker异常 | `Worker`终止 | 实时采集继续，历史查询暂时失败后恢复 |
| writer worker异常 | `Worker`终止 | 停止承诺持久化，活动会话保留 |
| renderer异常 | `forcefullyCrashRenderer()` | `render-process-gone`、窗口重建、采集继续 |
| renderer无响应 | 测试窗口阻塞或受控挂起 | `unresponsive`和恢复记录 |
| 主进程强制结束 | Playwright ChildProcess | 下次启动标记`process_interrupted` |
| 数据库锁和BUSY | 第二连接持锁 | 有界重试、队列指标、不丢已确认事件 |
| 数据库损坏 | 复制后的测试数据库 | 启动阻止、公开错误码、不覆盖原库 |
| HMAC密文损坏 | 临时测试profile | 阻止历史访问，不创建新键 |
| 磁盘写入失败 | 注入文件系统或测试卷 | 日志队列有界、存储错误、会话保留 |
| 退出刷新超时 | writer挂起 | 10秒后强制退出，下次识别异常 |

测试结束必须确认Electron主进程、renderer和worker都已结束，并删除测试自己的临时目录。不能清理或覆盖真实`~/Library/Application Support/弹幕看板`。

## Electron和Node可观测信号

### Renderer

[Electron app API](https://www.electronjs.org/docs/latest/api/app)提供应用级`render-process-gone`。事件带`webContents`和`RenderProcessGoneDetails`。[详情结构](https://www.electronjs.org/docs/latest/api/structures/render-process-gone-details)给出`clean-exit`、`abnormal-exit`、`killed`、`crashed`、`oom`、`launch-failed`和`memory-eviction`等原因。

[webContents API](https://www.electronjs.org/docs/latest/api/web-contents)还提供：

- `render-process-gone`
- `unresponsive`
- `responsive`

第一版使用应用级`render-process-gone`计数，再在对应webContents上处理重建。不要同时把应用级和webContents级同一事件计算两次。

日志字段只保存：

```text
webContentsRole
reason
exitCode
recoveryAction
```

不保存当前页面DOM、URL、弹幕或renderer console的任意参数。

### Chromium子进程

Electron的`child-process-gone`覆盖Utility、GPU、Network Service等Chromium子进程，并明确不包含renderer。允许记录：

```text
type
reason
exitCode
serviceName
```

`name`和`serviceName`只在确认属于Electron固定枚举或Chromium服务名后记录，未知自由文本丢弃。

`child-process-gone`不覆盖Node`worker_threads`。writer和reader需要独立监听Node Worker。

### Node Worker

[Node.js worker_threads文档](https://nodejs.org/download/release/latest-v24.x/docs/api/worker_threads.html)规定：

- Worker未捕获异常会触发`error`并终止。
- Worker停止会触发`exit`，这是最后一个事件。
- 非零退出码表示异常或终止。

每个worker记录启动代次、角色、预期终止标志、退出码和恢复动作。禁止直接写入Worker传出的任意Error对象或消息正文。

### 应用退出

[Electron app生命周期文档](https://www.electronjs.org/docs/latest/api/app)规定：

- `before-quit`在应用开始关闭窗口前触发，`preventDefault()`可以阻止退出。
- `will-quit`在窗口关闭后、进程退出前触发。
- `quit`带最终退出码。
- `app.exit()`立即结束，不触发`before-quit`和`will-quit`。

第一版把`before-quit`作为有界异步关闭入口：

1. 第一次进入时`preventDefault()`并设置退出中标志。
2. 停止采集，完成已接收队列，关闭缺口和会话。
3. writer检查点并关闭，reader关闭。
4. 成功后再次调用`app.quit()`，退出中标志允许第二次通过。
5. 10秒仍未结束才调用`app.exit()`，活动会话留给下次恢复。

允许记录退出阶段、耗时、未完成队列数量和是否强制退出，不记录队列内容。

### 未捕获异常

[Node.js process文档](https://nodejs.org/api/process.html)说明未捕获异常后进程状态可能不确定，`uncaughtException`只应做同步清理后退出，不能恢复正常运行。`uncaughtExceptionMonitor`可以在不改变默认崩溃行为的情况下观察异常。

主进程和worker使用`uncaughtExceptionMonitor`写入最小脱敏记录，让默认行为结束进程。不得安装一个吞掉异常并继续采集的`uncaughtException`处理器。

`unhandledRejection`记录公开错误码和阶段，随后进入受控失败路径。Promise对象、reason原值和任意上游错误正文不能直接序列化。

## 结构化日志方案

### 文件与轮转

日志目录继续使用`app.setAppLogsPath()`得到的：

```text
~/Library/Logs/弹幕看板/
```

日志采用一行一个对象的UTF-8 JSONL：

```json
{
  "ts": "2026-07-29T12:00:00.000Z",
  "level": "info",
  "event": "collector.state_changed",
  "component": "collector",
  "runId": "run_01",
  "sessionId": "session_01",
  "from": "connecting",
  "to": "collecting",
  "durationMs": 183
}
```

保留规则沿用打包规格：

- 单文件最多5MiB。
- 最多5个轮转文件。
- 最长保留7天。
- 不自动上传。

接收链路不能同步逐条写日志。普通指标按一分钟汇总，状态变化和错误单独写入有界缓冲区。缓冲区满时丢弃低级日志并增加`log_dropped_count`，不能阻塞WebSocket接收。

### 字段白名单

通用字段：

```text
ts
level
event
component
appVersion
electronVersion
runId
sessionId
state
from
to
stage
result
errorCode
retryable
attempt
nodeIndex
httpStatus
wsCloseCode
durationMs
count
bytes
batchSize
queueDepth
queueHighWater
gapId
workerRole
workerGeneration
processType
reason
exitCode
```

规则：

- `event`来自固定枚举。
- `errorCode`是项目公开错误码。
- `reason`只允许Electron或项目枚举，不能写上游自由文本。
- `httpStatus`只保存状态码，不保存URL、响应头和响应正文。
- `wsCloseCode`只保存数字关闭码，不保存上游reason字符串。
- 房间关联只使用内部`sessionId`。不记录直播链接和原始房间输入。
- 错误堆栈只保留项目相对路径、函数名和行号；错误message先映射成公开错误码，不能原样写入。

### 禁止字段

任何级别都不能记录：

- Cookie、临时凭据、WBI键、buvid、请求头和鉴权包。
- 房间接口完整URL、完整响应、WebSocket帧和压缩字节。
- 原始UID、`localUserKey`、HMAC明文键和`safeStorage`密文。
- 昵称、弹幕、礼物留言、醒目留言和搜索词。
- SQL参数、删除确认ID和IPC完整payload。
- 任意Error、Request、Response、Event或Electron对象的直接序列化结果。
- Application Support绝对路径中的用户名。

未知对象进入日志函数时拒绝写入，不能用`JSON.stringify(value)`作为兜底。

## 聚合指标

指标只驻留内存并按一分钟写入脱敏摘要。第一版不引入远程遥测。

### 采集和协议

```text
bootstrap_attempt_count
bootstrap_failure_count_by_code
ws_connect_count
ws_close_count_by_code
auth_failure_count_by_code
heartbeat_lag_ms_p95
last_frame_age_ms
compressed_bytes
decoded_bytes
packet_count_by_operation
decode_drop_count_by_code
schema_reject_count_by_command
unknown_command_count
reconnect_count
gap_count
gap_duration_ms
```

### SQLite和队列

```text
writer_queue_depth
writer_queue_high_water
writer_batch_size
writer_commit_ms_p50_p95_p99
writer_failure_count_by_code
reader_query_ms_p50_p95_p99
reader_failure_count_by_code
wal_bytes
checkpoint_count_by_result
persisted_event_count_by_type
```

### IPC和renderer

```text
ipc_batch_count
ipc_batch_bytes
ipc_batch_size
ipc_reject_count_by_code
commit_to_renderer_ms_p95
renderer_live_row_count
renderer_resync_count
render_process_gone_count_by_reason
renderer_unresponsive_count
```

### 进程资源

[Node.js`monitorEventLoopDelay()`文档](https://nodejs.org/api/perf_hooks.html)提供事件循环延迟直方图，数值单位为纳秒。[Electron`app.getAppMetrics()`文档](https://www.electronjs.org/docs/latest/api/app)提供应用关联进程的CPU和内存统计。

第一版每分钟记录：

```text
main_event_loop_lag_ms_p95_p99
main_rss_bytes
worker_heap_used_bytes_by_role
electron_private_memory_kib_by_process_type
cpu_percent_by_process_type
```

macOS上Electron文档指出`process.getProcessMemoryInfo()`的`private`比压缩内存环境下的resident set更有代表性。长跑报告同时保存定义和单位，不能混用KiB、KB和字节。

## 崩溃报告和高级诊断边界

### Electron crashReporter

[Electron crashReporter文档](https://www.electronjs.org/docs/latest/api/crash-reporter)说明：

- Crashpad会收集minidump。
- `uploadToServer:false`只是不上传，仍会在本地收集。
- 一旦启动不能停止。
- `extra`和`globalExtra`会进入报告。

第一版不调用`crashReporter.start()`。即使不上传，minidump仍可能包含进程内存中的弹幕、原始UID和临时凭据。

### Node.js诊断报告

[Node.js诊断报告文档](https://nodejs.org/api/report.html)显示报告包含命令行、JavaScript和native stack、heap信息、libuv handle、操作系统和资源信息，默认还包含环境变量与网络接口。

第一版保持以下选项关闭：

```text
process.report.reportOnFatalError=false
process.report.reportOnSignal=false
process.report.reportOnUncaughtException=false
```

不能用`--report-exclude-env`作为启用报告的充分理由，报告仍含命令行、栈、handle和其他运行信息。

### Heap snapshot、net log和content trace

- Heap snapshot可能包含完整JavaScript堆和业务字符串，第一版不生成。
- [Electron netLog文档](https://www.electronjs.org/docs/latest/api/net-log)明确说明`includeSensitive`包含Cookie和认证数据，`everything`包含套接字传输字节。第一版不启动netLog。
- Chromium或Electron content trace不进入用户诊断导出。

后续若需要启用任一高级诊断，必须单独做隐私ADR、用户明确同意、限时采集、本地保存、独立清理和导出前检查，不能借用第一版日志授权。

## 测试产物的敏感信息边界

### Playwright产物

[Playwright Trace Viewer文档](https://playwright.dev/docs/trace-viewer)说明trace可以包含：

- 操作前后的DOM快照。
- 截图。
- 浏览器和测试控制台。
- 网络请求头、响应头、请求正文和响应正文。

Playwright 1.61还把WebSocket请求加入HAR和trace记录。[Playwright 1.61发布页](https://github.com/microsoft/playwright/releases/tag/v1.61.0)给出该变化。

因此：

- 所有自动E2E只使用合成房间、合成事件和固定占位凭据。
- 只有合成测试允许`trace:'retain-on-failure'`和失败截图。
- 真实公开直播间的人工验证固定`trace:'off'`、`video:'off'`、`screenshot:'off'`和HAR关闭。
- trace、截图、视频、HTML报告和测试结果目录不提交Git。
- 不把真实trace上传到`trace.playwright.dev`、CI artifact或问题追踪系统。
- 测试名称、附件名和输出路径只使用场景名和随机runId，不使用房间号、昵称或消息正文。

### 脱敏哨兵测试

测试fixture加入显然虚构的哨兵：

```text
COOKIE_CANARY_DO_NOT_STORE
TOKEN_CANARY_DO_NOT_STORE
RAW_UID_CANARY_DO_NOT_STORE
LOCAL_USER_KEY_CANARY_DO_NOT_STORE
DANMAKU_CANARY_DO_NOT_LOG
SEARCH_CANARY_DO_NOT_LOG
```

每次测试结束扫描：

- JSONL日志。
- 诊断摘要。
- Playwright文本报告。
- SQLite中不应存在的列和字段。
- renderer IPC抓取结果。

断言所有禁止哨兵都不存在。弹幕哨兵可以存在于测试SQLite业务内容和合成UI中，但不能存在于日志、诊断导出和非必要测试报告。

扫描本身只使用固定合成值，不使用真实Cookie、令牌或UID。

## 建议的命令边界

实现后形成独立命令：

```text
npm run typecheck
npm run lint
npm run test:unit
npm run test:coverage
npm run test:integration
npm run test:e2e:dev
npm run make:mac
npm run test:e2e:packaged
npm run test:privacy
npm run test:load:1m
npm run test:load:200eps
npm run test:soak:12h
```

约束：

- `test:unit`和`test:integration`不联网。
- `test:e2e:dev`和`test:e2e:packaged`默认使用合成采集适配器和临时profile。
- `test:e2e:packaged`固定单worker。
- `test:load:*`使用最终Electron runtime、生产worker和生产SQLite驱动。
- `test:soak:12h`必须输出机器信息、版本、开始结束时间、事件总数、失败数、队列高水位、延迟分位数、内存趋势和数据库检查结果。
- 任何命令检测到真实Cookie、令牌或真实用户数据路径时立即失败。

## 工具选择的最终限制

1. Vitest负责普通TypeScript模块和React组件，不模拟完整Electron。
2. React Testing Library验证用户可见DOM，不验证Chromium绘制性能和macOS原生界面。
3. Playwright负责开发应用和打包应用的Electron流程，但其Electron API仍是experimental。
4. Playwright主进程访问依赖Node inspector，受Electron Fuse约束。
5. Playwright不能完整操作Tray、Menu、原生对话框、Gatekeeper和DMG安装。
6. 单元覆盖率、E2E通过和性能长跑是三份不同证据，不能互相替代。
7. 第一版不收集minidump、Node诊断报告、heap snapshot、net log、线上trace或HAR。
8. 所有自动测试和诊断产物只使用合成数据，线上协议问题通过手工重建的脱敏结构fixture复现。
