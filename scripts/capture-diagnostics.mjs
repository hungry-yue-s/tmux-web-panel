// Local operator tool: credentials stay in memory, remote APIs use the Hub relay.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import https from 'node:https';
import { appDir } from '../lib/legacy-names.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const [action, outputDir, target] = process.argv.slice(2);
const validTarget = (value) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value || '') && value !== 'local';
if (!['start', 'status', 'stop', 'download'].includes(action) || !outputDir
    || (action === 'start' && !validTarget(target)) || (target !== undefined && !validTarget(target))) {
  console.error('Usage: node scripts/capture-diagnostics.mjs start OUTPUT_DIR REMOTE_SERVER_ID');
  console.error('       node scripts/capture-diagnostics.mjs status|stop|download OUTPUT_DIR [REMOTE_SERVER_ID]');
  process.exit(1);
}
const configDir = appDir('config');
const ca = await fs.readFile(path.join(configDir, 'ca/ca.crt'));
const tokens = JSON.parse(await fs.readFile(path.join(configDir, 'tokens.json'), 'utf8'));
const token = tokens.find(([, entry]) => entry.expiresAt == null || entry.expiresAt > Date.now())?.[0];
if (!token) throw new Error('No active local login; sign in to the panel first');
const manifestPath = path.join(path.resolve(outputDir), 'capture-session.json');

function request(url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(new URL(url, 'https://127.0.0.1:7681'), {
      method: data ? 'POST' : 'GET', ca,
      headers: { Authorization: 'Bearer ' + token, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
    }, resolve);
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Diagnostic request timeout')));
    req.end(data);
  });
}
async function api(url, body) {
  const response = await request(url, body);
  const chunks = []; let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) { response.destroy(); throw new Error('Diagnostic response limit'); }
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid diagnostic response'); }
  if (response.statusCode !== 200 || !result.success) throw new Error('Diagnostic API failed: HTTP ' + response.statusCode);
  return result.data;
}

await fs.mkdir(path.resolve(outputDir), { recursive: true, mode: 0o700 });
let manifest;
if (action === 'start') {
  // Never overwrite the ids needed to retrieve an earlier run.
  const handle = await fs.open(manifestPath, 'wx', 0o600);
  manifest = { groupId: randomUUID(), target, startedByOperatorAt: new Date().toISOString(), captures: [] };
  try {
    for (const [role, prefix, targetServerId] of [['node', '/n/' + target, 'local'], ['hub', '', target]]) {
      const sentAt = new Date().toISOString();
      const status = await api(prefix + '/api/diagnostics/start', { groupId: manifest.groupId, targetServerId, durationMs: 7200000 });
      manifest.captures.push({ role, prefix, sentAt, receivedAt: new Date().toISOString(), ...status });
      if (!status.active) throw new Error('Capture did not start');
    }
  } catch (error) {
    // A partial start remains inspectable and can be stopped with this manifest.
    manifest.partial = true;
    throw error;
  } finally {
    await handle.writeFile(JSON.stringify(manifest, null, 2) + '\n');
    await handle.close();
  }
} else {
  manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!validTarget(manifest.target) || !Array.isArray(manifest.captures)) throw new Error('Invalid capture manifest');
  if (target !== undefined && target !== manifest.target) throw new Error('Server does not match the saved capture');
  for (const capture of manifest.captures) {
    if (!['node', 'hub'].includes(capture.role) || !/^[0-9a-f-]{36}$/.test(capture.id) || !['', '/n/' + manifest.target].includes(capture.prefix)) throw new Error('Invalid capture manifest');
    if (action === 'download') {
      const response = await request(capture.prefix + '/api/diagnostics/captures/' + capture.id);
      if (response.statusCode !== 200) { response.resume(); throw new Error('Capture download failed: HTTP ' + response.statusCode); }
      const file = path.join(path.resolve(outputDir), capture.role + '-' + capture.id + '-' + Date.now() + '.jsonl');
      await pipeline(response, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      console.log(JSON.stringify({ role: capture.role, file }));
    } else {
      const status = await api(capture.prefix + '/api/diagnostics/status');
      if (status.id !== capture.id) throw new Error('Capture changed; refusing to stop a different session');
      const result = action === 'stop' ? await api(capture.prefix + '/api/diagnostics/stop', {}) : status;
      console.log(JSON.stringify({ role: capture.role, ...result }));
    }
  }
}
if (action === 'start') console.log(JSON.stringify({ manifestPath, ...manifest }));
