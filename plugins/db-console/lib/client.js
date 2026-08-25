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

    exports.name = 'dsh-db-console';
    exports.inject = ['slots'];
    exports.apply = function (ctx) {
      var slots = ctx.slots;

      // ---- 与 host 通信 ----
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
      var STYLE_CSS =
        // 视图容器: 填满会话体给到的区域
        '.dbc-view{position:relative;display:flex;flex-direction:column;box-sizing:border-box;' +
        'width:100%;height:100%;min-height:320px;padding:14px 18px;gap:10px;' +
        'color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family,system-ui);font-size:13px;line-height:1.5;}' +
        '.dbc-card{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;' +
        'box-shadow:var(--dsw-shadow-lv2,rgba(0,0,0,.14)) 0 6px 24px;}' +
        // 登录卡片
        '.dbc-login{margin:auto;width:min(560px,92%);padding:22px 24px;display:flex;flex-direction:column;gap:12px;}' +
        '.dbc-login h2{margin:0;font-size:15px;font-weight:600;}' +
        '.dbc-muted{color:var(--dsw-alias-label-secondary);}' +
        '.dbc-faint{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;}' +
        '.dbc-input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;' +
        'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);' +
        'color:var(--dsw-alias-label-primary);font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}' +
        '.dbc-input:focus{outline:none;border-color:var(--dsw-alias-brand,#4a6cf7);}' +
        '.dbc-btnrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}' +
        '.dbc-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);cursor:pointer;' +
        'background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;}' +
        '.dbc-btn:hover{border-color:var(--dsw-alias-brand,#4a6cf7);}' +
        '.dbc-btn-primary{background:var(--dsw-alias-brand,#4a6cf7);border-color:transparent;color:#fff;}' +
        '.dbc-btn-danger{color:#e5484d;border-color:color-mix(in srgb,#e5484d 45%,transparent);}' +
        '.dbc-btn:disabled{opacity:.55;cursor:default;}' +
        '.dbc-err{color:#e5484d;font-size:12.5px;white-space:pre-wrap;word-break:break-all;}' +
        '.dbc-okmsg{color:#30a46c;font-size:12.5px;}' +
        '.dbc-masked{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;' +
        'word-break:break-all;color:var(--dsw-alias-label-secondary);}' +
        // 已连接工作台
        '.dbc-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;}' +
        '.dbc-head .dbc-title{font-weight:600;font-size:13px;}' +
        '.dbc-body{display:flex;gap:10px;flex:1;min-height:0;}' +
        '.dbc-side{width:250px;flex:none;display:flex;flex-direction:column;min-height:0;overflow:hidden;}' +
        '.dbc-side-head{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;' +
        'border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600;font-size:12.5px;flex:none;}' +
        '.dbc-tree{flex:1;overflow:auto;padding:6px 4px 10px;user-select:none;}' +
        '.dbc-schema{margin-bottom:2px;}' +
        '.dbc-schema-row{display:flex;align-items:center;gap:5px;padding:3px 8px;border-radius:6px;cursor:pointer;}' +
        '.dbc-schema-row:hover{background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.12));}' +
        '.dbc-caret{display:inline-block;width:0;height:0;border-left:5px solid currentColor;' +
        'border-top:4px solid transparent;border-bottom:4px solid transparent;opacity:.6;transition:transform .12s;}' +
        '.dbc-caret-open{transform:rotate(90deg);}' +
        '.dbc-tables{margin-left:16px;}' +
        '.dbc-table-row{display:flex;align-items:center;gap:5px;padding:2.5px 8px;border-radius:6px;cursor:pointer;}' +
        '.dbc-table-row:hover{background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.12));}' +
        '.dbc-cols{margin-left:18px;border-left:1px dashed var(--dsw-alias-border-l1);padding-left:6px;}' +
        '.dbc-col{display:flex;gap:6px;padding:1px 6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}' +
        '.dbc-col .t{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));opacity:.85;}' +
        '.dbc-main{flex:1;display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;}' +
        // 编辑器
        '.dbc-editor-wrap{position:relative;flex:none;height:34%;min-height:150px;display:flex;' +
        'flex-direction:column;overflow:hidden;}' +
        '.dbc-editor-scroll{position:relative;flex:1;overflow:hidden;}' +
        '.dbc-hl,.dbc-ta{position:absolute;inset:0;margin:0;padding:10px 12px;border:0;' +
        'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.8px;line-height:1.55;' +
        'white-space:pre-wrap;word-break:break-all;overflow-wrap:break-word;tab-size:2;}' +
        '.dbc-hl{pointer-events:none;overflow:hidden;color:var(--dsw-alias-label-primary);background:transparent;}' +
        '.dbc-ta{width:100%;height:100%;resize:none;background:var(--dsw-alias-bg-base);' +
        'color:transparent;caret-color:var(--dsw-alias-label-primary);-webkit-text-fill-color:transparent;' +
        'border-top:1px solid var(--dsw-alias-border-l1);}' +
        '.dbc-ta::selection{background:color-mix(in srgb,var(--dsw-alias-brand,#4a6cf7) 32%,transparent);}' +
        '.dbc-hl .kw{color:#c678dd;font-weight:600;}' +
        '.dbc-hl .str{color:#98c379;}.dbc-hl .num{color:#d19a66;}.dbc-hl .com{color:var(--dsw-alias-label-tertiary,#7f848e);font-style:italic;}' +
        '.dbc-editor-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;flex:none;}' +
        // 补全弹层
        '.dbc-cmplist{position:absolute;z-index:60;min-width:220px;max-width:340px;max-height:220px;overflow:auto;' +
        'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);' +
        'border-radius:8px;box-shadow:var(--dsw-shadow-lv2,rgba(0,0,0,.2)) 0 8px 28px;padding:4px;font-size:12.5px;}' +
        '.dbc-cmp{display:flex;justify-content:space-between;gap:12px;padding:3.5px 8px;border-radius:6px;cursor:pointer;}' +
        '.dbc-cmp-sel{background:color-mix(in srgb,var(--dsw-alias-brand,#4a6cf7) 22%,transparent);}' +
        '.dbc-cmp .k{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;}' +
        // 结果区
        '.dbc-results{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;overflow:auto;padding:10px 12px;}' +
        '.dbc-rstat{font-size:12px;color:var(--dsw-alias-label-secondary);}' +
        '.dbc-gridwrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;max-height:420px;}' +
        '.dbc-grid{border-collapse:separate;border-spacing:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
        'font-size:12px;min-width:100%;}' +
        '.dbc-grid th{position:sticky;top:0;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));' +
        'text-align:left;padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);font-weight:600;z-index:1;}' +
        '.dbc-grid td{padding:4px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);' +
        'white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis;cursor:pointer;}' +
        '.dbc-grid tr:hover td{background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.08));}' +
        '.dbc-null{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-style:italic;}' +
        // 提示条
        '.dbc-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:200;' +
        'padding:7px 16px;border-radius:999px;font-size:12.5px;pointer-events:none;' +
        'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);' +
        'box-shadow:var(--dsw-shadow-lv2,rgba(0,0,0,.18)) 0 6px 20px;}';

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
            { className: 'dbc-faint', style: { padding: '8px 12px' } },
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
                  className: 'dbc-schema-row',
                  onClick: function () {
                    toggleSchema(s.name);
                  },
                },
                React.createElement('i', {
                  className: 'dbc-caret' + (sOpen ? ' dbc-caret-open' : ''),
                }),
                React.createElement(
                  'span',
                  { style: { fontWeight: 600 } },
                  s.name,
                  React.createElement(
                    'span',
                    { className: 'dbc-faint' },
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
                            className: 'dbc-table-row',
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
        React.useEffect(
          function () {
            var alive = true;
            api('config.get', { root: sessionCwd || '' })
              .then(function (res) {
                if (!alive || !res || !res.ok) {
                  if (alive) setLoadErr((res && res.error) || '加载失败');
                  return;
                }
                setCfg({
                  key: res.key,
                  url: res.url,
                  maskedUrl: res.maskedUrl,
                  summary: res.summary,
                });
                if (res.connected && res.db) {
                  setConn('open');
                  setDbInfo(res.db);
                }
              })
              .catch(function (e) {
                if (alive) setLoadErr(String(e && e.message));
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
        function refreshCmp() {
          var ta = taRef.current;
          if (!ta) return;
          var caret = ta.selectionStart;
          if (caret === null || typeof caret !== 'number') {
            closeCmp();
            return;
          }
          var cctx = completionContext(sql, caret);
          if (cctx.word === '' && !cctx.dotTable) {
            closeCmp();
            return;
          }
          var items = buildCandidates(cctx, sql, schema);
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
        function acceptCmp(label) {
          var ta = taRef.current;
          if (!ta) return;
          var caret = ta.selectionStart;
          if (caret === null || cmp.ctxStart < 0) return;
          var next = sql.slice(0, cmp.ctxStart) + label + sql.slice(caret);
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
          var caret = ta.selectionStart === null ? sql.length : ta.selectionStart;
          var next = sql.slice(0, caret) + text + sql.slice(caret);
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

        // 卸载清理 toast 定时器
        React.useEffect(function () {
          return function () {
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          };
        }, []);

        var mono = { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace' };

        // ---- 渲染分支 ----
        if (!cfg && !loadErr) {
          return React.createElement(
            'div',
            { className: 'dbc-view' },
            React.createElement('div', { className: 'dbc-muted' }, '加载数据库配置…'),
          );
        }

        var showForm = loadErr || !cfg || !cfg.url || editMode;

        if (showForm) {
          return React.createElement(
            'div',
            { className: 'dbc-view' },
            toast ? React.createElement('div', { className: 'dbc-toast' }, toast) : null,
            React.createElement(
              'div',
              { className: 'dbc-card dbc-login' },
              React.createElement('h2', null, '数据库'),
              React.createElement(
                'div',
                { className: 'dbc-faint' },
                '粘贴完整 PostgreSQL 链接串登录。链接按项目(仓库根)保存于本机, 刷新/重启不失效。',
              ),
              React.createElement('input', {
                className: 'dbc-input',
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
                    { className: testMsg.ok ? 'dbc-okmsg' : 'dbc-err' },
                    testMsg.msg,
                  )
                : null,
              loadErr && !cfg
                ? React.createElement('div', { className: 'dbc-err' }, loadErr)
                : null,
              React.createElement(
                'div',
                { className: 'dbc-btnrow' },
                React.createElement(
                  'button',
                  {
                    className: 'dbc-btn dbc-btn-primary',
                    disabled: busy,
                    onClick: doSaveAndConnect,
                  },
                  busy ? '处理中…' : '保存并连接',
                ),
                React.createElement(
                  'button',
                  { className: 'dbc-btn', disabled: busy, onClick: doTest },
                  '测试连接',
                ),
                cfg && cfg.url
                  ? React.createElement(
                      'button',
                      {
                        className: 'dbc-btn',
                        onClick: function () {
                          setEditMode(false);
                          setUrlDraft('');
                        },
                      },
                      '取消',
                    )
                  : null,
              ),
              React.createElement(
                'details',
                { className: 'dbc-faint' },
                React.createElement('summary', null, '支持哪些写法?'),
                React.createElement(
                  'div',
                  null,
                  'postgres:// 或 postgresql:// 均可; 支持 sslmode、connect_timeout 等 query 参数; 密码中的特殊字符需 URL 转义(%40 代表 @)。',
                ),
              ),
            ),
          );
        }

        // 连接卡片(有配置未连接)
        if (conn !== 'open') {
          return React.createElement(
            'div',
            { className: 'dbc-view' },
            toast ? React.createElement('div', { className: 'dbc-toast' }, toast) : null,
            React.createElement(
              'div',
              { className: 'dbc-card dbc-login' },
              React.createElement('h2', null, '数据库'),
              React.createElement('div', { className: 'dbc-masked' }, cfg.maskedUrl || ''),
              cfg.summary
                ? React.createElement('div', { className: 'dbc-faint' }, cfg.summary)
                : null,
              connErr ? React.createElement('div', { className: 'dbc-err' }, connErr) : null,
              testMsg
                ? React.createElement(
                    'div',
                    { className: testMsg.ok ? 'dbc-okmsg' : 'dbc-err' },
                    testMsg.msg,
                  )
                : null,
              React.createElement(
                'div',
                { className: 'dbc-btnrow' },
                React.createElement(
                  'button',
                  {
                    className: 'dbc-btn dbc-btn-primary',
                    disabled: conn === 'connecting',
                    onClick: doConnect,
                  },
                  conn === 'connecting' ? '连接中…' : '连接',
                ),
                React.createElement(
                  'button',
                  {
                    className: 'dbc-btn',
                    disabled: busy,
                    onClick: function () {
                      doTest(cfg.url);
                    },
                  },
                  '测试连接',
                ),
                React.createElement(
                  'button',
                  {
                    className: 'dbc-btn',
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
                  { className: 'dbc-btn dbc-btn-danger', onClick: doDelete },
                  confirmDel ? '确认删除?' : '删除',
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
          { className: 'dbc-view' },
          toast ? React.createElement('div', { className: 'dbc-toast' }, toast) : null,
          React.createElement(
            'div',
            { className: 'dbc-card dbc-head' },
            React.createElement('span', { className: 'dbc-title' }, '数据库'),
            React.createElement('span', { className: 'dbc-masked' }, headDesc),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement(
              'button',
              {
                className: 'dbc-btn',
                title: '重新内省表结构',
                disabled: schemaBusy,
                onClick: loadSchema,
              },
              schemaBusy ? '⟳ …' : '⟳ schema',
            ),
            React.createElement('button', { className: 'dbc-btn', onClick: doDisconnect }, '断开'),
          ),
          React.createElement(
            'div',
            { className: 'dbc-body' },
            React.createElement(
              'div',
              { className: 'dbc-card dbc-side' },
              React.createElement(
                'div',
                { className: 'dbc-side-head' },
                React.createElement('span', null, '表结构'),
                schema
                  ? React.createElement(
                      'span',
                      { className: 'dbc-faint' },
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
                { className: 'dbc-card dbc-editor-wrap' },
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
                      requestAnimationFrame(refreshCmp);
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
                    'button',
                    { className: 'dbc-btn dbc-btn-primary', onClick: runQuery },
                    '▶ 执行',
                  ),
                  React.createElement(
                    'span',
                    { className: 'dbc-faint' },
                    'Ctrl/Cmd+Enter · 补全: 输入字母或「表名.」',
                  ),
                ),
              ),
              React.createElement(
                'div',
                { className: 'dbc-card dbc-results' },
                result === null
                  ? React.createElement('div', { className: 'dbc-faint' }, '结果将在这里展示')
                  : result.pending
                    ? React.createElement('div', { className: 'dbc-muted' }, '执行中…')
                    : result.err
                      ? React.createElement('div', { className: 'dbc-err' }, result.err)
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
