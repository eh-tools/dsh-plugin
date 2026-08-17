// DeepSeek 余额状态栏 — Host 端
// 用法: 作为 cordis_define 的 code.host 函数体使用(见 README.md)。
// 职责: 解析 DEEPSEEK_API_KEY(兼容 DEEPSEEK_BASE_URL), 用 curl 请求
//       GET /user/balance, 通过 harness.handle('ds-balance/query') 暴露给 Client。
// 注意: harness 是动态插件的 Host 内置符号, 本文件只能以动态插件方式运行。
return {
  apply(ctx) {
    const DEFAULT_BASE_URL = 'https://api.deepseek.com'
    let cachedAt = 0
    let cachedResult = null
    let inFlight = null

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

    async function queryBalance() {
      const subprocess = ctx.get('subprocess')
      const sandboxPolicy = ctx.get('sandboxPolicy')
      if (subprocess === undefined || sandboxPolicy === undefined) {
        return { ok: false, error: 'unavailable' }
      }
      const key = await resolveCredential('DEEPSEEK_API_KEY')
      if (key === undefined) return { ok: false, error: 'no-key' }
      const baseRef = await resolveCredential('DEEPSEEK_BASE_URL')
      const base = (baseRef === undefined ? DEFAULT_BASE_URL : baseRef.value)
        .replace(/\/+$/, '').replace(/\/v1$/, '')
      let curlPath
      try {
        curlPath = await subprocess.resolveExecutable('curl')
      } catch (err) {
        console.error('ds-balance: curl is not resolvable', err)
        return { ok: false, error: 'curl-missing' }
      }
      const url = base + '/user/balance'
      // The key rides an explicit child-env opt-in (survives the secret scrub)
      // and is expanded by sh, so the secret never lands in the process argv.
      const script = 'exec ' + JSON.stringify(curlPath)
        + ' -fsS --max-time 15 -H "Authorization: Bearer $DSH_BALANCE_KEY" '
        + JSON.stringify(url)
      const handle = subprocess.spawn({
        argv: ['/bin/sh', '-c', script],
        cwd: sandboxPolicy.workspaceRoot,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 8192 },
          stderr: { maxBytes: 4096 },
        },
        graceMs: 2000,
        env: { DSH_BALANCE_KEY: key.value },
      })
      const outcome = await handle.done
      if (outcome.exitCode !== 0) return { ok: false, error: 'http' }
      const stdout = handle.collected.stdout
      if (stdout === undefined) return { ok: false, error: 'http' }
      const text = stdout.readFrom(0).text
      let data
      try {
        data = JSON.parse(text)
      } catch (err) {
        console.error('ds-balance: balance response is not JSON', err)
        return { ok: false, error: 'parse' }
      }
      const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
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
        isAvailable: data.is_available !== false,
        at: Date.now(),
      }
    }

    harness.handle('ds-balance/query', async () => {
      if (cachedResult !== null && Date.now() - cachedAt < 60000) return cachedResult
      if (inFlight !== null) return inFlight
      const run = queryBalance().catch((err) => {
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
  },
}
