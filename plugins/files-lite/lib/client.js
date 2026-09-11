// dsh-files-lite — client half(静态浏览器 bundle)
//
// 与动态插件 client 半的差异: 沙箱内置符号换成真实模块表依赖 —— React 经
// require('react') 解析(loader 种子模块), 无 host 私有 RPC(本插件根本不发请求),
// styles.insert 换成手动 <style> 注入。槽位注册 API 与动态完全一致。
//
// 接管方式: 官方 `dsh-client-ui-sidebar-files` 用 `priority: 'builtin'` 注册
// `kind: 'files'`; 右侧栏注册表规定 **extension 档可以接管同 kind 的 builtin 档**
// (extension=3 > builtin=2)。本插件因此以 extension 档注册同一个 kind, 并在
// 卸载时自动让官方实现复位。
//
// 数据一律复用官方已有的 Remote face(`remote.workspaceFiles.list`), 不新增任何
// host 路由 —— 本插件只做「看」。
window.__ModuleLoader__.load({
  id: 'dsh-files-lite',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');

    exports.name = 'dsh-files-lite';

    /** 右侧栏注册表 + 槽位注册表 + 官方的目录列表 Remote face。 */
    exports.inject = ['slots', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles'];

    exports.apply = function (ctx) {
      var slots = ctx.slots;
      var h = React.createElement;

      var TYPE_ID = 'dsh-files-lite';
      /** 接管官方文件树的 kind(不是新建 kind)。 */
      var FILES_KIND = 'files';
      var LS_KEY = 'files-lite:show-hidden';

      // ---- 纯函数(lib/zones.js 的内联副本; bundle 无法 import host ESM) ----

      function joinChild(parent, name) {
        var base = typeof parent === 'string' ? parent.replace(/[\\/]+$/, '') : '';
        var child = String(name);
        return base === '' ? child : base + '/' + child;
      }

      function isHiddenName(name) {
        if (typeof name !== 'string' || name.length < 2 || name === '..') return false;
        return name.startsWith('.');
      }

      function shouldShow(name, showHidden) {
        if (typeof name !== 'string' || name === '') return false;
        if (name === '.git') return false;
        return showHidden === true ? true : !isHiddenName(name);
      }

      function visibleEntries(entries, showHidden) {
        var list = Array.isArray(entries) ? entries.slice() : [];
        var kept = [];
        for (var i = 0; i < list.length; i += 1) {
          var entry = list[i];
          if (entry === null || typeof entry !== 'object') continue;
          if (!shouldShow(entry.name, showHidden)) continue;
          kept.push(entry);
        }
        kept.sort(function (a, b) {
          var ad = a.type === 'directory' ? 0 : 1;
          var bd = b.type === 'directory' ? 0 : 1;
          if (ad !== bd) return ad - bd;
          return String(a.name).localeCompare(String(b.name), 'zh-CN');
        });
        return kept;
      }

      // ---- 开关持久化 ----

      function readShowHidden() {
        try {
          return window.localStorage.getItem(LS_KEY) === '1';
        } catch (e) {
          return false;
        }
      }

      function writeShowHidden(value) {
        try {
          window.localStorage.setItem(LS_KEY, value ? '1' : '0');
        } catch (e) {
          // localStorage 不可写时只是不记忆
        }
      }

      // ---- 样式 ----

      function ensureStyles() {
        var id = 'files-lite-styles';
        if (document.getElementById(id)) return;
        var el = document.createElement('style');
        el.id = id;
        el.textContent = [
          '.fl-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--dsw-alias-text-base,inherit)}',
          '.fl-head{display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.22));flex:0 0 auto}',
          '.fl-btn{border:0;background:transparent;cursor:pointer;padding:1px 5px;border-radius:4px;color:inherit;font-size:13px;line-height:1.4}',
          '.fl-btn:hover{background:rgba(128,128,128,.18)}',
          '.fl-btn[data-on="1"]{color:rgb(103,153,254)}',
          '.fl-cwd{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.7;direction:rtl;text-align:left;flex:1 1 auto}',
          '.fl-body{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 0}',
          '.fl-row{display:flex;align-items:center;gap:4px;padding:2px 8px;cursor:default;white-space:nowrap}',
          '.fl-row[data-dir="1"]{cursor:pointer}',
          '.fl-row[data-dir="1"]:hover{background:rgba(128,128,128,.16)}',
          '.fl-tw{width:1em;flex:0 0 auto;opacity:.6;font-size:10px}',
          '.fl-name{overflow:hidden;text-overflow:ellipsis}',
          '.fl-hidden{opacity:.55}',
          '.fl-empty{padding:12px 10px;opacity:.65;text-align:center}',
        ].join('\n');
        document.head.appendChild(el);
      }

      // ---- 页签体 ----

      /**
       * 树根 = 当前会话工作区 cwd(经 useSessions 的 byId[].cwd 感知),
       * 与右侧栏其他视图同一口径。会话没有 cwd 时显示占位而不是瞎猜目录。
       */
      function FilesLiteBody(props) {
        var sessionId = props.sessionId;
        var useSessions = props.useSessions;

        var cwd = null;
        if (typeof useSessions === 'function') {
          cwd =
            useSessions(function (s) {
              var id = sessionId || (s && s.current);
              var sess = s && s.byId && id ? s.byId[id] : null;
              return sess && typeof sess.cwd === 'string' && sess.cwd !== '' ? sess.cwd : null;
            }) || null;
        }

        var hiddenPair = React.useState(readShowHidden);
        var showHidden = hiddenPair[0];
        var setShowHidden = hiddenPair[1];

        // path → { kind: 'loading' | 'ready' | 'failed', entries?, error? }
        var levelsPair = React.useState({});
        var levels = levelsPair[0];
        var setLevels = levelsPair[1];
        var expandedPair = React.useState([]);
        var expanded = expandedPair[0];
        var setExpanded = expandedPair[1];

        var face = ctx.remote;
        var listDir =
          face && face.workspaceFiles && typeof face.workspaceFiles.list === 'function'
            ? face.workspaceFiles.list
            : null;

        var load = React.useCallback(
          function (dir) {
            if (listDir === null) {
              setLevels(function (prev) {
                var next = Object.assign({}, prev);
                next[dir] = { kind: 'failed', error: 'workspaceFiles 不可用' };
                return next;
              });
              return;
            }
            setLevels(function (prev) {
              var next = Object.assign({}, prev);
              next[dir] = { kind: 'loading' };
              return next;
            });
            Promise.resolve(listDir(sessionId, dir, undefined))
              .then(function (res) {
                setLevels(function (prev) {
                  var next = Object.assign({}, prev);
                  if (res && res.ok === true && res.value) {
                    next[dir] = {
                      kind: 'ready',
                      entries: res.value.entries || [],
                      truncated: res.value.truncated === true,
                    };
                  } else {
                    next[dir] = { kind: 'failed', error: (res && res.error) || 'list-failed' };
                  }
                  return next;
                });
              })
              .catch(function (err) {
                setLevels(function (prev) {
                  var next = Object.assign({}, prev);
                  next[dir] = { kind: 'failed', error: String((err && err.message) || err) };
                  return next;
                });
              });
          },
          [sessionId, listDir],
        );

        // 切换工作区: 丢掉旧树、只展开根。
        React.useEffect(
          function () {
            setExpanded([]);
            setLevels({});
            if (typeof cwd === 'string' && cwd !== '') load(cwd);
          },
          [cwd, load],
        );

        function toggle(dir) {
          if (expanded.indexOf(dir) !== -1) {
            setExpanded(
              expanded.filter(function (p) {
                return p !== dir;
              }),
            );
            return;
          }
          setExpanded(expanded.concat([dir]));
          if (levels[dir] === undefined) load(dir);
        }

        // 展平成行(只走已展开且有内容的层)
        var rows = [];
        function walk(dir, depth) {
          var level = levels[dir];
          if (level === undefined || level.kind !== 'ready') return;
          var list = visibleEntries(level.entries, showHidden);
          for (var i = 0; i < list.length; i += 1) {
            var entry = list[i];
            var child = joinChild(dir, entry.name);
            var isDir = entry.type === 'directory';
            rows.push({ path: child, name: entry.name, isDir: isDir, depth: depth });
            if (isDir && expanded.indexOf(child) !== -1) walk(child, depth + 1);
          }
        }
        if (typeof cwd === 'string' && cwd !== '') walk(cwd, 0);

        var head = h(
          'div',
          { className: 'fl-head' },
          h(
            'button',
            {
              className: 'fl-btn',
              'data-on': showHidden ? '1' : '0',
              title: showHidden ? '隐藏 dotfiles' : '显示隐藏文件',
              onClick: function () {
                var next = !showHidden;
                setShowHidden(next);
                writeShowHidden(next);
              },
            },
            showHidden ? '👁' : '👁🗨',
          ),
          h('span', { className: 'fl-cwd', title: cwd || '' }, cwd || '(无工作区)'),
        );

        var body = null;
        if (cwd === null) body = h('div', { className: 'fl-empty' }, '等待会话工作区…');
        else if (listDir === null)
          body = h('div', { className: 'fl-empty' }, 'workspaceFiles 不可用');
        else if (rows.length === 0) {
          var root = levels[cwd];
          if (root === undefined || root.kind === 'loading') body = h('div', { className: 'fl-empty' }, '读取中…');
          else if (root.kind === 'failed') body = h('div', { className: 'fl-empty' }, '读取失败(' + root.error + ')');
          else body = h('div', { className: 'fl-empty' }, '(空目录)');
        } else {
          body = h(
            'div',
            null,
            rows.map(function (row) {
              var level = levels[row.path];
              var glyph = row.isDir
                ? expanded.indexOf(row.path) !== -1
                  ? '▾'
                  : '▸'
                : '';
              return h(
                'div',
                {
                  key: row.path,
                  className: 'fl-row',
                  'data-dir': row.isDir ? '1' : '0',
                  style: { paddingLeft: String(8 + row.depth * 12) + 'px' },
                  title: row.path,
                  onClick: row.isDir
                    ? function () {
                        toggle(row.path);
                      }
                    : undefined,
                },
                h('span', { className: 'fl-tw' }, glyph),
                h(
                  'span',
                  {
                    className:
                      'fl-name' + (isHiddenName(row.name) ? ' fl-hidden' : ''),
                  },
                  row.name,
                ),
                row.isDir && level !== undefined && level.kind === 'loading'
                  ? h('span', { className: 'fl-tw' }, '…')
                  : null,
              );
            }),
          );
        }

        return h('div', { className: 'fl-root' }, head, h('div', { className: 'fl-body' }, body));
      }

      function FilesLiteTitle() {
        return h('span', null, '文件');
      }

      // ---- 注册 ----

      ensureStyles();

      // extension 档接管官方 builtin 的 'files' kind; id 必须与官方不同。
      ctx.effect(
        function () {
          return ctx.sidebarRightTabs.register({
            id: TYPE_ID,
            kind: FILES_KIND,
            priority: 'extension',
            title: function () {
              return '文件';
            },
            guide: [
              {
                order: 40,
                title: function () {
                  return '文件';
                },
                description: function () {
                  return '工作区文件树(可切显示隐藏文件)';
                },
              },
            ],
          });
        },
        'files-lite: files type takeover',
      );

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab', function () {
          return slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, FilesLiteBody);
        });
      }, 'files-lite: tree body');

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab.title', function () {
          return slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, FilesLiteTitle);
        });
      }, 'files-lite: tree title');

      console.info('[files-lite] ready — 已接管官方文件树(眼睛开关切换隐藏文件)');
    };

    return module.exports;
  },
});
