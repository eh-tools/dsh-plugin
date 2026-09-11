/**
 * dsh-file-git-explorer — 终端纯函数层测试(node:test)
 *
 * 运行: node tests/pty.test.mjs
 *
 * 覆盖: shell 绝对路径解析(Windows PATH 扫描 / 已知位置 / ComSpec 兜底;
 *       POSIX 的 $SHELL 必须绝对且存在)、cols/rows 钳制、控制帧编解码的
 *       脏数据防御、回放缓冲的绝对位寻址与 lossy 判定、终端池 LRU 淘汰。
 *
 * 全部用注入的 isFile 做存在判定, 因此不触碰真实文件系统, 沙箱内离线可跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveShellExecutable,
    clampSize,
    encodeControl,
    decodeControl,
    RingBuffer,
    TerminalPool,
    DEFAULT_COLS,
    DEFAULT_ROWS,
    MIN_COLS,
    MAX_COLS,
    MIN_ROWS,
    MAX_ROWS,
    REPLAY_CAP_BYTES,
    TERMINAL_POOL_CAP,
} from '../lib/pty.js';

const existsIn = (paths) => {
    const set = new Set(paths);
    return (p) => set.has(p);
};

// ---- shell 解析 ----

test('resolveShellExecutable: win32 按偏好扫 PATH, 产出绝对路径', () => {
    const env = { PATH: 'C:\\bin;D:\\tools', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    const isFile = existsIn(['C:\\bin\\pwsh.exe', 'C:\\Windows\\System32\\cmd.exe']);
    assert.equal(resolveShellExecutable('win32', env, isFile), 'C:\\bin\\pwsh.exe');
});

test('resolveShellExecutable: win32 偏好 pwsh.exe 优先于 powershell.exe', () => {
    const env = { PATH: 'D:\\tools' };
    const isFile = existsIn(['D:\\tools\\powershell.exe', 'D:\\tools\\pwsh.exe']);
    assert.equal(resolveShellExecutable('win32', env, isFile), 'D:\\tools\\pwsh.exe');
});

test('resolveShellExecutable: win32 PATH 不完整时退回已知安装位置', () => {
    const env = {
        PATH: '',
        ProgramFiles: 'C:\\Program Files',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    };
    const isFile = existsIn(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']);
    assert.equal(
        resolveShellExecutable('win32', env, isFile),
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    );
});

test('resolveShellExecutable: win32 全都找不到时退到 ComSpec, 无 ComSpec 则 null', () => {
    const nothing = () => false;
    const withComSpec = { PATH: '', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    assert.equal(
        resolveShellExecutable('win32', withComSpec, nothing),
        'C:\\Windows\\System32\\cmd.exe',
    );
    assert.equal(resolveShellExecutable('win32', { PATH: '' }, nothing), null);
});

test('resolveShellExecutable: POSIX 采用绝对且存在的 $SHELL', () => {
    const env = { SHELL: '/usr/bin/fish' };
    assert.equal(
        resolveShellExecutable('linux', env, existsIn(['/usr/bin/fish'])),
        '/usr/bin/fish',
    );
});

test('resolveShellExecutable: POSIX 忽略裸名 $SHELL, 走回退链', () => {
    const env = { SHELL: 'fish' };
    assert.equal(resolveShellExecutable('linux', env, existsIn(['/bin/bash'])), '/bin/bash');
});

test('resolveShellExecutable: POSIX 全都不存在时保底 /bin/sh', () => {
    assert.equal(
        resolveShellExecutable('linux', {}, () => false),
        '/bin/sh',
    );
});

// ---- 尺寸钳制 ----

test('clampSize: 钳制到 PTY 可接受区间, 非法值回落默认', () => {
    assert.deepEqual(clampSize(120, 40), { cols: 120, rows: 40 });
    assert.deepEqual(clampSize(0, 0), { cols: MIN_COLS, rows: MIN_ROWS });
    assert.deepEqual(clampSize(-5, -5), { cols: MIN_COLS, rows: MIN_ROWS });
    assert.deepEqual(clampSize(99999, 99999), { cols: MAX_COLS, rows: MAX_ROWS });
    assert.deepEqual(clampSize(undefined, undefined), { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    assert.deepEqual(clampSize('abc', 'abc'), { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    // 小数向下取整, 不产生半个字符格
    assert.deepEqual(clampSize(80.9, 24.9), { cols: 80, rows: 24 });
});

// ---- 控制帧 ----

test('encodeControl/decodeControl: 往返一致', () => {
    const msg = { t: 'resize', cols: 100, rows: 30 };
    assert.deepEqual(decodeControl(encodeControl(msg)), msg);
});

test('decodeControl: 脏数据一律返回 null 而不抛错', () => {
    assert.equal(decodeControl('not json'), null);
    assert.equal(decodeControl('[]'), null);
    assert.equal(decodeControl('"str"'), null);
    assert.equal(decodeControl('null'), null);
    assert.equal(decodeControl('{}'), null); // 缺 t
    assert.equal(decodeControl('{"t":""}'), null); // t 为空串
    assert.equal(decodeControl('{"t":"ping"}').t, 'ping');
});

// ---- 回放缓冲 ----

test('RingBuffer: 超上限从头部丢弃并推进绝对位', () => {
    const rb = new RingBuffer(5);
    assert.equal(rb.append('abc'), 0);
    assert.equal(rb.base, 0);
    assert.equal(rb.end, 3);
    assert.equal(rb.append('def'), 1); // 'abcdef' → 丢 'a'
    assert.equal(rb.base, 1);
    assert.equal(rb.end, 6);
    assert.equal(rb.buffer.toString(), 'bcdef');
});

test('RingBuffer: since 增量补发, 越界位置标记 lossy', () => {
    const rb = new RingBuffer(5);
    rb.append('abc');
    rb.append('def');
    // 客户端还在 0, 但 0 已被修剪 → lossy, 只能给现存内容
    const lossy = rb.since(0);
    assert.equal(lossy.bytes.toString(), 'bcdef');
    assert.equal(lossy.lossy, true);
    assert.equal(lossy.next, 6);
    // 客户端在 5 → 只给尾部 'f'
    const tail = rb.since(5);
    assert.equal(tail.bytes.toString(), 'f');
    assert.equal(tail.lossy, false);
    // 客户端已读到头 → 空
    const none = rb.since(6);
    assert.equal(none.bytes.length, 0);
    assert.equal(none.next, 6);
});

test('RingBuffer: 默认上限即 256KB 回放窗', () => {
    assert.equal(new RingBuffer().cap, REPLAY_CAP_BYTES);
});

test('RingBuffer: 单次写入超过上限时只留尾部', () => {
    const rb = new RingBuffer(4);
    rb.append('0123456789');
    assert.equal(rb.buffer.toString(), '6789');
    assert.equal(rb.base, 6);
    assert.equal(rb.end, 10);
});

// ---- 终端池 ----

test('TerminalPool: 超出上限按 LRU 淘汰并交回条目', () => {
    const pool = new TerminalPool(2);
    assert.equal(pool.cap, TERMINAL_POOL_CAP === 16 ? 2 : 2);
    pool.put('a', 1);
    pool.put('b', 2);
    pool.get('a'); // 触摸 a → 最久未用变成 b
    const evicted = pool.put('c', 3);
    assert.deepEqual(
        evicted.map((e) => e.key),
        ['b'],
    );
    assert.equal(pool.has('b'), false);
    assert.equal(pool.size, 2);
    assert.deepEqual(pool.keys(), ['c', 'a']); // 最近使用在前
});

test('TerminalPool: get/peek/delete 语义', () => {
    const pool = new TerminalPool(4);
    pool.put('a', { id: 'a' });
    assert.deepEqual(pool.get('a'), { id: 'a' });
    assert.deepEqual(pool.peek('a'), { id: 'a' });
    assert.equal(pool.get('missing'), undefined);
    assert.equal(pool.peek('missing'), undefined);
    assert.deepEqual(pool.delete('a'), { id: 'a' });
    assert.equal(pool.delete('a'), undefined);
    assert.equal(pool.size, 0);
});

test('TerminalPool: 重复 put 同一键不占两个名额', () => {
    const pool = new TerminalPool(1);
    pool.put('a', 1);
    pool.put('a', 2);
    assert.equal(pool.size, 1);
    assert.equal(pool.get('a'), 2);
});
