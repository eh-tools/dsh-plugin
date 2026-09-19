/**
 * browser-operator 的离线单测 —— 不需要浏览器、不需要网络、不需要 API key。
 *
 * 运行: node plugins/browser-operator/tests/policy.test.mjs
 *
 * 这个文件进 `just check`(见 justfile / 根 package.json 的三处接线)。
 * 会真的拉起浏览器的 tests/smoke.mjs 不在这里,也不在门禁里。
 */

import assert from 'node:assert/strict';

import {
    ACTION_SPACE,
    STATUS,
    buildElementTable,
    buildQuestions,
    buildState,
    parseDecision,
    renderElementTable,
    textCandidates,
    validateDecision,
} from '../lib/policy.js';
import { evaluateStop, runLoop } from '../lib/loop.js';
import {
    ELEMENT_SELECTOR,
    MAX_ELEMENTS,
    elementHandle,
    pageProbe,
    readSnapshot,
} from '../lib/snapshot.js';
import { TYPESAFE_REF, createDecide, resolveApiKey } from '../lib/jev.js';
import { apply, executeAction } from '../lib/index.js';
import { createHarness } from './harness.mjs';

/**
 * 用例只能登记在这一行之后、文件末尾的 runner 之前。runner 之后再登记会**抛错**,
 * 而不是被静默丢掉 —— 那条守卫本身由 tests/harness.test.mjs 钉住。
 */
const { check, checkAsync, run } = createHarness({ assert });

/** 一个固定的页面快照 fixture;形状与 lib/snapshot.js 的 reader 输出一致。 */
const SNAPSHOT = {
    url: 'https://example.test/flights',
    title: 'Flights',
    freshness: 'f-1',
    text: 'Round trip  Where from?  San Francisco  Where to?  Departure',
    elements: [
        {
            index: 1,
            role: 'button',
            name: 'Round trip',
            value: '',
            disabled: false,
            kind: 'clickable',
        },
        {
            index: 2,
            role: 'combobox',
            name: 'Where from?',
            value: 'San Francisco',
            disabled: false,
            kind: 'typeable',
        },
        {
            index: 3,
            role: 'combobox',
            name: 'Where to?',
            value: '',
            disabled: false,
            kind: 'selectable',
        },
        {
            index: 4,
            role: 'textbox',
            name: 'Departure',
            value: '',
            disabled: false,
            kind: 'typeable',
        },
        { index: 5, role: 'button', name: 'Search', value: '', disabled: true, kind: 'clickable' },
    ],
};

checkAsync('readSnapshot 把选择器作为参数传进页面,并透传结果', async () => {
    const canned = { ...SNAPSHOT };
    let seen;
    const page = {
        evaluate: async (fn, arg) => {
            seen = arg;
            return canned;
        },
    };
    assert.deepEqual(await readSnapshot(page), canned);
    assert.equal(seen.selector, ELEMENT_SELECTOR);
    assert.equal(seen.limit, MAX_ELEMENTS);
    assert.equal(seen.index, undefined, '读快照时不该带 index');
});

checkAsync('page.evaluate 返回非对象时抛错', async () => {
    const page = { evaluate: async () => null };
    await assert.rejects(() => readSnapshot(page), /browser-operator:/);
});

checkAsync('elementHandle 用同一个选择器按序号解析元素', async () => {
    const fakeElement = { click: async () => {} };
    let seen;
    const page = {
        evaluateHandle: async (fn, arg) => {
            seen = arg;
            return { asElement: () => fakeElement };
        },
    };
    assert.equal(await elementHandle(page, 3), fakeElement);
    assert.equal(seen.selector, ELEMENT_SELECTOR);
    assert.equal(seen.index, 3);
});

checkAsync('元素在执行前消失时抛错', async () => {
    let disposed = false;
    const page = {
        evaluateHandle: async () => ({
            asElement: () => null,
            dispose: async () => {
                disposed = true;
            },
        }),
    };
    await assert.rejects(() => elementHandle(page, 3), /元素 3/);
    assert.ok(disposed, '拿不到元素时该把句柄清掉,不能泄漏');
});

