// dsh-paste-image — client half(静态浏览器 bundle)
//
// 与动态插件 client 半的唯一差异: 沙箱内置符号换成真实模块表依赖 ——
// host.call 换成 fetch POST /paste-image/api/save, 其余(文档级 paste capture、
// conversation.input.dock 槽位、props.inputActions/sessionId/input)与动态一致。
window.__ModuleLoader__.load({
  id: 'dsh-paste-image',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    exports.name = 'dsh-paste-image';
    exports.inject = ['slots'];
    exports.apply = function (ctx) {
      var slots = ctx.slots;

      // capture 阶段拦截: 优先于 InputBar 的 React onPaste, 阻止图片进入
      // 官方草稿栏(发送时会被 inputModalities 检查拒绝)。
      var onPasteCapture = function (event) {
        var items = event.clipboardData && event.clipboardData.items;
        if (!items) return;
        var files = [];
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (item.kind === 'file' && item.type.indexOf('image/') === 0) {
            var file = item.getAsFile();
            if (file) files.push(file);
          }
        }
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        for (var j = 0; j < files.length; j++) {
          (function (file) {
            intake(file).catch(function (error) {
              console.error('paste-image intake failed:', error);
            });
          })(files[j]);
        }
      };

      // 读 File -> base64 data URL -> 发给 host -> 路径插入 draft。
      async function intake(file) {
        var dataUrl = await readAsDataURL(file);
        var base64 = dataUrl.split(',')[1];
        var res = await fetch('/paste-image/api/save', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionId,
            name: file.name || '',
            mediaType: file.type || 'image/png',
            data: base64,
          }),
        });
        var result = await res.json().catch(function () {
          return null;
        });
        if (!res.ok || !result || typeof result.path !== 'string') {
          throw new Error('paste-image: host returned no path');
        }
        var marker = '\n[已粘贴图片: ' + result.path + ']';
        var next = draftRef.current === '' ? marker.replace(/^\n/, '') : draftRef.current + marker;
        inputActions.setDraft(next);
      }

      function readAsDataURL(file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () {
            resolve(String(reader.result));
          };
          reader.onerror = function () {
            reject(new Error('paste-image: failed to read image file'));
          };
          reader.readAsDataURL(file);
        });
      }

      // 运行时状态: 当前会话的 inputActions 与 draft 引用。
      var inputActions = null;
      var sessionId = null;
      var draftRef = { current: '' };

      slots.inject('conversation.input.dock', function () {
        return slots.register(
          { name: 'conversation.input.dock', id: 'paste-image', order: 100 },
          function (props) {
            // props 提供 inputActions / sessionId / input(见槽位契约 InputZone)。
            inputActions = props.inputActions;
            sessionId = props.sessionId;
            // 用最新快照刷新 draft 引用; 渲染 null 占位, 不显示 UI。
            draftRef.current = props.input && props.input.draft ? props.input.draft : '';
            return null;
          },
        );
      });

      ctx.on('dispose', function () {
        document.removeEventListener('paste', onPasteCapture, true);
      });
      document.addEventListener('paste', onPasteCapture, true);
    };

    return module.exports;
  },
});
