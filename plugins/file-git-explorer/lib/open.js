/**
 * dsh-file-git-explorer — 「在系统资源管理器中打开」纯函数层(可单测, 不依赖 ctx / 进程)
 *
 * openTargetArgv 只做「平台 + 绝对路径 + 是否目录 → argv」的纯映射: 目标是否存在、
 * 是否在 root 之内, 由 host 半在调用前用 fs / 防穿越校验保证; 这里不碰进程。
 *
 * 口径(与需求一致):
 *   - 目录 → 打开目录自身(资源管理器窗口置前)
 *   - 文件 → 打开其所在目录; Windows / macOS 顺带选中该文件
 *
 * 注意: Windows 的 explorer.exe 即便成功也常返回退出码 1 —— 调用方不得以非零退出判失败。
 */

/**
 * 目标平台下打开「目录自身 / 文件所在目录」的 argv。
 *
 * @param {string} platform process.platform
 * @param {string} abs 目标绝对路径(目录或文件)
 * @param {boolean} isDir 目标是否为目录
 * @returns {string[]} 传给 subprocess.spawn 的 argv(首元素为可执行名)
 */
export function openTargetArgv(platform, abs, isDir) {
  if (platform === 'win32') {
    // 文件用 /select,<path> 打开所在目录并选中该文件(注意逗号后不能有空格)
    return isDir ? ['explorer', abs] : ['explorer', '/select,' + abs];
  }
  if (platform === 'darwin') {
    return isDir ? ['open', abs] : ['open', '-R', abs];
  }
  // linux / 其他 POSIX: xdg-open 没有「选中文件」口径, 文件退化为打开所在目录
  if (isDir) return ['xdg-open', abs];
  const i = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'));
  return ['xdg-open', i > 0 ? abs.slice(0, i) : abs];
}
