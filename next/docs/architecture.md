# next/：一切皆插件

`next/` 是 tmux-web-panel 的从零重写，思路来自 DeepSeek Harness：没有特权内核，产品的每一部分都是插件，插件注册的一切都是可逆的副作用，整个应用由一份可打印、可覆盖的配置组装出来。内核和 dsh 一样是 [Cordis](https://github.com/cordiverse/cordis)，vendor 在 `vendor/`（来源和补丁见 [vendor/README.md](../vendor/README.md)）。

**状态。** 生产服务仍然跑旧代码（仓库根目录的 `server/`、`public/`）。`next/` 按功能切片迁移（见文末路线），能完整替换时再切换服务管理器。根目录 `CLAUDE.md` 里的契约（Windows 上的 tmux 客户端、会话保护、终端首屏、Hub/Node……）对 `next/` 同样有效：迁移某个功能时，先把相关契约搬进对应插件并写成测试，不要重新踩一遍。

**安全。** 认证还没迁移。`http` 默认只监听 `127.0.0.1`，在认证插件完成之前不要用补丁改成对外监听。

## 运行

```sh
cd next
npm install
node bin/twp.js                    # 默认 profile: node，http://127.0.0.1:7690
node bin/twp.js --dump-config      # 打印组装结果，不启动
node bin/twp.js --patch my.yml     # 叠加一层补丁
npm test
```

`twp` 只用于开发和验证；正式部署将来由服务管理器启动，规则与根目录 `CLAUDE.md` 相同。

## 内核：五个概念

- **插件**：一个函数、一个带 `apply` 的对象（含模块命名空间），或一个类。`ctx.plugin(plugin, config)` 挂载它，得到一个 fiber。
- **服务**：继承 `Service` 并在构造时 `super(ctx, '<name>')` 的类。别的插件通过 `ctx.<name>` 使用它，而不是 import 它的实现。
- **inject**：插件声明依赖的服务（`static inject = [...]` 或导出 `inject`），全部就绪才启动；任一依赖消失，插件随之卸载，依赖回来再重新启动。加载顺序由依赖决定，不靠手工排列。
- **事件**：`ctx.on` / `emit` / `serial` / `waterfall` 等，监听器同样随插件卸载。
- **可逆副作用**：注册经 `ctx.effect(() => { …; return dispose })`。插件卸载时，它注册的路由、定时器、监听器、DOM 节点和提供的服务按相反顺序撤销。**没有一个插件需要写清理代码以外的关机逻辑。**

### 用 Cordis 必须知道的四件事

1. **服务方法里的 `this.ctx` 是调用方。** `ctx.http.get(...)` 进到 `HttpService.route()` 时，`this.ctx` 是调用它的插件的上下文，所以 `this.ctx.effect(...)` 把路由记在调用方身上，调用方卸载路由就消失。这正是所有注册类 API 的写法。需要服务自己的上下文时（例如 loader 挂载插件），在构造函数里另存一份（`this.home = ctx`）。服务的依赖仍按服务自己的 `inject` 解析：`workspace-tmux` 的方法里 `this.ctx.tmux` 可用，即使调用方没有 inject `tmux`。
2. **服务类不要用 `#私有字段`。** 方法调用经过代理，`this` 不是原对象，访问 `#x` 会抛错。用 `_x`。
3. **访问未声明的服务直接抛错**（`cannot get property "x" without inject`）。可选依赖用 `ctx.inject(['x'], (ctx) => …)` 包一层：有 `x` 时这段才运行，`x` 消失时一并撤销。`workspace` 用这种方式只在有 `client` 时注册视图。
4. **异步就绪放在 `[Service.init]()` 里**，返回清理函数。`http` 在这里监听端口，依赖它的插件要等端口真正打开才启动；`await ctx.plugin(...)` 也会等到这一步。

## 组装：profile 与补丁

运行中的面板是一份插件条目列表，按顺序由这些层叠出来：

1. profile：`profiles/<name>.yml`（或 `--profile <path>`）；
2. home 补丁：`$TWP_HOME/patch.yml`，默认 `~/.config/tmux-web-panel/next/patch.yml`；
3. 每个 `--patch <file>`，按命令行顺序。

`twp --dump-config` 打印叠完的结果和参与的每一层。打印出的任何条目都能被补丁替换；除此之外没有别的地方会挂载插件。

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
- id: workspace                     # 关掉 / 再打开
  disabled: true
- insert: { id: mine, use: ./mine.js }
  after: workspace                  # 或 before；省略则加在末尾
```

补丁里写错 id、插入重复 id、出现未知字段都会报错并指出文件和位置，不静默忽略。

启动时任一条目 `failed`（导入失败、构造抛错、`init` 失败如端口被占用），`twp` 停掉已启动的插件并以退出码 1 结束，交给服务管理器重启；条目 `pending`（等待一个没人提供的服务）只打警告。运行中可以经 `ctx.loader.setDisabled(id, bool)` 关掉或打开条目。

## 插件约定

- 内置插件放在 `plugins/<id>/index.js`。服务用 `export default class … extends Service`；普通插件导出 `name`、`inject`、`apply`（模块本身就是插件对象）。
- **一个功能一个插件，服务端和浏览器端放在一起**：浏览器部分放在 `plugins/<id>/client/`，由服务端插件调用 `ctx.client.entry(new URL('./client/index.js', import.meta.url))` 注册。服务端插件卸载，浏览器端条目随之从清单里消失。
- **功能依赖接缝，不依赖实现**：`workspace` 只用 `ctx.workspace`，从不调用 tmux；换一个 `workspace` 提供方（比如基础模式的 SSH 主机），API 和视图不用改。
- 错误：路由里抛 `HttpError(status, code, message)`，响应是 `{ error: { code, message } }`；其它异常记日志并返回 500，不把内部细节返回给浏览器。
- 日志用 `ctx.logger`；`logger-console` 插件把它打到进程控制台（journald、Windows 计划任务日志）。

## 能力接缝

一个接缝就是一个服务名：声明接口的约定、提供它的插件、使用它的插件。添加一项能力时三者一起设计；替换提供方就改变整个产品的那一块。

| 服务 | 接口 | 现有提供方 | 使用方 |
|---|---|---|---|
| `http` | `route(method, path, handler)`、`get/post/put/patch/delete`、`use(middleware)`、`upgrade(path, handler)`；`port` | `http` | 所有带 API 的插件 |
| `client` | `entry(file, config)`、`manifest()`、`importMap()` | `client` | 带界面的插件 |
| `tmux` | `exec(args, { timeout })`、`serverArgs()`、`version()`、`env` | `tmux` | `workspace-tmux`（将来还有终端） |
| `workspace` | `provider`、`read() → { provider, instanceId, complete, sessions }` | `workspace-tmux` | `workspace` |
| `loader` | `status()`、`setDisabled(id, bool)` | 内核 | 将来的插件管理页 |
| `timer` | `ctx.interval / timeout / debounce / throttle`（随插件撤销） | `@cordisjs/plugin-timer` | 任何需要定时的插件 |

浏览器端：

| 服务 | 接口 | 提供方 |
|---|---|---|
| `api` | `request(method, path, body)`、`get/post/put/patch/delete`；读 45 秒、写 5 分钟超时，错误为 `ApiError(status, code)` | `client/core/api.js` |
| `shell` | `mount(region, element, { order })`（region：`header`、`sidebar`、`main`）、`status(text, { tone })` | `client/core/shell.js` |
| `timer` | 同服务端 | `boot.js` 挂载 |

`workspace.read()` 的约定：一次 tmux 调用同时读出整棵树和 server 实例（`pid:start_time`），同一时刻的调用共享一次读取；没有 tmux server 时返回空树而不是错误（面板从不启动 tmux server）；任何窗口缺窗格时 `complete: false`，**凡是按窗口回收状态的逻辑只能在 `complete: true` 时回收**。

## 新行为放在哪里

| 目标 | 做法 |
|---|---|
| 加一个 API | 插件 inject `http`，`ctx.http.get(...)` |
| 加一块界面 | 服务端插件 `ctx.client.entry(...)`；浏览器端插件 inject `shell`，`ctx.shell.mount(...)` |
| 认证、同源检查这类横切逻辑 | `ctx.http.use(middleware)`，在路由之前运行 |
| WebSocket | `ctx.http.upgrade(path, handler)` |
| 定时任务 | inject `timer`，`ctx.interval(fn, ms)`；不要直接 `setInterval` |
| 换掉某个实现 | 提供同名服务的另一个插件，在补丁里换 `use` |
| 只在某服务存在时才做的事 | `ctx.inject(['x'], (ctx) => …)` |

## 浏览器端

- 浏览器跑同一个内核。`boot.js` 只创建根上下文、挂载 `timer`，然后按 `/api/client/manifest` 的顺序加载条目：先核心服务 `api`、`shell`，再是各功能注册的条目。
- 没有构建步骤。页面里的 import map 把 `cordis`、`cosmokit`、`@cordisjs/plugin-timer`、`@twp/client`（共享 DOM 工具）以及每个模块的 URL 映射到带内容哈希的 URL（`?h=…`），这些 URL 缓存一年；页面本身每次校验（ETag）。改了任何文件，刷新即生效，不用重启服务。
- 只提供 `client/`、`vendor/*/lib/` 和已注册条目的目录；以 `.` 开头的路径段和越出目录的路径一律 404。
- 浏览器控制台里 `twp` 就是根上下文（`twp.get('shell')`、`twp.registry`），用于调试。

## 测试

- `npm test`（在 `next/` 下）。浏览器端插件用 jsdom 测，不依赖 import map：vitest 里 `@twp/client` 由 `vitest.config.js` 的 alias 解析。
- 真实 tmux 的测试只用私有 socket（`tmux -L twp-next-test-<pid>` 加 `-f /dev/null`），结束时 `kill-server`。**MSYS2 的 tmux 退出后不删除 socket 文件**，测试要自己删（见 `test/workspace.test.js`）。
- 在 Git Bash 里直接运行 MSYS2 的 tmux 去启动 server 会挂住：server 继承了 shell 的输出管道，shell 一直等不到 EOF。准备演示会话请用 Node（经 `execFile`）。
- 根目录的 `vitest.config.js` 排除了 `next/**`，旧测试和新测试各跑各的。

## 迁移路线

每个切片完成时，相关的根目录契约要么已经在插件和测试里，要么明确写下还没覆盖的部分。

1. **已完成**：内核与组装（profile、补丁、`--dump-config`、运行时开关）、`http`、`client`（import map、清单）、`tmux`、`workspace` 只读和视图。
2. 认证：登录令牌、TOTP、node token，作为 `http.use` 中间件加浏览器端登录插件。完成前不对外监听。
3. 终端：`ws` 升级加终端服务，整体搬入 `TerminalManager` 的契约（Windows 上一次只变更一个客户端、`heldInput`、`ConsoleReaper`、取消一路到底），浏览器端 xterm 插件按“终端首屏契约”和字体切片规则实现。
4. 工作区写操作，以及基于修订号的状态推送。
5. 文件、预览分窗、Git 与 block。
6. 会话保护和托管资源。
7. Hub/Node：节点身份、链路、`/n/:serverId` 转发；基础模式作为 `workspace` 和终端的另一组提供方。
8. 监控、通知、Agent 控制台、诊断。
9. 服务安装脚本（`install-service.sh` / `.ps1`）切换到 `next/`，桌面与 Android 客户端跟进；旧代码删除。
