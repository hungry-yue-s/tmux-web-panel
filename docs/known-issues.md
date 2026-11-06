# 待优化 / 修复表

README 重做过程中实际踩到、观察到或验证过的问题。每条都给了证据位置，「待验证」表示现象来自自动化捕获环境，要真机或人工复核才能定性。

| # | 严重度 | 问题 | 证据 / 位置 | 建议 |
|---|--------|------|-------------|------|
| 1 | 已解决 | ⌘K 命令面板在多服务器 shell 下选中后不跳转（当时 `_selectItem()` 走 legacy `navigate()`）。现在窗口条目都带路由、经 `Router.go` 跳转；2026-11-06 删除了按旧 `state` 拼条目、再走 `navigate()` 的分支，工作区数据到达前只提供页面 | `plugins/ui/client/js/command-palette.js` | — |
| 2 | 已解决 | 测试红灯（claude-usage 3 例、disk-io 1 例）。2026-11-06 复核：claude-usage 已通过；disk-io 的根因不是采样间隔，而是 afterEach 里的 `vi.doUnmock` 取消了下一个测试的 `vi.doMock`，于是读到真实的 `/proc/diskstats`（Windows 上为空，Linux 上是真实磁盘） | `test/lib/api/disk-io.test.js` | 已去掉 doUnmock |
| 3 | 中 | 终端模式按「用户 + server」持久化，不区分设备。桌面切到分屏后手机打开同一 server 会继承分屏，窄屏上两个 pane 挤到不可读，本次捕获中实际复现 | `plugins/ui/client/js/store.js:2-15` 的 `terminalModeByServer` | 小视口回落 tab，或按设备维度持久化 |
| 4 | 中 | `plugins/ui/client/screenshots/` 全量过期且含真实会话名。4 月截图仍是 legacy shell，侧栏带真实中文会话名，README 若继续引用即泄露工作信息 | `plugins/ui/client/screenshots/*.png` | 删除该目录，README 统一引用 `docs/assets/readme/` |
| 5 | 已解决 | CLAUDE.md 与代码漂移（分窗宽度上限 820px）。CLAUDE.md 现写明最大为可用工作区的 70%、不再设 820px 上限 | `CLAUDE.md`「文件预览分窗契约」 | — |
| 6 | 低 | 仓库根目录散落一次性截图与证书文件。`claude-auto-detect.png`、`drawer-*.png`、`nexus-*.png`、`terminal-*.png`、`tmux-render-abnormal.png`、`layout-test-open.png`、`cert.pem`、`key.pem` 都只靠 `.gitignore` 兜底，工作树里长期存在 | `git status` 与根目录列表 | 从工作树移除，证书类文件不应留在仓库目录 |
| 7 | 低 | 性能页对任何已登录客户端暴露进程名与会话名，Top 压力来源和 Windows 与系统进程两块都是。单机自用没问题，多人共用一个面板时是信息泄露面 | `plugins/metrics/client/js/perf-panel.js`，`lib/api/` 下 window-stats 相关 | 共享部署时加配置项或脱敏，README 截图需 sanitize（本次已做） |
| 8 | 待验证 | 移动端 drawer 按键在合成 touch 序列后抽屉关闭，和「按键不退出」契约不符。可能是 touch 坐标命中抽屉拖拽热区，或 focus 哨兵把合成事件判成软键盘信号 | `CLAUDE.md`「移动端工具盘交互契约」，`plugins/keypad/client/js/fab-drawer.js` | 真机复现，若属实给 kbd 按钮加 `touch-action` 或阻止拖拽判定 |
| 9 | 待验证 | 场景自动识别延迟。pane 内进程改名为 `claude`（`exec -a`）后约 5s，drawer 场景芯片仍显示「终端」 | `plugins/keypad/client/js/fab-scene.js:13-264`，`lib/monitor.js` 的 pane-cmd 事件 | 核对 pane-cmd 推送周期与 ps 名称读取，必要时缩短探测间隔 |
| 10 | 待验证 | `/css/style.css` 偶发加载不完整。捕获过程中多次出现整页无样式或半样式渲染，`link.sheet` 存在但布局规则缺失，重试即恢复，疑似共享 Chrome 上该请求被截断或复位 | 捕获脚本 `ensureStyled` 与 `assertReady` 的重试日志 | 给静态资源加 `onerror` 重试或内联关键 CSS，若确认与本仓库服务端无关则忽略 |
| 11 | 低 | README 旧文案严重落后于实现，没提多服务器工作台、性能与 Claude/Codex 页、场景抽屉、Mermaid 导出、归档预览这些 | 旧 `README.md` | 本次已重写，后续大功能同步更新 README |

