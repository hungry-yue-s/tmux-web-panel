# CLAUDE.md

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

**静态文件改动不需要重启。** `express.static` 用 `{ etag: false, maxAge: 0 }` 挂载 `public/`，改 `public/js/*` 或 `public/css/*` 后用户刷新浏览器即生效——只有改 `server/*` 才需要 `systemctl --user restart`。

## tmux server 守护与会话持久化

Linux 使用用户级 `tmux-server.service`，macOS 使用 `com.tmux-web-panel.tmux-server.plist`；它们都由 `install-service.sh` 生成在用户服务目录中。这是为了让重启电脑后网页面板立刻能看到上次保存的会话。

工作链路：
1. 开机 → tmux companion service 跑 `tmux start-server`（macOS 为前台模式 `tmux -D`）→ 加载 `~/.tmux.conf`
2. tmux-continuum 的 `@continuum-restore 'on'` 自动从 `~/.local/share/tmux/resurrect/last` 恢复 sessions/windows/panes
3. Linux 由 systemd dependency 保证顺序；macOS 安装时先加载 tmux LaunchAgent，再加载网页面板
4. 网页打开 → `server/tmux.js` 的 `listSessions()` 跑 `tmux list-sessions`，看到所有 restored 会话

不变量：

- **部署必须使用 `vendor/tmux` 子模块构建的 tmux**：`install-service.sh install` 会调用 `scripts/build-tmux.sh`，原子部署到 `~/.local/share/tmux-web-panel/bin/tmux`，不得退回系统 `PATH` 中的 tmux
- **`~/.tmux.conf` 必须保留 `set -g exit-empty off`**：否则 systemd 启动的空 server 会因 continuum auto-restore 慢一拍而自杀
- **不要在 `tmux-server.service` 里预创建会话**（如 `tmux new-session -d -s main`）：continuum auto-restore 检测到已有 session 就不会触发，会话恢复失效
- **`server/tmux.js` 的 `listSessions()` 是只读**：不会自动创建/启动 tmux server。如果 server 不存在，网页就是空——这是设计意图，恢复责任在 systemd + continuum

排障：

- 启停 tmux server：`systemctl --user {start,stop,restart} tmux-server`
- 手动 `tmux kill-server` 后 unit 重启会拉起空 server，但**不会** auto-restore（continuum 只在 server 首次启动时触发），需 `prefix + Ctrl-r` 手动恢复
- continuum 只恢复窗口结构、cwd、命令行；不恢复进程内存状态（vim/claude 重启但不保留 buffer）

## 移动端工具盘交互契约

FAB 悬浮按钮 + 底部工具盘（drawer）在 `public/js/terminal.js` 的 `_createFabPanel` / `renderDrawer` 中实现。修改时必须尊重以下约定：

- **软键盘与工具盘互斥**：xterm 的 `.xterm-helper-textarea` focus = 系统软键盘唤起的唯一信号。`document.addEventListener('focusin', ...)` 哨兵监听：drawer open 且 focus 命中 textarea 时自动 `toggleDrawer(false)`。不要引入绕过这个哨兵的 focus 调用。
- **iOS 手势上下文**：`term.focus()` 必须在用户 tap 的 touchend/click 回调里**直接同步调用**——塞进 `setTimeout` 会让 iOS Safari 判定非用户手势而拒绝唤起软键盘。
- **抽屉按键不退出**：工具盘里按键发送后 drawer 保持打开（像软键盘一样）。只有 ×、backdrop、或终端 focus 会关闭。不要在按键处理里加 `toggleDrawer(false)`。
- **不要恢复已删的 FAB popup 面板**：`.fab-panel` / `togglePanel` / `positionPanel` / `_startVoice` / `_stopVoice` 等已全部移除。FAB 点击直接开 drawer。

## 桌面端选中复制契约

`~/.tmux.conf` 是 `set -g mouse on`，所以 xterm 会把所有左键拖动转发给 tmux，并**关掉自己的本地选区**（`_selectionService.disable()`）。tmux 收到后再分流：进 copy-mode，**或**——如果 pane 里跑着抢鼠标的程序（claude/vim/htop/带 mouse 的 less）——直接把拖动透传给那个**程序**。程序的弱/无文本选择就是"选几个字符就断"的来源，**在原生终端里同样会断**（"tmux 内部异常时浏览器也异常"），因为这是 tmux 的路由，不是网页面板的问题。

两条选择路径，改动时不要混淆：

- **裸拖（plain drag）= tmux copy-mode / 或被 pane 内程序吃掉**：copy-mode 高亮是 tmux 服务端画的反显，松手 `MouseDragEnd1Pane send -X copy-pipe` → OSC 52 → `server/terminal.js` 的 `extractOsc52` 拦截 → 浏览器剪贴板。copy-mode 是**按 pane 隔离**的（拖到 pane 边界就停，是正确行为）。pane 跑抢鼠标程序时裸拖根本进不了 copy-mode。
- **修饰键拖动 = xterm 本地选区（绕开 tmux 和程序）**：靠 `macOptionClickForcesSelection`（`createTerminalInstance`）打开。**Mac 用 Option/Alt+拖动，Linux/Win 用 Shift+拖动**。这是原生终端里"按 Shift 绕过程序鼠标"的网页等价物，不受重绘/边缘/copy-mode 状态影响，但只覆盖可见视口（不含 tmux 滚动历史）。

不变量：

- **`macOptionClickForcesSelection` 只在 zoom/tab 模式开（`!nozoom`）**：tab 模式 xterm 只渲染单个 zoom 后的 pane，本地线性选区干净。**split（nozoom）模式必须关掉它**——此时网格里是整个窗口的所有 pane + 边框，xterm 的**线性选区不认 pane**，Option+拖动会越过 `│` 边框选到隔壁 pane（垃圾）。split 模式只能用 tmux 自己的按-pane copy-mode（裸拖 / 键盘 `prefix + [`）。
- **Mac 删不得**：Mac 上 xterm 的 `shouldForceSelection` 是 `altKey && macOptionClickForcesSelection`，没这选项 Mac 就再没有任何键能本地选区（**Shift 在 Mac 被忽略，还会把 SGR 按钮码 32→36 连 tmux 也不认**）。Linux/Win 用 Shift，该选项 no-op。`shouldColumnSelect` 在该选项开时会被 xterm 自动禁用，所以 Option+拖动是普通线性选区、不是矩形选区。
- **本地选区靠 `mouseup` 复制**：xterm 选区在 canvas 上、非 DOM 文本，Cmd/Ctrl+C 抓不到，所以 `connectTerminalWs` 里给 `term.element` 挂了 `mouseup` → `term.getSelection()` → `_copyToClipboard`。裸拖 / split 模式时 xterm 选区为空，所以**不会与 OSC 52 双重复制**，split 模式下自动失效。
- **mouseup 复制限桌面**（`window.innerWidth >= 768`）：移动端有自己的长按选择 + Copy 按钮 UI，不走这条。
- 别给 Mac 用户建议"按 Shift 选择"——那是 Linux/Win 的行为，Mac 上无效。任何平台/任何模式下最可靠的是键盘 copy-mode：`prefix + [` → `v` 选 → `y` 复制（按 pane，且走 OSC 52）。
