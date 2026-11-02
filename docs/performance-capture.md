# 限时性能采集

用于复现远端操作卡顿、Git 分栏失败。先采集用户真实操作，再按同一时间段分析；不会自动修改性能参数。默认关闭，经已认证的 API 显式启动，每端最多 2 小时、64 MiB；写盘队列最多 1 MiB，满载或写入失败会自行停止。运行文件在各端配置目录的 `diagnostics/` 下，不进 Git。服务重启不会自动续采。

## 操作

以下工具使用本机已登录会话和现有 CA，通过本机 HTTPS 7681 的 Hub 访问远端。凭据只在内存中，不进入命令行或输出。输出目录请放在仓库外；每轮使用新目录。

```sh
node scripts/capture-diagnostics.mjs start /path/to/capture cc-windows
node scripts/capture-diagnostics.mjs status /path/to/capture
node scripts/capture-diagnostics.mjs stop /path/to/capture
node scripts/capture-diagnostics.mjs download /path/to/capture
```

启动后刷新主工作台一次，Swift 内嵌工作台与浏览器均会自动加入本次采集，无需打开开发者工具。发现采集状态最多等 15 秒。记录终端交互、切换窗口、Git 加载和失败的时间；出现明显卡顿时可顺手记下大致时刻，结束后通知分析者。收集期间不需要保持性能面板打开。独立 `terminal.html` 不含主工作台的认证/API 环境，本轮不采其客户端指标；服务器侧流量仍会被记录。

工具会将两端 ID、共同 groupId、发起/返回时间存入 `capture-session.json`。部分启动失败也保留已启动端的 ID，便于检查或停止；不会停止另一轮捕获。下载允许运行中的快照，正式分析宜先停止再下载。断电或强制退出可能丢失最后未写完的数据；下载中的最后不完整行应忽略。

## 采集范围和口径

- **HTTP**：规范化接口名、状态、首响应与总耗时、返回体字节、客户端中止。Hub 另外记录等待代理模式、连接池排队、TCP/TLS、发送及收到响应头的阶段；随机请求 ID 连接客户端、Hub、Node 三侧。Git 和 tmux 子命令记录操作名称、耗时、输出字节及退出/超时状态，不记录参数、目录、stdout/stderr 内容。
- **网络**：服务端 HTTP 字节在压缩之后计数，不包含 HTTP/TLS/SSH 头；终端和状态 socket 的计数包含 HTTP/WebSocket 帧与压缩后的数据，不包含 TLS/SSH 加密开销。客户端记录 UTF-8 应用消息字节，包含 JSON 外壳，不是线上带宽。Windows 记录每块网卡的累计字节与差分 B/s，网卡以匿名稳定 ID 关联，不能把虚拟和物理网卡直接相加。比较这些层级时不能重复求和；网卡还包含其它程序的流量。
- **机器与进程**：每 5 秒记录 Node CPU/RSS/堆内存、事件循环延迟与占用，整机 CPU 和可用内存；Windows 的持续采样子进程补充关键进程、分组数量/RSS/CPU与各网卡流量。Mac 补充 Swift、WebKit、WindowServer、Node 等进程；WebKit 可能属于其它应用，不能仅凭名称归因。Node `processCpuPercent` 的 100% 表示一颗逻辑核；OS 进程样本 `cpuPercent` 按全部逻辑核归一化。首次或未知样本为 null，不是 0%。RSS 分组求和可能重复计算共享页。
- **客户端**：API 包含响应体解析的耗时、HTTP/网络/超时/中止错误；Git 区分 API 与渲染失败；终端首屏沿用 TerminalTrace 时序，稳定画面仍是启发式判断。终端未解析积压 `count` 为 UTF-16 字符高水位；`queueMs` 是最旧积压的年龄；`parseMs` 是批次标记进入写队列到解析完成的延迟；`renderMs` 是输出到绘制事件的延迟，均不是 GPU 纯渲染时间。可见页面的心跳漂移可发现主线程停顿；支持 Long Tasks 的浏览器额外记录长任务，WKWebView 不支持时仍有心跳。客户端会话最多排队 300 条，批量上传失败直接丢弃并依赖服务端记录，不无限重试。

不保存终端正文、按键、剪贴板、文件内容、请求体、URL query、命令行、认证头或原始错误消息。诊断 API 受现有 token 与同源写入保护。采样器只结束自己创建的 PS/ps 子进程，不重启或清理 tmux。Windows 采样器短时测试显示约 165 MiB RSS、稳态约四核整机 0.24% CPU，仅为一次短样本估计；实际开销应查看当前捕获的 powershell 分组与采样耗时。
