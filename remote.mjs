// 远程控制（自己的 Windows / Mac 电脑）：配对码、输入事件校验。纯函数，便于测试。
import { randomInt } from 'node:crypto';

export const REMOTE_LIMITS = { pairTtlMs: 10 * 60 * 1000, maxDevices: 10, maxEventsPerBatch: 40, maxTextChars: 200, frameMaxBytes: 4 * 1048576, viewerIdleMs: 20000, offlineMs: 45000, queueMax: 200, eventsPerSecond: 120 };
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看错的 I O 0 1
export function newPairCode() { let out = ''; for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)]; return out.slice(0, 4) + '-' + out.slice(4); }
export const normalizePairCode = input => { const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return raw.length === 8 ? raw.slice(0, 4) + '-' + raw.slice(4) : ''; };

const BUTTONS = new Set(['left', 'right', 'middle']);
const MODS = ['ctrl', 'alt', 'shift', 'meta'];
const NAMED_KEYS = new Set(['enter', 'escape', 'tab', 'backspace', 'delete', 'space', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'insert', 'capslock', 'meta', ...Array.from({ length: 12 }, (_, i) => 'f' + (i + 1))]);
const unit = value => { const n = Number(value); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null; };
const fail = message => Object.assign(new Error(message), { status: 400 });

