# 原生 tmux 工作台

## 所有权与兼容边界

一个工作台视图展示一个真实 tmux 窗口，整个窗口只由一个 xterm 渲染。窗格树、边框、状态栏、prefix、自定义 bind-key、复制模式、鼠标、命令提示和 popup 都由 tmux 本身处理；网页不绘制第二套分窗标题，也不模拟 tmux 快捷键。外观沿用用户的 tmux 配置，后续样式定制可以作为独立插件。

远端 tmux 保留进程和历史；Node 保留自己的原生客户端；浏览器保存视图、字号和侧栏状态。会话的当前窗口、窗口的 active pane、zoom 等依然具有 tmux 原生的共享语义，多个客户端不会得到互相隔离的虚拟布局。这是保留原生能力的明确边界。

视图记录 `{serverId, instanceId, sessionId, windowId, clientId}`，文件和工具标签按 `viewId` 隔离。每个浏览器标签页有独立 clientId；刷新和短暂断线复用同一个原生客户端。关闭视图只解除订阅，默认五分钟后回收自己的客户端，不结束会话或窗格。新窗口使用持久 requestId 幂等创建；打开已有窗口不额外创建窗口。旧原型存储不自动迁移、合并或删除远端窗格。

## 原生传输

项目在固定的 `vendor/tmux` 源码上应用 `scripts/tmux-patches/`。新增 `--panel-pty COLSxROWS` 适配器使用 POSIX/MSYS 自己的 forkpty，子进程仍是正常的 tmux attach。Node 与适配器通过有长度边界的二进制帧交换原始字节、尺寸和退出信息。Windows 新路径不经过 ConPTY，尺寸变化使用同一 PTY 的 ioctl，不重新 attach。

每个持久客户端有一个辅助 control client，用于查询实际 pid/tty 对应的会话、窗口和窗格，以及请求原生重绘。浏览器字节只进入原生 PTY，不能成为 control 命令。连接先核对 tmux 实例、窗口和客户端身份；已存客户端重连时以它的实际上下文为准，允许用户已通过 prefix 切换或删除旧窗口。

`refresh-client -Q <随机 nonce>` 把完整原生重绘夹在同一输出流的 begin/end 标记之间。快照包括原生边框、状态栏、复制模式、prompt、popup、光标与终端模式。Node 验证元数据和上限，然后按 snapshot → output 序号发送。浏览器串行解析字节，在前一次 write 完成后才 reset、恢复快照并续接直播；不能用 capture-pane 文本替代完整客户端画面。

初始化字节通过 bootstrap 交给 xterm；终端查询应答走独立 response 消息，验证身份后可以在恢复完成前回到 PTY。用户输入只在恢复完成后开放；恢复不重放用户输入。普通 focus、前后台切换和相同尺寸不会触发快照或 reset。原生窗口布局改变仍由 tmux 正常重绘。

队列都有上限：单帧 1 MiB、原生输出与快照 8 MiB、浏览器待解析字节 16 MiB。慢浏览器只被解除订阅，不能牵连持久客户端或其它视图。WebSocket 每 15 秒 ping，10 秒未收到 pong 就主动释放订阅，避免半开连接长期挡住同一标签页重连。插件卸载关闭自己的客户端、控制通道、订阅、定时器和待执行请求；绝不终止用户 tmux server。

## 插件与接口

- `control-terminal` 注册 `nativeWindow: {available, protocol: 1, reason?}`（专用能力 API 另含 `mode: 'native-window'`）；工作台以运行中的 server 能力为准。
- `workbench` 提供 `#/workbench/:serverId/:viewId`。支持的服务器优先打开原生工作台；旧终端路由继续可用。
- GET `/api/workbench/native-capability` 检查能力；POST `/api/workbench/windows` 幂等创建窗口。
- `/ws/native-window/:windowId` 携带 protocol、instanceId、sessionId、clientId、cols、rows。服务器发送 ready、bootstrap、snapshot、output、context、error、exit；浏览器发送 input、response、resize、context-request。
- `context-request` 用有界 requestId 即时查询实际原生客户端。打开 Git 等操作等待这个结果，并校验视图/输入/路由代次；失败明确报错，不拿旧窗格代替。
- 原始 pane-stream/control snapshot 作为内部能力保留，不宣称具备完整原生客户端语义。Mosh 继续用于旧终端路径，不套在 native-window 或 pane-stream 外。

