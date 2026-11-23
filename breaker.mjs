// 熔断器（纯逻辑，不碰网络和磁盘，方便测试）。
//  · Breaker      按“键”（例如 某个模型）统计连续失败：连续失败达到阈值就“断开”一段时间，期间直接拒绝；
//                 到点后进入“试探”状态，只放少量请求过去，成功就恢复，失败就再断开（冷却时间翻倍，有上限）。
//  · RateGuard    按成员限速：滑动窗口内请求太多，只断开这一个人一小段时间（滥用熔断）。
// 默认值：连续 5 次失败断开 60 秒；单人每分钟最多 30 次请求。
export const DEFAULTS = { failureThreshold: 5, openSeconds: 60, maxOpenSeconds: 600, halfOpenProbes: 1, userRatePerMinute: 30, userOpenSeconds: 60 };

export function normalizeBreakerConfig(input = {}) {
  const int = (value, fallback, min, max) => { const n = Math.floor(Number(value)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
  return {
    enabled: input.enabled !== false,
    failureThreshold: int(input.failureThreshold, DEFAULTS.failureThreshold, 1, 100),
    openSeconds: int(input.openSeconds, DEFAULTS.openSeconds, 5, 3600),
    maxOpenSeconds: int(input.maxOpenSeconds, DEFAULTS.maxOpenSeconds, 5, 86400),
    halfOpenProbes: int(input.halfOpenProbes, DEFAULTS.halfOpenProbes, 1, 10),
    userRatePerMinute: int(input.userRatePerMinute, DEFAULTS.userRatePerMinute, 0, 6000), // 0 = 不限
    userOpenSeconds: int(input.userOpenSeconds, DEFAULTS.userOpenSeconds, 5, 3600),
    dailyCostLimit: Math.max(0, Number(input.dailyCostLimit) || 0), // 0 = 不限
    monthlyCostLimit: Math.max(0, Number(input.monthlyCostLimit) || 0),
  };
}

export class Breaker {
  constructor(config = {}, now = () => Date.now()) { this.config = normalizeBreakerConfig(config); this.now = now; this.items = new Map(); }
  setConfig(config) { this.config = normalizeBreakerConfig(config); }
  #item(key) { let item = this.items.get(key); if (!item) { item = { state: 'closed', failures: 0, openedAt: 0, openMs: 0, probes: 0, trips: 0, lastReason: '', manual: false, totalFailures: 0, totalSuccesses: 0 }; this.items.set(key, item); } return item; }
  // 能不能放行。返回 { ok:true, probe } 或 { ok:false, retryAfterMs, reason }
  allow(key) {
    if (!this.config.enabled) return { ok: true, probe: false };
    const item = this.#item(key), now = this.now();
    if (item.state === 'closed') return { ok: true, probe: false };
    if (item.state === 'open') {
      const left = item.openedAt + item.openMs - now;
      if (item.manual || left > 0) return { ok: false, retryAfterMs: item.manual ? 0 : left, reason: item.lastReason, manual: item.manual };
      item.state = 'half'; item.probes = 0; // 冷却结束：进入试探
    }
    if (item.probes >= this.config.halfOpenProbes) return { ok: false, retryAfterMs: 1000, reason: '正在试探恢复，请稍后' };
    item.probes++; return { ok: true, probe: true };
  }
  success(key) {
    const item = this.#item(key); item.totalSuccesses++;
    if (item.state === 'half' || item.state === 'closed') { item.state = 'closed'; item.failures = 0; item.probes = 0; item.openMs = 0; item.manual = false; }
  }
  failure(key, reason = '') {
    if (!this.config.enabled) return;
    const item = this.#item(key); item.totalFailures++;
    if (item.state === 'open') return; // 已经断开，期间的失败不再累加
    if (item.state === 'half') return this.#open(item, reason || item.lastReason, Math.min(this.config.maxOpenSeconds * 1000, Math.max(item.openMs, this.config.openSeconds * 1000) * 2));
    item.failures++; item.lastReason = String(reason).slice(0, 200);
    if (item.failures >= this.config.failureThreshold) this.#open(item, item.lastReason, this.config.openSeconds * 1000);
  }
  #open(item, reason, ms) { item.state = 'open'; item.openedAt = this.now(); item.openMs = ms; item.probes = 0; item.trips++; item.lastReason = String(reason || '').slice(0, 200); item.manual = false; }
  // 这次请求既不算成功也不算失败（例如用户中途取消、本地出错）：把占用的试探名额还回去，免得一直卡在“试探中”
  release(key) { const item = this.items.get(key); if (item && item.state === 'half' && item.probes > 0) item.probes--; }
  // 管理员手动熔断：一直断开，直到手动恢复
  trip(key, reason = '管理员手动熔断') { const item = this.#item(key); item.state = 'open'; item.manual = true; item.openedAt = this.now(); item.openMs = 0; item.trips++; item.lastReason = reason; }
  reset(key) { this.items.delete(key); }
  snapshot() {
    const now = this.now();
    return [...this.items.entries()].map(([key, item]) => ({ key, state: item.state, failures: item.failures, trips: item.trips, manual: item.manual, reason: item.lastReason, retryAfterMs: item.state === 'open' && !item.manual ? Math.max(0, item.openedAt + item.openMs - now) : 0, totalFailures: item.totalFailures, totalSuccesses: item.totalSuccesses }));
  }
}

// 单人限速：滑动窗口计数，超过上限就把这个人断开一小段时间
export class RateGuard {
  constructor(config = {}, now = () => Date.now()) { this.config = normalizeBreakerConfig(config); this.now = now; this.hits = new Map(); this.blocked = new Map(); }
  setConfig(config) { this.config = normalizeBreakerConfig(config); }
  check(userId) {
    const limit = this.config.userRatePerMinute;
    if (!this.config.enabled || !limit || !userId) return { ok: true };
    const now = this.now(), until = this.blocked.get(userId);
    if (until && until > now) return { ok: false, retryAfterMs: until - now };
    if (until) this.blocked.delete(userId);
    const list = (this.hits.get(userId) || []).filter(t => t > now - 60000); list.push(now); this.hits.set(userId, list);
    if (list.length > limit) { this.blocked.set(userId, now + this.config.userOpenSeconds * 1000); this.hits.delete(userId); return { ok: false, retryAfterMs: this.config.userOpenSeconds * 1000, tripped: true }; }
    return { ok: true };
  }
  reset(userId) { this.blocked.delete(userId); this.hits.delete(userId); }
  snapshot() { const now = this.now(); return [...this.blocked.entries()].filter(([, until]) => until > now).map(([userId, until]) => ({ userId, retryAfterMs: until - now })); }
}

// 哪些上游状态算“对方不健康”：限流、服务端错误、凭据被拒。400 / 404 / 422 这类是请求本身的问题，不算。
export const isProviderFailure = status => status === 429 || status === 401 || status === 403 || status >= 500;
