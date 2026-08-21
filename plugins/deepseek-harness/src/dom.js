/* ------------------------------------------------------------------ *
 * src/dom.js — DOM 骨架（initDom）
 *   鲸鱼画布由 whale-overlay.js 注册进 shell.overlay 承载；
 *   本模块只保留诊断对象；不触碰主题标记/body 透明（沿用官方明暗+系统）。
 *   由 scripts/build.mjs 拼接进 lib/client.js 的工厂闭包。
 * ------------------------------------------------------------------ */
function initDom(shared) {
  shared.dom.diag = { theme: "?", bodyBg: "?", htmlBg: "?", whaleGL: false, whaleProgs: "", canvasW: 0, canvasH: 0, mode: "", count: 0, err: "" };

  function applyThemeClass() {
    // 官方主题即页面主题，无需额外标记或透出背景（鲸鱼是 shell.overlay 浮层）。
  }

  shared.refs.applyThemeClass = applyThemeClass;
}
