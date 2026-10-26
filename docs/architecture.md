# 架构：Hub 与 Node

一台机器装一份 tmux-web-panel，它就是一个 **Node**：只管自己这台机器的 tmux、文件、PTY、监控、通知和 Agent 配置。浏览器打开的那份面板同时是 **Hub**：负责登录和服务器列表，把发给其它机器的请求原样转给那台机器上的 Node。

```
浏览器 ──登录 / 服务器列表──► Hub（你打开的那份面板）
                              │ /n/:serverId/api/...   HTTP，流式转发
                              │ /n/:serverId/ws/...    WebSocket，逐字节转发
              ┌───────────────┼────────────────┐
         Node(local)     Node(win-box)     Node(linux-box) …
     同一套服务；只有 Node 自己调用 tmux、读文件、开 PTY
```

之所以这样设计，是因为每台机器跑的都是同一套代码，所以在 Hub 看来，本机和远程完全一样。远程服务器能用的功能和本机相同，不需要为远程另写一套实现。

## 一条规则：机器上的事都走 `/n/:serverId`

| 路径 | 谁处理 |
|---|---|
| `/api/auth/*`、`/api/servers*`、`/api/plugins*`、`/api/managed-resources*`、`/api/share*`、`/s/:id` | Hub 自己，**永不转发** |
| `/n/local/...` | 本进程：去掉前缀后照常路由 |
| `/n/<其它 id>/api/...`、`/n/<其它 id>/ws/status`、`/n/<其它 id>/ws/terminal/:paneId` | 经该服务器的链路转发到那台机器的 Node |

Node 自己的 API 里不出现 serverId：`/api/workspace`、`/api/metrics/*`、`/api/files/*`、`/api/upload`、`/api/sessions/*`、`/ws/terminal/:paneId` 等。前端只有一个入口：`Api.nodeUrl(serverId, path)`；终端视图里的旧代码统一调用 `Api.activeUrl(path)`，它会跟随当前查看的服务器（`TerminalTarget.serverId`）。切换服务器时 `TerminalTarget` 会发出 `terminal-target-server` 事件，状态 WebSocket 收到后会重连到新服务器。

实现：`server/hub/proxy.js`（`createNodeProxy` / `relayNodeUpgrade`），`public/js/api.js`。

## 链路：SFTP 配对 + 一条 SSH 端口转发

`server/hub/node-link.js` 中的 `NodeLink` 对应一台服务器，`server/hub/link-pool.js` 按 serverId 缓存这些链路。

1. **配对。** Node 启动时写出仅本人可读的 `~/.config/tmux-web-panel/node.json`，内容为 `{ protocol, host, port, tls, tlsFingerprint, token }`（`server/node/identity.js`）。Hub 用 `sftp -b -` 读取这个文件。sftp 是 SSH 的子系统，不经过登录 shell，所以对端是 cmd.exe、PowerShell、fish 还是 bash 都没有影响。
2. **转发。** 起一个常驻的 `ssh -N -L 127.0.0.1:<本地随机端口>:<host>:<port>`，带 `ExitOnForwardFailure=yes`。SSH 只当加密管道用，**从不在远端执行命令**。
3. **请求。** 所有 HTTP 请求和 WebSocket 都走这一个转发（使用 keep-alive agent）。Hub 会去掉浏览器带来的 Authorization、Cookie、Origin、Referer 以及 `?token=`，换成 `Authorization: Bearer <node token>`。
4. **TLS。** 如果 Node 用 HTTPS，Hub 只接受与配对文件中指纹一致的证书。校验发生在 `secureConnect` 阶段，早于任何请求字节，所以证书不对时令牌不会被发出去。
5. **恢复。**
   - ssh 进程退出时丢弃转发，下次请求时重新建立。
   - Node 返回 401 时丢弃配对信息，下次重新读取配对文件（Node 重装后令牌会变）。
   - 转发正常但 Node 没有应答（`NODE_NOT_RUNNING`）时，同样重新读取配对文件，因为端口可能已经变了。

主机密钥仍然走首次信任流程：先 `scan` 再 `trust`，只接受用户确认过的那一个指纹。`StrictHostKeyChecking` 始终为 `yes`。用户名加密码的认证方式通过 askpass 完成，密码不会出现在 argv 和环境变量里（`server/transport/ssh-connection.js`）。

## 健康状态

健康状态只来自一次 `GET /api/node/info`（`server/node/info.js`）：对本机是函数调用，对远程是经过链路的请求。返回的协议版本、面板版本、平台、tmux 版本和能力清单会被映射成 UI 已经认识的状态结构（`statusFromNodeInfo`）。原有的退避、合并探测、generation 防护、按"正在查看的服务器"调整轮询频率，都保留在 `HealthService` 里。

链路层新增的错误码以及对应的修复提示：

| 错误码 | 含义 | 修复动作 |
|---|---|---|
| `NODE_NOT_INSTALLED` | 对方用户目录下没有配对文件 | 在那台机器上安装并启动面板 |
| `NODE_NOT_RUNNING` | 转发正常，但面板服务没有应答 | 启动对方的面板服务 |
| `NODE_AUTH_FAILED` | 令牌被拒，或证书指纹不符 | 稍后自动重新配对 |
| `NODE_INCOMPATIBLE` | 协议版本不一致，或配对文件无效 | 把两边更新到同一版本 |

## 插件（tmux-agent）

每个 Node 上的插件只操作本机。Hub 上的 MCP 工具收到其它 `serverId` 的调用时，会通过链路 `POST /api/plugins/tmux-agent/tools/:tool` 转给那台机器上的插件。插件在那台机器上校验参数、执行，并检查插件是否启用。`list_servers` 由 Hub 直接回答。

## 不变量

- Node 的 API 不接受 serverId。需要指定别的机器时，一律通过 Hub 的 `/n/:serverId`。
- Hub 不在远端执行命令。新增功能只写在 Node 上，远程服务器自动就能用。
- 转发入口只认登录令牌。node token 只能用来访问那台 Node 自己的 API，不能用它让一个 Hub 再链式转发到下一台机器。
- 配对文件和 node token 只对本人可读。在 Windows 上用 `icacls` 去掉继承的访问权限。
- 远端没有运行面板的机器无法接入。旧的“纯 SSH 工作区”已经移除。

## 和旧方案的区别

旧方案在 Hub 上把每个操作拼成 shell 命令，经 SSH 到远端执行（`OpenSSHExecutor`、健康与监控探测脚本、`ssh -tt` attach、PowerShell/SSH 工作区）。这带来三个问题：

- 每次调用都要在远端新起一个进程：在 Windows 主机上本机回环实测约 400ms。现在经 Hub 读取整个工作区约 70ms。
- 能不能用取决于远端用的是哪种 shell。Windows OpenSSH 在 pty 模式下不给远程命令加引号，fish 和 bash 的引号规则也不同。
- 文件、上传、进程统计、通知、Agent 配置这些功能只有本机有，远程要另写一套才能用。

这些问题在新架构下都不存在了。
