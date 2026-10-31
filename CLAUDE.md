# CLAUDE.md

通用 Agent 工作流程（含任务完成后自动提交与推送）见 [AGENTS.md](AGENTS.md)，执行本文件时同样遵守。

## 服务管理

**严禁使用 systemd 以外的方式启停服务。**

- 重启：`systemctl --user restart tmux-web-panel`
- 状态：`systemctl --user status tmux-web-panel`
- 日志：`journalctl --user -u tmux-web-panel -f`

禁止的操作：
- `kill` / `pkill` 进程后手动 `node server/index.js`
- `nohup node server/index.js &`
- 任何绕过 systemd 的手动启动方式

原因：systemd service 配置了 TLS 证书、认证凭据、HTTP 跳转端口等环境变量。手动启动会丢失这些配置，导致 HTTPS 不可用、认证失效。

**静态文件改动不需要重启。** `server/static-assets.js` 挂载 `public/`：HTML 每次都校验（`no-cache` + ETag），并在渲染时把本地 JS/CSS/字体 URL 改写成带内容哈希的 `?h=...`，这些 URL 可缓存一年。所以改 `public/js/*` 或 `public/css/*` 后用户刷新浏览器即生效，不再需要手动改 `?v=`——只有改 `server/*` 才需要 `systemctl --user restart`。动态加载的本地资源不经过改写，只走 `no-cache` 校验。

**终端字体按 unicode-range 切片。** 完整字体每个字重约 6 MB，页面不得预载或引用 `TmuxPanelMono-*.woff2`（它们只是 `scripts/build-font-subsets.mjs` 的输入）。首屏只预载核心片。字体和渲染器都在打开终端 socket 之前定好，attach 带的就是最终网格（`_mountTerminal` 的 `rendererReady`），不要改回首个输出之后再换字体：那会改变网格，在 Windows 上等于再 attach 一次并清屏。终端最多等核心片 `CORE_FONT_WAIT_MS`，超时后这次挂载保持系统等宽字体，核心片晚到也不自动切换（`_applyLateCoreFont`），要等下一次真实尺寸变化或下一次挂载才用上。中文和 Nerd 图标片由 `public/js/terminal-fonts.js` 按需加载：xterm 画在 canvas 上不会触发 unicode-range 加载，必须经 `TerminalFonts.ensure()`，切片到达后调用 `term.clearTextureAtlas()`。切片和 `public/css/terminal-fonts.css`、`public/js/terminal-fonts-data.js` 都是生成文件，只有源字体变化时才重新生成并提交。

**Windows** 上服务管理器是计划任务（`\tmux-web-panel\tmux-web-panel` 与 `\tmux-web-panel\tmux-server`），统一经 `scripts/install-service.ps1` 操作：`restart` / `status` / `logs`（加 `-Tmux` 针对 tmux server）。同样禁止手动 `node server/index.js` 或直接 `Stop-Process` 后自行启动——AUTH/TLS/端口配置在 `%USERPROFILE%\.config\tmux-web-panel\windows-service.json`，只由 `scripts/windows/run-panel.ps1` 注入。`restart -Tmux` 会结束 tmux server 和所有会话；只更新包装脚本 `run-tmux-server.ps1` 时用 `reload`，它不碰 tmux。

## 多服务器：Hub 与 Node

完整说明见 [docs/architecture.md](docs/architecture.md)。每份安装都是一个 Node，只管本机；浏览器所用的那份面板同时是 Hub，经 `/n/:serverId` 把机器相关的请求原样转给对应的 Node。

不变量：

