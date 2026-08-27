// dsh-db-console — client half(静态浏览器 bundle)
//
// 与动态插件 client 半的差异: React 经 require('react') 解析(loader 种子模块),
// host 通信走 fetch('/dbc/api/<method>'), 样式手动 <style> 注入。
// 槽位注册 API(slots.inject / slots.register)与动态完全一致 —— 本插件向
// conversation.view 注册第三个视图(id database, 排轨迹之后)。
//
// UI 结构:
//   ├─ 登录态: 项目连接卡片(打码链接/测试/保存并连接/删除二次确认)
//   ├─ 已连接: 头部(库摘要 + ⟳schema + 断开 + 修改)
//   │    ├─ 左栏 schema 树(schema → 表 → 列, 点击表名插入编辑器)
//   │    ├─ SQL 编辑器(textarea + 高亮 underlay + 三级补全弹层)
//   │    └─ 结果区(多语句分段网格; 500 行截断; 单元格点击复制)
//   └─ 快捷键: Ctrl/Cmd+Enter 执行
window.__ModuleLoader__.load({
  id: 'dsh-db-console',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    // 官方 UI 原语(Button/Input 等): 样式随壳层全局样式表已就位, 直接可用
    var UI = require('@deepseek-ai/dsh-client-ui-primitives');
    var Btn = UI.Button;
    var Input = UI.Input;

    exports.name = 'dsh-db-console';
    exports.inject = ['slots'];
    exports.apply = function (ctx) {
      var slots = ctx.slots;

      // 样式注入: 插件挂载即注入(幂等); 视图组件内还会再守一道
      ensureStyles();

      // ---- 与 host 通信 ----
      // 诊断开关: URL 带 ?dbcdebug=1 时向控制台输出关键链路
      var DBG = /[?&]dbcdebug=1/.test(window.location.search);
      function dbg() {
        if (!DBG) return;
        var args = ['[dbc]'].concat(Array.prototype.slice.call(arguments));
        console.log.apply(console, args);
      }
      function api(method, body) {
        return fetch('/dbc/api/' + method, {
          method: 'POST',
          headers: { 'x-dsh-plugin': '1', 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        }).then(function (res) {
          if (!res.ok) throw new Error('http ' + String(res.status));
          return res.json();
        });
      }

      // ---- 样式 ----
      // ---- 样式(原生口径) ----
      // 全部使用壳层设计代币(body 别名层随明暗主题自动翻转); 结构对齐轨迹视图:
      // 平铺满高 bg-layer-1 + 32px 级工具栏细条 + 官方表格配方; 主色是
      // state-business-primary(#4176e6/#679efe), 不再自造品牌蓝。
      // 编辑区回声 composer 卡片(specific-input-major + l2-darkmode-thin 边 + lv2 影)。
      var STYLE_CSS =
        // 根容器
        // 左右内缩跟随 --dsh-fge-strip-clear-* (file-git-explorer 广播的细条
        // 净空), 避免页面边缘落在细条悬停展开区内; fge 不在时变量缺省为 0。
        '.dbc-root{height:100%;min-height:320px;display:flex;flex-direction:column;' +
        'padding-left:var(--dsh-fge-strip-clear-l,0px);' +
        'padding-right:var(--dsh-fge-strip-clear-r,0px);box-sizing:border-box;' +
        'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);' +
        'font-family:var(--dsw-font-family);overflow:hidden;position:relative;}' +
        '.dbc-center{margin:auto;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-caption);}' +
        // 工具栏(轨迹同款细条)
        '.dbc-toolbar{flex:none;height:36px;display:flex;align-items:center;gap:6px;padding:0 6px;' +
        'border-bottom:1px solid var(--dsw-alias-border-l2);}' +
        '.dbc-title{flex:none;padding:0 6px;font:600 var(--dsw-font-s-14);}' +
        '.dbc-meta{font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;' +
        'color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52%;}' +
        '.dbc-spacer{flex:1;}' +
        // 轨迹同款小动作按钮(_toggle/_action 配方)
        '.dbc-tbtn{display:inline-flex;align-items:center;height:20px;padding:0 7px;border:0;' +
        'border-radius:3px;background:none;color:var(--dsw-alias-label-tertiary);' +
        'font:var(--dsw-font-xxs-12);cursor:pointer;white-space:nowrap;' +
        'transition:color .12s var(--ds-ease-in-out),background-color .12s var(--ds-ease-in-out);}' +
        '.dbc-tbtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}' +
        '.dbc-tbtn:active{background:var(--dsw-alias-interactive-bg-active);}' +
        '.dbc-tbtn:disabled{opacity:.45;cursor:default;background:none;}' +
        '.dbc-tbtn:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:1px;}' +
        '.dbc-danger{color:var(--dsw-alias-state-error,#ec1313);}' +
        '.dbc-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error,#ec1313) 10%,transparent);}' +
        // 登录态
        '.dbc-loginwrap{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;}' +
        '.dbc-login{width:min(440px,92%);display:flex;flex-direction:column;gap:12px;}' +
        '.dbc-login h2{margin:0;font:600 var(--dsw-font-s-14);}' +
        '.dbc-sub{margin:0;font:var(--dsw-font-xs-13);line-height:20px;color:var(--dsw-alias-label-secondary);}' +
        '.dbc-url{width:100%;}' +
        '.dbc-maskedbox{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);' +
        'border:1px solid var(--dsw-alias-border-l1);font-family:var(--ds-font-family-code);' +
        'font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all;}' +
        '.dbc-msg-ok{margin:0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-state-success,#16a34a);word-break:break-all;}' +
        '.dbc-msg-err{margin:0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-state-error,#ec1313);word-break:break-all;}' +
        '.dbc-btnrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}' +
        '.dbc-help{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);}' +
        '.dbc-help summary{cursor:pointer;color:var(--dsw-alias-label-tertiary);}' +
        // 工作台骨架
        '.dbc-body{flex:1;display:flex;min-height:0;}' +
        // schema 树面板 —— 编辑器同款圆角卡片(specific-input-major + 细边 + lv2 影)
        '.dbc-side{width:256px;flex:none;display:flex;flex-direction:column;min-height:0;' +
        'margin:10px 0 8px 10px;background:var(--dsw-specific-input-major);' +
        'border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:14px;' +
        'box-shadow:var(--dsw-shadow-lv2);overflow:hidden;}' +
        '.dbc-side-head{flex:none;height:30px;display:flex;align-items:center;justify-content:space-between;' +
        'padding:0 8px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-tertiary);' +
        'font:500 var(--dsw-font-xxs-12);border-bottom:1px solid var(--dsw-alias-border-l2);}' +
        '.dbc-tree{flex:1;overflow:auto;padding:4px 0 8px;user-select:none;}' +
        '.dbc-row{display:flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:4px;' +
        'cursor:pointer;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);' +
        'transition:background-color .12s var(--ds-ease-in-out),color .12s var(--ds-ease-in-out);}' +
        '.dbc-row:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}' +
        '.dbc-row-strong{color:var(--dsw-alias-label-primary);font-weight:500;}' +
        '.dbc-count{color:var(--dsw-alias-label-caption);font-weight:400;}' +
        '.dbc-caret{display:inline-block;width:0;height:0;border-left:4px solid currentColor;' +
        'border-top:3px solid transparent;border-bottom:3px solid transparent;opacity:.55;' +
        'transition:transform .12s var(--ds-ease-in-out);}' +
        '.dbc-caret-open{transform:rotate(90deg);}' +
        '.dbc-tables{margin-left:14px;}' +
        '.dbc-cols{margin-left:22px;border-left:1px dashed var(--dsw-alias-border-l1);padding-left:6px;}' +
        '.dbc-col{display:flex;align-items:center;gap:6px;height:19px;padding:0 4px;font-size:11px;' +
        'line-height:16px;color:var(--dsw-alias-label-tertiary);}' +
        '.dbc-col .t{color:var(--dsw-alias-label-caption);}' +
        '.dbc-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;}' +
        // 编辑器 —— 回声 composer 卡片
        // 高度用视口钳制而非百分比: % 依赖祖先链有确定高, 一旦断链 textarea
        // 会按内容自撑, 长 SQL 直接把页面拉成超长
        '.dbc-editor{flex:none;display:flex;flex-direction:column;' +
        'height:clamp(170px, 32vh, 320px);' +
        'margin:10px 10px 8px;background:var(--dsw-specific-input-major);' +
        'border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:14px;' +
        'box-shadow:var(--dsw-shadow-lv2);overflow:hidden;transition:border-color .12s var(--ds-ease-in-out);}' +
        '.dbc-editor:focus-within{border-color:var(--dsw-alias-state-business-primary);}' +
        '.dbc-editor-scroll{position:relative;flex:1;min-height:0;}' +
        '.dbc-hl,.dbc-ta{position:absolute;inset:0;margin:0;padding:10px 14px 12px;border:0;' +
        'font-family:var(--ds-font-family-code);font-size:13px;line-height:22px;' +
        'white-space:pre-wrap;word-break:break-all;overflow-wrap:break-word;tab-size:2;}' +
        '.dbc-hl{pointer-events:none;overflow:hidden;color:var(--dsw-alias-label-primary);background:none;}' +
        '.dbc-ta{width:100%;height:100%;resize:none;background:none;outline:none;overflow:auto;' +
        'color:transparent;-webkit-text-fill-color:transparent;caret-color:var(--dsw-alias-state-business-primary);}' +
        '.dbc-ta::placeholder{color:var(--dsw-alias-label-caption);}' +
        '.dbc-ta::selection{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent);}' +
        // 语法着色: 选用在明暗两种底色上都可读的中等亮度值(壳层无语法代币)
        '.dbc-hl .kw{color:#4176e6;font-weight:600;}' +
        '.dbc-hl .str{color:#1f9e5f;}.dbc-hl .num{color:#c77700;}' +
        '.dbc-hl .com{color:var(--dsw-alias-label-tertiary);font-style:italic;}' +
        '.dbc-editor-bar{flex:none;height:34px;display:flex;align-items:center;gap:8px;padding:0 6px;' +
        'border-top:1px solid var(--dsw-alias-border-l2-darkmode-thin);}' +
        '.dbc-hint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption);}' +
        // 补全弹层 —— specific-menu 配方
        '.dbc-cmplist{position:absolute;z-index:60;min-width:220px;max-width:360px;max-height:240px;overflow:auto;' +
        'background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3));border:1px solid var(--dsw-alias-border-l2);' +
        'border-radius:8px;box-shadow:var(--dsw-shadow-lv2);padding:4px;}' +
        '.dbc-cmp{display:flex;align-items:center;justify-content:space-between;gap:12px;height:24px;' +
        'padding:0 8px;border-radius:4px;font:var(--dsw-font-xxs-12);cursor:pointer;' +
        'color:var(--dsw-alias-label-secondary);}' +
        '.dbc-cmp:hover,.dbc-cmp-sel{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);}' +
        '.dbc-cmp .k{color:var(--dsw-alias-label-caption);font-size:11px;}' +
        // 结果面板
        '.dbc-results{flex:1;min-height:120px;display:flex;flex-direction:column;gap:8px;overflow:auto;' +
        'margin:0 10px 8px;padding:8px 12px;background:var(--dsw-alias-bg-base);' +
        'border:1px solid var(--dsw-alias-border-l1);border-radius:12px;}' +
        '.dbc-rstat{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);}' +
        '.dbc-gridwrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;max-height:300px;}' +
        '.dbc-grid{width:100%;border-collapse:separate;border-spacing:0;font:var(--dsw-font-xxs-12);}' +
        '.dbc-grid th{position:sticky;top:0;height:30px;text-align:left;padding:0 8px;z-index:1;' +
        'background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-tertiary);font-weight:500;' +
        'border-bottom:1px solid var(--dsw-alias-border-l2);}' +
        '.dbc-grid td{height:30px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);' +
        'white-space:nowrap;max-width:480px;overflow:hidden;text-overflow:ellipsis;cursor:pointer;}' +
        '.dbc-grid tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover);}' +
        '.dbc-null{color:var(--dsw-alias-label-tertiary);font-style:italic;}' +
        // 提示条(toast 配方)
        '.dbc-toast{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:200;' +
        'pointer-events:none;padding:6px 14px;border-radius:14px;font:var(--dsw-font-xs-13);' +
        'background:var(--dsw-alias-toast-bg);color:var(--dsw-static-neutral-bluish-00);' +
        'box-shadow:var(--dsw-shadow-lv2);}' +
        // 数据库页激活期间隐藏会话输入框(挂在 body 类上, 离开视图即恢复)
        'body.dbc-on [data-composer-card]{display:none !important;}';

      var styleEl = null;
      function ensureStyles() {
        if (styleEl && styleEl.isConnected) return;
        styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-db-console');
        styleEl.textContent = STYLE_CSS;
        document.head.appendChild(styleEl);
      }

      // ---- 小工具 ----
      function esc(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }
      function fmtVal(v) {
        if (v === null || v === undefined) return { text: 'NULL', isNull: true };
        if (typeof v === 'object') return { text: JSON.stringify(v), isNull: false };
        return { text: String(v), isNull: false };
      }
      function copyText(t) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t).catch(function () {});
          return true;
        }
        try {
          var ta = document.createElement('textarea');
          ta.value = t;
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

      // ---- 工作区记忆(localStorage, 按隔离键) ----
      // 记住每个项目的: SQL 草稿 / schema 树 / 最近一次结果。
      // 切会话、切页签、刷新后回到同一工作区即还原。结果超 256KB 不落缓存。
      function dbcNS(key) {
        return 'dsh.db-console:' + key;
      }
      function dbcLoadJSON(key, slot) {
        try {
          var raw = localStorage.getItem(dbcNS(key) + ':' + slot);
          if (!raw) return null;
          return JSON.parse(raw);
        } catch (e) {
          return null;
        }
      }
      function dbcSave(key, slot, value) {
        try {
          if (value === null || value === undefined)
            localStorage.removeItem(dbcNS(key) + ':' + slot);
          else localStorage.setItem(dbcNS(key) + ':' + slot, JSON.stringify(value));
        } catch (e) {
          /* 配额满/隐私模式: 静默放弃 */
        }
      }
      function dbcClearAll(key) {
        ['sql', 'schema', 'result'].forEach(function (slot) {
          try {
            localStorage.removeItem(dbcNS(key) + ':' + slot);
          } catch (e) {}
        });
      }

      // ---- SQL 高亮 tokenizer(整段扫描, 输出转义后的 HTML) ----
      var KW_SET = {};
      (
        'select from where insert into values update delete create table drop alter add column ' +
        'join inner left right full outer on as and or not in is null like ilike between exists ' +
        'group by order having limit offset union all distinct case when then else end with recursive ' +
        'returning primary key foreign references unique index view materialized begin commit rollback ' +
        'truncate grant revoke analyze explain vacuum show set reset use describe desc asc cascade ' +
        'default constraint check interval current_date current_timestamp now coalesce cast count sum ' +
        'avg min max true false'
      )
        .split(/\s+/)
        .forEach(function (w) {
          if (w) KW_SET[w.toUpperCase()] = 1;
        });

      function highlightSqlHtml(text) {
        var out = [];
        var i = 0;
        var n = text.length;
        function push(cls, seg) {
          out.push(cls ? '<span class="' + cls + '">' + esc(seg) + '</span>' : esc(seg));
        }
        while (i < n) {
          var ch = text[i];
          var two = text.slice(i, i + 2);
          if (two === '--') {
            var nl = text.indexOf('\n', i);
            if (nl === -1) nl = n;
            push('com', text.slice(i, nl));
            i = nl;
            continue;
          }
          if (two === '/*') {
            var cl = text.indexOf('*/', i + 2);
            cl = cl === -1 ? n : cl + 2;
            push('com', text.slice(i, cl));
            i = cl;
            continue;
          }
          if (ch === "'") {
            var j = i + 1;
            while (j < n) {
              if (text[j] === "'" && text[j + 1] === "'") j += 2;
              else if (text[j] === "'") {
                j++;
                break;
              } else j++;
            }
            push('str', text.slice(i, j));
            i = j;
            continue;
          }
          if (ch === '"') {
            var k = text.indexOf('"', i + 1);
            k = k === -1 ? n : k + 1;
            push('str', text.slice(i, k));
            i = k;
            continue;
          }
          if (/[0-9]/.test(ch) && (i === 0 || !/[\w$.]/.test(text[i - 1]))) {
            var m = /^(0x[0-9a-fA-F]+|[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?)/.exec(text.slice(i));
            if (m) {
              push('num', m[0]);
              i += m[0].length;
              continue;
            }
          }
          if (/[A-Za-z_]/.test(ch)) {
            var w = /^[\w$]+/.exec(text.slice(i))[0];
            push(KW_SET[w.toUpperCase()] ? 'kw' : '', w);
            i += w.length;
            continue;
          }
          push('', ch);
          i++;
        }
        return out.join('');
      }

      // ---- 光标坐标(mirror 测量) ----
      function caretPos(ta) {
        var cs = window.getComputedStyle(ta);
        var div = document.createElement('div');
        div.style.position = 'absolute';
        div.style.visibility = 'hidden';
        div.style.whiteSpace = 'pre-wrap';
        div.style.wordBreak = 'break-all';
        div.style.overflowWrap = 'break-word';
        div.style.fontFamily = cs.fontFamily;
        div.style.fontSize = cs.fontSize;
        div.style.lineHeight = cs.lineHeight;
        div.style.padding =
          cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft;
        div.style.borderStyle = 'solid';
        div.style.borderWidth =
          cs.borderTopWidth +
          ' ' +
          cs.borderRightWidth +
          ' ' +
          cs.borderBottomWidth +
          ' ' +
          cs.borderLeftWidth;
        div.style.boxSizing = cs.boxSizing;
        div.style.width = ta.clientWidth + 'px';
        var upTo = ta.value.slice(0, ta.selectionEnd === null ? ta.value.length : ta.selectionEnd);
        div.textContent = upTo;
        var mark = document.createElement('span');
        mark.textContent = '\u200b';
        div.appendChild(mark);
        document.body.appendChild(div);
        var spanRect = mark.getBoundingClientRect();
        var divRect = div.getBoundingClientRect();
        document.body.removeChild(div);
        var left = spanRect.left - divRect.left - ta.scrollLeft;
        var top = spanRect.top - divRect.top - ta.scrollTop;
        var lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.55 || 19;
        var maxX = ta.clientWidth - 8;
        var maxY = ta.clientHeight - lineH - 4;
        return {
          left: Math.max(4, Math.min(left, maxX)),
          top: Math.max(2, Math.min(top, maxY)) + lineH,
        };
      }

      // ---- 补全引擎 ----
      var SQL_KEYWORDS =
        'select from where insert into values update delete create table drop alter add column join inner left right full outer on as and or not in is null like ilike between exists group by order having limit offset union all distinct case when then else end with returning primary key foreign references unique index view begin commit rollback truncate explain show set reset asc desc cascade default constraint check interval coalesce cast count sum avg min max current_date current_timestamp now true false'.split(
          ' ',
        );

      /** 当前光标处的词与触发上下文: {word, dotTable|null, start} */
      function completionContext(text, caret) {
        var before = text.slice(0, caret);
        var m = /[\w$.]*$/.exec(before);
        var token = m ? m[0] : '';
        var start = caret - token.length;
        var dot = token.lastIndexOf('.');
        if (dot !== -1 && dot > 0) {
          return {
            word: token.slice(dot + 1),
            dotTable: token.slice(0, dot),
            start: start + dot + 1,
            rawToken: token,
          };
        }
        return { word: token, dotTable: null, start: start, rawToken: token };
      }

      /** 从 SQL 文本提取 表别名映射: { alias|tableLower: qualifiedName } */
      function collectAliases(text) {
        var map = {};
        var re =
          /\b(from|join)\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)(?:\s+(?:as\s+)?([A-Za-z_][\w]*))?/gi;
        var mm;
        while ((mm = re.exec(text))) {
          var tbl = mm[2].toLowerCase();
          var alias = mm[3] ? mm[3].toLowerCase() : null;
          map[tbl] = tbl;
          if (alias) map[alias] = tbl;
        }
        return map;
      }

      /**
       * 计算候选: 三级 —— 点号后 → 该表列; 否则 关键字+表名。
       * 返回 [{label, kind}] (kind: col|table|keyword)
       */
      function buildCandidates(cctx, text, schema) {
        var lower = cctx.word.toLowerCase();
        function rank(list, kind) {
          var starts = [];
          var incl = [];
          for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var l = item.toLowerCase();
            if (lower === '') {
              starts.push({ label: item, kind: kind });
              if (starts.length > 60) break;
            } else if (l.indexOf(lower) === 0) starts.push({ label: item, kind: kind });
            else if (l.indexOf(lower) !== -1) incl.push({ label: item, kind: kind });
          }
          return starts.concat(incl).slice(0, 14);
        }
        if (cctx.dotTable) {
          var dt = cctx.dotTable.toLowerCase();
          var aliases = collectAliases(text);
          var real = aliases[dt] || dt;
          var cols = findColumns(schema, real);
          if (!cols.length) return [];
          return rank(cols, 'col');
        }
        var tables = [];
        (schema || []).forEach(function (s) {
          s.tables.forEach(function (t) {
            tables.push(s.name === 'public' ? t.name : s.name + '.' + t.name);
          });
        });
        return rank(SQL_KEYWORDS, 'keyword').slice(0, 8).concat(rank(tables, 'table')).slice(0, 14);
      }

      function findColumns(schema, tableLower) {
        var shortName = tableLower.indexOf('.') !== -1 ? tableLower.split('.').pop() : tableLower;
        var cols = [];
        (schema || []).forEach(function (s) {
          s.tables.forEach(function (t) {
            if (t.name.toLowerCase() === shortName) {
              t.columns.forEach(function (c) {
                cols.push(c.name);
              });
            }
          });
        });
        return cols;
      }

      // ---- 组件: 补全弹层 ----
      function CmpPopup(props) {
        if (!props.items || !props.items.length) return null;
        var idx = Math.min(props.sel, props.items.length - 1);
        return React.createElement(
          'div',
          {
            className: 'dbc-cmplist',
            style: props.pos ? { left: props.pos.left, top: props.pos.top } : undefined,
          },
          props.items.map(function (it, i) {
            return React.createElement(
              'div',
              {
                key: it.kind + ':' + it.label + ':' + i,
                className: 'dbc-cmp' + (i === idx ? ' dbc-cmp-sel' : ''),
                onMouseDown: function (e) {
                  e.preventDefault();
                  props.onPick(it.label);
                },
                onMouseEnter: function () {
                  props.onHover(i);
                },
              },
              React.createElement('span', null, it.label),
              React.createElement('span', { className: 'k' }, it.kind),
            );
          }),
        );
      }

      // ---- 组件: schema 树 ----
      function SchemaTree(props) {
        var schemas = props.schemas || [];
        var openState = React.useState({});
        var open = openState[0];
        var setOpen = openState[1];
        function toggleSchema(name) {
          setOpen(function (p) {
            var n = Object.assign({}, p);
            n['s:' + name] = !n['s:' + name];
            return n;
          });
        }
        function toggleTable(key) {
          setOpen(function (p) {
            var n = Object.assign({}, p);
            n[key] = !n[key];
            return n;
          });
        }
        if (!schemas.length) {
          return React.createElement(
            'div',
            { className: 'dbc-hint', style: { padding: '8px 12px' } },
            props.loading ? '内省中…' : '无表(或未加载)',
          );
        }
        return React.createElement(
          'div',
          { className: 'dbc-tree' },
          schemas.map(function (s) {
            var sOpen = !!open['s:' + s.name];
            return React.createElement(
              'div',
              { className: 'dbc-schema', key: s.name },
              React.createElement(
                'div',
                {
                  className: 'dbc-row dbc-row-strong',
                  onClick: function () {
                    toggleSchema(s.name);
                  },
                },
                React.createElement('i', {
                  className: 'dbc-caret' + (sOpen ? ' dbc-caret-open' : ''),
                }),
                React.createElement(
                  'span',
                  null,
                  s.name,
                  React.createElement(
                    'span',
                    { className: 'dbc-count' },
                    ' (' + s.tables.length + ')',
                  ),
                ),
              ),
              sOpen
                ? React.createElement(
                    'div',
                    { className: 'dbc-tables' },
                    s.tables.map(function (t) {
                      var key = 't:' + s.name + '.' + t.name;
                      var tOpen = !!open[key];
                      return React.createElement(
                        'div',
                        { key: t.name },
                        React.createElement(
                          'div',
                          {
                            className: 'dbc-row',
                            title: '点击把表名插入编辑器; 再点展开列',
                            onClick: function (e) {
                              props.onPickTable(s.name, t.name);
                              toggleTable(key);
                            },
                          },
                          React.createElement('i', {
                            className: 'dbc-caret' + (tOpen ? ' dbc-caret-open' : ''),
                          }),
                          React.createElement('span', null, t.name),
                        ),
                        tOpen
                          ? React.createElement(
                              'div',
                              { className: 'dbc-cols' },
                              t.columns.map(function (c, ci) {
                                return React.createElement(
                                  'div',
                                  { className: 'dbc-col', key: c.name + ci },
                                  React.createElement('span', null, c.name),
                                  React.createElement('span', { className: 't' }, c.type),
                                );
                              }),
                            )
                          : null,
                      );
                    }),
                  )
                : null,
            );
          }),
        );
      }

      // ---- 组件: 结果段(单个 pg Result 的渲染) ----
      function ResultPart(props) {
        var p = props.part;
        if (p.kind === 'rows') {
          var note = p.truncated
            ? '已截断: 显示前 ' +
              p.rows.length +
              ' 行' +
              (p.total ? '(共取回 ' + p.total + ' 行)' : '')
            : p.rows.length + ' 行返回';
          return React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              { className: 'dbc-rstat' },
              note,
              p.command && p.command !== 'SELECT' ? ' · ' + p.command : '',
            ),
            React.createElement(
              'div',
              { className: 'dbc-gridwrap' },
              React.createElement(
                'table',
                { className: 'dbc-grid' },
                React.createElement(
                  'thead',
                  null,
                  React.createElement(
                    'tr',
                    null,
                    p.fields.map(function (f, fi) {
                      return React.createElement('th', { key: fi }, f);
                    }),
                  ),
                ),
                React.createElement(
                  'tbody',
                  null,
                  p.rows.map(function (row, ri) {
                    return React.createElement(
                      'tr',
                      { key: ri },
                      p.fields.map(function (f, fi) {
                        var v = fmtVal(row[f]);
                        return React.createElement(
                          'td',
                          {
                            key: fi,
                            className: v.isNull ? 'dbc-null' : '',
                            title: '点击复制',
                            onClick: function () {
                              if (copyText(v.text)) props.onToast('已复制单元格');
                            },
                          },
                          v.text,
                        );
                      }),
                    );
                  }),
                ),
              ),
            ),
          );
        }
        return React.createElement(
          'div',
          { className: 'dbc-rstat' },
          (p.command || 'OK') +
            (typeof p.rowCount === 'number' ? ' · 影响 ' + p.rowCount + ' 行' : ' · 执行成功'),
        );
      }

      // ---- 主视图 ----
      function DbConsoleView(props) {
        ensureStyles(); // 双保险: 即使 apply 阶段的注入被清掉也兜得住
        var useSessions = props.useSessions;
        var sessionCwd = null;
        if (typeof useSessions === 'function') {
          sessionCwd = useSessions(function (s) {
            var cur = s && s.current ? s.byId && s.byId[s.current] : null;
            return cur && typeof cur.cwd === 'string' && cur.cwd !== '' ? cur.cwd : null;
          });
        }

        var cfgState = React.useState(null); // {url, maskedUrl, summary, key}
        var cfg = cfgState[0];
        var setCfg = cfgState[1];
        var loadErrState = React.useState('');
        var loadErr = loadErrState[0];
        var setLoadErr = loadErrState[1];

        var connState = React.useState('idle'); // idle|connecting|open
        var conn = connState[0];
        var setConn = connState[1];
        var dbInfoState = React.useState(null);
        var dbInfo = dbInfoState[0];
        var setDbInfo = dbInfoState[1];
        var connErrState = React.useState('');
        var connErr = connErrState[0];
        var setConnErr = connErrState[1];

        var editModeState = React.useState(false);
        var editMode = editModeState[0];
        var setEditMode = editModeState[1];
        var urlDraftState = React.useState('');
        var urlDraft = urlDraftState[0];
        var setUrlDraft = urlDraftState[1];
        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var testMsgState = React.useState(null); // {ok, msg}
        var testMsg = testMsgState[0];
        var setTestMsg = testMsgState[1];
        var confirmDelState = React.useState(false);
        var confirmDel = confirmDelState[0];
        var setConfirmDel = confirmDelState[1];

        var schemaState = React.useState(null);
        var schema = schemaState[0];
        var setSchema = schemaState[1];
        var schemaBusyState = React.useState(false);
        var schemaBusy = schemaBusyState[0];
        var setSchemaBusy = schemaBusyState[1];

        var sqlState = React.useState('-- Ctrl/Cmd+Enter 执行\nSELECT 1;\n');
        var sql = sqlState[0];
        var setSql = sqlState[1];
        var resultState = React.useState(null); // {pending}|{err}|{parts:[...]}
        var result = resultState[0];
        var setResult = resultState[1];

        var toastState = React.useState(null);
        var toast = toastState[0];
        var setToast = toastState[1];
        var toastTimerRef = React.useRef(null);
        function showToast(msg) {
          setToast(msg);
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          toastTimerRef.current = setTimeout(function () {
            setToast(null);
          }, 1400);
        }

        // 首次装载: 拉配置; 若 host 侧已连接则直接进入工作台
        // hydratingRef: 会话/工作区切换后、回放完成前, 禁止把上一项目的
        // 内存状态写进新键(防串染)。
        var hydratingRef = React.useRef(true);
        React.useEffect(
          function () {
            hydratingRef.current = true; // 换了 cwd → 一切记忆待回放
            var alive = true;
            api('config.get', { root: sessionCwd || '' })
              .then(function (res) {
                if (!alive || !res || !res.ok) {
                  if (alive) {
                    setLoadErr((res && res.error) || '加载失败');
                    hydratingRef.current = false;
                  }
                  return;
                }
                setCfg({
                  key: res.key,
                  url: res.url,
                  maskedUrl: res.maskedUrl,
                  summary: res.summary,
                });
                // 工作区记忆回放(SQL 草稿 / schema 树; 结果走 Host 记忆)
                if (res.key) {
                  var sv = dbcLoadJSON(res.key, 'sql');
                  if (typeof sv === 'string' && sv !== '') setSql(sv);
                  else setSql('-- Ctrl/Cmd+Enter 执行\nSELECT 1;\n');
                  var sc = dbcLoadJSON(res.key, 'schema');
                  if (Array.isArray(sc) && sc.length) setSchema(sc);
                  else setSchema(null);
                } else {
                  setSchema(null);
                }
                if (res.connected && res.db) {
                  setConn('open');
                  setDbInfo(res.db);
                }
                dbg('config.get key=', res.key, 'connected=', !!res.connected);
                hydratingRef.current = false;
              })
              .catch(function (e) {
                if (alive) {
                  setLoadErr(String(e && e.message));
                  hydratingRef.current = false;
                }
              });
            return function () {
              alive = false;
            };
          },
          [sessionCwd],
        );

        function loadSchema() {
          setSchemaBusy(true);
          api('schema', { root: sessionCwd || '' })
            .then(function (res) {
              if (res && res.ok) setSchema(res.schemas || []);
              else setSchema([]);
            })
            .catch(function () {
              setSchema([]);
            })
            .then(function () {
              setSchemaBusy(false);
            });
        }

        function doConnect() {
          setConn('connecting');
          setConnErr('');
          api('connect', { root: sessionCwd || '' })
            .then(function (res) {
              if (res && res.ok) {
                setConn('open');
                setDbInfo(res.db);
                setEditMode(false);
                loadSchema();
              } else {
                setConn('idle');
                setConnErr((res && res.error) || '连接失败');
              }
            })
            .catch(function (e) {
              setConn('idle');
              setConnErr(String(e && e.message));
            });
        }

        function doSaveAndConnect() {
          var u = urlDraft.trim();
          if (!u) {
            setTestMsg({ ok: false, msg: '请粘贴完整链接' });
            return;
          }
          setBusy(true);
          setTestMsg(null);
          api('config.save', { root: sessionCwd || '', url: u })
            .then(function (res) {
              if (!res || !res.ok) throw new Error((res && res.error) || '保存失败');
              setCfg({
                key: res.key,
                url: u,
                maskedUrl: res.maskedUrl,
                summary: res.summary,
              });
              setBusy(false);
              doConnect();
            })
            .catch(function (e) {
              setBusy(false);
              setTestMsg({ ok: false, msg: String(e && e.message) });
            });
        }

        function doTest(urlArg) {
          var u = typeof urlArg === 'string' ? urlArg : urlDraft.trim();
          if (!u) {
            setTestMsg({ ok: false, msg: '请先粘贴完整链接' });
            return;
          }
          setBusy(true);
          setTestMsg(null);
          api('test', { url: u })
            .then(function (res) {
              setBusy(false);
              if (res && res.ok)
                setTestMsg({
                  ok: true,
                  msg:
                    '连接成功 · ' +
                    [res.db.database, res.db.user + '@' + res.db.host, res.db.serverVersion]
                      .filter(Boolean)
                      .join(' · '),
                });
              else setTestMsg({ ok: false, msg: (res && res.error) || '失败' });
            })
            .catch(function (e) {
              setBusy(false);
              setTestMsg({ ok: false, msg: String(e && e.message) });
            });
        }

        function doDisconnect() {
          api('disconnect', { root: sessionCwd || '' }).then(function () {
            setConn('idle');
            setDbInfo(null);
            setSchema(null);
            setResult(null);
          });
        }

        function doDelete() {
          if (!confirmDel) {
            setConfirmDel(true);
            return;
          }
          setConfirmDel(false);
          var delKey = cfg ? cfg.key : null;
          if (delKey) dbcClearAll(delKey); // 删配置即清工作区记忆
          api('config.delete', { root: sessionCwd || '' }).then(function () {
            setCfg({ key: cfg ? cfg.key : null, url: null, maskedUrl: null, summary: null });
            setConn('idle');
            setDbInfo(null);
            setSchema(null);
            setResult(null);
            setUrlDraft('');
            setEditMode(false);
          });
        }

        function runQuery() {
          if (!sql.trim()) return;
          setResult({ pending: true });
          api('query', { root: sessionCwd || '', sql: sql })
            .then(function (res) {
              if (!res || !res.ok) {
                setResult({ err: (res && res.error) || '执行失败' });
                return;
              }
              if (res.kind === 'multi') {
                setResult({ parts: res.parts });
              } else {
                setResult({ parts: [res] });
              }
            })
            .catch(function (e) {
              setResult({ err: String(e && e.message) });
            });
        }

        // 编辑器 + 补全
        var taRef = React.useRef(null);
        var cmp = React.useRef({ items: [], sel: 0, pos: null, ctxStart: -1 }).current;
        var cmpTickState = React.useState(0);
        var setCmpTick = cmpTickState[1];

        function closeCmp() {
          if (cmp.items.length) {
            cmp.items = [];
            cmp.ctxStart = -1;
            setCmpTick(function (t) {
              return t + 1;
            });
          }
        }
        // 补全上下文一律取 textarea 的实时值(ta.value)而非受控 state ——
        // state 落后最后一次按键一拍, 配上实时的 selectionStart 会把词起点
        // 算错一位, Enter 上屏就出现「ffrom」这类首字母重复。代际号用于
        // 作废已排队的 rAF 刷新(接受候选后不再被旧帧重新弹层)。
        function refreshCmp() {
          var ta = taRef.current;
          if (!ta) return;
          var live = ta.value;
          var caret = ta.selectionStart;
          if (caret === null || typeof caret !== 'number') {
            closeCmp();
            return;
          }
          var cctx = completionContext(live, caret);
          if (cctx.word === '' && !cctx.dotTable) {
            closeCmp();
            return;
          }
          var items = buildCandidates(cctx, live, schema);
          if (!items.length) {
            closeCmp();
            return;
          }
          cmp.items = items;
          cmp.sel = 0;
          cmp.ctxStart = cctx.start;
          cmp.pos = caretPos(ta);
          setCmpTick(function (t) {
            return t + 1;
          });
        }
        function scheduleRefresh() {
          var seq = (cmp.seq = (cmp.seq || 0) + 1);
          requestAnimationFrame(function () {
            if (cmp.seq === seq) refreshCmp();
          });
        }
        function acceptCmp(label) {
          var ta = taRef.current;
          if (!ta) return;
          cmp.seq = (cmp.seq || 0) + 1; // 作废挂起的刷新, 防止上屏后被旧帧重开弹层
          var live = ta.value;
          var caret = ta.selectionStart;
          if (caret === null || typeof caret !== 'number' || cmp.ctxStart < 0) return;
          if (cmp.ctxStart > caret) return; // 防御: 锚点越界(理论不达)直接放弃
          var next = live.slice(0, cmp.ctxStart) + label + live.slice(caret);
          setSql(next);
          closeCmp();
          requestAnimationFrame(function () {
            if (taRef.current) {
              var pos = cmp.ctxStart + label.length;
              taRef.current.focus();
              taRef.current.setSelectionRange(pos, pos);
            }
          });
        }
        function insertAtCursor(text) {
          var ta = taRef.current;
          if (!ta) return;
          var live = ta.value;
          var caret =
            ta.selectionStart === null || typeof ta.selectionStart !== 'number'
              ? live.length
              : ta.selectionStart;
          var next = live.slice(0, caret) + text + live.slice(caret);
          setSql(next);
          requestAnimationFrame(function () {
            if (taRef.current) {
              taRef.current.focus();
              taRef.current.setSelectionRange(caret + text.length, caret + text.length);
            }
          });
        }

        function onTaKeyDown(e) {
          if (cmp.items.length) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              cmp.sel = (cmp.sel + 1) % cmp.items.length;
              setCmpTick(function (t) {
                return t + 1;
              });
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              cmp.sel = (cmp.sel - 1 + cmp.items.length) % cmp.items.length;
              setCmpTick(function (t) {
                return t + 1;
              });
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              acceptCmp(cmp.items[Math.min(cmp.sel, cmp.items.length - 1)].label);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              closeCmp();
              return;
            }
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            runQuery();
          }
        }

        var hlRef = React.useRef(null);
        function syncScroll() {
          var ta = taRef.current;
          if (ta && hlRef.current) {
            hlRef.current.scrollTop = ta.scrollTop;
            hlRef.current.scrollLeft = ta.scrollLeft;
          }
        }

        // 激活标记: 全局 CSS 据 body.dbc-on 隐藏会话输入框; 离开视图即恢复
        React.useEffect(function () {
          document.body.classList.add('dbc-on');
          return function () {
            document.body.classList.remove('dbc-on');
          };
        }, []);

        // 工作区记忆写回(有隔离键且回放完成后才写, 防跨项目串染;
        // 结果不做任何持久化 —— 切走即清, 按用户决定)
        var cfgKey = cfg ? cfg.key : null;
        React.useEffect(
          function () {
            if (!cfgKey || hydratingRef.current) return;
            dbcSave(cfgKey, 'sql', sql);
          },
          [cfgKey, sql],
        );
        React.useEffect(
          function () {
            if (!cfgKey || hydratingRef.current || !schema) return;
            dbcSave(cfgKey, 'schema', schema);
          },
          [cfgKey, schema],
        );

        // 卸载清理 toast 定时器
        React.useEffect(function () {
          return function () {
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          };
        }, []);

        // ---- 渲染分支 ----
        if (!cfg && !loadErr) {
          return React.createElement(
            'div',
            { className: 'dbc-root' },
            React.createElement('div', { className: 'dbc-center' }, '加载数据库配置…'),
          );
        }

        var showForm = loadErr || !cfg || !cfg.url || editMode;

        if (showForm) {
          return React.createElement(
            'div',
            { className: 'dbc-root' },
            toast ? React.createElement('div', { className: 'dbc-toast' }, toast) : null,
            React.createElement(
              'div',
              { className: 'dbc-loginwrap' },
              toast ? React.createElement('div', { className: 'dbc-toast' }, toast) : null,
              React.createElement(
                'div',
                { className: 'dbc-login' },
                React.createElement('h2', null, '数据库'),
                React.createElement(
                  'p',
                  { className: 'dbc-sub' },
                  '粘贴完整 PostgreSQL 链接串登录。链接按项目(仓库根)保存于本机, 刷新/重启不失效。',
                ),
                React.createElement(Input, {
                  className: 'dbc-url',
                  type: 'text',
                  spellCheck: false,
                  autoFocus: true,
                  placeholder: 'postgres://user:password@host:5432/dbname?sslmode=require',
                  value: urlDraft,
                  onChange: function (e) {
                    setUrlDraft(e.target.value);
                    setTestMsg(null);
                  },
                  onKeyDown: function (e) {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      doSaveAndConnect();
                    }
                  },
                }),
                testMsg
                  ? React.createElement(
                      'div',
                      { className: testMsg.ok ? 'dbc-msg-ok' : 'dbc-msg-err' },
                      testMsg.msg,
                    )
                  : null,
                loadErr && !cfg
                  ? React.createElement('div', { className: 'dbc-msg-err' }, loadErr)
                  : null,
                React.createElement(
                  'div',
                  { className: 'dbc-btnrow' },
                  React.createElement(
                    Btn,
                    { variant: 'primary', size: 'sm', disabled: busy, onClick: doSaveAndConnect },
                    busy ? '处理中…' : '保存并连接',
                  ),
                  React.createElement(
                    Btn,
                    {
                      variant: 'outline',
                      size: 'sm',
                      disabled: busy,
                      onClick: function () {
                        doTest();
                      },
                    },
                    '测试连接',
                  ),
                  cfg && cfg.url
                    ? React.createElement(
                        Btn,
                        {
                          variant: 'ghost',
                          size: 'sm',
                          onClick: function () {
                            setEditMode(false);
                            setUrlDraft('');
                            setTestMsg(null);
                          },
                        },
                        '取消',
                      )
                    : null,
                ),
                React.createElement(
                  'details',
                  { className: 'dbc-help' },
                  React.createElement('summary', null, '支持哪些写法?'),
                  React.createElement(
                    'div',
                    null,
                    'postgres:// 或 postgresql:// 均可; 支持 sslmode、connect_timeout 等 query 参数; 密码中的特殊字符需 URL 转义(%40 代表 @)。',
                  ),
                ),
              ),
            ),
          );
        }

        // 已保存未连接
        if (conn !== 'open') {
          return React.createElement(
            'div',
            { className: 'dbc-root' },
            toast ? React.createElement('div', { className: 'dbc-toast' }, toast) : null,
            React.createElement(
              'div',
              { className: 'dbc-loginwrap' },
              React.createElement(
                'div',
                { className: 'dbc-login' },
                React.createElement('h2', null, '数据库'),
                React.createElement('div', { className: 'dbc-maskedbox' }, cfg.maskedUrl || ''),
                cfg.summary
                  ? React.createElement('p', { className: 'dbc-sub' }, cfg.summary)
                  : null,
                connErr ? React.createElement('div', { className: 'dbc-msg-err' }, connErr) : null,
                testMsg
                  ? React.createElement(
                      'div',
                      { className: testMsg.ok ? 'dbc-msg-ok' : 'dbc-msg-err' },
                      testMsg.msg,
                    )
                  : null,
                React.createElement(
                  'div',
                  { className: 'dbc-btnrow' },
                  React.createElement(
                    Btn,
                    {
                      variant: 'primary',
                      size: 'sm',
                      disabled: conn === 'connecting',
                      onClick: doConnect,
                    },
                    conn === 'connecting' ? '连接中…' : '连接',
                  ),
                  React.createElement(
                    Btn,
                    {
                      variant: 'outline',
                      size: 'sm',
                      disabled: busy,
                      onClick: function () {
                        doTest(cfg.url);
                      },
                    },
                    '测试连接',
                  ),
                  React.createElement(
                    Btn,
                    {
                      variant: 'outline',
                      size: 'sm',
                      onClick: function () {
                        setEditMode(true);
                        setUrlDraft(cfg.url || '');
                        setTestMsg(null);
                      },
                    },
                    '修改链接',
                  ),
                  React.createElement(
                    'button',
                    { className: 'dbc-tbtn dbc-danger', onClick: doDelete },
                    confirmDel ? '确认删除?' : '删除',
                  ),
                ),
              ),
            ),
          );
        }

        // 工作台
        var headDesc = [
          cfg.maskedUrl || '',
          dbInfo && dbInfo.serverVersion ? dbInfo.serverVersion : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return React.createElement(
          'div',
          { className: 'dbc-root' },
          toast ? React.createElement('div', { className: 'dbc-toast' }, toast) : null,
          React.createElement(
            'div',
            { className: 'dbc-toolbar' },
            React.createElement('span', { className: 'dbc-title' }, '数据库'),
            React.createElement('span', { className: 'dbc-meta' }, headDesc),
            React.createElement('span', { className: 'dbc-spacer' }),
            React.createElement(
              'button',
              {
                className: 'dbc-tbtn',
                title: '重新内省表结构',
                disabled: schemaBusy,
                onClick: loadSchema,
              },
              schemaBusy ? '⟳ 内省中…' : '⟳ schema',
            ),
            React.createElement('button', { className: 'dbc-tbtn', onClick: doDisconnect }, '断开'),
          ),
          React.createElement(
            'div',
            { className: 'dbc-body' },
            React.createElement(
              'div',
              { className: 'dbc-side' },
              React.createElement(
                'div',
                { className: 'dbc-side-head' },
                React.createElement('span', null, '表结构'),
                schema
                  ? React.createElement(
                      'span',
                      { className: 'dbc-count' },
                      schema.length + ' 个 schema',
                    )
                  : null,
              ),
              React.createElement(SchemaTree, {
                schemas: schema,
                loading: schemaBusy,
                onPickTable: function (sName, tName) {
                  insertAtCursor(sName === 'public' ? tName : sName + '.' + tName);
                  showToast('已插入 ' + (sName === 'public' ? tName : sName + '.' + tName));
                },
              }),
            ),
            React.createElement(
              'div',
              { className: 'dbc-main' },
              React.createElement(
                'div',
                { className: 'dbc-editor' },
                React.createElement(
                  'div',
                  { className: 'dbc-editor-scroll' },
                  React.createElement('pre', {
                    ref: hlRef,
                    className: 'dbc-hl',
                    'aria-hidden': 'true',
                    dangerouslySetInnerHTML: { __html: highlightSqlHtml(sql) + '\n' },
                  }),
                  React.createElement('textarea', {
                    ref: taRef,
                    className: 'dbc-ta',
                    value: sql,
                    spellCheck: false,
                    placeholder: '输入 SQL… (Ctrl/Cmd+Enter 执行)',
                    onKeyDown: onTaKeyDown,
                    onChange: function (e) {
                      setSql(e.target.value);
                      scheduleRefresh();
                    },
                    onClick: closeCmp,
                    onBlur: function () {
                      setTimeout(closeCmp, 120);
                    },
                    onScroll: syncScroll,
                    onKeyUp: function (e) {
                      if (
                        e.key === 'ArrowLeft' ||
                        e.key === 'ArrowRight' ||
                        e.key === 'Home' ||
                        e.key === 'End'
                      )
                        closeCmp();
                    },
                  }),
                  cmp.items.length
                    ? React.createElement(CmpPopup, {
                        items: cmp.items,
                        sel: cmp.sel,
                        pos: cmp.pos,
                        onPick: acceptCmp,
                        onHover: function (i) {
                          cmp.sel = i;
                          setCmpTick(function (t) {
                            return t + 1;
                          });
                        },
                      })
                    : null,
                ),
                React.createElement(
                  'div',
                  { className: 'dbc-editor-bar' },
                  React.createElement(
                    Btn,
                    { variant: 'primary', size: 'sm', onClick: runQuery },
                    '▶ 执行',
                  ),
                  React.createElement(
                    'span',
                    { className: 'dbc-hint' },
                    'Ctrl/Cmd+Enter · 补全: 输入字母或「表名.」',
                  ),
                ),
              ),
              React.createElement(
                'div',
                { className: 'dbc-results' },
                result === null
                  ? React.createElement('div', { className: 'dbc-hint' }, '结果将在这里展示')
                  : result.pending
                    ? React.createElement('div', { className: 'dbc-hint' }, '执行中…')
                    : result.err
                      ? React.createElement('div', { className: 'dbc-msg-err' }, result.err)
                      : (result.parts || []).map(function (part, pi) {
                          return React.createElement(ResultPart, {
                            key: pi,
                            part: part,
                            onToast: showToast,
                          });
                        }),
              ),
            ),
          ),
        );
      }

      // ---- 注册: 会话头部第三个页签 ----
      slots.inject('conversation.view', function () {
        return slots.register(
          {
            name: 'conversation.view',
            id: 'database',
            order: 20,
            label: '数据库',
            inject: function (sessionId) {
              return { sessionId: sessionId };
            },
          },
          DbConsoleView,
        );
      });

      ctx.on('dispose', function () {
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      });
    };

    return module.exports;
  },
});
