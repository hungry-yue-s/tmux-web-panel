# Blocks：终端旁边的内置工具

参考 [Tern](https://stencil.so/tern) 的 “blocks” 概念：在终端旁边直接用 Git、数据库、Notebook、看板、编辑器和浏览器，不必另开程序。所有 block 都是 Node 上的接口（`/api/git`、`/api/sqlite`、`/api/notebook`、`/api/open`），所以远程服务器经 `/n/:serverId` 自动拥有同样的功能。

| Block | 入口 | 快捷键 | 说明 |
| --- | --- | --- | --- |
| Shell | 命令面板 | Alt+Shift+T | 在当前会话新建窗口 |
| Git | 命令面板 / 文件预览“更多” | Alt+Shift+G | 状态、差异、按块/按行暂存与取消暂存、丢弃、提交（含 amend）、撤销上次提交、生成提交说明、提交图 |
| 文件 | 命令面板 | Alt+Shift+O | 打开当前 pane 的目录 |
| 看板 | 命令面板 / 打开 `TODO.md` | Alt+Shift+K | `## 标题` 为列，顶层列表项为卡片，拖动排序后写回文件 |
| 浏览器 | 命令面板 / `twp open <url>` | Alt+Shift+B | 右侧 iframe 浏览本地开发页面 |
| 任务管理器 | 命令面板 | Alt+Shift+M | 跳到当前服务器的性能页（进程、CPU、内存） |
| 切换主机 | 命令面板 | Alt+Shift+H | 打开命令面板并筛选服务器 |
| 主题 | 命令面板 | Alt+Shift+Y | ↑↓ 实时预览，Enter 应用，Esc 恢复原主题 |

快捷键在捕获阶段处理，终端获得焦点时也生效（不会发给 shell）。

## 文件预览里的 block

- **编辑**：“更多 → 编辑”。Markdown 用 Toast UI Editor 的所见即所得模式（可切换 Markdown 源码），其它文本用纯文本编辑器；Ctrl/⌘+S 保存。保存走 `PUT /api/files/content`，只有文件的 mtime 和大小与加载时一致才写入，否则提示冲突（409），不会覆盖别人的修改。编辑期间暂停自动刷新。
- **Git 行标记**：代码预览的行号栏标出相对 HEAD 新增（绿）、修改（蓝）、删除位置（红）。
- **SQLite**：`.sqlite` `.sqlite3` `.db` `.db3` 打开为数据库浏览器：表/视图列表、分页、按列排序、双击单元格编辑、新增/删除行、SQL 查询（默认只读，勾选“允许修改数据”才以读写方式打开）。基于 Node 自带的 `node:sqlite`，无需安装。
- **Notebook**：`.ipynb` 渲染 Markdown、代码与输出（文本、错误、图片；HTML/SVG 输出放在无权限的 sandbox iframe 里）。“运行全部”在服务器上执行 `jupyter nbconvert --execute --inplace`，需要该机器装有 Jupyter。
- **补丁**：`.diff` `.patch` 用 diff2html 渲染，可切换逐行/并排。
- **看板视图**：任意 Markdown 都可从“更多 → 看板视图”进入；`TODO.md`、`todo.md`、`kanban.md`、`board.md` 默认以看板打开，“返回文档”回到普通渲染。没有 `##` 标题时按勾选状态分为“待办/完成”两列。拖到名为 Done/完成 的列会勾选任务，拖出则取消勾选。看板写回时会规范化空行，第一个 `##` 之前的内容原样保留。

Git 的“生成说明”优先调用该机器上的 `claude -p`，找不到时按改动文件生成一行摘要。

## `twp` 命令行

`bin/twp`（Node 脚本 `bin/twp.mjs`）在 pane 里控制面板和 tmux，相当于 Tern 的 `tern open/split/run/capture/events`。可以链接到 PATH：

```sh
ln -s "$PWD/bin/twp" ~/.local/bin/twp
```

| 命令 | 作用 |
| --- | --- |
| `twp open [--preview] <file\|url>` | 在所有正在看这台机器的浏览器里预览文件，或在浏览器 block 打开网址 |
| `twp split [-h] [-c dir] [-t pane] [cmd...]` | 拆分当前 pane，输出新 pane id |
| `twp run [-t pane] <cmd...>` | 向 pane 输入一条命令并回车 |
| `twp capture [-t pane] [-n lines]` | 输出 pane 文本，可含滚动历史 |
| `twp events [--filter a,b]` | 以 JSON Lines 输出 `pane_spawned`、`pane_closed`、`layout_changed`、`window_added`、`window_closed`、`window_renamed`、`pane_focused` 等事件 |

`open` 读取配对文件 `~/.config/tmux-web-panel/node.json` 中的 node token 调用本机 `/api/open`（HTTPS 时按配对文件里的证书指纹固定），服务端经 `/ws/status` 推送给浏览器；只有可见的标签页会响应。其余命令直接调用 tmux；`events` 是一个只读、忽略尺寸、不接收输出的 tmux control-mode 客户端（`tmux -C attach -f read-only,ignore-size,no-output`）。

## 没有照搬的部分

- **屏幕共享 / 远程桌面**：需要 VNC 等额外服务，不在面板职责内。
- **Tern Surface Protocol、原生 GPU 渲染、提示符样式**：属于 Tern 自己的渲染器与 shell 主题；本项目的终端由 xterm.js 渲染，提示符交给 starship / oh-my-posh 等现成工具。
- **任务管理器的 GPU 列**：性能页目前没有 GPU 采样。