- **Node 的 API 不带 serverId**（`/api/workspace`、`/api/metrics/*`、`/api/files/*`、`/ws/terminal/:paneId` 等）。要访问其它机器，一律走 Hub 的 `/n/:serverId`（`server/hub/proxy.js`）；前端统一用 `Api.nodeUrl` / `Api.activeUrl` 拼路径，不要再写死 `/api/servers/:id/...` 这种按服务器分的机器接口。
- **对已装 Node 的机器，Hub 不在远端执行命令**。SSH 只用来做两件事：sftp 读取配对文件 `~/.config/tmux-web-panel/node.json`，以及维持一条 `ssh -N -L` 端口转发（`server/transport/ssh-connection.js`、`server/hub/node-link.js`）。新功能只在 Node 上实现，远程服务器就会自动拥有。
- **基础模式**（能 SSH 登录、没装面板，`server/hub/basic/`）只提供工作区和终端。发往远端的只能是 `sh -s`（脚本走 stdin），或单个单词的 pty 命令（经 sftp 上传的脚本路径）；不要拼接带参数的远程命令行，因为 Windows OpenSSH 在 pty 模式下会把它拆碎。文件、监控等功能不要在基础模式里另写远程实现，那些功能的入口是“安装 Node”（`server/hub/node-installer.js`、`scripts/remote/install-node.*`）。
- **只在 Hub 上处理、不转发的接口**：`/api/auth`、`/api/servers`、`/api/plugins`、`/api/managed-resources`、`/api/share`（`isRelayable` / `Api.isHubPath` 两处须一致）。
- **node token**（配对文件里的令牌）只能用来访问那台 Node 自己的 API。`/n/` 转发入口只接受登录令牌，防止一个 Hub 经另一个 Hub 链式转发。
- HTTPS Node 按配对文件里的证书指纹固定，升级请求（WebSocket）也走同样的固定证书 agent（`pinnedAgent`）；不要退回 `rejectUnauthorized: false` 却不校验指纹。

## tmux server 守护与会话持久化

Linux 使用用户级 `tmux-server.service`，macOS 使用 `com.tmux-web-panel.tmux-server.plist`；它们都由 `install-service.sh` 生成在用户服务目录中。这是为了让重启电脑后网页面板立刻能看到上次保存的会话。

工作链路：
1. 开机 → tmux companion service 跑 `tmux start-server`（macOS 为前台模式 `tmux -D`，Windows 为 `setsid -w tmux -D`）→ 加载 `~/.tmux.conf`
2. 面板服务启动，“会话保护”（`server/session-protection/`）每 20 秒看一次 tmux：第一次看到某个 server 实例时，如果它没有会话或刚启动（2 分钟内），就用 `last` 快照自动恢复它还缺的 sessions/windows/panes，并在该 server 上记下 `@twp-restored-at`（页面据此提示“已自动恢复”）
3. 面板每 5 分钟调用项目自带的 tmux-resurrect（`vendor/tmux-plugins/tmux-resurrect`）的 `save.sh` 保存；快照仍是 resurrect 标准格式，在 `~/.local/share/tmux/resurrect/`
4. 网页打开 → `server/tmux.js` 的 `listSessions()` 跑 `tmux list-sessions`，看到所有 restored 会话

设置在每台服务器的“会话”页面（`/api/session-protection`，经 `/n/:serverId` 远程同样可用），存于 `~/.config/tmux-web-panel/session-protection.json`。不用 tmux-continuum，也不需要往 `~/.tmux.conf` 加插件配置。

不变量：

- **部署必须使用 `vendor/tmux` 子模块构建的 tmux**：`install-service.sh install` 会调用 `scripts/build-tmux.sh`，原子部署到 `~/.local/share/tmux-web-panel/bin/tmux`，不得退回系统 `PATH` 中的 tmux
  - 唯一例外是 Windows：使用 MSYS2 打包的 tmux（`C:\msys64\usr\bin\tmux.exe`，带 MSYS 运行时补丁），由 `server/msys.js` 解析；tmux 进程必须带 `MSYS=noglob`，否则 MSYS 会把 `#{session_id}` 这类参数做花括号展开。pane 路径是 MSYS 路径（`/home/me`、`/c/...`），读写文件前经 `toNativePath` 转换