check('pageProbe 真的能被序列化进页面并跑通读模式', () => {
    // 只查源码里有没有 `require(` / `import` 是**空转的**:它检测不出函数体引用了
    // 模块作用域的标识符,而那正是 Playwright 序列化时唯一会炸的东西。
    // 这里复刻 Playwright 的做法:只拿函数源码,在一个**只有页面全局、没有模块作用域**
    // 的环境里重新求值,再拿假 DOM 真调一次读模式。
    const factory = new Function(
        'document',
        'window',
        'location',
        `return (${pageProbe.toString()});`,
    );
    const fakeDocument = {
        querySelectorAll: () => [
            {
                tagName: 'BUTTON',
                innerText: 'Round trip',
                value: '',
                disabled: false,
                isContentEditable: false,
                getAttribute: () => null,
                getBoundingClientRect: () => ({ width: 10, height: 10 }),
            },
        ],
    };
    const fakeWindow = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
    const fn = factory(fakeDocument, fakeWindow, { href: 'https://example.test/' });
    const snapshot = fn({ selector: ELEMENT_SELECTOR, limit: MAX_ELEMENTS });
    assert.equal(snapshot.elements.length, 1);
    assert.equal(snapshot.elements[0].name, 'Round trip');
});

check('动作空间闭合在 8 个操作上', () => {
    assert.deepEqual(
        [...ACTION_SPACE],
        ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_UP', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED'],
    );
});

check('status 闭合在 8 个取值上', () => {
    assert.deepEqual(
        [...STATUS],
        [
            'done',
            'stuck',
            'blocked',
            'max_steps',
            'timeout',
            'error',
            'uncertain',
            'text_unavailable',
        ],
    );
});

check('元素表把每个元素渲染成一行「[n] role name · value」', () => {
    const table = buildElementTable(SNAPSHOT);
    assert.equal(table.lines[0], '[1] button "Round trip"');
    assert.equal(table.lines[1], '[2] combobox "Where from?" · San Francisco');
});

check('元素表保留 index → 元素的映射', () => {
    const table = buildElementTable(SNAPSHOT);
    assert.equal(table.byIndex.get(4).name, 'Departure');
    assert.equal(table.byIndex.get(99), undefined);
});

check('停用的元素不进任何 eligible 列表', () => {
    const table = buildElementTable(SNAPSHOT);
    assert.ok(!table.eligible.CLICK.includes(5), 'disabled 的按钮不该可点');
    assert.deepEqual(table.eligible.CLICK, [1]);
});

check('eligible 按 kind 分派', () => {
    const table = buildElementTable(SNAPSHOT);
    assert.deepEqual(table.eligible.TYPE_TEXT, [2, 4]);
    assert.deepEqual(table.eligible.SELECT, [3]);
});

check('renderElementTable 输出多行文本', () => {
    const table = buildElementTable(SNAPSHOT);
    const text = renderElementTable(table);
    assert.equal(text.split('\n').length, 5);
    assert.match(text, /\[5\] button "Search"/);
});

check('state 带上 goal、当前 URL/标题、元素表与已走过的步数', () => {
    const table = buildElementTable(SNAPSHOT);
    const state = buildState({
        goal: 'Find one-way flights',
        snapshot: SNAPSHOT,
        table,
        steps: [{ step: 1, operation: 'CLICK', targetIndex: 1, reason: '', confidence: 0.9 }],
    });
    assert.equal(state.goal, 'Find one-way flights');
    assert.equal(state.url, SNAPSHOT.url);
    assert.equal(state.title, SNAPSHOT.title);
    assert.match(state.elementTable, /\[1\] button "Round trip"/);
    assert.equal(state.steps.length, 1);
});

check('questions 的键恰好是那六个', () => {
    const questions = buildQuestions({ goal: 'g', table: buildElementTable(SNAPSHOT) });
    assert.deepEqual(Object.keys(questions).sort(), [
        'click_target',
        'goal_met',
        'operation',
        'select_target',
        'stuck',
        'type_text_target',
    ]);
});

check('每个问题都带 type 判别字段,且 noul 不带 criteria', () => {
    const questions = buildQuestions({ goal: 'g', table: buildElementTable(SNAPSHOT) });
    for (const [name, question] of Object.entries(questions)) {
        assert.ok(
            ['choice', 'noul'].includes(question.type),
            `${name} 的 type 不对:${question.type}`,
        );
    }
    assert.equal(questions.operation.type, 'choice');
    assert.equal(questions.goal_met.type, 'noul');
    assert.ok(!('criteria' in questions.goal_met), 'noul 问题不该带 criteria');
});

