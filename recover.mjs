// 管理员“忘记密码”：恢复密钥 + 手机确认。纯逻辑，便于测试。
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看错的 I O 0 1
export const RECOVERY = { keyChars: 25, phoneTtlMs: 5 * 60 * 1000, maxPhoneAttempts: 8, minPasswordLength: 16 };

// 恢复密钥：25 个字符（约 125 位随机），显示成 YMR-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
export function newRecoveryKey() {
  const raw = Array.from({ length: RECOVERY.keyChars }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return { raw, display: formatRecoveryKey(raw) };
}
export const formatRecoveryKey = raw => 'YMR-' + raw.match(/.{5}/g).join('-');
// 接受带不带 YMR-、大小写、空格、横线的写法；不合格返回空串
export function normalizeRecoveryKey(input) {
  let raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length === RECOVERY.keyChars + 3 && raw.startsWith('YMR')) raw = raw.slice(3);
  return raw.length === RECOVERY.keyChars && [...raw].every(ch => ALPHABET.includes(ch)) ? raw : '';
}
export const passwordProblem = password => String(password || '').length < RECOVERY.minPasswordLength ? '新密码至少需要 ' + RECOVERY.minPasswordLength + ' 个字符' : String(password).length > 200 ? '密码太长' : '';

// 简单的失败次数限制：窗口内超过上限就拒绝
export function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const map = new Map();
  return {
    blocked(key) { const v = map.get(key); if (!v) return false; if (now() - v.at > windowMs) { map.delete(key); return false; } return v.n >= max; },
    fail(key) { const v = map.get(key); if (!v || now() - v.at > windowMs) map.set(key, { n: 1, at: now() }); else v.n++; },
    reset(key) { map.delete(key); },
    clear() { map.clear(); }
  };
}

// 手机确认：电脑上发起请求 → 得到 6 位验证码；已登录的手机输入验证码批准 → 电脑拿到一次性凭据登录 / 改密码
export function createPhoneStore({ now = () => Date.now() } = {}) {
  const byId = new Map();
  const sweep = () => { for (const [id, r] of byId) if (r.expires < now() - 60000) byId.delete(id); };
  const activeCodes = () => new Set([...byId.values()].filter(r => r.status === 'pending' && r.expires > now()).map(r => r.code));
  return {
    // userId 为 null 表示账号不存在：照样返回验证码（不泄露账号是否存在），但永远批准不了
    start(userId, meta = {}) {
      sweep();
      if ([...byId.values()].filter(r => r.status === 'pending' && r.expires > now()).length > 200) throw Object.assign(new Error('请求太多，请稍后再试'), { status: 429 });
      const taken = activeCodes(); let code; do { code = String(randomInt(1000000)).padStart(6, '0'); } while (taken.has(code));
      const id = randomBytes(24).toString('base64url'), request = { id, userId, code, status: 'pending', createdAt: now(), expires: now() + RECOVERY.phoneTtlMs, ip: meta.ip || '', ua: String(meta.ua || '').slice(0, 120), attempts: 0 };
      byId.set(id, request); return { id, code, expiresAt: request.expires };
    },
    status(id) {
      const r = byId.get(String(id || '')); if (!r) return { status: 'unknown' };
      if (r.status === 'pending' && r.expires <= now()) r.status = 'expired';
      return { status: r.status, expiresAt: r.expires };
    },
    pendingFor(userId) { return [...byId.values()].filter(r => r.userId === userId && r.status === 'pending' && r.expires > now()).map(r => ({ code: r.code, createdAt: r.createdAt, expiresAt: r.expires, ip: r.ip, ua: r.ua })); },
    // 已登录的本人批准 / 拒绝；返回 null 表示没有匹配的请求
    decide(userId, code, approve) {
      sweep(); if (!userId) return null;
      const r = [...byId.values()].find(item => item.userId === userId && item.code === String(code || '').replace(/\D/g, '') && item.status === 'pending' && item.expires > now());
      if (!r) return null;
      r.status = approve ? 'approved' : 'denied'; r.approvedAt = now(); return { status: r.status, ip: r.ip, ua: r.ua };
    },
    // 电脑端凭 id 领取一次（已批准且没过期），领完就作废
    consume(id) {
      const r = byId.get(String(id || ''));
      if (!r || r.status !== 'approved' || now() - r.approvedAt > RECOVERY.phoneTtlMs) return null;
      byId.delete(r.id); return r.userId;
    },
    size: () => byId.size
  };
}

// 扫码登录：电脑登录页生成二维码 → 已登录的手机扫码并确认 → 电脑拿到一次性凭据登录。
// code 在二维码里（手机用它确认）；secret 只留在电脑的页面里（领取登录时必须带上），所以只扫到二维码的人领不走登录。
export const QR = { ttlMs: 3 * 60 * 1000 };
export function createQrStore({ now = () => Date.now() } = {}) {
  const byId = new Map();
  const sweep = () => { for (const [id, r] of byId) if (r.expires < now() - 60000) byId.delete(id); };
  const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
  const live = r => r && r.expires > now();
  return {
    start(meta = {}) {
      sweep();
      if ([...byId.values()].filter(live).length > 300) throw Object.assign(new Error('请求太多，请稍后再试'), { status: 429 });
      const r = { id: randomBytes(18).toString('base64url'), code: randomBytes(16).toString('base64url'), secret: randomBytes(24).toString('base64url'), status: 'pending', userId: null, createdAt: now(), expires: now() + QR.ttlMs, ip: meta.ip || '', ua: String(meta.ua || '').slice(0, 160) };
      byId.set(r.id, r); return { id: r.id, code: r.code, secret: r.secret, expiresAt: r.expires };
    },
    status(id) { const r = byId.get(String(id || '')); if (!r) return { status: 'unknown' }; if (r.status === 'pending' && !live(r)) r.status = 'expired'; return { status: r.status, expiresAt: r.expires }; },
    // 手机端确认前看一眼：是谁在请求（IP / 浏览器），防止被人拿着二维码骗你确认
    info(code) { const r = [...byId.values()].find(item => same(item.code, code) && item.status === 'pending' && live(item)); return r ? { ip: r.ip, ua: r.ua, createdAt: r.createdAt, expiresAt: r.expires } : null; },
    decide(userId, code, approve) { sweep(); if (!userId) return null; const r = [...byId.values()].find(item => same(item.code, code) && item.status === 'pending' && live(item)); if (!r) return null; r.status = approve ? 'approved' : 'denied'; r.userId = approve ? userId : null; r.approvedAt = now(); return { status: r.status, ip: r.ip, ua: r.ua }; },
    consume(id, secret) { const r = byId.get(String(id || '')); if (!r || r.status !== 'approved' || now() - r.approvedAt > QR.ttlMs || !same(r.secret, secret)) return null; byId.delete(r.id); return r.userId; }
  };
}