## 环境问题记录

环境问题记在这里，并且由服务自己检测和恢复，不靠人工救场。每条写清现象、证据、结论和处理；还没证实的要写明。

### ENV-1 Windows：面板的终端操作会带走 MSYS2 tmux server（2026-10-30）

**现象。** 所有 tmux 会话突然消失。`tmux-server.log` 显示 server 在 10-28 至 10-30 反复退出（退出码 0，多数前面有 `[warn] poll: No error`），平时靠自动恢复盖过去，用户只觉得程序被重启过。每次退出还会留下无人管理的窗格进程：当天统计到 32 个孤儿 `bash.exe`、约 70 个无父进程的 `conhost.exe`。

**这次为什么没能自动恢复。** 这条链路上每一步都要有人兜底：

1. 18:45 实验脚本在用户的默认 tmux server 上反复接入，server 退出，靠自动恢复回来。
2. 18:51 再次实验，server 卡死：socket 已关闭，进程却不退出。计划任务的包装脚本只等进程退出，于是既没重启也没恢复。
3. 18:57 实验的 `new-session` 在没有 server 时新起了一个。它已有会话，所以恢复被跳过；5 分钟保存又用只有测试会话的快照覆盖了 `last`。
4. 19:04 用户在 PowerShell 里手动运行 `tmux`，这个 server 的 `HOME` 是 `/c/Users/Administrator`，而不是计划任务的 `/home/Administrator`，快照目录也变了，“找回会话”里看不到之前的历史。

**复现（私有 socket，没有经过面板）。**

| 操作 | 结果 |
|------|------|
| 客户端直接接在 ConPTY 上，连续 resize | 30 次内 server 退出 |
| resize 后 10ms 到 300ms 内断开 | 1 到 5 轮内 server 退出 |
| 不 resize，直接 node-pty `kill` | 启动窗口外 140 轮无事，启动窗口内（150 到 400ms）8 轮内退出 |
| 只结束客户端进程，不关控制台（含启动窗口） | 121 轮无事 |

`tmux -vv` 的日志在退出前没有任何信号或退出记录，进程是被外部直接结束的；日志里 server 持有的是 `/dev/consN`。node-pty 的 `kill` 会枚举控制台上的所有进程并逐个结束（`windowsPtyAgent.js`），然后关闭控制台。

**结论。** 已证实：对运行中的客户端做 ConPTY resize，以及在 server 附着时关闭控制台，都能让 server 退出。推断（符合全部数据，但没有直接观测）：MSYS 操作 `/dev/consN` 时 server 会临时附着到那个控制台，所以被一起结束。未证实：实验中的退出都没有 `poll: No error`，所以线上带这条警告的退出是否同一原因还不确定。修复后继续看 `tmux-server.log`，如果还有带这条警告的退出，就另查原因。

同一机制也造成了“终端内容只渲染在上半部分”：启动窗口内的 resize 会丢，tmux 按旧尺寸绘制，刷新后尺寸重新生效才正常。另一个独立原因是前端闭包捕获了第一个 WebSocket，断线重连后的 resize 全发到了已关闭的连接上。

**服务现在怎么处理。**

- `lib/terminal.js`：Windows 上不 resize 运行中的客户端，按新尺寸启动新客户端并替换旧的；断开时只结束客户端进程，不调用 node-pty 的 `kill` 去关控制台。
- `lib/terminal/console-reaper.js`：客户端结束 5 秒后再回收它的 `conhost.exe`，此时 tmux 早已放开这个控制台。
- `scripts/windows/run-tmux-server.ps1`：server 必须持续以同一 pid 应答，连续 3 次没有应答就结束它并重启，并写入 `tmux-server.log`。
- `lib/session-protection/`：Windows 上快照目录不随 `HOME` 变化；刚启动的 server 即使已有别的会话，也会补回 `last` 里缺失的会话。
- `plugins/terminal/client/js/terminal.js`：连接时带上实际尺寸，重连后的 resize 发到当前连接。

验证：真实 `TerminalManager` 在私有 tmux 上，所有间隔下最终尺寸全部正确，连续尺寸变化和各时点断开时 server 全部存活。

**放弃的方案。** 用 `script -qfc` 隔一层 MSYS pty：server 确实不再崩溃，键盘、鼠标、OSC 52 也正常，但稳定后连续 resize 的最后一次常常丢失。先 `detach-client` 再关控制台：同样会崩。

**还没解决的。**

