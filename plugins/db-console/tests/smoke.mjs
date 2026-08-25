/**
 * db-console 路由层冒烟测试(无真实 PG):
 * 用桩 webServer 捕获注册的 prefix handler, 以假 req/res 打请求,
 * 验证信任栅栏 / 方法分发 / 配置存取落盘(DSH_HOME 重定向到临时目录)/ 权限位。
 * 运行: node plugins/db-console/tests/smoke.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- 在导入被测模块前重定向 DSH_HOME ----
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-smoke-'));
process.env.DSH_HOME = tmpHome;

const { apply } = await import('../lib/index.js');

// ---- 桩 ctx: 捕获路由与 dispose ----
let captured = null;
const disposers = [];
const ctx = {
    webServer: {
        register(opts) {
            captured = opts;
            return () => {};
        },
    },
    on(ev, fn) {
        if (ev === 'dispose') disposers.push(fn);
    },
};

apply(ctx);
assert.ok(captured, 'webServer.register 未被调用');
assert.equal(captured.kind, 'prefix');
assert.equal(captured.path, '/dbc/api');
assert.equal(typeof captured.handler, 'function');

/** 构造假请求并执行 handler, 返回解析后的 JSON 与状态码。 */
function call(methodName, body, opts = {}) {
    return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.headers = {
            host: opts.host ?? '127.0.0.1:3080',
            'x-dsh-plugin': opts.pluginHeader ?? '1',
        };
        req.method = 'POST';
        req.url = '/dbc/api/' + methodName;
        req.destroy = () => {};
        const res = {
            statusCode: null,
            bodyText: '',
            writeHead(status) {
                this.statusCode = status;
                return this;
            },
            end(text) {
                this.bodyText = text;
                resolve(res);
            },
        };
        const done = captured.handler(req, res).catch(reject);
        process.nextTick(() => {
            if (opts.rawBody !== undefined) req.emit('data', Buffer.from(opts.rawBody));
            else if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
            req.emit('end');
        });
        void done;
    });
}

// ---- 1. 信任栅栏 ----
{
    const res = await call('config.get', {}, { host: 'evil.example.com:80' });
    assert.equal(res.statusCode, 403);
}
{
    const res = await call('config.get', {}, { pluginHeader: '0' });
    assert.equal(res.statusCode, 403);
}

// ---- 2. 方法分发 ----
{
    const res = await call('nope', {});
    assert.equal(res.statusCode, 404);
}
{
    const res = await call('config.get', undefined, { rawBody: '{bad json' });
    assert.equal(res.statusCode, 400);
}

// ---- 3. 配置保存 → 落盘 → 读回(隔离键 = root 的退化路径) ----
const projectRoot = path.join(tmpHome, 'fake-project'); // 无 .git → 键 = 自身
fs.mkdirSync(projectRoot, { recursive: true });
{
    const res = await call('config.save', {
        root: projectRoot,
        url: 'postgres://alice:s3cret@127.0.0.1:5439/somedb',
    });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.bodyText);
    assert.equal(parsed.ok, true);
    assert.ok(!parsed.maskedUrl.includes('s3cret'), '打码串不得含密码');

    // 文件落在 $DSH_HOME/storages 且权限收紧
    const storeFile = path.join(tmpHome, 'storages', 'db-console.json');
    assert.ok(fs.existsSync(storeFile));
    const mode = fs.statSync(storeFile).mode & 0o777;
    assert.equal(mode, 0o600, '配置文件应为 0600, 实际 ' + mode.toString(8));
    const raw = fs.readFileSync(storeFile, 'utf8');
    assert.ok(raw.includes('postgres://alice:s3cret@127.0.0.1:5439/somedb'), '按口径明文存储');
}
{
    const res = await call('config.get', { root: projectRoot });
    const parsed = JSON.parse(res.bodyText);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.url, 'postgres://alice:s3cret@127.0.0.1:5439/somedb');
    assert.ok(parsed.maskedUrl.includes('•••'));
    assert.equal(parsed.connected, false);
    assert.match(parsed.key, /fake-project$/);
}

// ---- 4. 非法链接被拒(业务错误走 200 + ok:false) ----
{
    const res = await call('config.save', { root: projectRoot, url: 'mysql://a@b/c' });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.bodyText);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /postgres/);
}

// ---- 5. 未连接时的查询/断开行为 ----
{
    const res = await call('query', { root: projectRoot, sql: 'select 1' });
    const parsed = JSON.parse(res.bodyText);
    assert.equal(parsed.ok, false);
    assert.ok(!('stack' in parsed));
}
{
    const res = await call('disconnect', { root: path.join(tmpHome, 'never-connected') });
    const parsed = JSON.parse(res.bodyText);
    assert.equal(parsed.ok, true);
}

// ---- 6. 删除配置 ----
{
    const res = await call('config.delete', { root: projectRoot });
    const parsed = JSON.parse(res.bodyText);
    assert.equal(parsed.ok, true);
    const after = JSON.parse(
        await call('config.get', { root: projectRoot }).then((r) => r.bodyText),
    );
    assert.equal(after.url, null);
}

// ---- 7. dispose 关停不抛错 ----
for (const fn of disposers) fn();

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log('db-console smoke: all assertions passed');
