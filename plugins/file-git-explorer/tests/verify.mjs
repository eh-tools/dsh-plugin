/**
 * dsh-file-git-explorer v0.6.0 host 冒烟验证(真实 HTTP + 真实 git, 离线可跑)
 *
 * 目的: 用自带 **真 node:http server** 的假 ctx 挂载静态双半插件的 host 半
 *       (../lib/index.js), 让全部路由都经真实 HTTP 走一遍 —— 校验
 *       info / status / diff / log / show 的数据契约、信任栅栏、vendor 白名单。
 *       本文件是**集成冒烟脚本**(不是 node:test 用例), 直接 `node tests/verify.mjs`。
 *
 * ⚠ 终端**不在这里**: 它在 ADR-0006 之后归官方 terminal-controller(host 半不再有终端路由),
 *   所以本文件只断言"那条旧 WS 路径已经不在了"; 帧桥那条契约在
 *   `scripts/verify-client-bundles.mjs` 里用假 xterm / 假 view 跑。
 *
 * 运行: node tests/verify.mjs
 *       cwd 必须 = plugins/file-git-explorer; git 在 PATH 中。
 *       退出码 0 = 所有非跳过检查通过, 1 = 有断言失败。
 *       依赖缺失(插件没装 @xterm/*)时对应小节打印 skip 而不失败 ——
 *       那是"环境缺依赖", 不是"代码错了"。
 *
 * 覆盖:
 *   · 假 ctx: 真 http server(register 精确优先 + 最长前缀胜出、
 *     端口 0 取真实端口、真实 404)、假 subprocess(真 child_process.execFile)、
 *     ctx.effect 收集器 + disposeAll
 *   · info    : cwd / repoRoot 指向临时仓库
 *   · status  : current=main、repoRoot、branches, 以及 porcelain v2 五类记录齐全 ——
 *               暂存 M / 未暂存 M / 未暂存 D / 重命名 R(origPath 存活) / 未跟踪 ?;
 *               被 .gitignore 忽略的文件不进 changes
 *   · diff    : 已跟踪文件回 kind:'diff' 且含 -/+ 对, 且 hunks 已把两侧拆成行块;
 *               未跟踪文件回 kind:'untracked' 且 hunks 为空
 *   · log/show: 提交列表契约(hash/short/author/subject + head)与提交详情(message/files)
 *   · 信任栅栏: 缺 x-dsh-plugin → 403、GET → 405、非回环 Host → 403、未知方法 → 404
 *   · vendor  : 白名单命中 200 + content-type/javascript, 未知名与 ../ 穿越 → 404
 *   · 终端内核: host 半零升级路由, 旧 /fge/ws/terminal → 404(终端已归官方, 见 ADR-0006)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { apply } from '../lib/index.js';

// ================================ 断言记账 ================================

let checksPassed = 0;
let checksSkipped = 0;

/** 记录一条通过的检查(一行 ok 对应一组断言)。 */
function ok(name) {
    checksPassed += 1;
    console.log('ok - ' + name);
}

