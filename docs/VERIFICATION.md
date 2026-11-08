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

单元测试：`node --test "packages/dsh-tray-follower/test/*.test.mjs"` → **74/74 通过**（2026-11-08，含 v0.2.0 settings/client 测试）。
`node --check` 覆盖全部 JS。

> v0.2.0 更新：Host 半现在提供 `Config` schema（9 个 `.volatile()` 字段），`state.json` 升级为
> `schemaVersion: 2` 并带 `options`；Client 半注册「设置 → 托盘跟随」页面。详见 §6。

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
| 通知 — 需要人工介入（真实实例） | **PASS**；2026-11-08 08:27:11 用户将 DSH 最小化后触发一次提问，`bridge.log` 记录 `notification-shown {"kind":"single","title":"需要你的操作"}` + `notification-batch {"shown":1,"focused":false,"visible":false}`，用户反馈「收到通知（我从通知点回来的）」，窗口被通知点击恢复（可见、非最小化、前台=DSH） |
| 通知 — 正在看 DSH 时不打扰 | PASS；08:21:09 完成事件在窗口聚焦时记录 `notification-suppressed {"reason":"focused","count":1}` |
| 通知 — 完成/停止（真实实例） | 与上同一 Electron Notification 通道、同一策略（`kind=completed`）；隔离 E2E 已验证 `notification-shown` 路径，真实实例的完成事件在聚焦时按设计被抑制 |

### 4.1 真实验证中发现并修复的缺陷

**现象**：第一次真实通知测试时用户没有收到通知，`bridge.log` 无任何 notification 记录。

**根因**：Host 插件为 `needs-attention` 事件生成 id 时使用 `stableEventId('attention', sessionId, kind, occurrence)`，其中 `occurrence` 是**进程内**自增计数器。DSH 重启（或插件重新加载）后计数器从 1 重新开始，同一会话的下一次等待会生成与上次完全相同的 id；bridge 的持久化 `seenEventIds` 已包含该 id，于是事件被当成“已读”直接丢弃，通知被静默吞掉。

**修复**：`packages/dsh-tray-follower/lib/tracker.js#publishAttention` 的 id 加入 `wait.at`（等待创建的真实时间戳，同一等待重发时稳定，跨重启必不相同），并新增回归测试 `attention ids stay unique across a Host restart (occurrence counter resets)`；插件通过插件管理器 bundle 关闭/开启完成热重载，无需重启 DSH。修复后新事件 id 为 `evt_54b43d150277886142b7`（与旧 id 不同），通知正常弹出。

## 5. 已执行的安全/回滚检查

- `tools/install-bridge.mjs` / `tools/uninstall-bridge.mjs` 默认 dry-run（不修改任何文件），`--apply` 才执行；
  原 `.lnk` 做字节级备份，卸载时原样恢复（已实测 dry-run 计划正确）。
- 注入器只绑定 `127.0.0.1` 并使用可用端口；注入完成后调用 `node:inspector.close()` 关闭端口。
- 未修改 DSH 安装目录、未改系统/用户环境变量。
- 桥接未安装/注入失败时行为：启动器以普通模式重新拉起 DSH（不阻塞用户使用），不启动任何外部通知进程。

## 6. v0.2.0 功能验证（托盘菜单设置 + 通知设置 + 空闲对话隐藏 + 上架物料）

### 6.1 代码与自检（本机实测）

| 检查项 | 结果 |
|---|---|
| 插件测试 | `node --test "packages/dsh-tray-follower/test/*.test.mjs"` → **74/74 PASS**（含 settings 13 项、client 6 项） |
| 桥接自检 | `node tools/bridge-selftest.mjs` → **67/67 PASS**（含 idle 隐藏默认、showIdle=true 子菜单、options 行数/页脚/计数、通知 kind 过滤、suppressWhenFocused=false、silent 标志） |
| 全仓检查 | `node tools/check.mjs` → all checks passed |
| 隔离实例 E2E | `node tools/probe-electron-hook.mjs --execute` → **PROBE RESULT: PASS**；证据含 `contract-v2 tray defaults applied`、`idle conversations hidden by default (no idle rows, no 空闲会话 submenu)`、header `对话：1 运行 / 1 待处理`、footer `dsh-tray-follower v0.2.0`、`notification-shown`（Electron 主进程） |
| 市场发布物 | `node scripts/build-market-package.mjs` → `dist/dsh-tray-follower/`（50 files，`npm pack` 92.4 KiB / 50 entries，`node --check` 通过；report `ok:true`） |

