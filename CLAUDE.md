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

## 移动端工具盘交互契约

FAB 悬浮按钮 + 底部工具盘（drawer）在 `public/js/terminal.js` 的 `_createFabPanel` / `renderDrawer` 中实现。修改时必须尊重以下约定：

- **软键盘与工具盘互斥**：xterm 的 `.xterm-helper-textarea` focus = 系统软键盘唤起的唯一信号。`document.addEventListener('focusin', ...)` 哨兵监听：drawer open 且 focus 命中 textarea 时自动 `toggleDrawer(false)`。不要引入绕过这个哨兵的 focus 调用。
- **iOS 手势上下文**：`term.focus()` 必须在用户 tap 的 touchend/click 回调里**直接同步调用**——塞进 `setTimeout` 会让 iOS Safari 判定非用户手势而拒绝唤起软键盘。
- **抽屉按键不退出**：工具盘里按键发送后 drawer 保持打开（像软键盘一样）。只有 ×、backdrop、或终端 focus 会关闭。不要在按键处理里加 `toggleDrawer(false)`。
- **不要恢复已删的 FAB popup 面板**：`.fab-panel` / `togglePanel` / `positionPanel` / `_startVoice` / `_stopVoice` 等已全部移除。FAB 点击直接开 drawer。
