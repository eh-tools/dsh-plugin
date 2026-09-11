/**
 * dsh-files-lite — 纯函数层(可单测; 不依赖 ctx / DOM / React)
 *
 * client bundle 无法 import host 的 ESM, 所以浏览器侧用的是本文件逻辑的**内联副本**;
 * 本文件的价值是给这份逻辑一份可执行规约(tests/zones.test.mjs), 两边必须同步改。
 *
 *   - joinChild:      父路径 + 子名 → 稳定键(一律 '/', host 解析混合分隔符)
 *   - isHiddenName:   dotfile 判定
 *   - shouldShow:     「显示隐藏文件」开关 + `.git` 永不显示
 *   - sortEntries:    目录优先, 再按 zh-CN 名称序
 *   - visibleEntries: 过滤 + 排序(树每层直接可用)
 */

/**
 * 父路径 + 子名 → 子项绝对路径键。
 * 一律用 `/` 连接: host 会解析混合分隔符, 而树只需要一个稳定的键。
 */
export function joinChild(parent, name) {
  const base = typeof parent === 'string' ? parent.replace(/[\\/]+$/, '') : '';
  const child = String(name);
  return base === '' ? child : base + '/' + child;
}

/**
 * 是否 dotfile(隐藏项)。
 * `.` 与 `..` 不算(它们不是条目)。`.git` 单独由 shouldShow 兜底, 因为它在
 * 「显示隐藏文件」打开时也**绝不**该出现。
 */
export function isHiddenName(name) {
  if (typeof name !== 'string' || name.length < 2 || name === '..') return false;
  return name.startsWith('.');
}

/** 「显示隐藏文件」开关下该名字是否展示。 */
export function shouldShow(name, showHidden) {
  if (typeof name !== 'string' || name === '') return false;
  if (name === '.git') return false; // 无论开关如何都不显示
  return showHidden === true ? true : !isHiddenName(name);
}

/** 目录优先, 同级按 zh-CN 名称序。 */
export function sortEntries(entries) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  return list.sort((a, b) => {
    const ad = a && a.type === 'directory' ? 0 : 1;
    const bd = b && b.type === 'directory' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return String(a && a.name).localeCompare(String(b && b.name), 'zh-CN');
  });
}

/** 某一层「过滤 + 排序」后的条目(直接可渲染)。 */
export function visibleEntries(entries, showHidden) {
  const list = Array.isArray(entries) ? entries : [];
  return sortEntries(
    list.filter(
      (entry) => entry !== null && typeof entry === 'object' && shouldShow(entry.name, showHidden),
    ),
  );
}