- 面板服务被强制重启时，操作系统会关闭它名下的控制台，如果此时有客户端附着，server 仍有小概率退出。这时依靠上面的卡死检测和自动恢复。
- 连接建立后约 30ms 内就断开的极端情况，个别 `conhost.exe` 和读取线程要到面板重启才释放。
- 历次退出留下的孤儿窗格进程没有清理，判断不了里面是否还有用户的程序，需要人工确认。
- 包装脚本的探测偶尔会失败。20:45 之后 `tmux-server.log` 有两次在 server 运行时又记录 `starting`，接着是 `open terminal failed: not a terminal` 和退出码 1：这是新起的 `tmux -D` 连上现有 server 后失败，不是 server 退出（pid 从 19:04 起没变）。两次都发生在全量测试运行期间（20:55:25 到 20:56:13、22:10:43 到 22:11:33），同一段时间面板日志有 5 次 tmux 命令失败。负载导致超时只是推测，未证实。手动起的 server 上这没有影响；计划任务的 server 上，连续 3 次没有应答（约 1 分钟）会被结束，再靠自动恢复回来，届时窗格里的程序要重新打开。

**实验规则。** 不要在默认 tmux server 上做接入、resize、断开实验，只碰临时会话也不行，会话隔离不等于 server 隔离。每条命令显式用 `tmux -S <私有 socket>` 或 `-L <唯一名称>`，带超时，并从实验及全部子进程环境移除 `TMUX` / `TMUX_PANE`。`TMUX_TMPDIR` 不能覆盖继承的 `TMUX` socket，不能单独作为隔离。清理前以相同 socket 参数核对 `socket_path` 和 server PID 归属；无法核对就不结束。不要在普通 shell 里手动起默认 socket 的 tmux。Windows 使用绝对 tmux 可执行路径时，PATH 中的 POSIX 包装不会提供隔离。

### ENV-2 Windows：手动启动的 tmux server，窗格里找不到 claude（2026-10-30）

**现象。** 窗格里运行 `claude` 报 `fish: Unknown command: claude`，而 `C:\Users\Administrator\.local\bin\claude.exe` 存在，PowerShell 里也能运行。Node、Git for Windows 等只装在 Windows PATH 上的程序同样会找不到。

**原因。** tmux 把窗格的 shell 作为登录 shell 启动。MSYS2 的登录脚本（fish 是 `/etc/fish/msys2.fish`，bash 是 `/etc/profile`）在没有 `MSYS2_PATH_TYPE` 时按 `minimal` 处理，把 PATH 重置成 MSYS2 目录加 `C:\Windows` 的几个系统目录。计划任务的 `run-tmux-server.ps1` 会设置 `MSYS2_PATH_TYPE=inherit`，但 ENV-1 第 4 步在 PowerShell 里手动运行的 `tmux` 没有这个变量。

**证据。** 用窗格的初始环境单独启动 `fish -l`：

| `MSYS2_PATH_TYPE` | 登录后的 PATH | `claude` |
|-------------------|---------------|----------|
| 未设置（手动启动的 server） | MSYS2 目录 + `C:\Windows` 系统目录 | 找不到 |
| `inherit`（计划任务的 server） | MSYS2 目录 + 完整的 Windows PATH | `/c/Users/Administrator/.local/bin/claude` |

`/proc/<pid>/environ` 里的 PATH 含有 `.local/bin`，所以只看环境变量会误判，要在登录 shell 里看。

**服务现在怎么处理。**

- `lib/session-protection/service.js`：Windows 上面板每看到一个 server 实例，就在恢复会话之前执行 `set-environment -g MSYS2_PATH_TYPE inherit`，手动启动的 server 最多 20 秒内补上。
- `lib/msys.js`：面板自身启动的 tmux 进程都带这个变量，面板新建会话时拉起的 server 第一个窗格就是对的。

验证：真实 `SessionProtection` 在私有 tmux 上，补变量之前开的窗格找不到 claude，之后新开的窗口能找到，已打开的 shell 不变，`fish_add_path` 能修复已打开的 shell。

**还没解决的。**

- 变量只影响之后新建的窗格。已经打开的 shell 改不了，要新开窗口，或在里面运行 `fish_add_path -g /c/Users/<用户>/.local/bin`（只补 claude 所在目录，bash 用 `export PATH="$PATH:/c/Users/<用户>/.local/bin"`）。
- 手动运行 `tmux` 时创建的第一个窗格，在面板补上变量之前就已经启动了，也属于这种情况。
- 用户自己加载 tmux-resurrect 的 `external` 模式不经过这段逻辑，手动起的 server 仍需自己设置。