check('questions 只装当前合法的操作与目标', () => {
    const table = buildElementTable(SNAPSHOT);
    const questions = buildQuestions({ goal: 'g', table });
    assert.deepEqual(Object.keys(questions.operation.criteria), [...ACTION_SPACE]);
    // criteria 的键就是元素序号的十进制写法 —— parseDecision 靠它把回答映射回索引。
    assert.deepEqual(
        Object.keys(questions.click_target.criteria),
        table.eligible.CLICK.map(String),
    );
    assert.deepEqual(
        Object.keys(questions.type_text_target.criteria),
        table.eligible.TYPE_TEXT.map(String),
    );
    assert.deepEqual(
        Object.keys(questions.select_target.criteria),
        table.eligible.SELECT.map(String),
    );
});

check('criteria 的值就是元素表里那一行', () => {
    const questions = buildQuestions({ goal: 'g', table: buildElementTable(SNAPSHOT) });
    assert.equal(questions.click_target.criteria['1'], '[1] button "Round trip"');
});

check('没有合法目标时依然给出 questions(交给 Jev 选 DONE/BLOCKED)', () => {
    const table = buildElementTable({ elements: [] });
    const questions = buildQuestions({ goal: 'g', table });
    assert.deepEqual(questions.click_target.criteria, {});
    assert.deepEqual(Object.keys(questions.operation.criteria), [...ACTION_SPACE]);
});

check('goal_met 与 stuck 是带实质文案的概率问题', () => {
    const questions = buildQuestions({ goal: 'g', table: buildElementTable(SNAPSHOT) });
    assert.ok(questions.goal_met.instructions.length > 0);
    assert.ok(questions.stuck.instructions.length > 0);
});

/**
 * 一个形状正确的 Jev 响应 fixture。
 *
 * 注意 target 的 `choice` 是**字符串标签**(SDK 的 `ChoiceResponse.choice` 是
 * `keyof T & string`),不是数字 —— 标签就是 criteria 的键,也就是元素序号。
 */
const RESPONSE = {
    answers: {
        operation: { choice: 'CLICK', confidence: 0.91 },
        click_target: { choice: '1', confidence: 0.88 },
        type_text_target: { choice: '2', confidence: 0.4 },
        select_target: { choice: '3', confidence: 0.3 },
        goal_met: { noul: 0.02 },
        stuck: { noul: 0.05 },
    },
};

check('解析出 operation 与各自的 target 概率', () => {
    const decision = parseDecision(RESPONSE);
    assert.equal(decision.operation, 'CLICK');
    assert.equal(decision.clickTarget, 1);
    assert.equal(decision.goalMet, 0.02);
    assert.equal(decision.stuck, 0.05);
    assert.equal(decision.confidence, 0.91);
});

check('未知 operation 直接抛错(不接受模型自创的动作)', () => {
    const bad = {
        answers: { ...RESPONSE.answers, operation: { choice: 'NAVIGATE', confidence: 1 } },
    };
    assert.throws(() => parseDecision(bad), /browser-operator:.*NAVIGATE/);
});

check('响应缺 answers 时抛错', () => {
    assert.throws(() => parseDecision({}), /browser-operator:/);
});

check('CLICK 的目标落在本次提供的白名单里 → 通过', () => {
    const table = buildElementTable(SNAPSHOT);
    assert.deepEqual(validateDecision(parseDecision(RESPONSE), table), {
        ok: true,
        targetIndex: 1,
    });
});

check('CLICK 的目标不在白名单(越界)→ 拒绝', () => {
    const table = buildElementTable(SNAPSHOT);
    const decision = { ...parseDecision(RESPONSE), clickTarget: 999 };
    const verdict = validateDecision(decision, table);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /999/);
});

check('CLICK 落在停用元素上 → 拒绝', () => {
    const table = buildElementTable(SNAPSHOT);
    const decision = { ...parseDecision(RESPONSE), clickTarget: 5 };
    const verdict = validateDecision(decision, table);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /不可用|停用/);
});

