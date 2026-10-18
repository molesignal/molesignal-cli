# molesignal

MoleSignal on the command line: sign in to a MoleSignal instance, read and
follow the logs of a stream, and serve MoleSignal's MCP tools over stdio, so that
an AI agent tool such as Claude Code, Cursor, Codex, VS Code or Gemini CLI can
use them.

[简体中文](README.zh-CN.md)

## Install

```bash
npm install -g @molesignal/cli
molesignal --help
```

Each command also runs without installing, as `npx -y @molesignal/cli <command>`.

## Sign in

```bash
npx -y @molesignal/cli login --url https://molesignal.example.com
```

The browser opens on MoleSignal; approve the sign-in there. The sign-in is kept
in `~/.config/molesignal/config.json`, readable by you only, and renews itself.

Where no browser is at hand, sign in with an API token created in MoleSignal
(**Identity & Access → API tokens**), read from stdin:

```bash
printf '%s' "$TOKEN" | npx -y @molesignal/cli login --url https://molesignal.example.com --with-token
```

Check the connection:

```bash
npx -y @molesignal/cli status
```

## Read logs

```bash
molesignal streams                                   # the log streams you can read
molesignal logs app_logs                             # the newest 100 logs of the last 15 minutes
molesignal logs app_logs -f --where "level = 'error'"  # keep printing new errors until Ctrl+C
molesignal logs app_logs -n 1000 --since 2h --json | jq .message
```

Each log is one line: its time, level, service and message. A follow reads again
every 2 seconds (`--interval`), from a little before the last read, so that a log
which reaches MoleSignal a few seconds late still appears, once. `--where` takes
an SQL condition on the stream's fields. The reads are MoleSignal's `query_logs`
tool, so your permissions and the organization's tool policy apply as they do
for an agent.

## Use it from an agent tool

The agent tool starts `molesignal mcp` itself. Add it as a stdio MCP server:

| Tool | Configuration |
|---|---|
| Claude Code | `claude mcp add molesignal -- npx -y @molesignal/cli mcp` |
| Cursor (`~/.cursor/mcp.json`) | `{"mcpServers": {"molesignal": {"command": "npx", "args": ["-y", "@molesignal/cli", "mcp"]}}}` |
| Codex (`~/.codex/config.toml`) | `[mcp_servers.molesignal]`<br>`command = "npx"`<br>`args = ["-y", "@molesignal/cli", "mcp"]` |
| VS Code (`.vscode/mcp.json`) | `{"servers": {"molesignal": {"type": "stdio", "command": "npx", "args": ["-y", "@molesignal/cli", "mcp"]}}}` |
| Gemini CLI (`settings.json`) | `{"mcpServers": {"molesignal": {"command": "npx", "args": ["-y", "@molesignal/cli", "mcp"]}}}` |

Instead of a saved sign-in, the server can be given `MOLESIGNAL_URL` and
`MOLESIGNAL_TOKEN` in its environment, as on a build machine.

What the tools can do is decided by MoleSignal: your permissions, the
organization's tool policy and its approvals. The command only carries the
messages.

## Commands

| Command | What it does |
|---|---|
| `molesignal login --url <address>` | Signs in in the browser |
| `molesignal login --url <address> --with-token` | Signs in with an API token read from stdin |
| `molesignal status` | Connects, and says which server answered and how many tools it offers |
| `molesignal streams` | Lists the log streams you can read |
| `molesignal logs <stream>` | Prints the newest logs of a stream; `-f` keeps printing new ones, `-n`, `--since`, `--where`, `--interval`, `--json`, `--utc` |
| `molesignal mcp` | Serves MoleSignal's MCP tools over stdio |
| `molesignal logout` | Forgets the saved sign-in |

| Environment variable | Meaning |
|---|---|
| `MOLESIGNAL_URL` | The MoleSignal address, instead of `--url` or the saved one |
| `MOLESIGNAL_TOKEN` | An API token, instead of the saved sign-in |
| `MOLESIGNAL_CONFIG` | Where the sign-in is kept |
| `NO_COLOR` / `FORCE_COLOR` | Print without colours / with colours even into a pipe |

Requires Node.js 20 or later.

## Develop

```bash
npm install
npm run check
```

## License

Apache-2.0
