# molesignal

MoleSignal 的命令行工具：查看并跟随日志，执行 SQL 与 PromQL，画出链路，汇总服务，处理事件与审批，在 CI 中上报发布、上传 Source Map 与符号，调用任意 MoleSignal 工具，并通过 stdio 提供 MoleSignal 的 MCP 工具，让 Claude Code、Cursor、Codex、VS Code、Gemini CLI 等 AI Agent 工具使用。

[English](README.md)

## 安装

```bash
npm install -g @molesignal/cli
molesignal --help
```

每个命令也可以不安装直接运行：`npx -y @molesignal/cli <命令>`。`molesignal <命令> --help` 说明一个命令及其选项。

## 登录

```bash
molesignal login --url https://molesignal.example.com
```

浏览器会打开 MoleSignal，在页面上同意授权即可。没有浏览器时，可以用 API Token（**身份与访问 → API tokens**）登录，Token 从标准输入读取：

```bash
printf '%s' "$TOKEN" | molesignal login --url https://molesignal.example.com --with-token
```

每个登录保存在 `~/.config/molesignal/config.json` 中的一个 profile 里，只有你本人可读。`--profile <名称>` 区分多个 MoleSignal 或组织；`molesignal profiles` 列出它们，`molesignal use` 切换。`molesignal doctor` 检查配置、网络与 TLS、代理（`HTTPS_PROXY`、`NO_PROXY`）、时钟、登录和 MCP。

## 查看与查询

```bash
molesignal logs app_logs -f -q "level = 'error' AND timeout"   # 跟随日志，字段查询与日志页面相同
molesignal logs app_logs --around "2026-10-26 14:03:12" -B 20 -A 20
molesignal query "SELECT level, COUNT(*) FROM app_logs GROUP BY level" --since 1d --csv
molesignal fields app_logs service                              # 字段最常见的值
molesignal metrics query 'sum by (service) (rate(http_server_requests_total[5m]))' --since 6h
molesignal traces --service checkout --errors
molesignal traces show 4bf92f3577b34da6a3ce929d0e0e4736         # 在终端画出瀑布图
molesignal services compare checkout 2.3.9 2.4.0 --fail-on-regression
molesignal search-jobs submit "SELECT * FROM app_logs WHERE level = 'error'" --since 30d --wait
```

## 事件与变更

```bash
molesignal incidents                          # 进行中的事件
molesignal incidents show <事件> --rca
molesignal incidents ack <事件>
molesignal oncall
molesignal approvals                          # 等待中或已批准的审批请求
molesignal annotate "Release 2.4.0" --tags release --yes
molesignal synthetics run "Checkout API" --wait --yes
```

变更与 Mole Agent 一样经过组织的 Tool Policy：立即执行、需要确认（`--yes` 预先确认），或等待审批人（命令以 3 退出；`--wait` 等待审批）。

## 在 CI 中使用

以下命令需要 `MOLESIGNAL_TOKEN` 中的 API Token：

```bash
molesignal deploy --service checkout --version "$GITHUB_SHA" --env production -- ./deploy.sh
molesignal source-maps upload dist/assets --application checkout-web --service web --release "$VERSION"
molesignal symbols upload build/Checkout.app.dSYM --application checkout-app --service checkout --release "$VERSION"
tail -f app.log | molesignal send app_logs --field service=billing
molesignal run jobs --name nightly-backup -- ./backup.sh
```

`deploy` 从 GitHub Actions、GitLab CI/CD、Jenkins、CircleCI、Buildkite、Bitbucket Pipelines 或 Azure Pipelines 中读取提交、代码仓库、PR、发布人和运行链接。`symbols` 读取 ELF 动态库的 Build ID 和 dSYM 每个架构的 UUID，并按文件名识别 Flutter Symbols 与 R8 Mapping。

## 任意工具

```bash
molesignal tools rum                                # 查找工具
molesignal call list_rum_sessions --since 1h limit=20
```

## 在 Agent 工具中使用

```bash
molesignal mcp setup claude      # 或 cursor、codex、vscode、gemini
```

之后 Agent 工具会自己启动 `molesignal mcp`：它把每条消息转给 MoleSignal 的 MCP 端点，再把回复带回来；MoleSignal 重启后会自动建立新会话。工具能做什么由 MoleSignal 决定：你的权限、组织的 Tool Policy 与审批。

也可以不用保存的登录，而在服务器的环境变量里给出 `MOLESIGNAL_URL` 与 `MOLESIGNAL_TOKEN`，例如在构建机上。

## 其他

`molesignal open <页面> [ID]` 在浏览器中打开 MoleSignal 页面；`logs`、`query`、`traces show`、`incidents show` 和 `services show` 带 `--web` 时打开本要输出的内容。`molesignal completion bash|zsh|fish` 输出补全脚本。

| 环境变量 | 含义 |
|---|---|
| `MOLESIGNAL_URL` | MoleSignal 地址，代替 `--url` 或保存的地址 |
| `MOLESIGNAL_TOKEN` | API Token，代替保存的登录 |
| `MOLESIGNAL_PROFILE` | 使用的 profile，代替当前 profile |
| `MOLESIGNAL_CONFIG` | 登录信息的保存位置 |
| `HTTPS_PROXY` / `NO_PROXY` | 每个请求经过的代理 / 不经过代理的主机 |
| `NO_COLOR` / `FORCE_COLOR` | 不输出颜色 / 输出到管道时也带颜色 |

退出码：0 成功，1 失败，2 命令行写错，3 变更在等待审批。

需要 Node.js 20 或更高版本。

## 开发

```bash
npm install
npm run check
```

## 许可证

Apache-2.0
