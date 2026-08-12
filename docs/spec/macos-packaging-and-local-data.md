# macOS打包与本地数据规格

## 目标与边界

第一版只交付Apple Silicon原生应用，支持macOS 13及以上版本。产物包括：

- 可直接运行的`弹幕看板.app`。
- 用于拖入`/Applications`安装的`弹幕看板-<version>-arm64.dmg`。

第一版没有Developer ID签名、Apple公证、自动更新、Mac App Store发行、Intel构建和通用二进制。这里的未签名发行版特指没有Developer ID身份和公证票据，`.app`内部仍必须使用ad-hoc签名保证Apple Silicon可执行代码完整。

## 固定标识与版本

首个保存用户数据的版本开始使用以下稳定标识：

| 项目 | 值 |
| --- | --- |
| npm名称 | `danmaku-dashboard` |
| 产品名称 | `弹幕看板` |
| Bundle ID | `com.songjinzhao.danmaku-dashboard` |
| 最低系统 | macOS 13.0 |
| 目标平台 | `darwin` |
| 目标架构 | `arm64` |

`name`、`productName`和Bundle ID不能在升级中改变。应用版本使用语义版本，`CFBundleVersion`必须随每次构建递增。

调研日的构建基线固定为：

```text
Electron 43.2.0
Node.js 24.18.0（Electron内置）
Electron Forge 7.11.2
@electron-forge/maker-base 7.11.2
@electron/fuses 2.1.3
```

所有`@electron-forge/*`包使用相同精确版本，提交`package-lock.json`，构建只执行`npm ci`。Electron 43计划于2027-01-05结束支持；超过该日期后构建发布版，必须先升级到仍受支持的稳定版本并重跑本规格全部验收。

## SQLite驱动

正式驱动首选Electron内置的`node:sqlite`，由唯一writer worker和只读reader worker调用。这样不引入需要Electron ABI重建的原生`.node`插件。

在开始业务存储实现前，打包后的arm64应用必须通过以下运行时探测：

- 主进程和两个Node worker都能导入`node:sqlite`。
- `PRAGMA compile_options`包含FTS5。
- 可以创建`fts5(body, tokenize='trigram')`虚表，并完成中文子串插入、查询和删除。
- WAL、外键、5000毫秒忙等待和两个连接并发读取正常。
- `sqlite.backup()`能生成一致性备份，重开后`PRAGMA quick_check`返回`ok`。
- 百万事件原型使用的DDL、参数绑定和查询都能在Electron运行时执行。

任一探测失败都暂停存储实现，新增SQLite驱动ADR并重新执行产物探测。不能用开发机Node.js或系统SQLite的结果代替Electron产物结果。

## Forge配置

`package.json`至少保留：

```json
{
  "name": "danmaku-dashboard",
  "productName": "弹幕看板",
  "scripts": {
    "package:mac": "electron-forge package --platform=darwin --arch=arm64",
    "make:mac": "electron-forge make --platform=darwin --arch=arm64"
  }
}
```

`forge.config.ts`落实以下约束。DMG使用项目内Forge maker调用macOS系统`hdiutil`，避免`@electron-forge/maker-dmg`间接依赖的旧原生模块与固定Node.js基线冲突：

```ts
import type { ForgeConfig } from '@electron-forge/shared-types'

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: 'com.songjinzhao.danmaku-dashboard',
    icon: 'assets/icon.icns',
    extendInfo: {
      LSMinimumSystemVersion: '13.0',
    },
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: () => ({
        hardenedRuntime: false,
        timestamp: 'none',
      }),
    },
  },
  makers: [new HdiutilDmgMaker()],
}

export default config
```

项目内maker必须使用`execFile`向`hdiutil`传递固定参数，不拼接shell字符串。临时卷目录只包含复制后的`.app`和指向`/Applications`的符号链接，完成或失败后都删除。输出名称固定为`弹幕看板-<version>-arm64.dmg`，格式固定为`ULFO`。

ad-hoc签名必须交给Forge调用的`@electron/osx-sign`按嵌套层级完成。不能在发布脚本中使用`codesign --deep --sign -`重新覆盖产物。`--deep`只用于验收验证。