- **`~/.tmux.conf` 必须保留 `set -g exit-empty off`**：否则开机启动的空 server 等不到面板来恢复就自己退出了
- **不要在 `tmux-server.service` 里预创建会话**（如 `tmux new-session -d -s main`）：同名会话不会被恢复，启动超过 2 分钟后才看到的 server 也不再恢复
- **Windows 上不得 resize 运行中的 tmux 客户端，也不得用 node-pty 的 `kill` 关闭它**：两者都可能带走整个 tmux server 和所有会话（`docs/known-issues.md` ENV-1）。尺寸变化走 `TerminalManager._setClientSize`（新客户端替换旧的），断开走 `_endClient`（只结束客户端进程），`conhost.exe` 由 `ConsoleReaper` 延后回收
- **Windows 上面板的 tmux 客户端一次只变更一个**：server 逐字节读新客户端的终端应答，这期间有客户端离开（别的会话的也算）就可能丢字节，剩下的会当按键进窗格（`docs/known-issues.md` ENV-3）。所以新接入和替换都排队经 `TerminalManager.whenClientCanStart` / `_inClientTurn`：确认旧客户端的进程已消失才启动，启动窗口内不结束别的客户端（`_endClient` 排队）。不要改回先启动新的、靠 `-d` 踢旧的；换 ConPTY DLL 也不是修复，实测同样漏。排队期间已取消的请求不得产生任何副作用。结束后超时仍活着就让接入失败并可重试（`TERMINAL_BUSY`，关闭码 1011），不并排启动；不要对同一个 pid 再结束一次（可能已被复用），只等 `onExit` 或确认 pid 已不存在。`onExit` 之后任何路径都不得再结束它
- **Windows 上被接管的连接立即失效，不等 `onExit`**：`onExit` 可能比进程消失晚约 1 秒，这段时间里旧 socket 的 resize 会反过来把会话抢回去。`_takeOver` / `_retire` 立刻把连接移出 `connections`、关闭 socket（接管用 1000，页面不再重连），`_leaving` 等待和 `onExit` 里的释放照常进行；消息入口先校验连接仍有效
- **客户端变更期间的输入留给下一个客户端**：网关的 `early`（接入前）和连接的 `heldInput`（从接受一次改变尺寸的 resize 起，到新客户端建立或尺寸改回）都只投递一次，总量受 `MAX_HELD_INPUT_BYTES` 限制，超过就以 1009 关闭并清空。不要把输入写给马上要结束的客户端。已经写入的，`_killClient` 按字节数等 server 读完（`INPUT_READ_*`，有上限）：这是尽力保护，不保证长粘贴，也不是 DA 问题的修复，不要拿它替代排队；没写过输入的客户端不等
- **Windows 上新窗格依赖 tmux 全局环境里的 `MSYS2_PATH_TYPE=inherit`**：没有它，MSYS2 登录 shell 会把 PATH 重置到最小集，窗格里找不到 claude、Node、Git（`docs/known-issues.md` ENV-2）。`run-tmux-server.ps1`、`server/msys.js` 和会话保护的 `_applyOptions` 三处保证，不要去掉
- **Windows 上结束终端控制台要能证明没人在用**：`conhost.exe` 只能按 `pty.spawn` 的精确时间窗认领，不加余量（实测 30 个全部落在窗内）。进程里每个 `pty.spawn` 都必须经 `trackConsoleSpawn`（`server/terminal/console-reaper.js`），它把时间窗记到 pty 退出；一个控制台还可能属于活着的 pty、或一个窗里不止一个控制台，就不结束。宁可漏清，不扩大窗口，也不要批量清理来历不明的 `conhost.exe`
- **环境问题要记录并由服务管理**：现象、证据和结论写进 `docs/known-issues.md`，检测和恢复做进服务，不靠人工救场。不要在默认 tmux server 上做接入、resize、断开实验，一律用 `tmux -L` 或 `TMUX_TMPDIR`
- **没有会话时绝不保存**：那次空快照会成为 `last`，下次重启就什么也恢复不了。`save.sh` 只能由 `SessionProtection` 在有会话时调用
- **用户自己在 `~/.tmux.conf` 里加载了 tmux-resurrect（常见于 TPM + continuum）时，面板不自动保存和恢复**（`mode: 'external'`），只提供立即保存和找回会话，避免两套机制互相覆盖或重复恢复
- **从 Windows 的 Node 调 MSYS2 程序（tmux）必须用 `msysExecArgs`**（`server/msys.js`）：Node 默认把 `"` 转义成 `\"`，MSYS 不认，布局字符串、带引号的命令或名字会被拆碎
- **`server/tmux.js` 的 `listSessions()` 是只读**：不会自动创建/启动 tmux server。如果 server 不存在，网页就是空——这是设计意图，恢复责任在 companion service + 会话保护

