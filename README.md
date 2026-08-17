# dsh-plugin

DeepSeek Harness 插件集合(一个插件一个目录,后续插件继续往 `plugins/` 里加)。

## 目录约定

```
dsh-plugin/
├── README.md                 # 本文件:集合约定
└── plugins/
    ├── <plugin-id>/          # 一个插件一个目录,id 用 kebab-case
    │   ├── manifest.json     # (动态插件) idPrefix / name / purpose,供重建使用
    │   ├── host.js           # (动态插件) cordis_define 的 code.host 函数体
    │   ├── client.js         # (动态插件) cordis_define 的 code.client 函数体
    │   ├── package.json      # (静态插件) npm 包描述
    │   ├── lib/index.js      # (静态插件) 插件实现,在 agent preset 里按绝对路径挂载
    │   ├── cordis.yml        # (静态插件) 挂载示例
    │   ├── tests/            # (静态插件) 冒烟测试
    │   └── README.md         # 插件说明
    └── ...
```

## 两类插件

### 动态 UI 插件(如 `ds-balance`)

- 需要浏览器端 UI(Slot、状态栏、设置页),依赖动态插件专属符号(`harness` / `host` / `styles`)。
- 文件:`host.js` + `client.js`(+ `manifest.json`)。
- 加载:在 DSH 进程内用 `cordis_define`(kind: new, idPrefix 见 manifest)创建、`cordis_run` 激活。
- 注意:动态插件是**进程内临时**的,DSH 重启后需重新加载(步骤见各插件 README)。

### 静态工具/服务插件(如 `tool-vision`)

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
2. 按类型放入文件(见上;动态插件记得写 `manifest.json` 记录 idPrefix)。
3. 在插件目录写 `README.md`:用途、配置项、如何加载。
4. 动态插件由 agent 用 `cordis_define` / `cordis_run` 加载;静态插件按 `cordis.yml` 挂载。

## 现有插件

| 插件          | 类型     | 说明                                                                                                        |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `ds-balance`  | 动态 UI  | 官方 stats 行下方第二行: DeepSeek 余额 + 今日/本月调用量, 每 5 分钟刷新; 非官方 API 或未配置 key 时整行隐藏 |
| `tool-vision` | 静态工具 | 本地 vision 工具,把图片发给本地 llama-server 并返回描述                                                     |
| `paste-image` | 动态插件 | 输入框粘贴图片即保存到会话工作目录 `attachments/`,路径写入草稿,供 `tool-vision` 识别                        |
