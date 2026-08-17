// DeepSeek 余额/调用量状态栏 — Host 端
// 用法: 作为 cordis_define 的 code.host 函数体使用(见 README.md)。
// 职责: 解析 DEEPSEEK_API_KEY(兼容 DEEPSEEK_BASE_URL), 用 curl 请求
//       GET /user/balance 拿余额; 当 base URL 指向官方 api.deepseek.com 且配置了
//       DEEPSEEK_USER_TOKEN(平台网页登录态)时, 再请求平台用量接口
//       usage/amount(按 userToken 认证)拿今日/本月 token 数。
//       结果经 harness.handle('ds-balance/query') 暴露给 Client。
//       非官方网关只返回余额, official:false 让 Client 整行隐藏。
//       另提供 ds-balance/open-login(系统浏览器打开登录页)与
//       ds-balance/save-token(把 userToken 写入本地凭证)。
// 注意: harness 是动态插件的 Host 内置符号, 本文件只能以动态插件方式运行。
return {
  apply(ctx) {
    const DEFAULT_BASE_URL = 'https://api.deepseek.com'
    const OFFICIAL_HOST = 'api.deepseek.com'
    const PLATFORM_USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'
    // dashboard 用量接口(userToken 认证, 按天返回; by_api_key/amount 的备用/主路径)。
    const PLATFORM_AMOUNT_URL = 'https://platform.deepseek.com/api/v0/usage/amount'
    // platform 前端接口需要浏览器指纹头, 否则被 WAF 429 拦截。
    const PLATFORM_HEADERS = [
      '-H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"',
      '-H "Accept: application/json, text/plain, */*"',
      '-H "Origin: https://platform.deepseek.com"',
      '-H "Referer: https://platform.deepseek.com/usage"',
      '-H "x-app-version: 1.0.0"',
      '-H "Authorization: Bearer $DSH_BALANCE_KEY"',
    ].join(' ')
    const BALANCE_HEADERS = '-H "Accept: application/json" -H "Authorization: Bearer $DSH_BALANCE_KEY"'
    // Playwright 一键登录脚本(绝对路径; 移动插件目录时同步修改)。
    const LOGIN_SCRIPT = '/Users/a1/workspace/dsh-plugin/plugins/ds-balance/scripts/deepseek-login.cjs'
    // 全局 node_modules 位置(npm root -g), 供脚本解析 playwright。
    const GLOBAL_NODE_MODULES = '/opt/homebrew/lib/node_modules'
    // node 绝对路径回退(scrubbed PATH 可能不含 homebrew bin)。
    const NODE_BIN = '/opt/homebrew/bin/node'
    let cachedAt = 0
    let cachedResult = null
    let inFlight = null
    // 浏览器登录状态机: 'idle' | 'waiting' | 'saved' | 'failed', 供 client 轮询。
    let loginState = 'idle'
    let loginError = null

    async function resolveCredential(ref) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return undefined
      try {
        return await credentials.resolve(ref)
      } catch (err) {
        console.error('ds-balance: credential resolve failed for "' + ref + '"', err)
        return undefined
      }
    }

    // 执行一次 curl GET。key 走显式 child-env opt-in(躲过密钥清理),
    // 由 sh 展开 $DSH_BALANCE_KEY, 密钥不进进程 argv。
    async function runCurl(url, headerArgs, keyValue) {
      const subprocess = ctx.get('subprocess')
      const sandboxPolicy = ctx.get('sandboxPolicy')
      if (subprocess === undefined || sandboxPolicy === undefined) {
        return { error: 'unavailable' }
      }
      let curlPath
      try {
        curlPath = await subprocess.resolveExecutable('curl')
      } catch (err) {
        console.error('ds-balance: curl is not resolvable', err)
        return { error: 'curl-missing' }
      }
      const script = 'exec ' + JSON.stringify(curlPath)
        + ' -fsS --max-time 15 ' + headerArgs + ' ' + JSON.stringify(url)
      const handle = subprocess.spawn({
        argv: ['/bin/sh', '-c', script],
        cwd: sandboxPolicy.workspaceRoot,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 65536 },
          stderr: { maxBytes: 4096 },
        },
        graceMs: 2000,
        env: { DSH_BALANCE_KEY: keyValue },
      })
      const outcome = await handle.done
      if (outcome.exitCode !== 0) return { error: 'http' }
      const stdout = handle.collected.stdout
      if (stdout === undefined) return { error: 'http' }
      const text = stdout.readFrom(0).text
      try {
        return { json: JSON.parse(text) }
      } catch (err) {
        console.error('ds-balance: response is not JSON', err)
        return { error: 'parse' }
      }
    }

    // 官方余额接口: GET {base}/user/balance
    async function queryBalance(base, keyValue) {
      const res = await runCurl(base + '/user/balance', BALANCE_HEADERS, keyValue)
      if (res.error !== undefined) return { ok: false, error: res.error }
      const infos = Array.isArray(res.json.balance_infos) ? res.json.balance_infos : []
      const info = infos[0]
      if (info === undefined) return { ok: false, error: 'parse' }
      const total = Number(info.total_balance)
      if (!Number.isFinite(total)) return { ok: false, error: 'parse' }
      const money = (v) => {
        const n = Number(v)
        return Number.isFinite(n) ? n : null
      }
      return {
        ok: true,
        currency: typeof info.currency === 'string' && info.currency !== '' ? info.currency : 'CNY',
        total,
        granted: money(info.granted_balance),
        toppedUp: money(info.topped_up_balance),
        isAvailable: res.json.is_available !== false,
      }
    }

    // 非官方判定: base URL 的主机不是 api.deepseek.com 即视为非官方,
    // Client 据此隐藏整行(网关没有官方余额/用量语义)。
    // 用正则解析主机, 不依赖 URL 全局(受限宿主环境不保证 URL 可用)。
    function officialHost(base) {
      const match = /^https?:\/\/([^/?#]+)/.exec(base)
      if (match === null) return false
      const host = match[1]
      return host === OFFICIAL_HOST || host.startsWith(OFFICIAL_HOST + ':')
    }

    // usage 里的数值可能是 number 或 string, 统一转有限数, 否则 null。
    function toFiniteNumber(v) {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v)
        return Number.isFinite(n) ? n : null
      }
      return null
    }

    // 本地时区今天 0 点的 UTC 秒(平台按 tz 参数切桶, time 为秒级时间戳)。
    function localDayStartSec(now) {
      return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
    }

    // 解析 by_api_key/amount 响应:
    // { code:0, data:{ biz_code:0, biz_data:{ series:[{ api_key, model,
    //   buckets:[{ time, usage:{ PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN,
    //     RESPONSE_TOKEN, REQUEST } }] }] } } }
    // 汇总全区间为 month, 按 time >= 今天 0 点筛出 today。结构不符返回 null。
    function parseUsage(json) {
      const data = json && typeof json === 'object' ? json.data : undefined
      if (json.code !== 0 || data === undefined || data.biz_code !== 0) return null
      const biz = data.biz_data
      if (biz === undefined || typeof biz !== 'object') return null
      const series = Array.isArray(biz.series) ? biz.series : []
      const now = new Date()
      const dayStart = localDayStartSec(now)
      const month = { requests: 0, promptCacheHit: 0, promptCacheMiss: 0, response: 0 }
      const today = { requests: 0, promptCacheHit: 0, promptCacheMiss: 0, response: 0 }
      let any = false
      for (const s of series) {
        if (s === undefined || typeof s !== 'object') continue
        const buckets = Array.isArray(s.buckets) ? s.buckets : []
        for (const b of buckets) {
          if (b === undefined || typeof b !== 'object') continue
          const usage = b.usage
          if (usage === undefined || typeof usage !== 'object') continue
          const req = toFiniteNumber(usage.REQUEST)
          const hit = toFiniteNumber(usage.PROMPT_CACHE_HIT_TOKEN)
          const miss = toFiniteNumber(usage.PROMPT_CACHE_MISS_TOKEN)
          const resp = toFiniteNumber(usage.RESPONSE_TOKEN)
          if (req === null && hit === null && miss === null && resp === null) continue
          any = true
          month.requests += req ?? 0
          month.promptCacheHit += hit ?? 0
          month.promptCacheMiss += miss ?? 0
          month.response += resp ?? 0
          if (typeof b.time === 'number' && b.time >= dayStart) {
            today.requests += req ?? 0
            today.promptCacheHit += hit ?? 0
            today.promptCacheMiss += miss ?? 0
            today.response += resp ?? 0
          }
        }
      }
      if (!any) return null
      return { today, month }
    }

    // 解析 usage/amount 响应(平台用量页 dashboard 接口, userToken 认证):
    // { code:0, data:{ biz_code:0, biz_data:{ total:[{model,usage}],
    //   days:[{ date:"YYYY-MM-DD", data:[{ model, usage:[{ type, amount }] }] }] } } }
    // type ∈ PROMPT_TOKEN | PROMPT_CACHE_HIT_TOKEN | PROMPT_CACHE_MISS_TOKEN |
    //       RESPONSE_TOKEN | REQUEST(调用次数)。
    // 汇总全月为 month, 按 date 匹配今天为 today。结构不符返回 null。
    function parseDaysUsage(json) {
      const data = json && typeof json === 'object' ? json.data : undefined
      if (json.code !== 0 || data === undefined || data.biz_code !== 0) return null
      const biz = data.biz_data
      if (biz === undefined || typeof biz !== 'object') return null
      const days = Array.isArray(biz.days) ? biz.days : []
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const todayKey = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      const month = { requests: 0, promptCacheHit: 0, promptCacheMiss: 0, response: 0 }
      const today = { requests: 0, promptCacheHit: 0, promptCacheMiss: 0, response: 0 }
      let any = false
      const addDay = (day, acc) => {
        const entries = Array.isArray(day.data) ? day.data : []
        for (const entry of entries) {
          if (entry === undefined || typeof entry !== 'object') continue
          const usage = Array.isArray(entry.usage) ? entry.usage : []
          for (const u of usage) {
            if (u === undefined || typeof u !== 'object') continue
            const amount = toFiniteNumber(u.amount)
            if (amount === null) continue
            const type = typeof u.type === 'string' ? u.type : ''
            any = true
            if (type === 'PROMPT_CACHE_HIT_TOKEN') acc.promptCacheHit += amount
            else if (type === 'PROMPT_CACHE_MISS_TOKEN') acc.promptCacheMiss += amount
            else if (type === 'RESPONSE_TOKEN') acc.response += amount
            else if (type === 'REQUEST') acc.requests += amount
            // PROMPT_TOKEN 是未命中缓存的输入旧口径, 与 CACHE_MISS 重叠, 不计。
          }
        }
      }
      for (const day of days) {
        if (day === undefined || typeof day !== 'object') continue
        addDay(day, month)
        if (day.date === todayKey) addDay(day, today)
      }
      if (!any) return null
      return { today, month }
    }

    // 平台用量接口(仅官方): 有 userToken 走 usage/amount(dashboard, 按天),
    // 没有则退回 by_api_key/amount(API key, 通常 40003 不可用)。
    async function queryUsage(keyValue, userToken) {
      const now = new Date()
      if (userToken !== undefined) {
        const month = now.getMonth() + 1
        const year = now.getFullYear()
        const url = PLATFORM_AMOUNT_URL + '?month=' + month + '&year=' + year
        const res = await runCurl(url, PLATFORM_HEADERS, userToken)
        if (res.error !== undefined) throw new Error('usage ' + res.error)
        const parsed = parseDaysUsage(res.json)
        if (parsed === null) throw new Error('usage shape mismatch')
        return parsed
      }
      const tz = -now.getTimezoneOffset() * 60
      const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000)
      const end = Math.floor(now.getTime() / 1000)
      const url = PLATFORM_USAGE_URL + '?start=' + start + '&end=' + end + '&tz=' + tz
      const res = await runCurl(url, PLATFORM_HEADERS, keyValue)
      if (res.error !== undefined) throw new Error('usage ' + res.error)
      const parsed = parseUsage(res.json)
      if (parsed === null) throw new Error('usage shape mismatch')
      return parsed
    }

    async function queryAccount() {
      const key = await resolveCredential('DEEPSEEK_API_KEY')
      if (key === undefined) return { ok: false, error: 'no-key' }
      // 平台用量接口需要网页登录态 userToken; 未配置则只显示余额。
      const tokenRef = await resolveCredential('DEEPSEEK_USER_TOKEN')
      const userToken = tokenRef === undefined ? undefined : tokenRef.value
      const baseRef = await resolveCredential('DEEPSEEK_BASE_URL')
      const base = (baseRef === undefined ? DEFAULT_BASE_URL : baseRef.value)
        .replace(/\/+$/, '').replace(/\/v1$/, '')
      const balance = await queryBalance(base, key.value)
      if (!balance.ok) return balance
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
      }
      if (result.official) {
        try {
          result.usage = await queryUsage(key.value, userToken)
        } catch (err) {
          console.error('ds-balance: usage query failed', err)
          // 用量拿不到只影响调用量两格, 余额照常显示。
        }
      }
      return result
    }

    harness.handle('ds-balance/query', async () => {
      if (cachedResult !== null && Date.now() - cachedAt < 60000) return cachedResult
      if (inFlight !== null) return inFlight
      const run = queryAccount().catch((err) => {
        console.error('ds-balance: query failed', err)
        return { ok: false, error: 'failed' }
      })
      inFlight = run.then((result) => {
        if (result.ok) {
          cachedResult = result
          cachedAt = Date.now()
        }
        return result
      }).finally(() => { inFlight = null })
      return inFlight
    })

    // 在系统浏览器打开 platform 登录页(用户登录后把 userToken 粘回插件)。
    harness.handle('ds-balance/open-login', async () => {
      const subprocess = ctx.get('subprocess')
      const sandboxPolicy = ctx.get('sandboxPolicy')
      if (subprocess === undefined || sandboxPolicy === undefined) {
        return { ok: false, error: 'unavailable' }
      }
      const LOGIN_URL = 'https://platform.deepseek.com'
      let opener = 'open'
      try {
        await subprocess.resolveExecutable('open')
      } catch {
        try {
          opener = 'xdg-open'
          await subprocess.resolveExecutable('xdg-open')
        } catch (err) {
          console.error('ds-balance: no browser opener', err)
          return { ok: false, error: 'no-opener' }
        }
      }
      const handle = subprocess.spawn({
        argv: [opener, LOGIN_URL],
        cwd: sandboxPolicy.workspaceRoot,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 },
        },
        graceMs: 2000,
      })
      await handle.done
      return { ok: true }
    })

    // 保存 userToken 到本地凭证(credentials 服务写 ~/.dsh/.credentials.yaml)。
    async function persistToken(token) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return false
      try {
        await credentials.set('DEEPSEEK_USER_TOKEN', token)
      } catch (err) {
        console.error('ds-balance: save token failed', err)
        return false
      }
      // 清缓存, 让下次查询带上新 token。
      cachedResult = null
      cachedAt = 0
      return true
    }

    // Playwright 一键登录: 弹出真实浏览器, 用户登录后脚本自动读取
    // userToken 输出到 stdout, 这里保存到本地凭证。不阻塞 handler。
    harness.handle('ds-balance/browser-login', async () => {
      const subprocess = ctx.get('subprocess')
      const sandboxPolicy = ctx.get('sandboxPolicy')
      if (subprocess === undefined || sandboxPolicy === undefined) {
        return { ok: false, error: 'unavailable' }
      }
      let nodePath
      try {
        nodePath = await subprocess.resolveExecutable('node')
      } catch {
        nodePath = NODE_BIN
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
        env: { DSH_PLAYWRIGHT_PATH: GLOBAL_NODE_MODULES + '/playwright' },
      })
      handle.done.then((outcome) => {
        const stdout = handle.collected.stdout
        if (outcome.exitCode === 0 && stdout !== undefined) {
          const text = stdout.readFrom(0).text.trim()
          try {
            const parsed = JSON.parse(text)
            if (parsed && typeof parsed.token === 'string' && parsed.token !== '') {
              void persistToken(parsed.token).then((ok) => {
                loginState = ok ? 'saved' : 'failed'
                if (!ok) loginError = 'save-failed'
              })
              return
            }
          } catch (err) {
            console.error('ds-balance: browser-login bad stdout', err)
          }
        }
        const stderr = handle.collected.stderr
        loginState = 'failed'
        loginError = stderr !== undefined ? stderr.readFrom(0).text : ('exit ' + String(outcome.exitCode))
        console.error('ds-balance: browser-login failed (exit ' + String(outcome.exitCode) + ')', loginError)
      })
      return { ok: true }
    })

    // 登录状态查询(不走 query 缓存, 供 client 轮询恢复)。
    harness.handle('ds-balance/login-status', async () => {
      return { state: loginState, error: loginError }
    })
  },
}
