/**
 * dsh-file-git-explorer — shell 行纯函数层测试(node:test)
 *
 * 运行: node --test tests/
 *
 * 覆盖: 用户默认 shell 解析(win/POSIX、$SHELL 缺失与不可执行回退)、
 *       历史追加(相邻去重 + 上限)、尾部缓冲(保尾弃头 + base 移位)、
 *       绝对位增量切片(无新内容 / lossy)、命令串校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveShellArgv,
    pushHistory,
    appendTail,
    sliceSince,
    validShellCommand,
    SHELL_HISTORY_CAP,
} from '../lib/shell.js';

const yes = () => true;
const no = () => false;

test('resolveShellArgv: POSIX 取 $SHELL 并用 -c', () => {
    const r = resolveShellArgv('darwin', '/opt/homebrew/bin/fish', yes);
    assert.deepEqual(r, {
        argv: ['/opt/homebrew/bin/fish', '-c'],
        shell: '/opt/homebrew/bin/fish',
    });
    const z = resolveShellArgv('linux', '/bin/zsh\n', yes); // 尾部空白容忍
    assert.equal(z.argv[1], '-c');
    assert.equal(z.shell, '/bin/zsh');
});

test('resolveShellArgv: $SHELL 空缺 → /bin/sh', () => {
    assert.deepEqual(resolveShellArgv('linux', undefined, yes), {
        argv: ['/bin/sh', '-c'],
        shell: '/bin/sh',
    });
    assert.deepEqual(resolveShellArgv('linux', '   ', yes).shell, '/bin/sh');
    assert.deepEqual(resolveShellArgv('linux', '', no).shell, '/bin/sh');
});

test('resolveShellArgv: $SHELL 不可执行 → /bin/sh 回退', () => {
    const r = resolveShellArgv('darwin', '/usr/bin/fish', (p) => p !== '/usr/bin/fish');
    assert.deepEqual(r, { argv: ['/bin/sh', '-c'], shell: '/bin/sh' });
});

test('resolveShellArgv: win32 pwsh 优先, 否则 powershell; 旗标 -Command', () => {
    assert.deepEqual(
        resolveShellArgv('win32', undefined, (n) => n === 'pwsh'),
        {
            argv: ['pwsh', '-Command'],
            shell: 'pwsh',
        },
    );
    // POSIX 值不影响 win 分支; canExec 全否 → powershell 保底
    const fb = resolveShellArgv('win32', '/usr/bin/fish', no);
    assert.deepEqual(fb, { argv: ['powershell', '-Command'], shell: 'powershell' });
});

test('pushHistory: 追加 + 相邻去重 + 上限截断(不改入参)', () => {
    assert.deepEqual(pushHistory([], 'a'), ['a']);
    assert.deepEqual(pushHistory(['a', 'b'], 'b'), ['a', 'b']);
    const src = ['x'];
    const out = pushHistory(src, 'y');
    assert.deepEqual(out, ['x', 'y']);
    assert.deepEqual(src, ['x']);
    let list = [];
    for (let i = 0; i < SHELL_HISTORY_CAP + 10; i++) list = pushHistory(list, 'c' + i);
    assert.equal(list.length, SHELL_HISTORY_CAP);
    assert.equal(list[0], 'c10'); // 头部截掉前 10 条
    assert.equal(list[list.length - 1], 'c109');
});

test('appendTail: 未超限原样拼接; 超限保尾弃头并报告丢弃数', () => {
    assert.deepEqual(appendTail('', 'abc', 10), { buffer: 'abc', dropped: 0 });
    assert.deepEqual(appendTail('abc', 'def', 10), { buffer: 'abcdef', dropped: 0 });
    const r = appendTail('abcde', 'fghij', 5);
    assert.equal(r.buffer, 'fghij');
    assert.equal(r.dropped, 5); // abc + fghij = 10 → 截回 5, 丢前 5 个字符
});

test('sliceSince: 正常增量 / 无新内容 / lossy(位置已被修剪)', () => {
    // base=0, buffer='hello'
    let base = 0;
    let buf = 'hello';
    let seg = sliceSince(buf, base, 0);
    assert.deepEqual(
        { text: seg.text, next: seg.next, lossy: seg.lossy },
        {
            text: 'hello',
            next: 5,
            lossy: false,
        },
    );
    // 客户端已读到 3 → 只有 'lo'
    seg = sliceSince(buf, base, 3);
    assert.equal(seg.text, 'lo');
    assert.equal(seg.next, 5);
    // 客户端追平 → 无新内容, next 维持请求位
    seg = sliceSince(buf, base, 5);
    assert.deepEqual({ text: seg.text, next: seg.next }, { text: '', next: 5 });
    // 追加触发修剪: appendTail('hello','world…', cap) 后 base 右移
    const app = appendTail(buf, 'XY', 4);
    buf = app.buffer; // 'loXY'
    base += app.dropped; // 3
    seg = sliceSince(buf, base, 2); // 请求位 2 < base 3 → lossy, 从现存头部给起
    assert.equal(seg.lossy, true);
    assert.equal(seg.text, 'loXY');
    assert.equal(seg.next, 7);
    seg = sliceSince(buf, base, 7); // 追平
    assert.deepEqual({ text: seg.text, next: seg.next }, { text: '', next: 7 });
    // 非法输入钳制
    assert.equal(sliceSince(buf, base, NaN).text, 'loXY');
    assert.equal(sliceSince(buf, base, -5).lossy, true);
});

test('validShellCommand: 空白拒绝 / trim / 长度上限', () => {
    assert.equal(validShellCommand('  git status  '), 'git status');
    assert.equal(validShellCommand('   '), null);
    assert.equal(validShellCommand(undefined), null);
    assert.equal(validShellCommand(42), null);
    assert.equal(validShellCommand('x'.repeat(4001)), null);
    assert.equal(validShellCommand('x'.repeat(4000)), 'x'.repeat(4000));
});
