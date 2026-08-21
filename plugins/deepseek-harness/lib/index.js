/**
 * dsh-deepseek-harness — host half(静态双半插件)
 *
 * 本插件的全部工作都在浏览器端 client 半(lib/client.js):
 *   - DeepSeek 主题 override 层(theme.overrideTokens)
 *   - "设置 → 通用" 的开关行
 *   - 全屏底层粒子鲸鱼
 *
 * 开关的持久化用浏览器 localStorage(跨刷新 / 跨 DSH 进程重启生效),
 * 因此 host 半无需注册任何设置命名空间 —— 避免静态 import @deepseek-ai/*
 * (workspace link: 插件在 Node 解析时无法命中 profile 的模块回退)。
 *
 * host 半只保留一个空 apply, 让本包作为 loader 条目被扫描, 从而它的
 * `dsh.client` 声明(浏览器 bundle)进入 boot 图。
 *
 * 挂载: 见 cordis.patch.yml —— 安装后随 profile boot 自动挂载。
 */

export const name = 'dsh-deepseek-harness';

/** 纯客户端插件, host 半无任何服务依赖。 */
export const inject = [];

export function apply() {
  // client-only 插件: 浏览器端做全部工作, host 半无副作用。
}
