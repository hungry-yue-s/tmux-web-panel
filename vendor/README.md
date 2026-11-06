# Vendored 内核

面板的插件内核是 [Cordis](https://github.com/cordiverse/cordis)，以发布版的形式放在这里，不从 npm 安装。服务端经 `package.json` 的 `file:` 依赖加载，浏览器经页面的 import map 加载同一份文件，两边跑的是同一个内核。

| 目录 | 包 | 版本 | 来源 | npm integrity |
|---|---|---|---|---|
| `cordis/` | `cordis` | 4.0.0-rc.12 | npm 发布版 `lib/`；上游 tag `v4.0.0-rc.12` | `sha512-/ZtRivYxr5sffTULPewHuX5kEy5sWi8oADHSpnt0KjAd8uKRIj+kv4fh3lxtutIfVlgwJVFVXWOQp/gYa+kIOQ==` |
| `cosmokit/` | `cosmokit` | 1.8.1 | npm 发布版 `lib/index.mjs` | `sha512-PDBv4l90xZKrUsZ0vtoycgZpO/j4iFsqJXrAxsyBDsnQRI7ZMJXIjgDJsKNjd5L8jnVnnlrDCdhkFbTncgCVjQ==` |
| `plugin-timer/` | `@cordisjs/plugin-timer` | 1.1.4 | npm 发布版 `lib/` | `sha512-hxm4MmT0hrNzue05EE30We2WYVTTR6g2Nj5kYDu4EWzM9B7JgrUQg8qfUvG03rzB+59uJJywm8u/9OeJXhYIcg==` |

三者都是 MIT 协议，许可证原文在各自目录的 `LICENSE`（Cordis 的发布包不带许可证文件，取自上游仓库根目录，timer 同属该仓库）。

## 为什么放发布版而不是 TypeScript 源码

上游源码用了 `const enum`、`namespace` 和构造参数属性，Node 的类型剥离跑不了，需要构建。面板不设构建步骤：改了文件刷新就生效，部署和远程安装 Node 时也不用多跑一步。发布版是未压缩的单文件 ESM，可以直接阅读和修改。

## 规则

- `package.json` 只保留运行需要的字段，**不写 `dependencies` / `peerDependencies`**：npm 会为 `file:` 包另装一份依赖，内核就会出现两份 cosmokit 或 cordis。它们之间的引用（cordis → cosmokit，timer → cordis）统一由根目录 `package.json` 的 `file:` 依赖解析到这里。
- **改动 vendor 文件就是打补丁**：在下面的“补丁”一节逐条记录改了哪个文件、为什么、上游是否已修。没有记录的改动视为错误。
- 升级时整目录替换为新的发布版，更新上表的版本和 integrity，再按“补丁”一节重新检查每个补丁是否仍需要。
- 上游 API 仍在 rc 阶段，升级前先跑全部测试。

## 补丁

1. `cosmokit/lib/index.mjs`：删掉末尾的 `//# sourceMappingURL=index.mjs.map`，不 vendor 这个 `.map`。它指向发布包里没有的 `../src/*.ts`，留着只会让测试和浏览器开发工具每次报找不到源码。上游未改，升级时照做。
