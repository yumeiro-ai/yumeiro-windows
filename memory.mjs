// 记忆连续系统：跨对话、跨模型的长期记忆 + 对话滚动摘要。
// 记忆按用户保存在服务端（不属于某个模型或某段对话），所以切换模型、新开对话后都能接着用。
// 这里只放纯函数（不碰网络和存储），server.mjs 负责接线。
import { randomUUID } from 'node:crypto';

export const MEMORY_LIMITS = { perUser: 200, textMax: 300, promptBudget: 1800, picks: 12, relatedChats: 2, summaryMax: 1500 };
export const defaultPrefs = () => ({ enabled: true, auto: true, crossChat: true });

export function readPrefs(user) {
  const saved = user?.memoryPrefs || {};
  const base = defaultPrefs();
  for (const key of Object.keys(base)) if (typeof saved[key] === 'boolean') base[key] = saved[key];
  return base;
}

// ---------- 分词（中文按二字组，英文按单词） ----------
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'you', 'are', 'was', 'have', 'what', 'how', 'can']);
export function tokens(text) {
  const out = new Set();
  const lower = String(text || '').toLowerCase();
  for (const word of lower.match(/[a-z0-9_.-]{2,}/g) || []) if (!STOP.has(word)) out.add(word);
  for (const run of lower.match(/[\u3400-\u9fff]+/g) || []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}
const overlap = (a, b) => { let n = 0; for (const t of a) if (b.has(t)) n++; return n; };
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; const n = overlap(a, b); return n / (a.size + b.size - n); };

// ---------- 过滤：不该进长期记忆的内容 ----------
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|bot_[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|(?:password|passwd|secret|token|api[_-]?key|密码|密钥|口令)\s*[:：=是为]\s*\S{6,})/i;
export const looksSecret = text => SECRET.test(String(text || ''));
export function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_LIMITS.textMax);
}

// ---------- 记忆条目 ----------
export function userMemories(db, userId) {
  return Object.values(db.memories || {}).filter(item => item.userId === userId);
}

// 新增或合并：和已有记忆很像（二字组相似度 ≥ 0.6）就更新那一条，而不是重复存。
export function upsertMemory(db, userId, { text, kind = 'note', pinned = false, source = 'auto', conversationId = null, ownerId = null }, now = Date.now()) {
  text = cleanText(text);
  if (text.length < 4 || looksSecret(text)) return null;
  db.memories ||= {};
  kind = kind === 'profile' ? 'profile' : 'note';
  const mine = userMemories(db, userId), mineTokens = tokens(text);
  const same = mine.find(item => item.text === text || jaccard(tokens(item.text), mineTokens) >= 0.6);
  if (same) {
    if (source === 'manual' || text.length >= same.text.length) same.text = text;
    same.updatedAt = now; if (pinned) same.pinned = true; if (kind === 'profile') same.kind = 'profile';
    return same;
  }
  if (mine.length >= MEMORY_LIMITS.perUser) {
    const victim = mine.filter(item => !item.pinned).sort((a, b) => (a.lastUsedAt || a.updatedAt) - (b.lastUsedAt || b.updatedAt))[0];
    if (!victim) return null;
    delete db.memories[victim.id];
  }
  const id = randomUUID();
  return db.memories[id] = { id, userId, ...(ownerId ? { ownerId } : {}), text, kind, pinned: !!pinned, source, conversationId, createdAt: now, updatedAt: now, lastUsedAt: null, uses: 0 };
}

// 用户说“记住……”时直接本地保存，不用再问模型。
export function explicitRemember(message) {
  const match = String(message || '').trim().match(/^(?:请|麻烦)?(?:你)?(?:帮我)?(?:记住|记一下|记到记忆里?|remember(?: that)?)[\s:：,，]*(.{4,})$/is);
  return match ? cleanText(match[1]) : null;
}

// ---------- 取回：挑出与当前话题相关的记忆 ----------
export function selectMemories(memories, query, { picks = MEMORY_LIMITS.picks, budget = MEMORY_LIMITS.promptBudget, now = Date.now() } = {}) {
  const q = tokens(query);
  const scored = memories.map(item => {
    const hit = overlap(tokens(item.text), q);
    const ageDays = Math.max(0, (now - (item.updatedAt || item.createdAt)) / 86400000);
    const base = item.pinned ? 100 : item.kind === 'profile' ? 10 : 0;
    const score = base + hit * 5 + (hit ? Math.max(0, 3 - ageDays / 30) + Math.min(2, (item.uses || 0) / 5) : 0);
    return { item, score, relevant: item.pinned || item.kind === 'profile' || hit > 0 };
  }).filter(entry => entry.relevant).sort((a, b) => b.score - a.score);
  const chosen = []; let used = 0;
  for (const { item } of scored) {
    if (chosen.length >= picks || used + item.text.length > budget) continue;
    used += item.text.length + 3; chosen.push(item);
  }
  return chosen;
}

