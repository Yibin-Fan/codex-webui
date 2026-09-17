# Codex WebUI

Codex WebUI 是一个运行在本机的浏览器界面，用于使用已安装的 [Codex CLI](https://developers.openai.com/codex/)。它不会自己实现另一个 Agent，而是通过 `codex app-server` 使用现有的登录状态、会话、工具和权限策略。

> 当前是早期 MVP，兼容基线为 `codex-cli 0.154.0`。app-server 本身仍属于实验性接口，请只在可信的本机工作区使用。

## 已实现

- 本地 loopback Web 服务与一次性启动链接
- Codex app-server stdio 适配器：初始化、JSONL 流式事件、反向 RPC 请求和优雅停止
- 创建、列出、读取和恢复 Codex 会话
- 发送消息、接收流式工具/文本事件与中断回合
- 命令输出、文件变更、MCP 调用和本轮统一 diff 的结构化展示
- 审批请求的浏览器展示和回传基础链路
- 浏览器断开不会结束本地 Codex 进程
- 协议生成脚本、类型检查、单元测试与 GitHub Actions 配置

## 运行

要求：Node.js 22+、npm、已安装并已登录的 Codex CLI。

```sh
npm install
npm run build
npm start -- --workspace /path/to/project
```

开发时在两个终端分别运行：

```sh
npm run dev:server
npm run dev:web
```

服务默认监听 `127.0.0.1:4317`。启动输出的链接带有一次性浏览器凭证，请勿分享。可以通过以下参数指定工作区或端口：

```sh
npm start -- --workspace /path/to/project --port 4318 --no-open
```

## 验证

```sh
npm run typecheck
npm test
npm run build
```

## 安全模型

服务仅监听本机回环地址。浏览器通过启动链接中的短随机 token 建立 HttpOnly 会话；token 不放入 API 返回体。浏览器不直接连接 Codex app-server，网关只公开必要的会话、回合和审批接口。

Codex 的文件、Shell 和网络权限仍由你的 Codex 配置及每次审批控制。该项目不会复制 `~/.codex` 中的登录凭证，也不会提供通用 Shell API。请不要将本地端口暴露到局域网或互联网。

## 项目资料

- [实现文档](docs/implementation.md)
- [Kimi Code Web 与 Codex 集成调研](docs/research.md)
- [本机协议核验记录](docs/research/verification.json)

## 开源许可

[MIT](LICENSE)
