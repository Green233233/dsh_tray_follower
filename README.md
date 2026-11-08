# dsh_tray_follower

在 DeepSeek Harness（DSH）**托盘图标**中显示各工作区正在运行的对话与状态，并在 DSH 最小化 / 失焦时，
由 **DSH 应用本身**（Electron 主进程 `Notification`，显示为 DeepSeek Harness）发出系统通知，
提醒「需要人工介入」或「任务已完成 / 已停止」。

> 通知要求：**以 DSH 本应用名义发出，不使用外部 PowerShell 发通知**。本实现只有 Electron 主进程内的
> `new Notification(...)` 一条通知通道，插件不调用任何外部通知进程。

> GitHub: <https://github.com/Green233233/dsh_tray_follower> · 发布包：<https://github.com/Green233233/dsh_tray_follower/releases/download/v0.2.0/dsh-tray-follower-0.2.0.tgz>

## 功能

- **托盘菜单扩展**：右键 DSH 托盘图标，原「打开 / 退出」之外出现：
  - 全局摘要 `对话：N 运行 / M 待处理`；
  - 每个工作区一个子菜单：`📁 <工作区名>  运行 N · 待处理 M`，内含按优先级排序的会话行
    （`⏸` 等待批准/选择/输入 → `▶` 运行中 → `✓` 已完成 / `✖` 失败，最多 6 行 + 溢出提示）；
  - **空闲对话默认不显示**（托盘菜单只列真正在工作的对话；可在设置里重新打开）；
  - 点击任意会话行可把 DSH 窗口显示并聚焦。
- **原生设置页**：DSH **设置 → 托盘跟随**（`settings.section`，由插件 Client 半注册）：
  - 「托盘右键菜单」：显示空闲对话、每工作区最大行数（1–20）、顶部计数、版本页脚；
  - 「通知」：完成通知、失败通知、需要人工介入通知、前台时静默、提示音。
  - 设置是 Host `Config`（`.volatile()`），保存后 ≤1 秒生效，**无需重启 DSH**。
- **系统通知**：当 DSH 窗口隐藏/最小化/失焦时，对未读事件发原生通知（点击通知聚焦窗口）：
  - `needs-attention`：需要你批准 / 选择 / 输入；
  - `completed`：会话完成目标 / 结束工作；
  - `failed`：会话失败。
  - 窗口聚焦时不打扰（可关闭）；首次运行静默基线，不会回放历史事件；事件去重 + 限流；超过 10 分钟的旧事件不提醒。
- **状态采集**：Host 插件订阅 DSH 的 `agent/status`、`session/event`、`approval/request`、
  `user-questions/request`、`agent/error` 等事件，按 `workspaceRegistry` 分组，7 种状态
  （running / waiting-approval / waiting-choice / waiting-input / completed / failed / idle），
  原子写入状态文件（契约见 [docs/DESIGN.md §4 / §4.1](docs/DESIGN.md)）。
- **可上架市场**：`scripts/build-market-package.mjs` 产出单包 npm 发布物（Host + Client + 桥接载荷 +
  安装脚本），`marketplace/` 提供市场索引条目、awesome-dsh-plugin 条目模板与发布清单。

## 仓库结构

```
packages/dsh-tray-follower/   DSH 插件本体（Host half + Client 设置页，通过 plugin_manager 安装）
bridge/shell-hook/            Electron 主进程钩子：托盘菜单接管 + 原生通知
bridge/injector/              Node Inspector 注入器（launcher / inject / CDP / tray adoption）
bridge/launcher/              隐藏窗口启动器（VBS + PS1）
marketplace/                  上架物料：npm README、市场索引条目、awesome 条目、发布清单、验证清单
scripts/build-market-package.mjs  构建单包 npm 发布物（dist/）
tools/                        安装/卸载、隔离 E2E 探针、自检、asar 调研工具
docs/                         设计（DESIGN）、验证记录（VERIFICATION）、调研（recon/）
```

## 安装

### 1. DSH 插件（已在本机安装）

