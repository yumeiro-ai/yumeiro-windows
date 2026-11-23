// 项目文件的在线预览 / 导出导入 / 本地使用包，以及“AI 指引对话”的提示词与解析。纯函数，便于测试。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { safeEntryName } from './ziputil.mjs';

export const PROJECT_LIMITS = { maxFiles: 3000, maxExportBytes: 200 * 1048576, previewTtlMs: 12 * 3600 * 1000 };
export const MANIFEST_NAME = 'yumeiro-project.json';
export const PROJECT_DIR = 'project';

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', pdf: 'application/pdf', wasm: 'application/wasm'
};
const TEXTUAL = new Set(['py', 'ts', 'tsx', 'jsx', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'yml', 'yaml', 'toml', 'ini', 'log', 'lua', 'kt', 'swift', 'vue', 'md', 'markdown']);
export const extOf = rel => { const m = /\.([A-Za-z0-9]+)$/.exec(String(rel)); return m ? m[1].toLowerCase() : ''; };
export const mimeOf = rel => { const ext = extOf(rel); return MIME[ext] || (TEXTUAL.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream'); };

// ---- Markdown → 完整 HTML 页面（自包含：会被原样放进“本地使用包”的 serve.mjs 里，所以不能引用外部变量）----
export function renderMarkdownPage(source, title) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeUrl = u => { const url = String(u).trim(); return /^(https?:|mailto:)/i.test(url) || /^[^:]*$/.test(url) ? url : '#'; };
  const inline = text => {
    const codes = [];
    let t = String(text).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    t = esc(t);
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => '<img alt="' + alt + '" src="' + safeUrl(url.replace(/&amp;/g, '&')) + '">');
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => '<a href="' + safeUrl(url.replace(/&amp;/g, '&')) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
    return t.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + esc(codes[Number(i)]) + '</code>');
  };
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n'), out = [];
  let i = 0;
  const isTableSep = s => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s || '');
  const cells = s => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { const body = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]); i++; out.push('<pre><code>' + esc(body.join('\n')) + '</code></pre>'); continue; }
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) { const body = []; while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, '')); out.push('<blockquote>' + inline(body.join(' ')) + '</blockquote>'); continue; }
    if (line.includes('|') && isTableSep(lines[i + 1])) {
      const head = cells(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'); continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2]), items = [];
      while (i < lines.length) { const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]); if (!m) break; items.push(m[3]); i++; }
      const tag = ordered ? 'ol' : 'ul'; out.push('<' + tag + '>' + items.map(x => '<li>' + inline(x.replace(/^\[( |x)\]\s+/i, (mm, c) => (c.trim() ? '☑ ' : '☐ '))) + '</li>').join('') + '</' + tag + '>'); continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
    out.push('<p>' + inline(para.join(' ')) + '</p>');
  }
  const style = 'body{max-width:860px;margin:32px auto;padding:0 20px;font:16px/1.75 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#222;background:#fff}pre{background:#f5f5f7;padding:12px 14px;border-radius:8px;overflow:auto}code{background:#f0f0f3;padding:1px 5px;border-radius:4px;font-size:.92em}pre code{background:none;padding:0}blockquote{margin:12px 0;padding:2px 14px;border-left:4px solid #ddd;color:#666}table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:6px 10px}img{max-width:100%}a{color:#d6385a}@media(prefers-color-scheme:dark){body{background:#15151b;color:#e4e4ea}pre{background:#20202a}code{background:#262631}th,td{border-color:#3a3a48}blockquote{border-color:#444;color:#aaa}}';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title || '文档') + '</title><style>' + style + '</style></head><body>' + out.join('\n') + '</body></html>';
}

