// 多智能体协作编排：纯逻辑，真正的“发言”由调用方注入的 call() 完成（提示词智能体、Claude Code / Codex / Pi 等都可以）。
//   pipeline   接力：按顺序执行，后一位看到前面所有人的产出，最后一位的产出就是结果
//   roundtable 圆桌：多人轮流讨论若干轮，最后由最后一位综合出结论
//   supervisor 主管调度：第一位是主管，每一步决定“让谁做什么”或“结束并给出最终答案”
export const MODES = ['pipeline', 'roundtable', 'supervisor'];
export const LIMITS = { participants: 6, rounds: 4, steps: 16, contextChars: 24000, stepChars: 60000 };

export function validatePlan({ mode, participants, rounds }) {
  if (!MODES.includes(mode)) throw new Error('协作方式必须是 pipeline / roundtable / supervisor');
  if (!Array.isArray(participants) || participants.length < 1 || participants.length > LIMITS.participants) throw new Error(`参与者需要 1–${LIMITS.participants} 位`);
  if (mode !== 'pipeline' && participants.length < 2) throw new Error('这种协作方式至少需要 2 位参与者');
  const labels = new Set();
  for (const item of participants) {
    if (!item.label || labels.has(item.label)) throw new Error('每位参与者都要有不重复的名称');
    labels.add(item.label);
  }
  if (mode === 'roundtable' && (!Number.isInteger(rounds) || rounds < 1 || rounds > LIMITS.rounds)) throw new Error(`讨论轮数需要 1–${LIMITS.rounds}`);
}

const clip = (text, max) => text.length > max ? '…（前文已省略）\n' + text.slice(text.length - max) : text;
const render = transcript => clip(transcript.map(item => `【${item.label}】\n${item.text}`).join('\n\n'), LIMITS.contextChars);
const roleLine = p => `你的名称：${p.label}${p.role ? `\n你的职责：${p.role}` : ''}`;

export function buildPrompt({ mode, task, participant, transcript, round, rounds, last, roster, instruction }) {
  const history = transcript.length ? `\n\n目前的协作记录：\n${render(transcript)}` : '';
  if (mode === 'pipeline') {
    return `你正在参与一个多智能体接力任务。\n\n总任务：${task}\n${roleLine(participant)}${history}\n\n请完成属于你的部分，直接给出你的产出（不要复述任务）。${last ? '你是最后一位，你的产出就是最终结果。' : '后面的成员会基于你的产出继续。'}`;
  }
  if (mode === 'roundtable') {
    if (last === 'summary') return `你正在参与一个多智能体圆桌讨论，现在需要你综合所有发言。\n\n议题：${task}\n${roleLine(participant)}${history}\n\n请给出最终结论和可执行的方案，指出仍存在的分歧或风险。`;
    return `你正在参与一个多智能体圆桌讨论（第 ${round}/${rounds} 轮）。\n\n议题：${task}\n${roleLine(participant)}${history}\n\n请从你的职责出发发表看法：补充新信息、指出他人的问题或表示同意并说明理由。保持简洁，不要重复已有观点。`;
  }
  // supervisor 下的工人
  return `你是一个多智能体团队里的成员，主管给你分配了工作。\n\n总任务：${task}\n${roleLine(participant)}\n\n主管的指示：${instruction}${history}\n\n请完成指示的工作并直接给出产出。`;
}

function supervisorPrompt({ task, supervisor, workers, transcript, remaining }) {
  const roster = workers.map(w => `- ${w.label}${w.role ? '：' + w.role : ''}`).join('\n');
  return `你是多智能体团队的主管。你自己不直接干活，而是把工作分配给成员，直到任务完成。\n\n总任务：${task}\n${roleLine(supervisor)}\n\n可分配的成员：\n${roster}\n${transcript.length ? `\n目前的协作记录：\n${render(transcript)}\n` : ''}\n你最多还能安排 ${remaining} 次工作。只输出一个 JSON 对象，不要其他文字：\n- 继续分配：{"next":"成员名称","instruction":"给他的具体指示"}\n- 任务已完成：{"next":"FINISH","final":"面向用户的最终答案"}`;
}