排障：

- 启停 tmux server：`systemctl --user {start,stop,restart} tmux-server`
- 手动 `tmux kill-server` 后 unit 重启会拉起空 server，面板在下一次检查（≤20 秒）时自动恢复；也可以在“会话”页面的“找回会话”里按时间点恢复单个会话（作为新会话，不影响正在运行的）
- 只恢复窗口结构、目录，并按页面上勾选的程序重新打开（claude 用 `--continue`、codex 用 `resume --last` 接着上次的对话）；不恢复进程内存状态

## 终端首屏契约

打开一个窗口要尽快到稳定画面，最贵的是无谓的第二次 attach：Windows 上换尺寸就是换 tmux 客户端并清屏重画。所以：

- **先定尺寸，再开 socket。** 字体（见上）、WebGL 渲染器、右侧分窗占位都在 `connectTerminalWs` 之前定好。分窗恢复时立刻按保存的宽度占位（`_reserveDockSpace`），标签内容随后异步加载；保存为隐藏的分窗全程在 DOM 外构建，不得占位。`renderTerminal` 即使拿到已知窗格也要异步挂载，这样 `MsApp._mountTerminal` 同步设置分窗后，终端量到的才是最终宽度。
- **能不等就不等。** 工作区里已有目标窗格时直接挂载（`MsApp._knownPanes`），超过 `PANES_FRESH_MS` 或来自不完整读取的，在后台再核对一次；缺失或读取失败才阻塞查询。服务端挂载前的 `resolvePane` 不能省。
- **过时结果不落地。** `MsApp._routeGeneration` 每次路由递增，所有在 await 之后继续的路由入口（`_renderTerminal`、`refreshCurrentTerminal`、`server` 路由）都要校验，过时就不得写 DOM、`TerminalTarget`、`state` 或分窗。同一目标重复路由时如果 `isTerminalLive()` 就不重建。
- **工作区请求合并。** 路由和读取用 `refreshWorkspace(id, { shared: true })`；刚做完修改的调用方不能加 `shared`，那次进行中的读取可能早于修改。服务端 `getWorkspace` 同样单飞，`_mutate` 后作废。一次 `readSnapshot` 就读完整棵树和实例 ID；窗口缺窗格、读取失败都必须 `complete: false`，否则分窗和 block 的回收会误删。
- **取消一路到底。** 浏览器走了就不能再 attach：`attach-session -d` 会抢走当前画面。前端 `_cleanupTerminalResources` 关闭 pending socket 和重试定时器；`TerminalGateway.handle`、`attachBasicTerminal`、`TerminalManager.create` 和 Hub 的 `relayNodeUpgrade`、`proxyUpgrade` 都要在继续前检查 socket 还活着。升级中的 socket 要 `watchUpgradeSocket` 才能发现对端离开。
- **等待都有上限，但只限等待本身。** `Api.request` 默认读 45 秒、写 5 分钟，长传输不走它。`NodeLink` 的 `stallGuard` 分别限制排队、连接和等响应头；只有连接超时才判定转发已死并丢弃隧道，排队超时只取消那一个请求，开始传输后不限时。TLS 固定指纹和认证不因此放宽。终端 socket 收到任何帧后不得盲目重试。
- **一次失败的请求不能判隧道死刑。** 隧道一断，上面所有终端和下载都跟着断。健康探针 `NodeLink.info()` 失败后在新连接上再确认一次，还不通才 `reset`；只有这个只读探针重试，写请求和转发请求都不重试，401 和证书变化不需要第二次确认。凡是 `await` 之后要 `reset` 的地方都用 `_resetIfCurrent(tunnel, …)`，旧隧道的迟到结果不得影响新隧道。每次隧道失效 `logLinkLost` 记一行（时间、`serverId`、原因、错误码、退出码或信号），不写 URL、请求头、令牌、SSH 参数或 stderr。
- `public/js/terminal-trace.js` 记录每次打开的时间线（`TerminalTrace.enable()` 开启，`.last()` 读取），默认关闭，只存时间、网格和计数。`marks.stable` 是启发式，验收以真实界面截图和独立时序为准。

