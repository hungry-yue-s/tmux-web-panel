# 设计原型的第三方资源

## Lucide 静态 SVG 子集

- 上游：[lucide-icons/lucide](https://github.com/lucide-icons/lucide)。
- 固定源提交：[`c29c276f16590cf017126671535ad8c792be64d8`](https://github.com/lucide-icons/lucide/tree/c29c276f16590cf017126671535ad8c792be64d8)，通过官方 Git `refs/heads/main` 核验后固定；不随主分支自动更新。
- 来源目录：[`icons/`](https://github.com/lucide-icons/lucide/tree/c29c276f16590cf017126671535ad8c792be64d8/icons)。仅复制下表选中的原始 SVG，无整套应用代码、包安装、外部 CDN 或运行时图标库。
- 许可：ISC；部分 Feather 派生图标附带 MIT。完整上游许可原样保存于 [vendor/lucide/LICENSE](vendor/lucide/LICENSE)，内联复用时也须随原型保留该许可。
- 本地目录：[vendor/lucide/](vendor/lucide/)。SVG 为 24 × 24 viewBox、`currentColor`、2px stroke 的上游原文件；消费处可用 CSS 统一显示尺寸。
- `panels-top-left.svg` 与 `columns-2.svg` 均已确认存在，分别提供标签/组合布局与双列布局的图形，不使用未经确认的别名。
- 下载地址模板：`https://raw.githubusercontent.com/lucide-icons/lucide/c29c276f16590cf017126671535ad8c792be64d8/icons/<name>.svg`；LICENSE 位于同一提交根目录。

以下 SHA-256 用于核验原始文件完整性：

| 文件 | SHA-256 |
| --- | --- |
| `LICENSE` | `b495047bd93a9b06913511076f504daba17d5bbeb3e0650f3bb53a4220329c57` |
| `panel-left.svg` | `029f67b9e3eeb7ddf7c7c499b174c50388725e8ea50d4ea59ed7dbaf8d61cb82` |
| `panels-top-left.svg` | `321a2a5500f2b814a2e62eb73c4b01dc65c7334fe2e6f7d77517239383e26bb1` |
| `columns-2.svg` | `bddf3348a9c82d111a060d118299c90755b1ae8411bd16ea1d5ddb83c5f98a27` |
| `refresh-cw.svg` | `2e10dd403c85a24f163d59fc6151aa21147fe9402e1305dfc8979208caee8944` |
| `folder-open.svg` | `ee57452b40e71df310214091dd9da1941a397c83197b8ff8d7ae66dd4242578b` |
| `tag.svg` | `85e11c07b29f5b67410e0f14c84799d9406320cd4575b7c8322f31910e0582cc` |
| `bell.svg` | `394889e9631fe3a9a63be9a479a95b451b708e432d895978d21d9130b5ee5dbe` |
| `ellipsis.svg` | `4f495cc72013ffdfec677f03b33a150f7b4dd741979283fd6853a09024bca112` |
| `x.svg` | `4a9cdab38fbb96162e7dace28e33f4ca0e49d8963a6162abc3d4691b7d675117` |
| `file-text.svg` | `52ca55846c202335fb870c8aa23e9345630ec10489303756d62e750f7109605c` |
| `terminal.svg` | `4f9b6488b237757d5cb615ccd07502fa99774826839e2a99017784bdb2596f1a` |
| `activity.svg` | `050fbcda05e13c2051cf857683645e19c6b180861ef4d0cc28a6f09ba1ea1666` |
| `settings-2.svg` | `06d06c191bd7eb28afaf9d40acb5c49ef69448fdeda91801d9823d7c440a4e10` |
| `chevron-right.svg` | `2758143d7b2434e4aa7307dfd34405c87909ff4052f21b5f3f40d45224b4f19b` |
| `chevron-down.svg` | `66ea878e72ed3488bb3b464c39dfdccee8d1f78e560dccea40e5e12da0e87e87` |
| `plus.svg` | `7f6af73bf1ff6c4bca3f18351c8d1bdec6749c0c2530c4de5da85d520c21df17` |
| `monitor.svg` | `d1a443233345724859de8e4fb48968ba91e885e12ddbd710701548bd91b39428` |

## 已有终端组件与字体

继续复用仓库现有资源；本轮未额外复制其源代码、字体文件或主题集合，也未升级版本。

- **xterm.js、Fit addon、WebGL addon**：现有资源位于 `public/vendor/xterm/`，各自完整许可为 `LICENSE.xterm`、`LICENSE.addon-fit`、`LICENSE.addon-webgl`（MIT）。[官方项目](https://github.com/xtermjs/xterm.js)、[官方终端选项](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)。现有接入位于 `public/js/terminal.js`。
- **Maple Mono 派生本地字体**：现有 `public/fonts/TmuxPanelMono-Regular.woff2`、`TmuxPanelMono-Bold.woff2` 由 `public/css/style.css` 以 `Tmux Panel Mono` 声明；沿用现有 `public/fonts/OFL-MapleMono.txt`。Maple Mono 上游采用 SIL OFL-1.1，[官方项目](https://github.com/subframe7536/maple-font)、[官方许可](https://github.com/subframe7536/maple-font/blob/v7/OFL.txt)。本轮未重新生成或替换这些字体。
- **主题**：继续使用 `public/js/theme.js` 已有的终端主题数据；未额外引入开源主题仓库。界面新材质与终端 ANSI 语义色分别处理。
