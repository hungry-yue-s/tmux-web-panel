import { Router } from 'express';
import { handle } from '../servers/errors.js';
import { requireSameOrigin } from './servers.js';

export function createManagedResourcesRouter(resources) {
  const router = Router();
  router.use(requireSameOrigin);
  router.get('/', handle(() => resources.status()));
  router.put('/tmux/config', handle((req) => resources.saveConfig(req.body || {})));
  router.post('/tmux/config/link', handle(() => resources.linkConfig(true)));
  router.post('/tmux/config/unlink', handle(() => resources.linkConfig(false)));
  router.post('/tmux/config/apply', handle(() => resources.applyConfig()));
  router.post('/tmux/build', handle(async (_req, res) => { res.status(202); return resources.buildTmux(); }));
  router.post('/tmux/rollback', handle(() => resources.rollbackTmux()));
  router.post('/skills/:name/:target/install', handle((req) => resources.changeSkill(req.params.name, req.params.target, true)));
  router.post('/skills/:name/:target/uninstall', handle((req) => resources.changeSkill(req.params.name, req.params.target, false)));
  return router;
}
