/**
 * Local vision tool for DeepSeek Harness.
 *
 * Registers one model-facing tool, `vision`, that takes an **attachment id**
 * (from a pasted image) and sends the image bytes to a locally running or
 * cloud OpenAI-compatible vision model, returning the model's description.
 *
 * ## Two paste paths — both produce an attachmentId the tool can read
 *
 * **Path A — image-capable model** (declares `input: [text, image]`):
 * User pastes an image → DSH host admits it → `attachments.saveImage()`
 * stores it → an image block with `attachmentId` enters the conversation.
 * The tool finds the ref in `exec.agent.session.events` and reads verified
 * bytes via `attachments.readImage(ref)`.
 *
 * **Path B — text-only model** (no image input declared):
 * The `paste-image` plugin intercepts the paste in the browser capture phase
 * (bypassing the host gate), saves the image through `attachments.saveImage()`,
 * and inserts `[已粘贴图片: sha256:…]` as a text marker into the draft.  The
 * model sees the marker, extracts the attachmentId, and passes it to this tool.
 * Since no image block exists in session events, the tool falls back to reading
 * the content-addressed file directly from the attachment store
 * (`DSH_HOME/attachments/v1/objects/<hash[:2]>/<hash>`), detecting MIME from
 * magic bytes.
 *
 * In both cases the agent only needs the attachmentId — never a file path.
 *
 * Mounting (inside any agent preset's `agent.cordis.yml`):
 *
 * ```yaml
 * - id: tool-vision
 *   name: /Users/<you>/workspace/dsh-plugin/plugins/tool-vision/lib/index.js
 *   config:
 *     baseUrl: http://127.0.0.1:8080/v1
 *     model: ''            # '' auto-detects the first model from /v1/models
 *     apiKey: ''           # 云服务认证:直接填 sk-xxx, 或 env:MY_VISION_KEY 读环境变量
 *     defaultPrompt: 用中文简要描述这张图片的内容
 *     maxTokens: 1024
 *     timeoutMs: 120000
 *     maxImageBytes: 31457280
 *     autoStart: false     # true = 服务不可达时自动拉起 llama-server
 *     serverCommand: ''    # 拉起命令;留空用默认(基于 baseUrl 的 qwen3.5-9b,
 *                          # 路径按 os.homedir() 解析,已适配 Windows)
 *     keepAliveMs: 0       # 0 = 用完即退;>0 = 闲置 keepAliveMs 毫秒后退出
 *     startupTimeoutMs: 120000
 * ```
 * @module tool-vision
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Plugin name: loader row identity and log label. */
export const name = 'tool-vision';

/** The tool registry service must exist before this plugin activates. */
export const inject = ['tools'];

