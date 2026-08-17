# paste-image:粘贴图片即存文件(DSH 静态双半插件)

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
3. 图片以 base64 经 `fetch POST /paste-image/api/save` 发给 Host(静态插件的
   HTTP JSON 路由,替代动态插件的 `host.call` 私有 RPC)。
4. Host 校验类型(png/jpeg/webp/gif)与大小(≤30MB),经 `ctx.shell` 的 stdin
   通道 `base64 -d` 落盘到 `<会话cwd>/attachments/<时间戳>-<文件名>`。
5. 返回绝对路径,Client 用 `inputActions.setDraft` 追加到草稿。
6. agent 看到路径,调用 `tool-vision` 识别(需要 `vision` preset 或已挂载
   tool-vision)。

## 安装与自动加载(随 DSH 启动自动挂载)

本插件已从动态插件改造为**静态双半 npm 包**(`dsh-paste-image`):host 半在
`lib/index.js`,client 半在 `lib/client.js`(浏览器 bundle),包自带
`cordis.patch.yml` 挂载层。安装后无需任何手动加载步骤,`dsh web` 每次启动
自动挂载,无 Run 卡批准,重启不丢;client 改动走 HMR 热更新,host 改动才需重启。

```sh
# 在仓库根目录执行(link: 本地安装, 无需发布到 npm)
dsh plugin --profile web add link:/Users/a1/workspace/dsh-plugin/plugins/paste-image
```

装完**重启 DSH 并硬刷新浏览器**(Cmd/Ctrl+Shift+R)。

- 更新: `git pull` 后重跑上面同一命令(CLI 会把已安装的 link 依赖重新链接);
  只改 `lib/client.js` 时刷新浏览器即可,改 `lib/index.js` 才需要重启。
- 卸载: `dsh plugin --profile web remove dsh-paste-image`。
- 原理: 包声明了 `dsh.bundle.patch`,CLI 的 bundle 协调会自动把它加进 profile
  的 `dsh.profile.bundles`,profile boot 时合并本包的 `cordis.patch.yml` 挂载行;
  `dsh.client` 声明让 clientModules 把浏览器半编入 `__DSH_BOOT__` 图。
- 旧的动态加载方式(用 `host.js`/`client.js` 走 `cordis_define`/`cordis_run`)
  已废弃,仅保留文件作参考;两者不要混用。

| 文件                    | 内容                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `lib/index.js`          | **Host 半(静态)** — 校验 + `ctx.shell` 落盘, `ctx.webServer` 暴露 `POST /paste-image/api/save` |
| `lib/client.js`         | **Client 半(静态 bundle)** — capture 拦截粘贴, fetch 上传, 路径写入 draft                      |
| `package.json`          | npm 包声明(`dsh.bundle.patch` + `dsh.client`)                                                  |
| `cordis.patch.yml`      | 挂载层(profile boot 时自动合并)                                                                |
| `host.js` / `client.js` | (已废弃) 旧动态插件函数体, 仅供对比参考                                                        |
| `manifest.json`         | kind / files / install, 供重建使用                                                             |

## 备注

- 落盘目录固定在会话 cwd 的 `attachments/`,文件名带时间戳防冲突。
- 文本粘贴不受影响(无图片文件时不拦截)。
- 移除: `dsh plugin --profile web remove dsh-paste-image` 后重启 DSH。
