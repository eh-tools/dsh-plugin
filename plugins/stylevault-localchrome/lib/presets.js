/**
 * dsh-stylevault-localchrome — StyleVault 预设生成引擎(纯 Node, 零依赖)。
 *
 * 三块:
 *   1) packTokens(c)        — 上游 GptsApp/dsh-stylevault 的 token 映射逻辑(按其实现照搬,
 *                            见 upstream lib/client.js)。输入一个小的具名调色板, 展开成
 *                            93 个 --dsw-alias-* / --dsw-specific-* 语义 token。
 *   2) derivePalette(accent)— 只给一个 accent, 推导一套完整调色板(浅/深两套), 用于
 *                            「从 Chrome 配色一键生成预设」。
 *   3) buildStyleVaultPreset— 把调色板包成 StyleVault 1.0 导出 payload,
 *                            (stylevault/name/description/basePreset/colorScheme/tokens/fonts/options/tags)。
 *
 * 纯逻辑, 不接 DSH 运行时; 可被 host 半 lib/index.js / scripts/build-preset.js CLI 引用。
 */

// ---- 基础色工具 ----

function hexToRgb(hex) {
  hex = String(hex || '')
    .replace('#', '')
    .trim();
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { r: 128, g: 128, b: 128 };
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function rgba(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function mixHex(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const r = Math.round(A.r + (B.r - A.r) * t);
  const g = Math.round(A.g + (B.g - A.g) * t);
  const bl = Math.round(A.b + (B.b - A.b) * t);
  return '#' + [r, g, bl].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue(h + 1 / 3) * 255),
    g: Math.round(hue(h) * 255),
    b: Math.round(hue(h - 1 / 3) * 255),
  };
}

function hexToHsl(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsl(r, g, b);
}