check('CLICK 落在不可点的 kind 上 → 拒绝', () => {
    const table = buildElementTable(SNAPSHOT);
    const decision = { ...parseDecision(RESPONSE), clickTarget: 4 }; // textbox
    const verdict = validateDecision(decision, table);
    assert.equal(verdict.ok, false);
});

check('DONE / BLOCKED 不需要目标', () => {
    const table = buildElementTable(SNAPSHOT);
    for (const operation of ['DONE', 'BLOCKED', 'SCROLL_UP', 'WAIT']) {
        const decision = { ...parseDecision(RESPONSE), operation };
        assert.deepEqual(validateDecision(decision, table), { ok: true, targetIndex: null });
    }
});

check('从 goal 里切出逐字候选', () => {
    const candidates = textCandidates('Fly from Zurich to London on 2026-09-20, one adult');
    assert.ok(candidates.includes('Zurich'));
    assert.ok(candidates.includes('London'));
    assert.ok(candidates.includes('2026-09-20'));
});

check('候选保持出现顺序并去重', () => {
    const candidates = textCandidates('Zurich then London then Zurich');
    assert.deepEqual(candidates, ['Zurich', 'then', 'London']);
});

check('剔除过短片段(1 个字符的词不要)', () => {
    const candidates = textCandidates('Fly from Zurich to London');
    assert.ok(!candidates.includes('to'));
});

check('空 goal 给出空候选(调用方据此回 text_unavailable)', () => {
    assert.deepEqual(textCandidates(''), []);
    assert.deepEqual(textCandidates(undefined), []);
});

check('用尽 maxSteps 时停下,status 为 max_steps', () => {
    assert.deepEqual(
        evaluateStop({
            attempts: 12,
            elapsedMs: 0,
            maxSteps: 12,
            budgetMs: 100000,
            consecutiveLowConfidence: 0,
        }),
        { stop: true, status: 'max_steps' },
    );
});

check('超预算时停下,status 为 timeout', () => {
    assert.deepEqual(
        evaluateStop({
            attempts: 0,
            elapsedMs: 100000,
            maxSteps: 12,
            budgetMs: 100000,
            consecutiveLowConfidence: 0,
        }),
        { stop: true, status: 'timeout' },
    );
});

check('连续 3 步低置信度时停下,status 为 uncertain', () => {
    assert.deepEqual(
        evaluateStop({
            attempts: 0,
            elapsedMs: 0,
            maxSteps: 12,
            budgetMs: 100000,
            consecutiveLowConfidence: 3,
        }),
        { stop: true, status: 'uncertain' },
    );
});

check('都没到时不停止', () => {
    assert.deepEqual(
        evaluateStop({
            attempts: 0,
            elapsedMs: 0,
            maxSteps: 12,
            budgetMs: 100000,
            consecutiveLowConfidence: 0,
        }),
        { stop: false },
    );
});

