/**
 * dsh-file-git-explorer — 文件地址纯函数层测试(node:test)
 *
 * 运行: node tests/address.test.mjs
 *
 * 覆盖: `dsh-resource://file/…` 地址解析(session / absolute 两种 scope、
 *       Windows 盘符、UNC、百分号编码、查询串与 fragment 被忽略、各类非法地址)、
 *       扩展名提取(含无扩展名与 Windows 反斜杠路径)、
 *       「可复制原文」判据(markdown/文本/代码为真, html/pdf/图片为假)、
 *       以及 Remote 读取结果的多种返回形状归一。
 *
 * 被测逻辑与 lib/client.js 里「复制内容」芯片的内联副本同源(bundle 无法 import host ESM),
 * 本文件即两边共享的可执行规约 —— 改其一时必须同步另一处。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseFileAddress,
    extensionOf,
    isCopyableSource,
    extractDocumentText,
} from '../lib/address.js';

test('parseFileAddress: session scope 解出 sessionId 与绝对路径', () => {
    assert.deepEqual(parseFileAddress('dsh-resource://file/session/s1/home/me/b.md'), {
        scope: 'session',
        sessionId: 's1',
        path: 'home/me/b.md',
    });
});

test('parseFileAddress: 百分号编码的段会解码', () => {
    assert.deepEqual(parseFileAddress('dsh-resource://file/session/s1/a%20b/%E4%B8%AD.md'), {
        scope: 'session',
        sessionId: 's1',
        path: 'a b/中.md',
    });
});

test('parseFileAddress: 查询串与 fragment 被忽略', () => {
    const expected = { scope: 'session', sessionId: 's1', path: 'a.md' };
    assert.deepEqual(parseFileAddress('dsh-resource://file/session/s1/a.md?rev=1'), expected);
    assert.deepEqual(parseFileAddress('dsh-resource://file/session/s1/a.md#L10'), expected);
});

test('parseFileAddress: absolute scope 的 POSIX 与 Windows 盘符', () => {
    assert.deepEqual(parseFileAddress('dsh-resource://file/absolute/home/me/a.md'), {
        scope: 'absolute',
        path: '/home/me/a.md',
    });
    assert.deepEqual(parseFileAddress('dsh-resource://file/absolute/C%3A/repo/a.md'), {
        scope: 'absolute',
        path: 'C:/repo/a.md',
    });
});

test('parseFileAddress: absolute scope 的 UNC 前缀', () => {
    assert.deepEqual(parseFileAddress('dsh-resource://file/absolute//server/share/a.md'), {
        scope: 'absolute',
        path: '//server/share/a.md',
    });
});

test('parseFileAddress: 非法地址一律 null', () => {
    assert.equal(parseFileAddress('dsh-resource://file/session/s1'), null, '缺路径段');
    assert.equal(parseFileAddress('dsh-resource://file/session//a.md'), null, '空 sessionId');
    assert.equal(parseFileAddress('dsh-resource://file/other/x.md'), null, '未知 scope');
    assert.equal(parseFileAddress('https://example.com/a.md'), null, '非文件地址');
    assert.equal(parseFileAddress('dsh-resource://file/session/s1/%'), null, '非法百分号编码');
    assert.equal(parseFileAddress(''), null);
    assert.equal(parseFileAddress(null), null);
    assert.equal(parseFileAddress(undefined), null);
});

test('extensionOf: 小写扩展名, 无扩展名与非常规路径', () => {
    assert.equal(extensionOf('/repo/a.md'), 'md');
    assert.equal(extensionOf('/repo/A.MD'), 'md');
    assert.equal(extensionOf('C:\\repo\\a.TXT'), 'txt');
    assert.equal(extensionOf('/repo/Makefile'), '');
    assert.equal(extensionOf('/repo/.gitignore'), '', '纯 dotfile 不算扩展名');
    assert.equal(extensionOf('/repo/a.'), '');
    assert.equal(extensionOf(''), '');
});

test('isCopyableSource: markdown / 文本 / 代码为真', () => {
    assert.equal(isCopyableSource('/repo/README.md'), true);
    assert.equal(isCopyableSource('/repo/notes.txt'), true);
    assert.equal(isCopyableSource('/repo/main.ts'), true);
    assert.equal(isCopyableSource('/repo/config.yaml'), true);
});

test('isCopyableSource: html / pdf / 图片为假(没有"原始文本"可复制)', () => {
    assert.equal(isCopyableSource('/repo/page.html'), false);
    assert.equal(isCopyableSource('/repo/doc.pdf'), false);
    assert.equal(isCopyableSource('/repo/pic.png'), false);
    assert.equal(isCopyableSource('/repo/pic.JPEG'), false);
    assert.equal(isCopyableSource('/repo/icon.svg'), false);
    assert.equal(isCopyableSource('/repo/Makefile'), false, '无扩展名不出复制图标');
});

test('extractDocumentText: 兼容多种返回形状', () => {
    const bytes = new TextEncoder().encode('# 标题\n');
    assert.equal(extractDocumentText('# 标题\n'), '# 标题\n', '直接字符串');
    assert.equal(extractDocumentText({ ok: true, value: { bytes } }), '# 标题\n', 'value.bytes');
    assert.equal(
        extractDocumentText({ ok: true, value: { data: bytes } }),
        '# 标题\n',
        'value.data 是字节',
    );
    assert.equal(extractDocumentText({ ok: true, value: { text: 'hi' } }), 'hi', 'value.text');
    assert.equal(extractDocumentText({ value: bytes }), '# 标题\n', '无 ok 包裹');
    assert.equal(extractDocumentText(bytes), '# 标题\n', '裸 Uint8Array');
    assert.equal(extractDocumentText(Array.from(bytes)), '# 标题\n', 'number[]');
});

test('extractDocumentText: remote.workspaceFiles.readAll 的 base64 data 要按字节解', () => {
    // 真实契约(见 dsh-api-remotes 的 readAll result schema + documentpreview 的 documentFileBytes):
    //   { ok: true, value: { offset, data: <base64>, eof, absolutePath, version, bytes? } }
    const text = '# 标题\n\n中文与 emoji: 🐳\n';
    const base64 = Buffer.from(text, 'utf8').toString('base64');
    const result = {
        ok: true,
        value: {
            offset: 0,
            data: base64,
            eof: true,
            absolutePath: '/repo/README.md',
            version: 'v1',
            bytes: Buffer.byteLength(text, 'utf8'),
        },
    };
    assert.equal(extractDocumentText(result), text, 'base64 必须解码成 UTF-8 原文');
    assert.notEqual(extractDocumentText(result), base64, '绝不能把 base64 串本身当原文');

    // 裸 value(无 ok 包裹)同样要解
    assert.equal(extractDocumentText({ data: base64 }), text);
});

test('extractDocumentText: data 不是合法 base64 时退回原字符串', () => {
    // 有些实现把 data 直接放明文; atob 会抛错, 此时不该丢内容。
    assert.equal(extractDocumentText({ ok: true, value: { data: 'plain text' } }), 'plain text');
    assert.equal(extractDocumentText({ ok: true, value: { data: '中文' } }), '中文');
});

test('extractDocumentText: 失败或无法识别返回 null', () => {
    assert.equal(extractDocumentText({ ok: false, error: 'nope' }), null);
    assert.equal(extractDocumentText(null), null);
    assert.equal(extractDocumentText(undefined), null);
    assert.equal(extractDocumentText(42), null);
    assert.equal(extractDocumentText({ ok: true, value: {} }), null);
});
