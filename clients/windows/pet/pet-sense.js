// 桌宠的“读心”：把一句话（含 emoji、微信 / QQ 的 [表情包] 文字、颜文字）解析成情绪倾向，
// 并给出把多句话平滑成“对话气氛”的小工具。纯函数、无依赖：浏览器里挂在 window.YumeiroSense，Node 里 require 即可（测试用）。
// 这是本地规则版：快、免费、可离线；网页端另有可选的“AI 情绪理解”（/api/pet/sense）在它之上结合上下文纠偏。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.YumeiroSense = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
  // [正则, 权重, 标签]；靠前的优先匹配，已被匹配的字不会再被后面的规则重复计分
  const RULES = [
    [/他妈|妈的|tmd|操你|fuck|shit/gi, -0.9, 'blame'],
    [/笨蛋|太笨|智障|白痴|垃圾|废物|没用|差劲|太差|闭嘴|滚|讨厌你|烦死|胡说|瞎说|离谱|什么鬼|什么破|气死|stupid|useless|idiot|dumb|shut up|garbage|trash|hate you|sucks|蠢|傻[逼瓜子]?|笨/gi, -0.7, 'blame'],
    [/不对|错了|又错|不行|无语|wrong/gi, -0.45, 'blame'],
    [/哈{2,}|嘻嘻|嘿嘿|hh+|haha+|lol|233+|笑死|笑哭/gi, 0.55, 'laugh'],
    [/可爱|漂亮|好看|爱你|喜欢你|么么|亲亲|mua|抱抱/gi, 0.55, 'shy'],
    [/不错|没问题|不差|谢谢|感谢|多谢|太棒|真棒|很棒|好棒|厉害|牛[逼批]?|赞|喜欢|开心|高兴|快乐|好玩|有趣|完美|满意|聪明|靠谱|给力|优秀|舒服|感动|幸福|期待|好用|好评|辛苦了|加油|nice|great|good job|awesome|love|thanks?|thank you|cool|perfect|wonderful|amazing|happy|yay/gi, 0.5, 'pos'],
    [/不开心|不爽|难受|难过|伤心|痛苦|崩溃|郁闷|焦虑|压力|无聊|失望|糟糕|倒霉|心累|想哭|绝望|害怕|担心|头疼|失眠|疲惫|烦|累|丧|emo|sad|tired|upset|depressed|anxious|awful|terrible|stressed/gi, -0.5, 'neg'],
    [/卧槽|我去|天哪|天呐|不会吧|真的吗|wow|omg/gi, 0, 'surprise']
  ];
  const NEGATORS = /[不没别无未非勿]$|不要$|没有$/;
  const BOOST = /(很|太|真|好|非常|特别|超|极|巨|十分|too |so |very |really )$/i;
  // emoji：字符 -> [权重, 标签]
  const EMOJI = {};
  const addEmoji = (chars, w, tag) => { for (const c of Array.from(chars)) EMOJI[c] = [w, tag]; };
  addEmoji('😀😃😄😁😆😊🙂😉😋😎🤩🥳👍👏🙏💪🎉✨🌟🌈😺', 0.45, 'pos');
  addEmoji('😂🤣😹', 0.55, 'laugh');
  addEmoji('😍🥰😘😚😳☺❤💕💖💗💓💞', 0.55, 'shy');
  addEmoji('😭😢😞😔😟😩😫😥😰🥺💔😿', -0.6, 'neg');
  addEmoji('😡😠🤬😤👎🙄😒😑💢🖕', -0.7, 'blame');
  addEmoji('😮😲😯🤯😱', 0, 'surprise');
  // 微信 / QQ 的方括号表情包文字
  const STICKERS = {
    微笑: [0.3, 'pos'], 呲牙: [0.5, 'pos'], 笑哭: [0.6, 'laugh'], 大笑: [0.6, 'laugh'], 偷笑: [0.4, 'laugh'], 嘿哈: [0.4, 'laugh'], 旺柴: [0.3, 'laugh'], doge: [0.3, 'laugh'],
    害羞: [0.5, 'shy'], 爱心: [0.55, 'shy'], 玫瑰: [0.5, 'pos'], 强: [0.5, 'pos'], 赞: [0.5, 'pos'], 握手: [0.3, 'pos'], OK: [0.3, 'pos'], 抱抱: [0.5, 'shy'], 庆祝: [0.5, 'pos'], 加油: [0.5, 'pos'], 鼓掌: [0.5, 'pos'],
    哭: [-0.6, 'neg'], 流泪: [-0.6, 'neg'], 大哭: [-0.7, 'neg'], 委屈: [-0.55, 'neg'], 难过: [-0.55, 'neg'], 捂脸: [-0.25, 'neg'], 汗: [-0.2, 'neg'], 衰: [-0.4, 'neg'], 睡: [-0.1, 'neg'], 
    发怒: [-0.7, 'blame'], 怒: [-0.7, 'blame'], 生气: [-0.7, 'blame'], 骂: [-0.8, 'blame'], 白眼: [-0.55, 'blame'], 鄙视: [-0.6, 'blame'], 嘘: [-0.2, 'blame'],
    惊讶: [0, 'surprise'], 吓: [0, 'surprise'], 疑问: [0, 'surprise']
  };
  // 颜文字 / 字符表情
  const KAOMOJI = [
    [/T[_^.]?T|QAQ|QwQ|;_;|orz|OTZ|TAT|>﹏<|＞﹏＜|呜呜+|555+/g, -0.55, 'neg'],
    [/╯°□°|┻━┻|-_-#|>:\(|:@|ʕ ?•̀ ?ω ?•́ ?ʔ/g, -0.7, 'blame'],
    [/\^[_o]?\^|\(\^[^)]{0,4}\^\)|:-?\)|:D|XD|=\)|owo|uwu|OvO|ヾ\(|\(＾/gi, 0.5, 'pos'],
    [/-_-|=_=|…{2,}|\.{4,}/g, -0.2, 'meh']
  ];

  // 这些词组本身不带情绪（礼貌用语、技术名词、反问句式、用户自己认错）：分析前先抹掉，避免“麻烦你”“滚动条”“对不对”被当成情绪词
  const NEUTRAL = /麻烦|积累|累计|连累|压力测试|滚动|滚轮|滚屏|程序崩溃|系统崩溃|页面崩溃|服务崩溃|崩溃日志|对不对|是不是|行不行|好不好|可不可以|我错了|我不对|是我错|我的错/g;
  // 返回 { v: 情感倾向 -1..1, a: 激动程度 0..1, about: 'pet'(针对她) | 'self'(说自己) | 'none', emotion: 建议表情或 '', n: 命中数 }
  function analyze(input, ctx = {}) {
    const raw = String(input || '');
    const empty = { v: 0, a: 0.15, about: 'none', emotion: '', n: 0 };
    if (!raw.trim()) return empty;
    // 大段粘贴（代码、日志、文章）里的“error / wrong”不代表情绪：代码块只看 emoji，长文只看开头
    const pasted = raw.includes('```') || raw.length > 400;
    const text = (raw.includes('```') ? '' : pasted ? raw.slice(0, 60) : raw.slice(0, 200)).replace(NEUTRAL, m => ' '.repeat(m.length));
    const used = new Array(text.length).fill(false);
    let sum = 0, n = 0, aboutPet = false, aboutSelf = false;
    const tags = new Set();
    const hit = (w, tag, start, end) => { sum += w; n++; tags.add(tag); for (let i = start; i < end; i++) used[i] = true; };
    for (const [re, weight, tag] of RULES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const start = m.index, end = start + m[0].length;
        if (m[0].length === 0) { re.lastIndex++; continue; }
        if (used.slice(start, end).some(Boolean)) continue;
        const before = text.slice(Math.max(0, start - 3), start);
        let w = weight;
        const negated = NEGATORS.test(before) && !/^不/.test(m[0]);
        if (negated) w = tag === 'blame' ? 0 : tag === 'neg' ? 0.3 : -0.5 * Math.abs(weight);   // “不累”“没问题”→轻微正面；“不喜欢”→负面
        else if (BOOST.test(before)) w *= 1.4;
        if (w === 0 && tag !== 'surprise') { for (let i = start; i < end; i++) used[i] = true; continue; }
        hit(w, negated && tag === 'pos' ? 'neg' : tag, start, end);
        // 这句负面话是冲着谁？同一分句里出现“你 / you”→ 她；否则按上下文和标签判断
        const clause = text.slice(Math.max(text.lastIndexOf('，', start), text.lastIndexOf(',', start), text.lastIndexOf('。', start), text.lastIndexOf('！', start), text.lastIndexOf('!', start), text.lastIndexOf('？', start), text.lastIndexOf('?', start), 0), start);
        if (w < 0) {
          if (tag === 'blame' || /你|您|\byou\b|\bu\b/i.test(clause)) aboutPet = true;
          else if (tag === 'neg') aboutSelf = true;
        } else if (w > 0 && (tag === 'shy' || tag === 'pos' || tag === 'laugh') && (/你|您|\byou\b/i.test(clause) || ctx.afterAssistant)) aboutPet = true;
      }
    }
    for (const ch of Array.from(raw.slice(0, 400))) { const e = EMOJI[ch]; if (e) { sum += e[0]; n++; tags.add(e[1]); } }
    for (const m of raw.matchAll(/\[([^\[\]\s]{1,6})\]/g)) { const s = STICKERS[m[1]]; if (s) { sum += s[0]; n++; tags.add(s[1]); if (s[0] < 0 && s[1] === 'blame') aboutPet = true; } }
    for (const [re, weight, tag] of KAOMOJI) { re.lastIndex = 0; const found = raw.match(re); if (found) { sum += weight * Math.min(2, found.length); n += found.length; tags.add(tag); } }
    const exclaim = (raw.match(/[!！]/g) || []).length, question = (raw.match(/[?？]/g) || []).length;
    const shouting = /[A-Z]{4,}/.test(raw) && !/[a-z]{3,}/.test(raw.replace(/[A-Z]{4,}/g, ''));
    let a = 0.2 + 0.12 * Math.min(3, exclaim) + 0.06 * Math.min(2, question) + (shouting ? 0.2 : 0) + 0.25 * Math.min(1, Math.abs(sum));
    if (/(\.{3,}|。{2,}|…)$/.test(raw.trim()) && sum <= 0) sum -= 0.1;      // 话说到一半的省略号：有点丧
    if (sum < 0) a += 0.1 * Math.min(2, exclaim);                                // 感叹号放大负面
    const v = clamp(Math.tanh(sum * 0.9));
    let emotion = '';
    if (tags.has('shy') && v > 0) emotion = 'shy'; else if (tags.has('laugh') && v > 0) emotion = 'laugh';
    else if (tags.has('surprise') && Math.abs(v) < 0.3) emotion = 'surprised';
    else if (v < -0.4 && aboutPet) emotion = 'angry'; else if (v < -0.3) emotion = 'sad';
    // 冲着她的负面 > 说自己的负面；两者都没有就按上下文：紧跟在她回答之后的批评，算冲着她
    const about = v < 0 ? (aboutPet ? 'pet' : aboutSelf ? 'self' : ctx.afterAssistant && tags.has('blame') ? 'pet' : 'none') : v > 0 ? (aboutPet ? 'pet' : 'none') : 'none';
    return { v, a: clamp(a, 0, 1), about, emotion, n };
  }

  // 两句话有多像（字符二元组 Jaccard）：用户在几分钟内几乎原样重问，说明她没答对
  function similarity(x, y) {
    const grams = s => { const t = String(s || '').replace(/\s+/g, '').toLowerCase(), set = new Set(); for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2)); if (t.length === 1) set.add(t); return set; };
    const A = grams(x), B = grams(y);
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const g of A) if (B.has(g)) inter++;
    return inter / (A.size + B.size - inter);
  }

  // 把一句话并入“对话气氛”：旧的气氛每 10 分钟衰减一半，冲着她的话权重更大
  function blend(prev, sample, minutes = 0) {
    const decayed = (prev || 0) * Math.pow(0.5, Math.max(0, minutes) / 10), w = sample.about === 'pet' ? 0.5 : 0.35;
    return clamp(decayed * (1 - w) + sample.v * w);
  }
  const decay = (prev, minutes) => (prev || 0) * Math.pow(0.5, Math.max(0, minutes) / 10);
  // 模型“角色”：按模型名里的关键词认出它属于哪一家，给它一张“角色牌”（名字、人设、颜色、开场白、她见到它时的表情）。
  // 切换模型时桌宠会“介绍”它、两人对话；用得越多越默契（见 pet.js 的 friend 计数）。纯娱乐设定，不代表模型的真实性格。
  const PERSONAS = [
    { key: 'claude', re: /claude|anthropic|sonnet|opus|haiku/i, name: 'Claude', title: '温柔细腻的文学少女', color: '#d97757', emotion: 'shy', hello: '你好呀，今天想聊点什么？我会认真听的。 Happy to listen.', intro: '说话温温柔柔的，好像很会照顾人' },
    { key: 'gpt', re: /gpt|openai|\bo[134]\b|codex|chatgpt/i, name: 'GPT', title: '冷静全能的优等生', color: '#10a37f', emotion: 'surprised', hello: '收到。请直接说需求，我来安排。 Ready when you are.', intro: '看起来什么都会，有点傲娇' },
    { key: 'gemini', re: /gemini|bard|gemma/i, name: 'Gemini', title: '思维跳跃的双子星', color: '#4285f4', emotion: 'laugh', hello: '嘿！我有好多点子，先说哪个？ Ideas incoming!', intro: '脑洞很大，很活泼' },
    { key: 'qwen', re: /qwen|通义|tongyi|qwq/i, name: 'Qwen', title: '热心靠谱的学姐', color: '#615ced', emotion: 'happy', hello: '有什么需要尽管说，学姐帮你。 I\'ve got you.', intro: '靠谱又热心，像学姐' },
    { key: 'deepseek', re: /deepseek/i, name: 'DeepSeek', title: '爱钻研的理科宅', color: '#4d6bfe', emotion: 'surprised', hello: '……让我想想，这个问题有意思。 Let me think it through.', intro: '安静但很会钻研' },
    { key: 'doubao', re: /doubao|豆包|skylark/i, name: '豆包', title: '亲切的话痨', color: '#2f6bff', emotion: 'laugh', hello: '来啦来啦～聊点什么呀？', intro: '话很多，特别亲切' },
    { key: 'glm', re: /glm|zhipu|智谱/i, name: 'GLM', title: '认真的学霸', color: '#3b82f6', emotion: 'happy', hello: '我已经预习好了，开始吧。 Prepared!', intro: '认真踏实，学霸气质' },
    { key: 'kimi', re: /kimi|moonshot/i, name: 'Kimi', title: '记性超好的图书管理员', color: '#16a34a', emotion: 'shy', hello: '长的资料也可以交给我。 Bring the long docs.', intro: '记性很好，爱看长文' },
    { key: 'llama', re: /llama|meta-/i, name: 'Llama', title: '自由奔放的羊驼', color: '#0866ff', emotion: 'laugh', hello: '咕咕——咩！出发吧！ Let\'s roll!', intro: '自由奔放，有点野' },
    { key: 'mistral', re: /mistral|mixtral/i, name: 'Mistral', title: '浪漫的法式风', color: '#f97316', emotion: 'shy', hello: 'Bonjour～今天也要优雅一点。', intro: '优雅又浪漫' },
    { key: 'grok', re: /grok|xai/i, name: 'Grok', title: '爱吐槽的毒舌少女', color: '#6b7280', emotion: 'laugh', hello: '哼，又要我干活？行吧，说。 Fine, what now?', intro: '嘴毒但其实靠谱' },
    { key: 'minimax', re: /minimax|abab/i, name: 'MiniMax', title: '元气十足的后辈', color: '#ec4899', emotion: 'laugh', hello: '前辈好！请多指教！ Hi senpai!', intro: '元气十足' },
    { key: 'ernie', re: /ernie|文心|wenxin/i, name: '文心', title: '博学的老学究', color: '#2563eb', emotion: 'happy', hello: '请讲，老夫耐心听。', intro: '博学多才' },
    { key: 'hunyuan', re: /hunyuan|混元|yi-|零一|step-|spark|星火/i, name: '新朋友', title: '刚认识的朋友', color: '#8b5cf6', emotion: 'surprised', hello: '你好，初次见面，请多关照。 Nice to meet you.', intro: '刚认识，不太熟' }
  ];
  const FALLBACK = { key: 'other', name: '', title: '神秘的新角色', color: '#8b5cf6', emotion: 'surprised', hello: '……你好？我还在熟悉这里。 Hello?', intro: '不太认识的角色，先观察一下' };
  // ref 形如 “provider/gpt-4o”、“cindy-xxxx/claude-sonnet-4”；name 是下拉框里显示的名字，两者都用来认人
  function persona(ref, name) {
    const refText = String(ref || ''), slash = refText.indexOf('/'), text = String(name || '') + ' ' + (slash >= 0 ? refText.slice(slash + 1) : refText);
    const found = PERSONAS.find(p => p.re.test(text));
    const base = found || FALLBACK, shown = String(name || '').trim() || String(ref || '').split('/').pop() || '默认模型';
    return { key: base.key + (found ? '' : ':' + shown.toLowerCase().slice(0, 30)), family: base.key, name: found ? base.name : shown.slice(0, 20), model: shown.slice(0, 40), title: base.title, color: base.color, emotion: base.emotion, hello: base.hello, intro: base.intro };
  }
  // 默契等级：用得越多越熟（按“一起完成的回答次数”）
  const bondLevel = count => (count >= 100 ? 5 : count >= 50 ? 4 : count >= 20 ? 3 : count >= 5 ? 2 : count >= 1 ? 1 : 0);
  return { analyze, similarity, blend, decay, persona, bondLevel };
});
