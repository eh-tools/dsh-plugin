// ds-balance host 逻辑冒烟测试(无网络):
// 直接 import 静态双半插件的 lib/index.js, 用 mock ctx 挂载, 再经注册的
// HTTP 路由(POST /ds-balance/api/query)校验余额/用量解析、official 判定、
// 失败回退与缓存行为。Run: node scripts/verify-ds-balance.mjs
import { apply } from '../plugins/ds-balance/lib/index.js';

const originalFetch = globalThis.fetch;

// --- 余额响应(官方真实结构) ---
const BALANCE_OK = JSON.stringify({
    is_available: true,
    balance_infos: [
        {
            currency: 'CNY',
            total_balance: '68.64',
            granted_balance: '0.00',
            topped_up_balance: '68.64',
        },
    ],
});

// --- by_api_key/amount 响应(按前端 bundle 契约构造) ---
function localDayStartSec(now = new Date()) {
    return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
}
const NOW = new Date();
const TODAY_START = localDayStartSec(NOW);
const YESTERDAY_START = TODAY_START - 86400;

function usageJson() {
    return JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
            biz_code: 0,
            biz_msg: 'success',
            biz_data: {
                start: 1750000000,
                end: 1752600000,
                bucket: 'day',
                models: ['deepseek-chat'],
                series: [
                    {
                        api_key: 'sk-xxx',
                        model: 'deepseek-chat',
                        buckets: [
                            {
                                time: TODAY_START,
                                usage: {
                                    PROMPT_CACHE_HIT_TOKEN: '30000',
                                    PROMPT_CACHE_MISS_TOKEN: '2000',
                                    RESPONSE_TOKEN: '1500',
                                    REQUEST: 10,
                                },
                            }, // 今天
                            {
                                time: YESTERDAY_START,
                                usage: {
                                    PROMPT_CACHE_HIT_TOKEN: '500000',
                                    PROMPT_CACHE_MISS_TOKEN: '30000',
                                    RESPONSE_TOKEN: '40000',
                                    REQUEST: 300,
                                },
                            }, // 之前
                        ],
                    },
                ],
            },
        },
    });
}

// 按 URL 分发 mock 响应; 默认情况返回余额+用量都成功
function makeEnv({
    usageBody = () => usageJson(),
    usageFails = false,
    balanceFails = false,
    base = 'https://api.deepseek.com',
    userToken,
} = {}) {
    const routes = [];
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/user/balance')) {
            if (balanceFails) return { ok: false, status: 500, text: async () => '' };
            return { ok: true, status: 200, text: async () => BALANCE_OK };
        }
        if (usageFails) {
            return {
                ok: true,
                status: 200,
                text: async () =>
                    '{"code":40003,"msg":"Authorization Failed (invalid token)","data":null}',
            };
        }
        return { ok: true, status: 200, text: async () => usageBody() };
    };
    const credentials = {
        async resolve(ref) {
            if (ref === 'DEEPSEEK_API_KEY') return { value: 'sk-test-123' };
            if (ref === 'DEEPSEEK_BASE_URL') {
                return base === 'https://api.deepseek.com' ? undefined : { value: base };
            }
            if (ref === 'DEEPSEEK_USER_TOKEN') {
                return userToken === undefined ? undefined : { value: userToken };
            }
            return undefined;
        },
    };
    const ctx = {
        webServer: {
            register(spec) {
                routes.push(spec);
            },
        },
        get(name) {
            if (name === 'credentials') return credentials;
            if (name === 'sandboxPolicy') return { workspaceRoot: '/tmp' };
            if (name === 'subprocess') {
                return {
                    async resolveExecutable() {
                        return '/usr/bin/curl';
                    },
                    spawn(spec) {
                        let out;
                        const scriptArg = spec.argv.find(
                            (a) =>
                                typeof a === 'string' &&
                                (a.includes('/user/balance') || a.includes('/api/v0/usage')),
                        );
                        if (scriptArg && scriptArg.includes('/user/balance')) {
                            if (balanceFails)
                                return {
                                    done: Promise.resolve({ exitCode: 22 }),
                                    collected: {
                                        stdout: {
                                            readFrom() {
                                                return { text: '' };
                                            },
                                        },
                                    },
                                };
                            out = BALANCE_OK;
                        } else if (usageFails)
                            out =
                                '{"code":40003,"msg":"Authorization Failed (invalid token)","data":null}';
                        else out = usageBody();
                        return {
                            done: Promise.resolve({ exitCode: 0 }),
                            collected: {
                                stdout: {
                                    readFrom() {
                                        return { text: out };
                                    },
                                },
                            },
                        };
                    },
                };
            }
            return undefined;
        },
    };
    apply(ctx);
    const spec = routes.find((r) => r.kind === 'prefix' && r.path === '/ds-balance/api');
    if (spec === undefined) throw new Error('route /ds-balance/api not registered');
    // 走 HTTP 路由入口: POST /ds-balance/api/<method>(本测试只用 query)。
    return async (method = 'query') => {
        let status = 0;
        let body = '';
        const res = {
            writeHead(s) {
                status = s;
            },
            end(payload) {
                body = payload;
            },
        };
        const req = {
            method: 'POST',
            url: '/ds-balance/api/' + method,
            headers: { host: '127.0.0.1:3080', 'x-dsh-plugin': '1' },
        };
        await spec.handler(req, res);
        if (status !== 200) throw new Error('route status ' + status + ': ' + body);
        return JSON.parse(body);
    };
}

