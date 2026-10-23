# Android 客户端

Android 8.0+ 的轻量原生客户端。使用与网页、Swift 客户端相同的服务和工作台，网页更新后下次刷新即可生效。应用采用项目的 K 方案图标。

移动客户端首次默认使用白色 Oyster 主题，原生连接页保持浅色。手动切换的工作台主题会保存到应用配置，下次启动或服务 IP 变化后继续沿用，不影响网页和 Swift 客户端自己的主题设置。

## 构建与安装

需要 JDK 17+、Android SDK Platform 36 / Build Tools 36，以及可访问 Maven 仓库的网络。Gradle Wrapper 固定为 8.13。

```bash
# 可选：预填首次连接地址
TMUX_PANEL_URL=https://192.168.1.10:7681 npm run build:android
# APK: dist/android/Tmux-Panel.apk
adb -s YOUR_DEVICE_SERIAL install -r dist/android/Tmux-Panel.apk
```

构建脚本依次运行 Java 单元测试、Android Lint 和 APK 构建，产物使用本机 Android debug key 签名，可以直接安装。同一签名可以覆盖升级；面向应用商店分发时需要另行配置正式签名，不要提交密钥。SDK 非默认路径时设置 `ANDROID_HOME`；非 macOS 系统自行配置 `JAVA_HOME`。

首次启动填写手机可访问的服务地址，随后在原有登录页登录。地址和登录状态分别保存在应用私有配置与 WebView 存储中。手机里的 `localhost` 指手机自身，通常需要填写电脑的局域网、公网或 VPN 地址。

优先使用项目的引导页链接。构建时未设置 `TMUX_PANEL_URL`，脚本会从本机 `public/js/relay-config.js` 读取引导页作为首次默认值；该部署文件不会提交。应用持久化保存引导链接，每次冷启动重新解析当前服务地址，保留引导页自身的登录存储和会话交接，不把临时 IP 或交接 Token 写入连接配置。

也可点击“扫描电脑二维码”完成配置。PC 端二维码内容约定为**原始 HTTP(S) 引导页 URL**，不包含密码、Token、查询参数或页面片段。识别后显示地址，点击“连接工作台”保存；以后启动无需再扫。取消扫码或无效二维码不覆盖已有配置。二维码展示功能可在 PC 端后续接入同一链接。

## HTTPS

证书正常验证，不忽略 TLS 错误。应用信任系统 CA 和用户安装的 CA；本机构建还会默认将 `~/.config/tmux-web-panel/ca/ca.crt` 的**公开证书**打入 APK，方便连接本机服务。证书和私钥都不会加入版本库，私钥不会读取或打包。

```bash
# 指定其他面板的公开 CA 证书
TMUX_PANEL_CA_CERT=/path/to/public-ca.crt npm run build:android
# 不内置本地 CA
TMUX_PANEL_CA_CERT='' npm run build:android
```

证书的主机名/IP 必须与连接地址匹配。更换 CA 后需重新构建，或在手机系统中安装新 CA。也可以显式填写 HTTP 地址连接仅提供 HTTP 的服务。

## 原生交互

- 键盘打开时按实际可用高度缩小工作区，避开状态栏、手势区和屏幕刘海。
- 系统返回先收起键盘、预览或弹层，再返回网页历史；关闭客户端不结束服务器上的 tmux 会话。
- 文件上传使用系统文件选择器，保存使用系统文档位置选择器，无需全盘存储权限。网页 Blob/图片导出单次上限 16 MB；普通同源 HTTP 文件下载流式保存。
- 独立预览在客户端内打开，可以一键返回工作台；外部网页交给浏览器。
- 网页“设置”页顶部有“Android 客户端 · 连接设置”，可换地址、刷新或在浏览器打开。页面连接错误时也有设置入口。
- 状态栏随网页主题更新。原生桥仅开放给当前工作台主框架；配置的引导页可以自动解析到新的 HTTPS 服务地址，普通外部链接和独立预览没有原生桥。

客户端需要服务在线；不在 Android 后台运行 tmux、Node 服务或常驻保活任务。通知沿用工作台页面内通知，暂未实现 Android 系统推送。

前端桥接回归测试：`npx vitest run test/android-client.test.js`。Java 测试与 Lint 报告位于 `android/app/build/reports/`。

扫码复用 [ZXing Android Embedded 4.3.0](https://github.com/journeyapps/zxing-android-embedded/tree/v4.3.0)（Apache-2.0），在设备上识别，不依赖 Google Play 服务。相机权限仅在主动扫描时申请，手动配置不需要相机权限。
