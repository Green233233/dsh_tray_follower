# DSH Desktop 调研记录

> 证据来源：安装目录 `C:\Users\Green\AppData\Local\Programs\DeepSeek Harness\`。
> 提取的第三方代码在 `docs/recon/extracted/`（gitignore，不提交）。
> 提取方法：`node tools/extract-asar.mjs <app.asar> <outDir> <regex>...`（自行解析 asar 头，不需要 Electron）。

## 1. 应用结构

| 事实 | 证据 |
|---|---|
| Desktop 应用 = Electron 壳 `@deepseek-ai/dsh-desktop` 0.2.2-rc.1 | `app.asar/package.json`（`main: lib/main.js`） |
| Electron 主进程 bundle 为 `app.asar/lib/main.js`（约 838 KB，含所有壳层模块） | 扫描结果 |
| 壳层把 DSH runtime 作为**子进程**启动（`@deepseek-ai/dsh-desktop-host`），通过 `process.send` IPC 通信 | `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` |
| Host 子进程只接受固定 IPC：`starting`/`ready`/`shutdown`/`file-drag-*`/`quit-inspection`/`update-tasks`/`plugin-operation`/`platform-session`/`fatal` | 同上，及 `lib/main.js` 中 `message.type` 分支 |
| DSH Web GUI 由 Host 的 web server 提供，地址经 `ready` 消息回传壳层 | desktop-host `lib/index.js` 末尾 |
| 安装目录的托盘图标资源：`resources/tray.ico` | `resources/` 列表 |

## 2. 托盘实现（关键结论）

`app.asar/lib/main.js` 的 `//#region lib/types/tray.js`（约 19801–19846 行）：

```js
var DesktopTray = class {
  constructor(options) { const tray = new Tray(nativeImage.createFromPath(options.iconPath)); ... this.relabel() }
  relabel() {
    tray.setToolTip(messages.aboutProduct)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: messages.openApplication, click: () => this.options.open() },
      { type: 'separator' },
      { label: messages.quitApplication, click: () => this.options.quit() },
    ]))
  }
  dispose() { this.tray?.destroy() }
}
```

- 创建位置约 21018–21032 行：仅 `win32` 创建，`trayIconPath = process.resourcesPath/tray.ico`；`open` → `focusPrimaryWindow()`；`quit` → `app.quit()`。
- **没有** 任何插件/配置扩展托盘的入口；菜单模板是硬编码的。
- 修改 `app.asar` 不可取：会被自动更新覆盖，且属于修改安装目录。

## 3. 可用的注入点

`resources/DeepSeek Harness.exe` 的 Electron fuse（REA `inspect_electron_fuses` 实测）：

| fuse | 状态 |
|---|---|
| RunAsNode | enabled |
| EnableNodeOptionsEnvironmentVariable | **enabled** |
| EnableNodeCliInspectArguments | enabled |
| EnableEmbeddedAsarIntegrityValidation | **disabled** |
| OnlyLoadAppFromAsar | disabled |

→ Electron 主进程会读取 `NODE_OPTIONS`，Node 的 `--require` 预加载模块会在入口 `lib/main.js` 之前执行。这是不改安装文件的注入点。**待实测**：用子进程启动一次 DSH Desktop 验证 `--require` 钩子确实执行（见 `tools/probe-electron-hook.ps1`）。

## 4. 现有社区插件做法（参考，不依赖）

- `dsh-notify-tray@0.1.8`（npm，MIT）：Host 半用 `agent/status`、`session/event` 跟踪会话状态；**Windows 只做通知**，不提供托盘图标（README 明说桌面应用自带托盘图标）；通知 = PowerShell WinRT toast（AUMID 用 PowerShell 的注册 ID）+ `dsh://open` 协议点击聚焦 DSH；macOS/Linux 用独立 helper 进程做状态栏图标。
- `dsh-task-notifier@1.1.0`：浏览器 `Notification` + host toast，思路相近。

参考代码仅用于确认 API 用法（`ctx.on('agent/status')`、`ctx.on('session/event')`、`ctx.agents`、WinRT toast），不复制其业务代码。

## 5. 通知

- 主进程可用 Electron `Notification`（`lib/main.js` 已在桌面更新提示中使用：`if (!Notification.isSupported()) return; const notification = new Notification({ title, body, icon? })`）。
- Windows toast 可靠性的关键在 AUMID；Electron 主进程内的 `Notification` 使用应用自身 AUMID，品牌为 DSH —— 这是桥接方案优于 PowerShell toast 的地方。
- 点击通知 → 桥接可直接 `BrowserWindow.getAllWindows()[0].show()/focus()`，再（后续版本）尝试深链到具体会话。

## 6. Host 侧数据源（待插件实现验证）

