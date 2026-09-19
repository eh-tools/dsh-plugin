/**
 * Jev 决策回路的**纯策略层** —— 零 import、零 I/O。
 *
 * 这一层的全部意义是可在离线环境里断言:快照 → 索引元素表 → Jev questions,
 * 以及 Jev 响应 → 校验过的动作。浏览器、网络、凭证都不在这里。
 *
 * @module dsh-browser-operator/policy
 */

/** 闭合的动作空间。策略层只会发出这 8 个操作之一,也只会接受这 8 个之一。 */
export const ACTION_SPACE = Object.freeze([
  'CLICK',
  'TYPE_TEXT',
  'SELECT',
  'SCROLL_UP',
  'SCROLL_DOWN',
  'WAIT',
  'DONE',
  'BLOCKED',
]);

/** 闭合的终止状态。 */
export const STATUS = Object.freeze([
  'done',
  'stuck',
  'blocked',
  'max_steps',
  'timeout',
  'error',
  'uncertain',
  'text_unavailable',
  // 与 `stuck` **分开**:`stuck` 是 Jev 自报「再走也没用」,这个是回路自己观测到
  // 「同一个操作 + 同一个目标,页面一点没变」。混用会让台账读不出到底是哪一种。
  'no_progress',
]);

/** 哪些 kind 支持哪些操作。`CLICK` 对 kind 无要求(由 eligible 决定)。 */
const KIND_FOR_OPERATION = {
  TYPE_TEXT: 'typeable',
  SELECT: 'selectable',
};

/**
 * 把快照转成**索引元素表** —— 表给模型看,索引给执行器用。
 *
 * 停用的元素照旧出现在表里(模型需要知道它存在),但不进任何 eligible 列表。
 *
 * @param {{ elements?: object[] }} snapshot
 * @returns {{ lines: string[], byIndex: Map<number, object>, eligible: Record<string, number[]> }}
 */
export function buildElementTable(snapshot) {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const lines = [];
  const byIndex = new Map();
  const eligible = { CLICK: [], TYPE_TEXT: [], SELECT: [] };

  for (const element of elements) {
    byIndex.set(element.index, element);
    lines.push(renderLine(element));
    if (element.disabled === true) continue;
    if (element.kind === 'clickable') eligible.CLICK.push(element.index);
    for (const [operation, kind] of Object.entries(KIND_FOR_OPERATION)) {
      if (element.kind === kind) eligible[operation].push(element.index);
    }
  }

  return { lines, byIndex, eligible };
}

/** 一行:`[2] combobox "Where from?" · San Francisco`;无值时不带 `· ` 段。 */
function renderLine(element) {
  const label = `[${element.index}] ${element.role} "${element.name}"`;
  const value = typeof element.value === 'string' ? element.value : '';
  return value === '' ? label : `${label} · ${value}`;
}

/**
 * criteria 里一个候选的描述:`role "name"`。
 *
 * **不带 `[N] ` 前缀** —— criteria 的键就是那个序号,再写一遍是纯重复。
 * **不带 ` · value`** —— 值在 state 的元素表里,模型照样看得到;criteria 只负责说清
 * 「哪些序号是合法的」。上限页面(200 元素)实测这两处省约 1.5 KB(全载荷 4.8%)。
 *
 * 元素表仍然是**唯一**的完整描述(`renderLine`),两处不能各写一份口径:
 * 序号是「同一选择器 + 同一可见性判定数出来的第 n 个」,渲染分叉迟早会错位。
 */
function renderCandidate(element) {
  return `${element.role} "${element.name}"`;
}

/** 元素表的模型可见文本。 */
export function renderElementTable(table) {
  return table.lines.join('\n');
}

/** 交给 Jev 的 state。键名是代码用的,模型只看得到内容。 */
export function buildState({ goal, snapshot, table, steps }) {
  return {
    goal,
    url: snapshot?.url ?? '',
    title: snapshot?.title ?? '',
    visibleText: typeof snapshot?.text === 'string' ? snapshot.text : '',
    elementTable: renderElementTable(table),
    steps: Array.isArray(steps) ? steps : [],
  };
}