checkAsync('校验失败后的重新观察也计一个单位(ADR-0009 决策点 6)', async () => {
    // 每次都返回越界目标:每一步都会重试 3 轮,但 attempts 也随之上涨,
    // 所以 maxSteps=3 时应该在第 3 次尝试后停下,而不是无限重试。
    const bad = {
        answers: {
            operation: { choice: 'CLICK', confidence: 0.9 },
            click_target: { choice: '999', confidence: 0.9 },
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    };
    let decides = 0;
    const result = await runLoop({
        goal: 'g',
        maxSteps: 3,
        budgetMs: 100000,
        now: () => 0,
        observe: async () => SNAPSHOT,
        decide: async () => {
            decides += 1;
            return bad;
        },
        execute: async () => {},
    });
    assert.ok(result.status === 'max_steps' || result.status === 'error');
    assert.ok(decides <= 4, `不该无限重试,实际调了 ${decides} 次`);
});

/** 回路测试用的假依赖:一次 CLICK,然后 DONE。 */
function fakeDeps({ responses, snapshot = SNAPSHOT }) {
    let clock = 0;
    const executed = [];
    const queue = [...responses];
    return {
        executed,
        now: () => clock,
        advance: (ms) => {
            clock += ms;
        },
        observe: async () => snapshot,
        decide: async () => queue.shift(),
        execute: async (action) => {
            executed.push(action);
        },
    };
}

const CLICK_THEN_DONE = [
    {
        answers: {
            operation: { choice: 'CLICK', confidence: 0.9 },
            click_target: { choice: '1', confidence: 0.9 },
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    },
    {
        answers: {
            operation: { choice: 'DONE', confidence: 0.95 },
            goal_met: { noul: 0.95 },
            stuck: { noul: 0.02 },
        },
    },
];

async function runWith(deps, overrides = {}) {
    return runLoop({
        goal: 'g',
        maxSteps: 12,
        budgetMs: 100000,
        now: deps.now,
        observe: deps.observe,
        decide: deps.decide,
        execute: deps.execute,
        ...overrides,
    });
}

checkAsync('回路执行 CLICK 后因 goal_met 停止', async () => {
    const deps = fakeDeps({ responses: CLICK_THEN_DONE });
    const result = await runWith(deps);
    assert.equal(result.status, 'done');
    assert.equal(result.steps.length, 2);
    assert.equal(deps.executed.length, 1);
    // 只断言这三个字段:action 上还挂着 snapshot 与 table(执行器要用)。
    assert.equal(deps.executed[0].operation, 'CLICK');
    assert.equal(deps.executed[0].targetIndex, 1);
    assert.equal(deps.executed[0].text, undefined);
});

checkAsync('DONE 不声称目标真的达成 —— 只回报概率', async () => {
    const deps = fakeDeps({ responses: CLICK_THEN_DONE });
    const result = await runWith(deps);
    assert.equal(result.goalMet, 0.95);
    assert.ok(!('success' in result), '不该有 success 这种断言');
});

checkAsync('越界目标被拒后重新观察,不执行;重试 2 次后 error', async () => {
    const bad = {
        answers: {
            operation: { choice: 'CLICK', confidence: 0.9 },
            click_target: { choice: '999', confidence: 0.9 },
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    };
    const deps = fakeDeps({ responses: [bad, bad, bad] });
    const result = await runWith(deps);
    assert.equal(result.status, 'error');
    assert.equal(deps.executed.length, 0, '越界目标一次都不该执行');
});

checkAsync('BLOCKED 映射到独立的 blocked 状态,与 stuck 分开', async () => {
    const deps = fakeDeps({
        responses: [
            {
                answers: {
                    operation: { choice: 'BLOCKED', confidence: 0.9 },
                    stuck: { noul: 0.1 },
                },
            },
        ],
    });
    const result = await runWith(deps);
    assert.equal(result.status, 'blocked');
});

checkAsync('stuck 高置信时停下,status 为 stuck', async () => {
    const deps = fakeDeps({
        responses: [
            { answers: { operation: { choice: 'WAIT', confidence: 0.9 }, stuck: { noul: 0.9 } } },
        ],
    });
    const result = await runWith(deps);
    assert.equal(result.status, 'stuck');
});

checkAsync('decide 抛错时立即停,不静默重试', async () => {
    let calls = 0;
    const result = await runLoop({
        goal: 'g',
        maxSteps: 12,
        budgetMs: 100000,
        now: () => 0,
        observe: async () => SNAPSHOT,
        decide: async () => {
            calls += 1;
            throw new Error('boom');
        },
        execute: async () => {},
    });
    assert.equal(result.status, 'error');
    assert.equal(calls, 1, '抛错后不该再调一次');
    assert.match(result.error, /boom/);
});

checkAsync('TYPE_TEXT 没有逐字候选时停下,status 为 text_unavailable', async () => {
    const deps = fakeDeps({
        responses: [
            {
                answers: {
                    operation: { choice: 'TYPE_TEXT', confidence: 0.9 },
                    type_text_target: { choice: '4', confidence: 0.9 },
                    goal_met: { noul: 0.1 },
                    stuck: { noul: 0.1 },
                },
            },
        ],
    });
    const result = await runWith(deps, { goal: '' });
    assert.equal(result.status, 'text_unavailable');
});

checkAsync('被拒一步的 reason 会留在下一步的台账上(不丢诊断)', async () => {
    // 第一轮:目标越界 → validateDecision 拒绝,重新观察(这一轮不记步,但花掉一个 attempts);
    // 第二轮:目标合法 → 记一步并执行。这一步的记录必须带着上一轮被拒的原因,
    // 否则「为什么多花了一轮」在台账里就查不出来了。
    const rejected = {
        answers: {
            operation: { choice: 'CLICK', confidence: 0.9 },
            click_target: { choice: '999', confidence: 0.9 },
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    };
    const accepted = {
        answers: {
            operation: { choice: 'CLICK', confidence: 0.9 },
            click_target: { choice: '1', confidence: 0.9 },
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    };
    const done = {
        answers: {
            operation: { choice: 'DONE', confidence: 0.95 },
            goal_met: { noul: 0.95 },
            stuck: { noul: 0.02 },
        },
    };
    const deps = fakeDeps({ responses: [rejected, accepted, done] });
    // maxSteps=3 = 被拒那轮 + 执行那轮 + 终止那轮。
    const result = await runWith(deps, { maxSteps: 3 });
    assert.equal(result.status, 'done');
    // 被拒的轮次没有决策,不记步(它只花一个 attempts 单位)—— 所以是被接受的两条。
    assert.equal(result.steps.length, 2);
    assert.match(result.steps[0].reason, /999/, '被拒的原因该留在下一条记录上');
    assert.equal(result.steps[1].reason, '', '没被拒过的步 reason 仍为空串');
});

checkAsync('凭证服务不可用时抛出可读的错误', async () => {
    await assert.rejects(() => resolveApiKey(undefined), /凭证服务/);
});

checkAsync('凭证未配置时错误里点名 TYPESAFE_API_KEY 并给出两条配置路径', async () => {
    const credentials = { resolve: async () => undefined };
    await assert.rejects(
        () => resolveApiKey(credentials),
        (error) => error.message.includes('TYPESAFE_API_KEY') && error.message.includes('.env'),
    );
});

checkAsync('凭证就绪时返回值与来源', async () => {
    const refs = [];
    const credentials = {
        resolve: async (ref) => {
            refs.push(ref);
            return { value: 'k-1', source: 'env' };
        },
    };
    assert.deepEqual(await resolveApiKey(credentials), { value: 'k-1', source: 'env' });
    // 引用名必须真的是 TYPESAFE_API_KEY —— 换成别的名字就查不到 key 了。
    assert.deepEqual(refs, [TYPESAFE_REF]);
});

checkAsync('每次解析都重新问凭证服务(不跨操作缓存)', async () => {
    let calls = 0;
    const credentials = {
        resolve: async () => {
            calls += 1;
            return { value: `k-${calls}`, source: 'env' };
        },
    };
    await resolveApiKey(credentials);
    const second = await resolveApiKey(credentials);
    assert.equal(calls, 2);
    assert.equal(second.value, 'k-2');
});

check('创建客户端时显式关掉 SDK 默认重试并传显式超时', () => {
    let seen;
    const decide = createDecide({
        apiKey: 'k-1',
        model: 'jev-latest',
        timeoutMs: 5000,
        clientFactory: (options) => {
            seen = options;
            return { systemOne: async () => ({ answers: {} }) };
        },
    });
    assert.equal(seen.apiKey, 'k-1');
    assert.equal(seen.model, 'jev-latest');
    // 真正生效的是 `defaultModel`;`model` 会被构造器静默忽略。两条都断言,免得日后
    // 有人把「看起来重复」的那个删掉 —— 删掉 defaultModel 就等于模型配置无声失效。
    assert.equal(seen.defaultModel, 'jev-latest');
    assert.equal(seen.timeout, 5000);
    assert.deepEqual(seen.retry, { maxRetries: 0 });
    assert.equal(typeof decide, 'function');
});

checkAsync('decide 把 state 与 questions 原样交给 systemOne', async () => {
    const calls = [];
    const decide = createDecide({
        apiKey: 'k-1',
        model: 'jev-latest',
        timeoutMs: 5000,
        clientFactory: () => ({
            systemOne: async (request) => {
                calls.push(request);
                return { answers: { operation: { choice: 'DONE', confidence: 1 } } };
            },
        }),
    });
    const response = await decide({ state: { goal: 'g' }, questions: { operation: {} } });
    assert.deepEqual(calls[0], { state: { goal: 'g' }, questions: { operation: {} } });
    assert.equal(response.answers.operation.choice, 'DONE');
});

/**
 * 假 ctx:捕获工具定义,记住 dispose 回调,可选提供 `get()`。
 *
 * 刻意**只**提供工具注册表与 `get`,不提供别的 —— 这样「apply 期碰了凭证 / 浏览器」
 * 会当场炸掉,而不是被一个过分宽松的假对象掩盖。
 */
function makeCtx({ credentials } = {}) {
    const tools = new Map();
    const disposers = [];
    return {
        tools: { register: (definition) => tools.set(definition.name, definition) },
        get: (name) => (name === 'credentials' ? credentials : undefined),
        on(event, handler) {
            if (event === 'dispose') disposers.push(handler);
        },
        toolsByName: tools,
        async dispose() {
            for (const handler of disposers) await handler();
        },
    };
}

/** 工具执行上下文:只用到 agent.session.id / header.cwd。 */
const execIn = (cwd) => ({ agent: { session: { id: 'offline', header: { cwd } } } });

check('browser_act 已注册且带齐门禁要求的四件套', () => {
    const ctx = makeCtx();
    apply(ctx, {});
    const definition = ctx.toolsByName.get('browser_act');
    assert.ok(definition !== undefined, 'browser_act 没有注册');
    assert.equal(typeof definition.timeoutMs, 'number');
    assert.ok(definition.output?.schema, '缺 output.schema');
    assert.equal(typeof definition.output.render, 'function', '缺 output.render');
    assert.equal(typeof definition.presentCall, 'function', '缺 presentCall');
    assert.equal(definition.timeoutMs, 120000);
});

check('注册只发生在 apply 期,不在 apply 里解析凭证', () => {
    // makeCtx() 故意不提供 get() 之外的 credentials —— 若 apply 期解析就会抛。
    assert.doesNotThrow(() => apply(makeCtx(), {}));
});

check('browser_act 的参数只有 goal 与 maxSteps', () => {
    const ctx = makeCtx();
    apply(ctx, {});
    const parameters = ctx.toolsByName.get('browser_act').parameters;
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['goal', 'maxSteps']);
    assert.deepEqual(parameters.required, ['goal']);
    assert.equal(parameters.additionalProperties, false);
});

checkAsync('没打开页面时 browser_act 指向 browser_navigate(而不是先抱怨缺 key)', async () => {
    const ctx = makeCtx();
    apply(ctx, {});
    await assert.rejects(
        () => ctx.toolsByName.get('browser_act').execute({ goal: 'g' }, execIn(process.cwd())),
        /browser_navigate/,
    );
});

checkAsync('非有限的 maxSteps 在离开工具之前就被拒(不许传进回路)', async () => {
    const ctx = makeCtx();
    apply(ctx, {});
    const execute = ctx.toolsByName.get('browser_act').execute;
    // exec 是 undefined:参数校验必须发生在一切 I/O 之前,所以连 exec 都不该被碰到。
    // 非有限值若走到 runLoop,`attempts >= maxSteps` 永不成立 → 回路不返回;
    // 它还会 starving 掉 Node 的 timer 相位,连从内部打断都做不到。
    for (const bad of [Infinity, -Infinity, NaN, 0, -3, 6.5, '12']) {
        await assert.rejects(
            () => execute({ goal: 'g', maxSteps: bad }),
            /maxSteps/,
            `${String(bad)} 不该被当成合法步数放过去`,
        );
    }
});

checkAsync('未被执行器实现的 operation 一律失败,不静默成功(R2 default-deny)', async () => {
    // 这个 operation 连 `ACTION_SPACE` 都不在 —— `parseDecision` 之外没人拦得住它。
    // 执行器必须**抛**,否则回路会把一次没发生的事记成成功。
    const page = {
        evaluate: () => {
            throw new Error('不该碰页面:operation 校验必须排在页面访问之前');
        },
    };
    await assert.rejects(
        () => executeAction({ operation: 'NAVIGATE', page, settings: {}, snapshot: {} }),
        /NAVIGATE/,
    );
});

// 回路用例:全部登记完再统一 await,失败才算数(见 harness.mjs 的 checkAsync)。
// `run()` 之后就不能再登记用例了 —— 迟到的登记会抛错,不会变成假绿。
await run();
