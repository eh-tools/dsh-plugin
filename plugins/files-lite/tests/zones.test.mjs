/**
 * dsh-files-lite — 纯函数层测试(node:test)
 *
 * 运行: node tests/zones.test.mjs
 *
 * 覆盖: 路径键拼接(尾分隔符 / 空父 / 混合分隔符)、dotfile 判定与 `.`/`..` 边界、
 *       `.git` 在任何开关下都不显示、「显示隐藏文件」开与关的过滤结果、
 *       目录优先 + zh-CN 名称序, 以及脏条目的防御。
 *
 * 被测逻辑与 lib/client.js 里的内联副本同源(bundle 无法 import host ESM),
 * 本文件即两边共享的可执行规约 —— 改其一时必须同步另一处。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinChild, isHiddenName, shouldShow, sortEntries, visibleEntries } from '../lib/zones.js';

test('joinChild: 一律用 `/` 连接, 并吃掉父路径的尾分隔符', () => {
    assert.equal(joinChild('/repo/src', 'a.ts'), '/repo/src/a.ts');
    assert.equal(joinChild('C:\\repo\\src', 'a.ts'), 'C:\\repo\\src/a.ts');
    assert.equal(joinChild('/repo/src/', 'a.ts'), '/repo/src/a.ts');
    assert.equal(joinChild('/repo/src\\\\', 'a.ts'), '/repo/src/a.ts');
    assert.equal(joinChild('', 'a.ts'), 'a.ts');
    assert.equal(joinChild(undefined, 'a.ts'), 'a.ts');
});

test('isHiddenName: dotfile 判定与 `.` / `..` 边界', () => {
    assert.equal(isHiddenName('.env'), true);
    assert.equal(isHiddenName('.git'), true);
    assert.equal(isHiddenName('.gitignore'), true);
    assert.equal(isHiddenName('.'), false);
    assert.equal(isHiddenName('..'), false);
    assert.equal(isHiddenName('a.txt'), false);
    assert.equal(isHiddenName('a.b'), false);
    assert.equal(isHiddenName(''), false);
    assert.equal(isHiddenName(undefined), false);
});

test('shouldShow: `.git` 在任何开关下都不显示', () => {
    assert.equal(shouldShow('.git', true), false);
    assert.equal(shouldShow('.git', false), false);
});

test('shouldShow: 开关关 = 隐藏 dotfile; 开 = 全部显示', () => {
    assert.equal(shouldShow('.env', false), false);
    assert.equal(shouldShow('.env', true), true);
    assert.equal(shouldShow('a.txt', false), true);
    assert.equal(shouldShow('a.txt', true), true);
    assert.equal(shouldShow('', true), false);
});

test('sortEntries: 目录优先, 同级按 zh-CN 名称序', () => {
    const sorted = sortEntries([
        { name: 'b.txt', type: 'file' },
        { name: 'zdir', type: 'directory' },
        { name: 'a.txt', type: 'file' },
        { name: 'adir', type: 'directory' },
    ]);
    assert.deepEqual(
        sorted.map((e) => e.name),
        ['adir', 'zdir', 'a.txt', 'b.txt'],
    );
});

test('visibleEntries: 关开关时滤掉 dotfile 与 .git, 且不改入参', () => {
    const input = [
        { name: '.env', type: 'file' },
        { name: '.git', type: 'directory' },
        { name: 'src', type: 'directory' },
        { name: 'a.txt', type: 'file' },
    ];
    const before = input.slice();
    const got = visibleEntries(input, false);
    assert.deepEqual(
        got.map((e) => e.name),
        ['src', 'a.txt'],
    );
    assert.deepEqual(input, before, '不应改写入参数组');
});

test('visibleEntries: 开开关时显示 dotfile 但仍不显示 .git', () => {
    const got = visibleEntries(
        [
            { name: '.env', type: 'file' },
            { name: '.git', type: 'directory' },
            { name: 'a.txt', type: 'file' },
        ],
        true,
    );
    assert.deepEqual(
        got.map((e) => e.name),
        ['.env', 'a.txt'],
    );
});

test('visibleEntries: 脏条目(null / 非对象 / 无名)被丢弃而不是抛错', () => {
    const got = visibleEntries(
        [null, undefined, 'nope', 42, { name: '', type: 'file' }, { name: 'ok.txt', type: 'file' }],
        true,
    );
    assert.deepEqual(
        got.map((e) => e.name),
        ['ok.txt'],
    );
});

test('visibleEntries: 非数组输入退化为空数组', () => {
    assert.deepEqual(visibleEntries(undefined, true), []);
    assert.deepEqual(visibleEntries(null, false), []);
});
