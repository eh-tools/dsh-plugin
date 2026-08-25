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
 * 条目已由调用方标注: `dot`(以 `.` 开头)、`ignored`(git 忽略)与
 * `subIgnored`(自身未忽略但子树含忽略项的桥接目录, 仅影响忽略区列表,
 * 不改变三区分桶 —— 桥接目录在可见区仍是普通成员)。
 * `.git` 由调用方在 readdir 阶段剔除。
 *
 * @param entries [{name, type, dot, ignored, subIgnored?}]
 * @param mode 'visible' | 'hidden' | 'ignored'
 * @param reveal boolean — 进入"归属区内部"时(true)展示全部子项
 *   (hidden 模式展开 dot 目录、ignored 模式展开被忽略目录),
 *   否则只展示本区成员(hidden 只展示 dot 项,
 *   ignored 展示忽略项 + 桥接目录 —— 否则深层忽略路径如 src/__pycache__
 *   因父级 src 未被忽略而永远无法从忽略区走到)。
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
  else if (mode === 'ignored') {
    // reveal=true 是"已进入真正被忽略目录内部", 全量展示;
    // 非 reveal 时含桥接目录, 但 dot 桥接除外(隐藏区已可达, 不重复列出)。
    list = reveal ? entries : entries.filter((e) => e.ignored || (e.subIgnored && !e.dot));
  } else list = [];
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

// ---- 文件搜索(name search) ----

/**
 * 命中项的三区归属: 被忽略 > 任一路径段以点开头(隐藏) > 其余(可见)。
 * 与树面板的逐条目分类口径一致(partitionChildren 的单条目视角)。
 */
export function searchZone(rel, ignored) {
  if (ignored) return 'ignored';
  const segs = String(rel).split('/');
  for (const seg of segs) {
    if (isDotName(seg)) return 'hidden';
  }
  return 'visible';
}

/**
 * 从文件路径列表推导其全部祖先目录(去重、按名称排序)。
 * git ls-files 只列文件; 目录命中项由此派生, 供搜索结果点目录 → 树内 reveal。
 * 搜索命中项统一为 {rel, type, zone, nameHit} 形状(matchEntries 产出)。
 */
export function dirsFromPaths(paths) {
  const seen = new Set();
  for (const p of paths) {
    const segs = String(p).split('/');
    for (let i = 1; i < segs.length; i++) {
      seen.add(segs.slice(0, i).join('/'));
    }
  }
  return [...seen].sort(compareZh);
}

/** 大小写不敏感子串匹配 + 排序: 名字命中 > 仅路径命中 → 短路径优先 → 名称。 */
export function matchEntries(entries, query) {
  const q = String(query).trim().toLowerCase();
  if (q === '') return [];
  const hits = [];
  for (const e of entries) {
    const rel = String(e.rel);
    const lower = rel.toLowerCase();
    if (!lower.includes(q)) continue;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    hits.push({ ...e, nameHit: base.toLowerCase().includes(q) });
  }
  return hits.sort((a, b) => {
    if (a.nameHit !== b.nameHit) return a.nameHit ? -1 : 1;
    const dl = a.rel.length - b.rel.length;
    if (dl !== 0) return dl;
    return compareZh(a.rel, b.rel);
  });
}

// ---- 提交历史(commit history) ----

const LOG_FORMAT = '%H%x00%h%x00%an%x00%at%x00%s';

/**
 * ref 是否可安全作为 git argv 参数(无 shell, 主要防选项注入与区间语法):
 * 拒绝 `-` 开头、`..` 区间、空白/NUL、reflog `@{`。
 */
export function safeRef(ref) {
  if (typeof ref !== 'string') return false;
  const r = ref.trim();
  if (r === '' || r.length > 200) return false;
  if (r.startsWith('-') || r.includes('..') || r.includes('@{')) return false;
  if (/[\s\0]/.test(r)) return false;
  return true;
}

/** hash 是否为纯十六进制串(7~64 位), 供 git show 使用。 */
export function safeHash(hash) {
  return typeof hash === 'string' && /^[0-9a-fA-F]{7,64}$/.test(hash);
}

/**
 * git log argv: NUL 分隔字段(hash 全/短, 作者, unix 时间戳, subject)。
 * ref 为 null/非法时缺省 HEAD; skip 钳制 ≥0, limit 钳制 1..500。
 */
export function logArgs(ref, skip, limit) {
  const sk = Math.max(0, Math.floor(Number(skip) || 0));
  const lim = Math.min(500, Math.max(1, Math.floor(Number(limit) || 50)));
  const args = ['-c', 'core.quotepath=false', 'log', '--format=' + LOG_FORMAT];
  args.push('--skip=' + String(sk), '-n', String(lim));
  if (safeRef(ref)) args.push(ref.trim());
  return args;
}

/** 解析 logArgs 的输出; 字段不足或时间非数字的行跳过。 */
export function parseLogOut(text) {
  const commits = [];
  for (const line of String(text).split('\n')) {
    if (line === '') continue;
    const f = line.split('\0');
    if (f.length < 5 || f[0] === '') continue;
    const at = Number(f[3]);
    if (!Number.isFinite(at)) continue;
    commits.push({ hash: f[0], short: f[1], author: f[2], at: at, subject: f[4] });
  }
  return commits;
}

/**
 * 解析 `diff-tree --numstat -z` 输出(实测钉死, 见 README「实现事实」):
 *   首个 token 是提交 hash; 普通条目 = "A\tD\t<path>\0";
 *   rename/copy 条目 = "A\tD\t\0<from>\0<to>\0"(计数 token 内路径位为空,
 *   紧跟旧、新两个裸路径 token)。二进制行 A/D 为 "-" → 归一为 null。
 */
export function parseNumStatZ(text) {
  const stats = [];
  const num = (v) => (/^\d+$/.test(v) ? Number(v) : null);
  const tokens = String(text).split('\0');
  for (let i = 1; i < tokens.length;) {
    const t = tokens[i];
    if (t === undefined || t === '') {
      i++;
      continue;
    }
    const i1 = t.indexOf('\t');
    if (i1 < 0) {
      i++;
      continue;
    }
    const i2 = t.indexOf('\t', i1 + 1);
    if (i2 < 0) {
      i++;
      continue;
    }
    const adds = num(t.slice(0, i1));
    const dels = num(t.slice(i1 + 1, i2));
    const inlinePath = t.slice(i2 + 1);
    if (inlinePath !== '') {
      stats.push({ adds: adds, dels: dels, path: inlinePath });
      i++;
      continue;
    }
    // rename/copy: 计数 token 路径位为空, 后跟 旧路径、新路径 两个裸 token
    const from = tokens[i + 1];
    const to = tokens[i + 2];
    if (typeof to === 'string' && to !== '') {
      stats.push({ adds: adds, dels: dels, path: to, from: from });
      i += 3;
    } else {
      i++;
    }
  }
  return stats;
}

/** 由 `rev-list --parents -n1 <hash>` 输出计父提交数(首个 token 是自身)。 */
export function parentsFromRevList(text) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.length - 1;
}