// 1. 官方 base: 余额 + 用量 都解析成功
{
    const call = makeEnv();
    const r = await call();
    console.log('1 official ok:', JSON.stringify(r, null, 0));
    if (!r.ok) throw new Error('expected ok');
    if (!r.official) throw new Error('expected official');
    if (r.usage === null) throw new Error('expected usage');
    if (r.usage.today.requests !== 10)
        throw new Error('today.requests != 10, got ' + r.usage.today.requests);
    if (r.usage.today.response !== 1500) throw new Error('today.response != 1500');
    if (r.usage.month.requests !== 310)
        throw new Error('month.requests != 310, got ' + r.usage.month.requests);
    if (r.usage.month.promptCacheHit !== 530000) throw new Error('month.cacheHit != 530000');
    if (r.total !== 68.64) throw new Error('total != 68.64');
    console.log('  ok — balance + today/month usage parsed correctly');
}

// 2. 非官方 base: official=false, usage=null
{
    const call = makeEnv({ base: 'https://gateway.example.com/v1' });
    const r = await call();
    if (!r.ok) throw new Error('expected ok');
    if (r.official !== false) throw new Error('expected official=false');
    if (r.usage !== null) throw new Error('expected usage=null');
    console.log('2 non-official base → official=false, usage=null ok');
}

// 3. 用量接口失败(40003): ok=true, official=true, usage=null(只显示余额)
{
    const call = makeEnv({ usageFails: true });
    const r = await call();
    if (!r.ok) throw new Error('expected ok');
    if (r.official !== true) throw new Error('expected official');
    if (r.usage !== null) throw new Error('expected usage=null on failure');
    console.log('3 usage failure → usage=null, balance intact ok');
}

// 4. 用量响应结构不符: usage=null
{
    const call = makeEnv({
        usageBody: () => '{"code":0,"data":{"biz_code":0,"biz_data":{"nope":true}}}',
    });
    const r = await call();
    if (r.usage !== null) throw new Error('expected usage=null on shape mismatch');
    console.log('4 usage shape mismatch → usage=null ok');
}

// 5. 余额失败: 整体失败, 不缓存
{
    const call = makeEnv({ balanceFails: true });
    const r = await call();
    if (r.ok) throw new Error('expected !ok on balance failure');
    if (r.error !== 'http') throw new Error('expected error=http, got ' + r.error);
    const r2 = await call();
    if (r2.error !== 'http') throw new Error('expected retry (failure not cached)');
    console.log('5 balance failure → {error:"http"}, retried ok');
}

