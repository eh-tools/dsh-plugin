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
        'background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;' +
        'box-shadow:var(--dsw-shadow-lv2,rgba(0,0,0,.18)) 0 6px 24px;color:var(--dsw-alias-label-primary);' +
        'font-size:12px;line-height:1.45;z-index:30;}' +
        '.fge-strip{position:fixed;pointer-events:auto;display:flex;align-items:center;justify-content:center;' +
        'background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;' +
        'box-shadow:var(--dsw-shadow-lv2,rgba(0,0,0,.18)) 0 4px 14px;color:var(--dsw-alias-label-secondary);' +
        'cursor:pointer;z-index:30;}' +
        '.fge-strip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}' +
        '.fge-panel-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);' +
        'flex:none;color:var(--dsw-alias-label-primary);font-weight:600;}' +
        '.fge-panel-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.fge-panel-sub{flex:none;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-weight:400;' +
        'font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;}' +
        '.fge-btn{flex:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);' +
        'border-radius:6px;padding:2px 6px;font-size:12px;cursor:pointer;line-height:1.4;}' +
        '.fge-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}' +
        '.fge-btn:disabled{opacity:.35;cursor:not-allowed;}' +
        '.fge-btn-active{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);}' +
        '.fge-section{display:flex;flex-direction:column;min-height:0;}' +
        '.fge-section-head{flex:none;padding:3px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));' +
        'border-top:1px solid var(--dsw-alias-border-l1);}' +
        '.fge-section-body{flex:1;overflow:auto;min-height:0;padding:2px 0;}' +
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
        '.fge-branch-menu{position:absolute;left:6px;right:6px;top:30px;z-index:40;background:var(--dsw-alias-bg-overlay);' +
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
        '.fge-changes{flex:1;overflow:auto;min-height:0;padding:2px 0;}' +
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
        'font-size:12px;overflow:hidden;z-index:40;}' +
        '.fge-float-head{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;}' +
        '.fge-float-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}' +
        '.fge-float-body{flex:1;overflow:auto;min-height:0;padding:8px 10px;}' +
        '.fge-pre{margin:0;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre;' +
        'color:var(--dsw-alias-label-primary);}' +
        '.fge-ln{display:inline-block;width:3ch;text-align:right;margin-right:10px;user-select:none;' +
        'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}' +
        '.fge-note{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));padding:8px;font-size:11px;}' +
        '.fge-tok-kw{color:var(--dsw-alias-brand-primary);}' +
        '.fge-tok-str{color:var(--dsw-alias-state-success-primary);}' +
        '.fge-tok-cmt{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-style:italic;}' +
        '.fge-tok-num{color:var(--dsw-alias-state-warn-primary);}' +
        '.fge-diff-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-label-primary);}' +
        '.fge-diff-del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-label-primary);}' +
        '.fge-diff-hunk{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);}' +
        '.fge-diff-meta{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}' +
        '.fge-resize{position:absolute;top:0;bottom:0;width:6px;cursor:col-resize;z-index:35;}' +
        '.fge-resize:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 25%,transparent);}' +
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
      // bottom= [data-composer-card] 底部
      // left/right = 对话滚动容器左右缘(自动跟随应用侧边栏折叠与 details 列)
      // 对话列宽 = --dsh-chat-content-width(定义在会话根, 滚动容器可继承)
      function measureGeometry() {
        var scrollBody = document.querySelector('[data-conversation-scroll]');
        if (!scrollBody) return null;
        var composer = document.querySelector('[data-composer-card="true"]');
        var rect = scrollBody.getBoundingClientRect();
        var top = rect.top;
        var bottom = composer ? composer.getBoundingClientRect().bottom : window.innerHeight;
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
      (function () {
        var words = (
          'const let var function return if else for while do switch case break continue new class extends ' +
          'import export from default async await try catch finally throw typeof instanceof in of this null true false ' +
          'undefined def lambda fn pub struct enum impl trait type interface namespace package public private protected ' +
          'static readonly yield delete void super get set as is where None True False self cls print require module ' +
          'exports describe it test expect and or not def match use move borrow loop match async mut ref fn'
        ).split(' ');
        for (var i = 0; i < words.length; i++) KEYWORD_SET[words[i]] = true;
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
            segs.push({ t: KEYWORD_SET[word] ? 'kw' : 'plain', v: word });
            i += word.length;
            continue;
          }
          var rest = line.slice(i, i + 4);
          segs.push({ t: 'plain', v: rest });
          i += rest.length;
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
          else if (line.slice(0, 1) === '+') cls = 'fge-diff-add';
          else if (line.slice(0, 1) === '-') cls = 'fge-diff-del';
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
            line.slice(0, 13) === 'new mode 100'
          )
            cls = 'fge-diff-meta';
          else if (line.slice(0, 13) === 'Binary files ') cls = 'fge-diff-meta';
          if (cls === '') html += escapeHtml(line);
          else html += '<span class="' + cls + '">' + escapeHtml(line) + '</span>';
          if (i < lines.length - 1) html += '\n';
        }
        return html;
      }

      function formatBytes(n) {
        if (n < 1024) return String(n) + ' B';
        if (n < 1048576) return String(Math.round((n / 1024) * 10) / 10) + ' KB';
        return String(Math.round((n / 1048576) * 10) / 10) + ' MB';
      }

      // ---- 懒加载树(每个分区一棵) ----
      // props: mode, refreshTick, onFileClick(rel, name, type)
      function LazyTree(props) {
        var mode = props.mode;
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
          api('tree', { path: rel, mode: mode, reveal: reveal })
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
          [props.refreshTick],
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

      // ---- 左侧文件树面板 ----
      function LeftPanel(props) {
        return React.createElement(
          'div',
          { className: 'fge-panel', 'data-fge-root': '1', style: props.style },
          React.createElement(
            'div',
            { className: 'fge-panel-head' },
            React.createElement('span', { className: 'fge-panel-title' }, '文件'),
            React.createElement(
              'span',
              { className: 'fge-panel-sub', title: props.cwd },
              props.cwd,
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn' + (props.pin ? ' fge-btn-active' : ''),
                title: props.pin ? '已固定: 点击解除固定' : '图钉: 固定后两个面板都不能收起',
                onClick: props.onPin,
              },
              '📌',
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn',
                title: '刷新(重扫文件树与 git 状态)',
                onClick: props.onRefresh,
              },
              '⟳',
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn',
                title: '收起为细条',
                onClick: props.onCollapse,
                disabled: props.pin,
              },
              '»',
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
          { className: 'fge-panel', 'data-fge-root': '1', style: props.style },
          React.createElement(
            'div',
            {
              className: 'fge-branch',
              onClick: function () {
                setMenuOpen(!menuOpen);
              },
              title: '点击显示所有分支(只读)',
            },
            React.createElement(
              'span',
              { className: 'fge-branch-name' },
              '⎇ ' + (current || '(detached)'),
            ),
            React.createElement('span', { className: 'fge-branch-caret' }, menuOpen ? '▴' : '▾'),
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
              '📌',
            ),
            React.createElement(
              'button',
              { className: 'fge-btn', title: '刷新 git 状态', onClick: props.onRefresh },
              '⟳',
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn',
                title: '收起为细条',
                onClick: props.onCollapse,
                disabled: props.pin,
              },
              '«',
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
        return React.createElement(
          'div',
          { className: 'fge-float', 'data-fge-root': '1', style: props.style },
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
            React.createElement('button', { className: 'fge-btn', onClick: props.onClose }, '✕'),
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
            api('file', { path: props.rel })
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
          [props.rel],
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
          },
          body,
        );
      }

      // ---- 细条(收起态) ----
      function Strip(props) {
        return React.createElement(
          'div',
          {
            className: 'fge-strip',
            'data-fge-root': '1',
            style: props.style,
            onClick: props.onExpand,
            title: props.title,
          },
          React.createElement('span', null, props.open ? '«' : props.icon),
        );
      }

      // ---- 根组件 ----
      function FgeRoot() {
        var geo = useGeometry();

        var infoState = React.useState(null);
        var info = infoState[0];
        var setInfo = infoState[1];
        var statusState = React.useState(null);
        var status = statusState[0];
        var setStatus = statusState[1];
        var pinState = React.useState(false);
        var pin = pinState[0];
        var setPin = pinState[1];
        var leftOpenState = React.useState(true);
        var leftOpen = leftOpenState[0];
        var setLeftOpen = leftOpenState[1];
        var rightOpenState = React.useState(true);
        var rightOpen = rightOpenState[0];
        var setRightOpen = rightOpenState[1];
        var leftWState = React.useState(320);
        var leftW = leftWState[0];
        var setLeftW = leftWState[1];
        var rightWState = React.useState(320);
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

        // 初次加载 info + status + 恢复 cwd 缓存
        React.useEffect(function () {
          var alive = true;
          api('info', {})
            .then(function (res) {
              if (!alive || !res || !res.ok) return;
              setInfo(res);
              if (res.repoRoot) {
                var cached = readCache(res.repoRoot);
                if (cached) {
                  if (typeof cached.leftW === 'number') setLeftW(cached.leftW);
                  if (typeof cached.rightW === 'number') setRightW(cached.rightW);
                  if (typeof cached.leftOpen === 'boolean') setLeftOpen(cached.leftOpen);
                  if (typeof cached.rightOpen === 'boolean') setRightOpen(cached.rightOpen);
                  if (typeof cached.viewedBranch === 'string') setViewedBranch(cached.viewedBranch);
                }
                api('status', { repoRoot: res.repoRoot })
                  .then(function (st) {
                    if (alive && st && st.ok) setStatus(st);
                  })
                  .catch(function () {});
              }
            })
            .catch(function () {});
          return function () {
            alive = false;
          };
        }, []);

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
        var refresh = React.useCallback(function () {
          api('info', {})
            .then(function (res) {
              if (!res || !res.ok) return;
              setInfo(res);
              setRefreshTick(function (t) {
                return t + 1;
              });
              if (res.repoRoot) {
                api('status', { repoRoot: res.repoRoot })
                  .then(function (st) {
                    if (st && st.ok) setStatus(st);
                  })
                  .catch(function () {});
              }
            })
            .catch(function () {});
        }, []);

        // 未固定时点击面板外 → 全部收起为细条
        React.useEffect(
          function () {
            function onDown(e) {
              if (pin) return;
              var t = e.target;
              if (!t || !t.closest || t.closest('[data-fge-root]')) return;
              setLeftOpen(false);
              setRightOpen(false);
            }
            document.addEventListener('pointerdown', onDown, true);
            return function () {
              document.removeEventListener('pointerdown', onDown, true);
            };
          },
          [pin],
        );

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

        var togglePin = React.useCallback(function () {
          setPin(function (p) {
            return !p;
          });
        }, []);

        // 布局计算
        var leftMaxW = geo ? Math.max(0, geo.convLeft - geo.sbLeft - 24) : 0;
        var rightMaxW = geo ? Math.max(0, geo.sbRight - geo.convRight - 24) : 0;
        var leftWidth = leftMaxW >= 140 ? clamp(leftW, 140, leftMaxW) : 0;
        var rightWidth = rightMaxW >= 140 ? clamp(rightW, 140, rightMaxW) : 0;
        var leftCanShow = leftMaxW >= 140;
        var rightCanShow = rightMaxW >= 140;
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
                setLeftW(clamp(w, 140, leftMaxW));
              } else {
                var w2 = startW - (e.clientX - startX);
                setRightW(clamp(w2, 140, rightMaxW));
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
        // 垂直带太矮(<68px)时不再渲染, 保证底边永不越过 composer card 下边框。
        if (geo.height < 68) return null;

        var top = geo.top + 4;
        var height = geo.height - 8;
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
        var floatW = Math.min(560, Math.max(320, geo.sbRight - geo.sbLeft - 60));
        var contentStyle = {
          left: Math.min(leftAnchor + 10, geo.convRight - 40),
          top: top,
          width: floatW,
          height: height,
        };
        var diffStyle = {
          left: Math.max(geo.convLeft + 40, rightAnchor - 10 - floatW),
          top: top,
          width: floatW,
          height: height,
        };

        return React.createElement(
          'div',
          { className: 'fge-wrap' },
          leftShow
            ? React.createElement(LeftPanel, {
                style: leftPanelStyle,
                cwd: info.cwd,
                pin: pin,
                onPin: togglePin,
                onRefresh: refresh,
                onCollapse: function () {
                  setLeftOpen(false);
                },
                onResizeStart: resize('left'),
                refreshTick: refreshTick,
                onFileClick: onFileClick,
              })
            : React.createElement(Strip, {
                style: leftStripStyle,
                icon: '▸',
                title: '展开文件树',
                onExpand: function () {
                  setLeftOpen(true);
                },
              }),
          rightShow
            ? React.createElement(RightPanel, {
                style: rightPanelStyle,
                status: status,
                repoRoot: info.repoRoot,
                pin: pin,
                onPin: togglePin,
                onRefresh: refresh,
                onCollapse: function () {
                  setRightOpen(false);
                },
                onResizeStart: resize('right'),
                viewedBranch: viewedBranch,
                onViewBranch: setViewedBranch,
                linkagePath: linkage,
                onDiffClick: onDiffClick,
                selectedDiff: diff ? diff.change.path : null,
              })
            : React.createElement(Strip, {
                style: rightStripStyle,
                icon: '◂',
                title: '展开 Git 树',
                onExpand: function () {
                  setRightOpen(true);
                },
              }),
          content
            ? React.createElement(ContentPanel, {
                style: contentStyle,
                rel: content.rel,
                onClose: function () {
                  setContent(null);
                },
              })
            : null,
          diff
            ? React.createElement(DiffPanel, {
                style: diffStyle,
                change: diff.change,
                repoRoot: info.repoRoot,
                onClose: function () {
                  setDiff(null);
                },
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
