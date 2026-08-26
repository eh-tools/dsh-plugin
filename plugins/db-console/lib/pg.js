/**
 * dsh-db-console — 纯函数层(host 半与测试共用, 不依赖运行时)
 *
 * 职责: 连接串校验/打码、语句形态判别、schema 内省结果整树、行截断、
 * 仓库根解析(隔离键)。全部无副作用或仅注入 fs, 方便 node:test 直测。
 */

import path from 'node:path';

/** 允许的连接协议前缀(pg 驱动实际支持的写法)。 */
const PG_SCHEMES = ['postgres:', 'postgresql:'];

/**
 * 校验完整 PostgreSQL 链接串。
 * 返回规范化后的 URL 字符串; 非法抛 Error(消息面向用户, 不回显原文)。
 * 规则: 必须是 postgres:// 或 postgresql:// 且可被 WHATWG URL 解析、host 非空。
 * 库名允许缺省(pg 会用 user 名兜底), 但显式给出时不能为空段。
 */
export function validateConnectionUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('链接串为空');
  }
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('链接串不是合法的 URL');
  }
  if (!PG_SCHEMES.includes(u.protocol)) {
    throw new Error('只支持 postgres:// 或 postgresql:// 链接');
  }
  if (!u.hostname) {
    throw new Error('链接串缺少主机名');
  }
  if (u.pathname === '') {
    // 允许省略库名(pg 以用户名同名词兜底)
  } else if (u.pathname === '/') {
    // 显式给出空库名段(以 / 结尾)视为非法, 避免静默连到默认库
    throw new Error('链接串的数据库名为空');
  }
  return u.href;
}

/** 给链接串追加/覆盖 application_name 标识(幂等)。返回新串。 */
export function withApplicationName(raw, appName) {
  const u = new URL(raw);
  const params = u.searchParams;
  if (!params.get('application_name')) params.set('application_name', appName);
  // searchParams 写回 href 时会对值做编码, 与 pg-connection-string 的解析兼容
  return u.toString();
}

/** 打码: 密码段替换为 •••(无密码原样返回; 解析失败返回固定掩码)。 */
export function maskConnectionUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return 'postgres://•••';
  }
  if (!u.password) return u.href;
  const user = decodeURIComponent(u.username);
  u.username = '';
  u.password = '';
  // password setter 会把非 ASCII 百分号编码, 因此清空后手工拼回掩码
  return u.href.replace(/^([a-z][a-z0-9+.-]*:\/\/)/, `$1${user}:•••@`);
}

/** 从链接串取展示摘要: user@host:port/db。解析失败返回 null。 */
export function describeConnectionUrl(raw) {
  try {
    const u = new URL(String(raw));
    const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
    return `${u.username || '-'}@${u.hostname}${u.port ? ':' + u.port : ''}/${db || '-'}`;
  } catch {
    return null;
  }
}

/** 顶层动词扫描: 跳过括号体, 返回第一个深度为 0 的 SQL 动词(小写)或 null。 */
function firstTopLevelVerb(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth < 0) depth = 0;
      continue;
    }
    if (depth !== 0) continue;
    if (!/[a-zA-Z]/.test(ch)) continue;
    const m = text.slice(i).match(/^(select|insert|update|delete|merge|values|table)\b/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * 语句形态判别(仅供结果区展示, 不是安全边界):
 * 返回 'rows'(期望行集) | 'ok'(命令) 。取首个词干判断,
 * WITH…SELECT 归为 rows; WITH 主句为写归 ok。
 * EXPLAIN/SHOW/TABLE/VALUES 归 rows。
 */
export function statementKind(sql) {
  const head = String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  if (head === '') return 'ok';
  const m = head.match(/^[a-zA-Z]+/);
  const kw = m ? m[0].toLowerCase() : '';
  switch (kw) {
    case 'select':
    case 'show':
    case 'explain':
    case 'table':
    case 'values':
      return 'rows';
    case 'with': {
      // 括号深度扫描: 找 WITH 子句结束后第一个「顶层动词」—— CTE 体内的
      // SELECT 不算数, 只有深度归零后出现的第一支动词决定形态。
      const rest = head.slice(kw.length);
      const verb = firstTopLevelVerb(rest);
      if (verb === null) return 'rows';
      return /^(select|values|table)$/.test(verb) ? 'rows' : 'ok';
    }
    default:
      return 'ok';
  }
}

/** schema 内省行(qualified_name, table_name, table_schema, column_name, data_type)整树。 */
export function groupSchemaTree(rows) {
  const schemas = new Map();
  for (const r of rows || []) {
    const sName = r.table_schema || 'public';
    const tName = r.table_name;
    let s = schemas.get(sName);
    if (!s) {
      s = { name: sName, tables: [] };
      schemas.set(sName, s);
    }
    let t = s.tables.find((x) => x.name === tName);
    if (!t) {
      t = { name: tName, columns: [] };
      s.tables.push(t);
    }
    t.columns.push({ name: r.column_name || '', type: r.data_type || '' });
  }
  const out = [...schemas.values()];
  for (const s of out) s.tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.sort((a, b) => {
    // public 永远最上
    if (a.name === 'public') return -1;
    if (b.name === 'public') return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}

/** 行集截断: 返回 {rows, truncated, total}。cap 最小 1。 */
export function truncateRows(rows, cap) {
  const list = Array.isArray(rows) ? rows : [];
  const n = Math.max(1, cap | 0);
  if (list.length <= n) return { rows: list, truncated: false, total: list.length };
  return { rows: list.slice(0, n), truncated: true, total: list.length };
}

/**
 * 隔离键解析: 从会话工作区目录向上找含 .git 的目录(仓库根),
 * 找不到退化为 start 自身。fsLike 注入便于测试, 默认 node:fs/promises。
 * 返回 realpath 后的绝对路径。
 */
export async function resolveScopeKey(start, fsLike) {
  const fs = fsLike || (await import('node:fs/promises'));
  let dir = path.resolve(String(start || '.'));
  for (;;) {
    try {
      await fs.stat(path.join(dir, '.git'));
      return real(dir, fs);
    } catch {
      /* 未命中, 向上继续 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return real(path.resolve(start), fs); // 到根都没有 .git
    dir = parent;
  }
}

async function real(p, fs) {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/**
 * 最近结果落盘的文件名: 隔离键(绝对路径)整体 encodeURIComponent,
 * 保证斜杠等字符不逃逸出存储目录。
 */
export function safeFileName(key) {
  return encodeURIComponent(String(key)) + '.json';
}
