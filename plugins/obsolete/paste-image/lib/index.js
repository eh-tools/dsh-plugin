/**
 * dsh-paste-image — host half(静态双半插件)
 *
 * 给"不支持图片输入的模型"(如纯文本模型)提供粘贴图片能力, 同时让粘贴
 * 体验保持原生:
 *
 *   - 客户端不做任何拦截, 完全走 DSH 原生粘贴流程: 粘贴图片 → 输入框显示
 *     原生图片预览 → 发送时以 image block 走 session.prompt RPC。
 *   - 本插件在宿主端包装 `apiProxy.sessions.prompt`:
 *       1. 先让原生 prompt 流程跑一次;
 *       2. 若宿主闸门以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝(纯文本模型),
 *          把消息里的 image block 通过 `attachments.saveImage` 持久化到
 *          DSH 附件存储, 替换成 `[已粘贴图片: sha256:…]` 文本标记后重试;
 *       3. 模型看到文本标记, 把 attachmentId 传给 vision 工具, 由工具从
 *          附件存储读取图片字节并发给视觉模型。
 *   - 视觉模型能看图时第一次尝试即成功, 不转换, 图片以原生 image block
 *     进入会话。
 *
 * 挂载: 见 cordis.patch.yml —— 安装后随 profile boot 自动挂载。
 */

export const name = 'dsh-paste-image';

export const inject = ['apiProxy', 'attachments'];

export function apply(ctx) {
  const sessions = ctx.apiProxy?.sessions;
  if (!sessions || typeof sessions.prompt !== 'function') {
    // apiProxy 未挂载时静默退出: 没有可包装的 prompt 入口。
    return;
  }

  const originalPrompt = sessions.prompt.bind(sessions);
  sessions.prompt = async (request) => {
    const first = await originalPrompt(request);
    if (!isModelDoesNotSupportImages(first)) return first;
    // 纯文本模型拒绝图片: 把 image block 转成 attachmentId 文本标记后重试。
    try {
      await convertImagesToMarkers(ctx, request);
    } catch (error) {
      console.error('paste-image: failed to save pasted image', error);
      return errResponse(
        request,
        `paste-image: failed to save pasted image: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return originalPrompt(request);
  };
}

/** 判断一次 prompt 响应是否为"当前模型不支持图片输入"闸门拒绝。 */
function isModelDoesNotSupportImages(result) {
  return (
    result !== null &&
    typeof result === 'object' &&
    result.result?.ok === false &&
    result.result.error?.code === 'attachment-error' &&
    result.result.error?.details?.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES'
  );
}

/**
 * 把请求里的 image block 全部持久化到附件存储, 并替换成
 * `[已粘贴图片: <attachmentId>]` 文本标记。
 */
async function convertImagesToMarkers(ctx, request) {
  const payload = request?.payload;
  const content = payload?.content;
  if (!Array.isArray(content)) return;
  let changed = false;
  const converted = [];
  for (const part of content) {
    if (
      part !== null &&
      typeof part === 'object' &&
      part.type === 'image' &&
      typeof part.data === 'string' &&
      part.data !== ''
    ) {
      const ref = await ctx.attachments.saveImage({
        data: Buffer.from(part.data, 'base64'),
        mediaType: part.mediaType,
        ...(typeof part.name === 'string' && part.name !== '' ? { name: part.name } : {}),
      });
      converted.push({ type: 'text', text: `[已粘贴图片: ${ref.attachmentId}]` });
      changed = true;
    } else {
      converted.push(part);
    }
  }
  if (changed) payload.content = converted;
}

/** 构造一个与 apiproxy err() 同形状的失败响应。 */
function errResponse(request, message) {
  return {
    rpcId: request?.rpcId,
    result: {
      ok: false,
      error: {
        code: 'attachment-error',
        message,
        details: { reason: 'PASTE_IMAGE_SAVE_FAILED' },
      },
    },
  };
}
