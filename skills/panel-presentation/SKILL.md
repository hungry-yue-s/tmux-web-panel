---
name: panel-presentation
description: 为用户个人阅读的报告、说明、对比或可视化 HTML 接入 Tmux Web Panel 的主题配色。适用于临时信息呈现网页；产品页面、品牌设计、视觉复刻及用户明确指定配色的作品遵循其自身要求。
---

# 个人信息网页的主题适配

让配色跟随阅读环境，把设计决定留给 AI 和用户。只有在任务适合用 HTML 呈现时才接入；安装本 skill 不意味着每次回答都要生成网页。

## 接入

在自包含 HTML 的 `<head>` 中加入：

```html
<meta name="tmux-panel-presentation" content="1">
```

在需要与面板协调的地方使用下面的 CSS 变量。预览引擎会在首屏提供当前配色，并在用户切换主题时更新变量；不需要请求服务、指定端口、引用 CDN 或安装框架。

| 变量 | 语义 |
| --- | --- |
| `--pp-bg` | 实色背景，适合图表等需要固定底色的区域 |
| `--pp-page-bg` | 当前容器的页面背景；桌面透明分栏中透出宿主，弹窗和普通浏览器中为实色 |
| `--pp-surface` / `--pp-surface-alt` | 内容表面 / 次级表面 |
| `--pp-glass-surface` | 可选的玻璃表面轻染色；不支持原生玻璃时退回实色表面 |
| `--pp-fg` / `--pp-muted` | 正文 / 次级文字 |
| `--pp-border` | 可见边界 |
| `--pp-accent` / `--pp-accent-fg` | 强调色 / 强调底色上的文字 |
| `--pp-success` / `--pp-warning` / `--pp-danger` | 成功 / 提醒 / 错误 |
| `--pp-purple` | 补充色 |

例如（只是接入示意，可自由改写）：

```css
:root { color-scheme: light dark; }
body { background: var(--pp-page-bg, var(--pp-bg, Canvas)); color: var(--pp-fg, CanvasText); }
a { color: var(--pp-accent, LinkText); }
```

提供变量 fallback，使原文件脱离面板仍可阅读。CSS、SVG 使用变量即可自动更新。Canvas、图表库等把颜色固化到像素的内容，可读取 `window.PanelPresentation?.getTheme()`，并监听 `document` 的 `panel-theme-change` 事件（`event.detail` 为 `{version, themeId, colorScheme, tokens, appearance}`），只更新图表颜色，保留交互状态。首次绘制时读取当前值，事件负责后续更新。

`appearance` 提供 `material`（`solid` / `native-glass`）、`transparency`（0–50）和 `glassIntensity`（0–100），变化同样触发上述事件。页面背景可使用 `--pp-page-bg`，局部表面按内容需要选择实色或 `--pp-glass-surface`。宿主已经实现窗口毛玻璃，无须再次按滑块值叠加整页 opacity、半透明背景或全页 backdrop-filter；保持文字不透明。固定实色图表可继续使用 `--pp-bg`。所有材料变量都可按设计需要选用，不要求玻璃卡片。

## 设计自由

- 这是一份颜色与变化通知协议，不是页面模板。自由选择信息结构、版式、字体、间距、形状、动效、组件和实现技术。
- 根据内容决定哪些颜色应随主题变化；图片、品牌色、领域约定色和有含义的数据颜色可以保留。需要清晰说明含义的颜色同时配合文字或标记。
- 用户要求独立的视觉风格时优先满足用户；可按局部使用变量，也可不加接入标记。不要为了主题一致牺牲内容表达。
- 不要把当前主题的颜色值写死成唯一配色，也不要接管面板的主题选择或读取父页面的数据。

[可选示例](assets/example.html) 展示 CSS、SVG 和 Canvas 的接入方式，按需参考，无须继承其布局或组件。

在面板文件预览中打开生成的 HTML，检查深浅主题下文字可读、主题切换不丢交互状态。面板外由 fallback 显示；导出或分享的渲染结果保留导出时的配色快照。