### ENV-3 Windows：没按键，窗格的提示符里多出终端应答（2026-10-31）

**现象。** 用户什么都没按，提示符里出现 `c?61;6;7;21;22;23;24;28;32;42cM` 这样的文本。这是终端对设备属性查询（DA）的应答，被当成了键盘输入。

**环境。** MSYS2 tmux 3.8-1、msys2-runtime 3.6.10-5、node-pty 1.2.0-beta.14（系统 ConPTY，`useConptyDll` 默认关）、Windows 10.0.26100。

**证据。** 全部在私有 `TMUX_TMPDIR` 上做，没有碰默认 server。

- tmux 启动客户端时发查询，等应答。系统 ConPTY 自己答 `ESC[c`、`ESC[>c`，宿主收不到查询（`hostWrites` 始终为空），所以这不是网页或 xterm.js 的应答。
- server 从控制台**逐字节**读应答，约 2ms 一个字节。现场日志 `keys are 62 (\033[61;…` 说明 `?` 在进入 tmux 的按键解析之前就没了；少了一个字节，剩下的就不再是应答，只能当按键。
- 丢的字节位置不固定：实验里分别缺过 `[`、`ESC`，留下 `[?61…`、`ESC?61…`、`ESC[61…`、`ESC[0;10;1c`、`ESC[?2026;$y`。

| 客户端怎么变（只结束客户端进程，窗格内容与应答逐字节比较） | 泄漏 |
|------------------------------------------------------------|------|
| 新客户端 `attach -d`，旧客户端此时还活着 | 4/10，即使宿主不应答也有 2/10 |
| 新客户端启动后 200 到 1000ms 结束旧客户端 | 多数延迟 3 到 4/8 |
| 新客户端启动窗口内，结束**别的会话**的客户端 | 150、250、400、500ms 有漏，300、350、700ms 这一轮 0/8 |
| 先结束旧客户端，确认进程消失，再 attach | 0/10 |
| 先 `detach-client`，再 attach | 0/10 |
| 别的会话的客户端只是空闲或持续输出 | 0/10 |
| 换成随包的 conpty.dll | 同样漏（`ESC[1;2c`），先结束旧的再 attach 是 0/10 |

node-pty 报告退出比进程消失晚约 1 秒（中位 1.0 到 1.4 秒），进程本身在结束后 0 到 1ms 就没了。所以等 `onExit` 既慢也不是判断依据，要看进程本身。

**结论。** 已证实：有客户端在新客户端读应答的窗口内离开，应答会丢字节并以按键进入窗格；把变更排开，这条路径就不漏。谁读走了那些字节没有直接观测，不下结论。排队只覆盖了部分路径，不是完整归因：见“还没解决的”里单次 attach 的记录。

现场那串里的 `c`、`M` 这类碎片，还有另一条能解释的路径：窗格里跑原生程序时，MSYS2 的 pcon 内层 ConPTY 会吃掉完整的 DA 应答并只漏出 `c`；程序自己发的查询也由内层应答，和外层用哪个后端无关。这条只在实验里看到，现场是否单一原因未证实。

**同一问题暴露的另外三个 bug（df6870f 上同样复现，都不是新引入的）。**

- resize 之后马上打的字会丢：旧逻辑收到 resize 后还在等客户端启动完，这期间输入照常写给旧客户端，随后旧客户端被结束。
- 打字后马上 resize，字也会丢：输入同样由 server 从控制台逐字节读，没读完就结束客户端，剩下的就没了。基线窗格收到过 `k5` 少一个 `.`，正是读到一半被切断。
- 被接管的旧 socket 能把会话抢回去：它要等约 1 秒后的 `onExit` 才算结束，这期间发 resize 会再启动一个 `attach -d`，反过来踢掉新客户端。

**服务现在怎么处理。**

- `TerminalManager.whenClientCanStart`（`lib/terminal.js`）：面板的新接入和替换排队进行。先结束同一会话上面板自己的其它客户端，确认进程消失，再启动；有客户端正在启动时，其它客户端的结束往后排。排队期间已经取消的请求不产生任何副作用。
- 结束后 1.5 秒还活着，就不启动，这次接入以 `TERMINAL_BUSY`（关闭码 1011）失败，页面重连时再试。不再结束第二次：PID 还存在不能证明还是原来的客户端，等 `onExit` 或确认 PID 已不存在。`onExit` 之后任何路径都不会再结束它。
- 被接管的连接立刻失效并以 1000 关闭，不等 `onExit`；客户端的等待和释放照常进行。
- 接入前的输入暂存在网关上，从接受一次改变尺寸的 resize 起的输入暂存在连接上，都只投递一次给有效的客户端。总量上限 1 MiB，超过以 1009 关闭并清空。
- 已经写给客户端的输入，结束客户端前按字节数等它读完（40ms + 8ms/字节，最多 1.5 秒）。这是尽力保护，没有任何信号能确认读完了：它不是 DA 问题的修复，DA 问题靠上面的排队，和这段等待无关。普通打开和没写过输入的客户端不等。
- 不换 ConPTY DLL：它同样会漏，还会多发一个查询。

