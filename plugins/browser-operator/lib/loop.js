/**
 * Jev 决策回路的**控制流**。
 *
 * `observe` / `decide` / `execute` / `now` 全部注入,所以这个文件不 import 任何
 * I/O,回路的全部行为都能离线断言(见 tests/policy.test.mjs)。
 *
 * @module dsh-browser-operator/loop
 */

import {
  buildElementTable,
  buildQuestions,
  buildState,
  parseDecision,
  typeTextCandidates,
  validateDecision,
} from './policy.js';

/** operation 的置信度低于这个值就算「低置信度」。 */
const LOW_CONFIDENCE = 0.35;
/** 连续这么多步低置信度就停。 */
const LOW_CONFIDENCE_RUN = 3;
/** 一次动作的校验失败最多重试这么多轮(每轮重新观察)。 */
const MAX_VALIDATION_RETRIES = 2;
/** goal_met / stuck 达到这个概率就停。 */
const STOP_PROBABILITY = 0.8;
/**
 * `text_unavailable` 的文案。spec(ADR-0009 决策点 6)要求它**显式**把调用方指去
 * `browser_fill` 单步工具 —— 「凭空生成文本」这条路本工具是**有意**不走的。
 */
const NO_TEXT =
  '这个目标与目标字段标签里都没有可用的逐字文本片段,无法确定该输入什么。' +
  '需要填入凭空生成的文本时,请改用 browser_fill 单步工具。';

/**
 * 该不该停。**纯函数**,顺序即优先级:预算 > 步数 > 低置信度。
 *
 * `attempts` 数的是**观察 → 决策**的轮次,不是成功执行的步数 —— 校验失败后的
 * 重新观察同样消耗一个单位(ADR-0009 决策点 6),否则一个持续越界的目标可以把
 * 回路拖成无界重试。
 *
 * @returns `{ stop: true, status }` 或 `{ stop: false }`
 */
export function evaluateStop({
  attempts,
  elapsedMs,
  maxSteps,
  budgetMs,
  consecutiveLowConfidence,
}) {
  if (elapsedMs >= budgetMs) return { stop: true, status: 'timeout' };
  if (attempts >= maxSteps) return { stop: true, status: 'max_steps' };
  if (consecutiveLowConfidence >= LOW_CONFIDENCE_RUN) return { stop: true, status: 'uncertain' };
  return { stop: false };
}

/**
 * 跑一次目标级回路。
 *
 * @param {object} options
 * @param {string} options.goal
 * @param {number} options.maxSteps
 * @param {number} options.budgetMs
 * @param {() => number} options.now
 * @param {() => Promise<object>} options.observe
 * @param {(request: { goal: string, state: object, questions: object }) => Promise<object>} options.decide
 * @param {(action: { operation: string, targetIndex: number|null, text: string|undefined, snapshot: object, table: object }) => Promise<void>} options.execute
 * @returns {Promise<{ status: string, steps: object[], goalMet: number, elapsedMs: number, error?: string }>}
 */
