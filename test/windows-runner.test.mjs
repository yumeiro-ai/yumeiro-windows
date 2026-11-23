import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execSandboxed, languagesFor, normalizeLanguage } from '../runner/sandbox.mjs';
import { killTree, resolveWinEngine, winChildEnv } from '../runner/winproc.mjs';
import { engineCommand, baseChildEnv } from '../runner/runner.mjs';

// 假的子进程：记录怎么被启动的，然后立刻“正常退出”
function fakeSpawn(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter(); child.pid = 4242; child.exitCode = null; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', Buffer.from('ok')); child.emit('close', 0, null); });
    return child;
  };
}
const WIN_ENV = { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE', ADMIN_PASSWORD: 'leak', STORE_ENCRYPTION_KEY: 'leak' };

test('Windows 沙箱：命令用 PowerShell 跑，不经过 sh / ulimit，子进程环境里没有密钥', async () => {
  const calls = [];
  const r = await execSandboxed({ cwd: tmpdir(), command: 'Write-Output hi', env: WIN_ENV, platform: 'win32', spawnFn: fakeSpawn(calls) });
  assert.equal(r.exitCode, 0); assert.equal(r.stdout, 'ok');
  const c = calls[0];
  assert.equal(c.cmd, 'powershell.exe'); assert.deepEqual(c.args.slice(-2), ['-Command', 'Write-Output hi']);
  assert.ok(c.args.includes('-NoProfile') && c.args.includes('-NonInteractive'));
  assert.ok(!JSON.stringify(c).includes('ulimit') && c.cmd !== 'sh');
  assert.equal(c.opts.windowsHide, true); assert.notEqual(c.opts.detached, true);
  assert.equal(c.opts.env.SystemRoot, 'C:\\Windows'); assert.equal(c.opts.env.ADMIN_PASSWORD, undefined); assert.equal(c.opts.env.STORE_ENCRYPTION_KEY, undefined);
  assert.ok(c.opts.env.TEMP && c.opts.env.USERPROFILE);
});

test('Windows 沙箱：语言 → 解释器；bash / sh 的说法都落到 PowerShell；不支持的语言照旧拒绝', async () => {
  assert.equal(normalizeLanguage('bash', 'win32'), 'powershell'); assert.equal(normalizeLanguage('sh', 'win32'), 'powershell');
  assert.equal(normalizeLanguage('py', 'win32'), 'python'); assert.equal(normalizeLanguage('JS', 'win32'), 'node'); assert.equal(normalizeLanguage('ruby', 'win32'), null);
  assert.equal(normalizeLanguage('bash', 'linux'), 'bash'); assert.deepEqual(Object.keys(languagesFor('linux')), ['python', 'node', 'bash']);
  const calls = [];
  await execSandboxed({ cwd: tmpdir(), language: 'python', code: 'print(1)', env: WIN_ENV, platform: 'win32', spawnFn: fakeSpawn(calls) });
  assert.equal(calls[0].cmd, 'python'); assert.match(calls[0].args[0], /main\.py$/);
  await execSandboxed({ cwd: tmpdir(), language: 'bash', code: 'Get-Date', env: WIN_ENV, platform: 'win32', spawnFn: fakeSpawn(calls) });
  assert.equal(calls[1].cmd, 'powershell.exe'); assert.equal(calls[1].args.at(-2), '-File'); assert.match(calls[1].args.at(-1), /main\.ps1$/);
  await assert.rejects(execSandboxed({ cwd: tmpdir(), language: 'ruby', code: '1', env: WIN_ENV, platform: 'win32', spawnFn: fakeSpawn([]) }), /不支持的语言/);
});

test('Windows 沙箱（真机）：PowerShell 命令的退出码、node 代码、超时后整棵进程树被结束', { skip: process.platform !== 'win32' }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ymsbx-'));
  const shell = await execSandboxed({ cwd, command: '[Console]::Error.WriteLine("err"); exit 3', env: process.env });
  assert.equal(shell.exitCode, 3); assert.match(shell.stderr, /err/);
  const node = await execSandboxed({ cwd, language: 'node', code: 'console.log(process.env.ADMIN_PASSWORD || "none")', env: { ...process.env, ADMIN_PASSWORD: 'leak' } });
  assert.equal(node.stdout.trim(), 'none');
  const slow = await execSandboxed({ cwd, command: 'Start-Sleep -Seconds 30', timeoutSec: 1, env: process.env });
  assert.equal(slow.timedOut, true); assert.ok(slow.durationMs < 8000);
});

