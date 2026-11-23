// 敏感内容检测（纯逻辑，方便测试）。只返回“命中了哪条规则、几次”，从不返回、也不记录匹配到的原文。
// 内置规则：身份证号（带校验位）、银行卡号（Luhn 校验）、密钥/令牌的典型格式、手机号、邮箱；
// 管理员可以再加关键词（不分大小写）和正则。命中后的处理方式由调用方决定（拦截 / 只警告）。
export const BUILTIN_RULES = {
  idcard: { label: '身份证号', default: true },
  bank: { label: '银行卡号', default: true },
  secret: { label: '密钥或令牌', default: true },
  phone: { label: '手机号', default: false },
  email: { label: '邮箱地址', default: false },
};
export const LIMITS = { maxScanChars: 400000, maxKeywords: 200, maxKeywordLength: 64, maxRegexes: 20, maxRegexLength: 200, maxAllow: 50 };

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2], ID_CHECK = '10X98765432';
export function validIdCard(value) {
  const text = String(value).toUpperCase();
  if (!/^\d{17}[\dX]$/.test(text)) return false;
  let sum = 0; for (let i = 0; i < 17; i++) sum += Number(text[i]) * ID_WEIGHTS[i];
  return ID_CHECK[sum % 11] === text[17];
}
export function luhn(value) {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 12 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let n = Number(digits[i]); if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}
const countMatches = (text, re, accept = () => true) => { let n = 0; for (const m of text.matchAll(re)) if (accept(m[0])) n++; return n; };
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/g, /\bsk-ant-[A-Za-z0-9_-]{20,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bghp_[A-Za-z0-9]{30,}/g, /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g, /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
const BUILTIN = {
  idcard: text => countMatches(text, /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dXx])/g, validIdCard),
  bank: text => countMatches(text, /(?<!\d)\d(?:[ -]?\d){15,18}(?!\d)/g, value => { const digits = value.replace(/\D/g, ''); return digits.length >= 16 && digits.length <= 19 && luhn(digits); }),
  secret: text => SECRET_PATTERNS.reduce((n, re) => n + countMatches(text, re), 0),
  phone: text => countMatches(text, /(?<![\d])1[3-9]\d{9}(?![\d])/g),
  email: text => countMatches(text, /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g),
};
// 容易让正则回溯爆炸的写法（嵌套量词）一律拒绝：管理员写的正则会在每次对话里执行
const RISKY_REGEX = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]|\([^()]*\|[^()]*\)[+*{]/;
export function checkRegex(pattern) {
  const text = String(pattern || '');
  if (!text || text.length > LIMITS.maxRegexLength) return '正则不能为空，且不能超过 ' + LIMITS.maxRegexLength + ' 个字符';
  if (RISKY_REGEX.test(text)) return '这个正则可能运行得很慢（嵌套的重复），请改写';
  try { new RegExp(text, 'giu'); } catch (error) { return '正则写法不对：' + error.message.slice(0, 80); }
  return '';
}

export function normalizePolicy(input = {}) {
  const builtin = {}; for (const [id, rule] of Object.entries(BUILTIN_RULES)) builtin[id] = input.builtin?.[id] === undefined ? rule.default : Boolean(input.builtin[id]);
  const keywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : String(input.keywords || '').split(/\r?\n/)).map(k => String(k).trim().slice(0, LIMITS.maxKeywordLength)).filter(Boolean))].slice(0, LIMITS.maxKeywords);
  const regexes = (Array.isArray(input.regexes) ? input.regexes : []).map(r => ({ name: String(r?.name || '自定义规则').trim().slice(0, 40) || '自定义规则', pattern: String(r?.pattern || '') })).filter(r => !checkRegex(r.pattern)).slice(0, LIMITS.maxRegexes);
  const allow = [...new Set((Array.isArray(input.confidentialAllow) ? input.confidentialAllow : []).map(String).map(s => s.trim().slice(0, 80)).filter(Boolean))].slice(0, LIMITS.maxAllow);
  return { enabled: Boolean(input.enabled), mode: input.mode === 'warn' ? 'warn' : 'block', builtin, keywords, regexes, confidentialAllow: allow };
}
// 保存前的校验：返回错误提示（空字符串表示没问题）
export function validatePolicyInput(input = {}) {
  for (const r of Array.isArray(input.regexes) ? input.regexes : []) { const problem = checkRegex(r?.pattern); if (problem) return `正则“${String(r?.name || '').slice(0, 20) || '未命名'}”：${problem}`; }
  if (Array.isArray(input.regexes) && input.regexes.length > LIMITS.maxRegexes) return '自定义正则最多 ' + LIMITS.maxRegexes + ' 条';
  return '';
}

export function scanText(text, policy) {
  const source = String(text || '').slice(0, LIMITS.maxScanChars), hits = [];
  if (!source) return hits;
  for (const [id, enabled] of Object.entries(policy.builtin)) { if (!enabled) continue; const count = BUILTIN[id](source); if (count) hits.push({ id, label: BUILTIN_RULES[id].label, count }); }
  const lower = source.toLowerCase();
  for (const keyword of policy.keywords) { const k = keyword.toLowerCase(); let count = 0, at = lower.indexOf(k); while (at !== -1 && count < 1000) { count++; at = lower.indexOf(k, at + k.length); } if (count) hits.push({ id: 'kw:' + keyword, label: '关键词「' + keyword + '」', count }); }
  for (const rule of policy.regexes) { let count = 0; try { count = [...source.matchAll(new RegExp(rule.pattern, 'giu'))].length; } catch { /* 写坏的规则不影响其他规则 */ } if (count) hits.push({ id: 'rx:' + rule.name, label: '自定义规则「' + rule.name + '」', count }); }
  return hits;
}
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part?.type === 'text' || typeof part?.text === 'string' ? String(part.text || '') : '').join('\n') : '';
// 只检查“这一轮新发出的内容”：最后一条用户消息以及它之后的消息。历史里更早的内容在当时已经检查过，
// 这样一条被拦截的消息不会让整段对话永远发不出去。
export function scanMessages(messages, policy) {
  const list = Array.isArray(messages) ? messages : [];
  let from = list.length - 1; while (from > 0 && list[from]?.role !== 'user') from--;
  const merged = new Map();
  for (const message of list.slice(Math.max(0, from))) for (const hit of scanText(textOf(message?.content), policy)) { const old = merged.get(hit.id); if (old) old.count += hit.count; else merged.set(hit.id, { ...hit }); }
  return [...merged.values()];
}
export const describeHits = hits => hits.map(h => `${h.label}${h.count > 1 ? ' ×' + h.count : ''}`).join('、');
