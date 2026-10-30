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

**实验规则。** 不要在默认 tmux server 上做接入、resize、断开实验，只碰临时会话也不行，会话隔离不等于 server 隔离。一律用 `tmux -L <name>` 或 `TMUX_TMPDIR`，每条命令带超时。不要在普通 shell 里手动起默认 socket 的 tmux。

## 捕获环境备注

两条和产物无关但值得记下来的事。CDP 的 `Page.startScreencast` 在这台共享 Chrome 上返回的帧偶发无样式，所以所有动画改成定时 `page.screenshot` 静帧合成，脚本在 `.playwright-mcp/readme-shot/shot.mjs`。截图里的主机名、内网和公网 IP、服务器名、进程名都在捕获期做了 DOM 文本替换脱敏，tmux 状态栏的主机名用 session 级 `status-right` 覆盖掉，规则见同目录 `shot.mjs` 的 `SANITIZE_RULES`。
