# 验证记录（dsh-tray-follower）

> 原则：只写实测得到的证据；未实测的项明确写“未验证”。

## 0. 环境

- DSH Desktop `@deepseek-ai/dsh-desktop` 0.2.2-rc.1（Electron 44.7.0 / Node 24.21.0 / Chrome 152）
- Windows 11（中文），包装安装于 `C:\Users\Green\AppData\Local\Programs\DeepSeek Harness`
- 仓库 commit：见 `git log`；验证脚本版本见各文件头

## 1. 插件 Host 半（本机 live 验证，非模拟）

安装方式：`plugin_manager install_bundle`（target = `packages/dsh-tray-follower` 绝对路径），返回
`application: "applied"`，bundle `dsh-tray-follower@0.1.0`。

证据：

- 运行中的 Host 进程（pid 变化后会重建）持续写出
  `%LOCALAPPDATA%\dsh-tray-follower\state.json`；
- `cordis_inspect_query` → `Config.listConfigs name=dsh-tray-follower` 返回 entry
  `include:dsh-tray-follower`，schema `absent`（插件无 Config，符合设计）；
- state.json 内容与真实工作区一致（示例：2 个 workspace；`dsh_tray_follower` 下本会话
  `status: "running"`、`detail: "正在执行 pwsh"`；default-workspace 下 4 个 idle 会话）；
- `updatedAt` 每 5 s 刷新（Host 存活信号）；
- `unreadEvents` 在会话完成时出现 `kind: "completed"` 事件（真实 turn 结束触发，已验证一次）。

单元测试：`node --test "packages/dsh-tray-follower/test/*.test.mjs"` → **51/51 通过**（2026-11-08）。
`node --check` 覆盖全部 JS。

## 2. 桥接层（隔离实例 E2E，已 PASS）

命令：

```powershell
node tools/probe-electron-hook.mjs --execute --keep
```

隔离措施：`--user-data-dir=<temp>`、`DSH_HOME=<temp>`、`DSH_TRAY_FOLLOWER_DIR=<temp>`，
子进程环境删除 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `ELECTRON_NO_ATTACH_CONSOLE`；
不触碰正在运行的 DSH。

实测结果（2026-11-08 08:06，Electron 44.7.0）：

| 检查项 | 结果与证据 |
|---|---|
| inspector 注入 | PASS；spawn 后 219 ms 出现 CDP 目标，hook 注入成功（`patched=true`） |
| 托盘接管 | PASS；`Runtime.queryObjects(Tray.prototype)` 找到 2 个实例，adopt 1 个 |
| 菜单重建 | PASS；`menu-rebuilt` 诊断包含：header `对话：1 运行 / 1 待处理`、`📁 探针工作区 A  运行 1 · 待处理 1`、`⏸ 等待批准的对话`、`▶ 运行中的对话`、`✓ 已完成的对话`、`📁 Probe Workspace B  运行 0 · 待处理 0`、`空闲会话 (1)`、`○ 空闲对话`、footer `dsh-tray-follower v0.1.0` |
| 原有菜单保留 | PASS；`打开 DeepSeek Harness | [separator] | 退出 DeepSeek Harness` |
| 通知通道 | PASS；`provider=electron-main-process`、`Notification.isSupported()=true`、`notification-shown` 证据（自检通知由 Electron 主进程发出，无外部进程） |
| 干净退出 | PASS；通过 inspector 调 `app.exit(0)`，进程树清理 |

证据文件：`%TEMP%\dsh-tray-follower-e2e-*\logs\probe-evidence.log`、`.../state/bridge.log`（`--keep` 时保留）。

## 3. 桥接安装与启动链路（已安装，实测链路通过）

安装命令：

```powershell
node tools/install-bridge.mjs --apply
```

结果（2026-11-08 08:13）：

| 检查项 | 结果 |
|---|---|
| app 载荷 | PASS；`%LOCALAPPDATA%\dsh-tray-follower\app\{shell-hook,injector,launcher}` + `install.json` |
| 开始菜单快捷方式 | PASS；target=`wscript.exe`，args=`"...\app\launcher\launch-bridge.vbs" "...\dsh-tray-follower"`，原文件备份至 `backup\shortcuts\01-DeepSeek Harness.lnk` |
| 桌面快捷方式 | PASS；同上，备份 `backup\shortcuts\02-DeepSeek Harness.lnk` |
| 任务栏固定项 | 本机无 DSH 任务栏固定项，无需处理（安装器会处理存在的 `User Pinned\TaskBar` 快捷方式） |
| 可逆性 | PASS；`node tools/uninstall-bridge.mjs`（dry-run）正确列出两条快捷方式还原计划与 app 载荷删除计划 |
| 启动链路（DSH 已运行时） | PASS；直接运行 VBS → PS1（隐藏）→ `launch.mjs`，正确识别已运行主进程 pid=14136、写 `injector.log`（`already-running`）、以普通模式拉起实例聚焦已有窗口，未产生多余常驻进程，弹出“请先完全退出 DSH”提示 |

## 4. 真实运行实例（已注入，用户在真实托盘上点击验证过）

用户完全退出 DSH 后，用替换后的快捷方式重启（2026-11-08 08:15）。实测证据：

| 检查项 | 结果 |
|---|---|
| 启动参数 | PASS；主进程命令行含 `--inspect=127.0.0.1:9531`（启动器注入），pid 19012 |
| 注入器日志 | PASS；`injector.log` 记录 inspector-target 174ms、hook-injected（patched=true）、trays-adopted（count=2, adopted=1）、hook-finalized、inspector-closed |
| 桥接日志 | PASS；`bridge.log` 记录 `hook-loaded`、`tray-patch`、`cursor-loaded`（首次基线 1 条）、`app-ready`、`tray-captured`（原菜单：打开/分隔线/退出）、`tray-adopted`、`menu-rebuilt` |
| 菜单随真实数据刷新 | PASS；`menu-rebuilt` 持续出现，真实数据从 workspaces=1/sessions=5 → workspaces=2/sessions=4/running=2 变化，`applied:1` 无错误 |
| 真实托盘点击（用户操作） | PASS；`bridge.log` 记录两次 `window-focused {"actions":["focus"]}` + `focus-request {"reason":"tray-session","ok":true}`（08:18:20、08:20:15），说明用户右键托盘后点击了会话行，桥接成功聚焦 DSH 窗口 |
| 安全收尾 | PASS；`inspector-close-scheduled` → `inspector-closed`（9531 端口已不可连接）；心跳 `bridge.json` 每 5s 刷新 |
| 通知（真实实例） | 待验证：需 DSH 最小化/失焦时出现新的完成或需要人工事件；当前用户一直聚焦 DSH，桥接按设计不打扰。下次轮次检查 `bridge.log` 的 `notification-shown` / `notification-suppressed` 即可确认 |

## 5. 已执行的安全/回滚检查

- `tools/install-bridge.mjs` / `tools/uninstall-bridge.mjs` 默认 dry-run（不修改任何文件），`--apply` 才执行；
  原 `.lnk` 做字节级备份，卸载时原样恢复（已实测 dry-run 计划正确）。
- 注入器只绑定 `127.0.0.1` 并使用可用端口；注入完成后调用 `node:inspector.close()` 关闭端口。
- 未修改 DSH 安装目录、未改系统/用户环境变量。
- 桥接未安装/注入失败时行为：启动器以普通模式重新拉起 DSH（不阻塞用户使用），不启动任何外部通知进程。