## 移动端工具盘交互契约

移动输入工具台 + 底部工具盘（drawer）在 `public/js/terminal.js` 的 `_createFabPanel` 和 `public/js/fab-drawer.js` 中实现；`.fab-tool` 保留为工具触发器的兼容类。修改时必须尊重以下约定：

- **软键盘与工具盘互斥**：xterm 的 `.xterm-helper-textarea` focus = 系统软键盘唤起的唯一信号。`document.addEventListener('focusin', ...)` 哨兵监听：drawer open 且 focus 命中 textarea 时自动 `toggleDrawer(false)`。不要引入绕过这个哨兵的 focus 调用。
- **iOS 手势上下文**：`term.focus()` 必须在用户 tap 的 touchend/click 回调里**直接同步调用**——塞进 `setTimeout` 会让 iOS Safari 判定非用户手势而拒绝唤起软键盘。
- **抽屉按键不退出**：工具盘里按键发送后 drawer 保持打开（像软键盘一样）。只有 ×、backdrop、或终端 focus 会关闭。不要在按键处理里加 `toggleDrawer(false)`。
- **不要恢复已删的 FAB popup 面板**：`.fab-panel` / `togglePanel` / `positionPanel` / `_startVoice` / `_stopVoice` 等已全部移除。“工具”按钮点击直接开 drawer，操作台在正常布局中占位，不能遮挡终端。

## 桌面端选中复制契约

`~/.tmux.conf` 是 `set -g mouse on`，所以 xterm 会把所有左键拖动转发给 tmux，并**关掉自己的本地选区**（`_selectionService.disable()`）。tmux 收到后再分流：进 copy-mode，**或**——如果 pane 里跑着抢鼠标的程序（claude/vim/htop/带 mouse 的 less）——直接把拖动透传给那个**程序**。程序的弱/无文本选择就是"选几个字符就断"的来源，**在原生终端里同样会断**（"tmux 内部异常时浏览器也异常"），因为这是 tmux 的路由，不是网页面板的问题。

两条选择路径，改动时不要混淆：

- **裸拖（plain drag）= tmux copy-mode / 或被 pane 内程序吃掉**：copy-mode 高亮是 tmux 服务端画的反显，松手 `MouseDragEnd1Pane send -X copy-selection-and-cancel` → OSC 52 → `server/terminal.js` 的 `extractOsc52` 拦截 → 浏览器剪贴板。不要再并行调用 `pbcopy`，否则异步 pasteboard 写入可能在浏览器成功后把剪贴板覆盖为空。copy-mode 是**按 pane 隔离**的（拖到 pane 边界就停，是正确行为）。pane 跑抢鼠标程序时裸拖根本进不了 copy-mode。
- **修饰键拖动 = xterm 本地选区（绕开 tmux 和程序）**：靠 `macOptionClickForcesSelection`（`createTerminalInstance`）打开。**Mac 用 Option/Alt+拖动，Linux/Win 用 Shift+拖动**。这是原生终端里"按 Shift 绕过程序鼠标"的网页等价物，不受重绘/边缘/copy-mode 状态影响，但只覆盖可见视口（不含 tmux 滚动历史）。

不变量：

