/**
 * dsh-ds-balance — host half(静态双半插件)
 *
 * 职责: 解析 DEEPSEEK_API_KEY(兼容 DEEPSEEK_BASE_URL), 请求 GET /user/balance
 *       拿余额; 当 base URL 指向官方 api.deepseek.com 且配置了
 *       DEEPSEEK_USER_TOKEN(平台网页登录态)时, 再请求平台用量接口
 *       usage/amount(按 userToken 认证)拿今日/本月 token 数。
 *
 * 静态插件的 client→host 通信不走动态插件的 harness.handle 私有 RPC, 而是
 * 注册一个 HTTP JSON 路由(与 dsh-better-sidebar 的 /sidebar/api 同款):
 *
 *   POST /ds-balance/api/query         余额 + 用量(60s 缓存 + 并发去重)
 *   POST /ds-balance/api/open-login    系统浏览器打开 platform 登录页
 *   POST /ds-balance/api/browser-login Playwright 一键登录(自动保存 userToken)
 *   POST /ds-balance/api/login-status  登录状态查询(client 轮询恢复)
 *
 * 非官方网关只返回余额, official:false 让 client 整行隐藏。
 *
 * 挂载: 见 cordis.patch.yml —— 安装后随 profile boot 自动挂载, 无需动态插件
 * 流程, 无 Run 卡批准, 重启不丢。
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-ds-balance';

/** webServer 是唯一硬依赖; credentials/subprocess/sandboxPolicy 走可选访问。 */
export const inject = ['webServer'];

