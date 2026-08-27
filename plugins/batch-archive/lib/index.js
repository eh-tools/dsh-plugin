/**
 * dsh-batch-archive — host half(静态双半插件)
 *
 * 纯客户端 UI 插件: 批量归档面板完全在浏览器端实现——会话列表与归档状态读
 * 槽位标准 props(useSessions / useWorkspaces), 归档动作直接调客户端
 * workspaces 服务的 archiveSession(sessionId)。host 半无需任何逻辑, 仅维持
 * bundle 挂载行存在(client-modules 按 loader 条目发现 dsh.client 包)。
 */

export const name = 'dsh-batch-archive';

export function apply() {
  // no-op: 全部逻辑在 client 半。
}
