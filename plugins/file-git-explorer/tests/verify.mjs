/**
 * file-git-explorer host 逻辑冒烟测试(真实 git, 无 DSH 环境, 离线可跑)
 *
 * 直接 import 静态双半插件的 lib/index.js, 用 mock ctx(webServer 捕获路由 +
 * 真实 child_process 充当 subprocess 服务)挂载, 再经注册的 HTTP 路由全链路
 * 校验 info / tree(三区划分与 reveal) / status / diff / file / 防穿越 / 信任栅栏。
 *
 * 前置: cwd 必须是一个 git 仓库(仓库自身即是); git 在 PATH 中。
 * 断言与仓库工作区状态无关(不依赖当前分支名、不依赖未提交变更)。
 * Run: node plugins/file-git-explorer/tests/verify.mjs
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

// ---- fake subprocess: 真实 child_process spawn + 收集输出 ----
function fakeSubprocess() {
    return {
        spawn(spec) {
            const cp = spawn(spec.argv[0], spec.argv.slice(1), {
                cwd: spec.cwd,
                env: { ...process.env, ...(spec.env || {}) },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let out = '';
            let err = '';
            cp.stdout.on('data', (d) => {
                out += d.toString('utf8');
            });
            cp.stderr.on('data', (d) => {
                err += d.toString('utf8');
            });
            const done = new Promise((resolve, reject) => {
                cp.on('error', reject);
                cp.on('close', (code) => resolve({ exitCode: code, signal: null }));
            });
            return {
                done,
                stdin: cp.stdin,
                collected: {
                    stdout: { readFrom: () => ({ text: out }) },
                    stderr: { readFrom: () => ({ text: err }) },
                },
                terminate: () => cp.kill(),
            };
        },
    };
}

let capturedRoute = null;
const ctx = {
    get: (name) => (name === 'subprocess' ? fakeSubprocess() : undefined),
    webServer: {
        register: (r) => {
            capturedRoute = r;
        },
    },
};
apply(ctx);
assert.ok(capturedRoute, 'route /fge/api not registered');
assert.equal(capturedRoute.kind, 'prefix');
assert.equal(capturedRoute.path, '/fge/api');

// ---- HTTP 路由调用模拟 ----
function callAt(method, path, body, headers) {
    return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = method;
        req.url = path;
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
const base = (m) => '/fge/api/' + m;

let passed = 0;
function ok(name) {
    passed++;
    console.log('  ✓ ' + name);
}

// 1. info: cwd / repoRoot / branch
const info = await callAt('POST', base('info'), {});
assert.equal(info.status, 200);
assert.equal(info.body.ok, true);
assert.equal(info.body.cwd, process.cwd());
assert.equal(info.body.repoRoot, process.cwd(), '本仓库根应等于 cwd');
assert.ok(info.body.branch === null || typeof info.body.branch === 'string');
ok('info: cwd/repoRoot/branch');

// 2. tree visible: 无 dotfile、无 node_modules、目录优先
const vis = await callAt('POST', base('tree'), { path: '', mode: 'visible', reveal: false });
assert.equal(vis.body.ok, true);
const visNames = vis.body.entries.map((e) => e.name);
assert.ok(visNames.includes('plugins'), 'visible 应含 plugins/');
assert.ok(!visNames.some((n) => n.startsWith('.')), 'visible 不应含 dotfile');
assert.ok(!visNames.includes('node_modules'), 'visible 不应含被忽略的 node_modules');
assert.ok(
    vis.body.entries.every((e, i, arr) => i === 0 || arr[i - 1].type === 'dir' || e.type !== 'dir'),
    '目录应排在文件前',
);
ok('tree visible: 过滤 dot/ignored + 目录优先');

// 3. tree hidden: 只含 dot 项、排除 .git;reveal 时含全部
const hid = await callAt('POST', base('tree'), { path: '', mode: 'hidden', reveal: false });
assert.equal(hid.body.ok, true);
const hidNames = hid.body.entries.map((e) => e.name);
assert.ok(hidNames.includes('.gitignore'), 'hidden 应含 .gitignore');
assert.ok(!hidNames.includes('.git'), 'hidden 应排除 .git');
assert.ok(
    hidNames.every((n) => n.startsWith('.')),
    'hidden(非 reveal)只含 dot 项',
);
const hidAll = await callAt('POST', base('tree'), { path: '', mode: 'hidden', reveal: true });
assert.ok(
    hidAll.body.entries.some((e) => !e.name.startsWith('.')),
    'hidden reveal 时应含全部子项(含普通项)',
);
ok('tree hidden: dot 过滤 + reveal 全量');

// 4. tree ignored: 含 node_modules(仓库 .gitignore 提交在库, 状态无关)
const ign = await callAt('POST', base('tree'), { path: '', mode: 'ignored', reveal: false });
assert.equal(ign.body.ok, true);
assert.ok(
    ign.body.entries.some((e) => e.name === 'node_modules'),
    'ignored 应含 node_modules',
);
ok('tree ignored: node_modules');

// 5. status: 分支 + 变更列表(断言状态无关)
const st = await callAt('POST', base('status'), { repoRoot: info.body.repoRoot });
assert.equal(st.status, 200);
assert.equal(st.body.ok, true);
assert.ok(st.body.current === null || typeof st.body.current === 'string');
assert.ok(Array.isArray(st.body.branches) && st.body.branches.length >= 1, 'branches 应为非空数组');
assert.ok(!st.body.branches.some((b) => b.name.endsWith('/HEAD')), '应过滤 */HEAD 符号引用');
assert.ok(Array.isArray(st.body.changes), 'changes 应为数组');
assert.ok(st.body.head === null || typeof st.body.head === 'string', 'head 应为 string|null');
ok('status: 分支/变更/HEAD 过滤');

