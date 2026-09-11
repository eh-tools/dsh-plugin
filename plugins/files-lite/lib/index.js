/**
 * dsh-files-lite — host half(静态双半插件)
 *
 * 全部逻辑在 client 半: 本插件只是「接管官方文件树的另一个视图」, 不提供任何
 * host 侧能力 —— 目录列表直接复用官方已有的 Remote face
 * (`remote.workspaceFiles.list(sessionId, path, signal)`), 因此不需要自己的
 * HTTP 路由, 也不需要额外的信任栅栏。
 *
 * 但按仓库的挂载契约, 双半包仍需一个真实的 host 行: 它让 `dsh plugin add` 经
 * `dsh.bundle.patch` 把本包挂进 `dsh.profile.bundles`, 也让
 * `dsh-client-modules` 在扫描 live loader 条目时发现本包的 client bundle。
 */

export const name = 'dsh-files-lite';

export function apply() {
  // no-op: 全部逻辑在 client 半。
}
