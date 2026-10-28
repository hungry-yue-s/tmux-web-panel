import { Router } from 'express';
import { handle } from '../servers/errors.js';
import { requireSameOrigin } from './same-origin.js';

// The tmux.conf fragment is managed per machine from the session page now
// (/api/session-protection), so it is reachable on remote servers too.
export function createManagedResourcesRouter(resources) {
  const router = Router();
  router.use(requireSameOrigin);
  router.get('/', handle(() => resources.status()));
  router.post('/tmux/build', handle(async (_req, res) => { res.status(202); return resources.buildTmux(); }));
  router.post('/tmux/rollback', handle(() => resources.rollbackTmux()));
  router.post('/skills/:name/:target/install', handle((req) => resources.changeSkill(req.params.name, req.params.target, true)));
  router.post('/skills/:name/:target/uninstall', handle((req) => resources.changeSkill(req.params.name, req.params.target, false)));
  return router;
}
