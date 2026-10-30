# 终端首屏：测量和验收

打开一个窗口要多久、有没有多余的 attach，这份文档说明怎么量，以及哪些数字只能算参考。约定见 `CLAUDE.md` 的“终端首屏契约”。

## 从哪里量

`public/js/terminal-trace.js` 记录每次打开的时间线，默认关闭，开启后也只保留最近 20 次，只存时间、网格和计数，不存令牌、地址、输入和终端内容。

```js
TerminalTrace.enable();  // 记在这个浏览器里，刷新后仍然开着
// 点开一个窗口，等画面稳定
TerminalTrace.last();
TerminalTrace.disable(); // 关闭并清空
```

| 字段 | 含义 |
|------|------|
| `marks.workspace` | 工作区就绪 |
| `marks.panes` | 窗格就绪；`panesDetail.known` 为 true 表示没有多发请求 |
| `marks.font` | 核心字体结果：`true` 可用，`false` 不可用，`null` 超时 |
| `marks.wsCreated` / `wsOpen` / `ready` | socket 创建、打开、attach 客户端已启动 |
| `marks.firstOutput` / `firstParsed` / `firstRender` | 首个输出、解析、渲染 |
| `marks.stable` | 启发式的稳定时间，见下 |
| `sizes` | 网格变化，第一项之后的每一项都是一次真实变化 |
| `counts.alternateScreens` | tmux 进入备用屏的次数，大于 1 说明又 attach 或整屏重画了一次 |
| `counts.connects` | socket 连接次数 |

`ready` 不代表画面已经画好。`marks.stable` 是最后一次实质活动（大块写入、进入备用屏、尺寸变化、新连接）渲染后，安静 1 秒得出的时间。又有实质活动就会撤销并重新判断，所以要等画面稳定后再读。它看不到像素，只能算辅助：**验收以真实界面的截图和独立时序为准。**

## 判断标准

- 尺寸没有真实变化时，一次打开只有一次 attach，`counts.alternateScreens` 为 1，`sizes` 只有一项。
- 核心字体超过 `CORE_FONT_WAIT_MS` 才到时，这次挂载保持系统等宽字体，网格不变；下一次真实尺寸变化或下一次挂载才用上。
- 恢复右侧分窗时，宽度从第一次测量起就是最终值；保存为隐藏的分窗全程不占位。

## 已知限制

- 机器本身的 CPU 占用（曾观察到 77% 到 100%，其中 Defender 短时约占三分之一）和孤儿 `conhost.exe`、`bash.exe` 不归这里管，首屏优化不改变它们。
- 工作区读取超过 20 秒、普通请求超过 45 秒会明确失败，不再无限等待；连接 Hub 的隧道失效时，受影响的只有那条隧道。
