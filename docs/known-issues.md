# 待优化 / 修复表

README 重做过程中实际踩到、观察到或验证过的问题。每条都给了证据位置，「待验证」表示现象来自自动化捕获环境，要真机或人工复核才能定性。

| # | 严重度 | 问题 | 证据 / 位置 | 建议 |
|---|--------|------|-------------|------|
| 1 | 高 | ⌘K 命令面板在多服务器 shell 下选中后不跳转。面板能打开、能模糊过滤，但点选或回车后界面停在原窗口。根因是 `_selectItem()` 走 app.js 的 legacy `navigate()`，而 legacy `render()` 在 `.ms-app` 存在时直接 return，全程不碰 `location.hash` 和 Router | `public/js/command-palette.js:93-105`，`public/js/app.js:335-368`、`app.js:376-380` | palette 改调 `Router`，序列化成 `#/terminal/:serverId/:sessionId/:windowId/:paneId`，补一条 ms-shell 下的跳转测试 |
| 2 | 中 | 测试红灯。`npm test` 当前 4 个失败，`test/api/claude-usage.test.js` 3 例（full data、not_configured、OAuth 失败降级），`test/api/disk-io.test.js` 1 例（sector delta 速率）。claude 三例断言 `modelUsage['claude-opus-4-6']`、`dailyActivity` 长度等，疑似定价表或日期窗口漂移，disk-io 例对采样间隔敏感 | `npm test` 输出，97 files / 1411 tests / 4 failed | 修 fixture 或断言，disk-io 例改为注入固定时间戳 |
| 3 | 中 | 终端模式按「用户 + server」持久化，不区分设备。桌面切到分屏后手机打开同一 server 会继承分屏，窄屏上两个 pane 挤到不可读，本次捕获中实际复现 | `public/js/store.js:2-15` 的 `terminalModeByServer` | 小视口回落 tab，或按设备维度持久化 |
| 4 | 中 | `public/screenshots/` 全量过期且含真实会话名。4 月截图仍是 legacy shell，侧栏带真实中文会话名，README 若继续引用即泄露工作信息 | `public/screenshots/*.png` | 删除该目录，README 统一引用 `docs/assets/readme/` |
| 5 | 低 | CLAUDE.md 与代码漂移。契约写分窗宽度 320–820px，代码已改为 `min(可用宽度 * 0.7)` | `CLAUDE.md`「文件预览分窗契约」，`public/js/file-preview.js:188`，commit `c897f9e` | 更新 CLAUDE.md 契约描述 |
| 6 | 低 | 仓库根目录散落一次性截图与证书文件。`claude-auto-detect.png`、`drawer-*.png`、`nexus-*.png`、`terminal-*.png`、`tmux-render-abnormal.png`、`layout-test-open.png`、`cert.pem`、`key.pem` 都只靠 `.gitignore` 兜底，工作树里长期存在 | `git status` 与根目录列表 | 从工作树移除，证书类文件不应留在仓库目录 |
| 7 | 低 | 性能页对任何已登录客户端暴露进程名与会话名，Top 压力来源和 Windows 与系统进程两块都是。单机自用没问题，多人共用一个面板时是信息泄露面 | `public/js/perf-panel.js`，`server/api/` 下 window-stats 相关 | 共享部署时加配置项或脱敏，README 截图需 sanitize（本次已做） |
| 8 | 待验证 | 移动端 drawer 按键在合成 touch 序列后抽屉关闭，和「按键不退出」契约不符。可能是 touch 坐标命中抽屉拖拽热区，或 focus 哨兵把合成事件判成软键盘信号 | `CLAUDE.md`「移动端工具盘交互契约」，`public/js/fab-drawer.js` | 真机复现，若属实给 kbd 按钮加 `touch-action` 或阻止拖拽判定 |
| 9 | 待验证 | 场景自动识别延迟。pane 内进程改名为 `claude`（`exec -a`）后约 5s，drawer 场景芯片仍显示「终端」 | `public/js/fab-scene.js:13-264`，`server/monitor.js` 的 pane-cmd 事件 | 核对 pane-cmd 推送周期与 ps 名称读取，必要时缩短探测间隔 |
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

- `server/terminal.js`：Windows 上不 resize 运行中的客户端，按新尺寸启动新客户端并替换旧的；断开时只结束客户端进程，不调用 node-pty 的 `kill` 去关控制台。
- `server/terminal/console-reaper.js`：客户端结束 5 秒后再回收它的 `conhost.exe`，此时 tmux 早已放开这个控制台。
- `scripts/windows/run-tmux-server.ps1`：server 必须持续以同一 pid 应答，连续 3 次没有应答就结束它并重启，并写入 `tmux-server.log`。
- `server/session-protection/`：Windows 上快照目录不随 `HOME` 变化；刚启动的 server 即使已有别的会话，也会补回 `last` 里缺失的会话。
- `public/js/terminal.js`：连接时带上实际尺寸，重连后的 resize 发到当前连接。

验证：真实 `TerminalManager` 在私有 tmux 上，所有间隔下最终尺寸全部正确，连续尺寸变化和各时点断开时 server 全部存活。