// 6. diff: 取当前第一个变更动态校验(状态无关); 若工作区干净则跳过
if (st.body.changes.length > 0) {
    const first = st.body.changes[0];
    const d = await callAt('POST', base('diff'), {
        repoRoot: info.body.repoRoot,
        path: first.path,
        status: first.status,
        from: first.from,
    });
    assert.equal(d.body.ok, true, 'diff(' + first.path + ') 应 ok');
    assert.ok(d.body.kind === 'diff' || d.body.kind === 'untracked', 'diff kind 应合法');
    if (d.body.kind === 'diff') {
        assert.ok(d.body.text.includes('diff --git'), 'unified diff 应含 diff --git 头');
    }
    ok('diff: 首个变更动态校验(' + first.path + ' → ' + d.body.kind + ')');
} else {
    console.log('  · 工作区干净, 跳过 diff 动态校验');
}

// 7. file: 内容读取 + 二进制探测
const file = await callAt('POST', base('file'), { path: 'CONTEXT.md' });
assert.equal(file.body.ok, true);
assert.equal(file.body.binary, false);
assert.ok(file.body.size > 0);
ok('file: 文本读取');

// 8. 显式 root: 请求根跟随工作区(缺省回退 cwd)
const rootVis = await callAt('POST', base('tree'), {
    root: process.cwd(),
    path: '',
    mode: 'visible',
    reveal: false,
});
assert.deepEqual(
    rootVis.body.entries.map((e) => e.name),
    vis.body.entries.map((e) => e.name),
    '显式 root 应与缺省 cwd 结果一致',
);
const infoRoot = await callAt('POST', base('info'), { root: process.cwd() });
assert.equal(infoRoot.body.ok, true);
assert.equal(infoRoot.body.cwd, process.cwd());
const stRoot = await callAt('POST', base('status'), {
    root: process.cwd(),
    repoRoot: info.body.repoRoot,
});
assert.equal(stRoot.body.ok, true);
ok('显式 root: info/tree/status 使用请求根');

// 8b. 非法 root(相对路径)拒绝
const badRoot = await callAt('POST', base('file'), { root: 'relative/path', path: 'x' });
assert.equal(badRoot.body.ok, false);
assert.equal(badRoot.body.error, 'invalid-root');
ok('非法 root(相对路径)拒绝');

// 9. 防穿越: 拒绝逃出 root
const trav = await callAt('POST', base('file'), { path: '../../outside.txt' });
assert.equal(trav.body.ok, false);
assert.equal(trav.body.error, 'outside-root');
ok('防穿越: outside-root 拒绝');

// 10. 信任栅栏: 无 x-dsh-plugin 头 / 非回环 host / 非 POST
const noHeader = await callAt('POST', base('info'), {}, { 'x-dsh-plugin': undefined });
assert.equal(noHeader.status, 403);
const badHost = await callAt('POST', base('info'), {}, { host: 'evil.example.com' });
assert.equal(badHost.status, 403);
const get = await callAt('GET', base('info'), undefined);
assert.equal(get.status, 405);
ok('信任栅栏: 头/回环/POST 校验');

