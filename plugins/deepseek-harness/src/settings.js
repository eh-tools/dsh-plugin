/* ===================================================================== *
 * src/settings.js — 设置（initSettings）
 *   master 开关 `on` 默认开启；已无设置入口，恒开、不再注册任何 UI。
 *   由 scripts/build.mjs 拼接进 lib/client.js 的工厂闭包。
 * ===================================================================== */
function initSettings(shared) {
  var SETTINGS_KEY = "dsh-deepseek-harness.settings";

  /* 默认：主开关 on；极光/星座/玻璃/束光/Orbs 一律关闭(范围外) */
  var DEFAULTS = {
    on: true,
    whale: true,
    mouse: true,     // 鲸鱼鼠标跟随交互(官方行为)
    fps: 60,
    followMs: 120,
    lightFollow: 1,
    auroraScale: 1
  };

  function loadSettings() {
    var d = {};
    var k;
    for (k in DEFAULTS) d[k] = DEFAULTS[k];
    var parsed = null;
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch (e) {}
    if (parsed && typeof parsed === "object") {
      var allowed = { on:1, whale:1, mouse:1, fps:1, followMs:1, lightFollow:1, auroraScale:1 };
      for (k in parsed) if (Object.prototype.hasOwnProperty.call(parsed, k) && allowed[k]) d[k] = parsed[k];
    }
    return d;
  }
  shared.settings = loadSettings();
  var bgSettings = shared.settings;
  bgSettings.on = true; // 恒开（已去掉设置入口）
  bgSettings.orbs = false; // 范围外, 恒关
  bgSettings.aurora = false;
  bgSettings.beam = false;
  bgSettings.constellation = false;
  bgSettings.glass = false;

  // 订阅：设置变化时各子系统即时响应
  var settingsListeners = [];
  function notifySettings() { for (var i = 0; i < settingsListeners.length; i++) { try { settingsListeners[i](); } catch (e) {} } }
  function subscribeSettings(fn) { settingsListeners.push(fn); return function () { var i = settingsListeners.indexOf(fn); if (i >= 0) settingsListeners.splice(i, 1); }; }

  shared.refs.subscribeSettings = subscribeSettings;
}