// ---- 在线预览的签名链接：<工作区id>.<撤销序号>.<过期时间(36进制)>.<签名> ----
const sign = (key, text) => createHmac('sha256', key).update('yumeiro-preview:' + text).digest('base64url').slice(0, 27);
export function signPreview(key, workspaceId, epoch, expiresAt) {
  const body = workspaceId + '.' + Number(epoch || 0) + '.' + Math.floor(expiresAt).toString(36);
  return body + '.' + sign(key, body);
}
export function verifyPreview(key, token, now = Date.now()) {
  const m = /^([0-9a-f-]{36})\.(\d{1,9})\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{27})$/.exec(String(token || ''));
  if (!m) return null;
  const body = m[1] + '.' + m[2] + '.' + m[3], want = Buffer.from(sign(key, body)), got = Buffer.from(m[4]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const expiresAt = parseInt(m[3], 36);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;
  return { workspaceId: m[1], epoch: Number(m[2]), expiresAt };
}
// 预览页面在“沙箱”里运行：拿不到本站的 Cookie 和接口，也不能向外网发请求（防数据外泄）。
export const previewHeaders = type => ({
  'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'self'; frame-ancestors 'self'"
});
// 预览请求路径 → 工作区内相对路径；不安全返回 null
export function previewPath(rest) {
  let decoded; try { decoded = decodeURIComponent(String(rest || '')); } catch { return null; }
  if (!decoded || decoded.endsWith('/')) decoded += 'index.html';
  return safeEntryName(decoded);
}

