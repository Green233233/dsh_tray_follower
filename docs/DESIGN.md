# 设计：DSH 托盘跟随者（dsh-tray-follower）

## 1. 需求拆解

| 编号 | 需求 | 验收方式 |
|---|---|---|
| R1 | DSH 托盘图标右键菜单在原有「打开 / 退出」之外，列出各工作区中正在运行的对话及状态 | 重启 DSH 后右键托盘图标，菜单出现工作区分组与每个对话的状态（运行中 / 等待批准 / 等待选择 / 已完成 / 失败 / 空闲） |
| R2 | DSH 最小化或失焦时，对话需要人工介入（批准、选择、输入）→ 系统级通知 | 隐藏窗口后触发一次工具批准请求，Windows 通知中心出现 DSH 通知 |
| R3 | 同上，对话停止工作（完成目标 / 结束并停止）→ 系统级通知 | 隐藏窗口后等待某会话完成一轮工作，出现「已完成」通知 |
| R4 | 可卸载、可回滚，不破坏 DSH 更新 | 运行卸载脚本后环境变量恢复、菜单恢复原样 |

## 2. 关键调研结论（详见 docs/recon/NOTES.md）

- DSH Desktop 是 Electron 应用，安装目录 `%LOCALAPPDATA%\Programs\DeepSeek Harness`；托盘菜单由主进程 bundle `resources/app.asar` 内的 `lib/main.js` 创建：`lib/types/tray.js` 的 `DesktopTray.relabel()` 用硬编码模板（打开 / 分隔线 / 退出）调用 `Menu.buildFromTemplate` + `tray.setContextMenu`。
- 该 Electron 应用 **没有** 开放的托盘扩展 API；Electron 的 `EnableEmbeddedAsarIntegrityValidation` fuse 为 disabled，但直接改 asar 会在自动更新后丢失，故不采用。
- Host（插件进程）是 Electron 主进程 fork 出来的子进程（`@deepseek-ai/dsh-desktop-host`），通过 `process.send` 与主进程通信，只处理固定消息类型，不能反向控制托盘。
- `NODE_OPTIONS=--require` 方案**不可行**：Electron 打包应用只支持极少数 NODE_OPTIONS，实测启动报 `Most NODE_OPTIONs are not supported in packaged apps`，钩子不执行（fuse 只表示“允许读取”，不代表支持 `--require`）。
- 可行注入点（已实测）：打包 DSH 会遵循 CLI 参数 `--inspect=127.0.0.1:<port>`（fuse `EnableNodeCliInspectArguments` enabled）。注入器通过 Node Inspector 协议（WebSocket + CDP）在 Electron 主进程内执行代码，可达 `electron.Tray/Menu/Notification/BrowserWindow`（`process.mainModule.require('electron')` 在 evaluate 上下文中可用），并能用 `Runtime.queryObjects(Tray.prototype)` 找到已创建的托盘实例、用 `Runtime.callFunctionOn` 接管其菜单。原生 `new Notification(...).show()` 已验证可弹 Windows 通知。

## 3. 架构

```
┌──────────────────── 启动器（快捷方式指向）─────────────────────────┐
│  launch-bridge.vbs/.cmd：选端口 → 起注入器 → 以 --inspect=127.0.0.1:  │
│  <port> 启动 DeepSeek Harness.exe                                    │
└──────────────┬───────────────────────────────────────────────────────┘
               │ Node Inspector WebSocket (CDP)
┌──────────────▼──────────────── DSH Electron 主进程 ─────────────────┐
│  injector.mjs：Runtime.enable → 评估 bootstrap 加载 hook.cjs →        │
│               Runtime.queryObjects 找 Tray → callFunctionOn adopt     │
│  hook.cjs（注入后常驻主进程）                                         │
│   ├─ patch Tray.prototype.setContextMenu → 捕获托盘与原始菜单          │
│   ├─ 轮询状态文件（1s）→ tray.setContextMenu(原菜单 + 工作区/会话状态) │
│   ├─ 轮询 unreadEvents → 隐藏/失焦时 new Notification() 原生通知       │
│   └─ 点击通知/菜单项 → restore/show/focus 主窗口                      │
└───────────────▲──────────────────────────────────┬──────────────────┘
                │ state.json / bridge.json          │ 点击
┌───────────────┴──────────────────────────────────▼──────────────────┐
│  DSH Host 进程：packages/dsh-tray-follower（DSH 插件）               │
│   ├─ 订阅 agent/status、session/event、approval/request、            │
│   │  user-questions/request 等事件，维护会话状态机                    │
│   ├─ 读取 workspaceRegistry + sessions，按工作区分组                  │
│   ├─ 原子写状态文件（JSON）与事件队列                                │
│   └─ 只发布状态；不自行调用任何 OS 通知通道（通知统一由桥接以 DSH     │
│      应用名义发出；桥接缺失时降级为“无通知”，见 §5）                   │
└──────────────────────────────────────────────────────────────────────┘
```

