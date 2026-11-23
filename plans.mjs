// 套餐分级与授权密钥（纯逻辑）。
// 目前处于“试用期”：PLAN_ENFORCEMENT = false，所有功能都可用，只展示“这个功能属于哪一档”。
// 以后要加锁时，把它改成 true（发版时改，不能靠设置或环境变量打开，避免误锁）。
// 授权密钥：Ed25519 签名，程序里只内置公钥；签发用 scripts/make-license.mjs，私钥不在仓库里。
import { createPublicKey, verify as edVerify } from 'node:crypto';

export const PLAN_ENFORCEMENT = false;

export const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAh7htxMo8dWzf0pGsaDYqoHtpYqRXdgu8P1WIAI5+6FM=
-----END PUBLIC KEY-----
`;

// 档位从低到高。seats = 成员上限（0 表示不限），desktops = 同时在线的成员桌面数（0 表示不开放）
export const TIERS = [
  { id: 'free', name: '免费版', seats: 3, desktops: 0, blurb: '个人或小圈子体验，基础对话与自带模型。' },
  { id: 'team', name: '团队版', seats: 20, desktops: 0, blurb: '小团队协作：邀请成员、额度、邮箱域名限制。' },
  { id: 'pro', name: '专业版', seats: 100, desktops: 5, blurb: '安全与合规：熔断、敏感内容拦截、AI 邮箱、审计导出。' },
  { id: 'business', name: '公司版', seats: 0, desktops: 50, blurb: '公司级管控：机密工作区、成员独立桌面、集中管理。' },
];
const RANK = Object.fromEntries(TIERS.map((t, i) => [t.id, i]));

// status: ready = 已可用；planned = 规划中（先占位分级，功能还没做完）
export const FEATURES = [
  { id: 'chat', name: '对话与自带模型', tier: 'free', status: 'ready' },
  { id: 'engineSelfcheck', name: '引擎与隔离自检', tier: 'free', status: 'ready' },
  { id: 'invites', name: '邀请成员与额度', tier: 'team', status: 'ready' },
  { id: 'emailDomain', name: '注册邮箱域名限制', tier: 'team', status: 'ready' },
  { id: 'costCap', name: '费用上限', tier: 'team', status: 'ready' },
  { id: 'breaker', name: '模型熔断与单人限速', tier: 'pro', status: 'ready' },
  { id: 'dlp', name: '敏感内容拦截', tier: 'pro', status: 'ready' },
  { id: 'aiMail', name: 'AI 邮箱', tier: 'pro', status: 'planned' },
  { id: 'auditExport', name: '审计导出', tier: 'pro', status: 'ready' },
  { id: 'confidential', name: '机密工作区标签', tier: 'business', status: 'ready' },
  { id: 'memberDesktop', name: '成员独立桌面', tier: 'business', status: 'planned' },
];

export const tierById = id => TIERS.find(t => t.id === id) || TIERS[0];
export const featureById = id => FEATURES.find(f => f.id === id);

// 功能能不能用。试用期（enforce=false）一律放行。
export function featureAllowed(featureId, tierId, enforce = PLAN_ENFORCEMENT) {
  if (!enforce) return true;
  const f = featureById(featureId); if (!f) return false;
  return (RANK[tierId] ?? 0) >= RANK[f.tier];
}
export function seatLimit(tierId, enforce = PLAN_ENFORCEMENT) { return enforce ? tierById(tierId).seats : 0; }

// ───────── 授权密钥 ─────────
// 格式：YML1.<载荷 base64url>.<签名 base64url>；载荷 { v:1, id, tier, org, seats?, iat, exp }（exp 为毫秒时间戳，0 = 长期有效）
export const LICENSE_PREFIX = 'YML1';
const b64 = s => Buffer.from(String(s), 'base64url');

export function verifyLicense(key, now = Date.now(), pem = LICENSE_PUBLIC_KEY) {
  const parts = String(key || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return { ok: false, error: '密钥格式不对' };
  let payload;
  try {
    if (!edVerify(null, Buffer.from(parts[0] + '.' + parts[1]), createPublicKey(pem), b64(parts[2]))) return { ok: false, error: '密钥签名无效' };
    payload = JSON.parse(b64(parts[1]).toString('utf8'));
  } catch { return { ok: false, error: '密钥无法识别' }; }
  if (payload?.v !== 1 || !(payload.tier in RANK) || typeof payload.id !== 'string') return { ok: false, error: '密钥内容不完整' };
  const exp = Number(payload.exp) || 0;
  const expired = exp > 0 && exp <= now;
  return { ok: true, expired, license: { id: payload.id.slice(0, 64), tier: payload.tier, org: String(payload.org || '').slice(0, 80), seats: Math.max(0, Math.floor(Number(payload.seats) || 0)), iat: Number(payload.iat) || 0, exp } };
}

// 当前生效的档位：有有效密钥用密钥的档位，否则免费版
export function effectivePlan(storedKey, now = Date.now(), pem) {
  const empty = { tier: 'free', source: 'none', license: null, error: '' };
  if (!storedKey) return empty;
  const r = verifyLicense(storedKey, now, pem);
  if (!r.ok) return { ...empty, error: r.error };
  if (r.expired) return { ...empty, license: r.license, error: '授权已过期' };
  return { tier: r.license.tier, source: 'license', license: r.license, error: '' };
}

// ───────── 注册邮箱域名限制 ─────────
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function normalizeEmailPolicy(input = {}) {
  const raw = Array.isArray(input.domains) ? input.domains : String(input.domains || '').split(/[\s,;，；]+/);
  const domains = [...new Set(raw.map(d => String(d).trim().toLowerCase().replace(/^@/, '')).filter(d => DOMAIN.test(d)))].slice(0, 50);
  return { enabled: Boolean(input.enabled) && domains.length > 0, domains };
}
export function validateEmailPolicyInput(input = {}) {
  const raw = Array.isArray(input.domains) ? input.domains : String(input.domains || '').split(/[\s,;，；]+/);
  const bad = raw.map(d => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean).filter(d => !DOMAIN.test(d));
  if (bad.length) return '域名格式不对：' + bad.slice(0, 3).join('、');
  if (input.enabled && !normalizeEmailPolicy(input).domains.length) return '开启域名限制前，请至少填写一个公司邮箱域名';
  return '';
}
// 只认完整域名：example.com 不放行 evil-example.com，也不放行 example.com.evil.net；子域名需要单独填写
export function emailAllowed(email, policy) {
  if (!policy?.enabled) return true;
  const parts = String(email || '').trim().toLowerCase().split('@');
  return parts.length === 2 && parts[0].length > 0 && policy.domains.includes(parts[1]);
}
export const emailPolicyMessage = policy => '只允许使用公司邮箱注册：' + policy.domains.map(d => '@' + d).join('、');
