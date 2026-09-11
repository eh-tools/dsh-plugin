/**
 * dsh-doc-copy — host half(静态双半插件)
 *
 * 全部逻辑在 client 半: 本插件只往官方文档页签的 ⋯ 菜单里加一项, 并用官方已有的
 * Remote face(`remote.workspaceFiles.readAll`)读原文, 因此不需要自己的 HTTP 路由,
 * 也没有额外的信任面。
 *
 * 但按仓库的挂载契约, 双半包仍需一个真实的 host 行: 它让 `dsh plugin add` 经
 * `dsh.bundle.patch` 把本包挂进 `dsh.profile.bundles`, 也让
 * `dsh-client-modules` 在扫描 live loader 条目时发现本包的 client bundle。
 */

export const name = 'dsh-doc-copy';

export function apply() {
  // no-op: 全部逻辑在 client 半。
}
