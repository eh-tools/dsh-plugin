/**
 * dsh-file-git-explorer — 终端纯函数层(可单测; 不依赖 ctx / 进程 / node-pty)
 *
 * 这里只放"给定输入就能算出结果"的解析、窗口数学与协议编解码:
 *   - resolveShellExecutable: 平台 + 环境 → shell 的**绝对路径**
 *   - clampSize:              cols/rows 钳制到 pty 能接受的区间
 *   - RingBuffer:             字节回放缓冲(重开抽屉时补发历史)
 *   - encodeControl/decodeControl: WebSocket 文本帧的控制协议
 *   - TerminalPool:           每工作区一个终端 + 全局 LRU 上限
 *
 * ============================ WebSocket 帧协议 ============================
 * 与 xterm 的接缝刻意做窄: 数据走二进制帧, 控制走文本帧。
 *   client → host
 *     · 二进制帧          = 原样写入 PTY 的 stdin 字节(不解析、不转义)
 *     · 文本帧 `{t:'resize', cols, rows}` = 同步 PTY 尺寸
 *     · 文本帧 `{t:'ping'}`               = 保活
 *     · 文本帧 `{t:'kill'}`               = 终止整棵终端进程树
 *   host → client
 *     · 二进制帧      = PTY stdout 原样字节(交由 xterm 解释 ANSI)
 *     · 文本帧 `{t:'ready', id, shell, cols, rows, replay}`
 *     · 文本帧 `{t:'exit', code, signal}`
 *     · 文本帧 `{t:'error', error}`
 * 二进制帧不经过 JSON —— 这样 vim / htop 的全屏重绘与任意字节序列都不会被
 * 编码层破坏; 控制帧用 JSON 便于人工核对与扩展。
 */

import { win32 as pathWin32, posix as pathPosix, isAbsolute } from 'node:path';

/** 回放缓冲字节上限(重开抽屉时补发的历史)。 */
export const REPLAY_CAP_BYTES = 256 * 1024;

/** 全局同时存活的工作区终端上限(超出按 LRU 淘汰)。 */
export const TERMINAL_POOL_CAP = 16;

/** cols/rows 钳制区间(PTY 不接受 0 或负数)。 */
export const MIN_COLS = 2;
export const MAX_COLS = 1000;
export const MIN_ROWS = 1;
export const MAX_ROWS = 500;

/** 终端默认尺寸(抽屉首次打开、客户端尚未测量时)。 */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/** 控制帧类型。 */
export const CTRL_READY = 'ready';
export const CTRL_EXIT = 'exit';
export const CTRL_ERROR = 'error';
export const CTRL_RESIZE = 'resize';
export const CTRL_PING = 'ping';
export const CTRL_KILL = 'kill';

/**
 * 解析用户默认 shell → **绝对路径**。
 *
 * ⚠ node-pty 的 Windows 原生层(ConPTY)不解析裸名: 直接传 'powershell' 会
 * 启动失败。所以这里一律产出绝对路径 —— 先按偏好扫 PATH, 再退到已知安装位置,
 * 最后退到 ComSpec。
 *
 * @param {string} platform process.platform
 * @param {Record<string,string|undefined>} env 进程环境
 * @param {(p: string) => boolean} isFile 文件存在判定(注入以便单测)
 * @returns {string|null} 绝对路径; 全都不存在时 null(调用方报错而非瞎猜)
 */
export function resolveShellExecutable(platform, env, isFile) {
  const e = env ?? {};

  if (platform === 'win32') {
    const p = pathWin32;
    const sysRoot = e.SystemRoot || e.windir || 'C:\\Windows';
    const programFiles = e.ProgramFiles || 'C:\\Program Files';
    const localAppData = typeof e.LOCALAPPDATA === 'string' ? e.LOCALAPPDATA : '';
    const comSpec = typeof e.ComSpec === 'string' && e.ComSpec !== '' ? e.ComSpec : null;

    // 偏好序: PowerShell 7 → 系统 Windows PowerShell → cmd
    const names = ['pwsh.exe', 'powershell.exe', 'cmd.exe'];
    const dirs = String(e.PATH ?? e.Path ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d !== '');

    for (const name of names) {
      for (const dir of dirs) {
        const full = p.join(dir, name);
        if (isFile(full)) return full;
      }
    }

    // PATH 不完整时(常见于从 IDE/服务启动)退回已知安装位置
    const known = [
      p.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      localAppData === '' ? null : p.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
      p.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      p.join(sysRoot, 'System32', 'cmd.exe'),
      comSpec,
    ];
    for (const cand of known) {
      if (cand !== null && isFile(cand)) return cand;
    }
    return comSpec;
  }

  const p = pathPosix;
  // POSIX 侧 node-pty 走 execvp 能解析裸名, 但仍然统一产出绝对路径:
  // 一是与 Windows 同口径, 二是 $SHELL 常是裸名而 isFile 判定需要真路径。
  const envShell = typeof e.SHELL === 'string' ? e.SHELL.trim() : '';
  if (envShell !== '' && isAbsolute(envShell) && isFile(envShell)) return envShell;

  const candidates = ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/sh'];
  for (const cand of candidates) {
    if (isFile(cand)) return cand;
  }
  // 保底: /bin/sh 是 POSIX 保证存在的路径
  return p.join('/bin', 'sh');
}

