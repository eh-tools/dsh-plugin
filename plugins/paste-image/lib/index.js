/**
 * dsh-paste-image — host half(静态双半插件)
 *
 * 职责: 接收 client 传来的粘贴图片(base64), 校验后经 ctx.shell 落盘到
 * 会话工作目录 <cwd>/attachments/<时间戳>-<文件名>, 返回绝对路径。
 *
 * 静态插件的 client→host 通信不走动态插件的 harness.handle 私有 RPC, 而是
 * 注册一个 HTTP JSON 路由(与 dsh-better-sidebar 的 /sidebar/api 同款):
 *
 *   POST /paste-image/api/save  body: { sessionId, name, mediaType, data }
 *
 * 图片最大 30MiB, base64 放大约 4/3, 所以 JSON body 上限放宽到 45MiB
 * (dsh-better-sidebar 的 1MiB 上限不够用, 这里单独实现大 body 读取)。
 *
 * 挂载: 见 cordis.patch.yml —— 安装后随 profile boot 自动挂载, 无需动态插件
 * 流程, 无 Run 卡批准, 重启不丢。
 */

export const name = 'dsh-paste-image';

export const inject = ['webServer', 'sessions', 'shell'];

export function apply(ctx) {
  const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
  // base64 文本体积 ≈ 原始字节 × 4/3, 留一点 JSON 结构余量。
  const MAX_BODY_BYTES = 45 * 1024 * 1024;

  // ---- 路由信任栅栏: 只服务本机浏览器(与 /api 网关同源信任边界的最小版)。
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

  // 读取 JSON body, 上限 MAX_BODY_BYTES(粘贴图片的 base64 可到 ~40MiB)。
  async function readJsonBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error('request body too large');
        err.status = 413;
        throw err;
      }
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') return {};
    return JSON.parse(text);
  }

  async function handleSave(args) {
    const { sessionId, name, mediaType, data } = args;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('missing sessionId');
    }
    if (!MEDIA_TYPES.includes(mediaType)) {
      throw new Error('unsupported media type ' + String(mediaType));
    }
    if (typeof data !== 'string' || data === '') {
      throw new Error('empty image data');
    }
    const approxBytes = Math.ceil((data.length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) {
      throw new Error('image too large (' + approxBytes + ' bytes, limit ' + MAX_IMAGE_BYTES + ')');
    }

    const session = ctx.sessions.get(sessionId);
    if (!session) {
      throw new Error('unknown session ' + sessionId);
    }
    const cwd = session.header.cwd;
    const dir = cwd + '/attachments';
    const safeName =
      typeof name === 'string' && name !== ''
        ? name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
        : 'paste.png';
    const file = Date.now() + '-' + safeName;
    const target = dir + '/' + file;

    // 用 shell 的 stdin 通道写二进制: base64 -d 从 stdin 读、写目标文件,
    // 避免超长命令行参数。
    const spec = ctx.shell.resolve({
      command: "mkdir -p '" + dir + "' && base64 -d > '" + target + "'",
      stdin: data,
      timeoutMs: 30000,
    });
    const result = await ctx.shell.run(spec);
    if (result.exitCode !== 0) {
      throw new Error('write failed (exit ' + String(result.exitCode) + '): ' + result.stderr.text);
    }
    return { path: target };
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: '/paste-image/api',
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const method = pathname.startsWith('/paste-image/api/')
        ? pathname.slice('/paste-image/api/'.length)
        : undefined;
      if (method !== 'save') {
        writeJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (err) {
        const status = err && err.status === 413 ? 413 : 400;
        writeJson(res, status, { ok: false, error: 'bad-request' });
        return;
      }
      try {
        writeJson(res, 200, await handleSave(payload));
      } catch (err) {
        console.error('paste-image: save failed', err);
        writeJson(res, 400, { ok: false, error: String(err && err.message ? err.message : err) });
      }
    },
  });
}
