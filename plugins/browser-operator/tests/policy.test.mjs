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
    renderElementTable,
} from '../lib/policy.js';

let passed = 0;
const failures = [];

function check(label, fn) {
    try {
        fn();
        passed += 1;
        console.log('ok - ' + label);
    } catch (error) {
        failures.push(`${label} :: ${error?.message ?? String(error)}`);
        console.error('not ok - ' + label + ' :: ' + (error?.message ?? String(error)));
    }
}

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

check('questions 只装当前合法的操作与目标', () => {
    const table = buildElementTable(SNAPSHOT);
    const questions = buildQuestions({ goal: 'g', table });
    assert.deepEqual(questions.operation.criteria, [...ACTION_SPACE]);
    assert.deepEqual(
        questions.click_target.criteria.map((c) => c.index),
        table.eligible.CLICK,
    );
    assert.deepEqual(
        questions.type_text_target.criteria.map((c) => c.index),
        table.eligible.TYPE_TEXT,
    );
});

check('没有合法目标时依然给出 questions(交给 Jev 选 DONE/BLOCKED)', () => {
    const table = buildElementTable({ elements: [] });
    const questions = buildQuestions({ goal: 'g', table });
    assert.deepEqual(questions.click_target.criteria, []);
    assert.deepEqual(questions.operation.criteria, [...ACTION_SPACE]);
});

check('questions 里带 goal_met 与 stuck 两个概率问题', () => {
    const questions = buildQuestions({ goal: 'g', table: buildElementTable(SNAPSHOT) });
    assert.equal(typeof questions.goal_met.instructions, 'string');
    assert.equal(typeof questions.stuck.instructions, 'string');
});

if (failures.length > 0) {
    console.error(`\n${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
    process.exit(1);
}
console.log(`\n全部通过:${passed} 项`);