// 容错解析主管的 JSON（可能被包在代码块或夹杂文字里）
export function parseDecision(text) {
  const candidates = [text, ...(text.match(/```(?:json)?\s*([\s\S]*?)```/g) || []).map(block => block.replace(/```(?:json)?|```/g, '')), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      if (value && typeof value.next === 'string') return { next: value.next.trim(), instruction: String(value.instruction || ''), final: String(value.final || '') };
    } catch { /* 试下一个 */ }
  }
  return null;
}

export async function runCollaboration({ task, mode, participants, rounds = 2, maxSteps = 8, call, emit = () => {}, signal }) {
  validatePlan({ mode, participants, rounds });
  if (!task || !String(task).trim()) throw new Error('请填写任务');
  maxSteps = Math.min(Math.max(1, maxSteps), LIMITS.steps);
  const transcript = [], steps = [];
  let status = 'completed';

  async function speak(participant, prompt, extra = {}) {
    if (signal?.aborted) throw Object.assign(new Error('已停止'), { aborted: true });
    const index = steps.length;
    emit({ type: 'step_start', index, label: participant.label, ...extra });
    const result = await call({ participant, prompt, index, signal, onDelta: text => emit({ type: 'delta', index, text }) });
    const text = String(result.text ?? '').slice(0, LIMITS.stepChars);
    steps.push({ label: participant.label, text, usage: result.usage || null, ...extra });
    emit({ type: 'step_end', index, label: participant.label, text, usage: result.usage || null });
    return text;
  }
  const remember = (participant, text) => transcript.push({ label: participant.label, text });

  let final = '';
  try {
    if (mode === 'pipeline') {
      for (const [i, participant] of participants.entries()) {
        const text = await speak(participant, buildPrompt({ mode, task, participant, transcript, last: i === participants.length - 1 }), { round: 1 });
        remember(participant, text); final = text;
      }
    } else if (mode === 'roundtable') {
      if (participants.length * rounds + 1 > LIMITS.steps + 8) throw new Error('参与者与轮数过多');
      for (let round = 1; round <= rounds; round++) {
        for (const participant of participants) {
          const text = await speak(participant, buildPrompt({ mode, task, participant, transcript, round, rounds }), { round });
          remember(participant, text);
        }
      }
      const closer = participants[participants.length - 1];
      final = await speak(closer, buildPrompt({ mode, task, participant: closer, transcript, last: 'summary' }), { round: rounds + 1, summary: true });
    } else {
      const [supervisor, ...workers] = participants;
      let used = 0, lastWorkerText = '';
      while (true) {
        const remaining = maxSteps - used;
        if (remaining <= 0) { status = 'step_limit'; final = lastWorkerText || '已达到步数上限，未能得到最终答案。'; break; }
        let raw = await speak(supervisor, supervisorPrompt({ task, supervisor, workers, transcript, remaining }), { supervisor: true });
        let decision = parseDecision(raw);
        if (!decision) { // 再给一次机会：只要求格式
          raw = await speak(supervisor, supervisorPrompt({ task, supervisor, workers, transcript, remaining }) + '\n\n注意：上一次的输出不是合法 JSON。请只输出 JSON 对象。', { supervisor: true, retry: true });
          decision = parseDecision(raw);
        }
        if (!decision) { status = 'bad_decision'; final = raw; break; }
        if (decision.next.toUpperCase() === 'FINISH') { final = decision.final || lastWorkerText || raw; break; }
        const worker = workers.find(item => item.label === decision.next);
        if (!worker) { remember(supervisor, `（主管指定了不存在的成员“${decision.next}”，请从名单中选择。）`); used++; continue; }
        remember(supervisor, `→ 分配给 ${worker.label}：${decision.instruction}`);
        const text = await speak(worker, buildPrompt({ mode, task, participant: worker, transcript, instruction: decision.instruction }), { assignedBy: supervisor.label });
        remember(worker, text); lastWorkerText = text; used++;
      }
    }
  } catch (error) {
    if (!error.aborted && !signal?.aborted) throw Object.assign(error, { steps, partial: final });
    status = 'stopped';
    final = final || steps.at(-1)?.text || '';
  }
  emit({ type: 'done', status, final });
  return { status, final, steps };
}

