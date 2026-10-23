import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { runInNewContext } from 'node:vm';
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
  it('pins an explicitly selected displayed model when the resumed agent still uses a different provider', async () => {
    const { manager, profile } = await fixture();
    const channel = join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/channel');
    await mkdir(channel, { recursive: true });
    const switchSource = `function select(provider, model, state, deps) {
  if (provider === state.provider && model === state.model) return true;
  deps.selection.current = { provider, model };
  return true;
}`;
    const bindingSource = `function bind(deps) {
  const selected = deps.modelSelection.selection.current;
  return selected;
}`;
    await writeFile(join(channel, 'model-switch.js'), switchSource);
    await writeFile(join(channel, 'binding-events.js'), bindingSource);
    const state = { provider: 'tmux-enterprise', model: group.model };
    const deps = { selection: { current: undefined } };
    const select = (text) => runInNewContext(text + '\nselect');
    expect(select(switchSource)(state.provider, state.model, state, deps)).toBe(true);
    expect(deps.selection.current).toBeUndefined();
    expect(await manager.activate(group)).toMatchObject({ runtimeRepairs: ['model-switch', 'bound-route'] });
    const patchedSwitch = await readFile(join(channel, 'model-switch.js'), 'utf8');
    select(patchedSwitch)(state.provider, state.model, state, deps);
    expect(deps.selection.current).toEqual({ provider: 'tmux-enterprise', model: group.model });
    const existingPin = deps.selection.current;
    select(patchedSwitch)(state.provider, state.model, state, deps);
    expect(deps.selection.current).toBe(existingPin);
    const bind = runInNewContext(await readFile(join(channel, 'binding-events.js'), 'utf8') + '\nbind');
    const resumed = { modelSelection: { selection: { current: undefined } }, binding: { agent: { options: { provider: 'glm', model: 'glm-test' } } } };
    expect(bind(resumed)).toEqual({ provider: 'glm', model: 'glm-test' });
    resumed.modelSelection.selection.current = existingPin;
    expect(bind(resumed)).toEqual(existingPin);
    expect(await manager.activate(group)).toMatchObject({ runtimeRepairs: [] });
  });

  it('repairs stale capacity display after a model switch, preserves projection fallback and applies once', async () => {
    const { manager, profile } = await fixture();
    const file = join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/context-occupancy.js');
    await mkdir(dirname(file), { recursive: true });
    const source = `export function resolveContextOccupancy(projected, sample, requestWindow) {
  const contextWindow = projected?.contextWindow ?? requestWindow;
  return { usedTokens: projected?.pressureTokens ?? sample?.input, contextWindow };
}\n`;
    await writeFile(file, source);
    const display = (text, currentWindow) => runInNewContext(text.replace('export ', '')
      + '\nresolveContextOccupancy({pressureTokens: 400000, contextWindow: 1000000}, undefined, window)', { window: currentWindow });
    expect(display(source, 800000).contextWindow).toBe(1000000);
    expect(await manager.activate(group)).toMatchObject({ contextWindowRepaired: true, backups: 3 });
    const patched = await readFile(file, 'utf8');
    expect(display(patched, 800000)).toEqual({ usedTokens: 400000, contextWindow: 800000 });
    expect(display(patched, undefined).contextWindow).toBe(1000000);
    expect(await manager.activate(group)).toMatchObject({ contextWindowRepaired: false });
    expect(await readFile(file, 'utf8')).toBe(patched);
    const newerSource = source.replace('projected?.contextWindow ?? requestWindow', 'requestWindow ?? projected?.contextWindow ?? 262144');
    await writeFile(file, newerSource);
    expect(await manager.activate(group)).toMatchObject({ contextWindowRepaired: false });
    expect(await readFile(file, 'utf8')).toBe(newerSource);
  });

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
    const { manager, profile, patchPath, credentialsPath, modelPath } = await fixture();
    const contextPath = join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/context-occupancy.js');
    const contextSource = 'export function resolveContextOccupancy(projected, sample, requestWindow) { const contextWindow = projected?.contextWindow ?? requestWindow; return contextWindow; }';
    await mkdir(dirname(contextPath), { recursive: true });
    await writeFile(contextPath, contextSource);
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
    expect(await readFile(contextPath, 'utf8')).toBe(contextSource);
    await expect(stat(join(dirname(modelPath), 'kernel.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${credentialsPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
