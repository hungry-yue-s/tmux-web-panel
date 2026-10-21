import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createEnterpriseRuntime } from '../../server/agent-providers/enterprise-runtime.js';

const roots = [];
const runtimes = [];
const MODEL = { id: 'mode-test', app: 'codex', appCode: 'Codex', name: 'Auto',
  baseUrl: 'https://token-hub.alibaba-inc.com/portal/llm-api/openai/v1' };
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'enterprise-runtime-'));
  roots.push(home);
  await mkdir(join(home, '.cc-switch'));
  const database = join(home, '.cc-switch/cc-switch.db');
  execFileSync('sqlite3', [database, 'create table providers(id text,app_type text,name text,settings_config text,category text,created_at integer,meta text,is_current integer,in_failover_queue integer,primary key(id,app_type));']);
  const client = { getCatalog: vi.fn(async () => ({ models: [{ ...MODEL }] })),
    checkQuota: vi.fn(async () => ({ available: true })), gatewayHeaders: vi.fn(async () => ({ 'X-Switch-Token': 'upstream-only', 'X-CC-Model-ID': MODEL.id, 'X-App-Tag': 'Codex' })) };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'r1', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 3, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } }));
  const runtime = createEnterpriseRuntime({ home, port: 0, client, fetchImpl });
  runtimes.push(runtime);
  const base = await runtime.start();
  const config = JSON.parse(await readFile(join(home, '.config/tmux-web-panel/enterprise-relay.json'), 'utf8'));
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.key, ...headers }, body: JSON.stringify(body) });
  return { home, database, client, fetchImpl, runtime, base, config, post };
}

describe('embedded enterprise runtime', () => {
  it('binds only loopback, protects local routes and rejects browser origins and unauthorized models', async () => {
    const { post, base, fetchImpl, runtime, config } = await fixture();
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(config.port).toBeGreaterThan(0);
    expect((await post('/codex/v1/responses', { model: MODEL.id }, { 'x-api-key': '' })).status).toBe(401);
    expect((await post('/codex/v1/responses', { model: MODEL.id }, { origin: 'https://example.test' })).status).toBe(401);
    expect((await post('/unknown', { model: MODEL.id })).status).toBe(404);
    expect((await post('/codex/v1/responses', { model: 'not-issued' })).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runtime.status().activeRequests).toBe(0);
  });

  it('forwards Codex and converts Claude requests without passing the local key upstream', async () => {
    const { post, fetchImpl, config } = await fixture();
    expect((await post('/codex/v1/responses', { model: MODEL.id, input: 'hello' })).status).toBe(200);
    const response = await post('/claude/v1/messages', { model: MODEL.id, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'OK' }] });
    const [url, options] = fetchImpl.mock.calls[1];
    expect(url).toBe(MODEL.baseUrl + '/responses');
    expect(options.headers).toMatchObject({ 'X-Switch-Token': 'upstream-only', 'X-App-Tag': 'Codex' });
    expect(JSON.stringify(options)).not.toContain(config.key);
    expect(JSON.parse(options.body).input).toBeDefined();
  });

  it('registers inactive compatible providers and never touches official login or live settings', async () => {
    const { runtime, database, home, config, client } = await fixture();
    const codex = await runtime.prepare('codex', MODEL.id);
    const claude = await runtime.prepare('claude', MODEL.id);
    expect(codex.requiresNativeProxy).toBe(false);
    expect(claude.requiresNativeProxy).toBe(false);
    const rows = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', database, 'select app_type,is_current,settings_config,meta from providers'], { encoding: 'utf8' }));
    expect(rows.map((row) => row.is_current)).toEqual([0, 0]);
    expect(JSON.parse(rows.find((row) => row.app_type === 'claude').meta).apiFormat).toBe('anthropic');
    expect(JSON.parse(rows.find((row) => row.app_type === 'claude').settings_config).env.ANTHROPIC_AUTH_TOKEN).toBe(config.key);
    expect((await stat(join(home, '.config/tmux-web-panel/enterprise-relay.json'))).mode & 0o777).toBe(0o600);
    await expect(stat(join(home, '.codex/auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(runtime.prepare('qoder', MODEL.id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    client.checkQuota.mockResolvedValue({ available: false });
    await expect(runtime.prepare('codex', MODEL.id)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('streams Claude SSE and hides upstream error bodies and credentials', async () => {
    const { post, fetchImpl } = await fixture();
    fetchImpl.mockResolvedValueOnce(new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":1}}}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const response = await post('/claude/v1/messages', { model: MODEL.id, stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] });
    const text = await response.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: message_stop');
    expect(text).toContain('OK');
    fetchImpl.mockResolvedValueOnce(new Response('upstream-only private diagnosis', { status: 401 }));
    const failed = await post('/codex/v1/responses', { model: MODEL.id, input: 'hello' });
    expect(failed.status).toBe(401);
    expect(await failed.text()).not.toContain('upstream-only');
    fetchImpl.mockResolvedValueOnce(new Response('event: error\ndata: {"type":"error","message":"Bearer upstream-only"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const failedStream = await post('/claude/v1/messages', { model: MODEL.id, stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] });
    const errorText = await failedStream.text();
    expect(errorText).toContain('event: error');
    expect(errorText).not.toContain('upstream-only');
  });

  it('refuses to replace a different configuration in a currently active owned row', async () => {
    const { runtime, database } = await fixture();
    const provider = await runtime.prepare('claude', MODEL.id);
    execFileSync('sqlite3', [database, `update providers set is_current=1,settings_config='{}' where id='${provider.providerId}'`]);
    await expect(runtime.prepare('claude', MODEL.id)).rejects.toMatchObject({ code: 'PROVIDER_CHANGED' });
    const row = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', database, 'select settings_config,is_current from providers'], { encoding: 'utf8' }))[0];
    expect(row).toEqual({ settings_config: '{}', is_current: 1 });
  });
});