// ---- 导出 / 导入 ----
export function manifestFor(workspaceName, files, { local = false, version = '' } = {}) {
  return JSON.stringify({ app: 'Yumeiro', kind: 'project', name: workspaceName, exportedAt: new Date().toISOString(), version, root: PROJECT_DIR + '/', fileCount: files, localKit: local }, null, 2);
}
// 把压缩包里的条目整理成要写入工作区的文件：识别本站导出的包（只取 project/），或自动去掉唯一的最外层目录
export function planImport(entries) {
  const names = entries.map(e => e.name);
  let prefix = '', mode = 'plain';
  const manifest = entries.find(e => e.name === MANIFEST_NAME);
  if (manifest) { try { if (JSON.parse(manifest.data.toString('utf8')).root === PROJECT_DIR + '/') { prefix = PROJECT_DIR + '/'; mode = 'yumeiro'; } } catch { /* 清单损坏：按普通包处理 */ } }
  if (!prefix) {
    const tops = new Set(names.map(n => n.split('/')[0]));
    if (tops.size === 1 && names.every(n => n.includes('/'))) { prefix = [...tops][0] + '/'; mode = 'folder'; }
  }
  const files = []; let ignored = 0;
  for (const e of entries) {
    if (prefix && !e.name.startsWith(prefix)) { ignored++; continue; }
    const name = prefix ? e.name.slice(prefix.length) : e.name;
    if (!name || name === MANIFEST_NAME || /(^|\/)(\.git|node_modules|__MACOSX)\//.test(name) || /(^|\/)\.DS_Store$/.test(name) || name.startsWith('.versions/')) { ignored++; continue; }
    files.push({ name, data: e.data });
  }
  return { files, ignored, mode, prefix };
}

// ---- 本地使用包（下载的 zip 里带上，解压后双击即可在本机浏览器里使用）----
const SERVE_SOURCE = String.raw`// Yumeiro 项目本地查看器：零依赖，只需要安装 Node.js 18 或更高版本。
// 用法：node serve.mjs [端口]    然后用浏览器打开屏幕上显示的地址。
import http from 'node:http';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'project');
const MIME = __MIME__;
__RENDER__
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mimeOf = file => { const m = /\.([A-Za-z0-9]+)$/.exec(file); const ext = m ? m[1].toLowerCase() : ''; return MIME[ext] || (ext === 'md' || ext === 'markdown' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'); };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    let info; try { info = await stat(target); } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('找不到文件'); }
    if (info.isDirectory()) {
      if (!url.pathname.endsWith('/')) { res.writeHead(302, { Location: url.pathname + '/' }); return res.end(); }
      try { const index = await readFile(path.join(target, 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(index); } catch { /* 没有 index.html：列目录 */ }
      const names = (await readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      const items = names.map(d => '<li><a href="' + encodeURI(d.name) + (d.isDirectory() ? '/' : '') + '">' + esc(d.name) + (d.isDirectory() ? '/' : '') + '</a></li>').join('');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>文件列表</title><body style="font:16px system-ui;max-width:760px;margin:30px auto"><h2>/' + esc(rel) + '</h2><ul>' + items + '</ul></body>');
    }
    const data = await readFile(target);
    if (/\.(md|markdown)$/i.test(target)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(renderMarkdownPage(data.toString('utf8'), path.basename(target))); }
    res.writeHead(200, { 'Content-Type': mimeOf(target), 'X-Content-Type-Options': 'nosniff' }); res.end(data);
  } catch (error) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('出错了：' + error.message); }
});
let port = Number(process.argv[2]) || 8080, tries = 0;
server.on('error', error => { if (error.code === 'EADDRINUSE' && tries++ < 20) server.listen(++port, '127.0.0.1'); else { console.error('无法启动：', error.message); process.exit(1); } });
server.on('listening', () => {
  const address = 'http://127.0.0.1:' + port + '/';
  console.log('项目已在本机打开：' + address + '\n按 Ctrl+C 结束。（只监听本机，局域网里的其他设备访问不到）');
  if (process.argv.includes('--open')) { const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', address]] : process.platform === 'darwin' ? ['open', [address]] : ['xdg-open', [address]]; try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* 打不开就手动访问 */ } }
});
server.listen(port, '127.0.0.1');
`;

export function serveSource() {
  return SERVE_SOURCE.replace('__MIME__', () => JSON.stringify(MIME)).replace('__RENDER__', () => renderMarkdownPage.toString());
}
export function localKit(name) {
  const readme = [
    'Yumeiro 项目：' + name, '', '这个压缩包是从 Yumeiro 工作区导出的，可以在本机直接使用。', '',
    '一、怎么看 / 怎么用',
    '  1. 解压整个压缩包。',
    '  2. Windows：双击“启动.bat”；macOS / Linux：在终端里运行 ./start.sh（第一次可能需要 chmod +x start.sh）。',
    '  3. 浏览器会自动打开项目；没有打开的话，手动访问屏幕上显示的地址（通常是 http://127.0.0.1:8080/）。',
    '  需要先安装 Node.js 18 或更高版本（https://nodejs.org）。如果项目只是一个纯网页，也可以直接双击 project/index.html 打开。', '',
    '二、文件在哪里', '  所有项目文件都在 project/ 文件夹里，可以用任何编辑器修改。', '',
    '三、再放回 Yumeiro', '  把整个压缩包（或只压缩 project 文件夹）在“工作区 → 导入项目”里上传，就会合并回工作区；同名文件会覆盖，覆盖前旧内容会自动备份。', '',
    '四、说明', '  - 在线预览里不能访问外网；本地查看器没有这个限制，但只监听本机。',
    '  - 如果项目里的程序需要别的运行环境（Python、数据库等），请按项目自己的 README 操作。', ''
  ].join('\r\n');
  return [
    { name: 'README-本地使用.txt', data: Buffer.from('\ufeff' + readme, 'utf8') },
    { name: 'serve.mjs', data: Buffer.from(serveSource(), 'utf8') },
    { name: '启动.bat', data: Buffer.from('@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul || (echo 没有找到 Node.js，请先安装：https://nodejs.org & pause & exit /b 1)\r\nnode serve.mjs --open\r\npause\r\n', 'utf8') },
    { name: 'start.sh', data: Buffer.from('#!/usr/bin/env sh\ncd "$(dirname "$0")" || exit 1\ncommand -v node >/dev/null 2>&1 || { echo "没有找到 Node.js，请先安装：https://nodejs.org"; exit 1; }\nexec node serve.mjs --open\n', 'utf8') }
  ];
}

// ---- AI 指引对话 ----
export const GUIDE_TABS = {
  '/settings': ['usage', 'dashboard', 'tokens', 'agents', 'skills', 'bots', 'wallpapers', 'cindy', 'audit'],
  '/admin/settings': ['members', 'invites', 'userskills', 'providers', 'engines', 'voice', 'tts', 'vision', 'imagegen', 'site', 'review', 'desktop', 'dashboard', 'audit', 'env', 'usage'],
  '/workspaces': [], '/market': [], '/remote': []
};
export function safeGoTarget(href) {
  const m = /^(\/[a-z/]+?)(?:\?tab=([a-z]+))?$/.exec(String(href).trim());
  if (!m || !GUIDE_TABS[m[1]]) return null;
  if (m[2] && !GUIDE_TABS[m[1]].includes(m[2])) return null;
  return m[1] + (m[2] ? '?tab=' + m[2] : '');
}
export function cleanGuideMessages(input, { maxMessages = 24, maxChars = 6000 } = {}) {
  const list = (Array.isArray(input) ? input : []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()).map(m => ({ role: m.role, content: m.content.slice(0, maxChars) })).slice(-maxMessages);
  while (list.length && list[0].role !== 'user') list.shift();
  return list;
}
// 把模型回复拆成：正文 / 可点选项 / 跳转按钮 / 要保存的文件
export function parseGuideReply(raw) {
  let text = String(raw || ''); const files = [], options = [], actions = [], dropped = [];
  text = text.replace(/<<<FILE path="([^"\n]{1,200})">>>\r?\n([\s\S]*?)\r?\n?<<<END>>>/g, (m, rawPath, content) => {
    const rel = safeEntryName(rawPath);
    let body = content;
    const fenced = /^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(body); if (fenced) body = fenced[1];
    if (!rel || /(^|\/)\./.test(rel) && !/^\.(gitignore|env\.example)$/.test(rel.split('/').pop()) || files.length >= 12 || Buffer.byteLength(body) > 200 * 1024) { dropped.push(rawPath); return ''; }
    files.push({ path: rel, content: body }); return '';
  });
  text = text.replace(/\[\[opt:([^\]\n]{1,60})\]\]/g, (m, label) => { if (options.length < 4) options.push(label.trim()); return ''; });
  text = text.replace(/\[\[go:([^|\]\n]{1,80})\|([^\]\n]{1,30})\]\]/g, (m, href, label) => { const target = safeGoTarget(href); if (target && actions.length < 3) actions.push({ href: target, label: label.trim() }); return ''; });
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { text, files, options, actions, dropped };
}
const KNOWLEDGE = `你是 Yumeiro（梦色）的内置指引助手。Yumeiro 是自托管的私有 AI 工作空间。你熟悉下面的功能，只回答和使用 Yumeiro 相关的问题；不确定的事直说不确定，不要编造功能或按钮。

【主要功能和位置】
- 聊天主页：左侧“开启新对话”；输入框旁可选模型和智能体；🖼 = 上传/粘贴图片让模型分析（管理员可在“图片理解”里接本机视觉模型 / OCR）；麦克风按钮=语音输入；顶栏按钮：🖥 远程控制自己的 Windows/Mac 电脑（/remote，手机上也能用）、📲 安装为独立应用（PWA）、🧭 AI 指引、🔊 语音（回复朗读、语音通话）、🎨 文字生成图片、🌸 对话历史树、🧠 长期记忆、主题切换。
- 个人设置 /settings：用量、仪表盘、API 令牌（给脚本/客户端调用本站的 OpenAI 兼容接口，也可接 /v1/audio、/v1/images）、智能体、技能工坊、机器人、壁纸、Cindy 账号、操作记录。
- 工作区 /workspaces：一组成员共享的项目目录，里面有文件浏览、上传/下载、版本历史（可还原）、过期清理、在线预览、整个项目下载 zip / 本地使用包、导入 zip，以及多智能体协作（接力、圆桌、主管调度）。需要已安装“智能体运行器”。
- 管理设置 /admin/settings（仅管理员）：团队成员、邀请成员、AI 接入（接模型服务商，最先要配）、智能体引擎、语音识别、语音朗读、绘画模型、站点设置（站点名、个人/团队模式、默认模型）、市场审核、桌面端、团队仪表盘、审计与统计、环境检测、团队用量。

【首次配置的推荐顺序】1) AI 接入：添加服务商和密钥，开放模型；2) 站点设置：选个人模式或团队模式、默认模型；3) 团队模式下：邀请成员、设额度；4) 按需：语音识别、语音朗读、绘画模型；5) 需要工作区/多智能体时安装运行器；6) 环境检测：确认服务器网络和出口地区。

【跳转按钮】需要带用户去某个页面时，在回复末尾写 [[go:路径|按钮文字]]（最多 3 个）。路径只能是：/settings?tab=（usage dashboard tokens agents skills bots wallpapers cindy audit）、/admin/settings?tab=（members invites userskills providers engines voice tts vision imagegen site review desktop dashboard audit env usage）、/workspaces、/market、/remote。普通成员不要指向 /admin 页面，告诉他们联系管理员。
`;
export function guidePrompt(mode, state = {}) {
  const lines = [
    '当前站点状态（据此判断哪些步骤已完成，不要让用户重复做）：',
    '- 当前用户：' + (state.admin ? '管理员' : '普通成员') + '；使用模式：' + (state.personal ? '个人' : '团队'),
    '- AI 模型：' + (state.model ? '已接入' : '尚未接入') + '；智能体运行器（工作区）：' + (state.runner ? '已安装' : '未安装') + '；语音识别：' + (state.asr ? '已开启' : '未开启') + '；语音朗读：' + (state.tts ? '已开启' : '未开启') + '；绘画模型：' + (state.images ? '已开启' : '未开启'),
    '- 该用户的工作区数量：' + (state.workspaces || 0)
  ].join('\n');
  if (mode === 'task') {
    return KNOWLEDGE + '\n' + lines + `

【任务引导模式】用户想完成一件事（做网页、写文档、做工具、整理方案等）。你的做法：
1. 每轮只问一个问题，问题短而具体，并给出 2–4 个可点选项，格式 [[opt:选项文字]]（每个选项单独写，选项文字不超过 20 字）；用户也可以自己打字。
2. 一般问 2–4 个问题（目标和使用场景、风格或技术偏好、必须有的内容）就够了；用户说“直接生成/你决定”时马上生成。
3. 信息足够后，一次性输出完整的项目文件。每个文件严格使用这个格式（不要在外面再包代码块）：
<<<FILE path="相对路径，如 index.html">>>
文件内容
<<<END>>>
4. 技术要求：优先做成“纯静态网页”（index.html + 需要时的 css/js 文件，不依赖外网 CDN 和构建工具），这样可以直接在线预览、下载后双击使用；一定附一个 README.md，说明怎么用。最多 12 个文件，每个文件不超过 60KB；路径只用英文、数字、下划线、短横线和点。
5. 输出文件前后各用一两句话说明做了什么，以及用户可以点“保存到工作区”后在线预览或下载。不要再写跳转按钮以外的链接。
6. 用户要求修改时，只输出需要改动的文件（完整内容）。`;
  }
  return KNOWLEDGE + '\n' + lines + `

【使用向导模式】回答要短、分步骤、直接说“点哪里、填什么”。能用跳转按钮的就给跳转按钮。如果用户要求你“带我配置”，一步一步来：每轮只讲一步，并给 1–3 个选项 [[opt:文字]] 如“已完成，下一步”“遇到问题”。涉及密钥时只告诉用户在哪一页填写，不要让用户把密钥发给你。`;
}
