---
title: 核实Apple Silicon打包与本地数据路径
status: closed
label: wayfinder:research
assignee: codex
parent: ../map.md
blocked_by: []
closed_at: 2026-07-29
---

## Question

Electron应用在当前Apple Silicon和macOS版本上应如何生成未签名的`.app`与`.dmg`；数据库、随机盐、脱敏日志和崩溃恢复标记应放在哪里；首次打开、应用升级、卸载、数据保留和菜单栏退出需要哪些明确规则，才能形成可重复的本机构建与验收流程？

## Resolution

第一版采用Electron 43.2.0与Electron Forge 7.11.2，只生成`darwin-arm64`产物：

- 未签名发行版定义为没有Developer ID和公证，但`.app`内部由Forge完成ad-hoc签名；DMG不签名。
- Bundle ID固定为`com.songjinzhao.danmaku-dashboard`，最低系统为macOS 13.0。
- 业务数据保存到`~/Library/Application Support/弹幕看板/app-data/`，Chromium缓存与日志分别放入系统Caches和Logs目录。
- 32字节HMAC键经`safeStorage`异步加密后落盘，跨ad-hoc版本解密连续性是发布硬门槛。
- SQLite活动会话和检查点是唯一崩溃恢复标记；第一版不启动可能包含敏感内存的`crashReporter`。
- 关闭窗口只隐藏，所有真正退出入口由统一协调器在10秒内停止采集、刷新存储并关闭worker。
- 替换应用升级不动数据；普通卸载默认保留历史，完全删除需要清理三个明确目录。
- 构建验收覆盖arm64、Info.plist、ad-hoc签名、DMG、Gatekeeper预期失败、安装、升级、恢复和数据保留。

本机已确认`arm64`、macOS 26.5.1、Node.js 24.14.1、Command Line Tools、`codesign`与`hdiutil`可用，并从npm官方注册表核实锁定版本。一次性完整烟测因Electron官方压缩包经当前本地代理下载过慢而停止，因此`.app`、DMG、`node:sqlite`产物能力与`safeStorage`跨版本连续性保留为编码第一阶段的硬验收，不把未完成下载误记为通过。

规范见[macOS打包与本地数据规格](../../spec/macos-packaging-and-local-data.md)，官方证据与失败判定见[Apple Silicon本地打包与数据目录调研](../../research/macos-packaging-2026-07-29.md)。
