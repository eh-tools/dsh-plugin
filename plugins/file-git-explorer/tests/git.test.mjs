/**
 * dsh-file-git-explorer — git 纯函数层测试(node:test)
 *
 * 运行: node tests/git.test.mjs   (或 node --test tests/)
 *
 * 覆盖: `git status --porcelain=v2 -z --branch` 的 header(初始 / 分离 / 上游 / ab)、
 *       1 / 2 / u / ? / ! 五种记录、**含空格路径**(最大坑, 见 lib/git.js 顶部)、
 *       rename 旧路径裸 token 与截断防御、XY 归一、徽标、排序、diff argv、
 *       log / numstat / rev-list 解析、ref / hash 白名单、路径穿越防护。
 *
 * 夹具全部是 Windows git 2.53.0 的**真实输出**(探针实测后原样抄录),
 * 不是手写臆想的格式 —— 这正是它抓得住"字段数差一"的原因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
    parseStatusV2,
    normalizeXY,
    statusBadge,
    sortChanges,
    diffArgs,
    resolveWithin,
    safeRef,
    safeHash,
    logArgs,
    parseLogOut,
    parseNumStatZ,
    parentsFromRevList,
    parseDiffHunks,
} from '../lib/git.js';

// ---- 夹具: 与真实输出逐字节一致(以 NUL 连接, 末尾保留 git 的收尾 NUL) ----

const RICH = [
    '# branch.oid 79a9c03deb78fa46b0c72fafc2a0f14a999e0ddb',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +1 -0',
    '1 AM N... 000000 100644 100644 0000000000000000000000000000000000000000 c9c6af7f78bc47490dbf3e822cf2f3c24d4b9061 both.txt',
    '1 .D N... 100644 100644 000000 286c5f5776916d7d7d5849988ca9d83e722cf9c2 286c5f5776916d7d7d5849988ca9d83e722cf9c2 deleted.txt',
    '2 R. N... 100644 100644 100644 4286f428e3b19fe84de503916ce0e7dc8deefea1 4286f428e3b19fe84de503916ce0e7dc8deefea1 R100 rename-to.txt',
    'rename-from.txt',
    '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 3e757656cf36eca53338e520d134963a44f793f8 staged-new.txt',
    '1 .M N... 100644 100644 100644 3eac62ec484a0c75051647a9b46e74cc30e292bc 3eac62ec484a0c75051647a9b46e74cc30e292bc sub dir/nested file.txt',
    '1 M. N... 100644 100644 100644 626799f0f85326a8c1fc522db584e86cdfccd51f 8c1384d825dbbe41309b7dc18ee7991a9085c46e tracked.txt',
    '1 .M N... 100644 100644 100644 ae9304576a6ec3419b231b2b9c8e33a06f97f9fb ae9304576a6ec3419b231b2b9c8e33a06f97f9fb 中文文件.txt',
    '? untracked.txt',
    '',
].join('\0');

const DETACHED = [
    '# branch.oid 79a9c03deb78fa46b0c72fafc2a0f14a999e0ddb',
    '# branch.head (detached)',
    '1 M. N... 100644 100644 100644 626799f0f85326a8c1fc522db584e86cdfccd51f 8c1384d825dbbe41309b7dc18ee7991a9085c46e tracked.txt',
    '',
].join('\0');

const EMPTY_REPO = ['# branch.oid (initial)', '# branch.head main', '? only.txt', ''].join('\0');

const CONFLICT = [
    '# branch.oid 1b457ee2a4eaca005b5c55c78fa9716d407fe753',
    '# branch.head main',
    'u UU N... 100644 100644 100644 100644 ab1e44b11851cf0e984ea49eaa21b315c55bb5b2 204118454f2cc15b4c4ef8317d7d93ea2e783d65 3785c0e4444345dfe6cac892afffa7107f0452cc both-modified.txt',
    'u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 ba2906d0666cf726c7eaadd2cd3db615dedfdf3a 2299c37978265a95cbe835a4b0f0bbf15aad5549 conflict.txt',
    '',
].join('\0');

const SPACED_RENAME_IGNORED = [
    '# branch.oid dee6237538d53965e5fe87d12a800d6904476243',
    '# branch.head main',
    '2 R. N... 100644 100644 100644 da0875b775d6a4f30a6b65a158e3de1834fcec80 da0875b775d6a4f30a6b65a158e3de1834fcec80 R100 new name.txt',
    'old name.txt',
    '! ignored thing.txt',
    '',
].join('\0');

// ---- header ----

test('parseStatusV2: header 解析(oid / head / upstream / ab)', () => {
    const { branch } = parseStatusV2(RICH);
    assert.equal(branch.oid, '79a9c03deb78fa46b0c72fafc2a0f14a999e0ddb');
    assert.equal(branch.head, 'main');
    assert.equal(branch.upstream, 'origin/main');
    assert.equal(branch.ahead, 1);
    assert.equal(branch.behind, 0);
    assert.equal(branch.initial, false);
    assert.equal(branch.detached, false);
});

test('parseStatusV2: 空仓库 header 为 (initial), oid 留 null', () => {
    const { branch, changes } = parseStatusV2(EMPTY_REPO);
    assert.equal(branch.oid, null);
    assert.equal(branch.initial, true);
    assert.equal(branch.head, 'main');
    assert.equal(branch.detached, false);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, 'untracked');
    assert.equal(changes[0].path, 'only.txt');
});

test('parseStatusV2: 分离 HEAD → detached, head 留 null, 无上游行也不崩', () => {
    const { branch } = parseStatusV2(DETACHED);
    assert.equal(branch.detached, true);
    assert.equal(branch.head, null);
    assert.equal(branch.upstream, null);
    assert.equal(branch.ahead, 0);
    assert.equal(branch.behind, 0);
});

// ---- 记录类型 ----

test('parseStatusV2: 1 / 2 / ? 三种记录 + 计数与顺序', () => {
    const { changes } = parseStatusV2(RICH);
    assert.equal(changes.length, 8);
    assert.deepEqual(
        changes.map((c) => [c.kind, c.path]),
        [
            ['ordinary', 'both.txt'],
            ['ordinary', 'deleted.txt'],
            ['renamed', 'rename-to.txt'],
            ['ordinary', 'staged-new.txt'],
            ['ordinary', 'sub dir/nested file.txt'],
            ['ordinary', 'tracked.txt'],
            ['ordinary', '中文文件.txt'],
            ['untracked', 'untracked.txt'],
        ],
    );
});

test('parseStatusV2: ⚠含空格路径必须整段保留(不能只取最后一段)', () => {
    const { changes } = parseStatusV2(RICH);
    const spaced = changes.find((c) => c.kind === 'ordinary' && c.path.includes('nested'));
    assert.equal(spaced.path, 'sub dir/nested file.txt');
    // 这正是"按官方文档字段数直接数"会踩的坑: 差一后路径只剩最后一段。
    assert.notEqual(spaced.path, 'file.txt');
});

test('parseStatusV2: rename 的旧路径是紧随的裸 token(可含空格)', () => {
    const { changes } = parseStatusV2(SPACED_RENAME_IGNORED);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, 'renamed');
    assert.equal(changes[0].path, 'new name.txt');
    assert.equal(changes[0].origPath, 'old name.txt');
    assert.equal(changes[0].score, 'R100');
});

test('parseStatusV2: 被忽略的 ! 行不进入变更列表', () => {
    const { changes } = parseStatusV2(SPACED_RENAME_IGNORED);
    assert.equal(
        changes.some((c) => c.path.includes('ignored')),
        false,
    );
});

test('parseStatusV2: rename 旧路径 token 孤悬(输出截断)时留 null 且不臆造条目', () => {
    const truncated = [
        '# branch.oid deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        '# branch.head main',
        '2 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 new name.txt',
        '',
    ].join('\0');
    const { changes } = parseStatusV2(truncated);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].origPath, null);
    assert.equal(changes[0].path, 'new name.txt');
});

test('parseStatusV2: 未合并 u 行(9 个固定字段)解析为 U 徽标', () => {
    const { changes } = parseStatusV2(CONFLICT);
    assert.equal(changes.length, 2);
    assert.deepEqual(
        changes.map((c) => [c.kind, c.badge, c.path]),
        [
            ['unmerged', 'U', 'both-modified.txt'],
            ['unmerged', 'U', 'conflict.txt'],
        ],
    );
});

test('parseStatusV2: 字段不足的截断行被跳过而不是抛错', () => {
    const broken = ['# branch.oid abc', '# branch.head main', '1 M. N... 100644', ''].join('\0');
    const { changes } = parseStatusV2(broken);
    assert.deepEqual(changes, []);
});

// ---- XY 归一 / 徽标 ----

test('normalizeXY: v2 的 `.` 归一为 v1 空格形态', () => {
    assert.equal(normalizeXY('.M'), ' M');
    assert.equal(normalizeXY('A.'), 'A ');
    assert.equal(normalizeXY('.D'), ' D');
    assert.equal(normalizeXY('M.'), 'M ');
    assert.equal(normalizeXY('AM'), 'AM');
    assert.equal(normalizeXY('??'), '??');
});

test('parseStatusV2: xy 归一后已暂存 / 未暂存可判', () => {
    const { changes } = parseStatusV2(RICH);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.xy]));
    assert.equal(byPath['tracked.txt'], 'M '); // 仅已暂存
    assert.equal(byPath['sub dir/nested file.txt'], ' M'); // 仅工作区
    assert.equal(byPath['both.txt'], 'AM'); // 两边都有
});

test('statusBadge: 优先级 R > C > A > D > M > U', () => {
    assert.equal(statusBadge('R '), 'R');
    assert.equal(statusBadge('RM'), 'R');
    assert.equal(statusBadge('C '), 'C');
    assert.equal(statusBadge('A '), 'A');
    assert.equal(statusBadge(' D'), 'D');
    assert.equal(statusBadge(' M'), 'M');
    assert.equal(statusBadge('UU'), 'U');
    assert.equal(statusBadge('??'), 'U');
});

// ---- 排序 / digest ----

test('sortChanges: 未跟踪沉底, 其余按 zh-CN 排序, 不改原数组', () => {
    const { changes } = parseStatusV2(RICH);
    const sorted = sortChanges(changes);
    assert.equal(sorted.length, changes.length);
    assert.equal(sorted[sorted.length - 1].path, 'untracked.txt');
    assert.equal(changes[0].path, 'both.txt');
});

test('diffArgs: 普通条目单路径; rename 同时给新旧两路径', () => {
    assert.deepEqual(diffArgs({ path: 'a.txt', origPath: null }), [
        '-c',
        'core.quotepath=false',
        'diff',
        'HEAD',
        '-M',
        '--',
        'a.txt',
    ]);
    assert.deepEqual(diffArgs({ path: 'new name.txt', origPath: 'old name.txt' }), [
        '-c',
        'core.quotepath=false',
        'diff',
        'HEAD',
        '-M',
        '--',
        'new name.txt',
        'old name.txt',
    ]);
    // 条目缺旧路径时用兜底 from
    assert.deepEqual(diffArgs({ path: 'n.txt', origPath: null }, 'o.txt').slice(-2), [
        'n.txt',
        'o.txt',
    ]);
});

// ---- 路径安全 ----

test('resolveWithin: 允许 base 之内, 拒绝越出', () => {
    const base = process.platform === 'win32' ? 'C:\\repo' : '/repo';
    assert.equal(resolveWithin(base, 'a/b.txt'), join(base, 'a', 'b.txt'));
    assert.equal(resolveWithin(base, '../outside.txt'), null);
    assert.equal(resolveWithin(base, 'a/../../outside.txt'), null);
    assert.equal(resolveWithin(base, ''), base);
});

// ---- ref / hash 白名单 ----

test('safeRef: 拒绝选项注入与区间语法', () => {
    assert.equal(safeRef('main'), true);
    assert.equal(safeRef('origin/main'), true);
    assert.equal(safeRef('v1.2.3'), true);
    assert.equal(safeRef('--upload-pack=evil'), false);
    assert.equal(safeRef('-x'), false);
    assert.equal(safeRef('main..dev'), false);
    assert.equal(safeRef('HEAD@{1}'), false);
    assert.equal(safeRef('a b'), false);
    assert.equal(safeRef(''), false);
    assert.equal(safeRef(null), false);
});

test('safeHash: 仅接受 7~64 位十六进制', () => {
    assert.equal(safeHash('79a9c03'), true);
    assert.equal(safeHash('79a9c03deb78fa46b0c72fafc2a0f14a999e0ddb'), true);
    assert.equal(safeHash('79a9c0'), false);
    assert.equal(safeHash('zzzzzzz'), false);
    assert.equal(safeHash('--help'), false);
});

// ---- 提交列表 ----

test('logArgs: skip 钳制 ≥0, limit 钳制 1..500, 非法 ref 缺省 HEAD', () => {
    const args = logArgs('main', -5, 1000);
    assert.ok(args.includes('--skip=0'));
    assert.ok(args.includes('500'));
    assert.equal(args[args.length - 1], 'main');

    // limit 为 0 / 缺失时回落到默认 50
    assert.ok(logArgs('main', 0, 0).includes('50'));

    // 非法 ref 不追加, 末尾即 limit
    const noRef = logArgs('--evil', 0, 5);
    assert.equal(noRef[noRef.length - 1], '5');
    assert.equal(noRef.includes('--evil'), false);
});

test('parseLogOut: NUL 分隔字段, 坏行跳过', () => {
    const text = [
        'full1\u0000sh1\u0000Alice\u00001700000000\u0000first commit',
        'full2\u0000sh2\u0000Bob\u00001700000001\u0000second',
        'bad',
    ].join('\n');
    const commits = parseLogOut(text);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0], {
        hash: 'full1',
        short: 'sh1',
        author: 'Alice',
        at: 1700000000,
        subject: 'first commit',
    });
});

test('parseNumStatZ: 普通 / rename(两裸 token) / 二进制归一', () => {
    const text = [
        'HASH',
        '10\t2\tpath/a.txt',
        '3\t0\t',
        'old name.txt',
        'new name.txt',
        '-\t-\tbin.dat',
        '',
    ].join('\0');
    const stats = parseNumStatZ(text);
    assert.equal(stats.length, 3);
    assert.deepEqual(stats[0], { adds: 10, dels: 2, path: 'path/a.txt' });
    assert.deepEqual(stats[1], { adds: 3, dels: 0, path: 'new name.txt', from: 'old name.txt' });
    assert.deepEqual(stats[2], { adds: null, dels: null, path: 'bin.dat' });
});

test('parentsFromRevList: 父提交数(首个 token 是自身)', () => {
    assert.equal(parentsFromRevList('abc'), 0);
    assert.equal(parentsFromRevList('abc p1'), 1);
    assert.equal(parentsFromRevList('abc p1 p2'), 2);
    assert.equal(parentsFromRevList(''), null);
});

// ---- 统一 diff → hunk(官方 DiffBlock 的 diffs 形状) ----
//
// 夹具同样是 Windows git 2.53.0 的真实输出。三个只有真输出才暴露的坑:
//   · `\ No newline at end of file` 是**行后的标记行**, 不是内容 —— 必须丢掉;
//   · 路径含空格/非 ASCII 时 `--- a/<路径>` 后面会**补一个 TAB** 作分隔;
//   · `core.quotepath=true` 时路径会被 C 风格引号包起来(本插件 host 一直传
//     `-c core.quotepath=false`, 但解析器不能因此就假设永不出现引号)。

const DIFF_MOD_TWO_HUNKS = [
    'diff --git a/mod.txt b/mod.txt',
    'index 0cd7b95..fc72b6d 100644',
    '--- a/mod.txt',
    '+++ b/mod.txt',
    '@@ -1,5 +1,5 @@',
    ' line 1',
    '-line 2',
    '+line 2 changed',
    ' line 3',
    ' line 4',
    ' line 5',
    '@@ -16,5 +16,5 @@ line 15',
    ' line 16',
    ' line 17',
    ' line 18',
    '-line 19',
    '+line 19 changed',
    ' line 20',
    '',
].join('\n');

const DIFF_NEW_FILE = [
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 0000000..824f3ce',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+n1',
    '+n2',
    '',
].join('\n');

const DIFF_DELETED = [
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    'index b5eff57..0000000',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-a',
    '-b',
    '-c',
    '',
].join('\n');

// rename 且内容有变、两侧路径都带空格: 注意 `--- a/ren old.txt\t` 的尾随 TAB。
const DIFF_RENAME_SPACED = [
    'diff --git a/ren old.txt b/ren new.txt',
    'similarity index 50%',
    'rename from ren old.txt',
    'rename to ren new.txt',
    'index 415a78b..29f1ccd 100644',
    '--- a/ren old.txt\t',
    '+++ b/ren new.txt\t',
    '@@ -1,3 +1,4 @@',
    ' x',
    ' y',
    ' z',
    '+w',
    '',
].join('\n');

const DIFF_MODE_ONLY = [
    'diff --git a/mode.txt b/mode.txt',
    'old mode 100644',
    'new mode 100755',
    '',
].join('\n');

const DIFF_BINARY = [
    'diff --git a/bin.dat b/bin.dat',
    'index a18d99c..8d4219a 100644',
    'Binary files a/bin.dat and b/bin.dat differ',
    '',
].join('\n');

const DIFF_NO_NEWLINE_EOF = [
    'diff --git a/nonl.txt b/nonl.txt',
    'index 1c943a9..36ef1ba 100644',
    '--- a/nonl.txt',
    '+++ b/nonl.txt',
    '@@ -1,3 +1,3 @@',
    ' a',
    '-b',
    '+B',
    ' c',
    '\\ No newline at end of file',
    '',
].join('\n');

const DIFF_UNICODE_SPACED = [
    'diff --git a/uni 中文.txt b/uni 中文.txt',
    'index 7a754f4..5f5fbe7 100644',
    '--- a/uni 中文.txt\t',
    '+++ b/uni 中文.txt\t',
    '@@ -1,2 +1,3 @@',
    ' 1',
    '-2',
    '\\ No newline at end of file',
    '+2',
    '+3',
    '\\ No newline at end of file',
    '',
].join('\n');

// core.quotepath=true 的形态: 路径被引号包住且非 ASCII 走八进制转义。
const DIFF_QUOTED_PATH = [
    'diff --git "a/uni \\344\\270\\255\\346\\226\\207.txt" "b/uni \\344\\270\\255\\346\\226\\207.txt"',
    'index 7a754f4..5f5fbe7 100644',
    '--- "a/uni \\344\\270\\255\\346\\226\\207.txt"\t',
    '+++ "b/uni \\344\\270\\255\\346\\226\\207.txt"\t',
    '@@ -1,2 +1,3 @@',
    ' 1',
    '-2',
    '\\ No newline at end of file',
    '+2',
    '+3',
    '\\ No newline at end of file',
    '',
].join('\n');

test('parseDiffHunks: 同一文件的两个 hunk 各自成一条, 路径取 b/ 侧', () => {
    const hunks = parseDiffHunks(DIFF_MOD_TWO_HUNKS);
    assert.equal(hunks.length, 2);
    assert.deepEqual(hunks[0], {
        path: 'mod.txt',
        oldText: 'line 1\nline 2\nline 3\nline 4\nline 5\n',
        newText: 'line 1\nline 2 changed\nline 3\nline 4\nline 5\n',
    });
    assert.deepEqual(hunks[1], {
        path: 'mod.txt',
        oldText: 'line 16\nline 17\nline 18\nline 19\nline 20\n',
        newText: 'line 16\nline 17\nline 18\nline 19 changed\nline 20\n',
    });
});

test('parseDiffHunks: 新增文件的旧侧为空串(不是 null, 也不是一行空内容)', () => {
    const hunks = parseDiffHunks(DIFF_NEW_FILE);
    assert.deepEqual(hunks, [{ path: 'new.txt', oldText: '', newText: 'n1\nn2\n' }]);
});

test('parseDiffHunks: 删除文件的新侧为空串, 路径回落到 a/ 侧', () => {
    const hunks = parseDiffHunks(DIFF_DELETED);
    assert.deepEqual(hunks, [{ path: 'gone.txt', oldText: 'a\nb\nc\n', newText: '' }]);
});

test('parseDiffHunks: rename+改动取新路径, 且去掉路径尾随的 TAB', () => {
    const hunks = parseDiffHunks(DIFF_RENAME_SPACED);
    assert.deepEqual(hunks, [
        { path: 'ren new.txt', oldText: 'x\ny\nz\n', newText: 'x\ny\nz\nw\n' },
    ]);
});

test('parseDiffHunks: 只有 mode 变化或二进制 → 没有任何 hunk', () => {
    assert.deepEqual(parseDiffHunks(DIFF_MODE_ONLY), []);
    assert.deepEqual(parseDiffHunks(DIFF_BINARY), []);
});

test('parseDiffHunks: 丢掉 "\\ No newline at end of file" 标记行', () => {
    assert.deepEqual(parseDiffHunks(DIFF_NO_NEWLINE_EOF), [
        { path: 'nonl.txt', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' },
    ]);
});

test('parseDiffHunks: 非 ASCII + 空格的未加引号路径', () => {
    assert.deepEqual(parseDiffHunks(DIFF_UNICODE_SPACED), [
        { path: 'uni 中文.txt', oldText: '1\n2\n', newText: '1\n2\n3\n' },
    ]);
});

test('parseDiffHunks: C 风格引号路径解回原样(防御 quotepath 未关时)', () => {
    assert.deepEqual(parseDiffHunks(DIFF_QUOTED_PATH), [
        { path: 'uni 中文.txt', oldText: '1\n2\n', newText: '1\n2\n3\n' },
    ]);
});

test('parseDiffHunks: 整份多文件 diff 按文件顺序铺开, 无 hunk 的文件不占位', () => {
    const all = [
        DIFF_BINARY,
        DIFF_DELETED,
        DIFF_MOD_TWO_HUNKS,
        DIFF_MODE_ONLY,
        DIFF_NEW_FILE,
        DIFF_RENAME_SPACED,
    ].join('');
    const hunks = parseDiffHunks(all);
    assert.deepEqual(
        hunks.map((h) => h.path),
        ['gone.txt', 'mod.txt', 'mod.txt', 'new.txt', 'ren new.txt'],
    );
});

test('parseDiffHunks: 空输入 / 纯噪声输入', () => {
    assert.deepEqual(parseDiffHunks(''), []);
    assert.deepEqual(parseDiffHunks('not a diff at all\n'), []);
});

test('parseDiffHunks: 每个 hunk 的行数与 @@ 头声明的增删数一致', () => {
    // 不变量: oldText 的行数 = 该 hunk 的 old 侧行数, newText 同理。
    const count = (text) => (text === '' ? 0 : text.split('\n').length - 1);
    for (const fixture of [
        DIFF_MOD_TWO_HUNKS,
        DIFF_NEW_FILE,
        DIFF_DELETED,
        DIFF_RENAME_SPACED,
        DIFF_NO_NEWLINE_EOF,
        DIFF_UNICODE_SPACED,
        DIFF_QUOTED_PATH,
    ]) {
        const declared = [...fixture.matchAll(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)].map(
            (m) => [m[1] === undefined ? 1 : Number(m[1]), m[2] === undefined ? 1 : Number(m[2])],
        );
        const hunks = parseDiffHunks(fixture);
        assert.equal(hunks.length, declared.length, 'hunk 数应与 @@ 头数一致');
        hunks.forEach((hunk, i) => {
            assert.equal(
                count(hunk.oldText),
                declared[i][0],
                '第 ' + String(i) + ' 个 hunk 的旧侧行数',
            );
            assert.equal(
                count(hunk.newText),
                declared[i][1],
                '第 ' + String(i) + ' 个 hunk 的新侧行数',
            );
        });
    }
});
