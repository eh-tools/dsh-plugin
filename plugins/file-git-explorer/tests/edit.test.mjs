/**
 * file-git-explorer 写类接口测试(save/create/rename/remove), 无 DSH 环境, 离线可跑
 *
 * 与 verify.mjs 同款 mock ctx 直调路由(不落真实仓库): 全部操作发生在临时目录,
 * 断言保存的乐观并发校验(mtimeMs/conflict/force)、body 上限按路由放宽、
 * 新建的父目录补建、重命名的名称校验与占用拒绝、删除的递归显式化、
 * 以及 .git 段防触与防穿越在写类接口上同样成立。
 * Run: node plugins/file-git-explorer/tests/edit.test.mjs
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

let capturedRoute = null;
const ctx = {
    get: () => undefined,
    webServer: {
        register: (r) => {
            capturedRoute = r;
        },
    },
};
apply(ctx);
assert.ok(capturedRoute, 'route /fge/api not registered');

function callAt(method, urlPath, body, headers) {
    return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = method;
        req.url = urlPath;
        req.headers = { host: '127.0.0.1:3080', 'x-dsh-plugin': '1', ...(headers || {}) };
        const res = {
            writeHead(status) {
                this.status = status;
            },
            end(payload) {
                resolve({ status: this.status, body: JSON.parse(payload) });
            },
        };
        capturedRoute.handler(req, res).catch(reject);
        if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
    });
}
// 原始字节流版(测 body 上限时绕过 JSON.stringify 组包自由度)
function callRaw(urlPath, rawBody) {
    return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = 'POST';
        req.url = urlPath;
        req.headers = { host: '127.0.0.1:3080', 'x-dsh-plugin': '1' };
        const res = {
            writeHead(status) {
                this.status = status;
            },
            end(payload) {
                resolve({
                    status: this.status,
                    body: payload === undefined ? null : JSON.parse(payload),
                });
            },
        };
        capturedRoute.handler(req, res).catch(reject);
        req.emit('data', Buffer.from(rawBody));
        req.emit('end');
    });
}
const base = (m) => '/fge/api/' + m;

let passed = 0;
function ok(name) {
    passed++;
    console.log('  ✓ ' + name);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fge-edit-'));
try {
    // 1. 保存: 经 create 建立嵌套文件后初次写入 → ok + size/mtimeMs 回传;
    //    save 本身不补建父目录(缺失父目录的 save 直接 write-failed, 由 create 负责)
    {
        const pre = await callAt('POST', base('create'), {
            root,
            path: 'notes/todo.md',
            kind: 'file',
        });
        assert.equal(pre.body.ok, true, '前置 create 应 ok');
        const r = await callAt('POST', base('save'), {
            root,
            path: 'notes/todo.md',
            content: 'hello\n',
        });
        assert.equal(r.body.ok, true, '首次保存应 ok: ' + JSON.stringify(r.body));
        assert.equal(r.body.size, 6);
        assert.ok(typeof r.body.mtimeMs === 'number');
        const back = await callAt('POST', base('file'), { root, path: 'notes/todo.md' });
        assert.equal(back.body.ok, true);
        assert.equal(back.body.text, 'hello\n');
        assert.equal(back.body.mtimeMs, r.body.mtimeMs, 'file 应回读同版本 mtimeMs');
        ok('save: 初次写入 + file 回读同版本');
    }

    // 2. 乐观并发: 旧 mtimeMs → conflict(带磁盘现状); force=true 覆盖; 新 mtimeMs 正常
    {
        const cur = await callAt('POST', base('file'), { root, path: 'notes/todo.md' });
        const staleMtime = cur.body.mtimeMs - 5000; // 人为"过期"的读取版本
        const conf = await callAt('POST', base('save'), {
            root,
            path: 'notes/todo.md',
            content: 'stale write\n',
            mtimeMs: staleMtime,
        });
        assert.equal(conf.body.ok, false);
        assert.equal(conf.body.error, 'conflict');
        assert.ok(
            Math.abs(conf.body.mtimeMs - cur.body.mtimeMs) <= 1,
            'conflict 应携带磁盘 mtimeMs',
        );

        const forced = await callAt('POST', base('save'), {
            root,
            path: 'notes/todo.md',
            content: 'forced\n',
            mtimeMs: staleMtime,
            force: true,
        });
        assert.equal(forced.body.ok, true, 'force 应跳过并发校验覆盖');

        const fresh = await callAt('POST', base('save'), {
            root,
            path: 'notes/todo.md',
            content: 'fresh\n',
            mtimeMs: forced.body.mtimeMs,
        });
        assert.equal(fresh.body.ok, true, '带最新 mtimeMs 的保存应正常');
        ok('save: 过期 conflict + force 覆盖 + 最新放行');
    }

    // 3. save 非法输入: content 缺失 / 二进制探测语义外(blob 名) / 相对 root / 穿越
    {
        const badContent = await callAt('POST', base('save'), {
            root,
            path: 'notes/x.md',
            content: 42,
        });
        assert.equal(badContent.body.error, 'invalid-content');
        const badPath = await callAt('POST', base('save'), {
            root,
            path: '../escape.md',
            content: 'x',
        });
        assert.equal(badPath.body.error, 'invalid-path');
        const outside = await callAt('POST', base('save'), {
            root: path.join(root, 'notes'),
            path: '../../outside.md',
            content: 'x',
        });
        assert.equal(outside.body.error, 'invalid-path');
        const gitTouch = await callAt('POST', base('save'), {
            root,
            path: '.git/config',
            content: '[evil]\n',
        });
        assert.equal(gitTouch.body.error, 'invalid-path', '.git 段不可写');
        ok('save: invalid-content/穿越/.git 段拒绝');
    }

    // 4. save 大小上限: >1MiB → too-large; 300KiB(超过通用 BODY_CAP)经放宽后成功
    {
        const overCap = await callAt('POST', base('save'), {
            root,
            path: 'big.txt',
            content: 'a'.repeat(1024 * 1024 + 1),
        });
        assert.equal(overCap.body.ok, false);
        assert.equal(overCap.body.error, 'too-large');
        const bigOk = await callAt('POST', base('save'), {
            root,
            path: 'big.txt',
            content: 'b'.repeat(300 * 1024),
        });
        assert.equal(bigOk.body.ok, true, '300KiB 内容应经放宽后的 body 上限通过');
        const st = fs.statSync(path.join(root, 'big.txt'));
        assert.equal(st.size, 300 * 1024);
        ok('save: too-large 上限 + save 路由 body 放宽生效');
    }

    // 5. body 硬上限仍守卫: 超 SAVE_BODY_CAP 的原始请求被拒(handler reject)
    {
        const huge = '{"path":"huge.txt","content":"' + 'c'.repeat(3 * 1024 * 1024) + '"}';
        await assert.rejects(
            () => callRaw(base('save'), huge),
            (err) => err instanceof Error,
            '超 save body 上限应拒收',
        );
        assert.ok(!fs.existsSync(path.join(root, 'huge.txt')));
        ok('body: 超上限请求被拒且未落盘');
    }

    // 6. create: 文件(父目录自动补建)/重复 exists/目录/根级 dotfile
    {
        const f = await callAt('POST', base('create'), {
            root,
            path: 'src/lib/new.ts',
            kind: 'file',
        });
        assert.equal(f.body.ok, true);
        assert.ok(fs.statSync(path.join(root, 'src/lib/new.ts')).isFile());
        const dup = await callAt('POST', base('create'), {
            root,
            path: 'src/lib/new.ts',
            kind: 'file',
        });
        assert.equal(dup.body.error, 'exists');
        const d = await callAt('POST', base('create'), { root, path: 'docs/api', kind: 'dir' });
        assert.equal(d.body.ok, true);
        assert.ok(fs.statSync(path.join(root, 'docs/api')).isDirectory());
        const dot = await callAt('POST', base('create'), {
            root,
            path: '.env.local',
            kind: 'file',
        });
        assert.equal(dot.body.ok, true, 'dotfile 可新建');
        const bad = await callAt('POST', base('create'), { root, path: 'a//b', kind: 'file' });
        assert.equal(bad.body.error, 'invalid-path');
        ok('create: 文件/目录/dotfile + exists/空段拒绝');
    }

    // 7. rename: 文件与整目录、目标占用、非法名(.git/..//' 含分隔符)
    {
        const r1 = await callAt('POST', base('rename'), {
            root,
            path: 'src/lib/new.ts',
            newName: 'renamed.ts',
        });
        assert.equal(r1.body.ok, true);
        assert.ok(fs.existsSync(path.join(root, 'src/lib/renamed.ts')));
        assert.ok(!fs.existsSync(path.join(root, 'src/lib/new.ts')));

        const dirRename = await callAt('POST', base('rename'), {
            root,
            path: 'src/lib',
            newName: 'clib',
        });
        assert.equal(dirRename.body.ok, true, '目录改名应带着子项整体移动');
        assert.ok(fs.existsSync(path.join(root, 'src/clib/renamed.ts')));

        const sibling = await callAt('POST', base('create'), {
            root,
            path: 'src/clib/other.txt',
            kind: 'file',
        });
        assert.equal(sibling.body.ok, true);
        const clash = await callAt('POST', base('rename'), {
            root,
            path: 'src/clib/renamed.ts',
            newName: 'other.txt',
        });
        assert.equal(clash.body.error, 'exists');
        for (const bad of ['..', '.git', 'a/b']) {
            const br = await callAt('POST', base('rename'), {
                root,
                path: 'src/clib/renamed.ts',
                newName: bad,
            });
            assert.equal(br.body.error, 'invalid-name', 'newName=' + bad + ' 应拒绝');
        }
        const missing = await callAt('POST', base('rename'), {
            root,
            path: 'no/such/file',
            newName: 'x',
        });
        assert.equal(missing.body.error, 'not-found');
        ok('rename: 文件/目录 + exists/invalid-name/not-found');
    }

    // 8. remove: 文件直接删; 目录需显式 recursive; not-found/根不可删
    {
        const emptyDir = await callAt('POST', base('remove'), { root, path: 'docs/api' });
        assert.equal(emptyDir.body.ok, true, '空目录无需 recursive 即可删');

        const nested = await callAt('POST', base('remove'), { root, path: 'src/clib' });
        assert.equal(nested.body.error, 'not-empty', '非空目录不递归时拒绝');
        const rec = await callAt('POST', base('remove'), {
            root,
            path: 'src/clib',
            recursive: true,
        });
        assert.equal(rec.body.ok, true, 'recursive=true 整树删除');
        assert.ok(!fs.existsSync(path.join(root, 'src/clib')));

        const nf = await callAt('POST', base('remove'), { root, path: 'ghost.txt' });
        assert.equal(nf.body.error, 'not-found');
        const rt = await callAt('POST', base('remove'), { root, path: '' });
        assert.equal(rt.body.error, 'invalid-path', '根目录不可删');
        const gitDir = await callAt('POST', base('remove'), {
            root,
            path: '.git',
            recursive: true,
        });
        assert.equal(gitDir.body.error, 'invalid-path', '.git 段不可删');
        const trav = await callAt('POST', base('remove'), { root, path: '../../outside' });
        assert.equal(trav.body.error, 'invalid-path');
        ok('remove: 文件/空目录/递归目录 + 根与 .git 段防护');
    }
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

console.log('\nEDIT API CHECKS PASSED (' + passed + ' groups)');
