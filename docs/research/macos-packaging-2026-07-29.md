# Apple Silicon本地打包与数据目录调研

日期：2026-07-29

## 结论

第一版可以在当前Apple Silicon Mac上稳定生成可双击运行的`.app`和安装用`.dmg`，建议固定以下基线：

- Electron固定为`43.2.0`。这是调研当日最新稳定版，内置Node.js`24.18.0`。
- Electron Forge固定为`7.11.2`，使用`@electron-forge/maker-dmg`生成`.dmg`。
- 构建目标只设为`darwin-arm64`，不构建`x64`或`universal`。
- 项目所说的未签名发行版，技术上应定义为没有Developer ID、没有公证，但`.app`内部使用ad-hoc签名。Apple Silicon要求可执行代码带签名，真正完全没有签名的产物不应作为交付物。
- 本机构建且没有隔离属性的ad-hoc应用通常可以直接运行。从浏览器或其他受隔离渠道下载的`.dmg`不能通过Gatekeeper，首次打开预计需要用户在系统设置的隐私与安全中选择仍要打开。
- 数据库、迁移备份、设置和加密后的HMAC键放在`userData`下的项目子目录；Chromium的`sessionData`单独移到`~/Library/Caches`；脱敏日志使用Electron的macOS日志目录。
- 异常中断恢复标记继续以SQLite中`status='active'`的会话和检查点为唯一事实来源，不再维护第二份哨兵文件。
- 第一版不启动Electron`crashReporter`。minidump可能包含进程内存中的原始消息或临时令牌，无法满足项目的数据最小化约束。崩溃诊断先使用脱敏结构化日志和SQLite恢复信息。

## 调研限制

项目要求所有联网操作先执行web-access的依赖检查。当前安装中不存在：

```text
/Users/songjinzhao/.codex/skills/web-access/scripts/check-deps.mjs
```

执行结果为`MODULE_NOT_FOUND`。本次没有启动CDP，也没有操作浏览器登录态，只通过只读网页工具访问Electron、Electron Forge、Node.js和Apple官方资料。

## 版本基线

### Electron

