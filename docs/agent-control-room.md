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
| [codex-switcher](https://github.com/Lampese/codex-switcher) | 本机参考项目 | 多 Codex 账号、OAuth/API Key、5 小时/周额度、安全切换 | 只读账号仓库并提供安全切换；切换前保存当前账号已轮换 Token |
| [cc-switch](https://github.com/farion1231/cc-switch) | ≈133k stars | 多 CLI/供应商、MCP/Skills/Prompts、代理/故障转移、请求日志 | 引入其 MIT 许可下的配置投影思路；本面板自行完成直连 Provider 切换，不依赖 CC Switch 进程 |
| [claude-code-router](https://github.com/musistudio/claude-code-router) | ≈37.4k stars | 多模型路由、凭据池、重试/回退、Token/延迟/成本日志 | 适合作为后续本地控制平面的设计参考，不在当前版本引入代理链路 |
| [ccusage](https://github.com/ccusage/ccusage) | ≈18.7k stars | 多 CLI 本地日志统计、日/周/月/会话/计费块分析 | 吸收日志归一化方式；不增加对其命令运行态的依赖 |
| [subswapper](https://github.com/lawzava/subswapper) / [Athena Usage Tracker](https://github.com/luckeyfaraday/athena-usage-tracker) | 补充参考 | 多账号隔离、最低用量排序、冷却与自动切换 | 当前保留人工确认切换；自动策略等有稳定额度源后再做 |

## 当前实现

- `GET /api/agent-hub`：兼容读取并返回脱敏后的 Codex 账号额度、Claude/Codex Provider 状态、Qoder Credits、本地会话和身份事件。
- `POST /api/agent-hub/codex-switcher/:accountId/activate`：在同一排他事务中先切回 OpenAI Official，再切换 Codex 账号，并保留轮换后的凭据。
- `POST /api/agent-hub/providers/:providerId/activate`：按请求中的 Agent 投影 Claude 或 Codex Provider，并同步当前 Provider 状态。
- `POST /api/agent-hub/qoder/session`：显式保存 Qoder 网页会话 Cookie（文件权限 `0600`），用于读取 Credits；浏览器响应永不包含 Cookie。
- Codex/Claude Provider 与 Codex 账号切换都有排他锁、快照、崩溃恢复日志和失败回滚；切换记录只用于之后新建会话的身份归属。
- Claude/Codex 原有用量接口继续负责本地会话、Token 和当前账号额度，前端统一呈现。
- 智谱 Provider 直接读取套餐额度和余额；API Key、Access Token、Refresh Token、Cookie 不进入浏览器响应。
- 设置中的 Claude 与 Codex/Qoder 数据源开关同时控制卡片和后台请求；关闭后不读取相应账号、Provider、额度或会话。

## 数据源边界

- Codex：账号仓库来自 `~/.codex-switcher/accounts.json`，当前认证来自 `~/.codex/auth.json`。
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
