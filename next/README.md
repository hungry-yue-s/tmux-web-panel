# tmux-web-panel / next

基于 Cordis 插件内核从零重写的 tmux-web-panel：服务端和浏览器端跑同一个内核，每个功能都是可以热插拔的插件，整个应用由一份 profile 加补丁组装。

```sh
npm install
node bin/twp.js                 # http://127.0.0.1:7690
node bin/twp.js --dump-config   # 看组装结果
npm test
```

设计与约定：[docs/architecture.md](docs/architecture.md)。内核来源：[vendor/README.md](vendor/README.md)。

生产服务仍然是仓库根目录的旧实现；`next/` 目前只读工作区，还没有认证，默认只监听本机。