/**
 * 8 个操作的说明文案。
 *
 * `@typesafe-ai/sdk` 的 `ChoiceCriteria` 是**「标签 → 描述」的对象**(不是数组),
 * 所以 choice 的 criteria 就得长这样:键是模型要原样回给我们的标签。
 */
const OPERATION_HINTS = Object.freeze({
  CLICK: 'Press one clickable element.',
  TYPE_TEXT: 'Fill one typeable element with a verbatim fragment of the goal.',
  SELECT: 'Choose an option in one selectable element.',
  SCROLL_UP: 'Scroll the page up. Makes no selection.',
  SCROLL_DOWN: 'Scroll the page down. Makes no selection.',
  WAIT: 'Wait for the page to settle. Makes no selection.',
  DONE: 'The goal is already met; stop.',
  BLOCKED: 'A human is required (login, SSO, captcha); stop.',
});

/**
 * 一次请求里同时问完 operation 与所有**当前真有可选目标**的操作 —— 两个决策,一次网络往返。
 *
 * ⚠ 形状必须与 SDK 的 `Question` 联合一致(见 `@typesafe-ai/sdk/dist/index.d.mts`):
 * 每个问题都带 `type`;`choice` 的 `criteria` 是「标签 → 描述」的对象;`noul` 不带
 * criteria。**标签就是元素序号的十进制写法** —— `parseDecision` 靠它把回答映射回索引。
 *
 * ⚠ **criteria 会为空的 choice 一律不发**(实测:服务端对空 criteria 的 choice 回 400
 * `Choice question must have at least one choice`)。一个操作在此页没有可选目标时,它那一问
 * 整个消失 —— 不补占位项、也不发空对象:模型因此**没有机会**挑一个不存在的目标。
 *
 * 同一条原则**也适用于 `operation` 那一问**:没有合法目标的操作(CLICK / TYPE_TEXT / SELECT)
 * 不再出现在它的 criteria 里 —— 留着就是请模型挑一个必然失败的答案。`goal_met` / `stuck`
 * 永远有内容;`operation` 也永远非空(SCROLL_UP / SCROLL_DOWN / WAIT / DONE / BLOCKED
 * 五个都不需要目标)。
 *
 * 文本那一问(`type_text_value`)的标签是**候选列表里的下标**(`'0'` / `'1'` …),
 * 描述才是片段本身 —— 与元素目标同一套十进制标签口径,于是 `parseDecision` /
 * `validateDecision` 的映射逻辑不必分叉,而一个乱答的标签也没有任何机会变成被输入的文本。
 * 候选为空时它同样不发;回路在**校验之前**就把 `TYPE_TEXT` 收在 `text_unavailable`。
 *
 * @param {{ goal: string, table: object, typeTextCandidates?: string[] }} options
 * @returns {Record<string, object>} 只含本次真的问得起的问题
 */