// 6. no-key: resolve 返回 undefined
{
    const routes = [];
    const ctx = {
        webServer: {
            register(spec) {
                routes.push(spec);
            },
        },
        get(name) {
            if (name === 'credentials')
                return {
                    async resolve() {
                        return undefined;
                    },
                };
            return undefined;
        },
    };
    apply(ctx);
    const spec = routes.find((r) => r.kind === 'prefix' && r.path === '/ds-balance/api');
    let status = 0;
    let body = '';
    const res = {
        writeHead(s) {
            status = s;
        },
        end(payload) {
            body = payload;
        },
    };
    const req = {
        method: 'POST',
        url: '/ds-balance/api/query',
        headers: { host: 'localhost', 'x-dsh-plugin': '1' },
    };
    await spec.handler(req, res);
    if (status !== 200) throw new Error('route status ' + status + ': ' + body);
    const r = JSON.parse(body);
    if (!(r.error === 'no-key')) throw new Error('expected no-key, got ' + body);
    console.log('6 no-key → {error:"no-key"} ok');
}

// 7. 用量接口不返回 REQUEST 时 requests 为 null(前端据此省略“次”)
{
    const call = makeEnv({
        usageBody: () =>
            JSON.stringify({
                code: 0,
                msg: 'success',
                data: {
                    biz_code: 0,
                    biz_msg: 'success',
                    biz_data: {
                        start: 1750000000,
                        end: 1752600000,
                        bucket: 'day',
                        models: ['deepseek-chat'],
                        series: [
                            {
                                api_key: 'sk-xxx',
                                model: 'deepseek-chat',
                                buckets: [
                                    {
                                        time: TODAY_START,
                                        usage: {
                                            PROMPT_CACHE_HIT_TOKEN: '30000',
                                            PROMPT_CACHE_MISS_TOKEN: '2000',
                                            RESPONSE_TOKEN: '1500',
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                },
            }),
    });
    const r = await call();
    if (r.usage === null) throw new Error('expected usage');
    if (r.usage.today.requests !== null) throw new Error('today.requests should be null');
    if (r.usage.month.requests !== null) throw new Error('month.requests should be null');
    if (r.usage.today.response !== 1500) throw new Error('today.response != 1500');
    console.log('7 usage without REQUEST → requests=null ok');
}

// 8. usage/amount(userToken)路径: days[].date 按 UTC 切天, today 按当前 UTC 日匹配
//    (回归: 此前用本地日期匹配, UTC+8 用户每天本地 00:00~08:00 显示今日 0)
{
    const utcDay = (d) => d.toISOString().slice(0, 10);
    const todayU = utcDay(new Date());
    const yestU = utcDay(new Date(Date.now() - 86400000));
    const call = makeEnv({
        userToken: 'tok-abc',
        usageBody: () =>
            JSON.stringify({
                code: 0,
                msg: 'success',
                data: {
                    biz_code: 0,
                    biz_msg: 'success',
                    biz_data: {
                        total: [],
                        days: [
                            {
                                date: yestU,
                                data: [
                                    {
                                        model: 'm',
                                        usage: [
                                            { type: 'REQUEST', amount: '300' },
                                            { type: 'RESPONSE_TOKEN', amount: '50' },
                                        ],
                                    },
                                ],
                            },
                            {
                                date: todayU,
                                data: [
                                    {
                                        model: 'm',
                                        usage: [
                                            { type: 'REQUEST', amount: '10' },
                                            { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '100' },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                },
            }),
    });
    const r = await call();
    if (!r.ok) throw new Error('expected ok (usage/amount path)');
    if (r.usage === null) throw new Error('expected usage');
    if (r.usage.today.requests !== 10)
        throw new Error('today.requests != 10, got ' + r.usage.today.requests);
    if (r.usage.today.promptCacheHit !== 100) throw new Error('today.hit != 100');
    if (r.usage.month.requests !== 310)
        throw new Error('month.requests != 310, got ' + r.usage.month.requests);
    console.log('8 usage/amount(userToken) → today matched by UTC date ok');
}

console.log('\nALL HOST LOGIC CHECKS PASSED');

globalThis.fetch = originalFetch;
