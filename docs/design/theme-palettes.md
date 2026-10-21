# 配色方案整理（2026-10-21）

当前实现位于 `design/workspace-v2`。从 13 套整理为 10 套：保留 6 套，移除 7 套重复选项，新增 4 套。默认仍为 Tokyo Night。

| 主题 | 色彩方向 |
| --- | --- |
| Prism · 棱镜（新增） | 烟紫、银灰、柔紫强调 |
| Graphite · 石墨（新增） | 中性炭黑、暖银、低饱和语法色 |
| Deep Current | 深海青、暖铜 |
| Forest Ink · 森林（新增） | 深林绿、苔黄、草木色阶 |
| Tokyo Night | 午夜蓝、清亮蓝紫 |
| Nord | 冷调蓝灰 |
| Gruvbox Dark | 暖炭灰、复古琥珀 |
| Oyster · 牡蛎白（新增） | 暖灰白、陶土红、深墨文字 |
| Solarized Light | 米黄、日光配色 |
| GitHub Light | 纯白、清晰蓝色 |

## 旧偏好迁移

删除的是选择器里的重复项，已有保存值仍可解析。读取、应用或原生窗口同步时会保存为新的标准 ID；透明度及毛玻璃强度保持原值。

| 旧 ID | 对应主题 |
| --- | --- |
| tokyo-night-storm | tokyo-night |
| catppuccin-mocha、catppuccin-mocha-pastel、rose-pine-moon、dracula | prism |
| one-dark | graphite |
| solarized-dark | deep-current |

## 旧配色修正

- 统一正文、次级文字、状态强调色和控件边界的语义映射。正文与强调色在不透明表面及 ±8% 背景混色样本上达到 4.5:1，强边界达到 3:1。
- 修正 Solarized Light 默认终端文字及各主题选区文字的低对比度；保留经典主题的 ANSI 色槽，避免破坏 TUI 背景及反显。
- 工作台和独立终端页均启用 xterm 的 `minimumContrastRatio: 4.5`，由渲染器按每个单元格的实际前景、背景处理低对比文字；不全局改亮 ANSI 背景槽。
- 弹窗主按钮、危险按钮、文件选择悬停、下载、分享及套餐标记采用主题背景色作为实色强调底上的文字色，替换固定黑字或白字。取消主操作／危险弹窗按钮悬停时的整体透明度，额度标签背景及边界随主题切换。
- 主题选择器展示简短说明及实际 ANSI 色条。预览保持不透明，不受 Swift 窗口透明度影响。

以上对比度检查不代表任意桌面壁纸透过高透明窗口后仍满足同样比值；原生材质和已有滑块保持独立。