function hslToHex(h, s, l) {
  const { r, g, b } = hslToRgb(h, s, l);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 上游 packTokens 的高 ROI token 包(照搬 dsh-stylevault lib/client.js)。
 * 输入具名调色板 c, 输出完整 --dsw-alias-* / --dsw-specific-* CSS 变量表。
 */
export function packTokens(c) {
  const code = c.code || c.bg2;
  const bubble = c.bubble || c.bg1;
  const label1 = c.label1;
  const label2 = c.label2;
  const label3 = c.label3 || c.label2;
  const brand = c.brand;
  const { r: br, g: bg_, b: bb } = hexToRgb(c.bgBase);
  const isDark = (br * 299 + bg_ * 587 + bb * 114) / 1000 < 140;
  const elev = (amount) =>
    isDark ? mixHex(c.bgBase, '#ffffff', amount) : mixHex(c.bgBase, '#000000', amount * 0.45);
  const lum = (hex) => {
    const { r, g, b } = hexToRgb(hex);
    return (r * 299 + g * 587 + b * 114) / 1000;
  };
  let surface1 = c.bg1 || elev(0.08);
  let surface2 = c.bg2 || elev(0.12);
  let surface3 = c.bg3 || elev(0.16);
  if (isDark) {
    if (lum(surface1) <= lum(c.bgBase) + 2) surface1 = elev(0.1);
    if (lum(surface2) <= lum(surface1) + 2) surface2 = elev(0.16);
    if (lum(surface3) <= lum(surface2) + 2) surface3 = elev(0.22);
  } else {
    const clampWhite = (hex) => {
      const { r, g, b } = hexToRgb(hex);
      if (r > 250 && g > 250 && b > 250) return elev(0.04) || mixHex(c.bgBase, '#e8e8e8', 0.5);
      return hex;
    };
    surface1 = clampWhite(surface1);
    surface2 = clampWhite(surface2);
    surface3 = clampWhite(surface3);
  }
  const elevatedBtn = isDark ? elev(0.18) : surface1;
  const floatingFill = isDark ? elev(0.12) : surface1;
  const floatingHover = isDark ? elev(0.22) : elev(0.06);
  const inputMajor = isDark ? elev(0.12) : surface1;
  const tip = isDark ? elev(0.1) : surface1;
  const businessSoft = rgba(brand, isDark ? 0.22 : 0.14);
  const hover = isDark ? rgba('#ffffff', 0.08) : rgba(label1, 0.06);
  const hoverAccent = rgba(brand, isDark ? 0.2 : 0.12);
  const hoverSolid = surface2;
  const hoverDanger = rgba(c.error, isDark ? 0.15 : 0.08);
  const active = isDark ? rgba('#ffffff', 0.14) : rgba(label1, 0.1);
  const sidebar = c.sidebar || surface1;
  return {
    '--dsw-alias-bg-base': c.bgBase,
    '--dsw-alias-bg-layer-1': surface1,
    '--dsw-alias-bg-layer-2': surface2,
    '--dsw-alias-bg-layer-3': surface3,
    '--dsw-alias-bg-overlay': c.bgOverlay || surface2,
    '--dsw-alias-bg-module-platform': surface1,
    '--dsw-alias-bg-multi-select': surface2,
    '--dsw-alias-bg-skeleton': isDark ? rgba('#ffffff', 0.06) : rgba('#000000', 0.04),
    '--dsw-alias-bg-primary': surface1,
    '--dsw-alias-bg-mask-1': isDark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.28)',
    '--dsw-alias-bg-mask-2': isDark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.16)',
    '--dsw-alias-bg-mask-3': isDark ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.4)',
    '--dsw-alias-border-l1': c.border1,
    '--dsw-alias-border-l2': c.border2,
    '--dsw-alias-border-l2-darkmode-thin': c.border1,
    '--dsw-alias-border-l3': c.border3 || c.border2,
    '--dsw-alias-border-l4': c.border2,
    '--dsw-alias-border-secondary': c.border2,
    '--dsw-alias-brand-primary': brand,
    '--dsw-alias-brand-text': brand,
    '--dsw-alias-brand-primary-new-colorprimary-new-color': brand,
    '--dsw-alias-button-primary-fill': brand,
    '--dsw-alias-button-primary-hover': mixHex(brand, isDark ? '#ffffff' : '#000000', 0.12),
    '--dsw-alias-button-primary-dimmed': rgba(brand, 0.55),
    '--dsw-alias-button-elevated-fill': elevatedBtn,
    '--dsw-alias-button-floating-fill': floatingFill,
    '--dsw-alias-button-floating-hover': floatingHover,
    '--dsw-alias-button-info-fill': brand,
    '--dsw-alias-button-info-hover': mixHex(brand, isDark ? '#ffffff' : '#000000', 0.12),
    '--dsw-alias-button-tool-bar-fill': surface1,
    '--dsw-alias-button-tool-bar-hover': surface2,
    '--dsw-alias-button-contrast-fill': label2,
    '--dsw-alias-button-ghost-active-fill': businessSoft,
    '--dsw-alias-button-ghost-active-hover': businessSoft,
    '--dsw-alias-button-ghost-active-border': brand,
    '--dsw-alias-label-primary': label1,
    '--dsw-alias-label-secondary': label2,
    '--dsw-alias-label-tertiary': label3,
    '--dsw-alias-label-quaternary': isDark
      ? mixHex(label3, c.bgBase, 0.35)
      : mixHex(label3, c.bgBase, 0.25),
    '--dsw-alias-label-caption': label3,
    '--dsw-alias-label-dimmed': label3,
    '--dsw-alias-label-error': c.error,
    '--dsw-alias-label-inverse': c.bgBase,
    '--dsw-alias-label-primary-dimmed': label2,
    '--dsw-alias-label-primary-bluish': brand,
    '--dsw-alias-label-primary-inverted': c.bgBase,
    '--dsw-alias-label-primary-foreground': c.bgBase,
    '--dsw-alias-state-business-primary': brand,
    '--dsw-alias-state-business-tertiary': businessSoft,
    '--dsw-alias-state-success-primary': c.success,
    '--dsw-alias-state-success-secondary': rgba(c.success, isDark ? 0.28 : 0.18),
    '--dsw-alias-state-success-tertiary': rgba(c.success, isDark ? 0.18 : 0.12),
    '--dsw-alias-state-warn-primary': c.warn,
    '--dsw-alias-state-warn-secondary': rgba(c.warn, isDark ? 0.28 : 0.18),
    '--dsw-alias-state-warn-tertiary': rgba(c.warn, isDark ? 0.16 : 0.1),
    '--dsw-alias-state-warn-label': c.warn,
    '--dsw-alias-state-error-primary': c.error,
    '--dsw-alias-state-error-secondary': rgba(c.error, isDark ? 0.28 : 0.16),
    '--dsw-alias-interactive-bg-hover': hover,
    '--dsw-alias-interactive-bg-hover-accent': hoverAccent,
    '--dsw-alias-interactive-bg-hover-solid': hoverSolid,
    '--dsw-alias-interactive-bg-hover-danger': hoverDanger,
    '--dsw-alias-interactive-bg-active': active,
    '--dsw-alias-interactive-bg-primary': hover,
    '--dsw-alias-fill-l2': surface2,
    '--dsw-alias-fill-tsp-secondary': businessSoft,
    '--dsw-alias-markdown-code-block': code,
    '--dsw-alias-markdown-code-block-banner': c.codeBanner || elev(isDark ? 0.12 : 0.04),
    '--dsw-alias-markdown-inline-code': c.inlineCode || (isDark ? elev(0.14) : elev(0.05)),
    '--dsw-alias-markdown-code-segment-selected': surface1,
    '--dsw-alias-markdown-code-segment-unselected': code,
    '--dsw-alias-markdown-placeholder': label3,
    '--dsw-alias-markdown-tag': businessSoft,
    '--dsw-alias-markdown-citation': brand,
    '--dsw-alias-separator-primary': c.border1,
    '--dsw-alias-line-secondary': c.border2,
    '--dsw-alias-scrollbar-bg-l1': c.border1,
    '--dsw-alias-scrollbar-bg-l2': c.border2,
    '--dsw-alias-scrollbar-hover-l1': brand,
    '--dsw-alias-scrollbar-hover-l2': brand,
    '--dsw-alias-toast-bg': surface2,
    '--dsw-alias-tooltip-bg': surface3,
    '--dsw-specific-sidebar-fill': sidebar,
    '--dsw-specific-sidebar-nav-item-hover': surface2,
    '--dsw-specific-sidebar-nav-item-active': surface2,
    '--dsw-specific-sidebar-nav-item-active-accent': businessSoft,
    '--dsw-specific-bubble': bubble,
    '--dsw-specific-bubble-highlight': c.bubbleHi || surface2,
    '--dsw-specific-input-major': inputMajor,
    '--dsw-specific-login-input': inputMajor,
    '--dsw-specific-menu': surface1,
    '--dsw-specific-selector': surface2,
    '--dsw-specific-tip': tip,
  };
}