export function buildQuestions({ goal, table, typeTextCandidates: candidates = [] }) {
  const criteriaFor = (indexes) => {
    const criteria = {};
    for (const index of indexes) {
      criteria[String(index)] = renderCandidate(table.byIndex.get(index));
    }
    return criteria;
  };
  /** 文本候选:键是**候选下标**的十进制写法,值是片段本身(逐字,不加工)。 */
  const candidateCriteria = (fragments) => {
    const criteria = {};
    fragments.forEach((fragment, position) => {
      criteria[String(position)] = fragment;
    });
    return criteria;
  };
  // 只摆出**本页真的能执行**的操作 —— 与下面 `askTarget` 是同一条原则。一个没有合法目标的
  // 操作出现在选项里,就是请模型挑一个必然失败的答案:实测踩到过(页面已无可填元素,模型仍选
  // TYPE_TEXT,目标那一问根本没发,校验连拒三次,整次调用收在 `error`)。
  //
  // ⚠ `TYPE_TEXT` 的**文本候选为空**不在此列:那种情况有专门的终止信号 `text_unavailable`,
  // 它会把调用方指去 `browser_fill`(ADR-0009 决策点 6)。挡掉它反而丢了一条可行动的信息。
  const operationCriteria = {};
  for (const operation of ACTION_SPACE) {
    const targeted = TARGET_FOR_OPERATION[operation];
    if (targeted !== undefined && table.eligible[operation].length === 0) continue;
    operationCriteria[operation] = OPERATION_HINTS[operation];
  }

  const questions = {
    operation: {
      type: 'choice',
      instructions:
        `Choose the single next operation that best advances this goal: ${goal}\n` +
        'Only operations that are legal on the current page are offered. ' +
        'CLICK presses a clickable element, TYPE_TEXT fills a typeable one, SELECT picks an ' +
        'option, SCROLL/WAIT make no selection, DONE means the goal is already met, and ' +
        'BLOCKED means a human is required (login, SSO, captcha).',
      criteria: operationCriteria,
    },
  };

  /**
   * 加一道「选目标」的 choice —— **criteria 为空就整问不加**。
   *
   * 服务端拒收空 criteria 的 choice(400),而没有可选目标的操作本来也不该被问:问了只会
   * 让模型选到一个不存在的目标,再由 `validateDecision` 拒掉、白花一轮。
   */
  const askTarget = (key, instructions, criteria) => {
    if (Object.keys(criteria).length === 0) return;
    questions[key] = { type: 'choice', instructions, criteria };
  };

  askTarget(
    'click_target',
    'Which element should be clicked? Answer with the element number. ' +
      'Only meaningful when operation is CLICK.',
    criteriaFor(table.eligible.CLICK),
  );
  askTarget(
    'type_text_target',
    'Which element should receive text? Answer with the element number. ' +
      'Only meaningful when operation is TYPE_TEXT.',
    criteriaFor(table.eligible.TYPE_TEXT),
  );
  askTarget(
    'type_text_value',
    'Which of these verbatim fragments should be typed into the target element? ' +
      'Answer with the fragment number. The fragments come from the goal and from the ' +
      'target field label; pick exactly one and it is typed unchanged. ' +
      'Only meaningful when operation is TYPE_TEXT.',
    candidateCriteria(candidates),
  );
  askTarget(
    'select_target',
    'Which element should be selected? Answer with the element number. ' +
      'Only meaningful when operation is SELECT.',
    criteriaFor(table.eligible.SELECT),
  );

  questions.goal_met = {
    type: 'noul',
    instructions: `The goal is already satisfied by the page as it stands: ${goal}`,
  };
  questions.stuck = {
    type: 'noul',
    instructions:
      'No offered operation can make further progress on this goal, and repeating the ' +
      'last operation would not help.',
  };

  return questions;
}

/** 需要目标的三个操作与它们各自读取的字段名。 */
const TARGET_FOR_OPERATION = {
  CLICK: 'clickTarget',
  TYPE_TEXT: 'typeTextTarget',
  SELECT: 'selectTarget',
};

/** 从 answers 里安全取一个 choice 值;缺了返回 undefined。 */
function choiceOf(answers, key) {
  const value = answers?.[key]?.choice;
  return value === undefined ? undefined : value;
}

/**
 * 从 answers 里安全取一个概率。`noul` 是概率原语的字段名;`choice` 类回答把
 * 概率放在 `confidence` 上,两处都要认。都缺时返回 0 —— 缺概率不该把回路憋死。
 */
