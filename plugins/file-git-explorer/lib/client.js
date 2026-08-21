// dsh-file-git-explorer — client half(静态浏览器 bundle)
//
// 与动态插件 client 半的差异: 沙箱内置符号换成真实模块表依赖 ——
// React 经 require('react') 解析(loader 种子模块), host.call 换成
// fetch('/fge/api/<method>'), styles.insert 换成手动 <style> 注入。
// 槽位注册 API(slots.inject / slots.register)与动态完全一致。
//
// UI 结构(全部挂在 shell.overlay, 官方 additive 帧级悬浮层):
//   ├─ 左侧文件树面板: 上=可见组 / 中=隐藏组 / 下=忽略组(三区独立滚动)
//   │    目录单击展开/折叠(懒加载), 文件单击 → 内容悬浮面板(向右浮出, 可越对话区)
//   │    + 右侧 git 树联动高亮(有 diff 才定位, 不自动打开)
//   ├─ 右侧 git 树面板: 顶部当前分支(只读下拉) + 变更列表(相对 HEAD)
//   │    变更单击 → diff 悬浮面板(向左浮出)
//   ├─ 图钉: 钉住后两面板都不能收起; 未钉时点击面板外自动收起为细条
//   └─ 几何: 两面板 fixed, top=会话 header 底部, bottom=composer card 底部,
//       左树左缘跟随应用侧边栏右缘, 右树右缘让位 details 列; 左右可拉伸,
//       钳制为不覆盖主对话区。锚点全部用稳定 data 属性, 不依赖哈希类名。
window.__ModuleLoader__.load({
  id: 'dsh-file-git-explorer',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');

    exports.name = 'dsh-file-git-explorer';
    exports.inject = ['slots'];
    exports.apply = function (ctx) {
      var slots = ctx.slots;

      // ---- 与 host 通信 ----
      function api(method, body) {
        return fetch('/fge/api/' + method, {
          method: 'POST',
          headers: { 'x-dsh-plugin': '1', 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        }).then(function (res) {
          if (!res.ok) throw new Error('fge: http ' + String(res.status));
          return res.json();
        });
      }

      // ---- 样式 ----
      var STYLE_CSS =
        '.fge-wrap{position:absolute;width:0;height:0;pointer-events:none;font-family:var(--ds-font-family,system-ui);}' +
        '.fge-panel{position:fixed;pointer-events:auto;display:flex;flex-direction:column;box-sizing:border-box;' +
        'background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;' +
        'box-shadow:var(--dsw-shadow-lv2,rgba(0,0,0,.18)) 0 6px 24px;color:var(--dsw-alias-label-primary);' +
        '--dsh-scrollbar-thumb:color-mix(in srgb,var(--dsw-alias-label-tertiary) 28%,transparent);' +
        '--dsh-scrollbar-thumb-hover:color-mix(in srgb,var(--dsw-alias-label-tertiary) 45%,transparent);' +
        'font-size:12px;line-height:1.45;z-index:30;}' +
        '.fge-strip{position:fixed;pointer-events:auto;display:flex;align-items:center;justify-content:center;' +
        'background:transparent;border:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));' +
        'cursor:pointer;z-index:30;}' +
        '.fge-strip:hover{color:var(--dsw-alias-label-primary);}' +
        '.fge-panel-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);' +
        'flex:none;color:var(--dsw-alias-label-primary);font-weight:600;}' +
        '.fge-panel-title{flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:18px;}' +
        '.fge-panel-sub{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-weight:400;' +
        'font-size:11px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;}' +
        '.fge-panel-sub:hover{color:var(--dsw-alias-label-primary);}' +
        '.fge-panel-sub.fge-copied{color:var(--dsw-alias-state-success-primary);}' +
        '.fge-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);' +
        'border-radius:6px;padding:2px 6px;font-size:12px;cursor:pointer;line-height:1.4;}' +
        '.fge-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}' +
        '.fge-btn:disabled{opacity:.35;cursor:not-allowed;}' +
        '.fge-btn-active{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);}' +
        '.fge-section{display:flex;flex-direction:column;min-height:0;}' +
        '.fge-section-head{flex:none;padding:3px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));' +
        'border-top:1px solid var(--dsw-alias-border-l1);}' +
        '.fge-section-body{flex:1;overflow:auto;min-height:0;padding:2px 0;' +
        'scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 28%,transparent) transparent;}' +
        '.fge-section-body::-webkit-scrollbar,.fge-changes::-webkit-scrollbar,.fge-float-body::-webkit-scrollbar{width:5px;height:5px;}' +
        '.fge-section-body::-webkit-scrollbar-track,.fge-changes::-webkit-scrollbar-track,.fge-float-body::-webkit-scrollbar-track{background:transparent;}' +
        '.fge-section-body::-webkit-scrollbar-thumb,.fge-changes::-webkit-scrollbar-thumb,.fge-float-body::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 22%,transparent);border-radius:3px;}' +
        '.fge-section-body::-webkit-scrollbar-thumb:hover,.fge-changes::-webkit-scrollbar-thumb:hover,.fge-float-body::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 40%,transparent);}' +
        '.fge-tree{padding:0;}' +
        '.fge-node{display:flex;align-items:center;gap:4px;padding:2px 6px;cursor:pointer;white-space:nowrap;' +
        'color:var(--dsw-alias-label-secondary);border-radius:4px;}' +
        '.fge-node:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}' +
        '.fge-node.fge-dir{color:var(--dsw-alias-label-primary);}' +
        '.fge-node.fge-selected{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);}' +
        '.fge-node-icon{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}' +
        '.fge-node-name{flex:1;overflow:hidden;text-overflow:ellipsis;}' +
        '.fge-loading{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));padding:2px 10px;font-size:11px;}' +
        '.fge-empty{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));padding:2px 10px;font-size:11px;}' +
        '.fge-branch{display:flex;align-items:center;gap:4px;padding:4px 8px;cursor:pointer;flex:none;' +
        'border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);}' +
        '.fge-branch:hover{background:var(--dsw-alias-bg-layer-2);}' +
        '.fge-branch-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}' +
        '.fge-branch-caret{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}' +
        '.fge-branch-menu{position:absolute;right:calc(100% + 8px);top:30px;width:280px;max-width:60vw;z-index:40;background:var(--dsw-alias-bg-overlay);' +
        'border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:var(--dsw-shadow-lv2,rgba(0,0,0,.25)) 0 8px 28px;' +
        'max-height:220px;overflow:auto;padding:4px;}' +
        '.fge-branch-group{font-size:10px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));' +
        'padding:4px 6px 2px;}' +
        '.fge-branch-item{display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:4px;cursor:pointer;' +
        'color:var(--dsw-alias-label-secondary);}' +
        '.fge-branch-item:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}' +
        '.fge-branch-item.fge-branch-current{color:var(--dsw-alias-brand-primary);font-weight:600;}' +
        '.fge-branch-item.fge-branch-viewed{color:var(--dsw-alias-state-warn-primary);}' +
        '.fge-branch-mark{margin-left:auto;font-size:10px;}' +
        '.fge-changes{flex:1;overflow:auto;min-height:0;padding:2px 0;' +
        'scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 28%,transparent) transparent;}' +
        '.fge-change{display:flex;align-items:center;gap:6px;padding:2px 8px;cursor:pointer;white-space:nowrap;' +
        'color:var(--dsw-alias-label-secondary);border-radius:4px;}' +
        '.fge-change:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}' +
        '.fge-change.fge-selected{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}' +
        '.fge-badge{flex:none;min-width:16px;text-align:center;font-size:10px;font-weight:700;border-radius:4px;padding:0 3px;}' +
        '.fge-badge-M{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 15%,transparent);}' +
        '.fge-badge-A{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);}' +
        '.fge-badge-D{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 15%,transparent);}' +
        '.fge-badge-R,.fge-badge-C{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);}' +
        '.fge-badge-U{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}' +
        '.fge-change-path{flex:1;overflow:hidden;text-overflow:ellipsis;}' +
        '.fge-flash{animation:fge-flash 1.4s ease-out;}' +
        '@keyframes fge-flash{0%{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);}100%{background:transparent;}}' +
        '.fge-float{position:fixed;pointer-events:auto;display:flex;flex-direction:column;box-sizing:border-box;' +
        'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;' +
        'box-shadow:var(--dsw-shadow-lv3,rgba(0,0,0,.3)) 0 12px 40px;color:var(--dsw-alias-label-primary);' +
        '--dsh-scrollbar-thumb:color-mix(in srgb,var(--dsw-alias-label-tertiary) 28%,transparent);' +
        '--dsh-scrollbar-thumb-hover:color-mix(in srgb,var(--dsw-alias-label-tertiary) 45%,transparent);' +
        'font-size:12px;overflow:hidden;z-index:40;}' +
        '.fge-float-head{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;}' +
        '.fge-float-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}' +
        '.fge-float-body{flex:1;overflow:auto;min-height:0;padding:8px 10px;' +
        'scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 28%,transparent) transparent;}' +
        '.fge-pre{margin:0;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre;' +
        'color:var(--dsw-alias-label-primary);}' +
        '.fge-ln{display:inline-block;width:3ch;text-align:right;margin-right:10px;user-select:none;' +
        'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}' +
        '.fge-note{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));padding:8px;font-size:11px;}' +
        '.fge-tok-kw{color:var(--dsw-alias-brand-primary);}' +
        '.fge-tok-str{color:var(--dsw-alias-state-success-primary);}' +
        '.fge-tok-cmt{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-style:italic;}' +
        '.fge-tok-num{color:var(--dsw-alias-state-warn-primary);}' +
        '.fge-tok-fn{color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-state-success-primary));}' +
        '.fge-tok-type{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-brand-primary));}' +
        '.fge-diff-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-label-primary);}' +
        '.fge-diff-del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-label-primary);}' +
        '.fge-diff-hunk{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);color:var(--dsw-alias-brand-primary);}' +
        '.fge-diff-meta{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}' +
        '.fge-resize{position:absolute;top:0;bottom:0;width:6px;cursor:col-resize;z-index:35;}' +
        '.fge-resize::after{content:"";position:absolute;top:0;bottom:0;left:50%;width:2px;margin-left:-1px;background:transparent;transition:background .15s;}' +
        '.fge-resize:hover::after{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);}' +
        '.fge-resize-left{right:-3px;}' +
        '.fge-resize-right{left:-3px;}';
      var styleTag = null;
      function ensureStyles() {
        if (styleTag !== null) return;
        styleTag = document.createElement('style');
        styleTag.setAttribute('data-plugin', 'dsh-file-git-explorer');
        styleTag.textContent = STYLE_CSS;
        document.head.appendChild(styleTag);
      }
      ensureStyles();
      ctx.on('dispose', function () {
        if (styleTag !== null) {
          styleTag.remove();
          styleTag = null;
        }
      });

      // ---- 工具 ----
      var clamp = function (v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
      };
      var CACHE_KEY = 'fge-cache-v1';

      function readCache(repoRoot) {
        try {
          var all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
          return (all && all[repoRoot]) || null;
        } catch (e) {
          return null;
        }
      }
      function writeCache(repoRoot, patch) {
        if (!repoRoot) return;
        try {
          var all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
          var cur = all[repoRoot] || {};
          all[repoRoot] = {};
          for (var k in cur) all[repoRoot][k] = cur[k];
          for (var p in patch) all[repoRoot][p] = patch[p];
          localStorage.setItem(CACHE_KEY, JSON.stringify(all));
        } catch (e) {
          /* ignore */
        }
      }

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      // ---- 几何: 稳定 data 属性锚点 ----
      // top   = [data-conversation-scroll] 顶部(== header/tablist 边框线)
      // bottom= 滚动容器底边(对话列底, 统一基准):
      //        会话态 composer 虽 sticky 于列底, 但其内层卡片自带 8px 底部留白,
      //        若以它为底边会让面板上下边距不对称、整体偏上; 首页(hero)态同理。
      //        面板因此以「列顶 + 对称边距 / 列底 - 对称边距」垂直居中。
      // left/right = 对话滚动容器左右缘(自动跟随应用侧边栏折叠与 details 列)
      // 对话列宽 = --dsh-chat-content-width(定义在会话根, 滚动容器可继承)
      function measureGeometry() {
        var scrollBody = document.querySelector('[data-conversation-scroll]');
        if (!scrollBody) return null;
        var rect = scrollBody.getBoundingClientRect();
        var top = rect.top;
        var bottom = rect.bottom;
        var contentW =
          parseFloat(getComputedStyle(scrollBody).getPropertyValue('--dsh-chat-content-width')) ||
          748;
        var gap = Math.max(0, (rect.width - contentW) / 2);
        return {
          top: top,
          bottom: bottom,
          sbLeft: rect.left,
          sbRight: rect.right,
          convLeft: rect.left + gap,
          convRight: rect.right - gap,
          height: Math.max(0, bottom - top),
        };
      }

      function useGeometry() {
        var state = React.useState(measureGeometry);
        var geo = state[0];
        var setGeo = state[1];
        React.useEffect(function () {
          var pending = false;
          function schedule() {
            if (pending) return;
            pending = true;
            requestAnimationFrame(function () {
              pending = false;
              setGeo(measureGeometry());
            });
          }
          window.addEventListener('resize', schedule);
          window.addEventListener('scroll', schedule, true);
          var observer = new MutationObserver(schedule);
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class'],
          });
          var offSlots = ctx.on('slots/changed', schedule);
          return function () {
            window.removeEventListener('resize', schedule);
            window.removeEventListener('scroll', schedule, true);
            observer.disconnect();
            if (typeof offSlots === 'function') offSlots();
          };
        }, []);
        return geo;
      }

      // ---- 迷你语法高亮(逐行扫描, 不跨行) ----
      var KEYWORD_SET = {};
      var TYPE_SET = {};
      (function () {
        // 关键字(控制流 / 声明 / 操作符词): 覆盖常见语言
        var kw = (
          'const let var function return if else for while do switch case break continue new class extends ' +
          'import export from default async await yield try catch finally throw typeof instanceof in of this ' +
          'void delete super get set as is where null true false undefined ' +
          'def lambda fn pub struct enum impl trait type interface namespace package public private protected ' +
          'static readonly match use move borrow loop mut ref impl ' +
          'None True False self cls ' +
          'func defer go chan select map range goroutine ' +
          'public protected static final abstract synchronized throws extends implements new ' +
          'echo print include require exit die ' +
          'SELECT FROM WHERE INSERT INTO UPDATE DELETE CREATE TABLE JOIN INNER LEFT RIGHT GROUP BY ORDER HAVING LIMIT ' +
          'if else fi then elif do done esac ' +
          'and or not in is'
        ).split(' ');
        // 常见内建/类类型
        var types = (
          'String Number Boolean Object Array Function Promise Map Set Date Error RegExp Symbol BigInt ' +
          'Buffer Stream EventEmitter ' +
          'Num Bool Char Vec Option Result ' +
          'i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 usize isize ' +
          'Integer Float BigDecimal ' +
          'any unknown never Record Partial Required Omit Pick ' +
          'HttpRequest HttpResponse ObjectId Decimal'
        ).split(' ');
        for (var i = 0; i < kw.length; i++) KEYWORD_SET[kw[i]] = true;
        for (var j = 0; j < types.length; j++) TYPE_SET[types[j]] = true;
      })();

      function tokenizeLine(line) {
        var segs = [];
        var i = 0;
        var n = line.length;
        while (i < n) {
          var c = line[i];
          if (c === '"' || c === "'" || c === '`') {
            var q = c;
            var j = i + 1;
            while (j < n) {
              if (line[j] === '\\') {
                j += 2;
                continue;
              }
              if (line[j] === q) {
                j++;
                break;
              }
              j++;
            }
            segs.push({ t: 'str', v: line.slice(i, j) });
            i = j;
            continue;
          }
          if (c === '#' || (c === '/' && line[i + 1] === '/')) {
            segs.push({ t: 'cmt', v: line.slice(i) });
            break;
          }
          if (c === '/' && line[i + 1] === '*') {
            var k = line.indexOf('*/', i + 2);
            if (k === -1) k = n;
            else k += 2;
            segs.push({ t: 'cmt', v: line.slice(i, k) });
            i = k;
            continue;
          }
          var ch = line[i];
          if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] || ''))) {
            var m = /^[0-9][0-9a-fA-FxXoObB_.]*/.exec(line.slice(i));
            var num = m ? m[0] : ch;
            segs.push({ t: 'num', v: num });
            i += num.length;
            continue;
          }
          if (/[A-Za-z_$]/.test(ch)) {
            var m2 = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(line.slice(i));
            var word = m2 ? m2[0] : ch;
            // 分类: 内建/大写类型 > 关键字 > 函数调用(后接 `(`) > 普通标识符
            var t = 'plain';
            if (TYPE_SET[word]) {
              t = 'type';
            } else if (KEYWORD_SET[word]) {
              t = 'kw';
            } else if (/[A-Z]/.test(word.charAt(0))) {
              t = 'type'; // 大写开头 → 类/类型
            } else {
              var look = i + word.length;
              while (look < n && /\s/.test(line[look])) look++;
              if (line[look] === '(') t = 'fn'; // 小写标识符后接 `(` → 函数调用
            }
            segs.push({ t: t, v: word });
            i += word.length;
            continue;
          }
          // 运算符/分隔符/空白: 连续消费, 但不吞掉下一个 token 的开头字符
          // (否则 `class Foo` 会把 `Foo` 一并划进普通文本, 导致高亮丢失)
          var j = i;
          while (j < n) {
            var cc = line[j];
            if (cc === '"' || cc === "'" || cc === '`') break; // 字符串
            if (cc === '#') break; // 注释
            if (cc === '/' && (line[j + 1] === '/' || line[j + 1] === '*')) break; // 注释
            if (/[A-Za-z0-9_$]/.test(cc)) break; // 标识符/数字紧邻
            if (cc === '.' && /[0-9]/.test(line[j + 1] || '')) break; // `.5` 数字
            j++;
          }
          if (j === i) j = i + 1;
          segs.push({ t: 'plain', v: line.slice(i, j) });
          i = j;
        }
        return segs;
      }

      function lineToHtml(line) {
        var segs = tokenizeLine(line);
        var html = '';
        for (var i = 0; i < segs.length; i++) {
          var s = segs[i];
          if (s.t === 'plain') html += escapeHtml(s.v);
          else html += '<span class="fge-tok-' + s.t + '">' + escapeHtml(s.v) + '</span>';
        }
        return html;
      }

      var MAX_PREVIEW_LINES = 4000;

      function highlightToHtml(text, numbered) {
        var lines = String(text).split('\n');
        if (lines.length > MAX_PREVIEW_LINES) lines = lines.slice(0, MAX_PREVIEW_LINES);
        var html = '';
        for (var i = 0; i < lines.length; i++) {
          if (numbered) html += '<span class="fge-ln">' + (i + 1) + '</span>';
          html += lineToHtml(lines[i]);
          if (i < lines.length - 1) html += '\n';
        }
        return html;
      }

      function diffToHtml(text) {
        var lines = String(text).split('\n');
        var html = '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var cls = '';
          if (line.slice(0, 4) === '@@ ') cls = 'fge-diff-hunk';
          else if (
            line.slice(0, 10) === 'diff --git' ||
            line.slice(0, 6) === 'index ' ||
            line.slice(0, 4) === '--- ' ||
            line.slice(0, 4) === '+++ ' ||
            line.slice(0, 13) === 'new file mode' ||
            line.slice(0, 13) === 'deleted file ' ||
            line.slice(0, 14) === 'similarity ind' ||
            line.slice(0, 12) === 'rename from ' ||
            line.slice(0, 10) === 'rename to ' ||
            line.slice(0, 13) === 'old mode 100' ||
            line.slice(0, 13) === 'new mode 100' ||
            line.slice(0, 13) === 'Binary files '
          )
            cls = 'fge-diff-meta';
          else if (line.slice(0, 1) === '+') cls = 'fge-diff-add';
          else if (line.slice(0, 1) === '-') cls = 'fge-diff-del';

          if (cls === 'fge-diff-add' || cls === 'fge-diff-del') {
            // 剥离 +/- 前缀, 内容做代码高亮(保留增删背景色)
            html +=
              '<span class="' + cls + '">' + line.charAt(0) + lineToHtml(line.slice(1)) + '</span>';
          } else if (cls === 'fge-diff-hunk' || cls === 'fge-diff-meta') {
            html += '<span class="' + cls + '">' + escapeHtml(line) + '</span>';
          } else {
            // 上下文行(空格或无前缀)也做代码高亮
            html += lineToHtml(line);
          }
          if (i < lines.length - 1) html += '\n';
        }
        return html;
      }

      function formatBytes(n) {
        if (n < 1024) return String(n) + ' B';
        if (n < 1048576) return String(Math.round((n / 1024) * 10) / 10) + ' KB';
        return String(Math.round((n / 1048576) * 10) / 10) + ' MB';
      }

      // 路径中间省略: 保头保尾, 中间用省略号; 超过 max 才截断
      function middleEllipsis(s, max) {
        if (!s || s.length <= max) return s;
        var head = Math.max(3, Math.round(max * 0.42));
        var tail = Math.max(3, max - head - 1);
        return s.slice(0, head) + '…' + s.slice(s.length - tail);
      }

      // 复制文本到剪贴板(navigator.clipboard + 非安全上下文 execCommand 回退)
      function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(function () {});
          return true;
        }
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          return true;
        } catch (e) {
          return false;
        }
      }

      // 延迟收起(张顿一点): 鼠标离开后用 delay(ms) 宽限, 期间移回则取消。
      // keepOnFloatOnly=true(侧栏): 只有移到悬浮栏才豁免收起(与悬浮栏联动);
      //                =false(悬浮栏): 移到任意 fge 元素都豁免(避免悬浮栏关闭其源侧栏)。
      function useDampedHide(ms, onHide, keepOnFloatOnly) {
        var ref = React.useRef(null);
        function clear() {
          if (ref.current) {
            clearTimeout(ref.current);
            ref.current = null;
          }
        }
        function enter() {
          clear();
        }
        function leave(e) {
          var to = e && e.relatedTarget;
          if (to && to.closest) {
            var inFloat = to.closest('.fge-float');
            var inRoot = to.closest('[data-fge-root]');
            if (keepOnFloatOnly ? inFloat : inRoot) {
              clear();
              return;
            }
          }
          clear();
          ref.current = setTimeout(function () {
            ref.current = null;
            onHide();
          }, ms);
        }
        React.useEffect(function () {
          return function () {
            clear();
          };
        }, []);
        return { enter: enter, leave: leave };
      }

      // ---- 懒加载树(每个分区一棵) ----
      // props: mode, root, refreshTick, onFileClick(rel, name, type)
      function LazyTree(props) {
        var mode = props.mode;
        var root = props.root;
        var cacheState = React.useState({});
        var cache = cacheState[0];
        var setCache = cacheState[1];
        var expandedState = React.useState({});
        var expanded = expandedState[0];
        var setExpanded = expandedState[1];
        var selectedState = React.useState(null);
        var selected = selectedState[0];
        var setSelected = selectedState[1];
        var loadingState = React.useState(null);
        var loading = loadingState[0];
        var setLoading = loadingState[1];
        var mounted = React.useRef(true);

        var loadChildren = function (rel, reveal) {
          setLoading(rel);
          api('tree', { root: root, path: rel, mode: mode, reveal: reveal })
            .then(function (res) {
              if (!mounted.current) return;
              setLoading(null);
              if (!res || !res.ok || !Array.isArray(res.entries)) return;
              setCache(function (prev) {
                var next = {};
                for (var k in prev) next[k] = prev[k];
                next[rel] = res.entries;
                return next;
              });
            })
            .catch(function () {
              if (mounted.current) setLoading(null);
            });
        };

        React.useEffect(
          function () {
            mounted.current = true;
            setCache({});
            setExpanded({});
            setSelected(null);
            loadChildren('', false);
            return function () {
              mounted.current = false;
            };
          },
          // 根变化(工作区切换)时同样作废整棵树
          [props.refreshTick, root],
        );

        var revealFor = function (e) {
          if (mode === 'hidden') return e.dot === true;
          if (mode === 'ignored') return e.ignored === true;
          return false;
        };

        var toggle = function (e) {
          if (e.type !== 'dir') {
            setSelected(e.rel);
            props.onFileClick(e.rel, e.name, e.type);
            return;
          }
          if (expanded[e.rel]) {
            var next1 = {};
            for (var k1 in expanded) if (k1 !== e.rel) next1[k1] = true;
            setExpanded(next1);
            return;
          }
          var next2 = {};
          for (var k2 in expanded) next2[k2] = true;
          next2[e.rel] = true;
          setExpanded(next2);
          if (!cache[e.rel]) loadChildren(e.rel, revealFor(e));
        };

        // 深度优先展开 → 行列表
        var rows = [];
        (function walk(rel, depth) {
          var entries = cache[rel];
          if (!entries) return;
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            rows.push({
              rel: e.rel,
              name: e.name,
              type: e.type,
              depth: depth,
              dot: e.dot,
              ignored: e.ignored,
            });
            if (e.type === 'dir' && expanded[e.rel]) walk(e.rel, depth + 1);
          }
        })('', 0);

        var rootLoaded = cache[''] !== undefined;
        var children = React.createElement(
          'div',
          { className: 'fge-tree' },
          rows.map(function (row) {
            var icon = row.type === 'dir' ? (expanded[row.rel] ? '▾' : '▸') : '·';
            return React.createElement(
              'div',
              {
                key: row.rel,
                className:
                  'fge-node' +
                  (row.type === 'dir' ? ' fge-dir' : '') +
                  (selected === row.rel ? ' fge-selected' : ''),
                onClick: function () {
                  toggle(row);
                },
                style: { paddingLeft: 6 + row.depth * 14 },
                title: row.rel,
              },
              React.createElement('span', { className: 'fge-node-icon' }, icon),
              React.createElement('span', { className: 'fge-node-name' }, row.name),
            );
          }),
          loading !== null
            ? React.createElement('div', { className: 'fge-loading', key: 'loading' }, '加载中…')
            : null,
          rootLoaded && rows.length === 0
            ? React.createElement('div', { className: 'fge-empty', key: 'empty' }, '(空)')
            : null,
        );
        return children;
      }

      // ---- 图钉图标(无色线条版 📌, 跟随 currentColor) ----
      function PinIcon() {
        return React.createElement(
          'svg',
          {
            width: 14,
            height: 14,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            style: { display: 'block' },
          },
          // Lucide "pin": 钉帽 + 针
          React.createElement('path', {
            d: 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z',
          }),
        );
      }

      // ---- 箭头图标(圆角线条, 细条展开用) ----
      function ChevronIcon(props) {
        return React.createElement(
          'svg',
          {
            width: 14,
            height: 14,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            style: { display: 'block' },
          },
          React.createElement('path', {
            d: props.dir === 'left' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6',
          }),
        );
      }

      // ---- 刷新图标(⟳, 单色线条) ----
      function RefreshIcon() {
        return React.createElement(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { display: 'block' } },
          React.createElement('path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }),
          React.createElement('path', { d: 'M21 3v5h-5' }),
        );
      }

      // ---- 收起图标(» / «, 双箭头) ----
      function CollapseIcon(props) {
        var d =
          props.dir === 'left'
            ? ['M11 17l-5-5 5-5', 'M18 17l-5-5 5-5']
            : ['M6 17l5-5-5-5', 'M13 17l5-5-5-5'];
        return React.createElement(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { display: 'block' } },
          React.createElement('path', { d: d[0] }),
          React.createElement('path', { d: d[1] }),
        );
      }

      // ---- 关闭图标(✕) ----
      function CloseIcon() {
        return React.createElement(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { display: 'block' } },
          React.createElement('path', { d: 'M18 6L6 18M6 6l12 12' }),
        );
      }

      // ---- git 分支图标(竖着, 两根分支线) ----
      function BranchIcon() {
        return React.createElement(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { display: 'block' } },
          React.createElement('line', { x1: 6, y1: 3, x2: 6, y2: 15 }),
          React.createElement('circle', { cx: 18, cy: 6, r: 3 }),
          React.createElement('circle', { cx: 6, cy: 18, r: 3 }),
          React.createElement('path', { d: 'M18 9a9 9 0 0 1-9 9' }),
        );
      }

      // ---- 分支下拉展开指示(▾ / ▴) ----
      function CaretIcon(props) {
        return React.createElement(
          'svg',
          { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { display: 'block' } },
          React.createElement('path', { d: props.open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6' }),
        );
      }

      // ---- 左侧文件树面板 ----
      function LeftPanel(props) {
        var copiedState = React.useState(false);
        var copied = copiedState[0];
        var setCopied = copiedState[1];
        // 延迟收起: 悬停离开后宽限, 移到悬浮栏(打开的预览/diff)则豁免(联动)
        var damp = useDampedHide(360, props.onHide, true);
        // 路径按面板可用宽度做中间省略(保头保尾), 点击整段复制完整路径
        var subWidth = (props.style && props.style.width) || 320;
        var subMax = Math.max(12, Math.floor((subWidth - 104) / 5.6));
        var onCopyPath = function () {
          if (copyText(props.cwd)) {
            setCopied(true);
            setTimeout(function () {
              setCopied(false);
            }, 1200);
          }
        };
        return React.createElement(
          'div',
          {
            className: 'fge-panel',
            'data-fge-root': '1',
            style: props.style,
            onMouseEnter: damp.enter,
            onMouseLeave: damp.leave,
          },
          React.createElement(
            'div',
            { className: 'fge-panel-head' },
            React.createElement('span', { className: 'fge-panel-title' }, '文件'),
            React.createElement(
              'span',
              {
                className: 'fge-panel-sub' + (copied ? ' fge-copied' : ''),
                title: props.cwd,
                onClick: onCopyPath,
              },
              copied ? '✓ 已复制' : middleEllipsis(props.cwd, subMax),
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn' + (props.pin ? ' fge-btn-active' : ''),
                title: props.pin ? '已固定: 点击解除固定' : '图钉: 固定后两个面板都不能收起',
                onClick: props.onPin,
              },
              React.createElement(PinIcon, null),
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn',
                title: '刷新(重扫文件树与 git 状态)',
                onClick: props.onRefresh,
              },
              React.createElement(RefreshIcon, null),
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn',
                title: '收起为细条',
                onClick: props.onCollapse,
                disabled: props.pin,
              },
              React.createElement(CollapseIcon, { dir: 'right' }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'fge-section', style: { flex: '3' } },
            React.createElement('div', { className: 'fge-section-head' }, '可显示文件'),
            React.createElement(
              'div',
              { className: 'fge-section-body' },
              React.createElement(LazyTree, {
                mode: 'visible',
                root: props.root,
                refreshTick: props.refreshTick,
                onFileClick: props.onFileClick,
              }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'fge-section', style: { flex: '1' } },
            React.createElement('div', { className: 'fge-section-head' }, '隐藏文件'),
            React.createElement(
              'div',
              { className: 'fge-section-body' },
              React.createElement(LazyTree, {
                mode: 'hidden',
                root: props.root,
                refreshTick: props.refreshTick,
                onFileClick: props.onFileClick,
              }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'fge-section', style: { flex: '1' } },
            React.createElement('div', { className: 'fge-section-head' }, '忽略文件'),
            React.createElement(
              'div',
              { className: 'fge-section-body' },
              React.createElement(LazyTree, {
                mode: 'ignored',
                root: props.root,
                refreshTick: props.refreshTick,
                onFileClick: props.onFileClick,
              }),
            ),
          ),
          React.createElement('div', {
            className: 'fge-resize fge-resize-left',
            onPointerDown: props.onResizeStart,
          }),
        );
      }

      // ---- 右侧 git 树面板 ----
      function RightPanel(props) {
        var menuState = React.useState(false);
        var menuOpen = menuState[0];
        var setMenuOpen = menuState[1];
        var listRef = React.useRef(null);
        // 延迟收起: 悬停离开后宽限, 移到悬浮栏(branch menu 或 diff)则豁免(联动)
        var damp = useDampedHide(360, props.onHide, true);

        var changes = props.status && props.status.changes ? props.status.changes : [];
        var current = props.status ? props.status.current : null;

        React.useEffect(
          function () {
            if (!props.linkagePath) return;
            var container = listRef.current;
            if (!container) return;
            var target = null;
            var nodes = container.querySelectorAll('[data-fge-change]');
            for (var i = 0; i < nodes.length; i++) {
              if (nodes[i].getAttribute('data-fge-change') === props.linkagePath) {
                target = nodes[i];
                break;
              }
            }
            if (!target) return;
            target.scrollIntoView({ block: 'nearest' });
            target.classList.add('fge-flash');
            var onEnd = function () {
              target.classList.remove('fge-flash');
              target.removeEventListener('animationend', onEnd);
            };
            target.addEventListener('animationend', onEnd);
          },
          [props.linkagePath, props.status],
        );

        var localBranches = [];
        var remoteBranches = [];
        if (props.status && Array.isArray(props.status.branches)) {
          for (var b = 0; b < props.status.branches.length; b++) {
            var br = props.status.branches[b];
            if (br.remote) remoteBranches.push(br);
            else localBranches.push(br);
          }
        }

        var menu = null;
        if (menuOpen) {
          var group = function (title, list) {
            if (list.length === 0) return null;
            return React.createElement(
              React.Fragment,
              { key: title },
              React.createElement('div', { className: 'fge-branch-group' }, title),
              list.map(function (br) {
                var isCurrent = br.name === current;
                var isViewed = br.name === props.viewedBranch && !isCurrent;
                var mark = isCurrent ? '当前' : isViewed ? '上次查看' : '';
                return React.createElement(
                  'div',
                  {
                    key: br.ref,
                    className:
                      'fge-branch-item' +
                      (isCurrent ? ' fge-branch-current' : '') +
                      (isViewed ? ' fge-branch-viewed' : ''),
                    onClick: function () {
                      if (!isCurrent) props.onViewBranch(br.name);
                      setMenuOpen(false);
                    },
                    title: isCurrent ? '当前分支(只读, 不支持切换)' : '只读展示, 不做分支切换',
                  },
                  React.createElement('span', null, br.name),
                  React.createElement('span', { className: 'fge-branch-mark' }, mark),
                );
              }),
            );
          };
          menu = React.createElement(
            'div',
            { className: 'fge-branch-menu' },
            group('本地分支', localBranches),
            group('远程分支', remoteBranches),
          );
        }

        return React.createElement(
          'div',
          {
            className: 'fge-panel',
            'data-fge-root': '1',
            style: props.style,
            onMouseEnter: damp.enter,
            onMouseLeave: damp.leave,
          },
          React.createElement(
            'div',
            {
              className: 'fge-branch',
              onClick: function () {
                setMenuOpen(!menuOpen);
              },
              title: '点击显示所有分支(只读)',
            },
            React.createElement(BranchIcon, null),
            React.createElement(
              'span',
              { className: 'fge-branch-name' },
              current || '(detached)',
            ),
            React.createElement(CaretIcon, { open: menuOpen }),
          ),
          menu,
          React.createElement(
            'div',
            {
              className: 'fge-panel-head',
              style: { borderTop: '1px solid var(--dsw-alias-border-l1)', borderRadius: 0 },
            },
            React.createElement(
              'span',
              { className: 'fge-panel-title' },
              '变更 (' + changes.length + ')',
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn' + (props.pin ? ' fge-btn-active' : ''),
                title: props.pin ? '已固定: 点击解除固定' : '图钉: 固定后两个面板都不能收起',
                onClick: props.onPin,
              },
              React.createElement(PinIcon, null),
            ),
            React.createElement(
              'button',
              { className: 'fge-btn', title: '刷新 git 状态', onClick: props.onRefresh },
              React.createElement(RefreshIcon, null),
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn',
                title: '收起为细条',
                onClick: props.onCollapse,
                disabled: props.pin,
              },
              React.createElement(CollapseIcon, { dir: 'left' }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'fge-changes', ref: listRef },
            changes.length === 0
              ? React.createElement('div', { className: 'fge-empty' }, '(工作区干净)')
              : changes.map(function (ch) {
                  return React.createElement(
                    'div',
                    {
                      key: ch.path,
                      className:
                        'fge-change' + (props.selectedDiff === ch.path ? ' fge-selected' : ''),
                      'data-fge-change': ch.path,
                      onClick: function () {
                        props.onDiffClick(ch);
                      },
                      title: ch.from ? ch.path + ' (原 ' + ch.from + ')' : ch.path,
                    },
                    React.createElement(
                      'span',
                      { className: 'fge-badge fge-badge-' + ch.status },
                      ch.status,
                    ),
                    React.createElement('span', { className: 'fge-change-path' }, ch.path),
                  );
                }),
          ),
          React.createElement('div', {
            className: 'fge-resize fge-resize-right',
            onPointerDown: props.onResizeStart,
          }),
        );
      }

      // ---- 悬浮面板公共外壳(头部徽标 + 标题 + 关闭 + 内容区) ----
      function FloatPanel(props) {
        // 延迟收起(悬浮栏): 离开后宽限; 移到任一侧栏/细条/其他悬浮栏则豁免
        var damp = useDampedHide(360, props.onHide, false);
        return React.createElement(
          'div',
          {
            className: 'fge-float',
            'data-fge-root': '1',
            style: props.style,
            onMouseEnter: damp.enter,
            onMouseLeave: damp.leave,
          },
          React.createElement(
            'div',
            { className: 'fge-float-head' },
            props.badge === undefined
              ? null
              : React.createElement(
                  'span',
                  { className: 'fge-badge fge-badge-' + props.badge },
                  props.badge,
                ),
            React.createElement(
              'span',
              { className: 'fge-float-title', title: props.title },
              props.title,
            ),
            React.createElement(
              'button',
              { className: 'fge-btn', onClick: props.onClose, title: props.onCloseTitle || '关闭' },
              React.createElement(CloseIcon, null),
            ),
          ),
          React.createElement('div', { className: 'fge-float-body' }, props.children),
        );
      }

      // ---- 内容悬浮面板(左树文件 → 向右浮出, 可越对话区) ----
      function ContentPanel(props) {
        var dataState = React.useState(null);
        var data = dataState[0];
        var setData = dataState[1];
        var errState = React.useState(null);
        var err = errState[0];
        var setErr = errState[1];

        React.useEffect(
          function () {
            var alive = true;
            setData(null);
            setErr(null);
            api('file', { root: props.root, path: props.rel })
              .then(function (res) {
                if (!alive) return;
                if (res && res.ok) setData(res);
                else setErr((res && res.error) || 'failed');
              })
              .catch(function () {
                if (alive) setErr('rpc-failed');
              });
            return function () {
              alive = false;
            };
          },
          [props.root, props.rel],
        );

        var body = null;
        if (err !== null) {
          body = React.createElement('div', { className: 'fge-note' }, '读取失败: ' + err);
        } else if (data === null) {
          body = React.createElement('div', { className: 'fge-note' }, '加载中…');
        } else if (data.binary) {
          body = React.createElement(
            'div',
            { className: 'fge-note' },
            '二进制文件(' + formatBytes(data.size) + '), 不预览',
          );
        } else if (data.truncated) {
          body = React.createElement(
            'div',
            { className: 'fge-note' },
            '文件超过 1 MiB(' + formatBytes(data.size) + '), 不预览',
          );
        } else {
          body = React.createElement('pre', {
            className: 'fge-pre',
            dangerouslySetInnerHTML: { __html: highlightToHtml(data.text, true) },
          });
        }

        return React.createElement(
          FloatPanel,
          {
            style: props.style,
            title: props.rel,
            onClose: props.onClose,
            onHide: props.onHide,
          },
          body,
        );
      }

      // ---- diff 悬浮面板(右树变更 → 向左浮出) ----
      function DiffPanel(props) {
        var dataState = React.useState(null);
        var data = dataState[0];
        var setData = dataState[1];
        var errState = React.useState(null);
        var err = errState[0];
        var setErr = errState[1];

        React.useEffect(
          function () {
            var alive = true;
            setData(null);
            setErr(null);
            api('diff', {
              root: props.root,
              repoRoot: props.repoRoot,
              path: props.change.path,
              status: props.change.status,
              from: props.change.from,
            })
              .then(function (res) {
                if (!alive) return;
                if (res && res.ok) setData(res);
                else setErr((res && res.error) || 'failed');
              })
              .catch(function () {
                if (alive) setErr('rpc-failed');
              });
            return function () {
              alive = false;
            };
          },
          [props.change.path],
        );

        var body = null;
        if (err !== null) {
          body = React.createElement('div', { className: 'fge-note' }, '读取失败: ' + err);
        } else if (data === null) {
          body = React.createElement('div', { className: 'fge-note' }, '加载中…');
        } else if (data.kind === 'diff') {
          if (data.text === '')
            body = React.createElement('div', { className: 'fge-note' }, '(无差异)');
          else
            body = React.createElement('pre', {
              className: 'fge-pre',
              dangerouslySetInnerHTML: { __html: diffToHtml(data.text) },
            });
        } else if (data.binary) {
          body = React.createElement(
            'div',
            { className: 'fge-note' },
            '二进制文件(' + formatBytes(data.size) + '), 不预览',
          );
        } else if (data.truncated) {
          body = React.createElement(
            'div',
            { className: 'fge-note' },
            '文件超过 1 MiB(' + formatBytes(data.size) + '), 不预览',
          );
        } else {
          body = React.createElement('pre', {
            className: 'fge-pre',
            dangerouslySetInnerHTML: { __html: highlightToHtml(data.text, true) },
          });
        }

        var head = null; // 徽标由 FloatPanel 的 badge 提供
        return React.createElement(
          FloatPanel,
          {
            style: props.style,
            badge: props.change.status,
            title: props.change.path,
            onClose: props.onClose,
            onHide: props.onHide,
          },
          body,
        );
      }

      // ---- 细条(收起态): 只剩一个圆角箭头, 无边框底色; 悬停自动展开 ----
      function Strip(props) {
        return React.createElement(
          'div',
          {
            className: 'fge-strip',
            'data-fge-root': '1',
            style: props.style,
            onMouseEnter: props.onExpand,
            onClick: props.onExpand,
            title: props.title,
          },
          React.createElement(ChevronIcon, { dir: props.dir }),
        );
      }

      // ---- 根组件 ----
      function FgeRoot(props) {
        var geo = useGeometry();

        // 当前会话 cwd: shell.overlay 标准 prop 提供 useSessions, 跟随工作区切换。
        // 会话没有 cwd(如 hero 空态)时回退 info.cwd(DSH 进程 cwd)。
        var useSessions = props.useSessions;
        var sessionCwd = null;
        if (typeof useSessions === 'function') {
          sessionCwd = useSessions(function (s) {
            if (!s || !s.current) return null;
            var sess = s.byId && s.byId[s.current];
            return sess && typeof sess.cwd === 'string' && sess.cwd !== '' ? sess.cwd : null;
          });
        }

        var infoState = React.useState(null);
        var info = infoState[0];
        var setInfo = infoState[1];
        var statusState = React.useState(null);
        var status = statusState[0];
        var setStatus = statusState[1];
        var pinState = React.useState(false);
        var pin = pinState[0];
        var setPin = pinState[1];
        var leftOpenState = React.useState(false);
        var leftOpen = leftOpenState[0];
        var setLeftOpen = leftOpenState[1];
        var rightOpenState = React.useState(false);
        var rightOpen = rightOpenState[0];
        var setRightOpen = rightOpenState[1];
        var leftWState = React.useState(400);
        var leftW = leftWState[0];
        var setLeftW = leftWState[1];
        var rightWState = React.useState(400);
        var rightW = rightWState[0];
        var setRightW = rightWState[1];
        var viewedBranchState = React.useState(null);
        var viewedBranch = viewedBranchState[0];
        var setViewedBranch = viewedBranchState[1];
        var contentState = React.useState(null);
        var content = contentState[0];
        var setContent = contentState[1];
        var diffState = React.useState(null);
        var diff = diffState[0];
        var setDiff = diffState[1];
        var linkageState = React.useState(null);
        var linkage = linkageState[0];
        var setLinkage = linkageState[1];
        var refreshTickState = React.useState(0);
        var refreshTick = refreshTickState[0];
        var setRefreshTick = refreshTickState[1];

        var cacheKey = info ? info.repoRoot || info.cwd : null;
        var root = sessionCwd || (info ? info.cwd : null);

        // 根切换时关闭悬浮面板与联动
        React.useEffect(
          function () {
            setContent(null);
            setDiff(null);
            setLinkage(null);
          },
          [root],
        );

        // info 跟随当前根: 根变化(会话/工作区切换)时重查仓库根与分支
        React.useEffect(
          function () {
            var alive = true;
            var req = root ? { root: root } : {};
            api('info', req)
              .then(function (res) {
                if (!alive || !res || !res.ok) return;
                setInfo(res);
              })
              .catch(function () {});
            return function () {
              alive = false;
            };
          },
          [root],
        );

        // status 跟随当前仓库根; 切回同一仓库时恢复 cwd 缓存(UI 状态)
        React.useEffect(
          function () {
            if (!info || !info.repoRoot) return;
            var alive = true;
            api('status', { root: info.cwd, repoRoot: info.repoRoot })
              .then(function (st) {
                if (!alive || !st || !st.ok) return;
                setStatus(st);
                var cached = readCache(info.repoRoot);
                if (cached) {
                  if (typeof cached.leftW === 'number') setLeftW(cached.leftW);
                  if (typeof cached.rightW === 'number') setRightW(cached.rightW);
                  if (typeof cached.leftOpen === 'boolean') setLeftOpen(cached.leftOpen);
                  if (typeof cached.rightOpen === 'boolean') setRightOpen(cached.rightOpen);
                  if (typeof cached.viewedBranch === 'string') setViewedBranch(cached.viewedBranch);
                }
              })
              .catch(function () {});
            return function () {
              alive = false;
            };
          },
          [root, info ? info.repoRoot : null],
        );

        // 持久化 cwd 缓存
        React.useEffect(
          function () {
            if (!cacheKey) return;
            writeCache(cacheKey, {
              leftW: leftW,
              rightW: rightW,
              leftOpen: leftOpen,
              rightOpen: rightOpen,
              viewedBranch: viewedBranch,
            });
          },
          [cacheKey, leftW, rightW, leftOpen, rightOpen, viewedBranch],
        );

        // 刷新: 重读 info + status, 树缓存作废
        var refresh = React.useCallback(
          function () {
            var req = root ? { root: root } : {};
            api('info', req)
              .then(function (res) {
                if (!res || !res.ok) return;
                setInfo(res);
                setRefreshTick(function (t) {
                  return t + 1;
                });
                if (res.repoRoot) {
                  api('status', { root: res.cwd, repoRoot: res.repoRoot })
                    .then(function (st) {
                      if (st && st.ok) setStatus(st);
                    })
                    .catch(function () {});
                }
              })
              .catch(function () {});
          },
          [root],
        );

        // 悬停交互: 面板由「鼠标悬停细条展开 / 鼠标离开面板收起」驱动,
        // 未固定时鼠标离开面板即自动收起为细条; 固定时保持展开。
        // 不再用「点击面板外收起」, 避免鼠标落在细条上时反复展开/收起。

        // Escape 关闭悬浮面板
        React.useEffect(function () {
          function onKey(e) {
            if (e.key === 'Escape') {
              setContent(null);
              setDiff(null);
            }
          }
          window.addEventListener('keydown', onKey);
          return function () {
            window.removeEventListener('keydown', onKey);
          };
        }, []);

        // 悬浮面板重叠时, 后点开的盖住先点开的(依赖 DOM 顺序, 无需排序)

        var onFileClick = React.useCallback(
          function (rel, name, type) {
            if (type === 'dir') return;
            // 再点同一文件 = 关闭内容面板(纯函数式判断, 不依赖 updater 副作用)
            if (content !== null && content.rel === rel) {
              setContent(null);
              setLinkage(null);
              return;
            }
            setContent({ rel: rel, name: name });
            // 联动: 右侧有该文件 diff 则定位高亮。
            // 左树 rel 是 cwd 相对, 变更列表的 cwdRel 同基准(仓库根≠cwd 时也能匹配);
            // 定位目标用仓库根相对的 path(与 data-fge-change 键一致)。
            var foundPath = null;
            if (status && Array.isArray(status.changes)) {
              for (var i = 0; i < status.changes.length; i++) {
                var ch = status.changes[i];
                if ((ch.cwdRel || ch.path) === rel) {
                  foundPath = ch.path;
                  break;
                }
              }
            }
            setLinkage(foundPath);
          },
          [status, content],
        );

        var onDiffClick = React.useCallback(function (ch) {
          setDiff(function (prev) {
            if (prev && prev.change.path === ch.path) return null;
            return { change: ch };
          });
        }, []);

        // 图钉: 无论点哪个面板的图钉, 动作一致 —— 固定时两个面板都展开为卡片。
        // 避免出现「已固定但另一侧仍是细条」的不一致状态。
        var togglePin = React.useCallback(function () {
          var next = !pin;
          setPin(next);
          if (next) {
            setLeftOpen(true);
            setRightOpen(true);
          }
        }, [pin]);

        // 收起某侧(悬停离开延迟触发 / 收起按钮): 一并关闭该侧关联的悬浮面板,
        // 避免「侧栏收了、悬浮栏还在」的孤儿状态(联动)。
        var hideLeft = React.useCallback(function () {
          if (!pin) {
            setLeftOpen(false);
            setContent(null);
          }
        }, [pin]);
        var hideRight = React.useCallback(function () {
          if (!pin) {
            setRightOpen(false);
            setDiff(null);
          }
        }, [pin]);

        // 布局计算
        // 可显示仍看「完整留白能容纳最小宽度」; 最大宽度 = 完整留白的 2/3(减少 1/3),
        // 面板拖不到对话区边缘, 留出更从容的留白。
        var leftGutterW = geo ? Math.max(0, geo.convLeft - geo.sbLeft - 24) : 0;
        var rightGutterW = geo ? Math.max(0, geo.sbRight - geo.convRight - 24) : 0;
        // 面板最小宽度 250px: 保证头部工具栏(图钉/刷新/收起)不被吞掉。
        var MIN_W = 250;
        var leftCanShow = leftGutterW >= MIN_W;
        var rightCanShow = rightGutterW >= MIN_W;
        var leftMaxW = leftCanShow ? Math.max(MIN_W, Math.floor(leftGutterW * (2 / 3))) : 0;
        var rightMaxW = rightCanShow ? Math.max(MIN_W, Math.floor(rightGutterW * (2 / 3))) : 0;
        var leftWidth = leftCanShow ? clamp(leftW, MIN_W, leftMaxW) : 0;
        var rightWidth = rightCanShow ? clamp(rightW, MIN_W, rightMaxW) : 0;
        var leftShow = leftOpen && leftCanShow;
        var rightShow = rightOpen && rightCanShow;

        // 拉伸
        var resize = function (side) {
          return function (ev) {
            ev.preventDefault();
            var startX = ev.clientX;
            var startW = side === 'left' ? leftWidth : rightWidth;
            function onMove(e) {
              if (side === 'left') {
                var w = startW + (e.clientX - startX);
                setLeftW(clamp(w, MIN_W, leftMaxW));
              } else {
                var w2 = startW - (e.clientX - startX);
                setRightW(clamp(w2, MIN_W, rightMaxW));
              }
            }
            function onUp() {
              window.removeEventListener('pointermove', onMove);
              window.removeEventListener('pointerup', onUp);
            }
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
          };
        };

        if (!geo || !info) return null;
        // 垂直带太矮(<74px)时不再渲染, 避免出现贴边的细长条。
        if (geo.height < 74) return null;

        // 垂直: 居中 + 对称留白, 高度上限 ≈ 屏幕高度的 85% —— 不贴满整个对话列。
        //   vMargin = 上下最小留白(对称); maxH = 面板高度上限(0.85 * 视口高)。
        //   高度 = min(列高 - 2*留白, 上限), 并在列内垂直居中。
        var colH = geo.height;
        var vMargin = 20;
        var maxH = Math.floor(window.innerHeight * 0.85);
        var panelH = Math.max(0, Math.min(colH - vMargin * 2, maxH));
        var top = geo.top + Math.max(vMargin, (colH - panelH) / 2);
        var height = panelH;
        var stripW = 26;
        var leftPanelStyle = {
          left: geo.sbLeft + 8,
          top: top,
          width: leftWidth,
          height: height,
        };
        var rightPanelStyle = {
          left: geo.sbRight - 8 - rightWidth,
          top: top,
          width: rightWidth,
          height: height,
        };
        var leftStripStyle = {
          left: geo.sbLeft + 8,
          top: top,
          width: stripW,
          height: height,
        };
        var rightStripStyle = {
          left: geo.sbRight - 8 - stripW,
          top: top,
          width: stripW,
          height: height,
        };

        var leftAnchor = geo.sbLeft + 8 + (leftShow ? leftWidth : stripW);
        var rightAnchor = geo.sbRight - 8 - (rightShow ? rightWidth : stripW);
        // 文件内容浮窗宽度 = 原值的 4/3(560→746); diff 浮窗保持原宽。
        var diffW = Math.min(560, Math.max(320, geo.sbRight - geo.sbLeft - 60));
        var contentW = Math.min(746, Math.max(426, geo.sbRight - geo.sbLeft - 60));
        var contentStyle = {
          left: Math.min(leftAnchor + 10, geo.convRight - 40),
          top: top,
          width: contentW,
          height: height,
        };
        var diffStyle = {
          left: Math.max(geo.convLeft + 40, rightAnchor - 10 - diffW),
          top: top,
          width: diffW,
          height: height,
        };

        return React.createElement(
          'div',
          { className: 'fge-wrap' },
          leftShow
            ? React.createElement(LeftPanel, {
                style: leftPanelStyle,
                cwd: info.cwd,
                root: root,
                pin: pin,
                onPin: togglePin,
                onRefresh: refresh,
                onCollapse: hideLeft,
                onHide: hideLeft,
                onResizeStart: resize('left'),
                refreshTick: refreshTick,
                onFileClick: onFileClick,
              })
            : leftCanShow
              ? React.createElement(Strip, {
                  style: leftStripStyle,
                  dir: 'right',
                  title: '展开文件树',
                  onExpand: function () {
                    setLeftOpen(true);
                  },
                })
              : null,
          rightShow
            ? React.createElement(RightPanel, {
                style: rightPanelStyle,
                status: status,
                repoRoot: info.repoRoot,
                pin: pin,
                onPin: togglePin,
                onRefresh: refresh,
                onCollapse: hideRight,
                onHide: hideRight,
                onResizeStart: resize('right'),
                viewedBranch: viewedBranch,
                onViewBranch: setViewedBranch,
                linkagePath: linkage,
                onDiffClick: onDiffClick,
                selectedDiff: diff ? diff.change.path : null,
              })
            : rightCanShow
              ? React.createElement(Strip, {
                  style: rightStripStyle,
                  dir: 'left',
                  title: '展开 Git 树',
                  onExpand: function () {
                    setRightOpen(true);
                  },
                })
              : null,
          content
            ? React.createElement(ContentPanel, {
                style: contentStyle,
                root: root,
                rel: content.rel,
                onClose: function () {
                  setContent(null);
                },
                onHide: hideLeft,
              })
            : null,
          diff
            ? React.createElement(DiffPanel, {
                style: diffStyle,
                root: root,
                change: diff.change,
                repoRoot: info.repoRoot,
                onClose: function () {
                  setDiff(null);
                },
                onHide: hideRight,
              })
            : null,
        );
      }

      slots.inject('shell.overlay', function () {
        return slots.register(
          // 独立 cell, 不替换任何 shipped entry。
          { name: 'shell.overlay', id: 'file-git-explorer', order: 100 },
          FgeRoot,
        );
      });
    };

    return module.exports;
  },
});
