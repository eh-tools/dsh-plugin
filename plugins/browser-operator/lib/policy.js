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
 * 一次请求里同时问完 operation 与所有兼容 target —— 两个决策,一次网络往返。
 *
 * ⚠ 形状必须与 SDK 的 `Question` 联合一致(见 `@typesafe-ai/sdk/dist/index.d.mts`):
 * 每个问题都带 `type`;`choice` 的 `criteria` 是「标签 → 描述」的对象;`noul` 不带
 * criteria。**标签就是元素序号的十进制写法** —— `parseDecision` 靠它把回答映射回索引。
 *
 * @param {{ goal: string, table: object }} options
 */
export function buildQuestions({ goal, table }) {
  const criteriaFor = (indexes) => {
    const criteria = {};
    for (const index of indexes) {
      criteria[String(index)] = renderLine(table.byIndex.get(index));
    }
    return criteria;
  };
  const operationCriteria = {};
  for (const operation of ACTION_SPACE) operationCriteria[operation] = OPERATION_HINTS[operation];

  return {
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
    click_target: {
      type: 'choice',
      instructions:
        'Which element should be clicked? Answer with the element number. ' +
        'Only meaningful when operation is CLICK.',
      criteria: criteriaFor(table.eligible.CLICK),
    },
    type_text_target: {
      type: 'choice',
      instructions:
        'Which element should receive text? Answer with the element number. ' +
        'Only meaningful when operation is TYPE_TEXT.',
      criteria: criteriaFor(table.eligible.TYPE_TEXT),
    },
    select_target: {
      type: 'choice',
      instructions:
        'Which element should be selected? Answer with the element number. ' +
        'Only meaningful when operation is SELECT.',
      criteria: criteriaFor(table.eligible.SELECT),
    },
    goal_met: {
      type: 'noul',
      instructions: `The goal is already satisfied by the page as it stands: ${goal}`,
    },
    stuck: {
      type: 'noul',
      instructions:
        'No offered operation can make further progress on this goal, and repeating the ' +
        'last operation would not help.',
    },
  };
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
 * @returns `{ ok: true, targetIndex: number|null }` 或 `{ ok: false, reason: string }`
 */
export function validateDecision(decision, table) {
  const field = TARGET_FOR_OPERATION[decision.operation];
  if (field === undefined) return { ok: true, targetIndex: null };

  const targetIndex = decision[field];
  if (!Number.isInteger(targetIndex)) {
    return {
      ok: false,
      reason: `${decision.operation} 需要一个整数目标,拿到 ${String(targetIndex)}`,
    };
  }

  const allowed = table.eligible[decision.operation];
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

  return { ok: true, targetIndex };
}

/** 逐字候选片段的最小长度。2 个字符的英文虚词(of / to / on / in)当候选没有意义。 */
const MIN_CANDIDATE_CHARS = 3;
/** 逐字候选的数量上限,挡住超长 goal 把 questions 撑爆。 */
const MAX_CANDIDATES = 20;

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
