// DeepSeek 余额/调用量状态栏 — Client 端
// 用法: 作为 cordis_define 的 code.client 函数体使用(见 README.md)。
// 职责: 在官方 stats 行之下注册独立第二行(conversation.composer.dock 的
//       'ds-balance' 单元格, order:1 排在官方 stats 之后), 显示
//       DeepSeek 余额 + 今日调用量 + 本月调用量。
//       未配置 key 或 base URL 非官方时(host 返回 !ok / official:false),
//       整行不渲染, 状态栏保持官方原样。
//       未配置 userToken 时提供"打开登录页 / 保存 token"入口(半自动获取)。
// 注意: 依赖动态插件的 client 内置符号(React / host / styles)与 timer 服务,
//       本文件只能以动态插件方式运行。
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    function formatTokens(n) {
      const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
      if (n < 1000) return String(n)
      if (n < 1000000) return scaled(n / 1000) + 'K'
      if (n < 1000000000) return scaled(n / 1000000) + 'M'
      return scaled(n / 1000000000) + 'B'
    }

    function formatMoney(n) {
      return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    function currencySymbol(currency) {
      if (currency === 'USD') return '$'
      if (currency === 'EUR') return '€'
      return '¥'
    }

    function BalanceLine() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [loaded, setLoaded] = React.useState(false)
      const busyRef = React.useRef(false)
      // loginPending 时正在等待 Playwright 浏览器登录; loginError 记录失败原因。
      const [loginPending, setLoginPending] = React.useState(false)
      const [loginError, setLoginError] = React.useState(null)

      const refresh = React.useCallback(() => {
        if (busyRef.current) return
        busyRef.current = true
        host.call('ds-balance/query')
          .then((result) => {
            setSnapshot(result)
            setLoaded(true)
            if (result && result.hasToken) setLoginPending(false)
          })
          .catch(() => { setSnapshot(null); setLoaded(true) })
          .finally(() => { busyRef.current = false })
      }, [])

      // Playwright 一键登录: 弹出浏览器, 用户登录后自动保存。
      const browserLogin = React.useCallback(() => {
        setLoginError(null)
        setLoginPending(true)
        host.call('ds-balance/browser-login')
          .then((result) => {
            if (result && !result.ok) {
              setLoginPending(false)
              setLoginError(result.error || 'failed')
            }
          })
          .catch(() => { setLoginPending(false); setLoginError('rpc-failed') })
      }, [])

      React.useEffect(() => {
        refresh()
        return ctx.interval(refresh, 5 * 60 * 1000)
      }, [refresh])

      // 等待浏览器登录: 轮询 host 的登录状态(不走 query 缓存), 完成后自动恢复。
      const checkLogin = React.useCallback(() => {
        host.call('ds-balance/login-status').then((st) => {
          if (!st) return
          if (st.state === 'saved') {
            setLoginPending(false)
            refresh()
          } else if (st.state === 'failed') {
            setLoginPending(false)
            setLoginError(st.error || 'failed')
          }
        }).catch(() => {})
      }, [refresh])

      React.useEffect(() => {
        if (!loginPending) return
        return ctx.interval(checkLogin, 2000)
      }, [loginPending, checkLogin])

      // 所有 hooks 都在早退之前, hook 顺序保持稳定。
      // 诊断版: 失败路径渲染一行可见状态(正式版恢复整行隐藏)。
      if (!loaded) return null
      if (snapshot === null) {
        return React.createElement('div', { className: 'dsbalance-line' }, 'DeepSeek 余额: host 调用失败')
      }
      if (!snapshot.ok) {
        return React.createElement('div', { className: 'dsbalance-line' }, 'DeepSeek 余额不可用: ' + String(snapshot.error))
      }
      if (!snapshot.official) {
        return React.createElement('div', { className: 'dsbalance-line' }, 'DeepSeek 余额(非官方网关, 已隐藏): ' + String(snapshot.base))
      }

      const symbol = currencySymbol(snapshot.currency)
      const cells = [{ text: 'DeepSeek ' + symbol + formatMoney(snapshot.total), balance: true }]
      if (snapshot.usage !== null && snapshot.usage !== undefined) {
        const { today, month } = snapshot.usage
        const tokens = (u) => u.promptCacheHit + u.promptCacheMiss + u.response
        // usage/amount 接口不返回调用次数(requests 为 null), 此时省略"次"。
        const usageCell = (label, u) => u.requests === null
          ? label + ' ' + formatTokens(tokens(u)) + ' tok'
          : label + ' ' + u.requests + ' 次 · ' + formatTokens(tokens(u)) + ' tok'
        cells.push({ text: usageCell('今日', today) })
        cells.push({ text: usageCell('本月', month) })
      }
      // 未配置 userToken 时提供一键登录入口。
      if (!snapshot.hasToken) {
        cells.push({ text: '浏览器登录', kind: 'link', onClick: browserLogin })
      }

      const detail = ['DeepSeek 总余额 ' + symbol + formatMoney(snapshot.total)]
      if (snapshot.granted !== null) detail.push('赠送 ' + symbol + formatMoney(snapshot.granted))
      if (snapshot.toppedUp !== null) detail.push('充值 ' + symbol + formatMoney(snapshot.toppedUp))
      if (snapshot.usage !== null && snapshot.usage !== undefined) {
        const day = (u) => '输入(缓存命中 ' + formatTokens(u.promptCacheHit)
          + ' / 未命中 ' + formatTokens(u.promptCacheMiss)
          + ') · 输出 ' + formatTokens(u.response)
        const count = (u) => u.requests === null ? '' : u.requests + ' 次: '
        detail.push('今日 ' + count(snapshot.usage.today) + day(snapshot.usage.today))
        detail.push('本月 ' + count(snapshot.usage.month) + day(snapshot.usage.month))
      }
      const title = detail.join('\n')

      // 等待浏览器登录: 提示用户在弹出的窗口登录, 登录后自动保存并恢复。
      if (loginPending) {
        return React.createElement('div', { className: 'dsbalance-line' },
          React.createElement('span', null, loginError !== null
            ? '浏览器登录失败: ' + loginError + '，'
            : '请在弹出的浏览器窗口中登录 platform.deepseek.com，登录后自动保存… '),
          React.createElement('span', { className: 'dsbalance-link', onClick: () => setLoginPending(false) }, '取消'),
        )
      }

      return React.createElement(
        'div',
        { className: 'dsbalance-line', title },
        cells.map((cell, i) => {
          const content = cell.kind === 'link'
            ? React.createElement('span', { className: 'dsbalance-link', onClick: cell.onClick }, cell.text)
            : cell.text
          return i === 0
            ? React.createElement('span', {
                key: 'c' + i,
                className: cell.balance ? 'dsbalance-balance' : undefined,
              }, content)
            : React.createElement(React.Fragment, { key: 'c' + i },
                React.createElement('span', { className: 'dsbalance-sep', 'aria-hidden': true }, '|'),
                ' ',
                content,
              )
        }),
      )
    }

    styles.insert(
      '.dsbalance-line{display:block;text-align:center;max-width:var(--dsh-chat-content-width);'
      + 'width:100%;margin:0 auto;box-sizing:border-box;padding:0 calc(var(--dsh-composer-side-clearance) + 16px) 4px;'
      + 'font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;'
      + 'overflow:hidden;text-overflow:ellipsis}'
      + '.dsbalance-line .dsbalance-balance{color:var(--dsw-alias-label-secondary)}'
      + '.dsbalance-line .dsbalance-sep{color:inherit;margin:0 10px}'
      + '.dsbalance-link{cursor:pointer;text-decoration:underline;color:var(--dsw-alias-label-secondary)}'
      + '.dsbalance-link:hover{color:var(--dsw-alias-label-primary)}',
    )

    slots.inject('conversation.composer.dock', () => slots.register(
      // 独立单元格, 不接管官方 stats; order:1 让本行排在官方 stats 行之下。
      { name: 'conversation.composer.dock', id: 'ds-balance', order: 1, priority: 0, locale: 'conversation' },
      BalanceLine,
    ))
  },
}
