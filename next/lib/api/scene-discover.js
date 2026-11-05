import { Router } from 'express';
import { scanTerminal } from '../scene-discover/terminal.js';
import { scanClaude } from '../scene-discover/claude.js';
import { scanVim } from '../scene-discover/vim.js';
import { scanLazygit } from '../scene-discover/lazygit.js';

const EMPTY = {
  terminal: { topCommands: [], topFullCommands: [], aliases: [] },
  claude:   { slashCommands: [], skills: [] },
  vim:      { leaderKey: null, customKeymaps: [] },
  lazygit:  { hasCustomConfig: false, customCommands: [] },
};

async function safeCall(fn) {
  try { return await fn(); } catch (_e) { return null; }
}

export function createSceneDiscoverRouter(scanners) {
  const t = scanners?.terminal || scanTerminal;
  const c = scanners?.claude   || scanClaude;
  const v = scanners?.vim      || scanVim;
  const l = scanners?.lazygit  || scanLazygit;

  const router = Router();

  router.get('/', async (_req, res) => {
    const [terminal, claude, vim, lazygit] = await Promise.all([
      safeCall(() => t()),
      safeCall(() => c()),
      safeCall(() => v()),
      safeCall(() => l()),
    ]);
    res.json({
      terminal: terminal || EMPTY.terminal,
      claude:   claude   || EMPTY.claude,
      vim:      vim      || EMPTY.vim,
      lazygit:  lazygit  || EMPTY.lazygit,
      timestamp: Date.now(),
    });
  });

  return router;
}