**验证。** 真实的网关、`WorkspaceService` 和 `TerminalManager`，私有 `TMUX_TMPDIR`，窗格里跑只记录收到内容的 `cat`，每个场景 8 轮，逐字节比较窗格收到的和打出去的。这些都是实验环境的结果，不等于现场已复现并消除。

| 场景 | df6870f | 修复后 |
|------|---------|--------|
| 新 socket 打开时旧 socket 还开着 | 漏 `ESC[61;…c` 两次 | 一致 |
| 别的会话的 socket 在启动窗口内关闭 | 漏 `ESC[830;100t`、`ESC[0;10;1c` | 一致 |
| 被接管的 socket 在 `onExit` 前发 resize 和输入 | 3/8 轮会话被抢回，窗格收到应答碎片 | 0/8，一致 |
| resize 连发并持续输入（48 字节） | 丢一半，只收到 `bN.` | 一致 |
| 打字后马上 resize（24 字节） | 收到 `k2.k4.k5k6.k8.` | 一致 |
| socket 打开瞬间输入（62 字节） | 全丢 | 一致 |
| 旧 socket 关闭后马上开新的 | 一致 | 一致 |
| A、B、A、B 快速切换 | 一致 | 一致 |

版本说明：完整 8 个场景跑在加入读取等待之前，那一轮“打字后马上 resize”失败（7/8，退出码 1）。加入读取等待和 `onExit` 收口之后，只在最终代码上重跑了三个有输入的场景（resize 连发、打字后马上 resize、打开瞬间输入），3/3 一致；没有输入的场景不进入这段等待，没有再跑一遍。

读取节奏（打字后等多久再 resize，8 轮里丢的轮数）：

| 字节数 | 不等待 | 按 6ms/字节等待时 |
|--------|--------|-------------------|
| 3 | 间隔 0、5、10、20ms 丢 8、6、6、1 轮；40ms 起 0 | 0 |
| 64 | 间隔 20 到 160ms 全丢，320ms 丢 3 轮 | 间隔 0 时 0；间隔 100ms 时 1 |
| 200 | 未测 | 0 |
| 1024 | 间隔 80 到 1280ms 全丢 | 8（超过 1.5 秒上限） |

因为 64 字节那 1 轮，最终用的是 8ms/字节，这个系数没有再单独扫一遍。

首屏（真实页面，私有 tmux）：温启动、冷启动、字体晚到、恢复分窗、隐藏分窗、手机视口，点击后都是 1 次 attach、1 次网格、1 次进入 alternate screen；温启动中位 `ready` 186ms、首个输出 296ms。

**还没解决的。**

- 单次 attach、没有任何客户端变更也会漏（2026-11-02）。私有 tmux（`-f /dev/null`），真实页面打开一个窗口，bash 窗格的提示符里出现 `61;6;7;21;22;23;24;28;32;42c`，有时还带 `2026;0$y`：f9ce247 和 e76099e 都是 4/4，所以不是 e76099e 的 Git 改动引入的。假 socket 加 bash 是 0/4；假 socket 加只记录字节的窗格是 1/4，当时没有任何输入帧。真实页面每轮都发了 `ESC[I`，但这解释不了没有输入的那一次。原因没有查，df6870f 和默认配置下没有测，是否就是现场现象也未证实。
- 用户手动 `tmux attach`（如 SSH 登录后）这类非面板客户端，它的 `-d` 和离开不受这里管理，遇上新客户端的启动窗口仍可能漏。
- 长粘贴（约 180 字节以上）写入后马上结束客户端，仍可能被 1.5 秒上限截断，1 KiB 实测全丢。要根治得有读取确认，或换掉输入路径，这次没有做。
- 客户端结束后一直不退出时，面板的新接入会持续 `TERMINAL_BUSY`，直到它退出；此时日志有 `has not gone after being ended`。实验中没有遇到过。
- pcon 内层的应答路径不受面板控制。
- 现场再出现时，先看 `tmux -vv` 日志里 `keys are` 的内容和当时有没有客户端变更，判断属于哪一条。

