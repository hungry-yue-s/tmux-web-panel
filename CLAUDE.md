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

`tmux-web-panel.service` 依赖 `tmux-server.service`（用户级 systemd unit）：unit 文件在 `~/.config/systemd/user/`，不在仓库内。这是为了让重启电脑后网页面板立刻能看到上次保存的会话。

工作链路：
1. 开机 → `tmux-server.service` 跑 `tmux start-server` → 加载 `~/.tmux.conf`
2. tmux-continuum 的 `@continuum-restore 'on'` 自动从 `~/.local/share/tmux/resurrect/last` 恢复 sessions/windows/panes
3. `tmux-web-panel.service` 的 `After=tmux-server.service Wants=tmux-server.service` 保证启动顺序
4. 网页打开 → `server/tmux.js` 的 `listSessions()` 跑 `tmux list-sessions`，看到所有 restored 会话

不变量：

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