所有接口沿现有认证、同源写保护和 `/n/:serverId` Hub 转发。Node token 留在 Hub，HTTPS 使用固定证书，SSH 保持严格主机校验。基础 SSH 模式没有这些原生能力，需先安装 Node。

## 网络、工具与移动端

终端 WebSocket 与文件/Git/API 使用两条独立的物理 SSH 转发连接，各自复用长连接；终端通道禁止复用 SSH ControlMaster，避免大文件传输堵住同一 SSH TCP 流。丢包或远端输出量造成的延迟仍然存在，不承诺消除网络 RTT。直连仍须 TLS 与证书固定；直连失败不重置健康的 SSH 通道。

默认 Git 跟随实际聚焦窗格。已经绑定仓库的标签和草稿保持原仓库；文件标签捕获服务器、实例及窗格来源，焦点变化不改写已打开文件的请求。侧栏按本地 viewId 保存，不会被远端窗口缓存回收误删。

手机也显示完整原生窗口，分屏、zoom 和复制遵守 tmux 配置。沿用同步用户手势唤起软键盘、键盘与工具盘互斥、按键不自动关闭工具盘的规则。主题、透明度与字体加载延续现有面板；整个窗口的本地线性选择可能跨窗格，推荐原生按窗格的 copy-mode。

## 构建、升级和验收

Linux/macOS 用 `scripts/build-tmux.sh`；Windows 用 `scripts/build-tmux-windows.ps1`，在 MSYS2 中构建同一 vendor 源码与补丁。Windows 产物按内容哈希安装到不可变路径，运行时 DLL 和 shell 从 MSYS2 根目录解析；路径包含空格与单引号也必须正常工作。

替换磁盘二进制不会升级正在运行的 tmux server。旧 server 保持现有终端入口，原生工作台只在探测到 `native_client_protocol=1` 后启用。不要为了启用能力重启仍有用户任务的 tmux；Node、Swift 和 tmux 的生命周期分开处理。

测试必须使用显式私有 socket，移除 TMUX/TMUX_PANE，清理前核对 socket 和 server PID。覆盖原生 prefix/custom bind、resize 同 PID、复制模式/提示/popup 全画面恢复、linked windows、会话切换、慢客户端、断线、辅助通道恢复、Git 即时焦点与插件撤销。真实平台结果及网络/资源测量应按实测报告，不用单元测试或局域网数字宣称公网性能。

### 2026-11-06 验收记录

- macOS 私有 socket：8 项原生客户端测试通过，涵盖自定义 prefix 分屏、同 PID resize、复制模式/状态栏/边框、prompt 光标、popup、输出限额、输入堵塞后 EOF 回收以及并存客户端。4 项真实 NativeWindowPool 集成覆盖恢复、linked window、即时焦点和切换会话后删除旧会话。
- Windows/MSYS2：通过正式构建 helper 从 vendor+补丁构建不可变候选，含空格与单引号的安装路径、缓存命中不覆写运行 exe、两种 native 能力均验证。原生 PTY 的复制模式逐 cell 重连、prefix 分屏、原地 resize、同 server/client PID 和订阅释放均通过。私有 server 暂停、输入积压后 dispose，在 2245 ms 内自行回收 attach，Node 强杀回退次数为 0，恢复后的 server 实例不变。
- Manjaro：同一最终补丁完整编译通过，原生 PTY/复制模式逐 cell 恢复、状态栏、边框、prefix、同 PID resize、断线重连和序号均通过。40 次 Node→PTY→Node 回显全部收到，2 ms 采样下中位 3.96 ms、P95 5.32 ms，测试原生输出总量 17,866 字节；这是远端本机管线测量，**不包含跨网传输 RTT，不代表公网输入延迟**。
- 所有上述底层实验均使用独立 socket，清理前核对 PID/socket；没有重启正式 tmux server 或结束用户任务。

- JavaScript 完整回归：168 个测试文件通过、2650 项通过；56 项按平台或显式集成开关跳过。原生专项另行执行，不以默认跳过代替验证。浏览器真实四窗格下，稳定静置 5 秒 snapshot/resize/reset 均为 0；原生命令提示中刷新后 native client PID 与 tty 保持一致。

- 390px 手机视口：工具盘切键盘同步聚焦，连续三次立即输入的完整字节与独立命令退出码 0 均核对通过，期间 snapshot/reset/error 均为 0。Git 依据真实点击窗格读取，文件预览跨断点后返回可点击，已有提交草稿保留。
