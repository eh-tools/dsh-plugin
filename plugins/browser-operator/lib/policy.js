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
