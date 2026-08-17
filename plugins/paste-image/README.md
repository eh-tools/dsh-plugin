# paste-image:粘贴图片即存文件(DSH 动态插件)

在输入框 **Cmd+V / Ctrl+V 粘贴图片**(截图等)时,自动把图片字节保存到
**当前会话工作目录的 `attachments/` 文件夹**,并把绝对路径追加进输入框草稿,
形如:

```
[已粘贴图片: /Users/a1/workspace/xxx/attachments/1760000000000-shot.png]
```

这样 agent 看到路径后,就可以用本地 `tool-vision` 插件直接传该路径识别——
完全绕开 DSH 主模型(DeepSeek)的 `inputModalities: ['text']` 图片检查。

## 为什么需要它

DSH 输入框原生支持粘贴图片(显示缩略图草稿),但发送时 host 会检查当前模型
是否声明支持图片输入;DeepSeek 适配器只声明 `['text']`,所以带图消息在落盘前
就被拒绝("当前模型不支持图片,请切换支持图片的模型")。粘贴的图片从未真正
进入 DSH 附件存储。本插件在粘贴瞬间就把图片落盘成文件,让本地 vision 插件
能读。

## 工作流程

1. 用户在输入框粘贴图片(文档级 capture 监听,优先于官方草稿处理)。
2. 拦截默认行为,图片**不进入**官方草稿栏(避免发送时被模型检查拒绝)。
3. 图片以 base64 经 `host.call('paste-image/save')` 发给 Host。
4. Host 校验类型(png/jpeg/webp/gif)与大小(≤30MB),经 `ctx.shell` 的 stdin
   通道 `base64 -d` 落盘到 `<会话cwd>/attachments/<时间戳>-<文件名>`。
5. 返回绝对路径,Client 用 `inputActions.setDraft` 追加到草稿。
6. agent 看到路径,调用 `tool-vision` 识别(需要 `vision` preset 或已挂载
   tool-vision)。

## 如何在 DSH 中(重新)加载

动态插件是**进程内临时**的:DSH 重启后需要重新创建并运行。

1. 让 agent 用本目录两个文件重建插件:

   ```
   cordis_define: kind: new, idPrefix: pstimg(见 manifest.json)
     code.host   <- host.js 的内容
     code.client <- client.js 的内容
   cordis_run:   pluginId + packageId, mode: run
   ```

2. 在界面批准 Run 卡(Client 端需要授权),激活后即可用。

## 文件

| 文件            | 内容                                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| `host.js`       | Host 端函数体 — 校验 + `ctx.shell` 落盘, 经 `harness.handle` 暴露 `paste-image/save` |
| `client.js`     | Client 端函数体 — capture 拦截粘贴, base64 上传, 路径写入 draft                      |
| `manifest.json` | idPrefix / name / purpose, 供重建使用                                                |

## 备注

- 落盘目录固定在会话 cwd 的 `attachments/`,文件名带时间戳防冲突。
- 文本粘贴不受影响(无图片文件时不拦截)。
- 停止: `cordis_stop`(恢复官方粘贴行为);彻底删除: `cordis_undefine`。