/**
 * 只给一个 accent, 推导一套完整调色板。dark 控制明暗。
 * 有意给可读的状态色(绿/琥珀/红): success 沿用 accent 色相(绿色系主题下就是同族绿),
 * warn/error 用固定琥珀/红, 避免浅底上过淡。
 */
export function derivePalette(accent, opts = {}) {
  const dark = opts.dark === true;
  const a = hexToHsl(accent);
  const h = a.h;
  const s = a.s;
  const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
  const sat = (k) => clamp(s * k);
  if (!dark) {
    return {
      bgBase: hslToHex(h, sat(0.2), 0.955),
      bg1: hslToHex(h, sat(0.24), 0.915),
      bg2: hslToHex(h, sat(0.28), 0.86),
      bg3: hslToHex(h, sat(0.32), 0.8),
      bgOverlay: hslToHex(h, sat(0.24), 0.905),
      border1: hslToHex(h, sat(0.3), 0.78),
      border2: hslToHex(h, sat(0.34), 0.7),
      border3: hslToHex(h, sat(0.38), 0.6),
      brand: accent,
      label1: hslToHex(h, sat(0.28), 0.22),
      label2: hslToHex(h, sat(0.22), 0.36),
      label3: hslToHex(h, sat(0.18), 0.47),
      success: hslToHex(h, 0.5, 0.4),
      warn: hslToHex(42, 0.62, 0.45),
      error: hslToHex(4, 0.65, 0.5),
      sidebar: hslToHex(h, sat(0.24), 0.915),
      code: hslToHex(h, sat(0.26), 0.875),
      bubble: hslToHex(h, sat(0.24), 0.915),
    };
  }
  return {
    bgBase: hslToHex(h, sat(0.3), 0.14),
    bg1: hslToHex(h, sat(0.32), 0.18),
    bg2: hslToHex(h, sat(0.34), 0.22),
    bg3: hslToHex(h, sat(0.36), 0.27),
    bgOverlay: hslToHex(h, sat(0.34), 0.22),
    border1: hslToHex(h, sat(0.3), 0.3),
    border2: hslToHex(h, sat(0.28), 0.38),
    border3: hslToHex(h, sat(0.26), 0.46),
    brand: accent,
    label1: hslToHex(h, sat(0.3), 0.9),
    label2: hslToHex(h, sat(0.22), 0.76),
    label3: hslToHex(h, sat(0.16), 0.6),
    success: hslToHex(h, 0.55, 0.6),
    warn: hslToHex(42, 0.55, 0.68),
    error: hslToHex(4, 0.6, 0.66),
    sidebar: hslToHex(h, sat(0.32), 0.18),
    code: hslToHex(h, sat(0.34), 0.2),
    bubble: hslToHex(h, sat(0.32), 0.18),
  };
}

