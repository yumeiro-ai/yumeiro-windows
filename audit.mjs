// 审计日志与按账号的操作统计（纯函数，不碰网络和存储）。
// 明细（谁、何时、做了什么、结果）保留最近 AUDIT_MAX 条；按天的计数器保留 90 天，用于长期趋势。
import { randomUUID } from 'node:crypto';

export const AUDIT_MAX = Math.max(500, Number(process.env.AUDIT_MAX) || 5000);
export const KEEP_DAYS = 90;

// 动作分类：用于统计面板分组
export const CATEGORY = {
  call: '模型调用', file: '文件操作', delete: '删除与清理', auth: '登录与安全', admin: '管理操作', guard: '环境与风险', other: '其他'
};
export function categoryOf(action) {
  if (action.startsWith('call.')) return 'call';
  if (/^file\.(write|upload|download|restore|read)/.test(action) || action === 'workspace.create') return 'file';
  if (/^file\.delete|^expiry\.|^workspace\.delete|^image\.delete/.test(action)) return 'delete';
  if (/^login|^logout|password|admin_ip|session/.test(action)) return 'auth';
  if (/^env\.|^guard\./.test(action)) return 'guard';
  if (/(_created|_updated|_deleted|_installed|_bound|_unbound)$|^member_|^invite_|^provider_|^engine_|^site_|^market_|^settings\./.test(action)) return 'admin';
  return 'other';
}
const dayOf = at => { const d = new Date(at); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// 记录一条审计。entry: {userId,email?,action,target?,detail?,ip?,ok?}
export function addAudit(db, entry, now = Date.now()) {
  db.audit ||= [];
  const user = entry.userId && db.users?.[entry.userId];
  const item = {
    id: randomUUID(), at: now, userId: entry.userId || null, email: entry.email || user?.email || null,
    action: String(entry.action).slice(0, 60), target: entry.target ? String(entry.target).slice(0, 300) : '',
    detail: entry.detail ? String(entry.detail).slice(0, 500) : '', ip: entry.ip || '', ok: entry.ok !== false
  };
  db.audit.push(item);
  if (db.audit.length > AUDIT_MAX) db.audit.splice(0, db.audit.length - AUDIT_MAX);
  if (item.userId) {
    db.stats ||= {};
    const stats = db.stats[item.userId] ||= { months: {}, days: {} };
    const ops = stats.ops ||= {};
    const day = ops[dayOf(now)] ||= {};
    day[item.action] = (day[item.action] || 0) + 1;
    const cutoff = dayOf(now - KEEP_DAYS * 86400000);
    for (const key of Object.keys(ops)) if (key < cutoff) delete ops[key];
  }
  return item;
}

// 查询：filters {userId, action, category, q, from, to, ok, limit, before}
export function queryAudit(db, filters = {}) {
  const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
  const q = String(filters.q || '').toLowerCase();
  const list = [];
  for (let i = (db.audit || []).length - 1; i >= 0 && list.length < limit; i--) {
    const item = db.audit[i];
    if (filters.before && item.at >= filters.before) continue;
    if (filters.userId && item.userId !== filters.userId) continue;
    if (filters.action && item.action !== filters.action) continue;
    if (filters.category && categoryOf(item.action) !== filters.category) continue;
    if (filters.ok !== undefined && filters.ok !== '' && item.ok !== (filters.ok === true || filters.ok === 'true')) continue;
    if (filters.from && item.at < filters.from) continue;
    if (filters.to && item.at > filters.to) continue;
    if (q && !(item.target + ' ' + item.detail + ' ' + (item.email || '') + ' ' + item.action).toLowerCase().includes(q)) continue;
    list.push(item);
  }
  return list;
}

// 统计：按账号汇总最近 days 天各动作次数
export function summarize(db, { days = 30, userId = null, now = Date.now() } = {}) {
  const from = dayOf(now - (days - 1) * 86400000);
  const rows = [], timeline = {};
  for (const [id, stats] of Object.entries(db.stats || {})) {
    if (userId && id !== userId) continue;
    const byAction = {}, byCategory = {}; let total = 0;
    for (const [day, actions] of Object.entries(stats.ops || {})) {
      if (day < from) continue;
      for (const [action, n] of Object.entries(actions)) {
        byAction[action] = (byAction[action] || 0) + n; total += n;
        const cat = categoryOf(action); byCategory[cat] = (byCategory[cat] || 0) + n;
        timeline[day] = (timeline[day] || 0) + n;
      }
    }
    if (!total) continue;
    const audit = db.audit || [];
    let lastAt = null;
    for (let i = audit.length - 1; i >= 0; i--) if (audit[i].userId === id) { lastAt = audit[i].at; break; }
    rows.push({ userId: id, email: db.users?.[id]?.email || '（已删除）', total, byAction, byCategory, lastAt });
  }
  rows.sort((a, b) => b.total - a.total);
  const series = [];
  for (let i = days - 1; i >= 0; i--) { const day = dayOf(now - i * 86400000); series.push({ day, total: timeline[day] || 0 }); }
  return { users: rows, series };
}

const csvCell = value => {
  let s = String(value ?? '');
  const risky = /^[=+\-@]/.test(s); // 防止 Excel 把内容当公式执行
  if (risky) s = "'" + s;
  return /[",\n\r]/.test(s) || risky ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export function toCsv(entries) {
  const lines = ['时间,账号,动作,对象,详情,结果,IP'];
  for (const e of entries) lines.push([new Date(e.at).toISOString(), e.email || '', e.action, e.target, e.detail, e.ok ? '成功' : '失败', e.ip].map(csvCell).join(','));
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

// 仪表盘数据：按天/类别/模型/来源/动作/账号/小时汇总，供前端画图和导出。
// 明细来自 db.usage（模型调用与 Token）和 db.audit（失败数、小时分布）；按天的类别计数来自长期计数器 stats.ops。
export function dashboardData(db, { days = 30, userId = null, now = Date.now() } = {}) {
  days = Math.min(90, Math.max(1, Math.floor(days) || 30));
  const dayList = []; for (let i = days - 1; i >= 0; i--) dayList.push(dayOf(now - i * 86400000));
  const index = new Map(dayList.map((d, i) => [d, i]));
  const series = dayList.map(day => ({ day, call: 0, file: 0, delete: 0, auth: 0, admin: 0, guard: 0, other: 0, tokens: 0 }));
  const byAction = {}, users = {};
  for (const [id, stats] of Object.entries(db.stats || {})) {
    if (userId && id !== userId) continue;
    const row = users[id] ||= { userId: id, email: db.users?.[id]?.email || '（已删除）', total: 0, calls: 0, tokens: 0 };
    for (const [day, actions] of Object.entries(stats.ops || {})) {
      const i = index.get(day); if (i === undefined) continue;
      for (const [action, n] of Object.entries(actions)) { series[i][categoryOf(action)] += n; byAction[action] = (byAction[action] || 0) + n; row.total += n; }
    }
  }
  const byModel = {}, bySource = {}, hours = new Array(24).fill(0);
  const since = now - days * 86400000;
  let tokens = 0, calls = 0;
  for (const item of db.usage || []) {
    if (item.at < since || (userId && item.userId !== userId)) continue;
    const i = index.get(dayOf(item.at)); if (i === undefined) continue;
    const t = item.totalTokens ?? ((item.inputTokens || 0) + (item.outputTokens || 0));
    series[i].tokens += t; tokens += t; calls++;
    const m = byModel[item.model || '未知'] ||= { model: item.model || '未知', calls: 0, tokens: 0 }; m.calls++; m.tokens += t;
    bySource[item.source || 'web'] = (bySource[item.source || 'web'] || 0) + 1;
    hours[new Date(item.at).getHours()]++;
    const row = users[item.userId] ||= { userId: item.userId, email: db.users?.[item.userId]?.email || '（已删除）', total: 0, calls: 0, tokens: 0 };
    row.calls++; row.tokens += t;
  }
  let failures = 0;
  for (const item of db.audit || []) if (item.at >= since && !item.ok && (!userId || item.userId === userId)) failures++;
  const sum = key => series.reduce((n, d) => n + d[key], 0);
  return {
    days, from: dayList[0], to: dayList.at(-1), series,
    totals: { calls, tokens, fileOps: sum('file'), deletes: sum('delete'), failures, operations: series.reduce((n, d) => n + d.call + d.file + d.delete + d.auth + d.admin + d.guard + d.other, 0) },
    byModel: Object.values(byModel).sort((a, b) => b.tokens - a.tokens || b.calls - a.calls).slice(0, 12),
    bySource: Object.entries(bySource).map(([source, n]) => ({ source, calls: n })).sort((a, b) => b.calls - a.calls),
    byAction: Object.entries(byAction).map(([action, n]) => ({ action, count: n })).sort((a, b) => b.count - a.count).slice(0, 15),
    users: Object.values(users).filter(u => u.total || u.calls).sort((a, b) => (b.calls + b.total) - (a.calls + a.total)).slice(0, 20),
    hours
  };
}
