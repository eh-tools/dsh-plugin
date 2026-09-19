/**
 * browser-operator 的离线单测 —— 不需要浏览器、不需要网络、不需要 API key。
 *
 * 运行: node plugins/browser-operator/tests/policy.test.mjs
 *
 * 这个文件进 `just check`(见 justfile / 根 package.json 的三处接线)。
 * 会真的拉起浏览器的 tests/smoke.mjs 不在这里,也不在门禁里。
 */

import assert from 'node:assert/strict';

import { ACTION_SPACE, STATUS, buildElementTable, renderElementTable } from '../lib/policy.js';

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

if (failures.length > 0) {
    console.error(`\n${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
    process.exit(1);
}
console.log(`\n全部通过:${passed} 项`);
