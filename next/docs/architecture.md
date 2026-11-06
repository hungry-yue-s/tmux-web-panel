# next/：一切皆插件

`next/` 是 tmux-web-panel 的重写，思路来自 DeepSeek Harness：没有特权内核，产品的每一部分都是插件，插件注册的一切都是可逆的副作用，整个应用由一份可打印、可覆盖的配置组装出来。内核和 dsh 一样是 [Cordis](https://github.com/cordiverse/cordis)，vendor 在 `vendor/`（来源和补丁见 [vendor/README.md](../vendor/README.md)）。

根目录 `CLAUDE.md` 的契约（Windows 上的 tmux 客户端、会话保护、终端首屏、Hub/Node……）对 `next/` 全部有效。

## 结构

```
next/
  kernel/      profile 与补丁、loader、createApp —— 内核只做组装
  plugins/     每个功能一个插件：服务端接线（index.js）和它的前端（client/，含 page.json）
  lib/         从旧 server/ 搬来的、验证过的业务模块（路由、TerminalManager、会话保护……）
  client/      浏览器端的 Cordis 内核：boot、核心服务 api、共享 DOM 工具
  profiles/    panel.yml：整个产品
  vendor/      Cordis、cosmokit、timer 的发布版
  test/        内核与插件的测试；test/lib/、test/client/ 是随代码迁来的旧服务端与前端测试
```

**`lib/` 与 `plugins/` 的分工。** 旧代码的问题不在业务模块，而在组装：`server/index.js` 用 657 行手工接线、手工排启动顺序、手工列关机步骤。重写把组装换成插件，把验证过的模块原样搬进 `lib/`（相对引用不变，旧测试随之迁来，作为对等规格）。插件负责“什么时候、以什么依赖、向哪里注册”，`lib/` 负责“怎么做”。之后可以在不动组装的前提下逐个重构 `lib/` 里的模块。

**仓库路径。** 迁移期间 `next/` 在仓库里面，不是 JavaScript 模块的共享资源——`scripts/`（服务安装、远程安装、Windows 采样）、`vendor/tmux-plugins/`、`plugins/`（tmux-agent 目录）、`skills/`、版本号所在的 `package.json`——仍在仓库根目录，统一经 `lib/paths.js` 的 `repoPath()` 取得（`TWP_REPO_ROOT` 可覆盖）。不要在代码里写相对于当前目录的路径。

## 运行

```sh
cd next
npm install
node bin/panel.js                    # profile panel，配置照旧来自环境变量 / --config
node bin/panel.js --dump-config      # 打印组装结果，不启动
node bin/panel.js --patch my.yml     # 叠加一层补丁
npm test
```

`bin/panel.js` 接受旧服务端的全部命令行选项（`--config`、`--port`、`--host`、`--auth`、`--tls-cert`、`--tls-key`、`--http-port`、`--poll-interval`、`--max-connections`），由 `launch` 插件读取，所以服务管理器把 `node server/index.js` 换成 `node next/bin/panel.js` 不需要改任何配置。

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
2. home 补丁：`$TWP_HOME/patch.yml`，默认 `~/.config/tmux-web-panel/next/patch.yml`；
3. 每个 `--patch <file>`，按命令行顺序。

`panel --dump-config` 打印叠完的结果和参与的每一层。打印出的任何条目都能被补丁替换；除此之外没有别的地方会挂载插件。

条目：

```yaml
- id: http                 # 唯一，补丁按它定位
  use: http                # 见下
  config: { port: 7690 }   # 原样传给插件
  disabled: false
```

`use` 的解析：`./x.js`、`../x.js` 或绝对路径是相对于**声明它的文件**的模块；裸 id（如 `http`）在 `plugins/<id>/index.js` 存在时是内置插件；其余按包名从 `next/` 解析（如 `@cordisjs/plugin-timer`）。

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

`http` 插件内部用 Express 分发，使搬来的路由保持原语义（`req.params`、`res.json`、multer、流式响应）。顺序与旧 `server/index.js` 一致：

| 阶段 | 内容 |
|---|---|
| 中间件 `order < 0` | 诊断计数（-100）、`/n/` 转发（-50）：原始流，压缩和解析请求体之前 |
| 压缩 | 页面、脚本、JSON；`/api/files/raw` 和 `/api/upload` 除外 |
| 中间件 `order >= 0` | `/api` 登录守卫 |
| 路由与挂载 | 按 `order`，同 order 内精确路径先于通配，再按注册顺序；静态站点挂在 `/`，`order: 1000` |
| 404 / 错误 | `{ error: { code, message } }`；未知异常记日志，返回 500，不带内部细节 |

- `ctx.http.mount(prefix, router, { json, order })` 挂 Express 路由，`prefix` 可带 `:参数`；默认先解析 100 KB 的 JSON（`json: false` 关闭，`json: { limit }` 调整）。
- `ctx.http.get/post/...(path, handler)` 是原生路由：`handler({ req, res, url, params, body })` 返回值即 JSON。
- 升级请求先过 `useUpgrade` 钩子（同样按 order：诊断 -100、转发 -50、鉴权 0），再到 `upgrade` / `websocket` 路由。`websocket(path, handler)` 共用一个 WebSocketServer（1 MB 帧上限、终端输出压缩），关机时以 1001 关闭所有连接。
- `/n/local/…` 转发会就地改写 `req.url` 再交给本地处理，所以路由匹配读 `req.url`，不读 `originalUrl`。

## tmux：选哪个 server

`lib/tmux-server.js` 是唯一决定面板对哪个 tmux server 说话的地方。默认不带任何全局参数，用用户的 server，和旧代码完全一样。`tmux` 插件的 `socket`（`-L`）或 `socketPath`（`-S`）选择私有 server 后，面板起的每个 tmux——命令执行器、终端接入的 PTY（Unix 的 `sh -c` 命令行和 Windows 的 argv）、文件辅助命令——都带上这个参数，子进程环境删掉 `TMUX` / `TMUX_PANE`，继承来的 `$TMUX` 无法把命令送到用户的 server。

会话保护要调用 tmux-resurrect 的脚本，脚本直接用默认 socket，无法跟随选择，所以选了私有 server 时 `session-protection` 插件不启动会话保护（托管资源照常）。新增任何启动 tmux 的代码都必须经 `tmuxServerArgs()` / `tmuxEnv()`，做不到的就检查 `isPrivateServer()` 并拒绝运行。

## 插件与接缝

| 条目 | 提供的服务 | 依赖 | 内容 |
|---|---|---|---|
| `logger` | — | — | 日志打到进程控制台 |
| `timer` | `timer` | — | `ctx.interval / timeout / debounce / throttle`，随插件撤销 |
| `launch` | `launch` | — | 环境变量与 `--config` 解析出的启动配置（`lib/runtime-config.js`） |
| `http` | `http` | launch | 见“HTTP 管线”；TLS 时另起 HTTP→HTTPS 跳转 |
| `diagnostics` | `diagnostics` | launch, http | 有界诊断记录，`/api/diagnostics` |
| `tmux` | `tmux` | — | 本机 tmux API（`lib/tmux.js`）与 server 选择 |
| `node` | `node` | launch, http, tmux | 配对文件、node token、`/api/node/info` |
| `auth` | `auth` | launch, http, node | 登录与 TOTP、令牌持久化与限流、`/api` 守卫、WebSocket 鉴权 |
| `workspace` | `workspace` | http, tmux | 会话/窗口/窗格树与修改，`/api/workspace`；修改发 `status/workspace-changed` |
| `tmux-api` | — | http, tmux | 旧的按名字/序号的 `/api/sessions…`、`/api/panes`、`/api/status` |
| `notifications` | `notifications`, `agentEvents` | launch, http | 通知存储与 Agent 事件 |
| `status` | `status` | launch, http, notifications, agentEvents | `/ws/status`，轮询 tmux，转播 `status/*` 事件 |
| `terminal` | `terminals` | launch, http, workspace | `/ws/terminal/:paneId`，TerminalManager 的全部 Windows 契约 |
| `pins` | `pins` | launch, http, tmux | 固定窗口 |
| `share` | `shares` | launch, http, timer | 预览快照分享，公开的 `/s/:id` |
| `files` | — | launch, http | 文件、上传、Git、SQLite、notebook、`twp open` |
| `metrics` | `metrics` | http | 系统与进程监控、历史、窗口资源、场景发现 |
| `agent-hub` | `agentHub` | launch, http | Agent 控制台、用量、预热、集团模型中继 |
| `servers` | `servers` | launch, http, auth, node, terminals, timer | 服务器列表、健康、SSH 链路与直连、`/n/` 转发、基础模式、Hub 侧 Mosh 终端、安装 Node 与 Mosh 组件；关机时 Mosh 终端先经链路结束会话，再关链路 |
| `mosh` | `mosh` | http, node, workspace, terminals, servers | Node 侧 Mosh 会话（`/api/mosh` 只认 node token 加 hub 标记），按 tmux 插件选的 server 接入；卸载时结束其进程 |
| `panel-plugins` | `panelPlugins` | launch, http, tmux, workspace, servers | tmux-agent 等面板插件与 MCP |
| `session-protection` | `managedResources`, `sessionProtection` | launch, http, tmux | 托管资源；会话保护（私有 server 时关闭） |
| `client` | `client` | http | 浏览器端 Cordis 内核、import map、客户端条目清单（`/client/manifest.json`） |
| `ui` | `ui` | launch, http | 主页面的组装、各插件前端的静态目录（内容哈希）、桌面版的中继配置 |

插件之间的广播走事件，不互相持有引用：

| 事件 | 发出方 | 接收方 |
|---|---|---|
| `status/workspace-changed (revision)` | workspace | status |
| `status/server-status (status)` | servers | status |
| `status/notifications (notifications)` | notifications（Agent 事件） | status |
| `status/event (event)` | files（`twp open`） | status |
| `mosh/refresh-components` | servers（本机装完 Mosh 组件后，`parallel` 等它完成） | mosh |

可选组件的能力（`mosh`、`moshClient`）由提供方经 `ctx.node.setCapability(name, probe)` 报进 `/api/node/info`，包在 `ctx.effect` 里随插件撤销。

## 浏览器端

**前端也归插件所有。** 原来的 `public/` 按功能拆进各插件的 `client/` 目录：外壳、路由、侧栏、设置页在 `ui`，终端、xterm、字体切片、移动端工具盘在 `terminal`，文件预览与 block 在 `files`，登录页在 `auth`，监控在 `metrics`，Agent 控制台在 `agent-hub`，通知、诊断、管理页、会话保护各在自己的插件。URL 一个没变（`/js/terminal.js` 还是 `/js/terminal.js`）：每个插件把自己的 `client/` 挂在 `/`，按注册顺序查找。

**主页面是组装出来的。** `ui` 的 `client/index.html` 只是模板，`<!--ui:head-->` / `<!--ui:body-->` 处放进各插件 `client/page.json` 声明的样式、脚本和字体预载：

```json
{
  "serve": ["."],
  "head": [{ "order": 10, "style": "/vendor/xterm/xterm.css?v=6.0.0" }, { "order": 20, "preload": "/fonts/tpm/…woff2" }],
  "body": [{ "order": 210, "script": "/js/terminal.js?v=25" }, { "order": 130, "module": "/js/sort-windows.js?v=1" }]
}
```

- 插件在 `apply` 里 `ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)))`：有页面时才贡献，插件卸载时它的脚本和目录一起从页面消失。
- `order` 是全局顺序，跨插件排序，保证脚本按依赖先后加载（旧脚本之间通过全局对象互相调用）。新增脚本时按它依赖谁、谁依赖它选一个空位；现在的顺序与原 `index.html` 逐字节一致。
- 可选功能（通知、监控、Agent 控制台、管理页、会话保护、诊断）关掉后页面照常工作：外壳对它们的全局对象都先判断存在。外壳、终端、文件三者互相依赖，作为一组使用。
- `?v=` 只是标记，渲染时替换成内容哈希 `?h=`；页面每次校验，资源缓存一年，改了文件刷新即生效，不用重启。
- 字体切片由 `scripts/build-font-subsets.mjs` 生成，写进 `terminal` 的 `client/`，核心片的预载就是它 `page.json` 里的 `preload` 项。

**浏览器端内核。** `client` 插件把 import map（`cordis`、`cosmokit`、`@cordisjs/plugin-timer`、`@twp/client` 和每个模块 URL → 带内容哈希的 URL）和 `/client/boot.js` 放进组装出的页面。boot 只建根上下文，按公开的 `/client/manifest.json`（登录前就要能读）挂载核心服务 `api` 和各功能用 `ctx.client.entry()` 注册的客户端插件，与旧脚本并存、不碰它们的 DOM。浏览器控制台里 `twp` 就是根上下文。旧脚本以后可以逐个改写成这样的客户端插件。

## 测试

- `npm test`（在 `next/` 下）。`test/` 是内核与插件的测试；`test/lib/` 是随模块迁来的旧服务端测试（引用从 `../server/` 改为 `../../lib/`，仓库资源经 `repoPath()`）；`test/client/` 是随前端迁来的旧测试，读主页面的用 `test/helpers/pages.js` 的组装结果，按文件名找脚本的用 `clientPath()`。全部一次跑可能内存不够，可以按目录分开跑。
- `test/panel.test.js` 用真实输入启动整个 `panel` profile：`AUTH`、临时配置目录与家目录、私有 tmux server，覆盖登录、`/api` 守卫、工作区、WebSocket 鉴权、终端接入和运行时关闭插件。
- **隔离规则**（来自“不在用户 tmux 上做实验”）：每个用到 tmux 的测试和冒烟都经 `tmux` 插件选私有 server（`-L`），`kill-server` 之前先 `display -p '#{socket_path}'` 断言是私有路径；配置目录（`launch` 的 `env.TMUX_PANEL_CONFIG_DIR`）和配对文件所在的家目录（`node` 的 `home`）指向临时目录；会读 `~/.claude`、`~/.codex` 或起模型中继的 `agent-hub` 关掉。
- 冒烟时像服务脚本一样带上 `LANG=C.UTF-8 LC_CTYPE=C.UTF-8`（`run-panel.ps1`、systemd 单元都设置了）。没有 UTF-8 locale 时 tmux 命令客户端把中文会话名输出成 `____`，再拿它去查就找不到。
- **MSYS2 的 tmux 退出后不删除 socket 文件**，测试要自己删。在 Git Bash 里直接运行 MSYS2 的 tmux 去启动 server 会挂住（server 继承了 shell 的输出管道），准备会话请用 Node 的 `execFile`。
- 这台 Windows 机器上，旧仓库原本就有一批测试失败（文件权限位、本机没有的工具与路径等），`test/lib/` 里同样的 11 个文件照样失败：`api/codex-usage`、`api/dsh-tui`、`api/enterprise-runtime`、`api/qoder-capabilities`、`api/qoder-usage`、`api/token-switch-claude-relay`、`auth`、`scene-discover/lazygit`、`server-registry`、`ssh-connection`、`totp`；`plugin-management` 的一项时好时坏。`test/client/` 全部通过。新的失败不在此列，就是回归。
- 合并 master 时：前端文件和前端测试靠 git 的改名识别自动跟到插件目录；`server/` 的改动要生成补丁、路径改成 `next/lib/` 后 `git apply --3way`，`server/index.js` 的接线改动手工翻译成插件；改过或新增的服务端测试重新复制到 `test/lib/` 并改路径。
- 根目录的 `vitest.config.js` 排除了 `next/**`，旧测试和新测试各跑各的。

## 迁移路线

1. **已完成**：内核与组装（profile、补丁、`--dump-config`、运行时开关）。
2. **已完成**：服务端全部跑在插件上（阶段 A）——旧 `server/` 的模块进 `lib/`，`server/index.js` 的全部接线拆成上表的插件，旧服务端测试迁来；页面由 `ui` 插件照旧提供，产品功能与旧服务端对等。
3. **已完成**：前端归插件（阶段 D 第一步）——`public/` 拆进各插件的 `client/`，主页面由 `ui` 组装，前端测试迁到 `test/client/`。
4. 切换部署（阶段 C）：`install-service.sh` / `.ps1`、`run-panel.ps1`、桌面版运行时与 macOS 打包改为启动 `next/bin/panel.js`；先在一台机器上验证，再删除根目录的 `server/`。
5. 前端模块化（阶段 D 之后）：把旧的全局脚本逐个改写成 ES 模块的客户端插件（`ctx.client.entry()`），全局对象换成服务；可以随功能迭代逐步做，不阻塞部署。