不设置`LSUIElement=true`。第一版同时保留Dock图标和菜单栏图标，用户可以通过Dock重新显示窗口。

## Electron Fuses

Forge在ad-hoc签名前通过`packageAfterCopy`钩子固定全部V1 Fuse。项目不使用`@electron-forge/plugin-fuses`，因为其7.11.2版本的peer范围停留在只认识8个Fuse的`@electron/fuses@^1.0.0`，无法严格配置Electron 43的9个Fuse。

| Fuse | 值 | 原因 |
| --- | --- | --- |
| `RunAsNode` | `false` | 不允许通过`ELECTRON_RUN_AS_NODE`把应用当通用Node运行时 |
| `EnableCookieEncryption` | `true` | 即使误写Chromium Cookie也由系统密钥保护 |
| `EnableNodeOptionsEnvironmentVariable` | `false` | 不接受`NODE_OPTIONS`和额外CA注入 |
| `EnableNodeCliInspectArguments` | `false` | 正式主进程不开放Node inspector |
| `EnableEmbeddedAsarIntegrityValidation` | `true` | 加载时验证`app.asar`完整性 |
| `OnlyLoadAppFromAsar` | `true` | 只加载经过验证的`app.asar` |
| `LoadBrowserProcessSpecificV8Snapshot` | `false` | Electron 43 arm64发行包只包含通用快照，启用后应用会在启动时退出 |
| `GrantFileProtocolExtraPrivileges` | `false` | renderer只使用`app://`协议 |
| `WasmTrapHandlers` | `true` | 保留V8对WebAssembly越界内存访问的信号处理器 |
配置使用`strictlyRequireAllFuses: true`。Electron或`@electron/fuses`升级后如果出现未配置Fuse，构建必须失败。验收使用本地已安装的CLI读取最终`.app`，逐项匹配上表。

`packageAfterCopy`还会删除Electron模板自带但项目不使用的摄像头、麦克风、音频捕获和蓝牙用途声明，并删除允许任意网络传输的ATS覆盖。验证脚本要求这些键在最终`Info.plist`中不存在。

关闭`EnableNodeCliInspectArguments`后，Playwright不能通过Node inspector接管最终主进程。开发应用仍使用Playwright自动化；最终产物使用黑盒启动、固定验证参数、系统命令和人工清单。

## 产物验证参数

正式主进程只接受两个固定验证入口：

```text
--verify-runtime
--benchmark-profile=smoke|million|sustained|soak
```

规则：

- 验证模式不创建窗口、菜单栏、采集会话或网络连接。
- 数据库和中间文件只创建在系统临时目录，不能读取或修改用户的Application Support数据。
- `--verify-runtime`检查主进程与两个worker的`node:sqlite`、FTS5三元组、WAL、backup和项目所需的异步`safeStorage`API。ad-hoc签名每次重建的代码身份不同，`isEncryptionAvailable`与自动加解密都可能触发macOS钥匙串重复授权并阻塞无界面验收，因此系统加密可用性、加解密与跨版本连续性保留为发布人工门槛。
- 性能档位调用生产队列、writer、reader、迁移与实时投影模块，输入只来自固定种子合成生成器。
- 参数不接受任意文件路径、SQL、模块名、网络地址或故障类型。
- 标准输出只有一个通过运行时schema的脱敏JSON摘要，标准错误不输出原始异常。
- 结束时关闭worker并删除临时数据库。清理失败只输出公开错误码。
- 正常应用已经运行时验证模式拒绝启动，避免与业务进程争用资源。

这两个入口用于证明最终asar和Electron运行时可以执行生产代码，不替代真实窗口、菜单栏、安装、升级和`safeStorage`跨版本人工验收。

## 本地目录

所有业务路径由主进程生成，不允许renderer接收绝对路径。

