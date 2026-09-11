# dsh-plugin

> DeepSeek Harness (DSH) 插件集合 —— 给 DSH 补上余额监控、本地识图、粘贴图片落盘等日常能力,`link:` 本地安装即用,随 `dsh web` 启动自动挂载。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![Made with DeepSeek + DSH](https://img.shields.io/badge/Made%20with-DeepSeek%20%2B%20DSH-4A6CF7)](https://github.com/deepseek-ai/DeepSeek-Harness)

## 这是什么

DSH 的插件生态还在早期,本仓库把几个日常高频缺口做成了独立插件,一个插件一个目录,按需取用:

| 插件                     | 状态   | 解决什么问题                             | 一句话说明                                                                                             |
| ------------------------ | ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ds-balance`             | 维护中 | 官方状态栏看不到余额和用量               | stats 行下方加第二行:余额 + 今日/本月 token,每 5 分钟刷新                                              |
| `file-git-explorer`      | 维护中 | 看不到 git 状态、GUI 里没有终端          | 官方右侧栏「git 页签」(变更列表 + 提交历史)+ 详情悬浮面板(官方正文 / diff)+ 终端抽屉(真 PTY)           |
| `db-console`             | 维护中 | GUI 里没有数据库客户端                   | 会话头部「数据库」页签:PG 完整链接登录(按项目保存)、schema 树、SQL 补全高亮、结果网格                  |
| `deepseek-harness`       | 维护中 | 想要粒子鲸鱼背景                         | 蓝色粒子鲸鱼(DeepSeek 品牌蓝)默认开启,沿用官方明/暗/系统主题;`?dshtest=1` 隐藏式诊断面板               |
| `stylevault-localchrome` | 维护中 | 想用本机 Chrome 配色当 DSH 主题          | 读本机 Chrome 用户色, 解码成 `#RRGGBB` 生成 StyleVault 1.0 预设; 授权后自动应用(需先装上游 StyleVault) |
| `batch-archive`          | 维护中 | 会话只能一个个归档                       | 侧边栏底部「批量归档」按钮 + 面板:勾选/全选多个会话一键归档(两次点击确认)                              |
| `tool-vision`            | 已归档 | DeepSeek 模型不支持图片输入              | 本地识图工具,把图片交给本地视觉模型(llama-server / LM Studio / Ollama)描述                             |
| `paste-image`            | 已归档 | 粘贴图片发送会被"当前模型不支持图片"拒绝 | 粘贴瞬间把图片落盘成文件,路径写入草稿,配合 `tool-vision` 实现看图                                      |

> ⚠️ `tool-vision` 与 `paste-image` 已**归档**:源码移到 `plugins/obsolete/`,不再维护、
> 不再列入默认安装,仅保留以便参考。其余插件为当前维护中。

## 效果展示

![界面全览:粒子鲸鱼背景、余额状态栏、左右文件/Git 树、数据库页签、批量归档按钮](<png/页面全览(文件树+git树+余额+粒子鲸鱼+数据库tag+批量归档按钮位置).png>)

## 快速上手

前置:Node.js >= 20、已安装 DeepSeek Harness(`dsh` CLI)及 `web` profile。

### 1. 克隆并安装插件

```sh
git clone https://github.com/eh-tools/dsh-plugin.git
cd dsh-plugin

# <repo-abs-path> 换成你克隆下来的仓库绝对路径(link: 安装要求绝对路径)
dsh plugin --profile web add link:<repo-abs-path>/plugins/ds-balance
dsh plugin --profile web add link:<repo-abs-path>/plugins/file-git-explorer
dsh plugin --profile web add link:<repo-abs-path>/plugins/deepseek-harness
dsh plugin --profile web add link:<repo-abs-path>/plugins/batch-archive
```

装完**重启 DSH 并硬刷新浏览器**(Cmd/Ctrl+Shift+R)生效。

> `tool-vision` 与 `paste-image` 已**归档**(`plugins/obsolete/`),不再列入默认安装;
> 如需装旧版,安装 / 挂载命令见下文对应章节。

> 更新插件:`git pull` 后重跑同一条安装命令;只改 `lib/client.js` 时刷新浏览器即可,
> 改 `lib/index.js` 才需要重启 DSH。
> 卸载:`dsh plugin --profile web remove dsh-ds-balance`,然后重启 DSH。

> `stylevault-localchrome` 是**可选**插件:它只负责「取色 + 生成预设」,要**应用**成 DSH 主题,
> 需**先装上游主题引擎**。推荐一起装:
>
> ```sh
> dsh plugin --profile web add github:GptsApp/dsh-stylevault
> dsh plugin --profile web add link:<repo-abs-path>/plugins/stylevault-localchrome
> ```

## 插件使用说明

### ds-balance —— 余额/调用量状态栏

装好后,官方 stats 行**下方**出现独立第二行:

```
DeepSeek ¥68.64 | 今日 34K tok | 本月 1.2M tok
```

- 每 5 分钟自动刷新;悬停可看明细(总余额 / 赠送 / 充值 / 今日与本月输入输出 token 拆分)。
- 配置:凭证写入 `~/.dsh/.credentials.yaml`(或环境变量),经 credentials 服务读取,不进代码:

  ```yaml
  DEEPSEEK_API_KEY: sk-xxxx
  DEEPSEEK_USER_TOKEN: <平台网页登录态 token>
  ```

  `DEEPSEEK_USER_TOKEN` 的获取:登录 platform.deepseek.com 后,F12 → Application →
  Local Storage → 复制 `userToken` 键 JSON 值里的 `.value` 字段;也可以在状态栏上点
  **"浏览器登录"**,插件会用系统 Chrome 打开登录页,登录后自动写入并生效。

#### 常见问题

| 现象                                | 原因                                                                    | 解决                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 状态栏没有第二行                    | base URL 指向非官方 API(网关/代理/自建中转),或未配置 `DEEPSEEK_API_KEY` | 确认 base 是 `api.deepseek.com` 且 key 已配置;**非官方场景整行隐藏是设计行为**,不会污染状态栏 |
| 只有余额,没有今日/本月              | 未配置 `DEEPSEEK_USER_TOKEN`                                            | 点状态栏"浏览器登录",或手动复制 userToken                                                     |
| 调用量突然消失,日志报 `40002/40003` | userToken 过期/退出登录                                                 | 重新登录,重新复制/一键登录                                                                    |
| "浏览器登录"失败                    | 本机没有 Google Chrome                                                  | 装 Chrome,或 `npx playwright install chromium`                                                |
| 数字不更新                          | 5 分钟轮询 + 60s 服务端缓存                                             | 正常现象,等下一轮刷新;改了 key 后重启 DSH 最稳                                                |

> 注意:调用量接口是平台用量页的**私有接口**(无公开文档),只返回 token 数不返回
> 调用次数,且可能随时变动——这属于平台侧限制,插件无法控制。

### tool-vision —— 本地识图工具(已归档)

> ⚠️ **已归档**:本插件不再维护、不再推荐,源码移至 `plugins/obsolete/tool-vision`,
> 以下内容仅作参考。

把图片路径交给它,返回视觉模型对图片的描述(读图 / OCR / 版面理解)。工具名 `vision`,
agent 会自动调用;支持 PNG / JPEG / WebP / BMP / GIF。

两种用法(核心配置 `autoStart`):

- **常驻服务**(高频):自己起一个 llama-server,`autoStart` 保持 `false`(默认),插件只对接端口。
- **on-demand**(低频 / 省内存):配 `autoStart: true`,插件在调用时自动拉起服务、
  用完即退(`keepAliveMs: 0`),外部已有服务时优先复用,不重复拉起。

完整配置项(全部有默认值,除 `baseUrl` 外通常不用改):

| 键                                          | 默认值                         | 说明                                                                          |
| ------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `baseUrl`                                   | `http://127.0.0.1:8080/v1`     | 任意 OpenAI 兼容视觉服务的 API 地址(带 `/v1`),本地或云端都行                  |
| `model`                                     | `''`                           | 模型 id;留空自动探测 `/v1/models` 第一个                                      |
| `apiKey`                                    | `''`                           | **云服务认证**:直接填 `sk-xxx`,或 `env:MY_KEY` 读环境变量;留空 = 无认证(本地) |
| `defaultPrompt`                             | `用中文简要描述这张图片的内容` | 调用方未传 `prompt` 时的指令                                                  |
| `maxTokens` / `timeoutMs` / `maxImageBytes` | `1024` / `120000` / `30 MiB`   | 生成上限 / 超时 / 图片体积上限                                                |
| `autoStart`                                 | `false`                        | 服务不可达时自动拉起 llama-server(云端保持 `false`)                           |
| `serverCommand`                             | `''`                           | 拉起命令;留空用默认(基于 `baseUrl` 推导,已适配 Windows)                       |
| `keepAliveMs`                               | `0`                            | `0` = 用完即退;`>0` = 闲置 N 毫秒后退出                                       |

#### 常见问题

| 现象                            | 原因                                        | 解决                                                                                                    |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 调用 `vision` 超时/报错         | llama-server 没起,或端口与 `baseUrl` 不一致 | 手动起服务;或配 `autoStart: true` 让插件自动拉起                                                        |
| Windows 上找不到 `llama-server` | 不在 `PATH`,或 cmd 不展开 `~`               | 显式配 `serverCommand` 完整路径(示例见插件 README);更省事用 LM Studio / Ollama,完全不碰 `serverCommand` |
| 想换模型 / 换推理服务           | —                                           | 只改 `baseUrl` + `model`,LM Studio / Ollama / vLLM 都行,只要模型支持视觉                                |
| 想用**云端**视觉模型            | —                                           | `baseUrl` 填云服务地址 + `model` 填云端模型 id + `apiKey` 填 key(`env:` 引用环境变量),示例见插件 README |
| 云端返回 401/403                | key 不对,或服务不支持视觉模型               | 核对 `apiKey` 与模型 id;DeepSeek 官方 API 不支持图片,不能当 vision 后端                                 |
| 图片太大被拒                    | 默认上限 30 MiB                             | 调大 `maxImageBytes`,或先压缩图片                                                                       |
| 多轮讨论模型"不记得"之前的图    | 每次调用是独立请求,无会话记忆               | 这是服务侧限制,由 agent 自己带上下文                                                                    |
| 常驻服务太占内存                | 模型常驻内存                                | `autoStart: true` + `keepAliveMs: 0`,用完即退                                                           |

### paste-image —— 粘贴图片落盘(已归档)

> ⚠️ **已归档**:本插件不再维护、不再推荐,源码移至 `plugins/obsolete/paste-image`,
> 以下内容仅作参考。

在输入框 **Cmd+V / Ctrl+V** 粘贴图片时,自动把图片字节保存到**当前会话工作目录的
`attachments/`**,并把绝对路径追加进草稿,形如:

```
[已粘贴图片: /path/to/session/attachments/1760000000000-shot.png]
```

这样 agent 看到路径后,直接用 `tool-vision` 传该路径识别——绕开 DSH 主模型
(DeepSeek)不支持图片的检查。限制:PNG / JPEG / WebP / GIF,单张 ≤ 30MB;
文本粘贴不受影响。

### file-git-explorer —— 官方右侧栏的 git 页签 + 详情悬浮面板 + 终端抽屉

只占官方右侧栏一个**自建 kind**(`fge-git`,不与任何 builtin 争位),其余两个落点是详情悬浮面板与
composer 座下方的终端抽屉。**文件树回归官方**,本插件不接管、不自绘;右栏**默认页签就是官方的「文件」**
(工作区文件树)—— 官方那条`guide 恰好一条才作默认`的规则会被本插件的 guide 条目顶掉, 所以这里补了一次
"每会话铺一次默认页签"。另外按用户要求覆盖了几处右栏外观:**宽度可拖,范围 200px ~ 15% 视口**(官方首开 45%、
上限 70%;拖过的宽度记在 `localStorage`,刷新 / 切会话都在),并隐藏右栏的「分栏」「进全屏」按钮。

- **Git 页签**:头部一颗**分支按钮**(当前分支 + 上游 `↑ahead ↓behind` 徽标),点它弹出**分支小浮窗** ——
  `本地分支` / `远程分支` 两组的**分支树**(远程按 remote 名分层),点任意一条即切「查看分支」并重取它的提交历史
  (**只换看哪个分支,不动工作区的实际分支**);**变更列表**(相对 `HEAD`,已暂存 / 未暂存 / 未跟踪,
  `M/A/D/R/U/?` 徽标);**提交历史**(每页 50 条、加载更多)。点一条提交**就地展开**它的文件
  (带 ±行数),再点收起 —— 页签内没有「返回」。点任一文件(diff 范围:工作区相对 HEAD;从提交展开的则是该提交对其父提交)
  即把 diff 送进悬浮面板。
- **详情悬浮面板**:视口 1/2 宽、满高、紧贴右栏左缘,**同一时间只有一个**;切会话 / 切工作区 / 右栏折叠 /
  按 **Esc** 都会关掉。承载官方**文档正文**与**diff**两类东西 ——
  文件内容不自己渲染,只是把官方正文页签 `ctx.sidebarRight.float()` 起来,于是 markdown / 代码 / 图片 / html / pdf
  全是官方原版;diff 用官方 `primitives.DiffBlock` 渲染,解析在 host 侧纯函数里。官方文档页签的芯片由本插件
  **影子替换**(顺带加一枚「复制内容」,复制磁盘原文;purpose 里的「复制内容」能力即原 `doc-copy`)。
  详情**只以浮层出现**:页签条上不闪出详情页签,浮起后右栏也**停在用户原本选中的那一格**(不跳到 git 树)。
- **终端抽屉**:真 PTY —— `node-pty` ↔ WebSocket ↔ `xterm.js`,vim / htop / 颜色 / 补全 / Ctrl+C 均可用。
  收起态是 composer 下方一枚透明 chevron,点击**向上**展开;抽屉**宽度与上方对话区一致**(跟着顶部那条宽度手柄)、
  顶部圆角,配色跟主题 token;终端里拖选后 **Alt+C 复制**(Ctrl+C 仍送 SIGINT);
  顶上是 **Windows Terminal 观感的「标题条」**:一枚页签(`>_` 字形 + **尾部省略号**截断的工作区路径 + 悬停出现的 `×`)
  加右端**红色 `■`**;`×` 与点条空白处都只是收起(不杀进程),`■` 才终止整棵进程树;上缘拖柄调高度(20%~70%,按工作区记忆)。
  标题条**只是外观** —— 页签恒定只有当前工作区这一枚, **不是多页签容器**(每工作区仍是一个终端)。
  每工作区一个终端,跨抽屉关闭 / 切会话 / 页面刷新存活(重连回放 256KB),全局上限 16 个 LRU;
  PowerShell 带 `-NoLogo` 启动、且重启会丢掉上一个进程的回放 —— 不会叠出一屏旧 banner。
- **刷新**:agent turn 结束时自动重取变更列表与历史首页(页签不可见时挂起、可见时补刷,且**不 fetch**);
  `⟳` 手动刷新会先 `git fetch --all --prune`(限时 8s,失败放行)。
- 已砍掉 v0.2 的自带文件树 / 搜索 / 编辑保存 / `.http` / shell 行,以及 v0.6 的右栏终端页签 ——
  只读浏览用 agent 的 glob/grep/read/edit 工具更强,终端只有抽屉一种形态。

详见 `plugins/file-git-explorer/README.md`(HTTP/WS 接口、帧协议、porcelain v2 字段数陷阱、统一 diff→hunk 的三个坑、
影子替换官方芯片为什么必须用负数 priority、悬浮面板几何、插件依赖解析锚点)。

### db-console —— 数据库控制台

会话头部新增第三个页签「数据库」(排在轨迹之后),粘贴完整 PostgreSQL 链接串即可登录:

- **按项目单例**:链接以仓库根为键保存在本机 `~/.dsh/storages/db-console.json`
  (明文, 权限 0600, UI 打码展示;安全口径见 `docs/adr/0001`), 切工作区、刷新浏览器、
  重启 DSH 都不丢——每个项目连自己的库。
- **schema 树**:连接成功后内省表结构(schema → 表 → 列, 手动 ⟳ 刷新),
  点表名直接插入编辑器。
- **SQL 编辑器**:语法高亮 + 三级补全(SQL 关键字 / 表名 / 输入 `表名.` 出列),
  行尾空白以极淡底色标出(透明 textarea 里光标不再像停在文本外),
  `Ctrl/Cmd+Enter` 执行光标所在语句/选区。
- **结果网格**:多语句分段渲染;行集默认截断 500 行并提示取回总数;点单元格复制;
  写语句显示影响行数。执行不做任何拦截。
- 依赖 `pg` 驱动,首次安装后在本插件目录执行过 `pnpm install`(仓库克隆后装一次即可)。

### batch-archive —— 批量归档

侧边栏底部(设置按钮旁)新增「批量归档」按钮,打开面板勾选多个会话一键归档:

- **入口**:展开侧边栏显示「图标 + 批量归档」,收起为窄栏时只显示图标。
- **面板**:按工作区分组列出所有未归档会话(无归属的归「未分组」),每行显示标题、
  相对时间与运行中状态点;支持全选 / 单选。
- **归档**:「归档所选 (N)」→ 按钮变为「确认归档 (N)」再次点击即 **8 路并发**归档
  (走客户端 `workspaces.archiveSession`,与行内归档同一接口),footer 实时显示
  「已归档 x / N」与失败计数;已归档会话自动从列表隐藏,会话日志保留。防误触:
  二次确认 + 归档中锁定界面。
- **性能**:遮罩不用 `backdrop-filter` 毛玻璃(避免滚动时对整个视口重算高斯模糊);面板
  **关闭时主体不挂载**(零会话 / 工作区订阅、零渲染),打开后行 / 分组头为 `React.memo`
  (原始值 props + 稳定回调),会话 store 每次 flush 不再全量重排列表。
- 纯客户端实现(无 Host 逻辑),会话数据来自槽位标准 props,不落盘任何状态。

### stylevault-localchrome —— 本机 Chrome 配色 → DSH 主题

把本机 Google Chrome 的「自定义外观」用户色读出来, 解码成 `#RRGGBB`(带符号 SkColor `0xAARRGGBB`),
再据此推导一套完整调色板, 生成可导入上游 [StyleVault](https://github.com/GptsApp/dsh-stylevault) 的预设 JSON。
在**已装上游 StyleVault 且你同意**的前提下, 首次启动自动应用为 DSH 主题。

- **依赖**: 需先装上游 `GptsApp/dsh-stylevault` 才会「应用」; 不装则只生成预设 JSON, 不接管主题。
- **CLI(不用挂载)**: `node plugins/stylevault-localchrome/scripts/build-preset.js` 生成预设, 粘到上游面板导入。
- **自动应用**: 首次启动弹窗询问, 同意后每次启动自动应用当前 Chrome 配色;
  之后可在 **Settings → StyleVault · Local Chrome** 卡片改主意。
- 只读本机 `Preferences` 的 `browser.theme.user_color`, 主题引擎与设置面板指向上游, 本插件不实现。

详见 `plugins/stylevault-localchrome/README.md`。

## 常见问题速查

| 现象           | 解决                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| 装了插件没效果 | 重启 DSH + 硬刷新浏览器(Cmd/Ctrl+Shift+R);确认安装命令用的是仓库**绝对路径** |
| 改了代码不生效 | `lib/client.js` 改动刷新浏览器即可;`lib/index.js` 改动需重启 DSH             |
| 如何更新插件   | `git pull` 后重跑安装命令                                                    |
| 如何卸载       | `dsh plugin --profile web remove <插件id>`,然后重启 DSH                      |
| 凭证放哪       | `~/.dsh/.credentials.yaml`(或环境变量),**不要写进代码/提交到 git**           |
| 想自己写插件   | 见下方「贡献与开发」                                                         |

## 贡献与开发

开发/新增插件/提交规范等见 [CONTRIBUTING.md](CONTRIBUTING.md);仓库结构很简单:
`plugins/<plugin-id>/` 一个插件一个目录(需要浏览器 UI 的为静态双半包,
纯功能性的为纯 host 插件,写法都有现成参考)。

## 安全

发现漏洞请走私有渠道报告,勿开公开 Issue,详见 [SECURITY.md](SECURITY.md)。

## 关于

- **开发方式**:本仓库由 **DeepSeek** 模型协助、基于 **DeepSeek Harness (DSH)**
  工具链开发。
- **免责声明**:第三方社区项目,与 DeepSeek / 深度求索官方无隶属关系,未经官方认可
  或背书;`ds-balance` 的调用量接口为平台私有接口,可能随时变动,仅用于展示你本人
  账户信息。

## 协议

[MIT](LICENSE) © 2025 [eh-tools](https://github.com/eh-tools)
