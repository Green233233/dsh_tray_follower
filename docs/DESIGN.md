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
- 主进程 fuse `EnableNodeOptionsEnvironmentVariable` 为 enabled：`NODE_OPTIONS=--require <hook.cjs>` 会被 Electron 主进程遵循，这给了**不修改安装文件**的注入点。

## 3. 架构

```
┌──────────────────────── DSH Electron 主进程 ────────────────────────┐
│  shell-hook.cjs（NODE_OPTIONS --require 注入，两阶段加载）            │
│   ├─ 捕获 Tray.prototype.setContextMenu → 记住托盘菜单原始项          │
│   ├─ 轮询状态文件（1s）→ 重建菜单：原始项 + 工作区/会话状态            │
│   ├─ 轮询事件队列 → 窗口隐藏/失焦时 new Notification() 原生通知        │
│   └─ 点击通知/菜单项 → 显示并聚焦主窗口（BrowserWindow）              │
└───────────────▲──────────────────────────────────┬──────────────────┘
                │ status.json / events.jsonl       │ 点击
┌───────────────┴──────────────────────────────────▼──────────────────┐
│  DSH Host 进程：packages/dsh-tray-follower（DSH 插件）               │
│   ├─ 订阅 agent/status、session/event、approval/request、            │
│   │  user-questions/request 等事件，维护会话状态机                    │
│   ├─ 读取 workspaceRegistry + sessions，按工作区分组                  │
│   ├─ 原子写状态文件（JSON）与事件队列（JSONL/环形）                    │
│   └─ 备用通道：无桥接时用 PowerShell WinRT toast 发通知               │
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
- **为什么桥接用 `NODE_OPTIONS`**：DSH Desktop 主进程 fuse 允许，且不改安装文件；钩子先判断 `process.versions.electron` 与 app 名称，非 DSH 进程立即返回。
- **失败回退**：桥接未安装时，插件 Host 半仍可用 PowerShell WinRT toast 发系统通知（品牌为 Windows PowerShell，可接受为降级）。

## 6. 未决问题

- 托盘菜单项点击“打开会话”：需要确认 DSH Web GUI 的会话深链（`dsh://open` 只聚焦窗口）。第一版先聚焦窗口，第二版再研究定位到具体会话。
- Windows 通知品牌：桥接通知由 Electron `Notification` 发出，走 DSH 自己的 AUMID，品牌正确；备用 PowerShell 通道品牌为 PowerShell。
