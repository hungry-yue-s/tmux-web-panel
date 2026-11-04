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

Node 自己的 API 里不出现 serverId：`/api/workspace`、`/api/metrics/*`、`/api/files/*`、`/api/upload`、`/api/sessions/*`、`/api/session-protection`（会话保护）、`/ws/terminal/:paneId` 等。前端只有一个入口：`Api.nodeUrl(serverId, path)`；终端视图里的旧代码统一调用 `Api.activeUrl(path)`，它会跟随当前查看的服务器（`TerminalTarget.serverId`）。切换服务器时 `TerminalTarget` 会发出 `terminal-target-server` 事件，状态 WebSocket 收到后会重连到新服务器。

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
   - 经转发的 GET/HEAD（无请求体）在收到任何应答前连接被重置时，换新连接再问一次，只用首个请求剩下的时限；写请求、已开始的应答、超时、证书或令牌错误都不重放。
6. **TLS 会话。** 同一转发、同一配对下的两个 Agent 共用一份内存会话缓存，新连接（包括终端升级）可以恢复会话。Node 在恢复的会话上拿不到对端证书，所以只缓存通过了指纹校验的连接产生的会话；一个连接要么出示固定的证书，要么完成了对这种会话的恢复。没有 0-RTT。新转发或重新配对时缓存清空。

### 可选：直连 Node 的 HTTPS

每台服务器可以分别为“终端”和“文件 / Git / 监控”选择 `transport.terminal`、`transport.api`：`ssh`（默认）或 `direct`。`direct` 用 SSH 主机的地址（`ssh -G` 解析别名）加配对文件里的端口，直接连 Node 自己的 HTTPS 监听：

- 只在配对文件声明 TLS 时才会尝试，证书同样按指纹固定，令牌仍只在 Hub；经 ProxyJump/ProxyCommand 的主机不尝试。配对和健康检查仍走 SSH，SSH 仍是必需的。
- 后台先用 `GET /api/node/info` 检查，通过后才使用；检查中、失败时一律走转发，不等待。失败原因只记固定短语（`[node-link] direct path`），不写地址。失败 5 分钟后再检查。
- 直连上的请求在应答前失败：可重放的读改走转发（仍只算一次重试），写请求返回错误；除池化连接被关闭外，其余失败把直连标为不可用。直连上的终端升级在连上之前失败时改走转发（Node 没收到握手，不会出现两个客户端）；握手已发出则只结束这一个 socket。
- 证书不符只让直连不可用，不重置 SSH 链路。
- 前提是 Node 监听在 Hub 能访问的地址上。一键安装的 Node 只监听 127.0.0.1，直连对它不可用；是否改监听地址、开放端口由用户决定，面板不改防火墙。
- 两条路径的对照用 `scripts/measure-node-paths.mjs <serverId>`（在 Hub 机器上运行，自建一条转发，不影响运行中的面板），随机交错的状态 socket ping，输出分位数、>1s 比例和 socket 计数字节数。单路径结果只能作为基线，不能称为对照；测量口径和 Mosh 的未完成验收门槛见 [Mac 验收记录](low-latency-validation.md)。

### 可选：终端走 Mosh（实验）

`transport.terminal = 'mosh'` 时，浏览器仍只连本机 Hub 的 WebSocket；Hub 在本机 PTY 里运行 `mosh-client`，经 UDP 连到 Node 上的 `mosh-server`，后者运行与普通终端相同的 tmux attach。预测回显发生在 Hub 这台机器的 mosh-client 里，所以只在 Hub 靠近浏览器时有意义（桌面客户端自带的面板）；手机连远端 Hub 时，预测发生在那台 Hub，不在手机上。Git、文件、监控照旧走 `transport.api`。

