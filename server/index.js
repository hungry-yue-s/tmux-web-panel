// Compatibility entry point. Service units installed before the plugin
// rewrite start `node server/index.js`; this starts the same panel as
// bin/panel.js, with the same options. Re-running scripts/install-service.sh
// (or install-service.ps1) points the unit at bin/panel.js directly.
import '../bin/panel.js';