**放弃的方案。** 用 `script -qfc` 隔一层 MSYS pty：server 确实不再崩溃，键盘、鼠标、OSC 52 也正常，但稳定后连续 resize 的最后一次常常丢失。先 `detach-client` 再关控制台：同样会崩。

**还没解决的。**

- 面板服务被强制重启时，操作系统会关闭它名下的控制台，如果此时有客户端附着，server 仍有小概率退出。这时依靠上面的卡死检测和自动恢复。
- 连接建立后约 30ms 内就断开的极端情况，个别 `conhost.exe` 和读取线程要到面板重启才释放。
- 历次退出留下的孤儿窗格进程没有清理，判断不了里面是否还有用户的程序，需要人工确认。
- 包装脚本的探测偶尔会失败。20:45 之后 `tmux-server.log` 有两次在 server 运行时又记录 `starting`，接着是 `open terminal failed: not a terminal` 和退出码 1：这是新起的 `tmux -D` 连上现有 server 后失败，不是 server 退出（pid 从 19:04 起没变）。两次都发生在全量测试运行期间（20:55:25 到 20:56:13、22:10:43 到 22:11:33），同一段时间面板日志有 5 次 tmux 命令失败。负载导致超时只是推测，未证实。手动起的 server 上这没有影响；计划任务的 server 上，连续 3 次没有应答（约 1 分钟）会被结束，再靠自动恢复回来，届时窗格里的程序要重新打开。

**实验规则。** 不要在默认 tmux server 上做接入、resize、断开实验，只碰临时会话也不行，会话隔离不等于 server 隔离。一律用 `tmux -L <name>` 或 `TMUX_TMPDIR`，每条命令带超时。不要在普通 shell 里手动起默认 socket 的 tmux。

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

- `server/session-protection/service.js`：Windows 上面板每看到一个 server 实例，就在恢复会话之前执行 `set-environment -g MSYS2_PATH_TYPE inherit`，手动启动的 server 最多 20 秒内补上。
- `server/msys.js`：面板自身启动的 tmux 进程都带这个变量，面板新建会话时拉起的 server 第一个窗格就是对的。

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

**结论。** 已证实：有客户端在新客户端读应答的窗口内离开，应答会丢字节并以按键进入窗格；把变更排开就不漏。谁读走了那些字节没有直接观测，不下结论。

现场那串里的 `c`、`M` 这类碎片，还有另一条能解释的路径：窗格里跑原生程序时，MSYS2 的 pcon 内层 ConPTY 会吃掉完整的 DA 应答并只漏出 `c`；程序自己发的查询也由内层应答，和外层用哪个后端无关。这条只在实验里看到，现场是否单一原因未证实。

**同一问题暴露的另外三个 bug（df6870f 上同样复现，都不是新引入的）。**

- resize 之后马上打的字会丢：旧逻辑收到 resize 后还在等客户端启动完，这期间输入照常写给旧客户端，随后旧客户端被结束。
- 打字后马上 resize，字也会丢：输入同样由 server 从控制台逐字节读，没读完就结束客户端，剩下的就没了。基线窗格收到过 `k5` 少一个 `.`，正是读到一半被切断。
- 被接管的旧 socket 能把会话抢回去：它要等约 1 秒后的 `onExit` 才算结束，这期间发 resize 会再启动一个 `attach -d`，反过来踢掉新客户端。

**服务现在怎么处理。**

- `TerminalManager.whenClientCanStart`（`server/terminal.js`）：面板的新接入和替换排队进行。先结束同一会话上面板自己的其它客户端，确认进程消失，再启动；有客户端正在启动时，其它客户端的结束往后排。排队期间已经取消的请求不产生任何副作用。
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

- 用户手动 `tmux attach`（如 SSH 登录后）这类非面板客户端，它的 `-d` 和离开不受这里管理，遇上新客户端的启动窗口仍可能漏。
- 长粘贴（约 180 字节以上）写入后马上结束客户端，仍可能被 1.5 秒上限截断，1 KiB 实测全丢。要根治得有读取确认，或换掉输入路径，这次没有做。
- 客户端结束后一直不退出时，面板的新接入会持续 `TERMINAL_BUSY`，直到它退出；此时日志有 `has not gone after being ended`。实验中没有遇到过。
- pcon 内层的应答路径不受面板控制。
- 现场再出现时，先看 `tmux -vv` 日志里 `keys are` 的内容和当时有没有客户端变更，判断属于哪一条。

## 捕获环境备注

两条和产物无关但值得记下来的事。CDP 的 `Page.startScreencast` 在这台共享 Chrome 上返回的帧偶发无样式，所以所有动画改成定时 `page.screenshot` 静帧合成，脚本在 `.playwright-mcp/readme-shot/shot.mjs`。截图里的主机名、内网和公网 IP、服务器名、进程名都在捕获期做了 DOM 文本替换脱敏，tmux 状态栏的主机名用 session 级 `status-right` 覆盖掉，规则见同目录 `shot.mjs` 的 `SANITIZE_RULES`。