/** 记录一条跳过(依赖/环境缺失, 不算失败)。 */
function skip(name, why) {
    checksSkipped += 1;
    console.log('skip - ' + name + ' :: ' + why);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 带平台折叠的路径比较(Windows 大小写不敏感, 短名/长名差异也容忍)。 */
function samePath(a, b) {
    const na = path.resolve(String(a));
    const nb = path.resolve(String(b));
    return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** 宽松 JSON 解析: 只接受普通对象, 非法 JSON / 数组 / 标量都返回 null。 */
function tryJson(text) {
    try {
        const value = JSON.parse(String(text));
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
        return value;
    } catch {
        return null;
    }
}

// ===================== 假 subprocess(真 execFile 收集器) =====================
//
// 对齐 lib/index.js 里 runGit 实际用到的字段: 只需 done / collected.stdout / collected.stderr。
// env 是**叠加**在 process.env 之上(绝不替换), 否则 git 找不到 PATH / HOME。

function createFakeSubprocess() {
    return {
        spawn(spec) {
            const argv = Array.isArray(spec.argv) ? spec.argv : [];
            const child = execFile(argv[0], argv.slice(1), {
                cwd: spec.cwd,
                env: { ...process.env, ...(spec.env ?? {}) },
                windowsHide: true,
                maxBuffer: 64 * 1024 * 1024,
            });
            let stdout = '';
            let stderr = '';
            let settled = false;
            const done = new Promise((resolve) => {
                child.stdout?.on('data', (chunk) => {
                    stdout += chunk.toString('utf8');
                });
                child.stderr?.on('data', (chunk) => {
                    stderr += chunk.toString('utf8');
                });
                // 起不来的进程(spawn 失败)归一为 127, 与真实 subprocess 服务的"不 reject"契约一致。
                child.on('error', () => {
                    if (settled) return;
                    settled = true;
                    resolve({ exitCode: 127 });
                });
                child.on('close', (code) => {
                    if (settled) return;
                    settled = true;
                    resolve({ exitCode: typeof code === 'number' ? code : 1 });
                });
            });
            const reader = (read) => ({
                readFrom(offset) {
                    const text = read();
                    const from = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
                    return { text: text.slice(from), nextOffset: text.length, lossy: false };
                },
            });
            return {
                stdin: undefined,
                done,
                collected: {
                    stdout: reader(() => stdout),
                    stderr: reader(() => stderr),
                },
            };
        },
    };
}

// ==================== 假 ctx + 真 node:http server ====================
//
// 路由语义严格镜像 dsh-host-webserver: 精确表命中优先, 否则前缀表里**最长者**胜出,
// 且前缀必须落在段边界上(`p === prefix` 或 `p.startsWith(prefix + '/')`); 无命中 404。
// upgrade 只按 pathname 精确匹配, 无命中 destroy socket。

const PROFILE_URL = pathToFileURL(
    path.join(os.homedir(), '.dsh', 'profiles', 'web') + path.sep,
).href;

async function startHarness() {
    const exactRoutes = new Map();
    const prefixRoutes = new Map();
    const upgradeRoutes = new Map();
    const disposers = [];

    function matchRoute(pathname) {
        const exact = exactRoutes.get(pathname);
        if (exact !== undefined) return exact;
        let best;
        for (const [prefix, route] of prefixRoutes) {
            if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue;
            if (best === undefined || prefix.length > best.path.length) best = route;
        }
        return best;
    }

    const server = http.createServer((req, res) => {
        let pathname;
        try {
            pathname = new URL(req.url ?? '/', 'http://x').pathname;
        } catch {
            res.writeHead(400);
            res.end();
            return;
        }
        const route = matchRoute(pathname);
        if (route === undefined) {
            res.writeHead(404);
            res.end();
            return;
        }
        Promise.resolve()
            .then(() => route.handler(req, res))
            .catch(() => {
                if (res.headersSent) res.destroy();
                else {
                    res.writeHead(400);
                    res.end();
                }
            });
    });

    server.on('upgrade', (req, socket, head) => {
        let route;
        try {
            route = upgradeRoutes.get(new URL(req.url ?? '/', 'http://x').pathname);
        } catch {
            socket.destroy();
            return;
        }
        if (route === undefined) {
            socket.destroy();
            return;
        }
        socket.on('error', () => {});
        Promise.resolve()
            .then(() => route.handler(req, socket, head))
            .catch(() => socket.destroy());
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });

    const subprocess = createFakeSubprocess();
    const ctx = {
        // profile 配置树锚点: 插件靠它解析自己带的静态资产(@xterm/xterm 的 dist)。
        baseUrl: PROFILE_URL,
        webServer: {
            register(route) {
                const table = route.kind === 'exact' ? exactRoutes : prefixRoutes;
                if (table.has(route.path)) {
                    throw new Error(
                        'webserver: duplicate ' + route.kind + ' route "' + route.path + '"',
                    );
                }
                table.set(route.path, route);
                return () => table.delete(route.path);
            },
            registerUpgrade(route) {
                if (upgradeRoutes.has(route.path)) {
                    throw new Error('webserver: duplicate upgrade route "' + route.path + '"');
                }
                upgradeRoutes.set(route.path, route);
                return () => upgradeRoutes.delete(route.path);
            },
        },
        get(name) {
            return name === 'subprocess' ? subprocess : undefined;
        },
        effect(fn) {
            const disposer = fn();
            if (typeof disposer === 'function') disposers.push(disposer);
            return disposer;
        },
    };

    return {
        ctx,
        port: server.address().port,
        /** 当前注册在案的升级路由条数 —— 终端内核易主后这里应当是 0(见 ADR-0006)。 */
        upgradeRouteCount: () => upgradeRoutes.size,
        /** 收起全部 side effect: ctx.effect 的 disposer(杀 PTY)优先, 再关 server。 */
        async close() {
            for (const dispose of disposers.splice(0).reverse()) {
                try {
                    dispose();
                } catch {
                    // 单个 disposer 失败不影响其余
                }
            }
            server.closeAllConnections?.();
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 2000);
                server.close(() => {
                    clearTimeout(timer);
                    resolve();
                });
                server.closeAllConnections?.();
            });
        },
    };
}

