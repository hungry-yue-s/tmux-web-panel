# 低延迟传输：Mac 验收与 Mosh 交接（2026-11-03）

## 当前范围

`feat/low-latency-mac-validation` 基于传输分支 `c025635`，并合入 `master` 的 `19bd619`，保留文件分栏恢复和移动端信任登录修复。它是独立验收分支；分支存在、测试通过不代表正式服务已部署。

已纳入验收的实现：固定证书下恢复 TLS 会话、小输出帧免压缩、无请求体 GET/HEAD 在应答前连接重置时限次重试，以及默认关闭的可选 HTTPS 直连。真实的终端输入、Git 请求、状态 ping 是不同工作负载，不能相互代替验收。

Mac 审查补充了以下修复：

- 重试共享第一次请求的剩余期限，排队、连接、发送不能各自重新获得完整预算；开始响应后不限制长传输。
- 重试所剩的短超时只结束该请求，不能判定整条 SSH 隧道失效。
- 直连请求失败后的回退先核对连接代际，再取 SSH 路由，避免连接已重置时访问空隧道。
- 升级后的 socket 仍归 NodeLink 管理；关闭或重置只结束该 link 的连接，拒绝迟到的升级，不重放终端输入。直连健康检查失败不会切断已经建立的终端。
- 小型内部 JSON 调用和直连检查的总期限覆盖排队、TCP、TLS 与响应，异常关闭及时收敛；直连检查取消后不得被迟到结果重新启用。

## 测量口径

从 Hub 机器运行小样本预探：

```sh
node scripts/measure-node-paths.mjs cc-windows --samples 10 --warmup 2 --cold 0 --interval-ms 50
```

工具自建 SSH 转发、只 ping 状态 WebSocket，不 attach tmux，也不输入文字。输出配对、转发就绪、状态握手等阶段的耗时和固定错误码；取消、失败和正常结束都清理本次自建资源。冷请求的超时覆盖 TCP、TLS 和整个响应。

- 已打开的状态 socket ping 测到的是链路与 Node 事件循环，不能直接称为按键回显耗时。
- 分位数只统计成功 pong；未收到 pong 不等于测到了 TCP 丢包。
- 字节数是该 WebSocket socket 的计数增量，可能含状态推送，不是整机带宽，也不含完整 SSH 开销。
- 只有两条路径都获得有效样本才允许比较。单路径基线保持 `comparable: false`，退出码为 2，不能据此宣称直连收益。
- 建连和稳态分开统计；正式比较不与全量测试并发运行。

本次少量新建连接的分段预探已确认 SFTP 和 SSH 转发能够建立，独立读取配对约 5.9–10.2 秒、转发就绪约 3.7–4.5 秒。它们是新建连接的成本，不能直接解释已连接终端每次按键为何卡顿。直连普通 socket 出站出现 `EBADF`，回环连接正常；执行环境限制是候选原因，尚未证实，不能归因服务器、防火墙或某个过滤器。

随后独立测得 100 个 SSH 路径样本（另有 5 次预热），测量时未运行全量测试：

| 指标 | 状态 WebSocket ping |
| --- | --- |
| 成功 / 超时 | 100 / 0 |
| p50 / p95 / p99 | 270.65 / 931.99 / 996.84ms |
| 最大值 / ≥1 秒 | 1141.99ms / 1 次 |
| 测量进程 CPU / 测量时长 | 213ms / 43.716 秒 |
| 测量进程事件循环 p99 / 最大值 | 14.65 / 44.96ms |

这支持链路往返及其抖动会显著影响交互的判断，但不能单凭 ping 将全部延迟归因公网、SSH 或 Windows CPU，也不能证明新分支减少了多少延迟。报告明确保持 `comparable: false`；本次创建的 SFTP 和 SSH 子进程均已退出，未接入用户终端、未重启服务。TLS 会话恢复主要减少新连接成本，小帧免压缩用于减少小帧压缩开销；这两项不能消除这段稳态往返时间，本次没有量化压缩排队收益。

CPU 复查和网络测量不在同一采样窗口：UTC 07:17:25 的 Node 系统指标显示 CPU 96.8%、内存 55.2%；UTC 07:21:35–37 的 2.037 秒进程 CPU 增量中，`MsMpEng` 占整机约 23.02%，`AliYunDunMonitor` 5.56%，三项 shell 共 7.48%，全部 Node 共 0.192%。可读且存活的进程只能解释约 40.28%，CIM 相邻读数仍为 98–100%；短命/不可读进程、系统计数口径和采样时序尚未核实，不能把差额归某个进程，也不能据此追溯前一段网络测量。当前没有证据证明 Node 进程吃满 CPU，远端资源争用仍需与卡顿同期采样。

