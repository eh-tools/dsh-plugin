/**
 * dsh-db-console — host half(静态双半插件)
 *
 * 职责: 为浏览器端「数据库」页签提供 PostgreSQL 连接与查询通道。
 *
 * 静态插件的 client→host 通信不走动态插件的私有 RPC, 而是注册回环 HTTP JSON
 * 路由(与 file-git-explorer 的 /fge/api 同款信任栅栏):
 *
 *   POST /dbc/api/config.get     { root? } → 该项目保存的连接(含明文 url, UI 打码)
 *   POST /dbc/api/config.save    { root?, url } → 保存(覆盖, 项目单例)
 *   POST /dbc/api/config.delete  { root? } → 删除并断开
 *   POST /dbc/api/test           { url } → 临时连接试连(不落盘不建池)
 *   POST /dbc/api/connect        { root? } → 用已存配置建池并 ping
 *   POST /dbc/api/disconnect     { root? } → 关池
 *   POST /dbc/api/schema         { root? } → information_schema 内省整树
 *   POST /dbc/api/query          { root?, sql } → 原样执行(不拦截), 行集截断返回
 *   POST /dbc/api/result.last    { root? } → 该项目最近一次执行结果(Host 内存)
 *
 * 隔离口径(CONTEXT.md § db-console): 隔离键 = 会话工作区向上找到的第一个
 * .git 所在目录(仓库根), 无仓库退化为 cwd 本身 —— 与 file-git-explorer 的
 * cwd 缓存同口径; 每个项目至多一条连接。
 *
 * 凭据口径(docs/adr/0001): 明文持久化在 $DSH_HOME/storages/db-console.json,
 * 原子写 + 权限收紧(文件 0600 / 目录尽量 0700); 不做任何加密与解锁流程。
 * 执行口径: SQL 原样下发 PG, host 不解析不拦截(statementKind 仅用于结果展示)。
 *
 * 挂载: 见 cordis.patch.yml —— 安装后随 profile boot 自动挂载。
 */

import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pgPkg from 'pg';
import {
  validateConnectionUrl,
  withApplicationName,
  maskConnectionUrl,
  describeConnectionUrl,
  groupSchemaTree,
  truncateRows,
  resolveScopeKey,
  safeFileName,
} from './pg.js';

const { Pool } = pgPkg;

export const name = 'dsh-db-console';

/** webServer 是唯一硬依赖。 */
export const inject = ['webServer'];

const BODY_CAP = 1024 * 1024; // 请求体上限 1 MiB(SQL 粘贴场景比 fge 放宽)
const ROUTE_PREFIX = '/dbc/api';
const ROW_CAP = 500; // 行集截断上限(host 与结果网格同值, 展示层约定)
const APP_NAME = 'dsh-db-console';

const SCHEMA_SQL =
  'select table_schema, table_name, column_name, data_type ' +
  'from information_schema.columns ' +
  "where table_schema not in ('pg_catalog', 'information_schema') " +
  "and table_schema not like 'pg\\_toast%' escape '\\' " +
  'order by table_schema, table_name, ordinal_position';

/** 用户可读的业务错误(区别于需要打日志的内部错误)。 */
class DbError extends Error {}

function dshHomeDir() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim());
  return path.join(os.homedir(), '.dsh');
}

function storeFilePath() {
  return path.join(dshHomeDir(), 'storages', 'db-console.json');
}

function emptyStore() {
  return { version: 1, projects: {} };
}

async function loadStore() {
  let text;
  try {
    text = await fsp.readFile(storeFilePath(), 'utf8');
  } catch {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.projects &&
      typeof parsed.projects === 'object'
    ) {
      return parsed;
    }
  } catch {
    /* 损坏即重置, 下次保存覆盖 */
  }
  return emptyStore();
}