/** Default endpoint of llama-server's OpenAI-compatible API. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1';

/** Plugin configuration, validated loudly in {@link apply}. */
export function apply(ctx, config = {}) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model =
    config.model === undefined || config.model === null || config.model === ''
      ? ''
      : assertString(config.model, 'model');
  // 云服务认证: '' = 无认证(本地服务); 直接填 key; 或 env:NAME 读环境变量,
  // 避免把密钥明文写进 agent.cordis.yml / 提交到 git。
  const apiKey = resolveApiKey(config.apiKey);
  const defaultPrompt =
    config.defaultPrompt === undefined || config.defaultPrompt === ''
      ? '用中文简要描述这张图片的内容'
      : assertString(config.defaultPrompt, 'defaultPrompt');
  const maxTokens = positiveInt(config.maxTokens, 1024, 'maxTokens');
  const timeoutMs = positiveInt(config.timeoutMs, 120000, 'timeoutMs');
  const maxImageBytes = positiveInt(config.maxImageBytes, 30 * 1024 * 1024, 'maxImageBytes');
  const autoStart = config.autoStart === true;
  const serverCommand =
    config.serverCommand === undefined ||
    config.serverCommand === null ||
    config.serverCommand === ''
      ? ''
      : assertString(config.serverCommand, 'serverCommand');
  const keepAliveMs = nonNegativeInt(config.keepAliveMs, 0, 'keepAliveMs');
  const startupTimeoutMs = positiveInt(config.startupTimeoutMs, 120000, 'startupTimeoutMs');

  // Managed llama-server subprocess (only when autoStart is on). One per apply
  // instance, so concurrent vision calls share a single startup/teardown.
  let child = null;
  let starting = null;
  let idleTimer = null;
  let active = 0;

  const stopServer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const proc = child;
    child = null;
    if (!proc || proc.exitCode !== null) return;
    if (process.platform === 'win32') {
      // Windows has no process-group signals. `shell: true` means the child is
      // cmd.exe with llama-server underneath it; plain proc.kill() would only
      // terminate the shell and orphan the server. taskkill /T walks the whole
      // tree and /F force-kills, so no grace timer is needed.
      try {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        // Last resort: kill the shell only (llama-server may leak).
        proc.kill('SIGTERM');
      }
      return;
    }
    // POSIX: detached + process group — kill the whole tree (shell + llama-server).
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
    // SIGTERM grace; escalate so a stuck server cannot leak.
    const killer = setTimeout(() => {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, 5000);
    killer.unref?.();
  };

  const startServer = async () => {
    const command = serverCommand || defaultServerCommand(baseUrl);
    const proc = spawn(command, {
      shell: true,
      detached: true,
      windowsHide: true, // no console window flashing on Windows
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child = proc;
    let stderrTail = '';
    proc.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        stopServer();
        throw new Error(
          `vision: auto-started server exited early (code ${proc.exitCode})${
            stderrTail ? ` — ${stderrTail}` : ''
          }`,
        );
      }
      if (await ping(baseUrl, 1500, apiKey)) return;
      await sleep(500);
    }
    stopServer();
    throw new Error(
      `vision: auto-started server did not become ready within ${startupTimeoutMs}ms${
        stderrTail ? ` — ${stderrTail}` : ''
      }`,
    );
  };

  const ensureServer = async () => {
    if (await ping(baseUrl, 1500, apiKey)) return;
    if (!autoStart) return;
    if (!starting) {
      starting = startServer().finally(() => {
        starting = null;
      });
    }
    await starting;
  };

  /**
   * One call finished. Stop the auto-started server immediately (keepAliveMs 0)
   * or arm the idle timer, but only once no other call is in flight.
   */
  const releaseServer = () => {
    active--;
    if (active > 0 || !child) return;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (keepAliveMs <= 0) {
      stopServer();
      return;
    }
    idleTimer = setTimeout(stopServer, keepAliveMs);
    idleTimer.unref?.();
  };

  ctx.on('dispose', stopServer);

  ctx.tools.register({
    name: 'vision',
    description:
      'Analyze an image that was pasted into the conversation. ' +
      'Pass the attachment id (the `sha256:…` value shown on the pasted image) ' +
      'and an optional instruction; the image is sent to a vision model ' +
      '(an OpenAI-compatible llama-server or cloud endpoint) and the result is ' +
      "the model's description of the image, suitable for understanding pictures, " +
      'reading text inside images (OCR), layout analysis, and fine-grained visual detail. ' +
      'Works with both image-capable models (image enters context natively) and ' +
      'text-only models (the paste-image plugin saves the image to the attachment ' +
      'store and inserts the attachment id as text).',
    parameters: {
      type: 'object',
      properties: {
        attachmentId: {
          type: 'string',
          description:
            'The attachment id of a pasted image already in this conversation ' +
            '(a `sha256:…` string). The image is read from the durable attachment ' +
            'store and sent to the vision model.',
        },
        prompt: {
          type: 'string',
          description:
            "Optional instruction telling the model what to describe or extract from the image. Defaults to the plugin's configured defaultPrompt.",
        },
        maxTokens: {
          type: 'integer',
          description:
            "Optional cap on generated tokens for this call. Defaults to the plugin's maxTokens setting.",
        },
      },
      required: ['attachmentId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: "The vision model's description of the image.",
          },
          model: {
            type: 'string',
            description: 'The model id that produced the description.',
          },
          durationMs: {
            type: 'integer',
            description: 'Wall-clock time of the model request in milliseconds.',
          },
        },
        // JSON-Schema form: `required` is an object-level array. Per-property
        // `required: true` is NOT part of the runtime's supported subset and
        // makes `tools.register` reject the schema at mount time.
        required: ['text', 'model', 'durationMs'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Analyze image',
      kind: 'other',
      rawInput: typeof args.attachmentId === 'string' ? args.attachmentId : undefined,
    }),
    async execute(args, exec) {
      const attachmentId = assertAttachmentId(args.attachmentId);
      const instruction =
        typeof args.prompt === 'string' && args.prompt.trim() !== '' ? args.prompt : defaultPrompt;
      const tokenCap =
        args.maxTokens === undefined
          ? maxTokens
          : positiveInt(args.maxTokens, maxTokens, 'maxTokens');

      active++;
      try {
        await ensureServer();
        const startedAt = Date.now();
        const { dataUrl } = await readAttachmentImage(ctx, exec, attachmentId, maxImageBytes);
        const modelId =
          model === '' ? await resolveModel(baseUrl, timeoutMs, exec.signal, apiKey) : model;
        const text = await chatCompletion({
          baseUrl,
          model: modelId,
          dataUrl,
          instruction,
          maxTokens: tokenCap,
          timeoutMs,
          signal: exec.signal,
          apiKey,
        });
        return { text, model: modelId, durationMs: Date.now() - startedAt };
      } finally {
        releaseServer();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Attachment resolution: pasted image → verified bytes → data URI
// ---------------------------------------------------------------------------

/**
 * The `attachmentId` argument must be a non-empty string (typically
 * `sha256:<64 hex chars>`).
 */
function assertAttachmentId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('vision: `attachmentId` must be a non-empty string (e.g. "sha256:…")');
  }
  return value.trim();
}

/**
 * Search one content-block array for an image block whose `attachmentId`
 * matches `targetId`, also descending into nested `tool-result` blocks.
 * @returns the `ImageAttachmentRef` object, or `undefined`.
 */
function imageBlockIn(content, targetId) {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
    if (
      block.type === 'image' &&
      typeof block.attachment === 'object' &&
      block.attachment !== null
    ) {
      if (String(block.attachment.attachmentId) === targetId) return block.attachment;
    }
    if (block.type === 'tool-result') {
      const nested = imageBlockIn(block.content, targetId);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * Search every event carrier that can own model-visible content (direct
 * `data.content`, `data.message.content`, and `data.inserted[]`) for an image
 * block matching `targetId`.
 * @returns the `ImageAttachmentRef`, or `undefined`.
 */
function imageInEvent(event, targetId) {
  const data = event?.data;
  if (data === undefined || data === null) return undefined;
  const direct = imageBlockIn(data.content, targetId);
  if (direct !== undefined) return direct;
  if (data.message !== undefined) {
    const wrapped = imageBlockIn(data.message.content, targetId);
    if (wrapped !== undefined) return wrapped;
  }
  if (Array.isArray(data.inserted)) {
    for (const message of data.inserted) {
      const inserted = imageBlockIn(message.content, targetId);
      if (inserted !== undefined) return inserted;
    }
  }
  return undefined;
}

/**
 * Resolve a pasted-image attachment id to its verified bytes and data URI.
 *
 * Two paths:
 *
 * 1. **Native flow** (image-capable model): the image entered the conversation
 *    as an image block.  Search `exec.agent.session.events` for the matching
 *    `ImageAttachmentRef`, then call `attachments.readImage(ref)` for verified
 *    bytes.
 *
 * 2. **paste-image plugin flow** (text-only model): the paste-image plugin
 *    intercepted the paste (bypassing the host gate), saved the image through
 *    `attachments.saveImage()`, and inserted the attachmentId as a text marker.
 *    The image is in the DSH attachment store but NOT in session events.  Fall
 *    back to reading the content-addressed file directly from the store path
 *    (`DSH_HOME/attachments/v1/objects/<hash[:2]>/<hash>`), detecting the MIME
 *    type from magic bytes.
 *
 * @param {object} ctx - plugin context (for `ctx.get('attachments')`).
 * @param {object} exec - tool execution context (for `exec.agent.session.events`).
 * @param {string} attachmentId - the `sha256:…` id.
 * @param {number} maxImageBytes - byte cap from plugin config.
 * @returns {Promise<{ dataUrl: string, mediaType: string }>}
 */
async function readAttachmentImage(ctx, exec, attachmentId, maxImageBytes) {
  const targetId = String(attachmentId);

  // 1. Try the native flow: find the full ref from session events.
  const agent = exec?.agent;
  const events = agent?.session?.events;
  let ref = undefined;
  if (Array.isArray(events)) {
    for (const event of events) {
      ref = imageInEvent(event, targetId);
      if (ref !== undefined) break;
    }
  }

  if (ref !== undefined) {
    // Native flow: use the attachments service to read verified bytes.
    if (typeof ref.bytes === 'number' && ref.bytes > maxImageBytes) {
      throw new Error(`vision: image too large: ${ref.bytes} bytes (limit ${maxImageBytes})`);
    }
    const attachments = ctx.get('attachments');
    if (attachments === undefined) {
      throw new Error('vision: no attachment service is mounted; cannot read pasted images.');
    }
    const stored = await attachments.readImage(ref, exec?.signal);
    const mediaType = ref.mediaType || stored.ref?.mediaType || 'image/png';
    const dataUrl = `data:${mediaType};base64,${Buffer.from(stored.data).toString('base64')}`;
    return { dataUrl, mediaType };
  }

  // 2. Fallback: the paste-image plugin saved the image to the attachment
  //    store but no image block exists in session events.  Read the
  //    content-addressed file directly.
  return readFromStore(ctx, targetId, maxImageBytes, exec?.signal);
}

/**
 * Read an image directly from the DSH attachment store by content hash.
 *
 * The store layout is `<root>/objects/<sha256[:2]>/<sha256>` where `<root>` is
 * `DSH_HOME/attachments/v1`.  We try `attachments.root` (LocalAttachmentStore
 * exposes it) first, then fall back to resolving DSH_HOME from the environment.
 *
 * @returns {Promise<{ dataUrl: string, mediaType: string }>}
 */
async function readFromStore(ctx, attachmentId, maxImageBytes, signal) {
  const hash = extractSha256(attachmentId);
  if (hash === null) {
    throw new Error(
      `vision: attachment "${attachmentId}" is not in this session and does not ` +
        'look like a valid sha256 attachment id.',
    );
  }

  // Resolve the store root.
  const attachments = ctx.get('attachments');
  let root = undefined;
  if (attachments !== undefined && typeof attachments.root === 'string') {
    root = attachments.root;
  } else {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    root = path.join(dshHome, 'attachments', 'v1');
  }
  const filePath = path.join(root, 'objects', hash.slice(0, 2), hash);

  let buffer;
  try {
    buffer = await readFile(filePath, { signal });
  } catch (error) {
    const code = error?.code;
    if (code === 'ENOENT') {
      throw new Error(
        `vision: attachment "${attachmentId}" not found in the attachment store ` +
          `(${filePath}). The image may not have been saved, or the store path is wrong.`,
      );
    }
    throw new Error(`vision: failed to read attachment "${attachmentId}": ${error.message}`);
  }

  if (buffer.byteLength > maxImageBytes) {
    throw new Error(`vision: image too large: ${buffer.byteLength} bytes (limit ${maxImageBytes})`);
  }

  const mediaType = detectImageMime(buffer);
  if (mediaType === null) {
    throw new Error(
      `vision: attachment "${attachmentId}" is not a recognized image format ` +
        '(expected PNG / JPEG / WebP / BMP / GIF).',
    );
  }

  const dataUrl = `data:${mediaType};base64,${buffer.toString('base64')}`;
  return { dataUrl, mediaType };
}

/**
 * Extract the 64-char hex sha256 hash from an attachment id string.
 * @returns {string|null} the hash, or null when the format is wrong.
 */
function extractSha256(attachmentId) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(String(attachmentId));
  return match ? match[1].toLowerCase() : null;
}

/** Image magic-byte signatures for MIME detection (fallback store read). */
function detectImageMime(buf) {
  const len = buf.length;
  if (len >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (len >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    len >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    len >= 6 &&
    (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (len >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return 'image/bmp';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Trim trailing slashes and require an http(s) URL. */
function normalizeBaseUrl(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_BASE_URL;
  const raw = assertString(value, 'baseUrl').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(raw)) {
    throw new Error(
      `tool-vision: config.baseUrl must be an http(s) URL (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

/** Non-empty string config value. */
function assertString(value, key) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `tool-vision: config.${key} must be a non-empty string (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** Positive integer config value, falling back when undefined. */
function positiveInt(value, fallback, key) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `tool-vision: config.${key} must be a positive integer (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** Non-negative integer config value (0 allowed), falling back when undefined. */
function nonNegativeInt(value, fallback, key) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `tool-vision: config.${key} must be a non-negative integer (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * Resolve `config.apiKey`: `''` (default) means no authentication (local
 * llama-server); a raw string is used verbatim; `env:NAME` reads the key from
 * environment variable NAME so secrets never have to sit in agent.cordis.yml.
 * Unset env vars fail loud (config error should never be silent).
 * @returns {string} the bearer token, or '' when no auth is configured.
 */
function resolveApiKey(value) {
  if (value === undefined || value === null || value === '') return '';
  const raw = assertString(value, 'apiKey');
  if (raw.startsWith('env:')) {
    const envName = raw.slice(4);
    if (envName === '') {
      throw new Error('tool-vision: config.apiKey env:NAME requires a variable name');
    }
    const fromEnv = process.env[envName];
    if (fromEnv === undefined || fromEnv === '') {
      throw new Error(`tool-vision: env var "${envName}" referenced by config.apiKey is not set`);
    }
    return fromEnv;
  }
  return raw;
}

/**
 * Authorization header for OpenAI-compatible endpoints. Returns an empty
 * object when no key is configured, so local llama-server keeps working
 * without any auth.
 * @param {string} apiKey - resolved bearer token ('' = no auth).
 */
function authHeaders(apiKey) {
  return apiKey === '' ? {} : { authorization: 'Bearer ' + apiKey };
}

// ---------------------------------------------------------------------------
// Server management (autoStart / on-demand llama-server)
// ---------------------------------------------------------------------------

/**
 * The default llama-server command, derived from `baseUrl` so a custom port in
 * the config is honored. Override via `config.serverCommand`.
 *
 * Portable across macOS/Linux and Windows: the model directory is resolved
 * through `os.homedir()` (cmd.exe does not expand `~`) and every path is
 * quoted with the platform's quote character so spaces in the home directory
 * do not break the command.
 * @param {string} baseUrl - normalized endpoint, e.g. `http://127.0.0.1:8080/v1`.
 * @returns {string} a shell command that starts llama-server with qwen3.5-9b.
 */
function defaultServerCommand(baseUrl) {
  const url = new URL(baseUrl);
  const host = url.hostname || '127.0.0.1';
  const port = url.port || '8080';
  const isWin = process.platform === 'win32';
  const quote = isWin ? '"' : "'";
  // cmd.exe does not expand ~; sh expands $HOME but not ~ inside quotes.
  const home = isWin ? process.env.USERPROFILE || os.homedir() : os.homedir();
  const modelDir = path.join(home, 'models', 'qwen3.5-9b');
  const model = `${quote}${path.join(modelDir, 'Qwen3.5-9B-Q4_K_M.gguf')}${quote}`;
  const mmproj = `${quote}${path.join(modelDir, 'mmproj-F16.gguf')}${quote}`;
  return [
    'llama-server',
    '-m',
    model,
    '--mmproj',
    mmproj,
    '--host',
    host,
    '--port',
    port,
    '-c',
    '4096',
    '-ngl',
    '99',
    '--image-min-tokens',
    '1024',
    '--alias',
    'qwen3.5-9b',
  ].join(' ');
}

/** Probe whether the endpoint answers GET /v1/models. */
async function ping(baseUrl, timeoutMs, apiKey = '') {
  const abort = abortSignal(timeoutMs, undefined);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: authHeaders(apiKey),
      signal: abort.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    abort.cleanup();
  }
}

/** Promise sleep; never rejects. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Vision model communication
// ---------------------------------------------------------------------------

/**
 * Resolve the model id: query GET {baseUrl}/models and use the first entry, or
 * fall back to `local` when the server does not advertise one.
 */
async function resolveModel(baseUrl, timeoutMs, signal, apiKey = '') {
  const abort = abortSignal(timeoutMs, signal);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: authHeaders(apiKey),
      signal: abort.signal,
    });
    if (response.ok) {
      const json = await response.json();
      const first = json?.data?.[0]?.id;
      if (typeof first === 'string' && first !== '') return first;
    }
  } catch {
    // The model field is advisory for llama-server; fall back below.
  } finally {
    abort.cleanup();
  }
  return 'local';
}

/**
 * POST a chat completion carrying the image as an `image_url` data URI and
 * return the model's text answer.
 * @returns {Promise<string>}
 */
async function chatCompletion({
  baseUrl,
  model,
  dataUrl,
  instruction,
  maxTokens,
  timeoutMs,
  signal,
  apiKey = '',
}) {
  const abort = abortSignal(timeoutMs, signal);
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      signal: abort.signal,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    throw new Error(
      `vision: failed to reach the vision server at ${baseUrl} (${error.message}) — is llama-server running?`,
    );
  } finally {
    abort.cleanup();
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `vision: server returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
    );
  }
  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content !== '') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    if (text !== '') return text;
  }
  throw new Error(
    `vision: model returned no text content (raw: ${JSON.stringify(json).slice(0, 500)})`,
  );
}

/**
 * Combine caller cancellation with a wall-clock timeout.
 *
 * Avoids `AbortSignal.any`/`AbortSignal.timeout` (Node ≥ 20.3 only) so the
 * plugin keeps working on the repo's declared `node >= 20`. The returned
 * `cleanup()` must run (finally) so the timer does not keep the process alive.
 * @returns {{ signal: AbortSignal, cleanup: () => void }}
 */
function abortSignal(timeoutMs, callerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener('abort', () => controller.abort(), { once: true });
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}
