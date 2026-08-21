/* ------------------------------------------------------------------ *
 * src/whale-overlay.js — 把粒子鲸鱼注册进 shell.overlay 槽位（initWhaleOverlay）
 *   shell.overlay 是 frame-wide 浮层层（z-index:20 在列之上、点击穿透），
 *   是官方背书、可检查、必然可见的安全表面——不再依赖 z-index:-1 背景。
 *   由 scripts/build.mjs 拼接进 lib/client.js 的工厂闭包。
 * ------------------------------------------------------------------ */
function initWhaleOverlay(shared) {
  var ctx = shared.ctx;
  if (!react) {
    shared.refs.setupOverlay = function () {};
    shared.refs.startDiagPanel = function () {};
    return;
  }
  var h = react.createElement;

  /** 全屏固定画布容器：接住鲸鱼层，位于最上层但 pointer-events:none */
  function WhaleShell(props) {
    var layerRef = react.useRef ? react.useRef(null) : null;
    var canvasRef = react.useRef ? react.useRef(null) : null;
    var onState = react.useState(shared.settings.on !== false);
    var on = onState[0];
    var setOn = onState[1];

    react.useEffect(function () {
      if (layerRef && canvasRef) {
        shared.dom.whaleLayer = layerRef.current;
        shared.dom.whaleCanvas = canvasRef.current;
        if (shared.refs.updateWhaleDisplay) shared.refs.updateWhaleDisplay(layerRef.current);
        var noWhale = (typeof location !== "undefined") && location.search.indexOf("nowhale") !== -1;
        if (!noWhale) {
          try { shared.refs.startWhale(canvasRef.current); } catch (e) {}
        }
      }
      return function () {
        shared.dom.whaleLayer = null;
        shared.dom.whaleCanvas = null;
      };
    }, []);

    react.useEffect(function () {
      return shared.refs.subscribeSettings(function () {
        setOn(shared.settings.on !== false);
        if (shared.refs.updateWhaleDisplay) shared.refs.updateWhaleDisplay(layerRef && layerRef.current);
      });
    }, []);

    return h("div", {
      ref: layerRef,
      className: "dsh-deepseek-whale",
      "aria-hidden": "true",
      style: { position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
        display: (on ? "flex" : "none"), alignItems: "center", justifyContent: "center",
        pointerEvents: "none", zIndex: 0, overflow: "hidden" }
    },
      h("canvas", {
        ref: canvasRef,
        className: "dsh-deepseek-whale-canvas",
        style: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", display: "block" }
      }));
  }

  /** 诊断（?dshtest=1 时显示，实时刷新，供排查 WebGL / 主题 / 画布状态；平时不显示） */
  function startDiagPanel() {
    try {
      var panel = document.createElement("pre");
      panel.id = "dsh-deepseek-diag";
      panel.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483000;background:#fff;color:#000;font:11px/1.5 monospace;padding:10px 12px;max-width:600px;white-space:pre-wrap;";
      document.body.appendChild(panel);
      var d = shared.dom.diag;
      function themeInfo() {
        try {
          if (shared.theme && shared.theme.getTheme) {
            var t = shared.theme.getTheme();
            return (t && (t.id || t.colorScheme)) || "?";
          }
        } catch (e) {}
        return "?";
      }
      function bodyBg() {
        try { return getComputedStyle(document.body).backgroundColor; } catch (e) {}
        return "?";
      }
      function upd() {
        var layer = shared.dom.whaleLayer;
        var cv = shared.dom.whaleCanvas;
        var info = "dsh-deepseek-harness\n";
        info += "theme=" + themeInfo() + " bodyBg=" + bodyBg() + "\n";
        info += "layer=" + (layer ? "mounted" : "none") + " canvas=" + (cv ? (cv.width + "x" + cv.height) : "none") + "\n";
        info += "whaleGL=" + d.whaleGL + " progs=[" + d.whaleProgs + "]\n";
        info += "state=" + (cv && cv.dataset ? (cv.dataset.state || "-") : "-") + "\n";
        info += "count=" + (cv && cv.dataset ? (cv.dataset.count || "-") : "-") + " on=" + shared.settings.on;
        panel.textContent = info;
      }
      upd();
      var iv = setInterval(upd, 400);
      try {
        var mo = new MutationObserver(function () {
          if (!document.body.contains(panel)) { clearInterval(iv); mo.disconnect(); }
        });
        mo.observe(document.body, { childList: true });
      } catch (e) {}
    } catch (e) {}
  }

  // 注册进 shell.overlay
  function setupOverlay(ctx) {
    try {
      var slots = ctx && ctx.get ? ctx.get("slots") : null;
      if (!slots) return;
      slots.inject("shell.overlay", function () {
        return slots.register({ name: "shell.overlay", id: "deepseek-harness-whale", order: 0 }, WhaleShell);
      });
    } catch (e) {}
  }

  shared.refs.setupOverlay = setupOverlay;
  shared.refs.startDiagPanel = startDiagPanel;
}
