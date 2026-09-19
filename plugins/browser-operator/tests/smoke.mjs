/**
 * browser-operator 自检 —— 离线可跑,不需要 DSH 进程。
 *
 * 运行: node plugins/obsolete/browser-operator/tests/smoke.mjs
 *
 * 只测**外部行为**:产物目录怎么选、工具能不能真的驱动浏览器、断言页面、落盘截图、
 * DISPOSE 后有没有残留进程。不测内部实现。
 *
 * 会真的拉起一个有头浏览器窗口(用临时 profile,跑完就关),所以你会在屏幕上看到它闪一下。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveArtifactDir } from '../lib/artifacts.js';
import { apply } from '../lib/index.js';

const run = promisify(execFile);

let passed = 0;
const failures = [];

/** 同步断言小步;失败收集起来,最后统一汇总(不中断后续检查)。 */
function check(label, fn) {
    try {
        fn();
        passed += 1;
        console.log('ok - ' + label);
    } catch (error) {
        failures.push(`${label} :: ${error?.message ?? String(error)}`);
        console.error('not ok - ' + label + ' :: ' + (error?.message ?? String(error)));
    }
}

/** 异步版 check。 */
async function checkAsync(label, fn) {
    try {
        await fn();
        passed += 1;
        console.log('ok - ' + label);
    } catch (error) {
        failures.push(`${label} :: ${error?.message ?? String(error)}`);
        console.error('not ok - ' + label + ' :: ' + (error?.message ?? String(error)));
    }
}

/** 一个够用的假 ctx:捕获工具定义,记住 dispose 回调。 */
function makeCtx() {
    const tools = new Map();
    const disposers = [];
    return {
        tools: { register: (definition) => tools.set(definition.name, definition) },
        on(event, handler) {
            if (event === 'dispose') disposers.push(handler);
        },
        toolsByName: tools,
        async dispose() {
            for (const handler of disposers) await handler();
        },
    };
}

/** 工具执行上下文:只用到 agent.session.id / header.cwd。 */
const execIn = (cwd) => ({ agent: { session: { id: 'smoke', header: { cwd } } } });

/** 调用一个工具并按 output.schema 的约定取回值。 */
async function callTool(ctx, name, args, cwd) {
    const definition = ctx.toolsByName.get(name);
    assert.ok(definition !== undefined, `工具 ${name} 没有注册`);
    return await definition.execute(args, execIn(cwd));
}

/** win32 上的 chrome.exe 进程数;其它平台或取不到时返回 null(跳过该项检查)。 */
async function chromeProcessCount() {
    if (process.platform !== 'win32') return null;
    try {
        const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], {
            windowsHide: true,
        });
        return stdout.split(/\r?\n/).filter((line) => line.includes('chrome.exe')).length;
    } catch {
        return null;
    }
}

/** 轮询等到 chrome 进程数回到基线。 */
async function waitForProcessesAtMost(baseline, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const current = await chromeProcessCount();
        if (current === null || current <= baseline) return current;
        if (Date.now() > deadline) return current;
        await sleep(500);
    }
}

/** Promise 版的 sleep。 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 尽力删掉临时目录。Chrome 刚退出时 profile 里的 sqlite 还可能被锁住几秒
 * (`EBUSY`),不值得为这点噪音把自检搞崩,所以重试几次后放弃。
 */
async function removeDir(dir) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            await rm(dir, { recursive: true, force: true });
            return true;
        } catch {
            await sleep(500);
        }
    }
    return false;
}

/** 建一个「假装是项目」的临时 git 仓库,`.gitignore` 里忽略 logs/,并做一次初始提交。 */
async function makeFakeProject() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bop-project-'));
    await writeFile(path.join(dir, '.gitignore'), 'node_modules/\nlogs/\n', 'utf8');
    await writeFile(path.join(dir, 'README.md'), '# fake\n', 'utf8');
    try {
        await run('git', ['init', '-q'], { cwd: dir, windowsHide: true });
        // 初始提交让「仓库状态干净」成为一个可断言的事实;身份用 -c 传,
        // 免得依赖这台机器全局配没配 user.name/user.email。
        await run('git', ['add', '-A'], { cwd: dir, windowsHide: true });
        await run(
            'git',
            [
                '-c',
                'user.email=smoke@example.com',
                '-c',
                'user.name=smoke',
                'commit',
                '-q',
                '-m',
                'init',
            ],
            { cwd: dir, windowsHide: true },
        );
    } catch {
        // 没有 git 也能跑:后面的用例会自动走 .gitignore 解析那条路。
    }
    return dir;
}