// ---------- 产品经理带队：用户只和产品经理说话，产品经理按每位成员的身份和擅长分配任务 ----------
export const PM_LIMITS = { members: 12, rounds: 6, parallel: 4 };
const clipText = (text, max) => text.length > max ? '…（更早的记录已省略）\n' + text.slice(text.length - max) : text;
export const renderTranscript = items => clipText(items.map(item => `【${item.label}】\n${item.text}`).join('\n\n'), LIMITS.contextChars);
export const rosterLine = m => `- ${m.label}${m.role ? `（身份：${m.role}）` : ''}｜擅长：${m.strengths || '通用'}${m.modelName ? `｜模型：${m.modelName}` : ''}`;

// 容错解析产品经理的 JSON：{say, assign:[{to,task}]} 或 {say, final}
export function parsePmDecision(text) {
  const raw = String(text || '');
  const candidates = [raw, ...(raw.match(/```(?:json)?\s*([\s\S]*?)```/g) || []).map(b => b.replace(/```(?:json)?|```/g, '')), raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    try {
      const v = JSON.parse(candidate.trim());
      if (!v || typeof v !== 'object') continue;
      const assign = Array.isArray(v.assign) ? v.assign.map(a => ({ to: String(a?.to || '').trim(), task: String(a?.task || '').trim() })).filter(a => a.to && a.task) : [];
      const final = v.final === undefined || v.final === null ? '' : String(v.final);
      if (assign.length || final.trim()) return { say: String(v.say || '').trim(), assign, final };
    } catch { /* 试下一个 */ }
  }
  return null;
}

export function pmPrompt({ pm, members, history, remaining, forceFinal }) {
  return `你是团队的产品经理（名称：${pm.label}），在群里辅助用户。你自己不做具体产出，而是根据每位成员的身份和擅长，把任务拆开分配给最合适的人，最后把成员的成果整合成给用户的答复。\n\n团队成员：\n${members.map(rosterLine).join('\n')}\n\n群聊记录：\n${history}\n\n` +
    (forceFinal ? '现在不能再分配任务了，请基于已有成果给用户最终答复。只输出 JSON：{"say":"","final":"答复内容"}'
      : `请只输出一个 JSON 对象（不要多余文字），二选一：\n1) 分配任务：{"say":"一句话告诉用户你打算怎么分工、为什么选这些人","assign":[{"to":"成员名称","task":"具体要做什么、交付什么"}]}。互相独立的任务可以同时分给多人（一次最多 ${PM_LIMITS.parallel} 人）。\n2) 答复或追问：{"say":"","final":"给用户的答复；信息不够时在这里向用户提问"}\n选人要看擅长：写代码给擅长代码的，推理分析给擅长推理的，写文案给擅长文字的。简单问题可直接 final。最多还能分配 ${remaining} 轮。`);
}
export function workerPrompt({ pm, member, task, history }) {
  return `你是团队成员「${member.label}」。${member.role ? `你的身份：${member.role}。` : ''}${member.strengths ? `你擅长：${member.strengths}。` : ''}\n产品经理（${pm.label}）分配给你的任务：\n${task}\n\n群聊记录：\n${history}\n\n请直接给出交付内容，不要复述任务。`;
}

