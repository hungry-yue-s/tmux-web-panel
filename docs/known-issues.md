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

## 捕获环境备注

两条和产物无关但值得记下来的事。CDP 的 `Page.startScreencast` 在这台共享 Chrome 上返回的帧偶发无样式，所以所有动画改成定时 `page.screenshot` 静帧合成，脚本在 `.playwright-mcp/readme-shot/shot.mjs`。截图里的主机名、内网和公网 IP、服务器名、进程名都在捕获期做了 DOM 文本替换脱敏，tmux 状态栏的主机名用 session 级 `status-right` 覆盖掉，规则见同目录 `shot.mjs` 的 `SANITIZE_RULES`。
