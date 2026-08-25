# Tmux Panel for macOS

这是现有 tmux-web-panel 的原生薄壳。它不会替代 Node、tmux 或浏览器客户端，也不会在窗口关闭时停止后台服务。

第一版包含：

- 使用 `WKWebView` 打开本机面板
- 从 `~/Library/LaunchAgents/com.tmux-web-panel.plist` 自动识别 HTTP/HTTPS 和端口
- 对回环地址上的自签名 TLS 证书做证书数据匹配，不进行无条件信任
- 菜单栏显示网页、面板 LaunchAgent 和 tmux companion 状态
- 顶栏按钮和菜单命令均可触发原生全屏，并提供刷新、浏览器打开及日志入口
- 将后台窗口的命令完成事件桥接到 macOS 通知中心
- 点击原生通知返回对应 session/window
- 将终端本地选区及 tmux OSC 52 内容通过同源原生桥写入 macOS 剪贴板

## 构建

```bash
npm run test:macos
npm run build:macos
open "dist/macos/Tmux Panel.app"
```

产物使用本机 ad-hoc 签名，仅用于本地运行。对外分发仍需 Developer ID 签名与公证。

默认加载 LaunchAgent 声明的本机地址。临时调试其他地址时，可以在启动 App 前设置 `TMUX_PANEL_URL`，例如：

```bash
TMUX_PANEL_URL=http://127.0.0.1:7681 "dist/macos/Tmux Panel.app/Contents/MacOS/TmuxPanel"
```

原生通知不会自动弹权限框；请从菜单栏选择“启用原生通知”。
