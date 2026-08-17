// paste-image — Host 端函数体(cordis_define 的 code.host)
//
// 职责: 接收 client 传来的粘贴图片(base64), 校验后经 ctx.shell 落盘到
// 会话工作目录 <cwd>/attachments/<时间戳>-<文件名>, 返回绝对路径。
// 依赖: sessions(取会话 cwd), shell(写文件, 动态环境无 node:fs)。

return {
  name: 'paste-image-host',
  inject: ['sessions', 'shell'],
  apply(ctx) {
    const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    const MAX_IMAGE_BYTES = 30 * 1024 * 1024

    harness.handle('paste-image/save', async (args) => {
      const { sessionId, name, mediaType, data } = args
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('paste-image: missing sessionId')
      }
      if (!MEDIA_TYPES.includes(mediaType)) {
        throw new Error(`paste-image: unsupported media type ${String(mediaType)}`)
      }
      if (typeof data !== 'string' || data === '') {
        throw new Error('paste-image: empty image data')
      }
      const approxBytes = Math.ceil(data.length * 3 / 4)
      if (approxBytes > MAX_IMAGE_BYTES) {
        throw new Error(`paste-image: image too large (${approxBytes} bytes, limit ${MAX_IMAGE_BYTES})`)
      }

      const session = ctx.sessions.get(sessionId)
      if (!session) {
        throw new Error(`paste-image: unknown session ${sessionId}`)
      }
      const cwd = session.header.cwd
      const dir = `${cwd}/attachments`
      const safeName = (typeof name === 'string' && name !== '')
        ? name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
        : 'paste.png'
      const file = `${Date.now()}-${safeName}`
      const target = `${dir}/${file}`

      // 动态插件环境没有 node:fs, 用 shell 的 stdin 通道写二进制:
      // base64 -d 从 stdin 读、写目标文件, 避免超长命令行参数。
      const spec = ctx.shell.resolve({
        command: `mkdir -p '${dir}' && base64 -d > '${target}'`,
        stdin: data,
        timeoutMs: 30000,
      })
      const result = await ctx.shell.run(spec)
      if (result.exitCode !== 0) {
        throw new Error(`paste-image: write failed (exit ${String(result.exitCode)}): ${result.stderr.text}`)
      }
      return { path: target }
    })
  },
}
