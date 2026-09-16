# Kimi Code Web 与 Codex 集成调研

调研日期：2026-09-16。本文区分官方文档事实、固定版本源码观察和本项目的设计建议。所有线上文档均可能变化。

## 1. 结论

Kimi 有与本项目直接相关的官方文档。`kimi web` 提供本地浏览器界面，终端中的 `/web` 可转到当前会话。它值得借鉴的是会话和执行引擎与展示层分离、结构化工具展示、审批交互和恢复机制。

Codex 的对应集成入口是 `codex app-server`。本项目建议保留 Codex 引擎，在它前面增加本地 Web 网关和浏览器 UI。这个选型是本项目判断，不是 Kimi 或 OpenAI 对本项目的背书。

## 2. 官方资料索引

| 编号 | 文档 | 用途与阅读注意 |
| --- | --- | --- |
| K1 | [Using Kimi Code in the browser](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/web.html) | 当前 Web 使用入口、启动、功能与 CLI 的关系 |
| K2 | [Kimi command 源文档](https://github.com/MoonshotAI/kimi-code/blob/9c5e9b48634be1dfae921fb48f9afc3a23ffd1ad/docs/en/reference/kimi-command.md) | 固定版本的 CLI 命令参考 |
| K3 | [Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html) | REST、WebSocket、鉴权、事件订阅；明确标为实验接口 |
| K4 | [旧版 Web UI 文档](https://moonshotai.github.io/kimi-cli/en/reference/kimi-web.html) | 旧版体验参考；不要混用其端口和参数 |
| K5 | [Kimi 官方仓库](https://github.com/MoonshotAI/kimi-code) | 本次源码阅读的来源 |
| O1 | [Codex App Server](https://learn.chatgpt.com/docs/app-server) | rich client 集成入口；原 developers.openai.com/codex/app-server 已重定向至此 |
| O2 | [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) | 程序化调用的备选路线 |

本次实际打开了 K1、K3、K4、K5、O1、O2；K2 的 `/web` 相关内容通过官方仓库页面检索核对。更具体的实现结论以下面固定 commit 的文件为依据。

### 版本差异

当前 K1/K3 使用默认端口 `58627`、`--host`、`#token=` 启动链接。旧 K4 使用 `5494`，并包含 `--network`、`--auth-token` 等选项。搜索结果同时出现两套资料，不能合并成同一套启动说明。[当前文档](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/web.html)、[旧文档](https://moonshotai.github.io/kimi-cli/en/reference/kimi-web.html)。

本次以 `MoonshotAI/kimi-code` 的 commit `9c5e9b48634be1dfae921fb48f9afc3a23ffd1ad` 为源码基准，GitHub 返回提交时间为 `2026-09-16T10:27:29Z`。它是当时的 main 快照，不等同于已安装版本或稳定发布版本。

## 3. 源码阅读路径及发现

### 3.1 `/web` 如何接续会话

[apps/kimi-code/src/tui/commands/web.ts](https://github.com/MoonshotAI/kimi-code/blob/9c5e9b48634be1dfae921fb48f9afc3a23ffd1ad/apps/kimi-code/src/tui/commands/web.ts)

`handleWebCommand` 取得当前 session ID，注册 TUI 退出后的 foreground task，再停止 TUI。退出任务启动服务，ready 回调构造 `/sessions/{id}#token=...` 并打开浏览器。

**可借鉴**：先完成执行端交接，再打开目标会话；浏览器只在服务 ready 后打开。这个文件支持“会话交接”的结论，不能据此宣称终端和网页可同时编辑同一会话。

### 3.2 命令启动与生命周期

[apps/kimi-code/src/cli/sub/web/run.ts](https://github.com/MoonshotAI/kimi-code/blob/9c5e9b48634be1dfae921fb48f9afc3a23ffd1ad/apps/kimi-code/src/cli/sub/web/run.ts)

CLI 调用 `@moonshot-ai/kap-server`，定位 `dist-web` 静态资源；服务在当前进程以前台方式运行，接收终止信号并关闭。

**可借鉴**：一个本地启动命令同时负责服务、资源、浏览器入口和退出清理，避免用户分别配置前后端。

### 3.3 服务端分层和技术选择

[packages/kap-server/package.json](https://github.com/MoonshotAI/kimi-code/blob/9c5e9b48634be1dfae921fb48f9afc3a23ffd1ad/packages/kap-server/package.json) 与 [src/start.ts](https://github.com/MoonshotAI/kimi-code/blob/9c5e9b48634be1dfae921fb48f9afc3a23ffd1ad/packages/kap-server/src/start.ts)

当前服务端为 TypeScript，依赖 Fastify、ws、Zod，并连接 agent-core-v2。启动代码组装鉴权、Host/Origin 检查、路由、事件广播和关闭逻辑。

**可借鉴**：协议、会话业务、传输、安全检查分层。本项目的执行层应替换成 Codex adapter，无需移植 Kimi agent-core。

### 3.4 静态资源与会话深链接

[packages/kap-server/src/routes/webAssets.ts](https://github.com/MoonshotAI/kimi-code/blob/9c5e9b48634be1dfae921fb48f9afc3a23ffd1ad/packages/kap-server/src/routes/webAssets.ts)

服务端提供静态文件，对没有扩展名的前端路径回退到 `index.html`，并排除 API 路径；带哈希资源长期缓存，入口页不缓存。

**可借鉴**：刷新会话 URL 仍能打开应用；API 404 不应误返回 SPA HTML。

### 3.5 事件恢复

[sessionEventJournal.ts](https://github.com/MoonshotAI/kimi-code/blob/9c5e9b48634be1dfae921fb48f9afc3a23ffd1ad/packages/kap-server/src/transport/ws/v1/sessionEventJournal.ts) 与 [sessionEventBroadcaster.ts](https://github.com/MoonshotAI/kimi-code/blob/9c5e9b48634be1dfae921fb48f9afc3a23ffd1ad/packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts)

日志以 epoch 与 seq 标识事件位置。广播层区分 volatile 与持久事件，支持游标补发；epoch 改变、缓冲区溢出等情况要求重新同步。日志实现也显式处理写盘失败，因此不能把“支持 journal”解释为任何故障下都无损。

**可借鉴**：明确区分增量和快照、短暂掉线和服务重启、可重放事件和瞬时状态。我们在网关增加自己的游标，不假设 Codex 已提供同样语义。

### 3.6 鉴权

[middleware/auth.ts](https://github.com/MoonshotAI/kimi-code/blob/9c5e9b48634be1dfae921fb48f9afc3a23ffd1ad/packages/kap-server/src/middleware/auth.ts) 与上述 [start.ts](https://github.com/MoonshotAI/kimi-code/blob/9c5e9b48634be1dfae921fb48f9afc3a23ffd1ad/packages/kap-server/src/start.ts)

REST 验证 Bearer 凭证；WebSocket upgrade 可从 header 或 subprotocol 取凭证，并检查 Host/Origin。日志对凭证做脱敏。

**可借鉴**：鉴权必须覆盖 HTTP 和 WebSocket，不能只保护首页。本项目选择短时启动凭证换取 HttpOnly cookie，是独立设计，不声称是 Kimi 的实现。

### 3.7 前端证据边界

该快照的公开树包含 `apps/kimi-code/dist-web` 成品资源，以及单独的 VS Code webview 和 `apps/vis` 源码。本次没有找到与主 Web UI 一一对应的完整前端开发目录；不把 VS Code webview、会话可视化器或旧版 UI 当成当前主 Web UI 的实现。

因此，本文对主界面功能的描述依据使用文档；React、Vite、组件拆分等是我们自己的技术选择。本次没有安装或启动 Kimi 做交互体验测试。

## 4. Codex 本机核验

已执行以下只读检查：

```sh
codex --version
codex app-server --help
codex app-server generate-ts --help
codex app-server generate-json-schema --help
codex app-server generate-ts --out /tmp/codex-webui-protocol
```

结果：本机是 `codex-cli 0.154.0`，支持默认 stdio transport 和协议类型生成。CLI 帮助将 app-server 命令标为 experimental；官方文档也明确提示相关成熟度限制。这个方案适合先做个人本地 MVP，不能据此宣称生产稳定性。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。

生成类型中核对了以下接口类别，完整方法清单和文件 SHA-256 见 [verification.json](research/verification.json)：

| 类别 | 本机类型中确认的方法 |
| --- | --- |
| 会话 | `thread/start`、`thread/list`、`thread/read`、`thread/resume`、`thread/archive` |
| 回合 | `turn/start`、`turn/steer`、`turn/interrupt` |
| 状态 | `account/read`、`model/list` |
| 流式事件 | `item/agentMessage/delta`、`item/commandExecution/outputDelta`、`turn/diff/updated`、`turn/completed` |
| 反向请求 | 命令、文件与权限审批；`item/tool/requestUserInput`；MCP elicitation |

类型存在只证明协议形状，不证明当前账号、模型、策略及所有运行环境都可用。本次没有发起模型请求，也没有验证真实登录、审批、CLI 历史导入或进程崩溃恢复。

另一个具体差异：在线文档对权限审批 `scope` 描述为可省略，而本机 `PermissionsRequestApprovalResponse` 将它列为必填。实现时显式传值，并以固定 CLI 生成类型及集成测试为准，不直接照搬在线示例。

## 5. 借鉴与取舍

| Kimi 提供的启发 | Codex WebUI 的决定 |
| --- | --- |
| 从终端打开本地浏览器 | 提供独立 `codex-web` 命令，前台运行 |
| 当前会话深链接 | 支持指定 thread ID 接续已结束回合；暂不接管运行中的 TUI |
| 使用同一执行引擎 | 保留 Codex 登录、工具和策略，由 app-server 执行 |
| REST 与实时事件分工 | 浏览器通过 REST 操作、WebSocket 订阅网关事件 |
| journal 与重同步 | 网关快照 + 有界事件重放；重启后重新对账 |
| 结构化工具、审批、变更视图 | 作为 MVP 核心能力 |
| 丰富设置、搜索、远程访问 | 分期实施，首版聚焦本机单用户 |

当前 Codex 官方文档将 app-server 定位于富客户端集成，将 SDK 作为自动化任务的选择。这支持本项目优先使用 app-server；PTY 终端嵌入仅作为后续可选面板。[官方说明](https://learn.chatgpt.com/docs/app-server)。

## 6. 后续核验清单

1. 固定 Codex 0.154.0，实测初始化、登录状态、流式回合、中断及命令/文件审批。
2. 对 CLI 创建的已关闭会话，验证列表过滤、cwd 和 `thread/resume` 的一致性。
3. 验证浏览器刷新不会终止回合；网关崩溃后不自动重发用户任务。
4. 核对所选模型、权限策略和 MCP 下实际出现的所有反向请求。
5. 若以后直接复用第三方代码或资源，再检查对应文件许可和保留通知；当前方案仅借鉴机制，没有复制主 UI 资源。
