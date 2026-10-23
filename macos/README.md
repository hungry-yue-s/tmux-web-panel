# Tmux Panel for macOS

完整桌面包内置服务端、Node 运行时、`node-pty`、项目维护的 tmux 与所需运行库。第一次打开可在原生界面完成初始化；已经有手工安装环境的用户默认继续使用原服务，不会被自动迁移。

## 下载与第一次打开

1. 从 [GitHub Releases 的 Assets](https://github.com/hungry-yue-s/tmux-web-panel/releases) 下载与 Mac 芯片匹配的完整包，并把 App 放入“应用程序”。**Source code (zip)** 是源码，不是客户端安装包。
2. 按首次引导创建账号密码。默认服务地址为 `127.0.0.1:17681`，只接受本机连接；内置组件、运行时安装、服务注册与连接检查分步显示。
3. 进入工作台后，从“设置与运行状态”检查组件、后台服务、日志和统一设置。退出或关闭客户端窗口不会结束 tmux 会话；电脑关机、注销和停止 tmux 则可能结束正在运行的任务。
4. 想用手机时，再到可选远程访问设置中开启局域网访问。先验证当前地址可达，再按指引创建自己的 Duck DNS 名称和 GitHub Pages 引导网页。它们帮助收藏固定入口，不是内网穿透。

完整步骤、公开网页的创建方式与故障排查见[桌面首次使用指南](../docs/desktop-onboarding.md)。每次 Release 应分别列明实际支持的系统、架构与签名/公证状态，不能把本机 ad-hoc 构建视为面向所有 Mac 的正式分发包。

当前完整包面向 **macOS 13.5+**，提供 `arm64`（Apple Silicon）与 `x64`（Intel）构建。本地输出为没有 Developer ID 或 Apple 公证的开发预览包；Rosetta 下的 x64 检查不代表 Intel 真机验收，最低系统版本扫描也不代表已经在 13.5 真机运行。下载附件的实际可用性和验证范围以该次 Release 为准。

## 托管模式与原有环境

托管数据统一保存在 `~/Library/Application Support/Tmux Panel/`：`settings.json` 为设置来源，`runtime/` 保存运行时版本，`logs/` 保存日志，`tls/` 保存证书，`relay-site/` 保存导出的引导网站。凭据以密码哈希保存，不需要放在命令行或手工编辑配置文件中。

托管服务使用单独的 `com.tmux-web-panel.desktop` 与 `com.tmux-web-panel.desktop.tmux` 标签，以及独立的 tmux socket 和配置；不会改写 `~/.tmux.conf`，也不会替换源码安装的旧服务。检测到已有 LaunchAgent 时，客户端默认沿用它；原安装的配置和运维仍由原安装管理。

引导页文件可以从客户端导出，由用户在自己的 GitHub 账号下创建仓库并上传。客户端的可选设置保存域名和公开引导页 URL，不会自动代替用户发布仓库。密码、Duck DNS token、CA 私钥和整个个人数据目录都不应上传。

设置修改遵循“先保存，再应用并重启面板”。更改账号或密码并应用后，当前客户端与其他设备都需要重新登录；重启面板保留 tmux 会话。替换 App 后，可用“更新/修复内置组件”安装新运行时，旧组件与数据继续保留；无法确认新旧会话引擎兼容时会拒绝自动替换，新组件健康检查失败时恢复原配置并尝试恢复原面板。不要为绕过兼容检查而结束现有任务。

## 原生工作台

主窗口使用与工作区融为一体的透明标题栏，保留系统红黄绿按钮；顶部窗口信息与工具按钮统一为紧凑的单行布局。顶栏空白区域可按住拖动窗口，按钮、菜单和输入控件保留网页交互。

工作台包含：

- 使用 `WKWebView` 打开本机面板
- 托管模式从统一设置识别地址；已有安装从 `~/Library/LaunchAgents/com.tmux-web-panel.plist` 识别 HTTP/HTTPS 和端口
- 对回环地址上的自签名 TLS 证书做证书数据匹配，不进行无条件信任
- 菜单栏显示网页、面板 LaunchAgent 和 tmux companion 状态
- 顶栏按钮和菜单命令均可触发原生全屏，并提供刷新、浏览器打开及日志入口
- 将后台窗口的命令完成事件桥接到 macOS 通知中心
- 点击原生通知返回对应 session/window
- 将终端本地选区及 tmux OSC 52 内容通过同源原生桥写入 macOS 剪贴板
- Mermaid PNG 可通过系统保存面板下载，也可直接写入 macOS 图片剪贴板
- 在 App 内用独立原生窗口打开站内预览和终端弹窗，外部链接仍交给默认浏览器

服务器状态面板上方的“独立展示”可将整个面板放进单独窗口，保留当前服务器和性能／Agent 控制台／连接页签。Swift 使用原生子窗口，浏览器使用新标签页；独立面板内仍可切换页签，点击“打开工作区”后恢复完整导航。

新版原生客户端在“设置 → 外观 → 主题”提供“背景透明度”，范围为 0–50%，默认 0%（不透明）。调高后通过 macOS 原生材质对窗口背后的桌面和其他窗口做毛玻璃模糊，文字保持清晰；浏览器端保持原有不透明外观。macOS 窗口透出依赖 WebKit 的非公开 `drawsBackground` 开关，运行时会检查支持情况；不支持时隐藏此设置。主窗口和独立终端窗口均支持。

使用绿色按钮进入独立桌面的原生全屏时，客户端将当前屏幕的桌面壁纸作为本地背景，毛玻璃改为在窗口内采样这张壁纸；退出后恢复原有的窗口背后采样。壁纸只在原生端读取，不上传、不写入仓库。多显示器按窗口所在屏幕选择；动态壁纸显示系统提供的静态图像。当前桌面内的普通最大化不启用此背景。若壁纸不可读取，则保留同屏最近可用图像或原有系统材质。

“毛玻璃强度”可独立调节为 0–100%，默认 100% 保持原生材质效果；0% 关闭毛玻璃。它调节背景材质的混合强度，不改变文字或背景透明度；两项设置均自动保存并同步到独立终端窗口。背景透明度为 0% 时，毛玻璃被不透明背景遮住。

## 从源码构建

构建者需要 Xcode 命令行工具，以及 `autoconf`、`automake`、`bison`、`cmake`、`pkg-config` 等构建工具；这些不是下载安装包用户的前置要求。仓库的 tmux 子模块需已初始化。

```bash
npm run test:macos
bash scripts/build-macos-app.sh
open "dist/macos/Tmux Panel.app"
```

默认构建包含完整运行时。用 `TMUX_PANEL_ARCH=arm64` 或 `TMUX_PANEL_ARCH=x64` 选择架构；对应原生 macOS runner 是正式构建路径，Apple Silicon 上已安装 Rosetta 时也可构建 x64，但仍需 Intel 真机单独验收。`TMUX_PANEL_BUNDLE_RUNTIME=0` 仅生成开发薄壳，不能用于首次安装后台环境。

无签名材料时，输出为 `dist/macos/Tmux-Panel-macOS-<arch>-development.zip` 及其 `.sha256` 校验文件。开发构建使用 ad-hoc 签名，不能宣称通过 Gatekeeper 正式分发验证。

### GitHub Actions 与正式发布

[macos-client.yml](../.github/workflows/macos-client.yml) 的手动 `workflow_dispatch` 没有额外输入项：在 Actions 中选择分支并运行，工作流分别使用原生 `macos-15`（arm64）与 `macos-15-intel`（x64）runner。没有证书 secret 时，手动运行只生成开发构建 Artifact，不创建正式 Release。

正式发布前，在仓库 Actions secrets 配置下列名称；不要把任何值提交到仓库：

| Secret | 用途 |
|---|---|
| `MACOS_CERTIFICATE_P12_BASE64` | Developer ID Application 证书与私钥的 P12，Base64 编码 |
| `MACOS_CERTIFICATE_PASSWORD` | P12 导出密码 |
| `MACOS_CODESIGN_IDENTITY` | 完整的 `Developer ID Application: …` 签名身份 |
| `APPLE_ID` | 提交公证的 Apple 账号 |
| `APPLE_TEAM_ID` | Apple Developer 团队 ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | 公证账号的 App 专用密码 |

推送严格格式 `vMAJOR.MINOR.PATCH` 的 tag 会触发发布构建。缺少签名材料时 tag 构建会失败；成功路径要求完整运行时、Developer ID 签名、Apple 公证、票据装订和评估。两种架构均构建成功后，工作流上传 `*-notarized.zip` 和校验文件，并创建 **GitHub Release 草稿**；维护者仍需检查附件与真实验收范围后再手工公开。工作流存在不代表这些签名、公证或跨系统验收已经完成。

本地正式构建使用 `TMUX_PANEL_CODESIGN_IDENTITY`、`TMUX_PANEL_NOTARY_PROFILE` 和 `TMUX_PANEL_DISTRIBUTION=1`；profile 应预先保存于 `notarytool` 钥匙串。可用 `TMUX_PANEL_NOTARY_KEYCHAIN` 指定该钥匙串；应用版本和构建号分别由 `TMUX_PANEL_APP_VERSION`、`TMUX_PANEL_BUILD_NUMBER` 提供。

托管模式加载自己的本机地址；沿用旧环境时加载原 LaunchAgent 声明的地址。临时调试其他地址时，可以在启动 App 前设置 `TMUX_PANEL_URL`，例如：

```bash
TMUX_PANEL_URL=http://127.0.0.1:7681 "dist/macos/Tmux Panel.app/Contents/MacOS/TmuxPanel"
```

原生通知不会自动弹权限框；请从菜单栏选择“启用原生通知”。
