# 集团 AI 额度与运行身份集成

验证日期：2026-10-16。功能合入现有 Agent 控制台的身份列表及「额度与消耗」，沿用已有供应商切换、认证和同源校验。

## 当前结果

| 能力 | 实现与验证 |
| --- | --- |
| Token Switch 登录复用 | 只读加载当前已登录用户的本地会话，内存解密后直接调用集团目录及额度可用性接口。已实测下发 7 个 Codex 模式，无需运行 Token Switch。 |
| Codex 集团模型切换 | 在现有身份列表选择模型，由面板写入兼容供应商并调用已有切换流程；面板自持回环中继直接连接集团网关。已验证普通与流式请求、实际配置切换。 |
| Claude 集团模型切换 | 同一身份列表、同一集团目录；内置 CC Switch 的 Anthropic Messages ↔ Responses 转换，无需运行 CC Switch。已验证普通响应、完整流式响应及工具调用参数。 |
| Qoder IDE 专属额度 | 官方 CLI 控制协议只读查询组织资源包，实测 20,000 / 20,000 Credits，剩余 0，到期北京时间 2026-10-23 00:00。阿里郎同类接口作为备用数据源。 |
| 集团 AI 月额度 | 复用阿里郎登录态及与当前员工、设备绑定的钥匙串身份，两个只读接口均实测 HTTP 200。主资源池已用 0.69 / 24,500 Credits，剩余 24,499.31；另有 1,200 Credits 活动包保留明细，不混入主额度。以上为本次接口观测值。 |
| Qoder 使用通用资源池 | 当前账号 `allow_byok=0`，未开放自定义模型地址；保留现有登录和专属额度，不能宣称已接入通用资源池。 |

当前集团账号未直接下发 Claude 目录，Claude 通过协议转换使用同账号获准的 Codex 模式。Auto 的上游思考模型拒绝强制指定工具（`tool_choice=required` 或对象）；自动工具选择已实测成功，不修改原请求来掩盖此限制。集团账单扣减归属尚未独立核对。

## 鉴权复用及保护点

### Token Switch 0.1.7

`createTokenSwitchClient` 只读查询 `~/.token-switch/token-switch.db` 内的安装 ID、设备 ID、会话元数据及密文。依据本机 Rust 导出符号与 LLVM 反汇编还原会话版本 1 的 SHA-256 流异或解密；令牌只留在服务端内存中，不复制到面板数据库、前端、日志或项目文件。

直接接口：

- `POST /portal/token-switch/providers/available`，请求应用名为 `Codex`（区分大小写）。
- `POST /portal/token-switch/providers/quota/check`，只返回模式是否可用，不能据此推算月 Credits。
- `POST /portal/llm-api/openai/v1/responses`，复用当前会话、应用和目录模式标识。

目录缓存绑定当前会话与设备身份，调用前校验模式仍属于当前账号。服务端只访问经过验证的集团 HTTPS 地址，不跟随重定向。

关键原生位置：会话派生 `0x100716280`、异或 `0x1007165f8`、加载会话 `0x100719240`；应用名映射 `0x10051e710`；网关配置及覆盖 `0x100470600`、`0x100607b78`。托管 Codex 配置使用 OpenAI Responses 传输，不能将模式的后端 `protocolList` 当成客户端传输协议。

### 阿里郎 6.35.11

`createAliLangUsageReader` 只读解析 Electron Local Storage 的 LevelDB SST/WAL，复用当前登录 token 和员工标识；不修复、不锁定或写入原数据库。已从远程模块定位：

- 集团资源包：`GET /auth/api/v1/tokenhub/packs.json`。
- Qoder 专属额度：`GET /auth/api/v1/sm/qoder/quota/usage.json`。

服务除了已有登录态，还要求 TLS 客户端证书。仅携带登录态已实测返回 HTTP 400 `No required SSL certificate was sent`。

