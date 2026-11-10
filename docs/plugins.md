# 一切皆插件

tmux-web-panel 跑在 [Cordis](https://github.com/cordiverse/cordis) 插件内核上，思路来自 DeepSeek Harness（同一个内核）：没有特权内核，产品的每一部分都是插件，插件注册的一切都是可逆的副作用，整个应用由一份可打印、可覆盖的配置组装出来。内核以发布版 vendor 在 `vendor/`（来源和补丁见 [vendor/README.md](../vendor/README.md)）。

根目录 `CLAUDE.md` 的契约（Windows 上的 tmux 客户端、会话保护、终端首屏、Hub/Node……）都落在这些插件和 `lib/` 里。

图解版见 [plugins-overview.html](plugins-overview.html)：插件依赖图、启动和请求流程、页面组装、补丁用法。克隆后用浏览器直接打开即可，不需要启动面板。

## 结构

```
kernel/      profile 与补丁、loader、createApp —— 内核只做组装
plugins/     每个功能一个插件：服务端接线（index.js）和它的前端（client/，含 page.json）
lib/         业务模块（路由、TerminalManager、会话保护、Hub 链路……），由插件接线
client/      浏览器端的 Cordis 内核：boot、核心服务 api、共享 DOM 工具
profiles/    panel.yml：整个产品
bin/         panel.js（启动面板）、twp（窗格里用的命令行）
catalog/     经过审核的面板插件（tmux-agent），由 panel-plugins 插件安装
vendor/      Cordis、cosmokit、timer 的发布版；tmux 子模块、tmux-resurrect
test/        kernel/plugins 的测试在 test/ 根下；test/lib/ 对应 lib/，test/client/ 对应各插件的前端，test/repo/ 对应安装脚本与原生客户端
server/      只剩 index.js：给旧服务单元留的兼容入口，启动的就是 bin/panel.js
```

**`lib/` 与 `plugins/` 的分工。** 插件负责“什么时候、以什么依赖、向哪里注册”，`lib/` 负责“怎么做”。原来的 `server/index.js` 用 657 行手工接线、手工排启动顺序、手工列关机步骤；现在这些都是插件的 `inject`、`ctx.effect` 和 profile。`lib/` 里的模块可以在不动组装的前提下逐个重构。

**仓库路径。** 不是 JavaScript 模块的共享资源——`scripts/`（服务安装、远程安装、Windows 采样）、`vendor/tmux-plugins/`、`catalog/`、`skills/`、版本号所在的 `package.json`——统一经 `lib/paths.js` 的 `repoPath()` 取得（`TWP_REPO_ROOT` 可覆盖，打包的运行时用得上）。不要在代码里写相对于当前目录的路径。

## 运行

```sh
npm install
node bin/panel.js                    # profile panel，配置来自环境变量 / --config
node bin/panel.js --dump-config      # 打印组装结果，不启动
node bin/panel.js --patch my.yml     # 叠加一层补丁
npm test
```

正式运行由服务管理器启动（见 `CLAUDE.md`）。`bin/panel.js` 接受原服务端的全部命令行选项（`--config`、`--port`、`--host`、`--auth`、`--tls-cert`、`--tls-key`、`--http-port`、`--poll-interval`、`--max-connections`），由 `launch` 插件读取；服务管理器注入的环境变量（`PORT`、`HOST`、`AUTH`、`NODE_ONLY`、`TLS_*`、`HTTP_PORT`、`TMUX_PANEL_CONFIG_DIR`）也照旧。`install-service.sh` / `.ps1` 生成的单元启动 `bin/panel.js`；还指向 `server/index.js` 的旧单元经兼容入口照常启动，重新运行安装脚本即改过来。从旧结构更新的安装还有两处遗留，由面板启动时自动处理：面板以前装的 tmux-agent 技能链接指向已不存在的 `plugins/tmux-agent/`，`managed-resources` 把它改指 `catalog/`（只认指向本仓库的链接，私有 tmux server 下不做）；`setup-relay.sh` 以前写在 `public/js/relay-config.js` 的中继配置，`ui` 把它挪到 `plugins/ui/client/js/`。

**不要用 `bin/panel.js` 直接跑在生产状态上做实验。** 默认配置目录就是正式面板的 `~/.config/tmux-web-panel`（令牌、通知、服务器列表、会话保护设置），`node` 插件还会改写 `~/.config/tmux-web-panel/node.json`（Hub 读的配对文件）。实验和冒烟一律用补丁把这些指走，并选私有 tmux server，见“测试”。

## 内核：五个概念

- **插件**：一个函数、一个带 `apply` 的对象（含模块命名空间），或一个类。`ctx.plugin(plugin, config)` 挂载它，得到一个 fiber。
- **服务**：继承 `Service` 并在构造时 `super(ctx, '<name>')` 的类，或在 `apply` 里 `ctx.provide('<name>', value)` 的值。别的插件通过 `ctx.<name>` 使用它，而不是 import 它的实现。
- **inject**：插件声明依赖的服务，全部就绪才启动；任一依赖消失，插件随之卸载，依赖回来再重新启动。加载顺序由依赖决定，不靠手工排列。
- **事件**：`ctx.on` / `emit` / `serial` / `waterfall` 等，监听器同样随插件卸载。
- **可逆副作用**：注册经 `ctx.effect(() => { …; return dispose })`。插件卸载时，它注册的路由、定时器、监听器、DOM 节点和提供的服务按相反顺序撤销。**没有一个插件写关机逻辑**；`panel` 收到 SIGTERM 就释放 loader，整个应用按依赖倒序停下。

### 用 Cordis 必须知道的六件事

1. **服务方法里的 `this.ctx` 是调用方。** `ctx.http.get(...)` 进到 `HttpService.route()` 时，`this.ctx` 是调用它的插件的上下文，所以 `this.ctx.effect(...)` 把路由记在调用方身上，调用方卸载路由就消失。所有注册类 API 都这样写。需要服务自己的上下文时（例如 loader 挂载插件），在构造函数里另存一份（`this.home = ctx`）。服务的依赖仍按服务自己的 `inject` 解析。
2. **服务类不要用 `#私有字段`。** 方法调用经过代理，`this` 不是原对象，访问 `#x` 会抛错。用 `_x`。
3. **访问未声明的服务直接抛错**（`cannot get property "x" without inject`）。可选依赖用 `ctx.inject(['x'], (ctx) => …)` 包一层：有 `x` 时这段才运行，`x` 消失时一并撤销。
4. **异步就绪放在 `[Service.init]()` 里**，返回清理函数；依赖方会等它就绪。函数插件可以直接 `async apply`。
5. **类插件的依赖写在 `static inject` 上。** 模块里 `export const inject` 只对“模块本身就是插件”（导出 `apply`）的情形有效；默认导出一个类时，Cordis 只看类的静态属性。
6. **有些名字被内核占用**：`ctx.runtime`、`ctx.effect`、`ctx.plugin`、`ctx.inject`、`ctx.on`/`emit`…、`ctx.get`/`set`/`provide`、`ctx.logger`、`ctx.events`、`ctx.registry`、`ctx.reflect`、`ctx.fiber`。服务不能叫这些名字（所以启动配置叫 `launch`，不叫 `runtime`）。

## 组装：profile 与补丁

运行中的面板是一份插件条目列表，按顺序由这些层叠出来：

1. profile：`profiles/<name>.yml`（或 `--profile <path>`），默认 `panel`；
2. 用户补丁：配置目录下的 `patch.yml`，即 `~/.config/tmux-web-panel/patch.yml`（`TMUX_PANEL_CONFIG_DIR` 或 `TWP_HOME` 可改）；
3. 每个 `--patch <file>`，按命令行顺序。

`panel --dump-config` 打印叠完的结果和参与的每一层。打印出的任何条目都能被补丁替换；除此之外没有别的地方会挂载插件。

条目：

```yaml
- id: http                 # 唯一，补丁按它定位
  use: http                # 见下
  config: { port: 7690 }   # 原样传给插件
  disabled: false
```

`use` 的解析：`./x.js`、`../x.js` 或绝对路径是相对于**声明它的文件**的模块；裸 id（如 `http`）在 `plugins/<id>/index.js` 存在时是内置插件；其余按包名解析（如 `@cordisjs/plugin-timer`）。

补丁是操作列表：

```yaml
- id: http                          # 整个替换 config
  config: { host: 127.0.0.1, port: 7699 }
- id: tmux                          # 换实现，保留 id
  use: ./my-tmux.js
- id: agent-hub                     # 关掉 / 再打开
  disabled: true
- insert: { id: mine, use: ./mine.js }
  after: workspace                  # 或 before；省略则加在末尾
```

补丁里写错 id、插入重复 id、出现未知字段都会报错并指出文件和位置，不静默忽略。

启动时任一条目 `failed`，`panel` 停掉已启动的插件并以退出码 1 结束，交给服务管理器重启；条目 `pending`（等待一个没人提供的服务）只打警告。运行中可以经 `ctx.loader.setDisabled(id, bool)` 关掉或打开条目。

## HTTP 管线

`http` 插件内部用 Express 分发，使搬来的路由保持原语义（`req.params`、`res.json`、multer、流式响应）。顺序与原来的 `server/index.js` 一致：

| 阶段 | 内容 |
|---|---|
| 中间件 `order < 0` | 诊断计数（-100）、去掉 `/n/local/` 前缀（-60，`node`）、`/n/:serverId` 转发（-50，`hub-relay`）：原始流，压缩和解析请求体之前 |
| 压缩 | 页面、脚本、JSON；`/api/files/raw` 和 `/api/upload` 除外 |
| 中间件 `order >= 0` | `/api` 登录守卫 |
| 路由与挂载 | 按 `order`，同 order 内精确路径先于通配，再按注册顺序；静态站点挂在 `/`，`order: 1000` |
| 404 / 错误 | `{ error: { code, message } }`；未知异常记日志，返回 500，不带内部细节 |

- `ctx.http.mount(prefix, router, { json, order })` 挂 Express 路由，`prefix` 可带 `:参数`；默认先解析 100 KB 的 JSON（`json: false` 关闭，`json: { limit }` 调整）。
- `ctx.http.get/post/...(path, handler)` 是原生路由：`handler({ req, res, url, params, body })` 返回值即 JSON。
- 升级请求先过 `useUpgrade` 钩子（同样按 order：诊断 -100、`/n/local/` -60、转发 -50、鉴权 0），再到 `upgrade` / `websocket` 路由。`websocket(path, handler)` 共用一个 WebSocketServer（1 MB 帧上限、终端输出压缩），关机时以 1001 关闭所有连接。
- `/n/local/…` 是本机自己的地址：`node` 插件就地改写 `req.url` 再交给本地处理（不依赖 `hub-relay`，转发关掉时浏览器照常用本机），所以路由匹配读 `req.url`，不读 `originalUrl`。

## tmux：选哪个 server

`lib/tmux-server.js` 是唯一决定面板对哪个 tmux server 说话的地方。默认不带任何全局参数，用用户的 server，和旧代码完全一样。`tmux` 插件的 `socket`（`-L`）或 `socketPath`（`-S`）选择私有 server 后，面板起的每个 tmux——命令执行器、终端接入的 PTY（Unix 的 `sh -c` 命令行和 Windows 的 argv）、文件辅助命令——都带上这个参数，子进程环境删掉 `TMUX` / `TMUX_PANE`，继承来的 `$TMUX` 无法把命令送到用户的 server。

会话保护要调用 tmux-resurrect 的脚本，脚本直接用默认 socket，无法跟随选择，所以选了私有 server 时 `session-protection` 插件不启动（`managed-resources` 照常）。新增任何启动 tmux 的代码都必须经 `tmuxServerArgs()` / `tmuxEnv()`，做不到的就检查 `isPrivateServer()` 并拒绝运行。

## 插件与接缝

拆分的标准：能单独关掉而且有意义、依赖不同、或出错时应互不连累的，就是两个插件。`profiles/panel.yml` 是完整的产品；`profiles/node.yml` 是只当 Node 的机器（`NODE_ONLY=1` 时默认用它），去掉了 Hub、分享和页面，其余条目的 id 和顺序与 panel 相同，同一份补丁两边都能用。

| 条目 | 提供的服务 | 依赖 | 内容 |
|---|---|---|---|
| `logger` | — | — | 日志打到进程控制台 |
| `timer` | `timer` | — | `ctx.interval / timeout / debounce / throttle`，随插件撤销 |
| `launch` | `launch` | — | 环境变量与 `--config` 解析出的启动配置（`lib/runtime-config.js`） |
| `http` | `http` | launch | 见“HTTP 管线”；TLS 时另起 HTTP→HTTPS 跳转 |
| `diagnostics` | `diagnostics` | launch, http | 有界诊断记录，`/api/diagnostics` |
| `tmux` | `tmux` | — | 本机 tmux API（`lib/tmux.js`）与 server 选择 |
| `node` | `node` | launch, http, tmux | 配对文件、node token、`/api/node/info`、能力声明；去掉 `/n/local/` 前缀（-60） |
| `auth` | `auth` | launch, http, node | 登录与 TOTP、令牌持久化与限流、`/api` 守卫、WebSocket 鉴权、登录是否仍有效 `/api/auth/check` |
| `workspace` | `workspace` | http, tmux | 会话/窗口/窗格树与修改，`/api/workspace`，全部按稳定 ID；还有布局选择器用的窗口布局、窗格内容、调整大小和交换；修改发 `status/workspace-changed`。原来按名字/序号的 `/api/sessions`、`/api/panes`、`/api/status` 已删除 |
| `status` | `status` | launch, http | `/ws/status`，轮询 tmux，转播 `status/*`；有 notifications / agentEvents 时接上 |
| `terminal` | `terminals` | launch, http, workspace | `/ws/terminal/:paneId`，TerminalManager 的全部 Windows 契约 |
| `keypad` | — | http | 移动端工具盘（前端）与它的场景发现 `/api/scene/discover` |
| `layouts` | — | — | 窗口布局选择器，只有前端，经 workspace 的布局/窗格接口 |
| `pins` | `pins` | launch, http, tmux | 固定窗口 |
| `notifications` | `notifications` | launch, http | 通知存储，`/api/notifications` |
| `agent-events` | `agentEvents` | http | Agent 钩子事件 `/api/agent-events`；有 notifications 时变成通知 |
| `files` | `fileAccess` | http | 文件浏览与预览 `/api/files`；文件根与路径守卫 |
| `upload` | — | launch, http | 上传 `/api/upload`；目录是它的 `dir`（原来的 `files.uploadDir` 不再读，设了会警告） |
| `git` | — | http, fileAccess | Git block 的 `/api/git` |
| `sqlite` | — | http, fileAccess | SQLite 预览 `/api/sqlite` |
| `notebook` | — | http, fileAccess | `/api/notebook` |
| `open` | — | http, fileAccess | `twp open` 的 `/api/open`，经 `status/event` 通知页面 |
| `browser` | — | — | 浏览器 block 与 `twp open <url>`，只有前端（只在 Hub） |
| `share` | `shares` | launch, http, timer | 预览快照分享，公开的 `/s/:id`（只在 Hub） |
| `metrics` | `metrics` | http | 系统与进程监控、历史、窗口资源 |
| `agent-usage` | — | launch, http | Claude / Codex 用量 `/api/claude-usage`、`/api/codex-usage` |
| `agent-hub` | `agentHub` | launch, http | Agent 控制台：Codex 账号、CC Switch 供应商、切换、预热、Qoder；集团部分按调用查 `enterpriseAi` |
| `enterprise-ai` | `enterpriseAi` | launch | 集团模型池、内嵌中继及其启停 |
| `panel-plugins` | `panelPlugins` | launch, http, tmux, workspace | tmux-agent 等面板插件与 MCP；跨服务器调用按调用查 `hubLinks` |
| `managed-resources` | `managedResources` | launch, http, tmux | 自建 tmux、技能链接、基础 tmux 配置 |
| `session-protection` | `sessionProtection` | launch, http, tmux, managedResources | 自动保存与恢复（私有 server 时不启动） |
| `mosh` | `mosh` | http, node, workspace, terminals | Node 侧 Mosh 会话（`/api/mosh` 只认 node token 加 hub 标记）；卸载时结束其进程 |
| `server-registry` | `serverRegistry` | launch | Hub：服务器列表 `servers.json` |
| `hub-links` | `hubLinks` | launch, serverRegistry | Hub：每台一条 SSH 链路，经它识别机器（`detect`，不需要基础模式）；基础模式的主机按调用找 `basicMode` |
| `server-health` | `serverHealth` | node, serverRegistry, hubLinks | Hub：探测与传输选择，发 `status/server-status` |
| `hub-relay` | — | http, auth, serverRegistry, hubLinks | Hub：`/n/:serverId` 转发（-50）；基础模式、Mosh 终端按请求查 |
| `servers` | `servers` | http, serverRegistry, hubLinks, serverHealth | Hub：`/api/servers` |
| `node-installer` | `nodeInstaller` | http, serverRegistry, hubLinks, serverHealth | Hub：安装 Node 与 Mosh 组件 |
| `basic-mode` | `basicMode` | http, hubLinks, terminals, timer | Hub：没装面板的机器的工作区与终端；卸载时只结束这些 shell，链路照旧 |
| `mosh-hub` | `moshHub` | http, node, serverRegistry, hubLinks | Hub：Mosh 终端；卸载时先经链路结束 Node 会话 |
| `client` | `client` | http | 浏览器端 Cordis 内核、import map、客户端条目清单（`/client/manifest.json`） |
| `ui` | `ui` | launch, http | 主页面的组装、各插件前端的静态目录（内容哈希）、桌面版的中继配置 |

**可选的依赖。** 依赖写进 `inject` 就是硬依赖：缺了插件不启动，对方卸载时先卸自己。可有可无的依赖不写进去，两种写法：

- 按调用查：`ctx.get('moshHub')?.retry(id)`。拿不到（没加载或已卸载）就是 `undefined`，代码要有没有它时的行为。它不建立依赖关系，不影响关机顺序。
- 有就接上：`ctx.inject(['notifications'], (ctx) => ctx.effect(() => monitor.useNotificationStore(ctx.notifications)))`。对方加载时接上，卸载时这个子作用域连同 effect 一起撤销。

**关机顺序靠依赖，不靠手写。** Cordis 卸载一个服务前，先等依赖它的插件都卸载完（`_unload` 里的 `dependents`），各自的 effect 都等完。所以 `mosh-hub` 依赖 `hubLinks`，它经链路结束 Node 会话之后，链路才会关。

插件之间的广播走事件，不互相持有引用：

| 事件 | 发出方 | 接收方 |
|---|---|---|
| `status/workspace-changed (revision)` | workspace | status |
| `status/server-status (status)` | server-health | status |
| `status/notifications (notifications)` | agent-events | status |
| `status/event (event)` | open（`twp open`） | status |
| `mosh/refresh-components` | node-installer（本机装完 Mosh 组件后，`parallel` 等它完成） | mosh |

可选组件的能力（`mosh`、`moshClient`）由提供方经 `ctx.node.setCapability(name, probe)` 报进 `/api/node/info`，包在 `ctx.effect` 里随插件撤销。

## 浏览器端

**前端也归插件所有。** 前端按功能放在各插件的 `client/` 目录：外壳、路由、侧栏、设置页、命令面板、block 框架（`blocks-kit.js`、`block-host.js`）在 `ui`；终端、xterm、字体切片、窗格条（`panes.js`）、终端里的链接识别（`link-detect.js`）在 `terminal`；移动端工具盘在 `keypad`；文件预览和分窗在 `files`；Git、浏览器、SQLite、notebook 的 block 或渲染器各在自己的插件；布局选择器在 `layouts`；登录页在 `auth`；监控在 `metrics`；Agent 控制台在 `agent-hub`；通知、诊断、托管资源、面板插件、会话保护各在自己的插件。URL 一个没变（`/js/terminal.js` 还是 `/js/terminal.js`）：每个插件把自己的 `client/` 挂在 `/`，按注册顺序查找，所以文件名在所有插件里不能重复。

**插件往外壳里加东西靠插槽，不靠外壳认识它。** `ui/client/js/slots.js` 最先加载，提供 `PanelSlots`：服务器页的分区（`serverSections`）、设置页的分区（`settingsSections`，`available()` 决定显示与否）、管理中心的面板（`managementPanels`）、命令面板的命令（`commands`）、`twp open` 的处理者（`openers`）。block 工具包另有 `Blocks.registerRenderer`（文件预览的渲染器）和 `Blocks.registerPreviewActions`（预览菜单里的动作）。插件关掉，它的脚本不加载，注册的东西也就不在。

**页面只调用在运行的插件的接口。** 页面带着本机在运行的插件清单（`window.PANEL_PLUGINS`，由 `ui` 渲染页面时写入）；别的服务器的清单在它的健康信息里（`node.plugins`，来自它的 `/api/node/info`）。外壳调用可选插件的接口前用 `PanelSlots.hasPlugin(id, serverId)` 判断；还不知道、或 Node 太旧报不出清单时当作有。

**主页面是组装出来的。** `ui` 的 `client/index.html` 只是模板，`<!--ui:head-->` / `<!--ui:body-->` 处放进各插件 `client/page.json` 声明的样式、脚本和字体预载：

```json
{
  "serve": ["."],
  "head": [{ "order": 10, "style": "/vendor/xterm/xterm.css?v=6.0.0" }, { "order": 20, "preload": "/fonts/tpm/…woff2" },
           { "order": 50.8, "style": "/css/terminal.css" }],
  "body": [{ "order": 110, "script": "/js/panes.js" }, { "order": 210, "script": "/js/terminal.js?v=25" }]
}
```

- 插件在 `apply` 里 `ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)))`：有页面时才贡献，插件卸载时它的脚本和目录一起从页面消失。
- `order` 是全局顺序，跨插件排序，保证脚本按依赖先后加载（旧脚本之间通过全局对象互相调用）。新增脚本时按它依赖谁、谁依赖它选一个空位。
- 可选功能（通知、监控、Agent 控制台、管理页、会话保护、诊断、工具盘、Git、浏览器、布局选择器……）关掉后页面照常工作：外壳对它们的全局对象都先判断存在，调用接口前看 `hasPlugin`。外壳、终端、文件三者互相依赖，作为一组使用；分窗归文件预览，所以没有 `files` 时 block 只能浮动。
- **样式也归插件。** 只有某个插件的脚本会产生的元素，它的样式放在该插件的 `client/css/<id>.css`；外壳的 `style.css` 只留外壳自己的和多个插件共用的。插件样式表紧跟在 `style.css` 之后加载（`order` 50.1–50.8，按插件名排），这样从 `style.css` 拆出来时层叠顺序不变。给插件元素加样式就写进它自己的表；如果要覆盖外壳里 `.btn`、`.input` 这类通用类，注意插件表在它之后，同等特异性时插件赢。测试里要断言样式时用 `test/helpers/pages.js` 的 `pageStyles()`（按页面顺序拼起来的全部样式），不要只读某一个文件。
- `?v=` 只是标记，渲染时替换成内容哈希 `?h=`；页面每次校验，资源缓存一年，改了文件刷新即生效，不用重启。
- 字体切片由 `scripts/build-font-subsets.mjs` 生成，写进 `terminal` 的 `client/`，核心片的预载就是它 `page.json` 里的 `preload` 项。

**浏览器端内核。** `client` 插件把 import map（`cordis`、`cosmokit`、`@cordisjs/plugin-timer`、`@twp/client` 和每个模块 URL → 带内容哈希的 URL）和 `/client/boot.js` 放进组装出的页面。boot 只建根上下文，按公开的 `/client/manifest.json`（登录前就要能读）挂载核心服务 `api` 和各功能用 `ctx.client.entry()` 注册的客户端插件，与旧脚本并存、不碰它们的 DOM。浏览器控制台里 `twp` 就是根上下文。旧脚本以后可以逐个改写成这样的客户端插件。

## 测试

- `npm test`。`test/*.test.js` 是内核与插件的测试；`test/lib/` 对应 `lib/` 的模块；`test/client/` 对应各插件的前端，读主页面的用 `test/helpers/pages.js` 的组装结果，按文件名找脚本的用 `clientPath()`；`test/repo/` 对应安装脚本、桌面运行时和原生客户端。全部一次跑可能内存不够，可以按目录分开跑（`npx vitest run test/lib` 等）。
- `test/panel.test.js` 用真实输入启动整个 `panel` profile：`AUTH`、临时配置目录与家目录、私有 tmux server，覆盖登录、`/api` 守卫、工作区、WebSocket 鉴权、终端接入和运行时关闭插件。
- **隔离规则**（来自“不在用户 tmux 上做实验”）：每个用到 tmux 的测试和冒烟都经 `tmux` 插件选私有 server（`-L`），`kill-server` 之前先 `display -p '#{socket_path}'` 断言是私有路径；配置目录（`launch` 的 `env.TMUX_PANEL_CONFIG_DIR`）和配对文件所在的家目录（`node` 的 `home`）指向临时目录；会读 `~/.claude`、`~/.codex`、CC Switch 数据库或起模型中继的 `agent-usage`、`agent-hub`、`enterprise-ai` 关掉。
- 冒烟时像服务脚本一样带上 `LANG=C.UTF-8 LC_CTYPE=C.UTF-8`（`run-panel.ps1`、systemd 单元都设置了）。没有 UTF-8 locale 时 tmux 命令客户端把中文会话名输出成 `____`，再拿它去查就找不到。
- 在同一个进程里启动面板做实验时，`app.stop()` 卸载 `tmux` 插件会撤销私有 server 的选择，之后这个进程里的 tmux 命令回到默认 server：核对 `socket_path` 和清理都要在 stop 之前做，而且显式带 `-t <会话>`（没有客户端附着时不带目标会失败）。私有 server 在 Windows 上可能卡住不应答（`docs/known-issues.md` ENV-1），这时只能按命令行里的私有 socket 名核对进程归属再结束。
- **MSYS2 的 tmux 退出后不删除 socket 文件**，测试要自己删。在 Git Bash 里直接运行 MSYS2 的 tmux 去启动 server 会挂住（server 继承了 shell 的输出管道），准备会话请用 Node 的 `execFile`。
- 测试在 Windows 上也要全过，任何失败都是回归。写测试时注意：
  - 权限位断言放在 `POSIX_MODES`（`test/helpers/permissions.js`）之后：Windows 的 `fs.stat` 只报 0o666 / 0o444。
  - 隔离家目录要同时设 `HOME` 和 `USERPROFILE`，或者把家目录作为参数传入；只设 `HOME` 在 Windows 上会写到真实家目录（`docs/known-issues.md` ENV-12）。
  - 期望的路径用 `join` / `resolve` 算，别写死 `/home/x/...`：Windows 上是反斜杠，`resolve` 还会加盘符。
  - SQLite 夹具用 `test/helpers/sqlite.js`（`node:sqlite`），不要调 `sqlite3` 命令行。
  - 只在某个平台存在的功能（macOS 桌面版、`install-service.sh`）在别的平台上 `skipIf`，并在旁边写明原因。

## 改造经过

1. 内核与组装：profile、补丁、`--dump-config`、运行时开关。
2. 服务端全部跑在插件上：原 `server/` 的模块进 `lib/`，`server/index.js` 的全部接线拆成上表的插件，原服务端测试随之迁来作为对等规格。
3. 前端归插件：`public/` 拆进各插件的 `client/`，主页面由 `ui` 组装（与原 `index.html` 逐字节一致），前端测试迁到 `test/client/`。
4. 合并改造期间 master 的改动（Mosh 传输、直连、修复），`server/` 的补丁改写到 `lib/` 后三方应用，接线改动翻译成 `servers` / `mosh` 插件。
5. 切换：代码移到仓库根，服务安装、Windows 计划任务、桌面运行时、macOS 打包、远程安装 Node 的打包清单、中继与 Android 构建脚本都改用新位置；`server/` 只留兼容入口。

6. 再拆细：面板现在是 42 个条目（Hub 的链路、转发、健康、安装、基础模式、Mosh 各自独立，文件之上的 Git、SQLite、notebook、上传、`twp open` 各自独立）；前端按插槽把功能脚本和样式归到各自的插件，删掉按名字/序号的旧 tmux 接口、隐藏的旧外壳和它们带着的死代码与死样式。

还可以继续做的：把前端的全局脚本逐个改写成 ES 模块的客户端插件（`ctx.client.entry()`），全局对象换成浏览器端的服务；把分窗从 `file-preview.js` 移进 `ui`，让 block 不依赖 `files` 也能停靠；把 `lib/` 里体量大的模块（`terminal.js`、`api/files.js`、`api/agent-hub.js`）按接缝拆成更小的插件。都可以随功能迭代逐步做。
