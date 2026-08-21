/* ------------------------------------------------------------------ *
 * src/boot.js — 启动编排（initBoot）
 *   只做主题 token 叠加 + 主题标记；鲸鱼由 whale-overlay 的
 *   shell.overlay 组件在挂载时自启动。由 build.mjs 拼接进工厂闭包。
 * ------------------------------------------------------------------ */
function initBoot(shared) {
  function boot() {
    if (!document.body) { document.addEventListener("DOMContentLoaded", boot, { once: true }); return; }
    try { shared.refs.applyThemeClass(); } catch (e) {}
    // ?dshtest=1 或 #dshtest 时显示诊断面板（whaleGL / progs / 主题 / 画布），便于确认 WebGL 状态
    var dbg = false;
    try {
      var url = location.href || "";
      dbg = url.indexOf("dshtest") !== -1;
    } catch (e) {}
    if (dbg) {
      try { if (shared.refs.startDiagPanel) shared.refs.startDiagPanel(); } catch (e) {}
    }
  }

  shared.refs.boot = boot;
}