export function defaultFonts() {
  return {
    ui: 'Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif',
    code: '"JetBrains Mono", "SF Mono", "Menlo", "Consolas", ui-monospace, monospace',
    uiScale: 3,
    codeScale: 3,
  };
}

export const SCHEMA_VERSION = '1.0';

/**
 * 把调色板 + 元数据包成 StyleVault 1.0 导出 payload。
 * 调色板跑 packTokens 展开成完整 token 表; brand-text 单独做可读性微调
 * (浅底用较深的同族色, 深底用较亮的同族色)。
 */
export function buildStyleVaultPreset(opts = {}) {
  const dark = opts.colorScheme === 'dark';
  const palette = opts.palette || derivePalette(opts.accent || '#88c0d0', { dark });
  const tokens = packTokens(palette);
  const a = hexToHsl(palette.brand || opts.accent || '#88c0d0');
  tokens['--dsw-alias-brand-text'] = dark
    ? hslToHex(a.h, Math.min(1, a.s * (a.s < 0.4 ? 1.4 : 1)), 0.72)
    : hslToHex(a.h, Math.min(1, a.s * 1.3), 0.38);
  return {
    stylevault: SCHEMA_VERSION,
    name: opts.name || (dark ? 'Chrome Night' : 'Chrome Day'),
    description:
      opts.description || `Generated from local Google Chrome theme accent ${palette.brand}.`,
    author: opts.author || '',
    createdAt: new Date().toISOString(),
    basePreset: opts.basePreset || (dark ? 'everforest-dark' : 'everforest-light'),
    colorScheme: dark ? 'dark' : 'light',
    tokens,
    fonts: opts.fonts || defaultFonts(),
    options: opts.options || { radius: '10px' },
    tags: opts.tags || ['chrome', dark ? 'dark' : 'light'],
  };
}

/** 便捷入口: 从 readChromeTheme() 的结果直接生成预设。 */
export function presetFromChrome(info, opts = {}) {
  const accent = info && info.color ? info.color : opts.accent || '#88c0d0';
  const dark = opts.dark === true;
  return buildStyleVaultPreset({
    accent,
    colorScheme: dark ? 'dark' : 'light',
    name: opts.name,
    description: opts.description,
    basePreset: opts.basePreset,
    author: opts.author,
    fonts: opts.fonts,
    options: opts.options,
    tags: opts.tags,
  });
}