### ENV-4 Windows：系统自带 ssh.exe 的端口转发每次往返多约 30ms（2026-11-03）

**现象。** 在 Windows 上作为 Hub 时，经 SSH 转发的每次往返比直连慢约 30ms。

**证据。** 同一台 Windows Server 2025，同一个 sshd（OpenSSH_for_Windows_9.5），同一个 Node（HTTPS，7681），已打开的 `/ws/status` 上随机交错的 WebSocket ping，每条 300 个样本，一次只有一个在途：

| 路径 | p50 | p95 | p99 |
|------|-----|-----|-----|
| `C:\Windows\System32\OpenSSH\ssh.exe -N -L` | 32.6ms | 46.0ms | 62.8ms |
| Git for Windows 的 MSYS `ssh.exe`（OpenSSH 10.6p1）`-N -L` | 1.7ms | 10.2ms | 25.7ms |
| 直连内网地址 | 1.0ms | 6.1ms | 20.4ms |

另一轮（`scripts/measure-node-paths.mjs`，500 个样本）系统 ssh.exe 转发 p50 32.8ms、直连 1.1ms。

**结论。** 已证实：多出的约 30ms 来自 Windows 自带的 ssh **客户端**，sshd 一侧只多约 0.8ms。原因（例如计时器粒度约 15.6ms 的两倍）未证实。所以 Mac 作 Hub、Windows 作 Node 时，这条不适用，直连在 Windows 一侧几乎省不出时间。

**还没处理。** 面板在 Windows 上仍用系统 ssh.exe。换客户端会引入对 Git for Windows 或 MSYS2 openssh 的依赖，需要另行决定。

### ENV-5 实验进程继承 TMUX 时，TMUX_TMPDIR 不足以隔离（2026-11-03）

**已确认的操作事故。** Mosh smoke 只设置了 `TMUX_TMPDIR`，但继承了窗格中的 `TMUX`；没有 `-L` / `-S` 的清理命令因此结束了默认 server。旧实例 `937593:1793354641` 后来变为 `185256:1793677232`。执行该实验的 Claude 在私有 socket 上复核优先级后确认了错误；主控也核对了项目 tmux 源码的 socket 选择逻辑：只有命令行未指定 `-L` / `-S` 时才采用 `TMUX`，随后才按目录构造默认路径。创建了临时目录或其中存在一个 socket，不足以证明每条命令都用了它。

**影响边界。** 默认 server 被结束会中断其会话和进程；自动恢复只能重建窗口结构和重新运行命令，不能恢复原进程内存。主控确认当前同名窗口可读，不能据此声称原任务完整保留。中断前后快照及其它集成测试的隔离仍需分别核查，不把它们列为已通过。

**防止重现。** 实验、真实组件测试及其清理全部显式使用同一个私有 `-S` socket 或唯一 `-L` 名称，移除所有子进程的 `TMUX` / `TMUX_PANE`，每条命令有超时。结束 server 前先用相同参数读取并核对 socket 路径和 PID 的归属。Windows 的产品代码可能直接调用绝对路径的 MSYS2 tmux，不能依赖 PATH 里的 POSIX 包装隔离；不具备 Windows 隔离实现的测试应明确跳过，而非一边失败一边访问默认 server。Mosh 实验在隔离与生命周期验收前保持不可用于正式连接。

### ENV-6 Windows：ConPTY 下的 mosh-client 会丢尺寸、偶尔不再响应（2026-11-03）

**现象。** 在 Windows 上用 node-pty 运行 MSYS2 的 `mosh-client`（mosh 1.4.0-6）时，尺寸变化有时到不了 mosh-server；连续快速改尺寸时，mosh-client 还会自行退出（exit 1，“mosh did not shut down cleanly”）。个别轮次里它整体不再响应：既不发尺寸，也收不到服务端的结束消息。

**证据。** 全部在私有 `-L` / `-S` tmux 上，mosh UDP 只绑 127.0.0.1。

| 场景 | 结果 |
|------|------|
| 10 次尺寸连发，间隔 15ms | 11 轮中 5 轮 mosh-client 退出；最终尺寸多数不是最后一次 |
| 同上，间隔 200ms | 8 轮中 1 轮丢了最后一次 |
| 单次改尺寸（生命周期验收第 9–23 轮，共 15 轮） | 6 轮没生效，其中 3 轮在与全量测试并发、主机 CPU 接近满载时；空闲的最后 3 轮都生效 |
| 每次失败时比对 `stty -F <mosh pty>` 与 tmux 客户端尺寸 | 始终相同，都是旧尺寸 |

