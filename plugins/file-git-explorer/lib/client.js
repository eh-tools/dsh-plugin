// dsh-file-git-explorer — client half(静态浏览器 bundle)
//
// 与动态插件 client 半的差异: 沙箱内置符号换成真实模块表依赖 —— React 经
// require('react') 解析(loader 种子模块), host.call 换成 fetch('/fge/api/<method>')
// (带 x-dsh-plugin: 1 头), styles.insert 换成手动 <style> 注入。
// 槽位注册 API(slots.inject / slots.register)与动态完全一致。
//
// 座位(均为官方右侧栏体系, 见 README「实现事实」):
//   · kind 'fge-git'   → 右侧栏「Git 树」页签: 分支/变更/diff/提交历史
//   · kind 'fge-shell' → 右侧栏「终端」页签: 真 PTY(经 WebSocket)
//   · conversation.composer.dock → 终端抽屉的「收起舌」, in-flow 展开推挤会话列
//
// React 组件只拿官方注入的 props(useTabInfo / sessionId / useSessions 等),
// 不 import 任何官方包 —— 官方内部模块名跨构建不稳定。
window.__ModuleLoader__.load({
  id: 'dsh-file-git-explorer',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');

    exports.name = 'dsh-file-git-explorer';

    /** 官方右侧栏注册表 + 槽位注册表。 */
    exports.inject = ['slots', 'sidebarRightTabs'];

    exports.apply = function (ctx) {
      var slots = ctx.slots;
      var h = React.createElement;

      // ---- 身份 ----
      var GIT_ID = 'dsh-file-git-explorer/git';
      var GIT_KIND = 'fge-git';
      var SHELL_ID = 'dsh-file-git-explorer/shell';
      var SHELL_KIND = 'fge-shell';

      var API_BASE = '/fge/api';
      var VENDOR_BASE = '/fge/vendor';
      var WS_PATH = '/fge/ws/terminal';
      var TERM_HEIGHT_KEY = 'fge-term-height-v1';
      var TERM_MIN_PCT = 20;
      var TERM_MAX_PCT = 70;

      // ---- host 调用 ----

      function api(method, payload) {
        return fetch(API_BASE + '/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-plugin': '1' },
          body: JSON.stringify(payload || {}),
        }).then(function (res) {
          if (!res.ok) throw new Error('fge: http ' + String(res.status));
          return res.json();
        });
      }

      // ---- 会话根目录 ----

      /**
       * 当前会话工作区 cwd; 会话没有 cwd 时回退 null(由调用方落到 info.cwd)。
       * 快照形状: { current, byId: { [id]: { cwd, running } } }。
       */
      function useSessionCwd(useSessions, sessionId) {
        var value = null;
        if (typeof useSessions === 'function') {
          value = useSessions(function (s) {
            var id = sessionId || (s && s.current);
            var sess = s && s.byId && id ? s.byId[id] : null;
            return sess && typeof sess.cwd === 'string' && sess.cwd !== '' ? sess.cwd : null;
          });
        }
        if (typeof value !== 'string' && value !== null) return null;
        return value || null;
      }

      /** 当前会话的 agent 运行态: true→false 即 turn 结束。 */
      function useSessionRunning(useSessions, sessionId) {
        var value = false;
        if (typeof useSessions === 'function') {
          value = useSessions(function (s) {
            var id = sessionId || (s && s.current);
            var sess = s && s.byId && id ? s.byId[id] : null;
            return !!(sess && sess.running);
          });
        }
        return value === true;
      }

      // ---- 样式 ----

      function ensureStyles() {
        var id = 'fge-styles';
        if (document.getElementById(id)) return;
        var el = document.createElement('style');
        el.id = id;
        el.textContent = [
          '.fge-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--dsw-alias-text-base,inherit)}',
          '.fge-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.22));flex:0 0 auto}',
          '.fge-btn{border:0;background:transparent;cursor:pointer;padding:2px 5px;border-radius:4px;color:inherit;font-size:12px;line-height:1.4}',
          '.fge-btn:hover{background:rgba(128,128,128,.18)}',
          '.fge-btn[disabled]{opacity:.45;cursor:default}',
          '.fge-branch{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:11em}',
          '.fge-ab{display:inline-flex;gap:4px;font-variant-numeric:tabular-nums;opacity:.85}',
          '.fge-spacer{flex:1 1 auto}',
          '.fge-body{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 0}',
          '.fge-row{display:flex;align-items:center;gap:6px;padding:3px 9px;cursor:pointer;white-space:nowrap}',
          '.fge-row:hover{background:rgba(128,128,128,.16)}',
          '.fge-row[data-active="1"]{background:rgba(103,153,254,.18)}',
          '.fge-badge{flex:0 0 auto;width:1.15em;text-align:center;font-weight:700;border-radius:3px;font-size:11px;background:rgba(128,128,128,.2)}',
          '.fge-badge[data-b="M"]{color:#c9822b}.fge-badge[data-b="A"]{color:#3fa34d}.fge-badge[data-b="D"]{color:#d9534f}',
          '.fge-badge[data-b="R"]{color:#4a7fd9}.fge-badge[data-b="C"]{color:#4a7fd9}.fge-badge[data-b="U"]{color:#d9534f}',
          '.fge-path{overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}',
          '.fge-empty{padding:14px 10px;opacity:.65;text-align:center}',
          '.fge-pre{margin:0;padding:8px 10px;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.45;white-space:pre;overflow:auto;tab-size:4}',
          '.fge-dl-add{color:#3fa34d}.fge-dl-del{color:#d9534f}.fge-dl-meta{color:#4a7fd9;font-weight:600}',
          '.fge-commit{display:flex;flex-direction:column;gap:1px;padding:4px 9px;cursor:pointer;border-bottom:1px solid rgba(128,128,128,.14)}',
          '.fge-commit:hover{background:rgba(128,128,128,.16)}',
          '.fge-commit-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.fge-commit-meta{opacity:.6;font-size:11px}',
          '.fge-msg{margin:0;padding:8px 10px;white-space:pre-wrap;font-family:inherit;font-size:12px;line-height:1.5;border-bottom:1px solid rgba(128,128,128,.2)}',
          '.fge-numstat{display:flex;gap:8px;align-items:baseline}',
          '.fge-numstat b{font-weight:600;font-size:11px;font-variant-numeric:tabular-nums}',
          // 终端抽屉: in-flow, 展开时推挤会话列(不做 fixed 悬浮)。
          '.fge-term{display:flex;flex-direction:column;border-top:1px solid rgba(103,153,254,.5);background:var(--dsw-alias-bg-base,rgba(0,0,0,.18))}',
          '.fge-term-head{display:flex;align-items:center;gap:6px;padding:2px 8px;font-size:11.5px}',
          '.fge-term-grip{height:5px;cursor:ns-resize;background:transparent}',
          '.fge-term-grip:hover{background:rgba(103,153,254,.45)}',
          '.fge-term-body{flex:1 1 auto;min-height:0;padding:2px 4px 4px}',
          '.fge-term-body .xterm{height:100%}',
          '.fge-tongue{display:flex;align-items:center;gap:6px;padding:1px 8px;cursor:pointer;font-size:11.5px;color:rgb(103,153,254);user-select:none}',
          '.fge-tongue:hover{background:rgba(103,153,254,.12)}',
          '.fge-dot{width:6px;height:6px;border-radius:50%;background:rgb(103,153,254);opacity:.75}',
          '.fge-stack{display:flex;align-items:center;gap:4px;flex:0 0 auto;overflow:hidden}',
          '.fge-chip{font-size:11px;padding:0 5px;border-radius:999px;background:rgba(128,128,128,.2);white-space:nowrap}',
        ].join('\n');
        document.head.appendChild(el);
      }

      // ---- vendor 资产: xterm 走静态资源路由 ----
      //
      // 刻意不把 xterm 内联进 client bundle: 那会 +300KB, 且浏览器模块表解析不到
      // 任意 node_modules。改由 host 的白名单路由伺服官方构建产物。

      var xtermPromise = null;

      function loadScript(src) {
        return new Promise(function (resolve, reject) {
          var el = document.createElement('script');
          el.src = src;
          el.async = false;
          el.onload = function () {
            resolve();
          };
          el.onerror = function () {
            reject(new Error('fge: failed to load ' + src));
          };
          document.head.appendChild(el);
        });
      }

      function ensureXterm() {
        if (xtermPromise !== null) return xtermPromise;
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = VENDOR_BASE + '/xterm.css';
        document.head.appendChild(link);
        xtermPromise = loadScript(VENDOR_BASE + '/xterm.js')
          .then(function () {
            return loadScript(VENDOR_BASE + '/addon-fit.js');
          })
          .then(function () {
            var Terminal = window.Terminal;
            var ns = window.FitAddon;
            var Fit = ns && (ns.FitAddon || ns);
            if (typeof Terminal !== 'function' || typeof Fit !== 'function') {
              throw new Error('fge: xterm 全局未按预期暴露');
            }
            return { Terminal: Terminal, FitAddon: Fit };
          });
        return xtermPromise;
      }

      // ---- 终端抽屉的共享开关(页签按钮 / dock 收起舌 / 终端页签共用) ----

      var drawerListeners = new Set();
      var drawerOpen = false;

      function setDrawer(next) {
        if (drawerOpen === next) return;
        drawerOpen = next;
        drawerListeners.forEach(function (fn) {
          fn(next);
        });
      }

      function useDrawerOpen() {
        var pair = React.useState(drawerOpen);
        var value = pair[0];
        var setValue = pair[1];
        React.useEffect(function () {
          drawerListeners.add(setValue);
          setValue(drawerOpen);
          return function () {
            drawerListeners.delete(setValue);
          };
        }, []);
        return value;
      }

      /** 按工作区记忆的抽屉高度(占视口百分比)。 */
      function readTermHeight(key) {
        try {
          var raw = window.localStorage.getItem(TERM_HEIGHT_KEY);
          var map = raw ? JSON.parse(raw) : {};
          var pct = map && typeof map[key] === 'number' ? map[key] : 40;
          return Math.min(TERM_MAX_PCT, Math.max(TERM_MIN_PCT, pct));
        } catch (e) {
          return 40;
        }
      }

      function writeTermHeight(key, pct) {
        try {
          var raw = window.localStorage.getItem(TERM_HEIGHT_KEY);
          var map = raw ? JSON.parse(raw) : {};
          map[key] = pct;
          window.localStorage.setItem(TERM_HEIGHT_KEY, JSON.stringify(map));
        } catch (e) {
          // localStorage 不可写时只是不记忆, 不影响功能
        }
      }

      // ---- 终端视图(真 PTY over WebSocket) ----

      /**
       * 一个 xterm 实例 ↔ 一条 WebSocket ↔ 该工作区的常驻 PTY。
       * 同工作区的多个实例各自连一条 WS, 输出由 host 广播(输入皆可)。
       */
      function TerminalView(props) {
        var root = props.root;
        var visible = props.visible !== false;
        var hostRef = React.useRef(null);
        var termRef = React.useRef(null);
        var fitRef = React.useRef(null);
        var wsRef = React.useRef(null);
        var statePair = React.useState('loading');
        var state = statePair[0];
        var setState = statePair[1];

        React.useEffect(
          function () {
            if (!visible || typeof root !== 'string' || root === '') return undefined;
            var disposed = false;
            var term = null;
            var ws = null;
            var fit = null;
            var ro = null;
            var onData = null;

            ensureXterm()
              .then(function (mod) {
                if (disposed || hostRef.current === null) return;
                term = new mod.Terminal({
                  convertEol: false,
                  cursorBlink: true,
                  fontSize: 12,
                  scrollback: 2000,
                  theme: { background: 'rgba(0,0,0,0)', selectionBackground: 'rgba(103,153,254,.35)' },
                });
                fit = new mod.FitAddon();
                term.loadAddon(fit);
                term.open(hostRef.current);
                termRef.current = term;
                fitRef.current = fit;
                try {
                  fit.fit();
                } catch (e) {
                  // 容器尚未布局, 由 ResizeObserver 补
                }

                var url =
                  WS_PATH +
                  '?root=' +
                  encodeURIComponent(root) +
                  '&cols=' +
                  String(term.cols) +
                  '&rows=' +
                  String(term.rows);
                ws = new WebSocket(
                  (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
                    window.location.host +
                    url,
                );
                ws.binaryType = 'arraybuffer';
                wsRef.current = ws;

                ws.onopen = function () {
                  if (!disposed) setState('open');
                };
                ws.onmessage = function (ev) {
                  if (disposed || term === null) return;
                  if (typeof ev.data === 'string') {
                    // 文本帧 = 控制协议(见 lib/pty.js 顶部)
                    var msg = null;
                    try {
                      msg = JSON.parse(ev.data);
                    } catch (e) {
                      msg = null;
                    }
                    if (msg && msg.t === 'exit') {
                      term.write(
                        '\r\n\x1b[90m[进程已结束' +
                          (msg.code === null || msg.code === undefined
                            ? ''
                            : ' 退出码 ' + String(msg.code)) +
                          ']\x1b[0m\r\n',
                      );
                    } else if (msg && msg.t === 'error') {
                      term.write('\r\n\x1b[31m[fge] ' + String(msg.error) + '\x1b[0m\r\n');
                    }
                    return;
                  }
                  term.write(new Uint8Array(ev.data));
                };
                ws.onclose = function () {
                  if (!disposed) setState('closed');
                };
                ws.onerror = function () {
                  if (!disposed) setState('error');
                };

                onData = term.onData(function (data) {
                  // ⚠ 必须走**二进制帧**: 文本帧在本协议里专供 JSON 控制消息,
                  // host 收到非 JSON 的文本帧会直接丢弃 —— 那样键入就全丢了。
                  if (ws !== null && ws.readyState === 1) {
                    ws.send(new TextEncoder().encode(data));
                  }
                });

                // 尺寸变化同步 PTY cols/rows
                if (typeof ResizeObserver === 'function') {
                  ro = new ResizeObserver(function () {
                    if (disposed || fit === null || ws === null) return;
                    try {
                      fit.fit();
                    } catch (e) {
                      return;
                    }
                    if (ws.readyState === 1) {
                      ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
                    }
                  });
                  ro.observe(hostRef.current);
                }
              })
              .catch(function (err) {
                if (!disposed) {
                  setState('error');
                  if (hostRef.current !== null) {
                    hostRef.current.textContent = String((err && err.message) || err);
                  }
                }
              });

            return function () {
              disposed = true;
              if (ro !== null) ro.disconnect();
              if (onData !== null) onData.dispose();
              if (ws !== null) {
                try {
                  ws.close();
                } catch (e) {
                  // 忽略
                }
              }
              if (term !== null) {
                try {
                  term.dispose();
                } catch (e) {
                  // 忽略
                }
              }
              termRef.current = null;
              fitRef.current = null;
              wsRef.current = null;
            };
          },
          [root, visible],
        );

        var hint = null;
        if (state === 'loading') hint = '正在连接终端…';
        else if (state === 'error') hint = '终端不可用(检查依赖与 host 日志)';
        else if (state === 'closed') hint = '连接已关闭, 重新打开即可重连';

        return h(
          'div',
          { className: 'fge-root' },
          hint === null
            ? null
            : h('div', { className: 'fge-empty' }, hint),
          h('div', { className: 'fge-term-body', ref: hostRef }),
        );
      }

      /** 终止当前工作区终端(■)。 */
      function killTerminal(root) {
        var ws = new WebSocket(
          (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
            window.location.host +
            WS_PATH +
            '?root=' +
            encodeURIComponent(root) +
            '&cols=80&rows=24',
        );
        ws.onopen = function () {
          ws.send(JSON.stringify({ t: 'kill' }));
          window.setTimeout(function () {
            try {
              ws.close();
            } catch (e) {
              // 忽略
            }
          }, 120);
        };
      }

      // ---- Git 树页签 ----

      function diffLines(text) {
        return String(text)
          .split('\n')
          .map(function (line, i) {
            var cls = null;
            if (line.startsWith('+++') || line.startsWith('---')) cls = 'fge-dl-meta';
            else if (line.startsWith('@@')) cls = 'fge-dl-meta';
            else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'fge-dl-meta';
            else if (line.startsWith('+')) cls = 'fge-dl-add';
            else if (line.startsWith('-')) cls = 'fge-dl-del';
            return h(
              'div',
              { key: String(i), className: cls === null ? undefined : cls },
              line === '' ? ' ' : line,
            );
          });
      }

      function formatTime(sec) {
        try {
          return new Date(sec * 1000).toLocaleString();
        } catch (e) {
          return '';
        }
      }

      function GitTabBody(props) {
        var useTabInfo = props.useTabInfo;
        var sessionId = props.sessionId;
        var useSessions = props.useSessions;

        var tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
        var visible = !!(tabInfo && tabInfo.tab && tabInfo.tab.visible);

        var sessionCwd = useSessionCwd(useSessions, sessionId);
        var running = useSessionRunning(useSessions, sessionId);
        var drawer = useDrawerOpen();

        var infoPair = React.useState(null);
        var info = infoPair[0];
        var setInfo = infoPair[1];
        var statusPair = React.useState(null);
        var status = statusPair[0];
        var setStatus = statusPair[1];
        var viewPair = React.useState({ name: 'changes' });
        var view = viewPair[0];
        var setView = viewPair[1];
        var diffPair = React.useState(null);
        var diff = diffPair[0];
        var setDiff = diffPair[1];
        var histPair = React.useState(null);
        var history = histPair[0];
        var setHistory = histPair[1];
        var showPair = React.useState(null);
        var show = showPair[0];
        var setShow = showPair[1];
        var busyPair = React.useState(false);
        var busy = busyPair[0];
        var setBusy = busyPair[1];
        var errPair = React.useState(null);
        var error = errPair[0];
        var setError = errPair[1];

        var prevRunning = React.useRef(running);
        var lastAuto = React.useRef(0);
        var pendingAuto = React.useRef(false);

        var root = sessionCwd || (info ? info.cwd : null);

        var load = React.useCallback(
          function () {
            return api('info', sessionCwd ? { root: sessionCwd } : {})
              .then(function (res) {
                if (!res || res.ok !== true) throw new Error((res && res.error) || 'info-failed');
                setInfo(res);
                return api('status', { root: res.cwd, repoRoot: res.repoRoot || undefined });
              })
              .then(function (res) {
                if (!res || res.ok !== true) {
                  setStatus(null);
                  setError((res && res.error) || 'status-failed');
                  return null;
                }
                setError(null);
                setStatus(res);
                return res;
              })
              .catch(function (err) {
                setError(String((err && err.message) || err));
                return null;
              });
          },
          [sessionCwd],
        );

        // 首次 / 切换工作区: 重取 info + status, 并回到默认视图。
        React.useEffect(
          function () {
            setView({ name: 'changes' });
            setDiff(null);
            setHistory(null);
            setShow(null);
            load();
          },
          [load],
        );

        // 自动刷新: 仅 turn 结束(true→false)触发, 1s 冷却; 不可见时挂起、可见时补刷。
        React.useEffect(
          function () {
            var was = prevRunning.current;
            prevRunning.current = running;
            if (was && !running) {
              if (!visible) {
                pendingAuto.current = true;
                return;
              }
              var now = Date.now();
              if (now - lastAuto.current < 1000) return;
              lastAuto.current = now;
              load();
            }
          },
          [running, visible, load],
        );

        React.useEffect(
          function () {
            if (visible && pendingAuto.current) {
              pendingAuto.current = false;
              lastAuto.current = Date.now();
              load();
            }
          },
          [visible, load],
        );

        /** ⟳ 手动刷新: 先 sync(fetch, 限时 8s 失败放行), 再 info → status。 */
        var manualRefresh = React.useCallback(
          function () {
            if (busy) return;
            setBusy(true);
            var payload = sessionCwd ? { root: sessionCwd } : {};
            var timer = new Promise(function (resolve) {
              window.setTimeout(function () {
                resolve('timeout');
              }, 8000);
            });
            Promise.race([api('sync', payload).catch(function () { return null; }), timer])
              .then(function () {
                return load();
              })
              .then(function () {
                setBusy(false);
              })
              .catch(function () {
                setBusy(false);
              });
          },
          [busy, sessionCwd, load],
        );

        function openDiff(change) {
          setView({ name: 'diff', change: change });
          setDiff(null);
          setShow(null);
          api('diff', {
            repoRoot: status ? status.repoRoot : undefined,
            path: change.path,
            status: change.badge,
            from: change.origPath || undefined,
            root: root || undefined,
          })
            .then(function (res) {
              if (res && res.ok === true) setDiff(res);
              else setDiff({ ok: false, error: (res && res.error) || 'diff-failed' });
            })
            .catch(function (err) {
              setDiff({ ok: false, error: String((err && err.message) || err) });
            });
        }

        function openHistory(ref) {
          setView({ name: 'history', ref: ref || null });
          setHistory({ commits: [], loading: true, ref: ref || null, done: false });
          setShow(null);
          api('log', {
            repoRoot: status ? status.repoRoot : undefined,
            ref: ref || undefined,
            skip: 0,
            limit: 50,
            root: root || undefined,
          })
            .then(function (res) {
              if (res && res.ok === true) {
                setHistory({
                  commits: res.commits,
                  loading: false,
                  ref: res.ref || null,
                  head: res.head,
                  done: res.commits.length < 50,
                });
              } else {
                setHistory({ commits: [], loading: false, error: (res && res.error) || 'log-failed' });
              }
            })
            .catch(function (err) {
              setHistory({ commits: [], loading: false, error: String((err && err.message) || err) });
            });
        }

        function openCommit(hash) {
          setView({ name: 'cfile', hash: hash });
          setShow({ loading: true });
          api('show', { repoRoot: status ? status.repoRoot : undefined, hash: hash, root: root || undefined })
            .then(function (res) {
              if (res && res.ok === true) setShow(res);
              else setShow({ error: (res && res.error) || 'show-failed' });
            })
            .catch(function (err) {
              setShow({ error: String((err && err.message) || err) });
            });
        }

        function openCommitFile(hash, filePath) {
          setDiff({ loading: true });
          setView({ name: 'cfile', hash: hash, file: filePath });
          api('show', {
            repoRoot: status ? status.repoRoot : undefined,
            hash: hash,
            path: filePath,
            root: root || undefined,
          })
            .then(function (res) {
              if (res && res.ok === true) setDiff(res);
              else setDiff({ ok: false, error: (res && res.error) || 'diff-failed' });
            })
            .catch(function (err) {
              setDiff({ ok: false, error: String((err && err.message) || err) });
            });
        }

        // ---- 头部 ----
        var current = status ? status.current : null;
        var detached = !!(status && status.detached);
        var branchLabel = current || (detached ? '(分离 HEAD)' : status && status.initial ? '(无提交)' : '—');

        var head = h(
          'div',
          { className: 'fge-head' },
          view.name === 'changes'
            ? null
            : h(
                'button',
                {
                  className: 'fge-btn',
                  title: '返回',
                  onClick: function () {
                    // cfile: 带文件 diff 时先退回提交详情, 再退回历史。
                    if (view.name === 'cfile' && view.file) {
                      setView({ name: 'cfile', hash: view.hash });
                      setDiff(null);
                      return;
                    }
                    if (view.name === 'cfile') {
                      setView({ name: 'history', ref: history ? history.ref : null });
                      return;
                    }
                    setView({ name: 'changes' });
                    setDiff(null);
                  },
                },
                '‹',
              ),
          h('span', { className: 'fge-branch', title: branchLabel }, branchLabel),
          status && (status.ahead > 0 || status.behind > 0)
            ? h(
                'span',
                { className: 'fge-ab', title: '相对上游 ahead/behind' },
                status.ahead > 0 ? '↑' + String(status.ahead) : null,
                status.behind > 0 ? '↓' + String(status.behind) : null,
              )
            : null,
          h('span', { className: 'fge-spacer' }),
          h(
            'button',
            {
              className: 'fge-btn',
              title: '提交历史',
              onClick: function () {
                if (view.name === 'history') {
                  setView({ name: 'changes' });
                  return;
                }
                openHistory(null);
              },
            },
            '⏱',
          ),
          h(
            'button',
            {
              className: 'fge-btn',
              title: '终端',
              onClick: function () {
                setDrawer(!drawer);
              },
            },
            '❯_',
          ),
          h(
            'button',
            {
              className: 'fge-btn',
              title: '刷新(先 fetch --prune)',
              disabled: busy,
              onClick: manualRefresh,
            },
            busy ? '…' : '⟳',
          ),
        );

        // ---- 主体 ----
        var body = null;

        if (error !== null && status === null) {
          body = h('div', { className: 'fge-empty' }, '非 git 工作区或 git 不可用(' + error + ')');
        } else if (view.name === 'changes') {
          var changes = status ? status.changes : [];
          if (status === null) body = h('div', { className: 'fge-empty' }, '读取中…');
          else if (changes.length === 0) body = h('div', { className: 'fge-empty' }, '(工作区干净)');
          else {
            body = h(
              'div',
              null,
              changes.map(function (c) {
                return h(
                  'div',
                  {
                    key: c.kind + ':' + c.path,
                    className: 'fge-row',
                    title: c.origPath ? c.path + ' ← ' + c.origPath : c.path,
                    onClick: function () {
                      openDiff(c);
                    },
                  },
                  h('span', { className: 'fge-badge', 'data-b': c.badge }, c.badge),
                  h('span', { className: 'fge-path' }, c.path),
                );
              }),
            );
          }
        } else if (view.name === 'diff') {
          if (diff === null) body = h('div', { className: 'fge-empty' }, '读取 diff…');
          else if (diff.ok === false) body = h('div', { className: 'fge-empty' }, 'diff 失败(' + diff.error + ')');
          else if (diff.kind === 'untracked')
            body = h(
              'div',
              { className: 'fge-empty' },
              '未跟踪文件 —— git 没有 diff 可比(可在编辑器里查看内容)',
            );
          else if (String(diff.text).trim() === '')
            body = h('div', { className: 'fge-empty' }, '(无差异)');
          else body = h('pre', { className: 'fge-pre' }, diffLines(diff.text));
        } else if (view.name === 'history') {
          if (history === null || history.loading) body = h('div', { className: 'fge-empty' }, '读取历史…');
          else if (history.error) body = h('div', { className: 'fge-empty' }, '历史失败(' + history.error + ')');
          else if (history.commits.length === 0) body = h('div', { className: 'fge-empty' }, '(无提交)');
          else {
            body = h(
              'div',
              null,
              history.commits.map(function (c) {
                return h(
                  'div',
                  {
                    key: c.hash,
                    className: 'fge-commit',
                    onClick: function () {
                      openCommit(c.hash);
                    },
                  },
                  h('div', { className: 'fge-commit-sub' }, c.subject),
                  h(
                    'div',
                    { className: 'fge-commit-meta' },
                    c.author + ' · ' + formatTime(c.at) + ' · ' + c.short,
                  ),
                );
              }),
            );
          }
        } else if (view.name === 'cfile') {
          if (show === null || show.loading) body = h('div', { className: 'fge-empty' }, '读取提交…');
          else if (show.error) body = h('div', { className: 'fge-empty' }, '提交失败(' + show.error + ')');
          else {
            var blocks = [
              h('pre', { key: 'msg', className: 'fge-msg' }, show.message || '(无提交说明)'),
            ];
            if (show.kind === 'merge') {
              blocks.push(
                h('div', { key: 'merge', className: 'fge-empty' }, 'merge 提交不展示 diff'),
              );
            } else {
              for (var i = 0; i < show.files.length; i += 1) {
                var f = show.files[i];
                blocks.push(
                  h(
                    'div',
                    {
                      key: 'f' + String(i),
                      className: 'fge-row',
                      onClick: function (path) {
                        return function () {
                          openCommitFile(view.hash, path);
                        };
                      }(f.path),
                    },
                    h(
                      'span',
                      { className: 'fge-numstat' },
                      h('b', { className: 'fge-dl-add' }, f.adds === null ? '·' : '+' + String(f.adds)),
                      h('b', { className: 'fge-dl-del' }, f.dels === null ? '·' : '−' + String(f.dels)),
                    ),
                    h('span', { className: 'fge-path' }, f.path),
                  ),
                );
              }
              if (show.files.length === 0) {
                blocks.push(h('div', { key: 'nofiles', className: 'fge-empty' }, '(无文件变更)'));
              }
            }
            // 历史里点开单文件 diff 时, diff 与详情同屏(上详情下 diff)。
            if (view.file !== undefined && diff !== null) {
              blocks.push(
                h(
                  'pre',
                  { key: 'diff', className: 'fge-pre' },
                  diff.ok === false ? 'diff 失败(' + diff.error + ')' : diffLines(diff.text || ''),
                ),
              );
            }
            body = h('div', null, blocks);
          }
        }

        return h('div', { className: 'fge-root' }, head, h('div', { className: 'fge-body' }, body));
      }

      function GitTabTitle() {
        return h('span', null, 'Git 树');
      }

      // ---- 终端页签 ----

      function ShellTabBody(props) {
        var useTabInfo = props.useTabInfo;
        var sessionId = props.sessionId;
        var useSessions = props.useSessions;
        var tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
        var visible = !!(tabInfo && tabInfo.tab && tabInfo.tab.visible);
        var sessionCwd = useSessionCwd(useSessions, sessionId);
        return h(TerminalView, { root: sessionCwd || '', visible: visible });
      }

      function ShellTabTitle() {
        return h('span', null, '终端');
      }

      // ---- 终端抽屉(dock 收起舌 + in-flow 展开) ----

      function TerminalDock(props) {
        var sessionId = props.sessionId;
        var useSessions = props.useSessions;
        var open = useDrawerOpen();
        var sessionCwd = useSessionCwd(useSessions, sessionId);
        var root = sessionCwd || '';
        var pctPair = React.useState(function () {
          return readTermHeight(root);
        });
        var pct = pctPair[0];
        var setPct = pctPair[1];

        React.useEffect(
          function () {
            setPct(readTermHeight(root));
          },
          [root],
        );

        // Esc 焦点分流: 焦点在终端内 → 交给终端; 否则关闭抽屉。
        React.useEffect(
          function () {
            if (!open) return undefined;
            function onKey(ev) {
              if (ev.key !== 'Escape') return;
              var el = document.activeElement;
              var host = document.getElementById('fge-term-host');
              if (host !== null && el !== null && host.contains(el)) return;
              setDrawer(false);
            }
            document.addEventListener('keydown', onKey, true);
            return function () {
              document.removeEventListener('keydown', onKey, true);
            };
          },
          [open],
        );

        function onGripDown(ev) {
          ev.preventDefault();
          var startY = ev.clientY;
          var startPct = pct;
          function onMove(e) {
            var deltaPct = ((startY - e.clientY) / window.innerHeight) * 100;
            var next = Math.min(TERM_MAX_PCT, Math.max(TERM_MIN_PCT, startPct + deltaPct));
            setPct(next);
          }
          function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            setPct(function (final) {
              writeTermHeight(root, final);
              return final;
            });
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }

        if (!open) {
          return h(
            'div',
            {
              className: 'fge-tongue',
              title: '展开终端抽屉',
              onClick: function () {
                setDrawer(true);
              },
            },
            h('span', { className: 'fge-dot' }),
            h('span', null, '终端'),
          );
        }

        return h(
          'div',
          { className: 'fge-term', style: { height: String(pct) + 'vh' } },
          h('div', { className: 'fge-term-grip', onMouseDown: onGripDown, title: '拖动调整高度' }),
          h(
            'div',
            { className: 'fge-term-head' },
            h('span', { className: 'fge-dot' }),
            h('span', { className: 'fge-chip' }, root || '(无工作区)'),
            h('span', { className: 'fge-spacer' }),
            h(
              'button',
              {
                className: 'fge-btn',
                title: '终止整棵终端进程树',
                onClick: function () {
                  if (root !== '') killTerminal(root);
                },
              },
              '■',
            ),
            h(
              'button',
              {
                className: 'fge-btn',
                title: '收起',
                onClick: function () {
                  setDrawer(false);
                },
              },
              '✕',
            ),
          ),
          h(
            'div',
            { className: 'fge-term-body', id: 'fge-term-host' },
            root === ''
              ? h('div', { className: 'fge-empty' }, '等待会话工作区…')
              : h(TerminalView, { root: root, visible: open }),
          ),
        );
      }

      // ---- 注册 ----

      ensureStyles();

      ctx.effect(
        function () {
          return ctx.sidebarRightTabs.register({
            id: GIT_ID,
            kind: GIT_KIND,
            // extension 档: 声明的 kind 是全新的, 不与任何 builtin 争位。
            priority: 'extension',
            title: function () {
              return 'Git 树';
            },
            guide: [
              {
                order: 60,
                title: function () {
                  return 'Git 树';
                },
                description: function () {
                  return '分支 / 变更 / diff / 提交历史';
                },
              },
            ],
          });
        },
        'fge: git tab type',
      );

      ctx.effect(
        function () {
          return ctx.sidebarRightTabs.register({
            id: SHELL_ID,
            kind: SHELL_KIND,
            priority: 'extension',
            title: function () {
              return '终端';
            },
            guide: [
              {
                order: 61,
                title: function () {
                  return '终端';
                },
                description: function () {
                  return '真 PTY(每工作区一个, 跨刷新存活)';
                },
              },
            ],
          });
        },
        'fge: shell tab type',
      );

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab', function () {
          return slots.register({ name: 'sidebar.right.pane.tab', key: GIT_ID }, GitTabBody);
        });
      }, 'fge: git tab body');

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab.title', function () {
          return slots.register({ name: 'sidebar.right.pane.tab.title', key: GIT_ID }, GitTabTitle);
        });
      }, 'fge: git tab title');

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab', function () {
          return slots.register({ name: 'sidebar.right.pane.tab', key: SHELL_ID }, ShellTabBody);
        });
      }, 'fge: shell tab body');

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab.title', function () {
          return slots.register(
            { name: 'sidebar.right.pane.tab.title', key: SHELL_ID },
            ShellTabTitle,
          );
        });
      }, 'fge: shell tab title');

      ctx.effect(function () {
        return slots.inject('conversation.composer.dock', function () {
          return slots.register(
            { name: 'conversation.composer.dock', id: 'fge-terminal', order: 50 },
            TerminalDock,
          );
        });
      }, 'fge: terminal dock');

      console.info('[fge] ready — 右侧栏「Git 树」/「终端」, composer 下的终端抽屉');
    };

    return module.exports;
  },
});
