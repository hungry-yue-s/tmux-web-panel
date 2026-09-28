# Agent 控制台

## 目标

用一个面板回答日常使用中的三个问题：每个 Agent 下一次启动会用哪个身份、这个身份还剩多少额度、此前的会话实际消耗了多少。主面板可以脱离展示：浏览器打开额外标签页，Swift `WKWebView` 壳通过既有 `window.open` 桥接打开原生子窗口。

## 领域模型

面板不把“账号池”和“供应商池”做成两个互不相干的模块，而是使用下面的关系：

```text
Agent（Claude / Codex / Qoder）
  ├─ 当前运行身份 ──> 新会话使用
  ├─ 可用运行身份
  │    ├─ 官方订阅 + 登录账号
  │    └─ API 服务 + 凭据/路由配置
  └─ 会话 ──> 启动时运行身份快照 ──> Token / 消息 / 成本

运行身份 ──> 额度窗口 / 余额 / 预算 / 重置时间
```

- **Agent** 是实际执行程序。它拥有会话，只能有一个“当前运行身份”。
- **运行身份** 是面板的核心切换单位。官方订阅账号和第三方 API 语义不同，但都能回答“下一次启动使用谁”，因此在同一个选择器中并列。
- **额度** 属于运行身份。官方订阅通常是滚动时间窗，API 服务通常是余额、预算或供应商账单，二者不强行换算。
- **会话** 属于 Agent，并应保存启动时的运行身份快照。切换只影响新会话；运行中和历史会话不改变。
- **消耗** 从会话日志汇总。日志没有身份字段时显示“运行身份未记录”，不能用当前身份倒推历史归属。

建议的稳定数据结构只有四类：`Agent`、`RuntimeProfile`、`QuotaSnapshot`、`Session`。Codex Switcher 与 CC Switch 的文件/数据库仅作为兼容导入源，不成为前端领域模型。

## 展示与操作顺序

1. 顶部 Agent 卡片先显示“下一次启动”使用的身份、主额度与本地消耗，用于快速扫一眼。
2. 点选 Agent 后显示唯一的“当前运行身份”，明确切换的生效范围。
3. “运行身份”区域把官方订阅和 API 服务放在同一网格中选择；类型只作为标签，不分裂成两套操作。
4. “额度与消耗”并列但不混算：左侧看当前身份的可用额度，右侧看该 Agent 的历史会话汇总。
5. 会话列表只展示所选 Agent。面板从本地日志读取会话，并用“会话开始时间之前最后一次已知切换”标注运行身份；没有证据时仍显示“运行身份未记录”。

Codex 账号、Codex API Provider、Claude 官方配置与 Claude API Provider 都使用同一种运行身份卡片和切换动作。Qoder 目前只有官方登录身份，面板读取其额度与本地会话，但不伪造不存在的多身份切换。

## 项目调研结论

Star 数是 2026-09-21 调研快照，只用于判断社区规模，会随时间变化。