**结论。** 已证实：丢失发生在客户端一侧，mosh-server 的 pty 和 tmux 只是没收到新尺寸；服务端 pty 到 tmux 的尺寸跟随在所有轮次中都正确。原因（ConPTY 的窗口事件、MSYS2 运行时的 SIGWINCH）未查。macOS 的 mosh-client 跑在真实 pty 上，是否有同样问题未测。

**服务现在怎么处理。** Windows 不作为 Mosh 客户端：Hub 在 Windows 上报告 `client_platform`，不提供 Mosh 终端（`lib/hub/mosh-terminal.js` 的 `findMoshClient`）。Windows 作为 Node 运行 mosh-server 不受影响。Hub 桥接期间定期向 Node 询问会话是否还在，客户端漏收结束消息时页面也会关闭，不会一直停在冻结画面。

### ENV-7：Swift 设置自测编译产物收到 SIGKILL（2026-11-04）

**现象。** `scripts/test-macos-shell.sh` 的 endpoint/原生顶栏编译自测通过；含 `DesktopSetupManager.swift` 的设置自测编译成功，但新版本连续两次执行收到 SIGKILL（137）。原版本的一次对照执行通过。Swift 主程序 `swift build -j 2` 编译链接成功，脚本附带的设置源码解释执行也通过；后者仅作逻辑补充，不能替代编译产物执行验收。

**证据边界。** 对应时段 amfid 对新旧测试产物都记录 `AppleMobileFileIntegrityError -423`，说明 ad-hoc 签名或证书链不被识别；syspolicyd 同时记录评估。尚无直接证据将两次 SIGKILL 归因于某条策略或本轮代码。保留原始退出码，不把源码解释通过、主程序构建成功或旧版本对照通过写成该编译自测已通过。

**2026-11-04 的处理。** 不关闭系统验证、不更改企业防护或签名信任策略，当时未替换正在运行的 Swift 应用。保留编译执行失败，不用解释执行结果代替。

**2026-11-05 复核。** 同机最小 Swift 并发程序和完整 App 的临时签名产物也在进入应用代码前收到 SIGKILL，采样停在 `_dyld_start + 0`；换 SDK、链接器和文件 inode 均未解决。使用本机已有的有效代码签名身份后，最小程序、真正编译的设置自测及完整 App 均可执行。该对照确认本机有可用的签名路径，不能据此指认具体的系统或企业防护规则。

**打包修复。** 自测和内层 tmux 构建现在都遵循 `TMUX_PANEL_CODESIGN_IDENTITY`，默认仍为临时签名。本地证书开发包使用普通代码签名：没有 Apple Team ID 的本地证书若被强加 Hardened Runtime，Node 加载已签名的 `pty.node` 会报 Team ID 不一致。Developer ID、公证和公开分发构建继续强制 Hardened Runtime，不添加关闭库验证的权限。最终签名后的真实 PTY 烟测仍检查输出和退出码，等待上限从 5 秒改为 30 秒；本机已测到首次执行需 5501ms，原期限会误杀正常启动。

**2026-11-05 的验证边界。** 本地身份签名下的编译自测通过，打包与桌面运行时回归 23/23，完整包两轮 Runtime/PTy 验证及深度严格验签通过；曾有一次 staging App 实际启动并稳定运行。后续完整候选仍在 `.app` 上下文被系统终止，连不含项目代码的全标准最小 App 也能复现；同一签名字节移到 App 外可以执行。签名身份有效、`anchor trusted` 和严格校验通过，因此不能把本地证书签名当作稳定执行授权，也不能把单次启动当作最终替换验收。当时保留旧 App，等待正常系统打开流程的具体提示；未更改信任或防护策略。公共安装包通过 macOS 分发验证仍需 Developer ID 和 Apple 公证。

**2026-11-06 部署复核。** 最新 master 与已构建候选的原生源码一致，复用完整 build 6，在备份当前 build 1 后正常退出旧客户端、同卷原子交换到原来的 `dist/macos/Tmux Panel.app`，再从原路径启动。新版进入前台、完成启动并创建窗口；安装包内的 Node 24.22.1、tmux next-3.8 和真实 PTY 验证也全部通过，没有改写已签名的 manifest。Node 服务进程、tmux 实例与全部 26 个原有窗格保持不变，Dock 入口仍指向原路径。此次实际执行与替换验收通过，未更改系统信任或防护策略；先前 SIGKILL 的具体系统原因仍未确定，不能将本次成功归因于某条未经验证的策略变化。

### ENV-8：macOS 客户端读取桌面壁纸阻塞主线程（2026-11-05）

