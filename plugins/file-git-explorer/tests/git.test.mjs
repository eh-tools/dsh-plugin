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
    searchZone,
    dirsFromPaths,
    matchEntries,
    safeRef,
    safeHash,
    logArgs,
    parseLogOut,
    parseNumStatZ,
    parentsFromRevList,
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

test('partitionChildren: ignored 桥接(subIgnored 目录在非 reveal 时可达深层忽略项)', () => {
    const entries = [
        { name: 'src', type: 'dir', dot: false, ignored: false, subIgnored: true },
        { name: 'plain', type: 'dir', dot: false, ignored: false },
        { name: 'node_modules', type: 'dir', dot: false, ignored: true },
    ];
    const r1 = partitionChildren(entries, 'ignored', false);
    assert.deepEqual(
        r1.list.map((e) => e.name),
        ['node_modules', 'src'],
    );
    // reveal 时仍为全量(含无桥接标记的普通项)
    const r2 = partitionChildren(entries, 'ignored', true);
    assert.deepEqual(
        r2.list.map((e) => e.name),
        ['node_modules', 'plain', 'src'],
    );
});

test('partitionChildren: 桥接不污染 visible/hidden 分桶', () => {
    const entries = [
        { name: 'src', type: 'dir', dot: false, ignored: false, subIgnored: true },
        { name: '.cfg', type: 'dir', dot: true, ignored: false, subIgnored: true },
        { name: '.env', type: 'file', dot: true, ignored: false },
    ];
    assert.deepEqual(
        partitionChildren(entries, 'visible', false).list.map((e) => e.name),
        ['src'],
    );
    // dot + subIgnored 仍归 hidden 桶(隐藏区成员资格不受桥接影响)
    assert.deepEqual(
        partitionChildren(entries, 'hidden', false).list.map((e) => e.name),
        ['.cfg', '.env'],
    );
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

// ---- 文件搜索(name search)纯函数 ----

test('searchZone: 忽略 > 点段 > 可见(任一路径段以点开头即隐藏)', () => {
    assert.equal(searchZone('src/a.js', false), 'visible');
    assert.equal(searchZone('.env', false), 'hidden');
    assert.equal(searchZone('src/.env', false), 'hidden');
    assert.equal(searchZone('.github/workflows/ci.yml', false), 'hidden');
    assert.equal(searchZone('node_modules/x/index.js', true), 'ignored');
    assert.equal(searchZone('.cache/f', true), 'ignored');
});

test('dirsFromPaths: 从文件路径推导去重后的目录列表', () => {
    assert.deepEqual(dirsFromPaths(['a/b/c.js', 'a/d.js', 'top.txt']), ['a', 'a/b']);
    assert.deepEqual(dirsFromPaths([]), []);
    assert.deepEqual(dirsFromPaths(['x/y/z.js', 'x/y/w.js']), ['x', 'x/y']);
    assert.deepEqual(dirsFromPaths(['single.js']), []);
});

test('matchEntries: 大小写不敏感子串命中, 名字命中优先于仅路径命中, 再按短路径', () => {
    const entries = [
        { rel: 'lib/util/a.js', type: 'file', zone: 'visible' },
        { rel: 'util.js', type: 'file', zone: 'visible' },
        { rel: 'src/utils/util-core.js', type: 'file', zone: 'visible' },
        { rel: 'src/main.js', type: 'dir', zone: 'visible' },
        { rel: 'docs/guide/UTILS.md', type: 'file', zone: 'hidden' },
    ];
    const r = matchEntries(entries, 'util');
    assert.deepEqual(
        r.map((e) => e.rel),
        ['util.js', 'docs/guide/UTILS.md', 'src/utils/util-core.js', 'lib/util/a.js'],
    );
    // 命中项保留原字段并标注是否名字命中
    assert.equal(r[0].nameHit, true);
    assert.equal(r[0].zone, 'visible');
    assert.equal(r[3].nameHit, false);
});

test('matchEntries: 空查询与全不命中返回空数组', () => {
    const entries = [{ rel: 'a.js', type: 'file', zone: 'visible' }];
    assert.deepEqual(matchEntries(entries, ''), []);
    assert.deepEqual(matchEntries(entries, '   '), []);
    assert.deepEqual(matchEntries(entries, 'zzz-none'), []);
});

// ---- 提交历史(commit history)纯函数 ----

test('safeRef/safeHash: 拒绝选项注入与非法字符', () => {
    assert.equal(safeRef('main'), true);
    assert.equal(safeRef('origin/foo'), true);
    assert.equal(safeRef('feature/dev-1.0'), true);
    assert.equal(safeRef('-web'), false); // 选项注入
    assert.equal(safeRef('--exec=x'), false);
    assert.equal(safeRef('a..b'), false); // 区间语法
    assert.equal(safeRef('has space'), false);
    assert.equal(safeRef('HEAD@{1}'), false); // reflog 语法
    assert.equal(safeRef(''), false);
    assert.equal(safeRef(null), false);
    assert.equal(safeHash('abc1234'), true);
    assert.equal(safeHash('ABCDEF0123456789abcdef0123456789abcdef01'), true);
    assert.equal(safeHash('xyz'), false);
    assert.equal(safeHash('abc;rm'), false);
    assert.equal(safeHash(''), false);
});

test('logArgs: ref 缺省 HEAD, skip/limit 钳制为安全整数', () => {
    const base = ['-c', 'core.quotepath=false', 'log', '--format=%H%x00%h%x00%an%x00%at%x00%s'];
    assert.deepEqual(logArgs(null, 0, 50), [...base, '--skip=0', '-n', '50']);
    assert.deepEqual(logArgs('origin/dev', 100, 50), [
        ...base,
        '--skip=100',
        '-n',
        '50',
        'origin/dev',
    ]);
    // 非法输入钳制: 负数→0, 超大 limit→500
    assert.ok(logArgs(null, -5, 99999).join(' ').includes('--skip=0'));
    assert.ok(logArgs(null, 0, 99999).join(' ').includes('-n 500'));
});

test('parseLogOut: NUL 字段解析, 坏行跳过', () => {
    const l1 = ['abc123full', 'abc123', '张三', '1700000000', 'feat: 初版'].join('\0');
    const l2 = ['def456full', '7890', '李四', '1700000100', 'fix(x): 修复崩溃'].join('\0');
    const commits = parseLogOut([l1, 'broken-line-no-sep', l2, ''].join('\n'));
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0], {
        hash: 'abc123full',
        short: 'abc123',
        author: '张三',
        at: 1700000000,
        subject: 'feat: 初版',
    });
    assert.equal(commits[1].short, '7890');
    assert.deepEqual(parseLogOut(''), []);
});

test('parseNumStatZ: 普通条目 / 二进制占位 / rename 双路径(实测 -z 形状)', () => {
    // 形状已在真实仓库实测: hash\0 + "A\tD\t<路径>\0"; rename 为 "A\tD\t\0旧\0新\0"
    const raw = [
        'f5b5ab52723cc418',
        '12\t3\tsrc/a.js',
        '-\t-\timg.png',
        '0\t0\t', // rename: 计数 token 路径位为空
        'old-dir/old-name.txt',
        'new-dir/new-name.txt',
        '',
    ].join('\0');
    const stats = parseNumStatZ(raw);
    assert.deepEqual(stats, [
        { adds: 12, dels: 3, path: 'src/a.js' },
        { adds: null, dels: null, path: 'img.png' },
        { adds: 0, dels: 0, path: 'new-dir/new-name.txt', from: 'old-dir/old-name.txt' },
    ]);
});

test('parentsFromRevList: 由 rev-list --parents 输出计父提交数', () => {
    assert.equal(parentsFromRevList('h1 p1 p2'), 2);
    assert.equal(parentsFromRevList('h1 p1'), 1);
    assert.equal(parentsFromRevList('h1'), 0);
    assert.equal(parentsFromRevList(''), null);
});
