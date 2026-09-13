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
// 两条对所有详情都成立的保证(成因与实测见 docs/adr/0004):
//   · **详情只以浮层出现**: 浮起前那次"座位绑定空隙"用**微任务**重试(定时器会把详情页签在
//     页签条上画出 3–5 帧 —— 就是使用者说的"先加一个 tag, 闪一下, 消失");
//   · **右栏不自己跳页签**: 浮起之后把用户原本选中的那一格 `focus()` 回来(dockkit 的 float 会把
//     活动页签改成"详情左边那一格", 从「文件」点文件就会跳去 git 树)。
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
      /** 右侧栏最大宽度(视口百分比)。官方的首开宽度是 45%、上限 70%, 这里按用户要求压到 15。 */
      var RIGHTBAR_MAX_VW = 15;
      /**
       * 右侧栏拖动下限(px)。上限仍是 `RIGHTBAR_MAX_VW`, 可拖区间 = [200px, 15vw]
       * (1600 宽 → 200–240, 1920 宽 → 200–288)。宽度拖完记住, 见 readRightbarWidth/persistRightbarWidth。
       */
      var RIGHTBAR_MIN_PX = 200;
      /** 拖动后宽度的存储键(与终端高度同款: localStorage, 刷新 / 切会话都在)。 */
      var RIGHTBAR_WIDTH_KEY = 'fge-rightbar-w-v1';
      /** 第三轨 / 面板宽度 / 拖柄位置共用的那一个值: 拖动过的 px 优先, 没拖过就按上限 15vw。 */
      var RIGHTBAR_TRACK = 'min(var(--fge-rightbar-px,' + String(RIGHTBAR_MAX_VW) + 'vw),' + String(RIGHTBAR_MAX_VW) + 'vw)';
      /**
       * 终端表面色 = 官方的「代码 / 终端卡片」底色(`--dsw-alias-markdown-code-block`)。
       *
       * ⚠ 不能用 `--dsw-alias-bg-base` / `bg-layer-*`: 官方浅色主题里这几个 token **全是纯白**,
       * 终端就与页面完全融合(实测: 用户主题下整个抽屉糊进背景, 连标题条的分隔线都看不出来)。
       * 官方终端卡片(`TerminalBlock` / `ioCard`)用的正是 code-block 底色 + `border-l1` 描边。
       * 兜底: 旧主题没有该 token 时回落到 `bg-base`。
       */
      var TERM_SURFACE = 'var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-base))';
      /** xterm 只吃具体颜色: JS 侧按这个名字读 token 再归一(见 terminalTheme)。 */
      var TERM_SURFACE_TOKEN = '--dsw-alias-markdown-code-block';
      /** float() 的重试预算: 座位瞬时缺位(见 floatWithRetry)下一次就够, 这里留足余量。 */
      var FLOAT_ATTEMPTS = 6;
      var FLOAT_RETRY_MS = 60;
      /**
       * 座位绑定空隙用微任务重试的次数(见 retryFloat): 空隙在同一次 effect flush 收尾就补好,
       * 1 次就够, 留 2 次只是容错。之后才退回定时器。
       */
      var FLOAT_MICRO_ATTEMPTS = 2;
      /** 右侧栏默认页签的重试预算(等座位绑定 + files 类型到位)。 */
      var SEED_ATTEMPTS = 20;
      var SEED_RETRY_MS = 150;

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
          // git 页签头部: **高度必须 38px**(border-box)—— 页签条占 0–38, 官方的「文件」页签头也是 38px,
          // 于是头部底边线正好落在 y=76, 与会话头部(`wSkVaW_header`)的底边线、以及官方文件页签的下缘对齐。
          // 写成 padding 撑出来的高度(33.8px)会差 4px, 看上去就是"这条线跟上面那条没对齐"。
          '.fge-head{display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 8px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:0 0 auto}',
          '.fge-btn{border:0;background:transparent;cursor:pointer;padding:2px 5px;border-radius:4px;color:inherit;font-size:12px;line-height:1.4}',
          '.fge-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          '.fge-btn[disabled]{opacity:.45;cursor:default}',
          '.fge-branch{display:flex;align-items:center;gap:4px;padding:2px 6px;max-width:11em;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}',
          '.fge-branch:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          '.fge-branch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.fge-branch-caret{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}',
          // 头部那颗分支按钮的小浮窗: 位置由官方 useAnchoredPosition 算(视口坐标), 所以 position:fixed
          // —— 这样既不被右栏面板的 overflow 裁掉, 也不受面板 transform 影响(展开态 transform:none)。
          '.fge-branch-menu{position:fixed;z-index:70;width:280px;max-width:70vw;max-height:min(60vh,420px);overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);font-size:12px}',
          '.fge-branch-group{padding:5px 6px 2px;font-size:10px;color:var(--dsw-alias-label-tertiary)}',
          '.fge-branch-item{display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:4px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}',
          '.fge-branch-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
          '.fge-branch-item[data-viewed="1"]{color:var(--dsw-alias-brand-primary);font-weight:600}',
          '.fge-branch-sub{padding-left:16px}',
          '.fge-branch-mark{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary)}',
          '.fge-ab{display:inline-flex;gap:4px;font-variant-numeric:tabular-nums;opacity:.85}',
          '.fge-spacer{flex:1 1 auto}',
          '.fge-body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 0 6px}',
          '.fge-section{display:flex;align-items:center;gap:6px;position:sticky;top:0;z-index:1;padding:4px 9px;font-size:11px;font-weight:600;letter-spacing:.02em;opacity:.72;background:var(--dsw-alias-bg-base,rgba(0,0,0,.18));border-bottom:1px solid rgba(128,128,128,.16)}',
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
          // 终端抽屉: 座位在 composer 之下(conversation.composer.dock), **宽度贯穿整个座位**,
          // 顶部两角圆角; 颜色全走主题 token(--dsw-alias-*), 不写死蓝/黑, 于是明暗主题都跟得上。
          //
          // ⚠ 表面色用**官方的"代码/终端卡片"底色** `--dsw-alias-markdown-code-block`, 不要用 `bg-base`:
          //   官方浅色主题里 `bg-base` / `layer-1/2/3` **全是纯白**, 拿它们当终端底 = 与页面完全融合,
          //   标题条那条分隔线也跟着看不出来(实测: 用户主题下整个抽屉糊进背景)。
          //   官方终端卡片(`TerminalBlock` / `ioCard`)用的就是 code-block 底色 + `border-l1` 描边。
          //   ⚠ 抽屉宽度 = **上方对话区宽度**(`--dsh-chat-content-width`, 就是那条
          //   `wSkVaW_widthHandle` 拖出来的宽度): 座位本身是整条中栏, `width:100%` 会比 composer
          //   卡片宽出一截, 看着不像"同一个对话区"。max-width + 居中即可, 纯 CSS 零测量;
          //   拖那条手柄时变量一变抽屉跟着变, 里面的 xterm 由 ResizeObserver 自动 refit。
          '.fge-term{display:flex;flex-direction:column;box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,100%);margin-inline:auto;border-top:1px solid var(--dsw-alias-border-l2);border-radius:12px 12px 0 0;background:' +
            TERM_SURFACE +
            ';color:var(--dsw-alias-label-primary)}',
          // 标题条(terminal title bar): 长得像 Windows Terminal 的页签栏, 但**不是多页签容器**
          // —— 每工作区仍只有一个终端(见 CONTEXT.md「工作区终端」), 所以条里恒定一枚页签。
          // 条本身仍是收起开关(点空白处 = 点页签上的 `×`: 只收抽屉, 不杀进程)。
          // ⚠ 底色**不设**(用户口径: 把那块色去掉) —— 直接透出抽屉表面, 条 / 体的分界交给下面那条
          //   `border-l3` 分隔线; 页签用同样的表面色, 于是条里只有页签这一块"面"。
          //   分隔线跟官方面板 header 同款(border-l3, 官方浅色主题实测 rgba(0,0,0,.12), 是三级边框里最深的)。
          '.fge-term-strip{display:flex;align-items:flex-end;gap:2px;padding:3px 8px 0;font-size:11.5px;cursor:pointer;background:none;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l3)}',
          // 页签: 只有当前工作区这一枚, 恒为活动态 —— 底色与终端体同色(于是"连着终端"), 与条形成对比, 两角圆角。
          // ⚠ **不再用"1px 投影盖掉条的底边"那套**: 那样页签底下就没有那条线了(用户点名要线是连续的)。
          //   现在页签停在条的内容盒底部、**不压** border, 于是 strip 的底边线在页签下面同样看得见。
          '.fge-term-tab{display:flex;align-items:center;gap:5px;min-width:0;max-width:42%;padding:3px 6px 3px 8px;border-radius:6px 6px 0 0;background:' +
            TERM_SURFACE +
            ';color:var(--dsw-alias-label-primary);cursor:pointer}',
          // 页签字形: primitives 里没有终端图标(75 枚图标全表最接近的只有 IconCodeOutline16),
          // 所以自绘 `>_` —— 与 `■` 同款做法, 不引依赖。
          '.fge-term-tab-glyph{flex:0 0 auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;opacity:.7}',
          // 标题 = 工作区路径: 单行, 尾部省略号(与 Windows Terminal 的页签标题同款)。
          '.fge-term-tab-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          // 页签上的 `×`: 平时不占位, hover / 键盘聚焦才出现(WT 同款); 语义是**收起抽屉, 不杀进程**。
          '.fge-term-tab-close{flex:0 0 auto;display:none;align-items:center;justify-content:center;width:14px;height:14px;padding:0;border:0;border-radius:3px;background:transparent;color:inherit;font-size:11px;line-height:1;cursor:pointer}',
          '.fge-term-tab:hover .fge-term-tab-close,.fge-term-tab-close:focus-visible{display:inline-flex}',
          '.fge-term-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          // 条右端的 `■`: 终止整棵终端进程树(危险色) —— 人停止终端的唯一入口, 与 `×`(收起)分开。
          '.fge-term-glyph{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;padding:0 4px;margin-bottom:3px;font-size:14px;line-height:1}',
          '.fge-term-kill{color:var(--dsw-alias-state-error-primary)}',
          '.fge-term-kill:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}',
          '.fge-term-grip{height:5px;cursor:ns-resize;background:transparent}',
          '.fge-term-grip:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          '.fge-term-body{flex:1 1 auto;min-height:0;padding:2px 4px 4px;background:' + TERM_SURFACE + '}',
          '.fge-term-body .xterm{height:100%}',
          // xterm 自带的滚动条(vscode 血统)是 **14px** 宽, 在这么窄的抽屉里显得又粗又占地方;
          // 而且它的宽/高是 **内联样式** 写死的(`domNode.setWidth(...)`), 只有 `!important` 能压住。
          // 这里收到 6px(抽屉里其它滚动区也是 5px 细滚条), 滑块交给 xterm 主题自己算色(跟随前景色)。
          '.fge-term-body .xterm-scrollable-element > .scrollbar.vertical{width:6px!important}',
          // 滑块跟着收窄 + **圆角**(用户口径: 参考 dsh 自己的滚动条 —— 细条 + 两端圆角)。
          // 颜色不用管: xterm 按 `scrollbarSliderBackground`(默认 = 前景色 20% 透明)自己注入样式, 天然跟主题。
          '.fge-term-body .xterm-scrollable-element > .scrollbar.vertical > .slider{width:100%!important;border-radius:3px}',
          // xterm 自带的 xterm.css 把 `.xterm-viewport` 写死成 `background:#000`, xterm 自己**不会**改它
          // (主题色只落在 `.xterm-scrollable-element` 上) —— 于是终端底边会漏出一条黑带。
          // 这里按**与画布同一个**表面 token 覆盖, 主题一换跟着变(纯 CSS, 不需要 JS 参与)。
          '.fge-term-body .xterm-viewport{background-color:' + TERM_SURFACE + '!important}',
          // 抽屉舌: 宽度与抽屉同宽(同一个 `--dsh-chat-content-width`), 中间一枚透明无边框 chevron
          // (旧实现的观感, 见 v0.2 的 .fge-strip)。
          '.fge-tongue{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,100%);margin-inline:auto;padding:1px 0 3px;background:transparent;border:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;user-select:none}',
          '.fge-tongue:hover{color:var(--dsw-alias-label-primary)}',
          '.fge-chip{font-size:11px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap}',
          // ---- 右栏外观调整(改的是官方 layout / sidebar-right 的 chrome, 用户点名要的) ----
          //
          // 1) 右栏宽度 = **可拖**, 上限 15vw、下限 200px(用户口径: 上限保留, 但得能拖)。
          //    官方没有公开的宽度 API: `setRightbar` 只在 layout 内部, 还被钳制到 [300px, 0.7×视口];
          //    首开宽度更是 45% of frame(`RIGHTBAR_DEFAULT_RATIO`)。所以这里**只改画法**:
          //    把 frame 第三轨定成 `RIGHTBAR_TRACK`(拖动过的 px, 没拖过回落 15vw)、面板也限到同样宽 ——
          //    于是右栏**占真实的一格轨道**, 打开时把中栏挤窄(而不是浮在它上面)。
          //    ⚠ 第三轨**不能写成 0**: 轨道为 0 时官方面板(`position:absolute; right:0`)会向左挂到中栏上面
          //    (官方注释原话 "it can hang over the centre when there is no track"), 看起来就是浮层 —— 实测踩过。
          //    ⚠ 折叠时必须把这一轨**还给中栏**, 所以按官方的 `data-rightbar-collapsed` 分成两条规则。
          //    左栏那一轨交给 `auto`(官方侧栏组件自带宽度), 于是收起成 56px 细条、拖动变宽都照旧。
          //    改上限/下限就改 RIGHTBAR_MAX_VW / RIGHTBAR_MIN_PX 两个常量。
          'div:has(> [data-rightbar-col]):not([data-rightbar-collapsed]){grid-template-columns:auto minmax(0,1fr) ' +
            RIGHTBAR_TRACK +
            '!important}',
          '[data-rightbar-collapsed]:has(> [data-rightbar-col]){grid-template-columns:auto minmax(0,1fr) 0px!important}',
          '[data-sidebar-right-panel="push"]{max-width:' + RIGHTBAR_TRACK + '!important}',
          //    拖柄: 官方那根 8px 的 col-resize 手柄本来就在边界上, 但它的 `left` 跟的是**官方**宽度
          //    (本插件不采用), 而且 `position:absolute` 在 frame 里 —— 这里改成按本插件轨道从右边定位,
          //    于是它始终骑在真实边界上。拖动本身由 JS 接管(见 attachRightbarDrag), 官方那套钳制不参与。
          '[data-side="rightbar"]{left:auto!important;right:calc(' + RIGHTBAR_TRACK + ' - 4px)!important;display:block}',
          //    hover / 拖动时的可见性提示: 一条 3px 圆角竖条(跟官方会话宽度手柄同款 token)。
          '[data-side="rightbar"]:after{content:"";position:absolute;top:0;bottom:0;right:2px;width:3px;border-radius:3px;background:transparent}',
          '[data-side="rightbar"]:hover:after,[data-fge-resizing] [data-side="rightbar"]:after{background:var(--dsw-alias-scrollbar-hover-l1,var(--dsw-alias-border-l2))}',
          //    拖动中关掉 frame 的宽度过渡(官方 `transition:grid-template-columns …` 会让面板追不上指针),
          //    并把光标钉成 col-resize —— 指针滑出那 8px 手柄时也还在拖。
          '[data-fge-resizing]{transition:none!important}',
          '[data-fge-resizing],[data-fge-resizing] *{cursor:col-resize!important}',
          // 2) 隐藏右栏 chrome 的「分栏」与「进全屏」按钮(「收起」保留)。
          //    `data-sidebar-right-mode` 的值是**下一个**模式, 所以只命中"当前不是全屏"时的进全屏按钮;
          //    真到了全屏, 那个按钮(退出全屏)还在, 不会把人关在全屏里出不来。
          '[data-dockkit-split-button]{display:none}',
          '[data-sidebar-right-mode="fullscreen"]{display:none}',
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

      // ---- 浮起之后把「用户原本在看的那一格」focus 回来 ----
      //
      // 详情页签总是**追加在来源 pane 的末尾**, 而官方的 float 会把该 pane 的 activeTabId 改成
      // `tabs[index - 1]`(dockkit 的 float reducer: `W3(tabs, s)` = 去掉被浮起的那格后的
      // `tabs[max(0, s - 1)]`)。于是浮起「文件详情」之后右栏会跳到详情左边那一格 —— 而那一格
      // 通常正是先打开的 git 树, 观感就是"右栏自己切回 git 树了"。
      //
      // 修法不是猜"左边那格应该是谁", 而是记住用户动手之前页签条上真正选中的那一格:
      // 详情浮起后 focus 回去, 右栏就停在用户原本看的地方(文件详情 → 停在「文件」, diff → 停在「Git」)。
      var userTabId = null;

      /**
       * 记下用户这次动作之前右栏选中的页签。
       *
       * 读的是页签条上的 `aria-selected`(而不是问 `sidebarRight.active()`): 捕获阶段拿到的就是
       * 动作发生前的状态, 而且**每次都重新读**, 不存在"上次读到的是什么时候"的陈旧问题。
       * 点在页签条本身上时跳过 —— 那是用户在切页签, 记下旧值只会把下次的回落目标指错。
       */
      function rememberUserTab(ev) {
        if (typeof document === 'undefined') return;
        var target = ev.target;
        if (target !== null && typeof target.closest === 'function' && target.closest('[data-dockkit-tab]') !== null) {
          return;
        }
        var active = document.querySelector('[data-dockkit-strip] [data-dockkit-tab][aria-selected="true"]');
        userTabId = active === null ? null : active.getAttribute('data-dockkit-tab');
      }

      /**
       * 浮起详情之后把用户那一格 focus 回来; 它已经被关掉(或座位又瞬时缺位)就保持官方落点。
       * @param {string} detailTabId 刚浮起的那一格, 等于用户那一格时不动
       */
      function restoreUserTab(detailTabId) {
        var id = userTabId;
        if (id === null || id === undefined || id === detailTabId) return;
        try {
          ctx.sidebarRight.focus(id);
        } catch (err) {
          // 座位瞬时缺位: 不影响详情已经浮起这件事, 只是右栏停在官方那格上。
        }
      }

      /**
       * 右栏可视区域的左缘(视口 x)。
       *
       * ⚠ 本插件把右栏宽度限死在 `RIGHTBAR_MAX_VW`(见 ensureStyles), 于是官方那个 grid 第三轨恒为 0 宽、
       * `[data-rightbar-col]` 贴在视口右缘 —— **不能再拿它的宽度/位置当锚点**了(那会恒为 null)。
       * 改从面板自己量: 面板右缘贴视口右缘、`max-width` 已经生效, 而 `transform` 只平移不改宽度,
       * 所以展开动画期间量它的 `width` 也是准的(量 `left` 才会拿到中间值)。
       * @returns {number|null} 右栏没显示时 null
       */
      function rightbarLeft() {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
          return null;
        }
        var panel = document.querySelector('[data-sidebar-right-panel="push"]');
        if (panel === null) return null;
        var width = panel.getBoundingClientRect().width;
        if (!(width > 0)) return null;
        return window.innerWidth - width;
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

      // ---- 右栏宽度: 可拖, 钳在 [RIGHTBAR_MIN_PX, 15vw] ----

      /** 当前右栏可视宽度(px); 面板没渲染(右栏折叠)时 null。 */
      function rightbarWidth() {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
        var panel = document.querySelector('[data-sidebar-right-panel="push"]');
        if (panel === null) return null;
        var width = panel.getBoundingClientRect().width;
        return width > 0 ? width : null;
      }

      /** 上限的像素值(`RIGHTBAR_MAX_VW` 换算)。 */
      function rightbarMaxPx() {
        return (window.innerWidth * RIGHTBAR_MAX_VW) / 100;
      }

      /** 钳进 [下限, 上限]; 视口窄到上限比下限还小时**以上限为准**(上限是用户的硬要求)。 */
      function clampRightbarWidth(px) {
        var max = rightbarMaxPx();
        var next = px < RIGHTBAR_MIN_PX ? RIGHTBAR_MIN_PX : px;
        return next > max ? max : next;
      }

      /** 落宽度: 只写一个 CSS 变量, 第三轨 / 面板 max-width / 拖柄位置三条规则都读它。 */
      function applyRightbarWidth(px) {
        if (typeof document === 'undefined') return;
        document.documentElement.style.setProperty('--fge-rightbar-px', String(Math.round(px)) + 'px');
      }

      /** 读上次拖动后的宽度; 没有 / 读不出(隐私模式)返回 null。 */
      function readRightbarWidth() {
        try {
          var raw = window.localStorage.getItem(RIGHTBAR_WIDTH_KEY);
          if (raw === null) return null;
          var px = Number.parseFloat(raw);
          return Number.isFinite(px) && px > 0 ? px : null;
        } catch (err) {
          return null;
        }
      }

      function persistRightbarWidth(px) {
        try {
          window.localStorage.setItem(RIGHTBAR_WIDTH_KEY, String(Math.round(px)));
        } catch (err) {
          // 隐私模式 / 配额: 记不住而已, 不影响这次拖动
        }
      }

      /**
       * 接管官方那根右栏拖柄。捕获阶段吃掉 pointerdown(`stopPropagation` 之后 React 的委托处理器
       * 收不到), 于是官方的拖动(写 layout store, 还钳到 [300px, 0.7×视口])完全不参与 ——
       * 本插件自己按指针位置算宽度、自己钳到 [200px, 15vw]、自己存。
       *
       * ⚠ 拖动期间给 frame 挂 `data-fge-resizing`: 官方的 `transition:grid-template-columns` 是
       * 慢过渡, 不关掉面板会追不上指针(顺带把光标钉成 col-resize, 指针滑出那 8px 手柄也还在拖)。
       * @returns {() => void} 卸下监听
       */
      function attachRightbarDrag() {
        function finishDrag(state, upEv) {
          window.removeEventListener('pointermove', state.move, true);
          window.removeEventListener('pointerup', state.finish, true);
          window.removeEventListener('pointercancel', state.finish, true);
          if (state.frame !== null) state.frame.removeAttribute('data-fge-resizing');
          if (upEv !== undefined && upEv !== null && typeof upEv.clientX === 'number') {
            setDragWidth(state, state.startWidth + (state.startX - upEv.clientX));
          }
          // ⚠ 存**本插件落下去的那个值**, 不要存"量出来的面板宽度": 面板是 border-box,
          // 量出来会比变量多 1px, 存下去下次再 +1 —— 每拖一次胖一点。
          if (state.width !== null) persistRightbarWidth(state.width);
        }

        function setDragWidth(state, px) {
          state.width = clampRightbarWidth(px);
          applyRightbarWidth(state.width);
        }

        function onPointerDown(ev) {
          var target = ev.target;
          if (target === null || typeof target.closest !== 'function') return;
          var handle = target.closest('[data-side="rightbar"]');
          if (handle === null) return;
          ev.preventDefault();
          ev.stopPropagation();
          var startWidth = rightbarWidth();
          var max = rightbarMaxPx();
          // 没有可视宽度(右栏折叠中)时从变量 / 上限起算, 免得拖出个负数起点。
          if (startWidth === null) startWidth = clampRightbarWidth(max);
          var state = {
            frame: handle.parentElement,
            startX: ev.clientX,
            startWidth: startWidth,
            width: clampRightbarWidth(startWidth),
            move: null,
            finish: null,
          };
          state.move = function (moveEv) {
            setDragWidth(state, state.startWidth + (state.startX - moveEv.clientX));
          };
          state.finish = function (upEv) {
            finishDrag(state, upEv);
          };
          if (state.frame !== null) state.frame.setAttribute('data-fge-resizing', '');
          window.addEventListener('pointermove', state.move, true);
          window.addEventListener('pointerup', state.finish, true);
          window.addEventListener('pointercancel', state.finish, true);
        }

        document.addEventListener('pointerdown', onPointerDown, true);
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true);
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
       * 重试一次的两种时钟。
       *
       * ⚠ 座位绑定空隙在同一**次** effect flush 的收尾就补好了: 卸载阶段先跑整棵树,
       * 装载阶段子先父后, 我们这个芯片的 effect 夹在中间 —— 所以一次微任务足够, 而且微任务
       * 天然落在 paint 之前。用 `setTimeout(FLOAT_RETRY_MS)` 会把这 60ms 的中间态画到屏幕上
       * (实测: 页签条上冒出详情页签 45–66ms / 3–5 帧), 那正是"先加一个 tag、闪一下"的来源。
       * 只有"量不出 rect"(右栏还在展开、没有轨道)那一路才真的需要等下一帧, 仍走定时器。
       */
      function retryFloat(tabId, attempt, previous) {
        if (attempt < FLOAT_MICRO_ATTEMPTS) {
          Promise.resolve().then(function () {
            floatWithRetry(tabId, attempt + 1, previous);
          });
          return;
        }
        window.setTimeout(function () {
          floatWithRetry(tabId, attempt + 1, previous);
        }, FLOAT_RETRY_MS);
      }

      /**
       * 浮起 + 重试。**关掉上一个的动作也放在这个重试循环里** —— 理由见下。
       *
       * ⚠ 实测(真 boot + 真浏览器): **新页签挂载的那一次 commit 里, 直接调 sidebarRight 的
       * 命令会抛 `sidebarRight: no session surface is mounted`**。原因是官方座位的绑定写在
       * `useEffect(() => bindService({...}), [..., surfaces])` 里, 而新页签让 `surfaces` 变了:
       * 那次 flush 先跑**卸载**阶段(座位释放绑定)、再跑**挂载**阶段, 而挂载阶段是子先父后 ——
       * 我们这个芯片的 effect 正好夹在"座位已释放、尚未重绑"的空隙里。**空隙在同一轮 flush 的收尾
       * 就补好了**(父的装载 effect 就在后面), 所以重试用微任务而不是定时器 —— 见 retryFloat。
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
          retryFloat(tabId, attempt, previous);
          return;
        }
        try {
          ctx.sidebarRight.float(tabId, rect === null ? undefined : rect);
          restoreUserTab(tabId);
        } catch (err) {
          if (attempt < FLOAT_ATTEMPTS) {
            retryFloat(tabId, attempt, previous);
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

      /** 官方「工作区文件」页签的 kind(ui-sidebar-files 注册; 它是 page 类型, 用 openTab 开)。 */
      var FILES_KIND = 'files';
      /** 官方 guide 页签的 kind(sidebar-right 自带, `canCloseTab` 也按这个字面量判断)。 */
      var GUIDE_KIND = 'guide';
      /** 已经铺过默认页签的会话: 每个会话只做一次, 免得跟用户手动关掉的动作打架。 */
      var seededSessions = new Set();

      /**
       * 右侧栏的默认页签。
       *
       * 官方 `defaultSeed` 的规则是: **guide 里恰好只有一条时**, 默认页签就是那一条; 有两条及以上
       * 就落回 guide 列表页。本插件自己也带一条 guide 条目(少了它 git 页签就没有入口), 于是默认
       * 变成列表页 —— 这里补一步, 把它还原成「默认就是工作区文件」:
       * 右栏还是空的 / 只有 guide 时, 打开「工作区文件」, 顺手把 guide 占位页收掉(此时它不是
       * 唯一页签, `canCloseTab` 允许关)。
       *
       * 不抢用户已经打开的页签: 每次尝试前都看一眼当前活动页签的 kind。失败(座位还没挂上 /
       * 没有 files 类型)按次数退避重试, 用尽就静默放弃 —— 这只是锦上添花, 不该影响别的功能。
       */
      function seedRightbar(sessionId) {
        if (seededSessions.has(sessionId)) return;
        seededSessions.add(sessionId);
        openFilesDefault(0);
      }

      function openFilesDefault(attempt) {
        var active;
        try {
          active = ctx.sidebarRight.active();
        } catch (err) {
          active = undefined;
        }
        if (active !== undefined && active.kind !== GUIDE_KIND) return; // 用户已经开了别的页签
        try {
          ctx.sidebarRight.openTab(FILES_KIND);
        } catch (err) {
          if (attempt < SEED_ATTEMPTS) {
            window.setTimeout(function () {
              openFilesDefault(attempt + 1);
            }, SEED_RETRY_MS);
          }
          return;
        }
        if (active !== undefined) {
          try {
            ctx.sidebarRight.close(active.id);
          } catch (err) {
            // 已被关掉: 不是错误
          }
        }
      }

      /** 只跑副作用、不渲染任何东西: 给每个会话铺一次右侧栏默认页签。 */
      function SessionSeed(props) {
        var sessionId = props.sessionId;
        React.useEffect(
          function () {
            if (typeof sessionId !== 'string' || sessionId === '') return;
            seedRightbar(sessionId);
          },
          [sessionId],
        );
        return null;
      }

      // ---- vendor 资产: xterm 走静态资源路由 ----
      //
      // 刻意不把 xterm 内联进 client bundle: 那会 +300KB, 且浏览器模块表解析不到
      // 任意 node_modules。改由 host 的白名单路由伺服官方构建产物。

      var xtermPromise = null;
      /** xterm.css 的 `<link>` 是否已插入(重试路径不重复插, 见 ensureXterm)。 */
      var xtermCssLinked = false;

      function loadScript(src) {
        return new Promise(function (resolve, reject) {
          var el = document.createElement('script');
          el.src = src;
          el.async = false;
          el.onload = function () {
            resolve();
          };
          el.onerror = function () {
            // 加载失败的 <script> 留在 head 里没有意义, 且重试时还会再插一枚 —— 立即摘掉。
            if (el.parentNode !== null) el.parentNode.removeChild(el);
            reject(new Error('fge: failed to load ' + src));
          };
          document.head.appendChild(el);
        });
      }

      // ---- 终端配色: 跟主题 token, 不跟 xterm 的默认黑 ----
      //
      // ⚠ xterm 的 `theme.background` 只认**具体颜色**。原来传的是 `rgba(0,0,0,0)`(想"透明、露出容器底色"),
      // 实测被判为无效值 → 静默回落到 xterm 自家的默认黑 `#000`, 于是浅色主题下标题条(白)与终端体(黑)
      // 对不上 —— 标题条那条"接缝"用的是 `box-shadow: 0 1px 0 var(--dsw-alias-bg-base)`, 白线压在黑底上,
      // 看起来就是"标题条错位/断开"。所以这里按主题色算出**不透明**的 #rrggbb 再交给 xterm。
      /** 所有活着的 xterm 实例: 主题一换要就地更新(组件重挂才算的话, 抽屉不关就一直是旧主题)。 */
      var liveTerms = new Set();
      /** 最近一次 theme/change 的快照: 新开的终端直接用它算色, 不必等下次主题切换。 */
      var lastThemeSnapshot = null;

      /** 把一个 CSS 颜色(可能是 hex / rgb() / oklch() / color-mix())归一成 xterm 认得的写法。 */
      function normalizeColor(value) {
        if (typeof value !== 'string' || value.trim() === '') return null;
        try {
          var ctx2d = document.createElement('canvas').getContext('2d');
          ctx2d.fillStyle = '#000000';
          ctx2d.fillStyle = value.trim();
          return ctx2d.fillStyle;
        } catch (err) {
          return null;
        }
      }

      /** 主题 token → xterm theme。token 缺位时给一组中性的明色, 绝不回落成 xterm 的黑。 */
      function terminalTheme(snapshot) {
        function token(name, fallback) {
          var raw =
            snapshot !== undefined && snapshot !== null && snapshot.tokens !== undefined
              ? snapshot.tokens[name]
              : undefined;
          if (typeof raw === 'string' && raw.trim() !== '') return raw;
          if (typeof document !== 'undefined' && document.body !== null) {
            return getComputedStyle(document.body).getPropertyValue(name);
          }
          return fallback;
        }
        var dark =
          snapshot !== undefined && snapshot !== null && snapshot.active !== undefined
            ? snapshot.active.colorScheme === 'dark'
            : false;
        // 底色必须与 CSS 里那只 `.fge-term-body / .xterm-viewport` 的 `TERM_SURFACE` 一致(都是 code-block),
        // 否则 xterm 画出来的画布与容器不同色, 又会出现"接缝"。见 TERM_SURFACE 的注释。
        var backgroundToken = token(TERM_SURFACE_TOKEN, '');
        if (typeof backgroundToken !== 'string' || backgroundToken.trim() === '') {
          backgroundToken = token('--dsw-alias-bg-base', dark ? '#151517' : '#ffffff');
        }
        var background = normalizeColor(backgroundToken);
        var foreground = normalizeColor(token('--dsw-alias-label-primary', dark ? '#f9fafb' : '#0f1115'));
        return {
          background: background === null ? (dark ? '#151517' : '#ffffff') : background,
          foreground: foreground === null ? (dark ? '#f9fafb' : '#0f1115') : foreground,
          cursor: foreground === null ? (dark ? '#f9fafb' : '#0f1115') : foreground,
          cursorAccent: background === null ? (dark ? '#151517' : '#ffffff') : background,
          selectionBackground: 'rgba(103,153,254,.35)',
        };
      }

      /** 主题变了就更新每个活着的终端(snapshot 可能早于 CSS 落盘, 下一帧再读一次 token 也无妨)。 */
      function applyTerminalTheme(snapshot) {
        var theme = terminalTheme(snapshot);
        liveTerms.forEach(function (term) {
          try {
            term.options.theme = theme;
          } catch (err) {
            // 实例已销毁: 忽略
          }
        });
      }

      /**
       * 懒加载 xterm(vendor 白名单路由), 结果缓存在 `xtermPromise`。
       *
       * ⚠ **失败不能把拒绝态永久缓存**: vendor 资产缺失(host 返回 503, 例如插件换了目录却
       * 没跑 `pnpm --dir plugins/file-git-explorer install`)是一次性的环境问题 —— 环境修好后
       * 应该「重开抽屉」就恢复。若把 rejected promise 缓存住, 用户只能**整页刷新**,
       * 而界面提示(「终端不可用(检查依赖与 host 日志)」)根本没提要刷新。
       * 所以失败时把 `xtermPromise` 置回 null, 下次调用重新拉一遍(`<link>` 只插一次,
       * 失败的 `<script>` 已被 loadScript 摘掉)。
       */
      function ensureXterm() {
        if (xtermPromise !== null) return xtermPromise;
        if (!xtermCssLinked) {
          xtermCssLinked = true;
          var link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = VENDOR_BASE + '/xterm.css';
          document.head.appendChild(link);
        }
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
          })
          .catch(function (err) {
            xtermPromise = null; // 见上方: 失败不缓存, 允许「重开抽屉」重试
            throw err;
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
                  theme: terminalTheme(lastThemeSnapshot),
                });
                fit = new mod.FitAddon();
                term.loadAddon(fit);
                term.open(hostRef.current);
                termRef.current = term;
                fitRef.current = fit;
                liveTerms.add(term);
                // 拖动选中之后**没法复制**(终端自己不吃系统的复制快捷键), 所以按用户口径加一条
                // **Alt+C = 复制选区**。⚠ 不用 Ctrl+C —— 那是 SIGINT, 必须原样送给 PTY;
                // 也不占 Ctrl+Shift+C(那是浏览器/DevTools 的"检查元素", 抢了很碍事)。
                // `attachCustomKeyEventHandler` 返回 false = 这次按键不送给 PTY。
                term.attachCustomKeyEventHandler(function (ev) {
                  if (ev.type !== 'keydown') return true;
                  if (!ev.altKey) return true;
                  if (!(ev.key === 'c' || ev.key === 'C' || ev.code === 'KeyC')) return true;
                  var selected = typeof term.getSelection === 'function' ? term.getSelection() : '';
                  if (typeof selected === 'string' && selected !== '') {
                    try {
                      Promise.resolve(primitives.writeClipboard(selected)).catch(function (err) {
                        console.warn('[fge] 复制终端选区失败', err);
                      });
                    } catch (err) {
                      console.warn('[fge] 复制终端选区失败', err);
                    }
                  }
                  return false;
                });
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
                liveTerms.delete(term);
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

      /** 按会话缓存的 git 页签视图状态(见 GitTabBody 顶部注释)。 */
      var gitViews = new Map();

      /**
       * 本插件的常驻 git 页签。
       *
       * 页签内是**两份列表**(变更列表 + 提交历史), 点提交**就地展开**它的文件, 所以
       * 页签内没有「返回上一层」这件事。点任一文件(变更行的、或提交展开出来的)都把
       * diff 送进悬浮面板 —— git 本体不开悬浮面板。
       *
       * ⚠ 本组件**会被卸载重挂**: dockkit 只渲染活动页签的页签体, 而点文件打开的 diff 页签会成为
       * 活动页签, 于是 git 页签体被卸载; diff 页签浮起后离开页签条, git 页签又成为活动页签、重新挂载。
       * 状态若只放组件里, 就会出现"点一下文件, 历史列表闪一下、刚展开的提交被收起来"(实测复现)。
       * 所以 info / status / 查看分支 / 历史 / 展开表都按会话 + 工作区缓存在模块级 Map 里, 重挂时恢复,
       * 并且**同一工作区的重挂不重新拉取**(不闪)。
       */
      function GitTabBody(props) {
        var useTabInfo = props.useTabInfo;
        var sessionId = props.sessionId;
        var useSessions = props.useSessions;

        var tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
        var visible = !!(tabInfo && tabInfo.tab && tabInfo.tab.visible);

        var sessionCwd = useSessionCwd(useSessions, sessionId);
        var running = useSessionRunning(useSessions, sessionId);

        // 只有"同一个工作区"的缓存可以直接复用; 换工作区必须重来。
        var viewKey = sessionId || '(no-session)';
        var cachedView = gitViews.get(viewKey);
        var restored =
          cachedView !== undefined && cachedView.cwd === sessionCwd ? cachedView : null;

        var infoPair = React.useState(restored === null ? null : restored.info);
        var info = infoPair[0];
        var setInfo = infoPair[1];
        var statusPair = React.useState(restored === null ? null : restored.status);
        var status = statusPair[0];
        var setStatus = statusPair[1];
        var errorPair = React.useState(null);
        var error = errorPair[0];
        var setError = errorPair[1];
        var busyPair = React.useState(false);
        var busy = busyPair[0];
        var setBusy = busyPair[1];
        var refPair = React.useState(restored === null ? '' : restored.viewedRef);
        var viewedRef = refPair[0];
        var setViewedRef = refPair[1];
        var histPair = React.useState(restored === null ? null : restored.history);
        var history = histPair[0];
        var setHistory = histPair[1];
        var expPair = React.useState(restored === null ? {} : restored.expanded);
        var expanded = expPair[0];
        var setExpanded = expPair[1];
        var menuPair = React.useState(false);
        var menuOpen = menuPair[0];
        var setMenuOpen = menuPair[1];

        // 分支小浮窗的锚点(头部那颗分支按钮)与面板; 定位与"点外面关掉"都用官方原语:
        // useAnchoredPosition 给视口坐标 + 视口内钳制, useDismissOnOutsidePointer 管外部 pointerdown。
        var branchAnchorRef = React.useRef(null);
        var branchMenuRef = React.useRef(null);
        var branchMenuPos = primitives.useAnchoredPosition({
          open: menuOpen,
          anchorRef: branchAnchorRef,
          panelRef: branchMenuRef,
          side: 'bottom',
          gap: 4,
          margin: 8,
        });
        primitives.useDismissOnOutsidePointer(
          branchAnchorRef,
          menuOpen,
          setMenuOpen,
          branchMenuRef,
        );

        // Esc 关小浮窗(焦点分流与终端一致: 终端里的 Esc 归终端)。
        React.useEffect(
          function () {
            if (!menuOpen) return undefined;
            function onKey(ev) {
              if (ev.key === 'Escape') setMenuOpen(false);
            }
            document.addEventListener('keydown', onKey, true);
            return function () {
              document.removeEventListener('keydown', onKey, true);
            };
          },
          [menuOpen],
        );

        /**
         * 最近一次 info/status 得到的根, 供各次 git 调用复用(避免把 status 塞进所有依赖)。
         * 重挂时直接从缓存里恢复 —— 否则刚挂载就点文件会带着空的 repoRoot 去请求。
         */
        var repoRef = React.useRef({
          root: restored !== null && restored.info !== null ? restored.info.cwd : null,
          repoRoot: restored !== null && restored.status !== null ? restored.status.repoRoot : null,
        });
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

        // 视图状态回写缓存(每次渲染后都写)。重挂时就是靠它恢复的。
        React.useEffect(function () {
          gitViews.set(viewKey, {
            cwd: sessionCwd,
            info: info,
            status: status,
            viewedRef: viewedRef,
            history: history,
            expanded: expanded,
          });
        });

        React.useEffect(
          function () {
            // 同一工作区的重挂(例如点文件开了 diff 页签又回来): 从缓存恢复, 既不清状态也不重新拉取。
            if (restored !== null) return;
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
        function pickBranch(name) {
          setMenuOpen(false);
          setViewedRef(name);
          setHistory(null);
          loadHistory(name, 0);
        }

        // ---- 头部 ----
        var current = status ? status.current : null;
        var detached = !!(status && status.detached);
        var branchLabel =
          current || (detached ? '(分离 HEAD)' : status && status.initial ? '(无提交)' : '—');

        var head = h(
          'div',
          { className: 'fge-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'fge-branch',
              ref: branchAnchorRef,
              title: '本地 / 远程分支: 点一个查看它的提交历史与 diff(不改工作区的实际分支)',
              'aria-expanded': menuOpen ? 'true' : 'false',
              onClick: function () {
                setMenuOpen(function (open) {
                  return !open;
                });
              },
            },
            h(primitives.IconBranchOutline16, { size: 14 }),
            h('span', { className: 'fge-branch-name' }, branchLabel),
            h(primitives.IconChevronDownOutline14, {
              size: 12,
              className: 'fge-branch-caret',
            }),
          ),
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
        /** 本地 / 远程两组; 远程再按 remote 名分成子树(展示用"树", 点击看该分支的历史)。 */
        var branchTree = { local: [], remotes: [] };
        var remoteIndexOf = {};
        for (var bi = 0; bi < branches.length; bi += 1) {
          var branch = branches[bi];
          if (!branch.remote) {
            branchTree.local.push({ full: branch.name, short: branch.name, remote: null });
            continue;
          }
          var slash = branch.name.indexOf('/');
          var remoteName = slash === -1 ? branch.name : branch.name.slice(0, slash);
          var shortName = slash === -1 ? branch.name : branch.name.slice(slash + 1);
          if (remoteIndexOf[remoteName] === undefined) {
            remoteIndexOf[remoteName] = { remote: remoteName, branches: [] };
            branchTree.remotes.push(remoteIndexOf[remoteName]);
          }
          remoteIndexOf[remoteName].branches.push({
            full: branch.name,
            short: shortName,
            remote: remoteName,
          });
        }

        /** 小浮窗里的一行分支。 */
        function branchRow(item) {
          var isCurrent = current !== null && item.full === current;
          var isViewed = viewedRef !== '' && viewedRef === item.full;
          var mark = isCurrent ? '当前' : isViewed ? '查看中' : '';
          return h(
            'div',
            {
              key: 'br:' + item.full,
              className: 'fge-branch-item' + (item.remote === null ? '' : ' fge-branch-sub'),
              'data-viewed': isViewed ? '1' : undefined,
              title: item.full,
              onClick: function () {
                pickBranch(item.full);
              },
            },
            h('span', { className: 'fge-branch-name' }, item.short),
            h('span', { className: 'fge-branch-mark' }, mark),
          );
        }

        var branchMenu = null;
        if (menuOpen) {
          var menuRows = [];
          menuRows.push(h('div', { key: 'g:local', className: 'fge-branch-group' }, '本地分支'));
          if (branchTree.local.length === 0) {
            menuRows.push(h('div', { key: 'g:local:none', className: 'fge-branch-item' }, '(无)'));
          }
          for (var li = 0; li < branchTree.local.length; li += 1) {
            menuRows.push(branchRow(branchTree.local[li]));
          }
          menuRows.push(h('div', { key: 'g:remote', className: 'fge-branch-group' }, '远程分支'));
          if (branchTree.remotes.length === 0) {
            menuRows.push(h('div', { key: 'g:remote:none', className: 'fge-branch-item' }, '(无)'));
          }
          for (var ri = 0; ri < branchTree.remotes.length; ri += 1) {
            var group = branchTree.remotes[ri];
            menuRows.push(
              h('div', { key: 'g:r:' + group.remote, className: 'fge-branch-group' }, group.remote),
            );
            for (var gi = 0; gi < group.branches.length; gi += 1) {
              menuRows.push(branchRow(group.branches[gi]));
            }
          }
          branchMenu = h(
            'div',
            {
              className: 'fge-branch-menu',
              ref: branchMenuRef,
              role: 'listbox',
              // 面板先渲染才能被量到(useAnchoredPosition 量的是面板自己的 offsetWidth):
              // 位置未算出时先藏起来, 布局 effect 跑完就可见 —— 中间不会有闪动。
              style: {
                left: branchMenuPos === null ? 0 : branchMenuPos.left,
                top: branchMenuPos === null ? 0 : branchMenuPos.top,
                visibility: branchMenuPos === null ? 'hidden' : 'visible',
              },
            },
            menuRows,
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
              'span',
              { className: 'fge-chip', title: '正在查看哪个分支的历史(点头部的分支按钮可换)' },
              '查看 ' + (viewedRef || current || '当前分支'),
            ),
          ),
          h('div', null, historyRows),
        );

        return h(
          'div',
          { className: 'fge-root' },
          head,
          branchMenu,
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
          // 条 = Windows Terminal 观感的「标题条」: 点条空白处收起(不杀进程), 与点页签上的 `×` 等价;
          // 页签里**恒定只有当前工作区这一枚**(外观档, 不引入多终端, 见 CONTEXT.md「终端标题条」)。
          // 条内按钮上的点击要 stopPropagation, 否则会连带收起。
          h(
            'div',
            {
              className: 'fge-term-strip',
              title: '点击收起(不杀进程)',
              onClick: function () {
                setDrawer(false);
              },
            },
            h(
              'div',
              {
                className: 'fge-term-tab',
                title: root || '(无工作区)',
              },
              h('span', { className: 'fge-term-tab-glyph' }, '>_'),
              h('span', { className: 'fge-term-tab-title' }, root || '(无工作区)'),
              h(
                'button',
                {
                  className: 'fge-term-tab-close',
                  title: '收起(不杀进程)',
                  'aria-label': '收起终端抽屉',
                  onClick: function (ev) {
                    ev.stopPropagation();
                    setDrawer(false);
                  },
                },
                '×',
              ),
            ),
            h('span', { className: 'fge-spacer' }),
            h(
              'button',
              {
                className: 'fge-btn fge-term-glyph fge-term-kill',
                title: '终止整棵终端进程树',
                'aria-label': '终止终端进程树',
                onClick: function (ev) {
                  ev.stopPropagation();
                  if (root !== '') killTerminal(root);
                },
              },
              '■',
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

      // 空渲染的座位, 只用来给每个会话铺一次右侧栏默认页签(见 seedRightbar)。
      ctx.effect(function () {
        return slots.inject('conversation.composer.dock', function () {
          return slots.register(
            { name: 'conversation.composer.dock', id: 'fge-session-seed', order: 40 },
            SessionSeed,
          );
        });
      }, 'fge: rightbar default tab');

      // 右栏宽度: 启动时落上次拖动过的值, 再把官方那根拖柄接管过来(钳在 [200px, 15vw], 见 attachRightbarDrag)。
      ctx.effect(
        function () {
          var stored = readRightbarWidth();
          if (stored !== null) applyRightbarWidth(stored);
          return attachRightbarDrag();
        },
        'fge: rightbar width drag',
      );

      // 终端配色跟主题走(见 terminalTheme): 官方主题一换, 已经开着的 xterm 就地更新, 不必重开抽屉。
      ctx.effect(
        function () {
          function onTheme(snapshot) {
            lastThemeSnapshot = snapshot;
            applyTerminalTheme(snapshot);
          }
          var off = ctx.on('theme/change', onTheme);
          return function () {
            if (typeof off === 'function') off();
          };
        },
        'fge: terminal follows theme',
      );

      // 记「用户动手之前右栏选中的那一格」: 浮起详情之后 focus 回去, 右栏不会自己跳走(见 restoreUserTab)。
      // 捕获阶段: 要在官方正文里的点击处理之前读到页签条的选中态。
      ctx.effect(
        function () {
          document.addEventListener('click', rememberUserTab, true);
          return function () {
            document.removeEventListener('click', rememberUserTab, true);
          };
        },
        'fge: remember the user tab before a detail opens',
      );

      // Esc 关掉本插件浮起的详情。跟终端抽屉共用同一条焦点分流: 焦点在终端里时 Esc 归终端
      // (见 TerminalDock 的 keydown), 不要连带把悬浮面板也关掉。
      ctx.effect(
        function () {
          function onKey(ev) {
            if (ev.key !== 'Escape') return;
            if (floatTarget === null) return;
            var host = typeof document === 'undefined' ? null : document.getElementById('fge-term-host');
            var active = typeof document === 'undefined' ? null : document.activeElement;
            if (host !== null && active !== null && host.contains(active)) return;
            closeOwnedFloat();
          }
          document.addEventListener('keydown', onKey, true);
          return function () {
            document.removeEventListener('keydown', onKey, true);
          };
        },
        'fge: close float on Escape',
      );

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

      // 插件卸载: 撤掉本插件浮起的详情, 不留孤儿页签与缓存。
      ctx.effect(
        function () {
          return function () {
            closeOwnedFloat();
            diffs.clear();
            gitViews.clear();
            seededSessions.clear();
          };
        },
        'fge: dispose float state',
      );

      console.info('[fge] ready — 右侧栏「git 页签」+ 详情悬浮面板, composer 下的终端抽屉');
    };

    return module.exports;
  },
});