```powershell
# 在 DSH 里通过插件管理器安装（本仓库的 packages 目录为本地链接安装）
# 等价 CLI（在仓库根目录、且 dsh 在 PATH 时）：
dsh plugin --profile desktop add https://github.com/Green233233/dsh_tray_follower/releases/download/v0.2.0/dsh-tray-follower-0.2.0.tgz
```

安装后插件即开始写 `%LOCALAPPDATA%\dsh-tray-follower\state.json`；无桥接时**只发布状态、不发通知**。

### 2. 桌面桥接（托盘菜单 + 通知）

```powershell
# 预览将要做什么（不修改任何文件）
node tools/install-bridge.mjs

# 正式安装：拷贝 app 载荷到 %LOCALAPPDATA%\dsh-tray-follower\app，
# 备份并把 DSH 的开始菜单/桌面/任务栏快捷方式指向隐藏启动器
node tools/install-bridge.mjs --apply
```

安装后**完全退出 DSH**（托盘图标右键 → 退出），再从开始菜单/桌面快捷方式启动，即可看到扩展后的托盘菜单。
原因是：托盘接管需要 DSH 启动时带 `--inspect` 注入，桥接无法注入已经启动的进程。

### 卸载

```powershell
node tools/uninstall-bridge.mjs          # 预览
node tools/uninstall-bridge.mjs --apply  # 还原快捷方式（字节级备份）、移除 app 载荷
```

## 验证

- 插件单元测试：`node --test "packages/dsh-tray-follower/test/*.test.mjs"` → 74/74
- 桥接自检：`node tools/bridge-selftest.mjs` → 67/67
- 全仓检查：`node tools/check.mjs`
- 隔离实例 E2E（不动当前 DSH）：`node tools/probe-electron-hook.mjs --execute` → **PASS**
  （证据：hook 注入、托盘接管、v2 options 生效、**空闲对话不出现**、菜单内容、原生通知通道、干净退出；
  详见 [docs/VERIFICATION.md](docs/VERIFICATION.md)）
- 构建可发布包：`node scripts/build-market-package.mjs` → `dist/dsh-tray-follower/`（`npm pack` 校验通过）

## 上架市场

```powershell
node scripts/build-market-package.mjs            # 产出 dist/ 单包发布物 + pack 校验报告
# 之后按 marketplace/PUBLISHING.md 执行 npm publish 与 awesome-dsh-plugin PR；
# 市场索引条目见 marketplace/market-index-entry.json，awesome 条目见 marketplace/awesome-plugin-entry.json
```

构建产物是一个自包含 npm 包：Host 插件 + Client 设置页 + 桥接载荷（shell-hook / injector / launcher）+
`scripts/install-bridge.mjs`（`dsh-tray-follower-bridge` bin）。用户安装插件后，只需运行一次
`npx dsh-tray-follower-bridge --apply` 再重启 DSH，即可获得托盘扩展与通知；也可只用通知/设置部分。

## 已知限制

- **桥接只能在 DSH 启动时注入**：直接双击 `DeepSeek Harness.exe`（未经启动器）不会扩展托盘；
  此时不会有任何系统通知（按需求不使用外部通知进程），插件仅发布状态。
- DSH 已在运行时再点快捷方式：只会聚焦已有窗口，并弹提示“请先完全退出 DSH 再从快捷方式启动”
  （因为无法给已启动的进程注入）。
- DSH 自动更新可能重建开始菜单快捷方式；更新后重新执行一次 `node tools/install-bridge.mjs --apply`。
- 通知依赖 Windows 通知中心：系统「勿扰模式」或关闭 DeepSeek Harness 通知权限时不会显示。
- 注入使用仅回环地址的 Node Inspector，注入完成后立即关闭该端口；不修改 DSH 安装文件、不改系统环境变量。
- 点击托盘会话行目前只聚焦 DSH 主窗口（DSH 未提供公开的会话深链 API）。

## 开发约定

见 [AGENTS.md](AGENTS.md)（提交规范、写作用域、验证基线）。设计决策与调研证据：
[docs/DESIGN.md](docs/DESIGN.md)、[docs/recon/NOTES.md](docs/recon/NOTES.md)、
[docs/recon/HOST-API.md](docs/recon/HOST-API.md)。