// 把浏览器发来的事件整理成统一格式；任何不认识的内容都直接拒绝
export function cleanInputEvents(events, { max = REMOTE_LIMITS.maxEventsPerBatch } = {}) {
  if (!Array.isArray(events) || !events.length) throw fail('没有操作');
  if (events.length > max) throw fail('一次最多 ' + max + ' 个操作');
  return events.map(event => {
    const type = String(event?.type || '');
    if (type === 'move') { const x = unit(event.x), y = unit(event.y); if (x === null || y === null) throw fail('坐标不合法'); return { type, x, y }; }
    if (type === 'down' || type === 'up' || type === 'click') {
      const button = BUTTONS.has(event.button) ? event.button : 'left', x = unit(event.x), y = unit(event.y);
      if ((type === 'click' && (x === null || y === null)) || (event.x !== undefined && x === null) || (event.y !== undefined && y === null)) throw fail('坐标不合法');
      return { type, button, ...(x !== null ? { x, y } : {}), ...(type === 'click' ? { count: event.count === 2 ? 2 : 1 } : {}) };
    }
    if (type === 'wheel') { const dy = Math.max(-20, Math.min(20, Math.trunc(Number(event.dy) || 0))), dx = Math.max(-20, Math.min(20, Math.trunc(Number(event.dx) || 0))); return { type, dx, dy }; }
    if (type === 'key') {
      const key = String(event.key || ''), name = key.length === 1 ? key : key.toLowerCase();
      if (!(NAMED_KEYS.has(name) || (key.length === 1 && /^[\x20-\x7e]$/.test(key)))) throw fail('不支持的按键：' + key.slice(0, 20));
      const action = event.action === 'down' || event.action === 'up' ? event.action : 'press';
      return { type, key: key.length === 1 ? key : name, action, mods: MODS.filter(mod => Array.isArray(event.mods) && event.mods.includes(mod)) };
    }
    if (type === 'text') {
      const text = String(event.text ?? '');
      if (!text || text.length > REMOTE_LIMITS.maxTextChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw fail('文字为空、太长或含控制字符');
      return { type, text };
    }
    throw fail('不支持的操作类型');
  });
}
export const countEvents = events => ({ events: events.length, keys: events.filter(e => e.type === 'key').length, textChars: events.filter(e => e.type === 'text').reduce((sum, e) => sum + e.text.length, 0), clicks: events.filter(e => e.type === 'click' || e.type === 'down').length });

export const isJpeg = buffer => Buffer.isBuffer(buffer) && buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
export const OS_LABELS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
export const cleanDeviceName = value => String(value || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);

// 要显示给用户的被控端安装命令
export function agentCommands(origin, code, { control = true } = {}) {
  const flag = control ? ' --allow-control' : ' --view-only';
  return {
    windows: `# 在要被控制的 Windows 电脑上，打开 PowerShell（需先安装 Node.js 18+）\niwr ${origin}/remote/agent.mjs -OutFile agent.mjs\nnode agent.mjs --server ${origin} --code ${code}${flag}`,
    mac: `# 在要被控制的 Mac 上，打开“终端”（需先安装 Node.js 18+）\ncurl -fsSLO ${origin}/remote/agent.mjs\nnode agent.mjs --server ${origin} --code ${code}${flag}`
  };
}

// ---- 画面清晰度 / 流畅度：按网络和电脑的实际速度自动升降档 ----
// 档位从清晰到流畅。电脑端按这个档位截图、压缩、上传；手机/网页每次取画面时把“下载这一帧花了多久”告诉服务器，
// 电脑端也把“上一帧传了多久”随下一帧一起告诉服务器。两头里只要有一头慢，就自动降一档；稳定一阵再慢慢升回来。
export const REMOTE_LEVELS = [
  { maxWidth: 1920, quality: 78, fps: 8 },
  { maxWidth: 1600, quality: 72, fps: 7 },
  { maxWidth: 1280, quality: 62, fps: 5 },
  { maxWidth: 1024, quality: 52, fps: 4 },
  { maxWidth: 800, quality: 42, fps: 3 },
  { maxWidth: 640, quality: 34, fps: 2 }
];
export const REMOTE_MODES = { auto: null, high: 1, smooth: 4 }; // 自动 / 清晰优先 / 流畅优先（后两个固定在某一档）
export const normalizeRemoteMode = value => (Object.hasOwn(REMOTE_MODES, value) ? value : 'auto');
export const newAdaptive = (now = Date.now()) => ({ level: 2, mode: 'auto', dl: 0, up: 0, skip: 0, changedAt: now, goodSince: now });
export function remoteProfile(a) {
  const fixed = REMOTE_MODES[a.mode], level = fixed ?? a.level;
  return { ...REMOTE_LEVELS[level], level, mode: a.mode };
}
export function setRemoteMode(a, mode, now = Date.now()) { a.mode = normalizeRemoteMode(mode); a.dl = a.up = a.skip = 0; a.changedAt = a.goodSince = now; return remoteProfile(a); }
const ema = (old, value) => (old ? old * 0.6 + value * 0.4 : value);
/** 喂一次测量值。返回 true 表示档位变了（要让电脑端立刻拿到新设置）。 */
export function sampleAdaptive(a, { dlMs = 0, upMs = 0, skipped = 0 } = {}, now = Date.now()) {
  if (dlMs > 0) a.dl = ema(a.dl, Math.min(dlMs, 20000));
  if (upMs > 0) a.up = ema(a.up, Math.min(upMs, 20000));
  a.skip = a.skip * 0.7 + Math.min(Math.max(0, skipped), 5) * 0.3;
  if (a.mode !== 'auto') return false;
  const budget = 1000 / REMOTE_LEVELS[a.level].fps, worst = Math.max(a.dl, a.up);
  const bad = worst > Math.max(450, budget * 1.2) || a.skip > 0.6;
  const good = worst < budget * 0.5 && a.skip < 0.15 && (a.dl > 0 || a.up > 0);
  if (!good) a.goodSince = now;
  let next = a.level;
  if (bad && now - a.changedAt > 3000 && a.level < REMOTE_LEVELS.length - 1) next = a.level + 1;
  else if (good && now - a.goodSince > 12000 && now - a.changedAt > 12000 && a.level > 0) next = a.level - 1;
  if (next === a.level) return false;
  a.level = next; a.changedAt = a.goodSince = now; a.dl = a.up = a.skip = 0;
  return true;
}
