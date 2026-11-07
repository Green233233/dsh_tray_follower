# DSH Host API 调研（dsh-tray-follower 插件用）

> 目的：把 `packages/dsh-tray-follower/` Host 半依赖的每一个 Service / Event /
> Session 事件字段固定下来，并保存可复核的证据。
>
> 证据来源分三类（下文用 `[inspect]` / `[read]` / `[ref]` 标注）：
> - `[inspect]`：本会话内 `cordis_inspect_query`（platform=host，providers
>   `Service` / `Event`）的实时返回，直接引用其签名/类型声明原文。
> - `[read]`：用 Host 的 `read` 工具直接读取安装目录
>   `C:\Users\Green\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\...`
>   内的文件（**只有 `read` 工具能读 app.asar；rg/glob/node/pwsh 都不行**，见 §7）。
> - `[ref]`：npm 参考包 `dsh-notify-tray@0.1.8`（仅用于确认 API 用法，不复制代码），
>   位于 `C:\Users\Green\AppData\Local\Temp\dsh-recon-refs\`。
>
> DSH 版本：`@deepseek-ai/dsh-desktop-runtime` 0.2.2-rc.1
> （`resources/app.asar/dsh/package.json` 第 4 行 `[read]`）。

---

## 1. 插件入口形态（bundle 规范）

`[read]` cordis-plugin-development skill：
`resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`

- 第 9–18 行：Host-only bundle 最小 manifest：
  `type: "module"`、`exports`、`dsh.bundle.patch`，无 dependencies / build tool。
- 第 22–27 行：patch 形态 `- insert: [{ id, name, config? }]`。
- 第 31–51 行：Plugin Manager/Settings 不激活插件也会读 `meta.title` /
  `meta.description`（来自导出的 `locale/*.json`）和 `./icon`；`files` 必须包含
  patch、locale、icon、全部运行文件；icon 支持 SVG/PNG/JPEG/WebP ≤256 KiB。
- 第 59–64 行：`index.js` 导出二选一：
  `export function apply(ctx, config)` + 可选 `export const inject` / `Config`，
  或 default export 一个 Service class；资源必须在 `apply` 内用 `ctx.effect` /
  `ctx.on` 注册。
- 模板：`.../templates/decoration/package.json` 第 1–21 行给出
  `exports` 含 `./locale/*.json`、`./icon` 的写法。

`[inspect]` `Service.listService`（catalog 模式）确认本进程存在这些服务，且
Host 代码通过 `ctx.<key>` / `ctx.get("<key>")` 访问。

---

## 2. Service 契约（插件实际用到的）

### 2.1 `agents`（硬依赖）

`[inspect] Service.listService service=agents`：

```text
get(id: SessionId): Agent | undefined
list(): Agent[]
roots(): Agent[]
```

- 访问方式：`hardDependency.inject = ["agents"]`,
  `hardDependency.expression = "ctx.agents"`；可选形式
  `ctx.get("agents")`（需 undefined 检查）。
- `Agent` 的公开 interface 只有 `{ readonly id: SessionId }`（`referencedTypes`），
  但实现侧的 `Agent` 还暴露 `.session`、`.status`、`.ctx`、`.model`、`.inbox`：
  - `[read] dsh/node_modules/@deepseek-ai/dsh-agent/README.md`
    - 第 43 行：setup 回调里 “the explicit unpublished Agent provides its Session”。
    - 第 58–70 行：`handle.agent.followup/steer/inject/cancel/whenIdle`。
    - 第 126 行：`const running = lookup(sessionId)?.status === "running"`
      （Agent 状态取值 `running` / `idle`）。
- 结论：状态采集用 `agent.id`、`agent.session`、`agent.status`；
  `agent/status` 事件的 payload 也只携带 `{ agent, status }`（§3）。

### 2.2 `sessions`（可选）

`[inspect] Service.listService service=sessions`：

```text
create(id?: SessionId, options?: CreateSessionOptions): Session
get(id: SessionId): Session | undefined
list(): Session[]
fork(...): Session
flush(session: Session): Promise<boolean>
```

- 访问：`optional.expression = ctx.get("sessions")`（需 undefined 检查）。
- `[read] dsh-session/README.md` 第 36–40 行：`ctx.sessions.create/get/list`
  返回 live Session；Session 只在当前 Host 进程内存在，持久化由独立插件负责
  （所以本插件只跟踪 live 会话）。
- `Session` 公开成员（`[inspect]` referencedTypes.Session 声明原文）：
  `.id`、`.header`（`createdAt`、`cwd`、`parentSession`、`origin?`、
  `delegationDepth?`、`isSeeded`）、`.deriveMessages()` 等。

### 2.3 `workspaceRegistry`（可选）

`[inspect] Service.listService service=workspaceRegistry`（原文摘要）：

```text
async create(path: string, title?: string): Promise<Workspace>
get(id: WorkspaceId): Workspace | undefined
list(): Workspace[]                       // "Synchronous workspace projection in durable registry order."
async resolveByPath(path: string): Promise<Workspace | undefined>
async archiveSession/unarchiveSession/pinSession/unpinSession...
```

`[inspect]` referencedTypes.Workspace 声明原文：

```ts
export interface Workspace {
    readonly id: WorkspaceId;
    readonly path: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly sessionIds: readonly SessionId[];
    setTitle(title: string): Promise<void>;
    attachSession(sessionId: SessionId): Promise<void>;
    insertSessionBefore(...): Promise<void>;
    detachSession(sessionId: SessionId): Promise<void>;
    status(): Promise<'ok' | 'missing-dir'>;
}
```

- `list()` 说明原文：*"Every entity's `sessionIds` getter is already filtered by
  the startup/live canonical-cwd header index"* —— 即 `sessionIds` 同时覆盖持久化
  与 live 会话；插件将其与 live 会话求交集得到每个工作区的会话。
- `[read] dsh-workspace/README.md`：第 51–60 行（create/list）、第 71–77 行
  （*"A session joins the project of the directory it runs in"*）、第 94 行
  （*"Header-only reads. Bootstrap and attach validation read SessionHeader fields only"*）。
- 访问：`ctx.get("workspaceRegistry")`；`sessionIds` 是 getter，服务卸载时可能
  抛错，插件逐项 try/catch（见 `index.js#readWorkspaces`）。

### 2.4 `sessionTitle`（可选）

`[inspect] Service.listService service=sessionTitle`：

```text
get(session: Session): SessionTitleSnapshot | undefined
rename(session: Session, title: string): SessionTitleSnapshot
async refresh(session: Session, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined>
register(provider: SessionTitleProvider): () => Promise<void>
```

`[inspect]` referencedTypes.SessionTitleSnapshot：

```ts
export interface SessionTitleSnapshot extends SessionTitleEventData {
    readonly eventSeq: SessionSeq;
    readonly updatedAt: number;
}
// SessionTitleEventData = { title, messageSeqs, source }
```

- `[read] dsh-session-title/README.md` 第 30–32 行：标题来源三选一（fallback /
  provider / 用户重命名），只从人类 `user/message` 折叠；第 59–61 行：
  `get(session)` 读 latest folded title，`foldSessionTitle(events)` 是纯折叠。
- 结论：种子时用 `ctx.get("sessionTitle").get(session)?.title`；运行期用
  `session/event` 的 `session/title` 事件增量更新（§4）。

### 2.5 `webApp` / `webServer`（可选）

`[inspect] Service.listService service=webApp`：

```text
getAdvertisedUrl(): string
// "The URL this GUI advertises, also used for DSH_WEB_URL and the startup URL line."
```

`webServer.getOrigin(): string`（catalog 中的签名）。结论：`webOrigin` 优先
`ctx.get("webApp").getAdvertisedUrl()`，其次 `ctx.get("webServer").getOrigin()`，
最后 `process.env.DSH_WEB_URL`，统一规约成 http(s) origin（丢掉 path/credentials）。

### 2.6 `goals`（可选，用于 goal 感知的状态推导）

`[inspect] Service.listService service=goals`：`get(agent: Agent): GoalView | undefined`
（"Read the current goal for one exact live agent"）；`GoalView.phase` 取值
`active|paused|blocked|complete`，`GoalView.activation` 取值 `armed|disarmed`
（同 `referencedTypes`）。种子时用它初始化 goal 状态，运行期用 `goal/changed`
事件维护（§3.7）。

---

## 3. Event 契约（插件监听的全部事件）

`[inspect] Event.listEvents` 原文（host）：

| event | mode | signature（原文） |
|---|---|---|
| `agent/status` | emit | `'agent/status'(this: Scoped<Agent>, payload: { agent: Agent; status: AgentStatus }): void` |
| `agent/created` | serial | `'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined \| Promise<undefined>` |
| `agent/disposed` | emit | `'agent/disposed'(this: Scoped<Agent>, payload: { agent: Agent }): void` |
| `agent/error` | emit | `'agent/error'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; error: unknown }): void` |
| `session/event` | emit | `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void` |
| `approval/request` | waterfall | `'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>` |
| `user-questions/request` | waterfall | `'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>` |
| `goal/changed` | emit | `'goal/changed'(this: Scoped<Agent>, payload: { agent: Agent; change: GoalChanged }): void` |
| `goal/activation-changed` | emit | `'goal/activation-changed'(payload: GoalActivationChanged): void` |

要点：

- `agent/status` 只有 `running` ⇄ `idle` 两个值（catalog description：
  *"Agent status changed (`idle` ⇄ `running`)"*）。
- **waterfall 监听器必须调用 `next()` 并返回其结果**；参考实现
  `[ref] dsh-notify-tray/lib/index.js` 第 111–126 行同样只在 emit 事件上监听，
  本插件按 `[inspect]` 的 mode 逐个区分（emit 用 `ctx.on`，waterfall 用
  `ctx.on(name, async (payload, next) => { ...; return await next() })`）。
- `agent/created` 是 serial 而非 emit：签名要求返回 `undefined | Promise<undefined>`；
  本插件注册普通监听（返回 undefined），不阻塞创建。
- 事件分类依据 `[inspect]` 的 `mode` 字段，不靠猜测。

### 3.1 `ApprovalRequestEvent`（`[inspect]` referencedTypes 原文）

```ts
export interface ApprovalRequestEvent {
    readonly agent: Agent;
    readonly toolName: string;
    readonly callId?: ToolCallId;
    readonly reason?: string;
    readonly displayReason?: { readonly en: string; readonly [locale: string]: string; };
    readonly signal?: AbortSignal;
}
```

`ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`。

### 3.2 `AskUserQuestionRequestEvent`（同上）

```ts
export interface AskUserQuestionRequestEvent {
    questions: AskUserQuestionItem[];
    agent?: Agent;
    signal?: AbortSignal;
    wait?: { callId: ToolCallId; timed?: boolean };
}
export interface AskUserQuestionItem {
    id: string; question: string; detail?: string; header?: string;
    options?: AskUserQuestionOption[]; multiSelect?: boolean;
    intent?: AskUserQuestionIntent;   // plan-review / approval
}
export interface AskUserQuestionAnswer { answers: AskUserQuestionAnswerItem[] }
```

### 3.3 `GoalChanged` / `GoalActivationChanged`（同上）

```ts
export interface GoalChanged {
    readonly operation: GoalOperation;  // create|edit|pause|resume|complete|block|clear
    readonly ref: GoalRef;              // { id, revision }
    readonly goal?: GoalView;           // fresh projection, or tombstone when cleared
}
export interface GoalActivationChanged {
    readonly sessionId: SessionId;
    readonly goal?: { readonly id: GoalId; readonly revision: number;
                      readonly activation: GoalActivation };
}
```

`GoalView` 额外含 `phase: active|paused|blocked|complete`、
`blockedReason?: { code, message }`、`roundsStarted`。

---

## 4. Session 事件（`session/event` 的 event 参数）

事件类型总表（`[read]` `dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js`
第 21–84 行，`KNOWN_SESSION_EVENT_TYPES`）中与本插件相关的条目及行号：

| 行 | 类型 |
|---|---|
| 24 | `approval/asked` |
| 25 | `approval/decided` |
| 26 | `approval/policy` |
| 40 | `goal/change` |
| 57 | `session/title` |
| 74 | `tool/call` |
| 77 | `tool/result` |
| 78 | `turn/end` |
| 79 | `turn/start` |
| 59–60 | `step/end` / `step/start` |

`SessionEvent` 外层结构（`[inspect]` sessions service referencedTypes 原文）：

```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
    type: K; seq: SessionSeq; time: number; data: SessionEventMap[K];
    ignorable?: true;
} & ...
```

### 4.1 本插件消费的 payload

| 事件 | data 字段 | 证据 |
|---|---|---|
| `session/title` | `{ title, messageSeqs, source }` | `[inspect]` sessionTitle referencedTypes.SessionTitleEventData；`[read]` dsh-session-title/README.md 第 79 行（*"every accepted revision is a `session/title` event"*） |
| `turn/start` | `{ turn }` | `[inspect]` SessionEventMap 声明（turn/start: { turn: number }） |
| `turn/end` | `{ turn, reason }`；`reason.kind` ∈ `completed \| aborted \| blocked \| error \| max-tokens \| interrupted \| forked`，`error.kind` 带 `LlmFailure{message,code,...}` | `[inspect]` SessionEventMap + TurnEndReasonMap 声明；`[ref]` dsh-notify-tray/lib/tracker.js 第 52–62、197–208 行（同名字段用法） |
| `tool/call` | `{ turn, step, callId, name, arguments }`（`arguments` 是 JSON **字符串**） | `[inspect]` SessionEventMap；`[ref]` tracker.js 第 177–184 行 |
| `tool/result` | `{ turn, step, message, error?, meta? }`；`message.toolCallId`（亦见 `message.source.callId`） | `[inspect]` SessionEventMap + ToolResultMessage 声明；`[ref]` tracker.js 第 185–196 行 |
| `approval/asked` | `{ id, toolName, callId?, reason? }` | **直接源码证据** `[read]` `dsh/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js` 第 153–169 行：`session.append("approval/asked", { id, toolName, ...callId, ...reason })`，随后 `session.append("approval/decided", { id, outcome })` |
| `approval/decided` | `{ id, outcome }` | 同上第 164–168 行 |
| `goal/change` | GoalChanged（`[inspect]` 事件的对应 session 事件；本插件只把它当作运行期 `goal/changed` 的兜底） | `[read]` known-event-types.js 第 40 行 |

顺序注意（`[read]` dsh-user-approval/lib/index.js 第 153–169 行）：
`request()` **先** append `approval/asked`，**再** dispatch `approval/request`
waterfall。因此同一等待会被两条路径观察两次；插件用同一 wait key
（`approval:<callId || toolName>`）去重（见 `lib/tracker.js#_beginWait`）。

### 4.2 判定“是否需要人工”的提问工具

`[read]` `dsh/node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js`：

- 第 66–68 行：`ctx.tools.register(defineTool({ name: "ask_user_question", ... }))`
  —— 工具名为 `ask_user_question`。
- 第 69–117 行：参数 `questions[]`，每项含 `id / question / header? /
  options? / multi_select?`；选项存在或 `multi_select` 即“选择”，否则“输入”。
- `[read]` dsh-user-questions/README.md 第 27–35 行：`ask()` 挂起等待、
  `plan-review` / `approval` intent 的展示语义（本插件把带 `intent` 的批量也归为选择）。

---

## 5. 状态文件契约与写入

- 契约原文：`docs/DESIGN.md` 第 40–81 行（`schemaVersion` / `updatedAt` /
  `hostPid` / `webOrigin` / `workspaces[].sessions[]` / `unreadEvents[]`）。
- 路径：`%LOCALAPPDATA%\dsh-tray-follower\state.json`，`DSH_TRAY_FOLLOWER_DIR` 覆盖。
- 桥接心跳：bridge 自己写 `<dataDir>\bridge.json`，契约 `{ pid, ts, version }`；
  本插件按 `ts` 判断新鲜度（>15 s 视为无桥接，走 PowerShell 兜底）。
- 写入实现：`lib/atomic-json.js`（tmp + rename，Windows 上 rename 被占用时删旧重试）、
  `lib/state-writer.js`（200 ms 合并窗口，错误只记日志）。
- 事件消费：`docs/DESIGN.md` 第 81 行——桥接不删除文件，用 `updatedAt` + 事件
  `id` 去重；因此本插件的事件 id 用确定性哈希（`lib/ids.js`），跨插件重载稳定。

---

## 6. 参考实现（仅确认 API 用法，业务代码全部原创）

`[ref]` `C:\Users\Green\AppData\Local\Temp\dsh-recon-refs\dsh-notify-tray-0.1.8\package\`：

- `lib/index.js` 第 103–127 行：`export const inject = ['agents']`、
  `ctx.on('agent/status', ({agent,status}) => ...)`、
  `ctx.on('agent/disposed', ({agent}) => ...)`、`ctx.on('session/event', (session,event) => ...)`
  —— 与 `[inspect]` 签名一致。
- `lib/tracker.js` 第 160–214 行：`session/title`、`approval/asked|decided`、
  `tool/call`、`tool/result`、`turn/end` 的字段读取方式（本插件字段名与之相同，
  逻辑为独立实现）。
- `lib/system.js` 第 77–100 行：PowerShell WinRT toast 的可行做法
  （`-EncodedCommand` UTF-16LE base64、ToastGeneric XML、PowerShell AUMID）。
  本插件的 `lib/fallback-toast.js` 是独立实现（自己的 XML/脚本构造与错误处理）。

---

## 7. 环境坑位（实现时实测）

1. **app.asar 只能由 `read` 工具读取**。`rg`/`glob`（原生 ripgrep）、`node fs`、
   PowerShell `Get-Content` 对 `...\resources\app.asar\...` 内的路径均失败；
   要列 asar 内文件可用仓库 `tools/scan-asar.mjs`（读 app.asar 这个普通文件本身）。
2. **Node 24 不再把位置参数目录当测试发现**：`node --test packages/dsh-tray-follower`
   会把该目录当模块入口解析（报 `Cannot find module` 或把 package 当单个测试），
   正确命令是 glob：`node --test "packages/dsh-tray-follower/test/*.test.mjs"`。
   已在 `AGENTS.md` 的验证基线同步。
3. `ctx.get("<service>")` 是可选服务访问方式（`[inspect]` access.optional），
   返回 `undefined` 时插件必须降级而不是抛错；`agents` 是唯一硬依赖
   （`inject = ['agents']`）。
4. `Workspace.sessionIds` 是 getter（`[inspect]` Workspace 声明），服务卸载途中
   读取可能抛错：插件在 `index.js#readWorkspaces` 内逐项 try/catch。
5. `session/title` 只对 **live Session** 可用（`sessionTitle.get(session)` 需要
   Session 对象）——这也是插件只跟踪 live 会话的原因。
6. `approval/request` / `user-questions/request` 是 waterfall：必须 `return await next()`；
   在 `finally` 里结算自己的等待状态，异常也只记录日志（不能抛回 DSH 事件循环）。
7. 插件加载顺序：`apply` 时 `agents` 已可列出 live agent；但 `webApp` 可能尚未
   起来，因此 `webOrigin` 每次写状态时重新读取（5 s tick + 每次事件写）。

---

## 8. 复现命令

```powershell
# Service 契约
#   cordis_inspect_query(platform=host, provider=Service, method=listService, input={service:"workspaceRegistry"})
# Event 契约
#   cordis_inspect_query(platform=host, provider=Event, method=listEvents, input={event:"approval/request"})
# 列出 asar 内相关文件（普通文件读取，不需要 Electron）
node tools/scan-asar.mjs "C:\Users\Green\AppData\Local\Programs\DeepSeek Harness\resources\app.asar" "dsh-user-approval" 50
# 语法 / 测试
Get-ChildItem -Recurse packages/dsh-tray-follower -Include *.js,*.mjs | ForEach-Object { node --check $_.FullName }
node --test "packages/dsh-tray-follower/test/*.test.mjs"
```

---

## 9. 与桥接（`bridge/shell-hook/`）的契约对齐复核

桥接代码由另一位 teammate 实现，2026-11-08 只读复核（未修改、未运行）：

- `[read] bridge/shell-hook/lib/heartbeat.cjs` 第 8、26–31 行：桥接写
  `<dataDir>/bridge.json`，payload `{ pid, ts, version }` —— 与插件
  `lib/bridge.js#parseHeartbeat` 的契约一致。
- `[read] bridge/shell-hook/lib/constants.cjs` 第 12–18、56–61 行：
  `DATA_DIR_NAME = 'dsh-tray-follower'`、`SCHEMA_VERSION = 1`、
  `heartbeatMs = 5000`。插件按 15 s（3 个心跳周期）判定 stale，容错一致。
- `[read] bridge/shell-hook/lib/constants.cjs` 第 31–48 行：桥接的
  `STATUS_GLYPHS` 覆盖插件全部 7 个状态；`EVENT_KINDS` 与插件的
  `UNREAD_KINDS` 完全一致。
- `[read] bridge/shell-hook/lib/state.cjs` 第 29–181 行：桥接对 state 做防御性
  normalize，读取 `workspaces[].sessions[].{id,title,status,detail,updatedAt,startedAt}`
  与 `unreadEvents[].{id,kind,sessionId,workspaceId,title,body,createdAt}`，
  与插件输出逐字段一致；未知 status → `idle`、未知 kind → `needs-attention`，
  不会因插件新增字段而报错。
- 桥接侧没有要求额外字段（没有 `bootId` 等），因此插件严格按 DESIGN §4 输出。
- 端到端未实测：插件未安装、DSH 未重启（按任务约束）；桥接安装以 Lead 的
  `tools/install-bridge*` 为准。

