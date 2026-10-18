# molesignal

MoleSignal 的命令行工具：登录一个 MoleSignal 实例，查看并持续跟随数据流的日志，并通过 stdio
提供 MoleSignal 的 MCP 工具，让 Claude Code、Cursor、Codex、VS Code、Gemini CLI 等 AI Agent
工具使用。

[English](README.md)

## 安装

```bash
npm install -g @molesignal/cli
molesignal --help
```

每个命令也可以不安装直接运行：`npx -y @molesignal/cli <命令>`。

## 登录

```bash
npx -y @molesignal/cli login --url https://molesignal.example.com
```

浏览器会打开 MoleSignal，在页面上同意授权即可。登录信息保存在
`~/.config/molesignal/config.json`，只有你本人可读，并会自动续期。

没有浏览器时，可以用在 MoleSignal 中创建的 API Token（**身份与访问 → API tokens**）登录，Token
从标准输入读取：

```bash
printf '%s' "$TOKEN" | npx -y @molesignal/cli login --url https://molesignal.example.com --with-token
```

检查连接：

```bash
npx -y @molesignal/cli status
```

## 查看日志

```bash
molesignal streams                                   # 你能读取的日志数据流
molesignal logs app_logs                             # 最近 15 分钟内最新的 100 条日志
molesignal logs app_logs -f --where "level = 'error'"  # 持续输出新的错误日志，按 Ctrl+C 结束
molesignal logs app_logs -n 1000 --since 2h --json | jq .message
```

每条日志一行：时间、级别、服务和消息。跟随时每 2 秒读一次（`--interval`），并从上一次读取
结束前一点开始读，晚几秒到达 MoleSignal 的日志也会出现，且只出现一次。`--where` 接受针对
数据流字段的 SQL 条件。读取用的是 MoleSignal 的 `query_logs` 工具，所以和 Agent 一样受你的
权限与组织的工具策略约束。

## 在 Agent 工具中使用

Agent 工具会自己启动 `molesignal mcp`。把它添加为 stdio MCP 服务器：

| 工具 | 配置 |
|---|---|
| Claude Code | `claude mcp add molesignal -- npx -y @molesignal/cli mcp` |
| Cursor（`~/.cursor/mcp.json`） | `{"mcpServers": {"molesignal": {"command": "npx", "args": ["-y", "@molesignal/cli", "mcp"]}}}` |
| Codex（`~/.codex/config.toml`） | `[mcp_servers.molesignal]`<br>`command = "npx"`<br>`args = ["-y", "@molesignal/cli", "mcp"]` |
| VS Code（`.vscode/mcp.json`） | `{"servers": {"molesignal": {"type": "stdio", "command": "npx", "args": ["-y", "@molesignal/cli", "mcp"]}}}` |
| Gemini CLI（`settings.json`） | `{"mcpServers": {"molesignal": {"command": "npx", "args": ["-y", "@molesignal/cli", "mcp"]}}}` |

也可以不用保存的登录，而在服务器的环境变量里给出 `MOLESIGNAL_URL` 与 `MOLESIGNAL_TOKEN`，
例如在构建机上。

工具能做什么由 MoleSignal 决定：你的权限、组织的工具策略与审批。这个命令只负责传递消息。

## 命令

| 命令 | 作用 |
|---|---|
| `molesignal login --url <地址>` | 在浏览器中登录 |
| `molesignal login --url <地址> --with-token` | 用从标准输入读取的 API Token 登录 |
| `molesignal status` | 连接一次，说明是哪个服务器在回答、提供多少工具 |
| `molesignal streams` | 列出你能读取的日志数据流 |
| `molesignal logs <数据流>` | 输出数据流最新的日志；`-f` 持续输出新日志，另有 `-n`、`--since`、`--where`、`--interval`、`--json`、`--utc` |
| `molesignal mcp` | 通过 stdio 提供 MoleSignal 的 MCP 工具 |
| `molesignal logout` | 删除保存的登录 |

| 环境变量 | 含义 |
|---|---|
| `MOLESIGNAL_URL` | MoleSignal 地址，代替 `--url` 或保存的地址 |
| `MOLESIGNAL_TOKEN` | API Token，代替保存的登录 |
| `MOLESIGNAL_CONFIG` | 登录信息的保存位置 |
| `NO_COLOR` / `FORCE_COLOR` | 不输出颜色 / 输出到管道时也带颜色 |

需要 Node.js 20 或更高版本。

## 开发

```bash
npm install
npm run check
```

## 许可证

Apache-2.0
