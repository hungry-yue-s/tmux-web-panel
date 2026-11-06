import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const ARGS = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '', '--disable-builtin-skills', '--permission-mode', 'dont_ask'];

function unavailable(reason, installed = true) {
  return { status: 'unavailable', installed, source: 'qoder-cli', reason };
}

function quota(response) {
  const usage = response?.usage;
  const bucket = usage?.orgResourcePackage;
  if (!bucket || bucket.unit !== 'credits' || ![bucket.used, bucket.cap, bucket.remaining]
    .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0) || bucket.cap <= 0) {
    return unavailable('当前 Qoder 登录未返回可识别的组织资源包额度');
  }
  const expiry = typeof usage.expiresAt === 'number' ? new Date(usage.expiresAt) : null;
  return { status: 'available', installed: true, source: 'qoder-cli', unit: 'credits',
    usedCredits: bucket.used, totalCredits: bucket.cap, remainingCredits: bucket.remaining,
    usedPercent: bucket.used / bucket.cap * 100, available: bucket.available === true,
    expiresAt: expiry && Number.isFinite(expiry.getTime()) ? expiry.toISOString() : null };
}

// Qoder's documented getUsageInfo control request needs no Agent turn. Never
// submit a user frame; disable project hooks, tools, MCP, and session persistence.
export function createQoderUsageReader(options = {}) {
  const home = options.home || homedir();
  const start = options.spawn || spawn;

  function read(binary) {
    return new Promise((resolve) => {
      let child;
      try { child = start(binary, ARGS, { cwd: home, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (error) { resolve(unavailable('无法启动 Qoder 额度查询', error?.code !== 'ENOENT')); return; }
      let result;
      let settled = false;
      let bytes = 0;
      let killTimer;
      const lines = createInterface({ input: child.stdout });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        lines.close();
        resolve(value);
      };
      const stop = (value) => {
        if (settled || killTimer) return;
        result = value;
        child.stdin.end();
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { child.kill('SIGKILL'); finish(result); }, 1000);
        killTimer.unref?.();
      };
      const timer = setTimeout(() => stop(result || unavailable('Qoder 额度查询超时')), 15_000);
      const send = (id, type, extra = {}) => child.stdin.write(`${JSON.stringify({
        type: 'control_request', request_id: id, request: { type, subtype: type, ...extra },
      })}\n`);
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024 && !settled) stop(unavailable('Qoder 额度响应超出大小限制'));
      });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.on('error', (error) => finish(unavailable('无法启动 Qoder 额度查询', error?.code !== 'ENOENT')));
      child.on('close', () => finish(result || unavailable('Qoder 未返回额度查询结果')));
      lines.on('line', (line) => {
        if (settled || result) return;
        let frame;
        try { frame = JSON.parse(line); } catch { return; }
        if (frame?.type === 'control_request' || frame?.type === 'assistant') {
          stop(unavailable('Qoder 只读额度查询需要额外的交互，已停止')); return;
        }
        if (frame?.type !== 'control_response') return;
        const response = frame.response;
        if (response?.subtype !== 'success') {
          stop(unavailable('Qoder 无法读取当前登录的额度')); return;
        }
        if (response.request_id === 'quota-init') send('quota-read', 'get_usage_info');
        if (response.request_id === 'quota-read') { result = quota(response.response); child.stdin.end(); }
      });
      send('quota-init', 'initialize', { modelPolicyProvider: false, supportsCatalogReadyInitialize: true,
        supportsAvailableModelsUpdate: false, supportsCommandsChanged: false, initializeTimeoutMs: 10_000 });
    });
  }

  return async function readQoderUsage() {
    for (const binary of [join(home, '.local', 'bin', 'qodercli'), 'qodercli']) {
      const result = await read(binary);
      if (result.installed) return result;
    }
    return unavailable('未检测到本机 Qoder CLI', false);
  };
}
