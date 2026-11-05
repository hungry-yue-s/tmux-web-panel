# tmux-web-panel / next

tmux-web-panel rebuilt on the Cordis plugin kernel: every part of the product is a plugin, every registration is reversible, and the whole application is assembled from one profile plus patches.

```sh
npm install
node bin/twp.js                 # the panel; configured by the environment / --config, as before
node bin/twp.js --dump-config   # print the assembled plugin list
npm test
```

Design, conventions and the migration route: [docs/architecture.md](docs/architecture.md). Kernel provenance: [vendor/README.md](vendor/README.md).

Status: the server runs entirely as plugins, with the same features and API as the old `server/`; the pages are still the existing `public/` front end, served by the `ui` plugin. Deployment still starts the old server until the service scripts are switched.