旧实现只按集团 issuer 和 `ssl-client` 有效策略筛选，遗漏了真正的阿里郎身份，选择了不带员工/设备绑定的其他证书；因此不能将此前停顿直接解释为系统拒绝授权。修复后枚举 `basic` 身份，读取公开 Subject Title（OID 2.5.4.12），按原生规则检查 `ownerId.startsWith(titleParts[0])` 和 `titleParts[1].startsWith('MDMSERVER' + IOPlatformUUID)`，使用首个匹配。多份同员工、同设备身份可以正常存在。

静态依据：`appSecretCredential@0x1000f4574` 取原生 `employId`；`mdmIdentityWithCommonName@0x1001fcf74` 校验 Subject Title 后返回首个匹配；`MDMUUID@0x1001c0d20` 拼接 `MDMSERVER` 和 IORegistry 的 `IOPlatformUUID`。前端 `KEY_WORK_ID` 来自原生相同的 `employId`。

系统 curl 的 SecureTransport 继续使用已有身份，不导出私钥、不改 ACL 或信任设置。URL 中的凭证及证书标签通过 stdin 配置传入；公开证书查询的标签只用于本机系统命令，不返回前端或日志。修正整个进程与每笔请求的时限，保留已完成响应，并返回脱敏的 DNS/TCP/TLS/响应阶段及 curl 状态码。潜在证书访问停顿仍暂停自动重试，避免反复弹窗；网络错误与服务端信任错误不再一律称为钥匙串授权失败。

原生私有 socket 的 Team ID 校验仍保留，不伪造签名或注入应用。mTLS 路径是另一条正常鉴权路径，不能把此前私有 IPC 失败解释为全部路径都不可用。

资源包按 API 类别汇总，活动额度保留明细，免费包不重复计入付费主额度。周期优先取 API；缺少周期时按已分析界面的 23 日至次月 22 日规则推算并标记来源，混合周期不制造统一重置时间。

### 面板运行时及已有供应商

`createEnterpriseRuntime` 仅监听 `127.0.0.1:15723`，自持 256 位本地认证密钥，配置文件权限 `0600`。拒绝浏览器 Origin、错误认证、未下发模式、未知路径及非白名单上游。它是面板服务的一部分，不需要第二个常驻应用。

Codex/Claude 供应商保存在现有 CC Switch 配置库中，以面板所有权元数据标记；只写自己的行，初始不激活，活动配置冲突时拒绝覆盖。面板已有切换器负责配置投影、日志与回滚。Codex 官方 `auth.json` 保持原状，集团投影保留现有运行设置及 MCP。