### 同期复测：远端 Node 是否发生多秒阻塞

在确认没有其它诊断采集运行后，为本任务启动 120 秒上限的既有诊断采集，同时再测 100 个 SSH 状态 ping。预热后的 Mac UTC 窗口为 07:27:45.497–07:28:33.172，采集结束后核对 id/group，只停止本任务采集（丢弃 0），下载后离线分析。测量结束后才运行完整测试。

- 100/100 成功，p50 268.77ms、p95 955.89ms、p99 1478.95ms、最大 3921.80ms，≥1 秒 4 次，超时 0。
- 重叠的 10 个 Node 五秒窗口中，**每窗口**事件循环 p99 为 55.25–91.75ms，窗口最大值最高 112.00ms。这不是把原始事件合并计算出的 p99。
- 最慢的 3.92 秒 pong 考虑时钟不确定范围后只可能覆盖两个 Node 窗口，其窗口最大延迟为 67.76ms。它不支持多秒 JavaScript 事件循环阻塞独自解释这次往返。
- Node CPU 为 0.299–1.876%（单核为 100%），换算四核整机为 0.075–0.469%；Node 采得主机 CPU 77.78–97.78%，Windows CIM 为 66–100%。公网、SSH 和系统调度尚未分解。
- 诊断 PowerShell 自身占四核整机 0–0.47% CPU，RSS 约 164–180MB。采样器报告的一张匿名网卡 RX 511–1696B/s、TX 3815–8080B/s，包含其它程序和封装，不能与 WebSocket socket 计数相加，也不能外推实际终端大量输出时的带宽。

服务端的 capture 开始时间落在 Mac 的 start API 发送与接收之间；稳定时钟偏差假设下 remote-minus-local 的边界为 -122 到 +851ms，未将两台机器视为精确同步。五秒聚合只能作粗粒度判断，不能把每个 pong 逐一归因。该轮同样没有直连对照、没有 attach 用户终端，不能宣称新传输方案的收益已经实测。

## Mac 回归验证

Node v24.18.1，完整 Vitest 回归：137 个文件，136 通过、1 跳过；2244 项通过、3 项跳过、0 失败。测试进程移除了继承的 `TMUX` / `TMUX_PANE`，真实 tmux 用例显式指向自己创建的私有 socket。另行启用 tmux-agent 集成并传入伪造继承环境的私有 harness 验证 7/7 通过；这不代表 Windows 的 tmux/Mosh 生命周期已验收。

生产 Mac LaunchAgent PID 保持 14862，tmux 实例保持 `1873:1793170878`，验证前后已存在的窗格均可见；远端实例保持事故后记录的 `185256:1793677232`。本次验收没有重启正式 Node 或 tmux，也没有把传输分支部署到正式服务。

## Mosh 尚未通过的验收门槛

以下针对 `c025635` 之后远端工作区的未提交快照，不是本分支已经提供的产品功能。Mosh 代码没有纳入本次正式连接。

| 边界 | 快照中的位置 | 必须满足的行为 |
| --- | --- | --- |
| 取消与代际 | `server/mosh/server.js` 的 `start`、`server/api/mosh.js`；Hub 的 `server/hub/mosh-terminal.js` | pending 和 active 都有归属；浏览器离开、link 重置/删除或服务关闭后不得再 attach、接管或向旧终端输入。 |
| Windows 启动串行化 | `server/mosh/server.js` 的 CONNECT 后固定等待 | 不能把打印 CONNECT 加 300ms 当作 tmux 已接入。必须证明实际 attach 完成才释放客户端启动队列；无此证明时 Windows Mosh 保持不可选。 |
| 进程退出与回收 | `server/mosh/server.js` 的会话表和 `stop`/`stopAll` | pending 计入限额；自然退出回收；只结束能证明属于本次启动的进程，不能只凭历史 PID；退出前等待清理完成。 |
| 升级失败和回退 | `server/hub/mosh-terminal.js` 的 `handleUpgrade` 前后 | HTTP 升级拒绝、抛错、迟到 POST 都须收敛本地 PTY 和远端会话；清理结果不明时不能再 attach 第二个终端。 |
| 真实验收 | 私有 socket 的 Windows Node + Mac Hub | 验证取消、并发、resize、掉线、旧进程退出；验证 UDP 不通时的失败/回退，不重放已经交付的输入。mock 通过不能替代这些验收。 |

