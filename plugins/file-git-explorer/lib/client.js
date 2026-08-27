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
        '.fge-branch-menu{position:absolute;right:calc(100% + 8px);top:30px;width:280px;max-width:60vw;z-index:45;background:var(--dsw-alias-bg-overlay);' +
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
        // 右树顶部分支下拉为纯展示清单: 行不可点 —— 关掉指针与 hover 反色,
        // 状态色(当前/查看中)保持常亮; 历史面板的同款菜单(.fge-hmenu)仍可点选。
        '.fge-branch-static{cursor:default;}' +
        '.fge-branch-item.fge-branch-static:hover{background:none;}' +
        '.fge-branch-item.fge-branch-static:not(.fge-branch-current):not(.fge-branch-viewed):hover' +
        '{color:var(--dsw-alias-label-secondary);}' +
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
        '.fge-resize-right{left:-3px;}' +
        '.fge-search-row{display:flex;align-items:center;gap:4px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;}' +
        '.fge-search-input{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-2);border:1px solid transparent;border-radius:6px;' +
        'color:var(--dsw-alias-label-primary);padding:3px 8px;font-size:12px;outline:none;}' +
        '.fge-search-input:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);}' +
        '.fge-search-input::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}' +
        '.fge-result{display:flex;align-items:center;gap:6px;padding:2px 8px;cursor:pointer;white-space:nowrap;' +
        'color:var(--dsw-alias-label-secondary);border-radius:4px;}' +
        '.fge-result:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}' +
        '.fge-result-name{flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;}' +
        '.fge-result-dir{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));' +
        'font-size:11px;overflow:hidden;text-overflow:ellipsis;text-align:right;}' +
        '.fge-badge-v{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);}' +
        '.fge-badge-h{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 15%,transparent);}' +
        '.fge-badge-i{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}' +
        '.fge-commit{padding:4px 8px;border-radius:0;cursor:pointer;color:var(--dsw-alias-label-secondary);' +
        'border-bottom:1px solid var(--dsw-alias-border-l1);}' +
        '.fge-commit:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}' +
        '.fge-commit-subject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.fge-commit-meta{display:flex;align-items:center;gap:6px;margin-top:1px;' +
        'font-size:10px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}' +
        '.fge-hash{font-family:Consolas,Menlo,monospace;}' +
        '.fge-stat-add{color:var(--dsw-alias-state-success-primary);flex:none;}' +
        '.fge-stat-del{color:var(--dsw-alias-state-error-primary);flex:none;}' +
        '.fge-cfile{display:flex;align-items:center;gap:8px;padding:3px 4px;border-radius:0;cursor:pointer;' +
        'white-space:nowrap;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);}' +
        // 历史面板头部的查看分支切换器 + 其下拉菜单(挂在 float 面板内, 不出面板)
        '.fge-hbranch{flex:none;display:inline-flex;align-items:center;gap:4px;max-width:46%;border:1px solid transparent;' +
        'background:transparent;color:var(--dsw-alias-brand-primary);border-radius:6px;padding:2px 6px;font-size:12px;' +
        'font-weight:600;cursor:pointer;line-height:1.4;}' +
        '.fge-hbranch:hover{background:var(--dsw-alias-bg-layer-2);}' +
        '.fge-hbranch > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.fge-hmenu{position:absolute;left:8px;top:32px;width:280px;max-width:calc(100% - 16px);z-index:45;' +
        'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;' +
        'box-shadow:var(--dsh-shadow-lv2,rgba(0,0,0,.25)) 0 8px 28px;max-height:240px;overflow:auto;padding:4px;}' +
        '.fge-cfile:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}' +
        '.fge-cfile-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}' +
        '.fge-msg{margin:0 0 8px;padding:6px 8px;background:var(--dsw-alias-bg-layer-2);border-radius:6px;' +
        'white-space:pre-wrap;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);font-family:inherit;}' +
        // ---- shell 行(shell bar) ----
        // 行顶边框 = 输出窗的下边缘: 弱化(25% 透明度), 与输出窗上边框的强化形成对比
        '.fge-shell-row{display:flex;align-items:center;gap:3px;padding:4px 6px;' +
        'border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 25%,transparent);flex:none;}' +
        '.fge-shell-row .fge-btn{padding:2px 4px;}' + // 行内按钮紧凑化, 给输入框让宽
        '.fge-shell-input{flex:1;min-width:0;background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;' +
        'padding:3px 8px;font-size:12px;color:var(--dsw-alias-label-primary);' +
        'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}' +
        '.fge-shell-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}' +
        '.fge-shell-input::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}' +
        // 运行中锁输入: 只读 + 视觉弱化, 光标离开输入框, 任务结束后恢复可编辑
        '.fge-shell-input.fge-shell-locked{opacity:.6;cursor:not-allowed;}' +
        // 输入框末端的运行状态点: 红色=已停止(默认) 绿色=运行中/启动中; 绝对定位于
        // 输入框右缘, pointer-events 穿透, 不遮挡文本输入(输入框右侧留出点位)。
        '.fge-shell-inputwrap{position:relative;flex:1;min-width:0;display:flex;align-items:center;}' +
        '.fge-shell-inputwrap .fge-shell-input{flex:1;min-width:0;width:100%;box-sizing:border-box;padding-right:20px;}' +
        '.fge-shell-dot{position:absolute;right:8px;top:50%;transform:translateY(-50%);' +
        'width:8px;height:8px;border-radius:50%;pointer-events:none;' +
        'background:var(--dsw-alias-state-error-primary);}' +
        '.fge-shell-dot.fge-shell-dot-run{background:var(--dsw-alias-state-success-primary);}' +
        // 输出窗: 常驻显示, 默认一行高(自动滚底显示最新一行); 点击行首箭头展开完整。
        // 上下边框均为粒子鲸鱼淡化蓝(rgb 103,153,254)呼吸灯: 展开态同步脉动,
        // 上强下弱(上 .28↔.9, 下 .08↔.32); 只脉动边框颜色, 不用 box-shadow
        // (光晕会向左右扩散, 像左右边框也在呼吸)。
        '.fge-shell-tail{flex:none;max-height:1.6em;overflow:hidden;margin:0;padding:4px 8px;' +
        'border-top:1px solid rgba(103,153,254,.28);' +
        'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;' +
        // 不自动换行: 长行横向滚动, 终端式阅读更直观
        'white-space:pre;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);}' +
        '.fge-shell-tail.fge-shell-tail-open{max-height:150px;overflow:auto;' +
        'animation:fge-tail-breathe-top 3s ease-in-out infinite;}' +
        '.fge-shell-tail.fge-shell-tail-open + .fge-shell-row{' +
        'animation:fge-tail-breathe-bottom 3s ease-in-out infinite;}' +
        '@keyframes fge-tail-breathe-top{' +
        '0%,100%{border-top-color:rgba(103,153,254,.28);}' +
        '50%{border-top-color:rgba(103,153,254,.9);}}' +
        '@keyframes fge-tail-breathe-bottom{' +
        '0%,100%{border-top-color:rgba(103,153,254,.08);}' +
        '50%{border-top-color:rgba(103,153,254,.32);}}' +
        '@media (prefers-reduced-motion: reduce){' +
        '.fge-shell-tail.fge-shell-tail-open,' +
        '.fge-shell-tail.fge-shell-tail-open + .fge-shell-row{animation:none;}}';

      // ---- 文件编辑(textarea)与树内写操作样式 ----
      STYLE_CSS +=
        '.fge-section-head{display:flex;align-items:center;gap:4px;}' +
        '.fge-section-head-sp{flex:1;min-width:6px;}' +
        '.fge-headplus{flex:none;display:inline-flex;border:0;background:transparent;color:inherit;cursor:pointer;' +
        'padding:1px 5px;border-radius:4px;font-size:13px;line-height:1;opacity:.65;font-family:inherit;}' +
        '.fge-headplus:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);opacity:1;}' +
        '.fge-rowacts{display:none;margin-left:auto;flex:none;align-items:center;gap:1px;}' +
        '.fge-node:hover .fge-rowacts,.fge-node:focus-within .fge-rowacts{display:inline-flex;}' +
        '.fge-rowact{border:0;background:transparent;color:inherit;cursor:pointer;padding:1px 3px;' +
        'font-size:12px;line-height:1;border-radius:3px;opacity:.55;font-family:inherit;}' +
        '.fge-node:hover .fge-rowact{opacity:1;}' +
        '.fge-rowact:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);}' +
        '.fge-rowact.fge-danger:hover{color:var(--dsw-alias-state-error-primary);}' +
        '.fge-oprow{display:flex;flex-wrap:wrap;align-items:center;gap:4px;}' +
        '.fge-opinput{flex:1;min-width:80px;background:var(--dsw-alias-bg-layer-2);' +
        'border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);border-radius:6px;' +
        'color:var(--dsw-alias-label-primary);padding:2px 8px;font-size:12px;outline:none;font-family:inherit;}' +
        '.fge-opinput::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}' +
        '.fge-ophint{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));white-space:nowrap;}' +
        '.fge-operr{flex-basis:100%;font-size:11px;line-height:1.35;color:var(--dsw-alias-state-error-primary);padding-left:2px;}' +
        '.fge-editorcol{flex:1;min-height:0;display:flex;flex-direction:column;}' +
        '.fge-editbar{flex:none;display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:11px;' +
        'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}' +
        '.fge-editbar-dirty{color:var(--dsw-alias-state-warn-primary);font-weight:600;}' +
        '.fge-editbar-saved{color:var(--dsw-alias-state-success-primary);}' +
        '.fge-textarea{flex:1;min-height:0;width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);' +
        'color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px;' +
        'font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre;overflow:auto;' +
        'resize:none;outline:none;tab-size:2;}' +
        '.fge-textarea:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);}' +
        '.fge-saveerr{flex:none;margin-bottom:6px;font-size:11px;color:var(--dsw-alias-state-error-primary);}' +
        '.fge-conflict{flex:none;margin-bottom:6px;padding:6px 8px;border:1px solid ' +
        'color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);' +
        'background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);border-radius:6px;' +
        'font-size:11px;line-height:1.5;color:var(--dsw-alias-label-primary);}' +
        // ---- 删除确认 / 失败提示(DSH 风格模态: 遮罩 + 居中卡片 + 底部按钮) ----
        '.fge-mask{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;' +
        'pointer-events:auto;background:rgba(8,10,16,.5);}' +
        '.fge-mbox{min-width:300px;max-width:min(420px,calc(100vw - 48px));box-sizing:border-box;' +
        'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;' +
        'box-shadow:var(--dsw-shadow-lv3,rgba(0,0,0,.35)) 0 18px 60px;padding:18px 20px 16px;' +
        'color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;}' +
        '.fge-mtitle{font-size:14px;font-weight:600;margin-bottom:8px;}' +
        '.fge-mbody{color:var(--dsw-alias-label-secondary);margin-bottom:18px;word-break:break-word;}' +
        '.fge-mfoot{display:flex;justify-content:flex-end;gap:8px;}' +
        '.fge-mbtn{border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;' +
        'border:1px solid transparent;line-height:1.5;}' +
        '.fge-mbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}' +
        '.fge-mbtn-ghost{background:transparent;border-color:var(--dsw-alias-border-l2);' +
        'color:var(--dsw-alias-label-secondary);}' +
        '.fge-mbtn-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}' +
        '.fge-mbtn-danger{background:var(--dsw-alias-state-error-primary);color:#fff;}' +
        '.fge-mbtn-danger:hover{filter:brightness(1.1);}' +
        '.fge-mbtn-brand{background:var(--dsw-alias-brand-primary);color:#fff;}' +
        '.fge-mbtn-brand:hover{filter:brightness(1.1);}';
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

      // ---- 会话头部 tablist 认领(观测器与几何回退共用) ----
      // 页面可能存在其他 tablist(设置弹窗等), 以包含「对话」页签者为准;
      // 都不含时退回第一个。
      function findSessionTablist() {
        var lists = [];
        try {
          lists = Array.prototype.slice.call(document.querySelectorAll('[role="tablist"]'));
        } catch (e) {
          lists = [];
        }
        if (!lists.length) return null;
        function tabsOf(list) {
          return Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
        }
        for (var li = 0; li < lists.length; li++) {
          var hasChat = tabsOf(lists[li]).some(function (t) {
            return (t.textContent || '').trim() === '对话';
          });
          if (hasChat) return lists[li];
        }
        return lists[0];
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
        if (scrollBody) {
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
        // 非对话视图(轨迹/数据库等页签): 无对话滚动容器。退化为以会话头部
        // tablist 底缘为顶、视口底为底、tablist 所在列左右缘为横向界 —— 保证
        // 细条在非对话视图仍可悬停展开(数据库页签下复制文件地址依赖此路径)。
        // 连 hero 空态(无 tablist)都缺失时维持旧行为返回 null(整组不渲染)。
        // tablist 认领规则与观测器一致(见 findSessionTablist)。
        var tabsEl = findSessionTablist();
        if (!tabsEl) return null;
        var tr = tabsEl.getBoundingClientRect();
        if (!tr || (tr.width === 0 && tr.height === 0)) return null;
        var fbTop = tr.bottom + 6;
        var fbBottom = window.innerHeight - 12;
        var fbContentW = 748;
        var fbGap = Math.max(0, (tr.width - fbContentW) / 2);
        return {
          top: fbTop,
          bottom: fbBottom,
          sbLeft: tr.left,
          sbRight: tr.right,
          convLeft: tr.left + fbGap,
          convRight: tr.right - fbGap,
          height: Math.max(0, fbBottom - fbTop),
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

      // 当前会话摘要: 从会话 store 快照取 current 对应的会话(无则返回 null)
      function currentSession(s) {
        if (!s || !s.current) return null;
        return (s.byId && s.byId[s.current]) || null;
      }

      // 延迟收起 —— 保持区(union)追踪器: 一侧的侧栏与其全部悬浮栏共享一个
      // 「鼠标在场」区域集; 只要指针还在任一已登记区域就不收起, 全部离开后才
      // 启动 HIDE_DELAY_MS 宽限定时器, 期间进入任一区域则取消。
      // 区域登记名约定: 左侧 lp=文件树面板 cf=内容悬浮栏;
      //                右侧 rp=git树面板 df=diff悬浮栏 hs=提交历史悬浮栏
      //                hd=提交内文件 diff 悬浮栏(历史详情点文件行后单开)。
      // (分支下拉/历史分组菜单是面板 DOM 子孙, 指针移入不触发面板 mouseleave,
      //  无需登记。)
      var HIDE_DELAY_MS = 360;
      function makeSideTracker(onFire) {
        var timer = null;
        var active = {};
        function anyActive() {
          for (var k in active) if (active[k]) return true;
          return false;
        }
        function clearT() {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        }
        return {
          enter: function (name) {
            active[name] = true;
            clearT();
          },
          leave: function (name) {
            active[name] = false;
            if (!anyActive()) {
              clearT();
              timer = setTimeout(function () {
                timer = null;
                onFire();
              }, HIDE_DELAY_MS);
            }
          },
          dispose: function () {
            clearT();
          },
        };
      }

      // ---- 懒加载树(每个分区一棵) ----
      // props: mode, root, refreshTick, onFileClick(rel, name, type),
      //        revealReq({rel, zone, tick} | null) —— 搜索结果点目录时的树内定位
      //        ops —— 树内写操作(create(parentRel,name,kind)/rename(row,newName)/
      //               remove(row), 均返回 Promise<{ok,error?,openRel?,openName?}>),
      //               由 LeftPanel 实现; 操作成功后经 ops 内部 fireReload 按需局部刷新。
      //        reloadReq({seq, rel}) —— 局部重载请求(挂到具体目录, 不作废展开状态)
      //        rootCreateReq({seq}) —— 本分区头"+"触发的根级新建
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
        var bodyRef = React.useRef(null);

        // ---- 树内写操作(新建/重命名)的行内待输入态 ----
        var pendState = React.useState(null); // {kind:'create'|'rename', rel, row?, err?}
        var pend = pendState[0];
        var setPend = pendState[1];
        var nameState = React.useState('');
        var name = nameState[0];
        var setName = nameState[1];
        var handledReloadRef = React.useRef(-1);
        var handledRootCreateRef = React.useRef(-1);

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
            setPend(null);
            setName('');
            loadChildren('', false);
            return function () {
              mounted.current = false;
            };
          },
          // 根变化(工作区切换)时同样作废整棵树
          [props.refreshTick, root],
        );

        // 局部重载请求: 只拉目标目录缓存并覆盖, 不清空展开/选中状态。
        // seq 去重保证同一事件只被每个分区的 LazyTree 各消费一次。
        React.useEffect(
          function () {
            var rq = props.reloadReq;
            if (!rq) return;
            if (handledReloadRef.current === rq.seq) return;
            handledReloadRef.current = rq.seq;
            loadChildren(rq.rel, false);
          },
          [props.reloadReq],
        );

        // 分区头"+": 在该分区根开启"新建"待输入行
        React.useEffect(
          function () {
            var rc = props.rootCreateReq;
            if (!rc) return;
            if (handledRootCreateRef.current === rc.seq) return;
            handledRootCreateRef.current = rc.seq;
            setPend({ kind: 'create', rel: '', row: null });
            setName('');
            if (cache[''] === undefined) loadChildren('', false);
          },
          [props.rootCreateReq],
        );

        // 树内 reveal(搜索结果点目录): 沿路径逐级加载 + 展开, 最后选中并闪现目标。
        // 链在某一层断掉(该区不展示此条目, 如可见区下的深层 dot 项)时,
        // 退化为高亮已到达的最深祖先。
        React.useEffect(
          function () {
            var req = props.revealReq;
            if (!req || !req.rel) return undefined;
            var alive = true;
            var segs = req.rel.split('/');
            var loadLevel = function (i) {
              var prefix = i === 0 ? '' : segs.slice(0, i).join('/');
              // hidden/ignored 区进入目录一律 reveal=true(展示全部子项)
              var revealFlag = mode !== 'visible' && i > 0;
              return api('tree', { root: root, path: prefix, mode: mode, reveal: revealFlag }).then(
                function (res) {
                  if (!alive || !res || !res.ok || !Array.isArray(res.entries)) return null;
                  setCache(function (prev) {
                    var next = {};
                    for (var k in prev) next[k] = prev[k];
                    next[prefix] = res.entries;
                    return next;
                  });
                  for (var j = 0; j < res.entries.length; j++) {
                    if (res.entries[j].name === segs[i]) return res.entries[j];
                  }
                  return null;
                },
              );
            };
            var finish = function (targetRel) {
              if (!alive) return;
              setSelected(targetRel);
              setTimeout(function () {
                if (!alive || !bodyRef.current || !targetRel) return;
                var el = bodyRef.current.querySelector('[data-fge-node="' + targetRel + '"]');
                if (!el) return;
                el.scrollIntoView({ block: 'nearest' });
                el.classList.add('fge-flash');
                var onEnd = function () {
                  el.classList.remove('fge-flash');
                  el.removeEventListener('animationend', onEnd);
                };
                el.addEventListener('animationend', onEnd);
              }, 30);
            };
            var walk = function (i) {
              if (i >= segs.length) {
                finish(req.rel);
                return;
              }
              loadLevel(i)
                .then(function (found) {
                  if (!alive) return;
                  if (!found) {
                    finish(i === 0 ? null : segs.slice(0, i).join('/'));
                    return;
                  }
                  if (found.type === 'dir') {
                    var p = segs.slice(0, i + 1).join('/');
                    setExpanded(function (prev) {
                      var next = {};
                      for (var k in prev) next[k] = prev[k];
                      next[p] = true;
                      return next;
                    });
                    walk(i + 1);
                  } else {
                    finish(found.rel);
                  }
                })
                .catch(function () {});
            };
            walk(0);
            return function () {
              alive = false;
            };
          },
          [props.revealReq],
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

        // ---- 行内写操作 ----
        var startCreateIn = function (row) {
          setPend({ kind: 'create', rel: row.rel, row: row });
          setName('');
          if (!expanded[row.rel]) {
            var next = {};
            for (var k in expanded) next[k] = true;
            next[row.rel] = true;
            setExpanded(next);
            if (!cache[row.rel]) loadChildren(row.rel, revealFor(row));
          }
        };
        var startRename = function (row) {
          setPend({ kind: 'rename', rel: row.rel, row: row });
          setName(row.name);
        };
        var askRemove = function (row) {
          props.ops.remove(row); // 确认与错误提示由 ops 实现(LeftPanel 层)
        };

        /** ops 失败码 → 行内短文案; cancelled(用户取消确认框)静默。 */
        var opErrorText = function (res) {
          if (res && res.ok) return null;
          var code = res && res.error ? String(res.error) : '失败';
          if (code === 'cancelled') return null;
          if (code === 'exists') return '同名条目已存在';
          if (code === 'invalid-path' || code === 'invalid-name')
            return '名称含非法字符或路径不合法';
          if (code === 'not-found') return '目标已不存在（可点头部刷新）';
          if (code === 'not-empty') return '目录非空';
          if (code === 'rpc-failed' || code === 'failed') return '请求失败';
          return code;
        };

        var submitOp = function () {
          if (!pend) return;
          var raw = String(name).trim();
          if (raw === '') {
            setPend(null);
            setName('');
            return;
          }
          if (pend.kind === 'rename') {
            if (pend.row && raw === pend.row.name) {
              setPend(null);
              setName('');
              return;
            }
            props.ops
              .rename(pend.row, raw)
              .then(function (res) {
                if (res && res.ok) {
                  setPend(null);
                  setName('');
                } else {
                  var msg = opErrorText(res);
                  setPend(msg === null ? null : Object.assign({}, pend, { err: msg }));
                }
              })
              .catch(function () {
                setPend(Object.assign({}, pend, { err: '请求失败' }));
              });
            return;
          }
          // create: 以 / 结尾建目录(多个斜杠取末段), 其余建文件; 名称可含 / 嵌套
          var isDir = raw.charAt(raw.length - 1) === '/';
          var clean = isDir ? raw.replace(/\/+$/, '') : raw;
          if (clean === '') {
            setPend(Object.assign({}, pend, { err: '请输入名称' }));
            return;
          }
          props.ops
            .create(pend.rel, clean, isDir ? 'dir' : 'file')
            .then(function (res) {
              if (res && res.ok) {
                setPend(null);
                setName('');
                if (res.openRel) props.onFileClick(res.openRel, res.openName, 'file');
              } else {
                var msg2 = opErrorText(res);
                setPend(msg2 === null ? null : Object.assign({}, pend, { err: msg2 }));
              }
            })
            .catch(function () {
              setPend(Object.assign({}, pend, { err: '请求失败' }));
            });
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

        var nodeElFor = function (row) {
          var icon = row.type === 'dir' ? (expanded[row.rel] ? '▾' : '▸') : '·';
          return React.createElement(
            'div',
            {
              key: row.rel,
              className:
                'fge-node' +
                (row.type === 'dir' ? ' fge-dir' : '') +
                (selected === row.rel ? ' fge-selected' : ''),
              'data-fge-node': row.rel,
              onClick: function () {
                toggle(row);
              },
              style: { paddingLeft: 6 + row.depth * 14 },
              title: row.rel,
            },
            React.createElement('span', { className: 'fge-node-icon' }, icon),
            React.createElement('span', { className: 'fge-node-name' }, row.name),
            props.ops
              ? React.createElement(
                  'span',
                  {
                    className: 'fge-rowacts',
                    onClick: function (e) {
                      e.stopPropagation(); // 点操作按钮不当成"切换该行"
                    },
                  },
                  row.type === 'dir'
                    ? React.createElement(
                        'button',
                        {
                          className: 'fge-rowact',
                          title: '新建子项（名称以 / 结尾建目录）',
                          onClick: function () {
                            startCreateIn(row);
                          },
                        },
                        '+',
                      )
                    : null,
                  React.createElement(
                    'button',
                    {
                      className: 'fge-rowact',
                      title: '重命名',
                      onClick: function () {
                        startRename(row);
                      },
                    },
                    '✎',
                  ),
                  React.createElement(
                    'button',
                    {
                      className: 'fge-rowact fge-danger',
                      title: row.type === 'dir' ? '删除目录(含全部内容)' : '删除文件',
                      onClick: function () {
                        askRemove(row);
                      },
                    },
                    '✕',
                  ),
                )
              : null,
          );
        };

        /** 待输入行(create/rename 共用): Enter 提交, Esc 取消; 错误显示在行内。 */
        var opRowElFor = function (depth, keySuffix) {
          return React.createElement(
            'div',
            {
              key: 'op-' + keySuffix,
              className: 'fge-oprow',
              style: { paddingLeft: 6 + depth * 14 },
            },
            React.createElement('input', {
              className: 'fge-opinput',
              value: name,
              autoFocus: true,
              placeholder:
                pend.kind === 'create' ? '名称（以 / 结尾建目录，可用 a/b 嵌套）' : '新名称',
              onFocus: function (ev) {
                if (pend.kind === 'rename' && ev.target.select) ev.target.select();
              },
              onChange: function (ev) {
                setName(ev.target.value);
              },
              onKeyDown: function (ev) {
                if (ev.key === 'Enter') {
                  ev.preventDefault();
                  submitOp();
                } else if (ev.key === 'Escape') {
                  ev.stopPropagation();
                  ev.preventDefault();
                  setPend(null);
                  setName('');
                } else if (ev.key === ' ' || ev.key === 'Tab') {
                  ev.stopPropagation(); // 空格/Tab 不冒泡触发面板快捷键语义
                }
              },
            }),
            React.createElement(
              'button',
              {
                className: 'fge-rowact',
                style: { opacity: 1 },
                title: '确认',
                onClick: function (ev) {
                  ev.stopPropagation();
                  submitOp();
                },
              },
              '✓',
            ),
            React.createElement(
              'button',
              {
                className: 'fge-rowact fge-danger',
                style: { opacity: 1 },
                title: '取消',
                onClick: function (ev) {
                  ev.stopPropagation();
                  setPend(null);
                  setName('');
                },
              },
              '✕',
            ),
            React.createElement(
              'span',
              { className: 'fge-ophint' },
              pend.kind === 'create' ? 'Enter 确认 · Esc 取消' : 'Enter 重命名 · Esc 取消',
            ),
            pend.err ? React.createElement('span', { className: 'fge-operr' }, pend.err) : null,
          );
        };

        var rootLoaded = cache[''] !== undefined;
        var rootPending = !!pend && pend.kind === 'create' && pend.rel === '';
        // 逐行装配: 行间按需插入待输入行(根级在最前, 目录/条目在其行后)
        var rowEls = [];
        if (rootPending) rowEls.push(opRowElFor(0, 'root'));
        for (var ri = 0; ri < rows.length; ri++) {
          var r = rows[ri];
          rowEls.push(nodeElFor(r));
          if (pend && pend.rel === r.rel) {
            if (pend.kind === 'create') rowEls.push(opRowElFor(r.depth + 1, 'create:' + r.rel));
            else if (pend.row && pend.row.rel === r.rel)
              rowEls.push(opRowElFor(r.depth, 'rename:' + r.rel));
          }
        }

        var children = React.createElement(
          'div',
          { className: 'fge-tree', ref: bodyRef },
          rowEls,
          loading !== null && !rootPending
            ? React.createElement('div', { className: 'fge-loading', key: 'loading' }, '加载中…')
            : null,
          rootLoaded && rows.length === 0 && !rootPending
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
          React.createElement('path', { d: d[0] }),
          React.createElement('path', { d: d[1] }),
        );
      }

      // ---- 关闭/停止图标(✕) ----
      function CloseIcon() {
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
          React.createElement('path', { d: 'M18 6L6 18M6 6l12 12' }),
        );
      }

      // ---- 对号图标(✓, shell 行执行) ----
      // ---- shell 行动作图标: ▶ 执行 / ■ 停止 ----
      function PlayIcon() {
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
          React.createElement('polygon', { points: '5 3 19 12 5 21 5 3' }),
        );
      }
      function StopIcon() {
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
          React.createElement('rect', { x: '4', y: '4', width: '16', height: '16', rx: '2' }),
        );
      }

      // ---- git 分支图标(竖着, 两根分支线) ----
      function BranchIcon() {
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
          {
            width: 12,
            height: 12,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            style: { display: 'block' },
          },
          React.createElement('path', { d: props.open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6' }),
        );
      }

      // ---- 放大镜(文件搜索入口) ----
      function SearchIcon() {
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
          React.createElement('circle', { cx: 11, cy: 11, r: 7 }),
          React.createElement('line', { x1: 16.5, y1: 16.5, x2: 21, y2: 21 }),
        );
      }

      // ---- 时钟回溯(提交历史入口) ----
      function HistoryIcon() {
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
          React.createElement('path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
          React.createElement('path', { d: 'M3 3v5h5' }),
          React.createElement('path', { d: 'M12 7v5l4 2' }),
        );
      }

      // ---- 搜索结果列表(平铺, 带分区徽标) ----
      // props: res {matches, truncated}, onPick(match)
      var ZONE_MARK = { visible: '显', hidden: '隐', ignored: '忽' };
      function SearchResults(props) {
        var matches = props.res && Array.isArray(props.res.matches) ? props.res.matches : [];
        return React.createElement(
          'div',
          { className: 'fge-tree' },
          matches.length === 0
            ? React.createElement('div', { className: 'fge-empty' }, '(无匹配)')
            : matches.map(function (m) {
                var name = m.rel.slice(m.rel.lastIndexOf('/') + 1);
                var dir = m.rel.slice(0, m.rel.length - name.length);
                return React.createElement(
                  'div',
                  {
                    key: m.type + ':' + m.rel,
                    className: 'fge-result',
                    onClick: function () {
                      props.onPick(m);
                    },
                    title: m.rel,
                  },
                  React.createElement(
                    'span',
                    { className: 'fge-badge fge-badge-' + m.zone.charAt(0), title: '所在分区' },
                    ZONE_MARK[m.zone] || '·',
                  ),
                  React.createElement('span', { className: 'fge-result-name' }, name),
                  dir !== ''
                    ? React.createElement('span', { className: 'fge-result-dir' }, dir)
                    : null,
                );
              }),
          props.res && props.res.truncated
            ? React.createElement(
                'div',
                { className: 'fge-empty' },
                '结果过多, 已截断(请缩短关键词)',
              )
            : null,
        );
      }

      // ---- shell 行(shell bar): 左树底部命令执行行 ----
      // 单槽(宿主侧记账): ✓ 启动即挂 ctx.jobs(kind 'shell', 无主, 完成不通知模型);
      // 运行中每秒拉一次尾部输出增量; GUI 刷新后经 shellState 认领仍在跑的任务。
      var SHELL_POLL_MS = 1000;
      var SHELL_TAIL_CHARS = 16 * 1024; // 客户端显示缓冲上限(与 host 每流缓冲同量级)
      var SHELL_HISTORY_MAX = 100;

      // 历史(相邻去重 + 上限截断)与 lib/shell.js 的 pushHistory 同算法 —— client
      // bundle 无法 import host ESM, 两处必须同步改; 可执行规约见 tests/shell.test.mjs。
      function pushHist(list, cmd) {
        if (list.length > 0 && list[list.length - 1] === cmd) return list;
        var next = list.concat([cmd]);
        return next.length > SHELL_HISTORY_MAX ? next.slice(next.length - SHELL_HISTORY_MAX) : next;
      }

      function ShellBar(props) {
        var cacheKey = props.cacheKey;
        var valueState = React.useState('');
        var value = valueState[0];
        var setValue = valueState[1];
        var jobState = React.useState(null); // {id,label,status,exitCode,signal,error}
        var job = jobState[0];
        var setJob = jobState[1];
        var startingState = React.useState(false); // shellStart 请求在途(○ 启动中)
        var starting = startingState[0];
        var setStarting = startingState[1];
        var openState = React.useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        var outTextState = React.useState('');
        var outText = outTextState[0];
        var setOutText = outTextState[1];
        var errTextState = React.useState('');
        var errText = errTextState[0];
        var setErrText = errTextState[1];
        var inputRef = React.useRef(null);
        var preRef = React.useRef(null);
        var histRef = React.useRef([]);
        var histIdxRef = React.useRef(null); // null = 实时输入
        var draftRef = React.useRef(''); // 离开实时输入时的草稿
        var fromRef = React.useRef({ out: 0, err: 0 }); // 已读到的绝对字符位
        var jobBusy = !!job && (job.status === 'running' || job.status === 'stopping');
        var busy = starting || jobBusy;

        // 历史随仓库根懒加载(cwd 缓存搭车: shellHistory 字段)
        React.useEffect(
          function () {
            var cached = cacheKey ? readCache(cacheKey) : null;
            histRef.current =
              cached && Array.isArray(cached.shellHistory)
                ? cached.shellHistory.filter(function (x) {
                    return typeof x === 'string';
                  })
                : [];
            histIdxRef.current = null;
          },
          [cacheKey],
        );

        // 挂载/切工作区时认领该工作区自己的槽任务(刷新恢复 running 态与 ✕ 可用性;
        // 槽按 root 隔离 —— 切走即重置展示态, 不显示上一个工作区的记录)
        React.useEffect(
          function () {
            var dead = false;
            setJob(null);
            setStarting(false);
            setOutText('');
            setErrText('');
            fromRef.current = { out: 0, err: 0 };
            api('shellState', { root: props.root })
              .then(function (r) {
                if (dead || !r || !r.ok || !r.job) return;
                setJob(r.job);
                // 输出窗常驻一行显示, 认领任务不自动展开
                // 认领已终结的任务时轮询不会跑, 单次拉尾部输出填充
                if (r.job.status !== 'running' && r.job.status !== 'stopping') {
                  // 终态任务: 把命令文本放回输入框(与「执行后命令保留不清空」一致),
                  // 让状态行有命令上下文, 不出现「空输入框 + 退出状态」的割裂观感
                  if (typeof r.job.label === 'string' && r.job.label !== '') {
                    setValue(r.job.label);
                  }
                  api('shellOutput', { root: props.root, outFrom: 0, errFrom: 0 })
                    .then(function (o) {
                      if (dead || !o || !o.ok) return;
                      setOutText(
                        o.out && o.out.text !== ''
                          ? (o.out.lossy ? '[…输出有缺口…]\n' : '') + o.out.text
                          : '',
                      );
                      setErrText(
                        o.err && o.err.text !== ''
                          ? (o.err.lossy ? '[…输出有缺口…]\n' : '') + o.err.text
                          : '',
                      );
                    })
                    .catch(function () {});
                }
              })
              .catch(function () {});
            return function () {
              dead = true;
            };
          },
          [props.root],
        );

        // 运行中轮询本工作区槽的尾部输出; done=true 的那一拍带最终状态与残余输出
        React.useEffect(
          function () {
            if (!busy) return undefined;
            var dead = false;
            var root = props.root; // 轮询锁定发起时的工作区, 切换即被 cleanup 作废
            var applySeg = function (which, seg, setText) {
              if (!seg) return;
              var add = seg.lossy ? '[…输出有缺口…]\n' : '';
              if (seg.text !== '') {
                setText(function (prev) {
                  var nextText = prev + add + seg.text;
                  return nextText.length > SHELL_TAIL_CHARS * 2
                    ? nextText.slice(-SHELL_TAIL_CHARS * 2)
                    : nextText;
                });
              }
              fromRef.current[which] = seg.next;
            };
            var tick = function () {
              api('shellOutput', {
                root: root,
                outFrom: fromRef.current.out,
                errFrom: fromRef.current.err,
              })
                .then(function (r) {
                  if (dead || !r || !r.ok || !r.job) return;
                  setJob(r.job);
                  applySeg('out', r.out, setOutText);
                  applySeg('err', r.err, setErrText);
                })
                .catch(function () {});
            };
            tick();
            var t = setInterval(tick, SHELL_POLL_MS);
            return function () {
              dead = true;
              clearInterval(t);
            };
          },
          [busy, props.root],
        );

        // 内容变化 / 展开时滚到底部
        React.useEffect(
          function () {
            var el = preRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          },
          [outText, errText, open],
        );

        var exec = function () {
          var cmd = value.trim();
          if (cmd === '' || busy) return;
          // 执行即离开输入框: 配合下方只读锁, 运行中光标不再停留在输入框内
          if (inputRef.current) inputRef.current.blur();
          setStarting(true); // ○ 启动中(请求在途)
          api('shellStart', { root: props.root, command: cmd })
            .then(function (r) {
              setStarting(false);
              if (!r || !r.ok) {
                // 启动失败信息进输出窗(状态符号保持 ■, 有效信息在窗口里)
                var reason = r && r.error;
                var txt =
                  reason === 'busy'
                    ? '已有任务在运行'
                    : reason === 'jobs-unavailable'
                      ? '后台任务服务不可用'
                      : reason === 'subprocess-unavailable'
                        ? '子进程服务不可用'
                        : reason === 'invalid-command'
                          ? '命令无效'
                          : reason === 'spawn-failed'
                            ? '进程启动失败' + (r && r.detail ? '(' + r.detail + ')' : '')
                            : '启动失败';
                setOutText('⚠ 启动失败：' + txt);
                setErrText('');
                return;
              }
              histRef.current = pushHist(histRef.current, cmd);
              histIdxRef.current = null;
              draftRef.current = '';
              if (cacheKey) writeCache(cacheKey, { shellHistory: histRef.current });
              fromRef.current = { out: 0, err: 0 };
              setOutText('');
              setErrText('');
              setJob(r.job);
            })
            .catch(function () {
              setStarting(false);
              setOutText('⚠ 启动失败：网络错误');
              setErrText('');
            });
        };

        var stop = function () {
          if (!jobBusy) return; // 只停真实在跑的任务(启动中无任务可停)
          api('shellStop', { root: props.root })
            .then(function (r) {
              if (r && r.ok && r.job) setJob(r.job);
            })
            .catch(function () {});
        };

        // ↑/↓ 历史导航: 离开实时输入时记草稿, 走到底再 ↓ 回到草稿
        var navHistory = function (dir) {
          var h = histRef.current;
          if (!h || h.length === 0) return;
          var idx = histIdxRef.current;
          if (dir === 'up') {
            if (idx === null) {
              draftRef.current = value;
              idx = h.length - 1;
            } else if (idx > 0) {
              idx -= 1;
            } else return;
          } else {
            if (idx === null) return;
            idx += 1;
            if (idx >= h.length) {
              histIdxRef.current = null;
              setValue(draftRef.current);
              return;
            }
          }
          histIdxRef.current = idx;
          setValue(h[idx]);
        };

        // 运行状态点: 绿色=运行中/启动中, 红色=已停止。渲染在输入框右缘;
        // 仅在有意义时显示 —— 空闲(无 job)或输入框为空时不显示任何点。
        var runActive = starting || jobBusy;
        var showDot = runActive || (!!job && value.trim() !== '');

        var tailText =
          outText + (errText !== '' ? (outText !== '' ? '\n' : '') + '[stderr]\n' + errText : '');

        return React.createElement(
          React.Fragment,
          null,
          // 输出窗常驻显示, 默认一行高(自动滚底显示最新一行), 箭头展开完整
          React.createElement(
            'pre',
            {
              className: 'fge-shell-tail' + (open ? ' fge-shell-tail-open' : ''),
              ref: preRef,
            },
            tailText !== '' ? tailText : '(尚无输出)',
          ),
          React.createElement(
            'div',
            { className: 'fge-shell-row' },
            // 行首小箭头: 一行 ↔ 完整显示输出窗(执行按钮不再控制显示)
            React.createElement(
              'button',
              {
                className: 'fge-btn' + (open ? ' fge-btn-active' : ''),
                title: open ? '收起输出为一行' : '展开完整输出',
                onClick: function () {
                  setOpen(!open);
                },
              },
              React.createElement(CaretIcon, { open: open }),
            ),
            React.createElement(
              'div',
              { className: 'fge-shell-inputwrap' },
              React.createElement('input', {
                ref: inputRef,
                className: 'fge-shell-input' + (busy ? ' fge-shell-locked' : ''),
                value: value,
                placeholder: 'shell 命令(⏎ 执行)',
                spellCheck: false,
                readOnly: busy,
                onChange: function (e) {
                  if (busy) return; // 运行中只读, 防御性兜底
                  setValue(e.target.value);
                  histIdxRef.current = null;
                  // 修改命令 = 作废上一任务: 状态点回到红色(默认), 输出窗回到一行
                  // (输出内容保留可查, 行首箭头可再展开)
                  setJob(null);
                  setOpen(false);
                },
                onKeyDown: function (e) {
                  if (busy) {
                    // 运行中锁定输入: 不响应 Enter/↑/↓ 等按键, 仅允许 Esc 失焦
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      if (inputRef.current) inputRef.current.blur();
                    } else {
                      e.preventDefault();
                      e.stopPropagation();
                    }
                    return;
                  }
                  if (e.key === 'Enter') {
                    // IME 组合期不触发; preventDefault+stopPropagation 隔离应用层按键链
                    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                    e.preventDefault();
                    e.stopPropagation();
                    exec();
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    e.stopPropagation();
                    navHistory('up');
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    e.stopPropagation();
                    navHistory('down');
                  } else if (e.key === 'Escape') {
                    // 只失焦: 不波及插件的常驻 window Esc 监听(会关悬浮窗)
                    e.stopPropagation();
                    if (inputRef.current) inputRef.current.blur();
                  }
                },
              }),
              // 运行状态点: 输入框右缘内部, pointer-events 穿透不挡输入; 空闲/空输入不渲染
              showDot
                ? React.createElement('span', {
                    className: 'fge-shell-dot' + (runActive ? ' fge-shell-dot-run' : ''),
                  })
                : null,
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn',
                title: busy ? '已有任务在运行' : '执行',
                disabled: busy || value.trim() === '',
                onClick: exec,
              },
              React.createElement(PlayIcon, null),
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn',
                title: '停止当前任务',
                disabled: !jobBusy,
                onClick: stop,
              },
              React.createElement(StopIcon, null),
            ),
          ),
        );
      }

      // ---- 左侧文件树面板 ----
      function LeftPanel(props) {
        var copiedState = React.useState(false);
        var copied = copiedState[0];
        var setCopied = copiedState[1];
        // 延迟收起: 由 FgeRoot 下发的保持区追踪器驱动(lp 区), 见 makeSideTracker
        var track = props.track;
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

        // ---- 文件搜索(name search): 输入防抖 150ms → host /search, 结果替换三区树 ----
        var searchOpenState = React.useState(false);
        var searchOpen = searchOpenState[0];
        var setSearchOpen = searchOpenState[1];
        var draftState = React.useState('');
        var draft = draftState[0];
        var setDraft = draftState[1];
        var queryState = React.useState(''); // 已提交(防抖后)的查询
        var query = queryState[0];
        var setQuery = queryState[1];
        var resState = React.useState(null); // {matches, truncated} | null
        var res = resState[0];
        var setRes = resState[1];
        var revealReqState = React.useState(null); // {rel, zone, tick}
        var revealReq = revealReqState[0];
        var setRevealReq = revealReqState[1];
        var seqRef = React.useRef(0); // 竞态守卫: 只接受最后一次请求的结果

        var closeSearch = React.useCallback(function () {
          setSearchOpen(false);
          setDraft('');
          setQuery('');
          setRes(null);
        }, []);

        // ---- 树内写操作(新建/重命名/删除的 client 编排) ----
        // 成功 → 局部重载(reloadReq 只重拉目标目录缓存, 不动展开/选中态) +
        // 广播事件(onTreeEvent: 改/删联动已打开的悬浮面板) + 状态刷新(onMutate)。
        var opSeqRef = React.useRef(0);
        var reloadReqState = React.useState(null); // {seq, rel}
        var reloadReq = reloadReqState[0];
        var setReloadReq = reloadReqState[1];
        var rootCreateSeqRef = React.useRef(0);
        var rootCreateState = React.useState(null); // {seq, zone}
        var rootCreateReq = rootCreateState[0];
        var setRootCreateReq = rootCreateState[1];

        var dirOf = function (rel) {
          var i = rel.lastIndexOf('/');
          return i < 0 ? '' : rel.slice(0, i);
        };
        var fireReload = function (parentRel) {
          opSeqRef.current += 1;
          setReloadReq({ seq: opSeqRef.current, rel: parentRel });
        };
        var notifyMutated = function () {
          if (typeof props.onMutate === 'function') props.onMutate();
        };
        var notifyEvent = function (evt) {
          if (typeof props.onTreeEvent === 'function') props.onTreeEvent(evt);
        };

        // ---- 删除确认 / 失败提示: DSH 风格模态(替代原生 window.confirm / alert) ----
        // confirmReq: null | {mode:'confirm', row} | {mode:'notice', title, message}
        var confirmReqState = React.useState(null);
        var confirmReq = confirmReqState[0];
        var setConfirmReq = confirmReqState[1];
        var confirmResolveRef = React.useRef(null); // 确认按钮的回调(取消/关闭 = false)
        var askConfirm = function (row) {
          return new Promise(function (resolve) {
            confirmResolveRef.current = resolve;
            setConfirmReq({ mode: 'confirm', row: row });
          });
        };
        var settleConfirm = function (ok) {
          if (confirmResolveRef.current) {
            confirmResolveRef.current(ok);
            confirmResolveRef.current = null;
          }
          setConfirmReq(null);
        };
        var showNotice = function (title, message) {
          confirmResolveRef.current = null;
          setConfirmReq({ mode: 'notice', title: title, message: message });
        };
        // 删除失败码 → 可读文案
        var removeErrText = function (code) {
          if (code === 'not-found') return '目标不存在（可能已被删除）';
          if (code === 'not-empty') return '目录非空，无法删除';
          if (code === 'invalid-path' || code === 'invalid-root') return '路径不合法';
          if (code === 'rpc-failed') return '请求失败，请重试';
          return code || '未知错误';
        };
        // 模态打开期间 Esc = 取消: document 捕获期拦截, 阻断全局 Esc(关悬浮面板)连锁
        React.useEffect(
          function () {
            if (!confirmReq) return undefined;
            function onKey(e) {
              if (e.key === 'Escape') {
                e.stopPropagation();
                settleConfirm(false);
              }
            }
            document.addEventListener('keydown', onKey, true);
            return function () {
              document.removeEventListener('keydown', onKey, true);
            };
          },
          [confirmReq],
        );

        var ops = {
          create: function (parentRel, cleanName, kind) {
            var relPath = parentRel === '' ? cleanName : parentRel + '/' + cleanName;
            return api('create', { root: props.root, path: relPath, kind: kind })
              .then(function (res) {
                if (res && res.ok) {
                  fireReload(parentRel);
                  notifyMutated();
                  if (kind === 'file') return { ok: true, openRel: relPath, openName: cleanName };
                  return { ok: true };
                }
                return res || { ok: false, error: 'failed' };
              })
              .catch(function () {
                return { ok: false, error: 'rpc-failed' };
              });
          },
          rename: function (row, newName) {
            return api('rename', { root: props.root, path: row.rel, newName: newName })
              .then(function (res) {
                if (res && res.ok) {
                  fireReload(dirOf(row.rel));
                  var to = dirOf(row.rel) === '' ? newName : dirOf(row.rel) + '/' + newName;
                  notifyEvent({ type: 'renamed', from: row.rel, to: to });
                  notifyMutated();
                }
                return res || { ok: false, error: 'failed' };
              })
              .catch(function () {
                return { ok: false, error: 'rpc-failed' };
              });
          },
          remove: function (row) {
            // DSH 风格模态确认(替代原生 confirm), 目录删除需显式确认
            return askConfirm(row).then(function (ok) {
              if (!ok) return { ok: false, error: 'cancelled' };
              return api('remove', {
                root: props.root,
                path: row.rel,
                recursive: row.type === 'dir',
              })
                .then(function (res) {
                  if (res && res.ok) {
                    fireReload(dirOf(row.rel));
                    notifyEvent({ type: 'deleted', rel: row.rel });
                    notifyMutated();
                  } else if (res && res.error !== 'cancelled') {
                    showNotice('删除失败', removeErrText(res.error));
                  }
                  return res || { ok: false, error: 'failed' };
                })
                .catch(function () {
                  showNotice('删除失败', '请求错误');
                  return { ok: false, error: 'rpc-failed' };
                });
            });
          },
        };
        /** 分区头"+" → 该分区根的新建待输入行 */
        var rootCreate = function (zone) {
          rootCreateSeqRef.current += 1;
          setRootCreateReq({ seq: rootCreateSeqRef.current, zone: zone });
        };

        // 根切换: 关闭搜索与定位态(树本身也会随 root 作废)
        React.useEffect(
          function () {
            closeSearch();
            setRevealReq(null);
          },
          [props.root, closeSearch],
        );

        // 搜索开启时全局 Esc 关闭(焦点不在输入框时——如刚点过结果——也能恢复树;
        // 输入框内的 Esc 由 onKeyDown stopPropagation 处理, 只关搜索不波及悬浮面板)
        React.useEffect(
          function () {
            if (!searchOpen) return undefined;
            function onKey(e) {
              if (e.key === 'Escape') closeSearch();
            }
            window.addEventListener('keydown', onKey);
            return function () {
              window.removeEventListener('keydown', onKey);
            };
          },
          [searchOpen, closeSearch],
        );

        React.useEffect(
          function () {
            if (!searchOpen) return undefined;
            var t = setTimeout(function () {
              var q = draft;
              setQuery(q);
              if (q.trim() === '') {
                setRes(null);
                return;
              }
              var mySeq = ++seqRef.current;
              api('search', { root: props.root, query: q })
                .then(function (r) {
                  if (seqRef.current !== mySeq) return;
                  setRes(r && r.ok ? r : { matches: [], truncated: false });
                })
                .catch(function () {
                  if (seqRef.current === mySeq) setRes({ matches: [], truncated: false });
                });
            }, 150);
            return function () {
              clearTimeout(t);
            };
          },
          [draft, searchOpen, props.root],
        );

        var searching = searchOpen && query.trim() !== '';
        // 目录命中 → 对应分区树内 reveal 并关闭搜索; 文件命中 → 打开内容悬浮面板。
        var onPickResult = function (m) {
          if (m.type === 'dir') {
            setRevealReq({ rel: m.rel, zone: m.zone, tick: Date.now() });
            closeSearch();
            return;
          }
          props.onFileClick(m.rel, m.rel.slice(m.rel.lastIndexOf('/') + 1), m.type);
        };
        // zone → 目标分区: 首段为 dot 走隐藏区, 忽略命中走忽略区, 其余走可见区。
        // (混合链如 src/.env 在可见区逐级走到最深可见祖先为止。)
        var revealModeFor = function (zone, rel) {
          if (zone === 'ignored') return 'ignored';
          var firstSeg = String(rel).split('/')[0];
          if (firstSeg.charAt(0) === '.') return 'hidden';
          return 'visible';
        };

        return React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'div',
            {
              className: 'fge-panel',
              'data-fge-root': '1',
              style: props.style,
              onMouseEnter: function () {
                track.enter('lp');
              },
              onMouseLeave: function () {
                track.leave('lp');
              },
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
                className: 'fge-btn' + (searchOpen ? ' fge-btn-active' : ''),
                title: searchOpen ? '关闭搜索' : '搜索文件(名称或路径)',
                onClick: function () {
                  if (searchOpen) closeSearch();
                  else setSearchOpen(true);
                },
              },
              React.createElement(SearchIcon, null),
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn' + (props.pin ? ' fge-btn-active' : ''),
                title: props.pinDisabled
                  ? '非对话视图下暂不可操作图钉'
                  : props.pin
                    ? '已固定: 点击解除固定'
                    : '图钉: 固定后两个面板都不能收起',
                onClick: props.onPin,
                disabled: !!props.pinDisabled,
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
          searchOpen
            ? React.createElement(
                'div',
                { className: 'fge-search-row' },
                React.createElement('input', {
                  className: 'fge-search-input',
                  value: draft,
                  autoFocus: true,
                  placeholder: '搜索文件名或路径…',
                  onChange: function (e) {
                    setDraft(e.target.value);
                  },
                  onKeyDown: function (e) {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      closeSearch();
                    }
                  },
                }),
              )
            : null,
          searching && res !== null
            ? React.createElement(
                'div',
                { className: 'fge-section', style: { flex: '1' } },
                React.createElement(
                  'div',
                  { className: 'fge-section-head' },
                  '搜索 "' + query.trim() + '"',
                ),
                React.createElement(
                  'div',
                  { className: 'fge-section-body' },
                  React.createElement(SearchResults, { res: res, onPick: onPickResult }),
                ),
              )
            : React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  'div',
                  { className: 'fge-section', style: { flex: '3' } },
                  React.createElement(
                    'div',
                    { className: 'fge-section-head' },
                    React.createElement('span', null, '可显示文件'),
                    React.createElement('span', { className: 'fge-section-head-sp' }),
                    React.createElement(
                      'button',
                      {
                        className: 'fge-headplus',
                        title: '在此分区根新建（名称以 / 结尾建目录，可用 a/b 嵌套）',
                        onClick: function () {
                          rootCreate('visible');
                        },
                      },
                      '+',
                    ),
                  ),
                  React.createElement(
                    'div',
                    { className: 'fge-section-body' },
                    React.createElement(LazyTree, {
                      mode: 'visible',
                      root: props.root,
                      refreshTick: props.refreshTick,
                      onFileClick: props.onFileClick,
                      ops: ops,
                      reloadReq: reloadReq,
                      rootCreateReq:
                        rootCreateReq && rootCreateReq.zone === 'visible' ? rootCreateReq : null,
                      revealReq:
                        revealReq && revealModeFor(revealReq.zone, revealReq.rel) === 'visible'
                          ? revealReq
                          : null,
                    }),
                  ),
                ),
                React.createElement(
                  'div',
                  { className: 'fge-section', style: { flex: '1' } },
                  React.createElement(
                    'div',
                    { className: 'fge-section-head' },
                    React.createElement('span', null, '隐藏文件'),
                    React.createElement('span', { className: 'fge-section-head-sp' }),
                    React.createElement(
                      'button',
                      {
                        className: 'fge-headplus',
                        title: '在此分区根新建（如 .env.local）',
                        onClick: function () {
                          rootCreate('hidden');
                        },
                      },
                      '+',
                    ),
                  ),
                  React.createElement(
                    'div',
                    { className: 'fge-section-body' },
                    React.createElement(LazyTree, {
                      mode: 'hidden',
                      root: props.root,
                      refreshTick: props.refreshTick,
                      onFileClick: props.onFileClick,
                      ops: ops,
                      reloadReq: reloadReq,
                      rootCreateReq:
                        rootCreateReq && rootCreateReq.zone === 'hidden' ? rootCreateReq : null,
                      revealReq:
                        revealReq && revealModeFor(revealReq.zone, revealReq.rel) === 'hidden'
                          ? revealReq
                          : null,
                    }),
                  ),
                ),
                React.createElement(
                  'div',
                  { className: 'fge-section', style: { flex: '1' } },
                  React.createElement(
                    'div',
                    { className: 'fge-section-head' },
                    React.createElement('span', null, '忽略文件'),
                    React.createElement('span', { className: 'fge-section-head-sp' }),
                    React.createElement(
                      'button',
                      {
                        className: 'fge-headplus',
                        title: '在此分区根新建（通常直接建在可见区即可）',
                        onClick: function () {
                          rootCreate('ignored');
                        },
                      },
                      '+',
                    ),
                  ),
                  React.createElement(
                    'div',
                    { className: 'fge-section-body' },
                    React.createElement(LazyTree, {
                      mode: 'ignored',
                      root: props.root,
                      refreshTick: props.refreshTick,
                      onFileClick: props.onFileClick,
                      ops: ops,
                      reloadReq: reloadReq,
                      rootCreateReq:
                        rootCreateReq && rootCreateReq.zone === 'ignored' ? rootCreateReq : null,
                      revealReq:
                        revealReq && revealModeFor(revealReq.zone, revealReq.rel) === 'ignored'
                          ? revealReq
                          : null,
                    }),
                  ),
                ),
              ),
            React.createElement(ShellBar, { root: props.root, cacheKey: props.cacheKey }),
            React.createElement('div', {
              className: 'fge-resize fge-resize-left',
              onPointerDown: props.onResizeStart,
            }),
          ),
          confirmReq
            ? React.createElement(
                'div',
                {
                  className: 'fge-mask',
                  'data-fge-root': '1',
                  onMouseEnter: function () {
                    track.enter('lp');
                  },
                  onMouseLeave: function () {
                    track.leave('lp');
                  },
                  onClick: function (e) {
                    if (e.target === e.currentTarget) settleConfirm(false); // 点遮罩 = 取消
                  },
                },
                React.createElement(
                  'div',
                  { className: 'fge-mbox' },
                  React.createElement(
                    'div',
                    { className: 'fge-mtitle' },
                    confirmReq.mode === 'notice' ? confirmReq.title : '删除确认',
                  ),
                  React.createElement(
                    'div',
                    { className: 'fge-mbody' },
                    confirmReq.mode === 'notice'
                      ? confirmReq.message
                      : confirmReq.row.type === 'dir'
                        ? '删除目录 “' + confirmReq.row.name + '” 及其全部内容？此操作不可恢复。'
                        : '删除文件 “' + confirmReq.row.name + '”？此操作不可恢复。',
                  ),
                  React.createElement(
                    'div',
                    { className: 'fge-mfoot' },
                    confirmReq.mode === 'notice'
                      ? null
                      : React.createElement(
                          'button',
                          {
                            className: 'fge-mbtn fge-mbtn-ghost',
                            onClick: function () {
                              settleConfirm(false);
                            },
                          },
                          '取消',
                        ),
                    React.createElement(
                      'button',
                      {
                        className:
                          'fge-mbtn ' +
                          (confirmReq.mode === 'notice' ? 'fge-mbtn-brand' : 'fge-mbtn-danger'),
                        autoFocus: confirmReq.mode === 'notice',
                        onClick: function () {
                          settleConfirm(confirmReq.mode !== 'notice');
                        },
                      },
                      confirmReq.mode === 'notice' ? '知道了' : '删除',
                    ),
                  ),
                ),
              )
            : null,
        );
      }

      // ---- 右侧 git 树面板 ----
      function RightPanel(props) {
        var menuState = React.useState(false);
        var menuOpen = menuState[0];
        var setMenuOpen = menuState[1];
        var listRef = React.useRef(null);
        var branchRef = React.useRef(null);
        var menuRef = React.useRef(null);
        // 与右侧悬浮栏(diff/历史)互斥: 两者都出现在面板左侧同一留白带,
        // 同时打开会互相遮挡 —— 悬浮栏在打开时收起本下拉(反向经 onOpenMenu 关闭悬浮栏)。
        React.useEffect(
          function () {
            if (props.floatOpen) setMenuOpen(false);
          },
          [props.floatOpen],
        );
        // 点下拉外任意位置即收起: 单击列表外(面板内其他区域 / 页面其他处)关闭分支列表,
        // 不再要求必须再点一次分支名。分支按钮本身除外 —— 它自己的 onClick 负责切换;
        // 捕获期 document 监听先于按钮合成点击执行, 无竞争。
        React.useEffect(
          function () {
            if (!menuOpen) return;
            function onDocDown(e) {
              var t = e.target;
              if (menuRef.current && menuRef.current.contains(t)) return;
              if (branchRef.current && branchRef.current.contains(t)) return;
              setMenuOpen(false);
            }
            document.addEventListener('mousedown', onDocDown, true);
            return function () {
              document.removeEventListener('mousedown', onDocDown, true);
            };
          },
          [menuOpen],
        );
        // 延迟收起: 由 FgeRoot 下发的保持区追踪器驱动(rp 区), 见 makeSideTracker
        var track = props.track;

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

        // 分支下拉仅作信息展示(点开只看列表): 行不响应点击, 也不改写「查看分支」;
        // 查看分支的切换入口只有历史面板头部的分支按钮。
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
                var mark = isCurrent ? '当前' : isViewed ? '查看中' : '';
                // 纯展示行: 不注册点击(查看分支的唯一切换入口在历史面板头部按钮)。
                return React.createElement(
                  'div',
                  {
                    key: br.ref,
                    className:
                      'fge-branch-item fge-branch-static' +
                      (isCurrent ? ' fge-branch-current' : '') +
                      (isViewed ? ' fge-branch-viewed' : ''),
                    title: isCurrent
                      ? br.name + ' · 当前分支(只读)'
                      : br.name + ' · 只读展示, 不做分支切换',
                  },
                  React.createElement('span', null, br.name),
                  React.createElement('span', { className: 'fge-branch-mark' }, mark),
                );
              }),
            );
          };
          menu = React.createElement(
            'div',
            { className: 'fge-branch-menu', ref: menuRef },
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
            onMouseEnter: function () {
              track.enter('rp');
            },
            onMouseLeave: function () {
              track.leave('rp');
            },
          },
          React.createElement(
            'div',
            {
              className: 'fge-branch',
              ref: branchRef,
              onClick: function () {
                var next = !menuOpen;
                setMenuOpen(next);
                // 展开下拉的同时关闭 diff/历史悬浮栏(互斥, 防遮挡)
                if (next && props.onOpenMenu) props.onOpenMenu();
              },
              title: '点击显示所有分支(只读)',
            },
            React.createElement(BranchIcon, null),
            React.createElement('span', { className: 'fge-branch-name' }, current || '(detached)'),
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
                className: 'fge-btn' + (props.historyOpen ? ' fge-btn-active' : ''),
                title: '提交历史(跟随查看分支)',
                onClick: props.onToggleHistory,
                disabled: !props.hasRepo,
              },
              React.createElement(HistoryIcon, null),
            ),
            React.createElement(
              'button',
              {
                className: 'fge-btn' + (props.pin ? ' fge-btn-active' : ''),
                title: props.pinDisabled
                  ? '非对话视图下暂不可操作图钉'
                  : props.pin
                    ? '已固定: 点击解除固定'
                    : '图钉: 固定后两个面板都不能收起',
                onClick: props.onPin,
                disabled: !!props.pinDisabled,
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
        // 延迟收起(悬浮栏): 由 FgeRoot 下发的保持区追踪器驱动(region 由调用方指定)
        var track = props.track;
        var region = props.region || 'fl';
        return React.createElement(
          'div',
          {
            className: 'fge-float',
            'data-fge-root': '1',
            style: props.style,
            onMouseEnter: function () {
              track.enter(region);
            },
            onMouseLeave: function () {
              track.leave(region);
            },
          },
          React.createElement(
            'div',
            { className: 'fge-float-head' },
            props.headExtra === undefined ? null : props.headExtra,
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
            props.afterTitle === undefined ? null : props.afterTitle,
            React.createElement(
              'button',
              { className: 'fge-btn', onClick: props.onClose, title: props.onCloseTitle || '关闭' },
              React.createElement(CloseIcon, null),
            ),
          ),
          React.createElement(
            'div',
            Object.assign({ className: 'fge-float-body' }, props.bodyProps || {}),
            props.children,
          ),
        );
      }

      // ---- 内容悬浮面板(左树文件 → 向右浮出, 可越对话区) ----
      // 纯 textarea 编辑态: ⌘S/Ctrl+S 保存, Esc 退出编辑; mtimeMs 乐观并发 ——
      // host 报 conflict 时提示"重新加载磁盘版 / 强制覆盖"。二进制与超限文件保持只读。
      var MAX_EDIT_CHARS = 1024 * 1024;
      function ContentPanel(props) {
        var dataState = React.useState(null);
        var data = dataState[0];
        var setData = dataState[1];
        var errState = React.useState(null);
        var err = errState[0];
        var setErr = errState[1];
        var editingState = React.useState(false);
        var editing = editingState[0];
        var setEditing = editingState[1];
        var draftState = React.useState('');
        var draft = draftState[0];
        var setDraft = draftState[1];
        var savingState = React.useState(false);
        var saving = savingState[0];
        var setSaving = savingState[1];
        var saveErrState = React.useState(null); // {conflict?:true, msg}
        var saveErr = saveErrState[0];
        var setSaveErr = saveErrState[1];
        var savedFlashState = React.useState(false);
        var savedFlash = savedFlashState[0];
        var setSavedFlash = savedFlashState[1];
        var reloadSeqRef = React.useRef(0); // 冲突后手动重载递增
        var reloadSeqReload = React.useState(0);
        var reloadSeq = reloadSeqReload[0];
        var setReloadSeq = reloadSeqReload[1];
        var flashTimerRef = React.useRef(null);

        var canEdit = !!data && !data.binary && !data.truncated && typeof data.text === 'string';
        var dirty = editing && canEdit && draft !== data.text;

        // 卸载/换文件时清保存闪现定时器
        React.useEffect(
          function () {
            return function () {
              if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
            };
          },
          [props.root, props.rel],
        );

        React.useEffect(
          function () {
            var alive = true;
            setData(null);
            setErr(null);
            setSaveErr(null);
            setSavedFlash(false);
            api('file', { root: props.root, path: props.rel })
              .then(function (res) {
                if (!alive) return;
                if (res && res.ok) {
                  setData(res);
                  setDraft(typeof res.text === 'string' ? res.text : '');
                  setEditing(false);
                } else setErr((res && res.error) || 'failed');
              })
              .catch(function () {
                if (alive) setErr('rpc-failed');
              });
            return function () {
              alive = false;
            };
          },
          [props.root, props.rel, reloadSeq],
        );

        var flashSaved = function () {
          setSavedFlash(true);
          if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
          flashTimerRef.current = setTimeout(function () {
            flashTimerRef.current = null;
            setSavedFlash(false);
          }, 1400);
        };

        var performSave = function (force) {
          if (!canEdit || saving || data === null) return;
          if (!dirty && force !== true) return; // 无改动不空写
          if (draft.length > MAX_EDIT_CHARS) {
            setSaveErr({ msg: '内容超过 1 MiB 上限，无法保存。' });
            return;
          }
          setSaving(true);
          setSaveErr(null);
          api('save', {
            root: props.root,
            path: props.rel,
            content: draft,
            mtimeMs: data.mtimeMs,
            force: force === true,
          })
            .then(function (res) {
              setSaving(false);
              if (res && res.ok) {
                setData(
                  Object.assign({}, data, { text: draft, size: res.size, mtimeMs: res.mtimeMs }),
                );
                flashSaved();
                if (typeof props.onSaved === 'function') props.onSaved();
              } else if (res && res.error === 'conflict') {
                setSaveErr({
                  conflict: true,
                  msg: '文件在磁盘上已被外部修改（如 agent 同时改动）。',
                });
              } else {
                setSaveErr({ msg: '保存失败：' + ((res && res.error) || 'failed') });
              }
            })
            .catch(function () {
              setSaving(false);
              setSaveErr({ msg: '请求失败，保存未完成。' });
            });
        };

        var exitEditing = function () {
          if (dirty && !window.confirm('放弃未保存的更改？')) return;
          setEditing(false);
          setDraft(data !== null && typeof data.text === 'string' ? data.text : '');
          setSaveErr(null);
        };
        var toggleEdit = function () {
          if (!canEdit || data === null || err !== null) return;
          if (editing) exitEditing();
          else {
            setDraft(data.text || '');
            setSaveErr(null);
            setEditing(true);
          }
        };
        var doClose = function () {
          if (dirty && !window.confirm('有未保存的更改，仍要关闭？')) return;
          props.onClose();
        };

        var editorRef = React.useRef(null);
        var onEditorKeyDown = function (e) {
          if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 's') {
            e.preventDefault();
            e.stopPropagation();
            performSave(e.shiftKey === true ? true : false); // Shift+⌘S = 忽略外部修改强制写
            return;
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            var el = e.target;
            var s = typeof el.selectionStart === 'number' ? el.selectionStart : draft.length;
            var t = typeof el.selectionEnd === 'number' ? el.selectionEnd : s;
            var next = draft.slice(0, s) + '  ' + draft.slice(t);
            setDraft(next);
            setTimeout(function () {
              if (
                editorRef.current !== null &&
                typeof editorRef.current.setSelectionRange === 'function'
              ) {
                editorRef.current.setSelectionRange(s + 2, s + 2);
              }
            }, 0);
            return;
          }
          if (e.key === 'Escape') {
            e.stopPropagation(); // 只退出编辑态, 不冒泡触发全局关面板
            exitEditing();
          }
        };

        var headExtra = canEdit
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                'button',
                {
                  className: 'fge-btn' + (editing ? ' fge-btn-active' : ''),
                  title: editing ? '退出编辑' : '编辑此文件',
                  onClick: toggleEdit,
                },
                editing ? '退出' : '编辑',
              ),
              React.createElement(
                'button',
                {
                  className: 'fge-btn',
                  title: '保存(⌘S；Shift+⌘S 忽略外部修改强制写入)',
                  onClick: function () {
                    performSave(false);
                  },
                  disabled: !dirty || saving,
                },
                saving ? '保存中…' : '保存',
              ),
            )
          : null;

        var body = null;
        var editBodyStyle =
          editing && canEdit ? { overflow: 'hidden', display: 'flex' } : undefined;
        if (err !== null) {
          body = React.createElement('div', { className: 'fge-note' }, '读取失败: ' + err);
        } else if (data === null) {
          body = React.createElement('div', { className: 'fge-note' }, '加载中…');
        } else if (editing && canEdit) {
          var barText = savedFlash ? '✓ 已保存' : dirty ? '未保存更改' : '已同步';
          var conflictBox =
            saveErr !== null && saveErr.conflict
              ? React.createElement(
                  'div',
                  { className: 'fge-conflict' },
                  saveErr.msg,
                  React.createElement('br', null),
                  '覆盖将丢弃磁盘上的新版本；重新加载会放弃当前编辑内容。',
                  ' ',
                  React.createElement(
                    'button',
                    {
                      className: 'fge-btn',
                      onClick: function () {
                        performSave(true);
                      },
                    },
                    '仍要覆盖写入',
                  ),
                  ' ',
                  React.createElement(
                    'button',
                    {
                      className: 'fge-btn',
                      onClick: function () {
                        if (dirty && !window.confirm('放弃当前编辑内容并加载磁盘最新版本？')) {
                          return;
                        }
                        setSaveErr(null);
                        reloadSeqRef.current += 1;
                        setReloadSeq(reloadSeqRef.current);
                      },
                    },
                    '重新加载磁盘版',
                  ),
                )
              : null;
          body = React.createElement(
            'div',
            { className: 'fge-editorcol' },
            React.createElement(
              'div',
              { className: 'fge-editbar' },
              React.createElement(
                'span',
                {
                  className: savedFlash
                    ? 'fge-editbar-saved'
                    : dirty
                      ? 'fge-editbar-dirty'
                      : undefined,
                },
                barText,
              ),
              React.createElement('span', { style: { marginLeft: 'auto' } }, '⌘S 保存 · Esc 退出'),
            ),
            conflictBox,
            saveErr !== null && !saveErr.conflict
              ? React.createElement('div', { className: 'fge-saveerr' }, saveErr.msg)
              : null,
            React.createElement('textarea', {
              className: 'fge-textarea',
              ref: editorRef,
              value: draft,
              spellCheck: false,
              onChange: function (e) {
                setDraft(e.target.value);
              },
              onKeyDown: onEditorKeyDown,
            }),
          );
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
            track: props.track,
            region: props.region || 'cf',
            title: props.rel + (dirty ? ' •' : ''),
            headExtra: headExtra,
            onClose: doClose,
            onHide: props.onHide,
            bodyProps: editBodyStyle !== undefined ? { style: editBodyStyle } : undefined,
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

        // commitHash 模式 = 复用本面板展示「某次提交内某文件的 diff」(历史详情点文件行):
        // 走 show 路由取该提交内该路径的 diff; 缺省 = 工作区变更 diff。
        var commitHash = props.commitHash || null;

        React.useEffect(
          function () {
            var alive = true;
            setData(null);
            setErr(null);
            var req = commitHash
              ? api('show', {
                  root: props.root,
                  repoRoot: props.repoRoot,
                  hash: commitHash,
                  path: props.change.path,
                })
              : api('diff', {
                  root: props.root,
                  repoRoot: props.repoRoot,
                  path: props.change.path,
                  status: props.change.status,
                  from: props.change.from,
                });
            req
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
          [props.change.path, props.statusVersion, commitHash],
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
            badge: props.badge === undefined ? props.change.status : props.badge,
            track: props.track,
            region: props.region || 'df',
            title: props.change.path,
            onClose: props.onClose,
            onHide: props.onHide,
          },
          body,
        );
      }

      // ---- 提交历史悬浮面板(右树头部入口, 与 diff 浮层互斥共享锚位) ----
      // props: style, root, repoRoot, refName(string|null), statusHead(string|null),
      //        onClose, onHide
      // refName = 「查看分支」(下拉最后点击, 缺省当前分支); 列表 50 条/页滚动加载;
      // turn-end 自动刷新比对 HEAD(statusHead), 变了才整页重拉并保留滚动位置。
      function fmtRelTime(at) {
        var diff = Math.floor(Date.now() / 1000) - at;
        if (!(diff >= 0)) return '';
        if (diff < 60) return '刚刚';
        if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
        if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
        if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
        var d = new Date(at * 1000);
        return (
          d.getFullYear() +
          '-' +
          String(d.getMonth() + 1).padStart(2, '0') +
          '-' +
          String(d.getDate()).padStart(2, '0')
        );
      }

      function HistoryPanel(props) {
        var PAGE = 50;
        var commitsState = React.useState(null); // null = 首屏加载中
        var commits = commitsState[0];
        var setCommits = commitsState[1];
        var exhaustedState = React.useState(false);
        var exhausted = exhaustedState[0];
        var setExhausted = exhaustedState[1];
        var loadingMoreState = React.useState(false);
        var loadingMore = loadingMoreState[0];
        var setLoadingMore = loadingMoreState[1];
        var errState = React.useState(null);
        var err = errState[0];
        var setErr = errState[1];
        var viewHashState = React.useState(null); // null=列表 | hash=详情(详情仍在历史面板内)
        var viewHash = viewHashState[0];
        var setViewHash = viewHashState[1];
        var detailState = React.useState(null); // {kind:'commit'|'merge', message, files?}
        var detail = detailState[0];
        var setDetail = detailState[1];
        var listRef = React.useRef(null);
        var shownHeadRef = React.useRef(null); // 本列表已知的 HEAD(供刷新比对)

        // ---- 头部「查看分支」切换器 ----
        // 分支名可点: 弹出与右树同款的本地/远程分组菜单, 点选即改写
        // 「查看分支」(FgeRoot 状态) —— refName 随之变化, 列表自动重拉。
        var pickState = React.useState(false);
        var pickOpen = pickState[0];
        var setPickOpen = pickState[1];
        var pickBranches = Array.isArray(props.branches) ? props.branches : [];
        var pickLocal = [];
        var pickRemote = [];
        for (var pbi = 0; pbi < pickBranches.length; pbi++) {
          (pickBranches[pbi].remote ? pickRemote : pickLocal).push(pickBranches[pbi]);
        }
        var pickGroup = function (title, list) {
          if (list.length === 0) return null;
          return React.createElement(
            React.Fragment,
            { key: title },
            React.createElement('div', { className: 'fge-branch-group' }, title),
            list.map(function (br) {
              var isCur = br.name === props.currentBranch;
              var isViewed = br.name === props.viewedBranch && !isCur;
              var mark = isCur ? '当前' : isViewed ? '查看中' : '';
              return React.createElement(
                'div',
                {
                  key: br.ref,
                  className:
                    'fge-branch-item' +
                    (isCur ? ' fge-branch-current' : '') +
                    (isViewed ? ' fge-branch-viewed' : ''),
                  onClick: function () {
                    setPickOpen(false);
                    if (!isCur && props.onViewBranch) props.onViewBranch(br.name);
                  },
                  title: isCur ? '当前分支(默认跟随)' : '查看该分支的提交历史(只读, 不切换工作区)',
                },
                React.createElement('span', null, br.name),
                React.createElement('span', { className: 'fge-branch-mark' }, mark),
              );
            }),
          );
        };
        var branchPick = React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'button',
            {
              className: 'fge-hbranch',
              title: '点击切换查看分支(只读, 不做工作区切换)',
              onClick: function () {
                setPickOpen(!pickOpen);
              },
            },
            React.createElement(BranchIcon, null),
            React.createElement('span', null, props.viewedBranch || '(HEAD)'),
            React.createElement(CaretIcon, { open: pickOpen }),
          ),
          pickOpen
            ? React.createElement(
                'div',
                { className: 'fge-hmenu' },
                pickGroup('本地分支', pickLocal),
                pickGroup('远程分支', pickRemote),
              )
            : null,
        );

        var fetchPage = React.useCallback(
          function (skip, limit) {
            return api('log', {
              root: props.root,
              repoRoot: props.repoRoot,
              ref: props.refName || undefined,
              skip: skip,
              limit: limit,
            });
          },
          [props.root, props.repoRoot, props.refName],
        );

        // ref / 仓库变化 → 重置并拉第一页
        React.useEffect(
          function () {
            var alive = true;
            setCommits(null);
            setViewHash(null);
            setDetail(null);
            if (props.onCloseFileDiff) props.onCloseFileDiff(); // 换查看分支 → 关闭文件 diff 悬浮栏
            setErr(null);
            setExhausted(false);
            shownHeadRef.current = null;
            fetchPage(0, PAGE)
              .then(function (r) {
                if (!alive) return;
                if (r && r.ok) {
                  setCommits(r.commits);
                  if (r.commits.length < PAGE) setExhausted(true);
                  shownHeadRef.current = r.head;
                } else {
                  setErr((r && r.error) || 'failed');
                }
              })
              .catch(function () {
                if (alive) setErr('rpc-failed');
              });
            return function () {
              alive = false;
            };
          },
          [props.refName, props.repoRoot, props.root],
        );

        // HEAD 变化(turn-end 自动刷新链路)→ 整页重拉, 尽量保留滚动位置
        React.useEffect(
          function () {
            var sh = props.statusHead;
            if (!sh || !shownHeadRef.current || sh === shownHeadRef.current) return;
            if (commits === null || commits.length === 0) return;
            var el = listRef.current;
            var prevTop = el ? el.scrollTop : 0;
            var count = commits.length;
            var alive = true;
            fetchPage(0, Math.max(count, PAGE))
              .then(function (r) {
                if (!alive || !r || !r.ok) return;
                setCommits(r.commits);
                shownHeadRef.current = r.head;
                if (r.commits.length < PAGE) setExhausted(true);
                requestAnimationFrame(function () {
                  if (el) el.scrollTop = Math.min(prevTop, el.scrollHeight);
                });
              })
              .catch(function () {});
            return function () {
              alive = false;
            };
          },
          [props.statusHead],
        );

        var onListScroll = function (e) {
          var el = e.currentTarget;
          if (exhausted || loadingMore || commits === null || commits.length === 0) return;
          if (el.scrollTop + el.clientHeight < el.scrollHeight - 40) return;
          setLoadingMore(true);
          fetchPage(commits.length, PAGE)
            .then(function (r) {
              if (r && r.ok) {
                setCommits(function (prev) {
                  return (prev || []).concat(r.commits);
                });
                if (r.commits.length < PAGE) setExhausted(true);
              } else {
                setExhausted(true);
              }
              setLoadingMore(false);
            })
            .catch(function () {
              setLoadingMore(false);
              setExhausted(true);
            });
        };

        // 详情视图仍在历史面板内: 完整 message + 文件 ±行数列表;
        // 点文件行由 FgeRoot 在历史面板左侧单开 DiffPanel 展示该提交内该文件的 diff
        // (与右侧变更列表点开 diff 悬浮栏同一套交互)。
        var detailReqRef = React.useRef(null); // 竞态守卫: 只接受最后一次详情请求
        var openDetail = function (c) {
          detailReqRef.current = c.hash;
          setViewHash(c.hash);
          setDetail(null);
          if (props.onCloseFileDiff) props.onCloseFileDiff(); // 换提交 → 关闭上一份文件 diff
          api('show', { root: props.root, repoRoot: props.repoRoot, hash: c.hash })
            .then(function (r) {
              if (detailReqRef.current !== c.hash) return;
              if (r && r.ok) setDetail(r);
              else setDetail({ kind: 'error', message: (r && r.error) || 'failed' });
            })
            .catch(function () {
              if (detailReqRef.current !== c.hash) return;
              setDetail({ kind: 'error', message: 'rpc-failed' });
            });
        };

        // ---- 渲染 ----
        // 查看分支不再拼进标题: 头部的 branchPick 按钮承担展示 + 切换。
        var title = '提交历史';
        var headExtra =
          viewHash !== null
            ? React.createElement(
                'button',
                {
                  className: 'fge-btn',
                  title: '返回提交列表',
                  onClick: function () {
                    detailReqRef.current = null;
                    setViewHash(null);
                    setDetail(null);
                    if (props.onCloseFileDiff) props.onCloseFileDiff(); // 回列表 → 关闭文件 diff
                  },
                },
                '‹ 列表',
              )
            : null;

        var body = null;
        if (err !== null) {
          body = React.createElement('div', { className: 'fge-note' }, '读取失败: ' + err);
        } else if (viewHash !== null) {
          // 详情视图: 完整 message + 文件 ±行数列表 → 点文件行在历史面板左侧开 diff 悬浮栏
          var inner = [];
          if (detail === null) {
            inner.push(React.createElement('div', { className: 'fge-note', key: 'ld' }, '加载中…'));
          } else if (detail.kind === 'error') {
            inner.push(
              React.createElement(
                'div',
                { className: 'fge-note', key: 'er' },
                '读取失败: ' + detail.message,
              ),
            );
          } else {
            inner.push(
              React.createElement(
                'pre',
                { className: 'fge-msg', key: 'msg' },
                detail.message.trim() || '(无提交说明)',
              ),
            );
            if (detail.kind === 'merge') {
              inner.push(
                React.createElement(
                  'div',
                  { className: 'fge-note', key: 'mg' },
                  'merge 提交不展示 diff',
                ),
              );
            } else if (!Array.isArray(detail.files) || detail.files.length === 0) {
              inner.push(
                React.createElement('div', { className: 'fge-note', key: 'ef' }, '(空提交)'),
              );
            } else {
              for (var fi = 0; fi < detail.files.length; fi++) {
                (function (f) {
                  inner.push(
                    React.createElement(
                      'div',
                      {
                        className: 'fge-cfile',
                        key: 'f:' + f.path,
                        onClick: function () {
                          if (props.onOpenFileDiff) props.onOpenFileDiff(viewHash, f.path);
                        },
                        title: f.from ? f.path + ' (原 ' + f.from + ')' : f.path,
                      },
                      f.adds === null
                        ? React.createElement('span', { className: 'fge-badge fge-badge-i' }, 'B')
                        : React.createElement(
                            'span',
                            { className: 'fge-commit-meta' },
                            React.createElement(
                              'span',
                              { className: 'fge-stat-add' },
                              '+' + f.adds,
                            ),
                            React.createElement(
                              'span',
                              { className: 'fge-stat-del' },
                              '−' + f.dels,
                            ),
                          ),
                      React.createElement('span', { className: 'fge-cfile-path' }, f.path),
                    ),
                  );
                })(detail.files[fi]);
              }
            }
          }
          body = React.createElement('div', null, inner);
        } else {
          // 列表视图
          var list = [];
          if (commits === null) {
            list.push(React.createElement('div', { className: 'fge-note', key: 'ld' }, '加载中…'));
          } else if (commits.length === 0) {
            list.push(
              React.createElement('div', { className: 'fge-empty', key: 'mt' }, '(无提交)'),
            );
          } else {
            for (var ci = 0; ci < commits.length; ci++) {
              (function (c) {
                list.push(
                  React.createElement(
                    'div',
                    {
                      key: c.hash,
                      className: 'fge-commit',
                      onClick: function () {
                        openDetail(c);
                      },
                      title: c.hash,
                    },
                    React.createElement('div', { className: 'fge-commit-subject' }, c.subject),
                    React.createElement(
                      'div',
                      { className: 'fge-commit-meta' },
                      React.createElement('span', null, c.author),
                      React.createElement('span', null, fmtRelTime(c.at)),
                      React.createElement('span', { className: 'fge-hash' }, c.short),
                    ),
                  ),
                );
              })(commits[ci]);
            }
            if (loadingMore) {
              list.push(
                React.createElement('div', { className: 'fge-loading', key: 'lm' }, '加载中…'),
              );
            } else if (exhausted) {
              list.push(
                React.createElement('div', { className: 'fge-empty', key: 'btm' }, '已到底'),
              );
            }
          }
          body = React.createElement('div', null, list);
        }

        return React.createElement(
          FloatPanel,
          {
            style: props.style,
            title: title,
            track: props.track,
            region: props.region || 'hs',
            afterTitle: branchPick,
            headExtra: headExtra,
            bodyProps: viewHash === null ? { onScroll: onListScroll } : undefined,
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
            var sess = currentSession(s);
            return sess && typeof sess.cwd === 'string' && sess.cwd !== '' ? sess.cwd : null;
          });
        }

        // 当前会话的 agent 运行态: turn 结束(running true→false)是自动刷新触发信号。
        var running = false;
        if (typeof useSessions === 'function') {
          running = useSessions(function (s) {
            var sess = currentSession(s);
            return !!(sess && sess.running);
          });
        }
        var prevRunningRef = React.useRef(running);
        var pendingAutoRef = React.useRef(false);
        var lastAutoRef = React.useRef(0);
        var autoRefreshFnRef = React.useRef(null);
        var autoRetryRef = React.useRef(null);

        var infoState = React.useState(null);
        var info = infoState[0];
        var setInfo = infoState[1];
        var statusState = React.useState(null);
        var status = statusState[0];
        var setStatus = statusState[1];
        var pinState = React.useState(true);
        var pin = pinState[0];
        var setPin = pinState[1];
        var leftOpenState = React.useState(true);
        var leftOpen = leftOpenState[0];
        var setLeftOpen = leftOpenState[1];
        var rightOpenState = React.useState(true);
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
        // 提交历史浮层开关(布尔): 面板内部状态由 HistoryPanel 自持
        var historyState = React.useState(false);
        var historyOpen = historyState[0];
        var setHistoryOpen = historyState[1];
        // 提交内文件 diff 浮层: 历史详情点文件行后, 在历史面板左侧单开
        // (复用 DiffPanel 的 commitHash 模式, 与变更列表点开 diff 同一套交互)。
        var histFileDiffState = React.useState(null); // {hash, path} | null
        var histFileDiff = histFileDiffState[0];
        var setHistFileDiff = histFileDiffState[1];
        var linkageState = React.useState(null);
        var linkage = linkageState[0];
        var setLinkage = linkageState[1];
        var refreshTickState = React.useState(0);
        var refreshTick = refreshTickState[0];
        var setRefreshTick = refreshTickState[1];
        // 状态版本: 每次 status 重取(自动/手动)递增, 驱动已打开的 diff 悬浮栏重拉
        var statusVersionState = React.useState(0);
        var statusVersion = statusVersionState[0];
        var setStatusVersion = statusVersionState[1];

        // ---- 视图观测(对话 vs 其他页签) ----
        // active view ≠ 对话 → 双树强制细条化(快照 pin/open), 切回对话 → 还原快照。
        // 轨迹/数据库等任何非对话页签一视同仁(fge 是侧栏联动的唯一事实来源,
        // db-console 等未来页签无需自行广播)。快照只进内存不落盘。
        var awayState = React.useState(null); // null=对话视图 | 字符串=离场中的页签名
        var away = awayState[0];
        var setAway = awayState[1];
        var awaySnapRef = React.useRef(null);
        var awaySnapTakenRef = React.useRef(false); // 本轮离场是否已处理过(含无快照情形)
        var everChatRef = React.useRef(false); // 本次挂载以来是否观测到过对话视图
        var awayRef = React.useRef(false);
        var cacheAppliedRef = React.useRef(false); // cwd 缓存是否已回放进当前状态

        // 保持区追踪器(左右各一): onFire 经 ref 取最新 hide*, 避免 stale 闭包
        var hideLeftRef = React.useRef(null);
        var hideRightRef = React.useRef(null);
        var leftTrack = React.useState(function () {
          return makeSideTracker(function () {
            if (hideLeftRef.current) hideLeftRef.current();
          });
        })[0];
        var rightTrack = React.useState(function () {
          return makeSideTracker(function () {
            if (hideRightRef.current) hideRightRef.current();
          });
        })[0];
        React.useEffect(function () {
          return function () {
            leftTrack.dispose();
            rightTrack.dispose();
          };
        }, []);

        // 页签观测器: 只读会话头部 tablist 的选中态, 与 fge 几何观测器分开,
        // 回调仅做字符串比较 + 条件 setState, 开销可忽略。
        React.useEffect(function () {
          function readActiveLabel() {
            var list = findSessionTablist();
            if (!list) return null;
            var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
            for (var i = 0; i < tabs.length; i++) {
              var t = tabs[i];
              var sel = t.getAttribute && t.getAttribute('aria-selected') === 'true';
              if (!sel) {
                var cls = typeof t.className === 'string' ? t.className : '';
                sel = /(^|\s)(active|selected|is-active)(\s|$)/.test(cls);
              }
              if (sel) return (t.textContent || '').trim();
            }
            return null;
          }
          function sync() {
            var label = readActiveLabel();
            var next = typeof label === 'string' && label !== '' && label !== '对话' ? label : null;
            if (next === null) everChatRef.current = true; // 观测到对话态
            setAway(function (prev) {
              return prev === next ? prev : next;
            });
          }
          sync();
          var obs = new MutationObserver(sync);
          obs.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class', 'aria-selected'],
          });
          return function () {
            obs.disconnect();
          };
        }, []);

        var cacheKey = info ? info.repoRoot || info.cwd : null;
        var root = sessionCwd || (info ? info.cwd : null);

        // 提交历史跟随「查看分支」: 下拉里最后点击的分支(默认当前分支)。
        // 查看分支已不在分支列表(如被删除)时回退当前分支; 非 git 目录为 null(host 回退 HEAD)。
        var branchList = status && Array.isArray(status.branches) ? status.branches : [];
        var viewedKnown =
          typeof viewedBranch === 'string' &&
          viewedBranch !== '' &&
          branchList.some(function (b) {
            return b.name === viewedBranch;
          });
        var historyRefName = viewedKnown
          ? viewedBranch
          : status && typeof status.current === 'string' && status.current !== ''
            ? status.current
            : null;

        // 根切换时关闭悬浮面板与联动
        React.useEffect(
          function () {
            setContent(null);
            setDiff(null);
            setLinkage(null);
            setHistoryOpen(false);
            setHistFileDiff(null);
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
                // 离场中不接受缓存回放(会顶掉强制收起态); 回对话后由快照还原负责
                if (cached && !awayRef.current) {
                  cacheAppliedRef.current = true;
                  if (typeof cached.pin === 'boolean') setPin(cached.pin);
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

        // 持久化 cwd 缓存(含固定态: 让「固定+展开」跨会话/刷新保留)
        // 离场中的强制收起态不落缓存 —— 否则刷新后快照语义被污染
        React.useEffect(
          function () {
            if (!cacheKey || awayRef.current) return;
            writeCache(cacheKey, {
              pin: pin,
              leftW: leftW,
              rightW: rightW,
              leftOpen: leftOpen,
              rightOpen: rightOpen,
              viewedBranch: viewedBranch,
            });
          },
          [cacheKey, pin, leftW, rightW, leftOpen, rightOpen, viewedBranch],
        );

        // 应用一次 status 结果: 更新状态、递增版本(驱动已打开 diff 重拉),
        // 若打开的 diff 对应变更已不在变更集(如已提交)则关闭该悬浮栏。
        var applyStatus = React.useCallback(function (st) {
          if (!st || !st.ok) return;
          setStatus(st);
          setStatusVersion(function (v) {
            return v + 1;
          });
          setDiff(function (prev) {
            if (!prev || !prev.change) return prev;
            if (Array.isArray(st.changes)) {
              var latest = null;
              for (var i = 0; i < st.changes.length; i++) {
                if (st.changes[i].path === prev.change.path) {
                  latest = st.changes[i];
                  break;
                }
              }
              if (!latest) return null; // 已不在变更集(如已提交) → 关闭
              // 仍在变更集 → 用最新元数据替换(重拉 diff 用最新 status/from)
              return { change: latest };
            }
            return prev;
          });
        }, []);

        // 自动刷新用: 只重取 status(不重查 info, 不作废树缓存 —— 文件树仅走手动 ⟳)
        var refreshStatus = React.useCallback(
          function () {
            if (!info || !info.repoRoot) return;
            api('status', { root: info.cwd, repoRoot: info.repoRoot })
              .then(applyStatus)
              .catch(function () {});
          },
          [info, applyStatus],
        );

        // 手动刷新(⟳): 重读 info + status, 树缓存作废; 无视冷却, 立刻执行。
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
                    .then(applyStatus)
                    .catch(function () {});
                }
              })
              .catch(function () {});
          },
          [root, applyStatus],
        );

        // 自动刷新(git 状态, 事件驱动): turn 结束(running true→false)触发。
        // 冷却 1s; 仅当右侧面板可见时才真正重取, 不可见则挂起(面板下次展开时补刷)。
        React.useEffect(
          function () {
            if (prevRunningRef.current && !running) {
              if (autoRefreshFnRef.current) autoRefreshFnRef.current();
            }
            prevRunningRef.current = running;
          },
          [running],
        );
        // 卸载清理自动刷新的重试定时器
        React.useEffect(function () {
          return function () {
            if (autoRetryRef.current) {
              clearTimeout(autoRetryRef.current);
              autoRetryRef.current = null;
            }
          };
        }, []);

        // 悬停交互: 面板由「鼠标悬停细条展开 / 鼠标离开面板收起」驱动,
        // 未固定时鼠标离开面板即自动收起为细条; 固定时保持展开。
        // 不再用「点击面板外收起」, 避免鼠标落在细条上时反复展开/收起。

        // Escape 关闭悬浮面板
        React.useEffect(function () {
          function onKey(e) {
            if (e.key === 'Escape') {
              setContent(null);
              setDiff(null);
              setHistoryOpen(false);
              setHistFileDiff(null);
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
          // 与历史浮层互斥: 打开 diff 即关闭历史(共享同一锚位)
          setHistoryOpen(false);
          setHistFileDiff(null);
          setDiff(function (prev) {
            if (prev && prev.change.path === ch.path) return null;
            return { change: ch };
          });
        }, []);

        // 树内写操作事件: 重命名/删除同步已打开的内容悬浮面板(前缀映射),
        // 避免面板还停在旧路径上(其内容已失效或已被删除)。
        var onTreeEvent = React.useCallback(function (evt) {
          if (!evt) return;
          if (evt.type === 'renamed') {
            var from = evt.from;
            var to = evt.to;
            setContent(function (prev) {
              if (!prev) return prev;
              if (prev.rel === from) {
                var base = to.slice(to.lastIndexOf('/') + 1);
                return { rel: to, name: base };
              }
              if (prev.rel.startsWith(from + '/')) {
                return { rel: to + prev.rel.slice(from.length), name: prev.name };
              }
              return prev;
            });
          } else if (evt.type === 'deleted') {
            var del = evt.rel;
            setContent(function (prev) {
              if (!prev) return prev;
              if (prev.rel === del || prev.rel.startsWith(del + '/')) return null;
              return prev;
            });
          }
        }, []);

        // 提交历史开关: 打开时关闭 diff 浮层(互斥共享锚位), 文件 diff 随历史一并复位
        var toggleHistory = React.useCallback(
          function () {
            if (historyOpen) {
              setHistoryOpen(false);
              setHistFileDiff(null);
              return;
            }
            setDiff(null);
            setHistoryOpen(true);
            setHistFileDiff(null);
          },
          [historyOpen],
        );

        // 历史详情点文件行 → 在历史面板左侧开/关该提交内该文件的 diff 悬浮栏
        // (复用 DiffPanel, 与右侧变更列表点开 diff 同一套交互; 再点同一行 = 关闭)。
        var openHistFileDiff = React.useCallback(function (hash, path) {
          if (!hash || !path) return;
          setHistFileDiff(function (prev) {
            if (prev && prev.hash === hash && prev.path === path) return null;
            return { hash: hash, path: path };
          });
        }, []);

        // 图钉: 无论点哪个面板的图钉, 动作一致 —— 固定时两个面板都展开为卡片。
        // 避免出现「已固定但另一侧仍是细条」的不一致状态。
        var togglePin = React.useCallback(
          function () {
            var next = !pin;
            setPin(next);
            if (next) {
              setLeftOpen(true);
              setRightOpen(true);
            }
          },
          [pin],
        );

        // 收起某侧(悬停离开延迟触发 / 收起按钮): 一并关闭该侧关联的悬浮面板,
        // 避免「侧栏收了、悬浮栏还在」的孤儿状态(联动)。
        var hideLeft = React.useCallback(
          function () {
            if (!pin) {
              setLeftOpen(false);
              setContent(null);
            }
          },
          [pin],
        );
        var hideRight = React.useCallback(
          function () {
            if (!pin) {
              setRightOpen(false);
              setDiff(null);
              setHistoryOpen(false);
              setHistFileDiff(null);
            }
          },
          [pin],
        );

        // 分支下拉与右侧悬浮栏互斥(防遮挡): 展开下拉时关闭 diff/历史/文件 diff 悬浮栏。
        // 反方向(悬浮栏打开时收起下拉)由 RightPanel 内部经 floatOpen 处理。
        var openBranchMenu = React.useCallback(function () {
          setDiff(null);
          setHistoryOpen(false);
          setHistFileDiff(null);
        }, []);

        // 保持区追踪器的触发回调指向最新 hide*(每渲染刷新, 见 makeSideTracker)
        hideLeftRef.current = hideLeft;
        hideRightRef.current = hideRight;

        // 离场/回归转换: 进非对话页签 → 快照并强制收起(联动关闭全部悬浮栏);
        // 切回对话 → 还原快照。挂载即离场(如刷新后落在数据库页签)不算"进入":
        // 不产生快照, 切回对话时回退默认的展开+固定 —— 即使 cwd 缓存先行回放
        // (cacheAppliedRef)也不把回放值当作进入前状态。
        React.useEffect(
          function () {
            awayRef.current = !!away;
            if (away && !awaySnapTakenRef.current) {
              awaySnapTakenRef.current = true;
              if (everChatRef.current && !cacheAppliedRef.current) {
                awaySnapRef.current = { pin: pin, leftOpen: leftOpen, rightOpen: rightOpen };
              }
              setPin(false);
              setLeftOpen(false);
              setRightOpen(false);
              setContent(null);
              setDiff(null);
              setLinkage(null);
              setHistoryOpen(false);
              setHistFileDiff(null);
            } else if (!away && awaySnapTakenRef.current) {
              awaySnapTakenRef.current = false;
              var snap = awaySnapRef.current;
              awaySnapRef.current = null;
              if (snap) {
                if (typeof snap.pin === 'boolean') setPin(snap.pin);
                if (typeof snap.leftOpen === 'boolean') setLeftOpen(snap.leftOpen);
                if (typeof snap.rightOpen === 'boolean') setRightOpen(snap.rightOpen);
              } else {
                // 无快照 → 回退默认展开+固定(共识口径)
                setPin(true);
                setLeftOpen(true);
                setRightOpen(true);
              }
            }
          },
          [away],
        );

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

        // 净空广播: 把「该侧树面板对同页内容的占位」写进根级 CSS 变量
        // (--dsh-fge-strip-clear-l / -r), 供同页其他视图(数据库页签等)内缩
        // 内容。三态: 无树=0 / 细条=60px(细条右缘34+富余26) /
        // 面板展开=实宽+14(吸边8+间隙6) —— 展开时页面同步让位, 不被覆盖。
        // fge 卸载/不可渲染时变量随清理归零, 对方无需感知 fge 存在与否。
        React.useEffect(
          function () {
            var s = document.documentElement.style;
            function sideVal(canShow, show, width) {
              if (!canShow) return '0px';
              return show ? Math.round(width + 14) + 'px' : '60px';
            }
            s.setProperty('--dsh-fge-strip-clear-l', sideVal(leftCanShow, leftShow, leftWidth));
            s.setProperty('--dsh-fge-strip-clear-r', sideVal(rightCanShow, rightShow, rightWidth));
          },
          [leftCanShow, leftShow, leftWidth, rightCanShow, rightShow, rightWidth],
        );
        React.useEffect(function () {
          return function () {
            var s = document.documentElement.style;
            s.removeProperty('--dsh-fge-strip-clear-l');
            s.removeProperty('--dsh-fge-strip-clear-r');
          };
        }, []);

        // 自动刷新(git 状态): turn 结束(running true→false)时由上方事件触发。
        // 冷却 1s; 仅当右侧面板可见(rightShow)时真正重取, 否则挂起待面板展开时补刷。
        autoRefreshFnRef.current = function () {
          var now = Date.now();
          if (!rightShow) {
            pendingAutoRef.current = true; // 不可见 → 必挂起(无论冷却)
            return;
          }
          var remaining = 1000 - (now - lastAutoRef.current);
          if (remaining > 0) {
            // 可见但处于冷却: 安排一次冷却结束后的重试, 避免挂起刷新被丢弃
            pendingAutoRef.current = true;
            if (autoRetryRef.current) clearTimeout(autoRetryRef.current);
            autoRetryRef.current = setTimeout(function () {
              autoRetryRef.current = null;
              lastAutoRef.current = Date.now();
              pendingAutoRef.current = false;
              refreshStatus();
            }, remaining + 30);
            return;
          }
          lastAutoRef.current = now;
          pendingAutoRef.current = false;
          refreshStatus();
        };
        // 面板从不可见变为可见时, 若挂起过一次自动刷新 → 立即触发(内部处理冷却/重试)
        React.useEffect(
          function () {
            if (rightShow && pendingAutoRef.current) {
              if (autoRefreshFnRef.current) autoRefreshFnRef.current();
            }
          },
          [rightShow],
        );

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
        // 右侧两浮层(历史面板 + 提交内文件 diff 面板)并排:
        // - 详情面板优先取满宽, 与右侧变更列表打开的 diff 同宽(diffW);
        // - 历史面板让位到剩余带宽(保底 FLOAT_MIN_W), 且并排宽度只由 historyOpen
        //   决定 —— 打开/关闭详情时历史面板宽度不变, 无跳变;
        // - 并排左界: 左树展开时以左树右缘 +8 为界(不盖左树; 悬浮栏允许越过
        //   对话区), 左树不可用时退回对话区左缘 +40; 带宽不足时详情降宽。
        var FLOAT_MIN_W = 280;
        var histW = diffW;
        var histFileDiffW = diffW;
        var pairLeft = geo.convLeft + 40;
        if (historyOpen) {
          pairLeft = leftShow ? leftAnchor + 8 : geo.convLeft + 40;
          var pairBand = (rightAnchor - 10) - pairLeft - 10;
          if (pairBand < diffW * 2 + 10) {
            var wantDetail = Math.min(diffW, Math.max(FLOAT_MIN_W, pairBand - FLOAT_MIN_W));
            histW = Math.max(FLOAT_MIN_W, pairBand - wantDetail);
            histFileDiffW = wantDetail;
          }
        }
        var diffStyle = {
          left: Math.max(geo.convLeft + 40, rightAnchor - 10 - histW),
          top: top,
          width: histW,
          height: height,
        };
        // 提交内文件 diff 悬浮面板: 单开在历史面板左侧(留 10px 间距), 与历史面板同存;
        // 与变更列表的 diff 同宽(diffW), 左界放宽到左树右缘, 不再遮挡文件列表。
        var histFileDiffStyle = {
          left: Math.max(pairLeft, diffStyle.left - histFileDiffW - 10),
          top: top,
          width: histFileDiffW,
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
                cacheKey: cacheKey,
                pin: pin,
                pinDisabled: !!away,
                track: leftTrack,
                onPin: togglePin,
                onRefresh: refresh,
                onCollapse: hideLeft,
                onHide: hideLeft,
                onResizeStart: resize('left'),
                refreshTick: refreshTick,
                onFileClick: onFileClick,
                onMutate: refreshStatus,
                onTreeEvent: onTreeEvent,
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
                pinDisabled: !!away,
                track: rightTrack,
                onPin: togglePin,
                onRefresh: refresh,
                onCollapse: hideRight,
                onHide: hideRight,
                onResizeStart: resize('right'),
                viewedBranch: viewedBranch,
                floatOpen: !!(diff || historyOpen || histFileDiff),
                onOpenMenu: openBranchMenu,
                linkagePath: linkage,
                onDiffClick: onDiffClick,
                selectedDiff: diff ? diff.change.path : null,
                onToggleHistory: toggleHistory,
                historyOpen: historyOpen,
                hasRepo: !!(info && info.repoRoot),
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
                track: leftTrack,
                region: 'cf',
                root: root,
                rel: content.rel,
                onClose: function () {
                  setContent(null);
                },
                onHide: hideLeft,
                onSaved: refreshStatus,
              })
            : null,
          diff
            ? React.createElement(DiffPanel, {
                style: diffStyle,
                track: rightTrack,
                region: 'df',
                root: root,
                change: diff.change,
                repoRoot: info.repoRoot,
                statusVersion: statusVersion,
                onClose: function () {
                  setDiff(null);
                },
                onHide: hideRight,
              })
            : null,
          historyOpen && info.repoRoot
            ? React.createElement(HistoryPanel, {
                style: diffStyle, // 与 diff 浮层互斥共享锚位(开一关一)
                track: rightTrack,
                region: 'hs',
                root: root,
                repoRoot: info.repoRoot,
                refName: historyRefName,
                branches: branchList,
                currentBranch: status ? status.current : null,
                viewedBranch: historyRefName,
                onViewBranch: setViewedBranch,
                onOpenFileDiff: openHistFileDiff,
                onCloseFileDiff: function () {
                  setHistFileDiff(null);
                },
                statusHead: status ? status.head : null,
                onClose: function () {
                  setHistoryOpen(false);
                  setHistFileDiff(null);
                },
                onHide: hideRight,
              })
            : null,
          historyOpen && info.repoRoot && histFileDiff
            ? React.createElement(DiffPanel, {
                key: histFileDiff.hash + ':' + histFileDiff.path,
                style: histFileDiffStyle,
                track: rightTrack,
                region: 'hd',
                root: root,
                repoRoot: info.repoRoot,
                change: { path: histFileDiff.path },
                commitHash: histFileDiff.hash,
                onClose: function () {
                  setHistFileDiff(null);
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
