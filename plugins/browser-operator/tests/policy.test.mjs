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
    MAX_CANDIDATES,
    STATUS,
    buildElementTable,
    buildQuestions,
    buildState,
    parseDecision,
    renderElementTable,
    textCandidates,
    typeTextCandidates,
    validateDecision,
} from '../lib/policy.js';
import { evaluateStop, runLoop } from '../lib/loop.js';
import {
    ELEMENT_SELECTOR,
    JEV_STATE_TEXT_CHARS,
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

checkAsync('readSnapshot 的两个载荷上限由调用方给,缺省回落到默认值', async () => {
    // 元素条数与进 state 的正文长度都是**每步重发**的成本,所以它们得可调
    // (插件配置 maxElements / jevMaxTextChars);缺省时回落,不能「漏传就无限」。
    let seen;
    const page = {
        evaluate: async (fn, arg) => {
            seen = arg;
            return { ...SNAPSHOT };
        },
    };
    await readSnapshot(page, ELEMENT_SELECTOR, 7, 123);
    assert.equal(seen.limit, 7);
    assert.equal(seen.maxTextChars, 123);
    await readSnapshot(page);
    assert.equal(seen.limit, MAX_ELEMENTS);
    assert.equal(seen.maxTextChars, JEV_STATE_TEXT_CHARS);
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

checkAsync('读快照与解析元素交给页面的是同一个 pageProbe 函数对象', async () => {
    // 这题不查行为,查**身份**:`readSnapshot` 走 `page.evaluate`、`elementHandle` 走
    // `page.evaluateHandle`,两个调用点必须交出同一个函数对象。序号「数出来的第 n 个」
    // 就押在这上面 —— 两处各自定义一份「长得很像」的函数,页面上任何一处判定漂移都会让
    // 执行器解析到**别的**元素,而且不报错。假页面只把调用点交出去的函数抓下来。
    const captured = [];
    const fakeElement = { click: async () => {} };
    const page = {
        evaluate: async (fn) => {
            captured.push(fn);
            return { url: 'u', title: 't', freshness: 'f', text: '', elements: [] };
        },
        evaluateHandle: async (fn) => {
            captured.push(fn);
            return { asElement: () => fakeElement, dispose: async () => {} };
        },
    };
    await readSnapshot(page);
    assert.equal(await elementHandle(page, 3), fakeElement);

    assert.equal(captured.length, 2, '两个调用点各该交出一个函数');
    // 只认 `===`(`assert/strict` 的 equal 就是严格相等):两份各自定义的替身**行为可以
    // 完全一致**,任何「行为/结构相等」的比法都会把它们放过去,只有引用相等拦得住。
    assert.equal(captured[0], captured[1], '两个调用点必须传同一个函数对象,不是两份长得很像的');
    assert.equal(captured[0], pageProbe, '交给页面的必须是导出的那一个 pageProbe');
    const lookalike = (options) => options.selector;
    assert.notEqual(lookalike, pageProbe, '同源替身过不了这道闸 —— 缺的正是上面那条引用相等');
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

check('freshness 用截断之前的计数,大页面重排后不再比较相等', () => {
    // 超过 limit / 4000 字符的页面:截断之后的数字会让上限以后的元素重排
    // (或正文变长)都算出同一个 freshness,过期校验就瞎了。
    const factory = new Function(
        'document',
        'window',
        'location',
        `return (${pageProbe.toString()});`,
    );
    const node = (name) => ({
        tagName: 'BUTTON',
        innerText: name,
        value: '',
        disabled: false,
        isContentEditable: false,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ width: 10, height: 10 }),
    });
    const bodyText = 'x'.repeat(5000);
    const document = {
        querySelectorAll: () => [node('a'), node('b'), node('c')],
        body: { innerText: bodyText },
    };
    const window = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
    const location = { href: 'https://example.test/' };
    const fn = factory(document, window, location);

    const limited = fn({ selector: ELEMENT_SELECTOR, limit: 2 });
    assert.equal(limited.elements.length, 2, 'limit 仍照旧只放出 2 个元素');
    assert.equal(limited.text.length, 4000, '正文仍照旧截到 4000 字符');
    assert.equal(limited.freshness, `3|https://example.test/|5000`, '计数取截断之前的');

    // 增删**上限之外**的元素(切片之内完全不变)—— 用后截断计数根本看不出来。
    document.querySelectorAll = () => [node('a'), node('b'), node('c'), node('d')];
    assert.notEqual(fn({ selector: ELEMENT_SELECTOR, limit: 2 }).freshness, limited.freshness);

    // 正文变长但仍在 4000 之后:同样必须变。
    document.querySelectorAll = () => [node('a'), node('b'), node('c')];
    document.body.innerText = `${bodyText}y`;
    assert.notEqual(fn({ selector: ELEMENT_SELECTOR, limit: 2 }).freshness, limited.freshness);

    // 页面真没变时 freshness 必须相等 —— 证明上面两条不是「永远不相等」。
    document.body.innerText = bodyText;
    assert.equal(fn({ selector: ELEMENT_SELECTOR, limit: 2 }).freshness, limited.freshness);
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

check('页面每种目标都有、候选也不空时,questions 的键恰好是那七个', () => {
    // 目标问是**按需**发的(空 criteria 会被服务端 400 拒,见下面几条),所以这一条
    // 特意把七问都凑齐:SNAPSHOT 里 CLICK / TYPE_TEXT / SELECT 都有 eligible,
    // 再给一份非空文本候选,`type_text_value` 才发得出来。
    const questions = buildQuestions({
        goal: 'g',
        table: buildElementTable(SNAPSHOT),
        typeTextCandidates: ['Zurich'],
    });
    assert.deepEqual(Object.keys(questions).sort(), [
        'click_target',
        'goal_met',
        'operation',
        'select_target',
        'stuck',
        'type_text_target',
        'type_text_value',
    ]);
});

check('文本那一问是 choice,标签是候选下标的十进制写法,描述是逐字片段', () => {
    // ADR-0009 决策点 6:TYPE_TEXT 的文本必须**由 Jev 从逐字候选里选**。
    // 标签走和元素目标同一套十进制口径,好让 parseDecision / validateDecision 的
    // 映射逻辑不必分叉 —— 候选片段本身只出现在描述里,绝不当标签。
    const questions = buildQuestions({
        goal: 'g',
        table: buildElementTable(SNAPSHOT),
        typeTextCandidates: ['Zurich', 'London'],
    });
    assert.equal(questions.type_text_value.type, 'choice');
    assert.deepEqual(questions.type_text_value.criteria, {
        0: 'Zurich',
        1: 'London',
    });
    assert.equal(questions.type_text_value.instructions.length > 0, true);
});

check('没给候选时文本那一问整个不发(空 criteria 会被服务端 400 拒)', () => {
    // 之前这里发的是 `criteria: {}`,服务端回 400
    // `Choice question must have at least one choice`。没有候选时既不补占位项,
    // 也不发空对象 —— 那一问直接消失。
    const questions = buildQuestions({ goal: 'g', table: buildElementTable(SNAPSHOT) });
    assert.equal('type_text_value' in questions, false, '没有候选时不该发那一问');
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

check('operation.criteria 的每个值都是非空字符串(加了第 9 个动作却没写说明就红)', () => {
    // 只比**键集**是不够的:往 `ACTION_SPACE` 里加了操作、却忘了在 `OPERATION_HINTS` 里
    // 写说明时,`criteria[新操作]` 会是 `undefined`,而键集照样与 `ACTION_SPACE` 相等 ——
    // 「每个动作都有一句说明」这件事就没有任何用例钉住了。
    //
    // 这里从**公开面**逐值检查(`buildQuestions` 的返回值),而不是导出私有的
    // `OPERATION_HINTS` 去比两处常量 —— 那样只是把同一个事实写两遍。
    const questions = buildQuestions({ goal: 'g', table: buildElementTable(SNAPSHOT) });
    const criteria = questions.operation.criteria;
    assert.deepEqual(Object.keys(criteria), [...ACTION_SPACE]);
    for (const [operation, hint] of Object.entries(criteria)) {
        assert.equal(typeof hint, 'string', `${operation} 的说明不是字符串:${String(hint)}`);
        assert.ok(hint.trim() !== '', `${operation} 的说明是空字符串`);
    }
});

check('criteria 的值只带 role+name:序号是键、完整描述在元素表里,都不重复', () => {
    // 元素表(state)才是完整描述;criteria 只负责说清「哪些序号合法」。
    // 上限页面(200 元素)实测:去掉 `[N] ` 前缀与 ` · value` 省约 1.5 KB(全载荷 4.8%)。
    const table = buildElementTable(SNAPSHOT);
    const questions = buildQuestions({ goal: 'g', table });
    assert.equal(questions.click_target.criteria['1'], 'button "Round trip"');
    assert.equal(
        table.lines[0],
        '[1] button "Round trip"',
        '元素表仍是完整描述(含序号;该元素无值)',
    );
    assert.ok(
        !Object.values(questions.click_target.criteria).some((line) => line.startsWith('[')),
        'criteria 的值不该再写一遍序号 —— 键就是它',
    );
});

/**
 * 造一个只有若干元素的最小快照。`kind` 取 `clickable` / `typeable` / `selectable`
 * 三者之一(buildElementTable 的 eligible 就按它分派)。
 */
function pageOf(...kinds) {
    return {
        elements: kinds.map((kind, position) => ({
            index: position + 1,
            role: kind,
            name: `e${position + 1}`,
            value: '',
            disabled: false,
            kind,
        })),
    };
}

check('每个目标问在对应 eligible 为空时整个不发,有目标时才发', () => {
    // 四道目标问各自与自己的 eligible 列表绑定:空列表 → 整问消失,绝不发空 criteria。
    const cases = [
        { key: 'click_target', present: 'clickable', absent: 'typeable' },
        { key: 'type_text_target', present: 'typeable', absent: 'clickable' },
        { key: 'select_target', present: 'selectable', absent: 'clickable' },
    ];
    for (const { key, present, absent } of cases) {
        const withEligible = buildQuestions({
            goal: 'g',
            table: buildElementTable(pageOf(present)),
        });
        assert.ok(withEligible[key] !== undefined, `${key} 有 eligible 目标时该发出来`);
        assert.ok(
            Object.keys(withEligible[key].criteria).length > 0,
            `${key} 的 criteria 不该是空的`,
        );

        const without = buildQuestions({ goal: 'g', table: buildElementTable(pageOf(absent)) });
        assert.equal(without[key], undefined, `${key} 没有 eligible 目标时整个不该发`);
    }

    // 文本那一问的 eligible 是「逐字候选」,不是元素 —— 候选为空同样整问不发。
    const noCandidates = buildQuestions({
        goal: 'g',
        table: buildElementTable(pageOf('typeable')),
    });
    assert.equal('type_text_value' in noCandidates, false);
    const withCandidates = buildQuestions({
        goal: 'g',
        table: buildElementTable(pageOf('typeable')),
        typeTextCandidates: ['Zurich'],
    });
    assert.deepEqual(withCandidates.type_text_value.criteria, { 0: 'Zurich' });
});

check('任何时候都不会发出 criteria 为空的 choice(那正是 400 的成因)', () => {
    // 这一条钉的是**已确认的线上形状**:一个空 criteria 的 choice 单独发出去也会 400。
    // 所以从公开面逐个数:凡是 choice,criteria 至少有一项;noul 一律不带 criteria。
    const pages = [
        SNAPSHOT,
        { elements: [] },
        pageOf('typeable'),
        pageOf('selectable'),
        pageOf('clickable'),
        pageOf('clickable', 'typeable', 'selectable'),
        {
            elements: [
                {
                    index: 1,
                    role: 'button',
                    name: 'Search',
                    value: '',
                    disabled: true,
                    kind: 'clickable',
                },
            ],
        },
    ];
    for (const snapshot of pages) {
        for (const candidateSet of [[], ['Zurich']]) {
            const questions = buildQuestions({
                goal: 'g',
                table: buildElementTable(snapshot),
                typeTextCandidates: candidateSet,
            });
            for (const [name, question] of Object.entries(questions)) {
                assert.ok(
                    ['choice', 'noul'].includes(question.type),
                    `${name} 的 type 不对:${question.type}`,
                );
                if (question.type === 'noul') {
                    assert.ok(!('criteria' in question), `${name} 是 noul,不该带 criteria`);
                    continue;
                }
                const keys = Object.keys(question.criteria ?? {});
                assert.ok(keys.length > 0, `${name} 发了空 criteria(服务端会回 400)`);
            }
        }
    }
});

check('没有任何 eligible 目标时,question 集仍然有效:operation/goal_met/stuck 三问俱全', () => {
    const table = buildElementTable({ elements: [] });
    const questions = buildQuestions({ goal: 'g', table });
    // 四道目标问全被省掉 —— 但它们本来也无从可选。
    assert.deepEqual(Object.keys(questions).sort(), ['goal_met', 'operation', 'stuck']);
    // operation 照旧列出全部 8 个操作(交给 Jev 选 DONE / BLOCKED),说明永远有内容。
    assert.deepEqual(Object.keys(questions.operation.criteria), [...ACTION_SPACE]);
    assert.equal(questions.operation.type, 'choice');
    assert.ok(questions.goal_met.instructions.length > 0);
    assert.ok(questions.stuck.instructions.length > 0);
    assert.equal(questions.goal_met.type, 'noul');
    assert.equal(questions.stuck.type, 'noul');
});

check('选了目标问被省掉的操作 → 校验拒绝(没问过 = 没答,不回落)', () => {
    const table = buildElementTable(pageOf('clickable'));
    const questions = buildQuestions({ goal: 'g', table });
    // 「没有 selectable 元素」正是一张典型真实页面的样子(绝大多数页面没有 <select>)。
    assert.equal('select_target' in questions, false);
    assert.deepEqual(Object.keys(questions.operation.criteria), [...ACTION_SPACE]);

    // Jev 仍旧可以答 SELECT —— operation 那一问列出全部 8 个操作。但那一问没发出去,
    // 于是回答里没有 select_target,parseDecision 不许因此抛错,只当作「没给目标」。
    const decision = parseDecision({
        answers: {
            operation: { choice: 'SELECT', confidence: 0.9 },
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    });
    assert.equal(decision.operation, 'SELECT');
    assert.equal(decision.selectTarget, undefined);

    const verdict = validateDecision(decision, table);
    assert.equal(verdict.ok, false, '没有 eligible 目标的 SELECT 必须被拒');
    assert.match(verdict.reason, /SELECT/);

    // 就算 Jev 硬答一个标签(理论上问都没问),它也不在 SELECT 的 eligible 里 → 同样拒。
    const answered = parseDecision({
        answers: {
            operation: { choice: 'SELECT', confidence: 0.9 },
            select_target: { choice: '1', confidence: 0.9 },
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    });
    assert.equal(answered.selectTarget, 1, '十进制标签照旧能解析出来');
    assert.equal(validateDecision(answered, table).ok, false, '不在 eligible 里就得拒');
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

check('完整候选 = goal 片段 + 目标字段标签片段(去重、保序、封顶)', () => {
    // ADR-0009 决策点 6 的两半:goal 的逐字片段,**加上**页面字段旁的标签 / 占位符。
    const candidates = typeTextCandidates({
        goal: 'Fly from Zurich to London',
        element: { name: 'London departure date' },
    });
    assert.deepEqual(candidates, ['Fly', 'from', 'Zurich', 'London', 'departure', 'date']);
    assert.equal(new Set(candidates).size, candidates.length, '不许有重复片段');
});

check('只有字段标签、没有 goal 时也有候选', () => {
    assert.deepEqual(typeTextCandidates({ goal: '', element: { name: 'Departure date' } }), [
        'Departure',
        'date',
    ]);
    // 'to?' 会被标点切开后只剩 'to',短于下限 —— 字段标签同样受逐字口径约束。
    assert.deepEqual(typeTextCandidates({ goal: '', element: { name: 'Where to?' } }), ['Where']);
    assert.deepEqual(typeTextCandidates({ goal: '', element: { name: '' } }), []);
});

check('候选总量封顶在 MAX_CANDIDATES', () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    assert.equal(typeTextCandidates({ goal: long }).length, MAX_CANDIDATES);
    assert.equal(
        typeTextCandidates({ goal: long, element: { name: 'another word' } }).length,
        MAX_CANDIDATES,
    );
});

check('文本回答映射成候选下标;乱答的标签一律当作「没给」', () => {
    const answers = (choice) => ({
        answers: {
            operation: { choice: 'TYPE_TEXT', confidence: 0.9 },
            type_text_target: { choice: '4', confidence: 0.9 },
            ...(choice === undefined ? {} : { type_text_value: { choice, confidence: 0.9 } }),
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    });
    assert.equal(parseDecision(answers('1')).typeTextValue, 1);
    assert.equal(parseDecision(answers('Zurich')).typeTextValue, undefined);
    assert.equal(parseDecision(answers(undefined)).typeTextValue, undefined);
});

check('选中的下标落在本次提供的候选里 → 通过,并把逐字片段交回来', () => {
    const table = buildElementTable(SNAPSHOT);
    const decision = { operation: 'TYPE_TEXT', typeTextTarget: 4, typeTextValue: 1 };
    assert.deepEqual(validateDecision(decision, table, { candidates: ['Zurich', 'London'] }), {
        ok: true,
        targetIndex: 4,
        text: 'London',
    });
});

check('选中的下标越界 → 拒绝,绝不回落到 candidates[0]', () => {
    const table = buildElementTable(SNAPSHOT);
    const decision = { operation: 'TYPE_TEXT', typeTextTarget: 4, typeTextValue: 9 };
    const verdict = validateDecision(decision, table, { candidates: ['Zurich', 'London'] });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /9/);
    assert.ok(!('text' in verdict), '被拒的校验不该带回任何文本');
});

check('候选为空时即便给了下标也拒绝(候选只有 0 个)', () => {
    const table = buildElementTable(SNAPSHOT);
    const decision = { operation: 'TYPE_TEXT', typeTextTarget: 4, typeTextValue: 0 };
    const verdict = validateDecision(decision, table, { candidates: [] });
    assert.equal(verdict.ok, false);
});

check('TYPE_TEXT 没答文本那一问 → 拒绝,绝不回落到 candidates[0]', () => {
    const table = buildElementTable(SNAPSHOT);
    const decision = { operation: 'TYPE_TEXT', typeTextTarget: 4 };
    const verdict = validateDecision(decision, table, { candidates: ['Zurich', 'London'] });
    assert.equal(verdict.ok, false, '没答文本那一问时必须拒绝,不许静默填第一个候选');
    assert.match(verdict.reason, /browser-operator:/, '拒绝理由要带浏览器操作员前缀');
    assert.ok(!('text' in verdict), '被拒的校验不该带回任何文本');
});

check('文本标签不是十进制下标(答成片段文本)→ 拒绝,绝不回落到 candidates[0]', () => {
    const table = buildElementTable(SNAPSHOT);
    // Jev 答的是片段**文本**而不是位置:`parseDecision` 按 indexOfLabel 把它当作「没给」。
    const response = {
        answers: {
            operation: { choice: 'TYPE_TEXT', confidence: 0.9 },
            type_text_target: { choice: '4', confidence: 0.9 },
            type_text_value: { choice: 'Zurich', confidence: 0.9 },
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    };
    const decision = parseDecision(response);
    assert.equal(decision.typeTextValue, undefined, '非十进制标签该解析成「没给」');
    const verdict = validateDecision(decision, table, { candidates: ['Zurich', 'London'] });
    assert.equal(verdict.ok, false, '答成片段文本时必须拒绝');
    assert.match(verdict.reason, /browser-operator:/);
    assert.ok(!('text' in verdict), '被拒的校验不该带回任何文本');
});

check('非 TYPE_TEXT 的操作不产出文本', () => {
    const table = buildElementTable(SNAPSHOT);
    const decision = { operation: 'CLICK', clickTarget: 1 };
    assert.deepEqual(validateDecision(decision, table, { candidates: ['Zurich'] }), {
        ok: true,
        targetIndex: 1,
    });
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

checkAsync(
    'TYPE_TEXT 完全没有逐字候选时停下,status 为 text_unavailable 并指向 browser_fill',
    async () => {
        // goal 为空,**所有**可填字段的 name 也是空的 → 逐字候选真的一个都没有。
        const bare = {
            ...SNAPSHOT,
            elements: SNAPSHOT.elements.map((element) =>
                element.kind === 'typeable' ? { ...element, name: '' } : element,
            ),
        };
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
            snapshot: bare,
        });
        const result = await runWith(deps, { goal: '' });
        assert.equal(result.status, 'text_unavailable');
        // spec 要求这条结果**显式**把调用方指去 browser_fill 单步工具。
        assert.match(result.error, /browser_fill/);
        assert.equal(deps.executed.length, 0, '没有文本可填时不该执行任何动作');
        // 这一步从没走到校验(Jev 答的 `type_text_target` 是 '4'),而台账里只有**校验过**
        // 的目标 —— 记原始值会让读轨迹的人以为「已经确认要填 4 号元素」。
        const [step] = result.steps;
        assert.equal(step.operation, 'TYPE_TEXT');
        assert.equal(step.targetIndex, undefined, '没校验过的目标不该写进轨迹');
    },
);

checkAsync('没有逐字候选时 type_text_value 整问不发,回路照旧收在 text_unavailable', async () => {
    // 候选为空时那一问的 criteria 只能是空的 —— 发出去就是 400,回路连判断的机会都没有。
    // 省掉它之后回路必须**仍然**走 `text_unavailable`(那条分支只看候选,不看问没问)。
    const bare = {
        ...SNAPSHOT,
        elements: SNAPSHOT.elements.map((element) =>
            element.kind === 'typeable' ? { ...element, name: '' } : element,
        ),
    };
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
        snapshot: bare,
    });
    const seen = [];
    const result = await runLoop({
        goal: '',
        maxSteps: 12,
        budgetMs: 100000,
        now: deps.now,
        observe: deps.observe,
        decide: async ({ questions }) => {
            seen.push(questions);
            return deps.decide();
        },
        execute: deps.execute,
    });
    assert.equal(result.status, 'text_unavailable');
    assert.match(result.error, /browser_fill/);
    assert.equal(deps.executed.length, 0);
    assert.equal('type_text_value' in seen[0], false, '没有候选时那一问不该发出去');
    // 目标那问仍有 eligible(2 号 / 4 号可填),所以它照常发出 —— 两条问的取舍彼此独立。
    assert.ok('type_text_target' in seen[0]);
});

checkAsync('目标问被省掉的操作 → 重新观察,重试额度用尽后 status 为 error', async () => {
    // 页面没有任何 selectable 元素(典型真实页面):`select_target` 那一问被省掉。
    // Jev 若答 SELECT,回答里就没有目标 —— 与 B1 的「没答/解析不出」走同一条拒绝路径:
    // 重新观察,额度用尽即 error,**不是**静默 no-op。
    const noSelect = {
        ...SNAPSHOT,
        elements: SNAPSHOT.elements.filter((element) => element.kind !== 'selectable'),
    };
    const selectAnswer = {
        answers: {
            operation: { choice: 'SELECT', confidence: 0.9 },
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    };
    let observes = 0;
    const asks = [];
    const result = await runLoop({
        goal: 'g',
        maxSteps: 12,
        budgetMs: 100000,
        now: () => 0,
        observe: async () => {
            observes += 1;
            return noSelect;
        },
        decide: async ({ questions }) => {
            asks.push(questions);
            return selectAnswer;
        },
        execute: async () => {
            throw new Error('被省掉目标的操作一次都不该执行');
        },
    });
    assert.equal(result.status, 'error', '没有目标可选必须收在 error,不能静默放过');
    // MAX_VALIDATION_RETRIES = 2 → 三轮「观察 → 决策」,每轮都重新观察。
    assert.equal(observes, 3, '每一轮重试都要重新观察,不能拿旧快照接着问');
    assert.equal(asks.length, 3);
    for (const questions of asks) {
        assert.equal('select_target' in questions, false, '没有 selectable 元素时不该发目标问');
    }
    assert.match(result.error, /SELECT/);
    assert.deepEqual(result.steps, [], '被拒的轮次没有决策,不该记步');
});

check('目标那一问没发出时,理由必须说「本页没有可选目标」而不是「拿到 undefined」', () => {
    // 实测(维基搜索页,TYPE_TEXT):收场串原本是「需要一个整数目标,拿到 undefined」,
    // 读的人会以为 Jev 乱答。真实成因是 criteria 为空时那一问整问没发,模型没机会给目标。
    // 两种成因必须分开报,否则这条诊断没有价值。
    const table = buildElementTable(pageOf('clickable', 'clickable')); // 没有 typeable
    const decision = {
        operation: 'TYPE_TEXT',
        typeTextTarget: undefined,
        typeTextValue: undefined,
    };
    const result = validateDecision(decision, table, { candidates: ['Zurich'] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /没有可选目标/);
    assert.match(result.reason, /没有发出/);

    // 反过来:本页**有**可选目标却没拿到整数 → 仍按「模型没给」报,别混为一谈。
    const withTypeable = buildElementTable(pageOf('typeable'));
    const other = validateDecision(decision, withTypeable, { candidates: ['Zurich'] });
    assert.equal(other.ok, false);
    assert.match(other.reason, /需要一个整数目标/);
    assert.doesNotMatch(other.reason, /没有可选目标/);
});

/** 回路用例里反复用的一次 CLICK(1 号元素)。 */
const CLICK_ANSWER = {
    answers: {
        operation: { choice: 'CLICK', confidence: 0.9 },
        click_target: { choice: '1', confidence: 0.9 },
        goal_met: { noul: 0.1 },
        stuck: { noul: 0.1 },
    },
};

/** 「动作执行前的校验没过」:文案照 executeAction / elementHandle 的真实抛法写。 */
function staleError(from, to) {
    const error = new Error(`browser-operator: 页面在执行前变了(${from} → ${to})`);
    error.stale = true;
    return error;
}

checkAsync('动作执行前校验没过 → 重新观察重试,不直接以 error 收场(ADR-0009 决策点 6)', async () => {
    // 报告里观测到的现场:搜索结果页还在渲染,元素数 48 → 59。旧行为是整次调用以 error
    // 收场;ADR 决策点 6 与 executeAction 的注释都要求「重新观察,最多重试 2 次」。
    const deps = fakeDeps({ responses: [CLICK_ANSWER, CLICK_ANSWER] });
    let executes = 0;
    const result = await runWith(deps, {
        maxSteps: 2,
        execute: async () => {
            executes += 1;
            if (executes === 1) throw staleError('48|u|1', '59|u|1');
        },
    });
    assert.equal(result.status, 'max_steps', '重试成功后该由步数上界收场,不是 error');
    assert.equal(executes, 2, '第一次抛、第二次真的执行');
    assert.equal(result.steps.length, 2);
    assert.match(result.steps[1].reason, /执行前校验失败/, '被拒的原因要留在下一步的台账上');
});

checkAsync('动作执行前校验连续失败用尽额度 → status 为 error', async () => {
    // 额度 2 = 最多重试 2 次;连续第 3 次仍没过就收场,不能无界重试。
    const deps = fakeDeps({ responses: [CLICK_ANSWER, CLICK_ANSWER, CLICK_ANSWER, CLICK_ANSWER] });
    let observes = 0;
    let executes = 0;
    const result = await runWith(deps, {
        observe: async () => {
            observes += 1;
            return SNAPSHOT;
        },
        execute: async () => {
            executes += 1;
            throw staleError('1|u|1', '2|u|1');
        },
    });
    assert.equal(result.status, 'error');
    assert.equal(executes, 3, '额度 2 → 连抛 3 次才收场');
    assert.equal(observes, 3, '每次重试都重新观察,不拿旧快照接着问');
    assert.match(result.error, /执行前连续 3 次校验失败/);
});

checkAsync('真正的执行失败不重试:没有 stale 标记就立即收场', async () => {
    // 额度只给「动作执行前的校验」。点击超时这类失败若也重试,可能把同一次点击落两遍。
    const deps = fakeDeps({ responses: [CLICK_ANSWER, CLICK_ANSWER] });
    let executes = 0;
    const result = await runWith(deps, {
        execute: async () => {
            executes += 1;
            throw new Error('browser-operator: 点击超时');
        },
    });
    assert.equal(result.status, 'error');
    assert.equal(executes, 1, '没有 stale 标记就不该再试第二次');
    assert.match(result.error, /点击超时/);
});

checkAsync('token 用量按次累加:重试那几次也要算进去', async () => {
    // `systemOne` 每次返回都带 usage。重试同样要付钱,所以累加值必须覆盖全部请求 ——
    // 否则「Jev 这一步贵不贵」只能靠猜。
    const deps = fakeDeps({ responses: [CLICK_ANSWER, CLICK_ANSWER] });
    let calls = 0;
    const result = await runWith(deps, {
        maxSteps: 2,
        decide: async () => {
            calls += 1;
            return {
                ...CLICK_ANSWER,
                usage: { input_tokens: 1000 + calls, output_tokens: 200 + calls },
            };
        },
    });
    assert.equal(result.usage.calls, 2);
    assert.equal(result.usage.inputTokens, 1001 + 1002);
    assert.equal(result.usage.outputTokens, 201 + 202);
});

checkAsync('decide 不带 usage 时按 0 计,不产生 NaN', async () => {
    // usage 是可以缺的:测试注入的 decide、以及任何非 SDK 的实现都不会有它。
    // 缺了按 0 计,不能把整个结果污染成 NaN。
    const deps = fakeDeps({ responses: CLICK_THEN_DONE });
    const result = await runWith(deps);
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, calls: 2 });
});

/** 目标字段(4 号 textbox)的 name 是 'Departure';2 号 'Where from?' 是标签代表。 */
const TYPEABLE = SNAPSHOT;

/** 给第二问(选哪段文本)的回答。 */
const typeValueAnswer = (choice) => ({ type_text_value: { choice, confidence: 0.9 } });

/**
 * 一步 TYPE_TEXT:一次请求里同时答完 operation + 目标 + 选中的文本。
 *
 * `textChoice` 可以是**候选下标字符串**,也可以是数字 —— 数字会先按
 * `typeTextCandidates` 换成下标,让用例不必手数候选顺序。
 */
const typeTextStep = (textChoice) => ({
    answers: {
        operation: { choice: 'TYPE_TEXT', confidence: 0.9 },
        type_text_target: { choice: '4', confidence: 0.9 },
        ...typeValueAnswer(String(textChoice)),
        goal_met: { noul: 0.1 },
        stuck: { noul: 0.1 },
    },
});

/** 终止一步:DONE + 高 goal_met,让回路干净收尾。 */
const DONE_STEP = {
    answers: {
        operation: { choice: 'DONE', confidence: 0.95 },
        goal_met: { noul: 0.95 },
        stuck: { noul: 0.02 },
    },
};

checkAsync('回路输入的是 Jev 选中的那一份逐字片段,不是 candidates[0]', async () => {
    const goal = 'Fly from Zurich to London on 2026-09-20, one adult';
    const candidates = typeTextCandidates({ goal, element: TYPEABLE.elements[1] });
    const chosen = candidates.indexOf('London');
    assert.ok(chosen > 0, `'London' 不该排在候选第 0 位(candidates=${candidates.join('|')})`);
    const deps = fakeDeps({
        responses: [typeTextStep(chosen)],
        snapshot: TYPEABLE,
    });
    const result = await runWith(deps, { goal, maxSteps: 1 });
    assert.equal(result.status, 'max_steps');
    assert.equal(deps.executed.length, 1);
    assert.equal(deps.executed[0].operation, 'TYPE_TEXT');
    assert.equal(deps.executed[0].text, 'London', 'typed 的必须是 Jev 选的那份,不是第一个');
    assert.notEqual(deps.executed[0].text, candidates[0]);
});

checkAsync('文本那一问的候选 = goal 片段 + 页面字段标签', async () => {
    // 请求发出前目标字段还没定,所以字段标签那半截取的是第一个能切出片段的可填字段
    // (这里是 2 号 'Where from?' 的 'Where')。两半截都必须在 criteria 里。
    const seen = [];
    const deps = fakeDeps({
        responses: [typeTextStep(0), DONE_STEP],
        snapshot: TYPEABLE,
    });
    const result = await runLoop({
        goal: 'Fly from Zurich',
        maxSteps: 12,
        budgetMs: 100000,
        now: deps.now,
        observe: deps.observe,
        decide: async (request) => {
            seen.push(request.questions);
            return deps.decide();
        },
        execute: deps.execute,
    });
    assert.equal(result.status, 'done');
    const criteria = seen[0].type_text_value.criteria;
    assert.ok(
        Object.values(criteria).includes('Where'),
        '页面字段标签该进候选(那正是 spec 的「字段标签 / 占位符」那半截)',
    );
    assert.ok(Object.values(criteria).includes('Zurich'), 'goal 片段该进候选');
    assert.equal(seen.length, 2, '一次请求问完全部决策;第二条是终止那步');
});

checkAsync('goal 为空时,输入的是页面字段标签片段', async () => {
    // 字段标签那一半单独顶用:goal 一个片段都给不出,候选全部来自字段标签。
    const deps = fakeDeps({
        responses: [typeTextStep(0)],
        snapshot: TYPEABLE,
    });
    const result = await runWith(deps, { goal: '', maxSteps: 1 });
    assert.equal(result.status, 'max_steps');
    assert.equal(deps.executed.length, 1);
    assert.equal(deps.executed[0].text, 'Where');
});

checkAsync('TYPE_TEXT 越界的文本下标被拒,不回落到 candidates[0]', async () => {
    // 第 1、2 轮:文本下标越界 → 校验拒绝(不许静默取第一个)。
    // 第 3 轮:目标也过期了(元素表里没有 999)→ 再拒一次,重试额度用尽 → error。
    const staleTarget = {
        answers: {
            operation: { choice: 'TYPE_TEXT', confidence: 0.9 },
            type_text_target: { choice: '999', confidence: 0.9 },
            ...typeValueAnswer('0'),
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    };
    const over = typeTextStep(9);
    const deps = fakeDeps({
        responses: [over, over, staleTarget],
        snapshot: TYPEABLE,
    });
    const result = await runWith(deps, { goal: 'Fly Zurich', maxSteps: 6 });
    assert.equal(result.status, 'error');
    assert.equal(deps.executed.length, 0, '越界的下标一次都不该执行');
    assert.match(result.error, /9/);
});

checkAsync('回路里没答文本那一问 → 收在 error,绝不敲进 candidates[0]', async () => {
    // 三轮都答 TYPE_TEXT、目标合法,但**每次都没答「填哪段文本」**(标签整个缺失)。
    // 校验拒绝 → 重新观察;重试额度用尽 → error。这一条钉的是回路层面的结果:
    // 绝不能出现「敲了候选第一个」这种静默降级。
    const noTextAnswer = {
        answers: {
            operation: { choice: 'TYPE_TEXT', confidence: 0.9 },
            type_text_target: { choice: '4', confidence: 0.9 },
            goal_met: { noul: 0.1 },
            stuck: { noul: 0.1 },
        },
    };
    const goal = 'Fly from Zurich to London';
    const firstCandidate = typeTextCandidates({ goal, element: TYPEABLE.elements[1] })[0];
    const deps = fakeDeps({
        responses: [noTextAnswer, noTextAnswer, noTextAnswer],
        snapshot: TYPEABLE,
    });
    const result = await runWith(deps, { goal, maxSteps: 6 });
    assert.equal(result.status, 'error', '没答文本那一问必须收在 error');
    assert.equal(deps.executed.length, 0, '一次都不该执行,更不该敲进候选第一个');
    assert.match(result.error, /TYPE_TEXT/, '错误里要能看出是哪道闸拦的');
    assert.notEqual(firstCandidate, undefined, '这条用例的前提是确实存在候选');
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

checkAsync('provider 返回 null 时也给可读的凭证错误,不是 TypeError', async () => {
    // 只挡 undefined 时这里会抛 `Cannot read properties of null` —— 一句读不懂的栈,
    // 而调用方真正需要的是「去这两条路径配 key」。
    const credentials = { resolve: async () => null };
    await assert.rejects(
        () => resolveApiKey(credentials),
        (error) =>
            error.message.includes('TYPESAFE_API_KEY') &&
            !error.message.includes('Cannot read properties of null'),
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

check('browser_act 的 render 把 reason 带进模型可见的输出', () => {
    // 这个洞咬过两次:模型看到的是 render,不是 output.schema 声明的那份结构值。
    // 在此之前门禁里唯一碰 render 的断言只是 `typeof === 'function'` —— 从不调用它,
    // 所以「结构化值里有 reason、渲染时把它丢掉」这种事完全测不出来。
    const ctx = makeCtx();
    apply(ctx, {});
    const [block] = ctx.toolsByName.get('browser_act').output.render(
        { goal: 'g' },
        {
            status: 'error',
            steps: [
                { step: 1, operation: 'CLICK', targetIndex: 17, reason: '', confidence: 1 },
                {
                    step: 2,
                    operation: 'CLICK',
                    targetIndex: 17,
                    reason: '执行前校验失败:页面在执行前变了',
                    confidence: 0.78,
                },
            ],
            goalMet: 0,
            elapsedMs: 3580,
            usage: { inputTokens: 24394, outputTokens: 5538, calls: 3 },
            error: '动作执行前连续 3 次校验失败',
        },
    );
    assert.equal(block.type, 'text');
    const text = block.text;
    assert.match(text, /^error · 2 步 · goalMet=0 · 3580ms · Jev 3 次 24394 in \/ 5538 out/);
    assert.match(text, /动作执行前连续 3 次校验失败/);
    assert.match(text, /^1\. CLICK \[17\] \(1\)$/m, '没有 reason 的那步不该多出尾巴');
    assert.match(text, /执行前校验失败:页面在执行前变了/, '重试原因必须进模型可见的输出');
});

check('注册只发生在 apply 期,不在 apply 里解析凭证', () => {
    // makeCtx() 故意不提供 get() 之外的 credentials —— 若 apply 期解析就会抛。
    assert.doesNotThrow(() => apply(makeCtx(), {}));
});

check('browser_act 的描述向模型说清动作空间与 SELECT 的已知边界', () => {
    const ctx = makeCtx();
    apply(ctx, {});
    const description = ctx.toolsByName.get('browser_act').description;
    // 闭合的 8 个操作必须逐个出现在描述里(模型只看得到描述)。
    for (const operation of ACTION_SPACE) {
        assert.ok(description.includes(operation), `描述里少了 ${operation}`);
    }
    // SELECT 只取第一个选项是有意保留的边界,必须说在模型看得见的地方。
    assert.match(description, /SELECT [^。]*第一个选项/);
});

check('browser_act 的参数只有 goal 与 maxSteps', () => {
    const ctx = makeCtx();
    apply(ctx, {});
    const parameters = ctx.toolsByName.get('browser_act').parameters;
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['goal', 'maxSteps']);
    assert.deepEqual(parameters.required, ['goal']);
    assert.equal(parameters.additionalProperties, false);
});

check('配置里的 maxSteps / budgetMs / 两个载荷上限 非有限值在装载期就被拒(R1 的配置那一半)', () => {
    // 模型给的 maxSteps 由 argMaxSteps 挡;这里是**配置**那一半。两者都挡不住的话,
    // 非有限界会让 runLoop 永不返回,而且会饿死 Node 的 timer 阶段、从内部无法中断。
    // 注意:真正挡住非有限值的是 `positiveInt` / `maxStepsConfig`,**不是**调用点那句
    // `Math.min(...)` —— `Math.min(NaN, 119000)` 仍然是 NaN。
    for (const bad of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        0,
        -3,
        6.5,
    ]) {
        assert.throws(() => apply(makeCtx(), { maxSteps: bad }), /browser-operator:/);
        assert.throws(() => apply(makeCtx(), { budgetMs: bad }), /browser-operator:/);
        assert.throws(() => apply(makeCtx(), { maxElements: bad }), /browser-operator:/);
        assert.throws(() => apply(makeCtx(), { jevMaxTextChars: bad }), /browser-operator:/);
    }
    assert.doesNotThrow(() => apply(makeCtx(), { budgetMs: 100000, maxSteps: 12 }));
    // 两个回路载荷上限都有默认值:不配能跑,配小了也照样是正数。
    assert.doesNotThrow(() => apply(makeCtx(), { maxElements: 40, jevMaxTextChars: 800 }));
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

checkAsync('表外的 operation 一律抛,原型上的键也不是操作(R2 的门=那张表)', async () => {
    // 重构前这里是「一个字符串列表决定放行 + 一条 if 链决定怎么做」两处并列,链尾
    // 那个兜底抛错**任何已提交用例都到不了**(列表先放行,链就必然接得住)。现在放行与
    // 实现同出一张表(handler map),门就是查表 —— 这条用例走的正是那条路径。
    // `toString` / `__proto__` 是原型上的键:裸下标查表会把它们当成「已实现」放行。
    const page = {
        evaluate: () => {
            throw new Error('不该碰页面:operation 校验必须排在页面访问之前');
        },
    };
    for (const operation of ['NAVIGATE', 'DONE', 'BLOCKED', 'toString', '__proto__', '']) {
        await assert.rejects(
            () => executeAction({ operation, page, settings: {}, snapshot: {} }),
            /没有实现 operation/,
            `${operation} 不该被那张表认下`,
        );
    }
});

checkAsync('六个页面操作各自落到位(表驱动重构后行为不变)', async () => {
    // 表只有一个了,所以「表里有这一项」不再等于「真的做得对」—— 六个都真跑一遍,记下
    // 各自碰了页面的哪里。`WAIT` 的 1000 ms 是真的等,所以它放最后。
    const calls = [];
    const element = {
        click: async (options) => calls.push(['click', options.timeout]),
        fill: async (text, options) => calls.push(['fill', text, options.timeout]),
        selectOption: async (options, rest) => calls.push(['selectOption', options, rest.timeout]),
    };
    const snapshot = {
        url: 'https://example.test/list',
        title: 'list',
        freshness: '2|https://example.test/list|0',
        text: '',
        elements: [],
    };
    const page = {
        evaluate: async () => snapshot,
        evaluateHandle: async () => ({ asElement: () => element, dispose: async () => {} }),
        mouse: { wheel: async (x, y) => calls.push(['wheel', x, y]) },
    };
    const settings = { actionTimeoutMs: 1234 };

    await executeAction({ operation: 'CLICK', targetIndex: 2, page, settings, snapshot });
    await executeAction({
        operation: 'TYPE_TEXT',
        targetIndex: 2,
        text: 'Zurich',
        page,
        settings,
        snapshot,
    });
    await executeAction({ operation: 'SELECT', targetIndex: 2, page, settings, snapshot });
    await executeAction({ operation: 'SCROLL_UP', page, settings, snapshot });
    await executeAction({ operation: 'SCROLL_DOWN', page, settings, snapshot });
    // WAIT 不碰元素、不碰鼠标 —— 跑完上面五次调用之后 calls 不该再多一项。
    await executeAction({ operation: 'WAIT', page, settings, snapshot });

    assert.deepEqual(calls, [
        ['click', 1234],
        ['fill', 'Zurich', 1234],
        // SELECT 的已知限制:只取第 0 项,不挑值。
        ['selectOption', { index: 0 }, 1234],
        ['wheel', 0, -600],
        ['wheel', 0, 600],
    ]);
});

checkAsync('执行前重读快照:同 URL 下 freshness 变了就必须抛,不许点错元素', async () => {
    // 离线用假页面:readSnapshot 会经 page.evaluate 拿快照,这里按调用顺序喂两份。
    // 两次 URL 相同、freshness 不同 —— 正是「只比 URL」漏掉的那种页面变动
    // (同 URL 的 DOM 变化会让序号指向另一个元素,点错还记成成功)。
    const snapshotAt = (freshness) => ({
        url: 'https://example.com/list',
        title: 'list',
        freshness,
        text: '',
        elements: [],
    });
    const pageProbeSnapshots = [];
    let clicked = 0;
    const page = {
        evaluate: async () => {
            if (pageProbeSnapshots.length === 0) throw new Error('快照读取次数超出预期');
            return pageProbeSnapshots.shift();
        },
        evaluateHandle: async () => {
            throw new Error('不该解析元素:过期校验必须排在元素解析之前');
        },
    };

    pageProbeSnapshots.push(snapshotAt('3|https://example.com/list|120'));
    await assert.rejects(
        () =>
            executeAction({
                operation: 'CLICK',
                targetIndex: 2,
                page,
                settings: { actionTimeoutMs: 1000 },
                snapshot: snapshotAt('2|https://example.com/list|120'),
            }),
        /页面在执行前变了/,
    );

    // 反过来:新鲜度一致时动作照常执行(证明上面那条不是「永远抛」)。
    pageProbeSnapshots.push(snapshotAt('2|https://example.com/list|120'));
    page.evaluateHandle = async () => ({
        asElement: () => ({
            click: async () => {
                clicked += 1;
            },
        }),
    });
    await executeAction({
        operation: 'CLICK',
        targetIndex: 2,
        page,
        settings: { actionTimeoutMs: 1000 },
        snapshot: snapshotAt('2|https://example.com/list|120'),
    });
    assert.equal(clicked, 1, 'freshness 一致时该真的点到元素');
});

// 回路用例:全部登记完再统一 await,失败才算数(见 harness.mjs 的 checkAsync)。
// `run()` 之后就不能再登记用例了 —— 迟到的登记会抛错,不会变成假绿。
await run();
