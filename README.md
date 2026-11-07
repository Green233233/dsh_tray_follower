# dsh_tray_follower

在 DeepSeek Harness（DSH）托盘图标中显示各工作区正在运行的对话与状态，并在 DSH 最小化 / 失焦时用系统级通知提醒“需要人工介入”或“任务已完成/已停止”的插件工程。

## 目标（来自需求）

1. 右键点击托盘里的 DSH 图标时，菜单除原有「打开」「退出」外，还应简要列出各工作区中正在运行的对话及其状态。
2. 当 DSH 被最小化或窗口失焦时，若某个对话需要人工介入，或者已经停止工作（完成目标），DSH 应发出系统级通知提醒用户。

## 仓库结构

```
packages/dsh-tray-follower/   DSH 插件本体（Host / 可选 Client，通过 plugin_manager 安装）
bridge/shell-hook/            DSH Desktop（Electron 主进程）桥接层：注入托盘菜单项 + 系统通知
tools/                        开发/安装/验证脚本（asar 扫描、桥接安装器等）
docs/                         设计文档、调研记录、验证记录
```

## 状态

- [x] 仓库初始化与工程管理配置（git / .gitignore / AGENTS.md）
- [x] DSH Desktop 壳层调研：托盘与通知的实现位置、可扩展点
- [ ] 插件 Host 半：会话/工作区状态采集与状态文件
- [ ] Electron 主进程桥接：托盘菜单注入、系统通知、窗口聚焦
- [ ] 安装、验证与文档

详见 [docs/DESIGN.md](docs/DESIGN.md) 与 [docs/recon/NOTES.md](docs/recon/NOTES.md)。
