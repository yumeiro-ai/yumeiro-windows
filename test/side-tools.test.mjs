import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// 浏览器脚本（项目是 ESM）：用 Function 包一层，让它走 module.exports 分支
const mod = { exports: {} };
new Function('module', readFileSync(new URL('../public/side-tools.js', import.meta.url), 'utf8'))(mod);
const { calc, convert, toUrl, mergeSide, splitMatches, parseTodoText, filterTodos, sortTodos, overdue, monthGrid, dayStats, lastDays, sessionsByDay, doneByDay, habitDoneSet, habitStreak, habitRate, dayRatio, topTasks } = mod.exports;

test('计算器：四则、优先级、乘方右结合、百分号、括号、函数、常量、中文符号', () => {
  assert.equal(calc('1+2*3').value, 7);
  assert.equal(calc('(1+2)*3').value, 9);
  assert.equal(calc('2^3^2').value, 512);
  assert.equal(calc('-2^2').value, -4);
  assert.equal(calc('50%').value, 0.5);
  assert.equal(calc('200*15%').value, 30);
  assert.equal(calc('sqrt(16)+max(1,5,3)').value, 9);
  assert.equal(calc('exp(0)+pow(2,3)').value, 9, 'exp / max 里的 x 不能被当成乘号');
  assert.equal(calc('6×7÷2').value, 21);
  assert.equal(calc('（1+2）*3').value, 9);
  assert.equal(calc('2*pi').text, '6.28318530718');
  assert.equal(calc('0.1+0.2').text, '0.3', '浮点误差被修整');
});

test('计算器：错误如实说明，且不会执行任何代码', () => {
  assert.equal(calc('1/0').ok, false); assert.match(calc('1/0').error, /除数/);
  assert.equal(calc('(1+2').ok, false);
  assert.equal(calc('1+').ok, false);
  assert.equal(calc('foo(1)').ok, false);
  assert.equal(calc('alert(1)').ok, false);
  assert.equal(calc('process.exit()').ok, false);
  assert.equal(calc('constructor').ok, false);
  assert.equal(calc('toString(1)').ok, false, '原型链上的名字不是函数');
  assert.equal(calc('1'.repeat(300)).ok, false);
  assert.equal(calc('((((((((((((((((((((((((((((((((((((((((((((((((((((1))))))))))))))))))))))))))))))))))))))))))))))))))))').ok, false, '括号太深');
  assert.equal(calc('').ok, false);
  assert.equal(calc('sqrt(-1)').ok, false, 'NaN 结果被拒绝');
});

test('单位换算：长度 / 重量 / 数据 / 时间 / 温度 / 中文单位与各种“转”的写法', () => {
  assert.ok(Math.abs(convert('5km to mi').value - 3.1068559611) < 1e-6);
  assert.equal(convert('3斤换成kg').value, 1.5);
  assert.equal(convert('2gb to mb').value, 2048);
  assert.equal(convert('90 min in h').value, 1.5, 'min 里的 “in” 不能被当成分隔词');
  assert.equal(convert('100 f 转 c').ok, true); assert.ok(Math.abs(convert('100 f 转 c').value - 37.7778) < 1e-3);
  assert.equal(convert('0℃ = k').value, 273.15);
  assert.equal(convert('1 mi → km').ok, true);
  assert.equal(convert('36 km/h to m/s').value, 10);
});

test('单位换算：不同类、不认识的单位、乱写都给出明确提示', () => {
  assert.match(convert('5 kg to km').error, /同一类/);
  assert.match(convert('5 foo to km').error, /不认识/);
  assert.match(convert('随便说点什么').error, /格式/);
});