/** cols/rows 钳制到 PTY 可接受区间; 非有限值回落到默认尺寸。 */
export function clampSize(cols, rows) {
  const c = Math.floor(Number(cols));
  const r = Math.floor(Number(rows));
  const safeCols = Number.isFinite(c) ? Math.min(MAX_COLS, Math.max(MIN_COLS, c)) : DEFAULT_COLS;
  const safeRows = Number.isFinite(r) ? Math.min(MAX_ROWS, Math.max(MIN_ROWS, r)) : DEFAULT_ROWS;
  return { cols: safeCols, rows: safeRows };
}

/** 编码一条控制帧(文本帧)。 */
export function encodeControl(message) {
  return JSON.stringify(message);
}

/**
 * 解码一条控制帧; 非法 JSON / 非对象 / 缺 `t` 都返回 null(调用方忽略该帧)。
 * 刻意不抛错 —— WebSocket 上任何脏数据都不该打断终端会话。
 */
export function decodeControl(text) {
  try {
    const value = JSON.parse(String(text));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.t !== 'string' || value.t === '') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * 字节回放缓冲: 只保尾部 cap 字节, 但对外用**绝对字节位**寻址,
 * 于是客户端记住自己读到的位置即可增量补发, 不因修剪而错位。
 */
export class RingBuffer {
  /** @param {number} cap 保留的最大字节数 */
  constructor(cap = REPLAY_CAP_BYTES) {
    this.cap = Math.max(1, Math.floor(cap));
    this.buffer = Buffer.alloc(0);
    /** 缓冲首字节的绝对位。 */
    this.base = 0;
  }

  /** 缓冲末端绝对位(= 已写入的总字节数)。 */
  get end() {
    return this.base + this.buffer.length;
  }

  /** 追加一段字节, 超出上限时从头部整段丢弃。返回本次丢弃的字节数。 */
  append(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? '');
    let merged = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);
    let dropped = 0;
    if (merged.length > this.cap) {
      dropped = merged.length - this.cap;
      merged = merged.subarray(dropped);
    }
    this.base += dropped;
    this.buffer = merged;
    return dropped;
  }

  /**
   * 取出 from 之后的增量。
   *   - from ≥ end: 没有新内容。
   *   - from < base: 要的位置已被修剪(lossy), 只给现存头部起的内容。
   */
  since(from) {
    const start = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
    const end = this.end;
    if (start >= end) return { bytes: Buffer.alloc(0), next: start, base: this.base, lossy: false };
    const index = Math.max(0, start - this.base);
    return {
      bytes: this.buffer.subarray(index),
      next: end,
      base: this.base,
      lossy: start < this.base,
    };
  }
}

/**
 * 每工作区一个终端, 全局 LRU 上限。
 *
 * 只管记账, 不碰 IO —— 淘汰时把条目交回调用方(由它去 kill PTY 并广播退出),
 * 所以本类是纯逻辑、可单测。
 */
export class TerminalPool {
  /** @param {number} cap 存活上限 */
  constructor(cap = TERMINAL_POOL_CAP) {
    this.cap = Math.max(1, Math.floor(cap));
    /** @type {Map<string, {key: string, value: unknown}>} 迭代序 = 最近使用序 */
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  /** 取条目并标记为最近使用。 */
  get(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** 只看不碰 LRU 顺序(用于状态查询)。 */
  peek(key) {
    return this.entries.get(key)?.value;
  }

  has(key) {
    return this.entries.has(key);
  }

  /**
   * 放入条目; 超出上限时按 LRU 淘汰并返回被淘汰的条目列表。
   * @returns {Array<{key: string, value: unknown}>}
   */
  put(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { key, value });
    const evicted = [];
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      const victim = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (victim !== undefined) evicted.push(victim);
    }
    return evicted;
  }

  /** 移除并返回条目(不存在返回 undefined)。 */
  delete(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    return entry.value;
  }

  /** 当前键列表(最近使用在前)。 */
  keys() {
    return [...this.entries.keys()].reverse();
  }
}
