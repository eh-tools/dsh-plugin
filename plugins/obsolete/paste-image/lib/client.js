// dsh-paste-image — client half(静态浏览器 bundle)
//
// 客户端不拦截任何粘贴事件: 图片粘贴完全走 DSH 原生流程(输入框显示原生
// 图片预览, 发送时以 image block 走 session.prompt RPC)。
//
// "文本模型也能粘贴图片"由宿主端实现: 宿主包装 apiProxy.sessions.prompt,
// 当模型不支持图片输入时, 把 image block 持久化到附件存储并替换成
// [已粘贴图片: sha256:…] 文本标记, 模型看到标记后调用 vision 工具识图。
//
// 本 client 半保留为空壳, 仅为了维持静态 bundle 的 client 模块存在。
window.__ModuleLoader__.load({
  id: 'dsh-paste-image',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    exports.name = 'dsh-paste-image';
    exports.apply = function (ctx) {
      // 无操作: 原生粘贴流程已足够, 宿主端负责文本模型的图片转换。
    };

    return module.exports;
  },
});