- `ctx.agents.list()`：当前 live Agent 列表，`agent.status`（`running`/`idle`）。
- 事件：`agent/status`、`session/event`、`approval/request`（waterfall）、`user-questions/request`（waterfall）、`agent/error`、`api-session/*`。
- 工作区：`workspaceRegistry.list()` / `workspaceController`；会话归属需进一步确认（workspace 的 session 列表字段）。
- 详细契约在实现前用 `cordis_inspect_query` 的 `Service`/`Event` 逐项确认。

## 7. 待验证清单

1. ~~`NODE_OPTIONS=--require hook.cjs` 在 DSH Desktop 主进程是否生效~~ → **已否证**（见 §8.1）。
2. `Tray.prototype.setContextMenu` 可被 monkey-patch，且壳层 `relabel()`（语言切换等）重建菜单后仍会被我们接管。
3. Electron `Notification` 在 Windows 上品牌是否为 DSH、点击事件是否可用。
4. 窗口隐藏/失焦检测：`BrowserWindow.isVisible()` / `isFocused()`。
5. 会话深链：`dsh://open` 的处理逻辑（grep main.js 的 `setAsDefaultProtocolClient` / `second-instance` 分支）。

## 8. 注入通道实测记录（2026-11-07）

探针脚本：`tools/injector-probe.mjs`（Lead 编写）；临时探针 2/3/4 在 `%TEMP%\dsh-inspector-probe*`。

### 8.1 NODE_OPTIONS 不可用

以正常 Electron 主进程方式启动（子进程环境**删除** `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS=--require <hook>`）时，stderr 出现：

```
ERROR:electron\shell\common\node_bindings.cc:492] Most NODE_OPTIONs are not supported in packaged apps.
```

钩子未执行（无日志）。结论：打包应用只支持极少 NODE_OPTIONS，`--require` 被过滤；fuse `EnableNodeOptionsEnvironmentVariable` 只表示“允许读取 NODE_OPTIONS”，不代表支持 preload。

**环境坑**：本会话的 pwsh 工具继承 DSH Host 的环境变量 `ELECTRON_RUN_AS_NODE=1`。用 pwsh 启动 `DeepSeek Harness.exe` 前必须从子进程环境删除该变量，否则是 Node 模式（会报 `bad option: --user-data-dir`）。

### 8.2 `--inspect` 可用（关键）

- 打包 DSH 接受 `--inspect=127.0.0.1:<port>` 与 `--inspect-brk=127.0.0.1:<port>`，`http://127.0.0.1:<port>/json/list` 约 150–200ms 内出现目标（fuse `EnableNodeCliInspectArguments` enabled）。
- `--inspect-brk` 暂停等待调试器期间，`Runtime.evaluate` 全部超时；必须先 `Runtime.runIfWaitingForDebugger` 才能求值。→ **不用 --inspect-brk**，用 `--inspect`。
- `--user-data-dir=<temp>` 被接受，可启动隔离的第二实例（不影响正在运行的 DSH 实例）；但 Host 会使用同一个 `DSH_HOME`，测试时必须同时设置 `DSH_HOME=<temp>`。

### 8.3 主进程内可用的能力（Runtime.evaluate 实测）

| 能力 | 结果 |
|---|---|
| `require` / `module` 全局 | `undefined`（主进程入口是 ESM） |
| `process.mainModule.require('electron')` | ✅ 返回 electron 模块，`Tray/Menu/Notification/BrowserWindow/app` 均可用 |
| `import('electron')`（动态 import） | ❌ `a dynamic import callback was not specified` |
| `process.getBuiltinModule('node:fs')` 等 | ✅ 可用 |
| `new Notification({title, body}).show()` | ✅ 成功弹出 Windows 原生通知 |
| `BrowserWindow.getAllWindows().length` | ✅ 运行时为 1 |
| `Runtime.queryObjects(Tray.prototype)` | ✅ 返回已创建的 Tray 实例（实测 2 个） |
| `Runtime.callFunctionOn(trayObjectId, 'function(){ globalThis.__x = this }')` | ✅ 可接管托盘实例 |

### 8.4 结论：桥接架构

启动器 → `--inspect=127.0.0.1:<port>` 启动 DSH → 注入器 WebSocket 连主进程 inspector → `Runtime.evaluate` 加载 `hook.cjs`（`new Function(module, exports, require=process.mainModule.require, ...)` 包装）→ `Runtime.queryObjects` + `callFunctionOn` 把 Tray 实例交给 hook → hook 常驻主进程：patch `Tray.prototype.setContextMenu`、轮询状态文件、重建托盘菜单、弹原生通知、聚焦窗口。详见 `docs/DESIGN.md` §3。

### 8.5 尚未验证

- 接管后的托盘菜单在真实 Windows 通知区域的显示效果（需要隔离实例 E2E + 截图）。
- 通知品牌（AUMID）与点击聚焦行为。
- 会话深链（从菜单项直接打开某个会话）。
- `node:inspector.close()` 能否在 hook 内关闭 inspector 监听端口。

