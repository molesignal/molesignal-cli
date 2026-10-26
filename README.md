# molesignal

MoleSignal on the command line: read and follow logs, run SQL and PromQL, draw
traces, sum up services, work incidents and approvals, report deployments and
upload source maps and symbols from CI, call any MoleSignal tool, and serve
MoleSignal's MCP tools over stdio to an AI agent tool such as Claude Code,
Cursor, Codex, VS Code or Gemini CLI.

[简体中文](README.zh-CN.md)

## Install

```bash
npm install -g @molesignal/cli
molesignal --help
```

Each command also runs without installing, as `npx -y @molesignal/cli <command>`.
`molesignal <command> --help` says what a command does and takes.

## Sign in

```bash
molesignal login --url https://molesignal.example.com
```

The browser opens on MoleSignal; approve the sign-in there. Without a browser,
sign in with an API token (**Identity & Access → API tokens**) read from stdin:

```bash
printf '%s' "$TOKEN" | molesignal login --url https://molesignal.example.com --with-token
```

Each sign-in is kept in a profile in `~/.config/molesignal/config.json`,
readable by you only. `--profile <name>` keeps several MoleSignals or
organizations apart; `molesignal profiles` lists them and `molesignal use`
switches. `molesignal doctor` checks the setup: configuration, network and TLS,
proxy (`HTTPS_PROXY`, `NO_PROXY`), clock, sign-in and MCP.

## Read and query

```bash
molesignal logs app_logs -f -q "level = 'error' AND timeout"   # follow, with the Logs page's field query
molesignal logs app_logs --around "2026-10-26 14:03:12" -B 20 -A 20
molesignal query "SELECT level, COUNT(*) FROM app_logs GROUP BY level" --since 1d --csv
molesignal fields app_logs service                              # the most common values of a field
molesignal metrics query 'sum by (service) (rate(http_server_requests_total[5m]))' --since 6h
molesignal traces --service checkout --errors
molesignal traces show 4bf92f3577b34da6a3ce929d0e0e4736         # a waterfall in the terminal
molesignal services compare checkout 2.3.9 2.4.0 --fail-on-regression
molesignal search-jobs submit "SELECT * FROM app_logs WHERE level = 'error'" --since 30d --wait
```

## Incidents and changes

```bash
molesignal incidents                          # the active incidents
molesignal incidents show <incident> --rca
molesignal incidents ack <incident>
molesignal oncall
molesignal approvals                          # approval requests waiting, or approved
molesignal annotate "Release 2.4.0" --tags release --yes
molesignal synthetics run "Checkout API" --wait --yes
```

A change goes through the organization's tool policy, as it does for Mole
Agent: it runs at once, asks to be confirmed (`--yes` confirms ahead of time),
or waits for reviewers (the command exits with 3; `--wait` waits for them).

## In CI

These take an API token in `MOLESIGNAL_TOKEN`:

```bash
molesignal deploy --service checkout --version "$GITHUB_SHA" --env production -- ./deploy.sh
molesignal source-maps upload dist/assets --application checkout-web --service web --release "$VERSION"
molesignal symbols upload build/Checkout.app.dSYM --application checkout-app --service checkout --release "$VERSION"
tail -f app.log | molesignal send app_logs --field service=billing
molesignal run jobs --name nightly-backup -- ./backup.sh
```

`deploy` takes the commit, repository, pull request, author and run link from
GitHub Actions, GitLab CI/CD, Jenkins, CircleCI, Buildkite, Bitbucket Pipelines
or Azure Pipelines. `symbols` reads the build ID of ELF libraries and the UUID of
each architecture of a dSYM, and finds Flutter symbols and R8 mappings by name.

## Any tool

```bash
molesignal tools rum                                # find tools
molesignal call list_rum_sessions --since 1h limit=20
```

## Use it from an agent tool

```bash
molesignal mcp setup claude      # or cursor, codex, vscode, gemini
```

The agent tool then starts `molesignal mcp` itself, which carries every message
to MoleSignal's MCP endpoint and every answer back, and opens a new session when
MoleSignal restarted. What the tools can do is decided by MoleSignal: your
permissions, the organization's tool policy and its approvals.

Instead of a saved sign-in, the server can be given `MOLESIGNAL_URL` and
`MOLESIGNAL_TOKEN` in its environment, as on a build machine.

## Also

`molesignal open <page> [id]` opens a MoleSignal page, and `--web` on `logs`,
`query`, `traces show`, `incidents show` and `services show` opens what they
would print. `molesignal completion bash|zsh|fish` prints a completion script.

| Environment variable | Meaning |
|---|---|
| `MOLESIGNAL_URL` | The MoleSignal address, instead of `--url` or the saved one |
| `MOLESIGNAL_TOKEN` | An API token, instead of the saved sign-in |
| `MOLESIGNAL_PROFILE` | The profile, instead of the current one |
| `MOLESIGNAL_CONFIG` | Where the sign-ins are kept |
| `HTTPS_PROXY` / `NO_PROXY` | A proxy for every request / the hosts reached without it |
| `NO_COLOR` / `FORCE_COLOR` | Print without colours / with colours even into a pipe |

Exit codes: 0 done, 1 failed, 2 a mistake in the command line, 3 a change that
waits for approval.

Requires Node.js 20 or later.

## Develop

```bash
npm install
npm run check
```

## License

Apache-2.0
