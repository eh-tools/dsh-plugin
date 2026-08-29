/*!
 * dsh-deepseek-harness 客户端入口（自动生成）
 * 由 scripts/build.mjs 从 src/ 拼接生成——请勿直接修改本文件。
 */
window.__ModuleLoader__.load({
  id: "dsh-deepseek-harness",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // 设置页面板需要 React（平台 seed 模块）；拿不到就跳过设置 UI
    var react = null;
    try { react = require("react"); } catch (e) {}
    if (document.getElementById("dsh-deepseek-bg-css") === null) {
      var styleTag = document.createElement("style");
      styleTag.id = "dsh-deepseek-bg-css";
      styleTag.textContent = `
/*!
 * dsh-deepseek-harness.css
 * DeepSeek 官网风格背景复刻（粒子鲸鱼）—— DSH Web GUI。
 * 颜色与蒙版取自 DeepSeek 官方站点：页面底色 #0d1017、canvas 蒙版、入场动画。
 * 全主题统一深色：浅色/深色均使用 harness 深色主题。
 */

/* ---------- 鲸鱼层（注册在 shell.overlay 内，frame-wide 浮层） ---------- */
.dsh-deepseek-whale {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
}

.dsh-deepseek-whale-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: block;
}

/* 粒子鲸鱼淡入 */
@keyframes dsh-deepseek-enter {
  0% { opacity: 0; filter: blur(20px); }
  100% { opacity: 1; filter: blur(0); }
}

@media (prefers-reduced-motion: reduce) {
  .dsh-deepseek-whale { animation: none; }
}

`;
      document.head.appendChild(styleTag);
    }

/* ===================== whale-shaders.js ===================== */
/* ===================================================================== *
 * src/whale-shaders.js — 工厂级片段（无副作用：常量/工具函数）
 *   鲸鱼 SVG 纹理 / 默认参数 / GLSL 着色器 / 4x4 矩阵工具 / 像素采样，
 *   被 src/whale.js（initWhale）直接调用。
 * ===================================================================== */
  /* ------------------------------------------------------------------ *
   * 粒子化鲸鱼引擎（官方移植：HeroDigitileR3F → 原生 WebGL2）
   * 源码取自官网 harness 页懒加载 chunk 776（未进缓存，已从官网抓取）：
   *   - 粒子位置：官方算法从 hero-whale.svg 像素亮度采样（60x60，边缘保留）
   *   - 顶点/片元 shader：官方 GLSL 逐字移植（three.js 矩阵替换为原生 uniform）
   *   - 交互：鼠标扭曲粒子（radius/strength/decay/distort）、光线跟随鼠标
   *     （lightParams.followX）、入场组装动画、松散漂移、游泳波动
   *   - 参数：DIGITILE_LIGHT_DEFAULTS / DIGITILE_MOUSE_DEFAULTS 与官方一致
   * ------------------------------------------------------------------ */
  // 官方鲸鱼纹理（hero-whale.svg，抓自 https://www.deepseek.com/harness/images/hero-whale.svg）
  var WHALE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18" viewBox="0 0 24 18" fill="none"><path d="M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746V14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z" fill="#FFFFFF"/></svg>';
  var WHALE_SRC = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(WHALE_SVG);
  // 官方参数（chunk 776 源码常量，fish 变体，提升基础亮度与光照对比度）
  var LIGHT_DEFAULTS = { x: 4.5, y: 5.5, z: 3, range: 14, shadeMin: 0.42, shadeMax: 1.35, followX: 1.05 };
  var MOUSE_DEFAULTS = { radius: 4.9, strength: 0.8, decay: 0.2, distort: 5 };
  var WAVE_DEFAULTS = { speed: 1.5, amount: 0.06 };

  function sampleWhalePixels(img) {
    var T = 60;
    var c = document.createElement("canvas");
    c.width = T; c.height = T;
    var a = c.getContext("2d");
    a.fillStyle = "#000"; a.fillRect(0, 0, T, T);
    var r = Math.min(T / img.width, T / img.height);
    var o = img.width * r, s = img.height * r;
    a.drawImage(img, (T - o) / 2, (T - s) / 2, o, s);
    var d = a.getImageData(0, 0, T, T);
    var lum = new Float32Array(T * T);
    for (var i = 0; i < T * T; i++) lum[i] = (0.299 * d.data[4*i] + 0.587 * d.data[4*i+1] + 0.114 * d.data[4*i+2]) / 255;
    var positions = [], scattered = [], opacities = [], edges = [];
    var half = T / 2;
    function isEdge(x, y) {
      for (var yy = -2; yy <= 2; yy++) for (var xx = -2; xx <= 2; xx++) {
        if (xx === 0 && yy === 0) continue;
        var nx = x + xx, ny = y + yy;
        if (nx < 0 || ny < 0 || nx >= T || ny >= T) continue;
        if (lum[ny * T + nx] > 0.2) return false;
      }
      return true;
    }
    for (var y = 0; y < T; y++) for (var x = 0; x < T; x++) {
      var l = lum[y * T + x];
      if (l > 0.2 && !isEdge(x, y)) {
        positions.push((x - half) * 0.18, (half - y) * 0.18, 0);
        opacities.push(l);
        var ec = 0;
        for (var yy = -1; yy <= 1; yy++) for (var xx = -1; xx <= 1; xx++) {
          if (xx === 0 && yy === 0) continue;
          var nx = x + xx, ny = y + yy;
          if (nx < 0 || ny < 0 || nx >= T || ny >= T || lum[ny * T + nx] <= 0.2) ec++;
        }
        edges.push(ec / 8);
        var phi = Math.random() * Math.PI * 2;
        var th = Math.acos(2 * Math.random() - 1);
        var rad = 3 * (0.4 + 0.6 * Math.random());
        scattered.push(Math.sin(th) * Math.cos(phi) * rad, Math.sin(th) * Math.sin(phi) * rad, Math.cos(th) * rad * 0.5);
      }
    }
    return {
      positions: new Float32Array(positions),
      scatteredPositions: new Float32Array(scattered),
      opacities: new Float32Array(opacities),
      edges: new Float32Array(edges),
      count: positions.length / 3
    };
  }

  // ---- 官方 shader（GLSL 逐字移植，three.js 内建矩阵换为原生 uniform） ----
  var WHALE_VS = "#version 300 es\n" +
    "precision highp float;\n" +
    "in vec3 position;\n" +
    "in float aOpacity;\n" +
    "in float aIndex;\n" +
    "in float aEdge;\n" +
    "in vec3 aScattered;\n" +
    "in vec3 aCenter;\n" +
    "in float aScale;\n" +
    "uniform float uTime;\n" +
    "uniform float uWaveSpeed;\n" +
    "uniform float uWaveAmount;\n" +
    "uniform vec2 uMouse;\n" +
    "uniform float uMouseRadius;\n" +
    "uniform float uMouseStrength;\n" +
    "uniform float uMouseDistort;\n" +
    "uniform float uAssembly;\n" +
    "uniform float uLoose;\n" +
    "uniform float uScatter;\n" +
    "uniform vec3 uLightPos;\n" +
    "uniform float uLightRange;\n" +
    "uniform float uShadeMin;\n" +
    "uniform float uShadeMax;\n" +
    "uniform mat4 uModel;\n" +
    "uniform mat4 uView;\n" +
    "uniform mat4 uProj;\n" +
    "uniform float uPointScale;\n" +
    "out float vOpacity;\n" +
    "out vec3 vWorldPos;\n" +
    "out float vAssembly;\n" +
    "out float vLight;\n" +
    "void main() {\n" +
    "  vOpacity = aOpacity;\n" +
    "  vAssembly = uAssembly;\n" +
    "  vec3 targetCenter = aCenter;\n" +
    "  vec3 localOffset = position * aScale;\n" +
    "  vec3 scatteredCenter = aScattered;\n" +
    "  float assembly = smoothstep(0.0, 1.0, uAssembly);\n" +
    "  vec3 center = mix(scatteredCenter, targetCenter, assembly);\n" +
    "  vec3 pos = center + localOffset;\n" +
    "  vWorldPos = center;\n" +
    "  float loose = uLoose * mix(0.25, 1.0, aEdge) * assembly;\n" +
    "  if (loose > 0.001) {\n" +
    "    vec3 jitter = vec3(\n" +
    "      fract(sin(aIndex * 12.9898) * 43758.5453) - 0.5,\n" +
    "      fract(sin(aIndex * 78.2330) * 12543.1230) - 0.5,\n" +
    "      fract(sin(aIndex * 39.4250) * 26711.7700) - 0.5\n" +
    "    );\n" +
    "    pos += jitter * 0.05 * loose;\n" +
    "    pos.x += sin(uTime * 0.50 + aIndex * 0.53) * 0.06 * loose;\n" +
    "    pos.y += cos(uTime * 0.42 + aIndex * 0.71) * 0.06 * loose;\n" +
    "    pos.z += sin(uTime * 0.36 + aIndex * 0.91) * 0.08 * loose;\n" +
    "    float tail = smoothstep(0.5, 4.5, targetCenter.x) * uLoose * assembly;\n" +
    "    pos.y += sin(uTime * 1.1 - targetCenter.x * 0.7) * 0.1 * tail;\n" +
    "    pos.z += cos(uTime * 0.9 - targetCenter.x * 0.55) * 0.06 * tail;\n" +
    "  }\n" +
    "  if (uScatter > 0.001) {\n" +
    "    float disperse = uScatter * mix(0.5, 1.0, aEdge);\n" +
    "    pos += (scatteredCenter - center) * disperse;\n" +
    "    pos.z += sin(uTime * 0.6 + aIndex * 0.3) * disperse * 0.6;\n" +
    "  }\n" +
    "  if (assembly > 0.95) {\n" +
    "    float effectStrength = (assembly - 0.95) * 20.0;\n" +
    "    float dist = length(center.xy);\n" +
    "    float waveFade = smoothstep(0.0, 3.0, dist);\n" +
    "    float wave = sin(dist * 3.0 - uTime * uWaveSpeed) * uWaveAmount * effectStrength * waveFade;\n" +
    "    pos.z += wave;\n" +
    "  }\n" +
    "  if (assembly > 0.8) {\n" +
    "    float mouseEffect = (assembly - 0.8) * 5.0;\n" +
    "    vec2 toMouse = center.xy - uMouse;\n" +
    "    float mouseDist = length(toMouse);\n" +
    "    if (mouseDist < uMouseRadius && mouseDist > 0.001) {\n" +
    "      float t = 1.0 - mouseDist / uMouseRadius;\n" +
    "      float force = t * t * t * mouseEffect * uMouseStrength;\n" +
    "      vec2 radialDir = toMouse / mouseDist;\n" +
    "      float noiseAngle = sin(aIndex * 0.37 + uTime * 0.5) * uMouseDistort;\n" +
    "      float ca = cos(noiseAngle);\n" +
    "      float sa = sin(noiseAngle);\n" +
    "      vec2 pushDir = vec2(radialDir.x * ca - radialDir.y * sa, radialDir.x * sa + radialDir.y * ca);\n" +
    "      pos.xy += pushDir * force * 2.0;\n" +
    "      pos.z += sin(aIndex * 1.7 + uTime) * force * 0.8;\n" +
    "    }\n" +
    "  }\n" +
    "  if (assembly < 0.9) {\n" +
    "    float scatter = smoothstep(0.9, 0.0, assembly);\n" +
    "    pos.x += sin(uTime * 0.5 + aIndex * 0.1) * 0.2 * scatter;\n" +
    "    pos.y += cos(uTime * 0.4 + aIndex * 0.07) * 0.2 * scatter;\n" +
    "    pos.z += sin(uTime * 0.3 + aIndex * 0.13) * 0.15 * scatter;\n" +
    "  }\n" +
    "  vec4 worldPos = uModel * vec4(pos, 1.0);\n" +
    "  float lightDist = distance(worldPos.xyz, uLightPos);\n" +
    "  float lit = clamp(1.0 - lightDist / uLightRange, 0.0, 1.0);\n" +
    "  vLight = mix(uShadeMin, uShadeMax, lit * lit);\n" +
    "  vec4 mvPosition = uView * uModel * vec4(pos, 1.0);\n" +
    "  gl_PointSize = max(1.0, uPointScale * aScale);\n" +
    "  gl_Position = uProj * mvPosition;\n" +
    "}\n";

  var WHALE_FS = "#version 300 es\n" +
    "precision highp float;\n" +
    "in float vOpacity;\n" +
    "in vec3 vWorldPos;\n" +
    "in float vAssembly;\n" +
    "in float vLight;\n" +
    "uniform float uTime;\n" +
    "uniform vec3 uColor;\n" +
    "out vec4 fragColor;\n" +
    "void main() {\n" +
    "  float dist = length(vWorldPos.xy);\n" +
    "  float glow = smoothstep(8.0, 0.0, dist) * 0.22 * vAssembly;\n" +
    "  float baseAlpha = mix(0.4, 0.58, vAssembly);\n" +
    "  float alpha = vOpacity * (baseAlpha + glow);\n" +
    "  float shimmer = sin(uTime * 1.5 + vWorldPos.x * 5.0 + vWorldPos.y * 3.0) * 0.08 + 0.92;\n" +
    "  alpha *= shimmer * clamp(vLight * 0.85 + 0.25, 0.3, 1.0);\n" +
    // 全局淡出一档: 粒子与光晕仍清晰可辨, 又不过度干扰对话区文本阅读
    "  alpha *= 0.7;\n" +
    "  vec3 color = (uColor + glow * vec3(0.15, 0.25, 0.45)) * vLight;\n" +
    "  color = mix(color, vec3(1.0), clamp(vLight - 0.85, 0.0, 1.0) * 0.2);\n" +
    "  fragColor = vec4(color, alpha);\n" +
    "}\n";

  // ---- 4x4 矩阵工具（列主序，与 WebGL uniform 一致） ----
  function m4Identity() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
  function m4Mul(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      o[c*4+r] = a[0*4+r]*b[c*4+0] + a[1*4+r]*b[c*4+1] + a[2*4+r]*b[c*4+2] + a[3*4+r]*b[c*4+3];
    }
    return o;
  }
  function m4Translation(tx, ty, tz) {
    var m = m4Identity(); m[12] = tx; m[13] = ty; m[14] = tz; return m;
  }
  function m4RotationX(a) { var c = Math.cos(a), s = Math.sin(a); var m = m4Identity(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
  function m4RotationY(a) { var c = Math.cos(a), s = Math.sin(a); var m = m4Identity(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
  function m4RotationZ(a) { var c = Math.cos(a), s = Math.sin(a); var m = m4Identity(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }
  function m4Scale(s) { var m = m4Identity(); m[0] = s; m[5] = s; m[10] = s; return m; }
  function m4Perspective(fovY, aspect, near, far) {
    var f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
    return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
  }
  function m4Inverse(m) {
    var m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
    var m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
    var m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
    var m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

    var b00 = m00 * m11 - m01 * m10;
    var b01 = m00 * m12 - m02 * m10;
    var b02 = m00 * m13 - m03 * m10;
    var b03 = m01 * m12 - m02 * m11;
    var b04 = m01 * m13 - m03 * m11;
    var b05 = m02 * m13 - m03 * m12;
    var b06 = m20 * m31 - m21 * m30;
    var b07 = m20 * m32 - m22 * m30;
    var b08 = m20 * m33 - m23 * m30;
    var b09 = m21 * m32 - m22 * m31;
    var b10 = m21 * m33 - m23 * m31;
    var b11 = m22 * m33 - m23 * m32;

    var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return m4Identity();
    var invDet = 1.0 / det;

    var out = new Float32Array(16);
    out[0] = (m11 * b11 - m12 * b10 + m13 * b09) * invDet;
    out[1] = (-m01 * b11 + m02 * b10 - m03 * b09) * invDet;
    out[2] = (m31 * b05 - m32 * b04 + m33 * b03) * invDet;
    out[3] = (-m21 * b05 + m22 * b04 - m23 * b03) * invDet;
    out[4] = (-m10 * b11 + m12 * b08 - m13 * b07) * invDet;
    out[5] = (m00 * b11 - m02 * b08 + m03 * b07) * invDet;
    out[6] = (-m30 * b05 + m32 * b02 - m33 * b01) * invDet;
    out[7] = (m20 * b05 - m22 * b02 + m23 * b01) * invDet;
    out[8] = (m10 * b10 - m11 * b08 + m13 * b06) * invDet;
    out[9] = (-m00 * b10 + m01 * b08 - m03 * b06) * invDet;
    out[10] = (m30 * b04 - m31 * b02 + m33 * b00) * invDet;
    out[11] = (-m20 * b04 + m21 * b02 - m23 * b00) * invDet;
    out[12] = (-m10 * b09 + m11 * b07 - m12 * b06) * invDet;
    out[13] = (m00 * b09 - m01 * b07 + m02 * b06) * invDet;
    out[14] = (-m30 * b03 + m31 * b01 - m32 * b00) * invDet;
    out[15] = (m20 * b03 - m21 * b01 + m22 * b00) * invDet;

    return out;
  }


/* ===================== theme.js ===================== */
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


/* ===================== settings.js ===================== */
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


/* ===================== dom.js ===================== */
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


/* ===================== whale.js ===================== */
/* ------------------------------------------------------------------ *
 * src/whale.js — 粒子化鲸鱼引擎（initWhale）+ 鲸鱼层显隐
 *   shader/纹理常量与矩阵工具在 src/whale-shaders.js（工厂级片段）。
 *   由 scripts/build.mjs 拼接进 lib/client.js 的工厂闭包。
 * ------------------------------------------------------------------ */
function initWhale(shared) {
  var state = shared.state;
  var bgSettings = shared.settings;
  var media = shared.media;
  var diag = shared.dom.diag;

  /** 鲸鱼层显隐：全主题统一，仅受设置主开关控制 */
  function updateWhaleDisplay(layer) {
    var el = layer || shared.dom.whaleLayer;
    if (!el) return;
    el.style.display = (bgSettings.on !== false) ? "flex" : "none";
  }
  function startWhale(canvasArg) {
    var canvas = canvasArg || shared.dom.whaleCanvas;
    if (!canvas) { diag.mode = "no-canvas"; return; }
    diag.canvasW = window.innerWidth || 0; diag.canvasH = window.innerHeight || 0;
    // 先试 WebGL2；失败或渲染丢失时回退到 2D canvas（保证一定能看到鲸鱼）。
    var gl = null;
    try {
      gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" });
    } catch (_) { gl = null; }
    if (!gl) { diag.mode = "webgl2-2d"; diag.err = "no-webgl2"; startWhale2D(canvas, "no-webgl2"); return; }
    diag.whaleGL = true;
    diag.mode = "webgl2";
    diag.err = "";
    try {
      canvas.addEventListener("webglcontextlost", function(e){ try{ e.preventDefault(); }catch(_){} canvas.dataset.state="context-lost"; diag.err="context-lost"; startWhale2D(canvas, "context-lost"); });
      canvas.addEventListener("webglcontextrestored", function(){ try{ canvas.dataset.state="restoring"; startWhale(canvas); }catch(_){} });
    } catch(_){}
    var img = new Image();
    img.onload = function () {
      var data;
      try { data = sampleWhalePixels(img); } catch (e) { diag.err="sample-fail"; startWhale2D(canvas, "sample-fail"); return; }
      if (!data || data.count === 0) { diag.err="sample-empty"; startWhale2D(canvas, "sample-empty"); return; }
      canvas.dataset.count = data.count;
      diag.count = data.count;
      var ok = true;
      try { initWhaleGL(gl, canvas, data); } catch (e) { ok = false; }
      // shader/link 失败时 canvas.dataset.state 会标记为非 shader-ok
      if (!ok || (canvas.dataset.state && canvas.dataset.state.indexOf("shader-ok") === -1 && canvas.dataset.state !== "context-lost")) {
        diag.err = canvas.dataset && canvas.dataset.state;
        startWhale2D(canvas, "gl-fallback");
      }
    };
    img.onerror = function () { diag.err="img-fail"; startWhale2D(canvas, "img-fail"); };
    img.src = WHALE_SRC;
  }

  /** WebGL2 不可用/失败时的 2D canvas 兜底：用同一套官方轮廓点画点阵 + 连线 + 鼠标扰动 */
  function startWhale2D(canvas, reason) {
    try { canvas.dataset.state = "2d:" + reason; } catch (_) {}
    var g = canvas.getContext("2d");
    if (!g || !g.canvas) return;
    var img = new Image();
    img.onload = function () {
      var data;
      try { data = sampleWhalePixels(img); } catch (e) { return; }
      if (!data || data.count === 0) return;
      var W = 0, H = 0, DPR = 1, scale = 0, ox = 0, oy = 0;
      function resize() {
        W = window.innerWidth; H = window.innerHeight;
        DPR = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
        canvas.style.width = W + "px"; canvas.style.height = H + "px";
        g.setTransform(DPR, 0, 0, DPR, 0, 0);
        // 官方参数映射到屏幕：宽幅右移，缩放到视口小边
        scale = Math.min(W, H) * 0.34; ox = W * 0.5; oy = H * 0.52;
      }
      resize();
      window.addEventListener("resize", resize);
      var mouse = { x: -1e4, y: -1e4 };
      function onMove(e) { if (bgSettings.mouse) { mouse.x = e.clientX; mouse.y = e.clientY; } }
      window.addEventListener("pointermove", onMove, { passive: true });
      var raf = 0, start = performance.now();
      function frame(now) {
        raf = requestAnimationFrame(frame);
        if (shared.dom.whaleLayer.style.display === "none") return;
        g.clearRect(0, 0, W, H);
        var t = (now - start) / 1000;
        var L = Math.max(0, Math.min(1, (t - 0.3) / 2.5));
        var D = 1 - Math.pow(1 - L, 3);
        var rot = Math.sin(t * 0.08) * 0.12; // 轻微摆动
        var c = Math.cos(rot), s = Math.sin(rot);
        var px = [], py = [];
        for (var i = 0; i < data.count; i++) {
          var x = data.positions[i*3], y = data.positions[i*3+1], z = data.positions[i*3+2];
          var rx = x * c - y * s, ry = x * s + y * c;
          var sx = ox + rx * scale, sy = oy + ry * scale;
          var drift = Math.sin(t * 0.6 + i * 0.3) * 4;
          px.push(sx + drift); py.push(sy);
        }
        // 邻近连线（简化）
        g.strokeStyle = "rgba(103,153,254," + (0.035 * D).toFixed(3) + ")";
        g.lineWidth = 0.5;
        for (var a = 0; a < px.length; a++) {
          for (var b = a + 1; b < px.length; b++) {
            var dx = px[a]-px[b], dy = py[a]-py[b];
            var d2 = dx*dx + dy*dy;
            if (d2 < 12000 && d2 > 1) {
              var al = (1 - d2/12000) * 0.035 * D;
              g.strokeStyle = "rgba(103,153,254," + al.toFixed(3) + ")";
              g.beginPath(); g.moveTo(px[a], py[a]); g.lineTo(px[b], py[b]); g.stroke();
            }
          }
        }
        // 点阵本体（鼠标斥力）
        for (var k = 0; k < px.length; k++) {
          var mx = px[k]-mouse.x, my = py[k]-mouse.y;
          var md = Math.sqrt(mx*mx+my*my), PUSH = 80;
          var fx = px[k], fy = py[k];
          if (md < PUSH && md > 0.001) { var f = (PUSH-md)/PUSH; fx += (mx/md)*f*14; fy += (my/md)*f*14; }
          g.fillStyle = "rgba(103,153,254," + (0.14 * D).toFixed(3) + ")";
          g.beginPath(); g.arc(fx, fy, 1.5 + Math.random()*0.8, 0, Math.PI*2); g.fill();
        }
      }
      raf = requestAnimationFrame(frame);
      if (media.reducedMotion) { cancelAnimationFrame(raf); raf = 0; }
    };
    img.src = WHALE_SRC;
  }

  function initWhaleGL(gl, canvas, data) {
    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        var log=""; try{ log=gl.getShaderInfoLog(s)||"compile failed"; }catch(_){}
        try{ console.error("[dsh-bg] whale shader compile failed:", log.slice(0,400)); }catch(_){}
        try{ canvas.dataset.state="whale-compile-fail:"+log.slice(0,200); diag.whaleProgs="compile-fail"; }catch(_){}
        try{ gl.deleteShader(s); }catch(_){}
        return null;
      }
      return s;
    }
    var prog = gl.createProgram();
    var vsS = compile(gl.VERTEX_SHADER, WHALE_VS);
    var fsS = compile(gl.FRAGMENT_SHADER, WHALE_FS);
    if (!vsS || !fsS) { try{ canvas.dataset.state="whale-shader-null"; diag.whaleProgs="compile-fail"; }catch(_){} return; }
    gl.attachShader(prog, vsS);
    gl.attachShader(prog, fsS);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      var log2=""; try{ log2=gl.getProgramInfoLog(prog)||"link failed"; }catch(_){}
      try{ console.error("[dsh-bg] whale program link failed:", log2.slice(0,400)); }catch(_){}
      try{ canvas.dataset.state = "link-fail:"+log2.slice(0,200); diag.whaleProgs = "link-fail"; }catch(_){}
      try{ gl.deleteProgram(prog); }catch(_){}
      return;
    }
    canvas.dataset.state = "shader-ok";
    diag.whaleProgs = "ok";
    gl.useProgram(prog);

    function buf(attr, arr, size) {
      var loc = gl.getAttribLocation(prog, attr);
      var b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    buf("aCenter", data.positions, 3);
    buf("aScattered", data.scatteredPositions, 3);
    buf("aOpacity", data.opacities, 1);
    buf("aEdge", data.edges, 1);
    var idx = new Float32Array(data.count);
    for (var i = 0; i < data.count; i++) idx[i] = i;
    buf("aIndex", idx, 1);
    // 官方实例缩放：s = .5 + 1*Math.random()（0.5–1.5）——粒子大小有变化，
    // 大粒子呈现小方块，是官方鲸鱼层次感的关键（chunk 776 源码原逻辑）
    var scaleArr = new Float32Array(data.count);
    for (var i2 = 0; i2 < data.count; i2++) scaleArr[i2] = 0.5 + 1 * Math.random();
    buf("aScale", scaleArr, 1);
    // position 属性默认 (0,0,0,1) —— 官方 BoxGeometry 的局部偏移对点精灵为 0

    var u = {};
    ["uTime","uWaveSpeed","uWaveAmount","uMouse","uMouseRadius","uMouseStrength","uMouseDistort",
     "uAssembly","uLoose","uScatter","uLightPos","uLightRange","uShadeMin","uShadeMax",
     "uModel","uView","uProj","uPointScale","uColor"].forEach(function (n) { u[n] = gl.getUniformLocation(prog, n); });

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); // 普通 alpha 混合：浅色/深色主题都能看清
    gl.disable(gl.DEPTH_TEST);

    // 鼠标状态机（官方：mouseActive / mouseHasMoved）
    var mouse = { x: 0, y: 0, active: false, hasMoved: false };
    function onMove(e) {
      if (!bgSettings.mouse) return; // 设置面板「鼠标跟随交互」关闭时忽略
      mouse.active = true;
      mouse.hasMoved = true;
      var w = window.innerWidth || 1, h = window.innerHeight || 1;
      mouse.x = (e.clientX / w) * 2 - 1;
      mouse.y = -((e.clientY / h) * 2 - 1);
    }
    function onLeave() { mouse.active = false; }
    function onVis() { if (document.hidden) mouse.active = false; }
    if (!media.reducedMotion) {
      window.addEventListener("mousemove", onMove, { passive: true });
      window.addEventListener("mouseleave", onLeave);
      document.addEventListener("visibilitychange", onVis);
    }

    var start = performance.now();
    var raf = 0;
    var last = 0;
    var strength = 0;
    var b = { x: 0, y: 0 };
    // 光线跟随的平滑状态（屏幕归一化坐标，帧率无关指数平滑，时间常数 ~40ms）
    var wSX = 0, wSY = 0;
    var FOV = 50 * Math.PI / 180;
    // 相机距离：官方 18 → 15（18/15 = 1.2），鲸鱼整体等比放大 1.2 倍
    var CAM_DIST = 15;
    var HALF_H = Math.tan(FOV / 2) * CAM_DIST; // viewport（z=0 平面）半高
    var view = m4Translation(0, 0, -15);
    // 复用矩阵缓冲，避免每帧分配 6 个 Float32Array(16)
    var _mTmpA = new Float32Array(16), _mTmpB = new Float32Array(16), _mTmpC = new Float32Array(16), _mTmpD = new Float32Array(16), _mTmpE = new Float32Array(16), _mTmpF = new Float32Array(16);
    var _modelBuf = new Float32Array(16), _projBuf = new Float32Array(16);

    // GPU 优化：鲸鱼是柔光粒子层，1.25x 物理分辨率渲染（原 1.5x 上限），
    // 像素量减少约 30%，屏幕混合的柔光粒子放大后无感知差异
    var WHALE_DPR = 1.25;

    // out 参数版矩阵工具（复用缓冲，零分配）
    function m4TranslationOut(tx, ty, tz, out) { out[0]=1;out[1]=0;out[2]=0;out[3]=0; out[4]=0;out[5]=1;out[6]=0;out[7]=0; out[8]=0;out[9]=0;out[10]=1;out[11]=0; out[12]=tx;out[13]=ty;out[14]=tz;out[15]=1; return out; }
    function m4ScaleOut(s, out) { out[0]=s;out[1]=0;out[2]=0;out[3]=0; out[4]=0;out[5]=s;out[6]=0;out[7]=0; out[8]=0;out[9]=0;out[10]=s;out[11]=0; out[12]=0;out[13]=0;out[14]=0;out[15]=1; return out; }
    function m4RotationXOut(a, out){ var c=Math.cos(a),s=Math.sin(a); out[0]=1;out[1]=0;out[2]=0;out[3]=0; out[4]=0;out[5]=c;out[6]=s;out[7]=0; out[8]=0;out[9]=-s;out[10]=c;out[11]=0; out[12]=0;out[13]=0;out[14]=0;out[15]=1; return out; }
    function m4RotationYOut(a, out){ var c=Math.cos(a),s=Math.sin(a); out[0]=c;out[1]=0;out[2]=-s;out[3]=0; out[4]=0;out[5]=1;out[6]=0;out[7]=0; out[8]=s;out[9]=0;out[10]=c;out[11]=0; out[12]=0;out[13]=0;out[14]=0;out[15]=1; return out; }
    function m4RotationZOut(a, out){ var c=Math.cos(a),s=Math.sin(a); out[0]=c;out[1]=s;out[2]=0;out[3]=0; out[4]=-s;out[5]=c;out[6]=0;out[7]=0; out[8]=0;out[9]=0;out[10]=1;out[11]=0; out[12]=0;out[13]=0;out[14]=0;out[15]=1; return out; }
    function m4MulOut(a,b,out){ for(var c=0;c<4;c++) for(var r=0;r<4;r++) out[c*4+r]=a[0*4+r]*b[c*4+0]+a[1*4+r]*b[c*4+1]+a[2*4+r]*b[c*4+2]+a[3*4+r]*b[c*4+3]; return out; }
    function m4PerspectiveOut(fovY, aspect, near, far, out){ var f=1/Math.tan(fovY/2), nf=1/(near-far); out[0]=f/aspect;out[1]=0;out[2]=0;out[3]=0; out[4]=0;out[5]=f;out[6]=0;out[7]=0; out[8]=0;out[9]=0;out[10]=(far+near)*nf;out[11]=-1; out[12]=0;out[13]=0;out[14]=2*far*near*nf;out[15]=0; return out; }

    function resize() {
      var w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
      var dpr = WHALE_DPR;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (shared.dom.whaleLayer.style.display === "none") return;
      // 鼠标跟随开启时鲸鱼提到 60fps（点精灵渲染开销小），光线/扭曲跟手更顺滑
      var frameMs = 1000 / (bgSettings.mouse ? 60 : (bgSettings.fps || 30));
      if (now - last < frameMs) return;
      var dt = Math.min(0.5, (now - last) / 1000);
      last = now - (now - last) % frameMs;

      var w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
      if (Math.round(w * WHALE_DPR) !== canvas.width || Math.round(h * WHALE_DPR) !== canvas.height) resize();

      var elapsed = (now - start) / 1000;
      var L = Math.max(0, Math.min(1, (elapsed - 0.3) / 2.5));
      var D = 1 - Math.pow(1 - L, 3); // 官方 easeOutCubic 组装
      var E = 0; // 固定背景无滚动分散

      // 官方 group 变换（fish：spin=false）
      var rotZ = elapsed * ((1 - D) * 0.3) + 0.04 * Math.sin(0.25 * elapsed);
      var rotX = 0.05 * Math.sin(0.08 * elapsed * 0.7);
      var rotY = 0.1 * Math.sin(0.08 * elapsed);
      var posY = 0.15 * Math.sin(0.4 * elapsed);
      var scale = 0.75 + 0.25 * D;
      var aspect = canvas.width / canvas.height;
      var halfW = HALF_H * aspect;
      // 靠右布局：将鲸鱼中心进一步向右侧偏移（占据右侧开阔区域，文字区彻底清爽）
      var posX = halfW * 0.52;
      // 使用复用缓冲的 out 版矩阵，避免每帧新建 6 个 Float32Array
      m4RotationXOut(rotX, _mTmpA);
      m4RotationYOut(rotY, _mTmpB);
      m4MulOut(_mTmpB, _mTmpA, _mTmpC);
      m4RotationZOut(rotZ, _mTmpD);
      m4MulOut(_mTmpD, _mTmpC, _mTmpE);
      m4TranslationOut(posX, posY, 0, _mTmpA);
      m4MulOut(_mTmpA, _mTmpE, _mTmpB);
      m4ScaleOut(scale, _mTmpC);
      m4MulOut(_mTmpB, _mTmpC, _modelBuf);
      var model = _modelBuf;
      m4PerspectiveOut(FOV, aspect, 0.1, 100, _projBuf);
      var proj = _projBuf;
      gl.uniformMatrix4fv(u.uModel, false, model);
      gl.uniformMatrix4fv(u.uView, false, view);
      gl.uniformMatrix4fv(u.uProj, false, proj);
      gl.uniform1f(u.uTime, elapsed);
      gl.uniform1f(u.uWaveSpeed, WAVE_DEFAULTS.speed);
      gl.uniform1f(u.uWaveAmount, WAVE_DEFAULTS.amount);
      gl.uniform1f(u.uAssembly, D);
      gl.uniform1f(u.uLoose, 1);
      gl.uniform1f(u.uScatter, 0);
      gl.uniform1f(u.uMouseRadius, MOUSE_DEFAULTS.radius);
      gl.uniform1f(u.uMouseDistort, MOUSE_DEFAULTS.distort);
      // 鼠标强度：官方以 (1-0.05^dt) 插值；设置面板关闭时恒为 0
      var target = (mouse.active && bgSettings.mouse) ? MOUSE_DEFAULTS.strength : 0;
      strength += (target - strength) * (1 - Math.pow(0.05, dt));
      gl.uniform1f(u.uMouseStrength, strength);
      // 光线：跟随鲸鱼右移基准 + 光标移动响应
      var wk = 1 - Math.exp(-dt / ((bgSettings.followMs != null ? bgSettings.followMs : 20) * 2 / 1000));
      wSX += ((bgSettings.mouse ? mouse.x : 0) - wSX) * wk;
      wSY += ((bgSettings.mouse ? mouse.y : 0) - wSY) * wk;
      gl.uniform3f(u.uLightPos, posX + 2.5 + wSX * halfW * LIGHT_DEFAULTS.followX * (bgSettings.mouse ? (bgSettings.lightFollow != null ? bgSettings.lightFollow : 1) : 0), LIGHT_DEFAULTS.y, LIGHT_DEFAULTS.z);
      gl.uniform1f(u.uLightRange, LIGHT_DEFAULTS.range);
      gl.uniform1f(u.uShadeMin, LIGHT_DEFAULTS.shadeMin);
      gl.uniform1f(u.uShadeMax, LIGHT_DEFAULTS.shadeMax);
      // uMouse：屏幕鼠标 → 世界(z=0) → 组局部空间（官方 matrixWorld 逆变换）
      if (mouse.hasMoved) {
        var wx = mouse.x * halfW, wy = mouse.y * HALF_H;
        if (strength < 0.01) { b.x = wx; b.y = wy; }
        // 帧率无关：官方 decay 是每 30fps 帧的插值系数，按实际 dt 归一化，60fps 下手感一致
        else { b.x += (wx - b.x) * (1 - Math.pow(1 - MOUSE_DEFAULTS.decay, dt * 30)); b.y += (wy - b.y) * (1 - Math.pow(1 - MOUSE_DEFAULTS.decay, dt * 30)); }
      }
      var inv = m4Inverse(model);
      var ux = inv[0]*b.x + inv[4]*b.y + inv[12];
      var uy = inv[1]*b.x + inv[5]*b.y + inv[13];
      gl.uniform2f(u.uMouse, ux, uy);
      // 颜色：DeepSeek 品牌蓝（稍暗一档），随组装进度 D 淡入，明暗主题皆可辨
      gl.uniform3f(u.uColor, 0.26 * D, 0.47 * D, 0.9 * D);
      // 点尺寸：官方 BoxGeometry 0.065 单位 × 实例缩放 × 组缩放（提升粒子点阵清晰度）
      gl.uniform1f(u.uPointScale, 0.065 * scale * (canvas.height / (2 * HALF_H)));

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, data.count);
    }

    if (media.reducedMotion) {
      start = performance.now() - 30000; // 组装动画已完成的状态下绘制单帧
      last = 0;
      frame(performance.now());
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      raf = requestAnimationFrame(frame);
    }
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        if (!raf && !media.reducedMotion) raf = requestAnimationFrame(frame);
      } else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    });
  }

  shared.refs.startWhale = startWhale;
  shared.refs.updateWhaleDisplay = updateWhaleDisplay;
}


/* ===================== whale-overlay.js ===================== */
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


/* ===================== boot.js ===================== */
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


/* ===================== index.js ===================== */
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


    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
