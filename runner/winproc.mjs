// 运行器在 Windows 上需要的几个小工具（纯函数 / 可注入依赖，任何系统上都能测试）。
//  - killTree：结束进程树（Windows 的 child.kill 只杀自己，不杀它启动的子进程）
//  - resolveWinEngine：npm 装的引擎在 Windows 上是 claude.cmd 这种垫片，Node 不能不经 shell 直接启动它（而经过 cmd.exe 会让提示词里的 & | ^ % 变成命令注入）
//    所以读 npm 包的 package.json 找到真正的入口（.js 用 node 跑，.exe 直接跑），完全不经 shell
//  - winChildEnv：Windows 子进程必须带的系统变量，并把用户目录 / 临时目录都指到引擎自己的独立目录里
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function killTree(child, signal = 'SIGTERM', { platform = process.platform, spawn = nodeSpawn } = {}) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined)) return;
  if (platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => { try { child.kill(signal); } catch { /* 已退出 */ } }); return; } catch { /* 退回 kill */ }
  }
  try { child.kill(signal); } catch { /* 已退出 */ }
}

export const ENGINE_PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex', pi: '@mariozechner/pi-coding-agent' };

// 返回 [命令, ...前置参数]；找不到返回 null。deps 可替换（测试用）
export function resolveWinEngine(engine, env = process.env, deps = {}) {
  const exists = deps.existsSync || existsSync, read = deps.readFileSync || readFileSync, node = deps.execPath || process.execPath;
  const pkgName = ENGINE_PACKAGES[engine];
  if (!pkgName) return null;
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  for (const dir of String(env[pathKey] || '').split(';').filter(Boolean)) {
    // npm -g --prefix X 在 Windows 上把垫片放在 X 根目录，包在 X\node_modules\<包名>
    const shim = path.join(dir, engine + '.cmd');
    if (!exists(shim)) continue;
    const pkgDir = path.join(dir, 'node_modules', ...pkgName.split('/'));
    let pkg; try { pkg = JSON.parse(read(path.join(pkgDir, 'package.json'), 'utf8')); } catch { continue; }
    const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.[engine] || Object.values(pkg.bin || {})[0]);
    if (!bin) continue;
    const target = path.resolve(pkgDir, bin);
    if (path.relative(pkgDir, target).startsWith('..')) continue; // 入口必须在包目录里
    if (!exists(target)) continue;
    return /\.(c|m)?js$/i.test(target) ? [node, target] : [target];
  }
  return null;
}

const SYSTEM_KEYS = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];
export const WIN_CHILD_ENV_KEYS = [...SYSTEM_KEYS, 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];
// home：这个引擎的独立目录。用户目录、应用数据、临时目录都放在它下面，引擎不会碰到运行器账号自己的配置
export function winChildEnv(env, home) {
  const out = {};
  for (const key of SYSTEM_KEYS) if (env[key] !== undefined) out[key] = env[key];
  out.USERPROFILE = home;
  out.APPDATA = path.join(home, 'AppData', 'Roaming');
  out.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  out.TEMP = out.TMP = path.join(home, 'tmp');
  return out;
}
