/* ------------------------------------------------------------------ *
 * src/theme.js — 主题检测（initTheme）
 *   沿用官方明暗+系统，不做任何强制深色或 token 覆盖。
 *   由 scripts/build.mjs 拼接进 lib/client.js 的工厂闭包。
 * ------------------------------------------------------------------ */
function initTheme(shared) {
  var state = shared.state;

  function detectDark() {
    try {
      if (shared.media && shared.media.darkQuery) return !!shared.media.darkQuery.matches;
    } catch (e) {}
    return false;
  }

  state.dark = detectDark();
  shared.refs.detectDark = detectDark;
}