## 4. 状态文件契约（v1）

路径：`%LOCALAPPDATA%\dsh-tray-follower\state.json`（`DSH_TRAY_FOLLOWER_DIR` 可覆盖）。

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": 1730000000000,
  "hostPid": 1234,
  "webOrigin": "http://127.0.0.1:61983",
  "workspaces": [
    {
      "id": "ws_...",
      "title": "dsh_tray_follower",
      "path": "C:\\...\\dsh_tray_follower",
      "sessions": [
        {
          "id": "session-...",
          "title": "配置 Git 等工程管理",
          "status": "running",          // running | waiting-approval | waiting-choice | waiting-input | completed | failed | idle
          "detail": "正在执行 bash",
          "updatedAt": 1730000000000,
          "startedAt": 1730000000000
        }
      ]
    }
  ],
  "unreadEvents": [
    {
      "id": "evt_...",
      "kind": "completed",              // completed | failed | needs-attention
      "sessionId": "session-...",
      "workspaceId": "ws_...",
      "title": "任务完成",
      "body": "dsh_tray_follower • 配置 Git 等工程管理",
      "createdAt": 1730000000000
    }
  ]
}
```

事件消费：桥接读取后不删除文件（避免竞态）；桥接以 `state.updatedAt` + 事件 `id` 去重，并记录自己的游标到自己的数据目录。

## 5. 取舍

- **为什么不改 asar**：自动更新会覆盖，且用户升级路径不可控。
- **为什么不注入渲染进程**：渲染进程拿不到 Electron `Tray` / `Notification` 主进程 API；浏览器 `Notification` 只能由页面弹，无法在窗口隐藏时保证展示且品牌是浏览器。
- **为什么用 Node Inspector 注入**：不改安装文件、不需要管理员权限、官方支持的调试通道；`--inspect` 由启动器附加在命令行上，用户仍按原方式点击快捷方式启动。
- **为什么不用 `--inspect-brk`**：等待调试器时 `Runtime.evaluate` 会挂起；`--inspect` 本身即可满足“先注入、后建托盘”，且即使注入晚于托盘创建也能用 `Runtime.queryObjects` 接管。
- **通知必须由 DSH 应用自身发出**（用户明确要求）：只用 Electron 主进程的 `new Notification(...)`（Windows 上以 DeepSeek Harness 的 AUMID 显示），**不调用外部 PowerShell/WinRT/notify-send 等进程**。桥接未安装或注入失败时，插件只发布状态、不弹任何 OS 通知，菜单保持 DSH 原样（明确记录的降级模式）。
- **安全边界**：Inspector 端口只绑 `127.0.0.1`；注入完成后注入器断开，并由 hook 调 `node:inspector.close()` 关闭端口；不修改系统环境变量。

## 6. 未决问题

- 托盘菜单项点击“打开会话”：需要确认 DSH Web GUI 的会话深链（`dsh://open` 只聚焦窗口）。第一版先聚焦窗口，第二版再研究定位到具体会话。
- Windows 通知品牌：桥接通知由 Electron 主进程 `Notification` 发出，理论上是 DSH 应用自身身份（AUMID）；E2E 时需在隔离实例确认通知实际显示为 DeepSeek Harness、点击可聚焦窗口。
- 注意：bridge 尚未安装时不会有任何通知（用户要求不使用外部 PowerShell 通知通道），这是明确接受的降级。
