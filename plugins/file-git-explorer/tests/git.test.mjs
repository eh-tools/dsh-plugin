/**
 * dsh-file-git-explorer — 纯函数层测试(node:test)
 *
 * 运行: node --test tests/
 *
 * 覆盖: status -z 解析(含 rename 双 token 编码)、状态徽标、路径防穿越、
 *       三区划分与 reveal 语义、单文件 diff 参数构造。
 * 说明: git 集成行为(porcelain/check-ignore 输出形状)已在开发时用真实仓库
 *       实测钉死, 见 README「实现事实」; 本测试不 spawn git, 保证沙箱内可跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
    parseStatusZ,
    statusBadge,
    resolveWithin,
    partitionChildren,
    diffArgs,
    isDotName,
} from '../lib/git.js';

test('isDotName', () => {
    assert.equal(isDotName('.env'), true);
    assert.equal(isDotName('.git'), true);
    assert.equal(isDotName('a.txt'), false);
    assert.equal(isDotName('.'), false); // 单点不是 dotfile
    assert.equal(isDotName('..'), false);
    assert.equal(isDotName(''), false);
});

test('parseStatusZ: 普通条目(暂存/未暂存/未跟踪)', () => {
    const entries = parseStatusZ(' M src/a.js\0A  src/b.js\0?? untracked.log\0');
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0], { xy: ' M', path: 'src/a.js' });
    assert.deepEqual(entries[1], { xy: 'A ', path: 'src/b.js' });
    assert.deepEqual(entries[2], { xy: '??', path: 'untracked.log' });
});

test('parseStatusZ: rename 双 token 编码(R 新路径 + 裸旧路径)', () => {
    const entries = parseStatusZ('R  new.txt\0old.txt\0 M x.js\0');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].xy, 'R ');
    assert.equal(entries[0].path, 'new.txt');
    assert.equal(entries[0].from, 'old.txt');
    assert.equal(entries[1].xy, ' M');
});

test('parseStatusZ: 双状态 MM 与空串过滤', () => {
    const entries = parseStatusZ('MM both.js\0');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].xy, 'MM');
    assert.equal(entries[0].path, 'both.js');
    const empty = parseStatusZ('');
    assert.deepEqual(empty, []);
});

test('statusBadge: R > C > A > D > M > U', () => {
    assert.equal(statusBadge('R '), 'R');
    assert.equal(statusBadge(' C'), 'C');
    assert.equal(statusBadge('A '), 'A');
    assert.equal(statusBadge(' D'), 'D');
    assert.equal(statusBadge(' M'), 'M');
    assert.equal(statusBadge('MM'), 'M');
    assert.equal(statusBadge('??'), 'U');
});

test('resolveWithin: 基目录内合法, 穿越返回 null', () => {
    const base = path.join(process.cwd(), 'fge-test-repo');
    assert.equal(resolveWithin(base, ''), base);
    assert.equal(resolveWithin(base, 'a/b.txt'), path.join(base, 'a', 'b.txt'));
    assert.equal(resolveWithin(base, '..'), null);
    assert.equal(resolveWithin(base, '../secret'), null);
    assert.equal(resolveWithin(base, 'a/../../secret'), null);
});

test('partitionChildren: visible 只含可见项', () => {
    const entries = [
        { name: 'a.txt', type: 'file', dot: false, ignored: false },
        { name: '.env', type: 'file', dot: true, ignored: false },
        { name: 'node_modules', type: 'dir', dot: false, ignored: true },
    ];
    const r = partitionChildren(entries, 'visible', false);
    assert.deepEqual(
        r.list.map((e) => e.name),
        ['a.txt'],
    );
});

test('partitionChildren: hidden 默认只含 dot 项, reveal 时含全部', () => {
    const entries = [
        { name: 'a.txt', type: 'file', dot: false, ignored: false },
        { name: '.env', type: 'file', dot: true, ignored: false },
        { name: '.config', type: 'dir', dot: true, ignored: false },
    ];
    const r1 = partitionChildren(entries, 'hidden', false);
    assert.deepEqual(
        r1.list.map((e) => e.name),
        ['.config', '.env'],
    );
    const r2 = partitionChildren(entries, 'hidden', true);
    assert.equal(r2.list.length, 3);
});

test('partitionChildren: ignored 默认只含忽略项, reveal 时含全部(含点文件)', () => {
    const entries = [
        { name: 'node_modules', type: 'dir', dot: false, ignored: true },
        { name: '.cache', type: 'dir', dot: true, ignored: true },
        { name: 'a.txt', type: 'file', dot: false, ignored: false },
    ];
    const r1 = partitionChildren(entries, 'ignored', false);
    assert.deepEqual(
        r1.list.map((e) => e.name),
        ['.cache', 'node_modules'],
    );
    const r2 = partitionChildren(entries, 'ignored', true);
    assert.equal(r2.list.length, 3);
});

test('partitionChildren: 目录优先, 组内按名称排序', () => {
    const entries = [
        { name: 'z.txt', type: 'file', dot: false, ignored: false },
        { name: 'alpha', type: 'dir', dot: false, ignored: false },
        { name: 'beta', type: 'dir', dot: false, ignored: false },
    ];
    const r = partitionChildren(entries, 'visible', false);
    assert.deepEqual(
        r.list.map((e) => e.name),
        ['alpha', 'beta', 'z.txt'],
    );
});

test('diffArgs: 普通文件与 rename', () => {
    assert.deepEqual(diffArgs({ path: 'a.js' }, 'M'), [
        '-c',
        'core.quotepath=false',
        'diff',
        'HEAD',
        '--',
        'a.js',
    ]);
    assert.deepEqual(diffArgs({ path: 'new.js', from: 'old.js' }, 'R'), [
        '-c',
        'core.quotepath=false',
        'diff',
        'HEAD',
        '-M',
        '--',
        'new.js',
        'old.js',
    ]);
    assert.deepEqual(diffArgs({ path: 'gone.js' }, 'D'), [
        '-c',
        'core.quotepath=false',
        'diff',
        'HEAD',
        '--',
        'gone.js',
    ]);
});
