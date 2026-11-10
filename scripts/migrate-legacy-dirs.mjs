#!/usr/bin/env node
// Moves the tmux-web-panel directories to anymux (lib/legacy-names.js). The
// panel does this itself when it starts, except on Windows, where
// scripts/install-service.ps1 runs this after stopping the old tasks.
// Prints what moved, and what had to stay, as JSON.
import { migrateLegacyDirs } from '../lib/legacy-names.js';

const results = migrateLegacyDirs({ windows: true, warn: (message) => process.stderr.write(message + '\n') });
process.stdout.write(JSON.stringify(results) + '\n');
