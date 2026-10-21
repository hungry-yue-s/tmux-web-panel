# Tmux Panel for macOS

这是现有 tmux-web-panel 的原生薄壳。它不会替代 Node、tmux 或浏览器客户端，也不会在窗口关闭时停止后台服务。

主窗口使用与工作区融为一体的透明标题栏，保留系统红黄绿按钮；顶部窗口信息与工具按钮统一为紧凑的单行布局。顶边留有原生窗口拖动区域。

第一版包含：

- 使用 `WKWebView` 打开本机面板
- 从 `~/Library/LaunchAgents/com.tmux-web-panel.plist` 自动识别 HTTP/HTTPS 和端口
- 对回环地址上的自签名 TLS 证书做证书数据匹配，不进行无条件信任
- 菜单栏显示网页、面板 LaunchAgent 和 tmux companion 状态
- 顶栏按钮和菜单命令均可触发原生全屏，并提供刷新、浏览器打开及日志入口
- 将后台窗口的命令完成事件桥接到 macOS 通知中心
- 点击原生通知返回对应 session/window
- 将终端本地选区及 tmux OSC 52 内容通过同源原生桥写入 macOS 剪贴板
- Mermaid PNG 可通过系统保存面板下载，也可直接写入 macOS 图片剪贴板
- 在 App 内用独立原生窗口打开站内预览和终端弹窗，外部链接仍交给默认浏览器

新版原生客户端在“设置 → 外观 → 主题”提供“背景透明度”，范围为 0–50%，默认 0%（不透明）。调高后通过 macOS 原生材质对窗口背后的桌面和其他窗口做毛玻璃模糊，文字保持清晰；浏览器端保持原有不透明外观。macOS 窗口透出依赖 WebKit 的非公开 `drawsBackground` 开关，运行时会检查支持情况；不支持时隐藏此设置。主窗口和独立终端窗口均支持。

“毛玻璃强度”可独立调节为 0–100%，默认 100% 保持原生材质效果；0% 关闭毛玻璃。它调节背景材质的混合强度，不改变文字或背景透明度；两项设置均自动保存并同步到独立终端窗口。背景透明度为 0% 时，毛玻璃被不透明背景遮住。

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
