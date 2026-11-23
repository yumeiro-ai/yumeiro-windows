#!/usr/bin/env node
// Windows 服务启动器：计划任务读不到 env 文件，也没有 systemd 的 EnvironmentFile / 日志，所以由它来做：
//   读 yumeiro.env → 设好环境变量 → （可选）先跑一个预备脚本 → 启动目标程序 → 把输出追加到日志文件（超过大小自动轮转）。
// 用法：node run-service.mjs --env <yumeiro.env> --log <日志文件> [--pre <脚本>] [--cwd <目录>] <入口脚本> [参数…]
// 目标程序退出时本进程用同一个退出码退出，计划任务据此自动重启。
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, openSync, closeSync, statSync, renameSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 解析 KEY=VALUE：忽略空行和 # 注释；兼容 CRLF；值两端成对的引号会去掉；不做变量展开
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

// 日志超过 maxBytes 就轮转：yumeiro.log → yumeiro.log.1 → … → .keep（最老的删掉）
export function rotateLog(file, { maxBytes = 5 * 1048576, keep = 5 } = {}) {
  let size = 0;
  try { size = statSync(file).size; } catch { return false; }
  if (size < maxBytes) return false;
  rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  renameSync(file, `${file}.1`);
  return true;
}

// 解析命令行。返回 { env, log, pre, cwd, entry, args }
export function parseArgs(argv) {
  const opts = { env: '', log: '', pre: '', cwd: '', entry: '', args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!opts.entry && ['--env', '--log', '--pre', '--cwd'].includes(a)) { opts[a.slice(2)] = argv[++i] || ''; continue; }
    if (!opts.entry) { opts.entry = a; continue; }
    opts.args.push(a);
  }
  return opts;
}

// Windows 下子进程至少要带这几个系统变量，否则 node / npm / 引擎会找不到系统目录
const KEEP_SYSTEM = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];
export function buildEnv(base, fileEnv) {
  const env = {};
  for (const key of KEEP_SYSTEM) if (base[key] !== undefined) env[key] = base[key];
  const pathKey = Object.keys(base).find(k => k.toLowerCase() === 'path') || 'Path';
  if (base[pathKey] !== undefined) env[pathKey] = base[pathKey];
  for (const [k, v] of Object.entries(fileEnv)) {
    if (k.toLowerCase() === 'path') env[pathKey] = v; else env[k] = v;
  }
  return env;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.entry) { console.error('用法：node run-service.mjs --env <env文件> --log <日志> [--pre <脚本>] [--cwd <目录>] <入口脚本>'); process.exit(2); }
  let fileEnv = {};
  if (o.env) { try { fileEnv = parseEnvFile(readFileSync(o.env, 'utf8')); } catch (error) { console.error('读不到配置文件 ' + o.env + '：' + error.message); process.exit(2); } }
  const env = buildEnv(process.env, fileEnv);
  const cwd = o.cwd || path.dirname(path.resolve(o.entry));
  let fd = 'ignore';
  if (o.log) { mkdirSync(path.dirname(o.log), { recursive: true }); rotateLog(o.log); fd = openSync(o.log, 'a'); }
  const stdio = ['ignore', fd, fd];
  if (o.pre) spawnSync(process.execPath, [o.pre], { cwd, env, stdio, timeout: 120000 }); // 预备脚本失败不影响启动（和 systemd 的 ExecStartPre=- 一致）
  const child = spawn(process.execPath, [o.entry, ...o.args], { cwd, env, stdio, windowsHide: true });
  const stop = () => { try { child.kill(); } catch { /* 已退出 */ } };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGBREAK']) process.on(signal, stop);
  child.on('error', error => { console.error('无法启动 ' + o.entry + '：' + error.message); process.exit(1); });
  child.on('exit', (code, signal) => { if (typeof fd === 'number') closeSync(fd); process.exit(code ?? (signal ? 1 : 0)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