function probabilityOf(answers, key) {
  const answer = answers?.[key];
  const value = typeof answer?.noul === 'number' ? answer.noul : answer?.confidence;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 元素目标的回答是 criteria 的**标签**(字符串),而标签就是元素序号的十进制写法。
 * 不是纯数字的标签一律当作「没给目标」返回 undefined —— 由 validateDecision 拒绝。
 */
function indexOfLabel(label) {
  return typeof label === 'string' && /^\d+$/.test(label) ? Number(label) : undefined;
}

/**
 * 解析一次 Jev 响应。形状不对就**抛** —— 宁可停下,也不要拿半个决策去点页面。
 * @param {object} response `systemOne` 的返回值
 */
export function parseDecision(response) {
  const answers = response?.answers;
  if (answers === null || typeof answers !== 'object') {
    throw new Error('browser-operator: Jev 响应里没有 answers');
  }
  const operation = choiceOf(answers, 'operation');
  if (!ACTION_SPACE.includes(operation)) {
    throw new Error(`browser-operator: Jev 给出了动作空间外的 operation: ${String(operation)}`);
  }
  return {
    operation,
    clickTarget: indexOfLabel(choiceOf(answers, 'click_target')),
    typeTextTarget: indexOfLabel(choiceOf(answers, 'type_text_target')),
    // 文本那一问的标签是**候选下标**,与元素目标同一套十进制映射。
    typeTextValue: indexOfLabel(choiceOf(answers, 'type_text_value')),
    selectTarget: indexOfLabel(choiceOf(answers, 'select_target')),
    goalMet: probabilityOf(answers, 'goal_met'),
    stuck: probabilityOf(answers, 'stuck'),
    confidence: probabilityOf(answers, 'operation'),
  };
}

/**
 * 执行前校验:操作合法、目标在本次提供的白名单里、且当前真的可用。
 * 这是「模型输出永远不直接变成选择器 / 坐标 / JS」的那道闸。
 *
 * `TYPE_TEXT` 还要过第二道:选中的文本下标必须落在**本次真的问过的那份候选**里 ——
 * 越界或没答一律拒绝,绝不回落到 `candidates[0]`(那正是把「Jev 选」偷换成
 * 「代码猜第一个词」的地方)。通过时把**逐字片段**交回给回路,回路不再自己挑。
 *
 * @param {object} options.candidates 本次问过 Jev 的文本候选列表,顺序即标签
 * @returns `{ ok: true, targetIndex: number|null, text?: string }`
 *   或 `{ ok: false, reason: string }`
 */
export function validateDecision(decision, table, { candidates = [] } = {}) {
  const field = TARGET_FOR_OPERATION[decision.operation];
  if (field === undefined) return { ok: true, targetIndex: null };

  const targetIndex = decision[field];
  const allowed = table.eligible[decision.operation];
  if (!Number.isInteger(targetIndex)) {
    // 目标那一问在 **criteria 为空时整问不发**(见 buildQuestions)。那种情况下模型根本
    // 没有机会给出目标,报「拿到 undefined」会让人以为模型乱答 —— 实测就这么被误导过一轮。
    // 两种成因分开报,否则这条诊断等于没有。
    if (allowed.length === 0) {
      return {
        ok: false,
        reason:
          `${decision.operation} 在本页没有可选目标 —— 目标那一问没有发出,` +
          `回答里不可能带目标(拿到 ${String(targetIndex)})`,
      };
    }
    return {
      ok: false,
      reason: `${decision.operation} 需要一个整数目标,拿到 ${String(targetIndex)}`,
    };
  }

  if (!allowed.includes(targetIndex)) {
    const element = table.byIndex.get(targetIndex);
    if (element === undefined) {
      return { ok: false, reason: `目标 ${targetIndex} 不在本次观察到的元素里` };
    }
    return {
      ok: false,
      reason: `目标 ${targetIndex} 不可用(停用或不是 ${decision.operation} 支持的类型)`,
    };
  }

  if (decision.operation === 'TYPE_TEXT') {
    const chosen = validateTypeTextValue(decision.typeTextValue, candidates);
    if (!chosen.ok) return chosen;
    return { ok: true, targetIndex, text: chosen.text };
  }

  return { ok: true, targetIndex };
}

/**
 * `TYPE_TEXT` 的第二道闸:选中下标 → 逐字片段。
 *
 * **没答**(`undefined`,标签不是十进制下标时会解析成它)与越界(包括候选整个为空)
 * 走同一条路:一律拒绝,由回路重新观察;重试额度用尽即 `status: 'error'`。这里**没有**
 * 「取候选第一个顶上」的回落 —— 那等于把「Jev 选」偷换成「代码猜第一个词」,正是本
 * 工具不生成文本的立场要排除的事。
 */
function validateTypeTextValue(value, candidates) {
  if (!Number.isInteger(value) || value < 0 || value >= candidates.length) {
    return {
      ok: false,
      reason:
        `browser-operator: TYPE_TEXT 的文本下标 ${String(value)} ` +
        `不在本次提供的 ${candidates.length} 个候选里(候选来自 goal 与目标字段标签的逐字片段)`,
    };
  }
  return { ok: true, text: candidates[value] };
}

/** 逐字候选片段的最小长度。2 个字符的英文虚词(of / to / on / in)当候选没有意义。 */
export const MIN_CANDIDATE_CHARS = 3;
/** 逐字候选的数量上限,挡住超长 goal 把 questions 撑爆。 */
export const MAX_CANDIDATES = 20;

/**
 * 从 goal 里切出**逐字片段**候选。
 *
 * 这是本插件对 `TYPE_TEXT` 的全部策略:文本必须原样来自 goal,不是生成的。
 * 调用方把候选交给 Jev 选一个;候选为空时该步只能停下(`text_unavailable`)。
 *
 * 切分口径:按空白与常见标点断词,保留出现顺序,去重,丢弃过短片段。
 *
 * @param {string|undefined} goal
 * @returns {string[]}
 */
export function textCandidates(goal) {
  if (typeof goal !== 'string' || goal.trim() === '') return [];
  const seen = new Set();
  const candidates = [];
  for (const raw of goal.split(/[\s,;，、。:：!?！？()（）"'`]+/u)) {
    const piece = raw.replace(/[.]+$/u, '');
    if (piece.length < MIN_CANDIDATE_CHARS) continue;
    if (seen.has(piece)) continue;
    seen.add(piece);
    candidates.push(piece);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

/**
 * `TYPE_TEXT` 的**完整**候选列表 = `textCandidates(goal)` + 目标字段标签切出的片段。
 *
 * 后半截就是 spec 说的「按页面字段旁的标签 / 占位符切出的片段」:元素名(`name`)在
 * `snapshot.js` 里已经是 `aria-label` → `placeholder` → `innerText` → `value` 的
 * 首选结果,所以读它就等于读了页面上的标签 / 占位符。仍取**逐字**口径(只切词、不改写),
 * 并按出现顺序去重、封顶 —— 标签在候选里排在 goal 之后,是「补足」而不是「顶掉」。
 *
 * 调用方把这份列表**同时**交给 `buildQuestions`(生成 criteria)与 `validateDecision`
 * (校验选中的下标),三处必须是同一份,否则校验会对着另一份清单放行。
 *
 * ⚠ `element` 传哪一个是调用方的事,但要与它随后校验、随后输入的那一份一致:
 * `lib/loop.js` 在请求发出**之前**就定下候选,所以它先用第一个能切出标签的可填字段
 * 做代表 —— 目标字段是 Jev 在同一个请求里才选的,请求体不可能等它。
 *
 * @param {{ goal?: string, element?: object }} options
 * @returns {string[]}
 */
export function typeTextCandidates({ goal, element } = {}) {
  const seen = new Set();
  const candidates = [];
  for (const source of [goal, element?.name]) {
    for (const fragment of textCandidates(source)) {
      if (seen.has(fragment)) continue;
      seen.add(fragment);
      candidates.push(fragment);
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }
  }
  return candidates;
}