export function apply(ctx) {
  const DEFAULT_BASE_URL = 'https://api.deepseek.com';
  const OFFICIAL_HOST = 'api.deepseek.com';
  const PLATFORM_USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount';
  // dashboard 用量接口(userToken 认证, 按天返回; by_api_key/amount 的备用/主路径)。
  const PLATFORM_AMOUNT_URL = 'https://platform.deepseek.com/api/v0/usage/amount';
  // platform 前端接口需要浏览器指纹头, 否则被 WAF 429 拦截。
  const PLATFORM_HEADERS = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://platform.deepseek.com',
    Referer: 'https://platform.deepseek.com/usage',
    'x-app-version': '1.0.0',
  };
  const BALANCE_HEADERS = { Accept: 'application/json' };
  // Playwright 一键登录脚本(随包相对解析, 移动/克隆仓库无需改路径)。
  const LOGIN_SCRIPT = fileURLToPath(new URL('../scripts/deepseek-login.cjs', import.meta.url));
  // 全局 node_modules 位置(npm root -g), 供脚本解析 playwright。
  // 默认值面向本机, 其他机器可用环境变量覆盖。
  const GLOBAL_NODE_MODULES =
    process.env.DSH_DS_BALANCE_PLAYWRIGHT_PATH ??
    (process.platform === 'win32'
      ? path.join(
          process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          'npm',
          'node_modules',
        )
      : '/opt/homebrew/lib/node_modules');
  // node 绝对路径回退(scrubbed PATH 可能不含 node), 可用环境变量覆盖。
  // 直接复用当前 host 进程的 node, 天然跨平台且不依赖 PATH。
  const NODE_BIN = process.env.DSH_DS_BALANCE_NODE_BIN ?? process.execPath;

  // 在全局 node_modules 下定位可用的 playwright 模块。npm 有时会把
  // playwright 提升到顶层, 有时嵌套在 @playwright/test/node_modules 下,
  // 这里逐个探测, 避免一键登录因路径不对而失败。
  function resolvePlaywrightModule(globalNodeModules) {
    const candidates = [
      path.join(globalNodeModules, 'playwright'),
      path.join(globalNodeModules, '@playwright', 'test', 'node_modules', 'playwright'),
      path.join(globalNodeModules, 'playwright-core'),
    ];
    for (const candidate of candidates) {
      try {
        if (existsSync(path.join(candidate, 'package.json'))) return candidate;
      } catch {
        // ignore and try next
      }
    }
    return path.join(globalNodeModules, 'playwright');
  }

  let cachedAt = 0;
  let cachedResult = null;
  let inFlight = null;
  // 浏览器登录状态机: 'idle' | 'waiting' | 'saved' | 'failed', 供 client 轮询。
  let loginState = 'idle';
  let loginError = null;

  // ---- 路由信任栅栏: 只服务本机浏览器(与 /api 网关同源信任边界的最小版)。
  // 经局域网 IP 访问 DSH 时, 需要像 dsh-better-sidebar 那样接入 webRuntime 的
  // trustedHosts 才能放行; 本插件面向本地使用, 先收紧为回环地址。
  function isTrustedRequest(req) {
    const host = String(req.headers.host ?? '');
    const name = host.split(':')[0];
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
  }

  function writeJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(payload);
  }

  async function resolveCredential(ref) {
    const credentials = ctx.get('credentials');
    if (credentials === undefined) return undefined;
    try {
      return await credentials.resolve(ref);
    } catch (err) {
      console.error('ds-balance: credential resolve failed for "' + ref + '"', err);
      return undefined;
    }
  }

  // 执行一次 HTTP GET。直接用 Node 原生 fetch, 不依赖系统 curl/shell,
  // 天然跨平台且密钥只存在于内存 headers, 不会出现在 argv/env 中。
  async function httpGetJson(url, headers, keyValue) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { ...headers, authorization: 'Bearer ' + keyValue },
        signal: controller.signal,
      });
      if (!response.ok) return { error: 'http' };
      const text = await response.text();
      try {
        return { json: JSON.parse(text) };
      } catch (err) {
        console.error('ds-balance: response is not JSON', err);
        return { error: 'parse' };
      }
    } catch (err) {
      console.error('ds-balance: request failed', err);
      return { error: 'http' };
    } finally {
      clearTimeout(timer);
    }
  }

  // 官方余额接口: GET {base}/user/balance
  async function queryBalance(base, keyValue) {
    const res = await httpGetJson(base + '/user/balance', BALANCE_HEADERS, keyValue);
    if (res.error !== undefined) return { ok: false, error: res.error };
    const infos = Array.isArray(res.json.balance_infos) ? res.json.balance_infos : [];
    const info = infos[0];
    if (info === undefined) return { ok: false, error: 'parse' };
    const total = Number(info.total_balance);
    if (!Number.isFinite(total)) return { ok: false, error: 'parse' };
    const money = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      ok: true,
      currency: typeof info.currency === 'string' && info.currency !== '' ? info.currency : 'CNY',
      total,
      granted: money(info.granted_balance),
      toppedUp: money(info.topped_up_balance),
      isAvailable: res.json.is_available !== false,
    };
  }

  // 非官方判定: base URL 的主机不是 api.deepseek.com 即视为非官方,
  // client 据此隐藏整行(网关没有官方余额/用量语义)。
  function officialHost(base) {
    const match = /^https?:\/\/([^/?#]+)/.exec(base);
    if (match === null) return false;
    const host = match[1];
    return host === OFFICIAL_HOST || host.startsWith(OFFICIAL_HOST + ':');
  }

  // usage 里的数值可能是 number 或 string, 统一转有限数, 否则 null。
  function toFiniteNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  // 本地时区今天 0 点的 UTC 秒(平台按 tz 参数切桶, time 为秒级时间戳)。
  function localDayStartSec(now) {
    return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  }

  // 解析 by_api_key/amount 响应:
  // { code:0, data:{ biz_code:0, biz_data:{ series:[{ api_key, model,
  //   buckets:[{ time, usage:{ PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN,
  //     RESPONSE_TOKEN, REQUEST } }] }] } } }
  // 汇总全区间为 month, 按 time >= 今天 0 点筛出 today。结构不符返回 null。
  function parseUsage(json) {
    const data = json && typeof json === 'object' ? json.data : undefined;
    if (json.code !== 0 || data === undefined || data.biz_code !== 0) return null;
    const biz = data.biz_data;
    if (biz === undefined || typeof biz !== 'object') return null;
    const series = Array.isArray(biz.series) ? biz.series : [];
    const now = new Date();
    const dayStart = localDayStartSec(now);
    const month = { requests: 0, promptCacheHit: 0, promptCacheMiss: 0, response: 0 };
    const today = { requests: 0, promptCacheHit: 0, promptCacheMiss: 0, response: 0 };
    let any = false;
    let hasRequests = false;
    for (const s of series) {
      if (s === undefined || typeof s !== 'object') continue;
      const buckets = Array.isArray(s.buckets) ? s.buckets : [];
      for (const b of buckets) {
        if (b === undefined || typeof b !== 'object') continue;
        const usage = b.usage;
        if (usage === undefined || typeof usage !== 'object') continue;
        const req = toFiniteNumber(usage.REQUEST);
        const hit = toFiniteNumber(usage.PROMPT_CACHE_HIT_TOKEN);
        const miss = toFiniteNumber(usage.PROMPT_CACHE_MISS_TOKEN);
        const resp = toFiniteNumber(usage.RESPONSE_TOKEN);
        if (req === null && hit === null && miss === null && resp === null) continue;
        any = true;
        if (req !== null) {
          hasRequests = true;
          month.requests += req;
        }
        month.promptCacheHit += hit ?? 0;
        month.promptCacheMiss += miss ?? 0;
        month.response += resp ?? 0;
        if (typeof b.time === 'number' && b.time >= dayStart) {
          if (req !== null) today.requests += req;
          today.promptCacheHit += hit ?? 0;
          today.promptCacheMiss += miss ?? 0;
          today.response += resp ?? 0;
        }
      }
    }
    if (!any) return null;
    if (!hasRequests) {
      month.requests = null;
      today.requests = null;
    }
    return { today, month };
  }

  // 解析 usage/amount 响应(平台用量页 dashboard 接口, userToken 认证):
  // { code:0, data:{ biz_code:0, biz_data:{ total:[{model,usage}],
  //   days:[{ date:"YYYY-MM-DD", data:[{ model, usage:[{ type, amount }] }] }] } } }
  // type ∈ PROMPT_TOKEN | PROMPT_CACHE_HIT_TOKEN | PROMPT_CACHE_MISS_TOKEN |
  //       RESPONSE_TOKEN | REQUEST(调用次数)。
  // 汇总全月为 month, 按 date 匹配今天为 today。结构不符返回 null。
  function parseDaysUsage(json) {
    const data = json && typeof json === 'object' ? json.data : undefined;
    if (json.code !== 0 || data === undefined || data.biz_code !== 0) return null;
    const biz = data.biz_data;
    if (biz === undefined || typeof biz !== 'object') return null;
    const days = Array.isArray(biz.days) ? biz.days : [];
    // 平台用量接口的 days[].date 按 UTC 固定时区切天(实测 tz 参数被忽略)。
    // 若用本地日期匹配, UTC+8 用户每天本地 00:00~08:00 的"今日"会指向一个
    // 尚未开始累积的桶(该时段请求落入上一 UTC 日), 于是今日显示 0 而本月却很大。
    // 因此按 UTC 取今天的日期字符串, 与平台桶标签对齐。
    const todayKey = new Date().toISOString().slice(0, 10);
    const month = { requests: 0, promptCacheHit: 0, promptCacheMiss: 0, response: 0 };
    const today = { requests: 0, promptCacheHit: 0, promptCacheMiss: 0, response: 0 };
    let any = false;
    let hasRequests = false;
    const addDay = (day, acc) => {
      const entries = Array.isArray(day.data) ? day.data : [];
      for (const entry of entries) {
        if (entry === undefined || typeof entry !== 'object') continue;
        const usage = Array.isArray(entry.usage) ? entry.usage : [];
        for (const u of usage) {
          if (u === undefined || typeof u !== 'object') continue;
          const amount = toFiniteNumber(u.amount);
          if (amount === null) continue;
          const type = typeof u.type === 'string' ? u.type : '';
          any = true;
          if (type === 'PROMPT_CACHE_HIT_TOKEN') acc.promptCacheHit += amount;
          else if (type === 'PROMPT_CACHE_MISS_TOKEN') acc.promptCacheMiss += amount;
          else if (type === 'RESPONSE_TOKEN') acc.response += amount;
          else if (type === 'REQUEST') {
            hasRequests = true;
            acc.requests += amount;
          }
          // PROMPT_TOKEN 是未命中缓存的输入旧口径, 与 CACHE_MISS 重叠, 不计。
        }
      }
    };
    for (const day of days) {
      if (day === undefined || typeof day !== 'object') continue;
      addDay(day, month);
      if (day.date === todayKey) addDay(day, today);
    }
    if (!any) return null;
    if (!hasRequests) {
      month.requests = null;
      today.requests = null;
    }
    return { today, month };
  }

  // 平台用量接口(仅官方): 有 userToken 走 usage/amount(dashboard, 按天),
  // 没有则退回 by_api_key/amount(API key, 通常 40003 不可用)。
  async function queryUsage(keyValue, userToken) {
    const now = new Date();
    if (userToken !== undefined) {
      // days[].date 按 UTC 切天, month/year 也按 UTC 取。否则本地月上旬 00:00~08:00
      // 时(UTC 仍是上个月)响应不含 todayKey, 今日会再次显示 0。
      const todayKey = now.toISOString().slice(0, 10);
      const month = Number(todayKey.slice(5, 7));
      const year = Number(todayKey.slice(0, 4));
      const url = PLATFORM_AMOUNT_URL + '?month=' + month + '&year=' + year;
      const res = await httpGetJson(url, PLATFORM_HEADERS, userToken);
      if (res.error !== undefined) throw new Error('usage ' + res.error);
      const parsed = parseDaysUsage(res.json);
      if (parsed === null) throw new Error('usage shape mismatch');
      return parsed;
    }
    const tz = -now.getTimezoneOffset() * 60;
    const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
    const end = Math.floor(now.getTime() / 1000);
    const url = PLATFORM_USAGE_URL + '?start=' + start + '&end=' + end + '&tz=' + tz;
    const res = await httpGetJson(url, PLATFORM_HEADERS, keyValue);
    if (res.error !== undefined) throw new Error('usage ' + res.error);
    const parsed = parseUsage(res.json);
    if (parsed === null) throw new Error('usage shape mismatch');
    return parsed;
  }

  async function queryAccount() {
    const key = await resolveCredential('DEEPSEEK_API_KEY');
    if (key === undefined) return { ok: false, error: 'no-key' };
    // 平台用量接口需要网页登录态 userToken; 未配置则只显示余额。
    const tokenRef = await resolveCredential('DEEPSEEK_USER_TOKEN');
    const userToken = tokenRef === undefined ? undefined : tokenRef.value;
    const baseRef = await resolveCredential('DEEPSEEK_BASE_URL');
    const base = (baseRef === undefined ? DEFAULT_BASE_URL : baseRef.value)
      .replace(/\/+$/, '')
      .replace(/\/v1$/, '');
    const balance = await queryBalance(base, key.value);
    if (!balance.ok) return balance;
    const result = {
      ok: true,
      official: officialHost(base),
      base,
      hasToken: userToken !== undefined,
      currency: balance.currency,
      total: balance.total,
      granted: balance.granted,
      toppedUp: balance.toppedUp,
      isAvailable: balance.isAvailable,
      usage: null,
      at: Date.now(),
    };
    if (result.official) {
      try {
        result.usage = await queryUsage(key.value, userToken);
      } catch (err) {
        console.error('ds-balance: usage query failed', err);
        // 用量拿不到只影响调用量两格, 余额照常显示。
      }
    }
    return result;
  }

  // 查询(带 60s 缓存 + 并发去重)。
  async function handleQuery() {
    if (cachedResult !== null && Date.now() - cachedAt < 60000) return cachedResult;
    if (inFlight !== null) return inFlight;
    const run = queryAccount().catch((err) => {
      console.error('ds-balance: query failed', err);
      return { ok: false, error: 'failed' };
    });
    inFlight = run
      .then((result) => {
        if (result.ok) {
          cachedResult = result;
          cachedAt = Date.now();
        }
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  // 在系统浏览器打开 platform 登录页(用户登录后把 userToken 粘回插件)。
  async function handleOpenLogin() {
    const subprocess = ctx.get('subprocess');
    const sandboxPolicy = ctx.get('sandboxPolicy');
    if (subprocess === undefined || sandboxPolicy === undefined) {
      return { ok: false, error: 'unavailable' };
    }
    const LOGIN_URL = 'https://platform.deepseek.com';
    let argv;
    if (process.platform === 'win32') {
      // `start` 是 cmd 内建命令, 不依赖 explorer 是否在 PATH 中。
      argv = [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', 'start', '""', LOGIN_URL];
    } else {
      let opener = 'open';
      try {
        await subprocess.resolveExecutable('open');
      } catch {
        try {
          opener = 'xdg-open';
          await subprocess.resolveExecutable('xdg-open');
        } catch (err) {
          console.error('ds-balance: no browser opener', err);
          return { ok: false, error: 'no-opener' };
        }
      }
      argv = [opener, LOGIN_URL];
    }
    const handle = subprocess.spawn({
      argv,
      cwd: sandboxPolicy.workspaceRoot,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1024 },
        stderr: { maxBytes: 1024 },
      },
      graceMs: 2000,
    });
    await handle.done;
    return { ok: true };
  }

  // 保存 userToken 到本地凭证(credentials 服务写 ~/.dsh/.credentials.yaml)。
  async function persistToken(token) {
    const credentials = ctx.get('credentials');
    if (credentials === undefined) return false;
    try {
      await credentials.set('DEEPSEEK_USER_TOKEN', token);
    } catch (err) {
      console.error('ds-balance: save token failed', err);
      return false;
    }
    // 清缓存, 让下次查询带上新 token。
    cachedResult = null;
    cachedAt = 0;
    return true;
  }

  // Playwright 一键登录: 弹出真实浏览器, 用户登录后脚本自动读取
  // userToken 输出到 stdout, 这里保存到本地凭证。不阻塞 handler。
  async function handleBrowserLogin() {
    const subprocess = ctx.get('subprocess');
    const sandboxPolicy = ctx.get('sandboxPolicy');
    if (subprocess === undefined || sandboxPolicy === undefined) {
      return { ok: false, error: 'unavailable' };
    }
    let nodePath;
    try {
      nodePath = await subprocess.resolveExecutable('node');
    } catch {
      nodePath = NODE_BIN;
    }
    const handle = subprocess.spawn({
      argv: [nodePath, LOGIN_SCRIPT],
      cwd: sandboxPolicy.workspaceRoot,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8192 },
        stderr: { maxBytes: 8192 },
      },
      graceMs: 2000,
      env: { DSH_PLAYWRIGHT_PATH: resolvePlaywrightModule(GLOBAL_NODE_MODULES) },
    });
    handle.done.then((outcome) => {
      const stdout = handle.collected.stdout;
      if (outcome.exitCode === 0 && stdout !== undefined) {
        const text = stdout.readFrom(0).text.trim();
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed.token === 'string' && parsed.token !== '') {
            void persistToken(parsed.token).then((ok) => {
              loginState = ok ? 'saved' : 'failed';
              if (!ok) loginError = 'save-failed';
            });
            return;
          }
        } catch (err) {
          console.error('ds-balance: browser-login bad stdout', err);
        }
      }
      const stderr = handle.collected.stderr;
      loginState = 'failed';
      loginError =
        stderr !== undefined ? stderr.readFrom(0).text : 'exit ' + String(outcome.exitCode);
      console.error(
        'ds-balance: browser-login failed (exit ' + String(outcome.exitCode) + ')',
        loginError,
      );
    });
    return { ok: true };
  }

  // 登录状态查询(不走 query 缓存, 供 client 轮询恢复)。
  function handleLoginStatus() {
    return { state: loginState, error: loginError };
  }

  const API_HANDLERS = {
    query: handleQuery,
    'open-login': handleOpenLogin,
    'browser-login': handleBrowserLogin,
    'login-status': handleLoginStatus,
  };

  ctx.webServer.register({
    kind: 'prefix',
    path: '/ds-balance/api',
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      // 自定义头用于阻止跨站“简单请求”CSRF: 同源 client 会带上,
      // 跨域网页无法在 Simple Request 中携带该头, 必须先过 preflight。
      if (req.headers['x-dsh-plugin'] !== '1') {
        writeJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const method = pathname.startsWith('/ds-balance/api/')
        ? pathname.slice('/ds-balance/api/'.length)
        : undefined;
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      const handler = API_HANDLERS[method];
      if (handler === undefined) {
        writeJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      try {
        writeJson(res, 200, await handler());
      } catch (err) {
        console.error('ds-balance: api "' + method + '" failed', err);
        writeJson(res, 500, { ok: false, error: 'failed' });
      }
    },
  });
}
