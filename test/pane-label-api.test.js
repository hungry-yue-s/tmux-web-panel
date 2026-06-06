import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../server/tmux.js', () => ({
  validatePaneId: (id) => /^%\d+$/.test(id),
  setPaneLabel: vi.fn(() => Promise.resolve()),
}));
const tmux = await import('../server/tmux.js');
const { flatPanesRouter } = await import('../server/api/panes.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/panes', flatPanesRouter);
  return app;
}

// pane ids contain '%', which the client always sends via encodeURIComponent
const pane = (id) => '/api/panes/' + encodeURIComponent(id) + '/label';

describe('PUT /api/panes/:paneId/label', () => {
  beforeEach(() => tmux.setPaneLabel.mockClear());

  it('sets a label and echoes it back', async () => {
    const res = await request(makeApp()).put(pane('%3')).send({ label: '日志' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { paneId: '%3', label: '日志' }, error: null });
    expect(tmux.setPaneLabel).toHaveBeenCalledWith('%3', '日志');
  });

  it('treats missing label as clear (empty string)', async () => {
    const res = await request(makeApp()).put(pane('%3')).send({});
    expect(res.status).toBe(200);
    expect(tmux.setPaneLabel).toHaveBeenCalledWith('%3', '');
  });

  it('rejects invalid pane id with 400', async () => {
    const res = await request(makeApp()).put(pane('bad')).send({ label: 'x' });
    expect(res.status).toBe(400);
    expect(tmux.setPaneLabel).not.toHaveBeenCalled();
  });

  it('rejects non-string label with 400', async () => {
    const res = await request(makeApp()).put(pane('%3')).send({ label: 123 });
    expect(res.status).toBe(400);
    expect(tmux.setPaneLabel).not.toHaveBeenCalled();
  });
});