| 内容 | 固定位置 |
| --- | --- |
| Electron `userData` | `~/Library/Application Support/弹幕看板/` |
| 项目持久数据根目录 | `~/Library/Application Support/弹幕看板/app-data/` |
| 主数据库 | `app-data/database/danmaku.sqlite3` |
| SQLite WAL与SHM | 与主数据库同目录，由SQLite管理 |
| 迁移前备份 | `app-data/database/backups/` |
| HMAC键密文 | `app-data/secrets/local-user-hmac-key-v1.enc` |
| 设置 | `app-data/settings/settings.json` |
| Chromium `sessionData` | `~/Library/Caches/com.songjinzhao.danmaku-dashboard/Chromium/` |
| 脱敏日志 | `~/Library/Logs/弹幕看板/` |

数据库不能写入`.app`、DMG挂载点、项目目录、下载目录或`process.cwd()`。

主进程必须在`ready`前创建缓存目录并调用：

```ts
app.setPath(
  'sessionData',
  path.join(
    app.getPath('home'),
    'Library',
    'Caches',
    'com.songjinzhao.danmaku-dashboard',
    'Chromium',
  ),
)
app.setAppLogsPath()
```

业务状态不能写入`localStorage`或Cookie。删除`sessionData`只会清理可重建的Chromium缓存，不能删除历史、设置或采集状态。

## 本地HMAC键

第一版使用`safeStorage`异步API保护32字节随机HMAC键：

1. `app.ready`后检查异步加密是否可用。
2. 新数据库首次运行生成32字节随机键，编码后调用`encryptStringAsync()`。
3. 密文采用临时文件、文件同步和原子改名写入，最终权限为`0600`。
4. 后续启动只解密现有密文；需要轮换时按`shouldReEncrypt`原子更新密文，HMAC明文键本身不轮换。
5. 数据库已有历史而密文缺失、损坏或无法解密时，进入本地数据恢复错误，不生成替代键。
6. 明文键和密文都不能进入日志、IPC、崩溃报告、测试快照或诊断导出。

由于第一版只有ad-hoc签名，版本A到版本B的`safeStorage`连续性是发布硬门槛。正常钥匙串授权后仍无法解密时阻止发布，不能静默改为明文文件。

## 崩溃恢复与诊断数据

异常恢复的唯一事实来源是SQLite中`status='active'`的会话及`last_checkpoint_at_ms`。不建立第二份哨兵文件，避免文件和事务状态不一致。

第一版不调用`crashReporter.start()`，也不自动上传崩溃文件。minidump可能包含内存中的原始消息、UID或临时令牌，不符合数据最小化要求。崩溃定位使用脱敏结构化日志、会话转换、数据缺口和检查点。

日志路径、字段白名单、轮转和保留规则由测试与诊断规格统一定义。

## 首次启动

主进程按固定顺序启动：

1. 设置稳定应用名称并取得单实例锁。
2. 在`ready`前设置`sessionData`和日志目录。
3. 等待`app.whenReady()`。
4. 初始化`safeStorage`并读取或创建HMAC键。
5. 启动writer worker，检查数据库模式版本。
6. 新库执行全部迁移；旧库先在线备份，再事务迁移和校验。
7. 在writer事务中把残留活动会话结束为`process_interrupted`，不自动重连。
8. 启动reader worker。
9. 创建主窗口和持有强引用的菜单栏图标。
10. 只有密钥、存储和恢复全部成功后才允许开始采集。

启动失败时显示可诊断错误，不创建新采集会话。第二实例只唤起第一实例窗口并立即退出。

## 窗口与退出

关闭窗口不等于退出：

- 普通`close`事件取消关闭并隐藏窗口。
- `window-all-closed`不调用`app.quit()`。
- Dock激活、第二实例和菜单栏中的显示看板复用并显示现有窗口。
- 菜单栏中的停止采集只结束当前采集，不退出程序。

菜单栏退出、`Cmd+Q`、Dock退出和系统正常终止都进入同一个`QuitCoordinator`：

```text
idle -> draining -> permitted
```

`idle`收到退出请求时，如有活动采集先显示确认。确认后在`before-quit`阻止默认退出并进入`draining`，拒绝新操作、关闭上游连接、刷新有界队列、结束会话并依次关闭reader及writer。10秒内成功后进入`permitted`并再次调用`app.quit()`；超过10秒则保留活动会话，调用`app.exit(1)`，由下次启动按异常中断恢复，不能伪造正常结束。

