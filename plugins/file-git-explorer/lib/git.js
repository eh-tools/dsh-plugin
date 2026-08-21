/**
 * dsh-file-git-explorer — 纯函数层(可单测, 不依赖 ctx / 进程)
 *
 * 这里只放"给定输入字符串/条目数组就能算出结果"的解析与划分逻辑:
 *   - parseStatusZ:     解析 `git status --porcelain=v1 -z` 输出
 *   - statusBadge:      XY 状态码 → 单字母徽标
 *   - resolveWithin:    相对路径 → 基目录内绝对路径(防目录穿越)
 *   - partitionChildren:把 readdir 条目按 可见/隐藏/忽略 三区分组
 *   - diffArgs:         按变更条目构造单文件 diff 的 git 参数
 */

import {
  resolve as pathResolve,
  relative as pathRelative,
  isAbsolute as pathIsAbsolute,
} from 'node:path';

/** 条目是否以 `.` 开头(dotfile); `.` / `..` 不算。 */
export function isDotName(name) {
  if (typeof name !== 'string' || name.length < 2 || name === '..') return false;
  return name.startsWith('.');
}

/**
 * 把以 `/` 分隔的相对路径解析到 base 之下, 返回绝对路径;
 * 若越过 base(穿越到外面)返回 null。
 */
export function resolveWithin(base, rel) {
  const abs = pathResolve(base, ...String(rel).split('/'));
  const rel2 = pathRelative(base, abs);
  if (rel2 === '') return abs; // 恰好等于 base
  if (rel2.startsWith('..') || pathIsAbsolute(rel2)) return null;
  return abs;
}

/** 与 localeCompare('zh-CN') 一致的名称比较, 供目录/变更排序复用。 */
export function compareZh(a, b) {
  return String(a).localeCompare(String(b), 'zh-CN');
}

/**
 * 解析 `git status --porcelain=v1 -z` 输出。
 *
 * 事实(已在 Windows git 2.53 实测):
 *   - 条目 NUL 分隔; 普通条目形如 `XY <path>`。
 *   - rename/copy 在 -z 下是两条: 先是 `R  <新路径>`, 紧接着一个裸 `<旧路径>`。
 *     (状态 token 带的是新路径, 旧路径是下一个裸 token。)
 *   - 未跟踪: `?? <path>`。
 *
 * @returns {Array<{xy: string, path: string, from?: string}>}
 */
export function parseStatusZ(text) {
  const tokens = String(text).split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '') continue;
    const m = /^([ MADRCU?!])([ MADRCU?!]) (.*)$/.exec(token);
    if (m === null) {
      // 孤立裸 token: 通常是上个 rename 的旧路径已在上一轮被消费;
      // 若出现说明输入异常, 保守地作为未跟踪条目处理。
      entries.push({ xy: '??', path: token });
      continue;
    }
    const xy = m[1] + m[2];
    const entry = { xy, path: m[3] };
    if (xy.indexOf('R') !== -1 || xy.indexOf('C') !== -1) {
      const next = tokens[i + 1];
      if (next !== undefined && next !== '') {
        entry.from = next;
        i++;
      }
    }
    entries.push(entry);
  }
  return entries;
}

/** XY 状态码 → 单字母徽标(R > C > A > D > M > U)。 */
export function statusBadge(xy) {
  const x = xy[0];
  const y = xy[1];
  if (x === 'R' || y === 'R') return 'R';
  if (x === 'C' || y === 'C') return 'C';
  if (x === 'A' || y === 'A') return 'A';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'M' || y === 'M') return 'M';
  return 'U';
}

/**
 * 把 readdir 条目按三区分组, 并返回当前树(visible/hidden/ignored)
 * 在该目录应该展示的列表。
 *
 * 条目已由调用方标注: `dot`(以 `.` 开头)与 `ignored`(git 忽略)。
 * `.git` 由调用方在 readdir 阶段剔除。
 *
 * @param entries [{name, type, dot, ignored}]
 * @param mode 'visible' | 'hidden' | 'ignored'
 * @param reveal boolean — 进入"归属区内部"时(true)展示全部子项
 *   (hidden 模式展开 dot 目录、ignored 模式展开被忽略目录),
 *   否则只展示本区成员(hidden 只展示 dot 项, ignored 只展示忽略项)。
 * @returns {{list: Array, visible: Array, hidden: Array, ignored: Array}}
 */
export function partitionChildren(entries, mode, reveal) {
  const visible = [];
  const hidden = [];
  const ignored = [];
  for (const e of entries) {
    if (e.ignored) ignored.push(e);
    else if (e.dot) hidden.push(e);
    else visible.push(e);
  }
  const sorted = (arr) =>
    arr.slice().sort((a, b) => {
      const ad = a.type === 'dir' ? 0 : 1;
      const bd = b.type === 'dir' ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return compareZh(a.name, b.name);
    });
  let list;
  if (mode === 'visible') list = visible;
  else if (mode === 'hidden') list = reveal ? entries : hidden;
  else if (mode === 'ignored') list = reveal ? entries : ignored;
  else list = [];
  return { list: sorted(list), visible, hidden, ignored };
}

/**
 * 按变更条目构造"单文件相对 HEAD 的 diff"git 参数。
 * rename/copy 需要同时给新、旧两个路径, 否则只给新路径时 git 会当 new file。
 */
export function diffArgs(entry, badge) {
  const base = ['-c', 'core.quotepath=false', 'diff', 'HEAD'];
  if (badge === 'R' || badge === 'C') {
    return [...base, '-M', '--', entry.path, ...(entry.from !== undefined ? [entry.from] : [])];
  }
  return [...base, '--', entry.path];
}