// ============================== HTTP 客户端 ==============================

let port = 0;

/** POST/GET /fge/api|vendor。body 省略则不发送请求体。 */
async function apiCall(method, apiPath, body, headers) {
    const finalHeaders = { ...(headers ?? {}) };
    if (finalHeaders['x-dsh-plugin'] === undefined && finalHeaders.omitPluginHeader !== true) {
        finalHeaders['x-dsh-plugin'] = '1';
    }
    delete finalHeaders.omitPluginHeader;
    if (method === 'POST') finalHeaders['content-type'] = 'application/json';
    const res = await fetch('http://127.0.0.1:' + port + apiPath, {
        method,
        headers: finalHeaders,
        body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: tryJson(text) };
}

/**
 * 裸 http.request: 唯一能真正控制 Host 头的路径。
 * 实测(undici/fetch)显式传 `host: 'evil.example'` 会被**静默忽略**, 服务端看到的仍是
 * `127.0.0.1:<port>` —— 所以信任栅栏里的 Host 用例必须走这里, 且 setHost:false 阻止
 * Node 再次覆盖。
 */
function rawHttpRequest({ method, requestPath, headers, body }) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, method, path: requestPath, headers, setHost: false },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    text += chunk;
                });
                res.on('end', () => resolve({ status: res.statusCode, text }));
            },
        );
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

// ============================== git fixture ==============================

/**
 * 建一个临时仓库, 并把它推到"porcelain v2 五类记录齐全"的状态:
 *   1 M. 暂存修改 | 1 .M 未暂存修改 | 1 .D 未暂存删除 | 2 R. 重命名 | ? 未跟踪
 * 另外落一个被 .gitignore 忽略的 ignored.txt(它**不该**出现在 changes 里)。
 */
function createRepoFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fge-verify-'));
    const git = (...args) =>
        execFileSync('git', args, {
            cwd: dir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    const write = (rel, text) => {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
    };

    git('init', '-b', 'main');
    git('config', 'user.email', 'verify@fge.test');
    git('config', 'user.name', 'FGE Verify');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    git('config', 'status.renames', 'true');

    write('.gitignore', 'ignored.txt\n');
    write('staged.txt', 'base staged\n');
    write('unstaged.txt', 'base unstaged\n');
    write('gone.txt', 'base gone\n');
    write('old-name.txt', 'base rename\n');
    git('add', '-A');
    git('commit', '-m', 'base commit');

    write('staged.txt', 'changed staged\n');
    git('add', 'staged.txt'); // 1 M.  暂存修改
    write('unstaged.txt', 'changed unstaged\n'); // 1 .M  未暂存修改
    fs.rmSync(path.join(dir, 'gone.txt')); // 1 .D  未暂存删除
    git('mv', 'old-name.txt', 'new-name.txt'); // 2 R.  重命名(旧路径随记录带回)
    write('untracked.txt', 'untracked\n'); // ?     未跟踪
    write('ignored.txt', 'ignored\n'); // 被忽略 → 不进 changes

    return dir;
}

// ============================== 清理 ==============================

let harness = null;
let repoDir = null;

async function cleanup() {
    if (harness !== null) {
        try {
            await harness.close();
        } catch {
            // server 已关
        }
        harness = null;
    }
    if (repoDir !== null) {
        // Windows 上刚被杀掉的 shell 可能还占着 cwd, 重试几次再放弃。
        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                fs.rmSync(repoDir, { recursive: true, force: true });
                break;
            } catch {
                await sleep(200);
            }
        }
        repoDir = null;
    }
}

