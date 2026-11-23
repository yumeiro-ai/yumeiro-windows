import test from 'node:test';
import assert from 'node:assert/strict';
import { runCollaboration, parseDecision, validatePlan } from '../collab.mjs';

const people = names => names.map(label => ({ label, role: label + '的职责' }));

test('pipeline：后一位看到前面所有产出，最后一位的产出是结果', async () => {
  const prompts = [];
  const result = await runCollaboration({
    task: '写一个函数', mode: 'pipeline', participants: people(['规划', '实现', '审查']),
    call: async ({ participant, prompt }) => { prompts.push(prompt); return { text: participant.label + '完成' }; }
  });
  assert.equal(result.final, '审查完成');
  assert.deepEqual(result.steps.map(s => s.label), ['规划', '实现', '审查']);
  assert.ok(!prompts[0].includes('目前的协作记录'));
  assert.ok(prompts[2].includes('【规划】') && prompts[2].includes('【实现】'));
  assert.ok(prompts[2].includes('最终结果'));
});

test('roundtable：轮流发言 N 轮，最后一位综合', async () => {
  const events = [];
  const result = await runCollaboration({
    task: '选型', mode: 'roundtable', rounds: 2, participants: people(['甲', '乙']),
    emit: e => events.push(e.type + (e.label ? ':' + e.label : '')),
    call: async ({ participant, prompt }) => ({ text: prompt.includes('综合所有发言') ? '结论' : participant.label + '观点', usage: { totalTokens: 3 } })
  });
  assert.deepEqual(result.steps.map(s => s.label), ['甲', '乙', '甲', '乙', '乙']);
  assert.equal(result.final, '结论');
  assert.equal(result.steps.at(-1).summary, true);
  assert.equal(events.at(-1), 'done');
  assert.equal(events.filter(e => e.startsWith('step_start')).length, 5);
});

test('supervisor：主管分配 → 成员执行 → 主管 FINISH', async () => {
  const script = [
    '```json\n{"next":"程序员","instruction":"写代码"}\n```',
    '好的，{"next":"测试","instruction":"测一下"} 就这样',
    '{"next":"FINISH","final":"全部完成"}'
  ];
  let supervisorCalls = 0;
  const result = await runCollaboration({
    task: '做个功能', mode: 'supervisor', participants: [{ label: '主管' }, { label: '程序员', role: '写代码' }, { label: '测试', role: '测试' }],
    call: async ({ participant, prompt }) => {
      if (participant.label === '主管') return { text: script[supervisorCalls++] };
      return { text: participant.label + '做完了：' + (prompt.match(/主管的指示：(.*)/)?.[1] || '') };
    }
  });
  assert.equal(result.final, '全部完成');
  assert.deepEqual(result.steps.map(s => s.label), ['主管', '程序员', '主管', '测试', '主管']);
  assert.equal(result.steps[1].text, '程序员做完了：写代码');
  assert.equal(result.status, 'completed');
});

test('supervisor：非法 JSON 重试一次；仍失败则以原文结束；点名不存在的成员会被提醒；步数上限', async () => {
  let n = 0;
  const bad = await runCollaboration({ task: 't', mode: 'supervisor', participants: [{ label: 'A' }, { label: 'B' }], call: async () => ({ text: '我不会输出 JSON ' + (++n) }) });
  assert.equal(bad.status, 'bad_decision');
  assert.equal(n, 2);
  assert.match(bad.final, /不会输出 JSON 2/);

  const calls = [];
  const loop = await runCollaboration({
    task: 't', mode: 'supervisor', maxSteps: 3, participants: [{ label: 'A' }, { label: 'B' }],
    call: async ({ participant, prompt }) => { calls.push(participant.label); return { text: participant.label === 'A' ? '{"next":"B","instruction":"干"}' : 'B 的产出' }; }
  });
  assert.equal(loop.status, 'step_limit');
  assert.equal(loop.final, 'B 的产出');

  let k = 0;
  const wrong = await runCollaboration({
    task: 't', mode: 'supervisor', participants: [{ label: 'A' }, { label: 'B' }],
    call: async ({ prompt }) => ({ text: k++ === 0 ? '{"next":"不存在","instruction":"x"}' : '{"next":"FINISH","final":"ok"}' })
  });
  assert.equal(wrong.final, 'ok');
});

test('停止：signal 中止后返回已完成的部分，状态为 stopped', async () => {
  const controller = new AbortController();
  const result = await runCollaboration({
    task: 't', mode: 'pipeline', participants: people(['一', '二', '三']), signal: controller.signal,
    call: async ({ participant }) => { if (participant.label === '二') controller.abort(); return { text: participant.label + '的产出' }; }
  });
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.steps.map(s => s.label), ['一', '二']);
  assert.equal(result.final, '二的产出');
});

test('执行失败会抛出并带上已完成的步骤；参数校验', async () => {
  await assert.rejects(runCollaboration({ task: 't', mode: 'pipeline', participants: people(['一', '二']), call: async ({ participant }) => { if (participant.label === '二') throw new Error('模型挂了'); return { text: 'ok' }; } }),
    error => error.message === '模型挂了' && error.steps.length === 1);
  assert.throws(() => validatePlan({ mode: 'roundtable', participants: people(['a']), rounds: 1 }), /至少/);
  assert.throws(() => validatePlan({ mode: 'pipeline', participants: [{ label: 'a' }, { label: 'a' }] }), /不重复/);
  assert.throws(() => validatePlan({ mode: 'roundtable', participants: people(['a', 'b']), rounds: 9 }), /轮数/);
  assert.throws(() => validatePlan({ mode: 'x', participants: people(['a']) }), /协作方式/);
  await assert.rejects(runCollaboration({ task: ' ', mode: 'pipeline', participants: people(['a']), call: async () => ({ text: '' }) }), /任务/);
  assert.equal(parseDecision('没有 json'), null);
  assert.equal(parseDecision('{"next":"X"}').next, 'X');
});
