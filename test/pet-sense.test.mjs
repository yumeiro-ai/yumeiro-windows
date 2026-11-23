import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// 浏览器脚本（项目是 ESM，直接 require 会被当成模块）：用 Function 包一层，让它走 module.exports 分支
const mod = { exports: {} };
new Function('module', readFileSync(new URL('../public/pet-sense.js', import.meta.url), 'utf8'))(mod);
const { analyze, similarity, blend, decay, persona, bondLevel } = mod.exports;

test('桌宠读心：夸奖、感谢、笑声为正面，冲着她的夸奖带 pet', () => {
  assert.ok(analyze('谢谢你，太棒了！').v > 0.5);
  assert.equal(analyze('你真可爱').emotion, 'shy');
  assert.equal(analyze('哈哈哈哈笑死我了').emotion, 'laugh');
  assert.equal(analyze('你真棒').about, 'pet');
});

test('桌宠读心：骂她 → 负面且针对她；说自己的低落 → 负面但针对自己', () => {
  const blame = analyze('你怎么这么笨，什么破答案！');
  assert.ok(blame.v < -0.5); assert.equal(blame.about, 'pet'); assert.equal(blame.emotion, 'angry');
  const self = analyze('今天好累，有点难受');
  assert.ok(self.v < -0.3); assert.equal(self.about, 'self'); assert.equal(self.emotion, 'sad');
  assert.equal(analyze('这个不对', { afterAssistant: true }).about, 'pet');
});

test('桌宠读心：否定词、礼貌用语、反问句、代码粘贴不会被当成情绪', () => {
  assert.ok(analyze('我不累').v >= 0);
  assert.ok(analyze('这个效果不错').v > 0.3);
  assert.equal(analyze('麻烦你帮我看看滚动条的问题').v, 0);
  assert.equal(analyze('这样对不对？').v, 0);
  assert.equal(analyze('我错了，抱歉').v, 0);
  assert.ok(analyze('```js\nthrow new Error("wrong");\n```\n帮我看看').v > -0.2);
});

test('桌宠读心：emoji、[表情包] 文字、颜文字也能读出情绪', () => {
  assert.ok(analyze('收到😂😂').v > 0.4);
  assert.ok(analyze('好的😭').v < -0.3);
  assert.ok(analyze('[大哭]').v < -0.3);
  assert.ok(analyze('[发怒]').v < -0.4);
  assert.equal(analyze('[发怒]').about, 'pet');
  assert.ok(analyze('[呲牙][强]').v > 0.5);
  assert.ok(analyze('QAQ').v < -0.3);
  assert.ok(analyze('^_^').v > 0.3);
  assert.equal(analyze('卧槽').emotion, 'surprised');
});

test('桌宠读心：感叹号让负面更激动；空输入是中性', () => {
  assert.ok(analyze('你太差了！！！').a > analyze('你太差了').a);
  assert.deepEqual({ ...analyze('') }, { v: 0, a: 0.15, about: 'none', emotion: '', n: 0 });
});

test('桌宠读心：重问识别、对话气氛平滑与衰减', () => {
  assert.ok(similarity('帮我写一个冒泡排序', '帮我写一个冒泡排序吧') > 0.6);
  assert.ok(similarity('帮我写一个冒泡排序', '今天天气怎么样') < 0.2);
  let ctx = 0;
  ctx = blend(ctx, { v: -0.8, about: 'pet' }, 0);
  assert.ok(ctx < -0.35);
  const later = blend(ctx, { v: 0.6, about: 'pet' }, 1);
  assert.ok(later > ctx);                       // 连续夸奖会把气氛拉回来
  assert.ok(Math.abs(decay(-0.8, 10) - -0.4) < 1e-9);   // 10 分钟衰减一半
});

test('模型角色：按模型名认出哪一家；认不出的用它自己的名字；不被供应商前缀误导', () => {
  assert.equal(persona('cindy-1234/claude-sonnet-4', 'claude-sonnet-4').family, 'claude');
  assert.equal(persona('openai/gpt-4o', 'gpt-4o').name, 'GPT');
  assert.equal(persona('o3-mini', '').family, 'gpt');
  assert.equal(persona('qwen-max', 'Qwen Max').family, 'qwen');
  assert.equal(persona('proxy/deepseek-chat', 'DeepSeek Chat').family, 'deepseek');
  assert.equal(persona('openai-compatible/my-model', 'my-model').family, 'other', '供应商 slug 里带 openai 不算模型家族');
  const unknown = persona('x/my-private-model', 'My Private Model');
  assert.equal(unknown.name, 'My Private Model'); assert.notEqual(unknown.key, persona('x/other-model', 'Other Model').key, '不同的未知模型要有各自的关系计数');
  assert.equal(persona('a/claude-x', 'Claude X').key, persona('b/claude-y', 'Claude Y').key, '同一家族的不同型号共享默契');
  assert.ok(/^#[0-9a-f]{6}$/i.test(persona('gpt-4', '').color));
});

test('默契等级随一起完成的回答次数递增', () => {
  assert.deepEqual([0, 1, 5, 20, 50, 100, 500].map(bondLevel), [0, 1, 2, 3, 4, 5, 5]);
});