**现象与证据。** 更新客户端时，旧 App 收到正常退出请求却无法退出；进程采样显示主线程停在 `PanelBackgroundView.updateBackground` → `NSImage(contentsOf:)` → 文件 `__open`。桌面壁纸所在位置不可及时读取时，激活和退出都会被同步文件访问拖住。

**处理与边界。** 壁纸读取和 ImageIO 解码移到后台串行队列，同一屏幕/URL 的进行中请求去重，以请求代次丢弃过期结果，只在主线程更新图层。原有透明与原生全屏下的壁纸语义保留。原生 release 编译通过；截至 2026-11-05，完整 `.app` 的前台执行仍受 ENV-7 所述限制，不能把编译成功写成已完成客户端替换。

**2026-11-06 后验。** 包含此修复的 build 6 已在原路径替换并成功前台运行。两秒进程采样显示主线程处于正常 AppKit 事件循环，未再停在同步壁纸文件读取；实际运行验收见上节部署复核。

### ENV-9 Windows：OpenSSH 启动不了 shell 脚本写的 askpass（2026-11-06）

**现象与证据。** 用密码登录的服务器，Windows 上的 Hub 配对和端口转发都拿不到密码。在本机 sshd 上用一个不存在的用户各试一次：系统 `System32\OpenSSH\ssh.exe` 对 `SSH_ASKPASS=*.sh` 报 `CreateProcessW failed error:193`，MSYS2 的 `ssh.exe` 同样没有运行它；两者都能运行 `.cmd`。

**处理。** Windows 上 `SSH_ASKPASS` 指向 `lib/transport/ssh-askpass.cmd`（`askpassHelper()`），它和 `.sh` 一样只启动 `ssh-askpass.js`，密码不进命令行；`.gitattributes` 让 `*.cmd` 保持 CRLF。

### ENV-10 Windows：没有 sqlite3 命令行（2026-11-06）

**现象。** CC Switch / Token Switch 的读取、供应商切换和企业中继注册都调用 `sqlite3` 命令行；Windows 一般没有它，这些功能在 Windows 上静默失效，对应测试也一直失败。

**处理与边界。** `lib/sqlite-json.js` 优先用 Node 自带的 `node:sqlite`（22.13 起不需要参数），没有时才退回命令行；两者保持命令行的约定：只读查询返回 `-json` 的文本，写入像 `-bail` 一样遇错即停、连接关闭时回滚未提交的事务、错误不带脚本内容、不创建不存在的数据库。语句按引号和注释之外的分号拆分，不支持 `CREATE TRIGGER` 正文。

### ENV-11 Windows：替换文件时目标被短暂占用（2026-11-06）

**现象与证据。** 原子写（写临时文件再改名覆盖）在 Windows 上偶发 `EPERM`：目标正被读取、杀毒或索引打开的那几毫秒里改名失败，结果直接丢失。tmux 构建结果因此停在旧状态，`plugin-management` 的测试时好时坏（日志里是 `rename ... EPERM`）。

**处理。** 所有原子写都经 `lib/atomic-file.js` 的 `replaceFile`：Windows 上对 `EPERM` / `EACCES` / `EBUSY` 重试至多两秒，其它平台和其它错误第一次失败即报。

### ENV-12 Windows：只改 HOME 的测试会写到真实家目录（2026-11-06）

**已确认的事故。** `install-agent-hooks` 的测试只设置了 `HOME`，而 Windows 上的 `os.homedir()` 读 `USERPROFILE`，所以每次运行都往真实的 `~/.qoder/settings.json`、`~/.codex/hooks.json` 安装钩子。安装是幂等的，钩子早已存在，内容与 10 月 26 日最早的备份逐字节相同；但每次都留下一个 `.bak-*` 备份（截至发现时 59 + 42 个）。

**防止重现。** 测试要隔离家目录时同时设置 `HOME` 和 `USERPROFILE`，或者把家目录作为参数传给被测模块；安装脚本没有改动时不再备份和重写文件。

## 捕获环境备注

两条和产物无关但值得记下来的事。CDP 的 `Page.startScreencast` 在这台共享 Chrome 上返回的帧偶发无样式，所以所有动画改成定时 `page.screenshot` 静帧合成，脚本在 `.playwright-mcp/readme-shot/shot.mjs`。截图里的主机名、内网和公网 IP、服务器名、进程名都在捕获期做了 DOM 文本替换脱敏，tmux 状态栏的主机名用 session 级 `status-right` 覆盖掉，规则见同目录 `shot.mjs` 的 `SANITIZE_RULES`。
