# 管理中心

入口：**设置 → 管理中心**。由当前项目管理面板所在机器的资源；不向已登记的远程服务器安装软件。

更新项目并执行 `npm ci` 后，通过原有 systemd/launchd 服务流程重新加载后端。
此功能没有新的后台服务、数据库或独立插件安装器。首次启动时插件未安装，skill 不会自动写入 agent 目录。

## tmux 运行时

- **构建并安装 / 重新构建** 调用现有 `scripts/build-tmux.sh`，源码来自 `vendor/tmux` 固定子模块。构建依赖仍须按原有安装文档准备，缺失依赖会在日志显示失败。
- 二进制安装到 `~/.local/share/tmux-web-panel/bin/tmux`，上一版本保留为 `tmux.previous`，可在页面回退。
- 构建异步执行，页面显示最近 64 KiB 日志。结果记录在 `~/.config/tmux-web-panel/tmux-build.json`。
- 面板重启后，未记录完成的构建显示“结果待核对”，不会因为文件存在就报告构建成功。
- 构建或回退不重启运行中的 tmux，也不删除其会话。页面版本表示磁盘上的项目二进制版本，不表示运行中的 tmux server 已升级。服务重启仍使用项目原有服务管理方式。
- 不提供一键删除正在使用的 tmux 运行时，避免破坏面板和 companion service。

## tmux 配置

编辑的是 `~/.config/tmux-web-panel/tmux.conf`，默认保留 `set -g exit-empty off`。
“接入自动加载”在 `~/.tmux.conf` 中添加带标记的 `source-file` 区块；取消加载只移除该区块。
用户其他配置保持不变；符号链接形式的 dotfile 仍保留其链接。

保存采用乐观并发检查和原子替换：其他页面或程序改过内容时拒绝覆盖。
每次覆盖已有配置前，备份保存到 `~/.config/tmux-web-panel/backups/`，结果提示具体路径。
保存不等于应用。“应用已保存配置”先通过项目 tmux 的 `source-file -n` 检查语法，再加载片段；它不会启动 tmux server。
语法检查不验证每个选项或外部命令的运行效果，应用失败时可能已有部分设置生效，可使用备份修复后再次应用。

## 插件

首个插件为 `tmux-agent`，支持安装、启用、停用、更新和卸载。当前目录为仓库随附的受控插件目录，不接受任意 URL 或上传代码。

安装将 `plugins/tmux-agent/` 复制到 `~/.config/tmux-web-panel/plugins/` 下的独立版本目录；完成入口校验后才激活。
安装状态持久化在该目录的 `state.json`。更新从当前仓库重新复制并保留启停状态。
停用/卸载立即阻止新的 MCP 请求，不停止已经启动的 tmux 命令，不删除任务日志。

**Agent 接入配置**显示实际面板地址下的 Streamable HTTP MCP URL：

```text
https://你的面板地址/api/plugins/tmux-agent/mcp
```

支持 HTTP MCP 的 agent 可直接连接；页面同时提供 JSON 示例和 skill 下载。
面板启用认证时，客户端请求必须携带 `Authorization: Bearer <面板 token>`；页面导出不包含凭据。
例如 Codex 客户端支持将该端点配置为 HTTP MCP，Claude 等客户端也可使用其 HTTP MCP 接入方式。
自签 HTTPS 证书需要在客户端建立信任，不应关闭全局 TLS 校验。

### 能力和持久性

| 能力 | 工具 | 完成证据 |
|---|---|---|
| 工作区发现 | `list_servers`, `workspace` | 当前 provider 和稳定 ID |
| 窗格管理 | `create_session`, `create_window`, `split_pane`, `label_pane`, `close_pane` | 面板现有 workspace 操作结果 |
| 交互输入 | `read_pane`, `send_text`, `send_key` | 发送结果 + 再次读取确认；不假定 agent 已接收 |
| 持久命令 | `start_command`, `get_job`, `list_jobs`, `wait_job` | 退出码与磁盘日志 |
| Agent 协作 | `send_task`, `get_job`, `wait_job` | 特定 worker 回复标记；不等于独立验证通过 |

命令在执行主机的新 tmux 窗口里运行，任务目录为该主机的
`~/.local/share/tmux-web-panel/agent-jobs/<job-id>/`，包含元数据、输出日志和退出码。
MCP 或面板断开不会结束任务。输出返回最近 64 KiB，完整日志保留在磁盘。
命令默认使用 `sh`，需要 bash 语法时显式调用 bash。

Agent 任务发送到已有窗格，通过唯一标记从最多 2000 行、64 KiB 的 scrollback 收集回复。
输入回显中的标记说明不会被当成完成。若回复在读取前已滚出历史，工具不会虚构成功；长任务宜要求 worker 将结果写入共享文件。
主机重启不能恢复运行中进程的内存状态；原有 resurrect/continuum 负责布局恢复，不等于命令断点续跑。
日志目前不自动清理，任务使用者可按需归档已完成的任务目录。

## Agent Skills

目录由项目维护：

- `tmux-agent`：使用插件管理 tmux 和 worker。
- `tmux-panel`：管理当前项目的运行时、配置、插件和 skill。

安装到面板所在机器的 `~/.codex/skills/` 或 `~/.claude/skills/`，以符号链接指向仓库的 skill 源目录。
项目更新后内容同步生效；移除只删除指向本项目目录的链接。
同名目录或其他来源的链接显示冲突，不能被安装/卸载覆盖。仓库移动后需要重新接入。
远程 agent 可以从插件页下载 SKILL.md，但面板不会代写远程客户端配置。

## 开发和验证

后端 `server/plugins.js` 负责插件生命周期，`server/managed-resources.js` 负责本机资源，均通过现有 `/api` 认证和同源写入保护。
插件业务代码在 `plugins/tmux-agent/server.mjs`，复用现有 WorkspaceService 和 ExecutorPool，本地/SSH 不另建一套连接机制。
MCP 使用官方 `@modelcontextprotocol/sdk`，不自行实现协议。

```bash
npm test
# 额外使用临时独立 tmux socket 验证真实执行，不操作用户会话
TMUX_AGENT_INTEGRATION=1 npx vitest run test/tmux-agent-integration.test.js
```

设计参考了 [bnomei/tmux-mcp](https://github.com/bnomei/tmux-mcp) 的命令跟踪和
[maxto/agent-mux](https://github.com/maxto/agent-mux) 的跨窗格协作思路；此处实现复用本仓库代码，未合并或打包这两个项目的源码。