// 4b. search: 子串命中 / 三区徽标 / 空查询(状态无关: 只断言仓库自身固定内容)
const sVis = await callAt('POST', base('search'), { query: 'CONTEXT.md' });
assert.equal(sVis.body.ok, true);
const ctxHit = sVis.body.matches.find((m) => m.rel === 'CONTEXT.md');
assert.ok(ctxHit, 'search 应命中 CONTEXT.md');
assert.equal(ctxHit.zone, 'visible');
assert.equal(ctxHit.nameHit, true);
const sDir = await callAt('POST', base('search'), { query: 'plugins' });
assert.equal(sDir.body.ok, true);
assert.ok(
    sDir.body.matches.some((m) => m.type === 'dir' && m.rel === 'plugins'),
    '应含由文件路径派生的目录命中(plugins)',
);
const sDot = await callAt('POST', base('search'), { query: '.gitmessage' });
assert.equal(sDot.body.ok, true);
const dotHit = sDot.body.matches.find((m) => m.rel === '.gitmessage');
assert.ok(dotHit, 'search 应命中根级 dotfile .gitmessage');
assert.equal(dotHit.zone, 'hidden');
const sEmpty = await callAt('POST', base('search'), { query: '   ' });
assert.deepEqual(sEmpty.body.matches, []);
const sNone = await callAt('POST', base('search'), { query: 'zzz-no-such-entry-xyz' });
assert.equal(sNone.body.ok, true);
assert.equal(sNone.body.matches.length, 0);
ok('search: 可见/隐藏区命中 + 空查询/无命中');

// 11. log: 提交列表 / ref 指定 / 分页越界 / 非法 ref 拒绝
const repoRootV = info.body.repoRoot;
const lg = await callAt('POST', base('log'), { repoRoot: repoRootV });
assert.equal(lg.body.ok, true);
assert.ok(Array.isArray(lg.body.commits) && lg.body.commits.length >= 1, 'log 应至少一条提交');
assert.equal(typeof lg.body.head, 'string', 'log.head 应为 HEAD 全 hash');
const c0 = lg.body.commits[0];
assert.ok(c0.hash.length >= 7 && typeof c0.subject === 'string' && typeof c0.at === 'number');
const lRef = await callAt('POST', base('log'), {
    repoRoot: repoRootV,
    ref: st.body.branches[0].name,
});
assert.equal(lRef.body.ok, true, '合法分支名作 ref 应 ok');
const lFar = await callAt('POST', base('log'), { repoRoot: repoRootV, skip: 1000000, limit: 10 });
assert.equal(lFar.body.ok, true);
assert.deepEqual(lFar.body.commits, []);
const lBad = await callAt('POST', base('log'), { repoRoot: repoRootV, ref: '-evil' });
assert.equal(lBad.body.ok, false);
assert.equal(lBad.body.error, 'invalid-ref');
ok('log: 列表/ref/分页越界/非法 ref');

// 12. show: 单提交详情(message + 文件 ±行数)/ 单文件 diff / 非法 hash 拒绝
const sh = await callAt('POST', base('show'), { repoRoot: repoRootV, hash: c0.hash });
assert.equal(sh.body.ok, true);
assert.ok(sh.body.kind === 'commit' || sh.body.kind === 'merge', 'show kind 应合法');
if (sh.body.kind === 'commit') {
    assert.ok(typeof sh.body.message === 'string' && sh.body.message.trim().length > 0);
    assert.ok(Array.isArray(sh.body.files));
    const textFile = sh.body.files.find((f) => f.adds !== null);
    if (textFile !== undefined) {
        const sf = await callAt('POST', base('show'), {
            repoRoot: repoRootV,
            hash: c0.hash,
            path: textFile.path,
        });
        assert.equal(sf.body.ok, true, '单文件 diff 应 ok');
        assert.equal(sf.body.kind, 'diff');
    }
}
const sBadHash = await callAt('POST', base('show'), { repoRoot: repoRootV, hash: '../etc/passwd' });
assert.equal(sBadHash.body.ok, false);
assert.equal(sBadHash.body.error, 'invalid-hash');
ok('show: 详情/diff/非法 hash');

console.log('\nHOST LOGIC CHECKS PASSED (' + passed + ' groups)');