- **`macOptionClickForcesSelection` 只在 zoom/tab 模式开（`!nozoom`）**：tab 模式 xterm 只渲染单个 zoom 后的 pane，本地线性选区干净。**split（nozoom）模式必须关掉它**——此时网格里是整个窗口的所有 pane + 边框，xterm 的**线性选区不认 pane**，Option+拖动会越过 `│` 边框选到隔壁 pane（垃圾）。split 模式只能用 tmux 自己的按-pane copy-mode（裸拖 / 键盘 `prefix + [`）。
- **Mac 删不得**：Mac 上 xterm 的 `shouldForceSelection` 是 `altKey && macOptionClickForcesSelection`，没这选项 Mac 就再没有任何键能本地选区（**Shift 在 Mac 被忽略，还会把 SGR 按钮码 32→36 连 tmux 也不认**）。Linux/Win 用 Shift，该选项 no-op。`shouldColumnSelect` 在该选项开时会被 xterm 自动禁用，所以 Option+拖动是普通线性选区、不是矩形选区。
- **本地选区靠 `mouseup` 复制**：xterm 选区在 canvas 上、非 DOM 文本，Cmd/Ctrl+C 抓不到，所以 `connectTerminalWs` 里给 `term.element` 挂了 `mouseup` → `term.getSelection()` → `_copyToClipboard`。裸拖 / split 模式时 xterm 选区为空，所以**不会与 OSC 52 双重复制**，split 模式下自动失效。
- **mouseup 复制限桌面**（`window.innerWidth >= 768`）：移动端有自己的长按选择 + Copy 按钮 UI，不走这条。
- 别给 Mac 用户建议"按 Shift 选择"——那是 Linux/Win 的行为，Mac 上无效。任何平台/任何模式下最可靠的是键盘 copy-mode：`prefix + [` → `v` 选 → `y` 复制（按 pane，且走 OSC 52）。

## 文件预览分窗契约

`public/js/file-preview.js` 的文件预览分成两个层次：新文件始终先进入 modal；用户点击“在右侧分栏打开”后，才把当前 `.fp-modal` 移入右侧 `.fp-dock` 并新增/激活 Tab。

- 分窗 Tab 按绝对路径去重；同一路径再次加入时激活已有 Tab，不复制。
- 每个 Tab 保存自己的 modal DOM、文件信息、pane ID、目录上下文、滚动和渲染状态；切换 Tab 不重新请求或重新渲染。
- “隐藏右侧预览”只收起分窗，不销毁 Tab；右侧恢复按钮负责重新展开。关闭最后一个 Tab 才销毁分窗。
- 分窗最小宽度为 320px，最大为扣除侧栏后可用工作区的 70%，不再设 820px 固定上限；左侧 12px resize 热区负责拖拽，保存值恢复、键盘调宽及窗口缩放时必须统一 clamp，至少为终端保留 30% 的共享空间。
- 分窗存在时点击其中的目录项/文件链接，仍必须先弹出 modal，不能直接覆盖当前 Tab。
- 导航离开 terminal 时 `FilePreview.closeDocked()` 会销毁整组分窗 Tab；普通 modal 的关闭语义保持独立。

Git、浏览器等工具 block 与文件共用这个分窗（同一个标签条、宽度和隐藏按钮），不要再做第二个右侧栏：

- 分窗归 `file-preview.js` 所有；`public/js/block-host.js` 只通过 `FilePreview.blockDock.sync()` 声明哪些 frame 属于标签条，block 的生命周期仍归它管。
- 切换文件 Tab 时文件 modal 离开 DOM，block 的 frame 只隐藏不移除，这样浏览器页面和未写完的提交说明都不会丢。
- 文件 Tab 和 Git block 按窗口保存，浏览器 block 按服务器保存：切换窗口时文件和 Git 标签跟着换，浏览器标签保留。block 的归属由注册时的 `perWindow` 决定，`_persistDockState` 不写入 block，只记录它是否在最前（`activeBlock`）。
- 切走窗口时 Git block 的 frame 只脱离 DOM、不销毁，这样没写完的提交说明不会丢；窗口的 block 要等访问到它才创建。在没有窗口的页面打开的 Git 先浮动，到第一个窗口时归属于它。
- 文件 Tab 和窗口级 block 的持久化键包含服务器 ID、tmux 服务实例（PID + 启动时间）和窗口 ID；不恢复缺少实例信息的旧缓存。删除窗口成功时立即清理；成功且完整的工作区快照还会回收已消失窗口和旧实例的记录，失败或不完整的读取不得触发回收。
- 关闭最后一个文件 Tab 时，只要还有 block 标签，分窗就保留；所有标签都没了才销毁。
- 分窗只存在于终端旁：离开终端页时 block 暂存（frame 脱离 DOM），回来再挂上；在其它页面打开 block 时用浮动窗口。
