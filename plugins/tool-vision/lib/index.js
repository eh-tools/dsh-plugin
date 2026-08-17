/**
 * Local vision tool for DeepSeek Harness.
 *
 * Registers one model-facing tool, `vision`, that sends a local image file to a
 * locally running llama-server (OpenAI-compatible chat completions endpoint) and
 * returns the vision model's description. The plugin is deliberately
 * dependency-free: it imports only Node builtins and the global `fetch`, and
 * registers the tool definition directly on `ctx.tools` (no `@deepseek-ai/*`
 * runtime imports), so it can be mounted from any location by absolute path.
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
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Plugin name: loader row identity and log label. */
export const name = 'tool-vision';

/** The tool registry service must exist before this plugin activates. */
export const inject = ['tools'];

/** Image extension → MIME type, for the `image_url` data URI. */
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
};

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
      'Analyze a local image file with the locally running vision model ' +
      '(an OpenAI-compatible llama-server endpoint) and return its description. ' +
      'Pass the path to the image and an optional instruction; the result is the ' +
      "model's description of the image, suitable for understanding pictures, " +
      'reading text inside images (OCR), layout analysis, and fine-grained visual detail. ' +
      'Supported formats: PNG, JPEG, WebP, BMP, GIF.',
    parameters: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description:
            'Absolute path to the image file to analyze. A relative path resolves against the process working directory.',
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
      required: ['image'],
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
      rawInput: typeof args.image === 'string' ? args.image : undefined,
    }),
    async execute(args, exec) {
      const imagePath = assertImagePath(args.image);
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
        const { dataUrl, mime } = await readImage(imagePath, maxImageBytes);
        const modelId =
          model === '' ? await resolveModel(baseUrl, timeoutMs, exec.signal, apiKey) : model;
        const text = await chatCompletion({
          baseUrl,
          model: modelId,
          dataUrl,
          mime,
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

/** The `image` argument must be a non-empty string path. */
function assertImagePath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('vision: `image` must be a non-empty path to an image file');
  }
  return path.resolve(value);
}

/**
 * Read and size-check the image, returning its data URI and MIME type.
 * @returns {Promise<{ dataUrl: string, mime: string }>}
 */
async function readImage(imagePath, maxImageBytes) {
  let info;
  try {
    info = await stat(imagePath);
  } catch {
    throw new Error(`vision: image not found: ${imagePath}`);
  }
  if (!info.isFile()) {
    throw new Error(`vision: not a file: ${imagePath}`);
  }
  if (info.size > maxImageBytes) {
    throw new Error(`vision: image too large: ${info.size} bytes (limit ${maxImageBytes})`);
  }
  const ext = path.extname(imagePath).slice(1).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(
      `vision: unsupported image type ".${ext}" (supported: ${Object.keys(MIME_BY_EXT).join(', ')})`,
    );
  }
  const buffer = await readFile(imagePath);
  assertImageSignature(buffer, mime);
  return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, mime };
}

/**
 * Verify the decoded file starts with the expected magic bytes for its
 * extension/MIME, so a renamed or corrupt file fails fast instead of being
 * forwarded to the vision backend with a misleading content type.
 */
function assertImageSignature(buffer, mime) {
  const len = buffer.length;
  const ascii = (start, end) => buffer.toString('ascii', start, end);
  const ok =
    (mime === 'image/png' &&
      len >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a) ||
    (mime === 'image/jpeg' &&
      len >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff) ||
    (mime === 'image/webp' && len >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') ||
    (mime === 'image/bmp' && len >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) ||
    (mime === 'image/gif' && len >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a'));
  if (!ok) {
    throw new Error(`vision: file content does not match image type "${mime}"`);
  }
}

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