test('Windows：killTree 用 taskkill /T /F 结束整棵进程树（类 Unix 仍是 child.kill）；已退出的不再动', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return new EventEmitter(); };
  killTree({ pid: 77, exitCode: null, kill: () => assert.fail('不应直接 kill') }, 'SIGTERM', { platform: 'win32', spawn });
  assert.equal(calls[0].cmd, 'taskkill'); assert.deepEqual(calls[0].args, ['/PID', '77', '/T', '/F']);
  let killed = 0; killTree({ pid: 1, exitCode: null, kill: sig => { killed = sig; } }, 'SIGKILL', { platform: 'linux', spawn }); assert.equal(killed, 'SIGKILL');
  killTree({ pid: 78, exitCode: 0, kill: () => assert.fail('已退出') }, 'SIGTERM', { platform: 'win32', spawn }); assert.equal(calls.length, 1);
});

test('Windows 引擎：从 npm 垫片找到包里真正的入口，不经 shell（提示词里的 & | ^ 不会被当成命令）', () => {
  const prefix = 'C:\\Yumeiro\\engines', files = {
    [path.join(prefix, 'claude.cmd')]: '', [path.join(prefix, 'codex.cmd')]: '', [path.join(prefix, 'pi.cmd')]: '',
    [path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json')]: JSON.stringify({ bin: { claude: 'cli.js' } }),
    [path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')]: '',
    [path.join(prefix, 'node_modules', '@openai', 'codex', 'package.json')]: JSON.stringify({ bin: { codex: 'bin/codex.exe' } }),
    [path.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.exe')]: '',
    [path.join(prefix, 'node_modules', '@mariozechner', 'pi-coding-agent', 'package.json')]: JSON.stringify({ bin: '../../../outside.js' }),
    [path.join(prefix, 'outside.js')]: ''
  };
  const deps = { existsSync: p => p in files, readFileSync: p => files[p], execPath: 'C:\\Yumeiro\\node\\node.exe' };
  const env = { Path: `C:\\Windows;${prefix}` };
  assert.deepEqual(resolveWinEngine('claude', env, deps), ['C:\\Yumeiro\\node\\node.exe', path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')]);
  assert.deepEqual(resolveWinEngine('codex', env, deps), [path.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.exe')]);
  assert.equal(resolveWinEngine('pi', env, deps), null, '入口跑到包目录外面就不信');
  assert.equal(resolveWinEngine('claude', { Path: 'C:\\Windows' }, deps), null); assert.equal(resolveWinEngine('nope', env, deps), null);
  // 管理员显式配置了命令时，以配置为准
  assert.deepEqual(engineCommand('claude', { CLAUDE_CMD: 'C:\\tools\\claude.exe --x', ...env }, 'win32'), ['C:\\tools\\claude.exe', '--x']);
  assert.deepEqual(engineCommand('claude', env, 'linux'), ['claude']);
});

test('Windows 引擎环境：用户目录 / 应用数据 / 临时目录都指到引擎自己的目录，宿主机变量不外泄', () => {
  const home = 'C:\\ProgramData\\Yumeiro\\work\\.home\\claude';
  const env = winChildEnv({ ...WIN_ENV, USERPROFILE: 'C:\\Users\\yumeiro-runner', TEMP: 'C:\\Users\\yumeiro-runner\\AppData\\Local\\Temp' }, home);
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) assert.ok(env[key].startsWith(home), key + ' 要在引擎自己的目录下');
  assert.equal(env.SystemRoot, 'C:\\Windows'); assert.equal(env.ADMIN_PASSWORD, undefined);
  const full = baseChildEnv(WIN_ENV, 'C:\\w', 'codex', 'win32');
  assert.equal(full.HOME, path.join('C:\\w', '.home', 'codex')); assert.equal(full.NO_COLOR, '1');
});