- **只有 Hub 自己能开会话。** `POST/GET/DELETE /api/mosh/sessions[/:id]`（`server/api/mosh.js`）要求 node token 加上只有 Hub 自己的调用才带的 `x-twp-hub-call`；`/n/` 转发会剥掉这个头，`isRelayable` 也拒绝任何拼法的 `/api/mosh`。会话密钥只在 Hub 进程和 mosh-client 的环境里，不进浏览器、日志和诊断。
- **会话 id 由 Hub 生成。** 应答没到也能按 id 结束；结束过的 id 记住 10 分钟，迟到的创建请求被拒；创建请求在应答前断开，Node 立即取消。启动中的会话计入上限。
- **Windows 的 attach 证明。** mosh-server 打印 CONNECT 后才 fork 命令子进程，子进程要等第一个客户端包才 exec tmux。Node 在 CONNECT 时就把端口和密钥交给 Hub，但**客户端启动队列一直持有到** `tmux list-clients` 里出现父进程是这个 mosh-server 的客户端，再等 `CLIENT_SETTLE_MS`；期间按 `holdStart` 计为“启动中”，面板自己的客户端不离开（ENV-3）。20 秒内没有就结束会话并释放队列。面板的新客户端在同一会话上启动前，经 `addClientOwner` 先结束该会话上的 Mosh 客户端，结果不明则 `TERMINAL_BUSY`。
- **结束只针对确认的进程。** `server/mosh/processes.js` 记录 pid、启动时间、可执行文件和（MSYS2 的）Windows pid；命令子进程 exec 后可执行文件和 Windows pid 会变，只按 pid+启动时间认。先结束 tmux 客户端，让 mosh-server 通知客户端后自行退出，再结束 mosh-server，最后才 KILL；仍有残留时报告 `clean: false`。自然退出的会话由定期清扫回收。关机时 `stopAll` 和 Hub 的 `closeAll` 完成后进程才退出。
- **回退规则。** 缺组件、经跳板机、地址解析失败或未看到远端画面时，Hub 先确认本机客户端退出，再请 Node 结束会话；**只有两端确认干净**才转发到 SSH，否则以 503 拒绝。未确认的资源保留完整归属，跨链路换代仍计入 busy 和关机清理，不用新连接覆盖它。已经交给某个传输的输入不会再发给另一个。
- **并发与重检。** 首次未验证的路径按服务器、link 实例和 generation 合并试探，其它新请求等待同一结论并再次检查，避免堆积多个失败的 Windows 接入。失败冷却为 10 分钟；配置变化和显式重新检测可清除已确认干净的负结果，周期健康轮询不清冷却。重试不关闭健康终端，也不清除待确认资源。Hub 客户端查找和 Node 组件能力均会重检，避免安装或移除组件后永久沿用旧结果。
- **状态与预算。** 未验证、验证中、已验证、失败分别报告；只有当前链路的成功证据才标记 Mosh。已有桥接仍健康但新连接需回退或拒绝时单独报告原因。准备阶段在 `MoshTerminals.open` 内共享 15 秒绝对预算（包括 DNS、POST 和最多 8 秒的 contact 等待），清理独立等待实际结果；外层首次 Node/SSH 识别不算入这 15 秒。浏览器显式选择远端 Mosh 时最多等 60 秒，普通 SSH/direct 和本机仍为 20 秒，预算不是人为延迟，也不依赖可能过期的健康快照。极慢的冷启动仍可能耗尽总等待，此时失败并收拢资源，不能假称已完成回退。
- **桥接期间。** WebSocket 使用 ping/pong 判断浏览器是否失联，不按无键盘输入清理。Hub 每 15 秒问 Node 会话是否还在；被接管或已结束就向页面发 exit 并以 1000 关闭（mosh 的结束消息可能丢失）。mosh-client 以 0 退出也以 1000 关闭，其它退出以 1011 让页面重连。
- Windows 不作为 Mosh 客户端（ENV-6）。

通道选择始终按服务器配置，默认仍是 SSH；保存首选通道只影响新连接，地址或认证变化才按原有规则重建链路。设置页中的 Hub 是运行面板服务的机器，不是手机；浏览器、Swift 和移动客户端共用这些规则。无 Node 的基础模式保持 SSH，并明确说明不能采用所选的 direct/Mosh。支持常见 SSH 配置别名（解析实际连接选项，`ProxyJump none` 不误判为跳板）；独立 UDP 公网地址/端口映射、多地址或地址族逐个试连尚未实现，NAT/双栈环境不能据 mock 覆盖宣称真实可用。

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

## 基础模式：能 SSH 登录、没装面板的机器

配对时如果 sftp 报告配对文件不存在（`NODE_NOT_INSTALLED`），这台机器就进入**基础模式**。它照常显示为 online，Hub 为它直接提供两样东西，形状与 Node 完全一致，浏览器不需要做任何区分：

- `/n/:id/api/workspace*`：会话、窗口、窗格的读取和增删改；
- `/n/:id/ws/terminal/:paneId`：终端。

其它机器级接口一律返回 `NODE_NOT_INSTALLED`，界面据此显示“安装面板服务”。代码在 `server/hub/basic/`。

先用一次检测脚本决定用哪种方式：

| 远端情况 | 方式 | 持久性 |
|---|---|---|
| 有 POSIX `sh` 且有 tmux | **远端 tmux**：Hub 用 `sh -s` 执行 tmux 命令，整棵会话树一次读完（`readTree`，用 `;` 串联）；挂接终端时运行一个经 sftp 上传的单词脚本 `.cache/tmux-web-panel/attach-<N>-<zoom>` | 会话在远端 tmux 里，Hub 重启后还在 |
| 没有 tmux，或没有 POSIX shell（cmd/PowerShell） | **Hub 托管的 SSH 终端**（`SshProvider` + `PaneRuntime`）：`ssh -tt host`，不带任何远程命令，直接得到对方的登录 shell | 浏览器刷新不丢；Hub（客户端）退出后结束 |