// pm / members：{label, role, strengths, modelName?, ...} 由调用方注入真正的发言函数 call({participant, prompt, onDelta, signal}) → {text}
// emit：turn_start{label} / delta{label,text} / turn_end{label,text}。history：此前的群聊记录 [{label,text}]
export async function runPmTeam({ message, history = [], pm, members, call, emit = () => {}, signal, maxRounds = 4 }) {
  if (!members.length) throw new Error('团队里还没有成员');
  maxRounds = Math.min(Math.max(1, maxRounds), PM_LIMITS.rounds);
  const log = [...history, { label: '用户', text: message }];
  const byLabel = new Map(members.map(m => [m.label, m]));
  const abortCheck = () => { if (signal?.aborted) throw Object.assign(new Error('已停止'), { aborted: true }); };
  const say = (label, text) => { emit({ type: 'turn_start', label }); emit({ type: 'delta', label, text }); emit({ type: 'turn_end', label, text }); log.push({ label, text }); };
  const decide = async (forceFinal, remaining) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      abortCheck();
      const out = await call({ participant: pm, prompt: pmPrompt({ pm, members, history: renderTranscript(log), remaining, forceFinal }) + (attempt ? '\n\n注意：上一次的输出不是合法 JSON，请只输出 JSON 对象。' : ''), onDelta: () => {}, signal });
      if (out.aborted) throw Object.assign(new Error('已停止'), { aborted: true });
      const decision = parsePmDecision(out.text);
      if (decision) return decision;
      if (attempt && String(out.text).trim()) return { say: '', assign: [], final: String(out.text).trim() }; // 实在不是 JSON：把原文当答复
    }
    return { say: '', assign: [], final: '（产品经理没有给出有效的答复）' };
  };
  let status = 'completed';
  for (let round = 1; ; round++) {
    const forceFinal = round > maxRounds;
    const decision = await decide(forceFinal, maxRounds - round + 1);
    if (decision.say && (decision.assign.length || decision.final)) say(pm.label, decision.say);
    if (forceFinal || !decision.assign.length) { if (decision.final.trim()) say(pm.label, decision.final); else if (!decision.say) say(pm.label, '（没有可汇报的内容）'); if (forceFinal && decision.assign.length) status = 'round_limit'; break; }
    const jobs = [], unknown = [], seen = new Set();
    for (const a of decision.assign.slice(0, PM_LIMITS.parallel)) {
      const member = byLabel.get(a.to);
      if (!member) unknown.push(a.to); else if (!seen.has(a.to)) { seen.add(a.to); jobs.push({ member, task: a.task }); }
    }
    if (unknown.length) log.push({ label: pm.label, text: `（我点了不存在的成员：${unknown.join('、')}，需从名单中选择。）` });
    const snapshot = renderTranscript(log);
    // 一位成员出错（限流、网络、额度）不拖垮整轮：记成“失败”，让产品经理知道并决定怎么办
    const results = await Promise.all(jobs.map(async ({ member, task }) => {
      abortCheck();
      emit({ type: 'turn_start', label: member.label, task });
      try {
        const out = await call({ participant: member, prompt: workerPrompt({ pm, member, task, history: snapshot }), onDelta: text => emit({ type: 'delta', label: member.label, text }), signal });
        emit({ type: 'turn_end', label: member.label, text: out.text, partial: Boolean(out.aborted) });
        return { label: member.label, text: String(out.text || '').slice(0, LIMITS.stepChars), aborted: Boolean(out.aborted) };
      } catch (error) {
        if (error.aborted || signal?.aborted) throw error;
        const text = '（执行失败：' + String(error.message || error).slice(0, 200) + '）';
        emit({ type: 'delta', label: member.label, text }); emit({ type: 'turn_end', label: member.label, text, failed: true });
        return { label: member.label, text };
      }
    }));
    for (const r of results) log.push({ label: r.label, text: r.text });
    if (results.some(r => r.aborted)) throw Object.assign(new Error('已停止'), { aborted: true });
  }
  emit({ type: 'done', status });
  return { status };
}