// ---------- 其它对话：找主题相近的往期对话 ----------
export function conversationDigest(conversation) {
  if (conversation.summary?.text) return conversation.summary.text;
  return (conversation.messages || []).filter(m => m.role === 'user').slice(-4).map(m => m.content).join(' / ').slice(0, 300);
}
export function relatedConversations(conversations, currentId, userId, query, { count = MEMORY_LIMITS.relatedChats } = {}) {
  const q = tokens(query);
  if (!q.size) return [];
  return conversations
    .filter(item => item.userId === userId && item.id !== currentId && !item.botId && item.messages?.length)
    .map(item => { const digest = conversationDigest(item); return { item, digest, hit: overlap(tokens(item.title + ' ' + digest), q) }; })
    .filter(entry => entry.hit >= 2)
    .sort((a, b) => b.hit - a.hit || b.item.updatedAt - a.item.updatedAt)
    .slice(0, count);
}

// ---------- 拼装成系统提示词里的一段 ----------
export function buildMemoryBlock({ memories = [], summary = '', related = [] } = {}) {
  const parts = [];
  if (memories.length) parts.push('## 关于用户的长期记忆\n' + memories.map(item => '- ' + item.text).join('\n'));
  if (summary) parts.push('## 本对话较早内容的摘要\n' + summary);
  if (related.length) parts.push('## 相关的往期对话\n' + related.map(entry => '- 《' + entry.item.title + '》：' + entry.digest.slice(0, 200)).join('\n'));
  if (!parts.length) return '';
  return '# 记忆（跨对话、跨模型保留）\n以下是之前积累的背景，仅在相关时自然使用；不要逐条复述，也不要说“根据记忆”。与用户当前说法冲突时，以用户当前说法为准。\n\n' + parts.join('\n\n');
}

// ---------- 让模型整理：提取记忆 / 滚动摘要 ----------
export function extractionMessages(userText, assistantText, existing) {
  const known = existing.length ? '\n已有记忆（不要重复）：\n' + existing.map(item => '- ' + item.text).join('\n') : '';
  return [{
    role: 'user',
    content: '从下面这一轮对话里，提取值得长期记住、以后新对话里还有用的内容：用户的身份、偏好、长期目标、项目背景、明确约定。' +
      '不要记录：一次性问题、临时状态、通用知识、密码/密钥/令牌等敏感信息、AI 自己说的话。' +
      '最多 3 条，每条一句话（60 字以内），用第三人称描述用户。kind 取 profile（身份/偏好，长期有效）或 note（项目/事实）。' +
      '只输出 JSON 数组，例如 [{"text":"用户是前端工程师，偏好 TypeScript","kind":"profile"}]；没有就输出 []。' + known +
      '\n\n用户：' + String(userText).slice(0, 2000) + '\n助手：' + String(assistantText).slice(0, 1500)
  }];
}
export function parseExtraction(reply) {
  const match = String(reply || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const list = JSON.parse(match[0]);
    return (Array.isArray(list) ? list : []).map(entry => typeof entry === 'string' ? { text: entry } : entry)
      .filter(entry => entry && typeof entry.text === 'string').slice(0, 3)
      .map(entry => ({ text: entry.text, kind: entry.kind === 'profile' ? 'profile' : 'note' }));
  } catch { return []; }
}

// 对话超出上下文窗口的那部分，需要折进摘要里。返回 null 表示暂时不用。
export function pendingSummaryRange(conversation, windowSize, minBatch = 6) {
  const upTo = conversation.summary?.upTo || 0, edge = conversation.messages.length - windowSize;
  return edge - upTo >= minBatch ? { from: upTo, to: edge } : null;
}
export function summaryMessages(previous, slice) {
  const text = slice.map(m => (m.role === 'user' ? '用户：' : '助手：') + String(m.content).slice(0, 600)).join('\n');
  return [{
    role: 'user',
    content: '把下面的对话合并进“已有摘要”，输出更新后的摘要：保留话题、已确定的结论与决定、用户的要求和未完成事项，忽略寒暄。不超过 ' +
      MEMORY_LIMITS.summaryMax / 3 + ' 字，只输出摘要正文。\n\n已有摘要：' + (previous || '（无）') + '\n\n新增对话：\n' + text
  }];
}
