/**
 * dsh-stylevault-localchrome — host 半(静态双半插件)
 *
 * 职责: 在 Node 侧读本机 Chrome 主题并把「预设生成」能力暴露给浏览器客户端。
 * 主题引擎与设置面板由上游 GptsApp/dsh-stylevault 提供, 本插件不接触运行时主题 ——
 * 只读取/生成 StyleVault 1.0 预设 JSON, 交给用户去上游面板导入。
 *
 * 路由(与 dsh-file-git-explorer / dsh-ds-balance 同款信任栅栏):
 *   GET  /svlc/api/chrome   → 读本机 Chrome 配色(解码后 #RRGGBB + 元数据)
 *   POST /svlc/api/preset   → { accent?|fromChrome, dark?, name?, basePreset?, author?, tags? }
 *                                    生成一份 StyleVault 1.0 预设 JSON
 *   POST /svlc/api/sage     → 直接返回内置的 Sage Mist 预设(assets/sage-mist.stylevault.json)
 *
 * 信任栅栏: 只接受 127.0.0.1/localhost + `x-dsh-plugin: 1` 头; 仅本机浏览器可调用。
 * 纯读取, 无写盘、无网络请求。
 *
 * 挂载: 见 cordis.patch.yml —— 安装后随 profile boot 自动挂载。
 */

import { createRequire } from 'node:module';
import { readChromeTheme, decodeUserColor } from './chrome-theme.js';
import {
  derivePalette,
  buildStyleVaultPreset,
  presetFromChrome,
  SCHEMA_VERSION,
} from './presets.js';

const require = createRequire(import.meta.url);
const SAGE_PATH = require.resolve('../assets/sage-mist.stylevault.json');
const ROUTE_PREFIX = '/svlc/api';

export const name = 'dsh-stylevault-localchrome';

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

function readJsonBody(req, cap) {
  const capBytes = typeof cap === 'number' && cap > 0 ? cap : 64 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > capBytes) {
        failed = true;
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text === '' ? {} : JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function apply(ctx) {
  // 提供可注入的读取/生成服务(暴露成库; 其它插件可 ctx.get('stylevaultChromeTheme'))。
  const service = {
    version: SCHEMA_VERSION,
    readChromeTheme,
    decodeUserColor,
    derivePalette,
    buildStyleVaultPreset,
    presetFromChrome,
  };
  try {
    if (typeof ctx.provide === 'function') ctx.provide('stylevaultChromeTheme', service);
  } catch (err) {
    console.warn('[stylevault-localchrome] provide service failed', err && err.message);
  }

  const webServer = ctx.get('webServer');
  if (webServer && typeof webServer.register === 'function') {
    webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
        if (req.headers['x-dsh-plugin'] !== '1')
          return writeJson(res, 403, { ok: false, error: 'forbidden' });
        const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice(
          ROUTE_PREFIX.length + 1,
        );

        if (method === 'chrome') {
          // GET 无 body; POST 可带 { file } 覆盖
          let body = {};
          if (req.method === 'POST') {
            try {
              body = await readJsonBody(req);
            } catch {
              return writeJson(res, 400, { ok: false, error: 'bad-json' });
            }
          }
          try {
            return writeJson(res, 200, readChromeTheme({ file: body.file }));
          } catch (err) {
            return writeJson(res, 500, {
              ok: false,
              error: 'failed',
              detail: String(err).slice(0, 200),
            });
          }
        }

        if (method === 'preset') {
          if (req.method !== 'POST')
            return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
          let body;
          try {
            body = await readJsonBody(req);
          } catch {
            return writeJson(res, 400, { ok: false, error: 'bad-json' });
          }
          try {
            const payload = buildPresetFromBody(body);
            return writeJson(res, 200, payload);
          } catch (err) {
            return writeJson(res, 500, {
              ok: false,
              error: 'failed',
              detail: String(err).slice(0, 200),
            });
          }
        }

        if (method === 'sage') {
          try {
            delete require.cache[SAGE_PATH]; // 防止文件更新后仍读旧值
            return writeJson(res, 200, require(SAGE_PATH));
          } catch (err) {
            return writeJson(res, 500, {
              ok: false,
              error: 'failed',
              detail: String(err).slice(0, 200),
            });
          }
        }

        return writeJson(res, 404, { ok: false, error: 'not-found' });
      },
    });
  } else {
    console.warn('[stylevault-localchrome] webServer unavailable — 仅作为库可用, 不挂路由');
  }

  console.info(
    '[stylevault-localchrome] ready — 本地 Chrome 取色 → StyleVault 预设。' +
      'GET /svlc/api/chrome · POST /svlc/api/preset · POST /svlc/api/sage',
  );
}

/** 从请求体组装预设: 优先用 chrome 取色; body.accent 可覆盖(直接用给定 accent)。 */
function buildPresetFromBody(body) {
  const dark = body.dark === true;
  if (typeof body.accent === 'string' && body.accent.trim()) {
    const palette = derivePalette(body.accent.trim(), { dark });
    return buildStyleVaultPreset({
      palette,
      colorScheme: dark ? 'dark' : 'light',
      name: body.name,
      basePreset: body.basePreset,
      author: body.author,
      tags: body.tags,
    });
  }
  let info;
  try {
    info = readChromeTheme({ file: body.file });
  } catch {
    info = { ok: false, color: null };
  }
  if (!info || !info.color) {
    throw new Error(
      info && info.error === 'prefs-not-found' ? 'prefs-not-found' : 'no-chrome-color',
    );
  }
  return presetFromChrome(info, {
    dark,
    name: body.name,
    basePreset: body.basePreset,
    author: body.author,
    tags: body.tags,
  });
}
