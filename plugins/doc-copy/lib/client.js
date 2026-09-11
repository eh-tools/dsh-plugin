// dsh-doc-copy — client half(静态浏览器 bundle)
//
// 与动态插件 client 半的差异: React 经 require('react') 解析(loader 种子模块),
// 无 host 私有 RPC(本插件用官方已有的 Remote face 读文件), styles 手动注入。
//
// 为什么是「菜单项」而不是「正文上的悬浮按钮」:
//   官方文档正文注册在 `sidebar.right.tab.document` —— 那是个 **keyed** 槽,
//   注册项只有 `key`(没有 priority), 语义是「注册已占用的 key 会**替换**该占用者」。
//   也就是说, 想往正文上加按钮就必须整块顶掉官方正文组件, 而官方组件并未导出,
//   只能自己重渲染 markdown —— 富文本预览会退化。因此本插件改走
//   `sidebar.right.tab.menu.item`(list 槽): 只加一项菜单, 不替换任何组件、
//   不碰 documentPreviews 注册表(「打开方式」菜单不会出现重复项), 卸载即还原。
//
// 「流式未读完时禁用」这条也不再需要: 本插件复制的是**磁盘上的原件**
// (官方 remote.workspaceFiles.readAll), 与预览是否渲染完无关。
window.__ModuleLoader__.load({
  id: 'dsh-doc-copy',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');

    exports.name = 'dsh-doc-copy';

    /** 槽位注册表 + 读原文用的官方 Remote face。 */
    exports.inject = ['slots', 'remote', 'remote.workspaceFiles'];

    exports.apply = function (ctx) {
      var slots = ctx.slots;
      var h = React.createElement;

      var ITEM_ID = 'doc-copy';
      var FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

      // ---- 纯函数(lib/address.js 的内联副本; bundle 无法 import host ESM) ----

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
        var bytes = value.bytes !== undefined ? value.bytes : value.data;
        return bytesToText(bytes);
      }

      // ---- 剪贴板 ----

      function copyToClipboard(text) {
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          return navigator.clipboard.writeText(text);
        }
        return new Promise(function (resolve, reject) {
          try {
            var area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.top = '-1000px';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(area);
            if (ok) resolve();
            else reject(new Error('execCommand copy failed'));
          } catch (err) {
            reject(err);
          }
        });
      }

      // ---- 菜单项 ----

      /**
       * 文档页签 ⋯ 菜单末尾的一项。
       * owner props: `{ tab, dismiss }`; 另加标准 props(含 `sessionId`)。
       * 对「不是文件选项卡」或「渲染型文件(html/pdf/图片)」返回 null ——
       * 契约明确「条目自己从拿到的 tab 决定可见性」。
       */
      function CopyMenuItem(props) {
        var tab = props.tab;
        var dismiss = props.dismiss;
        var sessionId = props.sessionId;
        var statePair = React.useState('idle');
        var state = statePair[0];
        var setState = statePair[1];

        var address = tab && typeof tab.address === 'string' ? tab.address : '';
        var parsed = parseFileAddress(address);

        function onClick() {
          if (state === 'busy') return;
          setState('busy');
          var face = ctx.remote;
          var readAll = face && face.workspaceFiles ? face.workspaceFiles.readAll : null;
          if (typeof readAll !== 'function') {
            setState('failed');
            dismiss();
            return;
          }
          var target = (parsed && parsed.sessionId) || sessionId;
          Promise.resolve(readAll(target, parsed.path, undefined))
            .then(function (res) {
              var text = extractDocumentText(res);
              if (text === null) throw new Error('doc-copy: 读不到文本');
              return copyToClipboard(text);
            })
            .then(function () {
              setState('done');
              dismiss();
            })
            .catch(function (err) {
              console.warn('[doc-copy] 复制失败', err);
              setState('failed');
              dismiss();
            });
        }

        if (parsed === null) return null;
        if (!isCopyableSource(parsed.path)) return null;

        var label =
          state === 'done'
            ? '已复制'
            : state === 'failed'
              ? '复制失败'
              : state === 'busy'
                ? '复制中…'
                : '复制内容';

        return h(
          'button',
          {
            type: 'button',
            // 内联样式: 菜单是官方组件的, 不引入自己的 CSS 类以免与其样式耦合
            style: {
              display: 'block',
              width: '100%',
              textAlign: 'left',
              background: 'transparent',
              border: 0,
              color: 'inherit',
              font: 'inherit',
              padding: '5px 10px',
              cursor: state === 'busy' ? 'default' : 'pointer',
              opacity: state === 'busy' ? 0.6 : 1,
            },
            disabled: state === 'busy',
            title: parsed.path,
            onClick: onClick,
          },
          label,
        );
      }

      // ---- 注册 ----

      ctx.effect(function () {
        return slots.inject('sidebar.right.tab.menu.item', function () {
          return slots.register(
            {
              name: 'sidebar.right.tab.menu.item',
              id: ITEM_ID,
              order: 50,
              label: function () {
                return '复制内容';
              },
            },
            CopyMenuItem,
          );
        });
      }, 'doc-copy: 文档页签菜单项');

      console.info('[doc-copy] ready — 文档页签 ⋯ 菜单里的「复制内容」');
    };

    return module.exports;
  },
});
