/**
 * dsh-doc-copy — 纯函数层(可单测; 不依赖 ctx / DOM / React)
 *
 *   - parseFileAddress:   解析 `dsh-resource://file/…` 选项卡地址 → {scope, sessionId?, path}
 *   - extensionOf:        取小写扩展名(不带点)
 *   - isCopyableSource:   该路径是否是「可复制原文」的类型(排除 html/pdf/图片等渲染型)
 *   - extractDocumentText: 把 Remote 读取结果归一成文本(兼容多种返回形状)
 *
 * client bundle 无法 import host 的 ESM, 所以浏览器侧用的是本文件逻辑的**内联副本**;
 * 本文件的价值是给这份逻辑一份可执行规约(tests/address.test.mjs), 两边必须同步改。
 *
 * ⚠ `parseFileAddress` 是对官方 `util/workspace-path/file-address.ts` 的**逐语义复刻**
 * (dsh-client-ui-sidebar-documentpreview 内联了同一份实现)。地址格式变了就必须同步,
 * 否则菜单项会静默地不出现或复制到错的路径。
 */

/** 每个文件地址的开头。 */
export const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

/** 解出的第一个路径段是否是 Windows 盘符(`C:`)。 */
function isDriveSegment(segment) {
  return segment !== undefined && /^[A-Za-z]:$/.test(segment);
}

/**
 * 把文件地址读回其组成部分(**不**解析 `.` / `..`)。
 * 查询串与 fragment 后缀忽略; 编码过的路径段会解码。
 *
 * @param {string} address 候选地址
 * @returns {{scope: string, sessionId?: string, path: string}|null}
 *   scope 为 `session` 时带 sessionId; 非法地址一律 null。
 */
export function parseFileAddress(address) {
  try {
    if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return null;
    const end = address.search(/[?#]/);
    const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end);
    const parts = body.split('/');
    const scope = parts[0];
    const rest = parts.slice(1);

    if (scope === 'session') {
      const id = rest[0];
      const segments = rest.slice(1);
      if (id === undefined || id === '' || segments.length === 0) return null;
      return {
        scope,
        sessionId: decodeURIComponent(id),
        path: segments.map(decodeURIComponent).join('/'),
      };
    }

    if (scope === 'absolute') {
      const unc = rest[0] === '' && rest.length > 1;
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
      if (segments.length === 0 || segments[0] === '') return null;
      if (unc) return { scope, path: '//' + segments.join('/') };
      return {
        scope,
        path: isDriveSegment(segments[0]) ? segments.join('/') : '/' + segments.join('/'),
      };
    }

    return null;
  } catch {
    // decodeURIComponent 抛错(非法百分号编码)按非法地址处理
    return null;
  }
}

/** 小写扩展名(不带点); 没有扩展名返回 ''。 */
export function extensionOf(path) {
  const value = String(path ?? '');
  const base = value.slice(value.lastIndexOf('/') + 1).slice(value.lastIndexOf('\\') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 渲染型(非源码)扩展名 —— 这些视图没有「原始文本」可复制, 菜单项对它们不出现:
 * HTML/PDF 由浏览器渲染, 图片是二进制。
 */
const RENDERED_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'svg',
]);

/**
 * 该路径是否可复制原文。
 * 判据是「非渲染型且有扩展名」—— 于是 markdown / 纯文本 / 代码预览都有这一项,
 * 而 html / pdf / 图片预览不出现(与产品预期一致)。
 */
export function isCopyableSource(path) {
  const ext = extensionOf(path);
  if (ext === '') return false;
  return !RENDERED_EXTENSIONS.has(ext);
}

/** 把「字节类」候选值归一成文本; 不是字节/字符串就返回 null。 */
function bytesToText(candidate) {
  if (typeof candidate === 'string') return candidate;
  if (candidate instanceof Uint8Array) return new TextDecoder().decode(candidate);
  if (Array.isArray(candidate)) return new TextDecoder().decode(Uint8Array.from(candidate));
  return null;
}

/**
 * 把 Remote 的读取结果归一成文本。
 *
 * 兼容形状: 直接给字符串 / 裸 Uint8Array / number[]; `{ok:true, value:{bytes|data}}`;
 * `{ok:true, value:{text}}`; `{value:...}`。失败(`ok:false`)或无法识别 → null。
 */
export function extractDocumentText(result) {
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') return result;

  // 裸字节/数组(没有 ok / value 包裹)
  const direct = bytesToText(result);
  if (direct !== null) return direct;

  if (typeof result !== 'object') return null;
  if (result.ok === false) return null;

  const value = result.value !== undefined ? result.value : result;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;

  const fromValue = bytesToText(value);
  if (fromValue !== null) return fromValue;

  if (typeof value !== 'object') return null;
  if (typeof value.text === 'string') return value.text;

  const bytes = value.bytes !== undefined ? value.bytes : value.data;
  return bytesToText(bytes);
}
