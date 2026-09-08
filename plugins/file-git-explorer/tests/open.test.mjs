/**
 * dsh-file-git-explorer — 「在系统资源管理器中打开」纯函数层测试(node:test)
 *
 * 运行: node tests/open.test.mjs
 *
 * 覆盖: 三平台 × 目录/文件 的 argv 映射(Windows /select 选中、macOS -R、
 *       Linux 文件退化为所在目录), 以及根路径/无分隔符的边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTargetArgv } from '../lib/open.js';

test('openTargetArgv: win32 目录直开 / 文件 /select 选中', () => {
    assert.deepEqual(openTargetArgv('win32', 'E:\\repo\\src', true), ['explorer', 'E:\\repo\\src']);
    assert.deepEqual(openTargetArgv('win32', 'E:\\repo\\src\\a.ts', false), [
        'explorer',
        '/select,E:\\repo\\src\\a.ts',
    ]);
});

test('openTargetArgv: darwin 目录 open / 文件 open -R', () => {
    assert.deepEqual(openTargetArgv('darwin', '/repo/src', true), ['open', '/repo/src']);
    assert.deepEqual(openTargetArgv('darwin', '/repo/src/a.ts', false), [
        'open',
        '-R',
        '/repo/src/a.ts',
    ]);
});

test('openTargetArgv: linux 目录 xdg-open / 文件打开所在目录', () => {
    assert.deepEqual(openTargetArgv('linux', '/repo/src', true), ['xdg-open', '/repo/src']);
    assert.deepEqual(openTargetArgv('linux', '/repo/src/a.ts', false), ['xdg-open', '/repo/src']);
    // 无分隔符的裸名 → 退化为自身(host 侧本就不会出现, 仅保证不崩)
    assert.deepEqual(openTargetArgv('linux', 'a.ts', false), ['xdg-open', 'a.ts']);
});
