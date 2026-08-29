// dsh-batch-archive — client half(静态浏览器 bundle)
//
// 与动态插件 client 半的差异: 沙箱内置符号换成真实模块表依赖 ——
// React 经 require('react') 解析(loader 种子模块), 官方 UI 原语经
// require('@deepseek-ai/dsh-client-ui-primitives') 取用(Button/图标),
// styles.insert 换成手动 <style> 注入(ctx.on('dispose') 清理)。
// 槽位注册 API(slots.inject / slots.register)与动态完全一致。
//
// 样式口径 —— 全部仿官方:
//   ├─ 侧边栏底部按钮: 复刻官方设置触发器(sidebar 设置行的 VOzbGW_trigger):
//   │    42px 高 / 12px 圆角 / hover 交互底色 / 展开态图标+文字, rail 态 36px 圆钮。
//   └─ 归档面板: 复刻官方设置浮层(VOzbGW overlay/mask/panel):
//        bg-mask-1 + mask-blur 遮罩, bg-layer-2 + shadow-lv3 + 24px 圆角面板,
//        官方滚动条 token, 自定义复选框(官方 IconCheckOutline14 勾选),
//        官方 Button(primary / ghost / outline)。
//
// 功能:
//   ├─ sidebar.footer.action: 「批量归档」入口按钮(官方 IconArchiveOutline20)
//   └─ shell.overlay: 按工作区分组列出未归档会话, 勾选/全选, 两次点击确认,
//        逐个调用 ctx.workspaces.archiveSession(id) 归档。
window.__ModuleLoader__.load({
  id: 'dsh-batch-archive',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    var UI = require('@deepseek-ai/dsh-client-ui-primitives');
    var IconArchiveOutline20 = UI.IconArchiveOutline20;
    var IconCheckOutline14 = UI.IconCheckOutline14;
    var IconCloseOutline16 = UI.IconCloseOutline16;
    var Btn = UI.Button;

    exports.name = 'dsh-batch-archive';
    exports.inject = ['slots', 'workspaces'];
    exports.apply = function (ctx) {
      var slots = ctx.slots;
      var workspaces = ctx.workspaces;

      // ---- 按钮与面板共享的开关状态 ----
      var open = false;
      var listeners = [];
      function notify() {
        for (var i = 0; i < listeners.length; i++) {
          try {
            listeners[i]();
          } catch (_err) {
            /* 单个监听器失败不影响其余 */
          }
        }
      }
      var store = {
        isOpen: function () {
          return open;
        },
        setOpen: function (value) {
          open = !!value;
          notify();
        },
        subscribe: function (fn) {
          listeners.push(fn);
          return function () {
            var i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
          };
        },
      };

      // ---- 样式(手动 <style> 注入, 卸载时移除) ----
      // 选中色取粒子鲸鱼插件的淡化蓝 rgb(103,153,254), 比官方 business-primary 更淡
      var STYLE_CSS =
        ':root{--dsh-batch-archive-accent:rgb(103,153,254)}' +
        // 侧边栏底部入口 —— 复刻官方 footer 单元格(CordisPanel layer/badge)与
        // 设置触发器(VOzbGW_trigger): 整行宽 42px, 整行 hover, rail 态 36px 圆钮
        '.baCell{flex:none;align-items:center;width:100%;height:42px;margin:8px 0 0;display:flex;position:relative}' +
        '.baAction{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden;user-select:none}' +
        '.baAction:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
        '.baAction.baOpen{color:var(--dsh-batch-archive-accent)}' +
        '.baActionLabel{white-space:nowrap;overflow:hidden}' +
        '.baCell.baRail{width:36px;height:36px;margin:0}' +
        '.baCell.baRail .baAction{width:36px;height:36px;border-radius:50%;justify-content:center;gap:0;margin:0;padding:0}' +
        // 浮层 —— 复刻官方设置浮层(VOzbGW overlay/mask/panel)
        '.baOverlay{z-index:1000;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}' +
        '.baMask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}' +
        '.baPanel{z-index:1;background:var(--dsw-alias-bg-layer-2);width:640px;max-width:calc(100vw - 48px);max-height:min(680px,calc(100vh - 48px));box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:24px;display:flex;flex-direction:column;position:relative;overflow:hidden;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}' +
        '.baHeader{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:8px;height:54px;padding:20px 14px 8px 10px}' +
        '.baTitle{flex:1;min-width:0;font-size:16px;font-weight:500;line-height:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.baHeaderNote{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}' +
        '.baClose{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:28px;justify-content:center;align-items:center;padding:0;display:inline-flex;flex:none}' +
        '.baClose:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
        '.baClose:disabled{opacity:.4;cursor:not-allowed}' +
        '.baToolbar{flex:none;display:flex;align-items:center;gap:14px;padding:2px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}' +
        '.baToolbarLabel{cursor:pointer;display:inline-flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);user-select:none;font-size:14px;line-height:22px}' +
        '.baToolbarCount{margin-left:auto;flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}' +
        '.baList{flex:1;min-height:140px;overflow-y:auto;padding:0 8px 12px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}' +
        '.baList::-webkit-scrollbar{width:5px;height:5px}' +
        '.baList::-webkit-scrollbar-track{background:transparent}' +
        '.baList::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:3px}' +
        '.baList::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}' +
        // 分组头: 吸顶条带 + 组内全选 + 计数, 与行明显区分
        '.baGroupHead{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;margin:0 -8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover) 40%,var(--dsw-alias-bg-layer-2));font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);user-select:none}' +
        '.baGroupHead:first-child{margin-top:6px}' +
        '.baGroupTitle{flex:1;min-width:0;display:inline-flex;align-items:center;gap:6px;padding:0;border:none;background:none;font-family:inherit;font-size:12px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left;user-select:none}' +
        '.baGroupTitle:hover{color:var(--dsw-alias-label-primary)}' +
        '.baGroupTitle.baGroupAll{color:var(--dsh-batch-archive-accent)}' +
        '.baGroupTitleText{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.baGroupCheck{flex:none;color:var(--dsh-batch-archive-accent)}' +
        '.baGroupCount{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}' +
        '.baRow{display:flex;align-items:center;gap:10px;height:40px;padding:0 12px;border-radius:12px;cursor:pointer;user-select:none}' +
        '.baRow:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
        '.baRowTitle{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.baRowMeta{flex:none;display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}' +
        '.baDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}' +
        // 自定义复选框(原生 input 视觉隐藏, 官方勾选图标)
        '.baCheck{flex:none;position:relative;width:16px;height:16px}' +
        '.baCheck input{position:absolute;opacity:0;width:16px;height:16px;margin:0;cursor:pointer}' +
        '.baCheckBox{box-sizing:border-box;width:16px;height:16px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:transparent;display:inline-flex;align-items:center;justify-content:center;color:#fff;pointer-events:none;transition:background-color .12s var(--ds-ease-in-out),border-color .12s var(--ds-ease-in-out)}' +
        '.baRow:hover .baCheckBox{border-color:var(--dsw-alias-label-tertiary)}' +
        '.baCheck input:checked + .baCheckBox{background:var(--dsh-batch-archive-accent);border-color:var(--dsh-batch-archive-accent)}' +
        '.baCheck input:focus-visible + .baCheckBox{box-shadow:0 0 0 2px var(--dsh-batch-archive-accent)}' +
        '.baCheck input:disabled + .baCheckBox{opacity:.4}' +
        '.baEmptyText{padding:48px 16px;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}' +
        '.baFooter{flex:none;display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}' +
        '.baFooterMsg{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.baFooterMsg.baError{color:var(--dsw-alias-state-error-primary)}' +
        '.baDanger{color:var(--dsw-alias-state-error-primary)}';

      var styleTag = null;
      function ensureStyles() {
        if (styleTag !== null) return;
        styleTag = document.createElement('style');
        styleTag.setAttribute('data-plugin', 'dsh-batch-archive');
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
      function usePanelOpen() {
        var state = React.useState(store.isOpen());
        React.useEffect(function () {
          return store.subscribe(function () {
            state[1](store.isOpen());
          });
        }, []);
        return state[0];
      }

      function timeAgo(ts) {
        if (!ts) return '';
        var diff = Date.now() - ts;
        var m = Math.floor(diff / 60000);
        if (m < 1) return '刚刚';
        if (m < 60) return m + ' 分钟前';
        var h = Math.floor(m / 60);
        if (h < 24) return h + ' 小时前';
        var d = Math.floor(h / 24);
        if (d < 30) return d + ' 天前';
        var mo = Math.floor(d / 30);
        if (mo < 12) return mo + ' 个月前';
        return Math.floor(mo / 12) + ' 年前';
      }

      // ---- 自定义复选框(官方勾选图标) ----
      function Checkbox(props) {
        return React.createElement(
          'span',
          { className: 'baCheck' },
          React.createElement('input', {
            type: 'checkbox',
            checked: props.checked,
            disabled: props.disabled,
            'aria-label': props['aria-label'],
            onChange: props.onChange,
          }),
          React.createElement(
            'span',
            { className: 'baCheckBox' },
            props.checked ? React.createElement(IconCheckOutline14, {}) : null,
          ),
        );
      }

      // ---- 侧边栏底部入口(整行宽单元格, 复刻官方 footer 单元格) ----
      function FooterAction(props) {
        var openNow = usePanelOpen();
        var wide = props.wide !== false;
        return React.createElement(
          'div',
          { className: 'baCell' + (wide ? '' : ' baRail') },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'baAction' + (openNow ? ' baOpen' : ''),
              'aria-label': '批量归档',
              onClick: function () {
                store.setOpen(!openNow);
              },
            },
            [
              React.createElement(IconArchiveOutline20, { key: 'icon', size: wide ? 16 : 18 }),
              wide
                ? React.createElement(
                    'span',
                    { key: 'label', className: 'baActionLabel' },
                    '批量归档',
                  )
                : null,
            ],
          ),
        );
      }

      // ---- 批量归档面板(复刻官方设置浮层) ----
      function BatchArchivePanel(props) {
        var openNow = usePanelOpen();
        var selectedState = React.useState({});
        var selected = selectedState[0];
        var setSelected = selectedState[1];
        var phaseState = React.useState('idle');
        var phase = phaseState[0];
        var setPhase = phaseState[1];
        var messageState = React.useState('');
        var message = messageState[0];
        var setMessage = messageState[1];

        React.useEffect(
          function () {
            if (openNow) {
              setSelected({});
              setPhase('idle');
              setMessage('');
            }
          },
          [openNow],
        );

        // ESC 关闭面板(归档进行中不响应)
        React.useEffect(
          function () {
            if (!openNow) return;
            function onKey(e) {
              if (e.key === 'Escape' && phase !== 'busy') {
                store.setOpen(false);
              }
            }
            window.addEventListener('keydown', onKey);
            return function () {
              window.removeEventListener('keydown', onKey);
            };
          },
          [openNow, phase],
        );

        var useSessions = props.useSessions;
        var useWorkspaces = props.useWorkspaces;
        var byId = useSessions
          ? useSessions(function (s) {
              return s.byId;
            })
          : undefined;
        var wsItems = useWorkspaces
          ? useWorkspaces(function (s) {
              return s.items;
            })
          : undefined;
        var archivedIds = useWorkspaces
          ? useWorkspaces(function (s) {
              return s.archivedSessionIds;
            })
          : undefined;
        var listIds = useSessions
          ? useSessions(function (s) {
              return s.ids;
            })
          : undefined;

        if (!openNow) return null;

        function renderShell(content) {
          return React.createElement(
            'div',
            {
              className: 'baOverlay',
              onClick: function () {
                if (!busy) store.setOpen(false);
              },
            },
            React.createElement('div', { className: 'baMask' }),
            React.createElement(
              'div',
              {
                className: 'baPanel',
                onClick: function (e) {
                  e.stopPropagation();
                },
              },
              content,
            ),
          );
        }

        if (!useSessions || !useWorkspaces || !byId) {
          return renderShell(
            React.createElement(
              React.Fragment,
              null,
              React.createElement(
                'div',
                { className: 'baHeader' },
                React.createElement('div', { className: 'baTitle' }, '批量归档'),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'baClose',
                    'aria-label': '关闭',
                    onClick: function () {
                      store.setOpen(false);
                    },
                  },
                  React.createElement(IconCloseOutline16, {}),
                ),
              ),
              React.createElement('div', { className: 'baEmptyText' }, '会话列表暂不可用'),
            ),
          );
        }

        // 分组: 按工作区 + 未分组桶。与官方 sidebar 口径一致 —— 只把"真正可见"的
        // 会话当作可归档项: origin !== 'subagent'、未归档、非 blank 占位会话。
        // 未分组只从权威的 list.ids 取(与官方 deriveGroups 的 stray 一致), 不直接
        // 遍历 byId —— 否则会把 subagent / 内部 / 占位会话也列出来, 导致数量远超
        // 工作区会话、且大半挤进"未分组"。
        var archived = {};
        for (var ai = 0; ai < (archivedIds || []).length; ai++) archived[archivedIds[ai]] = true;
        function visibleSession(s) {
          if (!s) return false;
          if (s.origin === 'subagent') return false;
          if (archived[s.id]) return false;
          if (s.blank) return false;
          return true;
        }
        var groups = [];
        var seen = {};
        for (var wi = 0; wi < (wsItems || []).length; wi++) {
          var w = wsItems[wi];
          var list = [];
          for (var si = 0; si < (w.sessionIds || []).length; si++) {
            var sid = w.sessionIds[si];
            if (visibleSession(byId[sid])) list.push(sid);
          }
          if (list.length > 0)
            groups.push({ key: 'w:' + w.workspaceId, title: w.title || w.path, sessions: list });
          for (var s2 = 0; s2 < list.length; s2++) seen[list[s2]] = true;
        }
        var ungrouped = [];
        var keys = listIds || [];
        for (var ik = 0; ik < keys.length; ik++) {
          var idk = keys[ik];
          if (!seen[idk] && visibleSession(byId[idk])) ungrouped.push(idk);
        }
        if (ungrouped.length > 0)
          groups.push({ key: 'ungrouped', title: '未分组', sessions: ungrouped });
        for (var gi = 0; gi < groups.length; gi++) {
          groups[gi].sessions.sort(function (a, b) {
            return (byId[b].updatedAt || 0) - (byId[a].updatedAt || 0);
          });
        }

        var allIds = [];
        for (var g2 = 0; g2 < groups.length; g2++) {
          for (var s3 = 0; s3 < groups[g2].sessions.length; s3++)
            allIds.push(groups[g2].sessions[s3]);
        }
        var selectedCount = 0;
        for (var sc = 0; sc < allIds.length; sc++) {
          if (selected[allIds[sc]]) selectedCount++;
        }
        var allSelected = allIds.length > 0 && selectedCount === allIds.length;
        var busy = phase === 'busy';
        var totalSessions = 0;
        for (var tk = 0; tk < (listIds || []).length; tk++) {
          if (visibleSession(byId[listIds[tk]])) totalSessions++;
        }
        var archivedCount = 0;
        for (var ak in archived) {
          if (Object.prototype.hasOwnProperty.call(archived, ak)) archivedCount++;
        }

        function touch() {
          if (phase !== 'busy') {
            setPhase('idle');
            setMessage('');
          }
        }
        function toggle(id) {
          touch();
          setSelected(function (prev) {
            var next = {};
            for (var k in prev) {
              if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
            }
            if (next[id]) delete next[id];
            else next[id] = true;
            return next;
          });
        }
        function toggleAll() {
          touch();
          if (allSelected) {
            setSelected({});
          } else {
            var next = {};
            for (var i = 0; i < allIds.length; i++) next[allIds[i]] = true;
            setSelected(next);
          }
        }
        function groupAllSelected(group) {
          var n = 0;
          for (var i = 0; i < group.sessions.length; i++) {
            if (selected[group.sessions[i]]) n++;
          }
          return group.sessions.length > 0 && n === group.sessions.length;
        }
        function toggleGroup(group) {
          touch();
          var all = groupAllSelected(group);
          setSelected(function (prev) {
            var next = {};
            for (var k in prev) {
              if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
            }
            for (var i = 0; i < group.sessions.length; i++) {
              if (all) delete next[group.sessions[i]];
              else next[group.sessions[i]] = true;
            }
            return next;
          });
        }
        function runArchive() {
          var ids = [];
          for (var i = 0; i < allIds.length; i++) {
            if (selected[allIds[i]]) ids.push(allIds[i]);
          }
          if (ids.length === 0 || busy) return;
          setPhase('busy');
          setMessage('');
          (function () {
            var chain = Promise.resolve();
            for (var i = 0; i < ids.length; i++) {
              (function (id) {
                chain = chain.then(function () {
                  return workspaces.archiveSession(id);
                });
              })(ids[i]);
            }
            chain
              .then(function () {
                setPhase('done');
                setMessage('已归档 ' + ids.length + ' 个会话');
                setSelected({});
              })
              .catch(function (err) {
                setPhase('error');
                setMessage('归档失败：' + (err && err.message ? err.message : String(err)));
              });
          })();
        }
        function primaryAction() {
          if (busy) return;
          if (phase === 'confirm') {
            runArchive();
            return;
          }
          if (selectedCount > 0) {
            setPhase('confirm');
            setMessage('将归档 ' + selectedCount + ' 个会话，归档后从列表中隐藏');
          }
        }
        function cancelAction() {
          if (busy) return;
          if (phase === 'confirm') {
            setPhase('idle');
            setMessage('');
            return;
          }
          store.setOpen(false);
        }

        // 行元素
        var rows = [];
        for (var rgi = 0; rgi < groups.length; rgi++) {
          (function (g) {
            rows.push(
              React.createElement(
                'div',
                { key: g.key, className: 'baGroupHead' },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'baGroupTitle' + (groupAllSelected(g) ? ' baGroupAll' : ''),
                    onClick: function () {
                      toggleGroup(g);
                    },
                    'aria-label': '全选' + g.title,
                    title: '点击全选/取消该分组',
                  },
                  [
                    groupAllSelected(g)
                      ? React.createElement(IconCheckOutline14, {
                          key: 'ck',
                          className: 'baGroupCheck',
                        })
                      : null,
                    React.createElement(
                      'span',
                      { key: 'tx', className: 'baGroupTitleText' },
                      g.title,
                    ),
                  ],
                ),
                React.createElement(
                  'span',
                  { className: 'baGroupCount' },
                  g.sessions.length + ' 个',
                ),
              ),
            );
            for (var ri = 0; ri < g.sessions.length; ri++) {
              (function (id) {
                var s = byId[id];
                rows.push(
                  React.createElement(
                    'label',
                    { key: id, className: 'baRow' },
                    React.createElement(Checkbox, {
                      checked: !!selected[id],
                      disabled: busy,
                      onChange: function () {
                        toggle(id);
                      },
                      'aria-label': s.displayTitle || s.title || id,
                    }),
                    React.createElement(
                      'span',
                      { className: 'baRowTitle' },
                      s.displayTitle || s.title || id,
                    ),
                    React.createElement(
                      'span',
                      { className: 'baRowMeta' },
                      s.running
                        ? React.createElement('span', { className: 'baDot', title: '运行中' })
                        : null,
                      React.createElement('span', null, timeAgo(s.updatedAt)),
                    ),
                  ),
                );
              })(g.sessions[ri]);
            }
          })(groups[rgi]);
        }
        if (rows.length === 0) {
          rows.push(
            React.createElement(
              'div',
              { key: 'empty', className: 'baEmptyText' },
              archivedCount > 0
                ? '没有可归档的会话（已归档 ' + archivedCount + ' 个）'
                : '没有可归档的会话',
            ),
          );
        }

        var primaryLabel;
        if (busy) primaryLabel = '归档中…';
        else if (phase === 'confirm') primaryLabel = '确认归档 (' + selectedCount + ')？';
        else if (selectedCount > 0) primaryLabel = '归档所选 (' + selectedCount + ')';
        else primaryLabel = '归档所选';
        var cancelLabel = busy ? '关闭' : phase === 'confirm' ? '返回' : '取消';

        return renderShell(
          React.createElement(
            React.Fragment,
            null,
            React.createElement(
              'div',
              { className: 'baHeader' },
              React.createElement('div', { className: 'baTitle' }, '批量归档'),
              React.createElement(
                'div',
                { className: 'baHeaderNote' },
                '共 ' + totalSessions + ' 个会话',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'baClose',
                  'aria-label': '关闭',
                  disabled: busy,
                  onClick: function () {
                    store.setOpen(false);
                  },
                },
                React.createElement(IconCloseOutline16, {}),
              ),
            ),
            React.createElement(
              'div',
              { className: 'baToolbar' },
              React.createElement(
                'label',
                { className: 'baToolbarLabel' },
                React.createElement(Checkbox, {
                  checked: allSelected,
                  disabled: busy || allIds.length === 0,
                  onChange: toggleAll,
                  'aria-label': '全选',
                }),
                React.createElement('span', null, '全选'),
              ),
              React.createElement(
                'span',
                { className: 'baToolbarCount' },
                '已选 ' + selectedCount + ' / ' + allIds.length,
              ),
            ),
            React.createElement('div', { className: 'baList' }, rows),
            React.createElement(
              'div',
              { className: 'baFooter' },
              React.createElement(
                'div',
                {
                  className: 'baFooterMsg' + (phase === 'error' ? ' baError' : ''),
                  title: message,
                },
                message,
              ),
              React.createElement(
                Btn,
                { variant: 'outline', disabled: busy, onClick: cancelAction },
                cancelLabel,
              ),
              React.createElement(
                Btn,
                {
                  variant: phase === 'confirm' ? 'outline' : 'primary',
                  className: phase === 'confirm' ? 'baDanger' : undefined,
                  disabled: busy || selectedCount === 0,
                  onClick: primaryAction,
                },
                primaryLabel,
              ),
            ),
          ),
        );
      }

      // ---- 槽位注册(独立 cell, 不替换任何 shipped entry) ----
      // sidebar.footer.action 的声明在 boot 期间可能被侧边栏条目短暂重声明,
      // inject 回调里的 register 抛错会被 defer 成微任务、静默丢失 ——
      // 这里对 footer 注册做自愈重试, 直到成功或插件卸载。
      slots.inject('sidebar.footer.action', function () {
        var stopped = false;
        var timer = null;
        var disposeEntry = null;
        function attempt() {
          if (stopped) return;
          try {
            disposeEntry = slots.register(
              { name: 'sidebar.footer.action', id: 'batch-archive', order: 10, label: '批量归档' },
              FooterAction,
            );
          } catch (_err) {
            timer = setTimeout(function () {
              timer = null;
              attempt();
            }, 200);
          }
        }
        attempt();
        return function () {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          if (typeof disposeEntry === 'function') disposeEntry();
        };
      });

      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'batch-archive-panel', order: 200, label: '批量归档' },
          BatchArchivePanel,
        );
      });
    };

    return module.exports;
  },
});