为什么这样做：Windows OpenSSH 在 pty 模式下会把远程命令不加引号地拼进 shell 命令行，而 cmd、PowerShell、fish、bash 的解析规则又各不相同。所以基础模式只向远端发送两种形式的命令：

- 非交互命令只发 `sh -s` 这两个普通单词，脚本内容走 stdin；
- 交互命令只发一个单词（脚本路径）。

这样不依赖任何登录 shell 的引号规则。

## 一键安装 Node

在基础模式服务器的页面上点“安装面板服务”，由 Hub 发起安装（`server/hub/node-installer.js`，接口为 `POST/GET /api/servers/:id/node/install`）。这是 Hub 唯一一处主动在远端运行程序的地方，必须由用户明确触发。

1. **打包。** 把 Hub 自己的面板代码打包（Linux/macOS 目标还会带上 `vendor/tmux` 源码），经 sftp 上传到 `.cache/tmux-web-panel/panel.tgz`。版本一定与 Hub 一致，远端也不需要能访问 GitHub。
2. **Linux / macOS：** 把 `scripts/remote/install-node.sh` 经 stdin 交给 `sh -s` 执行。
   - 缺少的编译依赖用包管理器安装（apt / dnf / yum / pacman / apk / zypper / brew）。需要 sudo 且没有免密时，返回 `needs_password`，界面向用户索要 sudo 密码。密码只随本次脚本经 stdin 传过去，不写日志也不保存。
   - Node.js 不满 20 时，下载官方二进制包到 `~/.local/share/tmux-web-panel/`，不需要 sudo。
   - 执行 `npm ci --omit=dev`，然后 `NODE_ONLY=1 HOST=127.0.0.1 scripts/install-service.sh install`（会编译项目自带的 tmux）。
3. **Windows：** 把 `scripts/remote/install-node.ps1` 用 `powershell -EncodedCommand` 执行（全是普通字符）。
   - 用 winget 补装 Node.js 和 MSYS2；
   - 执行 `npm ci`；
   - 运行 `install-service.ps1 install -ListenHost 127.0.0.1 -NodeOnly`。
4. **完成。** 安装结束后，Hub 立即重新配对。服务器从基础模式切换到完整模式，远端 tmux 里的会话不受影响。

`NODE_ONLY=1`：这样安装的 Node 没有登录页可用，API 和 WebSocket 只接受 node token。即使同一台机器上有其他用户，他们也无法访问这个 Node 的接口。

## 插件（tmux-agent）

每个 Node 上的插件只操作本机。Hub 上的 MCP 工具收到其它 `serverId` 的调用时，会通过链路 `POST /api/plugins/tmux-agent/tools/:tool` 转给那台机器上的插件。插件在那台机器上校验参数、执行，并检查插件是否启用。`list_servers` 由 Hub 直接回答。

## 不变量

- Node 的 API 不接受 serverId。需要指定别的机器时，一律通过 Hub 的 `/n/:serverId`。
- 已装 Node 的机器，Hub 不在远端执行命令。新增功能只写在 Node 上，远程服务器自动就能用。基础模式只覆盖工作区和终端，不要往里加文件、监控之类的远程脚本，那些功能的入口是“安装 Node”。
- 基础模式下发往远端的只有两种形式：`sh -s`（脚本走 stdin），或单个单词的 pty 命令（经 sftp 上传的脚本路径）。不要拼接带参数的远程命令行。
- 转发入口只认登录令牌。node token 只能用来访问那台 Node 自己的 API，不能用它让一个 Hub 再链式转发到下一台机器。
- 配对文件和 node token 只对本人可读。在 Windows 上用 `icacls` 去掉继承的访问权限。
- 没装面板的机器以基础模式接入。远端 tmux 的会话持久；由 Hub 托管的 shell 只活在 Hub 进程里。

## 和旧方案的区别

旧方案在 Hub 上把每个操作拼成 shell 命令，经 SSH 到远端执行（`OpenSSHExecutor`、健康与监控探测脚本、`ssh -tt` attach、PowerShell/SSH 工作区）。这带来三个问题：

- 每次调用都要在远端新起一个进程：在 Windows 主机上本机回环实测约 400ms。现在经 Hub 读取整个工作区约 70ms。
- 能不能用取决于远端用的是哪种 shell。Windows OpenSSH 在 pty 模式下不给远程命令加引号，fish 和 bash 的引号规则也不同。
- 文件、上传、进程统计、通知、Agent 配置这些功能只有本机有，远程要另写一套才能用。

这些问题在新架构下都不存在了。
