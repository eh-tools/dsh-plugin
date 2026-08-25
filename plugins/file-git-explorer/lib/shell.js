/**
 * dsh-file-git-explorer — shell 行纯函数层(可单测, 不依赖 ctx / 进程)
 *
 * 这里只放"给定输入就能算出结果"的解析与窗口数学:
 *   - resolveShellArgv: 平台 + $SHELL → 解释器 argv 前缀(可执行性由注入的 canExec 判定)
 *   - pushHistory:      历史追加(相邻去重 + 上限截断)
 *   - appendTail:       尾部缓冲追加(保尾弃头, 返回丢弃字符数供绝对位基准移位)
 *   - sliceSince:       按客户端持有的绝对字符位切出增量(越界标记 lossy)
 *   - validShellCommand: 命令串校验(非空白 + 长度上限), 返回裁剪后的串或 null
 *
 * 字符位口径: host 半为每条任务维护「尾部字符串缓冲 + 缓冲首字符的绝对位(base)」,
 * 客户端只持有自己读到的绝对位(from); 绝对位不因缓冲修剪而失效 —— 修剪只推进 base。
 */

/** 历史条数上限(localStorage 搭车 fge-cache-v1, 防膨胀)。 */
export const SHELL_HISTORY_CAP = 100;

/** 每流尾部缓冲的字符上限(stdout / stderr 各自独立)。 */
export const SHELL_STREAM_CAP_CHARS = 16 * 1024;

/** 命令串长度上限(约束 jobs 列表里的 label 体积)。 */
export const COMMAND_MAX_LEN = 4000;

/**
 * 解析用户默认 shell → argv 前缀([解释器, 参数旗标])。
 *
 * - win32: PATH 探测 pwsh, 失败回退 powershell; 旗标 -Command。
 * - POSIX: 取 $SHELL(DSH 从用户终端启动时即登录 shell); 空缺或 canExec
 *   判定不可执行时回退 /bin/sh; 旗标 -c(bash/zsh/fish/sh 通吃)。
 *
 * @param {string} platform process.platform
 * @param {string|undefined} envShell 进程环境 $SHELL
 * @param {(nameOrPath: string) => boolean} canExec 可执行判定(注入以便单测)
 * @returns {{argv: string[], shell: string}}
 */
export function resolveShellArgv(platform, envShell, canExec) {
  if (platform === 'win32') {
    if (canExec('pwsh')) return { argv: ['pwsh', '-Command'], shell: 'pwsh' };
    return { argv: ['powershell', '-Command'], shell: 'powershell' };
  }
  let sh = typeof envShell === 'string' ? envShell.trim() : '';
  if (sh === '' || !canExec(sh)) sh = '/bin/sh';
  return { argv: [sh, '-c'], shell: sh };
}

/**
 * 历史追加: 与末条相同则原样返回(相邻去重); 超上限从头部截断。
 * 纯函数, 返回新数组, 不改入参。
 *
 * ⚠ client 半的 pushHist(lib/client.js ShellBar)是同算法的手写副本 ——
 * bundle 无法 import host ESM; 改动此处语义时必须同步 client, 本函数的
 * 单测(tests/shell.test.mjs)即两份共享的可执行规约。
 */
export function pushHistory(list, cmd) {
  const prev = Array.isArray(list) ? list : [];
  const entry = String(cmd);
  if (prev.length > 0 && prev[prev.length - 1] === entry) return prev;
  const next = prev.concat([entry]);
  return next.length > SHELL_HISTORY_CAP ? next.slice(next.length - SHELL_HISTORY_CAP) : next;
}

/**
 * 尾部缓冲追加 delta, 超过 cap 字符时从头整段丢弃(保尾弃头)。
 * 返回新 buffer 与本次丢弃的字符数 —— 调用方把它累加进 base(缓冲首字符绝对位)。
 */
export function appendTail(buffer, delta, cap) {
  let buf = String(buffer ?? '') + String(delta ?? '');
  let dropped = 0;
  if (buf.length > cap) {
    dropped = buf.length - cap;
    buf = buf.slice(dropped);
  }
  return { buffer: buf, dropped };
}

/**
 * 按客户端持有的绝对字符位 from 切出增量。
 *   - from ≥ base+len: 没有新内容, text 空、next 维持 from。
 *   - from < base:     客户端要的位置已被修剪掉(lossy), 只能给现存头部起的内容。
 * 返回 {text, next(缓冲末端绝对位), base, lossy}。
 */
export function sliceSince(buffer, base, from) {
  const buf = String(buffer ?? '');
  const startPos = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
  const end = base + buf.length;
  if (startPos >= end) return { text: '', next: startPos, base, lossy: false };
  const idx = Math.max(0, startPos - base);
  return { text: buf.slice(idx), next: end, base, lossy: startPos < base };
}

/**
 * 命令串校验: 非空白、≤ 上限。合法返回 trim 后的串, 否则 null。
 */
export function validShellCommand(cmd) {
  if (typeof cmd !== 'string') return null;
  const trimmed = cmd.trim();
  if (trimmed === '' || trimmed.length > COMMAND_MAX_LEN) return null;
  return trimmed;
}
