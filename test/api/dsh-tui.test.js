import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { createDshTuiManager } from '../../server/agent-providers/dsh-tui.js';
import { ManagedResources } from '../../server/managed-resources.js';

const roots = [];
const group = { model: 'mode-auto', models: [{ id: 'mode-auto', name: 'Auto', contextWindow: 128000 }],
  base: 'http://127.0.0.1:15723', key: 'local-relay-key' };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-manager-'));
  roots.push(home);
  const profile = join(home, '.dsh/profiles/dsh-tui');
  const patchPath = join(profile, 'cordis.patch.yml');
  const credentialsPath = join(home, '.dsh/.credentials.yaml');
  const modelPath = join(home, '.dsh-tui/model.json');
  await mkdir(join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui'), { recursive: true });
  await writeFile(join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui/package.json'), '{"version":"0.16.1"}');
  await writeFile(patchPath, `# keep my setup
- id: llm-pi-ai
  config:
    providers:
      glm:
        apiKeyEnv: GLM_KEY
        models: [{ id: glm-test }]
- id: agent-default-model
  config: { provider: glm, model: glm-test }
- id: dsh-tui
  config:
    fullscreen: true
    persona: !!js 'throw new Error("must never execute")'
`);
  await writeFile(credentialsPath, '# original key\nversion: 1\nrefs:\n  GLM_KEY: private-glm-key\nrecords: {}\n', { mode: 0o600 });
  return { home, profile, patchPath, credentialsPath, modelPath, manager: createDshTuiManager({ home }) };
}

describe('native dsh-tui maintenance', () => {
  it('reads version and native profiles without returning credentials or evaluating YAML', async () => {
    const { manager } = await fixture();
    const status = await manager.status();
    expect(status).toMatchObject({ installed: true, version: '0.16.1', provider: 'glm', model: 'glm-test' });
    expect(status.profiles).toEqual([{ provider: 'glm', model: 'glm-test', name: 'glm-test', providerName: 'glm' }]);
    expect(JSON.stringify(status)).not.toMatch(/private-glm|throw new Error|apiKeyEnv/);
  });

  it('adds a Responses route, preserves native settings/credentials and can switch back to GLM', async () => {
    const { manager, home, patchPath, credentialsPath } = await fixture();
    expect(await manager.activate(group)).toMatchObject({ agent: 'dsh', active: true, backups: 2 });
    const patch = await readFile(patchPath, 'utf8');
    expect(patch).toContain('# keep my setup');
    expect(patch).toContain('!!js');
    expect(patch).toContain('must never execute');
    expect(patch).not.toContain(group.key);
    const doc = parseDocument(patch, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] });
    expect(doc.toJS()[0].config.providers['tmux-enterprise']).toMatchObject({
      api: 'openai-responses', baseURL: group.base + '/codex/v1', transport: 'sse',
      apiKeyEnv: 'TMUX_PANEL_ENTERPRISE_API_KEY', models: [{ id: 'mode-auto', contextWindow: 128000 }],
    });
    const credentials = parseDocument(await readFile(credentialsPath, 'utf8')).toJS();
    expect(credentials.refs).toEqual({ GLM_KEY: 'private-glm-key', TMUX_PANEL_ENTERPRISE_API_KEY: group.key });
    expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    const backups = await readdir(join(home, '.config/tmux-web-panel/backups'));
    expect(backups).toHaveLength(2);
    for (const backup of backups) expect((await stat(join(home, '.config/tmux-web-panel/backups', backup))).mode & 0o777).toBe(0o600);
    expect(await manager.status()).toMatchObject({ backend: 'dsh', enterpriseModelId: group.model });
    await manager.activate({ provider: 'glm', model: 'glm-test' });
    expect(await manager.status()).toMatchObject({ provider: 'glm', model: 'glm-test', enterpriseModelId: null });
    await expect(manager.activate({ provider: 'glm', model: 'unknown' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses malformed YAML and native writer locks without changing files', async () => {
    const { manager, patchPath, credentialsPath, profile } = await fixture();
    const original = await readFile(credentialsPath, 'utf8');
    await writeFile(join(profile, 'package.json.lock'), `${process.pid}\n`);
    await expect(manager.activate(group)).rejects.toMatchObject({ code: 'PROVIDER_CHANGED' });
    await rm(join(profile, 'package.json.lock'));
    await writeFile(patchPath, 'broken: [\n');
    await expect(manager.activate(group)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await readFile(credentialsPath, 'utf8')).toBe(original);
    expect(await manager.status()).toMatchObject({ installed: true, profiles: [], reason: expect.stringContaining('失败') });
  });

  it('restores completed writes if selecting the default model fails', async () => {
    const { manager, patchPath, credentialsPath, modelPath } = await fixture();
    const original = await readFile(patchPath, 'utf8');
    const creds = await readFile(credentialsPath, 'utf8');
    const backupWrite = ManagedResources.prototype.backupWrite;
    vi.spyOn(ManagedResources.prototype, 'backupWrite').mockImplementation(function (path, content) {
      if (path === modelPath) throw new Error('write failed');
      return backupWrite.call(this, path, content);
    });
    await expect(manager.activate(group)).rejects.toThrow('write failed');
    expect(await readFile(patchPath, 'utf8')).toBe(original);
    expect(await readFile(credentialsPath, 'utf8')).toBe(creds);
    await expect(stat(join(dirname(modelPath), 'kernel.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${credentialsPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
