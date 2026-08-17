// ds-balance host 逻辑冒烟测试(无网络):
// 在 mock 环境里执行 host.js 的 apply, 校验余额/用量解析、official 判定、
// 失败回退与缓存行为。Run: node scripts/verify-ds-balance.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../plugins/ds-balance/host.js', import.meta.url), 'utf8');

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
} = {}) {
    let calls = [];
    const handlers = {};
    const harness = {
        handle(method, fn) {
            this.handlers[method] = fn;
        },
        handlers,
    };
    const credentials = {
        async resolve(ref) {
            if (ref === 'DEEPSEEK_API_KEY') return { value: 'sk-test-123' };
            if (ref === 'DEEPSEEK_BASE_URL') {
                return base === 'https://api.deepseek.com' ? undefined : { value: base };
            }
            return undefined;
        },
    };
    const ctx = {
        get(name) {
            if (name === 'credentials') return credentials;
            if (name === 'sandboxPolicy') return { workspaceRoot: '/tmp' };
            if (name === 'subprocess') {
                return {
                    async resolveExecutable() {
                        return '/usr/bin/curl';
                    },
                    spawn(spec) {
                        calls.push(spec);
                        let out;
                        if (spec.argv[2].includes('/user/balance')) {
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
    // host.js 是函数体, 包一层 function 执行
    const factory = new Function('harness', src);
    const plugin = factory(harness);
    plugin.apply(ctx);
    return { call: () => harness.handlers['ds-balance/query'](), calls };
}

// 1. 官方 base: 余额 + 用量 都解析成功
{
    const env = makeEnv();
    const r = await env.call();
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
    const env = makeEnv({ base: 'https://gateway.example.com/v1' });
    const r = await env.call();
    if (!r.ok) throw new Error('expected ok');
    if (r.official !== false) throw new Error('expected official=false');
    if (r.usage !== null) throw new Error('expected usage=null');
    console.log('2 non-official base → official=false, usage=null ok');
}

// 3. 用量接口失败(40003): ok=true, official=true, usage=null(只显示余额)
{
    const env = makeEnv({ usageFails: true });
    const r = await env.call();
    if (!r.ok) throw new Error('expected ok');
    if (r.official !== true) throw new Error('expected official');
    if (r.usage !== null) throw new Error('expected usage=null on failure');
    console.log('3 usage failure → usage=null, balance intact ok');
}

// 4. 用量响应结构不符: usage=null
{
    const env = makeEnv({
        usageBody: () => '{"code":0,"data":{"biz_code":0,"biz_data":{"nope":true}}}',
    });
    const r = await env.call();
    if (r.usage !== null) throw new Error('expected usage=null on shape mismatch');
    console.log('4 usage shape mismatch → usage=null ok');
}

// 5. 余额失败: 整体失败, 不缓存
{
    const env = makeEnv({ balanceFails: true });
    const r = await env.call();
    if (r.ok) throw new Error('expected !ok on balance failure');
    if (r.error !== 'http') throw new Error('expected error=http, got ' + r.error);
    const r2 = await env.call();
    if (r2.error !== 'http') throw new Error('expected retry (failure not cached)');
    console.log('5 balance failure → {error:"http"}, retried ok');
}

// 6. no-key: resolve 返回 undefined
{
    const src2 = fs.readFileSync(new URL('../plugins/ds-balance/host.js', import.meta.url), 'utf8');
    const handlers = {};
    const harness = {
        handle(m, fn) {
            this.handlers[m] = fn;
        },
        handlers,
    };
    const ctx = {
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
    const factory = new Function('harness', src2);
    factory(harness).apply(ctx);
    const r = await harness.handlers['ds-balance/query']();
    if (!(r.error === 'no-key')) throw new Error('expected no-key, got ' + JSON.stringify(r));
    console.log('6 no-key → {error:"no-key"} ok');
}

console.log('\nALL HOST LOGIC CHECKS PASSED');
