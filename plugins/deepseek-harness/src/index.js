/* ===================================================================== *
 * src/index.js — dsh-deepseek-harness 客户端入口 apply(ctx)
 *   在自有插件内集成官方 DeepSeek 引擎（粒子鲸鱼），并叠加我们自己的主题
 *   overrideTokens 色彩层。由 scripts/build.mjs 拼进工厂闭包。
 * ===================================================================== */
function apply(ctx) {
  "use strict";
  if (window.__dshDeepSeekHarness && window.__dshDeepSeekHarness._inited) return;
  if (typeof document === "undefined") return;
  if (typeof window.__dshDeepSeekHarness !== "object" || window.__dshDeepSeekHarness === null) window.__dshDeepSeekHarness = {};
  window.__dshDeepSeekHarness._inited = true;

  /* 跨模块共享状态：预建容器对象，各 initX 捕获引用后后续填充依然有效 */
  var shared = {
    media: {
      darkQuery: window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null,
      reducedMotion: !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches),
      coarse: !!(window.matchMedia && window.matchMedia("(hover: none), (pointer: coarse)").matches),
      isWindows: (navigator.userAgentData && navigator.userAgentData.platform === "Windows") ||
        navigator.userAgent.indexOf("Windows") !== -1
    },
    state: { dark: false },
    settings: {},
    theme: ctx.get ? ctx.get("theme") : null,
    dom: {},
    refs: {},
    ctx: ctx
  };

  // 依赖顺序：theme → settings → dom → whale → whale-overlay → boot
  initTheme(shared);
  initSettings(shared);
  initDom(shared);
  initWhale(shared);
  initWhaleOverlay(shared);
  initBoot(shared);

  /* 主开关默认开启，且不再提供设置入口：鲸鱼恒开、主题沿用官方明暗/系统。 */
  if (shared.refs.subscribeSettings) {
    shared.refs.subscribeSettings(function () {
      if (shared.refs.updateWhaleDisplay) shared.refs.updateWhaleDisplay();
    });
  }

  if (shared.refs.setupOverlay) shared.refs.setupOverlay(ctx);
  if (shared.refs.boot) shared.refs.boot();
}