### 门槛现状（远端 Windows，2026-11-03）

上表各项已在 `server/mosh/`、`server/api/mosh.js`、`server/hub/mosh-terminal.js` 中实现，单元测试覆盖（`test/mosh-server.test.js`、`test/mosh-terminal.test.js`、`test/terminal-client-owners.test.js`），并在 Windows 上用真实 mosh-server / mosh-client / tmux 做了私有生命周期验收。它仍是默认关闭的实验通道，**不代表 Mac Hub → Windows Node 已验收**。

| 边界 | 现在的做法 |
| --- | --- |
| 取消与代际 | 会话 id 由 Hub 生成；Node 侧 pending 可被 `DELETE` 取消，创建请求在应答前断开即取消，结束过的 id 拒绝迟到的创建。Hub 侧尝试与已桥接终端都登记到 `NodeLink.adopt`，链路 `reset`（配对变化、关闭）时结束，并按 `generation` 拒绝落地。 |
| Windows 启动串行化 | CONNECT 后先答复 Hub，但客户端启动队列持有到 `tmux list-clients` 出现父进程为该 mosh-server 的客户端，再等 `CLIENT_SETTLE_MS`；期间 `holdStart` 阻止面板客户端离开。20 秒内无 attach 则在队列内结束会话。新客户端启动前经 `addClientOwner` 结束同一会话上的 Mosh 客户端，结果不明即 `TERMINAL_BUSY`。 |
| 进程退出与回收 | 启动中计入上限；记录 pid、启动时间、可执行文件、Windows pid，命令子进程按 pid+启动时间认（exec 后两者不变，已在 MSYS2 实测）；先结束 tmux 客户端让 mosh-server 自行通知客户端并退出，再 TERM、KILL；仍有残留报 `clean: false`。定期清扫自然退出的会话；关机等待 `stopAll` / `closeAll`。 |
| 升级失败和回退 | ws 拒绝握手、抛错、浏览器离开、迟到 POST 都结束本机 mosh-client 并 `DELETE`；只有 Node 回答 `clean: true` 才转发到 Node，否则 503。桥接期间每 15 秒查询会话状态，被接管或已结束即关闭页面连接。 |

私有验收（`-S` 私有 socket，子进程无 `TMUX`/`TMUX_PANE`，UDP 只绑 127.0.0.1；Node 侧为真实路由 + 真实 HTTP，Hub 侧为真实 `MoshTerminals` + 真实 ws；为此显式注入了 Windows 的 mosh-client，产品不允许 Windows 作客户端）。验收期间代码仍在改，按版本分列；只有最后一列是提交的代码，样本只有 3 轮：

| 检查 | 第 9–17 轮：加入会话监视后 | 第 18–20 轮：加入本地退出确认，与全量测试并发 | 第 21–23 轮：最终代码，主机空闲 |
| --- | --- | --- | --- |
| 打开、attach 证明（唯一客户端是该 mosh-server 的子进程） | 9/9 | 3/3 | 3/3 |
| ASCII + 中文输入到达窗格、输出到达页面、页面帧不含密钥 | 9/9 | 3/3 | 3/3 |
| 同一会话再开一个 Mosh 终端：旧的被结束，始终 1 个客户端，旧页面收到 exit | 9/9 | 3/3 | 3/3 |
| 关闭页面后会话与 tmux 客户端消失 | 9/9 | 3/3 | 3/3 |
| UDP 不通（客户端发往 127.0.0.2）：确认清理后转发，全程未 attach | 9/9 | 3/3 | 3/3 |
| 关机：`closeAll` + `stopAll` 后无客户端、无会话 | 9/9 | 3/3 | 3/3 |
| 无残留 mosh 进程；私有 tmux server 全程同一 pid | 9/9 | 3/3 | 3/3 |
| 单次改尺寸 | 6/9 | 0/3 | 3/3 |