[Electron 43.2.0发布页](https://releases.electronjs.org/release/v43.2.0)将它标为最新稳定版，列出的依赖为：

- Chromium`150.0.7871.129`
- Node.js`24.18.0`
- V8`15.0.1240245`

[Electron发布计划](https://releases.electronjs.org/schedule)显示Electron 43的稳定发布日期为2026-06-30，计划在2027-01-05结束支持。实现期如果已经越过该日期，发布前必须重新选择仍受支持的稳定主版本并重跑本报告的全部打包验收。

Electron 43仍能运行在macOS 12。Electron的[破坏性变更文档](https://www.electronjs.org/docs/latest/breaking-changes)说明Electron 44开始要求macOS 13或更高版本。项目只面向当前Apple Silicon Mac，建议第一版直接设置：

```text
LSMinimumSystemVersion=13.0
```

这是项目支持范围选择，不是Electron 43本身的最低要求。当前验证机为`arm64`、macOS`26.5.1`，满足该范围。

### Electron Forge

[Electron官方发行指南](https://www.electronjs.org/docs/latest/tutorial/forge-overview)推荐使用Electron Forge完成打包和发行。[Forge官方仓库](https://github.com/electron/forge)显示调研当日最新稳定版为`7.11.2`。

所有`@electron-forge/*`包应固定相同的精确版本，并提交`package-lock.json`。不使用`latest`、范围版本或未锁定的预发布版本。若使用Forge的Vite插件，需要记录它的[官方文档仍标记为experimental](https://js.electronforge.io/modules/_electron_forge_plugin_vite.html)，因此也必须固定精确版本并依赖锁文件控制升级。

## `node:sqlite`可用性

### 官方事实

[Node.js 24.18.0的SQLite文档](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)表明：

- `node:sqlite`从Node.js 22.5.0加入。
- 在Node.js 24.15.0进入release candidate稳定级别。
- 提供同步`DatabaseSync`接口，适合放在项目已经确定的writer和reader worker中。
- `sqlite.backup()`提供SQLite在线备份接口，符合迁移前一致性备份要求。

Node.js 24.18.0的[官方SQLite构建文件](https://raw.githubusercontent.com/nodejs/node/v24.18.0/deps/sqlite/sqlite.gyp)显式定义了`SQLITE_ENABLE_FTS5`。同版本的[官方SQLite头文件](https://raw.githubusercontent.com/nodejs/node/v24.18.0/deps/sqlite/sqlite3.h)显示捆绑SQLite版本为`3.53.1`。

### 对Electron的判断

Electron 43.2.0内置Node.js 24.18.0，因此`node:sqlite`具备成为正式驱动的基础条件。使用它可以避免打包原生`.node`扩展、Electron ABI重建和ASAR解包配置。

但Electron发布页没有单独保证以下三点：

1. Electron主进程和Node worker中可以正常导入`node:sqlite`。
2. Electron实际捆绑的SQLite编译选项包含FTS5。
3. 运行时可以创建项目要求的`tokenize='trigram'`全文索引。

因此正式实现按以下规则选择驱动：

1. 首选`node:sqlite`。
2. 在第一条实现任务中，用打包后的arm64`.app`执行运行时探测。
3. 只有以下探测全部通过，才能把`node:sqlite`确认为生产驱动：

```sql
SELECT sqlite_version();
PRAGMA compile_options;
CREATE VIRTUAL TABLE packaging_fts_probe
USING fts5(body, tokenize='trigram');
DROP TABLE packaging_fts_probe;
```

同时调用一次`sqlite.backup()`，重新打开备份并执行`PRAGMA quick_check`。探测还要覆盖WAL、外键、两个worker连接和百万事件基准使用的语句。

若打包产物探测失败，存储实现任务暂停并新增ADR，选择一个经过Electron 43.2.0 arm64产物测试、支持FTS5、在线备份和worker使用的原生驱动，再由Forge的Package步骤重建。不能在发布阶段临时更换驱动，也不能用开发机的Node.js测试结果替代Electron产物测试。由于本报告限定只使用Electron、Node.js和Apple官方资料，不在缺少驱动官方兼容性证据时猜测具体第三方包。

## Forge打包方案

### 依赖与脚本

核心开发依赖固定为：

```text
electron@43.2.0
@electron-forge/cli@7.11.2
@electron-forge/maker-dmg@7.11.2
```

`package.json`保留两个独立命令：

```json
{
  "scripts": {
    "package:mac": "electron-forge package --platform=darwin --arch=arm64",
    "make:mac": "electron-forge make --platform=darwin --arch=arm64"
  }
}
```

[Forge CLI文档](https://www.electronforge.io/cli)确认`package`和`make`都支持`--platform`及`--arch`，`arm64`是`make`允许的架构。`make`会先执行Package，再调用配置的Maker。

### Forge配置

下面是第一版需要落实的配置骨架：

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
      optionsForFile: () => ({
        timestamp: 'none',
      }),
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        format: 'ULFO',
      },
    },
  ],
}

export default config
```

`package.json`中的稳定标识为：

```json
{
  "name": "danmaku-dashboard",
  "productName": "弹幕看板"
}
```

`appBundleId`、`name`和`productName`一旦开始保存本地数据就不能随版本变化。`com.songjinzhao.danmaku-dashboard`用于第一版个人本地发行，不能改成暗示B站官方关系的命名。

[Electron Packager选项](https://electron.github.io/packager/main/interfaces/Options.html)确认macOS支持`arm64`，`appBundleId`、`asar`、`icon`、`extendInfo`和`osxSign`都是正式选项。[Forge DMG Maker文档](https://www.electronforge.io/config/makers/dmg)确认DMG只能在macOS上构建，并给出了`ULFO`格式配置。

不要设置`LSUIElement=true`。项目需要Dock图标重新显示窗口，同时还要常驻菜单栏，两者可以同时存在。菜单栏常驻不要求把应用变成纯后台代理。

## ad-hoc签名和Gatekeeper

### 为什么不能真正完全不签名

Apple在[macOS Big Sur通用应用发布说明](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes/)中说明，Apple Silicon要求所有可执行代码带签名，不要求特定身份，ad-hoc签名即可满足本地执行要求。Apple同时明确指出，ad-hoc签名没有有效开发者身份，不能通过Gatekeeper。

Apple的[`kSecCodeSignatureAdhoc`文档](https://developer.apple.com/documentation/security/seccodesignatureflags/adhoc)说明使用伪身份`-`会生成ad-hoc签名。

Forge使用`@electron/osx-sign`签名。其[官方源码](https://raw.githubusercontent.com/electron/osx-sign/main/src/sign.ts)显示，传入自定义`identity`时默认会到钥匙串验证身份。`-`不是证书，因此需要同时设置：

```ts
identity: '-'
identityValidation: false
```

同一官方源码按从内到外的顺序签名Electron嵌套框架、Helper和主应用，再执行严格验证。不要自己用`codesign --deep --sign`覆盖Forge签名流程。`--deep`只用于验收时验证整个包。

### 首次打开

本地构建文件通常没有下载隔离属性，因此ad-hoc签名应用可以在构建机上直接运行。这一点仍要在最终产物上实测。

从网络下载或其他受隔离渠道得到的`.dmg`会进入Gatekeeper检查。ad-hoc应用的预期结果是：

- `codesign --verify`成功，说明包内签名一致。
- `spctl --assess`失败，说明它没有Developer ID和公证票据。
- 用户首次双击可能看到无法验证开发者或Apple无法检查恶意软件的提示。

Apple的[安全打开Mac应用说明](https://support.apple.com/en-us/102445)规定，用户先尝试打开一次，再进入系统设置中的隐私与安全，点击仍要打开并再次确认。第一版安装说明应照此描述，不建议用户全局关闭Gatekeeper，也不使用删除隔离属性作为标准安装流程。

## 本地数据目录

### 目录表

第一版固定以下位置：

| 内容 | 路径 | 规则 |
|---|---|---|
| 项目持久数据根目录 | `~/Library/Application Support/弹幕看板/app-data/` | 来自`app.getPath('userData')`下的项目子目录 |
| 主数据库 | `app-data/database/danmaku.sqlite3` | SQLite、WAL和SHM必须一起由SQLite管理 |
| 迁移前备份 | `app-data/database/backups/` | 保留最近两份已校验备份 |
| 加密HMAC键 | `app-data/secrets/local-user-hmac-key-v1.enc` | 文件只保存`safeStorage`密文 |
| 设置 | `app-data/settings/settings.json` | 原子写入，不保存令牌和Cookie |
| Chromium会话数据 | `~/Library/Caches/com.songjinzhao.danmaku-dashboard/Chromium/` | 可删除缓存，不作为业务事实来源 |
| 脱敏日志 | `~/Library/Logs/弹幕看板/` | 通过`app.setAppLogsPath()`取得 |
| Crashpad保留位置 | `app-data/diagnostics/crashpad/` | 第一版不启动`crashReporter`，目录仅预留 |
| 异常恢复标记 | `sessions.status='active'`及`last_checkpoint_at_ms` | SQLite是唯一事实来源，不建哨兵文件 |

[Electron 43.2.0的app API](https://github.com/electron/electron/blob/v43.2.0/docs/api/app.md)规定：

- macOS的`appData`默认为`~/Library/Application Support`。
- `userData`默认为`appData`加应用名称。
- 项目文件应放在`userData`的子目录中，避免和Chromium自身目录冲突。
- `sessionData`保存Cookie、缓存、网络状态和DevTools数据，默认指向`userData`，可能产生很大的磁盘缓存。
- 如果要修改`sessionData`，必须在`ready`事件前完成。
- 不带参数调用`app.setAppLogsPath()`时，macOS日志目录为`~/Library/Logs/应用名`。

Apple的[`applicationSupportDirectory`文档](https://developer.apple.com/documentation/foundation/url/applicationsupportdirectory)也将非沙箱macOS应用的持久支持数据定位到`~/Library/Application Support`。

数据库不能放在`.app`包内、`process.cwd()`、下载目录或DMG挂载点中。`.app`升级会整体替换，DMG挂载点是只读和临时位置。

### `sessionData`

主进程在`ready`前创建缓存目录并执行：

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
```

React界面不能用`localStorage`保存业务状态，不能用Cookie保存B站身份。窗口状态、设置和历史都由主进程写入项目数据目录。这样删除`sessionData`不会删除历史记录，也不会改变采集会话事实。

### 本地HMAC键

[Electron 43.2.0的safeStorage文档](https://github.com/electron/electron/blob/v43.2.0/docs/api/safe-storage.md)说明，macOS上的加密键保存在Keychain Access中，其他应用不能在没有用户覆盖授权的情况下读取。文档推荐使用异步API，以避免阻塞并处理临时不可用及密钥轮换。

第一版按以下规则保存本地用户HMAC键：

1. `app.ready`后检查异步加密是否可用。
2. 首次运行生成32字节随机HMAC键。
3. 将键编码为字符串后交给`safeStorage.encryptStringAsync()`。
4. 把返回密文原子写入`local-user-hmac-key-v1.enc`，文件权限设为仅当前用户可读写。
5. 后续启动只解密既有文件，不重新生成。
6. 如果数据库已有历史，但密文缺失、损坏或无法解密，进入本地数据恢复错误，不得静默生成新键。否则同一用户会在新旧事件中得到不同标识。

Apple的[代码签名要求说明](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)指出，ad-hoc签名的代码身份会绑定具体版本，不能像Developer ID签名一样可靠地跨版本识别。因此升级验收必须覆盖`safeStorage`连续性和可能出现的钥匙串授权提示。

第一版不设置静默降级路径。如果两个ad-hoc构建版本之间无法解密，即使用户完成标准钥匙串授权并重启仍失败，则打包验收失败，不能发布。后续必须通过ADR在Developer ID签名和权限为`0600`的本地明文键文件之间明确选择，并记录相应的分发成本或本机威胁模型变化。程序不得自行改用明文文件，也不得重新生成键。

### 日志和崩溃信息

日志只记录类别、计数、状态、耗时、队列深度、数据库错误码和脱敏房间信息。不能记录：

- Cookie、令牌和完整上游响应。
- 原始用户ID。
- 完整原始消息。
- 数据库正文查询结果。
- `safeStorage`明文或密文。

建议每个日志文件最多5MiB，最多保留5个轮转文件，并清理7天前文件。诊断界面只能导出再次脱敏后的摘要。

[Electron crashReporter文档](https://www.electronjs.org/docs/latest/api/crash-reporter)说明Crashpad报告会临时存放在`userData`下，启动前可用`app.setPath('crashDumps', ...)`修改位置，`uploadToServer:false`可以只收集不上传。由于minidump仍可能包含敏感内存，第一版不调用`crashReporter.start()`，也不自动上传任何崩溃文件。

## 首次启动顺序

主进程必须按固定顺序启动：

1. 设定稳定应用名称。
2. 获取单实例锁。命令行启动的第二实例也必须退出，并让第一实例显示窗口。
3. 在`ready`前创建并设置`sessionData`，初始化日志路径。
4. 等待`app.whenReady()`。
5. 初始化`safeStorage`，读取或生成本地HMAC键。
6. 打开writer worker，检查数据库版本。
7. 新数据库执行全部迁移；旧数据库先做在线备份，再执行事务迁移和校验。
8. 在同一writer事务中处理残留的活动会话，把它标记为`process_interrupted`。
9. 启动reader worker。
10. 创建主窗口和菜单栏图标。
11. 只有存储、密钥和恢复全部成功后，才允许开始采集。

启动过程中任何一步失败，都显示可诊断错误，不创建新的采集会话。

## 升级规则

第一版没有自动更新。升级由用户退出应用后，用新`.app`替换`/Applications/弹幕看板.app`。

升级必须满足：

- `appBundleId`、`productName`、`userData`和`sessionData`路径不变。
- 应用版本使用语义版本，`CFBundleVersion`每次构建递增。
- 打开数据库前比较应用支持的模式版本和数据库版本。
- 升级迁移前执行在线备份，校验成功后才迁移。
- 迁移失败进入只读恢复界面，不开始采集。
- 旧应用打开新模式数据库时拒绝写入，不执行降级迁移。
- 替换`.app`前必须完全退出，不能在进程运行时覆盖包内容。
- 新版本首次启动必须解密原有HMAC键，并验证同一测试用户的本地标识没有变化。

## 卸载和数据保留

Apple的[卸载应用说明](https://support.apple.com/en-us/HT202235)指出，删除应用不会删除用户用该应用创建的文档或其他文件。对于没有单独卸载器的应用，用户退出后把`.app`移到废纸篓即可。

第一版采用保留数据策略：

- 删除`/Applications/弹幕看板.app`只移除程序，不移除历史。
- 重新安装相同`appBundleId`和`productName`的应用后，继续读取原数据库。
- `Application Support`、`Logs`、`Caches`和可能存在的Keychain条目不会随`.app`自动删除。

如果用户明确要求完全移除本地数据，应先正常退出应用，再手工删除以下精确目录：

```text
~/Library/Application Support/弹幕看板/
~/Library/Logs/弹幕看板/
~/Library/Caches/com.songjinzhao.danmaku-dashboard/
```

删除这些目录会永久删除历史、备份、设置和HMAC密文。Keychain中可能留下无法单独使用的应用加密键；`safeStorage`没有删除该键的公开API，不应通过猜测条目名称自动修改用户钥匙串。

## 菜单栏和退出生命周期

[Electron Tray指南](https://www.electronjs.org/docs/latest/tutorial/tray)说明，应用要在窗口关闭后保留菜单栏图标，需要监听`window-all-closed`并阻止默认退出；Tray对象还必须由主进程保留强引用。

第一版按现有进程规格执行：

- 点击窗口关闭按钮时，若没有进入退出流程，取消关闭并隐藏窗口。
- `window-all-closed`不调用`app.quit()`。
- Dock激活、第二实例启动或菜单栏中的显示看板都显示现有窗口，窗口已销毁时安全重建。
- 菜单栏中的停止采集只结束采集会话，不退出应用。
- 菜单栏退出、`Cmd+Q`、Dock退出和系统正常终止都进入同一个`QuitCoordinator`。

[Electron app生命周期文档](https://github.com/electron/electron/blob/v43.2.0/docs/api/app.md)说明：

- `before-quit`可以通过`preventDefault()`暂缓退出。
- `app.quit()`会先触发`before-quit`，随后关闭窗口并触发`will-quit`。
- `app.exit()`立即退出，不触发`before-quit`和`will-quit`。

实现中使用三态退出门：

```text
idle -> draining -> permitted
```

规则如下：

1. `idle`收到退出请求时，如有活动采集先确认。
2. 确认后进入`draining`，停止接收新IPC和上游事件，刷新有界队列，结束会话，关闭reader及writer。
3. 10秒内完成时进入`permitted`并再次调用`app.quit()`。
4. `permitted`状态的`before-quit`不再阻止退出。
5. 10秒仍未完成时保留SQLite中的活动会话，使用`app.exit(1)`结束。下次启动将它标记为异常中断，不能伪造成正常退出。

关闭主窗口不属于退出应用，不能进入以上流程。

## 可重复构建与验收

可重复表示相同锁文件、相同源代码和相同命令能持续生成通过验收的产物，不承诺DMG字节级哈希完全相同。DMG元数据和时间戳可能改变最终SHA-256。

### 构建

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

构建环境记录：

- Git提交。
- `package-lock.json`校验值。
- Node.js版本。
- Electron版本。
- Forge版本。
- macOS版本和架构。

### 静态产物检查

设`APP_PATH`为Forge生成的`弹幕看板.app`，`DMG_PATH`为`out/make`下唯一的`.dmg`：

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

验收值：

- 主可执行文件只有`arm64`。
- `CFBundleIdentifier`为固定值。
- `CFBundleShortVersionString`和`CFBundleVersion`正确。
- `LSMinimumSystemVersion`为`13.0`。
- `codesign`验证成功，显示ad-hoc签名，没有TeamIdentifier。
- DMG校验成功。

执行：

```bash
spctl --assess --type execute --verbose=4 "$APP_PATH"
```

预期返回失败，因为第一版没有Developer ID和公证。该失败用于确认发行边界，不是构建失败。

### 安装和首次运行

1. 挂载DMG。
2. 把`.app`拖到`/Applications`。
3. 从`/Applications`打开，不从DMG内长期运行。
4. 确认只启动一个实例。
5. 确认创建预期数据目录，没有在`.app`或项目目录产生数据库。
6. 确认主窗口和菜单栏图标同时存在。
7. 关闭窗口，确认应用和采集继续运行。
8. 从Dock或菜单栏恢复窗口。
9. 从菜单栏退出，确认writer在10秒内关闭且会话正常结束。

### `node:sqlite`产物探测

探测必须在打包应用中运行，保存脱敏结果：

- `process.versions.electron`
- `process.versions.node`
- `SELECT sqlite_version()`
- `PRAGMA compile_options`
- FTS5`trigram`建表、插入、中文子串查询和删除
- WAL读写
- `sqlite.backup()`和备份`quick_check`
- writer及reader worker各自打开连接

该探测通过后，才能删除原生SQLite驱动的回退任务。

### 升级

1. 用版本A创建历史和已知测试用户本地标识。
2. 正常退出版本A。
3. 用版本B替换`/Applications`中的`.app`。
4. 启动版本B，完成备份和迁移。
5. 验证历史、设置、HMAC键和测试用户本地标识保持不变。
6. 验证版本A再次打开时拒绝写入更高模式数据库。

### 异常恢复

1. 开始脱敏合成采集。
2. 确认会话为`active`并至少写过一个检查点。
3. 强制终止主进程。
4. 重新启动。
5. 验证原会话变为`interrupted`，结束原因为`process_interrupted`，应用不自动重连原直播间。

### 卸载与保留

1. 正常退出。
2. 把`.app`移到废纸篓。
3. 确认历史目录仍存在。
4. 重装同版本并确认历史可读。
5. 正常退出后手工删除三个项目目录。
6. 再删除`.app`，确认程序和本地数据都已清理。

## 必须在实现阶段验证的剩余项

以下内容已有明确判定规则，但不能只靠文档关闭：

1. Electron 43.2.0打包产物中的`node:sqlite`、FTS5、`trigram`和在线备份实测。
2. `safeStorage`在两个不同ad-hoc构建版本之间的解密连续性和钥匙串提示行为。
3. 当前macOS 26.5.1上本地产物、挂载DMG产物和带下载隔离属性产物的首次打开差异。
4. Forge 7.11.2在仅安装Command Line Tools的当前机器上完成ad-hoc签名和DMG生成；若失败，再安装完整Xcode。
5. 一场100万事件数据库升级时，在线备份、迁移和首次启动耗时。

这些验证应安排在正式功能大量开发前完成，失败处理如下：

| 失败项 | 处理 |
| --- | --- |
| `node:sqlite`运行时能力不足 | 暂停存储实现，新增驱动选择ADR并重新执行完整产物探测 |
| `safeStorage`跨版本解密失败 | 阻止发布，按本地HMAC键章节的规则形成ADR，不静默降级 |
| 隔离产物打开行为与文档不符 | 以当前macOS实测更新安装说明，仍不绕过或全局关闭Gatekeeper |
| Command Line Tools不能完成构建 | 安装完整Xcode后重测，并把构建机前置条件写入发布清单 |
| 百万事件备份或迁移超出发布阈值 | 优化迁移或调整迁移策略后重测，不能跳过备份和完整性检查 |
