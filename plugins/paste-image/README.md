# paste-image:让纯文本模型也能粘贴图片(DSH 静态双半插件)

用户粘贴图片时,**输入框显示原生图片预览**(与支持图片的模型完全一致的体验),
发送后图片自动进入 DSH 附件存储,模型收到的是 `[已粘贴图片: sha256:…]` 文本
标记,可调用 `tool-vision` 插件把图片发给本地/云端视觉模型识别。

## 为什么需要它

DSH 输入框原生支持粘贴图片(显示缩略图草稿),但发送时 host 会检查当前模型
是否声明支持图片输入(`input: [text, image]`)。纯文本模型(如 DeepSeek、
glm-5.2)只声明文本,所以带图消息在落盘前就被拒绝
(`MODEL_DOES_NOT_SUPPORT_IMAGES`)。

本插件让纯文本模型也能粘贴图片:**客户端完全走原生粘贴**,宿主端负责转换。

## 工作流程

1. 用户粘贴图片 → DSH 原生输入框显示图片预览(**无任何文本标记**)。
2. 用户发送 → 客户端以 image block 走 `session.prompt` RPC。
3. 宿主闸门检查模型能力:
   - **模型支持图片** → 图片以原生 image block 进入会话, 不做转换。
   - **模型不支持图片** → 闸门返回 `MODEL_DOES_NOT_SUPPORT_IMAGES`。
4. 本插件包装的 `apiProxy.sessions.prompt` 检测到该拒绝后:
   - 把 image block 通过 `attachments.saveImage()` 持久化到 DSH 附件存储
     (sha256 内容寻址, 与原生粘贴同一条存储路径);
   - 把 image block 替换成 `[已粘贴图片: sha256:…]` 文本标记;
   - 重试 prompt → 这次全是文本, 闸门放行。
5. 模型看到文本标记, 把 attachmentId 传给 `tool-vision` 工具 → 工具从附件
   存储读取图片字节 → 发给本地 llama-server / 云端视觉模型 → 返回描述。

## 客户端为什么是空壳

旧版 client 在文档捕获阶段拦截粘贴, 把图片存成文件、往草稿插路径文本。
新版不再拦截: 原生粘贴流程已经能显示图片预览, 拦截反而破坏体验。
转换逻辑全部在宿主端, 客户端保持原生。

## 挂载

```bash
dsh plugin --profile web add link:<repo-abs-path>/plugins/paste-image
```

挂载后随 web profile 启动自动加载, 无需动态插件流程。

## 开发与测试

```bash
node plugins/paste-image/tests/save.test.mjs
```

覆盖: 文本模型转换+重试、视觉模型不转换、非模型类拒绝透传、
保存失败报错、apiProxy 缺失时优雅退出。