改尺寸失败的每一轮，mosh pty 与 tmux 同为旧尺寸，是 Windows mosh-client 一侧（ENV-6），多见于主机负载高时。最终代码各时间（本机回环，不是 WAN）：打开约 1.3–2.0 秒，看到 attach 约 2.3–2.9 秒，接管约 1.6–2.1 秒，UDP 不通回退约 9.3–9.9 秒（8 秒连通时限 + 清理确认）。Mac 审查指出的启动保护、排队 teardown 自等待、capability 后复查三项由 mock 回归覆盖，其中前两项做了反证（改回旧逻辑时测试失败或死锁）；没有在真实进程上专门构造这些竞态。

未测或未通过、仍需 Mac 主控在真实 Mac Hub → Windows Node 上验收：Mac mosh-client（需安装）的改尺寸与预测回显；公网 UDP 是否可达（云安全组未知）及失败回退耗时；弱网、掉线重连、并发多窗格；输入法、粘贴/密码不回显、鼠标、OSC 52、链接、真彩色、Claude/vim 动态重绘；Windows 默认 tmux 上的 DA 应答（ENV-3）是否受 Mosh 客户端接入时序影响。预测显示与远端执行时间须分开报告。

### Mac 复核与长期身份修正

Mac 安装了官方 Homebrew Mosh 1.4.0 bottle，仅用于隔离验收。最终 Mosh 提交 `647bec8` 的原生客户端回收回归 1/1 通过：真实未连通客户端未响应首次结束请求，生产 helper 升级结束后，实测顺序为 `onExit → 远端 clean → fallback`；测试自身没有兜底强杀，没有 tmux、Mosh 服务端或远端操作。另有三次无 tmux 原生回环测试覆盖父进程退出与标准流关闭、首行文本、UDP 无服务端九秒负例，均保留固定字段证据，不保存密钥或输出正文。

进程身份复核发现了一个必须修复的长期会话问题：MSYS `ps -l` 的 STIME 在进程满 24 小时后从时分秒变成月日，不能用来识别进程。修正为同一 MSYS runtime 批读 `/proc/PID` 目录的 epoch mtime（逻辑进程 birth），并核对 WinPID；该 birth 保持跨 exec 的含义，而 `/proc/PID/stat` 第 22 字段可能随 Windows exec 改变。单数字日期也不再解析错列。身份读取失败、截断或缺失时保持 unknown，不能当作进程已退出；清理未确认的会话保留归属，后续接入仍须核实，避免下一次请求绕过保护。此身份核对仍不是原子操作，不作“PID 复用零风险”的承诺。

新 helper 已在 Windows 只读执行一次：205.83ms，89 行中 87 行有 epoch birth，2 行保持 unknown；源码与生成 stdin 的哈希一致，未调用 signal，也未执行 tmux 命令。`/proc` birth 与 tmux 自己的 `start_time` 是不同来源，不能要求两个字符串相等。MSYS 依赖的原始文件仅有 CRLF 差异，标准化后的源码一致。

身份修正后 Mac 完整回归为 **2311 通过、3 跳过、0 失败**。此前 `647bec8` 的一轮全量出现过一个 Git 文件 API 错误体断言失败；同文件在该分支和 master 各单独 21/21 通过，相关代码与依赖相同，该次失败记录保留，未把它冒充为已证明的 master 故障，也未为通过测试修改 Git 产品代码。

跨网络 generic 探针未取得 UDP 结论：准备脚本失败、没有启动 Mac 客户端；随后完整只读核实 Mosh 进程和该临时脚本候选均为 0。所用默认 `C:\msys64\usr\bin\mosh-server.exe` 路径当前不存在，实验用组件目录仍须从实际启动参数核对；不能把文档中的默认值当成已安装证据。原探针代码及失败记录保留，准备阶段诊断和非秘密资源归属 manifest 已补强，没有盲目重试、修改防火墙或部署正式服务。

Mosh 的启动时序可直接核对 [Mosh 1.4.0 官方源码](https://github.com/mobile-shell/mosh/blob/mosh-1.4.0/src/frontend/mosh-server.cc#L414)：CONNECT 在 fork 前输出，命令子进程先等待父进程释放，收到客户端状态后才继续执行。由此判断，固定等待不足以证明 Windows tmux 的 attach 已完成。

所有涉及 tmux 的真实实验必须遵守 [CLAUDE.md](../CLAUDE.md) 的私有 socket 和进程归属要求；操作事故及其影响边界见 [ENV-5](known-issues.md#env-5-实验进程继承-tmux-时tmux_tmpdir-不足以隔离2026-11-03)。