// ============================== 主流程 ==============================

async function runAll() {
    repoDir = createRepoFixture();
    harness = await startHarness();
    port = harness.port;

    apply(harness.ctx);

    const repo = repoDir;
    const api = '/fge/api';

    // ---- 1. info ----
    const info = await apiCall('POST', api + '/info', { root: repo });
    assert.equal(info.status, 200);
    assert.equal(info.body?.ok, true, 'info 应 ok: ' + info.text.slice(0, 200));
    assert.ok(samePath(info.body.cwd, repo), 'info.cwd 应为请求根, 实际: ' + info.body.cwd);
    assert.ok(
        samePath(info.body.repoRoot, repo),
        'info.repoRoot 应为临时仓库, 实际: ' + info.body.repoRoot,
    );
    ok('info: cwd / repoRoot 指向临时仓库');

    // ---- 2. status ----
    const status = await apiCall('POST', api + '/status', { root: repo, repoRoot: repo });
    assert.equal(status.status, 200);
    assert.equal(status.body?.ok, true, 'status 应 ok: ' + status.text.slice(0, 200));
    assert.equal(status.body.current, 'main', 'current 应为 main');
    assert.ok(samePath(status.body.repoRoot, repo), 'status.repoRoot 应为临时仓库');
    assert.ok(
        status.body.branches.some((b) => b.name === 'main' && b.remote === false),
        'branches 应含本地 main',
    );
    ok('status: current=main / repoRoot / branches');

    const changes = status.body.changes;
    assert.ok(Array.isArray(changes) && changes.length > 0, 'changes 应为非空数组');

    const staged = changes.find((c) => c.path === 'staged.txt');
    assert.ok(staged !== undefined, 'changes 应含 staged.txt');
    assert.equal(staged.xy[0], 'M', 'staged.txt 应为暂存修改(1 M.)');
    assert.equal(staged.badge, 'M');

    const unstaged = changes.find((c) => c.path === 'unstaged.txt');
    assert.ok(unstaged !== undefined, 'changes 应含 unstaged.txt');
    assert.equal(unstaged.xy, ' M', 'unstaged.txt 应为未暂存修改(1 .M)');
    assert.equal(unstaged.badge, 'M');

    const deleted = changes.find((c) => c.path === 'gone.txt');
    assert.ok(deleted !== undefined, 'changes 应含 gone.txt');
    assert.equal(deleted.xy, ' D', 'gone.txt 应为未暂存删除(1 .D)');
    assert.equal(deleted.badge, 'D');
    ok('status: 暂存 M(1 M.)/ 未暂存 M(1 .M)/ 删除 D(1 .D)');

    const renamed = changes.find((c) => c.path === 'new-name.txt');
    assert.ok(renamed !== undefined, 'changes 应含重命名后的 new-name.txt');
    assert.equal(renamed.kind, 'renamed', '重命名记录 kind 应为 renamed(2 R.)');
    assert.equal(renamed.badge, 'R');
    assert.equal(renamed.origPath, 'old-name.txt', 'rename 的 origPath 必须存活');
    ok('status: 重命名 R(origPath=old-name.txt 存活)');

    const untracked = changes.find((c) => c.path === 'untracked.txt');
    assert.ok(untracked !== undefined, 'changes 应含未跟踪的 untracked.txt');
    assert.equal(untracked.badge, '?');
    assert.equal(untracked.kind, 'untracked');
    assert.equal(changes[changes.length - 1].kind, 'untracked', '未跟踪应被 sortChanges 沉底');
    assert.ok(
        changes.every((c) => c.path !== 'ignored.txt'),
        '被 .gitignore 忽略的文件不应出现在 changes',
    );
    ok('status: 未跟踪 ? 沉底 + 被忽略文件不出现');

    // ---- 3. diff ----
    const diff = await apiCall('POST', api + '/diff', {
        repoRoot: repo,
        path: 'staged.txt',
        status: 'M',
    });
    assert.equal(diff.body?.ok, true, 'diff 应 ok: ' + diff.text.slice(0, 200));
    assert.equal(diff.body.kind, 'diff');
    const diffLines = diff.body.text.split('\n');
    assert.ok(diff.body.text.includes('diff --git'), 'unified diff 应含 diff --git 头');
    assert.ok(
        diffLines.some((l) => l.startsWith('-') && !l.startsWith('---')),
        'diff 应含删除行(-)',
    );
    assert.ok(
        diffLines.some((l) => l.startsWith('+') && !l.startsWith('+++')),
        'diff 应含新增行(+)',
    );
    assert.ok(diff.body.text.includes('-base staged'), 'diff 应含旧内容');
    assert.ok(diff.body.text.includes('+changed staged'), 'diff 应含新内容');
    // hunks 是官方 DiffBlock 的 diffs 形状: 两侧已是拆好的行块(前缀已剥掉)。
    assert.ok(Array.isArray(diff.body.hunks) && diff.body.hunks.length >= 1, 'hunks 应非空数组');
    const stagedHunk = diff.body.hunks[0];
    assert.equal(stagedHunk.path, 'staged.txt');
    assert.equal(stagedHunk.oldText, 'base staged\n', 'oldText 应是剥掉前缀的旧侧行块');
    assert.equal(stagedHunk.newText, 'changed staged\n', 'newText 应是剥掉前缀的新侧行块');
    ok('diff: 已跟踪文件回 kind:diff 且含 -/+ 对 + hunks 行块');

    const diffUntracked = await apiCall('POST', api + '/diff', {
        repoRoot: repo,
        path: 'untracked.txt',
        status: '?',
    });
    assert.equal(diffUntracked.body?.ok, true);
    assert.equal(diffUntracked.body.kind, 'untracked');
    assert.equal(diffUntracked.body.text, '', '未跟踪文件不读盘, text 应为空串');
    assert.deepEqual(diffUntracked.body.hunks, [], '未跟踪文件的 hunks 应为空数组(形状稳定)');
    ok("diff: 未跟踪文件只回 kind:'untracked' 且 hunks 为空");

    // 未暂存删除的一侧是 /dev/null: 路径必须回落到 a/ 侧, 新侧为空串。
    const diffDeleted = await apiCall('POST', api + '/diff', {
        repoRoot: repo,
        path: 'gone.txt',
        status: 'D',
    });
    assert.equal(diffDeleted.body?.ok, true);
    assert.equal(diffDeleted.body.kind, 'diff');
    assert.equal(diffDeleted.body.hunks.length, 1, '删除文件应有 1 个 hunk');
    assert.equal(diffDeleted.body.hunks[0].path, 'gone.txt', '路径应从 a/ 侧回落');
    assert.equal(diffDeleted.body.hunks[0].oldText, 'base gone\n');
    assert.equal(diffDeleted.body.hunks[0].newText, '');
    ok('diff: 删除文件的 hunk 取 a/ 侧路径且新侧为空串');

    // rename 必须走 -M 双路径, 否则 git 只会当成 new file(见 README 实现事实)。
    const diffRenamed = await apiCall('POST', api + '/diff', {
        repoRoot: repo,
        path: 'new-name.txt',
        status: 'R',
        from: 'old-name.txt',
    });
    assert.equal(diffRenamed.body?.ok, true);
    assert.equal(diffRenamed.body.kind, 'diff');
    assert.equal(diffRenamed.body.hunks.length, 0, '100% rename 没有内容差异 → 没有 hunk');
    assert.ok(
        diffRenamed.body.text.includes('rename from') ||
            diffRenamed.body.text.includes('similarity index'),
        'rename 的原文 text 仍应保留(备用)',
    );
    ok('diff: rename 无内容差异时 hunks 为空, text 原文保留');

    // ---- 4. log ----
    const log = await apiCall('POST', api + '/log', { repoRoot: repo });
    assert.equal(log.body?.ok, true, 'log 应 ok: ' + log.text.slice(0, 200));
    assert.ok(
        Array.isArray(log.body.commits) && log.body.commits.length >= 1,
        'log 应至少一条提交',
    );
    const first = log.body.commits[0];
    assert.equal(typeof first.hash, 'string');
    assert.ok(first.hash.length >= 7, 'hash 应为完整 hash');
    assert.equal(typeof first.short, 'string');
    assert.ok(first.hash.startsWith(first.short), 'short 应是 hash 的前缀');
    assert.equal(first.author, 'FGE Verify', 'author 应来自 fixture 的 user.name');
    assert.equal(first.subject, 'base commit');
    assert.ok(Number.isFinite(first.at), 'at 应为 unix 时间戳');
    assert.equal(typeof log.body.head, 'string', '首页应带 head');
    assert.equal(log.body.head, first.hash, 'head 应等于首条提交 hash(rev-parse HEAD)');
    ok('log: commits[0] 带 hash/short/author/subject + head');

    // ---- 5. show ----
    const show = await apiCall('POST', api + '/show', { repoRoot: repo, hash: first.hash });
    assert.equal(show.body?.ok, true, 'show 应 ok: ' + show.text.slice(0, 200));
    assert.equal(show.body.kind, 'commit');
    assert.ok(show.body.message.includes('base commit'), 'message 应含提交标题');
    assert.ok(Array.isArray(show.body.files), 'files 应为数组');
    assert.ok(
        show.body.files.some((f) => f.path === 'staged.txt'),
        'files 应列出 base commit 里的 staged.txt',
    );
    const showFile = await apiCall('POST', api + '/show', {
        repoRoot: repo,
        hash: first.hash,
        path: 'staged.txt',
    });
    assert.equal(showFile.body?.ok, true);
    assert.equal(showFile.body.kind, 'diff', '带 path 的 show 应回单文件 diff');
    assert.ok(showFile.body.text.includes('+base staged'), '该 diff 应含 base commit 里的内容');
    assert.equal(showFile.body.hunks.length, 1, '带 path 的 show 应同时给结构化 hunk');
    assert.equal(showFile.body.hunks[0].path, 'staged.txt');
    assert.equal(showFile.body.hunks[0].newText, 'base staged\n');
    ok('show: 提交详情(message/files)+ 单文件 diff + hunks');

    // ---- 6. 信任栅栏 ----
    const noHeader = await apiCall('POST', api + '/info', undefined, { omitPluginHeader: true });
    assert.equal(noHeader.status, 403, '缺 x-dsh-plugin 应 403');
    ok('信任栅栏: 缺 x-dsh-plugin → 403');

    const wrongMethod = await apiCall('GET', api + '/info');
    assert.equal(wrongMethod.status, 405, 'GET 应 405');
    ok('信任栅栏: GET → 405');

    // fetch 无法覆盖 Host(见 rawHttpRequest 注释), 故走裸 http.request。
    const evilHost = await rawHttpRequest({
        method: 'POST',
        requestPath: api + '/info',
        headers: { host: 'evil.example', 'x-dsh-plugin': '1', 'content-length': '0' },
    });
    assert.equal(evilHost.status, 403, '非回环 Host 应 403');
    ok('信任栅栏: Host=evil.example → 403');

    const unknownMethod = await apiCall('POST', api + '/nope');
    assert.equal(unknownMethod.status, 404, '未知 API 方法应 404');
    ok('路由: 未知 API 方法 → 404');

    // ---- 7. vendor ----
    const vendorMiss = await apiCall('GET', '/fge/vendor/nope.js');
    assert.equal(vendorMiss.status, 404, '白名单外文件名应 404');
    ok('vendor: 未知名 nope.js → 404');

    // 字面 `../`: fetch 在发送前就把路径归一成 /fge/package.json, 于是没有任何路由命中,
    // 由 webserver 层回 404(实测如此)。assert 保留 403 的容忍是因为不同实现可能先栅栏后路由。
    const vendorTraversal = await apiCall('GET', '/fge/vendor/../package.json');
    assert.ok(
        vendorTraversal.status === 404 || vendorTraversal.status === 403,
        '字面 ../ 穿越应被 404/403 拒绝, 实际: ' + vendorTraversal.status,
    );
    ok(
        'vendor: ../package.json → ' +
            vendorTraversal.status +
            '(fetch 已归一为 /fge/package.json)',
    );

    // 百分号编码的 `..` 不会被 URL 解析归一, 它真正抵达插件的白名单查表 —— 这条才验的是白名单本身。
    const vendorEncodedTraversal = await apiCall('GET', '/fge/vendor/%2e%2e/package.json');
    assert.equal(vendorEncodedTraversal.status, 404, '编码穿越应被白名单挡成 404');
    ok('vendor: %2e%2e 编码穿越抵达白名单 → 404');

    const vendorJs = await apiCall('GET', '/fge/vendor/xterm.js');
    if (vendorJs.status === 503) {
        skip('vendor: xterm.js', '插件回 503(自身依赖 @xterm/xterm 未安装)');
    } else {
        assert.equal(vendorJs.status, 200, 'xterm.js 应 200: ' + vendorJs.text.slice(0, 120));
        assert.match(String(vendorJs.headers.get('content-type')), /javascript/);
        assert.ok(vendorJs.text.length > 10000, 'xterm.js 应大于 10000 字节');
        assert.ok(vendorJs.text.includes('define.amd'), 'xterm.js 应带 UMD banner(define.amd)');
        assert.ok(
            vendorJs.text.includes('typeof exports'),
            'xterm.js 应带 UMD banner(typeof exports)',
        );
        ok('vendor: xterm.js 200 + javascript + UMD banner(' + vendorJs.text.length + ' 字节)');
    }

    const vendorCss = await apiCall('GET', '/fge/vendor/xterm.css');
    if (vendorCss.status === 503) {
        skip('vendor: xterm.css', '插件回 503(自身依赖 @xterm/xterm 未安装)');
    } else {
        assert.equal(vendorCss.status, 200, 'xterm.css 应 200');
        assert.match(String(vendorCss.headers.get('content-type')), /css/);
        assert.ok(vendorCss.text.length > 0);
        ok('vendor: xterm.css 200 + css(' + vendorCss.text.length + ' 字节)');
    }

    // ---- 8. 终端不再走 host(见 ADR-0006) ----
    //
    // 内核易主之后 host 半**不该**再注册任何升级路由: 抽屉里的终端由官方
    // `@deepseek-ai/dsh-api-terminal-controller` 提供(client 半用 `ctx.webTerminals`)。
    // 于是原来那条 `/fge/ws/terminal` 现在必须**查无此路**, 而整台 server 的升级路由表应当是空的。
    assert.equal(harness.upgradeRouteCount(), 0, 'host 半不该再注册任何升级路由');
    const gone = await apiCall('GET', '/fge/ws/terminal');
    assert.equal(gone.status, 404, '旧终端 WS 路径应 404(它已经不在了), 实际: ' + gone.status);
    ok('终端内核: host 侧无升级路由, 旧 /fge/ws/terminal → 404');
}

let failure = null;
try {
    await runAll();
} catch (err) {
    failure = err;
}

await cleanup();

if (failure === null) {
    console.log(
        '\nverify: ' +
            checksPassed +
            ' checks passed' +
            (checksSkipped > 0 ? ', ' + checksSkipped + ' skipped' : '') +
            ' — all good',
    );
} else {
    console.error(
        '\nverify: FAILED after ' + checksPassed + ' checks (' + checksSkipped + ' skipped)',
    );
    console.error(failure instanceof Error ? (failure.stack ?? failure.message) : String(failure));
}

// 等 stdout 落地再退出(Windows 上管道是异步的, 直接 process.exit 可能丢尾部输出)。
await new Promise((resolve) => process.stdout.write('', resolve));
process.exit(failure === null ? 0 : 1);
