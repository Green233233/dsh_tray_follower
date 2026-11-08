# AGENTS.md — dsh_tray_follower 工程约定

## 项目性质

本仓库同时包含两类产物：

1. **DSH 插件包**（`packages/dsh-tray-follower/`）：符合 DSH bundle 规范，通过 `plugin_manager` 的 `install_bundle` 安装；Host 半运行在 DSH Host 进程，Client 半运行在 Web GUI。
2. **DSH Desktop 桥接层**（`bridge/shell-hook/`）：以 Node Inspector CDP 注入的方式加载到 DSH Desktop 的 Electron 主进程（启动器给 DSH 附加仅回环的 `--inspect`，注入完成后关闭端口；打包 Electron 不支持 `NODE_OPTIONS=--require`），用于扩展托盘菜单与系统通知。它不属于 DSH 插件规范的一部分，属可选增强，安装/卸载必须可逆。

## 硬性约束

- 不要修改 DSH 安装目录（`%LOCALAPPDATA%\Programs\DeepSeek Harness`）下的任何文件；桥接只允许通过环境变量 + 外部钩子注入。
- 不要写用户 profile 的 `package.json` / `cordis.patch.yml`；插件安装一律走 `plugin_manager`。
- 任何对用户环境的持久化修改（环境变量、开机启动）必须由显式安装步骤完成，且提供卸载脚本。
- 状态数据目录：`%LOCALAPPDATA%\dsh-tray-follower\`（可由 `DSH_TRAY_FOLLOWER_DIR` 覆盖）。
- 插件与桥接之间的契约是**状态文件**（见 `docs/DESIGN.md`），不要引入未文档化的进程间调用。

## 工程管理

- 分支：`main` 为稳定；功能分支 `feat/<slug>`。
- 提交信息：Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:` / `test:`）。
- 提交前：`node tools/check.mjs`（语法检查 + 单元测试 + 契约校验）。
- 上架发布物用 `node scripts/build-market-package.mjs` 构建到 `dist/`（gitignored）；发布步骤见 `marketplace/PUBLISHING.md`。
- 调研提取的第三方代码放到 `docs/recon/extracted/`，已被 `.gitignore` 排除，禁止提交。
- 改动结论（尤其是对 DSH 内部行为的假设）必须写进 `docs/recon/NOTES.md`，附文件路径/行号证据。

## 验证基线

- 插件 Host 半：`node --check` 全部 JS；`node --test "packages/dsh-tray-follower/test/*.test.mjs"` 通过（Node 24 不把目录参数当测试发现）；`cordis_inspect_query` 能看到新增行。
- 桥接：`node tools/bridge-selftest.mjs` 通过（不启动 GUI 也能验证状态解析、菜单模型、通知去重逻辑）。
- 端到端：需要用户重启 DSH 后观察托盘菜单与通知；未实测前不得声称“已验证”。
