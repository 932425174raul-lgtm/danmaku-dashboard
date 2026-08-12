# Windows x64打包与本地数据规格

## 目标与边界

弹幕看板在保留现有Apple Silicon macOS版本的同时，新增Windows 10和Windows 11的x64便携版。Windows产物是包含完整应用目录的ZIP，用户解压后运行`弹幕看板.exe`。

第一个Windows版本不提供ARM64、32位、MSI或Squirrel安装器，不做代码签名、自动更新和Microsoft Store发布。ZIP内文件必须保持在同一目录，不支持只单独复制EXE。

## 运行时要求

- macOS和Windows使用同一套Electron主进程、采集器、SQLite Worker、IPC和React界面，不复制业务实现。
- 窗口关闭后不结束采集，应用留在系统托盘。托盘菜单可以重新显示窗口、停止采集或退出。
- B站与抖音的桌面请求标识根据实际运行系统生成，Windows不能冒充macOS。
- Windows上的系统托盘图标使用EXE内嵌的应用图标，macOS继续使用模板图标。

## 本地数据

Windows使用Electron的`userData`目录保存SQLite数据库和加密后的本地用户去重密钥。默认位置为`%APPDATA%\弹幕看板\`。Chromium会话数据放在`userData`下的`Chromium`子目录，不使用macOS的`~/Library/Caches`路径。

Windows上的Electron `safeStorage`使用DPAPI保护本地密钥密文。数据不会在macOS与Windows之间自动迁移，也不会上传。

## 构建与产物

| 平台 | 命令 | 架构 | 产物 |
| --- | --- | --- | --- |
| macOS | `npm run make:mac` | `darwin-arm64` | `.app`与DMG |
| Windows | `npm run make:win` | `win32-x64` | 应用目录与ZIP |

Forge在两个平台都只打包`.vite`构建输出。Electron Fuses保持一致，禁用Run As Node、`NODE_OPTIONS`和调试入口，只允许从asar加载应用。

## 自动验收

- AC-1：桌面请求标识在`darwin`和`win32`上生成对应的macOS或Windows x64 User-Agent，不支持的平台明确失败。
- AC-2：生产模式的`sessionData`在macOS使用现有Caches目录，在Windows使用`userData/Chromium`，验证和性能模式继续使用临时目录。
- AC-3：`npm run make:win`生成x64 PE可执行文件和ZIP，可执行文件包含项目图标，asar只包含构建输出。
- AC-4：`npm run test:package:win`检查PE架构、主进程、preload、双Worker、renderer、全部Electron Fuses和ZIP结构；在Windows上还必须执行`--verify-runtime`与两万条smoke基准。
- AC-5：GitHub Actions在`windows-latest`上从锁文件安装依赖，执行快速验证、Windows打包和产物验收，然后上传ZIP。

## 人工验收

发布Windows版本前，需在真实Windows 10或Windows 11 x64设备上完成：

1. 解压ZIP并启动`弹幕看板.exe`。
2. 连接一个当时正在直播的公开B站房间，确认弹幕、看板和历史正常。
3. 关闭主窗口，确认采集继续且系统托盘可重新打开窗口。
4. 退出并重启，确认历史保留、异常会话标记正确。
5. 记录Windows版本、应用版本、ZIP SHA-256和SmartScreen首次打开行为。
