// paste-image — Client 端函数体(cordis_define 的 code.client)
//
// 职责: 在 composer 输入区监听文档级 paste 事件(capture 阶段), 发现剪贴板
// 带图片文件时拦截默认行为(不触发官方图片草稿, 那会走到模型图片检查被拒),
// 把图片发给 Host 落盘, 成功后把绝对路径追加进输入框 draft。
// 依赖: slots 服务, host.call 私有 RPC, React。

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    // capture 阶段拦截: 优先于 InputBar 的 React onPaste, 阻止图片进入
    // 官方草稿栏(发送时会被 inputModalities 检查拒绝)。
    const onPasteCapture = (event) => {
      const items = event.clipboardData?.items
      if (!items) return
      const files = []
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (files.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      for (const file of files) {
        intake(file).catch((error) => {
          console.error('paste-image intake failed:', error)
        })
      }
    }

    // 读 File -> base64 data URL -> 发给 host -> 路径插入 draft。
    async function intake(file) {
      const dataUrl = await readAsDataURL(file)
      const base64 = dataUrl.split(',')[1]
      const result = await host.call('paste-image/save', {
        sessionId,
        name: file.name || '',
        mediaType: file.type || 'image/png',
        data: base64,
      })
      if (!result || typeof result.path !== 'string') {
        throw new Error('paste-image: host returned no path')
      }
      const marker = `\n[已粘贴图片: ${result.path}]`
      const next = draftRef.current === ''
        ? marker.trimStart()
        : draftRef.current + marker
      inputActions.setDraft(next)
    }

    function readAsDataURL(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('paste-image: failed to read image file'))
        reader.readAsDataURL(file)
      })
    }

    // 运行时状态: 当前会话的 inputActions 与 draft 引用。
    let inputActions = null
    let sessionId = null
    const draftRef = { current: '' }

    slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'paste-image', order: 100 },
      (props) => {
        // props 提供 inputActions / useInput / sessionId(见 slot 契约)。
        inputActions = props.inputActions
        sessionId = props.sessionId
        // 用最新快照刷新 draft 引用; 渲染 null 占位, 不显示 UI。
        draftRef.current = props.input?.draft ?? ''
        return null
      },
    ))

    ctx.on('dispose', () => {
      document.removeEventListener('paste', onPasteCapture, true)
    })
    document.addEventListener('paste', onPasteCapture, true)
  },
}
