/**
 * dsh-stylevault-localchrome — 本地 Chrome 浏览器主题读取器(纯 Node, 零依赖)。
 *
 * 职责: 从本机 Chrome 的 <User Data>/<profile>/Preferences 里读出「自定义外观 /
 * Customize Chrome」配色, 并把存成带符号 32 位 SkColor(0xAARRGGBB) 的 user_color
 * 解码回 #RRGGBB。这是一个独立的、可复用的脚本: 既被 host 半 lib/index.js 和
 * scripts/build-preset.js CLI 引用, 也可单独 `node` 直接跑着玩。
 *
 * 判别:
 *   - browser.theme(本机用户色主题), extensions.theme.id === 'user_color_theme_id'
 *     → 说明是「用户色」主题(Chrome 内建自定义外观), user_color 才有意义;
 *   - 若 extensions.theme.id 是一个 Web Store 扩展 id → 是商店图片主题,
 *     颜色由扩展自身控制, 不在 browser.theme 这棵 JSON 里, 本读取器会明确标注。
 *
 * 纯逻辑, 不接 DSH 运行时; 出错一律返回结构化结果而非 throw(除非显式要 strict)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USER_COLOR_THEME_ID = 'user_color_theme_id';

/** Windows/macOS 默认 Chrome Preferences 路径; profile 默认 'Default'。 */
export function defaultPreferencesPath(profile = 'Default') {
  const base =
    process.env.LOCALAPPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
      : process.env.APPDATA || path.join(os.homedir(), '.config'));
  if (process.platform === 'win32') {
    return path.join(base, 'Google', 'Chrome', 'User Data', profile, 'Preferences');
  }
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      profile,
      'Preferences',
    );
  }
  return path.join(base, 'google-chrome', profile, 'Preferences');
}

/**
 * 把 Chrome 的 user_color(通常是带符号 32 位 SkColor/ARGB)解码为 #RRGGBB。
 * 同时也兼容直接给 #RRGGBB / 0xAARRGGBB 字符串或普通正整数。
 *
 * @param {number|string} value
 * @returns {{hex:string, rgb:[number,number,number], argb:number}|null}
 */
export function decodeUserColor(value) {
  if (value === null || value === undefined || value === '') return null;

  // 字符串形式: '#87BA81' / 'FF87BA81' / '0x87BA81' / '0xFF87BA81'
  if (typeof value === 'string') {
    let s = String(value).trim().replace(/^0x/i, '').replace(/^#/, '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6,8}$/.test(s)) return null;
    if (s.length === 8) s = s.slice(2); // 丢 Alpha
    const n = parseInt(s, 16);
    return fromRgb((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // 带符号 32 位 → 无符号
    let u = value < 0 ? value + 0x100000000 : value;
    u = u & 0xffffffff;
    return fromRgb((u >> 16) & 0xff, (u >> 8) & 0xff, u & 0xff);
  }

  return null;
}

function fromRgb(r, g, b) {
  const hex = '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return { hex, rgb: [r, g, b], argb: 0xff000000 | (r << 16) | (g << 8) | b };
}

/**
 * 读取 Chrome 主题。opts:
 *   file    覆盖 Preferences 路径(缺省走 defaultPreferencesPath)
 *   profile 覆盖 Chrome profile(缺省 'Default')
 *   strict  true 时文件缺失/解析失败会 throw(默认返回结构化错误)
 */
export function readChromeTheme(opts = {}) {
  const file = opts.file || process.env.CHROME_PREFS || defaultPreferencesPath(opts.profile);
  let prefs;
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (opts.strict) throw err;
    return {
      ok: false,
      error: err && err.code === 'ENOENT' ? 'prefs-not-found' : 'prefs-parse-failed',
      file,
      color: null,
      rgb: null,
      argb: null,
      color_scheme: null,
      color_variant: null,
      follows_system_colors: null,
      extensionThemeId: null,
      isUserColorTheme: false,
    };
  }

  const theme = (prefs && prefs.browser && prefs.browser.theme) || {};
  const ext = (prefs && prefs.extensions && prefs.extensions.theme) || {};
  const extensionThemeId = ext.id || null;
  const decoded = decodeUserColor(theme.user_color);
  const color_scheme = theme.color_scheme === undefined ? null : theme.color_scheme;
  // 0=system 1=light 2=dark
  const scheme =
    color_scheme === 1
      ? 'light'
      : color_scheme === 2
        ? 'dark'
        : color_scheme === 0
          ? 'system'
          : null;

  return {
    ok: true,
    file,
    isUserColorTheme: extensionThemeId === USER_COLOR_THEME_ID,
    extensionThemeId,
    color_scheme,
    color_variant: theme.color_variant === undefined ? null : theme.color_variant,
    follows_system_colors:
      theme.follows_system_colors === undefined ? null : theme.follows_system_colors,
    scheme,
    color: decoded ? decoded.hex : null,
    rgb: decoded ? decoded.rgb : null,
    argb: decoded ? decoded.argb : null,
    user_color_raw: theme.user_color === undefined ? null : theme.user_color,
  };
}

// 独立运行: node lib/chrome-theme.js
if (
  typeof process !== 'undefined' &&
  process.argv &&
  process.argv[1] &&
  process.argv[1].endsWith('chrome-theme.js')
) {
  const info = readChromeTheme();
  if (!info.ok) {
    console.error(`[svlc] 读取失败: ${info.error} (${info.file})`);
    console.error('[svlc] 可设置 CHROME_PREFS 环境变量指向 Preferences 文件');
    process.exit(1);
  }
  console.log(JSON.stringify(info, null, 2));
}
