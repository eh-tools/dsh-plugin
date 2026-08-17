// DeepSeek 余额状态栏 — Client 端
// 用法: 作为 cordis_define 的 code.client 函数体使用(见 README.md)。
// 职责: 注册进官方 stats 行所在的 conversation.composer.dock 槽位, 以 priority:1
//       接管官方 'stats' 单元格, 把余额并入官方那一行(DeepSeek ¥68.64 | 12 轮 · 3 步 | ...)。
//       官方 stats 的统计逻辑为逐行复刻(deriveStats / formatTokens / ...)。
// 注意: 依赖动态插件的 client 内置符号(React / host / styles)与 timer 服务,
//       本文件只能以动态插件方式运行。
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    // ---- pure helpers copied from the shipped StatsLine (ui-conversation) ----
    function assistantStepReading(node) {
      const timing = node.timing
      const ttftMs = timing !== undefined && timing.stepStartTime !== null && timing.firstTokenTime !== null
        ? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
        : null
      const decodeMs = timing !== undefined && timing.firstTokenTime !== null
        ? Math.max(0, timing.completedTime - timing.firstTokenTime)
        : null
      let outputTokens = null
      const usage = node.usage
      if (typeof usage === 'object' && usage !== null
        && typeof usage.outputTokens === 'number'
        && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0) {
        outputTokens = usage.outputTokens
      }
      return { ttftMs, decodeMs, outputTokens }
    }

    function deriveStats(nodes) {
      const turns = new Set()
      let steps = 0
      let llmMs = 0
      let toolMs = 0
      let ttftMs = 0
      let ttftSteps = 0
      let decodeMs = 0
      let decodeTokens = 0
      for (const node of nodes) {
        if (node.kind === 'tool-result') {
          if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
          continue
        }
        if (node.kind !== 'assistant') continue
        turns.add(node.turn)
        steps += 1
        if (node.timing !== undefined && node.timing.stepStartTime !== null) {
          llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
        }
        const reading = assistantStepReading(node)
        if (reading.ttftMs !== null) {
          ttftMs += reading.ttftMs
          ttftSteps += 1
        }
        if (reading.decodeMs !== null && reading.outputTokens !== null) {
          decodeMs += reading.decodeMs
          decodeTokens += reading.outputTokens
        }
      }
      return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
    }

    function formatTokens(n) {
      const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
      if (n < 1000) return String(n)
      if (n < 1000000) return scaled(n / 1000) + 'K'
      return scaled(n / 1000000) + 'M'
    }

    function formatDuration(ms) {
      const s = ms / 1000
      if (s < 60) return String(Math.round(s * 10) / 10) + 's'
      const whole = Math.round(s)
      return Math.floor(whole / 60) + 'm' + (whole % 60) + 's'
    }

    function formatTokensPerSecond(tps) {
      const clamped = Math.max(0, tps)
      return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
    }

    function billedInputTokens(usage) {
      return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    }

    function cacheHitPercent(usage) {
      const denominator = billedInputTokens(usage)
      return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 100)
    }

    // ---- balance display helpers ----
    function formatMoney(n) {
      return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    function currencySymbol(currency) {
      if (currency === 'USD') return '$'
      if (currency === 'EUR') return '€'
      return '¥'
    }

    function balanceGroup(balance) {
      if (balance.ok) {
        const symbol = currencySymbol(balance.currency)
        const parts = ['总余额 ' + symbol + formatMoney(balance.total)]
        if (balance.granted !== null) parts.push('赠送 ' + symbol + formatMoney(balance.granted))
        if (balance.toppedUp !== null) parts.push('充值 ' + symbol + formatMoney(balance.toppedUp))
        return {
          text: 'DeepSeek ' + symbol + formatMoney(balance.total),
          title: 'DeepSeek ' + parts.join(' · '),
        }
      }
      if (balance.error === 'no-key') {
        return { text: 'DeepSeek 未配置 Key', title: '未检测到 DEEPSEEK_API_KEY' }
      }
      return { text: 'DeepSeek 余额 --', title: '余额查询失败，将自动重试' }
    }

    function DockLine(props) {
      const { useSession, useProjection, t } = props
      const settledNodes = useSession((s) => s.chat.legacy.nodes)
      const usage = useProjection('tokenUsage')
      const projected = useProjection('sessionStats')
      const stats = React.useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])

      const [balance, setBalance] = React.useState(null)
      const [loaded, setLoaded] = React.useState(false)
      const busyRef = React.useRef(false)

      const refresh = React.useCallback(() => {
        if (busyRef.current) return
        busyRef.current = true
        host.call('ds-balance/query')
          .then((result) => { setBalance(result); setLoaded(true) })
          .catch(() => { setBalance({ ok: false, error: 'failed' }); setLoaded(true) })
          .finally(() => { busyRef.current = false })
      }, [])

      React.useEffect(() => {
        refresh()
        return ctx.interval(refresh, 5 * 60 * 1000)
      }, [refresh])

      const parts = []
      let balanceTitle = undefined
      if (loaded && balance !== null) {
        const bg = balanceGroup(balance)
        parts.push({ text: bg.text, kind: 'balance' })
        balanceTitle = bg.title
      }
      if (stats.steps > 0) {
        parts.push({ text: t('stats.counts', { turns: stats.turns, steps: stats.steps }), kind: 'stats' })
        const durations = []
        if (stats.llmMs > 0) durations.push(t('stats.llm', { duration: formatDuration(stats.llmMs) }))
        if (stats.toolMs > 0) durations.push(t('stats.toolCall', { duration: formatDuration(stats.toolMs) }))
        if (durations.length > 0) parts.push({ text: durations.join(' · '), kind: 'stats' })
        const speeds = []
        if (stats.ttftSteps > 0) {
          speeds.push(t('stats.ttftAverage', { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }))
        }
        if (stats.decodeMs > 0) {
          speeds.push(t('stats.tokensPerSecond', {
            throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1000)),
          }))
        }
        if (speeds.length > 0) parts.push({ text: speeds.join(' · '), kind: 'stats' })
      }
      if (usage !== undefined && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
        const cacheHit = cacheHitPercent(usage)
        if (cacheHit !== null) parts.push({ text: t('stats.cacheHit', { percent: cacheHit }), kind: 'stats' })
        parts.push({ text: t('stats.tokens', {
          input: formatTokens(billedInputTokens(usage)),
          output: formatTokens(usage.outputTokens),
        }), kind: 'stats' })
      }
      const line = parts.map((p) => p.text).join(' | ')
      const title = balanceTitle !== undefined ? balanceTitle + ' | ' + line : line

      const rootRef = React.useRef(null)
      const [truncated, setTruncated] = React.useState(false)
      React.useEffect(() => {
        const el = rootRef.current
        if (el === null) return
        const measure = () => { setTruncated(el.scrollWidth > el.clientWidth) }
        measure()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(measure)
        observer.observe(el)
        return () => { observer.disconnect() }
      }, [line])

      // Early return AFTER every hook so the hook order stays stable across
      // renders (the official StatsLine declares its hooks first too).
      if (parts.length === 0) return null
      return React.createElement(
        'div',
        { ref: rootRef, className: 'dsbalance-line', title: truncated ? title : undefined },
        parts.map((part, i) => i === 0
          ? React.createElement('span', { key: part.text, className: 'dsbalance-balance' }, part.text)
          : React.createElement(React.Fragment, { key: part.text },
              React.createElement('span', { className: 'dsbalance-sep', 'aria-hidden': true }, '|'),
              ' ',
              React.createElement('span', null, part.text),
            )),
      )
    }

    styles.insert(
      '.dsbalance-line{display:block;text-align:center;max-width:var(--dsh-chat-content-width);'
      + 'width:100%;margin:0 auto;box-sizing:border-box;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0;'
      + 'font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;'
      + 'overflow:hidden;text-overflow:ellipsis}'
      + '.dsbalance-line .dsbalance-balance{color:var(--dsw-alias-label-secondary)}'
      + '.dsbalance-line .dsbalance-sep{color:inherit;margin:0 10px}',
    )

    slots.inject('conversation.composer.dock', () => slots.register(
      { name: 'conversation.composer.dock', id: 'stats', order: 0, priority: 1, locale: 'conversation' },
      DockLine,
    ))
  },
}
