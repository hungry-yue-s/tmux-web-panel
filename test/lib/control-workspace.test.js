import { describe, it, expect } from 'vitest';
import { WorkspaceService } from '../../lib/workspace/service.js';
it('invalidates a pending workspace read after an external workbench mutation and publishes the new revision', async () => {
  let release, reads = 0;
  const revisions = [];
  const workspace = new WorkspaceService({ tmux: {}, onChange: revision => revisions.push(revision) });
  workspace.provider.readSnapshot = () => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ instanceId: '1:2', sessions: [] });
  const before = workspace.getWorkspace();
  workspace.invalidate();
  const after = workspace.getWorkspace();
  expect(after).not.toBe(before);
  expect((await after).revision).toBe(1);
  expect(revisions).toEqual([1]);
  release({ instanceId: '1:2', sessions: [{ id: '$old', windows: [], windowCount: 0 }] });
  expect((await before).sessions).toEqual([]);
});