Claude 转换器移植自 [CC Switch v3.20.3](https://github.com/farion1231/cc-switch/tree/v3.20.3/src-tauri/src/proxy/providers)，提交 `2181dda6b4703a7870ffe8c52671947375dec6d0`。保留 MIT 许可和版权。支持文本、图片、函数工具及结果、流式工具参数、缓存用量和不透明推理回放；未支持的托管工具类型明确报错。服务端错误体不直接泄露到 Claude 客户端。

## 验证范围

- 17 个相关测试文件 153 项通过；随后额度备用来源与运行时收尾改动的 2 个测试文件 9 项通过。包括客户端鉴权/缓存、LevelDB 解析、额度分类、协议转换、流式边界、路由权限及已有切换器。
- 实际普通请求：Codex 和 Claude 均 HTTP 200，返回 OK，未发送项目代码。
- 实际内置流式请求：Codex 66 个事件并完成；Claude 9 个事件并完成，返回 `panel_echo` 工具调用及 `{"text":"OK"}` 参数，未执行工具。事件数量仅代表本次观测。
- 实际配置切换：Codex/Claude 都写入面板回环地址及集团模式，验证后恢复原先选中身份和配置；官方登录未改动，集团供应商保留为未选中。
- 阿里郎修复：4 个相关测试文件 53 项通过，覆盖员工及设备绑定、拒绝无关身份、首个匹配、阶段诊断、部分响应保留及界面反馈；语法和 diff 检查通过。
- 实际只读查询：修复后的系统 curl 读取两份额度均 HTTP 200，整体约 9.9 秒。另以正常 URLSession 做一次受控对照请求，也返回有效资源包 JSON；无需将 Swift 探针加入产品。主资源池 0.69 / 24,500，Qoder 20,000 / 20,000，均来自当前账号真实接口。

本机受限分析材料位于 `~/.cache/tmux-web-panel/reverse/{alilang,tokenswitch,ccswitch,qoder}/`，不提交提取物和身份材料。REA JavaScript 证据保留了包结构及语义分析；原生细节依据 Rust 符号与 LLVM 反汇编，不声称获得完整原生反编译结果。

## dsh-tui（2026-10-22）

现有 Agent 控制台增加 dsh-tui，与 Claude、Codex、Qoder 一起展示。进入 dsh-tui 卡片，选择集团模型即可为新会话切换；原有 GLM 等自定义模型可在同一列表切回。使用 `dsh-tui --backend dsh` 启动；已有会话保留原模型，可通过 `/model` 手动选择集团提供方。

原生 DSH 后端使用 `llm-pi-ai` 的 `openai-responses` 传输，复用面板现有 `/codex/v1/responses` 回环中继和当前账号下发的 Codex 模式。切换前检查集团登录、目录和额度可用性，不依赖 CC Switch 配置库。共享 Credits 显示在已有「额度与消耗」内，Qoder IDE 专属额度单独保留。

配置写入 `$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`（默认 `~/.dsh`），只增加 `tmux-enterprise` 提供方；TUI 的 `~/.dsh-tui/model.json`、`kernel.json` 保存下一次启动选择。本地中继密钥保存在 DSH 的 `~/.dsh/.credentials.yaml` 专用引用中，集团登录令牌仍只由面板服务端读取。保留 YAML 注释、`!!js` 表达式、原有模型及其他凭据，解析时不执行表达式。

沿用 DSH 配置编辑器的 profile 锁及凭据锁；写入使用已有管理中心的原子替换和私有备份，位置为 `~/.config/tmux-web-panel/backups/`。失败时恢复已完成且未被其他进程改动的文件。明确固定到其他后端的 profile 会拒绝切换，避免显示虚假生效状态；命令行或环境中的显式后端选择仍以 DSH 自身规则为准。

本机验证版本：dsh-tui 0.16.1、DSH 0.2.1-rc.2。已在现有账号刷新登录后，通过真实面板 API 切到集团 Auto；DSH 配置组合检查通过，原生 DSH headless 使用相同提供方配置和实际集团中继完成流式调用，退出码 0、回复 `OK`，未发送项目代码。请求使用独立临时 Harness home，测试结束已清理；现有 dsh-tui 保持集团 Auto 作为新会话默认。此验证确认真实请求可用，未独立核对集团账单扣减。

9 个相关测试文件共 101 项通过，覆盖原配置保留、YAML 表达式不执行、私有备份、并发锁、失败回滚、额度检查及前后端切换分发。以真实状态数据加载现有 UI/CSS 做本地浏览器渲染检查；390px 宽度无水平溢出，四个 Agent 卡片与共享额度均可见。

### DSH 状态栏仍显示 1M

集团当前下发的上下文窗口为 800,000 tokens，原有 GLM-5.3 配置为 1,000,000。面板修改新会话默认值，已有会话继续保留自身路由；应通过该会话的 `/model` 选择「集团 AI 资源包」，或新建集团会话。

dsh-tui 0.16.1 的容量显示还有一个独立问题：`resolveContextOccupancy` 优先读取上次请求的 `contextPressure.contextWindow`，使已解析为 800K 的当前路由仍显示旧 GLM 的 1M。切换时，维护逻辑对已识别的这条表达式应用兼容修复，优先使用当前路由容量；缺少当前容量时仍回退到投影。原文件纳入相同的私有备份、并发锁和失败回滚；已修复或未知实现保持原状。已运行的 DSH 需重新启动才能载入代码修复，已有会话日志不会重写。

本次 5 个相关测试文件共 51 项通过；已通过真实面板切换接口应用本机修复，并直接调用修复后的原生函数验证：旧投影 1M、当前路由 800K 时返回 800K，缺少当前路由容量时仍返回投影的 1M。

### 恢复会话实际仍走 GLM（2026-10-23）

进一步核对当前会话的 `request/header`、`request/context` 和回复 `source`，发现实际仍为 `zai-coding-cn / glm-5.3`，即使状态栏已经显示集团旗舰和 800K。此前容量修复及独立 headless 调用未覆盖恢复会话的模型选择，不能据此确认该会话的请求或额度归属。

dsh-tui 0.16.1 在恢复会话时可能沿用启动偏好作为显示模型，而 Agent 仍保留原请求路由；选择与显示相同的模型又会直接返回成功，未写入明确的路由选择。维护逻辑现在修复两条已识别的原生表达式：只有实际选择也一致时才能跳过切换；绑定恢复的 Agent 时，没有明确选择则读取 Agent 自身的提供方和模型。两处修复沿用已有配置锁、私有备份及失败回滚，已修复或未知实现不再修改。

新启动的 DSH 会载入修复。已运行进程仍持有旧代码，可在原生模型菜单先选择另一个集团模式，再选回目标模式，强制更新本次会话路由。本机当前窗口已按此方式重新绑定集团旗舰，保留未发送输入，未向工作对话发送测试消息。

验证：5 个相关测试文件共 52 项通过。另以隔离会话建立模拟 GLM 历史，使用真实原生 TUI 恢复、选择集团旗舰并发出最小测试请求；实际集团回环中继收到一次请求并返回 HTTP 200，持久化请求和回复来源均变为 `tmux-enterprise`，上下文为 800,000。切换后模拟 GLM 调用数未增加；测试未发送项目代码，临时会话和服务已清理。该结果验证实际请求路径，集团 Credits 账单扣减仍未独立核对。

### 记忆插件阻断模型路由（2026-10-23）

RL 窗口重启后的请求再次记录为 GLM，并返回智谱 429 用量上限错误。此前隔离测试只加载 DSH 基础和 TUI，未覆盖该窗口安装的第三方记忆插件，因此不能作为该窗口已修复的证据。

直接对照 [dsh-tui v0.16.1 开源实现](https://github.com/ccch1mneyyy/dsh-TUI/blob/v0.16.1/src/dsh-adapter/channel/model-selection.ts) 与本机代码：`selection.current` 必须在 `system-prompt/assemble` 阶段保存到 `selection.assembled`，请求钩子才会采用选择的模型。本机 `dsh-tdai-memory` 0.4.4 的组装监听器返回 assembly 时没有调用 `next()`；Cordis waterfall 会在这里停止，后注册的 TUI 钩子无法执行，即使界面已经切换，实际请求仍继承 GLM。

新增的 `assembly-route` 兼容修复只将已识别的 TUI 路由组装钩子注册为 `prepend: true`，使路由快照在记忆钩子之前执行；仍调用下游并保留记忆内容。未禁用或修改记忆插件，也未重写历史会话。

验证：5 个相关测试文件共 53 项通过。直接运行本机 Cordis 和 TUI 模块，复现提前返回的组装插件令请求仍走 GLM，修复后请求为集团模型且记忆内容保留。再使用带同类记忆钩子的原生 TUI 恢复隔离会话，实际集团中继返回 HTTP 200，持久化请求及回复来源均为 `tmux-enterprise`，切换后模拟 GLM 调用数未增加；临时测试资源已清理。

RL 原窗口使用原生 `/restart` 载入修复，保留同一会话并重选集团旗舰。北京时间 10:24:23 的真实请求头及上下文记录为 `tmux-enterprise`，10:24:34 的回复来源同为该提供方，回复“集团路由验证完成”，无工具调用，回合正常完成。随后再次原生重启并恢复同一会话，仍为集团旗舰，状态栏为约 353K / 800K；真实请求头已持久化，恢复时不再采用旧 GLM 路由。