## 升级

第一版不自动更新。用户必须先正常退出，再用新版`.app`替换`/Applications/弹幕看板.app`。

- 固定标识和本地路径保持不变。
- 打开旧数据库前创建并校验在线备份，最近保留两份。
- 每个迁移在事务中执行；失败进入只读恢复界面，不开始采集。
- 旧应用遇到更高模式版本时拒绝写入，不执行降级迁移。
- 新版本首次启动必须解密旧HMAC键，并验证固定测试UID的本地键未变化。
- 不能在程序运行时覆盖`.app`包内容。

## 卸载与数据保留

默认卸载只删除应用，不删除历史：

- 正常退出后把`/Applications/弹幕看板.app`移入废纸篓。
- `Application Support`、`Logs`、`Caches`和钥匙串内容继续保留。
- 重装相同标识的版本后继续读取原数据库。

完全删除需要先正常退出，再删除：

```text
~/Library/Application Support/弹幕看板/
~/Library/Logs/弹幕看板/
~/Library/Caches/com.songjinzhao.danmaku-dashboard/
```

此操作永久删除历史、备份、设置和HMAC密文。`safeStorage`没有删除应用钥匙串键的公开API，程序不得猜测条目名称并自动修改用户钥匙串；残留键在密文删除后不能单独恢复HMAC明文。

## 首次打开与Gatekeeper

本机构建且没有下载隔离属性的产物需要验证能直接运行。从网络下载的DMG会接受Gatekeeper检查；ad-hoc应用预期不能通过Developer ID和公证评估。

安装说明只允许以下标准流程：

1. 挂载DMG并把应用拖到`/Applications`。
2. 尝试打开一次。
3. 如果被拦截，打开系统设置中的隐私与安全，选择仍要打开并再次确认。

不能要求用户全局关闭Gatekeeper，也不能把删除`com.apple.quarantine`属性作为标准安装步骤。

## 可重复构建

可重复构建指相同提交、锁文件、工具版本和命令反复生成行为一致并通过验收的产物，不承诺DMG字节级哈希相同。

```bash
test "$(uname -m)" = "arm64"
sw_vers
node --version
xcode-select -p

npm ci
npm run typecheck
npm test
npm run make:mac
```

发布记录保存Git提交、`package-lock.json`校验值、Node.js、Electron、Forge、macOS版本和架构。

## 产物验收

设`APP_PATH`为Forge生成的`.app`，`DMG_PATH`为生成的唯一`.dmg`。

```bash
test -d "$APP_PATH"
test -f "$DMG_PATH"

file "$APP_PATH/Contents/MacOS/弹幕看板"
lipo -archs "$APP_PATH/Contents/MacOS/弹幕看板"
plutil -p "$APP_PATH/Contents/Info.plist"

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign --display --verbose=4 "$APP_PATH"

hdiutil verify "$DMG_PATH"
shasum -a 256 "$DMG_PATH"
```

必须满足：

- 主可执行文件只有`arm64`。
- Bundle ID、两个版本字段和最低系统版本正确。
- `codesign`严格验证成功，签名为ad-hoc，没有TeamIdentifier。
- DMG校验成功并能只读挂载。

以下评估预期失败，用于确认第一版没有伪装成可公开无警告分发的产物：

```bash
spctl --assess --type execute --verbose=4 "$APP_PATH"
```

最后执行人工验收：

- 从DMG安装到`/Applications`并首次启动。
- 验证业务数据只写入固定目录。
- 验证单实例、Dock、菜单栏、窗口隐藏与恢复。
- 活动采集时退出并确认10秒内有序收尾。
- 强制终止后重启，确认会话异常结束且不自动重连。
- 使用版本A创建历史，再由版本B验证迁移、HMAC键和用户本地键连续。
- 删除应用后重装，确认默认保留的数据可读。

官方证据、版本来源和仍需在正式产物中执行的探测见[Apple Silicon本地打包与数据目录调研](../research/macos-packaging-2026-07-29.md)。