### 6.2 本机 live 安装验证（Host Config + Client 设置页）

安装/重载方式：`plugin_manager set_bundle dsh-tray-follower` 关闭再开启（应用 `applied`，无需重启 DSH）。

| 检查项 | 结果与证据 |
|---|---|
| 状态契约 v2 | PASS；重载后 `state.json` 立即变为 `schemaVersion: 2`，`options` 与契约默认值完全一致（`showIdle:false, maxSessionsPerWorkspace:6, showHeaderCounts:true, showFooter:true`；通知 5 项均 true） |
| Host Config schema | PASS；`cordis_inspect_query Config.listConfigs` → entry `include:dsh-tray-follower`，`status: "schema"`，9 个字段全部 `x-cordis.volatile: true`，中英双语 description，number 字段 `minimum:1, maximum:20` |
| Client 设置页注册 | PASS；`cordis_inspect_query client Slots.listSubTree root=settings.section` → occupants 含 `{id:"tray-follower", order:30, active:true}`（与 cost-meter 同为 order 30，居中排布） |
| Client→Host 设置写入（真实用户操作） | **PASS**；用户在真实设置页点击开关后，`state.json.options.tray.showFooter` 由默认 `true` 变为 `false`（`updatedAt` 同步刷新），证明 设置页 → Config → state.json 的实时链路已跑通；用户同时反馈开关响应偏慢、可读性一般，已安排 UI 优化（乐观更新 + 排版重做） |
| 设置页 UI 复检（真实用户） | **PASS**；乐观更新 + 排版重做后重新热加载，用户复检反馈「开关即时响应，排版也清晰」，并再次操作开关成功（`state.json` 持续写入 `schemaVersion:2` + `options`，Client 槽位 `tray-follower` 仍 active） |
| 桥接日志可观测性 | PASS；v0.2.0 的 `menu-rebuilt` 日志新增 `showIdle` / `maxSessionsPerWorkspace` / `displayedSessions` 字段，重启后可直接从 `bridge.log` 验证“空闲对话未出现在菜单” |
| 真实数据 → v0.2.0 菜单渲染（无需重启） | **PASS**；用桥接 `readStateFile()` 读取当前真实 `state.json`（2 工作区 / 6 会话 / 其中 4 个 idle）再走 `buildStatusSection()`：header `对话：2 运行 / 0 待处理`、仅 2 条运行会话行、`idle-group` 0 条、空闲会话行 0 条；`showIdle:false`、`showFooter:false`（用户设置）均生效，输出中无页脚。即真实数据在新逻辑下不会出现空闲对话（该进程重启后生效） |
| 构建/载荷一致性（sha256） | PASS；dist/dsh-tray-follower 的 client.js/index.js/lib/settings.js 及 bridge 关键文件与源文件 sha256 一致；已安装载荷 pp/shell-hook/{bridge,menu-model,state,notify-policy}.cjs 与仓库一致；pm pack 96,125 bytes / 50 files（仅 repository 占位符警告，属发布前填写项） |
| 桥接载荷更新 | PASS；`node tools/install-bridge.mjs --apply` 重新安装 v0.2.0 载荷到 `%LOCALAPPDATA%\dsh-tray-follower\app`（shell-hook/injector/launcher + install.json），开始菜单快捷方式保持指向启动器、桌面快捷方式 already |
| 待重启确认 | **未验证（需用户重启 DSH）**：当前运行的桥接仍是 v0.1.0 进程内代码，托盘菜单要等 DSH 从快捷方式重启后才会应用 v0.2.0 的“空闲对话默认隐藏 + 设置即时生效”；`bridge.log` 目前记录 `schemaVersion 2 is not 1; parsed best-effort`（旧桥接对 v2 的兼容告警），重启后应消失 |

### 6.3 上架物料

`LICENSE`、`CHANGELOG.md`、`marketplace/{package-readme.md, awesome-plugin-entry.json, market-index-entry.json, PUBLISHING.md, VALIDATION.md}`、`scripts/build-market-package.mjs` 均已就绪；发布需 npm 凭据与 awesome-dsh-plugin PR（本机不执行），步骤见 `marketplace/PUBLISHING.md`。