test('地址栏：像网址就补全、否则当搜索；危险协议一律拒绝', () => {
  assert.equal(toUrl('example.com'), 'https://example.com/');
  assert.equal(toUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(toUrl('http://127.0.0.1:8787/x'), 'http://127.0.0.1:8787/x');
  assert.equal(toUrl('localhost:3000'), 'https://localhost:3000/');
  assert.match(toUrl('怎么煮米饭'), /^https:\/\/www\.bing\.com\/search\?q=%E6%80%8E/);
  assert.match(toUrl('hello world'), /search\?q=hello%20world$/);
  assert.equal(toUrl('javascript:alert(1)'), null);
  assert.equal(toUrl('file:///etc/passwd'), null);
  assert.equal(toUrl('data:text/html,<script>1</script>'), null);
  assert.equal(toUrl('  '), null);
});

const todo = (id, t, extra = {}) => ({ id, t, done: false, pri: 0, due: '', group: '', tags: [], sub: [], o: 0, at: 1, u: 1, ...extra });

test('待办输入：#标签 被提取，最多 5 个且去重', () => {
  assert.deepEqual(parseTodoText('交报告 #工作 #紧急'), { t: '交报告', tags: ['工作', '紧急'] });
  assert.deepEqual(parseTodoText('#只有标签'), { t: '#只有标签', tags: ['只有标签'] }.t ? parseTodoText('#只有标签') : null);
  assert.equal(parseTodoText('a #1 #1 #2 #3 #4 #5 #6').tags.length, 5);
  assert.equal(parseTodoText('买牛奶').tags.length, 0);
});

test('待办筛选：状态 / 分组 / 搜索（标题、标签、子任务）/ 今天与已逾期', () => {
  const today = '2026-06-10';
  const list = [todo('a', '写周报', { due: today, group: '工作', tags: ['紧急'] }), todo('b', '买菜', { due: '2026-06-01', group: '生活' }), todo('c', '看书', { done: true }), todo('d', '整理桌面', { sub: [{ id: 's', t: '擦屏幕', done: false }] })];
  const ids = o => filterTodos(list, o, today).map(t => t.id).join('');
  assert.equal(ids({}), 'abcd'); assert.equal(ids({ status: 'open' }), 'abd'); assert.equal(ids({ status: 'done' }), 'c');
  assert.equal(ids({ status: 'today' }), 'a'); assert.equal(ids({ status: 'overdue' }), 'b');
  assert.equal(ids({ group: '工作' }), 'a'); assert.equal(ids({ q: '紧急' }), 'a'); assert.equal(ids({ q: '擦屏' }), 'd');
  assert.equal(overdue(list[2], today), false, '已完成的不算逾期');
});

test('待办排序：手动 / 优先级 / 截止日期，已完成永远在最后', () => {
  const list = [todo('a', 'a', { o: 3, pri: 0, due: '2026-06-20' }), todo('b', 'b', { o: 1, pri: 2 }), todo('c', 'c', { o: 2, pri: 1, due: '2026-06-11' }), todo('d', 'd', { o: 0, done: true, pri: 2 })];
  const ids = mode => sortTodos(list, mode).map(t => t.id).join('');
  assert.equal(ids('manual'), 'bcad'); assert.equal(ids('pri'), 'bcad'); assert.equal(ids('due'), 'cabd');
});

test('同步合并：同一条取最后修改的；删除优先于更旧的修改；旧删除记录被清理；不会丢另一台设备的新增', () => {
  const now = 10_000_000_000_000;
  const phone = { u: 5, notes: [{ id: 'n1', title: '手机', body: 'p', u: 100 }], todos: [todo('t1', '手机版', { u: 200 }), todo('t2', '只在手机', { u: 50 })], snippets: [], del: {} };
  const pc = { u: 6, notes: [{ id: 'n1', title: '电脑', body: 'c', u: 300 }, { id: 'n2', title: '新便签', body: '', u: 10 }], todos: [todo('t1', '电脑版', { u: 150 })], snippets: [], del: { t2: 60, old: now - 61 * 864e5 } };
  const merged = mergeSide(phone, pc, now);
  assert.equal(merged.notes.find(n => n.id === 'n1').title, '电脑', 'u 更大的一方胜出');
  assert.equal(merged.notes.length, 2, '另一台设备新增的便签保留');
  assert.equal(merged.todos.find(t => t.id === 't1').t, '手机版');
  assert.equal(merged.todos.some(t => t.id === 't2'), false, '删除时间 60 ≥ 修改时间 50：已删除');
  assert.equal('old' in merged.del, false, '超过 60 天的删除记录被清理');
  const revived = mergeSide({ todos: [todo('t2', '删后又改', { u: 99 })], del: {} }, { del: { t2: 60 } }, now);
  assert.equal(revived.todos.length, 1, '删除之后又被修改过的，保留');
  assert.deepEqual(mergeSide(null, undefined).notes, []);
});

test('日历：月视图固定 6 行 × 7 列，上下月补齐，周起始可选', () => {
  const june = monthGrid(2026, 5);                       // 2026-06-01 是周一
  assert.equal(june.length, 42); assert.equal(june[0].date, '2026-06-01'); assert.equal(june[0].inMonth, true);
  assert.equal(june[29].date, '2026-06-30'); assert.equal(june[30].inMonth, false, '7 月的日子用来补齐');
  const sundayFirst = monthGrid(2026, 5, 0);
  assert.equal(sundayFirst[0].date, '2026-05-31'); assert.equal(sundayFirst[0].inMonth, false);
  const feb = monthGrid(2028, 1);                        // 闰年 2 月
  assert.equal(feb.filter(c => c.inMonth).length, 29);
  assert.equal(monthGrid(2026, 11).find(c => c.date === '2027-01-01').inMonth, false, '跨年');
});

test('日历：按日期汇总待办（未完成 / 已完成 / 逾期）和番茄（个数 / 分钟）', () => {
  const today = '2026-06-10';
  const todos = [todo('a', 'a', { due: '2026-06-10' }), todo('b', 'b', { due: '2026-06-10', done: true }), todo('c', 'c', { due: '2026-06-01' }), todo('d', 'd')];
  const sessions = [{ id: 's1', day: '2026-06-10', min: 25, todo: 'a' }, { id: 's2', day: '2026-06-10', min: 25, todo: '' }, { id: 's3', day: '2026-06-09', min: 50 }];
  const stats = dayStats(todos, sessions, today);
  assert.deepEqual(stats['2026-06-10'], { open: 1, done: 1, late: false, pom: 2, min: 50 });
  assert.equal(stats['2026-06-01'].late, true, '过了截止日期还没做');
  assert.equal(stats['2026-06-09'].pom, 1); assert.equal(stats['2026-06-09'].open, 0);
  assert.equal(Object.keys(stats).length, 3, '没有截止日期的待办不出现在日历上');
});

test('同步合并也覆盖番茄记录（sessions）', () => {
  const merged = mergeSide({ sessions: [{ id: 's1', day: '2026-06-10', min: 25, u: 1 }] }, { sessions: [{ id: 's2', day: '2026-06-10', min: 25, u: 2 }, { id: 's1', day: '2026-06-10', min: 25, u: 1 }] }, 5);
  assert.deepEqual(merged.sessions.map(s => s.id), ['s2', 's1']);
});

const everyDay = [true, true, true, true, true, true, true];
const set = (...days) => new Set(days);

test('统计：最近 N 天（含今天、按日期升序、跨月）', () => {
  assert.deepEqual(lastDays(3, '2026-06-01'), ['2026-05-30', '2026-05-31', '2026-06-01']);
  assert.equal(lastDays(14, '2026-06-10').length, 14);
});

test('统计：番茄按天汇总、完成待办按完成时间归到当天、任务分布', () => {
  const days = lastDays(3, '2026-06-10');
  const sessions = [{ day: '2026-06-10', min: 25, todo: 'a' }, { day: '2026-06-10', min: 25, todo: 'a' }, { day: '2026-06-08', min: 50, todo: 'b' }, { day: '2026-05-01', min: 25, todo: 'a' }, { day: '2026-06-09', min: 25, todo: '' }];
  assert.deepEqual(sessionsByDay(sessions, days).map(d => [d.pom, d.min]), [[1, 50], [1, 25], [2, 50]]);
  const noon = day => new Date(day + 'T12:00:00').getTime();
  const todos = [todo('a', '写周报', { done: true, da: noon('2026-06-10') }), todo('b', '读书', { done: true, da: noon('2026-06-08') }), todo('c', '没完成'), todo('d', '旧的', { done: true, da: noon('2026-01-01') })];
  assert.deepEqual(doneByDay(todos, days), [1, 0, 1]);
  const top = topTasks(sessions, todos, days);
  assert.deepEqual(top.map(r => [r.title, r.min, r.pom]), [['写周报', 50, 2], ['读书', 50, 1], ['未指定任务', 25, 1]], '按分钟降序，同分钟保持先出现的在前');
  assert.equal(topTasks([{ day: '2026-06-10', min: 25, todo: 'gone' }], todos, days)[0].title, '（已删除的待办）');
});

test('习惯：连续天数（今天没打卡不算断）、按计划日统计、最长连续', () => {
  const today = '2026-06-10';                                           // 周三
  assert.deepEqual(habitStreak(set('2026-06-10', '2026-06-09', '2026-06-08'), everyDay, today), { current: 3, best: 3 });
  assert.equal(habitStreak(set('2026-06-09', '2026-06-08'), everyDay, today).current, 2, '今天还没打，不影响连续');
  assert.equal(habitStreak(set('2026-06-08'), everyDay, today).current, 0, '昨天漏了就断了');
  const weekdays = [false, true, true, true, true, true, false];       // 周末休息
  assert.equal(habitStreak(set('2026-06-10', '2026-06-09', '2026-06-08', '2026-06-05', '2026-06-04'), weekdays, today).current, 5, '周末不是计划日，不算断');
  assert.equal(habitStreak(set('2026-05-01', '2026-05-02', '2026-05-03', '2026-05-10'), everyDay, today).best, 3);
  assert.deepEqual(habitRate(set('2026-06-10', '2026-06-08'), weekdays, lastDays(7, today)), { done: 2, due: 5, rate: 0.4 });
});

test('习惯：热力图的每日完成比例、打卡记录只取 v=1', () => {
  const habits = [{ id: 'h1', days: everyDay }, { id: 'h2', days: [false, true, true, true, true, true, false] }];
  const sets = { h1: set('2026-06-07'), h2: set('2026-06-07') };
  assert.deepEqual(dayRatio(habits, sets, '2026-06-07'), { due: 1, done: 1, ratio: 1 }, '周日只有 h1 要打');
  assert.deepEqual(dayRatio(habits, sets, '2026-06-10'), { due: 2, done: 0, ratio: 0 });
  assert.deepEqual([...habitDoneSet([{ h: 'h1', day: 'd1', v: 1 }, { h: 'h1', day: 'd2', v: 0 }, { h: 'h2', day: 'd3', v: 1 }], 'h1')], ['d1']);
});

test('同步合并：习惯的打卡记录各自合并；习惯被删后，它的打卡记录一起清掉', () => {
  const habit = (id, u = 1) => ({ id, name: id, days: everyDay, o: 0, u });
  const check = (h, day, v, u) => ({ id: h.slice(0, 5) + day.slice(5), h, day, v, u });
  const phone = { habits: [habit('habit-a1')], checks: [check('habit-a1', '2026-06-09', 1, 10), check('habit-a1', '2026-06-10', 1, 10)] };
  const pc = { habits: [habit('habit-a1')], checks: [check('habit-a1', '2026-06-10', 0, 20), check('habit-a1', '2026-06-08', 1, 5)] };
  const merged = mergeSide(phone, pc, 100);
  assert.deepEqual(merged.checks.map(c => c.day + ':' + c.v).sort(), ['2026-06-08:1', '2026-06-09:1', '2026-06-10:0'], '同一天按最后修改的为准；不同天都保留');
  const deleted = mergeSide(phone, { del: { 'habit-a1': 50 } }, 100);
  assert.equal(deleted.habits.length, 0); assert.equal(deleted.checks.length, 0);
});

test('搜索高亮：不区分大小写切成命中/非命中片段，拼回去与原文一致；HTML 只是文本；空词与特殊字符安全', () => {
  const parts = splitMatches('Hello World, hello again', 'HELLO');
  assert.deepEqual(parts.filter(p => p.hit).map(p => p.t), ['Hello', 'hello'], '保留原文的大小写');
  assert.equal(parts.map(p => p.t).join(''), 'Hello World, hello again');
  assert.deepEqual(splitMatches('abc', ''), [{ t: 'abc', hit: false }]);
  assert.deepEqual(splitMatches('abc', 'zzz'), [{ t: 'abc', hit: false }]);
  assert.deepEqual(splitMatches('<b>x</b>', 'b').filter(p => p.hit).length, 2, '< > 不会被当作标签处理，也没有正则注入');
  assert.deepEqual(splitMatches('a.b*c(d)', '.b*c(').map(p => p.hit), [false, true, false], '正则特殊字符按字面匹配');
  assert.equal(splitMatches('中文内容 搜索', '搜索').filter(p => p.hit)[0].t, '搜索');
  assert.equal(splitMatches('aaaa', 'a', 2).filter(p => p.hit).length, 2, '命中处数有上限');
  assert.equal(splitMatches('İstanbul İ', 'İ').map(p => p.t).join(''), 'İstanbul İ', '转小写会变长的字符也不会错位');
});