| 项目 | 社区规模 | 值得吸收的能力 | 本项目的取舍 |
| --- | ---: | --- | --- |
| [CodexBar](https://github.com/steipete/CodexBar) | ≈21.7k stars | 多提供商适配、额度与重置时间、消费/状态、Qoder 支持、缓存最后一次成功结果 | 采用“统一视图 + 数据源适配器”思路；不扫描浏览器 Cookie/钥匙串 |
| [codex-switcher](https://github.com/Lampese/codex-switcher) | 本机参考项目 | 多 Codex 账号、OAuth/API Key、账号画像、重置 Credits、安全切换 | 只读账号仓库并提供安全切换；切换前保存当前账号已轮换 Token。本机 Codex 只按实际返回展示周额度，不推测 5 小时窗口 |
| [cc-switch](https://github.com/farion1231/cc-switch) | ≈133k stars | 多 CLI/供应商、MCP/Skills/Prompts、代理/故障转移、请求日志 | 引入其 MIT 许可下的配置投影思路；本面板自行完成直连 Provider 切换，不依赖 CC Switch 进程 |
| [claude-code-router](https://github.com/musistudio/claude-code-router) | ≈37.4k stars | 多模型路由、凭据池、重试/回退、Token/延迟/成本日志 | 适合作为后续本地控制平面的设计参考，不在当前版本引入代理链路 |
| [ccusage](https://github.com/ccusage/ccusage) | ≈18.7k stars | 多 CLI 本地日志统计、日/周/月/会话/计费块分析 | 吸收日志归一化方式；不增加对其命令运行态的依赖 |
| [ccstatusline](https://github.com/sirmalloc/ccstatusline) | 高 Star 补充参考 | 当前上下文、Token 速度、压缩次数、额度缓存失效 | 只借鉴当前会话遥测；不引入状态栏编辑器和主题系统 |
| [subswapper](https://github.com/lawzava/subswapper) / [Athena Usage Tracker](https://github.com/luckeyfaraday/athena-usage-tracker) | 补充参考 | 多账号隔离、最低用量排序、冷却与自动切换 | 当前保留人工确认切换；自动策略等有稳定额度源后再做 |

### CodexBar

最有价值的是数据层而不是 Swift 菜单栏外壳：

- 每个 Provider 独立声明认证来源、抓取策略、额度窗口和展示数据。
- 多种抓取方式按优先级回退，单一来源失败不拖垮整个面板。
- 网络失败时保留最后一次成功快照，并明确标记 `stale`，而不是把旧数据当实时数据或直接清空。
- 按前台交互、近期活动和空闲状态调整刷新间隔，合并重复刷新。
- 官方服务状态与账号额度分开，事故状态不伪装成账号额度耗尽。
- 本地日志产生的 Token/成本与供应商返回的额度并列展示，但不混算。

不迁移浏览器 Cookie 自动扫描、钥匙串遍历、PTY 登录探测、菜单栏图标和 Widget。这些能力依赖 macOS 权限或 Swift UI，且会扩大凭据读取范围。Qoder 仍由用户显式录入会话 Cookie。

### codex-switcher

现有实现已经吸收其最关键的安全切换行为：写入另一个账号前，先把 `~/.codex/auth.json` 中可能已经轮换的 Token 保存回当前账号；账号切换与后台操作串行化，并提供崩溃恢复和回滚。

后续适合独立实现的能力：

- OAuth 账号的今天、近 7 天、近 30 天 Token 和每日桶。
- 连续活跃天数、最长任务、常用集成、推理强度等账号画像。
- Manual Reset Credits 数量、最近到期时间和订阅到期提醒。
- 401 时刷新凭据后重试一次；403 不盲目刷新，避免消耗或破坏仍有效的 Refresh Token。
- 切换前只做运行状态提示，不默认结束正在运行的 Codex 进程。

当前本地检出的项目没有 `LICENSE` 文件，包清单也没有许可证声明。因此只能借鉴交互、协议和行为，不能直接复制其 Rust 或前端代码。

### CC Switch

适合迁移的是不要求其进程运行的数据能力：

- Provider 预设、配置投影、原子写入、切换前快照和失败恢复。
- 套餐额度、余额和预算的查询模板。
- Claude/Codex 等本地 JSONL 会话的增量扫描、去重和聚合。
- 模型名称归一化、输入/输出/缓存 Token 分列和自定义价格。
- 按日期、Agent、Provider、模型、项目筛选用量。
- 会话搜索、详情、复制恢复命令和显式恢复。
- MCP 配置的跨 Agent 只读盘点和差异预览。

不迁移本地代理接管、请求格式转换、故障转移、熔断、任意 JavaScript 用量脚本、云同步和 Deep Link。它们会让面板从观察/切换工具变成请求控制平面，也会引入请求内容、密钥和流式协议处理责任。

### ccusage

ccusage 的价值是统一离线统计模型：同一套结构表达日、周、月和会话用量，并保留 Agent、模型、项目、时区、输入/输出/缓存 Token 与价格来源。

本项目应在服务端复用这种归一化思路并直接读取本地日志，不通过 `npx ccusage` 或常驻子进程获取数据。成本显示必须区分：

- API Provider：供应商真实账单或按其价格表估算。
- 官方订阅：仅显示“API 等价成本”，不是实际付款金额。
- 未知模型或未知价格：显示 Token，不估算金额。

### Claude Code Router 与 ccstatusline

Claude Code Router 的 `Agent Profile` 概念适合未来的“使用指定身份新建 tmux Window”：默认运行身份仍用于普通新会话，用户也可以在启动时显式选择另一个身份；只有 CLI 官方支持隔离配置目录时才允许多个身份并行运行。

ccstatusline 中的当前上下文比例、Token 速度、当前模型和压缩次数适合放进“当前会话详情”，不应放进账号额度卡片。账号额度、单会话上下文和机器性能是三类不同指标。

## 迁移原则

“引入代码逻辑、不依赖第三方运行态”具体意味着：

1. 不调用第三方 GUI、CLI、后台服务、端口或本地代理。
2. 只复用许可证允许的算法、协议映射和解析规则；跨 Swift/Rust/TypeScript 时优先用本项目语言独立实现。
3. 第三方配置只作为兼容导入源，前端只认识 `Agent`、`RuntimeProfile`、`QuotaSnapshot` 和 `Session`。
4. 面板直接读取 Agent 官方本地日志，或由服务端直连额度接口；所有响应先脱敏再发给浏览器。
5. 数据源失败必须局部降级，并保留最后一次成功快照及采集时间。
6. 切换始终由用户确认，影响范围明确为“新会话”；历史会话身份不随当前选择变化。

建议的面板自有注册表为 `~/.config/tmux-web-panel/agent-profiles.json`。账号和 Provider 数量很少，使用带文件锁和原子替换的 JSON 足够；用量历史增长到需要索引后，再单独使用 SQLite。兼容导入应保留 `source` 和外部 ID，避免重复导入，但外部数据库结构不成为内部模型。

## 可迁移功能清单

| 优先级 | 功能 | 主要参考 | 落地方式 | 是否产生外部副作用 |
| --- | --- | --- | --- | --- |
| P0 | 最后成功快照、`fresh/stale/error/unconfigured` 状态 | CodexBar、CC Switch | 服务端缓存数据、时间和错误；失败保留旧值 | 否 |
| P0 | 自适应刷新、请求合并、账号查询并发限制 | CodexBar | 前台快、后台慢；同一数据源只保留一个进行中请求 | 否 |
| P0 | Codex 周额度严格按接口窗口展示 | CodexBar、codex-switcher | 有 `windowMinutes` 才显示周期；缺失时只写“额度” | 否 |
| P0 | Codex TOML 原文保护 | CC Switch | 只修改面板拥有字段，保留注释、顺序、快照与回滚 | 是，用户确认切换时写配置 |
| P1 | Codex 账号画像与 Reset Credits | codex-switcher | 单账号展开后延迟请求，401 最多刷新重试一次 | 只读网络请求 |
| P1 | 日/周/月/会话 Token 与成本时间线 | ccusage、CC Switch、CodexBar | 直接解析本地日志，统一模型与价格来源 | 否 |
| P1 | 会话搜索、筛选、详情、复制恢复命令 | CC Switch | 默认只读；恢复操作由用户显式触发 | 恢复时创建会话 |
| P1 | 官方状态事故与 Provider 可达性 | CodexBar、CC Switch | 状态页查询；自定义 Provider 只做 DNS/TLS/HTTP 探测 | 只读网络请求 |
| P1 | 额度阈值提醒与最低使用率账号建议 | CodexBar、subswapper | 只提醒和建议，默认不自动切换 | 否 |
| P2 | 声明式 Provider 额度模板 | CC Switch | 固定 HTTP 请求和字段映射，不执行用户脚本 | 只读网络请求 |
| P2 | 使用指定身份新建 tmux Window | Claude Code Router | 启动时绑定身份快照；按 Agent 能力决定是否隔离 | 创建本地会话 |
| P2 | MCP 配置只读总览与差异预览 | CC Switch | 先扫描和比较，写入必须再次确认 | 默认否 |
| P2 | 当前会话上下文、Token 速度、压缩次数 | ccstatusline | 由已有 Hook/会话日志提供，放入会话详情 | 否 |

### Provider 额度模板边界

CC Switch 支持自定义 JavaScript 查询，但本项目首版只允许声明式 HTTP 与字段映射。模板必须满足：

- 仅允许 HTTPS，目标为 Provider 的已配置域名或内置允许域名。
- 禁止 `file:`、localhost、环回、链路本地和私有网段，防止 SSRF。
- 设置连接/读取超时和响应大小上限。
- 凭据只在服务端插值，调试日志和浏览器响应均脱敏。
- 不允许模板执行 JavaScript、Shell、动态模块或任意文件读取。

### 暖号边界

暖号会向模型发送真实请求并消耗周额度。手动暖号每次都要求确认；自动暖号默认关闭，必须在每个 OAuth 账号卡片上单独确认开启。不提供“全部开启”或固定时刻的批量调度。

自动策略严格按当前 Codex 周额度运行：

1. 只识别额度接口明确返回的 `10080` 分钟窗口，不推测 5 小时窗口。
2. launchd 维护的面板服务每 30 秒检查已开启账号；页面或 Swift 窗口关闭不影响调度。
3. 只在新周窗口开始后的 5 分钟内发送，每个 `resetAt` 最多成功一次；最近一小时内已手动暖号时也不重复发送。
4. 账号额度已耗尽、额度无法读取、非 OAuth 账号或 Token 失效时跳过；失败后至少间隔一分钟才重试。
5. 多账号串行执行，不切换当前账号，不自动刷新 Token，不降级为 API Key。

成功后只更新独立的 `agent-warmups.json`，并将来源标记为 `manual` 或 `automatic`；不创建面板会话，也不改变当前运行身份。[OpenAI 公开文档](https://learn.chatgpt.com/docs/enterprise/access-tokens) 支持信任环境中的非交互 Codex 自动化，但未将“暖号”定义为稳定公开 API；当前请求仍是隔离的兼容适配点。

## 许可证与代码复用边界

- CodexBar、CC Switch、ccusage、Claude Code Router 为 MIT，可在保留许可证和署名的前提下选择性移植代码。
- 当前本地 codex-switcher 未声明许可证，只能独立重写相同行为，不能复制实现。
- 即使许可证允许，也不整包搬入 Swift/Rust/Tauri 模块；只迁移本项目实际需要的最小解析、映射或聚合逻辑。
- 从外部项目复制的实质性代码必须在仓库许可证/NOTICE 中记录来源、原作者和对应许可证。

## 当前实现

- `GET /api/agent-hub`：兼容读取并返回脱敏后的 Codex 账号额度、Claude/Codex Provider 状态、Qoder Credits、本地会话和身份事件。
- `POST /api/agent-hub/codex-switcher/:accountId/activate`：在同一排他事务中先切回 OpenAI Official，再切换 Codex 账号，并保留轮换后的凭据。
- `POST /api/agent-hub/codex-switcher/:accountId/warmup`：用指定 Codex OAuth 账号发送一次低推理强度的最小请求；不切换账号，不支持 API Key，不自动刷新或轮换 Token。
- `POST /api/agent-hub/codex-switcher/:accountId/auto-warmup`：保存该账号的自动暖号开关；后台调度属于面板服务，不依赖浏览器或第三方项目运行。
- `POST /api/agent-hub/providers/:providerId/activate`：按请求中的 Agent 投影 Claude 或 Codex Provider，并同步当前 Provider 状态。
- `POST /api/agent-hub/qoder/session`：显式保存 Qoder 网页会话 Cookie（文件权限 `0600`），用于读取 Credits；浏览器响应永不包含 Cookie。
- Codex/Claude Provider 与 Codex 账号切换都有排他锁、快照、崩溃恢复日志和失败回滚；切换记录只用于之后新建会话的身份归属。
- Claude/Codex 原有用量接口继续负责本地会话、Token 和当前账号额度，前端统一呈现。
- 智谱 Provider 直接读取套餐额度和余额；API Key、Access Token、Refresh Token、Cookie 不进入浏览器响应。
- 设置中的 Claude 与 Codex/Qoder 数据源开关同时控制卡片和后台请求；关闭后不读取相应账号、Provider、额度或会话。

## 数据源边界

- Codex：账号仓库来自 `~/.codex-switcher/accounts.json`，当前认证来自 `~/.codex/auth.json`；暖号开关、成功时间、来源和最后成功的周窗口键单独保存在 `~/.config/tmux-web-panel/agent-warmups.json`，不含 Token 或响应内容。
- CC Switch 兼容数据：读取 `~/.cc-switch/cc-switch.db` 和 `settings.json`，但不要求 CC Switch 安装或运行。Provider 切换由面板内置逻辑完成。代理接管模式下会拒绝直接写入，避免与代理的 live config 所有权冲突。
- Qoder：统计 `~/.qoder/tasks`，并解析 `~/.qoder/projects/*/*.jsonl` 的会话、模型及日志中确实存在的 Token；当前 Qoder 日志没有 Token 字段时显示 `—`，不以 `0` 冒充真实消耗。macOS 拒绝读取日志时降级为文件元数据。实时 Credits 由用户在面板显式配置网页 Cookie；不扫描浏览器、钥匙串或其他进程。
- ChatGPT 账号额度请求失败时保留账号和本地使用数据，不阻断整个面板。

## 后续优先级

1. 统一 Claude、Codex、Qoder 的日/周/月 Token 与成本时间线；当前先提供最近会话和累计量。
2. 额度阈值通知、重置倒计时和“最低使用率账号”建议；自动切换保持默认关闭。
3. 在有稳定需求后，再把 CC Switch 兼容格式迁移为面板自有 Provider Registry；当前不复制一套配置管理系统。

## 已知边界

- 面板只保证与自身触发的切换互斥；如果同时在 CC Switch 或其他程序里改同一份 live config，外部进程不会共享本面板的锁。操作前应关闭 CC Switch 的代理接管，面板也会主动检测并拒绝覆盖。
- 历史 CLI 日志通常不含账号/Provider ID。身份事件启用前的会话无法可靠归属，保持“运行身份未记录”。
- Qoder Cookie 会过期，需要重新配置；中国站可通过本地配置中的 `site: "china"` 使用 `qoder.com.cn`。