const scratch = await mkdtemp(path.join(os.tmpdir(), 'dsh-bop-smoke-'));
const project = await makeFakeProject();
const ctx = makeCtx();
const baseline = await chromeProcessCount();

console.log('browser-operator smoke');
console.log('  scratch =', scratch);
console.log('  project =', project);
console.log('  chrome baseline =', baseline === null ? '(n/a)' : baseline);
console.log('');

// ── 1. 产物目录解析(纯逻辑,不起浏览器)──────────────────────────────────

await checkAsync('产物目录:已 ignore 的 logs/ 优先', async () => {
    const resolved = await resolveArtifactDir({ cwd: project, sessionId: 'smoke' });
    assert.equal(resolved.dir, path.join(project, 'logs', 'browser-operator'));
    assert.equal(resolved.source, 'gitignore');
});

await checkAsync('产物目录:配置优先于自动探测', async () => {
    const resolved = await resolveArtifactDir({
        cwd: project,
        override: path.join(scratch, 'explicit'),
    });
    assert.equal(resolved.dir, path.join(scratch, 'explicit'));
    assert.equal(resolved.source, 'config');
});

await checkAsync('产物目录:非仓库工作区退到 logs/', async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), 'dsh-bop-plain-'));
    const resolved = await resolveArtifactDir({ cwd: plain, sessionId: 'smoke' });
    assert.equal(resolved.dir, path.join(plain, 'logs', 'browser-operator'));
    await rm(plain, { recursive: true, force: true });
});

await checkAsync('产物目录:仓库里没有可 ignore 的目录时写仓库外', async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), 'dsh-bop-bare-'));
    await run('git', ['init', '-q'], { cwd: bare, windowsHide: true });
    const resolved = await resolveArtifactDir({ cwd: bare, sessionId: 'smoke' });
    assert.equal(resolved.source, 'dsh-home');
    assert.ok(!resolved.dir.startsWith(bare), '不该落在仓库里面');
    await rm(bare, { recursive: true, force: true });
});

// ── 2. 工具注册表 ──────────────────────────────────────────────────────────

apply(ctx, {
    profileDir: path.join(scratch, 'profile'),
    headless: false,
    browser: 'chrome',
    logCap: 50,
});

const EXPECTED_TOOLS = [
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_fill',
    'browser_eval',
    'browser_screenshot',
    'browser_console',
    'browser_network',
    'browser_artifacts',
];

check('注册了全部 browser_* 工具', () => {
    for (const tool of EXPECTED_TOOLS) {
        assert.ok(ctx.toolsByName.has(tool), `缺工具 ${tool}`);
    }
    assert.equal(ctx.toolsByName.size, EXPECTED_TOOLS.length, '多注册了计划外的工具');
});

check('每个工具都声明了 output 与 presentCall', () => {
    for (const [tool, definition] of ctx.toolsByName) {
        assert.ok(definition.output?.schema, `${tool} 缺 output.schema`);
        assert.equal(typeof definition.output.render, 'function', `${tool} 缺 output.render`);
        assert.equal(typeof definition.presentCall, 'function', `${tool} 缺 presentCall`);
        assert.equal(typeof definition.timeoutMs, 'number', `${tool} 缺 timeoutMs`);
    }
});

// ── 3. 真浏览器链路 ────────────────────────────────────────────────────────

const PAGE_HTML =
    'data:text/html,<title>smoke-title</title><h1>hello-browser</h1>' +
    '<script>console.error("smoke-console-error")</script>';