/** 原子写(temp + fsync + rename), 并把权限收紧到 0600。 */
async function saveStore(store) {
  const file = storeFilePath();
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  try {
    await fsp.chmod(dir, 0o700);
  } catch {
    /* 尽力而为 */
  }
  const tmp = path.join(dir, `.db-console.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(store, null, 2) + '\n';
  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(payload, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    /* 尽力而为 */
  }
}

export function apply(ctx) {
  const CWD = process.cwd();

  /** 连接池表: scopeKey → { pool, info }。每项目一个常驻小池(max 5)。 */
  const pools = new Map();
  /** 隔离键解析缓存: root 字符串 → Promise<scopeKey>(进程内记忆即可)。 */
  const scopeKeyCache = new Map();
  /** connect 去重: scopeKey → Promise */
  const connecting = new Map();
  /** 每项目最近一次执行结果: scopeKey → 展示结构。
   *  L1 = 进程内存(热路径), L2 = ~/.dsh/storages/db-console-results/ 落盘
   *  (重启 dsh / 刷新浏览器 / 切工作区都不丢)。写盘异步串行, 失败仅告警。 */
  const lastResults = new Map();
  /** 结果落盘串行化锁。 */
  let resultChain = Promise.resolve();

  function resultFilePath(key) {
    return path.join(dshHomeDir(), 'storages', 'db-console-results', safeFileName(key));
  }

  function persistLastResult(key, payload) {
    resultChain = resultChain.then(async () => {
      try {
        const file = resultFilePath(key);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp.' + process.pid;
        await fsp.writeFile(
          tmp,
          JSON.stringify({ key, savedAt: Date.now(), result: payload }),
          'utf8',
        );
        await fsp.rename(tmp, file);
      } catch (err) {
        console.error('db-console: persist last result failed', err && err.message);
      }
    });
    return resultChain;
  }

  async function readPersistedLastResult(key) {
    try {
      const raw = await fsp.readFile(resultFilePath(key), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && parsed.result ? parsed.result : null;
    } catch {
      return null;
    }
  }

  function dropPersistedLastResult(key) {
    return fsp.rm(resultFilePath(key), { force: true }).catch(() => {});
  }
  /** 配置存取串行化锁(防并发保存丢更新)。 */
  let storeChain = Promise.resolve();

  async function scopeKeyOf(body) {
    const raw = typeof body.root === 'string' ? body.root : '';
    let base;
    if (raw === '') base = CWD;
    else if (path.isAbsolute(raw)) base = path.normalize(raw);
    else throw new DbError('root 必须是绝对路径');
    const cached = scopeKeyCache.get(base);
    if (cached) return cached;
    const p = resolveScopeKey(base);
    scopeKeyCache.set(base, p);
    p.catch(() => scopeKeyCache.delete(base));
    return p;
  }

  function projectUrlSync(key) {
    // 同步读盘在 handler 里可接受(文件极小); 每次现读保证跨 handler 一致
    try {
      const parsed = JSON.parse(fsSync.readFileSync(storeFilePath(), 'utf8'));
      const rec = parsed && parsed.projects ? parsed.projects[key] : null;
      return rec && typeof rec.url === 'string' ? rec.url : null;
    } catch {
      return null;
    }
  }

  function friendlyPgError(err) {
    const code = err && err.code;
    const msg = err && err.message ? String(err.message) : '未知错误';
    if (code === 'ECONNREFUSED') return '连接被拒绝: 主机或端口不可达';
    if (code === 'ETIMEDOUT' || code === 'ENOTFOUND') return '无法解析或连接到主机';
    if (code === '28P01') return '认证失败: 用户名或密码错误';
    if (code === '3D000' || /database .* does not exist/i.test(msg)) return '数据库不存在';
    if (code === '28000') return '认证失败';
    if (code === '42501') return '权限不足';
    return msg.split('\n')[0].slice(0, 300);
  }

  async function probeInfo(pool, url) {
    let u = null;
    try {
      u = new URL(url);
    } catch {
      /* 已校验过, 理论不达 */
    }
    const res = await pool.query(
      'select current_database() as db, current_user as usr, version() as ver',
    );
    const row = res.rows[0] || {};
    return {
      database: row.db || (u ? decodeURIComponent(u.pathname.replace(/^\//, '')) : ''),
      user: row.usr || (u ? decodeURIComponent(u.username) : ''),
      host: u ? u.hostname : '',
      port: u && u.port ? Number(u.port) : 5432,
      serverVersion: typeof row.ver === 'string' ? row.ver.split(' ').slice(0, 2).join(' ') : '',
    };
  }

  /** 取该项目的常驻池; 未连接则用已存配置建立(带并发去重)。 */
  async function ensurePool(key) {
    const exist = pools.get(key);
    if (exist) return exist;
    const inflight = connecting.get(key);
    if (inflight) return inflight;
    const task = (async () => {
      const url = projectUrlSync(key);
      if (!url) throw new DbError('该项目尚未保存数据库连接');
      let validated;
      try {
        validated = validateConnectionUrl(url);
      } catch (err) {
        throw new DbError('已保存的链接串非法: ' + (err && err.message));
      }
      const pool = new Pool({
        connectionString: withApplicationName(validated, APP_NAME),
        max: 5,
        idleTimeoutMillis: 60_000,
        connectionTimeoutMillis: 10_000,
      });
      try {
        const info = await probeInfo(pool, validated);
        const entry = { pool, info };
        pools.set(key, entry);
        return entry;
      } catch (err) {
        await pool.end().catch(() => {});
        throw new DbError(friendlyPgError(err));
      }
    })();
    connecting.set(key, task);
    try {
      return await task;
    } finally {
      connecting.delete(key);
    }
  }

  async function requirePool(key) {
    const entry = await ensurePool(key);
    return entry.pool;
  }

  // ---- handlers ----

  async function handleConfigGet(body) {
    const key = await scopeKeyOf(body);
    const url = projectUrlSync(key);
    const entry = pools.get(key) || null;
    return {
      ok: true,
      key,
      url,
      maskedUrl: url ? maskConnectionUrl(url) : null,
      summary: url ? describeConnectionUrl(url) : null,
      connected: !!entry,
      db: entry ? entry.info : null,
    };
  }

  async function handleConfigSave(body) {
    const key = await scopeKeyOf(body);
    let validated;
    try {
      validated = validateConnectionUrl(typeof body.url === 'string' ? body.url : '');
    } catch (err) {
      throw new DbError(err && err.message ? err.message : '链接串非法');
    }
    storeChain = storeChain.then(async () => {
      const store = await loadStore();
      store.projects[key] = { url: validated, savedAt: Date.now() };
      await saveStore(store);
    });
    await storeChain;
    return {
      ok: true,
      key,
      maskedUrl: maskConnectionUrl(validated),
      summary: describeConnectionUrl(validated),
    };
  }

  async function handleConfigDelete(body) {
    const key = await scopeKeyOf(body);
    storeChain = storeChain.then(async () => {
      const store = await loadStore();
      if (store.projects && key in store.projects) {
        delete store.projects[key];
        await saveStore(store);
      }
    });
    await storeChain;
    const entry = pools.get(key);
    if (entry) {
      pools.delete(key);
      await entry.pool.end().catch(() => {});
    }
    lastResults.delete(key); // 删配置即清最近结果
    dropPersistedLastResult(key);
    return { ok: true };
  }

  async function handleTest(body) {
    let validated;
    try {
      validated = validateConnectionUrl(typeof body.url === 'string' ? body.url : '');
    } catch (err) {
      throw new DbError(err && err.message ? err.message : '链接串非法');
    }
    const pool = new Pool({
      connectionString: withApplicationName(validated, APP_NAME),
      max: 1,
      connectionTimeoutMillis: 8_000,
    });
    try {
      const info = await probeInfo(pool, validated);
      return { ok: true, db: info };
    } catch (err) {
      throw new DbError(friendlyPgError(err));
    } finally {
      await pool.end().catch(() => {});
    }
  }

  async function handleConnect(body) {
    const key = await scopeKeyOf(body);
    const entry = await ensurePool(key);
    return { ok: true, db: entry.info };
  }

  async function handleDisconnect(body) {
    const key = await scopeKeyOf(body);
    const entry = pools.get(key);
    if (entry) {
      pools.delete(key);
      await entry.pool.end().catch(() => {});
    }
    return { ok: true };
  }

  async function handleSchema(body) {
    const key = await scopeKeyOf(body);
    const pool = await requirePool(key);
    try {
      const res = await pool.query(SCHEMA_SQL);
      return { ok: true, schemas: groupSchemaTree(res.rows || []), at: Date.now() };
    } catch (err) {
      throw new DbError(friendlyPgError(err));
    }
  }

  /** 单个 pg Result → 展示结构(kind rows/ok + 截断元数据)。 */
  function shapeResult(r) {
    if (r && Array.isArray(r.rows) && r.fields && r.fields.length > 0) {
      const t = truncateRows(r.rows, ROW_CAP);
      return {
        kind: 'rows',
        fields: r.fields.map((f) => f.name),
        rows: t.rows,
        total: t.total,
        truncated: t.truncated,
        command: r.command || '',
        rowCount: typeof r.rowCount === 'number' ? r.rowCount : null,
      };
    }
    return {
      kind: 'ok',
      command: (r && r.command) || 'OK',
      rowCount: r && typeof r.rowCount === 'number' ? r.rowCount : null,
    };
  }

  async function handleQuery(body) {
    const key = await scopeKeyOf(body);
    const sql = typeof body.sql === 'string' ? body.sql : '';
    if (sql.trim() === '') throw new DbError('SQL 为空');
    const pool = await requirePool(key);
    try {
      const raw = await pool.query(sql);
      // 多语句(simple query protocol)返回数组; 展示层逐段渲染
      let payload;
      if (Array.isArray(raw)) payload = { kind: 'multi', parts: raw.map(shapeResult) };
      else payload = { kind: 'single', ...shapeResult(raw) };
      lastResults.set(key, payload); // L1 内存
      persistLastResult(key, payload); // L2 落盘(重启 dsh 也不丢)
      return { ok: true, ...payload };
    } catch (err) {
      throw new DbError(friendlyPgError(err));
    }
  }

  /** 取该项目最近一次执行结果(无则 null)。 */
  async function handleResultLast(body) {
    const key = await scopeKeyOf(body);
    const cached = lastResults.get(key);
    if (cached) return { ok: true, result: cached };
    // L1 未命中(如 dsh 刚重启) → 读 L2 落盘并回填内存
    const persisted = await readPersistedLastResult(key);
    if (persisted) lastResults.set(key, persisted);
    return { ok: true, result: persisted };
  }

  // ---- 路由与信任栅栏(与 file-git-explorer 同款) ----

  const HANDLERS = {
    'config.get': handleConfigGet,
    'config.save': handleConfigSave,
    'config.delete': handleConfigDelete,
    test: handleTest,
    connect: handleConnect,
    disconnect: handleDisconnect,
    schema: handleSchema,
    query: handleQuery,
    'result.last': handleResultLast,
  };

  function isTrustedRequest(req) {
    const host = String((req.headers && req.headers.host) ?? '');
    const name = host.split(':')[0];
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
  }

  function writeJson(res, status, bodyObj) {
    const payload = JSON.stringify(bodyObj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(payload);
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let failed = false;
      req.on('data', (chunk) => {
        if (failed) return;
        total += chunk.length;
        if (total > BODY_CAP) {
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

  const unregister = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      if (req.headers['x-dsh-plugin'] !== '1') {
        writeJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const method = pathname.startsWith(ROUTE_PREFIX + '/')
        ? pathname.slice(ROUTE_PREFIX.length + 1)
        : undefined;
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      const handler = HANDLERS[method];
      if (handler === undefined) {
        writeJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        writeJson(res, 400, { ok: false, error: 'bad-json' });
        return;
      }
      try {
        writeJson(res, 200, await handler(body));
      } catch (err) {
        if (err instanceof DbError) {
          writeJson(res, 200, { ok: false, error: err.message });
          return;
        }
        console.error('db-console: api "' + method + '" failed', err);
        writeJson(res, 500, { ok: false, error: 'failed' });
      }
    },
  });

  // 可逆性: 插件停止/更新时关池、撤路由
  ctx.on('dispose', () => {
    if (typeof unregister === 'function') {
      try {
        unregister();
      } catch {
        /* 忽略 */
      }
    }
    for (const [, entry] of pools) {
      entry.pool.end().catch(() => {});
    }
    pools.clear();
    lastResults.clear();
  });
}
