// dsh-file-git-explorer — client half(静态浏览器 bundle)
//
// 与动态插件 client 半的差异: 沙箱内置符号换成真实模块表依赖 —— React 与 primitives
// 经 require 解析(loader 的种子模块表是封闭 9 项, 两者都在表内), host.call 换成
// fetch('/fge/api/<method>')(带 x-dsh-plugin: 1 头), styles.insert 换成手动 <style> 注入。
//
// 本插件的浏览器半边只有四件事:
//   1. kind 'fge-git'   右侧栏「git 页签」: 变更列表 + 提交历史, 提交**就地展开**;
//   2. kind 'fge-diff'  diff 详情页签: 一开出来就被浮起, 内容交给官方 primitives.DiffBlock;
//   3. conversation.composer.dock  终端抽屉的「抽屉舌」(居中、点击向上展开);
//   4. **影子替换**官方文档页签的芯片槽(`sidebar.right.pane.tab.title`, key = 官方 text
//      类型 id), 借它拿到该页签的 `tabId`, 再把官方正文页签 `ctx.sidebarRight.float()`
//      成一个悬浮面板 —— 于是 markdown / 代码 / 图片 / html / pdf 全是官方原版, 本插件零正文
//      渲染代码。拿 tabId 的路为什么只有这一条, 见 docs/adr/0003。
//
// ⚠ 影子替换的机制(实测 SlotCore.register): keyed 槽**同 key 同 priority 会直接抛错**,
//   渲染取的是排序后该 key 的**第一条**, 而排序按 priority **升序**(最低者渲染)。
//   官方 `text` 类型的 title 注册没有 priority(即 0), 所以本插件必须用**负数** priority。
//   (ADR-0003 原文写的"注册已占用的 key 会替换该占用者"不够准确, 已在 ADR 里补正。)
//
// ⚠ 单一悬浮面板: 文档详情与 diff 详情共用同一个 `floatTarget` 记账, 开新的先关旧的, 于是观感
//   就是"内容就地更换"。
window.__ModuleLoader__.load({
  id: 'dsh-file-git-explorer',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    exports.name = 'dsh-file-git-explorer';

    /** 官方右侧栏注册表 / 槽位注册表 / 悬浮面板控制面。 */
    exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];

    exports.apply = function (ctx) {
      var slots = ctx.slots;
      var h = React.createElement;

      // ---- 身份 ----

      var GIT_ID = 'dsh-file-git-explorer/git';
      var GIT_KIND = 'fge-git';
      var DIFF_ID = 'dsh-file-git-explorer/diff';
      var DIFF_KIND = 'fge-diff';
      /** 官方 text 正文类型的实现 id(= 页签芯片槽的 key, 见 ADR-0003)。 */
      var DOC_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview';
      /** 影子注册必须**低于**官方的 0, 否则同 key 同档直接抛错。 */
      var DOC_PRIORITY = -1;

      var API_BASE = '/fge/api';
      var VENDOR_BASE = '/fge/vendor';
      var WS_PATH = '/fge/ws/terminal';
      var TERM_HEIGHT_KEY = 'fge-term-height-v1';
      var TERM_MIN_PCT = 20;
      var TERM_MAX_PCT = 70;
      var TERM_DEFAULT_PCT = 40;
      var COMMIT_PAGE = 50;
      var DIFF_KEEP = 8;
      /** float() 的重试预算: 座位瞬时缺位(见 floatWithRetry)下一次就够, 这里留足余量。 */
      var FLOAT_ATTEMPTS = 6;
      var FLOAT_RETRY_MS = 60;

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
        if (typeof document === 'undefined') return;
        var id = 'fge-styles';
        if (document.getElementById(id) !== null) return;
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
          '.fge-body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 0 6px}',
          '.fge-section{display:flex;align-items:center;gap:6px;position:sticky;top:0;z-index:1;padding:4px 9px;font-size:11px;font-weight:600;letter-spacing:.02em;opacity:.72;background:var(--dsw-alias-bg-base,rgba(0,0,0,.18));border-bottom:1px solid rgba(128,128,128,.16)}',
          '.fge-select{flex:0 1 auto;min-width:0;max-width:11em;font-size:11px;padding:1px 2px;border-radius:4px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit}',
          '.fge-row{display:flex;align-items:center;gap:6px;padding:3px 9px;cursor:pointer;white-space:nowrap}',
          '.fge-row:hover{background:rgba(128,128,128,.16)}',
          '.fge-indent{padding-left:22px}',
          '.fge-badge{flex:0 0 auto;width:1.15em;text-align:center;font-weight:700;border-radius:3px;font-size:11px;background:rgba(128,128,128,.2)}',
          '.fge-badge[data-b="M"]{color:#c9822b}.fge-badge[data-b="A"]{color:#3fa34d}.fge-badge[data-b="D"]{color:#d9534f}',
          '.fge-badge[data-b="R"]{color:#4a7fd9}.fge-badge[data-b="C"]{color:#4a7fd9}.fge-badge[data-b="U"]{color:#d9534f}',
          '.fge-path{overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}',
          '.fge-empty{padding:14px 10px;opacity:.65;text-align:center}',
          '.fge-dl-add{color:#3fa34d}.fge-dl-del{color:#d9534f}',
          '.fge-commit{display:flex;flex-direction:column;gap:1px;padding:4px 9px;cursor:pointer;border-bottom:1px solid rgba(128,128,128,.14)}',
          '.fge-commit:hover{background:rgba(128,128,128,.16)}',
          '.fge-commit-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.fge-commit-meta{opacity:.6;font-size:11px}',
          '.fge-msg{margin:0;padding:6px 9px;white-space:pre-wrap;font-family:inherit;font-size:12px;line-height:1.5;border-bottom:1px solid rgba(128,128,128,.16)}',
          '.fge-numstat{flex:0 0 auto;display:flex;gap:6px;align-items:baseline;font-size:11px;font-variant-numeric:tabular-nums}',
          // diff 悬浮面板的正文: 官方 FloatLayer 的 body 自己会滚, 这里只管排布与留白。
          '.fge-diff{padding:6px 8px 10px}',
          // diff 页签的芯片文字: 只做截断, 版式交给 dockkit 的页签壳。
          '.fge-chip-label{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:22em}',
          // 影子芯片上的「复制内容」: 只占一枚小图标, 不吃掉页签的点击。
          '.fge-copy{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer}',
          '.fge-copy:hover{color:var(--dsw-alias-label-primary);background:rgba(128,128,128,.18)}',
          '.fge-copy[data-s="done"]{color:#3fa34d}',
          '.fge-copy[data-s="failed"]{color:#d9534f}',
          // 终端抽屉: 座位在 composer 之下(conversation.composer.dock), 居中靠对话根元素上的
          // --dsh-chat-content-width, 零 JS 测量。
          '.fge-term{display:flex;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width);margin-inline:auto;border-top:1px solid rgba(103,153,254,.5);background:var(--dsw-alias-bg-base,rgba(0,0,0,.18))}',
          '.fge-term-head{display:flex;align-items:center;gap:6px;padding:2px 8px;font-size:11.5px}',
          '.fge-term-grip{height:5px;cursor:ns-resize;background:transparent}',
          '.fge-term-grip:hover{background:rgba(103,153,254,.45)}',
          '.fge-term-body{flex:1 1 auto;min-height:0;padding:2px 4px 4px}',
          '.fge-term-body .xterm{height:100%}',
          // 抽屉舌: 透明、无边框的一枚 chevron, 居中(旧实现的观感, 见 v0.2 的 .fge-strip)。
          '.fge-tongue{display:flex;align-items:center;justify-content:center;width:100%;max-width:var(--dsh-chat-content-width);margin-inline:auto;padding:1px 0 3px;background:transparent;border:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;user-select:none}',
          '.fge-tongue:hover{color:var(--dsw-alias-label-primary)}',
          '.fge-chip{font-size:11px;padding:0 5px;border-radius:999px;background:rgba(128,128,128,.2);white-space:nowrap}',
        ].join('\n');
        document.head.appendChild(el);
      }

      // ---- 文件地址 + 读原文(lib/address.js 的内联副本; bundle 无法 import host ESM) ----

      var FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

      function isDriveSegment(segment) {
        return segment !== undefined && /^[A-Za-z]:$/.test(segment);
      }

      function parseFileAddress(address) {
        try {
          if (typeof address !== 'string' || address.indexOf(FILE_ADDRESS_PREFIX) !== 0) return null;
          var end = address.search(/[?#]/);
          var body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end);
          var parts = body.split('/');
          var scope = parts[0];
          var rest = parts.slice(1);

          if (scope === 'session') {
            var id = rest[0];
            var segments = rest.slice(1);
            if (id === undefined || id === '' || segments.length === 0) return null;
            return {
              scope: scope,
              sessionId: decodeURIComponent(id),
              path: segments.map(decodeURIComponent).join('/'),
            };
          }

          if (scope === 'absolute') {
            var unc = rest[0] === '' && rest.length > 1;
            var segs = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
            if (segs.length === 0 || segs[0] === '') return null;
            if (unc) return { scope: scope, path: '//' + segs.join('/') };
            return {
              scope: scope,
              path: isDriveSegment(segs[0]) ? segs.join('/') : '/' + segs.join('/'),
            };
          }

          return null;
        } catch (e) {
          return null;
        }
      }

      function extensionOf(path) {
        var value = String(path === undefined || path === null ? '' : path);
        var base = value.slice(value.lastIndexOf('/') + 1).slice(value.lastIndexOf('\\') + 1);
        var dot = base.lastIndexOf('.');
        if (dot <= 0 || dot === base.length - 1) return '';
        return base.slice(dot + 1).toLowerCase();
      }

      var RENDERED_EXTENSIONS = [
        'html',
        'htm',
        'xhtml',
        'pdf',
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'bmp',
        'ico',
        'avif',
        'svg',
      ];

      function isCopyableSource(path) {
        var ext = extensionOf(path);
        if (ext === '') return false;
        return RENDERED_EXTENSIONS.indexOf(ext) === -1;
      }

      function bytesToText(candidate) {
        if (typeof candidate === 'string') return candidate;
        if (candidate instanceof Uint8Array) return new TextDecoder().decode(candidate);
        if (Array.isArray(candidate)) return new TextDecoder().decode(Uint8Array.from(candidate));
        return null;
      }

      /** base64 → 文本(按字节解码, UTF-8 原文原样回来); 非法 base64 返回 null。 */
      function base64ToText(value) {
        try {
          var binary = atob(value);
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          return new TextDecoder().decode(bytes);
        } catch (e) {
          return null;
        }
      }

      /**
       * 把 Remote 的读取结果归一成文本。
       * ⚠ `workspaceFiles.readAll` 的 `value.data` 是 **base64**(不是明文), 必须按字节解 ——
       *   否则要么乱码, 要么把 base64 串本身复制进剪贴板。
       */
      function extractDocumentText(result) {
        if (result === null || result === undefined) return null;
        if (typeof result === 'string') return result;
        var direct = bytesToText(result);
        if (direct !== null) return direct;
        if (typeof result !== 'object') return null;
        if (result.ok === false) return null;
        var value = result.value !== undefined ? result.value : result;
        if (value === null || value === undefined) return null;
        if (typeof value === 'string') return value;
        var fromValue = bytesToText(value);
        if (fromValue !== null) return fromValue;
        if (typeof value !== 'object') return null;
        if (typeof value.text === 'string') return value.text;
        if (value.data !== undefined) {
          var fromData;
          if (typeof value.data === 'string') {
            fromData = base64ToText(value.data);
            if (fromData === null) fromData = value.data; // 不是合法 base64 就当普通字符串
          } else {
            fromData = bytesToText(value.data);
          }
          if (fromData !== null) return fromData;
        }
        return bytesToText(value.bytes);
      }

      /** 把"读不出文本"变成一句能查的话(而不是静默 null)。 */
      function readFailureReason(res) {
        if (res && res.ok === false && res.error !== undefined && res.error !== null) {
          return typeof res.error === 'string' ? res.error : JSON.stringify(res.error);
        }
        return '无法识别的返回形状';
      }

      // ---- 单一悬浮面板 ----

      /**
       * 当前由本插件浮起的详情: `{tabId, sessionId}` 或 null。
       * 两者一同生效、一同清掉 —— 会话换掉时也要知道旧的那个属于谁。
       */
      var floatTarget = null;

      /** 关页签; 返回是否成功(座位瞬时缺位时会抛错, 由调用方决定要不要重试)。 */
      function tryClose(tabId) {
        if (tabId === null || tabId === undefined) return true;
        try {
          ctx.sidebarRight.close(tabId);
          return true;
        } catch (err) {
          return false;
        }
      }

      /** 关掉本插件当前浮起的详情(幂等, 失败也不吵)。 */
      function closeOwnedFloat() {
        var target = floatTarget;
        floatTarget = null;
        if (target !== null) tryClose(target.tabId);
      }

      /**
       * 右栏左缘的视口 x。用**右栏列的 grid item**(`[data-rightbar-col]`)而不是里面那块面板:
       * 面板靠 CSS transform 滑入滑出, 展开动画期间量它只会拿到中间值; 列本身不动。
       * @returns {number|null} 列宽为 0(右栏收起)时 null
       */
      function rightbarLeft() {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
          return null;
        }
        var col = document.querySelector('[data-rightbar-col]');
        if (col === null) return null;
        var rect = col.getBoundingClientRect();
        if (!(rect.width > 0)) return null;
        return rect.left;
      }

      /**
       * 悬浮面板矩形: 视口宽度 1/2、满高顶到底、右缘贴右栏左缘。
       *
       * ⚠ 只在**浮起那一刻**算一次: 官方没有移动 / 缩放悬浮面板的公开接口
       * (`ctx.sidebarRight` 只有 close/focus/float/dock/split, `ctx.layout` 只有面板选择与右栏显隐),
       * 而 float() 对已浮起的页签是 no-op。所以换窗口尺寸之后面板不会自动重排 —— 见 README 已知限制。
       */
      function measureFloatRect() {
        var left = rightbarLeft();
        if (left === null) return null;
        var width = Math.round(window.innerWidth / 2);
        return {
          x: Math.round(left - width),
          y: 0,
          width: width,
          height: window.innerHeight,
        };
      }

      /**
       * 把某个页签采纳为唯一的悬浮详情: 关掉上一个(维持单面板), 再把它浮起来。
       *
       * 幂等: 对**已经浮起**的页签, 官方 float() 是 no-op, 所以重复调用是安全的 ——
       * 这也顺带解决了"用户按了悬浮面板头上的「送回侧栏」之后, 再点同一个文件应当重新浮起"。
       */
      function adoptFloat(tabId, sessionId) {
        if (tabId === null || tabId === undefined) return;
        var previous = floatTarget !== null && floatTarget.tabId !== tabId ? floatTarget.tabId : null;
        floatTarget = { tabId: tabId, sessionId: sessionId === undefined ? null : sessionId };
        floatWithRetry(tabId, 0, previous);
      }

      /**
       * 浮起 + 重试。**关掉上一个的动作也放在这个重试循环里** —— 理由见下。
       *
       * ⚠ 实测(真 boot + 真浏览器): **新页签挂载的那一次 commit 里, 直接调 sidebarRight 的
       * 命令会抛 `sidebarRight: no session surface is mounted`**。原因是官方座位的绑定写在
       * `useEffect(() => bindService({...}), [..., surfaces])` 里, 而新页签让 `surfaces` 变了:
       * 那次 flush 先跑**卸载**阶段(座位释放绑定)、再跑**挂载**阶段, 而挂载阶段是子先父后 ——
       * 我们这个芯片的 effect 正好夹在"座位已释放、尚未重绑"的空隙里。下一次事件循环绑定就回来了。
       *
       * 所以 close() 与 float() **都要重试**, 且必须在同一次尝试里按"先关后浮"的顺序做:
       * 只重试 float 的话, 第一次 close 悄悄失败, 结果就是两个悬浮面板并存(实测确实如此)。
       * 要么都成功, 要么一起再来一次。
       *
       * 另一种瞬时是右栏还没有轨道(列宽 0, 正在展开): 那时 rect 量不出来, 也要等一帧再量,
       * 否则面板会落在官方默认的级联位上。重试预算用尽还失败, 才按"右侧栏确实没有已挂载的会话
       * 座位"处理(官方文档明确这种情况会抛错, 调用点必须容错)。
       */
      function floatWithRetry(tabId, attempt, previous) {
        if (floatTarget === null || floatTarget.tabId !== tabId) return; // 期间用户又打开了别的详情
        var rect = measureFloatRect();
        if (rect === null && attempt < FLOAT_ATTEMPTS) {
          window.setTimeout(function () {
            floatWithRetry(tabId, attempt + 1, previous);
          }, FLOAT_RETRY_MS);
          return;
        }
        // 先关旧的。关不掉(座位瞬时缺位)就整体重来, 不能带着两个悬浮面板继续。
        if (previous !== null && !tryClose(previous) && attempt < FLOAT_ATTEMPTS) {
          window.setTimeout(function () {
            floatWithRetry(tabId, attempt + 1, previous);
          }, FLOAT_RETRY_MS);
          return;
        }
        try {
          ctx.sidebarRight.float(tabId, rect === null ? undefined : rect);
        } catch (err) {
          if (attempt < FLOAT_ATTEMPTS) {
            window.setTimeout(function () {
              floatWithRetry(tabId, attempt + 1, previous);
            }, FLOAT_RETRY_MS);
            return;
          }
          console.warn('[fge] 悬浮详情不可用(右侧栏没有已挂载的会话座位)', err);
          if (floatTarget !== null && floatTarget.tabId === tabId) floatTarget = null;
        }
      }

      // ---- 影子芯片:官方文档页签的标题(顺带把页签浮起来 + 复制内容) ----

      /**
       * 复刻官方芯片(`FileTypeIcon` + `tab.title`), 多一枚「复制内容」。
       * 它同时出现在**页签条**和**悬浮面板头部**两个位置(官方文档如此), 所以两种位置都得站得住。
       *
       * ⚠ 副作用放到 useEffect 里而不是渲染期: 渲染期调 float/close 会改布局 store。
       * 代价是"页签被浮起前会有一帧出现在页签条上" —— 官方 chrome 没有可注入的槽,
       * 这是影子替换方案已知且可接受的瞬时(见 ADR-0003)。
       */
      function DocTitle(props) {
        var sessionId = props.sessionId;
        var tab = tabOf(props.useTabInfo);
        var tabId = tab ? tab.id : null;
        var title = tab && typeof tab.title === 'string' ? tab.title : '';
        var visible = !!(tab && tab.visible);
        // 每导航到这个页签都会 +1(reveal 已存在的页签也算), 用它把"重新点同一个文件"也
        // 变成一次采纳 —— 用户在悬浮面板头上按过「送回侧栏」之后, 再点该文件应当重新浮起。
        var revision = tab && tab.navigation ? tab.navigation.revision : 0;
        var address = tab
          ? typeof tab.contentId === 'string' && tab.contentId !== ''
            ? tab.contentId
            : tab.navigation && typeof tab.navigation.address === 'string'
              ? tab.navigation.address
              : ''
          : '';

        // 会话换了: 旧悬浮面板属于上一个会话, 先关掉再采纳这一个。
        React.useEffect(
          function () {
            if (floatTarget !== null && sessionId !== undefined && floatTarget.sessionId !== sessionId) {
              closeOwnedFloat();
            }
          },
          [sessionId],
        );

        React.useEffect(
          function () {
            if (tabId === null || tabId === undefined) return undefined;
            // 右栏收起时页签不可见, 此刻不要浮起; 展开后这个 effect 会再跑一次。
            if (!visible) return undefined;
            adoptFloat(tabId, sessionId);
            return undefined;
          },
          [tabId, revision, visible, sessionId],
        );

        return h(
          React.Fragment,
          null,
          h(primitives.FileTypeIcon, {
            kind: primitives.classifyFileType(title),
            size: 16,
          }),
          title,
          h(FileCopyButton, { address: address, sessionId: sessionId }),
        );
      }

      /** 芯片上的「复制内容」: 复制该文件**磁盘上的原文**(不是预览出来的富文本)。 */
      function FileCopyButton(props) {
        var address = props.address;
        var sessionId = props.sessionId;
        var parsed = parseFileAddress(address);
        var pair = React.useState('idle');
        var state = pair[0];
        var setState = pair[1];

        React.useEffect(
          function () {
            if (state === 'idle' || state === 'busy') return undefined;
            var timer = window.setTimeout(function () {
              setState('idle');
            }, 1200);
            return function () {
              window.clearTimeout(timer);
            };
          },
          [state],
        );

        if (parsed === null || !isCopyableSource(parsed.path)) return null;

        function onClick(ev) {
          ev.preventDefault();
          ev.stopPropagation();
          if (state === 'busy') return;
          setState('busy');
          // ⚠ 只用 ctx.get 可选读取, 且**必须取点名的服务**:
          //   cordis 的 Context 对未 inject 的属性访问直接抛 `cannot get property "X" without inject`,
          //   而 `remote` 本身是个命名空间式服务 —— 取 ctx.get('remote') 拿回来的是它的 Context,
          //   再读 `.workspaceFiles` 会按点名 `remote.workspaceFiles` 触发同一道栅栏(实测的 pageerror)。
          //   官方 ui-sidebar-files 的做法是把 'remote' 与 'remote.workspaceFiles' 都写进 inject;
          //   本插件读的是可选的"附加能力", 所以改用 ctx.get 点名读取, 缺了只是不出复制图标。
          var readAll = null;
          try {
            var files = typeof ctx.get === 'function' ? ctx.get('remote.workspaceFiles') : undefined;
            var fn = files === undefined || files === null ? null : files.readAll;
            if (typeof fn === 'function') readAll = fn;
          } catch (err) {
            console.warn('[fge] 读不到 remote.workspaceFiles(复制内容不可用)', err);
          }
          if (readAll === null) {
            setState('failed');
            return;
          }
          Promise.resolve(readAll(parsed.sessionId || sessionId, parsed.path, undefined))
            .then(function (res) {
              var text = extractDocumentText(res);
              if (text === null) throw new Error('读不到文本: ' + readFailureReason(res));
              return primitives.writeClipboard(text);
            })
            .then(function (ok) {
              setState(ok === false ? 'failed' : 'done');
            })
            .catch(function (err) {
              console.warn('[fge] 复制内容失败', err);
              setState('failed');
            });
        }

        var label = state === 'done' ? '已复制' : state === 'failed' ? '复制失败' : '复制内容';
        var Icon =
          state === 'done'
            ? primitives.IconCheckOutline16
            : state === 'failed'
              ? primitives.IconWarningOutline16
              : primitives.IconCopyOutline16;

        return h(
          'button',
          {
            type: 'button',
            className: 'fge-copy',
            'data-s': state,
            title: label + ' · ' + parsed.path,
            'aria-label': label,
            // 页签条与悬浮面板头部都靠 pointerdown 起拖拽/选中, 这里必须吃掉, 否则点图标会拖走页签。
            onPointerDown: function (ev) {
              ev.stopPropagation();
            },
            onClick: onClick,
          },
          h(Icon, { size: 14 }),
        );
      }

      // ---- diff 页签(第二个 kind): 开出来即被浮起 ----

      /** token → diff 详情。只把 token 放进页签的 navigation.params, 免得把 diff 正文写进会话布局记录。 */
      var diffs = new Map();
      var diffSeq = 0;

      var DIFF_LABELS = {
        copy: '复制',
        copied: '已复制',
        files: function (n) {
          return String(n) + ' 个文件';
        },
        expand: function (n) {
          return '展开另外 ' + String(n) + ' 行';
        },
        expandAria: function (n) {
          return '展开另外 ' + String(n) + ' 行';
        },
        collapse: '收起',
        collapseAria: '收起',
      };

      function putDiff(detail) {
        diffSeq += 1;
        var token = String(diffSeq);
        diffs.set(token, detail);
        while (diffs.size > DIFF_KEEP) {
          var oldest = diffs.keys().next();
          if (oldest.done === true) break;
          diffs.delete(oldest.value);
        }
        return token;
      }

      /**
       * 把一份 diff 详情开成(并浮起)悬浮面板。
       * 页面类型在同一个 pane 内会**去重**, 所以第二次点文件是"就地换内容": 页签不新增,
       * 但 navigation 会重新下发(params 变、revision 递增), 标题与正文据此重渲染。
       */
      function openDiff(detail) {
        var token = putDiff(detail);
        try {
          ctx.sidebarRight.openTab(DIFF_KIND, { params: { token: token } });
        } catch (err) {
          console.warn('[fge] 打不开 diff 悬浮面板', err);
        }
      }

      /**
       * 从 `useTabInfo()` 派生的页签信息里读回本页签指向的 diff 详情。
       * 标题芯片与正文都要这一步(同一个 token 记账), 所以只写一遍。
       * @returns {{tabId: string|null, revision: number, detail: object|undefined}}
       */
      function diffDetailOf(tab) {
        var params = tab && tab.navigation ? tab.navigation.params : null;
        var token = params && typeof params.token === 'string' ? params.token : null;
        return {
          tabId: tab ? tab.id : null,
          revision: tab && tab.navigation ? tab.navigation.revision : 0,
          detail: token === null ? undefined : diffs.get(token),
        };
      }

      /** 页签信息 hook → 当前 tab 记录(拿不到时 null)。 */
      function tabOf(useTabInfo) {
        var info = typeof useTabInfo === 'function' ? useTabInfo() : null;
        return info && info.tab ? info.tab : null;
      }

      function DiffTabTitle(props) {
        var found = diffDetailOf(tabOf(props.useTabInfo));
        var sessionId = props.sessionId;

        React.useEffect(
          function () {
            if (found.tabId === null || found.tabId === undefined) return undefined;
            adoptFloat(found.tabId, sessionId);
            return undefined;
          },
          [found.tabId, found.revision, sessionId],
        );

        var label = found.detail && found.detail.path ? found.detail.path : 'diff';
        return h('span', { className: 'fge-chip-label', title: label }, label);
      }

      function DiffTabBody(props) {
        var detail = diffDetailOf(tabOf(props.useTabInfo)).detail;

        if (detail === undefined) {
          return h('div', { className: 'fge-empty' }, '(详情已失效, 请重新点开)');
        }
        if (detail.error) {
          return h('div', { className: 'fge-empty' }, '读取失败(' + detail.error + ')');
        }
        if (detail.kind === 'untracked') {
          return h(
            'div',
            { className: 'fge-empty' },
            '未跟踪文件 —— git 没有 diff 可比(可在编辑器里查看内容)',
          );
        }
        if (!Array.isArray(detail.hunks) || detail.hunks.length === 0) {
          return h('div', { className: 'fge-empty' }, '(无内容差异: 纯 mode 变化 / 二进制 / 纯改名)');
        }
        return h(
          'div',
          { className: 'fge-diff' },
          h(primitives.DiffBlock, { diffs: detail.hunks, labels: DIFF_LABELS }),
        );
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

      // ---- 终端抽屉的共享开关 ----

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
          var pct = map && typeof map[key] === 'number' ? map[key] : TERM_DEFAULT_PCT;
          return Math.min(TERM_MAX_PCT, Math.max(TERM_MIN_PCT, pct));
        } catch (e) {
          return TERM_DEFAULT_PCT;
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
                  theme: {
                    background: 'rgba(0,0,0,0)',
                    selectionBackground: 'rgba(103,153,254,.35)',
                  },
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
          hint === null ? null : h('div', { className: 'fge-empty' }, hint),
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

      // ---- Git 页签: 变更列表 + 提交历史 ----

      function formatTime(sec) {
        try {
          return new Date(sec * 1000).toLocaleString();
        } catch (e) {
          return '';
        }
      }

      /**
       * 本插件的常驻 git 页签。
       *
       * 页签内是**两份列表**(变更列表 + 提交历史), 点提交**就地展开**它的文件, 所以
       * 页签内没有「返回上一层」这件事。点任一文件(变更行的、或提交展开出来的)都把
       * diff 送进悬浮面板 —— git 本体不开悬浮面板。
       */
      function GitTabBody(props) {
        var useTabInfo = props.useTabInfo;
        var sessionId = props.sessionId;
        var useSessions = props.useSessions;

        var tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
        var visible = !!(tabInfo && tabInfo.tab && tabInfo.tab.visible);

        var sessionCwd = useSessionCwd(useSessions, sessionId);
        var running = useSessionRunning(useSessions, sessionId);

        var infoPair = React.useState(null);
        var info = infoPair[0];
        var setInfo = infoPair[1];
        var statusPair = React.useState(null);
        var status = statusPair[0];
        var setStatus = statusPair[1];
        var errorPair = React.useState(null);
        var error = errorPair[0];
        var setError = errorPair[1];
        var busyPair = React.useState(false);
        var busy = busyPair[0];
        var setBusy = busyPair[1];
        var refPair = React.useState('');
        var viewedRef = refPair[0];
        var setViewedRef = refPair[1];
        var histPair = React.useState(null);
        var history = histPair[0];
        var setHistory = histPair[1];
        var expPair = React.useState({});
        var expanded = expPair[0];
        var setExpanded = expPair[1];

        /** 最近一次 info/status 得到的根, 供各次 git 调用复用(避免把 status 塞进所有依赖)。 */
        var repoRef = React.useRef({ root: null, repoRoot: null });
        var handlers = React.useRef({});

        var root = sessionCwd || (info ? info.cwd : null);

        function loadStatus() {
          return api('info', sessionCwd ? { root: sessionCwd } : {})
            .then(function (res) {
              if (!res || res.ok !== true) throw new Error((res && res.error) || 'info-failed');
              setInfo(res);
              repoRef.current.root = res.cwd;
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
              repoRef.current.repoRoot = res.repoRoot;
              return res;
            })
            .catch(function (err) {
              setError(String((err && err.message) || err));
              return null;
            });
        }

        function loadHistory(ref, skip) {
          var append = skip > 0;
          if (!append) {
            setHistory({ commits: [], loading: true, done: false, ref: ref || null, error: null });
          }
          return api(
            'log',
            gitPayload({
              ref: ref || undefined,
              skip: skip,
              limit: COMMIT_PAGE,
            }),
          )
            .then(function (res) {
              if (!res || res.ok !== true) {
                setHistory({
                  commits: [],
                  loading: false,
                  done: true,
                  ref: ref || null,
                  error: (res && res.error) || 'log-failed',
                });
                return;
              }
              setHistory(function (prev) {
                var base = append && prev && prev.commits ? prev.commits : [];
                var commits = base.concat(res.commits);
                return {
                  commits: commits,
                  loading: false,
                  done: res.commits.length < COMMIT_PAGE,
                  ref: res.ref || null,
                  error: null,
                };
              });
            })
            .catch(function (err) {
              setHistory({
                commits: [],
                loading: false,
                done: true,
                ref: ref || null,
                error: String((err && err.message) || err),
              });
            });
        }

        /** 首次 / 切工作区: 重取 info → status, 再看一次历史首页。 */
        function reload() {
          return loadStatus().then(function (stat) {
            if (stat !== null) return loadHistory(viewedRef || null, 0);
            return null;
          });
        }

        // 每次渲染都把最新闭包放进 ref, 供 effect / 延时回调取用(避免依赖数组抖动)。
        handlers.current = { reload: reload, loadHistory: loadHistory };

        React.useEffect(
          function () {
            setViewedRef('');
            setExpanded({});
            setHistory(null);
            closeOwnedFloat(); // 切工作区: 详情悬浮面板关掉
            handlers.current.reload();
          },
          [sessionCwd],
        );

        // 自动刷新: 仅 turn 结束(true→false)触发, 1s 冷却。
        // 页签不可见时**挂起**、可见时**补刷**(CONTEXT「刷新」的语义), 所以记一个 pending 标记。
        var prevRunning = React.useRef(running);
        var lastAuto = React.useRef(0);
        var pendingAuto = React.useRef(false);
        React.useEffect(
          function () {
            var was = prevRunning.current;
            prevRunning.current = running;
            if (!was || running) return;
            if (!visible) {
              pendingAuto.current = true;
              return;
            }
            var now = Date.now();
            if (now - lastAuto.current < 1000) return;
            lastAuto.current = now;
            // 只重取会变的东西: 变更列表与历史首页。提交详情是不可变的, 不必重取。
            handlers.current.reload();
          },
          [running, visible],
        );

        // 补刷: 页签重新可见且挂起过, 就补一次(同样受 1s 冷却约束)。
        React.useEffect(
          function () {
            if (!visible || !pendingAuto.current) return;
            var now = Date.now();
            if (now - lastAuto.current < 1000) return;
            pendingAuto.current = false;
            lastAuto.current = now;
            handlers.current.reload();
          },
          [visible],
        );

        /** ⟳ 手动刷新: 先 sync(fetch, 限时 8s 失败放行), 再 info → status → 历史首页。 */
        function manualRefresh() {
          if (busy) return;
          setBusy(true);
          var payload = sessionCwd ? { root: sessionCwd } : {};
          var timer = new Promise(function (resolve) {
            window.setTimeout(function () {
              resolve('timeout');
            }, 8000);
          });
          Promise.race([api('sync', payload).catch(function () {
            return null;
          }), timer])
            .then(function () {
              return handlers.current.reload();
            })
            .then(function () {
              setBusy(false);
            })
            .catch(function () {
              setBusy(false);
            });
        }

        /** 每次 git 调用都要带的根: repoRoot 由上一次 status 带回, root 是当前工作区。 */
        function gitPayload(extra) {
          var payload = { root: root || undefined };
          if (repoRef.current.repoRoot) payload.repoRoot = repoRef.current.repoRoot;
          for (var key in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
          }
          return payload;
        }

        /**
         * 一次 git 请求 → diff 悬浮面板。变更行(`diff` 路由)与提交里的文件行(`show` 路由)
         * 只有请求不同, 落地方式完全一样, 所以只写一遍。
         */
        function openDiffFrom(path, request) {
          request
            .then(function (res) {
              if (res && res.ok === true) {
                openDiff({
                  path: path,
                  kind: res.kind,
                  hunks: res.hunks || [],
                  text: res.text || '',
                });
              } else {
                openDiff({ path: path, error: (res && res.error) || 'diff-failed' });
              }
            })
            .catch(function (err) {
              openDiff({ path: path, error: String((err && err.message) || err) });
            });
        }

        /** 变更行 → diff 悬浮面板(diff 范围: 工作区相对 HEAD)。 */
        function openChangeDiff(change) {
          openDiffFrom(
            change.path,
            api(
              'diff',
              gitPayload({
                path: change.path,
                status: change.badge,
                from: change.origPath || undefined,
              }),
            ),
          );
        }

        /** 提交里展开出来的文件行 → 该提交相对其父提交的 diff。 */
        function openCommitFileDiff(hash, filePath) {
          openDiffFrom(filePath, api('show', gitPayload({ hash: hash, path: filePath })));
        }

        /** 展开表的一次不可变更新(React 要新对象才会重渲染)。 */
        function withExpanded(prev, hash, value) {
          var next = {};
          for (var key in prev) {
            if (Object.prototype.hasOwnProperty.call(prev, key)) next[key] = prev[key];
          }
          if (value === undefined) delete next[hash];
          else next[hash] = value;
          return next;
        }

        /** 点一条提交 → 就地展开 / 收起它的文件。 */
        function toggleCommit(hash) {
          var willExpand = expanded[hash] === undefined;
          setExpanded(function (prev) {
            return withExpanded(prev, hash, willExpand ? { loading: true } : undefined);
          });
          if (!willExpand) return;
          api('show', gitPayload({ hash: hash }))
            .then(function (res) {
              setExpanded(function (prev) {
                if (prev[hash] === undefined) return prev; // 已被收起
                var value =
                  res && res.ok === true
                    ? { detail: res }
                    : { error: (res && res.error) || 'show-failed' };
                return withExpanded(prev, hash, value);
              });
            })
            .catch(function (err) {
              setExpanded(function (prev) {
                if (prev[hash] === undefined) return prev;
                return withExpanded(prev, hash, { error: String((err && err.message) || err) });
              });
            });
        }

        /** 切「查看分支」: 只决定看哪个分支的历史, 不动工作区的实际分支。 */
        function onPickRef(ev) {
          var next = ev.target.value;
          setViewedRef(next);
          setHistory(null);
          loadHistory(next || null, 0);
        }

        // ---- 头部 ----
        var current = status ? status.current : null;
        var detached = !!(status && status.detached);
        var branchLabel =
          current || (detached ? '(分离 HEAD)' : status && status.initial ? '(无提交)' : '—');

        var head = h(
          'div',
          { className: 'fge-head' },
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
              title: '刷新(先 fetch --all --prune)',
              disabled: busy,
              onClick: manualRefresh,
            },
            busy ? '…' : '⟳',
          ),
        );

        // ---- 变更列表 ----
        var changes = status ? status.changes : [];
        var changeRows = [];
        if (status === null) {
          changeRows.push(h('div', { key: 'loading', className: 'fge-empty' }, '读取中…'));
        } else if (changes.length === 0) {
          changeRows.push(h('div', { key: 'clean', className: 'fge-empty' }, '(工作区干净)'));
        } else {
          for (var ci = 0; ci < changes.length; ci += 1) {
            changeRows.push(
              h(
                'div',
                {
                  key: 'c:' + changes[ci].kind + ':' + changes[ci].path,
                  className: 'fge-row',
                  title: changes[ci].origPath
                    ? changes[ci].path + ' ← ' + changes[ci].origPath
                    : changes[ci].path,
                  onClick: (function (change) {
                    return function () {
                      openChangeDiff(change);
                    };
                  })(changes[ci]),
                },
                h('span', { className: 'fge-badge', 'data-b': changes[ci].badge }, changes[ci].badge),
                h('span', { className: 'fge-path' }, changes[ci].path),
              ),
            );
          }
        }

        var changesSection = h(
          'div',
          null,
          h(
            'div',
            { className: 'fge-section' },
            '变更列表',
            changes.length > 0 ? h('span', { className: 'fge-chip' }, String(changes.length)) : null,
          ),
          error !== null && status === null
            ? h('div', { className: 'fge-empty' }, '非 git 工作区或 git 不可用(' + error + ')')
            : h('div', null, changeRows),
        );

        // ---- 提交历史 ----
        var branches = status && Array.isArray(status.branches) ? status.branches : [];
        var refOptions = [
          h('option', { key: '', value: '' }, '查看分支: 当前' + (current ? '(' + current + ')' : '')),
        ];
        for (var bi = 0; bi < branches.length; bi += 1) {
          var name = branches[bi].name;
          refOptions.push(
            h('option', { key: name, value: name }, (branches[bi].remote ? '远程 ' : '') + name),
          );
        }

        var historyRows = [];
        if (history === null || history.loading) {
          historyRows.push(h('div', { key: 'loading', className: 'fge-empty' }, '读取历史…'));
        } else if (history.error) {
          historyRows.push(
            h('div', { key: 'err', className: 'fge-empty' }, '历史失败(' + history.error + ')'),
          );
        } else if (history.commits.length === 0) {
          historyRows.push(h('div', { key: 'none', className: 'fge-empty' }, '(无提交)'));
        } else {
          for (var hi = 0; hi < history.commits.length; hi += 1) {
            var commit = history.commits[hi];
            var row = expanded[commit.hash];
            historyRows.push(
              h(
                'div',
                {
                  key: 'h:' + commit.hash,
                  className: 'fge-commit',
                  onClick: (function (hash) {
                    return function () {
                      toggleCommit(hash);
                    };
                  })(commit.hash),
                },
                h('div', { className: 'fge-commit-sub' }, commit.subject),
                h(
                  'div',
                  { className: 'fge-commit-meta' },
                  commit.author + ' · ' + formatTime(commit.at) + ' · ' + commit.short,
                ),
              ),
            );
            if (row === undefined) continue;
            if (row.loading) {
              historyRows.push(
                h('div', { key: 'h:' + commit.hash + ':l', className: 'fge-empty' }, '读取提交…'),
              );
              continue;
            }
            if (row.error !== undefined) {
              historyRows.push(
                h(
                  'div',
                  { key: 'h:' + commit.hash + ':e', className: 'fge-empty' },
                  '提交失败(' + row.error + ')',
                ),
              );
              continue;
            }
            // 展开态: 一次提交详情(host `show` 的返回)。
            var detail = row.detail;
            historyRows.push(
              h(
                'pre',
                { key: 'h:' + commit.hash + ':m', className: 'fge-msg' },
                detail.message || '(无提交说明)',
              ),
            );
            if (detail.kind === 'merge') {
              historyRows.push(
                h(
                  'div',
                  { key: 'h:' + commit.hash + ':merge', className: 'fge-empty' },
                  'merge 提交只显示说明, 不展开文件',
                ),
              );
              continue;
            }
            var files = Array.isArray(detail.files) ? detail.files : [];
            if (files.length === 0) {
              historyRows.push(
                h('div', { key: 'h:' + commit.hash + ':nf', className: 'fge-empty' }, '(无文件变更)'),
              );
              continue;
            }
            for (var fi = 0; fi < files.length; fi += 1) {
              historyRows.push(
                h(
                  'div',
                  {
                    key: 'h:' + commit.hash + ':f' + String(fi),
                    className: 'fge-row fge-indent',
                    title: files[fi].path,
                    onClick: (function (hash, filePath) {
                      return function (ev) {
                        ev.stopPropagation();
                        openCommitFileDiff(hash, filePath);
                      };
                    })(commit.hash, files[fi].path),
                  },
                  h(
                    'span',
                    { className: 'fge-numstat' },
                    h('b', { className: 'fge-dl-add' }, files[fi].adds === null ? '·' : '+' + String(files[fi].adds)),
                    h('b', { className: 'fge-dl-del' }, files[fi].dels === null ? '·' : '−' + String(files[fi].dels)),
                  ),
                  h('span', { className: 'fge-path' }, files[fi].path),
                ),
              );
            }
          }
          if (history.done === false) {
            historyRows.push(
              h(
                'div',
                {
                  key: 'more',
                  className: 'fge-row',
                  onClick: function () {
                    loadHistory(history.ref, history.commits.length);
                  },
                },
                h('span', { className: 'fge-empty' }, '加载更多…'),
              ),
            );
          }
        }

        var historySection = h(
          'div',
          null,
          h(
            'div',
            { className: 'fge-section' },
            '提交历史',
            h(
              'select',
              { className: 'fge-select', value: viewedRef, onChange: onPickRef, title: '查看分支' },
              refOptions,
            ),
          ),
          h('div', null, historyRows),
        );

        return h(
          'div',
          { className: 'fge-root' },
          head,
          h('div', { className: 'fge-body' }, changesSection, historySection),
        );
      }

      function GitTabTitle() {
        return h('span', null, 'Git');
      }

      // ---- 终端抽屉(composer 座里的抽屉舌 + 向上展开) ----

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

        // 切工作区: 上一个工作区的详情悬浮面板关掉(终端本身按工作区常驻, 不动)。
        var prevCwd = React.useRef(sessionCwd);
        React.useEffect(
          function () {
            if (prevCwd.current !== sessionCwd) {
              prevCwd.current = sessionCwd;
              closeOwnedFloat();
            }
          },
          [sessionCwd],
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
            'button',
            {
              type: 'button',
              className: 'fge-tongue',
              title: '展开终端抽屉',
              'aria-label': '展开终端抽屉',
              onClick: function () {
                setDrawer(true);
              },
            },
            h(primitives.IconChevronUpOutline14, { size: 14 }),
          );
        }

        return h(
          'div',
          { className: 'fge-term', style: { height: String(pct) + 'vh' } },
          h('div', {
            className: 'fge-term-grip',
            onMouseDown: onGripDown,
            title: '拖动调整高度',
          }),
          h(
            'div',
            { className: 'fge-term-head' },
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
                title: '收起(不杀进程)',
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
              return 'Git';
            },
            guide: [
              {
                order: 60,
                title: function () {
                  return 'Git';
                },
                description: function () {
                  return '变更列表 / 提交历史 / diff 详情悬浮面板';
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
            id: DIFF_ID,
            kind: DIFF_KIND,
            priority: 'extension',
            title: function () {
              return 'diff';
            },
          });
        },
        'fge: diff tab type',
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
          return slots.register({ name: 'sidebar.right.pane.tab', key: DIFF_ID }, DiffTabBody);
        });
      }, 'fge: diff tab body');

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab.title', function () {
          return slots.register({ name: 'sidebar.right.pane.tab.title', key: DIFF_ID }, DiffTabTitle);
        });
      }, 'fge: diff tab title');

      // 影子替换官方文档页签的芯片: 拿到 tabId 才能把官方正文页签浮起来。
      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab.title', function () {
          return slots.register(
            { name: 'sidebar.right.pane.tab.title', key: DOC_ID, priority: DOC_PRIORITY },
            DocTitle,
          );
        });
      }, 'fge: doc tab title shadow');

      ctx.effect(function () {
        return slots.inject('conversation.composer.dock', function () {
          return slots.register(
            { name: 'conversation.composer.dock', id: 'fge-terminal', order: 50 },
            TerminalDock,
          );
        });
      }, 'fge: terminal dock');

      // 右栏折叠 → 关掉本插件浮起的详情: 悬浮面板在 document.body 上的一个 fixed portal 里
      // (z-index 60), 不随右栏一起滑走, 所以必须显式关。
      ctx.effect(
        function () {
          if (typeof MutationObserver !== 'function' || typeof document === 'undefined') {
            return function () {};
          }
          function check() {
            if (floatTarget === null) return;
            if (document.querySelector('[data-rightbar-collapsed]') !== null) closeOwnedFloat();
          }
          var observer = new MutationObserver(check);
          observer.observe(document.documentElement, {
            attributes: true,
            subtree: true,
            attributeFilter: ['data-rightbar-collapsed'],
          });
          return function () {
            observer.disconnect();
          };
        },
        'fge: close float when rightbar collapses',
      );

      // 插件卸载: 撤掉本插件浮起的详情, 不留孤儿页签。
      ctx.effect(
        function () {
          return function () {
            closeOwnedFloat();
            diffs.clear();
          };
        },
        'fge: dispose float state',
      );

      console.info('[fge] ready — 右侧栏「git 页签」+ 详情悬浮面板, composer 下的终端抽屉');
    };

    return module.exports;
  },
});