await checkAsync('browser_navigate 打开 data URL 并读到标题', async () => {
    const result = await callTool(ctx, 'browser_navigate', { url: PAGE_HTML }, project);
    assert.match(result.url, /^data:text\/html/);
    assert.equal(result.title, 'smoke-title');
});

await checkAsync('browser_snapshot 读到可见文本', async () => {
    const result = await callTool(ctx, 'browser_snapshot', {}, project);
    assert.equal(result.title, 'smoke-title');
    assert.match(result.text, /hello-browser/);
});

await checkAsync('browser_eval 在页面里求值', async () => {
    const result = await callTool(ctx, 'browser_eval', { expression: '1 + 1' }, project);
    assert.equal(result.result, '2');
});

await checkAsync('browser_console 捕获到 console.error', async () => {
    const result = await callTool(ctx, 'browser_console', { onlyErrors: true }, project);
    assert.ok(result.entries.length > 0, '没有抓到任何 error 级日志');
    assert.ok(
        result.entries.some((entry) => entry.text.includes('smoke-console-error')),
        '环形缓冲里没有 smoke-console-error',
    );
});

await checkAsync('browser_network 抓到一个失败请求', async () => {
    // data URL 不发请求,所以显式跳到一个必然失败的回环端口。
    await callTool(ctx, 'browser_navigate', { url: 'http://127.0.0.1:9/nope' }, project).catch(
        () => undefined,
    );
    const result = await callTool(ctx, 'browser_network', {}, project);
    assert.ok(result.entries.length > 0, '没有抓到失败请求');
});

await checkAsync('browser_screenshot 落进项目已 ignore 的目录', async () => {
    const result = await callTool(ctx, 'browser_screenshot', { name: 'smoke' }, project);
    assert.ok(existsSync(result.path), `截图不存在: ${result.path}`);
    assert.ok(result.bytes > 0, '截图是空文件');
    assert.equal(result.directory, path.join(project, 'logs', 'browser-operator'));
    assert.equal(result.directorySource.split(' ')[0], 'gitignore');

    // 断言:产物确实被 git 忽略,仓库状态依然干净。
    const { stdout } = await run('git', ['status', '--porcelain'], {
        cwd: project,
        windowsHide: true,
    });
    assert.equal(stdout.trim(), '', `产物污染了仓库状态:\n${stdout}`);
});

await checkAsync('browser_artifacts 报出目录与已落盘文件', async () => {
    const result = await callTool(ctx, 'browser_artifacts', { action: 'list' }, project);
    assert.equal(result.directory, path.join(project, 'logs', 'browser-operator'));
    assert.ok(
        result.files.some((file) => file.name.startsWith('smoke')),
        '没列到刚才那张截图',
    );
});

await checkAsync('未导航就调只读工具时给出人话提示', async () => {
    const fresh = makeCtx();
    apply(fresh, { profileDir: path.join(scratch, 'profile-2'), browser: 'chrome' });
    await assert.rejects(
        () => callTool(fresh, 'browser_snapshot', {}, project),
        /先调一次 browser_navigate/,
    );
    await fresh.dispose();
});

// ── 4. 收尾:不残留进程 ────────────────────────────────────────────────────

await ctx.dispose();
const after = await waitForProcessesAtMost(baseline);

await checkAsync('DISPOSE 后没有残留浏览器进程', async () => {
    if (baseline === null || after === null) {
        console.log('     (取不到进程数,跳过)');
        return;
    }
    assert.ok(after <= baseline, `浏览器进程没清干净: 基线 ${baseline}, 现在 ${after}`);
});

await removeDir(scratch);
await removeDir(project);

console.log('');
if (failures.length > 0) {
    console.error(`browser-operator 自检: ${failures.length} 项失败`);
    for (const failure of failures) console.error('  - ' + failure);
    console.error(`  通过 ${passed} 项`);
    process.exit(1);
}
console.log(`browser-operator 自检: ${passed} 项全部通过`);
// Playwright 的 driver 子进程会让 event loop 挂着,显式退出。
process.exit(0);
