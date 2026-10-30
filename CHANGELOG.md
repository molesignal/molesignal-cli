# Changelog

## Unreleased

- **Alert rules as files.** `alerts rules export` writes the alert rules as a
  bundle that names escalation policies and child rules; `alerts rules apply`
  applies such a bundle or a Prometheus alerting rule file, tried first,
  written at once, exiting with 1 when a rule fails.
- **Escalation policies, schedules and routing rules as files.**
  `alerts policies|schedules|routing export|apply` do the same for them; users
  are named by email, policies, schedules, teams and holiday calendars by name.
- **Incidents opened by hand.** `incidents create --title …` opens an incident
  with a severity, priority, urgency, services and labels, routed like an alert
  or paging a team, a policy or people; it goes through the tool policy as
  `ack` and `resolve` do.

## 0.2.0

- **PromQL search jobs at a step.** `search-jobs submit --promql --step 1m` reads
  a point every step. MoleSignal no longer derives the step from `--limit`:
  without `--step` a PromQL job reads the value at the end of the window.

## 0.1.0

First release of the `molesignal` command, for Node.js 20 and later.

- **Sign-in.** `login` in the browser (OAuth with PKCE) or with an API token,
  named profiles (`--profile`, `MOLESIGNAL_PROFILE`, `profiles`, `use`),
  `logout`, `status`, `whoami` and `doctor`. Requests go through `HTTPS_PROXY`
  when it is set.
- **Logs and queries.** `streams`, `logs` (newest first or `-f`, field queries,
  a time range, the lines around one), `query` (SQL as a table, CSV or JSON),
  `fields`, `metrics` (PromQL), `traces` (with a waterfall), `services` (with
  two versions compared) and `search-jobs`.
- **On-call and changes.** `incidents`, `oncall`, `approvals`, `annotate` and
  `synthetics`. Changes go through MoleSignal's approvals; `--wait` waits for
  them.
- **Releases and data, with an API token.** `deploy` reports a deployment and
  can run the deploy command; `source-maps` and `symbols` upload what RUM needs
  to read stack traces; `send` and `run` write lines into a log stream.
- **Agent tools.** `mcp` serves MoleSignal's MCP tools over stdio, and
  `mcp setup` adds it to Claude Code, Cursor, Codex, VS Code or Gemini CLI;
  `tools` and `call` reach every tool from the shell.
- `open` opens a MoleSignal page, and `completion` prints bash, zsh and fish
  completions.
