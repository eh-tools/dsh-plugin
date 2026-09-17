# dsh-plugin

> DeepSeek Harness (DSH) 插件集合 —— 余额监控、数据库控制台、批量归档等日常能力,`link:` 本地安装即用。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![Made with DeepSeek + DSH](https://img.shields.io/badge/Made%20with-DeepSeek%20%2B%20DSH-4A6CF7)](https://github.com/deepseek-ai/DeepSeek-Harness)

## 插件清单

| 插件                     | 状态   | 一句话说明                                                      |
| ------------------------ | ------ | --------------------------------------------------------------- |
| `ds-balance`             | 维护中 | 状态栏第二行:余额 + 今日/本月 token,5 分钟自动刷新              |
| `db-console`             | 维护中 | 会话头部「数据库」页签:PG 登录、schema 树、SQL 编辑器、结果网格 |
| `deepseek-harness`       | 维护中 | 蓝色粒子鲸鱼背景,跟随官方明/暗/系统主题                         |
| `stylevault-localchrome` | 维护中 | 读本机 Chrome 配色 → 生成并应用 StyleVault 预设                 |
| `batch-archive`          | 维护中 | 侧边栏「批量归档」按钮,一次归档多个会话                         |
| `browser-operator`       | 维护中 | 常驻可见浏览器 + 9 个 `browser_*` 工具(纯 host,挂 agent preset) |
| `tool-vision`            | 已归档 | 本地视觉模型描述图片(读图 / OCR / 版面)                         |
| `paste-image`            | 已归档 | 粘贴图片落盘成文件,路径写入草稿                                 |
| `file-git-explorer`      | 已归档 | 右栏 Git 页签 + 详情悬浮面板 + 终端抽屉(自建界面已退场)         |

> 归档插件源码在 `plugins/obsolete/`,不再维护、不列入默认安装。
> 每个插件的配置项与细节见其自身 `plugins/<plugin-id>/README.md`。

## 快速上手

前置:Node.js >= 20、已安装 DSH(`dsh` CLI)及 `web` profile。

```sh
git clone https://github.com/eh-tools/dsh-plugin.git
cd dsh-plugin

# <repo-abs-path> 换成克隆下来的仓库绝对路径(link: 要求绝对路径)
dsh plugin --profile web add link:<repo-abs-path>/plugins/ds-balance
dsh plugin --profile web add link:<repo-abs-path>/plugins/deepseek-harness
dsh plugin --profile web add link:<repo-abs-path>/plugins/batch-archive
```

装完**重启 DSH 并硬刷新浏览器**(Cmd/Ctrl+Shift+R)生效。

- **更新**:`git pull` 后重跑同一条安装命令。
- **卸载**:`dsh plugin --profile web remove dsh-ds-balance`,然后重启 DSH。
- **可选**:`stylevault-localchrome` 要**应用**成主题需先装上游主题引擎:
  ```sh
  dsh plugin --profile web add github:GptsApp/dsh-stylevault
  dsh plugin --profile web add link:<repo-abs-path>/plugins/stylevault-localchrome
  ```
- **例外**:`browser-operator` 不装 profile,挂进 agent preset(见下)。

## 插件使用说明

### ds-balance —— 余额 / 调用量状态栏

- 官方 stats 行下方独立第二行:`DeepSeek ¥68.64 | 今日 34K tok | 本月 1.2M tok`;悬停看明细(总余额 / 赠送 / 充值 / 输入输出拆分)。
- 凭证写入 `~/.dsh/.credentials.yaml`(或环境变量),不进代码:

  ```yaml
  DEEPSEEK_API_KEY: sk-xxxx
  DEEPSEEK_USER_TOKEN: <平台网页登录态 token>
  ```

- 也可点状态栏**「浏览器登录」**,用系统 Chrome 登录后自动写入。
- 常见问题:只有余额没调用量 = 缺 `DEEPSEEK_USER_TOKEN`;调用量报 `40002/40003` = token 过期,重新登录;「浏览器登录」不可用 = 本机没有 Chrome。
- 非官方 base URL(网关 / 代理 / 中转)下整行隐藏,属设计行为。

### db-console —— 数据库控制台

- 会话头部第三个页签「数据库」,粘贴完整 PostgreSQL 链接串登录,**按项目保存**(切工作区 / 刷新 / 重启都不丢)。
- schema 树:内省 schema → 表 → 列,手动 ⟳ 刷新,点表名插入编辑器。
- SQL 编辑器:语法高亮 + 三级补全(SQL 关键字 / 表名 / `表名.` 出列),`Ctrl/Cmd+Enter` 执行光标语句或选区。
- 结果网格:多语句分段渲染,行集默认截断 500 行并提示总数,点单元格复制,写语句显示影响行数。
- 依赖 `pg`,首次安装后在本插件目录执行一次 `pnpm install`。

### batch-archive —— 批量归档

- 侧边栏底部(设置按钮旁)「批量归档」按钮 → 面板按工作区分组列出未归档会话(标题 / 相对时间 / 运行中状态)。
- 勾选或全选 → 「归档所选 (N)」→ 二次确认后 8 路并发归档,footer 实时显示「已归档 x / N」与失败数;已归档的自动隐藏,会话日志保留。
- 纯客户端实现,不落盘任何状态。

### stylevault-localchrome —— 本机 Chrome 配色 → DSH 主题

- 读本机 Chrome 用户色,生成可导入上游 [StyleVault](https://github.com/GptsApp/dsh-stylevault) 的预设 JSON。
- 已装上游且同意后,首次启动弹窗询问,同意即每次启动自动应用当前 Chrome 配色;之后可在 **Settings → StyleVault · Local Chrome** 卡片改主意。
- 不装上游则只生成预设,不接管主题。
- 不挂载也能用 CLI 生成预设:`node plugins/stylevault-localchrome/scripts/build-preset.js`。

### browser-operator —— 常驻可见浏览器(挂 agent preset,不走 profile)

- 先装依赖(仅 `playwright-core`,用系统 Chrome,不下载浏览器):

  ```sh
  pnpm --dir <repo-abs-path>/plugins/browser-operator install
  ```

- 再把 `plugins/browser-operator/cordis.yml` 里那行加进 preset 的 `agent.cordis.yml`(`name` 写绝对路径):

  ```yaml
  - id: browser-operator
    name: <repo-abs-path>/plugins/browser-operator/lib/index.js
    config:
      browser: chrome
      headless: false
  ```

- 常驻**有头**浏览器,独立 profile,与日常 Chrome 并存,登录态跨轮次、跨 DSH 重启复用(首次在可见窗口人工登录一次)。
- **9 个工具**:`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_fill`、`browser_eval`、`browser_screenshot`、`browser_console`、`browser_network`、`browser_artifacts`。
- 截图等产物落在项目已 ignore 的目录下,**不脏仓库**。
- 改 `lib/index.js` 需重启 DSH。

## 常见问题速查

| 现象           | 解决                                                                 |
| -------------- | -------------------------------------------------------------------- |
| 装了插件没效果 | 重启 DSH + 硬刷新浏览器;确认安装命令用的是仓库**绝对路径**           |
| 改了代码不生效 | `lib/client.js` 改动刷新浏览器即可;`lib/index.js` 改动需重启 DSH     |
| 如何更新插件   | `git pull` 后重跑安装命令                                            |
| 如何卸载       | `dsh plugin --profile web remove <插件id>`,然后重启 DSH              |
| 凭证放哪       | `~/.dsh/.credentials.yaml`(或环境变量),**不要写进代码 / 提交到 git** |

## 贡献与开发

新增插件 / 提交规范见 [CONTRIBUTING.md](CONTRIBUTING.md);仓库结构:在役插件在 `plugins/<plugin-id>/`(一个插件一个目录),退役插件留档在 `plugins/obsolete/<plugin-id>/`。

## 安全

漏洞请走私密渠道报告,勿开公开 Issue,详见 [SECURITY.md](SECURITY.md)。

## 关于

- 本仓库由 **DeepSeek** 模型协助、基于 **DeepSeek Harness (DSH)** 开发。
- 第三方社区项目,与 DeepSeek / 深度求索官方无隶属关系;`ds-balance` 的调用量接口为平台私有接口,可能随时变动,仅用于展示你本人账户信息。

## 协议

[MIT](LICENSE) © 2025 [eh-tools](https://github.com/eh-tools)