export async function runLoop({ goal, maxSteps, budgetMs, now, observe, decide, execute }) {
  const startedAt = now();
  const steps = [];
  let attempts = 0;
  let consecutiveLowConfidence = 0;
  let goalMet = 0;

  /**
   * 记一步。**每个被接受的决策都记**,包括终止的那一步(DONE / 高概率 goal_met /
   * stuck / BLOCKED)—— 所以 steps 是「决策过什么」的完整台账,不只是「执行过什么」。
   * 校验失败的轮次不记(那一轮没有决策),但它照样消耗一个 attempts 单位。
   *
   * `reason` 带的是**上一步被拒的原因**(`lastReason`):走到执行这一步之前如果先被
   * 拒过,多花的那些观察轮次才有据可查。没被拒过时是空串 —— 也就是大多数正常步。
   */
  const recordStep = (decision, targetIndex, text, reason) => {
    const record = {
      step: steps.length + 1,
      operation: decision.operation,
      reason,
      confidence: decision.confidence,
    };
    // targetIndex 只有 CLICK / TYPE_TEXT / SELECT 才有。**不写 null** —— 工具输出的
    // schema 就得声明可空整数,而 dsh-tools 的 schema 子集不认 `type: [...]` 联合。
    if (targetIndex !== null) record.targetIndex = targetIndex;
    if (text !== undefined) record.text = text;
    steps.push(record);
  };

  try {
    for (;;) {
      const elapsedMs = now() - startedAt;
      const verdict = evaluateStop({
        attempts,
        elapsedMs,
        maxSteps,
        budgetMs,
        consecutiveLowConfidence,
      });
      if (verdict.stop) return finish(verdict.status, steps, goalMet, elapsedMs);

      // 观察 → 决策。校验失败时整轮重来,最多 MAX_VALIDATION_RETRIES 次;
      // 每一轮都计一个 attempts 单位,包括失败的那些轮 —— 否则一个持续越界的目标
      // 可以把回路拖成无界重试。
      let action = null;
      let lastReason = '';
      for (let retry = 0; action === null && retry <= MAX_VALIDATION_RETRIES; retry += 1) {
        attempts += 1;
        if (attempts > maxSteps) return finish('max_steps', steps, goalMet, now() - startedAt);
        const snapshot = await observe();
        const table = buildElementTable(snapshot);
        const state = buildState({ goal, snapshot, table, steps });

        // 文本候选**先于决策**算好 —— 一次请求里同时问完 operation、元素目标与
        // 「填哪段文本」(投机扇出,与元素目标同一套做法)。它既要进 questions(供
        // Jev 选),又要进 validateDecision(校验选中的下标),两处必须是**同一份**,
        // 否则校验会对着另一份清单放行。
        //
        // 候选 = goal 片段 + 页面字段标签片段。目标字段是 Jev 在**同一个请求里**才选的,
        // 请求体不可能等它,所以字段标签那半截取元素表里第一个能切出片段的可填字段当代表
        // (见 `labelSource`)。spec 要求的「按页面字段旁的标签 / 占位符切出的片段」因此一定
        // 在被问过的那份清单里;校验与输入共用同一份,不会出现「问了 A 却按 B 校验」。
        const candidates = typeTextCandidates({
          goal,
          element: labelSource(table),
        });
        const questions = buildQuestions({ goal, table, typeTextCandidates: candidates });
        const decision = parseDecision(await decide({ goal, state, questions, snapshot }));

        if (decision.goalMet >= STOP_PROBABILITY) {
          goalMet = decision.goalMet;
          recordStep(decision, null, undefined, lastReason);
          return finish('done', steps, goalMet, now() - startedAt);
        }
        if (decision.stuck >= STOP_PROBABILITY) {
          recordStep(decision, null, undefined, lastReason);
          return finish('stuck', steps, decision.goalMet, now() - startedAt);
        }
        if (decision.operation === 'BLOCKED') {
          recordStep(decision, null, undefined, lastReason);
          return finish('blocked', steps, decision.goalMet, now() - startedAt);
        }
        if (decision.operation === 'DONE') {
          recordStep(decision, null, undefined, lastReason);
          return finish('done', steps, decision.goalMet, now() - startedAt);
        }

        if (decision.operation === 'TYPE_TEXT' && candidates.length === 0) {
          // 候选整个为空:goal 与所有可填字段的标签都没给出可用片段,这一步只能停下。
          recordStep(decision, decision.typeTextTarget, undefined, lastReason);
          return finish('text_unavailable', steps, decision.goalMet, now() - startedAt, NO_TEXT);
        }

        const checked = validateDecision(decision, table, { candidates });
        if (!checked.ok) {
          lastReason = checked.reason;
          continue; // 重新观察
        }

        // 文本是 **Jev 选中的**那一份逐字片段 —— 不是候选里的第一个。
        recordStep(decision, checked.targetIndex, checked.text, lastReason);
        consecutiveLowConfidence =
          decision.confidence < LOW_CONFIDENCE ? consecutiveLowConfidence + 1 : 0;
        action = {
          operation: decision.operation,
          targetIndex: checked.targetIndex,
          text: checked.text,
          snapshot,
          table,
        };
      }

      if (action === null) {
        return finish('error', steps, goalMet, now() - startedAt, `动作校验连续失败:${lastReason}`);
      }
      await execute(action);

      const elapsedAfter = now() - startedAt;
      if (elapsedAfter >= budgetMs) return finish('timeout', steps, goalMet, elapsedAfter);
    }
  } catch (error) {
    return finish('error', steps, goalMet, now() - startedAt, error?.message ?? String(error));
  }
}

/** 统一的收尾形状。`status: 'done'` 只表示回路停了,**不表示目标真的达成**。 */
function finish(status, steps, goalMet, elapsedMs, error) {
  const result = { status, steps, goalMet, elapsedMs };
  if (error !== undefined) result.error = error;
  return result;
}

/**
 * 「页面字段标签」那半截候选的代表元素。
 *
 * 目标字段是 Jev 在**同一个请求里**才选的,而候选必须在请求发出前就写进那一问的
 * criteria —— 所以这里取元素表里**第一个能切出片段的可填字段**当代表。它不是「猜
 * 目标」:候选只用来列举可选的逐字片段,校验与输入用的是同一份清单,所以这里选谁都
 * 不会让候选与校验漂移;换一个可填字段只是让 criteria 的字段标签那几项换一批同源片段。
 *
 * 没有任何可填字段时返回 `undefined` —— 此时候选只剩 goal 片段(或为空)。
 *
 * @param {{ eligible: Record<string, number[]>, byIndex: Map<number, object> }} table
 * @returns {object|undefined}
 */
function labelSource(table) {
  for (const index of table.eligible.TYPE_TEXT) {
    const element = table.byIndex.get(index);
    if (element !== undefined && typeof element.name === 'string' && element.name !== '') {
      return element;
    }
  }
  return undefined;
}
