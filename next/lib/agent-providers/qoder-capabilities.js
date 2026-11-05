import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createQoderCapabilitiesReader(options = {}) {
  const home = options.home || homedir();
  const run = options.execFile || execFileAsync;
  return async function readQoderCapabilities() {
    const empty = { installed: false, version: null, loggedIn: false, accountType: null,
      userType: null, allowByok: null, customProviderAvailable: false };
    for (const binary of [join(home, '.local', 'bin', 'qodercli'), 'qodercli']) {
      let stdout;
      try {
        ({ stdout } = await run(binary, ['status', '-o', 'json'], { timeout: 5000, maxBuffer: 64 * 1024 }));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        return { ...empty, installed: true, reason: '无法读取 Qoder 账号能力，请在本机检查登录状态' };
      }
      try {
        const status = JSON.parse(String(stdout));
        const loggedIn = status.logged_in === true;
        const accountType = ['user', 'service_account'].includes(status.account_type) ? status.account_type : null;
        const userType = ['individual', 'personal', 'teams', 'enterprise', 'free', 'pro', 'pro_plus', 'premium', 'ultimate']
          .includes(status.user_type) ? status.user_type : null;
        const allowByok = Number.isInteger(status.allow_byok) && status.allow_byok >= 0 ? status.allow_byok : null;
        const customProviderAvailable = loggedIn && accountType === 'user' && allowByok >= 2;
        const version = typeof status.version === 'string' && /^\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.-]+)?$/.test(status.version)
          ? status.version : null;
        const reason = !loggedIn ? 'Qoder 尚未登录'
          : accountType === 'service_account' ? 'Qoder 服务账号不支持本地自定义 Provider'
            : customProviderAvailable ? 'Qoder 账号已开放自定义 Provider，仍需资源包授权对应应用'
              : allowByok === 1 ? 'Qoder 仅开放目录中的 BYOK，尚未开放自定义端点'
                : '当前 Qoder 账号尚未开放自定义 Provider';
        return { installed: true, version, loggedIn, accountType, userType, allowByok, customProviderAvailable, reason };
      } catch {
        return { ...empty, installed: true, reason: 'Qoder 状态返回格式无法识别' };
      }
    }
    return { ...empty, reason: '未检测到本机 Qoder CLI' };
  };
}
