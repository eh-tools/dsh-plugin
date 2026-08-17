# dsh-plugin

DeepSeek Harness 插件集合(一个插件一个目录,后续插件继续往 `plugins/` 里加)。

## 目录约定

```
dsh-plugin/
├── README.md                 # 本文件:集合约定
└── plugins/
    ├── <plugin-id>/          # 一个插件一个目录,id 用 kebab-case
    │   ├── manifest.json     # kind / files / install,供重建使用
    │   ├── package.json      # npm 包描述(声明 dsh.bundle.patch + dsh.client)
    │   ├── cordis.patch.yml  # (带浏览器 UI 的包) 挂载层,profile boot 自动合并
    │   ├── lib/index.js      # (双半包) host 半实现
    │   ├── lib/client.js     # (双半包) client 半浏览器 bundle
    │   ├── host.js           # (已废弃) 旧动态插件函数体,仅供对比参考
    │   ├── client.js         # (已废弃) 旧动态插件函数体,仅供对比参考
    │   ├── cordis.yml        # (纯 host 插件) 挂载示例
    │   ├── tests/            # (纯 host 插件) 冒烟测试
    │   └── README.md         # 插件说明
    └── ...
```

## 两类插件

### 静态双半 npm 包(需要浏览器 UI,如 `ds-balance` / `paste-image`)

- host 半 + client 半打成一个 npm 包:host 在 `lib/index.js`(ESM, 命名导出
  `name`/`inject`/`apply`),client 在 `lib/client.js`(`window.__ModuleLoader__.load`
  闭包),包自带 `cordis.patch.yml` 挂载层。
- client→host 通信用 `ctx.webServer` 注册的 **HTTP JSON 路由**(如
  `/ds-balance/api/query`),不再用动态插件的 `harness.handle` 私有 RPC。
- 安装:**`dsh plugin --profile web add link:<本目录绝对路径>`**。CLI 的 bundle
  协调发现 `dsh.bundle.patch` 后自动加进 profile 的 `dsh.profile.bundles`;
  `dsh.client` 声明让 clientModules 把浏览器半编入 `__DSH_BOOT__` 图。
- 效果:随 `dsh web` 启动**自动挂载**,无 Run 卡批准,重启不丢;client 改动走
  HMR 热更新(刷新浏览器即可),host 改动才需重启 DSH。
- 参考实现:https://github.com/omdsh-dev/DSH-better-sidebar(同款架构)。
- 注意:动态插件(`cordis_define`/`cordis_run`)是**进程内临时**的,不能开机自动
  加载,已不再作为本仓库插件的交付形态。

### 纯 host 插件(如 `tool-vision`)

- 只需 Host 端能力(工具、服务、文件、命令),以 ESM 包形式挂载进 agent preset。
- 文件:`package.json` + `lib/index.js`(+ `cordis.yml` 挂载示例 + `tests/`)。
- 加载:在目标 preset 的 `agent.cordis.yml` 加一行,保存后新建会话生效:

  ```yaml
  - id: tool-vision
    name: /Users/a1/workspace/dsh-plugin/plugins/tool-vision/lib/index.js
    config: { ... }
  ```

## 新增插件

1. `mkdir plugins/<plugin-id>`
2. 需要浏览器 UI 的按「静态双半 npm 包」结构写(`package.json` 声明
   `dsh.bundle.patch` + `dsh.client`,`lib/index.js` + `lib/client.js`,自带的
   `cordis.patch.yml` 挂载行);纯 host 的按「纯 host 插件」写。
3. 在插件目录写 `README.md`:用途、配置项、安装命令。
4. 安装: `dsh plugin --profile web add link:/Users/a1/workspace/dsh-plugin/plugins/<plugin-id>`。

## 现有插件

| 插件          | 类型     | 说明                                                                                                        |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `ds-balance`  | 静态双半 | 官方 stats 行下方第二行: DeepSeek 余额 + 今日/本月调用量, 每 5 分钟刷新; 非官方 API 或未配置 key 时整行隐藏 |
| `tool-vision` | 纯 host  | 本地 vision 工具,把图片发给本地 llama-server 并返回描述                                                     |
| `paste-image` | 静态双半 | 输入框粘贴图片即保存到会话工作目录 `attachments/`,路径写入草稿,供 `tool-vision` 识别                        |
